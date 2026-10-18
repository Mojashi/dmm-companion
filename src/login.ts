import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DmmClient, parseHistory } from "./dmm";
import type { Credentials } from "./domain";
import type { LoginIdentity } from "./prompt";
import { atomicJson, type Store } from "./store";

/** DMM refused the email/password itself, so trying the same password again cannot succeed. */
export class LoginRejected extends Error {}

type Cookie = { name: string; value: string; domain: string; path: string; secure: boolean; expires: number };
type EventHandler = (method: string, params: Record<string, unknown>) => void;

/** Only controls the Chrome process launched for this app's dedicated login profile. */
class LoginConnection {
  private sequence = 0;
  private pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();
  onEvent: EventHandler = () => {};
  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
        method?: string;
        params?: Record<string, unknown>;
      };
      if (message.id) {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) waiter?.reject(new Error(`ログイン用ブラウザ: ${message.error.message}`));
        else waiter?.resolve(message.result);
      } else if (message.method) this.onEvent(message.method, message.params ?? {});
    });
    socket.addEventListener("close", () => {
      for (const waiter of this.pending.values())
        waiter.reject(new Error("ログイン用ブラウザが閉じられました。"));
      this.pending.clear();
    });
  }
  static async connect(url: string): Promise<LoginConnection> {
    const socket = new WebSocket(url);
    const connection = new LoginConnection(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ログイン用ブラウザに接続できません。")), 10_000);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("ログイン用ブラウザの接続が失敗しました。"));
        },
        { once: true },
      );
    });
    return connection;
  }
  async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ログイン処理がタイムアウトしました (${method})。`));
      }, 15_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  close() {
    this.socket.close();
  }
}

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

export function captureApiHeaders(
  url: string,
  headers: Record<string, unknown>,
  credentials: Credentials,
): void {
  if (new URL(url).origin !== "https://api.engoo.com") return;
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== "string") continue;
    if (key.toLowerCase() === "authorization" && /^Bearer\s+\S+$/i.test(value)) credentials.bearer = value;
    if (key.toLowerCase() === "x-viewmodel-versions") credentials.viewmodel = value;
  }
}

function chromeExecutable(explicit?: string): string {
  const paths = explicit
    ? [explicit]
    : process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        ]
      : ["google-chrome", "chromium", "chromium-browser", "chrome.exe"];
  for (const path of paths) {
    const resolved = Bun.which(path);
    if (resolved) return resolved;
  }
  throw new Error(
    "Google Chromeが見つかりません。インストールするか、dmm setup --browser PATHで実行ファイルを指定してください。",
  );
}

export async function setupLogin(
  store: Store,
  report: (message: string) => void,
  identity: LoginIdentity,
  options: { browser?: string } = {},
): Promise<void> {
  try {
    await withFreshLoginProfile(store.path("login-browser"), (profile) =>
      loginWithBrowser(store, report, identity, profile, options),
    );
  } finally {
    identity.password = "";
  }
}

/** Every setup validates the supplied password, independently of previous browser sessions. */
export async function withFreshLoginProfile(
  root: string,
  signIn: (profile: string) => Promise<void>,
): Promise<void> {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const profile = mkdtempSync(join(root, "attempt-"));
  try {
    await signIn(profile);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}

async function loginWithBrowser(
  store: Store,
  report: (message: string) => void,
  identity: LoginIdentity,
  profile: string,
  options: { browser?: string },
): Promise<void> {
  const activePort = join(profile, "DevToolsActivePort");
  const child = Bun.spawn(
    [
      chromeExecutable(options.browser),
      `--user-data-dir=${profile}`,
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--headless=new",
      "about:blank",
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  const terminate = () => {
    child.kill();
  };
  process.once("exit", terminate);
  let connection: LoginConnection | undefined;
  try {
    const launchDeadline = Date.now() + 20_000;
    while (!existsSync(activePort)) {
      if (child.exitCode !== null || Date.now() > launchDeadline)
        throw new Error(
          "ログイン用Chromeを起動できません。DMM Companion用のChromeを閉じて再実行してください。",
        );
      await Bun.sleep(150);
    }
    const port = Number(readFileSync(activePort, "utf8").split("\n")[0]);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("Chromeの接続ポートが不正です。");
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
      type: string;
      webSocketDebuggerUrl?: string;
    }[];
    const target = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (!target?.webSocketDebuggerUrl) throw new Error("ログインタブを開けません。");
    connection = await LoginConnection.connect(target.webSocketDebuggerUrl);
    const auth: Credentials = {};
    const requests = new Map<string, string>();
    const extras = new Map<string, Record<string, unknown>>();
    connection.onEvent = (method, params) => {
      if (method === "Network.requestWillBeSent") {
        const request = params.request as { url: string; headers: Record<string, unknown> };
        const id = String(params.requestId);
        if (!request.url.startsWith("https://api.engoo.com/")) return;
        requests.set(id, request.url);
        captureApiHeaders(request.url, request.headers, auth);
        const extra = extras.get(id);
        if (extra) {
          captureApiHeaders(request.url, extra, auth);
          extras.delete(id);
        }
      }
      if (method === "Network.requestWillBeSentExtraInfo") {
        const id = String(params.requestId);
        const headers = params.headers as Record<string, unknown>;
        const url = requests.get(id);
        if (url) captureApiHeaders(url, headers, auth);
        else {
          if (extras.size > 300) extras.clear();
          extras.set(id, headers);
        }
      }
    };
    await connection.send("Network.enable");
    await connection.send("Page.enable");
    await connection.send("Page.navigate", { url: "https://eikaiwa.dmm.com/lesson/" });
    report("DMMのログインフォームを開いています…");
    await signInWithPassword(connection, identity, report);
    identity.password = "";
    const deadline = Date.now() + 90_000;
    let bookingId: string | undefined;
    let historyReady = false;
    let stageReported = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null)
        throw new Error("ログイン用Chromeが終了しました。dmm setupを再実行してください。");
      const { cookies } = await connection.send<{ cookies: Cookie[] }>("Network.getCookies", {
        urls: ["https://eikaiwa.dmm.com/lesson/", "https://api.engoo.com/api/users/current"],
      });
      const dmmCookie = cookieHeader(cookies, "https://eikaiwa.dmm.com/lesson/");
      const apiCookie = cookieHeader(cookies, "https://api.engoo.com/api/users/current");
      if (dmmCookie) auth.dmmCookie = dmmCookie;
      if (apiCookie) auth.apiCookie = apiCookie;
      if (auth.dmmCookie && !historyReady) {
        try {
          const page = parseHistory(await new DmmClient(auth).history("/lesson/"));
          historyReady = true;
          for (const lesson of page.lessons) store.merge(lesson);
          bookingId = page.lessons.find((l) => l.bookingId)?.bookingId;
          if (bookingId) {
            const short = Buffer.from(bookingId.replaceAll("-", ""), "hex").toString("base64url");
            await connection.send("Page.navigate", {
              url: `https://eikaiwa.dmm.com/app/lesson-booking/${short}`,
            });
          } else await connection.send("Page.navigate", { url: "https://eikaiwa.dmm.com/app/" });
        } catch (error) {
          if (!(error instanceof Error) || !/認証|ログイン|履歴ページ/.test(error.message)) throw error;
        }
      }
      if (historyReady && !stageReported) {
        report("ログインを確認しました。録音への接続を確認しています…");
        stageReported = true;
      }
      if (historyReady && (auth.bearer || auth.apiCookie)) {
        try {
          const client = new DmmClient(auth);
          if (bookingId) await client.api(`/api/lesson_bookings/${bookingId}/combined`);
          else await client.currentUser();
          // Replace, rather than merge, credentials so a previous account's token cannot survive setup.
          auth.savedAt = new Date().toISOString();
          auth.email = identity.email;
          atomicJson(store.path("credentials.json"), auth);
          store.save();
          report("ログイン情報を保存しました。");
          return;
        } catch (error) {
          if (!(error instanceof Error) || !/認証/.test(error.message)) throw error;
        }
      }
      await Bun.sleep(1200);
    }
    throw new Error("ログイン後の接続を確認できませんでした。dmm setupを再実行してください。");
  } finally {
    identity.password = "";
    process.removeListener("exit", terminate);
    if (connection) {
      try {
        await connection.send("Browser.close");
      } catch {
        /* Browser.close may close the socket before replying. */
      }
      connection.close();
    }
    child.kill();
    await child.exited;
  }
}

