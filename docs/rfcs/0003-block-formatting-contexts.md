# RFC 0003: Block formatting contexts — margin collapsing and float intrusion

Status: Implemented

Owner: engine contributors

Labels:
`rfc`, `stage:layout`, `phase:layout`

## Decision

Turn the block formatting context into a **first-class object**. A new
`packages/layout/src/bfc.ts` defines `BlockFormattingContext` — the owner of
the two kinds of state that CSS 2.1 §9.4.1 attaches to a BFC:

- the **float registry**: every float's border-box rectangle, recorded in BFC
  coordinates so any descendant in the same BFC can query intrusion at its own
  position; and
- the **margin-collapse chain**: the running "pending" margin that adjoining
  vertical margins collapse into.

A `layoutBlock` that does **not** establish a new BFC shares its parent's
`BlockFormattingContext` instance; one that does (floats, `overflow` ≠
`visible`/`clip`, `inline-block`, absolutely-positioned boxes, and the
tree root) opens a fresh one. Formatting context **splitting** is therefore
mechanical: the BFC — not a loop-local `cursorY` — decides what collapses
with what and which floats intrude where.

On top of the shared registry, three spec behaviours land:

1. **Full margin collapsing** (CSS 2.1 §8.3.1): adjoining-sibling collapse
   (exists today), parent/first-in-flow-child top-margin collapse,
   parent/last-in-flow-child bottom-margin collapse, and empty-block
   top+bottom self-collapse — each gated on the spec's barriers (borders,
   padding, clearance, BFC boundaries).
2. **Float intrusion into line boxes**: `layoutInline`/`layoutInlineRun`
   accept a per-line `narrowLine(y)` callback; each line box shortens and
   shifts against the floats spanning its y — text wraps *around* floats,
   including floats floated by ancestor siblings (the BFC propagates the
   registry into non-BFC descendants).
3. **Float-aware block rules** (§9.5): a normal block keeps its full border
   box next to a float (only its line boxes shorten — new, since narrowing
   now lives in the IFC); a BFC-establishing or block-level-replaced child's
   border box narrows to the free space, dropping below the floats if the
   space at its y cannot hold it; floats themselves fit-or-drop at their
   earliest legal y; and a BFC's height grows to contain its floats
   (the "clearfix" behaviour).

The FragmentTree IR is **unchanged**: all of this is positional geometry
inside existing boxes — no new IR fields, no backend changes.

## Problem

The current `layoutBlock` (≈200 lines) carries BFC responsibilities on local
variables:

```ts
let prevBottomMargin: number | null = null;
const activeFloats: { side; width; bottom }[] = [];
```

That is a *simulation* of a BFC scoped to one element's child loop:

- **Margins collapse only between adjacent siblings.** A first child's top
  margin cannot leak through its parent's top edge (`<div><p>` with no
  borders renders double spacing where CSS shows one margin); an empty
  block's top and bottom margins stack instead of collapsing; a last
  child's bottom margin cannot merge into the parent's.
- **Floats die at the block boundary.** `activeFloats` is a local array: a
  float inside a nested (non-BFC) block neither intrudes on the outer flow
  nor is seen by later blocks. Conversely an outer float cannot narrow the
  line boxes inside a descendant paragraph — `layoutInlineRun` receives one
  flat `contentWidth` and wraps as if the float were not there.
- **Normal blocks are shrunk like BFCs.** `availWidth = contentWidth −
  intrusion` is applied to every in-flow child, but §9.5 only shrinks the
  border boxes of BFC-establishing (and block-level-replaced) elements; a
  normal block's border box keeps full width — only its *line boxes*
  shorten. With line-box narrowing absent, the current shrinking is the
  wrong approximation of the wrong rule.
- **`clear` uses a heuristic cursor bump**, not a query over the BFC float
  registry; it cannot see floats from other blocks of the same BFC.
