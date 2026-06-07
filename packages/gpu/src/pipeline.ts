/**
 * pipeline.ts — the GPU render-pipeline model + its core rasterizer.
 *
 * A real GPU pipeline, expressed the way GPUs work:
 *   - a serializable **command buffer** — clear / quad / clip — the thing a host
 *     records and submits to a device;
 *   - **fragment shaders as DATA** ({@link Fragment}): solid, linear-gradient,
 *     `coverage` (an alpha mask × colour — how text glyphs shade) and `image`
 *     (a sampled RGBA source) — programs, not host closures, so they cross a
 *     `worker_threads` (or device) boundary exactly as real shaders do;
 *   - **tiled scan-conversion** + fixed-function source-over blend, with a clip
 *     stack — the programmable-shade / fixed-blend split of a GPU.
 *
 * {@link renderBand} rasterizes a horizontal BAND `[y0, y1)`; bands are disjoint
 * and self-contained, so the SAME function drives the serial device and the
 * multi-core (`worker_threads`) device — one band per core — with identical
 * output. {@link applyCommand} is the per-command kernel both share.
 */

/** A straight-alpha colour: 8-bit RGB, `a` in 0..1. */
export interface GpuColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** A fragment-shader program, expressed as serializable DATA (not a closure). */
export type Fragment =
  | { readonly kind: "solid"; readonly color: GpuColor }
  | {
      readonly kind: "linear-gradient";
      readonly from: GpuColor;
      readonly to: GpuColor;
      readonly axis: "x" | "y";
    }
  | {
      /** A coverage mask (e.g. a rasterized glyph) modulated by `color`. */
      readonly kind: "coverage";
      readonly width: number;
      readonly height: number;
      /** `width × height` coverage values in `[0,1]`, row-major. */
      readonly mask: Float64Array;
      readonly color: GpuColor;
    }
  | {
      /** A sampled RGBA image source (straight alpha, `a` byte 0..255). */
      readonly kind: "image";
      readonly width: number;
      readonly height: number;
      readonly rgba: Uint8ClampedArray;
    };

/** Clear the whole target to a colour. */
export interface ClearCommand {
  readonly op: "clear";
  readonly color: GpuColor;
}

/** Draw an axis-aligned quad, shaded per fragment, blended source-over, clipped. */
export interface QuadCommand {
  readonly op: "quad";
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly fragment: Fragment;
}

