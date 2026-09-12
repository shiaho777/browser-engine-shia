/**
 * harfbuzz-shaper.ts — E1: the REAL HarfBuzz shaping adapter (harfbuzzjs WASM),
 * implementing the layout stage's {@link TextShaper} seam.
 *
 * The seam contract (text-shaper.ts): `shapeLine(text, font) → ShapedRun` —
 * per-glyph advances and their sum. This adapter wraps the engine's built-in
 * TrueType font into a HarfBuzz face and shapes each run through the REAL
 * shaping stack: cmap lookup, kerning (GPOS/kern), ligatures (GSUB),
 * complex-script clustering.
 *
 * harfbuzzjs v1 initializes itself on module load (top-level WASM compile);
 * the classes (Blob/Face/Font/Buffer/shape) come straight from the package.
 * Advances are HarfBuzz's own output scaled by fontSize/unitsPerEm, so line
 * breaking becomes kerning- and ligature-aware for the first time.
 *
 * The adapter is injected via `layout(..., { shaper })` exactly like the
 * metrics placeholder — the layout algorithm is unchanged (the seam's point).
 */
import * as hb from "harfbuzzjs";

import { px } from "@browser-engine/ir";
import type { Px } from "@browser-engine/ir";

import { builtinFontBytes } from "./builtin.js";
import type { ShapedGlyph, ShapedRun, TextShaper } from "./text-shaper-types.js";

/** The built-in font's HarfBuzz face/font (lazy — one per process). */
let hbFont: hb.Font | undefined;
let faceUpeM: number = 1000;

/** Load the built-in font into a HarfBuzz face (cached). */
function ensureFont(): hb.Font {
  if (hbFont !== undefined) {
    return hbFont;
  }
  const blob = new hb.Blob(builtinFontBytes().slice().buffer);
  const face = new hb.Face(blob, 0);
  faceUpeM = face.upem;
  const font = new hb.Font(face);
  // Keep the font in its natural units; the shaper scales to CSS px itself.
  font.setScale(faceUpeM, faceUpeM);
  hbFont = font;
  return font;
}

/**
 * Create the REAL HarfBuzz shaper (E1). Synchronous per-call once the font is
 * loaded (the WASM module self-initializes on import); shaped runs carry
 * kerning and ligature-aware advances.
 */
export function createHarfBuzzShaper(): TextShaper {
  const font = ensureFont();
  return {
    shapeLine(text: string, shapingFont: { fontSize: Px; fontWeight?: number }): ShapedRun {
      if (text.length === 0) {
        return { advance: px(0), glyphs: [] };
      }
      const buffer = new hb.Buffer();
      try {
        buffer.addText(text);
        buffer.guessSegmentProperties();
        hb.shape(font, buffer);
        const infos = buffer.getGlyphInfos();
        const positions = buffer.getGlyphPositions();
        // Advances are in font units (the font is at native scale): convert to
        // CSS px via fontSize / unitsPerEm.
        const scale = Number(shapingFont.fontSize) / faceUpeM;
        const glyphs: ShapedGlyph[] = [];
        let total = 0;
        for (let i = 0; i < infos.length; i += 1) {
          const adv = (positions[i]?.xAdvance ?? 0) * scale;
          glyphs.push({ advance: px(adv) });
          total += adv;
        }
        // The seam expects one entry per UTF-16 unit (clusters may merge or
        // split code points): attribute each glyph's advance to its cluster's
        // first unit and zero the rest, preserving glyphs.length === text.length.
        if (infos.length !== text.length && glyphs.length > 0) {
          const perUnit: ShapedGlyph[] = Array.from({ length: text.length }, () => ({ advance: px(0) }));
          for (let i = 0; i < infos.length; i += 1) {
            const info = infos[i]!;
            const nextCluster = i + 1 < infos.length ? infos[i + 1]!.cluster : text.length;
            const units = Math.max(1, nextCluster - info.cluster);
            perUnit[info.cluster] = { advance: glyphs[i]!.advance };
            for (let u = 1; u < units; u += 1) {
              perUnit[info.cluster + u] = { advance: px(0) };
            }
          }
          for (let i = 0; i < text.length; i += 1) {
            if (perUnit[i] === undefined) {
              perUnit[i] = { advance: px(0) };
            }
          }
          return { advance: px(total), glyphs: perUnit };
        }
        return { advance: px(total), glyphs };
      } catch {
        // A shaping failure falls back to zero advances (the caller's line
        // breaker treats the run as unbreakable zero-width content).
        return { advance: px(0), glyphs: new Array(text.length).fill({ advance: px(0) }) };
      }
    },
  };
}
