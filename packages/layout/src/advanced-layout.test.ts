/**
 * Unit tests for the Phase 5-7 advanced layout BRANCHES (task 7.1; design.md
 * §8.2 note; Requirement 16.1: "THE Layout_Engine SHALL support flexbox, grid,
 * table, float, and positioned layout").
 *
 * Built by `tsc` then run with: `node --test packages/layout/dist/*.test.js`.
 *
 * These exercise the new branches dispatched off `display` / `position` /
 * `float`: flex (row main-axis distribution + column stacking), grid (row-major
 * placement into equal-width cells), table (rows → cells), float (shifted out of
 * flow with following content flowing), and positioned (relative offset keeping
 * its in-flow space; absolute removed from flow). They also prove the branches
 * produce a valid, deep-frozen {@link FragmentTree} and that the default
 * block/inline path is unaffected when none of these properties are present.
 *
 * IMPORTANT (the pending generator extension): the cascade `generator` does not
 * yet emit `position` / `float` / `flex-direction` / `grid-template-columns` /
 * the `table` display keyword into the ComputedStyle property table, so the
 * layout engine reads them DEFENSIVELY off ComputedStyle's open
 * `[k: string]: unknown` index signature. These tests therefore drive the
 * branches with a SYNTHETIC ComputedStyle that carries the layout properties via
 * that open signature — mirroring how task 5.8 tested the `border` command.
 *
 * Layout lives inside a *stage* package, so (per `local/no-cross-stage-import`)
 * it may import ONLY the frozen IR (`@browser-engine/ir`) and the package under
 * test — never html-parser / cascade. The DomTree input and ComputedStyle table
 * are assembled here by hand as frozen IR values.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { deepFreeze, nodeId, px } from "@browser-engine/ir";
import type {
  Color,
  ComputedStyle,
  DomNode,
  DomTree,
  Edges,
  Fragment,
  FragmentId,
  FragmentTree,
  NodeId,
  Px,
} from "@browser-engine/ir";

import { DEFAULT_VIEWPORT_WIDTH, layout, metricsShaper } from "./index.js";

// ---------------------------------------------------------------------------
// IR builders — assemble a frozen DomTree and a ComputedStyle table by hand
// (mirrors index.test.ts; kept local so this file is self-contained).
// ---------------------------------------------------------------------------

interface NodeSpec {
  readonly id: number;
  readonly kind: DomNode["kind"];
  readonly tag?: string;
  readonly text?: string;
  readonly children?: readonly number[];
  readonly parent: number | null;
  readonly attrs?: Readonly<Record<string, string>>;
}

/** Build a frozen DomTree from a flat list of node specs (root id 0). */
function buildDom(specs: readonly NodeSpec[]): DomTree {
  const nodes = new Map<NodeId, DomNode>();
  for (const spec of specs) {
    const base = {
      id: nodeId(spec.id),
      kind: spec.kind,
      children: (spec.children ?? []).map(nodeId),
      parent: spec.parent === null ? null : nodeId(spec.parent),
    };
    let node: DomNode;
    if (spec.kind === "element") {
      node = {
        ...base,
        tag: spec.tag ?? "",
        attrs: new Map<string, string>(Object.entries(spec.attrs ?? {})),
      };
    } else if (spec.kind === "text" || spec.kind === "comment") {
      node = { ...base, text: spec.text ?? "" };
    } else {
      node = base;
    }
    nodes.set(node.id, node);
  }
  return deepFreeze({ root: nodeId(0), nodes } as unknown as DomTree);
}

const BLACK: Color = { r: 0, g: 0, b: 0, a: 1 };
const RED: Color = { r: 255, g: 0, b: 0, a: 1 };
const BLUE: Color = { r: 0, g: 0, b: 255, a: 1 };
const TRANSPARENT: Color = { r: 0, g: 0, b: 0, a: 0 };
const ZERO_EDGES: Edges<Px> = { top: px(0), right: px(0), bottom: px(0), left: px(0) };

/**
 * Per-node style overrides. The Phase 1 fields are typed; the advanced layout
 * properties (display:table keyword, position/float/insets, flex-direction,
 * grid-template-columns) ride on the open index signature exactly as the
 * defensive layout readers consume them, since the generator does not yet emit
 * them as typed fields.
 */
interface StyleSpec {
  readonly display?: string;
  readonly width?: number | "auto";
  readonly height?: number | "auto";
  readonly aspectRatio?: string;
  readonly margin?: Edges<Px>;
  readonly fontSize?: number;
  // Advanced (open index signature) — read defensively by the layout branches.
  readonly position?: string;
  readonly float?: string;
  readonly overflow?: string;
  readonly top?: number;
  readonly right?: number;
  readonly bottom?: number;
  readonly left?: number;
  readonly "flex-direction"?: string;
  readonly "justify-content"?: string;
  readonly "align-items"?: string;
  readonly "align-self"?: string;
  readonly "align-content"?: string;
  readonly "flex-wrap"?: string;
  readonly "flex-grow"?: number;
  readonly "flex-shrink"?: number;
  readonly "flex-basis"?: number | string;
  readonly gap?: string | number;
  readonly "grid-template-columns"?: number | string | readonly unknown[];
  readonly "grid-template-rows"?: number | string | readonly unknown[];
  readonly "grid-auto-flow"?: string;
  readonly "grid-auto-rows"?: string;
  readonly "grid-auto-columns"?: string;
  readonly "grid-column"?: string;
  readonly "grid-row"?: string;
  readonly "grid-area"?: string;
  readonly "grid-template-areas"?: string;
  readonly "justify-items"?: string;
  readonly "justify-self"?: string;
  readonly "border-collapse"?: string;
  readonly "border-spacing"?: string;
  readonly "table-layout"?: string;
  readonly "caption-side"?: string;
  readonly padding?: Edges<Px>;
  readonly border?: Edges<Px>;
  readonly zIndex?: number;
  readonly transform?: readonly number[];
  readonly textIndent?: number | string;
  readonly whiteSpace?: string;
  readonly verticalAlign?: string;
  readonly direction?: string;
  readonly writingMode?: string;
  readonly marginTop?: number | "auto";
  readonly marginRight?: number | "auto";
  readonly marginBottom?: number | "auto";
  readonly marginLeft?: number | "auto";
  /** `::first-letter` computed font-size in px, the field the cascade stores. */
  readonly firstLetterFontSize?: number;
  /** `::first-line` computed font-size in px, the field the cascade stores. */
  readonly firstLineFontSize?: number;
  readonly firstLetterColor?: Color;
  readonly firstLineColor?: Color;
  readonly firstLetterFloat?: "left" | "right";
  readonly firstLetterFontWeight?: number;
  readonly firstLineFontWeight?: number;
  readonly firstLetterFontStyle?: "normal" | "italic" | "oblique";
  readonly firstLineFontStyle?: "normal" | "italic" | "oblique";
  readonly firstLetterTextTransform?: "uppercase" | "lowercase" | "capitalize";
  readonly firstLineTextTransform?: "uppercase" | "lowercase" | "capitalize";
  readonly firstLetterWordSpacing?: number;
  readonly firstLineWordSpacing?: number;
  readonly firstLetterLineHeight?: number;
  readonly firstLineLineHeight?: number;
  readonly firstLetterVerticalAlign?: string;
  readonly firstLetterTextDecoration?: { line: "underline" | "overline" | "line-through"; color?: Color };
  readonly firstLineTextDecoration?: { line: "underline" | "overline" | "line-through"; color?: Color };
  readonly firstLetterLetterSpacing?: number;
  readonly firstLineLetterSpacing?: number;
  readonly firstLetterMargin?: { top: number; right: number; bottom: number; left: number };
  readonly firstLetterPadding?: { top: number; right: number; bottom: number; left: number };
  readonly firstLetterBorder?: {
    top: LetterBorderEdgeSpec;
    right: LetterBorderEdgeSpec;
    bottom: LetterBorderEdgeSpec;
    left: LetterBorderEdgeSpec;
  };
  readonly firstLetterBackgroundColor?: Color;
  readonly firstLineBackgroundColor?: Color;
  readonly firstLetterBackgroundImage?: {
    image: string;
    repeat: string;
    size: string;
    position: string;
  };
  readonly firstLineBackgroundImage?: {
    image: string;
    repeat: string;
    size: string;
    position: string;
  };
}

interface LetterBorderEdgeSpec {
  width: number;
  style: "none" | "solid" | "dashed" | "dotted" | "double";
  color: Color;
}

/** Build a frozen, geometry-free ComputedStyle from a partial spec. */
function makeStyle(spec: StyleSpec = {}): ComputedStyle {
  const style: Record<string, unknown> = {
    display: spec.display ?? "inline",
    color: BLACK,
    fontSize: px(spec.fontSize ?? 16),
    margin: spec.margin ?? ZERO_EDGES,
    width: spec.width ?? "auto",
    height: spec.height ?? "auto",
    backgroundColor: TRANSPARENT,
  };
  if (spec.aspectRatio !== undefined) style["aspectRatio"] = spec.aspectRatio;
  // Attach advanced properties only when supplied, so the "default path" tests
  // carry exactly the Phase 1 property set the real cascade emits.
  if (spec.position !== undefined) style["position"] = spec.position;
  if (spec.float !== undefined) style["float"] = spec.float;
  if (spec.overflow !== undefined) style["overflow"] = spec.overflow;
  if (spec.top !== undefined) style["top"] = spec.top;
  if (spec.right !== undefined) style["right"] = spec.right;
  if (spec.bottom !== undefined) style["bottom"] = spec.bottom;
  if (spec.left !== undefined) style["left"] = spec.left;
  // The layout engine now reads the GENERATED camelCase fields (the names the
  // real cascade produces), so the synthetic style must use them too.
  if (spec["flex-direction"] !== undefined) style["flexDirection"] = spec["flex-direction"];
  if (spec["justify-content"] !== undefined) style["justifyContent"] = spec["justify-content"];
  if (spec["align-items"] !== undefined) style["alignItems"] = spec["align-items"];
  if (spec["flex-wrap"] !== undefined) style["flexWrap"] = spec["flex-wrap"];
  if (spec["align-self"] !== undefined) style["alignSelf"] = spec["align-self"];
  if (spec["align-content"] !== undefined) style["alignContent"] = spec["align-content"];
  if (spec["flex-grow"] !== undefined) style["flexGrow"] = spec["flex-grow"];
  if (spec["flex-shrink"] !== undefined) style["flexShrink"] = spec["flex-shrink"];
  if (spec["flex-basis"] !== undefined) style["flexBasis"] = spec["flex-basis"];
  if (spec.gap !== undefined) style["gap"] = spec.gap;
  if (spec["grid-template-columns"] !== undefined) {
    style["gridTemplateColumns"] = spec["grid-template-columns"];
  }
  if (spec["grid-template-rows"] !== undefined) style["gridTemplateRows"] = spec["grid-template-rows"];
  if (spec["grid-auto-flow"] !== undefined) style["gridAutoFlow"] = spec["grid-auto-flow"];
  if (spec["grid-auto-rows"] !== undefined) style["gridAutoRows"] = spec["grid-auto-rows"];
  if (spec["grid-auto-columns"] !== undefined) style["gridAutoColumns"] = spec["grid-auto-columns"];
  if (spec["grid-column"] !== undefined) style["gridColumn"] = spec["grid-column"];
  if (spec["grid-row"] !== undefined) style["gridRow"] = spec["grid-row"];
  if (spec["grid-area"] !== undefined) style["gridArea"] = spec["grid-area"];
  if (spec["grid-template-areas"] !== undefined) style["gridTemplateAreas"] = spec["grid-template-areas"];
  if (spec["justify-items"] !== undefined) style["justifyItems"] = spec["justify-items"];
  if (spec["justify-self"] !== undefined) style["justifySelf"] = spec["justify-self"];
  if (spec["border-collapse"] !== undefined) style["borderCollapse"] = spec["border-collapse"];
  if (spec["border-spacing"] !== undefined) style["borderSpacing"] = spec["border-spacing"];
  if (spec["table-layout"] !== undefined) style["tableLayout"] = spec["table-layout"];
  if (spec["caption-side"] !== undefined) style["captionSide"] = spec["caption-side"];
  if (spec.padding !== undefined) style["padding"] = spec.padding;
  if (spec.border !== undefined) style["border"] = spec.border;
  if (spec.zIndex !== undefined) style["zIndex"] = spec.zIndex;
  if (spec.transform !== undefined) style["transform"] = spec.transform;
  if (spec.textIndent !== undefined) style["textIndent"] = spec.textIndent;
  if (spec.whiteSpace !== undefined) style["whiteSpace"] = spec.whiteSpace;
  if (spec.verticalAlign !== undefined) style["verticalAlign"] = spec.verticalAlign;
  if (spec.direction !== undefined) style["direction"] = spec.direction;
  if (spec.writingMode !== undefined) style["writingMode"] = spec.writingMode;
  if (spec.marginTop !== undefined) style["marginTop"] = spec.marginTop;
  if (spec.marginRight !== undefined) style["marginRight"] = spec.marginRight;
  if (spec.marginBottom !== undefined) style["marginBottom"] = spec.marginBottom;
  if (spec.marginLeft !== undefined) style["marginLeft"] = spec.marginLeft;
  if (spec.firstLetterFontSize !== undefined) style["firstLetterFontSize"] = spec.firstLetterFontSize;
  if (spec.firstLineFontSize !== undefined) style["firstLineFontSize"] = spec.firstLineFontSize;
  if (spec.firstLetterColor !== undefined) style["firstLetterColor"] = spec.firstLetterColor;
  if (spec.firstLineColor !== undefined) style["firstLineColor"] = spec.firstLineColor;
  if (spec.firstLetterFloat !== undefined) style["firstLetterFloat"] = spec.firstLetterFloat;
  if (spec.firstLetterFontWeight !== undefined) style["firstLetterFontWeight"] = spec.firstLetterFontWeight;
  if (spec.firstLineFontWeight !== undefined) style["firstLineFontWeight"] = spec.firstLineFontWeight;
  if (spec.firstLetterFontStyle !== undefined) style["firstLetterFontStyle"] = spec.firstLetterFontStyle;
  if (spec.firstLineFontStyle !== undefined) style["firstLineFontStyle"] = spec.firstLineFontStyle;
  if (spec.firstLetterTextTransform !== undefined) style["firstLetterTextTransform"] = spec.firstLetterTextTransform;
  if (spec.firstLineTextTransform !== undefined) style["firstLineTextTransform"] = spec.firstLineTextTransform;
  if (spec.firstLetterWordSpacing !== undefined) style["firstLetterWordSpacing"] = spec.firstLetterWordSpacing;
  if (spec.firstLineWordSpacing !== undefined) style["firstLineWordSpacing"] = spec.firstLineWordSpacing;
  if (spec.firstLetterLineHeight !== undefined) style["firstLetterLineHeight"] = spec.firstLetterLineHeight;
  if (spec.firstLineLineHeight !== undefined) style["firstLineLineHeight"] = spec.firstLineLineHeight;
  if (spec.firstLetterVerticalAlign !== undefined) style["firstLetterVerticalAlign"] = spec.firstLetterVerticalAlign;
  if (spec.firstLetterTextDecoration !== undefined) style["firstLetterTextDecoration"] = spec.firstLetterTextDecoration;
  if (spec.firstLineTextDecoration !== undefined) style["firstLineTextDecoration"] = spec.firstLineTextDecoration;
  if (spec.firstLetterLetterSpacing !== undefined) style["firstLetterLetterSpacing"] = spec.firstLetterLetterSpacing;
  if (spec.firstLineLetterSpacing !== undefined) style["firstLineLetterSpacing"] = spec.firstLineLetterSpacing;
  if (spec.firstLetterMargin !== undefined) style["firstLetterMargin"] = spec.firstLetterMargin;
  if (spec.firstLetterPadding !== undefined) style["firstLetterPadding"] = spec.firstLetterPadding;
  if (spec.firstLetterBorder !== undefined) style["firstLetterBorder"] = spec.firstLetterBorder;
  if (spec.firstLetterBackgroundColor !== undefined) style["firstLetterBackgroundColor"] = spec.firstLetterBackgroundColor;
  if (spec.firstLineBackgroundColor !== undefined) style["firstLineBackgroundColor"] = spec.firstLineBackgroundColor;
  if (spec.firstLetterBackgroundImage !== undefined) style["firstLetterBackgroundImage"] = spec.firstLetterBackgroundImage;
  if (spec.firstLineBackgroundImage !== undefined) style["firstLineBackgroundImage"] = spec.firstLineBackgroundImage;
  return deepFreeze(style as unknown as ComputedStyle);
}

/** Make a `computedStyleOf` callback from a per-node style map (default: initial). */
function styleTable(map: ReadonlyMap<number, ComputedStyle>): (node: NodeId) => ComputedStyle {
  const fallback = makeStyle();
  return (node: NodeId) => map.get(node) ?? fallback;
}

/** The fragment whose back-reference is `node` (or undefined). */
function fragmentOf(tree: FragmentTree, node: NodeId): Fragment | undefined {
  for (const frag of tree.fragments.values()) {
    if (frag.node === node) return frag;
  }
  return undefined;
}

/** The FragmentId whose back-reference is `node`. */
function fragmentIdOf(tree: FragmentTree, node: NodeId): FragmentId {
  for (const [id, frag] of tree.fragments) {
    if (frag.node === node) return id;
  }
  throw new Error(`no fragment for node ${Number(node)}`);
}

/** Assert the whole FragmentTree is deep-frozen (Req 3.2). */
function assertFrozenTree(tree: FragmentTree): void {
  assert.ok(Object.isFrozen(tree));
  assert.ok(Object.isFrozen(tree.fragments));
  for (const frag of tree.fragments.values()) {
    assert.ok(Object.isFrozen(frag));
    assert.ok(Object.isFrozen(frag.box));
    assert.ok(Object.isFrozen(frag.box.borderBox));
    assert.ok(Object.isFrozen(frag.box.marginBox));
    assert.ok(Object.isFrozen(frag.children));
  }
}

// ===========================================================================
// FLEX (display:flex) — Req 16.1
// ===========================================================================

void test("display:-webkit-box is normalized to flex layout (legacy flexbox mapping)", () => {
  // -webkit-box must behave as flex: children flow along the main axis, not stack
  // vertically as block. This is the modern-browser mapping for old flexbox.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "-webkit-box", width: 200, height: 40 })],
      [2, makeStyle({ display: "block", width: 60, height: 40 })],
      [3, makeStyle({ display: "block", width: 60, height: 40 })],
    ]),
  );
  const tree = layout(dom, styles);
  const flex = fragmentOf(tree, nodeId(1))!;
  const kids = flex.children.map((id) => tree.fragments.get(id)!);
  // Flex row: second item follows the first along x (not below it on y).
  assert.ok(Number(kids[1]!.box.borderBox.x) >= Number(kids[0]!.box.borderBox.x), "-webkit-box children flow horizontally");
  assert.equal(Number(kids[1]!.box.borderBox.y), Number(kids[0]!.box.borderBox.y), "-webkit-box children share the same line");
});

