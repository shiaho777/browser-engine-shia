/**
 * Tests for CSS shorthand expansion (ROADMAP Phase 2).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { expandShorthand, expandDeclarations } from "./shorthand-expansion.js";
import type { Declaration } from "@browser-engine/ir";

void test("border shorthand expands to 12 longhands", () => {
  const result = expandShorthand("border", "1px solid red");
  assert.ok(result !== null);
  assert.equal(result.length, 12);
  const props = result.map((r) => r.property);
  assert.ok(props.includes("border-top-width"));
  assert.ok(props.includes("border-top-style"));
  assert.ok(props.includes("border-top-color"));
  assert.ok(props.includes("border-left-width"));
  assert.ok(props.includes("border-left-style"));
  assert.ok(props.includes("border-left-color"));
});

void test("border shorthand tokens in any order", () => {
  const r1 = expandShorthand("border", "red 1px solid");
  assert.ok(r1 !== null);
  const widthDecl = r1.find((d) => d.property === "border-top-width");
  assert.equal(widthDecl?.value, "1px");
  const styleDecl = r1.find((d) => d.property === "border-top-style");
  assert.equal(styleDecl?.value, "solid");
  const colorDecl = r1.find((d) => d.property === "border-top-color");
  assert.equal(colorDecl?.value, "red");
});

void test("border shorthand with partial values", () => {
  const result = expandShorthand("border", "solid");
  assert.ok(result !== null);
  assert.equal(result.length, 4); // only style for 4 edges
  assert.equal(result[0]?.property, "border-top-style");
  assert.equal(result[0]?.value, "solid");
});

void test("border shorthand with width keyword", () => {
  const result = expandShorthand("border", "thin solid black");
  assert.ok(result !== null);
  const widthDecl = result.find((d) => d.property === "border-top-width");
  assert.equal(widthDecl?.value, "thin");
});

void test("border-top expands to 3 longhands", () => {
  const result = expandShorthand("border-top", "2px dashed blue");
  assert.ok(result !== null);
  assert.equal(result.length, 3);
  assert.equal(result[0]?.property, "border-top-width");
  assert.equal(result[0]?.value, "2px");
  assert.equal(result[1]?.property, "border-top-style");
  assert.equal(result[1]?.value, "dashed");
  assert.equal(result[2]?.property, "border-top-color");
  assert.equal(result[2]?.value, "blue");
});

void test("flex shorthand: single number → grow only", () => {
  const result = expandShorthand("flex", "2");
  assert.ok(result !== null);
  assert.equal(result.length, 3);
  assert.equal(result[0]?.property, "flex-grow");
  assert.equal(result[0]?.value, "2");
  assert.equal(result[1]?.property, "flex-shrink");
  assert.equal(result[1]?.value, "1"); // default
  assert.equal(result[2]?.property, "flex-basis");
  assert.equal(result[2]?.value, "0%"); // default
});

void test("flex shorthand: grow + shrink", () => {
  const result = expandShorthand("flex", "2 0");
  assert.ok(result !== null);
  assert.equal(result[0]?.property, "flex-grow");
  assert.equal(result[0]?.value, "2");
  assert.equal(result[1]?.property, "flex-shrink");
  assert.equal(result[1]?.value, "0");
  assert.equal(result[2]?.property, "flex-basis");
  assert.equal(result[2]?.value, "0%");
});

void test("flex shorthand: grow + shrink + basis", () => {
  const result = expandShorthand("flex", "1 1 100px");
  assert.ok(result !== null);
  assert.equal(result[0]?.property, "flex-grow");
  assert.equal(result[0]?.value, "1");
  assert.equal(result[1]?.property, "flex-shrink");
  assert.equal(result[1]?.value, "1");
  assert.equal(result[2]?.property, "flex-basis");
  assert.equal(result[2]?.value, "100px");
});

void test("flex shorthand: none", () => {
  const result = expandShorthand("flex", "none");
  assert.ok(result !== null);
  assert.equal(result[0]?.property, "flex-grow");
  assert.equal(result[0]?.value, "0");
  assert.equal(result[1]?.property, "flex-shrink");
  assert.equal(result[1]?.value, "0");
  assert.equal(result[2]?.property, "flex-basis");
  assert.equal(result[2]?.value, "auto");
});

void test("flex shorthand: auto", () => {
  const result = expandShorthand("flex", "auto");
  assert.ok(result !== null);
  assert.equal(result[0]?.property, "flex-grow");
  assert.equal(result[0]?.value, "1");
  assert.equal(result[1]?.property, "flex-shrink");
  assert.equal(result[1]?.value, "1");
  assert.equal(result[2]?.property, "flex-basis");
  assert.equal(result[2]?.value, "auto");
});

void test("non-shorthand property returns null", () => {
  assert.equal(expandShorthand("color", "red"), null);
  assert.equal(expandShorthand("margin", "1px"), null);
  assert.equal(expandShorthand("display", "block"), null);
});

void test("invalid border value returns null", () => {
  assert.equal(expandShorthand("border", ""), null);
  assert.equal(expandShorthand("border", "foo bar baz qux"), null);
});

void test("expandDeclarations preserves non-shorthand declarations", () => {
  const decls: Declaration[] = [
    { property: "color", value: "red", important: false },
    { property: "display", value: "block", important: false },
  ];
  const result = expandDeclarations(decls);
  assert.equal(result.length, 2);
  assert.equal(result[0]?.property, "color");
  assert.equal(result[1]?.property, "display");
});

void test("expandDeclarations replaces shorthand with longhands", () => {
  const decls: Declaration[] = [
    { property: "border", value: "1px solid red", important: false },
  ];
  const result = expandDeclarations(decls);
  assert.equal(result.length, 12);
  assert.equal(result[0]?.property, "border-top-width");
  assert.equal(result[0]?.value, "1px");
});

void test("expandDeclarations preserves important flag on expanded longhands", () => {
  const decls: Declaration[] = [
    { property: "flex", value: "1", important: true },
  ];
  const result = expandDeclarations(decls);
  assert.equal(result.length, 3);
  for (const d of result) {
    assert.equal(d.important, true);
  }
});

void test("expandDeclarations mixes shorthand and non-shorthand", () => {
  const decls: Declaration[] = [
    { property: "color", value: "blue", important: false },
    { property: "flex", value: "1 0 auto", important: false },
    { property: "display", value: "flex", important: false },
  ];
  const result = expandDeclarations(decls);
  assert.equal(result.length, 5); // 1 + 3 + 1
  assert.equal(result[0]?.property, "color");
  assert.equal(result[1]?.property, "flex-grow");
  assert.equal(result[2]?.property, "flex-shrink");
  assert.equal(result[3]?.property, "flex-basis");
  assert.equal(result[4]?.property, "display");
});
