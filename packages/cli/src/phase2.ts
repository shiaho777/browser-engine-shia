/**
 * Phase 2-4 ("逼近 A 档") WPT subset, configured target threshold, and the
 * forward-only pass-count baseline (task 5.12).
 *
 * design.md §5 ("Phase 2-4 — 逼近 A 档") success criteria:
 *   "选定 WPT 子集(html-parsing + css-cascade + css-layout 块/行内)通过率
 *    ≥ 目标值;选择器匹配复杂度可证明为亚平方(索引生效)。"
 *
 * and §9.1 (WPT 记分牌纪律): "每个 Phase 锁定一组 Web Platform Tests,CI 每次
 * 提交跑;通过率即 compat 分子。CI 禁止合并使通过率下降的 PR。"
 *
 * This module turns those into concrete, committed artifacts the constitution
 * check gate (`./checks.ts`) runs on every commit:
 *
 *   1. The Phase 2-4 WPT SUBSET ({@link PHASE2_WPT_SUBSET}, Requirement 15.5) —
 *      a meaningful set of real checks across the THREE configured groups, each
 *      driving the ACTUAL stage code (no mocks) and asserting real observable
 *      behaviour, exactly as `PHASE1_WPT_SUBSET` is written:
 *        - **html-parsing** — the full HTML5 tree construction (task 5.1):
 *          nesting, optional-tag auto-closing (`<p>`/`<li>`), error recovery and
 *          the recovery metric, attributes, void / raw-text elements, and the
 *          parse→print→parse round trip — via `parseHtml`/`parseHtmlWithMetrics`
 *          and `serializeDom`/`domTreesEquivalent`.
 *        - **css-cascade** — the cascade + indexed selector matching (tasks 5.3,
 *          3.4): type / class / id / descendant / child combinators and the
 *          supported structural pseudo-classes, specificity, `!important`,
 *          inheritance, and initial values — via `parseCss` + `cascade` (which
 *          routes matching SOLELY through the `RuleIndex`).
 *        - **css-layout (block + inline)** — block stacking (the y-monotonic
 *          invariant), width / height / margin resolution, and inline text
 *          wrapping / line breaking through the shaping seam (task 5.7) — via
 *          `layout` (+ the injected `TextShaper`).
 *
 *   2. The configured Phase TARGET threshold ({@link PHASE2_TARGET_PASS_RATE},
 *      Requirement 15.5). design.md §3.2 / §14 note that "各 Phase 的通过率目标
 *      百分比" are *configurable* open values; this module expresses the target
 *      as a single named constant so the number lives in one place. Every check
 *      here is authored to match the engine's REAL behaviour, so the engine
 *      genuinely passes the whole subset and the configured target is `1.0` of
 *      the configured subset.
 *
 *   3. The forward-only pass-count BASELINE ({@link PHASE2_WPT_BASELINE},
 *      Requirement 10.2). The North Star discipline is forward-only
 *      compatibility: the measured pass count may stay flat or grow but never
 *      regress below the stored baseline. The check gate compares the live pass
 *      count against this baseline through `checkWptRegression` and blocks a
 *      commit that lowers it (`./checks.ts`).
 *
 * The cli is an orchestration layer (not a pipeline stage), so it may legally
 * import the stage packages and the scoreboard to compose them here.
 */
import { px } from "@browser-engine/ir";
import type { DomNode, DomTree, Fragment, FragmentTree, NodeId } from "@browser-engine/ir";
import { domTreesEquivalent, parseHtml, parseHtmlWithMetrics, serializeDom } from "@browser-engine/html-parser";
import { parseCss } from "@browser-engine/css-parser";
import { cascade } from "@browser-engine/cascade";
import { layout } from "@browser-engine/layout";
import { documentStylesheets } from "./stylesheets.js";
import {
  computeScoreboard,
  runWptSubset,
  type ReftestEvidence,
  type Scoreboard,
  type SourceFileInput,
  type WptRunSummary,
  type WptSubset,
} from "@browser-engine/scoreboard";

