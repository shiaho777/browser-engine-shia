# RFC 0015: Real flex, grid, and table layout

Status: Implemented

Owner: engine contributors

Labels:
`rfc`, `stage:layout`, `phase:rendering`

## Decision

Replace the three placeholder layout branches with real algorithms that
share one infrastructure spine — **measure → place → (optional) relayout —
with fragment-tree hygiene for throwaway subtrees**:

1. **Flex** (CSS Flexbox §9): full main-axis sizing — `flex-basis`
   (px/`%`/`auto`), `flex-grow` weighted distribution, `flex-shrink`
   scaled-factor distribution on overflow, `order`, `flex-wrap` line
   formation on hypothetical sizes, `row`/`row-reverse`/`column`/
   `column-reverse` axes, `gap` on both axes, `justify-content` packing,
   `align-items`/`align-self`/`align-content` line+item alignment, and
   `stretch` re-layout at the effective line cross size.
2. **Grid** (CSS Grid §7–§12): `grid-template-columns`/`grid-template-rows`
   track lists (`px`/`%`/`fr`/`auto`/`minmax(min,max)`/`repeat(n)`),
   occupancy-based placement honoring `grid-column`/`grid-row` line and
   `span` forms, `grid-auto-flow` row/column/dense, implicit tracks sized
   by `grid-auto-rows`/`grid-auto-columns`, `justify-items`/`justify-self`/
   `align-items`/`align-self` cell alignment, `justify-content`/
   `align-content` track-grid distribution, `align-content:stretch`
   growth of auto rows against a definite container height, and cell
   re-layout at the resolved band size.
3. **Table** (CSS 2.1 §17): structural pass flattens `thead`/`tbody`/
   `tfoot`/bare rows into groups → rows → cells; `colspan`/`rowspan` place
   cells on an occupancy grid; `border-spacing` separates cells and insets
   the grid from the table edge; `border-collapse` positions cells
   adjacent; `table-layout:fixed` sizes columns from the first row only;
   cells are relaid to fill their band and `vertical-align`
   (`top`/`middle`/`bottom`/length/`%`) shifts cell content inside it.

## Problem

- Flex was a single-line equal-share approximation: no `flex-basis`,
  no shrink, no reverse axes, no `align-self`/`align-content`, and
  `stretch` only offset the fragment without re-laying it.
- Grid resolved only `grid-template-columns` — no row tracks, no
  `minmax`, no `%`, no auto rows; `auto-flow` was ignored.
- Table was a flat equal-column strip: no groups, no spans, no border
  model, no `vertical-align`.
- **A subtle architectural bug surfaced**: measurement passes (flex
  column auto-base, stretch re-layouts, cell relayout) register the
  probe fragment's *descendants* into the flat `fragments` map, so one
  DOM node produced two fragments — `getBoundingClientRect` returned the
  stale probe's `borderBox` object. The geometry-source property test
  caught it via reference identity (`assert.equal`, not `deepEqual`).

## Goals

- `flex-grow`/`flex-shrink` produce spec-proportioned main sizes
  (shrink scales by base size — §9.7).
- `auto-flow:column` wraps at the explicit row count (`max(1, explicit
  rows)` — no `grid-template-rows` ⇒ single implicit row ⇒ horizontal
  strip); `dense` rescans from the origin.
- `fr` rows share the *definite* container height's free space; a
  content-sized floor (`minmax(auto,1fr)` semantics) keeps content visible.
- Row-spanning cells/items feed uncovered height back into their spanned
  rows equally.
- `border-spacing` applies between cells **and** between cells and the
  table edge (§17.6.1).
- Probe/regenerated fragments never leak into `FragmentTree`.

## Non-Goals

- No intrinsic `min-content`/`max-content` pass: `auto` **columns**
  approximate `1fr`; `auto` **rows** size to content (measurable).
- Cell `vertical-align:baseline` shares the row's first-line baseline.
  `baseline` of a cell with no line is its content bottom. Rowspan cells
  do not join that pass. `sub`/`super` stay top-aligned.
- `col`/`colgroup` widths (including `span`) seed columns. They do not
  generate column-group boxes. No column-spanning group reordering
  (`tfoot` stays in DOM order). Collapsed borders resolve a shared edge
  by width, then by style (`double` > `solid` > `dashed` > `dotted`);
  a tie keeps the left or top edge.
- Column and row `subgrid` reuse the parent tracks an item spans, including
  that axis's gap. Row subgrid is adopted only when every spanned parent
  row is definite (px, percent, or fr in a definite height). Named lines
  inside `repeat()` are skipped, not repeated. No negative/zero line numbers.
- Column `flex-wrap` uses the same line packing as rows. It wraps only
  when the container's main size (height) is definite. An indefinite
  height stays a single column.
- `minmax`/`fr`/`%`/auto tracks in `grid-auto-*` resolve, but implicit
  *row* sizing via `grid-auto-rows: fr` only flexes when the container
  height is definite.

## Proposed Mechanism

### Probe hygiene (`layoutProbe` / `dropFragmentTree`)

`register()` pushes every fragment into the flat map. Two passes that
throw away layout results must not leak descendants:

- `layoutProbe(fn)` — for discarded whole-trees (flex column auto-base
  measure): marks a waterline, runs `fn`, then deletes every id
  registered inside. Reentrant (nested probes roll back only their own).
- `dropFragmentTree(frag)` — for *kept-then-replaced* fragments
  (stretch re-layout): the returned top fragment was never registered,
  so only its `children` subtree is walked and deleted, then the item
  is relaid.

### Flex

