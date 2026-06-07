/**
 * Tests for bidirectional text ordering + complex-script itemization (task 9.1;
 * design.md §5 Phase 8+; Requirement 17.1 — "THE Layout_Engine SHALL support
 * bidirectional text ordering and complex-script shaping").
 *
 * Built by `tsc` then run with: `node --test packages/layout/dist/*.test.js`.
 *
 * These assert the engine-owned half of international text (UAX #9 ordering and
 * script itemization; the glyph shaping itself is reused from HarfBuzz at the
 * TextShaper seam):
 *   - base-direction detection (first strong char, default LTR);
 *   - bidi class assignment for Latin / Hebrew / Arabic / digits;
 *   - visual reordering of an RTL run inside LTR text (and vice versa);
 *   - directional run segmentation;
 *   - script itemization for per-run complex-script shaping.
 *
 * Pure-ASCII / Latin text must pass through ordering UNCHANGED (visual ===
 * logical), so the common case is provably untouched.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  baseDirection,
  bidiClass,
  bidiRuns,
  reorderVisual,
  resolveLevels,
  scriptOf,
  scriptRuns,
} from "./bidi.js";

// Sample RTL strings (kept short; comments give the logical content).
const HEBREW = "\u05d0\u05d1\u05d2"; // three Hebrew letters (alef, bet, gimel)
const ARABIC = "\u0627\u0628\u062c"; // three Arabic letters

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

void test("bidiClass classifies Latin, Hebrew, Arabic, digits, and whitespace", () => {
  assert.equal(bidiClass("a"), "L");
  assert.equal(bidiClass("Z"), "L");
  assert.equal(bidiClass("\u05d0"), "R"); // Hebrew alef
  assert.equal(bidiClass("\u0628"), "AL"); // Arabic beh
  assert.equal(bidiClass("5"), "EN");
  assert.equal(bidiClass("\u0660"), "AN"); // Arabic-Indic zero
  assert.equal(bidiClass(" "), "WS");
  assert.equal(bidiClass("!"), "ON");
});

void test("scriptOf classifies scripts for itemization", () => {
  assert.equal(scriptOf("a"), "latin");
  assert.equal(scriptOf("\u05d0"), "hebrew");
  assert.equal(scriptOf("\u0628"), "arabic");
  assert.equal(scriptOf("\u4e2d"), "han"); // CJK
  assert.equal(scriptOf("5"), "common");
  assert.equal(scriptOf(" "), "common");
});

// ---------------------------------------------------------------------------
// Base direction (UAX #9 P2/P3)
// ---------------------------------------------------------------------------

void test("Req 17.1: base direction is the first strong character (default LTR)", () => {
  assert.equal(baseDirection("hello"), "ltr");
  assert.equal(baseDirection(HEBREW), "rtl");
  assert.equal(baseDirection(ARABIC), "rtl");
  // Leading neutrals/digits are skipped; the first STRONG char decides.
  assert.equal(baseDirection("123 " + HEBREW), "rtl");
  assert.equal(baseDirection("  hello"), "ltr");
  // No strong character ⇒ LTR.
  assert.equal(baseDirection("123 !!!"), "ltr");
  // Explicit override wins.
  assert.equal(baseDirection("hello", "rtl"), "rtl");
});

// ---------------------------------------------------------------------------
// Visual reordering (UAX #9 L2)
// ---------------------------------------------------------------------------

void test("Req 17.1: pure-LTR text reorders to itself (visual === logical)", () => {
  assert.equal(reorderVisual("hello world"), "hello world");
  assert.equal(reorderVisual("abc 123 def"), "abc 123 def");
});

void test("Req 17.1: a pure-RTL run is reversed in visual order", () => {
  // An all-Hebrew paragraph (RTL base): the letters paint right-to-left, so the
  // visual order is the reverse of the logical order.
  assert.equal(reorderVisual(HEBREW), [...HEBREW].reverse().join(""));
});

void test("Req 17.1: an RTL run embedded in LTR text is reversed in place", () => {
  // Logical: "a" + Hebrew(abc) + "b" with LTR base. The Hebrew run reverses,
  // but the surrounding Latin keeps its order and position.
  const logical = "a" + HEBREW + "b";
  const visual = reorderVisual(logical);
  const hebrewReversed = [...HEBREW].reverse().join("");
  assert.equal(visual, "a" + hebrewReversed + "b");
});

void test("Req 17.1: digits inside an RTL run stay left-to-right (numbers are LTR)", () => {
  // Hebrew followed by digits, RTL base: the Hebrew reverses but "12" stays
  // "12" (not "21"), because European numbers are LTR within RTL text.
  const logical = HEBREW + "12";
  const visual = reorderVisual(logical);
  assert.ok(visual.includes("12"), `digits must stay LTR; got ${JSON.stringify(visual)}`);
  assert.ok(!visual.includes("21"), "digits must not be reversed");
});

void test("Req 17.1: reordering is reversible-consistent for an LTR base with no RTL", () => {
  // With no RTL content the reorder is the identity (a meaningful guard that
  // the common path is untouched).
  const s = "The quick brown fox 2024";
  assert.equal(reorderVisual(s), s);
});

// ---------------------------------------------------------------------------
// Embedding levels + directional runs
// ---------------------------------------------------------------------------

void test("resolveLevels assigns even levels to LTR and odd to RTL", () => {
  const logical = "a" + HEBREW; // L then R…
  const levels = resolveLevels(logical, "ltr");
  assert.equal(levels[0]! % 2, 0, "Latin 'a' is an even (LTR) level");
  assert.equal(levels[1]! % 2, 1, "Hebrew is an odd (RTL) level");
});

void test("Req 17.1: bidiRuns segments text into maximal equal-level runs", () => {
  const logical = "ab" + HEBREW + "cd";
  const runs = bidiRuns(logical, "ltr");
  // Three runs: "ab" (LTR), Hebrew (RTL), "cd" (LTR).
  assert.equal(runs.length, 3);
  assert.equal(runs[0]!.text, "ab");
  assert.equal(runs[0]!.level % 2, 0);
  assert.equal(runs[1]!.text, HEBREW);
  assert.equal(runs[1]!.level % 2, 1);
  assert.equal(runs[2]!.text, "cd");
  assert.equal(runs[2]!.level % 2, 0);
  // Runs cover the whole string contiguously.
  assert.equal(runs[0]!.start, 0);
  assert.equal(runs[runs.length - 1]!.end, [...logical].length);
});

void test("bidiRuns on pure-LTR text is a single run", () => {
  const runs = bidiRuns("hello world");
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.level, 0);
});

// ---------------------------------------------------------------------------
// Script itemization (per-run complex-script shaping)
// ---------------------------------------------------------------------------

void test("Req 17.1: scriptRuns itemizes mixed scripts for per-run shaping", () => {
  const text = "abc" + ARABIC + "\u4e2d";
  const runs = scriptRuns(text);
  assert.equal(runs.length, 3);
  assert.equal(runs[0]!.script, "latin");
  assert.equal(runs[1]!.script, "arabic");
  assert.equal(runs[2]!.script, "han");
});

void test("scriptRuns keeps shared characters (digits/spaces) within the current run", () => {
  // "abc 123" is ONE Latin run — a `common` char does not split the run.
  const runs = scriptRuns("abc 123");
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.script, "latin");
  assert.equal(runs[0]!.text, "abc 123");
});

void test("scriptRuns on empty text is empty", () => {
  assert.deepEqual(scriptRuns(""), []);
});

void test("reorderVisual on empty text is empty", () => {
  assert.equal(reorderVisual(""), "");
});