// ===========================================================================
// Small test helpers (mirror the PHASE1_WPT_SUBSET style in ./phase1.ts).
// ===========================================================================

/** Encode a source string as the UTF-8 bytes the parsers consume. */
function encode(source: string): Uint8Array {
  return new TextEncoder().encode(source);
}

/** Throw a plain assertion failure (counted as a WPT `fail` by the runner). */
function expect(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

/** The first element node of a parsed document. */
function firstElementId(dom: DomTree): NodeId {
  for (const [id, node] of dom.nodes) {
    if (node.kind === "element") {
      return id;
    }
  }
  throw new Error("expected at least one element node in the parsed DOM");
}

/** The first text node of a parsed document (used for inline-layout checks). */
function firstTextId(dom: DomTree): NodeId {
  for (const [id, node] of dom.nodes) {
    if (node.kind === "text") {
      return id;
    }
  }
  throw new Error("expected a text node in the parsed DOM");
}

/** All element nodes with the given (lowercased) tag, in document order. */
function elementsByTag(dom: DomTree, tag: string): DomNode[] {
  const out: DomNode[] = [];
  for (const node of dom.nodes.values()) {
    if (node.kind === "element" && node.tag === tag) {
      out.push(node);
    }
  }
  return out;
}

/** The single element node with the given tag (asserts exactly one exists). */
function elementByTag(dom: DomTree, tag: string): DomNode {
  const matches = elementsByTag(dom, tag);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one <${tag}>, found ${matches.length}`);
  }
  return matches[0] as DomNode;
}

/** The fragment laid out for a given DOM node. */
function fragmentForNode(tree: FragmentTree, node: NodeId): Fragment {
  for (const fragment of tree.fragments.values()) {
    if (fragment.node === node) {
      return fragment;
    }
  }
  throw new Error(`expected a fragment for node ${String(node)}`);
}

/** Exact equality of a computed `Color` against r/g/b/a channel values. */
function colorIs(value: unknown, r: number, g: number, b: number, a: number): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const c = value as Record<string, unknown>;
  return c["r"] === r && c["g"] === g && c["b"] === b && c["a"] === a;
}

// ===========================================================================
// 1. The configured Phase 2-4 capabilities, grouped (Requirement 15.5).
// ===========================================================================

/**
 * The three configured Phase 2-4 WPT groups (design.md §5 success criteria) and
 * the web-facing capabilities each one tracks. The scoreboard reports a status
 * for every capability; one with a passing check in the subset is "implemented"
 * (Requirement 1.4).
 */
export const PHASE2_GROUPS = {
  "html-parsing": [
    "html-tree-construction",
    "html-optional-tags",
    "html-error-recovery",
    "html-attributes",
    "html-void-elements",
    "html-raw-text",
    "html-roundtrip",
  ],
  "css-cascade": [
    "css-selector-type",
    "css-selector-class",
    "css-selector-id",
    "css-selector-descendant",
    "css-selector-child",
    "css-pseudo-class",
    "css-specificity",
    "css-important",
    "css-inheritance",
    "css-initial-values",
  ],
  "css-layout": [
    "layout-block-stacking",
    "layout-width-height",
    "layout-margin",
    "layout-inline-wrapping",
  ],
} as const satisfies Record<string, readonly string[]>;

/** The configured Phase 2-4 group names (the three success-criteria groups). */
export const PHASE2_GROUP_NAMES = Object.keys(PHASE2_GROUPS) as readonly (keyof typeof PHASE2_GROUPS)[];

/** Every Phase 2-4 capability the scoreboard tracks, across the three groups. */
export const PHASE2_CAPABILITIES: readonly string[] = PHASE2_GROUP_NAMES.flatMap(
  (group) => PHASE2_GROUPS[group],
);

// ===========================================================================
// 2. The Phase 2-4 WPT subset (Requirement 15.5).
//
// Each test drives the ACTUAL stage code — parse, cascade (via the RuleIndex),
// layout (+ the text shaper) — and asserts real, observable behaviour (no
// mocks). A test passes when its `run` completes without throwing.
// ===========================================================================

/** html-parsing group: drives the full HTML5 tree construction (task 5.1). */
const HTML_PARSING_TESTS: WptSubset = [
  {
    id: "phase2/html-parsing/nesting.html",
    capability: "html-tree-construction",
    run: () => {
      // document → div → span → text "a": nested element construction.
      const dom = parseHtml(encode("<div><span>a</span></div>"));
      const div = elementByTag(dom, "div");
      expect(div.children.length === 1, `<div> child count: ${div.children.length}`);
      const span = dom.nodes.get(div.children[0] as NodeId);
      expect(span?.kind === "element" && span.tag === "span", "expected a <span> child of <div>");
      const text = dom.nodes.get((span?.children[0] ?? -1) as NodeId);
      expect(text?.kind === "text" && text.text === "a", `expected text "a", got ${String(text?.text)}`);
    },
  },
  {
    id: "phase2/html-parsing/optional-tag-paragraph.html",
    capability: "html-optional-tags",
    run: () => {
      // A second <p> auto-closes the first (optional end tag): two siblings.
      const dom = parseHtml(encode("<p>one<p>two"));
      const paragraphs = elementsByTag(dom, "p");
      expect(paragraphs.length === 2, `expected two <p> elements, got ${paragraphs.length}`);
      const first = dom.nodes.get(paragraphs[0]?.children[0] as NodeId);
      const second = dom.nodes.get(paragraphs[1]?.children[0] as NodeId);
      expect(first?.text === "one" && second?.text === "two", "each <p> keeps its own text run");
    },
  },
  {
    id: "phase2/html-parsing/optional-tag-list-item.html",
    capability: "html-optional-tags",
    run: () => {
      // <li> auto-closes a previous open <li>; </ul> closes the last one.
      const dom = parseHtml(encode("<ul><li>a<li>b</ul>"));
      const ul = elementByTag(dom, "ul");
      const items = ul.children
        .map((id) => dom.nodes.get(id))
        .filter((n) => n?.kind === "element" && n.tag === "li");
      expect(items.length === 2, `expected two <li> children of <ul>, got ${items.length}`);
    },
  },
  {
    id: "phase2/html-parsing/error-recovery-stray-end-tag.html",
    capability: "html-error-recovery",
    run: () => {
      // A stray </span> with no open <span> is dropped and recorded (Req 13.1).
      const { tree, recoveries } = parseHtmlWithMetrics(encode("<div></span></div>"));
      expect(
        recoveries.some((r) => r.kind === "stray-end-tag"),
        "a stray end tag must be recorded as a recovery",
      );
      expect(elementsByTag(tree, "div").length === 1, "the <div> still parses after recovery");
    },
  },
  {
    id: "phase2/html-parsing/recovery-metric.html",
    capability: "html-error-recovery",
    run: () => {
      // A mismatched end tag force-closes intervening elements AND records the
      // recovery metric (Requirement 13.2: a recovery is counted).
      const { recoveries } = parseHtmlWithMetrics(encode("<b><i></b>"));
      expect(recoveries.length > 0, "malformed input must record at least one recovery metric");
      expect(
        recoveries.some((r) => r.kind === "mismatched-end-tag"),
        "a mismatched end tag must be recorded as a recovery",
      );
    },
  },
  {
    id: "phase2/html-parsing/attributes.html",
    capability: "html-attributes",
    run: () => {
      // Attribute names lowercased; values preserved on the element.
      const dom = parseHtml(encode('<div id="main" class="box"></div>'));
      const div = elementByTag(dom, "div");
      expect(div.attrs?.get("id") === "main", `id attribute: ${String(div.attrs?.get("id"))}`);
      expect(div.attrs?.get("class") === "box", `class attribute: ${String(div.attrs?.get("class"))}`);
    },
  },
  {
    id: "phase2/html-parsing/void-elements.html",
    capability: "html-void-elements",
    run: () => {
      // Void elements (<br>, <img>) are childless siblings, never nested.
      const dom = parseHtml(encode('<div><br><img src="x"></div>'));
      const div = elementByTag(dom, "div");
      const children = div.children.map((id) => dom.nodes.get(id));
      expect(children.length === 2, `<div> should hold two void children, got ${children.length}`);
      expect(children[0]?.tag === "br" && children[0]?.children.length === 0, "<br> is a childless void element");
      expect(children[1]?.tag === "img" && children[1]?.children.length === 0, "<img> is a childless void element");
      expect(children[1]?.attrs?.get("src") === "x", "<img> keeps its src attribute");
    },
  },
  {
    id: "phase2/html-parsing/raw-text-element.html",
    capability: "html-raw-text",
    run: () => {
      // <style> content is raw text: kept verbatim, not parsed as markup.
      const dom = parseHtml(encode("<style>.a{color:red}</style>"));
      const style = elementByTag(dom, "style");
      expect(style.children.length === 1, `<style> child count: ${style.children.length}`);
      const text = dom.nodes.get(style.children[0] as NodeId);
      expect(
        text?.kind === "text" && text.text === ".a{color:red}",
        `raw-text content: ${String(text?.text)}`,
      );
    },
  },
  {
    id: "phase2/html-parsing/round-trip.html",
    capability: "html-roundtrip",
    run: () => {
      // parse → print → parse reproduces a structurally equivalent DomTree
      // (Requirement 18.4), driving the Pretty_Printer + equality oracle.
      const dom = parseHtml(encode('<div id="x"><span>hi</span><br></div>'));
      const reparsed = parseHtml(encode(serializeDom(dom)));
      expect(domTreesEquivalent(dom, reparsed), "serialized DOM must re-parse to an equivalent tree");
    },
  },
];

/** css-cascade group: drives cascade + indexed selector matching (tasks 5.3, 3.4). */
const CSS_CASCADE_TESTS: WptSubset = [
  {
    id: "phase2/css-cascade/type-selector.html",
    capability: "css-selector-type",
    run: () => {
      const dom = parseHtml(encode("<div></div>"));
      const sheets = [parseCss(encode("div { color: blue }"))];
      const style = cascade(dom, sheets, firstElementId(dom));
      expect(colorIs(style.color, 0, 0, 255, 1), `type selector did not apply blue: ${JSON.stringify(style.color)}`);
    },
  },
  {
    id: "phase2/css-cascade/class-selector.html",
    capability: "css-selector-class",
    run: () => {
      const dom = parseHtml(encode('<div class="box"></div>'));
      const sheets = [parseCss(encode(".box { color: red }"))];
      const style = cascade(dom, sheets, firstElementId(dom));
      expect(colorIs(style.color, 255, 0, 0, 1), `class selector did not apply red: ${JSON.stringify(style.color)}`);
    },
  },
  {
    id: "phase2/css-cascade/id-selector.html",
    capability: "css-selector-id",
    run: () => {
      const dom = parseHtml(encode('<div id="main"></div>'));
      const sheets = [parseCss(encode("#main { color: green }"))];
      const style = cascade(dom, sheets, firstElementId(dom));
      expect(colorIs(style.color, 0, 128, 0, 1), `id selector did not apply green: ${JSON.stringify(style.color)}`);
    },
  },
  {
    id: "phase2/css-cascade/descendant-combinator.html",
    capability: "css-selector-descendant",
    run: () => {
      // `div span` matches a span anywhere under a div, but NOT the div itself.
      const dom = parseHtml(encode("<div><span></span></div>"));
      const sheets = [parseCss(encode("div span { color: red }"))];
      const span = elementByTag(dom, "span");
      const div = elementByTag(dom, "div");
      expect(colorIs(cascade(dom, sheets, span.id).color, 255, 0, 0, 1), "descendant selector should match the span");
      // The div is not a descendant of a div, so it keeps the initial color.
      expect(colorIs(cascade(dom, sheets, div.id).color, 0, 0, 0, 1), "descendant selector must not match the div");
    },
  },
  {
    id: "phase2/css-cascade/child-combinator.html",
    capability: "css-selector-child",
    run: () => {
      const sheet = "div > span { color: red }";
      // Direct child matches.
      const direct = parseHtml(encode("<div><span></span></div>"));
      const directSpan = elementByTag(direct, "span");
      expect(
        colorIs(cascade(direct, [parseCss(encode(sheet))], directSpan.id).color, 255, 0, 0, 1),
        "child combinator should match a direct child span",
      );
      // A grandchild span does NOT match `div > span`.
      const nested = parseHtml(encode("<div><p><span></span></p></div>"));
      const nestedSpan = elementByTag(nested, "span");
      expect(
        colorIs(cascade(nested, [parseCss(encode(sheet))], nestedSpan.id).color, 0, 0, 0, 1),
        "child combinator must not match a grandchild span",
      );
    },
  },
  {
    id: "phase2/css-cascade/pseudo-class-first-child.html",
    capability: "css-pseudo-class",
    run: () => {
      // `li:first-child` matches only the first element child of its parent.
      const dom = parseHtml(encode("<ul><li>a</li><li>b</li></ul>"));
      const sheets = [parseCss(encode("li:first-child { color: red }"))];
      const items = elementsByTag(dom, "li");
      expect(items.length === 2, `expected two <li>, got ${items.length}`);
      expect(colorIs(cascade(dom, sheets, items[0]!.id).color, 255, 0, 0, 1), "first <li> matches :first-child");
      expect(colorIs(cascade(dom, sheets, items[1]!.id).color, 0, 0, 0, 1), "second <li> does not match :first-child");
    },
  },
  {
    id: "phase2/css-cascade/specificity.html",
    capability: "css-specificity",
    run: () => {
      // #main ([1,0,0]) beats div ([0,0,1]) regardless of source order.
      const dom = parseHtml(encode('<div id="main"></div>'));
      const sheets = [parseCss(encode("div { color: red } #main { color: green }"))];
      const style = cascade(dom, sheets, firstElementId(dom));
      expect(colorIs(style.color, 0, 128, 0, 1), `higher specificity (#main) must win: ${JSON.stringify(style.color)}`);
    },
  },
  {
    id: "phase2/css-cascade/important.html",
    capability: "css-important",
    run: () => {
      // An earlier `!important` declaration beats a later normal one.
      const dom = parseHtml(encode("<div></div>"));
      const sheets = [parseCss(encode("div { color: red !important } div { color: green }"))];
      const style = cascade(dom, sheets, firstElementId(dom));
      expect(colorIs(style.color, 255, 0, 0, 1), `!important must win over a later normal rule: ${JSON.stringify(style.color)}`);
    },
  },
  {
    id: "phase2/css-cascade/inheritance.html",
    capability: "css-inheritance",
    run: () => {
      // `color` is inherited: a span with no rule takes its parent div's color.
      const dom = parseHtml(encode("<div><span></span></div>"));
      const sheets = [parseCss(encode("div { color: red }"))];
      const span = elementByTag(dom, "span");
      expect(colorIs(cascade(dom, sheets, span.id).color, 255, 0, 0, 1), "color must inherit to the child span");
    },
  },
  {
    id: "phase2/css-cascade/initial-values.html",
    capability: "css-initial-values",
    run: () => {
      // With no matching rule every property resolves to its initial value.
      const dom = parseHtml(encode("<div></div>"));
      const style = cascade(dom, [], firstElementId(dom));
      expect(colorIs(style.color, 0, 0, 0, 1), `initial color must be black: ${JSON.stringify(style.color)}`);
      expect(style.display === "inline", `initial display must be inline: ${style.display}`);
      expect(colorIs(style["backgroundColor"], 0, 0, 0, 0), "initial background-color must be transparent");
      expect(style.fontSize === 16, `initial font-size must be 16: ${style.fontSize}`);
      const margin = style.margin;
      expect(
        margin.top === 0 && margin.right === 0 && margin.bottom === 0 && margin.left === 0,
        "initial margin must be zero on every edge",
      );
    },
  },
];

