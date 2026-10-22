/**
 * Core font-engine types — the vector-glyph model shared by the TrueType parser
 * ({@link import("./truetype.js")}), the in-repo font compiler
 * ({@link import("./compile.js")}), and the outline rasterizer
 * ({@link import("./raster.js")}).
 *
 * This package is the engine's REAL font subsystem — the FreeType/HarfBuzz-class
 * "irreducible dirty work" the manifesto says to own behind a narrow seam:
 *
 *   - it parses real TrueType/OpenType (`sfnt`) bytes into scalable glyph
 *     OUTLINES (quadratic-bézier contours) plus real `cmap`/`hmtx` metrics;
 *   - it rasterizes those outlines to anti-aliased coverage at any pixel size
 *     (scanline fill, nonzero winding, sub-scanline + analytic-horizontal AA);
 *   - it ships a deterministic built-in font (so the engine renders real vector
 *     text with NO external asset), and loads ANY real `.ttf` the same way.
 *
 * It imports ONLY `@browser-engine/ir` for the `Px` brand; it is infrastructure
 * (like the kernel), not a pipeline stage, so stages may consume it via narrow
 * injected interfaces without violating `local/no-cross-stage-import`.
 */

/** A point in font design units. `onCurve=false` is a quadratic off-curve control point. */
export interface GlyphPoint {
  readonly x: number;
  readonly y: number;
  readonly onCurve: boolean;
}

/** One closed contour: a ring of on/off-curve points (TrueType quadratic convention). */
export type Contour = readonly GlyphPoint[];

/** A glyph outline: zero or more contours, plus its glyph-space bounding box. */
export interface GlyphOutline {
  readonly contours: readonly Contour[];
  readonly xMin: number;
  readonly yMin: number;
  readonly xMax: number;
  readonly yMax: number;
}

/** Per-glyph horizontal metrics (font design units). */
export interface GlyphMetrics {
  /** Advance width — how far the pen moves after this glyph. */
  readonly advanceWidth: number;
  /** Left side bearing — gap from pen origin to the glyph's left edge. */
  readonly leftSideBearing: number;
}

/**
 * A parsed/loaded font face: the read-only product of {@link parseTrueType}. All
 * coordinates are in font design units; divide by {@link unitsPerEm} and
 * multiply by the pixel font-size to get device pixels.
 */
export interface FontFace {
  /** Font units per em — the scale denominator (`head.unitsPerEm`). */
  readonly unitsPerEm: number;
  /** Number of glyphs in the font (`maxp.numGlyphs`). */
  readonly numGlyphs: number;
  /** Typographic ascent / descent in font units (`hhea`). */
  readonly ascent: number;
  readonly descent: number;
  /** Map a Unicode code point to a glyph id (0 = `.notdef` / missing). */
  glyphIdForCodePoint(codePoint: number): number;
  /** The horizontal metrics of a glyph id. */
  metricsOf(glyphId: number): GlyphMetrics;
  /** The (curve-bearing) outline of a glyph id; empty contours for a blank glyph. */
  outlineOf(glyphId: number): GlyphOutline;
  /**
   * The face's raw sfnt bytes, retained so a rasterization backend can hand the
   * same font file to an external scaler (e.g. Skia's FreeType) instead of
   * re-rasterizing outlines itself, and so the HarfBuzz adapter can create an
   * `hb_face`/`hb_font` over the identical font file. Present whenever the face
   * was parsed from bytes; callers MUST NOT mutate the array (shared, not
   * copied — same typed-array caveat as the IR contract).
   */
  readonly data?: Uint8Array;
  /**
   * The face's index inside a TrueType/OpenType COLLECTION (`ttcf`), when the
   * bytes are a collection. Absent/zero for a standalone sfnt file. The
   * in-repo parser reads single-face sfnts today; the field exists so external
   * consumers (HarfBuzz `hb_face_create` index, Skia typefaces) can name the
   * right face inside a collection the moment collections are loadable.
   */
  readonly collectionIndex?: number;
  /**
   * The face's own `OS/2.usWeightClass` (400/700/…) when the table is present —
   * backends compare it against a run's requested weight to decide whether
   * SYNTHETIC bolding is needed (a genuinely-bold face is never double-bolded;
   * RFC 0006 `font-synthesis`).
   */
  readonly weight?: number;
  /**
   * `OS/2.sxHeight` in font units when the table is version 2 or newer.
   * Divide by `unitsPerEm` for the em ratio `vertical-align: middle` uses.
   */
  readonly xHeight?: number;
  /** OS/2 fsSelection bit 0. Absent ⇒ the face is not known to be italic. */
  readonly italic?: boolean;
  /** OS/2 ySubscriptYOffset in font units (negative ⇒ below the baseline). */
  readonly subscriptOffset?: number;
  /** OS/2 ySuperscriptYOffset in font units (positive ⇒ above the baseline). */
  readonly superscriptOffset?: number;
}

/**
 * A rasterized glyph: a row-major coverage grid in `[0,1]` (1 = fully inked),
 * positioned by `left`/`top` in device pixels relative to the pen origin sitting
 * on the baseline. `top` is the distance from the baseline UP to the grid's top
 * row (positive = above the baseline).
 */
export interface GlyphRaster {
  readonly width: number;
  readonly height: number;
  /** `width * height` coverage values, row-major, top-to-bottom. */
  readonly coverage: Float64Array;
  /** Device-pixel offset of the grid's top-left from the pen origin on the baseline. */
  readonly left: number;
  readonly top: number;
}

export interface GlyphCoverageSource {
  glyphId(codePoint: number): number;
  advanceEm(glyphId: number): number;
  readonly ascentEm: number;
  raster(glyphId: number, fontSizePx: number): GlyphRaster;
}

/**
 * The post-shaping rasterization seam (RFC 0002). Once text is REALLY shaped,
 * the DisplayList's `text` command carries `(faceIndex, glyphId)` pairs — a
 * real font-local gid plus which face it belongs to — so a backend needs only
 * "rasterize THIS gid of THIS face at THIS size", nothing more. The
 * code-point→glyph resolution of {@link GlyphCoverageSource} is the SHAPER's
 * job now; it must never leak back into a rasterizer.
 *
 * `faceIndex` indexes the SAME face table the pipeline shaper resolved against
 * (the table injected at backend construction — the contract is positional:
 * identical list, identical order, on both sides of the boundary).
 */
export interface GlyphRasterSource {
  /** Em ascent of the PRIMARY face — the shared baseline metric for a run. */
  readonly ascentEm: number;
  /**
   * Rasterize `glyphId` of `faces[faceIndex]` at `fontSizePx`. An out-of-range
   * face or glyph yields an empty raster (a `.notdef` is itself a real glyph
   * id — `outlineOf(0)` draws the font's own box, never a fabricated blank).
   */
  raster(faceIndex: number, glyphId: number, fontSizePx: number): GlyphRaster;
  /**
   * The face's own `OS/2.usWeightClass` (RFC 0006) — the backends compare it
   * against a run's requested `fontWeight` to decide whether SYNTHETIC bolding
   * is needed (a genuinely-bold face is never double-bolded). Absent on
   * hand-rolled sources ⇒ treated as 400.
   */
  faceWeight?(faceIndex: number): number | undefined;
  /** True when the face's OS/2 fsSelection marks it italic. */
  faceItalic?(faceIndex: number): boolean | undefined;
}

