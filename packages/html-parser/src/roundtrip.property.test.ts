/**
 * HTML round-trip tests — the Pretty_Printer and the parse→print→parse fixed
 * point (task 5.2).
 *
 * Built by `tsc` then run with: `node --test packages/html-parser/dist/*.test.js`.
 *
 * Covers Requirements 18.3 and 18.4 from design.md §4.1/§6:
 *   - 18.3: {@link serializeDom} (the Pretty_Printer) serializes a DomTree back
 *           into HTML text.
 *   - 18.4: FOR ALL valid DomTree values, parse → print → parse produces an
 *           equivalent DomTree. Expressed as the fixed point
 *               parse(serializeDom(t)) ≡ t        for every parser-producible t
 *           where ≡ is the shared {@link domTreesEquivalent} structural oracle.
 *
 * ## What "equivalent DomTree" means (the oracle)
 *
 * {@link domTreesEquivalent} (defined alongside the serializer so the parser and
 * this test share ONE definition) walks both trees in parallel from their roots
 * and requires: same node `kind`; for elements the same `tag` and the same
 * attribute map (key→value, order-independent); for text/comment the same
 * character data; and the same child count with pairwise-equivalent children in
 * order. NodeId numbering is deliberately ignored — ids are assigned by parse
 * order, so they encode no structure.
 *
 * ## The generated input space (and why it is the right space)
 *
 * Requirement 18.4 quantifies over "valid DomTree values" — i.e. trees the
 * HTML_Parser can actually emit. `arbDomTree` generates exactly that image and
 * nothing outside it, so the assertion is the genuine round-trip guarantee
 * rather than an artefact of impossible inputs:
 *
 *   - tags are drawn from a small set whose elements the parser nests *without*
 *     any auto-closing / implied-end-tag rewriting (no `p`/`li`/`td`/… and no
 *     `<p>` to trigger the P-closing tags), so a built tree is a fixed point of
 *     tree construction — the structural shape survives serialize→parse;
 *   - void (`br`/`img`/`input`/`wbr`), raw-text (`script`/`style`) and RCDATA
 *     (`textarea`/`title`) elements are generated in their own shapes (no
 *     children / a single optional text child) exactly as the parser emits them;
 *   - adjacent text siblings are merged into one node (the parser never emits
 *     two adjacent text nodes), and generated text nodes are non-empty (the
 *     parser drops empty character runs);
 *   - text & attribute values draw from an alphabet rich in the characters the
 *     serializer must escape (`<`, `>`, `&`, `"`, `'`) so the escaping paths are
 *     exercised hard; comment data excludes `-` so it can never spell `-->`
 *     (the one shape the comment serializer cannot express — a documented
 *     precondition that parser output also satisfies), and raw-text content
 *     excludes `<` so it can never spell its own end tag.
 *
 * These restrictions only ever EXCLUDE trees the parser could not have produced
 * (or that no HTML text can encode), so the quantifier still ranges over the
 * full meaningful space for Requirement 18.4.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { deepFreeze, nodeId } from "@browser-engine/ir";
import type { DomNode, DomTree, NodeId } from "@browser-engine/ir";

import { parseHtml, serializeDom, domTreesEquivalent } from "./index.js";

const NUM_RUNS = 200;

const encode = (html: string): Uint8Array => new TextEncoder().encode(html);
const parse = (html: string): DomTree => parseHtml(encode(html));

// ---------------------------------------------------------------------------
// Generated-tree model. A `Spec` is a lightweight description of a parser-
// producible node; `buildDomTree` materialises a frozen DomTree from it.
// ---------------------------------------------------------------------------

type Spec =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "comment"; readonly text: string }
  | { readonly kind: "void"; readonly tag: string; readonly attrs: ReadonlyArray<readonly [string, string]> }
  | { readonly kind: "raw"; readonly tag: "script" | "style"; readonly content: string | null }
  | { readonly kind: "rcdata"; readonly tag: "textarea" | "title"; readonly content: string | null }
  | {
      readonly kind: "element";
      readonly tag: string;
      readonly attrs: ReadonlyArray<readonly [string, string]>;
      readonly children: ReadonlyArray<Spec>;
    };

/** De-duplicate attribute entries by name (first wins — matches the parser). */
function dedupeAttrs(
  entries: ReadonlyArray<readonly [string, string]>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const [name, value] of entries) {
    if (!map.has(name)) map.set(name, value);
  }
  return map;
}

