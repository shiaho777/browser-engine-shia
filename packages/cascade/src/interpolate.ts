/**
 * interpolate.ts — the value-interpolation core of CSS Transitions and the Web
 * Animations API (CSS Animations §3, web-animations-1 §4 "Animation effects").
 *
 * A real engine animates a property by, every frame, computing a value at some
 * progress `t ∈ [0,1]` between a `from` and a `to` computed value, where `t` is
 * the fraction of the active duration warped through a TIMING FUNCTION (easing).
 * Two irreducible mechanisms make that real:
 *
 *   1. {@link sampleEasing} — the CSS `<easing-function>`: `linear`, the named
 *      cubic-béziers (`ease`/`ease-in`/`ease-out`/`ease-in-out`), an arbitrary
 *      `cubic-bezier(x1,y1,x2,y2)` solved by Newton–Raphson with a bisection
 *      fallback (exactly Blink's `UnitBezier`), and `steps(n, position)`.
 *   2. {@link interpolateValue} — per-property value interpolation DISPATCHED ON
 *      DATA: every property's {@link CssPropertyDef} already carries an
 *      `animationType` (`discrete` → 50% flip; `by-computed-value` → numeric
 *      interpolation) and a `tsType` (`Px`, `Color`, `Edges<Px>`, `number`,
 *      `LengthOrAuto`, …) that selects the component interpolation. No
 *      per-property branch is hand-written; the generated table is the source.
 *
 * {@link interpolateStyle} ties them together: given two {@link ComputedStyle}s,
 * a set of properties, and a raw progress, it produces the interpolated style —
 * the value an animation tick (driven by `requestAnimationFrame`) installs.
 *
 * Pure and deterministic: identical inputs yield identical output (no clock, no
 * randomness), so the whole animation model is testable on a virtual clock.
 */
import type { Color, ComputedStyle, Edges, Px } from "@browser-engine/ir";
import { px } from "@browser-engine/ir";
import { CSS_PROPERTIES } from "@browser-engine/generator";
import type { CssPropertyDef } from "@browser-engine/generator";

/** Clamp `x` into the inclusive `[lo, hi]` range. */
function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Scalar linear interpolation: `a` at `t=0`, `b` at `t=1`. */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ---------------------------------------------------------------------------
// Timing functions (CSS <easing-function>)
// ---------------------------------------------------------------------------

/** A parsed CSS easing function. */
export type Easing =
  | { readonly kind: "linear" }
  | { readonly kind: "cubic-bezier"; readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number }
  | { readonly kind: "steps"; readonly count: number; readonly position: StepPosition };

/** Where the jump happens for `steps()` (web-animations-1 §3.2). */
export type StepPosition = "start" | "end" | "jump-start" | "jump-end" | "jump-none" | "jump-both";

/** The named cubic-bézier keywords (CSS easing-1 §2). */
const NAMED_BEZIER: Record<string, readonly [number, number, number, number]> = {
  ease: [0.25, 0.1, 0.25, 1],
  "ease-in": [0.42, 0, 1, 1],
  "ease-out": [0, 0, 0.58, 1],
  "ease-in-out": [0.42, 0, 0.58, 1],
};

/**
 * Parse a CSS `<easing-function>`. Unknown / unsupported syntaxes are NOT
 * silently coerced — they throw, so a typo never quietly becomes `linear`.
 */
export function parseEasing(spec: string): Easing {
  const s = spec.trim().toLowerCase();
  if (s === "linear") return { kind: "linear" };
  if (s === "step-start") return { kind: "steps", count: 1, position: "start" };
  if (s === "step-end") return { kind: "steps", count: 1, position: "end" };
  const named = NAMED_BEZIER[s];
  if (named !== undefined) {
    return { kind: "cubic-bezier", x1: named[0], y1: named[1], x2: named[2], y2: named[3] };
  }
  const bezier = /^cubic-bezier\(\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*([^)]+)\)$/.exec(s);
  if (bezier !== null) {
    const x1 = Number(bezier[1]);
    const y1 = Number(bezier[2]);
    const x2 = Number(bezier[3]);
    const y2 = Number(bezier[4]);
    if ([x1, y1, x2, y2].some((n) => !Number.isFinite(n))) {
      throw new Error(`invalid cubic-bezier arguments: ${spec}`);
    }
    // x must stay in [0,1] (a function of time); y is unconstrained (overshoot).
    if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) {
      throw new Error(`cubic-bezier x coordinates must be in [0,1]: ${spec}`);
    }
    return { kind: "cubic-bezier", x1, y1, x2, y2 };
  }
  const steps = /^steps\(\s*(\d+)\s*(?:,\s*([a-z-]+)\s*)?\)$/.exec(s);
  if (steps !== null) {
    const count = Number(steps[1]);
    const position = (steps[2] ?? "end") as StepPosition;
    if (!Number.isInteger(count) || count < 1) throw new Error(`steps() needs a positive integer: ${spec}`);
    const allowed: readonly StepPosition[] = ["start", "end", "jump-start", "jump-end", "jump-none", "jump-both"];
    if (!allowed.includes(position)) throw new Error(`invalid steps position: ${spec}`);
    if (position === "jump-none" && count < 2) throw new Error(`steps(n, jump-none) requires n ≥ 2: ${spec}`);
    return { kind: "steps", count, position };
  }
  throw new Error(`unsupported easing function: ${spec}`);
}

