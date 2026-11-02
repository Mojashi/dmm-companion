import { expect, test } from "bun:test";
import { AiQuotaExceeded, agyResponse, isQuotaError, jsonIn } from "../src/gemini";
import { CommandError } from "../src/process";

test("本文のあとにJSONが付いた回答からJSONを取り出す", () => {
  const prose =
    'Hello.\n\nYes, {sort of} I can hear you.\n{"toolAction":"Completing","transcript":"Hello.\\nYes"}';
  expect(jsonIn(prose)).toEqual({ toolAction: "Completing", transcript: "Hello.\nYes" });
  expect(jsonIn('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  expect(() => jsonIn("no json here")).toThrow("JSON");
  expect(agyResponse(JSON.stringify({ status: "SUCCESS", response: 'text {"a":2}' }))).toEqual({ a: 2 });
});

test("利用上限はJSON応答とCLIエラーの両方を識別する", () => {
  expect(() => agyResponse(JSON.stringify({ status: "ERROR", error: "Individual quota reached." }))).toThrow(
    AiQuotaExceeded,
  );
  expect(isQuotaError(new CommandError("agy", 3, "", "Individual quota reached."))).toBe(true);
  expect(isQuotaError("network issue")).toBe(false);
});
