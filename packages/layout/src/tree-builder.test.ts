/**
 * tree-builder.test.ts — B1 tests: the layout tree builder's anonymous-block
 * wrapping (css2.1 §9.2.1.1), whitespace-run dropping, and css-tables-3 fixup.
 *
 * These pin the INVARIANTS the layout algorithms now rely on: every block
 * container's children come pre-classified, bare text in tables is wrapped
 * (never dropped), and naked rows/cells get an anonymous table.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { deepFreeze, nodeId, px, type ComputedStyle, type DomNode, type DomTree } from "@browser-engine/ir";

import { buildLayoutTree } from "./tree-builder.js";
import { layout } from "./index.js";

// ---------------------------------------------------------------------------
// Test helpers (mirror index.test.ts's buildDom/makeStyle/styleTable shapes).
// ---------------------------------------------------------------------------

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

const styleOf = (styles: ReadonlyMap<number, Record<string, unknown>>) =>
  ((id: ReturnType<typeof nodeId>) =>
    makeStyle(styles.get(Number(id)) ?? {})) as never;

// ---------------------------------------------------------------------------
// Block fixup: inline-run grouping + whitespace dropping.
// ---------------------------------------------------------------------------

void test("mixed content groups into [run, box, run]", () => {
  // <div>text <div>block</div> more</div> — node 1 mixes inline text with a
  // block child. The fixup produces TWO inline runs around ONE box.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3, 4] },
    { id: 2, kind: "text", text: "text ", parent: 1 },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 4, kind: "text", text: " more", parent: 1 },
  ]);
  const tree = buildLayoutTree(dom, styleOf(new Map([[3, { display: "block" }]])));
  const children = tree.childrenOf.get(nodeId(1))!;

  assert.equal(children.length, 3);
  assert.deepEqual(
    children.map((c) => c.kind),
    ["inline-run", "box", "inline-run"],
  );
  assert.deepEqual((children[0] as { nodes: readonly number[] }).nodes, [2]);
  assert.deepEqual((children[2] as { nodes: readonly number[] }).nodes, [4]);
});

void test("whitespace-only runs between block boxes are dropped", () => {
  // <div>\n  <p>a</p>\n  <p>b</p>\n</div> — the whitespace text nodes (3, 5)
  // between the two block children are collapsible: css2.1 §9.2.1.1 removes
  // them; they must not even appear as empty inline runs.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3, 4, 5, 6] },
    { id: 2, kind: "text", text: "\n  ", parent: 1 },
    { id: 3, kind: "element", tag: "p", parent: 1, children: [] },
    { id: 4, kind: "text", text: "\n  ", parent: 1 },
    { id: 5, kind: "element", tag: "p", parent: 1, children: [] },
    { id: 6, kind: "text", text: "\n", parent: 1 },
  ]);
  const styles = new Map([
    [3, { display: "block" }],
    [5, { display: "block" }],
  ]);
  const tree = buildLayoutTree(dom, styleOf(styles));
  const children = tree.childrenOf.get(nodeId(1))!;

  assert.equal(children.length, 2, "only the two boxes — all whitespace runs dropped");
  assert.deepEqual(
    children.map((c) => c.kind),
    ["box", "box"],
  );
});

void test("a run of only whitespace in an inline-only container is dropped too", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "text", text: "   ", parent: 1 },
  ]);
  const tree = buildLayoutTree(dom, styleOf(new Map()));
  assert.equal(tree.childrenOf.get(nodeId(1))!.length, 0);
});

void test("whitespace INSIDE a content run is kept (word separation)", () => {
  // <div>a <b>x</b> c</div> — the text nodes contain real words + spaces; the
  // run has an element so nothing is dropped.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3, 4] },
    { id: 2, kind: "text", text: "a ", parent: 1 },
    { id: 3, kind: "element", tag: "b", parent: 1, children: [] },
    { id: 4, kind: "text", text: " c", parent: 1 },
  ]);
  const tree = buildLayoutTree(dom, styleOf(new Map()));
  const children = tree.childrenOf.get(nodeId(1))!;
  assert.equal(children.length, 1);
  assert.deepEqual((children[0] as { nodes: readonly number[] }).nodes, [2, 3, 4]);
});

// ---------------------------------------------------------------------------
// Table fixup (css-tables-3): bare text, mixed rows, naked cells.
// ---------------------------------------------------------------------------

void test("bare text in a table wraps into an anonymous row + cell", () => {
  // <table>hello</table> — pre-B1 this text was SILENTLY DROPPED by
  // layoutTable; the fixup wraps it so it lays out.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "table", parent: 0, children: [2] },
    { id: 2, kind: "text", text: "hello", parent: 1 },
  ]);
  const tree = buildLayoutTree(dom, styleOf(new Map([[1, { display: "table" }]])));
  const rows = tree.tableStructureOf.get(nodeId(1))!;

  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.rowId, null, "anonymous row");
  assert.equal(rows[0]!.cells.length, 1);
  assert.equal(rows[0]!.cells[0]!.cellId, null, "anonymous cell");
  const cellChildren = rows[0]!.cells[0]!.children!;
  assert.equal(cellChildren.length, 1);
  assert.deepEqual((cellChildren[0] as { nodes: readonly number[] }).nodes, [2]);
});

void test("mixed row content: text before a real cell wraps into its own cell", () => {
  // <tr>text<td>cell</td></tr> — the leading text gets an anonymous cell; the
  // real td keeps its identity.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "table", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "tr", parent: 1, children: [3, 4] },
    { id: 3, kind: "text", text: "text", parent: 2 },
    { id: 4, kind: "element", tag: "td", parent: 2, children: [] },
  ]);
  const styles = new Map([
    [1, { display: "table" }],
    [2, { display: "table-row" }],
    [4, { display: "table-cell" }],
  ]);
  const tree = buildLayoutTree(dom, styleOf(styles));
  const rows = tree.tableStructureOf.get(nodeId(1))!;

  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.rowId, 2, "real row");
  assert.equal(rows[0]!.cells.length, 2);
  assert.equal(rows[0]!.cells[0]!.cellId, null, "anonymous cell for the text");
  assert.equal(rows[0]!.cells[1]!.cellId, 4, "real cell keeps identity");
});

void test("row groups (tbody) expand transparently into rows", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "table", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "tbody", parent: 1, children: [3] },
    { id: 3, kind: "element", tag: "tr", parent: 2, children: [] },
  ]);
  const styles = new Map([
    [1, { display: "table" }],
    [2, { display: "table-row-group" }],
    [3, { display: "table-row" }],
  ]);
  const tree = buildLayoutTree(dom, styleOf(styles));
  const rows = tree.tableStructureOf.get(nodeId(1))!;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.rowId, 3, "the tr inside tbody surfaces as a row");
});

void test("naked table cells in a block wrap into an anonymous table", () => {
  // <div><td>a</td><td>b</td></div> — consecutive cells wrap into one
  // anonymous table (css-tables-3 generate_missing_parents).
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "td", parent: 1, children: [4] },
    { id: 3, kind: "element", tag: "td", parent: 1, children: [] },
    { id: 4, kind: "text", text: "a", parent: 2 },
  ]);
  const styles = new Map([
    [1, { display: "block" }],
    [2, { display: "table-cell" }],
    [3, { display: "table-cell" }],
  ]);
  const tree = buildLayoutTree(dom, styleOf(styles));
  const children = tree.childrenOf.get(nodeId(1))!;

  assert.equal(children.length, 1, "one anonymous table wraps the cell sequence");
  assert.equal(children[0]!.kind, "table");
  const table = children[0] as { kind: "table"; rows: { rowId: number | null; cells: unknown[] }[] };
  assert.equal(table.rows.length, 1);
  assert.equal(table.rows[0]!.cells.length, 2);
});

// ---------------------------------------------------------------------------
// Geometry: the fixup must NOT change existing mixed-content positioning.
// ---------------------------------------------------------------------------

void test("mixed content lays out sequentially (geometry unchanged from pre-B1)", () => {
  // The pre-B1 engine already stacked runs and blocks in document order; the
  // tree builder must preserve that ordering and geometry exactly.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3, 4] },
    { id: 2, kind: "text", text: "first", parent: 1 },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 4, kind: "text", text: "second", parent: 1 },
  ]);
  const styles = new Map<number, ComputedStyle>([
    [1, makeStyle({ display: "block", width: 300 })],
    [3, makeStyle({ display: "block", height: 50 })],
  ]);
  const tree = layout(dom, styleTable(styles));
  // The mixed content is INSIDE div(1): its fragment holds the three slots.
  const container = [...tree.fragments.values()].find((f) => f.node === nodeId(1))!;
  const kids = container.children.map((id) => tree.fragments.get(id)!);

  // Document order preserved: [run("first"), block, run("second")].
  assert.equal(kids.length, 3);
  const text1 = kids.find((f) => f.text !== undefined && f.node === nodeId(2));
  const block = kids.find((f) => f.node === nodeId(3));
  const text2 = kids.find((f) => f.text !== undefined && f.node === nodeId(4));
  assert.ok(text1 !== undefined && block !== undefined && text2 !== undefined);

  // Sequential stacking: the block starts after the first line, the second
  // text after the block.
  assert.equal(block.box.borderBox.y, 16, "block follows the 16px line");
  assert.equal(text2.box.borderBox.y, 66, "second run follows the 50px block");
});

void test("table text lays out (was silently dropped pre-B1)", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "table", parent: 0, children: [2] },
    { id: 2, kind: "text", text: "cell text", parent: 1 },
  ]);
  const styles = new Map<number, ComputedStyle>([[1, makeStyle({ display: "table", width: 200 })]]);
  const tree = layout(dom, styleTable(styles));

  // A text fragment with REAL geometry exists — the pre-B1 engine produced
  // an empty table (the text vanished).
  const textFrags = [...tree.fragments.values()].filter((f) => f.text !== undefined);
  assert.equal(textFrags.length, 1, "the table's text survives");
  assert.ok(textFrags[0]!.box.height >= 16, "the cell text has line height");
});
