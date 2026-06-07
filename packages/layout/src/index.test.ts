/**
 * Unit tests for the minimal block-level layout engine (task 3.7; design.md
 * §8.2; Requirements 14.1, 2.7).
 *
 * Built by `tsc` then run with: `node --test packages/layout/dist/*.test.js`.
 *
 * Layout lives inside a *stage* package, so (per `local/no-cross-stage-import`)
 * it may import ONLY the frozen IR (`@browser-engine/ir`) and the package under
 * test — never html-parser / cascade. The DomTree input is therefore built here
 * by hand as a frozen IR value, and `ComputedStyle` is supplied through the same
 * `computedStyleOf` callback the pipeline injects (layout never imports the
 * cascade).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { deepFreeze, nodeId, px } from "@browser-engine/ir";
import type {
  Color,
  ComputedStyle,
  DisplayValue,
  DomNode,
  DomTree,
  Edges,
  NodeId,
  Px,
} from "@browser-engine/ir";

import { DEFAULT_VIEWPORT_WIDTH, layout } from "./index.js";

// ---------------------------------------------------------------------------
// IR builders — assemble a frozen DomTree and a ComputedStyle table by hand.
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

/** Per-node style overrides; anything omitted takes a Phase 1 initial value. */
interface StyleSpec {
  readonly display?: DisplayValue;
  readonly width?: number | "auto";
  readonly height?: number | "auto";
  readonly margin?: Edges<Px>;
  readonly fontSize?: number;
  readonly extra?: Readonly<Record<string, unknown>>;
}

/**
 * Build a frozen, geometry-free ComputedStyle from a partial spec, filling the
 * Phase 1 initial values for anything unspecified (display:inline, width/height
 * auto, margin 0, font-size 16) — exactly the shape the cascade emits.
 */
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
  if (spec.extra !== undefined) Object.assign(style, spec.extra);
  return deepFreeze(style as unknown as ComputedStyle);
}

/** Make a `computedStyleOf` callback from a per-node style map (default: initial). */
function styleTable(map: ReadonlyMap<number, ComputedStyle>): (node: NodeId) => ComputedStyle {
  const fallback = makeStyle();
  return (node: NodeId) => map.get(node) ?? fallback;
}

// ---------------------------------------------------------------------------
// A single block lays out with correct geometry.
// ---------------------------------------------------------------------------

void test("a single block fills the containing width and resolves a declared height (Req 14.2)", () => {
  // document(0) → div(1), div { display:block; height:50px }.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [] },
  ]);
  const styles = styleTable(new Map([[1, makeStyle({ display: "block", height: 50 })]]));

  const tree = layout(dom, styles);
  const rootFrag = tree.fragments.get(tree.root);
  assert.ok(rootFrag !== undefined);
  const divFrag = tree.fragments.get(rootFrag.children[0]!);
  assert.ok(divFrag !== undefined);

  // auto width fills the (default) viewport; declared height is honoured.
  assert.equal(divFrag.box.width, DEFAULT_VIEWPORT_WIDTH);
  assert.equal(divFrag.box.height, px(50));
  // Phase 1 has no padding/border: content/padding/border boxes share a size.
  assert.equal(divFrag.box.borderBox.width, divFrag.box.width);
  assert.equal(divFrag.box.contentBox.height, divFrag.box.height);
  // Single child placed at the top of the container's content box.
  assert.equal(divFrag.box.y, px(0));
});

void test("a declared width is used verbatim and clamped to non-negative", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [] },
  ]);
  const styles = styleTable(new Map([[1, makeStyle({ display: "block", width: 120, height: 30 })]]));
  const tree = layout(dom, styles);
  const root = tree.fragments.get(tree.root)!;
  const div = tree.fragments.get(root.children[0]!)!;
  assert.equal(div.box.width, px(120));
});

// ---------------------------------------------------------------------------
// Nested blocks stack with monotonically increasing y; cumulative height.
// ---------------------------------------------------------------------------

void test("nested blocks stack top-to-bottom with monotonically increasing y (design §8.2 invariant)", () => {
  // document(0) → div(1) with three block children a(2)/b(3)/c(4) of heights 10/20/30.
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
  const div = tree.fragments.get(tree.fragments.get(tree.root)!.children[0]!)!;
  const kids = div.children.map((id) => tree.fragments.get(id)!);
  assert.equal(kids.length, 3);

  // y is strictly increasing here (positive heights) and equals the running sum.
  assert.equal(kids[0]!.box.marginBox.y, px(0));
  assert.equal(kids[1]!.box.marginBox.y, px(10));
  assert.equal(kids[2]!.box.marginBox.y, px(30));

  // Monotonic non-decreasing in block flow: each child starts at the previous
  // child's margin-box bottom.
  for (let i = 1; i < kids.length; i += 1) {
    const prev = kids[i - 1]!.box.marginBox;
    const cur = kids[i]!.box.marginBox;
    assert.ok(cur.y >= prev.y, "block-flow y must be monotonically non-decreasing");
    assert.equal(cur.y, px(prev.y + prev.height));
  }
});

