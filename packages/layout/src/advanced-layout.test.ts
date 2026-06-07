/**
 * Unit tests for the Phase 5-7 advanced layout BRANCHES (task 7.1; design.md
 * §8.2 note; Requirement 16.1: "THE Layout_Engine SHALL support flexbox, grid,
 * table, float, and positioned layout").
 *
 * Built by `tsc` then run with: `node --test packages/layout/dist/*.test.js`.
 *
 * These exercise the new branches dispatched off `display` / `position` /
 * `float`: flex (row main-axis distribution + column stacking), grid (row-major
 * placement into equal-width cells), table (rows → cells), float (shifted out of
 * flow with following content flowing), and positioned (relative offset keeping
 * its in-flow space; absolute removed from flow). They also prove the branches
 * produce a valid, deep-frozen {@link FragmentTree} and that the default
 * block/inline path is unaffected when none of these properties are present.
 *
 * IMPORTANT (the pending generator extension): the cascade `generator` does not
 * yet emit `position` / `float` / `flex-direction` / `grid-template-columns` /
 * the `table` display keyword into the ComputedStyle property table, so the
 * layout engine reads them DEFENSIVELY off ComputedStyle's open
 * `[k: string]: unknown` index signature. These tests therefore drive the
 * branches with a SYNTHETIC ComputedStyle that carries the layout properties via
 * that open signature — mirroring how task 5.8 tested the `border` command.
 *
 * Layout lives inside a *stage* package, so (per `local/no-cross-stage-import`)
 * it may import ONLY the frozen IR (`@browser-engine/ir`) and the package under
 * test — never html-parser / cascade. The DomTree input and ComputedStyle table
 * are assembled here by hand as frozen IR values.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { deepFreeze, nodeId, px } from "@browser-engine/ir";
import type {
  Color,
  ComputedStyle,
  DomNode,
  DomTree,
  Edges,
  Fragment,
  FragmentTree,
  NodeId,
  Px,
} from "@browser-engine/ir";

import { DEFAULT_VIEWPORT_WIDTH, layout } from "./index.js";

// ---------------------------------------------------------------------------
// IR builders — assemble a frozen DomTree and a ComputedStyle table by hand
// (mirrors index.test.ts; kept local so this file is self-contained).
// ---------------------------------------------------------------------------

interface NodeSpec {
  readonly id: number;
  readonly kind: DomNode["kind"];
  readonly tag?: string;
  readonly text?: string;
  readonly children?: readonly number[];
  readonly parent: number | null;
}

/** Build a frozen DomTree from a flat list of node specs (root id 0). */
function buildDom(specs: readonly NodeSpec[]): DomTree {
  const nodes = new Map<NodeId, DomNode>();
  for (const spec of specs) {
    const base = {
      id: nodeId(spec.id),
      kind: spec.kind,
      children: (spec.children ?? []).map(nodeId),
      parent: spec.parent === null ? null : nodeId(spec.parent),
    };
    let node: DomNode;
    if (spec.kind === "element") {
      node = { ...base, tag: spec.tag ?? "", attrs: new Map<string, string>() };
    } else if (spec.kind === "text" || spec.kind === "comment") {
      node = { ...base, text: spec.text ?? "" };
    } else {
      node = base;
    }
    nodes.set(node.id, node);
  }
  return deepFreeze({ root: nodeId(0), nodes } as unknown as DomTree);
}

const BLACK: Color = { r: 0, g: 0, b: 0, a: 1 };
const TRANSPARENT: Color = { r: 0, g: 0, b: 0, a: 0 };
const ZERO_EDGES: Edges<Px> = { top: px(0), right: px(0), bottom: px(0), left: px(0) };

/**
 * Per-node style overrides. The Phase 1 fields are typed; the advanced layout
 * properties (display:table keyword, position/float/insets, flex-direction,
 * grid-template-columns) ride on the open index signature exactly as the
 * defensive layout readers consume them, since the generator does not yet emit
 * them as typed fields.
 */
