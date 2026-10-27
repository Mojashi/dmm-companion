import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Assessment } from "../src/assessment";
import { criteria } from "../src/assessment";
import type { CefrLevel } from "../src/cefr";
import type { Feedback, Lesson } from "../src/domain";
import { enableSlackDelivery, levelBar, readSlackSettings, reviewSlackMessage } from "../src/slack";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const feedback: Feedback = {
  source: "audio_transcript",
  title: "Practice",
  summary: "<!channel> & <https://example.com|link>",
  speakerIdentification: "Identified",
  strengths: [],
  focus: ["Tense"],
  expressions: [],
  nextLesson: ["Use the past tense"],
  uncertainties: [],
};

const lesson = (id: string, date: string, assessment?: Assessment): Lesson => ({
  id,
  bookingId: id,
  date,
  teacher: "Anna",
  topic: "",
  attended: true,
  tracks: [],
  phase: "done",
  reviewed: [],
  feedback,
  assessment: assessment && { ...assessment, model: "gemini-test", assessedAt: date },
});
const judged = (levels: CefrLevel[], nextSteps: Partial<Record<string, string>> = {}): Assessment => ({
  source: "native_audio",
  criteria: criteria.map((criterion, i) => ({
    criterion,
    evidence: "e",
    level: levels[i] ?? "B1",
    nextStep: nextSteps[criterion] ?? `next ${criterion}`,
  })),
  overall: { rationale: "r", level: "B1+" },
  caveats: [],
});

test("Slack投稿はAIや講師の文の制御文字をエスケープし、メンションやリンクにしない", () => {
  const message = reviewSlackMessage({
    id: "a",
    bookingId: "a",
    date: "2026-09-11T15:30:00.000Z",
    teacher: "Anna",
    topic: "",
    attended: true,
    tracks: [],
    phase: "done",
    reviewed: [],
    feedback,
  });
  const json = JSON.stringify(message);
  expect(json).toContain("&lt;!channel&gt; &amp; &lt;https://example.com|link&gt;");
  expect(json).not.toContain("<!channel>");
  expect(message.text).toContain("*DMM英会話の振り返り: Practice*");
  expect(json).not.toContain("CEFR");
  // The long summary and lists sit in one attachment section, which Slack folds behind "Show more".
  expect(JSON.stringify(message.blocks)).not.toContain("今日の重点");
  expect(message.attachments?.[0]?.blocks).toHaveLength(1);
  expect(JSON.stringify(message.attachments)).toContain("今日の重点");
});

test("CEFRは6マスのバーで観点ごとに並べ、直近の平均より半段以上の変化に矢印を付け、最も低い観点の次の一歩を載せる", () => {
  expect(levelBar("A1")).toBe("🟩⬜⬜⬜⬜⬜");
  expect(levelBar("B1+")).toBe("🟩🟩🟩🟨⬜⬜");
  expect(levelBar("C2")).toBe("🟩🟩🟩🟩🟩🟩");
  const history = [
    lesson("old1", "2026-09-01T00:00:00.000Z", judged(["B1", "B1", "B1", "B1", "B1", "B1"])),
    lesson("old2", "2026-09-05T00:00:00.000Z", judged(["B1", "B1", "B1", "B1", "B1", "B1"])),
  ];
  const today = lesson(
    "today",
    "2026-09-11T15:30:00.000Z",
    judged(["B2", "B1", "A2+", "B1+", "B1", "B1"], { fluency: "Use <fillers> & pauses" }),
  );
  const json = JSON.stringify(reviewSlackMessage(today, [...history, today]));
  expect(json).toContain("🎯 CEFRの目安  B1+");
  expect(json).toContain("🟩🟩🟩🟩⬜⬜  表現の幅 *B2* ⬆️");
  expect(json).toContain("🟩🟩🟨⬜⬜⬜  流暢さ *A2+* ⬇️");
  expect(json).toContain("🟩🟩🟩⬜⬜⬜  正確さ *B1*\\n");
  expect(json).toContain("次の一歩: 流暢さ*\\nUse &lt;fillers&gt; &amp; pauses");
  expect(json).toContain("直近2回の平均との比較");
});

test("SlackのWebhook以外のURLは保存せず、テスト投稿に失敗した設定も保存しない", async () => {
  const root = mkdtempSync(join(tmpdir(), "dmm-slack-"));
  roots.push(root);
  await expect(enableSlackDelivery(root, "https://example.com/hook")).rejects.toThrow("hooks.slack.com");
  await expect(enableSlackDelivery(root, "http://hooks.slack.com/services/x")).rejects.toThrow(
    "hooks.slack.com",
  );
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("no_service", { status: 404 })) as unknown as typeof fetch;
  try {
    await expect(enableSlackDelivery(root, "https://hooks.slack.com/services/T/B/x")).rejects.toThrow(
      "no_service",
    );
    expect(existsSync(join(root, "slack.json"))).toBe(false);
    globalThis.fetch = (async () => new Response("ok")) as unknown as typeof fetch;
    await enableSlackDelivery(root, "https://hooks.slack.com/services/T/B/x");
  } finally {
    globalThis.fetch = original;
  }
  expect(existsSync(join(root, "slack.json"))).toBe(true);
  expect(readSlackSettings(root)?.webhookUrl).toBe("https://hooks.slack.com/services/T/B/x");
});
