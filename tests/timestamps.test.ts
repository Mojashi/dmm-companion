import { expect, test } from "bun:test";
import { plainTimes, timedSegments, withinRecording, youglish } from "../src/timestamps";

test("本文中の[m:ss]を再生位置として切り出す", () => {
  expect(timedSegments("[0:18]と[1:19]でtalkedが2音節")).toEqual([
    { at: 18 },
    { text: "と" },
    { at: 79 },
    { text: "でtalkedが2音節" },
  ]);
  expect(timedSegments("時刻なし")).toEqual([{ text: "時刻なし" }]);
});
test("区間は[m:ss-m:ss]と[m:ss]〜[m:ss]の両方を読む", () => {
  expect(timedSegments("（[1:27-5:40]）")).toEqual([{ text: "（" }, { at: 87, until: 340 }, { text: "）" }]);
  expect(timedSegments("[1:27]〜[5:40]")).toEqual([{ at: 87, until: 340 }]);
  expect(timedSegments("[0:18]、[1:19]")).toEqual([{ at: 18 }, { text: "、" }, { at: 79 }]);
  expect(timedSegments("[5:40]〜[1:27]")).toEqual([{ at: 340 }]);
});
test("録音外の時刻は再生リンクにせず、メール向けには括弧を外す", () => {
  expect(withinRecording("[0:18]と[30:30]", 1500)).toBe("[0:18]と30:30");
  expect(withinRecording("[1:27]〜[5:40]", 1500)).toBe("[1:27-5:40]");
  expect(withinRecording("[24:00]〜[26:00]", 1500)).toBe("[24:00]");
  expect(plainTimes("[4:37]の発話")).toBe("4:37の発話");
  expect(plainTimes("[1:27-5:40]")).toBe("1:27–5:40");
});
test("YouGlishのリンクは単語を小文字・URLエンコードする", () => {
  expect(youglish("Colleagues")).toBe("https://youglish.com/pronounce/colleagues/english/us");
  expect(youglish(" climb up ")).toBe("https://youglish.com/pronounce/climb%20up/english/us");
});
