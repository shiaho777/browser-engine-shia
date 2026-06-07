/**
 * @browser-engine/test-harness
 *
 * Self-built test harnesses: WPT subset runner, reftest (PNG vs reference image
 * within a pixel threshold) and the differential harness (naive full-recompute
 * vs true incremental, byte-for-byte). See design.md §9. The WPT/reftest/diff
 * harnesses arrive in tasks 1.7–1.9 and are wired into CI in task 1.10.
 */
export const PACKAGE_NAME = "@browser-engine/test-harness" as const;

// Reftest (screenshot) harness — task 1.8. Compares a rendered PNG against a
// reference image within a configurable pixel-difference threshold (Req 10.4).
export {
  compareReftest,
  compareRawImages,
  diffRawImages,
  DimensionMismatchError,
  type ReftestOptions,
  type ReftestResult,
} from "./reftest.js";
export { decodePng, encodePng, type RawImage, type EncodePngOptions } from "./png.js";

// Differential harness — task 1.9. Replays the SAME input-edit sequence through
// two `Db` backends (naive full-recompute vs incremental) and compares their
// rendered output byte-for-byte; any difference blocks the merge (Req 9.2, 9.4,
// 13.4). Phase 0 diffs two NaiveDb instances; task 5.11 swaps in the real
// incremental backend with no structural change.
export {
  applyEdits,
  assertCampaignClean,
  assertDifferentialIdentical,
  canonicalJsonBytes,
  compareBytes,
  DifferentialMismatchError,
  runDifferential,
  runDifferentialCampaign,
  type ByteDifference,
  type CampaignResult,
  type DbFactory,
  type DifferentialOutcome,
  type EditSequenceGenerator,
  type InputEdit,
  type RenderProbe,
} from "./differential.js";
