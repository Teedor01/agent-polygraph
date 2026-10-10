import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuleBasedFuturesAgent } from "./agents.js";
import { runPolygraph } from "./report.js";
import { importReportFile, recordRun } from "./history.js";

test("runPolygraph records run kind; deterministic runs carry no provider/model", async () => {
  const r = await runPolygraph(new RuleBasedFuturesAgent(), { countPerRegime: 1, mutationSampleSize: 2 });
  assert.equal(r.run?.kind, "deterministic");
  assert.equal(r.run?.provider, null);
  assert.equal(r.run?.model, null);
});

test("recordRun stores each run separately and never overwrites an earlier one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "poly-hist-"));
  const a = await runPolygraph(new RuleBasedFuturesAgent(), { countPerRegime: 1, mutationSampleSize: 2 });
  const b = await runPolygraph(new RuleBasedFuturesAgent(), { countPerRegime: 1, mutationSampleSize: 2 });
  assert.ok(await recordRun(a, dir));
  assert.ok(await recordRun(b, dir));
  assert.equal(await recordRun(a, dir), null, "same runId is not stored twice");
  const index = JSON.parse(await readFile(join(dir, "index.json"), "utf-8"));
  assert.equal(index.length, 2);
  assert.equal((await readdir(dir)).filter((f) => f.startsWith("futures-")).length, 2);
});

test("importing a legacy LLM report keeps the file verbatim and flags what was inferred", async () => {
  const dir = await mkdtemp(join(tmpdir(), "poly-imp-"));
  const base = await runPolygraph(new RuleBasedFuturesAgent(), { countPerRegime: 1, mutationSampleSize: 0 });
  const legacy: any = JSON.parse(JSON.stringify(base));
  delete legacy.run;
  delete legacy.scorecard.providerErrorsByKind;
  legacy.agent = "Futures LLM Agent";
  legacy.runId = "legacy-run-0001";
  legacy.scorecard.agentErrors = 1;
  const failing = JSON.parse(JSON.stringify(base.replaySample[0]));
  failing.passed = false;
  failing.failure = { category: "agent_error", details: [], severity: "HIGH" };
  failing.agentDecision.agentError =
    'LLM endpoint returned HTTP 429: {"error":{"message":"Rate limit reached for model `openai/gpt-oss-120b` ... tokens per day (TPD) ... https://console.groq.com/settings/billing"}}';
  legacy.failures = [failing];
  const src = join(dir, "legacy.json");
  const text = JSON.stringify(legacy, null, 2);
  await writeFile(src, text);

  const e = await importReportFile(src, join(dir, "runs"));
  assert.ok(e);
  assert.equal(e!.kind, "llm");
  assert.equal(e!.model, "openai/gpt-oss-120b");
  assert.equal(e!.provider, "groq");
  assert.deepEqual(e!.providerErrorsByKind, { quota_exhausted: 1 });
  assert.ok(e!.imported!.inferred.includes("kind"));
  assert.equal(await readFile(join(dir, "runs", e!.file), "utf-8"), text, "stored verbatim");
});

test("import refuses reports whose agent kind cannot be determined instead of guessing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "poly-bad-"));
  const base: any = await runPolygraph(new RuleBasedFuturesAgent(), { countPerRegime: 1, mutationSampleSize: 0 });
  delete base.run;
  base.agent = "Mystery Agent";
  const src = join(dir, "m.json");
  await writeFile(src, JSON.stringify(base));
  await assert.rejects(() => importReportFile(src, join(dir, "runs")), /refusing to guess/);
});
