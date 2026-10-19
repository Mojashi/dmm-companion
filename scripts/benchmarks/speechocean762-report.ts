/**
 * Summarizes speechocean762 benchmark runs against the expert scores.
 *
 *   bun scripts/benchmarks/speechocean762-report.ts <manifest.jsonl> <results.jsonl>...
 *
 * Several results files are averaged per utterance (an ensemble of repeated runs). Samples are stratified
 * by human total score, so correlations are re-weighted to the split's real score distribution; otherwise
 * the wider spread of the sample would inflate them. 95% intervals come from a stratified bootstrap.
 */
import { readFileSync } from "node:fs";

const [manifestPath, ...resultPaths] = Bun.argv.slice(2);
if (!manifestPath || !resultPaths.length)
  throw new Error("usage: speechocean762-report.ts <manifest.jsonl> <results.jsonl>...");

const aspects = ["accuracy", "fluency", "prosodic", "total"] as const;
type Scores = Record<(typeof aspects)[number], number>;
type Result = { id: string; human: Scores; model: Scores | null };

const lines = <T>(path: string) =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);

const population = new Map<number, number>();
for (const u of lines<{ total: number }>(manifestPath))
  population.set(Math.round(u.total), (population.get(Math.round(u.total)) ?? 0) + 1);

// Per utterance, the mean of every run that scored it; only utterances scored by all runs are compared.
const runs = resultPaths.map(
  (p) =>
    new Map(
      lines<Result>(p)
        .filter((r) => r.model)
        .map((r) => [r.id, r]),
    ),
);
const ids = [...(runs[0]?.keys() ?? [])].filter((id) => runs.every((run) => run.has(id)));
const rows = ids.map((id) => {
  const scored = runs.map((run) => run.get(id) as Result);
  const model = Object.fromEntries(
    aspects.map((a) => [a, scored.reduce((s, r) => s + (r.model?.[a] ?? 0), 0) / scored.length]),
  ) as Scores;
  return { human: (scored[0] as Result).human, model, bin: Math.round((scored[0] as Result).human.total) };
});

type Row = (typeof rows)[number];
function weightedPearson(sample: Row[], aspect: (typeof aspects)[number]): number {
  const inSample = new Map<number, number>();
  for (const r of sample) inSample.set(r.bin, (inSample.get(r.bin) ?? 0) + 1);
  const w = sample.map((r) => (population.get(r.bin) ?? 0) / (inSample.get(r.bin) ?? 1));
  const W = w.reduce((s, v) => s + v, 0);
  const x = sample.map((r) => r.human[aspect]);
  const y = sample.map((r) => r.model[aspect]);
  const mx = x.reduce((s, v, i) => s + (w[i] ?? 0) * v, 0) / W;
  const my = y.reduce((s, v, i) => s + (w[i] ?? 0) * v, 0) / W;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < sample.length; i++) {
    const dx = (x[i] ?? 0) - mx;
    const dy = (y[i] ?? 0) - my;
    sxy += (w[i] ?? 0) * dx * dy;
    sxx += (w[i] ?? 0) * dx * dx;
    syy += (w[i] ?? 0) * dy * dy;
  }
  return sxy / Math.sqrt(sxx * syy);
}

// Deterministic bootstrap so reruns of the report agree.
let seed = 1;
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed / 2 ** 31;
};
const bins = new Map<number, Row[]>();
for (const r of rows) bins.set(r.bin, [...(bins.get(r.bin) ?? []), r]);

console.log(`${resultPaths.length} run(s), ${rows.length} utterances`);
for (const a of aspects) {
  const boot = Array.from({ length: 1000 }, () =>
    weightedPearson(
      [...bins.values()].flatMap((b) => b.map(() => b[Math.floor(random() * b.length)] as Row)),
      a,
    ),
  ).sort((p, q) => p - q);
  const bias = rows.reduce((s, r) => s + r.model[a] - r.human[a], 0) / rows.length;
  console.log(
    `${a.padEnd(9)} PCC ${weightedPearson(rows, a).toFixed(3)} [${(boot[25] ?? 0).toFixed(3)}, ${(boot[974] ?? 0).toFixed(3)}]  bias ${bias >= 0 ? "+" : ""}${bias.toFixed(2)}`,
  );
}