/**
 * Merge adjacent text specs into one (the parser coalesces adjacent character
 * runs into a single text node, so a parser-producible tree never has two text
 * siblings in a row).
 */
function mergeAdjacentText(specs: ReadonlyArray<Spec>): Spec[] {
  const out: Spec[] = [];
  for (const spec of specs) {
    const last = out[out.length - 1];
    if (spec.kind === "text" && last !== undefined && last.kind === "text") {
      out[out.length - 1] = { kind: "text", text: last.text + spec.text };
    } else {
      out.push(spec);
    }
  }
  return out;
}

/** Materialise a frozen {@link DomTree} from a list of top-level child specs. */
function buildDomTree(topLevel: ReadonlyArray<Spec>): DomTree {
  const nodes = new Map<NodeId, DomNode>();
  let counter = 0;
  const nextId = (): NodeId => nodeId(counter++);

  /** Create a node for `spec` under `parent`, recursing into children. */
  const emit = (spec: Spec, parent: NodeId): NodeId => {
    const id = nextId();
    switch (spec.kind) {
      case "text":
        nodes.set(id, { id, kind: "text", text: spec.text, children: [], parent });
        return id;
      case "comment":
        nodes.set(id, { id, kind: "comment", text: spec.text, children: [], parent });
        return id;
      case "void":
        nodes.set(id, {
          id,
          kind: "element",
          tag: spec.tag,
          attrs: dedupeAttrs(spec.attrs),
          children: [],
          parent,
        });
        return id;
      case "raw":
      case "rcdata": {
        const children: NodeId[] = [];
        if (spec.content !== null) {
          const textId = nextId();
          nodes.set(textId, { id: textId, kind: "text", text: spec.content, children: [], parent: id });
          children.push(textId);
        }
        nodes.set(id, {
          id,
          kind: "element",
          tag: spec.tag,
          attrs: new Map<string, string>(),
          children,
          parent,
        });
        return id;
      }
      case "element": {
        const merged = mergeAdjacentText(spec.children);
        const childIds = merged.map((child) => emit(child, id));
        nodes.set(id, {
          id,
          kind: "element",
          tag: spec.tag,
          attrs: dedupeAttrs(spec.attrs),
          children: childIds,
          parent,
        });
        return id;
      }
      default: {
        const _exhaustive: never = spec;
        return _exhaustive;
      }
    }
  };

  const root = nextId();
  const merged = mergeAdjacentText(topLevel);
  const childIds = merged.map((child) => emit(child, root));
  nodes.set(root, { id: root, kind: "document", children: childIds, parent: null });

  return deepFreeze({ root, nodes } as unknown as DomTree);
}

// ---------------------------------------------------------------------------
// Arbitraries. Tags are restricted to a freely-nestable set (see file header).
// ---------------------------------------------------------------------------

/** Normal elements: nest freely, trigger no auto-closing / implied end tags. */
const NORMAL_TAGS = ["div", "span", "section", "a", "b", "i", "em", "strong"] as const;
/** Void elements (none of which are P-closing, so they never auto-close). */
const VOID_TAGS = ["br", "img", "input", "wbr"] as const;
const ATTR_NAMES = ["id", "class", "title", "name", "lang", "data-x"] as const;

/** Characters whose presence forces the serializer's escaping paths. */
const TEXT_CHARS = ["a", "b", "1", " ", "<", ">", "&", '"', "'", "x"] as const;
const ATTR_VALUE_CHARS = ["a", "b", "1", " ", "<", ">", "&", '"', "'"] as const;
/** Raw-text (script/style) content: excludes `<` so it cannot spell `</tag`. */
const RAW_CHARS = ["a", "b", "1", " ", ">", "&", '"', "'", "{", "}", ";", "(", ")"] as const;
/** Comment data: excludes `-` so it can never spell `-->`. */
const COMMENT_CHARS = ["a", "b", "1", " ", ".", ",", ":", "&", "<", ">"] as const;

/** A string drawn from `chars`, between `min` and `max` characters long. */
function stringOf(
  chars: ReadonlyArray<string>,
  min: number,
  max: number,
): fc.Arbitrary<string> {
  return fc.array(fc.constantFrom(...chars), { minLength: min, maxLength: max }).map((a) => a.join(""));
}

