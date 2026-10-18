import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timeline } from "../src/audio";
import { Companion, parseFeedback } from "../src/coach";
import { DmmClient, parseHistory, parseTracks, recordingKey } from "../src/dmm";
import { bookingUuid, duration, type Feedback, type Lesson } from "../src/domain";
import { importHar, syncHistory } from "../src/importer";
import { Store } from "../src/store";
import { noSavedLogin } from "./fakes";

const directories: string[] = [];
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function store(): Store {
  const dir = mkdtempSync(join(tmpdir(), "dmm-test-"));
  directories.push(dir);
  return new Store(dir);
}
const lesson = (id = "booking-1"): Lesson => ({
  id,
  bookingId: id,
  date: "2026-09-11T15:30:00Z",
  teacher: "Tutor",
  topic: "",
  attended: true,
  tracks: [],
  phase: "idle",
  reviewed: [],
});
const history = (month = "202609", entries = true) =>
  `<select name="history_date"><option value="202608" ${month === "202608" ? "selected" : ""}>August</option><option value="202609" ${month === "202609" ? "selected" : ""}>September</option></select>${entries ? `<div id="contents"><header>2026年9月11日（金） 24:30 - 24:55<a href="/lesson/note/12/view/">レッスンノート</a></header><dt id="en">Tutor</dt><a href="https://eikaiwa.dmm.com/app/lesson-booking/AAAAAAAAAAAAAbooking01">Room</a></div>` : ""}`;
const recording =
  "https://dmm-eikaiwa-content-recordings.s3.us-west-002.backblazeb2.com/video_chunks/brand/room/track/1";
const feedback: Feedback = {
  source: "audio_transcript",
  title: "Practice",
  summary: "Summary",
  speakerIdentification: "Identified",
  strengths: ["Clear"],
  focus: ["Tense"],
  expressions: [
    {
      kind: "correction",
      at: 3,
      original: "I go yesterday",
      improved: "I went yesterday.",
      meaning: "昨日行った",
      explanation: "過去形",
      practice: "I went to the park yesterday.",
      confidence: "high",
    },
  ],
  nextLesson: ["Practice"],
  uncertainties: [],
};

describe("HAR and DMM protocol", () => {
  test("24時以降を翌日JSTに変換し、短縮UUIDと紐付ける", () => {
    const page = parseHistory(history());
    expect(page.lessons[0]?.date).toBe("2026-09-11T15:30:00.000Z");
    expect(page.lessons[0]?.bookingId).toBe("00000000-0000-0000-0001-ba289229e0d3");
    expect(bookingUuid("AAAAAAAAAAAAAbooking01")).toBe("00000000-0000-0000-0001-ba289229e0d3");
    expect(page.months).toEqual(["202608", "202609"]);
    expect(() => parseHistory("<html>Login</html>")).toThrow("ログイン");
  });
  test("参照を解決して受講者と講師の録音を区別する", () => {
    const tracks = parseTracks({
      data: [
        {
          id: "track",
          rtc_track_type: "Audio",
          recorded_participant: { _ref: "student" },
          start_time: "2026-09-11T15:30:32Z",
          mime_type: "audio/webm",
          chunks: [{ duration: "PT30.34S", url: `${recording}?signature=one` }],
        },
      ],
      references: { student: { app_data: { role: "Student" } } },
    });
    expect(tracks[0]?.role).toBe("Student");
    expect(tracks[0]?.chunks[0]?.seconds).toBe(30.34);
    expect(recordingKey(`${recording}?signature=one`)).toBe(recordingKey(`${recording}?signature=two`));
    expect(() => recordingKey("http://127.0.0.1/private")).toThrow();
    expect(() => duration("broken")).toThrow();
  });
  test("複数HARでも履歴を重複させず、分析・復習済みを維持する", async () => {
    const db = store();
    const entry = {
      request: { url: "https://eikaiwa.dmm.com/lesson/", method: "GET", headers: [] },
      response: { status: 200, content: { text: history() } },
    };
    const bytes = Buffer.from(JSON.stringify({ log: { entries: [entry] } }));
    await importHar(db, bytes, "one.har");
    const first = db.library.lessons[0];
    if (!first) throw new Error("missing lesson");
    first.feedback = feedback;
    first.reviewed = [0];
    first.phase = "done";
    await importHar(db, bytes, "duplicate.har");
    await importHar(db, Buffer.from(JSON.stringify({ log: { entries: [entry, entry] } })), "two.har");
    expect(db.library.lessons).toHaveLength(1);
    expect(first.feedback).toEqual(feedback);
    expect(first.reviewed).toEqual([0]);
    expect(db.library.imports).toHaveLength(2);
    expect(db.library.coverage.complete).toBe(false);
    expect(JSON.parse(readFileSync(db.path("manifest.json"), "utf8")).counts.lessons).toBe(1);
  });
  test("OAuth認可コードをBearerとして保存しない", async () => {
    const db = store();
    await importHar(
      db,
      Buffer.from(
        JSON.stringify({
          log: {
            entries: [
              {
                request: { url: "https://api.engoo.com/api/oauth/token", method: "POST", headers: [] },
                response: {
                  status: 200,
                  content: {
                    text: JSON.stringify({
                      access_token: "authorization-code",
                      token_type: "authorization_code",
                    }),
                  },
                },
              },
            ],
          },
        }),
      ),
      "sanitized.har",
    );
    expect(db.credentials().bearer).toBeUndefined();
    await expect(new DmmClient(db.credentials()).history("/lesson/")).rejects.toThrow("dmm setup");
  });
  test("同期は全月を読み終えてから完了とし、途中結果を保存する", async () => {
    const db = store();
    db.saveCredentials({ dmmCookie: "session=test" });
    const paths: string[] = [];
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      paths.push(url.search);
      return new Response(history(url.searchParams.get("history_date") ?? "202609", false));
    }) as unknown as typeof fetch;
    await syncHistory(db, () => {});
    expect(paths).toEqual(["", "?history_date=202609", "?history_date=202608"]);
    expect(db.library.coverage.complete).toBe(true);
    globalThis.fetch = mock(async () => new Response("Expired", { status: 401 })) as unknown as typeof fetch;
    await expect(syncHistory(db, () => {})).rejects.toThrow("認証");
    expect(db.library.coverage.complete).toBe(false);
    expect(db.library.coverage.months).toHaveLength(2);
  });
  test("保存済みパスワードがなければ認証切れをそのまま伝え、キーチェーンを消さない", async () => {
    const db = store();
    db.saveCredentials({ dmmCookie: "session=expired" });
    globalThis.fetch = mock(async () => new Response("", { status: 302 })) as unknown as typeof fetch;
    let forgotten = false;
    const companion = new Companion(db, "gemini-test", {
      ...noSavedLogin,
      available: true,
      forget: async () => {
        forgotten = true;
      },
    });
    await companion.sync();
    expect(companion.status.error).toContain("dmm setup");
    expect(forgotten).toBe(false);
  });
  test("末尾スラッシュのない追加ページを取得し、DMMの総件数と照合する", async () => {
    const db = store();
    db.saveCredentials({ dmmCookie: "session=test" });
    const second = history()
      .replaceAll("/note/12/", "/note/13/")
      .replaceAll("AAAAAAAAAAAAAbooking01", "BBBBBBBBBBBBBbooking02");
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.searchParams.get("history_date") === "202608") return new Response(history("202608", false));
      return new Response(
        (url.searchParams.has("page")
          ? second
          : `${history()}<a href="/lesson?history_date=202609&amp;page=2">2</a>`) +
          '<p class="txt-total">2件中</p>',
      );
    }) as unknown as typeof fetch;
    await syncHistory(db, () => {});
    expect(db.library.lessons).toHaveLength(2);
    expect(db.library.coverage.complete).toBe(true);
    globalThis.fetch = mock(
      async () => new Response(`${history()}<p class="txt-total">2件中</p>`),
    ) as unknown as typeof fetch;
    await expect(syncHistory(db, () => {})).rejects.toThrow("履歴が不足");
    expect(db.library.coverage.complete).toBe(false);
  });
});

