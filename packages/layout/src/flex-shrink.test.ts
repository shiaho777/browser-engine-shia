/**
 * flex-shrink.test.ts — B8 tests: the flex SHRINK pass (CSS Flexbox §9.7
 * resolve-flexible-lengths, simplified): when fixed items overflow the main
 * axis, each gives up space proportional to shrink × basis, floored at a
 * min-content approximation; `flex-shrink: 0` opts an item out.
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

/** flex(1) with N fixed-width item divs (each carrying text). */
function flexDoc(itemSpecs: readonly { width: number; shrink?: number; text?: string }[]): {
  dom: DomTree;
  styles: Map<number, ComputedStyle>;
} {
  const specs: TestNode[] = [
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [] },
  ];
  const styles = new Map<number, ComputedStyle>([
    [1, makeStyle({ display: "flex", width: 300 })],
  ]);
  const childIds: number[] = [];
  let next = 2;
  for (const item of itemSpecs) {
    const childId = next++;
    const textId = next++;
    specs.push({ id: childId, kind: "element", tag: "div", parent: 1, children: [textId] });
    specs.push({ id: textId, kind: "text", text: item.text ?? "x".repeat(Math.ceil(item.width / 8)), parent: childId });
    styles.set(childId, makeStyle({
      display: "block",
      width: item.width,
      ...(item.shrink !== undefined ? { flexShrink: item.shrink } : {}),
    }));
    childIds.push(childId);
  }
  specs[1] = { ...specs[1]!, children: childIds };
  return { dom: buildDom(specs), styles };
}

const fragOf = (tree: ReturnType<typeof layout>, id: number) => {
  const frag = [...tree.fragments.values()].find((f) => f.node === nodeId(id));
  assert.ok(frag !== undefined, `fragment for node ${id}`);
  return frag;
};

void test("overflowing fixed items shrink proportionally to shrink × basis", () => {
  // Two items of 200px and 100px in a 300px container (total 300 — no
  // overflow). Three items: 200 + 150 + 100 = 450 in 300 → deficit 150.
  // Weights (shrink 1): 200 + 150 + 100 = 450 → give 150×(w/450).
  //   item1: 200 − 66.7 = 133.3; item2: 150 − 50 = 100; item3: 100 − 33.3 = 66.7.
  const { dom, styles } = flexDoc([{ width: 200 }, { width: 150 }, { width: 100 }]);
  const tree = layout(dom, styleTable(styles));
  const w1 = Number(fragOf(tree, 2).box.width);
  const w2 = Number(fragOf(tree, 4).box.width);
  const w3 = Number(fragOf(tree, 6).box.width);
  assert.ok(Math.abs(w1 - 133.33) < 1, `item 1 shrunk: ${w1}`);
  assert.ok(Math.abs(w2 - 100) < 1, `item 2 shrunk: ${w2}`);
  assert.ok(Math.abs(w3 - 66.67) < 1, `item 3 shrunk: ${w3}`);
});

void test("flex-shrink: 0 keeps an item at its declared width", () => {
  // Two 200px items in 300px; item 2 has shrink 0 → item 1 absorbs all deficit
  // (down to its floor): item1 ≈ max(100, 300−200) = 100, item2 = 200.
  const { dom, styles } = flexDoc([{ width: 200 }, { width: 200, shrink: 0 }]);
  const tree = layout(dom, styleTable(styles));
  const w1 = Number(fragOf(tree, 2).box.width);
  const w2 = Number(fragOf(tree, 4).box.width);
  assert.ok(Math.abs(w2 - 200) < 1, `the shrink-0 item keeps 200: ${w2}`);
  assert.ok(Math.abs(w1 - 100) < 1, `the shrinker gives up everything to the floor: ${w1}`);
});

void test("a higher shrink factor gives up more space", () => {
  // Two 200px items in 300px: item 1 shrink 3, item 2 shrink 1 → weights
  // 600 vs 200 → item 1 gives 75 deficit × 3/4, item 2 × 1/4.
  const { dom, styles } = flexDoc([{ width: 200, shrink: 3 }, { width: 200, shrink: 1 }]);
  const tree = layout(dom, styleTable(styles));
  const w1 = Number(fragOf(tree, 2).box.width);
  const w2 = Number(fragOf(tree, 4).box.width);
  assert.ok(w1 < w2, `the higher-shrink item shrinks more: ${w1} < ${w2}`);
  assert.ok(Math.abs(w1 + w2 - 300) < 2, `they still fill the container: ${w1 + w2}`);
});

void test("no overflow means no shrink (regression)", () => {
  // 100 + 150 = 250 in 300 → no deficit, no shrink.
  const { dom, styles } = flexDoc([{ width: 100 }, { width: 150 }]);
  const tree = layout(dom, styleTable(styles));
  assert.equal(Number(fragOf(tree, 2).box.width), 100);
  assert.equal(Number(fragOf(tree, 4).box.width), 150);
});

void test("the min-content floor keeps text visible", () => {
  // A 200px item with 10px of text in a 10px container: it shrinks toward
  // its floor (25% of 200 = 50), never to 0.
  const { dom, styles } = flexDoc([{ width: 200, text: "ab" }]);
  styles.set(1, makeStyle({ display: "flex", width: 10 }));
  const tree = layout(dom, styleTable(styles));
  const w = Number(fragOf(tree, 2).box.width);
  assert.ok(w >= 50 - 1, `the item keeps its min-content floor: ${w}`);
});
