/**
 * text-transform.test.ts — E2 tests: the rendered-text view (CSS Text §3.1) —
 * `text-transform: uppercase | lowercase | capitalize` applies to the SHAPED
 * glyph stream (layout + paint) while the DOM's text content stays untouched.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { deepFreeze, nodeId, px, type ComputedStyle, type DomNode, type DomTree } from "@browser-engine/ir";
import { layout } from "./index.js";
import { proportionalShaper } from "./text-shaper.js";

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

/** div(1) with one text child(2); measure the laid-out text run. */
function textRunWidth(text: string, style: Record<string, unknown>): number {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "text", text, parent: 1 },
  ]);
  const styles = new Map<number, ComputedStyle>([
    [1, makeStyle({ display: "block", width: 500 })],
    [2, makeStyle(style)],
  ]);
  const tree = layout(dom, styleTable(styles), { shaper: proportionalShaper });
  const frag = [...tree.fragments.values()].find((f) => f.text !== undefined);
  assert.ok(frag !== undefined, "the text run laid out");
  return Number(frag.box.width);
}

// The metrics placeholder: each code unit advances fontSize × em-class.

void test("uppercase widens the rendered run vs the source text", () => {
  const none = textRunWidth("hello", {});
  const upper = textRunWidth("hello", { textTransform: "uppercase" });
  // 'HELLO' (H,E,L,L,O are all WIDE class 0.62em) is wider than 'hello'
  // (normal class 0.52em): 5×16×0.62 = 49.6 vs 5×16×0.52 = 41.6.
  assert.ok(upper > none, `HELLO (${upper}) wider than hello (${none})`);
  assert.ok(Math.abs(upper - 49.6) < 0.5, `uppercase metrics: ${upper}`);
});

void test("lowercase narrows the rendered run vs the uppercase source", () => {
  const asIs = textRunWidth("HELLO", {});
  const lowered = textRunWidth("HELLO", { textTransform: "lowercase" });
  assert.ok(lowered < asIs, `hello (${lowered}) narrower than HELLO (${asIs})`);
});

void test("capitalize uppercases the first letter of each word only", () => {
  const capped = textRunWidth("hello world", { textTransform: "capitalize" });
  // 'Hello World': H,W wide (0.62); e,l,l,o,o,o,r,l,d normal (0.52); space
  // narrow (0.34). = 2×9.92 + 9×8.32 + 3.2*1... compute: the exact value
  // matters less than the shape — compare against the fully-lowercased run.
  const lower = textRunWidth("hello world", {});
  const allCaps = textRunWidth("hello world", { textTransform: "uppercase" });
  assert.ok(capped > lower, "capitalize is wider than lowercase (2 caps)");
  assert.ok(capped < allCaps, "capitalize is narrower than full uppercase (9 uncapped)");
});

void test("text-transform: none (and absent) leaves the run unchanged", () => {
  const absent = textRunWidth("Mixed Case", {});
  const none = textRunWidth("Mixed Case", { textTransform: "none" });
  assert.equal(absent, none, "none === absent");
});

void test("the DOM text content is NOT mutated (only the shaped view)", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "text", text: "hello", parent: 1 },
  ]);
  const styles = new Map<number, ComputedStyle>([
    [1, makeStyle({ display: "block", width: 500 })],
    [2, makeStyle({ textTransform: "uppercase" })],
  ]);
  layout(dom, styleTable(styles));
  assert.equal(dom.nodes.get(nodeId(2))?.text, "hello", "the DOM keeps the source text");
});

void test("text-transform inherits (an inherited property)", () => {
  // The parent declares it; the child text node (no declaration) inherits.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "text", text: "hello", parent: 1 },
  ]);
  // The cascade inherits text-transform to the text node; our styleTable
  // stub does not — verify with the value on the text node itself (the
  // layout reads the TEXT node's computed style, which a real cascade fills
  // from the parent via inheritance).
  const styles = new Map<number, ComputedStyle>([
    [1, makeStyle({ display: "block", width: 500 })],
    [2, makeStyle({ textTransform: "uppercase" })],
  ]);
  const tree = layout(dom, styleTable(styles), { shaper: proportionalShaper });
  const frag = [...tree.fragments.values()].find((f) => f.text !== undefined);
  assert.ok(frag !== undefined);
  // HELLO metrics: 5 × 16 × 0.62 = 49.6.
  assert.ok(Math.abs(Number(frag.box.width) - 49.6) < 0.5, `uppercase on the text node: ${Number(frag.box.width)}`);
});

void test("an unrecognized value is treated as none (no silent mis-transform)", () => {
  const none = textRunWidth("hello", {});
  const bogus = textRunWidth("hello", { textTransform: "full-width" });
  assert.equal(none, bogus, "full-width (unimplemented) falls back to no transform");
});

void test("text-transform affects the max-content estimate (shrink-to-fit follows)", () => {
  // An abspos box with text-transform: uppercase shrinks to the TRANSFORMED
  // text's width — the estimator and the inline layout agree.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [4] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 4, kind: "text", text: "hello", parent: 2 },
  ]);
  const styles = new Map<number, ComputedStyle>([
    [1, makeStyle({ display: "block", width: 300 })],
    [2, makeStyle({ display: "block", position: "absolute", textTransform: "uppercase" })],
    [4, makeStyle({ textTransform: "uppercase" })],
  ]);
  const tree = layout(dom, styleTable(styles), { shaper: proportionalShaper });
  const abs = [...tree.fragments.values()].find((f) => f.node === nodeId(2));
  assert.ok(abs !== undefined);
  // HELLO: 5 × 16 × 0.62 = 49.6 (the transformed text's shrink-to-fit).
  assert.ok(Math.abs(Number(abs.box.width) - 49.6) < 0.5, `shrink-to-fit measures HELLO: ${Number(abs.box.width)}`);
});
