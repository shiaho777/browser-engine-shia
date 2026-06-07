/**
 * Tests for the M3.2 scripting bridge: REAL JavaScript (executed by V8 via
 * `node:vm`) mutates the DOM, and the fine-grained session re-renders to reflect
 * it. This is the interactive loop end-to-end: script → DOM mutation →
 * incremental re-render.
 *
 * Built by `tsc` then run with: `node --test packages/cli/dist/*.test.js`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { PaintCmd } from "@browser-engine/ir";

import { FineSession } from "./fine.js";
import { runScript } from "./script.js";

const styled =
  "<html><head><style>.box { width: 10px; height: 10px; background-color: red }" +
  " .hot { background-color: blue }</style></head>" +
  '<body><div id="a" class="box">hi</div></body></html>';

function rectFills(list: { commands: readonly PaintCmd[] }): { r: number; g: number; b: number }[] {
  return list.commands
    .filter((c): c is Extract<PaintCmd, { op: "rect" }> => c.op === "rect")
    .map((c) => ({ r: c.fill.r, g: c.fill.g, b: c.fill.b }));
}

function textGlyphIds(list: { commands: readonly PaintCmd[] }): number[] {
  return list.commands
    .filter((c): c is Extract<PaintCmd, { op: "text" }> => c.op === "text")
    .flatMap((c) => c.glyphs.map((g) => g.glyphId));
}

void test("real JS setAttribute mutates the DOM and the engine re-renders the new style", () => {
  const session = new FineSession(styled);
  // Before: the div is `.box` ⇒ red.
  assert.deepEqual(rectFills(session.render()), [{ r: 255, g: 0, b: 0 }]);

  // Real V8-executed JavaScript toggles the class.
  const result = runScript(session, `document.getElementById("a").setAttribute("class", "box hot");`);
  assert.equal(result.mutations, 1);

  // After re-render: the `.hot` rule wins ⇒ blue.
  assert.deepEqual(rectFills(session.render()), [{ r: 0, g: 0, b: 255 }]);
});

void test("real JS textContent assignment changes the rendered glyph run", () => {
  const session = new FineSession(styled);
  assert.deepEqual(textGlyphIds(session.render()), [0x68, 0x69]); // "hi"

  runScript(session, `document.getElementById("a").textContent = "ok";`);

  assert.deepEqual(textGlyphIds(session.render()), [0x6f, 0x6b]); // "ok"
});

void test("real JS can read back the DOM it mutated (getAttribute / textContent)", () => {
  const session = new FineSession(styled);
  session.render();
  // The script reads, mutates, and the assertions ride on a returned marker
  // attribute so we observe the script's own view of the DOM.
  runScript(
    session,
    `const el = document.querySelector("#a");
     if (el.getAttribute("class") !== "box") throw new Error("read failed: " + el.getAttribute("class"));
     el.setAttribute("data-seen", el.textContent);`,
  );
  // The script wrote its observed textContent ("hi") into data-seen.
  const a = [...session.dom.nodes.values()].find((n) => n.attrs?.get("id") === "a");
  assert.equal(a?.attrs?.get("data-seen"), "hi");
});

void test("a script that mutates nothing performs zero mutations and changes no output", () => {
  const session = new FineSession(styled);
  const before = rectFills(session.render());
  const result = runScript(session, `var x = document.getElementById("a").getAttribute("class");`);
  assert.equal(result.mutations, 0);
  assert.deepEqual(rectFills(session.render()), before);
});

void test("scripted mutation re-renders incrementally (only the edited node recomputes)", () => {
  // A list with many items; a script edits ONE — the per-node session recomputes
  // only that item's cascade (the M4 win, now driven by real JS).
  const items = Array.from({ length: 40 }, (_, i) => `<div id="i${i}" class="box">x</div>`).join("");
  const html =
    "<html><head><style>.box { width: 5px; height: 5px; background-color: red } .hot { background-color: blue }</style></head>" +
    `<body>${items}</body></html>`;
  const session = new FineSession(html);
  session.render();
  const before = session.recomputeCount;

  runScript(session, `document.getElementById("i20").setAttribute("class", "box hot");`);
  session.render();
  const delta = session.recomputeCount - before;

  // Constant-ish work for one scripted edit, NOT ~40 cascades.
  assert.ok(delta < 10, `one scripted edit recomputes O(1), not O(N): delta=${delta}`);
  // And exactly one box turned blue.
  assert.equal(session.render().commands.filter((c) => c.op === "rect" && c.fill.b === 255).length, 1);
});
