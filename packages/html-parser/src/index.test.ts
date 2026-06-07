/**
 * Tests for the HTML parser.
 *
 * Built by `tsc` then run with: `node --test packages/html-parser/dist/*.test.js`.
 *
 * The original block (task 3.1) covers the Phase 1 supported subset and the IR
 * contract from design.md §4.1/§6 and Requirements 14.1, 18.1, 2.7, 3.2.
 *
 * Task 5.1 (Phase 2-4, Requirement 15.1) upgraded the minimal string scanner to
 * a genuine tokenizer + tree-construction algorithm. The block at the end of
 * this file exercises that fuller behaviour:
 *   - 15.1: real tree construction — implied end tags, optional-tag
 *     auto-closing (`<p>`/`<li>`/`<dd>`…), the stack of open elements, and
 *     explicit `<html>`/`<head>`/`<body>` handling.
 *   - 13.1/18.6: malformed input is recovered (mismatched/unclosed/stray tags)
 *     and the parser keeps producing a best-effort DomTree.
 *   - 13.2/18.6: each recovery is recorded in the recovery metric exposed by
 *     `parseHtmlWithMetrics`.
 *
 * The task-3.1 assertions are retained verbatim: the `<div>hello</div>` →
 * document → div → text shape the downstream pipeline depends on MUST survive
 * the upgrade (top-level elements are parented directly to `document`; no forced
 * `html`/`head`/`body` wrappers — a deliberate, documented divergence).
 *
 * Covers the IR contract from design.md §4.1/§6 and Requirements 14.1, 18.1, 2.7:
 *   - 18.1: a valid HTML byte stream parses into a DomTree.
 *   - 14.1: the Phase 1 minimal document `<div>hello</div>` is representable.
 *   - 2.7:  parseHtml is a pure function — same bytes ⇒ equal DomTree.
 *   - 3.2:  the returned DomTree is deep-frozen (downstream cannot mutate it).
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { DomNode, DomTree, NodeId } from "@browser-engine/ir";

import { parseHtml, parseHtmlWithMetrics } from "./index.js";

const encode = (html: string): Uint8Array => new TextEncoder().encode(html);
const parse = (html: string): DomTree => parseHtml(encode(html));

/** The single child of `id` (asserting there is exactly one). */
function onlyChild(tree: DomTree, id: NodeId): DomNode {
  const node = tree.nodes.get(id);
  assert.ok(node !== undefined, "node must exist");
  assert.equal(node.children.length, 1, "expected exactly one child");
  const childId = node.children[0];
  assert.ok(childId !== undefined);
  const child = tree.nodes.get(childId);
  assert.ok(child !== undefined, "child node must be in the map");
  return child;
}

/** Resolve a node by id, asserting presence. */
function nodeAt(tree: DomTree, id: NodeId): DomNode {
  const node = tree.nodes.get(id);
  assert.ok(node !== undefined, "node must exist");
  return node;
}

void test("Req 14.1/18.1: <div>hello</div> parses into the expected DomTree", () => {
  const tree = parse("<div>hello</div>");

  const root = nodeAt(tree, tree.root);
  assert.equal(root.kind, "document");
  assert.equal(root.parent, null);

  const div = onlyChild(tree, tree.root);
  assert.equal(div.kind, "element");
  assert.equal(div.tag, "div");
  assert.equal(div.parent, tree.root);

  const text = onlyChild(tree, div.id);
  assert.equal(text.kind, "text");
  assert.equal(text.text, "hello");
  assert.equal(text.parent, div.id);
  assert.deepEqual([...text.children], []);
});

void test("nested elements build a parent/child tree", () => {
  const tree = parse("<div><p><span>hi</span></p></div>");

  const div = onlyChild(tree, tree.root);
  assert.equal(div.tag, "div");

  const p = onlyChild(tree, div.id);
  assert.equal(p.tag, "p");
  assert.equal(p.parent, div.id);

  const span = onlyChild(tree, p.id);
  assert.equal(span.tag, "span");
  assert.equal(span.parent, p.id);

  const text = onlyChild(tree, span.id);
  assert.equal(text.kind, "text");
  assert.equal(text.text, "hi");
});

void test("attributes are parsed (quoted, unquoted, valueless, lowercased names)", () => {
  const tree = parse(
    `<div id="main" CLASS='a b' data-x=42 hidden>x</div>`,
  );
  const div = onlyChild(tree, tree.root);
  assert.equal(div.tag, "div");
  assert.ok(div.attrs !== undefined);

  assert.equal(div.attrs.get("id"), "main");
  assert.equal(div.attrs.get("class"), "a b");
  assert.equal(div.attrs.get("data-x"), "42");
  assert.equal(div.attrs.get("hidden"), "");
});

