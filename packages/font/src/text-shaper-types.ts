/**
 * text-shaper-types.ts — the TextShaper seam types, re-declared for the font
 * package. The seam lives in `@browser-engine/layout` (the layout stage owns
 * it), but the constitution forbids the font package from importing a stage's
 * internals — so this module mirrors the seam's SHAPE. `layout` re-exports
 * these same types; the structural (duck) typing keeps both sides in sync
 * without a cross-stage import.
 */
import type { Px } from "@browser-engine/ir";

/** The font parameters a shaper needs (mirrors layout's ShapingFont). */
export interface ShapingFont {
  readonly fontSize: Px;
  readonly fontWeight?: number;
  readonly ascentEm?: number;
}

/** One shaped glyph's horizontal advance (mirrors layout's ShapedGlyph). */
export interface ShapedGlyph {
  readonly advance: Px;
}

/** The result of shaping one run (mirrors layout's ShapedRun). */
export interface ShapedRun {
  readonly advance: Px;
  readonly glyphs: readonly ShapedGlyph[];
}

/** The shaping boundary (mirrors layout's TextShaper). */
export interface TextShaper {
  shapeLine(text: string, font: ShapingFont): ShapedRun;
}
