import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutomaticReviews, type AutomationConfig, reviewIsDue } from "../src/automation";
import { launchAgent, serviceLabel } from "../src/background";
import { notificationAction, reviewMarkdown, shellQuote } from "../src/delivery";
import type { Feedback, Lesson } from "../src/domain";
import { reviewEmail } from "../src/email";
import { atomicJson, Store } from "../src/store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const config: AutomationConfig = {
  version: 1,
  enabled: true,
  since: "2026-09-01T00:00:00.000Z",
  intervalMinutes: 10,
  minimumAgeMinutes: 45,
  maxPerRun: 3,
  delivery: "mac",
};
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
      at: null,
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
function lesson(id: string, date = "2026-09-12T01:00:00.000Z"): Lesson {
  return {
    id,
    bookingId: id,
    date,
    teacher: "Tutor",
    topic: "",
    attended: true,
    tracks: [],
    phase: "idle",
    reviewed: [],
  };
}
function context() {
  const root = mkdtempSync(join(tmpdir(), "dmm-automatic-"));
  roots.push(root);
  const store = new Store(root);
  atomicJson(store.path("automation.json"), config);
  let now = Date.parse("2026-09-12T02:00:00Z");
  const generated: string[] = [];
  const delivered: string[] = [];
  const alerts: string[] = [];
  const worker = {
    status: { busy: false, message: "", error: "" },
    sync: async () => {},
    enqueue: (ids: string[]) => {
      for (const id of ids) {
        generated.push(id);
        store.lesson(id).feedback = feedback;
        store.lesson(id).phase = "done";
      }
      store.save();
      return ids.length;
    },
    idle: async () => {},
  };
  const delivery = {
    deliver: async (l: Lesson) => {
      delivered.push(l.id);
      return { file: `deliveries/${l.id}.md` };
    },
    alert: async (message: string) => {
      alerts.push(message);
    },
  };
  const mailed: string[] = [];
  const mail = {
    key: "email" as const,
    label: "振り返りのメール送信",
    enabledAt: (): string | undefined => undefined,
    send: async (l: Lesson) => {
      mailed.push(l.id);
    },
  };
  const posted: string[] = [];
  const slack = {
    key: "slack" as const,
    label: "振り返りのSlack投稿",
    enabledAt: (): string | undefined => undefined,
    send: async (l: Lesson) => {
      posted.push(l.id);
    },
  };
  const automatic = () => new AutomaticReviews(store, worker, delivery, [mail, slack], () => now);
  return {
    store,
    worker,
    delivery,
    generated,
    delivered,
    alerts,
    mail,
    mailed,
    slack,
    posted,
    automatic,
    advance: (minutes: number) => {
      now += minutes * 60_000;
    },
  };
}

test("対象期間・受講済み・録音公開の待ち時間を満たすレッスンだけを自動生成する", async () => {
  const c = context();
  const recent = lesson("too-recent", "2026-09-12T01:40:00Z");
  const missed = { ...lesson("missed"), attended: false };
  c.store.merge(lesson("ready"));
  c.store.merge(recent);
  c.store.merge(missed);
  c.store.merge(lesson("old", "2026-08-01T00:00:00Z"));
  await c.automatic().run();
  expect(c.generated).toEqual(["ready"]);
  expect(c.delivered).toEqual(["ready"]);
  expect(reviewIsDue(recent, config, Date.parse("2026-09-12T02:00:00Z"))).toBe(false);
  expect(existsSync(c.store.path("automation-state.json"))).toBe(true);
});

