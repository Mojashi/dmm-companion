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
