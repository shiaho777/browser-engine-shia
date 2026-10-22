# RFC 0032 — Dedicated Workers

Status: implemented. A `new Worker(url)` in the page sandbox spawns a real
`worker_threads` worker running `packages/cli/src/dedicated-worker.ts` — a
fresh `vm` realm with the `DedicatedWorkerGlobalScope` surface. The page
side (`worker-global.ts`) is a factory installed into both runners'
sandboxes; its inbound messages arrive as tasks on the page's virtual
event loop.

## Decision

Two realms, three layers, one invariant: **worker↔page traffic never
bypasses the event loop on either side.**

### The worker realm (`dedicated-worker.ts`)

A `worker_threads` entry point. Inside the thread we build a `vm` context
exposing `self`/`globalThis` (aliased to the realm global), `postMessage`,
`close`, `onmessage`/`onerror`, `addEventListener`/`removeEventListener`,
`location.href`, `name`, `queueMicrotask`, real `setTimeout`/`setInterval`,
`fetch`, and `importScripts`.

- **The thread's own Node loop IS the worker event loop.** `parentPort`
  messages dispatch to `onmessage` + message listeners as real tasks —
  the same FIFO ordering the spec mandates, with zero reimplementation.
- **`importScripts` is genuinely blocking** — legal inside a worker.
  `data:`/`file:` URLs resolve synchronously in-thread; `http(s)` falls
  back to a `curl` subprocess (bounded by `--max-time`). Anything else
  throws, surfacing as a worker `error` event parent-side.
- **Worker `fetch` is raw undici.** The page's cookie jar, CSP, and COEP
  do NOT cross the thread boundary — honest boundary, not an oversight.

### The parent-side `Worker` (`worker-global.ts`)

`makeWorkerCtor(deps)` returns the constructor installed on the page
sandbox.

- `new Worker(url)` resolves against the document URL, then fetches the
  script through a **dedicated channel** (`fetchWorkerSource` in
  `ScriptNetworkOptions`, built by `engine-runtime`): `destination:
  "worker"`, `mode: "same-origin"`, `credentials: "same-origin"` per
  Fetch §"fetch a classic worker script", with the document's
  `initiatorCoep` — so classic worker URLs are same-origin-restricted
  and respect the page's embedder policy.
- `csp.check("worker", url)` gates the spawn (`worker-src` → `child-src`
  → `script-src` → `default-src` — the fallback chain already lives in
  `csp.ts`). A refused spawn is an async `error` event, not a
  constructor throw (spec: "fire an event named error").
- `type: "module"` throws `TypeError` honestly — module workers need the
  ESM graph inside the worker realm, a follow-up.
- `postMessage` before the thread exists queues parent-side and flushes
  on spawn (spec: messages queue as tasks on a not-yet-started loop —
  we hold the queue ourselves).
- **Inbound dispatch is a virtual-loop task**: `node.on("message")` →
  `loop.setTimeout(…, 0)` → `onmessage` + listeners. Messages surface
  only when the page pumps its loop — deterministic, and the same
  mechanism every other task uses.
- Payloads cross the port via **V8 structured clone** (worker_threads
  semantics) — real cloning, including `Map`/typed arrays; no
  transferables or DOM nodes.

### Teardown (the hard-won bit)

`node --test` keeps running while any worker thread lives; `unref()`
alone is not sufficient under the test runner. So workers register at
**construction time** (a fetch-in-flight is still a live worker) into a
per-run registry: `EventDrivenRun.disposeWorkers`, exposed through
`PageRuntime`, and `BrowsingContext.dispose()` recurses through child
contexts — the same teardown discipline RFC 0030 established for OOPIF
workers. `terminate()` marks the worker dead; dead workers drop queued
inbound tasks and accept no new posts.

## Evidence

`packages/cli/src/worker.test.ts` — 9 tests: page↔worker round-trip over
real threads, postMessage-before-spawn ordering (FIFO), importScripts of
a `data:` URL, honest failure for unreachable importScripts URLs,
worker-side `error` propagation to `onerror`, terminate dropping pending
inbound messages, worker-side timers, `worker-src` refusal as an error
event, and the honest `type:"module"` rejection.

## Honest boundaries

1. **Classic workers only.** `type:"module"` throws `TypeError`; the
   worker realm has no ESM graph.
2. **Worker `fetch` bypasses the page's network context** — no cookie
   jar, no CSP, no COEP/COOP inheritance inside the thread (raw undici).
   `importScripts` http(s) goes through `curl`, also outside the jar.
3. **No transferables / no DOM** — structured clone only.
4. `onmessage` on the page-side handle is a plain property read at
   dispatch time (no setter semantics); realm-bound event objects are
   minimal `{type, data}` — no `MessageEvent` class, no `ports`/`source`.
5. Payload objects arrive in the *other* realm's prototype context
   (structured clone crosses realms — `instanceof` on a received array
   fails across the boundary; `Array.isArray` works). Same caveat as
   cross-frame `postMessage` (RFC 0030).
6. `importScripts` failure modes: unknown schemes fail; http(s) depends
   on `curl` availability.
7. A worker cannot itself spawn a worker (no `Worker` in the worker
   realm — nested workers are a follow-up).
8. No `SharedWorker`, no `ServiceWorker` — the fetch-interception
   boundary SW requires is its own RFC.
