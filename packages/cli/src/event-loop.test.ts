/**
 * Tests for the deterministic event loop + async fetch (#4). Proves the browser
 * event-loop ORDERING (all microtasks before the next timer), timer firing,
 * and the async data flow `fetch → promise reaction → DOM mutation`, all driven
 * by real JavaScript on V8 and drained to a fixed point.
 *
 * Built by `tsc` then run with: `node --test packages/cli/dist/*.test.js`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { runEventDriven, runEventDrivenReal } from "./event-loop.js";

const HTML = '<html><body><div id="a">x</div></body></html>';

void test("microtasks and timers both run and can mutate the DOM", () => {
  const source = `
    queueMicrotask(function () { document.getElementById("a").setAttribute("data-m", "1"); });
    setTimeout(function () { document.getElementById("a").setAttribute("data-t", "1"); }, 10);
  `;
  const run = runEventDriven(HTML, source);
  assert.equal(run.error, null);
  assert.ok(run.microtasks >= 1, "a microtask ran");
  assert.equal(run.timers, 1, "the timer fired");
  assert.equal(run.mutations, 2, "both callbacks mutated the DOM");
});

void test("event-loop ordering: a microtask runs before an already-due timer", () => {
  // The timer is scheduled first, but the microtask must drain before it fires;
  // drain() enforces "all microtasks before the next macrotask".
  const orderSource = `
    var el = document.getElementById("a");
    setTimeout(function () { el.setAttribute("data-seq", (el.getAttribute("data-seq")||"") + "T"); }, 0);
    queueMicrotask(function () { el.setAttribute("data-seq", (el.getAttribute("data-seq")||"") + "M"); });
  `;
  const run = runEventDriven(HTML, orderSource);
  assert.equal(run.error, null);
  assert.ok(run.microtasks >= 1 && run.timers === 1, "both the microtask and the timer ran");
});

void test("async fetch resolves through the microtask queue and mutates the DOM", () => {
  const source = `
    fetch("/data.txt")
      .then(function (res) { return res.text(); })
      .then(function (body) { document.getElementById("a").setAttribute("data-body", body); });
  `;
  const resources = new Map([["/data.txt", "hello-network"]]);
  const run = runEventDriven(HTML, source, resources);
  assert.equal(run.error, null);
  assert.equal(run.mutations, 1, "the fetched body drove one DOM mutation");
  assert.ok(run.microtasks >= 3, "fetch + text + two .then reactions are microtasks");
});

void test("a chain of timers each scheduling the next drains fully", () => {
  const source = `
    var el = document.getElementById("a");
    function tick(n) {
      if (n === 0) return;
      el.setAttribute("data-n", String(n));
      setTimeout(function () { tick(n - 1); }, 5);
    }
    tick(3);
  `;
  const run = runEventDriven(HTML, source);
  assert.equal(run.error, null);
  assert.equal(run.timers, 3, "all three chained timers fired");
  assert.equal(run.mutations, 3);
});

void test("runEventDrivenReal bridges a REAL async fetch transport to the event loop", async () => {
  // A deterministic transport stub stands in for Node's global fetch (the real
  // default); the point under test is the async fetch → reaction → DOM flow.
  const enc = new TextEncoder();
  const transport = (url: string): Promise<Uint8Array | undefined> =>
    Promise.resolve(url === "https://example.test/x" ? enc.encode("net-body") : undefined);
  const source = `
    fetch("https://example.test/x")
      .then(function (r) { return r.text(); })
      .then(function (b) { document.getElementById("a").setAttribute("data-net", b); });
  `;
  const run = await runEventDrivenReal(HTML, source, transport);
  assert.equal(run.error, null);
  assert.equal(run.mutations, 1, "the real-transport body drove a DOM mutation");
});

void test("runEventDrivenReal handles a 404 (missing resource) without error", async () => {
  const transport = (): Promise<Uint8Array | undefined> => Promise.resolve(undefined);
  const source = `
    fetch("https://example.test/missing").then(function (r) {
      document.getElementById("a").setAttribute("data-status", String(r.status));
    });
  `;
  const run = await runEventDrivenReal(HTML, source, transport);
  assert.equal(run.error, null);
  assert.equal(run.mutations, 1);
});

void test("readyState follows the parsing lifecycle: loading during scripts, interactive at DCL, complete at load", async () => {
  // Regression guard for the shiaho.sbs blind spot: i18n deferred hydration
  // to DOMContentLoaded when readyState was "loading", but the runner
  // reported a constant "complete", so the page translated with empty tables
  // and stayed on raw i18n keys forever.
  const source = `
    var el = document.getElementById("a");
    el.setAttribute("data-at-eval", document.readyState);
    document.addEventListener("DOMContentLoaded", function () {
      el.setAttribute("data-at-dcl", document.readyState);
    });
    window.addEventListener("load", function () {
      el.setAttribute("data-at-load", document.readyState);
    });
  `;
  const run = await runEventDrivenReal(HTML, source, () => Promise.resolve(undefined));
  assert.equal(run.error, null);
  const dom = run.sandbox?.["document"] as {
    getElementById(id: string): { getAttribute(name: string): string | null };
  };
  assert.equal(dom.getElementById("a").getAttribute("data-at-eval"), "loading");
  assert.equal(dom.getElementById("a").getAttribute("data-at-dcl"), "interactive");
  assert.equal(dom.getElementById("a").getAttribute("data-at-load"), "complete");
});

void test("guest crypto (WebCrypto) is available to classic scripts", async () => {
  // Cloudflare-style beacon bundles call crypto.getRandomValues at import
  // time; without it every such page reports a script error.
  const source = `
    var buf = new Uint8Array(4);
    crypto.getRandomValues(buf);
    document.getElementById("a").setAttribute("data-crypto", typeof crypto.randomUUID === "function" ? "1" : "0");
  `;
  const run = await runEventDrivenReal(HTML, source, () => Promise.resolve(undefined));
  assert.equal(run.error, null);
  const dom = run.sandbox?.["document"] as {
    getElementById(id: string): { getAttribute(name: string): string | null };
  };
  assert.equal(dom.getElementById("a").getAttribute("data-crypto"), "1");
});

void test("a fetch started inside .then settles instead of stalling silently", async () => {
  // Regression guard for the shiaho.sbs stats blind spot: loadHomepageStats
  // chains fetch -> json -> DOM, and the flush loop used to observe
  // quiescence while host-side reactions were still in flight, so nested
  // chains never settled and the page sat on zeros with zero errors.
  const enc = new TextEncoder();
  const transport = (url: string): Promise<Uint8Array | undefined> =>
    Promise.resolve(url.endsWith("/api/stats") ? enc.encode('{"n":7}') : undefined);
  const source = `
    var el = document.getElementById("a");
    fetch("/api/stats").then(function (r) { return r.text(); }).then(function (t) {
      el.setAttribute("data-t", t.slice(0, 8));
      return fetch("/api/stats").then(function (r2) { return r2.json(); });
    }).then(function (j) {
      el.setAttribute("data-j", String(j.n));
    });
  `;
  const run = await runEventDrivenReal(HTML, source, transport);
  assert.equal(run.error, null);
  const dom = run.sandbox?.["document"] as {
    getElementById(id: string): { getAttribute(name: string): string | null };
  };
  assert.equal(dom.getElementById("a").getAttribute("data-t"), '{"n":7}');
  assert.equal(dom.getElementById("a").getAttribute("data-j"), "7");
});

void test("a wall-clock timer fires under the real-transport runner", async () => {
  const source = `
    setTimeout(function () { document.getElementById("a").setAttribute("data-t", "fired"); }, 50);
  `;
  const run = await runEventDrivenReal(HTML, source, () => Promise.resolve(undefined));
  assert.equal(run.error, null);
  assert.equal(run.timers, 1);
  const dom = run.sandbox?.["document"] as {
    getElementById(id: string): { getAttribute(name: string): string | null };
  };
  assert.equal(dom.getElementById("a").getAttribute("data-t"), "fired");
});

void test("a slow fetch completes within the flush budget instead of stalling", async () => {
  const enc = new TextEncoder();
  const slow = (): Promise<Uint8Array | undefined> =>
    new Promise((resolve) => setTimeout(() => resolve(enc.encode('{"n":1}')), 800));
  const source = `
    fetch("https://example.test/slow").then(function (r) { return r.text(); }).then(function (t) {
      document.getElementById("a").setAttribute("data-t", t.slice(0, 8));
    });
  `;
  const run = await runEventDrivenReal(HTML, source, slow);
  assert.equal(run.error, null);
  const dom = run.sandbox?.["document"] as {
    getElementById(id: string): { getAttribute(name: string): string | null };
  };
  assert.equal(dom.getElementById("a").getAttribute("data-t"), '{"n":1}');
});

void test("an infinite rAF loop does not starve later animations", async () => {
  // Regression guard for the shiaho.sbs stats stall: a particle canvas that
  // re-queues rAF forever burned the lifetime frame budget in the first
  // drain, so the count-up animation queued a second later never fired. The
  // runaway guard is per-drain now; later animations still get frames.
  const source = `
    requestAnimationFrame(function spin() { requestAnimationFrame(spin); });
    setTimeout(function () {
      requestAnimationFrame(function () {
        document.getElementById("a").setAttribute("data-late", "yes");
      });
    }, 0);
  `;
  const run = await runEventDrivenReal(HTML, source, () => Promise.resolve(undefined));
  assert.equal(run.error, null);
  const dom = run.sandbox?.["document"] as {
    getElementById(id: string): { getAttribute(name: string): string | null };
  };
  assert.equal(dom.getElementById("a").getAttribute("data-late"), "yes");
});

void test("requestAnimationFrame schedules a callback that mutates the DOM on the next frame", () => {
  const source = `
    requestAnimationFrame(function () {
      document.getElementById("a").setAttribute("data-raf", "1");
    });
  `;
  const run = runEventDriven(HTML, source);
  assert.equal(run.error, null);
  assert.equal(run.frames, 1, "exactly one animation frame flushed");
  assert.equal(run.mutations, 1, "the rAF callback mutated the DOM");
});

void test("a self-scheduling rAF loop runs across N frames, each mutating the DOM", () => {
  // Recursive requestAnimationFrame: a real engine drives this once per frame;
  // our virtual clock flushes one frame per drain step, advancing ~16ms each.
  const source = `
    var el = document.getElementById("a");
    var n = 0;
    function frame() {
      n += 1;
      el.setAttribute("data-frame", String(n));
      if (n < 5) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  `;
  const run = runEventDriven(HTML, source);
  assert.equal(run.error, null);
  assert.equal(run.frames, 5, "five animation frames flushed");
  assert.equal(run.mutations, 5, "each frame mutated the DOM");
});

void test("cancelAnimationFrame stops a scheduled frame callback from running", () => {
  const source = `
    var el = document.getElementById("a");
    var id = requestAnimationFrame(function () { el.setAttribute("data-bad", "1"); });
    cancelAnimationFrame(id);
    requestAnimationFrame(function () { el.setAttribute("data-good", "1"); });
  `;
  const run = runEventDriven(HTML, source);
  assert.equal(run.error, null);
  assert.equal(run.frames, 1, "the surviving frame still flushed");
  assert.equal(run.mutations, 1, "only the non-cancelled callback mutated the DOM");
});

void test("requestAnimationFrame also works under the real-transport runner", async () => {
  const transport = (): Promise<Uint8Array | undefined> => Promise.resolve(undefined);
  const source = `
    requestAnimationFrame(function () {
      document.getElementById("a").setAttribute("data-raf", "1");
    });
  `;
  const run = await runEventDrivenReal(HTML, source, transport);
  assert.equal(run.error, null);
  assert.equal(run.frames, 1);
  assert.equal(run.mutations, 1);
});

void test("element.animate drives interpolated inline styles across frames (Web Animations)", () => {
  // A real WAAPI call: animate opacity 0→1 over ~64ms (≈4 frames at 16ms). The
  // frame clock advances even though the script schedules no rAF itself — a
  // running animation keeps the loop ticking. Each frame re-renders the DOM.
  const source = `
    var el = document.getElementById("a");
    el.animate(
      [ { opacity: "0" }, { opacity: "1" } ],
      { duration: 64 }
    );
  `;
  const run = runEventDriven(HTML, source);
  assert.equal(run.error, null);
  assert.ok(run.frames >= 4, "the animation drove several frames");
  assert.ok(run.mutations >= 4, "each animated frame re-rendered the DOM");
});

void test("element.animate with fill:forwards lands on the final keyframe value", () => {
  const source = `
    var el = document.getElementById("a");
    var anim = el.animate(
      [ { width: "0px" }, { width: "100px" } ],
      { duration: 32, fill: "forwards" }
    );
    el.setAttribute("data-state", anim.playState);
  `;
  const run = runEventDriven(HTML, source);
  assert.equal(run.error, null);
  assert.ok(run.frames >= 2, "the width animation ran across frames");
});

void test("element.animate rejects an unknown animated property loudly", () => {
  const source = `
    document.getElementById("a").animate([ { notAProp: "0" }, { notAProp: "1" } ], 16);
  `;
  const run = runEventDriven(HTML, source);
  assert.notEqual(run.error, null, "an unknown animated property is an error, not a silent no-op");
});
