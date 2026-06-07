/**
 * Unit tests for the minimal paint engine (task 3.10; design.md §8.6;
 * Requirement 3.5).
 *
 * Built by `tsc` then run with: `node --test packages/paint/dist/*.test.js`.
 *
 * Paint lives inside a *stage* package, so (per `local/no-cross-stage-import`)
 * it may import ONLY the frozen IR (`@browser-engine/ir`) and the package under
 * test — never layout / cascade. The FragmentTree input is therefore built here
 * by hand as a frozen IR value, and `ComputedStyle` is supplied through the same
 * `styleOf` callback the pipeline injects (paint never imports the cascade).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { deepFreeze, fragmentId, nodeId, px } from "@browser-engine/ir";
import type {
  BorderSide,
  BoxGeometry,
  Color,
  ComputedStyle,
  DisplayValue,
  Edges,
  Fragment,
  FragmentId,
  FragmentTree,
  NodeId,
  PaintCmd,
  Px,
  Rect,
} from "@browser-engine/ir";

import { paint } from "./index.js";

// ---------------------------------------------------------------------------
// IR builders — assemble a frozen FragmentTree and a ComputedStyle table by hand.
// ---------------------------------------------------------------------------

/** Construct a {@link Rect}. */
function rect(x: number, y: number, width: number, height: number): Rect {
  return { x: px(x), y: px(y), width: px(width), height: px(height) };
}

/**
 * Build a {@link BoxGeometry} whose four boxes share the given rectangle (Phase
 * 1 has no padding/border, so content/padding/border boxes coincide; the margin
 * box is supplied separately or defaults to the border box).
 */
function box(borderBox: Rect, marginBox: Rect = borderBox): BoxGeometry {
  return {
    x: borderBox.x,
    y: borderBox.y,
    width: borderBox.width,
    height: borderBox.height,
    contentBox: borderBox,
    paddingBox: borderBox,
    borderBox,
    marginBox,
  };
}

interface FragSpec {
  readonly id: number;
  readonly node: number;
  readonly box: BoxGeometry;
  readonly children?: readonly number[];
}

/** Build a frozen FragmentTree from a flat list of fragment specs (root id 0). */
function buildTree(specs: readonly FragSpec[], rootId = 0): FragmentTree {
  const fragments = new Map<FragmentId, Fragment>();
  for (const spec of specs) {
    const fragment: Fragment = {
      node: nodeId(spec.node),
      box: spec.box,
      children: (spec.children ?? []).map(fragmentId),
    };
    fragments.set(fragmentId(spec.id), fragment);
  }
  return deepFreeze({ root: fragmentId(rootId), fragments } as unknown as FragmentTree);
}

const BLACK: Color = { r: 0, g: 0, b: 0, a: 1 };
const RED: Color = { r: 255, g: 0, b: 0, a: 1 };
const TRANSPARENT: Color = { r: 0, g: 0, b: 0, a: 0 };
const ZERO_EDGES: Edges<Px> = { top: px(0), right: px(0), bottom: px(0), left: px(0) };

/** Per-node style overrides; anything omitted takes a Phase 1 initial value. */
interface StyleSpec {
  readonly display?: DisplayValue;
  readonly color?: Color;
  readonly backgroundColor?: Color;
  readonly fontSize?: number;
  /**
   * A synthetic `border` descriptor. `border-*` is not yet in the generated
   * ComputedStyle property table, so paint reads it defensively off the open
   * index signature (task 5.8); tests carry it through that same `border` key.
   */
  readonly border?: Edges<BorderSide>;
  /**
   * The generated `visibility` keyword (a real cascade field). Omitted ⇒ the
   * initial `visible`. When `hidden`/`collapse`, the fragment's own paint
   * (background/border/text) is suppressed but its subtree still paints.
   */
  readonly visibility?: string;
  /**
   * Real generated per-edge border longhands. When supplied, each edge's
   * `borderTopWidth`/`borderTopStyle`/`borderTopColor` (etc.) fields are written
   * onto the style so paint assembles the border from the SAME fields the
   * cascade now emits (Platform-as-Data end-to-end).
   */
  readonly longhandBorder?: {
    readonly width: number;
    readonly style: string;
    readonly color: Color;
  };
  /** Arbitrary extra generated fields (e.g. outline-*, box-shadow) for paint. */
  readonly extra?: Readonly<Record<string, unknown>>;
}

