# RFC 0031 — COEP / COOP / CORP, credentialless, origin-keyed agent clusters

Status: implemented. The policy layer is pure (`packages/guest/src/coep.ts`);
enforcement lives in the network stack (per-hop, like CORS/HSTS); document
state lands on `FineSession.isolation`; the COOP opener-severing pair check
runs inside document boot — before any opened-document script observes
`window.opener`.

## Decision

Three header-driven policies converge on one invariant: **every cross-origin
fetch hop can be gated by the response it carries, and every opener link can
be severed before the opened document's first script runs.**

### `coep.ts` — pure policy

- `Coep` = `unsafe-none` | `require-corp` | `credentialless`;
  `Coop` = `unsafe-none` | `same-origin` | `same-origin-allow-popups` |
  `noopener-allow-popups`; `Corp` = `same-origin` | `same-site` |
  `cross-origin`. Parsers are total: unknown/absent ⇒ the unsafe default
  (COEP/COOP) or `null` (CORP — absence is itself meaningful).
- `corpAllows(corp, requestOrigin, resourceOrigin)` — Fetch §CORP check.
  Absent header defaults to `same-origin`. `same-site` compares scheme +
  last-two-labels host tail (no PSL — honest boundary).
- `coepApplies(mode, destination)` — COEP gates `no-cors` fetches and
  `destination:"iframe"` navigations only. CORS requests authorize via
  CORS itself; top-level navigations are exempt.
- `coopSeversOpenerLink(myCoop, otherCoop, sameOrigin, otherIsPopup)` —
  the HTML §7.1.3.1 compatibility table, evaluated once per direction.
- `crossOriginIsolated(coep, coop)` — `same-origin` ∧ (`require-corp` ∨
  `credentialless`); `same-origin-allow-popups` is deliberately NOT
  isolating (spec: it permits cross-origin popups it can't gate).

### Stack integration (`network.ts`)

`NetworkRequest.initiatorCoep` carries the DOCUMENT's COEP into every
fetch. Inside `request()`:

1. `hopCredentialsAllowed()` — `credentialless` strips credentials on
   cross-origin hops of gated requests (jar cookies AND caller
   `Authorization`/`Cookie`/`Proxy-Authorization` headers via the same
   `buildHeaders` gate `credentials:"omit"` uses). Same-origin hops stay
   credentialed — credentialless anonymizes the foreign hop, nothing else.
2. Per redirect hop: `require-corp` ⇒ `corpAllows(parseCorp(headers))`
   must hold for that hop's response. A CORP-less final hop rejects the
   whole request even when earlier hops were clean — same discipline as
   per-hop ACAO for CORS.
3. `destination:"iframe"` under `require-corp` additionally requires the
   CHILD's own `Cross-Origin-Embedder-Policy` to be non-`unsafe-none`
   (the embedder's isolation can't be relaxed by its child).

### Document state (`fine.ts` + `engine-runtime.ts`)

`DocumentIsolation { coep, coop, originAgentCluster, crossOriginIsolated }`
— a plain field, not an incremental input (isolation doesn't feed the
cascade). `bootFineSession` parses `cross-origin-embedder-policy`,
`cross-origin-opener-policy`, `origin-agent-cluster` from
`responseHeaders` **before** any resource fetch or script — headers are the
only COEP/COOP carrier (no `<meta>` support, matching the spec).

### COOP severing — the pair check has two moments

- **Open time** (TabHost): `NewTabRequest` now carries `openerOrigin` +
  `openerCoop`; `openInNewTab` forwards them as `openerInfo` through the
  web-content worker's `workerData` into `BrowsingContext` deps.
- **Response time** (`bootFineSession`): once THIS document's COOP parses,
  `coopSeversOpenerLink` runs in both directions (opener's coop vs mine,
  mine vs opener's — the popup bit is "the opened context is a popup").
  A severed link nulls `sessionHost.openerTabId` — the sandbox installs
  `window.opener` from that field **at context build**, which happens after
  boot ⇒ the very first opened-document script already sees `null`.

A `same-origin` document therefore always opens into its own browsing
context group when paired cross-origin — matching Chrome/Firefox behavior
without a process-model dependency in the checker.

### Sandbox globals (`event-loop.ts`)

`window.crossOriginIsolated`, `window.originAgentCluster`,
`window.isSecureContext` — installed at context build from
`session.isolation` + `isPotentiallyTrustworthyUrl`. Read-only, present
before any script.

### Plumbing coverage

- Subresources: `networkStackToFetchFn` contexts carry `initiatorCoep` —
  the document's own COEP is only known post-header-parse, so
  `page.ts`'s resource channel reads it through a lazy `coepRef` flipped
  by `onAfterClassic`; the pre-boot stylesheet preload reads it directly
  from `navHeaders`.
- Scripts: classic (`no-cors`/`include`) and module (`cors`/`same-origin`)
  channels both forward `session.isolation.coep`.
- Guest `fetch`/`XHR`: `networkStackToBrowserFetch` takes `initiatorCoep`
  so `fetch()` inside an isolated document is gated identically.
- Iframes: `#loadOneChild` passes the embedder's `page.coep` as
  `initiatorCoep` on the child navigation — in-process AND OOPIF paths
  (the OOPIF worker receives it over the `load` message).
- IPC: `NavState` carries `coep`/`coop`/`crossOriginIsolated`/
  `originAgentCluster` for chrome surfaces; `NewTabRequest` carries the
  opener identity described above. Codecs regenerated.

## Evidence

- `guest/coep.test.ts` — 14 tests: parsers, `corpAllows` matrix, the full
  COOP table, `coepApplies`, `crossOriginIsolated`, stack-level require-corp
  accept/reject, per-redirect-hop enforcement, credentialless jar+header
  stripping (cross-origin vs same-origin), iframe COEP-inheritance rule.
- `app/coep-coop.test.ts` — 9 tests: headers → `PageState` isolation fields;
  `crossOriginIsolated`/`originAgentCluster`/`isSecureContext` sandbox
  globals; COOP sever before first script (host + guest observation);
  same-origin pairing retention; `noopener-allow-popups` popup bit;
  real-server `loadPage` end-to-end; a `require-corp` document's CORP-less
  cross-origin `<img>` never lands.

## Honest boundaries

1. `same-site` = last-two-labels approximation (no Public Suffix List).
2. COOP severing models `window.opener`/return-value semantics; real
   browsing-context-group reuse (a severed group holding only its own
   documents) isn't separately enumerated — each top-level context is its
   own unit anyway.
3. `Origin-Agent-Cluster` is observational: site isolation is already
   origin-keyed for every frame, so the hint changes nothing behaviorally.
4. `credentialless` strips cookies/authorization on gated cross-origin
   hops; real Chrome also suppresses the HTTP cache credential dimension —
   our cache keys don't partition on it.
5. `COEP: credentialless` doesn't exempt CORS-mode fetches (they authorize
   via CORS — correct per spec, worth stating since it's surprising).
6. Report-only variants of these headers are not parsed (CSP has
   report-only; COEP/COOP report-only exists in real browsers — a follow-up).
7. The iframe COEP-inheritance check requires the child's OWN header; the
   spec's `credentialless`-child relaxation isn't modeled (conservative).