/** css-layout group: drives block + inline layout (tasks 3.7, 5.7). */
const CSS_LAYOUT_TESTS: WptSubset = [
  {
    id: "phase2/css-layout/block-stacking.html",
    capability: "layout-block-stacking",
    run: () => {
      // Block children stack top-to-bottom: y is monotonic and the next child's
      // y equals the running sum of prior margin-box heights (design.md §8.2).
      const dom = parseHtml(encode('<div><div class="a"></div><div class="b"></div></div>'));
      const sheets = [parseCss(encode(".a { height: 30px } .b { height: 40px }"))];
      const tree = layout(dom, (node) => cascade(dom, sheets, node));
      const divs = elementsByTag(dom, "div"); // [outer, a, b] in document order.
      const fragA = fragmentForNode(tree, divs[1]!.id);
      const fragB = fragmentForNode(tree, divs[2]!.id);
      expect(fragA.box.borderBox.y === 0, `first child y: ${fragA.box.borderBox.y}`);
      expect(fragA.box.marginBox.height === 30, `first child height: ${fragA.box.marginBox.height}`);
      expect(fragB.box.borderBox.y >= fragA.box.borderBox.y, "child y must be monotonically non-decreasing");
      expect(
        fragB.box.borderBox.y === fragA.box.borderBox.y + fragA.box.marginBox.height,
        `second child y (${fragB.box.borderBox.y}) must follow the first child's margin box`,
      );
    },
  },
  {
    id: "phase2/css-layout/width-height-resolution.html",
    capability: "layout-width-height",
    run: () => {
      const dom = parseHtml(encode("<div></div>"));
      const sheets = [parseCss(encode("div { width: 120px; height: 60px }"))];
      const tree = layout(dom, (node) => cascade(dom, sheets, node));
      const frag = fragmentForNode(tree, firstElementId(dom));
      expect(frag.box.borderBox.width === 120, `width did not resolve to 120px: ${frag.box.borderBox.width}`);
      expect(frag.box.borderBox.height === 60, `height did not resolve to 60px: ${frag.box.borderBox.height}`);
    },
  },
  {
    id: "phase2/css-layout/width-auto-fills.html",
    capability: "layout-width-height",
    run: () => {
      // `width:auto` fills the containing block (the configured viewport width).
      const dom = parseHtml(encode("<div></div>"));
      const tree = layout(dom, (node) => cascade(dom, [], node), { viewportWidth: px(640) });
      const frag = fragmentForNode(tree, firstElementId(dom));
      expect(frag.box.borderBox.width === 640, `auto width must fill the 640px viewport: ${frag.box.borderBox.width}`);
    },
  },
  {
    id: "phase2/css-layout/margin-resolution.html",
    capability: "layout-margin",
    run: () => {
      const dom = parseHtml(encode("<div></div>"));
      const sheets = [parseCss(encode("div { width: 100px; height: 10px; margin: 5px }"))];
      const tree = layout(dom, (node) => cascade(dom, sheets, node));
      const frag = fragmentForNode(tree, firstElementId(dom));
      expect(frag.box.marginBox.width === 110, `margin box width: ${frag.box.marginBox.width}`);
      expect(frag.box.marginBox.height === 20, `margin box height: ${frag.box.marginBox.height}`);
      expect(frag.box.borderBox.x === 5, `border box offset by left margin: ${frag.box.borderBox.x}`);
    },
  },
  {
    id: "phase2/css-layout/inline-line-breaking.html",
    capability: "layout-inline-wrapping",
    run: () => {
      // Inline text wraps when it overflows the containing inline width: three
      // 4-char words at width 40 (per-glyph advance 8px, default font-size 16)
      // wrap to three lines, so the text box is 3 × 16 = 48px tall. The cascade
      // includes the UA sheet — the same list the live pipeline feeds — so the
      // bare `<div>` is a block box and the text run wraps inside it.
      const dom = parseHtml(encode("<div>aaaa bbbb cccc</div>"));
      const tree = layout(dom, (node) => cascade(dom, documentStylesheets(dom), node), { viewportWidth: px(40) });
      const textFrag = fragmentForNode(tree, firstTextId(dom));
      expect(textFrag.box.borderBox.height === 48, `wrapped text height (3 lines): ${textFrag.box.borderBox.height}`);
    },
  },
  {
    id: "phase2/css-layout/inline-single-line.html",
    capability: "layout-inline-wrapping",
    run: () => {
      // A short run that fits stays on one line: the box is one line tall (16px).
      const dom = parseHtml(encode("<div>hi</div>"));
      const tree = layout(dom, (node) => cascade(dom, [], node));
      const textFrag = fragmentForNode(tree, firstTextId(dom));
      expect(textFrag.box.borderBox.height === 16, `single-line text height: ${textFrag.box.borderBox.height}`);
    },
  },
];

