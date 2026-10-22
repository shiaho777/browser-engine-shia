/**
 * Bidi (UAX #9) — RFC 0023. Two layers under test:
 *
 *   1. The engine-owned algorithm in `@browser-engine/layout`'s `bidi.ts`:
 *      full bidi classes (strongs, weak EN/ES/ET/AN/CS/NSM, neutrals, BN, and
 *      the explicit-format controls), the X/W/N/I resolution, and the
 *      multi-owner {@link visualOrderParts} the inline run is built on.
 *   2. Layout integration through the real pipeline (`parseHtml` → `cascade`
 *      with the UA sheet → `layout`): `dir`/`dir=auto`, `unicode-bidi`,
 *      `<bdo>`/`<bdi>` (UA rules), cross-member paragraph order, and
 *      direction-aware `text-align: start`.
 *
 * Glyph ids are source code points under the placeholder shaper, so a text
 * fragment's glyph sequence shows the emitted word order directly.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { DomTree, FragmentTree, NodeId } from "@browser-engine/ir";
import { parseHtml } from "@browser-engine/html-parser";
import { parseCss } from "@browser-engine/css-parser";
import { cascade } from "@browser-engine/cascade";
import {
  BIDI_CTRL,
  bidiClass,
  layout,
  resolveLevels,
  visualOrderParts,
} from "@browser-engine/layout";
import { uaStylesheet } from "./stylesheets.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const H = "אבג"; // Hebrew alef-bet-gimel (strong R)
const c = String.fromCodePoint;

// ---------------------------------------------------------------------------
// Pipeline helpers
// ---------------------------------------------------------------------------

/** parseHtml → cascade(UA + author) → layout for `html`. */
function lay(html: string, css = ""): { dom: DomTree; tree: FragmentTree } {
  const dom: DomTree = parseHtml(enc(html));
  const sheets = [uaStylesheet(), ...(css !== "" ? [parseCss(enc(css))] : [])];
  const styleOf = (n: NodeId) => cascade(dom, sheets, n);
  return { dom, tree: layout(dom, styleOf) };
}

interface TextFrag {
  readonly logical: string;
  readonly glyphs: string; // emitted glyph order (code points)
  readonly x: number;
  readonly width: number;
}

