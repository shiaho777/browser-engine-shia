/**
 * `raster.ts` — flatten quadratic glyph outlines to polygons and SCAN-CONVERT
 * them to an anti-aliased coverage grid.
 *
 * The rasterizer is the real-glyph-rendering mechanism (the FreeType analog):
 *   - quadratic béziers are flattened to polylines (the only "curve" TrueType
 *     has), with subdivision proportional to on-screen size;
 *   - filling uses the NONZERO winding rule (so counters / holes like the inside
 *     of `o` and `e` come out hollow), evaluated per sub-scanline;
 *   - anti-aliasing is exact horizontally (fractional pixel coverage along each
 *     span) and `SUBSAMPLES`-tap vertically — clean edges at any size.
 */
import type { Contour, GlyphOutline, GlyphRaster } from "./types.js";

/** Vertical sub-scanlines per pixel row (vertical AA quality). */
const SUBSAMPLES = 5;

interface Edge {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  /** Winding direction: +1 if the edge goes downward (y increasing), else -1. */
  readonly dir: number;
}

/**
 * Rasterize a glyph outline at `pixelsPerUnit` scale into an anti-aliased
 * coverage grid, positioned relative to the pen origin on the baseline.
 * A glyph with no contours (e.g. space) yields a zero-size grid.
 */
export function rasterizeOutline(outline: GlyphOutline, pixelsPerUnit: number): GlyphRaster {
  if (outline.contours.length === 0 || pixelsPerUnit <= 0) {
    return { width: 0, height: 0, coverage: new Float64Array(0), left: 0, top: 0 };
  }
  // Device bounding box (y flips: font y is up, device y is down).
  const x0 = Math.floor(outline.xMin * pixelsPerUnit);
  const x1 = Math.ceil(outline.xMax * pixelsPerUnit);
  const topDev = Math.floor(-outline.yMax * pixelsPerUnit);
  const botDev = Math.ceil(-outline.yMin * pixelsPerUnit);
  const width = Math.max(0, x1 - x0);
  const height = Math.max(0, botDev - topDev);
  if (width === 0 || height === 0) {
    return { width: 0, height: 0, coverage: new Float64Array(0), left: 0, top: 0 };
  }

  // Build edges in grid space: gx = x*s - x0 ; gy = -y*s - topDev.
  const edges: Edge[] = [];
  for (const contour of outline.contours) {
    flattenContour(contour, pixelsPerUnit, x0, topDev, edges);
  }

  const coverage = new Float64Array(width * height);
  const weight = 1 / SUBSAMPLES;
  const xs: { x: number; dir: number }[] = [];
  for (let ry = 0; ry < height; ry += 1) {
    for (let k = 0; k < SUBSAMPLES; k += 1) {
      const sy = ry + (k + 0.5) / SUBSAMPLES;
      xs.length = 0;
      for (const e of edges) {
        const lo = Math.min(e.y0, e.y1);
        const hi = Math.max(e.y0, e.y1);
        if (sy < lo || sy >= hi) continue;
        const t = (sy - e.y0) / (e.y1 - e.y0);
        xs.push({ x: e.x0 + t * (e.x1 - e.x0), dir: e.dir });
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a.x - b.x);
      let winding = 0;
      for (let i = 0; i < xs.length - 1; i += 1) {
        winding += xs[i]!.dir;
        if (winding === 0) continue; // outside (nonzero rule).
        addSpan(coverage, ry, width, xs[i]!.x, xs[i + 1]!.x, weight);
      }
    }
  }

  return { width, height, coverage, left: x0, top: -topDev };
}

/** Accumulate fractional horizontal coverage of `[xa,xb)` into row `ry`. */
function addSpan(
  coverage: Float64Array,
  ry: number,
  width: number,
  xa: number,
  xb: number,
  weight: number,
): void {
  const a = Math.max(0, xa);
  const b = Math.min(width, xb);
  if (b <= a) return;
  const row = ry * width;
  let px = Math.floor(a);
  for (; px < b; px += 1) {
    const overlap = Math.min(b, px + 1) - Math.max(a, px);
    if (overlap > 0) coverage[row + px] = (coverage[row + px] ?? 0) + overlap * weight;
  }
}

/** Flatten one contour's on/off-curve points into grid-space polygon edges. */
function flattenContour(
  contour: Contour,
  s: number,
  x0: number,
  topDev: number,
  out: Edge[],
): void {
  // Resolve the TrueType implied-on-curve convention into an explicit polyline.
  const poly = flattenToPolyline(contour, s, x0, topDev);
  for (let i = 0; i < poly.length; i += 1) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    if (p.y === q.y) continue; // horizontal edges contribute no crossings.
    out.push({ x0: p.x, y0: p.y, x1: q.x, y1: q.y, dir: q.y > p.y ? 1 : -1 });
  }
}

interface Pt {
  readonly x: number;
  readonly y: number;
}

/** Convert a contour to a closed polyline in grid space, flattening quadratics. */
function flattenToPolyline(contour: Contour, s: number, x0: number, topDev: number): Pt[] {
  const g = (px: number, py: number): Pt => ({ x: px * s - x0, y: -py * s - topDev });
  const n = contour.length;
  if (n === 0) return [];

  // Find a starting on-curve point; synthesize one if the contour is all-off.
  let startIdx = -1;
  for (let i = 0; i < n; i += 1) {
    if (contour[i]!.onCurve) {
      startIdx = i;
      break;
    }
  }
  const pts: Pt[] = [];
  let startPt: Pt;
  if (startIdx === -1) {
    // All off-curve: start at the midpoint of the last and first control points.
    const a = contour[n - 1]!;
    const b = contour[0]!;
    startPt = g((a.x + b.x) / 2, (a.y + b.y) / 2);
    startIdx = 0;
  } else {
    const sp = contour[startIdx]!;
    startPt = g(sp.x, sp.y);
  }
  pts.push(startPt);

  let current = startPt;
  let i = 1;
  while (i <= n) {
    const point = contour[(startIdx + i) % n]!;
    if (point.onCurve) {
      current = g(point.x, point.y);
      pts.push(current);
      i += 1;
      continue;
    }
    // Off-curve control point: the next point closes the quadratic, or an
    // implied on-curve midpoint does when two off-curve points are adjacent.
    const ctrl = g(point.x, point.y);
    const nextRaw = contour[(startIdx + i + 1) % n]!;
    let endP: Pt;
    if (nextRaw.onCurve) {
      endP = g(nextRaw.x, nextRaw.y);
      i += 2;
    } else {
      endP = g((point.x + nextRaw.x) / 2, (point.y + nextRaw.y) / 2);
      i += 1;
    }
    flattenQuadratic(current, ctrl, endP, pts);
    current = endP;
  }
  return pts;
}

/** Append a flattened quadratic bézier (excluding the start point) to `pts`. */
function flattenQuadratic(p0: Pt, p1: Pt, p2: Pt, pts: Pt[]): void {
  // Steps proportional to the control polygon's pixel length (size-adaptive).
  const len =
    Math.hypot(p1.x - p0.x, p1.y - p0.y) + Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const steps = Math.max(2, Math.min(24, Math.ceil(len / 2)));
  for (let k = 1; k <= steps; k += 1) {
    const t = k / steps;
    const mt = 1 - t;
    const x = mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x;
    const y = mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y;
    pts.push({ x, y });
  }
}
