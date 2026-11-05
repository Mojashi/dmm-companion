import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Companion } from "../src/coach";
import { type Conversation, type ConversationAI, readConversation } from "../src/conversation";
import { serve } from "../src/server";
import { Store } from "../src/store";
import { noSavedLogin } from "./fakes";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

test("会話ログと質問APIは認証・入力・重複実行を検証し、保存した履歴を返す", async () => {
  const root = mkdtempSync(join(tmpdir(), "dmm-conversation-server-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  store.merge({
    id: "test",
    date: "2026-11-02",
    teacher: "Teacher",
    topic: "",
    attended: true,
    phase: "done",
    reviewed: [],
    audio: { file: "audio/test.mp3", seconds: 10, origin: "2026-11-02T00:00:00Z" },
    tracks: ["Teacher", "Student"].map((role) => ({
      id: role,
      role: role as "Teacher" | "Student",
      start: "2026-11-02T00:00:00Z",
      mime: "audio/webm",
      chunks: [],
    })),
  });
  store.save();
  mkdirSync(store.path("work", "test"));
  writeFileSync(store.path("audio", "test.mp3"), "cached audio");
  for (const role of ["teacher", "student"])
    writeFileSync(store.path("work", "test", `${role}.mp3`), "cached audio");
  let gate = Promise.withResolvers<void>();
  let fail = false;
  let calls = 0;
  const ask: ConversationAI = async (request) => {
    calls++;
    if (request.schema.name === "conversation-answer") expect(request.model).toBe("gemini-budget");
    await gate.promise;
    if (fail) throw new Error("AI unavailable");
    return JSON.stringify({
      status: "SUCCESS",
      response:
        request.schema.name === "conversation-answer"
          ? { text: "短い返し方です。", examples: [], referenceIds: ["teacher-0-0"] }
          : { segments: [{ start: 1, end: 2, text: "hidden-dialogue" }] },
    });
  };
  const companion = new Companion(store, "gemini-test", noSavedLogin, "gemini-budget", {
    ask,
    clips: async () => [{ file: store.path("work", "test", "student.mp3"), start: 0, seconds: 10 }],
  });
  const { server, url } = serve(companion, 0);
  cleanups.push(() => {
    void server.stop(true);
  });
  const base = new URL(url);
  const path = `${base.origin}/api/lessons/test/conversation`;
  const headers = { "x-companion-token": base.hash.slice(1), "Content-Type": "application/json" };
  const post = (target: string, body: unknown, extra: Record<string, string> = {}) =>
    fetch(target, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  expect((await fetch(path, { method: "POST" })).status).toBe(401);
  expect((await post(path, {}, { Origin: "https://attacker.test" })).status).toBe(403);
  expect((await fetch(path.replace("/test/", "/missing/"), { headers })).status).toBe(404);
  const empty = await fetch(path, { headers });
  expect(empty.headers.get("Cache-Control")).toBe("no-store");
  expect(await empty.json()).toEqual({});
  expect((await post(`${path}/teacher-0-0/questions`, { question: "Meaning?" })).status).toBe(409);
  expect(calls).toBe(0);
  expect((await post(path, {})).status).toBe(202);
  expect((await post(path, {})).status).toBe(409);
  const pending = await (await fetch(path, { headers })).json();
  expect(pending.task.busy).toBe(true);
  gate.resolve();
  await companion.idle();
  const saved = (await (await fetch(path, { headers })).json()) as { conversation: Conversation };
  expect(saved.conversation.segments).toHaveLength(2);
  expect(calls).toBe(2);
  expect(await (await fetch(`${base.origin}/api/library`, { headers })).text()).not.toContain(
    "hidden-dialogue",
  );
  for (const body of [{ question: " " }, { question: "a".repeat(2001) }, { question: 42 }, null])
    expect((await post(`${path}/teacher-0-0/questions`, body)).status).toBe(400);
  expect((await post(`${path}/missing/questions`, { question: "Meaning?" })).status).toBe(404);
  expect(calls).toBe(2);
  gate = Promise.withResolvers<void>();
  expect((await post(`${path}/teacher-0-0/questions`, { question: "Meaning?" })).status).toBe(202);
  expect((await post(`${path}/student-0-0/questions`, { question: "Other?" })).status).toBe(409);
  gate.resolve();
  await companion.idle();
  expect(
    readConversation(new Store(root), "test")?.segments.find((s) => s.id === "teacher-0-0")?.questions[0]
      ?.question,
  ).toBe("Meaning?");
  fail = true;
  expect((await post(`${path}/teacher-0-0/questions`, { question: "More?" })).status).toBe(202);
  await companion.idle();
  const failed = await (await fetch(path, { headers })).json();
  expect(failed.task).toMatchObject({ busy: false, error: "AI unavailable", segmentId: "teacher-0-0" });
  expect(
    failed.conversation.segments.find((s: { id: string }) => s.id === "teacher-0-0").questions,
  ).toHaveLength(1);
  expect(companion.status.busy).toBe(false);
  fail = false;
  expect((await post(`${path}/teacher-0-0/questions`, { question: "More?" })).status).toBe(202);
  await companion.idle();
  expect(
    readConversation(store, "test")?.segments.find((s) => s.id === "teacher-0-0")?.questions,
  ).toHaveLength(2);
  const beforeRepeat = calls;
  const repeated = await post(`${path}/teacher-0-0/questions`, { question: "More?" });
  expect(repeated.status).toBe(202);
  await companion.idle();
  expect(calls).toBe(beforeRepeat + 1);
  expect(
    readConversation(store, "test")?.segments.find((s) => s.id === "teacher-0-0")?.questions,
  ).toHaveLength(3);
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
  const { server, url } = serve(new Companion(store, "gemini-test", noSavedLogin, "gemini-test"), 0);
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
