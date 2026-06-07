/**
 * `@browser-engine/font` — the engine's real font subsystem (FreeType/HarfBuzz
 * analog), owned behind a narrow seam:
 *
 *   - parse real TrueType/OpenType (`glyf`) fonts → {@link FontFace}
 *     ({@link parseTrueType});
 *   - compile glyph outlines → real `sfnt` bytes ({@link compileTrueType});
 *   - rasterize outlines → anti-aliased coverage ({@link rasterizeOutline});
 *   - a deterministic built-in vector font ({@link builtinFont}) so the engine
 *     renders real scalable text with no external asset.
 *
 * Stages consume it through small injected interfaces (a `TextShaper` for
 * metrics, a glyph coverage provider for the backend), so the IR boundaries are
 * untouched. It imports only `@browser-engine/ir`.
 */
export const PACKAGE_NAME = "@browser-engine/font" as const;

export type {
  FontFace,
  GlyphMetrics,
  GlyphOutline,
  GlyphPoint,
  GlyphRaster,
  Contour,
} from "./types.js";

export { parseTrueType } from "./truetype.js";
export { compileTrueType, type CompileFont, type CompileGlyph } from "./compile.js";
export { rasterizeOutline } from "./raster.js";
export {
  builtinFont,
  builtinFontBytes,
  builtinCompileFont,
} from "./builtin.js";

// Built-in glyph-art data (the single source the built-in font's outlines derive from).
export {
  GLYPH_WIDTH,
  GLYPH_HEIGHT,
  GLYPH_ART_BY_CODEPOINT,
} from "./glyph-art.js";

import type { FontFace, GlyphRaster } from "./types.js";
import { rasterizeOutline } from "./raster.js";

/**
 * A device-space glyph coverage provider — the narrow interface the backend
 * consumes to rasterize real font glyphs (it knows nothing of the font format).
 */
export interface GlyphCoverageSource {
  /** Map a code point to a glyph id (0 = missing). */
  glyphId(codePoint: number): number;
  /** The advance of a glyph id in EM units (advanceWidth / unitsPerEm). */
  advanceEm(glyphId: number): number;
  /** Typographic ascent in EM units — the baseline sits this far below the em-box top. */
  readonly ascentEm: number;
  /** Rasterize a glyph id at the given pixel font-size into a coverage grid. */
  raster(glyphId: number, fontSizePx: number): GlyphRaster;
}

/** Adapt a {@link FontFace} into the backend's {@link GlyphCoverageSource}. */
export function coverageSource(font: FontFace): GlyphCoverageSource {
  return {
    glyphId: (cp: number): number => font.glyphIdForCodePoint(cp),
    advanceEm: (glyphId: number): number => font.metricsOf(glyphId).advanceWidth / font.unitsPerEm,
    ascentEm: font.ascent / font.unitsPerEm,
    raster: (glyphId: number, fontSizePx: number): GlyphRaster =>
      rasterizeOutline(font.outlineOf(glyphId), fontSizePx / font.unitsPerEm),
  };
}
