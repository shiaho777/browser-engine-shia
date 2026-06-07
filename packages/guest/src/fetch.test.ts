/**
 * Tests for real guest `fetch` over the reused networking stack (task 7.7;
 * design.md §11, §2 bug#4; Requirements 16.5, 16.7, 8.1, 5.1, 5.4).
 *
 * Built by `tsc` then run with: `node --test packages/guest/dist/*.test.js`.
 *
 * These prove the constitution's "delete the v0 stub" requirement:
 *   - guest `fetch` issues a REAL request through the injected stack and resolves
 *     with the genuine status + body (Requirement 16.5) — never a hard-coded 404
 *     or any fabricated response;
 *   - an unimplemented/unsupported path (non-HTTP(S) scheme, malformed argument,
 *     missing host fetch) throws {@link NotImplemented}, not a silent placeholder
 *     (Requirements 16.7, 5.1, 5.4);
 *   - the default stack delegates to the reused host `fetch` (undici/TLS) —
 *     verified through an injected fake that records the delegated call.
 *
 * To stay deterministic and offline, the guest runtime is driven with an
 * in-memory {@link NetworkStack} double; the default `nodeFetchNetworkStack` is
 * exercised separately against an injected `fetch` spy (no real network I/O).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { isNotImplemented } from "@browser-engine/ir";

import { createGuestFetch } from "./fetch.js";
import { nodeFetchNetworkStack, type NetworkRequest, type NetworkResponse, type NetworkStack } from "./network.js";
import { GuestRuntime } from "./runtime.js";

/** A deterministic in-memory stack: routes by URL to canned responses. */
function memoryStack(routes: Record<string, NetworkResponse>): NetworkStack & { calls: NetworkRequest[] } {
  const calls: NetworkRequest[] = [];
  return {
    calls,
    request(req: NetworkRequest): Promise<NetworkResponse> {
      calls.push(req);
      const route = routes[req.url];
      if (route === undefined) {
        return Promise.resolve({ status: 404, ok: false, headers: {}, body: new Uint8Array() });
      }
      return Promise.resolve(route);
    },
  };
}

function textResponse(body: string, status = 200): NetworkResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { "content-type": "text/plain" },
    body: new TextEncoder().encode(body),
  };
}

// ---------------------------------------------------------------------------
// Guest fetch through the runtime (end-to-end across the V8 boundary).
// ---------------------------------------------------------------------------

void test("Req 16.5: guest fetch resolves with the REAL status and body from the stack", async () => {
  const stack = memoryStack({ "https://example.com/hello": textResponse("hi there") });
  const rt = new GuestRuntime({ networkStack: stack });
  rt.evaluate(`
    globalThis.__out = null;
    (async () => {
      const r = await fetch("https://example.com/hello");
      globalThis.__out = r.status + "|" + r.ok + "|" + (await r.text());
    })();
  `);
  await rt.settle();
  assert.equal(rt.evaluate("globalThis.__out").value, "200|true|hi there");
  // The request genuinely went through the stack (not a fabricated response).
  assert.equal(stack.calls.length, 1);
  assert.equal(stack.calls[0]!.url, "https://example.com/hello");
});

void test("Req 16.5: guest fetch surfaces a real 404 (not a stubbed-out success)", async () => {
  const stack = memoryStack({}); // every route 404s.
  const rt = new GuestRuntime({ networkStack: stack });
  rt.evaluate(`
    globalThis.__status = null;
    (async () => {
      const r = await fetch("https://example.com/missing");
      globalThis.__status = r.status + ":" + r.ok;
    })();
  `);
  await rt.settle();
  // The 404 is the stack's genuine answer, surfaced honestly — the OPPOSITE of
  // v0's "fetch hard-coded to 404 masquerading as working".
  assert.equal(rt.evaluate("globalThis.__status").value, "404:false");
});

