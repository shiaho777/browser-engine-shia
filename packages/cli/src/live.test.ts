/**
 * Tests for the M3 live document session: DOM mutation → incremental re-render.
 *
 * These prove the live loop on the real incremental kernel:
 *   - CORRECTNESS: an incremental re-render after a mutation is byte-for-byte
 *     identical to a from-scratch render of the mutated tree (kernel soundness);
 *   - MEMOIZATION: re-rendering without a mutation does ZERO recompute;
 *   - NO-OP: an equal-value mutation disturbs nothing (Req 2.6);
 *   - a real mutation is reflected in the output.
 *
 * Built by `tsc` then run with: `node --test packages/cli/dist/*.test.js`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { DisplayList, DomTree, NodeId, PaintCmd } from "@browser-engine/ir";
import { nodeId } from "@browser-engine/ir";

import { LiveSession, withRemoveAttribute, withText } from "./live.js";

/** Find the first node of a given kind/tag in a session's DOM. */
function findNode(dom: DomTree, pred: (n: { kind: string; tag?: string; text?: string }) => boolean): NodeId {
  for (const [id, node] of dom.nodes) {
    if (pred(node)) return id;
  }
  throw new Error("node not found");
}

/** A stable, comparable snapshot of a DisplayList's command ops + text/fills. */
function snapshot(list: DisplayList): string {
  return JSON.stringify(
    list.commands.map((c: PaintCmd) => {
      switch (c.op) {
        case "text":
          return { op: c.op, glyphs: c.glyphs.map((g) => g.glyphId), at: c.at };
        case "rect":
          return { op: c.op, rect: c.rect, fill: c.fill };
        default:
          return { op: c.op };
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Correctness: incremental re-render == from-scratch render of the mutated tree
// ---------------------------------------------------------------------------

void test("a mutated session renders byte-for-byte like a fresh session of the mutated DOM", () => {
  const session = new LiveSession("<div>hi</div>");
  session.render(); // prime the caches.

  const textId = findNode(session.dom, (n) => n.kind === "text");
  session.setText(textId, "hello");
  const incremental = snapshot(session.render());

  // A fresh session built directly from the mutated DOM (no incremental history).
  const fresh = new LiveSession("<div>hi</div>");
  const freshDom = withText(fresh.dom, findNode(fresh.dom, (n) => n.kind === "text"), "hello");
  fresh.setDom(freshDom);
  const fromScratch = snapshot(fresh.render());

  assert.equal(incremental, fromScratch, "incremental re-render equals a from-scratch render");
});

// ---------------------------------------------------------------------------
// Memoization: re-render without a mutation does ZERO recompute
// ---------------------------------------------------------------------------

void test("re-rendering without a mutation recomputes NOTHING (kernel memoization)", () => {
  const session = new LiveSession("<div>hi</div>");
  session.render(); // first render populates the memo.
  const after1 = session.recomputeCount;
  session.render(); // second render: every query is cache-clean.
  const after2 = session.recomputeCount;
  assert.equal(after2, after1, "a no-mutation re-render performs zero recompute");
});

void test("an equal-value mutation disturbs nothing (Req 2.6)", () => {
  const session = new LiveSession("<div>hi</div>");
  session.render();
  const before = session.recomputeCount;
  // Re-set the SAME tree object: setInput with an equal value is a no-op.
  session.setDom(session.dom);
  session.render();
  assert.equal(session.recomputeCount, before, "an equal-value setInput causes no recompute");
});

// ---------------------------------------------------------------------------
// A real mutation is reflected in the output
// ---------------------------------------------------------------------------

void test("mutating text changes the rendered glyph run", () => {
  const session = new LiveSession("<div>hi</div>");
  const before = session.render();
  const beforeGlyphs = before.commands
    .filter((c): c is Extract<PaintCmd, { op: "text" }> => c.op === "text")
    .flatMap((c) => c.glyphs.map((g) => g.glyphId));

  const textId = findNode(session.dom, (n) => n.kind === "text");
  session.setText(textId, "hello");
  const after = session.render();
  const afterGlyphs = after.commands
    .filter((c): c is Extract<PaintCmd, { op: "text" }> => c.op === "text")
    .flatMap((c) => c.glyphs.map((g) => g.glyphId));

  // "hi" = [104,105]; "hello" = [104,101,108,108,111].
  assert.deepEqual(beforeGlyphs, [0x68, 0x69]);
  assert.deepEqual(afterGlyphs, [0x68, 0x65, 0x6c, 0x6c, 0x6f]);
});

void test("mutating an attribute restyles the node (class drives a CSS rule)", () => {
  // A <style> rule keyed on a class; toggling the class on the div changes its
  // computed background, and the re-render reflects it.
  const html =
    "<html><head><style>.on { background-color: red; width: 20px; height: 20px }</style></head>" +
    "<body><div>x</div></body></html>";
  const session = new LiveSession(html);
  session.render();
  const divId = findNode(session.dom, (n) => n.kind === "element" && n.tag === "div");

  // Before: the div has no class ⇒ transparent ⇒ no background rect.
  assert.equal(session.render().commands.filter((c) => c.op === "rect").length, 0);

  // Add class="on": the rule matches ⇒ a red background rect appears.
  session.setAttribute(divId, "class", "on");
  const rects = session.render().commands.filter((c) => c.op === "rect");
  assert.ok(rects.length >= 1, "adding the class paints the rule's background");
  assert.ok(rects.some((c) => c.op === "rect" && c.fill.r === 255 && c.fill.b === 0), "background is red");
});

void test("withRemoveAttribute removes the key rather than storing an empty value", () => {
  const session = new LiveSession('<div id="x" data-on="yes"></div>');
  const divId = findNode(session.dom, (n) => n.kind === "element" && n.tag === "div");
  const next = withRemoveAttribute(session.dom, divId, "data-on");
  const div = next.nodes.get(divId);

  assert.equal(div?.attrs?.has("data-on"), false, "the attribute key is gone");
  assert.equal(div?.attrs?.get("data-on"), undefined, "there is no empty-string placeholder");
});

void test("the live session's render is itself deterministic across calls", () => {
  const session = new LiveSession("<div>hi</div>");
  assert.equal(snapshot(session.render()), snapshot(session.render()));
  void nodeId; // (re-exported id constructor is available to callers)
});
