/**
 * floats.test.ts — B3 tests: float band placement (CSS 2.1 §9.5) —
 * same-side floats sit SIDE BY SIDE (not overlapping), a too-wide float drops
 * to the next band edge, and inline runs flow in the NARROWED span beside
 * active floats (§9.5: line boxes shrink around floats).
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

void test("two left floats sit side by side, not overlapping", () => {
  // container(1) → floatA(2, 100×60), floatB(3, 100×50). Both fit on one row
  // (200 ≤ 300): floatB's left edge = 100 (beside floatA), same band top = 0.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = new Map<number, ComputedStyle>([
    [1, makeStyle({ display: "block", width: 300 })],
    [2, makeStyle({ display: "block", float: "left", width: 100, height: 60 })],
    [3, makeStyle({ display: "block", float: "left", width: 100, height: 50 })],
  ]);
  const tree = layout(dom, styleTable(styles));
  const a = fragOf(tree, 2);
  const b = fragOf(tree, 3);
  assert.equal(Number(a.box.borderBox.x), 0, "floatA at the left edge");
  assert.equal(Number(b.box.borderBox.x), 100, "floatB BESIDE floatA (not overlapping)");
  assert.equal(Number(b.box.borderBox.y), 0, "same band top");
});

void test("a too-wide second float drops to the next band edge", () => {
  // floatA(2, 200×40), floatB(3, 200×30) in a 300px container: they cannot
  // share a row (400 > 300) — floatB drops BELOW floatA's bottom (y = 40).
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = new Map<number, ComputedStyle>([
    [1, makeStyle({ display: "block", width: 300 })],
    [2, makeStyle({ display: "block", float: "left", width: 200, height: 40 })],
    [3, makeStyle({ display: "block", float: "left", width: 200, height: 30 })],
  ]);
  const tree = layout(dom, styleTable(styles));
  const b = fragOf(tree, 3);
  assert.equal(Number(b.box.borderBox.y), 40, "below the blocking float's bottom");
  assert.equal(Number(b.box.borderBox.x), 0, "back at the left edge of the new band");
});

void test("left and right floats narrow the middle for in-flow blocks", () => {
  // floatL(2, 100×50), floatR(3, 100×50), in-flow block(4, h=20):
  // the block gets 300 − 100 − 100 = 100px and shifts to x = 100.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3, 4] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 4, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = new Map<number, ComputedStyle>([
    [1, makeStyle({ display: "block", width: 300 })],
    [2, makeStyle({ display: "block", float: "left", width: 100, height: 50 })],
    [3, makeStyle({ display: "block", float: "right", width: 100, height: 50 })],
    [4, makeStyle({ display: "block", height: 20 })],
  ]);
  const tree = layout(dom, styleTable(styles));
  const block = fragOf(tree, 4);
  assert.equal(Number(block.box.width), 100, "narrowed between the floats");
  assert.equal(Number(block.box.borderBox.x), 100, "shifted past the left float");
});

void test("an inline run flows in the span beside a left float", () => {
  // floatL(2, 100×50) then a text run: the run's line box is 200px wide and
  // starts at x = 100 (BESIDE the float, not under it).
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "text", text: "hello world", parent: 1 },
  ]);
  const styles = new Map<number, ComputedStyle>([
    [1, makeStyle({ display: "block", width: 300 })],
    [2, makeStyle({ display: "block", float: "left", width: 100, height: 50 })],
  ]);
  const tree = layout(dom, styleTable(styles));
  const text = fragOf(tree, 3);
  assert.equal(Number(text.box.borderBox.x), 100, "the line starts beside the float");
  // The full run is "hello world" = 11 glyphs × 0.5 × 16 = 88px ≤ 200: ONE line.
  assert.ok(Number(text.box.width) <= 200, "the line box is the narrowed span");
});

void test("an inline run beside a right float shifts by the left gap only", () => {
  // floatR(2, 100×50) then text: the span is [0, 200]; text starts at x = 0.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "text", text: "hi", parent: 1 },
  ]);
  const styles = new Map<number, ComputedStyle>([
    [1, makeStyle({ display: "block", width: 300 })],
    [2, makeStyle({ display: "block", float: "right", width: 100, height: 50 })],
  ]);
  const tree = layout(dom, styleTable(styles));
  const text = fragOf(tree, 3);
  assert.equal(Number(text.box.borderBox.x), 0, "no left intrusion");
  assert.ok(Number(text.box.width) <= 200, "the line box is narrowed by the right float");
});
