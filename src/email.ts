import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ReviewChannel } from "./automation";
import type { Lesson } from "./domain";
import { reviewEmailHtml } from "./email-html";
import { command } from "./process";
import { atomicJson, type Store } from "./store";

export const emailSettingsSchema = z.object({
  version: z.literal(1),
  to: z.email(),
  enabledAt: z.iso.datetime(),
});
export type EmailSettings = z.infer<typeof emailSettingsSchema>;
export type EmailMessage = { subject: string; html: string };

const settingsPath = (root: string) => join(root, "email.json");

export function readEmailSettings(root: string): EmailSettings | undefined {
  const path = settingsPath(root);
  return existsSync(path) ? emailSettingsSchema.parse(JSON.parse(readFileSync(path, "utf8"))) : undefined;
}

export function reviewEmail(lesson: Lesson): EmailMessage {
  const date = new Date(lesson.date).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" });
  return {
    subject: `DMM英会話の振り返り ${date} ${lesson.teacher}先生: ${lesson.feedback?.title}`,
    html: reviewEmailHtml(lesson),
  };
}

/** Sends through the Gmail account that the gws CLI is signed in to. */
export async function sendGmail(to: string, message: EmailMessage): Promise<void> {
  await command(
    ["gws", "gmail", "+send", "--to", to, "--subject", message.subject, "--body", message.html, "--html"],
    {
      timeout: 60_000,
    },
  );
}

export async function gwsAccount(): Promise<string> {
  const profile = JSON.parse(
    await command(["gws", "gmail", "users", "getProfile", "--params", '{"userId":"me"}'], {
      timeout: 60_000,
    }),
  ) as { emailAddress?: string };
  if (!profile.emailAddress)
    throw new Error("gwsのGmailアカウントを取得できません。gws auth loginを確認してください。");
  return profile.emailAddress;
}

/** Sends a test message first, so settings are saved only once gws can actually send. */
export async function enableEmailDelivery(root: string, to: string): Promise<EmailSettings> {
  const settings = emailSettingsSchema.parse({ version: 1, to, enabledAt: new Date().toISOString() });
  await sendGmail(settings.to, {
    subject: "DMM英会話の振り返り: メール配信の設定テスト",
    html: "<p>メール配信を設定しました。これ以降に完成した振り返りをこのアドレスに送ります。</p>",
  });
  atomicJson(settingsPath(root), settings);
  return settings;
}

export function disableEmailDelivery(root: string): void {
  rmSync(settingsPath(root), { force: true });
}

/** Reads the settings on every use, so `dmm auto email` takes effect in a running background process. */
export class GmailReviewMail implements ReviewChannel {
  readonly key = "email";
  readonly label = "振り返りのメール送信";
  constructor(private readonly store: Pick<Store, "root">) {}
  enabledAt() {
    return readEmailSettings(this.store.root)?.enabledAt;
  }
  async send(lesson: Lesson) {
    const settings = readEmailSettings(this.store.root);
    if (!settings) throw new Error("メール配信が設定されていません。");
    await sendGmail(settings.to, reviewEmail(lesson));
  }
}
