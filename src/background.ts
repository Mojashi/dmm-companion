import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type AutomationConfig, automationConfigSchema, readAutomationConfig } from "./automation";
import { readEmailSettings } from "./email";
import { requireMacNotifications } from "./notifications";
import { command } from "./process";
import { atomicJson, hash } from "./store";

export type BackgroundOptions = {
  root: string;
  binary: string;
  model: string;
  transcriptionModel: string;
  port: number;
  path: string;
};
const xml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
export const serviceLabel = (root: string) => `com.dmm-companion.auto.${hash(resolve(root)).slice(0, 12)}`;

export function launchAgent(options: BackgroundOptions): string {
  const args = [
    options.binary,
    "background",
    "--no-open",
    "--data-dir",
    options.root,
    "--model",
    options.model,
    "--transcribe-model",
    options.transcriptionModel,
    "--port",
    String(options.port),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${serviceLabel(options.root)}</string>
<key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(options.root)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(options.path)}</string></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>30</integer>
<key>LimitLoadToSessionType</key><string>Aqua</string>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(join(options.root, "logs", "background.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(options.root, "logs", "background-error.log"))}</string>
</dict></plist>\n`;
}

function serviceAddress(root: string) {
  if (process.platform !== "darwin" || !process.getuid)
    throw new Error("自動起動の登録はmacOSで利用できます。");
  const label = serviceLabel(root);
  return {
    target: `gui/${process.getuid()}/${label}`,
    domain: `gui/${process.getuid()}`,
    plist: join(homedir(), "Library", "LaunchAgents", `${label}.plist`),
  };
}

async function serviceIsLoaded(target: string): Promise<boolean> {
  const child = Bun.spawn(["/bin/launchctl", "print", target], { stdout: "ignore", stderr: "ignore" });
  return (await child.exited) === 0;
}

/** launchctl bootout returns before the service is gone; bootstrapping too early fails with error 5. */
async function unload(target: string): Promise<void> {
  if (!(await serviceIsLoaded(target))) return;
  await command(["/bin/launchctl", "bootout", target]);
  for (let waited = 0; await serviceIsLoaded(target); waited += 250) {
    if (waited >= 15_000)
      throw new Error("自動実行の停止を確認できませんでした。少し待って再実行してください。");
    await Bun.sleep(250);
  }
}

export async function enableAutomaticReviews(
  options: Omit<BackgroundOptions, "path">,
  changes: { since?: string; intervalMinutes?: number } = {},
): Promise<AutomationConfig> {
  const address = serviceAddress(options.root);
  for (const tool of ["agy", "ffmpeg", "ffprobe", "terminal-notifier"])
    if (!Bun.which(tool)) throw new Error(`${tool}が必要です。インストールしてから有効にしてください。`);
  if (!existsSync(join(options.root, "credentials.json")))
    throw new Error("先にdmm setupを実行してください。");
  if (!process.env.PATH) throw new Error("自動実行用のPATHが未設定です。");
  if (options.binary.endsWith("/bun"))
    throw new Error("ビルドしたdmmバイナリからauto enableを実行してください。");
  await requireMacNotifications();
  const configPath = join(options.root, "automation.json");
  const previous = readAutomationConfig(configPath);
  const config = automationConfigSchema.parse({
    version: 1,
    enabled: true,
    since: changes.since ?? previous?.since ?? new Date(Date.now() - 7 * 86400_000).toISOString(),
    intervalMinutes: changes.intervalMinutes ?? previous?.intervalMinutes ?? 10,
    minimumAgeMinutes: previous?.minimumAgeMinutes ?? 45,
    maxPerRun: previous?.maxPerRun ?? 3,
    delivery: "mac",
  });
  mkdirSync(dirname(address.plist), { recursive: true });
  mkdirSync(join(options.root, "logs"), { recursive: true, mode: 0o700 });
  for (const file of ["background.log", "background-error.log"])
    writeFileSync(join(options.root, "logs", file), "", { flag: "a", mode: 0o600 });
  writeFileSync(address.plist, launchAgent({ ...options, path: process.env.PATH }), { mode: 0o600 });
  await command(["/usr/bin/plutil", "-lint", address.plist]);
  await unload(address.target);
  atomicJson(configPath, config);
  try {
    await command(["/bin/launchctl", "bootstrap", address.domain, address.plist]);
  } catch (error) {
    if (previous) atomicJson(configPath, previous);
    else rmSync(configPath, { force: true });
    throw error;
  }
  return config;
}

export async function disableAutomaticReviews(root: string): Promise<void> {
  const configPath = join(root, "automation.json");
  const config = readAutomationConfig(configPath);
  if (config) atomicJson(configPath, { ...config, enabled: false });
  const address = serviceAddress(root);
  await unload(address.target);
  rmSync(address.plist, { force: true });
}

export function automaticReviewStatus(root: string): unknown {
  const statePath = join(root, "automation-state.json");
  return {
    config: readAutomationConfig(join(root, "automation.json")) ?? { enabled: false },
    email: readEmailSettings(root) ?? { enabled: false },
    state: existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null,
  };
}
