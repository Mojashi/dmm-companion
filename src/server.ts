import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AutomaticReviews } from "./automation";
import type { Companion } from "./coach";
import { safeError } from "./domain";
import index from "./web/index.html";

export function serve(companion: Companion, port: number, automatic?: AutomaticReviews) {
  const token = randomBytes(24).toString("hex");
  const store = companion.store;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 120,
    maxRequestBodySize: 512 * 1024 * 1024,
    routes: { "/": index },
    async fetch(request) {
      const url = new URL(request.url);
      const host = request.headers.get("host");
      if (host !== `127.0.0.1:${server.port}`) return new Response("Forbidden", { status: 403 });
      const supplied = Buffer.from(
        request.headers.get("x-companion-token") ?? url.searchParams.get("token") ?? "",
      );
      if (supplied.length !== token.length || !timingSafeEqual(supplied, Buffer.from(token)))
        return new Response("Unauthorized", { status: 401 });
      const origin = request.headers.get("origin");
      if (origin && origin !== server.url.origin) return new Response("Forbidden", { status: 403 });
      try {
        if (url.pathname === "/api/automation/run" && request.method === "POST" && automatic) {
          if (!automatic.snapshot().config?.enabled)
            return Response.json({ error: "先にdmm auto enableを実行してください。" }, { status: 409 });
          if (companion.status.busy || automatic.snapshot().running)
            return Response.json({ error: "現在の処理が終わってから実行してください。" }, { status: 409 });
          void automatic.run(true);
          return Response.json({ ok: true }, { status: 202 });
        }
        if (url.pathname === "/api/library" && request.method === "GET")
          return Response.json(
            {
              ...store.library,
              lessons: store.library.lessons.map((l) => ({
                ...l,
                tracks: l.tracks.map((t) => ({
                  id: t.id,
                  role: t.role,
                  start: t.start,
                  chunks: t.chunks.length,
                })),
                audio: l.audio ? { seconds: l.audio.seconds } : undefined,
              })),
              status: companion.status,
              model: companion.model,
              dataDir: store.root,
              canSync: Boolean(store.credentials().dmmCookie),
              automation: automatic?.snapshot(),
            },
            { headers: { "Cache-Control": "no-store" } },
          );
        if (url.pathname === "/api/setup" && request.method === "POST") {
          if (companion.status.busy)
            return Response.json({ error: "処理が終わってからログインしてください。" }, { status: 409 });
          const identity = (await request.json()) as { email?: unknown; password?: unknown };
          if (
            typeof identity.email !== "string" ||
            typeof identity.password !== "string" ||
            !identity.email ||
            !identity.password
          )
            return Response.json({ error: "ターミナルで dmm setup を実行してください。" }, { status: 400 });
          void companion.setup({ email: identity.email, password: identity.password });
          return Response.json({ ok: true }, { status: 202 });
        }
        if (url.pathname === "/api/sync" && request.method === "POST") {
          if (companion.status.busy)
            return Response.json({ error: "現在の処理が終わってから同期してください。" }, { status: 409 });
          const body = (await request.json()) as { full?: unknown };
          void companion.sync(body.full === true);
          return Response.json({ ok: true }, { status: 202 });
        }
        if (url.pathname === "/api/analyze" && request.method === "POST") {
          const body: unknown = await request.json();
          if (
            typeof body !== "object" ||
            body === null ||
            !("ids" in body) ||
            !Array.isArray(body.ids) ||
            !body.ids.every((id) => typeof id === "string")
          )
            return Response.json({ error: "idsが不正です。" }, { status: 400 });
          return Response.json({ queued: companion.enqueue(body.ids) }, { status: 202 });
        }
        const review = /^\/api\/lessons\/([\w-]+)\/review$/.exec(url.pathname);
        if (review?.[1] && request.method === "POST") {
          const lesson = store.lesson(review[1]);
          const body = (await request.json()) as { index?: number; reviewed?: boolean };
          if (
            !Number.isInteger(body.index) ||
            body.index === undefined ||
            body.index < 0 ||
            body.index >= (lesson.feedback?.expressions.length ?? 0) ||
            typeof body.reviewed !== "boolean"
          )
            return Response.json({ error: "復習項目が不正です。" }, { status: 400 });
          lesson.reviewed = body.reviewed
            ? [...new Set([...lesson.reviewed, body.index])]
            : lesson.reviewed.filter((i) => i !== body.index);
          store.save();
          return Response.json({ ok: true });
        }
        const audio = /^\/api\/lessons\/([\w-]+)\/audio$/.exec(url.pathname);
        if (audio?.[1] && request.method === "GET") {
          const lesson = store.lesson(audio[1]);
          if (!lesson.audio) return new Response("Audio not ready", { status: 404 });
          const file = Bun.file(store.path(lesson.audio.file));
          const range = request.headers.get("range");
          const headers = {
            "Content-Type": "audio/mpeg",
            "Accept-Ranges": "bytes",
            "Cache-Control": "private, no-store",
          };
          if (range) {
            const match = /^bytes=(\d+)-(\d*)$/.exec(range);
            if (!match)
              return new Response(null, {
                status: 416,
                headers: { "Content-Range": `bytes */${file.size}` },
              });
            const start = Number(match[1]);
            const end = match[2] ? Math.min(Number(match[2]), file.size - 1) : file.size - 1;
            if (start > end || start >= file.size)
              return new Response(null, {
                status: 416,
                headers: { "Content-Range": `bytes */${file.size}` },
              });
            return new Response(file.slice(start, end + 1), {
              status: 206,
              headers: {
                ...headers,
                "Content-Range": `bytes ${start}-${end}/${file.size}`,
                "Content-Length": String(end - start + 1),
              },
            });
          }
          return new Response(file, { headers });
        }
        if (url.pathname === "/api/export" && request.method === "GET") {
          return Response.json(
            {
              exportedAt: new Date().toISOString(),
              lessons: store.library.lessons.map((l) => ({
                id: l.id,
                date: l.date,
                teacher: l.teacher,
                feedback: l.feedback,
                reviewed: l.reviewed,
              })),
            },
            {
              headers: {
                "Content-Disposition": 'attachment; filename="dmm-review.json"',
                "Cache-Control": "no-store",
              },
            },
          );
        }
        return new Response("Not found", { status: 404 });
      } catch (error) {
        return Response.json({ error: safeError(error) }, { status: 400 });
      }
    },
  });
  // A new launch must not reuse an HTML shell that points at a previous binary's assets.
  return { server, url: `${server.url}?session=${randomBytes(8).toString("hex")}#${token}` };
}
