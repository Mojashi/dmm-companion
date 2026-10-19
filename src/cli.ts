#!/usr/bin/env bun
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { AutomaticReviews, readAutomationConfig } from "./automation";
import { automaticReviewStatus, disableAutomaticReviews, enableAutomaticReviews } from "./background";
import { Companion } from "./coach";
import { MacReviewDelivery } from "./delivery";
import { type Lesson, safeError } from "./domain";
import { disableEmailDelivery, enableEmailDelivery, GmailReviewMail, gwsAccount } from "./email";
import { importHar } from "./importer";
import { liveLockHolder } from "./lock";
import { diagnoseMacNotifications } from "./notifications";
import { promptIdentity } from "./prompt";
import { KeychainLogin } from "./saved-login";
import { serve } from "./server";
import { atomicJson, Store } from "./store";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    "data-dir": { type: "string" },
    port: { type: "string", default: "4317" },
    browser: { type: "string" },
    model: { type: "string", default: "gemini-4-argon-high" },
    "transcribe-model": { type: "string", default: "gemini-3.8-flash-low" },
    "no-open": { type: "boolean" },
    full: { type: "boolean" },
    since: { type: "string" },
    interval: { type: "string" },
    lesson: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) {
  console.log(`dmm — DMM英会話の振り返りノート

  dmm setup                     DMMにログインして資格情報をローカルに保存
                                (パスワードはキーチェーンに保存し、認証切れ時に自動で再ログイン)
  dmm                           振り返りページを開く・履歴と録音一覧を同期
  dmm sync                      新しい履歴と録音一覧を同期
  dmm sync --full               全月を取り直す
  dmm analyze [lesson-id... | all]  Geminiで未分析レッスンを振り返る
  dmm measure [lesson-id... | all]  録音のあるレッスンの発話量・流暢さ・語彙を計測
  dmm assess [lesson-id... | all]   振り返り済みのレッスンのCEFRの目安を判定
  dmm auto enable              自動生成・Mac通知を有効化（ログイン時に自動起動）
  dmm auto status              自動実行・配信の状態を表示
  dmm auto doctor              Mac通知の許可・表示設定を診断
  dmm auto test                テスト通知を送る（初回の通知許可）
  dmm auto run                 今すぐ自動振り返りを実行
  dmm auto email [ADDRESS]     完成した振り返りをgwsのGmailからメールでも送る
  dmm auto email off           メール配信を停止
  dmm auto disable             自動生成・通知を停止

  --data-dir PATH   保存先 (既定: ~/.dmm-companion)
  --port NUMBER     ローカルポート (既定: 4317)
  --model NAME      振り返りのGeminiモデル (既定: gemini-4-argon-high)
  --transcribe-model NAME  発話の書き起こしのGeminiモデル (既定: gemini-3.8-flash-low)
  --browser PATH   setupで使用するGoogle Chromeの実行ファイル
  --no-open        ページを自動で開かない
  --since DATE     自動生成の開始日 (例: 2026-09-01、既定: 初回設定の7日前)
  --interval N     自動確認の間隔 (分、既定: 10)
  --lesson ID      指定したレッスンの振り返りを開く

初回: dmm setup → メールアドレス・パスワードを入力 → dmm
必要な外部ツール: Google Chrome (バックグラウンドの認証処理)、agy、ffmpeg (分析)
アプリとブラウザUIはこのバイナリに同梱されています。`);
  process.exit(0);
}

function openPage(url: string): void {
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
  if (Bun.which(opener)) Bun.spawn([opener, url], { stdout: "ignore", stderr: "ignore" });
}

function reportSavedLogin(root: string): void {
  console.log(
    new KeychainLogin(root).available
      ? "パスワードをキーチェーンに保存しました。認証が切れたら自動で再ログインします。"
      : "このOSではパスワードを保存しません。認証が切れたらdmm setupを再実行してください。",
  );
}

/** Lesson ids given to `dmm measure` / `dmm assess`; none or "all" means every lesson. */
function measureTargets(): string[] {
  return positionals.slice(1);
}