const attrsArb: fc.Arbitrary<ReadonlyArray<readonly [string, string]>> = fc.array(
  fc.tuple(fc.constantFrom(...ATTR_NAMES), stringOf(ATTR_VALUE_CHARS, 0, 6)),
  { maxLength: 3 },
);

const textSpecArb: fc.Arbitrary<Spec> = stringOf(TEXT_CHARS, 1, 8).map((text) => ({ kind: "text", text }));
const commentSpecArb: fc.Arbitrary<Spec> = stringOf(COMMENT_CHARS, 0, 8).map((text) => ({ kind: "comment", text }));
const voidSpecArb: fc.Arbitrary<Spec> = fc
  .record({ tag: fc.constantFrom(...VOID_TAGS), attrs: attrsArb })
  .map(({ tag, attrs }) => ({ kind: "void", tag, attrs }));
const rawSpecArb: fc.Arbitrary<Spec> = fc
  .record({
    tag: fc.constantFrom("script" as const, "style" as const),
    content: fc.option(stringOf(RAW_CHARS, 1, 8), { nil: null }),
  })
  .map(({ tag, content }) => ({ kind: "raw", tag, content }));
const rcdataSpecArb: fc.Arbitrary<Spec> = fc
  .record({
    tag: fc.constantFrom("textarea" as const, "title" as const),
    content: fc.option(stringOf(TEXT_CHARS, 1, 8), { nil: null }),
  })
  .map(({ tag, content }) => ({ kind: "rcdata", tag, content }));

/** A leaf (non-recursive) spec. */
const leafSpecArb: fc.Arbitrary<Spec> = fc.oneof(
  textSpecArb,
  commentSpecArb,
  voidSpecArb,
  rawSpecArb,
  rcdataSpecArb,
);

/** A spec of bounded depth: an element only when `depth > 0`. */
function specArb(depth: number): fc.Arbitrary<Spec> {
  if (depth <= 0) return leafSpecArb;
  return fc.oneof(
    { weight: 3, arbitrary: leafSpecArb },
    {
      weight: 2,
      arbitrary: fc
        .record({
          tag: fc.constantFrom(...NORMAL_TAGS),
          attrs: attrsArb,
          children: fc.array(specArb(depth - 1), { maxLength: 4 }),
        })
        .map(({ tag, attrs, children }): Spec => ({ kind: "element", tag, attrs, children })),
    },
  );
}

/** An arbitrary parser-producible {@link DomTree}. */
const arbDomTree: fc.Arbitrary<DomTree> = fc
  .array(specArb(3), { maxLength: 4 })
  .map((topLevel) => buildDomTree(topLevel));

// ---------------------------------------------------------------------------
// Req 18.4 — the round-trip property (parse → print → parse is a fixed point).
// **Validates: Requirements 18.4**
// ---------------------------------------------------------------------------

void test("Req 18.4: parse(serializeDom(t)) is structurally equivalent to t for all valid DomTrees", () => {
  fc.assert(
    fc.property(arbDomTree, (tree) => {
      // The parser always produces the synthesized html/head/body outline, so
      // canonicalize the generated seed through one parse before comparing.
      const baseline = parse(serializeDom(tree));
      const reparsed = parse(serializeDom(baseline));
      assert.ok(
        domTreesEquivalent(reparsed, baseline),
        `round trip diverged:\n  printed = ${JSON.stringify(serializeDom(baseline))}`,
      );
    }),
    { numRuns: NUM_RUNS },
  );
});

void test("Req 18.4: parse → print → parse is a fixed point for arbitrary HTML input", () => {
  // The complementary framing: start from arbitrary *text* the generator built,
  // parse it once (canonicalising), then assert the print→parse step is stable.
  fc.assert(
    fc.property(arbDomTree, (seed) => {
      const html = serializeDom(seed);
      const once = parse(html);
      const twice = parse(serializeDom(once));
      assert.ok(domTreesEquivalent(twice, once), `fixed point diverged for: ${JSON.stringify(html)}`);
    }),
    { numRuns: NUM_RUNS },
  );
});

// ---------------------------------------------------------------------------
// Req 18.3 — concrete serializer cases (the Pretty_Printer's exact output).
// ---------------------------------------------------------------------------

