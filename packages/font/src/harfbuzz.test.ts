/**
 * Tests for {@link HarfBuzzShaper} — the real shaping adapter (RFC 0002).
 *
 * Deterministic cases run on the in-repo compiled builtin face plus a small
 * synthetic Greek face compiled here via `compileTrueType` (no committed
 * binary fixtures). Cases that need GSUB/GPOS intelligence (ligatures,
 * kerning) run only when a system font carrying those tables is present —
 * the same conditional pattern `system-font.test.ts` already uses.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { builtinFont } from "./builtin.js";
import { compileTrueType, type CompileGlyph } from "./compile.js";
import { parseTrueType } from "./truetype.js";
import { HarfBuzzShaper } from "./harfbuzz.js";
import { cssFontFeatures } from "./features.js";
import type { FontFace } from "./types.js";

// `harfbuzzjs` self-initializes under its top-level await — importing it here
// yields a fully ready module (the production path does the same in
// `packages/cli/src/fonts.ts`).
const hb = await import("harfbuzzjs");

/** A closed square contour (consistent winding) for fixture glyphs. */
function box(x0: number, y0: number, x1: number, y1: number): CompileGlyph["contours"][number] {
  return [
    { x: x0, y: y0, onCurve: true },
    { x: x1, y: y0, onCurve: true },
    { x: x1, y: y1, onCurve: true },
    { x: x0, y: y1, onCurve: true },
  ];
}

/**
 * A fixture face covering ONLY the Greek letters α β γ (the builtin face is
 * ASCII-only) — deterministic, compiled in-memory, used to prove the
 * engine-owned fallback loop re-shapes missing spans on the next face.
 */
function greekFont(): FontFace {
  const g = (advance: number): CompileGlyph => ({
    contours: [box(40, 0, 460, 660)],
    advanceWidth: advance,
  });
  return parseTrueType(
    compileTrueType({
      unitsPerEm: 1000,
      ascent: 800,
      descent: 200,
      glyphs: [
        { contours: [], advanceWidth: 500 }, // gid 0 = .notdef
        g(600), // gid 1 = α
        g(650), // gid 2 = β
        g(700), // gid 3 = γ
      ],
      cmap: new Map([
        [0x03b1, 1],
        [0x03b2, 2],
        [0x03b3, 3],
      ]),
    }),
  );
}

void test("shapes to REAL glyph ids (not code points) with advances + clusters", () => {
  const face = builtinFont();
  const shaper = new HarfBuzzShaper(hb, [face]);
  const glyphs = shaper.shape("Hi", [0]);

  assert.equal(glyphs.length, 2, "two source chars ⇒ two glyphs (no liga in this font)");
  // The builtin cmap maps 'H' → a real glyph index that is NOT the code point.
  const realH = face.glyphIdForCodePoint(0x48);
  assert.notEqual(realH, 0x48, "the builtin font's 'H' gid differs from its code point");
  assert.equal(glyphs[0]!.glyphId, realH, "the shaped glyph id is the font-local gid");
  assert.equal(glyphs[0]!.faceIndex, 0);
  assert.equal(glyphs[1]!.glyphId, face.glyphIdForCodePoint(0x69));
  assert.deepEqual(
    glyphs.map((g) => g.cluster),
    [0, 1],
    "clusters map back to source offsets",
  );
  for (const g of glyphs) {
    assert.ok(g.advanceEm > 0, `glyph ${g.glyphId} has a positive em advance`);
    assert.ok(g.advanceEm < 1, "builtin advances are sub-em");
  }
});

void test("explicit rtl direction emits the run in VISUAL order (reversed clusters)", () => {
  const shaper = new HarfBuzzShaper(hb, [builtinFont()]);
  const glyphs = shaper.shape("abc", [0], { direction: "rtl", script: "Latn" });
  assert.deepEqual(
    glyphs.map((g) => g.cluster),
    [2, 1, 0],
    "rtl ⇒ glyphs emitted right-to-left, clusters reversed",
  );
  // Positions are still pen-advances left-to-right on the canvas — the ORDER
  // is what flips.
  assert.equal(glyphs.length, 3);
});

