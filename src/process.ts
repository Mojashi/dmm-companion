import { closeSync, openSync } from "node:fs";

export class CommandError extends Error {
  constructor(
    executable: string,
    readonly exitCode: number,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(`${executable} が失敗しました (${exitCode}): ${stderr.slice(-700)}`);
  }
}

export async function command(
  args: string[],
  options: { cwd?: string; timeout?: number; log?: string } = {},
): Promise<string> {
  const executable = args[0];
  if (!executable || !Bun.which(executable))
    throw new Error(`${executable} が見つかりません。インストールしてPATHを確認してください。`);
  const fd = options.log ? openSync(options.log, "w", 0o600) : undefined;
  let timedOut = false;
  const child = Bun.spawn(args, { cwd: options.cwd, stdin: "ignore", stdout: fd ?? "pipe", stderr: "pipe" });
  const terminate = () => {
    child.kill();
  };
  process.once("exit", terminate);
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, options.timeout ?? 180_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      typeof child.stdout !== "number" ? new Response(child.stdout).text() : Promise.resolve(""),
      new Response(child.stderr).text(),
    ]);
    if (timedOut) throw new Error(`${executable} が制限時間を超えました。保存済みデータから再実行できます。`);
    if (exitCode !== 0) throw new CommandError(executable, exitCode, stdout, stderr);
    return options.log ? Bun.file(options.log).text() : stdout;
  } finally {
    process.removeListener("exit", terminate);
    clearTimeout(timer);
    if (fd !== undefined) closeSync(fd);
  }
}
