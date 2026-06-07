/**
 * @browser-engine/layout
 *
 * Layout engine (design.md §4.1, §8.2). The query `qLayout` consumes the frozen
 * DomTree + per-node ComputedStyle and produces the {@link FragmentTree} IR —
 * the SINGLE source of truth for geometry (`BoxGeometry`). `getBoundingClient
 * Rect` (task 3.8) reads ONLY a fragment's `borderBox`.
 *
 * ## Phase 1 minimal scope (task 3.7; Requirement 14.1)
 *
 * This is the *minimal block-level* engine that makes the end-to-end vertical
 * slice (`<div>hello</div>` → DOM → cascade → layout → paint → PNG) lay out. It
 * deliberately implements only what Phase 1 needs:
 *
 *   - **Block flow (the default).** Every box that produces a fragment and is
 *     not dispatched to an advanced branch (below) is stacked as a block:
 *     children are laid out top-to-bottom, `cursorY` accumulating each child's
 *     *margin-box* height. `inline` / `inline-block` elements use this same
 *     block algorithm so the slice still produces geometry.
 *   - **`display:none` produces no fragment** (and its subtree is skipped).
 *
 * ## Phase 5-7 advanced layout BRANCHES (task 7.1; Requirement 16.1)
 *
 * `flex` / `grid` / `table` / `float` / positioned layout are added as NEW
 * layout-query BRANCHES dispatched off the element's computed `display` (and
 * `position` / `float`), WITHOUT changing the FragmentTree IR boundary
 * (design.md §8.2 note — "flex/grid/table/float/position 在 Phase 5-7 作为新的
 * layout query 分支加入,不改 IR 边界"). Each branch still produces ordinary
 * {@link Fragment}s carrying {@link BoxGeometry}, so `getBoundingClientRect`,
 * paint, and the geometry single-source property are untouched:
 *
 *   - **`display:flex`** → {@link layout}'s `layoutFlex`: a single-line flex
 *     pass. In the default `row` direction, items are laid along the main axis;
 *     items with a declared width keep it and the remaining main-axis space is
 *     shared EQUALLY among the auto-width items (a genuine, flex-grow-less
 *     distribution), aligned to the cross-start edge. `column` stacks items.
 *   - **`display:grid`** → `layoutGrid`: a basic fixed-column grid that places
 *     children row-major into equal-width cells (`grid-template-columns` modelled
 *     as a positive integer track count), each row as tall as its tallest cell.
 *   - **`display:table`** → `layoutTable`: a basic table laying out
 *     table → rows → cells, columns aligned to a shared cell width and each row
 *     as tall as its tallest cell.
 *   - **`float:left` / `float:right`** (handled inside block flow) → the floated
 *     box is shifted to the container's left/right edge and taken out of the
 *     vertical flow, so following content flows beside it (its `cursorY` is not
 *     advanced by the float).
 *   - **`position:relative` / `position:absolute`** (handled inside block flow)
 *     → a relative box is laid out in normal flow then visually offset by its
 *     insets (the space it occupied is preserved); an absolute box is removed
 *     from flow and positioned at its insets relative to the container.
 *
 * The default block/inline path (no `flex`/`grid`/`table`, no `float`, static
 * position) is byte-for-byte unchanged, so all Phase 1-4 tests stay green and
 * the block-flow y-monotonic invariant still holds for that path.
 *
 * ### Reading layout properties defensively (the pending generator extension)
 *
 * The cascade `generator` does NOT yet emit the properties these branches
 * consult — `position`, `top`/`right`/`bottom`/`left`, `float`,
 * `flex-direction`, `grid-template-columns` — nor even `display:table`: its
 * property table currently carries only color / display / width / height /
 * margin / background-color / font-size. So **real cascade output never triggers
 * an advanced branch**, and a plain document exercises only the block/inline
 * path. Exactly as task 5.8 did for `border`, each extra property is read
 * DEFENSIVELY off `ComputedStyle`'s open `[k: string]: unknown` index signature,
 * narrowed to the expected shape only when present and well-formed (else a sane
 * fallback). The branches + dispatch are genuinely implemented and tested with a
 * synthetic `ComputedStyle` that carries those properties, proving the
 * Layout_Engine SUPPORTS these modes (Req 16.1). Wiring them as real generated
 * CSS properties (so the cascade emits them) is a PENDING generator
 * property-table extension; once it lands, these same branches consume the typed
 * fields with no IR-boundary change.
 *   - **Text** is laid out by `layoutInline` (task 5.7): the injected
 *     {@link TextShaper} shapes the run into glyph advances, and a real
 *     shape-then-break algorithm wraps the advances into LINE BOXES against the
 *     containing inline width, breaking at whitespace. See `layoutInline` below
 *     for the wrapped-text fragment representation.
 *   - **Width/height/margin** resolve from `ComputedStyle` (Requirement 14.2):
 *     `width:auto` fills the containing block minus horizontal margins;
 *     `height:auto` is the content height (the accumulated child margin-box
 *     heights). Phase 1 has no padding or border, so contentBox = paddingBox =
 *     borderBox in size, and the margin box is the border box grown by margins.
 *
 * ## Key invariant (design.md §8.2)
 *
 * Within any block container, the laid-out children's `marginBox.y` is
 * **monotonically non-decreasing** in the block-flow direction, and the
 * container's content height equals the **sum of the children's margin-box
 * heights** (`child[i+1].marginBox.y === child[i].marginBox.y +
 * child[i].marginBox.height`). This is the correctness invariant Phase 1 and the
 * task 3.9 geometry property lean on.
 *
 * ## Coordinate system
 *
 * Each fragment's `BoxGeometry` is expressed **relative to its containing block**
 * (the parent's content origin), matching design.md §6 ("相对包含块"). Because
 * Phase 1 has no padding/border, a parent's content origin coincides with its
 * border-box origin, so absolute coordinates (task 3.8) are a simple ancestor
 * accumulation. Offsetting a child shifts only that child's own box; its
 * descendants stay relative to it.
 *
 * ## Purity & the existing signature (Requirement 2.7)
 *
 * `layout(dom, computedStyleOf)` is a PURE, deterministic function of its inputs
 * (no shared mutable state; all scaffolding is local), so it is safe as the
 * memoized `qLayout` query — memoization/invalidation are the kernel's job, not
 * layout's. The result is `deepFreeze`-d (Requirement 3.2). The root containing
 * width defaults to {@link DEFAULT_VIEWPORT_WIDTH} (a documented constant) and
 * can be overridden via the optional `options.viewportWidth`, keeping the
 * `cli/pipeline.ts` call site (`layout(dom, styleOf)`) compiling unchanged. The
 * {@link TextShaper} used for inline text defaults to `defaultShaper` (the
 * metrics placeholder) and can be overridden via `options.shaper` so a HarfBuzz
 * adapter is injected WITHOUT changing the call site (Req 8.1 / 8.3).
 *
 * This module imports ONLY the frozen IR (`@browser-engine/ir`) — the single
 * sanctioned inter-stage channel — so it never reaches across a stage boundary
 * (`local/no-cross-stage-import`). It receives `ComputedStyle` through the
 * injected `computedStyleOf` callback rather than importing the cascade.
 */
import { deepFreeze, fragmentId, px } from "@browser-engine/ir";
import type {
  BoxGeometry,
  ComputedStyle,
  DomNode,
  DomTree,
  Edges,
  Fragment,
  FragmentId,
  FragmentTree,
  LaidGlyph,
  NodeId,
  Px,
  Rect,
  TextRun,
} from "@browser-engine/ir";

import { defaultShaper } from "./text-shaper.js";
import type { ShapingFont, TextShaper } from "./text-shaper.js";

export const PACKAGE_NAME = "@browser-engine/layout" as const;

