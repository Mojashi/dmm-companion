import { describe, expect, test } from "bun:test";
import type { Feedback } from "../src/domain";
import { slackShareText } from "../src/share";

const feedback: Feedback = {
  source: "audio_transcript",
  title: "Practice",
  summary: "[1:05]で過去形を言い直しました。",
  speakerIdentification: "Identified",
  strengths: ["Clear"],
  focus: ["Tense", "Linking", "Pace", "Extra"],
  expressions: [],
  nextLesson: ["Use the past tense"],
  uncertainties: [],
};

describe("slackShareText", () => {
  test("要点・重点3つ・次回をSlackの書式で、時刻はプレーンにする", () => {
    expect(slackShareText({ date: "2026-09-11T15:30:00.000Z", teacher: "Anna", feedback })).toBe(
      [
        "*DMM英会話の振り返り: Practice*",
        "2026/9/12 / Anna先生",
        "1:05で過去形を言い直しました。",
        "*今日の重点*",
        "• Tense\n• Linking\n• Pace",
        "*次のレッスンで使う*",
        "• Use the past tense",
      ].join("\n\n"),
    );
  });
  test("振り返りが無ければ共有しない", () => {
    expect(() => slackShareText({ date: "2026-09-11T15:30:00.000Z", teacher: "Anna" })).toThrow();
  });
});
