# RFC 0002: Real text shaping — HarfBuzz behind the `TextShaper` seam

Status: Draft

Owner: engine contributors

Labels:
`rfc`, `stage:layout`, `stage:font`, `stage:backend`, `phase:4-i18n`

## Decision

Land real text shaping by reusing **HarfBuzz** via `harfbuzzjs` (the official
HarfBuzz WASM build maintained by the HarfBuzz project, pinned `1.6.2`), wired
into the `TextShaper` seam that `layout` has injected since task 5.7. Glyph
identity in the IR becomes real: `LaidGlyph`/`Glyph.glyphId` stops carrying a
Unicode code point and carries the font-local glyph id a shaper produced, plus
a `faceIndex` naming which face of the pipeline font table it belongs to. The
"resolve code point → (face, gid)" machinery currently duplicated inside every
backend (`fallbackCoverageSource` slot ids, the Skia face chain) moves upstream
into the shaper where it architecturally belongs; backends consume
`(faceIndex, gid)` directly.

This is the manifesto's reuse doctrine applied to the last handwritten
placeholder in the text path — shaping is irreducible dirty work (design.md
§11 names HarfBuzz explicitly), and `FontFace.data` (RFC 0001) already carries
the raw sfnt bytes HarfBuzz needs.

## Problem

Text is the weakest remaining placeholder in the pipeline:

1. **`glyphId` is a lie.** `placeWord` emits `ch.codePointAt(0)` as the glyph
   id; every backend then re-derives font selection and cmap mapping. Three
   copies of the same resolution logic (CPU coverage source, GPU translator,
   Skia face chain) must agree by convention alone.
2. **No shaping intelligence exists.** `pipelineShaper` sums per-codepoint
   advances. No kerning, no ligatures, no combining-mark positioning, no
   Arabic joining, no RTL. "AV" measures as A+V; "fi" draws two glyphs; marks
   render as full-width boxes.
3. **The call site defeats any real shaper.** `placeWord` calls
   `shapeLine(ch)` **per character** — even HarfBuzz behind that signature
   cannot kern, because it never sees more than one code point of context.
4. **The bidi machinery is dead code.** `bidi.ts` implements UAX #9 levels,
   visual reordering, and script itemization — tested, exported, and invoked
   nowhere. Real shaping is what makes direction/script runs meaningful.

## Goals

- A `font`-package HarfBuzz adapter producing real `(faceIndex, gid, advance,
  xOffset, yOffset, cluster)` glyph streams, consumed through the existing
  `TextShaper` injection point (`layout(..., { shaper })`).