/** Intersect the clip rect with this rectangle for subsequent draws. */
export interface PushClipCommand {
  readonly op: "push-clip";
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Restore the clip to before the matching push-clip. */
export interface PopClipCommand {
  readonly op: "pop-clip";
}

export type GpuCommand = ClearCommand | QuadCommand | PushClipCommand | PopClipCommand;

/** A recorded, submittable command buffer (fully serializable). */
export interface CommandBuffer {
  readonly width: number;
  readonly height: number;
  readonly commands: readonly GpuCommand[];
}

/** A half-open integer clip rectangle. */
export interface ClipRect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** Evaluate a fragment shader at local quad coordinates `(u, v)` in `[0,1]`. */
export function shade(fragment: Fragment, u: number, v: number): GpuColor {
  switch (fragment.kind) {
    case "solid":
      return fragment.color;
    case "linear-gradient": {
      const t = fragment.axis === "x" ? u : v;
      const { from, to } = fragment;
      return {
        r: from.r + (to.r - from.r) * t,
        g: from.g + (to.g - from.g) * t,
        b: from.b + (to.b - from.b) * t,
        a: from.a + (to.a - from.a) * t,
      };
    }
    case "coverage": {
      const cx = Math.min(fragment.width - 1, Math.max(0, Math.floor(u * fragment.width)));
      const cy = Math.min(fragment.height - 1, Math.max(0, Math.floor(v * fragment.height)));
      const cov = fragment.mask[cy * fragment.width + cx] ?? 0;
      const c = fragment.color;
      return { r: c.r, g: c.g, b: c.b, a: c.a * cov };
    }
    case "image": {
      const ix = Math.min(fragment.width - 1, Math.max(0, Math.floor(u * fragment.width)));
      const iy = Math.min(fragment.height - 1, Math.max(0, Math.floor(v * fragment.height)));
      const i = (iy * fragment.width + ix) * 4;
      return {
        r: fragment.rgba[i] ?? 0,
        g: fragment.rgba[i + 1] ?? 0,
        b: fragment.rgba[i + 2] ?? 0,
        a: (fragment.rgba[i + 3] ?? 0) / 255,
      };
    }
  }
}

/**
 * Rasterize rows `[y0, y1)` of `cmd` into a fresh RGBA buffer of size
 * `width × (y1 - y0)` (band-local; buffer row 0 is `y0`). Pure + self-contained
 * — the parallel unit of work.
 */
export function renderBand(cmd: CommandBuffer, y0: number, y1: number): Uint8ClampedArray {
  const w = cmd.width;
  const rows = Math.max(0, y1 - y0);
  const buf = new Uint8ClampedArray(w * rows * 4);
  const clipStack: ClipRect[] = [{ x0: 0, y0, x1: w, y1 }];
  for (const command of cmd.commands) {
    applyCommand(buf, w, y0, y1, clipStack, command);
  }
  return buf;
}

/** Apply ONE command to a band buffer, honouring the clip stack. The kernel
 * shared by the serial device, the parallel workers, and the layer executor. */
export function applyCommand(
  buf: Uint8ClampedArray,
  w: number,
  bandY0: number,
  bandY1: number,
  clipStack: ClipRect[],
  command: GpuCommand,
): void {
  const clip = clipStack[clipStack.length - 1] as ClipRect;
  switch (command.op) {
    case "clear": {
      const a = clamp01(command.color.a);
      for (let i = 0; i < w * (bandY1 - bandY0); i += 1) {
        buf[i * 4] = command.color.r;
        buf[i * 4 + 1] = command.color.g;
        buf[i * 4 + 2] = command.color.b;
        buf[i * 4 + 3] = a * 255;
      }
      return;
    }
    case "push-clip": {
      clipStack.push({
        x0: Math.max(clip.x0, Math.floor(command.x)),
        y0: Math.max(clip.y0, Math.floor(command.y)),
        x1: Math.min(clip.x1, Math.ceil(command.x + command.w)),
        y1: Math.min(clip.y1, Math.ceil(command.y + command.h)),
      });
      return;
    }
    case "pop-clip": {
      if (clipStack.length > 1) clipStack.pop();
      return;
    }
    case "quad": {
      const q = command;
      const x0 = Math.max(clip.x0, Math.floor(q.x));
      const x1 = Math.min(clip.x1, Math.ceil(q.x + q.w));
      const qy0 = Math.max(clip.y0, bandY0, Math.floor(q.y));
      const qy1 = Math.min(clip.y1, bandY1, Math.ceil(q.y + q.h));
      if (x1 <= x0 || qy1 <= qy0 || q.w <= 0 || q.h <= 0) return;
      for (let y = qy0; y < qy1; y += 1) {
        const v = (y + 0.5 - q.y) / q.h;
        const rowBase = (y - bandY0) * w;
        for (let x = x0; x < x1; x += 1) {
          const u = (x + 0.5 - q.x) / q.w;
          blendInto(buf, (rowBase + x) * 4, shade(q.fragment, u, v));
        }
      }
      return;
    }
  }
}

/** Source-over blend a straight-alpha fragment onto a band pixel (alpha-correct). */
export function blendInto(buf: Uint8ClampedArray, i: number, c: GpuColor): void {
  const sa = clamp01(c.a);
  if (sa <= 0) return;
  const dstA = (buf[i + 3] as number) / 255;
  const outA = sa + dstA * (1 - sa);
  if (outA <= 0) {
    buf[i] = 0;
    buf[i + 1] = 0;
    buf[i + 2] = 0;
    buf[i + 3] = 0;
    return;
  }
  const k = dstA * (1 - sa);
  buf[i] = (c.r * sa + (buf[i] as number) * k) / outA;
  buf[i + 1] = (c.g * sa + (buf[i + 1] as number) * k) / outA;
  buf[i + 2] = (c.b * sa + (buf[i + 2] as number) * k) / outA;
  buf[i + 3] = outA * 255;
}

export function clamp01(a: number): number {
  return a < 0 ? 0 : a > 1 ? 1 : a;
}
