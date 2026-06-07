/**
 * fonts.ts — the wiring layer's REAL FONT bridge.
 *
 * Loads the deterministic built-in TrueType font from `@browser-engine/font`
 * and adapts it to the two narrow seams the pipeline injects:
 *
 *   - {@link pipelineShaper} — a layout {@link TextShaper} whose advances come
 *     from the font's real `hmtx` metrics (via its `cmap`), so text width and
 *     line breaking match the glyphs that get drawn;
 *   - {@link pipelineGlyphSource} — the backend's glyph coverage source, which
 *     rasterizes the same font's real vector outlines (anti-aliased).
 *
 * Both are backed by the SAME {@link FontFace}, so metrics and rendering agree.
 * This is the cli's job (composing stages); the stages themselves only ever see
 * the injected interfaces, never the font package.
 */
import { px } from "@browser-engine/ir";
import {
  builtinFont,
  coverageSource,
  type FontFace,
  type GlyphCoverageSource,
} from "@browser-engine/font";
import type { ShapedGlyph, ShapingFont, ShapedRun, TextShaper } from "@browser-engine/layout";

/** The active font face for the pipeline (the deterministic built-in font). */
const FACE: FontFace = builtinFont();

/** The backend glyph coverage source — real outline rasterization. */
export const pipelineGlyphSource: GlyphCoverageSource = coverageSource(FACE);

/**
 * A font-backed text shaper: per-glyph advance = `fontSize × advanceWidth /
 * unitsPerEm`, read from the font's real metrics through its `cmap`. Still a
 * metrics shaper (no kerning/ligatures/complex-script shaping — that is the
 * HarfBuzz seam), but the advances are a real font's, not a fixed ratio.
 */
export const pipelineShaper: TextShaper = {
  shapeLine(text: string, font: ShapingFont): ShapedRun {
    const glyphs: ShapedGlyph[] = [];
    let total = 0;
    for (const ch of text) {
      const gid = FACE.glyphIdForCodePoint(ch.codePointAt(0)!);
      const adv = font.fontSize * (FACE.metricsOf(gid).advanceWidth / FACE.unitsPerEm);
      // One slot per UTF-16 unit; the cluster advance lands on its first unit.
      for (let u = 0; u < ch.length; u += 1) glyphs.push({ advance: px(u === 0 ? adv : 0) });
      total += adv;
    }
    return { advance: px(total), glyphs };
  },
};
