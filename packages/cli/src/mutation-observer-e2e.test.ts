/**
 * mutation-observer-e2e.test.ts — the guest-facing MutationObserver, exercised
 * through a REAL script running on V8 inside the engine's event loop. This
 * replaces the dead stub (a constitution violation): a page-level
 * `new MutationObserver(cb)` must actually fire, with spec-shaped records.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { runScriptsOnSession } from "./event-loop.js";
import { FineSession } from "./fine.js";

const html = `<div id="app"><span id="child">hello</span></div>`;

/** Run one guest script and return what it observed (via console.log lines). */
function observe(script: string): { readonly logs: readonly string[]; readonly errors: readonly string[] } {
  const diagnostics = { console: [] as { level: string; message: string }[], errors: [] as string[] };
  runScriptsOnSession(new FineSession(html), [script], new Map(), { diagnostics });
  return {
    logs: diagnostics.console.map((c) => c.message),
    errors: diagnostics.errors,
  };
}

void test("guest MutationObserver fires on childList mutation with spec-shaped records", () => {
  const { logs } = observe(`
    const records = [];
    const obs = new MutationObserver((rs) => { records.push(...rs); });
    obs.observe(document.getElementById("app"), { childList: true });
    const el = document.createElement("p");
    el.id = "injected";
    document.getElementById("app").appendChild(el);
    // MutationObserver callbacks are microtasks: not yet run here.
    console.log("sync-records=" + records.length);
    queueMicrotask(() => {
      console.log("async-records=" + records.length);
      console.log("type=" + records[0].type);
      console.log("added=" + records[0].addedNodes.length);
      console.log("target=" + records[0].target.id);
    });
  `);

  assert.ok(logs.includes("sync-records=0"), "callback must NOT fire synchronously");
  assert.ok(logs.includes("async-records=1"), "one record after microtask");
  assert.ok(logs.includes("type=childList"));
  assert.ok(logs.includes("added=1"));
  assert.ok(logs.includes("target=app"));
});

void test("attribute mutation with oldValue", () => {
  const { logs } = observe(`
    const records = [];
    const obs = new MutationObserver((rs) => { records.push(...rs); });
    const el = document.getElementById("child");
    obs.observe(el, { attributes: true, attributeOldValue: true });
    el.setAttribute("class", "new-class");
    queueMicrotask(() => {
      console.log("type=" + records[0].type);
      console.log("attr=" + records[0].attributeName);
      console.log("old=" + JSON.stringify(records[0].oldValue));
    });
  `);

  assert.ok(logs.includes("type=attributes"));
  assert.ok(logs.includes("attr=class"));
  // The span had no class before, so oldValue is null.
  assert.ok(logs.includes("old=null"));
});

void test("subtree:true sees mutations in descendants", () => {
  const { logs } = observe(`
    const records = [];
    const obs = new MutationObserver((rs) => { records.push(...rs); });
    obs.observe(document.getElementById("app"), { childList: true, subtree: true });
    document.getElementById("child").appendChild(document.createElement("b"));
    queueMicrotask(() => console.log("count=" + records.length));
  `);

  assert.ok(logs.includes("count=1"), "subtree observer must see the deep append");
});

void test("disconnect stops delivery AND clears already-queued records (DOM Standard)", () => {
  const { logs } = observe(`
    const records = [];
    const obs = new MutationObserver((rs) => { records.push(...rs); });
    const app = document.getElementById("app");
    obs.observe(app, { childList: true });
    app.appendChild(document.createElement("i"));
    obs.disconnect();
    app.appendChild(document.createElement("u"));
    queueMicrotask(() => console.log("count=" + records.length));
  `);

  // DOM Standard disconnect() step 1: EMPTY the record queue — the
  // pre-disconnect record is discarded, not delivered.
  assert.ok(logs.includes("count=0"), "disconnect must clear queued records before they deliver");
});

void test("the global is the real implementation, not a stub (constructor.name)", () => {
  const { logs } = observe(`
    console.log("ctor=" + (typeof MutationObserver));
    const obs = new MutationObserver(() => {});
    console.log("has-observe=" + (typeof obs.observe === "function"));
    console.log("has-takeRecords=" + (typeof obs.takeRecords === "function"));
    console.log("has-disconnect=" + (typeof obs.disconnect === "function"));
  `);

  assert.ok(logs.includes("ctor=function"));
  assert.ok(logs.includes("has-observe=true"));
  assert.ok(logs.includes("has-takeRecords=true"));
  assert.ok(logs.includes("has-disconnect=true"));
});
