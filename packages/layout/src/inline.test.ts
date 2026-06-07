/**
 * Unit tests for inline layout — text shaping + line breaking through the reused
 * text-shaping seam (task 5.7; design.md §8.2; Requirements 15.3, 8.1, 8.3).
 *
 * Built by `tsc` then run with: `node --test packages/layout/dist/*.test.js`.
 *
 * These exercise `layout`'s `layoutInline` path: a short run packs onto one
 * line; a long run wraps to multiple lines within the containing width; the line
 * height derives from font-size; and injecting a custom {@link TextShaper}
 * changes the measured width / break points — proving the HarfBuzz reuse seam is
 * actually consulted (Req 8.1 / 8.3) rather than a hard-coded estimate.
 *
 * Layout lives inside a *stage* package, so (per `local/no-cross-stage-import`)
 * it may import ONLY the frozen IR (`@browser-engine/ir`) and the package under
 * test — never html-parser / cascade. The DomTree input is therefore built here
 * by hand as a frozen IR value, and `ComputedStyle` is supplied through the same
 * `computedStyleOf` callback the pipeline injects.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { deepFreeze, nodeId, px } from "@browser-engine/ir";
import type {
  Color,
  ComputedStyle,
  DisplayValue,
  DomNode,
  DomTree,
  Edges,
  NodeId,
  Px,
} from "@browser-engine/ir";

import {
  METRICS_ADVANCE_RATIO,
  defaultShaper,
  layout,
  metricsShaper,
} from "./index.js";
import type { ShapedRun, ShapingFont, TextShaper } from "./index.js";

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
      node = { ...base, tag: spec.tag ?? "", attrs: new Map<string, string>() };
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
const TRANSPARENT: Color = { r: 0, g: 0, b: 0, a: 0 };
const ZERO_EDGES: Edges<Px> = { top: px(0), right: px(0), bottom: px(0), left: px(0) };

interface StyleSpec {
  readonly display?: DisplayValue;
  readonly width?: number | "auto";
  readonly height?: number | "auto";
  readonly margin?: Edges<Px>;
  readonly fontSize?: number;
}

/** Build a frozen, geometry-free ComputedStyle from a partial spec. */
function makeStyle(spec: StyleSpec = {}): ComputedStyle {
  const style = {
    display: spec.display ?? "inline",
    color: BLACK,
    fontSize: px(spec.fontSize ?? 16),
    margin: spec.margin ?? ZERO_EDGES,
    width: spec.width ?? "auto",
    height: spec.height ?? "auto",
    backgroundColor: TRANSPARENT,
  };
  return deepFreeze(style as unknown as ComputedStyle);
}

/** Make a `computedStyleOf` callback from a per-node style map (default: initial). */
function styleTable(map: ReadonlyMap<number, ComputedStyle>): (node: NodeId) => ComputedStyle {
  const fallback = makeStyle();
  return (node: NodeId) => map.get(node) ?? fallback;
}

/** A `document → div → text(content)` tree; the div is a block container. */
function divWithText(content: string): DomTree {
  return buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "text", text: content, parent: 1, children: [] },
  ]);
}

/** The text fragment of a `document → div → text` tree. */
function textFragmentOf(tree: ReturnType<typeof layout>) {
  const root = tree.fragments.get(tree.root)!;
  const div = tree.fragments.get(root.children[0]!)!;
  return tree.fragments.get(div.children[0]!)!;
}

const FONT_SIZE = 16;
const BLOCK_STYLE = styleTable(new Map([[1, makeStyle({ display: "block" })]]));

// ---------------------------------------------------------------------------
// Short text lays out on a single line, `fontSize` tall.
// ---------------------------------------------------------------------------

void test("a short run lays out on ONE line whose height === font-size (Req 15.3)", () => {
  // "hello" = 5 glyphs × 0.5 × 16 = 40px, far under the 800px viewport ⇒ 1 line.
  const tree = layout(divWithText("hello"), BLOCK_STYLE);
  const text = textFragmentOf(tree);

  assert.equal(text.box.height, px(FONT_SIZE), "single short line is exactly one em tall");
  assert.equal(text.box.width, px(5 * METRICS_ADVANCE_RATIO * FONT_SIZE)); // 40px.
  assert.ok(text.box.width <= 800);
});

void test("whitespace-only / empty text contributes a zero box (no line)", () => {
  for (const content of ["", "   ", "\n\t "]) {
    const tree = layout(divWithText(content), BLOCK_STYLE);
    const text = textFragmentOf(tree);
    assert.equal(text.box.height, px(0), `"${content}" renders no line`);
    assert.equal(text.box.width, px(0));
  }
});

// ---------------------------------------------------------------------------
// Long text wraps to multiple lines within the containing width.
// ---------------------------------------------------------------------------

