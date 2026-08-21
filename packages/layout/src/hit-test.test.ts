import test from "node:test";
import assert from "node:assert/strict";
import { deepFreeze, nodeId, px } from "@browser-engine/ir";
import type { ComputedStyle, DomNode, DomTree, NodeId } from "@browser-engine/ir";
import { hitTest, layout } from "./index.js";

function makeStyle(width: number, height: number): ComputedStyle {
  return deepFreeze({
    display: "block",
    width: px(width),
    height: px(height),
    fontSize: px(16),
    margin: { top: px(0), right: px(0), bottom: px(0), left: px(0) },
    color: { r: 0, g: 0, b: 0, a: 1 },
    backgroundColor: { r: 0, g: 0, b: 0, a: 0 },
  } as unknown as ComputedStyle);
}

void test("hitTest returns the smallest covering fragment", () => {
  const root = nodeId(0);
  const outer = nodeId(1);
  const inner = nodeId(2);
  const nodes = new Map<NodeId, DomNode>([
    [root, deepFreeze({ id: root, kind: "document", children: [outer], parent: null })],
    [
      outer,
      deepFreeze({
        id: outer,
        kind: "element",
        tag: "div",
        children: [inner],
        parent: root,
        attrs: deepFreeze(new Map()),
      }),
    ],
    [
      inner,
      deepFreeze({
        id: inner,
        kind: "element",
        tag: "a",
        children: [],
        parent: outer,
        attrs: deepFreeze(new Map([["href", "/next"]])),
      }),
    ],
  ]);
  const dom = deepFreeze({ root, nodes }) as unknown as DomTree;
  const styles = new Map<NodeId, ComputedStyle>([
    [outer, makeStyle(200, 100)],
    [inner, makeStyle(80, 30)],
  ]);
  const tree = layout(dom, (id) => styles.get(id) ?? makeStyle(0, 0));
  const hit = hitTest(tree, 10, 10);
  assert.ok(hit !== null);
  assert.equal(hit.node, inner);
  assert.equal(hitTest(tree, 900, 900), null);
});