async function main(): Promise<void> {
  let action = positionals[0] ?? "serve";
  if (
    !["serve", "background", "auto", "setup", "sync", "analyze", "measure", "assess", "import-har"].includes(
      action,
    )
  )
    throw new Error("不明なコマンドです。--helpを確認してください。");
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("portは0〜65535の整数で指定してください。");
  if (!values.model?.startsWith("gemini-")) throw new Error("--modelにGeminiモデルを指定してください。");
  const transcriptionModel = values["transcribe-model"];
  if (!transcriptionModel?.startsWith("gemini-"))
    throw new Error("--transcribe-modelにGeminiモデルを指定してください。");
  if (values.lesson && !/^[\w-]+$/.test(values.lesson)) throw new Error("レッスンIDが不正です。");
  const root = resolve(values["data-dir"] ?? join(homedir(), ".dmm-companion"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (action === "auto") {
    const operation = positionals[1] ?? "status";
    if (operation === "doctor") {
      const diagnosis = await diagnoseMacNotifications();
      console.log(diagnosis.report);
      if (diagnosis.issues.length) throw new Error(diagnosis.issues.join("\n"));
      console.log("通知は許可されています。実際の表示は集中モードなどのMac設定にも依存します。");
      return;
    }
    if (operation === "test") {
      await new MacReviewDelivery(
        { root, path: (...parts: string[]) => join(root, ...parts) },
        process.execPath,
      ).test();
      console.log("テスト通知をMacに登録しました。画面に表示されるか確認してください。");
      return;
    }
    if (operation === "enable") {
      if (values.since && !/^\d{4}-\d{2}-\d{2}$/.test(values.since))
        throw new Error("--sinceはYYYY-MM-DDで指定してください。");
      const config = await enableAutomaticReviews(
        { root, binary: process.execPath, model: values.model, transcriptionModel, port },
        {
          since: values.since ? new Date(`${values.since}T00:00:00+09:00`).toISOString() : undefined,
          intervalMinutes: values.interval ? Number(values.interval) : undefined,
        },
      );
      console.log(
        `自動振り返りを有効にしました。${config.intervalMinutes}分ごとに確認し、完成したらMacに通知します。\n対象: ${config.since}以降\n保存先: ${root}`,
      );
      return;
    }
    if (operation === "email") {
      if (positionals[2] === "off") {
        disableEmailDelivery(root);
        console.log("メール配信を停止しました。Mac通知は引き続き届きます。");
        return;
      }
      const settings = await enableEmailDelivery(root, positionals[2] ?? (await gwsAccount()));
      console.log(
        `テストメールを${settings.to}に送りました。これ以降に完成した振り返りをメールでも送ります。`,
      );
      return;
    }
    if (operation === "disable") {
      await disableAutomaticReviews(root);
      console.log("自動振り返りを停止しました。");
      return;
    }
    if (operation === "status") {
      console.log(JSON.stringify(automaticReviewStatus(root), null, 2));
      return;
    }
    if (operation !== "run")
      throw new Error("auto enable / disable / status / run / doctor / test / emailを指定してください。");
    action = "auto-run";
  }
  const lock = join(root, "app.lock");
  if (existsSync(lock)) {
    const pid = liveLockHolder(lock, Number(readFileSync(lock, "utf8")));
    if (pid !== undefined) {
      if (action === "background") {
        // A manually opened app already runs the scheduler. Take over after it exits.
        while (liveLockHolder(lock, pid) === pid) await Bun.sleep(2000);
        return main();
      }
      const connectionFile = join(root, "server.json");
      if (!existsSync(connectionFile))
        throw new Error("別のdmmコマンドが処理中です。完了を待って再実行してください。");
      const running = JSON.parse(readFileSync(connectionFile, "utf8")) as { pid: number; url: string };
      const url = new URL(running.url);
      if (running.pid !== pid || url.hostname !== "127.0.0.1" || url.protocol !== "http:")
        throw new Error("別のdmmコマンドが処理中です。");
      if (action === "serve") {
        if (values.lesson) url.searchParams.set("lesson", values.lesson);
        console.log(`DMM Companion: ${url}`);
        if (!values["no-open"]) openPage(url.href);
        return;
      }
      if (!["setup", "sync", "measure", "assess", "auto-run"].includes(action))
        throw new Error("ページを開いている間の分析は、ページのボタンから実行してください。");
      const identity = action === "setup" ? await promptIdentity() : undefined;
      const headers = { "x-companion-token": url.hash.slice(1), "Content-Type": "application/json" };
      const response = await fetch(`${url.origin}/api/${action === "auto-run" ? "automation/run" : action}`, {
        method: "POST",
        headers,
        body: JSON.stringify(
          identity ??
            (action === "measure" || action === "assess"
              ? {
                  ids:
                    measureTargets().length && !measureTargets().includes("all")
                      ? measureTargets()
                      : undefined,
                }
              : { full: values.full === true }),
        ),
      });
      if (identity) identity.password = "";
      if (!response.ok) throw new Error(((await response.json()) as { error: string }).error);
      let message = "";
      while (true) {
        const snapshot = (await (await fetch(`${url.origin}/api/library`, { headers })).json()) as {
          status: { busy: boolean; message: string; error: string };
          automation?: { running: boolean; error?: string };
        };
        if (snapshot.status.message && snapshot.status.message !== message) {
          message = snapshot.status.message;
          console.log(message);
        }
        if (!snapshot.status.busy && !snapshot.automation?.running) {
          if (snapshot.status.error) throw new Error(snapshot.status.error);
          if (action === "auto-run" && snapshot.automation?.error) throw new Error(snapshot.automation.error);
          break;
        }
        await Bun.sleep(1000);
      }
      if (action === "setup") reportSavedLogin(root);
      console.log(`完了しました。保存先: ${root}`);
      return;
    }
    unlinkSync(lock);
  }
  const lockFd = openSync(lock, "wx", 0o600);
  writeFileSync(lockFd, String(process.pid));
  closeSync(lockFd);
  process.on("exit", () => {
    if (existsSync(lock) && readFileSync(lock, "utf8") === String(process.pid)) unlinkSync(lock);
  });
  process.on("SIGINT", () => process.exit(130));
  process.on("SIGTERM", () => process.exit(143));
  const store = new Store(root);
  const companion = new Companion(store, values.model, new KeychainLogin(root), transcriptionModel);
  const automatic = new AutomaticReviews(
    store,
    companion,
    new MacReviewDelivery(store, process.execPath),
    new GmailReviewMail(store),
  );
  if (action === "import-har") {
    if (positionals.length < 2) throw new Error("開発用のHARファイルを指定してください。");
    for (const path of positionals.slice(1))
      await importHar(store, new Uint8Array(await Bun.file(path).arrayBuffer()), path);
  }
  if (action === "setup" || action === "sync") {
    let message = "";
    const timer = setInterval(() => {
      if (companion.status.message && companion.status.message !== message) {
        message = companion.status.message;
        console.log(message);
      }
    }, 500);
    try {
      if (action === "setup") await companion.setup(await promptIdentity(), values.browser);
      else await companion.sync(values.full === true);
    } finally {
      clearInterval(timer);
    }
    if (companion.status.error) throw new Error(companion.status.error);
    if (action === "setup") reportSavedLogin(root);
  }
  if (action === "analyze") {
    const targets = positionals.slice(1);
    const ids =
      !targets.length || targets.includes("all")
        ? store.library.lessons.filter((l) => l.attended && l.bookingId).map((l) => l.id)
        : targets;
    companion.enqueue(ids);
    await companion.idle();
    const failed = ids.map((id) => store.lesson(id)).filter((l) => l.phase === "error");
    for (const lesson of failed) console.error(`${lesson.teacher}: ${lesson.error}`);
    if (failed.length) process.exitCode = 1;
  }
  if (action === "measure" || action === "assess") {
    const targets = measureTargets();
    const ids = !targets.length || targets.includes("all") ? store.library.lessons.map((l) => l.id) : targets;
    let message = "";
    const timer = setInterval(() => {
      if (companion.status.message && companion.status.message !== message) {
        message = companion.status.message;
        console.log(message);
      }
    }, 500);
    try {
      await (action === "measure" ? companion.measureAll(ids) : companion.assessAll(ids));
    } finally {
      clearInterval(timer);
    }
    const errorOf = (l: Lesson) => (action === "measure" ? l.metricsError : l.assessmentError);
    const failed = ids.map((id) => store.lesson(id)).filter(errorOf);
    for (const lesson of failed)
      console.error(`${lesson.teacher} (${lesson.date.slice(0, 10)}): ${errorOf(lesson)}`);
    if (failed.length) process.exitCode = 1;
  }
  if (action === "auto-run") {
    if (!readAutomationConfig(store.path("automation.json"))?.enabled)
      throw new Error("先にdmm auto enableを実行してください。");
    await automatic.run(true);
    if (automatic.state.error) throw new Error(automatic.state.error);
  }
  if (action === "serve" || action === "background") {
    const { url } = serve(companion, port, automatic);
    atomicJson(store.path("server.json"), { pid: process.pid, url });
    console.log(`DMM Companion: ${url}\n保存先: ${store.root}`);
    const page = new URL(url);
    if (values.lesson) page.searchParams.set("lesson", values.lesson);
    if (action === "serve" && !values["no-open"]) openPage(page.href);
    if (readAutomationConfig(store.path("automation.json"))?.enabled) automatic.start();
    else {
      if (store.credentials().dmmCookie) void companion.sync();
      automatic.start();
    }
  } else
    console.log(
      `保存先: ${store.root}\n履歴 ${store.library.lessons.length}件 / 分析済み ${store.library.lessons.filter((l) => l.feedback).length}件`,
    );
}

await main().catch((error) => {
  console.error(safeError(error));
  process.exitCode = 1;
});
