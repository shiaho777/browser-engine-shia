/**
 * @browser-engine/paint
 *
 * Paint engine (design.md §4.1, §8.6; Requirement 3.5). The query `qPaint`
 * consumes the frozen {@link FragmentTree} (geometry) + per-node
 * {@link ComputedStyle} (paint) and emits the {@link DisplayList} IR — a
 * backend-agnostic sequence of abstract paint commands (rect / text / border /
 * …). The Paint_Backend later consumes ONLY this DisplayList; paint never hands
 * an upstream IR handle to it, so reverse reads are structurally impossible
 * (Requirement 3.5). To make that boundary physically true, every command
 * carries FRESH plain geometry/colour values copied out of the FragmentTree,
 * never a reference into the fragment graph.
 *
 * ## Phase 1 minimal scope (task 3.10; Requirement 3.5)
 *
 * This pass completes the end-to-end vertical slice (`<div>hello</div>` → … →
 * DisplayList) and is extended in task 5.8 (Requirement 15.4) to emit display
 * commands for text, borders, AND backgrounds. It walks the FragmentTree in
 * tree order (document order) and, for each fragment, emits commands in **paint
 * order** — background, then border, then text/content; ancestors before
 * descendants; earlier siblings before later ones:
 *
 *   - **background** — a `rect` command for any fragment whose computed
 *     `background-color` is not transparent (alpha > 0), filling the fragment's
 *     `borderBox`. Text nodes inherit no `background-color` (it is a
 *     non-inherited property whose initial value is transparent), so they emit
 *     no background.
 *   - **border** — a `border` command carrying the fragment's `borderBox` and
 *     the four computed {@link BorderSide} edges, emitted for any fragment whose
 *     style carries a well-formed border descriptor (see "Border emission"
 *     below). A fragment with no (or a malformed) border descriptor emits no
 *     `border` command — we never fabricate a border for an element that has
 *     none.
 *   - **text** — a `text` command for every *leaf* fragment (one with no
 *     children). In the Phase 1 FragmentTree a leaf is, in practice, a text
 *     node's minimal line box (an empty element leaf emits a harmless
 *     empty-glyph command). The command carries the leaf's box origin as `at`
 *     and the node's computed `color` as `fill`.
 *
 * ## Border emission — reading the descriptor (Requirement 15.4)
 *
 * The cascade `generator` does NOT yet emit `border-*` properties into the
 * ComputedStyle property table (it emits only color / display / width / height /
 * margin / background-color / font-size), so real cascade output carries no
 * border fields. Rather than block the `border` command on that pending
 * generator work, the emission path reads a border descriptor **defensively**
 * off ComputedStyle's open `[k: string]: unknown` index signature (the `border`
 * key): it narrows `unknown` → `Edges<BorderSide>` only when the value is
 * present and well-formed (every edge a `{ width, style, color }` triple with a
 * recognised border `style` keyword), and otherwise emits nothing. The
 * resulting command uses the fragment's `borderBox`.
 *
 * Because the generator does not produce a `border` field today, this path
 * emits nothing for documents driven by the real cascade (so `<div>hello</div>`
 * still paints exactly one `text` command and no border); it is exercised by a
 * synthetic ComputedStyle that carries a `border`. Wiring real `border-*`
 * properties is a PENDING generator property-table extension — once the
 * generator emits typed border fields, this same emission path consumes them
 * with no IR-boundary change.
 *
 * ## Documented Phase 2-4 simplifications
 *
 *   - **No real shaping.** The current FragmentTree carries no text runs and
 *     real glyph shaping (HarfBuzz) flows into the DisplayList in a later phase,
 *     so a `text` command's `glyphs` array is EMPTY. We deliberately do not
 *     fabricate fake glyph geometry presented as truth; the honest `at` (the box
 *     origin) and `fill` (the computed colour) are real, and the glyph runs are
 *     filled in once shaping output reaches the DisplayList. When the
 *     FragmentTree gains explicit text runs, the "leaf ⇒ text" heuristic is
 *     replaced by reading the run off the fragment.
 *
 * ## Purity & immutability (Requirements 2.7, 3.2)
 *
 * `paint(fragments, styleOf)` is a PURE, deterministic function of its inputs
 * (no shared mutable state; the command list is built locally), so it is safe as
 * the memoized `qPaint` query — memoization/invalidation are the kernel's job.
 * The result is `deepFreeze`-d (Requirement 3.2).
 *
 * This module imports ONLY the frozen IR (`@browser-engine/ir`) — the single
 * sanctioned inter-stage channel — so it never reaches across a stage boundary
 * (`local/no-cross-stage-import`). It receives `ComputedStyle` through the
 * injected `styleOf` callback rather than importing the cascade, and the
 * FragmentTree as a parameter rather than importing layout.
 */
