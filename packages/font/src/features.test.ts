/**
 * RFC 0005 evidence: the CSS font micro-syntax parsers — `font-family` lists,
 * `font-feature-settings`, `font-variation-settings`, `font-stretch`, and the
 * `cssFontFeatures` folding order.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  cssFontFeatures,
  fontStretchWidthClass,
  isGenericFamily,
  parseFontFamilyList,
  parseFontFeatureSettings,
  parseVariationSettings,
} from "./features.js";

void test("font-family list: quotes, whitespace folding, generics, case", () => {
  assert.deepEqual(parseFontFamilyList('Georgia, "Times New Roman" , serif'), [
    "georgia",
    "times new roman",
    "serif",
  ]);
  // Quoted names keep their inner whitespace verbatim (CSS Fonts §4.1);
  // matching normalizes case but not the literal name.
  assert.deepEqual(parseFontFamilyList("'Noto  Sans'"), ["noto  sans"]);
  assert.deepEqual(parseFontFamilyList("Helvetica Neue, monospace"), [
    "helvetica neue",
    "monospace",
  ]);
  assert.deepEqual(parseFontFamilyList(" , , "), []);
  assert.ok(isGenericFamily("SANS-SERIF"));
  assert.ok(isGenericFamily("ui-monospace"));
  assert.equal(isGenericFamily("georgia"), false);
});

void test("font-feature-settings: on/off/int values, bad entries dropped", () => {
  assert.deepEqual(parseFontFeatureSettings('"kern" 0, "liga" 1, "dlig"'), [
    { tag: "kern", value: 0 },
    { tag: "liga", value: 1 },
    { tag: "dlig", value: 1 },
  ]);
  assert.deepEqual(parseFontFeatureSettings('"aalt" 2'), [{ tag: "aalt", value: 2 }]);
  assert.deepEqual(parseFontFeatureSettings('"liga" off'), [{ tag: "liga", value: 0 }]);
  assert.deepEqual(parseFontFeatureSettings("normal"), []);
  assert.deepEqual(parseFontFeatureSettings(""), []);
  // Malformed entries are dropped, well-formed siblings survive.
  assert.deepEqual(parseFontFeatureSettings('"kern" 1, garbage stuff, "liga" 1'), [
    { tag: "kern", value: 1 },
    { tag: "liga", value: 1 },
  ]);
});

void test("cssFontFeatures folds kerning + variants, settings override", () => {
  assert.deepEqual(cssFontFeatures({ kerning: "none" }), [{ tag: "kern", value: 0 }]);
  assert.deepEqual(cssFontFeatures({ variantCaps: "small-caps" }), [{ tag: "smcp", value: 1 }]);
  assert.deepEqual(cssFontFeatures({ variantNumeric: "oldstyle-nums tabular-nums" }), [
    { tag: "onum", value: 1 },
    { tag: "tnum", value: 1 },
  ]);
  // font-feature-settings beats shorthand-derived features for the same tag.
  assert.deepEqual(
    cssFontFeatures({ kerning: "none", featureSettings: '"kern" 1, "liga" 0' }),
    [
      { tag: "kern", value: 1 },
      { tag: "liga", value: 0 },
    ],
  );
  // all-small-caps claims both tags.
  assert.deepEqual(cssFontFeatures({ variantCaps: "all-small-caps" }), [
    { tag: "smcp", value: 1 },
    { tag: "c2sc", value: 1 },
  ]);
  assert.deepEqual(cssFontFeatures({}), []);
});

void test("font-variant-ligatures keyword classes fold to liga/clig/dlig/hlig/calt", () => {
  // `none` disables every ligature-related feature, contextual included.
  assert.deepEqual(cssFontFeatures({ variantLigatures: "none" }), [
    { tag: "liga", value: 0 },
    { tag: "clig", value: 0 },
    { tag: "dlig", value: 0 },
    { tag: "hlig", value: 0 },
    { tag: "calt", value: 0 },
  ]);
  assert.deepEqual(cssFontFeatures({ variantLigatures: "discretionary-ligatures historical-ligatures" }), [
    { tag: "dlig", value: 1 },
    { tag: "hlig", value: 1 },
  ]);
  // no-* forms turn their class off.
  assert.deepEqual(cssFontFeatures({ variantLigatures: "no-common-ligatures no-contextual" }), [
    { tag: "liga", value: 0 },
    { tag: "clig", value: 0 },
    { tag: "calt", value: 0 },
  ]);
  // feature-settings still win over the longhand.
  assert.deepEqual(
    cssFontFeatures({ variantLigatures: "none", featureSettings: '"liga" 1' }),
    [
      { tag: "clig", value: 0 },
      { tag: "dlig", value: 0 },
      { tag: "hlig", value: 0 },
      { tag: "calt", value: 0 },
      { tag: "liga", value: 1 },
    ],
  );
});

void test("font-variant-position/east-asian/alternates map to their OT tags", () => {
  assert.deepEqual(cssFontFeatures({ variantPosition: "sup" }), [{ tag: "sups", value: 1 }]);
  assert.deepEqual(cssFontFeatures({ variantPosition: "sub" }), [{ tag: "subs", value: 1 }]);
  assert.deepEqual(cssFontFeatures({ variantEastAsian: "jis78 ruby" }), [
    { tag: "jp78", value: 1 },
    { tag: "ruby", value: 1 },
  ]);
  assert.deepEqual(cssFontFeatures({ variantEastAsian: "traditional full-width" }), [
    { tag: "trad", value: 1 },
    { tag: "fwid", value: 1 },
  ]);
  // Functional alternates: styleset → ssNN, character-variant → cvNN,
  // swash/ornaments/annotation carry the argument as the feature VALUE.
  assert.deepEqual(
    cssFontFeatures({ variantAlternates: "styleset(1, 4) character-variant(2) swash(2) historical-forms" }),
    [
      { tag: "ss01", value: 1 },
      { tag: "ss04", value: 1 },
      { tag: "cv02", value: 1 },
      { tag: "swsh", value: 2 },
      { tag: "hist", value: 1 },
    ],
  );
  assert.deepEqual(cssFontFeatures({ variantAlternates: "annotation(3)" }), [
    { tag: "nalt", value: 3 },
  ]);
});

void test("font-variation-settings parses tag + number pairs", () => {
  assert.deepEqual(parseVariationSettings('"wght" 700, "wdth" 75.5'), [
    { tag: "wght", value: 700 },
    { tag: "wdth", value: 75.5 },
  ]);
  assert.deepEqual(parseVariationSettings('"slnt" -7.5'), [{ tag: "slnt", value: -7.5 }]);
  assert.deepEqual(parseVariationSettings("normal"), []);
  assert.deepEqual(parseVariationSettings(""), []);
  assert.deepEqual(parseVariationSettings('"wg" 5'), []); // tags are 4 chars
});

void test("font-stretch maps keywords and percentages to usWidthClass", () => {
  assert.equal(fontStretchWidthClass("condensed"), 3);
  assert.equal(fontStretchWidthClass("expanded"), 7);
  assert.equal(fontStretchWidthClass("normal"), null); // no preference
  assert.equal(fontStretchWidthClass("75%"), 3);
  assert.equal(fontStretchWidthClass("125%"), 7);
  assert.equal(fontStretchWidthClass("bogus"), null);
});
