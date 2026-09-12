/**
 * document-write.test.ts — D5 tests: `document.write` / `writeln` / `open` /
 * `close` (HTML §4.2.5). The insertion point is the PARSER'S position —
 * right after the currently executing `<script>` element — so written content
 * lands in the document's flow, before later-siblings render.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { runScriptsOnSession } from "./event-loop.js";
import { FineSession } from "./fine.js";

/**
 * Run one guest script against a document. The script is passed SEPARATELY
 * (not extracted from the HTML) — a `</p>` inside a document.write string
 * would terminate a regex extraction, and the pipeline extracts scripts
 * from the DOM (where the tokenizer's RAWTEXT handling already solved this).
 */
function run(html: string, scripts: readonly string[] = []): { session: FineSession; error: string | null } {
  const session = new FineSession(html);
  const run0 = runScriptsOnSession(session, scripts.length > 0 ? scripts : [defaultScript(html)]);
  return { session, error: run0.error };
}

/** The default script: whatever sits in the html's first <script> body. */
function defaultScript(html: string): string {
  const start = html.indexOf("<script>");
  if (start === -1) return "";
  const end = html.indexOf("</script>", start);
  return end === -1 ? html.slice(start + 8) : html.slice(start + 8, end);
}

void test("document.write inserts parsed HTML after the executing script", () => {
  const { session, error } = run(
    '<div>before</div><script></script><div>after</div>',
    ['document.write(\'<p id="inj">injected</p>\')'],
  );
  assert.equal(error, null);
  const p = [...session.dom.nodes.values()].find((n) => n.tag === "p");
  assert.ok(p !== undefined, "the <p> was written into the document");
  assert.equal(p.attrs?.get("id"), "inj");

  // The insertion point: the written <p> is in the same parent as the
  // document outline, with the "after" div still present after it.
  const parent = session.dom.nodes.get(p.parent!)!;
  const pIdx = parent.children.indexOf(p.id);
  assert.ok(pIdx > 0, "the written <p> sits after the script");
  // The "after" div is still in the document (not replaced by the write).
  const afterText = [...session.dom.nodes.values()].find(
    (n) => n.kind === "text" && (n.text ?? "").trim() === "after",
  );
  assert.ok(afterText !== undefined, "the later-sibling div's text is still present");
});

void test("document.write text content becomes a text node", () => {
  const { session, error } = run(
    '<script>document.write("hello world")</script>',
  );
  assert.equal(error, null);
  const text = [...session.dom.nodes.values()].find(
    (n) => n.kind === "text" && (n.text ?? "").includes("hello world"),
  );
  assert.ok(text !== undefined, "the written string became a text node");
});

void test("document.write composes multiple calls in order", () => {
  const { session, error } = run(
    '<script>document.write("<b>one</b>"); document.write("<i>two</i>")</script>',
  );
  assert.equal(error, null);
  const b = [...session.dom.nodes.values()].find((n) => n.tag === "b");
  const i = [...session.dom.nodes.values()].find((n) => n.tag === "i");
  assert.ok(b !== undefined && i !== undefined);
  // <b> comes before <i> in the parent's child list.
  const bIdx = session.dom.nodes.get(b.parent!)!.children.indexOf(b.id);
  const iIdx = session.dom.nodes.get(i.parent!)!.children.indexOf(i.id);
  assert.ok(bIdx < iIdx, "the writes compose in call order");
});

void test("document.write with no executing script appends to the body", () => {
  const { session, error } = run(
    '<div>content</div><script>setTimeout(function () { document.write("<span>late</span>") }, 0)</script>',
  );
  assert.equal(error, null);
  // After the timer drains, the span appended to the body.
  const span = [...session.dom.nodes.values()].find((n) => n.tag === "span");
  assert.ok(span !== undefined, "the late write appended to the body");
  const parent = session.dom.nodes.get(span.parent!)!;
  assert.equal(parent.tag, "body");
});

void test("document.writeln appends a trailing newline", () => {
  const { session, error } = run(
    "<div></div>",
    ['document.writeln("line1"); document.writeln("line2")'],
  );
  assert.equal(error, null);
  const texts = [...session.dom.nodes.values()]
    .filter((n) => n.kind === "text" && (n.text ?? "").includes("line"))
    .map((n) => n.text ?? "");
  assert.ok(texts.length >= 2, "two text nodes from two writeln calls");
  assert.ok(texts[0]!.endsWith("\n"), "writeln adds a trailing newline");
});

void test("document.open and document.close are callable no-ops", () => {
  const { error } = run(
    '<script>document.open(); document.close(); document.title = "survived"</script>',
  );
  assert.equal(error, null, "open/close do not throw");
});

void test("document.write from a dynamic (late) script appends without a script context", () => {
  const { error } = run(
    '<div>host</div>',
  );
  assert.equal(error, null);
  // No script executed — write through a second run with a script that
  // document.writes but the currentScriptBox is empty (post-parse).
  const session2 = new FineSession("<div>host</div>");
  const run2 = runScriptsOnSession(session2, ['document.write("<em>late</em>")']);
  assert.equal(run2.error, null);
  const em = [...session2.dom.nodes.values()].find((n) => n.tag === "em");
  assert.ok(em !== undefined, "the post-parse write landed");
  const parent = session2.dom.nodes.get(em.parent!)!;
  assert.equal(parent.tag, "body", "it appended to the body");
});

void test("written content participates in rendering", () => {
  const { session, error } = run(
    '<style>p { color: red; height: 20px }</style><script>document.write("<p>written</p>")</script>',
  );
  assert.equal(error, null);
  const p = [...session.dom.nodes.values()].find((n) => n.tag === "p");
  assert.ok(p !== undefined);
  // The written <p> laid out (the cascade + layout ran on it).
  const tree = session.layoutTree();
  const frag = [...tree.fragments.values()].find((f) => f.node === p.id);
  assert.ok(frag !== undefined, "the written <p> has a fragment");
  assert.equal(Number(frag.box.height), 20, "its CSS height applied");
});