/**
 * Build a frozen, geometry-free ComputedStyle from a partial spec, filling the
 * Phase 1 initial values for anything unspecified (display:inline, color black,
 * background transparent, font-size 16) — exactly the shape the cascade emits.
 * A synthetic `border` is attached only when supplied (real cascade output
 * carries none until the generator emits `border-*`).
 */
function makeStyle(spec: StyleSpec = {}): ComputedStyle {
  const style: Record<string, unknown> = {
    display: spec.display ?? "inline",
    color: spec.color ?? BLACK,
    fontSize: px(spec.fontSize ?? 16),
    margin: ZERO_EDGES,
    width: "auto",
    height: "auto",
    backgroundColor: spec.backgroundColor ?? TRANSPARENT,
  };
  if (spec.border !== undefined) {
    style["border"] = spec.border;
  }
  if (spec.visibility !== undefined) {
    style["visibility"] = spec.visibility;
  }
  if (spec.longhandBorder !== undefined) {
    const { width, style: s, color } = spec.longhandBorder;
    for (const edge of ["Top", "Right", "Bottom", "Left"]) {
      style[`border${edge}Width`] = px(width);
      style[`border${edge}Style`] = s;
      style[`border${edge}Color`] = color;
    }
  }
  if (spec.extra !== undefined) {
    Object.assign(style, spec.extra);
  }
  return deepFreeze(style as unknown as ComputedStyle);
}

/** Build a uniform {@link Edges}<{@link BorderSide}> (same side on all edges). */
function uniformBorder(
  width: number,
  style: BorderSide["style"],
  color: Color,
): Edges<BorderSide> {
  const side: BorderSide = { width: px(width), style, color };
  return { top: side, right: side, bottom: side, left: side };
}

/** Make a `styleOf` callback from a per-node style map (default: initial). */
function styleTable(map: ReadonlyMap<number, ComputedStyle>): (node: NodeId) => ComputedStyle {
  const fallback = makeStyle();
  return (node: NodeId) => map.get(node) ?? fallback;
}

/** Collect the commands of a given op for convenient assertions. */
function ofOp<Op extends PaintCmd["op"]>(
  commands: readonly PaintCmd[],
  op: Op,
): readonly Extract<PaintCmd, { op: Op }>[] {
  return commands.filter((c): c is Extract<PaintCmd, { op: Op }> => c.op === op);
}

// ---------------------------------------------------------------------------
// Background-color → rect.
// ---------------------------------------------------------------------------

void test("a background-color element emits a rect with the borderBox geometry and the fill colour (Req 3.5)", () => {
  // A single element fragment (no children) with a red background.
  const tree = buildTree([{ id: 0, node: 0, box: box(rect(10, 20, 100, 40)) }]);
  const styles = styleTable(new Map([[0, makeStyle({ backgroundColor: RED })]]));

  const list = paint(tree, styles);
  const rects = ofOp(list.commands, "rect");
  assert.equal(rects.length, 1);
  const r = rects[0]!;
  assert.deepEqual(r.rect, { x: px(10), y: px(20), width: px(100), height: px(40) });
  assert.deepEqual(r.fill, RED);
});

void test("a transparent background (alpha 0) emits no rect command", () => {
  const tree = buildTree([{ id: 0, node: 0, box: box(rect(0, 0, 50, 50)) }]);
  const styles = styleTable(new Map([[0, makeStyle({ backgroundColor: TRANSPARENT })]]));

  const list = paint(tree, styles);
  assert.equal(ofOp(list.commands, "rect").length, 0);
});