void test("multiple sibling text and element nodes preserve document order", () => {
  const tree = parse("<div>a<span>b</span>c</div>");
  const div = onlyChild(tree, tree.root);
  assert.equal(div.children.length, 3);

  const kinds = div.children.map((id) => nodeAt(tree, id).kind);
  assert.deepEqual(kinds, ["text", "element", "text"]);

  const first = nodeAt(tree, div.children[0]!);
  const middle = nodeAt(tree, div.children[1]!);
  const last = nodeAt(tree, div.children[2]!);
  assert.equal(first.text, "a");
  assert.equal(middle.tag, "span");
  assert.equal(onlyChild(tree, middle.id).text, "b");
  assert.equal(last.text, "c");
});

void test("text-only documents and whitespace are preserved", () => {
  const tree = parse("hello world");
  const text = onlyChild(tree, tree.root);
  assert.equal(text.kind, "text");
  assert.equal(text.text, "hello world");
});

void test("HTML entities in text and attributes are decoded", () => {
  const tree = parse(`<a title="x &amp; y">5 &lt; 10 &#65;</a>`);
  const a = onlyChild(tree, tree.root);
  assert.equal(a.attrs?.get("title"), "x & y");
  const text = onlyChild(tree, a.id);
  assert.equal(text.text, "5 < 10 A");
});

void test("void elements have no children and do not capture following siblings", () => {
  const tree = parse("<div><br>after</div>");
  const div = onlyChild(tree, tree.root);
  assert.equal(div.children.length, 2);

  const br = nodeAt(tree, div.children[0]!);
  assert.equal(br.tag, "br");
  assert.deepEqual([...br.children], []);

  const after = nodeAt(tree, div.children[1]!);
  assert.equal(after.kind, "text");
  assert.equal(after.text, "after");
  assert.equal(after.parent, div.id);
});

void test("self-closing syntax is treated as a childless element", () => {
  const tree = parse("<div><custom-thing/>tail</div>");
  const div = onlyChild(tree, tree.root);
  assert.equal(div.children.length, 2);
  const custom = nodeAt(tree, div.children[0]!);
  assert.equal(custom.tag, "custom-thing");
  assert.deepEqual([...custom.children], []);
});

void test("comments become comment nodes carrying their text", () => {
  const tree = parse("<div><!-- note -->x</div>");
  const div = onlyChild(tree, tree.root);
  const comment = nodeAt(tree, div.children[0]!);
  assert.equal(comment.kind, "comment");
  assert.equal(comment.text, " note ");
});

void test("DOCTYPE declarations are skipped (not emitted as nodes)", () => {
  const tree = parse("<!DOCTYPE html><div>hi</div>");
  const div = onlyChild(tree, tree.root);
  assert.equal(div.tag, "div");
});

void test("raw-text elements (script/style) keep their content verbatim", () => {
  const tree = parse("<style>.a > .b { color: red }</style>");
  const style = onlyChild(tree, tree.root);
  assert.equal(style.tag, "style");
  const text = onlyChild(tree, style.id);
  assert.equal(text.kind, "text");
  assert.equal(text.text, ".a > .b { color: red }");
});

void test("tag names are lowercased", () => {
  const tree = parse("<DIV><SPAN>x</SPAN></DIV>");
  const div = onlyChild(tree, tree.root);
  assert.equal(div.tag, "div");
  assert.equal(onlyChild(tree, div.id).tag, "span");
});

void test("stray/mismatched end tags are tolerated without throwing", () => {
  const tree = parse("<div>hi</span></div>");
  const div = onlyChild(tree, tree.root);
  assert.equal(div.tag, "div");
  assert.equal(onlyChild(tree, div.id).text, "hi");
});

void test("unclosed tags still produce a well-formed tree", () => {
  const tree = parse("<div><p>text");
  const div = onlyChild(tree, tree.root);
  assert.equal(div.tag, "div");
  const p = onlyChild(tree, div.id);
  assert.equal(p.tag, "p");
  assert.equal(onlyChild(tree, p.id).text, "text");
});

void test("an empty byte stream yields a lone document root", () => {
  const tree = parse("");
  const root = nodeAt(tree, tree.root);
  assert.equal(root.kind, "document");
  assert.deepEqual([...root.children], []);
  assert.equal(tree.nodes.size, 1);
});