void test("hebrew text auto-detects RTL even when glyphs are .notdef", () => {
  // The builtin face has no Hebrew coverage — but direction detection and
  // visual reordering are HarfBuzz's job, independent of coverage.
  const shaper = new HarfBuzzShaper(hb, [builtinFont()]);
  const glyphs = shaper.shape("שלום", [0]);
  assert.deepEqual(
    glyphs.map((g) => g.cluster),
    [3, 2, 1, 0],
    "guessed rtl ⇒ reversed visual order",
  );
  assert.ok(
    glyphs.every((g) => g.glyphId === 0 && g.faceIndex === 0),
    "no face covers Hebrew ⇒ the primary face's .notdef is emitted, not dropped",
  );
});

void test("missing coverage falls back to the next face, spliced in place", () => {
  const builtin = builtinFont();
  const greek = greekFont();
  const shaper = new HarfBuzzShaper(hb, [builtin, greek]);
  // 'A' is covered by builtin (face 0); 'α','β' only by the Greek face (face 1).
  const glyphs = shaper.shape("Aαβ", [0, 1]);
  assert.equal(glyphs.length, 3);
  assert.equal(glyphs[0]!.faceIndex, 0, "'A' stays on the primary face");
  assert.equal(glyphs[0]!.glyphId, builtin.glyphIdForCodePoint(0x41));
  assert.equal(glyphs[1]!.faceIndex, 1, "'α' fell back to the Greek face");
  assert.equal(glyphs[1]!.glyphId, 1, "α is gid 1 in the fixture face");
  assert.equal(glyphs[2]!.faceIndex, 1);
  assert.equal(glyphs[2]!.glyphId, 2);
  assert.deepEqual(
    glyphs.map((g) => g.cluster),
    [0, 1, 2],
    "clusters survive the fallback re-shape",
  );
});

void test("fallback preserves VISUAL position for interleaved spans", () => {
  const builtin = builtinFont();
  const greek = greekFont();
  const shaper = new HarfBuzzShaper(hb, [builtin, greek]);
  // Alternating coverage: α (face1) A (face0) β (face1) — two separate missing
  // spans must each be spliced at their own output position.
  const glyphs = shaper.shape("αAβ", [0, 1]);
  assert.deepEqual(
    glyphs.map((g) => g.faceIndex),
    [1, 0, 1],
    "interleaved faces splice correctly",
  );
  assert.deepEqual(
    glyphs.map((g) => g.cluster),
    [0, 1, 2],
    "logical order preserved",
  );
});

void test("a span no face covers emits the primary face's .notdef honestly", () => {
  const shaper = new HarfBuzzShaper(hb, [builtinFont(), greekFont()]);
  // Emoji U+1F600: covered by neither face.
  const glyphs = shaper.shape("A\u{1F600}", [0, 1]);
  const emoji = glyphs.find((g) => g.cluster === 1);
  assert.ok(emoji !== undefined, "the uncovered cluster still produces output");
  assert.equal(emoji.glyphId, 0, "the LAST face's .notdef is emitted");
  assert.ok(emoji.advanceEm > 0, ".notdef keeps its advance (it draws a box)");
});

void test("a face with no sfnt bytes is skipped in the face order", () => {
  const dataless: FontFace = {
    unitsPerEm: 1000,
    numGlyphs: 0,
    ascent: 800,
    descent: 200,
    glyphIdForCodePoint: () => 0,
    metricsOf: () => ({ advanceWidth: 0, leftSideBearing: 0 }),
    outlineOf: () => ({ contours: [], xMin: 0, yMin: 0, xMax: 0, yMax: 0 }),
  };
  const shaper = new HarfBuzzShaper(hb, [dataless, builtinFont()]);
  const glyphs = shaper.shape("Hi", [0, 1]);
  assert.equal(glyphs.length, 2);
  assert.ok(
    glyphs.every((g) => g.faceIndex === 1),
    "shaping skipped the byte-less face and used the builtin face",
  );
});

// ---------------------------------------------------------------------------
// Conditional: system fonts carrying GSUB/GPOS (macOS ships STIX; other hosts
// may not — same conditional pattern as system-font.test.ts).
// ---------------------------------------------------------------------------

const STIX = "/System/Library/Fonts/Supplemental/STIXGeneral.otf";

/** Minimal shaping-only FontFace over raw sfnt bytes (raster fields unused). */
function byteFace(data: Uint8Array, unitsPerEm: number): FontFace {
  return {
    unitsPerEm,
    numGlyphs: 0,
    ascent: unitsPerEm * 0.8,
    descent: unitsPerEm * 0.2,
    data,
    glyphIdForCodePoint: () => 0,
    metricsOf: () => ({ advanceWidth: 0, leftSideBearing: 0 }),
    outlineOf: () => ({ contours: [], xMin: 0, yMin: 0, xMax: 0, yMax: 0 }),
  };
}

