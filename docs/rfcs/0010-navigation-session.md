# RFC 0010: Navigation & Session — Owned History, Live Location/History, Storage Lifetime

- **Status**: Implemented
- **Depends on**: RFC 0004 (app process model), RFC 0009 (network layer)

## Problem

The tab session model is a URL list. Every navigation discards everything a
real browser keeps alive across page loads:

| Real browser invariant | Current state |
|---|---|
| One cookie jar / HTTP cache per tab | `loadPage` mints a **fresh `BrowserNetworkStack` per navigation** — the RFC-0009 jar and cache die on every click |
| `sessionStorage` persists per tab for the session | Fresh `createMemoryStorage()` per boot — dies per navigation |
| `localStorage` persists per origin | Same — fresh empty map every load |
| `history.pushState` updates URL without fetching | Static stub `{length: 1, no-ops}` |
| `location.assign/replace/reload` navigate | Frozen snapshot object; all methods are no-ops |
| `#fragment` changes scroll same-document | Full `loadPage` reload |
| `history.back()` restores scroll position | Full reload, scroll lost |
| Link clicks send `Referer` + `Sec-Fetch-*` nav headers | Document fetch carries **no initiator** — no Referer, no navigation metadata |
| History entry records the post-redirect URL | `NetworkResponse` has no `url` field; entries store the *requested* URL |
| `popstate`/`hashchange`/`pageshow`/`pagehide` | Never fired |

## Architecture

### Session-owned browsing context (`packages/app/src/session.ts`, new)

```ts
interface SessionEntry {
  readonly url: string;        // post-redirect committed URL
  readonly title: string;
  readonly scrollY: number;    // restored on traversal
  readonly state: unknown;     // pushState/replaceState payload
}

class SessionHistory {
  push(entry) / replace(entry) / traverse(delta): SessionEntry | null
  get length / get current
  // update(url, state) — pushState's synchronous visible effect
}
```

`TabSession` owns, for the life of the tab:

- **one `BrowserNetworkStack`** — jar + HTTP cache survive navigation; the
  stack is *passed into* `loadPage` instead of minted per load
- **one `sessionStorage`** — injected into every guest boot
- **shared `localStorage` registry** — `Map<origin, Storage>` owned by the
  app process (`TabHost`), so same-origin docs share storage across tabs
- **one `SessionHost` bridge** — the object guest `location`/`history`
  delegate into

### Guest↔host navigation bridge

`installBrowserGlobals` gains a `host?: SessionHost` parameter. When present,
`location`/`history` become **live objects**:

- `location.href/hash` getters read `host.currentUrl` (mutated synchronously
  by `pushState` — spec requires the visible URL update to be synchronous)
- `location.assign/href=`, `history.back/forward/go` queue a *navigation
  intent* on the host — real browsers navigate asynchronously after the
  current task, and so do we: `TabSession` drains `host.intents` after boot
  and after each `pumpFrames` cycle
- `history.pushState(state, _, url)` → synchronously updates the current
  entry's URL+state (no fetch — spec explicitly forbids loading)
- `location.reload` → reload intent
- `location.replace` → navigate intent with `replace: true`

`PageRuntime` gains `fireEvent(type, payload)` so traversal can dispatch
`hashchange`/`popstate` into the live sandbox via its `dispatchEvent`.

### Same-document fragment navigation

`navigate()` detects `stripHash(new) === stripHash(current)`:

- **no reload** — update entry URL, scroll to the anchor via
  `getBoundingClientRect(fragmentTree, anchorNode)` (finds `[id=]` /
  `a[name=]` targets), fire `hashchange` on the live runtime
- pushes a history entry per spec (fragment hops are traversable)

### Traversal semantics (no bfcache — honest boundary)