import { deepFreeze } from "@browser-engine/ir";
import type {
  BorderSide,
  Color,
  ComputedStyle,
  DecodedImage,
  DisplayList,
  Edges,
  Fragment,
  FragmentId,
  FragmentTree,
  Glyph,
  Matrix,
  NodeId,
  PaintCmd,
  Point,
  Px,
  Rect,
} from "@browser-engine/ir";

export const PACKAGE_NAME = "@browser-engine/paint" as const;

/**
 * Emit the {@link DisplayList} for a laid-out document (design.md §8.6) from the
 * frozen FragmentTree (geometry) and per-node ComputedStyle (paint). The
 * returned commands are backend-agnostic and reference no part of the
 * FragmentTree graph (Requirement 3.5); the result is deep-frozen.
 *
 * @param fragments the frozen FragmentTree IR (the sole source of geometry).
 * @param styleOf accessor for a node's frozen, geometry-free ComputedStyle.
 * @returns the deep-frozen DisplayList of abstract paint commands.
 */
export function paint(
  fragments: FragmentTree,
  styleOf: (node: NodeId) => ComputedStyle,
  imageOf?: (node: NodeId) => DecodedImage | undefined,
): DisplayList {
  const commands: PaintCmd[] = [];

  /**
   * Paint one fragment and its subtree in paint order: this fragment's
   * background (behind everything it contains), then its border, then its text
   * if it is a leaf, then each child in document order (so descendants and later
   * siblings paint on top).
   */
  function paintFragment(id: FragmentId): void {
    const fragment = fragments.fragments.get(id);
    if (fragment === undefined) {
      return; // a dangling child id (should not happen for a well-formed tree).
    }
    const style = styleOf(fragment.node);

    // Compositing layer (task 9.2; Requirement 17.2): a fragment whose style
    // establishes a stacking layer — a non-default `opacity` or a `transform` —
    // is wrapped in a push-layer / pop-layer pair so the backend composites its
    // whole subtree as one layer. Read defensively off the open ComputedStyle
    // index signature (these properties are not yet emitted by the generator;
    // see the module doc), so a plain document emits no layer and the existing
    // command stream is byte-for-byte unchanged.
    const layer = readLayer(style);
    if (layer !== null) {
      const transform = layer.transform === IDENTITY_MATRIX
        ? layer.transform
        : originRelativeMatrix(layer.transform, fragment.box.borderBox);
      commands.push(
        layer.filter === undefined
          ? { op: "push-layer", opacity: layer.opacity, transform }
          : { op: "push-layer", opacity: layer.opacity, transform, filter: layer.filter },
      );
    }

    // `visibility` (CSS Box, generated property) gates this fragment's OWN paint
    // (background/border/text) but NOT its subtree: a `visibility:hidden` box
    // can contain a `visibility:visible` descendant, so children are still
    // walked below. `collapse` behaves like `hidden` for non-table boxes. A
    // visible (or absent/initial) value paints normally, so a plain document's
    // command stream is byte-for-byte unchanged.
    const selfVisible = readVisibility(style) === "visible";

    if (selfVisible) {
      emitBoxShadow(fragment, style, commands);
      emitBackground(fragment, style, commands);
      emitBorder(fragment, style, commands);
      emitOutline(fragment, style, commands);

      // A replaced element (an `<img>` whose source decoded) paints its image in
      // the content box. `imageOf` returns the decoded bitmap for such nodes and
      // `undefined` for everything else, so paint needs no DOM/tag knowledge: a
      // defined result means "this fragment is a painted replaced element".
      const image = imageOf?.(fragment.node);
      if (image !== undefined) {
        commands.push({ op: "image", rect: copyRect(fragment.box.contentBox), src: image });
      } else if (fragment.children.length === 0) {
        // A childless, non-replaced fragment is a text-bearing leaf (module doc).
        emitText(fragment, style, commands);
      }
    }

    // `overflow` (CSS Box, generated property): a non-`visible` overflow clips
    // this fragment's DESCENDANTS to its padding box (the CSS overflow clip
    // rectangle). The box's own background/border already painted above and are
    // NOT clipped; only the subtree below is. A `visible` (or absent/initial)
    // overflow pushes no clip, so a plain document's command stream is
    // byte-for-byte unchanged. The clip is balanced by a matching `pop-clip`.
    const clips = readClips(style) && fragment.children.length > 0;
    if (clips) {
      commands.push({ op: "push-clip", rect: copyRect(fragment.box.paddingBox) });
    }

    // Children paint within the layer (if any), ordered by z-index then
    // document order so a higher z-index sibling composites on top (Req 17.2).
    for (const childId of paintOrderedChildren(fragment)) {
      paintFragment(childId);
    }

    if (clips) {
      commands.push({ op: "pop-clip" });
    }

    if (layer !== null) {
      commands.push({ op: "pop-layer" });
    }
  }

  /**
   * The child fragment ids in PAINT order: ascending `z-index` (default 0),
   * ties broken by document order (a stable sort preserves it). This realises
   * the z-index half of compositing (Requirement 17.2) without changing the
   * FragmentTree — the order is derived from each child's computed style. When
   * no child carries a z-index the children are returned in document order
   * untouched, so a plain document's command stream is unchanged.
   */
  function paintOrderedChildren(fragment: Fragment): readonly FragmentId[] {
    const children = fragment.children;
    let anyZ = false;
    for (const childId of children) {
      const child = fragments.fragments.get(childId);
      if (child !== undefined && readZIndex(styleOf(child.node)) !== 0) {
        anyZ = true;
        break;
      }
    }
    if (!anyZ) {
      return children;
    }
    return children
      .map((childId, index) => {
        const child = fragments.fragments.get(childId);
        const z = child === undefined ? 0 : readZIndex(styleOf(child.node));
        return { childId, index, z };
      })
      .sort((a, b) => (a.z !== b.z ? a.z - b.z : a.index - b.index))
      .map((entry) => entry.childId);
  }

  paintFragment(fragments.root);

  const list = { commands } as unknown as DisplayList;
  return deepFreeze(list);
}