void test("the background rect reads from the borderBox, not the margin box", () => {
  // borderBox is inset from the margin box by the (10,8) top-left margins.
  const marginBox = rect(0, 0, 120, 60);
  const borderBox = rect(10, 8, 100, 40);
  const tree = buildTree([{ id: 0, node: 0, box: box(borderBox, marginBox) }]);
  const styles = styleTable(new Map([[0, makeStyle({ backgroundColor: RED })]]));

  const list = paint(tree, styles);
  const r = ofOp(list.commands, "rect")[0]!;
  assert.deepEqual(r.rect, { x: px(10), y: px(8), width: px(100), height: px(40) });
});

// ---------------------------------------------------------------------------
// Text fragment → text command.
// ---------------------------------------------------------------------------

void test("a leaf (text) fragment emits a text command positioned at its box origin with the node colour", () => {
  const tree = buildTree([{ id: 0, node: 0, box: box(rect(5, 12, 40, 16)) }]);
  const styles = styleTable(new Map([[0, makeStyle({ color: RED })]]));

  const list = paint(tree, styles);
  const texts = ofOp(list.commands, "text");
  assert.equal(texts.length, 1);
  const t = texts[0]!;
  assert.deepEqual(t.at, { x: px(5), y: px(12) });
  assert.deepEqual(t.fill, RED);
  // Phase 1: no real shaping yet, so the glyph array is empty (documented).
  assert.deepEqual([...t.glyphs], []);
});

void test("a container fragment (with children) emits no text command of its own", () => {
  // parent(0) → leaf(1). Only the leaf is a text-bearing fragment.
  const tree = buildTree([
    { id: 0, node: 0, box: box(rect(0, 0, 100, 16)), children: [1] },
    { id: 1, node: 1, box: box(rect(0, 0, 40, 16)) },
  ]);
  const list = paint(tree, styleTable(new Map()));
  const texts = ofOp(list.commands, "text");
  assert.equal(texts.length, 1);
  assert.deepEqual(texts[0]!.at, { x: px(0), y: px(0) });
});

// ---------------------------------------------------------------------------
// Border descriptor → border command (task 5.8; Requirement 15.4).
// ---------------------------------------------------------------------------

void test("a bordered element emits a border command over its borderBox with the computed edges (Req 15.4)", () => {
  const borderBox = rect(10, 20, 100, 40);
  const tree = buildTree([{ id: 0, node: 0, box: box(borderBox) }]);
  const edges: Edges<BorderSide> = {
    top: { width: px(1), style: "solid", color: RED },
    right: { width: px(2), style: "dashed", color: BLACK },
    bottom: { width: px(3), style: "dotted", color: RED },
    left: { width: px(4), style: "double", color: BLACK },
  };
  const styles = styleTable(new Map([[0, makeStyle({ border: edges })]]));

  const list = paint(tree, styles);
  const borders = ofOp(list.commands, "border");
  assert.equal(borders.length, 1);
  const b = borders[0]!;
  // The command uses the fragment's borderBox.
  assert.deepEqual(b.rect, { x: px(10), y: px(20), width: px(100), height: px(40) });
  // Each edge's width / style / colour is carried through.
  assert.deepEqual(b.edges, edges);
});

void test("an element with no border descriptor emits no border command (paint never fabricates borders)", () => {
  const tree = buildTree([{ id: 0, node: 0, box: box(rect(0, 0, 50, 50)) }]);
  // A plain element (the cascade emits no `border` field today).
  const styles = styleTable(new Map([[0, makeStyle({ backgroundColor: RED })]]));

  const list = paint(tree, styles);
  assert.equal(ofOp(list.commands, "border").length, 0);
});

void test("a malformed border descriptor is treated as no border (defensive narrowing)", () => {
  const tree = buildTree([{ id: 0, node: 0, box: box(rect(0, 0, 50, 50)) }]);
  // Smuggle a malformed border (bad style keyword + missing colour) through the
  // open IR index signature; the defensive narrowing rejects it.
  const bad = deepFreeze({
    display: "block",
    color: BLACK,
    fontSize: px(16),
    margin: ZERO_EDGES,
    width: "auto",
    height: "auto",
    backgroundColor: TRANSPARENT,
    border: {
      top: { width: 1, style: "groovy", color: RED },
      right: { width: 1, style: "solid" },
      bottom: { width: 1, style: "solid", color: RED },
      left: { width: 1, style: "solid", color: RED },
    },
  } as unknown as ComputedStyle);
  const list = paint(tree, () => bad);
  assert.equal(ofOp(list.commands, "border").length, 0);
});

