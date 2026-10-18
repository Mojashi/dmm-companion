import { statSync } from "node:fs";

// ps -o etime= prints "[[dd-]hh:]mm:ss".
function elapsedSeconds(etime: string): number {
  const [days, clock] = etime.includes("-") ? etime.split("-") : ["0", etime];
  const units = (clock ?? "").split(":").map(Number).reverse();
  const [seconds = 0, minutes = 0, hours = 0] = units;
  return Number(days) * 86400 + hours * 3600 + minutes * 60 + seconds;
}

function processStartedAt(pid: number): number | undefined {
  const result = Bun.spawnSync(["ps", "-o", "etime=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const etime = result.stdout.toString().trim();
  if (result.exitCode !== 0 || !etime) return undefined;
  return Date.now() - elapsedSeconds(etime) * 1000;
}

/**
 * Returns the PID that still holds the lock, or undefined when the lock is stale.
 * A PID left behind by a crash or reboot can be reused by an unrelated process,
 * so the holder must have started before the lock file was written.
 */
export function liveLockHolder(lock: string, pid: number): number | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const written = statSync(lock, { throwIfNoEntry: false });
  const startedAt = processStartedAt(pid);
  if (!written || startedAt === undefined) return undefined;
  // etime has one-second resolution.
  return startedAt <= written.mtimeMs + 1000 ? pid : undefined;
}
