import type { Color } from "@browser-engine/ir";

/** One color stop. `offset` is 0 at the gradient start and 1 at the end. */
export interface GradientStop {
  readonly color: Color;
  readonly offset: number;
}

/** Color at position `t` along the stops. `t` is clamped to 0..1. */
export function gradientColor(stops: readonly GradientStop[], t: number): Color {
  if (stops.length === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const clamped = Math.max(0, Math.min(1, t));
  let prev = stops[0]!;
  if (clamped <= prev.offset) return prev.color;
  for (let i = 1; i < stops.length; i += 1) {
    const stop = stops[i]!;
    if (clamped <= stop.offset) {
      const span = stop.offset - prev.offset;
      const u = span <= 0 ? 0 : (clamped - prev.offset) / span;
      return mixColor(prev.color, stop.color, u);
    }
    prev = stop;
  }
  return prev.color;
}

/**
 * Position of pixel center `(x, y)` along a CSS linear gradient.
 * `angleDeg` uses CSS axes: 0 is up, 90 is to the right.
 */
export function gradientT(
  x: number,
  y: number,
  rectX: number,
  rectY: number,
  width: number,
  height: number,
  angleDeg: number,
): number {
  const rad = (angleDeg * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  const half = Math.abs(width / 2 * dx) + Math.abs(height / 2 * dy);
  if (!(half > 0)) return 0;
  const cx = rectX + width / 2;
  const cy = rectY + height / 2;
  return 0.5 + ((x - cx) * dx + (y - cy) * dy) / (2 * half);
}

/**
 * Position of pixel center `(x, y)` on a radial gradient.
 * `0` is the box center. `1` is the farthest corner.
 */
export function radialT(
  x: number,
  y: number,
  rectX: number,
  rectY: number,
  width: number,
  height: number,
): number {
  const rx = width / 2;
  const ry = height / 2;
  if (!(rx > 0) || !(ry > 0)) return 0;
  const nx = (x - (rectX + rx)) / rx;
  const ny = (y - (rectY + ry)) / ry;
  return Math.sqrt(nx * nx + ny * ny) / Math.SQRT2;
}

function mixColor(a: Color, b: Color, u: number): Color {
  return {
    r: Math.round(a.r + (b.r - a.r) * u),
    g: Math.round(a.g + (b.g - a.g) * u),
    b: Math.round(a.b + (b.b - a.b) * u),
    a: a.a + (b.a - a.a) * u,
  };
}
