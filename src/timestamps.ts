import type { Feedback } from "./domain";

/**
 * Feedback prose refers to a moment in the recording as [m:ss], e.g. [4:37], and to a span as
 * [m:ss-m:ss]. Gemini also writes spans as [1:27]〜[5:40], which is read the same way.
 */
const time = String.raw`(\d{1,3}):([0-5]\d)`;
const reference = new RegExp(
  String.raw`\[${time}(?:\s*[-–〜~]\s*${time})?\](?:\s*[〜~–]\s*\[${time}\])?`,
  "g",
);

export type TimedSegment = { text: string } | { at: number; until?: number };

export function timedSegments(text: string): TimedSegment[] {
  const segments: TimedSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(reference)) {
    if (match.index > last) segments.push({ text: text.slice(last, match.index) });
    const seconds = (m?: string, s?: string) => (m === undefined ? undefined : Number(m) * 60 + Number(s));
    const at = seconds(match[1], match[2]) ?? 0;
    const until = seconds(match[3], match[4]) ?? seconds(match[5], match[6]);
    segments.push(until !== undefined && until > at ? { at, until } : { at });
    last = match.index + match[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last) });
  return segments;
}

export function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

export function span(s: { at: number; until?: number }): string {
  return s.until === undefined ? clock(s.at) : `${clock(s.at)}–${clock(s.until)}`;
}

/** For media that cannot seek the recording (mail, Markdown): [4:37] → 4:37. */
export function plainTimes(text: string): string {
  return timedSegments(text)
    .map((s) => ("at" in s ? span(s) : s.text))
    .join("");
}

/**
 * Normalizes references to [m:ss] / [m:ss-m:ss] and keeps only those inside the recording seekable.
 * A span running past the end keeps its start; a start past the end becomes plain text.
 */
export function withinRecording(text: string, seconds: number): string {
  return timedSegments(text)
    .map((s) => {
      if ("text" in s) return s.text;
      if (s.at >= seconds) return span(s);
      const inside =
        s.until !== undefined && s.until <= seconds ? { at: s.at, until: s.until } : { at: s.at };
      return `[${span(inside).replace("–", "-")}]`;
    })
    .join("");
}

/** YouGlish plays YouTube clips where native speakers say the word, cued to that moment. */
export function youglish(word: string): string {
  return `https://youglish.com/pronounce/${encodeURIComponent(word.trim().toLowerCase())}/english/us`;
}

export function mapFeedbackProse(feedback: Feedback, map: (text: string) => string): Feedback {
  return {
    ...feedback,
    summary: map(feedback.summary),
    speakerIdentification: map(feedback.speakerIdentification),
    strengths: feedback.strengths.map(map),
    focus: feedback.focus.map(map),
    expressions: feedback.expressions.map((e) => ({ ...e, explanation: map(e.explanation) })),
    nextLesson: feedback.nextLesson.map(map),
    uncertainties: feedback.uncertainties.map(map),
  };
}
