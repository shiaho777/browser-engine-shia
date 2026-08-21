/**
 * Live_Metrics — our engine's numbers, computed live from the repository
 * (compete-with-google-benchmark spec; Requirement 1).
 *
 * Every "our engine" figure is computed here by scanning the actual source +
 * reading the live data tables, never written down. That is what makes the
 * benchmark impossible to inflate: anyone can re-run it and get the same values.
 *
 *   - LOC: reuse the scoreboard's `tallyLoc` (which already classifies
 *     generated vs hand-written), then additionally exclude `*.test.*` so the
 *     denominator is the *product* hand-written surface, not the test code.
 *   - CSS-property count: `CSS_PROPERTIES.length` from the live data table —
 *     "add a property = add a row" means this number rises for free.
 *   - DOM-member count: the sum of members across `DOM_INTERFACES`.
 *   - WPT pass count: run the configured self-test subset, not a stored number.
 *   - compat-per-LOC and mechanism-density: derived from the above.
 *
 * This module is orchestration infrastructure (not a pipeline stage), so it may
 * import the scoreboard and generator data tables directly.
 */
import { tallyLoc, type LocTally, type SourceFileInput } from "@browser-engine/scoreboard";
import { CSS_PROPERTIES, DOM_INTERFACES } from "@browser-engine/generator";

import type { ExecutionEvidence } from "./evidence.js";

/** The live, repository-derived metrics for our engine. */
export interface LiveMetrics {
  /** Hand-written product lines (excludes generated AND test files). */
  readonly handWrittenLines: number;
  /** Generated lines (excluded from the compat-per-LOC denominator). */
  readonly generatedLines: number;
  /** Test lines (excluded from the product surface; reported for honesty). */
  readonly testLines: number;
  /** Total system size = handWritten + generated + test. */
  readonly totalLines: number;
  /** Number of CSS properties in the live data table. */
  readonly cssPropertyCount: number;
  /** Number of DOM interface members across the live IDL table. */
  readonly domMemberCount: number;
  /** Platform-feature count = cssPropertyCount + domMemberCount. */
  readonly platformFeatureCount: number;
  /** Passing self-test WPT subset count (run live, not stored). */
  readonly wptPassCount: number;
  /** compat-per-LOC = wptPassCount / handWrittenLines, or null if not measurable. */
  readonly compatPerLoc: number | null;
  /** mechanism-density = platformFeatureCount / (handWrittenLines / 1000), or null. */
  readonly mechanismDensity: number | null;
  /** Stable execution evidence from maintained WPT subset traces. */
  readonly executionEvidence?: ExecutionEvidence;
}

/** True when a path is a test file (excluded from the product hand-written surface). */
export function isTestFile(path: string): boolean {
  return /\.(test|spec|property\.test)\.[cm]?tsx?$/.test(path) || /\.test\./.test(path);
}

/**
 * Compute every live metric from a set of source files plus a live WPT pass
 * count. Pure: same inputs ⇒ same output, so anyone can reproduce it.
 *
 * @param files the repository source files (path + content).
 * @param wptPassCount the live self-test subset pass count (run by the caller).
 */
export function computeLiveMetrics(
  files: Iterable<SourceFileInput>,
  wptPassCount: number,
  executionEvidence?: ExecutionEvidence,
): LiveMetrics {
  // Split test files out of the product surface, then tally the rest by origin.
  const product: SourceFileInput[] = [];
  let testLines = 0;
  for (const file of files) {
    if (isTestFile(file.path)) {
      testLines += countLines(file.content);
    } else {
      product.push(file);
    }
  }

  const tally: LocTally = tallyLoc(product);
  const cssPropertyCount = CSS_PROPERTIES.length;
  const domMemberCount = DOM_INTERFACES.reduce((sum, iface) => sum + iface.members.length, 0);
  const platformFeatureCount = cssPropertyCount + domMemberCount;

  const compatPerLoc = tally.handWritten > 0 ? wptPassCount / tally.handWritten : null;
  const mechanismDensity =
    tally.handWritten > 0 ? platformFeatureCount / (tally.handWritten / 1000) : null;

  const metrics: LiveMetrics = {
    handWrittenLines: tally.handWritten,
    generatedLines: tally.generated,
    testLines,
    totalLines: tally.total + testLines,
    cssPropertyCount,
    domMemberCount,
    platformFeatureCount,
    wptPassCount,
    compatPerLoc,
    mechanismDensity,
  };
  return executionEvidence === undefined ? metrics : { ...metrics, executionEvidence };
}

/** Count non-blank physical lines (mirrors the scoreboard's source-line rule). */
function countLines(content: string): number {
  if (content.length === 0) return 0;
  let count = 0;
  for (const line of content.split(/\r\n|\r|\n/)) {
    if (line.trim().length > 0) count += 1;
  }
  return count;
}
