# RFC 0018 — Shadow DOM v1

Status: implemented (core surface, with documented simplifications)
Packages: `ir` (DomNode.shadow), `cli` (session, script bridge), `cascade`
(`:host`, `shadow-host` origin), `layout` (composed tree), `guest` (Event.composedPath)

## Decision

Real Shadow DOM on the existing stack: the shadow root is a regular
`"#shadow-root"` DomNode side-attached to its host via a new `DomNode.shadow`
field — **never** in `children` — so every light-DOM query
(`getElementsByTagName`, `querySelector`, `childNodes`, the document id index)
stays tree-scoped for free, while the composed-tree view layout needs is a
projection computed at consumption time.

### Why a `shadow` field, not a child

Putting the root in `children` would poison every descendant enumeration
(document.getElementById would find shadow ids, `:nth-child` counts would
shift, MutationObserver subtree on document would leak across the boundary).
The field keeps the light DOM structurally closed; shadow membership is
derived from `parent === shadow-host` walks, which cross the boundary only
where spec says they should (inheritance, connectivity, shadow-including
event paths).

### Why DOM-parent is null for the shadow root

`session.attachShadow` sets `sr.parent = host` for traversal convenience,
but spec says `shadowRoot.parentNode === null` — the host is only its
*shadow-including* parent. So DOM-sense walks (`ancestorPath`,
`containsNode`, `parentNode`/`parentElement`, MutationObserver `subtree`
matching) all terminate at `"#shadow-root"`, while shadow-including walks
(`isConnected`, event paths, `getRootNode({composed})`) continue through
`host`. `document.contains(shadowChild)` correctly returns `false` while
`shadowChild.isConnected` is `true`.

## Mechanism

### attachShadow / ShadowRoot surface