void test("display:inline-flex is normalized to flex layout (inner layout preserved)", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "inline-flex", width: 200, height: 40 })],
      [2, makeStyle({ display: "block", width: 50, height: 40 })],
      [3, makeStyle({ display: "block", width: 50, height: 40 })],
    ]),
  );
  const tree = layout(dom, styles);
  const flex = fragmentOf(tree, nodeId(1))!;
  const kids = flex.children.map((id) => tree.fragments.get(id)!);
  // inline-flex children still flow along the flex main axis.
  assert.equal(Number(kids[1]!.box.borderBox.y), Number(kids[0]!.box.borderBox.y), "inline-flex children share the same line");
});

void test("flex row lays children along the MAIN axis with monotonic x and shared widths (Req 16.1)", () => {
  // document → flex(1) { a(2), b(3), c(4) } — empty items, flex-grow 1 ⇒ equal thirds.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3, 4] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 4, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "flex", width: 300, height: 50 })],
      [2, makeStyle({ display: "block", height: 20, "flex-grow": 1 })],
      [3, makeStyle({ display: "block", height: 30, "flex-grow": 1 })],
      [4, makeStyle({ display: "block", height: 10, "flex-grow": 1 })],
    ]),
  );

  const tree = layout(dom, styles);
  const flex = fragmentOf(tree, nodeId(1))!;
  const kids = flex.children.map((id) => tree.fragments.get(id)!);
  assert.equal(kids.length, 3);

  // Three empty items with flex-grow 1 share 300px equally ⇒ 100px each.
  for (const kid of kids) {
    assert.equal(kid.box.width, px(100));
  }
  // Laid along the main (x) axis: x increases by each item's width; all at y=0.
  assert.equal(kids[0]!.box.borderBox.x, px(0));
  assert.equal(kids[1]!.box.borderBox.x, px(100));
  assert.equal(kids[2]!.box.borderBox.x, px(200));
  for (const kid of kids) {
    assert.equal(kid.box.borderBox.y, px(0), "row items align to the cross-start edge");
  }
});

void test("flex row keeps a declared-width item fixed and shares the rest among flexible items", () => {
  // a(2) is 120px fixed; b(3)/c(4) grow ⇒ split the remaining 180px ⇒ 90 each.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3, 4] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 4, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "flex", width: 300 })],
      [2, makeStyle({ display: "block", width: 120, height: 10 })],
      [3, makeStyle({ display: "block", height: 10, "flex-grow": 1 })],
      [4, makeStyle({ display: "block", height: 10, "flex-grow": 1 })],
    ]),
  );

  const tree = layout(dom, styles);
  const flex = fragmentOf(tree, nodeId(1))!;
  const kids = flex.children.map((id) => tree.fragments.get(id)!);

  assert.equal(kids[0]!.box.width, px(120), "fixed item keeps its declared width");
  assert.equal(kids[1]!.box.width, px(90), "flexible items split the remaining 180px");
  assert.equal(kids[2]!.box.width, px(90));
  // Packed along the main axis with no overlap.
  assert.equal(kids[0]!.box.borderBox.x, px(0));
  assert.equal(kids[1]!.box.borderBox.x, px(120));
  assert.equal(kids[2]!.box.borderBox.x, px(210));
});

void test("flex column stacks children along the vertical main axis (monotonic y)", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "flex", "flex-direction": "column", width: 200 })],
      [2, makeStyle({ display: "block", height: 40 })],
      [3, makeStyle({ display: "block", height: 60 })],
    ]),
  );

  const tree = layout(dom, styles);
  const flex = fragmentOf(tree, nodeId(1))!;
  const kids = flex.children.map((id) => tree.fragments.get(id)!);

  assert.equal(kids[0]!.box.borderBox.y, px(0));
  assert.equal(kids[1]!.box.borderBox.y, px(40), "second item stacks below the first");
  // Column main-axis height is the sum of the items' heights.
  assert.equal(flex.box.height, px(100));
});

// ===========================================================================
// FLEX justify-content / align-items
// ===========================================================================

void test("flex row justify-content:center centers the items along the main axis", () => {
  // 300px container, two 60px fixed items ⇒ 180px free ⇒ 90px leading offset.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "flex", "justify-content": "center", width: 300, height: 50 })],
      [2, makeStyle({ display: "block", width: 60, height: 50 })],
      [3, makeStyle({ display: "block", width: 60, height: 50 })],
    ]),
  );
  const tree = layout(dom, styles);
  const flex = fragmentOf(tree, nodeId(1))!;
  const kids = flex.children.map((id) => tree.fragments.get(id)!);
  assert.equal(kids[0]!.box.borderBox.x, px(90), "first item starts at the centered leading offset");
  assert.equal(kids[1]!.box.borderBox.x, px(150), "second item follows with no extra gap");
});

void test("flex row justify-content:flex-end packs items to the main-end edge", () => {
  // 300px container, two 60px items ⇒ 180px free ⇒ leading offset 180.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "flex", "justify-content": "flex-end", width: 300, height: 50 })],
      [2, makeStyle({ display: "block", width: 60, height: 50 })],
      [3, makeStyle({ display: "block", width: 60, height: 50 })],
    ]),
  );
  const tree = layout(dom, styles);
  const flex = fragmentOf(tree, nodeId(1))!;
  const kids = flex.children.map((id) => tree.fragments.get(id)!);
  assert.equal(kids[0]!.box.borderBox.x, px(180));
  assert.equal(kids[1]!.box.borderBox.x, px(240));
});

void test("flex row justify-content:space-between distributes gaps between items only", () => {
  // 300px container, three 60px items ⇒ 120px free / 2 gaps ⇒ 60px between.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3, 4] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 4, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "flex", "justify-content": "space-between", width: 300, height: 50 })],
      [2, makeStyle({ display: "block", width: 60, height: 50 })],
      [3, makeStyle({ display: "block", width: 60, height: 50 })],
      [4, makeStyle({ display: "block", width: 60, height: 50 })],
    ]),
  );
  const tree = layout(dom, styles);
  const flex = fragmentOf(tree, nodeId(1))!;
  const kids = flex.children.map((id) => tree.fragments.get(id)!);
  assert.equal(kids[0]!.box.borderBox.x, px(0), "first item at main-start");
  assert.equal(kids[1]!.box.borderBox.x, px(120), "middle item after the first gap");
  assert.equal(kids[2]!.box.borderBox.x, px(240), "last item at main-end");
});

void test("flex row align-items:center centers items on the cross axis", () => {
  // 300px×60px container; items are 40px tall ⇒ 20px slack ⇒ 10px top offset.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "flex", "align-items": "center", width: 300, height: 60 })],
      [2, makeStyle({ display: "block", width: 60, height: 40 })],
    ]),
  );
  const tree = layout(dom, styles);
  const flex = fragmentOf(tree, nodeId(1))!;
  const kids = flex.children.map((id) => tree.fragments.get(id)!);
  assert.equal(kids[0]!.box.borderBox.y, px(10), "item centered on the cross axis");
});

void test("flex row align-items:flex-end aligns items to the cross-end edge", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "flex", "align-items": "flex-end", width: 300, height: 60 })],
      [2, makeStyle({ display: "block", width: 60, height: 40 })],
    ]),
  );
  const tree = layout(dom, styles);
  const flex = fragmentOf(tree, nodeId(1))!;
  const kids = flex.children.map((id) => tree.fragments.get(id)!);
  assert.equal(kids[0]!.box.borderBox.y, px(20), "item pushed to the cross-end edge");
});

void test("flex row defaults to justify-content:flex-start and align-items:flex-start", () => {
  // No justify/align declared ⇒ items pack at main-start, align to cross-start.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "flex", width: 300, height: 60 })],
      [2, makeStyle({ display: "block", width: 60, height: 40 })],
    ]),
  );
  const tree = layout(dom, styles);
  const flex = fragmentOf(tree, nodeId(1))!;
  const kids = flex.children.map((id) => tree.fragments.get(id)!);
  assert.equal(kids[0]!.box.borderBox.x, px(0), "default packs at main-start");
  assert.equal(kids[0]!.box.borderBox.y, px(0), "default aligns to cross-start");
});


void test("flex-basis overrides the declared width as the flex base (§9.2)", () => {
  // width:60 + flex-basis:20 → the BASE is 20; free 300−60−(no grow) stays.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "flex", width: 300, height: 50 })],
      [2, makeStyle({ display: "block", width: 60, height: 30, "flex-basis": 20 })],
      [3, makeStyle({ display: "block", height: 30, "flex-basis": 100 })],
    ]),
  );
  const tree = layout(dom, styles);
  const kids = fragmentOf(tree, nodeId(1))!.children.map((id) => tree.fragments.get(id)!);
  assert.equal(Number(kids[0]!.box.borderBox.width), 20, "basis wins over width");
  assert.equal(Number(kids[1]!.box.borderBox.width), 100, "basis is the base size");
  assert.equal(Number(kids[1]!.box.borderBox.x), 20, "packed at base1");
});

void test("flex-grow distributes free space by factor over the basis", () => {
  // bases 50+50=100, free 200 ⇒ grow 3:1 → 150+50 added ⇒ 200 + 100.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "flex", width: 300, height: 50 })],
      [2, makeStyle({ display: "block", width: 50, height: 30, "flex-grow": 3 })],
      [3, makeStyle({ display: "block", width: 50, height: 30, "flex-grow": 1 })],
    ]),
  );
  const tree = layout(dom, styles);
  const kids = fragmentOf(tree, nodeId(1))!.children.map((id) => tree.fragments.get(id)!);
  assert.equal(Number(kids[0]!.box.borderBox.width), 200, "50 + 3/4·200");
  assert.equal(Number(kids[1]!.box.borderBox.width), 100, "50 + 1/4·200");
  assert.equal(Number(kids[1]!.box.borderBox.x), 200);
});

void test("flex-shrink:0 keeps the item at its base even when the line overflows", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "flex", width: 100, height: 50 })],
      [2, makeStyle({ display: "block", width: 80, height: 30, "flex-shrink": 0 })],
      [3, makeStyle({ display: "block", width: 80, height: 30 })],
    ]),
  );
  const tree = layout(dom, styles);
  const kids = fragmentOf(tree, nodeId(1))!.children.map((id) => tree.fragments.get(id)!);
  assert.equal(Number(kids[0]!.box.borderBox.width), 80, "shrink:0 is unshrinkable");
  assert.equal(Number(kids[1]!.box.borderBox.width), 20, "overflow lands entirely on the shrinkable item");
  assert.equal(Number(kids[1]!.box.borderBox.x), 80);
});

void test("flex-direction:row-reverse mirrors the packed main axis", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "flex", "flex-direction": "row-reverse", width: 300 })],
      [2, makeStyle({ display: "block", width: 60, height: 30 })],
      [3, makeStyle({ display: "block", width: 60, height: 30 })],
    ]),
  );
  const tree = layout(dom, styles);
  const kids = fragmentOf(tree, nodeId(1))!.children.map((id) => tree.fragments.get(id)!);
  assert.equal(Number(kids[0]!.box.borderBox.x), 240, "first item packed at main-end");
  assert.equal(Number(kids[1]!.box.borderBox.x), 180, "second to its left");
});

void test("align-self overrides the container's align-items for one item", () => {
  // Container align-items:flex-start; item2 align-self:flex-end → it drops to
  // the line bottom while its sibling stays at the top.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "flex", width: 300, height: 60 })],
      [2, makeStyle({ display: "block", width: 60, height: 20 })],
      [3, makeStyle({ display: "block", width: 60, height: 20, "align-self": "flex-end" })],
    ]),
  );
  const tree = layout(dom, styles);
  const kids = fragmentOf(tree, nodeId(1))!.children.map((id) => tree.fragments.get(id)!);
  assert.equal(Number(kids[0]!.box.borderBox.y), 0, "item1 at cross-start");
  assert.equal(Number(kids[1]!.box.borderBox.y), 40, "item2 at cross-end (60−20)");
});

void test("align-items:stretch re-lays a height-auto item at the line cross size", () => {
  // item2 has NO height ⇒ stretch fills it to the line height (the tallest
  // sibling's 50px — single line in a definite 80px container ⇒ line = 80).
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "flex", "align-items": "stretch", width: 300, height: 80 })],
      [2, makeStyle({ display: "block", width: 60, height: 40 })],
      [3, makeStyle({ display: "block", width: 60 })],
    ]),
  );
  const tree = layout(dom, styles);
  const kids = fragmentOf(tree, nodeId(1))!.children.map((id) => tree.fragments.get(id)!);
  assert.equal(Number(kids[1]!.box.borderBox.height), 80, "height:auto stretched to the (definite) line cross");
  assert.equal(Number(kids[0]!.box.borderBox.height), 40, "declared-height item keeps its size");
});

void test("align-content:space-between separates wrapped lines in a definite cross", () => {
  // 2 lines of 20px in a 100px container ⇒ 60px free between them.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3, 4] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 4, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "flex", "flex-wrap": "wrap", "align-content": "space-between", width: 130, height: 100 })],
      [2, makeStyle({ display: "block", width: 60, height: 20 })],
      [3, makeStyle({ display: "block", width: 60, height: 20 })],
      [4, makeStyle({ display: "block", width: 60, height: 20 })],
    ]),
  );
  const tree = layout(dom, styles);
  const kids = fragmentOf(tree, nodeId(1))!.children.map((id) => tree.fragments.get(id)!);
  assert.equal(Number(kids[0]!.box.borderBox.y), 0, "line1 at top");
  assert.equal(Number(kids[2]!.box.borderBox.y), 80, "line2 pushed to the bottom (20+60 free)");
});

// ===========================================================================
// FLEX wrap (multiple lines)
// ===========================================================================

void test("flex-wrap:wrap moves items that overflow the main axis to a new line", () => {
  // 200px container, three 90px items (fixed) + 10px gap ⇒ 90+10+90=190 fits,
  // 90+10+90+10+90=290 overflows ⇒ third item wraps to line 2.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3, 4] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 4, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "flex", "flex-wrap": "wrap", gap: "10px", width: 200, height: 50 })],
      [2, makeStyle({ display: "block", width: 90, height: 30 })],
      [3, makeStyle({ display: "block", width: 90, height: 30 })],
      [4, makeStyle({ display: "block", width: 90, height: 30 })],
    ]),
  );
  const tree = layout(dom, styles);
  const flex = fragmentOf(tree, nodeId(1))!;
  const kids = flex.children.map((id) => tree.fragments.get(id)!);
  assert.equal(Number(kids[0]!.box.borderBox.x), 0, "first item at line 1 start");
  assert.equal(Number(kids[1]!.box.borderBox.x), 100, "second item after 90px + 10px gap");
  assert.equal(Number(kids[1]!.box.borderBox.y), 0, "first line at y=0");
  assert.equal(Number(kids[2]!.box.borderBox.x), 0, "third item wraps to line 2 start");
  assert.equal(Number(kids[2]!.box.borderBox.y), 40, "line 2 = line1 height (30) + row gap (10)");
});

void test("flex-wrap:wrap adds the row gap between lines", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3, 4] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 4, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  // Two lines with a 15px row gap (gap: "15px" = both column and row gaps).
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "flex", "flex-wrap": "wrap", gap: "15px", width: 120, height: 50 })],
      [2, makeStyle({ display: "block", width: 60, height: 20 })],
      [3, makeStyle({ display: "block", width: 60, height: 20 })],
      [4, makeStyle({ display: "block", width: 60, height: 20 })],
    ]),
  );
  const tree = layout(dom, styles);
  const flex = fragmentOf(tree, nodeId(1))!;
  const kids = flex.children.map((id) => tree.fragments.get(id)!);
  // line1: item0(60) + 15 gap + item1(60) = 135 > 120 ⇒ item1 wraps to line 2.
  assert.equal(Number(kids[0]!.box.borderBox.y), 0, "first line at y=0");
  assert.equal(Number(kids[1]!.box.borderBox.y), 35, "line 2 = line1 height (20) + row gap (15)");
});

void test("flex-wrap:wrap resolves align-items against each LINE's height", () => {
  // 130px container, 60px items with a 10px gap:
  //   line1 = [item0(h40), item1(h20)] (60+10+60=130 fits exactly).
  //   line2 = [item2(h20)] (next would be 130+10+60>130).
  // With align-items:center, item1 centers within line1's height (40): offset 10.
  // item2 centers within line2's own height (20): offset 0.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3, 4] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 4, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "flex", "flex-wrap": "wrap", "align-items": "center", gap: "10px", width: 130, height: 60 })],
      [2, makeStyle({ display: "block", width: 60, height: 40 })],
      [3, makeStyle({ display: "block", width: 60, height: 20 })],
      [4, makeStyle({ display: "block", width: 60, height: 20 })],
    ]),
  );
  const tree = layout(dom, styles);
  const flex = fragmentOf(tree, nodeId(1))!;
  const kids = flex.children.map((id) => tree.fragments.get(id)!);
  assert.equal(Number(kids[1]!.box.borderBox.y), 10, "20px item centered within line1's 40px height");
  assert.equal(Number(kids[0]!.box.borderBox.y), 0, "40px item fills line1's height (no slack)");
  assert.equal(Number(kids[2]!.box.borderBox.y), 50, "line2 starts at line1 height (40) + row gap (10)");
  assert.equal(Number(kids[2]!.box.borderBox.x), 0, "line2 first item at main-start");
});

void test("flex-wrap:nowrap (the default) keeps items on ONE line — flex-shrink makes them fit", () => {
  // No flex-wrap declared ⇒ no second line; overflow resolves by flex-shrink
  // (initial 1, spec §9.7): 80+80+10gap=170 in a 100px container ⇒ −70 shared
  // equally (equal scaled factors) ⇒ each item shrinks 35 to 45px.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "flex", gap: "10px", width: 100, height: 50 })],
      [2, makeStyle({ display: "block", width: 80, height: 30 })],
      [3, makeStyle({ display: "block", width: 80, height: 30 })],
    ]),
  );
  const tree = layout(dom, styles);
  const flex = fragmentOf(tree, nodeId(1))!;
  const kids = flex.children.map((id) => tree.fragments.get(id)!);
  assert.equal(Number(kids[0]!.box.borderBox.y), Number(kids[1]!.box.borderBox.y), "no wrap ⇒ same line");
  assert.equal(Number(kids[0]!.box.borderBox.width), 45, "item1 shrunk 80→45 (scaled factor share)");
  assert.equal(Number(kids[1]!.box.borderBox.width), 45, "item2 shrunk 80→45");
  assert.equal(Number(kids[1]!.box.borderBox.x), 55, "item2 at 45+10gap — the line now fits exactly");
});

