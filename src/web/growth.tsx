import { useState } from "react";
import { cefrLevels, cefrPeriods, cefrScore } from "../cefr";
import type { Lesson, SpeakingMetrics } from "../domain";

type Measured = Pick<Lesson, "id" | "date" | "teacher" | "metrics" | "assessment">;

/** Reads a metric off a lesson that has speaking metrics. */
const fromMetrics =
  (read: (m: SpeakingMetrics) => number | null) =>
  (l: Measured): number | null =>
    l.metrics ? read(l.metrics) : null;

/** A CEFR-like score (A2 = 2, B1 = 3, "+" = 0.5) shown as the nearest level; averages keep one decimal. */
function cefrLabel(score: number): string {
  const nearest = cefrLevels.reduce((best, level) =>
    Math.abs(cefrScore[level] - score) < Math.abs(cefrScore[best] - score) ? level : best,
  );
  return Number.isInteger(score * 2) ? nearest : `${nearest} (${score.toFixed(1)})`;
}

/** Lessons swing with the topic, so trends are read from the average of this many recent lessons. */
const recent = 4;

type Measure = {
  key: string;
  label: string;
  value: (l: Measured) => number | null;
  format: (v: number) => string;
  better: "higher" | "lower";
  note: string;
};
const measures: Measure[] = [
  {
    key: "cefr",
    label: "CEFRの目安 (総合)",
    value: (l) => (l.assessment ? cefrScore[l.assessment.overall.level] : null),
    format: cefrLabel,
    better: "higher",
    note: "録音からGeminiが判定した総合レベルの目安。1回ごとの判定は粗いので平均の推移で見る",
  },
  {
    key: "share",
    label: "話した割合",
    value: fromMetrics((m) => m.talkShare * 100),
    format: (v) => `${v.toFixed(0)}%`,
    better: "higher",
    note: "あなたと講師が声を出していた時間のうち、あなたの割合",
  },
  {
    key: "turn",
    label: "1回の発言の長さ",
    value: fromMetrics((m) => m.meanTurnSeconds),
    format: (v) => `${v.toFixed(1)}秒`,
    better: "higher",
    note: "講師と交代するまでに話し続けた時間の平均。相づちは数えない",
  },
  {
    key: "run",
    label: "途切れずに言えた語数",
    value: fromMetrics((m) => m.meanLengthOfRun),
    format: (v) => `${v.toFixed(1)}語`,
    better: "higher",
    note: "0.25秒以上の間を空けずに続けて言えた語数の平均 (MLR)。流暢さの代表的な指標",
  },
  {
    key: "rate",
    label: "話す速さ",
    value: fromMetrics((m) => m.wordsPerMinute),
    format: (v) => `${v.toFixed(0)}語/分`,
    better: "higher",
    note: "声を出している時間あたりの語数。uh・umは含めない",
  },
  {
    key: "mattr",
    label: "語彙の多様さ",
    value: fromMetrics((m) => m.mattr),
    format: (v) => v.toFixed(2),
    better: "higher",
    note: "50語ごとの窓で、異なる語の割合を平均した値 (MATTR)。話した量に左右されにくい",
  },
  {
    key: "filler",
    label: "uh・umの頻度",
    value: fromMetrics((m) => m.fillersPerMinute),
    format: (v) => `${v.toFixed(1)}回/分`,
    better: "lower",
    note: "声を出している1分あたりのuh・um・erなど",
  },
];

const mean = (values: number[]) => values.reduce((s, v) => s + v, 0) / values.length;
const day = (date: string) =>
  new Date(date).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric", timeZone: "Asia/Tokyo" });

/** Each lesson's value, and the average of the lessons up to and including it. */
function series(lessons: Measured[], measure: Measure) {
  const points = lessons.flatMap((l) => {
    const v = measure.value(l);
    return v === null ? [] : [{ lesson: l, value: v }];
  });
  return points.map((p, i) => ({
    ...p,
    average: mean(points.slice(Math.max(0, i - recent + 1), i + 1).map((q) => q.value)),
  }));
}

