/**
 * Unit tests for `getBoundingClientRect` (task 3.8; design.md §8.4;
 * Requirement 3.4).
 *
 * The point of these tests is the architectural guarantee, not just the numbers:
 * the returned rectangle comes from the {@link FragmentTree}'s `borderBox` and
 * NOWHERE else (root-cause fix for v0 bug#2). They build a frozen DomTree +
 * ComputedStyle table by hand, run the real `layout`, then assert that
 * `getBoundingClientRect` returns precisely the laid-out fragment's
 * `box.borderBox`.
 *
 * Built by `tsc` then run with: `node --test packages/layout/dist/*.test.js`.
 *
 * Layout lives inside a *stage* package, so (per `local/no-cross-stage-import`)
 * it may import ONLY the frozen IR (`@browser-engine/ir`) and the package under
 * test — never html-parser / cascade. The inputs are therefore built here as
 * frozen IR values.
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

import { getBoundingClientRect, layout } from "./index.js";

// ---------------------------------------------------------------------------
// IR builders — assemble a frozen DomTree and a ComputedStyle table by hand.
// (Mirrors index.test.ts; kept local so this file is self-contained.)
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

interface StyleSpec {
  readonly display?: DisplayValue;
  readonly width?: number | "auto";
  readonly height?: number | "auto";
  readonly margin?: Edges<Px>;
  readonly fontSize?: number;
}

/** Build a frozen, geometry-free ComputedStyle from a partial spec. */
function makeStyle(spec: StyleSpec = {}): ComputedStyle {
  const style = {
    display: spec.display ?? "inline",
    color: BLACK,
    fontSize: px(spec.fontSize ?? 16),
    margin: spec.margin ?? ZERO_EDGES,
    width: spec.width ?? "auto",
    height: spec.height ?? "auto",
    backgroundColor: TRANSPARENT,
  };
  return deepFreeze(style as unknown as ComputedStyle);
}

/** Make a `computedStyleOf` callback from a per-node style map (default: initial). */
function styleTable(map: ReadonlyMap<number, ComputedStyle>): (node: NodeId) => ComputedStyle {
  const fallback = makeStyle();
  return (node: NodeId) => map.get(node) ?? fallback;
}

/** Find the fragment whose back-reference is `node` (or undefined). */
function fragmentOf(tree: ReturnType<typeof layout>, node: NodeId) {
  for (const frag of tree.fragments.values()) {
    if (frag.node === node) return frag;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// A laid-out node returns its borderBox — and EXACTLY its borderBox (Req 3.4).
// ---------------------------------------------------------------------------

void test("a laid-out node's rect is exactly its fragment's box.borderBox (Req 3.4)", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [] },
  ]);
  const styles = styleTable(new Map([[1, makeStyle({ display: "block", width: 120, height: 50 })]]));
  const tree = layout(dom, styles);

  const rect = getBoundingClientRect(tree, nodeId(1));
  const frag = fragmentOf(tree, nodeId(1));
  assert.ok(frag !== undefined);

  // The SOLE legal source: the returned rect IS the fragment's borderBox.
  assert.deepEqual(rect, frag.box.borderBox);
  // And it reflects the laid-out geometry (declared 120×50).
  assert.equal(rect.width, px(120));
  assert.equal(rect.height, px(50));
});

void test("the returned rect is the borderBox, not the margin/content box", () => {
  // A box with non-zero margins makes borderBox ≠ marginBox, so we can prove
  // which box is returned.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [] },
  ]);
  const margin: Edges<Px> = { top: px(8), right: px(12), bottom: px(4), left: px(10) };
  const styles = styleTable(new Map([[1, makeStyle({ display: "block", height: 40, margin })]]));
  const tree = layout(dom, styles);

  const rect = getBoundingClientRect(tree, nodeId(1));
  const frag = fragmentOf(tree, nodeId(1))!;

  assert.deepEqual(rect, frag.box.borderBox);
  // borderBox is inset from the margin-box origin by the top/left margins, so
  // it differs from both the margin box and (in width) reflects the auto fill.
  assert.equal(rect.x, px(10));
  assert.equal(rect.y, px(8));
  assert.notDeepEqual(rect, frag.box.marginBox);
});

