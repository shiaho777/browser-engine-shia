/**
 * Unit tests for RFC 0003 — block formatting contexts: margin collapsing
 * (CSS 2.1 §8.3.1) and float intrusion into line boxes (§9.5), driven through
 * the shared `BlockFormattingContext` registry.
 *
 * As with `advanced-layout.test.ts`, the DomTree and ComputedStyle tables are
 * assembled by hand as frozen IR values (the stage boundary means layout can
 * only consume IR). Text tests rely on the default metrics shaper: every code
 * unit advances `fontSize × 0.5` = 8px at the default 16px font size, and one
 * line box is 16px tall.
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

import { layout } from "./index.js";

// ---------------------------------------------------------------------------
// IR builders (same shape as the other layout test files).
// ---------------------------------------------------------------------------

interface NodeSpec {
  readonly id: number;
  readonly kind: DomNode["kind"];
  readonly tag?: string;
  readonly text?: string;
  readonly children?: readonly number[];
  readonly parent: number | null;
}

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
const edges = (top: number, right: number, bottom: number, left: number): Edges<Px> => ({
  top: px(top),
  right: px(right),
  bottom: px(bottom),
  left: px(left),
});

interface StyleSpec {
  readonly display?: string;
  readonly width?: number | "auto";
  readonly height?: number | "auto";
  readonly margin?: Edges<Px>;
  readonly padding?: Edges<Px>;
  readonly fontSize?: number;
  readonly position?: string;
  readonly float?: string;
  readonly clear?: string;
  readonly overflow?: string;
  readonly borderWidth?: Edges<Px>;
  readonly borderStyle?: string;
}

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
  if (spec.padding !== undefined) style["padding"] = spec.padding;
  if (spec.position !== undefined) style["position"] = spec.position;
  if (spec.float !== undefined) style["float"] = spec.float;
  if (spec.clear !== undefined) style["clear"] = spec.clear;
  if (spec.overflow !== undefined) style["overflow"] = spec.overflow;
  if (spec.borderWidth !== undefined) style["borderWidth"] = spec.borderWidth;
  if (spec.borderStyle !== undefined) style["borderStyle"] = spec.borderStyle;
  return deepFreeze(style as unknown as ComputedStyle);
}

function styleTable(map: ReadonlyMap<number, ComputedStyle>): (node: NodeId) => ComputedStyle {
  const fallback = makeStyle();
  return (node: NodeId) => map.get(node) ?? fallback;
}

function fragmentOf(tree: FragmentTree, node: NodeId): Fragment | undefined {
  for (const frag of tree.fragments.values()) {
    if (frag.node === node) return frag;
  }
  return undefined;
}

/** Absolute (root-frame) margin-box rect of a fragment's node. */
function absBox(tree: FragmentTree, node: NodeId): { x: number; y: number } {
  // Walk ancestors: a fragment's box is relative to its containing block, so
  // accumulate margin-box offsets up the fragment tree.
  const byNode = new Map<NodeId, Fragment>();
  for (const frag of tree.fragments.values()) byNode.set(frag.node, frag);
  const parentOf = new Map<Fragment, Fragment>();
  for (const frag of tree.fragments.values()) {
    for (const cid of frag.children) {
      parentOf.set(tree.fragments.get(cid)!, frag);
    }
  }
  let frag = byNode.get(node)!;
  let x = Number(frag.box.marginBox.x);
  let y = Number(frag.box.marginBox.y);
  while (parentOf.has(frag)) {
    frag = parentOf.get(frag)!;
    x += Number(frag.box.marginBox.x);
    y += Number(frag.box.marginBox.y);
  }
  return { x, y };
}

// ===========================================================================
// MARGIN COLLAPSING (CSS 2.1 §8.3.1)
// ===========================================================================

void test("adjoining sibling margins collapse to the larger value", () => {
  // A(2) h=10 mb=20, B(3) h=10 mt=30: B's border top sits 30 (max, not 50)
  // below A's border bottom.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block" })],
      [2, makeStyle({ display: "block", height: 10, margin: edges(0, 0, 20, 0) })],
      [3, makeStyle({ display: "block", height: 10, margin: edges(30, 0, 0, 0) })],
    ]),
  );
  const tree = layout(dom, styles);
  const a = fragmentOf(tree, nodeId(2))!;
  const b = fragmentOf(tree, nodeId(3))!;
  assert.equal(Number(b.box.borderBox.y) - Number(a.box.borderBox.y) - Number(a.box.borderBox.height), px(30));
});

