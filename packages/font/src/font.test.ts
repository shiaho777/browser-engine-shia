/**
 * Tests for the real font engine: compile → parse round-trips on genuine `sfnt`
 * bytes, the built-in font's metrics + cmap, and the outline rasterizer
 * (including quadratic-bézier flattening + nonzero-winding fill).
 *
 * Built by `tsc` then run with: `node --test packages/font/dist/*.test.js`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  builtinFont,
  builtinFontBytes,
  compileTrueType,
  coverageSource,
  parseTrueType,
  rasterizeOutline,
  type CompileFont,
  type Contour,
} from "./index.js";

// ---------------------------------------------------------------------------
// Built-in font: real sfnt bytes, parsed back through the real parser.
// ---------------------------------------------------------------------------

void test("the built-in font compiles to valid TrueType bytes and parses back", () => {
  const bytes = builtinFontBytes();
  assert.equal(bytes[0], 0x00, "sfnt version 0x00010000 (TrueType)");
  assert.equal(bytes[1], 0x01);
  const font = parseTrueType(bytes);
  assert.equal(font.unitsPerEm, 1400);
  assert.ok(font.numGlyphs > 90, "covers printable ASCII");
});

void test("the built-in cmap maps real code points to non-empty outlines", () => {
  const font = builtinFont();
  for (const ch of "Hello1@") {
    const gid = font.glyphIdForCodePoint(ch.codePointAt(0)!);
    assert.ok(gid > 0, `'${ch}' has a glyph id`);
    assert.ok(font.outlineOf(gid).contours.length > 0, `'${ch}' has outline contours`);
  }
  // An uncovered code point maps to .notdef (0).
  assert.equal(font.glyphIdForCodePoint(0x2603), 0, "snowman is not in the built-in font");
});

void test("built-in advances are proportional: 'i' narrower than 'm', space has width", () => {
  const src = coverageSource(builtinFont());
  const em = (ch: string): number => src.advanceEm(src.glyphId(ch.codePointAt(0)!));
  assert.ok(em("i") < em("m"), `i (${em("i")}) must be narrower than m (${em("m")})`);
  assert.ok(em("l") < em("W"), "l narrower than W");
  assert.ok(em(" ") > 0, "space advances");
});

void test("rasterizing a glyph produces anti-aliased coverage; space is empty", () => {
  const src = coverageSource(builtinFont());
  const H = src.raster(src.glyphId("H".codePointAt(0)!), 24);
  assert.ok(H.width > 0 && H.height > 0, "'H' rasterizes to a real grid");
  let ink = 0;
  let partial = 0;
  for (const c of H.coverage) {
    if (c > 0) ink += 1;
    if (c > 0.05 && c < 0.95) partial += 1;
  }
  assert.ok(ink > 0, "'H' inks pixels");
  assert.ok(partial > 0, "non-integer scale yields anti-aliased (partial) coverage");

  const space = src.raster(src.glyphId(" ".codePointAt(0)!), 24);
  assert.equal(space.width, 0, "space has no contours ⇒ empty raster");
});

// ---------------------------------------------------------------------------
// Round-trip a hand-built font with a CURVED glyph (béziers + winding).
// ---------------------------------------------------------------------------

/** A filled disc contour centred at (c,c) radius r, via 4 quadratic segments. */
function disc(c: number, r: number): Contour {
  const on = (x: number, y: number) => ({ x, y, onCurve: true });
  const off = (x: number, y: number) => ({ x, y, onCurve: false });
  return [
    on(c + r, c), off(c + r, c + r), on(c, c + r), off(c - r, c + r),
    on(c - r, c), off(c - r, c - r), on(c, c - r), off(c + r, c - r),
  ];
}

void test("a quadratic-curve glyph round-trips and rasterizes as a filled disc", () => {
  const font: CompileFont = {
    unitsPerEm: 1000,
    ascent: 800,
    descent: -200,
    glyphs: [
      { contours: [], advanceWidth: 600 }, // .notdef
      { contours: [disc(500, 300)], advanceWidth: 1000 }, // 'O' → a disc
    ],
    cmap: new Map([[0x4f, 1]]),
  };
  const parsed = parseTrueType(compileTrueType(font));
  const gid = parsed.glyphIdForCodePoint(0x4f);
  assert.equal(gid, 1);
  const outline = parsed.outlineOf(gid);
  assert.equal(outline.contours.length, 1);
  assert.equal(outline.contours[0]!.length, 8, "8 points (4 on + 4 off) survive the round-trip");
  assert.ok(outline.contours[0]!.some((p) => !p.onCurve), "off-curve control points preserved");

  const r = rasterizeOutline(outline, 40 / 1000);
  // Centre pixel is well inside the disc ⇒ fully covered; a bbox corner is outside.
  const cx = Math.floor(r.width / 2);
  const cy = Math.floor(r.height / 2);
  assert.ok((r.coverage[cy * r.width + cx] ?? 0) > 0.9, "disc centre is filled");
  assert.ok((r.coverage[0] ?? 0) < 0.5, "the bbox corner is outside the disc (curve, not a box)");
});

void test("nonzero winding leaves a counter (hole) — outer disc minus inner disc", () => {
  // Outer disc CCW + inner disc with REVERSED points (opposite winding) ⇒ ring.
  const outer = disc(500, 400);
  const inner = [...disc(500, 200)].reverse();
  const font: CompileFont = {
    unitsPerEm: 1000,
    ascent: 800,
    descent: -200,
    glyphs: [
      { contours: [], advanceWidth: 600 },
      { contours: [outer, inner], advanceWidth: 1000 },
    ],
    cmap: new Map([[0x4f, 1]]),
  };
  const parsed = parseTrueType(compileTrueType(font));
  const r = rasterizeOutline(parsed.outlineOf(1), 60 / 1000);
  const cx = Math.floor(r.width / 2);
  const cy = Math.floor(r.height / 2);
  assert.ok((r.coverage[cy * r.width + cx] ?? 0) < 0.1, "the ring's centre is a hole (nonzero winding)");
  // A point in the ring band (between inner and outer radius) is inked.
  const bandX = Math.floor(r.width * 0.12);
  assert.ok((r.coverage[cy * r.width + bandX] ?? 0) > 0.5, "the ring band is inked");
});