// The text-shaping seam (design.md §8.2; Requirements 15.3, 8.1, 8.3). Inline
// layout shapes + breaks text through the abstract {@link TextShaper}; the
// concrete shaper (the metrics placeholder today, a HarfBuzz adapter tomorrow)
// is injected via `layout(..., { shaper })`. Re-exported here so consumers
// import the seam alongside `layout`.
export {
  defaultShaper,
  metricsShaper,
  proportionalShaper,
  proportionalAdvanceEm,
  METRICS_ADVANCE_RATIO,
} from "./text-shaper.js";
export type {
  ShapedGlyph,
  ShapedRun,
  ShapingFont,
  TextShaper,
} from "./text-shaper.js";

// getBoundingClientRect (task 3.8) — reads geometry ONLY from the FragmentTree's
// borderBox (design.md §8.4; Requirement 3.4). Lives in its own module; re-
// exported here so consumers (e.g. the generated DOM surface) import it from the
// layout package alongside `layout`.
export { getBoundingClientRect } from "./bounding-rect.js";

// Bidi text ordering + complex-script itemization (task 9.1; Requirement 17.1).
// The engine-owned half of international text: UAX #9 base direction, embedding
// levels, visual reordering, directional runs, and script itemization that a
// reused complex-script shaper (HarfBuzz) is invoked per run on.
export {
  baseDirection,
  bidiClass,
  bidiRuns,
  reorderVisual,
  resolveLevels,
  scriptOf,
  scriptRuns,
  type BidiClass,
  type BidiRun,
  type Direction,
  type Script,
  type ScriptRun,
} from "./bidi.js";

/**
 * The default root containing width, in CSS pixels — the viewport width an
 * `auto`-width block fills when nothing overrides it. 800px is a conventional
 * minimal viewport; Phase 1 needs only *a* stable, documented choice so layout
 * is deterministic. Override per call via {@link LayoutOptions.viewportWidth}.
 */
export const DEFAULT_VIEWPORT_WIDTH: Px = px(800);

/**
 * The default viewport height, in CSS pixels — the height the quirks-mode
 * full-canvas root (see {@link LayoutOptions.quirksMode}) stretches an
 * auto-height root to. 600px pairs with the 800px default width (a conventional
 * minimal viewport). Override per call via {@link LayoutOptions.viewportHeight}.
 */
export const DEFAULT_VIEWPORT_HEIGHT: Px = px(600);

/** Options for {@link layout}. All optional, so `layout(dom, styleOf)` is valid. */
export interface LayoutOptions {
  /** The root containing-block width. Defaults to {@link DEFAULT_VIEWPORT_WIDTH}. */
  readonly viewportWidth?: Px;
  /**
   * The text-shaping library used by inline layout (Req 15.3 / 8.1 / 8.3).
   * Defaults to {@link defaultShaper} (the metrics placeholder); inject a
   * HarfBuzz adapter here to swap in real shaping without touching the call
   * site or the line-breaking algorithm.
   */
  readonly shaper?: TextShaper;
  /**
   * Whether the document is in QUIRKS mode (task 9.4; Requirement 17.4). When
   * `true`, the layout engine applies quirks-mode behaviours; when `false` (the
   * default — standards / no-quirks mode) layout is byte-for-byte unchanged. The
   * document mode is determined by the HTML parser from the DOCTYPE
   * (`detectDocumentMode`); the wiring layer threads it in here.
   *
   * The one quirk implemented at this layer is the classic "quirks-mode
   * full-canvas root": the root `document` block's AUTO height stretches to fill
   * at least {@link viewportHeight}, so a short document still paints a
   * full-viewport canvas (the well-known quirks-mode body/html height
   * behaviour). A document with an explicit root height, or in standards mode,
   * is unaffected.
   */
  readonly quirksMode?: boolean;
  /**
   * The viewport height the quirks-mode full-canvas root stretches to (used only
   * when {@link quirksMode} is `true`). Defaults to {@link DEFAULT_VIEWPORT_HEIGHT}.
   */
  readonly viewportHeight?: Px;
}

/** A box with no margins on any edge (text/leaf boxes carry no margin in Phase 1). */
const ZERO_MARGIN: Edges<Px> = {
  top: px(0),
  right: px(0),
  bottom: px(0),
  left: px(0),
};

/**
 * Lay the document out into a {@link FragmentTree} (design.md §8.2).
 *
 * @param dom the frozen DomTree IR.
 * @param computedStyleOf accessor for a node's frozen, geometry-free ComputedStyle.
 * @param options optional layout parameters (e.g. the root containing width).
 * @returns the deep-frozen FragmentTree — the sole source of geometry.
 */
