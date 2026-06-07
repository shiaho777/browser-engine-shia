/**
 * Tests for the PROPORTIONAL metrics shaper (the honest fidelity step beyond the
 * monospace {@link metricsShaper}). Proves advances are proportional (`i` < `m`),
 * derived from the DATA table, and that line breaking honours them — without
 * disturbing the monospace default that existing geometry tests rely on.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { px } from "@browser-engine/ir";

import {
  defaultShaper,
  metricsShaper,
  proportionalShaper,
  proportionalAdvanceEm,
} from "./index.js";

const FONT = { fontSize: px(16) } as const;

void test("the default shaper is still the monospace placeholder (no geometry regression)", () => {
  assert.equal(defaultShaper, metricsShaper);
  assert.notEqual(defaultShaper, proportionalShaper);
});

void test("proportional advances are actually proportional: i < o < m", () => {
  const adv = (ch: string): number => Number(proportionalShaper.shapeLine(ch, FONT).advance);
  assert.ok(adv("i") < adv("o"), `i (${adv("i")}) must be narrower than o (${adv("o")})`);
  assert.ok(adv("o") < adv("m"), `o (${adv("o")}) must be narrower than m (${adv("m")})`);
  assert.ok(adv("l") < adv("W"), "l must be far narrower than W");
});

void test("a run's total advance equals the exact sum of its glyph advances", () => {
  const run = proportionalShaper.shapeLine("Wim", FONT);
  const sum = run.glyphs.reduce((t, g) => t + Number(g.advance), 0);
  assert.equal(Number(run.advance), sum);
  assert.equal(run.glyphs.length, 3, "one glyph slot per code unit");
});

void test("advance is exactly fontSize × the data-table EM ratio", () => {
  for (const ch of ["i", "m", "A", "x", "@", " "]) {
    const expected = 16 * proportionalAdvanceEm(ch.codePointAt(0)!);
    assert.equal(Number(proportionalShaper.shapeLine(ch, FONT).advance), expected, `advance(${ch})`);
  }
});

void test("an unlisted glyph falls back to the normal width class", () => {
  // U+00E9 (é) is not in any membership list ⇒ the `normal` default.
  assert.equal(proportionalAdvanceEm(0x00e9), proportionalAdvanceEm("o".codePointAt(0)!));
});

void test("astral code points measure once (glyphs.length tracks code units)", () => {
  const run = proportionalShaper.shapeLine("a\u{1F600}b", FONT); // emoji = 2 UTF-16 units.
  assert.equal(run.glyphs.length, 4, "3 code points, 4 code units");
  // The surrogate pair contributes a single advance (on its first unit).
  assert.equal(Number(run.glyphs[2]!.advance), 0, "trailing surrogate half adds no advance");
});
