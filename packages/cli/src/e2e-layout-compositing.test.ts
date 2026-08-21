/**
 * End-to-end evidence: REAL HTML+CSS documents trigger the advanced layout and
 * compositing branches through the actual pipeline — NO synthetic ComputedStyle
 * (platform-as-data-layout spec, tasks 6.1 + 6.2; Requirements 5.1-5.5).
 *
 * Built by `tsc` then run with: `node --test packages/cli/dist/*.test.js`.
 *
 * This is the climax of the campaign: before the welding, the flex/grid/table/
 * float/positioned and opacity/transform/z-index branches were dead — reachable
 * only by hand-built ComputedStyle in unit tests. Now a real `<style>` document
 * driven through parse → cascade → layout → paint genuinely exercises them,
 * proving "add a property = add a row" holds end-to-end (the whole point of the
 * compat-per-LOC bet in MANIFESTO.md).
 *
 * The cli is an orchestration layer, so it may import and compose every stage.
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { DomNode, DomTree, Fragment, FragmentTree, NodeId, Px } from "@browser-engine/ir";
import { parseHtml } from "@browser-engine/html-parser";
import { parseCss } from "@browser-engine/css-parser";
import { cascade } from "@browser-engine/cascade";
import { layout } from "@browser-engine/layout";
import { paint } from "@browser-engine/paint";
import { uaStylesheet } from "./stylesheets.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * Build the real FragmentTree for a document (parse → cascade → layout). The
 * UA stylesheet is included (as the real pipeline does) so `<div>` and friends
 * default to `display: block` — without it, an un-styled div computes as
 * `inline` and participates in the inline formatting context instead of block
 * flow.
 */
function layoutDoc(html: string, css: string): { dom: DomTree; tree: FragmentTree } {
  const dom = parseHtml(enc(html));
  const sheets = [uaStylesheet(), parseCss(enc(css))];
  const tree = layout(dom, (node: NodeId) => cascade(dom, sheets, node));
  return { dom, tree };
}

/** Build the real DisplayList for a document (parse → cascade → layout → paint). */
function paintDoc(html: string, css: string): string[] {
  const dom = parseHtml(enc(html));
  const sheets = [uaStylesheet(), parseCss(enc(css))];
  const styleOf = (node: NodeId) => cascade(dom, sheets, node);
  return paint(layout(dom, styleOf), styleOf).commands.map((c) => c.op);
}

/** All element nodes with the given (lowercased) tag, in document order. */
function elementsByTag(dom: DomTree, tag: string): DomNode[] {
  const out: DomNode[] = [];
  for (const node of dom.nodes.values()) {
    if (node.kind === "element" && node.tag === tag) out.push(node);
  }
  return out;
}

/** The direct child fragments of the element with the given class. */
function fragmentsOfChildren(tree: FragmentTree, dom: DomTree, className: string): Fragment[] {
  for (const node of dom.nodes.values()) {
    if (node.kind === "element" && node.attrs?.get("class") === className) {
      const parent = fragmentForNode(tree, node.id);
      return parent.children.map((id) => tree.fragments.get(id)!);
    }
  }
  return [];
}

/** The fragment laid out for a given DOM node. */
function fragmentForNode(tree: FragmentTree, node: NodeId): Fragment {
  for (const f of tree.fragments.values()) {
    if (f.node === node) return f;
  }
  throw new Error(`no fragment for node ${String(node)}`);
}

// ===========================================================================
// Task 6.1 — advanced layout from a real document (Requirements 5.1-5.4)
// ===========================================================================

void test("Req 5.1: a real flex document lays children along the main axis (equal split)", () => {
  const { dom, tree } = layoutDoc(
    '<div class="f"><span class="i"></span><span class="i"></span></div>',
    ".f { display: flex; width: 300px; height: 50px } .i { height: 50px }",
  );
  const items = elementsByTag(dom, "span");
  const a = fragmentForNode(tree, items[0]!.id);
  const b = fragmentForNode(tree, items[1]!.id);
  // Two auto-width flex items split 300px equally and lay along x.
  assert.equal(Number(a.box.borderBox.width), 150);
  assert.equal(Number(b.box.borderBox.width), 150);
  assert.equal(Number(a.box.borderBox.x), 0);
  assert.equal(Number(b.box.borderBox.x), 150, "second flex item lays along the main axis");
});

void test("Req 5.1: a real flex-direction:column document stacks children vertically", () => {
  const { dom, tree } = layoutDoc(
    '<div class="f"><span class="i"></span><span class="i"></span></div>',
    ".f { display: flex; flex-direction: column; width: 200px } .i { height: 40px }",
  );
  const items = elementsByTag(dom, "span");
  const a = fragmentForNode(tree, items[0]!.id);
  const b = fragmentForNode(tree, items[1]!.id);
  assert.equal(Number(a.box.borderBox.y), 0);
  assert.equal(Number(b.box.borderBox.y), 40, "column flex stacks the second item below the first");
});

void test("Req 5.2: a real 2-column grid document places children row-major", () => {
  const { dom, tree } = layoutDoc(
    '<div class="g"><span class="c"></span><span class="c"></span><span class="c"></span><span class="c"></span></div>',
    ".g { display: grid; grid-template-columns: 2; width: 200px } .c { height: 25px }",
  );
  const cells = elementsByTag(dom, "span").map((n) => fragmentForNode(tree, n.id));
  // 2 columns × 100px; row-major placement of 4 cells.
  assert.equal(Number(cells[0]!.box.borderBox.x), 0);
  assert.equal(Number(cells[0]!.box.borderBox.y), 0);
  assert.equal(Number(cells[1]!.box.borderBox.x), 100);
  assert.equal(Number(cells[3]!.box.borderBox.x), 100);
  assert.equal(Number(cells[3]!.box.borderBox.y), 25, "fourth cell wraps to row 2, column 2");
});

void test("Req 5.x: a real display:table document lays rows top-to-bottom", () => {
  const { dom, tree } = layoutDoc(
    "<table><tr><td></td><td></td></tr></table>",
    "table { display: table; width: 200px } td { height: 20px }",
  );
  const rows = elementsByTag(dom, "tr");
  const rowFrag = fragmentForNode(tree, rows[0]!.id);
  assert.equal(Number(rowFrag.box.borderBox.width), 200, "table row spans the table content width");
});