/**
 * Solve `bezier_x(s) = x` for the parameter `s`, then return `bezier_y(s)`.
 * Newton–Raphson (8 iters) with a bisection fallback — the algorithm Blink's
 * `UnitBezier::solve` uses. `p0=(0,0)`, `p3=(1,1)` are fixed.
 */
function solveCubicBezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
  // Polynomial coefficients for the parametric bézier with fixed endpoints.
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (s: number): number => ((ax * s + bx) * s + cx) * s;
  const sampleY = (s: number): number => ((ay * s + by) * s + cy) * s;
  const sampleDX = (s: number): number => (3 * ax * s + 2 * bx) * s + cx;

  // Newton–Raphson from the identity guess.
  let s = x;
  for (let i = 0; i < 8; i++) {
    const xs = sampleX(s) - x;
    if (Math.abs(xs) < 1e-7) return sampleY(s);
    const d = sampleDX(s);
    if (Math.abs(d) < 1e-7) break;
    s -= xs / d;
  }
  // Bisection fallback (guaranteed convergence on the monotone-in-x domain).
  let lo = 0;
  let hi = 1;
  s = x;
  if (s < lo) return sampleY(lo);
  if (s > hi) return sampleY(hi);
  for (let i = 0; i < 32; i++) {
    const xs = sampleX(s);
    if (Math.abs(xs - x) < 1e-7) break;
    if (x > xs) lo = s;
    else hi = s;
    s = (lo + hi) / 2;
  }
  return sampleY(s);
}

/**
 * Warp a linear progress `t ∈ [0,1]` through `easing`, returning the eased
 * output progress (which a cubic-bézier may push outside `[0,1]`).
 */
