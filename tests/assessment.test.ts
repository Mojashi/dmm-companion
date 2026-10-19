import { expect, test } from "bun:test";
import { type Assessment, criteria, parseAssessment } from "../src/assessment";

const answer = (): Assessment => ({
  source: "native_audio",
  criteria: [...criteria].reverse().map((criterion) => ({
    criterion,
    evidence: "[0:10] の発話と [30:00] の発話",
    level: "B1",
    nextStep: "次は [0:20] のように",
  })),
  overall: { rationale: "全体として [1:00]", level: "B1" },
  caveats: [],
});

test("観点を定義順に並べ、録音外の時刻は再生リンクにしない", () => {
  const parsed = parseAssessment(answer(), 600);
  expect(parsed.criteria.map((c) => c.criterion)).toEqual([...criteria]);
  expect(parsed.criteria[0]?.evidence).toBe("[0:10] の発話と 30:00 の発話");
});
test("観点の欠け・重複や、文字起こしだけでの判定を拒否する", () => {
  const duplicated = answer();
  duplicated.criteria[1] = { ...(duplicated.criteria[0] as Assessment["criteria"][number]) };
  expect(() => parseAssessment(duplicated, 600)).toThrow("観点");
  expect(() => parseAssessment({ ...answer(), source: "audio_transcript" }, 600)).toThrow("文字起こし");
  expect(() => parseAssessment({ ...answer(), criteria: answer().criteria.slice(1) }, 600)).toThrow();
});