// ---------------------------------------------------------------------------
// Command emission. Each command is built from FRESH plain values (no handle
// into the FragmentTree / ComputedStyle is stored in the command — Req 3.5).
// ---------------------------------------------------------------------------

/**
 * Emit a background `rect` for a fragment whose computed `background-color` is
 * not transparent (alpha > 0), filling its `borderBox`. A transparent (or
 * unreadable) background emits nothing.
 */
function emitBackground(fragment: Fragment, style: ComputedStyle, out: PaintCmd[]): void {
  const fill = readColor(style["backgroundColor"]);
  if (fill === null || fill.a <= 0) {
    return; // transparent / absent background paints nothing.
  }
  out.push({ op: "rect", rect: copyRect(fragment.box.borderBox), fill });
}

/**
 * Emit a `text` command for a leaf fragment. When the fragment carries a shaped
 * glyph run (`fragment.text`, produced by layout), the command carries the real
 * positioned glyphs — each glyph's `offset` is its position relative to the
 * content-box origin (`at`) and `advance` its cell width — plus the run's
 * `fontSize`, so the backend can rasterize them. A fragment with no run (an
 * empty element leaf, or a hand-built test fragment) emits an empty glyph run at
 * the content origin, exactly as before (the documented Phase-1 no-op).
 */
