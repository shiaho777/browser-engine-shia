import assert from "node:assert/strict";
import test from "node:test";

import { parseHtml } from "@browser-engine/html-parser";
import { cascade } from "@browser-engine/cascade";
import { layout } from "@browser-engine/layout";
import { paint } from "@browser-engine/paint";
import { px } from "@browser-engine/ir";

import { documentStylesheets, pipelineShaper } from "./index.js";

void test("UA stylesheet makes body/div/h1 block and paints backgrounds", () => {
  const html = `<!DOCTYPE html><html><head><style>
body { margin: 24px; background-color: #f8fafc; color: #0f172a; }
h1 { color: #1d4ed8; font-size: 28px; background-color: #fee2e2; }
.box { width: 160px; height: 70px; margin-top: 18px; background-color: #f59e0b; }
</style></head><body>
<h1>Hello</h1>
<div class="box">x</div>
</body></html>`;
  const dom = parseHtml(new TextEncoder().encode(html));
  const sheets = documentStylesheets(dom);
  const origins = sheets.map((_, i) => (i === 0 ? ("ua" as const) : ("author" as const)));
  const styleOf = (node: number) => cascade(dom, sheets, node as never, { width: 800, height: 600 }, origins);

  let bodyId: number | null = null;
  let h1Id: number | null = null;
  let divId: number | null = null;
  for (const [id, node] of dom.nodes) {
    if (node.kind !== "element") continue;
    if (node.tag === "body") bodyId = Number(id);
    if (node.tag === "h1") h1Id = Number(id);
    if (node.tag === "div") divId = Number(id);
  }
  assert.ok(bodyId !== null && h1Id !== null && divId !== null);
  assert.equal(styleOf(bodyId).display, "block");
  assert.equal(styleOf(h1Id).display, "block");
  assert.equal(styleOf(divId).display, "block");

  const tree = layout(dom, styleOf, {
    shaper: pipelineShaper,
    viewportWidth: px(800),
    viewportHeight: px(600),
  });
  const list = paint(tree, styleOf);
  const rects = list.commands.filter((c) => c.op === "rect");
  assert.ok(rects.length >= 3, `expected body/h1/box backgrounds, got ${rects.length}`);
  const texts = list.commands.filter((c) => c.op === "text" && c.glyphs.length > 0);
  assert.ok(texts.length >= 2, "expected real text runs");
  const hello = texts.find((c) => c.op === "text" && c.glyphs.some((g) => g.glyphId === 72));
  assert.ok(hello !== undefined && hello.op === "text");
  if (hello && hello.op === "text") {
    assert.ok(Number(hello.at.y) >= 24, `text y should include body margin, got ${hello.at.y}`);
  }
  const h1Bg = rects.find((c) => c.op === "rect" && c.fill.r === 254 && c.fill.g === 226);
  assert.ok(h1Bg !== undefined && h1Bg.op === "rect");
  if (h1Bg && h1Bg.op === "rect") {
    assert.ok(Number(h1Bg.rect.y) >= 24, `h1 background should be below body margin, got ${h1Bg.rect.y}`);
  }
});
