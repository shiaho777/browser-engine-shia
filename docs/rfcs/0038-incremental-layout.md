# RFC 0038 — Incremental layout: mutation damage → boundary replay

Status: implemented. A DOM mutation no longer forces a whole-tree relayout —
elements that establish an independent formatting context replay their cached
fragment subtrees verbatim when the damage tracker proves them clean, while
the damaged path re-lays out normally.

## Decision

**One invariant: a replayed subtree is byte-for-byte what `layout()` would
have produced — reuse is a pure performance transform and can always be
dropped for a conservative re-layout.**

The seam is `layoutNode` — the single dispatch point every element layout
funnels through (`packages/layout/src/index.ts`). Two pieces:

### 1. Damage tracking (`FineSession`)

`#emitMutation` already funnels every mutation (MutationObserver plumbing);
it now also marks a per-session `LayoutDamageStore`:

- `childList` on P → P is *structural*-dirty (its child list changed).
- `attributes` on N → N is *content*-dirty: descendants' computed styles can
  inherit the change.
- `characterData` on text T → T's parent element is structural-dirty.
- `<style>` text edits, `<link>`/`<base>` attr edits, and childList edits
  whose added/removed subtree CONTAINS a sheet element → `global` — every
  computed style is suspect; all entries miss.
- When the collected sheet set can restyle siblings (`:first-child`,
  `:nth-*`, `+`/`~` combinators, `:has`, `:not` — detected per render by
  `renderDom` and recorded as `damage.siblingSelectors`), childList and
  attribute edits conservatively fan content-dirt out to all children of the
  touched parent.

`clean(id)` answers "the subtree rooted at `id` is provably unchanged": the
node itself unmarked, no content-dirty ancestor (inheritance), and no dirty
node inside its subtree — the last checked the cheap way: for each dirty
node, walk ITS ancestors (`O(|dirty| × depth)`), not a descendant scan.
Structural dirt on an ancestor does NOT taint a node — a sibling insert
repositions the subtree but cannot change its internal layout.

### 2. Boundary reuse (`IncrementalLayout` on `LayoutOptions`)

A node is a **layout boundary** — its internal layout is a pure function of
its own subtree plus the incoming containing sizes — when it:

- establishes a BFC (`establishesBfc`: floats, abs/fixed, non-visible
  overflow, `display:flow-root`, `inline-block`), or
- is a flex/grid/table/multicol/ruby container or a replaced element, or
- is a flex/grid **item** (Flexbox §4 / Grid §3.4: items are independent
  formatting contexts — outside floats and margins never reach in).

On produce, the fragments emitted inside the call (`fragMark..nextId`) plus
the returned (unregistered, pre-placement) root are stored under the node's
`NodeId` keyed by `{width, containingHeight, forceContentHeight,
forcedContentWidth, epoch}`. On a hit the entry replays: every recorded
fragment is cloned under a FRESH `FragmentId` (`children` remapped), so the
emitted tree keeps unique ids and stays frozen. The root is NOT registered —
the parent's placement pass offsets and registers it exactly like a freshly
produced fragment, so a clean subtree can land at new coordinates for free
(this is what makes reparented/floating panels reusable).

**Never cached:** subtrees that pushed out-of-flow requests to an ancestor
frame (their static positions are external inputs the replay cannot
reproduce) — detected by diffing the abs-stack's top frame across the call;
subtrees laid out inside a measurement probe (`probeDepth > 0`); nodes inside
a virtual writing-mode space; `display:none`; and anything non-boundary —
plain in-flow blocks always re-lay out because sibling floats and margin
collapse reach inside them.

### Epoch

`damage.epoch` is bumped on global inputs the mutation stream does not key
per-node: viewport size, scrollY, dpr (`page.ts` compares a
`layoutInputKey` fingerprint), and `setExternalSheetLoader`. Entries produced
under another epoch are ignored.

### Wiring

- `FineSession` owns the store; `qFineLayout` hands it to `layout()` through
  the kernel's `LayoutDamage` input slot (stable identity — never drives
  invalidation itself; the struct/attr inputs already do).
- `page.ts`: `loadPage` carries `session.layoutDamage` onto `PageState`;
  `repaintPage` bumps the epoch on input drift and feeds the store back into
  `renderDom`, which also scans the collected sheets to set
  `siblingSelectors`.
- `consume()` runs when a render commits the damage (`render()` /
  `layoutTree()` / `renderDom` tail) — the next mutation marks fresh dirt.

## Verification

- `packages/layout/src/incremental.test.ts` (9): clean-BFC replay ≡
  cache-free geometry; fresh-id replay (no collisions); OOF-leak subtree
  never cached; non-boundary blocks never cached; width/epoch invalidation;
  flex-item boundaries; repositioned-parent replay; frozen text-run shared.
- `packages/app/src/incremental-layout.test.ts` (4): guest `textContent`
  edit → repaint hits ≥1 boundary AND the page PNG is **byte-identical to a
  fresh full load of the mutated document**; deep attribute edit taints only
  its subtree; scrollY change bumps the epoch; inserted `<style>` sets
  `global`.
- `packages/benchmark` `subtreeReuse` evidence: 120 `overflow:hidden` panels
  (1806 nodes) — one text edit replays all 119 undamaged panels
  (`boundaryHits`), `replayCorrect` checks the warm tree against an all-miss
  control relayout of the same document state.

## Honest boundaries

- **Reuse ≈ clone cost**: replay re-allocates fragment objects (fresh ids).
  On shallow subtrees warm vs cold layout time is roughly parity; the win
  scales with per-subtree produce cost (shaping, deep nesting) minus clone
  cost. The benchmark records both numbers — it does not claim a wall-clock
  win where none was measured.
- Non-boundary nodes (plain in-flow blocks) still re-lay out — most real
  block content is in-flow, so a mutation near the top still re-walks much
  of the document. Damage narrows *boundary work*, not the outer walk.
- Reuse is conservative: content-dirty ancestors, sibling-restyle selectors,
  OOF leaks, probes, and virtual writing modes all fall back to re-layout.
- Style resolution itself is unchanged — `createComputedStyleResolver` still
  runs per render (kernel-memoized per node); damage only governs fragment
  reuse.
- A corrupt/incomplete cache entry fails safe: replay returns null and the
  boundary re-lays out.
