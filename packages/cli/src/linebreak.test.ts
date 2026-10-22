/**
 * Line breaking (UAX #14) — RFC 0024. Two layers under test:
 *
 *   1. The engine-owned classifier + pair table in `@browser-engine/layout`'s
 *      `linebreak.ts`: break classes over the pragmatic range set, the pair
 *      rules (BK mandatory, GL/WJ glue, closing/opening punctuation
 *      protection, number groups, ideographic × ideographic, CJ starters,
 *      soft hyphens, ZWSP), and the `word-break`/`line-break`/
 *      `overflow-wrap`/`hyphens` keyword adjustments.
 *   2. Layout integration through the real pipeline (`parseHtml` → `cascade`
 *      → `layout`): CJK char-level wrapping, punctuation that must not start
 *      a line, `word-break: keep-all`/`break-all`, `line-break: loose`,
 *      ZWSP breaks, and soft-hyphen hyphen rendering.
 *
 * Glyph ids are source code points under the placeholder shaper (8px each at
 * the default 16px font), so a fragment's glyph sequence + y-coordinates show
 * both emitted text and line assignment directly.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { px, type DomTree, type FragmentTree, type NodeId } from "@browser-engine/ir";
import { parseHtml } from "@browser-engine/html-parser";
import { parseCss } from "@browser-engine/css-parser";
import { cascade } from "@browser-engine/cascade";
import {
  breakUnits,
  lbClass,
  layout,
  pairBreak,
} from "@browser-engine/layout";
import { uaStylesheet } from "./stylesheets.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const cp = String.fromCodePoint;

/** parseHtml → cascade(UA + author) → layout for `html`. */
function lay(html: string, css = "", w = 800): { dom: DomTree; tree: FragmentTree } {
  const dom: DomTree = parseHtml(enc(html));
  const sheets = [uaStylesheet(), ...(css !== "" ? [parseCss(enc(css))] : [])];
  const styleOf = (n: NodeId) => cascade(dom, sheets, n);
  return { dom, tree: layout(dom, styleOf, { viewportWidth: px(w) }) };
}

/**
 * Glyphs as `text@y` lines — group by line-top, order by x — showing the
 * visual line contents of every text fragment.
 */
function lines({ dom, tree }: { dom: DomTree; tree: FragmentTree }): string[] {
  const pts: { ch: string; x: number; y: number }[] = [];
  for (const f of tree.fragments.values()) {
    const n = dom.nodes.get(f.node);
    if (n !== undefined && n.kind === "text" && f.text !== undefined) {
      for (const g of f.text.glyphs) {
        pts.push({
          ch: cp(g.glyphId),
          x: Number(g.x) + Number(f.box.contentBox.x),
          y: Number(g.y) + Number(f.box.contentBox.y),
        });
      }
    }
  }
  pts.sort((a, b) => a.y - b.y || a.x - b.x);
  const out: string[] = [];
  let lastY = Number.NaN;
  for (const g of pts) {
    if (g.y !== lastY) {
      out.push("");
      lastY = g.y;
    }
    out[out.length - 1] += g.ch;
  }
  return out.filter((s) => s !== "");
}

// ---------------------------------------------------------------------------
// lbClass coverage
// ---------------------------------------------------------------------------

void test("lbClass covers the pragmatic UAX #14 class set", () => {
  assert.equal(lbClass(0x0a), "BK"); // \n
  assert.equal(lbClass(0x20), "SP");
  assert.equal(lbClass(0x09), "SP"); // tab folds into the space run
  assert.equal(lbClass(0x200b), "ZW");
  assert.equal(lbClass(0x2060), "WJ");
  assert.equal(lbClass(0x00a0), "GL"); // NBSP
  assert.equal(lbClass(0x00ad), "SHY");
  assert.equal(lbClass(0x2014), "BA"); // em dash
  assert.equal(lbClass(0x2d), "HY"); // hyphen-minus
  assert.equal(lbClass(0x29), "CL"); // )
  assert.equal(lbClass(0x3002), "CL"); // 。
  assert.equal(lbClass(0xff0c), "CL"); // 、-ish fullwidth comma
  assert.equal(lbClass(0x28), "OP"); // (
  assert.equal(lbClass(0x300a), "OP"); // 《
  assert.equal(lbClass(0x21), "EX"); // !
  assert.equal(lbClass(0x2c), "IS"); // ,
  assert.equal(lbClass(0x22), "QU"); // "
  assert.equal(lbClass(0x35), "NU");
  assert.equal(lbClass(0x24), "PR"); // $
  assert.equal(lbClass(0x25), "PO"); // %
  assert.equal(lbClass(0x4e2d), "ID"); // 中
  assert.equal(lbClass(0x3042), "ID"); // あ
  assert.equal(lbClass(0x3041), "CJ"); // ぁ small kana
  assert.equal(lbClass(0x1f1fa), "RI"); // regional indicator
  assert.equal(lbClass(0x61), "AL"); // a
});