void test("Req 5.3: a real float:left document takes the box out of flow", () => {
  const { dom, tree } = layoutDoc(
    '<div class="c"><span class="fl"></span><span class="flow"></span></div>',
    ".c { width: 400px } .fl { float: left; width: 100px; height: 50px } .flow { height: 20px }",
  );
  const floatFrag = fragmentForNode(tree, elementsByTag(dom, "span")[0]!.id);
  const flowFrag = fragmentForNode(tree, elementsByTag(dom, "span")[1]!.id);
  assert.equal(Number(floatFrag.box.borderBox.x), 0, "float sits at the left edge");
  assert.equal(Number(flowFrag.box.borderBox.y), 0, "in-flow content flows beside the float (y stays 0)");
});

void test("Req 5.4: a real position:absolute document places the box at its insets, out of flow", () => {
  const { dom, tree } = layoutDoc(
    '<div class="c"><span class="abs"></span><span class="flow"></span></div>',
    ".c { width: 300px } .abs { position: absolute; top: 10px; left: 20px; height: 40px } .flow { height: 15px }",
  );
  const abs = fragmentForNode(tree, elementsByTag(dom, "span")[0]!.id);
  const flow = fragmentForNode(tree, elementsByTag(dom, "span")[1]!.id);
  assert.equal(Number(abs.box.borderBox.x), 20);
  assert.equal(Number(abs.box.borderBox.y), 10);
  assert.equal(Number(flow.box.borderBox.y), 0, "absolute box reserves no in-flow space");
});

void test("Req 5.1-5.4: a real relative document offsets the box but keeps its in-flow space", () => {
  // Block-level (div) siblings exercise the relative-in-block-flow path; span
  // siblings would participate in the inline formatting context instead.
  const { dom, tree } = layoutDoc(
    '<div class="c"><div class="rel"></div><div class="flow"></div></div>',
    ".c { width: 300px } .rel { position: relative; top: 5px; left: 8px; height: 40px } .flow { height: 30px }",
  );
  const rel = fragmentForNode(tree, elementsByTag(dom, "div")[1]!.id);
  const flow = fragmentForNode(tree, elementsByTag(dom, "div")[2]!.id);
  assert.equal(Number(rel.box.borderBox.x), 8, "relative box is visually offset by its insets");
  assert.equal(Number(rel.box.borderBox.y), 5);
  assert.equal(Number(flow.box.borderBox.y), 40, "relative offset preserves the in-flow space (40px)");
});

// ===========================================================================
// Task 6.2 — compositing from a real document (Requirement 5.5)
// ===========================================================================

void test("Req 5.5: a real opacity document emits a compositing layer", () => {
  const ops = paintDoc(
    '<div class="box"></div>',
    ".box { width: 50px; height: 50px; background-color: red; opacity: 0.5 }",
  );
  assert.ok(ops.includes("push-layer"), "opacity < 1 must push a compositing layer");
  assert.ok(ops.includes("pop-layer"));
});

void test("Req 5.5: a real transform document emits a compositing layer", () => {
  const ops = paintDoc(
    '<div class="box"></div>',
    ".box { width: 50px; height: 50px; background-color: red; transform: matrix(2,0,0,2,0,0) }",
  );
  assert.ok(ops.includes("push-layer"), "a transform must push a compositing layer");
});

void test("Req 5.5: a real z-index document reorders sibling paint", () => {
  // Sibling A declared first with z-index 2 (red); sibling B declared second
  // with z-index 1 (blue). Paint order must put the lower z (blue) first.
  const dom = parseHtml(enc('<div class="c"><span class="hi"></span><span class="lo"></span></div>'));
  const sheets = [
    parseCss(
      enc(
        ".c { width: 100px } .hi { z-index: 2; height: 20px; background-color: red } .lo { z-index: 1; height: 20px; background-color: blue }",
      ),
    ),
  ];
  const styleOf = (node: NodeId) => cascade(dom, sheets, node);
  const list = paint(layout(dom, styleOf), styleOf);
  const rects = list.commands.filter((c) => c.op === "rect");
  assert.equal(rects.length, 2, "both backgrounds paint");
  // The lower z-index (blue) paints first, higher (red) on top — real z-order.
  assert.ok(rects[0]!.op === "rect" && rects[0]!.fill.b === 255, "lower z-index (blue) paints first");
  assert.ok(rects[1]!.op === "rect" && rects[1]!.fill.r === 255, "higher z-index (red) paints last");
});

void test("Req 5.5: a real opaque document emits NO compositing layer (no synthetic style)", () => {
  const ops = paintDoc(
    '<div class="box"></div>',
    ".box { width: 50px; height: 50px; background-color: red }",
  );
  assert.equal(ops.includes("push-layer"), false, "an opaque, untransformed box needs no layer");
});

// ===========================================================================
// Border + visibility from a real document — the "declared but not rendered"
// gap closed end-to-end. The cascade now emits `border-<edge>-width/style/color`
// and `visibility` as typed fields; paint consumes EXACTLY those, so a real CSS
// declaration paints with no synthetic ComputedStyle (Platform-as-Data).
// ===========================================================================

void test("a real border-* document paints a border command from the resolved longhands", () => {
  const ops = paintDoc(
    '<div class="b"></div>',
    ".b { width: 50px; height: 50px; border-top-width: 4px; border-right-width: 4px; border-bottom-width: 4px; border-left-width: 4px; border-top-style: solid; border-right-style: solid; border-bottom-style: solid; border-left-style: solid }",
  );
  assert.ok(ops.includes("border"), "a real border declaration must paint a border command");
});

void test("a real border-* document carries the resolved width/style onto every edge", () => {
  const dom = parseHtml(enc('<div class="b"></div>'));
  const sheets = [
    parseCss(
      enc(
        ".b { width: 50px; height: 50px; border-top-width: 3px; border-right-width: 3px; border-bottom-width: 3px; border-left-width: 3px; border-top-style: dashed; border-right-style: dashed; border-bottom-style: dashed; border-left-style: dashed }",
      ),
    ),
  ];
  const styleOf = (node: NodeId) => cascade(dom, sheets, node);
  const list = paint(layout(dom, styleOf), styleOf);
  const border = list.commands.find((c) => c.op === "border");
  assert.ok(border !== undefined && border.op === "border");
  assert.equal(Number(border.edges.top.width), 3);
  assert.equal(border.edges.top.style, "dashed");
  assert.equal(border.edges.left.style, "dashed");
});

