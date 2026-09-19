import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { RuntimeContext } from "./config.js";

export interface PositionState {
  inPosition: boolean;
  entryPrice: number | null;
  entryQtyBase: number | null; 
  entryOrderId: string | null;
  entryTimestamp: string | null;
}

export const FLAT_POSITION: PositionState = {
  inPosition: false,
  entryPrice: null,
  entryQtyBase: null,
  entryOrderId: null,
  entryTimestamp: null,
};

export class PositionStateCorruptedError extends Error {
  constructor(path: string, cause: unknown) {
    super(
      `Position state file at ${path} exists but could not be read/parsed. Refusing to assume FLAT - ` +
        `an untracked real position may still be open. Fix or remove the file manually after checking your ` +
        `actual Bitget Demo account balance, then restart. Underlying error: ${cause instanceof Error ? cause.message : cause}`,
    );
    this.name = "PositionStateCorruptedError";
  }
}

const STATE_DIR = path.join(process.cwd(), "logs");

function positionPathFor(ctx: RuntimeContext): string {
  return path.join(STATE_DIR, `position.${ctx.environment}.json`);
}

export async function loadPosition(ctx: RuntimeContext): Promise<PositionState> {
  const filePath = positionPathFor(ctx);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err: any) {
    if (err && err.code === "ENOENT") {
      return { ...FLAT_POSITION };
    }
    throw new PositionStateCorruptedError(filePath, err);
  }

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || typeof parsed.inPosition !== "boolean") {
      throw new Error("parsed content is not a valid PositionState shape");
    }
    return parsed as PositionState;
  } catch (err) {
    throw new PositionStateCorruptedError(filePath, err);
  }
}

export async function savePosition(ctx: RuntimeContext, state: PositionState): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(positionPathFor(ctx), JSON.stringify(state, null, 2), "utf-8");
}