- **Floats never push a container's height** (no clearfix) and never drop
  when the free width at their y cannot fit them — they overlap the
  previous float on the same side.

The result is honest but visibly wrong on real pages: double margins around
`<p>`/headings, text rendering *through* floats, zero-height float parents.

## Design

### The `BlockFormattingContext` object

```ts
// bfc.ts
export class BlockFormattingContext {
  // floats in BFC coordinates: margin-box rects.
  placeFloat(side, rect {x0,x1} bounds, w, h, minY): {x, y};  // fit-or-drop
  intrusion(y, x0, x1): { x0, x1 };        // narrowed free interval at y
  clearanceY(side): number;                // max bottom of matching floats
  floatsBottom(): number;                  // deepest float bottom (∞ none→0)
}
```

Coordinates: BFC space is anchored at the BFC root's content-box origin.
A block's participation contract:

- `layoutNode(id, w, h?, forceH?, fc)` gains an optional `fc:
  { bfc: BlockFormattingContext; originX: number; originY: number }` —
  the node's margin-box top-left **in BFC coordinates**, known before layout
  (the caller computes it from its own cursor state).
- A `layoutBlock` that establishes a BFC (`establishesBfc(style)`: `float ≠
  none`, `position: absolute|fixed`, `overflow ∉ {visible, clip}`,
  `display: inline-block`, or the tree root) creates `ownBfc = new
  BlockFormattingContext()` and anchors its own content box at `(0, 0)`.
- A normal block shares `fc.bfc`; its content origin in BFC space is
  `fc.origin + (contentLeft, contentTop)`.
- Other FCs (`flex`, `grid`, `table`, `multicol`, replaced) do not consume
  `fc` — their subtrees already live outside the parent's BFC.

### The margin-collapse chain

Inside `layoutBlock`, `prevBottomMargin` generalizes to a proper chain:

- `penY` = the previous in-flow box's border-box bottom (content coords);
  `pending` = the current trailing collapsed-margin value.
- In-flow child with margins `mTop/mBot`: `borderTop = penY +
  (pending === null ? mTop : collapsed(pending, mTop))`.
- Non-empty child: `penY = borderTop + borderBox.height`, `pending = mBot`.
- **Empty block** (zero in-flow height, no border/padding): its two margins
  join the chain — `pending = collapsed(pending, mTop, mBot)` — so a run of
  empty divs accumulates one merged margin, per spec.