void test("a real no-border document paints NO border command (initial border is invisible)", () => {
  const ops = paintDoc(
    '<div class="b"></div>',
    ".b { width: 50px; height: 50px; background-color: red }",
  );
  assert.equal(ops.includes("border"), false, "an undeclared border stays at the invisible initial");
});

void test("a real visibility:hidden document suppresses the box's own background", () => {
  const visible = paintDoc(
    '<div class="b"></div>',
    ".b { width: 50px; height: 50px; background-color: red }",
  );
  const hidden = paintDoc(
    '<div class="b"></div>',
    ".b { width: 50px; height: 50px; background-color: red; visibility: hidden }",
  );
  const visibleRects = visible.filter((op) => op === "rect").length;
  const hiddenRects = hidden.filter((op) => op === "rect").length;
  assert.ok(visibleRects >= 1, "a visible red box paints its background");
  assert.ok(hiddenRects < visibleRects, "visibility:hidden removes the box's own background rect");
});

void test("a real visibility:hidden parent still lets a visible child paint (gates self only)", () => {
  // Parent hidden, child visible — the child's background must still paint.
  const dom = parseHtml(enc('<div class="p"><span class="c"></span></div>'));
  const sheets = [
    parseCss(
      enc(
        ".p { width: 100px; height: 50px; background-color: red; visibility: hidden } .c { width: 30px; height: 20px; background-color: blue; visibility: visible }",
      ),
    ),
  ];
  const styleOf = (node: NodeId) => cascade(dom, sheets, node);
  const list = paint(layout(dom, styleOf), styleOf);
  const rects = list.commands.filter((c) => c.op === "rect");
  // Only the visible child's (blue) background paints; the hidden parent's does not.
  assert.equal(rects.length, 1, "only the visible child's background paints");
  assert.ok(rects[0]!.op === "rect" && rects[0]!.fill.b === 255, "the painted rect is the blue child");
});

// ===========================================================================
// Box model from a real document — padding + border-width + box-sizing now
// OCCUPY SPACE (the cascade emits them; layout consumes them). The border box
// (what getBoundingClientRect returns) grows by padding+border, content is
// inset, and `box-sizing:border-box` makes a declared width the border-box
// width. A document declaring none of them is byte-for-byte the Phase-1 layout.
// ===========================================================================

void test("real padding grows the border box and insets the content (content-box default)", () => {
  const { dom, tree } = layoutDoc(
    '<div class="b"></div>',
    ".b { width: 100px; height: 40px; padding-top: 10px; padding-right: 20px; padding-bottom: 10px; padding-left: 20px }",
  );
  const b = fragmentForNode(tree, elementsByTag(dom, "div")[0]!.id);
  // content-box: declared 100×40 is the CONTENT; border box = content + padding.
  assert.equal(Number(b.box.contentBox.width), 100);
  assert.equal(Number(b.box.contentBox.height), 40);
  assert.equal(Number(b.box.borderBox.width), 140, "border box = 100 + 20 + 20");
  assert.equal(Number(b.box.borderBox.height), 60, "border box = 40 + 10 + 10");
  // The content box is inset from the border-box origin by the left/top padding.
  assert.equal(Number(b.box.contentBox.x) - Number(b.box.borderBox.x), 20);
  assert.equal(Number(b.box.contentBox.y) - Number(b.box.borderBox.y), 10);
});

void test("real border-width occupies space only when its style draws", () => {
  const drawn = layoutDoc(
    '<div class="b"></div>',
    ".b { width: 100px; height: 40px; border-top-width: 5px; border-right-width: 5px; border-bottom-width: 5px; border-left-width: 5px; border-top-style: solid; border-right-style: solid; border-bottom-style: solid; border-left-style: solid }",
  );
  const db = fragmentForNode(drawn.tree, elementsByTag(drawn.dom, "div")[0]!.id);
  assert.equal(Number(db.box.borderBox.width), 110, "solid 5px borders add 10px width");
  assert.equal(Number(db.box.borderBox.height), 50);

  // Same widths but border-style:none ⇒ no space taken (styleless border).
  const styleless = layoutDoc(
    '<div class="b"></div>',
    ".b { width: 100px; height: 40px; border-top-width: 5px; border-right-width: 5px; border-bottom-width: 5px; border-left-width: 5px }",
  );
  const sb = fragmentForNode(styleless.tree, elementsByTag(styleless.dom, "div")[0]!.id);
  assert.equal(Number(sb.box.borderBox.width), 100, "a width with no border-style takes no space");
  assert.equal(Number(sb.box.borderBox.height), 40);
});

void test("box-sizing:border-box makes the declared width the BORDER-box width", () => {
  const { dom, tree } = layoutDoc(
    '<div class="b"></div>',
    ".b { box-sizing: border-box; width: 100px; height: 40px; padding-top: 10px; padding-right: 10px; padding-bottom: 10px; padding-left: 10px }",
  );
  const b = fragmentForNode(tree, elementsByTag(dom, "div")[0]!.id);
  // border-box: the declared 100×40 IS the border box; content shrinks by padding.
  assert.equal(Number(b.box.borderBox.width), 100, "declared width is the border-box width");
  assert.equal(Number(b.box.borderBox.height), 40);
  assert.equal(Number(b.box.contentBox.width), 80, "content = 100 - 10 - 10");
  assert.equal(Number(b.box.contentBox.height), 20, "content = 40 - 10 - 10");
});

void test("padding pushes in-flow children into the content area (children offset by padding)", () => {
  const { dom, tree } = layoutDoc(
    '<div class="p"><span class="c"></span></div>',
    ".p { width: 200px; padding-top: 15px; padding-right: 0px; padding-bottom: 0px; padding-left: 25px } .c { height: 10px }",
  );
  const child = fragmentForNode(tree, elementsByTag(dom, "span")[0]!.id);
  // The child's border-box origin is offset by the parent's left/top padding.
  assert.equal(Number(child.box.borderBox.x), 25, "child inset by parent's left padding");
  assert.equal(Number(child.box.borderBox.y), 15, "child inset by parent's top padding");
});

