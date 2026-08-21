export const PACKAGE_NAME = "@browser-engine/font" as const;

export type {
  FontFace,
  GlyphMetrics,
  GlyphOutline,
  GlyphPoint,
  GlyphRaster,
  Contour,
  GlyphCoverageSource,
} from "./types.js";

export { parseTrueType } from "./truetype.js";
export { compileTrueType, type CompileFont, type CompileGlyph } from "./compile.js";
export { rasterizeOutline } from "./raster.js";
export {
  loadTrueTypeFontFromBytes,
  loadTrueTypeFontFromUrl,
  loadTrueTypeFontFromPath,
  loadPreferredSystemFont,
  loadPreferredSystemBoldFont,
  preferredSystemTrueTypePaths,
  discoverSystemFontDirs,
} from "./font-loader.js";
export {
  builtinFont,
  builtinFontBytes,
  builtinCompileFont,
} from "./builtin.js";
export {
  GLYPH_WIDTH,
  GLYPH_HEIGHT,
  GLYPH_ART_BY_CODEPOINT,
} from "./glyph-art.js";
export { fallbackCoverageSource, advanceEmForCodePoint } from "./fallback.js";

import type { FontFace, GlyphCoverageSource, GlyphRaster } from "./types.js";
import { rasterizeOutline } from "./raster.js";

export function coverageSource(font: FontFace): GlyphCoverageSource {
  return {
    glyphId: (cp: number): number => font.glyphIdForCodePoint(cp),
    advanceEm: (glyphId: number): number => font.metricsOf(glyphId).advanceWidth / font.unitsPerEm,
    ascentEm: font.ascent / font.unitsPerEm,
    raster: (glyphId: number, fontSizePx: number): GlyphRaster =>
      rasterizeOutline(font.outlineOf(glyphId), fontSizePx / font.unitsPerEm),
  };
}