// ---------------------------------------------------------------------------
// Req 3.2 — the result is deep-frozen so a downstream stage cannot mutate it.
// ---------------------------------------------------------------------------
void test("Req 3.2: the returned DomTree is deep-frozen", () => {
  const tree = parse(`<div id="main">hello</div>`);
  assert.ok(Object.isFrozen(tree));
  assert.ok(Object.isFrozen(tree.nodes));
  for (const node of tree.nodes.values()) {
    assert.ok(Object.isFrozen(node));
    assert.ok(Object.isFrozen(node.children));
    if (node.attrs !== undefined) {
      assert.ok(Object.isFrozen(node.attrs));
    }
  }

  const div = onlyChild(tree, tree.root);
  assert.throws(() => {
    (div as unknown as Record<string, unknown>)["tag"] = "span";
  }, TypeError);
});

// ---------------------------------------------------------------------------
// Req 2.7 — parseHtml is a pure function: same bytes ⇒ structurally equal IR.
// ---------------------------------------------------------------------------
void test("Req 2.7: parseHtml is deterministic for identical input", () => {
  const html = `<div id="x"><p>hello</p><br>world</div>`;

  const serialize = (tree: DomTree): string => {
    const parts: string[] = [`root=${tree.root}`];
    for (const [id, node] of [...tree.nodes.entries()].sort((a, b) => a[0] - b[0])) {
      const attrs = node.attrs ? [...node.attrs.entries()].sort() : [];
      parts.push(
        `${id}:${node.kind}:${node.tag ?? ""}:${node.text ?? ""}:${JSON.stringify(attrs)}:[${node.children.join(",")}]:${node.parent}`,
      );
    }
    return parts.join("|");
  };

  assert.equal(serialize(parse(html)), serialize(parse(html)));
});

// ===========================================================================
// Task 5.1 — full HTML5 tree-construction algorithm (Requirement 15.1) and the
// recovery metric (Requirements 13.1, 13.2, 18.6).
// ===========================================================================

/** All element nodes in document order, by tag name. */
function elementTags(tree: DomTree): string[] {
  const tags: string[] = [];
  for (const node of tree.nodes.values()) {
    if (node.kind === "element" && node.tag !== undefined) tags.push(node.tag);
  }
  return tags;
}

/** The children (resolved) of a node. */
function childrenOf(tree: DomTree, id: NodeId): DomNode[] {
  return nodeAt(tree, id).children.map((c) => nodeAt(tree, c));
}

/** The first element with `tag`, asserting it exists. */
function firstElement(tree: DomTree, tag: string): DomNode {
  for (const node of tree.nodes.values()) {
    if (node.kind === "element" && node.tag === tag) return node;
  }
  throw new Error(`expected an <${tag}> element`);
}

// ---------------------------------------------------------------------------
// Req 15.1 — the `<div>hello</div>` shape is preserved (NO forced html/head/body
// wrappers). This is the contract the whole downstream pipeline relies on.
// ---------------------------------------------------------------------------
void test("Req 15.1: a bare document is NOT wrapped in implied html/head/body", () => {
  const tree = parse("<div>hello</div>");
  // document → div → text, with the div as nodeId 1 and text as nodeId 2.
  const root = nodeAt(tree, tree.root);
  assert.equal(root.children.length, 1);
  const div = nodeAt(tree, root.children[0]!);
  assert.equal(div.tag, "div");
  assert.equal(div.id, 1);
  const text = nodeAt(tree, div.children[0]!);
  assert.equal(text.kind, "text");
  assert.equal(text.text, "hello");
  assert.equal(text.id, 2);
  // No html/head/body were synthesised.
  assert.deepEqual(elementTags(tree), ["div"]);
});

// ---------------------------------------------------------------------------
// Req 18.1 — well-formed nested documents build the expected tree.
// ---------------------------------------------------------------------------
void test("Req 18.1: a well-formed nested document builds the full tree", () => {
  const tree = parse(
    "<section><h1>Title</h1><p>Para <em>one</em></p><ul><li>a</li><li>b</li></ul></section>",
  );
  const section = onlyChild(tree, tree.root);
  assert.equal(section.tag, "section");

  const kids = childrenOf(tree, section.id);
  assert.deepEqual(kids.map((k) => k.tag), ["h1", "p", "ul"]);

  const ul = kids[2]!;
  const lis = childrenOf(tree, ul.id);
  assert.deepEqual(lis.map((k) => k.tag), ["li", "li"]);
  assert.equal(onlyChild(tree, lis[0]!.id).text, "a");
  assert.equal(onlyChild(tree, lis[1]!.id).text, "b");

  const p = kids[1]!;
  const pKids = childrenOf(tree, p.id);
  assert.equal(pKids[0]!.text, "Para ");
  assert.equal(pKids[1]!.tag, "em");
});

