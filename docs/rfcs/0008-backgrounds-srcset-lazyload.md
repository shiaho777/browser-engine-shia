# RFC 0008: Background Layer Model, DPR-Aware `srcset`/`sizes`, and `loading` Semantics

- **Status**: Implemented
- **Depends on**: RFC 0007 (image codecs — `DecodedImage`), RFC 0005 (computed-style plumbing)

## Context

Three deliberately shallow seams remain after RFC 0007 wired decoding:

1. **`background-image` is single-layer, stretched, unpositioned.** The paint
   path takes the FIRST `url()`, ignores `background-position`, `repeat`,
   `origin`, `attachment`, and multi-layer lists, and implements
   `cover`/`contain` by CROPPING PIXELS — which is wrong for `contain` (it must
   shrink the destination rect, never cut the bitmap). No `background`
   shorthand expansion exists at all.
2. **`srcset` picks by "closest to 640px"** — a heuristic unrelated to the
   spec's density algorithm (`w` descriptors ÷ `sizes` slot width vs device
   pixel ratio). `sizes` is never parsed.
3. **`loading`/`fetchpriority` are unread** — the app's image ranking is a
   geometry heuristic pile that treats eager and lazy images identically.

## Design

### A. `op:"tile"` — one honest command for repeated backgrounds

```ts
{ op:"tile", area: Rect, src: DecodedImage,
  tile: { width: Px; height: Px },      // concrete tile size (post bg-size)
  origin: Point,                         // doc-space position of tile (0,0)
  step: { x: Px; y: Px },               // tile advance (== tile, or + gap for `space`)
  repeatX: boolean, repeatY: boolean,   // false → single tile on that axis
  radius?: Px }
```

`image` stays for single placements; `tile` is emitted whenever any axis
repeats (and degenerates cleanly when both are off). All three backends
implement it: screenshot/gpu loop clipped blits; Skia loops `drawImageRect`
under a clip (`fastSample` preserved — oracle semantics).

### B. The layer engine (paint `emitBackground` rewrite)

Per CSS Backgrounds §2/§3, each comma-separated layer resolves independently
over its **positioning area** (`background-origin`; `background-attachment:
fixed` switches the area to the viewport rect — paint gains a `viewport`
option) and clips to **`background-clip`**. Missing list entries repeat the
last value (spec list-matching rule).

- **size**: `auto`, `cover`, `contain`, `<length>`/`<%>`{1,2} — `cover`/
  `contain` produce a SCALED tile rect (the contain-crop bug dies).
- **position**: 1–4 value syntax (`right 10px bottom 20px` edge-offsets,
  `%`/lengths vs `area − tile`).
- **repeat**: `repeat[-x|-y]`, `no-repeat`, `space` (edge-touching equal gaps;
  position ignored when ≥2 fit), `round` (tile rescales so a whole count fits).
- Multi-layer: painted back-to-front in list order (first layer on top).
- `background` shorthand expands in the generator: url/color/position[/size]/
  repeat/attachment/box keywords per layer; unparseable → refuse expansion.
- Removed: `backgroundImageWithSize` pixel-crop hack.

### C. `srcset`/`sizes` — the spec selection algorithm

`imageSourceCandidates(img, {dpr, slotWidth})` parses `srcset` into
`{url, w|x}`, resolves `sizes` (media-condition list evaluated with the
document viewport — reusing/generalizing `link-rel`'s matcher; default
`100vw`), computes each `w` candidate's density `w/slot`, and orders by the
spec rule: smallest density ≥ dpr wins; else the largest density. `x`
candidates compare directly. Invalid entries drop; the attribute-order
fallback list remains for fetch retries.

### D. `loading` / `fetchpriority` (app/page.ts)

- `loading="lazy"` gates fetch to within the load-in margin (one viewport
  beyond `scrollY`); `eager`/absent keeps the current visibility ranking.
- `fetchpriority="high"` bubbles the image to the front of the picked queue;
  `low` sinks it.
- The visibility ranking itself is unchanged — this RFC layers the attribute
  contract on top, honestly.

## Non-goals

- `background-attachment: fixed` needs the viewport at paint time; without a
  `viewport` option it falls back to `scroll` (recorded, not faked).
- `<picture>`/`<source>` selection, `image-set()`, gradients, `border-image`,
  `background-blend-mode`.
- Animated backgrounds — decoded raster stays first-frame (RFC 0007).
- `calc()` inside `sizes` — unsupported → the entry is skipped.

## Verification

- paint unit tests: position/size/repeat/origin/clip matrices on a fixed
  fragment; `space` gap math; `round` rescale; multi-layer order; `fixed`
  origin. All asserted on emitted `tile`/`image` commands (geometry is the
  contract).
- shorthand-expansion tests: `background:` layer splits incl. `pos/size` slash.
- images.test.ts: `w`+`sizes` vs dpr picks the right URL; `x` density order;
  malformed entries skipped.
- page-level: `loading=lazy` below the fold is NOT fetched; `eager` is;
  `fetchpriority=high` outranks a larger visible image.
- Full gate + evidence regen.