void test("flex-direction:column with flex-wrap:wrap packs overflow onto the next column", () => {
  // Main axis is the 200px height. Three 90px items + 10px gap:
  // 90+10+90=190 fits the first column, the third item starts column 2.
  // Cross size is exact (30+10+30), so align-content has no free space.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3, 4] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 4, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({
        display: "flex",
        "flex-direction": "column",
        "flex-wrap": "wrap",
        "align-content": "flex-start",
        gap: "10px",
        width: 70,
        height: 200,
      })],
      [2, makeStyle({ display: "block", width: 30, height: 90 })],
      [3, makeStyle({ display: "block", width: 30, height: 90 })],
      [4, makeStyle({ display: "block", width: 30, height: 90 })],
    ]),
  );
  const tree = layout(dom, styles);
  const kids = fragmentOf(tree, nodeId(1))!.children.map((id) => tree.fragments.get(id)!);
  assert.equal(Number(kids[0]!.box.borderBox.x), 0, "first column at x=0");
  assert.equal(Number(kids[0]!.box.borderBox.y), 0, "first item at the column start");
  assert.equal(Number(kids[1]!.box.borderBox.x), 0, "second item stays in column 1");
  assert.equal(Number(kids[1]!.box.borderBox.y), 100, "second item after 90px + 10px gap");
  assert.equal(Number(kids[2]!.box.borderBox.x), 40, "third item starts column 2 (30px + 10px gap)");
  assert.equal(Number(kids[2]!.box.borderBox.y), 0, "wrapped item returns to the main start");
});

void test("column flex-wrap:wrap-reverse packs later columns toward the cross start", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3, 4] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 4, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({
        display: "flex",
        "flex-direction": "column",
        "flex-wrap": "wrap-reverse",
        "align-content": "flex-start",
        gap: "10px",
        width: 70,
        height: 200,
      })],
      [2, makeStyle({ display: "block", width: 30, height: 90 })],
      [3, makeStyle({ display: "block", width: 30, height: 90 })],
      [4, makeStyle({ display: "block", width: 30, height: 90 })],
    ]),
  );
  const tree = layout(dom, styles);
  const kids = fragmentOf(tree, nodeId(1))!.children.map((id) => tree.fragments.get(id)!);
  assert.equal(Number(kids[0]!.box.borderBox.x), 40, "first column sits at the cross end");
  assert.equal(Number(kids[1]!.box.borderBox.x), 40, "second item stays in that column");
  assert.equal(Number(kids[2]!.box.borderBox.x), 0, "next column packs toward the cross start");
  assert.equal(Number(kids[2]!.box.borderBox.y), 0, "wrapped item returns to the main start");
});

void test("column flex-wrap stays one column when the height is indefinite", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3, 4] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 4, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({
        display: "flex",
        "flex-direction": "column",
        "flex-wrap": "wrap",
        gap: "10px",
        width: 70,
      })],
      [2, makeStyle({ display: "block", width: 30, height: 90 })],
      [3, makeStyle({ display: "block", width: 30, height: 90 })],
      [4, makeStyle({ display: "block", width: 30, height: 90 })],
    ]),
  );
  const tree = layout(dom, styles);
  const kids = fragmentOf(tree, nodeId(1))!.children.map((id) => tree.fragments.get(id)!);
  assert.equal(Number(kids[0]!.box.borderBox.x), 0);
  assert.equal(Number(kids[1]!.box.borderBox.x), 0);
  assert.equal(Number(kids[2]!.box.borderBox.x), 0, "no definite height ⇒ no second column");
  assert.equal(Number(kids[2]!.box.borderBox.y), 200, "items keep stacking with the row gap");
});

void test("row flex auto items use the content max-content width as the flex base", () => {
  // Item 2 has no width and flex-grow 0. Its max-content is the 40px child,
  // so it stays 40px and the definite 80px sibling packs right after it.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 4] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [3] },
    { id: 3, kind: "element", tag: "div", parent: 2, children: [] },
    { id: 4, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "flex", width: 300, height: 40 })],
      [2, makeStyle({ display: "block", height: 20 })],
      [3, makeStyle({ display: "block", width: 40, height: 10 })],
      [4, makeStyle({ display: "block", width: 80, height: 20 })],
    ]),
  );
  const tree = layout(dom, styles);
  const kids = fragmentOf(tree, nodeId(1))!.children.map((id) => tree.fragments.get(id)!);
  assert.equal(Number(kids[0]!.box.borderBox.width), 40, "auto item sizes to its content");
  assert.equal(Number(kids[0]!.box.borderBox.x), 0);
  assert.equal(Number(kids[1]!.box.borderBox.width), 80);
  assert.equal(Number(kids[1]!.box.borderBox.x), 40, "definite item packs after the content base");
});

// ===========================================================================
// GRID (display:grid) — Req 16.1
// ===========================================================================

void test("grid places children row-major into equal-width cells (Req 16.1)", () => {
  // 2-column grid of 4 children ⇒ a 2×2 arrangement in a 200px container.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3, 4, 5] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 4, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 5, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const cell = makeStyle({ display: "block", height: 25 });
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "grid", width: 200, "grid-template-columns": 2 })],
      [2, cell],
      [3, cell],
      [4, cell],
      [5, cell],
    ]),
  );

  const tree = layout(dom, styles);
  const grid = fragmentOf(tree, nodeId(1))!;
  const cells = grid.children.map((id) => tree.fragments.get(id)!);
  assert.equal(cells.length, 4);

  // Equal cell width = 200 / 2 = 100.
  for (const c of cells) {
    assert.equal(c.box.width, px(100));
  }
  // Row-major placement: (col0,row0)=(0,0) (col1,row0)=(100,0)
  //                      (col0,row1)=(0,25) (col1,row1)=(100,25).
  assert.deepEqual(
    cells.map((c) => [c.box.borderBox.x, c.box.borderBox.y]),
    [
      [px(0), px(0)],
      [px(100), px(0)],
      [px(0), px(25)],
      [px(100), px(25)],
    ],
  );
  // Two rows of height 25 ⇒ content height 50.
  assert.equal(grid.box.height, px(50));
});

void test("grid with a missing track count defaults to a single column", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "grid", width: 150 })], // no grid-template-columns.
      [2, makeStyle({ display: "block", height: 10 })],
      [3, makeStyle({ display: "block", height: 20 })],
    ]),
  );

  const tree = layout(dom, styles);
  const grid = fragmentOf(tree, nodeId(1))!;
  const cells = grid.children.map((id) => tree.fragments.get(id)!);

  // One column ⇒ full-width cells stacked vertically.
  for (const c of cells) {
    assert.equal(c.box.width, px(150));
  }
  assert.equal(cells[0]!.box.borderBox.y, px(0));
  assert.equal(cells[1]!.box.borderBox.y, px(10));
});

void test("grid with fr tracks distributes space proportionally", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      // "1fr 2fr" in 300px → 100px and 200px
      [1, makeStyle({ display: "grid", width: 300, "grid-template-columns": "1fr 2fr" })],
      [2, makeStyle({ display: "block", height: 20 })],
      [3, makeStyle({ display: "block", height: 20 })],
    ]),
  );
  const tree = layout(dom, styles);
  const grid = fragmentOf(tree, nodeId(1))!;
  const kids = grid.children.map((id) => tree.fragments.get(id)!);
  assert.equal(kids[0]!.box.width, px(100), "1fr track = 100px");
  assert.equal(kids[1]!.box.width, px(200), "2fr track = 200px");
});

void test("grid with fixed + fr tracks", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      // "100px 1fr" in 300px → 100px and 200px
      [1, makeStyle({ display: "grid", width: 300, "grid-template-columns": "100px 1fr" })],
      [2, makeStyle({ display: "block", height: 20 })],
      [3, makeStyle({ display: "block", height: 20 })],
    ]),
  );
  const tree = layout(dom, styles);
  const grid = fragmentOf(tree, nodeId(1))!;
  const kids = grid.children.map((id) => tree.fragments.get(id)!);
  assert.equal(kids[0]!.box.width, px(100), "fixed track = 100px");
  assert.equal(kids[1]!.box.width, px(200), "fr track gets remaining 200px");
});

void test("grid with repeat(3, 1fr) creates 3 equal tracks", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3, 4] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 4, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "grid", width: 300, "grid-template-columns": "repeat(3, 1fr)" })],
      [2, makeStyle({ display: "block", height: 20 })],
      [3, makeStyle({ display: "block", height: 20 })],
      [4, makeStyle({ display: "block", height: 20 })],
    ]),
  );
  const tree = layout(dom, styles);
  const grid = fragmentOf(tree, nodeId(1))!;
  const kids = grid.children.map((id) => tree.fragments.get(id)!);
  for (const kid of kids) {
    assert.equal(kid.box.width, px(100), "each repeat(3, 1fr) track = 100px");
  }
});

void test("repeat(auto-fill, 100px) fits as many columns as the container holds", () => {
  // 320 / 100 = 3 columns. The fourth item wraps to the next row.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3, 4, 5] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 4, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 5, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "grid", width: 320, "grid-template-columns": "repeat(auto-fill, 100px)" })],
      [2, makeStyle({ display: "block", height: 10 })],
      [3, makeStyle({ display: "block", height: 10 })],
      [4, makeStyle({ display: "block", height: 10 })],
      [5, makeStyle({ display: "block", height: 10 })],
    ]),
  );
  const tree = layout(dom, styles);
  const kids = fragmentOf(tree, nodeId(1))!.children.map((id) => tree.fragments.get(id)!);
  assert.equal(Number(kids[0]!.box.borderBox.x), 0);
  assert.equal(Number(kids[1]!.box.borderBox.x), 100);
  assert.equal(Number(kids[2]!.box.borderBox.x), 200);
  assert.equal(Number(kids[2]!.box.borderBox.y), 0, "third item still on the first row");
  assert.equal(Number(kids[3]!.box.borderBox.x), 0, "fourth item wraps");
  assert.equal(Number(kids[3]!.box.borderBox.y), 10);
});

void test("repeat(auto-fit, minmax(100px, 1fr)) collapses empty columns onto the items", () => {
  // 320px fits three 100px minimums. Two items occupy two tracks; the empty
  // one collapses, and the two 1fr tracks split the row.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "grid", width: 320, "grid-template-columns": "repeat(auto-fit, minmax(100px, 1fr))" })],
      [2, makeStyle({ display: "block", height: 10 })],
      [3, makeStyle({ display: "block", height: 10 })],
    ]),
  );
  const tree = layout(dom, styles);
  const kids = fragmentOf(tree, nodeId(1))!.children.map((id) => tree.fragments.get(id)!);
  assert.equal(Number(kids[0]!.box.borderBox.width), 160);
  assert.equal(Number(kids[1]!.box.borderBox.x), 160);
  assert.equal(Number(kids[1]!.box.borderBox.width), 160);
  assert.equal(Number(kids[1]!.box.borderBox.y), 0, "both items stay on the first row");
});

void test("grid-template-areas places named regions and sizes missing columns from the strings", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3, 4] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 4, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({
        display: "grid",
        width: 200,
        "grid-template-areas": "\"header header\" \"side main\"",
      })],
      [2, makeStyle({ display: "block", height: 20, "grid-area": "header" })],
      [3, makeStyle({ display: "block", height: 30, "grid-area": "side" })],
      [4, makeStyle({ display: "block", height: 30, "grid-area": "main" })],
    ]),
  );
  const tree = layout(dom, styles);
  const header = fragmentOf(tree, nodeId(2))!;
  const side = fragmentOf(tree, nodeId(3))!;
  const main = fragmentOf(tree, nodeId(4))!;
  assert.equal(Number(header.box.borderBox.x), 0);
  assert.equal(Number(header.box.borderBox.width), 200, "header spans both columns");
  assert.equal(Number(side.box.borderBox.x), 0);
  assert.equal(Number(side.box.borderBox.y), 20, "side starts under the header");
  assert.equal(Number(side.box.borderBox.width), 100);
  assert.equal(Number(main.box.borderBox.x), 100);
  assert.equal(Number(main.box.borderBox.y), 20);
  assert.equal(Number(main.box.borderBox.width), 100);
});

void test("named grid lines place items with grid-column: name / name", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({
        display: "grid",
        width: 200,
        "grid-template-columns": "[start] 100px [mid] 100px [end]",
      })],
      [2, makeStyle({ display: "block", height: 10, "grid-column": "start / mid" })],
      [3, makeStyle({ display: "block", height: 10, "grid-column": "mid" })],
    ]),
  );
  const tree = layout(dom, styles);
  const kids = fragmentOf(tree, nodeId(1))!.children.map((id) => tree.fragments.get(id)!);
  assert.equal(Number(kids[0]!.box.borderBox.x), 0);
  assert.equal(Number(kids[0]!.box.borderBox.width), 100, "start / mid is the first track");
  assert.equal(Number(kids[1]!.box.borderBox.x), 100, "mid starts the second track");
  assert.equal(Number(kids[1]!.box.borderBox.width), 100);
});

void test("grid-template-columns: subgrid reuses the parent tracks the item spans", () => {
  // Parent columns are 80px with a 10px gap. The child spans columns 2–3,
  // so its subgrid is 80px, the parent's gap, then 80px.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [3, 4] },
    { id: 3, kind: "element", tag: "div", parent: 2, children: [] },
    { id: 4, kind: "element", tag: "div", parent: 2, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({
        display: "grid",
        width: 260,
        "grid-template-columns": "80px 80px 80px",
        gap: "10px",
      })],
      [2, makeStyle({
        display: "grid",
        "grid-column": "2 / span 2",
        "grid-template-columns": "subgrid",
      })],
      [3, makeStyle({ display: "block", height: 10 })],
      [4, makeStyle({ display: "block", height: 10 })],
    ]),
  );
  const tree = layout(dom, styles);
  const sub = fragmentOf(tree, nodeId(2))!;
  const a = fragmentOf(tree, nodeId(3))!;
  const b = fragmentOf(tree, nodeId(4))!;
  assert.equal(Number(sub.box.borderBox.x), 90, "subgrid item starts on the parent's second column");
  assert.equal(Number(sub.box.borderBox.width), 170, "span includes the parent gap between the two tracks");
  assert.equal(Number(a.box.borderBox.x), 0);
  assert.equal(Number(a.box.borderBox.width), 80);
  assert.equal(Number(b.box.borderBox.x), 90, "second subgrid item starts after the inherited gap");
  assert.equal(Number(b.box.borderBox.width), 80);
  assert.equal(Number(b.box.borderBox.y), Number(a.box.borderBox.y), "both items share the subgrid row");
});

void test("grid-template-rows: subgrid reuses the definite parent rows the item spans", () => {
  // Parent rows are 40px and 30px with a 10px gap. The child spans both,
  // so its items are 40px, then the gap, then 30px.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [3, 4] },
    { id: 3, kind: "element", tag: "div", parent: 2, children: [] },
    { id: 4, kind: "element", tag: "div", parent: 2, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({
        display: "grid",
        width: 100,
        "grid-template-columns": "100px",
        "grid-template-rows": "40px 30px",
        gap: "10px",
      })],
      [2, makeStyle({
        display: "grid",
        "grid-row": "1 / span 2",
        "grid-template-rows": "subgrid",
      })],
      [3, makeStyle({ display: "block" })],
      [4, makeStyle({ display: "block" })],
    ]),
  );
  const tree = layout(dom, styles);
  const sub = fragmentOf(tree, nodeId(2))!;
  const a = fragmentOf(tree, nodeId(3))!;
  const b = fragmentOf(tree, nodeId(4))!;
  assert.equal(Number(sub.box.borderBox.height), 80, "span includes the parent row gap");
  assert.equal(Number(a.box.borderBox.y), 0);
  assert.equal(Number(a.box.borderBox.height), 40);
  assert.equal(Number(b.box.borderBox.y), 50, "second item starts after the inherited row gap");
  assert.equal(Number(b.box.borderBox.height), 30);
});


void test("grid-column span 2 places item across two tracks", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3, 4] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 4, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "grid", width: 300, "grid-template-columns": "repeat(4, 1fr)" })],
      [2, makeStyle({ display: "block", height: 40, "grid-column": "span 2", "grid-row": "span 2" })],
      [3, makeStyle({ display: "block", height: 20 })],
      [4, makeStyle({ display: "block", height: 20 })],
    ]),
  );
  const tree = layout(dom, styles);
  const grid = fragmentOf(tree, nodeId(1))!;
  const kids = grid.children.map((id) => tree.fragments.get(id)!);
  const wide = kids.find((k) => k.node === nodeId(2))!;
  assert.equal(wide.box.width, px(150), "span 2 of 4 equal tracks in 300px = 150px");
  assert.equal(wide.box.borderBox.x, px(0));
  assert.equal(wide.box.borderBox.y, px(0));
  const a = kids.find((k) => k.node === nodeId(3))!;
  const b = kids.find((k) => k.node === nodeId(4))!;
  assert.equal(a.box.borderBox.x, px(150), "next item auto-places in column 3");
  assert.equal(a.box.borderBox.y, px(0));
  assert.equal(b.box.borderBox.x, px(225));
  assert.equal(b.box.borderBox.y, px(0));
});

void test("grid-column 1/3 line form spans two columns", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "grid", width: 400, "grid-template-columns": "repeat(4, 1fr)" })],
      [2, makeStyle({ display: "block", height: 30, "grid-column": "1/3", "grid-row": "1/3" })],
      [3, makeStyle({ display: "block", height: 20 })],
    ]),
  );
  const tree = layout(dom, styles);
  const kids = fragmentOf(tree, nodeId(1))!.children.map((id) => tree.fragments.get(id)!);
  const wide = kids.find((k) => k.node === nodeId(2))!;
  assert.equal(wide.box.width, px(200));
  assert.equal(wide.box.borderBox.x, px(0));
  const next = kids.find((k) => k.node === nodeId(3))!;
  assert.equal(next.box.x, px(200));
  assert.equal(next.box.y, px(0));
});

// ===========================================================================
// TABLE (display:table) — Req 16.1
// ===========================================================================

void test("table lays out rows and cells with aligned columns (Req 16.1)", () => {
  // table(1) → row(2){ cell(4), cell(5) }, row(3){ cell(6), cell(7) }.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "table", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "tr", parent: 1, children: [4, 5] },
    { id: 3, kind: "element", tag: "tr", parent: 1, children: [6, 7] },
    { id: 4, kind: "element", tag: "td", parent: 2, children: [] },
    { id: 5, kind: "element", tag: "td", parent: 2, children: [] },
    { id: 6, kind: "element", tag: "td", parent: 3, children: [] },
    { id: 7, kind: "element", tag: "td", parent: 3, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "table", width: 200 })],
      [2, makeStyle({ display: "block" })],
      [3, makeStyle({ display: "block" })],
      [4, makeStyle({ display: "block", height: 30 })],
      [5, makeStyle({ display: "block", height: 20 })],
      [6, makeStyle({ display: "block", height: 15 })],
      [7, makeStyle({ display: "block", height: 25 })],
    ]),
  );

  const tree = layout(dom, styles);
  const table = fragmentOf(tree, nodeId(1))!;
  // The table's children are the two row fragments.
  assert.equal(table.children.length, 2);
  const row0 = tree.fragments.get(table.children[0]!)!;
  const row1 = tree.fragments.get(table.children[1]!)!;
  assert.equal(row0.node, nodeId(2));
  assert.equal(row1.node, nodeId(3));

  // Rows span the table width and stack top-to-bottom; row height = tallest cell.
  assert.equal(row0.box.width, px(200));
  assert.equal(row0.box.borderBox.y, px(0));
  assert.equal(row0.box.height, px(30), "row 0 height = max(30, 20)");
  assert.equal(row1.box.borderBox.y, px(30), "row 1 stacks below row 0");
  assert.equal(row1.box.height, px(25), "row 1 height = max(15, 25)");
  assert.equal(table.box.height, px(55), "table height = sum of row heights");

  // Cells in a row align to a shared column width (200 / 2 = 100).
  const c0 = tree.fragments.get(row0.children[0]!)!;
  const c1 = tree.fragments.get(row0.children[1]!)!;
  assert.equal(c0.box.width, px(100));
  assert.equal(c1.box.width, px(100));
  assert.equal(c0.box.borderBox.x, px(0));
  assert.equal(c1.box.borderBox.x, px(100), "second cell sits in the next column");
});

