/**
 * The "add a property = add a data row" mechanism, proven mechanically
 * (platform-as-data-layout spec, task 7.1; Requirements 6.1, 6.2, 6.3, 1.4).
 *
 * Built by `tsc` then run with: `node --test packages/generator/dist/*.test.js`.
 *
 * This is the elemental proof of the whole compat-per-LOC bet (MANIFESTO.md):
 * a BRAND-NEW property added as ONE data row (plus its computeValue) yields its
 * parser, initial-value entry, inheritance flag, AND ComputedStyle field type
 * with NO other hand-written code — and the parsing delegates to an existing
 * reusable primitive (no new per-property parser). If a new property of an
 * existing value-shape required new per-property code, this test would fail.
 *
 * `add-property.test.ts` covers the original Phase 1 shapes; this adds the
 * layout/compositing shapes (integer / number / transform / keyword) to make
 * the guarantee total for the shapes this spec connected.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { CSS_PROPERTIES } from "./css-properties.data.js";
import { defineProperty, type CssPropertyDef } from "./css-property-def.js";
import { integer, keyword, number, transform } from "./value-grammar.js";
import {
  emitComputedStyleFields,
  emitCssParser,
  emitInheritance,
  emitInitialValues,
} from "./emit/css-codegen.js";

/**
 * A brand-new property NOT in the real data table, added as a single row using
 * an existing reusable grammar shape (`keyword`). Its very existence here — with
 * no companion hand-written parser/initial/inherit/field code — is the test.
 */
const NEW_KEYWORD_PROPERTY = defineProperty({
  name: "visibility",
  inherited: true,
  initial: "visible",
  syntax: keyword("visible", "hidden", "collapse"),
  computeValue: (s: string) => s,
  animationType: "discrete",
  tsType: "string",
});

/** Build a table = the real table + one new row (the only change). */
function tableWithNewRow(row: CssPropertyDef): readonly CssPropertyDef[] {
  return [...CSS_PROPERTIES, row] as readonly CssPropertyDef[];
}

void test("Req 1.4/6.2: a new keyword property row generates ALL four artifacts, no other code", () => {
  const table = tableWithNewRow(NEW_KEYWORD_PROPERTY as unknown as CssPropertyDef);

  // 1) parser — a generated function + a table entry delegating to parseKeyword.
  const parser = emitCssParser(table).contents;
  assert.match(parser, /export function parseVisibilityValue/);
  assert.match(parser, /"visibility": parseVisibilityValue/);
  assert.match(parser, /parseKeyword\(value, \["visible", "hidden", "collapse"\]\)/);

  // 2) initial value — serialized from the row's `initial`.
  const initials = emitInitialValues(table).contents;
  assert.match(initials, /visibility: "visible"/);

  // 3) inheritance flag — from the row's `inherited`.
  const inherit = emitInheritance(table).contents;
  assert.match(inherit, /visibility: true/);

  // 4) ComputedStyle field type — from the row's `tsType` + `field`.
  const fields = emitComputedStyleFields(table).contents;
  assert.match(fields, /readonly visibility: string;/);
});

void test("Req 6.2: a new property of each connected shape reuses an existing primitive (no new parser)", () => {
  // integer / number / transform rows all delegate to the shape's primitive —
  // proof the per-shape mechanism cost was paid once and is now free to reuse.
  const rows = [
    defineProperty({
      name: "order",
      inherited: false,
      initial: 0,
      syntax: integer(),
      computeValue: (s: number) => s,
      animationType: "discrete",
      tsType: "number",
    }),
    defineProperty({
      name: "flex-grow",
      inherited: false,
      initial: 0,
      syntax: number({ min: 0 }),
      computeValue: (s: number) => s,
      animationType: "by-computed-value",
      tsType: "number",
    }),
    defineProperty({
      name: "backdrop-transform",
      inherited: false,
      initial: "none",
      syntax: transform(),
      computeValue: (s: unknown) => s,
      animationType: "discrete",
      tsType: "TransformValue",
    }),
  ] as readonly CssPropertyDef[];

  const parser = emitCssParser([...CSS_PROPERTIES, ...rows]).contents;
  assert.match(parser, /"order": parseOrderValue/);
  assert.match(parser, /parseInteger\(value, \{\}\)/);
  assert.match(parser, /"flex-grow": parseFlexGrowValue/);
  assert.match(parser, /parseNumber\(value, \{ min: 0 \}\)/);
  assert.match(parser, /"backdrop-transform": parseBackdropTransformValue/);
  assert.match(parser, /parseTransform\(value\)/);
});

void test("Req 6.3: adding a row does NOT change the artifacts of any existing property", () => {
  // The new row must be purely additive: every existing property's emitted
  // field is unchanged when the table grows.
  const before = emitComputedStyleFields(CSS_PROPERTIES).contents;
  const after = emitComputedStyleFields(
    tableWithNewRow(NEW_KEYWORD_PROPERTY as unknown as CssPropertyDef),
  ).contents;
  // Every line of `before`'s field block still appears verbatim in `after`.
  for (const line of before.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("readonly ")) {
      assert.ok(after.includes(trimmed), `existing field must be unchanged: ${trimmed}`);
    }
  }
});
