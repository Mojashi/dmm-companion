import { basename } from "node:path";
import { z } from "zod";
import { DmmClient, parseBooking, parseHistory, parseTracks, recordingKey } from "./dmm";
import { type ApiEnvelope, type Credentials, safeError } from "./domain";
import { atomicJson, hash, type Store } from "./store";

const headerSchema = z.object({ name: z.string(), value: z.string() });
const harSchema = z.object({
  log: z.object({
    entries: z.array(
      z.object({
        request: z.object({
          url: z.string(),
          method: z.string(),
          headers: z.array(headerSchema),
          cookies: z.array(headerSchema).optional(),
        }),
        response: z.object({
          status: z.number(),
          content: z.object({
            mimeType: z.string().optional(),
            text: z.string().optional(),
            encoding: z.string().optional(),
          }),
        }),
      }),
    ),
  }),
});

export async function importHar(store: Store, bytes: Uint8Array, name: string): Promise<void> {
  const sha256 = hash(bytes);
  if (store.library.imports.some((i) => i.sha256 === sha256)) return;
  const har = harSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  const auth: Credentials = {};
  const bookings: ApiEnvelope[] = [];
  const recordings: { room: string; data: ApiEnvelope }[] = [];
  let audioChunks = 0;
  const importedIds = new Set<string>();
  const remember = (id: string) => importedIds.add(id);
  for (const entry of har.log.entries) {
    const url = new URL(entry.request.url);
    const headers = Object.fromEntries(entry.request.headers.map((h) => [h.name.toLowerCase(), h.value]));
    const cookie = headers.cookie ?? entry.request.cookies?.map((c) => `${c.name}=${c.value}`).join("; ");
    if (url.hostname === "eikaiwa.dmm.com" && cookie) auth.dmmCookie = cookie;
    if (url.hostname === "api.engoo.com") {
      if (cookie) auth.apiCookie = cookie;
      if (headers.authorization && /^Bearer\s+\S+$/i.test(headers.authorization))
        auth.bearer = headers.authorization;
      if (headers["x-viewmodel-versions"]) auth.viewmodel = headers["x-viewmodel-versions"];
    }
    const content = entry.response.content;
    if (entry.response.status !== 200 || !content.text) continue;
    const body =
      content.encoding === "base64" ? Buffer.from(content.text, "base64") : Buffer.from(content.text);
    if (url.hostname === "eikaiwa.dmm.com" && /^\/lesson\/?$/.test(url.pathname)) {
      const page = parseHistory(body.toString());
      for (const lesson of page.lessons) remember(store.merge(lesson).id);
      store.library.coverage.months = [
        ...new Set([...store.library.coverage.months, page.selected].filter(Boolean)),
      ].sort();
      store.library.coverage.availableMonths = [
        ...new Set([...store.library.coverage.availableMonths, ...page.months]),
      ].sort();
      await Bun.write(store.path("sources", `history-${page.selected}-${sha256.slice(0, 12)}.html`), body);
    }
    if (url.hostname === "api.engoo.com" && /\/lesson_bookings\/[\w-]+\/combined$/.test(url.pathname))
      bookings.push(JSON.parse(body.toString()) as ApiEnvelope);
    const room = /^\/api\/rtc\/rooms\/([\w-]+)\/videos$/.exec(url.pathname)?.[1];
    if (url.hostname === "api.engoo.com" && room)
      recordings.push({ room, data: JSON.parse(body.toString()) as ApiEnvelope });
    if (
      url.hostname === "dmm-eikaiwa-content-recordings.s3.us-west-002.backblazeb2.com" &&
      url.pathname.startsWith("/video_chunks/") &&
      content.encoding === "base64"
    ) {
      await Bun.write(store.path("chunks", recordingKey(url.href)), body);
      audioChunks++;
    }
  }
  for (const data of bookings) {
    const lesson = store.merge(parseBooking(data));
    atomicJson(store.path("sources", `booking-${lesson.bookingId}.json`), data);
    remember(lesson.id);
  }
  for (const { room, data } of recordings) {
    const lesson = store.library.lessons.find((l) => l.roomId === room);
    if (!lesson)
      throw new Error(
        "録音とレッスンを対応付けられません。レッスン画面の読み込みから含めてHARを保存してください。",
      );
    lesson.tracks = parseTracks(data);
    atomicJson(store.path("sources", `recordings-${room}.json`), data);
  }
  store.saveCredentials(auth);
  store.library.imports.push({
    name: basename(name),
    sha256,
    at: new Date().toISOString(),
    entries: har.log.entries.length,
    lessons: importedIds.size,
    audioChunks,
  });
  store.save();
}

