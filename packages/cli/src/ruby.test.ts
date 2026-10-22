/**
 * Ruby — RFC 0026. Under test:
 *
 *   1. Partition: children split by COMPUTED display (`ruby-text`,
 *      `ruby-text-container`, `ruby-base`, `none`) — `<rp>` parens never
 *      paint, `rb`/`rbc` unwrap, bare text is base content.
 *   2. Geometry: the ruby box shrink-wraps to max(base, widest annotation);
 *      the narrower run centres under `space-around`/`center` and flushes
 *      to the inline-start edge under `start`; annotations stack on the
 *      `ruby-position` side and grow the box's block extent.
 *   3. Atomic integration: `display:ruby` is inline-level — it packs into
 *      a line box between text runs and the LINE grows to fit it; the
 *      atomic baseline is the BASE run's baseline (`rubyBaselineOff`).
 *   4. Cascade plumbing: `rt { font-size: 50% }` resolves through the
 *      font-size percentage fix (`resolveFontSizeLength`); `ruby-position:
 *      under` drops the annotation below the base; inside `writing-mode:
 *      vertical-rl` the annotation transposes to the base's right side.
 *
 * Placeholder shaper: glyphId = code point, advance = fontSize/2.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  px,
  type DomTree,
  type Fragment,
  type FragmentTree,
  type NodeId,
} from "@browser-engine/ir";
import { parseHtml } from "@browser-engine/html-parser";
import { parseCss } from "@browser-engine/css-parser";
import { cascade } from "@browser-engine/cascade";
import { layout } from "@browser-engine/layout";
import { uaStylesheet } from "./stylesheets.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function lay(
  html: string,
  css = "",
  w = 400,
  h = 300,
): { dom: DomTree; tree: FragmentTree; styleOf: (n: NodeId) => ReturnType<typeof cascade> } {
  const dom: DomTree = parseHtml(enc(html));
  const sheets = [uaStylesheet(), ...(css !== "" ? [parseCss(enc(css))] : [])];
  const styleOf = (n: NodeId) => cascade(dom, sheets, n);
  return { dom, styleOf, tree: layout(dom, styleOf, { viewportWidth: px(w), viewportHeight: px(h) }) };
}

function nodeByTag(dom: DomTree, tag: string, nth = 0): NodeId {
  let seen = 0;
  for (const [id, n] of dom.nodes) {
    if (n.kind === "element" && n.tag === tag) {
      if (seen === nth) return id;
      seen += 1;
    }
  }
  throw new Error(`no <${tag}>#${nth}`);
}

/** The fragment for `node` — coords stay parent-space (marginBox-origin). */
function fragOf(tree: FragmentTree, node: NodeId): Fragment {
  for (const f of tree.fragments.values()) {
    if (f.node === node) return f;
  }
  throw new Error("no fragment");
}

/** Text carried by the fragment for `node`, or "" for a box. */
function textOf(tree: FragmentTree, node: NodeId): string {
  const f = fragOf(tree, node);
  return f.text === undefined
    ? ""
    : f.text.glyphs.map((g) => String.fromCodePoint(g.glyphId)).join("");
}

