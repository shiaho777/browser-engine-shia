/**
 * Tests for the minimal CSS parser (task 3.3).
 *
 * Built by `tsc` then run with: `node --test packages/css-parser/dist/*.test.js`.
 *
 * Covers the Phase 1 supported subset and the IR contract from design.md
 * §4.1/§6 and Requirements 18.2, 18.6, 2.7, 3.2:
 *   - 18.2: a valid CSS byte stream parses into a Stylesheet IR.
 *   - 18.6/13.1: malformed declarations/rules are recovered (skipped), not fatal.
 *   - 2.7:  parseCss is a pure function — same bytes ⇒ structurally equal IR.
 *   - 3.2:  the returned StyleSheet is deep-frozen (downstream cannot mutate it).
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { StyleSheet } from "@browser-engine/ir";

import { parseCss } from "./index.js";

const encode = (css: string): Uint8Array => new TextEncoder().encode(css);
const parse = (css: string): StyleSheet => parseCss(encode(css));

void test("Req 18.2: a simple rule parses into the Stylesheet IR", () => {
  const sheet = parse("div { color: red; width: 100px }");
  assert.equal(sheet.rules.length, 1);

  const rule = sheet.rules[0];
  assert.ok(rule !== undefined);
  assert.deepEqual(
    rule.selector.map((s) => s.text),
    ["div"],
  );
  assert.equal(rule.order, 0);
  assert.deepEqual([...rule.specificity], [0, 0, 1]);

  assert.deepEqual(
    rule.declarations.map((d) => ({ p: d.property, v: d.value, i: d.important })),
    [
      { p: "color", v: "red", i: false },
      { p: "width", v: "100px", i: false },
    ],
  );
});

void test("multiple rules are kept in source order with increasing `order`", () => {
  const sheet = parse("div { color: red } p { color: blue } span { display: none }");
  assert.equal(sheet.rules.length, 3);
  assert.deepEqual(
    sheet.rules.map((r) => r.order),
    [0, 1, 2],
  );
  assert.deepEqual(
    sheet.rules.map((r) => r.selector[0]?.text),
    ["div", "p", "span"],
  );
});

void test("a comma-separated selector list expands into one rule per selector", () => {
  const sheet = parse("h1, .lead, #main { color: black }");
  assert.equal(sheet.rules.length, 3);

  assert.deepEqual(
    sheet.rules.map((r) => r.selector[0]?.text),
    ["h1", ".lead", "#main"],
  );
  // Each expanded rule still carries the same declarations…
  for (const rule of sheet.rules) {
    assert.deepEqual(
      rule.declarations.map((d) => d.property),
      ["color"],
    );
  }
  // …but its own specificity and a distinct source order.
  assert.deepEqual(
    sheet.rules.map((r) => [...r.specificity]),
    [
      [0, 0, 1], // h1   — one type
      [0, 1, 0], // .lead — one class
      [1, 0, 0], // #main — one id
    ],
  );
  assert.deepEqual(
    sheet.rules.map((r) => r.order),
    [0, 1, 2],
  );
});

void test("specificity counts ids, classes/attrs/pseudo-classes, and types/pseudo-elements", () => {
  const cases: ReadonlyArray<readonly [string, readonly [number, number, number]]> = [
    ["*", [0, 0, 0]],
    ["li", [0, 0, 1]],
    ["ul li", [0, 0, 2]],
    ["ul > li", [0, 0, 2]],
    [".a", [0, 1, 0]],
    ["a.b.c", [0, 2, 1]],
    ["#id", [1, 0, 0]],
    ["#id .cls a", [1, 1, 1]],
    ["a[href]", [0, 1, 1]],
    ["a:hover", [0, 1, 1]],
    ["p::before", [0, 0, 2]],
    ["#a #b .c .d e", [2, 2, 1]],
  ];

  for (const [selector, expected] of cases) {
    const sheet = parse(`${selector} { color: red }`);
    const rule = sheet.rules[0];
    assert.ok(rule !== undefined, `expected a rule for "${selector}"`);
    assert.deepEqual([...rule.specificity], [...expected], `specificity of "${selector}"`);
  }
});

void test("!important is detected and stripped from the stored value", () => {
  const sheet = parse("div { color: red !important; width: 50px }");
  const rule = sheet.rules[0];
  assert.ok(rule !== undefined);
  assert.deepEqual(
    rule.declarations.map((d) => ({ p: d.property, v: d.value, i: d.important })),
    [
      { p: "color", v: "red", i: true },
      { p: "width", v: "50px", i: false },
    ],
  );
});

void test("!important matching is case-insensitive and whitespace-tolerant", () => {
  const sheet = parse("div { color: blue ! IMPORTANT }");
  const decl = sheet.rules[0]?.declarations[0];
  assert.ok(decl !== undefined);
  assert.equal(decl.value, "blue");
  assert.equal(decl.important, true);
});

void test("property names are lowercased; raw value is preserved", () => {
  const sheet = parse("DIV { COLOR: RED }");
  const rule = sheet.rules[0];
  assert.ok(rule !== undefined);
  // Selector type names contribute to specificity regardless of case.
  assert.deepEqual([...rule.specificity], [0, 0, 1]);
  const decl = rule.declarations[0];
  assert.ok(decl !== undefined);
  assert.equal(decl.property, "color");
  assert.equal(decl.value, "RED");
});

void test("Req 18.6: a malformed declaration is skipped, the rest of the block survives", () => {
  // `garbage` has no colon; `width: 100px` is well-formed.
  const sheet = parse("div { garbage; color: red; width: 100px }");
  const rule = sheet.rules[0];
  assert.ok(rule !== undefined);
  assert.deepEqual(
    rule.declarations.map((d) => d.property),
    ["color", "width"],
  );
});

void test("Req 18.6: a known property with an invalid value is dropped via the generated parser", () => {
  // `width: red` is invalid (`width` wants <length>|auto); `color: red` is fine.
  const sheet = parse("div { width: red; color: red }");
  const rule = sheet.rules[0];
  assert.ok(rule !== undefined);
  assert.deepEqual(
    rule.declarations.map((d) => ({ p: d.property, v: d.value })),
    [{ p: "color", v: "red" }],
  );
});

void test("unknown properties are kept verbatim (forward-compatible recovery)", () => {
  const sheet = parse("div { -webkit-foo: bar; color: red }");
  const rule = sheet.rules[0];
  assert.ok(rule !== undefined);
  assert.deepEqual(
    rule.declarations.map((d) => ({ p: d.property, v: d.value })),
    [
      { p: "-webkit-foo", v: "bar" },
      { p: "color", v: "red" },
    ],
  );
});

void test("comments are stripped and do not fuse adjacent tokens", () => {
  const sheet = parse("div /* c */ { color/* x */: red /* y */ }");
  const rule = sheet.rules[0];
  assert.ok(rule !== undefined);
  assert.deepEqual(rule.selector[0]?.text, "div");
  const decl = rule.declarations[0];
  assert.ok(decl !== undefined);
  assert.equal(decl.property, "color");
  assert.equal(decl.value, "red");
});

