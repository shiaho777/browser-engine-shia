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
 * container's content height equals the last in-flow child's **border-box
 * bottom** — under margin collapsing (RFC 0003) adjoining vertical margins
 * fold into one gap, so the raw sum of margin-box heights overcounts. The
 * collapse follows CSS 2.1 §8.3.1 (sibling adjacency, parent/first-and-last-
 * child edges, empty-block self-collapse) gated on the spec's barriers
 * (borders, padding, clearance, BFC boundaries via the shared
 * {@link BlockFormattingContext} registry).
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
  Color,
  LaidGlyph,
  NodeId,
  Px,
  Rect,
  TextRun,
} from "@browser-engine/ir";

import { defaultShaper } from "./text-shaper.js";
import type { CssFontSelection, ShapingFont, TextShaper } from "./text-shaper.js";
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
  CssFontSelection,
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
  BIDI_CTRL,
  baseDirection,
  bidiClass,
  bidiRuns,
  bidiVisualRuns,
  reorderVisual,
  resolveLevels,
  runScriptTag,
  scriptOf,
  scriptRuns,
  visualOrderParts,
  type BidiClass,
  type BidiPiece,
  type BidiRun,
  type Direction,
  type Script,
  type ScriptRun,
  type VisualPart,
} from "./bidi.js";
export { breakUnits, lbClass, pairBreak } from "./linebreak.js";
export type { BreakOptions, BreakUnit, LBClass } from "./linebreak.js";

import {
  BIDI_CTRL,
  bidiVisualRuns,
  runScriptTag,
  visualOrderParts,
  type BidiPiece,
} from "./bidi.js";
import {
  breakUnits,
  lbClass,
  type BreakOptions,
  type BreakUnit,
} from "./linebreak.js";
import { BlockFormattingContext } from "./bfc.js";

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
  /**
   * The viewport's current scroll offset (document-space y). `position:fixed`
   * boxes pin to the viewport rect `(0, scrollY, w, h)` and `sticky` offsets
   * clamp against it — since layout re-runs per scroll repaint, passing the
   * live offset reproduces real pin behaviour per frame. Default 0.
   */
  readonly scrollY?: number;
  /**
   * RFC 0038 incremental layout: a caller-owned subtree-reuse cache that
   * survives across `layout()` calls. When supplied, layoutNode checks each
   * element that establishes an independent formatting context (BFC root,
   * flex/grid/table/multicol/ruby container, replaced element, or a flex/grid
   * ITEM — all layout boundaries whose internal geometry depends only on
   * their own subtree plus the incoming containing-block size) against the
   * cache; a clean hit replays the recorded fragment subtree under FRESH
   * fragment ids, so the emitted tree keeps unique ids and stays frozen.
   *
   * Correctness contract — the caller MUST keep this honest:
   *  - `clean(id)` answers "this node's subtree content and every ancestor's
   *    style-affecting inputs are unchanged since the damage snapshot"; a
   *    conservative `false` is always safe.
   *  - `epoch` is bumped by the caller on ANY global input change: viewport
   *    size, scrollY, stylesheet set, writing-mode plumbing.
   *  - A subtree that pushed out-of-flow requests to an enclosing containing
   *    block is NEVER cached (its static-position inputs live outside).
   * Nodes that are not boundaries — plain in-flow blocks — always re-lay out:
   * their contents observe sibling floats and margin collapse from outside.
   */
  readonly incremental?: IncrementalLayout;
}

/**
 * RFC 0038: one cached layout boundary — the fragments a single `layoutNode`
 * call emitted for an isolated subtree, together with the external inputs the
 * layout consumed. Fragment objects are shared verbatim with older trees
 * (they are frozen); on reuse they are re-registered under fresh ids.
 */
export interface CachedSubtree {
  /**
   * The subtree's root fragment AS RETURNED by the producing dispatch —
   * unregistered (the parent's placement pass offsets and registers it). It
   * replays by cloning under the caller's own placement, so positions in the
   * parent can change freely.
   */
  readonly root: Fragment;
  /**
   * Every fragment created while laying the subtree out — the descendants
   * `root.children` links reach into. The root itself is NOT here.
   */
  readonly descendants: ReadonlyMap<FragmentId, Fragment>;
  /** External inputs the internal layout consumed. */
  readonly width: number;
  readonly containingHeight: number; // -1 when absent
  readonly forceContentHeight: number;
  readonly forcedContentWidth: number;
  /** The {@link IncrementalLayout.epoch} the entry was produced under. */
  readonly epoch: number;
}

/**
 * RFC 0038: caller-owned damage + reuse store for incremental layout. One
 * instance lives on the session and is passed into every `layout()` call.
 */
export interface IncrementalLayout {
  /**
   * "The subtree rooted at `id` is byte-for-byte what the producing run
   * saw" — no attribute/style/content mutations inside it and no
   * content-dirty ancestor (inherited styles can change a clean subtree).
   * Structural dirt on an ANCESTOR (a sibling insert above) does NOT taint
   * the node — its internal layout only depends on itself and the incoming
   * containing size; it simply lands at a new position.
   */
  readonly clean: (id: NodeId) => boolean;
  /** NodeId → last producing run's subtree. Callers may pre-seed or clear. */
  readonly entries: Map<NodeId, CachedSubtree>;
  /**
   * Global-invalidations stamp: bump whenever anything outside the tracked
   * damage set can change layout (viewport, scrollY, stylesheet set, shaper
   * config). Entries produced under another epoch are ignored.
   */
  epoch: number;
  /**
   * Optional counters — hit/miss/tainted stores for benchmark evidence. The
   * engine never reads them.
   */
  readonly stats?: { hits: number; misses: number; stores: number; bypassed: number };
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
  // A block's `::first-letter` / `::first-line` applies to the first letter of
  // its first line, which may sit inside a `display: inline` descendant. While
  // that descendant lays out, this points at the block's style. `inline-block`
  // is not carried into: it is its own block.
  let ancestorPseudo: ComputedStyle | undefined;
  let inlineDropCap: { cap?: { side: "left" | "right"; width: number; height: number } } = {};
  const scrollY = options?.scrollY ?? 0;
  const incr = options?.incremental;

  /**
   * The stack of pending out-of-flow (absolutely-positioned) children. A block
   * that is a containing-block owner for `position:absolute` descendants
   * (`position ≠ static`, or a `transform` — Transforms §4 makes ANY
   * transformed element a CB) pushes a frame before laying out its children
   * and drains it against its own padding box after its height resolves.
   * Children of non-CB blocks forward into the stack top — which is exactly
   * "the nearest positioned ancestor" (CSS 2.1 §10.1). Frame 0 is the initial
   * containing block (the viewport): it also catches every `position:fixed`
   * box unless an intermediate frame `capturesFixed` (a transformed ancestor
   * captures fixed descendants per Transforms §4).
   */
  interface AbsReq {
    readonly childNodeId: NodeId;
    readonly childStyle: ComputedStyle | null;
    readonly fixed: boolean;
    /** The BFC instance active where the box was encountered (frame check). */
    readonly bfc: BlockFormattingContext;
    /** The box's would-be static position, in that BFC's coordinates. */
    readonly staticBfcX: number;
    readonly staticBfcY: number;
  }
  const absStack: { items: AbsReq[]; capturesFixed: boolean }[] = [
    { items: [], capturesFixed: false },
  ];

  // -------------------------------------------------------------------------
  // Shadow DOM / composed-tree flattening (RFC 0018)
  //
  // Layout consumes the FLAT tree: a shadow host's renderable children are its
  // shadow root's children, and each `<slot>` inside a shadow tree renders the
  // host's light-DOM children assigned to it (name match on `slot=`; unnamed
  // slots take unslotted children + text). With no assignment the slot's own
  // children render as fallback. Anything else uses the light-DOM `children`.
  // -------------------------------------------------------------------------

  /** The nearest shadow host for `node`, when `node` lives in a shadow tree. */
  const enclosingShadowHost = (node: DomNode): DomNode | undefined => {
    let cur = node.parent;
    while (cur !== null) {
      const n = dom.nodes.get(cur);
      if (n === undefined) return undefined;
      if (n.tag === "#shadow-root") {
        return n.parent === null ? undefined : dom.nodes.get(n.parent);
      }
      cur = n.parent;
    }
    return undefined;
  };

  /** Light-DOM children of `host` assigned to `<slot>` `slotNode`. */
  const assignedToSlot = (host: DomNode, slotNode: DomNode): NodeId[] => {
    const name = slotNode.attrs?.get("name") ?? "";
    return host.children.filter((cid) => {
      const c = dom.nodes.get(cid);
      if (c?.kind === "element") return (c.attrs?.get("slot") ?? "") === name;
      return c?.kind === "text" && name === ""; // text slottable only into the default slot
    });
  };

  /**
   * The children layout actually renders: shadow-host → shadow tree kids;
   * `<slot>` in a shadow tree → its assigned light children (else fallback);
   * anything else → light-DOM children.
   */
  const contentChildren = (node: DomNode): readonly NodeId[] => {
    if (node.shadow !== undefined) {
      return dom.nodes.get(node.shadow)?.children ?? [];
    }
    if (node.tag === "slot") {
      const host = enclosingShadowHost(node);
      if (host !== undefined) {
        const assigned = assignedToSlot(host, node);
        return assigned.length > 0 ? assigned : node.children;
      }
    }
    return node.children;
  };

  /** Register a built fragment in the flat map and hand back its fresh id. */
  function register(fragment: Fragment): FragmentId {
    const id = fragmentId(nextId);
    nextId += 1;
    fragments.set(id, fragment);
    if (probeDepth > 0) probeIds.push(id);
    return id;
  }

  // Measurement passes (flex column auto-base, grid cell probe, stretch
  // re-layout) call layoutNode purely to read a size — the fragment subtree
  // they produce must NOT leak into the tree (a node would appear twice and
  // getBoundingClientRect would return the stale probe). `layoutProbe` wraps
  // such calls and rolls back every registration made inside.
  let probeDepth = 0;
  const probeIds: FragmentId[] = [];

  /**
   * RFC 0038: replay a cached boundary subtree — clone each recorded fragment
   * under a FRESH id (the returned tree's ids stay globally unique) while
   * sharing the frozen geometry verbatim. Returns null when the entry is
   * incomplete (a fragment referenced by `children` went missing — treat as a
   * corrupt cache; callers fall through to a real re-layout).
   */
  function reuseSubtree(entry: CachedSubtree): Fragment | null {
    const remap = new Map<FragmentId, FragmentId>();
    // Descendants were REGISTERED fragments — clone each under a fresh id so
    // the emitted tree keeps unique ids; frozen geometry shared verbatim.
    const cloneDesc = (oldId: FragmentId): FragmentId | null => {
      const done = remap.get(oldId);
      if (done !== undefined) return done;
      const of = entry.descendants.get(oldId);
      if (of === undefined) return null;
      const children: FragmentId[] = [];
      for (const c of of.children) {
        const cid = cloneDesc(c);
        if (cid === null) return null;
        children.push(cid);
      }
      const nid = register({ ...of, children });
      remap.set(oldId, nid);
      return nid;
    };
    const children: FragmentId[] = [];
    for (const c of entry.root.children) {
      const cid = cloneDesc(c);
      if (cid === null) return null;
      children.push(cid);
    }
    // The root replay is NOT registered — the parent's placement pass applies
    // the offset and registers it, exactly like a freshly produced fragment.
    return { ...entry.root, children };
  }

  function layoutProbe<T>(fn: () => T): T {
    const mark = probeIds.length;
    probeDepth += 1;
    try {
      return fn();
    } finally {
      for (let i = probeIds.length - 1; i >= mark; i -= 1) {
        fragments.delete(probeIds[i]!);
      }
      probeIds.length = mark;
      probeDepth -= 1;
    }
  }

  /**
   * Remove every descendant fragment of `frag` from the flat map. `frag`
   * itself was never registered (callers register placed fragments), so only
   * its `children` subtree needs dropping — used when an item is re-laid out
   * (stretch re-layout) and the earlier pass's descendants become stale.
   */
  function dropFragmentTree(frag: Fragment): void {
    const stack = [...frag.children];
    while (stack.length > 0) {
      const id = stack.pop()!;
      const child = fragments.get(id);
      if (child === undefined) continue;
      stack.push(...child.children);
      fragments.delete(id);
    }
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
    return activeStyleOf(id);
  }

  // ---- vertical writing modes (RFC 0025) -----------------------------------
  //
  // A vertical-mode subtree is laid out in a VIRTUAL horizontal space: the
  // CSS inline axis is virtual-x and the block axis virtual-y, so the entire
  // horizontal pipeline (block flow, inline runs, floats, alignment) runs
  // unmodified; a post-pass then transposes the emitted fragment subtree into
  // physical coordinates. Styles inside the space are viewed through
  // `activeStyleOf`, which permutes the physical edges back into virtual
  // order — the cascade already mapped logical→physical, so the physical
  // fields carry correct values and only need re-axis-ing.
  //
  // `writing-mode` itself remaps to `horizontal-tb` inside the space, so a
  // descendant's own mode cannot re-enter the virtual branch — nested
  // writing-mode switches inside vertical content are a documented bound.
  interface SpaceMap {
    /** The writing-mode keyword this space transposes (`vertical-rl` …). */
    readonly wm: string;
    /** block-start sits at the physical RIGHT (vertical-rl) when true. */
    readonly blockFlip: boolean;
    /** inline-start sits at the physical BOTTOM (direction:rtl) when true. */
    readonly inlineFlip: boolean;
    /** virtual edge → physical edge it sources. */
    readonly src: { top: AxisEdge; right: AxisEdge; bottom: AxisEdge; left: AxisEdge };
  }

  function spaceMapFor(wm: string, dir: "ltr" | "rtl"): SpaceMap {
    const blockFlip = wm === "vertical-rl" || wm === "sideways-rl";
    // `sideways-*` rotate a horizontal box: CW (rl) keeps ltr inline flow
    // top→bottom; CCW (lr) flips it to bottom→top for ltr — the inline axis
    // direction is inverted vs the `vertical-*` partners.
    const inlineFlip =
      wm === "sideways-lr" ? dir === "ltr" : dir === "rtl";
    return {
      wm,
      blockFlip,
      inlineFlip,
      src: {
        top: blockFlip ? "right" : "left",
        bottom: blockFlip ? "left" : "right",
        left: inlineFlip ? "bottom" : "top",
        right: inlineFlip ? "top" : "bottom",
      },
    };
  }

  type AxisEdge = "top" | "right" | "bottom" | "left";
  const EDGE_CAP: Record<AxisEdge, string> = {
    top: "Top", right: "Right", bottom: "Bottom", left: "Left",
  };

  let activeSpace: SpaceMap | null = null;
  const virtualStyleCache = new Map<NodeId, ComputedStyle>();

  /**
   * Permute a computed style's physical edges into the active virtual space:
   * virtual-top ← physical(src.top), etc. Widths/heights swap (the inline
   * extent is the physical height), `writing-mode` reads `horizontal-tb`, and
   * `text-orientation`/`direction` pass through unchanged (direction is
   * already the virtual-inline direction).
   */
  function remapStyleForSpace(style: ComputedStyle, space: SpaceMap): ComputedStyle {
    const s = style as unknown as Record<string, unknown>;
    const out: Record<string, unknown> = { ...s };
    const edges: readonly AxisEdge[] = ["top", "right", "bottom", "left"];
    for (const stem of ["margin", "padding"] as const) {
      for (const e of edges) {
        out[`${stem}${EDGE_CAP[e]}`] = s[`${stem}${EDGE_CAP[space.src[e]]}`];
      }
    }
    for (const e of edges) {
      for (const suffix of ["Width", "Style", "Color"] as const) {
        out[`border${EDGE_CAP[e]}${suffix}`] =
          s[`border${EDGE_CAP[space.src[e]]}${suffix}`];
      }
    }
    for (const e of edges) {
      out[e] = s[space.src[e]]; // insets: top/right/bottom/left
    }
    // Border radii: a virtual corner's physical source is the corner at
    // (src.blockEdge, src.inlineEdge).
    out["borderTopLeftRadius"] = s[`border${EDGE_CAP[space.src.top]}${EDGE_CAP[space.src.left]}Radius`];
    out["borderTopRightRadius"] = s[`border${EDGE_CAP[space.src.top]}${EDGE_CAP[space.src.right]}Radius`];
    out["borderBottomRightRadius"] = s[`border${EDGE_CAP[space.src.bottom]}${EDGE_CAP[space.src.right]}Radius`];
    out["borderBottomLeftRadius"] = s[`border${EDGE_CAP[space.src.bottom]}${EDGE_CAP[space.src.left]}Radius`];
    // The inline extent is the physical height; the block extent the width.
    out["width"] = s["height"];
    out["height"] = s["width"];
    out["minWidth"] = s["minHeight"];
    out["minHeight"] = s["minWidth"];
    out["maxWidth"] = s["maxHeight"];
    out["maxHeight"] = s["maxWidth"];
    out["overflowX"] = s["overflowY"];
    out["overflowY"] = s["overflowX"];
    out["writingMode"] = "horizontal-tb";
    return Object.freeze(out) as unknown as ComputedStyle;
  }

  function activeStyleOf(id: NodeId): ComputedStyle {
    const s = computedStyleOf(id);
    if (activeSpace === null) return s;
    let hit = virtualStyleCache.get(id);
    if (hit === undefined) {
      hit = remapStyleForSpace(s, activeSpace);
      virtualStyleCache.set(id, hit);
    }
    return hit;
  }

  /** `text-orientation` keyword (inherited; initial `mixed`). */
  function textOrientationOf(style: ComputedStyle): string {
    const v =
      typeof style["textOrientation"] === "string"
        ? style["textOrientation"].trim().toLowerCase()
        : "mixed";
    return v === "upright" || v === "sideways" || v === "mixed" ? v : "mixed";
  }

  /**
   * Whether a glyph rotates 90° clockwise in vertical text. `sideways`
   * rotates everything, `upright` nothing; `mixed` keeps the vertical-native
   * classes (ideographic/kana/conditional starters) upright and rotates the
   * rest — `lbClass` doubles as the script test here.
   */
  function glyphRotates(glyphId: number, orientation: string): boolean {
    if (orientation === "sideways") return true;
    if (orientation === "upright") return false;
    const cls = lbClass(glyphId);
    return cls !== "ID" && cls !== "CJ";
  }

  /**
   * Lay out one DOM node, returning an UNREGISTERED fragment positioned at the
   * origin (its margin-box top-left at `(0, 0)`); the caller offsets it into
   * place and registers it. Descendants are registered during recursion.
   * Returns `null` when the node produces no box (comment, or `display:none`).
   */

  /**
   * RFC 0021: form controls are replaced elements (HTML §14.3/rendering —
   * their internal parts are not laid out as DOM). `input[type=hidden]`
   * keeps normal-element status (its UA `display:none` is overridable).
   */
  function isReplacedElement(node: DomNode): boolean {
    const tag = node.tag;
    if (tag === "img" || tag === "svg" || tag === "iframe" || tag === "canvas" || tag === "video") {
      return true;
    }
    // RFC 0035: `<audio>` is a replaced box only when it shows a controls
    // widget (HTML §14.3); without `controls` the UA sheet hides it anyway.
    if (tag === "audio") return node.attrs?.has("controls") === true;
    if (tag === "textarea" || tag === "select") return true;
    if (tag === "input") {
      const t = (node.attrs?.get("type") ?? "text").toLowerCase().trim();
      return t !== "hidden";
    }
    return false;
  }

  /**
   * A form control's intrinsic size (documented approximation of the UA's
   * control-part metrics — no real widget toolkit exists to measure):
   * character-cell types derive width from `size`/`cols` × approximate char
   * width and height from `rows` × line-height; push-buttons derive width
   * from label text; checkbox/radio/range/color/file carry fixed defaults.
   */
  function controlIntrinsicSize(
    node: DomNode,
    style: Record<string, unknown>,
  ): { width: number; height: number } | undefined {
    const fontSize =
      typeof style["font-size"] === "number" ? (style["font-size"]) : 16;
    const lineH =
      typeof style["line-height"] === "number" && (style["line-height"]) > 0
        ? (style["line-height"])
        : fontSize * 1.2;
    const charW = fontSize * 0.5; // 0.5em ≈ average glyph advance.
    const numAttr = (name: string, dflt: number): number => {
      const n = Number(node.attrs?.get(name));
      return Number.isFinite(n) && n > 0 ? n : dflt;
    };
    switch (node.tag) {
      case "textarea":
        return {
          width: numAttr("cols", 20) * charW + 4,
          height: numAttr("rows", 2) * lineH + 4,
        };
      case "select": {
        // Collapsed control: widest option label + dropdown affordance;
        // a sized/multiple select shows a list-box `size` rows tall.
        let widest = 0;
        const collect = (id: NodeId): void => {
          const n = dom.nodes.get(id);
          if (n === undefined) return;
          if (n.tag === "option") {
            let len = 0;
            for (const c of n.children ?? []) {
              const t = dom.nodes.get(c);
              if (t?.kind === "text") len += (t.text ?? "").trim().length;
            }
            widest = Math.max(widest, len);
            return;
          }
          for (const c of n.children ?? []) collect(c);
        };
        for (const c of node.children ?? []) collect(c);
        const rows = numAttr("size", 1);
        const listbox = node.attrs?.has("multiple") === true || rows > 1;
        return {
          width: Math.max(24, widest * charW + 24),
          height: (listbox ? Math.max(rows, 1) : 1) * lineH + 6,
        };
      }
      case "input": {
        const t = (node.attrs?.get("type") ?? "text").toLowerCase().trim();
        switch (t) {
          case "checkbox":
          case "radio":
            return { width: 13, height: 13 };
          case "range":
            return { width: 129, height: Math.max(15, lineH) };
          case "color":
            return { width: 44, height: Math.max(23, lineH) };
          case "file":
            return { width: 238, height: lineH + 4 };
          case "submit":
          case "reset":
          case "button":
          case "image": {
            const label =
              node.attrs?.get("value") ??
              (t === "submit" ? "Submit" : t === "reset" ? "Reset" : "");
            return { width: Math.max(40, label.length * charW + 16), height: lineH + 6 };
          }
          default:
            // Text-entry family (text/search/tel/url/email/password/number/
            // date/…): `size` chars wide, one line tall + field padding.
            return { width: numAttr("size", 20) * charW + 2, height: lineH + 3 };
        }
      }
      default:
        return undefined;
    }
  }

