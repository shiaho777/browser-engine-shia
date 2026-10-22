# RFC 0023 — Bidi (UAX #9): real level resolution, element semantics, paragraph-wide reordering

Status: implemented (X/W/N/I rules complete, documented range-table bounds)
Packages: `layout` (`bidi.ts` — full rewrite; `index.ts` — paragraph stream +
container wrap + direction-aware `text-align`), `cli` (`fine.ts` — `dir` in
the struct channel; `stylesheets.ts` — UA bidi rules; `bidi.test.ts`)

## Decision

**The paragraph — not the text node — is the unit of bidi resolution.** The
old `bidi.ts` resolved each text member independently inside a pragmatic
subset (no explicit controls, no isolates, no bracket pairs, neutrals by
nearest-neighbor). The rewrite runs the real UAX #9 pipeline over the whole
inline run:

- **Classification** — the full Bidi_Class space: strongs (`L`/`R`/`AL`),
  weak types (`EN`/`ES`/`ET`/`AN`/`CS`/`NSM`), neutrals (`B`/`S`/`WS`/`ON`),
  boundary neutrals (`BN`), and the nine explicit-format characters
  (`LRE`/`RLE`/`PDF`/`LRO`/`RLO`/`LRI`/`RLI`/`FSI`/`PDI`) — over a range
  table, not per-block heuristics.
- **P1–P3** — `B`-class characters split the stream into paragraphs; each
  resolves its own base (explicit `direction`, or first-strong when the
  container is `dir=auto`/`plaintext`).
- **X1–X10** — a directional-status stack: embeddings push even/odd levels,
  overrides force strong types, isolates re-base their interior and return
  to the embedding level on `PDI`, `FSI` scans its interior's first strong
  to pick LRI-vs-RLI, `PDF` pops only within the current isolate scope, and
  depth is capped at 125. Format controls + `BN`s mark `removed` and leave
  no glyph.
- **W1–W7** — `NSM` inherits its base character's class, `EN` after `AL`
  becomes `AN`, `ES`/`CS` between matching digits join them, `ET` adjacent
  to `EN` becomes `EN`, leftover separators drop to `ON`, `EN` after `L`
  becomes `L`.
- **N0–N2** — paired brackets (`()[]{}`) match on a stack and resolve
  against their interior + surrounding strongs (the `"(אבג)"` parens stay
  on the correct side); remaining neutral runs take matching surrounding
  strongs or the embedding direction.
- **I1/I2** — implicit level bumps (odd-embed `L`/`EN`/`AN` → +1; even-embed
  `R` → +1, `EN`/`AN` → +2).
- **L2** — run-granularity visual reordering, per paragraph.

### `visualOrderParts` — the layout seam

Layout feeds the paragraph as ordered pieces: one per text member, a
`U+FFFC` object character per atomic inline box (image, inline-block,
`<bdo>`/`<bdi>` element — objects participate in level runs and reorder
with them), plus injected control strings at the container edges. The
resolver returns visual-order fragments tagged with their owner, so each
chunk keeps its own font/metrics and shapes independently — the standard
"itemize, then shape each item" pipeline. `B`-class characters surface as
`hardBreak` parts, preserving the existing `pre*` newline machinery.

### Element semantics via the UA sheet + container wrap

`unicode-bidi`/`direction` are already computed-style fields. The UA sheet
maps HTML semantics (HTML §3.5.3, §14.4.4):

```
[dir]               { unicode-bidi: isolate }
[dir=ltr]/[dir=rtl] { direction: ltr / rtl }
bdi, output         { unicode-bidi: isolate }
bdo, bdo[dir]       { unicode-bidi: bidi-override }  /* [dir] outranks bdo otherwise */
```

The element whose inline content a run belongs to (the container) then
applies its own `unicode-bidi` by *wrapping the paragraph stream* in the
corresponding explicit codes — `bidi-override` ⇒ `LRO`/`RLO`…`PDF`,
`isolate-override` ⇒ `LRI`/`RLI`+`LRO`/`RLO`…`PDF`+`PDI` — so the X rules
do the rest unchanged. `dir=auto` (and `plaintext`) switches the base to
per-paragraph first-strong; `dir` is kept on the struct channel so the
fine path sees it (`attr` edits invalidate layout correctly).

This reaches **both** text paths: `layoutInlineRun`'s member stream, and
the single-text fast path (`layoutInline`), which now receives
`containerStyle` + `containerNode` from its bare-text call site — the same
context `text-indent`/`direction` were already meant to inherit.

### `text-align` is direction-aware

`start`/`end`/`justify` resolve against the paragraph direction (`start` on
an RTL block aligns to the right edge); `left`/`right` stay physical.

## Honest boundaries

- `Bidi_Class` is a hand-audited range table, not the generated UCD —
  scripts outside the listed ranges classify as `ON` (they still resolve
  as neutrals, which is safe: content survives, order is approximate).
- The bracket-pair table covers `()[]{}` only (BidiBrackets subset);
  mirrored-glyph substitution (e.g. `(` → `)` in RTL) is the font's job.
- `L1` (per-line trailing-whitespace level reset) is not run — line
  breaking feeds whole paragraphs to the resolver.
- Inline elements are atomic boxes in this engine (pre-existing model):
  a `<bdo>`/`<bdi>`/`[dir]` element's *outer* relationship to the
  paragraph is a neutral object either way — the difference vs. a real
  browser shows only at boundary neutrals around the box.
- `textarea[dir=auto]`/`input[dir=auto]` should use `plaintext` per HTML;
  they currently take the same isolate path.
- `unicode-bidi:plaintext` approximates as per-paragraph first-strong
  (no separate plaintext wrap semantics).
- Words never span member boundaries — a run crossing a text-node edge
  splits into per-owner parts, each ordered correctly (identical to the
  previous word model).

## Evidence

- `bidi.test.ts`: **23/23** — class table coverage (strongs/weak/neutrals/
  `BN`/all nine controls), `RLO`/`RLE`/`PDF`/`RLI`/`FSI`/`PDI` level
  resolution, `PDF`-cannot-cross-isolate, unmatched-control robustness,
  digits-in-RTL (`W7`/`I2`), `N0` parens, `visualOrderParts` owner
  mapping + `hardBreak` + per-paragraph bases; pipeline tests for
  `direction:rtl` word order + `start`-edge alignment,
  `bidi-override`/`isolate-override`, `dir=rtl`/`dir=auto` through the UA
  sheet, `<bdo dir=rtl>`/`<bdi dir=auto>` element semantics, atomic
  reordering inside RTL paragraphs, preserved-newline interaction, and a
  pure-LTR byte-identical guard.
- Existing `bidi.test.ts` (unit, `layout`): 15/15 — unchanged API.
- Full suite: **1510/1510**; WPT subsets 462/462 (unchanged).
- `npm run ci` all gates green.