/** The text node ids in document order under `root`. */
function textNodes(dom: DomTree, root: NodeId): NodeId[] {
  const out: NodeId[] = [];
  const walk = (id: NodeId): void => {
    const n = dom.nodes.get(id);
    if (n === undefined) return;
    if (n.kind === "text" && (n.text ?? "").trim() !== "") out.push(id);
    for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
}

void test("ruby: annotation sits above the base and the box shrink-wraps", () => {
  const { dom, tree } = lay(`<div><ruby id="r">漢<rt>かん</rt></ruby></div>`);
  const ruby = fragOf(tree, nodeByTag(dom, "ruby"));
  const rt = fragOf(tree, nodeByTag(dom, "rt"));
  const base = fragOf(tree, textNodes(dom, nodeByTag(dom, "ruby"))[0]!);
  assert.equal(Number(ruby.box.contentBox.width), 8); // 漢 = 16px*0.5
  assert.equal(Number(ruby.box.contentBox.height), 24); // 16 base + 8 annotation
  // Annotation at the top of the ruby box, base below it (children are
  // stored in the ruby's own margin-box space).
  assert.equal(Number(rt.box.contentBox.y), 0);
  assert.equal(Number(base.box.contentBox.y), 8);
  assert.equal(textOf(tree, nodeByTag(dom, "rt")), "かん");
});

void test("ruby: a wider annotation widens the box and centres the base", () => {
  const { dom, tree } = lay(`<div><ruby id="r">A<rt>longannotation</rt></ruby></div>`);
  const ruby = fragOf(tree, nodeByTag(dom, "ruby"));
  const base = fragOf(tree, textNodes(dom, nodeByTag(dom, "ruby"))[0]!);
  // rt = 14 glyphs × 8px × 0.5 = 56; base "A" = 8 → box takes the annotation's width.
  assert.equal(Number(ruby.box.contentBox.width), 56);
  assert.equal(Number(base.box.contentBox.x), (56 - 8) / 2);
});

void test("ruby: `ruby-align: start` flushes the narrower run to inline-start", () => {
  const { dom, tree } = lay(
    `<div><ruby id="r" style="ruby-align:start">A<rt>longannotation</rt></ruby></div>`,
  );
  const base = fragOf(tree, textNodes(dom, nodeByTag(dom, "ruby"))[0]!);
  assert.equal(Number(base.box.contentBox.x), 0);
});

void test("ruby: <rp> parens never paint", () => {
  const { dom, tree } = lay(`<div><ruby id="r">漢<rp>(</rp><rt>かん</rt><rp>)</rp></ruby></div>`);
  // No fragment may carry the paren text nodes.
  const rpNodes: NodeId[] = [];
  for (const [id, n] of dom.nodes) if (n.kind === "element" && n.tag === "rp") rpNodes.push(id);
  for (const f of tree.fragments.values()) {
    for (const rp of rpNodes) assert.notEqual(f.node, rp);
  }
  assert.equal(Number(fragOf(tree, nodeByTag(dom, "ruby")).box.contentBox.width), 8);
});

void test("ruby: `ruby-position: under` moves the annotation below the base", () => {
  const { dom, tree } = lay(
    `<div><ruby id="r"><rb>漢字</rb><rt style="ruby-position:under">かんじ</rt></ruby></div>`,
  );
  const rt = fragOf(tree, nodeByTag(dom, "rt"));
  const base = fragOf(tree, textNodes(dom, nodeByTag(dom, "rb"))[0]!);
  assert.equal(Number(base.box.contentBox.y), 0);
  assert.equal(Number(rt.box.contentBox.y), 16); // below the 16px base line
});

void test("ruby: <rb>/<rbc> unwrap into base content", () => {
  const { dom, tree } = lay(`<div><ruby id="r"><rbc><rb>漢</rb><rb>字</rb></rbc><rt>かんじ</rt></ruby></div>`);
  const ruby = fragOf(tree, nodeByTag(dom, "ruby"));
  assert.equal(Number(ruby.box.contentBox.width), 16); // 2 chars × 8px
});

void test("ruby: <rtc> contributes stacked annotations", () => {
  const { dom, tree } = lay(
    `<div><ruby id="r"><rb>漢字</rb><rtc><rt>a1</rt><rt>a2</rt></rtc></ruby></div>`,
  );
  const ruby = fragOf(tree, nodeByTag(dom, "ruby"));
  assert.equal(Number(ruby.box.contentBox.height), 16 + 8 + 8); // base + two anns
  // Both rt fragments stack above the base, closest annotation adjacent.
  const rt0 = fragOf(tree, nodeByTag(dom, "rt", 0));
  const rt1 = fragOf(tree, nodeByTag(dom, "rt", 1));
  assert.equal(Number(rt0.box.contentBox.y), 8);
  assert.equal(Number(rt1.box.contentBox.y), 0);
});

void test("ruby: flows inline between text runs and the line grows to fit it", () => {
  const { dom, tree } = lay(`<div id="d">前<ruby id="r">漢<rt>かん</rt></ruby>後</div>`);
  const d = fragOf(tree, nodeByTag(dom, "div"));
  const ruby = fragOf(tree, nodeByTag(dom, "ruby"));
  // Ruby is the SECOND inline member: 前 ends at x=8.
  assert.equal(Number(ruby.box.marginBox.x), 8);
  // Its 24px margin box sits on a 24px-tall line — annotation included.
  assert.equal(Number(d.box.contentBox.height), 24);
  // And the following text continues on the same line (x=16), not wrapped.
  // (Index 3: the walk also descends into the ruby — 漢 and かん's text
  // nodes come between 前 and 後.)
  const after = fragOf(tree, textNodes(dom, nodeByTag(dom, "div"))[3]!);
  assert.equal(Number(after.box.contentBox.x), 16);
  assert.equal(Number(after.box.contentBox.y), Number(fragOf(tree, textNodes(dom, nodeByTag(dom, "div"))[0]!).box.contentBox.y));
});

void test("ruby: the atomic baseline is the BASE run's baseline", () => {
  const { dom, tree } = lay(`<div id="d">x<ruby id="r">漢<rt>かん</rt></ruby></div>`);
  const ruby = fragOf(tree, nodeByTag(dom, "ruby"));
  const textFrag = fragOf(tree, textNodes(dom, nodeByTag(dom, "div"))[0]!);
  // Baseline alignment puts the ruby's BASE baseline on the line baseline,
  // so its margin box pokes 8px (the annotation's height) above the text
  // run's top instead of hanging off the bottom margin edge.
  assert.equal(Number(ruby.box.marginBox.y), Number(textFrag.box.contentBox.y) - 8);
});

void test("ruby: annotation text uses its own computed style (font-size 50%)", () => {
  const { dom, tree, styleOf } = lay(`<div><ruby id="r" style="font-size:20px">漢<rt>かん</rt></ruby></div>`);
  const rtId = nodeByTag(dom, "rt");
  assert.equal(Number(styleOf(rtId).fontSize), 10);
  const rt = fragOf(tree, rtId);
  assert.equal(Number(rt.box.contentBox.height), 10); // line box = rt's own line-height × size
});

void test("ruby: nested inside vertical-rl the annotation lands on the right", () => {
  const { dom, tree } = lay(
    `<div id="v" style="writing-mode:vertical-rl"><ruby id="r">漢<rt>かん</rt></ruby></div>`,
  );
  const rt = fragOf(tree, nodeByTag(dom, "rt"));
  const base = fragOf(tree, textNodes(dom, nodeByTag(dom, "ruby"))[0]!);
  // After the v-rl transposition "over" the base = to its RIGHT.
  assert.ok(Number(rt.box.contentBox.x) > Number(base.box.contentBox.x));
  assert.equal(Number(rt.box.contentBox.y), Number(base.box.contentBox.y));
});

void test("ruby: stray <rt> outside a ruby renders as ordinary inline text", () => {
  const { dom, tree } = lay(`<div><rt>plain</rt></div>`);
  const f = fragOf(tree, nodeByTag(dom, "rt"));
  assert.ok(Number(f.box.contentBox.width) > 0);
});

void test("ruby: annotation-only ruby (no base) still shows its rt", () => {
  const { dom, tree } = lay(`<div><ruby id="r"><rt>かん</rt></ruby></div>`);
  assert.equal(textOf(tree, nodeByTag(dom, "rt")), "かん");
  assert.ok(Number(fragOf(tree, nodeByTag(dom, "ruby")).box.contentBox.width) > 0);
});

void test("cascade: font-size percentages resolve against the parent font size", () => {
  const { dom, styleOf } = lay(`<div style="font-size:20px"><b id="b" style="font-size:150%">x</b></div>`);
  assert.equal(Number(styleOf(nodeByTag(dom, "b")).fontSize), 30);
});
