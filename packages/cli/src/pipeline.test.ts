/**
 * Tests for the §7.2 render-pipeline wiring (task 1.10, updated through task
 * 3.10).
 *
 * Built by `tsc` then run with: `node --test packages/cli/dist/*.test.js`.
 *
 * The Phase 1 stages (html-parse, css-parse, cascade, layout, paint) are now
 * implemented, so running `qPaint` drives the FULL pipeline to a frozen
 * DisplayList. The constitution still holds end-to-end (design.md §12;
 * Requirement 5.1): any capability a Phase 1 stage does not implement must
 * still FAIL LOUDLY with `NotImplemented`, never a silent placeholder.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { isNotImplemented } from "@browser-engine/ir";
import { NaiveDb } from "@browser-engine/kernel";
import { CSS_PROPERTIES } from "@browser-engine/generator";
import { encodePng } from "@browser-engine/test-harness";

import {
  qComputed,
  qDom,
  qLayout,
  qPaint,
  qSheets,
  SourceBytes,
  type Url,
} from "./pipeline.js";
import { nodeId } from "@browser-engine/ir";

const URL: Url = "test://doc";
const BYTES = new TextEncoder().encode("<div>hello</div>");

/** Build a fresh naive-backed Db with the single leaf input seeded. */
function seededDb(): NaiveDb {
  const db = new NaiveDb();
  db.setInput(SourceBytes, URL, BYTES);
  return db;
}

void test("qDom parses the source bytes into a DomTree (html-parse implemented — task 3.1)", () => {
  const db = seededDb();
  const dom = db.query(qDom, URL);

  // <div>hello</div> ⇒ document → div → text "hello".
  const root = dom.nodes.get(dom.root);
  assert.ok(root !== undefined && root.kind === "document");
  assert.equal(root.children.length, 1);

  const divId = root.children[0];
  assert.ok(divId !== undefined);
  const div = dom.nodes.get(divId);
  assert.ok(div !== undefined && div.kind === "element");
  assert.equal(div.tag, "div");

  const textId = div.children[0];
  assert.ok(textId !== undefined);
  const text = dom.nodes.get(textId);
  assert.ok(text !== undefined && text.kind === "text");
  assert.equal(text.text, "hello");
});

void test("qSheets prepends the UA default sheet; a doc with no <style> has only it (real collection — M2)", () => {
  // The fixture bytes (`<div>hello</div>`) contain no `<style>`, so the only
  // sheet is the UA default (which carries `head/style/script { display:none }`).
  const db = seededDb();
  const sheets = db.query(qSheets, URL);
  assert.equal(sheets.length, 1, "only the UA default sheet is present");
});

void test("qSheets parses a <style> element's CSS into rules (after the UA sheet)", () => {
  const db = new NaiveDb();
  db.setInput(SourceBytes, URL, new TextEncoder().encode("<style>div { color: red }</style>"));
  const sheets = db.query(qSheets, URL);
  assert.equal(sheets.length, 2, "UA sheet + the document's <style>");
  const rule = sheets[1]?.rules[0]; // sheets[0] is the UA default.
  assert.ok(rule !== undefined);
  assert.equal(rule.selector[0]?.text, "div");
  assert.equal(rule.declarations[0]?.property, "color");
  assert.equal(rule.declarations[0]?.value, "red");
});

