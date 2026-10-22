# RFC 0025 — Vertical writing modes: logical→physical mapping, virtual-space transposition, glyph orientation

Status: implemented (transposition model, documented bounds)
Packages: `cascade` (`index.ts` — flow axes + logical-winner remapping),
`generator` (`shorthand-expansion.ts` — logical shorthand expansion),
`ir` (`fragment-tree.ts` — `TextRun.advanceAxis`/`writingMode`,
`LaidGlyph.rotate90`), `layout` (`index.ts` — virtual space +
`remapSubtree`), `cli` (`vertical-writing.test.ts`)

## Decision

**Vertical layout is not a second engine — it is a coordinate
transposition.** A `writing-mode: vertical-*` subtree is laid out by the
*existing* horizontal pipeline in a **virtual space** where the CSS inline
axis is virtual-x and the block axis virtual-y; a post-pass
(`remapSubtree`) then maps the emitted fragment subtree into physical
geometry. This works because the pipeline was already written against the
abstract model: every fragment's rects live in the frag space whose origin
is its own margin-box TL, and children are positioned relative to their
parent's margin-box origin — so a single rect map

```
v-rl:  px = physX + physW − (vy + h)      py = physY + vx
v-lr:  px = physX + vy                    py = physY + vx
(rtl inside vertical flips the y-map the same way)
```

applied recursively (each frag's stored rects in its parent's space)
produces correct physical geometry for *all* box layers — margin/padding/
border/content — because the margin box already carries the margin and the
flip references the *margin-box* extent.

**Logical properties resolve in the cascade, not in layout.** The generator
expanded logical shorthands into logical longhands; the cascade now maps
logical longhand names onto physical property names using the element's
own `writing-mode` + `direction` — *before* computed-value resolution — so
`margin-inline-start` and `margin-top` compete for the same slot under the
normal origin/layer/specificity/source-order rules (`beats` re-run). This
is the correct layer: every downstream consumer (layout, paint,
`getComputedStyle`) reads physical fields and stays honest.

Inside a virtual space, `activeStyleOf` permutes each element's *physical*
edges back into virtual order (`margin-top` → virtual margin-left for
v-rl…), swaps `width`↔`height`, and reads `writing-mode` as
`horizontal-tb` — the whole horizontal pipeline runs unchanged.

## Nested modes

`computedStyleOf` still reads the *real* writing-mode (inheritance makes a
same-mode child compare equal to the space's mode, so it stays inside;
this is correct — its physical result is the same transposition). A
**perpendicular or different-axis child** (`horizontal-tb` inside
`vertical-rl`, or `vertical-lr` inside `vertical-rl`) goes through
`layoutOrthogonal`: it is laid out in true physical space — a nested
vertical mode runs its own `layoutVertical` and gets real physical
geometry — then `remapSubtree(…, toPhys=false)` stores the subtree
*pre-transposed* so the outer pass lands it correctly. Text runs carry
their final `writingMode` marker so the outer pass skips re-rotation.

## Text orientation

`LaidGlyph.rotate90` flags the glyphs a paint backend must rotate 90°
clockwise. Under `text-orientation: mixed` (and `vertical-*`), the
vertical-native classes — ideographic/kana/`CJ` via the UAX #14 classifier
— stay upright while Latin/digits/punctuation rotate; `upright` rotates
nothing; `sideways` and `sideways-*` writing modes rotate everything
(`sideways` is orientation, not flow). `TextRun.advanceAxis` is `x` or `y`
and `writingMode` records the run's final mode, so paint can pick the
correct baseline axis without re-running the classifier.

`sideways-lr` is the one case where the inline axis *differs* from its
`vertical-*` partner: a horizontal box rotated 90° CCW sends ltr text
bottom→top, so `inlineFlip` is inverted (`dir === "ltr"` ⇒ flip) in both
the cascade `flowEdges` and the layout `spaceMapFor`.

## Evidence

- `vertical-writing.test.ts`: **20/20** — cascade mapping (all four modes,
  rtl interplay, shorthand expansion, source-order re-competition),
  column stacking directions (rl vs lr), inheritance, block progression,
  rtl inline start at the bottom, physical margin/padding edges, two kinds
  of nested modes, all three `text-orientation` values, `sideways-rl`
  forced sideways, horizontal-tb byte-identical regression.
- `npm run ci`: **1552/1552**, WPT 462/462 — zero horizontal regressions.

## Bounds

1. **Glyph metrics are unrotated**: `rotate90` is a flag for the paint
   backend; glyph `x`/`y`/`advance` are transposed positions with the
   advance mapped along the block axis. Real CJK OpenType `vert`/`vrt2`
   substitution and true vertical origin/baseline metrics are font-layer
   work — the metadata is the hook.
2. **Vertical containing block from the inline offer only**: a vertical
   element's inline extent (physical height) is the parent's
   `containingHeight` when definite, else the viewport height — vertical
   text in an auto-height block wraps at the viewport height, not the
   eventual content height.
3. **Orthogonal children's width offer is the parent's block extent**
   (usually indefinite → the child behaves like an unbounded
   shrink-to-fit context and can overfill the column band; CSS
   Writing Modes §7.3's full orthogonal sizing pass is not implemented).
4. **Replaced elements transpose like boxes**: an `<img>` inside vertical
   text gets a swapped box (w↔h); per spec replaced content should keep
   physical orientation and size from logical props — a paint-side
   counter-rotation would be needed for pixel-faithful images.
5. **Floats/`clear` are already logical** (float:left = line-left edge)
   and transpose correctly; `position:fixed`/`sticky` fixes resolve against
   physical viewport axes — sticky inside vertical text tracks `scrollY`,
   not the block scroll position.
6. **`text-orientation` has no per-codepoint `vert` fallback table**:
   the mixed/upright decision uses the line-break class table, so rare
   scripts that should stand upright (e.g. Mongolian) rotate.
7. `writing-mode` on `<html>` works (it becomes the document's space),
   but `direction` propagation from `<html>` onto `body`'s space is the
   one not exercised by the suite beyond the direct case.
