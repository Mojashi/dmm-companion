import * as cheerio from "cheerio";
import {
  type ApiEnvelope,
  type ApiObject,
  bookingUuid,
  type Credentials,
  duration,
  type Lesson,
  object,
  resolveRef,
  string,
  type Track,
} from "./domain";
import { hash } from "./store";

export function parseHistory(html: string): {
  lessons: Lesson[];
  months: string[];
  selected: string;
  next: string[];
  total?: number;
} {
  const $ = cheerio.load(html);
  if (!$("select[name=history_date]").length)
    throw new Error("履歴ページを取得できません。dmm setupでログインしてください。");
  const months = $("select[name=history_date] option")
    .toArray()
    .map((el) => $(el).attr("value") ?? "")
    .filter((v) => /^\d{6}$/.test(v));
  const selected = $("select[name=history_date] option[selected]").attr("value") ?? "";
  const lessons: Lesson[] = [];
  for (const node of $("[id=contents]").toArray()) {
    const row = $(node);
    const noteId = /\/lesson\/note\/(\d+)\/view/.exec(
      row.find("a[href*='/lesson/note/']").attr("href") ?? "",
    )?.[1];
    if (!noteId) continue;
    const short = /\/app\/lesson-booking\/([\w-]+)/.exec(
      row.find("a[href*='/app/lesson-booking/']").attr("href") ?? "",
    )?.[1];
    const dateMatch = /(\d{4})年\s*(\d+)月\s*(\d+)日[^\d]*(\d+):(\d+)/.exec(row.find("header").text());
    if (!dateMatch) throw new Error("履歴の日付を解釈できません。");
    const [, year, month, day, hour, minute] = dateMatch;
    const date = new Date(
      Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 9, Number(minute)),
    ).toISOString();
    const bookingId = short ? bookingUuid(short) : undefined;
    lessons.push({
      id: bookingId ?? `note-${noteId}`,
      bookingId,
      noteId,
      date,
      teacher: row.find("[id=en]").text().trim(),
      topic: row
        .find("[id=lessonStyleBox] .inner")
        .toArray()
        .map((el) => $(el).text().trim())
        .join(" / "),
      attended: !row.text().includes("このレッスンは受講されていません"),
      tracks: [],
      phase: "idle",
      reviewed: [],
    });
  }
  const expected = /(\d+)件中/.exec($(".txt-total").text())?.[1];
  if (expected && Number(expected) > 0 && !lessons.length)
    throw new Error("履歴のHTML構造が変わっています。");
  const next = $("a[href]")
    .toArray()
    .map((el) => $(el).attr("href") ?? "")
    .filter((href) => /^\/lesson\/?\?/.test(href) && /(?:page|offset)=/.test(href));
  return {
    lessons,
    months,
    selected,
    next: [...new Set(next)],
    total: expected ? Number(expected) : undefined,
  };
}

export function parseBooking(envelope: ApiEnvelope): Lesson {
  const data = object(envelope.data);
  const booking =
    data._type === "CombinedLessonBooking" ? resolveRef((data.bookings as unknown[])[0], envelope) : data;
  const teacher = resolveRef(data.teacher, envelope);
  const time = object(data.time);
  const room = booking.rtc_room ? resolveRef(booking.rtc_room, envelope) : undefined;
  return {
    id: identifier(data.id),
    bookingId: identifier(data.id),
    roomId: room ? identifier(room.id) : undefined,
    date: string(time.min),
    teacher: string(teacher.name),
    topic: "",
    attended: !booking.cancellation && booking.student_attendance !== "absent",
    tracks: [],
    phase: "idle",
    reviewed: [],
  };
}

