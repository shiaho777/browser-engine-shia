# RFC 0042 — SharedWorker (lanes into a shared realm)

Phase 5 leftover, landed after Phase 6. `new SharedWorker(url, name)`
connects a **lane** — a MessagePort-shaped endpoint — into a shared
`worker_threads` realm keyed on `(resolvedUrl, name)`. This RFC adds the
MessagePort semantics the platform lacked: before it, no port primitive
existed anywhere in the engine.

## Model

```
page A ── new SharedWorker(u,"x") ──► registry.connect(u,"x") ──► lane 0
page B ── new SharedWorker(u,"x") ──► registry.connect(u,"x") ──► lane 1
                                        │ same instance
                                        ▼
                         worker_threads: shared-worker.js
                         SharedWorkerGlobalScope { self, onconnect,
                         addEventListener("connect"), importScripts, … }
                         per lane: port { postMessage, start, close,
                                          onmessage, addEventListener }
```

Wire protocol over `parentPort`:

| frame | direction | meaning |
|---|---|---|
| `{t:"connect", lane}` | parent → worker | fire `connect` event, `e.ports[0]` = lane port |
| `{t:"msg", lane, data}` | both | deliver to that lane's port (queued if unstarted) |
| `{t:"close", lane}` | parent → worker | client severed the port |
| `{t:"closed", lane}` | worker → parent | worker-side `port.close()` |

Ordering invariant: a lane's `connect` frame always precedes its `msg`
frames — outbound posts queue in `pendingOut` until spawn+connect has
been posted (the second-connect bug this RFC's test suite caught: a later
client's `postMessage` raced ahead of its own `connect`).

## Sharing scope

`SharedWorkerRegistry` maps `(url, name)` → instance and is carried on
the network stack (`stack.sharedWorkers`, an opaque attachment the stack
never reads — `createPageNetwork` binds one; `TabSession` binds its own
alongside the SW registry). Because a browsing context's context tree —
iframes included — shares `BrowsingContext.#network`, same-origin iframes
and navigations within the tab automatically share worker realms, and the
registry outlives each page's session like spec says.

Absent a supplied registry (harness paths), each session boot falls back
to a fresh per-session registry — intra-page `new SharedWorker` sharing
still works.

## Port semantics (both sides implemented identically)

- Unstarted port **queues** inbound messages; `start()` or assigning
  `onmessage` opens it and flushes — tested both directions.
- `addEventListener("message")` does NOT start the port (spec quirk,
  mirrored in both realms).
- `port.close()` → `{t:"close"}` → the lane's worker-side port goes inert;
  `SharedWorkerRegistry.laneClosed` terminates the thread and evicts the
  instance when the last lane dies.
- Session teardown (`disposeWorkers`) closes the page's lanes without
  killing a worker other contexts still hold — lanes are refcounted.

## Fetch / policy

- Script bytes ride `destination:"sharedworker"`, `mode:"same-origin"`,
  `credentials:"same-origin"` through the page's network stack
  (`sec-fetch-dest: sharedworker` on the wire) — a new
  `fetchSharedWorkerSource` channel parallel to the dedicated-worker one.
- `worker-src` CSP gates construction — refusal is an async `error` event
  on the SharedWorker object (never a throw), same as RFC 0032.
- `type:"module"` throws TypeError honestly (no worker ESM graph yet).

## Boundaries (honest)

- Sharing is scoped to a **stack/context tree** — two independent
  `loadPage` calls with independent stacks do not share; profile-wide
  sharing is a caller-provided shared `SharedWorkerRegistry` away.
- No `MessageChannel`/`window.postMessage`-port machinery for documents —
  ports exist only as SharedWorker lanes (a `MessageChannel` global is a
  separate feature).
- No transferables, no nested SharedWorker-spawning-SharedWorker (the
  worker realm has no `SharedWorker` global), no `name`-only registry
  lookup APIs.
- `credentials` option parsed but unused (stack fetches with same-origin
  credentials — spec default — `"include"` divergence undocumented in
  spec terms here).
- Cross-origin worker URLs inherit the dedicated-worker behavior: the
  `mode:"same-origin"` script channel fails them (load error → error
  event); there is no separate SecurityError ctor throw.

## Evidence

`shared-worker.test.ts` 8/8 — port round-trip through `onconnect`/
`ports[0]`; two same-key connects share one realm (sequential counter);
different `name` isolates; **two sessions + one registry share worker
state** (the cross-page invariant); unstarted-port queue flush on
`onmessage`; last-lane teardown evicts the instance; CSP refusal is an
async error event; `type:"module"` boundary throws.
