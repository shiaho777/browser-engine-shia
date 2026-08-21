/**
 * Tests for the CSS data table + emitter (task 3.2).
 *
 * Built by `tsc` then run with: `node --test packages/generator/dist/*.test.js`.
 *
 * Covers design.md §4.2/§8.5 and Requirements 6.1, 6.2, 14.2:
 *   - 6.1/14.2: the data table defines all seven Phase 1 properties, each with
 *     name, inheritance flag, initial value, parsing syntax, computeValue, and
 *     animation type.
 *   - 6.2: the emitter derives the parser, initial-value table, inheritance
 *     table, and ComputedStyle field types FROM the table, each referencing
 *     every property.
 *   - every emitted file carries the `@generated` marker so the Scoreboard
 *     excludes it from the compat-per-LOC denominator (Requirement 1.2).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { CSS_PROPERTIES } from "./css-properties.data.js";
import {
  emitComputedStyleFields,
  emitCssArtifacts,
  emitCssParser,
  emitInheritance,
  emitInitialValues,
} from "./emit/css-codegen.js";
import { toCamelCase } from "./css-property-def.js";

/** The seven Phase 1 properties (Requirement 14.2). */
const PHASE1_PROPERTIES = [
  "color",
  "display",
  "width",
  "height",
  "margin",
  "background-color",
  "font-size",
] as const;

/**
 * The layout + compositing properties connected by the platform-as-data-layout
 * spec. Each is a single data row reusing an existing/new grammar shape — proof
 * that growth is "add a row", not "add per-property code".
 */
const LAYOUT_COMPOSITING_PROPERTIES = [
  "position",
  "float",
  "top",
  "right",
  "bottom",
  "left",
  "flex-direction",
  "grid-template-columns",
  "opacity",
  "transform",
  "z-index",
] as const;

void test("Req 6.1/14.2: the data table contains the 7 Phase 1 properties", () => {
  const names = new Set(CSS_PROPERTIES.map((p) => p.name));
  for (const name of PHASE1_PROPERTIES) {
    assert.ok(names.has(name), `Phase 1 property ${name} must be present`);
  }
});

void test("platform-as-data-layout: every layout/compositing property is a data row", () => {
  const names = new Set(CSS_PROPERTIES.map((p) => p.name));
  for (const name of LAYOUT_COMPOSITING_PROPERTIES) {
    assert.ok(names.has(name), `layout/compositing property ${name} must be a data row`);
  }
  // The data table contains at least the Phase 1 subset + the connected layout/
  // compositing properties; further breadth-expansion rows only grow it (the
  // count is intentionally NOT pinned, so adding a property never breaks this).
  assert.ok(
    CSS_PROPERTIES.length >= PHASE1_PROPERTIES.length + LAYOUT_COMPOSITING_PROPERTIES.length,
    "the data table grows monotonically as properties are added",
  );
});

void test("platform-as-data-layout: new properties carry generated camelCase fields + correct shapes", () => {
  const byName = new Map(CSS_PROPERTIES.map((p) => [p.name, p]));
  // Multi-word names fold to camelCase fields (the keys layout/paint read).
  assert.equal(byName.get("flex-direction")?.field, "flexDirection");
  assert.equal(byName.get("grid-template-columns")?.field, "gridTemplateColumns");
  assert.equal(byName.get("z-index")?.field, "zIndex");
  // The new grammar shapes are wired (integer / number / transform).
  assert.equal(byName.get("z-index")?.syntax.kind, "integer");
  assert.equal(byName.get("opacity")?.syntax.kind, "number");
  assert.equal(byName.get("transform")?.syntax.kind, "transform");
  // display now accepts the table keyword.
  const display = byName.get("display");
  assert.ok(display !== undefined && display.syntax.kind === "keyword");
  if (display !== undefined && display.syntax.kind === "keyword") {
    assert.ok(display.syntax.keywords.includes("table"), "display must accept the table keyword");
  }
});

