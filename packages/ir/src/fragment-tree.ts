/**
 * Stage 4 IR: FragmentTree (design.md §6, Requirement 3.4).
 *
 * Output of the layout engine and the SINGLE source of truth for geometry.
 * Nominally branded `"FragmentTree"`. `getBoundingClientRect` derives its
 * rectangle from `Fragment.box.borderBox` and nowhere else.
 */
import type { Branded, FragmentId, NodeId } from "./brand.js";
import type { Px } from "./brand.js";
import type { BoxGeometry } from "./geometry.js";
import type { Color } from "./values.js";

/**
 * One laid-out glyph in a text fragment (RFC 0002): a REAL font-local glyph id
 * produced by the text shaper, the `faceIndex` naming which face of the
 * pipeline font table it belongs to, its position RELATIVE to the fragment's
 * content-box origin (pen position already folded with the shaper's draw
 * offsets), and the horizontal advance the pen moved. This is the layout
 * product of text shaping; paint copies it into a `text` paint command and the
 * backend rasterizes `faces[faceIndex].outlineOf(glyphId)` — no code-point
 * reinterpretation survives past the shaper.
 */
export interface LaidGlyph {
  readonly glyphId: number;
  readonly faceIndex: number;
  readonly x: Px;
  readonly y: Px;
  readonly advance: Px;
  /**
   * Vertical-text orientation (RFC 0025): `true` when the glyph is rendered
   * rotated 90° clockwise under `text-orientation` (`sideways`, or `mixed`
   * for non-upright scripts). Absent ⇒ upright.
   */
  readonly rotate90?: boolean;
  /**
   * This glyph's own `font-size` when it differs from the run (`::first-letter`
   * / `::first-line`). Absent ⇒ paint uses `TextRun.fontSize`.
   */
  readonly fontSize?: Px;
  /**
   * This glyph's own fill (`::first-letter` / `::first-line` `color`). Absent ⇒
   * paint uses the element's `color`.
   */
  readonly color?: Color;
  /**
   * This glyph's own `font-weight` (100–900) when a pseudo sets one. Absent ⇒
   * paint uses the run's weight.
   */
  readonly fontWeight?: number;
  /**
   * This glyph's own `font-style` when a pseudo sets one. Absent ⇒ paint uses
   * the element's style (the face selection), and does not add a shear.
   */
  readonly fontStyle?: "normal" | "italic" | "oblique";
}

/** The shaped, positioned glyph run a text fragment carries. */
export interface TextRun {
  /** The computed `font-size` (cell height) the glyphs are sized to. */
  readonly fontSize: Px;
  /** Computed font-weight (100–900); absent ⇒ 400. */
  readonly fontWeight?: number;
  /**
   * `font-synthesis` gate for fake bolding (RFC 0006): `false` when the
   * computed value lacks `weight` (`none`, `style`, …) — backends must not
   * embolden this run. Absent ⇒ synthesis allowed (spec initial).
   */
  readonly synthesizeBold?: boolean;
  /**
   * `font-synthesis` gate for a fake italic shear. `false` when the computed
   * value lacks `style`. Absent ⇒ synthesis allowed.
   */
  readonly synthesizeStyle?: boolean;
  /**
   * The pen axis the glyph advances step along (RFC 0025): `"y"` inside
   * vertical writing modes — `advance` then measures the VERTICAL pen step.
   * Absent ⇒ `"x"` (horizontal).
   */
  readonly advanceAxis?: "x" | "y";
  /**
   * The writing mode the run was laid out in — `"vertical-rl"` /
   * `"vertical-lr"` / `"sideways-*"` when the text is columnar. Absent ⇒
   * `"horizontal-tb"`.
   */
  readonly writingMode?: string;
  /** The positioned glyphs, relative to the fragment's content-box origin. */
  readonly glyphs: readonly LaidGlyph[];
  /**
   * Border around `::first-letter`, in the same content-box space as `glyphs`.
   * Absent when the pseudo has no drawn border.
   */
  readonly letterBorder?: LetterBorder;
  /**
   * Background of `::first-letter`, in the same content-box space as `glyphs`.
   * The rectangle is the border box. Absent when the pseudo paints no fill.
   */
  readonly letterBackground?: LetterBackground;
  /**
   * `background-image` of `::first-letter`. `x`/`y`/`width`/`height` is the
   * border box (the clip). The origin fields are the padding box. Absent when
   * the pseudo has no url image.
   */
  readonly letterImage?: LetterImage;
  /**
   * Background of `::first-line`, in the same content-box space as `glyphs`.
   * The rectangle covers the first line's glyph run. Absent when that pseudo
   * paints no fill.
   */
  readonly lineBackground?: LetterBackground;
  /**
   * `background-image` of `::first-line`. The clip and the position origin are
   * both the first line's glyph run. Absent when that pseudo has no url image.
   */
  readonly lineImage?: LetterImage;
  /** Underline, overline, or line-through segments for `::first-letter` / `::first-line`. */
  readonly decorations?: readonly TextDecorationMark[];
}

/** One decoration stroke in the text fragment's content-box space. */
export interface TextDecorationMark {
  readonly x: Px;
  readonly y: Px;
  readonly width: Px;
  readonly color: Color;
  readonly line: "underline" | "overline" | "line-through";
}

/** A `::first-letter` background image, relative to the text fragment's content origin. */
export interface LetterImage {
  readonly x: Px;
  readonly y: Px;
  readonly width: Px;
  readonly height: Px;
  readonly originX: Px;
  readonly originY: Px;
  readonly originWidth: Px;
  readonly originHeight: Px;
  readonly image: string;
  readonly repeat: string;
  readonly size: string;
  readonly position: string;
}

/** The border-box fill of `::first-letter`, relative to the text fragment's content origin. */
export interface LetterBackground {
  readonly x: Px;
  readonly y: Px;
  readonly width: Px;
  readonly height: Px;
  readonly color: Color;
}

/** One edge of a `::first-letter` border. */
export interface LetterBorderSide {
  readonly width: Px;
  readonly style: "none" | "solid" | "dashed" | "dotted" | "double";
  readonly color: Color;
}

/** The border box of `::first-letter`, relative to the text fragment's content origin. */
export interface LetterBorder {
  readonly x: Px;
  readonly y: Px;
  readonly width: Px;
  readonly height: Px;
  readonly top: LetterBorderSide;
  readonly right: LetterBorderSide;
  readonly bottom: LetterBorderSide;
  readonly left: LetterBorderSide;
}

/** One laid-out box. `node` is a read-only back-reference into the DomTree. */
export interface Fragment {
  /** back-reference to the DOM node, read-only */
  readonly node: NodeId;
  /** the only legal source for getBoundingClientRect */
  readonly box: BoxGeometry;
  readonly children: readonly FragmentId[];
  /**
   * The shaped glyph run for a text-bearing leaf fragment (absent for boxes
   * that bear no text). Carrying it on the fragment is how the laid-out text
   * reaches paint, which has no access to the DomTree's text content. Glyph
   * positions are relative to this fragment's content-box origin, so they move
   * with the fragment under `offsetFragment` and need no re-positioning.
   */
  readonly text?: TextRun;
}

/** The laid-out fragment tree. Nominally branded. */
export type FragmentTree = Branded<
  {
    readonly root: FragmentId;
    readonly fragments: ReadonlyMap<FragmentId, Fragment>;
  },
  "FragmentTree"
>;