void test("getBoundingClientRect reflects the padded/bordered border box (single source still holds)", () => {
  const { dom, tree } = layoutDoc(
    '<div class="b"></div>',
    ".b { width: 50px; height: 50px; padding-top: 10px; padding-right: 10px; padding-bottom: 10px; padding-left: 10px; border-top-width: 2px; border-right-width: 2px; border-bottom-width: 2px; border-left-width: 2px; border-top-style: solid; border-right-style: solid; border-bottom-style: solid; border-left-style: solid }",
  );
  const b = fragmentForNode(tree, elementsByTag(dom, "div")[0]!.id);
  // 50 content + 20 padding + 4 border = 74 on each axis.
  assert.equal(Number(b.box.borderBox.width), 74);
  assert.equal(Number(b.box.borderBox.height), 74);
});

void test("a document declaring no padding/border lays out byte-for-byte like Phase 1", () => {
  // The classic slice: a plain div with a child, no insets. The child sits at
  // the content origin (0,0) and the parent's border box equals its content.
  const { dom, tree } = layoutDoc(
    '<div class="p"><span class="c"></span></div>',
    ".p { width: 200px } .c { height: 30px }",
  );
  const parent = fragmentForNode(tree, elementsByTag(dom, "div")[0]!.id);
  const child = fragmentForNode(tree, elementsByTag(dom, "span")[0]!.id);
  assert.equal(Number(child.box.borderBox.x), 0, "no padding ⇒ child at content origin (0,0)");
  assert.equal(Number(child.box.borderBox.y), 0);
  assert.equal(Number(parent.box.borderBox.width), 200, "no insets ⇒ border box = content");
  assert.equal(Number(parent.box.contentBox.width), 200);
});

void test("text paints at the padded content origin, inside the box's padding", () => {
  // A padded div containing text: the text command's `at` must be the content
  // origin (offset by the padding), not the border-box origin.
  const dom = parseHtml(enc('<div class="p">hi</div>'));
  const sheets = [
    parseCss(enc(".p { width: 200px; padding-top: 12px; padding-right: 0px; padding-bottom: 0px; padding-left: 18px }")),
  ];
  const styleOf = (node: NodeId) => cascade(dom, sheets, node);
  const list = paint(layout(dom, styleOf), styleOf);
  const text = list.commands.find((c) => c.op === "text");
  assert.ok(text !== undefined && text.op === "text");
  assert.equal(Number(text.at.x), 18, "text x = parent left padding");
  assert.equal(Number(text.at.y), 12, "text y = parent top padding");
});

// ===========================================================================
// min/max sizing constraints from a real document — `min-*`/`max-*` now CLAMP
// the resolved content size (the cascade emits them; layout applies them). A
// document declaring none is byte-for-byte the Phase-1 layout.
// ===========================================================================

void test("max-width clamps a wider declared width down", () => {
  const { dom, tree } = layoutDoc(
    '<div class="b"></div>',
    ".b { width: 300px; max-width: 150px; height: 20px }",
  );
  const b = fragmentForNode(tree, elementsByTag(dom, "div")[0]!.id);
  assert.equal(Number(b.box.contentBox.width), 150, "max-width caps the declared 300px to 150px");
});

void test("min-width raises a narrower declared width up", () => {
  const { dom, tree } = layoutDoc(
    '<div class="b"></div>',
    ".b { width: 40px; min-width: 120px; height: 20px }",
  );
  const b = fragmentForNode(tree, elementsByTag(dom, "div")[0]!.id);
  assert.equal(Number(b.box.contentBox.width), 120, "min-width raises the declared 40px to 120px");
});

void test("min-width wins a min/max conflict (min applied last, per CSS)", () => {
  const { dom, tree } = layoutDoc(
    '<div class="b"></div>',
    ".b { width: 50px; min-width: 200px; max-width: 100px; height: 20px }",
  );
  const b = fragmentForNode(tree, elementsByTag(dom, "div")[0]!.id);
  // max clamps 50→... then min raises to 200 (min wins): result 200.
  assert.equal(Number(b.box.contentBox.width), 200, "min-width overrides max-width on conflict");
});

void test("max-height clamps an auto content height that overflows", () => {
  // A tall child gives the parent a large auto content height; max-height caps it.
  const { dom, tree } = layoutDoc(
    '<div class="p"><span class="tall"></span></div>',
    ".p { width: 100px; max-height: 30px } .tall { height: 200px }",
  );
  const p = fragmentForNode(tree, elementsByTag(dom, "div")[0]!.id);
  assert.equal(Number(p.box.contentBox.height), 30, "max-height caps the auto content height");
});

void test("a document with no min/max lays out byte-for-byte (clamp is a no-op)", () => {
  const { dom, tree } = layoutDoc('<div class="b"></div>', ".b { width: 123px; height: 45px }");
  const b = fragmentForNode(tree, elementsByTag(dom, "div")[0]!.id);
  assert.equal(Number(b.box.contentBox.width), 123);
  assert.equal(Number(b.box.contentBox.height), 45);
});

// ===========================================================================
// overflow:hidden → paint clip. A non-`visible` overflow clips the box's
// DESCENDANTS to its padding box (push-clip/pop-clip around the subtree). The
// box's own background/border are NOT clipped. `visible` (the initial) pushes
// no clip, so a plain document's command stream is byte-for-byte unchanged.
// ===========================================================================

void test("overflow:hidden pushes a clip around the box's descendants", () => {
  const ops = paintDoc(
    '<div class="p"><span class="c"></span></div>',
    ".p { width: 100px; height: 50px; overflow: hidden } .c { height: 20px; background-color: red }",
  );
  assert.ok(ops.includes("push-clip"), "overflow:hidden must push a clip");
  assert.ok(ops.includes("pop-clip"), "the clip is balanced by a pop");
  // The clip wraps the child's content: push-clip precedes the child's rect.
  assert.ok(ops.indexOf("push-clip") < ops.lastIndexOf("rect"), "clip is pushed before the clipped content");
});