void test("platform-as-data-layout: emitted artifacts include every new field", () => {
  const fields = emitComputedStyleFields(CSS_PROPERTIES).contents;
  const initials = emitInitialValues(CSS_PROPERTIES).contents;
  const parser = emitCssParser(CSS_PROPERTIES).contents;
  // Field types for the new properties.
  assert.match(fields, /readonly flexDirection: FlexDirection;/);
  assert.match(fields, /readonly gridTemplateColumns: string;/);
  assert.match(fields, /readonly opacity: number;/);
  assert.match(fields, /readonly transform: TransformValue;/);
  assert.match(fields, /readonly zIndex: number;/);
  assert.match(fields, /readonly position: PositionValue;/);
  // Initial values serialized from data.
  assert.match(initials, /opacity: 1/);
  assert.match(initials, /transform: "none"/);
  assert.match(initials, /zIndex: 0/);
  assert.match(initials, /position: "static"/);
  // Parsers delegate to the new primitives (by shape, not by name).
  assert.match(parser, /parseInteger\(value/);
  assert.match(parser, /parseNumber\(value/);
  assert.match(parser, /parseTransform\(value\)/);
});

void test("Req 6.1: every row carries the full declarative metadata", () => {
  for (const property of CSS_PROPERTIES) {
    assert.equal(typeof property.name, "string");
    assert.equal(typeof property.inherited, "boolean");
    assert.notEqual(property.initial, undefined, `${property.name} initial`);
    assert.equal(typeof property.syntax, "object", `${property.name} syntax`);
    assert.equal(typeof property.syntax.kind, "string");
    assert.equal(typeof property.computeValue, "function", `${property.name} computeValue`);
    assert.ok(
      ["discrete", "by-computed-value", "none"].includes(property.animationType),
      `${property.name} animationType`,
    );
    assert.equal(typeof property.tsType, "string", `${property.name} tsType`);
    assert.equal(typeof property.field, "string", `${property.name} field`);
  }
});

void test("data table records the expected inheritance flags", () => {
  const inherited = new Map(CSS_PROPERTIES.map((p) => [p.name, p.inherited]));
  assert.equal(inherited.get("color"), true);
  assert.equal(inherited.get("font-size"), true);
  assert.equal(inherited.get("display"), false);
  assert.equal(inherited.get("width"), false);
  assert.equal(inherited.get("background-color"), false);
});

void test("Req 6.2: emitted parser names every property + a parse function", () => {
  const file = emitCssParser(CSS_PROPERTIES);
  assert.equal(file.path, "css-parsing.ts");
  assert.match(file.contents, /@generated\b/);
  for (const name of PHASE1_PROPERTIES) {
    assert.ok(
      file.contents.includes(`"${name}":`),
      `parser table must key on ${name}`,
    );
  }
  // a real per-property function delegating to a runtime primitive
  assert.match(file.contents, /export function parseColorValue/);
  assert.match(file.contents, /parseColor\(value\)/);
  assert.match(file.contents, /parseEdgesLength\(value\)/);
  assert.match(file.contents, /export function parsePropertyValue/);
});

void test("Req 6.2: emitted initial-value table names every field", () => {
  const file = emitInitialValues(CSS_PROPERTIES);
  assert.equal(file.path, "css-initial-values.ts");
  assert.match(file.contents, /@generated\b/);
  for (const property of CSS_PROPERTIES) {
    assert.ok(
      file.contents.includes(`${property.field}:`),
      `initial table must include field ${property.field}`,
    );
  }
  // initial values are serialized from the data (not hand-written)
  assert.match(file.contents, /display: "inline"/);
  assert.match(file.contents, /fontSize: 16/);
});

void test("Req 6.2: emitted inheritance table reflects each row's flag", () => {
  const file = emitInheritance(CSS_PROPERTIES);
  assert.equal(file.path, "css-inheritance.ts");
  assert.match(file.contents, /@generated\b/);
  assert.match(file.contents, /color: true/);
  assert.match(file.contents, /"font-size": true/);
  assert.match(file.contents, /display: false/);
  assert.match(file.contents, /width: false/);
});

void test("Req 6.2: emitted ComputedStyle fields type every property", () => {
  const file = emitComputedStyleFields(CSS_PROPERTIES);
  assert.equal(file.path, "computed-style-fields.ts");
  assert.match(file.contents, /@generated\b/);
  assert.match(file.contents, /interface GeneratedComputedStyleFields/);
  for (const property of CSS_PROPERTIES) {
    assert.ok(
      file.contents.includes(`readonly ${property.field}: ${property.tsType};`),
      `field type for ${property.field}: ${property.tsType}`,
    );
  }
});

void test("Req 6.2: emitCssArtifacts yields all four CSS files, each @generated", () => {
  const files = emitCssArtifacts(CSS_PROPERTIES);
  const paths = files.map((f) => f.path).sort();
  assert.deepEqual(paths, [
    "computed-style-fields.ts",
    "css-inheritance.ts",
    "css-initial-values.ts",
    "css-parsing.ts",
  ]);
  for (const file of files) {
    assert.match(file.contents, /@generated\b/, `${file.path} must be @generated`);
  }
});

void test("multi-word property names map to camelCase fields", () => {
  assert.equal(toCamelCase("background-color"), "backgroundColor");
  const bg = CSS_PROPERTIES.find((p) => p.name === "background-color");
  assert.ok(bg !== undefined);
  assert.equal(bg.field, "backgroundColor");
});

void test("emitter output is deterministic for a given table", () => {
  const a = emitCssArtifacts(CSS_PROPERTIES);
  const b = emitCssArtifacts(CSS_PROPERTIES);
  assert.deepEqual(
    a.map((f) => f.contents),
    b.map((f) => f.contents),
  );
});