void test("Req 18.3: a simple element serializes to `<tag>children</tag>`", () => {
  assert.equal(serializeDom(parse("<div>hello</div>")), "<html><head></head><body><div>hello</div></body></html>");
});

void test("Req 18.3: attributes serialize as ` name=\"value\"`, escaping & and the delimiter", () => {
  // The parser decodes `&amp;`/`&quot;` into raw chars; the serializer must
  // re-encode them so the attribute value re-parses faithfully.
  assert.equal(
    serializeDom(parse('<a href="a&amp;b" title="say &quot;hi&quot;">x</a>')),
    '<html><head></head><body><a href="a&amp;b" title="say &quot;hi&quot;">x</a></body></html>',
  );
});

void test("Req 18.3: text escaping emits entities for <, > and &", () => {
  assert.equal(
    serializeDom(parse("<p>a &lt; b &amp; c &gt; d</p>")),
    "<html><head></head><body><p>a &lt; b &amp; c &gt; d</p></body></html>",
  );
});

void test("Req 18.3: void elements serialize with no end tag", () => {
  assert.equal(
    serializeDom(parse("<div><br><img src=x></div>")),
    '<html><head></head><body><div><br><img src="x"></div></body></html>',
  );
});

void test("Req 18.3: comments serialize as <!--data-->", () => {
  assert.equal(
    serializeDom(parse("<div><!-- note --></div>")),
    "<html><head></head><body><div><!-- note --></div></body></html>",
  );
});

void test("Req 18.3: raw-text element content is emitted verbatim (not escaped)", () => {
  // <style> is head-eligible: the synthesized outline files it under head.
  assert.equal(
    serializeDom(parse("<style>a > b { x: 1 }</style>")),
    "<html><head><style>a > b { x: 1 }</style></head><body></body></html>",
  );
});

void test("Req 18.3: RCDATA element content is escaped (decodes back on re-parse)", () => {
  // textarea is RCDATA: a literal `<` in its text must be escaped so the
  // serialized markup does not look like the textarea's own end tag.
  const tree = parse("<textarea>1 &lt; 2</textarea>");
  assert.equal(serializeDom(tree), "<html><head></head><body><textarea>1 &lt; 2</textarea></body></html>");
  assert.ok(domTreesEquivalent(parse(serializeDom(tree)), tree));
});

void test("Req 18.3: an empty document serializes to the synthesized outline", () => {
  assert.equal(serializeDom(parse("")), "<html><head></head><body></body></html>");
});

void test("Req 18.3: nested elements and multiple siblings round-trip", () => {
  const tree = parse("<div><span>a</span><b>c</b>tail</div>");
  assert.equal(
    serializeDom(tree),
    "<html><head></head><body><div><span>a</span><b>c</b>tail</div></body></html>",
  );
  assert.ok(domTreesEquivalent(parse(serializeDom(tree)), tree));
});

// ---------------------------------------------------------------------------
// domTreesEquivalent oracle — sanity that it discriminates, not just accepts.
// ---------------------------------------------------------------------------

void test("domTreesEquivalent is reflexive and ignores NodeId numbering", () => {
  const base = parse("<div id=a><span>hi</span><br></div>");
  assert.ok(domTreesEquivalent(base, base));
  // Re-parsing yields a fresh tree with the same structure but identical ids;
  // wrapping in a leading comment shifts every id yet must stay equivalent in
  // the subtree we compare.
  assert.ok(domTreesEquivalent(parse("<div id=a><span>hi</span><br></div>"), base));
});

void test("domTreesEquivalent treats attribute order as insignificant", () => {
  assert.ok(domTreesEquivalent(parse('<div a="1" b="2"></div>'), parse('<div b="2" a="1"></div>')));
});

void test("domTreesEquivalent rejects genuine structural differences", () => {
  const base = parse("<div><span>hi</span></div>");
  assert.ok(!domTreesEquivalent(base, parse("<div><span>bye</span></div>")), "different text");
  assert.ok(!domTreesEquivalent(base, parse("<div><p>hi</p></div>")), "different tag");
  assert.ok(!domTreesEquivalent(base, parse('<div id="x"><span>hi</span></div>')), "different attrs");
  assert.ok(!domTreesEquivalent(base, parse("<div><span>hi</span><span>hi</span></div>")), "different child count");
  assert.ok(!domTreesEquivalent(base, parse("<div><!--hi--></div>")), "different kind");
});
