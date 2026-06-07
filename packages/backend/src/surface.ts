/**
 * The raster {@link Surface}: the pixel buffer a {@link PaintBackend} draws into
 * (design.md §8.6). A Surface is a plain, backend-owned RGBA8888 buffer — it
 * carries NO handle to any upstream IR (FragmentTree/ComputedStyle); the backend
 * only ever sees the {@link DisplayList} + this buffer, so reverse reads are
 * structurally impossible (Requirement 3.5).
 *
 * This module imports ONLY `@browser-engine/ir` (the `Color` value type) — the
 * single sanctioned channel — keeping the backend's stage boundary physical
 * (`local/no-cross-stage-import`).
 */
import type { Color } from "@browser-engine/ir";

/**
 * A mutable raster target: a row-major, top-to-bottom, 8-bit **RGBA** pixel
 * buffer. `pixels.length === width * height * 4`. This is the only thing the
 * paint backend writes to.
 */
export interface Surface {
  readonly width: number;
  readonly height: number;
  /** RGBA bytes (4 per pixel), row-major. `Uint8ClampedArray` auto-clamps blends. */
  readonly pixels: Uint8ClampedArray;
}

/** Opaque white — the conventional default screenshot background. */
export const WHITE: Color = { r: 255, g: 255, b: 255, a: 1 };

/**
 * Allocate a {@link Surface} of `width × height` pixels, pre-filled with
 * `background` (default opaque {@link WHITE}). Dimensions are clamped to a
 * minimum of 1×1 so a degenerate (zero-extent) document still yields a valid,
 * encodable image.
 *
 * @param width  surface width in device pixels.
 * @param height surface height in device pixels.
 * @param background the initial fill colour (default opaque white).
 */
export function createSurface(width: number, height: number, background: Color = WHITE): Surface {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const pixels = new Uint8ClampedArray(w * h * 4);

  // Pre-multiply the background's straight alpha into opaque RGB: the surface is
  // an opaque canvas, so the stored alpha channel stays 255 and only RGB carries
  // the (alpha-weighted) background colour.
  const a = clampAlpha(background.a);
  const r = background.r * a + 255 * (1 - a);
  const g = background.g * a + 255 * (1 - a);
  const b = background.b * a + 255 * (1 - a);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = r;
    pixels[i + 1] = g;
    pixels[i + 2] = b;
    pixels[i + 3] = 255;
  }
  return { width: w, height: h, pixels };
}

/** Clamp a straight-alpha value to the `0..1` range. */
export function clampAlpha(a: number): number {
  if (Number.isNaN(a)) return 0;
  if (a < 0) return 0;
  if (a > 1) return 1;
  return a;
}
