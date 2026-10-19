import { mkdirSync } from "node:fs";
import { z } from "zod";
import { command } from "./process";
import { atomicJson } from "./store";

/** Unwraps agy's --output-format json envelope into the model's JSON answer. */
export function agyResponse(stdout: string): unknown {
  const envelope = JSON.parse(stdout) as { status?: string; response?: unknown };
  if (envelope.status !== "SUCCESS")
    throw new Error("agyの音声分析が完了しませんでした。analysesの実行ログを確認してください。");
  return typeof envelope.response === "string" ? jsonIn(envelope.response) : envelope.response;
}

/**
 * The JSON answer inside a model's text. Flash sometimes writes the answer as prose first and then the
 * schema object, or wraps it in a code fence, so take the outermost object that parses.
 */
export function jsonIn(text: string): unknown {
  const body = text
    .trim()
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(body);
  } catch {
    const end = body.lastIndexOf("}");
    for (let start = body.indexOf("{"); start !== -1 && start < end; start = body.indexOf("{", start + 1)) {
      try {
        return JSON.parse(body.slice(start, end + 1));
      } catch {
        // not the object's opening brace; try the next one
      }
    }
    throw new Error("Geminiの回答にJSONが含まれていません。analysesの実行ログを確認してください。");
  }
}

/**
 * Asks Gemini (through agy) to answer in the given schema. The raw run is kept at `log` so a failed
 * or surprising answer can be inspected; `workDir` is agy's working directory.
 */
export async function askGemini(request: {
  prompt: string;
  model: string;
  schema: { name: string; shape: z.ZodType };
  workDir: string;
  log: string;
}): Promise<string> {
  if (!request.model.startsWith("gemini-")) throw new Error("音声分析にはGeminiモデルを指定してください。");
  mkdirSync(request.workDir, { recursive: true, mode: 0o700 });
  const schemaPath = `${request.workDir}/${request.schema.name}.schema.json`;
  atomicJson(schemaPath, z.toJSONSchema(request.schema.shape));
  return command(
    [
      "agy",
      "-p",
      request.prompt,
      "--model",
      request.model,
      "--output-format",
      "json",
      "--json-schema",
      schemaPath,
      "--print-timeout",
      "15m",
    ],
    { cwd: request.workDir, timeout: 16 * 60_000, log: request.log },
  );
}