interface StyleSpec {
  readonly display?: string;
  readonly width?: number | "auto";
  readonly height?: number | "auto";
  readonly margin?: Edges<Px>;
  readonly fontSize?: number;
  // Advanced (open index signature) — read defensively by the layout branches.
  readonly position?: string;
  readonly float?: string;
  readonly top?: number;
  readonly right?: number;
  readonly bottom?: number;
  readonly left?: number;
  readonly "flex-direction"?: string;
  readonly "grid-template-columns"?: number | readonly unknown[];
}

/** Build a frozen, geometry-free ComputedStyle from a partial spec. */
function makeStyle(spec: StyleSpec = {}): ComputedStyle {
  const style: Record<string, unknown> = {
    display: spec.display ?? "inline",
    color: BLACK,
    fontSize: px(spec.fontSize ?? 16),
    margin: spec.margin ?? ZERO_EDGES,
    width: spec.width ?? "auto",
    height: spec.height ?? "auto",
    backgroundColor: TRANSPARENT,
  };
  // Attach advanced properties only when supplied, so the "default path" tests
  // carry exactly the Phase 1 property set the real cascade emits.
  if (spec.position !== undefined) style["position"] = spec.position;
  if (spec.float !== undefined) style["float"] = spec.float;
  if (spec.top !== undefined) style["top"] = spec.top;
  if (spec.right !== undefined) style["right"] = spec.right;
  if (spec.bottom !== undefined) style["bottom"] = spec.bottom;
  if (spec.left !== undefined) style["left"] = spec.left;
  // The layout engine now reads the GENERATED camelCase fields (the names the
  // real cascade produces), so the synthetic style must use them too.
  if (spec["flex-direction"] !== undefined) style["flexDirection"] = spec["flex-direction"];
  if (spec["grid-template-columns"] !== undefined) {
    style["gridTemplateColumns"] = spec["grid-template-columns"];
  }
  return deepFreeze(style as unknown as ComputedStyle);
}

/** Make a `computedStyleOf` callback from a per-node style map (default: initial). */
function styleTable(map: ReadonlyMap<number, ComputedStyle>): (node: NodeId) => ComputedStyle {
  const fallback = makeStyle();
  return (node: NodeId) => map.get(node) ?? fallback;
}

/** The fragment whose back-reference is `node` (or undefined). */
function fragmentOf(tree: FragmentTree, node: NodeId): Fragment | undefined {
  for (const frag of tree.fragments.values()) {
    if (frag.node === node) return frag;
  }
  return undefined;
}

/** Assert the whole FragmentTree is deep-frozen (Req 3.2). */
function assertFrozenTree(tree: FragmentTree): void {
  assert.ok(Object.isFrozen(tree));
  assert.ok(Object.isFrozen(tree.fragments));
  for (const frag of tree.fragments.values()) {
    assert.ok(Object.isFrozen(frag));
    assert.ok(Object.isFrozen(frag.box));
    assert.ok(Object.isFrozen(frag.box.borderBox));
    assert.ok(Object.isFrozen(frag.box.marginBox));
    assert.ok(Object.isFrozen(frag.children));
  }
}

// ===========================================================================
// FLEX (display:flex) — Req 16.1
// ===========================================================================

