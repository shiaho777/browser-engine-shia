/**
 * Tests for the WPT pass-count regression gate (task 1.11).
 *
 * Built by `tsc` then run with: `node --test packages/scoreboard/dist/*.test.js`.
 *
 * Covers Requirement 10.2 — "IF a submitted commit lowers the WPT subset pass
 * count below the current baseline, THEN THE CI_Pipeline SHALL block the
 * merge". The gate is the pure decision point CI consults; these tests prove
 * the forward-only rule:
 *   - a candidate BELOW the baseline is blocked (the regression case);
 *   - a flat candidate (== baseline) is allowed;
 *   - a candidate ABOVE the baseline is allowed (forward progress);
 *   - the empty Phase 0 baseline (0 vs 0) is NOT blocked, so the green pipeline
 *     is undisturbed;
 *   - a broken (negative / non-finite) measurement fails loudly.
 *
 * The companion end-to-end "deliberate violation" assertion — that running a
 * regressing subset through the runner + gate is rejected — lives in the
 * constitution-fixtures suite (tools/constitution-fixtures), alongside the
 * three ESLint/kernel violation classes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { checkWptRegression } from "./regression.js";
import { runWptSubset, type WptSubset } from "./wpt.js";

// ---------------------------------------------------------------------------
// The forward-only rule (Req 10.2)
// ---------------------------------------------------------------------------

void test("Req 10.2: a candidate BELOW the baseline is blocked (regression)", () => {
  const result = checkWptRegression(10, 7);
  assert.equal(result.blocked, true);
  assert.equal(result.baseline, 10);
  assert.equal(result.candidate, 7);
  assert.equal(result.delta, -3);
});

void test("Req 10.2: a flat candidate (== baseline) is allowed", () => {
  const result = checkWptRegression(10, 10);
  assert.equal(result.blocked, false);
  assert.equal(result.delta, 0);
});

void test("Req 10.2: a candidate ABOVE the baseline is allowed (forward progress)", () => {
  const result = checkWptRegression(10, 13);
  assert.equal(result.blocked, false);
  assert.equal(result.delta, 3);
});

void test("Phase 0 empty baseline (0 vs 0) is NOT blocked — green pipeline undisturbed", () => {
  const result = checkWptRegression(0, 0);
  assert.equal(result.blocked, false);
  assert.equal(result.delta, 0);
});

void test("dropping to zero from a real baseline is blocked", () => {
  assert.equal(checkWptRegression(1, 0).blocked, true);
});

// ---------------------------------------------------------------------------
// Broken measurements fail loudly (constitution stance: never fake)
// ---------------------------------------------------------------------------

void test("a negative or non-finite pass count is rejected loudly, not silently passed", () => {
  assert.throws(() => checkWptRegression(-1, 0), RangeError);
  assert.throws(() => checkWptRegression(0, -1), RangeError);
  assert.throws(() => checkWptRegression(Number.NaN, 0), RangeError);
  assert.throws(() => checkWptRegression(0, Number.POSITIVE_INFINITY), RangeError);
});

// ---------------------------------------------------------------------------
// End-to-end: the gate fed by the real subset runner blocks a regressing commit
// ---------------------------------------------------------------------------

/** Build a subset of `passing` always-pass tests + `failing` always-fail tests. */
function subsetWith(passing: number, failing: number): WptSubset {
  const tests = [];
  for (let i = 0; i < passing; i += 1) {
    tests.push({ id: `pass-${i}`, capability: "cap", run: () => true });
  }
  for (let i = 0; i < failing; i += 1) {
    tests.push({
      id: `fail-${i}`,
      capability: "cap",
      run: () => {
        throw new Error("regressed");
      },
    });
  }
  return tests;
}

void test("Req 10.2: a commit whose subset run lowers the pass count is blocked", () => {
  // Baseline established earlier: 5 tests passed.
  const baseline = runWptSubset(subsetWith(5, 0)).passCount;
  assert.equal(baseline, 5);

  // Candidate commit regresses: 2 of the 5 now fail → 3 passing.
  const candidate = runWptSubset(subsetWith(3, 2)).passCount;
  assert.equal(candidate, 3);

  const gate = checkWptRegression(baseline, candidate);
  assert.equal(gate.blocked, true, "a pass-count regression must block the merge (Req 10.2)");
});

void test("a commit that keeps every baseline test passing is allowed", () => {
  const baseline = runWptSubset(subsetWith(5, 0)).passCount;
  const candidate = runWptSubset(subsetWith(5, 0)).passCount;
  assert.equal(checkWptRegression(baseline, candidate).blocked, false);
});

// ---------------------------------------------------------------------------
// Property: blocked ⟺ candidate < baseline, for all non-negative counts
// ---------------------------------------------------------------------------

void test("Property: the gate blocks exactly when the candidate count is below the baseline", () => {
  // **Validates: Requirements 10.2**
  fc.assert(
    fc.property(fc.nat({ max: 10_000 }), fc.nat({ max: 10_000 }), (baseline, candidate) => {
      const result = checkWptRegression(baseline, candidate);
      return (
        result.blocked === candidate < baseline &&
        result.delta === candidate - baseline &&
        result.baseline === baseline &&
        result.candidate === candidate
      );
    }),
  );
});