// ---------------------------------------------------------------------------
// pairBreak — the pair table
// ---------------------------------------------------------------------------

void test("pairBreak: ideographic × ideographic, and keep-all joins them", () => {
  assert.equal(pairBreak("ID", "ID", {}), true);
  assert.equal(pairBreak("ID", "ID", { keepAll: true }), false);
  // keep-all does NOT suppress a CJK–Latin boundary.
  assert.equal(pairBreak("ID", "AL", { keepAll: true }), true);
  assert.equal(pairBreak("AL", "ID", {}), true);
});

void test("pairBreak: closing/opening punctuation protection", () => {
  assert.equal(pairBreak("ID", "CL", {}), false, "no break before 、。");
  assert.equal(pairBreak("AL", "CL", {}), false);
  assert.equal(pairBreak("ID", "EX", {}), false, "no break before !？");
  assert.equal(pairBreak("OP", "ID", {}), false, "no break after (《");
  assert.equal(pairBreak("OP", "AL", {}), false);
});

void test("pairBreak: number groups and currency stay glued", () => {
  assert.equal(pairBreak("NU", "NU", {}), false);
  assert.equal(pairBreak("NU", "IS", {}), false); // 1,
  assert.equal(pairBreak("IS", "NU", {}), false); // ,234
  assert.equal(pairBreak("NU", "PO", {}), false); // 50%
  assert.equal(pairBreak("PR", "NU", {}), false); // $12
  assert.equal(pairBreak("HY", "NU", {}), false); // 1-2 (LB22)
  assert.equal(pairBreak("HY", "AL", {}), true); // foo-bar
});

void test("pairBreak: letters never split without break-all", () => {
  assert.equal(pairBreak("AL", "AL", {}), false);
  assert.equal(pairBreak("AL", "NU", {}), false);
  assert.equal(pairBreak("NU", "AL", {}), false);
  assert.equal(pairBreak("AL", "AL", { breakAll: true }), true);
});

void test("pairBreak: glue classes and CJ starters", () => {
  assert.equal(pairBreak("AL", "GL", {}), false, "NBSP is glue");
  assert.equal(pairBreak("GL", "AL", {}), false);
  assert.equal(pairBreak("WJ", "ID", {}), false);
  assert.equal(pairBreak("ID", "WJ", {}), false);
  assert.equal(pairBreak("ID", "CJ", {}), false, "small kana never starts a line");
  assert.equal(pairBreak("ID", "CJ", { lineBreak: "loose" }), true);
  assert.equal(pairBreak("ID", "CJ", { lineBreak: "strict" }), false);
  assert.equal(pairBreak("RI", "RI", {}), false, "flags stay paired");
  assert.equal(pairBreak("AL", "EX", { anywhere: true }), true, "anywhere overrides all");
});

// ---------------------------------------------------------------------------
// breakUnits — whitespace fold, ZW, SHY, hard breaks
// ---------------------------------------------------------------------------

void test("breakUnits: whitespace folds to spaceBefore, never into text", () => {
  const u = breakUnits("a  b\tc", {});
  assert.deepEqual(
    u.map((x) => [x.text, x.spaceBefore]),
    [["a", false], ["b", true], ["c", true]],
  );
});

void test("breakUnits: CJK splits per char, ZWSP is a zero-width boundary", () => {
  const u = breakUnits("中中文", {});
  assert.deepEqual(u.map((x) => x.text), ["中", "中", "文"]);
  const z = breakUnits("ab​cd", {});
  assert.deepEqual(
    z.map((x) => [x.text, x.spaceBefore]),
    [["ab", false], ["cd", false]],
  );
});

void test("breakUnits: soft hyphen is a flagged break; none keeps it silent", () => {
  const u = breakUnits("dis­play", {});
  assert.deepEqual(
    u.map((x) => [x.text, x.shyAfter]),
    [["dis", true], ["play", false]],
  );
  const n = breakUnits("dis­play", { hyphens: "none" });
  assert.deepEqual(
    n.map((x) => [x.text, x.shyAfter]),
    [["display", false]],
    "hyphens:none — the shy vanishes and never breaks",
  );
});

