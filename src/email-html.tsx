import type { CSSProperties, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Lesson } from "./domain";
import { mapFeedbackProse, plainTimes, youglish } from "./timestamps";

// Mail clients drop <style> blocks, so every style is inline. Colors follow src/web/style.css.
const ink = "#253930";
const muted = "#788177";
const line = "#dfe2d7";
const accent = "#b55333";
const green = "#2b4437";
const font = "'Hiragino Sans', 'Noto Sans JP', 'Helvetica Neue', Arial, sans-serif";

const styles = {
  page: { background: "#f5f3ec", padding: "24px 12px", fontFamily: font, color: ink },
  card: {
    maxWidth: 600,
    margin: "0 auto",
    background: "#fcfbf6",
    border: `1px solid ${line}`,
    borderRadius: 12,
    padding: "28px 24px",
  },
  eyebrow: { margin: 0, fontSize: 12, letterSpacing: "0.08em", color: accent, fontWeight: 600 },
  title: { margin: "6px 0 4px", fontSize: 22, lineHeight: 1.4, color: green },
  meta: { margin: 0, fontSize: 13, color: muted },
  summary: { margin: "18px 0 0", fontSize: 15, lineHeight: 1.8 },
  heading: {
    margin: "28px 0 10px",
    paddingBottom: 6,
    borderBottom: `1px solid ${line}`,
    fontSize: 16,
    color: green,
  },
  list: { margin: 0, paddingLeft: 20, fontSize: 15, lineHeight: 1.8 },
  expression: { margin: "0 0 14px", padding: "14px 16px", background: "#edf0e4", borderRadius: 8 },
  prompt: { margin: 0, fontSize: 15, fontWeight: 600 },
  improved: { margin: "8px 0 0", fontSize: 17, lineHeight: 1.5, color: green, fontWeight: 600 },
  label: { fontSize: 12, color: muted, fontWeight: 400 },
  detail: { margin: "6px 0 0", fontSize: 14, lineHeight: 1.7 },
  original: { margin: "6px 0 0", fontSize: 14, color: muted, textDecoration: "line-through" },
  link: { color: accent, textDecoration: "none", marginRight: 8 },
  note: { margin: "4px 0 0", fontSize: 12, lineHeight: 1.7, color: muted },
} satisfies Record<string, CSSProperties>;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <h2 style={styles.heading}>{title}</h2>
      {children}
    </>
  );
}

function Bullets({ items }: { items: string[] }) {
  return (
    <ul style={styles.list}>
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

function ReviewEmail({ lesson }: { lesson: Lesson }) {
  if (!lesson.feedback) throw new Error("配信する振り返りがありません。");
  const feedback = mapFeedbackProse(lesson.feedback, plainTimes);
  const date = new Date(lesson.date).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <p style={styles.eyebrow}>DMM英会話の振り返り</p>
        <h1 style={styles.title}>{feedback.title}</h1>
        <p style={styles.meta}>
          {date} / {lesson.teacher}先生
        </p>
        <p style={styles.summary}>{feedback.summary}</p>
        <Section title="うまくできたこと">
          <Bullets items={feedback.strengths} />
        </Section>
        <Section title="今日の重点">
          <Bullets items={feedback.focus.slice(0, 3)} />
        </Section>
        <Section title="見ずに英語で言ってみる">
          {feedback.expressions.slice(0, 3).map((e, i) => (
            <div key={e.meaning} style={styles.expression}>
              <p style={styles.prompt}>
                {i + 1}. {e.meaning}
              </p>
              <p style={styles.improved}>
                <span style={styles.label}>
                  {e.kind === "comprehension" ? "返し方の例 " : "言い直しの例 "}
                </span>
                {e.improved}
              </p>
              {e.kind === "correction" ? (
                <p style={styles.original}>{e.original}</p>
              ) : (
                <p style={styles.detail}>
                  <span style={styles.label}>レッスンでの発話 </span>
                  {e.original}
                </p>
              )}
              <p style={styles.detail}>{e.explanation}</p>
              {e.kind === "pronunciation" && e.words?.length ? (
                <p style={styles.detail}>
                  <span style={styles.label}>ネイティブの発音 </span>
                  {e.words.map((word) => (
                    <a key={word} href={youglish(word)} style={styles.link}>
                      ▶ {word}{" "}
                    </a>
                  ))}
                </p>
              ) : null}
              <p style={styles.detail}>
                <span style={styles.label}>次はこの文も </span>
                {e.practice}
              </p>
            </div>
          ))}
        </Section>
        <Section title="次のレッスンで使う">
          <Bullets items={feedback.nextLesson} />
        </Section>
        <Section title="分析の補足">
          <p style={styles.note}>
            {feedback.source === "audio_transcript"
              ? "録音の文字起こしに基づく振り返りです。"
              : "録音に基づく振り返りです。"}
          </p>
          {[feedback.speakerIdentification, ...feedback.uncertainties].map((note) => (
            <p key={note} style={styles.note}>
              {note}
            </p>
          ))}
        </Section>
      </div>
    </div>
  );
}

export function reviewEmailHtml(lesson: Lesson): string {
  return renderToStaticMarkup(<ReviewEmail lesson={lesson} />);
}
