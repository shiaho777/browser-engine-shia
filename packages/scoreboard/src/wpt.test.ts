/**
 * Tests for the WPT subset runner + pass-count statistics (task 1.7).
 *
 * Built by `tsc` then run with: `node --test packages/scoreboard/dist/*.test.js`.
 *
 * Covers design.md §9.1 and Requirements 1.5 / 10.1 / 10.3:
 *   - the pass count is the metric numerator and must be counted faithfully;
 *   - a test fails by throwing (incl. NotImplemented) or returning false;
 *   - one failing test never aborts the whole subset run;
 *   - an empty (Phase 0) subset is the honest zero starting point.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { runWptSubset, runWptTest, type WptSubset, type WptTestCase } from "./wpt.js";

void test("Req 1.5/10.1: empty subset is the honest zero starting point", () => {
  const summary = runWptSubset([]);
  assert.equal(summary.total, 0);
  assert.equal(summary.passCount, 0);
  assert.equal(summary.failCount, 0);
  assert.equal(summary.results.length, 0);
  assert.equal(summary.passingCapabilities.size, 0);
});

void test("a test that completes without throwing passes", () => {
  const result = runWptTest({ id: "t1", capability: "cap-a", run: () => {} });
  assert.equal(result.verdict, "pass");
});

void test("a test that returns true passes; returning false fails", () => {
  assert.equal(runWptTest({ id: "t", capability: "c", run: () => true }).verdict, "pass");
  assert.equal(runWptTest({ id: "t", capability: "c", run: () => false }).verdict, "fail");
});

void test("a throwing test fails and captures the error message (no propagation)", () => {
  const result = runWptTest({
    id: "boom",
    capability: "cap-x",
    run: () => {
      throw new Error("assertion failed: expected 1 got 2");
    },
  });
  assert.equal(result.verdict, "fail");
  assert.equal(result.error, "assertion failed: expected 1 got 2");
});

void test("Req 1.5/10.1: pass count tallies only passing tests; one failure does not abort the run", () => {
  const subset: WptSubset = [
    { id: "p1", capability: "cap-a", run: () => true },
    {
      id: "f1",
      capability: "cap-b",
      run: () => {
        throw new Error("nope");
      },
    },
    { id: "p2", capability: "cap-a", run: () => {} },
    { id: "f2", capability: "cap-c", run: () => false },
  ];

  const summary = runWptSubset(subset);
  assert.equal(summary.total, 4);
  assert.equal(summary.passCount, 2);
  assert.equal(summary.failCount, 2);
  // All four ran despite the failures in the middle.
  assert.equal(summary.results.length, 4);
  // Capabilities with at least one passing test (cap-b/cap-c never passed).
  assert.deepEqual([...summary.passingCapabilities].sort(), ["cap-a"]);
});

void test("Property: passCount + failCount === total and passCount equals the number of passing tests", () => {
  // **Validates: Requirements 1.5**
  const arbTest = fc
    .record({
      id: fc.string({ minLength: 1 }),
      capability: fc.constantFrom("cap-a", "cap-b", "cap-c"),
      outcome: fc.constantFrom("pass-void", "pass-true", "fail-false", "fail-throw"),
    })
    .map(
      ({ id, capability, outcome }): { test: WptTestCase; passes: boolean } => ({
        passes: outcome === "pass-void" || outcome === "pass-true",
        test: {
          id,
          capability,
          run: () => {
            switch (outcome) {
              case "pass-void":
                return undefined;
              case "pass-true":
                return true;
              case "fail-false":
                return false;
              default:
                throw new Error("boom");
            }
          },
        },
      }),
    );

  fc.assert(
    fc.property(fc.array(arbTest, { maxLength: 50 }), (cases) => {
      const subset = cases.map((c) => c.test);
      const expectedPass = cases.filter((c) => c.passes).length;
      const summary = runWptSubset(subset);
      return (
        summary.total === cases.length &&
        summary.passCount === expectedPass &&
        summary.passCount + summary.failCount === summary.total &&
        summary.results.length === cases.length
      );
    }),
  );
});
