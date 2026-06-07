/**
 * @browser-engine/scoreboard
 *
 * Computes and publishes compat-per-LOC = (passing WPT subset tests) /
 * (hand-written source lines). Excludes Code_Generator output from the
 * denominator but includes it in reported total system size. Marks capabilities
 * without a passing WPT/reftest as not implemented. See design.md §1.3, §9 and
 * Requirements 1 and 10.
 */
export const PACKAGE_NAME = "@browser-engine/scoreboard" as const;

// ---- LOC accounting (the metric denominator; Req 1.1, 1.2, 1.3) -----------
export {
  classifyFile,
  classifyOrigin,
  countSourceLines,
  hasGeneratedMarker,
  isGeneratedPath,
  tallyLoc,
  type ClassifiedFile,
  type CodeOrigin,
  type LocTally,
  type SourceFileInput,
} from "./loc.js";

// ---- WPT subset runner + pass-count statistics (Req 1.5, 10.1, 10.3) ------
export {
  runWptSubset,
  runWptTest,
  type WptRunSummary,
  type WptSubset,
  type WptTestCase,
  type WptTestResult,
  type WptVerdict,
} from "./wpt.js";

// ---- WPT pass-count regression gate: forward-only compat (Req 10.2) -------
export { checkWptRegression, type WptRegressionResult } from "./regression.js";

// ---- Scoreboard: compat-per-LOC, capability status, publication -----------
export {
  computeCompatPerLoc,
  computeScoreboard,
  publishScoreboard,
  reportCapabilities,
  type CapabilityReport,
  type CapabilityStatus,
  type PublishResult,
  type ReftestEvidence,
  type Scoreboard,
  type ScoreboardInput,
  type ScoreboardPublisher,
} from "./scoreboard.js";
