/**
 * grid-tracks.test.ts — B7 tests: content-aware track sizing (css-grid-1 §12,
 * simplified): `auto` tracks size to their column's content, `minmax()` floors
 * and caps, `%` tracks resolve against the budget, and `fr` shares the
 * leftover after fixed/auto tracks.
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

/** grid(1) with N children divs; each child gets the given style overrides. */
function gridDoc(template: string, childTexts: readonly string[]): { dom: DomTree; styles: Map<number, ComputedStyle> } {
  const specs: TestNode[] = [
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [] },
  ];
  const styles = new Map<number, ComputedStyle>([
    [1, makeStyle({ display: "grid", width: 300, gridTemplateColumns: template })],
  ]);
  const gridChildren: number[] = [];
  let next = 2;
  for (const text of childTexts) {
    const childId = next++;
    const textId = next++;
    specs.push({ id: childId, kind: "element", tag: "div", parent: 1, children: [textId] });
    specs.push({ id: textId, kind: "text", text, parent: childId });
    styles.set(childId, makeStyle({ display: "block" }));
    gridChildren.push(childId);
  }
  specs[1] = { ...specs[1]!, children: gridChildren };
  return { dom: buildDom(specs), styles };
}

const fragOf = (tree: ReturnType<typeof layout>, id: number) => {
  const frag = [...tree.fragments.values()].find((f) => f.node === nodeId(id));
  assert.ok(frag !== undefined, `fragment for node ${id}`);
  return frag;
};

// The metrics shaper advances 0.5 × fontSize per glyph at font 16: one char = 8px.

void test("auto tracks size to their column's content", () => {
  // "hello" = 40px in column 0; "hi" = 16px in column 1; the fr gets 300−56 = 244.
  const { dom, styles } = gridDoc("auto auto 1fr", ["hello", "hi", "x"]);
  const tree = layout(dom, styleTable(styles));
  const c0 = fragOf(tree, 2);
  const c1 = fragOf(tree, 4);
  const c2 = fragOf(tree, 6);
  assert.ok(Math.abs(Number(c0.box.width) - 40) < 1, `col 0 = content 40: ${Number(c0.box.width)}`);
  assert.ok(Math.abs(Number(c1.box.width) - 16) < 1, `col 1 = content 16: ${Number(c1.box.width)}`);
  assert.ok(Math.abs(Number(c2.box.width) - 244) < 1, `fr = leftover 244: ${Number(c2.box.width)}`);
});

void test("minmax(px, px) clamps the content size", () => {
  // Content 40px clamped into [80, 200] ⇒ 80 (the floor binds).
  const { dom, styles } = gridDoc("minmax(80px, 200px) 1fr", ["hello"]);
  const tree = layout(dom, styleTable(styles));
  const c0 = fragOf(tree, 2);
  assert.ok(Math.abs(Number(c0.box.width) - 80) < 1, `minmax floor: ${Number(c0.box.width)}`);
});

void test("minmax(auto, Xpx) caps the content size at X", () => {
  // Content 40px, capped at 24px ⇒ 24.
  const { dom, styles } = gridDoc("minmax(auto, 24px) 1fr", ["hello"]);
  const tree = layout(dom, styleTable(styles));
  const c0 = fragOf(tree, 2);
  assert.ok(Math.abs(Number(c0.box.width) - 24) < 1, `minmax cap: ${Number(c0.box.width)}`);
});

void test("minmax(100px, 1fr): the fr shares the leftover, floored at 100px", () => {
  const { dom, styles } = gridDoc("minmax(100px, 1fr) minmax(100px, 1fr)", ["a", "b"]);
  const tree = layout(dom, styleTable(styles));
  const c0 = fragOf(tree, 2);
  const c1 = fragOf(tree, 4);
  assert.ok(Math.abs(Number(c0.box.width) - 150) < 1, `each minmax-fr gets half: ${Number(c0.box.width)}`);
  assert.ok(Math.abs(Number(c1.box.width) - 150) < 1);
});

void test("percentage tracks resolve against the budget", () => {
  // 30% of 300 = 90; the fr takes the rest = 210.
  const { dom, styles } = gridDoc("30% 1fr", ["a", "b"]);
  const tree = layout(dom, styleTable(styles));
  const c0 = fragOf(tree, 2);
  const c1 = fragOf(tree, 4);
  assert.ok(Math.abs(Number(c0.box.width) - 90) < 1, `pct track: ${Number(c0.box.width)}`);
  assert.ok(Math.abs(Number(c1.box.width) - 210) < 1, `fr gets the rest: ${Number(c1.box.width)}`);
});

void test("mixed fixed + auto + fr: fixed first, auto from content, fr the leftover", () => {
  // fixed 50 + auto 40 (content) + fr → 300 − 90 = 210.
  const { dom, styles } = gridDoc("50px auto 1fr", ["x", "hello", "y"]);
  const tree = layout(dom, styleTable(styles));
  const c1 = fragOf(tree, 4); // "hello" is in column 1.
  const c2 = fragOf(tree, 6);
  assert.ok(Math.abs(Number(c1.box.width) - 40) < 1, `auto column: ${Number(c1.box.width)}`);
  assert.ok(Math.abs(Number(c2.box.width) - 210) < 1, `fr leftover: ${Number(c2.box.width)}`);
});

void test("an fr floor exceeding its share takes from the flexible frs", () => {
  // minmax(200px, 1fr) + 1fr in 300px: the floored track takes 200, the
  // flexible fr gets the remaining 100 (not 150 each).
  const { dom, styles } = gridDoc("minmax(200px, 1fr) 1fr", ["a", "b"]);
  const tree = layout(dom, styleTable(styles));
  const c0 = fragOf(tree, 2);
  const c1 = fragOf(tree, 4);
  assert.ok(Math.abs(Number(c0.box.width) - 200) < 1, `floored fr keeps 200: ${Number(c0.box.width)}`);
  assert.ok(Math.abs(Number(c1.box.width) - 100) < 1, `flexible fr gets the rest: ${Number(c1.box.width)}`);
});

void test("equal frs still split evenly (regression)", () => {
  const { dom, styles } = gridDoc("1fr 2fr", ["a", "b"]);
  const tree = layout(dom, styleTable(styles));
  const c0 = fragOf(tree, 2);
  const c1 = fragOf(tree, 4);
  assert.ok(Math.abs(Number(c0.box.width) - 100) < 1, `1fr: ${Number(c0.box.width)}`);
  assert.ok(Math.abs(Number(c1.box.width) - 200) < 1, `2fr: ${Number(c1.box.width)}`);
});