export function layout(
  dom: DomTree,
  computedStyleOf: (node: NodeId) => ComputedStyle,
  options?: LayoutOptions,
): FragmentTree {
  const viewportWidth = options?.viewportWidth ?? DEFAULT_VIEWPORT_WIDTH;
  const shaper: TextShaper = options?.shaper ?? defaultShaper;
  const quirksMode = options?.quirksMode ?? false;
  const viewportHeight = options?.viewportHeight ?? DEFAULT_VIEWPORT_HEIGHT;

  // Local mutable scaffolding — never escapes this call, so `layout` stays pure.
  const fragments = new Map<FragmentId, Fragment>();
  let nextId = 0;

  /** Register a built fragment in the flat map and hand back its fresh id. */
  function register(fragment: Fragment): FragmentId {
    const id = fragmentId(nextId);
    nextId += 1;
    fragments.set(id, fragment);
    return id;
  }

  /**
   * The ComputedStyle of a child *element*, or `null` for non-elements (text /
   * comment / document) which carry no `float`/`position`/flex-item style.
   * `layoutBlock` uses this to decide float / positioning of in-flow children
   * without assuming every child id has a meaningful style.
   */
  function childStyleOf(id: NodeId): ComputedStyle | null {
    const node = dom.nodes.get(id);
    if (node === undefined || node.kind !== "element") {
      return null;
    }
    return computedStyleOf(id);
  }

  /**
   * Lay out one DOM node, returning an UNREGISTERED fragment positioned at the
   * origin (its margin-box top-left at `(0, 0)`); the caller offsets it into
   * place and registers it. Descendants are registered during recursion.
   * Returns `null` when the node produces no box (comment, or `display:none`).
   */
  function layoutNode(id: NodeId, containingWidth: Px): Fragment | null {
    const node = dom.nodes.get(id);
    if (node === undefined || node.kind === "comment") {
      return null;
    }
    if (node.kind === "text") {
      return layoutInline(node, containingWidth);
    }
    // element or document.
    if (node.kind === "element") {
      // Dispatch off the element's computed `display` into the advanced layout
      // BRANCHES (task 7.1; Req 16.1) WITHOUT changing the IR boundary
      // (design.md §8.2 note). `display` is read as a *string* so the `table`
      // keyword — not in the `DisplayValue` union because the generator's
      // property table does not yet emit it — can be matched defensively.
      const display = readDisplay(computedStyleOf(id));
      if (display === "none") {
        return null; // skip the element and its entire subtree.
      }
      if (display === "flex") {
        return layoutFlex(node, containingWidth);
      }
      if (display === "grid") {
        return layoutGrid(node, containingWidth);
      }
      if (display === "table") {
        return layoutTable(node, containingWidth);
      }
      if (establishesMulticol(computedStyleOf(id))) {
        return layoutMulticol(node, containingWidth);
      }
    }
    return layoutBlock(node, containingWidth);
  }

  /**
   * Block layout (design.md §8.2 `layoutBlock`): resolve this box's width, stack
   * its children top-to-bottom (cursorY += child margin-box height), then
   * resolve its height from style or the accumulated content height.
   *
   * Two Phase 5-7 BRANCHES (task 7.1; Req 16.1) ride inside this default flow,
   * keyed off properties read defensively off the open ComputedStyle index
   * signature (the generator does not yet emit them, so they never fire for a
   * real-cascade document — see the module doc):
   *
   *   - **float** (`float:left|right`): the child is shifted to the container's
   *     left/right content edge and TAKEN OUT of the vertical flow, so `cursorY`
   *     is not advanced and the following in-flow content flows beside it.
   *   - **positioned** (`position:relative|absolute`): a `relative` child is
   *     laid out in normal flow then visually offset by its insets (its in-flow
   *     space is preserved, so `cursorY` advances by its margin box); an
   *     `absolute` child is removed from flow (no `cursorY` advance) and placed
   *     at its insets relative to the container's content origin.
   */
  function layoutBlock(node: DomNode, containingWidth: Px): Fragment {
    const style = computedStyleOf(node.id);
    const margin = resolveMargin(style);
    const padding = resolvePadding(style);
    const border = resolveBorder(style);
    const contentWidth = resolveWidth(style, containingWidth, margin, padding, border);

    // The content origin (relative to this box's border-box origin), into which
    // in-flow children are laid. Zero padding/border ⇒ (0, 0), so the existing
    // child coordinates are byte-for-byte unchanged.
    const contentLeft = border.left + padding.left;
    const contentTop = border.top + padding.top;

    let cursorY = 0;
    // The bottom margin of the previous in-flow sibling, for adjacent-sibling
    // margin collapsing (null until the first in-flow child is placed).
    let prevBottomMargin: number | null = null;
    const childIds: FragmentId[] = [];
    for (const childNodeId of node.children) {
      const childFrag = layoutNode(childNodeId, contentWidth);
      if (childFrag === null) {
        continue;
      }
      const childStyle = childStyleOf(childNodeId);
      const float = childStyle === null ? "none" : readFloat(childStyle);
      const position = childStyle === null ? "static" : readPosition(childStyle);

      if (float === "left" || float === "right") {
        // Floated: shift to the container's left/right content edge, out of the
        // vertical flow (cursorY is NOT advanced — following content flows by).
        // A float does not participate in margin collapsing (prevBottomMargin
        // is left untouched, so the blocks around it still collapse).
        const dx =
          float === "left"
            ? 0
            : Math.max(0, contentWidth - childFrag.box.marginBox.width);
        childIds.push(register(offsetFragment(childFrag, contentLeft + dx, contentTop + cursorY)));
        continue;
      }

      if (position === "absolute") {
        // Out of flow: positioned at its insets relative to the content origin;
        // cursorY is NOT advanced (it occupies no in-flow space) and it does not
        // collapse margins with its siblings.
        const insets = readInsets(childStyle);
        childIds.push(register(offsetFragment(childFrag, contentLeft + insets.left, contentTop + insets.top)));
        continue;
      }

      // In normal flow. Collapse this in-flow child's TOP margin with the
      // previous in-flow sibling's BOTTOM margin (CSS 2.1 §8.3.1): the gap
      // between them is the collapsed margin, not the sum, so pull this child up
      // by the overlap. With no vertical margins the overlap is 0 — unchanged.
      const childMargin = childStyle === null ? ZERO_MARGIN : resolveMargin(childStyle);
      if (prevBottomMargin !== null) {
        const overlap = (prevBottomMargin + childMargin.top) - collapsedMargin(prevBottomMargin, childMargin.top);
        cursorY -= overlap;
      }

      // Place at the content origin, advanced by (the collapsed) cursorY.
      let positioned = offsetFragment(childFrag, contentLeft, contentTop + cursorY);
      const advance = positioned.box.marginBox.height; // in-flow space reserved.
      if (position === "relative") {
        // Visually offset by the insets, but the in-flow space is preserved, so
        // cursorY still advances by the pre-offset margin-box height.
        const insets = readInsets(childStyle);
        positioned = offsetFragment(positioned, insets.left, insets.top);
      }
      childIds.push(register(positioned));
      cursorY += advance; // ← monotonic block advance (in-flow children only).
      prevBottomMargin = childMargin.bottom;
    }

    const contentHeight = resolveHeight(style, px(cursorY), padding, border);
    const box = buildBoxAtOrigin(margin, contentWidth, contentHeight, padding, border);
    return { node: node.id, box, children: childIds };
  }

  /**
   * Inline layout (design.md §8.2 `layoutInline`; Requirements 15.3, 8.1, 8.3):
   * shape the text run through the injected {@link TextShaper} and break it into
   * LINE BOXES that wrap to a new line when the content would exceed the
   * containing inline width. This is the real shape-then-break algorithm that
   * replaces the Phase 1 single-line estimate; dropping in a HarfBuzz adapter at
   * the {@link shaper} seam changes nothing here, because the break logic
   * consumes only the abstract {@link ShapedRun} advances.
   *
   * ## Algorithm
   *
   *   1. Collapse runs of whitespace (CSS `white-space: normal`) and tokenise the
   *      run into words, keeping whitespace as the only break opportunities.
   *   2. Measure each word's advance and the inter-word space advance through the
   *      shaper.
   *   3. Greedily pack words onto the current line; when the next word (plus the
   *      separating space) would overflow `containingWidth`, start a new line. A
   *      single word wider than the line still occupies its own line (it
   *      overflows rather than breaking mid-word, matching `white-space:normal`).
   *
   * ## Wrapped-text fragment representation (documented choice)
   *
   * The wrapped run is represented as a SINGLE text fragment with NO
   * sub-fragments, whose box height spans all the lines:
   *
   *     height = lineCount × lineHeight     (lineHeight derives from font-size)
   *     width  = widest line advance, clamped to the containing width
   *
   * Keeping it one childless fragment (rather than per-line sub-fragments) is the
   * representation the rest of the pipeline already expects: paint treats a
   * childless fragment as one text leaf and emits exactly one `text` command, and
   * `getBoundingClientRect` reads this fragment's `borderBox` directly (Property
   * 3 stays an exact identity). Because the metrics placeholder's advance ratio
   * matches the Phase 1 estimate, a SHORT single-line run (e.g. "hello") packs
   * onto one line, so its box is exactly `fontSize` tall — preserving the
   * existing `<div>hello</div>` geometry the slice's downstream checks assert.
   */
  function layoutInline(node: DomNode, containingWidth: Px): Fragment {
    const style = computedStyleOf(node.id);
    const fontSize = style.fontSize;
    const content = node.text ?? "";
    const font: ShapingFont = { fontSize };

    // Whitespace collapses to break opportunities; words are the unbreakable
    // units. An empty or whitespace-only run renders no line (zero geometry),
    // matching the Phase 1 empty-text behaviour.
    const words = content.split(/\s+/).filter((word) => word.length > 0);
    if (words.length === 0) {
      const box = buildBoxAtOrigin(ZERO_MARGIN, px(0), px(0));
      return { node: node.id, box, children: [] };
    }

    // Line height = `line-height` (a unitless multiplier) × font-size. The
    // initial multiplier is 1.0 (our metrics shaper's one-em line box), so an
    // undeclared run is exactly `font-size` tall — byte-for-byte Phase-1
    // behaviour; a declared `line-height` genuinely scales the line box.
    const lineHeight = px(readLineHeight(style) * fontSize);
    const letterSpacing = readSpacing(style["letterSpacing"]);
    const wordSpacing = readSpacing(style["wordSpacing"]);
    const spaceAdvance = shaper.shapeLine(" ", font).advance + wordSpacing;

    // `white-space` controls whether the run wraps at the containing width. The
    // wrapping values (`normal`/`pre-wrap`/`pre-line`) break greedily at spaces;
    // the non-wrapping values (`nowrap`/`pre`) keep the whole run on ONE line
    // (which may overflow the containing width). The initial value is `normal`,
    // so an undeclared run wraps exactly as before — byte-for-byte Phase-1.
    const wraps = whiteSpaceWraps(readWhiteSpace(style));

    // Greedy line breaking: accumulate the per-line advances AND position each
    // glyph. Glyph positions are relative to the fragment's content-box origin
    // (x from 0 per line, y = lineIndex × lineHeight); the fragment's own offset
    // — including any `text-align` delta below — carries them into place, so the
    // box geometry stays exactly as before (zero regression) while paint now has
    // real glyphs to draw.
    const glyphs: LaidGlyph[] = [];
    const placeWord = (word: string, startX: number, lineIndex: number): void => {
      let penX = startX;
      for (const ch of word) {
        const advance = shaper.shapeLine(ch, font).advance + letterSpacing;
        glyphs.push({
          glyphId: ch.codePointAt(0) ?? 0,
          x: px(penX),
          y: px(lineIndex * lineHeight),
          advance: px(advance),
        });
        penX += advance;
      }
    };

    const lineWidths: number[] = [];
    let current = 0; // advance of the line currently being filled.
    let lineHasContent = false;
    let lineIndex = 0;
    for (const word of words) {
      // `letter-spacing` adds advance after each glyph; the metrics shaper emits
      // one glyph per code unit, so the extra is `letterSpacing × word.length`
      // (0 by default ⇒ the inline width is unchanged).
      const wordAdvance = shaper.shapeLine(word, font).advance + letterSpacing * word.length;
      if (!lineHasContent) {
        placeWord(word, 0, lineIndex);
        current = wordAdvance; // first word always fits on its (own) line.
        lineHasContent = true;
        continue;
      }
      const tentative = current + spaceAdvance + wordAdvance;
      if (wraps && tentative > containingWidth) {
        lineWidths.push(current); // close the current line and wrap.
        lineIndex += 1;
        placeWord(word, 0, lineIndex);
        current = wordAdvance;
      } else {
        placeWord(word, current + spaceAdvance, lineIndex); // after the space gap.
        current = tentative; // the word (and its space) fit on this line (or no-wrap keeps it).
      }
    }
    lineWidths.push(current); // close the final, in-progress line.

    const lineCount = lineWidths.length; // ≥ 1 here.
    const contentHeight = px(lineCount * lineHeight);
    const widestLine = lineWidths.reduce((max, w) => (w > max ? w : max), 0);
    // A wrapping run is clamped to the containing width (its lines fit by
    // construction); a non-wrapping (`nowrap`/`pre`) run keeps its full width,
    // which may OVERFLOW the container (the overflow is then clipped/visible per
    // `overflow`). Default `normal` wraps ⇒ the clamp is unchanged.
    const contentWidth = wraps ? px(Math.min(containingWidth, widestLine)) : px(widestLine);
    // `text-align` shifts the inline content horizontally within the containing
    // width. We model the run as one box of width `contentWidth`, so alignment
    // is a horizontal offset of that box inside `containingWidth`: `start`/`left`
    // ⇒ 0 (unchanged), `end`/`right` ⇒ all the slack, `center` ⇒ half. `justify`
    // has no inter-word stretching in this single-box model, so it lays as
    // `start`. The initial value is `start`, so an undeclared run is unchanged.
    const alignDelta = textAlignOffset(readTextAlign(style), containingWidth, contentWidth);
    const box = buildBoxAtOrigin(ZERO_MARGIN, contentWidth, contentHeight);
    const textRun: TextRun = { fontSize, glyphs };
    const base: Fragment = { node: node.id, box, children: [], text: textRun };
    return alignDelta > 0 ? offsetFragment(base, alignDelta, 0) : base;
  }

  /**
   * Flex layout BRANCH (task 7.1; Req 16.1). A genuine, minimal single-line
   * flex pass with no flex-grow/shrink lines and no wrapping:
   *
   *   - **`row` (default).** Items are laid along the MAIN (horizontal) axis,
   *     left to right, each at the cross-start (top) edge. An item with a
   *     declared `width` keeps it; the remaining main-axis free space (container
   *     content width minus the fixed items' margin boxes) is shared EQUALLY
   *     among the auto-width (flexible) items, which are laid out against that
   *     share so their content genuinely fills it. With no declared widths this
   *     is the familiar "equal columns" flex row; with some fixed, the rest
   *     split what is left. The container's content height is the tallest item's
   *     margin-box height (or its declared `height`).
   *   - **`column`.** Items stack along the vertical main axis (equivalent to
   *     block stacking), each at the cross-start (left) edge.
   *
   * `flex-direction` is read defensively off the open ComputedStyle index
   * signature (see the module doc); an absent/unknown value means `row`.
   */
  function layoutFlex(node: DomNode, containingWidth: Px): Fragment {
    const style = computedStyleOf(node.id);
    const margin = resolveMargin(style);
    const contentWidth = resolveWidth(style, containingWidth, margin);
    const direction = readFlexDirection(style);

    const childIds: FragmentId[] = [];

    if (direction === "column") {
      // Column main axis ⇒ stack vertically at the cross-start (left) edge.
      let cursorY = 0;
      for (const childNodeId of node.children) {
        const frag = layoutNode(childNodeId, contentWidth);
        if (frag === null) {
          continue;
        }
        const placed = offsetFragment(frag, 0, cursorY);
        childIds.push(register(placed));
        cursorY += placed.box.marginBox.height;
      }
      const contentHeight = resolveHeight(style, px(cursorY));
      const box = buildBoxAtOrigin(margin, contentWidth, contentHeight);
      return { node: node.id, box, children: childIds };
    }

    // row. Pass 1 (style only): classify each box-producing child as FIXED (a
    // declared main-axis width) or FLEXIBLE (auto), and total the fixed items'
    // outer (margin-box) main extent so the free space can be shared.
    interface RowItem {
      readonly nodeId: NodeId;
      readonly flexible: boolean;
      readonly edges: Edges<Px>; // the item's own margins (0 for text/null).
      readonly fixedInnerWidth: Px; // declared content width when fixed (else 0).
    }
    const rowItems: RowItem[] = [];
    let fixedOuterMain = 0;
    let flexibleCount = 0;
    for (const childNodeId of node.children) {
      const childNode = dom.nodes.get(childNodeId);
      if (childNode === undefined || childNode.kind === "comment") {
        continue; // produces no box.
      }
      const childStyle = childStyleOf(childNodeId);
      const edges = childStyle === null ? ZERO_MARGIN : resolveMargin(childStyle);
      const declared = childStyle === null ? null : declaredWidthOf(childStyle);
      if (declared !== null) {
        const outer = declared + edges.left + edges.right;
        fixedOuterMain += outer;
        rowItems.push({ nodeId: childNodeId, flexible: false, edges, fixedInnerWidth: px(declared) });
      } else {
        flexibleCount += 1;
        rowItems.push({ nodeId: childNodeId, flexible: true, edges, fixedInnerWidth: px(0) });
      }
    }

    const freeMain = Math.max(0, contentWidth - fixedOuterMain);
    const flexOuterShare = flexibleCount > 0 ? freeMain / flexibleCount : 0;

    // Pass 2: lay each item out at its final main size and pack along the axis.
    let cursorX = 0;
    let maxHeight = 0;
    for (const item of rowItems) {
      // A flexible item is laid against its inner share (outer share minus its
      // own margins) so its auto width genuinely fills the distributed space; a
      // fixed item keeps its declared width regardless of the containing value.
      const innerWidth = item.flexible
        ? px(Math.max(0, flexOuterShare - item.edges.left - item.edges.right))
        : item.fixedInnerWidth;
      const frag = layoutNode(item.nodeId, innerWidth);
      if (frag === null) {
        continue;
      }
      const positioned = offsetFragment(frag, cursorX, 0); // cross-start top.
      childIds.push(register(positioned));
      cursorX += positioned.box.marginBox.width; // pack along the main axis.
      maxHeight = Math.max(maxHeight, positioned.box.marginBox.height);
    }
    const contentHeight = resolveHeight(style, px(maxHeight));
    const box = buildBoxAtOrigin(margin, contentWidth, contentHeight);
    return { node: node.id, box, children: childIds };
  }

  /**
   * Grid layout BRANCH (task 7.1; Req 16.1). A basic fixed-column grid: children
   * are placed row-major into equal-width cells of a `columns`-track grid
   * (`grid-template-columns` modelled as a positive integer track count, read
   * defensively; default 1). Each grid row is as tall as its tallest cell's
   * margin box, and rows stack top-to-bottom. Each child is re-laid against the
   * cell width and placed at its cell's top-left.
   */
  function layoutGrid(node: DomNode, containingWidth: Px): Fragment {
    const style = computedStyleOf(node.id);
    const margin = resolveMargin(style);
    const contentWidth = resolveWidth(style, containingWidth, margin);
    const columns = readGridColumns(style);
    const cellWidth = px(contentWidth / columns);

    // Lay each child against the cell width (children that produce a box).
    const cells: Fragment[] = [];
    for (const childNodeId of node.children) {
      const frag = layoutNode(childNodeId, cellWidth);
      if (frag !== null) {
        cells.push(frag);
      }
    }

    const childIds: FragmentId[] = [];
    let cursorY = 0;
    for (let i = 0; i < cells.length; i += columns) {
      const row = cells.slice(i, i + columns);
      const rowHeight = row.reduce(
        (max, cell) => Math.max(max, cell.box.marginBox.height),
        0,
      );
      row.forEach((cell, col) => {
        const placed = offsetFragment(cell, col * cellWidth, cursorY);
        childIds.push(register(placed));
      });
      cursorY += rowHeight; // next row starts below the tallest cell.
    }

    const contentHeight = resolveHeight(style, px(cursorY));
    const box = buildBoxAtOrigin(margin, contentWidth, contentHeight);
    return { node: node.id, box, children: childIds };
  }

  /**
   * Multi-column layout BRANCH (CSS Multi-column). An element with
   * `column-count` > 1 (or a `column-width` that fits ≥ 2 columns in the content
   * width) flows its block children into N equal-width columns separated by
   * `column-gap`, balanced by count (`column-fill: balance` — the default): each
   * column gets a contiguous run of ⌈children/N⌉ children, stacked vertically.
   * Each column is laid against the column width; the box's content height is
   * the tallest column. Produces ordinary {@link Fragment}s (no IR change).
   */
  function layoutMulticol(node: DomNode, containingWidth: Px): Fragment {
    const style = computedStyleOf(node.id);
    const margin = resolveMargin(style);
    const contentWidth = resolveWidth(style, containingWidth, margin);
    const gap = readColumnGap(style);
    const count = resolveColumnCount(style, contentWidth, gap);
    const colWidth = px((contentWidth - gap * (count - 1)) / count);

    // Lay every child against the column width (those that produce a box).
    const frags: Fragment[] = [];
    for (const childNodeId of node.children) {
      const frag = layoutNode(childNodeId, colWidth);
      if (frag !== null) frags.push(frag);
    }

    const perColumn = Math.max(1, Math.ceil(frags.length / count));
    const childIds: FragmentId[] = [];
    let maxColumnHeight = 0;
    for (let col = 0; col < count; col += 1) {
      const columnFrags = frags.slice(col * perColumn, (col + 1) * perColumn);
      const colX = col * (Number(colWidth) + gap);
      let cursorY = 0;
      for (const frag of columnFrags) {
        const placed = offsetFragment(frag, px(colX), px(cursorY));
        childIds.push(register(placed));
        cursorY += frag.box.marginBox.height;
      }
      maxColumnHeight = Math.max(maxColumnHeight, cursorY);
    }

    const contentHeight = resolveHeight(style, px(maxColumnHeight));
    const box = buildBoxAtOrigin(margin, contentWidth, contentHeight);
    return { node: node.id, box, children: childIds };
  }

  /**
   * Table layout BRANCH (task 7.1; Req 16.1). A basic table: the table's element
   * children are ROWS, and each row's element children are CELLS. Cells in a row
   * are laid left-to-right sharing a common column width (content width ÷ the
   * widest row's cell count); each row is as tall as its tallest cell, and rows
   * stack top-to-bottom. Row fragments are real {@link Fragment}s nested under
   * the table, so the FragmentTree shape mirrors table → row → cell.
   */
  function layoutTable(node: DomNode, containingWidth: Px): Fragment {
    const style = computedStyleOf(node.id);
    const margin = resolveMargin(style);
    const contentWidth = resolveWidth(style, containingWidth, margin);

    // Collect the row elements and their cell-element ids (skip non-elements).
    const rows: { readonly rowId: NodeId; readonly cellIds: readonly NodeId[] }[] = [];
    for (const rowNodeId of node.children) {
      const rowNode = dom.nodes.get(rowNodeId);
      if (rowNode === undefined || rowNode.kind !== "element") {
        continue;
      }
      const cellIds = rowNode.children.filter((cellId) => {
        const cell = dom.nodes.get(cellId);
        return cell !== undefined && cell.kind === "element";
      });
      rows.push({ rowId: rowNodeId, cellIds });
    }

    const columnCount = rows.reduce((max, r) => Math.max(max, r.cellIds.length), 0);
    const columnWidth = columnCount > 0 ? px(contentWidth / columnCount) : contentWidth;

    const rowFragmentIds: FragmentId[] = [];
    let cursorY = 0;
    for (const { rowId, cellIds } of rows) {
      // Lay out this row's cells across the shared column width.
      const cellFrags: Fragment[] = [];
      let cursorX = 0;
      const placedCellIds: FragmentId[] = [];
      for (const cellId of cellIds) {
        const cellFrag = layoutNode(cellId, columnWidth);
        if (cellFrag === null) {
          continue;
        }
        const placed = offsetFragment(cellFrag, cursorX, 0);
        cellFrags.push(placed);
        cursorX += columnWidth;
      }
      const rowHeight = cellFrags.reduce(
        (max, cell) => Math.max(max, cell.box.marginBox.height),
        0,
      );
      // Register the cells (their geometry is relative to the row's content).
      for (const placed of cellFrags) {
        placedCellIds.push(register(placed));
      }
      // The row fragment spans the full content width and its tallest cell.
      const rowBox = buildBoxAtOrigin(ZERO_MARGIN, contentWidth, px(rowHeight));
      const rowFrag = offsetFragment(
        { node: rowId, box: rowBox, children: placedCellIds },
        0,
        cursorY,
      );
      rowFragmentIds.push(register(rowFrag));
      cursorY += rowHeight; // rows stack top-to-bottom.
    }

    const contentHeight = resolveHeight(style, px(cursorY));
    const box = buildBoxAtOrigin(margin, contentWidth, contentHeight);
    return { node: node.id, box, children: rowFragmentIds };
  }

  // Lay out from the document root (its containing block is the viewport, at
  // origin). The root is never offset. A well-formed DomTree's root is the
  // `document`, which always produces a fragment; the fallback keeps `layout`
  // total for a degenerate (rootless) tree.
  const rootFrag =
    layoutNode(dom.root, viewportWidth) ??
    ({
      node: dom.root,
      box: buildBoxAtOrigin(ZERO_MARGIN, viewportWidth, px(0)),
      children: [],
    } satisfies Fragment);
  // Quirks-mode full-canvas root (task 9.4; Requirement 17.4): an auto-height
  // root stretches to fill at least the viewport height, so a short document
  // still paints a full-viewport canvas. Standards mode (the default) and a
  // root already taller than the viewport are left byte-for-byte unchanged.
  const root = register(quirksMode ? stretchRootToViewport(rootFrag, viewportHeight) : rootFrag);

  const tree = { root, fragments } as unknown as FragmentTree;
  return deepFreeze(tree);
}

