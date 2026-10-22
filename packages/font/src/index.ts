export const PACKAGE_NAME = "@browser-engine/font" as const;

export type {
  FontFace,
  GlyphMetrics,
  GlyphOutline,
  GlyphPoint,
  GlyphRaster,
  Contour,
  GlyphCoverageSource,
  GlyphRasterSource,
} from "./types.js";

export { parseTrueType } from "./truetype.js";
export {
  compileTrueType,
  compileTrueTypeCollection,
  type CompileFont,
  type CompileGlyph,
} from "./compile.js";
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
export {
  fallbackCoverageSource,
  advanceEmForCodePoint,
  faceTableRasterSource,
} from "./fallback.js";
export {
  HarfBuzzShaper,
  type HarfBuzzApi,
  type HarfBuzzGlyph,
  type ShapeOptions,
} from "./harfbuzz.js";
export {
  readSfntFaceInfo,
  readSfntFaceInfoFromFile,
  type SfntFaceInfo,
} from "./names.js";
export {
  cssFontFeatures,
  fontStretchWidthClass,
  isGenericFamily,
  parseFontFamilyList,
  parseFontFeatureSettings,
  parseVariationSettings,
  type CssFeatureInput,
  type FontFeatureSpec,
  type FontVariation,
} from "./features.js";
export { FontRegistry, type FontSelect } from "./registry.js";
export {
  collectFontFaceDescriptors,
  faceFromSourceBytes,
  fontFaceFormatSupported,
  parseFontFaceRule,
  type FontFaceDescriptor,
  type FontFaceSource,
} from "./fontface.js";
export { isWoff, unwrapWoff } from "./woff.js";

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
