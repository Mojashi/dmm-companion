/**
 * Calls Gemini on Vertex AI directly with audio attached inline: the same model as agy, for experiments
 * that would otherwise exhaust agy's quota. Billed to the given GCP project; auth comes from gcloud.
 */
import type { z } from "zod";

export type Part = { text: string } | { audio: string };

let token: { value: string; until: number } | undefined;
async function accessToken(): Promise<string> {
  if (token && Date.now() < token.until) return token.value;
  const child = Bun.spawn(["gcloud", "auth", "print-access-token"], { stdout: "pipe", stderr: "pipe" });
  const [value, code] = [(await new Response(child.stdout).text()).trim(), await child.exited];
  if (code !== 0 || !value) throw new Error("gcloud auth print-access-token failed; run gcloud auth login");
  token = { value, until: Date.now() + 30 * 60_000 };
  return value;
}

export async function askVertex<T>(request: {
  project: string;
  model: string;
  parts: Part[];
  schema: z.ZodType<T>;
  jsonSchema: unknown;
}): Promise<T> {
  const parts = await Promise.all(
    request.parts.map(async (p) =>
      "text" in p
        ? { text: p.text }
        : {
            inlineData: {
              mimeType: "audio/wav",
              data: Buffer.from(await Bun.file(p.audio).arrayBuffer()).toString("base64"),
            },
          },
    ),
  );
  const url = `https://aiplatform.googleapis.com/v1/projects/${request.project}/locations/global/publishers/google/models/${request.model}:generateContent`;
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: {
          thinkingConfig: { thinkingLevel: "HIGH" },
          responseMimeType: "application/json",
          responseJsonSchema: request.jsonSchema,
        },
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if ((response.status === 429 || response.status >= 500) && attempt < 4) {
      await Bun.sleep(2 ** attempt * 5_000);
      continue;
    }
    const body = (await response.json()) as {
      error?: { message: string };
      candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
    };
    if (!response.ok || body.error)
      throw new Error(`Vertex ${response.status}: ${body.error?.message ?? ""}`);
    const text = body.candidates?.[0]?.content?.parts?.filter((p) => !p.thought && p.text).at(-1)?.text;
    if (!text) throw new Error("Vertex returned no text");
    return request.schema.parse(JSON.parse(text));
  }
}
