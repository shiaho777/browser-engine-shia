import { rasterizeOutline } from "./raster.js";
import type { FontFace, GlyphCoverageSource, GlyphRaster } from "./types.js";

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

  // Glyph-atlas cache: scan-converting an outline is the most expensive per-
  // pixel operation in the pipeline, and every repaint re-rasterizes the SAME
  // (glyph, size) pairs. A page frame rasterizes each visible glyph once per
  // frame without this; the cache turns repeat frames (scroll, pump, focus)
  // into Map lookups. Key: `syntheticId @ fontSizePx*10` (0.1px granularity —
  // the fractional sizes callers pass are stable per page zoom).
  const atlas = new Map<string, GlyphRaster>();

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
      const key = `${syntheticId}@${Math.round(fontSizePx * 10)}`;
      const hit = atlas.get(key);
      if (hit !== undefined) return hit;
      const raster = rasterizeOutline(slot.face.outlineOf(slot.gid), fontSizePx / slot.face.unitsPerEm);
      atlas.set(key, raster);
      return raster;
    },
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
