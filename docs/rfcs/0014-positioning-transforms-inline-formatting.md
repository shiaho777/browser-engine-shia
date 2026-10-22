# RFC 0014: Positioned layout, transforms, and inline formatting breadth

Status: Implemented

Owner: engine contributors

Labels:
`rfc`, `stage:layout`, `stage:paint`, `phase:rendering`

## Decision

Land the four highest-compat-per-line rendering features as one coherent
batch, because they share a single seam — **fragment geometry is
parent-local, paint consumes the tree unchanged**:

1. **Real positioned layout** (CSS 2.1 §9.3, §10.1, §10.6): `relative`,
   `absolute`, `fixed`, `sticky` resolve against the *containing block* —
   the nearest positioned **or transformed** ancestor for `absolute`, the
   initial containing block for `fixed` unless a transformed ancestor
   captures it. Percentage insets resolve against the containing block's
   padding box. `sticky` keeps its in-flow slot and clamps per-axis to
   `scrollY` inside its containing block's bounds. Positioned children are
   drained by their *containing-block owner* through a LIFO stack
   (`absStack`), not by their DOM parent.
2. **Transforms + compositing** (Transforms §3–§4): `transform`,
   `translate`, `rotate`, `scale` compose into one matrix;
   `transform-origin` (lengths, percentages, keywords) is baked into that
   matrix about the resolved origin. `opacity`/`filter`/`transform` push a
   compositing layer (`push-layer`/`pop-layer`); transformed ancestors
   capture fixed descendants. Sibling paint order follows CSS 2.1 Appendix
   E's simplified group order — negative-z positioned → normal flow/floats
   → non-negative/auto positioned — with document-order stability inside a
   group.
3. **Inline formatting breadth** (CSS 2.1 §10.8): `text-align` (line-level),
   `line-height`, `text-indent`, `white-space`
   (`normal`/`pre`/`pre-wrap`/`pre-line`/`nowrap`, break-spaces-style
   wrapping), hard `\n` breaks including consecutive breaks, and
   `vertical-align` for atomic inline members — `baseline` takes the box's
   text baseline (`contentTop + ascent`) when it has content, the bottom
   margin edge when it is an empty `inline-block`/replaced box
   (§10.8.1); `top`/`bottom`/`middle`/`sub`/`super`/`text-top`/
   `text-bottom`/length/percent all resolve and grow the line box.
4. **Real media environments**: `@media` evaluation sees actual viewport
   width/height, `orientation`, DPR (`resolution`), `prefers-color-scheme`,
   `prefers-reduced-motion`, `hover`, and CSS Media Queries L4 range syntax
   (`(400px <= width <= 800px)`). `EngineViewport` carries the preferences;
   `LiveSession.setMedia`/`FineMedia` expose the same input to the
   incremental pipelines.

## Problem

- `position:fixed` was treated as `absolute` (wrong containing block, no
  scroll pinning); `sticky` was an alias for `relative`; `absolute` asked
  only the *direct parent* instead of walking to the nearest positioned
  ancestor; there was no z-index paint order.
- `transform` painted but `transform-origin`, the individual longhands,
  and transform's containing-block capture (Transforms §4) were absent.
- The IFC ignored `vertical-align` entirely — atomic members sat on the
  line top, so baseline-aligned content drifted; `text-indent`,
  `pre`-style hard breaks, and `line-height` arithmetic were missing.
- `@media` evaluated against a hardcoded 800×600 `MediaEnvironment` — no
  caller ever passed the real viewport, and `dppx`/`prefers-*`/range
  syntax were unimplemented, so responsive stylesheets never matched.

## Goals

- Correct containing-block ownership: `absolute` queues on the nearest
  positioned/transformed ancestor; `fixed` queues on the ICB; a transform
  on any ancestor re-targets both.
- Scroll-correctness: `fixed` pins to the viewport via `LayoutOptions.scrollY`;
  `sticky` clamps `top`/`left`/`right`/`bottom` thresholds inside its
  containing block's margin bounds.
