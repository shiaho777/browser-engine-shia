/**
 * Tests for the Phase 5-7 ("逼近 B 档") WPT subset, real-site smoke set,
 * configured target threshold, and the zero-silent-stub assertion (task 7.9).
 *
 * Built by `tsc` then run with: `node --test packages/cli/dist/*.test.js`.
 *
 * Covers the Phase 5-7 success criteria (design.md §5):
 *   - the configured B-tier WPT subset runs against the REAL Phase 5-7 code and
 *     meets the configured target pass rate (Requirement 16.x, 15.5-style);
 *   - the real-site smoke set passes (fetch-over-reused-stack + web-font apply);
 *   - the forward-only pass-count baseline matches the subset (Requirement 10.2);
 *   - ZERO silent stubs: every unimplemented guest-surface member throws
 *     NotImplemented and the scoreboard marks unimplemented capabilities red
 *     (Requirements 16.7, 5.4).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { computeScoreboard } from "@browser-engine/scoreboard";

import {
  PHASE3_CAPABILITIES,
  PHASE3_GROUPS,
  PHASE3_GROUP_NAMES,
  PHASE3_SMOKE_TESTS,
  PHASE3_TARGET_PASS_RATE,
  PHASE3_WPT_BASELINE,
  PHASE3_WPT_SUBSET,
  assertZeroSilentStubs,
  computePhase3Scoreboard,
  phase3PassRate,
  probeSilentStubs,
  runPhase3WptSubset,
  runSmokeTests,
} from "./phase3.js";
import { checkWptSubset } from "./checks.js";

// ---------------------------------------------------------------------------
// The Phase 5-7 WPT subset meets the configured target (design.md §5).
// ---------------------------------------------------------------------------

void test("Req 16.x: the Phase 5-7 WPT subset is non-empty and every check passes", () => {
  const summary = runPhase3WptSubset();
  assert.ok(summary.total > 0, "the B-tier subset must contain real checks");
  assert.equal(summary.failCount, 0, `every Phase 5-7 check must pass; failures: ${
    summary.results.filter((r) => r.verdict === "fail").map((r) => `${r.id} (${r.error ?? ""})`).join("; ")
  }`);
  assert.equal(summary.passCount, PHASE3_WPT_SUBSET.length);
});

void test("Req 16.x: the live pass rate meets or exceeds the configured target", () => {
  assert.ok(phase3PassRate() >= PHASE3_TARGET_PASS_RATE, "pass rate must meet the configured target");
  assert.equal(PHASE3_TARGET_PASS_RATE, 1.0);
});

void test("the subset exercises every configured B-tier capability across all groups", () => {
  const covered = new Set(PHASE3_WPT_SUBSET.map((t) => t.capability));
  for (const capability of PHASE3_CAPABILITIES) {
    assert.ok(covered.has(capability), `no Phase 5-7 WPT check covers capability "${capability}"`);
  }
  // The three configured groups are all represented.
  assert.deepEqual([...PHASE3_GROUP_NAMES], ["advanced-layout", "dom-and-js", "networking-and-fonts"]);
  for (const group of PHASE3_GROUP_NAMES) {
    assert.ok(PHASE3_GROUPS[group].length > 0, `group ${group} must declare capabilities`);
  }
});

void test("Req 10.2: the forward-only baseline equals the current passing subset size", () => {
  assert.equal(PHASE3_WPT_BASELINE, PHASE3_WPT_SUBSET.length);
  // The check gate's WPT subset check passes for the Phase 5-7 subset.
  const result = checkWptSubset(PHASE3_WPT_SUBSET);
  assert.equal(result.passed, true, result.detail);
});

// ---------------------------------------------------------------------------
// The real-site smoke set passes (design.md §5).
// ---------------------------------------------------------------------------

void test("design.md §5: the real-site smoke set passes end-to-end", async () => {
  const passed = await runSmokeTests();
  assert.equal(passed, PHASE3_SMOKE_TESTS.length, "every smoke scenario must pass");
  assert.ok(PHASE3_SMOKE_TESTS.length >= 2, "the smoke set must contain real scenarios");
});

void test("design.md §5: each smoke scenario is individually green", async () => {
  for (const smoke of PHASE3_SMOKE_TESTS) {
    await assert.doesNotReject(() => smoke.run(), `smoke scenario ${smoke.id} must pass`);
  }
});

// ---------------------------------------------------------------------------
// Zero silent stubs (Requirements 16.7, 5.4).
// ---------------------------------------------------------------------------

void test("Req 16.7/5.4: ZERO silent stubs — every unimplemented guest-surface member throws NotImplemented", () => {
  const report = probeSilentStubs();
  assert.ok(report.probed > 0, "the probe must touch real generated surface members");
  assert.deepEqual(
    report.silentStubs,
    [],
    `these guest-surface members returned a placeholder instead of throwing NotImplemented: ${report.silentStubs.join(", ")}`,
  );
});

void test("Req 16.7/5.4: assertZeroSilentStubs passes for the current surface", () => {
  assert.doesNotThrow(() => assertZeroSilentStubs());
  const report = assertZeroSilentStubs();
  assert.ok(report.probed > 0);
});

void test("Req 16.7/1.4: capabilities WITHOUT passing evidence are reported not-implemented (scoreboard red)", () => {
  // A capability the engine does not yet expose has no passing WPT/reftest, so
  // the scoreboard marks it not-implemented — the "red" the requirement wants.
  const board = computePhase3Scoreboard();
  const reported = new Map(board.capabilities.map((c) => [c.capability, c.status]));
  // Every configured B-tier capability HAS a passing check ⇒ implemented.
  for (const capability of PHASE3_CAPABILITIES) {
    assert.equal(reported.get(capability), "implemented", `${capability} should be implemented`);
  }
});

void test("Req 1.4: an unevidenced capability is marked not-implemented by the scoreboard", () => {
  // Add a bogus capability with no passing check: it must come back red.
  const board = computePhase3Scoreboard();
  const withBogus = board.capabilities.length;
  assert.ok(withBogus > 0);
  // Recompute with an extra capability that no WPT test covers.
  const extended = computePhase3ScoreboardWith("totally-unimplemented-capability");
  const bogus = extended.capabilities.find((c) => c.capability === "totally-unimplemented-capability");
  assert.equal(bogus?.status, "not-implemented");
  assert.equal(bogus?.hasPassingWpt, false);
});

// ---------------------------------------------------------------------------
// Scoreboard validity (independent of display; Req 14.4-style discipline).
// ---------------------------------------------------------------------------

void test("the Phase 5-7 scoreboard holds a valid, non-zero pass count", () => {
  const board = computePhase3Scoreboard();
  assert.equal(Number.isInteger(board.passCount), true);
  assert.ok(board.passCount > 0);
  assert.equal(board.passCount, PHASE3_WPT_SUBSET.length);
  assert.equal(board.wpt.failCount, 0);
});

/** Helper: compute the Phase 5-7 scoreboard with one extra (bogus) capability. */
function computePhase3ScoreboardWith(extraCapability: string) {
  return computeScoreboardWithCapabilities([...PHASE3_CAPABILITIES, extraCapability]);
}

/** Compute a scoreboard over the Phase 5-7 subset with an arbitrary capability list. */
function computeScoreboardWithCapabilities(capabilities: readonly string[]) {
  return computeScoreboard({
    wptSubset: PHASE3_WPT_SUBSET,
    sourceFiles: [],
    capabilities,
    reftests: [],
  });
}