test("配信失敗だけを再試行し、再起動後も生成・配信の完了記録を維持する", async () => {
  const c = context();
  c.store.merge(lesson("ready"));
  let fail = true;
  c.delivery.deliver = async (l) => {
    c.delivered.push(l.id);
    if (fail) throw new Error("notification unavailable");
    return { file: "deliveries/ready.md" };
  };
  await c.automatic().run();
  expect(c.generated).toEqual(["ready"]);
  expect(c.delivered).toHaveLength(1);
  expect(c.alerts).toHaveLength(1);
  fail = false;
  await c.automatic().run(true);
  expect(c.delivered).toHaveLength(1);
  expect(c.alerts).toHaveLength(1);
  c.advance(11);
  const restarted = c.automatic();
  await restarted.run();
  expect(c.delivered).toHaveLength(2);
  expect(c.generated).toHaveLength(1);
  expect(restarted.state.jobs.ready?.delivery.deliveredAt).toBeDefined();
  c.advance(11);
  await c.automatic().run();
  expect(c.delivered).toHaveLength(2);
});

test("録音待ち・分析失敗を再試行し、個別の失敗後も次のレッスンを処理する", async () => {
  const c = context();
  c.store.merge(lesson("missing-recording"));
  c.store.merge(lesson("ready"));
  const enqueue = c.worker.enqueue;
  c.worker.enqueue = (ids) => {
    if (ids[0] === "missing-recording") {
      c.generated.push("missing-recording");
      c.store.lesson("missing-recording").error = "録音はまだ公開されていません";
      return 1;
    }
    return enqueue(ids);
  };
  await c.automatic().run();
  expect(c.generated).toEqual(["missing-recording", "ready"]);
  expect(c.delivered).toEqual(["ready"]);
  c.worker.enqueue = enqueue;
  c.advance(11);
  await c.automatic().run();
  expect(c.delivered).toEqual(["ready", "missing-recording"]);
});

test("手動処理中・無効化中は開始せず、同時呼び出しを重複実行しない", async () => {
  const c = context();
  c.store.merge(lesson("ready"));
  const auto = c.automatic();
  c.worker.status.busy = true;
  await auto.run();
  expect(c.generated).toHaveLength(0);
  c.worker.status.busy = false;
  atomicJson(c.store.path("automation.json"), { ...config, enabled: false });
  await auto.run();
  expect(c.generated).toHaveLength(0);
  atomicJson(c.store.path("automation.json"), config);
  await Promise.all([auto.run(), auto.run()]);
  expect(c.generated).toEqual(["ready"]);
  expect(c.delivered).toEqual(["ready"]);
});

test("同期が認証切れでも生成済みの復習を配信し、再ログインを通知する", async () => {
  const c = context();
  c.store.merge({ ...lesson("done"), feedback, phase: "done" });
  c.worker.sync = async () => {
    c.worker.status.error = "dmm setupでログインし直してください。";
  };
  await c.automatic().run();
  expect(c.delivered).toEqual(["done"]);
  expect(c.alerts).toEqual(["dmm setupでログインし直してください。"]);
  expect(c.generated).toHaveLength(0);
});

test("メール配信は通知と別に記録し、片方の失敗でもう片方を再送しない", async () => {
  const c = context();
  c.mail.enabledAt = () => "2026-09-12T00:00:00.000Z";
  c.store.merge(lesson("ready"));
  let fail = true;
  c.mail.send = async (l) => {
    c.mailed.push(l.id);
    if (fail) throw new Error("SMTP unavailable");
  };
  await c.automatic().run();
  expect(c.delivered).toEqual(["ready"]);
  expect(c.mailed).toEqual(["ready"]);
  expect(c.alerts).toEqual(["振り返りのメール送信: SMTP unavailable"]);
  fail = false;
  c.advance(11);
  const restarted = c.automatic();
  await restarted.run();
  expect(c.delivered).toEqual(["ready"]);
  expect(c.mailed).toEqual(["ready", "ready"]);
  expect(restarted.state.jobs.ready?.email?.deliveredAt).toBeDefined();
});

