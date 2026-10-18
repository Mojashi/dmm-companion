import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Credentials, Lesson, Library } from "./domain";

export const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
export function atomicJson(path: string, value: unknown): void {
  writeFileSync(`${path}.new`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.new`, path);
  chmodSync(path, 0o600);
}
export class Store {
  readonly root: string;
  readonly library: Library;
  constructor(root: string) {
    this.root = resolve(root);
    for (const dir of ["", "chunks", "audio", "sources", "analyses", "work"])
      mkdirSync(join(this.root, dir), { recursive: true, mode: 0o700 });
    chmodSync(this.root, 0o700);
    this.library = existsSync(this.path("library.json"))
      ? (JSON.parse(readFileSync(this.path("library.json"), "utf8")) as Library)
      : {
          version: 1,
          lessons: [],
          imports: [],
          coverage: { months: [], availableMonths: [], complete: false },
        };
    if (this.library.version !== 1) throw new Error("未対応のライブラリ形式です。");
    for (const lesson of this.library.lessons) {
      if (lesson.feedback && lesson.feedback.source === undefined) {
        lesson.feedback.source = "audio_transcript";
        for (const expression of lesson.feedback.expressions) expression.at = null;
      }
      if (["queued", "downloading", "listening"].includes(lesson.phase)) {
        lesson.phase = "error";
        lesson.error = "前回の処理が中断されました。再分析で保存済み音声から再開できます。";
      }
    }
    this.save();
  }
  path(...parts: string[]): string {
    return join(this.root, ...parts);
  }
  save(): void {
    this.library.lessons.sort((a, b) => b.date.localeCompare(a.date));
    atomicJson(this.path("library.json"), this.library);
    atomicJson(this.path("manifest.json"), {
      version: 1,
      updatedAt: new Date().toISOString(),
      source: "DMM Eikaiwa HAR / authenticated GET",
      conditions: this.library.coverage,
      imports: this.library.imports,
      counts: {
        lessons: this.library.lessons.length,
        attended: this.library.lessons.filter((l) => l.attended).length,
        withRecordings: this.library.lessons.filter((l) => l.tracks.length).length,
        downloadedAudio: this.library.lessons.filter((l) => l.audio).length,
        analyzed: this.library.lessons.filter((l) => l.feedback).length,
      },
    });
  }
  lesson(id: string): Lesson {
    const lesson = this.library.lessons.find((l) => l.id === id || l.bookingId === id);
    if (!lesson) throw new Error("レッスンが見つかりません。");
    return lesson;
  }
  merge(incoming: Lesson): Lesson {
    const existing = this.library.lessons.find(
      (l) =>
        l.id === incoming.id ||
        (incoming.bookingId && l.bookingId === incoming.bookingId) ||
        (incoming.noteId && l.noteId === incoming.noteId),
    );
    if (!existing) {
      this.library.lessons.push(incoming);
      return incoming;
    }
    Object.assign(existing, {
      bookingId: incoming.bookingId ?? existing.bookingId,
      noteId: incoming.noteId ?? existing.noteId,
      roomId: incoming.roomId ?? existing.roomId,
      date: incoming.date || existing.date,
      teacher: incoming.teacher || existing.teacher,
      topic: incoming.topic || existing.topic,
      attended: incoming.attended,
      tracks: incoming.tracks.length ? incoming.tracks : existing.tracks,
    });
    return existing;
  }
  credentials(): Credentials {
    return existsSync(this.path("credentials.json"))
      ? (JSON.parse(readFileSync(this.path("credentials.json"), "utf8")) as Credentials)
      : {};
  }
  saveCredentials(credentials: Credentials): void {
    atomicJson(this.path("credentials.json"), { ...this.credentials(), ...credentials });
  }
}
