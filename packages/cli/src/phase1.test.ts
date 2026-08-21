/**
 * Tests for the Phase 1 vertical-slice fixtures (task 3.12).
 *
 * Built by `tsc` then run with: `node --test packages/cli/dist/*.test.js`.
 *
 * Covers the Phase 1 success criteria (design.md §5, §9.1):
 *   - Req 14.3: the `<div>hello</div>` reftest passes the pixel comparison
 *     against its committed reference image within the configured threshold.
 *   - Req 14.4: when Phase 1 completes, the Scoreboard holds a VALID WPT subset
 *     pass count, INDEPENDENT of whether the scoreboard display / screenshot
 *     renders (or publishes) successfully.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { compareReftest } from "@browser-engine/test-harness";
import { publishScoreboard } from "@browser-engine/scoreboard";

import { checkReftests, checkWptSubset } from "./checks.js";
import {
  DIV_HELLO_SOURCE,
  PHASE1_CAPABILITIES,
  PHASE1_WPT_SUBSET,
  computePhase1Scoreboard,
  divHelloBaseline,
  loadDivHelloReference,
  phase1Reftests,
  renderDivHelloPng,
} from "./phase1.js";

// ---------------------------------------------------------------------------
// Req 14.3 — the <div>hello</div> reftest baseline passes within threshold
// ---------------------------------------------------------------------------

void test("Req 14.3: <div>hello</div> matches its committed reference within the configured threshold", () => {
  const rendered = renderDivHelloPng();
  const reference = loadDivHelloReference();

  // The BASELINE's configured threshold passes (it absorbs cross-platform
  // glyph anti-aliasing variance — see DIV_HELLO_MAX_DIFF_PIXELS).
  const baseline = divHelloBaseline();
  const result = compareReftest(rendered, reference, baseline.options);
  assert.equal(result.pass, true, `diffPixels=${result.diffPixels}/${result.totalPixels}`);
});

void test("Req 14.3: the reftest baseline is stable — fresh renders are byte-for-byte identical", () => {
  // The pipeline is pure, so re-rendering on the SAME platform produces
  // identical bytes; this is what makes a committed reference image a sound,
  // stable baseline. (Cross-platform, system-font anti-aliasing differs —
  // the committed threshold absorbs that; see divHelloBaseline.)
  assert.deepEqual([...renderDivHelloPng()], [...renderDivHelloPng()]);
});

void test("Req 14.3: the div-hello baseline is in the suite the check gate runs and it passes", () => {
  const baselines = phase1Reftests();
  assert.ok(
    baselines.some((b) => b.name === "div-hello"),
    "the <div>hello</div> baseline must be configured in the reftest suite",
  );
  const result = checkReftests(baselines);
  assert.equal(result.passed, true, result.detail);
});

void test("divHelloBaseline renders the documented Phase 1 vertical-slice document", () => {
  assert.equal(DIV_HELLO_SOURCE, "<div>hello</div>");
  const baseline = divHelloBaseline();
  assert.equal(baseline.name, "div-hello");
  // Rendered and reference are real PNGs of the same document; they match
  // within the configured threshold (cross-platform glyph anti-aliasing
  // variance — see DIV_HELLO_MAX_DIFF_PIXELS).
  assert.ok(baseline.rendered.length > 0);
  const result = compareReftest(baseline.rendered, baseline.reference, baseline.options);
  assert.equal(result.pass, true, `diffPixels=${result.diffPixels}/${result.totalPixels}`);
});

// ---------------------------------------------------------------------------
// Req 14.4 — the scoreboard holds a valid WPT pass count, independent of display
// ---------------------------------------------------------------------------

void test("Req 14.4: the Phase 1 scoreboard holds a valid (real, > 0) WPT pass count", () => {
  const board = computePhase1Scoreboard();

  // A valid number: a non-negative integer no greater than the subset size.
  assert.equal(Number.isInteger(board.passCount), true);
  assert.ok(board.passCount >= 0);
  assert.ok(board.passCount <= PHASE1_WPT_SUBSET.length);

  // Phase 1 ships real, passing checks, so the held number is genuinely > 0
  // (design.md §5: "一个真实(虽小)的数字").
  assert.ok(board.passCount > 0, "Phase 1 must hold a real, non-zero pass count");
  assert.equal(board.passCount, PHASE1_WPT_SUBSET.length, "every Phase 1 WPT check passes");
  assert.equal(board.wpt.failCount, 0);
});

void test("Req 14.4: the held pass count is INDEPENDENT of whether the display/screenshot renders", () => {
  // Compute the pass count with NO reftest/display evidence at all.
  const withoutDisplay = computePhase1Scoreboard({ reftests: [] });

  // Now compute it with display evidence flipped both ways. A failing display
  // (reftest) must NOT lower the pass count, and a succeeding one must not
  // raise it: the WPT pass count is decoupled from display success.
  const withFailingDisplay = computePhase1Scoreboard({
    reftests: [{ capability: "render-pipeline", pass: false }],
  });
  const withPassingDisplay = computePhase1Scoreboard({
    reftests: [{ capability: "render-pipeline", pass: true }],
  });

  assert.equal(withFailingDisplay.passCount, withoutDisplay.passCount);
  assert.equal(withPassingDisplay.passCount, withoutDisplay.passCount);
  assert.ok(withoutDisplay.passCount > 0, "a valid pass count is held with no display evidence");
});

void test("Req 14.4: a failed publish (CI/network/display) does NOT change the held pass count", async () => {
  const board = computePhase1Scoreboard();
  const heldBefore = board.passCount;

  // Simulate the scoreboard *display* failing to publish — Req 1.6 says this
  // must not block the commit, and Req 14.4 says the held count stays valid.
  const result = await publishScoreboard(board, () => {
    throw new Error("scoreboard display host unreachable");
  });

  assert.equal(result.published, false);
  assert.equal(result.commitAllowed, true);
  // The scoreboard snapshot's held count is unchanged by the publish outcome.
  assert.equal(board.passCount, heldBefore);
  assert.ok(board.passCount > 0);
});

void test("Req 14.4: the WPT subset check (the gate's numerator source) passes and reports the count", () => {
  const result = checkWptSubset(PHASE1_WPT_SUBSET);
  assert.equal(result.passed, true, result.detail);
  assert.match(result.detail, new RegExp(`${PHASE1_WPT_SUBSET.length} passing`));
});

void test("the Phase 1 subset exercises every Req 14.2 CSS capability plus the render pipeline", () => {
  const covered = new Set(PHASE1_WPT_SUBSET.map((t) => t.capability));
  for (const capability of PHASE1_CAPABILITIES) {
    assert.ok(covered.has(capability), `no WPT check covers capability "${capability}"`);
  }
});

void test("Req 14.4: passing real source files yields a real compat-per-LOC without affecting the count", () => {
  const board = computePhase1Scoreboard({
    sourceFiles: [{ path: "packages/cli/src/phase1.ts", content: "const a = 1;\nconst b = 2;\n" }],
  });
  assert.equal(board.loc.handWritten, 2);
  assert.equal(board.compatPerLoc, board.passCount / 2);
  // The denominator does not perturb the numerator (the held pass count).
  assert.equal(board.passCount, PHASE1_WPT_SUBSET.length);
});
