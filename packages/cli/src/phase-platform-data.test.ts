/**
 * Tests for the platform-as-data layout/compositing WPT subset + scoreboard
 * wiring (platform-as-data-layout spec, task 6.3; Requirements 9.1, 9.2, 9.3).
 *
 * Built by `tsc` then run with: `node --test packages/cli/dist/*.test.js`.
 *
 * These assert the Scoreboard counts the newly-connected capabilities as
 * implemented ONLY on the basis of a passing real-document check, and that the
 * subset is forward-only.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { computeScoreboard } from "@browser-engine/scoreboard";

import {
  PLATFORM_DATA_CAPABILITIES,
  PLATFORM_DATA_WPT_BASELINE,
  PLATFORM_DATA_WPT_SUBSET,
  computePlatformDataScoreboard,
  runPlatformDataWptSubset,
} from "./phase-platform-data.js";

void test("Req 9.1: every connected capability passes its real-document check", () => {
  const summary = runPlatformDataWptSubset();
  assert.ok(summary.total > 0, "the subset must contain real-document checks");
  assert.equal(summary.failCount, 0, `every check must pass; failures: ${
    summary.results.filter((r) => r.verdict === "fail").map((r) => `${r.id} (${r.error ?? ""})`).join("; ")
  }`);
  assert.equal(summary.passCount, PLATFORM_DATA_WPT_SUBSET.length);
});

void test("Req 9.1: the scoreboard reports every connected capability as implemented", () => {
  const board = computePlatformDataScoreboard();
  const status = new Map(board.capabilities.map((c) => [c.capability, c.status]));
  for (const capability of PLATFORM_DATA_CAPABILITIES) {
    assert.equal(status.get(capability), "implemented", `${capability} must be implemented (real-document evidence)`);
  }
});

void test("Req 9.2: a capability with NO real-document check is NOT reported implemented", () => {
  // Add a capability that no check in the subset covers: it must come back red,
  // i.e. implemented status is granted ONLY on real-document evidence.
  const board = computeScoreboard({
    wptSubset: PLATFORM_DATA_WPT_SUBSET,
    sourceFiles: [],
    capabilities: [...PLATFORM_DATA_CAPABILITIES, "compositing-filter-not-connected"],
    reftests: [],
  });
  const bogus = board.capabilities.find((c) => c.capability === "compositing-filter-not-connected");
  assert.equal(bogus?.status, "not-implemented");
  assert.equal(bogus?.hasPassingWpt, false);
});

void test("Req 9.3: the subset is forward-only (baseline equals the passing count)", () => {
  assert.equal(PLATFORM_DATA_WPT_BASELINE, PLATFORM_DATA_WPT_SUBSET.length);
  const board = computePlatformDataScoreboard();
  assert.equal(board.passCount, PLATFORM_DATA_WPT_BASELINE);
});

void test("the subset covers each connected capability exactly", () => {
  const covered = new Set(PLATFORM_DATA_WPT_SUBSET.map((t) => t.capability));
  for (const capability of PLATFORM_DATA_CAPABILITIES) {
    assert.ok(covered.has(capability), `no real-document check covers ${capability}`);
  }
});
