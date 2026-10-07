/**
 * table-auto.test.ts — B6 tests: automatic table layout's column sizing
 * (css-tables-3 §7.2, simplified): columns measure their widest cell's
 * max-content, surplus grows the table to its width, deficit shrinks
 * proportionally with a floor.
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

/** table(1) → tr(2) → cells; texts per cell given as strings. */
function oneRowTable(cellTexts: readonly string[]): { dom: DomTree; styles: Map<number, ComputedStyle> } {
  const specs: TestNode[] = [
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "table", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "tr", parent: 1, children: [] },
  ];
  const styles = new Map<number, ComputedStyle>([
    [1, makeStyle({ display: "table", width: 300 })],
    [2, makeStyle({ display: "table-row" })],
  ]);
  let next = 3;
  for (const text of cellTexts) {
    const cellId = next++;
    const textId = next++;
    specs.push({ id: cellId, kind: "element", tag: "td", parent: 2, children: [textId] });
    specs.push({ id: textId, kind: "text", text, parent: cellId });
    styles.set(cellId, makeStyle({ display: "table-cell" }));
  }
  specs[2] = { ...specs[2]!, children: specs.filter((s) => s.tag === "td").map((s) => s.id) };
  return { dom: buildDom(specs), styles };
}

const fragOf = (tree: ReturnType<typeof layout>, id: number) => {
  const frag = [...tree.fragments.values()].find((f) => f.node === nodeId(id));
  assert.ok(frag !== undefined, `fragment for node ${id}`);
  return frag;
};

const cellWidths = (tree: ReturnType<typeof layout>, dom: DomTree): number[] => {
  const tr = [...dom.nodes.values()].find((n) => n.tag === "tr")!;
  const rowFrag = fragOf(tree, tr.id);
  return rowFrag.children.map((cid) => Number(tree.fragments.get(cid)!.box.width));
};

// The metrics shaper advances 0.5 × fontSize per glyph: at font 16, one char
// is 8px, so "hello" = 40px and "hi" = 16px.

void test("columns size to their content, not equally", () => {
  const { dom, styles } = oneRowTable(["hello", "hi"]);
  const tree = layout(dom, styleTable(styles));
  const widths = cellWidths(tree, dom);
  // Preferred: 40 and 16; surplus 244 grows evenly (+122 each).
  assert.ok(widths[0]! > widths[1]!, `the wider content column is wider: ${widths.join(",")}`);
  assert.ok(Math.abs(widths[0]! - (40 + 122)) < 1, `column 0 ≈ 162: ${widths[0]}`);
  assert.ok(Math.abs(widths[1]! - (16 + 122)) < 1, `column 1 ≈ 138: ${widths[1]}`);
  assert.ok(Math.abs(widths[0]! + widths[1]! - 300) < 2, "the table spans its width");
});

void test("equal contents produce equal columns (regression)", () => {
  const { dom, styles } = oneRowTable(["ab", "cd"]);
  const tree = layout(dom, styleTable(styles));
  const widths = cellWidths(tree, dom);
  assert.equal(widths.length, 2);
  assert.ok(Math.abs(widths[0]! - widths[1]!) < 1, `equal columns: ${widths.join(",")}`);
});

void test("a deficit shrinks wide columns proportionally", () => {
  // Two very wide cells in a 100px table: preferred (8×30=240, 8×20=160)
  // total 400 → shrink proportionally: 60 and 40 (floors don't bind).
  const { dom, styles } = oneRowTable([ "a".repeat(30), "b".repeat(20) ]);
  styles.set(1, makeStyle({ display: "table", width: 100 }));
  const tree = layout(dom, styleTable(styles));
  const widths = cellWidths(tree, dom);
  assert.ok(Math.abs(widths[0]! - 60) < 2, `column 0 shrunk to 60: ${widths[0]}`);
  assert.ok(Math.abs(widths[1]! - 40) < 2, `column 1 shrunk to 40: ${widths[1]}`);
});

void test("a column never shrinks below the min-content floor", () => {
  // One gigantic cell (1000px preferred) + one tiny cell in a 100px table:
  // the giant clamps to 100 − floor(tiny) = 100 − 16.
  const { dom, styles } = oneRowTable(["x".repeat(125), "y"]);
  styles.set(1, makeStyle({ display: "table", width: 100 }));
  const tree = layout(dom, styleTable(styles));
  const widths = cellWidths(tree, dom);
  assert.ok(widths[0]! <= 84 + 2, `the giant column leaves the floor to the small one: ${widths.join(",")}`);
  assert.ok(widths[1]! >= 16 - 1, `the tiny column keeps its floor: ${widths[1]}`);
});

void test("a declared cell width fixes that cell; its column follows", () => {
  // Cell 0 declares width: 120 — the CELL stays 120 wide regardless of the
  // column; the surplus column space flows to the auto cell (CSS: a cell's
  // declared width is honored; the column takes the widest cell).
  const { dom, styles } = oneRowTable(["hi", "there!"]);
  const cells = [...dom.nodes.values()].filter((n) => n.tag === "td");
  styles.set(Number(cells[0]!.id), makeStyle({ display: "table-cell", width: 120 }));
  const tree = layout(dom, styleTable(styles));
  const widths = cellWidths(tree, dom);
  assert.equal(widths[0], 120, "the declared cell keeps exactly 120px");
  assert.ok(Math.abs(widths[1]! - 114) < 2, `the auto cell takes the rest: ${widths[1]}`);
  const table = fragOf(tree, 1);
  assert.equal(Number(table.box.width), 300, "the table still spans its width");
});

void test("bare text in a table measures into its anonymous column", () => {
  // <table>hello</table> — the anonymous cell's content is "hello" = 40px.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "table", parent: 0, children: [2] },
    { id: 2, kind: "text", text: "hello", parent: 1 },
  ]);
  const styles = new Map<number, ComputedStyle>([
    [1, makeStyle({ display: "table", width: 300 })],
  ]);
  const tree = layout(dom, styleTable(styles));
  // One anonymous column spans the full 300 (surplus grows it).
  const table = fragOf(tree, 1);
  assert.equal(Number(table.box.width), 300);
  const text = [...tree.fragments.values()].find((f) => f.text !== undefined)!;
  assert.ok(Number(text.box.width) <= 300, "the text fits its column");
});
