/**
 * @browser-engine/backend
 *
 * Replaceable paint backend (Skia / Canvas / SVG-PNG screenshot). The single
 * entry point consumes the DisplayList and produces pixels/vector output; it
 * receives NO upstream IR handle (FragmentTree/ComputedStyle), so reverse reads
 * are impossible by construction. Note this package references only `ir` — not
 * `layout`/`cascade` — to keep that boundary physical. See design.md §6, §8.6.
 *
 * ## Phase 1 (task 3.11): minimal software-raster screenshot backend
 *
 * To close the end-to-end vertical slice (`render <html> -o out.png` —
 * Requirement 14.1) this package ships a small, self-built software rasterizer:
 *
 *   - {@link Surface} — a backend-owned RGBA8888 pixel buffer (the *only* thing
 *     the backend writes; it holds no IR handle).
 *   - {@link ScreenshotBackend} — a {@link PaintBackend} whose `render(list,
 *     surface)` interprets the DisplayList's Phase 1 commands (`rect` fills;
 *     `text` is a documented no-op until glyph shaping lands in task 5.7;
 *     clip/layer are honoured; `border`/`image` handled for completeness).
 *   - {@link encodeSurfaceToPng} — encodes a Surface to PNG bytes via Node's
 *     `zlib`, with NO external dependency and NO cross-stage import (the backend
 *     may import only `@browser-engine/ir`).
 *
 * The reuse-vs-build boundary (Requirement 8.1) is honoured conceptually: the
 * backend is the replaceable component behind the DisplayList; a production
 * Skia/FreeType backend swaps in here without changing anything upstream.
 * design.md §14 keeps "default paint backend (Skia vs SVG/Canvas)" an open
 * question, so Phase 1 uses this minimal raster backend deliberately.
 */
export const PACKAGE_NAME = "@browser-engine/backend" as const;

export type { Surface } from "./surface.js";
export { createSurface, clampAlpha, WHITE } from "./surface.js";

export type { PaintBackend, ScreenshotBackendOptions } from "./screenshot.js";
export { ScreenshotBackend, UnsupportedPaintCommandError } from "./screenshot.js";

export { renderDisplayListOnGpu } from "./gpu-render.js";

export { encodeSurfaceToPng } from "./png.js";
