import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  answerConversationQuestion,
  type Conversation,
  type ConversationAI,
  canReuseAnswer,
  createConversation,
  parseUtterances,
  questionContext,
  readConversation,
} from "../src/conversation";
import type { Lesson } from "../src/domain";
import { CommandError } from "../src/process";
import { atomicJson, Store } from "../src/store";
import { ensureSpeech } from "../src/transcription";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const envelope = (response: unknown) => JSON.stringify({ status: "SUCCESS", response });
const testClips = async (store: Store, lesson: Lesson) => [
  { file: store.path("work", lesson.id, "student.mp3"), start: 0, seconds: 30 },
];
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
  expect(readConversation(store, lesson.id)?.pendingRoles).toEqual(["Teacher"]);
  await createConversation(store, lesson, "gemini-test", ask, testClips);
  expect(teacherCalls).toBe(2);
  expect(studentCalls).toBe(1);
});

test("質問には選択した話者・前後の会話・同じ発言の直近3件だけを渡す", () => {
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
  expect(context.previousQuestions.map((q) => q.question)).toEqual([5, 6, 7].map((i) => `question ${i}`));
  expect(JSON.stringify(context)).not.toContain("Other segment private question");
  expect(() => questionContext(conversation, "Tutor", "missing", "Meaning?")).toThrow("発言");
  for (const question of [" ", "a".repeat(2001)])
    expect(() => questionContext(conversation, "Tutor", selected.id, question)).toThrow("2,000");
});

test("区間の時刻を戻し、複数の音声を話者ごとに1回で依頼する", async () => {
  const { store, lesson } = fixture();
  if (!lesson.audio) throw new Error("Missing audio");
  lesson.audio.seconds = 200;
  let calls = 0;
  const clips = async () =>
    [0, 90, 180].map((start) => ({
      file: store.path("work", lesson.id, "student.mp3"),
      start,
      seconds: Math.min(90, 200 - start),
    }));
  const saved = await createConversation(
    store,
    lesson,
    "gemini-test",
    async (request) => {
      calls++;
      const inputs = JSON.parse(request.prompt.split("\n").at(-1) ?? "[]") as { start: number }[];
      return envelope({
        clips: inputs.map(({ start }) => ({ start, segments: [{ start: 0.25, end: 1.5, text: "Hello." }] })),
      });
    },
    clips,
  );
  expect(calls).toBe(2);
  expect(saved.segments.map((s) => s.start)).toEqual([0.25, 0.25, 90.25, 90.25, 180.25, 180.25]);
  expect(saved.segments.find((s) => s.id === "student-180-0")?.end).toBe(181.5);
});

test("利用上限のJSON応答では残りの話者に追加依頼しない", async () => {
  const { store, lesson } = fixture();
  let calls = 0;
  await expect(
    createConversation(
      store,
      lesson,
      "gemini-test",
      async () => {
        calls++;
        return JSON.stringify({ status: "ERROR", error: "Individual quota reached." });
      },
      testClips,
    ),
  ).rejects.toThrow("利用上限");
  expect(calls).toBe(1);
});

