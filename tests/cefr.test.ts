import { expect, test } from "bun:test";
import { type Assessed, aspectMean, cefrPeriods } from "../src/cefr";

const lesson = (day: number, overall: Assessed["overall"]): Assessed => ({
  date: `2026-09-${String(day).padStart(2, "0")}T00:00:00Z`,
  overall,
  aspects: { fluency: overall, phonology: "B1" },
});

test("新しい方から10件ずつ区切り、レベルを数値で平均する", () => {
  const lessons = [
    ...Array.from({ length: 3 }, (_, i) => lesson(i + 1, "A2")),
    ...Array.from({ length: 10 }, (_, i) => lesson(i + 10, i < 5 ? "B1" : "B1+")),
  ].reverse();
  const periods = cefrPeriods(lessons, 10);
  expect(periods.map((p) => p.count)).toEqual([3, 10]);
  expect(periods[0]?.overall).toBe(2);
  expect(periods[1]?.overall).toBe(3.25);
  expect(periods[1]?.aspects).toEqual({ fluency: 3.25, phonology: 3 });
  expect(periods[1]?.from).toBe("2026-09-10T00:00:00Z");
});

test("1回のレッスンのレベルは6観点を数値にした平均で連続値になる", () => {
  expect(aspectMean(["B1", "B1+", "B1", "B2", "A2+", "B1"])).toBeCloseTo(19 / 6);
  expect(aspectMean([])).toBeNull();
});