void test("background, border and text are all emitted, in that paint order, for a bordered leaf (Req 15.4)", () => {
  // A single bordered, red-background leaf with red text → rect, border, text.
  const tree = buildTree([{ id: 0, node: 0, box: box(rect(0, 0, 100, 40)) }]);
  const styles = styleTable(
    new Map([
      [
        0,
        makeStyle({
          backgroundColor: RED,
          color: BLACK,
          border: uniformBorder(2, "solid", BLACK),
        }),
      ],
    ]),
  );

  const list = paint(tree, styles);
  assert.deepEqual(
    list.commands.map((c) => c.op),
    ["rect", "border", "text"],
  );
});

void test("border paints before a child's content: ancestor border under descendant (paint order)", () => {
  // parent(0, bordered) → leaf(1, text). The parent's border precedes the leaf.
  const tree = buildTree([
    { id: 0, node: 0, box: box(rect(0, 0, 100, 40)), children: [1] },
    { id: 1, node: 1, box: box(rect(0, 0, 40, 16)) },
  ]);
  const styles = styleTable(
    new Map([[0, makeStyle({ border: uniformBorder(1, "solid", RED) })]]),
  );

  const list = paint(tree, styles);
  assert.deepEqual(
    list.commands.map((c) => c.op),
    ["border", "text"],
  );
});

void test("border commands carry fresh plain values, not references into the FragmentTree or ComputedStyle (Req 3.5)", () => {
  const borderBox = rect(5, 6, 70, 30);
  const tree = buildTree([{ id: 0, node: 0, box: box(borderBox) }]);
  const edges = uniformBorder(2, "solid", { r: 4, g: 5, b: 6, a: 1 });
  const style = makeStyle({ border: edges });
  const styles = styleTable(new Map([[0, style]]));

  const list = paint(tree, styles);
  const b = ofOp(list.commands, "border")[0]!;

  // Equal by value …
  assert.deepEqual(b.rect, { x: px(5), y: px(6), width: px(70), height: px(30) });
  assert.deepEqual(b.edges, edges);

  // … but NOT the same reference as anything reachable from the IR inputs.
  assert.notEqual(b.rect, tree.fragments.get(fragmentId(0))!.box.borderBox);
  assert.notEqual(b.edges, style["border"]);
  assert.notEqual(b.edges.top, edges.top);
  assert.notEqual(b.edges.top.color, edges.top.color);
});

// ---------------------------------------------------------------------------
// Paint order: background before content, ancestors before descendants.
// ---------------------------------------------------------------------------

void test("nested fragments paint in tree order: background before content, parent before child", () => {
  // document(0) → div(1, red bg) → text(2). Expected order:
  //   div background rect, then text command.
  const tree = buildTree([
    { id: 0, node: 0, box: box(rect(0, 0, 800, 16)), children: [1] },
    { id: 1, node: 1, box: box(rect(0, 0, 800, 16)), children: [2] },
    { id: 2, node: 2, box: box(rect(0, 0, 40, 16)) },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", backgroundColor: RED })],
      [2, makeStyle({ color: BLACK })],
    ]),
  );

  const list = paint(tree, styles);
  assert.deepEqual(
    list.commands.map((c) => c.op),
    ["rect", "text"],
  );
  // The background rect comes from the div's borderBox; the text from the leaf.
  const r = ofOp(list.commands, "rect")[0]!;
  assert.deepEqual(r.fill, RED);
});

void test("two backgrounds paint outermost-first (ancestor background under descendant background)", () => {
  // outer(0, red) → inner(1, black). Outer paints first (underneath).
  const tree = buildTree([
    { id: 0, node: 0, box: box(rect(0, 0, 100, 100)), children: [1] },
    { id: 1, node: 1, box: box(rect(10, 10, 50, 50)) },
  ]);
  const styles = styleTable(
    new Map([
      [0, makeStyle({ backgroundColor: RED })],
      [1, makeStyle({ backgroundColor: BLACK })],
    ]),
  );

  const list = paint(tree, styles);
  const rects = ofOp(list.commands, "rect");
  assert.equal(rects.length, 2);
  assert.deepEqual(rects[0]!.fill, RED); // outer first
  assert.deepEqual(rects[1]!.fill, BLACK); // inner on top
});

