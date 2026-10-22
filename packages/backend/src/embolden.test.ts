/**
 * `needsSyntheticBold` — the shared fake-bold gate (RFC 0006).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { needsSyntheticBold, needsSyntheticItalic, syntheticItalicShift } from "./embolden.js";

void test("synthetic bold needs: heavy request + synthesis allowed + a face that lacks it", () => {
  // Regular face, bold request, synthesis on → embolden.
  assert.equal(needsSyntheticBold(700, 400, true), true);
  // A real bold face is NEVER emboldened twice.
  assert.equal(needsSyntheticBold(700, 700, true), false);
  // A semi-bold face still lacks weight 700 → embolden.
  assert.equal(needsSyntheticBold(700, 500, true), true);
  // `font-synthesis: none` (or no `weight` token) suppresses it entirely.
  assert.equal(needsSyntheticBold(700, 400, false), false);
  // Below the fake-bold band nothing is synthesized.
  assert.equal(needsSyntheticBold(400, 400, true), false);
  assert.equal(needsSyntheticBold(499, 400, true), false);
  // Faces without weight metadata are treated as regular (400).
  assert.equal(needsSyntheticBold(700, undefined, true), true);
  assert.equal(needsSyntheticBold(undefined, 400, true), false);
});

void test("synthetic italic is a shear only for italic and oblique", () => {
  assert.equal(needsSyntheticItalic("italic", true), true);
  assert.equal(needsSyntheticItalic("oblique", true), true);
  assert.equal(needsSyntheticItalic("normal", true), false);
  assert.equal(needsSyntheticItalic(undefined, true), false);
  assert.equal(needsSyntheticItalic("italic", false), false);
  assert.equal(needsSyntheticItalic("italic", true, true), false);
  assert.equal(syntheticItalicShift(0), 0);
  assert.equal(syntheticItalicShift(5), -1);
});
