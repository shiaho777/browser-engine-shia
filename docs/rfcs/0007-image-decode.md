# RFC 0007: Raster Image Decoding via the Skia Codec Surface

- **Status**: Implemented
- **Depends on**: RFC 0001 (Skia WASM backend), RFC 0004 (page resource seam), RFC 0006 (`webfonts.ts` loader pattern)

## Context

`<img>`/`background-image` already flow end-to-end (`collectImages*` →
`DecodedImage` → `op:"image"` → backend blit). The DECODE layer, however, is
the least honest part of the tree:

- WebP decodes by **spawning `dwebp`/`magick`/`sips` subprocesses** through
  temp files — sync-blocking in `tryDecode`, host-tool dependent, ~250 lines of
  PAM parsing and semaphore plumbing.
- GIF/BMP/ICO/AVIF do not decode at all.
- JPEG goes through `jpeg-js` (pure JS, correct but unnecessary once a real
  codec surface exists).

Meanwhile `canvaskit-wasm@0.41.1` — already shipped for the raster backend —
exposes `MakeImageFromEncoded`, which in this build decodes **PNG, JPEG, WebP,
GIF, BMP, ICO, and AVIF** in-process and synchronously. Reusing it is exactly
the project's "mature infrastructure for irreducible subsystems" rule.

## Design

### `backend/src/codecs.ts` (new)

- `sniffImageFormat(bytes): ImageFormat | undefined` — pure magic-byte table:
  `png|jpeg|webp|gif|bmp|ico|avif` (RIFF/WEBP, `GIF8?a`, `BM`, `00 00 01 00`,
  `ftyp`+`avif|avis` brands).
- `decodeImageBytes(bytes): DecodedImage | undefined` — synchronous; uses the
  CanvasKit instance **only if already initialized** (the backend's shared
  `ensureSkia` promise stores the resolved `ck`; sync decode before first
  backend construction returns `undefined` and callers fall back).
- `decodeImageBytesAsync(bytes)` — `await ensureSkia()` then decode. The app's
  async resource phase always takes this path.
- Pixels are read as `RGBA_8888` + `AlphaType.Unpremul` + `ColorSpace.SRGB` —
  the exact straight-alpha contract `DecodedImage.pixels` already documents.
- `DecodedImage` gains an optional `format` tag for diagnostics/tracing.
- `MakeAnimatedImageFromEncoded` exists upstream; we take the first frame as a
  static poster — animation is a recorded non-goal.

### `cli/images.ts` — decode chain rewrite

- DELETE every subprocess path: `decodeViaDwebp*`, `decodeViaMagick`,
  `withTempDir`, `parsePamRgba`, the `dwebp` semaphore. JPEG also drops the
  jpeg-js dependency in the async path (Skia covers it); jpeg-js stays only as
  the sync-path fallback when CanvasKit has not been initialized yet.
- `tryDecode` (sync): PNG → in-repo `decodePng` (deterministic, tested) →
  Skia-if-ready → jpeg-js (JPEG only).
- `tryDecodeAsync`: PNG → in-repo → `decodeImageBytesAsync` (all formats) →
  jpeg-js last-ditch for JPEG.
- sha1 decode cache and in-flight dedup stay as-is — cache keys are content
  hashes, so scope/page isolation falls out naturally.

### Honesty boundaries

- SVG is a document, not a raster codec — still renders as the replaced-element
  placeholder; a real SVG pipeline is future work, not faked here.
- EXIF orientation: honored iff the Skia codec applies it; we do not re-rotate.
- Animated GIF/AVIF: first frame only.
- Decode failures stay silent-but-honest: the `<img>` keeps its intrinsic-box
  placeholder instead of painting garbage.

## Verification

- `backend/src/codecs.test.ts`: every supported format decodes to the right
  dimensions; a transparent PNG pixel comes back straight-alpha; garbage is
  rejected. Fixtures are self-produced — PNG via `encodeSurfaceToPng`, JPEG via
  `jpeg-js.encode`, GIF/BMP hand-constructed byte-for-byte in the test, and
  WebP/ICO/AVIF as small base64 constants (generated once with `cwebp`/`magick`,
  embedded — no host-tool dependency at test time).
- `cli/images.ts` tests: data-URL decode, WebP through the async chain with NO
  subprocess, srcset candidate order unchanged.
- Full gate + evidence regen.