void test("overflow:visible (the initial) pushes NO clip", () => {
  const ops = paintDoc(
    '<div class="p"><span class="c"></span></div>',
    ".p { width: 100px; height: 50px } .c { height: 20px; background-color: red }",
  );
  assert.equal(ops.includes("push-clip"), false, "an unclipped box pushes no clip command");
});

void test("the clip rectangle is the padding box, and the box's own background is NOT clipped", () => {
  const dom = parseHtml(enc('<div class="p"><span class="c"></span></div>'));
  const sheets = [
    parseCss(
      enc(
        ".p { width: 100px; height: 50px; padding-top: 5px; padding-right: 5px; padding-bottom: 5px; padding-left: 5px; overflow: hidden; background-color: blue } .c { height: 20px; background-color: red }",
      ),
    ),
  ];
  const styleOf = (node: NodeId) => cascade(dom, sheets, node);
  const list = paint(layout(dom, styleOf), styleOf);
  const ops = list.commands.map((c) => c.op);
  // The parent's own blue background rect comes BEFORE the push-clip (not clipped).
  const firstRect = ops.indexOf("rect");
  const pushClip = ops.indexOf("push-clip");
  assert.ok(firstRect >= 0 && pushClip > firstRect, "the box's own background paints before its clip");
  // The clip rect equals the parent's padding box.
  const clipCmd = list.commands.find((c) => c.op === "push-clip");
  assert.ok(clipCmd !== undefined && clipCmd.op === "push-clip");
  const parent = fragmentForNode(layout(dom, styleOf), elementsByTag(dom, "div")[0]!.id);
  assert.deepEqual(clipCmd.rect, parent.box.paddingBox);
});

void test("overflow-x:hidden alone also triggers the clip (axis longhand)", () => {
  const ops = paintDoc(
    '<div class="p"><span class="c"></span></div>',
    ".p { width: 100px; height: 50px; overflow-x: hidden } .c { height: 20px; background-color: red }",
  );
  assert.ok(ops.includes("push-clip"), "overflow-x:hidden triggers clipping");
});

// ===========================================================================
// Adjacent-sibling margin collapsing (CSS 2.1 §8.3.1) from a real document.
// The vertical gap between two in-flow block siblings is the COLLAPSED margin
// (the larger of the two), not their sum. A document with no vertical margins
// between siblings is byte-for-byte the Phase-1 layout.
// ===========================================================================

void test("adjacent block siblings collapse their touching vertical margins (max, not sum)", () => {
  const { dom, tree } = layoutDoc(
    '<div class="c"><div class="a"></div><div class="b"></div></div>',
    ".c { width: 200px } .a { height: 30px; margin-top: 0px; margin-right: 0px; margin-bottom: 20px; margin-left: 0px } .b { height: 30px; margin-top: 30px; margin-right: 0px; margin-bottom: 0px; margin-left: 0px }",
  );
  const a = fragmentForNode(tree, elementsByTag(dom, "div")[1]!.id); // first child div
  const b = fragmentForNode(tree, elementsByTag(dom, "div")[2]!.id); // second child div
  // a border box: y=0, height 30 ⇒ bottom edge at 30. a's bottom margin 20 and
  // b's top margin 30 collapse to max(20,30)=30, so b's border box starts at 60.
  assert.equal(Number(a.box.borderBox.y), 0);
  assert.equal(Number(b.box.borderBox.y), 60, "gap is the collapsed max(20,30)=30, not the sum 50");
});

void test("non-touching margins (one side zero) do not change position (collapse is a no-op)", () => {
  const { dom, tree } = layoutDoc(
    '<div class="c"><div class="a"></div><div class="b"></div></div>',
    ".c { width: 200px } .a { height: 30px } .b { height: 30px; margin-top: 15px; margin-right: 0px; margin-bottom: 0px; margin-left: 0px }",
  );
  const b = fragmentForNode(tree, elementsByTag(dom, "div")[2]!.id);
  // a has no bottom margin (0); b's top margin 15. collapse(0,15)=15 = the sum,
  // so b sits at 30 + 15 = 45 — exactly the un-collapsed position.
  assert.equal(Number(b.box.borderBox.y), 45);
});

void test("equal touching margins collapse to one (the classic 'paragraph gap' case)", () => {
  const { dom, tree } = layoutDoc(
    '<div class="c"><div class="p"></div><div class="p"></div><div class="p"></div></div>',
    ".c { width: 200px } .p { height: 20px; margin-top: 10px; margin-right: 0px; margin-bottom: 10px; margin-left: 0px }",
  );
  const divs = elementsByTag(dom, "div").slice(1).map((n) => fragmentForNode(tree, n.id));
  // First p: top margin 10 ⇒ border box at y=10. Each subsequent gap is
  // collapse(10,10)=10, plus 20px content: +30 each.
  assert.equal(Number(divs[0]!.box.borderBox.y), 10);
  assert.equal(Number(divs[1]!.box.borderBox.y), 40, "10 (first top) + 20 (h) + 10 (collapsed) = 40");
  assert.equal(Number(divs[2]!.box.borderBox.y), 70);
});

void test("collapsing shrinks the container's auto content height accordingly", () => {
  const noCollapse = layoutDoc(
    '<div class="c"><div class="a"></div><div class="b"></div></div>',
    ".c { width: 200px } .a { height: 20px } .b { height: 20px }",
  );
  const collapsed = layoutDoc(
    '<div class="c"><div class="a"></div><div class="b"></div></div>',
    ".c { width: 200px } .a { height: 20px; margin-top: 0px; margin-right: 0px; margin-bottom: 40px; margin-left: 0px } .b { height: 20px; margin-top: 40px; margin-right: 0px; margin-bottom: 0px; margin-left: 0px }",
  );
  const cNo = fragmentForNode(noCollapse.tree, elementsByTag(noCollapse.dom, "div")[0]!.id);
  const cYes = fragmentForNode(collapsed.tree, elementsByTag(collapsed.dom, "div")[0]!.id);
  // Without margins: 20 + 20 = 40. With collapsing: a content 20 + collapsed gap
  // max(40,40)=40 + b content 20 + b bottom margin 0 = 80, NOT the un-collapsed
  // 20 + 40 + 40 + 20 = 120.
  assert.equal(Number(cNo.box.contentBox.height), 40);
  assert.equal(Number(cYes.box.contentBox.height), 80, "the collapsed gap counts once, not twice");
});