void test("a positive and a negative margin collapse by addition", () => {
  // A(2) h=10 mb=20, B(3) h=10 mt=-10: collapsed = 20 + (-10) = 10.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block" })],
      [2, makeStyle({ display: "block", height: 10, margin: edges(0, 0, 20, 0) })],
      [3, makeStyle({ display: "block", height: 10, margin: edges(-10, 0, 0, 0) })],
    ]),
  );
  const tree = layout(dom, styles);
  const a = fragmentOf(tree, nodeId(2))!;
  const b = fragmentOf(tree, nodeId(3))!;
  assert.equal(Number(b.box.borderBox.y) - Number(a.box.borderBox.y) - Number(a.box.borderBox.height), px(10));
});

void test("an empty block's top and bottom margins collapse into the chain", () => {
  // A(2) h=10 mb=20, EMPTY(3) mt=10 mb=30 h=0, B(4) h=10 mt=5.
  // Empty: border top = A_bb + collapsed(20,10) = 30; chain continues with
  // collapsed(20,10,30)=30; B: gap = collapsed(30,5) = 30 → B top = A_bb+30.
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
      [2, makeStyle({ display: "block", height: 10, margin: edges(0, 0, 20, 0) })],
      [3, makeStyle({ display: "block", height: 0, margin: edges(10, 0, 30, 0) })],
      [4, makeStyle({ display: "block", height: 10, margin: edges(5, 0, 0, 0) })],
    ]),
  );
  const tree = layout(dom, styles);
  const a = fragmentOf(tree, nodeId(2))!;
  const empty = fragmentOf(tree, nodeId(3))!;
  const b = fragmentOf(tree, nodeId(4))!;
  const aBB = Number(a.box.borderBox.y) + Number(a.box.borderBox.height);
  assert.equal(empty.box.borderBox.y, px(aBB + 20), "empty block border top inside the merged margin");
  assert.equal(empty.box.borderBox.height, px(0));
  assert.equal(b.box.borderBox.y, px(aBB + 30), "B collapses against the merged empty margin");
});

void test("a parent's top margin collapses with its first in-flow child's", () => {
  // parent(1) mt=20 (no border/padding) > child(2) mt=30 h=10.
  // Joint top margin = collapsed(20,30) = 30: the parent border top is 30
  // below its margin-box top AND the child's border top coincides with the
  // parent's content top (= its border top here).
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", margin: edges(20, 0, 0, 0) })],
      [2, makeStyle({ display: "block", height: 10, margin: edges(30, 0, 0, 0) })],
    ]),
  );
  const tree = layout(dom, styles);
  const parent = fragmentOf(tree, nodeId(1))!;
  const child = fragmentOf(tree, nodeId(2))!;
  assert.equal(parent.box.borderBox.y, px(30), "collapsed joint top margin pushes the border box");
  assert.equal(child.box.borderBox.y, px(30), "child border top = parent content top");
});

void test("a top border stops parent/first-child margin collapse", () => {
  // parent(1) mt=20 borderTop 1 > child(2) mt=30: no collapse — the child
  // keeps its own margin inside the parent.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [
        1,
        makeStyle({
          display: "block",
          margin: edges(20, 0, 0, 0),
          borderWidth: edges(1, 0, 0, 0),
          borderStyle: "solid",
        }),
      ],
      [2, makeStyle({ display: "block", height: 10, margin: edges(30, 0, 0, 0) })],
    ]),
  );
  const tree = layout(dom, styles);
  const parent = fragmentOf(tree, nodeId(1))!;
  const child = fragmentOf(tree, nodeId(2))!;
  assert.equal(parent.box.borderBox.y, px(20), "parent keeps its own margin");
  // child border top = parent border-top(20) + border(1) + child mt(30).
  assert.equal(child.box.borderBox.y, px(51));
});

void test("a parent's bottom margin collapses with its last in-flow child's", () => {
  // parent(1) mb=10 > child(2) h=20 mb=30 → marginBox.height = 20 + max(10,30).
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", margin: edges(0, 0, 10, 0) })],
      [2, makeStyle({ display: "block", height: 20, margin: edges(0, 0, 30, 0) })],
    ]),
  );
  const tree = layout(dom, styles);
  const parent = fragmentOf(tree, nodeId(1))!;
  assert.equal(parent.box.height, px(20), "content height is the child's border bottom");
  assert.equal(parent.box.marginBox.height, px(50), "child bottom margin folded into parent's");
});