// ---------------------------------------------------------------------------
// Style resolution (Phase 1 subset: width / height / margin).
// ---------------------------------------------------------------------------

/**
 * The node's computed margins. As with padding, the `margin` shorthand is not
 * expanded at cascade time, so the effective per-edge value is the declared
 * longhand (`margin-top`, …) when present, else the shorthand `margin` quad,
 * else 0. Margins may be NEGATIVE (unlike padding/border), so longhands are not
 * clamped here. Both `margin: 5px` (shorthand) and `margin-top: 5px` (longhand)
 * therefore resolve correctly, and absent everything ⇒ the initial 0 edges.
 */
function resolveMargin(style: ComputedStyle): Edges<Px> {
  const sh = style.margin;
  const pick = (longhand: unknown, short: Px): Px =>
    typeof longhand === "number" && Number.isFinite(longhand) && longhand !== 0 ? px(longhand) : short;
  return {
    top: pick(style["marginTop"], sh.top),
    right: pick(style["marginRight"], sh.right),
    bottom: pick(style["marginBottom"], sh.bottom),
    left: pick(style["marginLeft"], sh.left),
  };
}

/**
 * The COLLAPSED value of two adjacent vertical margins (CSS 2.1 §8.3.1): the
 * largest positive margin plus the most-negative negative margin. For two
 * non-negative margins this is simply `max(a, b)`; the general form also handles
 * negative margins. Two zero margins collapse to zero, so a document with no
 * vertical margins between siblings is byte-for-byte unchanged.
 */
