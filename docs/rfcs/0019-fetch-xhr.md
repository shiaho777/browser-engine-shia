# RFC 0019 — Guest fetch + XMLHttpRequest

Status: implemented (core surface, with documented simplifications)
Packages: `guest` (`fetch-api.ts` — spec-shaped classes + shared facade),
`cli` (both event-loop runners + esm-runner + XHR installer), `guest`
(`network.ts` — NetworkStack adapter)

## Decision

One shared fetch facade — `makeFetchApi(baseUrl)` — produces the guest
realm's own `Headers`/`Request`/`Response`/`ReadableStream` classes plus a
`makeFetch(core)` that normalizes arguments into a `NormalizedRequest`,
hands it to an injected transport `core`, and wraps the `RawFetchResult`
back into a real `Response`. Every runner (virtual `runScriptsOnSession`,
real `runScriptsOnSessionReal`, `esm-runner`) uses the same bundle, and the
sandbox classes and the runner's fetch impl share ONE api instance so
`new Request(...)` round-trips through `fetch()` with `instanceof` intact.

### Why a facade over a transport core

Three runners, three transports, one spec surface:

- **Virtual runner** — the `resources` map. `fetchFn` stays a virtual-loop
  `deferred` for deterministic scheduling; it now resolves
  `api.responseFromRaw(...)` instead of a hand-rolled response-shaped
  object.
- **Real runner** — the `browserFetch` hook when provided (app/webview
  path), else the low-level `fetchFn(url) → bytes` decoder. Both produce
  `RawFetchResult` (`adaptResponseLike` for structural stubs, direct bytes
  otherwise).
- **ESM runner** — same facade; its budget/seal/low-value-module filters
  stay as core-level policy, returning an empty `RawFetchResult` instead
  of reaching the transport.

Because `fetch()` is `api.makeFetch(core)`, request normalization
(base-URL resolution, method whitelist, GET/HEAD body rejection, header
merging, Request-from-Request cloning, body byte extraction) is shared —
guest-visible semantics can't drift between runners.

### Why realm-bound error constructors

vm realms have their own `TypeError`/`RangeError`; a host-constructed
error fails `e instanceof TypeError` inside guest code (a real WPT-style
check). `api.bindRealmErrors()` is called once per context after
`vm.createContext` with the realm's intrinsics; all API-thrown errors use
them. Node's vm realm has no `DOMException` intrinsic, so the
guest-package class is installed as the sandbox `DOMException` global —
`e instanceof DOMException` holds for XHR `InvalidStateError` and fetch
`AbortError` alike.

### Why `Thenable` grew `reject()`

The virtual loop's `Thenable` documented "never rejects" — acceptable when
the only fetch semantics needed were resolve-or-{ok:false}. Real fetch
rejects on transport failure and abort (Fetch §4.3/§4.4), XHR needs
rejection to choose `error` over `load`, and guest `await` needs the
rejection to propagate through `then`/`catch`/`finally` chains and across
the host-microtask boundary (`await thenable` registers both handlers via
a PromiseResolveThenableJob). `reject(reason)` + per-handler
`onFulfilled`/`onRejected` propagation brings it in line.

## Mechanism

### The classes (`guest/fetch-api.ts`)

- **Headers** — insertion-ordered entry list; `append` combines with
  `", "` on `get`, `set` replaces, `getSet`/`getSetCookie` return raw
  per-entry values (`set-cookie` never combines — Fetch §5.2); accepts
  tuples, records, and `entries()`/`forEach()`/iterable inits.
- **Request** — base-URL resolution (constructor errors are synchronous,
  before async); method whitelist (`CONNECT`/`TRACE`/`TRACK` → TypeError);
  Request-from-Request inheritance for method/headers/body (init
  overrides); GET/HEAD+body → TypeError; auto `content-type` for string
  bodies; `bodyBytes` captured for the transport; `signal` retained for
  abort plumbing.
- **Response** — status/`ok` (200–299)/statusText/url/redirected/`type`;
  body `BodyState` is one-shot — `text()`/`json()`/`arrayBuffer()`/
  `formData()`/`blob()` set `bodyUsed`, a second consume rejects
  TypeError; `clone()` tees the byte buffer so both read; `body` is a real
  `ReadableStream` (getReader/read/done); statics `error()`/`redirect()`/
  `json()`.
- **responseFromRaw** — lifts a `RawFetchResult` (status/statusText/url/
  headers/body/redirected/type) into a Response; `type` defaults to
  `basic`/`cors` by same-origin check against the document base.
