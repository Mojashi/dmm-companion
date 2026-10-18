import { existsSync, mkdirSync, renameSync } from "node:fs";
import { recordingUrl } from "./dmm";
import type { Lesson } from "./domain";
import { discoverRecording } from "./importer";
import { command } from "./process";
import type { Store } from "./store";

export function timeline(lesson: Lesson): { origin: string; seconds: number; offsets: number[] } {
  if (!lesson.tracks.length) throw new Error("音声がありません。");
  const starts = lesson.tracks.map((t) => Date.parse(t.start));
  if (starts.some((s) => !Number.isFinite(s))) throw new Error("録音の開始時刻が不正です。");
  const origin = Math.min(...starts);
  const offsets = starts.map((s) => (s - origin) / 1000);
  const seconds = Math.max(
    ...lesson.tracks.map((t, i) => (offsets[i] ?? 0) + t.chunks.reduce((s, c) => s + c.seconds, 0)),
  );
  return { origin: new Date(origin).toISOString(), seconds, offsets };
}

export async function prepareAudio(store: Store, lesson: Lesson): Promise<void> {
  if (lesson.audio && existsSync(store.path(lesson.audio.file))) return;
  const auth = store.credentials();
  const missing = lesson.tracks.some((t) => t.chunks.some((c) => !existsSync(store.path("chunks", c.key))));
  if (!lesson.tracks.length || (missing && (auth.bearer || auth.apiCookie)))
    await discoverRecording(store, lesson.id);
  if (!Bun.which("ffmpeg") || !Bun.which("ffprobe"))
    throw new Error("音声の復元にはffmpegが必要です。macOS: brew install ffmpeg");
  const alignment = timeline(lesson);
  const work = store.path("work", lesson.id);
  mkdirSync(work, { recursive: true, mode: 0o700 });
  const inputs: string[] = [];
  for (const track of lesson.tracks) {
    if (!/^[\w-]+$/.test(track.id) || !track.chunks.length) throw new Error("録音の構成が不正です。");
    for (const chunk of track.chunks) {
      const path = store.path("chunks", chunk.key);
      if (existsSync(path)) continue;
      const response = await fetch(recordingUrl(chunk.url), {
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok)
        throw new Error(`録音を取得できません (HTTP ${response.status})。同期してから再分析してください。`);
      await Bun.write(`${path}.part`, response);
      renameSync(`${path}.part`, path);
    }
    // MediaRecorder chunks are byte fragments of ONE WebM stream, not separate media files.
    const stream = store.path("work", lesson.id, `${track.id}.webm`);
    const writer = Bun.file(stream).writer();
    try {
      for (const chunk of track.chunks)
        writer.write(await Bun.file(store.path("chunks", chunk.key)).arrayBuffer());
    } finally {
      await writer.end();
    }
    inputs.push(stream);
  }
  const filter =
    lesson.tracks
      .map(
        (_, i) =>
          `[${i}:a]aresample=24000,asetpts=PTS-STARTPTS,adelay=${Math.round((alignment.offsets[i] ?? 0) * 1000)}:all=1[a${i}]`,
      )
      .join(";") +
    `;${lesson.tracks.map((_, i) => `[a${i}]`).join("")}amix=inputs=${inputs.length}:normalize=0:duration=longest,alimiter=limit=0.95:level=false[mix]`;
  const file = `audio/${lesson.id}.mp3`;
  const temp = store.path("work", lesson.id, "mixed.mp3");
  await command([
    "ffmpeg",
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    ...inputs.flatMap((p) => ["-i", p]),
    "-filter_complex",
    filter,
    "-map",
    "[mix]",
    "-ac",
    "1",
    "-ar",
    "24000",
    "-b:a",
    "64k",
    temp,
  ]);
  const probe = JSON.parse(
    await command(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", temp]),
  ) as { format: { duration: string } };
  const seconds = Number(probe.format.duration);
  if (!Number.isFinite(seconds) || seconds < alignment.seconds - 3 || seconds > alignment.seconds + 10)
    throw new Error("復元した録音の長さが元データと一致しません。音声の欠落を確認してください。");
  renameSync(temp, store.path(file));
  lesson.audio = { file, seconds, origin: alignment.origin };
  store.save();
}
