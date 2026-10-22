import { rasterizeOutline } from "./raster.js";
import type { FontFace, GlyphCoverageSource, GlyphRaster, GlyphRasterSource } from "./types.js";

const EMPTY_RASTER: GlyphRaster = {
  width: 0,
  height: 0,
  coverage: new Float64Array(0),
  left: 0,
  top: 0,
};

export function fallbackCoverageSource(faces: readonly FontFace[]): GlyphCoverageSource {
  if (faces.length === 0) {
    throw new Error("font: fallbackCoverageSource requires at least one FontFace");
  }
  type Slot = { face: FontFace; gid: number };
  const slots: Slot[] = [];
  const byCodePoint = new Map<number, number>();
  const primary = faces[0]!;

  const resolve = (codePoint: number): number => {
    const cached = byCodePoint.get(codePoint);
    if (cached !== undefined) return cached;
    for (const face of faces) {
      const gid = face.glyphIdForCodePoint(codePoint);
      if (gid !== 0) {
        const sid = slots.length + 1;
        slots.push({ face, gid });
        byCodePoint.set(codePoint, sid);
        return sid;
      }
    }
    byCodePoint.set(codePoint, 0);
    return 0;
  };

  return {
    glyphId: resolve,
    advanceEm: (syntheticId: number): number => {
      if (syntheticId <= 0) return 0;
      const slot = slots[syntheticId - 1];
      if (slot === undefined) return 0;
      return slot.face.metricsOf(slot.gid).advanceWidth / slot.face.unitsPerEm;
    },
    ascentEm: primary.ascent / primary.unitsPerEm,
    raster: (syntheticId: number, fontSizePx: number): GlyphRaster => {
      if (syntheticId <= 0) return EMPTY_RASTER;
      const slot = slots[syntheticId - 1];
      if (slot === undefined) return EMPTY_RASTER;
      return rasterizeOutline(slot.face.outlineOf(slot.gid), fontSizePx / slot.face.unitsPerEm);
    },
  };
}

/**
 * The post-shaping raster source (RFC 0002): a {@link GlyphRasterSource} over
 * a face TABLE — the same ordered list the pipeline shaper resolves
 * `faceIndex` against. A text command's `(faceIndex, glyphId)` pair goes
 * straight to `faces[faceIndex].outlineOf(glyphId)`; no code-point resolution
 * happens at raster time (that is the shaper's job now).
 */
export function faceTableRasterSource(faces: readonly FontFace[]): GlyphRasterSource {
  if (faces.length === 0) {
    throw new Error("font: faceTableRasterSource requires at least one FontFace");
  }
  const primary = faces[0]!;
  return {
    ascentEm: primary.ascent / primary.unitsPerEm,
    raster: (faceIndex: number, glyphId: number, fontSizePx: number): GlyphRaster => {
      const face = faces[faceIndex];
      // gid 0 is the face's own .notdef — a real glyph, drawn honestly.
      if (face === undefined || glyphId < 0) return EMPTY_RASTER;
      return rasterizeOutline(face.outlineOf(glyphId), fontSizePx / face.unitsPerEm);
    },
    faceWeight: (faceIndex: number): number | undefined => faces[faceIndex]?.weight,
    faceItalic: (faceIndex: number): boolean | undefined => faces[faceIndex]?.italic,
  };
}

export function advanceEmForCodePoint(faces: readonly FontFace[], codePoint: number): number {
  for (const face of faces) {
    const gid = face.glyphIdForCodePoint(codePoint);
    if (gid !== 0) {
      return face.metricsOf(gid).advanceWidth / face.unitsPerEm;
    }
  }
  const face = faces[0];
  if (face === undefined) return 0;
  return face.metricsOf(0).advanceWidth / face.unitsPerEm;
}