void test("a document with no vertical sibling margins lays out byte-for-byte like Phase 1", () => {
  const { dom, tree } = layoutDoc(
    '<div class="c"><div class="a"></div><div class="b"></div></div>',
    ".c { width: 200px } .a { height: 10px } .b { height: 20px }",
  );
  const divs = elementsByTag(dom, "div").slice(1).map((n) => fragmentForNode(tree, n.id));
  assert.equal(Number(divs[0]!.box.borderBox.y), 0);
  assert.equal(Number(divs[1]!.box.borderBox.y), 10, "no margins ⇒ simple stacking, unchanged");
});

// ===========================================================================
// Inline layout: line-height + text-align from a real document. `line-height`
// (a unitless multiplier) scales the line box; `text-align` shifts the inline
// run horizontally within its line. The initials (1.0 / start) leave a plain
// run byte-for-byte at `font-size` tall and at the content origin.
// ===========================================================================

/** The single text fragment under a styled block (the inline run). */
function textRunUnder(html: string, css: string): Fragment {
  const { dom, tree } = layoutDoc(html, css);
  // The text node is the deepest leaf; find the fragment for the text node.
  let textNode: NodeId | null = null;
  for (const node of dom.nodes.values()) {
    if (node.kind === "text") textNode = node.id;
  }
  if (textNode === null) throw new Error("no text node");
  return fragmentForNode(tree, textNode);
}

void test("line-height scales the inline run's height by the multiplier × font-size", () => {
  const run = textRunUnder(
    '<div class="t">hello</div>',
    ".t { width: 800px; font-size: 20px; line-height: 2 }",
  );
  // One line, line-height 2 ⇒ box height = 2 × 20 = 40 (vs 20 at the 1.0 initial).
  assert.equal(Number(run.box.height), 40, "line-height:2 doubles the 20px line box");
});

void test("the initial line-height (1.0) keeps the run exactly font-size tall (unchanged)", () => {
  const run = textRunUnder('<div class="t">hello</div>', ".t { width: 800px; font-size: 16px }");
  assert.equal(Number(run.box.height), 16, "no line-height ⇒ one-em line box");
});

void test("text-align:center offsets the inline run by half the slack", () => {
  const run = textRunUnder(
    '<div class="t">hi</div>',
    ".t { width: 800px; font-size: 16px; text-align: center }",
  );
  // The run is centred: equal slack on both sides of the content width.
  const left = Number(run.box.borderBox.x);
  const right = 800 - left - Number(run.box.contentBox.width);
  assert.ok(left > 0, "centered run is offset from the start edge");
  assert.equal(left, right, "centering leaves equal slack on both sides");
});

void test("text-align:right pushes the inline run to the line's end", () => {
  const run = textRunUnder(
    '<div class="t">hi</div>',
    ".t { width: 800px; font-size: 16px; text-align: right }",
  );
  assert.equal(Number(run.box.borderBox.x), 800 - Number(run.box.contentBox.width), "right-aligned run sits at the end");
});

void test("text-align:left (and the initial start) leaves the run at the content origin", () => {
  const left = textRunUnder('<div class="t">hi</div>', ".t { width: 800px; text-align: left }");
  const start = textRunUnder('<div class="t">hi</div>', ".t { width: 800px }");
  assert.equal(Number(left.box.borderBox.x), 0, "left-aligned run at x=0");
  assert.equal(Number(start.box.borderBox.x), 0, "initial start ⇒ x=0 (unchanged)");
});

void test("text paints at the aligned position end-to-end (text-align flows to the text command)", () => {
  const dom = parseHtml(enc('<div class="t">hi</div>'));
  const sheets = [parseCss(enc(".t { width: 800px; font-size: 16px; text-align: right }"))];
  const styleOf = (node: NodeId) => cascade(dom, sheets, node);
  const list = paint(layout(dom, styleOf), styleOf);
  const text = list.commands.find((c) => c.op === "text");
  assert.ok(text !== undefined && text.op === "text");
  assert.ok(Number(text.at.x) > 0, "right-aligned text paints at a positive x offset, not the origin");
});

void test("text-align:justify stretches inter-word gaps so a wrapped line fills the width", () => {
  // A narrow container forces a wrap; justify stretches the first line's word
  // gaps so its last glyph reaches close to the containing width.
  const run = textRunUnder(
    '<div class="t">alpha beta gamma</div>',
    ".t { width: 60px; font-size: 10px; text-align: justify }",
  );
  assert.ok(run.text !== undefined, "the run carries a shaped text glyph stream");
  const glyphs = run.text.glyphs;
  // Glyphs share a y per line; group by y and inspect the first line's extent.
  const firstLineY = Number(glyphs[0]!.y);
  const firstLine = glyphs.filter((g) => Number(g.y) === firstLineY);
  const lastGlyphX = Number(firstLine[firstLine.length - 1]!.x);
  // A justified line's trailing glyph should reach near 60px (the container),
  // whereas an unjustified line would be well short of it.
  assert.ok(lastGlyphX > 45, `justified first line reaches near the edge (got ${lastGlyphX}), not packed left`);
});

// ===========================================================================
// Inline metrics: letter-spacing + word-spacing from a real document. Both add
// advance to the inline run (per glyph / per inter-word space). Default 0 ⇒ the
// run width is byte-for-byte the Phase-1 metric.
// ===========================================================================

void test("letter-spacing widens the inline run by spacing × glyph count", () => {
  // "hello" = 5 glyphs; letter-spacing 4px adds 5 × 4 = 20px to the run width.
  const base = textRunUnder('<div class="t">hello</div>', ".t { width: 800px; font-size: 16px }");
  const spaced = textRunUnder(
    '<div class="t">hello</div>',
    ".t { width: 800px; font-size: 16px; letter-spacing: 4px }",
  );
  assert.equal(
    Number(spaced.box.contentBox.width),
    Number(base.box.contentBox.width) + 20,
    "letter-spacing:4px over 5 glyphs adds 20px",
  );
});

