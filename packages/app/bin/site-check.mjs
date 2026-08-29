#!/usr/bin/env node
// Site adaptation evidence runner: node packages/app/bin/site-check.mjs docs/sites/<site>.json [report.json]
import { writeFileSync } from "node:fs";
import { checkSite } from "../dist/site-check.js";

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
console.log(`${report.site}: ${report.passed ? "PASS" : `FAIL (${report.failedCount})`}`);
if (process.argv[3] !== undefined) {
  writeFileSync(process.argv[3], JSON.stringify(report, null, 1));
}
process.exit(report.passed ? 0 : 1);