// ---------------------------------------------------------------------------
// Req 15.1 — explicit html/head/body are honoured as ordinary elements.
// ---------------------------------------------------------------------------
void test("Req 15.1: explicit <html>/<head>/<body> are honoured (not duplicated)", () => {
  const tree = parse(
    "<html><head><title>T</title></head><body><div>x</div></body></html>",
  );
  const html = onlyChild(tree, tree.root);
  assert.equal(html.tag, "html");

  const htmlKids = childrenOf(tree, html.id);
  assert.deepEqual(htmlKids.map((k) => k.tag), ["head", "body"]);

  const head = htmlKids[0]!;
  assert.equal(onlyChild(tree, head.id).tag, "title");

  const body = htmlKids[1]!;
  assert.equal(onlyChild(tree, body.id).tag, "div");

  // Exactly one of each — no implied duplicates.
  assert.equal(elementTags(tree).filter((t) => t === "html").length, 1);
  assert.equal(elementTags(tree).filter((t) => t === "head").length, 1);
  assert.equal(elementTags(tree).filter((t) => t === "body").length, 1);
});

// ---------------------------------------------------------------------------
// Req 15.1 — optional-tag auto-closing (VALID HTML, not a recovery).
// ---------------------------------------------------------------------------
void test("Req 15.1: implicit <p> closing — a block start tag closes an open <p>", () => {
  const { tree, recoveries } = parseHtmlWithMetrics(
    new TextEncoder().encode("<p>one<p>two<div>three</div>"),
  );
  // Three siblings under document: p, p, div — the <p>s auto-closed.
  const top = childrenOf(tree, tree.root);
  assert.deepEqual(top.map((k) => k.tag), ["p", "p", "div"]);
  assert.equal(onlyChild(tree, top[0]!.id).text, "one");
  assert.equal(onlyChild(tree, top[1]!.id).text, "two");
  assert.equal(onlyChild(tree, top[2]!.id).text, "three");
  // Auto-closing optional tags is valid HTML — no recovery recorded.
  assert.deepEqual([...recoveries], []);
});

void test("Req 15.1: implicit <li> closing — a sibling <li> closes the open one", () => {
  const { tree, recoveries } = parseHtmlWithMetrics(
    new TextEncoder().encode("<ul><li>a<li>b<li>c</ul>"),
  );
  const ul = onlyChild(tree, tree.root);
  assert.equal(ul.tag, "ul");
  const lis = childrenOf(tree, ul.id);
  assert.deepEqual(lis.map((k) => k.tag), ["li", "li", "li"]);
  // Each <li> nests its own text only (not its siblings).
  assert.equal(onlyChild(tree, lis[0]!.id).text, "a");
  assert.equal(onlyChild(tree, lis[1]!.id).text, "b");
  assert.equal(onlyChild(tree, lis[2]!.id).text, "c");
  // </ul> closing the last open <li> is valid HTML — no recovery.
  assert.deepEqual([...recoveries], []);
});

void test("Req 15.1: implicit <dd>/<dt> and <option> closing", () => {
  const tree = parse("<dl><dt>term<dd>def</dl><select><option>a<option>b</select>");
  const dl = firstElement(tree, "dl");
  assert.deepEqual(childrenOf(tree, dl.id).map((k) => k.tag), ["dt", "dd"]);
  const select = firstElement(tree, "select");
  assert.deepEqual(childrenOf(tree, select.id).map((k) => k.tag), ["option", "option"]);
});

// ---------------------------------------------------------------------------
// Req 13.1/13.2/18.6 — malformed-input recovery + recovery metric.
// ---------------------------------------------------------------------------
void test("Req 13.1/13.2: a mismatched end tag force-closes and records a recovery", () => {
  const { tree, recoveries } = parseHtmlWithMetrics(
    new TextEncoder().encode("<b><i>x</b>y"),
  );
  // <i> is force-closed by </b>; the tree still has both elements.
  const b = firstElement(tree, "b");
  const i = firstElement(tree, "i");
  assert.equal(i.parent, b.id);
  // A recovery for the mismatched (force-closed) <i> was recorded.
  assert.ok(recoveries.some((r) => r.kind === "mismatched-end-tag" && r.tag === "i"));
});