void test("sibling fragments paint in document order", () => {
  // parent(0) → a(1, red), b(2, black). a's background precedes b's.
  const tree = buildTree([
    { id: 0, node: 0, box: box(rect(0, 0, 100, 100)), children: [1, 2] },
    { id: 1, node: 1, box: box(rect(0, 0, 100, 50)) },
    { id: 2, node: 2, box: box(rect(0, 50, 100, 50)) },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ backgroundColor: RED })],
      [2, makeStyle({ backgroundColor: BLACK })],
    ]),
  );

  const list = paint(tree, styles);
  const rects = ofOp(list.commands, "rect");
  assert.equal(rects.length, 2);
  assert.deepEqual(rects[0]!.fill, RED);
  assert.deepEqual(rects[1]!.fill, BLACK);
});

// ---------------------------------------------------------------------------
// `<div>hello</div>`-shaped tree → non-empty DisplayList (Requirement 14.1).
// ---------------------------------------------------------------------------

void test("the `<div>hello</div>` fragment tree produces a non-empty DisplayList", () => {
  // document(0) → div(1) → text "hello"(2). With initial styles (transparent
  // background, black text), only the text command is emitted — still non-empty.
  const tree = buildTree([
    { id: 0, node: 0, box: box(rect(0, 0, 800, 16)), children: [1] },
    { id: 1, node: 1, box: box(rect(0, 0, 800, 16)), children: [2] },
    { id: 2, node: 2, box: box(rect(0, 0, 40, 16)) },
  ]);
  const list = paint(tree, styleTable(new Map()));

  assert.ok(list.commands.length > 0, "the slice must produce at least one command");
  const texts = ofOp(list.commands, "text");
  assert.equal(texts.length, 1);
  assert.deepEqual(texts[0]!.at, { x: px(0), y: px(0) });
});

// ---------------------------------------------------------------------------
// Frozen output + determinism (Requirement 3.2 / 2.7).
// ---------------------------------------------------------------------------

void test("the DisplayList output is deep-frozen (Req 3.2)", () => {
  const tree = buildTree([{ id: 0, node: 0, box: box(rect(0, 0, 100, 40)) }]);
  const list = paint(
    tree,
    styleTable(
      new Map([
        [0, makeStyle({ backgroundColor: RED, border: uniformBorder(2, "solid", BLACK) })],
      ]),
    ),
  );

  assert.ok(Object.isFrozen(list));
  assert.ok(Object.isFrozen(list.commands));
  for (const command of list.commands) {
    assert.ok(Object.isFrozen(command));
  }
  // The border command's nested edges/colours are frozen too (deep freeze).
  const b = ofOp(list.commands, "border")[0]!;
  assert.ok(Object.isFrozen(b.edges));
  assert.ok(Object.isFrozen(b.edges.top));
  assert.ok(Object.isFrozen(b.edges.top.color));
});

void test("paint is deterministic: same inputs ⇒ structurally equal DisplayList (Req 2.7)", () => {
  const tree = buildTree([
    { id: 0, node: 0, box: box(rect(0, 0, 800, 16)), children: [1] },
    { id: 1, node: 1, box: box(rect(0, 0, 800, 16)), children: [2] },
    { id: 2, node: 2, box: box(rect(0, 0, 40, 16)) },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ backgroundColor: RED, border: uniformBorder(1, "solid", BLACK) })],
    ]),
  );

  const a = paint(tree, styles);
  const b = paint(tree, styles);
  assert.deepEqual(a.commands, b.commands);
});

// ---------------------------------------------------------------------------
// Commands carry plain values, not IR handles (Requirement 3.5).
// ---------------------------------------------------------------------------