/**
 * The configured Phase 2-4 WPT subset (Requirement 15.5): html-parsing +
 * css-cascade + css-layout (block & inline), every check driving the real stage
 * code. Concatenated in group order so the subset reads top-to-bottom by group.
 */
export const PHASE2_WPT_SUBSET: WptSubset = [
  ...HTML_PARSING_TESTS,
  ...CSS_CASCADE_TESTS,
  ...CSS_LAYOUT_TESTS,
];

// ===========================================================================
// 3. The configured target threshold + forward-only baseline.
// ===========================================================================

/**
 * The configured Phase 2-4 target pass RATE (Requirement 15.5; design.md §3.2 /
 * §14 — thresholds are configurable). Every check in {@link PHASE2_WPT_SUBSET}
 * is authored to match the engine's real behaviour, so the engine passes the
 * whole configured subset and the target is `1.0` (100% of the configured
 * subset). Lower this single value to relax the target, or raise the subset to
 * tighten it — the threshold lives in exactly one place.
 */
export const PHASE2_TARGET_PASS_RATE = 1.0;

/**
 * The forward-only WPT pass-count BASELINE the regression gate compares against
 * (Requirement 10.2). It is the known-good number of passing Phase 2-4 checks;
 * the gate (`./checks.ts`) blocks any commit whose live pass count drops below
 * it. Per the North Star discipline this number may only ever be RAISED (when
 * new passing checks are added), never lowered. It is pinned to the current
 * subset size because every authored check passes.
 */
