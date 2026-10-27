import type { ReactNode } from "react";
import { aspectLabel } from "../cefr";
import type { Lesson } from "../domain";

/** The lesson's CEFR estimate per aspect: the level, then the evidence it rests on and the next step. */
export function LessonAssessment({
  assessment,
  error,
  timed,
}: {
  assessment?: Lesson["assessment"];
  error?: string;
  timed: (text: string) => ReactNode;
}) {
  if (!assessment) return error ? <p className="speaking-error">CEFRの判定に失敗しました: {error}</p> : null;
  return (
    <section className="assessment">
      <span className="eyebrow">CEFR ESTIMATE</span>
      <h3>
        CEFRの目安 <strong>{assessment.overall.level}</strong>
      </h3>
      <p className="assessment-rationale">{timed(assessment.overall.rationale)}</p>
      <div className="assessment-levels">
        {assessment.criteria.map((c) => (
          <details key={c.criterion}>
            <summary>
              <span>{aspectLabel[c.criterion]}</span>
              <strong>{c.level}</strong>
            </summary>
            <p>
              <span className="assessment-tag">根拠</span>
              {timed(c.evidence)}
            </p>
            <p>
              <span className="assessment-tag">次へ</span>
              {timed(c.nextStep)}
            </p>
          </details>
        ))}
      </div>
      {assessment.caveats.length > 0 && (
        <ul className="assessment-caveats">
          {assessment.caveats.map((c) => (
            <li key={c}>{timed(c)}</li>
          ))}
        </ul>
      )}
      <small>
        25分の会話1回分から {assessment.model}{" "}
        が判定した目安です。1回ごとの判定は粗いので、成長の記録の平均で見てください。
      </small>
    </section>
  );
}
