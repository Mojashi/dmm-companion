import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ReviewChannel } from "./automation";
import { aspectLabel, aspectMean, type CefrLevel, cefrScore } from "./cefr";
import type { Lesson } from "./domain";
import { slackShareText } from "./share";
import { atomicJson, type Store } from "./store";
import { mapFeedbackProse, plainTimes } from "./timestamps";

export const slackSettingsSchema = z.object({
  version: z.literal(1),
  webhookUrl: z.url({ protocol: /^https$/, hostname: /^hooks\.slack\.com$/ }),
  enabledAt: z.iso.datetime(),
});
export type SlackSettings = z.infer<typeof slackSettingsSchema>;

const settingsPath = (root: string) => join(root, "slack.json");

export function readSlackSettings(root: string): SlackSettings | undefined {
  const path = settingsPath(root);
  return existsSync(path) ? slackSettingsSchema.parse(JSON.parse(readFileSync(path, "utf8"))) : undefined;
}

/** Slack reads `&`, `<` and `>` as control characters, so text from the teacher or Gemini is escaped. */
export function slackEscape(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

type Block = Record<string, unknown>;
export type SlackMessage = {
  text: string;
  blocks?: Block[];
  attachments?: { color: string; blocks: Block[] }[];
};

const mrkdwn = (text: string): Block => ({ type: "section", text: { type: "mrkdwn", text } });
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const plain = (text: string, max: number) => ({ type: "plain_text", text: clip(text, max), emoji: true });

/** A1 to C2 as six cells: one 🟩 per level reached and a 🟨 for a "+". */
export function levelBar(level: CefrLevel): string {
  const score = cefrScore[level];
  const full = Math.floor(score);
  const half = score > full ? 1 : 0;
  return "🟩".repeat(full) + "🟨".repeat(half) + "⬜".repeat(6 - full - half);
}

/** ⬆️ / ⬇️ when a level is at least half a step off the mean of the previous lessons; nothing otherwise. */
function trend(score: number, previous: number[]): string {
  if (!previous.length) return "";
  const diff = score - previous.reduce((s, x) => s + x, 0) / previous.length;
  return diff >= 0.5 ? " ⬆️" : diff <= -0.5 ? " ⬇️" : "";
}

/** How many earlier judgements a lesson's levels are compared with, matching the growth chart's reading. */
const recentCount = 4;

/** The CEFR estimate as level bars per aspect, compared with recent lessons, and the weakest aspect's next step. */
function cefrBlocks(lesson: Lesson, history: Lesson[]): Block[] {
  const assessment = lesson.assessment;
  if (!assessment) return [];
  const recent = history
    .filter((l) => l.assessment && l.id !== lesson.id && l.date < lesson.date)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, recentCount);
  const levels = assessment.criteria.map((c) => c.level);
  const mean = aspectMean(levels) ?? 0;
  const recentMeans = recent.flatMap(
    (l) => aspectMean(l.assessment?.criteria.map((c) => c.level) ?? []) ?? [],
  );
  const rows = assessment.criteria.map((c) => {
    const before = recent.flatMap(
      (l) =>
        l.assessment?.criteria.filter((p) => p.criterion === c.criterion).map((p) => cefrScore[p.level]) ??
        [],
    );
    return `${levelBar(c.level)}  ${aspectLabel[c.criterion]} *${c.level}*${trend(cefrScore[c.level], before)}`;
  });
  const weakest = assessment.criteria.reduce((a, b) => (cefrScore[b.level] < cefrScore[a.level] ? b : a));
  return [
    mrkdwn(
      `*🎯 CEFRの目安  ${assessment.overall.level}*　6観点の平均 ${mean.toFixed(1)}${trend(mean, recentMeans)}\n${rows.join("\n")}`,
    ),
    mrkdwn(`💡 *次の一歩: ${aspectLabel[weakest.criterion]}*\n${slackEscape(clip(weakest.nextStep, 600))}`),
    ...(recent.length
      ? [
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `⬆️⬇️は直近${recent.length}回の平均との比較。A1〜C2を6マスで表示（🟨は「+」）`,
              },
            ],
          },
        ]
      : []),
  ];
}

/**
 * The review as Block Kit: title and CEFR bars when judged up front, then the summary, focus points and next lesson.
 * The long part goes in an attachment, which Slack folds behind "Show more" after a few lines.
 */
export function reviewSlackMessage(lesson: Lesson, history: Lesson[] = []): SlackMessage {
  if (!lesson.feedback) throw new Error("投稿する振り返りがありません。");
  const feedback = mapFeedbackProse(lesson.feedback, plainTimes);
  const date = new Date(lesson.date).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" });
  const list = (items: string[]) => items.map((s) => `• ${slackEscape(s)}`).join("\n");
  const cefr = cefrBlocks(lesson, history);
  return {
    // Shown in notifications and by clients that cannot render blocks.
    text: slackEscape(slackShareText(lesson)),
    blocks: [
      { type: "header", text: plain(`📝 ${feedback.title}`, 150) },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: slackEscape(`DMM英会話 · ${date} · ${lesson.teacher}先生`) }],
      },
      ...cefr,
    ],
    attachments: [
      {
        color: "#2eb67d",
        // One section, since Slack folds each section on its own; the parts stay under its 3000 characters.
        blocks: [
          mrkdwn(
            [
              slackEscape(clip(feedback.summary, 1800)),
              `*今日の重点*\n${list(feedback.focus.slice(0, 3).map((s) => clip(s, 200)))}`,
              `*次のレッスンで使う*\n${list(feedback.nextLesson.slice(0, 5).map((s) => clip(s, 150)))}`,
            ].join("\n\n"),
          ),
        ],
      },
    ],
  };
}

/** Posts to an Incoming Webhook. The URL is the secret, so errors never include it. */
export async function postSlack(webhookUrl: string, message: SlackMessage): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(
      `SlackのWebhookが投稿を受け付けませんでした (${response.status} ${(await response.text()).slice(0, 200)})。`,
    );
}

/** Posts a test message first, so settings are saved only once the webhook actually accepts posts. */
export async function enableSlackDelivery(root: string, webhookUrl: string): Promise<SlackSettings> {
  const parsed = slackSettingsSchema.safeParse({
    version: 1,
    webhookUrl,
    enabledAt: new Date().toISOString(),
  });
  if (!parsed.success)
    throw new Error("SlackのIncoming WebhookのURL (https://hooks.slack.com/...) を入力してください。");
  await postSlack(parsed.data.webhookUrl, {
    text: "Slack配信を設定しました。これ以降に完成したDMM英会話の振り返りをここに投稿します。",
  });
  atomicJson(settingsPath(root), parsed.data);
  return parsed.data;
}

export function disableSlackDelivery(root: string): void {
  rmSync(settingsPath(root), { force: true });
}

/** Reads the settings on every use, so `dmm auto slack` takes effect in a running background process. */
export class SlackReviewPost implements ReviewChannel {
  readonly key = "slack";
  readonly label = "振り返りのSlack投稿";
  constructor(private readonly store: Pick<Store, "root" | "library">) {}
  enabledAt() {
    return readSlackSettings(this.store.root)?.enabledAt;
  }
  async send(lesson: Lesson) {
    const settings = readSlackSettings(this.store.root);
    if (!settings) throw new Error("Slack配信が設定されていません。");
    await postSlack(settings.webhookUrl, reviewSlackMessage(lesson, this.store.library.lessons));
  }
}