test("不足した区間の再試行で、保存済みの区間をもう一度依頼しない", async () => {
  const { store, lesson } = fixture();
  if (!lesson.audio) throw new Error("Missing audio");
  lesson.audio.seconds = 210;
  const clips = async () =>
    [0, 90, 180].map((start) => ({ file: store.path("work", lesson.id, "student.mp3"), start, seconds: 30 }));
  const requested: number[][] = [];
  const ask: ConversationAI = async (request) => {
    const inputs = JSON.parse(request.prompt.split("\n").at(-1) ?? "[]") as { start: number }[];
    requested.push(inputs.map((i) => i.start));
    const segments = [{ start: 1, end: 2, text: "Hello." }];
    if (inputs.length === 1) return envelope({ segments });
    return envelope({
      clips: (requested.length === 1 ? inputs.slice(0, 2) : inputs).map(({ start }) => ({ start, segments })),
    });
  };
  await expect(createConversation(store, lesson, "gemini-test", ask, clips)).rejects.toThrow("未完了");
  const saved = await createConversation(store, lesson, "gemini-test", ask, clips);
  expect(saved.segments).toHaveLength(6);
  expect(requested).toEqual([[0, 90, 180], [180], [0, 90, 180]]);
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

test("既存の時刻なし本文はAIなしで表示し、講師だけを追加して質問履歴を保持する", async () => {
  const { store, lesson } = fixture();
  const legacy = {
    model: "gemini-old",
    transcribedAt: "2026-11-01",
    transcript: "I like tennis.\nI play on Sundays.",
  };
  atomicJson(store.path("analyses", "lesson.learner.json"), legacy);
  const before = readFileSync(store.path("analyses", "lesson.learner.json"), "utf8");
  const initial = readConversation(store, lesson.id);
  expect(initial?.segments).toHaveLength(2);
  expect(initial?.segments.every((s) => s.start === null && s.role === "Student")).toBe(true);
  expect(initial?.pendingRoles).toEqual(["Teacher"]);
  const id = initial?.segments[0]?.id;
  if (!id) throw new Error("Missing saved utterance");
  await answerConversationQuestion(store, lesson, id, "どう言い換える？", "gemini-test", async () =>
    envelope(answer),
  );
  let calls = 0;
  const saved = await createConversation(
    store,
    lesson,
    "gemini-test",
    async (request) => {
      calls++;
      expect(request.schema.name).toBe("conversation-teacher");
      return envelope({ segments: [{ start: 1, end: 2, text: "What sport do you like?" }] });
    },
    testClips,
  );
  expect(calls).toBe(1);
  expect(saved.segments.find((s) => s.id === id)?.questions).toHaveLength(1);
  expect(saved.segments.filter((s) => s.role === "Student").every((s) => s.start === null)).toBe(true);
  expect(readFileSync(store.path("analyses", "lesson.learner.json"), "utf8")).toBe(before);
});

test("発話指標で作った共通の文字起こしは会話作成でも再利用する", async () => {
  const { store, lesson } = fixture();
  let calls = 0;
  const ask: ConversationAI = async () => {
    calls++;
    return envelope({ segments: [{ start: 1, end: 2, text: "Hello there." }] });
  };
  const first = await ensureSpeech(store, lesson, "Student", "gemini-test", ask, testClips);
  expect(first.transcript).toBe("Hello there.");
  expect(calls).toBe(1);
  await createConversation(store, lesson, "gemini-test", ask, testClips);
  expect(calls).toBe(2);
  await ensureSpeech(store, lesson, "Student", "gemini-other", ask, testClips);
  expect(calls).toBe(2);
});

test("質問は近傍の最大6000文字に絞り、全文参照は明示した場合だけ送る", () => {
  const c = document();
  c.segments = Array.from({ length: 400 }, (_, i) => ({
    id: `s-${i}`,
    role: i % 2 ? "Student" : "Teacher",
    start: i * 2,
    end: i * 2 + 1,
    text: `sentence ${i} ${"word ".repeat(100)}`,
    questions: [],
  }));
  const nearby = questionContext(c, "Tutor", "s-200", "どういう意味？");
  expect(nearby.dialogue.some((s) => s.id === "s-200")).toBe(true);
  expect(nearby.dialogue.reduce((sum, s) => sum + s.text.length, 0)).toBeLessThanOrEqual(6000);
  expect(nearby.omittedSegments).toBeGreaterThan(380);
  const all = questionContext(c, "Tutor", "s-200", "全体の話題は？", true);
  expect(all.dialogue).toHaveLength(400);
  expect(all.omittedSegments).toBe(0);
});

test("直前と同じ質問は再利用し、追加質問や参照範囲が変われば再利用しない", async () => {
  const { store, lesson } = fixture();
  atomicJson(store.path("analyses", "lesson.conversation.json"), document());
  let calls = 0;
  const ask: ConversationAI = async () => {
    calls++;
    return envelope(answer);
  };
  await answerConversationQuestion(store, lesson, "teacher-0", "意味は？", "gemini-test", ask);
  await answerConversationQuestion(store, lesson, "teacher-0", " 意味は？ ", "gemini-test", ask);
  expect(calls).toBe(1);
  expect(readConversation(store, lesson.id)?.segments[0]?.questions).toHaveLength(1);
  const saved = readConversation(store, lesson.id);
  if (!saved) throw new Error("Missing conversation");
  expect(canReuseAnswer(saved, "teacher-0", "意味は？")).toBe(true);
  expect(canReuseAnswer(saved, "teacher-0", "意味は？", true)).toBe(false);
  await answerConversationQuestion(store, lesson, "teacher-0", "もっと短く", "gemini-test", ask);
  await answerConversationQuestion(store, lesson, "teacher-0", "意味は？", "gemini-test", ask);
  expect(calls).toBe(3);
});

test("CLIの非ゼロ終了による利用上限でも残りの依頼を中止する", async () => {
  const { store, lesson } = fixture();
  let calls = 0;
  await expect(
    createConversation(
      store,
      lesson,
      "gemini-test",
      async () => {
        calls++;
        throw new CommandError("agy", 3, "", "Individual quota reached. RESOURCE_EXHAUSTED");
      },
      testClips,
    ),
  ).rejects.toThrow("利用上限");
  expect(calls).toBe(1);
});

test("一部の時刻が不正でも他の正常な区間は保存して再利用する", async () => {
  const { store, lesson } = fixture();
  if (!lesson.audio) throw new Error("Missing audio");
  lesson.audio.seconds = 210;
  const clips = async () =>
    [0, 90, 180].map((start) => ({ file: store.path("work", lesson.id, "student.mp3"), start, seconds: 30 }));
  const requested: number[][] = [];
  const ask: ConversationAI = async (request) => {
    const inputs = JSON.parse(request.prompt.split("\n").at(-1) ?? "[]") as { start: number }[];
    requested.push(inputs.map((i) => i.start));
    const segment = { start: 1, end: 2, text: "Hello." };
    if (inputs.length === 1) return envelope({ segments: [segment] });
    return envelope({
      clips: inputs.map(({ start }) => ({
        start,
        segments: [{ ...segment, end: requested.length === 1 && start === 90 ? 40 : 2 }],
      })),
    });
  };
  await expect(createConversation(store, lesson, "gemini-test", ask, clips)).rejects.toThrow("時刻");
  await createConversation(store, lesson, "gemini-test", ask, clips);
  expect(requested).toEqual([[0, 90, 180], [90], [0, 90, 180]]);
});

test("モデルの指定が変わっても成功済みの区間を再依頼しない", async () => {
  const { store, lesson } = fixture();
  atomicJson(store.path("analyses", "lesson.conversation-student-0.json"), {
    origin: lesson.audio?.origin,
    seconds: 30,
    model: "gemini-old",
    response: envelope({ segments: [{ start: 1, end: 2, text: "Hello." }] }),
  });
  const saved = await ensureSpeech(
    store,
    lesson,
    "Student",
    "gemini-new",
    async () => {
      throw new Error("Unexpected AI call");
    },
    testClips,
  );
  expect(saved.model).toBe("gemini-old");
  expect(saved.transcript).toBe("Hello.");
});
