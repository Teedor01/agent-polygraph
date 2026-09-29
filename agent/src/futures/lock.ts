import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import path from "node:path";
import type { FuturesRuntimeContext } from "./config.js";

const LOCK_DIR = path.join(process.cwd(), "logs");

function lockPathFor(ctx: FuturesRuntimeContext): string {
  return path.join(LOCK_DIR, `agent-futures.${ctx.environment}.lock`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function acquireFuturesLock(ctx: FuturesRuntimeContext): Promise<() => Promise<void>> {
  await mkdir(LOCK_DIR, { recursive: true });
  const lockPath = lockPathFor(ctx);

  let existingPid: number | null = null;
  try {
    const raw = await readFile(lockPath, "utf-8");
    const parsed = JSON.parse(raw);
    existingPid = typeof parsed.pid === "number" ? parsed.pid : null;
  } catch {
    existingPid = null;
  }

  if (existingPid !== null && existingPid !== process.pid && isProcessAlive(existingPid)) {
    throw new Error(
      `Another futures agent process (PID ${existingPid}) appears to already be running against ` +
        `${ctx.environment} state in this folder. Stop it first, or delete ${lockPath} only if you're certain it's stale.`,
    );
  }

  await writeFile(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2), "utf-8");

  return async () => {
    try {
      await unlink(lockPath);
    } catch {
      
    }
  };
}

export function futuresLockPath(ctx: FuturesRuntimeContext): string {
  return lockPathFor(ctx);
}
