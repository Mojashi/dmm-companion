import { useEffect, useRef, useState } from "react";
import { youglish } from "../timestamps";

type Widget = { fetch(query: string, lang: string, accent?: string): void; close(): void };
declare global {
  interface Window {
    YG?: { Widget: new (elementId: string, options: object) => Widget };
    onYouglishAPIReady?: () => void;
  }
}

let api: Promise<NonNullable<Window["YG"]>> | undefined;
/** Loads YouGlish's widget script once, on the first request for a native example. */
function loadApi(): Promise<NonNullable<Window["YG"]>> {
  api ??= new Promise((resolve, reject) => {
    window.onYouglishAPIReady = () => (window.YG ? resolve(window.YG) : reject(new Error("YouGlish")));
    const script = document.createElement("script");
    script.src = "https://youglish.com/public/emb/widget.js";
    script.async = true;
    script.onerror = () => {
      api = undefined;
      reject(new Error("YouGlishを読み込めませんでした。"));
    };
    document.head.append(script);
  });
  return api;
}

// title | caption | speed
const components = 4 | 8 | 16;
let mounts = 0;

/** Plays YouTube clips where native speakers say the word, inside the card. */
export function NativeExamples({ word, onClose }: { word: string; onClose: () => void }) {
  const container = useRef<HTMLDivElement>(null);
  const widget = useRef<Widget>(undefined);
  const [error, setError] = useState("");
  const [empty, setEmpty] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setEmpty(false);
    void loadApi()
      .then((YG) => {
        if (cancelled || !container.current) return;
        if (!widget.current) {
          // The widget looks its host up by id and replaces it via outerHTML, so give it a node React does not own.
          const host = document.createElement("div");
          host.id = `youglish-${++mounts}`;
          container.current.replaceChildren(host);
        }
        widget.current ??= new YG.Widget(`youglish-${mounts}`, {
          components,
          autoStart: 1,
          events: { onFetchDone: (e: { totalResult: number }) => setEmpty(e.totalResult === 0) },
        });
        widget.current.fetch(word, "english", "us");
      })
      .catch((e: Error) => setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [word]);
  useEffect(() => () => widget.current?.close(), []);
  return (
    <div className="youglish">
      <div className="youglish-head">
        <span>“{word}” — ネイティブの発音</span>
        <button type="button" className="text-button" onClick={onClose}>
          閉じる
        </button>
      </div>
      {error || empty ? (
        <p className="youglish-note">
          {error || "動画が見つかりませんでした。"}{" "}
          <a href={youglish(word)} target="_blank" rel="noreferrer">
            YouGlishで開く ↗
          </a>
        </p>
      ) : null}
      <div ref={container} />
      <p className="youglish-note">
        動画は
        <a href="https://youglish.com" target="_blank" rel="noreferrer">
          YouGlish
        </a>
        経由でYouTubeから再生しています。著作権は各動画の権利者にあり、再利用はできません。
        <a href="https://www.youtube.com/t/terms" target="_blank" rel="noreferrer">
          YouTube利用規約
        </a>
      </p>
    </div>
  );
}