void test("a long run wraps to MULTIPLE lines; height === lines × lineHeight (Req 15.3)", () => {
  // Each word is 10 glyphs ⇒ 10 × 0.5 × 16 = 80px; a space is 0.5 × 16 = 8px.
  // 20 words in a narrow 200px container must wrap to several lines.
  const word = "wwwwwwwwww"; // 10 chars.
  const content = Array.from({ length: 20 }, () => word).join(" ");
  const narrow = px(200);

  const tree = layout(divWithText(content), BLOCK_STYLE, { viewportWidth: narrow });
  const text = textFragmentOf(tree);

  // 200px holds floor((200 - 80) / 88) + 1 = 2 words per line ⇒ 10 lines.
  const lineHeight = FONT_SIZE;
  const lines = text.box.height / lineHeight;
  assert.ok(Number.isInteger(lines), "height must be a whole number of lines");
  assert.ok(lines > 1, `expected multiple lines, got ${lines}`);
  assert.equal(text.box.height, px(lines * lineHeight));
  // No line is wider than the containing width.
  assert.ok(text.box.width <= narrow, `widest line ${text.box.width} must fit ${narrow}`);
});

void test("a single word wider than the line occupies its own (overflowing) line", () => {
  // One 100-glyph word = 100 × 0.5 × 16 = 800px; in a 100px container it still
  // takes exactly one line (no mid-word break under white-space:normal).
  const word = "x".repeat(100);
  const tree = layout(divWithText(word), BLOCK_STYLE, { viewportWidth: px(100) });
  const text = textFragmentOf(tree);

  assert.equal(text.box.height, px(FONT_SIZE), "one unbreakable word ⇒ one line");
  // Its measured width is clamped to the containing width (it overflows).
  assert.equal(text.box.width, px(100));
});

void test("more words wrap to more lines as the container narrows (monotone in width)", () => {
  const content = Array.from({ length: 12 }, () => "abcde").join(" "); // 5-glyph words.
  const wide = textFragmentOf(layout(divWithText(content), BLOCK_STYLE, { viewportWidth: px(800) }));
  const narrow = textFragmentOf(layout(divWithText(content), BLOCK_STYLE, { viewportWidth: px(120) }));

  assert.equal(wide.box.height, px(FONT_SIZE), "everything fits on one wide line");
  assert.ok(narrow.box.height > wide.box.height, "a narrower container needs more lines");
});

// ---------------------------------------------------------------------------
// Line height derives from font-size.
// ---------------------------------------------------------------------------

void test("line height derives from font-size: a single line's height equals the font-size", () => {
  for (const fontSize of [10, 16, 24, 32]) {
    // layoutInline reads the TEXT node's style; font-size inherits to it in the
    // real pipeline, so set it on node 2 here.
    const styles = styleTable(
      new Map([
        [1, makeStyle({ display: "block" })],
        [2, makeStyle({ fontSize })],
      ]),
    );
    // A short word fits on one line at any of these sizes within 800px.
    const tree = layout(divWithText("hi"), styles);
    const text = textFragmentOf(tree);
    assert.equal(text.box.height, px(fontSize), `line height tracks font-size ${fontSize}`);
  }
});

void test("wrapped height scales with font-size (lineHeight = font-size per line)", () => {
  const content = Array.from({ length: 8 }, () => "abcd").join(" ");
  // font-size lives on the text node (node 2) that layoutInline measures.
  const small = styleTable(
    new Map([
      [1, makeStyle({ display: "block" })],
      [2, makeStyle({ fontSize: 16 })],
    ]),
  );
  const big = styleTable(
    new Map([
      [1, makeStyle({ display: "block" })],
      [2, makeStyle({ fontSize: 32 })],
    ]),
  );
  const view = { viewportWidth: px(160) };

  const smallText = textFragmentOf(layout(divWithText(content), small, view));
  const bigText = textFragmentOf(layout(divWithText(content), big, view));

  // Bigger font ⇒ wider glyphs ⇒ at least as many lines, and each line twice as
  // tall, so the total height grows.
  assert.ok(bigText.box.height > smallText.box.height);
  assert.equal(bigText.box.height % 32, 0, "big text height is a whole number of 32px lines");
  assert.equal(smallText.box.height % 16, 0, "small text height is a whole number of 16px lines");
});

// ---------------------------------------------------------------------------
// The shaper seam is actually used: a custom shaper changes width + break points.
// ---------------------------------------------------------------------------

