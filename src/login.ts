import { rmSync } from "node:fs";
import * as cheerio from "cheerio";
import { DmmClient, parseHistory } from "./dmm";
import type { Credentials } from "./domain";
import type { LoginIdentity } from "./prompt";
import { atomicJson, type Store } from "./store";

/** DMM refused the email/password itself, so trying the same password again cannot succeed. */
export class LoginRejected extends Error {}

const PASSWORD_LOGIN = "https://accounts.dmm.com/service/login/password";
const HISTORY = "https://eikaiwa.dmm.com/lesson/";
/** The DMM英会話 web app's public OAuth client, brand and callback, as its own sign-in uses them. */
const API_AUTHORIZE = "https://api.eikaiwa.dmm.com/api/oauth/authorize";
const API_CLIENT_ID = "946a79332d4fc03468f3e680e3917edde70659d77e9850b2e2c86e87b5c74293";
const EIKAIWA_BRAND = "5a4657f2-e151-4c48-9cce-000000000005";
const API_CALLBACK = "https://eikaiwa.dmm.com/app/login/callback";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

type Cookie = { name: string; value: string; domain: string; path: string; secure: boolean; expires: number };

export function cookieHeader(cookies: Cookie[], url: string, now = Date.now() / 1000): string {
  const target = new URL(url);
  return cookies
    .filter((cookie) => {
      const domain = cookie.domain.startsWith(".") ? cookie.domain.slice(1) : cookie.domain;
      const domainMatches = cookie.domain.startsWith(".")
        ? target.hostname === domain || target.hostname.endsWith(`.${domain}`)
        : target.hostname === domain;
      const pathMatches =
        target.pathname === cookie.path ||
        (target.pathname.startsWith(cookie.path) &&
          (cookie.path.endsWith("/") || target.pathname[cookie.path.length] === "/"));
      return (
        domainMatches &&
        pathMatches &&
        (!cookie.secure || target.protocol === "https:") &&
        (cookie.expires <= 0 || cookie.expires > now)
      );
    })
    .sort((a, b) => b.path.length - a.path.length)
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

/** Cookies of one sign-in. Each setup starts empty, so no previous session can stand in for the password. */
export class LoginSession {
  private cookies: Cookie[] = [];
  /** Stores a Set-Cookie header received from `url`; an expired one removes the stored cookie. */
  receive(setCookie: string, url: string, now = Date.now() / 1000): void {
    const [pair = "", ...attributes] = setCookie.split(";").map((part) => part.trim());
    const at = pair.indexOf("=");
    if (at < 1) return;
    const attribute = (name: string) =>
      attributes
        .find((a) => a.toLowerCase().startsWith(`${name}=`))
        ?.slice(name.length + 1)
        .trim();
    const host = new URL(url).hostname;
    const domain = attribute("domain")?.replace(/^\./, "").toLowerCase();
    // Only for the responding host or a parent domain within dmm.com, never a whole public suffix.
    if (domain && ((host !== domain && !host.endsWith(`.${domain}`)) || !/(^|\.)dmm\.com$/.test(domain)))
      return;
    const maxAge = attribute("max-age");
    const expiresAt = attribute("expires");
    const expires =
      maxAge !== undefined ? now + Number(maxAge) : expiresAt ? Date.parse(expiresAt) / 1000 : -1;
    const cookie: Cookie = {
      name: pair.slice(0, at),
      value: pair.slice(at + 1),
      domain: domain ? `.${domain}` : host,
      path: attribute("path") ?? "/",
      secure: attributes.some((a) => a.toLowerCase() === "secure"),
      expires,
    };
    this.cookies = this.cookies.filter(
      (c) => !(c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path),
    );
    if (expires === -1 || expires > now) this.cookies.push(cookie);
  }
  header(url: string): string {
    return cookieHeader(this.cookies, url);
  }
  has(name: string, url: string): boolean {
    return this.header(url)
      .split("; ")
      .some((pair) => pair.startsWith(`${name}=`));
  }
  /**
   * Requests `url` and follows redirects within DMM, keeping cookies. Stops before a redirect that
   * `stopAt` accepts and returns that URL, so a token in its fragment is read rather than requested.
   */
  async visit(
    url: string,
    init: { method?: string; form?: URLSearchParams; referer?: string } = {},
    stopAt: (next: URL) => boolean = () => false,
  ): Promise<{ url: URL; body: string }> {
    let current = new URL(url);
    let request = init;
    for (let hop = 0; hop < 15; hop++) {
      if (current.protocol !== "https:" || !/(^|\.)dmm\.com$/.test(current.hostname))
        throw new Error("DMM以外のログイン先を拒否しました。");
      const response = await fetch(current, {
        method: request.method ?? "GET",
        body: request.form,
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
        headers: {
          "User-Agent": USER_AGENT,
          "Accept-Language": "ja",
          Cookie: this.header(current.href),
          ...(request.form && {
            "Content-Type": "application/x-www-form-urlencoded",
            Origin: current.origin,
          }),
          ...(request.referer && { Referer: request.referer }),
        },
      });
      for (const setCookie of response.headers.getSetCookie()) this.receive(setCookie, current.href);
      const location = response.headers.get("location");
      if (response.status < 300 || response.status >= 400 || !location)
        return { url: current, body: await response.text() };
      await response.body?.cancel();
      const next = new URL(location, current);
      if (stopAt(next)) return { url: next, body: "" };
      current = next;
      request = {};
    }
    throw new Error("DMMのログインでリダイレクトが続きました。");
  }
}

/** The hidden fields of DMM's password form (one-time token, device id, ...), which must be sent back. */
export function passwordForm(html: string): Record<string, string> {
  const $ = cheerio.load(html);
  const form = $('form[action*="/password/authenticate"]');
  if (!form.find('input[name="login_id"]').length || !form.find('input[name="password"]').length)
    throw new Error("DMMのログインフォームが変更されています。");
  return Object.fromEntries(
    form
      .find('input[type="hidden"][name]')
      .toArray()
      .map((input) => [$(input).attr("name") ?? "", $(input).attr("value") ?? ""]),
  );
}

/** Why DMM sent the sign-in back to the login page, from the error list it embeds in that page. */
export function loginErrors(html: string): string[] {
  const list = /"error":(\[[^\]]*\])/.exec(html)?.[1];
  if (!list) return [];
  try {
    return (JSON.parse(list) as unknown[]).filter((e): e is string => typeof e === "string");
  } catch {
    return [];
  }
}

