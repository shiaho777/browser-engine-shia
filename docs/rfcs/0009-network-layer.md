# RFC 0009: The Network Layer — Owned Redirects, HTTP Cache, Cookie SameSite, Referrer-Policy

- **Status**: Implemented
- **Depends on**: RFC 0004 (app process model), RFC 0007 (image codecs)

## Context

`BrowserNetworkStack` already reuses undici/curl for transport with a cookie jar
and browser-like headers — but the *protocol semantics* on top are shallow in
four places that matter to real sites:

1. **Redirects are a black box.** `curl -L` / undici `redirect:"follow"` follow
   hops internally, so the stack cannot (a) re-derive headers per hop — the
   curl path forwards the ORIGIN's `Cookie`/`Authorization` to the redirect
   target host, a real credential leak; (b) store `Set-Cookie` against the hop
   URL that emitted it; (c) honor `Set-Cookie` on intermediate hops at all in
   the fetch path.
2. **No HTTP cache.** Every subresource refetches unconditionally; `ETag` /
   `Last-Modified` / `Cache-Control` are ignored and the loader even sends
   `Cache-Control: no-cache` hardcoded.
3. **Cookies lack SameSite and host-only.** A `Set-Cookie` without `Domain` is
   stored suffix-matchable → host cookies leak to subdomains. `cookieHeader`
   has no initiator → `SameSite=Lax` (the modern default) rides cross-site
   subresource requests it must not.
4. **Referrer-Policy is unread.** Every request leaks the full page URL as
   `Referer` regardless of `<meta name=referrer>` or per-element
   `referrerpolicy`.

## Design

### A. The redirect loop is OURS (network.ts)

`request()` runs a per-hop loop (cap 20, matching undici's default):

```
hop: headers = buildHeaders(req, hopUrl, {initiator})
     → transport (curl --max-redirs 0 / fetch redirect:"manual")
     → store Set-Cookie against hopUrl
     → 3xx + Location? → resolve next hop, rewrite method
       (301/302/303 → GET unless the method was already GET/HEAD-safe;
        307/308 preserve method+body), strip Cookie/Authorization/
        Referer when origin changes, push hop event, loop.
```

Both transports lose their internal redirect following — semantics are uniform
and observable in `events` (per-hop entries).

### B. HttpCache (guest/http-cache.ts)

GET/HEAD only. Freshness per RFC 9111 §4.2–4.3:

- `Cache-Control: max-age`, `s-maxage`, `no-store`, `no-cache`,
  `must-revalidate`, `private`; `Expires` fallback; heuristic freshness
  (10% of `Date − Last-Modified`) when no explicit directive.
- Stale hits revalidate: `ETag` → `If-None-Match`, `Last-Modified` →
  `If-Modified-Since`; a `304` refreshes stored headers and returns the cached
  body (event `status: 304` recorded as served-from-cache).
- `Vary`: entries key on `(url, sorted vary header values)`; `Vary: *` never
  caches.
- The loader's hardcoded `Cache-Control: no-cache` request header is deleted —
  it forced unconditional revalidation against our own semantics.

### C. Cookies: host-only + SameSite (cookie-jar.ts)

- `StoredCookie` gains `hostOnly` (no `Domain=` attribute → exact host match
  only — fixes the subdomain leak) and `sameSite` (`lax|strict|none`;
  `none` requires `Secure` per spec, else treated as `lax`).
- `cookieHeader(url, {initiator})` — cross-site requests carry only
  `SameSite=None`+Secure cookies; Lax additionally allowed when the request is
  a top-level navigation (`initiator.mode === "navigate"`). `Strict` never
  crosses sites. Passing no initiator keeps legacy same-site-anywhere
  behavior — call sites opt in.

### D. Referrer-Policy (network.ts + loader)

`NetworkRequest.referrerPolicy` + `NetworkRequest.initiator` (the page URL).
Default policy `strict-origin-when-cross-origin`. Supported:
`no-referrer`, `no-referrer-when-downgrade`, `origin`,
`origin-when-cross-origin`, `same-origin`, `strict-origin`,
`strict-origin-when-cross-origin`, `unsafe-url`. Document default policy
comes from the response's `Referrer-Policy` **header** first, then
`<meta name=referrer>` (header wins — it's the later-specified signal and
a server override the document can't veto); the committed value caches on
the context (`#docPolicy`) and rides every navigation that lacks an
element-level override. Per-element attrs: `a[referrerpolicy]` on links,
`form[referrerpolicy]` / submitter `formreferrerpolicy` on submissions
(the submitter wins — HTML §4.10.21), `iframe[referrerpolicy]` on child
document loads, and `window.open(url,"_blank","noreferrer")` features.
The loader reads both and passes them through.

### E. `X-Content-Type-Options: nosniff` (network.ts)

For `destination: "style"|"script"` a `nosniff` response whose `Content-Type`
is not `text/css` / a JavaScript MIME respectively rejects as a network error —
the Fetch spec block, not a silent pass.

## Non-goals

- CORS enforcement, CSP, Mixed-Content blocking, HSTS pinning — security
  policy layers that need their own RFCs.
- Range requests, streaming bodies, HTTP/2 prioritization, service workers.
- Cache persistence across processes (the cache is per-session, in-memory).
- `SameSite=Lax`+POST 2-minute grace, partitioned cookies (CHIPS).

## Verification

Local `node:http` servers only — zero external network:

- redirect: method rewrite matrix, cross-origin credential strip, per-hop
  Set-Cookie storage, `manual`/`error` modes, loop cap.
- cache: `max-age` hit without re-request, `ETag`→`If-None-Match`→304 body
  reuse, `no-store`/`no-cache`/`Vary` behavior, heuristic freshness.
- cookies: host-only subdomain non-leak, SameSite=Lax/Strict/None across
  same-site vs cross-site initiators.
- referrer: policy matrix including `strict-origin-when-cross-origin`
  default and cross-origin trimming.
- nosniff: style/script refusal, pass-through for correct types.
- Existing fetch/cookie suites keep passing.
