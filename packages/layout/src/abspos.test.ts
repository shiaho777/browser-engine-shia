/**
 * abspos.test.ts — B2 tests: absolutely positioned elements' full resolution
 * (CSS 2.1 §10.3.7 / §10.6.4): static position at the child's document slot,
 * shrink-to-fit width for auto-width boxes, and the pre-existing
 * both-insets/one-inset geometry (pinned as regression).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { deepFreeze, nodeId, px, type ComputedStyle, type DomNode, type DomTree } from "@browser-engine/ir";
import { layout } from "./index.js";

interface TestNode {
  readonly id: number;
  readonly kind: DomNode["kind"];
  readonly tag?: string;
  readonly text?: string;
  readonly parent: number | null;
  readonly children?: readonly number[];
}

function buildDom(specs: readonly TestNode[]): DomTree {
  const nodes = new Map<number, DomNode>();
  for (const s of specs) {
    nodes.set(s.id, {
      id: nodeId(s.id),
      kind: s.kind,
      ...(s.tag !== undefined ? { tag: s.tag } : {}),
      ...(s.text !== undefined ? { text: s.text } : {}),
      ...(s.kind === "element" ? { attrs: new Map<string, string>() } : {}),
      children: (s.children ?? []).map((c) => nodeId(c)),
      parent: s.parent === null ? null : nodeId(s.parent),
    });
  }
  const root = specs.find((s) => s.parent === null)?.id ?? 0;
  return { root: nodeId(root), nodes } as unknown as DomTree;
}

const ZERO_EDGES = { top: px(0), right: px(0), bottom: px(0), left: px(0) };

function makeStyle(spec: Record<string, unknown> = {}): ComputedStyle {
  return deepFreeze({
    display: spec["display"] ?? "inline",
    color: { r: 0, g: 0, b: 0, a: 1 },
    fontSize: px(16),
    margin: ZERO_EDGES,
    width: spec["width"] ?? "auto",
    height: spec["height"] ?? "auto",
    backgroundColor: { r: 0, g: 0, b: 0, a: 0 },
    ...spec,
  }) as unknown as ComputedStyle;
}

function styleTable(map: ReadonlyMap<number, ComputedStyle>): (node: ReturnType<typeof nodeId>) => ComputedStyle {
  const fallback = makeStyle();
  return (node) => map.get(Number(node)) ?? fallback;
}

const fragOf = (tree: ReturnType<typeof layout>, id: number) => {
  const frag = [...tree.fragments.values()].find((f) => f.node === nodeId(id));
  assert.ok(frag !== undefined, `fragment for node ${id}`);
  return frag;
};

// ---------------------------------------------------------------------------
// Static position: the child's DOCUMENT position, not the flow's end.
// ---------------------------------------------------------------------------

void test("an inset-less abspos child renders at its static (document) position", () => {
  // container(1) → block(2, h=50), abs(3), block(4, h=30).
  // The abspos child's static position is BETWEEN the two blocks (y=50),
  // not at the flow's end (y=80 — the pre-B2 bug).
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3, 4] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 4, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = new Map<number, ComputedStyle>([
    [1, makeStyle({ display: "block", width: 300 })],
    [2, makeStyle({ display: "block", height: 50 })],
    [3, makeStyle({ display: "block", position: "absolute" })],
    [4, makeStyle({ display: "block", height: 30 })],
  ]);
  const tree = layout(dom, styleTable(styles));
  const abs = fragOf(tree, 3);
  assert.equal(Number(abs.box.borderBox.y), 50, "static top = between the blocks");
});

// ---------------------------------------------------------------------------
// Shrink-to-fit: auto-width abspos boxes size to content (§10.3.7).
// ---------------------------------------------------------------------------

void test("a left-anchored auto-width abspos box shrinks to its content width", () => {
  // The abspos child contains ONE text run of 5 chars at font 16 (advance
  // ratio 0.5 ⇒ 5×8 = 40px). With only `left` set, its used width is
  // min(available, max-content) = 40px, NOT the full 300px container.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [4] },
    { id: 4, kind: "text", text: "hello", parent: 3 },
  ]);
  const styles = new Map<number, ComputedStyle>([
    [1, makeStyle({ display: "block", width: 300 })],
    [2, makeStyle({ display: "block", height: 20 })],
    [3, makeStyle({ display: "block", position: "absolute", left: 10 })],
  ]);
  const tree = layout(dom, styleTable(styles));
  const abs = fragOf(tree, 3);
  // 5 glyphs × 0.5 × 16 = 40px content width.
  assert.equal(Number(abs.box.width), 40, "shrink-to-fit = the text's natural width");
  assert.equal(Number(abs.box.borderBox.x), 10, "anchored at left: 10");
});

void test("a static-position abspos box also shrinks to fit", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [3] },
    { id: 3, kind: "text", text: "hi", parent: 2 },
  ]);
  const styles = new Map<number, ComputedStyle>([
    [1, makeStyle({ display: "block", width: 300 })],
    [2, makeStyle({ display: "block", position: "absolute" })],
  ]);
  const tree = layout(dom, styleTable(styles));
  const abs = fragOf(tree, 2);
  assert.equal(Number(abs.box.width), 16, "2 glyphs × 0.5 × 16 = 16px");
});

void test("a declared width wins over shrink-to-fit", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [3] },
    { id: 3, kind: "text", text: "hi", parent: 2 },
  ]);
  const styles = new Map<number, ComputedStyle>([
    [1, makeStyle({ display: "block", width: 300 })],
    [2, makeStyle({ display: "block", position: "absolute", left: 0, width: 120 })],
  ]);
  const tree = layout(dom, styleTable(styles));
  assert.equal(Number(fragOf(tree, 2).box.width), 120);
});

void test("both insets solve the width (existing behavior, pinned)", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = new Map<number, ComputedStyle>([
    [1, makeStyle({ display: "block", width: 300 })],
    [2, makeStyle({ display: "block", position: "absolute", left: 20, right: 30 })],
  ]);
  const tree = layout(dom, styleTable(styles));
  const abs = fragOf(tree, 2);
  assert.equal(Number(abs.box.width), 250, "300 - 20 - 30");
  assert.equal(Number(abs.box.borderBox.x), 20);
});

void test("right-anchored box solves its position from the shrink-to-fit width", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [3] },
    { id: 3, kind: "text", text: "hello", parent: 2 },
  ]);
  const styles = new Map<number, ComputedStyle>([
    [1, makeStyle({ display: "block", width: 300 })],
    [2, makeStyle({ display: "block", position: "absolute", right: 40 })],
  ]);
  const tree = layout(dom, styleTable(styles));
  const abs = fragOf(tree, 2);
  // Shrink-to-fit width = 40 ("hello"); right: 40 ⇒ x = 300 - 40 - 40 = 220.
  assert.equal(Number(abs.box.width), 40);
  assert.equal(Number(abs.box.borderBox.x), 220, "right edge honored from the shrunken width");
});

// ---------------------------------------------------------------------------
// The max-content estimate composes: block children stack (max), inline sum.
// ---------------------------------------------------------------------------

void test("shrink-to-fit takes the WIDEST block child", () => {
  // abs(2) → block(3, text "hello" = 40px), block(4, text "hi" = 16px)
  // → max-content = 40px.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [3, 4] },
    { id: 3, kind: "element", tag: "div", parent: 2, children: [5] },
    { id: 4, kind: "element", tag: "div", parent: 2, children: [6] },
    { id: 5, kind: "text", text: "hello", parent: 3 },
    { id: 6, kind: "text", text: "hi", parent: 4 },
  ]);
  const styles = new Map<number, ComputedStyle>([
    [1, makeStyle({ display: "block", width: 300 })],
    [2, makeStyle({ display: "block", position: "absolute" })],
    [3, makeStyle({ display: "block" })],
    [4, makeStyle({ display: "block" })],
  ]);
  const tree = layout(dom, styleTable(styles));
  assert.equal(Number(fragOf(tree, 2).box.width), 40, "the wider child's 40px");
});

void test("an inline-block child's content sums into the estimate", () => {
  // abs(2) → inline-block(3) containing "hello" (40px) + margin 4px.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [3] },
    { id: 3, kind: "element", tag: "span", parent: 2, children: [4] },
    { id: 4, kind: "text", text: "hello", parent: 3 },
  ]);
  const styles = new Map<number, ComputedStyle>([
    [1, makeStyle({ display: "block", width: 300 })],
    [2, makeStyle({ display: "block", position: "absolute" })],
    [3, makeStyle({ display: "inline-block", margin: { top: px(0), right: px(4), bottom: px(0), left: px(4) } })],
  ]);
  const tree = layout(dom, styleTable(styles));
  // 40px text + 8px of horizontal margins.
  assert.equal(Number(fragOf(tree, 2).box.width), 48);
});