function emitText(fragment: Fragment, style: ComputedStyle, out: PaintCmd[]): void {
  const origin = fragment.box.contentBox;
  const at: Point = { x: origin.x, y: origin.y };
  const run = fragment.text;
  if (run === undefined) {
    out.push({ op: "text", glyphs: [], at, fill: copyColor(style.color), fontSize: style.fontSize });
    return;
  }
  const glyphs: Glyph[] = run.glyphs.map((g) => ({
    glyphId: g.glyphId,
    advance: g.advance,
    offset: { x: g.x, y: g.y },
  }));
  out.push({ op: "text", glyphs, at, fill: copyColor(style.color), fontSize: run.fontSize });
}

/**
 * Emit a `border` command over the fragment's `borderBox` when the style carries
 * a well-formed border (Requirement 15.4). Two sources are tried, in order:
 *
 *   1. the REAL generated per-edge longhands — `borderTopWidth/Style/Color`,
 *      `borderRightWidth/Style/Color`, … — which the cascade now emits as typed
 *      ComputedStyle fields (Platform-as-Data). These are assembled into an
 *      `Edges<BorderSide>` when at least one edge is actually drawn (a non-`none`
 *      style and a positive width); a box whose four edges are all the initial
 *      `none`/0 emits nothing, so a plain document's command stream is unchanged.
 *   2. failing that, a synthetic `border` descriptor read defensively off the
 *      open `[k: string]: unknown` index signature (the original task 5.8 path,
 *      still exercised by tests that carry a whole `border` object).
 *
 * Every value is copied, so the command holds no reference into the
 * ComputedStyle (Req 3.5).
 */
function emitBorder(fragment: Fragment, style: ComputedStyle, out: PaintCmd[]): void {
  const edges = readLonghandBorder(style) ?? readEdges(style["border"]);
  if (edges === null) {
    return; // no (or all-`none`) border paints nothing.
  }
  out.push({ op: "border", rect: copyRect(fragment.box.borderBox), edges });
}

/**
 * Emit an `outline` as a `border` command over an OUTSET rectangle — the border
 * box grown outward by `outline-offset` plus `outline-width` on every side, with
 * the four edges set to the outline's width/style/color. CSS outlines take no
 * layout space and paint just outside the border edge; modelling them as a
 * border on the outset rect is exact for the uniform (4-equal-edge) outline the
 * shorthand produces. Emits nothing for the initial `none`/0 outline, so a plain
 * document's command stream is unchanged.
 */
function emitOutline(fragment: Fragment, style: ComputedStyle, out: PaintCmd[]): void {
  const width = numberField(style["outlineWidth"]);
  const keyword = stringField(style["outlineStyle"], "none");
  if (width <= 0 || keyword === "none" || keyword === "hidden") {
    return;
  }
  const offset = numberField(style["outlineOffset"]);
  const bb = fragment.box.borderBox;
  const grow = offset + width;
  const rect: Rect = {
    x: (Number(bb.x) - grow) as Px,
    y: (Number(bb.y) - grow) as Px,
    width: (Number(bb.width) + 2 * grow) as Px,
    height: (Number(bb.height) + 2 * grow) as Px,
  };
  const side: BorderSide = {
    width: width as Px,
    style: toBorderSideStyle(keyword),
    color: readColor(style["outlineColor"]) ?? { r: 0, g: 0, b: 0, a: 1 },
  };
  out.push({ op: "border", rect, edges: { top: side, right: side, bottom: side, left: side } });
}

/**
 * Emit a `box-shadow` as a filled `rect` behind the box, offset by the shadow's
 * `<ox> <oy>` and grown by its spread. HONEST APPROXIMATION: the software raster
 * has no Gaussian blur, so the shadow is hard-edged (the blur radius is parsed
 * but not convolved) — the offset, spread, and colour are real. `inset` shadows
 * and the `none` initial emit nothing. Parsed defensively off the generated
 * `boxShadow` string field; an unparseable value emits nothing.
 */
