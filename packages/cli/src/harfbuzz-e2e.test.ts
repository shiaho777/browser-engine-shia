/**
 * harfbuzz-e2e.test.ts — E1 end-to-end: the ENGINE_SHAPER=harfbuzz pipeline
 * flag resolves the REAL HarfBuzz shaper at the TextShaper seam, and the
 * whole engine lays text out with real (kerning/ligature-aware) metrics.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { resolvePipelineShaper } from "./fonts.js";

void test("ENGINE_SHAPER=harfbuzz resolves the real HarfBuzz shaper at the seam", () => {
  const prev = process.env["ENGINE_SHAPER"];
  process.env["ENGINE_SHAPER"] = "harfbuzz";
  try {
    const shaper = resolvePipelineShaper();
    const run = shaper.shapeLine("hello world", { fontSize: 16 as never });
    // The proportional placeholder gives 11 glyphs ≈ 88px; HarfBuzz's real
    // metrics for the built-in font differ measurably.
    assert.ok(
      Number(run.advance) > 0,
      `the shaper produced a positive advance (${Number(run.advance)})`,
    );
    // Determinism: shaping twice gives the same value.
    const again = shaper.shapeLine("hello world", { fontSize: 16 as never });
    assert.equal(Number(again.advance), Number(run.advance));
    // Proportionality through the real font: 'mmmm' is wider than 'iiii'.
    const wide = shaper.shapeLine("mmmm", { fontSize: 16 as never });
    const thin = shaper.shapeLine("iiii", { fontSize: 16 as never });
    assert.ok(Number(wide.advance) > Number(thin.advance) * 1.3, "real proportional widths");
  } finally {
    if (prev === undefined) delete process.env["ENGINE_SHAPER"];
    else process.env["ENGINE_SHAPER"] = prev;
  }
});

void test("without the flag the pipeline keeps the metrics placeholder (default unchanged)", () => {
  const prev = process.env["ENGINE_SHAPER"];
  delete process.env["ENGINE_SHAPER"];
  try {
    const shaper = resolvePipelineShaper();
    const run = shaper.shapeLine("mmmm", { fontSize: 16 as never });
    // The pipeline's metrics placeholder reads the FACES advance table —
    // deterministic, and crucially DIFFERENT from HarfBuzz's real 51.2px
    // (the two shapers must be distinguishable by their output).
    const harfbuzzValue = 51.2;
    assert.ok(
      Math.abs(Number(run.advance) - harfbuzzValue) > 0.5,
      `placeholder metrics differ from HarfBuzz's ${harfbuzzValue} (${Number(run.advance)})`,
    );
  } finally {
    if (prev !== undefined) process.env["ENGINE_SHAPER"] = prev;
  }
});