export const PHASE2_WPT_BASELINE = PHASE2_WPT_SUBSET.length;

// ===========================================================================
// 4. Running the subset + the Phase 2-4 scoreboard.
// ===========================================================================

/** Run the configured Phase 2-4 WPT subset and return the pass/fail summary. */
export function runPhase2WptSubset(): WptRunSummary {
  return runWptSubset(PHASE2_WPT_SUBSET);
}

/**
 * The live Phase 2-4 WPT pass rate (passing / total) for the configured subset.
 * An empty subset yields `1` (vacuously meets any target), but the configured
 * subset is non-empty, so this is the real measured rate.
 */
export function phase2PassRate(summary: WptRunSummary = runPhase2WptSubset()): number {
  return summary.total === 0 ? 1 : summary.passCount / summary.total;
}

/** Optional inputs for {@link computePhase2Scoreboard}. */
export interface Phase2ScoreboardOptions {
  /** Reftest evidence feeding capability status (independent of the pass count). */
  readonly reftests?: readonly ReftestEvidence[];
  /** Source files for the compat-per-LOC denominator (optional). */
  readonly sourceFiles?: Iterable<SourceFileInput>;
}

/**
 * Compute the Phase 2-4 scoreboard snapshot from the configured subset
 * (Requirement 15.5) so compat-per-LOC and per-capability reporting reflect the
 * three Phase 2-4 groups + their capabilities. Pure and side-effect free; the
 * held pass count is independent of whether the display publishes (Req 1.6).
 */
export function computePhase2Scoreboard(options: Phase2ScoreboardOptions = {}): Scoreboard {
  return computeScoreboard({
    wptSubset: PHASE2_WPT_SUBSET,
    sourceFiles: options.sourceFiles ?? [],
    capabilities: PHASE2_CAPABILITIES,
    reftests: options.reftests ?? [],
  });
}
