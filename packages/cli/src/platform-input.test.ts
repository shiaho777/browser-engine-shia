/**
 * Integration tests for the host→guest trusted input pipeline:
 * `runScriptsOnSessionReal`'s `dispatchPlatformEvent` hook must reach REAL
 * page listeners (`addEventListener`), carry pointer coordinates, fire
 * activation behavior for click, and honour defaultPrevented.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { FineSession } from "./fine.js";
import { runScriptsOnSessionReal } from "./event-loop.js";
import type { NodeId } from "@browser-engine/ir";

const FETCH_NONE = (): Promise<Uint8Array | undefined> => Promise.resolve(undefined);

function asNodeId(n: number): NodeId {
  return n as unknown as NodeId;
}

function firstTagId(session: FineSession, tag: string): NodeId {
  for (const [id, node] of session.dom.nodes) {
    if (node.kind === "element" && node.tag === tag) return asNodeId(id);
  }
  throw new Error(`no <${tag}> in fixture`);
}

function titleText(session: FineSession): string {
  for (const [, node] of session.dom.nodes) {
    if (node.kind === "element" && node.tag === "title") {
      const parts: string[] = [];
      for (const child of node.children) {
        const t = session.dom.nodes.get(child);
        if (t?.kind === "text" && t.text !== undefined) parts.push(t.text);
      }
      return parts.join("");
    }
  }
  return "";
}

void test("dispatchPlatformEvent fires a real page click listener with coordinates", async () => {
  const session = new FineSession(`<html><head><title>t0</title></head><body><button id="b">go</button></body></html>`);
  const run = await runScriptsOnSessionReal(session, [
    [
      'document.getElementById("b").addEventListener("click", function (e) {',
      '  document.title = "clicked:" + e.clientX + ":" + e.clientY + ":" + Boolean(e.isTrusted);',
      "});",
    ].join("\n"),
  ], FETCH_NONE, { keepAlive: true });
  const dispatch = run.dispatchPlatformEvent;
  assert.ok(dispatch !== undefined, "keepAlive run must expose dispatchPlatformEvent");
  dispatch(firstTagId(session, "button"), { type: "click", clientX: 42, clientY: 7 });
  assert.equal(titleText(session), "clicked:42:7:true");
});

void test("preventDefault in a click listener suppresses activation", async () => {
  const session = new FineSession(`<html><body><a id="l" href="#x">x</a></body></html>`);
  const run = await runScriptsOnSessionReal(session, [
    'document.getElementById("l").addEventListener("click", function (e) { e.preventDefault(); });',
  ], FETCH_NONE, { keepAlive: true });
  const dispatch = run.dispatchPlatformEvent;
  assert.ok(dispatch !== undefined);
  const notPrevented = dispatch(firstTagId(session, "a"), { type: "click" });
  assert.equal(notPrevented, false, "preventDefault must be reported back to the host");
});

void test("pointerdown → pointerup → click sequence all reach listeners", async () => {
  const session = new FineSession(`<html><head><title>t0</title></head><body><div id="d">zone</div></body></html>`);
  const run = await runScriptsOnSessionReal(session, [
    [
      "const seen = [];",
      'for (const t of ["pointerdown", "pointerup", "click"]) {',
      '  document.getElementById("d").addEventListener(t, function () { seen.push(t); });',
      "}",
      'document.getElementById("d").addEventListener("click", function () {',
      '  document.title = seen.join(",");',
      "});",
    ].join("\n"),
  ], FETCH_NONE, { keepAlive: true });
  const dispatch = run.dispatchPlatformEvent;
  assert.ok(dispatch !== undefined);
  const target = firstTagId(session, "div");
  dispatch(target, { type: "pointerdown", clientX: 1, clientY: 2, button: 0, buttons: 1 });
  dispatch(target, { type: "pointerup", clientX: 1, clientY: 2, button: 0, buttons: 0 });
  dispatch(target, { type: "click", clientX: 1, clientY: 2 });
  assert.equal(titleText(session), "pointerdown,pointerup,click");
});
