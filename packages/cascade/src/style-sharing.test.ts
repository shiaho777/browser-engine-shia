/**
 * style-sharing.test.ts — F2 tests: the style-sharing cache. Elements with the
 * same tag + classes + matched-rule sequence + same inheritable parent compute
 * IDENTICAL ComputedStyles — the second reuses the first's frozen object.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { nodeId, type DomNode, type DomTree, type NodeId } from "@browser-engine/ir";
import { cascade, styleSharingStats } from "./index.js";

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

void test("style sharing: same selector + same parent ⇒ same object (via sheets)", () => {
  // Three .card divs under the same parent; .card { width: 200px; height: 50px }.
  // The FIRST computes; the SECOND and THIRD share the first's frozen object.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3, 4] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 4, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  // Give each card the class="card" attribute.
  for (const id of [2, 3, 4]) {
    Object.assign(dom.nodes.get(nodeId(id)) as object, { attrs: new Map([["class", "card"]]) });
  }
  // Build a stylesheet via the exported parseCss from css-parser (the test
  // cannot import cross-stage; use cascade with a sheet built manually).
  const sheets = [
    {
      rules: [
        {
          selector: [{ text: ".card" }],
          declarations: [
            { property: "width", value: "200px", important: false },
            { property: "height", value: "50px", important: false },
          ],
          specificity: [0, 1, 0],
          order: 0,
        },
      ],
      layerOrder: undefined,
    },
  ] as never;
  const s1 = cascade(dom, sheets, nodeId(2));
  const s2 = cascade(dom, sheets, nodeId(3));
  const s3 = cascade(dom, sheets, nodeId(4));
  // The three cards SHARE: s2 and s3 are the SAME OBJECT as s1.
  assert.equal(s2, s1, "card 2 shares card 1's style object");
  assert.equal(s3, s1, "card 3 shares card 1's style object");
  assert.equal(Number(s1["width"]), 200, "the shared style is correct");
});

void test("style sharing stats count hits and misses", () => {
  const before = styleSharingStats();
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "span", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "span", parent: 1, children: [] },
  ]);
  for (const id of [2, 3]) {
    Object.assign(dom.nodes.get(nodeId(id)) as object, { attrs: new Map([["class", "pill"]]) });
  }
  const sheets = [
    {
      rules: [
        {
          selector: [{ text: ".pill" }],
          declarations: [{ property: "color", value: "red", important: false }],
          specificity: [0, 1, 0],
          order: 0,
        },
      ],
    },
  ] as never;
  cascade(dom, sheets, nodeId(2));
  cascade(dom, sheets, nodeId(3));
  const after = styleSharingStats();
  // The first pill MISSES (computes); the second HITS (shares).
  assert.ok(after.hits > before.hits, `hits grew (${before.hits} → ${after.hits})`);
  assert.ok(after.misses > before.misses, `misses grew (${before.misses} → ${after.misses})`);
});

void test("a DIFFERENT class does not share (a different rule matches)", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  Object.assign(dom.nodes.get(nodeId(2)) as object, { attrs: new Map([["class", "a"]]) });
  Object.assign(dom.nodes.get(nodeId(3)) as object, { attrs: new Map([["class", "b"]]) });
  const sheets = [
    {
      rules: [
        {
          selector: [{ text: ".a" }],
          declarations: [{ property: "width", value: "100px", important: false }],
          specificity: [0, 1, 0],
          order: 0,
        },
        {
          selector: [{ text: ".b" }],
          declarations: [{ property: "width", value: "200px", important: false }],
          specificity: [0, 1, 0],
          order: 1,
        },
      ],
    },
  ] as never;
  const sa = cascade(dom, sheets, nodeId(2));
  const sb = cascade(dom, sheets, nodeId(3));
  assert.notEqual(sa, sb, "different classes ⇒ different styles");
  assert.equal(Number(sa["width"]), 100);
  assert.equal(Number(sb["width"]), 200);
});

void test("an interaction-state difference prevents sharing (:hover)", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  for (const id of [2, 3]) {
    Object.assign(dom.nodes.get(nodeId(id)) as object, { attrs: new Map([["class", "item"]]) });
  }
  const sheets = [
    {
      rules: [
        {
          selector: [{ text: ".item" }],
          declarations: [{ property: "width", value: "100px", important: false }],
          specificity: [0, 1, 0],
          order: 0,
        },
        {
          selector: [{ text: ".item:hover" }],
          declarations: [{ property: "height", value: "80px", important: false }],
          specificity: [0, 2, 0],
          order: 1,
        },
      ],
    },
  ] as never;
  const noState = { hovered: new Set<NodeId>(), active: new Set<NodeId>(), focused: new Set<NodeId>() };
  const hover2 = { hovered: new Set([nodeId(2)]), active: new Set<NodeId>(), focused: new Set<NodeId>() };
  const s1 = cascade(dom, sheets, nodeId(2), undefined, undefined, undefined, noState);
  const s2hover = cascade(dom, sheets, nodeId(2), undefined, undefined, undefined, hover2);
  assert.notEqual(s1, s2hover, "hover and non-hover do not share");
  assert.equal(s2hover["height"], 80, "the hovered variant has the :hover height");
  assert.equal(s1["height"] ?? "auto", "auto", "the non-hover variant does not");
});
