/**
 * Tests for the V8-backed guest runtime (task 7.6; design.md §10, §11;
 * Requirements 16.3, 16.4, 8.1).
 *
 * Built by `tsc` then run with: `node --test packages/guest/dist/*.test.js`.
 *
 * These prove the runtime:
 *   - executes guest JavaScript through the embedded V8 engine (reused via
 *     Node's `vm`) and returns completion values (Requirement 16.3, 8.1);
 *   - runs the guest in a surface-only global with NO engine internals and NO
 *     Node host objects reachable (Requirement 7.3 / 16.3);
 *   - integrates V8 Promise reactions and injected `queueMicrotask` / `setTimeout`
 *     with the event loop, draining microtasks between macrotasks
 *     (Requirement 16.4);
 *   - fails loudly (NotImplemented) on an unsupported scheduling call rather than
 *     silently no-op-ing (Requirement 5.1).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { isNotImplemented } from "@browser-engine/ir";

import { GuestRuntime } from "./runtime.js";

void test("Req 16.3/8.1: runs guest JS through V8 and returns the completion value", () => {
  const rt = new GuestRuntime();
  assert.equal(rt.evaluate("1 + 2").value, 3);
  assert.equal(rt.evaluate("'a' + 'b' + 'c'").value, "abc");
  assert.equal(rt.evaluate("[1,2,3].map(x => x * 2).join(',')").value, "2,4,6");
});

void test("Req 16.3/8.1: guest JS uses real V8 language features (closures, classes, JSON)", () => {
  const rt = new GuestRuntime();
  const source = `
    class Counter { constructor() { this.n = 0; } inc() { this.n += 1; return this.n; } }
    const c = new Counter();
    c.inc(); c.inc();
    JSON.stringify({ n: c.n });
  `;
  assert.equal(rt.evaluate(source).value, '{"n":2}');
});

void test("Req 16.3: the guest global exposes ONLY the generated web surface (Element/Document visible)", () => {
  const rt = new GuestRuntime();
  // Generated interface constructors are present on the guest global.
  assert.equal(rt.evaluate("typeof Element").value, "function");
  assert.equal(rt.evaluate("typeof Document").value, "function");
  assert.equal(rt.evaluate("typeof Node").value, "function");
  // Their prototypes carry the generated (inherited) member surface.
  assert.equal(rt.evaluate("'tagName' in Element.prototype").value, true);
  assert.equal(rt.evaluate("'appendChild' in Element.prototype").value, true); // inherited from Node
});

void test("Req 7.3/16.3: no engine-internal or Node host object is reachable from the guest", () => {
  const rt = new GuestRuntime();
  // Node host objects must be absent from the surface-only global.
  for (const name of ["require", "process", "module", "global", "Buffer", "INTERNAL"]) {
    assert.equal(rt.evaluate(`typeof ${name}`).value, "undefined", `${name} leaked into the guest`);
  }
  // The engine-internal symbol is unnameable; a guest probing for it gets nothing.
  assert.equal(rt.evaluate("typeof globalThis['engine-internal']").value, "undefined");
});

void test("Req 16.3: a generated interface is not guest-constructable (illegal constructor)", () => {
  const rt = new GuestRuntime();
  // Engine wrappers are minted by trusted code, never `new Element()` by a guest.
  const threw = rt.evaluate("(() => { try { new Element(); return false; } catch (e) { return true; } })()");
  assert.equal(threw.value, true);
});

void test("Req 16.4: V8 Promise reactions run as microtasks before a scheduled timer", () => {
  const rt = new GuestRuntime();
  // The guest records ordering into an array the host reads back after the loop.
  const source = `
    globalThis.__order = [];
    setTimeout(() => globalThis.__order.push('timeout'), 0);
    Promise.resolve().then(() => globalThis.__order.push('promise'));
    globalThis.__order.push('sync');
  `;
  rt.evaluate(source);
  rt.runEventLoop();
  const order = rt.evaluate("globalThis.__order.join(',')").value;
  // sync first (top-level), then the Promise microtask, then the timer macrotask.
  assert.equal(order, "sync,promise,timeout");
});

void test("Req 16.4: queueMicrotask integrates with the loop and runs before timers", () => {
  const rt = new GuestRuntime();
  const source = `
    globalThis.__order = [];
    setTimeout(() => globalThis.__order.push('macro'), 0);
    queueMicrotask(() => globalThis.__order.push('micro'));
  `;
  rt.evaluate(source);
  rt.runEventLoop();
  assert.equal(rt.evaluate("globalThis.__order.join(',')").value, "micro,macro");
});

void test("Req 16.4: chained Promise reactions all drain before the next macrotask", () => {
  const rt = new GuestRuntime();
  const source = `
    globalThis.__order = [];
    setTimeout(() => globalThis.__order.push('timer'), 0);
    Promise.resolve()
      .then(() => globalThis.__order.push('p1'))
      .then(() => globalThis.__order.push('p2'))
      .then(() => globalThis.__order.push('p3'));
  `;
  rt.evaluate(source);
  rt.runEventLoop();
  // The whole promise chain (microtasks) drains before the 0ms timer macrotask.
  assert.equal(rt.evaluate("globalThis.__order.join(',')").value, "p1,p2,p3,timer");
});

void test("Req 16.4: async/await resolves on the loop's microtask drain", () => {
  const rt = new GuestRuntime();
  const source = `
    globalThis.__result = null;
    (async () => {
      const a = await Promise.resolve(20);
      const b = await Promise.resolve(22);
      globalThis.__result = a + b;
    })();
  `;
  rt.evaluate(source);
  rt.runEventLoop();
  assert.equal(rt.evaluate("globalThis.__result").value, 42);
});

void test("Req 16.4: timers fire in due-time order through the runtime loop", () => {
  const rt = new GuestRuntime();
  const source = `
    globalThis.__order = [];
    setTimeout(() => globalThis.__order.push(30), 30);
    setTimeout(() => globalThis.__order.push(10), 10);
    setTimeout(() => globalThis.__order.push(20), 20);
  `;
  rt.evaluate(source);
  rt.runEventLoop();
  assert.equal(rt.evaluate("globalThis.__order.join(',')").value, "10,20,30");
});

void test("Req 5.1: a non-callable scheduling argument fails loudly (NotImplemented), not silently", () => {
  const rt = new GuestRuntime();
  try {
    rt.evaluate("queueMicrotask(42)");
    assert.fail("expected queueMicrotask(42) to throw");
  } catch (error: unknown) {
    assert.equal(isNotImplemented(error), true, "must throw the sanctioned NotImplemented");
  }
});

void test("run() evaluates then drives the loop to quiescence in one call", () => {
  const rt = new GuestRuntime();
  const source = `
    globalThis.__done = false;
    Promise.resolve().then(() => { globalThis.__done = true; });
    'started';
  `;
  const result = rt.run(source);
  assert.equal(result.value, "started");
  assert.equal(rt.evaluate("globalThis.__done").value, true);
});

void test("a syntax error in guest source surfaces from V8 (loud failure)", () => {
  const rt = new GuestRuntime();
  assert.throws(() => rt.evaluate("function ("), SyntaxError);
});

void test("the runtime exposes its event loop for host-side scheduling inspection", () => {
  const rt = new GuestRuntime();
  // No guest work scheduled ⇒ the loop has nothing pending.
  assert.equal(rt.loop.hasPending, false);
});