function collapsedMargin(a: number, b: number): number {
  return Math.max(0, a, b) + Math.min(0, a, b);
}

// ---------------------------------------------------------------------------
// Box-model inset resolution: padding + border-width + box-sizing (the cascade
// now emits these as real generated fields, so block layout can give them
// genuine space). Every reader is defensive (fields are `unknown` on the open
// ComputedStyle index signature) and bottoms out at ZERO, so a box that
// declares none of them produces byte-for-byte the Phase-1 geometry.
// ---------------------------------------------------------------------------

/** Narrow an `unknown` length field to a non-negative {@link Px} (absent ⇒ 0). */
function readPx(value: unknown): Px {
  return typeof value === "number" && Number.isFinite(value) ? px(Math.max(0, value)) : px(0);
}

/** Narrow an `unknown` value to a non-negative {@link Edges}<Px>, or `null`. */
function readEdgesPx(value: unknown): Edges<Px> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const e = value as Record<string, unknown>;
  const t = e["top"], r = e["right"], b = e["bottom"], l = e["left"];
  if (
    typeof t === "number" && typeof r === "number" &&
    typeof b === "number" && typeof l === "number"
  ) {
    return { top: px(Math.max(0, t)), right: px(Math.max(0, r)), bottom: px(Math.max(0, b)), left: px(Math.max(0, l)) };
  }
  return null;
}

