import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createConversation } from "../src/conversation";
import { measureSpeaking } from "../src/metrics";
import { Store } from "../src/store";
import { ensureSpeech } from "../src/transcription";

function wave(seconds: number, amplitude = 1000) {
  const sampleRate = 8000;
  const size = seconds * sampleRate * 2;
  const buffer = Buffer.alloc(44 + size);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + size, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(size, 40);
  for (let i = 0; i < size / 2; i++)
    buffer.writeInt16LE(Math.round(Math.sin((i * 220 * 2 * Math.PI) / sampleRate) * amplitude), 44 + i * 2);
  return buffer;
}

test.skipIf(!Bun.which("ffmpeg") || !Bun.which("ffprobe"))(
  "音声を各AI処理の作業フォルダ内に置き、短い話者録音を超えて空の区間を作らない",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "dmm-conversation-audio-"));
    try {
      const store = new Store(root);
      const lesson = store.merge({
        id: "test",
        date: "2026-11-02",
        teacher: "Tutor",
        topic: "",
        attended: true,
        phase: "done",
        reviewed: [],
        audio: { file: "audio/test.mp3", origin: "2026-11-02T00:00:00Z", seconds: 200 },
        tracks: ["Teacher", "Student"].map((role) => ({
          id: role,
          role: role as "Teacher" | "Student",
          start: "2026-11-02T00:00:00Z",
          mime: "audio/webm",
          chunks: [],
        })),
      });
      mkdirSync(store.path("work", lesson.id), { recursive: true });
      writeFileSync(store.path("work", lesson.id, "teacher.mp3"), wave(3.5));
      writeFileSync(store.path("work", lesson.id, "student.mp3"), wave(2.5));
      let calls = 0;
      const saved = await createConversation(store, lesson, "gemini-test", async (request) => {
        calls++;
        const inputs = JSON.parse(request.prompt.split("\n").at(-1) ?? "[]") as { file: string }[];
        const file = inputs[0]?.file;
        if (!file) throw new Error("Missing audio path");
        expect(dirname(file)).toBe(request.workDir);
        expect(await Bun.file(file).size).toBeGreaterThan(100);
        return JSON.stringify({
          status: "SUCCESS",
          response: { segments: [{ start: 0.2, end: 1.5, text: "Hello." }] },
        });
      });
      expect(calls).toBe(2);
      expect(saved.segments).toHaveLength(2);
      await measureSpeaking(store, lesson, "gemini-test", async () => {
        throw new Error("Unexpected duplicate transcription");
      });
      expect(lesson.metrics?.words).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(!Bun.which("ffmpeg") || !Bun.which("ffprobe"))("無音だけの録音はAIに送らない", async () => {
  const root = mkdtempSync(join(tmpdir(), "dmm-silent-audio-"));
  try {
    const store = new Store(root);
    const lesson = store.merge({
      id: "silent",
      date: "2026-11-02",
      teacher: "Tutor",
      topic: "",
      attended: true,
      phase: "done",
      reviewed: [],
      audio: { file: "audio/silent.mp3", origin: "2026-11-02T00:00:00Z", seconds: 2 },
      tracks: [
        { id: "student", role: "Student", start: "2026-11-02T00:00:00Z", mime: "audio/webm", chunks: [] },
      ],
    });
    mkdirSync(store.path("work", lesson.id), { recursive: true });
    writeFileSync(store.path("work", lesson.id, "student.mp3"), wave(2, 0));
    const saved = await ensureSpeech(store, lesson, "Student", "gemini-test", async () => {
      throw new Error("Unexpected AI call for silence");
    });
    expect(saved.transcript).toBe("");
    expect(saved.segments).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