void test("a container's content height equals the sum of its children's margin-box heights (design §8.2)", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block" })], // auto height ⇒ content height.
      [2, makeStyle({ display: "block", height: 15 })],
      [3, makeStyle({ display: "block", height: 25, margin: { top: px(5), right: px(0), bottom: px(7), left: px(0) } })],
    ]),
  );

  const tree = layout(dom, styles);
  const div = tree.fragments.get(tree.fragments.get(tree.root)!.children[0]!)!;
  const kids = div.children.map((id) => tree.fragments.get(id)!);
  const sum = kids.reduce((acc, k) => acc + k.box.marginBox.height, 0);

  // child 2 margin box: 15; child 3 margin box: 5 + 25 + 7 = 37; total 52.
  assert.equal(sum, 52);
  assert.equal(div.box.height, px(sum));
});

// ---------------------------------------------------------------------------
// Margins are respected.
// ---------------------------------------------------------------------------

void test("horizontal margins shrink an auto width; vertical margins grow the margin box", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [] },
  ]);
  const margin: Edges<Px> = { top: px(8), right: px(12), bottom: px(4), left: px(10) };
  const styles = styleTable(new Map([[1, makeStyle({ display: "block", height: 40, margin })]]));

  const tree = layout(dom, styles);
  const div = tree.fragments.get(tree.fragments.get(tree.root)!.children[0]!)!;

  // auto width fills viewport minus left+right margins.
  assert.equal(div.box.width, px(DEFAULT_VIEWPORT_WIDTH - 10 - 12));
  // border box is inset from the margin-box origin by the top/left margins.
  assert.equal(div.box.borderBox.x, px(10));
  assert.equal(div.box.borderBox.y, px(8));
  // margin box is the border box grown by all four margins.
  assert.equal(div.box.marginBox.width, px(div.box.width + 10 + 12));
  assert.equal(div.box.marginBox.height, px(40 + 8 + 4));
  assert.equal(div.box.marginBox.x, px(0));
  assert.equal(div.box.marginBox.y, px(0));
});

// ---------------------------------------------------------------------------
// display:none produces no fragment.
// ---------------------------------------------------------------------------

void test("display:none produces no fragment and skips its subtree", () => {
  // document(0) → div(1) where div is display:none with a child(2).
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "span", parent: 1, children: [] },
  ]);
  const styles = styleTable(new Map([[1, makeStyle({ display: "none" })]]));

  const tree = layout(dom, styles);
  const root = tree.fragments.get(tree.root)!;
  assert.equal(root.children.length, 0); // the none subtree contributed nothing.
  // Only the document fragment exists; neither the div nor its child laid out.
  assert.equal(tree.fragments.size, 1);
  for (const frag of tree.fragments.values()) {
    assert.notEqual(frag.node, nodeId(1));
    assert.notEqual(frag.node, nodeId(2));
  }
});

// ---------------------------------------------------------------------------
// `<div>hello</div>`-shaped tree lays out (Requirement 14.1).
// ---------------------------------------------------------------------------

void test("the `<div>hello</div>` document lays out with text contributing geometry (Req 14.1)", () => {
  // document(0) → div(1) → text "hello"(2). Initial styles (no CSS).
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "text", text: "hello", parent: 1, children: [] },
  ]);
  const tree = layout(dom, styleTable(new Map()));

  assert.equal(tree.fragments.size, 3);
  const root = tree.fragments.get(tree.root)!;
  assert.equal(root.node, nodeId(0));
  const div = tree.fragments.get(root.children[0]!)!;
  assert.equal(div.node, nodeId(1));
  const text = tree.fragments.get(div.children[0]!)!;
  assert.equal(text.node, nodeId(2));

  // The text leaf is one line (font-size 16) tall and has SOME width.
  assert.equal(text.box.height, px(16));
  assert.ok(text.box.width > 0);
  // The div's auto height collapses onto the single line's margin-box height.
  assert.equal(div.box.height, text.box.marginBox.height);
});

void test("empty text contributes a zero-height fragment (still present)", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "text", text: "", parent: 0, children: [] },
  ]);
  const tree = layout(dom, styleTable(new Map()));
  const root = tree.fragments.get(tree.root)!;
  const text = tree.fragments.get(root.children[0]!)!;
  assert.equal(text.box.height, px(0));
});