// ===========================================================================
// FLOAT (float:left|right) — Req 16.1
// ===========================================================================

void test("a floated box shifts out of flow and following content flows beside it (Req 16.1)", () => {
  // container(1) → float-left(2), in-flow(3), in-flow(4).
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3, 4] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 4, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 400 })],
      [2, makeStyle({ display: "block", float: "left", width: 100, height: 50 })],
      [3, makeStyle({ display: "block", height: 20 })],
      [4, makeStyle({ display: "block", height: 20 })],
    ]),
  );

  const tree = layout(dom, styles);
  const container = fragmentOf(tree, nodeId(1))!;
  const floatFrag = fragmentOf(tree, nodeId(2))!;
  const flow1 = fragmentOf(tree, nodeId(3))!;
  const flow2 = fragmentOf(tree, nodeId(4))!;

  // The float sits at the left edge, top of the container.
  assert.equal(floatFrag.box.borderBox.x, px(0));
  assert.equal(floatFrag.box.borderBox.y, px(0));
  // The float is OUT of the vertical flow: the first in-flow box starts at y=0
  // (it is not pushed down by the float's 50px height), and the second stacks
  // after only the in-flow boxes.
  assert.equal(flow1.box.borderBox.y, px(0), "in-flow content starts at the top, beside the float");
  assert.equal(flow2.box.borderBox.y, px(20), "in-flow boxes stack among themselves");
  // Container auto height reflects only the in-flow content (20 + 20).
  assert.equal(container.box.height, px(40));
});

void test("a right-floated box is shifted to the container's right content edge", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 400 })],
      [2, makeStyle({ display: "block", float: "right", width: 100, height: 50 })],
    ]),
  );

  const tree = layout(dom, styles);
  const floatFrag = fragmentOf(tree, nodeId(2))!;
  // Right edge: container width (400) - float margin-box width (100) = 300.
  assert.equal(floatFrag.box.borderBox.x, px(300));
  assert.equal(floatFrag.box.borderBox.y, px(0));
});

void test("float intrusion: a normal block keeps its border box; a BFC block shrinks (RFC 0003, CSS 2.1 §9.5)", () => {
  // container(1) → float-left(2) 100×50, in-flow(3) height=20, in-flow(4) height=20
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3, 4] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 4, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 400 })],
      [2, makeStyle({ display: "block", float: "left", width: 100, height: 50 })],
      [3, makeStyle({ display: "block", height: 20 })],
      [4, makeStyle({ display: "block", height: 20 })],
    ]),
  );

  const tree = layout(dom, styles);
  const floatFrag = fragmentOf(tree, nodeId(2))!;
  const flow1 = fragmentOf(tree, nodeId(3))!;
  const flow2 = fragmentOf(tree, nodeId(4))!;

  // Float at left edge.
  assert.equal(floatFrag.box.borderBox.x, px(0));
  assert.equal(floatFrag.box.borderBox.y, px(0));
  // §9.5: only a float's *line boxes* shorten — a NORMAL block's border box
  // keeps the full containing width (it may overlap the float's margin box).
  assert.equal(flow1.box.borderBox.x, px(0), "normal block border box does not shift");
  assert.equal(flow1.box.width, px(400), "normal block keeps full width beside a float");
  assert.equal(flow1.box.borderBox.y, px(0), "in-flow content starts at top, beside the float");
  assert.equal(flow2.box.borderBox.x, px(0));
  assert.equal(flow2.box.borderBox.y, px(20));
});

void test("float intrusion: an overflow:hidden block narrows its border box beside a float (RFC 0003)", () => {
  // container(1) → float-left(2) 100×50, BFC block(3) overflow:hidden.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 400 })],
      [2, makeStyle({ display: "block", float: "left", width: 100, height: 50 })],
      [3, makeStyle({ display: "block", height: 20, overflow: "hidden" })],
    ]),
  );

  const tree = layout(dom, styles);
  const bfcBlock = fragmentOf(tree, nodeId(3))!;

  // §9.5: a BFC-establishing box must not overlap a float's margin box — it
  // shrinks to the free interval and its border box shifts right.
  assert.equal(bfcBlock.box.borderBox.x, px(100), "BFC border box clears the left float");
  assert.equal(bfcBlock.box.width, px(300), "BFC border box shrinks to the free width");
  assert.equal(bfcBlock.box.borderBox.y, px(0));
});

// ===========================================================================
// POSITIONED (position:relative|absolute) — Req 16.1
// ===========================================================================

void test("a relatively positioned box is visually offset but keeps its in-flow space (Req 16.1)", () => {
  // container(1) → a(2) relative top:5 left:8, b(3) in-flow below a.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 300 })],
      [2, makeStyle({ display: "block", height: 40, position: "relative", top: 5, left: 8 })],
      [3, makeStyle({ display: "block", height: 30 })],
    ]),
  );

  const tree = layout(dom, styles);
  const a = fragmentOf(tree, nodeId(2))!;
  const b = fragmentOf(tree, nodeId(3))!;

  // a is offset by its insets from its normal-flow origin (0,0).
  assert.equal(a.box.borderBox.x, px(8));
  assert.equal(a.box.borderBox.y, px(5));
  // b keeps the space a would have occupied (a's 40px), so it sits at y=40, NOT
  // pushed by a's visual offset.
  assert.equal(b.box.borderBox.y, px(40), "relative offset preserves in-flow space");
});

void test("an absolutely positioned box is removed from flow and placed at its insets (Req 16.1)", () => {
  // container(1) → abs(2) at top:10 left:20, flow(3), flow(4).
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3, 4] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 4, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 300 })],
      [2, makeStyle({ display: "block", height: 40, position: "absolute", top: 10, left: 20 })],
      [3, makeStyle({ display: "block", height: 15 })],
      [4, makeStyle({ display: "block", height: 25 })],
    ]),
  );

  const tree = layout(dom, styles);
  const abs = fragmentOf(tree, nodeId(2))!;
  const flow1 = fragmentOf(tree, nodeId(3))!;
  const flow2 = fragmentOf(tree, nodeId(4))!;
  const container = fragmentOf(tree, nodeId(1))!;

  // Absolute box placed at its insets relative to the container content origin.
  assert.equal(abs.box.borderBox.x, px(20));
  assert.equal(abs.box.borderBox.y, px(10));
  // It is out of flow: the in-flow boxes start at y=0 and stack among themselves
  // only, ignoring the absolute box entirely.
  assert.equal(flow1.box.borderBox.y, px(0), "absolute box reserves no in-flow space");
  assert.equal(flow2.box.borderBox.y, px(15));
  assert.equal(container.box.height, px(40), "auto height ignores the out-of-flow box");
});


void test("absolute fill uses padding edge not content edge (aspect-ratio box)", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const parentStyle: Record<string, unknown> = {
    display: "block",
    color: BLACK,
    fontSize: px(16),
    margin: ZERO_EDGES,
    width: 200,
    height: "auto",
    backgroundColor: TRANSPARENT,
    position: "relative",
    paddingTop: 100,
    paddingRight: 0,
    paddingBottom: 0,
    paddingLeft: 0,
  };
  const childStyle: Record<string, unknown> = {
    display: "block",
    color: BLACK,
    fontSize: px(16),
    margin: ZERO_EDGES,
    width: 200,
    height: 100,
    backgroundColor: TRANSPARENT,
    position: "absolute",
    top: 0,
    left: 0,
  };
  const styles = styleTable(
    new Map([
      [1, deepFreeze(parentStyle as unknown as ComputedStyle)],
      [2, deepFreeze(childStyle as unknown as ComputedStyle)],
    ]),
  );
  const tree = layout(dom, styles);
  const child = fragmentOf(tree, nodeId(2))!;
  assert.equal(child.box.borderBox.x, px(0), "absolute left:0 is padding edge");
  assert.equal(child.box.borderBox.y, px(0), "absolute top:0 is padding edge not below padding-top");
  assert.equal(child.box.width, px(200));
  assert.equal(child.box.height, px(100));
});

void test("bottom/right insets offset a relative box upward/left when top/left are absent", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 300 })],
      [2, makeStyle({ display: "block", height: 40, position: "relative", bottom: 5, right: 8 })],
    ]),
  );

  const tree = layout(dom, styles);
  const a = fragmentOf(tree, nodeId(2))!;
  // bottom/right map to negative top/left offsets.
  assert.equal(a.box.borderBox.x, px(-8));
  assert.equal(a.box.borderBox.y, px(-5));
});

void test("an absolutely positioned box with NO insets stays at its static (in-flow) position", () => {
  // When top/left are absent (auto), CSS keeps the box where it WOULD have been
  // in normal flow — not snapped to the container's top-left corner. Here a
  // prior in-flow sibling (height 30) pushes the absolute box's static y to 30.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 300, position: "relative" })],
      [2, makeStyle({ display: "block", height: 30 })],
      [3, makeStyle({ display: "block", height: 20, position: "absolute" })],
    ]),
  );
  const tree = layout(dom, styles);
  const abs = fragmentOf(tree, nodeId(3))!;
  // Static y = the prior sibling's height (30); static x = content left (0).
  assert.equal(Number(abs.box.borderBox.y), 30, "absolute with no top stays at its static in-flow y");
  assert.equal(Number(abs.box.borderBox.x), 0, "absolute with no left stays at content left");
});

void test("a fixed-positioned box is removed from flow and placed at its insets (Req 16.1)", () => {
  // container(1) → fixed(2) at top:10 left:20, flow(3), flow(4).
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3, 4] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 4, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 300 })],
      [2, makeStyle({ display: "block", height: 40, position: "fixed", top: 10, left: 20 })],
      [3, makeStyle({ display: "block", height: 15 })],
      [4, makeStyle({ display: "block", height: 25 })],
    ]),
  );

  const tree = layout(dom, styles);
  const fixed = fragmentOf(tree, nodeId(2))!;
  const flow1 = fragmentOf(tree, nodeId(3))!;
  const flow2 = fragmentOf(tree, nodeId(4))!;
  const container = fragmentOf(tree, nodeId(1))!;

  // Fixed box placed at its insets (like absolute in this engine).
  assert.equal(fixed.box.borderBox.x, px(20));
  assert.equal(fixed.box.borderBox.y, px(10));
  // It is out of flow: the in-flow boxes start at y=0 and stack among themselves.
  assert.equal(flow1.box.borderBox.y, px(0), "fixed box reserves no in-flow space");
  assert.equal(flow2.box.borderBox.y, px(15));
  assert.equal(container.box.height, px(40), "auto height ignores the out-of-flow box");
});

void test("a sticky-positioned box pins at its top inset and preserves in-flow space", () => {
  // Real sticky semantics (CSS Position §3): at scrollY=0 a `top:5` threshold
  // pins the box down to y=5 (its static top would otherwise sit above the
  // threshold); `left` on a full-width box cannot be satisfied inside the
  // containing block — the constraint clamps it back to the bound edge.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 300 })],
      [2, makeStyle({ display: "block", height: 40, position: "sticky", top: 5, left: 8 })],
      [3, makeStyle({ display: "block", height: 30 })],
    ]),
  );

  const tree = layout(dom, styles);
  const sticky = fragmentOf(tree, nodeId(2))!;
  const next = fragmentOf(tree, nodeId(3))!;

  assert.equal(sticky.box.borderBox.x, px(0), "left inset on a full-width box clamps to the bound edge");
  assert.equal(sticky.box.borderBox.y, px(5), "top:5 pins the box at the threshold");
  assert.equal(next.box.borderBox.y, px(40), "sticky preserves in-flow space");
});

// ===========================================================================
// Every advanced branch produces a VALID, deep-frozen FragmentTree (Req 3.2).
// ===========================================================================

void test("each advanced mode produces a deep-frozen FragmentTree (Req 3.2)", () => {
  const cases: ReadonlyMap<number, ComputedStyle>[] = [
    new Map([[1, makeStyle({ display: "flex", width: 300 })]]),
    new Map([[1, makeStyle({ display: "grid", width: 200, "grid-template-columns": 2 })]]),
    new Map([[1, makeStyle({ display: "block", width: 300 })], [2, makeStyle({ display: "block", float: "left", width: 50, height: 20 })]]),
    new Map([[1, makeStyle({ display: "block", width: 300 })], [2, makeStyle({ display: "block", position: "absolute", top: 5, left: 5, height: 20 })]]),
  ];
  for (const map of cases) {
    const dom = buildDom([
      { id: 0, kind: "document", parent: null, children: [1] },
      { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
      { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
      { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
    ]);
    const tree = layout(dom, styleTable(map));
    assertFrozenTree(tree);
  }
});

void test("advanced layout is deterministic: same inputs ⇒ structurally equal trees (Req 2.7)", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "flex", width: 300 })],
      [2, makeStyle({ display: "block", height: 10 })],
      [3, makeStyle({ display: "block", height: 20 })],
    ]),
  );
  const a = layout(dom, styles);
  const b = layout(dom, styles);
  assert.equal(a.fragments.size, b.fragments.size);
  for (const [id, fragA] of a.fragments) {
    assert.deepEqual(fragA, b.fragments.get(id));
  }
});



// ===========================================================================
// The default block/inline path is UNAFFECTED when no advanced props present.
// ===========================================================================

void test("a plain block document (no advanced props) lays out exactly as before", () => {
  // Mirrors index.test.ts's stacking case: three blocks stack top-to-bottom.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3, 4] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 4, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block" })],
      [2, makeStyle({ display: "block", height: 10 })],
      [3, makeStyle({ display: "block", height: 20 })],
      [4, makeStyle({ display: "block", height: 30 })],
    ]),
  );

  const tree = layout(dom, styles);
  const div = fragmentOf(tree, nodeId(1))!;
  const kids = div.children.map((id) => tree.fragments.get(id)!);

  // Block stacking is unchanged: monotonic y, full-viewport auto width.
  assert.equal(div.box.width, DEFAULT_VIEWPORT_WIDTH);
  assert.equal(kids[0]!.box.borderBox.y, px(0));
  assert.equal(kids[1]!.box.borderBox.y, px(10));
  assert.equal(kids[2]!.box.borderBox.y, px(30));
  assert.equal(div.box.height, px(60));
  // No child was shifted horizontally (no float/positioning).
  for (const kid of kids) {
    assert.equal(kid.box.borderBox.x, px(0));
  }
});

void test("static-position / float:none children take the normal-flow path verbatim", () => {
  // Carrying position:static and float:none must behave identically to omitting
  // them — the defensive readers fall back to the flow path.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const withProps = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 300 })],
      [2, makeStyle({ display: "block", height: 12, position: "static", float: "none" })],
      [3, makeStyle({ display: "block", height: 18, position: "static", float: "none" })],
    ]),
  );
  const without = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 300 })],
      [2, makeStyle({ display: "block", height: 12 })],
      [3, makeStyle({ display: "block", height: 18 })],
    ]),
  );

  const a = layout(dom, withProps);
  const b = layout(dom, without);
  // Same geometry on every fragment.
  for (const [id, fragA] of a.fragments) {
    assert.deepEqual(fragA.box, b.fragments.get(id)!.box);
  }
});

// ===========================================================================
// Positioned layout — containing-block selection, scroll-anchored fixed,
// sticky clamping, transformed CB capture, and paint order (CSS 2.1 §10.1,
// CSS Position §3, Transforms §4, CSS2.1 Appendix E).
// ===========================================================================

void test("absolute resolves against the NEAREST POSITIONED ancestor, skipping static parents", () => {
  // grandparent(1, relative, padding-box CB) → static parent(2) → abs(3).
  // The abs child's `top:0` must resolve against node 1's padding box, not
  // node 2's — even though 2 is its direct parent.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [3] },
    { id: 3, kind: "element", tag: "div", parent: 2, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 300, height: 200, position: "relative", top: 50, left: 30 })],
      [2, makeStyle({ display: "block", height: 60 })],
      [3, makeStyle({ display: "block", height: 20, width: 40, position: "absolute", top: 0, left: 0 })],
    ]),
  );
  const tree = layout(dom, styles);
  const gp = fragmentOf(tree, nodeId(1))!;
  const mid = fragmentOf(tree, nodeId(2))!;
  const abs = fragmentOf(tree, nodeId(3))!;
  // The abs fragment is held by the POSITIONED grandparent — not the static
  // parent — and sits at the grandparent's padding-box origin (local coords).
  assert.ok(gp.children.includes(fragmentIdOf(tree, nodeId(3))), "abs held by the positioned ancestor");
  assert.ok(!mid.children.includes(fragmentIdOf(tree, nodeId(3))), "static parent skipped as CB");
  assert.equal(abs.box.borderBox.x, px(0), "abs x = grandparent's padding-box left edge");
  assert.equal(abs.box.borderBox.y, px(0), "abs y = grandparent's padding-box top edge");
});

void test("absolute %-insets resolve against the containing block's padding box", () => {
  // CB = 200×100 padding box; top:25%/left:50% → (100, 25).
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 200, height: 100, position: "relative" })],
      [2, makeStyle({
        display: "block", height: 10, width: 10, position: "absolute",
        top: { kind: "specified-length", unit: "%", value: 25 } as never,
        left: { kind: "specified-length", unit: "%", value: 50 } as never,
      })],
    ]),
  );
  const tree = layout(dom, styles);
  const abs = fragmentOf(tree, nodeId(2))!;
  assert.equal(abs.box.borderBox.x, px(100), "left:50% of the 200px padding box");
  assert.equal(abs.box.borderBox.y, px(25), "top:25% of the 100px padding box");
});

void test("abspos table with a non-cell child fit-content sizes and auto-margins center", () => {
  const auto = {
    marginTop: "auto" as const,
    marginRight: "auto" as const,
    marginBottom: "auto" as const,
    marginLeft: "auto" as const,
  };
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [3] },
    { id: 3, kind: "element", tag: "div", parent: 2, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 40, height: 40, position: "relative" })],
      [2, makeStyle({
        display: "table",
        position: "absolute",
        top: 0, right: 0, bottom: 0, left: 0,
        ...auto,
      })],
      [3, makeStyle({ display: "block", width: 20, height: 20 })],
    ]),
  );
  const tree = layout(dom, styles);
  const table = fragmentOf(tree, nodeId(2))!;
  assert.equal(Number(table.box.borderBox.width), 20, "table shrinks to the child width");
  assert.equal(Number(table.box.borderBox.height), 20, "table shrinks to the child height");
  assert.equal(Number(table.box.borderBox.x), 10, "auto left/right margins center");
  assert.equal(Number(table.box.borderBox.y), 10, "auto top/bottom margins center");
});

