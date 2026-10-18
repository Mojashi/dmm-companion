import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReviewDelivery } from "./automation";
import type { Lesson } from "./domain";
import { sendMacNotification } from "./notifications";
import type { Store } from "./store";
import { mapFeedbackProse, plainTimes, youglish } from "./timestamps";

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function notificationAction(binary: string, root: string, lessonId?: string): string {
  const args = [binary, "--data-dir", root];
  if (lessonId) args.push("--lesson", lessonId);
  return `/usr/bin/nohup ${args.map(shellQuote).join(" ")} >> ${shellQuote(join(root, "logs", "page.log"))} 2>&1 < /dev/null &`;
}

export function reviewMarkdown(lesson: Lesson): string {
  if (!lesson.feedback) throw new Error("配信する振り返りがありません。");
  const feedback = mapFeedbackProse(lesson.feedback, plainTimes);
  const date = new Date(lesson.date).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  return [
    `# ${feedback.title}`,
    `${date} / ${lesson.teacher}先生`,
    feedback.source === "audio_transcript"
      ? "録音の文字起こしに基づく振り返りです。"
      : "録音に基づく振り返りです。",
    feedback.summary,
    "## うまくできたこと",
    ...feedback.strengths.map((s) => `- ${s}`),
    "## 今日の重点",
    ...feedback.focus.slice(0, 3).map((s) => `- ${s}`),
    "## 見ずに英語で言ってみる",
    ...feedback.expressions
      .slice(0, 3)
      .flatMap((e, i) => [
        `### ${i + 1}. ${e.meaning}`,
        `${e.kind === "comprehension" ? "返し方の例" : "言い直しの例"}: ${e.improved}`,
        `レッスンでの発話: ${e.original}`,
        e.explanation,
        ...(e.kind === "pronunciation" && e.words?.length
          ? [`ネイティブの発音: ${e.words.map((w) => `[${w}](${youglish(w)})`).join(" ")}`]
          : []),
        `次はこの文も: ${e.practice}`,
      ]),
    "## 次のレッスンで使う",
    ...feedback.nextLesson.map((s) => `- ${s}`),
    "## 分析の補足",
    feedback.speakerIdentification,
    ...feedback.uncertainties,
  ].join("\n\n");
}

export class MacReviewDelivery implements ReviewDelivery {
  constructor(
    private readonly store: Pick<Store, "root" | "path">,
    private readonly binary: string,
  ) {}
  async deliver(lesson: Lesson): Promise<{ file: string }> {
    if (!/^[\w-]+$/.test(lesson.id)) throw new Error("配信対象のレッスンIDが不正です。");
    mkdirSync(this.store.path("deliveries"), { recursive: true, mode: 0o700 });
    const file = `deliveries/${lesson.id}.md`;
    writeFileSync(this.store.path(file), `${reviewMarkdown(lesson)}\n`, { mode: 0o600 });
    await this.notify(
      `${lesson.teacher}先生との振り返り`,
      `${lesson.feedback?.title}\n${lesson.feedback?.focus[0] ?? "次のレッスンに向けて復習しましょう。"}`.slice(
        0,
        220,
      ),
      `dmm-review-${lesson.id}`,
      lesson.id,
    );
    return { file };
  }
  async alert(message: string): Promise<void> {
    await this.notify("自動振り返りを確認してください", message.slice(0, 220), "dmm-automation-error");
  }
  async test(): Promise<void> {
    await this.notify(
      "DMM英会話の振り返り",
      "通知テストです。クリックすると振り返りページが開きます。",
      "dmm-notification-test",
      undefined,
      true,
    );
  }
  private async notify(
    title: string,
    message: string,
    group: string,
    lessonId?: string,
    requestPermission = false,
  ) {
    mkdirSync(this.store.path("logs"), { recursive: true, mode: 0o700 });
    writeFileSync(this.store.path("logs", "page.log"), "", { flag: "a", mode: 0o600 });
    await sendMacNotification(
      [
        "-title",
        title,
        "-message",
        message,
        "-group",
        group,
        "-execute",
        notificationAction(this.binary, this.store.root, lessonId),
      ],
      requestPermission,
    );
  }
}
