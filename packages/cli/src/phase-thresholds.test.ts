/**
 * Tests for the progressive per-Phase WPT thresholds — the "逐 9 递进" gate
 * (task 9.6; design.md §5; Requirement 17.5).
 *
 * Built by `tsc` then run with: `node --test packages/cli/dist/*.test.js`.
 *
 * Requirement 17.5: each Phase's configured "9" target must be met or exceeded
 * by the live pass rate, and the targets ascend across phases. These assert:
 *   - every configured Phase meets its target (each authored subset passes 100%);
 *   - the configured targets form a monotonically non-decreasing ladder of nines;
 *   - the gate BLOCKS (reports not-met) when a target exceeds the live rate
 *     (a forced regression), proving the gate is meaningful.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  PHASE_TARGETS,
  checkPhaseThreshold,
  checkProgressiveThresholds,
  type PhaseTarget,
} from "./phase-thresholds.js";

void test("Req 17.5: every configured Phase meets or exceeds its '9' target", () => {
  const result = checkProgressiveThresholds();
  for (const phase of result.phases) {
    assert.equal(
      phase.meetsTarget,
      true,
      `${phase.id}: live ${phase.passRate} < target ${phase.target} (${phase.passCount}/${phase.total})`,
    );
  }
  assert.equal(result.allMet, true);
});

void test("Req 17.5: the configured targets form an ascending ladder of nines", () => {
  const result = checkProgressiveThresholds();
  assert.equal(result.ladderMonotonic, true, "each Phase target must be ≥ the previous");
  // The ladder is strictly ascending across the four configured rungs.
  const targets = PHASE_TARGETS.map((t) => t.targetPassRate);
  for (let i = 1; i < targets.length; i += 1) {
    assert.ok(targets[i]! >= targets[i - 1]!, `rung ${i} (${targets[i]}) must be ≥ ${targets[i - 1]}`);
  }
  // It genuinely climbs the nines: 0.1 → 0.9 → 0.99 → 0.999.
  assert.deepEqual(targets, [0.1, 0.9, 0.99, 0.999]);
});

void test("Req 17.5: each Phase subset is non-empty and passes 100% (clears its target with margin)", () => {
  const result = checkProgressiveThresholds();
  for (const phase of result.phases) {
    assert.ok(phase.total > 0, `${phase.id} must have a non-empty subset`);
    assert.equal(phase.passRate, 1, `${phase.id} authored subset passes 100%`);
    assert.ok(phase.passRate >= phase.target);
  }
});

void test("Req 17.5: the gate BLOCKS when the configured target exceeds the live rate", () => {
  // A subset of two tests where one fails ⇒ live rate 0.5; a target of 0.9 must
  // NOT be met (the gate would block this Phase).
  const failing: PhaseTarget = {
    id: "synthetic/regressed",
    targetPassRate: 0.9,
    subset: [
      { id: "t/pass", capability: "x", run: () => {} },
      { id: "t/fail", capability: "x", run: () => { throw new Error("fail"); } },
    ],
  };
  const result = checkPhaseThreshold(failing);
  assert.equal(result.passRate, 0.5);
  assert.equal(result.meetsTarget, false, "0.5 must not meet a 0.9 target — the gate blocks");
});

void test("a Phase whose live rate exactly equals its target meets it (inclusive)", () => {
  // Two tests, both pass ⇒ rate 1.0; target 1.0 ⇒ met (>= is inclusive).
  const exact: PhaseTarget = {
    id: "synthetic/exact",
    targetPassRate: 1.0,
    subset: [
      { id: "t/a", capability: "x", run: () => {} },
      { id: "t/b", capability: "x", run: () => {} },
    ],
  };
  const result = checkPhaseThreshold(exact);
  assert.equal(result.passRate, 1);
  assert.equal(result.meetsTarget, true);
});

void test("checkProgressiveThresholds detects a non-monotonic (broken) ladder", () => {
  const broken: readonly PhaseTarget[] = [
    { id: "a", targetPassRate: 0.99, subset: [{ id: "t", capability: "x", run: () => {} }] },
    { id: "b", targetPassRate: 0.9, subset: [{ id: "t", capability: "x", run: () => {} }] }, // drops!
  ];
  const result = checkProgressiveThresholds(broken);
  assert.equal(result.ladderMonotonic, false, "a descending target must be flagged");
});

void test("the four configured rungs map to the four phases in order", () => {
  assert.deepEqual(
    PHASE_TARGETS.map((t) => t.id),
    ["phase-1 / vertical-slice", "phase-2-4 / A-tier", "phase-5-7 / B-tier", "phase-8 / C-tier"],
  );
});
