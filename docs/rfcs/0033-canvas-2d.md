# RFC 0033 — `<canvas>` 2D: op-log engine + lazy Skia rasterization

Status: implemented. `canvas.getContext("2d")` returns a real
`CanvasRenderingContext2D` surface backed by `Canvas2DEngine`
(`packages/cli/src/canvas2d.ts`) — the element records drawing ops into an
immutable log, and the bitmap rasterizes lazily through the repo's existing
CanvasKit/Skia backend (`@browser-engine/backend`). `OffscreenCanvas` is the
same engine without the DOM wrapper. The rendered bitmap reaches the page
pipeline through the same `imageOf(node)` channel `<img>` uses — no second
paint path exists.

## Decision

**One engine, three surfaces, one invariant: a canvas bitmap is just another
`DecodedImage` — paint never learns it came from a script.**

### The engine (`canvas2d.ts`)

`Canvas2DEngine` is a recording device, not a per-call rasterizer:

- **State + op log.** Drawing state (`fillStyle`/`strokeStyle`/line-*/
  `globalAlpha`/`globalCompositeOperation`/`font`/text align+baseline/
  `direction`/shadow fields/`imageSmoothing*`/dash list+offset/CTM/clip
  stack) lives in a `DrawState`; every mutation appends a `RasterOp`
  (`fill`|`stroke`|`clip`|`clearRect`|`fillRect`|`strokeRect`|`image`|
  `text`|`putImageData`…) capturing the *common* snapshot (ctm, clips,
  alpha, blend, shadow, smoothing) at record time. `save`/`restore` push/
  pop the whole state — including the clip list, which replays per op.
- **Paths as verb lists.** `moveTo`/`lineTo`/`bezierCurveTo`/
  `quadraticCurveTo`/`arc`/`arcTo`/`ellipse`/`rect`/`closePath` record
  `Verb`s; arcs/ellipses flatten to cubics. `Path2D` (`Path2DImpl`) is the
  same verb list — constructible, copyable, passable to `fill`/`stroke`/
  `clip`.
- **Lazy rasterize.** `rasterize()` replays the log onto a CanvasKit raster
  `Surface` (PathBuilder → `Path`, `Paint` per state, `MakeTwoPointConical`
  for real radial gradients, pattern images via `MakeImageShader`) and
  reads back **unpremultiplied RGBA8888** — the `DecodedImage` contract.
  A `dirty` flag caches the raster between mutations.
- **Hit testing is real geometry.** `isPointInPath`/`isPointInStroke` hand
  the path to `Path.contains` / `Path.makeStroked().contains` when
  CanvasKit is warm; a JS flattening fallback keeps the calls honest when
  it isn't (e.g. cold start — rasterize returns `undefined` then, the same
  degradation `toDataURL` admits).
- **Pixel IO.** `getImageData` reads the rasterized bitmap; `putImageData`
  appends a pixels-write op (strides, offsets, dirty-rect honored), so
  image-data writes participate in the same replay, not a parallel buffer.
- **`drawImage` resolves three source kinds** through injected deps:
  canvas elements and `OffscreenCanvas`es (peer `canvasObjects` registry →
  their `DecodedImage`), `<img>` elements (`idOf` →
  `canvasImageSource` → the freshest `decodedImages` map), and raw
  `ImageData`-shaped guests where identifiable. Nine-arg/three-arg/five-arg
  overloads, negative dims flip, source-rect clamping per spec.
- **Text** rasterizes through the same typeface as page paint
  (`#typefaceOf`), honoring `font` spec parse (size/family/weight/style/
  variant), `textAlign`, `textBaseline`, `direction`; `measureText`
  returns real advances.
- **`globalCompositeOperation`** maps to Skia blend modes where the name
  matches (`source-over`/`copy`/`destination-over`/`lighter`/`xor`/
  `multiply`/`screen`/`overlay`/`darken`/`lighten`/…); unknown values fall
  back to `source-over` — the spec's "unrecognized ⇒ ignore" is preserved
  at set-time (the setter keeps the previous value).

