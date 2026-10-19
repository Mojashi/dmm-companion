import { expect, test } from "bun:test";
import { agyResponse, jsonIn } from "../src/gemini";

test("本文のあとにJSONが付いた回答からJSONを取り出す", () => {
  const prose =
    'Hello.\n\nYes, {sort of} I can hear you.\n{"toolAction":"Completing","transcript":"Hello.\\nYes"}';
  expect(jsonIn(prose)).toEqual({ toolAction: "Completing", transcript: "Hello.\nYes" });
  expect(jsonIn('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  expect(() => jsonIn("no json here")).toThrow("JSON");
  expect(agyResponse(JSON.stringify({ status: "SUCCESS", response: 'text {"a":2}' }))).toEqual({ a: 2 });
});
