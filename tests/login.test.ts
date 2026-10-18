import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Credentials } from "../src/domain";
import { captureApiHeaders, cookieHeader, withFreshLoginProfile } from "../src/login";

test("setupの再実行・失敗後も前回のブラウザセッションを引き継がない", async () => {
  const root = mkdtempSync(join(tmpdir(), "dmm-login-"));
  try {
    mkdirSync(join(root, "Default"));
    writeFileSync(join(root, "Default", "Cookies"), "previous signed-in session");
    let previous = "";
    await expect(
      withFreshLoginProfile(root, async (profile) => {
        previous = profile;
        expect(existsSync(join(profile, "Default", "Cookies"))).toBe(false);
        mkdirSync(join(profile, "Default"));
        writeFileSync(join(profile, "Default", "Cookies"), "new session");
        throw new Error("authentication failed");
      }),
    ).rejects.toThrow("authentication failed");
    expect(existsSync(previous)).toBe(false);
    await withFreshLoginProfile(root, async (profile) => {
      expect(profile).not.toBe(previous);
      expect(existsSync(join(profile, "Default", "Cookies"))).toBe(false);
      previous = profile;
    });
    expect(existsSync(previous)).toBe(false);
    expect(existsSync(join(root, "Default", "Cookies"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

test("DMM英会話API以外の認証ヘッダーを保存しない", () => {
  const credentials: Credentials = {};
  captureApiHeaders("https://attacker.test/", { Authorization: "Bearer wrong" }, credentials);
  expect(credentials).toEqual({});
  captureApiHeaders(
    "https://api.engoo.com/api/oauth/token",
    { Authorization: "Basic not-a-session" },
    credentials,
  );
  expect(credentials).toEqual({});
  captureApiHeaders(
    "https://api.engoo.com/api/users/current",
    { Authorization: "Bearer session", "X-Viewmodel-Versions": "versions", Cookie: "ignored" },
    credentials,
  );
  expect(credentials).toEqual({ bearer: "Bearer session", viewmodel: "versions" });
});
