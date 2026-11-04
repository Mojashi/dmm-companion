import { useEffect, useRef, useState } from "react";
import type { ConversationSnapshot } from "../conversation";
import { clock } from "../timestamps";

type Request = <T>(path: string, options?: RequestInit) => Promise<T>;

export function LessonConversation({
  lessonId,
  teacher,
  available,
  busy,
  request,
  play,
}: {
  lessonId: string;
  teacher: string;
  available: boolean;
  busy: boolean;
  request: Request;
  play: (at: number, until?: number) => void;
}) {
  const [snapshot, setSnapshot] = useState<ConversationSnapshot>();
  const [failure, setFailure] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [filter, setFilter] = useState("all");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [wholeLesson, setWholeLesson] = useState(false);
  const [submitted, setSubmitted] = useState<{ segmentId: string; question: string; count: number }>();
  const sendingRef = useRef(false);
  const panel = useRef<HTMLElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const path = `/api/lessons/${lessonId}/conversation`;
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const next = await request<ConversationSnapshot>(path);
        if (alive) {
          setSnapshot(next);
          setFailure("");
        }
      } catch (error) {
        if (alive) setFailure(error instanceof Error ? error.message : String(error));
      }
    }
    void load();
    const timer = setInterval(() => void load(), 2500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [path, request]);
  useEffect(() => {
    if (!submitted || !snapshot?.conversation) return;
    const segment = snapshot.conversation.segments.find((s) => s.id === submitted.segmentId);
    if (
      !segment?.questions.slice(submitted.count).some((entry) => entry.question === submitted.question.trim())
    )
      return;
    setDrafts((current) =>
      current[submitted.segmentId] === submitted.question
        ? { ...current, [submitted.segmentId]: "" }
        : current,
    );
    setSubmitted(undefined);
  }, [snapshot, submitted]);
  const conversation = snapshot?.conversation;
  const hasUntimed = conversation?.segments.some((s) => s.start === null);
  const selected = conversation?.segments.find((s) => s.id === selectedId);
  const active = sending || Boolean(snapshot?.task?.busy);
  const disabled = busy || active;
  const draft = selected ? (drafts[selected.id] ?? "") : "";
  const taskError =
    snapshot?.task?.error && (!snapshot.task.segmentId || snapshot.task.segmentId === selectedId)
      ? snapshot.task.error
      : "";
  async function post(target: string, body: unknown) {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setFailure("");
    try {
      await request(target, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setSnapshot(await request<ConversationSnapshot>(path));
      return true;
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }
  function select(id: string) {
    setSelectedId(id);
    setWholeLesson(false);
    setFailure("");
    requestAnimationFrame(() => {
      document.getElementById(`conversation-${lessonId}-${id}`)?.scrollIntoView({ block: "nearest" });
      panel.current?.scrollIntoView({ block: "nearest" });
      input.current?.focus({ preventScroll: true });
    });
  }
  async function ask() {
    if (!selected || !draft.trim() || disabled || sendingRef.current) return;
    setSubmitted({ segmentId: selected.id, question: draft, count: selected.questions.length });
    const id = selected.id;
    const result = await post(`${path}/${id}/questions`, { question: draft, wholeLesson });
    if (result) setWholeLesson(false);
  }
  return (
    <section className="conversation" aria-label="会話と質問">
      {(failure || taskError) && (
        <p className="conversation-error" role="alert">
          {failure || taskError}
        </p>
      )}
      {!snapshot && !failure ? (
        <output className="conversation-loading" aria-label="会話を読み込み中">
          <span />
          <span />
          <span />
        </output>
      ) : !conversation ? (
        <div className="conversation-empty">
          <h3>会話ログ</h3>
          <p>
            {available
              ? "保存済みの文字起こしを利用し、不足分だけ作成します。"
              : "録音のあるレッスンで利用できます。"}
          </p>
          {available && (
            <button
              type="button"
              className="primary-button"
              disabled={disabled || !snapshot}
              onClick={() => void post(path, {})}
            >
              {active ? "会話ログを作成中…" : "会話ログを作成"}
            </button>
          )}
          {active && <output>この画面を離れても作成を続けます。</output>}
        </div>
      ) : (
        <>
          <div className="conversation-heading">
            <span className="eyebrow">LESSON DIALOGUE</span>
            <span>{conversation.segments.length} 発言</span>
          </div>
          {(conversation.pendingRoles?.length ?? 0) > 0 && (
            <div className="conversation-addition">
              <button
                type="button"
                className="outline-button"
                disabled={disabled || !available}
                onClick={() => void post(path, {})}
              >
                {active ? "不足分を作成中…" : "不足分の会話を追加"}
              </button>
              <span>追加分のみAIを利用します</span>
            </div>
          )}
          {hasUntimed && (
            <details className="conversation-sources">
              <summary>時刻のない文字起こしを含みます</summary>
              <p>
                保存済みの本文を再利用しています。時刻のない発話は本文順に表示し、再生位置は推定しません。
              </p>
            </details>
          )}
          <fieldset className="conversation-filters" aria-label="会話の表示">
            {[
              ["all", "すべて"],
              ["Student", "あなた"],
              ["Teacher", "先生"],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={filter === value}
                onClick={() => setFilter(value ?? "all")}
              >
                {label}
              </button>
            ))}
          </fieldset>
          <div className="conversation-body">
            <ol className="conversation-timeline" aria-label={hasUntimed ? "保存済みの会話" : "時系列の会話"}>
              {conversation.segments
                .filter((s) => filter === "all" || s.role === filter)
                .map((s) => (
                  <li
                    key={s.id}
                    id={`conversation-${lessonId}-${s.id}`}
                    className={`conversation-turn ${s.role.toLowerCase()} ${selectedId === s.id ? "selected" : ""}`}
                  >
                    <div className="conversation-turn-meta">
                      <span>{s.role === "Student" ? "あなた" : teacher}</span>
                      {s.start !== null && (
                        <button
                          type="button"
                          className="timestamp"
                          aria-label={`${clock(s.start)}の音声を再生`}
                          onClick={() => {
                            if (s.start !== null) play(s.start, s.end ?? undefined);
                          }}
                        >
                          ▷ {clock(s.start)}
                        </button>
                      )}
                    </div>
                    <button
                      type="button"
                      className="conversation-utterance"
                      aria-pressed={selectedId === s.id}
                      onClick={() => select(s.id)}
                    >
                      {s.text}
                    </button>
                    {s.questions.length > 0 && (
                      <span className="conversation-question-count">質問 {s.questions.length}件</span>
                    )}
                  </li>
                ))}
            </ol>
            <section className="conversation-question" ref={panel} aria-label="選んだ発言への質問">
              <h3>この発言について聞く</h3>
              {selected ? (
                <>
                  <blockquote>
                    <span>
                      {selected.role === "Student" ? "あなた" : teacher}
                      {selected.start !== null && ` · ${clock(selected.start)}`}
                    </span>
                    <p>{selected.text}</p>
                  </blockquote>
                  <div className="conversation-answers" aria-live="polite">
                    {selected.questions.map((entry) => (
                      <article key={entry.id}>
                        <h4>{entry.question}</h4>
                        <p>{entry.answer.text}</p>
                        {entry.answer.examples.map((example, i) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: examples are saved in a fixed order
                          <div className="conversation-example" key={i}>
                            <strong>{example.english}</strong>
                            <span>{example.meaning}</span>
                          </div>
                        ))}
                        {entry.answer.referenceIds.length > 0 && (
                          <div className="conversation-references">
                            <span>関連する発言</span>
                            {entry.answer.referenceIds.map((id) => {
                              const reference = conversation.segments.find((s) => s.id === id);
                              return (
                                reference && (
                                  <button
                                    type="button"
                                    key={id}
                                    className="timestamp"
                                    onClick={() => {
                                      setFilter("all");
                                      select(id);
                                    }}
                                  >
                                    {reference.start !== null ? `${clock(reference.start)} ` : ""}
                                    {reference.role === "Student" ? "あなた" : teacher}
                                  </button>
                                )
                              );
                            })}
                          </div>
                        )}
                      </article>
                    ))}
                    {snapshot?.task?.busy && snapshot.task.segmentId === selected.id && (
                      <output>回答を作成中…</output>
                    )}
                  </div>
                  <fieldset className="conversation-prompts" aria-label="質問の例">
                    {["どういう意味？", "どう返せばよかった？", "文法を説明して"].map((text) => (
                      <button
                        type="button"
                        key={text}
                        disabled={disabled}
                        onClick={() => {
                          setDrafts((current) => ({ ...current, [selected.id]: text }));
                          input.current?.focus();
                        }}
                      >
                        {text}
                      </button>
                    ))}
                  </fieldset>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void ask();
                    }}
                  >
                    <label htmlFor={`conversation-question-${lessonId}`}>質問</label>
                    <textarea
                      id={`conversation-question-${lessonId}`}
                      ref={input}
                      value={draft}
                      maxLength={2000}
                      rows={3}
                      placeholder="この発言の意味や返し方を聞く"
                      onChange={(event) => {
                        const text = event.currentTarget.value;
                        setDrafts((current) => ({ ...current, [selected.id]: text }));
                      }}
                      onKeyDown={(event) => {
                        if (
                          event.key === "Enter" &&
                          (event.metaKey || event.ctrlKey) &&
                          !event.nativeEvent.isComposing
                        ) {
                          event.preventDefault();
                          void ask();
                        }
                      }}
                    />
                    <label className="conversation-scope">
                      <input
                        type="checkbox"
                        checked={wholeLesson}
                        onChange={(event) => setWholeLesson(event.currentTarget.checked)}
                      />
                      今回だけレッスン全体を参照（送信量が増えます）
                    </label>
                    <button className="primary-button" type="submit" disabled={disabled || !draft.trim()}>
                      質問する ↗
                    </button>
                  </form>
                </>
              ) : (
                <p className="conversation-prompt">気になった発言を選んでください。</p>
              )}
            </section>
          </div>
        </>
      )}
    </section>
  );
}