  function resolveIntrinsicSize(node: DomNode, style: Record<string, unknown>): { width: number; height: number } | undefined {
    const control = controlIntrinsicSize(node, style);
    if (control !== undefined) return control;
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
      // RFC 0013: iframe intrinsic size per HTML (300×150 default object size).
      if (node.tag === "iframe") {
        return { width: 300, height: 150 };
      }
      // RFC 0033: `<canvas>` default bitmap size per HTML (300×150); the
      // width/height attrs were already honored by the numeric path above.
      if (node.tag === "canvas") {
        return { width: 300, height: 150 };
      }
      // RFC 0035: `<video>` uses the same default-object-size rule (HTML
      // §4.8.11's 300×150 before metadata; intrinsic-dimensions-reflow is a
      // documented boundary — metadata arrives async through the resource
      // pass, so `width`/`height` attrs remain the declared-size path).
      if (node.tag === "video") {
        return { width: 300, height: 150 };
      }
      // RFC 0035: `audio[controls]` paints a 300×54 controls box (no widget
      // toolkit — a replaced placeholder).
      if (node.tag === "audio" && node.attrs?.has("controls") === true) {
        return { width: 300, height: 54 };
      }
    } else if (node.tag === "iframe" || node.tag === "canvas" || node.tag === "video") {
      return { width: 300, height: 150 };
    } else if (node.tag === "svg") {
      return { width: 20, height: 20 };
    }
    return undefined;
  }

  function layoutReplaced(node: DomNode, containingWidth: Px): Fragment {
    const style = activeStyleOf(node.id);
    const margin = resolveMargin(style);
    const padding = resolvePadding(style, containingWidth);
    const border = resolveBorder(style);
    const intrinsic = resolveIntrinsicSize(node, style);
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

  function layoutNode(
    id: NodeId,
    containingWidth: Px,
    containingHeight?: number,
    forceContentHeight?: number,
    fc?: FlowCtx,
    forcedContentWidth?: Px,
  ): Fragment | null {
    const node = dom.nodes.get(id);
    if (node === undefined || node.kind === "comment") {
      return null;
    }
    if (node.kind === "text") {
      // The parent element IS the paragraph container: its `direction`/
      // `unicode-bidi`/`dir` drive the text's bidi context (RFC 0023), and its
      // `text-indent` was already meant to reach the run (CSS inheritance made
      // that a no-op before — now the container is explicit).
      const parentId = node.parent;
      const parentNode = parentId !== null ? dom.nodes.get(parentId) : undefined;
      const parentStyle = parentId !== null ? activeStyleOf(parentId) : undefined;
      return layoutInline(node, containingWidth, parentStyle, undefined, parentNode);
    }
    // element or document.
    if (node.kind === "element") {
      // Vertical writing mode (RFC 0025): lay the subtree out in a virtual
      // horizontal space (inline↔x, block↔y) and transpose the emitted
      // fragments. The REAL computed value decides — inside a virtual space
      // `writing-mode` reads `horizontal-tb`, so nested modes must compare
      // against `computedStyleOf`. A perpendicular or different-axis child is
      // laid out physically and stored pre-transposed (`layoutOrthogonal`);
      // a same-mode child simply stays inside the space (its author mode is
      // inherited anyway, so `realWm === activeSpace.wm` covers it).
      const realWm = readWritingMode(computedStyleOf(id));
      // An abspos border box is resolved in its containing block's axes, which
      // is the active (possibly virtual) space. Entering layoutVertical /
      // layoutOrthogonal here would swap that box onto the abspos's own
      // writing mode before align-self / justify-self had sized it. Descendants
      // still take their own mode when they are laid out below.
      const pos = computedStyleOf(id)["position"];
      const sizedInCbSpace = pos === "absolute" || pos === "fixed";
      if (!sizedInCbSpace) {
        if (activeSpace === null) {
          if (realWm !== "horizontal-tb") {
            return layoutVertical(node, containingWidth, containingHeight, realWm);
          }
        } else if (realWm !== activeSpace.wm) {
          return layoutOrthogonal(node, containingWidth, containingHeight);
        }
      }
      // Dispatch off the element's computed `display` into the advanced layout
      // BRANCHES (task 7.1; Req 16.1) WITHOUT changing the IR boundary
      // (design.md §8.2 note). `display` is read as a *string* so the `table`
      // keyword — not in the `DisplayValue` union because the generator's
      // property table does not yet emit it — can be matched defensively.
      const elStyle = activeStyleOf(id);
      const display = readDisplay(elStyle);
      if (display === "none") {
        return null; // skip the element and its entire subtree.
      }
      const produce = (): Fragment | null => {
        if (isReplacedElement(node)) {
          // Replaced elements (RFC 0013 iframe; RFC 0021 form controls): their
          // children are fallback/content-model internals and MUST NOT lay out
          // — the frame's own document / the control part owns that surface.
          return layoutReplaced(node, containingWidth);
        }
        if (display === "flex") {
          return layoutFlex(node, containingWidth, containingHeight, forceContentHeight, forcedContentWidth);
        }
        if (display === "grid") {
          return layoutGrid(node, containingWidth, containingHeight, forcedContentWidth, forceContentHeight === undefined ? undefined : px(forceContentHeight));
        }
        if (display === "table") {
          return layoutTable(
            node,
            containingWidth,
            containingHeight,
            forceContentHeight === undefined ? undefined : px(forceContentHeight),
            forcedContentWidth,
          );
        }
        if (display === "ruby") {
          return layoutRuby(node, containingWidth);
        }
        if (establishesMulticol(elStyle)) {
          return layoutMulticol(node, containingWidth);
        }
        return layoutBlock(node, containingWidth, containingHeight, forceContentHeight, undefined, fc, forcedContentWidth);
      };
      // ---- RFC 0038: subtree reuse at formatting-context boundaries --------
      // A boundary's internal layout is a pure function of its subtree plus
      // the incoming containing sizes — floats and margins cannot cross a
      // BFC/flex/grid edge — so a clean entry replays verbatim. Anything else
      // (plain in-flow blocks) participates in the surrounding flow and must
      // re-lay out: outside floats rewrap its lines, sibling margins merge.
      // Layout probes are excluded: inside `layoutProbe` the produced ids get
      // rolled back — a cached subtree replayed there would keep its stale
      // registrations. Virtual writing-mode spaces transpose after layout;
      // skip reuse there too.
      if (incr !== undefined && activeSpace === null && probeDepth === 0) {
        const parentId = node.parent;
        const parentDisplay =
          parentId !== null ? readDisplay(activeStyleOf(parentId)) : "";
        const boundary =
          isReplacedElement(node) ||
          display === "flex" ||
          display === "grid" ||
          display === "table" ||
          display === "ruby" ||
          establishesMulticol(elStyle) ||
          establishesBfc(elStyle) ||
          // Flexbox §4 / Grid §3.4: flex and grid ITEMS are independent
          // formatting contexts — outside floats and margins never reach in.
          parentDisplay === "flex" ||
          parentDisplay === "grid";
        if (boundary) {
          const widthIn = Number(containingWidth);
          const heightIn = containingHeight ?? -1;
          const forceHIn = forceContentHeight ?? -1;
          const forcedWIn = forcedContentWidth === undefined ? -1 : Number(forcedContentWidth);
          const hit = incr.entries.get(id);
          if (
            hit !== undefined &&
            hit.epoch === incr.epoch &&
            incr.clean(id) &&
            hit.width === widthIn &&
            hit.containingHeight === heightIn &&
            hit.forceContentHeight === forceHIn &&
            hit.forcedContentWidth === forcedWIn
          ) {
            if (incr.stats !== undefined) incr.stats.hits += 1;
            const replayed = reuseSubtree(hit);
            if (replayed !== null) return replayed;
          }
          if (incr.stats !== undefined) incr.stats.misses += 1;
          const fragMark = nextId;
          const leakMark =
            absStack.length > 0 ? absStack[absStack.length - 1]!.items.length : 0;
          const frag = produce();
          const leak =
            absStack.length > 0
              ? absStack[absStack.length - 1]!.items.length - leakMark
              : 0;
          // Outgoing out-of-flow requests anchor against a containing-block
          // ancestor OUTSIDE this subtree — their static positions are inputs
          // the replay cannot reproduce, so such subtrees are never cached.
          if (frag !== null && leak === 0) {
            const created = new Map<FragmentId, Fragment>();
            for (let i = fragMark; i < nextId; i += 1) {
              const fid = fragmentId(i);
              const f = fragments.get(fid);
              if (f === undefined) continue;
              created.set(fid, f);
            }
            incr.entries.set(id, {
              root: frag,
              descendants: created,
              width: widthIn,
              containingHeight: heightIn,
              forceContentHeight: forceHIn,
              forcedContentWidth: forcedWIn,
              epoch: incr.epoch,
            });
            if (incr.stats !== undefined) incr.stats.stores += 1;
          } else if (leak !== 0) {
            incr.entries.delete(id);
            if (incr.stats !== undefined) incr.stats.bypassed += 1;
          }
          return frag;
        }
      }
      return produce();
    }
    return layoutBlock(node, containingWidth, containingHeight, forceContentHeight, undefined, fc, forcedContentWidth);
  }

  /**
   * `writing-mode` reader (RFC 0025): sanitizes to the four vertical keywords
   * or `horizontal-tb`; anything else means horizontal flow.
   */
  function readWritingMode(style: ComputedStyle): string {
    const v =
      typeof style["writingMode"] === "string"
        ? style["writingMode"].trim().toLowerCase()
        : "horizontal-tb";
    return v === "vertical-rl" || v === "vertical-lr" ||
      v === "sideways-rl" || v === "sideways-lr"
      ? v
      : "horizontal-tb";
  }

  /**
   * Vertical writing mode: lay the subtree out in a virtual horizontal space
   * (inline axis ↔ x, block axis ↔ y) and transpose the emitted fragments.
   *
   * The virtual containing width is the inline extent — the containing
   * block's physical height when definite, else the viewport height
   * (documented bound: vertical text in an auto-height container wraps at
   * the viewport height).
   */
  function layoutVertical(
    node: DomNode,
    containingWidth: Px,
    containingHeight: number | undefined,
    wm: string,
  ): Fragment | null {
    const space = spaceMapFor(
      wm,
      readDirection(activeStyleOf(node.id)) ?? "ltr",
    );
    const prevSpace = activeSpace;
    activeSpace = space;
    virtualStyleCache.clear();
    try {
      const vcw = px(
        containingHeight !== undefined
          ? containingHeight
          : Number(viewportHeight),
      );
      const frag = layoutNode(node.id, vcw, containingWidth);
      return frag === null ? null : remapSubtree(frag, space, true);
    } finally {
      activeSpace = prevSpace;
      virtualStyleCache.clear();
    }
  }

  /**
   * Orthogonal child (RFC 0025): an element whose real `writing-mode` differs
   * from the active virtual space's (`horizontal-tb`, or a vertical mode with
   * a different block direction). Lay its subtree out in TRUE physical space,
   * then inverse-transpose the result into the parent's virtual space so the
   * outer pass un-maps it back — box and glyphs both recover physical
   * geometry, and the text runs keep their own writing-mode marker so the
   * outer pass doesn't re-rotate them.
   *
   * The child's physical containing width is the parent's block extent — the
   * caller's `containingHeight` offer (usually indefinite, so the child
   * behaves like an unbounded-width shrink-to-fit context; documented bound).
   */
  function layoutOrthogonal(
    node: DomNode,
    containingWidth: Px,
    containingHeight: number | undefined,
  ): Fragment | null {
    const space = activeSpace;
    if (space === null) return null;
    const prevSpace = activeSpace;
    activeSpace = null;
    try {
      const cw =
        containingHeight !== undefined ? px(containingHeight) : containingWidth;
      const frag = layoutNode(node.id, cw, Number(containingWidth));
      return frag === null ? null : remapSubtree(frag, space, false);
    } finally {
      activeSpace = prevSpace;
    }
  }

  /**
   * Re-map a fragment subtree between a frag's virtual (inline↔x, block↔y)
   * coordinate space and its physical one — in both directions. Vertical
   * subtrees are laid out in the virtual space and transposed OUT
   * (`toPhys: true`); perpendicular children — a `horizontal-tb` element or a
   * different vertical mode inside a vertical context — are laid out
   * physically and transposed IN (`toPhys: false`) so the outer pass lands
   * them with the right physical geometry.
   *
   * Coordinate model (matches `offsetFragment`/paint): a fragment's stored
   * rects live in the space whose origin is that fragment's margin-box TL;
   * children are positioned relative to their PARENT's margin-box origin.
   * `frame` therefore anchors a frag space at its margin box: `ax,ay` is the
   * space origin in the input's stored coords (always the owner's margin-box
   * pos — `(0,0)` at rest), `bx..bh` the OUTPUT-space margin-box rect the
   * space maps onto, with `bw`/`bh` read as the block/inline extents of that
   * output rect.
   */
  interface TransFrame {
    readonly ax: number;
    readonly ay: number;
    readonly bx: number;
    readonly by: number;
    readonly bw: number;
    readonly bh: number;
  }

  function remapSubtree(root: Fragment, space: SpaceMap, toPhys: boolean): Fragment {
    const wmIsSideways = space.wm.startsWith("sideways");
    const remapRect = (r: Rect, f: TransFrame): Rect => {
      const relX = Number(r.x) - f.ax;
      const relY = Number(r.y) - f.ay;
      const rw = Number(r.width);
      const rh = Number(r.height);
      // Block-axis rel → output x (toPhys) / input-x → output y (toVirtual).
      const ox = toPhys
        ? f.bx + (space.blockFlip ? f.bw - (relY + rh) : relY)
        : f.bx + (space.inlineFlip ? f.bw - (relY + rh) : relY);
      const oy = toPhys
        ? f.by + (space.inlineFlip ? f.bh - (relX + rw) : relX)
        : f.by + (space.blockFlip ? f.bh - (relX + rw) : relX);
      return makeRect(px(ox), px(oy), r.height, r.width);
    };

    const remapFrag = (f: Fragment, frame: TransFrame): Fragment => {
      const b = f.box;
      const outMb = remapRect(b.marginBox, frame);
      const borderBox = remapRect(b.borderBox, frame);
      const out: Fragment = {
        node: f.node,
        box: {
          x: borderBox.x,
          y: borderBox.y,
          width: borderBox.width,
          height: borderBox.height,
          contentBox: remapRect(b.contentBox, frame),
          paddingBox: remapRect(b.paddingBox, frame),
          borderBox,
          marginBox: outMb,
        },
        children: f.children,
        ...(f.text === undefined ? {} : { text: remapText(f, b, frame) }),
      };
      const childFrame: TransFrame = {
        ax: 0,
        ay: 0,
        bx: Number(outMb.x),
        by: Number(outMb.y),
        bw: Number(outMb.width),
        bh: Number(outMb.height),
      };
      for (const cid of f.children) {
        const child = fragments.get(cid);
        if (child === undefined) continue;
        fragments.set(cid, remapFrag(child, childFrame));
      }
      return out;
    };

    /** Glyphs are content-box-relative; remap them inside that box only. */
    const remapText = (f: Fragment, b: BoxGeometry, frame: TransFrame): TextRun => {
      const t = f.text!;
      const outContent = remapRect(b.contentBox, frame);
      const cw = Number(outContent.width);
      const ch = Number(outContent.height);
      const fs = Number(t.fontSize);
      // A run stamped with a writingMode already carries its final axis —
      // perpendicular/nested subtrees pass through untransformed.
      const foreign = t.writingMode !== undefined;
      const orientation = foreign
        ? "upright"
        : wmIsSideways
          ? "sideways"
          : textOrientationOf(activeStyleOf(f.node));
      return {
        ...t,
        advanceAxis: foreign ? (t.advanceAxis ?? "x") : toPhys ? "y" : "x",
        writingMode: foreign ? t.writingMode : toPhys ? space.wm : "horizontal-tb",
        glyphs: t.glyphs.map((g) => {
          const gx = Number(g.x);
          const gy = Number(g.y);
          const adv = Number(g.advance);
          return {
            ...g,
            x: px(
              toPhys
                ? space.blockFlip ? cw - (gy + fs) : gy
                : space.inlineFlip ? cw - (gy + adv) : gy,
            ),
            y: px(
              toPhys
                ? space.inlineFlip ? ch - (gx + adv) : gx
                : space.blockFlip ? ch - (gx + fs) : gx,
            ),
            ...(toPhys && !foreign && glyphRotates(g.glyphId, orientation)
              ? { rotate90: true as const }
              : {}),
          };
        }),
      };
    };

    const mb = root.box.marginBox;
    return remapFrag(root, {
      ax: 0,
      ay: 0,
      bx: Number(mb.x),
      by: Number(mb.y),
      bw: Number(mb.height),
      bh: Number(mb.width),
    });
  }

  /**
   * Ruby layout (RFC 0026): a `display:ruby` box is a shrink-wrapped atomic
   * whose children partition by their COMPUTED `display` — `ruby-text` /
   * `ruby-text-container` become annotations, `ruby-base` /
   * `ruby-base-container` unwrap into base items, `none` (`<rp>`) drops,
   * and everything else (bare text, ordinary inline elements) is base
   * content. Each item keeps its own element id / style, so `<rt>`'s UA
   * `font-size: 50%` and per-span color survive.
   *
   * Geometry: content width = max(base extent, widest annotation); the
   * narrower run is centred inside it (`ruby-align: start` flushes to the
   * inline start edge — which transposes correctly inside vertical writing
   * since the ruby lays out in the space's virtual x). Annotations on the
   * `ruby-position: over` side stack above the base line, `under` below;
   * they grow the box's block size so the annotation always has room —
   * real engines let annotations overhang into the line gap instead, an
   * approximation documented in the RFC. `inter-character` maps to `over`.
   *
   * The base run is emitted as the LAST text-bearing child so
   * {@link rubyBaselineOff} can find it by scanning from the end: its
   * baseline (contentTop + its own ascent) is what the atomic member feeds
   * `vertical-align`, not the box's bottom margin edge.
   */
  function layoutRuby(node: DomNode, containingWidth: Px): Fragment {
    const style = activeStyleOf(node.id);
    const margin = resolveMargin(style);
    const padding = resolvePadding(style, containingWidth);
    const border = resolveBorder(style);

    interface RubyTextItem {
      readonly nodeId: NodeId;
      readonly text: string;
      readonly font: ShapingFont;
      readonly letterSpacing: number;
      readonly fontSize: number;
      readonly ascent: number;
      readonly lineHeight: number;
    }
    const baseItems: RubyTextItem[] = [];
    interface RubyAnn {
      readonly item: RubyTextItem;
      readonly under: boolean;
    }
    const anns: RubyAnn[] = [];

    const rubyFontSize = Number(style.fontSize);
    const itemOf = (nodeId: NodeId, styleId: NodeId, text: string): RubyTextItem => {
      const st = activeStyleOf(styleId);
      const fs = Number(st.fontSize);
      return {
        nodeId,
        text,
        font: {
          fontSize: st.fontSize,
          fontWeight: readFontWeight(st),
          css: fontSelection(st),
          ...directionProp(st),
        },
        letterSpacing: readSpacing(st["letterSpacing"]),
        fontSize: fs,
        ascent: 0.8 * fs,
        lineHeight: readLineHeight(st) * fs,
      };
    };
    const foldText = (raw: string): string => raw.replace(/\s+/g, " ");

    /** Flattened descendant text (nested elements fold into their parent's run). */
    const textOf = (id: NodeId): string => {
      const n = dom.nodes.get(id);
      if (n === undefined) return "";
      if (n.kind === "text") return n.text ?? "";
      let acc = "";
      for (const cid of contentChildren(n)) acc += textOf(cid);
      return acc;
    };

    const rawDisplay = (id: NodeId): string => {
      const st = childStyleOf(id);
      const v = st?.["display"];
      return typeof v === "string" ? v.trim().toLowerCase() : "inline";
    };
    const rubyPosition = (id: NodeId): string => {
      const st = childStyleOf(id);
      const v = st?.["rubyPosition"];
      return typeof v === "string" ? v.trim().toLowerCase() : "over";
    };

    const collect = (kidId: NodeId): void => {
      const kid = dom.nodes.get(kidId);
      if (kid === undefined) return;
      if (kid.kind === "text") {
        const t = foldText(kid.text ?? "");
        if (t.length > 0 && t !== " ") {
          baseItems.push(itemOf(kidId, kid.parent ?? node.id, t));
        }
        return;
      }
      if (kid.kind !== "element") return;
      const kd = rawDisplay(kidId);
      if (kd === "none") return; // <rp> — its parens never paint.
      if (kd === "ruby-text") {
        const t = foldText(textOf(kidId));
        anns.push({ item: itemOf(kidId, kidId, t), under: rubyPosition(kidId) === "under" });
        return;
      }
      if (kd === "ruby-text-container") {
        // An rtc's rt children are its annotations; bare text inside rtc
        // forms an implicit annotation carried by the rtc's own style.
        let rtcText = "";
        for (const g of contentChildren(kid)) {
          const gn = dom.nodes.get(g);
          if (gn === undefined) continue;
          if (gn.kind === "element" && rawDisplay(g) === "ruby-text") {
            const t = foldText(textOf(g));
            anns.push({ item: itemOf(g, g, t), under: rubyPosition(kidId) === "under" || rubyPosition(g) === "under" });
          } else {
            rtcText += textOf(g);
          }
        }
        const t = foldText(rtcText);
        if (t.length > 0 && t !== " ") {
          anns.push({ item: itemOf(kidId, kidId, t), under: rubyPosition(kidId) === "under" });
        }
        return;
      }
      // ruby-base / ruby-base-container unwrap; anything else (including a
      // nested `display:ruby`) contributes its flattened text with its own
      // style — nested ruby annotations are not paired (documented bound).
      if (kd === "ruby-base" || kd === "ruby-base-container") {
        for (const g of contentChildren(kid)) collect(g);
        return;
      }
      const t = foldText(textOf(kidId));
      if (t.length > 0 && t !== " ") {
        baseItems.push(itemOf(kidId, kidId, t));
      }
    };
    for (const kidId of contentChildren(node)) collect(kidId);

    // Shape every item once; the run width is the sum of advances.
    const shaped = (item: RubyTextItem): { glyphs: LaidGlyph[]; advance: number } => {
      const out = shapeWordUnits(shaper, item.text, item.font, item.letterSpacing);
      return { glyphs: out.glyphs.map((g) => ({ glyphId: g.glyphId, faceIndex: g.faceIndex, x: px(g.dx), y: px(g.dy), advance: px(g.advance) })), advance: out.advance };
    };
    const baseRuns = baseItems.map((it) => ({ it, s: shaped(it) }));
    const annRuns = anns.map((a) => ({ a, s: shaped(a.item) }));

    const baseW = baseRuns.reduce((acc, r) => acc + r.s.advance, 0);
    const baseH = Math.max(rubyFontSize, ...baseItems.map((i) => i.lineHeight));
    const baseAsc = Math.max(0.8 * rubyFontSize, ...baseItems.map((i) => i.ascent));

    // The box's inline extent covers whichever run is wider; the narrower
    // run is centred (or start-flushed) inside it.
    const align = typeof style["rubyAlign"] === "string" ? style["rubyAlign"].trim().toLowerCase() : "space-around";
    const centerish = align !== "start";
    const overAnns = annRuns.filter((r) => !r.a.under);
    const underAnns = annRuns.filter((r) => r.a.under);
    const overH = overAnns.reduce((acc, r) => acc + r.a.item.lineHeight, 0);
    const underH = underAnns.reduce((acc, r) => acc + r.a.item.lineHeight, 0);
    const widestAnn = annRuns.reduce((acc, r) => Math.max(acc, r.s.advance), 0);
    const contentW = Math.max(baseW, widestAnn);
    const contentH = overH + baseH + underH;
    const box = buildBoxAtOrigin(margin, px(contentW), px(contentH), padding, border);
    const contentLeft = Number(box.contentBox.x);
    const contentTop = Number(box.contentBox.y);

    const alignX = (runW: number): number =>
      centerish ? Math.max(0, (contentW - runW) / 2) : 0;

    const childIds: FragmentId[] = [];
    // Base items first (annotation fragments paint over them if they touch).
    let pen = contentLeft + alignX(baseW);
    for (const r of baseRuns) {
      const dy = baseAsc - r.it.ascent; // baseline-align mixed-size base spans
      const glyphs: LaidGlyph[] = r.s.glyphs.map((g) => ({ ...g, y: px(Number(g.y) + dy) }));
      const frag: Fragment = {
        node: r.it.nodeId,
        box: buildBoxAtOrigin(ZERO_MARGIN, px(r.s.advance), px(baseH)),
        children: [],
        text: {
          fontSize: r.it.font.fontSize,
          fontWeight: r.it.font.fontWeight ?? 400,
          ...(synthesizeBoldAllowed(r.it.font.css) ? {} : { synthesizeBold: false }),
          glyphs,
        },
      };
      childIds.push(register(offsetFragment(frag, pen, contentTop + overH)));
      pen += r.s.advance;
    }
    // Over annotations stack upward from the base line; under downward.
    let y = contentTop + overH;
    for (const r of overAnns) {
      y -= r.a.item.lineHeight;
      const frag: Fragment = {
        node: r.a.item.nodeId,
        box: buildBoxAtOrigin(ZERO_MARGIN, px(r.s.advance), px(r.a.item.lineHeight)),
        children: [],
        text: {
          fontSize: r.a.item.font.fontSize,
          fontWeight: r.a.item.font.fontWeight ?? 400,
          ...(synthesizeBoldAllowed(r.a.item.font.css) ? {} : { synthesizeBold: false }),
          glyphs: r.s.glyphs.map((g) => ({ ...g })),
        },
      };
      childIds.push(register(offsetFragment(frag, contentLeft + alignX(r.s.advance), y)));
    }
    y = contentTop + overH + baseH;
    for (const r of underAnns) {
      const frag: Fragment = {
        node: r.a.item.nodeId,
        box: buildBoxAtOrigin(ZERO_MARGIN, px(r.s.advance), px(r.a.item.lineHeight)),
        children: [],
        text: {
          fontSize: r.a.item.font.fontSize,
          fontWeight: r.a.item.font.fontWeight ?? 400,
          ...(synthesizeBoldAllowed(r.a.item.font.css) ? {} : { synthesizeBold: false }),
          glyphs: r.s.glyphs.map((g) => ({ ...g })),
        },
      };
      childIds.push(register(offsetFragment(frag, contentLeft + alignX(r.s.advance), y)));
      y += r.a.item.lineHeight;
    }

    return { node: node.id, box, children: childIds };
  }

  /**
   * A `display:ruby` atomic's baseline: the BASE run's baseline, found by
   * scanning the box's children for the first text run that is not an
   * annotation (`rt`/`rtc` node). Falls back to the bottom margin edge when
   * the ruby degenerated to annotation-only content.
   */
  function rubyBaselineOff(frag: Fragment): number {
    for (const cid of frag.children) {
      const cf = fragments.get(cid);
      if (cf === undefined || cf.text === undefined) continue;
      const tag = dom.nodes.get(cf.node)?.tag;
      if (tag === "rt" || tag === "rtc") continue;
      return Number(cf.box.contentBox.y) + 0.8 * Number(cf.text.fontSize);
    }
    return Number(frag.box.marginBox.height);
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
  function layoutBlock(node: DomNode, containingWidth: Px, containingHeight?: number, forceContentHeight?: number, maxHeight?: number, fc?: FlowCtx, forcedContentWidth?: Px): Fragment {
    const style = activeStyleOf(node.id);
    const margin = resolveMargin(style);
    const padding = resolvePadding(style, containingWidth);
    const border = resolveBorder(style);
    // `forcedContentWidth` is the flex algorithm's resolved MAIN size: a flex
    // item's used size is the flexed target, not its declared `width` (which
    // only seeds `flex-basis:auto`). Other callers leave it undefined.
    const contentWidth = forcedContentWidth ?? resolveWidth(style, containingWidth, margin, padding, border);

    // Containing-block ownership (CSS 2.1 §10.1 + Transforms §4): a box whose
    // `position` is non-static — OR that carries a transform — is the CB for
    // its `absolute` descendants, and a TRANSFORMED box additionally captures
    // `fixed` descendants. Owning means opening an abs frame so descendants
    // queue here instead of bubbling to an outer ancestor.
    const selfPosition = typeof style["position"] === "string" ? style["position"] : "static";
    const selfTransform = hasTransform(style);
    const isCbOwner =
      (selfPosition !== "static" && selfPosition !== "") || selfTransform;
    if (isCbOwner) {
      absStack.push({ items: [], capturesFixed: selfTransform });
    }

    // ---- block formatting context (RFC 0003) --------------------------------
    // `shared` is non-null when this block PARTICIPATES in its parent's BFC —
    // i.e. it does not establish a fresh one. A BFC root gets its own float
    // registry and margin chains cannot cross its edges.
    const shared: FlowCtx | undefined =
      fc !== undefined && !establishesBfc(style) ? fc : undefined;
    const bfc = shared?.bfc ?? new BlockFormattingContext();

    // ---- parent/first-child top-margin collapse (CSS 2.1 §8.3.1) ------------
    // Peek at the first in-flow child: when this block has no top border or
    // padding and is not itself a BFC root, its top margin collapses with the
    // first in-flow child's. Out-of-flow children (floats, positioned) are
    // skipped; an inline-level or cleared first child blocks the collapse (the
    // anonymous block around an inline run has zero margins — and it still
    // consumes the first-in-flow slot).
    const flatChildren = contentChildren(node);
    let firstCollapseId: NodeId | null = null;
    let marginTopEff = margin.top;
    if (shared !== undefined && border.top === 0 && padding.top === 0) {
      for (const cid of flatChildren) {
        const cnode = dom.nodes.get(cid);
        if (cnode === undefined || cnode.kind === "comment") {
          continue;
        }
        if (cnode.kind === "text") {
          // Whitespace-only text produces no box — keep peeking.
          if (visualWords(cnode.text ?? "", undefined).length === 0) {
            continue;
          }
          break; // a real text run takes the first in-flow slot.
        }
        const cstyle = childStyleOf(cid);
        if (cnode.kind !== "element" || cstyle === null) {
          break;
        }
        if (isInlineLevelChild(cnode, cstyle)) {
          break; // anonymous inline block intervenes.
        }
        const pos = readPosition(cstyle);
        if (pos === "absolute" || pos === "fixed") {
          continue; // out of flow — does not count.
        }
        if (readFloat(cstyle) !== "none" || readDisplay(cstyle) === "none") {
          continue;
        }
        if (readClear(cstyle) !== "none") {
          break; // a cleared child's top margin never collapses with the parent.
        }
        firstCollapseId = cid;
        marginTopEff = px(collapsedMargin(margin.top, resolveMargin(cstyle).top));
        break;
      }
    }

    // Children register in this box's LOCAL frame — the fragment is still at the
    // origin here and only the box itself is offset by the grandparent later — so
    // the content origin runs from the MARGIN-box origin: +margin → border box,
    // +border+padding → content box. Zero margins ⇒ the historical values.
    const contentLeft = margin.left + border.left + padding.left;
    const contentTop = marginTopEff + border.top + padding.top;

    // This block's content-box origin in the shared BFC's coordinates (a BFC
    // root anchors its own BFC at its content box — (0, 0)).
    const contentOriginBfcX = shared === undefined ? 0 : shared.originX + contentLeft;
    const contentOriginBfcY = shared === undefined ? 0 : shared.originY + contentTop;

    // The DEFINITE content height this block offers its percentage-height
    // children and its relatively positioned descendants. A length, a
    // percentage or calc against a definite containing height, or `stretch`
    // against that same height, is definite. `auto` stays indefinite even
    // when an ancestor's height is known — a percentage does not skip an
    // auto-height box (CSS 2.1 §10.5).
    const declaredHeight = style["height"];
    const ratio = aspectRatioOf(style);
    // `height: auto` with a preferred aspect ratio and a definite width takes
    // that ratio's block size (CSS Sizing 4). Percentage insets of children
    // then resolve against it.
    const aspectHeight =
      forceContentHeight === undefined &&
      !isDefiniteBlockSize(declaredHeight, containingHeight) &&
      ratio !== null &&
      Number(contentWidth) > 0
        ? Number(contentWidth) / ratio
        : undefined;
    const definiteChildHeight =
      forceContentHeight !== undefined
        ? Math.max(0, forceContentHeight)
        : isDefiniteBlockSize(declaredHeight, containingHeight)
          ? Number(resolveHeight(style, px(0), padding, border, containingHeight))
          : aspectHeight;

    // `penY` is the border-bottom edge of the last in-flow content (in THIS
    // block's content coordinates); `pending` is the trailing collapsed-margin
    // chain — the value the next in-flow child's top margin collapses into.
    // Floats and positioned boxes touch neither (they are out of flow); the
    // chain also survives across a float (adjoining-ness is unaffected by
    // out-of-flow siblings, per spec).
    let penY = 0;
    let pending: number | null = null;
    // The first in-flow child whose top margin folded into this block's own
    // top margin (null when the slot is taken by an inline run / cleared
    // child / nothing). Compared by id — out-of-flow and boxless children
    // between it and its turn never match, so it can only fire once.
    const collapseWithParent = firstCollapseId;
    // Paint groups for the stacking pass (CSS2.1 Appendix E + z-index): 0 =
    // positioned children with negative z (paint under in-flow content), 1 =
    // normal flow + floats, 2 = positioned children with z ≥ 0 / auto.
    type ChildSlot = { kind: "frag"; id: FragmentId; group: 0 | 1 | 2; z: number };
    const childSlots: ChildSlot[] = [];
    // `sticky` children are laid out in-flow, then clamped between their
    // scroll thresholds and this block's content box once its height is known
    // (style kept to resolve %-insets against the FINAL content box).
    const stickyFixups: {
      fragId: FragmentId;
      staticBfcTop: number;
      staticBfcLeft: number;
      width: number;
      height: number;
      style: ComputedStyle | null;
    }[] = [];

    for (let ci = 0; ci < flatChildren.length; ci += 1) {
      const childNodeId = flatChildren[ci]!;
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
        while (ci < flatChildren.length) {
          const mId = flatChildren[ci]!;
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

        // The anonymous block wrapping the run has zero margins, so the chain
        // collapses to `pending` itself — the run's top edge lands at
        // `penY + pending` (≡ the previous margin-box bottom).
        const runTop = penY + (pending ?? 0);
        const runTopBfc = contentOriginBfcY + runTop;
        // Each line box shortens and shifts against the floats spanning its
        // own y (CSS 2.1 §9.5 line-box rule) — this is what "text wraps around
        // floats" means, including floats floated by ancestor siblings (the
        // registry is shared through non-BFC blocks).
        const narrowLine = (localY: number): { x0: number; x1: number } => {
          const r = bfc.intrusion(
            runTopBfc + localY,
            contentOriginBfcX,
            contentOriginBfcX + contentWidth,
          );
          return { x0: r.x0 - contentOriginBfcX, x1: r.x1 - contentOriginBfcX };
        };
        const dropSlot: { cap?: { side: "left" | "right"; width: number; height: number } } = {};
        inlineDropCap = dropSlot;
        const runFragments = layoutInlineRun(runIds, px(contentWidth), style, narrowLine);
        if (dropSlot.cap !== undefined) {
          bfc.placeFloat(
            dropSlot.cap.side,
            dropSlot.cap.width,
            dropSlot.cap.height,
            runTopBfc,
            contentOriginBfcX,
            contentOriginBfcX + contentWidth,
          );
        }
        let runHeight = 0;
        for (const frag of runFragments) {
          childSlots.push({
            kind: "frag",
            group: 1,
            z: 0,
            id: register(offsetFragment(frag, contentLeft, contentTop + runTop)),
          });
          runHeight = Math.max(runHeight, Number(frag.box.marginBox.height));
        }
        penY = runTop + runHeight;
        pending = null; // the anonymous block's zero margins add nothing.
        continue;
      }

      const float = childStyle === null ? "none" : readFloat(childStyle);
      const rawPosition = childStyle === null ? "static" : readPosition(childStyle);
      const stickySelf = childStyle !== null && childStyle["position"] === "sticky";
      const position = stickySelf ? "sticky" : rawPosition;

      // Out-of-flow children (§10.1): `absolute` queues on the nearest
      // containing-block frame (the stack top); `fixed` queues on the nearest
      // TRANSFORMED ancestor's frame, else the initial containing block
      // (frame 0 — the viewport). Neither advances `penY`/`pending`.
      if (position === "absolute" || position === "fixed") {
        let frame = absStack[absStack.length - 1]!;
        if (position === "fixed") {
          for (let fi = absStack.length - 1; fi >= 0; fi -= 1) {
            if (absStack[fi]!.capturesFixed) {
              frame = absStack[fi]!;
              break;
            }
            if (fi === 0) frame = absStack[0]!; // viewport
          }
          if (!frame.capturesFixed) frame = absStack[0]!;
        }
        frame.items.push({
          childNodeId,
          childStyle,
          fixed: position === "fixed",
          bfc,
          staticBfcX: contentOriginBfcX,
          staticBfcY: contentOriginBfcY + penY + (pending ?? 0),
        });
        continue;
      }

      if (float === "left" || float === "right") {
        const childFrag = layoutNode(childNodeId, contentWidth);
        if (childFrag === null) {
          continue;
        }
        const fw = Number(childFrag.box.marginBox.width);
        const fh = Number(childFrag.box.marginBox.height);
        // The float floats at the current flow position but descends while
        // the free width at that y cannot hold it (fit-or-drop); it pins to
        // THIS block's content edges — the containing block (§9.5.1). Its own
        // `clear` additionally forces it below matching floats.
        const floatClear = childStyle === null ? "none" : readClear(childStyle);
        let floatMinY = contentOriginBfcY + penY + (pending ?? 0);
        if (floatClear !== "none") {
          floatMinY = Math.max(floatMinY, bfc.clearanceY(floatClear));
        }
        const spot = bfc.placeFloat(
          float,
          fw,
          fh,
          floatMinY,
          contentOriginBfcX,
          contentOriginBfcX + contentWidth,
        );
        childSlots.push({
          kind: "frag",
          group: 1,
          z: 0,
          id: register(
            offsetFragment(
              childFrag,
              contentLeft + (spot.x - contentOriginBfcX),
              contentTop + (spot.y - contentOriginBfcY),
            ),
          ),
        });
        continue; // out of flow: neither penY nor pending changes.
      }

      const childMargin = childStyle === null ? ZERO_MARGIN : resolveMargin(childStyle);

      // The gap between the last in-flow border-bottom and this border top.
      // With no live chain the child's own top margin applies in full — unless
      // this is the first in-flow child collapsing through the parent's top
      // edge, in which case the joint margin already sits above the parent.
      let gap: number;
      if (pending === null) {
        gap = collapseWithParent === childNodeId ? 0 : childMargin.top;
      } else {
        gap = collapsedMargin(pending, childMargin.top);
      }
      let borderTop = penY + gap;

      // `clear` (§8.3.1 clearance): the border top is pushed below the matching
      // floats' bottoms; the collapsed margin above is kept.
      const clear = childStyle === null ? "none" : readClear(childStyle);
      if (clear !== "none") {
        const clearLocal = bfc.clearanceY(clear) - contentOriginBfcY;
        if (clearLocal > borderTop) {
          borderTop = clearLocal;
        }
      }
      let marginBoxTop = borderTop - childMargin.top;

      // Border-box narrowing (§9.5): a BFC-establishing or block-level-replaced
      // child's border box must not overlap floats — it shrinks to the free
      // interval and drops below them when nothing fits. A NORMAL block keeps
      // its full border box; only its line boxes shorten (inside its own
      // layout, via the shared BFC).
      const isReplaced = isReplacedElement(childNode);
      const childBfc = childStyle !== null && establishesBfc(childStyle);
      let childWidth = contentWidth;
      let marginBoxX = 0;
      if (childBfc || isReplaced) {
        let topBfc = contentOriginBfcY + borderTop;
        let free = bfc.intrusion(topBfc, contentOriginBfcX, contentOriginBfcX + contentWidth);
        if (free.x1 - free.x0 <= 0) {
          topBfc = bfc.fitY(
            contentOriginBfcY + borderTop,
            1,
            contentOriginBfcX,
            contentOriginBfcX + contentWidth,
          );
          free = bfc.intrusion(topBfc, contentOriginBfcX, contentOriginBfcX + contentWidth);
          borderTop = topBfc - contentOriginBfcY;
          marginBoxTop = borderTop - childMargin.top;
        }
        childWidth = px(Math.max(0, free.x1 - free.x0));
        marginBoxX = free.x0 - contentOriginBfcX;
      }

      const childFrag = layoutNode(
        childNodeId,
        px(childWidth),
        definiteChildHeight,
        undefined,
        { bfc, originX: contentOriginBfcX + marginBoxX, originY: contentOriginBfcY + marginBoxTop },
      );
      if (childFrag === null) {
        continue;
      }
      const childBorderBoxH = Number(childFrag.box.borderBox.height);

      let positioned = offsetFragment(childFrag, contentLeft + marginBoxX, contentTop + marginBoxTop);
      if (position === "relative") {
        // Percentage insets resolve against THIS box's content box (the
        // child's containing block), and only when that height is definite.
        const insets = readInsets(childStyle, contentWidth, definiteChildHeight ?? null);
        positioned = offsetFragment(positioned, insets.left, insets.top);
      }
      const childZ = childStyle === null ? 0 : readZIndex(childStyle);
      const childPos = position !== "static";
      childSlots.push({
        kind: "frag",
        group: childPos ? (childZ < 0 ? 0 : 2) : 1,
        z: childZ,
        id: register(positioned),
      });
      // `sticky` (CSS Position §3): in-flow normally; after this block's
      // content box resolves, the fragment is clamped between its scroll
      // threshold (vs `scrollY` — horizontal scroll unsupported, scrollX=0)
      // and the containing block's content box.
      if (stickySelf) {
        stickyFixups.push({
          fragId: childSlots[childSlots.length - 1]!.id,
          staticBfcTop: contentOriginBfcY + borderTop,
          staticBfcLeft: contentOriginBfcX + marginBoxX + childMargin.left,
          width: Number(childFrag.box.borderBox.width),
          height: childBorderBoxH,
          style: childStyle,
        });
      }

      // Margin-chain advance. An EMPTY in-flow block (zero border-box height —
      // auto height, no in-flow content, no border/padding) collapses its own
      // top and bottom margins into the chain WITHOUT consuming flow height:
      // it joins `pending` and `penY` stays at its border-top edge.
      const selfEmpty = !childBfc && childBorderBoxH === 0;
      if (selfEmpty) {
        pending =
          pending === null
            ? collapsedMargin(childMargin.top, childMargin.bottom)
            : collapsedMargin(collapsedMargin(pending, childMargin.top), childMargin.bottom);
      } else {
        penY = borderTop + childBorderBoxH;
        pending = childMargin.bottom;
      }
    }

    // In-flow content height: the last in-flow border-bottom — plus, for a BFC
    // root, the bottoms of the floats it CONTAINS (the "clearfix" behaviour:
    // a BFC grows to enclose its floats, CSS 2.1 §10.6.7). Float bottoms in a
    // shared BFC belong to the root's space and do not extend this block.
    const contentFlowHeight = Math.max(penY, shared === undefined ? bfc.floatsBottom() : 0);

    let contentHeight =
      forceContentHeight !== undefined
        ? px(Math.max(0, forceContentHeight))
        : aspectHeight !== undefined
          ? px(aspectHeight)
          : resolveHeight(style, px(contentFlowHeight), padding, border, containingHeight);
    if (maxHeight !== undefined) {
      const maxH = Math.max(0, maxHeight);
      if (Number(contentHeight) > maxH) {
        contentHeight = px(maxH);
      }
    }

    // ---- sticky constraint pass (CSS Position §3) --------------------------
    // A `sticky` child was laid out in-flow; now that this block's content
    // height is final, clamp it between its scroll threshold (measured from
    // the current `scrollY`) and the containing block's content box.
    for (const fix of stickyFixups) {
      const boundTop = contentOriginBfcY;
      const boundBottom = contentOriginBfcY + Number(contentHeight);
      const boundLeft = contentOriginBfcX;
      const boundRight = contentOriginBfcX + contentWidth;
      let newTop = fix.staticBfcTop;
      let newLeft = fix.staticBfcLeft;
      const insetT = readInsetValue(fix.style, "top", Number(contentHeight));
      const insetB = readInsetValue(fix.style, "bottom", Number(contentHeight));
      const insetL = readInsetValue(fix.style, "left", contentWidth);
      const insetR = readInsetValue(fix.style, "right", contentWidth);
      // Vertical thresholds pin against the scrolled viewport; horizontal
      // insets clamp statically (scrollX is not a render surface yet).
      if (insetT !== null) {
        newTop = Math.max(newTop, Math.min(scrollY + insetT, boundBottom - fix.height));
      }
      if (insetB !== null) {
        const cap = scrollY + Number(viewportHeight) - insetB - fix.height;
        newTop = Math.min(newTop, Math.max(cap, boundTop));
      }
      if (insetL !== null) {
        newLeft = Math.max(newLeft, Math.min(insetL, boundRight - fix.width));
      }
      if (insetR !== null) {
        const cap = Number(viewportWidth) - insetR - fix.width;
        newLeft = Math.min(newLeft, Math.max(cap, boundLeft));
      }
      const dy = newTop - fix.staticBfcTop;
      const dx = newLeft - fix.staticBfcLeft;
      if (Math.abs(dy) > 1e-9 || Math.abs(dx) > 1e-9) {
        const frag = fragments.get(fix.fragId);
        if (frag !== undefined) {
          fragments.set(fix.fragId, offsetFragment(frag, dx, dy));
        }
      }
    }

    // ---- containing-block drain (CSS 2.1 §10.1) ----------------------------
    // If this block OWNS a containing-block frame, the absolute children that
    // queued during the walk now resolve against this (final) padding box.
    // Their static position is expressed in the BFC they were encountered in —
    // identical to this block's frame unless an inner BFC root intervened.
    if (isCbOwner) {
      const mine = absStack.pop()!;
      const padCbW = contentWidth + padding.left + padding.right;
      const padCbH = Number(contentHeight) + padding.top + padding.bottom;
      for (const item of mine.items) {
        const sameBfc = item.bfc === bfc;
        const staticLeft = sameBfc
          ? item.staticBfcX - contentOriginBfcX + contentLeft
          : contentLeft;
        const staticTop = sameBfc
          ? item.staticBfcY - contentOriginBfcY + contentTop
          : contentTop + Number(contentHeight);
        const placed = placeAbsoluteFragment(
          (id2, w2, ch2, fh2) => layoutNode(id2, w2, ch2, fh2),
          item.childNodeId,
          item.childStyle,
          padCbW,
          padCbH,
          border.left,
          border.top,
          staticLeft,
          staticTop,
          (fid) => fragments.get(fid),
        );
        const z = item.childStyle === null ? 0 : readZIndex(item.childStyle);
        childSlots.push({
          kind: "frag",
          group: z < 0 ? 0 : 2,
          z,
          id: register(
            placed ?? {
              node: item.childNodeId,
              box: buildBoxAtOrigin(ZERO_MARGIN, px(0), px(0)),
              children: [],
            },
          ),
        });
      }
    }

    // Stacking order (CSS2.1 App. E): negative-z positioned descendants first
    // (under in-flow content), normal flow next, z≥0 positioned last — sorted
    // by z ascending inside each group, stably (DOM order preserved within a
    // level). Fragment `children` order IS the paint order.
    const childIds = childSlots
      .slice()
      .sort((a, b) => a.group - b.group || a.z - b.z)
      .map((slot) => slot.id);

    // ---- parent/last-child bottom-margin collapse (CSS 2.1 §8.3.1) ---------
    // With auto height and no bottom border/padding (and not a BFC root), the
    // trailing margin chain folds into this block's own bottom margin. The
    // children's geometry is untouched — the child's margin simply rides
    // inside this block's enlarged bottom margin.
    const heightIsAuto =
      forceContentHeight === undefined &&
      aspectHeight === undefined &&
      !isDefiniteBlockSize(style["height"], containingHeight) &&
      maxHeight === undefined;
    const marginBottomEff =
      shared !== undefined &&
      heightIsAuto &&
      border.bottom === 0 &&
      padding.bottom === 0 &&
      pending !== null
        ? px(collapsedMargin(margin.bottom, pending))
        : margin.bottom;

    const box = buildBoxAtOrigin(
      { top: marginTopEff, right: margin.right, bottom: marginBottomEff, left: margin.left },
      contentWidth,
      contentHeight,
      padding,
      border,
    );
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
  function scriptAt(fontSize: number, font?: ShapingFont): { sub?: number; super?: number } {
    const metrics = shaper.fontMetrics?.(font ?? { fontSize: px(fontSize) });
    const out: { sub?: number; super?: number } = {};
    if (metrics?.subscriptEm !== undefined) out.sub = metrics.subscriptEm * fontSize;
    if (metrics?.superscriptEm !== undefined) out.super = metrics.superscriptEm * fontSize;
    return out;
  }

  function reportedXHeight(style: ComputedStyle): number | undefined {
    const em = shaper.fontMetrics?.({
      fontSize: style.fontSize,
      fontWeight: readFontWeight(style),
      css: fontSelection(style),
      ...directionProp(style),
    })?.xHeightEm;
    return em === undefined ? undefined : em * Number(style.fontSize);
  }

  function xHeightSpread(xHeight: number | undefined): { xHeight: number } | Record<string, never> {
    return xHeight === undefined ? {} : { xHeight };
  }

  function layoutInlineRun(
    runIds: readonly NodeId[],
    containingWidth: Px,
    containerStyle: ComputedStyle,
    narrowLine?: (localY: number) => { x0: number; x1: number },
  ): Fragment[] {
    // The block that owns the pseudo, when this run is a nested inline.
    const pseudoSource = ancestorPseudo ?? containerStyle;
    if (runIds.length === 0) {
      return [];
    }

    // A member is either a TEXT run (shaped word by word) or an ATOMIC box
    // (inline-block / inline element laid out via layoutNode, an indivisible
    // unit that flows within the line).
    interface TextMember {
      readonly kind: "text";
      readonly nodeId: NodeId;
      /** Outer-to-inner `display: inline` elements whose text this run is. */
      readonly wrapperNodeIds?: readonly NodeId[];
      readonly words: readonly string[]; // the line-break units' text.
      /** Per-unit: a real whitespace gap precedes it (the packer adds the
       *  space advance); unit boundaries alone never imply a space. */
      readonly spaces: readonly boolean[];
      /** Per-unit: a soft-hyphen break follows it — a wrap there shows a
       *  visible `-` at the line end (`hyphens` ≠ none). */
      readonly shyAfter: readonly boolean[];
      readonly font: ShapingFont;
      readonly letterSpacing: number;
      readonly spaceAdvance: number; // one inter-word space (incl. word-spacing).
      readonly wordWidths: readonly number[];
      readonly lineHeight: number; // px of one line box for this member's font.
      readonly wraps: boolean;
      readonly canBreakWord: boolean;
      /** Word-index → count of `\n` breaks BEFORE it (`pre*` newlines).
       *  Breaks past the last word sit at key `words.length` (trailing `\n`
       *  produces a final empty line per CSS Text §4.1). */
      readonly hardBreaks: ReadonlyMap<number, number>;
      /** Em ascent in px for baseline alignment (`ascentEm` × fontSize). */
      readonly ascent: number;
      readonly perCharWidths?: readonly number[];
      /** `vertical-align` of this text run. Baseline (the initial) does not shift it. */
      readonly valign: VerticalAlign;
      /** Full x-height in px when the shaper reported one. */
      readonly xHeight?: number;
    }
    interface AtomicMember {
      readonly kind: "atomic";
      readonly nodeId: NodeId;
      readonly frag: Fragment; // laid out box (width is definite).
      readonly valign: VerticalAlign;
      readonly fontSize: number; // for middle/sub/super offsets.
      /** Margin-box-top → the box's BASELINE (§10.8.1): an inline-block /
       *  replaced box with no in-flow text uses its bottom margin edge; a
       *  box WITH text (or a plain `inline` element's strut) sits its
       *  baseline at content-top + ascent — which keeps ordinary inline
       *  content on the parent baseline unchanged. */
      readonly baselineOff: number;
      /** Full x-height in px when the shaper reported one. */
      readonly xHeight?: number;
    }
    interface EmptyMember {
      readonly kind: "empty";
      readonly nodeId: NodeId; // whitespace-only text: contributes a zero box.
    }
    type Member = TextMember | AtomicMember | EmptyMember;

    // ---- prepare members ---------------------------------------------------
    // Text members defer word emission: bidi ordering is resolved ONCE over the
    // whole run (the paragraph), because runs span sibling text nodes and flow
    // AROUND atomic inline boxes (each atomic feeds a U+FFFC object character).
    interface PreText {
      readonly kind: "preText";
      readonly nodeId: NodeId;
      readonly wrapperNodeIds?: readonly NodeId[];
      readonly text: string;
      readonly font: ShapingFont;
      readonly letterSpacing: number;
      readonly spaceAdvance: number;
      readonly lineHeight: number;
      readonly wraps: boolean;
      readonly canBreakWord: boolean;
      /** CSS Text break keywords for {@link breakUnits} (`word-break` /
       *  `line-break` / `overflow-wrap` / `hyphens`). */
      readonly breakOpts: BreakOptions;
      readonly preserveNewlines: boolean;
      readonly ascent: number;
      readonly valign?: VerticalAlign;
    }
    type PreMember = PreText | AtomicMember;
    const pre: PreMember[] = [];
    // Collapsible whitespace ahead of the first box is not content, so
    // `::first-letter` still reaches the next inline. A preserved newline is
    // an empty first line and does block it.
    const inlineChainAlign = (wrappers: readonly NodeId[]): VerticalAlign => {
      for (let i = wrappers.length - 1; i >= 0; i -= 1) {
        const align = readVerticalAlign(activeStyleOf(wrappers[i]!));
        if (align.kind !== "baseline") return align;
      }
      return { kind: "baseline" };
    };
    const flattenInline = (
      elementId: NodeId,
    ): { textId: NodeId; text: string; wrappers: NodeId[] } | undefined => {
      const el = dom.nodes.get(elementId);
      if (el === undefined || el.kind !== "element") return undefined;
      const st = activeStyleOf(elementId);
      if (st["display"] !== "inline" || isReplacedElement(el)) return undefined;
      const kids = contentChildren(el);
      if (kids.length !== 1) return undefined;
      const child = dom.nodes.get(kids[0]!);
      if (child === undefined) return undefined;
      if (child.kind === "text") {
        return { textId: child.id, text: child.text ?? "", wrappers: [elementId] };
      }
      if (child.kind !== "element") return undefined;
      const inner = flattenInline(child.id);
      if (inner === undefined) return undefined;
      return { textId: inner.textId, text: inner.text, wrappers: [elementId, ...inner.wrappers] };
    };
    const letterStillOpen = (): boolean => {
      for (const item of pre) {
        if (item.kind !== "preText") return false;
        if (item.preserveNewlines) return false;
        if (item.text.trim().length > 0) return false;
      }
      return true;
    };
    let runWraps = true; // default; tightened by the first text member's white-space.
    let runWrapsSeen = false;
    for (const memberId of runIds) {
      const node = dom.nodes.get(memberId);
      if (node === undefined || node.kind === "comment") {
        continue;
      }
      if (node.kind === "text") {
        const content = node.text ?? "";
        const style = activeStyleOf(node.id);
        const fontSize = style.fontSize;
        const font: ShapingFont = {
          fontSize,
          fontWeight: readFontWeight(style),
          css: fontSelection(style),
          ...directionProp(style),
        };
        const letterSpacing = readSpacing(style["letterSpacing"]);
        const wordSpacing = readSpacing(style["wordSpacing"]);
        const spaceAdvance = shapeWordUnits(shaper, " ", font, 0).advance + wordSpacing;
        const wraps = whiteSpaceWraps(readWhiteSpace(style));
        if (!runWrapsSeen) {
          runWraps = wraps;
          runWrapsSeen = true;
        } else {
          runWraps = runWraps && wraps; // any nowrap member tightens the run.
        }
        const overflowWrap = typeof style["overflowWrap"] === "string" ? style["overflowWrap"] : "normal";
        const canBreakWord = overflowWrap === "break-word" || overflowWrap === "anywhere";
        pre.push({
          kind: "preText",
          nodeId: memberId,
          text: content,
          font,
          letterSpacing,
          spaceAdvance,
          lineHeight: readLineHeight(style) * fontSize,
          wraps,
          canBreakWord,
          breakOpts: breakOptionsOf(style),
          preserveNewlines: whiteSpaceKeepsNewlines(readWhiteSpace(style)),
          ascent: (font.ascentEm ?? 0.8) * fontSize,
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
        const memberKids = node !== undefined ? contentChildren(node) : [];
        const textChild =
          node !== undefined && node.kind === "element" && memberKids.length === 1
            ? dom.nodes.get(memberKids[0]!)
            : undefined;
        const flat = flattenInline(memberId);
        if (flat !== undefined) {
          const textStyle = activeStyleOf(flat.textId);
          const textSize = Number(textStyle.fontSize);
          const textFont: ShapingFont = {
            fontSize: textStyle.fontSize,
            fontWeight: readFontWeight(textStyle),
            css: fontSelection(textStyle),
            ...directionProp(textStyle),
          };
          pre.push({
            kind: "preText",
            nodeId: flat.textId,
            wrapperNodeIds: flat.wrappers,
            text: flat.text,
            font: textFont,
            letterSpacing: readSpacing(textStyle["letterSpacing"]),
            spaceAdvance: shapeWordUnits(shaper, " ", textFont, 0).advance + readSpacing(textStyle["wordSpacing"]),
            lineHeight: readLineHeight(textStyle) * textSize,
            wraps: whiteSpaceWraps(readWhiteSpace(textStyle)),
            canBreakWord: textStyle["overflowWrap"] === "break-word" || textStyle["overflowWrap"] === "anywhere",
            breakOpts: breakOptionsOf(textStyle),
            preserveNewlines: whiteSpaceKeepsNewlines(readWhiteSpace(textStyle)),
            ascent: (textFont.ascentEm ?? 0.8) * textSize,
            ...(() => {
              const align = inlineChainAlign(flat.wrappers);
              return align.kind === "baseline" ? {} : { valign: align };
            })(),
          });
          continue;
        }
        if (textChild !== undefined && textChild.kind === "text") {
          const st = activeStyleOf(memberId);
          const fontSize = st.fontSize;
          const font: ShapingFont = {
            fontSize,
            fontWeight: readFontWeight(st),
            css: fontSelection(st),
            ...directionProp(st),
          };
          const units = visualTokens(
            textChild.text ?? "",
            font.direction,
            whiteSpaceKeepsNewlines(readWhiteSpace(st)),
            null,
            breakOptionsOf(st),
          ).units;
          const letterSpacing = readSpacing(st["letterSpacing"]);
          const from = ancestorPseudo ?? containerStyle;
          const carry =
            letterStillOpen() &&
            st["display"] === "inline" &&
            node !== undefined &&
            !isReplacedElement(node) &&
            hasFirstPseudo(from);
          let w = 0;
          let firstUnit = true;
          let letterPending = carry;
          const letterPx = carry ? readFirstLetterSize(from) : undefined;
          const linePx = carry ? readFirstLineSize(from) : undefined;
          const letterTrack = carry ? readSpacingField(from, "firstLetterLetterSpacing") : undefined;
          const lineTrack = carry ? readSpacingField(from, "firstLineLetterSpacing") : undefined;
          for (const u of units) {
            if (!firstUnit && u.spaceBefore) {
              const spaceFont = linePx !== undefined ? { ...font, fontSize: px(linePx) } : font;
              w += shapeWordUnits(shaper, " ", spaceFont, 0).advance;
            }
            let word = u.text;
            if (letterPending) {
              const end = firstLetterUnits(word);
              const head = word.slice(0, end);
              word = word.slice(end);
              if (head.length > 0) {
                const headSize = letterPx ?? linePx;
                const headFont = headSize !== undefined ? { ...font, fontSize: px(headSize) } : font;
                const headMargin = carry ? readBoxEdges(from, "firstLetterMargin") : undefined;
                const headPad = carry ? readBoxEdges(from, "firstLetterPadding") : undefined;
                const headBorder = carry ? readLetterBorder(from) : undefined;
                w += (headMargin?.left ?? 0) + (headMargin?.right ?? 0);
                w += (headPad?.left ?? 0) + (headPad?.right ?? 0);
                w += drawnBorderWidth(headBorder?.left) + drawnBorderWidth(headBorder?.right);
                w += shapeWordUnits(shaper, head, headFont, letterTrack ?? lineTrack ?? letterSpacing).advance;
              }
              letterPending = false;
            }
            if (word.length > 0) {
              const use = linePx !== undefined ? { ...font, fontSize: px(linePx) } : font;
              w += shapeWordUnits(shaper, word, use, lineTrack ?? letterSpacing).advance;
            }
            firstUnit = false;
          }
          const owned = carry && ancestorPseudo === undefined;
          if (owned) ancestorPseudo = from;
          let frag: Fragment | null;
          try {
            frag = layoutNode(memberId, px(Math.max(1, w)));
          } finally {
            if (owned) ancestorPseudo = undefined;
          }
          if (frag === null) {
            continue;
          }
          pre.push({
            kind: "atomic", nodeId: memberId, frag,
            valign: readVerticalAlign(st),
            fontSize: Number(st.fontSize),
            baselineOff: st["display"] === "ruby" ? rubyBaselineOff(frag) : atomicBaselineOff(frag, st, true),
            ...xHeightSpread(reportedXHeight(st)),
          });
        } else {
          const stForCarry = activeStyleOf(memberId);
          const from = ancestorPseudo ?? containerStyle;
          const carry =
            letterStillOpen() &&
            stForCarry["display"] === "inline" &&
            node !== undefined &&
            !isReplacedElement(node) &&
            hasFirstPseudo(from);
          const owned = carry && ancestorPseudo === undefined;
          if (owned) ancestorPseudo = from;
          let frag: Fragment | null;
          try {
            frag = layoutNode(memberId, containingWidth);
          } finally {
            if (owned) ancestorPseudo = undefined;
          }
          if (frag === null) {
            continue;
          }
          const st = activeStyleOf(memberId);
          const specAtomic =
            st["display"] === "inline-block" ||
            (node !== undefined && node !== null && isReplacedElement(node));
          pre.push({
            kind: "atomic", nodeId: memberId, frag,
            valign: readVerticalAlign(st),
            fontSize: Number(st.fontSize),
            baselineOff: st["display"] === "ruby" ? rubyBaselineOff(frag) : atomicBaselineOff(frag, st, !specAtomic),
            ...xHeightSpread(reportedXHeight(st)),
          });
        }
      }
    }
    if (pre.length === 0) {
      return [];
    }

    // ---- paragraph-level bidi resolution ------------------------------------
    // The run's text members + atomic boxes are ONE paragraph: the combined
    // stream resolves direction once (text pieces carry their owner's index;
    // atomics contribute a U+FFFC object character; the container's own
    // `unicode-bidi` injects explicit-format codes at the edges — UAX #9 X
    // rules / CSS `bidi-override`/`isolate-override`). Paragraph direction is
    // the container's computed `direction`; `dir=auto` and
    // `unicode-bidi:plaintext` resolve per-paragraph first-strong instead.
    const containerNodeId = dom.nodes.get(runIds[0]!)?.parent ?? null;
    const containerNode =
      containerNodeId !== null ? dom.nodes.get(containerNodeId) : undefined;
    const containerDirAttr = containerNode?.attrs?.get("dir")?.toLowerCase();
    const ubidi = unicodeBidiKeyword(containerStyle);
    const baseOverride: "ltr" | "rtl" | undefined =
      containerDirAttr === "auto" || ubidi === "plaintext"
        ? undefined
        : readDirection(containerStyle);
    const wrap = containerBidiWrap(containerStyle, ubidi);
    // Flattened inlines (`<bdo>`, `<bdi>`) keep their element ids on the text
    // member. Wrap that text in the element's own embedding so the paragraph
    // resolver sees the override or isolate, not only the block container's.
    const wrapInlineBidi = (text: string, wrappers: readonly NodeId[] | undefined): string => {
      if (wrappers === undefined || wrappers.length === 0) return text;
      let open = "";
      let close = "";
      for (const id of wrappers) {
        const st = activeStyleOf(id);
        const ubidi = unicodeBidiKeyword(st);
        const explicit = containerBidiWrap(st, ubidi);
        const dirAttr = dom.nodes.get(id)?.attrs?.get("dir")?.toLowerCase();
        const c = String.fromCodePoint;
        const wrap = explicit ?? (ubidi === "isolate"
          ? dirAttr === "auto"
            ? { open: c(BIDI_CTRL.FSI), close: c(BIDI_CTRL.PDI) }
            : readDirection(st) === "rtl"
              ? { open: c(BIDI_CTRL.RLI), close: c(BIDI_CTRL.PDI) }
              : { open: c(BIDI_CTRL.LRI), close: c(BIDI_CTRL.PDI) }
          : null);
        if (wrap === null) continue;
        open += wrap.open;
        close = wrap.close + close;
      }
      return open + text + close;
    };
    const pieces: BidiPiece[] = [];
    if (wrap !== null) pieces.push({ text: wrap.open });
    const ownerOf = new Map<number, number>(); // piece index → pre-member index
    for (let m = 0; m < pre.length; m += 1) {
      const p = pre[m]!;
      ownerOf.set(pieces.length, m);
      pieces.push({
        text:
          p.kind === "preText"
            ? wrapInlineBidi(
                p.preserveNewlines ? p.text : p.text.replace(/[\n\r\f]/g, " "),
                p.wrapperNodeIds,
              )
            : "�",
      });
    }
    if (wrap !== null) pieces.push({ text: wrap.close });
    const parts = visualOrderParts(pieces, baseOverride);

    // ---- emit members in visual order ---------------------------------------
    // Parts arrive grouped per level-run; an odd-level run's word order is
    // right-to-left, so its owner parts (and each part's words) are emitted in
    // reverse. A text member may surface as several chunks (one per level-run
    // fragment it contributes) — each chunk is its own TextMember sharing the
    // source nodeId.
    const members: Member[] = [];
    let pendingBreaks = 0;
    let pendingCarrier: PreText | null = null;
    let lastBreaks: Map<number, number> | null = null;
    let lastWordCount = 0;
    // Whether the previously EMITTED part ended in whitespace — the boundary
    // space between parts folds onto the next text part's first unit.
    let prevPartEndsWs = false;
    const emitTextChunk = (
      t: PreText,
      units: readonly BreakUnit[],
      breaks: Map<number, number>,
    ): void => {
      // `units` are maximal unbreakable spans — `break-all`/`anywhere` already
      // produced one unit per character inside `breakUnits`.
      const ws = units.map((u) => u.text);
      units.forEach((u, ui) => {
        if (u.hardBreaksBefore > 0) {
          breaks.set(ui, (breaks.get(ui) ?? 0) + u.hardBreaksBefore);
        }
      });
      members.push({
        kind: "text",
        nodeId: t.nodeId,
        ...(t.wrapperNodeIds !== undefined ? { wrapperNodeIds: t.wrapperNodeIds } : {}),
        words: ws,
        spaces: units.map((u) => u.spaceBefore),
        shyAfter: units.map((u) => u.shyAfter),
        font: t.font,
        letterSpacing: t.letterSpacing,
        spaceAdvance: t.spaceAdvance,
        wordWidths: ws.map(
          (word) => shapeWordUnits(shaper, word, t.font, t.letterSpacing).advance,
        ),
        lineHeight: t.lineHeight,
        wraps: t.wraps,
        canBreakWord: t.canBreakWord,
        hardBreaks: breaks,
        ascent: t.ascent,
        valign: t.valign ?? readVerticalAlign(activeStyleOf(t.nodeId)),
        ...xHeightSpread(reportedXHeight(activeStyleOf(t.nodeId))),
      });
      lastBreaks = breaks;
      lastWordCount = ws.length;
    };
    // Group the part stream into maximal same-level runs (a run boundary is a
    // level change or a hard break); emit each run's parts in its visual order.
    let ri = 0;
    while (ri < parts.length) {
      const first = parts[ri]!;
      if (first.hardBreak === true) {
        pendingBreaks += 1;
        prevPartEndsWs = false;
        const own = pre[ownerOf.get(first.owner) ?? -1];
        if (own !== undefined && own.kind === "preText") {
          pendingCarrier = own;
        }
        ri += 1;
        continue;
      }
      let rEnd = ri;
      while (
        rEnd + 1 < parts.length &&
        parts[rEnd + 1]!.hardBreak !== true &&
        parts[rEnd + 1]!.level === first.level
      ) {
        rEnd += 1;
      }
      const group = parts.slice(ri, rEnd + 1);
      const ordered = first.level % 2 === 1 ? group.slice().reverse() : group;
      for (const part of ordered) {
        const p = pre[ownerOf.get(part.owner) ?? -1];
        if (p === undefined) {
          continue;
        }
        if (p.kind === "atomic") {
          // A hard break before an atomic still has to break the line: park it
          // on a zero-word text member (its trailing-break slot fires it).
          if (pendingBreaks > 0) {
            const carrier =
              pendingCarrier !== null && pendingCarrier !== undefined
                ? pendingCarrier
                : pre.find((q): q is PreText => q.kind === "preText");
            if (carrier !== undefined) {
              emitTextChunk(carrier, [], new Map([[0, pendingBreaks]]));
              pendingBreaks = 0;
            }
          }
          members.push(p);
          prevPartEndsWs = false;
        } else {
          const breaks = new Map<number, number>();
          if (pendingBreaks > 0) {
            breaks.set(0, pendingBreaks);
            pendingBreaks = 0;
          }
          let units = breakUnits(part.text, p.breakOpts);
          if (first.level % 2 === 1) units = reverseUnits(units);
          // The space at a PART boundary belongs to neither part's own unit
          // stream: it lives in the whitespace run one side or the other
          // carried. Fold it onto this part's first unit.
          if (units.length > 0 && (prevPartEndsWs || /^\s/.test(part.text))) {
            const u0 = units[0]!;
            units = [
              {
                text: u0.text,
                spaceBefore: true,
                hardBreaksBefore: u0.hardBreaksBefore,
                shyAfter: u0.shyAfter,
              },
              ...units.slice(1),
            ];
          }
          prevPartEndsWs = /\s$/.test(part.text);
          if (units.length === 0 && breaks.size === 0) continue;
          emitTextChunk(p, units, breaks);
        }
      }
      ri = rEnd + 1;
    }
    // Trailing hard breaks produce extra empty lines on the last text chunk.
    const lb = lastBreaks as Map<number, number> | null;
    if (pendingBreaks > 0 && lb !== null) {
      lb.set(lastWordCount, (lb.get(lastWordCount) ?? 0) + pendingBreaks);
    }
    // Text pre-members that produced no words (whitespace-only) contribute
    // their zero boxes, in document order.
    const emittedOwners = new Set<NodeId>();
    for (const m of members) {
      if (m.kind === "text") emittedOwners.add(m.nodeId);
    }
    for (const p of pre) {
      if (p.kind === "preText" && !emittedOwners.has(p.nodeId)) {
        members.push({ kind: "empty", nodeId: p.nodeId });
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
    // `::first-letter` / `::first-line` stay on this packer: `layoutInline` has
    // one font-size for the whole run, so it cannot size the first code point
    // or the first line on their own. Every other single-text run keeps the
    // historical path.
    if (
      members.length === 1 &&
      textMembers.length === 1 &&
      members[0]!.kind === "text" &&
      (members[0]!.wrapperNodeIds?.length ?? 0) === 0 &&
      !hasFirstPseudo(pseudoSource)
    ) {
      const node = dom.nodes.get(members[0]!.nodeId);
      if (node !== undefined && node.kind === "text") {
        return [layoutInline(node, containingWidth, containerStyle, narrowLine, containerNode)];
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
    // Text/strut-only line heights — `lineHeights` additionally absorbs atomic
    // margin-box heights (they size the line pre-alignment), but §10.8's
    // grown-box floor must come from text metrics alone: an aligned atomic's
    // real bottom edge is `baseline + descent`, not `top + height`, and using
    // the atomic-inflated height as the floor double-counts the atomic.
    const lineTextHeights: number[] = [0];
    // Per-line text baseline offset (max member ascent) — `vertical-align`
    // on atomic boxes resolves against it (CSS 2.1 §10.8.1).
    const lineAscents: number[] = [0];
    let lineIndex = 0;
    // `curLineTop` is the run-local y of the CURRENT line's top edge — final
    // line heights accumulate as lines close, so the current line's top is
    // always known while it fills. The current line's free interval comes
    // from the BFC float registry via `narrowLine` (absent ⇒ the whole
    // containing width, byte-for-byte the old behaviour). `text-indent`
    // (CSS Text §3.6) shrinks ONLY the first line's start edge.
    const textIndent = readTextIndent(containerStyle, Number(containingWidth));
    const indentRtl = containerStyle["direction"] === "rtl";
    let curLineTop = 0;
    // A floated `::first-letter` is removed from the line and shortens every
    // line it still covers. It is local to this run: following blocks do not
    // wrap around it, and it is not carried into an atomic inline.
    let dropCap: { side: "left" | "right"; width: number; height: number } | undefined;
    let letterFrame: LetterFrame | undefined;
    let letterFill: LetterFill | undefined;
    let letterImageFrame: LetterImageFrame | undefined;
    const letterDecorations: LetterDecoration[] = [];
    const curSpan = (): { x0: number; x1: number } => {
      const span =
        narrowLine === undefined
          ? { x0: 0, x1: Number(containingWidth) }
          : narrowLine(curLineTop);
      let x0 = span.x0;
      let x1 = span.x1;
      if (lineIndex === 0 && textIndent !== 0) {
        if (indentRtl) x1 -= textIndent;
        else x0 += textIndent;
      }
      if (dropCap !== undefined && curLineTop < dropCap.height - 0.001) {
        if (dropCap.side === "left") x0 += dropCap.width;
        else x1 -= dropCap.width;
      }
      return { x0, x1 };
    };
    let penX = curSpan().x0;
    let lineHasAny = false;
    // `::first-letter` sizes, colors, and may float the first letter.
    // `::first-line` sizes and colors line 0. A left/right float shortens the
    // lines it covers; it does not grow those line boxes.
    const firstLetterPx = readFirstLetterSize(pseudoSource);
    const firstLinePx = readFirstLineSize(pseudoSource);
    const firstLetterColor = readPaintColor(pseudoSource, "firstLetterColor");
    const firstLineColor = readPaintColor(pseudoSource, "firstLineColor");
    const firstLetterFloat =
      ancestorPseudo === undefined ? readFirstLetterFloat(pseudoSource) : undefined;
    const firstLetterWeight = readWeightField(pseudoSource, "firstLetterFontWeight");
    const firstLineWeight = readWeightField(pseudoSource, "firstLineFontWeight");
    const firstLetterStyle = readStyleField(pseudoSource, "firstLetterFontStyle");
    const firstLineStyle = readStyleField(pseudoSource, "firstLineFontStyle");
    const firstLetterTransform = readTransformField(pseudoSource, "firstLetterTextTransform");
    const firstLineTransform = readTransformField(pseudoSource, "firstLineTextTransform");
    const firstLetterWordSpacing = readSpacingField(pseudoSource, "firstLetterWordSpacing");
    const firstLineWordSpacing = readSpacingField(pseudoSource, "firstLineWordSpacing");
    const firstLetterLineHeight = readSpacingField(pseudoSource, "firstLetterLineHeight");
    const firstLineLineHeight = readSpacingField(pseudoSource, "firstLineLineHeight");
    const firstLetterValign = readAlignField(pseudoSource);
    const firstLetterDecoration = readDecorationField(pseudoSource, "firstLetterTextDecoration");
    const firstLineDecoration = readDecorationField(pseudoSource, "firstLineTextDecoration");
    const firstLetterSpacing = readSpacingField(pseudoSource, "firstLetterLetterSpacing");
    const firstLineSpacing = readSpacingField(pseudoSource, "firstLineLetterSpacing");
    const firstLetterMargin = readBoxEdges(pseudoSource, "firstLetterMargin");
    const firstLetterPadding = readBoxEdges(pseudoSource, "firstLetterPadding");
    const firstLetterBorder = readLetterBorder(pseudoSource);
    const firstLetterBackground = readPaintColor(pseudoSource, "firstLetterBackgroundColor");
    const firstLineBackground = readPaintColor(pseudoSource, "firstLineBackgroundColor");
    const firstLetterImage = readLetterImage(pseudoSource, "firstLetterBackgroundImage");
    const firstLineImage = readLetterImage(pseudoSource, "firstLineBackgroundImage");
    let letterConsumed = false;
    let letterRestY = 0;

    const placeWord = (
      _member: TextMember,
      word: string,
      startX: number,
      glyphY: number,
      font: ShapingFont,
      markSize: boolean,
      color: Color | undefined,
      fontWeight: number | undefined,
      spacing: number,
      fontStyle?: "normal" | "italic" | "oblique",
    ): LaidGlyph[] =>
      shapeWordUnits(shaper, word, font, spacing).glyphs.map((g) => ({
        glyphId: g.glyphId,
        faceIndex: g.faceIndex,
        x: px(startX + g.dx),
        y: px(glyphY + g.dy),
        advance: px(g.advance),
        ...(markSize ? { fontSize: font.fontSize } : {}),
        ...(color !== undefined ? { color } : {}),
        ...(fontWeight !== undefined ? { fontWeight } : {}),
        ...(fontStyle !== undefined ? { fontStyle } : {}),
      }));
    const closeLine = (): void => {
      curLineTop += lineHeights[lineIndex]!;
      lineWidths.push(0);
      lineHeights.push(0);
      lineTextHeights.push(0);
      lineAscents.push(0);
      lineIndex += 1;
      penX = curSpan().x0;
    };
    const startNewLineIfNeeded = (nextWidth: number): boolean => {
      // Wrap when the next unit would overflow AND the line already has content.
      if (runWraps && lineHasAny && penX + nextWidth > curSpan().x1) {
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
        const fireHardBreaks = (count: number): void => {
          for (let b = 0; b < count; b += 1) {
            lineHeights[lineIndex] = Math.max(lineHeights[lineIndex]!, member.lineHeight);
            lineTextHeights[lineIndex] = Math.max(lineTextHeights[lineIndex]!, member.lineHeight);
            lineAscents[lineIndex] = Math.max(lineAscents[lineIndex]!, member.ascent);
            flushLine();
            closeLine();
            lineHasAny = false; // the new line starts empty.
          }
        };
        let runWords = member.words;
        let runWidths = member.wordWidths;
        let runSpaces = member.spaces;
        let runShy = member.shyAfter;
        let runBreaks = member.hardBreaks;
        if (!letterConsumed && (firstLetterPx !== undefined || firstLetterColor !== undefined || firstLetterFloat !== undefined || firstLetterWeight !== undefined || firstLetterStyle !== undefined || firstLetterTransform !== undefined || firstLetterWordSpacing !== undefined || firstLetterLineHeight !== undefined || firstLetterValign !== undefined || firstLetterDecoration !== undefined || firstLetterSpacing !== undefined || firstLetterMargin !== undefined || firstLetterPadding !== undefined || firstLetterBorder !== undefined || firstLetterBackground !== undefined || firstLetterImage !== undefined)) {
          const word0 = runWords[0];
          if (word0 !== undefined && word0.length > 0 && (runBreaks.get(0) ?? 0) === 0) {
            letterConsumed = true;
            // Punctuation that immediately precedes or follows the first letter
            // or digit is part of `::first-letter` (CSS Pseudo-Elements). A word
            // with no letter still peels one code point, so a symbol such as an
            // emoji keeps the previous behaviour.
            const end = firstLetterUnits(word0);
            const ch = applyTextTransform(word0.slice(0, end), firstLetterTransform ?? firstLineTransform);
            const rest = applyTextTransform(word0.slice(end), firstLineTransform);
            const lead =
              runSpaces[0] === true && penX > curSpan().x0 ? member.spaceAdvance : 0;
            const originX = penX + lead;
            const bodySize = Number(member.font.fontSize);
            const letterSize = firstLetterPx ?? bodySize;
            const letterWeight = firstLetterWeight ?? firstLineWeight;
            const letterStyle = firstLetterStyle ?? firstLineStyle;
            const letterFont: ShapingFont = {
              ...member.font,
              fontSize: px(letterSize),
              ...(letterWeight !== undefined ? { fontWeight: letterWeight } : {}),
              ...(letterStyle !== undefined ? { css: { ...member.font.css, style: letterStyle } } : {}),
            };
            const shaped = shapeWordUnits(
              shaper,
              ch,
              letterFont,
              firstLetterSpacing ?? firstLineSpacing ?? member.letterSpacing,
            );
            const bodyAscent = member.ascent;
            const ascentEm = bodySize > 0 ? bodyAscent / bodySize : 0.8;
            const letterAscent = ascentEm * letterSize;
            // The rest of line 0 is the first-line font when that rule exists,
            // otherwise the element's own font.
            const restPx = firstLinePx ?? bodySize;
            const restAscent = ascentEm * restPx;
            const baseline = Math.max(letterAscent, restAscent);
            let letterY = baseline - letterAscent;
            letterY += letterValignShift(firstLetterValign, letterSize, scriptAt(letterSize, letterFont));
            const restShift = baseline - restAscent;
            const ratio = bodySize > 0 ? member.lineHeight / bodySize : 1;
            const margin = firstLetterMargin ?? { top: 0, right: 0, bottom: 0, left: 0 };
            const pad = firstLetterPadding ?? { top: 0, right: 0, bottom: 0, left: 0 };
            const bTop = drawnBorderWidth(firstLetterBorder?.top);
            const bRight = drawnBorderWidth(firstLetterBorder?.right);
            const bBottom = drawnBorderWidth(firstLetterBorder?.bottom);
            const bLeft = drawnBorderWidth(firstLetterBorder?.left);
            const insetLeft = margin.left + bLeft + pad.left;
            const insetRight = margin.right + bRight + pad.right;
            const insetTop = margin.top + bTop + pad.top;
            const insetBottom = margin.bottom + bBottom + pad.bottom;
            const noteBorder = (boxX: number, boxY: number): void => {
              if (firstLetterBorder === undefined || bTop + bRight + bBottom + bLeft <= 0) return;
              const edge = (raw: LetterBorderEdge | undefined, drawn: number): LetterBorderEdge => ({
                width: drawn,
                style: drawn > 0 && raw !== undefined ? raw.style : "none",
                color: raw?.color ?? { r: 0, g: 0, b: 0, a: 1 },
              });
              letterFrame = {
                nodeId: member.nodeId,
                x: boxX + margin.left,
                y: boxY + margin.top,
                width: bLeft + pad.left + shaped.advance + pad.right + bRight,
                height: bTop + pad.top + ratio * letterSize + pad.bottom + bBottom,
                top: edge(firstLetterBorder.top, bTop),
                right: edge(firstLetterBorder.right, bRight),
                bottom: edge(firstLetterBorder.bottom, bBottom),
                left: edge(firstLetterBorder.left, bLeft),
              };
            };
            const noteBackground = (boxX: number, boxY: number): void => {
              if (firstLetterBackground === undefined || !(firstLetterBackground.a > 0)) return;
              letterFill = {
                nodeId: member.nodeId,
                x: boxX + margin.left,
                y: boxY + margin.top,
                width: bLeft + pad.left + shaped.advance + pad.right + bRight,
                height: bTop + pad.top + ratio * letterSize + pad.bottom + bBottom,
                color: firstLetterBackground,
              };
            };
            const noteImage = (boxX: number, boxY: number): void => {
              if (firstLetterImage === undefined) return;
              letterImageFrame = {
                nodeId: member.nodeId,
                x: boxX + margin.left,
                y: boxY + margin.top,
                width: bLeft + pad.left + shaped.advance + pad.right + bRight,
                height: bTop + pad.top + ratio * letterSize + pad.bottom + bBottom,
                originX: boxX + margin.left + bLeft,
                originY: boxY + margin.top + bTop,
                originWidth: pad.left + shaped.advance + pad.right,
                originHeight: pad.top + ratio * letterSize + pad.bottom,
                image: firstLetterImage.image,
                repeat: firstLetterImage.repeat,
                size: firstLetterImage.size,
                position: firstLetterImage.position,
              };
            };
            const letterBox = Math.max(
              letterY + insetTop + ratio * letterSize + insetBottom,
              restShift + ratio * restPx,
              firstLetterLineHeight ?? 0,
              firstLineLineHeight ?? 0,
            );
            const letterPaint = firstLetterColor ?? firstLineColor;
            const letterMark = {
              ...(firstLetterPx !== undefined ? { fontSize: px(letterSize) } : {}),
              ...(letterPaint !== undefined ? { color: letterPaint } : {}),
              ...(letterWeight !== undefined ? { fontWeight: letterWeight } : {}),
              ...(letterStyle !== undefined ? { fontStyle: letterStyle } : {}),
            };
            if (firstLetterFloat !== undefined) {
              const host =
                narrowLine === undefined
                  ? { x0: 0, x1: Number(containingWidth) }
                  : narrowLine(curLineTop);
              const floatWidth = insetLeft + shaped.advance + insetRight;
              dropCap = {
                side: firstLetterFloat,
                width: floatWidth,
                height: insetTop + ratio * letterSize + insetBottom,
              };
              inlineDropCap.cap = dropCap;
              const floatX = firstLetterFloat === "left" ? host.x0 : host.x1 - floatWidth;
              noteBorder(floatX, 0);
              noteBackground(floatX, 0);
              noteImage(floatX, 0);
              lineGlyphs = shaped.glyphs.map((g) => ({
                glyphId: g.glyphId,
                faceIndex: g.faceIndex,
                x: px(floatX + insetLeft + g.dx),
                y: px(insetTop + g.dy),
                advance: px(g.advance),
                ...letterMark,
              }));
              lineHasGlyphs = true;
              lineStartX = floatX;
              penX = curSpan().x0;
              lineHasAny = true;
              lineWidths[lineIndex] = Math.max(lineWidths[lineIndex]!, floatX + floatWidth);
            } else {
              letterRestY = restShift;
              noteBorder(originX, letterY);
              noteBackground(originX, letterY);
              noteImage(originX, letterY);
              if (firstLetterDecoration !== undefined) {
                const decoY = decorationY(firstLetterDecoration.line, letterY + insetTop, letterSize);
                letterDecorations.push({
                  nodeId: member.nodeId,
                  x: originX + insetLeft,
                  y: decoY,
                  width: shaped.advance,
                  color: firstLetterDecoration.color ?? { r: 0, g: 0, b: 0, a: 1 },
                  line: firstLetterDecoration.line,
                });
              }
              lineGlyphs = shaped.glyphs.map((g) => ({
                glyphId: g.glyphId,
                faceIndex: g.faceIndex,
                x: px(originX + insetLeft + g.dx),
                y: px(letterY + insetTop + g.dy),
                advance: px(g.advance),
                ...letterMark,
              }));
              lineHasGlyphs = true;
              lineStartX = originX;
              penX = originX + insetLeft + shaped.advance + insetRight;
              lineHasAny = true;
              lineWidths[lineIndex] = Math.max(lineWidths[lineIndex]!, penX);
              lineHeights[lineIndex] = Math.max(lineHeights[lineIndex]!, letterBox);
              lineTextHeights[lineIndex] = Math.max(lineTextHeights[lineIndex]!, letterBox);
              lineAscents[lineIndex] = Math.max(lineAscents[lineIndex]!, letterAscent);
            }
            if (rest.length > 0) {
              const restWidth = shapeWordUnits(shaper, rest, member.font, member.letterSpacing).advance;
              runWords = [rest, ...runWords.slice(1)];
              runWidths = [restWidth, ...runWidths.slice(1)];
              runSpaces = [false, ...runSpaces.slice(1)];
            } else {
              const shifted = new Map<number, number>();
              for (const [k, v] of runBreaks) {
                if (k > 0) shifted.set(k - 1, v);
              }
              runWords = runWords.slice(1);
              runWidths = runWidths.slice(1);
              runSpaces = runSpaces.slice(1);
              runShy = runShy.slice(1);
              runBreaks = shifted;
            }
          } else if (word0 !== undefined && word0.length > 0) {
            letterConsumed = true;
          }
        }
        const metricsAt = (
          word: string,
          fallbackWidth: number,
          line: number,
        ): {
          w: number;
          space: number;
          y: number;
          box: number;
          ascent: number;
          font?: ShapingFont;
        } => {
          const first = line === 0 && firstLinePx !== undefined;
          const font = first ? { ...member.font, fontSize: px(firstLinePx) } : undefined;
          const use = font ?? member.font;
          const body = Number(member.font.fontSize);
          const ratio = body > 0 ? member.lineHeight / body : 1;
          const ascentEm = body > 0 ? member.ascent / body : 0.8;
          const bodySpace = shapeWordUnits(shaper, " ", member.font, 0).advance;
          const track = line === 0 && (firstLinePx !== undefined || firstLineSpacing !== undefined);
          const spacing = line === 0 && firstLineSpacing !== undefined ? firstLineSpacing : member.letterSpacing;
          return {
            w: track
              ? shapeWordUnits(shaper, word, use, spacing).advance
              : fallbackWidth,
            space: (first
              ? shapeWordUnits(shaper, " ", use, 0).advance + (member.spaceAdvance - bodySpace)
              : member.spaceAdvance) + (line === 0 ? (firstLineWordSpacing ?? firstLetterWordSpacing ?? 0) : 0),
            y: line === 0 ? letterRestY : 0,
            box: line === 0 && (firstLineLineHeight !== undefined || firstLetterLineHeight !== undefined)
              ? Math.max(first ? ratio * firstLinePx : member.lineHeight, firstLineLineHeight ?? 0, firstLetterLineHeight ?? 0)
              : first ? ratio * firstLinePx : member.lineHeight,
            ascent: first ? ascentEm * firstLinePx : member.ascent,
            ...(font !== undefined ? { font } : {}),
          };
        };
        for (let wi = 0; wi < runWords.length; wi += 1) {
          const word = runWords[wi]!;
          // `white-space: pre*`: a source `\n` forces a line break regardless
          // of fit — even on an empty line (`\n\n` yields a blank line box at
          // this member's line-height).
          fireHardBreaks(runBreaks.get(wi) ?? 0);
          let m = metricsAt(word, runWidths[wi]!, lineIndex);
          const gap0 = runSpaces[wi] === true && penX > curSpan().x0 ? m.space : 0;
          const fits = !(runWraps && lineHasAny && penX + gap0 + m.w > curSpan().x1);
          if (!fits) {
            // Soft-hyphen break: the line ends with a visible `-`.
            if (wi > 0 && runShy[wi - 1] === true) {
              const hg = placeWord(
                member, "-", penX, m.y, m.font ?? member.font, m.font !== undefined,
                lineIndex === 0 ? firstLineColor : undefined,
                lineIndex === 0 ? firstLineWeight : undefined,
                lineIndex === 0 && firstLineSpacing !== undefined ? firstLineSpacing : member.letterSpacing,
                lineIndex === 0 ? firstLineStyle : undefined,
              );
              lineGlyphs = lineGlyphs.concat(hg);
              const hw = shapeWordUnits(
                shaper,
                "-",
                m.font ?? member.font,
                lineIndex === 0 && firstLineSpacing !== undefined ? firstLineSpacing : member.letterSpacing,
              ).advance;
              lineWidths[lineIndex] = Math.max(lineWidths[lineIndex]!, penX + hw);
            }
            flushLine();
            closeLine();
            m = metricsAt(word, runWidths[wi]!, lineIndex);
          }
          // A line-leading word that STILL overflows (overflow-wrap: break-word
          // / anywhere) is broken mid-word across lines.
          if (
            runWraps &&
            m.w > curSpan().x1 - curSpan().x0 &&
            member.canBreakWord &&
            word.length > 1
          ) {
            let x = curSpan().x0;
            for (const ch of word) {
              const bodyCw = shapeWordUnits(shaper, ch, member.font, member.letterSpacing).advance;
              let cm = metricsAt(ch, bodyCw, lineIndex);
              if (lineHasGlyphs && x + cm.w > curSpan().x1) {
                flushLine();
                closeLine();
                x = curSpan().x0;
                cm = metricsAt(ch, bodyCw, lineIndex);
              }
              const gl = placeWord(
                member,
                applyTextTransform(ch, lineIndex === 0 ? firstLineTransform : undefined),
                x, cm.y, cm.font ?? member.font, cm.font !== undefined,
                lineIndex === 0 ? firstLineColor : undefined,
                lineIndex === 0 ? firstLineWeight : undefined,
                lineIndex === 0 && firstLineSpacing !== undefined ? firstLineSpacing : member.letterSpacing,
                lineIndex === 0 ? firstLineStyle : undefined,
              );
              lineGlyphs = lineGlyphs.concat(gl);
              lineWidths[lineIndex] = Math.max(lineWidths[lineIndex]!, x + cm.w);
              lineHeights[lineIndex] = Math.max(lineHeights[lineIndex]!, cm.box);
              lineTextHeights[lineIndex] = Math.max(lineTextHeights[lineIndex]!, cm.box);
              lineAscents[lineIndex] = Math.max(lineAscents[lineIndex]!, cm.ascent);
              if (!lineHasGlyphs) {
                lineStartX = x;
                lineHasGlyphs = true;
              }
              penX = x + cm.w;
              lineHasAny = true;
              x += cm.w;
            }
            continue;
          }
          const gap = runSpaces[wi] === true && penX > curSpan().x0 ? m.space : 0;
          const startX = penX + gap;
          const gl = placeWord(
            member,
            applyTextTransform(word, lineIndex === 0 ? firstLineTransform : undefined),
            startX, m.y, m.font ?? member.font, m.font !== undefined,
            lineIndex === 0 ? firstLineColor : undefined,
            lineIndex === 0 ? firstLineWeight : undefined,
            lineIndex === 0 && firstLineSpacing !== undefined ? firstLineSpacing : member.letterSpacing,
            lineIndex === 0 ? firstLineStyle : undefined,
          );
          lineGlyphs = lineGlyphs.concat(gl);
          lineWidths[lineIndex] = Math.max(lineWidths[lineIndex]!, startX + m.w);
          lineHeights[lineIndex] = Math.max(lineHeights[lineIndex]!, m.box);
          lineTextHeights[lineIndex] = Math.max(lineTextHeights[lineIndex]!, m.box);
          lineAscents[lineIndex] = Math.max(lineAscents[lineIndex]!, m.ascent);
          if (!lineHasGlyphs) {
            lineStartX = startX;
            lineHasGlyphs = true;
          }
          penX = startX + m.w;
          lineHasAny = true;
        }
        // Trailing `\n` markers (key == words.length): each yields one more
        // empty line at this member's metrics (CSS Text §4.1).
        fireHardBreaks(runBreaks.get(runWords.length) ?? 0);
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
    const align = readTextAlign(activeStyleOf(runIds[0]!));
    // Each line aligns inside ITS OWN free interval (floats may narrow
    // different lines differently). `lineWidths` are absolute right edges
    // (penX counts from the line's narrowed x0).
    const spanForLine = (line: number): { x0: number; x1: number } =>
      narrowLine === undefined
        ? { x0: 0, x1: Number(containingWidth) }
        : narrowLine(lineY[line]!);
    const alignRtl = readDirection(containerStyle) === "rtl";
    const alignDeltaFor = (line: number): number => {
      const span = spanForLine(line);
      const used = Math.max(0, lineWidths[line]! - span.x0);
      const slack = Math.max(0, span.x1 - lineWidths[line]!);
      // `left`/`right` are physical; `start`/`end`/`justify` follow `direction`.
      if (align === "right") return slack;
      if (align === "left") return 0;
      if (align === "end") return alignRtl ? 0 : slack;
      if (align === "center") {
        return Math.max(0, span.x0 + (span.x1 - span.x0 - used) / 2 + used - lineWidths[line]!);
      }
      return alignRtl ? slack : 0; // start / justify / unknown
    };

    // ---- vertical-align pass (CSS 2.1 §10.8.1) ------------------------------
    // Atomic boxes align per `vertical-align` against the line's baseline and
    // edges. The baseline is the deepest member ascent on the line (the strut
    // fallback is the container's own font: `ascentEm` × size, or the 0.8em
    // metrics-placeholder approximation). The line box grows BOTH ways per
    // §10.8: an aligned box's top extends `lineTop` upward and its bottom
    // extends `lineBottom` downward — a lone 300×150 <canvas>/<img> must be
    // fully inside its line, not clipped against the line's top edge. `lift`
    // shifts every member of the line down by the upward growth so intra-line
    // alignment (baseline deltas) is preserved unchanged.
    const strutFontSize = Number(containerStyle.fontSize ?? 16);
    const strutAscent = 0.8 * strutFontSize;
    const strutLineHeight = readLineHeight(containerStyle) * strutFontSize;
    const atomicAlignedY = new Map<Placed, number>();
    const textAlignedY = new Map<Placed, number>();
    const lineY: number[] = [];
    let yAcc = 0;
    for (let li = 0; li < lineWidths.length; li += 1) {
      const top = yAcc;
      const baselineDelta = lineAscents[li]! > 0 ? lineAscents[li]! : strutAscent;
      // §10.8 floor is the TEXT-metrics line box (strut on an atomic-only
      // line). `lineHeights` absorbs atomic heights pre-alignment assuming a
      // top-anchored box — that slack must not double-count here, so aligned
      // atomic edges (`t`/`t+h`) are the only atomic contribution.
      const bottom0 = top + Math.max(lineTextHeights[li]!, strutLineHeight);
      let grownBottom = bottom0;
      let grownTop = top;
      // Two passes (§10.8.1): `top`/`bottom` resolve against the line box's
      // edges as grown by every OTHER box — aligning them against the bare
      // text floor under-shoots whenever a baseline/length atomic extends the
      // box. Pass A resolves baseline-relative members; pass B puts edge-
      // aligned boxes on the grown edges and extends them further if taller.
      const lineAtomics: { item: Placed; t: number; h: number }[] = [];
      const lineTexts: { item: Placed; t: number; h: number }[] = [];
      const deferred: { item: Placed; h: number; va: VerticalAlign }[] = [];
      for (const item of placed) {
        if (item.line !== li) continue;
        if (item.member.kind === "text") {
          if (item.member.valign.kind === "baseline") continue;
          const h = item.member.lineHeight;
          const t = verticalAlignTop(
            item.member.valign,
            h,
            item.member.ascent,
            Number(item.member.font.fontSize),
            top,
            bottom0,
            baselineDelta,
            bottom0 - top,
            item.member.xHeight,
            scriptAt(Number(item.member.font.fontSize), item.member.font),
          );
          lineTexts.push({ item, t, h });
          grownBottom = Math.max(grownBottom, t + h);
          grownTop = Math.min(grownTop, t);
          continue;
        }
        if (item.member.kind !== "atomic") continue;
        const h = Number(item.member.frag.box.marginBox.height);
        if (item.member.valign.kind === "top" || item.member.valign.kind === "bottom") {
          deferred.push({ item, h, va: item.member.valign });
          continue;
        }
        const t = verticalAlignTop(
          item.member.valign,
          h,
          item.member.baselineOff,
          item.member.fontSize,
          top,
          bottom0,
          baselineDelta,
          bottom0 - top,
          item.member.xHeight,
          scriptAt(item.member.fontSize),
        );
        lineAtomics.push({ item, t, h });
        grownBottom = Math.max(grownBottom, t + h);
        grownTop = Math.min(grownTop, t);
      }
      for (const { item, h, va } of deferred) {
        const t = va.kind === "top" ? grownTop : grownBottom - h;
        lineAtomics.push({ item, t, h });
        grownBottom = Math.max(grownBottom, t + h);
        grownTop = Math.min(grownTop, t);
      }
      const lift = Math.max(0, top - grownTop);
      for (const { item, t } of lineAtomics) atomicAlignedY.set(item, t + lift);
      for (const { item, t } of lineTexts) textAlignedY.set(item, t + lift);
      lineY.push(top + lift);
      lineHeights[li] = grownBottom - top + lift;
      yAcc = grownBottom + lift;
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
        const boxY = textAlignedY.get(first) ?? firstLineY;
        // Glyphs are relative to the box origin: each glyph's x is shifted back
        // by the first item's x (plus any per-line align delta difference), and
        // its y is shifted up to the first line's top.
        const glyphs: LaidGlyph[] = [];
        let maxRight = 0;
        let lineLeft = Number.POSITIVE_INFINITY;
        let lineRight = Number.NEGATIVE_INFINITY;
        let sawFirstLine = false;
        for (const gItem of group) {
          const dY = lineY[gItem.line]! - firstLineY;
          const dX = alignDeltaFor(gItem.line) - alignDeltaFor(first.line);
          for (const g of gItem.glyphs ?? []) {
            const gx = Number(g.x) - first.x + dX;
            glyphs.push({ ...g, x: px(gx), y: px(Number(g.y) + dY) });
            if (gItem.line === 0) {
              sawFirstLine = true;
              lineLeft = Math.min(lineLeft, gx);
              lineRight = Math.max(lineRight, gx + Number(g.advance));
            }
          }
          maxRight = Math.max(maxRight, lineWidths[gItem.line]!);
        }
        const width = px(Math.max(0, maxRight - first.x));
        const height = px(lineY[lastLine]! + lineHeights[lastLine]! - firstLineY);
        const box = buildBoxAtOrigin(ZERO_MARGIN, width, height);
        const firstText = first.member as TextMember;
        const textRun: TextRun = {
          fontSize: firstText.font.fontSize,
          fontWeight: firstText.font.fontWeight ?? 400,
          ...(synthesizeBoldAllowed(firstText.font.css) ? {} : { synthesizeBold: false }),
          ...(synthesizeStyleAllowed(firstText.font.css) ? {} : { synthesizeStyle: false }),
          glyphs,
          ...(letterFrame !== undefined && letterFrame.nodeId === firstText.nodeId
            ? {
                letterBorder: {
                  x: px(letterFrame.x - first.x),
                  y: px(letterFrame.y + (lineY[first.line]! - firstLineY)),
                  width: px(letterFrame.width),
                  height: px(letterFrame.height),
                  top: letterBorderSide(letterFrame.top),
                  right: letterBorderSide(letterFrame.right),
                  bottom: letterBorderSide(letterFrame.bottom),
                  left: letterBorderSide(letterFrame.left),
                },
              }
            : {}),
          ...(letterFill !== undefined && letterFill.nodeId === firstText.nodeId
            ? {
                letterBackground: {
                  x: px(letterFill.x - first.x),
                  y: px(letterFill.y + (lineY[first.line]! - firstLineY)),
                  width: px(letterFill.width),
                  height: px(letterFill.height),
                  color: letterFill.color,
                },
              }
            : {}),
          ...(letterImageFrame !== undefined && letterImageFrame.nodeId === firstText.nodeId
            ? {
                letterImage: {
                  x: px(letterImageFrame.x - first.x),
                  y: px(letterImageFrame.y + (lineY[first.line]! - firstLineY)),
                  width: px(letterImageFrame.width),
                  height: px(letterImageFrame.height),
                  originX: px(letterImageFrame.originX - first.x),
                  originY: px(letterImageFrame.originY + (lineY[first.line]! - firstLineY)),
                  originWidth: px(letterImageFrame.originWidth),
                  originHeight: px(letterImageFrame.originHeight),
                  image: letterImageFrame.image,
                  repeat: letterImageFrame.repeat,
                  size: letterImageFrame.size,
                  position: letterImageFrame.position,
                },
              }
            : {}),
          ...(firstLineBackground !== undefined &&
          firstLineBackground.a > 0 &&
          sawFirstLine &&
          lineRight > lineLeft
            ? {
                lineBackground: {
                  x: px(lineLeft),
                  y: px(lineY[0]! - firstLineY),
                  width: px(lineRight - lineLeft),
                  height: px(lineHeights[0]!),
                  color: firstLineBackground,
                },
              }
            : {}),
          ...(firstLineImage !== undefined && sawFirstLine && lineRight > lineLeft
            ? {
                lineImage: {
                  x: px(lineLeft),
                  y: px(lineY[0]! - firstLineY),
                  width: px(lineRight - lineLeft),
                  height: px(lineHeights[0]!),
                  originX: px(lineLeft),
                  originY: px(lineY[0]! - firstLineY),
                  originWidth: px(lineRight - lineLeft),
                  originHeight: px(lineHeights[0]!),
                  image: firstLineImage.image,
                  repeat: firstLineImage.repeat,
                  size: firstLineImage.size,
                  position: firstLineImage.position,
                },
              }
            : {}),
          ...(() => {
            const dy = lineY[first.line]! - firstLineY;
            const marks = letterDecorations
              .filter((mark) => mark.nodeId === firstText.nodeId)
              .map((mark) => ({
                x: px(mark.x - first.x),
                y: px(mark.y + dy),
                width: px(mark.width),
                color: mark.color,
                line: mark.line,
              }));
            if (firstLineDecoration !== undefined && sawFirstLine && lineRight > lineLeft) {
              const size = Number(firstText.font.fontSize);
              marks.push({
                x: px(lineLeft),
                y: px(lineY[0]! - firstLineY + decorationY(firstLineDecoration.line, 0, size)),
                width: px(lineRight - lineLeft),
                color: firstLineDecoration.color ?? { r: 0, g: 0, b: 0, a: 1 },
                line: firstLineDecoration.line,
              });
            }
            return marks.length === 0 ? {} : { decorations: marks };
          })(),
        };
        const base: Fragment = { node: firstText.nodeId, box, children: [], text: textRun };
        const placedFrag = boxX > 0 || boxY > 0 ? offsetFragment(base, boxX, boxY) : base;
        const wrappers = firstText.wrapperNodeIds;
        if (wrappers !== undefined && wrappers.length > 0) {
          const innerBox = (): BoxGeometry =>
            buildBoxAtOrigin(ZERO_MARGIN, placedFrag.box.width, placedFrag.box.height);
          let childId = register({
            node: firstText.nodeId,
            box: innerBox(),
            children: [],
            ...(placedFrag.text === undefined ? {} : { text: placedFrag.text }),
          });
          for (let i = wrappers.length - 1; i >= 1; i -= 1) {
            childId = register({ node: wrappers[i]!, box: innerBox(), children: [childId] });
          }
          out.push({ node: wrappers[0]!, box: placedFrag.box, children: [childId] });
        } else {
          out.push(placedFrag);
        }
      } else if (item.member.kind === "atomic") {
        const dx = item.x + alignDeltaFor(item.line);
        out.push(offsetFragment(item.member.frag, dx, atomicAlignedY.get(item) ?? lineYTop));
      }
      // "empty" members never reach `placed` (no line, no geometry).
    }
    return out;
  }

  function layoutInline(
    node: DomNode,
    containingWidth: Px,
    containerStyle?: ComputedStyle,
    narrowLine?: (localY: number) => { x0: number; x1: number },
    containerNode?: DomNode,
  ): Fragment {
    const style = activeStyleOf(node.id);
    const fontSize = style.fontSize;
    const content = node.text ?? "";
    const font: ShapingFont = {
      fontSize,
      fontWeight: readFontWeight(style),
      css: fontSelection(style),
      ...directionProp(style),
    };

    // Whitespace collapses to break opportunities; words are the unbreakable
    // units — in VISUAL order (bidi L2 across the run, RFC 0002). For
    // newline-preserving `white-space` (`pre`/`pre-wrap`/`pre-line`/
    // `break-spaces`) a `\n` also emits a hard line break. An empty or
    // whitespace-only run renders no line (zero geometry), matching the Phase 1
    // empty-text behaviour.
    const whiteSpace = readWhiteSpace(style);
    // Paragraph bidi context (RFC 0023): the container's `unicode-bidi` wraps
    // the text in explicit-format codes (bidi-override/isolate-override);
    // `dir=auto`/`plaintext` resolve the base per-paragraph first-strong —
    // otherwise the (inherited) `direction` on the run is the base.
    const containerDirAttr = containerNode?.attrs?.get("dir")?.toLowerCase();
    const ubidi =
      containerStyle === undefined ? "normal" : unicodeBidiKeyword(containerStyle);
    const wrap =
      containerStyle === undefined ? null : containerBidiWrap(containerStyle, ubidi);
    const baseOverride: "ltr" | "rtl" | undefined =
      containerDirAttr === "auto" || ubidi === "plaintext" ? undefined : font.direction;
    const { units, trailingBreaks } = visualTokens(
      content,
      baseOverride,
      whiteSpaceKeepsNewlines(whiteSpace),
      wrap,
      breakOptionsOf(style),
    );
    const words: string[] = [];
    const spaces: boolean[] = [];
    const shyAfter: boolean[] = [];
    const hardBreaks = new Map<number, number>();
    for (const u of units) {
      const at = words.length;
      if (u.hardBreaksBefore > 0) {
        hardBreaks.set(at, (hardBreaks.get(at) ?? 0) + u.hardBreaksBefore);
      }
      words.push(u.text);
      spaces.push(u.spaceBefore);
      shyAfter.push(u.shyAfter);
    }
    if (trailingBreaks > 0) {
      hardBreaks.set(words.length, trailingBreaks);
    }
    if (words.length === 0 && hardBreaks.size === 0) {
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
    const spaceAdvance = shapeWordUnits(shaper, " ", font, 0).advance + wordSpacing;

    // `overflow-wrap: break-word` splits a word mid-way ONLY when it cannot
    // fit on a line by itself (the `canBreakWord` path in the wrap loop).
    // `break-all` / `anywhere` arrived pre-split per character from
    // `breakUnits` — each char unit is already its own breakable word.
    const overflowWrap = typeof style["overflowWrap"] === "string" ? style["overflowWrap"] : "normal";
    const perCharAdvance = (ch: string): number => shapeWordUnits(shaper, ch, font, letterSpacing).advance;
    const canBreakWord = overflowWrap === "break-word" || overflowWrap === "anywhere";
    const hyphenAdvance = shapeWordUnits(shaper, "-", font, letterSpacing).advance;

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
    // RFC 0003: `narrowLine` gives each line's free interval after float
    // intrusion; pen positions are ABSOLUTE inside it (x0-aware).
    const spanFor = (li: number): { x0: number; x1: number } => {
      const span =
        narrowLine === undefined
          ? { x0: 0, x1: Number(containingWidth) }
          : narrowLine(li * lineHeight);
      // `text-indent` (CSS Text §3.6): the FIRST formatted line retreats from
      // the start edge (negative indents may push it before the box edge).
      if (li !== 0 || textIndent === 0) return span;
      return indentRtl
        ? { x0: span.x0, x1: span.x1 - textIndent }
        : { x0: span.x0 + textIndent, x1: span.x1 };
    };
    // `text-indent` is a block-container property (inherited): the enclosing
    // block's value wins over the text node's own, like `text-overflow`.
    const indentSource = containerStyle ?? style;
    const textIndent = readTextIndent(indentSource, Number(containingWidth));
    const indentRtl = indentSource["direction"] === "rtl";

    const glyphs: LaidGlyph[] = [];
    const placeWord = (word: string, startX: number, lineIndex: number): void => {
      for (const g of shapeWordUnits(shaper, word, font, letterSpacing).glyphs) {
        glyphs.push({
          glyphId: g.glyphId,
          faceIndex: g.faceIndex,
          x: px(startX + g.dx),
          y: px(lineIndex * lineHeight + g.dy),
          advance: px(g.advance),
        });
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
    for (let wi = 0; wi < words.length; wi += 1) {
      const word = words[wi]!;
      // `white-space: pre*`: `\n` markers force a line break regardless of fit
      // — including on an empty line (`\n\n` yields a blank line box).
      const breaks = hardBreaks.get(wi) ?? 0;
      for (let b = 0; b < breaks; b += 1) {
        closeLine(lineHasContent ? current : 0);
        lineIndex += 1;
        lineHasContent = false;
      }
      // `letter-spacing` adds advance after each glyph; the metrics shaper emits
      // one glyph per code unit, so the extra is `letterSpacing × word.length`
      // (0 by default ⇒ the inline width is unchanged).
      const wordAdvance = shapeWordUnits(shaper, word, font, letterSpacing).advance;
      const span = spanFor(lineIndex);
      if (!lineHasContent) {
        // The word is the first on its line. `overflow-wrap: break-word` lets a
        // word that STILL overflows the line by itself break mid-word, so it wraps
        // to multiple lines instead of overflowing as one unbreakable unit.
        if (wraps && canBreakWord && wordAdvance > span.x1 - span.x0) {
          let penX = spanFor(lineIndex).x0;
          let placedAny = false;
          for (const ch of word) {
            const chAdvance = perCharAdvance(ch);
            if (placedAny && penX + chAdvance > spanFor(lineIndex).x1) {
              closeLine(penX);
              lineIndex += 1;
              penX = spanFor(lineIndex).x0;
              placeWord(ch, penX, lineIndex);
              penX += chAdvance;
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
        placeWord(word, span.x0, lineIndex);
        current = span.x0 + wordAdvance; // first word always fits on its (own) line.
        lineHasContent = true;
        lineWordCount = 1;
        continue;
      }
      const gap = spaces[wi] === true ? spaceAdvance : 0;
      const tentative = current + gap + wordAdvance;
      if (wraps && tentative > span.x1) {
        // A soft-hyphen break (`hyphens` ≠ none) shows a visible hyphen at the
        // line end before wrapping.
        if (shyAfter[wi - 1] === true) {
          placeWord("-", current, lineIndex);
          current += hyphenAdvance;
        }
        closeLine(current); // close the current line and wrap.
        lineIndex += 1;
        const nextSpan = spanFor(lineIndex);
        // The wrapped word is now first on the new line; if it still overflows and
        // mid-word breaking is allowed, break it across lines.
        if (canBreakWord && wordAdvance > nextSpan.x1 - nextSpan.x0) {
          let penX = nextSpan.x0;
          for (const ch of word) {
            const chAdvance = perCharAdvance(ch);
            if (penX > spanFor(lineIndex).x0 && penX + chAdvance > spanFor(lineIndex).x1) {
              closeLine(penX);
              lineIndex += 1;
              penX = spanFor(lineIndex).x0;
              placeWord(ch, penX, lineIndex);
              penX += chAdvance;
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
        placeWord(word, nextSpan.x0, lineIndex);
        current = nextSpan.x0 + wordAdvance;
        lineWordCount = 1;
      } else {
        placeWord(word, current + gap, lineIndex); // after the space gap (if any).
        current = tentative; // the word (and its space) fit on this line (or no-wrap keeps it).
        lineWordCount += 1;
      }
    }
    // Trailing `\n` markers each add one more empty line box.
    for (let b = 0; b < (hardBreaks.get(words.length) ?? 0); b += 1) {
      closeLine(lineHasContent ? current : 0);
      lineIndex += 1;
      lineHasContent = false;
    }
    closeLine(current); // close the final, in-progress line.

    const lineCount = lineWidths.length; // ≥ 1 here.
    const contentHeight = px(lineCount * lineHeight);
    // `lineWidths` are ABSOLUTE right edges (pen positions include the line's
    // narrowed x0), so `widestLine` is the furthest right any line reached.
    const widestLine = lineWidths.reduce((max, w) => (w > max ? w : max), 0);
    // `text-align: justify` stretches the inter-word gaps of every line EXCEPT
    // the last so the line fills its own (possibly float-narrowed) free
    // interval. We keep the natural layout for the last line (and for
    // single-word lines, which have no gap to stretch).
    const justify = readTextAlign(style) === "justify" && wraps;
    if (justify) {
      for (let li = 0; li < lineCount - 1; li += 1) {
        const range = lineRanges[li]!;
        if (range.wordCount < 2) {
          continue; // no inter-word gap to distribute.
        }
        const slack = Math.max(0, spanFor(li).x1 - lineWidths[li]!);
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
          // A word starts at the line's x0 OR when the previous glyph's
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
    // `text-align` shifts each line's content inside ITS OWN free interval
    // (floats may narrow different lines differently): `right`/`end` take all
    // the interval's slack, `center` half, `start`/`left`/`justify` none. The
    // fragment box then spans from the first line's shifted left edge to the
    // widest shifted right edge — under no narrowing this is byte-for-byte the
    // historical single `alignDelta` box shift.
    const deltas: number[] = lineWidths.map((w, li) => {
      if (justify) {
        return 0;
      }
      const span = spanFor(li);
      const used = Math.max(0, w - span.x0);
      return textAlignOffset(
        readTextAlign(style),
        px(span.x1 - span.x0),
        px(used),
        readDirection(style) === "rtl",
      );
    });
    for (let li = 0; li < lineCount; li += 1) {
      const range = lineRanges[li]!;
      const shift = deltas[li]!;
      if (shift === 0) {
        continue;
      }
      for (let gi = range.start; gi < range.end; gi += 1) {
        const g = glyphs[gi]!;
        glyphs[gi] = { ...g, x: px(Number(g.x) + shift) };
      }
    }
    const boxX = spanFor(0).x0 + deltas[0]!;
    const maxRight = lineWidths.reduce((max, w, li) => Math.max(max, w + deltas[li]!), 0);
    // A wrapping run is clamped to the containing width (its lines fit by
    // construction); a non-wrapping (`nowrap`/`pre`) run keeps its full width,
    // which may OVERFLOW the container (the overflow is then clipped/visible per
    // `overflow`). Default `normal` wraps ⇒ the clamp is unchanged.
    const contentWidth = px(
      Math.max(0, (wraps ? Math.min(Number(containingWidth), maxRight) : maxRight) - boxX),
    );
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
      widestLine > spanFor(0).x1 &&
      textOverflow === "ellipsis"
    ) {
      const ellipsisAdvance = shapeWordUnits(shaper, "\u2026", font, 0).advance;
      const budget = Math.max(0, spanFor(0).x1 - ellipsisAdvance);
      const kept: LaidGlyph[] = [];
      for (const g of glyphs) {
        if (Number(g.x) + Number(g.advance) > budget) break;
        kept.push(g);
      }
      if (kept.length < glyphs.length) {
        for (const g of shapeWordUnits(shaper, "\u2026", font, 0).glyphs) {
          kept.push({
            glyphId: g.glyphId,
            faceIndex: g.faceIndex,
            x: px(budget + g.dx),
            y: px(g.dy),
            advance: px(g.advance),
          });
        }
        ellipsisedGlyphs = kept;
      }
    }
    // Normalize glyph x into the fragment's content-box frame (absolute − boxX).
    const finalGlyphs =
      boxX === 0
        ? ellipsisedGlyphs
        : ellipsisedGlyphs.map((g) => ({ ...g, x: px(Number(g.x) - boxX) }));
    const box = buildBoxAtOrigin(ZERO_MARGIN, contentWidth, contentHeight);
    const textRun: TextRun = {
      fontSize,
      fontWeight: font.fontWeight ?? 400,
      ...(synthesizeBoldAllowed(font.css) ? {} : { synthesizeBold: false }),
      glyphs: finalGlyphs,
    };
    const base: Fragment = { node: node.id, box, children: [], text: textRun };
    return boxX === 0 ? base : offsetFragment(base, boxX, 0);
  }

  /**
   * Max-content margin-box width. A definite `width` wins. Otherwise a block
   * takes the widest child line, and a row flex sums its items. Percentages
   * are indefinite in this pass. Nested flex gaps are not added.
   */
  function textMaxAdvance(node: DomNode): number {
    const raw = (node.text ?? "").replace(/\s+/g, " ").trim();
    if (raw.length === 0) return 0;
    const styleId = node.kind === "text" ? node.parent : node.id;
    if (styleId === null) return 0;
    const style = activeStyleOf(styleId);
    const font: ShapingFont = {
      fontSize: style.fontSize,
      fontWeight: readFontWeight(style),
      css: fontSelection(style),
      ...directionProp(style),
    };
    return shapeWordUnits(shaper, raw, font, readSpacing(style["letterSpacing"])).advance;
  }

  function maxContentMarginBox(nodeId: NodeId): number {
    const node = dom.nodes.get(nodeId);
    if (node === undefined || node.kind === "comment") return 0;
    if (node.kind === "text") return textMaxAdvance(node);
    if (node.kind !== "element") return 0;
    const style = activeStyleOf(nodeId);
    if (readDisplay(style) === "none") return 0;
    const margin = resolveMargin(style);
    const padding = resolvePadding(style, 0);
    const border = resolveBorder(style);
    const insets = padding.left + padding.right + border.left + border.right;
    const margins = margin.left + margin.right;
    const declared = style["width"];
    if (typeof declared === "number") {
      const content = Math.max(0, readBoxSizing(style) === "border-box" ? declared - insets : declared);
      return content + insets + margins;
    }
    if (isReplacedElement(node)) {
      const intrinsic = resolveIntrinsicSize(node, style);
      return (intrinsic?.width ?? 0) + insets + margins;
    }
    return maxContentInner(node) + insets + margins;
  }

  function maxContentInner(node: DomNode): number {
    const style = activeStyleOf(node.id);
    const display = readDisplay(style);
    const dir = readFlexDirection(style);
    const rowish = display === "flex" && (dir === "row" || dir === "row-reverse");
    let line = 0;
    let max = 0;
    const flush = (): void => {
      max = Math.max(max, line);
      line = 0;
    };
    for (const childId of contentChildren(node)) {
      const child = dom.nodes.get(childId);
      if (child === undefined || child.kind === "comment") continue;
      if (child.kind === "text") {
        line += textMaxAdvance(child);
        continue;
      }
      const cs = childStyleOf(childId);
      if (cs !== null && readDisplay(cs) === "none") continue;
      const pos = cs === null ? "static" : readPosition(cs);
      if (pos === "absolute" || pos === "fixed") continue;
      const outer = maxContentMarginBox(childId);
      const childDisplay = cs === null ? "inline" : readDisplay(cs);
      const inlineLevel =
        rowish ||
        childDisplay === "inline" ||
        childDisplay === "inline-block" ||
        childDisplay === "inline-flex" ||
        childDisplay === "inline-grid";
      if (inlineLevel) {
        line += outer;
      } else {
        flush();
        max = Math.max(max, outer);
      }
    }
    flush();
    return max;
  }

  /**
   * Flex layout BRANCH (CSS Flexbox §9). Axis-generic: `order`-sorted items are
   * sized on the MAIN axis from `flex-basis` / the declared main size, then
   * grown by `flex-grow` or shrunk by `flex-shrink` (scaled flex factors,
   * frozen at 0) PER LINE. An item with neither basis nor declared main size
   * is AUTO. Column items measure their content height. Row items measure a
   * max-content width. Free space goes only to items with `flex-grow`.
   *
   * `flex-wrap` packs items into lines on their hypothetical outer main size,
   * including `column` when the container height is definite;
   * `justify-content` packs within each line; `align-items`/`align-self` align
   * on the cross (`stretch` re-lays the item at the line's cross size);
   * `align-content` distributes lines inside a definite container cross.
   * `*-reverse` directions mirror the packed coordinate. Children are offset by
   * the container's content origin (contentLeft/contentTop) — the container's
   * own margins/padding/border now genuinely inset the items.
   */
  function layoutFlex(node: DomNode, containingWidth: Px, containingHeight?: number, forceContentHeight?: number, forcedContentWidth?: Px): Fragment {
    const style = activeStyleOf(node.id);
    const margin = resolveMargin(style);
    const padding = resolvePadding(style, containingWidth);
    const border = resolveBorder(style);
    const contentWidth = forcedContentWidth ?? resolveWidth(style, containingWidth, margin, padding, border);
    const contentLeft = margin.left + border.left + padding.left;
    const contentTop = margin.top + border.top + padding.top;

    const dir = readFlexDirection(style);
    const isRow = dir === "row" || dir === "row-reverse";
    const mainRev = dir === "row-reverse" || dir === "column-reverse";
    const wraps = readFlexWrap(style) !== "nowrap";
    const crossRev = readFlexWrap(style) === "wrap-reverse";
    const justify = readJustifyContent(style);
    const alignItems = readAlignItems(style);
    const alignContent = readAlignContent(style);
    const gaps = readGridGaps(style, contentWidth);
    const mainGap = isRow ? gaps.column : gaps.row;
    const crossGap = isRow ? gaps.row : gaps.column;

    // The container's definite content height: the column direction's main
    // size AND the row direction's definite cross size.
    const definiteContentH = forceContentHeight ?? definiteHeightOf(style, padding, border, containingHeight);
    const definiteMain = isRow ? contentWidth : definiteContentH;
    const definiteCross = isRow ? definiteContentH : contentWidth;

    interface FlexItem {
      readonly nodeId: NodeId;
      readonly order: number;
      readonly seq: number;
      /** Outer (margin-box) main size before flexing; auto-row ⇒ 0. */
      readonly outerBase: number;
      readonly isAuto: boolean;
      readonly grow: number;
      readonly shrink: number;
      readonly marginsMain: number;
      readonly marginsCross: number;
      readonly insetsMain: number;
      readonly insetsCross: number;
      readonly alignSelf: string;
      readonly declaredCross: number | null;
    }
    const items: FlexItem[] = [];
    const absIds: NodeId[] = [];
    let seq = 0;
    for (const childNodeId of contentChildren(node)) {
      const childNode = dom.nodes.get(childNodeId);
      if (childNode === undefined || childNode.kind === "comment") continue;
      if (childNode.kind === "text" && (childNode.text ?? "").trim().length === 0) continue;
      const cs = childStyleOf(childNodeId);
      if (cs !== null) {
        const pos = readPosition(cs);
        if (pos === "absolute" || pos === "fixed") {
          absIds.push(childNodeId);
          continue;
        }
      }
      const edges = cs === null ? ZERO_MARGIN : resolveMargin(cs);
      const pad = cs === null ? ZERO_MARGIN : resolvePadding(cs, contentWidth);
      const bd = cs === null ? ZERO_MARGIN : resolveBorder(cs);
      // `box-sizing:border-box` makes the declared main size / flex-basis a
      // BORDER-box length; flex math works on content-box bases — convert.
      const bdBox = cs !== null && readBoxSizing(cs) === "border-box";
      const basisRaw = cs === null ? null : readFlexBasis(cs, definiteMain);
      const declaredRaw = cs === null
        ? null
        : isRow
          ? declaredWidthOf(cs, contentWidth)
          : declaredHeightOf(cs, definiteContentH);
      const declaredCross = cs === null
        ? null
        : isRow
          ? declaredHeightOf(cs, definiteContentH)
          : declaredWidthOf(cs, contentWidth);
      const insetsMain = isRow ? pad.left + pad.right + bd.left + bd.right : pad.top + pad.bottom + bd.top + bd.bottom;
      const insetsCross = isRow ? pad.top + pad.bottom + bd.top + bd.bottom : pad.left + pad.right + bd.left + bd.right;
      const marginsMain = isRow ? edges.left + edges.right : edges.top + edges.bottom;
      const marginsCross = isRow ? edges.top + edges.bottom : edges.left + edges.right;
      // Declared main size / basis become CONTENT-box bases: border-box
      // declarations shed their own padding+border first.
      const toContentBase = (raw: number): number =>
        Math.max(0, raw - (bdBox ? insetsMain : 0));
      const basis = basisRaw === null ? null : toContentBase(basisRaw);
      const declaredMain = declaredRaw === null ? null : toContentBase(declaredRaw);
      const isAuto = basis === null && declaredMain === null;
      const outerBase = isAuto ? 0 : (basis ?? declaredMain ?? 0) + insetsMain + marginsMain;
      items.push({
        nodeId: childNodeId,
        order: cs === null ? 0 : readOrder(cs),
        seq,
        outerBase,
        isAuto,
        grow: cs === null ? 0 : readFlexGrow(cs),
        shrink: cs === null ? 1 : readFlexShrink(cs),
        marginsMain,
        marginsCross,
        insetsMain,
        insetsCross,
        alignSelf: cs === null ? "auto" : readAlignSelf(cs),
        declaredCross,
      });
      seq += 1;
    }
    items.sort((a, b) => (a.order !== b.order ? a.order - b.order : a.seq - b.seq));

    // Column direction needs a MEASURE pass for auto items: height:auto is the
    // natural content height. Row auto items take a max-content width. The
    // column probe runs under `layoutProbe` so the throwaway fragment subtree
    // never reaches the tree.
    const measuredOuter = new Map<NodeId, number>();
    for (const item of items) {
      if (!item.isAuto) continue;
      if (isRow) {
        measuredOuter.set(item.nodeId, maxContentMarginBox(item.nodeId));
        continue;
      }
      const probe = layoutProbe(() => layoutNode(item.nodeId, contentWidth, containingHeight));
      if (probe !== null) measuredOuter.set(item.nodeId, Number(probe.box.marginBox.height));
    }

    // ---- line formation -----------------------------------------------------
    // Wrap on the HYPOTHETICAL outer main size (definite base, or the measured
    // max-content / content height for auto items). A definite-main-less
    // container never wraps.
    const hypoOuter = (i: FlexItem): number =>
      (i.isAuto ? (measuredOuter.get(i.nodeId) ?? i.marginsMain) : i.outerBase);
    interface Line {
      items: FlexItem[];
      hypo: number; // sum of hypothetical outer sizes + main gaps
    }
    const lines: Line[] = [];
    let cur: Line = { items: [], hypo: 0 };
    for (const item of items) {
      const gap = cur.items.length > 0 ? mainGap : 0;
      const ho = hypoOuter(item);
      if (
        wraps &&
        definiteMain !== undefined &&
        cur.items.length > 0 &&
        cur.hypo + gap + ho > definiteMain + 0.001
      ) {
        lines.push(cur);
        cur = { items: [], hypo: 0 };
      }
      const g = cur.items.length > 0 ? mainGap : 0;
      cur.items.push(item);
      cur.hypo += g + ho;
    }
    if (cur.items.length > 0 || lines.length === 0) lines.push(cur);

    // ---- per-line flex + layout ---------------------------------------------
    interface Placed {
      item: FlexItem;
      frag: Fragment;
      mainPos: number;
      crossPos: number;
      crossOuter: number;
    }
    const placedAll: Placed[] = [];
    const lineCrosses: number[] = [];
    const lineMembers: { item: FlexItem; frag: Fragment }[][] = [];
    let accLines = 0; // Σ line cross sizes + cross gaps — the used cross extent.
    for (const line of lines) {
      const n = line.items.length;
      const gapsTotal = mainGap * Math.max(0, n - 1);
      // An auto item's base is its measured content size (max-content width on
      // a row, content height on a column).
      const baseOuterOf = (i: FlexItem): number =>
        i.isAuto ? (measuredOuter.get(i.nodeId) ?? i.marginsMain) : i.outerBase;
      const baseSum = line.items.reduce((s, i) => s + baseOuterOf(i), 0);
      const free = definiteMain === undefined ? 0 : definiteMain - baseSum - gapsTotal;
      const growSum = line.items.reduce((s, i) => s + i.grow, 0);
      // Shrink factor sum: scaled by base size (spec §9.7's scaled flex shrink).
      const shrinkScaled = line.items.reduce(
        (s, i) => s + (i.shrink > 0 ? Math.max(0, baseOuterOf(i) - i.marginsMain) * i.shrink : 0),
        0,
      );
      const targetOuterOf = (item: FlexItem): number => {
        const base = baseOuterOf(item);
        if (free > 0) {
          if (growSum > 0) {
            return base + (free * item.grow) / growSum;
          }
          // No author `flex-grow`. An empty auto item (max-content 0) shares
          // the free space — the equal-split fixtures. A content max-content
          // base stays put, and so does a definite width.
          if (item.isAuto && base === 0) {
            const emptyCount = line.items.reduce(
              (n, i) => n + (i.isAuto && baseOuterOf(i) === 0 ? 1 : 0),
              0,
            );
            if (emptyCount > 0) return free / emptyCount;
          }
          return base;
        }
        if (free < 0 && item.shrink > 0 && shrinkScaled > 0) {
          const scaled = Math.max(0, base - item.marginsMain) * item.shrink;
          return Math.max(0, base + (free * scaled) / shrinkScaled);
        }
        return base;
      };

      // Lay out each item at its target outer main size, then measure.
      const lineItems: { item: FlexItem; frag: Fragment }[] = [];
      for (const item of line.items) {
        const targetOuter = Math.max(0, targetOuterOf(item));
        let frag: Fragment | null;
        if (isRow) {
          // Offering containing width W to an auto-width child produces a
          // margin box exactly W wide (content = W − margins − insets). The
          // forced content width makes the flexed size WIN over the child's
          // declared `width` — the declaration only seeded flex-basis:auto.
          const targetInner = Math.max(0, targetOuter - item.marginsMain - item.insetsMain);
          frag = layoutNode(item.nodeId, px(targetOuter), containingHeight, undefined, undefined, px(targetInner));
        } else {
          const targetInner = Math.max(0, targetOuter - item.marginsMain - item.insetsMain);
          frag = layoutNode(item.nodeId, contentWidth, containingHeight, px(targetInner));
        }
        if (frag === null) continue;
        lineItems.push({ item, frag });
      }

      const naturalCross = lineItems.reduce((m, li) => {
        const c = isRow ? li.frag.box.marginBox.height : li.frag.box.marginBox.width;
        return Math.max(m, Number(c));
      }, 0);

      // justify-content distributes the line's post-flex free space.
      const usedOuter =
        lineItems.reduce((s, li) => s + (isRow ? Number(li.frag.box.marginBox.width) : Number(li.frag.box.marginBox.height)), 0) +
        mainGap * Math.max(0, lineItems.length - 1);
      const freeJust = definiteMain === undefined ? 0 : Math.max(0, definiteMain - usedOuter);
      const { leading, between } = justifyOffsets(justify, freeJust, lineItems.length);

      let packed = 0;
      for (let i = 0; i < lineItems.length; i += 1) {
        const { item, frag } = lineItems[i]!;
        const outerMain = isRow ? Number(frag.box.marginBox.width) : Number(frag.box.marginBox.height);
        const outerCross = isRow ? Number(frag.box.marginBox.height) : Number(frag.box.marginBox.width);
        if (i > 0) packed += mainGap;
        let mainPos = packed + leading + between * i;
        if (mainRev && definiteMain !== undefined) {
          mainPos = definiteMain - mainPos - outerMain;
        }
        packed += outerMain;
        placedAll.push({ item, frag, mainPos, crossPos: 0, crossOuter: outerCross });
      }
      lineCrosses.push(naturalCross);
      accLines += naturalCross;
      lineMembers.push(lineItems);
    }

    // ---- line placement (align-content + wrap-reverse + stretch) -------------
    const contentHeightAuto = accLines + crossGap * Math.max(0, lines.length - 1);
    const usedCross = definiteCross !== undefined ? Math.max(definiteCross, contentHeightAuto) : contentHeightAuto;
    // align-content only distributes when there is definite cross free space.
    const acFree =
      definiteCross !== undefined && lines.length > 1
        ? Math.max(0, definiteCross - contentHeightAuto)
        : 0;
    // align-content:stretch (the initial) grows every line by an equal share of
    // the free cross space; other keywords distribute via justifyOffsets.
    const stretchShare = alignContent === "stretch" && lines.length > 1 && acFree > 0
      ? acFree / lines.length
      : 0;
    const { leading: acLeading, between: acBetween } =
      alignContent === "stretch" ? { leading: 0, between: 0 } : justifyOffsets(alignContent, acFree, lines.length);
    const effAlign = (item: FlexItem): string =>
      item.alignSelf === "auto" ? alignItems : item.alignSelf;

    const childIds: FragmentId[] = [];
    let lineOrigin = 0;
    let placedIdx = 0;
    for (let li = 0; li < lines.length; li += 1) {
      const naturalCross = lineCrosses[li]!;
      const items = lineMembers[li]!;
      // The EFFECTIVE line cross: nowrap single-line stretches to the
      // container's definite cross (§9.4); multi-line grows by the stretch
      // share; otherwise the natural cross.
      const effCross =
        !wraps && definiteCross !== undefined
          ? Math.max(naturalCross, definiteCross)
          : naturalCross + stretchShare;
      const origin = crossRev && definiteCross !== undefined
        ? usedCross - lineOrigin - effCross
        : acLeading + lineOrigin;
      for (let k = 0; k < items.length; k += 1) {
        const p = placedAll[placedIdx]!;
        placedIdx += 1;
        let frag = p.frag;
        // align-items:stretch re-lays a cross-auto item at the effective line
        // cross (§8.3); skip when it already fills the line.
        if (effAlign(p.item) === "stretch" && p.item.declaredCross === null && p.crossOuter < effCross) {
          const target = Math.max(0, effCross - p.item.marginsCross - p.item.insetsCross);
          const re = isRow
            ? layoutNode(
                p.item.nodeId,
                px(Number(frag.box.marginBox.width)),
                containingHeight,
                px(target),
                undefined,
                px(Number(frag.box.width)),
              )
            : layoutNode(p.item.nodeId, px(effCross), containingHeight);
          if (re !== null) {
            dropFragmentTree(frag);
            frag = re;
          }
        }
        const crossOuter = isRow ? Number(frag.box.marginBox.height) : Number(frag.box.marginBox.width);
        const crossPos = alignOffset(effAlign(p.item), crossOuter, effCross);
        // The line origin lives on the CROSS axis: row adds it to Y, column
        // adds it to X.
        const fx = isRow ? p.mainPos : origin + crossPos;
        const fy = isRow ? origin + crossPos : p.mainPos;
        childIds.push(register(offsetFragment(frag, contentLeft + fx, contentTop + fy)));
      }
      lineOrigin += effCross + (li < lines.length - 1 ? crossGap : 0) + (li < lines.length - 1 ? acBetween : 0);
    }

    const usedMainTotal = placedAll.reduce((m, p) => {
      const end = p.mainPos + (isRow ? Number(p.frag.box.marginBox.width) : Number(p.frag.box.marginBox.height));
      return Math.max(m, end);
    }, 0);
    const contentHeight = isRow
      ? forceContentHeight !== undefined
        ? px(Math.max(0, forceContentHeight))
        : resolveHeight(style, px(usedCross), padding, border, containingHeight)
      : forceContentHeight !== undefined
        ? px(Math.max(0, forceContentHeight))
        : resolveHeight(style, px(usedMainTotal), padding, border, containingHeight);

    for (const absId of absIds) {
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
        (fid) => fragments.get(fid),
      );
      if (placed !== null) childIds.push(register(placed));
    }
    const box = buildBoxAtOrigin(margin, contentWidth, contentHeight, padding, border);
    return { node: node.id, box, children: childIds };
  }

  /**
   * Tracks a parent grid lends to a subgrid item, for the axes it asked for.
   * Set only for the duration of that item's layout.
   */
  let subgridOffer: {
    readonly cols: readonly number[] | null;
    readonly rows: readonly number[] | null;
    readonly columnGap: number;
    readonly rowGap: number;
  } | null = null;
  function layoutAsSubgrid<T>(
    style: ComputedStyle | null,
    cols: readonly number[],
    rows: readonly number[],
    columnGap: number,
    rowGap: number,
    fn: () => T,
  ): T {
    if (style === null || readDisplay(style) !== "grid") return fn();
    const colSpec = style["gridTemplateColumns"];
    const rowSpec = style["gridTemplateRows"];
    const colSub = typeof colSpec === "string" && colSpec.trim() === "subgrid" && cols.length > 0;
    const rowSub = typeof rowSpec === "string" && rowSpec.trim() === "subgrid" && rows.length > 0;
    if (!colSub && !rowSub) return fn();
    const prev = subgridOffer;
    subgridOffer = {
      cols: colSub ? cols : null,
      rows: rowSub ? rows : null,
      columnGap,
      rowGap,
    };
    try {
      return fn();
    } finally {
      subgridOffer = prev;
    }
  }

  /**
   * Grid layout BRANCH (CSS Grid §7–§12). Track lists accept `px`, `%`,
   * `fr`, `auto`, and `minmax(min,max)` plus `repeat()`, including
   * `auto-fill` / `auto-fit`; `grid-template-columns`
   * AND `grid-template-rows` both resolve, with implicit rows sized by
   * `grid-auto-rows` (initial `auto` ⇒ content height). Placement honors
   * `grid-column`/`grid-row` line/span forms and `grid-auto-flow`
   * (row | column, optional `dense`); an occupancy grid keeps spanning cells
   * from colliding. A cell's own `justify-self`/`align-self` (else the
   * container's `justify-items`/`align-items`) positions a non-stretched item
   * inside its cell area; `justify-content`/`align-content` distribute free
   * container space across the track grid. Row-spanning cells feed their
   * overflow back into their spanned auto rows. `auto` column tracks share the
   * leftover width with `fr` (documented approximation — no intrinsic
   * max-content pass); `auto` ROWS genuinely size to content.
   */
  function layoutGrid(node: DomNode, containingWidth: Px, containingHeight?: number, forcedContentWidth?: Px, forceContentHeight?: Px): Fragment {
    const style = activeStyleOf(node.id);
    const margin = resolveMargin(style);
    const padding = resolvePadding(style, containingWidth);
    const border = resolveBorder(style);
    const contentWidth = forcedContentWidth ?? resolveWidth(style, containingWidth, margin, padding, border);
    const contentLeft = margin.left + border.left + padding.left;
    const contentTop = margin.top + border.top + padding.top;
    const definiteContentH = forceContentHeight ?? definiteHeightOf(style, padding, border, containingHeight);
    let gaps = readGridGaps(style, contentWidth);

    const colTemplate = parseGridTemplate(style["gridTemplateColumns"]);
    const expandedCols = expandAutoRepeats(colTemplate.tracks, Number(contentWidth), gaps.column);
    let colTracks = expandedCols.tracks;
    const autoFitColumns = expandedCols.fit;
    const rowTemplate = parseGridTemplate(style["gridTemplateRows"]);
    let rowTracks = rowTemplate.tracks;
    const autoColTrack = parseGridTracks(style["gridAutoColumns"])[0];
    const autoRowTrack = parseGridTracks(style["gridAutoRows"])[0];
    const templateAreas = parseTemplateAreas(style["gridTemplateAreas"]);
    const columnTemplateValue = style["gridTemplateColumns"];
    const columnsSpecified =
      columnTemplateValue !== undefined &&
      (typeof columnTemplateValue !== "string" || columnTemplateValue.trim() !== "none");
    if (templateAreas !== null && !columnsSpecified && templateAreas.cols > 0) {
      colTracks = Array.from({ length: templateAreas.cols }, () => ({ kind: "fr" as const, fr: 1 }));
    }
    if (subgridOffer !== null) {
      const columnSubgrid =
        typeof style["gridTemplateColumns"] === "string" && style["gridTemplateColumns"].trim() === "subgrid";
      const rowSubgrid =
        typeof style["gridTemplateRows"] === "string" && style["gridTemplateRows"].trim() === "subgrid";
      if (columnSubgrid && subgridOffer.cols !== null && subgridOffer.cols.length > 0) {
        colTracks = subgridOffer.cols.map((size) => ({ kind: "px" as const, size }));
        gaps = { row: gaps.row, column: subgridOffer.columnGap };
      }
      if (rowSubgrid && subgridOffer.rows !== null && subgridOffer.rows.length > 0) {
        rowTracks = subgridOffer.rows.map((size) => ({ kind: "px" as const, size }));
        gaps = { row: subgridOffer.rowGap, column: gaps.column };
      }
    }
    const trackAt = (tracks: readonly GridTrack[], fallback: GridTrack | undefined, i: number): GridTrack =>
      tracks[i] ?? fallback ?? { kind: "auto" };
    // Row flow scans within the explicit column count; column flow wraps at
    // the explicit row count (no `grid-template-rows` ⇒ one implicit row ⇒
    // items spread across implicit columns — the horizontal-strip pattern).
    const explicitCols = Math.max(1, colTracks.length);
    const flowRows = Math.max(1, rowTracks.length);

    // ---- placement ----------------------------------------------------------
    const autoFlow = (() => {
      const v = typeof style["gridAutoFlow"] === "string" ? style["gridAutoFlow"].trim().toLowerCase() : "row";
      return {
        column: v.startsWith("column"),
        dense: v.includes("dense"),
      };
    })();
    type Placement = {
      itemStyle: ComputedStyle | null;
      nodeId: NodeId;
      col: number;
      row: number;
      colSpan: number;
      rowSpan: number;
    };
    const placements: Placement[] = [];
    const occupied = new Set<string>();
    const key = (r: number, c: number) => `${r},${c}`;
    const mark = (r: number, c: number, rs: number, cs: number) => {
      for (let rr = r; rr < r + rs; rr += 1) {
        for (let cc = c; cc < c + cs; cc += 1) occupied.add(key(rr, cc));
      }
    };
    const free = (r: number, c: number, rs: number, cs: number): boolean => {
      if (c < 0 || (!autoFlow.column && c + cs > explicitCols)) return false;
      for (let rr = r; rr < r + rs; rr += 1) {
        for (let cc = c; cc < c + cs; cc += 1) {
          if (occupied.has(key(rr, cc))) return false;
        }
      }
      return true;
    };
    // Auto-placement cursor position for linear index `n` — the primary axis
    // advances fastest (columns under row flow, rows under column flow).
    const scanPos = (
      n: number,
      span: number,
      fixedCol: number | null,
      fixedRow: number | null,
    ): { col: number; row: number } | null => {
      if (!autoFlow.column) {
        if (fixedCol !== null) return { col: fixedCol, row: n };
        if (fixedRow !== null) return n + span > explicitCols ? null : { col: n, row: fixedRow };
        return { col: n % explicitCols, row: Math.floor(n / explicitCols) };
      }
      if (fixedRow !== null) return { col: n, row: fixedRow };
      if (fixedCol !== null) return { col: fixedCol, row: n };
      return { row: n % flowRows, col: Math.floor(n / flowRows) };
    };
    const scan = (colSpan: number, rowSpan: number, fixedCol: number | null, fixedRow: number | null): { col: number; row: number } => {
      // Scan the occupancy grid in flow order until the span fits.
      for (let n = 0; n <= 200000; n += 1) {
        const pos = scanPos(n, colSpan, fixedCol, fixedRow);
        if (pos === null) break;
        if (free(pos.row, pos.col, rowSpan, colSpan)) return { col: pos.col, row: pos.row };
      }
      return { col: fixedCol ?? 0, row: fixedRow ?? 0 };
    };
    // `row` (non-dense) keeps a monotonic cursor — an auto item never scans
    // cells before the previously placed one. `dense` rescans from the origin.
    let cursor = 0; // linear index into the scan order
    const linearIndex = (r: number, c: number): number =>
      autoFlow.column ? c * flowRows + r : r * explicitCols + c;
    for (const childNodeId of contentChildren(node)) {
      const childNode = dom.nodes.get(childNodeId);
      if (childNode === undefined || childNode.kind === "comment") continue;
      if (childNode.kind === "text" && (childNode.text ?? "").trim().length === 0) continue;
      const childStyle = childStyleOf(childNodeId);
      if (childStyle !== null) {
        const pos = readPosition(childStyle);
        if (pos === "absolute" || pos === "fixed") continue;
      }
      const areaName =
        childStyle !== null && typeof childStyle["gridArea"] === "string" ? childStyle["gridArea"].trim() : "";
      const area = areaName.length > 0 ? templateAreas?.names.get(areaName) : undefined;
      if (area !== undefined) {
        mark(area.row, area.col, area.rowSpan, area.colSpan);
        placements.push({
          itemStyle: childStyle,
          nodeId: childNodeId,
          col: area.col,
          row: area.row,
          colSpan: area.colSpan,
          rowSpan: area.rowSpan,
        });
        continue;
      }
      const colPlace = parseGridPlacement(childStyle === null ? undefined : childStyle["gridColumn"], colTemplate.lines);
      const rowPlace = parseGridPlacement(childStyle === null ? undefined : childStyle["gridRow"], rowTemplate.lines);
      const colSpan = autoFlow.column
        ? Math.max(1, colPlace.span)
        : Math.max(1, Math.min(explicitCols, colPlace.span));
      const rowSpan = Math.max(1, rowPlace.span);
      let col: number;
      let row: number;
      if (colPlace.start !== null && rowPlace.start !== null) {
        col = Math.max(0, autoFlow.column ? colPlace.start - 1 : Math.min(explicitCols - colSpan, colPlace.start - 1));
        row = Math.max(0, rowPlace.start - 1);
      } else if (colPlace.start !== null) {
        const fixedCol = Math.max(0, autoFlow.column ? colPlace.start - 1 : Math.min(explicitCols - colSpan, colPlace.start - 1));
        const found = scan(colSpan, rowSpan, fixedCol, null);
        col = found.col;
        row = found.row;
      } else if (rowPlace.start !== null) {
        row = Math.max(0, rowPlace.start - 1);
        const found = scan(colSpan, rowSpan, null, row);
        col = found.col;
      } else {
        // Auto item: dense flow rescans from the origin; sparse flow continues
        // from the cursor (CSS Grid §8.5's auto-placement algorithm).
        const start = autoFlow.dense ? 0 : cursor;
        let found = { col: 0, row: 0 };
        for (let n = start; n <= start + 200000; n += 1) {
          const pos = scanPos(n, colSpan, null, null);
          if (pos === null) break;
          if (free(pos.row, pos.col, rowSpan, colSpan)) {
            found = { col: pos.col, row: pos.row };
            break;
          }
        }
        col = found.col;
        row = found.row;
        cursor = linearIndex(row, col) + 1;
      }
      mark(row, col, rowSpan, colSpan);
      placements.push({ itemStyle: childStyle, nodeId: childNodeId, col, row, colSpan, rowSpan });
    }

    let sizedCols = explicitCols;
    if (autoFitColumns && placements.length > 0) {
      const used = new Set<number>();
      for (const p of placements) {
        for (let c = p.col; c < p.col + p.colSpan; c += 1) used.add(c);
      }
      if (used.size > 0 && used.size < colTracks.length) {
        const map = new Map<number, number>();
        const next: GridTrack[] = [];
        for (let i = 0; i < colTracks.length; i += 1) {
          if (!used.has(i)) continue;
          map.set(i, next.length);
          next.push(colTracks[i]!);
        }
        colTracks = next;
        for (let i = 0; i < placements.length; i += 1) {
          const p = placements[i]!;
          let start: number | null = null;
          let kept = 0;
          for (let c = p.col; c < p.col + p.colSpan; c += 1) {
            const mapped = map.get(c);
            if (mapped === undefined) continue;
            if (start === null) start = mapped;
            kept += 1;
          }
          if (start !== null) placements[i] = { ...p, col: start, colSpan: Math.max(1, kept) };
        }
        sizedCols = colTracks.length;
      }
    }

    // ---- column track sizing ------------------------------------------------
    // Placements can exceed the explicit grid (column flow / explicit
    // `grid-column` past the last track) — implicit columns size by
    // `grid-auto-columns`.
    const colCount = placements.reduce((m, p) => Math.max(m, p.col + p.colSpan), sizedCols);
    const colBudget = Math.max(0, contentWidth - gaps.column * Math.max(0, colCount - 1));
    const effectiveCols: GridTrack[] = [];
    for (let i = 0; i < colCount; i += 1) effectiveCols.push(trackAt(colTracks, autoColTrack, i));
    const colWidths = resolveTrackSizes(effectiveCols, colBudget);
    const colOffsets: number[] = [];
    {
      let acc = 0;
      for (let i = 0; i < colCount; i += 1) {
        colOffsets.push(acc);
        acc += colWidths[i]! + (i < colCount - 1 ? gaps.column : 0);
      }
    }
    const colsUsedW = colWidths.reduce((a, w) => a + w, 0) + gaps.column * Math.max(0, colCount - 1);

    // ---- row track sizing ----------------------------------------------------
    const maxRow = placements.reduce((m, p) => Math.max(m, p.row + p.rowSpan), 0);
    const rowCount = Math.max(1, maxRow);
    // Definite row budget: the container's definite content height minus gaps.
    const rowBudget =
      definiteContentH !== undefined
        ? Math.max(0, definiteContentH - gaps.row * Math.max(0, rowCount - 1))
        : undefined;
    const rowSizes = new Array<number>(rowCount).fill(0);
    const rowIsAuto = new Array<boolean>(rowCount).fill(false);
    // Pass A: resolve px/%/fr rows (fr rows only split a DEFINITE budget;
    // in an indefinite container they size to content like `auto`).
    for (let r = 0; r < rowCount; r += 1) {
      const t = trackAt(rowTracks, autoRowTrack, r);
      const fixed = resolveOneTrack(t, rowBudget ?? 0);
      if (fixed !== null) {
        rowSizes[r] = fixed;
      } else {
        rowIsAuto[r] = true;
      }
    }
    // Pass B: lay each item at its cell width and measure natural height —
    // auto (and indefinite-fr) rows take the tallest content; a spanning cell
    // shares its overflow equally across its spanned auto rows.
    const measured: { p: Placement; frag: Fragment; cellW: number; insetsX: number; insetsY: number; edges: Edges<Px> }[] = [];
    for (const p of placements) {
      let cellW = 0;
      for (let c = p.col; c < p.col + p.colSpan && c < colCount; c += 1) cellW += colWidths[c]!;
      cellW += gaps.column * (p.colSpan - 1);
      const cs = p.itemStyle;
      const edges = cs === null ? ZERO_MARGIN : resolveMargin(cs);
      const padI = cs === null ? ZERO_MARGIN : resolvePadding(cs, cellW);
      const bdI = cs === null ? ZERO_MARGIN : resolveBorder(cs);
      const insetsX = padI.left + padI.right + bdI.left + bdI.right;
      const insetsY = padI.top + padI.bottom + bdI.top + bdI.bottom;
      // justify-self/justify-items — a declared-width item keeps it; auto
      // width fills the cell (stretch default).
      const declaredW = cs === null ? null : declaredWidthOf(cs, cellW);
      const offerW = declaredW !== null
        ? px(declaredW + edges.left + edges.right + insetsX)
        : px(Math.max(0, cellW));
      const spannedCols = colWidths.slice(p.col, Math.min(colCount, p.col + p.colSpan));
      const spannedRows: number[] = [];
      let rowsDefinite = true;
      for (let r = p.row; r < p.row + p.rowSpan && r < rowCount; r += 1) {
        if (rowIsAuto[r]) rowsDefinite = false;
        spannedRows.push(rowSizes[r]!);
      }
      if (!rowsDefinite || spannedRows.length !== p.rowSpan) spannedRows.length = 0;
      const frag = layoutAsSubgrid(cs, spannedCols, spannedRows, gaps.column, gaps.row, () => layoutNode(p.nodeId, offerW));
      if (frag === null) continue;
      measured.push({ p, frag, cellW, insetsX, insetsY, edges });
      // The cell's margin box spans `rowSpan` rows plus the inner row gaps.
      const h = Number(frag.box.marginBox.height) + gaps.row * (p.rowSpan - 1);
      const spanned = [...Array(p.rowSpan).keys()].map((k) => p.row + k).filter((r) => r < rowCount);
      const autoSpanned = spanned.filter((r) => rowIsAuto[r]);
      if (autoSpanned.length === 0) continue;
      const spannedFixed = spanned.reduce((s, r) => s + (rowIsAuto[r] ? 0 : rowSizes[r]!), 0);
      // Whatever the fixed rows can't cover is shared equally by the auto
      // rows in the span (a non-spanning cell just takes max of its row).
      const perAuto = Math.max(0, h - spannedFixed) / autoSpanned.length;
      for (const r of autoSpanned) rowSizes[r] = Math.max(rowSizes[r]!, perAuto);
    }
    // fr rows in a definite container split what remains after fixed rows.
    if (rowBudget !== undefined) {
      const frSum = [...Array(rowCount).keys()].reduce((s, r) => {
        const t = trackAt(rowTracks, autoRowTrack, r);
        return s + (t.kind === "fr" ? t.fr : 0);
      }, 0);
      if (frSum > 0) {
        // `1fr` means `minmax(auto, 1fr)`: the row's content min is its floor;
        // the flexed share is what remains after the NON-fr rows. Don't count
        // an fr row's own measured size as "fixed" space it must pay for.
        const fixedSum = rowSizes.reduce(
          (a, s, r) => a + (trackAt(rowTracks, autoRowTrack, r).kind === "fr" ? 0 : s),
          0,
        );
        const unit = Math.max(0, rowBudget - fixedSum) / frSum;
        for (let r = 0; r < rowCount; r += 1) {
          const t = trackAt(rowTracks, autoRowTrack, r);
          if (t.kind === "fr") {
            rowSizes[r] = Math.max(rowSizes[r]!, t.fr * unit);
            rowIsAuto[r] = false; // fr rows took their share — not auto-sized.
          }
        }
      }
    }
    // `align-content:stretch` (and `normal`, the initial value) grows AUTO rows
    // to consume leftover definite height (css-align §5.1: auto-sized tracks
    // stretch; fixed tracks are untouched).
    const alignContentForStretch =
      typeof style["alignContent"] === "string" ? style["alignContent"] : "stretch";
    if (rowBudget !== undefined && (alignContentForStretch === "stretch" || alignContentForStretch === "normal")) {
      const autoRows = rowSizes.map((_, r) => r).filter((r) => rowIsAuto[r]);
      if (autoRows.length > 0) {
        const freeH = rowBudget - rowSizes.reduce((a, s) => a + s, 0);
        if (freeH > 0) {
          const per = freeH / autoRows.length;
          for (const r of autoRows) rowSizes[r] = rowSizes[r]! + per;
        }
      }
    }
    const rowOffsets: number[] = [];
    {
      let acc = 0;
      for (let r = 0; r < rowCount; r += 1) {
        rowOffsets.push(acc);
        acc += rowSizes[r]! + (r < rowCount - 1 ? gaps.row : 0);
      }
    }
    const rowsUsedH = rowSizes.reduce((a, h) => a + h, 0) + gaps.row * Math.max(0, rowCount - 1);

    // ---- item placement inside cells -----------------------------------------
    const justifyItems = typeof style["justifyItems"] === "string" ? style["justifyItems"] : "stretch";
    const alignItemsG = readAlignItems(style);
    const justifyContent = readJustifyContent(style);
    const alignContentG = readAlignContent(style);
    // Container-level distribution: free space offsets the whole track grid.
    const jcFree = Math.max(0, contentWidth - colsUsedW);
    const { leading: jcLeading, between: jcBetween } = justifyOffsets(justifyContent, jcFree, colCount);
    const acFree = definiteContentH !== undefined ? Math.max(0, definiteContentH - rowsUsedH) : 0;
    const { leading: acLeading, between: acBetween } =
      alignContentG === "stretch" ? { leading: 0, between: 0 } : justifyOffsets(alignContentG, acFree, rowCount);

    const childIds: FragmentId[] = [];
    for (const { p, frag: frag0, cellW, insetsY, edges } of measured) {
      let cellH = 0;
      for (let r = p.row; r < p.row + p.rowSpan && r < rowCount; r += 1) cellH += rowSizes[r]!;
      cellH += gaps.row * (p.rowSpan - 1);
      const cs = p.itemStyle;
      const ji = cs !== null && typeof cs["justifySelf"] === "string" && cs["justifySelf"] !== "auto" ? cs["justifySelf"] : justifyItems;
      const ai = cs !== null && readAlignSelf(cs) !== "auto" ? readAlignSelf(cs) : alignItemsG;
      let frag = frag0;
      // align stretch (the default): a height-auto item fills its cell area.
      const declaredH = cs === null ? null : declaredHeightOf(cs, cellH);
      if ((ai === "stretch" || ai === "normal") && declaredH === null && Number(frag.box.marginBox.height) < cellH) {
        const target = Math.max(0, cellH - edges.top - edges.bottom - insetsY);
        const spannedCols = colWidths.slice(p.col, Math.min(colCount, p.col + p.colSpan));
        const spannedRows: number[] = [];
        let rowsDefinite = true;
        for (let r = p.row; r < p.row + p.rowSpan && r < rowCount; r += 1) {
          if (rowIsAuto[r]) rowsDefinite = false;
          spannedRows.push(rowSizes[r]!);
        }
        if (!rowsDefinite || spannedRows.length !== p.rowSpan) spannedRows.length = 0;
        const re = layoutAsSubgrid(cs, spannedCols, spannedRows, gaps.column, gaps.row, () =>
          layoutNode(p.nodeId, px(Number(frag.box.marginBox.width)), undefined, px(target)),
        );
        if (re !== null) {
          dropFragmentTree(frag);
          frag = re;
        }
      }
      const w = Number(frag.box.marginBox.width);
      const h = Number(frag.box.marginBox.height);
      const xOff = ji === "stretch" || ji === "normal" ? 0 : alignOffset(ji, w, cellW);
      const yOff = ai === "stretch" || ai === "normal" ? 0 : alignOffset(ai, h, cellH);
      const x = jcLeading + (colOffsets[p.col] ?? 0) + jcBetween * p.col + xOff;
      const y = acLeading + (rowOffsets[p.row] ?? 0) + acBetween * p.row + yOff;
      childIds.push(register(offsetFragment(frag, contentLeft + x, contentTop + y)));
    }

    const usedH = acLeading + rowsUsedH + acBetween * Math.max(0, rowCount - 1);
    const contentHeight = resolveHeight(style, px(usedH), padding, border, containingHeight);
    const box = buildBoxAtOrigin(margin, contentWidth, contentHeight, padding, border);
    return { node: node.id, box, children: childIds };
  }

  function layoutMulticol(node: DomNode, containingWidth: Px): Fragment {
    const style = activeStyleOf(node.id);
    const margin = resolveMargin(style);
    const contentWidth = resolveWidth(style, containingWidth, margin);
    const gap = readColumnGap(style);
    const count = resolveColumnCount(style, contentWidth, gap);
    const colWidth = px((contentWidth - gap * (count - 1)) / count);

    // Lay every child against the column width (those that produce a box).
    const frags: Fragment[] = [];
    for (const childNodeId of contentChildren(node)) {
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
  /**
   * Table layout BRANCH (CSS 2.1 §17). Structural pass flattens the table into
   * row-groups → rows → cells (explicit `thead`/`tbody`/`tfoot` or
   * `display:table-*-group` produce group fragments; consecutive bare rows
   * share one anonymous group). `colspan`/`rowspan` attributes place cells on
   * an occupancy grid. `border-collapse` positions cells adjacent (equal
   * shared borders overlap identically); `border-spacing` adds spacing
   * between cells AND around the table edge. Column widths: `table-layout:
   * fixed` uses first-row widths; `auto` takes the widest declared cell width
   * per column, spreads a spanning cell's width across its columns, splits
   * the leftover among width-less columns, then stretches proportionally to
   * fill the table (approximation — no max-content pass). Cells are relaid at
   * their full band height and `vertical-align:baseline` aligns first-line
   * baselines across the row (rowspan cells stay top-aligned).
   */
  function layoutTable(
    node: DomNode,
    containingWidth: Px,
    containingHeight?: number,
    forceContentHeight?: Px,
    forcedContentWidth?: Px,
  ): Fragment {
    const style = activeStyleOf(node.id);
    const margin = resolveMargin(style);
    const padding = resolvePadding(style, containingWidth);
    const border = resolveBorder(style);
    let contentWidth = forcedContentWidth ?? resolveWidth(style, containingWidth, margin, padding, border);
    const contentLeft = margin.left + border.left + padding.left;
    const contentTop = margin.top + border.top + padding.top;
    const collapse = readBorderCollapse(style);
    const spacing = collapse ? { h: 0, v: 0 } : readBorderSpacing(style);
    const fixedLayout = readTableLayout(style) === "fixed";
    // css-position-3 §4.1: an abspos table's automatic inline size is
    // fit-content. An in-flow block table still fills its containing block.
    const shrinkInline =
      forcedContentWidth === undefined &&
      (style["position"] === "absolute" || style["position"] === "fixed") &&
      fitsContentOnAxis(style, "justifySelf");

    // ---- structural pass ---------------------------------------------------
    const displayOf = (id: NodeId): string => {
      const cs = childStyleOf(id);
      return cs === null ? "" : readDisplay(cs);
    };
    const isRow = (n: DomNode): boolean =>
      n.kind === "element" && (displayOf(n.id) === "table-row" || n.tag === "tr");
    const isGroup = (n: DomNode): boolean =>
      n.kind === "element" &&
      (TABLE_GROUP_DISPLAYS.has(displayOf(n.id)) || n.tag === "thead" || n.tag === "tbody" || n.tag === "tfoot");
    const isCell = (n: DomNode): boolean =>
      n.kind === "element" && (displayOf(n.id) === "table-cell" || n.tag === "td" || n.tag === "th");
    const isCaption = (n: DomNode): boolean =>
      n.kind === "element" && (n.tag === "caption" || displayOf(n.id) === "table-caption");

    type CellSpec = { id: NodeId; colspan: number; rowspan: number; cs: ComputedStyle | null };
    type RowSpec = { id: NodeId; group: DomNode | null; cells: CellSpec[] };
    const groups: { group: DomNode | null; rows: RowSpec[] }[] = [];
    const captionIds: NodeId[] = [];
    const columnSpecs: { width: number | null; span: number }[] = [];
    const pushColumn = (el: DomNode): void => {
      const cs = childStyleOf(el.id);
      columnSpecs.push({
        width: cs === null ? null : declaredWidthOf(cs, contentWidth),
        span: clampSpan(el.attrs?.get("span")),
      });
    };
    const isColumn = (n: DomNode): boolean =>
      n.kind === "element" && (n.tag === "col" || displayOf(n.id) === "table-column");
    const isColumnGroup = (n: DomNode): boolean =>
      n.kind === "element" && (n.tag === "colgroup" || displayOf(n.id) === "table-column-group");
    const cellSpecOf = (cell: DomNode): CellSpec => ({
      id: cell.id,
      colspan: clampSpan(cell.attrs?.get("colspan")),
      rowspan: clampSpan(cell.attrs?.get("rowspan")),
      cs: childStyleOf(cell.id),
    });
    for (const childId of contentChildren(node)) {
      const child = dom.nodes.get(childId);
      if (child === undefined || child.kind !== "element") continue;
      if (isCaption(child)) {
        captionIds.push(child.id);
        continue;
      }
      if (isColumn(child)) {
        pushColumn(child);
        continue;
      }
      if (isColumnGroup(child)) {
        const cols = child.children
          .map((id) => dom.nodes.get(id))
          .filter((n): n is DomNode => n !== undefined && isColumn(n));
        if (cols.length === 0) pushColumn(child);
        else for (const col of cols) pushColumn(col);
        continue;
      }
      if (isGroup(child)) {
        const rows: RowSpec[] = [];
        for (const rowId of child.children) {
          const row = dom.nodes.get(rowId);
          if (row === undefined || !isRow(row)) continue;
          const cells: CellSpec[] = [];
          for (const cellId of row.children) {
            const cell = dom.nodes.get(cellId);
            if (cell === undefined || !isCell(cell)) continue;
            cells.push(cellSpecOf(cell));
          }
          rows.push({ id: rowId, group: child, cells });
        }
        groups.push({ group: child, rows });
      } else if (isRow(child)) {
        // Bare row → merge into the running anonymous group (spec wraps
        // consecutive bare rows in ONE anonymous table-row-group box).
        let bare = groups.length > 0 ? groups[groups.length - 1]! : undefined;
        if (bare === undefined || bare.group !== null) {
          bare = { group: null, rows: [] };
          groups.push(bare);
        }
        const cells: CellSpec[] = [];
        for (const cellId of child.children) {
          const cell = dom.nodes.get(cellId);
          if (cell === undefined || !isCell(cell)) continue;
          cells.push(cellSpecOf(cell));
        }
        bare.rows.push({ id: childId, group: null, cells });
      } else if (displayOf(child.id) !== "none") {
        // CSS 2.1 §17.2.1: a non-internal child generates an anonymous row
        // and cell. The child element is that cell; the row reuses its id
        // only as a fragment anchor (the cell is registered first, so node
        // lookup finds the cell box).
        let bare = groups.length > 0 ? groups[groups.length - 1]! : undefined;
        if (bare === undefined || bare.group !== null) {
          bare = { group: null, rows: [] };
          groups.push(bare);
        }
        bare.rows.push({ id: childId, group: null, cells: [cellSpecOf(child)] });
      }
    }

    // ---- occupancy placement (colspan/rowspan) ------------------------------
    type Placed = { spec: CellSpec; row: number; col: number; rowIndex: number };
    const allRows: { spec: RowSpec; group: DomNode | null }[] = [];
    for (const g of groups) for (const r of g.rows) allRows.push({ spec: r, group: g.group });
    const occupied = new Set<string>();
    const okey = (r: number, c: number) => `${r},${c}`;
    const placedCells: Placed[] = [];
    let colCount = 0;
    for (let r = 0; r < allRows.length; r += 1) {
      let c = 0;
      for (const cell of allRows[r]!.spec.cells) {
        while (occupied.has(okey(r, c))) c += 1;
        for (let rr = r; rr < r + cell.rowspan; rr += 1) {
          for (let cc = c; cc < c + cell.colspan; cc += 1) occupied.add(okey(rr, cc));
        }
        placedCells.push({ spec: cell, row: r, col: c, rowIndex: r });
        c += cell.colspan;
      }
    }
    for (const p of placedCells) colCount = Math.max(colCount, p.col + p.spec.colspan);
    const rowCount = allRows.length;

    // ---- column widths ------------------------------------------------------
    const colWidths = new Array<number>(colCount).fill(0);
    const colDeclared = new Array<boolean>(colCount).fill(false);
    {
      let ci = 0;
      for (const spec of columnSpecs) {
        for (let s = 0; s < spec.span && ci < colCount; s += 1) {
          if (spec.width !== null && spec.width > colWidths[ci]!) {
            colWidths[ci] = spec.width;
            colDeclared[ci] = true;
          }
          ci += 1;
        }
      }
    }
    // Declared cell widths seed their columns (fixed layout reads only the
    // FIRST row per CSS 2.1 §17.5.2.1; spanning widths share across columns).
    for (const p of placedCells) {
      if (p.spec.cs === null) continue;
      if (fixedLayout && p.row !== 0) continue;
      const w = declaredWidthOf(p.spec.cs, contentWidth);
      if (w === null) continue;
      const per = Math.max(0, w - spacing.h * (p.spec.colspan - 1)) / p.spec.colspan;
      for (let c = p.col; c < p.col + p.spec.colspan && c < colCount; c += 1) {
        if (per > colWidths[c]!) {
          colWidths[c] = per;
          colDeclared[c] = true;
        }
      }
    }
    const spacingTotalX = spacing.h * (colCount + 1); // edge + inner spacing
    const availW = Math.max(0, contentWidth - spacingTotalX);
    const declaredSum = colWidths.reduce((a, w) => a + w, 0);
    const undecIdx = colWidths.map((w, i) => (w === 0 ? i : -1)).filter((i) => i >= 0);
    if (colCount > 0 && !shrinkInline) {
      if (undecIdx.length > 0) {
        const per = Math.max(0, availW - declaredSum) / undecIdx.length;
        for (const i of undecIdx) colWidths[i] = per;
      } else if (declaredSum > 0 && declaredSum < availW) {
        const k = availW / declaredSum;
        for (let i = 0; i < colCount; i += 1) colWidths[i] = colWidths[i]! * k;
      }
    }
    if (shrinkInline) {
      const gridW = spacing.h * (colCount + 1) + colWidths.reduce((a, w) => a + w, 0);
      contentWidth = px(Math.max(0, gridW));
    }
    const colX: number[] = [];
    {
      let acc = spacing.h;
      for (let i = 0; i < colCount; i += 1) {
        colX.push(acc);
        acc += colWidths[i]! + spacing.h;
      }
    }

    // ---- row heights: measure pass ------------------------------------------
    const naturalH: number[] = [];
    const cellFrags0: (Fragment | null)[] = [];
    const cellBandW = (p: Placed): number => {
      let w = 0;
      for (let c = p.col; c < p.col + p.spec.colspan && c < colCount; c += 1) w += colWidths[c]!;
      return w + spacing.h * (p.spec.colspan - 1);
    };
    const cellInsetsX = (cs: ComputedStyle | null, w: number): number =>
      cs === null
        ? 0
        : resolvePadding(cs, w).left + resolvePadding(cs, w).right + resolveBorder(cs).left + resolveBorder(cs).right;
    for (const p of placedCells) {
      const w = cellBandW(p);
      // Measure at the cell's column width — a cell's own `width` feeds the
      // COLUMN sizing above; the cell box itself is sized to its band (§17.5.2).
      const frag = layoutNode(
        p.spec.id,
        px(w),
        containingHeight,
        undefined,
        undefined,
        px(Math.max(0, w - cellInsetsX(p.spec.cs, w))),
      );
      cellFrags0.push(frag);
      naturalH.push(frag === null ? 0 : Number(frag.box.marginBox.height));
    }
    const rowH = new Array<number>(rowCount).fill(0);
    // Non-spanning cells set their row; spanning cells share any deficit over
    // their spanned rows equally (analogous to the grid row-span rule).
    placedCells.forEach((p, i) => {
      const bandBase = rowH.slice(p.row, p.row + p.spec.rowspan).reduce((a, h) => a + h, 0)
        + spacing.v * (p.spec.rowspan - 1);
      const deficit = naturalH[i]! - bandBase;
      if (p.spec.rowspan === 1) {
        rowH[p.row] = Math.max(rowH[p.row]!, naturalH[i]!);
      } else if (deficit > 0) {
        const per = deficit / p.spec.rowspan;
        for (let r = p.row; r < p.row + p.spec.rowspan && r < rowCount; r += 1) rowH[r] = rowH[r]! + per;
      }
    });
    // Row baseline (CSS 2.1 §17.5.3): the deepest first-line baseline among
    // baseline-aligned, single-row cells. Content shifts down to meet it, and
    // the row grows to keep that content inside the band. Row-spanning cells
    // stay out of this pass.
    const firstLineBaseline = (frag: Fragment, top: number): number | null => {
      if (frag.text !== undefined) {
        const inset = Number(frag.box.contentBox.y) - Number(frag.box.borderBox.y);
        return top + inset + 0.8 * Number(frag.text.fontSize);
      }
      for (const cid of frag.children) {
        const child = fragments.get(cid);
        if (child === undefined) continue;
        const hit = firstLineBaseline(child, top + Number(child.box.borderBox.y));
        if (hit !== null) return hit;
      }
      return null;
    };
    const cellBaselineOff = placedCells.map((p, i) => {
      const frag = cellFrags0[i];
      if (frag === undefined || frag === null) return 0;
      const fromText = firstLineBaseline(frag, 0);
      if (fromText !== null) return fromText;
      const cs = p.spec.cs;
      const pad = cs === null ? ZERO_MARGIN : resolvePadding(cs, Number(frag.box.width));
      const bd = cs === null ? ZERO_MARGIN : resolveBorder(cs);
      return Math.max(0, Number(frag.box.borderBox.height) - pad.bottom - bd.bottom);
    });
    const rowBaseline = new Array<number>(rowCount).fill(0);
    placedCells.forEach((p, i) => {
      if (p.spec.rowspan !== 1) return;
      if (readVerticalAlign(p.spec.cs).kind !== "baseline") return;
      rowBaseline[p.row] = Math.max(rowBaseline[p.row]!, cellBaselineOff[i]!);
    });
    placedCells.forEach((p, i) => {
      if (p.spec.rowspan !== 1) return;
      if (readVerticalAlign(p.spec.cs).kind !== "baseline") return;
      const extra = rowBaseline[p.row]! - cellBaselineOff[i]!;
      if (extra > 0) rowH[p.row] = Math.max(rowH[p.row]!, naturalH[i]! + extra);
    });
    const rowY: number[] = [];
    {
      let acc = spacing.v;
      for (let r = 0; r < rowCount; r += 1) {
        rowY.push(acc);
        acc += rowH[r]! + spacing.v;
      }
    }
    const gridH = spacing.v * (rowCount + 1) + rowH.reduce((a, h) => a + h, 0);

    const laidCaptions: { frag: Fragment; h: number; side: "top" | "bottom" }[] = [];
    for (const id of captionIds) {
      const frag = layoutNode(id, contentWidth);
      if (frag === null) continue;
      const cs = childStyleOf(id);
      const side = cs !== null && cs["captionSide"] === "bottom" ? "bottom" : "top";
      laidCaptions.push({ frag, h: Number(frag.box.marginBox.height), side });
    }
    const topH = laidCaptions.filter((c) => c.side === "top").reduce((sum, c) => sum + c.h, 0);
    const bottomH = laidCaptions.filter((c) => c.side === "bottom").reduce((sum, c) => sum + c.h, 0);

    // ---- second pass: cells fill their band; vertical-align shifts content ---
    const finalFrags: (Fragment | null)[] = [...cellFrags0];
    placedCells.forEach((p, i) => {
      const frag0 = cellFrags0[i];
      if (frag0 === undefined || frag0 === null) return;
      const w = cellBandW(p);
      let bandH = 0;
      for (let r = p.row; r < p.row + p.spec.rowspan && r < rowCount; r += 1) bandH += rowH[r]!;
      bandH += spacing.v * (p.spec.rowspan - 1);
      const cs = p.spec.cs;
      const pad = cs === null ? ZERO_MARGIN : resolvePadding(cs, w);
      const bd = cs === null ? ZERO_MARGIN : resolveBorder(cs);
      const innerTop = pad.top + bd.top;
      const innerBot = pad.bottom + bd.bottom;
      // The cell box fills the whole band (§17.5.3: the cell's height IS the
      // row height); content aligns inside via vertical-align.
      let frag = frag0;
      if (bandH > naturalH[i]!) {
        const re = layoutNode(
          p.spec.id,
          px(w),
          containingHeight,
          px(Math.max(0, bandH - innerTop - innerBot)),
          undefined,
          px(Math.max(0, w - cellInsetsX(p.spec.cs, w))),
        );
        if (re !== null) {
          dropFragmentTree(frag);
          frag = re;
        }
      }
      // vertical-align: shift the cell's CONTENT inside its band box. The
      // forced re-layout already made the box band-tall; children still sit at
      // the content top, so middle/bottom offsets move them down.
      const contentH = Math.max(0, naturalH[i]! - innerTop - innerBot);
      const innerH = Number(frag.box.contentBox.height);
      const va = readVerticalAlign(cs);
      let dy = 0;
      if (va.kind === "baseline" && p.spec.rowspan === 1) {
        dy = Math.max(0, rowBaseline[p.row]! - cellBaselineOff[i]!);
      } else if (va.kind === "middle") dy = Math.max(0, innerH - contentH) / 2;
      else if (va.kind === "bottom") dy = Math.max(0, innerH - contentH);
      else if (va.kind === "length") dy = va.len;
      else if (va.kind === "percent") dy = (va.pct / 100) * innerH;
      // sub/super/top/text-* stay at the top of the band.
      if (dy > 0) {
        for (const cid of frag.children) {
          const cfrag = fragments.get(cid);
          if (cfrag !== undefined) fragments.set(cid, offsetFragment(cfrag, 0, dy));
        }
      }
      finalFrags[i] = frag;
    });

    // ---- fragment assembly --------------------------------------------------
    // Rows carry their cells in row-local coordinates (cell x = column offset,
    // cell y = 0 at the band top). Explicit groups wrap their rows in a group
    // fragment; bare rows hang off the table directly (anonymous group box
    // elided — noted in the doc comment).
    const tableChildIds: FragmentId[] = [];
    {
      let ri = 0;
      for (const g of groups) {
        if (g.rows.length === 0) continue;
        const gTop = rowY[ri]! - spacing.v;
        const groupRowIds: FragmentId[] = [];
        for (const r of g.rows) {
          const cellIds: FragmentId[] = [];
          for (let i = 0; i < placedCells.length; i += 1) {
            const p = placedCells[i]!;
            if (p.row !== ri) continue;
            const frag = finalFrags[i];
            if (frag === undefined || frag === null) continue;
            cellIds.push(register(offsetFragment(frag, colX[p.col]!, 0)));
          }
          const rowBox = buildBoxAtOrigin(ZERO_MARGIN, contentWidth, px(rowH[ri]!));
          const rowFrag = { node: r.id, box: rowBox, children: cellIds };
          if (g.group === null) {
            tableChildIds.push(register(offsetFragment(rowFrag, contentLeft, contentTop + topH + rowY[ri]!)));
          } else {
            groupRowIds.push(register(offsetFragment(rowFrag, 0, rowY[ri]! - gTop)));
          }
          ri += 1;
        }
        if (g.group !== null) {
          const lastRi = ri - 1;
          const gBottom = rowY[lastRi]! + rowH[lastRi]! + spacing.v;
          const groupBox = buildBoxAtOrigin(ZERO_MARGIN, contentWidth, px(gBottom - gTop));
          tableChildIds.push(
            register(
              offsetFragment({ node: g.group.id, box: groupBox, children: groupRowIds }, contentLeft, contentTop + topH + gTop),
            ),
          );
        }
      }
    }
    let topY = 0;
    let bottomY = topH + gridH;
    for (const cap of laidCaptions) {
      if (cap.side === "top") {
        tableChildIds.push(register(offsetFragment(cap.frag, contentLeft, contentTop + topY)));
        topY += cap.h;
      } else {
        tableChildIds.push(register(offsetFragment(cap.frag, contentLeft, contentTop + bottomY)));
        bottomY += cap.h;
      }
    }

    const contentHeight = forceContentHeight ?? resolveHeight(style, px(topH + gridH + bottomH), padding, border, containingHeight);
    const box = buildBoxAtOrigin(margin, contentWidth, contentHeight, padding, border);
    return { node: node.id, box, children: tableChildIds };
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

  // ---- initial-containing-block drain --------------------------------------
  // Absolute boxes that found no positioned ancestor land here and resolve
  // against the ICB = the viewport box anchored at the DOCUMENT origin
  // (scroll-independent). `fixed` boxes anchor to the CURRENT viewport rect —
  // their offsets resolve from `scrollY`, which is what keeps them pinned
  // across scroll repaints (layout re-runs per repaint with a new scrollY).
  const icbItems = absStack[0]!.items;
  if (icbItems.length > 0) {
    // Reorder with the same stacking rule as `layoutBlock`: negative-z
    // positioned boxes under in-flow root content, z ≥ 0 over it.
    const slots = (rootFrag.children as FragmentId[]).map((id) => ({
      id,
      group: 1,
      z: 0,
    }));
    for (const item of icbItems) {
      const edgeTop = item.fixed ? scrollY : 0;
      const staticTop = item.fixed
        ? scrollY + Math.max(0, item.staticBfcY)
        : Math.max(0, item.staticBfcY);
      const placed = placeAbsoluteFragment(
        (id2, w2, ch2, fh2) => layoutNode(id2, w2, ch2, fh2),
        item.childNodeId,
        item.childStyle,
        viewportWidth,
        viewportHeight,
        0,
        edgeTop,
        Math.max(0, item.staticBfcX),
        staticTop,
        (fid) => fragments.get(fid),
      );
      if (placed !== null) {
        const z = readZIndex(item.childStyle);
        slots.push({ id: register(placed), group: z < 0 ? 0 : 2, z });
      }
    }
    const ordered = slots.sort((a, b) => a.group - b.group || a.z - b.z).map((s) => s.id);
    const children = rootFrag.children as FragmentId[];
    children.length = 0;
    children.push(...ordered);
  }

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
  const pick = (longhand: unknown, short: Px): Px => {
    if (longhand === "auto") return px(0);
    return typeof longhand === "number" && Number.isFinite(longhand) && longhand !== 0 ? px(longhand) : short;
  };
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

/**
 * `::first-letter` computed `font-size` in px, stored on the originating
 * element's style by the cascade. Absent ⇒ the first letter uses the run's font.
 */
/** A concrete sRGB color stored on the element for a pseudo (`firstLetterColor`). */
function readPaintColor(style: ComputedStyle | undefined, field: string): Color | undefined {
  if (style === undefined) return undefined;
  const value = style[field];
  if (typeof value !== "object" || value === null) return undefined;
  const c = value as Record<string, unknown>;
  if (
    typeof c["r"] !== "number" ||
    typeof c["g"] !== "number" ||
    typeof c["b"] !== "number" ||
    typeof c["a"] !== "number"
  ) {
    return undefined;
  }
  return { r: c["r"], g: c["g"], b: c["b"], a: c["a"] };
}

const PUNCTUATION = /^\p{P}$/u;
const LETTER_OR_NUMBER = /^[\p{L}\p{N}]$/u;

function codePointUnits(cp: number): number {
  return cp > 0xffff ? 2 : 1;
}

/**
 * UTF-16 length of the `::first-letter` prefix of `word`: the leading
 * punctuation, the first letter or digit, and the punctuation that follows
 * it immediately. A word with no letter or digit yields one code point.
 */
function firstLetterUnits(word: string): number {
  const first = word.codePointAt(0);
  if (first === undefined) return 0;
  let i = 0;
  while (i < word.length) {
    const cp = word.codePointAt(i)!;
    if (!PUNCTUATION.test(String.fromCodePoint(cp))) break;
    i += codePointUnits(cp);
  }
  const letter = i < word.length ? word.codePointAt(i) : undefined;
  if (letter === undefined || !LETTER_OR_NUMBER.test(String.fromCodePoint(letter))) {
    return codePointUnits(first);
  }
  i += codePointUnits(letter);
  while (i < word.length) {
    const cp = word.codePointAt(i)!;
    if (!PUNCTUATION.test(String.fromCodePoint(cp))) break;
    i += codePointUnits(cp);
  }
  return i;
}

function hasFirstPseudo(style: ComputedStyle | undefined): boolean {
  return (
    readFirstLetterSize(style) !== undefined ||
    readFirstLineSize(style) !== undefined ||
    readPaintColor(style, "firstLetterColor") !== undefined ||
    readPaintColor(style, "firstLineColor") !== undefined ||
    readFirstLetterFloat(style) !== undefined ||
    readWeightField(style, "firstLetterFontWeight") !== undefined ||
    readWeightField(style, "firstLineFontWeight") !== undefined ||
    readStyleField(style, "firstLetterFontStyle") !== undefined ||
    readStyleField(style, "firstLineFontStyle") !== undefined ||
    readTransformField(style, "firstLetterTextTransform") !== undefined ||
    readTransformField(style, "firstLineTextTransform") !== undefined ||
    readSpacingField(style, "firstLetterWordSpacing") !== undefined ||
    readSpacingField(style, "firstLineWordSpacing") !== undefined ||
    readSpacingField(style, "firstLetterLineHeight") !== undefined ||
    readSpacingField(style, "firstLineLineHeight") !== undefined ||
    readAlignField(style) !== undefined ||
    readDecorationField(style, "firstLetterTextDecoration") !== undefined ||
    readDecorationField(style, "firstLineTextDecoration") !== undefined ||
    readSpacingField(style, "firstLetterLetterSpacing") !== undefined ||
    readSpacingField(style, "firstLineLetterSpacing") !== undefined ||
    readBoxEdges(style, "firstLetterMargin") !== undefined ||
    readBoxEdges(style, "firstLetterPadding") !== undefined ||
    readLetterBorder(style) !== undefined ||
    readPaintColor(style, "firstLetterBackgroundColor") !== undefined ||
    readPaintColor(style, "firstLineBackgroundColor") !== undefined ||
    readLetterImage(style, "firstLetterBackgroundImage") !== undefined ||
    readLetterImage(style, "firstLineBackgroundImage") !== undefined
  );
}

interface LetterImageSpec {
  image: string;
  repeat: string;
  size: string;
  position: string;
}

interface LetterImageFrame extends LetterImageSpec {
  nodeId: NodeId;
  x: number;
  y: number;
  width: number;
  height: number;
  originX: number;
  originY: number;
  originWidth: number;
  originHeight: number;
}

function isPaintedBackgroundImage(image: string): boolean {
  const trimmed = image.trim();
  return (
    image.toLowerCase().includes("url(") ||
    /^linear-gradient\(/i.test(trimmed) ||
    /^radial-gradient\(/i.test(trimmed)
  );
}

function readLetterImage(style: ComputedStyle | undefined, field: string): LetterImageSpec | undefined {
  if (style === undefined) return undefined;
  const value = style[field];
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const image = raw["image"];
  if (
    typeof image !== "string" ||
    !isPaintedBackgroundImage(image)
  ) {
    return undefined;
  }
  const text = (key: string, fallback: string): string =>
    typeof raw[key] === "string" ? raw[key] : fallback;
  return {
    image,
    repeat: text("repeat", "repeat"),
    size: text("size", "auto"),
    position: text("position", "0% 0%"),
  };
}

interface LetterFill {
  nodeId: NodeId;
  x: number;
  y: number;
  width: number;
  height: number;
  color: Color;
}

interface LetterBorderEdge {
  width: number;
  style: "none" | "solid" | "dashed" | "dotted" | "double";
  color: Color;
}

interface LetterFrame {
  nodeId: NodeId;
  x: number;
  y: number;
  width: number;
  height: number;
  top: LetterBorderEdge;
  right: LetterBorderEdge;
  bottom: LetterBorderEdge;
  left: LetterBorderEdge;
}

function letterBorderSide(edge: LetterBorderEdge): {
  width: Px;
  style: LetterBorderEdge["style"];
  color: Color;
} {
  return { width: px(edge.width), style: edge.style, color: edge.color };
}

/** A drawn `::first-letter` border edge. `none` and a non-positive width take no space. */
function drawnBorderWidth(edge: LetterBorderEdge | undefined): number {
  if (edge === undefined || edge.style === "none" || !(edge.width > 0)) return 0;
  return edge.width;
}

function readLetterBorder(style: ComputedStyle | undefined): {
  top: LetterBorderEdge;
  right: LetterBorderEdge;
  bottom: LetterBorderEdge;
  left: LetterBorderEdge;
} | undefined {
  if (style === undefined) return undefined;
  const value = style["firstLetterBorder"];
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const edge = (key: string): LetterBorderEdge | undefined => {
    const side = raw[key];
    if (typeof side !== "object" || side === null) return undefined;
    const s = side as Record<string, unknown>;
    const width = s["width"];
    const styleName = s["style"];
    const color = s["color"];
    if (typeof width !== "number" || !Number.isFinite(width)) return undefined;
    if (
      styleName !== "none" &&
      styleName !== "solid" &&
      styleName !== "dashed" &&
      styleName !== "dotted" &&
      styleName !== "double"
    ) {
      return undefined;
    }
    if (!isColor(color)) return undefined;
    return { width, style: styleName, color };
  };
  const top = edge("top");
  const right = edge("right");
  const bottom = edge("bottom");
  const left = edge("left");
  if (top === undefined || right === undefined || bottom === undefined || left === undefined) return undefined;
  return { top, right, bottom, left };
}

function isColor(value: unknown): value is Color {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c["r"] === "number" &&
    typeof c["g"] === "number" &&
    typeof c["b"] === "number" &&
    typeof c["a"] === "number"
  );
}

function readBoxEdges(
  style: ComputedStyle | undefined,
  field: string,
): { top: number; right: number; bottom: number; left: number } | undefined {
  if (style === undefined) return undefined;
  const value = style[field];
  if (typeof value !== "object" || value === null) return undefined;
  const e = value as Record<string, unknown>;
  const n = (key: string): number =>
    typeof e[key] === "number" && Number.isFinite(e[key]) ? e[key] : 0;
  return { top: n("top"), right: n("right"), bottom: n("bottom"), left: n("left") };
}

/** A px `letter-spacing`, including 0 and negative. Absent when the pseudo does not set one. */
function readSpacingField(style: ComputedStyle | undefined, field: string): number | undefined {
  if (style === undefined) return undefined;
  const value = style[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

type TextTransformMode = "uppercase" | "lowercase" | "capitalize";

function applyTextTransform(text: string, mode: TextTransformMode | undefined): string {
  if (mode === undefined || text.length === 0) return text;
  if (mode === "uppercase") return text.toUpperCase();
  if (mode === "lowercase") return text.toLowerCase();
  const first = text.codePointAt(0)!;
  const rest = text.slice(codePointUnits(first));
  return String.fromCodePoint(first).toUpperCase() + rest;
}

function letterValignShift(
  align: string | undefined,
  fontSize: number,
  script?: { sub?: number; super?: number },
): number {
  if (align === "super") return -(script?.super ?? fontSize * 0.33);
  if (align === "sub") return script?.sub ?? fontSize * 0.2;
  if (align === "middle") return fontSize * 0.25;
  if (align !== undefined && align.endsWith("px")) {
    const n = Number(align.slice(0, -2));
    if (Number.isFinite(n)) return -n;
  }
  return 0;
}

function decorationY(line: "underline" | "overline" | "line-through", top: number, fontSize: number): number {
  if (line === "overline") return top;
  if (line === "line-through") return top + fontSize * 0.5;
  return top + fontSize * 0.9;
}

function readTransformField(style: ComputedStyle | undefined, field: string): TextTransformMode | undefined {
  if (style === undefined) return undefined;
  const value = style[field];
  if (value === "uppercase" || value === "lowercase" || value === "capitalize") return value;
  return undefined;
}

function readAlignField(style: ComputedStyle | undefined): string | undefined {
  if (style === undefined) return undefined;
  const value = style["firstLetterVerticalAlign"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

interface LetterDecoration {
  nodeId: NodeId;
  x: number;
  y: number;
  width: number;
  color: Color;
  line: "underline" | "overline" | "line-through";
}

function readDecorationField(
  style: ComputedStyle | undefined,
  field: string,
): { line: "underline" | "overline" | "line-through"; color?: Color } | undefined {
  if (style === undefined) return undefined;
  const value = style[field];
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const line = raw["line"];
  if (line !== "underline" && line !== "overline" && line !== "line-through") return undefined;
  const color = raw["color"];
  if (color === undefined) return { line };
  if (typeof color !== "object" || color === null) return { line };
  const c = color as Record<string, unknown>;
  if (typeof c["r"] !== "number" || typeof c["g"] !== "number" || typeof c["b"] !== "number" || typeof c["a"] !== "number") {
    return { line };
  }
  return { line, color: { r: c["r"], g: c["g"], b: c["b"], a: c["a"] } };
}

function readStyleField(
  style: ComputedStyle | undefined,
  field: string,
): "normal" | "italic" | "oblique" | undefined {
  if (style === undefined) return undefined;
  const value = style[field];
  if (value === "normal" || value === "italic" || value === "oblique") return value;
  return undefined;
}

function readWeightField(style: ComputedStyle | undefined, field: string): number | undefined {
  if (style === undefined) return undefined;
  const value = style[field];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function readFirstLetterFloat(style: ComputedStyle | undefined): "left" | "right" | undefined {
  if (style === undefined) return undefined;
  const value = style["firstLetterFloat"];
  if (value === "left" || value === "right") return value;
  return undefined;
}

function readFirstLetterSize(style: ComputedStyle | undefined): number | undefined {
  if (style === undefined) return undefined;
  const value = style["firstLetterFontSize"];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** `::first-line` computed `font-size` in px. Absent ⇒ line 0 uses the run's font. */
function readFirstLineSize(style: ComputedStyle | undefined): number | undefined {
  if (style === undefined) return undefined;
  const value = style["firstLineFontSize"];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
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

/**
 * The computed `font-weight` as a number (100–900). `bold`/`bolder` map to 700,
 * `lighter` to 400 (relative weights need the parent weight — a flattened
 * approximation until the cascade resolves them against the parent).
 */
function readFontWeight(style: ComputedStyle): number {
  const value = style["fontWeight"];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
    if (value === "bold" || value === "bolder") return 700;
    if (value === "lighter") return 400;
  }
  return 400;
}

// ---------------------------------------------------------------------------
// Shaped-word plumbing (RFC 0002): a whitespace-free token is itemized into
// bidi level runs (engine-owned UAX #9 subset), the runs are L2-reordered into
// visual order, and each run is shaped once — direction + script passed to the
// injected {@link TextShaper} (the HarfBuzz adapter in the pipeline).
// ---------------------------------------------------------------------------

/**
 * One glyph of a shaped token: its draw position relative to the token start
 * (`dx` includes the shaper's `xOffset`; `dy` is the baseline-relative
 * `yOffset`, CSS down-positive), real `glyphId`/`faceIndex`, and pen advance
 * including this glyph's share of `letter-spacing`.
 */
interface ShapedWordGlyph {
  readonly glyphId: number;
  readonly faceIndex: number;
  readonly dx: number;
  readonly dy: number;
  readonly advance: number;
}

/**
 * UTF-16 span length of each cluster in a shaped run — the spacing unit
 * `letter-spacing` distributes over. Cluster starts partition the run text;
 * a cluster's span is up to the next cluster start (or the run's end).
 */
function clusterSpanLengths(clusters: readonly number[], textLength: number): Map<number, number> {
  const starts = [...new Set(clusters)].sort((a, b) => a - b);
  const spans = new Map<number, number>();
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i]!;
    const end = i + 1 < starts.length ? starts[i + 1]! : textLength;
    spans.set(start, end - start);
  }
  return spans;
}

/**
 * The element's base writing direction for bidi itemization (`direction`,
 * inherited). Undefined ⇒ the UAX #9 first-strong-character rule.
 */
function readDirection(style: ComputedStyle): "ltr" | "rtl" | undefined {
  const v = style["direction"];
  return v === "rtl" ? "rtl" : v === "ltr" ? "ltr" : undefined;
}

/** `direction` as an optional object spread — exactOptionalPropertyTypes-safe. */
function directionProp(style: ComputedStyle): { direction?: "ltr" | "rtl" } {
  const d = readDirection(style);
  return d === undefined ? {} : { direction: d };
}

/**
 * The `unicode-bidi` keyword, normalized (`isolate override` →
 * `isolate-override`); absent/invalid ⇒ `normal` (CSS Writing Modes §2).
 */
function unicodeBidiKeyword(style: ComputedStyle): string {
  const v = style["unicodeBidi"];
  return typeof v === "string" ? v.trim().toLowerCase().replace(/\s+/g, "-") : "normal";
}

/**
 * The explicit-format codes a container's own `unicode-bidi` wraps its inline
 * content in (UAX #9 X rules): `bidi-override` ⇒ LRO/RLO…PDF,
 * `isolate-override` ⇒ LRI/RLI + LRO/RLO…PDF+PDI. `embed`/`isolate`/`normal`
 * need no interior wrap — their effect lives at the box's outer boundary.
 */
function containerBidiWrap(
  style: ComputedStyle,
  ubidi: string,
): { readonly open: string; readonly close: string } | null {
  const rtl = readDirection(style) === "rtl";
  const c = String.fromCodePoint;
  switch (ubidi) {
    case "bidi-override":
      return { open: c(rtl ? BIDI_CTRL.RLO : BIDI_CTRL.LRO), close: c(BIDI_CTRL.PDF) };
    case "isolate-override":
      return {
        open: c(rtl ? BIDI_CTRL.RLI : BIDI_CTRL.LRI) + c(rtl ? BIDI_CTRL.RLO : BIDI_CTRL.LRO),
        close: c(BIDI_CTRL.PDF) + c(BIDI_CTRL.PDI),
      };
    default:
      return null;
  }
}

/**
 * The `ShapingFont.css` block (RFC 0005): the computed font-selection strings
 * carried verbatim — the font package parses/interprets them, layout only
 * relays. Omitted fields keep the property's initial value.
 */
function fontSelection(style: ComputedStyle): CssFontSelection {
  const str = (key: string): string | undefined => {
    const v = style[key];
    return typeof v === "string" && v.trim() !== "" ? v : undefined;
  };
  const out: {
    family?: string;
    style?: string;
    stretch?: string;
    kerning?: string;
    variantLigatures?: string;
    variantCaps?: string;
    variantPosition?: string;
    variantEastAsian?: string;
    variantAlternates?: string;
    variantNumeric?: string;
    featureSettings?: string;
    variationSettings?: string;
    opticalSizing?: string;
    synthesis?: string;
  } = {};
  const family = str("fontFamily");
  if (family !== undefined && family.toLowerCase() !== "sans-serif") out.family = family;
  const fontStyle = str("fontStyle");
  if (fontStyle !== undefined && fontStyle !== "normal") out.style = fontStyle;
  const stretch = str("fontStretch");
  if (stretch !== undefined && stretch !== "normal") out.stretch = stretch;
  const kerning = str("fontKerning");
  if (kerning !== undefined && kerning !== "auto") out.kerning = kerning;
  const grabIfNotNormal = (key: string, field: keyof typeof out): void => {
    const v = str(key);
    if (v !== undefined && v !== "normal") out[field] = v;
  };
  grabIfNotNormal("fontVariantLigatures", "variantLigatures");
  grabIfNotNormal("fontVariantCaps", "variantCaps");
  grabIfNotNormal("fontVariantPosition", "variantPosition");
  grabIfNotNormal("fontVariantEastAsian", "variantEastAsian");
  grabIfNotNormal("fontVariantAlternates", "variantAlternates");
  grabIfNotNormal("fontVariantNumeric", "variantNumeric");
  const featureSettings = str("fontFeatureSettings");
  if (featureSettings !== undefined && featureSettings !== "normal") {
    out.featureSettings = featureSettings;
  }
  const variationSettings = str("fontVariationSettings");
  if (variationSettings !== undefined && variationSettings !== "normal") {
    out.variationSettings = variationSettings;
  }
  const opticalSizing = str("fontOpticalSizing");
  if (opticalSizing !== undefined && opticalSizing !== "auto") {
    out.opticalSizing = opticalSizing;
  }
  const synthesis = str("fontSynthesis");
  if (synthesis !== undefined && synthesis !== "weight style small-caps") {
    out.synthesis = synthesis;
  }
  return out;
}

/**
 * `font-synthesis` → whether fake emboldening is allowed (RFC 0006).
 * `auto`/`""` ⇒ spec initial (`weight style small-caps`) ⇒ allowed; `none`
 * ⇒ none; otherwise the `weight` token decides.
 */
export function synthesizeBoldAllowed(css: CssFontSelection | undefined): boolean {
  const v = (css?.synthesis ?? "auto").trim().toLowerCase();
  if (v === "" || v === "auto") return true;
  if (v === "none") return false;
  return v.split(/\s+/).includes("weight");
}

/** `font-synthesis` allows a synthetic italic shear. Initial `auto` allows it. */
export function synthesizeStyleAllowed(css: CssFontSelection | undefined): boolean {
  const v = (css?.synthesis ?? "auto").trim().toLowerCase();
  if (v === "" || v === "auto") return true;
  if (v === "none") return false;
  return v.split(/\s+/).includes("style");
}

/**
 * Split `text` into whitespace-free tokens in VISUAL order: bidi-itemize the
 * whole string first (`bidiVisualRuns` applies UAX #9 L2 across the runs), then
 * split each run's text on whitespace — reversing the word order of odd-level
 * (RTL) runs. This is what makes multi-word RTL text come out right: "שלום
 * עולם" yields its words right-to-left, not merely each word internally
 * reversed. (The per-word shaping then re-itemizes each token for its own
 * internal run order.)
 */
function visualWords(text: string, direction: "ltr" | "rtl" | undefined): string[] {
  const words: string[] = [];
  for (const run of bidiVisualRuns(text, direction)) {
    const ws = run.text.split(/\s+/).filter((w) => w.length > 0);
    if (run.level % 2 === 1) ws.reverse();
    words.push(...ws);
  }
  return words;
}

/**
 * Shape one whitespace-free token: bidi-itemize → visual order → shape each
 * run once (`shapeLine` sees the whole run — kerning/ligatures/contextual
 * forms work). `letter-spacing` is distributed per SOURCE CLUSTER (its span
 * length × the value lands on the cluster's last output glyph), so the token
 * width stays `Σ advances + letterSpacing × word.length` — identical to the
 * pre-shaping accounting, now driven by real shaped positions.
 */
function shapeWordUnits(
  shaper: TextShaper,
  word: string,
  font: ShapingFont,
  letterSpacing: number,
): { readonly glyphs: readonly ShapedWordGlyph[]; readonly advance: number } {
  const glyphs: ShapedWordGlyph[] = [];
  let pen = 0;
  for (const run of bidiVisualRuns(word, font.direction)) {
    const shaped = shaper.shapeLine(run.text, {
      ...font,
      direction: run.level % 2 === 1 ? "rtl" : "ltr",
      script: runScriptTag(run.text),
    });
    const spans = clusterSpanLengths(
      shaped.glyphs.map((g) => g.cluster),
      run.text.length,
    );
    for (let i = 0; i < shaped.glyphs.length; i += 1) {
      const g = shaped.glyphs[i]!;
      const lastOfCluster =
        i + 1 === shaped.glyphs.length || shaped.glyphs[i + 1]!.cluster !== g.cluster;
      const spacing = lastOfCluster ? letterSpacing * (spans.get(g.cluster) ?? 0) : 0;
      const advance = Number(g.advance) + spacing;
      glyphs.push({
        glyphId: g.glyphId,
        faceIndex: g.faceIndex,
        dx: pen + Number(g.xOffset),
        dy: Number(g.yOffset),
        advance,
      });
      pen += advance;
    }
  }
  return { glyphs, advance: pen };
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

/**
 * Whether the `white-space` keyword preserves NEWLINES as hard breaks
 * (`pre`, `pre-wrap`, `pre-line`, `break-spaces`; CSS Text §4.1). `normal` /
 * `nowrap` collapse `\n` into a plain space (handled by the `\s+` tokenizer).
 */
function whiteSpaceKeepsNewlines(keyword: string): boolean {
  return keyword === "pre" || keyword === "pre-wrap" || keyword === "pre-line" || keyword === "break-spaces";
}

/**
 * Split text into visual-order words, and — for newline-preserving
 * `white-space` — interleave HARD BREAK markers at each `\n`. Each marker
 * forces a line box break even when the next word would have fitted (and even
 * when the line is empty, so `\n\n` yields a blank line of the member's
 * line-height). Space runs are still collapsed (multiple preserved spaces is
 * a documented `pre`/`break-spaces` limitation).
 */
/**
 * The CSS Text break keywords of a text run as {@link BreakOptions} for
 * {@link breakUnits} — `word-break`/`line-break`/`overflow-wrap`/`hyphens`
 * (all inherited, all already on the computed style).
 */
function breakOptionsOf(style: ComputedStyle): BreakOptions {
  const wb = typeof style["wordBreak"] === "string" ? style["wordBreak"] : "normal";
  const lb = typeof style["lineBreak"] === "string" ? style["lineBreak"] : "auto";
  const ow = typeof style["overflowWrap"] === "string" ? style["overflowWrap"] : "normal";
  const hy = typeof style["hyphens"] === "string" ? style["hyphens"] : "manual";
  return {
    ...(wb === "break-all" ? { breakAll: true } : {}),
    ...(wb === "keep-all" ? { keepAll: true } : {}),
    lineBreak:
      lb === "loose" || lb === "normal" || lb === "strict" || lb === "anywhere"
        ? lb
        : "auto",
    ...(ow === "anywhere" ? { anywhere: true } : {}),
    hyphens: hy === "none" || hy === "auto" ? hy : "manual",
  };
}

/**
 * Reverse a run's units for an odd (RTL) embedding level: unit ORDER flips
 * and each unit's `spaceBefore` migrates to the unit now FOLLOWING the gap —
 * the space stays between the same two units regardless of direction.
 */
function reverseUnits(units: readonly BreakUnit[]): BreakUnit[] {
  const out = units.slice().reverse();
  for (let i = 0; i < out.length; i += 1) {
    const src = units[units.length - 2 - i]; // logical predecessor of out[i]
    out[i] = { ...out[i]!, spaceBefore: src === undefined ? false : src.spaceBefore };
  }
  return out;
}

/**
 * Split text into visual-order {@link BreakUnit}s — whitespace folds into
 * `spaceBefore`, `\n`-class separators into `hardBreaksBefore`, ZW/SHY into
 * boundaries — via {@link breakUnits} applied per bidi fragment (UAX #14
 * pairing inside each level run, UAX #9 L2 ordering between them).
 */
function visualTokens(
  text: string,
  direction: "ltr" | "rtl" | undefined,
  preserveNewlines: boolean,
  wrap?: { readonly open: string; readonly close: string } | null,
  breakOpts?: BreakOptions,
): { readonly units: readonly BreakUnit[]; readonly trailingBreaks: number } {
  // Collapsing white-space modes fold the segment separators into a space
  // before bidi resolution; `pre` keeps them as B-class paragraph separators
  // (U+2028/U+2029 stay separators either way — UAX #9 B class).
  const src = preserveNewlines ? text : text.replace(/[\n\r\f]/g, " ");
  const pieces =
    wrap === undefined || wrap === null
      ? [{ text: src }]
      : [{ text: wrap.open }, { text: src }, { text: wrap.close }];
  const opts: BreakOptions = breakOpts ?? {};
  const out: BreakUnit[] = [];
  let prevEndsWs = false;
  let pendingHard = 0;
  for (const part of visualOrderParts(pieces, direction)) {
    if (part.hardBreak === true) {
      pendingHard += 1;
      prevEndsWs = false;
      continue;
    }
    let units = breakUnits(part.text, opts);
    if (part.level % 2 === 1) units = reverseUnits(units);
    for (let i = 0; i < units.length; i += 1) {
      const u = units[i]!;
      const spaceBefore =
        u.spaceBefore ||
        (i === 0 && (/^\s/.test(part.text) || prevEndsWs));
      const merged =
        pendingHard > 0 || spaceBefore !== u.spaceBefore
          ? {
              text: u.text,
              spaceBefore,
              hardBreaksBefore: u.hardBreaksBefore + pendingHard,
              shyAfter: u.shyAfter,
            }
          : u;
      out.push(merged);
      pendingHard = 0;
    }
    prevEndsWs = /\s$/.test(part.text);
  }
  return { units: out, trailingBreaks: pendingHard };
}

/**
 * The `text-indent` shift for a block's FIRST formatted line, in px. Lengths
 * pass through; `<percent>` resolves against the containing block's inline
 * size (CSS Text §3.6). Negative values shift the line start left of the box
 * edge (allowed; the line may overflow leftward).
 */
function readTextIndent(style: ComputedStyle | null, containingWidth: number): number {
  if (style === null) return 0;
  const raw = style["textIndent"];
  const len = readLengthOr(raw);
  if (len !== null) return len;
  const pct = percentOf(raw);
  return pct !== null ? (pct / 100) * containingWidth : 0;
}

/** A parsed `vertical-align` (CSS 2.1 §10.8.1): keyword, `<length>` raise, or
 * `<percent>` of the line box's own line-height. */
type VerticalAlign =
  | { readonly kind: "baseline" | "sub" | "super" | "top" | "text-top" | "middle" | "bottom" | "text-bottom" }
  | { readonly kind: "length"; readonly len: number }
  | { readonly kind: "percent"; readonly pct: number };

function readVerticalAlign(style: ComputedStyle | null): VerticalAlign {
  const raw = style === null ? undefined : style["verticalAlign"];
  if (typeof raw === "string") {
    const k = raw.trim().toLowerCase();
    switch (k) {
      case "baseline": case "sub": case "super": case "top":
      case "text-top": case "middle": case "bottom": case "text-bottom":
        return { kind: k };
      default: break;
    }
    const pct = /^(-?\d+(?:\.\d+)?)%$/.exec(k);
    if (pct !== null) return { kind: "percent", pct: Number(pct[1]) };
  }
  const len = readLengthOr(raw);
  if (len !== null) return { kind: "length", len };
  const pctObj = percentOf(raw);
  if (pctObj !== null) return { kind: "percent", pct: pctObj };
  return { kind: "baseline" };
}

/** `display` values that form a table row GROUP (CSS 2.1 §17.2.1). */
const TABLE_GROUP_DISPLAYS: ReadonlySet<string> = new Set([
  "table-row-group",
  "table-header-group",
  "table-footer-group",
]);

/** An HTML `colspan`/`rowspan` attribute → a clamped positive integer. */
function clampSpan(raw: string | undefined): number {
  const n = raw === undefined ? 1 : Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.min(1000, Math.floor(n)) : 1;
}

/** `border-collapse` — `collapse` removes all inter-cell spacing. */
function readBorderCollapse(style: ComputedStyle): boolean {
  return typeof style["borderCollapse"] === "string" && style["borderCollapse"].trim() === "collapse";
}

/**
 * `border-spacing: <h> [<v>]` in px — spacing between cells AND between cells
 * and the table edge (CSS 2.1 §17.6.1); a single value sets both.
 */
function readBorderSpacing(style: ComputedStyle): { h: number; v: number } {
  const raw = style["borderSpacing"];
  const parts = typeof raw === "string" ? raw.trim().split(/\s+/).filter(Boolean) : [];
  const h = parts.length > 0 ? readGapLength(parts[0], 0) : readGapLength(raw, 0);
  const v = parts.length > 1 ? readGapLength(parts[1]!, 0) : h;
  return { h, v };
}

/** `table-layout` — `fixed` sizes columns from the first row only. */
function readTableLayout(style: ComputedStyle): string {
  const v = style["tableLayout"];
  return typeof v === "string" ? v.trim() : "auto";
}

/**
 * The atomic box's margin-box TOP for its `vertical-align` inside a line box
 * `[lineTop, lineBottom]` with `baseline` at `lineTop + ascent` (CSS 2.1
 * §10.8.1). An atomic's baseline is approximated by its bottom margin edge
 * (the spec rule for an inline-block with no text baseline inside). `middle`
 * uses the x-height/2 ≈ 0.25em approximation; `sub`/`super` shift the baseline
 * by 0.2em/0.33em. `<length>` and `<percent>` raise the box ABOVE baseline.
 */
/**
 * The atomic box's baseline offset from its own margin-box TOP (CSS 2.1
 * §10.8.1): `useTextBaseline` ⇒ `contentTop + 0.8em` (the strut/first-line
 * baseline approximation — a real `ascentEm` rides on the member when the
 * shaper supplies one); otherwise the bottom margin edge (the spec rule for
 * an inline-block / replaced box with no in-flow line box).
 */
function atomicBaselineOff(frag: Fragment, style: ComputedStyle, useTextBaseline: boolean): number {
  if (!useTextBaseline) {
    return Number(frag.box.marginBox.height);
  }
  const contentTop = Number(frag.box.contentBox.y) - Number(frag.box.marginBox.y);
  return contentTop + 0.8 * Number(style.fontSize);
}

/**
 * The atomic box's margin-box TOP for its `vertical-align` inside a line box
 * `[lineTop, lineBottom]` with the text baseline at `baseline`. `baselineOff`
 * is the box's own baseline distance from its margin-box top (see
 * {@link atomicBaselineOff}); `middle` aligns the box's CENTRE to
 * baseline + x-height/2 (≈0.25em); `sub`/`super` shift the baseline by
 * 0.2em/0.33em; `<length>`/`<percent>` raise the box's baseline upward.
 */
function verticalAlignTop(
  va: VerticalAlign,
  atomicH: number,
  baselineOff: number,
  fontSize: number,
  lineTop: number,
  lineBottom: number,
  baselineDelta: number,
  lineHeight: number,
  xHeight?: number,
  script?: { sub?: number; super?: number },
): number {
  // baselineDelta is `baseline − lineTop` measured BEFORE the line-top addition
  // so `lineTop + (baselineDelta − baselineOff)` cancels exactly (baseline =
  // lineTop + 0.8em, baselineOff = contentTop + 0.8em → no float residue).
  const middleRise = xHeight !== undefined ? xHeight / 2 : fontSize * 0.25;
  switch (va.kind) {
    case "top":
      return lineTop;
    case "bottom":
      return lineBottom - atomicH;
    case "text-top":
      return lineTop + Math.max(0, (lineHeight - fontSize) / 2);
    case "text-bottom":
      return lineTop + (lineHeight + fontSize) / 2 - atomicH;
    case "middle":
      return lineTop + baselineDelta + middleRise - atomicH / 2;
    case "sub":
      return lineTop + (baselineDelta + (script?.sub ?? fontSize * 0.2) - baselineOff);
    case "super":
      return lineTop + (baselineDelta - (script?.super ?? fontSize * 0.33) - baselineOff);
    case "length":
      return lineTop + (baselineDelta - va.len - baselineOff);
    case "percent":
      return lineTop + (baselineDelta - (va.pct / 100) * lineHeight - baselineOff);
    case "baseline":
    default:
      return lineTop + (baselineDelta - baselineOff);
  }
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
function textAlignOffset(
  align: string,
  containingWidth: Px,
  contentWidth: Px,
  rtl: boolean,
): number {
  const slack = Math.max(0, containingWidth - contentWidth);
  switch (align) {
    case "right":
      return slack;
    case "left":
      return 0;
    case "end":
      return rtl ? 0 : slack;
    case "center":
      return slack / 2;
    default:
      return rtl ? slack : 0; // start / justify — the direction-aware start edge
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

/** A `calc()` value still carrying a percentage, duck-typed (no generator import). */
function isSizingCalc(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "specified-calc";
}

/**
 * Evaluate a sizing `calc()` against a percentage basis. Relative units other
 * than `%` stay unresolved here (the cascade already folded those when the
 * expression had no percentage). Returns `null` when a `%` has no definite basis.
 */
function evalSizingCalc(value: unknown, percentBasis: number | undefined): number | null {
  if (!isSizingCalc(value)) return null;
  const ast = (value as { ast?: unknown }).ast;
  const evalNode = (node: unknown): number | null => {
    if (typeof node !== "object" || node === null) return null;
    const n = node as { type?: unknown; value?: unknown; unit?: unknown; left?: unknown; right?: unknown };
    switch (n.type) {
      case "px":
      case "num":
        return typeof n.value === "number" && Number.isFinite(n.value) ? n.value : null;
      case "len": {
        if (typeof n.value !== "number" || !Number.isFinite(n.value)) return null;
        if (n.unit === "%") {
          if (percentBasis === undefined || !Number.isFinite(percentBasis) || percentBasis <= 0) return null;
          return (n.value / 100) * percentBasis;
        }
        return null;
      }
      case "add":
      case "sub":
      case "mul":
      case "div": {
        const left = evalNode(n.left);
        const right = evalNode(n.right);
        if (left === null || right === null) return null;
        if (n.type === "add") return left + right;
        if (n.type === "sub") return left - right;
        if (n.type === "mul") return left * right;
        return right === 0 ? null : left / right;
      }
      default:
        return null;
    }
  };
  return evalNode(ast);
}

/**
 * Whether `height` resolves without looking at content: a length, `stretch`
 * against a definite containing height, or a percentage / percentage-calc
 * against that same height. `auto` is indefinite.
 */
/** Preferred width/height from `aspect-ratio`, or null for `auto` / unparsable. */
function aspectRatioOf(style: ComputedStyle): number | null {
  const raw = style["aspectRatio"];
  if (typeof raw !== "string") return null;
  const text = raw.trim().toLowerCase();
  if (text === "" || text === "auto") return null;
  const match = /^(?:auto\s+)?(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+(?:\.\d+)?))?$/.exec(text);
  if (match === null) return null;
  const width = Number(match[1]);
  const height = match[2] === undefined ? 1 : Number(match[2]);
  if (!(width > 0) || !(height > 0)) return null;
  return width / height;
}

function isDefiniteBlockSize(declared: unknown, containingHeight: number | undefined): boolean {
  if (typeof declared === "number" && Number.isFinite(declared)) return true;
  const basisOk = containingHeight !== undefined && Number.isFinite(containingHeight) && containingHeight > 0;
  if (declared === "stretch") return basisOk;
  if (percentOf(declared) !== null) return basisOk;
  if (isSizingCalc(declared)) return evalSizingCalc(declared, containingHeight) !== null;
  return false;
}

/**
 * Resolve the content height (design.md §8.2 `resolveHeight`). A declared length
 * wins; `auto` (the initial value) is the accumulated child content height.
 * Under `border-box` a declared height is reduced by this box's own vertical
 * padding+border (zero insets ⇒ unchanged). `stretch` sizes the margin box to
 * the containing block. A percentage `calc()` resolves against that same height.
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
  const basisOk = containingHeight !== undefined && Number.isFinite(containingHeight) && containingHeight > 0;
  let content: number;
  if (declared === "stretch" && basisOk && containingHeight !== undefined) {
    const margin = resolveMargin(style);
    content = containingHeight - margin.top - margin.bottom - insetY;
  } else if (typeof declared === "number") {
    content = boxSizing === "border-box" ? declared - insetY : declared;
  } else {
    const pct = percentOf(declared);
    const calc = pct === null ? evalSizingCalc(declared, containingHeight) : null;
    if (pct !== null) {
      // `height: <percent>` resolves against the containing block's DEFINITE
      // height (passed in as `containingHeight`). When the containing height is
      // not definite (undefined / non-positive), the spec says the percentage
      // behaves as `auto` — fall through to the element's content height.
      if (!basisOk || containingHeight === undefined) {
        content = contentHeight;
      } else {
        content = boxSizing === "border-box" ? (pct * containingHeight) / 100 - insetY : (pct * containingHeight) / 100;
      }
    } else if (calc !== null) {
      content = boxSizing === "border-box" ? calc - insetY : calc;
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
  fragmentAt?: (id: FragmentId) => Fragment | undefined,
): Fragment | null {
  const declaredTop = readInsetValue(childStyle, "top", padCbH);
  const declaredLeft = readInsetValue(childStyle, "left", padCbW);
  const declaredBottom = readInsetValue(childStyle, "bottom", padCbH);
  const declaredRight = readInsetValue(childStyle, "right", padCbW);
  // A non-stretch self-alignment (or a table) sizes the automatic axis to the
  // content instead of stretching between the insets. Auto margins then share
  // whatever space is left.
  const fitBlock = fitsContentOnAxis(childStyle, "alignSelf");
  const fitInline = fitsContentOnAxis(childStyle, "justifySelf");
  let usedW = padCbW;
  let forceH: number | undefined;
  let topOffset: number;
  let leftOffset: number;
  if (declaredLeft !== null && declaredRight !== null && !fitInline) {
    usedW = Math.max(0, padCbW - declaredLeft - declaredRight);
    leftOffset = padEdgeLeft + declaredLeft;
  } else if (declaredLeft !== null) {
    leftOffset = padEdgeLeft + declaredLeft;
  } else if (declaredRight !== null) {
    leftOffset = padEdgeLeft;
  } else {
    leftOffset = staticLeft;
  }
  if (declaredTop !== null && declaredBottom !== null && !fitBlock) {
    forceH = Math.max(0, padCbH - declaredTop - declaredBottom);
    topOffset = padEdgeTop + declaredTop;
  } else if (declaredTop !== null) {
    topOffset = padEdgeTop + declaredTop;
  } else if (declaredBottom !== null) {
    topOffset = padEdgeTop;
  } else {
    topOffset = staticTop;
  }
  // The containing block's padding-box height is a definite percentage basis
  // for an abspos even when the CB's own height is content-sized (CSS 2.1
  // §10.5). `forceH` still wins only when top and bottom are both set.
  const childFrag = layoutNodeFn(childNodeId, px(usedW), padCbH, forceH);
  if (childFrag === null) return null;
  if (declaredLeft === null && declaredRight !== null) {
    leftOffset = padEdgeLeft + Math.max(0, padCbW - declaredRight - Number(childFrag.box.marginBox.width));
  }
  if (declaredTop === null && declaredBottom !== null && forceH === undefined) {
    topOffset = padEdgeTop + Math.max(0, padCbH - declaredBottom - Number(childFrag.box.marginBox.height));
  }
  if (fitBlock && declaredTop !== null && declaredBottom !== null) {
    const free = padCbH - declaredTop - declaredBottom - Number(childFrag.box.borderBox.height);
    const topAuto = childStyle?.["marginTop"] === "auto";
    const bottomAuto = childStyle?.["marginBottom"] === "auto";
    if (topAuto && bottomAuto) topOffset += free / 2;
    else if (topAuto && !bottomAuto) topOffset += free;
  }
  let sized = childFrag;
  if (fitInline && declaredLeft !== null && declaredRight !== null && fragmentAt !== undefined) {
    const contentW = Math.max(0, Number(sized.box.contentBox.x));
    let maxEdge = contentW;
    for (const childId of sized.children) {
      const child = fragmentAt(childId);
      if (child === undefined) continue;
      maxEdge = Math.max(maxEdge, Number(child.box.borderBox.x) + Number(child.box.borderBox.width));
    }
    const fitW = Math.max(0, maxEdge - contentW);
    if (fitW + 0.5 < Number(sized.box.borderBox.width)) {
      sized = setFragmentContentWidth(sized, fitW);
    }
  }
  if (fitInline && declaredLeft !== null && declaredRight !== null) {
    const free = padCbW - declaredLeft - declaredRight - Number(sized.box.borderBox.width);
    const leftAuto = childStyle?.["marginLeft"] === "auto";
    const rightAuto = childStyle?.["marginRight"] === "auto";
    if (leftAuto && rightAuto) leftOffset += Math.max(0, free) / 2;
    else if (leftAuto && !rightAuto) leftOffset += Math.max(0, free);
  }
  let placed = offsetFragment(sized, leftOffset, topOffset);
  if (forceH !== undefined && Number(placed.box.marginBox.height) < forceH - 0.5) {
    placed = stretchFragmentHeight(placed, forceH - Number(placed.box.marginBox.height));
  }
  return placed;
}

/** Abspos `align-self` / `justify-self` other than the stretch defaults, or a table. */
function fitsContentOnAxis(style: ComputedStyle | null, key: "alignSelf" | "justifySelf"): boolean {
  if (style === null) return false;
  const value = style[key];
  const align = typeof value === "string" ? value.trim().toLowerCase() : "auto";
  // Explicit stretch always stretch-fits, including tables (css-position-3 §4.1).
  if (align === "stretch") return false;
  // `auto` / `normal` stretch a non-replaced non-table box. A table wrapper's
  // automatic size stays fit-content under those keywords.
  if (readDisplay(style) === "table") return true;
  return align !== "auto" && align !== "normal";
}

function setFragmentContentWidth(frag: Fragment, width: number): Fragment {
  const box = frag.box;
  const extra = Number(box.borderBox.width) - Number(box.width);
  const marginExtra = Number(box.marginBox.width) - Number(box.borderBox.width);
  const padExtra = Number(box.paddingBox.width) - Number(box.width);
  return {
    ...frag,
    box: {
      ...box,
      width: px(width),
      contentBox: { ...box.contentBox, width: px(width) },
      paddingBox: { ...box.paddingBox, width: px(width + padExtra) },
      borderBox: { ...box.borderBox, width: px(width + extra) },
      marginBox: { ...box.marginBox, width: px(width + extra + marginExtra) },
    },
  };
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
  "ruby",
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
  // `ruby` is an inline-level box (CSS Ruby §2.1: the outer role is inline);
  // the internal roles normalize to `inline` in readDisplay anyway.
  return display === "inline" || display === "inline-block" || display === "ruby";
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

/**
 * How a laid-out node participates in a shared block formatting context
 * (RFC 0003): `bfc` is the registry its block box lives in, and `originX` /
 * `originY` give the node's MARGIN-BOX top-left in BFC coordinates — known to
 * the caller before layout, so descendants can query float intrusion at their
 * own position. A block that establishes its own BFC still receives `fc` (the
 * parent needs the coordinates for narrowing) but does not share the registry.
 */
interface FlowCtx {
  readonly bfc: BlockFormattingContext;
  readonly originX: number;
  readonly originY: number;
}

/**
 * Whether `style` establishes a NEW block formatting context (CSS 2.1 §9.4.1
 * subset, RFC 0003): floats, absolutely-positioned boxes, `overflow` ≠
 * `visible|clip`, and `display:inline-block`. Flex/grid/table/multicol
 * containers establish their own (non-block) formatting contexts and never
 * reach `layoutBlock`, so they are not listed here. A BFC root never shares
 * its parent's float registry or margin-collapse chain.
 */
function establishesBfc(style: ComputedStyle): boolean {
  if (readFloat(style) !== "none") return true;
  const position = readPosition(style);
  if (position === "absolute" || position === "fixed") return true;
  // CSS 2.1 §9.4.1: overflow non-visible on EITHER axis establishes a BFC.
  for (const key of ["overflow", "overflowX", "overflowY"] as const) {
    const v = style[key];
    if (typeof v === "string" && v !== "visible" && v !== "clip") {
      return true;
    }
  }
  return style["display"] === "inline-block";
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
function readInsets(
  style: ComputedStyle | null,
  cbWidth?: number,
  cbHeight?: number | null,
): { readonly top: number; readonly left: number } {
  if (style === null) {
    return { top: 0, left: 0 };
  }
  const top = readInsetValue(style, "top", cbHeight ?? null);
  const left = readInsetValue(style, "left", cbWidth ?? null);
  const bottom = readInsetValue(style, "bottom", cbHeight ?? null);
  const right = readInsetValue(style, "right", cbWidth ?? null);
  return {
    top: top !== null ? top : bottom !== null ? -bottom : 0,
    left: left !== null ? left : right !== null ? -right : 0,
  };
}

/**
 * One inset edge (`top`/`right`/`bottom`/`left`) resolved to px: numbers and
 * `px` strings pass through; `<percent>` resolves against `percentBase` (the
 * containing block's size in that axis — `null`/indefinite ⇒ the percentage
 * is unresolvable and treated as absent per spec for indefinite CB heights).
 */
function readInsetValue(
  style: ComputedStyle | null,
  key: "top" | "right" | "bottom" | "left",
  percentBase: number | null,
): number | null {
  if (style === null) return null;
  const raw = style[key];
  const n = readLengthOr(raw);
  if (n !== null) return n;
  const pct = percentOf(raw);
  if (pct !== null && percentBase !== null) return (pct / 100) * percentBase;
  return null;
}

/** The computed `z-index` integer; `auto`/absent/non-integer ⇒ 0 (the
 * stacking level of an `auto` positioned box in sibling paint order). */
function readZIndex(style: ComputedStyle | null): number {
  if (style === null) return 0;
  const v = style["zIndex"];
  return typeof v === "number" && Number.isInteger(v) ? v : 0;
}

/** Whether the style carries a non-`none` transform — the `transform` matrix
 * (a live 6-tuple; `%`-translate is rejected by the value grammar) OR any of
 * the individual transform properties `translate`/`rotate`/`scale`
 * (Transforms L2). Transforms §4: any transformed element is a containing
 * block for `absolute` AND `fixed` descendants. */
function hasTransform(style: ComputedStyle | null): boolean {
  if (style === null) return false;
  const v = style["transform"];
  if (Array.isArray(v) && v.length === 6) return true;
  for (const key of ["translate", "rotate", "scale"] as const) {
    const s = style[key];
    if (typeof s === "string" && s.trim() !== "" && s.trim() !== "none") return true;
  }
  return false;
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
function readFlexDirection(style: ComputedStyle): "row" | "row-reverse" | "column" | "column-reverse" {
  const v = style["flexDirection"];
  return v === "column" || v === "column-reverse" || v === "row-reverse" ? v : "row";
}

/**
 * A flex item's `flex-basis` in px (`auto`/`content`/absent ⇒ `null`). A
 * percentage basis resolves against the container's definite main size.
 */
function readFlexBasis(style: ComputedStyle, containerMain?: number): number | null {
  const v = style["flexBasis"];
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, v);
  const pct = percentOf(v);
  if (pct !== null && containerMain !== undefined && Number.isFinite(containerMain) && containerMain > 0) {
    return Math.max(0, (pct * containerMain) / 100);
  }
  return null;
}

/** `flex-shrink` factor (initial 1; clamped ≥ 0). */
function readFlexShrink(style: ComputedStyle): number {
  const v = style["flexShrink"];
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : 1;
}

/** `align-self` (initial `auto` — defer to the container's align-items). */
function readAlignSelf(style: ComputedStyle): string {
  const v = style["alignSelf"];
  return typeof v === "string" ? v : "auto";
}

/** `align-content` (initial `stretch`). */
function readAlignContent(style: ComputedStyle): string {
  const v = style["alignContent"];
  return typeof v === "string" ? v : "stretch";
}

/**
 * The element's declared content `height` in px, or `null` when `auto`/absent
 * or a percentage against an indefinite containing height (which behaves as
 * `auto` — CSS 2.1 §10.5). Mirrors {@link declaredWidthOf}.
 */
function declaredHeightOf(style: ComputedStyle, containingHeight?: number): number | null {
  const declared = style["height"];
  if (typeof declared === "number" && Number.isFinite(declared)) return Math.max(0, declared);
  const pct = percentOf(declared);
  if (pct !== null && containingHeight !== undefined && Number.isFinite(containingHeight) && containingHeight > 0) {
    return Math.max(0, (pct * containingHeight) / 100);
  }
  return null;
}

/**
 * The element's DEFINITE content height in px when `height` resolves to a
 * usable size (a length, or a percentage against a definite containing
 * height), else `undefined` (auto ⇒ content-driven).
 */
function definiteHeightOf(
  style: ComputedStyle,
  padding: Edges<Px>,
  border: Edges<Px>,
  containingHeight?: number,
): number | undefined {
  const declared = style["height"];
  if (typeof declared !== "number" && percentOf(declared) === null) return undefined;
  if (percentOf(declared) !== null && (containingHeight === undefined || containingHeight <= 0)) {
    return undefined;
  }
  const resolved = resolveHeight(style, px(0), padding, border, containingHeight);
  return Number(resolved);
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
function readFlexWrap(style: ComputedStyle): "nowrap" | "wrap" | "wrap-reverse" {
  const value = style["flexWrap"];
  return value === "wrap" || value === "wrap-reverse" ? value : "nowrap";
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

type GridTrack =
  | { readonly kind: "px"; readonly size: number }
  | { readonly kind: "percent"; readonly pct: number }
  | { readonly kind: "fr"; readonly fr: number }
  | { readonly kind: "auto" }
  | { readonly kind: "minmax"; readonly min: GridTrack; readonly max: GridTrack }
  | { readonly kind: "auto-repeat"; readonly mode: "fill" | "fit"; readonly tracks: readonly GridTrack[] };

function trackMinDefinite(track: GridTrack, width: number): number | null {
  if (track.kind === "px") return track.size;
  if (track.kind === "percent") return (track.pct / 100) * width;
  if (track.kind === "minmax") return trackMinDefinite(track.min, width);
  return null;
}

/**
 * Expand `repeat(auto-fill|auto-fit, …)` against a definite width. The count is
 * the largest number of copies whose minimum size fits; a track with no
 * definite minimum is repeated once. `fit` is reported so empty copies can
 * collapse after placement.
 */
function expandAutoRepeats(
  list: readonly GridTrack[],
  width: number,
  gap: number,
): { tracks: GridTrack[]; fit: boolean } {
  const idx = list.findIndex((track) => track.kind === "auto-repeat");
  if (idx < 0) return { tracks: [...list], fit: false };
  const rep = list[idx]!;
  if (rep.kind !== "auto-repeat") return { tracks: [...list], fit: false };
  const flatten = (tracks: readonly GridTrack[]): GridTrack[] =>
    tracks.flatMap((track) => (track.kind === "auto-repeat" ? [...track.tracks] : [track]));
  const fixed = flatten([...list.slice(0, idx), ...list.slice(idx + 1)]);
  const pattern = flatten(rep.tracks);
  const patternDefinite = pattern.length > 0 && pattern.every((track) => trackMinDefinite(track, width) !== null);
  const patternMin = pattern.reduce((sum, track) => sum + (trackMinDefinite(track, width) ?? 0), 0);
  const fixedSize = fixed.reduce((sum, track) => sum + (trackMinDefinite(track, width) ?? 0), 0);
  const inner = patternMin + gap * Math.max(0, pattern.length - 1);
  let count = 1;
  if (patternDefinite && inner > 0) {
    const available = Math.max(0, width - fixedSize - gap * Math.max(0, fixed.length - 1));
    count = Math.max(1, Math.floor((available + gap) / (inner + gap)));
  }
  const repeated: GridTrack[] = [];
  for (let n = 0; n < count; n += 1) repeated.push(...pattern);
  return {
    tracks: [...flatten(list.slice(0, idx)), ...repeated, ...flatten(list.slice(idx + 1))],
    fit: rep.mode === "fit",
  };
}

function parseOneTrackToken(token: string): GridTrack {
  const t = token.trim();
  if (t === "auto") {
    return { kind: "auto" };
  }
  const pxMatch = /^(-?\d+(?:\.\d+)?)px$/i.exec(t);
  if (pxMatch !== null) {
    return { kind: "px", size: Math.max(0, Number(pxMatch[1])) };
  }
  const pctMatch = /^(-?\d+(?:\.\d+)?)%$/.exec(t);
  if (pctMatch !== null) {
    return { kind: "percent", pct: Math.max(0, Number(pctMatch[1])) };
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

/** Split a track list on top-level spaces (respecting `minmax()`/`repeat()` parens and `[line]` brackets). */
function splitTrackTokens(s: string): string[] {
  const tokens: string[] = [];
  let paren = 0;
  let bracket = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") paren += 1;
    else if (ch === ")") paren -= 1;
    else if (ch === "[") bracket += 1;
    else if (ch === "]") bracket -= 1;
    if (/\s/.test(ch) && paren === 0 && bracket === 0) {
      if (cur.length > 0) tokens.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.length > 0) tokens.push(cur);
  return tokens;
}

function parseTrackList(source: string, lines: Map<string, number[]> | null): GridTrack[] {
  const tracks: GridTrack[] = [];
  const noteLines = (token: string): void => {
    if (lines === null) return;
    const inner = token.slice(1, -1).trim();
    if (inner.length === 0) return;
    const line = tracks.length + 1;
    for (const name of inner.split(/\s+/)) {
      if (name.length === 0) continue;
      const at = lines.get(name) ?? [];
      at.push(line);
      lines.set(name, at);
    }
  };
  for (const token of splitTrackTokens(source)) {
    if (/^\[.*\]$/.test(token)) {
      noteLines(token);
      continue;
    }
    const rep = /^repeat\(\s*(\d+)\s*,(.*)\)$/is.exec(token);
    if (rep !== null) {
      const count = Math.max(0, Math.floor(Number(rep[1])));
      const repeated = parseGridTracks(rep[2]!.trim());
      for (let n = 0; n < count; n += 1) tracks.push(...repeated);
      continue;
    }
    const repAuto = /^repeat\(\s*(auto-fill|auto-fit)\s*,(.*)\)$/is.exec(token);
    if (repAuto !== null) {
      tracks.push({
        kind: "auto-repeat",
        mode: repAuto[1] === "auto-fit" ? "fit" : "fill",
        tracks: parseGridTracks(repAuto[2]!.trim()),
      });
      continue;
    }
    const mm = /^minmax\(\s*(.*?)\s*,\s*(.*?)\s*\)$/is.exec(token);
    if (mm !== null) {
      const minT = parseGridTracks(mm[1]!)[0] ?? { kind: "auto" as const };
      const maxT = parseGridTracks(mm[2]!)[0] ?? { kind: "auto" as const };
      tracks.push({ kind: "minmax", min: minT, max: maxT });
      continue;
    }
    tracks.push(parseOneTrackToken(token));
  }
  return tracks;
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
        const tracks = parseGridTracks(entry);
        return tracks.length === 1 ? tracks[0]! : { kind: "fr" as const, fr: 1 };
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
    const tracks = parseTrackList(s, null);
    return tracks.length > 0 ? tracks : [{ kind: "fr", fr: 1 }];
  }
  return [{ kind: "fr", fr: 1 }];
}

/**
 * Resolve one NON-flexible track (px/%/minmax-fixed) to a length in `budget`;
 * `fr` and content-driven `auto`/`minmax(auto,*)` return `null` — the caller
 * splits the remaining space among `fr`s or measures content.
 */
function resolveOneTrack(t: GridTrack, budget: number): number | null {
  switch (t.kind) {
    case "px":
      return Math.max(0, t.size);
    case "percent":
      return Math.max(0, (t.pct / 100) * budget);
    case "minmax": {
      const min = resolveOneTrack(t.min, budget);
      const max = resolveOneTrack(t.max, budget);
      if (min === null || max === null) return null; // flexible bound
      return Math.max(min, max); // minmax(a, b) ≥ a; clamped by the caller's max
    }
    default:
      return null;
  }
}

/**
 * Resolve a track list against a definite `budget`: fixed tracks keep their
 * size, `fr` splits the remainder, and `auto` COLUMNS are treated as `1fr`
 * (documented approximation — no intrinsic max-content pass).
 */
function resolveTrackSizes(tracks: readonly GridTrack[], budget: number): number[] {
  if (tracks.length === 0) {
    return [Math.max(0, budget)];
  }
  let fixed = 0;
  let frSum = 0;
  const mins: (number | null)[] = [];
  for (const t of tracks) {
    const v = resolveOneTrack(t, budget);
    if (t.kind === "fr") {
      frSum += t.fr;
      mins.push(null);
      continue;
    }
    if (t.kind === "auto") {
      frSum += 1; // auto columns ≈ 1fr
      mins.push(null);
      continue;
    }
    if (t.kind === "minmax") {
      const min = resolveOneTrack(t.min, budget);
      const maxR = resolveOneTrack(t.max, budget);
      if (maxR !== null) {
        const size = Math.max(min ?? 0, maxR);
        fixed += size;
        mins.push(size);
        continue;
      }
      // minmax(min, fr|auto): min is fixed floor, max flexes
      if (t.max.kind === "fr") frSum += t.max.fr;
      else frSum += 1;
      mins.push(min ?? 0);
      continue;
    }
    fixed += v ?? 0;
    mins.push(v ?? 0);
  }
  const free = Math.max(0, budget - fixed);
  const unit = frSum > 0 ? free / frSum : 0;
  return tracks.map((t, i) => {
    if (t.kind === "fr") return t.fr * unit;
    if (t.kind === "auto") return unit;
    if (t.kind === "minmax") {
      const min = mins[i] ?? 0;
      const flex = t.max.kind === "fr" ? t.max.fr * unit : t.max.kind === "auto" ? unit : 0;
      const maxR = resolveOneTrack(t.max, budget);
      return Math.max(min, maxR ?? flex);
    }
    return mins[i] ?? 0;
  });
}

interface GridAreaRect {
  readonly col: number;
  readonly row: number;
  readonly colSpan: number;
  readonly rowSpan: number;
}

/** `"a a" "b c"` → rectangular named areas. A non-rectangular name is dropped. */
function parseTemplateAreas(value: unknown): { cols: number; rows: number; names: Map<string, GridAreaRect> } | null {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim() === "none") return null;
  const quoted = [...value.matchAll(/"([^"]*)"|'([^']*)'/g)].map((match) => (match[1] ?? match[2] ?? "").trim());
  const rows = (quoted.length > 0 ? quoted : value.split("/").map((part) => part.trim())).filter((row) => row.length > 0);
  const cells = rows.map((row) => row.split(/\s+/).filter((cell) => cell.length > 0));
  const cols = cells[0]?.length ?? 0;
  if (cols === 0 || cells.some((row) => row.length !== cols)) return null;
  const hits = new Map<string, { r: number; c: number }[]>();
  for (let r = 0; r < cells.length; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const name = cells[r]![c]!;
      if (name === ".") continue;
      const list = hits.get(name) ?? [];
      list.push({ r, c });
      hits.set(name, list);
    }
  }
  const names = new Map<string, GridAreaRect>();
  for (const [name, list] of hits) {
    const minR = Math.min(...list.map((cell) => cell.r));
    const maxR = Math.max(...list.map((cell) => cell.r));
    const minC = Math.min(...list.map((cell) => cell.c));
    const maxC = Math.max(...list.map((cell) => cell.c));
    if ((maxR - minR + 1) * (maxC - minC + 1) !== list.length) continue;
    names.set(name, { col: minC, row: minR, colSpan: maxC - minC + 1, rowSpan: maxR - minR + 1 });
  }
  return { cols, rows: cells.length, names };
}

function parseGridTemplate(value: unknown): { tracks: GridTrack[]; lines: Map<string, number[]> } {
  const lines = new Map<string, number[]>();
  if (typeof value === "string") {
    const s = value.trim();
    if (s.length > 0 && !/^\d+$/.test(s)) {
      const tracks = parseTrackList(s, lines);
      return { tracks: tracks.length > 0 ? tracks : [{ kind: "fr", fr: 1 }], lines };
    }
  }
  return { tracks: parseGridTracks(value), lines };
}

function lineIndex(token: string, lines: ReadonlyMap<string, number[]>): number | null {
  if (/^\d+$/.test(token)) {
    const n = Number(token);
    return n > 0 ? n : null;
  }
  return lines.get(token)?.[0] ?? null;
}

function parseGridPlacement(value: unknown, lines: ReadonlyMap<string, number[]> = new Map()): { start: number | null; span: number } {
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
    const start = Math.min(a, b);
    return { start, span: Math.max(1, Math.abs(b - a)) };
  }
  const startSpan = /^([^\s/]+)\s*\/\s*span\s+(\d+)$/i.exec(raw);
  if (startSpan !== null) {
    const start = lineIndex(startSpan[1]!, lines);
    if (start !== null) return { start, span: Math.max(1, Number(startSpan[2])) };
  }
  const pair = /^([^\s/]+)\s*\/\s*([^\s/]+)$/.exec(raw);
  if (pair !== null) {
    const a = lineIndex(pair[1]!, lines);
    const b = lineIndex(pair[2]!, lines);
    if (a !== null && b !== null) {
      const start = Math.min(a, b);
      return { start, span: Math.max(1, Math.abs(b - a)) };
    }
  }
  const single = lineIndex(raw, lines);
  if (single !== null) return { start: single, span: 1 };
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
