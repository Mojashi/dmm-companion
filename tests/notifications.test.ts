import { expect, test } from "bun:test";
import { notificationDiagnosis } from "../src/notifications";
import { CommandError, command } from "../src/process";

const report = `terminal-notifier 3.1.0
  NotificationCenter  running
  authorization       authorized
  alerts              enabled
  alert style         banners
  notification centre enabled
  scheduled delivery  not supported
`;

test("通知の受け付けと表示許可を分けて診断する", () => {
  expect(notificationDiagnosis(report).issues).toEqual([]);
  expect(notificationDiagnosis(report.replace("authorized", "denied")).issues.join()).toContain("通知を許可");
  expect(notificationDiagnosis(report.replace("authorized", "provisional")).issues).not.toHaveLength(0);
  expect(notificationDiagnosis(report.replace("banners", "none")).issues.join()).toContain("通知スタイル");
  expect(notificationDiagnosis(report.replace("not supported", "enabled")).issues.join()).toContain(
    "時刻指定要約",
  );
  expect(notificationDiagnosis(report.replace("running", "NOT RUNNING")).issues.join()).toContain(
    "接続できません",
  );
  expect(() => notificationDiagnosis("terminal-notifier 2.0.0")).toThrow("brew upgrade");
  expect(() => notificationDiagnosis("")).toThrow();
});

test("診断が拒否を返してもstdoutにある理由を読み取れ、通常のエラーにはstdoutを露出しない", async () => {
  let failure: unknown;
  try {
    await command(["/bin/sh", "-c", "printf 'authorization denied'; printf 'failed' >&2; exit 3"]);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(CommandError);
  if (!(failure instanceof CommandError)) throw new Error("CommandErrorが必要です。");
  expect(failure.exitCode).toBe(3);
  expect(failure.stdout).toBe("authorization denied");
  expect(failure.message).not.toContain("authorization denied");
});