void test("vertical containing block maps abspos align-self onto the physical width", () => {
  const auto = {
    marginTop: "auto" as const,
    marginRight: "auto" as const,
    marginBottom: "auto" as const,
    marginLeft: "auto" as const,
  };
  const lay = (align: { "align-self"?: string; "justify-self"?: string }) => {
    const dom = buildDom([
      { id: 0, kind: "document", parent: null, children: [1] },
      { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
      { id: 2, kind: "element", tag: "div", parent: 1, children: [3] },
      { id: 3, kind: "element", tag: "div", parent: 2, children: [] },
    ]);
    const styles = styleTable(
      new Map([
        [1, makeStyle({
          display: "block", width: 40, height: 40, position: "relative",
          writingMode: "vertical-rl",
        })],
        [2, makeStyle({
          display: "block",
          position: "absolute",
          writingMode: "horizontal-tb",
          top: 0, right: 0, bottom: 0, left: 0,
          ...auto,
          ...align,
        })],
        [3, makeStyle({ display: "block", width: 20, height: 20, writingMode: "horizontal-tb" })],
      ]),
    );
    return fragmentOf(layout(dom, styles), nodeId(2))!;
  };
  const block = lay({ "align-self": "start" });
  assert.equal(Number(block.box.borderBox.width), 20, "align-self sizes the vertical block axis (physical width)");
  assert.equal(Number(block.box.borderBox.height), 40, "the inline axis still stretches");
  assert.equal(Number(block.box.borderBox.x), 10, "auto block margins center the fit-content width");
  assert.equal(Number(block.box.borderBox.y), 0, "stretched inline axis stays at the start edge");
  const inline = lay({ "justify-self": "start" });
  assert.equal(Number(inline.box.borderBox.height), 20, "justify-self sizes the vertical inline axis (physical height)");
  assert.equal(Number(inline.box.borderBox.width), 40, "the block axis still stretches");
  assert.equal(Number(inline.box.borderBox.y), 10, "auto inline margins center the fit-content height");
  assert.equal(Number(inline.box.borderBox.x), 0);
});

void test("aspect-ratio gives an auto-height block a definite height for percentage insets", () => {
  const pct = (value: number) => ({ kind: "specified-length", unit: "%", value }) as never;
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 200, position: "relative", aspectRatio: "2 / 1" })],
      [2, makeStyle({ display: "block", width: 20, height: 20, position: "relative", top: pct(50) })],
    ]),
  );
  const tree = layout(dom, styles);
  const box = fragmentOf(tree, nodeId(1))!;
  const child = fragmentOf(tree, nodeId(2))!;
  assert.equal(Number(box.box.borderBox.height), 100, "200px width at 2/1 is 100px tall");
  assert.equal(Number(child.box.borderBox.y), 50, "top:50% of the aspect-ratio height");
});

void test("relative percentage top resolves against an abspos percentage height", () => {
  // fixed CB 200px → abspos height 100% → relative top 50% offsets by 100.
  // height 50% → offset 50. auto height → percentage top is 0.
  const pct = (value: number) => ({ kind: "specified-length", unit: "%", value }) as never;
  const calc = (ast: unknown) => ({ kind: "specified-calc", ast }) as never;
  const lay = (absHeight: unknown) => {
    const dom = buildDom([
      { id: 0, kind: "document", parent: null, children: [1] },
      { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
      { id: 2, kind: "element", tag: "div", parent: 1, children: [3] },
      { id: 3, kind: "element", tag: "div", parent: 2, children: [] },
    ]);
    const styles = styleTable(
      new Map([
        [1, makeStyle({ display: "block", width: 200, height: 200, position: "relative" })],
        [2, makeStyle({ display: "block", position: "absolute", height: absHeight as never })],
        [3, makeStyle({ display: "block", width: 20, height: 20, position: "relative", top: pct(50) })],
      ]),
    );
    const tree = layout(dom, styles);
    return {
      abs: fragmentOf(tree, nodeId(2))!,
      rel: fragmentOf(tree, nodeId(3))!,
    };
  };
  const full = lay(pct(100));
  assert.equal(Number(full.abs.box.borderBox.height), 200, "abspos height:100% of 200px");
  assert.equal(Number(full.rel.box.borderBox.y), 100, "relative top:50% of the abspos");
  const half = lay(pct(50));
  assert.equal(Number(half.abs.box.borderBox.height), 100, "abspos height:50%");
  assert.equal(Number(half.rel.box.borderBox.y), 50, "relative top:50% of the 100px abspos");
  const stretched = lay("stretch");
  assert.equal(Number(stretched.abs.box.borderBox.height), 200, "abspos height:stretch");
  assert.equal(Number(stretched.rel.box.borderBox.y), 100, "relative top:50% of a stretch abspos");
  const summed = lay(calc({
    type: "add",
    left: { type: "len", value: 50, unit: "%" },
    right: { type: "px", value: 50 },
  }));
  assert.equal(Number(summed.abs.box.borderBox.height), 150, "abspos height:calc(50% + 50px)");
  assert.equal(Number(summed.rel.box.borderBox.y), 75, "relative top:50% of the calc height");
  const auto = lay("auto");
  assert.equal(Number(auto.rel.box.borderBox.y), 0, "auto-height abspos does not resolve percentage top");
});

void test("absolute with both left+right insets sizes to fill between them", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 200, height: 100, position: "relative" })],
      [2, makeStyle({ display: "block", height: 10, position: "absolute", left: 20, right: 30 })],
    ]),
  );
  const tree = layout(dom, styles);
  const abs = fragmentOf(tree, nodeId(2))!;
  assert.equal(abs.box.borderBox.x, px(20));
  assert.equal(Number(abs.box.borderBox.width), 150, "left+right insets solve the width (200-20-30)");
});

void test("fixed anchors to the scrolled viewport; absolute stays in document space", () => {
  // Same insets, same tree: under scrollY=200 the fixed box moves with the
  // viewport (y=scrollY+top) while the absolute box is document-anchored.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 300, height: 2000 })],
      [2, makeStyle({ display: "block", height: 40, width: 40, position: "fixed", top: 10, left: 20 })],
      [3, makeStyle({ display: "block", height: 40, width: 40, position: "absolute", top: 10, left: 20 })],
    ]),
  );
  const top0 = layout(dom, styles);
  const scrolled = layout(dom, styles, { scrollY: 200 });

  const fixed0 = fragmentOf(top0, nodeId(2))!;
  const fixedS = fragmentOf(scrolled, nodeId(2))!;
  const absS = fragmentOf(scrolled, nodeId(3))!;
  assert.equal(fixed0.box.borderBox.y, px(10), "fixed at scrollY=0 → y=10");
  assert.equal(fixedS.box.borderBox.y, px(210), "fixed rides the viewport: scrollY + top");
  assert.equal(absS.box.borderBox.y, px(10), "absolute stays document-anchored");
});

void test("sticky lifts to its top threshold under scroll and clamps at the bound bottom", () => {
  // Container 1000 tall; sticky (h=40) at static y=50 with top:10.
  // scrollY=100 → pinned at 100+10=110. scrollY=2000 → clamps at bound 960.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 300, height: 1000 })],
      [2, makeStyle({ display: "block", height: 50 })],
      [3, makeStyle({ display: "block", height: 40, position: "sticky", top: 10 })],
    ]),
  );
  const atRest = layout(dom, styles);
  const scrolled = layout(dom, styles, { scrollY: 100 });
  const pastEnd = layout(dom, styles, { scrollY: 2000 });

  const rest = fragmentOf(atRest, nodeId(3))!;
  const pinned = fragmentOf(scrolled, nodeId(3))!;
  const clamped = fragmentOf(pastEnd, nodeId(3))!;
  assert.equal(rest.box.borderBox.y, px(50), "static position when below the threshold");
  assert.equal(pinned.box.borderBox.y, px(110), "scrollY + insetTop");
  assert.equal(clamped.box.borderBox.y, px(960), "clamped to containing-block bottom (1000-40)");
});

void test("a transformed box captures fixed AND absolute descendants (Transforms §4)", () => {
  // transform on (1) makes it the containing block: the `fixed` child pins to
  // ITS padding box, not the viewport.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({
        display: "block", width: 300, height: 400,
        margin: { top: px(70), right: px(0), bottom: px(0), left: px(15) },
        transform: [1, 0, 0, 1, 0, 0],
      })],
      [2, makeStyle({ display: "block", height: 30, width: 30, position: "fixed", top: 0, left: 0 })],
    ]),
  );
  const tree = layout(dom, styles);
  const host = fragmentOf(tree, nodeId(1))!;
  const fixed = fragmentOf(tree, nodeId(2))!;
  const rootFrag = tree.fragments.get(tree.root)!;
  // Captured by the transformed ancestor: held in ITS children at the
  // padding-box origin — not drained to the root (initial containing block).
  assert.ok(host.children.includes(fragmentIdOf(tree, nodeId(2))), "fixed captured by transformed ancestor");
  assert.ok(!rootFrag.children.includes(fragmentIdOf(tree, nodeId(2))), "fixed did NOT escape to the ICB");
  assert.equal(fixed.box.borderBox.x, px(0), "host-local padding-box left edge");
  assert.equal(fixed.box.borderBox.y, px(0), "host-local padding-box top edge");
});

void test("z-index orders positioned children in paint order (negative under in-flow, positive over)", () => {
  // flow(2) + posA(3, z:5) + posB(4, z:-1): the parent's fragment children
  // list IS paint order → posB (negative) first, flow next, posA last.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3, 4] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 4, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 300 })],
      [2, makeStyle({ display: "block", height: 50 })],
      [3, makeStyle({ display: "block", height: 20, width: 20, position: "relative", zIndex: 5 })],
      [4, makeStyle({ display: "block", height: 20, width: 20, position: "relative", zIndex: -1 })],
    ]),
  );
  const tree = layout(dom, styles);
  const parent = fragmentOf(tree, nodeId(1))!;
  const order = new Map<FragmentId, number>();
  parent.children.forEach((id, i) => order.set(id, i));
  const fragIdOf = (n: number): FragmentId => {
    for (const [id, frag] of tree.fragments) {
      if (frag.node === nodeId(n)) return id;
    }
    throw new Error(`no fragment for node ${n}`);
  };
  const posFlow = order.get(fragIdOf(2))!;
  const posA = order.get(fragIdOf(3))!;
  const posB = order.get(fragIdOf(4))!;
  assert.ok(posB < posFlow, "negative z paints under in-flow content");
  assert.ok(posFlow < posA, "positive z paints over in-flow content");
});

// ===========================================================================
// Inline-formatting completion — text-indent, preserved newlines
// (`white-space: pre*`), and vertical-align on atomic boxes
// (CSS Text §3.6/§4.1, CSS 2.1 §10.8.1).
// ===========================================================================

void test("text-indent shifts ONLY the first line's start edge", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "text", text: "alpha", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 300, textIndent: 40 })],
      [2, makeStyle({})],
    ]),
  );
  const tree = layout(dom, styles);
  const text = fragmentOf(tree, nodeId(2))!;
  // The anonymous line box — and therefore the text fragment — starts at the
  // indented start edge; without the indent it would sit at x=0.
  assert.equal(text.box.borderBox.x, px(40), "first line begins at the text-indent");
});

void test("white-space:pre turns \\n into hard line breaks (blank lines keep height)", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "text", text: "aa\n\nbb", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 300 })],
      [2, makeStyle({ whiteSpace: "pre", fontSize: 16 })],
    ]),
  );
  const tree = layout(dom, styles);
  const text = fragmentOf(tree, nodeId(2))!;
  // Three line boxes: "aa", an EMPTY middle line (the second \n), "bb" —
  // each 16px tall (fontSize × the initial line-height 1.0).
  assert.equal(Number(text.box.borderBox.height), 48, "3 line boxes incl. the blank middle line");
  const ys = new Set((text.text?.glyphs ?? []).map((g) => Number(g.y)));
  assert.ok(ys.has(0) && ys.has(32), "glyphs on line 0 and line 2 (y=32)");
});

void test("white-space:normal still collapses \\n to a break opportunity", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "text", text: "aa\n\nbb", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 300 })],
      [2, makeStyle({ fontSize: 16 })],
    ]),
  );
  const tree = layout(dom, styles);
  const text = fragmentOf(tree, nodeId(2))!;
  assert.equal(Number(text.box.borderBox.height), 16, "collapsed \\n: one line");
});

void test("vertical-align positions atomic boxes against the line baseline and edges", () => {
  // [text 16px] [atomic h=30 baseline] [atomic h=10 bottom] on one line:
  // text floor = 16; baseline = lineTop + 12.8 (0.8em strut). atomic30 →
  // bottom at baseline → t = 12.8 − 30 = −17.2 above the line top → §10.8
  // lifts the whole line by 17.2: lineY = 17.2. atomic10 resolves `bottom`
  // against the line-box bottom grown by the OTHER members (16, atomic30's
  // bottom sits at the baseline 12.8 < 16) → t = 6; the grown line box is
  // [−17.2, 16] → 33.2 tall.
  //   atomic30 → y = 0 (bottom edge at the baseline = y 30)
  //   atomic10 → bottom at grown line bottom 33.2 → y = 23.2
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3, 4] },
    { id: 2, kind: "text", text: "x", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "span", parent: 1, children: [] },
    { id: 4, kind: "element", tag: "span", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 300 })],
      [2, makeStyle({ fontSize: 16 })],
      [3, makeStyle({ display: "inline-block", width: 20, height: 30 })],
      [4, makeStyle({ display: "inline-block", width: 20, height: 10, verticalAlign: "bottom" })],
    ]),
  );
  const tree = layout(dom, styles);
  const tall = fragmentOf(tree, nodeId(3))!;
  const short = fragmentOf(tree, nodeId(4))!;
  // The line box grows BOTH ways (§10.8): the 30px atomic would poke 17.2
  // above the 12.8px-strut line top, so the whole line lifts by 17.2 —
  // atomic30's bottom edge still lands exactly on the baseline (y+30 = 30).
  assert.equal(Number(tall.box.borderBox.y), 0, "baseline: bottom edge at the line baseline");
  assert.equal(Number(short.box.borderBox.y), 23.2, "bottom: bottom edge at the grown line-box bottom");
});

void test("vertical-align:middle uses the font x-height when the shaper reports one", () => {
  // Default middle rise is 0.25em. An x-height of 0.4em rises by 0.2em instead:
  // y = baseline(12.8) + 3.2 − height/2(5) = 11.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "p", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "span", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 200, fontSize: 16 })],
      [2, makeStyle({ display: "inline-block", width: 10, height: 10, fontSize: 16, verticalAlign: "middle" })],
    ]),
  );
  const tree = layout(dom, styles, {
    shaper: {
      shapeLine: metricsShaper.shapeLine.bind(metricsShaper),
      fontMetrics: () => ({ xHeightEm: 0.4 }),
    },
  });
  const box = fragmentOf(tree, nodeId(2))!;
  assert.equal(Number(box.box.borderBox.y), 11);
});

void test("vertical-align:super on an inline span lifts that text above the line baseline", () => {
  // super raises the span's baseline by 0.33em. The line then grows upward and
  // lifts, so the span stays at y=0 and the sibling text drops by 0.33em.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "p", parent: 0, children: [2, 3] },
    { id: 2, kind: "text", text: "A", parent: 1 },
    { id: 3, kind: "element", tag: "span", parent: 1, children: [4] },
    { id: 4, kind: "text", text: "B", parent: 3 },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 400, fontSize: 16 })],
      [2, makeStyle({ fontSize: 16 })],
      [3, makeStyle({ display: "inline", fontSize: 16, verticalAlign: "super" })],
      [4, makeStyle({ fontSize: 16 })],
    ]),
  );
  const tree = layout(dom, styles);
  const text = fragmentOf(tree, nodeId(2))!;
  const span = fragmentOf(tree, nodeId(3))!;
  assert.equal(
    Number(text.box.borderBox.y) - Number(span.box.borderBox.y),
    16 * 0.33,
    "the superscript span sits 0.33em above the sibling text",
  );
});

void test("vertical-align:super on an inline still wraps onto the parent's next line", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "p", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "span", parent: 1, children: [3] },
    { id: 3, kind: "text", text: "aa bb cc", parent: 2 },
  ]);
  const tree = layout(dom, styleTable(new Map([
    [1, makeStyle({ display: "block", width: 40, fontSize: 16 })],
    [2, makeStyle({ display: "inline", fontSize: 16, verticalAlign: "super" })],
    [3, makeStyle({ fontSize: 16 })],
  ])));
  const text = fragmentOf(tree, nodeId(3))!;
  const span = fragmentOf(tree, nodeId(2))!;
  const glyphs = text.text?.glyphs ?? [];
  assert.equal(glyphs.length, 6);
  assert.ok(Number(glyphs[4]!.y) > Number(glyphs[0]!.y), "the third word sits on the next line");
  assert.equal(Number(span.box.borderBox.width), 40);
  assert.ok(Number(span.box.borderBox.height) > 16, "the wrapped span is taller than one line");
});

void test("::first-letter font-size sizes the first code point and grows the first line", () => {
  // Body 16px advances 8 per code unit (metrics ratio 0.5). The first letter
  // at 32px advances 16. The rest of the line shares its baseline, so "b"
  // sits at y = 0.8*32 − 0.8*16 and keeps the body advance.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "p", parent: 0, children: [2] },
    { id: 2, kind: "text", text: "Ab", parent: 1 },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 400, fontSize: 16, firstLetterFontSize: 32 })],
      [2, makeStyle({ fontSize: 16 })],
    ]),
  );
  const tree = layout(dom, styles);
  const text = fragmentOf(tree, nodeId(2))!;
  const glyphs = text.text?.glyphs ?? [];
  assert.equal(Number(text.box.borderBox.width), 24, "16px letter + 8px rest");
  assert.equal(Number(text.box.borderBox.height), 32, "the first line grows to the letter");
  assert.equal(glyphs.length, 2);
  assert.equal(Number(glyphs[0]!.x), 0);
  assert.equal(Number(glyphs[0]!.advance), 16);
  assert.equal(Number(glyphs[0]!.fontSize), 32);
  assert.equal(Number(glyphs[1]!.x), 16);
  assert.equal(Number(glyphs[1]!.advance), 8);
  assert.equal(glyphs[1]!.fontSize, undefined);
  assert.equal(Number(glyphs[1]!.y), 0.8 * 32 - 0.8 * 16);
});