void test("flex row lays children along the MAIN axis with monotonic x and shared widths (Req 16.1)", () => {
  // document → flex(1) { a(2), b(3), c(4) } — all auto width ⇒ equal thirds.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3, 4] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 4, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "flex", width: 300, height: 50 })],
      [2, makeStyle({ display: "block", height: 20 })],
      [3, makeStyle({ display: "block", height: 30 })],
      [4, makeStyle({ display: "block", height: 10 })],
    ]),
  );

  const tree = layout(dom, styles);
  const flex = fragmentOf(tree, nodeId(1))!;
  const kids = flex.children.map((id) => tree.fragments.get(id)!);
  assert.equal(kids.length, 3);

  // Three auto-width items share 300px equally ⇒ 100px each.
  for (const kid of kids) {
    assert.equal(kid.box.width, px(100));
  }
  // Laid along the main (x) axis: x increases by each item's width; all at y=0.
  assert.equal(kids[0]!.box.borderBox.x, px(0));
  assert.equal(kids[1]!.box.borderBox.x, px(100));
  assert.equal(kids[2]!.box.borderBox.x, px(200));
  for (const kid of kids) {
    assert.equal(kid.box.borderBox.y, px(0), "row items align to the cross-start edge");
  }
});

void test("flex row keeps a declared-width item fixed and shares the rest among flexible items", () => {
  // a(2) is 120px fixed; b(3)/c(4) are auto ⇒ split the remaining 180px ⇒ 90 each.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3, 4] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 4, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "flex", width: 300 })],
      [2, makeStyle({ display: "block", width: 120, height: 10 })],
      [3, makeStyle({ display: "block", height: 10 })],
      [4, makeStyle({ display: "block", height: 10 })],
    ]),
  );

  const tree = layout(dom, styles);
  const flex = fragmentOf(tree, nodeId(1))!;
  const kids = flex.children.map((id) => tree.fragments.get(id)!);

  assert.equal(kids[0]!.box.width, px(120), "fixed item keeps its declared width");
  assert.equal(kids[1]!.box.width, px(90), "flexible items split the remaining 180px");
  assert.equal(kids[2]!.box.width, px(90));
  // Packed along the main axis with no overlap.
  assert.equal(kids[0]!.box.borderBox.x, px(0));
  assert.equal(kids[1]!.box.borderBox.x, px(120));
  assert.equal(kids[2]!.box.borderBox.x, px(210));
});

void test("flex column stacks children along the vertical main axis (monotonic y)", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "flex", "flex-direction": "column", width: 200 })],
      [2, makeStyle({ display: "block", height: 40 })],
      [3, makeStyle({ display: "block", height: 60 })],
    ]),
  );

  const tree = layout(dom, styles);
  const flex = fragmentOf(tree, nodeId(1))!;
  const kids = flex.children.map((id) => tree.fragments.get(id)!);

  assert.equal(kids[0]!.box.borderBox.y, px(0));
  assert.equal(kids[1]!.box.borderBox.y, px(40), "second item stacks below the first");
  // Column main-axis height is the sum of the items' heights.
  assert.equal(flex.box.height, px(100));
});

// ===========================================================================
// GRID (display:grid) — Req 16.1
// ===========================================================================

void test("grid places children row-major into equal-width cells (Req 16.1)", () => {
  // 2-column grid of 4 children ⇒ a 2×2 arrangement in a 200px container.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3, 4, 5] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 4, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 5, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const cell = makeStyle({ display: "block", height: 25 });
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "grid", width: 200, "grid-template-columns": 2 })],
      [2, cell],
      [3, cell],
      [4, cell],
      [5, cell],
    ]),
  );

  const tree = layout(dom, styles);
  const grid = fragmentOf(tree, nodeId(1))!;
  const cells = grid.children.map((id) => tree.fragments.get(id)!);
  assert.equal(cells.length, 4);

  // Equal cell width = 200 / 2 = 100.
  for (const c of cells) {
    assert.equal(c.box.width, px(100));
  }
  // Row-major placement: (col0,row0)=(0,0) (col1,row0)=(100,0)
  //                      (col0,row1)=(0,25) (col1,row1)=(100,25).
  assert.deepEqual(
    cells.map((c) => [c.box.borderBox.x, c.box.borderBox.y]),
    [
      [px(0), px(0)],
      [px(100), px(0)],
      [px(0), px(25)],
      [px(100), px(25)],
    ],
  );
  // Two rows of height 25 ⇒ content height 50.
  assert.equal(grid.box.height, px(50));
});

