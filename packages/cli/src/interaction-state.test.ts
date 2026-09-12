/**
 * interaction-state.test.ts — D4 tests: `:hover` / `:active` / `:focus` /
 * `:focus-within` matching against live interaction state through the whole
 * FineSession pipeline (cascade → layout → render).
 *
 * The state is a KERNEL INPUT: setting a new one invalidates exactly the
 * cascade queries that read it (a re-cascade, not a rebuild).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { nodeId } from "@browser-engine/ir";

import { FineSession } from "./fine.js";

const HTML = [
  "<style>",
  "div { color: black }",
  "div:hover { color: red }",
  "div:active { color: green }",
  "div:focus { color: blue }",
  ".box:focus-within { color: green }",
  "</style>",
  '<div class="box"><div id="inner">hi</div></div>',
].join("");

const COLOR_OF = (s: { color: unknown }): string =>
  typeof s.color === "object" && s.color !== null
    ? `rgb(${(s.color as { r: number }).r},${(s.color as { g: number }).g},${(s.color as { b: number }).b})`
    : String(s.color);

const innerId = (session: FineSession): ReturnType<typeof nodeId> => {
  const inner = [...session.dom.nodes.values()].find((n) => n.tag === "div" && n.attrs?.get("id") === "inner")!;
  return inner.id;
};
const boxId = (session: FineSession): ReturnType<typeof nodeId> => {
  const box = [...session.dom.nodes.values()].find((n) => n.tag === "div" && n.attrs?.get("class") === "box")!;
  return box.id;
};

void test(":hover matches only the hovered node", () => {
  const session = new FineSession(HTML);
  const inner = innerId(session);
  const before = session.computed(inner);
  assert.equal(COLOR_OF(before), "rgb(0,0,0)", "no state ⇒ the base rule");

  session.setInteractionState({
    hovered: new Set([inner]),
    active: new Set(),
    focused: new Set(),
  });
  const hovered = session.computed(inner);
  assert.equal(COLOR_OF(hovered), "rgb(255,0,0)", "the :hover rule wins");

  // Leaving: back to the base rule.
  session.setInteractionState({
    hovered: new Set(),
    active: new Set(),
    focused: new Set(),
  });
  assert.equal(COLOR_OF(session.computed(inner)), "rgb(0,0,0)", "state cleared ⇒ base rule");
});

void test(":active and :focus match their own state", () => {
  const session = new FineSession(HTML);
  const inner = innerId(session);

  session.setInteractionState({ hovered: new Set(), active: new Set([inner]), focused: new Set() });
  assert.equal(COLOR_OF(session.computed(inner)), "rgb(0,128,0)", ":active wins");

  session.setInteractionState({ hovered: new Set(), active: new Set(), focused: new Set([inner]) });
  assert.equal(COLOR_OF(session.computed(inner)), "rgb(0,0,255)", ":focus wins");
});

void test(":focus-within matches an ancestor of the focused node", () => {
  const session = new FineSession(HTML);
  const inner = innerId(session);
  const box = boxId(session);

  session.setInteractionState({ hovered: new Set(), active: new Set(), focused: new Set([inner]) });
  assert.equal(COLOR_OF(session.computed(box)), "rgb(0,128,0)", "the ancestor sees :focus-within");
  // The focused inner itself also matches :focus (blue).
  assert.equal(COLOR_OF(session.computed(inner)), "rgb(0,0,255)");
});

void test("a state change re-renders with the hovered appearance (paint)", () => {
  const session = new FineSession(HTML);
  const inner = innerId(session);
  const before = session.render();

  session.setInteractionState({ hovered: new Set([inner]), active: new Set(), focused: new Set() });
  const after = session.render();
  assert.notEqual(before, after, "the display list changed");
  // The hovered text paints red: find the text command and check its fill.
  const textCmd = after.commands.find((c) => c.op === "text");
  assert.ok(textCmd !== undefined && textCmd.op === "text");
  assert.equal((textCmd.fill as { r: number }).r, 255, "the text paints red under :hover");
});

void test("hovering one node does not affect its sibling", () => {
  const html = [
    "<style>div { color: black } div:hover { color: red }</style>",
    "<div id='a'>a</div><div id='b'>b</div>",
  ].join("");
  const session = new FineSession(html);
  const a = [...session.dom.nodes.values()].find((n) => n.attrs?.get("id") === "a")!;
  const b = [...session.dom.nodes.values()].find((n) => n.attrs?.get("id") === "b")!;

  session.setInteractionState({ hovered: new Set([a.id]), active: new Set(), focused: new Set() });
  assert.equal(COLOR_OF(session.computed(a.id)), "rgb(255,0,0)", "a is hovered");
  assert.equal(COLOR_OF(session.computed(b.id)), "rgb(0,0,0)", "b stays at the base rule");
});

void test("the whole pipeline stays deterministic under state churn", () => {
  const session = new FineSession(HTML);
  const inner = innerId(session);
  for (let i = 0; i < 5; i += 1) {
    session.setInteractionState({ hovered: new Set([inner]), active: new Set(), focused: new Set() });
    const h1 = session.render();
    session.setInteractionState({ hovered: new Set(), active: new Set(), focused: new Set() });
    const b1 = session.render();
    session.setInteractionState({ hovered: new Set([inner]), active: new Set(), focused: new Set() });
    const h2 = session.render();
    assert.deepEqual(h1, h2, "the same state ⇒ the same display list");
    void b1;
  }
});