void test("comment nodes produce no fragment", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1, 2] },
    { id: 1, kind: "comment", text: "x", parent: 0, children: [] },
    { id: 2, kind: "element", tag: "div", parent: 0, children: [] },
  ]);
  const tree = layout(dom, styleTable(new Map([[2, makeStyle({ display: "block", height: 10 })]])));
  const root = tree.fragments.get(tree.root)!;
  assert.equal(root.children.length, 1); // only the div, not the comment.
  assert.equal(tree.fragments.get(root.children[0]!)!.node, nodeId(2));
});

// ---------------------------------------------------------------------------
// Frozen output + determinism (Requirement 2.7 / 3.2).
// ---------------------------------------------------------------------------

void test("the FragmentTree output is deep-frozen (Req 3.2)", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [] },
  ]);
  const tree = layout(dom, styleTable(new Map([[1, makeStyle({ display: "block", height: 10 })]])));

  assert.ok(Object.isFrozen(tree));
  assert.ok(Object.isFrozen(tree.fragments));
  for (const frag of tree.fragments.values()) {
    assert.ok(Object.isFrozen(frag));
    assert.ok(Object.isFrozen(frag.box));
    assert.ok(Object.isFrozen(frag.box.borderBox));
    assert.ok(Object.isFrozen(frag.children));
  }
});

void test("layout is deterministic: same inputs ⇒ structurally equal FragmentTree (Req 2.7)", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "text", text: "hello", parent: 1, children: [] },
  ]);
  const styles = styleTable(new Map([[1, makeStyle({ display: "block" })]]));

  const a = layout(dom, styles);
  const b = layout(dom, styles);

  // Same shape and same geometry on every fragment.
  assert.equal(a.fragments.size, b.fragments.size);
  for (const [id, fragA] of a.fragments) {
    const fragB = b.fragments.get(id);
    assert.ok(fragB !== undefined);
    assert.deepEqual(fragA, fragB);
  }
});

void test("the root containing width is overridable via options (documented default 800)", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [] },
  ]);
  const styles = styleTable(new Map([[1, makeStyle({ display: "block", height: 10 })]]));

  assert.equal(DEFAULT_VIEWPORT_WIDTH, px(800));
  const wide = layout(dom, styles, { viewportWidth: px(1024) });
  const div = wide.fragments.get(wide.fragments.get(wide.root)!.children[0]!)!;
  assert.equal(div.box.width, px(1024)); // auto width fills the overridden viewport.
});

// ---------------------------------------------------------------------------
// Multi-column layout BRANCH (CSS Multi-column).
// ---------------------------------------------------------------------------

void test("multi-column flows block children into N balanced columns", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3, 4, 5] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 4, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 5, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const item = makeStyle({ display: "block", height: 10 });
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 200, extra: { columnCount: 2, columnGap: 0 } })],
      [2, item],
      [3, item],
      [4, item],
      [5, item],
    ]),
  );
  const tree = layout(dom, styles);
  const container = tree.fragments.get(tree.root)!.children
    .map((c) => tree.fragments.get(c)!)
    .find((f) => Number(f.node) === 1)!;
  const kids = container.children.map((c) => tree.fragments.get(c)!);
  assert.equal(kids.length, 4);

  // colWidth = 200 / 2 = 100. ⌈4/2⌉ = 2 children per column.
  const at = (x: number, y: number): boolean =>
    kids.some((k) => Number(k.box.borderBox.x) === x && Number(k.box.borderBox.y) === y);
  assert.ok(at(0, 0) && at(0, 10), "column 0 stacks two items at x=0");
  assert.ok(at(100, 0) && at(100, 10), "column 1 stacks two items at x=100");
  // Each item is laid against the 100px column width.
  assert.equal(Number(kids[0]!.box.borderBox.width), 100);
  // The container's content height is the tallest column (2 × 10px).
  assert.equal(Number(container.box.height), 20);
});

void test("column-width derives the column count from the available width", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      // 300px content, 90px columns, 0 gap ⇒ floor(300/90) = 3 columns.
      [1, makeStyle({ display: "block", width: 300, extra: { columnWidth: px(90), columnGap: 0 } })],
      [2, makeStyle({ display: "block", height: 10 })],
    ]),
  );
  const tree = layout(dom, styles);
  const container = tree.fragments.get(tree.root)!.children
    .map((c) => tree.fragments.get(c)!)
    .find((f) => Number(f.node) === 1)!;
  const kid = tree.fragments.get(container.children[0]!)!;
  assert.equal(Number(kid.box.borderBox.width), 100, "300 / 3 columns = 100px each");
});
