/**
 * Tests for the Phase 2-4 ("逼近 A 档") WPT subset, configured target threshold,
 * forward-only regression gate, and scoreboard (task 5.12).
 *
 * Built by `tsc` then run with: `node --test packages/cli/dist/*.test.js`.
 *
 * Covers the Phase 2-4 success criteria (design.md §5, §9.1):
 *   - Req 15.5: when the configured Phase 2-4 WPT subset (html-parsing +
 *     css-cascade + css-layout block/inline) runs, the pass rate meets or
 *     exceeds the configured Phase target threshold.
 *   - Req 10.2: a commit that lowers the WPT subset pass count below the
 *     forward-only baseline is blocked by the regression gate; a flat (or
 *     higher) count is allowed.
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { WptSubset } from "@browser-engine/scoreboard";

import {
  checkWptRegressionGate,
  checkWptSubset,
  runPhase0Checks,
} from "./checks.js";
import {
  PHASE2_CAPABILITIES,
  PHASE2_GROUPS,
  PHASE2_GROUP_NAMES,
  PHASE2_TARGET_PASS_RATE,
  PHASE2_WPT_BASELINE,
  PHASE2_WPT_SUBSET,
  computePhase2Scoreboard,
  phase2PassRate,
  runPhase2WptSubset,
} from "./phase2.js";

// ---------------------------------------------------------------------------
// Req 15.5 — the configured subset's pass rate meets the configured threshold
// ---------------------------------------------------------------------------

void test("Req 15.5: every Phase 2-4 WPT check passes (no failures across the configured subset)", () => {
  const summary = runPhase2WptSubset();
  assert.equal(summary.total, PHASE2_WPT_SUBSET.length);
  assert.equal(
    summary.failCount,
    0,
    summary.results
      .filter((r) => r.verdict === "fail")
      .map((r) => `${r.id}: ${r.error ?? "returned false"}`)
      .join("\n"),
  );
  assert.equal(summary.passCount, PHASE2_WPT_SUBSET.length, "every configured check must pass");
});

void test("Req 15.5: the configured subset pass rate meets or exceeds the configured Phase target threshold", () => {
  // The Phase 2-4 pass RATE is the success-criteria number: it must be >= the
  // single configured target so the gate measures a real, on-target subset.
  assert.ok(
    phase2PassRate() >= PHASE2_TARGET_PASS_RATE,
    `pass rate ${phase2PassRate()} fell below the configured target ${PHASE2_TARGET_PASS_RATE}`,
  );
  // The target is a valid rate (a fraction in (0, 1]).
  assert.ok(PHASE2_TARGET_PASS_RATE > 0 && PHASE2_TARGET_PASS_RATE <= 1);
});

void test("Req 15.5: the WPT subset check reports the full passing count for the configured subset", () => {
  const result = checkWptSubset(PHASE2_WPT_SUBSET);
  assert.equal(result.passed, true, result.detail);
  assert.match(result.detail, new RegExp(`${PHASE2_WPT_SUBSET.length} passing`));
});

// ---------------------------------------------------------------------------
// Req 15.5 — capability + group coverage of the three success-criteria groups
// ---------------------------------------------------------------------------

void test("Req 15.5: every configured Phase 2-4 capability is covered by at least one passing check", () => {
  const summary = runPhase2WptSubset();
  for (const capability of PHASE2_CAPABILITIES) {
    assert.ok(
      summary.passingCapabilities.has(capability),
      `no passing WPT check covers capability "${capability}"`,
    );
  }
});

void test("Req 15.5: all three configured groups (html-parsing, css-cascade, css-layout) are represented", () => {
  // The subset ids are namespaced `phase2/<group>/...`, so the group is the
  // second path segment. Each configured group must appear in the subset.
  const groupsInSubset = new Set(PHASE2_WPT_SUBSET.map((t) => t.id.split("/")[1]));
  for (const group of PHASE2_GROUP_NAMES) {
    assert.ok(groupsInSubset.has(group), `no check belongs to the "${group}" group`);
  }
  // And the three configured groups are exactly the success-criteria triple.
  assert.deepEqual([...PHASE2_GROUP_NAMES], ["html-parsing", "css-cascade", "css-layout"]);
});

void test("Req 15.5: every capability a check declares belongs to one of the configured groups", () => {
  const declared = new Set<string>(PHASE2_CAPABILITIES);
  for (const test_ of PHASE2_WPT_SUBSET) {
    assert.ok(
      declared.has(test_.capability),
      `check ${test_.id} declares capability "${test_.capability}" not in any configured group`,
    );
  }
  // PHASE2_CAPABILITIES is exactly the flattened group capabilities.
  const flattened = PHASE2_GROUP_NAMES.flatMap((g) => PHASE2_GROUPS[g]);
  assert.deepEqual([...PHASE2_CAPABILITIES], flattened);
});

// ---------------------------------------------------------------------------
// Req 10.2 — the forward-only WPT pass-count regression gate
// ---------------------------------------------------------------------------

void test("Req 10.2: the regression gate PASSES at the current baseline (live count === baseline)", () => {
  // The live subset passes every check, so the live pass count equals the
  // forward-only baseline — flat is allowed, the merge is not blocked.
  assert.equal(runPhase2WptSubset().passCount, PHASE2_WPT_BASELINE);
  const result = checkWptRegressionGate();
  assert.equal(result.passed, true, result.detail);
  assert.match(result.detail, new RegExp(`≥ baseline ${PHASE2_WPT_BASELINE}`));
});

void test("Req 10.2: the gate BLOCKS when the live pass count is below a higher (synthetic) baseline", () => {
  // Simulate a regression by defending a baseline higher than the live pass
  // count: the live subset still passes all 25, but a baseline of +1 means the
  // measured count dropped below the stored baseline ⇒ the merge is blocked.
  const higherBaseline = PHASE2_WPT_BASELINE + 1;
  const result = checkWptRegressionGate(PHASE2_WPT_SUBSET, higherBaseline);
  assert.equal(result.passed, false, "a pass count below the baseline must block the merge");
  assert.match(result.detail, /regressed/);
  assert.match(result.detail, /merge blocked/);
});

void test("Req 10.2: the gate BLOCKS when a deliberately-failing check drops the live count below the baseline", () => {
  // The other way to regress: keep the baseline but feed a subset whose live
  // pass count is lower (a deliberately-failing check). Build a subset that is
  // strictly smaller than the baseline so the live count cannot reach it.
  const failingSubset: WptSubset = [
    {
      id: "phase2/regression/deliberately-failing.html",
      capability: "css-selector-type",
      run: () => {
        throw new Error("synthetic failure to simulate a compatibility regression");
      },
    },
  ];
  const summary = runPhase2WptSubset();
  // Defend the real baseline against a subset that passes 0 of 1.
  const result = checkWptRegressionGate(failingSubset, summary.passCount);
  assert.equal(result.passed, false, "a regressed pass count must block the merge");
  assert.match(result.detail, /merge blocked/);
});

void test("Req 10.2: forward progress (a higher live count) is allowed by the gate", () => {
  // A baseline lower than the live count is forward progress, never blocked.
  const lowerBaseline = Math.max(0, PHASE2_WPT_BASELINE - 1);
  const result = checkWptRegressionGate(PHASE2_WPT_SUBSET, lowerBaseline);
  assert.equal(result.passed, true, result.detail);
});

// ---------------------------------------------------------------------------
// Req 15.5 — the Phase 2-4 scoreboard holds a valid pass count + capabilities
// ---------------------------------------------------------------------------

void test("Req 15.5: the Phase 2-4 scoreboard holds a valid pass count equal to the subset size", () => {
  const board = computePhase2Scoreboard();
  assert.equal(Number.isInteger(board.passCount), true);
  assert.ok(board.passCount >= 0);
  assert.ok(board.passCount <= PHASE2_WPT_SUBSET.length);
  assert.equal(board.passCount, PHASE2_WPT_SUBSET.length, "every Phase 2-4 WPT check passes");
  assert.equal(board.wpt.failCount, 0);
});

void test("Req 15.5: the scoreboard reports every configured Phase 2-4 capability as implemented", () => {
  const board = computePhase2Scoreboard();
  const reported = new Map(board.capabilities.map((c) => [c.capability, c]));
  assert.equal(board.capabilities.length, PHASE2_CAPABILITIES.length);
  for (const capability of PHASE2_CAPABILITIES) {
    const report = reported.get(capability);
    assert.ok(report, `capability "${capability}" is missing from the scoreboard`);
    assert.equal(
      report.status,
      "implemented",
      `capability "${capability}" should be implemented (has a passing WPT check)`,
    );
  }
});

void test("Req 15.5: the held pass count is independent of the (optional) LOC denominator", () => {
  const board = computePhase2Scoreboard({
    sourceFiles: [{ path: "packages/cli/src/phase2.ts", content: "const a = 1;\nconst b = 2;\n" }],
  });
  assert.equal(board.loc.handWritten, 2);
  assert.equal(board.compatPerLoc, board.passCount / 2);
  assert.equal(board.passCount, PHASE2_WPT_SUBSET.length);
});

// ---------------------------------------------------------------------------
// The overall constitution gate stays GREEN with the Phase 2-4 subset wired in
// ---------------------------------------------------------------------------

void test("the constitution check gate is green with the Phase 2-4 subset + regression gate wired in", () => {
  const status = runPhase0Checks();
  assert.equal(status.passed, true, JSON.stringify(status.checks, null, 2));
  const names = new Set(status.checks.map((c) => c.name));
  // The Phase 2-4 numerator source and its forward-only regression gate run.
  assert.ok(names.has("wpt-subset"), "the WPT subset runner is wired (Req 15.5)");
  assert.ok(names.has("wpt-regression"), "the WPT regression gate is wired (Req 10.2)");

  // The wired WPT subset check reports the full Phase 2-4 passing count.
  const wpt = status.checks.find((c) => c.name === "wpt-subset");
  assert.ok(wpt);
  assert.equal(wpt.passed, true, wpt.detail);
  assert.match(wpt.detail, new RegExp(`${PHASE2_WPT_SUBSET.length} passing`));

  // The wired regression gate passes at the current baseline (flat count).
  const regression = status.checks.find((c) => c.name === "wpt-regression");
  assert.ok(regression);
  assert.equal(regression.passed, true, regression.detail);
});
