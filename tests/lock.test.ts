import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveLockHolder } from "../src/lock";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function lockFile(pid: number, writtenAt: Date): string {
  const dir = mkdtempSync(join(tmpdir(), "dmm-lock-"));
  directories.push(dir);
  const lock = join(dir, "app.lock");
  writeFileSync(lock, String(pid));
  utimesSync(lock, writtenAt, writtenAt);
  return lock;
}

test("lock written by a running process is live", () => {
  expect(liveLockHolder(lockFile(process.pid, new Date()), process.pid)).toBe(process.pid);
});

test("PID reused by a process started after the lock was written is stale", () => {
  const beforeThisProcess = new Date(Date.now() - 24 * 60 * 60 * 1000 * 365);
  expect(liveLockHolder(lockFile(process.pid, beforeThisProcess), process.pid)).toBeUndefined();
});

test("lock of an exited process is stale", async () => {
  const child = Bun.spawn(["true"]);
  await child.exited;
  expect(liveLockHolder(lockFile(child.pid, new Date()), child.pid)).toBeUndefined();
});

test("missing or malformed lock is stale", () => {
  expect(liveLockHolder("/nonexistent/app.lock", process.pid)).toBeUndefined();
  expect(liveLockHolder(lockFile(process.pid, new Date()), Number.NaN)).toBeUndefined();
});