void test("Req 16.5: guest fetch can POST a body and read JSON back", async () => {
  const stack = memoryStack({
    "https://api.example.com/echo": {
      status: 200,
      ok: true,
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode('{"ok":true,"n":42}'),
    },
  });
  const rt = new GuestRuntime({ networkStack: stack });
  rt.evaluate(`
    globalThis.__n = null;
    (async () => {
      const r = await fetch("https://api.example.com/echo", { method: "POST", body: "ping" });
      const j = await r.json();
      globalThis.__n = j.n;
    })();
  `);
  await rt.settle();
  assert.equal(rt.evaluate("globalThis.__n").value, 42);
  assert.equal(stack.calls[0]!.method, "POST");
  assert.deepEqual(stack.calls[0]!.body, new TextEncoder().encode("ping"));
});

void test("Req 16.4/16.5: a synchronously-queued microtask runs before the fetch resolves", async () => {
  const stack = memoryStack({ "https://example.com/x": textResponse("done") });
  const rt = new GuestRuntime({ networkStack: stack });
  rt.evaluate(`
    globalThis.__order = [];
    fetch("https://example.com/x").then(() => globalThis.__order.push("fetch"));
    queueMicrotask(() => globalThis.__order.push("microtask"));
  `);
  await rt.settle();
  // The synchronously-queued microtask runs before the network completion.
  assert.equal(rt.evaluate("globalThis.__order.join(',')").value, "microtask,fetch");
});

// ---------------------------------------------------------------------------
// Loud failures (Requirements 16.7, 5.1, 5.4): no silent stub anywhere.
// ---------------------------------------------------------------------------

void test("Req 5.1: a non-URL fetch argument throws NotImplemented synchronously (no silent coercion)", () => {
  const stack = memoryStack({});
  const fetchFn = createGuestFetch(stack);
  // A malformed call must fail loudly at call time, not resolve to a fake value.
  // (The synchronous arg normalisation throws BEFORE any promise is created.)
  assert.throws(() => {
    void fetchFn(42);
  }, (error: unknown) => isNotImplemented(error));
  assert.equal(stack.calls.length, 0, "a malformed call must not reach the network stack");
});

void test("Req 16.7/5.4: the default stack rejects a non-HTTP(S) scheme with NotImplemented", async () => {
  // The default (reused) stack must not silently handle unsupported schemes.
  await assert.rejects(
    () => nodeFetchNetworkStack.request({ url: "ftp://example.com/file" }),
    (error: unknown) => isNotImplemented(error) && error.feature.startsWith("network:scheme:"),
  );
});

void test("Req 16.7/5.4: the default stack rejects a non-absolute URL with NotImplemented", async () => {
  await assert.rejects(
    () => nodeFetchNetworkStack.request({ url: "/relative/path" }),
    (error: unknown) => isNotImplemented(error),
  );
});

// ---------------------------------------------------------------------------
// Req 8.1: the default stack DELEGATES to the reused host fetch (undici/TLS).
// ---------------------------------------------------------------------------

void test("Req 8.1: the default stack delegates to the host's reused fetch (undici/TLS)", async () => {
  // Inject a fake global fetch to prove delegation WITHOUT real network I/O:
  // the default stack must call the host fetch, not reimplement HTTP itself.
  const original = (globalThis as { fetch?: typeof fetch }).fetch;
  let calledUrl: string | null = null;
  (globalThis as { fetch?: unknown }).fetch = (url: string) => {
    calledUrl = url;
    return Promise.resolve(
      new Response(new TextEncoder().encode("reused"), {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );
  };
  try {
    const response = await nodeFetchNetworkStack.request({ url: "https://example.com/reuse" });
    assert.equal(calledUrl, "https://example.com/reuse");
    assert.equal(response.status, 200);
    assert.equal(new TextDecoder().decode(response.body), "reused");
  } finally {
    (globalThis as { fetch?: unknown }).fetch = original;
  }
});

void test("createGuestFetch issues exactly one stack request per call", async () => {
  const stack = memoryStack({ "https://example.com/once": textResponse("ok") });
  const fetchFn = createGuestFetch(stack);
  const response = await fetchFn("https://example.com/once");
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ok");
  assert.equal(stack.calls.length, 1);
});