function emitBoxShadow(fragment: Fragment, style: ComputedStyle, out: PaintCmd[]): void {
  const shadow = parseShadow(stringField(style["boxShadow"], "none"));
  if (shadow === null) {
    return;
  }
  const bb = fragment.box.borderBox;
  const rect: Rect = {
    x: (Number(bb.x) + shadow.offsetX - shadow.spread) as Px,
    y: (Number(bb.y) + shadow.offsetY - shadow.spread) as Px,
    width: (Number(bb.width) + 2 * shadow.spread) as Px,
    height: (Number(bb.height) + 2 * shadow.spread) as Px,
  };
  if (shadow.blur > 0) {
    // Reuse the layer compositor's filter: the shadow rect is drawn into a layer
    // blurred by the shadow's blur radius — a REAL Gaussian-ish blur, not a hard
    // edge. half the blur radius ≈ the CSS blur's standard deviation.
    out.push({ op: "push-layer", opacity: 1, transform: IDENTITY_MATRIX, filter: `blur(${shadow.blur / 2}px)` });
    out.push({ op: "rect", rect, fill: shadow.color });
    out.push({ op: "pop-layer" });
    return;
  }
  out.push({ op: "rect", rect, fill: shadow.color });
}

interface ShadowSpec {
  readonly offsetX: number;
  readonly offsetY: number;
  readonly blur: number;
  readonly spread: number;
  readonly color: Color;
}

/**
 * Parse the common `box-shadow` form `<ox> <oy> [blur] [spread] [color]`
 * (outset only). Returns `null` for `none`, `inset` shadows, or an unparseable
 * value. Lengths are read as px numbers; the colour accepts `#hex` and
 * `rgb()/rgba()` (else a default translucent black). The blur radius is parsed
 * but not used (no blur in the raster — documented approximation).
 */
function parseShadow(value: string): ShadowSpec | null {
  const text = value.trim();
  if (text === "" || text === "none" || text.includes("inset")) {
    return null;
  }
  // Pull a trailing/leading colour token out first, then read the lengths.
  let color: Color = { r: 0, g: 0, b: 0, a: 0.5 };
  let rest = text;
  const rgbMatch = /rgba?\([^)]*\)/i.exec(rest);
  const hexMatch = /#[0-9a-fA-F]{3,8}\b/.exec(rest);
  if (rgbMatch !== null) {
    const parsed = parseRgbFunc(rgbMatch[0]);
    if (parsed !== null) color = parsed;
    rest = rest.replace(rgbMatch[0], " ");
  } else if (hexMatch !== null) {
    const parsed = parseHex(hexMatch[0]);
    if (parsed !== null) color = parsed;
    rest = rest.replace(hexMatch[0], " ");
  }
  const lengths = rest
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => Number.parseFloat(t.replace(/px$/, "")));
  if (lengths.length < 2 || lengths.some((n) => Number.isNaN(n))) {
    return null; // need at least offset-x and offset-y.
  }
  return {
    offsetX: lengths[0] ?? 0,
    offsetY: lengths[1] ?? 0,
    blur: Math.max(0, lengths[2] ?? 0),
    spread: lengths[3] ?? 0,
    color,
  };
}

/** Parse `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa` into a {@link Color}. */
function parseHex(token: string): Color | null {
  const hex = token.slice(1);
  const dup = (s: string): number => Number.parseInt(s + s, 16);
  if (hex.length === 3 || hex.length === 4) {
    return {
      r: dup(hex[0] as string),
      g: dup(hex[1] as string),
      b: dup(hex[2] as string),
      a: hex.length === 4 ? dup(hex[3] as string) / 255 : 1,
    };
  }
  if (hex.length === 6 || hex.length === 8) {
    return {
      r: Number.parseInt(hex.slice(0, 2), 16),
      g: Number.parseInt(hex.slice(2, 4), 16),
      b: Number.parseInt(hex.slice(4, 6), 16),
      a: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
    };
  }
  return null;
}

