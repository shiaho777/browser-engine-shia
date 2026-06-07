/**
 * Tests for quirks-mode LAYOUT behaviour (task 9.4; design.md §5 Phase 8+;
 * Requirement 17.4 — "THE Engine SHALL support quirks-mode … layout behaviors").
 *
 * Built by `tsc` then run with: `node --test packages/layout/dist/*.test.js`.
 *
 * The one quirk implemented at the layout layer is the classic "quirks-mode
 * full-canvas root": an auto-height `document` root stretches to fill at least
 * the viewport height, so a short document still paints a full-viewport canvas.
 * These assert:
 *   - quirks mode stretches a short root to the viewport height;
 *   - standards (no-quirks, the default) leaves the root at its content height
 *     — byte-for-byte unchanged from prior phases;
 *   - a root already taller than the viewport is NOT shrunk in quirks mode;
 *   - the quirk affects ONLY the root box; children keep their geometry.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { deepFreeze, nodeId, px } from "@browser-engine/ir";
import type { Color, ComputedStyle, DomNode, DomTree, Edges, Fragment, FragmentTree, NodeId, Px } from "@browser-engine/ir";

import { DEFAULT_VIEWPORT_HEIGHT, layout } from "./index.js";

interface NodeSpec {
  readonly id: number;
  readonly kind: DomNode["kind"];
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
    const node: DomNode =
      spec.kind === "element" ? { ...base, tag: "div", attrs: new Map<string, string>() } : base;
    nodes.set(node.id, node);
  }
  return deepFreeze({ root: nodeId(0), nodes } as unknown as DomTree);
}

const BLACK: Color = { r: 0, g: 0, b: 0, a: 1 };
const TRANSPARENT: Color = { r: 0, g: 0, b: 0, a: 0 };
const ZERO_EDGES: Edges<Px> = { top: px(0), right: px(0), bottom: px(0), left: px(0) };

function makeStyle(spec: { display?: string; height?: number | "auto" } = {}): ComputedStyle {
  return deepFreeze({
    display: spec.display ?? "inline",
    color: BLACK,
    fontSize: px(16),
    margin: ZERO_EDGES,
    width: "auto",
    height: spec.height ?? "auto",
    backgroundColor: TRANSPARENT,
  } as unknown as ComputedStyle);
}

function styleTable(map: ReadonlyMap<number, ComputedStyle>): (node: NodeId) => ComputedStyle {
  const fallback = makeStyle();
  return (node: NodeId) => map.get(Number(node)) ?? fallback;
}

function rootFragment(tree: FragmentTree): Fragment {
  return tree.fragments.get(tree.root)!;
}

/** A document → div(height 30) scene (short content: 30px tall root). */
function shortScene(): { dom: DomTree; styles: (n: NodeId) => ComputedStyle } {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", parent: 0 },
  ]);
  const styles = styleTable(new Map([[1, makeStyle({ display: "block", height: 30 })]]));
  return { dom, styles };
}

void test("Req 17.4: quirks mode stretches a short auto-height root to the viewport height", () => {
  const { dom, styles } = shortScene();
  const tree = layout(dom, styles, { quirksMode: true, viewportHeight: px(600) });
  const root = rootFragment(tree);
  assert.equal(root.box.height, px(600), "quirks root fills the viewport height");
  assert.equal(root.box.borderBox.height, px(600));
});

void test("Req 17.4: standards (no-quirks, default) leaves the root at its content height", () => {
  const { dom, styles } = shortScene();
  const tree = layout(dom, styles); // default: standards mode.
  const root = rootFragment(tree);
  // The root's auto height is the single child's 30px — unchanged from prior phases.
  assert.equal(root.box.height, px(30));
});

void test("Req 17.4: quirksMode:false is byte-for-byte identical to omitting the option", () => {
  const { dom, styles } = shortScene();
  const a = layout(dom, styles);
  const b = layout(dom, styles, { quirksMode: false });
  assert.equal(a.fragments.size, b.fragments.size);
  for (const [id, fragA] of a.fragments) {
    assert.deepEqual(fragA, b.fragments.get(id));
  }
});

void test("Req 17.4: a root already taller than the viewport is NOT shrunk in quirks mode", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", parent: 0 },
  ]);
  const styles = styleTable(new Map([[1, makeStyle({ display: "block", height: 900 })]]));
  const tree = layout(dom, styles, { quirksMode: true, viewportHeight: px(600) });
  assert.equal(rootFragment(tree).box.height, px(900), "a tall root keeps its height");
});

void test("Req 17.4: the quirk grows ONLY the root box; children keep their geometry", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", parent: 0 },
  ]);
  const styles = styleTable(new Map([[1, makeStyle({ display: "block", height: 30 })]]));
  const standards = layout(dom, styles);
  const quirks = layout(dom, styles, { quirksMode: true, viewportHeight: px(600) });

  // The child div fragment is identical in both modes (same y, height).
  const childStandards = [...standards.fragments.values()].find((f) => f.node === nodeId(1))!;
  const childQuirks = [...quirks.fragments.values()].find((f) => f.node === nodeId(1))!;
  assert.deepEqual(childQuirks.box, childStandards.box, "only the root grows, not its children");
});

void test("quirks-mode viewport height defaults to DEFAULT_VIEWPORT_HEIGHT", () => {
  const { dom, styles } = shortScene();
  const tree = layout(dom, styles, { quirksMode: true });
  assert.equal(rootFragment(tree).box.height, DEFAULT_VIEWPORT_HEIGHT);
});