type LoginPage = {
  url: string;
  hasPassword: boolean;
  loginLink: string | null;
  error: string;
  challenge: boolean;
};
async function signInWithPassword(
  connection: LoginConnection,
  identity: LoginIdentity,
  report: (message: string) => void,
): Promise<void> {
  const deadline = Date.now() + 90_000;
  let submitted = false;
  const followed = new Set<string>();
  while (Date.now() < deadline) {
    const state = await connection.send<{ result: { value?: LoginPage }; exceptionDetails?: unknown }>(
      "Runtime.evaluate",
      {
        expression: `(() => {
        const form = document.querySelector('form[action*="/password/authenticate"]');
        const anchor = Array.from(document.querySelectorAll('a[href]')).find(a => a.href.includes('/app/oauth/authorize') && a.href.includes('force_login=1'))
          || Array.from(document.querySelectorAll('a[href]')).find(a => a.href.includes('accounts.dmm.com/service/login/password'));
        const error = Array.from(document.querySelectorAll('.error-message, .errorMessage, .message--error, [role="alert"]')).map(e => e.textContent).join(' ').trim();
        return { url: location.href, hasPassword: !!form?.querySelector('input[name="login_id"]') && !!form?.querySelector('input[name="password"]'), loginLink: anchor?.href ?? null, error,
          challenge: !!document.querySelector('input[autocomplete="one-time-code"], iframe[src*="recaptcha"][title*="challenge"]') };
      })()`,
        returnByValue: true,
      },
    );
    const page = state.result.value;
    if (!page) {
      await Bun.sleep(500);
      continue;
    }
    const url = new URL(page.url);
    if (page.challenge)
      throw new LoginRejected(
        "DMMから追加認証が求められました。通常のDMMサイトで認証を完了してからdmm setupを再実行してください。",
      );
    if (submitted && page.error)
      throw new LoginRejected(
        "DMMへのログインが拒否されました。メールアドレス・パスワード、または追加認証を確認してください。",
      );
    if (
      submitted &&
      url.hostname === "eikaiwa.dmm.com" &&
      !url.pathname.includes("/login") &&
      !url.pathname.includes("/oauth")
    )
      return;
    if (!submitted && page.hasPassword && url.origin === "https://accounts.dmm.com") {
      report("メールアドレスとパスワードで認証しています…");
      const credentials = JSON.stringify({ email: identity.email, password: identity.password });
      const result = await connection.send<{ exceptionDetails?: unknown }>("Runtime.evaluate", {
        expression: `(() => {
          const credentials = ${credentials};
          const form = document.querySelector('form[action*="/password/authenticate"]');
          for (const [name, value] of [['login_id', credentials.email], ['password', credentials.password]]) {
            const input = form.querySelector('input[name="' + name + '"]');
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
          const remember = form.querySelector('input[name="use_auto_login"]');
          if (remember && !remember.checked) remember.click();
          const submit = form.querySelector('button[type="submit"], input[type="submit"]');
          if (submit) submit.click(); else form.requestSubmit();
        })()`,
        returnByValue: true,
      });
      if (result.exceptionDetails) throw new Error("DMMのログインフォームが変更されています。");
      submitted = true;
    } else if (!submitted && page.loginLink && !followed.has(page.loginLink)) {
      const target = new URL(page.loginLink);
      if (target.protocol !== "https:" || !["eikaiwa.dmm.com", "accounts.dmm.com"].includes(target.hostname))
        throw new Error("DMM以外のログイン先を拒否しました。");
      followed.add(page.loginLink);
      await connection.send("Page.navigate", { url: target.href });
    }
    await Bun.sleep(750);
  }
  throw new Error("DMMへのログインが完了しませんでした。入力情報または追加認証を確認してください。");
}
