import { speakerAudio } from "./audio";
import type { Lesson, SpeakingMetrics } from "./domain";
import { askGemini } from "./gemini";
import { command } from "./process";
import type { Store } from "./store";
import { ensureSpeech } from "./transcription";

/**
 * 1レッスンの話す力を測る。
 * 講師と受講者の録音はトラックが分かれているので、それぞれの声だけから「いつ話していたか」を取り、
 * 受講者の声は逐語で書き起こして、発話量・流暢さ・語彙の指標を計算する。
 */
export async function measureSpeaking(
  store: Store,
  lesson: Lesson,
  model: string,
  ask = askGemini,
): Promise<void> {
  const learner = await speakerAudio(store, lesson, "Student");
  const teacher = await speakerAudio(store, lesson, "Teacher");
  const learnerSpeech = await speechRuns(learner);
  const teacherSpeech = await speechRuns(teacher);
  const { transcript } = await ensureSpeech(store, lesson, "Student", model, ask);
  lesson.metrics = {
    ...speakingMetrics(learnerSpeech, teacherSpeech, spokenWords(transcript)),
    measuredAt: new Date().toISOString(),
    model,
  };
  delete lesson.metricsError;
  store.save();
}

export type Run = { start: number; end: number };

/** A pause is at least this long; the usual threshold in fluency research. */
const pauseSeconds = 0.25;

/** Stretches of voice between pauses. WebRTC noise suppression leaves near-digital silence between them. */
async function speechRuns(file: string): Promise<Run[]> {
  const [detected, probed] = await Promise.all([
    command([
      "ffmpeg",
      "-hide_banner",
      "-nostats",
      "-loglevel",
      "error",
      "-i",
      file,
      "-af",
      `silencedetect=noise=-35dB:d=${pauseSeconds},ametadata=mode=print:file=-`,
      "-f",
      "null",
      "-",
    ]),
    command(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]),
  ]);
  return runsBetweenSilences(detected, Number(probed));
}

export function runsBetweenSilences(metadata: string, duration: number): Run[] {
  if (!Number.isFinite(duration)) throw new Error("録音の長さを取得できません。");
  const runs: Run[] = [];
  let voiceFrom = 0;
  for (const [, edge, at] of metadata.matchAll(/lavfi\.silence_(start|end)=([\d.]+)/g)) {
    const time = Number(at);
    if (edge === "start" && time > voiceFrom) runs.push({ start: voiceFrom, end: time });
    if (edge === "end") voiceFrom = time;
  }
  if (duration - voiceFrom >= pauseSeconds) runs.push({ start: voiceFrom, end: duration });
  return runs;
}

/** Hesitations (S&I's %hesitation%): counted, but not as words. */
const hesitations = new Set(["uh", "um", "uhm", "er", "erm"]);
/** Non-lexical back-channels and murmurs (mhm, mmm, uh-huh, …): neither words nor hesitations. */
const backchannels = new Set(["mhm", "mm", "mmm", "hm", "hmm", "aha", "ah", "huh"]);

export function spokenWords(transcript: string): { words: string[]; fillers: number } {
  const tokens = (
    transcript
      .replace(/\[[^\]]*\]/g, " ")
      .toLowerCase()
      .replace(/\b(?:uh-huh|mm-hmm)\b/g, " mhm ")
      .match(/[a-z]+(?:['’][a-z]+)*/g) ?? []
  ).map((t) => t.replace("’", "'"));
  return {
    words: tokens.filter((t) => !hesitations.has(t) && !backchannels.has(t)),
    fillers: tokens.filter((t) => hesitations.has(t)).length,
  };
}

/**
 * Moving-average type-token ratio: the share of distinct words in every 50-word window, averaged.
 * Unlike a plain type-token ratio it does not fall just because the learner talked longer.
 */
export function mattr(words: string[], window = 50): number | null {
  if (words.length < window) return null;
  const counts = new Map<string, number>();
  for (const word of words.slice(0, window)) counts.set(word, (counts.get(word) ?? 0) + 1);
  let sum = counts.size;
  for (let i = window; i < words.length; i++) {
    const leaving = words[i - window] ?? "";
    const left = (counts.get(leaving) ?? 0) - 1;
    if (left) counts.set(leaving, left);
    else counts.delete(leaving);
    const entering = words[i] ?? "";
    counts.set(entering, (counts.get(entering) ?? 0) + 1);
    sum += counts.size;
  }
  return sum / (words.length - window + 1) / window;
}

/**
 * Who holds the floor, as alternating turns. A run that starts while the other speaker's turn is still
 * going (a "yeah" or "uh-huh" over them) is a back-channel, not a new turn.
 */
export function turns(learner: Run[], teacher: Run[]): (Run & { speaker: "learner" | "teacher" })[] {
  const runs = [
    ...learner.map((r) => ({ ...r, speaker: "learner" as const })),
    ...teacher.map((r) => ({ ...r, speaker: "teacher" as const })),
  ].sort((a, b) => a.start - b.start);
  const result: (Run & { speaker: "learner" | "teacher" })[] = [];
  for (const run of runs) {
    const current = result.at(-1);
    if (!current || (run.speaker !== current.speaker && run.start >= current.end)) result.push({ ...run });
    else if (run.speaker === current.speaker) current.end = Math.max(current.end, run.end);
  }
  return result;
}

const seconds = (runs: Run[]) => runs.reduce((sum, r) => sum + (r.end - r.start), 0);

export function speakingMetrics(
  learner: Run[],
  teacher: Run[],
  spoken: { words: string[]; fillers: number },
): Omit<SpeakingMetrics, "measuredAt" | "model"> {
  const learnerSeconds = seconds(learner);
  const teacherSeconds = seconds(teacher);
  if (!learnerSeconds) throw new Error("受講者の発話を検出できませんでした。");
  const learnerTurns = turns(learner, teacher).filter((t) => t.speaker === "learner");
  const minutes = learnerSeconds / 60;
  return {
    version: 1,
    learnerSeconds,
    teacherSeconds,
    talkShare: learnerSeconds / (learnerSeconds + teacherSeconds),
    turns: learnerTurns.length,
    meanTurnSeconds: seconds(learnerTurns) / learnerTurns.length,
    words: spoken.words.length,
    wordsPerMinute: spoken.words.length / minutes,
    meanLengthOfRun: spoken.words.length / learner.length,
    fillersPerMinute: spoken.fillers / minutes,
    mattr: mattr(spoken.words),
  };
}
