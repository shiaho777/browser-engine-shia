/**
 * RFC 0032 — dedicated `Worker`: real worker_threads realms. Under test:
 * postMessage round-trips (both directions), pre-spawn message queueing,
 * `importScripts`, `terminate`, `onerror`, CSP `worker-src` gating, and
 * async work inside the worker (its own timers).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { FineSession } from "./fine.js";
import { runScriptsOnSession } from "./event-loop.js";
import { CspContext, cspFromHeaders } from "./csp.js";

const PAGE = "https://example.com/app.html";
const WORKER = "https://example.com/w.js";

/** Wait until `pred` holds — the worker runs on a real thread, so each poll
 *  also drains the virtual loop (inbound worker messages are loop tasks). */
async function until(pred: () => boolean, drain?: () => void, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for worker");
    drain?.();
    await new Promise((r) => setTimeout(r, 10));
  }
}

function session(html = "<!doctype html><title>t</title>"): FineSession {
  return new FineSession(html, PAGE);
}

void test("worker round-trip: page→worker→page over real threads", async () => {
  const s = session();
  const r = runScriptsOnSession(
    s,
    [
      `const w = new Worker("${WORKER}");
       __got = null;
       w.onmessage = (e) => { __got = e.data; };
       w.postMessage({ ping: 21 });`,
    ],
    new Map([
      [WORKER, `self.onmessage = (e) => { self.postMessage({ pong: e.data.ping * 2 }); };`],
    ]),
  );
  assert.equal(r.error, null);
  await until(() => (r.sandbox as Record<string, unknown>)["__got"] !== null, r.drain);
  r.drain?.();
  assert.deepEqual((r.sandbox as Record<string, unknown>)["__got"], { pong: 42 });
  r.disposeWorkers?.();
});

void test("postMessage before the worker spawns is queued, not dropped", async () => {
  const s = session();
  const r = runScriptsOnSession(
    s,
    [
      `const w = new Worker("${WORKER}");
       __msgs = [];
       w.postMessage("first");
       w.postMessage("second");
       w.onmessage = (e) => { __msgs.push(e.data); };`,
    ],
    new Map([
      [WORKER, `self.onmessage = (e) => { self.postMessage("saw:" + e.data); };`],
    ]),
  );
  await until(() => ((r.sandbox as Record<string, unknown>)["__msgs"] as unknown[]).length >= 2, r.drain);
  r.drain?.();
  // `__msgs` is a REALM array (vm context) — deepStrictEqual compares
  // prototypes across realms; compare the joined contents instead.
  const msgs = (r.sandbox as Record<string, unknown>)["__msgs"] as unknown[];
  assert.equal(msgs.join(","), "saw:first,saw:second", "FIFO order preserved");
  r.disposeWorkers?.();
});

void test("importScripts of a URL the worker can't reach fails honestly", async () => {
  const s = session();
  const r = runScriptsOnSession(
    s,
    [
      `const w = new Worker("${WORKER}");
       __err = null;
       w.onerror = (e) => { __err = e.message || "err"; };`,
    ],
    new Map([
      // The resource map is a PARENT-side channel — a worker thread can't
      // see it; importScripts must error, not silently succeed.
      [WORKER, `importScripts("https://nonexistent.invalid/lib.js");`],
    ]),
  );
  await until(() => (r.sandbox as Record<string, unknown>)["__err"] !== null, r.drain);
  r.drain?.();
  const err = String((r.sandbox as Record<string, unknown>)["__err"]);
  assert.match(err, /importScripts|fetch/i);
  r.disposeWorkers?.();
});

// importScripts over a data: URL — the channel the worker CAN read.
void test("importScripts over a data: URL works synchronously in-thread", async () => {
  const s = session();
  const lib = `data:text/javascript,${encodeURIComponent("self.libValue = 'lib-ok';")}`;
  const r = runScriptsOnSession(
    s,
    [
      `const w = new Worker("${WORKER}");
       __got = null;
       w.onmessage = (e) => { __got = e.data; };`,
    ],
    new Map([
      [WORKER, `importScripts(${JSON.stringify(lib)});
        self.postMessage(self.libValue);`],
    ]),
  );
  await until(() => (r.sandbox as Record<string, unknown>)["__got"] !== null, r.drain);
  r.drain?.();
  assert.equal((r.sandbox as Record<string, unknown>)["__got"], "lib-ok");
  r.disposeWorkers?.();
});

void test("worker error propagates to onerror", async () => {
  const s = session();
  const r = runScriptsOnSession(
    s,
    [
      `const w = new Worker("${WORKER}");
       __err = null;
       w.onerror = (e) => { __err = e.message || "err"; };`,
    ],
    new Map([[WORKER, `throw new Error("worker-boom");`]]),
  );
  await until(() => (r.sandbox as Record<string, unknown>)["__err"] !== null, r.drain);
  r.drain?.();
  const err = (r.sandbox as Record<string, unknown>)["__err"];
  assert.match(String(err), /worker-boom/);
});

void test("terminate drops pending inbound messages", async () => {
  const s = session();
  const r = runScriptsOnSession(
    s,
    [
      `const w = new Worker("${WORKER}");
       __msgs = [];
       w.onmessage = (e) => { __msgs.push(e.data); };
       w.postMessage("go");
       w.terminate();`,
    ],
    new Map([[WORKER, `self.onmessage = () => { self.postMessage("late"); };`]]),
  );
  // Give the (now dead) worker a beat — nothing should arrive.
  await new Promise((r2) => setTimeout(r2, 300));
  r.drain?.();
  assert.equal(
    ((r.sandbox as Record<string, unknown>)["__msgs"] as unknown[]).length,
    0,
    "terminated worker's pending messages never dispatch",
  );
  r.disposeWorkers?.();
});

void test("worker timers run on the worker's own loop", async () => {
  const s = session();
  const r = runScriptsOnSession(
    s,
    [
      `const w = new Worker("${WORKER}");
       __got = null;
       w.onmessage = (e) => { __got = e.data; };`,
    ],
    new Map([
      [WORKER, `setTimeout(() => self.postMessage("fired"), 20);`],
    ]),
  );
  await until(() => (r.sandbox as Record<string, unknown>)["__got"] !== null, r.drain);
  r.drain?.();
  assert.equal((r.sandbox as Record<string, unknown>)["__got"], "fired");
  r.disposeWorkers?.();
});

void test("worker-src CSP: a refused spawn surfaces as an error event", async () => {
  const s = session();
  const policies = cspFromHeaders({ "content-security-policy": "worker-src 'none'" });
  const r = runScriptsOnSession(
    s,
    [
      `const w = new Worker("${WORKER}");
       __err = null;
       w.onerror = (e) => { __err = e.message || "err"; };`,
    ],
    new Map([[WORKER, `self.postMessage("never");`]]),
    { csp: new CspContext(policies, PAGE) },
  );
  await until(() => (r.sandbox as Record<string, unknown>)["__err"] !== null, r.drain);
  r.drain?.();
  const err = String((r.sandbox as Record<string, unknown>)["__err"]);
  assert.match(err, /worker-src/i);
  r.disposeWorkers?.();
});

void test("type:module is rejected honestly (boundary)", () => {
  const s = session();
  const r = runScriptsOnSession(
    s,
    [
      `try { new Worker("${WORKER}", { type: "module" }); __err = "no-throw"; }
       catch (e) { __err = e.name; }`,
    ],
    new Map([[WORKER, "1;"]]),
  );
  r.drain?.();
  assert.equal((r.sandbox as Record<string, unknown>)["__err"], "TypeError");
  r.disposeWorkers?.();
});
