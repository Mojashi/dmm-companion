import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  answerConversationQuestion,
  type Conversation,
  type ConversationAI,
  createConversation,
  parseUtterances,
  questionContext,
  readConversation,
} from "../src/conversation";
import type { Lesson } from "../src/domain";
import { atomicJson, Store } from "../src/store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const envelope = (response: unknown) => JSON.stringify({ status: "SUCCESS", response });
const testClips = async () => [{ file: "cached-audio.mp3", start: 0, seconds: 30 }];
const answer = {
  text: "先生の質問への返し方です。",
  examples: [{ english: "I enjoy tennis.", meaning: "テニスが好きです。" }],
  referenceIds: ["teacher-0"],
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dmm-conversation-"));
  roots.push(root);
  const store = new Store(root);
  const lesson: Lesson = {
    id: "lesson",
    date: "2026-11-02T05:00:00Z",
    teacher: "Tutor",
    topic: "",
    attended: true,
    phase: "done",
    reviewed: [],
    audio: { file: "audio/lesson.mp3", seconds: 30, origin: "2026-11-02T05:00:02Z" },
    tracks: ["Teacher", "Student"].map((role) => ({
      id: role,
      role: role as "Teacher" | "Student",
      start: "2026-11-02T05:00:02Z",
      mime: "audio/webm",
      chunks: [],
    })),
  };
  store.merge(lesson);
  store.save();
  mkdirSync(store.path("work", lesson.id), { recursive: true });
  for (const role of ["teacher", "student"])
    writeFileSync(store.path("work", lesson.id, `${role}.mp3`), "cached speaker audio");
  return { store, lesson };
}
function document(): Conversation {
  return {
    version: 1,
    lessonId: "lesson",
    model: "gemini-test",
    createdAt: "2026-11-02",
    segments: [
      {
        id: "teacher-0",
        role: "Teacher",
        start: 1,
        end: 3,
        text: "What do you do in your free time?",
        questions: [],
      },
      { id: "student-0", role: "Student", start: 4, end: 6, text: "I like tennis.", questions: [] },
      { id: "teacher-1", role: "Teacher", start: 7, end: 9, text: "I like swimming.", questions: [] },
    ],
  };
}

test("会話の時刻を検証し、順序を整え、録音末尾の僅かな超過を補正する", () => {
  expect(
    parseUtterances(
      envelope({
        segments: [
          { start: 4, end: 5, text: " later " },
          { start: 1, end: 2, text: "First" },
        ],
      }),
      10,
    ).map((s) => s.text),
  ).toEqual(["First", "later"]);
  expect(parseUtterances(envelope({ segments: [{ start: 9, end: 10.2, text: "End" }] }), 10)[0]?.end).toBe(
    10,
  );
  for (const segment of [
    { start: -1, end: 2, text: "No" },
    { start: 3, end: 2, text: "No" },
    { start: 9, end: 11, text: "No" },
    { start: 10, end: 10.3, text: "No" },
    { start: 0, end: 1, text: " " },
  ])
    expect(() => parseUtterances(envelope({ segments: [segment] }), 10)).toThrow();
});

test("話者は録音由来で固定し、両方の会話を時系列に保存して再利用する", async () => {
  const { store, lesson } = fixture();
  let calls = 0;
  const ask: ConversationAI = async (request) => {
    calls++;
    return envelope({
      segments: [
        {
          start: request.schema.name.endsWith("teacher") ? 1 : 4,
          end: request.schema.name.endsWith("teacher") ? 3 : 6,
          text: "A spoken sentence.",
        },
      ],
    });
  };
  const saved = await createConversation(store, lesson, "gemini-test", ask, testClips);
  expect(saved.segments.map((s) => [s.start, s.role])).toEqual([
    [1, "Teacher"],
    [4, "Student"],
  ]);
  expect(calls).toBe(2);
  expect(statSync(store.path("analyses", "lesson.conversation.json")).mode & 0o777).toBe(0o600);
  expect(await createConversation(store, lesson, "gemini-other", ask, testClips)).toEqual(saved);
  expect(calls).toBe(2);
  expect(readConversation(new Store(store.root), lesson.id)).toEqual(saved);
});

test("片方の書き起こしが失敗しても、もう片方の完了を待って再試行時に再利用する", async () => {
  const { store, lesson } = fixture();
  let studentDone = false;
  let teacherCalls = 0;
  let studentCalls = 0;
  const ask: ConversationAI = async (request) => {
    if (request.schema.name.endsWith("teacher")) {
      teacherCalls++;
      if (teacherCalls === 1) throw new Error("try again");
    } else {
      studentCalls++;
      await Bun.sleep(20);
      studentDone = true;
    }
    return envelope({ segments: [{ start: 1, end: 2, text: "Hello." }] });
  };
  await expect(createConversation(store, lesson, "gemini-test", ask, testClips)).rejects.toThrow("try again");
  expect(studentDone).toBe(true);
  expect(readConversation(store, lesson.id)).toBeUndefined();
  await createConversation(store, lesson, "gemini-test", ask, testClips);
  expect(teacherCalls).toBe(2);
  expect(studentCalls).toBe(1);
});