export function sampleEasing(easing: Easing, t: number): number {
  const x = clamp(t, 0, 1);
  switch (easing.kind) {
    case "linear":
      return x;
    case "cubic-bezier":
      return solveCubicBezier(easing.x1, easing.y1, easing.x2, easing.y2, x);
    case "steps": {
      const { count, position } = easing;
      // The number of "jumps" and the floor/ceil rounding follow §3.2.
      let step = Math.floor(x * count);
      const before = position === "start" || position === "jump-start" || position === "jump-both";
      if (before) step += 1;
      // Exactly at t=1, never exceed the available steps.
      if (x === 1) step = position === "jump-none" ? count - 1 : count;
      const denom = position === "jump-none" ? count - 1 : position === "jump-both" ? count + 1 : count;
      return clamp(step / denom, 0, 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Per-property value interpolation (dispatched on the data table's tsType)
// ---------------------------------------------------------------------------

/** Interpolate two sRGB colors per channel (straight-alpha, gamma-naive sRGB). */
function interpolateColor(a: Color, b: Color, t: number): Color {
  return {
    r: clamp(Math.round(lerp(a.r, b.r, t)), 0, 255),
    g: clamp(Math.round(lerp(a.g, b.g, t)), 0, 255),
    b: clamp(Math.round(lerp(a.b, b.b, t)), 0, 255),
    a: clamp(lerp(a.a, b.a, t), 0, 1),
  };
}

/** Interpolate an `Edges<Px>` quad component-wise. */
function interpolateEdges(a: Edges<Px>, b: Edges<Px>, t: number): Edges<Px> {
  return {
    top: px(lerp(a.top, b.top, t)),
    right: px(lerp(a.right, b.right, t)),
    bottom: px(lerp(a.bottom, b.bottom, t)),
    left: px(lerp(a.left, b.left, t)),
  };
}

/** A property value is interpolable if both endpoints share an interpolable shape. */
function isColor(v: unknown): v is Color {
  return typeof v === "object" && v !== null && "r" in v && "g" in v && "b" in v && "a" in v;
}

function isEdges(v: unknown): v is Edges<Px> {
  return typeof v === "object" && v !== null && "top" in v && "right" in v && "bottom" in v && "left" in v;
}

/**
 * The discrete-flip rule (web-animations-1 §4.4): the `from` value holds for
 * `t < 0.5`, the `to` value from `t ≥ 0.5`.
 */
function discreteFlip<T>(from: T, to: T, t: number): T {
  return t < 0.5 ? from : to;
}

/**
 * Interpolate one property's value at progress `t`, using its data-table row to
 * decide HOW: `discrete`/`none` properties flip at 50%; `by-computed-value`
 * properties interpolate numerically by their `tsType` shape. Endpoints whose
 * runtime shape is not numerically interpolable (e.g. a `LengthOrAuto` that is
 * the keyword `"auto"`) fall back to the spec-mandated discrete flip rather than
 * producing a nonsense value.
 */
export function interpolateValue(def: CssPropertyDef, from: unknown, to: unknown, t: number): unknown {
  if (def.animationType !== "by-computed-value") return discreteFlip(from, to, t);
  if (t <= 0) return from;
  if (t >= 1) return to;

  switch (def.tsType) {
    case "Px":
      return px(lerp(from as number, to as number, t));
    case "number":
      return lerp(from as number, to as number, t);
    case "Color":
      if (isColor(from) && isColor(to)) return interpolateColor(from, to, t);
      return discreteFlip(from, to, t);
    case "Edges<Px>":
      if (isEdges(from) && isEdges(to)) return interpolateEdges(from, to, t);
      return discreteFlip(from, to, t);
    case "LengthOrAuto":
    case "LengthSizing":
      // Lengths interpolate; `auto`/`none` keywords are not interpolable.
      if (typeof from === "number" && typeof to === "number") return px(lerp(from, to, t));
      return discreteFlip(from, to, t);
    default:
      return discreteFlip(from, to, t);
  }
}

// ---------------------------------------------------------------------------
// Whole-style interpolation (the per-frame animation sample)
// ---------------------------------------------------------------------------

/** Index the property data table by its camelCase `ComputedStyle` field. */
const PROPS_BY_FIELD: ReadonlyMap<string, CssPropertyDef> = new Map(
  CSS_PROPERTIES.map((p) => [p.field, p]),
);

/**
 * Produce the {@link ComputedStyle} at progress `t` between `from` and `to`,
 * interpolating ONLY the named `fields` (the animated properties) and copying
 * everything else from `from`. `t` is the RAW progress; pass it pre-eased
 * (via {@link sampleEasing}) for a timing-function-warped sample. Unknown field
 * names throw — an animation cannot target a property the engine does not know.
 */
export function interpolateStyle(
  from: ComputedStyle,
  to: ComputedStyle,
  fields: readonly string[],
  t: number,
): ComputedStyle {
  const result: Record<string, unknown> = { ...(from as unknown as Record<string, unknown>) };
  const fromRec = from as unknown as Record<string, unknown>;
  const toRec = to as unknown as Record<string, unknown>;
  for (const field of fields) {
    const def = PROPS_BY_FIELD.get(field);
    if (def === undefined) throw new Error(`cannot animate unknown property field: ${field}`);
    result[field] = interpolateValue(def, fromRec[field], toRec[field], t);
  }
  return result as unknown as ComputedStyle;
}

/**
 * Compute the active progress of a single-interval animation/transition at
 * `elapsedMs` into a run of `durationMs` (after `delayMs`), warped through
 * `easing`. Before the delay the progress is 0; at/after the end it is 1. A
 * zero (or negative) duration snaps to 1 once started (an instantaneous change).
 */
export function animationProgress(
  elapsedMs: number,
  durationMs: number,
  delayMs: number,
  easing: Easing,
): number {
  const active = elapsedMs - delayMs;
  if (active <= 0) return 0;
  if (durationMs <= 0) return 1;
  return sampleEasing(easing, clamp(active / durationMs, 0, 1));
}
