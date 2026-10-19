/** CEFR levels and their numeric scale; shared by the server and the page, so it imports nothing. */
export const cefrLevels = ["A1", "A2", "A2+", "B1", "B1+", "B2", "B2+", "C1", "C2"] as const;
export type CefrLevel = (typeof cefrLevels)[number];
/** The CEFR-like numeric scale of the Speak & Improve corpus (A2 = 2.0, B1 = 3.0, … "+" adds 0.5), for averaging. */
export const cefrScore: Record<CefrLevel, number> = {
  A1: 1,
  A2: 2,
  "A2+": 2.5,
  B1: 3,
  "B1+": 3.5,
  B2: 4,
  "B2+": 4.5,
  C1: 5,
  C2: 6,
};

export type Assessed = { date: string; overall: CefrLevel; aspects: Record<string, CefrLevel> };
export type Period = {
  from: string;
  to: string;
  count: number;
  overall: number;
  aspects: Record<string, number>;
};

/**
 * Groups judged lessons into periods of `size` lessons and averages each level on the numeric scale.
 * One lesson's estimate swings with the topic; an average over several is the steadier reading.
 * Periods are cut from the newest lesson backwards, so only the oldest period may be short.
 */
export function cefrPeriods(assessed: Assessed[], size: number): Period[] {
  const sorted = [...assessed].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const periods: Period[] = [];
  for (let end = sorted.length; end > 0; end -= size) {
    const group = sorted.slice(Math.max(0, end - size), end);
    const mean = (levels: CefrLevel[]) => levels.reduce((s, l) => s + cefrScore[l], 0) / levels.length;
    const names = Object.keys(group[0]?.aspects ?? {});
    periods.unshift({
      from: group[0]?.date ?? "",
      to: group.at(-1)?.date ?? "",
      count: group.length,
      overall: mean(group.map((g) => g.overall)),
      aspects: Object.fromEntries(
        names.map((n) => [n, mean(group.flatMap((g) => (g.aspects[n] ? [g.aspects[n]] : [])))]),
      ),
    });
  }
  return periods;
}
