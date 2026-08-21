/**
 * `npm run benchmark` entry point — scan the real repository, compute live
 * metrics, judge every dimension against Chromium's cited figures, and write
 * the complete `BENCHMARK.md` at the repo root
 * (compete-with-google-benchmark spec; Requirement 4, task 7).
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { computeLiveMetrics } from "../metrics.js";
import { scanRepositorySources } from "../scan.js";
import {
  buildSnapshot,
  renderBenchmarkJson,
  renderBenchmarkMarkdown,
  renderEvidenceDashboardHtml,
} from "../report.js";
import { liveWptPassCount } from "../self-test.js";
import { collectExecutionEvidence } from "../evidence.js";

/** Resolve the repository root from this file's location (packages/benchmark/dist/bin). */
function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/bin -> dist -> benchmark -> packages -> repo root
  return path.resolve(here, "..", "..", "..", "..");
}

async function main(): Promise<void> {
  const root = repoRoot();
  const files = scanRepositorySources(root);
  const wptPassCount = liveWptPassCount();
  const evidence = await collectExecutionEvidence(root);
  const metrics = computeLiveMetrics(files, wptPassCount, evidence);
  const snapshot = buildSnapshot(metrics);
  const markdown = renderBenchmarkMarkdown(snapshot);
  const json = renderBenchmarkJson(snapshot);
  const dashboard = renderEvidenceDashboardHtml(snapshot);

  const outPath = path.join(root, "BENCHMARK.md");
  const jsonPath = path.join(root, "benchmark-evidence.json");
  const dashboardPath = path.join(root, "evidence-dashboard.html");
  writeFileSync(outPath, markdown);
  writeFileSync(jsonPath, json);
  writeFileSync(dashboardPath, dashboard);
  console.log(
    `wrote ${outPath}, ${jsonPath}, and ${dashboardPath} — handWritten=${metrics.handWrittenLines}, features=${metrics.platformFeatureCount}, compat/LOC=${metrics.compatPerLoc?.toFixed(4) ?? "—"}`,
  );
}

await main();