/**
 * The node's resolved padding on each edge. We do not expand the `padding`
 * shorthand at cascade time, so the effective per-edge value is the non-zero
 * longhand (`padding-top`, …) when present, else the shorthand `padding`
 * quad, else 0. Both `padding: 10px` (only the shorthand set) and
 * `padding-top: 5px` (only the longhand set) therefore resolve correctly.
 */
function resolvePadding(style: ComputedStyle): Edges<Px> {
  const sh = readEdgesPx(style["padding"]) ?? ZERO_MARGIN;
  const pick = (longhand: unknown, short: Px): Px => {
    const lv = readPx(longhand);
    return lv > 0 ? lv : short;
  };
  return {
    top: pick(style["paddingTop"], sh.top),
    right: pick(style["paddingRight"], sh.right),
    bottom: pick(style["paddingBottom"], sh.bottom),
    left: pick(style["paddingLeft"], sh.left),
  };
}

/** Whether a border-style keyword occupies layout space (`none`/`hidden` do not). */
function borderStyleDraws(keyword: string): boolean {
  return keyword !== "none" && keyword !== "hidden";
}

/**
 * The node's resolved border WIDTH on each edge — the space the border occupies
 * in the box model. A width contributes only when its edge's border-style is
 * something other than `none`/`hidden` (CSS: a styleless border takes no space).
 * Per-edge values use the non-zero longhand else the `border-width` shorthand;
 * the style is the non-`none` per-edge longhand else the `border-style`
 * shorthand. Absent everything ⇒ 0 on every edge (unchanged Phase-1 geometry).
 */
function resolveBorder(style: ComputedStyle): Edges<Px> {
  const shWidth = readEdgesPx(style["borderWidth"]) ?? ZERO_MARGIN;
  const shStyle = typeof style["borderStyle"] === "string" ? style["borderStyle"] : "none";
  const widthOf = (longhand: unknown, short: Px): Px => {
    const lv = readPx(longhand);
    return lv > 0 ? lv : short;
  };
  const styleOf = (longhand: unknown): string => {
    const lv = typeof longhand === "string" ? longhand : "none";
    return lv !== "none" ? lv : shStyle;
  };
  const gate = (width: Px, keyword: string): Px => (borderStyleDraws(keyword) ? width : px(0));
  return {
    top: gate(widthOf(style["borderTopWidth"], shWidth.top), styleOf(style["borderTopStyle"])),
    right: gate(widthOf(style["borderRightWidth"], shWidth.right), styleOf(style["borderRightStyle"])),
    bottom: gate(widthOf(style["borderBottomWidth"], shWidth.bottom), styleOf(style["borderBottomStyle"])),
    left: gate(widthOf(style["borderLeftWidth"], shWidth.left), styleOf(style["borderLeftStyle"])),
  };
}

/** The node's `box-sizing` (default `content-box`). */
function readBoxSizing(style: ComputedStyle): "content-box" | "border-box" {
  return style["boxSizing"] === "border-box" ? "border-box" : "content-box";
}

/** The `line-height` multiplier (a unitless `<number>`); absent/invalid ⇒ 1.0. */
function readLineHeight(style: ComputedStyle): number {
  const value = style["lineHeight"];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 1.0;
}

