#!/usr/bin/env node
// Site adaptation evidence runner: node packages/app/bin/site-check.mjs docs/sites/<site>.json [report.json]
// On failure the report now carries GUEST diagnostics (console output, uncaught
// errors, failed network calls) so a failing check explains itself.
import "./ensure-vm-modules.mjs";
import { writeFileSync } from "node:fs";

// Guest code creates its own promises the runner never observes; when one
// rejects (e.g. a player bundle reading a property of null), Node's default
// unhandledRejection behavior would kill the WHOLE check run mid-way. The
// check still records the failure — an escaped rejection must not erase the
// other pages' results (same guard as the WPT baseline runner).
process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  process.stderr.write(`[site-check] escaped guest rejection (continuing): ${message}\n`);
});

const { checkSite } = await import("../dist/site-check.js");

const manifest = process.argv[2];
if (manifest === undefined) {
  console.error("usage: site-check.mjs <manifest.json> [out.json]");
  process.exit(2);
}
const report = await checkSite(manifest);
for (const check of report.checks) {
  console.log(`${check.passed ? "PASS" : "FAIL"}  ${check.id}: ${check.detail}`);
}
console.log(`metrics: ${JSON.stringify(report.metrics)}`);
if (!report.passed && report.diagnostics !== undefined) {
  const { errors, console: logs } = report.diagnostics;
  console.log(`--- guest diagnostics: ${errors.length} errors, ${logs.length} console lines ---`);
  for (const e of errors.slice(0, 30)) console.log(`ERROR: ${e.slice(0, 200)}`);
  for (const c of logs.slice(0, 20)) console.log(`${String(c.level).toUpperCase()}: ${c.message.slice(0, 160)}`);
}
console.log(`${report.site}: ${report.passed ? "PASS" : `FAIL (${report.failedCount})`}`);
if (process.argv[3] !== undefined) {
  writeFileSync(process.argv[3], JSON.stringify(report, null, 1));
}
process.exit(report.passed ? 0 : 1);
