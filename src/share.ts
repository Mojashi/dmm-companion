import type { Lesson } from "./domain";
import { mapFeedbackProse, plainTimes } from "./timestamps";

/** A short review in Slack's mrkdwn, meant to be pasted into a message as is. */
export function slackShareText(lesson: Pick<Lesson, "date" | "teacher" | "feedback">): string {
  if (!lesson.feedback) throw new Error("共有する振り返りがありません。");
  const feedback = mapFeedbackProse(lesson.feedback, plainTimes);
  const date = new Date(lesson.date).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" });
  return [
    `*DMM英会話の振り返り: ${feedback.title}*`,
    `${date} / ${lesson.teacher}先生`,
    feedback.summary,
    "*今日の重点*",
    feedback.focus
      .slice(0, 3)
      .map((s) => `• ${s}`)
      .join("\n"),
    "*次のレッスンで使う*",
    feedback.nextLesson.map((s) => `• ${s}`).join("\n"),
  ].join("\n\n");
}