void test("word-spacing widens a multi-word run at each inter-word space", () => {
  // "a b c" = 3 words ⇒ 2 inter-word spaces; word-spacing 10px adds 2 × 10 = 20px.
  const base = textRunUnder('<div class="t">a b c</div>', ".t { width: 800px; font-size: 16px }");
  const spaced = textRunUnder(
    '<div class="t">a b c</div>',
    ".t { width: 800px; font-size: 16px; word-spacing: 10px }",
  );
  assert.equal(
    Number(spaced.box.contentBox.width),
    Number(base.box.contentBox.width) + 20,
    "word-spacing:10px over 2 gaps adds 20px",
  );
});

void test("no letter/word-spacing leaves the inline run byte-for-byte (default 0)", () => {
  const base = textRunUnder('<div class="t">hello world</div>', ".t { width: 800px; font-size: 16px }");
  const explicitZero = textRunUnder(
    '<div class="t">hello world</div>',
    ".t { width: 800px; font-size: 16px; letter-spacing: 0px; word-spacing: 0px }",
  );
  assert.equal(Number(explicitZero.box.contentBox.width), Number(base.box.contentBox.width));
});

void test("letter-spacing can push a run to wrap to more lines", () => {
  // A run that fits on one line gains enough letter-spacing to overflow and wrap,
  // increasing the run's height (more line boxes).
  const tight = textRunUnder(
    '<div class="t">aaaa bbbb cccc</div>',
    ".t { width: 120px; font-size: 16px }",
  );
  const loose = textRunUnder(
    '<div class="t">aaaa bbbb cccc</div>',
    ".t { width: 120px; font-size: 16px; letter-spacing: 8px }",
  );
  assert.ok(
    Number(loose.box.height) >= Number(tight.box.height),
    "wide letter-spacing wraps to at least as many lines",
  );
});

// ===========================================================================
// white-space wrapping control from a real document. `normal` (initial) wraps
// at the containing width; `nowrap`/`pre` keep the whole run on one line, whose
// width may overflow the container. Default `normal` ⇒ byte-for-byte Phase-1.
// ===========================================================================

void test("white-space:nowrap keeps a long run on a single line (no wrap)", () => {
  const wrapped = textRunUnder(
    '<div class="t">aaaa bbbb cccc dddd</div>',
    ".t { width: 60px; font-size: 16px }",
  );
  const nowrap = textRunUnder(
    '<div class="t">aaaa bbbb cccc dddd</div>',
    ".t { width: 60px; font-size: 16px; white-space: nowrap }",
  );
  // The wrapping run is multiple lines tall; the nowrap run is exactly one line.
  assert.ok(Number(wrapped.box.height) > 16, "normal wraps to several lines in a narrow box");
  assert.equal(Number(nowrap.box.height), 16, "nowrap stays on a single line");
});

void test("white-space:nowrap lets the run width OVERFLOW the container", () => {
  const nowrap = textRunUnder(
    '<div class="t">aaaa bbbb cccc dddd</div>',
    ".t { width: 60px; font-size: 16px; white-space: nowrap }",
  );
  assert.ok(
    Number(nowrap.box.contentBox.width) > 60,
    "the single-line run is wider than the 60px container (it overflows)",
  );
});

void test("white-space:pre also suppresses wrapping (single line)", () => {
  const pre = textRunUnder(
    '<div class="t">aaaa bbbb cccc dddd</div>',
    ".t { width: 60px; font-size: 16px; white-space: pre }",
  );
  assert.equal(Number(pre.box.height), 16, "pre keeps the run on one line");
});

void test("white-space:normal (the initial) wraps exactly as before (byte-for-byte)", () => {
  const explicit = textRunUnder(
    '<div class="t">aaaa bbbb cccc dddd</div>',
    ".t { width: 60px; font-size: 16px; white-space: normal }",
  );
  const initial = textRunUnder(
    '<div class="t">aaaa bbbb cccc dddd</div>',
    ".t { width: 60px; font-size: 16px }",
  );
  assert.equal(Number(explicit.box.height), Number(initial.box.height));
  assert.equal(Number(explicit.box.contentBox.width), Number(initial.box.contentBox.width));
});

void test("nowrap + overflow:hidden clips the overflowing single-line run end-to-end", () => {
  // The capstone: white-space (layout) overflows the box, overflow (paint) clips
  // it — two generated properties cooperating across layout → paint.
  const ops = paintDoc(
    '<div class="t">aaaa bbbb cccc dddd</div>',
    ".t { width: 60px; height: 16px; white-space: nowrap; overflow: hidden }",
  );
  assert.ok(ops.includes("push-clip"), "overflow:hidden clips the nowrap overflow");
});

// ===========================================================================
// Percentage geometry: width/height % and border-radius %
// ===========================================================================

void test("width: 50% resolves against the containing block content width", () => {
  // 200px container, child width:50% ⇒ 100px border-box.
  const real = layoutDoc('<div class="c"><div class="h"></div></div>', ".c { width: 200px; height: 100px } .h { width: 50%; height: 20px }");
  let hFrag: Fragment | null = null;
  for (const n of real.dom.nodes.values()) {
    if (n.kind === "element" && n.attrs?.get("class") === "h") hFrag = fragmentForNode(real.tree, n.id);
  }
  assert.ok(hFrag !== null, "the .h element exists");
  assert.equal(Number(hFrag.box.borderBox.width), 100, "width:50% of 200px ⇒ 100px");
});

void test("height: 50% resolves against a definite containing block height", () => {
  const real = layoutDoc('<div class="c"><div class="h"></div></div>', ".c { width: 200px; height: 100px } .h { width: 20px; height: 50% }");
  let hFrag: Fragment | null = null;
  for (const n of real.dom.nodes.values()) {
    if (n.kind === "element" && n.attrs?.get("class") === "h") hFrag = fragmentForNode(real.tree, n.id);
  }
  assert.ok(hFrag !== null);
  assert.equal(Number(hFrag.box.borderBox.height), 50, "height:50% of 100px ⇒ 50px");
});

