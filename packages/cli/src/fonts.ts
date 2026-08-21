import { px } from "@browser-engine/ir";
import {
  advanceEmForCodePoint,
  builtinFont,
  fallbackCoverageSource,
  loadPreferredSystemBoldFont,
  loadPreferredSystemFont,
  type FontFace,
  type GlyphCoverageSource,
  type GlyphRaster,
} from "@browser-engine/font";
import type { ShapedGlyph, ShapingFont, ShapedRun, TextShaper } from "@browser-engine/layout";

function resolvePipelineFaces(): FontFace[] {
  const faces: FontFace[] = [];
  const system = loadPreferredSystemFont();
  if (system !== null) faces.push(system);
  faces.push(builtinFont());
  return faces;
}

function resolveBoldFaces(regular: readonly FontFace[]): FontFace[] {
  const faces: FontFace[] = [];
  const bold = loadPreferredSystemBoldFont();
  if (bold !== null) faces.push(bold);
  for (const face of regular) faces.push(face);
  return faces;
}

const FACES: readonly FontFace[] = resolvePipelineFaces();
const BOLD_FACES: readonly FontFace[] = resolveBoldFaces(FACES);

export const pipelineFaces: readonly FontFace[] = FACES;

function emboldenRaster(r: GlyphRaster): GlyphRaster {
  if (r.width <= 0 || r.height <= 0) return r;
  const w = r.width + 1;
  const h = r.height;
  const coverage = new Float64Array(w * h);
  for (let y = 0; y < r.height; y += 1) {
    for (let x = 0; x < r.width; x += 1) {
      const v = r.coverage[y * r.width + x] ?? 0;
      if (v <= 0) continue;
      const i0 = y * w + x;
      coverage[i0] = Math.max(coverage[i0] ?? 0, v);
      coverage[i0 + 1] = Math.max(coverage[i0 + 1] ?? 0, v);
    }
  }
  return { width: w, height: h, coverage, left: r.left, top: r.top };
}

function weightedCoverageSource(
  regular: GlyphCoverageSource,
  bold: GlyphCoverageSource,
): GlyphCoverageSource & { withWeight(weight: number): GlyphCoverageSource } {
  const cache = new Map<number, GlyphCoverageSource>();
  const make = (weight: number): GlyphCoverageSource => {
    const useBoldFace = weight >= 600;
    const base = useBoldFace ? bold : regular;
    if (weight < 500) return base;
    return {
      glyphId: (cp) => base.glyphId(cp),
      advanceEm: (gid) => base.advanceEm(gid),
      ascentEm: base.ascentEm,
      raster: (gid, fontSizePx) => {
        const r = base.raster(gid, fontSizePx);
        return weight >= 500 ? emboldenRaster(r) : r;
      },
    };
  };
  const defaultSource = make(400);
  return Object.assign(defaultSource, {
    withWeight(weight: number): GlyphCoverageSource {
      const key = weight >= 700 ? 700 : weight >= 600 ? 600 : weight >= 500 ? 500 : 400;
      let hit = cache.get(key);
      if (hit === undefined) {
        hit = make(key);
        cache.set(key, hit);
      }
      return hit;
    },
  });
}

const regularSource = fallbackCoverageSource(FACES);
const boldSource = fallbackCoverageSource(BOLD_FACES);
export const pipelineGlyphSource: GlyphCoverageSource & {
  withWeight?(weight: number): GlyphCoverageSource;
} = weightedCoverageSource(regularSource, boldSource);

export const pipelineShaper: TextShaper = {
  shapeLine(text: string, font: ShapingFont): ShapedRun {
    const glyphs: ShapedGlyph[] = [];
    let total = 0;
    const weight = font.fontWeight ?? 400;
    const faces = weight >= 600 ? BOLD_FACES : FACES;
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      const adv = font.fontSize * advanceEmForCodePoint(faces, cp);
      for (let u = 0; u < ch.length; u += 1) glyphs.push({ advance: px(u === 0 ? adv : 0) });
      total += adv;
    }
    return { advance: px(total), glyphs };
  },
};

export function pipelinePrimaryFontName(): string {
  return FACES.length > 1 ? "system+builtin" : "builtin";
}