/** Text-bearing leaf fragments in document order. */
function textFrags({ dom, tree }: { dom: DomTree; tree: FragmentTree }): TextFrag[] {
  const out: TextFrag[] = [];
  for (const f of tree.fragments.values()) {
    const n = dom.nodes.get(f.node);
    if (n !== undefined && n.kind === "text" && f.text !== undefined) {
      out.push({
        logical: n.text ?? "",
        glyphs: f.text.glyphs.map((g) => c(g.glyphId)).join(""),
        x: Number(f.box.borderBox.x),
        width: Number(f.box.borderBox.width),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bidi classes (UAX #9 classification coverage)
// ---------------------------------------------------------------------------

void test("bidiClass covers strongs, weak types, neutrals, and controls", () => {
  assert.equal(bidiClass("a"), "L");
  assert.equal(bidiClass("א"), "R");
  assert.equal(bidiClass("ب"), "AL");
  assert.equal(bidiClass("5"), "EN");
  assert.equal(bidiClass("٠"), "AN");
  assert.equal(bidiClass("+"), "ES");
  assert.equal(bidiClass("$"), "ET");
  assert.equal(bidiClass(","), "CS");
  assert.equal(bidiClass("́"), "NSM"); // combining acute
  assert.equal(bidiClass(" "), "WS");
  assert.equal(bidiClass("\t"), "S");
  assert.equal(bidiClass("\n"), "B");
  assert.equal(bidiClass("!"), "ON");
  assert.equal(bidiClass("‏"), "BN"); // RLM is a boundary neutral
  assert.equal(bidiClass(c(BIDI_CTRL.LRE)), "LRE");
  assert.equal(bidiClass(c(BIDI_CTRL.RLO)), "RLO");
  assert.equal(bidiClass(c(BIDI_CTRL.FSI)), "FSI");
  assert.equal(bidiClass(c(BIDI_CTRL.PDI)), "PDI");
});

// ---------------------------------------------------------------------------
// Explicit-format characters (X rules)
// ---------------------------------------------------------------------------

void test("resolveLevels: RLO overrides the direction of strong text", () => {
  const levels = resolveLevels("a" + c(BIDI_CTRL.RLO) + "bc" + c(BIDI_CTRL.PDF) + "d", "ltr");
  // a=0, controls at base, overridden bc at odd level, d back at 0.
  assert.equal(levels[0]!, 0);
  assert.equal(levels[2]! % 2, 1, "b under RLO is odd level");
  assert.equal(levels[3]! % 2, 1, "c under RLO is odd level");
  assert.equal(levels[5]!, 0);
});

void test("resolveLevels: an isolate re-bases its interior (L inside RLI is deeper)", () => {
  // LTR base, RLI wrapping latin: interior resolves inside the isolate —
  // latin at the isolate's odd level gets bumped by I2 to level+1 (even 2).
  const levels = resolveLevels("x" + c(BIDI_CTRL.RLI) + "ab" + c(BIDI_CTRL.PDI) + "y", "ltr");
  assert.equal(levels[2]!, 2, "latin inside an RTL isolate sits one level deeper");
  assert.equal(levels[4]!, 0);
});

void test("resolveLevels: FSI picks direction from the first strong inside", () => {
  const rtl = resolveLevels(c(BIDI_CTRL.FSI) + H + "x" + c(BIDI_CTRL.PDI), "ltr");
  assert.equal(rtl[1]! % 2, 1, "FSI with Hebrew inside is RTL");
  const ltr = resolveLevels(c(BIDI_CTRL.FSI) + "ab" + c(BIDI_CTRL.PDI), "ltr");
  assert.equal(ltr[1]! % 2, 0, "FSI with Latin inside is LTR");
});

void test("resolveLevels: PDF does not cross an isolate boundary", () => {
  // The inner PDF inside the isolate is consumed by the isolate scope; the
  // outer text must not escape into the outer level early.
  const t = "a" + c(BIDI_CTRL.RLE) + c(BIDI_CTRL.RLI) + "b" + c(BIDI_CTRL.PDF) + "c" + c(BIDI_CTRL.PDI) + "d";
  const levels = resolveLevels(t, "ltr");
  assert.equal(levels[t.length - 1]!, 2, "d stays inside the level-2 RLE embedding");
});

void test("unmatched explicit codes are ignored, not fatal", () => {
  const levels = resolveLevels("a" + c(BIDI_CTRL.PDI) + c(BIDI_CTRL.PDF) + "b", "ltr");
  assert.equal(levels[0]!, 0);
  assert.equal(levels[3]!, 0);
});

// ---------------------------------------------------------------------------
// Weak types + neutrals
// ---------------------------------------------------------------------------

void test("numbers keep LTR inside an RTL paragraph (W7/I2)", () => {
  const logical = "a " + H + " 12 b";
  const levels = resolveLevels(logical, "rtl");
  // EN at odd embedding level resolves one level deeper (level 2, LTR).
  const digitLevel = levels[[...logical].indexOf("1")]!;
  assert.equal(digitLevel % 2, 0, "digits sit at an even level");
  assert.equal(digitLevel, 2);
});

void test("N0: parentheses around RTL text keep the embedding direction", () => {
  // LTR paragraph with "(HEBREW)": both parens resolve L (level 0), so the
  // pair encloses the Hebrew run visually instead of flipping around it.
  const logical = "a (" + H + ") b";
  const levels = resolveLevels(logical, "ltr");
  assert.equal(levels[2]!, 0, "open paren stays at base level");
  assert.equal(levels[6]!, 0, "close paren stays at base level");
});

// ---------------------------------------------------------------------------
// Multi-owner itemization (the inline run's paragraph stream)
// ---------------------------------------------------------------------------

void test("visualOrderParts reorders runs ACROSS owner boundaries", () => {
  // Hebrew | atomic(U+FFFC) | Hebrew at RTL base: all level 1, one run —
  // parts arrive per-owner for independent shaping/measurement.
  const parts = visualOrderParts(
    [{ text: H }, { text: "￼" }, { text: "דה" }],
    "rtl",
  );
  assert.deepEqual(
    parts.map((p) => p.owner),
    [0, 1, 2],
  );
  assert.ok(parts.every((p) => p.level === 1));
});

void test("visualOrderParts splits paragraphs at B-class chars and emits hardBreak", () => {
  const parts = visualOrderParts([{ text: "ab\ncd" }], "ltr");
  assert.deepEqual(
    parts.map((p) => (p.hardBreak === true ? "BR" : p.text)),
    ["ab", "BR", "cd"],
  );
});

void test("visualOrderParts resolves each paragraph's base independently", () => {
  // A Hebrew second paragraph gets RTL even inside an LTR document when the
  // base is content-resolved (dir=auto / plaintext path).
  const parts = visualOrderParts([{ text: "ab\n" + H }]);
  const second = parts.find((p) => p.text === H);
  assert.equal(second?.level, 1);
});

// ---------------------------------------------------------------------------
// Layout integration
// ---------------------------------------------------------------------------

void test("layout: LTR paragraph keeps word order, RTL run inside paints in place", () => {
  const frags = textFrags(lay(`<p>a ${H} b</p>`));
  assert.equal(frags.length, 1);
  assert.equal(frags[0]!.glyphs, `a${H}b`);
});

void test("layout: direction:rtl reverses word order and start-aligns right", () => {
  const r = lay(`<p class=x>ab ${H} cd</p>`, ".x{direction:rtl;width:100px}");
  const frags = textFrags(r);
  assert.equal(frags.length, 1);
  assert.equal(frags[0]!.glyphs, `cd${H}ab`, "rtl paragraph emits words right-to-left");
  assert.ok(frags[0]!.x > 0, "text-align:start on rtl resolves to the right edge");
});

void test("layout: unicode-bidi:bidi-override forces the container's direction", () => {
  const frags = textFrags(
    lay(`<p class=x>ab cd</p>`, ".x{unicode-bidi:bidi-override;direction:rtl}"),
  );
  assert.equal(frags[0]!.glyphs, "cdab", "override reverses the whole line");
});

void test("layout: unicode-bidi:isolate-override wraps content in isolate+override", () => {
  const frags = textFrags(
    lay(`<p class=x>ab cd</p>`, ".x{unicode-bidi:isolate-override;direction:rtl}"),
  );
  assert.equal(frags[0]!.glyphs, "cdab");
});

void test("layout: dir=rtl attribute sets direction through the UA sheet", () => {
  const frags = textFrags(lay(`<p dir=rtl>ab ${H} cd</p>`));
  assert.equal(frags[0]!.glyphs, `cd${H}ab`);
});

void test("layout: dir=auto resolves the paragraph base from content", () => {
  // First strong char is Hebrew → rtl paragraph → the Latin tail lands left.
  const rtl = textFrags(lay(`<p dir=auto>${H} ab</p>`));
  assert.equal(rtl[0]!.glyphs, `ab${H}`, "dir=auto picked rtl from Hebrew content");
  const ltr = textFrags(lay(`<p dir=auto>ab ${H}</p>`));
  assert.equal(ltr[0]!.glyphs, `ab${H}`, "dir=auto picked ltr from Latin content");
});

void test("layout: <bdo dir=rtl> reverses its own content (UA bidi-override)", () => {
  const frags = textFrags(lay(`<p>x<bdo dir=rtl>ab cd</bdo>y</p>`));
  const bdo = frags.find((f) => f.logical === "ab cd");
  assert.equal(bdo?.glyphs, "cdab", "bdo content overrides to rtl");
});

void test("layout: <bdi dir=auto> isolates and resolves first-strong inside", () => {
  // The bdi box is an atomic object in the outer paragraph; `dir=auto` gives
  // its interior the first-strong base (Hebrew first ⇒ rtl interior) without
  // disturbing the surrounding Latin words.
  const frags = textFrags(lay(`<p>a<bdi dir=auto>${H} xy</bdi>b</p>`));
  const inner = frags.find((f) => f.logical === `${H} xy`);
  const a = frags.find((f) => f.logical === "a");
  const b = frags.find((f) => f.logical === "b");
  assert.equal(inner?.glyphs, `xy${H}`, "bdi dir=auto interior resolves rtl");
  assert.equal(a?.glyphs, "a");
  assert.equal(b?.glyphs, "b");
  assert.ok(a !== undefined && b !== undefined && inner !== undefined);
});

void test("layout: atomic boxes reorder with the paragraph's level runs", () => {
  // RTL paragraph: logical [אאא][img][בבב] → visual בבב,img,אאא — the img sits
  // BETWEEN the two Hebrew words, not at the logical boundary.
  const r = lay(`<p class=x>אאא<img>בבב</p>`, ".x{direction:rtl} img{width:20px;height:20px}");
  const placed: { tag: string; x: number }[] = [];
  for (const f of r.tree.fragments.values()) {
    const n = r.dom.nodes.get(f.node);
    if (n !== undefined && (n.kind === "text" || n.tag === "img")) {
      placed.push({ tag: f.text ? (n.text ?? "text") : "img", x: Number(f.box.borderBox.x) });
    }
  }
  placed.sort((a, b) => a.x - b.x);
  assert.deepEqual(
    placed.map((p) => p.tag),
    ["בבב", "img", "אאא"],
    "RTL paragraph paints בבב | img | אאא left-to-right",
  );
});

void test("layout: digits inside RTL text stay left-to-right", () => {
  const frags = textFrags(lay(`<p dir=rtl>${H} 12</p>`));
  // The "12" run keeps its digits in order — glyphs show "12", never "21".
  assert.ok(frags[0]!.glyphs.includes("12"));
  assert.ok(!frags[0]!.glyphs.includes("21"));
});

void test("layout: preserved newlines still hard-break inside bidi runs", () => {
  const frags = textFrags(
    lay(`<p class=x>ab\ncd</p>`, ".x{white-space:pre-wrap;direction:rtl}"),
  );
  const f = frags[0]!;
  assert.ok(f.glyphs.includes("cd") && f.glyphs.includes("ab"));
  const ys = new Set<number>();
  const r = lay(`<p class=x>ab\ncd</p>`, ".x{white-space:pre-wrap;direction:rtl}");
  for (const frag of r.tree.fragments.values()) {
    if (frag.text) {
      for (const g of frag.text.glyphs) ys.add(Number(g.y));
    }
  }
  assert.equal(ys.size, 2, "two lines of glyphs");
  void f;
});

void test("layout: pure-LTR documents are byte-identical (no bidi drift)", () => {
  const a = textFrags(lay("<p>The quick brown fox jumps 42 times</p>"));
  assert.equal(a[0]!.glyphs, "Thequickbrownfoxjumps42times");
});