- **Parent/first-child**: before the loop, peek the first in-flow child;
  when this block is not a BFC root and has zero top border/padding, the
  effective `margin.top = collapsed(margin.top, firstChildMargin.top)` and
  the child starts at `penY = contentTop − mTop` (its margin rides inside
  the joint margin above the parent's border).
- **Parent/last-child**: symmetric — with auto height and zero bottom
  border/padding, `margin.bottom = collapsed(margin.bottom, pending)`.
- **Clearance**: a cleared child's top margin still collapses with the
  chain; the border top is then pushed to `max(borderTop, clearanceY)` —
  matching §8.3.1's "clearance is added between the collapsed margin and
  the border top". Margins after a cleared element resume normally.
- BFC-root blocks and floats never collapse with their children (the
  boundaries stop the chain by construction — a child in a fresh BFC cannot
  see its parent's `pending`).

### Line boxes against floats

`layoutInline` and `layoutInlineRun` gain an optional

```ts
narrowLine?: (localY: number) => { x: number; width: number };
```

The block caller builds it as a closure over the shared BFC:

```ts
const narrowLine = (ly) => {
  const r = bfc.intrusion(runTopBfc + ly, contentLeftBfc, contentRightBfc);
  return { x: r.x0 - contentLeftBfc, width: r.x1 - r.x0 };
};
```

Each line queries at its own top y; `penX` starts at `x`, wrap decisions
use `width`, and per-line `text-align` slack distributes inside the narrowed
interval. Without `narrowLine` (tests, flex/grid internals) behaviour is
identical to today. A line whose free width is zero still gets its first
word (overflow, per the line-leading rule) rather than sliding — documented
subset below.

A normal in-flow block child now receives the **full** content width (its
border box is unshrunk per §9.5); only BFC-establishing and block-level
replaced children get `intrusion`-narrowed width + x-shift, with fit-or-
drop (`bfc.placeFloat`-style descent) when the narrowed width is zero.
`img`/`svg` (replaced) are treated as border-box-shrinking, matching the
spec's "block-level replaced element" clause.

### Float placement

`placeFloat` pins the float's margin box to the **containing block's**
content edges (this block's — the nearest block ancestor — not the BFC
root's), at `minY =` current flow position; while the free interval at `y`
cannot hold the float's width, `y` descends to the next expiring float
bottom. This yields the spec's side-by-side packing and drop rules for free.
The placed rect joins the registry in BFC coordinates; `clearanceY` and
`floatsBottom` read it back for `clear` and BFC height containment.

## Alternatives considered

- **Keep local `activeFloats`, pass them down manually.** Rejected: the
  registry is exactly what defines a BFC; threading an ad-hoc array without
  the object re-creates the same coupling with worse discoverability.
- **Shrink every block to free width** (status quo). Rejected: it is the
  spec's rule applied to the wrong boxes — BFC roots shrink, normal blocks
  don't; keeping it would also make line-box narrowing redundant.
- **Full clearance algorithm** (CSS 2.1's "required clearance" two-pass).
  Deferred: our single-pass border-top clamp matches all non-degenerate
  cases and keeps the honest-subset note.

## Honest subset / limitations

- Margin chains are **one level**: a collapsing grandchild inside a child
  that itself collapses propagates through the *chain* at each level
  correctly only for the first/last in-flow child — deep transitivity (3+
  nested collapsing edges) approximates to pairwise collapse. No visual
  regression versus today; strictly closer to spec.
- Line boxes that cannot fit in their y's free width overflow instead of
  sliding below the float (only when the free width is literally zero does
  the line drop one float-height — bounded loop).
- `clear: inline-start/inline-end` keep their current `both` treatment
  (direction-aware clearing unwired, as before).
- Floats do not yet intrude **through** a BFC-establishing block into its
  siblings' line boxes (correct — that is what a BFC means).
- `display: flow-root` is not yet a parsed keyword; authors reach BFC via
  `overflow`, `float`, or `inline-block`.

## Boundary

- `BlockFormattingContext` lives wholly inside `packages/layout` — it is
  layout-engine state, not IR. FragmentTree, ComputedStyle, DisplayList are
  untouched; paint and backends see only moved boxes.
- No new dependencies, no new public API — `layout()` signature unchanged;
  the `fc` plumbing is internal.
- Rollback: the object is additive; `narrowLine`/`fc` parameters optional —
  reverting to loop-local floats is a small diff if the threading proves
  wrong.

## Test plan

New focused tests (each asserts *geometry*, not internals):

- margins: positive siblings, positive+negative siblings, empty-block
  self-collapse chains, parent/first-child through-collapse, parent/
  last-child through-collapse, no-collapse across padding/border, no-
  collapse across a BFC boundary (`overflow:hidden` parent keeps its own
  margins off its child's).
- floats: text wraps beside a left float (line widths narrowed, glyphs
  shifted right), beside a right float, both-side floats, two stacked
  same-side floats packing, float drop when no width, float bottom expiry
  (lines below a float regain full width), `clear:left/right/both`,
  float in a nested non-BFC block intruding on outer content, BFC parent
  growing to contain floats (clearfix), `overflow:hidden` block shrinking
  beside a float.
- regression: the Phase-1 invariants that changed semantics are updated
  (container content height no longer equals the raw sum of margin-box
  heights — it equals the *collapsed* stack); all 1172 tests + WPT gate.