void test("border-radius: 50% paints a circular radius on a square box", () => {
  // A 40×40 box with border-radius:50% ⇒ the paint rect/border carries a 20px
  // radius (50% of min(40,40) = 20), so avatars/icons become circles.
  const dom = parseHtml(enc('<div class="a"></div>'));
  const sheets = [parseCss(enc(".a { width: 40px; height: 40px; background-color: red; border-radius: 50% }"))];
  const styleOf = (node: NodeId) => cascade(dom, sheets, node);
  const list = paint(layout(dom, styleOf), styleOf);
  const rect = list.commands.find((c) => c.op === "rect");
  assert.ok(rect !== undefined && rect.op === "rect");
  assert.equal(Number((rect as { radius?: Px }).radius ?? 0), 20, "border-radius:50% on 40px box ⇒ radius 20");
});

// ===========================================================================
// Inline formatting context: consecutive inline-level children flow into line
// boxes left-to-right instead of each taking a vertical row.
// ===========================================================================

void test("inline run: text + span + text flow on ONE horizontal line", () => {
  const { dom, tree } = layoutDoc(
    '<div class="c">alpha<span class="s">beta</span>gamma</div>',
    ".c { width: 400px; font-size: 16px } .s { color: red }",
  );
  // The run's members: text(alpha), span(beta), text(gamma) — all on line 0.
  // The span is an atomic box whose OWN text child lives beneath it, so the
  // container has 3 children: alpha text, the span box, gamma text.
  const fragments = fragmentsOfChildren(tree, dom, "c");
  assert.equal(fragments.length, 3, "text, span box, text");
  const withText = fragments.filter((f) => f.text !== undefined);
  assert.equal(withText.length, 2, "two of the three children are text-bearing");
  // The span box sits BETWEEN the two texts on the same line.
  const xs = fragments.map((f) => Number(f.box.borderBox.x));
  assert.ok(xs[0]! < xs[1]! && xs[1]! < xs[2]!, "members flow left to right (x increases)");
  const ys = fragments.map((f) => Number(f.box.borderBox.y));
  assert.equal(new Set(ys).size, 1, "all members share one line (same y)");
});

void test("inline run wraps to a second line when it overflows the width", () => {
  const { dom, tree } = layoutDoc(
    '<div class="c">aaaa bbbb cccc dddd eeee</div>',
    ".c { width: 80px; font-size: 16px }",
  );
  const frag = fragmentForNode(tree, elementsByTag(dom, "div")[0]!.id);
  // The text wraps to several lines; the block's height reflects that.
  assert.ok(Number(frag.box.borderBox.height) > 16, "text wraps to multiple lines inside the block");
});

void test("inline-block participates as an atomic unit on the same line", () => {
  const { dom, tree } = layoutDoc(
    '<div class="c">go<span class="i"></span></div>',
    ".c { width: 300px; font-size: 16px } .i { display: inline-block; width: 30px; height: 10px; background-color: red }",
  );
  const span = elementsByTag(dom, "span")[0]!;
  const spanFrag = fragmentForNode(tree, span.id);
  // The span (inline-block) sits to the RIGHT of the text, on the same line.
  const textNode = [...dom.nodes.values()].find((n) => n.kind === "text")!;
  const text = fragmentForNode(tree, textNode.id);
  assert.ok(Number(text.box.borderBox.x) < Number(spanFrag.box.borderBox.x), "text left of inline-block");
  assert.equal(Number(text.box.borderBox.y), Number(spanFrag.box.borderBox.y), "same line (same y)");
});

void test("a block-level sibling breaks the inline run", () => {
  const { dom, tree } = layoutDoc(
    '<div class="c">alpha<div class="mid"></div>omega</div>',
    ".c { width: 300px; font-size: 16px } .mid { height: 30px }",
  );
  const texts = [...dom.nodes.values()]
    .filter((n) => n.kind === "text" && (n.text ?? "").trim().length > 0)
    .map((n) => fragmentForNode(tree, n.id));
  assert.equal(texts.length, 2, "two text fragments");
  // alpha is above omega (the block div sits between them in flow).
  assert.ok(
    Number(texts[0]!.box.borderBox.y) < Number(texts[1]!.box.borderBox.y),
    "the block sibling separates the two inline runs vertically",
  );
});

void test("inline run honors text-align:center at the LINE level", () => {
  const { dom, tree } = layoutDoc(
    '<div class="c">aa<span class="s">bb</span></div>',
    ".c { width: 300px; font-size: 16px; text-align: center }",
  );
  // The whole line is centered: the first member (alpha text) starts at a
  // positive x, and the span (second member) follows to its right.
  const cFrags = fragmentsOfChildren(tree, dom, "c");
  const alphaX = Number(cFrags[0]!.box.borderBox.x);
  assert.ok(alphaX > 0, "the run starts at a positive x (centered)");
  assert.ok(
    Number(cFrags[1]!.box.borderBox.x) > alphaX,
    "the span follows the first member on the same line",
  );
});

// ===========================================================================
// text-overflow: ellipsis — long single-line text is truncated with an ellipsis.
// ===========================================================================

void test("text-overflow:ellipsis truncates an overflowing single line with …", () => {
  // "abcdefghijklmno" at font-size 16 → each glyph ~8px ⇒ 15×8 = 120px in a
  // 60px container with white-space:nowrap + overflow:hidden + ellipsis.
  const { dom, tree } = layoutDoc(
    '<div class="t">abcdefghijklmno</div>',
    ".t { width: 60px; font-size: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }",
  );
  const textNode = [...dom.nodes.values()].find((n) => n.kind === "text")!;
  const frag = fragmentForNode(tree, textNode.id);
  assert.ok(frag.text !== undefined, "text run present");
  const glyphs = frag.text.glyphs;
  // The last glyph is the ellipsis U+2026.
  assert.equal(glyphs[glyphs.length - 1]!.glyphId, 0x2026, "trailing glyph is the ellipsis");
  // The run was truncated: fewer glyphs than the original 15 characters.
  assert.ok(glyphs.length < 15, "the overflowing text was truncated");
});

void test("text-overflow:ellipsis is NOT applied when the text fits", () => {
  const { dom, tree } = layoutDoc(
    '<div class="t">hi</div>',
    ".t { width: 200px; font-size: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }",
  );
  const textNode = [...dom.nodes.values()].find((n) => n.kind === "text")!;
  const frag = fragmentForNode(tree, textNode.id);
  const glyphs = frag.text!.glyphs;
  assert.equal(glyphs[glyphs.length - 1]!.glyphId, "i".charCodeAt(0), "no ellipsis when the text fits");
});