Per item: `base = flex-basis | declared main size` (content-box
converted; `auto`+auto ⇒ `isAuto`). Lines form on hypothetical sizes:
auto-row items measure max-content width (`maxContentMarginBox`), auto-column items get a real measured content height via
`layoutProbe`. Per line: `free = definiteMain − Σbase − gaps`; positive
free distributes by `grow`, negative shrinks by `base·shrink` factors.
Items lay out with `forcedContentWidth`/`forceContentHeight` so the
flexed size *overrides* the item's own declared main size (the declared
value already fed `flex-basis:auto` once — feeding it again would pin
the item). Reverse axes mirror `mainPos` around `definiteMain`.
`stretch` relayouts cross-auto items at the effective line cross and
re-reads the cross size.

### Grid

Placement runs *before* column sizing because `auto-flow:column` (and
over-hanging explicit placements) create implicit columns: the flow
cursor advances row-major (`n % explicitCols`, `floor(n / explicitCols)`)
or column-major wrapping at `flowRows`. `free()` bounds row-flow spans
to the explicit column count. Final `colCount = max(explicit, placed
end)`; tracks resolve via `resolveTrackSizes` over the effective list
(explicit + `grid-auto-columns` fallback). Rows: fixed tracks resolve
against the definite row budget; auto rows take the tallest measured
cell; spanning deficits split equally; `fr` takes `max(content min,
share of budget − non-fr)`; `align-content:stretch|normal` then grows
`auto` rows to consume leftover definite height. Cells relayout to their
band (height) and align inside via `justify-self`/`align-self`.

### Table

`clampSpan` reads the `colspan`/`rowspan` attributes; an occupancy set
advances each cell's column cursor past rowspans carried down from
earlier rows. Column width seeding: declared cell widths (fixed layout:
first row only) spread across spans; leftover splits among undeclared
columns; shortfall stretches declared columns proportionally to fill the
table. Cells are measured at band width with `forcedContentWidth` (a
cell's own `width` seeds columns but does not size the box — §17.5.2),
then rows take the max natural height with rowspan deficits distributed
equally. A second pass relayouts cells to the band height
(`forceContentHeight`) and offsets children for `vertical-align` —
`middle`/`bottom` shift `(innerH − contentH) × {0.5, 1}`; fragments'
descendants move with the child (parent-local invariant), so shifting a
direct child shifts its subtree.

## Stage Boundary Check

- Upstream reads: `DomTree` (incl. element `attrs` for spans),
  `ComputedStyle` (generated fields via the open index signature —
  `gridTemplateRows`, `borderSpacing`, `tableLayout`, … are read
  defensively; the generator already emits them).
- Downstream writes: `FragmentTree` only. No new IR fields, no paint
  changes — flex/grid/table emit ordinary nested boxes.
- Probe/rollback state is `layout()`-local; nothing crosses into IR.
- Silent stubs: none — absent properties resolve to spec initials
  (`flex: 0 1 auto`, `auto` tracks, `border-collapse: separate`).

## Evidence Plan

```bash
npm run typecheck && npm run lint && npm run test
npm run wpt:subsets && npm run evidence
```

- 11 new focused tests in `advanced-layout.test.ts`: row tracks +
  `minmax`/`%`, column flow wrap + `grid-auto-columns`, `dense`
  back-fill, `justify-self`/`align-self`, row-span band fill, group
  fragments, colspan occupancy, rowspan deficit distribution,
  border-spacing geometry, cell `vertical-align:middle`, fixed-layout
  first-row widths.
- Layout suite 153/153; repository **1401/1401**; WPT maintained subsets
  **462/462** (the `emptyShell` regression — empty declared-width items
  must not share free space — was caught by `flex-gap-order`/
  `flex-layout` fixtures and fixed by deleting the rule).
- Probe hygiene verified by `geometry-source.property.test.ts`
  reference-identity assertions (2 probe leaks found and removed).

## Alternatives Considered

1. **True intrinsic sizing (min/max-content).** Rejected for now —
   requires a second text/intrinsic measuring pipeline; the `auto ≈
   share` approximation is documented and confined to track resolution.
2. **Anonymous row-group fragments for bare `tr`s.** Rejected —
   fragments key on `NodeId`; anonymous boxes have none. Bare rows hang
   off the table directly (spec-equivalent geometry, no phantom node).
3. **Global-coordinate fragments for cell offsets.** Rejected —
   `vertical-align` shifting children relies on the parent-local
   invariant to move whole subtrees in O(1).

## Risks

- Two-pass cell layout doubles cell work; deep tables inside tables
  compound. Acceptable at this stage (layout is still O(n) passes).
- `dense` + spanning corner cases (spans wider than remaining columns
  in non-flow-bounded scans) fall back to origin placement — rare.
- Collapsed shared edges keep one winner. The winner still paints on its
  own border box, not centered on the grid line. `hidden` is painted as
  `none` before the conflict, so it does not suppress a neighbor.

## Rollback

The three branches are additive inside `layoutFlex`/`layoutGrid`/
`layoutTable`; `layoutProbe`/`dropFragmentTree` are pure additions.
Reverting = restoring the single-pass approximations — no IR or public
API changed.

## Boundary

- All logic stays in `packages/layout`; `packages/generator` untouched
  (fields already generated).
- Honest gaps carried forward: intrinsic sizing, baseline cell align,
  `table-caption`, named grid areas, collapse conflict resolution.

## Test plan

- Flex: basis/shrink bidirectional math, reverse axes, wrap+cursor,
  align-self/align-content, stretch relayout (already covered earlier).
- Grid: all six new tests above + existing column tests.
- Table: groups/spans/spacing/valign/fixed.
- Full gates at merge: 1401 tests, WPT 462, lint/typecheck/
  constitution/open-source — all green.
