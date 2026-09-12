/**
 * baseline.test.ts — B4 tests: baseline alignment and the vertical-align
 * matrix (CSS 2.1 §10.8) in the inline formatting context.
 *
 * The line box assembles from members' BASELINE extents (plus the parent-font
 * strut), so mixed-height members align on their baselines, and
 * vertical-align shifts follow the spec's keyword/length semantics.
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

/** A run: text "hi" (font 16 ⇒ ascent 12.8) + an inline-block box. */
function runWithBox(boxStyle: Record<string, unknown>): ReturnType<typeof layout> {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "text", text: "hi", parent: 1 },
    { id: 3, kind: "element", tag: "span", parent: 1, children: [] },
  ]);
  const styles = new Map<number, ComputedStyle>([
    [1, makeStyle({ display: "block", width: 300 })],
    [3, makeStyle({ display: "inline-block", ...boxStyle })],
  ]);
  return layout(dom, styleTable(styles));
}

void test("an inline-block's BOTTOM sits on the text baseline (default alignment)", () => {
  // Text "hi" at font 16: ascent = 0.8 × 16 = 12.8. The box (h=30) aligns its
  // bottom edge to the baseline: top = lineAscent − 30, where lineAscent =
  // max(12.8, 30) = 30 ⇒ box top = 0, text top = 30 − 12.8 = 17.2.
  const tree = runWithBox({ width: 40, height: 30 });
  const text = fragOf(tree, 2);
  const box = fragOf(tree, 3);
  assert.equal(Number(box.box.borderBox.y), 0, "the taller box sets the line's ascent");
  assert.equal(Number(text.box.borderBox.y), 17.2, "text's baseline meets the box's bottom edge");
});

void test("vertical-align: top puts the box at the line top", () => {
  const tree = runWithBox({ width: 40, height: 8, "verticalAlign": "top" });
  const box = fragOf(tree, 3);
  // The box is 8px tall with valign top: y = 0 even though its baseline extent
  // would place it lower.
  assert.equal(Number(box.box.borderBox.y), 0);
});

void test("vertical-align: bottom puts the box at the line bottom", () => {
  const tree = runWithBox({ width: 40, height: 8, "verticalAlign": "bottom" });
  const box = fragOf(tree, 3);
  // Line height ≥ strut (16); the 8px box sits at the line's bottom.
  const text = fragOf(tree, 2);
  const lineH = Number(text.box.borderBox.y) + 16; // text top + one text line height.
  assert.equal(Number(box.box.borderBox.y), lineH - 8);
});

void test("vertical-align: super raises the box above the baseline", () => {
  // The line box GROWS to contain the raised member (CSS 2.1 §10.8), so the
  // shift is measured against the BASELINE (the text), not absolute y.
  const baselineOf = (tree: ReturnType<typeof layout>): number =>
    Number(fragOf(tree, 2).box.borderBox.y) + 12.8;
  const bottomOf = (tree: ReturnType<typeof layout>): number =>
    Number(fragOf(tree, 3).box.borderBox.y) + 8;
  const normal = runWithBox({ width: 40, height: 8 });
  const sup = runWithBox({ width: 40, height: 8, "verticalAlign": "super" });
  const normalOffset = bottomOf(normal) - baselineOf(normal);
  const superOffset = bottomOf(sup) - baselineOf(sup);
  // super shifts UP by 0.33em = 5.28px relative to the baseline.
  assert.ok(Math.abs(normalOffset - superOffset - 5.28) < 0.01, "by 0.33em above the baseline");
});

void test("vertical-align: sub lowers the box below the baseline", () => {
  const normal = runWithBox({ width: 40, height: 8 });
  const subbed = runWithBox({ width: 40, height: 8, "verticalAlign": "sub" });
  const normalY = Number(fragOf(normal, 3).box.borderBox.y);
  const subY = Number(fragOf(subbed, 3).box.borderBox.y);
  assert.ok(subY > normalY, `sub lowers the box (${subY} > ${normalY})`);
});

void test("vertical-align: middle centers the box on the baseline + half x-height", () => {
  const tree = runWithBox({ width: 40, height: 8, "verticalAlign": "middle" });
  const box = fragOf(tree, 3);
  // Line ascent = max(strut 12.8, extents…); the box's center =
  // baseline + 0.25em (4px) ⇒ top = lineAscent − 8/2 + ... derive from text:
  const text = fragOf(tree, 2);
  const baseline = Number(text.box.borderBox.y) + 12.8; // the line's baseline y.
  const boxCenter = Number(box.box.borderBox.y) + 4;
  assert.ok(Math.abs(boxCenter - (baseline + 4)) < 0.01, "center = baseline + half x-height");
});

void test("vertical-align: text-top aligns the box's top with the font's ascent", () => {
  const tree = runWithBox({ width: 40, height: 8, "verticalAlign": "text-top" });
  const text = fragOf(tree, 2);
  const box = fragOf(tree, 3);
  assert.equal(Number(box.box.borderBox.y), Number(text.box.borderBox.y), "same top as the text");
});

void test("a length vertical-align raises the box by that amount", () => {
  // Baseline-relative (the line grows to contain the raised box).
  const baselineOf = (tree: ReturnType<typeof layout>): number =>
    Number(fragOf(tree, 2).box.borderBox.y) + 12.8;
  const bottomOf = (tree: ReturnType<typeof layout>): number =>
    Number(fragOf(tree, 3).box.borderBox.y) + 8;
  const normal = runWithBox({ width: 40, height: 8 });
  const raised = runWithBox({ width: 40, height: 8, "verticalAlign": "6px" });
  const normalOffset = bottomOf(normal) - baselineOf(normal);
  const raisedOffset = bottomOf(raised) - baselineOf(raised);
  assert.ok(Math.abs(normalOffset - raisedOffset - 6) < 0.01, "raised by exactly 6px");
});

void test("a lone inline-block line is at least strut-height (the strut participates)", () => {
  // Only an inline-block (8px) in the run: the line is at least the parent's
  // font line (strut ascent+descent = 16px) per CSS 2.1 §10.8.1.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "span", parent: 1, children: [] },
  ]);
  const styles = new Map<number, ComputedStyle>([
    [1, makeStyle({ display: "block", width: 300 })],
    [2, makeStyle({ display: "inline-block", width: 40, height: 8 })],
  ]);
  const tree = layout(dom, styleTable(styles));
  const container = fragOf(tree, 1);
  // The container's height includes the strut line.
  assert.ok(Number(container.box.height) >= 16, `container ≥ strut height, got ${Number(container.box.height)}`);
});