void test("Req 13.1/13.2: a stray end tag is dropped and recorded", () => {
  const { tree, recoveries } = parseHtmlWithMetrics(
    new TextEncoder().encode("<div>hi</span></div>"),
  );
  const div = onlyChild(tree, tree.root);
  assert.equal(div.tag, "div");
  assert.equal(onlyChild(tree, div.id).text, "hi");
  assert.ok(recoveries.some((r) => r.kind === "stray-end-tag" && r.tag === "span"));
});

void test("Req 13.1/13.2: unclosed non-optional elements are closed at EOF and recorded", () => {
  const { tree, recoveries } = parseHtmlWithMetrics(
    new TextEncoder().encode("<div><span>text"),
  );
  const div = onlyChild(tree, tree.root);
  const span = onlyChild(tree, div.id);
  assert.equal(span.tag, "span");
  assert.equal(onlyChild(tree, span.id).text, "text");
  // Both <div> and <span> were left open → two unclosed-element recoveries.
  const unclosed = recoveries.filter((r) => r.kind === "unclosed-element");
  assert.deepEqual(unclosed.map((r) => r.tag).sort(), ["div", "span"]);
});

void test("Req 13.2: an end tag for a void element is recorded as a recovery", () => {
  const { recoveries } = parseHtmlWithMetrics(new TextEncoder().encode("<div></br></div>"));
  assert.ok(recoveries.some((r) => r.kind === "end-tag-for-void-element" && r.tag === "br"));
});

void test("Req 18.6: an unterminated comment is recovered and recorded", () => {
  const { tree, recoveries } = parseHtmlWithMetrics(
    new TextEncoder().encode("<div><!-- oops"),
  );
  const div = onlyChild(tree, tree.root);
  const comment = nodeAt(tree, div.children[0]!);
  assert.equal(comment.kind, "comment");
  assert.equal(comment.text, " oops");
  assert.ok(recoveries.some((r) => r.kind === "eof-in-comment"));
});

void test("Req 13.1: well-formed input records ZERO recoveries", () => {
  const { recoveries } = parseHtmlWithMetrics(
    new TextEncoder().encode("<div><p>hi</p><br><span>x</span></div>"),
  );
  assert.deepEqual([...recoveries], []);
});

void test("Req 18.6: the recovery metric (count) accumulates across multiple errors", () => {
  const { recoveries } = parseHtmlWithMetrics(
    new TextEncoder().encode("</p><b><i>x</b></u>"),
  );
  // stray </p>, mismatched </b> (force-closes <i>), stray </u>, plus the
  // unclosed <b> at EOF (… actually <b> is closed by </b>): at least 3 events.
  assert.ok(recoveries.length >= 3, `expected ≥3 recoveries, got ${recoveries.length}`);
  // The metric is a list of structured events with positions.
  for (const r of recoveries) {
    assert.equal(typeof r.position, "number");
    assert.ok(typeof r.kind === "string" && r.kind.length > 0);
  }
});

// ---------------------------------------------------------------------------
// RCDATA elements (textarea/title): verbatim markup, but entities decode.
// ---------------------------------------------------------------------------
void test("Req 15.1: RCDATA elements keep markup verbatim but decode entities", () => {
  const tree = parse("<textarea><b>not a tag</b> &amp; more</textarea>");
  const ta = onlyChild(tree, tree.root);
  assert.equal(ta.tag, "textarea");
  const text = onlyChild(tree, ta.id);
  assert.equal(text.kind, "text");
  assert.equal(text.text, "<b>not a tag</b> & more");
});

// ---------------------------------------------------------------------------
// Pure-function metric: same bytes ⇒ structurally equal recovery metric.
// ---------------------------------------------------------------------------
void test("Req 2.7: parseHtmlWithMetrics is deterministic (tree + recovery metric)", () => {
  const bytes = new TextEncoder().encode("<b><i>x</b><div><p>y");
  const a = parseHtmlWithMetrics(bytes);
  const b = parseHtmlWithMetrics(bytes);
  assert.deepEqual(
    a.recoveries.map((r) => `${r.kind}:${r.tag ?? ""}:${r.position}`),
    b.recoveries.map((r) => `${r.kind}:${r.tag ?? ""}:${r.position}`),
  );
  // The result (tree + metric) is deep-frozen.
  assert.ok(Object.isFrozen(a));
  assert.ok(Object.isFrozen(a.recoveries));
});
