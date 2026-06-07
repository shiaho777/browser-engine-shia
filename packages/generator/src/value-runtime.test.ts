/**
 * Tests for the generated parser's runtime behavior (task 3.2).
 *
 * The emitter wires each property to a hand-written runtime primitive; these
 * tests exercise the committed generated parser end to end to prove the wiring
 * is correct — a parse actually produces the right typed value. This is the
 * behavioral counterpart to `css-codegen.test.ts` (which checks the emitted
 * source text).
 *
 * Covers Requirements 6.2 (generated parser works), 5.1 (unknown property
 * throws NotImplemented), 14.2 (the Phase 1 value subset parses).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { isNotImplemented } from "@browser-engine/ir";

import {
  parseColorValue,
  parseDisplayValue,
  parseMarginValue,
  parsePropertyValue,
  PROPERTY_PARSERS,
} from "./generated/css-parsing.js";
import { CSS_PROPERTIES } from "./css-properties.data.js";

/** Unwrap an `ok` parse result or fail the test with its reason. */
function unwrap<T>(result: { ok: true; value: T } | { ok: false; reason: string }): T {
  assert.ok(result.ok, result.ok ? "" : `parse failed: ${result.reason}`);
  return result.value;
}

void test("Req 6.2: generated color parser parses named/hex/rgb colors", () => {
  assert.deepEqual(unwrap(parseColorValue("red")), { r: 255, g: 0, b: 0, a: 1 });
  assert.deepEqual(unwrap(parseColorValue("#00ff00")), { r: 0, g: 255, b: 0, a: 1 });
  assert.deepEqual(unwrap(parseColorValue("rgb(1,2,3)")), { r: 1, g: 2, b: 3, a: 1 });
});

void test("Req 6.2: generated display parser parses keywords, rejects others", () => {
  assert.equal(unwrap(parseDisplayValue("block")), "block");
  assert.equal(unwrap(parseDisplayValue("none")), "none");
  const bad = parseDisplayValue("wobble");
  assert.equal(bad.ok, false);
});

void test("Req 6.2: generated margin parser expands a 1-to-4 length quad", () => {
  assert.deepEqual(unwrap(parseMarginValue("1px 2px")), {
    top: 1,
    right: 2,
    bottom: 1,
    left: 2,
  });
});

void test("Req 6.2: every property name has a working parser in the table", () => {
  // Derived from the LIVE data table: the parser table must key on EXACTLY the
  // properties in the data table — so adding a CSS property (Platform-as-Data)
  // automatically gets a parser and never breaks this test.
  const names = Object.keys(PROPERTY_PARSERS).sort();
  const expected = CSS_PROPERTIES.map((p) => p.name).sort();
  assert.deepEqual(names, expected);
  // Sanity: each generated parser is callable.
  for (const name of names) {
    assert.equal(typeof PROPERTY_PARSERS[name], "function", `parser for ${name} must exist`);
  }
});

void test("parsePropertyValue dispatches to the right parser", () => {
  assert.equal(unwrap(parsePropertyValue("display", "flex")), "flex");
  assert.deepEqual(unwrap(parsePropertyValue("font-size", "12px")), 12);
  // The newly-connected layout/compositing properties parse through the table.
  assert.equal(unwrap(parsePropertyValue("position", "absolute")), "absolute");
  assert.equal(unwrap(parsePropertyValue("z-index", "3")), 3);
  assert.equal(unwrap(parsePropertyValue("opacity", "0.5")), 0.5);
  assert.equal(unwrap(parsePropertyValue("transform", "none")), "none");
});

void test("Req 5.1: parsing an unknown property throws NotImplemented", () => {
  try {
    // A property still absent from the data table is an unimplemented capability.
    parsePropertyValue("xyzzy-not-a-property", "1");
    assert.fail("expected NotImplemented to be thrown");
  } catch (error) {
    assert.ok(isNotImplemented(error), "must throw NotImplemented");
    assert.match(error.feature, /css-property:xyzzy-not-a-property/);
  }
});
