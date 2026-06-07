/**
 * Tests for the CSS serializer / Pretty_Printer (task 5.5).
 *
 * Built by `tsc` then run with: `node --test packages/css-parser/dist/*.test.js`.
 *
 * Covers Requirements 18.3 and 18.5 from design.md §4.1/§6:
 *   - 18.3: the Pretty_Printer serializes a Stylesheet IR back into CSS text.
 *   - 18.5: parse → print → parse produces a structurally equivalent Stylesheet
 *           (the parse→print→parse fixed point), using the package's shared
 *           `stylesheetsEquivalent` oracle.
 *
 * These tests stay separate from index.test.ts (task 3.3) so the existing
 * parser tests are left undisturbed.
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { StyleSheet } from "@browser-engine/ir";

import {
  parseCss,
  serializeStylesheet,
  serializeRule,
  serializeDeclaration,
  stylesheetsEquivalent,
} from "./index.js";

const encode = (css: string): Uint8Array => new TextEncoder().encode(css);
const parse = (css: string): StyleSheet => parseCss(encode(css));

// ---------------------------------------------------------------------------
// Req 18.3 — serialize a Stylesheet IR back into CSS text.
// ---------------------------------------------------------------------------

void test("Req 18.3: a single rule serializes to canonical `selector { … }` text", () => {
  const sheet = parse("div { color: red; width: 100px }");
  assert.equal(serializeStylesheet(sheet), "div {\n  color: red;\n  width: 100px;\n}");
});

void test("Req 18.3: multiple rules are separated by a blank line, in source order", () => {
  const sheet = parse("div { color: red } p { color: blue }");
  assert.equal(
    serializeStylesheet(sheet),
    "div {\n  color: red;\n}\n\np {\n  color: blue;\n}",
  );
});

void test("Req 18.3: a selector list is expanded to one rule per selector on serialize", () => {
  // The parser expands `h1, .lead` into two rules, so the serializer emits two.
  const sheet = parse("h1, .lead { color: black }");
  assert.equal(
    serializeStylesheet(sheet),
    "h1 {\n  color: black;\n}\n\n.lead {\n  color: black;\n}",
  );
});

void test("Req 18.3: an !important declaration round-trips the bang back into text", () => {
  const sheet = parse("div { color: red !important; width: 50px }");
  assert.equal(
    serializeStylesheet(sheet),
    "div {\n  color: red !important;\n  width: 50px;\n}",
  );
});

void test("serializeDeclaration emits `property: value` and appends !important", () => {
  assert.equal(
    serializeDeclaration({ property: "color", value: "red", important: false }),
    "color: red",
  );
  assert.equal(
    serializeDeclaration({ property: "color", value: "red", important: true }),
    "color: red !important",
  );
});

void test("serializeRule emits a single rule with its selector and declarations", () => {
  const sheet = parse("a.b { display: none }");
  const rule = sheet.rules[0];
  assert.ok(rule !== undefined);
  assert.equal(serializeRule(rule), "a.b {\n  display: none;\n}");
});

// ---------------------------------------------------------------------------
// Serializer edge cases.
// ---------------------------------------------------------------------------

void test("an empty stylesheet serializes to the empty string", () => {
  assert.equal(serializeStylesheet(parse("")), "");
  assert.equal(serializeStylesheet(parse("   \n\t  ")), "");
  assert.equal(serializeStylesheet(parse("/* only a comment */")), "");
});

void test("a declaration-less rule serializes to `selector {}`", () => {
  const sheet = parse("div {}");
  assert.equal(sheet.rules.length, 1);
  assert.equal(serializeStylesheet(sheet), "div {}");
});

void test("a rule whose only declaration is dropped serializes to `selector {}`", () => {
  // `width: red` is invalid and dropped by the generated parser, leaving no
  // declarations — the serializer must still emit a syntactically valid rule.
  const sheet = parse("div { width: red }");
  assert.equal(serializeStylesheet(sheet), "div {}");
});

// ---------------------------------------------------------------------------
// Req 18.5 — round-trip equivalence: parse(print(parse(css))) ≡ parse(css).
// ---------------------------------------------------------------------------

const ROUND_TRIP_CASES: ReadonlyArray<readonly [string, string]> = [
  ["single rule", "div { color: red; width: 100px }"],
  ["multiple rules", "div { color: red } p { color: blue } span { display: none }"],
  ["selector list expansion", "h1, .lead, #main { color: black }"],
  ["important + normal", "div { color: red !important; width: 50px }"],
  ["combinators & specificity mix", "#main p > span { display: none } a.b.c { color: red }"],
  ["attribute & pseudo selectors", "a[href] { color: red } a:hover { color: blue }"],
  ["pseudo-element", "p::before { display: none }"],
  ["margin shorthand", "div { margin: 1px 2px 3px 4px }"],
  ["empty block", "div {}"],
];

void test("Req 18.5: parse → print → parse is a fixed point for representative CSS", () => {
  for (const [label, css] of ROUND_TRIP_CASES) {
    const once = parse(css);
    const twice = parse(serializeStylesheet(once));
    assert.ok(
      stylesheetsEquivalent(once, twice),
      `expected round-trip equivalence for: ${label}`,
    );
  }
});

void test("Req 18.5: round trip preserves specificity and source order", () => {
  const css = "h1, .lead { color: red !important } #main p > span { display: none }";
  const once = parse(css);
  const twice = parse(serializeStylesheet(once));

  // The oracle already checks order + specificity, but assert them explicitly
  // so a regression points straight at the cascade-relevant metadata.
  assert.deepEqual(
    twice.rules.map((r) => r.order),
    once.rules.map((r) => r.order),
  );
  assert.deepEqual(
    twice.rules.map((r) => [...r.specificity]),
    once.rules.map((r) => [...r.specificity]),
  );
  assert.deepEqual(
    twice.rules.map((r) => r.selector[0]?.text),
    once.rules.map((r) => r.selector[0]?.text),
  );
  assert.ok(stylesheetsEquivalent(once, twice));
});

// ---------------------------------------------------------------------------
// stylesheetsEquivalent oracle — sanity that it discriminates, not just accepts.
// ---------------------------------------------------------------------------

void test("stylesheetsEquivalent is reflexive and rejects genuine differences", () => {
  const base = parse("div { color: red }");
  assert.ok(stylesheetsEquivalent(base, parse("div { color: red }")));

  // Different value.
  assert.ok(!stylesheetsEquivalent(base, parse("div { color: blue }")));
  // Different selector (and thus specificity).
  assert.ok(!stylesheetsEquivalent(base, parse(".x { color: red }")));
  // Different importance.
  assert.ok(!stylesheetsEquivalent(base, parse("div { color: red !important }")));
  // Different rule count.
  assert.ok(!stylesheetsEquivalent(base, parse("div { color: red } p { color: red }")));
});