void test("breakUnits: word joiner glues and vanishes from unit text", () => {
  const u = breakUnits("a⁠b", {});
  assert.equal(u.length, 1, "WJ prevents the break");
  assert.equal(u[0]!.text, "ab", "WJ itself never reaches the shaper");
});

void test("breakUnits: newlines count as hardBreaksBefore", () => {
  const u = breakUnits("a\n\nb", {});
  assert.deepEqual(
    u.map((x) => [x.text, x.hardBreaksBefore]),
    [["a", 0], ["b", 2]],
  );
});

// ---------------------------------------------------------------------------
// Layout integration
// ---------------------------------------------------------------------------

void test("layout: CJK text wraps between any two ideographs", () => {
  // p width 24 → three 8px glyphs per line.
  const out = lines(lay("<p>中中中中中</p>", "p{width:24px}", 200));
  assert.deepEqual(out, ["中中中", "中中"]);
});

void test("layout: a closing punctuation never starts a line", () => {
  // Width 40 fits exactly five glyphs: 中中中中、…
  const out = lines(lay("<p>中中中中、中中中</p>", "p{width:40px}", 200));
  assert.deepEqual(out, ["中中中中、", "中中中"], "、 rides with its line");
});

void test("layout: opening punctuation never ends a line", () => {
  const out = lines(lay("<p>中中中中（中中</p>", "p{width:40px}", 200));
  assert.deepEqual(out, ["中中中中", "（中中"], "（ wraps to the next line");
});

void test("layout: word-break:keep-all suppresses CJK breaks", () => {
  const out = lines(
    lay("<p style='word-break:keep-all'>中中中中中</p>", "p{width:24px}", 200),
  );
  assert.deepEqual(out, ["中中中中中"], "one unbreakable run overflows");
});

void test("layout: word-break:break-all splits latin per character", () => {
  const out = lines(
    lay("<p style='word-break:break-all'>hello</p>", "p{width:24px}", 200),
  );
  assert.deepEqual(out, ["hel", "lo"]);
});

void test("layout: ZWSP is an invisible break opportunity", () => {
  const out = lines(lay("<p>ab​cd</p>", "p{width:24px}", 200));
  assert.deepEqual(out, ["ab", "cd"]);
});

void test("layout: soft hyphen shows '-' at the break", () => {
  const out = lines(lay("<p>dis­play</p>", "p{width:40px}", 200));
  assert.deepEqual(out, ["dis-", "play"]);
  const none = lines(
    lay("<p>dis­play</p>", "p{width:40px;hyphens:none}", 200),
  );
  assert.deepEqual(none, ["display"], "hyphens:none keeps the run glued");
});

void test("layout: line-break:loose allows a break before small kana", () => {
  // きゃ pairs: normal keeps them together; loose can split the pair.
  const normal = lines(lay("<p>きゃきゅきょきゃ</p>", "p{width:56px}", 200));
  assert.deepEqual(normal, ["きゃきゅきょ", "きゃ"]);
  const loose = lines(
    lay("<p style='line-break:loose'>きゃきゅきょきゃ</p>", "p{width:56px}", 200),
  );
  assert.deepEqual(loose, ["きゃきゅきょき", "ゃ"], "loose splits き|ゃ");
});

void test("layout: adjacent text nodes get no phantom space", () => {
  const out = lines(lay("<p>he<span>x</span>llo</p>", "", 800));
  assert.deepEqual(out, ["x", "hello"], "he+llo join; span atom sits apart");
});

void test("layout: a real space still breaks with its gap", () => {
  const { dom, tree } = lay("<p>a b</p>", "p{width:80px}", 200);
  // Find the 'b' glyph: it sits one space-advance (8px) after 'a'.
  let ax = -1;
  let bx = -1;
  for (const f of tree.fragments.values()) {
    const n = dom.nodes.get(f.node);
    if (n?.kind === "text" && f.text) {
      for (const g of f.text.glyphs) {
        const x = Number(g.x) + Number(f.box.contentBox.x);
        if (g.glyphId === 0x61) ax = x;
        if (g.glyphId === 0x62) bx = x;
      }
    }
  }
  assert.equal(bx - ax, 16, "8px glyph + 8px space gap");
});

void test("layout: long latin word with break-word splits on overflow only", () => {
  const out = lines(
    lay("<p style='overflow-wrap:break-word'>supercalifragilistic</p>", "p{width:48px}", 200),
  );
  // 48px → 6 glyphs/line; an unbreakable word splits at the line edge.
  assert.deepEqual(out, ["superc", "alifra", "gilist", "ic"]);
});
