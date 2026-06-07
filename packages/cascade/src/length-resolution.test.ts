/**
 * Tests for font-relative length resolution in the cascade (CSS Values 4 §6.1):
 * `em` resolves against the element's own computed `font-size` (and, for
 * `font-size` itself, against the parent's), while `rem` resolves against the
 * root font size. Built by `tsc`, run with `node --test packages/cascade/dist/*.test.js`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { DomTree, DomNode, NodeId, StyleSheet } from "@browser-engine/ir";
import { nodeId, deepFreeze } from "@browser-engine/ir";

import { cascade } from "./index.js";

/** Build a tiny two-node DomTree: a root <div> with one child <p>. */
function tree(): DomTree {
  const root = nodeId(0);
  const child = nodeId(1);
  const nodes = new Map<NodeId, DomNode>([
    [root, { id: root, kind: "element", tag: "div", attrs: new Map(), parent: null, children: [child] } as unknown as DomNode],
    [child, { id: child, kind: "element", tag: "p", attrs: new Map(), parent: root, children: [] } as unknown as DomNode],
  ]);
  return deepFreeze({ root, nodes } as unknown as DomTree);
}

/** A stylesheet of `selector { decls }` rules (specificity by order, low→high). */
function sheet(rules: { selector: string; decls: Record<string, string> }[]): StyleSheet {
  const styleRules = rules.map((r, order) => ({
    selector: [{ text: r.selector }],
    declarations: Object.entries(r.decls).map(([property, value]) => ({ property, value, important: false })),
    specificity: [0, 0, 1] as const,
    order,
  }));
  return deepFreeze({ rules: styleRules } as unknown as StyleSheet);
}

const field = (s: unknown, f: string): unknown => (s as Record<string, unknown>)[f];

void test("em on a non-font-size property resolves against the element's own font-size", () => {
  const dom = tree();
  const sheets = [sheet([{ selector: "div", decls: { "font-size": "20px", width: "2em" } }])];
  const style = cascade(dom, sheets, nodeId(0));
  assert.equal(field(style, "fontSize"), 20);
  assert.equal(field(style, "width"), 40, "2em × 20px = 40px");
});

void test("em on font-size itself resolves against the PARENT font-size", () => {
  const dom = tree();
  const sheets = [
    sheet([
      { selector: "div", decls: { "font-size": "20px" } },
      { selector: "p", decls: { "font-size": "1.5em" } },
    ]),
  ];
  const child = cascade(dom, sheets, nodeId(1));
  assert.equal(field(child, "fontSize"), 30, "1.5em × parent 20px = 30px");
});

void test("rem resolves against the root font size (16px default), not the element", () => {
  const dom = tree();
  const sheets = [sheet([{ selector: "div", decls: { "font-size": "32px", width: "2rem" } }])];
  const style = cascade(dom, sheets, nodeId(0));
  assert.equal(field(style, "width"), 32, "2rem × 16px root = 32px (independent of the 32px font-size)");
});

void test("em in a margin edge quad resolves each edge against font-size", () => {
  const dom = tree();
  const sheets = [sheet([{ selector: "div", decls: { "font-size": "10px", margin: "1em 2em" } }])];
  const style = cascade(dom, sheets, nodeId(0));
  assert.deepEqual(field(style, "margin"), { top: 10, right: 20, bottom: 10, left: 20 });
});

void test("inherited font-size makes em on a child resolve against the inherited value", () => {
  const dom = tree();
  // The child has no font-size of its own; it inherits 24px and `width:2em` = 48.
  const sheets = [
    sheet([
      { selector: "div", decls: { "font-size": "24px" } },
      { selector: "p", decls: { width: "2em" } },
    ]),
  ];
  const child = cascade(dom, sheets, nodeId(1));
  assert.equal(field(child, "fontSize"), 24, "font-size inherited from the parent div");
  assert.equal(field(child, "width"), 48, "2em × inherited 24px = 48px");
});

void test("vw/vh resolve against the supplied viewport size", () => {
  const dom = tree();
  const sheets = [sheet([{ selector: "div", decls: { width: "50vw", height: "25vh" } }])];
  const style = cascade(dom, sheets, nodeId(0), { width: 1000, height: 800 });
  assert.equal(field(style, "width"), 500, "50vw × 1000 / 100 = 500");
  assert.equal(field(style, "height"), 200, "25vh × 800 / 100 = 200");
});

void test("vmin/vmax resolve against the smaller/larger viewport axis", () => {
  const dom = tree();
  const sheets = [sheet([{ selector: "div", decls: { width: "10vmin", height: "10vmax" } }])];
  const style = cascade(dom, sheets, nodeId(0), { width: 1200, height: 400 });
  assert.equal(field(style, "width"), 40, "10vmin × min(1200,400)=400 / 100 = 40");
  assert.equal(field(style, "height"), 120, "10vmax × max(1200,400)=1200 / 100 = 120");
});

void test("the default viewport (800×600) applies when no viewport is supplied", () => {
  const dom = tree();
  const sheets = [sheet([{ selector: "div", decls: { width: "100vw", height: "100vh" } }])];
  const style = cascade(dom, sheets, nodeId(0));
  assert.equal(field(style, "width"), 800, "100vw of the 800px default width");
  assert.equal(field(style, "height"), 600, "100vh of the 600px default height");
});
