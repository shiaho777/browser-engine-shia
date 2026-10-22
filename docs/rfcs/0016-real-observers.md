# RFC 0016: Real MutationObserver, ResizeObserver, IntersectionObserver

Status: Implemented

Owner: engine contributors

Labels:
`rfc`, `stage:runtime`, `phase:platform-api`

## Decision

Replace the four fake `createObserverStub` implementations (duplicated in
`event-loop.ts` and `esm-runner.ts`) with **real observers implemented once
inside `buildDocumentApi`** and delivered to every sandbox via `domGlobals`:

1. **MutationObserver** rides a new synchronous sink on `FineSession` —
   `session.onMutation(cb)` emits a structured `DomMutation` from every
   mutator (`setText`, `setAttribute`, `removeAttribute`, `appendChild`,
   `insertBefore`, `removeChild`, and reparent-detach). The facade routes
   each mutation to matching registrations (`subtree` ancestry walk,
   `attributes`/`attributeFilter`, `characterData`, `childList`, spec
   default-implication rules for `attributeOldValue`/`attributeFilter`/
   `characterDataOldValue`), builds real `MutationRecord`s — wrapped
   targets via the existing wrapper cache (stable identity), static
   NodeList snapshots for `addedNodes`/`removedNodes`, sibling fields,
   gated `oldValue` — and batches delivery through ONE compound microtask
   per notification round (DOM §"queue a mutation observer compound
   microtask"). Reparenting emits the platform's real pair: removal on
   the old parent, addition on the new.
2. **ResizeObserver / IntersectionObserver** are *rendering-step*
   observers: they never fire synchronously inside a DOM write. A
   mutation marks geometry dirty and schedules an evaluation microtask;
   `tickAnimations` also evaluates at every animation-frame boundary.
   Each evaluation resolves the layout **once** (shared `FragmentIndex`),
   then per observer: RO diffs each target's content/border-box size;
   IO intersects document-space rects with the viewport (live
   `options.viewport` getter) or a root element's border box expanded by
   `rootMargin` (px/`%`), applying real threshold-index semantics.
3. **Document-space coordinates.** Fragment rects are parent-local
   (margin-origin spaces). `documentRectOf` accumulates each ancestor's
   `marginBox` origin — the sole FragmentTree reads, consistent with
   `getBoundingClientRect`'s documented coordinate model.
4. **Microtask scheduling is injectable** (`options.queueMicrotask`):
   virtual-time runners pass `loop.microtask` so observer callbacks
   interleave with guest `queueMicrotask` in true FIFO order; real-vm
   paths (WPT harness, ESM runner) default to the ambient queue.
   `PerformanceObserver` remains an honest shell — registered, never
   fabricates entries — pending a real performance timeline.

## Problem

The stubs fired fake callbacks: IntersectionObserver always reported
`isIntersecting: true, ratio: 1` with all-zero rects; ResizeObserver
reported zero sizes; MutationObserver never delivered at all. Any page
code driving lazy-loading, infinite scroll, virtualization, or DOM-diff
watching was silently broken.

## Mechanism notes

- **`LAYOUT_FIELDS` bug found via this work**: `overflow` had been
  classified paint-only, so the fine session's layout projection dropped
  it — `overflow:hidden` never established a BFC and child margins
  collapsed through it. `overflow`/`overflowX`/`overflowY` are now
  layout fields; `establishesBfc` checks all three axes.
- `observe()` re-registration replaces the prior init for that target
  (spec); `disconnect()` clears both registrations and the pending
  queue; `takeRecords()` drains without delivery.
- IO entries carry `rootBounds`, `boundingClientRect`,
  `intersectionRect`, `isIntersecting`, `intersectionRatio`, `time`;
  edge-touching counts as intersecting; a non-laid-out target reports
  `isIntersecting: false`. RO entries carry `contentRect` and all three
  `*BoxSize` arrays; `box: "border-box"` selects the observed box.

## Honest boundaries

- RO/IO deliver one microtask hop after evaluation (spec delivers at the
  rendering step itself); scroll-driven re-evaluation requires a frame or
  mutation — no dedicated scroll plumbing yet.
- MutationObserver transient registrations (mutations inside a detached
  subtree reaching the former ancestor's observer) are not modeled.
- `runScriptsOnSessionRealInner` uses `geometryMode:"stub"` — observers
  there deliver with zero geometry until the app path gains real layout.
- No `document` root-scrolling model: viewport `scrollY` is the only
  scroll offset honored for IO root bounds.

## Rollback

`git revert` this RFC's commit. The sink API is additive; the observers
live entirely inside `buildDocumentApi`.