void test("injecting a custom shaper changes the measured width (the seam is consulted)", () => {
  // A shaper with double the advance per glyph must double a single line's width.
  const wideShaper: TextShaper = {
    shapeLine(text: string, font: ShapingFont): ShapedRun {
      const perGlyph = font.fontSize * 1.0; // 2× the metrics placeholder's 0.5.
      const glyphs = Array.from({ length: text.length }, () => ({ advance: px(perGlyph) }));
      return { advance: px(text.length * perGlyph), glyphs };
    },
  };

  const dom = divWithText("hello");
  const def = textFragmentOf(layout(dom, BLOCK_STYLE));
  const wide = textFragmentOf(layout(dom, BLOCK_STYLE, { shaper: wideShaper }));

  assert.equal(def.box.width, px(5 * 0.5 * FONT_SIZE)); // 40px from the default.
  assert.equal(wide.box.width, px(5 * 1.0 * FONT_SIZE)); // 80px from the injection.
  assert.equal(wide.box.width, px(def.box.width * 2));
});

void test("injecting a custom shaper changes the break points (line count)", () => {
  // A zero-advance shaper makes every word free, so any run collapses to ONE
  // line regardless of width — proving line breaking reads the shaper's metrics.
  const zeroShaper: TextShaper = {
    shapeLine(_text: string, _font: ShapingFont): ShapedRun {
      return { advance: px(0), glyphs: [] };
    },
  };

  const content = Array.from({ length: 50 }, () => "word").join(" ");
  const view = { viewportWidth: px(50) };

  const wrapped = textFragmentOf(layout(divWithText(content), BLOCK_STYLE, view));
  const collapsed = textFragmentOf(layout(divWithText(content), BLOCK_STYLE, { ...view, shaper: zeroShaper }));

  assert.ok(wrapped.box.height > px(16), "the default shaper wraps this run to many lines");
  assert.equal(collapsed.box.height, px(16), "a zero-advance shaper packs everything on one line");
});

void test("the default shaper equals the metrics placeholder (re-exported from index)", () => {
  assert.equal(defaultShaper, metricsShaper);
  const run = defaultShaper.shapeLine("abc", { fontSize: px(16) });
  assert.equal(run.advance, px(3 * METRICS_ADVANCE_RATIO * 16));
  assert.equal(run.glyphs.length, 3);
});

// ---------------------------------------------------------------------------
// Block-flow y stays monotonic with wrapped inline content (task 3.7 invariant).
// ---------------------------------------------------------------------------

void test("wrapped text keeps the block-flow y-monotonic invariant among siblings", () => {
  // document → div → [ block a(h=10), text(wrapping), block c(h=20) ].
  const longText = Array.from({ length: 12 }, () => "abcde").join(" ");
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3, 4] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [] },
    { id: 3, kind: "text", text: longText, parent: 1, children: [] },
    { id: 4, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ display: "block" })],
      [2, makeStyle({ display: "block", height: 10 })],
      [4, makeStyle({ display: "block", height: 20 })],
    ]),
  );

  const tree = layout(dom, styles, { viewportWidth: px(140) });
  const div = tree.fragments.get(tree.fragments.get(tree.root)!.children[0]!)!;
  const kids = div.children.map((id) => tree.fragments.get(id)!);
  assert.equal(kids.length, 3);

  // The middle child is the wrapped text and is multiple lines tall.
  const textKid = kids[1]!;
  assert.ok(textKid.box.marginBox.height > px(16), "text wrapped to multiple lines");

  // Each child starts exactly at the previous child's margin-box bottom, so y is
  // monotonically non-decreasing through the wrapped run (design §8.2 invariant).
  for (let i = 1; i < kids.length; i += 1) {
    const prev = kids[i - 1]!.box.marginBox;
    const cur = kids[i]!.box.marginBox;
    assert.ok(cur.y >= prev.y, "block-flow y must be monotonically non-decreasing");
    assert.equal(cur.y, px(prev.y + prev.height));
  }
  // The container's content height is the sum of the children's margin boxes.
  const sum = kids.reduce((acc, k) => acc + k.box.marginBox.height, 0);
  assert.equal(div.box.height, px(sum));
});

// ---------------------------------------------------------------------------
// Output is frozen + deterministic with the new inline path.
// ---------------------------------------------------------------------------

void test("inline layout output is deep-frozen and deterministic (Req 3.2 / 2.7)", () => {
  const content = Array.from({ length: 15 }, () => "abcde").join(" ");
  const dom = divWithText(content);
  const view = { viewportWidth: px(180) };

  const a = layout(dom, BLOCK_STYLE, view);
  const b = layout(dom, BLOCK_STYLE, view);

  assert.ok(Object.isFrozen(a));
  assert.ok(Object.isFrozen(a.fragments));
  for (const frag of a.fragments.values()) {
    assert.ok(Object.isFrozen(frag));
    assert.ok(Object.isFrozen(frag.box));
  }
  // Same inputs ⇒ structurally equal trees (the wrapped geometry is stable).
  assert.equal(a.fragments.size, b.fragments.size);
  for (const [id, fragA] of a.fragments) {
    assert.deepEqual(fragA, b.fragments.get(id));
  }
});
