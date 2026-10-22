# RFC 0039 — Paint Invalidation + Retained Surface

Phase 6 (perf). Before this RFC every repaint rasterized the full display
list into a fresh pixel buffer — a no-change repaint did the same work as a
first paint, and a single-character edit repainted the whole viewport.

This RFC adds **display-list diffing → damage rects → scissored repair into
a retained surface**. The output contract is unchanged: every frame still
produces a complete, correct `Uint8ClampedArray`; damage only restricts which
pixels are recomputed.

## Data flow

```
prev clipped commands ─┐
                        ├─ diffCommands ──► damage = ∪ bounds(changed middle)
next clipped commands ─┘        + prev/next focus-overlay bounds
                                     │
        ┌────────────────────────────┤
        ▼                            ▼
  damage = null               renderDisplayListOnGpu(list, …,
  → retained pixels as-is         { damage, into: prev.pixels })
                                   ├─ translate: skip draw ops whose
                                   │   bounds miss the damage rect
                                   └─ renderProgram: clipStack[0]=damage
                                       fills scissored · layer composite
                                       clipped · damage rect cleared to bg
```

## The differ (`ir/display-diff.ts`)

Prefix+suffix trim on command arrays — not a full LCS. Insertions and
localized edits realign through the suffix; an arbitrary shuffle damages the
union of both middle spans (over-damage is safe, never wrong).

- `paintCmdEqual` deep-compares per op. `image`/`tile` compare `src` by
  **identity**: every producer mints a fresh `DecodedImage` when pixels
  change (canvas rasterize returns a new object when dirty, media
  materializes a new frame per timestamp, decoded `<img>`s are stable), so
  identity equality is the correct change detector.
- `paintCmdBounds` gives each draw op's paint footprint. `text` bounds are
  computed from glyph offsets+advances+fontSize — not a fixed box guess.
- Envelope ops (`push-clip`, `pop-clip`, `push-layer`, `pop-layer`) inside a
  changed span contribute the caller's `unbounded` rect — a changed clip or
  layer envelope can redirect output arbitrarily far.

## Scissored repair (`gpu/executor.ts`)

`renderProgram(program, { damage, into })`:

- `into` is the previous frame's `pixels` — reused only when its size
  matches. Otherwise, or when `damage` is absent, a fresh buffer is
  allocated and fully cleared (exactly the old behaviour).
- With damage: only the damage rect is re-cleared to the background, the
  clip stack seeds at the damage rect, and every fill op is scissored
  through it. `compositeLayer` is clipped to the damage rect — pixels
  outside damage provably retain the previous frame's content.
- **Self-enforcing guard**: the executor pre-scans for `push-layer` commands
  with a non-identity `transform` or a `filter`. Both resample/write outside
  their own content bounds (transform samples anywhere; blur bleeds at
  edges), so their presence drops the damage hint to a full render — the
  caller cannot express "layer output changed only inside my rect" honestly.

Translate-level skip in `renderDisplayListOnGpu` removes draw ops whose
bounds miss the damage rect entirely; envelope commands are never skipped
(a clip's bounds are not the bounds of the content it gates, and dropping
`push-clip` alone would orphan its `pop-clip`).

`applyCommand`'s `clear` now honours the clip stack — previously it ignored
clips and would have wiped a retained buffer whole.

## Page wiring (`app/page.ts`)

- `PageState.raster` retains `{ commands (clipped list), pixels, w, h,
  focusRect }`; `PageState.paintDamage` reports the last render's diff
  stats (`unchangedCommands`, `changedCommands`, `damageArea`,
  `identical`, `repaired`) for the benchmark surface.
- `renderWithDamage` computes `damage = diff ∪ prev.focusRect ∪
  next.focusRect` — the focus overlay paints post-raster into the same
  buffer, so its bounds must damage or stale ring/caret pixels persist.
  A null diff short-circuits: the retained buffer is returned untouched
  (`identical: true`), skipping rasterization entirely.
- Both repaint paths (`renderDom` via `repaintPage`, and `fastScrollPaint`)
  go through it. Scroll shifts nearly all command positions, so scrolling
  correctly degrades to ~full-viewport damage.

## Evidence

`benchmark-evidence.json → paintDamage`: 120 static panels + one text edit
→ `repaired: true`, `partialCorrect: true` (byte-identical to a fresh full
load), no-change repaint is a raster no-op, damage ≈ 2% of viewport.
`warmRepaintMs`/`coldRepaintMs` are whole-`repaintPage` wall-times —
dominated by layout+PNG encode — reported as context, not as a raster
speedup claim. The fill-level savings scale with damage area, not repaint
time.

## Honest boundaries

- **What is saved**: per-pixel fill work inside the undamaged region, layer
  compositing outside damage, and the whole raster pass on identical frames.
  Command translation, layout, style, and PNG encode still run per frame.
- Single damage **rect** (union), not a damage region set — two far-apart
  changes produce a large union. Real engines keep per-layer tile grids;
  that granularity needs retained tiles we don't have.
- Layers with `transform`/`filter` force full renders — damage-aware layer
  resampling needs per-layer retained offscreens (real layer tree) — not
  built.
- The differ is prefix/suffix, not LCS — a reordering of equal content
  damages the union of both middles rather than aligning moves.
- `<canvas>`/media/`img` change detection depends on producers minting new
  `DecodedImage` objects on mutation — true today; a future in-place
  mutating producer must go through a version channel or images will diff
  clean when they shouldn't.
- GPU-command `clear` is now clip-scissored — a semantic fix the retained
  path requires; band-parallel clearing unchanged.
