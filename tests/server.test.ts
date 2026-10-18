import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Companion } from "../src/coach";
import { serve } from "../src/server";
import { Store } from "../src/store";
import { noSavedLogin } from "./fakes";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

test("ローカルAPIの認証・Origin検証と音声Range配信", async () => {
  const root = mkdtempSync(join(tmpdir(), "dmm-server-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  store.saveCredentials({ bearer: "Bearer private-credential" });
  await Bun.write(store.path("audio", "test.mp3"), new Uint8Array([0, 1, 2, 3, 4, 5]));
  store.merge({
    id: "test",
    date: "2026-01-01",
    teacher: "Teacher",
    topic: "",
    attended: true,
    tracks: [],
    phase: "idle",
    reviewed: [],
    audio: { file: "audio/test.mp3", seconds: 1, origin: "2026-01-01" },
  });
  const { server, url } = serve(new Companion(store, "gemini-test", noSavedLogin), 0);
  cleanups.push(() => {
    void server.stop(true);
  });
  const base = new URL(url);
  const headers = { "x-companion-token": base.hash.slice(1) };
  expect((await fetch(`${base.origin}/api/library`)).status).toBe(401);
  expect(
    (
      await fetch(`${base.origin}/api/sync`, {
        method: "POST",
        headers: { ...headers, Origin: "https://attacker.test" },
      })
    ).status,
  ).toBe(403);
  const library = await fetch(`${base.origin}/api/library`, { headers });
  expect(library.status).toBe(200);
  expect(await library.text()).not.toContain("private-credential");
  const audio = await fetch(`${base.origin}/api/lessons/test/audio`, {
    headers: { ...headers, Range: "bytes=2-4" },
  });
  expect(audio.status).toBe(206);
  expect(audio.headers.get("Content-Range")).toBe("bytes 2-4/6");
  expect([...new Uint8Array(await audio.arrayBuffer())]).toEqual([2, 3, 4]);
  expect(
    (await fetch(`${base.origin}/api/lessons/test/audio`, { headers: { ...headers, Range: "bytes=20-30" } }))
      .status,
  ).toBe(416);
  expect((await fetch(`${base.origin}/api/setup`, { method: "POST", headers, body: "{}" })).status).toBe(400);
  expect(statSync(store.path("credentials.json")).mode & 0o777).toBe(0o600);
  expect(statSync(root).mode & 0o777).toBe(0o700);
});