void test("qComputed produces a real ComputedStyle (cascade implemented — task 3.4)", () => {
  // The fixture `<div>hello</div>` parses to document → div → text. qSheets
  // parses the same bytes as CSS, which yields no rules, so the div's cascade
  // resolves every property to its initial value (Req 11.4) — and inherited
  // properties bottom out at their initial value too (Req 11.3). The div is
  // node 1 (document = 0).
  const db = seededDb();
  const style = db.query(qComputed, { url: URL, node: nodeId(1) });

  // Every data-table property is present with a computed value (Req 11.1).
  // Derived from the LIVE data table, so adding a CSS property (Platform-as-Data)
  // never breaks this — the cascade must surface exactly the generated fields.
  assert.deepEqual(new Set(Object.keys(style)), new Set(CSS_PROPERTIES.map((p) => p.field)));
  // Initial values for the undeclared div (Req 11.4 / 11.3).
  assert.deepEqual(style.color, { r: 0, g: 0, b: 0, a: 1 });
  assert.equal(style.display, "inline");
  assert.equal(style.fontSize, 16);
  // The new fields default to their initial values for an undeclared element.
  assert.equal(style["position"], "static");
  assert.equal(style["float"], "none");
  assert.equal(style["opacity"], 1);
  assert.equal(style["transform"], "none");
  assert.equal(style["zIndex"], 0);
  // No geometry leaks into ComputedStyle (Req 3.3) and the result is frozen.
  assert.equal("x" in style, false);
  assert.equal("box" in style, false);
  assert.ok(Object.isFrozen(style));
});

void test("qComputed is deterministic: same inputs ⇒ equal ComputedStyle (Req 11.5)", () => {
  const db = seededDb();
  const a = db.query(qComputed, { url: URL, node: nodeId(1) });
  const b = db.query(qComputed, { url: URL, node: nodeId(1) });
  assert.deepEqual(a, b);
});

void test("qLayout lays the document out into a FragmentTree (layout implemented — task 3.7)", () => {
  // `<div>hello</div>` ⇒ document(0) → div(1) → text "hello"(2). The minimal
  // block engine produces one fragment per laid-out node, stacked in block flow;
  // the FragmentTree is the sole source of geometry and is deep-frozen (Req 3.2).
  const db = seededDb();
  const tree = db.query(qLayout, URL);

  assert.ok(Object.isFrozen(tree));
  assert.ok(Object.isFrozen(tree.fragments));

  // The root fragment is the document node (id 0); it always lays out.
  const rootFrag = tree.fragments.get(tree.root);
  assert.ok(rootFrag !== undefined);
  assert.equal(rootFrag.node, nodeId(0));

  // document → div → text: three fragments.
  assert.equal(tree.fragments.size, 3);

  const divFragId = rootFrag.children[0];
  assert.ok(divFragId !== undefined);
  const divFrag = tree.fragments.get(divFragId);
  assert.ok(divFrag !== undefined);
  assert.equal(divFrag.node, nodeId(1));

  const textFragId = divFrag.children[0];
  assert.ok(textFragId !== undefined);
  const textFrag = tree.fragments.get(textFragId);
  assert.ok(textFrag !== undefined);
  assert.equal(textFrag.node, nodeId(2));

  // The text leaf carries SOME geometry (a line `font-size` tall — Req 14.1).
  assert.ok(textFrag.box.height > 0);
  // Block flow: the div's content height equals its single child's margin-box
  // height (the §8.2 cumulative-height invariant).
  assert.equal(divFrag.box.height, textFrag.box.marginBox.height);
  // getBoundingClientRect's sole legal source exists on every fragment.
  assert.ok(rootFrag.box.borderBox !== undefined);
});

void test("qPaint drives the FULL pipeline to a frozen DisplayList (paint implemented — task 3.10)", () => {
  // Every stage is implemented now, so running qPaint flows the whole pipeline
  // parse → cascade → layout → paint to completion and returns the DisplayList
  // IR — the backend-agnostic abstract paint commands (design.md §8.6).
  const db = seededDb();
  const list = db.query(qPaint, URL);

  // The result is the frozen DisplayList IR (Req 3.2): a commands sequence.
  assert.ok(Object.isFrozen(list));
  assert.ok(Object.isFrozen(list.commands));

  // `<div>hello</div>` ⇒ document → div → text "hello". With no CSS the div is
  // transparent (no rect), but the text leaf emits a `text` command (Req 3.5),
  // so the slice produces a NON-EMPTY DisplayList.
  assert.ok(list.commands.length > 0, "the `<div>hello</div>` slice must paint something");
  const texts = list.commands.filter((c) => c.op === "text");
  assert.equal(texts.length, 1);
  // The text command carries plain geometry/colour values, not IR handles.
  const textCmd = texts[0];
  assert.ok(textCmd !== undefined && textCmd.op === "text");
  assert.equal(typeof textCmd.at.x, "number");
  assert.equal(typeof textCmd.at.y, "number");
  // Initial color is black (no CSS declared it).
  assert.deepEqual(textCmd.fill, { r: 0, g: 0, b: 0, a: 1 });
});