void test("a BFC-establishing parent never collapses margins with children", () => {
  // parent(1) overflow:hidden mt=20 > child(2) mt=30: the child's margin
  // applies INSIDE the parent — child border top = parent content top + 30.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", overflow: "hidden", margin: edges(20, 0, 0, 0) })],
      [2, makeStyle({ display: "block", height: 10, margin: edges(30, 0, 0, 0) })],
    ]),
  );
  const tree = layout(dom, styles);
  const parent = fragmentOf(tree, nodeId(1))!;
  const child = fragmentOf(tree, nodeId(2))!;
  assert.equal(parent.box.borderBox.y, px(20), "parent keeps its own 20px margin");
  assert.equal(child.box.borderBox.y, px(50), "child margin lives inside the BFC parent");
});

// ===========================================================================
// FLOAT INTRUSION INTO LINE BOXES (CSS 2.1 §9.5, RFC 0003)
// ===========================================================================

const WORD = "aaaaaaaaaa"; // 10 chars × 8px = 80px at the default shaper.

void test("line boxes shorten and shift beside a left float, then regain width below it", () => {
  // container(1) w=400 > float-left(2) 100×32, text(3). Beside the float the
  // free width is 300 → 3 words/line (256 ≤ 300 < 344); below y=32 the full
  // 400 fits 4 words/line.
  const text = Array.from({ length: 14 }, () => WORD).join(" ");
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "text", parent: 1, text },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 400 })],
      [2, makeStyle({ display: "block", float: "left", width: 100, height: 32 })],
      [3, makeStyle()],
    ]),
  );
  const tree = layout(dom, styles);
  const run = fragmentOf(tree, nodeId(3))!;
  const gx = run.box.marginBox.x;
  const gy = run.box.marginBox.y;
  const glyphs = run.text!.glyphs;

  // Line 0 (y<16, inside the float's vertical span): every glyph sits right
  // of the float's 100px.
  const line0 = glyphs.filter((g) => Number(g.y) < 16);
  assert.ok(line0.length === 3 * WORD.length, "3 words fit beside the float");
  const minX0 = Math.min(...line0.map((g) => Number(gx) + Number(g.x)));
  assert.equal(minX0, 100, "line boxes start at the float's right edge");

  // A line starting below the float (y≥32) regains the full 400px — 4 words.
  const line2 = glyphs.filter((g) => Number(g.y) >= 32 && Number(g.y) < 48);
  assert.ok(line2.length === 4 * WORD.length, "4 words fit on a line below the float");
  const minX2 = Math.min(...line2.map((g) => Number(gx) + Number(g.x)));
  assert.equal(minX2, 0, "a line below the float starts at the left edge");
  void gy;
});

void test("line boxes shorten against a right float", () => {
  // container(1) w=400 > float-right(2) 100×32, text(3). Free width beside
  // the float is 300 → glyphs on line 0 must stay ≤ x=300.
  const text = Array.from({ length: 14 }, () => WORD).join(" ");
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "text", parent: 1, text },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 400 })],
      [2, makeStyle({ display: "block", float: "right", width: 100, height: 32 })],
      [3, makeStyle()],
    ]),
  );
  const tree = layout(dom, styles);
  const run = fragmentOf(tree, nodeId(3))!;
  const gx = run.box.marginBox.x;
  const line0 = run.text!.glyphs.filter((g) => Number(g.y) < 16);
  const maxRight0 = Math.max(...line0.map((g) => Number(gx) + Number(g.x) + Number(g.advance)));
  assert.ok(maxRight0 <= 300, `line 0 stays left of the right float (right edge ${maxRight0})`);
});

void test("an outer float narrows line boxes inside a nested non-BFC block", () => {
  // container(1) w=400 > float-left(2) 100×32, wrapper(3) > text(4). The
  // wrapper is a NORMAL block — its border box keeps full width, but its line
  // boxes (in the shared BFC) still shorten around the float.
  const text = Array.from({ length: 6 }, () => WORD).join(" ");
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [4] },
    { id: 4, kind: "text", parent: 3, text },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 400 })],
      [2, makeStyle({ display: "block", float: "left", width: 100, height: 32 })],
      [3, makeStyle({ display: "block" })],
      [4, makeStyle()],
    ]),
  );
  const tree = layout(dom, styles);
  const wrapper = fragmentOf(tree, nodeId(3))!;
  const run = fragmentOf(tree, nodeId(4))!;
  assert.equal(wrapper.box.width, px(400), "normal block keeps full border-box width");
  const abs = absBox(tree, nodeId(4));
  const line0 = run.text!.glyphs.filter((g) => Number(g.y) < 16);
  const minX0 = Math.min(...line0.map((g) => Number(abs.x) + Number(g.x)));
  assert.equal(minX0, 100, "nested line boxes shorten around the outer float");
});