void test("commands carry fresh plain values, not references into the FragmentTree or ComputedStyle (Req 3.5)", () => {
  const borderBox = rect(10, 20, 100, 40);
  const tree = buildTree([{ id: 0, node: 0, box: box(borderBox) }]);
  const bgColor: Color = { r: 1, g: 2, b: 3, a: 1 };
  const textColor: Color = { r: 9, g: 8, b: 7, a: 1 };
  // A leaf with a background → both a rect and a text command.
  const style = makeStyle({ backgroundColor: bgColor, color: textColor });
  const styles = styleTable(new Map([[0, style]]));

  const list = paint(tree, styles);
  const r = ofOp(list.commands, "rect")[0]!;
  const t = ofOp(list.commands, "text")[0]!;

  // Equal by value …
  assert.deepEqual(r.rect, { x: px(10), y: px(20), width: px(100), height: px(40) });
  assert.deepEqual(r.fill, bgColor);
  assert.deepEqual(t.fill, textColor);

  // … but NOT the same reference as anything reachable from the IR inputs.
  assert.notEqual(r.rect, tree.fragments.get(fragmentId(0))!.box.borderBox);
  assert.notEqual(r.fill, style["backgroundColor"]);
  assert.notEqual(t.fill, style.color);

  // And the FragmentTree is left untouched (no reference smuggled out and
  // mutated): the command list is its own frozen graph.
  assert.notEqual(list.commands, tree.fragments);
});

void test("a non-colour background-color value is treated as no background (defensive narrowing)", () => {
  const tree = buildTree([{ id: 0, node: 0, box: box(rect(0, 0, 50, 50)) }]);
  // Smuggle a malformed (non-colour) backgroundColor through the open IR shape.
  const bad = deepFreeze({
    display: "block",
    color: BLACK,
    fontSize: px(16),
    margin: ZERO_EDGES,
    width: "auto",
    height: "auto",
    backgroundColor: "not-a-color",
  } as unknown as ComputedStyle);
  const list = paint(tree, () => bad);
  assert.equal(ofOp(list.commands, "rect").length, 0);
});

// ---------------------------------------------------------------------------
// Real per-edge border longhands → border command (Platform-as-Data end-to-end).
//
// The cascade now emits `border-<edge>-width/style/color` as typed ComputedStyle
// fields. Paint assembles the `border` command from EXACTLY those fields, so a
// real CSS `border-*` declaration paints with no synthetic descriptor — closing
// the "declared but not rendered" gap one mechanism at a time.
// ---------------------------------------------------------------------------

void test("a real border longhand triple paints a border command (no synthetic descriptor)", () => {
  const borderBox = rect(0, 0, 100, 40);
  const tree = buildTree([{ id: 0, node: 0, box: box(borderBox) }]);
  const styles = styleTable(
    new Map([[0, makeStyle({ longhandBorder: { width: 3, style: "solid", color: RED } })]]),
  );

  const list = paint(tree, styles);
  const borders = ofOp(list.commands, "border");
  assert.equal(borders.length, 1, "the real longhands assemble one border command");
  const b = borders[0]!;
  assert.deepEqual(b.rect, { x: px(0), y: px(0), width: px(100), height: px(40) });
  for (const edge of [b.edges.top, b.edges.right, b.edges.bottom, b.edges.left]) {
    assert.equal(edge.width, 3);
    assert.equal(edge.style, "solid");
    assert.deepEqual(edge.color, RED);
  }
});

void test("the initial border longhands (none/0 on every edge) emit NO border command", () => {
  // A box that explicitly carries the initial border longhands must paint
  // exactly like a box with no border fields at all — preserving byte-for-byte
  // output for the overwhelming common case.
  const tree = buildTree([{ id: 0, node: 0, box: box(rect(0, 0, 50, 50)) }]);
  const styles = styleTable(
    new Map([[0, makeStyle({ longhandBorder: { width: 0, style: "none", color: BLACK } })]]),
  );

  const list = paint(tree, styles);
  assert.equal(ofOp(list.commands, "border").length, 0);
});

