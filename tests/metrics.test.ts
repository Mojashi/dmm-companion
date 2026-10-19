import { expect, test } from "bun:test";
import { mattr, runsBetweenSilences, speakingMetrics, spokenWords, turns } from "../src/metrics";

test("無音の区間の間を発話区間として取り出す", () => {
  const metadata = [
    "frame:0 pts:0",
    "lavfi.silence_start=0",
    "lavfi.silence_end=1.5",
    "lavfi.silence_start=4",
    "lavfi.silence_end=6",
  ].join("\n");
  expect(runsBetweenSilences(metadata, 9)).toEqual([
    { start: 1.5, end: 4 },
    { start: 6, end: 9 },
  ]);
  expect(runsBetweenSilences("lavfi.silence_start=0\nlavfi.silence_end=2", 2.1)).toEqual([]);
});
test("言い淀みと注記を語数から除き、言い淀みは別に数える", () => {
  expect(spokenWords("Uh, I don't wanna, um, [ja] lose to them [inaudible].")).toEqual({
    words: ["i", "don't", "wanna", "lose", "to", "them"],
    fillers: 2,
  });
  expect(spokenWords("Mhm. Uh-huh. Mmm, yeah, hmm.")).toEqual({ words: ["yeah"], fillers: 0 });
});
test("MATTRは窓ごとの異なり語率の平均", () => {
  expect(mattr(["a", "b"], 50)).toBeNull();
  expect(mattr(["a", "b", "a", "b"], 2)).toBe(1);
  expect(mattr(["a", "a", "a"], 2)).toBe(0.5);
});
test("相手の発話中の相づちは発話の番にしない", () => {
  const learner = [
    { start: 0, end: 5 },
    { start: 12, end: 12.5 }, // "yeah" while the teacher is talking
    { start: 20, end: 30 },
  ];
  const teacher = [{ start: 6, end: 19 }];
  expect(turns(learner, teacher).map((t) => t.speaker)).toEqual(["learner", "teacher", "learner"]);
  const metrics = speakingMetrics(learner, teacher, { words: Array(31).fill("word"), fillers: 3 });
  expect(metrics.turns).toBe(2);
  expect(metrics.meanTurnSeconds).toBe(7.5);
  expect(metrics.learnerSeconds).toBe(15.5);
  expect(metrics.talkShare).toBeCloseTo(15.5 / 28.5);
  expect(metrics.meanLengthOfRun).toBeCloseTo(31 / 3);
  expect(metrics.wordsPerMinute).toBeCloseTo(31 / (15.5 / 60));
});
test("同時実行数を上限で抑えて全件を処理する", async () => {
  const { eachConcurrently } = await import("../src/concurrency");
  let running = 0;
  let peak = 0;
  const done: number[] = [];
  await eachConcurrently([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    peak = Math.max(peak, ++running);
    await Bun.sleep(5);
    running--;
    done.push(n);
  });
  expect(peak).toBe(3);
  expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
});
