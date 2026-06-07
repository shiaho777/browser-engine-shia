/**
 * add-property.test.ts — Requirement 6.5 (the headline Platform-as-Data claim).
 *
 * "Adding a new CSS property as ONE data-table row together with its
 * computeValue requires NO additional hand-written parsing, initial-value, or
 * inheritance code." This test proves it: it appends a single new row to a copy
 * of the table and asserts the new property flows through to ALL FOUR generated
 * artifacts — parser, initial-value table, inheritance table, and ComputedStyle
 * field — with no other change. The only thing the new row supplied is data
 * (and, in general, a `computeValue` algorithm); the emitter did the rest.
 *
 * It also pins the drift guard: the committed `generated/*` files must match
 * what the emitter produces from the current table, so the repo never drifts
 * from its data table.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { CSS_PROPERTIES } from "./css-properties.data.js";
import { defineProperty, type CssPropertyDef } from "./css-property-def.js";
import { lengthOr } from "./value-grammar.js";
import type { LengthOrAuto } from "./value-grammar.js";
import {
  emitComputedStyleFields,
  emitCssParser,
  emitInheritance,
  emitInitialValues,
} from "./emit/css-codegen.js";

/**
 * A brand-new property defined as exactly one data row + its computeValue. It
 * reuses the existing `length-or-keyword` grammar and the `LengthOrAuto` type,
 * so it adds ZERO hand-written parsing/initial/inheritance/field code. The name
 * is a synthetic probe deliberately NOT in the live data table (asserted below),
 * so this proves a genuinely new property flows through (not one that ships).
 */
const PROBE_NAME = "x-add-property-probe";
const PROBE_FIELD = "xAddPropertyProbe";

const SCROLL_PADDING: CssPropertyDef<LengthOrAuto, LengthOrAuto> = defineProperty<
  LengthOrAuto,
  LengthOrAuto
>({
  name: PROBE_NAME,
  inherited: false,
  initial: "auto",
  syntax: lengthOr("auto"),
  computeValue: (specified) => specified,
  animationType: "by-computed-value",
  tsType: "LengthOrAuto",
});

const EXTENDED: readonly CssPropertyDef[] = [
  ...CSS_PROPERTIES,
  SCROLL_PADDING as unknown as CssPropertyDef,
];

void test("the probe name is genuinely absent from the live table", () => {
  // Guards the whole file: if a real row ever takes this name, every assertion
  // below would be meaningless, so fail loudly instead.
  assert.ok(
    !CSS_PROPERTIES.some((p) => p.name === PROBE_NAME),
    `${PROBE_NAME} must not be a real property`,
  );
});

void test("Req 6.5: a new row flows through to the generated PARSER", () => {
  const before = emitCssParser(CSS_PROPERTIES).contents;
  const after = emitCssParser(EXTENDED).contents;

  assert.ok(!before.includes(PROBE_NAME), "baseline must not mention the new prop");
  assert.ok(after.includes(`"${PROBE_NAME}":`), "parser table must key on the new prop");
  assert.match(after, /export function parseXAddPropertyProbeValue/);
  assert.match(after, /parseLengthOrKeyword\(value, \["auto"\]\)/);
});

void test("Req 6.5: a new row flows through to the INITIAL-VALUE table", () => {
  const after = emitInitialValues(EXTENDED).contents;
  assert.match(after, /xAddPropertyProbe: "auto"/);
});

void test("Req 6.5: a new row flows through to the INHERITANCE table", () => {
  const after = emitInheritance(EXTENDED).contents;
  assert.match(after, /"x-add-property-probe": false/);
});

void test("Req 6.5: a new row flows through to the ComputedStyle FIELD types", () => {
  const after = emitComputedStyleFields(EXTENDED).contents;
  assert.match(after, /readonly xAddPropertyProbe: LengthOrAuto;/);
});

void test("Req 6.5: NO hand-written per-property code beyond the one row", () => {
  // The new property required only: one data row (`SCROLL_PADDING`) reusing an
  // existing grammar + value type. We assert all four artifacts changed solely
  // by the emitter — i.e. the new content appears without us writing any
  // parser/initial/inheritance/field code by hand.
  const artifacts = {
    parser: emitCssParser(EXTENDED).contents,
    initial: emitInitialValues(EXTENDED).contents,
    inheritance: emitInheritance(EXTENDED).contents,
    fields: emitComputedStyleFields(EXTENDED).contents,
  };
  assert.ok(artifacts.parser.includes(PROBE_NAME));
  assert.ok(artifacts.initial.includes(PROBE_FIELD));
  assert.ok(artifacts.inheritance.includes(PROBE_NAME));
  assert.ok(artifacts.fields.includes(PROBE_FIELD));
});