void test("::first-letter takes one code point, including a surrogate pair", () => {
  // U+1F600 is two UTF-16 units. At 32px the metrics shaper advances
  // 0.5*32 per unit, so the emoji is 32px wide and "b" starts at x=32.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "p", parent: 0, children: [2] },
    { id: 2, kind: "text", text: "😀b", parent: 1 },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 400, fontSize: 16, firstLetterFontSize: 32 })],
      [2, makeStyle({ fontSize: 16 })],
    ]),
  );
  const tree = layout(dom, styles);
  const text = fragmentOf(tree, nodeId(2))!;
  const glyphs = text.text?.glyphs ?? [];
  assert.equal(Number(text.box.borderBox.width), 40);
  assert.equal(glyphs.length, 3);
  assert.equal(Number(glyphs[0]!.fontSize), 32);
  assert.equal(Number(glyphs[1]!.fontSize), 32);
  assert.equal(Number(glyphs[2]!.x), 32);
  assert.equal(Number(glyphs[2]!.advance), 8);
  assert.equal(glyphs[2]!.fontSize, undefined);
});

void test("::first-line font-size wraps the first line and leaves the next line at the body size", () => {
  // Body 16px: "aa" is 16 wide and a space is 8, so "aa bb cc" is 64 and fits
  // in 80. At 32px each word is 32 and each space is 16, so "aa bb" fills 80
  // and "cc" wraps back to the 16px body size.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "p", parent: 0, children: [2] },
    { id: 2, kind: "text", text: "aa bb cc", parent: 1 },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 80, fontSize: 16, firstLineFontSize: 32 })],
      [2, makeStyle({ fontSize: 16 })],
    ]),
  );
  const tree = layout(dom, styles);
  const text = fragmentOf(tree, nodeId(2))!;
  const glyphs = text.text?.glyphs ?? [];
  assert.equal(Number(text.box.borderBox.width), 80);
  assert.equal(Number(text.box.borderBox.height), 48, "32px first line + 16px second line");
  assert.equal(glyphs.length, 6);
  assert.equal(Number(glyphs[0]!.x), 0);
  assert.equal(Number(glyphs[0]!.advance), 16);
  assert.equal(Number(glyphs[0]!.fontSize), 32);
  assert.equal(Number(glyphs[2]!.x), 48, "the second word starts after a 32px word and a 16px space");
  assert.equal(Number(glyphs[2]!.fontSize), 32);
  assert.equal(Number(glyphs[4]!.x), 0);
  assert.equal(Number(glyphs[4]!.y), 32);
  assert.equal(Number(glyphs[4]!.advance), 8);
  assert.equal(glyphs[4]!.fontSize, undefined);
  assert.equal(glyphs[5]!.fontSize, undefined);
});

void test("::first-line sizes the rest of the first line while ::first-letter keeps the first code point", () => {
  // Letter 32px (advance 16), first line 24px (advance 12). They share the
  // 25.6px baseline, so "b" sits 6.4px down. The line box is the letter's 32px.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "p", parent: 0, children: [2] },
    { id: 2, kind: "text", text: "Ab", parent: 1 },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({
        display: "block", width: 400, fontSize: 16,
        firstLetterFontSize: 32, firstLineFontSize: 24,
      })],
      [2, makeStyle({ fontSize: 16 })],
    ]),
  );
  const tree = layout(dom, styles);
  const text = fragmentOf(tree, nodeId(2))!;
  const glyphs = text.text?.glyphs ?? [];
  assert.equal(Number(text.box.borderBox.width), 28);
  assert.equal(Number(text.box.borderBox.height), 32);
  assert.equal(glyphs.length, 2);
  assert.equal(Number(glyphs[0]!.advance), 16);
  assert.equal(Number(glyphs[0]!.fontSize), 32);
  assert.equal(Number(glyphs[0]!.y), 0);
  assert.equal(Number(glyphs[1]!.x), 16);
  assert.equal(Number(glyphs[1]!.advance), 12);
  assert.equal(Number(glyphs[1]!.fontSize), 24);
  assert.equal(Number(glyphs[1]!.y), 0.8 * 32 - 0.8 * 24);
});

void test("::first-letter color paints only the first code point", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "p", parent: 0, children: [2] },
    { id: 2, kind: "text", text: "Ab", parent: 1 },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 400, fontSize: 16, firstLetterColor: RED })],
      [2, makeStyle({ fontSize: 16 })],
    ]),
  );
  const tree = layout(dom, styles);
  const text = fragmentOf(tree, nodeId(2))!;
  const glyphs = text.text?.glyphs ?? [];
  assert.equal(Number(text.box.borderBox.width), 16, "color does not change the advance");
  assert.equal(glyphs.length, 2);
  assert.deepEqual(glyphs[0]!.color, RED);
  assert.equal(glyphs[0]!.fontSize, undefined);
  assert.equal(glyphs[1]!.color, undefined);
});

void test("::first-line color stops at the first line, and ::first-letter color wins on the first code point", () => {
  // Width 40 fits "aa bb" (16+8+16) and wraps "cc". Line 0 is red except the
  // first code point, which is blue. Line 1 keeps the element color.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "p", parent: 0, children: [2] },
    { id: 2, kind: "text", text: "aa bb cc", parent: 1 },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({
        display: "block", width: 40, fontSize: 16,
        firstLetterColor: BLUE, firstLineColor: RED,
      })],
      [2, makeStyle({ fontSize: 16 })],
    ]),
  );
  const tree = layout(dom, styles);
  const glyphs = fragmentOf(tree, nodeId(2))!.text?.glyphs ?? [];
  assert.equal(glyphs.length, 6);
  assert.deepEqual(glyphs[0]!.color, BLUE);
  assert.deepEqual(glyphs[1]!.color, RED);
  assert.deepEqual(glyphs[2]!.color, RED);
  assert.equal(Number(glyphs[4]!.y), 16);
  assert.equal(glyphs[4]!.color, undefined);
  assert.equal(glyphs[5]!.color, undefined);
});

void test("::first-letter includes the punctuation that touches the first letter", () => {
  // "(A" is the first letter: the parenthesis precedes A, and "b)" does not.
  // At 32px those two code points advance 16 each; "b)" stays at 8 each.
  const wrapped = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "p", parent: 0, children: [2] },
    { id: 2, kind: "text", text: "(Ab)", parent: 1 },
  ]);
  const wrappedTree = layout(wrapped, styleTable(new Map([
    [1, makeStyle({ display: "block", width: 400, fontSize: 16, firstLetterFontSize: 32 })],
    [2, makeStyle({ fontSize: 16 })],
  ])));
  const wrappedGlyphs = fragmentOf(wrappedTree, nodeId(2))!.text?.glyphs ?? [];
  assert.equal(Number(fragmentOf(wrappedTree, nodeId(2))!.box.borderBox.width), 48);
  assert.equal(wrappedGlyphs.length, 4);
  assert.equal(Number(wrappedGlyphs[0]!.advance), 16);
  assert.equal(Number(wrappedGlyphs[0]!.fontSize), 32);
  assert.equal(Number(wrappedGlyphs[1]!.x), 16);
  assert.equal(Number(wrappedGlyphs[1]!.fontSize), 32);
  assert.equal(Number(wrappedGlyphs[2]!.x), 32);
  assert.equal(Number(wrappedGlyphs[2]!.advance), 8);
  assert.equal(wrappedGlyphs[2]!.fontSize, undefined);
  assert.equal(Number(wrappedGlyphs[3]!.x), 40);

  // "A." keeps the stop with the letter, and both take the first-letter color.
  const stopped = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "p", parent: 0, children: [2] },
    { id: 2, kind: "text", text: "A.", parent: 1 },
  ]);
  const stoppedTree = layout(stopped, styleTable(new Map([
    [1, makeStyle({
      display: "block", width: 400, fontSize: 16,
      firstLetterFontSize: 32, firstLetterColor: RED,
    })],
    [2, makeStyle({ fontSize: 16 })],
  ])));
  const stoppedGlyphs = fragmentOf(stoppedTree, nodeId(2))!.text?.glyphs ?? [];
  assert.equal(Number(fragmentOf(stoppedTree, nodeId(2))!.box.borderBox.width), 32);
  assert.equal(stoppedGlyphs.length, 2);
  assert.equal(Number(stoppedGlyphs[0]!.fontSize), 32);
  assert.equal(Number(stoppedGlyphs[1]!.fontSize), 32);
  assert.deepEqual(stoppedGlyphs[0]!.color, RED);
  assert.deepEqual(stoppedGlyphs[1]!.color, RED);
});

void test("::first-letter on a block styles the text of its first inline child", () => {
  // <p><span>Ab</span></p>. The span is display:inline, so the block's
  // first-letter reaches the text inside it. An inline-block is its own block
  // and stays at the body size.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "p", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "span", parent: 1, children: [3] },
    { id: 3, kind: "text", text: "Ab", parent: 2 },
  ]);
  const tree = layout(dom, styleTable(new Map([
    [1, makeStyle({ display: "block", width: 400, fontSize: 16, firstLetterFontSize: 32, firstLetterColor: RED })],
    [2, makeStyle({ display: "inline", fontSize: 16 })],
    [3, makeStyle({ fontSize: 16 })],
  ])));
  const text = fragmentOf(tree, nodeId(3))!;
  const glyphs = text.text?.glyphs ?? [];
  assert.equal(Number(text.box.borderBox.width), 24);
  assert.equal(Number(text.box.borderBox.height), 32);
  assert.equal(Number(glyphs[0]!.fontSize), 32);
  assert.equal(Number(glyphs[0]!.advance), 16);
  assert.deepEqual(glyphs[0]!.color, RED);
  assert.equal(Number(glyphs[1]!.advance), 8);
  assert.equal(glyphs[1]!.fontSize, undefined);
  assert.equal(glyphs[1]!.color, undefined);
  assert.equal(Number(fragmentOf(tree, nodeId(2))!.box.borderBox.width), 24);

  const boxed = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "p", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "span", parent: 1, children: [3] },
    { id: 3, kind: "text", text: "Ab", parent: 2 },
  ]);
  const boxedTree = layout(boxed, styleTable(new Map([
    [1, makeStyle({ display: "block", width: 400, fontSize: 16, firstLetterFontSize: 32 })],
    [2, makeStyle({ display: "inline-block", fontSize: 16 })],
    [3, makeStyle({ fontSize: 16 })],
  ])));
  const boxedGlyphs = fragmentOf(boxedTree, nodeId(3))!.text?.glyphs ?? [];
  assert.equal(boxedGlyphs[0]!.fontSize, undefined);
  assert.equal(Number(boxedGlyphs[0]!.advance), 8);

  const nested = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "p", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "b", parent: 1, children: [3] },
    { id: 3, kind: "element", tag: "span", parent: 2, children: [4] },
    { id: 4, kind: "text", text: "Ab", parent: 3 },
  ]);
  const nestedTree = layout(nested, styleTable(new Map([
    [1, makeStyle({ display: "block", width: 400, fontSize: 16, firstLetterFontSize: 32 })],
    [2, makeStyle({ display: "inline", fontSize: 16 })],
    [3, makeStyle({ display: "inline", fontSize: 16 })],
    [4, makeStyle({ fontSize: 16 })],
  ])));
  const nestedGlyphs = fragmentOf(nestedTree, nodeId(4))!.text?.glyphs ?? [];
  assert.equal(Number(nestedGlyphs[0]!.fontSize), 32);
  assert.equal(Number(nestedGlyphs[1]!.advance), 8);
});

void test("collapsible whitespace before an inline does not hide ::first-letter", () => {
  // <p> <span>Ab</span></p> — the leading space collapses, so the span's A is
  // still the first letter. A preserved newline is an empty first line, and
  // the letter on the next line stays at the body size.
  const spaced = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "p", parent: 0, children: [2, 3] },
    { id: 2, kind: "text", text: " \n ", parent: 1 },
    { id: 3, kind: "element", tag: "span", parent: 1, children: [4] },
    { id: 4, kind: "text", text: "Ab", parent: 3 },
  ]);
  const spacedTree = layout(spaced, styleTable(new Map([
    [1, makeStyle({ display: "block", width: 400, fontSize: 16, firstLetterFontSize: 32 })],
    [2, makeStyle({ fontSize: 16 })],
    [3, makeStyle({ display: "inline", fontSize: 16 })],
    [4, makeStyle({ fontSize: 16 })],
  ])));
  const spacedGlyphs = fragmentOf(spacedTree, nodeId(4))!.text?.glyphs ?? [];
  assert.equal(Number(spacedGlyphs[0]!.fontSize), 32);
  assert.equal(Number(spacedGlyphs[0]!.advance), 16);
  assert.equal(Number(spacedGlyphs[1]!.advance), 8);

  const broken = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "p", parent: 0, children: [2, 3] },
    { id: 2, kind: "text", text: "\n", parent: 1 },
    { id: 3, kind: "element", tag: "span", parent: 1, children: [4] },
    { id: 4, kind: "text", text: "Ab", parent: 3 },
  ]);
  const brokenTree = layout(broken, styleTable(new Map([
    [1, makeStyle({ display: "block", width: 400, fontSize: 16, firstLetterFontSize: 32, whiteSpace: "pre" })],
    [2, makeStyle({ fontSize: 16, whiteSpace: "pre" })],
    [3, makeStyle({ display: "inline", fontSize: 16, whiteSpace: "pre" })],
    [4, makeStyle({ fontSize: 16, whiteSpace: "pre" })],
  ])));
  const brokenGlyphs = fragmentOf(brokenTree, nodeId(4))!.text?.glyphs ?? [];
  assert.equal(brokenGlyphs[0]!.fontSize, undefined);
  assert.equal(Number(brokenGlyphs[0]!.advance), 8);
});

void test("a floated ::first-letter shortens the lines it covers", () => {
  // Width 48. The 32px "A" floats left (advance 16, height 32) and leaves 32px
  // beside it. "bb" fits there; "cc" wraps but still starts at x=16; "dd" is
  // past the float and starts at x=0.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "p", parent: 0, children: [2] },
    { id: 2, kind: "text", text: "A bb cc dd", parent: 1 },
  ]);
  const tree = layout(dom, styleTable(new Map([
    [1, makeStyle({
      display: "block", width: 48, fontSize: 16,
      firstLetterFontSize: 32, firstLetterFloat: "left",
    })],
    [2, makeStyle({ fontSize: 16 })],
  ])));
  const text = fragmentOf(tree, nodeId(2))!;
  const glyphs = text.text?.glyphs ?? [];
  assert.equal(glyphs.length, 7);
  assert.equal(Number(text.box.borderBox.height), 48);
  assert.equal(Number(glyphs[0]!.x), 0);
  assert.equal(Number(glyphs[0]!.advance), 16);
  assert.equal(Number(glyphs[0]!.fontSize), 32);
  assert.equal(Number(glyphs[1]!.x), 16);
  assert.equal(Number(glyphs[1]!.y), 0);
  assert.equal(Number(glyphs[3]!.x), 16);
  assert.equal(Number(glyphs[3]!.y), 16);
  assert.equal(Number(glyphs[5]!.x), 0);
  assert.equal(Number(glyphs[5]!.y), 32);
  assert.equal(glyphs[5]!.fontSize, undefined);
});

void test("::first-letter font-weight bolds only the first letter", () => {
  // Weight does not change the metrics advance. The first letter is 700; the
  // rest of a bold first line is 700 too, except the letter's own 900 wins.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "p", parent: 0, children: [2] },
    { id: 2, kind: "text", text: "Ab", parent: 1 },
  ]);
  const tree = layout(dom, styleTable(new Map([
    [1, makeStyle({ display: "block", width: 400, fontSize: 16, firstLetterFontWeight: 700 })],
    [2, makeStyle({ fontSize: 16 })],
  ])));
  const text = fragmentOf(tree, nodeId(2))!;
  const glyphs = text.text?.glyphs ?? [];
  assert.equal(Number(text.box.borderBox.width), 16);
  assert.equal(glyphs[0]!.fontWeight, 700);
  assert.equal(glyphs[0]!.fontSize, undefined);
  assert.equal(glyphs[1]!.fontWeight, undefined);

  const lined = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "p", parent: 0, children: [2] },
    { id: 2, kind: "text", text: "aa bb cc", parent: 1 },
  ]);
  const linedTree = layout(lined, styleTable(new Map([
    [1, makeStyle({
      display: "block", width: 40, fontSize: 16,
      firstLetterFontWeight: 900, firstLineFontWeight: 700,
    })],
    [2, makeStyle({ fontSize: 16 })],
  ])));
  const linedGlyphs = fragmentOf(linedTree, nodeId(2))!.text?.glyphs ?? [];
  assert.equal(linedGlyphs[0]!.fontWeight, 900);
  assert.equal(linedGlyphs[1]!.fontWeight, 700);
  assert.equal(Number(linedGlyphs[4]!.y), 16);
  assert.equal(linedGlyphs[4]!.fontWeight, undefined);
});

void test("::first-letter font-style italicizes only the first letter", () => {
  // Style does not change the metrics advance. The letter is italic; the rest
  // of an oblique first line stays oblique, and the next line stays upright.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "p", parent: 0, children: [2] },
    { id: 2, kind: "text", text: "Ab", parent: 1 },
  ]);
  const tree = layout(dom, styleTable(new Map([
    [1, makeStyle({ display: "block", width: 400, fontSize: 16, firstLetterFontStyle: "italic" })],
    [2, makeStyle({ fontSize: 16 })],
  ])));
  const text = fragmentOf(tree, nodeId(2))!;
  const glyphs = text.text?.glyphs ?? [];
  assert.equal(Number(text.box.borderBox.width), 16);
  assert.equal(glyphs[0]!.fontStyle, "italic");
  assert.equal(glyphs[1]!.fontStyle, undefined);

  const lined = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "p", parent: 0, children: [2] },
    { id: 2, kind: "text", text: "aa bb cc", parent: 1 },
  ]);
  const linedTree = layout(lined, styleTable(new Map([
    [1, makeStyle({
      display: "block", width: 40, fontSize: 16,
      firstLetterFontStyle: "italic", firstLineFontStyle: "oblique",
    })],
    [2, makeStyle({ fontSize: 16 })],
  ])));
  const linedGlyphs = fragmentOf(linedTree, nodeId(2))!.text?.glyphs ?? [];
  assert.equal(linedGlyphs[0]!.fontStyle, "italic");
  assert.equal(linedGlyphs[1]!.fontStyle, "oblique");
  assert.equal(Number(linedGlyphs[4]!.y), 16);
  assert.equal(linedGlyphs[4]!.fontStyle, undefined);
});

void test("::first-letter text-transform uppercases only the first letter", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "p", parent: 0, children: [2] },
    { id: 2, kind: "text", text: "ab", parent: 1 },
  ]);
  const tree = layout(dom, styleTable(new Map([
    [1, makeStyle({ display: "block", width: 400, fontSize: 16, firstLetterTextTransform: "uppercase" })],
    [2, makeStyle({ fontSize: 16 })],
  ])));
  const glyphs = fragmentOf(tree, nodeId(2))!.text?.glyphs ?? [];
  assert.equal(glyphs[0]!.glyphId, 65);
  assert.equal(glyphs[1]!.glyphId, 98);
});

