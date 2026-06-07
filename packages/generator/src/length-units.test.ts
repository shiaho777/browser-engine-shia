/**
 * Tests for the full CSS `<length>` unit set (CSS Values 4 §6.2). Absolute
 * units (px/in/pc/pt/cm/mm/Q) resolve to `px` at parse time; the font-relative
 * units em/rem return an unresolved {@link SpecifiedLength} the cascade later
 * resolves. Built by `tsc`, run with `node --test packages/generator/dist/*.test.js`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { parseLength, isSpecifiedLength } from "./value-runtime.js";

const val = (input: string): unknown => {
  const r = parseLength(input);
  assert.ok(r.ok, `"${input}" should parse`);
  return r.value;
};

void test("absolute units resolve to px at parse time by their exact ratios", () => {
  assert.equal(val("10px"), 10);
  assert.equal(val("1in"), 96, "1in = 96px");
  assert.equal(val("1pc"), 16, "1pc = 16px");
  assert.equal(val("72pt"), 96, "72pt = 96px (1pt = 1/72in)");
  assert.equal(val("2.54cm"), 96, "2.54cm = 96px");
  assert.equal(val("25.4mm"), 96, "25.4mm = 96px");
  assert.ok(Math.abs((val("40q") as number) - 96 / 2.54) < 1e-9, "40Q = 1cm");
});

void test("a bare 0 is a valid length; negative lengths are allowed", () => {
  assert.equal(val("0"), 0);
  assert.equal(val("-5px"), -5);
});

void test("em and rem stay UNRESOLVED as a SpecifiedLength (need context)", () => {
  const em = val("2em");
  assert.ok(isSpecifiedLength(em));
  assert.deepEqual(em, { kind: "specified-length", value: 2, unit: "em" });
  const rem = val("1.5rem");
  assert.ok(isSpecifiedLength(rem));
  assert.deepEqual(rem, { kind: "specified-length", value: 1.5, unit: "rem" });
});

void test("an unknown unit or a unit-less non-zero number fails to parse", () => {
  assert.equal(parseLength("5furlong").ok, false);
  assert.equal(parseLength("10").ok, false, "a non-zero number needs a unit");
  assert.equal(parseLength("abc").ok, false);
});

void test("viewport units stay UNRESOLVED as a SpecifiedLength (need the viewport)", () => {
  for (const unit of ["vw", "vh", "vmin", "vmax"]) {
    const v = val(`50${unit}`);
    assert.ok(isSpecifiedLength(v), `${unit} is a specified length`);
    assert.deepEqual(v, { kind: "specified-length", value: 50, unit });
  }
});