- In-flow invariants preserved: `relative`/`sticky` reserve their slot;
  `absolute`/`fixed` reserve none; percentage insets measure the padding
  box.
- Vertical-align honors §10.8.1's baseline ladder and grows the line box
  when an aligned member overflows it.
- `@media` reads real environment inputs end-to-end (page render, live,
  and fine incremental paths).

## Non-Goals

- `::first-letter` applies `font-size` (including `em`/`%` against the
  originating element) and `color` to the first letter or digit of that block's
  own text run, plus the punctuation that immediately precedes or follows it.
  A word with no letter still peels one code point. `::first-line` applies the
  same two properties to every glyph that stays on line 0; the larger advance
  is what wraps the line, and later lines keep the element's font and color.
  The letter's color wins over the line's. The two share a baseline when both
  set a size. Neither restyles the element. A `display: inline` descendant
  (including a nested one) carries the block's pseudo into its text;
  `inline-block` does not. The carried text is still an atomic box, so it does
  not wrap across the parent's lines. Collapsible whitespace before that inline
  is skipped. A preserved newline is an empty first line, so the letter on the
  following line is not a `::first-letter`. `float: left` or `right` on
  `::first-letter` pulls the letter out of the line and shortens the lines it
  still covers; following blocks do not wrap around it, and the float is not
  carried into an atomic inline. `font-weight` (`bold` = 700) applies to the
  letter, and a `::first-line` weight applies to the rest of line 0; the
  letter's weight wins. The element's own weight is unchanged, and the metrics
  advance does not change. `font-style` (`italic` / `oblique`) works the same
  way: the letter's style wins over the line's, later lines stay upright, and
  the element's own style stays put. The advance does not change. The backend
  shears `italic` and `oblique` by `setSkewX(-0.2)` unless `font-synthesis`
  lacks `style`. The shear is skipped when the face's OS/2 fsSelection marks
  it italic. `letter-spacing` widens the letter, and a
  `::first-line` spacing widens the rest of line 0; `em` uses the pseudo's
  font-size when that rule sets one. `margin` (shorthand and longhands; `em`
  against the pseudo's font-size) insets the letter and pushes the following
  text; a later longhand overrides that edge. `padding` sits inside that margin
  and insets the glyph the same way. `border` sits between them: a drawn edge
  (style other than `none`/`hidden`, width > 0) takes space and is painted
  around the letter. `em` on a width uses the pseudo's font-size; a later
  longhand overrides that edge. The element's own border stays initial.
  `background-color` (including the color in the `background` shorthand; a later
  longhand wins) fills that border box. Transparent stores nothing, and the
  element's own background stays initial. The same property on `::first-line`
  fills the glyph run of line 0 and stops there. The letter's fill paints over
  the line's. `background-image` on `::first-letter` paints over that fill.
  The clip is the letter's border box and the position origin is its padding
  box. The shorthand's repeat, size, and position are kept; a later
  `background-image` replaces only the url. A value with no `url()` stores
  nothing, except a `linear-gradient(...)` or a `radial-gradient(...)`, which
  is kept and painted. A radial gradient starts at the center and ends at the
  farthest corner. The element's own image stays initial. The same image on
  `::first-line` covers the glyph run of line 0, with the clip and the
  position origin on that same rectangle, and paints under the letter's fill.
- `vertical-align` shifts atomic inline boxes and text runs (`super` /
  `sub` / length / percent). `middle` uses the font's x-height when the
  shaper reports `OS/2.sxHeight`; otherwise the rise stays 0.25em.
  `sub`/`super` use the shaper's OS/2 subscript/superscript em when reported;
  otherwise the shift stays 0.2em/0.33em. `::first-letter` also takes
  `vertical-align`, `text-transform`, `word-spacing`, `line-height`, and
  `text-decoration`; `::first-line` takes the same set except `vertical-align`.
  A floated first letter is registered on the BFC float list, so a following
  block's line boxes shorten beside it. A `display: inline` element whose only child is text — or a nested chain of
  such inlines — participates in the parent's line breaking, including when
  `vertical-align` is not baseline. The alignment shifts that text against the
  line. Each element in the chain keeps a fragment. An inline with more than
  one child stays one atomic box.
- Flex/grid/table algorithms unchanged (Phase 1b).
- `will-change: transform`, `opacity`, or `filter` promotes a compositing
  layer. Other hints (`scroll-position`, `contents`) do not. No
  scroll-driven animations.

## Proposed Mechanism

### Containing-block stack

`layoutBlock` keeps `absStack: AbsRequest[]`. When a child is out-of-flow:

- `position:absolute` — pushed onto the stack; the nearest ancestor whose
  `position` ≠ `static` or that `hasTransform` claims ownership and drains
  the stack at the end of its own layout.
- `position:fixed` — same queue, but marked `fixed`; only the ICB drains
  it *unless* a transformed ancestor intervenes (Transforms §4: a
  transform establishes the containing block for fixed descendants too).
- Drained requests resolve `top/right/bottom/left` against the owner's
  **padding box** (`readInsetValue`/`readInsets`), fall back to the
  static-position edge when the inset is `auto`, and are placed by
  `placeAbsoluteFragment` in owner-local coordinates.

### Sticky

Sticky boxes lay out in flow as usual, then `layout()` applies a
scroll-aware fixup: `top` clamps the border box to `scrollY + inset`
(bounded below by the containing block's bottom minus the margin-box
height); `bottom`/`left`/`right` mirror. The fixup re-runs on every
`scrollY` change — no separate sticky layer.

### Stacking order

Each `layoutBlock` groups its children for paint order:

```
negative-z positioned  →  normal flow / floats  →  z ≥ 0 / auto positioned
```

`z-index` is read per child (`readZIndex`); equal-z members keep document
order (stable). The same three-group ordering applies at the ICB drain in
`layout()`.

### Transforms in paint

`readLayer(style)` composes `transform` plus `translate`/`rotate`/`scale`
into a single matrix; `originRelativeMatrix` bakes `transform-origin`
(resolved against the box's border-box size: keywords, percentages,
lengths) into `T(origin) · M · T(−origin)`. Paint emits `push-layer`
with the baked matrix, `opacity`, `filter`; `pop-layer` closes it.

### Inline run placement

`layoutInlineRun` tokenizes text into `TextMember`s (carrying
`hardBreaks: Map<wordIndex, count>` for `pre` line feeds) and
`AtomicMember`s (carrying `valign`, `baselineOff`, `fontSize`). After the
greedy break loop:

1. Each line's baseline = `lineTop + max(strutAscent, text ascents)`.
2. Atomic tops come from `verticalAlignTop`, which takes
   `baselineDelta` (baseline − lineTop) and subtracts `baselineOff` —
   arithmetic ordered so identical doubles cancel exactly (no
   `30 + 12.8 − 12.8` residue).
3. `grownBottom` absorbs aligned members taller than the line box; the
   line height is written back so later lines and the block height see
   the real extent.

`text-indent` narrows the first line's span; `text-align` shifts each
line inside its span; hard breaks close the current line N times (empty
lines get strut height).

### Media environment

`MediaEnvironment` gains `height`, `orientation`, `resolution` (dppx),
`prefersColorScheme`, `prefersReducedMotion`, `hover`. The evaluator
handles range syntax and unit conversions; `page.ts` builds it from the
`EngineViewport`; `live.ts`/`fine.ts` accept a media slot so incremental
re-layout re-evaluates the same queries.

## Stage Boundary Check

- Upstream stages read: `DomTree`, `ComputedStyle`, `EngineViewport`.
- Downstream stages written: `FragmentTree` (geometry only — no new IR
  fields), `DisplayList` (`push-layer`/`pop-layer`/`transform` already
  existed).
- IR boundary used: fragments remain **parent-local** — `offsetFragment`
  moves only the fragment's own edges; descendants keep owner-local
  coordinates. Paint accumulates; layout never emits document space.
- New generated surface: none (`transform-origin`/`translate`/`rotate`/
  `scale` were already generated `ComputedStyle` fields).
- Manual invalidation API added: `scrollY` is a pure layout *input*; a
  scroll changes layout, not a repaint hack.
- Silent stub path added: no — absent `vertical-align`/`position` values
  resolve to spec initials (`baseline`/`static`).

## Evidence Plan

```bash
npm run typecheck && npm run lint && npm run test
npm run wpt:subsets && npm run evidence
```

- Layout suite: 45 positioned-geometry tests (CB ancestor walk, % insets,
  scroll-pinned fixed, sticky clamps, transform capture, z-order), 135
  total green.
- Paint suite: transform-origin, individual longhands, matrix bake —
  12/12.
- e2e: `e2e-layout-compositing` 63/63 — text at padded content origin,
  inline-block baseline on the same line, real-document checks.
- WPT phase-2 subset restored to 25/25; maintained subsets 462/462.

## Alternatives Considered

1. **Keep `fixed`≈`absolute`, `sticky`≈`relative`.** Rejected — scroll
   behavior is the whole point of the values; an approximation that fails
   on the first scrolled page is worse than absent.
2. **Global-coordinate fragments.** Rejected — the parent-local invariant
   is what makes `offsetFragment` O(1); flattening would couple every
   positioned move to its whole subtree.
3. **Bottom-edge baseline for every atomic.** Rejected — spec splits
   text-bearing boxes (text baseline) from empty `inline-block`/replaced
   (bottom margin edge); the unified rule regressed 9 real-document
   tests.

## Risks

- `middle`/`sub`/`super` fractions are approximations until the shaper
  reports real x-height/sub/sup offsets — flagged in Non-Goals.
- Sticky fixup runs on the block's own post-layout pass; deeply nested
  sticky-in-sticky corners are exercised but exotic pages may expose
  ordering the tests don't cover.
- The metrics shaper's `0.8em` ascent is a stand-in; real HarfBuzz
  ascents will shift baselines by a few tenths of a pixel — tests assert
  with tolerance or relative relations, not magic constants.

## Rollback

The batch is additive: `absStack`/`stickyFixups` are locals inside
`layoutBlock`; `verticalAlignTop`/`atomicBaselineOff` are new helpers;
`MediaEnvironment` fields are optional. Reverting = deleting the
dispatch branches — the pre-batch code path (in-flow only) is untouched.

## Boundary

- Geometry for `::first-letter` stays in the fragment. `LaidGlyph.fontSize`
  is optional; paint splits a text command when a glyph carries its own size
  so the backend can rasterize that glyph at that size. No new IPC, no
  backend changes.
- Honest gaps: `::first-letter` and `::first-line` are `font-size` and `color`
  only, on the block's own text run (see Non-Goals). Scroll-driven animations.
  `middle` uses `OS/2.sxHeight` when the font has it. `will-change: transform|opacity|filter`
  promotes a layer; other hint keywords do not.

## Test plan

- position: relative in-flow offset; absolute vs positioned ancestor;
  % inset vs padding box; fixed under `scrollY`; sticky clamp + bottom
  bound; transform capturing fixed/absolute; negative/auto z-index order;
  stable equal-z document order.
- IFC: text-align left/right/center/justify; line-height; text-indent;
  `pre`/`pre-wrap`/`pre-line`/`nowrap`; hard `\n` including consecutive;
  vertical-align each keyword/length/percent; baseline for empty vs
  text-bearing inline-blocks; line-box growth.
- transforms: origin keywords/percent/length; `translate`/`rotate`/`scale`
  composition; opacity+transform layers.
- @media: width/height/orientation/dppx/prefers-*/hover, range syntax,
  live `setMedia` re-evaluation.
- Full regression: 1383 tests, WPT 462, constitution/scoreboard/lint
  gates — all green at merge.
