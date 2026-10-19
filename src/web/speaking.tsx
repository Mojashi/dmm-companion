import { useState } from "react";
import type { SpeakingMetrics } from "../domain";

/** This lesson's speaking metrics, and the learner's verbatim transcript loaded when opened. */
export function LessonSpeaking({
  metrics,
  error,
  loadTranscript,
}: {
  metrics?: SpeakingMetrics;
  error?: string;
  loadTranscript: () => Promise<{ transcript: string; model: string }>;
}) {
  const [transcript, setTranscript] = useState<{ transcript: string; model: string }>();
  const [failure, setFailure] = useState("");
  if (!metrics) return error ? <p className="speaking-error">発話の計測に失敗しました: {error}</p> : null;
  const facts = [
    ["話した割合", `${(metrics.talkShare * 100).toFixed(0)}%`],
    ["1回の発言", `${metrics.meanTurnSeconds.toFixed(1)}秒`],
    ["途切れずに", `${metrics.meanLengthOfRun.toFixed(1)}語`],
    ["速さ", `${metrics.wordsPerMinute.toFixed(0)}語/分`],
    ["語彙の多様さ", metrics.mattr === null ? "—" : metrics.mattr.toFixed(2)],
    ["uh・um", `${metrics.fillersPerMinute.toFixed(1)}回/分`],
  ];
  return (
    <div className="speaking">
      <span className="eyebrow">HOW YOU SPOKE</span>
      <dl>
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <details
        onToggle={(e) => {
          if (e.currentTarget.open && !transcript)
            loadTranscript()
              .then(setTranscript)
              .catch((e: Error) => setFailure(e.message));
        }}
      >
        <summary>あなたの発話の書き起こし ({metrics.words}語)</summary>
        {failure ? (
          <p className="speaking-error">{failure}</p>
        ) : transcript ? (
          <>
            <div className="transcript">
              {transcript.transcript.split(/\n+/).map((line, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional and never reordered
                <p key={i}>{line}</p>
              ))}
            </div>
            <small>{transcript.model} が言い淀みも含めて書き起こしたものです。</small>
          </>
        ) : (
          <p>読み込み中…</p>
        )}
      </details>
    </div>
  );
}