void test("a 3D border-style keyword (groove) paints as a solid edge (honest paint-layer mapping)", () => {
  const tree = buildTree([{ id: 0, node: 0, box: box(rect(0, 0, 100, 40)) }]);
  const styles = styleTable(
    new Map([[0, makeStyle({ longhandBorder: { width: 2, style: "groove", color: BLACK } })]]),
  );

  const list = paint(tree, styles);
  const b = ofOp(list.commands, "border")[0]!;
  assert.equal(b.edges.top.style, "solid", "groove renders as solid at the paint layer");
});

// ---------------------------------------------------------------------------
// `visibility` gates a fragment's OWN paint but not its subtree (CSS Box).
// ---------------------------------------------------------------------------

void test("visibility:hidden suppresses the fragment's own background/border/text", () => {
  const tree = buildTree([{ id: 0, node: 0, box: box(rect(0, 0, 100, 40)) }]);
  const styles = styleTable(
    new Map([
      [0, makeStyle({ backgroundColor: RED, visibility: "hidden", longhandBorder: { width: 2, style: "solid", color: BLACK } })],
    ]),
  );

  const list = paint(tree, styles);
  assert.equal(list.commands.length, 0, "a hidden leaf paints nothing of its own");
});

void test("visibility:hidden on a parent still lets a visible child paint (it gates only self)", () => {
  // parent(0, hidden, red bg) → child(1, visible, red bg). Only the child paints.
  const tree = buildTree([
    { id: 0, node: 0, box: box(rect(0, 0, 100, 40)), children: [1] },
    { id: 1, node: 1, box: box(rect(0, 0, 40, 16)) },
  ]);
  const styles = styleTable(
    new Map([
      [0, makeStyle({ backgroundColor: RED, visibility: "hidden" })],
      [1, makeStyle({ backgroundColor: RED, visibility: "visible" })],
    ]),
  );

  const list = paint(tree, styles);
  // Parent emits nothing; the child emits its background rect (+ its own text leaf).
  const rects = ofOp(list.commands, "rect");
  assert.equal(rects.length, 1, "only the visible child's background paints");
  assert.deepEqual(rects[0]!.rect, { x: px(0), y: px(0), width: px(40), height: px(16) });
});

void test("visibility:collapse behaves like hidden for a non-table box", () => {
  const tree = buildTree([{ id: 0, node: 0, box: box(rect(0, 0, 50, 50)) }]);
  const styles = styleTable(new Map([[0, makeStyle({ backgroundColor: RED, visibility: "collapse" })]]));
  const list = paint(tree, styles);
  assert.equal(ofOp(list.commands, "rect").length, 0);
});

void test("an absent visibility field paints normally (initial value is visible)", () => {
  const tree = buildTree([{ id: 0, node: 0, box: box(rect(0, 0, 100, 40)) }]);
  const styles = styleTable(new Map([[0, makeStyle({ backgroundColor: RED })]]));
  const list = paint(tree, styles);
  assert.equal(ofOp(list.commands, "rect").length, 1, "no visibility field ⇒ visible");
});

// ---------------------------------------------------------------------------
// Outline + box-shadow emission (#1: making generated properties render).
// ---------------------------------------------------------------------------

void test("an outline emits a border command on an OUTSET rect (offset + width)", () => {
  const tree = buildTree([{ id: 0, node: 0, box: box(rect(10, 10, 100, 40)) }]);
  const styles = styleTable(
    new Map([[0, makeStyle({ extra: { outlineWidth: px(3), outlineStyle: "solid", outlineColor: RED, outlineOffset: px(2) } })]]),
  );
  const list = paint(tree, styles);

  const borders = ofOp(list.commands, "border");
  assert.equal(borders.length, 1);
  const b = borders[0]!;
  // Outset by offset(2)+width(3)=5 on every side of the 10,10,100,40 border box.
  assert.deepEqual(b.rect, { x: px(5), y: px(5), width: px(110), height: px(50) });
  assert.equal(b.edges.top.width, px(3));
  assert.deepEqual(b.edges.left.color, RED);
});

void test("the initial (none/0) outline emits nothing", () => {
  const tree = buildTree([{ id: 0, node: 0, box: box(rect(0, 0, 50, 50)) }]);
  const styles = styleTable(new Map([[0, makeStyle({ extra: { outlineStyle: "none", outlineWidth: px(0) } })]]));
  assert.equal(ofOp(paint(tree, styles).commands, "border").length, 0);
});