export function parseTracks(envelope: ApiEnvelope): Track[] {
  if (!Array.isArray(envelope.data)) throw new Error("録音一覧の形式が変わっています。");
  return envelope.data
    .map(object)
    .filter((v) => v.rtc_track_type === "Audio")
    .map((v) => {
      const participant = resolveRef(v.recorded_participant, envelope);
      const role = object(participant.app_data).role;
      if (!Array.isArray(v.chunks)) throw new Error("録音に音声データ一覧がありません。");
      return {
        id: identifier(v.id),
        role: role === "Student" || role === "Teacher" ? role : "Unknown",
        start: string(v.start_time),
        mime: string(v.mime_type),
        chunks: v.chunks.map(object).map((c) => ({
          url: string(c.url),
          seconds: duration(c.duration),
          key: recordingKey(string(c.url)),
        })),
      };
    });
}
export function parseDisplayName(envelope: ApiEnvelope): string | undefined {
  const name = (envelope.data as ApiObject | undefined)?.display_name;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

function identifier(value: unknown): string {
  const id = string(value);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("DMM APIに不正なIDが含まれています。");
  return id;
}
export function recordingKey(url: string): string {
  const parsed = recordingUrl(url);
  return hash(`${parsed.origin}${parsed.pathname}`);
}
export function recordingUrl(url: string): URL {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "dmm-eikaiwa-content-recordings.s3.us-west-002.backblazeb2.com" ||
    !parsed.pathname.startsWith("/video_chunks/")
  )
    throw new Error("未対応の録音配信元です。");
  return parsed;
}

/** DMM rejected the saved session; signing in again may fix it. */
export class SessionExpired extends Error {
  constructor() {
    super("DMMの認証が無効または期限切れです。dmm setupでログインし直してください。");
  }
}

export class DmmClient {
  constructor(private readonly auth: Credentials) {}
  async history(path: string): Promise<string> {
    if (!this.auth.dmmCookie) throw new Error("ログイン情報がありません。dmm setupを実行してください。");
    const url = new URL(path, "https://eikaiwa.dmm.com");
    if (url.origin !== "https://eikaiwa.dmm.com" || !/^\/lesson\/?$/.test(url.pathname))
      throw new Error("履歴以外のURLは取得できません。");
    return (await this.get(url, { Cookie: this.auth.dmmCookie })).text();
  }
  async api(path: string): Promise<ApiEnvelope> {
    if (!this.auth.bearer && !this.auth.apiCookie)
      throw new Error("録音の接続情報がありません。dmm setupを実行してください。");
    if (!/^\/api\/(lesson_bookings\/[\w-]+\/combined|rtc\/rooms\/[\w-]+\/videos)(?:\?|$)/.test(path))
      throw new Error("未対応のAPIです。");
    return (
      await this.get(new URL(path, "https://api.engoo.com"), this.apiHeaders())
    ).json() as Promise<ApiEnvelope>;
  }
  async currentUser(): Promise<ApiEnvelope> {
    return (
      await this.get(new URL("https://api.engoo.com/api/users/current"), this.apiHeaders())
    ).json() as Promise<ApiEnvelope>;
  }
  /** The learner's display name from their profile, or undefined when it is not set. */
  async displayName(): Promise<string | undefined> {
    return parseDisplayName(await this.currentUser());
  }
  private apiHeaders(): Record<string, string> {
    const headers: Record<string, string> = { Origin: "https://eikaiwa.dmm.com", Accept: "application/json" };
    if (this.auth.bearer) headers.Authorization = this.auth.bearer;
    if (this.auth.apiCookie) headers.Cookie = this.auth.apiCookie;
    if (this.auth.viewmodel) headers["x-viewmodel-versions"] = this.auth.viewmodel;
    return headers;
  }
  private async get(url: URL, headers: Record<string, string>): Promise<Response> {
    const response = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(60_000) });
    if ([401, 403, 301, 302, 303, 307, 308].includes(response.status)) throw new SessionExpired();
    if (!response.ok) throw new Error(`DMMへの読み取りが失敗しました (HTTP ${response.status})。`);
    return response;
  }
}
