import { createInterface } from "node:readline/promises";

export type LoginIdentity = { email: string; password: string };

export async function promptIdentity(): Promise<LoginIdentity> {
  if (!process.stdin.isTTY)
    throw new Error(
      "dmm setupはターミナルから実行してください。メールアドレスとパスワードを対話入力します。",
    );
  const input = createInterface({ input: process.stdin, output: process.stdout });
  let email: string;
  try {
    email = (await input.question("メールアドレス: ")).trim();
  } finally {
    input.close();
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("メールアドレスを確認してください。");
  const password = await hiddenInput("パスワード: ");
  if (!password) throw new Error("パスワードが入力されていません。");
  return { email, password };
}

export function hiddenInput(label: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("パスワード入力にはターミナルが必要です。");
  process.stdout.write(label);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      process.stdin.off("data", receive);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const receive = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003" || char === "\u0004") {
          cleanup();
          reject(new Error("入力を中止しました。"));
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (char === "\u007f" || char === "\b") value = Array.from(value).slice(0, -1).join("");
        else if (char >= " ") value += char;
      }
    };
    process.stdin.on("data", receive);
  });
}