### The guest surface (`canvas2dApi` + `script.ts`)

`canvas2dApi(engine, deps)` returns the plain-object context the sandbox
hands out: every IDL attribute routes to engine methods (`fillStyle =`
→ `setPaint` → `coercePaint` → `parseColor` from `@browser-engine/
generator`; non-parsing values are ignored per spec). Element wiring:

- `getContext("2d", {alpha:false})` creates the engine **once** —
  `canvasContexts`/`canvasEngines` are `NodeId`-keyed maps; repeats return
  the cached context (and mode). Non-`2d` kinds → `null`; non-canvas tags
  → `null`.
- **`width`/`height` writes reset the bitmap AND state** — IDL setters
  *and* `setAttribute("width"|"height")` both resize through
  `engine.resize(w,h)` → `reset()` (HTML §"set bitmap dimensions"). The
  defaults reflect as `300`/`150`.
- `toDataURL()` → real `encodeSurfaceToPng` bytes → base64 (PNG only —
  jpeg/webp is a documented boundary; cold CanvasKit → the 1×1 fallback
  the stub used, which is also the spec's zero-size behavior).
- `toBlob(cb)` delivers a real `{type,size,arrayBuffer}` payload — never
  `null` when a bitmap exists.
- `OffscreenCanvas` constructs a detached engine; `getContext("2d")` works
  identically; `width`/`height` setters resize the backing bitmap.
  `transferToImageBitmap`/`convertToBlob` are honest absences.
- `Path2D` is a sandbox global; `new Path2D(other)`/`new Path2D(dString)`
  clone/parse where supported.
- **`ctx.canvas` returns the element wrapper** (`canvasRef`), and the
  element→engine WeakMap makes `drawImage(canvasEl)`/`drawImage(offscreen)`
  resolve their peer bitmaps.

### Plumbing: engines outlive the sandbox

Two mutable maps live inside `buildDocumentApi`'s closure —
`canvasEngines: Map<NodeId, Canvas2DEngine>` and the guest-object WeakMap.
The api exposes `canvasBitmaps(): ReadonlyMap<NodeId, DecodedImage>` —
rasterizing every live engine at call time (lazy ⇒ the caller decides the
moment; repaints re-rasterize only when dirty).

- **`bootFineSession` returns `canvas: { bitmaps, imageBox }`
  unconditionally** — even without `keepAlive`. Scroll/relayout repaints
  must still see the bitmaps, and a scriptless page just gets the empty
  map.
- **`PageRuntime.canvasBitmaps` merges classic + module runs** — each
  builds its own document api (two engine maps, same `NodeId`s).
- **`canvasImageBox`** is the mutable holder behind
  `drawImage(imgEl)`: every `renderDom` publishes its freshest
  `decodedImages` into it, so a canvas draw in a later task sees the same
  decoded pixels the paint pass used.
- **`page.ts` merges canvas bitmaps into the `images` map** right where
  `frameImages` already merge — `paint()`'s existing `imageOf(fragment.node)`
  emits the image command; the backend blits the RGBA pixels exactly like
  an `<img>`.

### Layout: canvas is a replaced element, 300×150

`isReplacedElement` covers `canvas`; `resolveIntrinsicSize` honors
`width`/`height` attrs then defaults to **300×150** (HTML §the canvas
element's default object size). This surfaced a real IFC bug — the
vertical-align pass grew the line box **only downward**, so a lone 300×150
atomic poked 137px above its line top and painted mostly clipped. §10.8
grows both ways: the pass now lifts the whole line by the upward growth,
preserving every baseline delta. (`<img>` had the same latent bug; canvas
just made it unmissable.)

## The bug canvas exposed

`loadPage(url)` built `fetchFn = networkStackToFetchFn(network)` — a *bare*
adapter — and passed it as `options.fetchFn` into `renderHtmlEngine`, where
`fetchForResources = options.fetchFn ?? gatedAdapter` let it **shadow the
gated subresource channel entirely**. Every subresource rode out as
`mode:"navigate"`, no `destination`, `initiatorCoep:"unsafe-none"` — the
COEP CORP check, mixed-content destination map, and no-cors semantics all
silently skipped. Fixed by leaving `fetchFn` undefined when the session
stack exists, so the properly-equipped adapter is the only subresource
channel. (`coepRef` also now seeds from `session.isolation` right after
boot — `onAfterClassic` never fires on the `runScripts:false` path.)

## Evidence

- `packages/cli/src/canvas2d.test.ts` — 13 tests through the real guest
  surface (`runScriptsOnSession` + `canvasBitmaps`): fill/stroke pixels,
  path fill + `isPointInPath`/`isPointInStroke` (real Skia geometry),
  transforms + save/restore isolation, clip, linear-gradient ramp,
  `getImageData`/`putImageData` round-trip, glyph ink + `measureText`,
  `toDataURL` → `decodePng` round-trip, bitmap/state reset on `width=`,
  `drawImage(canvas→canvas)` + real `OffscreenCanvas`,
  `drawImage(imgEl)` via the decoded-image channel, `Path2D`.
- `packages/app/src/canvas.test.ts` — 3 end-to-end: scripted canvas →
  rendered page PNG pixels, 300×150 default intrinsic box (45000 red px),
  post-load mutation → repaint re-rasterizes (dirty flag) into the next
  frame.
- `packages/layout` — the IFC upward-growth fix covered by the updated
  vertical-align test (atomic bottoms still land on the baseline).
- Regression: the corrected `loadPage` subresource channel keeps the
  `require-corp` CORP test green (it was the only consumer that noticed
  the shadowing).

## Honest boundaries

1. **`toDataURL`/`toBlob` are PNG-only** — `"image/jpeg"`/`"image/webp"`
   MIME arguments are accepted but ignored (the repo encoder emits PNG).
   CanvasKit-cold calls return the spec's 1×1 transparent PNG.
2. **`{alpha:false}`** (opaque canvas) binds at first `getContext` on
   `<canvas>`; `OffscreenCanvas`'s options argument is accepted but the
   alpha knob is not yet honored there.
3. **Cold-CanvasKit degradation**: until the WASM module settles, the
   engine records ops but `rasterize()`/`getImageData`/`toDataURL` yield
   `undefined`/fallback — construction kicks `loadCanvasKit()` early so
   steady-state code never sees it; hit-testing falls back to JS-flattened
   geometry.
4. **No `ImageBitmap`/`transferToImageBitmap`/`convertToBlob`**, no
   `drawImage` from `HTMLVideoElement`/`SVGImageElement`/`ImageBitmap`
   sources — `CanvasImageSource` admits canvas elements, OffscreenCanvas,
   `<img>` (decoded), and `ImageData`-shaped sources only.
5. **`filter`, `letterSpacing`, `wordSpacing`, `textRendering`, lang/
   direction-affecting font features** are parsed-and-stored fields, not
   rasterized effects; shadows use CanvasKit's `Shadow` flags only for
   blur+offset+color (no spread/inset semantics).
6. `strokeText` uses the paint stroke pass — text-stroke-specific paint
   order is approximated, not full glyph-outline stroking.
7. **Pixel format is straight-alpha RGBA8888** end to end; `putImageData`
   writes participate in op replay (they are not a live alias into the
   buffer — callers mutating an `ImageData` after put see spec behavior,
   code relying on live views won't).
8. `isPointInStroke`'s fallback flattener ignores dash patterns (Skia-warm
   path is exact); `getLineDash`/`lineDashOffset`/`setLineDash` rasterize
   dashes only when CanvasKit is warm.
9. No `desynchronized`, no `willReadFrequently` hint behavior (the op-log
   design makes reads cheap regardless), no `colorSpace` selection.
10. Cross-origin **tainting is not modeled**: `drawImage` of a cross-origin
    image into a canvas does not mark the origin-dirty flag (the document's
    images are all fetched through the page's own channel). Flag for when
    multi-origin image sources become a thing.
