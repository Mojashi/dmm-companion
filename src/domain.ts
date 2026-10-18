import { z } from "zod";

export const feedbackSchema = z.object({
  source: z.enum(["native_audio", "audio_transcript"]),
  title: z.string().min(1),
  summary: z.string().min(1),
  speakerIdentification: z.string().min(1),
  strengths: z.array(z.string()).min(1),
  focus: z.array(z.string()).min(1),
  expressions: z.array(
    z.object({
      kind: z.enum(["correction", "expression", "pronunciation", "comprehension"]),
      at: z.number().finite().nonnegative().nullable(),
      original: z.string().min(1),
      improved: z.string().min(1),
      meaning: z.string().min(1),
      explanation: z.string().min(1),
      practice: z.string().min(1),
      confidence: z.enum(["high", "medium", "low"]),
      /** Pronunciation only: the English words to practice, linked to YouGlish for native examples. */
      words: z.array(z.string().min(1)).optional(),
    }),
  ),
  nextLesson: z.array(z.string()).min(1),
  uncertainties: z.array(z.string()),
});
export type Feedback = z.infer<typeof feedbackSchema>;
export type Phase = "idle" | "queued" | "downloading" | "listening" | "done" | "error";
export type Track = {
  id: string;
  role: "Student" | "Teacher" | "Unknown";
  start: string;
  mime: string;
  chunks: { url: string; seconds: number; key: string }[];
};
export type Lesson = {
  id: string;
  bookingId?: string;
  noteId?: string;
  roomId?: string;
  date: string;
  teacher: string;
  topic: string;
  attended: boolean;
  tracks: Track[];
  phase: Phase;
  error?: string;
  audio?: { file: string; seconds: number; origin: string };
  feedback?: Feedback;
  analyzedAt?: string;
  recordingCheckedAt?: string;
  recordingUnavailable?: boolean;
  model?: string;
  reviewed: number[];
};
export type ImportRecord = {
  name: string;
  sha256: string;
  at: string;
  entries: number;
  lessons: number;
  audioChunks: number;
};
export type Library = {
  version: 1;
  lessons: Lesson[];
  imports: ImportRecord[];
  coverage: {
    months: string[];
    availableMonths: string[];
    complete: boolean;
    syncedMonths?: string[];
    syncedAt?: string;
    error?: string;
  };
};
export type Credentials = {
  dmmCookie?: string;
  apiCookie?: string;
  bearer?: string;
  viewmodel?: string;
  savedAt?: string;
  email?: string;
};
export type ApiObject = Record<string, unknown>;
export type ApiEnvelope = {
  data: unknown;
  references?: Record<string, ApiObject>;
  meta?: { pagination?: { last_page?: boolean; start?: number; page_size?: number } };
};

export function object(value: unknown): ApiObject {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("DMM API のデータ形式が変わっています。");
  return value as ApiObject;
}
export function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}
export function resolveRef(value: unknown, envelope: ApiEnvelope): ApiObject {
  const ref = object(value);
  return typeof ref._ref === "string" ? object(envelope.references?.[ref._ref]) : ref;
}
export function duration(value: unknown): number {
  const match = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(string(value));
  if (!match || !match.slice(1).some(Boolean)) throw new Error("録音の長さを解釈できません。");
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}
export function bookingUuid(short: string): string {
  if (!/^[A-Za-z0-9_-]{22}$/.test(short)) throw new Error("レッスンIDが不正です。");
  const hex = Buffer.from(short, "base64url").toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/https?:\/\/\S+/g, "[URL]")
    .slice(0, 900);
}