function Tile({
  lessons,
  measure,
  onOpen,
}: {
  lessons: Measured[];
  measure: Measure;
  onOpen: (id: string) => void;
}) {
  const [hover, setHover] = useState<number>();
  const points = series(lessons, measure);
  if (!points.length) return null;
  const latest = mean(points.slice(-recent).map((p) => p.value));
  const before =
    points.length > recent ? mean(points.slice(-2 * recent, -recent).map((p) => p.value)) : undefined;
  const change = before ? (latest - before) / before : undefined;
  const improved = change !== undefined && (measure.better === "higher" ? change > 0 : change < 0);
  // Sparkline geometry in viewBox units; times are positioned by date so gaps between lessons show.
  const width = 280;
  const height = 64;
  const pad = 6;
  const times = points.map((p) => Date.parse(p.lesson.date));
  const values = points.flatMap((p) => [p.value, p.average]);
  const [t0, t1] = [Math.min(...times), Math.max(...times)];
  const [v0, v1] = [Math.min(...values), Math.max(...values)];
  const x = (t: number) => (t1 === t0 ? width / 2 : pad + ((t - t0) / (t1 - t0)) * (width - 2 * pad));
  const y = (v: number) =>
    v1 === v0 ? height / 2 : height - pad - ((v - v0) / (v1 - v0)) * (height - 2 * pad);
  const shown = hover === undefined ? undefined : points[hover];
  return (
    <figure className="growth-tile">
      <figcaption>
        <span className="growth-label">{measure.label}</span>
        <span className="growth-value">{measure.format(latest)}</span>
        <span className="growth-change">
          直近{Math.min(recent, points.length)}回の平均
          {change !== undefined && (
            <>
              {" · "}前の{recent}回より{change > 0 ? "+" : ""}
              {(change * 100).toFixed(0)}%{improved ? " ↗ 良くなっています" : ""}
            </>
          )}
        </span>
      </figcaption>
      <div className="growth-plot">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${measure.label}の推移`}>
          <polyline
            className="growth-average"
            points={points.map((p, i) => `${x(times[i] ?? 0)},${y(p.average)}`).join(" ")}
          />
          {points.map((p, i) => (
            <circle
              key={p.lesson.id}
              className={i === hover ? "growth-dot active" : "growth-dot"}
              cx={x(times[i] ?? 0)}
              cy={y(p.value)}
              r={i === hover ? 4.5 : 3}
            />
          ))}
        </svg>
        {points.map((p, i) => (
          // Hit targets wider than the dots, laid over the plot as real buttons.
          <button
            key={p.lesson.id}
            type="button"
            className="growth-hit"
            style={{ left: `${(x(times[i] ?? 0) / width) * 100}%` }}
            aria-label={`${day(p.lesson.date)} ${p.lesson.teacher}: ${measure.format(p.value)}`}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(undefined)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(undefined)}
            onClick={() => onOpen(p.lesson.id)}
          />
        ))}
        {shown && hover !== undefined && (
          <div className="growth-tooltip" style={{ left: `${(x(times[hover] ?? 0) / width) * 100}%` }}>
            <strong>{measure.format(shown.value)}</strong>
            <span>
              {day(shown.lesson.date)} · {shown.lesson.teacher}
            </span>
            <span>平均 {measure.format(shown.average)}</span>
          </div>
        )}
      </div>
      <p className="growth-note">{measure.note}</p>
    </figure>
  );
}

const aspectLabel: Record<string, string> = {
  range: "表現の幅",
  accuracy: "正確さ",
  fluency: "流暢さ",
  interaction: "やりとり",
  coherence: "まとまり",
  phonology: "発音",
};
/** Lessons per period: enough judgements that one lesson's topic does not decide the level. */
const periodSize = 10;

/** The CEFR estimate averaged over every 10 judged lessons, newest period last. */
function Periods({ lessons }: { lessons: Measured[] }) {
  const periods = cefrPeriods(
    lessons.flatMap((l) =>
      l.assessment
        ? [
            {
              date: l.date,
              overall: l.assessment.overall.level,
              aspects: Object.fromEntries(l.assessment.criteria.map((c) => [c.criterion, c.level])),
            },
          ]
        : [],
    ),
    periodSize,
  );
  if (!periods.length) return null;
  const aspects = Object.keys(periods.at(-1)?.aspects ?? {});
  return (
    <div className="growth-periods">
      <h3>
        {periodSize}回ごとのCEFRの目安 <span>各レッスンの判定を平均したもの</span>
      </h3>
      <div className="growth-table-wrap">
        <table className="growth-table">
          <thead>
            <tr>
              <th>期間</th>
              <th>回数</th>
              <th>総合</th>
              {aspects.map((a) => (
                <th key={a}>{aspectLabel[a] ?? a}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...periods].reverse().map((p, i, all) => {
              const previous = all[i + 1];
              const change = previous ? p.overall - previous.overall : 0;
              return (
                <tr key={p.from}>
                  <td>
                    {day(p.from)}〜{day(p.to)}
                  </td>
                  <td>{p.count}</td>
                  <td>
                    {cefrLabel(p.overall)}
                    {Math.abs(change) >= 0.25 && (
                      <span className="growth-delta">{change > 0 ? " ↗" : " ↘"}</span>
                    )}
                  </td>
                  {aspects.map((a) => (
                    <td key={a}>{p.aspects[a] === undefined ? "—" : cefrLabel(p.aspects[a])}</td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function Growth({
  lessons,
  onOpen,
}: {
  lessons: Pick<Lesson, "id" | "date" | "teacher" | "metrics" | "metricsError" | "assessment">[];
  onOpen: (id: string) => void;
}) {
  const measured = lessons
    .filter((l) => l.metrics || l.assessment)
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const failed = lessons.filter((l) => l.metricsError && !l.metrics).length;
  return (
    <section className="growth">
      <div className="section-heading">
        <h2>
          Your progress <span>話す力の推移 · {measured.length}レッスン</span>
        </h2>
        <span className="growth-legend">
          <i className="dot" /> 各レッスン <i className="line" /> 直近{recent}回の平均
        </span>
      </div>
      {measured.length ? (
        <>
          <div className="growth-grid">
            {measures.map((m) => (
              <Tile key={m.key} lessons={measured} measure={m} onOpen={onOpen} />
            ))}
          </div>
          <Periods lessons={measured} />
          <p className="growth-caveat">
            話題や教材で1回ごとの値は大きく動きます。平均の線の向きで見てください。点を押すとそのレッスンを開きます。
            {failed ? ` 計測できなかったレッスンが${failed}件あります。` : ""}
          </p>
          <div className="growth-table-wrap">
            <table className="growth-table">
              <thead>
                <tr>
                  <th>日付</th>
                  <th>講師</th>
                  {measures.map((m) => (
                    <th key={m.key}>{m.label}</th>
                  ))}
                  <th>語数</th>
                </tr>
              </thead>
              <tbody>
                {[...measured].reverse().map((l) => (
                  <tr key={l.id} onClick={() => onOpen(l.id)}>
                    <td>{day(l.date)}</td>
                    <td>{l.teacher}</td>
                    {measures.map((m) => {
                      const v = m.value(l);
                      return <td key={m.key}>{v === null ? "—" : m.format(v)}</td>;
                    })}
                    <td>{l.metrics?.words ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="reflection-empty">
          <h3>まだ計測したレッスンがありません。</h3>
          <p>
            振り返りを作ると、あわせて発話量・流暢さ・語彙を計測します。過去のレッスンは{" "}
            <code>dmm measure all</code> で計測できます。
          </p>
        </div>
      )}
    </section>
  );
}
