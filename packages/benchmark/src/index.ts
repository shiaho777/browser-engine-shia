/**
 * @browser-engine/benchmark
 *
 * The Competitive Benchmark Scoreboard: our engine's numbers, computed live
 * from this repository, set head-to-head against Chromium's cited public /
 * third-party figures — wins loud, gaps honest, incomparable refused. See
 * `MANIFESTO.md` and `.kiro/specs/compete-with-google-benchmark/`.
 */
export const PACKAGE_NAME = "@browser-engine/benchmark" as const;

export type { Confidence, CompetitorDatum } from "./competitors.data.js";
export { COMPETITORS, competitorFor } from "./competitors.data.js";

export type { LiveMetrics } from "./metrics.js";
export { computeLiveMetrics, isTestFile } from "./metrics.js";

export type { ExecutionEvidence } from "./evidence.js";
export { collectExecutionEvidence } from "./evidence.js";

export { scanRepositorySources } from "./scan.js";

export type { Verdict, DimensionResult } from "./dimensions.js";
export { evaluateDimensions } from "./dimensions.js";

export type { BenchmarkJsonReport, BenchmarkSnapshot } from "./report.js";
export {
  buildBenchmarkJsonReport,
  buildSnapshot,
  renderBenchmarkJson,
  renderBenchmarkMarkdown,
  renderEvidenceDashboardHtml,
} from "./report.js";

export { BENCHMARK_SELF_TEST_SUBSET, liveWptPassCount } from "./self-test.js";
