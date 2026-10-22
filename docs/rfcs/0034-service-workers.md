# RFC 0034 — Service Workers: scope-keyed interception inside the network stack

Status: implemented. `navigator.serviceWorker.register()` fetches the script
through the page's own network stack, spawns a real `worker_threads` realm
(`sw-realm.ts`), and drives install → activate through `waitUntil`. Every
controlled client's requests — navigations and subresources alike — dispatch
a `fetch` event to the worker; `respondWith` answers with a real
`NetworkResponse`, and `caches`/`clients`/`skipWaiting` are live. The
interception point is INSIDE `BrowserNetworkStack.request()` — the same
seam HSTS/CORS/COEP already share.

## Decision

**One invariant: the fetch-event seam sits after the request-level gates
and before the HTTP cache — a SW can synthesize or cache-answer a request,
but it can never launder one past the security gates.**

### The seam (`guest/network.ts`)

`BrowserNetworkOptions.serviceWorker` accepts a `ServiceWorkerInterceptor`:

```ts
handle(req, networkFetch) → Promise<NetworkResponse | null>
```

Consulted after URL parse, HSTS upgrade, mixed-content, same-origin and
COEP mode checks — and **before** `cache.lookup`/the redirect loop. A non-
null return IS the response (recorded in `events`, returned verbatim); null
falls through to the normal wire path. `networkFetch` re-enters
`request()` with `skipServiceWorker: true` — the worker's own `fetch()`
passes every gate (CORS for cross-origin, cookies per credentials mode)
but can never intercept itself.

### The realm (`cli/sw-realm.ts`)

A `worker_threads` entry in the RFC 0032 mold, but the global is a
`ServiceWorkerGlobalScope`:

- **Events**: `addEventListener`/`on*` for `install`, `activate`, `fetch`,
  `message`. `ExtendableEvent.waitUntil` tracks lifetime promises (nested
  waits settle too); `FetchEvent.respondWith` accepts a `Response` (or a
  promise of one) — anything else falls through to the wire.
- **`fetch`** loop-backs to the parent (`swFetch` message → registry →
  `networkFetch`), so the realm shares the page's cookie jar/CORS/COEP
  semantics rather than raw undici — the deliberate divergence from
  RFC 0032's worker fetch.
- **`caches`**: real CacheStorage semantics — named `Cache`s with
  `match`/`put`/`add`(via the loopback fetch)/`delete`/`keys`, `caches.open`
  /`match`/`keys`/`has`/`delete`. In-thread storage: lives as long as the
  worker realm lives (boundary — no persistence across realms).
- **`Request`/`Response`/`Headers`**: real clones (`clone()`, `text()`,
  `json()`, `arrayBuffer()`, header normalization) — the fetch event hands
  a `Request` built from the intercepted request's wire shape.
- **`registration`** carries `scope`; `skipWaiting()`/`clients.claim()`
  resolve immediately (no incumbent-worker waiting state exists to skip);
  `clients.matchAll()` returns known clients.
- `importScripts` shares the dedicated-worker's blocking loader.

### The registry (`cli/service-worker.ts`)

`ServiceWorkerRegistry` is created per network stack
(`createPageNetwork`/`TabSession`) — **registrations survive navigations
inside the tab**, and a shared registry passed in shares them across
stacks.

- `register(scriptURL, {scope})`: same-origin checks on script and scope;
  default scope = the script's directory. Script bytes come through the
  page's stack (`destination:"serviceworker"`, `mode:"same-origin"` —
  already-marked `skipServiceWorker`). Then spawn → `evaluated` →
  `install` dispatch → `installed` → `activating` → `activate` dispatch →
  `activated`. Re-registering the same script+scope returns the live
  registration.
- **Scope match**: longest-prefix `scope` match on the client URL —
  `origin`-keyed map, `startsWith` per RFC 3986 path-prefix semantics.
