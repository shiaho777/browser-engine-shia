# RFC 0012: bfcache — Retained Pages for Instant Traversal

- **Status**: Implemented
- **Depends on**: RFC 0010 (navigation/session)

## Problem

Session traversal reloads the document every time (RFC 0010's stated honest
boundary). A real browser keeps recently-left pages **alive** — DOM, guest
runtime, scroll, form state — so `back()` is a restoration, not a reload:

| Real browser | Current state |
|---|---|
| Back-forward cache retains the last few pages | `loadPage` re-fetches/re-parses/re-runs scripts on every traversal |
| `pageshow`/`pagehide` carry `persisted` | Neither event exists |
| Guest state survives (timers merely paused) | Runtime discarded — a form's typed text, expanded state, and JS heap are gone |

Re-running scripts on traversal is not just slow — it is **observably wrong**:
`pageshow.persisted` never fires, and any mutation the guest made is lost.

## Design

### Entry-attached retention

`SessionEntry` gains an optional retained `PageState`. On a cross-document
navigation the outgoing page — DOM, `PageRuntime` (guest heap + pending
timers), decoded images — is stashed into its entry:

- `history.stashPage(page)` attaches; `history.takePage()` detaches on hit.
- **Cap 3** (LRU-evict oldest stashed). Evicted/missing ⇒ the existing
  reload path runs — retention is an optimization over the RFC 0010 behavior,
  never a semantic change.
- Retention requires a live runtime (`keepAlive` pages); static loads are
  reload-on-traverse as before.

### Traversal with restore

`#traverseSession` cross-document branch: `takePage()` hit ⇒ adopt the page,
fire `pageshow {persisted: true}`, repaint at `entry.scrollY`, drain intents.
Miss ⇒ unchanged reload + `pageshow {persisted: false}` post-load.

`navigate()`/`reload()`/`loadHtml` dispatch `pagehide {persisted}` before
leaving (matching the retention decision), and `pageshow` after a fresh load
— so guest code sees the full lifecycle pair either way.

`beforeunload` precedes every cross-document leave (`SessionHistory` peeks
the traversal target before committing the index): a canceled event — via
`preventDefault()` or the legacy string `returnValue` — consults
`confirmBeforeLeave`; a decline aborts the navigation/traversal/reload with
history untouched. The check recurses into child contexts (a frame that
vets the leave holds the whole tab).

Guest timers of a retained page simply aren't pumped while it isn't active —
the correct pause semantics fall out of "only the active page is pumped".

## Honest boundaries

- No `Cache-Control: no-store` eligibility check (the document response's
  headers are not plumbed to the session); cap-and-evict bounds cost instead.
- `unload`-listener eviction heuristics are not modeled.
- Retention is per-tab memory; nothing is serialized.
- A retained page's timers do not fire while cached — same observable deferral
  as real bfcache, though by absence of pumping rather than a freezer.

## Tests

Traverse → same `PageState` object (identity), `pageshow.persisted=true` in
guest, scroll restored, zero network requests for the restore; eviction past
cap falls back to reload; `pagehide` fires on leave; guest DOM mutations
survive a back→forward round trip.