`attachShadow({mode})` validates the host: the HTML whitelist
(article…span, incl. `main`) **or any valid custom-element name** (defined
or not — spec's potential-host list); otherwise `NotSupportedError`, as is
double-attach. `session.attachShadow` allocates the `"#shadow-root"` node,
records `mode` in attrs, and seeds the host's struct input so incremental
queries invalidate. `element.shadowRoot` returns the wrapper for open roots
and `null` for closed (the root still exists internally — mode is honest
visibility, not access control on the internals). `ShadowRoot.prototype`
extends `DocumentFragment.prototype`; `host`, `mode`, and a shadow-scoped
`getElementById` are own properties on the wrapper (the document-level id
index never enters shadow trees, so scoped id lookup walks the shadow
subtree — `queryAll`'s `#id` fast path dispatches on scope).

### Slots and the flattened tree

`slotAssignedIds(slot)` resolves assignment by scanning the host's light
children: elements match `slot=""`/`name`-equality; bare text nodes land in
the default slot only. `assignedSlot` on a light child inverts that
(`assignedSlotFor`). `slotchange` rides the session mutation sink: any
mutation touching a shadow root's slots or a host's light children recomputes
each slot's assignment signature and signals a bubbling `slotchange` on a
microtask — deduped per slot while pending (spec's "signal once" semantics).

### Layout consumes the composed tree

`layout()` gained a `contentChildren(node)` helper: for a host it splices in
`[shadowRoot]` in place of nothing (the shadow root lays out as a fragment
container), for a `<slot>` it substitutes assigned light children — falling
back to the slot's own children when empty — and otherwise returns
`children`. **Every** child enumeration across block/inline/flex/grid/
multicolumn/table layout, first-child margin-collapse probing, and text
measurement went through this one helper, so slotted content lays out inside
its slot's box and shadow content renders where light children would.

### Scoped stylesheets and `:host`

`qFineComputed` routes by the node's enclosing shadow root: inside a shadow
tree it cascades against `qFineShadowIndex` — a per-root rule index built
from the UA sheet + `<style>`/`<link>` collected with the shadow root as the
collection scope — and inherits through the host (the root node's computed
style IS the host's). Document rules never apply inside; shadow rules never
apply outside (verified both directions in tests). For the host element,
`:host`-subject rules are pre-filtered from the shadow sheets
(`qFineShadowHostRules`), matched against the host, and merged as
`IndexedRule`s at a new `CascadeOrigin: "shadow-host"` ranked **below every
document origin** — CSS Scoping §2.4's "document wins over :host" rule.

Cascade proper learned the `host` field on `CompoundSelector`: bare `:host`
or `:host(<compound>)`, parsed like `:not`, matching only elements with a
`shadow` field (functional form additionally requires the inner compound).

### Events: flattened-tree paths + retargeting

`dispatch()` builds the path via `shadowPath` — the **shadow-including**
parent chain: slotted nodes route through their `<slot>` (so shadow
listeners see light-DOM events — spec's flattened-tree semantics), a shadow
root's parent is its host. Non-composed events truncate the path at the
first `"#shadow-root"` (the root itself still gets it — matching browsers);
composed events traverse out through the host to the document.

Retargeting is scope-based: `eventScopeOf(node)` = the node itself if it's a
shadow root, else the first enclosing shadow root in its shadow-including
chain, else the document root — so a slotted child's scope is the shadow
tree it lands in (shadow listeners see the real target; document listeners
see the host). `invokeAt` computes the listener's scope and swaps `target`
to the deepest path node sharing it. `Event` grew `composed`,
`composedPath()` (full untruncated path, cached wrappers), and internal
`_setComposedPath`; `EventInit.composed` is honored by `EventCtor`.

### CE interplay

`forEachElementPreorder` (lifecycle dispatch) and `elementIdsByTagNameDeep`
(`define()` upgrades) both descend into `node.shadow`, so custom elements
inside shadow trees upgrade, connect, and disconnect with their host —
verified end-to-end (`x-ins` upgraded inside a shadow tree, `disconnectedCallback`
fired on host removal).

## Boundaries (honest)

- **No declarative shadow DOM** — `<template shadowrootmode>` isn't parsed;
  shadow trees are script-built only.
- **`assignedNodes({flatten:true})`** returns the assigned list without
  descending into nested slot chains (slot-in-shadow-of-shadow resolves one
  level, not the recursive spec walk).
- **No `::slotted` / `::part` / `:host-context()` / `:host()` ancestor
  args** — `:host` and `:host(sel)` only; `::slotted` styling would need a
  flattened-tree cascade pass we don't run.
- **No `adoptNode` across roots**, and no shadow-aware `getClientRects`/
  `offsetParent` subtleties.
- **`style.sheet` inside shadow** returns the generic stylesheet object
  (same surface as light DOM), but shadow sheet objects aren't separately
  exposed via `shadowRoot.styleSheets` yet.
- **Event `relatedTarget` retargeting** isn't implemented (mouse/focus
  crossing pairs); `target` retargeting and path scoping are full.
- **`slotchange` is per-slot microtask**, not the spec's mutation-signal
  batch — visible ordering matches, but a slot that changes twice in one
  task signals once (dedupe) while two tasks each deliver.
- **Non-composed truncation keeps the shadow root in-path** — listeners on
  the shadow root itself fire for non-composed events (browser-consistent);
  the *host* is where it stops.
- **Retarget granularity is per-listener-scope**, not per-path-item spec
  bookkeeping — equivalent for targets that differ across boundaries.

## Verification

`packages/cli/src/shadow-dom.test.ts` — 8 tests through
`runScriptsOnSession` + direct session queries: open/closed attach +
error taxonomy, slot assignment/fallback/`assignedSlot`/`assignedElements`,
composed-tree layout geometry (slotted text inside slot box, shadow siblings
in flow), style isolation both ways + `:host` at below-document origin,
non-composed trapping + composed retarget-to-host + `composedPath` length,
flattened-tree routing for slotted children (shadow listeners see real
target), `slotchange` dedupe + CE lifecycle inside shadow, `getRootNode`
composed/plain + scoped `getElementById`.

1431/1431 total tests, WPT 462/462 (dom-events subset unchanged — no
regression from retargeting work), typecheck/lint/constitution/open-source
all green.

## Rollback

`git revert` removes: `DomNode.shadow` + `attachShadow`/`shadowRootOf` in
fine/ir, the composed-tree `contentChildren` helper + call-site swaps in
layout, `shadow-host` origin + `CompoundSelector.host` + `:host` parsing in
cascade, the shadow block in script.ts (`ShadowRootCtor`, helpers, element
surface, `shadowPath`/`eventScopeOf` dispatch changes, slotchange sink),
`Event.composed/composedPath` in guest, and `shadow-dom.test.ts`. Custom
Elements does not depend on any of it (RFC 0017 stands alone).