void test(
  "ligature substitution (STIX 'fi' → one glyph) when the system font exists",
  { skip: !existsSync(STIX) },
  () => {
    const stix = byteFace(new Uint8Array(readFileSync(STIX)), 1000);
    const shaper = new HarfBuzzShaper(hb, [stix]);
    const glyphs = shaper.shape("fi", [0]);
    assert.equal(
      glyphs.length,
      1,
      "GSUB liga substitutes the pair into a single ligature glyph",
    );
    assert.equal(glyphs[0]!.cluster, 0, "the ligature claims cluster 0");
  },
);

void test(
  "kerning tightens 'AV' below the unpaired sum (STIX GPOS) when present",
  { skip: !existsSync(STIX) },
  () => {
    const stix = byteFace(new Uint8Array(readFileSync(STIX)), 1000);
    const shaper = new HarfBuzzShaper(hb, [stix]);
    const pair = shaper.shape("AV", [0]).reduce((s, g) => s + g.advanceEm, 0);
    const sepA = shaper.shape("A", [0])[0]!.advanceEm;
    const sepV = shaper.shape("V", [0])[0]!.advanceEm;
    assert.ok(
      pair < sepA + sepV,
      `GPOS kern applies: pair ${pair.toFixed(3)}em < sum ${(sepA + sepV).toFixed(3)}em`,
    );
  },
);

// ---- RFC 0005: features + variations reach the hb_shape call --------------

void test(
  "kern=0 removes the AV kern; liga=0 splits the 'fi' ligature (STIX)",
  { skip: !existsSync(STIX) },
  () => {
    const stix = byteFace(new Uint8Array(readFileSync(STIX)), 1000);
    const shaper = new HarfBuzzShaper(hb, [stix]);
    const width = (features?: { tag: string; value: number }[]) =>
      shaper.shape("AV", [0], { features: features ?? [] }).reduce((s, g) => s + g.advanceEm, 0);
    const kerned = width();
    const unkerned = width([{ tag: "kern", value: 0 }]);
    assert.ok(
      unkerned > kerned,
      `font-kerning:none → -kern: ${unkerned.toFixed(3)}em > ${kerned.toFixed(3)}em`,
    );
    const lig = shaper.shape("fi", [0]).length;
    const noLig = shaper.shape("fi", [0], { features: [{ tag: "liga", value: 0 }] }).length;
    assert.equal(lig, 1, "default shapes to the fi ligature");
    assert.equal(noLig, 2, "liga=0 splits the ligature back into two glyphs");
  },
);

void test(
  "variation fonts accept font-variation-settings without breaking shaping (STIXVar)",
  { skip: !existsSync("/System/Library/Fonts/Supplemental/STIXVar.otf") },
  () => {
    const bytes = new Uint8Array(
      readFileSync("/System/Library/Fonts/Supplemental/STIXVar.otf"),
    );
    const face = byteFace(bytes, 1000);
    const shaper = new HarfBuzzShaper(hb, [face]);
    const plain = shaper.shape("Hello", [0]);
    const heavy = shaper.shape("Hello", [0], {
      variations: [{ tag: "wght", value: 900 }],
    });
    assert.equal(plain.length, heavy.length, "same text, same glyph count");
    // A wght-900 run may share advances with the default (STIXVar's wght axis
    // barely moves Latin advances) — what must hold is that the variation path
    // runs through hb without error and caches separately.
    const heavyAgain = shaper.shape("Hello", [0], {
      variations: [{ tag: "wght", value: 900 }],
    });
    assert.deepEqual(heavy, heavyAgain, "variation-keyed shaping is deterministic");
  },
);

void test(
  "font-variant-ligatures:none (via cssFontFeatures) splits the STIX 'fi' ligature",
  { skip: !existsSync(STIX) },
  () => {
    const stix = byteFace(new Uint8Array(readFileSync(STIX)), 1000);
    const shaper = new HarfBuzzShaper(hb, [stix]);
    const lig = shaper.shape("fi", [0]).length;
    // The CSS longhand folds to -liga -clig -dlig -hlig -calt and reaches hb.
    const off = shaper.shape("fi", [0], {
      features: cssFontFeatures({ variantLigatures: "none" }),
    }).length;
    assert.equal(lig, 1, "default keeps the fi ligature");
    assert.equal(off, 2, "variant-ligatures:none splits it into f + i");
  },
);