- **Control**: a client is controlled when an *activated* registration's
  scope covers its URL — navigations key on the request URL, subresources
  on the `initiator` URL (documented approximation: real clients are
  controlled only if claimed-at-load; ours behave as if `claim()` ran).
- **Teardown**: `registry.dispose()` (from `TabSession.dispose`) marks
  workers redundant, rejects pending dispatches, terminates threads —
  same discipline as RFC 0030/0032.

### The container (`createServiceWorkerContainer`)

`navigator.serviceWorker` in the page sandbox:

- `register(url, {scope})` → resolves to a `{scope, active}` registration
  face after activation completes.
- `controller` — the active `ServiceWorker` handle (`postMessage` →
  `message` event in the realm) or `null`.
- `ready` — resolves when a registration covers this page (polled through
  the page's event loop).
- `addEventListener("message")`/`onmessage` — `Client.postMessage` from
  the worker arrives as a real task on the page's loop (`postTask` is the
  virtual loop for classic runs, real timers for the module runner).
- `getRegistration(url)`.

Classic and module runs install the same container — a module script can
`register` just like a classic one. OOPIF workers get their own stacks →
own registries (registrations are per-stack, per-origin-keyed).

## Evidence

`packages/app/src/service-worker.test.ts` — 3 tests over a real
double-stack HTTP server:

1. `register("/sw.js")` → `install`/`activate` both fire with `waitUntil`
   honored; `reg.scope` = script directory; `controller` non-null post-
   activation; `fetch("/data.txt")` returns the SW's synthesized
   `Response("sw-synthetic")` — the wire body never reaches the page.
2. Navigation interception: a second `loadPage` to an in-scope URL gets
   the SW's `Response` HTML (`title` = "sw-nav"), plus the install-time
   `caches.put` answers a later `fetch("/asset.txt")` with the cached
   body and the wire counter stays at 0.
3. Scope isolation: registered under `/scoped/`, the top-level page is
   uncontrolled (`controller === null`) and its `fetch` hits the wire.

## Honest boundaries

1. **Control model is `claim()`-always** — any active registration covers
   matching clients immediately; the registering page is controlled right
   away (spec requires reload or an explicit `clients.claim()` — which we
   implement as an always-effective no-op).
2. **No update lifecycle** — `installing`/`waiting` faces are `null`,
   `updatefound`/`statechange`/`controllerchange` events don't fire, byte-
   identical re-registration dedups but a CHANGED script under an existing
   scope replaces it wholesale rather than waiting for tabs to close.
   `unregister()` is a stub.
3. **`caches` is per-realm and in-memory** — no disk persistence, no
   cross-worker sharing, no request `ignoreSearch`/`ignoreMethod` options.
4. **No background events** — `push`, `sync`, `notificationclick`,
   `messageerror`, `contentdelete` don't exist; `fetch`/`message`/
   `install`/`activate` only.
5. **`clients.matchAll()`/`openWindow`/`get()`** are minimal — claim
   resolves, matchAll returns the empty list (window clients aren't
   modeled as addressable objects).
6. `FetchEvent` has `request`/`clientId`/`respondWith`/`waitUntil` — no
   `handled`, `preloadResponse`, `resultingClientId`, `replacesClientId`,
   `isReload`.
7. **Scope matching is string-prefix** — spec's `/`-boundary and URL-
   canonical edge cases aren't modeled beyond `startsWith` on the href.
8. Responses synthesized by the SW skip the redirect-loop's per-hop
   CORS/COEP re-verification — the request was already gated pre-seam;
   the response itself is treated as the fetch result (browsers treat
   SW responses per their `Response.type`; we don't model opaque/
   cors/opaqueredirect response types).
9. Worker threads stay unref'd; teardown is explicit
   (`registry.dispose`/`TabSession.dispose`) — the `node --test` hang
   discipline from RFC 0030/0032 applies.
10. The registry is per stack (per tab). Sharing across tabs requires
    passing one `ServiceWorkerRegistry` to `createPageNetwork` — the API
    supports it; the default is per-tab isolation.
