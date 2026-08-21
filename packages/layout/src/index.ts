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
export { hitTest } from "./hit-test.js";

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
  readonly clipMaxY?: number;
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

  function resolveIntrinsicSize(node: DomNode): { width: number; height: number } | undefined {
    const attrs = node.attrs;
    if (attrs !== undefined) {
      const aw = Number(attrs.get("width"));
      const ah = Number(attrs.get("height"));
      if (Number.isFinite(aw) && Number.isFinite(ah) && aw > 0 && ah > 0) {
        return { width: aw, height: ah };
      }
      const src = attrs.get("src") ?? attrs.get("data-src") ?? "";
      const m = /@(\d+)w_(\d+)h/i.exec(src);
      if (m !== null) {
        const width = Number(m[1]);
        const height = Number(m[2]);
        if (width > 0 && height > 0) return { width, height };
      }
      if (node.tag === "svg") {
        const vb = attrs.get("viewBox") ?? attrs.get("viewbox");
        if (vb !== undefined) {
          const parts = vb.trim().split(/[\s,]+/).map(Number);
          if (parts.length >= 4) {
            const width = parts[2]!;
            const height = parts[3]!;
            if (width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height)) {
              return { width, height };
            }
          }
        }
        return { width: 20, height: 20 };
      }
    } else if (node.tag === "svg") {
      return { width: 20, height: 20 };
    }
    return undefined;
  }

  function layoutReplaced(node: DomNode, containingWidth: Px): Fragment {
    const style = computedStyleOf(node.id);
    const margin = resolveMargin(style);
    const padding = resolvePadding(style, containingWidth);
    const border = resolveBorder(style);
    const intrinsic = resolveIntrinsicSize(node);
    const ratio =
      intrinsic !== undefined && intrinsic.width > 0
        ? intrinsic.height / intrinsic.width
        : 9 / 16;
    const declaredW = typeof style["width"] === "number" ? (style["width"]) : null;
    const declaredH = typeof style["height"] === "number" ? (style["height"]) : null;
    let contentW: number;
    let contentH: number;
    if (declaredW !== null) {
      contentW = Math.max(0, declaredW);
      contentH = declaredH !== null ? Math.max(0, declaredH) : contentW * ratio;
    } else if (declaredH !== null) {
      contentH = Math.max(0, declaredH);
      contentW = ratio > 0 ? contentH / ratio : 0;
    } else if (node.tag === "svg") {
      const iw = intrinsic?.width ?? 18;
      const ih = intrinsic?.height ?? 18;
      const maxSide = 20;
      if (iw <= maxSide && ih <= maxSide) {
        contentW = Math.max(1, iw);
        contentH = Math.max(1, ih);
      } else if (iw >= ih) {
        contentW = maxSide;
        contentH = Math.max(1, maxSide * (ih / Math.max(1, iw)));
      } else {
        contentH = maxSide;
        contentW = Math.max(1, maxSide * (iw / Math.max(1, ih)));
      }
    } else if (intrinsic !== undefined) {
      contentW = Math.min(Number(containingWidth), intrinsic.width);
      contentH = contentW * ratio;
    } else {
      contentW = Math.max(0, Number(resolveWidth(style, containingWidth, margin, padding, border)));
      contentH = contentW * ratio;
    }
    const box = buildBoxAtOrigin(margin, px(contentW), px(contentH), padding, border);
    return { node: node.id, box, children: [] };
  }

  function layoutNode(id: NodeId, containingWidth: Px, containingHeight?: number, forceContentHeight?: number): Fragment | null {
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
      if (node.tag === "img" || node.tag === "svg") {
        return layoutReplaced(node, containingWidth);
      }
      if (display === "flex") {
        return layoutFlex(node, containingWidth, containingHeight, forceContentHeight);
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
    return layoutBlock(node, containingWidth, containingHeight, forceContentHeight, undefined);
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
  function layoutBlock(node: DomNode, containingWidth: Px, containingHeight?: number, forceContentHeight?: number, maxHeight?: number): Fragment {
    const style = computedStyleOf(node.id);
    const margin = resolveMargin(style);
    const padding = resolvePadding(style, containingWidth);
    const border = resolveBorder(style);
    const contentWidth = resolveWidth(style, containingWidth, margin, padding, border);

    // Children register in this box's LOCAL frame — the fragment is still at the
    // origin here and only the box itself is offset by the grandparent later — so
    // the content origin runs from the MARGIN-box origin: +margin → border box,
    // +border+padding → content box. Zero margins ⇒ the historical values.
    const contentLeft = margin.left + border.left + padding.left;
    const contentTop = margin.top + border.top + padding.top;

    // The DEFINITE content height this block offers its percentage-height children.
    // Only when this block's own `height` is a definite length (not auto/% of an
    // indefinite ancestor) does a child `height: <percent>` resolve; otherwise the
    // CSS rule makes it behave as `auto` and `definiteChildHeight` stays undefined.
    const declaredHeight = style["height"];
    const definiteChildHeight =
      forceContentHeight !== undefined
        ? Math.max(0, forceContentHeight)
        : typeof declaredHeight === "number"
          ? Math.max(0, readBoxSizing(style) === "border-box" ? declaredHeight - (padding.top + padding.bottom + border.top + border.bottom) : declaredHeight)
          : containingHeight;

    let cursorY = 0;
    let prevBottomMargin: number | null = null;
    type AbsPending = { childNodeId: NodeId; childStyle: ComputedStyle | null };
    type ChildSlot = { kind: "frag"; id: FragmentId } | { kind: "abs"; abs: AbsPending };
    const childSlots: ChildSlot[] = [];
    const activeFloats: { side: "left" | "right"; width: number; bottom: number }[] = [];

    function intrusionAt(y: number): { left: number; right: number } {
      let left = 0;
      let right = 0;
      for (const f of activeFloats) {
        if (f.bottom > y) {
          if (f.side === "left") left = Math.max(left, f.width);
          else right = Math.max(right, f.width);
        }
      }
      return { left, right };
    }

    for (let ci = 0; ci < node.children.length; ci += 1) {
      const childNodeId = node.children[ci]!;
      const childNode = dom.nodes.get(childNodeId);
      if (childNode === undefined || childNode.kind === "comment") {
        continue;
      }
      const childStyle = childStyleOf(childNodeId);

      // ---- inline formatting context -------------------------------------
      // A run of CONSECUTIVE inline-level children (text nodes + display:inline
      // / inline-block elements) flows left-to-right in line boxes instead of
      // each taking its own vertical row. Block-level members, positioned and
      // floated boxes break the run.
      if (isInlineLevelChild(childNode, childStyle)) {
        const runIds: NodeId[] = [];
        while (ci < node.children.length) {
          const mId = node.children[ci]!;
          const mNode = dom.nodes.get(mId);
          if (mNode === undefined || mNode.kind === "comment") {
            ci += 1;
            continue;
          }
          const mStyle = childStyleOf(mId);
          if (!isInlineLevelChild(mNode, mStyle)) {
            break;
          }
          runIds.push(mId);
          ci += 1;
        }
        ci -= 1; // the for-loop's ++ re-advances past the last run member.
        const runFragments = layoutInlineRun(runIds, px(contentWidth), style);
        let runHeight = 0;
        for (const frag of runFragments) {
          childSlots.push({
            kind: "frag",
            id: register(offsetFragment(frag, contentLeft, contentTop + cursorY)),
          });
          runHeight = Math.max(runHeight, Number(frag.box.marginBox.height));
        }
        cursorY += runHeight;
        prevBottomMargin = null; // an inline run never participates in margin collapse.
        continue;
      }

      const float = childStyle === null ? "none" : readFloat(childStyle);
      const rawPosition = childStyle === null ? "static" : readPosition(childStyle);
      const position =
        rawPosition === "fixed"
          ? "absolute"
          : childStyle !== null && childStyle["position"] === "sticky"
            ? "relative"
            : rawPosition;

      if (position === "absolute") {
        childSlots.push({ kind: "abs", abs: { childNodeId, childStyle } });
        continue;
      }

      if (float === "left" || float === "right") {
        const childFrag = layoutNode(childNodeId, contentWidth);
        if (childFrag === null) {
          continue;
        }
        const fw = childFrag.box.marginBox.width;
        const fh = childFrag.box.marginBox.height;
        const dx =
          float === "left" ? 0 : Math.max(0, contentWidth - fw);
        childSlots.push({
          kind: "frag",
          id: register(offsetFragment(childFrag, contentLeft + dx, contentTop + cursorY)),
        });
        activeFloats.push({ side: float, width: fw, bottom: cursorY + fh });
        continue;
      }

      // `clear`: advance the cursor below the relevant floats before placing
      // this in-flow child. `clear: left` clears left floats, `right` clears
      // right floats, `both`/`inline-start`/`inline-end` clear all (we treat the
      // logical values as `both` since direction-aware clearing is not wired).
      const clear = childStyle === null ? "none" : readClear(childStyle);
      if (clear !== "none") {
        let clearBottom = 0;
        for (const f of activeFloats) {
          const matches =
            clear === "both" ||
            clear === "inline-start" ||
            clear === "inline-end" ||
            f.side === clear;
          if (matches) {
            clearBottom = Math.max(clearBottom, f.bottom);
          }
        }
        if (clearBottom > cursorY) {
          cursorY = clearBottom;
          prevBottomMargin = null; // clearing establishes a new BFC edge for margins.
        }
      }

      const room = intrusionAt(cursorY);
      const availWidth = px(Math.max(0, contentWidth - room.left - room.right));
      const childFrag = layoutNode(childNodeId, availWidth, definiteChildHeight);
      if (childFrag === null) {
        continue;
      }

      const childMargin = childStyle === null ? ZERO_MARGIN : resolveMargin(childStyle);
      if (prevBottomMargin !== null) {
        const overlap =
          prevBottomMargin + childMargin.top - collapsedMargin(prevBottomMargin, childMargin.top);
        cursorY -= overlap;
      }

      const room2 = intrusionAt(cursorY);
      const xShift = room2.left;
      let positioned = offsetFragment(childFrag, contentLeft + xShift, contentTop + cursorY);
      const advance = positioned.box.marginBox.height;
      if (position === "relative") {
        const insets = readInsets(childStyle);
        positioned = offsetFragment(positioned, insets.left, insets.top);
      }
      childSlots.push({ kind: "frag", id: register(positioned) });
      cursorY += advance;
      prevBottomMargin = childMargin.bottom;
    }

    const hasAbsoluteSlots = childSlots.some((slot) => slot.kind === "abs");
    if (hasAbsoluteSlots) {
      const inFlowContentHeight = Number(resolveHeight(style, px(cursorY), padding, border, containingHeight));
      const padCbW = contentWidth + padding.left + padding.right;
      const padCbH = inFlowContentHeight + padding.top + padding.bottom;
      const padEdgeLeft = border.left;
      const padEdgeTop = border.top;
      for (let si = 0; si < childSlots.length; si += 1) {
        const slot = childSlots[si]!;
        if (slot.kind !== "abs") continue;
        const item = slot.abs;
        const absId = item.childNodeId;
        const absStyle = item.childStyle;
        const declaredTop = absStyle === null ? null : readLengthOr(absStyle["top"]);
        const declaredLeft = absStyle === null ? null : readLengthOr(absStyle["left"]);
        const declaredBottom = absStyle === null ? null : readLengthOr(absStyle["bottom"]);
        const declaredRight = absStyle === null ? null : readLengthOr(absStyle["right"]);
        let usedW = padCbW;
        let forceH: number | undefined;
        let topOffset: number;
        let leftOffset: number;
        if (declaredLeft !== null && declaredRight !== null) {
          usedW = Math.max(0, padCbW - declaredLeft - declaredRight);
          leftOffset = padEdgeLeft + declaredLeft;
        } else if (declaredLeft !== null) {
          leftOffset = padEdgeLeft + declaredLeft;
        } else if (declaredRight !== null) {
          leftOffset = padEdgeLeft;
        } else {
          leftOffset = contentLeft;
        }
        if (declaredTop !== null && declaredBottom !== null) {
          forceH = Math.max(0, padCbH - declaredTop - declaredBottom);
          topOffset = padEdgeTop + declaredTop;
        } else if (declaredTop !== null) {
          topOffset = padEdgeTop + declaredTop;
        } else if (declaredBottom !== null) {
          topOffset = padEdgeTop;
        } else {
          topOffset = contentTop + cursorY;
        }
        const childFrag = layoutNode(absId, px(usedW), forceH, forceH);
        if (childFrag === null) {
          childSlots[si] = { kind: "frag", id: register({ node: absId, box: buildBoxAtOrigin(ZERO_MARGIN, px(0), px(0)), children: [] }) };
          continue;
        }
        if (declaredLeft === null && declaredRight !== null) {
          leftOffset = padEdgeLeft + Math.max(0, padCbW - declaredRight - Number(childFrag.box.marginBox.width));
        }
        if (declaredTop === null && declaredBottom !== null && forceH === undefined) {
          topOffset = padEdgeTop + Math.max(0, padCbH - declaredBottom - Number(childFrag.box.marginBox.height));
        }
        let placed = offsetFragment(childFrag, leftOffset, topOffset);
        if (forceH !== undefined && Number(placed.box.marginBox.height) < forceH - 0.5) {
          const grow = forceH - Number(placed.box.marginBox.height);
          placed = stretchFragmentHeight(placed, grow);
        }
        childSlots[si] = { kind: "frag", id: register(placed) };
      }
    }

    const childIds: FragmentId[] = [];
    for (const slot of childSlots) {
      if (slot.kind === "frag") {
        childIds.push(slot.id);
      }
    }

    let contentHeight =
      forceContentHeight !== undefined
        ? px(Math.max(0, forceContentHeight))
        : resolveHeight(style, px(cursorY), padding, border, containingHeight);
    if (maxHeight !== undefined) {
      const maxH = Math.max(0, maxHeight);
      if (Number(contentHeight) > maxH) {
        contentHeight = px(maxH);
      }
    }
    const box = buildBoxAtOrigin(margin, contentWidth, contentHeight, padding, border);
    return { node: node.id, box, children: childIds };
  }

  /**
   * The INLINE FORMATTING CONTEXT (task: line boxes). Lays a run of consecutive
   * inline-level children (text nodes + display:inline / inline-block elements)
   * into LINE BOXES flowing left-to-right, wrapping greedily at the containing
   * width. Each member becomes its own fragment (a shaped single-line text run
   * for text members, a laid-out box for atomic members), positioned at its
   * (x, y) inside the run; the caller offsets them into the block's content
   * origin. Line height per line = max of that line's members; text-align
   * distributes each line's slack across ALL its members (row-level, unlike the
   * single-run alignment in {@link layoutInline}).
   *
   * A run with a single text member is behaviorally identical to `layoutInline`
   * (one line, or word-wrapped lines), so the existing per-text-node path is
   * byte-for-byte unchanged.
   */
  function layoutInlineRun(
    runIds: readonly NodeId[],
    containingWidth: Px,
    containerStyle: ComputedStyle,
  ): Fragment[] {
    if (runIds.length === 0) {
      return [];
    }

    // A member is either a TEXT run (shaped word by word) or an ATOMIC box
    // (inline-block / inline element laid out via layoutNode, an indivisible
    // unit that flows within the line).
    interface TextMember {
      readonly kind: "text";
      readonly nodeId: NodeId;
      readonly words: readonly string[];
      readonly font: ShapingFont;
      readonly letterSpacing: number;
      readonly spaceAdvance: number; // one inter-word space (incl. word-spacing).
      readonly wordWidths: readonly number[];
      readonly lineHeight: number; // px of one line box for this member's font.
      readonly wraps: boolean;
      readonly canBreakWord: boolean;
      readonly perCharWidths?: readonly number[];
    }
    interface AtomicMember {
      readonly kind: "atomic";
      readonly nodeId: NodeId;
      readonly frag: Fragment; // laid out box (width is definite).
    }
    interface EmptyMember {
      readonly kind: "empty";
      readonly nodeId: NodeId; // whitespace-only text: contributes a zero box.
    }
    type Member = TextMember | AtomicMember | EmptyMember;

    // ---- prepare members ---------------------------------------------------
    const members: Member[] = [];
    let runWraps = true; // default; tightened by the first text member's white-space.
    let runWrapsSeen = false;
    for (const memberId of runIds) {
      const node = dom.nodes.get(memberId);
      if (node === undefined || node.kind === "comment") {
        continue;
      }
      if (node.kind === "text") {
        const content = node.text ?? "";
        const style = computedStyleOf(node.id);
        const fontSize = style.fontSize;
        const font: ShapingFont = { fontSize };
        const letterSpacing = readSpacing(style["letterSpacing"]);
        const wordSpacing = readSpacing(style["wordSpacing"]);
        const spaceAdvance = shaper.shapeLine(" ", font).advance + wordSpacing;
        const wraps = whiteSpaceWraps(readWhiteSpace(style));
        if (!runWrapsSeen) {
          runWraps = wraps;
          runWrapsSeen = true;
        } else {
          runWraps = runWraps && wraps; // any nowrap member tightens the run.
        }
        const wordBreak = typeof style["wordBreak"] === "string" ? style["wordBreak"] : "normal";
        const overflowWrap = typeof style["overflowWrap"] === "string" ? style["overflowWrap"] : "normal";
        const breakAll = wordBreak === "break-all";
        const breakAnywhere = overflowWrap === "anywhere" || wordBreak === "break-all";
        const canBreakWord = overflowWrap === "break-word" || overflowWrap === "anywhere";
        // Whitespace collapses to break opportunities; empty text yields no words.
        const rawWords = content.split(/\s+/).filter((word) => word.length > 0);
        const words: string[] = [];
        if (breakAll || breakAnywhere) {
          for (const word of rawWords) {
            for (const ch of word) words.push(ch);
          }
        } else {
          words.push(...rawWords);
        }
        if (words.length === 0) {
          // Whitespace-only text member: contributes a zero box (no line), like
          // the empty-text behaviour of `layoutInline`.
          members.push({ kind: "empty", nodeId: memberId });
          continue;
        }
        const wordWidths = words.map(
          (word) => shaper.shapeLine(word, font).advance + letterSpacing * word.length,
        );
        members.push({
          kind: "text",
          nodeId: memberId,
          words,
          font,
          letterSpacing,
          spaceAdvance,
          wordWidths,
          lineHeight: readLineHeight(style) * fontSize,
          wraps,
          canBreakWord,
        });
      } else {
        // inline / inline-block element: an atomic box. The box SHRINK-WRAPS:
        // an auto width would otherwise fill the containing width (block
        // behaviour) and blow the line. A box whose content is a single text
        // node (the common `<span>text</span>` case) is measured directly and
        // laid out once against that width — a two-pass probe would orphan the
        // first pass's registered fragments. Everything else (declared width,
        // images, nested boxes) lays out once as-is; a declared width is already
        // respected by resolveWidth, and block-content atoms keep the fill width.
        const node = dom.nodes.get(memberId);
        const textChild =
          node !== undefined && node.kind === "element" && node.children.length === 1
            ? dom.nodes.get(node.children[0]!)
            : undefined;
        if (textChild !== undefined && textChild.kind === "text") {
          const st = computedStyleOf(memberId);
          const fontSize = st.fontSize;
          const font: ShapingFont = { fontSize };
          const words = (textChild.text ?? "").split(/\s+/).filter((word) => word.length > 0);
          const letterSpacing = readSpacing(st["letterSpacing"]);
          const space = shaper.shapeLine(" ", font).advance;
          let w = 0;
          let first = true;
          for (const word of words) {
            if (!first) w += space;
            w += shaper.shapeLine(word, font).advance + letterSpacing * word.length;
            first = false;
          }
          const frag = layoutNode(memberId, px(Math.max(1, w)));
          if (frag === null) {
            continue;
          }
          members.push({ kind: "atomic", nodeId: memberId, frag });
        } else {
          const frag = layoutNode(memberId, containingWidth);
          if (frag === null) {
            continue;
          }
          members.push({ kind: "atomic", nodeId: memberId, frag });
        }
      }
    }
    if (members.length === 0) {
      return [];
    }

    // ---- single-member fast paths (zero-regression) --------------------------
    // A run of ONE text member lays out exactly as `layoutInline` does: all lines
    // share one fragment whose height = lines × line-height (the historical
    // behaviour). A run of ONLY empty members yields their zero boxes.
    const textMembers = members.filter((m): m is TextMember => m.kind === "text");
    if (members.length === 1 && textMembers.length === 1 && members[0]!.kind === "text") {
      const node = dom.nodes.get(members[0]!.nodeId);
      if (node !== undefined && node.kind === "text") {
        return [layoutInline(node, containingWidth, containerStyle)];
      }
    }
    if (members.every((m) => m.kind === "empty")) {
      return members.map((m) => {
        const box = buildBoxAtOrigin(ZERO_MARGIN, px(0), px(0));
        return { node: (m).nodeId, box, children: [] };
      });
    }

    // ---- greedy line boxing ------------------------------------------------
    // Each placed item knows its line index and in-line x so the line-level
    // text-align pass can shift whole lines uniformly.
    interface Placed {
      readonly member: Member;
      readonly x: number; // in-line x BEFORE the align shift.
      readonly line: number;
      readonly glyphs?: LaidGlyph[]; // for text members (built during placement).
    }
    const placed: Placed[] = [];
    const lineWidths: number[] = [0];
    const lineHeights: number[] = [0];
    let lineIndex = 0;
    let penX = 0;
    let lineHasAny = false;

    const placeWord = (member: TextMember, word: string, startX: number, glyphY: number): LaidGlyph[] => {
      const glyphs: LaidGlyph[] = [];
      let x = startX;
      for (const ch of word) {
        const advance = shaper.shapeLine(ch, member.font).advance + member.letterSpacing;
        glyphs.push({
          glyphId: ch.codePointAt(0) ?? 0,
          x: px(x),
          y: px(glyphY),
          advance: px(advance),
        });
        x += advance;
      }
      return glyphs;
    };
    const closeLine = (): void => {
      lineWidths.push(0);
      lineHeights.push(0);
      lineIndex += 1;
      penX = 0;
    };
    const startNewLineIfNeeded = (nextWidth: number): boolean => {
      // Wrap when the next unit would overflow AND the line already has content.
      if (runWraps && lineHasAny && penX + nextWidth > Number(containingWidth)) {
        closeLine();
        return true;
      }
      return false;
    };

    for (const member of members) {
      if (member.kind === "text") {
        // A text member contributes ONE placed item per line it occupies; the
        // item's glyphs are the line's words (positions relative to the text
        // fragment's content-box origin, so y is always 0 for the run's single
        // line — the fragment itself is offset to the line's y later).
        let lineGlyphs: LaidGlyph[] = [];
        let lineStartX = 0;
        let lineHasGlyphs = false;
        const flushLine = (): void => {
          if (!lineHasGlyphs) {
            return;
          }
          placed.push({ member, x: lineStartX, line: lineIndex, glyphs: lineGlyphs });
          lineGlyphs = [];
          lineHasGlyphs = false;
        };
        for (let wi = 0; wi < member.words.length; wi += 1) {
          const word = member.words[wi]!;
          const w = member.wordWidths[wi]!;
          const gap = penX > 0 ? member.spaceAdvance : 0;
          const fits = !(runWraps && lineHasAny && penX + gap + w > Number(containingWidth));
          if (!fits) {
            flushLine();
            closeLine();
          }
          // A line-leading word that STILL overflows (overflow-wrap: break-word
          // / anywhere) is broken mid-word across lines.
          if (
            runWraps &&
            w > Number(containingWidth) &&
            member.canBreakWord &&
            word.length > 1
          ) {
            let x = 0;
            for (const ch of word) {
              const cw = shaper.shapeLine(ch, member.font).advance + member.letterSpacing;
              if (lineHasGlyphs && x + cw > Number(containingWidth)) {
                flushLine();
                closeLine();
                x = 0;
              }
              const gl = placeWord(member, ch, x, 0);
              lineGlyphs = lineGlyphs.concat(gl);
              lineWidths[lineIndex] = Math.max(lineWidths[lineIndex]!, x + cw);
              lineHeights[lineIndex] = Math.max(lineHeights[lineIndex]!, member.lineHeight);
              if (!lineHasGlyphs) {
                lineStartX = 0;
                lineHasGlyphs = true;
              }
              penX = x + cw;
              lineHasAny = true;
              x += cw;
            }
            continue;
          }
          const startX = penX + gap;
          const gl = placeWord(member, word, startX, 0);
          lineGlyphs = lineGlyphs.concat(gl);
          lineWidths[lineIndex] = Math.max(lineWidths[lineIndex]!, startX + w);
          lineHeights[lineIndex] = Math.max(lineHeights[lineIndex]!, member.lineHeight);
          if (!lineHasGlyphs) {
            lineStartX = startX;
            lineHasGlyphs = true;
          }
          penX = startX + w;
          lineHasAny = true;
        }
        flushLine();
      } else if (member.kind === "atomic") {
        // Atomic box: an indivisible unit.
        const w = Number(member.frag.box.marginBox.width);
        startNewLineIfNeeded(w);
        const x = penX;
        placed.push({ member, x, line: lineIndex });
        lineWidths[lineIndex] = Math.max(lineWidths[lineIndex]!, x + w);
        lineHeights[lineIndex] = Math.max(lineHeights[lineIndex]!, Number(member.frag.box.marginBox.height));
        penX = x + w;
        lineHasAny = true;
      }
      // "empty" members produce no line and no placed item; their zero boxes are
      // emitted at the end.
    }

    // ---- line-level text-align ---------------------------------------------
    const align = readTextAlign(computedStyleOf(runIds[0]!));
    const alignDeltaFor = (line: number): number => {
      if (align === "right" || align === "end") {
        return Math.max(0, Number(containingWidth) - lineWidths[line]!);
      }
      if (align === "center") {
        return Math.max(0, Number(containingWidth) - lineWidths[line]!) / 2;
      }
      return 0; // start / left / justify (justify has no inter-word stretch here).
    };

    // Cumulative line Y: each line sits below the max height of the lines above.
    const lineY: number[] = [];
    let yAcc = 0;
    for (let li = 0; li < lineWidths.length; li += 1) {
      lineY.push(yAcc);
      yAcc += lineHeights[li]!;
    }

    // ---- emit fragments -----------------------------------------------------
    const out: Fragment[] = [];
    // Whitespace-only members produce their zero boxes at their document order.
    const emptyIds = members.filter((m): m is EmptyMember => m.kind === "empty").map((m) => m.nodeId);
    for (const emptyId of emptyIds) {
      const box = buildBoxAtOrigin(ZERO_MARGIN, px(0), px(0));
      out.push({ node: emptyId, box, children: [] });
    }
    // Group each text member's placed items by node so a member spanning several
    // lines emits ONE fragment (like `layoutInline`): the invariant is one
    // fragment per laid-out node (Req 3.4 / gBCR single-source), so multi-line
    // text cannot emit one fragment per line.
    const textGroups = new Map<NodeId, Placed[]>();
    for (const item of placed) {
      if (item.member.kind === "text") {
        const group = textGroups.get(item.member.nodeId) ?? [];
        group.push(item);
        textGroups.set(item.member.nodeId, group);
      }
    }
    const emittedText = new Set<NodeId>();
    for (const item of placed) {
      const lineYTop = lineY[item.line]!;
      if (item.member.kind === "text") {
        if (emittedText.has(item.member.nodeId)) {
          continue; // already emitted as part of this member's merged fragment.
        }
        emittedText.add(item.member.nodeId);
        const group = textGroups.get(item.member.nodeId)!;
        const first = group[0]!;
        const firstLineY = lineY[first.line]!;
        const lastLine = group[group.length - 1]!.line;
        // Box: starts at the first item's in-line x (plus its line's align
        // shift); spans from the first line's top to the last line's bottom.
        const boxX = first.x + alignDeltaFor(first.line);
        const boxY = firstLineY;
        // Glyphs are relative to the box origin: each glyph's x is shifted back
        // by the first item's x (plus any per-line align delta difference), and
        // its y is shifted up to the first line's top.
        const glyphs: LaidGlyph[] = [];
        let maxRight = 0;
        for (const gItem of group) {
          const dY = lineY[gItem.line]! - firstLineY;
          const dX = alignDeltaFor(gItem.line) - alignDeltaFor(first.line);
          for (const g of gItem.glyphs ?? []) {
            glyphs.push({ ...g, x: px(Number(g.x) - first.x + dX), y: px(Number(g.y) + dY) });
          }
          maxRight = Math.max(maxRight, lineWidths[gItem.line]!);
        }
        const width = px(Math.max(0, maxRight - first.x));
        const height = px(lineY[lastLine]! + lineHeights[lastLine]! - firstLineY);
        const box = buildBoxAtOrigin(ZERO_MARGIN, width, height);
        const firstText = first.member as TextMember;
        const textRun: TextRun = { fontSize: firstText.font.fontSize, glyphs };
        const base: Fragment = { node: firstText.nodeId, box, children: [], text: textRun };
        out.push(boxX > 0 || boxY > 0 ? offsetFragment(base, boxX, boxY) : base);
      } else if (item.member.kind === "atomic") {
        const dx = item.x + alignDeltaFor(item.line);
        out.push(offsetFragment(item.member.frag, dx, lineYTop));
      }
      // "empty" members never reach `placed` (no line, no geometry).
    }
    return out;
  }

  function layoutInline(node: DomNode, containingWidth: Px, containerStyle?: ComputedStyle): Fragment {
    const style = computedStyleOf(node.id);
    const fontSize = style.fontSize;
    const content = node.text ?? "";
    const font: ShapingFont = { fontSize };

    // Whitespace collapses to break opportunities; words are the unbreakable
    // units. An empty or whitespace-only run renders no line (zero geometry),
    // matching the Phase 1 empty-text behaviour.
    const rawWords = content.split(/\s+/).filter((word) => word.length > 0);
    if (rawWords.length === 0) {
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

    // `word-break` / `overflow-wrap` control mid-word breaking. `break-all` lets
    // a word break between ANY two characters; `overflow-wrap: break-word` /
    // `anywhere` breaks a word ONLY when it would otherwise overflow its line.
    // We pre-split words into breakable units so the greedy line breaker can
    // wrap them naturally.
    const wordBreak = typeof style["wordBreak"] === "string" ? style["wordBreak"] : "normal";
    const overflowWrap = typeof style["overflowWrap"] === "string" ? style["overflowWrap"] : "normal";
    const perCharAdvance = (ch: string): number => shaper.shapeLine(ch, font).advance + letterSpacing;
    const breakAll = wordBreak === "break-all";
    const breakAnywhere = overflowWrap === "anywhere" || wordBreak === "break-all";
    // For `break-all` / `anywhere`, every word becomes a sequence of single-char
    // units (each is its own breakable word). For `overflow-wrap: break-word`,
    // we keep whole words but split a word mid-way when it cannot fit on a line
    // by itself (handled in the wrap loop below via `canBreakWord`).
    const words: string[] = [];
    if (breakAll || breakAnywhere) {
      for (const word of rawWords) {
        for (const ch of word) words.push(ch);
      }
    } else {
      words.push(...rawWords);
    }
    const canBreakWord = overflowWrap === "break-word" || overflowWrap === "anywhere";

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
    // Track the glyph index range and word count per line so `text-align:
    // justify` can stretch inter-word gaps afterward.
    interface LineRange {
      readonly start: number; // first glyph index on the line.
      readonly end: number; // one-past the last glyph index on the line.
      readonly wordCount: number;
    }
    const lineRanges: LineRange[] = [];
    let current = 0; // advance of the line currently being filled.
    let lineHasContent = false;
    let lineIndex = 0;
    let lineStartGlyph = 0;
    let lineWordCount = 0;
    const closeLine = (advance: number): void => {
      lineWidths.push(advance);
      lineRanges.push({ start: lineStartGlyph, end: glyphs.length, wordCount: lineWordCount });
      lineStartGlyph = glyphs.length;
      lineWordCount = 0;
    };
    for (const word of words) {
      // `letter-spacing` adds advance after each glyph; the metrics shaper emits
      // one glyph per code unit, so the extra is `letterSpacing × word.length`
      // (0 by default ⇒ the inline width is unchanged).
      const wordAdvance = shaper.shapeLine(word, font).advance + letterSpacing * word.length;
      if (!lineHasContent) {
        // The word is the first on its line. `overflow-wrap: break-word` lets a
        // word that STILL overflows the line by itself break mid-word, so it wraps
        // to multiple lines instead of overflowing as one unbreakable unit.
        if (wraps && canBreakWord && wordAdvance > containingWidth) {
          let penX = 0;
          let placedAny = false;
          for (const ch of word) {
            const chAdvance = perCharAdvance(ch);
            if (placedAny && penX + chAdvance > containingWidth) {
              closeLine(penX);
              lineIndex += 1;
              penX = 0;
              placeWord(ch, 0, lineIndex);
              penX = chAdvance;
              lineWordCount = 1;
            } else {
              placeWord(ch, penX, lineIndex);
              penX += chAdvance;
              if (!placedAny) {
                lineWordCount = 1;
                placedAny = true;
              } else {
                lineWordCount += 1;
              }
            }
          }
          current = penX;
          lineHasContent = true;
          continue;
        }
        placeWord(word, 0, lineIndex);
        current = wordAdvance; // first word always fits on its (own) line.
        lineHasContent = true;
        lineWordCount = 1;
        continue;
      }
      const tentative = current + spaceAdvance + wordAdvance;
      if (wraps && tentative > containingWidth) {
        closeLine(current); // close the current line and wrap.
        lineIndex += 1;
        // The wrapped word is now first on the new line; if it still overflows and
        // mid-word breaking is allowed, break it across lines.
        if (canBreakWord && wordAdvance > containingWidth) {
          let penX = 0;
          for (const ch of word) {
            const chAdvance = perCharAdvance(ch);
            if (penX > 0 && penX + chAdvance > containingWidth) {
              closeLine(penX);
              lineIndex += 1;
              penX = 0;
              placeWord(ch, 0, lineIndex);
              penX = chAdvance;
              lineWordCount = 1;
            } else {
              placeWord(ch, penX, lineIndex);
              penX += chAdvance;
              lineWordCount = lineWordCount === 0 ? 1 : lineWordCount + 1;
            }
          }
          current = penX;
          lineWordCount = Math.max(1, lineWordCount);
          continue;
        }
        placeWord(word, 0, lineIndex);
        current = wordAdvance;
        lineWordCount = 1;
      } else {
        placeWord(word, current + spaceAdvance, lineIndex); // after the space gap.
        current = tentative; // the word (and its space) fit on this line (or no-wrap keeps it).
        lineWordCount += 1;
      }
    }
    closeLine(current); // close the final, in-progress line.

    const lineCount = lineWidths.length; // ≥ 1 here.
    const contentHeight = px(lineCount * lineHeight);
    const widestLine = lineWidths.reduce((max, w) => (w > max ? w : max), 0);
    // A wrapping run is clamped to the containing width (its lines fit by
    // construction); a non-wrapping (`nowrap`/`pre`) run keeps its full width,
    // which may OVERFLOW the container (the overflow is then clipped/visible per
    // `overflow`). Default `normal` wraps ⇒ the clamp is unchanged.
    const contentWidth = wraps ? px(Math.min(containingWidth, widestLine)) : px(widestLine);
    // `text-align: justify` stretches the inter-word gaps of every line EXCEPT
    // the last so the line fills the containing width. We keep the natural layout
    // for the last line (and for single-word lines, which have no gap to stretch).
    const justify = readTextAlign(style) === "justify" && wraps;
    if (justify) {
      for (let li = 0; li < lineCount - 1; li += 1) {
        const range = lineRanges[li]!;
        if (range.wordCount < 2) {
          continue; // no inter-word gap to distribute.
        }
        const slack = Math.max(0, containingWidth - lineWidths[li]!);
        if (slack <= 0) {
          continue; // already flush.
        }
        const extraPerGap = slack / (range.wordCount - 1);
        // The glyph stream placed words in DOM order; word boundaries are the
        // glyph positions where a new word began (a word's first glyph). We walk
        // the line's glyphs left to right and accumulate the cumulative stretch
        // at each detected word start.
        let wordOnLine = 0;
        for (let gi = range.start; gi < range.end; gi += 1) {
          const g = glyphs[gi]!;
          // A word starts at x === 0 (line start) OR when the previous glyph's
          // right edge left a space-sized gap (the natural word boundary the
          // placer introduced). Detect the gap: previous glyph advance + its x
          // is less than this glyph's x by roughly spaceAdvance.
          if (gi > range.start) {
            const prev = glyphs[gi - 1]!;
            const gap = Number(g.x) - (Number(prev.x) + Number(prev.advance));
            if (gap >= spaceAdvance * 0.5) {
              wordOnLine += 1;
            }
          }
          const shift = extraPerGap * wordOnLine;
          glyphs[gi] = { ...g, x: px(Number(g.x) + shift) };
        }
      }
    }
    // `text-align` shifts the inline content horizontally within the containing
    // width. We model the run as one box of width `contentWidth`, so alignment
    // is a horizontal offset of that box inside `containingWidth`: `start`/`left`
    // ⇒ 0 (unchanged), `end`/`right` ⇒ all the slack, `center` ⇒ half. `justify`
    // lines are flush to both edges already, so the box offset is 0 (start).
    const alignDelta = justify
      ? 0
      : textAlignOffset(readTextAlign(style), containingWidth, contentWidth);
    // `text-overflow: ellipsis` (with `overflow` clipping on the box): a SINGLE
    // line whose natural width exceeds the content width is truncated to fit and
    // an ellipsis glyph ("…" U+2026) is appended. Multi-line wrapping runs keep
    // their full content (ellipsis applies to the clipped overflow of a line box,
    // not to wrapping). The caller's box clips whatever remains.
    let ellipsisedGlyphs = glyphs;
    // `text-overflow: ellipsis` is a NON-inherited property of the BLOCK
    // container, so when this text run was reached via a block's inline run, the
    // container's value wins over the text node's own (inherited) value.
    const textOverflowSource = containerStyle ?? style;
    const textOverflow =
      typeof textOverflowSource["textOverflow"] === "string" ? textOverflowSource["textOverflow"] : "clip";
    if (
      !wraps &&
      widestLine > containingWidth &&
      textOverflow === "ellipsis"
    ) {
      const ellipsisAdvance = shaper.shapeLine("\u2026", font).advance;
      const budget = Math.max(0, containingWidth - ellipsisAdvance);
      const kept: LaidGlyph[] = [];
      for (const g of glyphs) {
        if (Number(g.x) + Number(g.advance) > budget) break;
        kept.push(g);
      }
      if (kept.length < glyphs.length) {
        kept.push({
          glyphId: 0x2026,
          x: px(budget),
          y: px(0),
          advance: px(ellipsisAdvance),
        });
        ellipsisedGlyphs = kept;
      }
    }
    const box = buildBoxAtOrigin(ZERO_MARGIN, contentWidth, contentHeight);
    const textRun: TextRun = { fontSize, glyphs: ellipsisedGlyphs };
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
  function layoutFlex(node: DomNode, containingWidth: Px, containingHeight?: number, forceContentHeight?: number): Fragment {
    const style = computedStyleOf(node.id);
    const margin = resolveMargin(style);
    const contentWidth = resolveWidth(style, containingWidth, margin);
    const direction = readFlexDirection(style);

    const childIds: FragmentId[] = [];

    if (direction === "column") {
      // Column: main axis = vertical (justify-content packs Y), cross axis =
      // horizontal (align-items aligns X against the content width).
      const justify = readJustifyContent(style);
      const align = readAlignItems(style);
      const mainGap = readFlexGap(style, contentWidth).cross;
      // `order`: collect child ids, drop non-box children, then stable-sort by order.
      const orderedIds: { readonly id: NodeId; readonly order: number; readonly seq: number }[] = [];
      const colAbsIds: NodeId[] = [];
      let colSeq = 0;
      for (const childNodeId of node.children) {
        const childNode = dom.nodes.get(childNodeId);
        if (childNode === undefined || childNode.kind === "comment") continue;
        if (childNode.kind === "text" && (childNode.text ?? "").trim().length === 0) continue;
        const childStyle = childStyleOf(childNodeId);
        if (childStyle !== null) {
          const pos = readPosition(childStyle);
          if (pos === "absolute" || pos === "fixed") {
            colAbsIds.push(childNodeId);
            continue;
          }
        }
        const order = childStyle === null ? 0 : readOrder(childStyle);
        orderedIds.push({ id: childNodeId, order, seq: colSeq });
        colSeq += 1;
      }
      orderedIds.sort((a, b) => (a.order !== b.order ? a.order - b.order : a.seq - b.seq));
      interface ColPlaced {
        readonly frag: Fragment;
        readonly packedY: number;
      }
      const placed: ColPlaced[] = [];
      let cursorY = 0;
      let usedMain = 0;
      let placedCount = 0;
      const childContainingHeight = forceContentHeight ?? containingHeight;
      for (const { id: childNodeId } of orderedIds) {
        const frag = layoutNode(childNodeId, contentWidth, childContainingHeight);
        if (frag === null) {
          continue;
        }
        if (placedCount > 0 && mainGap > 0) {
          cursorY += mainGap;
          usedMain += mainGap;
        }
        placed.push({ frag, packedY: cursorY });
        cursorY += frag.box.marginBox.height;
        usedMain += frag.box.marginBox.height;
        placedCount += 1;
      }
      const justifyFree = Math.max(0, resolveHeight(style, px(usedMain)) - usedMain);
      const { leading: justifyLeading, between: justifyBetween } = justifyOffsets(
        justify,
        justifyFree,
        placed.length,
      );
      for (let i = 0; i < placed.length; i += 1) {
        const { frag, packedY } = placed[i]!;
        const mainY = packedY + justifyLeading + justifyBetween * i;
        const crossX = alignOffset(align, frag.box.marginBox.width, contentWidth);
        childIds.push(register(offsetFragment(frag, crossX, mainY)));
      }
      const contentHeight =
        forceContentHeight !== undefined
          ? px(Math.max(0, forceContentHeight))
          : resolveHeight(style, px(usedMain), ZERO_MARGIN, ZERO_MARGIN, containingHeight);
      for (const absId of colAbsIds) {
        const placed = placeAbsoluteFragment(
          layoutNode,
          absId,
          childStyleOf(absId),
          contentWidth,
          Number(contentHeight),
          0,
          0,
          0,
          0,
        );
        if (placed !== null) childIds.push(register(placed));
      }
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
      readonly order: number; // flex `order` (initial 0).
      readonly seq: number; // document order (for stable sort ties).
      readonly flexGrow: number; // `flex-grow` factor (initial 0).
    }
    const rowItems: RowItem[] = [];
    let fixedOuterMain = 0;
    let flexibleCount = 0;
    let totalGrow = 0;
    let itemSeq = 0;
    const absChildIds: NodeId[] = [];
    for (const childNodeId of node.children) {
      const childNode = dom.nodes.get(childNodeId);
      if (childNode === undefined || childNode.kind === "comment") {
        continue;
      }
      if (childNode.kind === "text" && (childNode.text ?? "").trim().length === 0) {
        continue;
      }
      const childStyle = childStyleOf(childNodeId);
      if (childStyle !== null) {
        const pos = readPosition(childStyle);
        if (pos === "absolute" || pos === "fixed") {
          absChildIds.push(childNodeId);
          continue;
        }
      }
      const edges = childStyle === null ? ZERO_MARGIN : resolveMargin(childStyle);
      const declared = childStyle === null ? null : declaredWidthOf(childStyle, contentWidth);
      let emptyShell = false;
      if (
        declared !== null &&
        childNode.kind === "element" &&
        childStyle !== null &&
        typeof childStyle["height"] !== "number"
      ) {
        let hasContent = false;
        for (const cid of childNode.children) {
          const c = dom.nodes.get(cid);
          if (c === undefined || c.kind === "comment") continue;
          if (c.kind === "text" && (c.text ?? "").trim().length === 0) continue;
          if (c.kind === "element") {
            const d = readDisplay(computedStyleOf(cid));
            if (d === "none") continue;
            const p = readPosition(computedStyleOf(cid));
            if (p === "absolute" || p === "fixed") continue;
          }
          hasContent = true;
          break;
        }
        if (!hasContent) emptyShell = true;
      }
      const order = childStyle === null ? 0 : readOrder(childStyle);
      const flexGrow = childStyle === null ? 0 : readFlexGrow(childStyle);
      const seq = itemSeq;
      itemSeq += 1;
      if (declared !== null && !emptyShell) {
        const outer = declared + edges.left + edges.right;
        fixedOuterMain += outer;
        rowItems.push({ nodeId: childNodeId, flexible: false, edges, fixedInnerWidth: px(declared), order, seq, flexGrow });
      } else if (emptyShell) {
        flexibleCount += 1;
        totalGrow += flexGrow;
        rowItems.push({ nodeId: childNodeId, flexible: true, edges, fixedInnerWidth: px(0), order, seq, flexGrow });
      } else {
        flexibleCount += 1;
        totalGrow += flexGrow;
        rowItems.push({ nodeId: childNodeId, flexible: true, edges, fixedInnerWidth: px(0), order, seq, flexGrow });
      }
    }

    const freeMain = Math.max(0, contentWidth - fixedOuterMain);
    // `flex-grow`: when at least one flexible item declares a positive grow
    // factor, the free main space is shared PROPORTIONALLY to each item's grow
    // factor (flex-basis is treated as auto/0 here). When no grow factors are
    // set, fall back to equal shares (the original "equal columns" behaviour).
    const growShare = (item: { readonly flexGrow: number }): number =>
      totalGrow > 0 ? freeMain * (item.flexGrow / totalGrow) : freeMain / Math.max(1, flexibleCount);
    const justify = readJustifyContent(style);
    const align = readAlignItems(style);
    const flexGap = readFlexGap(style, contentWidth);
    const mainGap = flexGap.main;

    // `order`: items are reordered by ascending `order`, ties broken by document
    // order (a stable sort). This reorders BOTH fixed and flexible items.
    const orderedItems = [...rowItems].sort((a, b) => {
      const ao = a.order;
      const bo = b.order;
      return ao !== bo ? ao - bo : a.seq - b.seq;
    });

    // Pass 2: lay each item out at its final main size and pack it into LINES.
    // Without `flex-wrap` there is exactly one line — behaviour identical to the
    // historical single-line pack. With `wrap`, items that would overflow the
    // main axis start a new line; each line justifies independently and `align-
    // items` resolves against the LINE's cross size. `gap` adds `mainGap`
    // between items on a line and `rowGap` between lines.
    const wrap = readFlexWrap(style);
    const rowGap = readFlexGap(style, contentWidth).cross;
    interface PlacedItem {
      readonly frag: Fragment;
      readonly packedX: number; // main-axis position before justify adjustment.
    }
    interface FlexLine {
      readonly items: PlacedItem[];
      readonly width: number; // sum of the line's margin-box widths (+ main gaps).
      readonly height: number; // tallest item on the line.
    }
    const lines: FlexLine[] = [];
    let line: { items: PlacedItem[]; width: number; height: number } = { items: [], width: 0, height: 0 };
    let maxHeight = 0;
    for (const item of orderedItems) {
      // A flexible item is laid against its inner share (its grow share minus its
      // own margins) so its auto width genuinely fills the distributed space; a
      // fixed item keeps its declared width regardless of the containing value.
      const innerWidth = item.flexible
        ? px(Math.max(0, growShare(item) - item.edges.left - item.edges.right))
        : item.fixedInnerWidth;
      const frag = layoutNode(item.nodeId, innerWidth, forceContentHeight ?? containingHeight);
      if (frag === null) {
        continue;
      }
      const w = Number(frag.box.marginBox.width);
      const h = Number(frag.box.marginBox.height);
      const gap = line.items.length > 0 ? mainGap : 0;
      // Wrap: the next item would overflow the line and wrapping is enabled.
      if (wrap && line.items.length > 0 && line.width + gap + w > contentWidth) {
        lines.push(line);
        line = { items: [], width: 0, height: 0 };
      }
      const packedX = line.width + (line.items.length > 0 ? mainGap : 0);
      line.items.push({ frag, packedX });
      line.width = packedX + w;
      line.height = Math.max(line.height, h);
      maxHeight = Math.max(maxHeight, h);
    }
    lines.push(line);
    // The cross-axis size for a NON-wrapping container is the larger of the
    // tallest item and the container's declared cross size (historical
    // behaviour); for a wrapping container each line resolves against its own
    // height.
    const declaredCross = Number(resolveHeight(style, px(maxHeight)));
    let yAcc = 0;
    for (let li = 0; li < lines.length; li += 1) {
      const l = lines[li]!;
      // `space-*` distribute THIS line's free space (its own width, not the
      // container's), so each line's justify-content lines up with its content.
      const justifyFree = Math.max(0, contentWidth - l.width);
      const { leading: justifyLeading, between: justifyBetween } = justifyOffsets(
        justify,
        justifyFree,
        l.items.length,
      );
      const crossSize = wrap ? l.height : Math.max(maxHeight, declaredCross);
      for (let i = 0; i < l.items.length; i += 1) {
        const { frag, packedX } = l.items[i]!;
        const mainX = packedX + justifyLeading + justifyBetween * i;
        const crossY = yAcc + alignOffset(align, frag.box.marginBox.height, crossSize);
        childIds.push(register(offsetFragment(frag, mainX, crossY)));
      }
      yAcc += l.height + (li < lines.length - 1 ? rowGap : 0);
    }
    const contentHeight =
      forceContentHeight !== undefined
        ? px(Math.max(0, forceContentHeight))
        : resolveHeight(style, px(wrap ? yAcc : maxHeight), ZERO_MARGIN, ZERO_MARGIN, containingHeight);
    for (const absId of absChildIds) {
      const placed = placeAbsoluteFragment(
        layoutNode,
        absId,
        childStyleOf(absId),
        contentWidth,
        Number(contentHeight),
        0,
        0,
        0,
        0,
      );
      if (placed !== null) childIds.push(register(placed));
    }
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
    const gaps = readGridGaps(style, contentWidth);
    const tracks = parseGridTracks(style["gridTemplateColumns"]);
    const colCountHint = Math.max(1, tracks.length);
    const trackBudget = Math.max(0, contentWidth - gaps.column * Math.max(0, colCountHint - 1));
    const colWidths = resolveTrackWidths(tracks, trackBudget);
    const colCount = Math.max(1, colWidths.length);
    const colOffsets: number[] = [];
    {
      let acc = 0;
      for (let i = 0; i < colCount; i += 1) {
        colOffsets.push(acc);
        acc += colWidths[i]! + (i < colCount - 1 ? gaps.column : 0);
      }
    }

    type Placement = {
      nodeId: NodeId;
      col: number;
      row: number;
      colSpan: number;
      rowSpan: number;
      frag: Fragment;
    };
    const placements: Placement[] = [];
    const occupied = new Set<string>();
    const key = (r: number, c: number) => `${r},${c}`;
    const mark = (r: number, c: number, rs: number, cs: number) => {
      for (let rr = r; rr < r + rs; rr += 1) {
        for (let cc = c; cc < c + cs; cc += 1) {
          occupied.add(key(rr, cc));
        }
      }
    };
    const free = (r: number, c: number, rs: number, cs: number): boolean => {
      if (c < 0 || c + cs > colCount) return false;
      for (let rr = r; rr < r + rs; rr += 1) {
        for (let cc = c; cc < c + cs; cc += 1) {
          if (occupied.has(key(rr, cc))) return false;
        }
      }
      return true;
    };
    const findAuto = (colSpan: number, rowSpan: number, fixedCol: number | null): { col: number; row: number } => {
      let row = 0;
      for (;;) {
        if (fixedCol !== null) {
          if (free(row, fixedCol, rowSpan, colSpan)) return { col: fixedCol, row };
        } else {
          for (let col = 0; col <= colCount - colSpan; col += 1) {
            if (free(row, col, rowSpan, colSpan)) return { col, row };
          }
        }
        row += 1;
        if (row > 10000) return { col: 0, row: 0 };
      }
    };

    for (const childNodeId of node.children) {
      const childStyle = childStyleOf(childNodeId);
      if (childStyle !== null) {
        const pos = readPosition(childStyle);
        if (pos === "absolute" || pos === "fixed") {
          continue;
        }
      }
      const colPlace = parseGridPlacement(childStyle === null ? undefined : childStyle["gridColumn"]);
      const rowPlace = parseGridPlacement(childStyle === null ? undefined : childStyle["gridRow"]);
      const colSpan = Math.max(1, Math.min(colCount, colPlace.span));
      const rowSpan = Math.max(1, rowPlace.span);
      let col: number;
      let row: number;
      if (colPlace.start !== null && rowPlace.start !== null) {
        col = Math.max(0, Math.min(colCount - colSpan, colPlace.start - 1));
        row = Math.max(0, rowPlace.start - 1);
      } else if (colPlace.start !== null) {
        const fixedCol = Math.max(0, Math.min(colCount - colSpan, colPlace.start - 1));
        const found = findAuto(colSpan, rowSpan, fixedCol);
        col = found.col;
        row = found.row;
      } else if (rowPlace.start !== null) {
        row = Math.max(0, rowPlace.start - 1);
        let foundCol = 0;
        for (let c = 0; c <= colCount - colSpan; c += 1) {
          if (free(row, c, rowSpan, colSpan)) {
            foundCol = c;
            break;
          }
        }
        col = foundCol;
      } else {
        const found = findAuto(colSpan, rowSpan, null);
        col = found.col;
        row = found.row;
      }
      let cellW = 0;
      for (let c = col; c < col + colSpan && c < colCount; c += 1) {
        cellW += colWidths[c]!;
      }
      const frag = layoutNode(childNodeId, px(Math.max(0, cellW)));
      if (frag === null) {
        continue;
      }
      mark(row, col, rowSpan, colSpan);
      placements.push({ nodeId: childNodeId, col, row, colSpan, rowSpan, frag });
    }

    const maxRow = placements.reduce((m, p) => Math.max(m, p.row + p.rowSpan), 0);
    const rowHeights = new Array<number>(Math.max(1, maxRow)).fill(0);
    for (const p of placements) {
      rowHeights[p.row] = Math.max(rowHeights[p.row]!, p.frag.box.marginBox.height);
    }
    const rowOffsets: number[] = [];
    {
      let acc = 0;
      for (let r = 0; r < rowHeights.length; r += 1) {
        rowOffsets.push(acc);
        acc += rowHeights[r]! + (r < rowHeights.length - 1 ? gaps.row : 0);
      }
    }

    const childIds: FragmentId[] = [];
    for (const p of placements) {
      const x = colOffsets[p.col] ?? 0;
      const y = rowOffsets[p.row] ?? 0;
      childIds.push(register(offsetFragment(p.frag, x, y)));
    }

    const totalH =
      rowHeights.reduce((a, h) => a + h, 0) +
      gaps.row * Math.max(0, rowHeights.length - 1);
    const contentHeight = resolveHeight(style, px(totalH));
    const box = buildBoxAtOrigin(margin, contentWidth, contentHeight);
    return { node: node.id, box, children: childIds };
  }

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

/**
 * Detect a percentage specified-length value (shape: `{ kind: "specified-length",
 * unit: "%", value: <n> }`) WITHOUT importing the generator (cross-stage boundary).
 * Returns the numeric percentage (e.g. `50` for `50%`), or `null` when the value
 * is not a percentage. This lets {@link resolveWidth}/{@link resolveHeight} resolve
 * `width: 50%` / `height: 50%` against their containing block.
 */
function percentOf(value: unknown): number | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as { kind?: unknown; unit?: unknown; value?: unknown };
  if (v.kind === "specified-length" && v.unit === "%" && typeof v.value === "number" && Number.isFinite(v.value)) {
    return v.value;
  }
  return null;
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
function readLengthAgainstWidth(value: unknown, containingWidth: number): Px {
  if (typeof value === "number" && Number.isFinite(value)) {
    return px(Math.max(0, value));
  }
  if (typeof value === "string") {
    const pct = /^(-?\d+(?:\.\d+)?)%$/.exec(value.trim());
    if (pct !== null) {
      return px(Math.max(0, (Number(pct[1]) / 100) * containingWidth));
    }
    const pxm = /^(-?\d+(?:\.\d+)?)px$/i.exec(value.trim());
    if (pxm !== null) {
      return px(Math.max(0, Number(pxm[1])));
    }
  }
  if (typeof value === "object" && value !== null) {
    const v = value as { kind?: unknown; unit?: unknown; value?: unknown };
    if (v.unit === "%" && typeof v.value === "number" && Number.isFinite(v.value)) {
      return px(Math.max(0, (v.value / 100) * containingWidth));
    }
    if (typeof v.value === "number" && Number.isFinite(v.value) && (v.unit === "px" || v.unit === undefined) && v.kind !== "specified-length") {
      return px(Math.max(0, v.value));
    }
    if (v.kind === "specified-length" && typeof v.value === "number" && Number.isFinite(v.value)) {
      if (v.unit === "%") return px(Math.max(0, (v.value / 100) * containingWidth));
      if (v.unit === "px" || v.unit === undefined) return px(Math.max(0, v.value));
    }
  }
  return px(0);
}

function resolvePadding(style: ComputedStyle, containingWidth: number = 0): Edges<Px> {
  const raw = style["padding"];
  const sh: Edges<Px> = {
    top: readLengthAgainstWidth(
      typeof raw === "object" && raw !== null && "top" in (raw) ? (raw).top : raw,
      containingWidth,
    ),
    right: readLengthAgainstWidth(
      typeof raw === "object" && raw !== null && "right" in (raw) ? (raw).right : raw,
      containingWidth,
    ),
    bottom: readLengthAgainstWidth(
      typeof raw === "object" && raw !== null && "bottom" in (raw) ? (raw).bottom : raw,
      containingWidth,
    ),
    left: readLengthAgainstWidth(
      typeof raw === "object" && raw !== null && "left" in (raw) ? (raw).left : raw,
      containingWidth,
    ),
  };
  const pick = (longhand: unknown, short: Px): Px => {
    const lv = readLengthAgainstWidth(longhand, containingWidth);
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
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  // `line-height` is declared as a STRING property in the data table, so a
  // unitless multiplier (`line-height: 2`) reaches layout as the string "2".
  // Accept a numeric string (and reject "normal"/length strings, which need a
  // different resolution path we do not yet implement).
  if (typeof value === "string" && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value.trim())) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) {
      return n;
    }
  }
  return 1.0;
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
    const pct = percentOf(declared);
    if (pct !== null) {
      // `width: <percent>` resolves against the containing block's content width
      // (minus this box's margins, matching the auto-width basis). The result is
      // the BORDER-box percentage; reduce by insets for content-box sizing.
      const basis = containingWidth - margin.left - margin.right;
      content = boxSizing === "border-box" ? (pct * basis) / 100 - insetX : (pct * basis) / 100;
    } else {
      // `auto`: the BORDER box fills the containing block minus horizontal
      // margins, so the content width is that minus this box's own padding+border.
      // Zero insets ⇒ the Phase-1 `containingWidth - margins` behaviour, unchanged.
      content = containingWidth - margin.left - margin.right - insetX;
    }
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
  containingHeight?: number,
): Px {
  const insetY = padding.top + padding.bottom + border.top + border.bottom;
  const boxSizing = readBoxSizing(style);
  const declared = style["height"];
  let content: number;
  if (typeof declared === "number") {
    content = boxSizing === "border-box" ? declared - insetY : declared;
  } else {
    const pct = percentOf(declared);
    if (pct !== null) {
      // `height: <percent>` resolves against the containing block's DEFINITE
      // height (passed in as `containingHeight`). When the containing height is
      // not definite (undefined / non-positive), the spec says the percentage
      // behaves as `auto` — fall through to the element's content height.
      const basis = containingHeight;
      if (basis === undefined || !Number.isFinite(basis) || basis <= 0) {
        content = contentHeight;
      } else {
        content = boxSizing === "border-box" ? (pct * basis) / 100 - insetY : (pct * basis) / 100;
      }
    } else {
      content = contentHeight;
    }
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

function placeAbsoluteFragment(
  layoutNodeFn: (id: NodeId, w: Px, ch?: number, forceH?: number) => Fragment | null,
  childNodeId: NodeId,
  childStyle: ComputedStyle | null,
  padCbW: number,
  padCbH: number,
  padEdgeLeft: number,
  padEdgeTop: number,
  staticLeft: number,
  staticTop: number,
): Fragment | null {
  const declaredTop = childStyle === null ? null : readLengthOr(childStyle["top"]);
  const declaredLeft = childStyle === null ? null : readLengthOr(childStyle["left"]);
  const declaredBottom = childStyle === null ? null : readLengthOr(childStyle["bottom"]);
  const declaredRight = childStyle === null ? null : readLengthOr(childStyle["right"]);
  let usedW = padCbW;
  let forceH: number | undefined;
  let topOffset: number;
  let leftOffset: number;
  if (declaredLeft !== null && declaredRight !== null) {
    usedW = Math.max(0, padCbW - declaredLeft - declaredRight);
    leftOffset = padEdgeLeft + declaredLeft;
  } else if (declaredLeft !== null) {
    leftOffset = padEdgeLeft + declaredLeft;
  } else if (declaredRight !== null) {
    leftOffset = padEdgeLeft;
  } else {
    leftOffset = staticLeft;
  }
  if (declaredTop !== null && declaredBottom !== null) {
    forceH = Math.max(0, padCbH - declaredTop - declaredBottom);
    topOffset = padEdgeTop + declaredTop;
  } else if (declaredTop !== null) {
    topOffset = padEdgeTop + declaredTop;
  } else if (declaredBottom !== null) {
    topOffset = padEdgeTop;
  } else {
    topOffset = staticTop;
  }
  const childFrag = layoutNodeFn(childNodeId, px(usedW), forceH, forceH);
  if (childFrag === null) return null;
  if (declaredLeft === null && declaredRight !== null) {
    leftOffset = padEdgeLeft + Math.max(0, padCbW - declaredRight - Number(childFrag.box.marginBox.width));
  }
  if (declaredTop === null && declaredBottom !== null && forceH === undefined) {
    topOffset = padEdgeTop + Math.max(0, padCbH - declaredBottom - Number(childFrag.box.marginBox.height));
  }
  let placed = offsetFragment(childFrag, leftOffset, topOffset);
  if (forceH !== undefined && Number(placed.box.marginBox.height) < forceH - 0.5) {
    placed = stretchFragmentHeight(placed, forceH - Number(placed.box.marginBox.height));
  }
  return placed;
}

function stretchFragmentHeight(frag: Fragment, grow: number): Fragment {
  if (!(grow > 0)) return frag;
  const box = frag.box;
  return {
    ...frag,
    box: {
      ...box,
      height: px(Number(box.height) + grow),
      contentBox: {
        ...box.contentBox,
        height: px(Number(box.contentBox.height) + grow),
      },
      paddingBox: {
        ...box.paddingBox,
        height: px(Number(box.paddingBox.height) + grow),
      },
      borderBox: {
        ...box.borderBox,
        height: px(Number(box.borderBox.height) + grow),
      },
      marginBox: {
        ...box.marginBox,
        height: px(Number(box.marginBox.height) + grow),
      },
    },
  };
}

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
/**
 * The set of display values the layout dispatcher recognizes as real layout
 * branches. Legacy/vendor values are normalized INTO these by {@link readDisplay}.
 */
const LAYOUT_DISPLAYS: ReadonlySet<string> = new Set([
  "block",
  "inline",
  "inline-block",
  "flex",
  "grid",
  "table",
  "none",
]);

/**
 * Read the computed `display` and NORMALIZE legacy / vendor / inline-variant
 * values into a layout branch the engine actually implements:
 *
 *   - `-webkit-box` / `-webkit-inline-box` / `-ms-flexbox` / `-ms-inline-flexbox`
 *     / `-webkit-inline-flex` → `flex` (every modern browser maps old flexbox
 *     to standard flex).
 *   - `inline-flex` / `inline-grid` / `inline-table` → the inner layout
 *     (`flex` / `grid` / `table`); the inline *outer* role awaits a real inline
 *     formatting context, so the box currently participates as a block — but its
 *     CHILDREN get the correct inner layout, which is where the visible damage
 *     was (children stacking vertically instead of flowing along a flex axis).
 *   - `list-item` → `block` (list markers are not yet rendered).
 *
 * Unrecognized / absent values fall back to the initial `inline`.
 */
function readDisplay(style: ComputedStyle): string {
  const value = style["display"];
  if (typeof value !== "string") {
    return "inline";
  }
  switch (value) {
    case "-webkit-box":
    case "-webkit-inline-box":
    case "-ms-flexbox":
    case "-ms-inline-flexbox":
    case "-webkit-inline-flex":
      return "flex";
    case "inline-flex":
      return "flex";
    case "inline-grid":
      return "grid";
    case "inline-table":
      return "table";
    case "list-item":
      return "block";
    default:
      return LAYOUT_DISPLAYS.has(value) ? value : "inline";
  }
}

/**
 * Is this child an INLINE-LEVEL box (a member of the inline formatting context)?
 * Text nodes always are; elements are when they are in-flow, non-floated, and
 * declare `display: inline` / `inline-block`. Everything else (block/flex/grid/
 * table/none, positioned, floated) is block-level and BREAKS an inline run.
 * The raw `display` value is consulted (not the normalized one) so `inline-block`
 * participates in the run while `inline-flex` (normalized to flex) does not.
 */
function isInlineLevelChild(node: DomNode, style: ComputedStyle | null): boolean {
  if (node.kind === "text") {
    return true;
  }
  if (node.kind !== "element" || style === null) {
    return false;
  }
  const position = readPosition(style);
  if (position === "absolute" || position === "fixed") {
    return false;
  }
  if (readFloat(style) !== "none") {
    return false;
  }
  const display = style["display"];
  return display === "inline" || display === "inline-block";
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

/**
 * Read the `clear` keyword (initial `none`). Recognized values: `none`, `left`,
 * `right`, `both`, `inline-start`, `inline-end`. Anything else ⇒ `none`.
 */
function readClear(style: ComputedStyle): string {
  const value = style["clear"];
  if (
    typeof value === "string" &&
    (value === "none" ||
      value === "left" ||
      value === "right" ||
      value === "both" ||
      value === "inline-start" ||
      value === "inline-end")
  ) {
    return value;
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
function readPosition(style: ComputedStyle): "static" | "relative" | "absolute" | "fixed" {
  const value = style["position"];
  if (value === "relative") return "relative";
  if (value === "absolute") return "absolute";
  if (value === "fixed") return "fixed";
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
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value && typeof value === "object" && "value" in (value)) {
    const v = value as { value?: unknown; unit?: unknown; kind?: unknown };
    if (typeof v.value === "number" && Number.isFinite(v.value)) {
      if (v.unit === "%" || v.unit === "percent") return null;
      return v.value;
    }
  }
  if (typeof value === "string") {
    const m = /^(-?\d+(?:\.\d+)?)(px)?$/.exec(value.trim());
    if (m) return Number(m[1]);
  }
  return null;
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
 * Read the flex container's `justify-content` (main-axis packing). Falls back to
 * `flex-start` (the initial value) for any unrecognized keyword.
 */
function readJustifyContent(style: ComputedStyle): string {
  const value = style["justifyContent"];
  return typeof value === "string" ? value : "flex-start";
}

/**
 * Read the flex container's `align-items` (cross-axis alignment). Falls back to
 * `stretch` (the initial value) for any unrecognized keyword.
 */
function readAlignItems(style: ComputedStyle): string {
  const value = style["alignItems"];
  return typeof value === "string" ? value : "stretch";
}

/**
 * Read the flex `gap` for the main axis (the column gap for a row, the row gap
 * for a column). Honors the `gap` shorthand, the `column-gap`/`row-gap`
 * longhands, and the legacy `grid-gap`/`grid-column-gap` aliases.
 */
function readFlexGap(style: ComputedStyle, containingWidth: number): { main: number; cross: number } {
  const gaps = readGridGaps(style, containingWidth);
  return { main: gaps.column, cross: gaps.row };
}

/**
 * Read a flex item's `order` (initial 0). Items are sorted by ascending order;
 * equal orders keep document order (stable).
 */
function readOrder(style: ComputedStyle): number {
  const value = style["order"];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Read a flex item's `flex-grow` factor (initial 0). A negative value is
 * clamped to 0. Non-numeric / absent ⇒ 0.
 */
function readFlexGrow(style: ComputedStyle): number {
  const value = style["flexGrow"];
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * Whether the flex container WRAPS its items onto multiple lines. `wrap` and
 * `wrap-reverse` both return true (the reverse axis is treated as plain wrap for
 * now); `nowrap` (the initial value) and anything else return false.
 */
function readFlexWrap(style: ComputedStyle): boolean {
  const value = style["flexWrap"];
  return value === "wrap" || value === "wrap-reverse";
}

/**
 * Compute the main-axis (x) offset for each packed item given the total free
 * space and the `justify-content` keyword. Returns one leading offset per item
 * index (the item is additionally shifted by the cumulative inter-item spacing).
 *
 * `usedMain` is the sum of the items' outer main sizes; `contentMain` is the
 * container's content-box main size. `count` is the number of items.
 */
function justifyOffsets(
  justify: string,
  freeSpace: number,
  count: number,
): { readonly leading: number; readonly between: number } {
  if (count <= 0 || freeSpace <= 0) {
    return { leading: 0, between: 0 };
  }
  switch (justify) {
    case "flex-end":
    case "end":
      return { leading: freeSpace, between: 0 };
    case "center":
      return { leading: freeSpace / 2, between: 0 };
    case "space-between":
      return { leading: 0, between: count > 1 ? freeSpace / (count - 1) : 0 };
    case "space-around":
      return {
        leading: count > 0 ? freeSpace / count / 2 : 0,
        between: count > 1 ? freeSpace / count : 0,
      };
    case "space-evenly":
      return { leading: freeSpace / (count + 1), between: freeSpace / (count + 1) };
    case "flex-start":
    case "start":
    default:
      return { leading: 0, between: 0 };
  }
}

/**
 * Compute the cross-axis (y) offset for an item given its outer cross size, the
 * line's cross size, and the `align-items` keyword. `stretch` keeps the item at
 * cross-start (its size was already resolved against the container cross size by
 * the layout call), matching the existing behavior.
 */
function alignOffset(align: string, itemCross: number, lineCross: number): number {
  const slack = Math.max(0, lineCross - itemCross);
  switch (align) {
    case "flex-end":
    case "end":
      return slack;
    case "center":
      return slack / 2;
    case "flex-start":
    case "start":
    case "stretch":
    case "baseline":
    default:
      return 0;
  }
}

function readGapLength(value: unknown, containingWidth: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  if (typeof value === "string") {
    const pct = /^(-?\d+(?:\.\d+)?)%$/.exec(value.trim());
    if (pct !== null) return Math.max(0, (Number(pct[1]) / 100) * containingWidth);
    const pxm = /^(-?\d+(?:\.\d+)?)px$/i.exec(value.trim());
    if (pxm !== null) return Math.max(0, Number(pxm[1]));
    const n = Number(value);
    if (Number.isFinite(n)) return Math.max(0, n);
  }
  if (typeof value === "object" && value !== null) {
    const v = value as { unit?: unknown; value?: unknown };
    if (typeof v.value === "number" && Number.isFinite(v.value)) {
      if (v.unit === "%") return Math.max(0, (v.value / 100) * containingWidth);
      return Math.max(0, v.value);
    }
  }
  return 0;
}

function readGridGaps(style: ComputedStyle, containingWidth: number): { row: number; column: number } {
  const shorthand = style["gap"] ?? style["gridGap"];
  let row = 0;
  let column = 0;
  if (typeof shorthand === "string") {
    const parts = shorthand.trim().split(/\s+/).filter((p) => p.length > 0);
    if (parts.length === 1) {
      row = readGapLength(parts[0], containingWidth);
      column = row;
    } else if (parts.length >= 2) {
      row = readGapLength(parts[0], containingWidth);
      column = readGapLength(parts[1], containingWidth);
    }
  } else if (typeof shorthand === "number") {
    row = Math.max(0, shorthand);
    column = row;
  }
  if (style["rowGap"] !== undefined) row = readGapLength(style["rowGap"], containingWidth);
  if (style["columnGap"] !== undefined) column = readGapLength(style["columnGap"], containingWidth);
  return { row, column };
}

type GridTrack = { readonly kind: "px"; readonly size: number } | { readonly kind: "fr"; readonly fr: number };

function parseOneTrackToken(token: string): GridTrack {
  const t = token.trim();
  const pxMatch = /^(-?\d+(?:\.\d+)?)px$/i.exec(t);
  if (pxMatch !== null) {
    return { kind: "px", size: Math.max(0, Number(pxMatch[1])) };
  }
  const frMatch = /^(-?\d+(?:\.\d+)?)fr$/i.exec(t);
  if (frMatch !== null) {
    return { kind: "fr", fr: Math.max(0, Number(frMatch[1])) };
  }
  const num = Number(t);
  if (Number.isFinite(num) && num > 0) {
    return { kind: "px", size: num };
  }
  return { kind: "fr", fr: 1 };
}

function parseGridTracks(value: unknown): GridTrack[] {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return Array.from({ length: value }, () => ({ kind: "fr" as const, fr: 1 }));
  }
  if (Array.isArray(value) && value.length > 0) {
    return value.map((entry) => {
      if (typeof entry === "number" && Number.isFinite(entry)) {
        return { kind: "px" as const, size: Math.max(0, entry) };
      }
      if (typeof entry === "string") {
        return parseOneTrackToken(entry);
      }
      return { kind: "fr" as const, fr: 1 };
    });
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const s = value.trim();
    // A bare positive integer (e.g. `grid-template-columns: 2`) means "that many
    // equal 1fr columns" — the same meaning as the numeric form, which reaches
    // this branch as a STRING because the cascade stores grid-template-columns
    // as a string property.
    const bareCount = /^\d+$/.exec(s);
    if (bareCount !== null) {
      const n = Number(bareCount[0]);
      if (Number.isInteger(n) && n > 0) {
        return Array.from({ length: n }, () => ({ kind: "fr" as const, fr: 1 }));
      }
    }
    const tracks: GridTrack[] = [];
    let i = 0;
    while (i < s.length) {
      while (i < s.length && /\s/.test(s[i]!)) i += 1;
      if (i >= s.length) break;
      if (/^repeat\s*\(/i.test(s.slice(i))) {
        const open = s.indexOf("(", i);
        let depth = 0;
        let j = open;
        for (; j < s.length; j += 1) {
          if (s[j] === "(") depth += 1;
          else if (s[j] === ")") {
            depth -= 1;
            if (depth === 0) break;
          }
        }
        const inner = s.slice(open + 1, j);
        const comma = inner.indexOf(",");
        const count = Math.max(0, Math.floor(Number(inner.slice(0, comma).trim())));
        const trackPart = inner.slice(comma + 1).trim();
        const repeated = parseGridTracks(trackPart);
        for (let n = 0; n < count; n += 1) {
          tracks.push(...repeated);
        }
        i = j + 1;
        continue;
      }
      let j = i;
      while (j < s.length && !/\s/.test(s[j]!)) j += 1;
      tracks.push(parseOneTrackToken(s.slice(i, j)));
      i = j;
    }
    return tracks.length > 0 ? tracks : [{ kind: "fr", fr: 1 }];
  }
  return [{ kind: "fr", fr: 1 }];
}

function resolveTrackWidths(tracks: readonly GridTrack[], budget: number): number[] {
  if (tracks.length === 0) {
    return [Math.max(0, budget)];
  }
  let fixed = 0;
  let frSum = 0;
  for (const t of tracks) {
    if (t.kind === "px") fixed += t.size;
    else frSum += t.fr;
  }
  const free = Math.max(0, budget - fixed);
  const unit = frSum > 0 ? free / frSum : 0;
  return tracks.map((t) => (t.kind === "px" ? t.size : t.fr * unit));
}

function parseGridPlacement(value: unknown): { start: number | null; span: number } {
  if (typeof value !== "string") {
    return { start: null, span: 1 };
  }
  const raw = value.trim();
  const spanOnly = /^span\s+(\d+)$/i.exec(raw);
  if (spanOnly !== null) {
    return { start: null, span: Math.max(1, Number(spanOnly[1])) };
  }
  const lineForm = /^(\d+)\s*\/\s*(\d+)$/.exec(raw);
  if (lineForm !== null) {
    const a = Number(lineForm[1]);
    const b = Number(lineForm[2]);
    return { start: a, span: Math.max(1, b - a) };
  }
  const startSpan = /^(\d+)\s*\/\s*span\s+(\d+)$/i.exec(raw);
  if (startSpan !== null) {
    return { start: Number(startSpan[1]), span: Math.max(1, Number(startSpan[2])) };
  }
  const single = /^(\d+)$/.exec(raw);
  if (single !== null) {
    return { start: Number(single[1]), span: 1 };
  }
  return { start: null, span: 1 };
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
function declaredWidthOf(style: ComputedStyle, containingWidth?: number): number | null {
  const declared = style["width"];
  if (typeof declared === "number") return Math.max(0, declared);
  const pct = percentOf(declared);
  if (pct !== null && containingWidth !== undefined && Number.isFinite(containingWidth) && containingWidth > 0) {
    return Math.max(0, (pct * containingWidth) / 100);
  }
  return null;
}