void test("grid with a missing track count defaults to a single column", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "grid", width: 150 })], // no grid-template-columns.
      [2, makeStyle({ display: "block", height: 10 })],
      [3, makeStyle({ display: "block", height: 20 })],
    ]),
  );

  const tree = layout(dom, styles);
  const grid = fragmentOf(tree, nodeId(1))!;
  const cells = grid.children.map((id) => tree.fragments.get(id)!);

  // One column ⇒ full-width cells stacked vertically.
  for (const c of cells) {
    assert.equal(c.box.width, px(150));
  }
  assert.equal(cells[0]!.box.borderBox.y, px(0));
  assert.equal(cells[1]!.box.borderBox.y, px(10));
});

// ===========================================================================
// TABLE (display:table) — Req 16.1
// ===========================================================================

void test("table lays out rows and cells with aligned columns (Req 16.1)", () => {
  // table(1) → row(2){ cell(4), cell(5) }, row(3){ cell(6), cell(7) }.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "table", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "tr", parent: 1, children: [4, 5] },
    { id: 3, kind: "element", tag: "tr", parent: 1, children: [6, 7] },
    { id: 4, kind: "element", tag: "td", parent: 2, children: [] },
    { id: 5, kind: "element", tag: "td", parent: 2, children: [] },
    { id: 6, kind: "element", tag: "td", parent: 3, children: [] },
    { id: 7, kind: "element", tag: "td", parent: 3, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "table", width: 200 })],
      [2, makeStyle({ display: "block" })],
      [3, makeStyle({ display: "block" })],
      [4, makeStyle({ display: "block", height: 30 })],
      [5, makeStyle({ display: "block", height: 20 })],
      [6, makeStyle({ display: "block", height: 15 })],
      [7, makeStyle({ display: "block", height: 25 })],
    ]),
  );

  const tree = layout(dom, styles);
  const table = fragmentOf(tree, nodeId(1))!;
  // The table's children are the two row fragments.
  assert.equal(table.children.length, 2);
  const row0 = tree.fragments.get(table.children[0]!)!;
  const row1 = tree.fragments.get(table.children[1]!)!;
  assert.equal(row0.node, nodeId(2));
  assert.equal(row1.node, nodeId(3));

  // Rows span the table width and stack top-to-bottom; row height = tallest cell.
  assert.equal(row0.box.width, px(200));
  assert.equal(row0.box.borderBox.y, px(0));
  assert.equal(row0.box.height, px(30), "row 0 height = max(30, 20)");
  assert.equal(row1.box.borderBox.y, px(30), "row 1 stacks below row 0");
  assert.equal(row1.box.height, px(25), "row 1 height = max(15, 25)");
  assert.equal(table.box.height, px(55), "table height = sum of row heights");

  // Cells in a row align to a shared column width (200 / 2 = 100).
  const c0 = tree.fragments.get(row0.children[0]!)!;
  const c1 = tree.fragments.get(row0.children[1]!)!;
  assert.equal(c0.box.width, px(100));
  assert.equal(c1.box.width, px(100));
  assert.equal(c0.box.borderBox.x, px(0));
  assert.equal(c1.box.borderBox.x, px(100), "second cell sits in the next column");
});

// ===========================================================================
// FLOAT (float:left|right) — Req 16.1
// ===========================================================================