void test("a float inside a nested non-BFC block intrudes on outer line boxes", () => {
  // container(1) w=400 > wrapper(3){float-left(4) 100×32}, text(2). The
  // nested float lives in the shared BFC, so the OUTER text wraps around it.
  const text = Array.from({ length: 6 }, () => WORD).join(" ");
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [3, 2] },
    { id: 2, kind: "text", parent: 1, text },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [4] },
    { id: 4, kind: "element", tag: "div", parent: 3, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 400 })],
      [2, makeStyle()],
      [3, makeStyle({ display: "block" })],
      [4, makeStyle({ display: "block", float: "left", width: 100, height: 32 })],
    ]),
  );
  const tree = layout(dom, styles);
  const run = fragmentOf(tree, nodeId(2))!;
  const gx = run.box.marginBox.x;
  const line0 = run.text!.glyphs.filter((g) => Number(g.y) < 16);
  const minX0 = Math.min(...line0.map((g) => Number(gx) + Number(g.x)));
  assert.equal(minX0, 100, "outer text wraps around the nested float");
});

void test("a BFC root grows to contain its floats (the clearfix behaviour)", () => {
  // container(1) overflow:hidden > float-left(2) 100×50 only → height 50.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", overflow: "hidden", width: 400 })],
      [2, makeStyle({ display: "block", float: "left", width: 100, height: 50 })],
    ]),
  );
  const tree = layout(dom, styles);
  const container = fragmentOf(tree, nodeId(1))!;
  assert.equal(container.box.height, px(50), "BFC height contains the float's bottom");
});

void test("a float drops below a same-side float when the width cannot fit", () => {
  // container(1) w=150 > float-left(2) 100×50, float-left(3) 100×30.
  // The second float cannot fit beside the first (50px free < 100) → drops.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 150 })],
      [2, makeStyle({ display: "block", float: "left", width: 100, height: 50 })],
      [3, makeStyle({ display: "block", float: "left", width: 100, height: 30 })],
    ]),
  );
  const tree = layout(dom, styles);
  const f1 = fragmentOf(tree, nodeId(2))!;
  const f2 = fragmentOf(tree, nodeId(3))!;
  assert.equal(f1.box.borderBox.y, px(0));
  assert.equal(f2.box.borderBox.y, px(50), "second float drops below the first");
  assert.equal(f2.box.borderBox.x, px(0), "still pinned to the left edge");
});

void test("clear:both pushes a block below the floats", () => {
  // container(1) w=400 > float-left(2) 100×50, div(3) clear:both h=10.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 400 })],
      [2, makeStyle({ display: "block", float: "left", width: 100, height: 50 })],
      [3, makeStyle({ display: "block", height: 10, clear: "both" })],
    ]),
  );
  const tree = layout(dom, styles);
  const cleared = fragmentOf(tree, nodeId(3))!;
  assert.equal(cleared.box.borderBox.y, px(50), "cleared box starts below the float");
});

void test("a float's own clear pushes it below matching floats", () => {
  // container(1) w=400 > float-left(2) 100×50, float-right(3) 100×30
  // clear:left → the right float must drop below the left float.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 400 })],
      [2, makeStyle({ display: "block", float: "left", width: 100, height: 50 })],
      [3, makeStyle({ display: "block", float: "right", width: 100, height: 30, clear: "left" })],
    ]),
  );
  const tree = layout(dom, styles);
  const f2 = fragmentOf(tree, nodeId(3))!;
  assert.equal(f2.box.borderBox.y, px(50), "clear:left drops the right float below the left float");
  assert.equal(f2.box.borderBox.x, px(300), "still pinned to the right edge");
});

void test("clear:left ignores a right float", () => {
  // container(1) w=400 > float-right(2) 100×50, div(3) clear:left h=10 → no
  // descent (nothing to clear).
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 400 })],
      [2, makeStyle({ display: "block", float: "right", width: 100, height: 50 })],
      [3, makeStyle({ display: "block", height: 10, clear: "left" })],
    ]),
  );
  const tree = layout(dom, styles);
  const cleared = fragmentOf(tree, nodeId(3))!;
  assert.equal(cleared.box.borderBox.y, px(0), "a right float does not trigger clear:left");
});