describe("Audio and coaching", () => {
  test("再接続を含む別話者の録音を絶対時刻で整列する", () => {
    const l = lesson();
    l.tracks = [0, 20, 1].map((offset, i) => ({
      id: String(i),
      role: i === 2 ? "Teacher" : "Student",
      start: new Date(Date.parse(l.date) + offset * 1000).toISOString(),
      mime: "audio/webm",
      chunks: [{ url: recording, seconds: 10, key: "key" }],
    }));
    expect(timeline(l).offsets).toEqual([0, 20, 1]);
    expect(timeline(l).seconds).toBe(30);
  });
  test("音声未確認・不正な分析を拒否し、範囲外の時刻は頭出しなしにする", () => {
    expect(
      parseFeedback(JSON.stringify({ status: "SUCCESS", response: JSON.stringify(feedback) }), 10),
    ).toEqual(feedback);
    expect(() =>
      parseFeedback(
        JSON.stringify({
          status: "SUCCESS",
          response: JSON.stringify({ ...feedback, source: "unavailable" }),
        }),
        10,
      ),
    ).toThrow();
    const overshoot = parseFeedback(
      JSON.stringify({ status: "SUCCESS", response: JSON.stringify(feedback) }),
      2,
    );
    expect(overshoot.expressions[0]?.at).toBeNull();
    expect(overshoot.expressions[0]?.original).toBe("I go yesterday");
    const comprehension = parseFeedback(
      JSON.stringify({
        status: "SUCCESS",
        response: JSON.stringify({
          ...feedback,
          expressions: [{ ...feedback.expressions[0], kind: "comprehension", confidence: "high" }],
        }),
      }),
      10,
    );
    expect(comprehension.expressions[0]?.confidence).toBe("medium");
    expect(() => parseFeedback(JSON.stringify({ status: "ERROR", response: "failed" }), 10)).toThrow();
    expect(() =>
      parseFeedback(
        JSON.stringify({
          status: "SUCCESS",
          response: JSON.stringify({
            ...feedback,
            expressions: [{ ...feedback.expressions[0], kind: "pronunciation" }],
          }),
        }),
        10,
      ),
    ).toThrow("文字起こし");
  });
  test("キューは個別の失敗後も続行し、中断状態は再開可能にする", async () => {
    const db = store();
    db.merge(lesson("first"));
    db.merge(lesson("second"));
    const companion = new Companion(db, "gemini-test", noSavedLogin);
    expect(companion.enqueue(["first", "first", "second"])).toBe(2);
    await companion.idle();
    expect(db.library.lessons.map((l) => l.phase)).toEqual(["error", "error"]);
    const l = db.lesson("first");
    l.phase = "listening";
    db.save();
    const reopened = new Store(db.root);
    expect(reopened.lesson("first").phase).toBe("error");
    expect(reopened.lesson("first").error).toContain("中断");
  });
});