/** Parse `rgb(r,g,b)` / `rgba(r,g,b,a)` into a {@link Color}. */
function parseRgbFunc(token: string): Color | null {
  const m = /rgba?\(([^)]*)\)/i.exec(token);
  if (m === null) return null;
  const parts = (m[1] ?? "").split(",").map((p) => Number.parseFloat(p.trim()));
  if (parts.length < 3 || parts.slice(0, 3).some((n) => Number.isNaN(n))) return null;
  return {
    r: clampChannel(parts[0] ?? 0),
    g: clampChannel(parts[1] ?? 0),
    b: clampChannel(parts[2] ?? 0),
    a: parts.length >= 4 && !Number.isNaN(parts[3]) ? Math.max(0, Math.min(1, parts[3] ?? 1)) : 1,
  };
}

function clampChannel(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

/** Read a numeric ComputedStyle field (Px or number), defaulting to 0. */
function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Read a string ComputedStyle field, defaulting to `fallback`. */
function stringField(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

// ---------------------------------------------------------------------------
// Value copying / narrowing helpers.
// ---------------------------------------------------------------------------

/** Copy a {@link Rect} into a fresh plain object (no FragmentTree reference). */
function copyRect(rect: Rect): Rect {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/** Copy a {@link Color} into a fresh plain object (no ComputedStyle reference). */
function copyColor(color: Color): Color {
  return { r: color.r, g: color.g, b: color.b, a: color.a };
}

/**
 * Narrow an `unknown` ComputedStyle field (generated properties are typed
 * `unknown` on the IR's open index signature) to a fresh {@link Color}, or
 * `null` when it is not a colour. Returning a copy keeps the command free of any
 * reference into the ComputedStyle.
 */
function readColor(value: unknown): Color | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const c = value as Record<string, unknown>;
  if (
    typeof c["r"] === "number" &&
    typeof c["g"] === "number" &&
    typeof c["b"] === "number" &&
    typeof c["a"] === "number"
  ) {
    return { r: c["r"], g: c["g"], b: c["b"], a: c["a"] };
  }
  return null;
}

/** The recognised `border-style` keywords (matches {@link BorderSide}). */
const BORDER_STYLES: ReadonlySet<string> = new Set([
  "none",
  "solid",
  "dashed",
  "dotted",
  "double",
]);

/**
 * Narrow an `unknown` border-edge value to a fresh {@link BorderSide}, or `null`
 * when it is not a well-formed `{ width: number, style: <keyword>, color }`
 * triple. The returned side is a deep copy, so it holds no reference into the
 * ComputedStyle (Req 3.5).
 */
function readBorderSide(value: unknown): BorderSide | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const side = value as Record<string, unknown>;
  const width = side["width"];
  const style = side["style"];
  const color = readColor(side["color"]);
  if (typeof width !== "number" || typeof style !== "string" || color === null) {
    return null;
  }
  if (!BORDER_STYLES.has(style)) {
    return null;
  }
  return {
    width: width as Px,
    style: style as BorderSide["style"],
    color,
  };
}

/**
 * Narrow an `unknown` ComputedStyle field (the open index signature's `border`
 * key) to a fresh {@link Edges}<{@link BorderSide}>, or `null` when it is absent
 * or any edge is malformed. All four edges must be well-formed border sides;
 * returning copies keeps the command free of any reference into the
 * ComputedStyle.
 */
function readEdges(value: unknown): Edges<BorderSide> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const e = value as Record<string, unknown>;
  const top = readBorderSide(e["top"]);
  const right = readBorderSide(e["right"]);
  const bottom = readBorderSide(e["bottom"]);
  const left = readBorderSide(e["left"]);
  if (top === null || right === null || bottom === null || left === null) {
    return null;
  }
  return { top, right, bottom, left };
}