void test("qPaint is deterministic: same input ⇒ structurally equal DisplayList (Req 2.7 purity)", () => {
  const db = seededDb();
  const a = db.query(qPaint, URL);
  const b = db.query(qPaint, URL);
  assert.deepEqual(a.commands, b.commands);
});

void test("an unimplemented capability still fails loudly with a pipeline NotImplemented (Req 5.1)", () => {
  // The pipeline is wired end-to-end, but the NotImplemented constitution still
  // holds: a capability the Phase 1 stages do not implement (here a CSS at-rule,
  // surfaced through qSheets) throws a NotImplemented that identifies it, rather
  // than silently returning a placeholder.
  const db = new NaiveDb();
  db.setInput(SourceBytes, URL, new TextEncoder().encode("<style>@media screen { div { color: red } }</style>"));
  try {
    db.query(qPaint, URL);
    assert.fail("expected an unimplemented capability to throw NotImplemented");
  } catch (error: unknown) {
    assert.ok(isNotImplemented(error));
    assert.equal(error.feature, "css-at-rule:@media");
  }
});

void test("running qDom is deterministic: same input ⇒ structurally equal DomTree (Req 2.7 purity)", () => {
  const shapes = new Set<string>();
  for (let i = 0; i < 3; i += 1) {
    const db = seededDb();
    const dom = db.query(qDom, URL);
    const parts: string[] = [`root=${dom.root}`];
    for (const [id, node] of [...dom.nodes.entries()].sort((a, b) => a[0] - b[0])) {
      parts.push(`${id}:${node.kind}:${node.tag ?? ""}:${node.text ?? ""}:[${node.children.join(",")}]`);
    }
    shapes.add(parts.join("|"));
  }
  assert.equal(shapes.size, 1, "a pure parse must yield the same DomTree shape every run");
});

void test("the pipeline's only writable surface is the SourceBytes leaf input", () => {
  // Reading the input before it is set fails loudly (no silent default); after
  // seeding, the stage — not the input — is what is missing.
  const empty = new NaiveDb();
  assert.throws(() => empty.query(qDom, URL)); // InputNotSetError from getInput
});

// ---------------------------------------------------------------------------
// M2: a REAL full HTML document — <head><style> styling <body> content — now
// renders end-to-end through real stylesheet collection (no Phase-1 hack).
// ---------------------------------------------------------------------------

void test("M2: a <style> in <head> styles <body> content end-to-end (real collection)", () => {
  const doc =
    "<html><head><style>div { width: 120px; height: 40px; background-color: red }</style></head>" +
    "<body><div>hi</div></body></html>";
  const db = new NaiveDb();
  db.setInput(SourceBytes, URL, new TextEncoder().encode(doc));

  // The stylesheet is collected from <style> and applied: the <div> resolves a
  // red background and a declared size, so paint emits a red background rect.
  const list = db.query(qPaint, URL);
  const rects = list.commands.filter((c) => c.op === "rect");
  assert.ok(rects.length >= 1, "the styled div paints a background rect");
  const r = rects[0];
  assert.ok(r !== undefined && r.op === "rect");
  assert.deepEqual(r.fill, { r: 255, g: 0, b: 0, a: 1 }, "the <style> rule colored the div red");
  assert.equal(Number(r.rect.width), 120, "the <style> rule sized the div to 120px");
  assert.equal(Number(r.rect.height), 40);
});

