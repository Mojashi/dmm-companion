import { expect, test } from "bun:test";
import { cookieHeader, LoginSession, loginErrors, passwordForm } from "../src/login";

test("Cookieをドメイン・パス・期限・HTTPSで絞り込む", () => {
  const base = { value: "test", domain: ".dmm.com", path: "/", secure: true, expires: 200 };
  const cookies = [
    { ...base, name: "valid" },
    { ...base, name: "expired", expires: 90 },
    { ...base, name: "other", domain: "accounts.dmm.com" },
    { ...base, name: "scoped", path: "/lesson" },
    { ...base, name: "session", expires: -1 },
  ];
  expect(cookieHeader(cookies, "https://eikaiwa.dmm.com/lesson/", 100)).toBe(
    "scoped=test; valid=test; session=test",
  );
  expect(cookieHeader(cookies, "https://eikaiwa.dmm.com/lessons/", 100)).toBe("valid=test; session=test");
  expect(cookieHeader(cookies, "https://dmm.com.attacker.test/", 100)).toBe("");
  expect(cookieHeader(cookies, "http://eikaiwa.dmm.com/lesson/", 100)).toBe("");
});

test("ログイン中のSet-Cookieをドメイン付きで保持し、期限切れで削除する", () => {
  const session = new LoginSession();
  const now = Date.now() / 1000;
  session.receive(
    "login_session_id=abc; Domain=.dmm.com; Path=/; Secure; HttpOnly",
    "https://accounts.dmm.com/x",
    now,
  );
  session.receive("host_only=1; Path=/", "https://accounts.dmm.com/x", now);
  session.receive("short=1; Max-Age=60; Path=/", "https://accounts.dmm.com/x", now);
  expect(session.header("https://eikaiwa.dmm.com/lesson/")).toBe("login_session_id=abc");
  expect(session.has("login_session_id", "https://eikaiwa.dmm.com/lesson/")).toBe(true);
  expect(session.header("https://accounts.dmm.com/")).toBe("login_session_id=abc; host_only=1; short=1");
  session.receive("login_session_id=; Domain=dmm.com; Path=/; Max-Age=0", "https://www.dmm.com/", now);
  expect(session.has("login_session_id", "https://eikaiwa.dmm.com/lesson/")).toBe(false);
});

test("別ドメイン宛てのCookieは受け取らない", () => {
  const session = new LoginSession();
  session.receive("stolen=1; Domain=attacker.test; Path=/", "https://accounts.dmm.com/");
  session.receive("parent=1; Domain=com; Path=/", "https://accounts.dmm.com/");
  expect(session.header("https://attacker.test/")).toBe("");
  expect(session.header("https://example.com/")).toBe("");
  expect(session.header("https://accounts.dmm.com/")).toBe("");
});

test("ログインフォームの隠し項目を送り返せる形で取り出す", () => {
  const html = `<form action="/service/login/password/authenticate" method="post">
    <input type="hidden" name="token" value="t1"/><input type="hidden" name="user_device" value="d1"/>
    <input type="email" name="login_id"/><input type="password" name="password"/>
    <input type="hidden" name="recaptchaToken" value=""/></form>`;
  expect(passwordForm(html)).toEqual({ token: "t1", user_device: "d1", recaptchaToken: "" });
  expect(() => passwordForm("<form action='/other'></form>")).toThrow("ログインフォームが変更");
});

test("ログイン画面に戻された理由を読み取る", () => {
  expect(
    loginErrors('{"isStatic":false,"error":["メールアドレスまたはパスワードが正しくありません。"]}'),
  ).toEqual(["メールアドレスまたはパスワードが正しくありません。"]);
  expect(loginErrors('{"error":[]}')).toEqual([]);
  expect(loginErrors("<html></html>")).toEqual([]);
});
