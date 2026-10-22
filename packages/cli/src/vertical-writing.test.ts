/**
 * Vertical writing modes — RFC 0025. Three layers under test:
 *
 *   1. Cascade-level logical→physical mapping: `margin-block-start`,
 *      `inline-size`, logical border/padding/inset resolve against the
 *      element's own `writing-mode` + `direction` and re-enter cascade order
 *      against colliding physical declarations.
 *   2. Layout transposition: a `writing-mode: vertical-*` subtree is laid out
 *      in a virtual horizontal space (inline↔x, block↔y) and re-mapped into
 *      physical fragment geometry — text columns stack block-wise, margins
 *      and nested modes included.
 *   3. Glyph orientation metadata: `text-orientation` (mixed/upright/
 *      sideways) sets `rotate90` on the glyphs that need it; perpendicular
 *      children keep their own writing-mode stamp so the outer pass does
 *      not re-rotate them.
 *
 * Glyph ids are source code points under the placeholder shaper (8px advance
 * at the default 16px font); fragment coords are stored relative to the
 * parent's margin-box origin, so the harness accumulates them.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  px,
  type DomTree,
  type Fragment,
  type FragmentId,
  type FragmentTree,
  type NodeId,
  type Rect,
} from "@browser-engine/ir";
import { parseHtml } from "@browser-engine/html-parser";
import { parseCss } from "@browser-engine/css-parser";
import { cascade } from "@browser-engine/cascade";
import { layout } from "@browser-engine/layout";
import { uaStylesheet } from "./stylesheets.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const cp = String.fromCodePoint;

/** parseHtml → cascade(UA + author) → layout for `html`. */
function lay(
  html: string,
  css = "",
  w = 400,
  h = 300,
): { dom: DomTree; tree: FragmentTree; styleOf: (n: NodeId) => ReturnType<typeof cascade> } {
  const dom: DomTree = parseHtml(enc(html));
  const sheets = [uaStylesheet(), ...(css !== "" ? [parseCss(enc(css))] : [])];
  const styleOf = (n: NodeId) => cascade(dom, sheets, n);
  return {
    dom,
    styleOf,
    tree: layout(dom, styleOf, {
      viewportWidth: px(w),
      viewportHeight: px(h),
    }),
  };
}

/** First element carrying `id="tag"`. */
function nodeByTag(dom: DomTree, tag: string): NodeId {
  for (const [id, n] of dom.nodes) {
    if (n.kind === "element" && n.attrs?.get("id") === tag) return id;
  }
  throw new Error(`no #${tag}`);
}

/** Absolute position of the fragment for `node` (margin-box-origin walk). */
function absFrag(tree: FragmentTree, node: NodeId): { f: Fragment; abs: Rect } | undefined {
  const q: { id: FragmentId; ox: number; oy: number }[] = [{ id: tree.root, ox: 0, oy: 0 }];
  while (q.length > 0) {
    const { id, ox, oy } = q.shift()!;
    const f = tree.fragments.get(id)!;
    if (f.node === node) {
      return {
        f,
        abs: {
          x: px(ox + Number(f.box.borderBox.x)),
          y: px(oy + Number(f.box.borderBox.y)),
          width: f.box.borderBox.width,
          height: f.box.borderBox.height,
        },
      };
    }
    for (const cid of f.children) {
      q.push({ id: cid, ox: ox + Number(f.box.marginBox.x), oy: oy + Number(f.box.marginBox.y) });
    }
  }
  return undefined;
}