void test("a floated box shifts out of flow and following content flows beside it (Req 16.1)", () => {
  // container(1) → float-left(2), in-flow(3), in-flow(4).
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3, 4] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 4, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 400 })],
      [2, makeStyle({ display: "block", float: "left", width: 100, height: 50 })],
      [3, makeStyle({ display: "block", height: 20 })],
      [4, makeStyle({ display: "block", height: 20 })],
    ]),
  );

  const tree = layout(dom, styles);
  const container = fragmentOf(tree, nodeId(1))!;
  const floatFrag = fragmentOf(tree, nodeId(2))!;
  const flow1 = fragmentOf(tree, nodeId(3))!;
  const flow2 = fragmentOf(tree, nodeId(4))!;

  // The float sits at the left edge, top of the container.
  assert.equal(floatFrag.box.borderBox.x, px(0));
  assert.equal(floatFrag.box.borderBox.y, px(0));
  // The float is OUT of the vertical flow: the first in-flow box starts at y=0
  // (it is not pushed down by the float's 50px height), and the second stacks
  // after only the in-flow boxes.
  assert.equal(flow1.box.borderBox.y, px(0), "in-flow content starts at the top, beside the float");
  assert.equal(flow2.box.borderBox.y, px(20), "in-flow boxes stack among themselves");
  // Container auto height reflects only the in-flow content (20 + 20).
  assert.equal(container.box.height, px(40));
});

void test("a right-floated box is shifted to the container's right content edge", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 400 })],
      [2, makeStyle({ display: "block", float: "right", width: 100, height: 50 })],
    ]),
  );

  const tree = layout(dom, styles);
  const floatFrag = fragmentOf(tree, nodeId(2))!;
  // Right edge: container width (400) - float margin-box width (100) = 300.
  assert.equal(floatFrag.box.borderBox.x, px(300));
  assert.equal(floatFrag.box.borderBox.y, px(0));
});

// ===========================================================================
// POSITIONED (position:relative|absolute) — Req 16.1
// ===========================================================================

void test("a relatively positioned box is visually offset but keeps its in-flow space (Req 16.1)", () => {
  // container(1) → a(2) relative top:5 left:8, b(3) in-flow below a.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 300 })],
      [2, makeStyle({ display: "block", height: 40, position: "relative", top: 5, left: 8 })],
      [3, makeStyle({ display: "block", height: 30 })],
    ]),
  );

  const tree = layout(dom, styles);
  const a = fragmentOf(tree, nodeId(2))!;
  const b = fragmentOf(tree, nodeId(3))!;

  // a is offset by its insets from its normal-flow origin (0,0).
  assert.equal(a.box.borderBox.x, px(8));
  assert.equal(a.box.borderBox.y, px(5));
  // b keeps the space a would have occupied (a's 40px), so it sits at y=40, NOT
  // pushed by a's visual offset.
  assert.equal(b.box.borderBox.y, px(40), "relative offset preserves in-flow space");
});

void test("an absolutely positioned box is removed from flow and placed at its insets (Req 16.1)", () => {
  // container(1) → abs(2) at top:10 left:20, flow(3), flow(4).
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3, 4] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 4, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 300 })],
      [2, makeStyle({ display: "block", height: 40, position: "absolute", top: 10, left: 20 })],
      [3, makeStyle({ display: "block", height: 15 })],
      [4, makeStyle({ display: "block", height: 25 })],
    ]),
  );

  const tree = layout(dom, styles);
  const abs = fragmentOf(tree, nodeId(2))!;
  const flow1 = fragmentOf(tree, nodeId(3))!;
  const flow2 = fragmentOf(tree, nodeId(4))!;
  const container = fragmentOf(tree, nodeId(1))!;

  // Absolute box placed at its insets relative to the container content origin.
  assert.equal(abs.box.borderBox.x, px(20));
  assert.equal(abs.box.borderBox.y, px(10));
  // It is out of flow: the in-flow boxes start at y=0 and stack among themselves
  // only, ignoring the absolute box entirely.
  assert.equal(flow1.box.borderBox.y, px(0), "absolute box reserves no in-flow space");
  assert.equal(flow2.box.borderBox.y, px(15));
  assert.equal(container.box.height, px(40), "auto height ignores the out-of-flow box");
});

void test("bottom/right insets offset a relative box upward/left when top/left are absent", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 300 })],
      [2, makeStyle({ display: "block", height: 40, position: "relative", bottom: 5, right: 8 })],
    ]),
  );

  const tree = layout(dom, styles);
  const a = fragmentOf(tree, nodeId(2))!;
  // bottom/right map to negative top/left offsets.
  assert.equal(a.box.borderBox.x, px(-8));
  assert.equal(a.box.borderBox.y, px(-5));
});