/** A `<length>` spacing field (`letter-spacing`/`word-spacing`), may be negative; absent ⇒ 0. */
function readSpacing(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** The `white-space` keyword (inherited); absent/invalid ⇒ the initial `normal`. */
function readWhiteSpace(style: ComputedStyle): string {
  const value = style["whiteSpace"];
  return typeof value === "string" ? value : "normal";
}

/**
 * Whether a `white-space` keyword allows the run to wrap at the containing
 * width. `normal`/`pre-wrap`/`pre-line`/`break-spaces` wrap; `nowrap`/`pre`
 * keep the run on one line. The initial `normal` wraps, so an undeclared run
 * breaks lines exactly as before.
 */
function whiteSpaceWraps(keyword: string): boolean {
  return keyword !== "nowrap" && keyword !== "pre";
}

/** The `text-align` keyword (inherited); absent/invalid ⇒ the initial `start`. */
function readTextAlign(style: ComputedStyle): string {
  const value = style["textAlign"];
  return typeof value === "string" ? value : "start";
}

/**
 * The horizontal offset of an inline run of width `contentWidth` within a line
 * of width `containingWidth`, for a `text-align` keyword. `start`/`left`/
 * `justify` ⇒ 0; `end`/`right` ⇒ all the slack; `center` ⇒ half. Never negative
 * (a run wider than its line stays at the start edge).
 */
function textAlignOffset(align: string, containingWidth: Px, contentWidth: Px): number {
  const slack = Math.max(0, containingWidth - contentWidth);
  switch (align) {
    case "right":
    case "end":
      return slack;
    case "center":
      return slack / 2;
    default:
      return 0; // start / left / justify
  }
}

/**
 * Clamp a resolved CONTENT length against the node's `min-*`/`max-*` sizing
 * fields (`LengthSizing` = `Px | "auto" | "none"`). The min/max are expressed in
 * the same box as the content length here (we subtract this box's own
 * padding+border from a border-box-relative min/max so they constrain the
 * content consistently with `resolveWidth`/`resolveHeight`). The CSS rule is:
 * apply `max` first (a `<length>`; `none` ⇒ no upper bound), then `min` (a
 * `<length>`; `auto`/absent ⇒ 0), so `min` always wins a conflict. Absent both
 * ⇒ the value is returned unchanged (byte-for-byte Phase-1 behaviour).
 */
function clampSize(
  content: Px,
  minValue: unknown,
  maxValue: unknown,
  inset: number,
  boxSizing: "content-box" | "border-box",
): Px {
  let result = content;
  // `max-*`: a numeric length is an upper bound; "none"/absent imposes none.
  if (typeof maxValue === "number" && Number.isFinite(maxValue)) {
    const maxContent = boxSizing === "border-box" ? maxValue - inset : maxValue;
    result = px(Math.min(result, Math.max(0, maxContent)));
  }
  // `min-*`: a numeric length is a lower bound; "auto"/absent is 0.
  if (typeof minValue === "number" && Number.isFinite(minValue)) {
    const minContent = boxSizing === "border-box" ? minValue - inset : minValue;
    result = px(Math.max(result, Math.max(0, minContent)));
  }
  return result;
}

/**
 * Resolve the content width (design.md §8.2 `resolveWidth`). A declared length
 * wins; `auto` (the initial value) fills the containing block minus horizontal
 * margins, clamped to a non-negative width.
 *
 * `width` is a generated property, so it is typed `unknown` on the IR's open
 * `ComputedStyle`; the cascade emits a `LengthOrAuto` (`Px | "auto"`), which is
 * a `number` or the string `"auto"` at runtime — narrowed here.
 */
function resolveWidth(
  style: ComputedStyle,
  containingWidth: Px,
  margin: Edges<Px>,
  padding: Edges<Px> = ZERO_MARGIN,
  border: Edges<Px> = ZERO_MARGIN,
): Px {
  const insetX = padding.left + padding.right + border.left + border.right;
  const boxSizing = readBoxSizing(style);
  const declared = style["width"];
  let content: number;
  if (typeof declared === "number") {
    // `border-box`: the declared length is the BORDER-box width, so the content
    // width is it minus this box's own padding+border; `content-box` (default):
    // the declared length IS the content width. Zero insets ⇒ identical.
    content = boxSizing === "border-box" ? declared - insetX : declared;
  } else {
    // `auto`: the BORDER box fills the containing block minus horizontal
    // margins, so the content width is that minus this box's own padding+border.
    // Zero insets ⇒ the Phase-1 `containingWidth - margins` behaviour, unchanged.
    content = containingWidth - margin.left - margin.right - insetX;
  }
  // Clamp against min-width/max-width (absent ⇒ unchanged).
  return clampSize(px(Math.max(0, content)), style["minWidth"], style["maxWidth"], insetX, boxSizing);
}

/**
 * Resolve the content height (design.md §8.2 `resolveHeight`). A declared length
 * wins; `auto` (the initial value) is the accumulated child content height.
 * Under `border-box` a declared height is reduced by this box's own vertical
 * padding+border (zero insets ⇒ unchanged).
 */
function resolveHeight(
  style: ComputedStyle,
  contentHeight: Px,
  padding: Edges<Px> = ZERO_MARGIN,
  border: Edges<Px> = ZERO_MARGIN,
): Px {
  const insetY = padding.top + padding.bottom + border.top + border.bottom;
  const boxSizing = readBoxSizing(style);
  const declared = style["height"];
  let content: number;
  if (typeof declared === "number") {
    content = boxSizing === "border-box" ? declared - insetY : declared;
  } else {
    content = contentHeight;
  }
  // Clamp against min-height/max-height (absent ⇒ unchanged).
  return clampSize(px(Math.max(0, content)), style["minHeight"], style["maxHeight"], insetY, boxSizing);
}

// ---------------------------------------------------------------------------
// BoxGeometry construction + positioning.
// ---------------------------------------------------------------------------

/**
 * Build a fragment's {@link BoxGeometry} at the origin (margin-box top-left at
 * `(0, 0)`), nesting the four CSS boxes:
 *
 *     marginBox ⊇ borderBox ⊇ paddingBox ⊇ contentBox
 *
 * `width`/`height` are the CONTENT dimensions; the border box grows by padding
 * then border, and the margin box grows by margin. `getBoundingClientRect`
 * reads `borderBox`, so its size is `content + padding + border`. When padding
 * and border are zero (the overwhelming common case, and every Phase-1 test),
 * all four boxes coincide in size exactly as before — byte-for-byte unchanged.
 *
 * The content origin sits at `(margin.left + border.left + padding.left,
 * margin.top + border.top + padding.top)` from the margin-box origin, so a
 * child laid out at the parent's content origin is inset by the parent's
 * border+padding (the caller offsets children into content space).
 */
function buildBoxAtOrigin(
  margin: Edges<Px>,
  width: Px,
  height: Px,
  padding: Edges<Px> = ZERO_MARGIN,
  border: Edges<Px> = ZERO_MARGIN,
): BoxGeometry {
  const paddingW = width + padding.left + padding.right;
  const paddingH = height + padding.top + padding.bottom;
  const borderW = paddingW + border.left + border.right;
  const borderH = paddingH + border.top + border.bottom;

  // The border box is offset from the margin-box origin by the margins.
  const borderX = margin.left;
  const borderY = margin.top;
  const borderBox: Rect = makeRect(px(borderX), px(borderY), px(borderW), px(borderH));
  const paddingBox: Rect = makeRect(
    px(borderX + border.left),
    px(borderY + border.top),
    px(paddingW),
    px(paddingH),
  );
  const contentBox: Rect = makeRect(
    px(borderX + border.left + padding.left),
    px(borderY + border.top + padding.top),
    width,
    height,
  );
  const marginBox: Rect = makeRect(
    px(0),
    px(0),
    px(margin.left + borderW + margin.right),
    px(margin.top + borderH + margin.bottom),
  );
  return {
    x: borderBox.x,
    y: borderBox.y,
    width,
    height,
    contentBox,
    paddingBox,
    borderBox,
    marginBox,
  };
}

/** Return a copy of `frag` with its own box translated by `(dx, dy)`. Descendant
 * fragments are relative to `frag`, so they are intentionally left untouched. */
function offsetFragment(frag: Fragment, dx: number, dy: number): Fragment {
  const b = frag.box;
  return {
    node: frag.node,
    box: {
      x: px(b.x + dx),
      y: px(b.y + dy),
      width: b.width,
      height: b.height,
      contentBox: shiftRect(b.contentBox, dx, dy),
      paddingBox: shiftRect(b.paddingBox, dx, dy),
      borderBox: shiftRect(b.borderBox, dx, dy),
      marginBox: shiftRect(b.marginBox, dx, dy),
    },
    children: frag.children,
    // The shaped glyph run (if any) is relative to the fragment's content-box
    // origin, which moves WITH the fragment, so the glyphs need no shifting —
    // carry the run through unchanged.
    ...(frag.text === undefined ? {} : { text: frag.text }),
  };
}

/** Translate a rectangle by `(dx, dy)`, preserving its size. */
function shiftRect(rect: Rect, dx: number, dy: number): Rect {
  return makeRect(px(rect.x + dx), px(rect.y + dy), rect.width, rect.height);
}

/**
 * Quirks-mode full-canvas root (task 9.4; Requirement 17.4): return a copy of
 * the root fragment whose box height is grown to at least `viewportHeight`
 * (its width/position and all descendants unchanged). When the root is already
 * at least that tall this is an exact copy, so a tall document is unaffected.
 * Only the box's own height-bearing rects (border/padding/content/margin) grow;
 * children keep their geometry (the canvas grows beneath them).
 */
function stretchRootToViewport(root: Fragment, viewportHeight: Px): Fragment {
  if (root.box.height >= viewportHeight) {
    return root;
  }
  const b = root.box;
  const grow = (rect: Rect): Rect => makeRect(rect.x, rect.y, rect.width, viewportHeight);
  return {
    node: root.node,
    box: {
      x: b.x,
      y: b.y,
      width: b.width,
      height: viewportHeight,
      contentBox: grow(b.contentBox),
      paddingBox: grow(b.paddingBox),
      borderBox: grow(b.borderBox),
      marginBox: grow(b.marginBox),
    },
    children: root.children,
  };
}

/** Construct a {@link Rect}. */
function makeRect(x: Px, y: Px, width: Px, height: Px): Rect {
  return { x, y, width, height };
}

// ---------------------------------------------------------------------------
// Phase 5-7 layout-property readers (task 7.1; Requirement 16.1).
//
// The cascade `generator` does NOT yet emit these properties into the
// ComputedStyle property table (it emits only color / display / width / height
// / margin / background-color / font-size — see the module doc), so they are
// read DEFENSIVELY off ComputedStyle's open `[k: string]: unknown` index
// signature, exactly as task 5.8 reads the `border` descriptor. Each reader
// narrows `unknown` to the expected shape only when present and well-formed,
// and otherwise returns the property's initial/fallback value — so a plain
// real-cascade document (which carries none of these) takes the unchanged
// block/inline path. Wiring these as real generated CSS properties is a PENDING
// generator property-table extension; once it lands, these readers consume the
// typed fields with no change to the layout BRANCHES or the IR boundary.
// ---------------------------------------------------------------------------

/**
 * The `display` keyword as a raw string (initial `"inline"`). Read off the
 * index signature rather than the typed `display` field so the `"table"`
 * keyword — which the `DisplayValue` union does not yet include because the
 * generator does not emit it — can still be matched by the layout dispatch.
 */
function readDisplay(style: ComputedStyle): string {
  const value = style["display"];
  return typeof value === "string" ? value : "inline";
}

/** The recognised `float` keywords; anything else (incl. absent) ⇒ `"none"`. */
const FLOAT_VALUES: ReadonlySet<string> = new Set(["left", "right", "none"]);

/**
 * The computed `float` (initial `"none"`). Narrowed from the open index
 * signature; an absent or unrecognised value is the initial `"none"`, so a
 * non-floated element takes the normal-flow path unchanged.
 */
function readFloat(style: ComputedStyle): "left" | "right" | "none" {
  const value = style["float"];
  if (typeof value === "string" && FLOAT_VALUES.has(value)) {
    return value as "left" | "right" | "none";
  }
  return "none";
}

/** The recognised `position` keywords; anything else (incl. absent) ⇒ `"static"`. */
const POSITION_VALUES: ReadonlySet<string> = new Set([
  "static",
  "relative",
  "absolute",
  "fixed",
  "sticky",
]);

/**
 * The computed `position` (initial `"static"`). Narrowed from the open index
 * signature; an absent or unrecognised value is the initial `"static"`, so a
 * statically positioned element takes the normal-flow path unchanged. (Only
 * `relative` / `absolute` are acted on by the block branch today; `fixed` /
 * `sticky` fall back to static flow.)
 */
function readPosition(style: ComputedStyle): "static" | "relative" | "absolute" {
  const value = style["position"];
  if (value === "relative") return "relative";
  if (value === "absolute") return "absolute";
  if (typeof value === "string" && POSITION_VALUES.has(value)) return "static";
  return "static";
}

/**
 * The positioning insets (`top` / `left`) as offsets, in px, from the
 * containing block's content origin. Read defensively: a numeric `top`/`left`
 * is used; `bottom`/`right` are mapped to negative top/left offsets only when
 * the corresponding `top`/`left` is absent (a minimal but real inset
 * resolution); anything else contributes 0. Returns plain numbers so callers
 * can pass them straight to `offsetFragment`.
 */
function readInsets(style: ComputedStyle | null): { readonly top: number; readonly left: number } {
  if (style === null) {
    return { top: 0, left: 0 };
  }
  const top = readLengthOr(style["top"]);
  const left = readLengthOr(style["left"]);
  const bottom = readLengthOr(style["bottom"]);
  const right = readLengthOr(style["right"]);
  return {
    top: top !== null ? top : bottom !== null ? -bottom : 0,
    left: left !== null ? left : right !== null ? -right : 0,
  };
}

/** Narrow an `unknown` ComputedStyle field to a finite number, else `null`. */
function readLengthOr(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The flex container's `flex-direction` (initial `"row"`). Narrowed from the
 * open index signature; only `"column"` switches the main axis, everything else
 * (incl. absent / `"row"` / unknown) is the initial `"row"`.
 */
function readFlexDirection(style: ComputedStyle): "row" | "column" {
  return style["flexDirection"] === "column" ? "column" : "row";
}

/**
 * The grid's column-track count from `grid-template-columns` (default 1).
 * Modelled minimally: a positive integer is the track count; an array value is
 * its length (one track per entry); anything else is a single column. Clamped
 * to ≥ 1 so the cell width is always finite.
 */
function readGridColumns(style: ComputedStyle): number {
  const value = style["gridTemplateColumns"];
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (Array.isArray(value) && value.length > 0) {
    return value.length;
  }
  return 1;
}

/** Whether the element establishes a multi-column container (Multi-column). */
function establishesMulticol(style: ComputedStyle): boolean {
  const count = style["columnCount"];
  const width = style["columnWidth"];
  return (
    (typeof count === "number" && Number.isInteger(count) && count > 1) ||
    (typeof width === "number" && Number.isFinite(width) && width > 0)
  );
}

/** The `column-gap` in px (initial 0). */
function readColumnGap(style: ComputedStyle): number {
  const gap = style["columnGap"];
  return typeof gap === "number" && Number.isFinite(gap) && gap > 0 ? gap : 0;
}

/**
 * Resolve the realised column count: an explicit `column-count` wins; otherwise
 * `column-width` fits as many whole columns as the content width allows
 * (accounting for the gaps), at least one. Clamped to ≥ 1.
 */
function resolveColumnCount(style: ComputedStyle, contentWidth: number, gap: number): number {
  const count = style["columnCount"];
  if (typeof count === "number" && Number.isInteger(count) && count > 0) {
    return Math.max(1, count);
  }
  const width = style["columnWidth"];
  if (typeof width === "number" && Number.isFinite(width) && width > 0) {
    return Math.max(1, Math.floor((contentWidth + gap) / (width + gap)));
  }
  return 1;
}

/**
 * The element's declared content `width` in px, or `null` when it is `auto` /
 * absent (a flexible main size). The cascade emits a `LengthOrAuto`
 * (`Px | "auto"`), narrowed here off the open index signature.
 */
function declaredWidthOf(style: ComputedStyle): number | null {
  const declared = style["width"];
  return typeof declared === "number" ? Math.max(0, declared) : null;
}
