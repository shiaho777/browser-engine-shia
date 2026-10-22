# RFC 0029 — Mixed Content + HSTS

Status: implemented (mixed-content block/upgrade + STS store in the network stack).

## Decision

Two transport-level policies live **inside `createBrowserNetworkStack`** —
the same place CORS lives — because both must see every redirect hop and
must run before any wire byte:

- **HSTS** (RFC 6797): `Strict-Transport-Security` observed on HTTPS
  responses populates a per-stack `HstsStore`; subsequent `http:` requests
  to covered hosts upgrade to `https:` *before* the request leaves.
- **Baseline Mixed Content Level 2**: with NO CSP involved, an http
  subresource from a secure-context initiator is **blocked** when the
  destination is blockable (active content: script, style, font, iframe,
  object/embed, manifest, workers, track, `empty` for fetch/XHR/beacon) and
  **upgraded a posteriori** when optionally-blockable (image/audio/video).

`packages/guest/src/hsts.ts` is the pure-policy module: `HstsStore`,
`isPotentiallyTrustworthyUrl`, `mixedContentVerdict`.

## Ordering (the load-bearing part)

Inside `stack.request()` and again on **every redirect hop**:

1. Parse URL → compute `mode`/`credentials`/`initiator`/origin.
2. **HSTS upgrade** — `http:` + covered host → `https:` (host exact match,
   or ancestor entry carrying `includeSubDomains`; a non-ISD ancestor does
   NOT stop the upward walk).
3. **Mixed-content verdict** on the *post-upgrade* URL — so an STS-bearing
   site rescues its own `http:` subresources.
4. CORS same-origin/preflight, cache key (`requestedUrl` = upgraded URL),
   headers, transport.
5. On each live response: `https:` hop → `hsts.observe(host, STS header)`
   (RFC 6797 §8.1 — the header over insecure transport is ignored; the
   CORS preflight observes it too).

CSP composes on top unchanged: `upgrade-insecure-requests` upgrades at the
document layer before the stack sees the URL; `block-all-mixed-content`
blocks everything at that same layer. The stack's baseline then covers
destinations and paths CSP never saw (guest `fetch`, XHR, WebSocket,
redirect hops).

## Mixed-content classification

`mixedContentVerdict(url, initiator, destination, mode)`:

- Initiator must be potentially trustworthy (Secure Contexts §3.2:
  `https:`, `wss:`, `file:`, `http://localhost|127.0.0.1|[::1]`).
- Target must be `http:` **and not itself trustworthy** — `http://127.0.0.1`
  and `http://localhost` targets are exempt (this is what keeps the local
  dev-server test path working).
- `mode === "navigate"` is exempt — EXCEPT `destination === "iframe"`:
  child-frame navigations are blockable mixed content. `loadPage` declares
  `destination: "iframe"` whenever `ancestorOrigins` is set (also fixes the
  emitted `Sec-Fetch-Dest`).

## Destination wiring (the invisible half)

Subresource loads previously reached the stack with no `destination`, so a
`GET` defaulted to `mode:"navigate"` — invisible to mixed content and
wrong for `SameSite=Lax` cookies (navigations receive them). Now:

- `collectSubresourceDestinations(dom, url)` maps resolved URLs →
  `image`/`style`; `networkStackToFetchFn`'s `requestFor` hook gained a
  `destination` field.
- Resource loads default to `mode:"no-cors"`, `credentials:"include"`
  (the legacy subresource contract — SameSite rules now apply correctly
  in the jar since requests no longer masquerade as navigations).
- Classic scripts: `destination:"script"`, `no-cors`/`include`.
- Module graph (entrypoints AND deep imports): a separate
  `fetchFnModules` channel — `cors` mode + `same-origin` credentials.
- Fonts: `destination:"font"` on the existing cors-anonymous channel.
- WebSocket: `ws:` from a secure context throws TypeError in the
  `wsTransport` wrapper (sockets are never upgradable).
- Virtual transports (the Map-backed runner) enforce the same verdict
  for `fetch()` — client-side policy, no server headers needed.

## HSTS persistence

`HstsStore` is per-stack by default but injectable
(`createBrowserNetworkStack({ hsts })`) — a session/profile shares ONE
store across stacks and navigations. `serialize()`/`restore()` expose a
plain `{host: {maxAgeSeconds, includeSubDomains}}` payload so a host can
persist to disk; the engine itself ships no file format.

## Tests

`packages/guest/src/hsts.test.ts` (13): store semantics (max-age=0,
expiry, first-directive-wins, includeSubDomains walk, serialize/restore),
verdict table, and stack-level integration over stubbed `fetch`: STS
learning → later upgrade, insecure-transport STS ignored, blockable
rejection before the wire, a-posteriori image upgrade, redirect-hop
re-checks both ways, shared store across stacks.

`packages/cli/src/mixed-content.test.ts` (2): destination map + verdict.

## Honest bounds

- **No preload list** — only dynamically-learned STS entries.
- **No certificate pinning** — TLS errors surface as transport errors;
  there's no "click through" path to gate.
- `ws:`/`wss:` aren't in `mixedContentVerdict` (not http); the WS gate
  handles `ws:` blocking — `ws:` targets of *redirects* are impossible.
- `nodeFetchNetworkStack` (the bare fallback adapter) performs no HSTS —
  it's a single-transport shim, documented as such.
- HSTS applies per navigation/context session; there is no built-in
  cross-restart persistence (a host can wire `serialize`/`restore`).
- `file:`/`engine:`/virtual transports don't run the stack's HSTS.