void test("::first-line word-spacing widens only the first line", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "p", parent: 0, children: [2] },
    { id: 2, kind: "text", text: "aa bb cc", parent: 1 },
  ]);
  const tree = layout(dom, styleTable(new Map([
    [1, makeStyle({ display: "block", width: 48, fontSize: 16, firstLineWordSpacing: 8 })],
    [2, makeStyle({ fontSize: 16 })],
  ])));
  const glyphs = fragmentOf(tree, nodeId(2))!.text?.glyphs ?? [];
  assert.equal(Number(glyphs[2]!.x), 32);
  assert.equal(Number(glyphs[4]!.y), 16);
  assert.equal(Number(glyphs[4]!.x), 0);
});

void test("::first-line line-height grows only the first line box", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "p", parent: 0, children: [2] },
    { id: 2, kind: "text", text: "aa bb cc", parent: 1 },
  ]);
  const tree = layout(dom, styleTable(new Map([
    [1, makeStyle({ display: "block", width: 40, fontSize: 16, firstLineLineHeight: 32 })],
    [2, makeStyle({ fontSize: 16 })],
  ])));
  const text = fragmentOf(tree, nodeId(2))!;
  const glyphs = text.text?.glyphs ?? [];
  assert.equal(Number(text.box.borderBox.height), 48);
  assert.equal(Number(glyphs[4]!.y), 32);
});

void test("::first-letter vertical-align:super raises the letter", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "p", parent: 0, children: [2] },
    { id: 2, kind: "text", text: "Ab", parent: 1 },
  ]);
  const tree = layout(dom, styleTable(new Map([
    [1, makeStyle({ display: "block", width: 400, fontSize: 16, firstLetterVerticalAlign: "super" })],
    [2, makeStyle({ fontSize: 16 })],
  ])));
  const glyphs = fragmentOf(tree, nodeId(2))!.text?.glyphs ?? [];
  assert.equal(Number(glyphs[0]!.y), -16 * 0.33);
  assert.equal(Number(glyphs[1]!.y), 0);
});

void test("vertical-align:super uses the shaper superscript em", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "p", parent: 0, children: [2, 3] },
    { id: 2, kind: "text", text: "A", parent: 1 },
    { id: 3, kind: "text", text: "B", parent: 1 },
  ]);
  const tree = layout(dom, styleTable(new Map([
    [1, makeStyle({ display: "block", width: 400, fontSize: 16 })],
    [2, makeStyle({ fontSize: 16 })],
    [3, makeStyle({ fontSize: 16, verticalAlign: "super" })],
  ])), {
    shaper: {
      shapeLine: metricsShaper.shapeLine.bind(metricsShaper),
      fontMetrics: () => ({ superscriptEm: 0.5 }),
    },
  });
  const plain = fragmentOf(tree, nodeId(2))!;
  const raised = fragmentOf(tree, nodeId(3))!;
  assert.equal(Number(plain.box.borderBox.y) - Number(raised.box.borderBox.y), 8);
});

void test("a floated ::first-letter intrudes into the following block", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 4] },
    { id: 2, kind: "element", tag: "p", parent: 1, children: [3] },
    { id: 3, kind: "text", text: "A", parent: 2 },
    { id: 4, kind: "element", tag: "p", parent: 1, children: [5] },
    { id: 5, kind: "text", text: "B", parent: 4 },
  ]);
  const tree = layout(dom, styleTable(new Map([
    [1, makeStyle({ display: "block", width: 200, fontSize: 16 })],
    [2, makeStyle({ display: "block", width: 200, fontSize: 16, firstLetterFloat: "left", firstLetterFontSize: 32 })],
    [3, makeStyle({ fontSize: 16 })],
    [4, makeStyle({ display: "block", width: 200, fontSize: 16 })],
    [5, makeStyle({ fontSize: 16 })],
  ])));
  const next = fragmentOf(tree, nodeId(5))!;
  assert.equal(Number(next.box.borderBox.x), 16);
});

void test("inline text wraps onto the parent's next line", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "p", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "span", parent: 1, children: [3] },
    { id: 3, kind: "text", text: "aa bb cc", parent: 2 },
  ]);
  const tree = layout(dom, styleTable(new Map([
    [1, makeStyle({ display: "block", width: 40, fontSize: 16 })],
    [2, makeStyle({ display: "inline", fontSize: 16 })],
    [3, makeStyle({ fontSize: 16 })],
  ])));
  const text = fragmentOf(tree, nodeId(3))!;
  const span = fragmentOf(tree, nodeId(2))!;
  assert.equal(Number(text.box.borderBox.height), 32);
  assert.equal(Number((text.text?.glyphs ?? [])[4]!.y), 16);
  assert.equal(Number(span.box.borderBox.height), 32);
  assert.equal(Number(span.box.borderBox.width), 40);
});

void test("nested inline text wraps onto the parent's next line", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "p", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "b", parent: 1, children: [3] },
    { id: 3, kind: "element", tag: "span", parent: 2, children: [4] },
    { id: 4, kind: "text", text: "aa bb cc", parent: 3 },
  ]);
  const tree = layout(dom, styleTable(new Map([
    [1, makeStyle({ display: "block", width: 40, fontSize: 16 })],
    [2, makeStyle({ display: "inline", fontSize: 16 })],
    [3, makeStyle({ display: "inline", fontSize: 16 })],
    [4, makeStyle({ fontSize: 16 })],
  ])));
  const text = fragmentOf(tree, nodeId(4))!;
  const outer = fragmentOf(tree, nodeId(2))!;
  const inner = fragmentOf(tree, nodeId(3))!;
  assert.equal(Number((text.text?.glyphs ?? [])[4]!.y), 16);
  assert.equal(Number(outer.box.borderBox.height), 32);
  assert.equal(Number(outer.box.borderBox.width), 40);
  assert.equal(Number(inner.box.borderBox.height), 32);
  assert.equal(Number(inner.box.borderBox.width), 40);
  assert.equal(outer.children.length, 1);
  assert.equal(tree.fragments.get(outer.children[0]!)!.node, nodeId(3));
});

void test("::first-letter underline sits under the letter", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "p", parent: 0, children: [2] },
    { id: 2, kind: "text", text: "Ab", parent: 1 },
  ]);
  const tree = layout(dom, styleTable(new Map([
    [1, makeStyle({
      display: "block", width: 400, fontSize: 16,
      firstLetterTextDecoration: { line: "underline" },
    })],
    [2, makeStyle({ fontSize: 16 })],
  ])));
  const marks = fragmentOf(tree, nodeId(2))!.text?.decorations ?? [];
  assert.equal(marks.length, 1);
  assert.equal(marks[0]!.line, "underline");
  assert.equal(Number(marks[0]!.x), 0);
  assert.equal(Number(marks[0]!.width), 8);
  assert.equal(Number(marks[0]!.y), 16 * 0.9);
});

void test("::first-letter letter-spacing widens only the first letter", () => {
  // Body advance is 8. Spacing 4 adds 4 after the letter, so A is 12 and b stays 8.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "p", parent: 0, children: [2] },
    { id: 2, kind: "text", text: "Ab", parent: 1 },
  ]);
  const tree = layout(dom, styleTable(new Map([
    [1, makeStyle({ display: "block", width: 400, fontSize: 16, firstLetterLetterSpacing: 4 })],
    [2, makeStyle({ fontSize: 16 })],
  ])));
  const glyphs = fragmentOf(tree, nodeId(2))!.text?.glyphs ?? [];
  assert.equal(Number(fragmentOf(tree, nodeId(2))!.box.borderBox.width), 20);
  assert.equal(Number(glyphs[0]!.advance), 12);
  assert.equal(Number(glyphs[1]!.advance), 8);

  // Line spacing 4 makes "aa"/"bb" 24 wide, so they fill a 56px line and "cc"
  // wraps at the body advance. The letter's own spacing 10 wins on the first glyph.
  const lined = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "p", parent: 0, children: [2] },
    { id: 2, kind: "text", text: "aa bb cc", parent: 1 },
  ]);
  const linedTree = layout(lined, styleTable(new Map([
    [1, makeStyle({
      display: "block", width: 56, fontSize: 16,
      firstLetterLetterSpacing: 10, firstLineLetterSpacing: 4,
    })],
    [2, makeStyle({ fontSize: 16 })],
  ])));
  const linedGlyphs = fragmentOf(linedTree, nodeId(2))!.text?.glyphs ?? [];
  assert.equal(Number(linedGlyphs[0]!.advance), 18);
  assert.equal(Number(linedGlyphs[1]!.advance), 12);
  assert.equal(Number(linedGlyphs[4]!.y), 16);
  assert.equal(Number(linedGlyphs[4]!.advance), 8);
});

void test("::first-letter margin insets the letter and pushes the following text", () => {
  // Left 4 and right 6 sit outside the 8px advance, so A starts at x=4 and b
  // at x=18. Top 10 and bottom 2 grow the line to 28 and drop the letter.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "p", parent: 0, children: [2] },
    { id: 2, kind: "text", text: "Ab", parent: 1 },
  ]);
  const tree = layout(dom, styleTable(new Map([
    [1, makeStyle({
      display: "block", width: 400, fontSize: 16,
      firstLetterMargin: { top: 10, right: 6, bottom: 2, left: 4 },
    })],
    [2, makeStyle({ fontSize: 16 })],
  ])));
  const text = fragmentOf(tree, nodeId(2))!;
  const glyphs = text.text?.glyphs ?? [];
  assert.equal(Number(text.box.borderBox.width), 26);
  assert.equal(Number(text.box.borderBox.height), 28);
  assert.equal(Number(glyphs[0]!.x), 4);
  assert.equal(Number(glyphs[0]!.y), 10);
  assert.equal(Number(glyphs[0]!.advance), 8);
  assert.equal(Number(glyphs[1]!.x), 18);
  assert.equal(Number(glyphs[1]!.y), 0);
});

void test("::first-letter padding sits inside the margin", () => {
  // Margin 4/6 and padding 3/5 stack. A starts at 7; b starts after the 8px
  // advance plus padding-right and margin-right. Top padding drops the letter.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "p", parent: 0, children: [2] },
    { id: 2, kind: "text", text: "Ab", parent: 1 },
  ]);
  const tree = layout(dom, styleTable(new Map([
    [1, makeStyle({
      display: "block", width: 400, fontSize: 16,
      firstLetterMargin: { top: 0, right: 6, bottom: 0, left: 4 },
      firstLetterPadding: { top: 2, right: 5, bottom: 1, left: 3 },
    })],
    [2, makeStyle({ fontSize: 16 })],
  ])));
  const text = fragmentOf(tree, nodeId(2))!;
  const glyphs = text.text?.glyphs ?? [];
  assert.equal(Number(text.box.borderBox.width), 34);
  assert.equal(Number(text.box.borderBox.height), 19);
  assert.equal(Number(glyphs[0]!.x), 7);
  assert.equal(Number(glyphs[0]!.y), 2);
  assert.equal(Number(glyphs[1]!.x), 26);
});

void test("::first-letter border sits between the margin and the padding", () => {
  // Outside-in: margin 4/6, border 2, padding 3/5. A starts at 9. The border
  // box begins after the margin and wraps padding plus the 8px advance.
  const red = { r: 255, g: 0, b: 0, a: 1 };
  const edge = { width: 2, style: "solid" as const, color: red };
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "p", parent: 0, children: [2] },
    { id: 2, kind: "text", text: "Ab", parent: 1 },
  ]);
  const tree = layout(dom, styleTable(new Map([
    [1, makeStyle({
      display: "block", width: 400, fontSize: 16,
      firstLetterMargin: { top: 0, right: 6, bottom: 0, left: 4 },
      firstLetterPadding: { top: 2, right: 5, bottom: 1, left: 3 },
      firstLetterBorder: { top: edge, right: edge, bottom: edge, left: edge },
    })],
    [2, makeStyle({ fontSize: 16 })],
  ])));
  const text = fragmentOf(tree, nodeId(2))!;
  const glyphs = text.text?.glyphs ?? [];
  const frame = text.text?.letterBorder;
  assert.equal(Number(text.box.borderBox.width), 38);
  assert.equal(Number(text.box.borderBox.height), 23);
  assert.equal(Number(glyphs[0]!.x), 9);
  assert.equal(Number(glyphs[0]!.y), 4);
  assert.equal(Number(glyphs[1]!.x), 30);
  assert.ok(frame !== undefined);
  assert.equal(Number(frame.x), 4);
  assert.equal(Number(frame.y), 0);
  assert.equal(Number(frame.width), 20);
  assert.equal(Number(frame.height), 23);
  assert.equal(Number(frame.left.width), 2);
  assert.equal(frame.left.style, "solid");
});

void test("::first-letter background fills the border box", () => {
  // A 2px border makes the border box 12×20. The fill covers that box, under
  // the border, while the glyph stays inset by the border width.
  const red = { r: 255, g: 0, b: 0, a: 1 };
  const edge = { width: 2, style: "solid" as const, color: red };
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "p", parent: 0, children: [2] },
    { id: 2, kind: "text", text: "Ab", parent: 1 },
  ]);
  const tree = layout(dom, styleTable(new Map([
    [1, makeStyle({
      display: "block", width: 400, fontSize: 16,
      firstLetterBorder: { top: edge, right: edge, bottom: edge, left: edge },
      firstLetterBackgroundColor: red,
    })],
    [2, makeStyle({ fontSize: 16 })],
  ])));
  const text = fragmentOf(tree, nodeId(2))!;
  const glyphs = text.text?.glyphs ?? [];
  const fill = text.text?.letterBackground;
  assert.equal(Number(glyphs[0]!.x), 2);
  assert.equal(Number(glyphs[0]!.y), 2);
  assert.ok(fill !== undefined);
  assert.equal(Number(fill.x), 0);
  assert.equal(Number(fill.y), 0);
  assert.equal(Number(fill.width), 12);
  assert.equal(Number(fill.height), 20);
  assert.deepEqual(fill.color, red);
});

void test("::first-line background covers only the first line", () => {
  // "aa bb" is 40px wide at 16px, so "cc" wraps. The fill is that first line
  // and does not continue onto the second.
  const red = { r: 255, g: 0, b: 0, a: 1 };
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "p", parent: 0, children: [2] },
    { id: 2, kind: "text", text: "aa bb cc", parent: 1 },
  ]);
  const tree = layout(dom, styleTable(new Map([
    [1, makeStyle({
      display: "block", width: 40, fontSize: 16,
      firstLineBackgroundColor: red,
    })],
    [2, makeStyle({ fontSize: 16 })],
  ])));
  const text = fragmentOf(tree, nodeId(2))!;
  const glyphs = text.text?.glyphs ?? [];
  const fill = text.text?.lineBackground;
  assert.equal(Number(glyphs[0]!.x), 0);
  assert.equal(Number(glyphs[0]!.y), 0);
  assert.equal(Number(glyphs[2]!.x), 24);
  assert.equal(Number(glyphs[4]!.y), 16);
  assert.ok(fill !== undefined);
  assert.equal(Number(fill.x), 0);
  assert.equal(Number(fill.y), 0);
  assert.equal(Number(fill.width), 40);
  assert.equal(Number(fill.height), 16);
  assert.deepEqual(fill.color, red);
});

void test("::first-letter background-image uses the border box and the padding box", () => {
  // A 2px border makes the clip 12×20 and the padding-box origin 8×16, inset
  // by that border. The glyph stays inside the padding edge.
  const edge = { width: 2, style: "solid" as const, color: { r: 255, g: 0, b: 0, a: 1 } };
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "p", parent: 0, children: [2] },
    { id: 2, kind: "text", text: "Ab", parent: 1 },
  ]);
  const tree = layout(dom, styleTable(new Map([
    [1, makeStyle({
      display: "block", width: 400, fontSize: 16,
      firstLetterBorder: { top: edge, right: edge, bottom: edge, left: edge },
      firstLetterBackgroundImage: {
        image: "url(dot.png)",
        repeat: "no-repeat",
        size: "auto",
        position: "0% 0%",
      },
    })],
    [2, makeStyle({ fontSize: 16 })],
  ])));
  const text = fragmentOf(tree, nodeId(2))!;
  const image = text.text?.letterImage;
  assert.equal(Number(text.text?.glyphs[0]!.x), 2);
  assert.ok(image !== undefined);
  assert.equal(Number(image.x), 0);
  assert.equal(Number(image.y), 0);
  assert.equal(Number(image.width), 12);
  assert.equal(Number(image.height), 20);
  assert.equal(Number(image.originX), 2);
  assert.equal(Number(image.originY), 2);
  assert.equal(Number(image.originWidth), 8);
  assert.equal(Number(image.originHeight), 16);
  assert.equal(image.image, "url(dot.png)");
  assert.equal(image.repeat, "no-repeat");
});

void test("::first-line background-image covers only the first line", () => {
  // "aa bb" is 40px wide at 16px, so "cc" wraps. The image box is that first
  // line; clip and position origin are the same rectangle.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "p", parent: 0, children: [2] },
    { id: 2, kind: "text", text: "aa bb cc", parent: 1 },
  ]);
  const tree = layout(dom, styleTable(new Map([
    [1, makeStyle({
      display: "block", width: 40, fontSize: 16,
      firstLineBackgroundImage: {
        image: "url(dot.png)",
        repeat: "no-repeat",
        size: "auto",
        position: "0% 0%",
      },
    })],
    [2, makeStyle({ fontSize: 16 })],
  ])));
  const text = fragmentOf(tree, nodeId(2))!;
  const glyphs = text.text?.glyphs ?? [];
  const image = text.text?.lineImage;
  assert.equal(Number(glyphs[4]!.y), 16);
  assert.equal(text.text?.letterImage, undefined);
  assert.ok(image !== undefined);
  assert.equal(Number(image.x), 0);
  assert.equal(Number(image.y), 0);
  assert.equal(Number(image.width), 40);
  assert.equal(Number(image.height), 16);
  assert.equal(Number(image.originX), 0);
  assert.equal(Number(image.originY), 0);
  assert.equal(Number(image.originWidth), 40);
  assert.equal(Number(image.originHeight), 16);
  assert.equal(image.image, "url(dot.png)");
  assert.equal(image.repeat, "no-repeat");
});

void test("vertical-align:super on a text run lifts that run and not the sibling text", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "p", parent: 0, children: [2, 3] },
    { id: 2, kind: "text", text: "A", parent: 1 },
    { id: 3, kind: "text", text: "B", parent: 1 },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 400, fontSize: 16 })],
      [2, makeStyle({ fontSize: 16 })],
      [3, makeStyle({ fontSize: 16, verticalAlign: "super" })],
    ]),
  );
  const tree = layout(dom, styles);
  const plain = fragmentOf(tree, nodeId(2))!;
  const raised = fragmentOf(tree, nodeId(3))!;
  assert.equal(
    Number(plain.box.borderBox.y) - Number(raised.box.borderBox.y),
    16 * 0.33,
    "the superscript text run sits 0.33em above the sibling run",
  );
});

// ===========================================================================
// GRID (Phase 1b) — auto-flow / row tracks / spans / cell alignment
// ===========================================================================