function textFrag(tree: FragmentTree, dom: DomTree): Fragment | undefined {
  for (const f of tree.fragments.values()) {
    const n = dom.nodes.get(f.node);
    if (n?.kind === "text" && f.text !== undefined) return f;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Cascade: logical → physical mapping
// ---------------------------------------------------------------------------

void test("logical margins map to physical edges in horizontal-tb", () => {
  const { dom, styleOf } = lay("<div id=a>x</div>", "#a{margin-block-start:20px;margin-inline-end:12px}");
  const s = styleOf(nodeByTag(dom, "a")) as unknown as Record<string, number>;
  assert.equal(s["marginTop"], 20);
  assert.equal(s["marginRight"], 12);
  assert.equal(s["marginBottom"], 0);
  assert.equal(s["marginLeft"], 0);
});

void test("logical margins follow direction:rtl inline axis", () => {
  const { dom, styleOf } = lay("<div id=a>x</div>", "#a{direction:rtl;margin-inline-start:30px}");
  const s = styleOf(nodeByTag(dom, "a")) as unknown as Record<string, number>;
  assert.equal(s["marginRight"], 30);
  assert.equal(s["marginLeft"], 0);
});

void test("logical margins map under vertical-rl (inline-start→top, block-start→right)", () => {
  const { dom, styleOf } = lay(
    "<div id=a>x</div>",
    "#a{writing-mode:vertical-rl;margin-inline-start:30px;margin-block-start:9px}",
  );
  const s = styleOf(nodeByTag(dom, "a")) as unknown as Record<string, number>;
  assert.equal(s["marginTop"], 30); // inline-start
  assert.equal(s["marginRight"], 9); // block-start
  assert.equal(s["marginLeft"], 0);
});

void test("logical sizing maps inline-size/block-size to physical axes", () => {
  const { dom, styleOf } = lay(
    "<div id=a>x</div>",
    "#a{writing-mode:vertical-rl;inline-size:100px;block-size:50px}",
  );
  const s = styleOf(nodeByTag(dom, "a")) as unknown as Record<string, number>;
  assert.equal(s["height"], 100); // inline extent is physical height
  assert.equal(s["width"], 50); // block extent is physical width
  const h = lay("<div id=a>x</div>", "#a{inline-size:100px;block-size:50px}");
  const hs = h.styleOf(nodeByTag(h.dom, "a")) as unknown as Record<string, number>;
  assert.equal(hs["width"], 100);
  assert.equal(hs["height"], 50);
});

void test("mapped logical declarations re-enter cascade order vs physical", () => {
  // Later physical declaration beats the earlier logical one for the same slot.
  const a = lay(
    "<div id=a>x</div>",
    "#a{writing-mode:vertical-rl;margin-inline-start:30px;margin-top:9px}",
  );
  const sa = a.styleOf(nodeByTag(a.dom, "a")) as unknown as Record<string, number>;
  assert.equal(sa["marginTop"], 9);
  // Reversed order: the logical declaration wins its physical slot.
  const b = lay(
    "<div id=a>x</div>",
    "#a{writing-mode:vertical-rl;margin-top:9px;margin-inline-start:30px}",
  );
  const sb = b.styleOf(nodeByTag(b.dom, "a")) as unknown as Record<string, number>;
  assert.equal(sb["marginTop"], 30);
});

void test("logical padding/border widths map in vertical-lr", () => {
  const { dom, styleOf } = lay(
    "<div id=a>x</div>",
    "#a{writing-mode:vertical-lr;padding-block-start:7px;border-inline-start-width:3px}",
  );
  const s = styleOf(nodeByTag(dom, "a")) as unknown as Record<string, number>;
  // vertical-lr: block-start = left, inline-start (ltr) = top
  assert.equal(s["paddingLeft"], 7);
  assert.equal(s["borderTopWidth"], 3);
});

void test("margin-block/margin-inline shorthands expand then map", () => {
  const { dom, styleOf } = lay(
    "<div id=a>x</div>",
    "#a{writing-mode:vertical-rl;margin-block:4px 6px;margin-inline:10px}",
  );
  const s = styleOf(nodeByTag(dom, "a")) as unknown as Record<string, number>;
  // v-rl: block-start→right, block-end→left, inline-*→top/bottom
  assert.equal(s["marginRight"], 4);
  assert.equal(s["marginLeft"], 6);
  assert.equal(s["marginTop"], 10);
  assert.equal(s["marginBottom"], 10);
});

// ---------------------------------------------------------------------------
// Layout: transposed geometry
// ---------------------------------------------------------------------------

void test("vertical-rl text stacks glyphs down, columns right→left", () => {
  // 8 ideographs at 8px each; inline extent (physical height) 40 → 5 per column.
  const { dom, tree } = lay(
    "<div id=v>中中中中中中中中</div>",
    "#v{writing-mode:vertical-rl;height:40px}",
  );
  const t = textFrag(tree, dom)!;
  assert.equal(t.text!.writingMode, "vertical-rl");
  assert.equal(t.text!.advanceAxis, "y");
  const pts = t.text!.glyphs.map((g) => ({ x: Number(g.x), y: Number(g.y) }));
  // First column: glyphs advance downward.
  assert.deepEqual(pts.slice(0, 3).map((p) => [p.x, p.y]), [[16, 0], [16, 8], [16, 16]]);
  // Second column wraps to a column LEFT of the first (rl block direction).
  assert.equal(pts[5]!.x, 0);
  assert.equal(pts[5]!.y, 0);
});

void test("vertical-lr columns stack left→right", () => {
  const { dom, tree } = lay(
    "<div id=v>中中中中中中中中</div>",
    "#v{writing-mode:vertical-lr;height:40px}",
  );
  const t = textFrag(tree, dom)!;
  const pts = t.text!.glyphs.map((g) => ({ x: Number(g.x), y: Number(g.y) }));
  assert.equal(pts[0]!.x, 0);
  assert.equal(pts[5]!.x, 16); // next column to the right
});

void test("writing-mode is inherited into descendants", () => {
  const { dom, tree } = lay(
    "<div id=v><p>中中中</p></div>",
    "#v{writing-mode:vertical-rl;height:80px}",
  );
  const t = textFrag(tree, dom)!;
  assert.equal(t.text!.writingMode, "vertical-rl");
  assert.equal(t.text!.advanceAxis, "y");
});

void test("block progression: later block children move left in vertical-rl", () => {
  const { dom, tree } = lay(
    "<div id=v><p id=a>中</p><p id=b>中</p></div>",
    "#v{writing-mode:vertical-rl;height:80px}p{margin:0}",
  );
  const a = absFrag(tree, nodeByTag(dom, "a"))!;
  const b = absFrag(tree, nodeByTag(dom, "b"))!;
  // First block child's border box sits further RIGHT than the second.
  assert.ok(
    Number(a.abs.x) > Number(b.abs.x),
    `a.x=${Number(a.abs.x)} should exceed b.x=${Number(b.abs.x)}`,
  );
});

void test("inline direction rtl in vertical-rl starts text at the bottom", () => {
  const ltr = lay(
    "<div id=v>中a</div>",
    "#v{writing-mode:vertical-rl;height:80px}",
  );
  const rtl = lay(
    "<div id=v>中a</div>",
    "#v{writing-mode:vertical-rl;direction:rtl;height:80px}",
  );
  const ltrT = textFrag(ltr.tree, ltr.dom)!.text!.glyphs;
  const rtlT = textFrag(rtl.tree, rtl.dom)!.text!.glyphs;
  // rtl: the first glyph's inline offset maps to the far (bottom) edge.
  assert.ok(Number(rtlT[0]!.y) > Number(ltrT[0]!.y));
});

void test("physical box edges transpose: margin + padding land on mapped edges", () => {
  const { dom, tree } = lay(
    "<div id=v>x</div>",
    "#v{writing-mode:vertical-rl;padding-block-start:10px;margin-inline-start:20px}",
  );
  const d = absFrag(tree, nodeByTag(dom, "v"))!;
  // margin-inline-start → physical margin-top 20: the margin box top sits 20
  // above the border box top.
  const marginTop = Number(d.f.box.borderBox.y) - Number(d.f.box.marginBox.y);
  assert.equal(marginTop, 20);
  // padding-block-start → physical padding-right 10: the content box is 10
  // inside the border box on the RIGHT edge (v-rl block-start = right).
  const bbRight = Number(d.f.box.borderBox.x) + Number(d.f.box.borderBox.width);
  const cbRight = Number(d.f.box.contentBox.x) + Number(d.f.box.contentBox.width);
  assert.equal(bbRight - cbRight, 10);
  assert.equal(Number(d.f.box.contentBox.x) - Number(d.f.box.borderBox.x), 0);
});

void test("perpendicular child: horizontal-tb inside vertical-rl stays horizontal", () => {
  const { dom, tree } = lay(
    "<div id=v><p id=h>ab</p></div>",
    "#v{writing-mode:vertical-rl;height:80px}#h{writing-mode:horizontal-tb}",
  );
  const t = textFrag(tree, dom)!;
  assert.equal(t.text!.writingMode, "horizontal-tb");
  assert.equal(t.text!.advanceAxis, "x");
  // Glyphs advance horizontally and carry no rotation flags.
  const pts = t.text!.glyphs;
  assert.equal(Number(pts[0]!.y), Number(pts[1]!.y));
  assert.ok(Number(pts[1]!.x) > Number(pts[0]!.x));
  assert.ok(pts.every((g) => g.rotate90 !== true));
});

void test("nested vertical-lr inside vertical-rl keeps its own mode", () => {
  const { dom, tree } = lay(
    "<div id=v><p id=h>中中中中中中</p></div>",
    "#v{writing-mode:vertical-rl;height:80px}#h{writing-mode:vertical-lr}",
  );
  const t = textFrag(tree, dom)!;
  assert.equal(t.text!.writingMode, "vertical-lr");
  const h = absFrag(tree, nodeByTag(dom, "h"))!;
  // The child is the first block child of a v-rl parent: its margin box hugs
  // the parent's content RIGHT edge.
  const div = absFrag(tree, nodeByTag(dom, "v"))!;
  const hMbRight = Number(h.abs.x) - (Number(h.f.box.borderBox.x) - Number(h.f.box.marginBox.x)) + Number(h.f.box.marginBox.width);
  const divContentRight = Number(div.abs.x) + Number(div.abs.width);
  assert.equal(hMbRight, divContentRight);
});

void test("text-orientation mixed rotates latin but keeps CJK upright", () => {
  const { dom, tree } = lay(
    "<div id=v>中ab文</div>",
    "#v{writing-mode:vertical-rl;height:80px}",
  );
  const gs = textFrag(tree, dom)!.text!.glyphs;
  assert.equal(cp(gs[0]!.glyphId), "中");
  assert.ok(gs[0]!.rotate90 !== true); // CJK upright
  assert.equal(gs[1]!.rotate90, true); // 'a' rotates
  assert.equal(gs[2]!.rotate90, true); // 'b' rotates
  assert.ok(gs[3]!.rotate90 !== true); // 文 upright
});

void test("text-orientation upright keeps everything upright", () => {
  const { dom, tree } = lay(
    "<div id=v>中a</div>",
    "#v{writing-mode:vertical-rl;text-orientation:upright;height:80px}",
  );
  const gs = textFrag(tree, dom)!.text!.glyphs;
  assert.ok(gs.every((g) => g.rotate90 !== true));
});

void test("text-orientation sideways rotates everything", () => {
  const { dom, tree } = lay(
    "<div id=v>中a</div>",
    "#v{writing-mode:vertical-rl;text-orientation:sideways;height:80px}",
  );
  const gs = textFrag(tree, dom)!.text!.glyphs;
  assert.ok(gs.every((g) => g.rotate90 === true));
});

void test("sideways-rl implies sideways orientation for all glyphs", () => {
  const { dom, tree } = lay(
    "<div id=v>中a</div>",
    "#v{writing-mode:sideways-rl;height:80px}",
  );
  const gs = textFrag(tree, dom)!.text!.glyphs;
  assert.ok(gs.every((g) => g.rotate90 === true));
});

void test("horizontal-tb output is byte-identical (regression)", () => {
  const plain = lay("<div id=d>a b c</div><p>x</p>");
  const t = textFrag(plain.tree, plain.dom)!;
  assert.equal(t.text!.writingMode, undefined);
  assert.equal(t.text!.advanceAxis, undefined);
  const div = absFrag(plain.tree, nodeByTag(plain.dom, "d"))!;
  assert.equal(Number(div.abs.x), 8);
  assert.equal(Number(div.abs.y), 8);
});
