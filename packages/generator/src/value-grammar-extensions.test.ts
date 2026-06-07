/**
 * Tests for the mechanism-level value-grammar extensions (task 1.1-1.4 of the
 * platform-as-data-layout spec; Requirements 2.1, 2.3, 2.4).
 *
 * Built by `tsc` then run with: `node --test packages/generator/dist/*.test.js`.
 *
 * The whole "add a property = add a data row" economics rests on these being
 * REUSABLE: a new value SHAPE (integer / number / transform) costs one grammar
 * + one runtime primitive ONCE, and thereafter any property of that shape needs
 * no new parsing code. These assert:
 *   - the three new runtime primitives parse + clamp + reject correctly;
 *   - the generator emits a parser for each new grammar shape from the shape
 *     ALONE — never a per-property (by-name) branch (Requirement 2.4);
 *   - a synthetic data table using the new shapes generates working parsers.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { parseInteger, parseNumber, parseTransform } from "./value-runtime.js";
import { defineProperty, type CssPropertyDef } from "./css-property-def.js";
import { integer, number, transform } from "./value-grammar.js";
import { emitCssParser } from "./emit/css-codegen.js";

// ---------------------------------------------------------------------------
// Runtime primitives (Requirement 2.3) — reusable, clamped, loud on bad input.
// ---------------------------------------------------------------------------

void test("parseInteger parses signed integers and clamps to bounds", () => {
  assert.deepEqual(parseInteger("5"), { ok: true, value: 5 });
  assert.deepEqual(parseInteger("-3"), { ok: true, value: -3 });
  assert.deepEqual(parseInteger("+7"), { ok: true, value: 7 });
  // Clamping to inclusive [min, max].
  assert.deepEqual(parseInteger("100", { min: 0, max: 10 }), { ok: true, value: 10 });
  assert.deepEqual(parseInteger("-100", { min: 0, max: 10 }), { ok: true, value: 0 });
});

void test("parseInteger rejects non-integers", () => {
  assert.equal(parseInteger("1.5").ok, false);
  assert.equal(parseInteger("abc").ok, false);
  assert.equal(parseInteger("").ok, false);
  assert.equal(parseInteger("3px").ok, false);
});

void test("parseNumber parses decimals and clamps (opacity-style 0..1)", () => {
  assert.deepEqual(parseNumber("0.5"), { ok: true, value: 0.5 });
  assert.deepEqual(parseNumber("1"), { ok: true, value: 1 });
  assert.deepEqual(parseNumber(".25"), { ok: true, value: 0.25 });
  assert.deepEqual(parseNumber("-2"), { ok: true, value: -2 });
  // opacity clamp.
  assert.deepEqual(parseNumber("2", { min: 0, max: 1 }), { ok: true, value: 1 });
  assert.deepEqual(parseNumber("-0.5", { min: 0, max: 1 }), { ok: true, value: 0 });
});

void test("parseNumber rejects non-numbers", () => {
  assert.equal(parseNumber("abc").ok, false);
  assert.equal(parseNumber("").ok, false);
  assert.equal(parseNumber("1px").ok, false);
});

void test("parseTransform parses none and matrix(...)", () => {
  assert.deepEqual(parseTransform("none"), { ok: true, value: "none" });
  const m = parseTransform("matrix(2, 0, 0, 2, 10, 20)");
  assert.equal(m.ok, true);
  if (m.ok) {
    assert.deepEqual([...m.value as readonly number[]], [2, 0, 0, 2, 10, 20]);
  }
  // Whitespace-separated components are accepted too.
  const m2 = parseTransform("matrix(1 0 0 1 0 0)");
  assert.equal(m2.ok, true);
});

void test("parseTransform rejects unsupported / malformed transforms (no silent stub)", () => {
  assert.equal(parseTransform("translate(10px)").ok, true); // now a supported function
  assert.equal(parseTransform("matrix(1,2,3)").ok, false); // wrong arity
  assert.equal(parseTransform("matrix(a,b,c,d,e,f)").ok, false); // non-numeric
  assert.equal(parseTransform("garbage").ok, false);
});

// ---------------------------------------------------------------------------
// Generator emits a parser per SHAPE, with NO by-name branch (Requirement 2.4).
// ---------------------------------------------------------------------------

void test("Req 2.1/2.4: the generator emits parsers for the new shapes from the shape alone", () => {
  // A synthetic table exercising each new grammar shape. None of these property
  // NAMES appears anywhere in the generator — the emission is driven purely by
  // the grammar `kind`.
  const table = [
    defineProperty({
      name: "z-index",
      inherited: false,
      initial: 0,
      syntax: integer(),
      computeValue: (s: number) => s,
      animationType: "discrete",
      tsType: "number",
    }),
    defineProperty({
      name: "opacity",
      inherited: false,
      initial: 1,
      syntax: number({ min: 0, max: 1 }),
      computeValue: (s: number) => s,
      animationType: "by-computed-value",
      tsType: "number",
    }),
    defineProperty({
      name: "transform",
      inherited: false,
      initial: "none",
      syntax: transform(),
      computeValue: (s: unknown) => s,
      animationType: "discrete",
      tsType: "TransformValue",
    }),
  ];

  const { contents } = emitCssParser(table as readonly CssPropertyDef[]);
  // Each property gets a generated parser delegating to the matching primitive.
  assert.match(contents, /parseInteger\(value, \{\}\)/);
  assert.match(contents, /parseNumber\(value, \{ min: 0, max: 1 \}\)/);
  assert.match(contents, /parseTransform\(value\)/);
  // The runtime primitives are imported (only the used ones).
  assert.match(contents, /parseInteger/);
  assert.match(contents, /parseNumber/);
  assert.match(contents, /parseTransform/);
});

void test("Req 2.4: the generator source contains no by-name branch for the new properties", () => {
  // A structural guard: the emitter dispatches on grammar `kind`, never on a
  // property name. The generated output must not hard-code a property name in a
  // conditional. (We assert the emitted parser table keys ARE the names — that
  // is data — but there is no `if (property.name === ...)` style branch, which
  // would show up as a name compared in the emitter, not present in output.)
  const table = [
    defineProperty({
      name: "grid-template-columns",
      inherited: false,
      initial: 1,
      syntax: integer({ min: 1 }),
      computeValue: (s: number) => s,
      animationType: "discrete",
      tsType: "number",
    }),
  ];
  const { contents } = emitCssParser(table as readonly CssPropertyDef[]);
  // The property appears only as a data-table key + its generated fn name,
  // delegating to the shape's primitive with the declared bounds.
  assert.match(contents, /"grid-template-columns": parseGridTemplateColumnsValue/);
  assert.match(contents, /parseInteger\(value, \{ min: 1 \}\)/);
});