/**
 * Map a CSS `border-style` keyword (the full generated set) onto the paintable
 * {@link BorderSide} style subset. The 3D keywords (`groove`/`ridge`/`inset`/
 * `outset`) have no distinct fill in the Phase-1 raster, so they render as a
 * solid edge; `hidden` paints like `none`. This is an honest approximation at
 * the paint layer (the style value itself is preserved upstream), not a
 * fabricated value.
 */
function toBorderSideStyle(keyword: string): BorderSide["style"] {
  switch (keyword) {
    case "none":
    case "hidden":
      return "none";
    case "dashed":
      return "dashed";
    case "dotted":
      return "dotted";
    case "double":
      return "double";
    case "solid":
    case "groove":
    case "ridge":
    case "inset":
    case "outset":
      return "solid";
    default:
      return "none";
  }
}

/** Read one edge's longhand triple (`border-<edge>-width/style/color`). */
function readLonghandEdge(
  style: ComputedStyle,
  widthField: string,
  styleField: string,
  colorField: string,
): BorderSide {
  const widthValue = style[widthField];
  const width = typeof widthValue === "number" && Number.isFinite(widthValue) ? widthValue : 0;
  const styleValue = style[styleField];
  const sideStyle = toBorderSideStyle(typeof styleValue === "string" ? styleValue : "none");
  const color = readColor(style[colorField]) ?? { r: 0, g: 0, b: 0, a: 1 };
  return { width: width as Px, style: sideStyle, color };
}

/**
 * Assemble the four border edges from the REAL generated per-edge longhand
 * fields (`borderTopWidth`/`borderTopStyle`/`borderTopColor`, …). Returns the
 * `Edges<BorderSide>` only when at least one edge is actually drawn (a non-`none`
 * style and a positive width); otherwise `null`, so a box with the initial
 * `none`/0 border (the overwhelming common case) emits no `border` command and a
 * plain document's command stream is byte-for-byte unchanged.
 */
function readLonghandBorder(style: ComputedStyle): Edges<BorderSide> | null {
  const top = readLonghandEdge(style, "borderTopWidth", "borderTopStyle", "borderTopColor");
  const right = readLonghandEdge(style, "borderRightWidth", "borderRightStyle", "borderRightColor");
  const bottom = readLonghandEdge(style, "borderBottomWidth", "borderBottomStyle", "borderBottomColor");
  const left = readLonghandEdge(style, "borderLeftWidth", "borderLeftStyle", "borderLeftColor");
  const drawn = (side: BorderSide): boolean => side.style !== "none" && side.width > 0;
  if (!drawn(top) && !drawn(right) && !drawn(bottom) && !drawn(left)) {
    return null; // initial border on every edge ⇒ no command (unchanged output).
  }
  return { top, right, bottom, left };
}

/**
 * Narrow the generated `visibility` field to its keyword. Absent/invalid is the
 * initial `visible`. Used to gate a fragment's own paint (not its subtree).
 */
function readVisibility(style: ComputedStyle): string {
  const value = style["visibility"];
  return typeof value === "string" ? value : "visible";
}

/**
 * Whether this fragment CLIPS its descendants — true when its `overflow` (or
 * either axis longhand `overflow-x`/`overflow-y`) is anything other than
 * `visible`. CSS clips a box's content to its padding box whenever overflow is
 * `hidden`/`clip`/`scroll`/`auto`. The initial value is `visible` (no clip), so
 * absent fields ⇒ no clip ⇒ a plain document's command stream is unchanged.
 */
function readClips(style: ComputedStyle): boolean {
  const clipsAxis = (value: unknown): boolean =>
    typeof value === "string" && value !== "visible";
  return clipsAxis(style["overflow"]) || clipsAxis(style["overflowX"]) || clipsAxis(style["overflowY"]);
}

// ---------------------------------------------------------------------------
// Compositing-layer readers (task 9.2; Requirement 17.2).
//
// `opacity` / `transform` / `z-index` are not yet emitted by the cascade
// generator into the ComputedStyle property table, so — exactly as `border` is
// read above — they are narrowed defensively off ComputedStyle's open
// `[k: string]: unknown` index signature. A plain real-cascade document carries
// none of them, so {@link readLayer} returns `null` and {@link readZIndex}
// returns 0, leaving the emitted command stream byte-for-byte unchanged. Wiring
// these as real generated properties is a PENDING generator extension; once it
// lands these readers consume the typed fields with no change to paint.
// ---------------------------------------------------------------------------

