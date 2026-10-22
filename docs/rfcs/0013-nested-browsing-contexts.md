# RFC 0013: Nested Browsing Contexts — iframes as Real Documents

- **Status**: Implemented
- **Depends on**: RFC 0010 (session), RFC 0011 (activation), RFC 0012 (bfcache)

## Problem

`<iframe>` parses and lays out as an inert block — no child document is ever
fetched, `contentWindow`/`frames`/`parent` don't exist, and a frame's
fallback children render inline (wrong: frame children are *fallback*). The
frame tree — the structure every real site's third-party embeds, docs, and
ads depend on — is absent.

## Design

### BrowsingContext — the shared core

The per-context machinery TabSession grew (history, host, navigate, traverse,
bfcache, intent drain) extracts into `BrowsingContext`; `TabSession` holds the
**root** context plus viewport/focus/hit-testing, and each `<iframe>` owns a
nested `BrowsingContext`. Same code, same semantics — no parallel frame
machinery to drift.

A child context shares the tab's **network stack** (one jar, one cache — an
iframe's cookies are the tab's cookies) and **storage registries**
(sessionStorage becomes origin-keyed per tab: same-origin frames share,
cross-origin isolate — per HTML §11.2).

### Child lifecycle (async — like real browsers)

After a document loads, iframe elements are discovered; each spawns a child
load (`src`, `srcdoc`, else `about:blank`) into a context sized to the iframe's
laid-out content box (default intrinsic 300×150, `width`/`height` attrs and
CSS honored — iframe joins the replaced-element path). The parent paints
**first** with the frame area blank; when a child finishes, its rendered frame
bitmap composites into the parent's next paint via `imageOf(node)` — real
browsers do exactly this (frame content pops in, then composites).

- `load` fires on the `<iframe>` element after child boot.
- `sandbox` without `allow-scripts` ⇒ child runs scriptless.
- Recursion handled (a child's own iframes nest further); **depth-capped** so
  `src=self` terminates.

### Guest surface

- `iframe.contentWindow` → the child's window **proxy** (cross-VM: separate
  sandbox — real engines also cross realms here).
- `window.frames`/`length`, `parent`, `top` — proxies along the frame tree;
  root's `parent`/`top` is itself.
- `window.postMessage`/`contentWindow.postMessage(data, origin)` → `message`
  event delivered into the target sandbox via its runtime (JSON-cloned —
  structured-clone-lite), honoring `targetOrigin`.
- Child `location.assign`/link clicks navigate **that context only** — intents
  drain through the owning context, pumped recursively by the tab.

### Frame-tree reconciliation

`src`/`srcdoc` carry a per-element signature (`resolveNavigationTarget`-ed
src, or the srcdoc payload). After every guest task drain / pump,
`#syncFrames` diffs the live DOM's connected iframe set against live
children:

- **new element** ⇒ child context spawns and loads,
- **detached element** (parent chain no longer reaches `dom.root` —
  `removeChild`/`remove`) ⇒ its context and bitmap are dropped,
- **signature drift** (`src`/`srcdoc` mutation) ⇒ the child re-navigates —
  `src` pushes a child history entry, `srcdoc` reloads inline.

Signatures ride along in bfcache retention so a restored page doesn't
reconcile against a stale map, and `adoptPage` resets them on navigation.

### Shell integration

`target=_blank` on a remote tab surfaces through `NavState.pendingNewTabs`;
the `TabHost` drains it into `openInNewTab` — a real second tab that also
receives the opener's `sessionStorage` snapshot (spec: cloning on `_blank`).

### Joint session history

The root context owns ONE ordered log (`JointStep[]`) of every committed
entry across the frame tree; a cursor marks the tab's position. Every
`push`/`pushStateEntry` in ANY context appends a step; a frame's FIRST load
joins its parent's step as a contiguous part (no extra back-stop for an
initial iframe document). `back()`/`forward()` — from the shell OR from any
context's `history.go()` intent — resolves each live navigable's latest
recorded entry ≤ target and traverses each context to it: a click inside an
iframe rewinds the frame, then the parent's own entry. Steps reference
contexts weakly plus an ownerElement path, so a parent reload that rebuilds
children still resolves their targets (a rebuilt `src`-frame re-navigates to
its recorded URL). `history.length` is the joint count: every committed
step broadcasts the new length into every live context's `SessionHost`, so
a child navigation extends what the parent observes (and vice versa).

### Cross-context DOM

`iframe.contentDocument` / `proxy.document` return the child's live document
wrapper when the two contexts share an effective origin — plain JS objects
cross our VM-realm boundary safely because contexts are lexical realms, not
processes. `about:blank`/srcdoc children inherit the embedder's origin (and
now its storage, per spec); sandbox-without-`allow-same-origin` gets a
fresh opaque key per load, so cross-origin and opaque frames stay sealed.

## Honest boundaries

- `frameElement` is `null` inside children (cross-VM element identity has no
  marshalling layer). `contentDocument` now answers for BOTH runtime shapes:
  a live child returns its real document wrapper; a same-origin SCRIPTLESS
  child (`sandbox="allow-same-origin"` without `allow-scripts`) returns a
  read-only facade over its committed DomTree — `getElementById`,
  `querySelector(All)` via the cascade's real selector matcher,
  `getElementsByTagName/ClassName`, `textContent`, attributes, tree
  getters (`frame-dom-facade.ts`). Mutations are honest no-shows: no
  DOM-0 write API is fabricated.
- Child bitmap compositing is per-parent-paint — no independent child
  scrolling/painting cadence.
- `name`-targeted navigation resolves `target` to the named child when found
  (`window.open(url, name)` navigates the frame and returns a live proxy).
  An *unknown* name now creates a named top-level traversable per spec:
  `NewTabRequest.name` registers the spawned tab with `TabHost`, and later
  opens/targets with the same name reuse it (verified end-to-end — a second
  `open('','w1')` navigates the same tab, no third tab spawns).
- `window.open` returning a proxy only works in-process: `_blank` into a
  remote tab returns `null` since a WindowProxy can't cross IPC. The remote
  tab DOES get a working `window.opener` reply proxy
  (postMessage/focus/closed) routed tab→tab through the browser process,
  and `window.close()` works end-to-end for script-opened tabs
  (`NavState.closeRequested` → `TabHost.close`).
- `window.focus()` and the `focus()` on an opener/`e.source` reply proxy
  ride `NavState.focusRequests` to `TabHost.select` — focus changes real
  tab-strip activation, verified by `opener.focus()` re-selecting the
  opener. `window.blur()` is an honest no-op: there is no chrome focus
  model to move away to.
- `<frame>`/`<frameset>` legacy frame documents are not nested contexts.

## Tests

`node:http` serving parent+child: iframe loads real child (parent cookies ride
the child request — shared jar), `load` fires, `contentWindow.postMessage`
delivers `message` with data+origin into the child, `parent.postMessage` round
trip, `sandbox` blocks child scripts, `srcdoc` renders inline, child
`location.assign` repaints the frame without touching parent history,
frame bitmap lands in the parent's PNG.