export async function syncHistory(
  store: Store,
  report: (message: string) => void,
  full = false,
): Promise<void> {
  const client = new DmmClient(store.credentials());
  const coverage = store.library.coverage;
  const syncedMonths = new Set(coverage.syncedMonths ?? (coverage.complete ? coverage.months : []));
  coverage.syncedMonths = [...syncedMonths];
  coverage.complete = false;
  delete coverage.error;
  store.save();
  try {
    const first = parseHistory(await client.history("/lesson/"));
    coverage.availableMonths = [...new Set([...coverage.availableMonths, ...first.months])].sort();
    const visited = new Set<string>();
    const newest = [...coverage.availableMonths].reverse();
    for (const month of newest.filter((month, index) => full || !syncedMonths.has(month) || index < 2)) {
      const pending = [`/lesson/?history_date=${month}`];
      const monthLessons = new Set<string>();
      let expectedTotal: number | undefined;
      while (pending.length) {
        const path = pending.shift();
        if (!path || visited.has(path)) continue;
        visited.add(path);
        if (visited.size > 5000)
          throw new Error("履歴のページ数が上限を超えました。同期条件を確認してください。");
        report(`${month.slice(0, 4)}年${month.slice(4)}月の履歴を取得中`);
        const html = await client.history(path);
        const page = parseHistory(html);
        if (page.selected !== month) throw new Error("指定した月と取得できた履歴の月が一致しません。");
        await Bun.write(store.path("sources", `history-${month}-${hash(path).slice(0, 8)}.html`), html);
        for (const lesson of page.lessons) {
          store.merge(lesson);
          monthLessons.add(lesson.noteId ?? lesson.id);
        }
        if (page.total !== undefined) expectedTotal = page.total;
        pending.push(...page.next.filter((p) => !visited.has(p)));
        store.save();
      }
      if (expectedTotal !== undefined && monthLessons.size !== expectedTotal)
        throw new Error(
          `${month}の履歴が不足しています (${monthLessons.size}/${expectedTotal}件)。同期を再実行してください。`,
        );
      coverage.months = [...new Set([...coverage.months, month])].sort();
      syncedMonths.add(month);
      coverage.syncedMonths = [...syncedMonths].sort();
      store.save();
    }
    coverage.complete = true;
    coverage.syncedAt = new Date().toISOString();
    store.save();
  } catch (error) {
    coverage.error = safeError(error);
    store.save();
    throw error;
  }
}

export async function discoverRecording(store: Store, id: string): Promise<void> {
  const lesson = store.lesson(id);
  if (!lesson.bookingId) throw new Error("この履歴には録音を取得するためのレッスンIDがありません。");
  const client = new DmmClient(store.credentials());
  const booking = await client.api(`/api/lesson_bookings/${lesson.bookingId}/combined`);
  store.merge(parseBooking(booking));
  atomicJson(store.path("sources", `booking-${lesson.bookingId}.json`), booking);
  if (!lesson.roomId) throw new Error("このレッスンには録音ルームがありません。");
  const tracks = [];
  let start = 0;
  while (true) {
    const data = await client.api(
      `/api/rtc/rooms/${lesson.roomId}/videos?purposes%5B%5D=Review&start=${start}`,
    );
    atomicJson(store.path("sources", `recordings-${lesson.roomId}-${start}.json`), data);
    tracks.push(...parseTracks(data));
    const pagination = data.meta?.pagination;
    if (pagination?.last_page === true) break;
    if (!pagination?.page_size || tracks.length > 10000) throw new Error("録音一覧の終端を確認できません。");
    start += pagination.page_size;
  }
  lesson.tracks = tracks;
  lesson.recordingCheckedAt = new Date().toISOString();
  lesson.recordingUnavailable = !tracks.length;
  store.save();
  if (!tracks.length) throw new Error("録音がありません。保存期限を過ぎたか、録音対象外のレッスンです。");
}
