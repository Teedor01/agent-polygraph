import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "polygraph");

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

const FORBIDDEN_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /futures\/execution(\.js)?['"]/, reason: "imports futures/execution.ts (real order placement/closing)" },
  { pattern: /\bsafeInvoke\s*\(/, reason: "calls safeInvoke directly (bypasses the decision-only boundary)" },
  { pattern: /@bitget-ai\/bitget-agent-sdk/, reason: "imports the Bitget SDK directly" },
];

test("no non-test Polygraph source file imports futures/execution.ts, calls safeInvoke, or imports the Bitget SDK", () => {
  const files = readdirSync(SRC_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  assert.ok(files.length > 0, "expected to find polygraph source files - the path resolution itself may be broken");

  const violations: string[] = [];
  for (const file of files) {
    const raw = readFileSync(path.join(SRC_DIR, file), "utf-8");
    const code = stripComments(raw);
    for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
      if (pattern.test(code)) {
        violations.push(`${file}: ${reason}`);
      }
    }
  }

  assert.deepEqual(violations, [], `Safety boundary violated:\n${violations.join("\n")}`);
});
