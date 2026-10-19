import { existsSync, mkdirSync, renameSync } from "node:fs";
import { recordingUrl } from "./dmm";
import type { Lesson, Track } from "./domain";
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

/** Makes sure the recording list and its chunks are available, and that ffmpeg can process them. */
async function ensureRecording(store: Store, lesson: Lesson): Promise<void> {
  const auth = store.credentials();
  const missing = lesson.tracks.some((t) => t.chunks.some((c) => !existsSync(store.path("chunks", c.key))));
  if (!lesson.tracks.length || (missing && (auth.bearer || auth.apiCookie)))
    await discoverRecording(store, lesson.id);
  if (!Bun.which("ffmpeg") || !Bun.which("ffprobe"))
    throw new Error("音声の復元にはffmpegが必要です。macOS: brew install ffmpeg");
}

/** Downloads missing chunks and joins each track into one WebM stream, in lesson.tracks order. */
async function trackStreams(store: Store, lesson: Lesson): Promise<string[]> {
  mkdirSync(store.path("work", lesson.id), { recursive: true, mode: 0o700 });
  const streams: string[] = [];
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
    streams.push(stream);
  }
  return streams;
}

/** Mixes tracks onto the lesson's absolute timeline (0s = the earliest track start) as mono MP3. */
async function mix(inputs: { stream: string; offset: number }[], out: string, sampleRate: number) {
  const filter =
    inputs
      .map(
        (input, i) =>
          `[${i}:a]aresample=${sampleRate},asetpts=PTS-STARTPTS,adelay=${Math.round(input.offset * 1000)}:all=1[a${i}]`,
      )
      .join(";") +
    `;${inputs.map((_, i) => `[a${i}]`).join("")}amix=inputs=${inputs.length}:normalize=0:duration=longest,alimiter=limit=0.95:level=false[mix]`;
  await command([
    "ffmpeg",
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    ...inputs.flatMap((input) => ["-i", input.stream]),
    "-filter_complex",
    filter,
    "-map",
    "[mix]",
    "-ac",
    "1",
    "-ar",
    String(sampleRate),
    "-b:a",
    "64k",
    out,
  ]);
}

export async function prepareAudio(store: Store, lesson: Lesson): Promise<void> {
  if (lesson.audio && existsSync(store.path(lesson.audio.file))) return;
  await ensureRecording(store, lesson);
  const alignment = timeline(lesson);
  const streams = await trackStreams(store, lesson);
  const file = `audio/${lesson.id}.mp3`;
  const temp = store.path("work", lesson.id, "mixed.mp3");
  await mix(
    streams.map((stream, i) => ({ stream, offset: alignment.offsets[i] ?? 0 })),
    temp,
    24000,
  );
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

/**
 * One speaker's voice alone (all of their reconnected tracks), on the same timeline as the lesson
 * recording. Rebuilt from chunks on demand, so it lives under work/.
 */
export async function speakerAudio(store: Store, lesson: Lesson, role: Track["role"]): Promise<string> {
  const file = store.path("work", lesson.id, `${role.toLowerCase()}.mp3`);
  if (existsSync(file)) return file;
  await ensureRecording(store, lesson);
  if (!lesson.tracks.some((t) => t.role === role))
    throw new Error(`${role === "Student" ? "受講者" : "講師"}の録音がありません。`);
  const alignment = timeline(lesson);
  const streams = await trackStreams(store, lesson);
  const temp = `${file}.part.mp3`;
  await mix(
    lesson.tracks.flatMap((t, i) =>
      t.role === role ? [{ stream: streams[i] ?? "", offset: alignment.offsets[i] ?? 0 }] : [],
    ),
    temp,
    16000,
  );
  renameSync(temp, file);
  return file;
}
