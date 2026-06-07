/**
 * WPT pass-count regression gate (design.md §5 Phase success criteria, §9.1;
 * Requirement 10.2).
 *
 * The North Star discipline is **forward-only compatibility**: measured
 * compatibility (the passing WPT subset count) may stay flat or grow, but a
 * commit that *lowers* it below the current baseline must be blocked
 * (Requirement 10.2 — "IF a submitted commit lowers the WPT subset pass count
 * below the current baseline, THEN THE CI_Pipeline SHALL block the merge").
 *
 * This module is the single, pure decision point CI consults: compare a
 * candidate commit's pass count against the stored baseline and report whether
 * the merge must be blocked. It is deliberately tiny and side-effect free —
 * reading the baseline, running the subset, and failing the build are the
 * caller's (CI's) jobs; this just makes the verdict.
 *
 * Note on the empty Phase 0 baseline: with baseline 0 and candidate 0 the gate
 * reports `blocked: false` (0 is not below 0), so the Phase 0 green pipeline is
 * undisturbed. The gate only bites once a real, non-zero baseline exists and a
 * later commit regresses it.
 */

/** The verdict of a WPT pass-count regression check (Requirement 10.2). */
export interface WptRegressionResult {
  /** The current baseline pass count the candidate is compared against. */
  readonly baseline: number;
  /** The candidate commit's WPT subset pass count. */
  readonly candidate: number;
  /** `candidate - baseline`: negative means a regression, ≥ 0 means progress. */
  readonly delta: number;
  /**
   * True iff the merge must be blocked because the candidate lowered the pass
   * count below the baseline (`candidate < baseline`). Equal counts (flat) and
   * higher counts (forward progress) are allowed.
   */
  readonly blocked: boolean;
}

/**
 * Reject a non-finite / negative pass count loudly rather than letting a broken
 * measurement slip a regression through silently (constitution stance: fail
 * loudly, never fake — design.md §2 bug#4). Pass counts come from
 * {@link runWptSubset} and are always non-negative integers.
 */
function assertValidCount(label: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(
      `WPT regression gate: ${label} pass count must be a finite, non-negative number; got ${String(value)}`,
    );
  }
}

/**
 * Decide whether a candidate commit's WPT subset pass count regresses below the
 * baseline and must therefore block the merge (Requirement 10.2).
 *
 * Forward-only rule:
 *   - `candidate < baseline`  → `blocked: true`  (compatibility went backwards).
 *   - `candidate === baseline` → `blocked: false` (flat is allowed).
 *   - `candidate > baseline`  → `blocked: false` (forward progress).
 *
 * @param baseline  the current stored baseline pass count (≥ 0, finite).
 * @param candidate the candidate commit's pass count (≥ 0, finite), typically
 *                  `runWptSubset(subset).passCount`.
 */
export function checkWptRegression(baseline: number, candidate: number): WptRegressionResult {
  assertValidCount("baseline", baseline);
  assertValidCount("candidate", candidate);
  return {
    baseline,
    candidate,
    delta: candidate - baseline,
    blocked: candidate < baseline,
  };
}
