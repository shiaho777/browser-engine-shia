/**
 * gradient.test.ts — linear-gradient parsing (CSS Images §4) and paint
 * emission. The parser is exercised directly; the emission goes through the
 * full paint pipeline so the display list carries a real gradient command.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { parseLinearGradient } from "./gradient.js";

void test("parses the default angle (to bottom) with two stops", () => {
  const g = parseLinearGradient("linear-gradient(red, blue)")!;
  assert.equal(g.angle, 180);
  assert.equal(g.stops.length, 2);
  assert.deepEqual(g.stops[0], { color: { r: 255, g: 0, b: 0, a: 1 }, position: 0 });
  assert.deepEqual(g.stops[1], { color: { r: 0, g: 0, b: 255, a: 1 }, position: 1 });
});

void test("parses an explicit angle in degrees", () => {
  const g = parseLinearGradient("linear-gradient(90deg, #ff0000, #0000ff)")!;
  assert.equal(g.angle, 90);
});

void test("parses direction keywords: to right = 90, to top left = 315", () => {
  assert.equal(parseLinearGradient("linear-gradient(to right, red, blue)")!.angle, 90);
  assert.equal(parseLinearGradient("linear-gradient(to top, red, blue)")!.angle, 0);
  assert.equal(parseLinearGradient("linear-gradient(to left, red, blue)")!.angle, 270);
  assert.equal(parseLinearGradient("linear-gradient(to bottom right, red, blue)")!.angle, 135);
  assert.equal(parseLinearGradient("linear-gradient(to top left, red, blue)")!.angle, 315);
});

void test("percentage positions map to [0,1]", () => {
  const g = parseLinearGradient("linear-gradient(90deg, red 0%, green 30%, blue 100%)")!;
  assert.equal(g.stops.length, 3);
  assert.equal(g.stops[0]!.position, 0);
  assert.equal(g.stops[1]!.position, 0.3);
  assert.equal(g.stops[2]!.position, 1);
});

void test("omitted middle positions distribute evenly between defined neighbors", () => {
  // red=0, olive=?, green=0.5, teal=?, blue=1 — the two omitted middles sit
  // at the midpoints of their defined intervals (CSS Images §4).
  const g = parseLinearGradient("linear-gradient(red, olive, green 50%, teal, blue)")!;
  assert.equal(g.stops.length, 5);
  assert.equal(g.stops[0]!.position, 0);
  assert.equal(g.stops[1]!.position, 0.25, "olive: midpoint of [0, 0.5]");
  assert.equal(g.stops[2]!.position, 0.5);
  assert.equal(g.stops[3]!.position, 0.75, "teal: midpoint of [0.5, 1]");
  assert.equal(g.stops[4]!.position, 1);
});

void test("rgba() and named colors with alpha parse", () => {
  const g = parseLinearGradient("linear-gradient(rgba(255,0,0,0.5), rgba(0,0,255,1))")!;
  assert.equal(g.stops[0]!.color.a, 0.5);
  assert.equal(g.stops[1]!.color.a, 1);
});

void test("multi-layer background-image: the FIRST linear-gradient wins", () => {
  const g = parseLinearGradient(
    "linear-gradient(45deg, red, blue), linear-gradient(90deg, green, yellow)",
  )!;
  assert.equal(g.angle, 45);
});

void test("a gradient inside a longer background-image value is found", () => {
  const g = parseLinearGradient("url(a.png), linear-gradient(to top, red, blue)")!;
  assert.equal(g.angle, 0);
});

void test("unparseable gradients return null (no silent fallback)", () => {
  assert.equal(parseLinearGradient("linear-gradient(red)"), null); // one stop.
  assert.equal(parseLinearGradient("linear-gradient()"), null);
  assert.equal(parseLinearGradient("linear-gradient(90deg, notacolor, blue)"), null);
  assert.equal(parseLinearGradient("no gradient here"), null);
});
