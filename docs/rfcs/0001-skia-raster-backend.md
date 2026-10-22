# RFC 0001: Skia raster backend behind the `PaintBackend` seam

Status: Draft

Owner: engine contributors

Labels:
`rfc`, `stage:backend`, `stage:paint`, `phase:8-performance`

## Decision

Land a production raster path by adapting the `DisplayList` to **real Skia**
via `canvaskit-wasm` (the official Skia WASM build, pinned `0.41.1`), exported
as `createSkiaBackend(): Promise<SkiaBackend>` implementing the existing
`PaintBackend` contract `render(list, surface): void`. The existing
`ScreenshotBackend` (hand-written CPU raster) stays as the differential oracle
and the zero-dependency fallback; the `gpu` package pipeline stays as the
default `render` path until Skia parity is evidence-proven. This is the
"reuse the irreducible dirty work" move the manifesto prescribes (Skia is
explicitly on the reuse list) and the same DisplayList→Skia boundary Ladybird
implements.

## Problem

Rasterization today is hand-written twice over: `ScreenshotBackend`'s pixel
loops and the `gpu` package's software command pipeline. That buys three real
problems:

1. **Correctness ceiling.** Real antialiasing, rounded-rect clipping, affine
   transforms, CSS `filter` chains, and glyph rasterization are re-implemented
   by hand (box-blur ×3 pretending to be a Gaussian, widened coverage masks
   pretending to be bold).
2. **A silent coverage hole.** `paint` emits `line` commands for
   `text-decoration`; the GPU-path translator drops them silently and the CPU
   oracle throws `UnsupportedPaintCommandError`. Today an underline on a real
   page vanishes without a trace — the exact failure class the constitution
   forbids.
3. **Performance ceiling.** No tile cache, no SIMD-optimized blits, no path to
   hardware acceleration — and every optimization is hand-written LOC that
   counts against the compat-per-LOC denominator.

## Goals

- A `PaintBackend` adapter backed by real Skia covering **all nine** DisplayList
  ops, including `line` (which no existing backend renders).
- Real AA (analytic, not coverage-hack), real `RRect` clips, real affine layer
  transforms, real `ImageFilter`/`ColorFilter` filter chains, real glyph
  rasterization through FreeType-inside-Skia drawing the pipeline's own font
  files — the seam gains one additive field, `FontFace.data`, so backend and
  shaper resolve the identical font bytes.
- Byte-visible proof: a differential suite against `ScreenshotBackend` with a
  documented, justified tolerance (AA edge coverage differs legitimately).
- Zero upstream change: `DisplayList` IR, paint, layout, and the kernel are
  untouched; the adapter imports only `ir` + `font` + `canvaskit-wasm`.
- CLI opt-in: `render --backend=skia` (default stays `gpu`; promotion is a
  later evidence-gated decision, not this RFC's claim).

## Non-Goals

- No shaping change: `glyphId` still carries code points until HarfBuzz lands;
  the adapter maps cp→gid through the existing `GlyphCoverageSource` seam.
- No new IR fields (a `font` handle on `text` commands is a later RFC).
- No GPU-silicon WebGPU device here — the `gpu` package's `webgpu-device` seam
  remains the hardware path; Skia is the production *rasterizer*.
- No removal of `ScreenshotBackend` — it is the correctness oracle.

## Proposed Mechanism

```
DisplayList ──► SkiaBackend.render(list, surface)
                   │  canvas ops on a Skia raster surface
                   ▼
                readPixels(RGBA_8888, Unpremul) ──► Surface.pixels
```

Command mapping (all real Skia calls, nothing approximated):

| `PaintCmd` | Skia call |
| --- | --- |
| `rect` | `drawRect` / `drawRRect` (radius) |
| `border` | four edge `drawRect` fills (parity with oracle; styled edges later) |
| `text` | `drawGlyphs` per face-run; each code point resolves `(face, real glyphId)` through the pipeline's fallback face order — the same ordering `fallbackCoverageSource` applies. Faces carry their own sfnt bytes (`FontFace.data`, attached at parse) so Skia's FreeType scaler rasterizes the very font the layout stage measured against; weight ≥ 600 selects the bold face list, 500–599 get `Font.setEmbolden` |
| `line` | `drawLine` stroke — **new capability** |
| `image` | `MakeImage` + `drawImageRect` |
| `push-clip`/`pop-clip` | `save` + `clipRect`/`clipRRect` (AA) / `restore` |
| `push-layer`/`pop-layer` | offscreen `MakeSurface` per layer; pop composites with `concat` (row-major `Matrix`) + `Paint` carrying `alphaf` opacity and `ImageFilter` chain |

CSS `filter` functions map to `ImageFilter.MakeBlur` (`blur`) or
`ColorFilter.MakeMatrix` → `ImageFilter.MakeColorFilter` (grayscale, sepia,
saturate, invert, brightness, contrast, opacity) using the W3C filter-effects
matrices, composed with `MakeCompose`.

WASM memory is managed (`Paint`/`Surface`/`Image`/`TextBlob` `.delete()` after
use). Init is async once at factory time (`locateFile` resolves the packaged
wasm via `createRequire`), so `render` stays synchronous per the `PaintBackend`
contract.

## Stage Boundary Check

- Upstream stages read: none (consumes `DisplayList` + `Surface` only).
- Downstream stages written: none.
- IR boundary used: `DisplayList` (unchanged).
- New generated surface: none.
- Manual invalidation API added: no
- Silent stub path added: no (`line` support *removes* a silent-drop path; every
  op renders or the backend throws `UnsupportedPaintCommandError`).

## Evidence Plan

```bash
npm run typecheck
npm run lint
npm run test            # skia.test.ts + skia-differential.test.ts
npm run wpt:subsets     # unchanged gates stay green
npm run evidence        # regenerated artifacts absorb the new LOC
```

Differential suite vs `ScreenshotBackend`: geometry/clip/parity scenes at tight
tolerance; text and filter scenes at documented tolerance (Skia AA vs the
scanline coverage rasterizer legitimately differ at edges). A dedicated test
proves `line` commands paint pixels — coverage no existing backend provides.

## Alternatives Considered

1. **`@napi-rs/canvas` / `skia-canvas`** — real Skia, but only a DOM Canvas2D
   API: no positioned-glyph API, so our `glyphId` runs would degrade to
   per-glyph `fillText`. Rejected: loses the shaped-glyph seam HarfBuzz lands
   on.
2. **Extend the hand-written rasterizer** — keeps zero deps but grows LOC on
   the north-star denominator and stays below the correctness ceiling.
   Rejected by the manifesto's reuse doctrine.
3. **WebGPU-first via the `gpu` seam** — right long-term (hardware path) but no
   GPU is guaranteed in Node/CI; Skia raster is the production floor now.

## Risks

- WASM binary size (~7 MB) and first-init cost — paid once per process, behind
  an async factory; CI impact is bounded.
- AA differences vs the CPU oracle mean the differential suite needs a real
  tolerance policy; documented, not hidden.
- `canvaskit-wasm` is the first runtime dependency: pinned exactly, ≥7-day-old
  release, supply-chain posture per repo rules.

## Rollback

Delete `skia.ts` + its tests and the `canvaskit-wasm` dependency; the
`--backend` flag reverts to `gpu`. Nothing upstream or in IR changes.

## Open Questions

- Promotion criteria for making `skia` the default `render` backend (WPT subset
  + reftest parity thresholds).
- Whether `Surface` should grow a premultiplied-alpha mode to skip the
  unpremultiply on read-back.
- How the future `font` handle on `text` commands interacts with
  `TypefaceFontProvider` selection.
