import { importReportFile } from "./history.js";

async function main() {
  const argv = process.argv.slice(2);
  const dirArg = argv.find((a) => a.startsWith("--history-dir="));
  const files = argv.filter((a) => !a.startsWith("--"));
  if (!dirArg || files.length === 0) {
    console.error("usage: import-history --history-dir=<dir> <report.json> [more.json ...]");
    process.exit(2);
  }
  const dir = dirArg.slice("--history-dir=".length);
  for (const f of files) {
    try {
      const e = await importReportFile(f, dir);
      console.log(e ? `imported ${f} -> ${e.file} (${e.kind}, ${e.scenarios} scenarios, validity=${e.validity})` : `skipped ${f}: runId already in history`);
    } catch (err) {
      console.error(`FAILED ${f}: ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
    }
  }
}
main();