void test("M2: an inline data: <link rel=stylesheet> is collected and applied", () => {
  const css = "div { background-color: red }";
  const doc =
    `<html><head><link rel="stylesheet" href="data:text/css,${encodeURIComponent(css)}"></head>` +
    "<body><div>hi</div></body></html>";
  const db = new NaiveDb();
  db.setInput(SourceBytes, URL, new TextEncoder().encode(doc));
  const list = db.query(qPaint, URL);
  const rects = list.commands.filter((c) => c.op === "rect");
  assert.ok(rects.some((c) => c.op === "rect" && c.fill.r === 255 && c.fill.b === 0), "data: link styled the div red");
});

void test("M2: an unfetchable external <link> is skipped gracefully (renders unstyled, no throw)", () => {
  // A stylesheet that cannot be loaded is a real, graceful web condition — the
  // document renders unstyled — NOT an unimplemented capability. So it must NOT
  // throw; the div simply has no background rect.
  const doc =
    '<html><head><link rel="stylesheet" href="https://example.com/x.css"></head>' +
    "<body><div>hi</div></body></html>";
  const db = new NaiveDb();
  db.setInput(SourceBytes, URL, new TextEncoder().encode(doc));
  const list = db.query(qPaint, URL); // must not throw
  assert.equal(list.commands.filter((c) => c.op === "rect").length, 0, "unstyled ⇒ no background rect");
});

// ---------------------------------------------------------------------------
// M2: <img> replaced-element rendering. A `data:image/png` source is decoded
// (reusing the PNG codec) and paint emits an `image` command blitting it into
// the element's content box.
// ---------------------------------------------------------------------------

/** Build a `data:image/png;base64,…` URL for a w×h solid-colour image. */
function pngDataUrl(w: number, h: number, rgba: readonly [number, number, number, number]): string {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    data[i * 4] = rgba[0];
    data[i * 4 + 1] = rgba[1];
    data[i * 4 + 2] = rgba[2];
    data[i * 4 + 3] = rgba[3];
  }
  const png = encodePng({ width: w, height: h, data });
  const base64 = Buffer.from(png).toString("base64");
  return `data:image/png;base64,${base64}`;
}

void test("M2: an <img> with a data:image/png source paints a decoded image command", () => {
  const src = pngDataUrl(2, 2, [10, 20, 30, 255]);
  const doc =
    `<html><head><style>img { width: 64px; height: 48px }</style></head>` +
    `<body><img src="${src}"></body></html>`;
  const db = new NaiveDb();
  db.setInput(SourceBytes, URL, new TextEncoder().encode(doc));

  const list = db.query(qPaint, URL);
  const images = list.commands.filter((c) => c.op === "image");
  assert.equal(images.length, 1, "the <img> paints exactly one image command");
  const img = images[0];
  assert.ok(img !== undefined && img.op === "image");
  // The decoded source carries the real 2×2 pixels.
  assert.equal(img.src.width, 2);
  assert.equal(img.src.height, 2);
  assert.equal(img.src.pixels[0], 10, "decoded R channel");
  assert.equal(img.src.pixels[1], 20, "decoded G channel");
  assert.equal(img.src.pixels[2], 30, "decoded B channel");
  // It blits into the CSS-sized content box (64×48).
  assert.equal(Number(img.rect.width), 64);
  assert.equal(Number(img.rect.height), 48);
});

void test("M2: a broken/undecodable <img> source renders nothing (no image command, no throw)", () => {
  const doc =
    `<html><head><style>img { width: 64px; height: 48px }</style></head>` +
    `<body><img src="data:image/png;base64,not-a-real-png"></body></html>`;
  const db = new NaiveDb();
  db.setInput(SourceBytes, URL, new TextEncoder().encode(doc));
  const list = db.query(qPaint, URL); // must not throw
  assert.equal(list.commands.filter((c) => c.op === "image").length, 0);
});

void test("M2: an <img> with no decodable source emits no image command (external src skipped)", () => {
  const doc = `<body><img src="https://example.com/x.png"></body>`;
  const db = new NaiveDb();
  db.setInput(SourceBytes, URL, new TextEncoder().encode(doc));
  const list = db.query(qPaint, URL);
  assert.equal(list.commands.filter((c) => c.op === "image").length, 0);
});