/** Signs in to the DMM account with the password; DMM sets its shared session on .dmm.com. */
async function signInToDmm(session: LoginSession, identity: LoginIdentity): Promise<void> {
  const page = await session.visit(PASSWORD_LOGIN);
  const form = new URLSearchParams({
    ...passwordForm(page.body),
    login_id: identity.email,
    password: identity.password,
    use_auto_login: "1",
  });
  identity.password = "";
  const result = await session.visit(`${PASSWORD_LOGIN}/authenticate`, {
    method: "POST",
    form,
    referer: page.url.href,
  });
  if (session.has("login_session_id", HISTORY)) return;
  const errors = loginErrors(result.body);
  if (errors.some((e) => /メールアドレス|パスワード/.test(e)))
    throw new LoginRejected(
      "DMMへのログインが拒否されました。メールアドレス・パスワードを確認してください。",
    );
  if (!errors.length && result.url.hostname === "accounts.dmm.com")
    throw new LoginRejected(
      "DMMから追加認証が求められました。通常のDMMサイトで認証を完了してからdmm setupを再実行してください。",
    );
  throw new Error(`DMMへのログインが完了しませんでした。${errors.join(" ")}`.trim());
}

/** Trades the DMM session for the DMM英会話 API token, the way the web app signs in (OAuth implicit flow). */
async function apiToken(session: LoginSession): Promise<string> {
  const authorize = new URL(API_AUTHORIZE);
  authorize.search = new URLSearchParams({
    client_id: API_CLIENT_ID,
    response_type: "token",
    redirect_uri: API_CALLBACK,
    scope: "allUnprivileged",
    provider: "dmm",
    brand: EIKAIWA_BRAND,
    client_type: "desktop",
    display: "page",
    state: crypto.randomUUID(),
  }).toString();
  const { url } = await session.visit(authorize.href, {}, (next) => next.href.startsWith(API_CALLBACK));
  const answer = new URLSearchParams(url.hash.slice(1));
  const token = answer.get("access_token");
  if (!url.href.startsWith(API_CALLBACK) || !token)
    throw new Error(
      `DMM英会話の録音への接続を取得できませんでした${answer.get("error") ? ` (${answer.get("error")})` : ""}。`,
    );
  return `Bearer ${token}`;
}

/** Signs in, proves both the history page and the recording API accept the session, then saves it. */
export async function setupLogin(
  store: Store,
  report: (message: string) => void,
  identity: LoginIdentity,
): Promise<void> {
  try {
    // Earlier versions signed in through a Chrome profile here; it may still hold an old DMM session.
    rmSync(store.path("login-browser"), { recursive: true, force: true });
    const session = new LoginSession();
    report("メールアドレスとパスワードで認証しています…");
    await signInToDmm(session, identity);
    report("ログインを確認しました。録音への接続を確認しています…");
    const credentials: Credentials = { dmmCookie: session.header(HISTORY), bearer: await apiToken(session) };
    const client = new DmmClient(credentials);
    const page = parseHistory(await client.history("/lesson/"));
    for (const lesson of page.lessons) store.merge(lesson);
    const bookingId = page.lessons.find((l) => l.bookingId)?.bookingId;
    if (bookingId) await client.api(`/api/lesson_bookings/${bookingId}/combined`);
    else await client.currentUser();
    // Replace, rather than merge, credentials so a previous account's token cannot survive setup.
    atomicJson(store.path("credentials.json"), {
      ...credentials,
      savedAt: new Date().toISOString(),
      email: identity.email,
    });
    store.save();
    report("ログイン情報を保存しました。");
  } finally {
    identity.password = "";
  }
}