`back()/forward()` reload the entry's document **with the shared session
stack** (cookies/cache live, so it's cheap and correct), then restore
`entry.scrollY`. `history.scrollRestoration === "manual"` suppresses
restoration. Document-state traversal (pushState entries, same-doc) fires
`popstate`/`hashchange` without reloading when the target entry shares the
current document key.

### Navigation request correctness

Document loads go through the session stack with
`{destination:"document", mode:"navigate", initiator: referringUrl}` — so
RFC-0009's owned machinery finally serves navigations: Referer computed per
the *previous document's* policy, SameSite=Lax allowed on top-level nav,
`sec-fetch-user: ?1`. `NetworkResponse` gains `url` (the post-redirect hop
URL) so history commits record where the browser actually landed.

### `window.open` (HTML §7.2.2)

`sandbox.open` → `SessionHost.openWindow` (synchronous, per spec) →
`BrowsingContext.#openWindow`:

- `parseWindowFeatures` understands `popup`/`width`/`height`/`left`/`top`/
  `noopener`/`noreferrer`; `noreferrer` implies `noopener` (spec), and any
  geometry/`popup` token marks the request popup-shaped.
- `_self`/`_parent`/`_top`/named-iframe destinations route through the
  *destination's* intent queue (`sessionHost.submit` + drain) — the same
  serialization as `location.assign`, so an `open()` mid-load can never
  interleave with the load in progress.
- The return value is a real WindowProxy: for `_self` it is the realm's own
  `window` (the contextified global is pinned on the host — a host-side
  wrapper would break `===` across the vm boundary); for named/sibling
  contexts it's the cached `proxyFor` proxy; for `noopener`/`noreferrer`
  it's `null`.
- `_blank`/new traversables go to `onNewTab` as a `NewTabRequest`
  `{url, referrerPolicy, popup, width, height, name, scriptOpened, noopener}`
  over `NavState.pendingNewTabs` — the browser process spawns the tab and
  navigates with the carried `referrerPolicy` (verified: `noreferrer`
  new-tab navigations emit no `Referer`).
- An **unknown named target** creates a named traversable (HTML §7.1.2.3):
  the request carries `name`, `TabHost` registers the spawned tab under it,
  and later `window.open`/`target=` with the same name navigate that tab
  instead of opening another.
- `window.opener` on a spawned tab is a reply proxy (`postMessage` +
  `closed`) — `postMessage` JSON-clones and routes through
  `NavState.pendingPostMessages` → the browser process → `DeliverMessage`
  into the target tab's renderer; the receiver's `e.source` is the symmetric
  reply proxy, so opener↔opened messaging round-trips across workers.
  `noopener`/`noreferrer` opens ship `openerTabId: null` ⇒ `opener` is null.
- `window.close()` honors the spec's script-closable gate: only tabs spawned
  by `window.open` (`NewTabRequest.scriptOpened`, threaded through
  `workerData`) may self-close; the intent drains as
  `NavState.closeRequested` and the shell closes the tab. A normal tab's
  `window.close()` is silently ignored.

### Downloads (HTML §4.6.3, RFC 6266)

- `a[download]` on a **same-origin** target downloads instead of navigating
  (`activateLink` carries the attr as a filename hint through the intent
  layer); cross-origin `download` attrs are ignored per spec — the click
  falls through to a normal navigation.
- A document navigation whose response is `Content-Disposition: attachment`
  is consumed as a download — `loadPage`'s `onNavResponse` callback returns
  `"download"` ⇒ `null` page ⇒ no commit, no history entry (traversal to an
  attachment URL rolls its index back).
- Filename resolution: download-attr hint → `filename*`/`filename=` from the
  Content-Disposition → URL basename → `download.bin`; filesystem-unsafe
  chars sanitize to `_`. Bytes land in `downloadsDir`.
- Lifecycle events cross `NavState.pendingDownloads` to `onDownload`:
  `started` → `progress` (per 64KB chunk streamed to disk) → `completed`
  with running `bytes` and `totalBytes` (the buffered body length — undici
  hides `content-length`); a failed fetch/write reports `failed` with an
  error string instead of vanishing silently (the web-content process owns
  the network stack, so it owns the write — the notices cross back over IPC).
- Chrome surfaces: `TabHost.onDownload` feeds both the Electron log channel
  (`engineShell.onDownload` over preload IPC, status-line + log panel in
  `shell.html`) and the HTTP shell's rolling `GET /api/downloads` log.

### Session history persistence

`SessionHistory.snapshot()`/`restore()` serialize entries
(url+title+scrollY+`state` as JSON+docKey) and the cursor; `documentKey`s
remap to fresh keys on restore so same-document (pushState) grouping
survives without colliding with live keys. `ExportHistory`/`ImportHistory`
cross IPC; `TabHost.exportSession()/restoreSession()` cover every tab plus
the active index; the Electron shell writes `session.json` on `will-quit`
and restores on ready. Restore **reloads** the current entry — live page/VM
state never serializes (this is reload-restore, not SHIP serialization).

## Honest boundaries

- No bfcache: traversals reload (correct but not instant). Session state
  (cookies, cache, storage, history) is what makes it *honest* rather than
  merely fast.
- `beforeunload` cancellation (including the legacy string `returnValue`)
  consults `TabSession.confirmBeforeLeave` — the chrome hook answers the
  prompt; declining aborts navigation, traversal and reload alike. There is
  no built-in dialog UI.
- `localStorage` persists to disk when a profile dir is configured:
  `LocalStorageRegistry(persistFile)` JSON-serializes `{origin: {k: v}}`,
  written atomically (tmp+rename) on every mutation and loaded synchronously
  at construction. `TabHost({profileDir})` threads it into each renderer
  worker via `workerData`; the Electron shell maps it to `userData`.
  Multi-process writers are eventually-consistent (last flush wins) — the
  storage-authority arbitration real browsers do in the browser process is
  not modeled.
- `sessionStorage` clones across `_blank`/duplicate-tab flows:
  `SessionStorageRegistry.snapshot()`/`restore()` + `exportSessionStorage`/
  `importSessionStorage` travel over IPC (`ExportStorage`/`ImportStorage`),
  so a spawned tab starts equal to its opener then diverges (spec: the copy
  is a snapshot, not a link).
- `pushState` URL rewriting does not fetch (spec); cross-origin pushState
  targets reject per spec.
- `window.open` `_blank` across the worker boundary returns `null` — a live
  WindowProxy cannot cross IPC (the new tab is real, the returned handle is
  honestly absent). `popup`/`width`/`height` are parsed and carried to the
  shell as hints; no OS-level popup chrome positioning is modeled.
- `window.opener`/`e.source` across tabs are reply proxies exposing only
  `postMessage` + `closed` — arbitrary property access can't cross the
  process boundary (same-origin `opener.location` etc. are absent). Payloads
  are JSON-cloned, not structured-cloned, and postMessage delivery rides the
  next nav reply drain (a real browser posts to a task queue — latency, not
  ordering, differs).
- Downloads are written by the web-content process (it owns the network
  stack); progress events reflect disk-write progress of an already-buffered
  body, not wire progress (a streaming network layer is unimplemented).
  There is no download UI or pause/resume.
- History persistence serializes entries/cursor only — bfcache pages and
  nested-frame joint steps are not serializable; a restored tab reloads
  fresh documents and rebuilds its frame tree from the parent document.
