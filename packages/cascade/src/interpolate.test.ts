/**
 * Tests for the CSS Transitions / Web Animations interpolation core. Proves the
 * timing functions (linear, named + arbitrary cubic-bézier, steps) and the
 * data-driven per-property value interpolation (Px, number, Color, Edges, the
 * discrete 50%-flip, and the auto/none non-interpolable fallback), plus the
 * whole-style sampler an rAF tick installs.
 *
 * Built by `tsc` then run with: `node --test packages/cascade/dist/*.test.js`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { px } from "@browser-engine/ir";
import type { Color, ComputedStyle, Edges, Px } from "@browser-engine/ir";
import { CSS_PROPERTIES } from "@browser-engine/generator";

import {
  parseEasing,
  sampleEasing,
  interpolateValue,
  interpolateStyle,
  animationProgress,
} from "./interpolate.js";

const byName = new Map(CSS_PROPERTIES.map((p) => [p.name, p]));
const def = (name: string) => {
  const d = byName.get(name);
  assert.ok(d !== undefined, `property ${name} exists in the data table`);
  return d;
};

// --- timing functions -------------------------------------------------------

void test("linear easing is the identity over [0,1] and clamps outside it", () => {
  const e = parseEasing("linear");
  assert.equal(sampleEasing(e, 0), 0);
  assert.equal(sampleEasing(e, 0.5), 0.5);
  assert.equal(sampleEasing(e, 1), 1);
  assert.equal(sampleEasing(e, 2), 1, "clamped above");
  assert.equal(sampleEasing(e, -1), 0, "clamped below");
});

void test("cubic-bezier pins endpoints and is monotone for ease-in-out", () => {
  const e = parseEasing("ease-in-out");
  assert.ok(Math.abs(sampleEasing(e, 0) - 0) < 1e-6, "f(0)=0");
  assert.ok(Math.abs(sampleEasing(e, 1) - 1) < 1e-6, "f(1)=1");
  // ease-in-out is symmetric: f(0.5) == 0.5.
  assert.ok(Math.abs(sampleEasing(e, 0.5) - 0.5) < 1e-3, "symmetric midpoint");
  // ease-in: slow start, so output < input early on.
  const ein = parseEasing("ease-in");
  assert.ok(sampleEasing(ein, 0.25) < 0.25, "ease-in lags early");
});

void test("an explicit cubic-bezier solves to the named ease keyword", () => {
  const named = parseEasing("ease");
  const explicit = parseEasing("cubic-bezier(0.25, 0.1, 0.25, 1)");
  for (const t of [0.1, 0.3, 0.5, 0.7, 0.9]) {
    assert.ok(Math.abs(sampleEasing(named, t) - sampleEasing(explicit, t)) < 1e-6, `match at ${t}`);
  }
});

void test("steps(4, end) produces four equal floor-rounded plateaus", () => {
  const e = parseEasing("steps(4, end)");
  assert.equal(sampleEasing(e, 0), 0);
  assert.equal(sampleEasing(e, 0.24), 0);
  assert.equal(sampleEasing(e, 0.25), 0.25);
  assert.equal(sampleEasing(e, 0.5), 0.5);
  assert.equal(sampleEasing(e, 0.99), 0.75);
  assert.equal(sampleEasing(e, 1), 1);
});

void test("steps(start) jumps immediately; step-start/step-end are the n=1 forms", () => {
  const e = parseEasing("steps(2, start)");
  assert.equal(sampleEasing(e, 0.01), 0.5, "start jumps on entry");
  assert.equal(parseEasing("step-start").kind, "steps");
  assert.equal(parseEasing("step-end").kind, "steps");
});

void test("invalid easing functions throw rather than silently defaulting", () => {
  assert.throws(() => parseEasing("wiggle"));
  assert.throws(() => parseEasing("cubic-bezier(2, 0, 0, 1)"), /x coordinates/);
  assert.throws(() => parseEasing("steps(0, end)"));
  assert.throws(() => parseEasing("steps(1, jump-none)"), /jump-none/);
});

// --- per-property value interpolation ---------------------------------------

void test("a Px property (width) interpolates numerically and pins endpoints", () => {
  const width = def("width");
  // width is LengthOrAuto; numeric endpoints interpolate as lengths.
  assert.equal(interpolateValue(width, px(0), px(100), 0), px(0));
  assert.equal(interpolateValue(width, px(0), px(100), 1), px(100));
  assert.equal(interpolateValue(width, px(0), px(100), 0.25), px(25));
});

void test("a number property (opacity) interpolates linearly", () => {
  const opacity = def("opacity");
  assert.equal(opacity.animationType, "by-computed-value");
  assert.equal(interpolateValue(opacity, 0, 1, 0.3), 0.3);
});

void test("a Color property interpolates per channel and rounds to bytes", () => {
  const color = def("color");
  const from: Color = { r: 0, g: 0, b: 0, a: 1 };
  const to: Color = { r: 255, g: 100, b: 0, a: 0 };
  const mid = interpolateValue(color, from, to, 0.5) as Color;
  assert.deepEqual(mid, { r: 128, g: 50, b: 0, a: 0.5 });
});

void test("an Edges<Px> property interpolates each edge", () => {
  const padding = def("padding");
  const from: Edges<Px> = { top: px(0), right: px(0), bottom: px(0), left: px(0) };
  const to: Edges<Px> = { top: px(10), right: px(20), bottom: px(30), left: px(40) };
  const mid = interpolateValue(padding, from, to, 0.5) as Edges<Px>;
  assert.deepEqual(mid, { top: px(5), right: px(10), bottom: px(15), left: px(20) });
});

void test("a discrete property (display) flips at the 50% boundary", () => {
  const display = def("display");
  assert.equal(display.animationType, "discrete");
  assert.equal(interpolateValue(display, "block", "flex", 0.49), "block");
  assert.equal(interpolateValue(display, "block", "flex", 0.5), "flex");
});

void test("a LengthOrAuto endpoint of `auto` is not interpolable — it flips discretely", () => {
  const width = def("width");
  assert.equal(interpolateValue(width, "auto", px(100), 0.3), "auto");
  assert.equal(interpolateValue(width, "auto", px(100), 0.7), px(100));
});

// --- whole-style sampling + progress ----------------------------------------

function baseStyle(): ComputedStyle {
  const base: Record<string, unknown> = {};
  for (const p of CSS_PROPERTIES) base[p.field] = p.initial;
  return base as unknown as ComputedStyle;
}

void test("interpolateStyle interpolates only the named fields, copying the rest", () => {
  const from: Record<string, unknown> = { ...(baseStyle() as unknown as Record<string, unknown>), opacity: 0, width: px(0) };
  const to: Record<string, unknown> = { ...(baseStyle() as unknown as Record<string, unknown>), opacity: 1, width: px(200) };
  const mid = interpolateStyle(
    from as unknown as ComputedStyle,
    to as unknown as ComputedStyle,
    ["opacity", "width"],
    0.5,
  ) as unknown as Record<string, unknown>;
  assert.equal(mid["opacity"], 0.5);
  assert.equal(mid["width"], px(100));
  // An untouched field keeps the `from` value.
  assert.deepEqual(mid["color"], from["color"]);
});

void test("interpolateStyle rejects an unknown animated property field", () => {
  const s = baseStyle();
  assert.throws(() => interpolateStyle(s, s, ["notAProp"], 0.5), /unknown property/);
});

void test("animationProgress respects delay, duration, and easing", () => {
  const linear = parseEasing("linear");
  assert.equal(animationProgress(50, 200, 100, linear), 0, "before the delay ⇒ 0");
  assert.equal(animationProgress(100, 200, 100, linear), 0, "exactly at delay start ⇒ 0");
  assert.equal(animationProgress(200, 200, 100, linear), 0.5, "halfway through the active duration");
  assert.equal(animationProgress(300, 200, 100, linear), 1, "at the end ⇒ 1");
  assert.equal(animationProgress(999, 200, 100, linear), 1, "past the end clamps to 1");
  assert.equal(animationProgress(150, 0, 100, linear), 1, "zero duration snaps to 1 once started");
});