- **makeFetch(core)** — sync normalization (a malformed call throws
  synchronously, matching the platform); core promise resolves through
  `responseFromRaw`; a core REJECTION becomes a realm `TypeError` (Fetch
  §4.2 "network error"); a pre-aborted or mid-flight-abort signal rejects
  `AbortError` DOMException (races the core via signal listener).
- **adaptResponseLike(res, fallbackUrl)** — lifts a structural response
  ({status, url, headers, text/json/arrayBuffer}) to `RawFetchResult`;
  headers enumerated via `entries()`/`Symbol.iterator`/`forEach`, plain
  records iterated directly, and get/has-only facades probed against the
  common-name list (documented bound — unknown custom names are
  invisible to probing).

### XMLHttpRequest (shared installer, `event-loop.ts`)

Built ON the sandbox `fetch` — same transport, so HTTP semantics
(redirect/cookie/referrer policies owned by the stack) apply identically:

- `open(method, url, async)` — URL resolves against the document base;
  `async:false` → `InvalidAccessError` (sync XHR unsupported, honestly).
- `setRequestHeader`/`send` state gating → realm `DOMException`
  `InvalidStateError`; request headers + body forwarded into the fetch
  init (asserted end-to-end against `browserFetch`).
- Response: `status`/`statusText`/`responseURL`; response headers held
  for `getResponseHeader`/`getAllResponseHeaders` (`entries()` when the
  response's Headers exposes them — the shared facade's always do).
- `readyState` marches 1→2→3→4 with `readystatechange` per state,
  `progress`, `load`, `loadend` — event order matches the spec pipeline.
- **Load vs error**: ANY received HTTP response completes `load` (404 is
  a response); transport rejection completes `error`; `abort()` emits
  `abort`+`loadend`, resets to UNSENT, and suppresses the in-flight
  resolution (`sendFlag` checked on both settle paths); `timeout` aborts
  via `AbortController` and emits `timeout` when it wins the race.
- `responseType`: `""`/`text`/`json` consume `text()`;
  `arraybuffer`/`blob` consume `arrayBuffer()` — a single consumption per
  response (the body is one-shot; the earlier text-then-bytes path threw
  "body already consumed" — found by the test).
- `upload` is a real listener target (receives `load`/`loadend` after a
  send with body); no synthetic progress bytes — progress events fire
  without byte counts (honest).

### Wiring

- `installBrowserGlobals(sandbox, href, …, fetchApi?)` creates-or-reuses
  the api bundle, installs the four classes (only if absent — external
  sandboxes keep their own), and returns the api so the caller's fetch
  impl shares the class set. `installEventTarget` receives it for the
  legacy grab-bag path.
- After `vm.createContext`, all three runners bind realm intrinsics:
  `bindRealmErrors({TypeError, RangeError, DOMException})` and
  `sandbox.DOMException` (guest class when the realm lacks the intrinsic).
- `networkStackToBrowserFetch` (guest/network.ts) is the app's real wire:
  forwards method/headers/body/mode/initiator/referrerPolicy into
  `NetworkStack.request` and returns `api.responseFromRaw` — a genuine
  guest `Response` whose `url` is the LAST redirect hop.

## Boundary (honest)

- `Request.redirect`/`cache`/`integrity`/`priority`/`keepalive` are
  parsed-and-carried, not enforced — redirect policy lives in the stack's
  hop loop; no fetch-metadata `sec-fetch-*` gating from JS init.
- `ReadableStream` is a minimal spec shell (single-chunk `getReader`/
  `read`/`done`, locked check) — no tee/pipeThrough/transform; `Response`
  bodies are already-buffered bytes, not live sockets.
- `FormData` body encoding is urlencoded-only; `multipart/form-data`
  decode throws `NotImplemented("dom-api:formData:multipart")`.
- `credentials:"omit"` can't retract cookie-jar state; `mode:"no-cors"`
  produces no `opaque` response type.
- Response `type` is inferred (`basic`/`cors`/`error`) not negotiated per
  spec's fetch metadata.
- XHR: no `responseXML` (stays `null`), no upload progress byte counts,
  `timeout` races the transport — a faster response wins (correct); sync
  XHR is rejected by design.
- A get/has-only response facade can only surface the common probed
  header names; enumerable headers (entries/iterator/record) surface
  fully.

## Rollback / compat

`Thenable.reject` is additive; prior resolve-only consumers are
unaffected. The old stub `XMLHttpRequest` in `esm-runner` and the
response-shaped objects in both runners are deleted — guest code holding
`Response`/`Request`/`Headers` class refs now gets the shared spec-shaped
set; `fetch()` return type changed from response-like-object to true
`Response` (a superset surface).