// ===========================================================================
// Every advanced branch produces a VALID, deep-frozen FragmentTree (Req 3.2).
// ===========================================================================

void test("each advanced mode produces a deep-frozen FragmentTree (Req 3.2)", () => {
  const cases: ReadonlyMap<number, ComputedStyle>[] = [
    new Map([[1, makeStyle({ display: "flex", width: 300 })]]),
    new Map([[1, makeStyle({ display: "grid", width: 200, "grid-template-columns": 2 })]]),
    new Map([[1, makeStyle({ display: "block", width: 300 })], [2, makeStyle({ display: "block", float: "left", width: 50, height: 20 })]]),
    new Map([[1, makeStyle({ display: "block", width: 300 })], [2, makeStyle({ display: "block", position: "absolute", top: 5, left: 5, height: 20 })]]),
  ];
  for (const map of cases) {
    const dom = buildDom([
      { id: 0, kind: "document", parent: null, children: [1] },
      { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
      { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
      { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
    ]);
    const tree = layout(dom, styleTable(map));
    assertFrozenTree(tree);
  }
});

void test("advanced layout is deterministic: same inputs ⇒ structurally equal trees (Req 2.7)", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "flex", width: 300 })],
      [2, makeStyle({ display: "block", height: 10 })],
      [3, makeStyle({ display: "block", height: 20 })],
    ]),
  );
  const a = layout(dom, styles);
  const b = layout(dom, styles);
  assert.equal(a.fragments.size, b.fragments.size);
  for (const [id, fragA] of a.fragments) {
    assert.deepEqual(fragA, b.fragments.get(id));
  }
});

// ===========================================================================
// The default block/inline path is UNAFFECTED when no advanced props present.
// ===========================================================================

void test("a plain block document (no advanced props) lays out exactly as before", () => {
  // Mirrors index.test.ts's stacking case: three blocks stack top-to-bottom.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3, 4] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 4, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block" })],
      [2, makeStyle({ display: "block", height: 10 })],
      [3, makeStyle({ display: "block", height: 20 })],
      [4, makeStyle({ display: "block", height: 30 })],
    ]),
  );

  const tree = layout(dom, styles);
  const div = fragmentOf(tree, nodeId(1))!;
  const kids = div.children.map((id) => tree.fragments.get(id)!);

  // Block stacking is unchanged: monotonic y, full-viewport auto width.
  assert.equal(div.box.width, DEFAULT_VIEWPORT_WIDTH);
  assert.equal(kids[0]!.box.borderBox.y, px(0));
  assert.equal(kids[1]!.box.borderBox.y, px(10));
  assert.equal(kids[2]!.box.borderBox.y, px(30));
  assert.equal(div.box.height, px(60));
  // No child was shifted horizontally (no float/positioning).
  for (const kid of kids) {
    assert.equal(kid.box.borderBox.x, px(0));
  }
});

void test("static-position / float:none children take the normal-flow path verbatim", () => {
  // Carrying position:static and float:none must behave identically to omitting
  // them — the defensive readers fall back to the flow path.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const withProps = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 300 })],
      [2, makeStyle({ display: "block", height: 12, position: "static", float: "none" })],
      [3, makeStyle({ display: "block", height: 18, position: "static", float: "none" })],
    ]),
  );
  const without = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 300 })],
      [2, makeStyle({ display: "block", height: 12 })],
      [3, makeStyle({ display: "block", height: 18 })],
    ]),
  );

  const a = layout(dom, withProps);
  const b = layout(dom, without);
  // Same geometry on every fragment.
  for (const [id, fragA] of a.fragments) {
    assert.deepEqual(fragA.box, b.fragments.get(id)!.box);
  }
});