/** The identity 2D affine transform (no translate/scale/skew/rotate). */
const IDENTITY_MATRIX: Matrix = [1, 0, 0, 1, 0, 0];

/**
 * Bake the transform-origin into an affine matrix: returns `T(c)·M·T(−c)` where
 * `c` is the border-box centre (the CSS `transform-origin` default). The
 * resulting device-absolute matrix can be applied by the backend about (0,0)
 * and still pivots scale/rotate/skew about the element's centre.
 */
function originRelativeMatrix(m: Matrix, borderBox: Rect): Matrix {
  const [a, b, c, d, e, f] = m;
  const cx = Number(borderBox.x) + Number(borderBox.width) / 2;
  const cy = Number(borderBox.y) + Number(borderBox.height) / 2;
  return [a, b, c, d, e + cx - (a * cx + c * cy), f + cy - (b * cx + d * cy)];
}

/** A resolved compositing layer: its opacity, transform, and filter for `push-layer`. */
interface LayerProps {
  readonly opacity: number;
  readonly transform: Matrix;
  readonly filter: string | undefined;
}

/**
 * Resolve a fragment's compositing layer from its style, or `null` when the
 * fragment establishes no layer (the common case). A layer is established when
 * the style carries an `opacity` < 1, a non-identity `transform`, OR a non-`none`
 * `filter`. The returned `opacity` is clamped to `0..1`, `transform` is a fresh
 * 6-tuple, and `filter` is the raw functions string (or `undefined`), so the
 * emitted `push-layer` command holds only plain values (Req 3.5).
 */
function readLayer(style: ComputedStyle): LayerProps | null {
  const opacity = readOpacity(style["opacity"]);
  const transform = readMatrix(style["transform"]);
  const filter = readFilter(style["filter"]);
  const hasOpacity = opacity < 1;
  const hasTransform = transform !== null;
  if (!hasOpacity && !hasTransform && filter === undefined) {
    return null; // establishes no layer.
  }
  return {
    opacity: hasOpacity ? opacity : 1,
    transform: transform ?? IDENTITY_MATRIX,
    filter,
  };
}

/** Narrow a `filter` field to a non-empty functions string, or `undefined`. */
function readFilter(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" || trimmed === "none" ? undefined : trimmed;
}

/** Narrow an `unknown` `opacity` to a `0..1` number; absent/invalid ⇒ 1 (opaque). */
function readOpacity(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 1;
  }
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Narrow an `unknown` `transform` to a fresh affine {@link Matrix}, or `null`
 * when absent / not a well-formed 6-number tuple. A tuple equal to the identity
 * also returns `null` (no layer needed). Accepts a 6-element number array (the
 * `matrix(a,b,c,d,e,f)` form).
 */
function readMatrix(value: unknown): Matrix | null {
  if (!Array.isArray(value) || value.length !== 6) {
    return null;
  }
  const m: number[] = [];
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      return null;
    }
    m.push(entry);
  }
  const matrix: Matrix = [m[0]!, m[1]!, m[2]!, m[3]!, m[4]!, m[5]!];
  // An identity transform establishes no layer.
  let identity = true;
  for (let i = 0; i < 6; i += 1) {
    if (matrix[i] !== IDENTITY_MATRIX[i]) {
      identity = false;
      break;
    }
  }
  return identity ? null : matrix;
}

/**
 * Narrow an `unknown` `z-index` to an integer (default 0 / `auto`). Used to
 * order sibling paint within a stacking context (Req 17.2). A non-integer or
 * absent value is the initial `auto`, modelled as 0.
 */
function readZIndex(style: ComputedStyle): number {
  const value = style["zIndex"];
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  return 0;
}