void test("a rule with an empty/garbage selector prelude is skipped", () => {
  const sheet = parse("{ color: red } p { color: blue }");
  assert.equal(sheet.rules.length, 1);
  assert.equal(sheet.rules[0]?.selector[0]?.text, "p");
});

void test("an unclosed final block is still recovered into a rule", () => {
  const sheet = parse("div { color: red");
  assert.equal(sheet.rules.length, 1);
  const decl = sheet.rules[0]?.declarations[0];
  assert.ok(decl !== undefined);
  assert.equal(decl.property, "color");
  assert.equal(decl.value, "red");
});

void test("an empty stylesheet yields no rules", () => {
  assert.equal(parse("").rules.length, 0);
  assert.equal(parse("   \n\t  ").rules.length, 0);
  assert.equal(parse("/* only a comment */").rules.length, 0);
});

void test("margin shorthand (1–4 lengths) is accepted by the generated parser", () => {
  const sheet = parse("div { margin: 1px 2px 3px 4px }");
  const decl = sheet.rules[0]?.declarations[0];
  assert.ok(decl !== undefined);
  assert.equal(decl.property, "margin");
  assert.equal(decl.value, "1px 2px 3px 4px");
});

// ---------------------------------------------------------------------------
// At-rules are an unimplemented capability — they must fail loudly (Req 5.1).
// ---------------------------------------------------------------------------
void test("at-rules throw NotImplemented rather than being silently dropped", () => {
  assert.throws(() => parse("@media screen { div { color: red } }"), /NotImplemented/);
});

// ---------------------------------------------------------------------------
// Req 3.2 — the result is deep-frozen so a downstream stage cannot mutate it.
// ---------------------------------------------------------------------------
void test("Req 3.2: the returned StyleSheet is deep-frozen", () => {
  const sheet = parse("div, .x { color: red; width: 1px }");
  assert.ok(Object.isFrozen(sheet));
  assert.ok(Object.isFrozen(sheet.rules));
  for (const rule of sheet.rules) {
    assert.ok(Object.isFrozen(rule));
    assert.ok(Object.isFrozen(rule.selector));
    assert.ok(Object.isFrozen(rule.declarations));
    assert.ok(Object.isFrozen(rule.specificity));
    for (const decl of rule.declarations) {
      assert.ok(Object.isFrozen(decl));
    }
  }

  const rule = sheet.rules[0];
  assert.ok(rule !== undefined);
  assert.throws(() => {
    (rule as unknown as Record<string, unknown>)["order"] = 99;
  }, TypeError);
});

// ---------------------------------------------------------------------------
// Req 2.7 — parseCss is a pure function: same bytes ⇒ structurally equal IR.
// ---------------------------------------------------------------------------
void test("Req 2.7: parseCss is deterministic for identical input", () => {
  const css =
    "h1, .lead { color: red !important; width: 100px } #main p > span { display: none }";

  const serialize = (sheet: StyleSheet): string =>
    sheet.rules
      .map(
        (r) =>
          `${r.order}|[${r.specificity.join(",")}]|${r.selector
            .map((s) => s.text)
            .join(",")}|${r.declarations
            .map((d) => `${d.property}=${d.value}!${String(d.important)}`)
            .join(";")}`,
      )
      .join("||");

  assert.equal(serialize(parse(css)), serialize(parse(css)));
});