// ---------------------------------------------------------------------------
// A nested node returns the correct rect (its own fragment's borderBox).
// ---------------------------------------------------------------------------

void test("a nested node returns its own fragment's borderBox, not its parent's", () => {
  // document(0) → div(1) → div(2). Child stacked below... here it's the only
  // child, but it has its own declared size distinct from the parent.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 300 })],
      [2, makeStyle({ display: "block", width: 80, height: 25 })],
    ]),
  );
  const tree = layout(dom, styles);

  const childRect = getBoundingClientRect(tree, nodeId(2));
  const parentRect = getBoundingClientRect(tree, nodeId(1));
  const childFrag = fragmentOf(tree, nodeId(2))!;
  const parentFrag = fragmentOf(tree, nodeId(1))!;

  assert.deepEqual(childRect, childFrag.box.borderBox);
  assert.deepEqual(parentRect, parentFrag.box.borderBox);
  // The child's rect reflects ITS geometry (80×25), distinct from the parent.
  assert.equal(childRect.width, px(80));
  assert.equal(childRect.height, px(25));
  assert.notEqual(childRect.width, parentRect.width);
});

void test("a stacked sibling returns the borderBox at its block-flow offset", () => {
  // document(0) → div(1) → [a(2) h=10, b(3) h=20]; b is offset to y=10.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block" })],
      [2, makeStyle({ display: "block", height: 10 })],
      [3, makeStyle({ display: "block", height: 20 })],
    ]),
  );
  const tree = layout(dom, styles);

  const rectB = getBoundingClientRect(tree, nodeId(3));
  const fragB = fragmentOf(tree, nodeId(3))!;
  assert.deepEqual(rectB, fragB.box.borderBox);
  // Second sibling sits below the first (height 10), so its borderBox y is 10.
  assert.equal(rectB.y, px(10));
  assert.equal(rectB.height, px(20));
});

// ---------------------------------------------------------------------------
// A display:none / absent node returns the documented zero rect.
// ---------------------------------------------------------------------------

void test("a display:none node returns a zero rect (web-platform behavior)", () => {
  // div(1) is display:none → no fragment for it or its child(2).
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "span", parent: 1, children: [] },
  ]);
  const styles = styleTable(new Map([[1, makeStyle({ display: "none" })]]));
  const tree = layout(dom, styles);

  // Sanity: the none subtree produced no fragment.
  assert.equal(fragmentOf(tree, nodeId(1)), undefined);

  const rect = getBoundingClientRect(tree, nodeId(1));
  assert.deepEqual(rect, { x: px(0), y: px(0), width: px(0), height: px(0) });
});

void test("a node id with no fragment at all returns a zero rect", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [] },
  ]);
  const tree = layout(dom, styleTable(new Map([[1, makeStyle({ display: "block", height: 10 })]])));

  // Node 999 was never in the document, so it has no fragment.
  const rect = getBoundingClientRect(tree, nodeId(999));
  assert.deepEqual(rect, { x: px(0), y: px(0), width: px(0), height: px(0) });
});

// ---------------------------------------------------------------------------
// Property-3-shaped sanity check (the full property is task 3.9): for EVERY
// laid-out node, gBCR equals that fragment's borderBox.
// ---------------------------------------------------------------------------

void test("for every laid-out fragment, gBCR(node) === fragment.box.borderBox", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "text", text: "hello", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block" })],
      [2, makeStyle({ display: "block", height: 12 })],
    ]),
  );
  const tree = layout(dom, styles);

  for (const frag of tree.fragments.values()) {
    const rect = getBoundingClientRect(tree, frag.node);
    assert.deepEqual(rect, frag.box.borderBox);
  }
});
