import { CommandError, command } from "./process";

const settingsGuide = "システム設定 → 通知 → terminal-notifier";

export function notificationDiagnosis(report: string) {
  const major = Number(/^terminal-notifier (\d+)\./m.exec(report)?.[1]);
  if (!(major >= 3))
    throw new Error("Mac通知にはterminal-notifier 3以上が必要です。brew upgrade terminal-notifier");
  const field = (name: string) => new RegExp(`^  ${name} +(.+)$`, "m").exec(report)?.[1]?.trim();
  const authorization = field("authorization");
  const issues: string[] = [];
  if (authorization !== "authorized")
    issues.push(
      `Mac通知が許可されていません（${authorization ?? "不明"}）。${settingsGuide}で「通知を許可」をオンにしてください。初回はdmm auto testで許可を求めます。`,
    );
  if (field("alerts") !== "enabled" || !["banners", "alerts"].includes(field("alert style") ?? ""))
    issues.push(`${settingsGuide}で通知スタイルを「バナー」または「通知パネル」にしてください。`);
  if (field("NotificationCenter") !== "running") issues.push("Macの通知センターに接続できません。");
  if (field("scheduled delivery") === "enabled")
    issues.push(`${settingsGuide}で時刻指定要約を外し、すぐに配信する設定にしてください。`);
  return { report, authorization, issues };
}

export async function diagnoseMacNotifications() {
  if (process.platform !== "darwin") throw new Error("Mac通知はmacOSで利用できます。");
  if (!Bun.which("terminal-notifier"))
    throw new Error("Mac通知にはterminal-notifierが必要です。brew install terminal-notifier");
  let report: string;
  try {
    report = await command(["terminal-notifier", "-diagnose"], { timeout: 15_000 });
  } catch (error) {
    // Version 3 reports denied permission on stdout, and exits with code 3.
    if (!(error instanceof CommandError) || ![1, 3].includes(error.exitCode)) throw error;
    report = error.stdout;
  }
  return notificationDiagnosis(report);
}

export async function requireMacNotifications(): Promise<void> {
  const diagnosis = await diagnoseMacNotifications();
  if (diagnosis.issues.length) throw new Error(diagnosis.issues.join("\n"));
}

export async function sendMacNotification(args: string[], requestPermission = false): Promise<void> {
  const diagnosis = await diagnoseMacNotifications();
  const initialPermission = requestPermission && diagnosis.authorization?.startsWith("not determined");
  if (diagnosis.issues.length && !initialPermission) throw new Error(diagnosis.issues.join("\n"));
  try {
    await command(["terminal-notifier", ...args, "-sound", "default"], {
      timeout: initialPermission ? 90_000 : 15_000,
    });
  } catch (error) {
    if (error instanceof CommandError && error.exitCode === 3)
      throw new Error(`Mac通知が拒否されました。${settingsGuide}で「通知を許可」をオンにしてください。`);
    throw error;
  }
  await requireMacNotifications();
}