test("メール配信を有効にする前に通知済みの振り返りはメールで送らない", async () => {
  const c = context();
  c.store.merge(lesson("before"));
  await c.automatic().run();
  expect(c.delivered).toEqual(["before"]);
  c.mail.enabledAt = () => new Date(Date.parse("2026-09-12T02:00:00Z") + 60_000).toISOString();
  c.store.merge(lesson("after", "2026-09-12T01:10:00.000Z"));
  c.advance(11);
  const auto = c.automatic();
  await auto.run();
  expect(c.delivered).toEqual(["before", "after"]);
  expect(c.mailed).toEqual(["after"]);
  expect(auto.state.jobs.before?.email).toBeUndefined();
});

test("Slack投稿はメールと別に記録し、Slackの失敗でメールを再送しない", async () => {
  const c = context();
  c.mail.enabledAt = () => "2026-09-12T00:00:00.000Z";
  c.slack.enabledAt = () => "2026-09-12T00:00:00.000Z";
  c.store.merge(lesson("ready"));
  let fail = true;
  c.slack.send = async (l) => {
    c.posted.push(l.id);
    if (fail) throw new Error("no_service");
  };
  await c.automatic().run();
  expect(c.mailed).toEqual(["ready"]);
  expect(c.posted).toEqual(["ready"]);
  expect(c.alerts).toEqual(["振り返りのSlack投稿: no_service"]);
  fail = false;
  c.advance(11);
  const restarted = c.automatic();
  await restarted.run();
  expect(c.delivered).toEqual(["ready"]);
  expect(c.mailed).toEqual(["ready"]);
  expect(c.posted).toEqual(["ready", "ready"]);
  expect(restarted.state.jobs.ready?.slack?.deliveredAt).toBeDefined();
  expect(restarted.state.error).toBeUndefined();
});

test("通知のクリックで指定レッスンを開き、パス中のシェル構文を実行させない", async () => {
  const dangerous = "/Users/space name/a'$(echo NOT_EXECUTABLE)`bad`";
  const child = Bun.spawn(["/bin/sh", "-c", `printf %s ${shellQuote(dangerous)}`], { stdout: "pipe" });
  expect(await new Response(child.stdout).text()).toBe(dangerous);
  expect(await child.exited).toBe(0);
  const action = notificationAction("/path/dmm", dangerous, "lesson-1");
  expect(action).toContain("'--lesson' 'lesson-1'");
  expect(action).toContain(shellQuote(dangerous));
  expect(reviewMarkdown({ ...lesson("done"), feedback })).toContain("昨日行った");
});

test("メールの件名にレッスン日・講師・題名を載せ、本文のHTMLは講師やAIの文をエスケープする", () => {
  const message = reviewEmail({
    ...lesson("done"),
    feedback: { ...feedback, summary: "<script>x</script> & more" },
  });
  expect(message.subject).toBe("DMM英会話の振り返り 2026/9/12 Tutor先生: Practice");
  expect(message.html).toContain("昨日行った");
  expect(message.html).toContain("I went yesterday.");
  expect(message.html).toContain("&lt;script&gt;x&lt;/script&gt; &amp; more");
  expect(message.html).not.toContain("<script>");
});

test("launchd設定は絶対パスとPATHを保存し、XML特殊文字を正しく扱う", () => {
  const options = {
    root: "/Users/a & b/data",
    binary: "/Users/a & b/dmm",
    path: "/opt/homebrew/bin:/bin",
    model: "gemini-test",
    transcriptionModel: "gemini-flash-test",
    port: 4317,
  };
  const plist = launchAgent(options);
  expect(plist).toContain("<string>--transcribe-model</string><string>gemini-flash-test</string>");
  expect(plist).toContain("/Users/a &amp; b/dmm");
  expect(plist).toContain("<key>KeepAlive</key><true/>");
  expect(plist).toContain("<string>background</string>");
  expect(plist).toContain("/opt/homebrew/bin:/bin");
  expect(serviceLabel(options.root)).not.toBe(serviceLabel("/another/root"));
});