- Itemization inside layout: a text node's string is bidi-itemized FIRST
  (UAX #9 subset) → runs L2-reordered to visual order → each run split into
  whitespace-free tokens (odd-level runs yield their words in reverse order) →
  each token itemized again and shaped per its own runs with direction +
  script tag → `hb_shape`. Real directional shaping of Hebrew/Arabic.
- Engine-owned per-glyph font fallback (HarfBuzz deliberately does not do
  this): shape a run on the first face, detect `.notdef` (gid 0) clusters,
  re-shape the missing span on the next face, recurse.
- IR: `Glyph`/`LaidGlyph` gain `faceIndex`; `ShapedGlyph` gains `glyphId`,
  `faceIndex`, `xOffset`, `yOffset`, `cluster`; `ShapingFont` gains optional
  `direction`/`script`/`language` hints.
- Backends simplify to trusting the IR: `raster(faceIndex, gid, sizePx)` for
  the CPU/GPU coverage paths; `typefaces[faceIndex]` + real gids for Skia.
- The placeholder shapers (`metricsShaper`, `proportionalShaper`) keep working
  by emitting honest defaults (`faceIndex: 0`, `glyphId: codePoint`, zero
  offsets) — clearly labelled test scaffolding, unchanged.

## Non-Goals

- **No cross-member / cross-line bidi reordering.** Word-level L2 lands via
  `visualWords` (itemize the member's whole text → L2 run order → odd-level
  runs yield reversed words), so multi-word RTL inside one text node is
  correct. Runs spanning MULTIPLE text nodes or reordering AFTER line
  breaking (UAX #9 L2 across line boxes) still need run-aware line boxes —
  documented boundary, follow-up work.
- No `font-feature-settings`/`font-variant` CSS plumbing — the adapter accepts
  a feature list, but no generated CSS property feeds it yet.
- No font fallback *inside* a grapheme beyond the `.notdef`-span loop (no
  UAX #29 grapheme itemization; HarfBuzz cluster granularity suffices).
- No emoji/COLR color glyphs, no variable-font axes, no vertical text.
- No shaping-cache optimization layer (a `(text,font)→run` memo can follow
  under the kernel once profiling says so).

## Proposed Mechanism

```
DomTree text node
  └─► layout: text → bidiRuns → L2 → per-run whitespace split (visual words)
        └─► per word: bidiRuns → L2 → per-run script tag →
            TextShaper.shapeLine(runText, {fontSize, fontWeight, direction, script})
              └─► font/HarfBuzzAdapter: hb.Buffer(dir, script) → hb.shape(face.hbFont)
                    ├─ all gids ≠ 0 → emit (faceIndex=i, gid, pos…)
                    └─ gid 0 spans → regroup contiguous missing clusters
                          → shape span on next face → splice
        └─► LaidGlyph { faceIndex, glyphId, x, y, advance }
  └─► paint copies run → DisplayList `text` { glyphs, fontSize, fontWeight }
  └─► backend: faces[faceIndex] → (Skia typeface | outline rasterizer) + gid
```

### `font` package owns the adapter

Shaping is font machinery, so `packages/font` exports:

```ts
export interface ShapedGlyphOut {
  readonly glyphId: number;   // real font-local gid
  readonly faceIndex: number; // index into the face table given at creation
  readonly advanceEm: number; readonly xOffsetEm: number; readonly yOffsetEm: number;
  readonly cluster: number;   // UTF-16 index of the source cluster start
}
export interface ShapeRequest {
  readonly text: string; readonly direction: "ltr" | "rtl";
  readonly script?: string; readonly language?: string;
}
export interface HarfBuzzShaper {
  shape(req: ShapeRequest): readonly ShapedGlyphOut[]; // em units
}
export async function createHarfBuzzShaper(
  faces: readonly FontFace[], boldFaces: readonly FontFace[],
): Promise<{ shaperFor(weight): HarfBuzzShaper; faceTable: readonly FontFace[] }>
```

The adapter returns positions in **em units**; layout scales by `fontSize`
(the `TextShaper` seam stays pixel-facing, unchanged signature). The single
master `faceTable` (deduped union of regular + bold lists) is what
`faceIndex` indexes — backends receive the identical table at construction, so
weight-based face *selection* lives only in the shaper.

`harfbuzzjs` initializes by top-level-await inside its own module
(`await import("harfbuzzjs")` resolves only when WASM is ready). `cli/fonts.ts`
performs that import at module top level, making the pipeline modules async-
evaluated under Node ESM — zero call-site plumbing, and a `TextShaper` that is
synchronously callable once the graph resolves.

### Fallback loop

HarfBuzz shapes on one face; glyphs whose source cluster covered no cmap entry
come back `gid === 0`. The adapter collects contiguous `.notdef` cluster spans
and re-shapes each span on the next face until a face covers it or the table
is exhausted; an exhausted span keeps `gid 0` — painted as `.notdef` (honest,
never fabricated).

## Stage Boundary Check

- Upstream stages read: DomTree text + ComputedStyle font fields (unchanged).
- Downstream stages written: `LaidGlyph`/`Glyph` IR (additive `faceIndex`;
  `glyphId` semantics documented: code point → real gid).
- IR boundary used: `FragmentTree.text`, `DisplayList.text` (additive).
- New generated surface: none.
- Manual invalidation API added: no.
- Silent stub path added: no (`.notdef` is drawn visibly, never skipped
  silently; a face without `data` contributes coverage but cannot serve the
  Skia path and is skipped loudly in the face table contract).

## Evidence Plan

```bash
npm run typecheck
npm run lint
npm run test            # new font/shaper + layout shaping tests
npm run wpt:subsets -- --trace
npm run evidence        # text metrics change ⇒ rendered output changes honestly
```

Targeted evidence:

- `font` adapter tests: real gid output vs the face's own cmap; kerning pair
  advance ≠ naive sum when the face carries kern pairs; RTL input returns
  visual-order clusters; a code point uncovered by face 0 lands on the
  fallback face with the correct `faceIndex`.
- `layout` tests: `placeWord` consumes one `shapeLine` per run (no per-char
  calls); word widths reflect shaped advances; RTL runs carry
  `direction: "rtl"` through.
- Backend differential: Skia vs CPU oracle on shaped text (real gids, AA
  tolerance as RFC 0001).
- CLI smoke: Latin + Hebrew + Arabic + CJK mix rendered on all three
  backends.

## Alternatives Considered

1. **Keep code-point glyphs + per-codepoint metrics** — the status quo; the
   pipeline can never produce a ligature or position a mark. Rejected by the
   manifesto.
2. **Hand-write a minimal shaper** — explicitly the "irreducible dirty work"
   the project refuses to reimplement (design.md §11).
3. **ICU/Pango-style native binding** — no Node-WASM distribution story as
   clean as `harfbuzzjs` (which *is* HarfBuzz, compiled by the HarfBuzz
   project); a native binding can replace the wasm later behind the same
   adapter interface.
4. **Shape in paint instead of layout** — wrong layer: line breaking needs
   shaped advances, so shaping must precede layout decisions. The seam was
   placed correctly; this RFC fills it.

## Risks

- `harfbuzzjs` is ESM with top-level await — pipeline modules become async-
  evaluated; any consumer doing non-async module evaluation breaks loudly at
  load, not silently.
- Every text-bearing golden/differential image shifts (real metrics, real
  gids, real kern) — expected, absorbed by evidence regeneration.
- WASM adds ~2 MB and one async init per process; shaping runs per word per
  layout — perf is watched by the benchmark LOC/duration traces, not hidden.
- The `.notdef`-span fallback can re-shape degenerate cases repeatedly; spans
  are grouped contiguously and face count is small (2–3), so cost is bounded.

## Rollback

Remove `harfbuzz.ts` from `font`, restore `pipelineShaper` to the per-codepoint
implementation, and drop `faceIndex` handling (the field is additive — backends
can ignore it). IR additions are backward-tolerable: readers that ignore
`faceIndex` fall back to `faceIndex = 0` semantics.

## Open Questions

- Whether `faceIndex` should resolve through a DisplayList-embedded font table
  (self-contained serialization — Ladybird's cross-process display list shape)
  rather than the construction-time table. Chosen: construction-time table
  now; a serialized font table is a compatible later extension.
- Cluster-level choice (`ClusterLevel.MONOTONE_GRAPHEMES` vs default) once
  selection/editing consumes clusters.
- Promotion of the shaper to also serve `guest`'s canvas `measureText` path.
