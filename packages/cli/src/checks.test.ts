/**
 * Tests for the Phase 0 empty-pipeline check gate (task 1.10).
 *
 * Built by `tsc` then run with: `node --test packages/cli/dist/*.test.js`.
 *
 * Validates the Phase 0 constitution requirements:
 *   - 12.4: a commit runs the WPT subset, reftest suite, AND differential harness.
 *   - 12.5: with every stage signaling NotImplemented and empty WPT/reftest
 *     baselines, ALL configured checks report passing (the green baseline).
 *   - 12.6: when no commit is submitted, the reported status is passing.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { encodePng } from "@browser-engine/test-harness";

import {
  checkDifferential,
  checkEmptyPipeline,
  checkReftests,
  checkWptSubset,
  runPhase0Checks,
  statusForCommit,
  type ReftestBaseline,
} from "./checks.js";

// ---------------------------------------------------------------------------
// Req 12.5 — the empty pipeline with NotImplemented stages is the green baseline
// ---------------------------------------------------------------------------

void test("Req 12.5: every configured Phase 0 check passes", () => {
  const status = runPhase0Checks();
  assert.equal(status.passed, true, JSON.stringify(status.checks, null, 2));
  for (const check of status.checks) {
    assert.equal(check.passed, true, `${check.name}: ${check.detail}`);
  }
});

void test("Req 12.4: the gate wires all three check types plus the empty-pipeline invariant", () => {
  const status = runPhase0Checks();
  const names = new Set(status.checks.map((c) => c.name));
  assert.ok(names.has("wpt-subset"), "WPT subset runner is wired (Req 10.1)");
  assert.ok(names.has("reftest-suite"), "reftest suite is wired (Req 10.4)");
  assert.ok(names.has("differential-harness"), "differential harness is wired (Req 9.2)");
  assert.ok(names.has("empty-pipeline"), "empty-pipeline invariant is checked (Req 12.5)");
});

void test("Req 12.5: empty pipeline passes because stages signal NotImplemented (not a placeholder)", () => {
  const result = checkEmptyPipeline();
  assert.equal(result.passed, true);
  assert.match(result.detail, /NotImplemented/);
});

// ---------------------------------------------------------------------------
// Individual checks: honest empty Phase 0 baselines
// ---------------------------------------------------------------------------

void test("Req 10.1: the empty WPT subset passes with zero failures", () => {
  const result = checkWptSubset();
  assert.equal(result.passed, true);
  assert.match(result.detail, /0 passing \/ 0 total/);
});

void test("Req 10.4: the empty reftest baseline set passes vacuously", () => {
  const result = checkReftests();
  assert.equal(result.passed, true);
});

void test("Req 9.2: the naive-vs-naive differential campaign is byte-for-byte identical", () => {
  const result = checkDifferential();
  assert.equal(result.passed, true);
  assert.match(result.detail, /identical/);
});

// ---------------------------------------------------------------------------
// Reftest check actually compares pixels (proves it is not a no-op)
// ---------------------------------------------------------------------------

void test("checkReftests passes a matching baseline and fails a mismatched one within threshold", () => {
  const width = 2;
  const height = 2;
  const solid = (r: number, g: number, b: number): Uint8Array => {
    const data = new Uint8Array(width * height * 4);
    for (let p = 0; p < width * height; p += 1) {
      data[p * 4] = r;
      data[p * 4 + 1] = g;
      data[p * 4 + 2] = b;
      data[p * 4 + 3] = 255;
    }
    return encodePng({ width, height, data });
  };

  const red = solid(255, 0, 0);
  const blue = solid(0, 0, 255);

  const matching: ReftestBaseline = { name: "match", rendered: red, reference: red };
  assert.equal(checkReftests([matching]).passed, true);

  const mismatched: ReftestBaseline = {
    name: "mismatch",
    rendered: red,
    reference: blue,
    options: { maxDiffPixels: 0 },
  };
  assert.equal(checkReftests([mismatched]).passed, false);
});

// ---------------------------------------------------------------------------
// Req 12.6 — no commit → passing status
// ---------------------------------------------------------------------------

void test("Req 12.6: with no commit submitted the status is passing and no checks ran", () => {
  const status = statusForCommit(null);
  assert.equal(status.passed, true);
  assert.equal(status.ran, false);
  assert.equal(status.checks.length, 0);
});

void test("Req 12.4/12.5: a submitted commit runs the full gate and passes", () => {
  const status = statusForCommit({ id: "deadbeef" });
  assert.equal(status.ran, true);
  assert.equal(status.passed, true);
  assert.ok(status.checks.length >= 4);
});