test("質問には選択した話者・全会話・同じ発言の直近6件だけを渡す", () => {
  const conversation = document();
  const selected = conversation.segments[0];
  const other = conversation.segments[1];
  if (!selected || !other) throw new Error("Missing test segments");
  selected.questions = Array.from({ length: 8 }, (_, i) => ({
    id: String(i),
    question: `question ${i}`,
    answer,
    model: "gemini-test",
    createdAt: "2026-11-02",
  }));
  other.questions = [
    {
      id: "other",
      question: "Other segment private question",
      answer,
      model: "gemini-test",
      createdAt: "2026-11-02",
    },
  ];
  const context = questionContext(conversation, "Tutor", selected.id, "  どう返す？  ");
  expect(context.question).toBe("どう返す？");
  expect(context.selected.role).toBe("Teacher");
  expect(context.dialogue).toHaveLength(3);
  expect(context.previousQuestions.map((q) => q.question)).toEqual(
    [2, 3, 4, 5, 6, 7].map((i) => `question ${i}`),
  );
  expect(JSON.stringify(context)).not.toContain("Other segment private question");
  expect(() => questionContext(conversation, "Tutor", "missing", "Meaning?")).toThrow("発言");
  for (const question of [" ", "a".repeat(2001)])
    expect(() => questionContext(conversation, "Tutor", selected.id, question)).toThrow("2,000");
});

test("区間内の時刻を元の録音へ戻し、同時呼び出しを4件に制限する", async () => {
  const { store, lesson } = fixture();
  if (!lesson.audio) throw new Error("Missing audio");
  lesson.audio.seconds = 200;
  let running = 0;
  let peak = 0;
  const clips = async () => [
    { file: "one", start: 0, seconds: 90 },
    { file: "two", start: 90, seconds: 90 },
    { file: "three", start: 180, seconds: 20 },
  ];
  const saved = await createConversation(
    store,
    lesson,
    "gemini-test",
    async () => {
      peak = Math.max(peak, ++running);
      await Bun.sleep(10);
      running--;
      return envelope({ segments: [{ start: 0.25, end: 1.5, text: "Hello." }] });
    },
    clips,
  );
  expect(peak).toBe(4);
  expect(saved.segments.map((s) => s.start)).toEqual([0.25, 0.25, 90.25, 90.25, 180.25, 180.25]);
  expect(saved.segments.find((s) => s.id === "student-180-0")?.end).toBe(181.5);
});

test("利用上限に達したら新しい区間の呼び出しを止め、成功した区間から再開する", async () => {
  const { store, lesson } = fixture();
  if (!lesson.audio) throw new Error("Missing audio");
  lesson.audio.seconds = 210;
  const clips = async () => [0, 90, 180].map((start) => ({ file: "cached", start, seconds: 30 }));
  let calls = 0;
  let limited = true;
  const ask: ConversationAI = async () => {
    calls++;
    if (limited && calls === 1)
      return JSON.stringify({ status: "ERROR", error: "Individual quota reached." });
    await Bun.sleep(10);
    return envelope({ segments: [{ start: 1, end: 2, text: "Hello." }] });
  };
  await expect(createConversation(store, lesson, "gemini-test", ask, clips)).rejects.toThrow("利用上限");
  expect(calls).toBe(4);
  expect(readConversation(store, lesson.id)).toBeUndefined();
  limited = false;
  const saved = await createConversation(store, lesson, "gemini-test", ask, clips);
  expect(saved.segments).toHaveLength(6);
  expect(calls).toBe(7);
});

test("回答を追記して保存し、架空の参照IDを除去し、生成失敗では履歴を壊さない", async () => {
  const { store, lesson } = fixture();
  atomicJson(store.path("analyses", "lesson.conversation.json"), document());
  const ask: ConversationAI = async (request) => {
    expect(request.prompt).toContain('"role":"Teacher"');
    expect(request.prompt).toContain('"question":"どう返す？"');
    expect(request.prompt).not.toContain("credentials");
    return envelope({ ...answer, referenceIds: ["teacher-0", "not-real", "teacher-0"] });
  };
  await answerConversationQuestion(store, lesson, "teacher-0", "どう返す？", "gemini-test", ask);
  const saved = readConversation(store, lesson.id);
  if (!saved) throw new Error("Missing test conversation");
  expect(saved.segments[0]?.questions).toHaveLength(1);
  expect(saved.segments[0]?.questions[0]?.answer.referenceIds).toEqual(["teacher-0"]);
  expect(saved.segments[1]?.questions).toEqual([]);
  await expect(
    answerConversationQuestion(store, lesson, "teacher-0", "もっと短く", "gemini-test", async () => {
      throw new Error("offline");
    }),
  ).rejects.toThrow("offline");
  expect(readConversation(store, lesson.id)).toEqual(saved);
});
