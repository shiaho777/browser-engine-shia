/**
 * RFC 0042 — `SharedWorker`: one realm per (url, name), lanes are
 * MessagePort-shaped endpoints, `connect` events fire per client,
 * postMessage rides lane frames, `close()`/teardown sever lanes and the
 * last lane kills the thread. The registry is the sharing scope —
 * cross-session tests pass one registry into both sessions like a
 * browsing context's shared stack does.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { FineSession } from "./fine.js";
import { runScriptsOnSession } from "./event-loop.js";
import { CspContext, cspFromHeaders } from "./csp.js";
import { SharedWorkerRegistry } from "./shared-worker-global.js";

const PAGE = "https://example.com/app.html";
const SWURL = "https://example.com/sw.js";

async function until(pred: () => boolean, drain?: () => void, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for shared worker");
    drain?.();
    await new Promise((r) => setTimeout(r, 10));
  }
}

function session(): FineSession {
  return new FineSession("<!doctype html><title>t</title>", PAGE);
}

void test("shared worker: port round-trip via onconnect + ports[0]", async () => {
  const r = runScriptsOnSession(
    session(),
    [
      `const sw = new SharedWorker("${SWURL}");
       __got = null;
       sw.port.onmessage = (e) => { __got = e.data; };
       sw.port.postMessage({ ping: 21 });`,
    ],
    new Map([
      [
        SWURL,
        `self.onconnect = (e) => {
           const port = e.ports[0];
           port.onmessage = (m) => { port.postMessage({ pong: m.data.ping * 2 }); };
         };`,
      ],
    ]),
  );
  assert.equal(r.error, null);
  await until(() => (r.sandbox as Record<string, unknown>)["__got"] !== null, r.drain);
  assert.deepEqual((r.sandbox as Record<string, unknown>)["__got"], { pong: 42 });
  r.disposeWorkers?.();
});

void test("shared worker: two connects on (url,name) share ONE realm", async () => {
  const r = runScriptsOnSession(
    session(),
    [
      `__conns = [];
       const a = new SharedWorker("${SWURL}", "shared-name");
       const b = new SharedWorker("${SWURL}", "shared-name");
       a.port.onmessage = (e) => { __conns.push(e.data); };
       b.port.onmessage = (e) => { __conns.push(e.data); };`,
    ],
    new Map([
      [
        SWURL,
        `let n = 0;
         self.onconnect = (e) => {
           n += 1;
           e.ports[0].postMessage("connect:" + n);
         };`,
      ],
    ]),
  );
  await until(
    () => ((r.sandbox as Record<string, unknown>)["__conns"] as unknown[]).length >= 2,
    r.drain,
  );
  const conns = (r.sandbox as Record<string, unknown>)["__conns"] as unknown[];
  // Both ports saw the SAME counter — one realm, sequential connects.
  assert.equal(conns.sort().join(","), "connect:1,connect:2");
  r.disposeWorkers?.();
});

void test("shared worker: different name = different realm", async () => {
  const r = runScriptsOnSession(
    session(),
    [
      `__conns = [];
       const a = new SharedWorker("${SWURL}", "one");
       const b = new SharedWorker("${SWURL}", "two");
       a.port.onmessage = (e) => { __conns.push(e.data); };
       b.port.onmessage = (e) => { __conns.push(e.data); };`,
    ],
    new Map([
      [
        SWURL,
        `let n = 0;
         self.onconnect = (e) => {
           n += 1;
           e.ports[0].postMessage("connect:" + n);
         };`,
      ],
    ]),
  );
  await until(
    () => ((r.sandbox as Record<string, unknown>)["__conns"] as unknown[]).length >= 2,
    r.drain,
  );
  const conns = (r.sandbox as Record<string, unknown>)["__conns"] as unknown[];
  // Each realm counted its own first connect.
  assert.equal(conns.join(","), "connect:1,connect:1");
  r.disposeWorkers?.();
});

void test("shared worker: one registry shares state across two sessions", async () => {
  const registry = new SharedWorkerRegistry();
  const first = runScriptsOnSession(
    session(),
    [
      `const sw = new SharedWorker("${SWURL}");
       __got = null;
       sw.port.onmessage = (e) => { __got = e.data; };
       sw.port.postMessage("bump");`,
    ],
    new Map([
      [
        SWURL,
        `let count = 0;
         self.onconnect = (e) => {
           const port = e.ports[0];
           port.onmessage = (m) => {
             if (m.data === "bump") { count += 1; port.postMessage("count:" + count); }
           };
         };`,
      ],
    ]),
    { sharedWorkerRegistry: registry },
  );
  await until(() => (first.sandbox as Record<string, unknown>)["__got"] !== null, first.drain);
  assert.equal((first.sandbox as Record<string, unknown>)["__got"], "count:1");

  // Second session — a different "page" — same registry ⇒ same realm,
  // its counter is already 1.
  const second = runScriptsOnSession(
    session(),
    [
      `const sw = new SharedWorker("${SWURL}");
       __got = null;
       sw.port.onmessage = (e) => { __got = e.data; };
       sw.port.postMessage("bump");`,
    ],
    new Map([
      [
        SWURL,
        `unreachable — the realm is already running`,
      ],
    ]),
    { sharedWorkerRegistry: registry },
  );
  await until(() => (second.sandbox as Record<string, unknown>)["__got"] !== null, second.drain);
  assert.equal(
    (second.sandbox as Record<string, unknown>)["__got"],
    "count:2",
    "the second session's connect hit the SAME worker (count incremented)",
  );
  first.disposeWorkers?.();
  second.disposeWorkers?.();
});

void test("shared worker: unstarted port queues inbound until onmessage", async () => {
  const r = runScriptsOnSession(
    session(),
    [
      `__got = [];
       const sw = new SharedWorker("${SWURL}");
       // Worker posts immediately on connect — the port is NOT started, so
       // the message must queue; assigning onmessage starts it and flushes.
       sw.port.postMessage("ready");
       setTimeout(() => { sw.port.onmessage = (e) => { __got.push(e.data); }; }, 250);`,
    ],
    new Map([
      [
        SWURL,
        `self.onconnect = (e) => {
           const port = e.ports[0];
           port.onmessage = () => { port.postMessage("early-bird"); };
         };`,
      ],
    ]),
  );
  await until(
    () => ((r.sandbox as Record<string, unknown>)["__got"] as unknown[]).length >= 1,
    r.drain,
  );
  const got = (r.sandbox as Record<string, unknown>)["__got"] as unknown[];
  assert.equal(got.join(","), "early-bird");
  r.disposeWorkers?.();
});

void test("shared worker: closing the last lane tears the realm down", async () => {
  const registry = new SharedWorkerRegistry();
  const r = runScriptsOnSession(
    session(),
    [
      `const sw = new SharedWorker("${SWURL}");
       __open = null;
       sw.port.onmessage = (e) => { __open = e.data; };
       sw.port.postMessage("hi");
       __sw = sw;`,
    ],
    new Map([[SWURL, `self.onconnect = (e) => { e.ports[0].onmessage = () => e.ports[0].postMessage("alive"); };`]]),
    { sharedWorkerRegistry: registry },
  );
  await until(() => (r.sandbox as Record<string, unknown>)["__open"] !== null, r.drain);
  assert.equal(registry.size, 1, "one live instance while the lane is open");

  // Close the only lane → the worker should be torn down and evicted.
  const sw = (r.sandbox as Record<string, unknown>)["__sw"] as { port: { close(): void } };
  sw.port.close();
  await until(() => registry.size === 0, undefined, 2000);
  r.disposeWorkers?.();
});

void test("shared worker: worker-src CSP refusal is an async error event", async () => {
  const policies = cspFromHeaders({ "content-security-policy": "worker-src 'none'" });
  const r = runScriptsOnSession(
    session(),
    [
      `const sw = new SharedWorker("${SWURL}");
       __err = null;
       sw.onerror = (e) => { __err = e.message || "err"; };`,
    ],
    new Map([[SWURL, `self.onconnect = () => {};`]]),
    { csp: new CspContext(policies, PAGE) },
  );
  await until(() => (r.sandbox as Record<string, unknown>)["__err"] !== null, r.drain);
  assert.match(String((r.sandbox as Record<string, unknown>)["__err"]), /worker-src/i);
  r.disposeWorkers?.();
});

void test("shared worker: type:module is rejected honestly (boundary)", () => {
  const r = runScriptsOnSession(
    session(),
    [
      `try { new SharedWorker("${SWURL}", { type: "module" }); __err = "no-throw"; }
       catch (e) { __err = e.name; }`,
    ],
    new Map([[SWURL, "1;"]]),
  );
  assert.equal((r.sandbox as Record<string, unknown>)["__err"], "TypeError");
  r.disposeWorkers?.();
});