void test("grid-template-rows sizes rows; align-content:stretch grows auto rows to the container", () => {
  // height:200 container, rows `60px auto` — the auto row is content-sized then
  // stretched to consume the leftover (stretch is the initial align-content).
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({
        display: "grid", width: 100, height: 200,
        "grid-template-columns": "1fr",
        "grid-template-rows": "60px auto",
      })],
      [2, makeStyle({ display: "block" })],
      [3, makeStyle({ display: "block" })],
    ]),
  );
  const tree = layout(dom, styles);
  const a = fragmentOf(tree, nodeId(2))!;
  const b = fragmentOf(tree, nodeId(3))!;
  assert.equal(Number(a.box.borderBox.height), 60, "fixed row keeps its 60px");
  assert.equal(Number(b.box.borderBox.y), 60, "second row starts after the first");
  assert.equal(Number(b.box.borderBox.height), 140, "auto row stretched to fill 200-60");
});

void test("minmax(50px,25%) resolves against the container; % tracks use the content width", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({
        display: "grid", width: 400,
        "grid-template-columns": "minmax(50px, 25%) 1fr",
      })],
      [2, makeStyle({ display: "block" })],
      [3, makeStyle({ display: "block" })],
    ]),
  );
  const tree = layout(dom, styles);
  const a = fragmentOf(tree, nodeId(2))!;
  const b = fragmentOf(tree, nodeId(3))!;
  assert.equal(Number(a.box.borderBox.width), 100, "minmax(50,25%)→max(50,100)=100");
  assert.equal(Number(b.box.borderBox.x), 100, "second track starts at 100");
  assert.equal(Number(b.box.borderBox.width), 300, "1fr takes the leftover");
});

void test("grid-auto-flow:column fills rows within a column then moves to an implicit column", () => {
  // Explicit `grid-template-rows: 2` bounds the column; the fifth item wraps to
  // column 3 — an IMPLICIT column sized by `grid-auto-columns`.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3, 4, 5, 6] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 4, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 5, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 6, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({
        display: "grid", width: 300,
        "grid-auto-flow": "column",
        "grid-template-columns": "80px 80px",
        "grid-template-rows": "20px 20px",
        "grid-auto-columns": "60px",
      })],
      [2, makeStyle({ display: "block" })],
      [3, makeStyle({ display: "block" })],
      [4, makeStyle({ display: "block" })],
      [5, makeStyle({ display: "block" })],
      [6, makeStyle({ display: "block" })],
    ]),
  );
  const tree = layout(dom, styles);
  const a = fragmentOf(tree, nodeId(2))!;
  const b = fragmentOf(tree, nodeId(3))!;
  const c = fragmentOf(tree, nodeId(4))!;
  const d = fragmentOf(tree, nodeId(5))!;
  const e = fragmentOf(tree, nodeId(6))!;
  assert.equal(Number(a.box.borderBox.x), 0);
  assert.equal(Number(a.box.borderBox.y), 0);
  assert.equal(Number(b.box.borderBox.x), 0, "item2 fills row 2 of column 1");
  assert.equal(Number(b.box.borderBox.y), 20);
  assert.equal(Number(c.box.borderBox.x), 80, "item3 wraps to column 2");
  assert.equal(Number(c.box.borderBox.y), 0);
  assert.equal(Number(d.box.borderBox.y), 20, "item4 fills row 2 of column 2");
  assert.equal(Number(e.box.borderBox.x), 160, "item5 reaches the IMPLICIT third column");
  assert.equal(Number(e.box.borderBox.width), 60, "implicit column uses grid-auto-columns");
});

void test("grid-auto-flow:dense back-fills holes left by spanning items", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3, 4] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 4, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({
        display: "grid", width: 300,
        "grid-auto-flow": "dense",
        "grid-template-columns": "100px 100px 100px",
      })],
      [2, makeStyle({ display: "block", "grid-column": "span 2", height: 10 })],
      [3, makeStyle({ display: "block", "grid-column": "span 2", height: 10 })],
      [4, makeStyle({ display: "block", height: 10 })],
    ]),
  );
  const tree = layout(dom, styles);
  const wide2 = fragmentOf(tree, nodeId(3))!;
  const filler = fragmentOf(tree, nodeId(4))!;
  assert.equal(Number(wide2.box.borderBox.x), 0, "second span-2 lands on row 2");
  assert.equal(Number(wide2.box.borderBox.y), 10);
  assert.equal(Number(filler.box.borderBox.x), 200, "dense back-fills the (200,0) hole");
  assert.equal(Number(filler.box.borderBox.y), 0);
});

void test("justify-self/align-self position a non-stretch cell inside its area", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({
        display: "grid", width: 200, height: 100,
        "grid-template-columns": "1fr", "grid-template-rows": "1fr",
        "justify-items": "end",
      })],
      [2, makeStyle({ display: "block", width: 50, height: 20, "align-self": "center" })],
    ]),
  );
  const tree = layout(dom, styles);
  const cell = fragmentOf(tree, nodeId(2))!;
  assert.equal(Number(cell.box.borderBox.x), 150, "justify-items:end → flush right");
  assert.equal(Number(cell.box.borderBox.width), 50, "declared width kept under end");
  assert.equal(Number(cell.box.borderBox.y), 40, "align-self:center → (100-20)/2");
});

void test("row-spanning grid cell fills its band and shares overflow across auto rows", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3, 4] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 4, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({
        display: "grid", width: 200,
        "grid-template-columns": "100px 100px",
        "grid-template-rows": "auto auto",
      })],
      [2, makeStyle({ display: "block", "grid-row": "1 / 3", height: 50 })],
      [3, makeStyle({ display: "block", height: 10 })],
      [4, makeStyle({ display: "block", height: 10 })],
    ]),
  );
  const tree = layout(dom, styles);
  const spanner = fragmentOf(tree, nodeId(2))!;
  const r2 = fragmentOf(tree, nodeId(4))!;
  assert.equal(Number(spanner.box.borderBox.height), 50, "spanner keeps its height");
  // Two auto rows of 10 leave 30 uncovered → +15 each.
  assert.equal(Number(r2.box.borderBox.y), 25, "row 2 starts after row 1's 25");
});

// ===========================================================================
// TABLE (Phase 1b) — row groups / spans / border-spacing / vertical-align
// ===========================================================================

void test("table: thead/tbody group fragments wrap their rows with correct band heights", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "table", parent: 0, children: [8, 9] },
    { id: 8, kind: "element", tag: "thead", parent: 1, children: [2] },
    { id: 2, kind: "element", tag: "tr", parent: 8, children: [3] },
    { id: 3, kind: "element", tag: "th", parent: 2, children: [] },
    { id: 9, kind: "element", tag: "tbody", parent: 1, children: [5] },
    { id: 5, kind: "element", tag: "tr", parent: 9, children: [6] },
    { id: 6, kind: "element", tag: "td", parent: 5, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "table", width: 100, "border-collapse": "collapse" })],
      [8, makeStyle({ display: "table-header-group" })],
      [9, makeStyle({ display: "table-row-group" })],
      [2, makeStyle({ display: "table-row" })],
      [5, makeStyle({ display: "table-row" })],
      [3, makeStyle({ display: "table-cell", height: 10 })],
      [6, makeStyle({ display: "table-cell", height: 20 })],
    ]),
  );
  const tree = layout(dom, styles);
  const thead = fragmentOf(tree, nodeId(8))!;
  const tbody = fragmentOf(tree, nodeId(9))!;
  const th = fragmentOf(tree, nodeId(3))!;
  const td = fragmentOf(tree, nodeId(6))!;
  assert.equal(Number(thead.box.borderBox.y), 0);
  assert.equal(Number(thead.box.borderBox.height), 10, "group band = its row");
  assert.equal(Number(tbody.box.borderBox.y), 10, "tbody follows thead");
  assert.equal(Number(tbody.box.borderBox.height), 20);
  assert.equal(Number(th.box.borderBox.width), 100, "single cell spans the table");
  assert.equal(Number(td.box.borderBox.y), 0, "cell coords are row-local");
  // Cells hang under row fragments, rows under groups.
  const rowFrag = fragmentOf(tree, nodeId(5))!;
  const rowChildren = rowFrag.children.map((id) => tree.fragments.get(id)!.node);
  assert.deepEqual(rowChildren, [nodeId(6)], "row owns its cell fragment");
});

void test("table colspan occupies two columns; rowspan distributes band height across rows", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "table", parent: 0, children: [2, 5] },
    { id: 2, kind: "element", tag: "tr", parent: 1, children: [3, 4] },
    { id: 3, kind: "element", tag: "td", parent: 2, children: [], attrs: { colspan: "2" } },
    { id: 4, kind: "element", tag: "td", parent: 2, children: [] },
    { id: 5, kind: "element", tag: "tr", parent: 1, children: [6] },
    { id: 6, kind: "element", tag: "td", parent: 5, children: [], attrs: { rowspan: "2" } },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "table", width: 300 })],
      [2, makeStyle({ display: "table-row" })],
      [5, makeStyle({ display: "table-row" })],
      [3, makeStyle({ display: "table-cell", height: 10 })],
      [4, makeStyle({ display: "table-cell", height: 10 })],
      [6, makeStyle({ display: "table-cell", height: 50 })],
    ]),
  );
  const tree = layout(dom, styles);
  const wide = fragmentOf(tree, nodeId(3))!;
  const c4 = fragmentOf(tree, nodeId(4))!;
  const tall = fragmentOf(tree, nodeId(6))!;
  assert.equal(Number(wide.box.borderBox.width), 200, "colspan 2 ⇒ two of three 100px columns");
  assert.equal(Number(c4.box.borderBox.x), 200, "third column starts after the span");
  // tall spans rows 0..1: band = row0 + row1. row0=10 (cells), row1 must give
  // tall 50 total ⇒ row1 = 40.
  assert.equal(Number(tall.box.borderBox.height), 50, "rowspan cell fills its band");
});

void test("table border-spacing separates cells AND insets them from the table edge", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "table", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "tr", parent: 1, children: [3, 4] },
    { id: 3, kind: "element", tag: "td", parent: 2, children: [] },
    { id: 4, kind: "element", tag: "td", parent: 2, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "table", width: 210, "border-spacing": "10px 4px" })],
      [2, makeStyle({ display: "table-row" })],
      [3, makeStyle({ display: "table-cell", height: 20 })],
      [4, makeStyle({ display: "table-cell", height: 20 })],
    ]),
  );
  const tree = layout(dom, styles);
  const table = fragmentOf(tree, nodeId(1))!;
  const a = fragmentOf(tree, nodeId(3))!;
  const b = fragmentOf(tree, nodeId(4))!;
  assert.equal(Number(a.box.borderBox.x), 10, "left edge spacing");
  // avail = 210 - 10*3 = 180 → 90 per column; cell b x = 10+90+10 = 110.
  assert.equal(Number(a.box.borderBox.width), 90);
  assert.equal(Number(b.box.borderBox.x), 110, "edge + col + inner spacing");
  // table content height = 4 (top) + 20 (row) + 4 (bottom) = 28.
  assert.equal(Number(table.box.borderBox.height), 28, "spacing wraps the grid");
});

void test("table vertical-align:middle centers short content inside the row band", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "table", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "tr", parent: 1, children: [3, 4] },
    { id: 3, kind: "element", tag: "td", parent: 2, children: [7] },
    { id: 4, kind: "element", tag: "td", parent: 2, children: [] },
    { id: 7, kind: "element", tag: "div", parent: 3, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "table", width: 200 })],
      [2, makeStyle({ display: "table-row" })],
      [3, makeStyle({ display: "table-cell", verticalAlign: "middle" })],
      [4, makeStyle({ display: "table-cell", height: 40 })],
      [7, makeStyle({ display: "block", height: 10 })],
    ]),
  );
  const tree = layout(dom, styles);
  const cell = fragmentOf(tree, nodeId(3))!;
  const inner = fragmentOf(tree, nodeId(7))!;
  assert.equal(Number(cell.box.borderBox.height), 40, "cell fills the 40px band");
  assert.equal(Number(inner.box.borderBox.y), 15, "middle: (40-10)/2 inside the cell");
});

void test("table cells with vertical-align:baseline share the row's first-line baseline", () => {
  // Ascent is 0.8em. A 10px font baselines at 8; a 20px font baselines at 16.
  // The row baseline is 16, so the smaller run shifts down by 8.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "table", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "tr", parent: 1, children: [3, 4] },
    { id: 3, kind: "element", tag: "td", parent: 2, children: [5] },
    { id: 4, kind: "element", tag: "td", parent: 2, children: [6] },
    { id: 5, kind: "text", text: "a", parent: 3 },
    { id: 6, kind: "text", text: "b", parent: 4 },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "table", width: 200 })],
      [2, makeStyle({ display: "table-row" })],
      [3, makeStyle({ display: "table-cell", verticalAlign: "baseline" })],
      [4, makeStyle({ display: "table-cell", verticalAlign: "baseline" })],
      [5, makeStyle({ fontSize: 10 })],
      [6, makeStyle({ fontSize: 20 })],
    ]),
  );
  const tree = layout(dom, styles);
  const small = fragmentOf(tree, nodeId(5))!;
  const large = fragmentOf(tree, nodeId(6))!;
  assert.equal(Number(large.box.borderBox.y), 0, "the deeper baseline stays at the row top");
  assert.equal(Number(small.box.borderBox.y), 8, "10px run drops so its baseline meets the 20px run");
});

void test("table-layout:fixed takes column widths from the FIRST row only", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "table", parent: 0, children: [2, 5] },
    { id: 2, kind: "element", tag: "tr", parent: 1, children: [3, 4] },
    { id: 3, kind: "element", tag: "td", parent: 2, children: [] },
    { id: 4, kind: "element", tag: "td", parent: 2, children: [] },
    { id: 5, kind: "element", tag: "tr", parent: 1, children: [6, 7] },
    { id: 6, kind: "element", tag: "td", parent: 5, children: [] },
    { id: 7, kind: "element", tag: "td", parent: 5, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "table", width: 300, "table-layout": "fixed" })],
      [2, makeStyle({ display: "table-row" })],
      [5, makeStyle({ display: "table-row" })],
      [3, makeStyle({ display: "table-cell", width: 60, height: 10 })],
      [4, makeStyle({ display: "table-cell", height: 10 })],
      [6, makeStyle({ display: "table-cell", width: 200, height: 10 })],
      [7, makeStyle({ display: "table-cell", height: 10 })],
    ]),
  );
  const tree = layout(dom, styles);
  const r2c1 = fragmentOf(tree, nodeId(6))!;
  const r2c2 = fragmentOf(tree, nodeId(7))!;
  // Fixed layout: col0 = 60 (first row), col1 = 300-60 = 240; the second row's
  // width:200 is ignored.
  assert.equal(Number(r2c1.box.borderBox.width), 60, "first row wins: col0 = 60");
  assert.equal(Number(r2c2.box.borderBox.x), 60);
  assert.equal(Number(r2c2.box.borderBox.width), 240, "remaining width to the free column");
});

void test("table caption sits above the row grid by default and below it when caption-side is bottom", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "table", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "caption", parent: 1, children: [] },
    { id: 3, kind: "element", tag: "tr", parent: 1, children: [4] },
    { id: 4, kind: "element", tag: "td", parent: 3, children: [] },
  ]);
  const topStyles = styleTable(
    new Map([
      [1, makeStyle({ display: "table", width: 200 })],
      [2, makeStyle({ display: "table-caption", height: 20 })],
      [3, makeStyle({ display: "table-row" })],
      [4, makeStyle({ display: "table-cell", height: 30 })],
    ]),
  );
  const top = layout(dom, topStyles);
  const topCaption = fragmentOf(top, nodeId(2));
  const topRow = fragmentOf(top, nodeId(3))!;
  assert.ok(topCaption !== undefined, "caption produces a fragment");
  assert.equal(Number(topCaption.box.borderBox.y), 0, "default caption-side is top");
  assert.equal(Number(topCaption.box.borderBox.height), 20);
  assert.equal(Number(topRow.box.borderBox.y), 20, "row grid starts below the caption");
  assert.equal(Number(fragmentOf(top, nodeId(1))!.box.borderBox.height), 50, "table height includes the caption");

  const bottomStyles = styleTable(
    new Map([
      [1, makeStyle({ display: "table", width: 200 })],
      [2, makeStyle({ display: "table-caption", height: 20, "caption-side": "bottom" })],
      [3, makeStyle({ display: "table-row" })],
      [4, makeStyle({ display: "table-cell", height: 30 })],
    ]),
  );
  const bottom = layout(dom, bottomStyles);
  const bottomCaption = fragmentOf(bottom, nodeId(2))!;
  const bottomRow = fragmentOf(bottom, nodeId(3))!;
  assert.equal(Number(bottomRow.box.borderBox.y), 0, "row grid stays at the top");
  assert.equal(Number(bottomCaption.box.borderBox.y), 30, "bottom caption follows the grid");
});

void test("col and colgroup widths seed table columns, including span", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "table", parent: 0, children: [2, 5] },
    { id: 2, kind: "element", tag: "colgroup", parent: 1, children: [3, 4] },
    { id: 3, kind: "element", tag: "col", parent: 2, children: [] },
    { id: 4, kind: "element", tag: "col", parent: 2, children: [], attrs: { span: "1" } },
    { id: 5, kind: "element", tag: "tr", parent: 1, children: [6, 7] },
    { id: 6, kind: "element", tag: "td", parent: 5, children: [] },
    { id: 7, kind: "element", tag: "td", parent: 5, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "table", width: 80 })],
      [2, makeStyle({ display: "table-column-group" })],
      [3, makeStyle({ display: "table-column", width: 50 })],
      [4, makeStyle({ display: "table-column", width: 30 })],
      [5, makeStyle({ display: "table-row" })],
      [6, makeStyle({ display: "table-cell", height: 10 })],
      [7, makeStyle({ display: "table-cell", height: 10 })],
    ]),
  );
  const tree = layout(dom, styles);
  const a = fragmentOf(tree, nodeId(6))!;
  const b = fragmentOf(tree, nodeId(7))!;
  assert.equal(Number(a.box.borderBox.width), 50, "first col width seeds column 0");
  assert.equal(Number(b.box.borderBox.x), 50);
  assert.equal(Number(b.box.borderBox.width), 30, "second col width seeds column 1");

  const spanned = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "table", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", tag: "col", parent: 1, children: [], attrs: { span: "2" } },
    { id: 3, kind: "element", tag: "tr", parent: 1, children: [4, 5] },
    { id: 4, kind: "element", tag: "td", parent: 3, children: [] },
    { id: 5, kind: "element", tag: "td", parent: 3, children: [] },
  ]);
  const spanTree = layout(
    spanned,
    styleTable(
      new Map([
        [1, makeStyle({ display: "table", width: 80 })],
        [2, makeStyle({ display: "table-column", width: 40 })],
        [3, makeStyle({ display: "table-row" })],
        [4, makeStyle({ display: "table-cell", height: 10 })],
        [5, makeStyle({ display: "table-cell", height: 10 })],
      ]),
    ),
  );
  const spanA = fragmentOf(spanTree, nodeId(4))!;
  const spanB = fragmentOf(spanTree, nodeId(5))!;
  assert.equal(Number(spanA.box.borderBox.width), 40, "span=2 applies the col width to column 0");
  assert.equal(Number(spanB.box.borderBox.width), 40, "span=2 applies the col width to column 1");
});
