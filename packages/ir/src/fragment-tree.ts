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

/**
 * One laid-out glyph in a text fragment: an abstract glyph id (= Unicode code
 * point for the built-in bitmap font; a real shaper produces font-specific ids),
 * its top-left position RELATIVE to the fragment's content-box origin, and the
 * horizontal cell width (`advance`) the backend scales the glyph into. This is
 * the layout product of text shaping; paint copies it into a `text` paint
 * command and the backend rasterizes it.
 */
export interface LaidGlyph {
  readonly glyphId: number;
  readonly x: Px;
  readonly y: Px;
  readonly advance: Px;
}

/** The shaped, positioned glyph run a text fragment carries. */
export interface TextRun {
  /** The computed `font-size` (cell height) the glyphs are sized to. */
  readonly fontSize: Px;
  /** The positioned glyphs, relative to the fragment's content-box origin. */
  readonly glyphs: readonly LaidGlyph[];
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