void test("box-shadow emits a filled rect offset behind the box (hard-edged approximation)", () => {
  const tree = buildTree([{ id: 0, node: 0, box: box(rect(20, 20, 100, 40)) }]);
  const styles = styleTable(new Map([[0, makeStyle({ extra: { boxShadow: "4px 6px 8px #ff0000" } })]]));
  const list = paint(tree, styles);

  const rects = ofOp(list.commands, "rect");
  assert.equal(rects.length, 1);
  // Offset by (4,6), no spread ⇒ same size at the shifted origin; color #ff0000.
  assert.deepEqual(rects[0]!.rect, { x: px(24), y: px(26), width: px(100), height: px(40) });
  assert.deepEqual(rects[0]!.fill, { r: 255, g: 0, b: 0, a: 1 });
});

void test("box-shadow with spread grows the shadow rect; rgba color is parsed", () => {
  const tree = buildTree([{ id: 0, node: 0, box: box(rect(0, 0, 50, 50)) }]);
  const styles = styleTable(new Map([[0, makeStyle({ extra: { boxShadow: "0px 0px 0px 5px rgba(0,0,0,0.5)" } })]]));
  const r = ofOp(paint(tree, styles).commands, "rect")[0]!;
  assert.deepEqual(r.rect, { x: px(-5), y: px(-5), width: px(60), height: px(60) });
  assert.equal(r.fill.a, 0.5);
});

void test("box-shadow:none and inset shadows emit nothing", () => {
  const tree = buildTree([{ id: 0, node: 0, box: box(rect(0, 0, 50, 50)) }]);
  assert.equal(ofOp(paint(tree, styleTable(new Map([[0, makeStyle({ extra: { boxShadow: "none" } })]]))).commands, "rect").length, 0);
  assert.equal(ofOp(paint(tree, styleTable(new Map([[0, makeStyle({ extra: { boxShadow: "inset 2px 2px 4px #000" } })]]))).commands, "rect").length, 0);
});

// ---------------------------------------------------------------------------
// CSS filter establishes a layer; blurred box-shadow rides the filter layer.
// ---------------------------------------------------------------------------

void test("a filter establishes a compositing layer carrying the filter string", () => {
  const tree = buildTree([{ id: 0, node: 0, box: box(rect(0, 0, 50, 50)) }]);
  const styles = styleTable(new Map([[0, makeStyle({ extra: { filter: "grayscale(1)" }, backgroundColor: RED })]]));
  const list = paint(tree, styles);

  const push = ofOp(list.commands, "push-layer")[0];
  assert.ok(push !== undefined);
  assert.equal(push.filter, "grayscale(1)");
  assert.ok(ofOp(list.commands, "pop-layer").length === 1, "the layer is balanced");
});

void test("a blurred box-shadow wraps its rect in a blur-filter layer", () => {
  const tree = buildTree([{ id: 0, node: 0, box: box(rect(10, 10, 40, 20)) }]);
  const styles = styleTable(new Map([[0, makeStyle({ extra: { boxShadow: "2px 2px 8px #000000" } })]]));
  const list = paint(tree, styles);

  const push = ofOp(list.commands, "push-layer").find((c) => c.filter !== undefined);
  assert.ok(push !== undefined, "the shadow rides a filter layer");
  assert.match(push.filter ?? "", /^blur\(/, "the layer carries a blur filter");
  assert.equal(ofOp(list.commands, "rect").length, 1, "the shadow rect is drawn inside the layer");
});

void test("a zero-blur box-shadow stays a plain rect (no layer)", () => {
  const tree = buildTree([{ id: 0, node: 0, box: box(rect(0, 0, 40, 20)) }]);
  const styles = styleTable(new Map([[0, makeStyle({ extra: { boxShadow: "3px 3px 0px #000000" } })]]));
  const list = paint(tree, styles);
  assert.equal(ofOp(list.commands, "push-layer").length, 0);
  assert.equal(ofOp(list.commands, "rect").length, 1);
});
