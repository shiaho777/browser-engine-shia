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

void test("background shorthand expands a lone color to background-color", () => {
  assert.deepEqual(expandShorthand("background", "#2b221c"), [
    { property: "background-color", value: "#2b221c" },
  ]);
  assert.deepEqual(expandShorthand("background", "rgba(180, 126, 87, 0.2)"), [
    { property: "background-color", value: "rgba(180, 126, 87, 0.2)" },
  ]);
  assert.deepEqual(expandShorthand("background", "red"), [
    { property: "background-color", value: "red" },
  ]);
});

void test("background none resets color and image", () => {
  assert.deepEqual(expandShorthand("background", "none"), [
    { property: "background-color", value: "transparent" },
    { property: "background-image", value: "none" },
  ]);
  assert.deepEqual(expandShorthand("background", "NONE"), [
    { property: "background-color", value: "transparent" },
    { property: "background-image", value: "none" },
  ]);
});

void test("background shorthand expands a lone url to background-image", () => {
  assert.deepEqual(expandShorthand("background", "url(bg.png)"), [
    { property: "background-image", value: "url(bg.png)" },
  ]);
});

void test("background shorthand declines gradients, layers, and combos", () => {
  assert.equal(
    expandShorthand("background", "linear-gradient(90deg, red 0%, blue 100%)"),
    null,
  );
  assert.equal(expandShorthand("background", "red, blue"), null);
  assert.equal(expandShorthand("background", "#fff url(bg.png) no-repeat"), null);
  assert.equal(expandShorthand("background", ""), null);
});

void test("background shorthand passes a lone var() through to background-color", () => {
  assert.deepEqual(expandShorthand("background", "var(--accent)"), [
    { property: "background-color", value: "var(--accent)" },
  ]);
  assert.deepEqual(expandShorthand("background", "var(--missing, red)"), [
    { property: "background-color", value: "var(--missing, red)" },
  ]);
});

// ---------------------------------------------------------------------------
// A5 import wave: inset / overflow / place-* / text-decoration / font.
// ---------------------------------------------------------------------------

void test("inset expands 1-to-4 values per the CSS quad rules", () => {
  assert.deepEqual(expandShorthand("inset", "0"), [
    { property: "top", value: "0" },
    { property: "right", value: "0" },
    { property: "bottom", value: "0" },
    { property: "left", value: "0" },
  ]);
  assert.deepEqual(expandShorthand("inset", "10px 20px"), [
    { property: "top", value: "10px" },
    { property: "right", value: "20px" },
    { property: "bottom", value: "10px" },
    { property: "left", value: "20px" },
  ]);
  assert.deepEqual(expandShorthand("inset", "1px 2px 3px 4px"), [
    { property: "top", value: "1px" },
    { property: "right", value: "2px" },
    { property: "bottom", value: "3px" },
    { property: "left", value: "4px" },
  ]);
  assert.equal(expandShorthand("inset", "1px 2px 3px 4px 5px"), null);
});

void test("inset-block / inset-inline expand start+end", () => {
  assert.deepEqual(expandShorthand("inset-block", "5px 10px"), [
    { property: "inset-block-start", value: "5px" },
    { property: "inset-block-end", value: "10px" },
  ]);
  assert.deepEqual(expandShorthand("inset-inline", "auto"), [
    { property: "inset-inline-start", value: "auto" },
    { property: "inset-inline-end", value: "auto" },
  ]);
});

void test("overflow expands to x/y, one value doubles; overlay normalizes to auto", () => {
  assert.deepEqual(expandShorthand("overflow", "hidden"), [
    { property: "overflow-x", value: "hidden" },
    { property: "overflow-y", value: "hidden" },
  ]);
  assert.deepEqual(expandShorthand("overflow", "hidden auto"), [
    { property: "overflow-x", value: "hidden" },
    { property: "overflow-y", value: "auto" },
  ]);
  assert.deepEqual(expandShorthand("overflow", "overlay"), [
    { property: "overflow-x", value: "auto" },
    { property: "overflow-y", value: "auto" },
  ]);
  assert.equal(expandShorthand("overflow", "sideways"), null);
});

void test("place-items/content/self expand align + justify, one value doubles", () => {
  assert.deepEqual(expandShorthand("place-items", "center"), [
    { property: "align-items", value: "center" },
    { property: "justify-items", value: "center" },
  ]);
  assert.deepEqual(expandShorthand("place-content", "space-between center"), [
    { property: "align-content", value: "space-between" },
    { property: "justify-content", value: "center" },
  ]);
  assert.deepEqual(expandShorthand("place-self", "center start"), [
    { property: "align-self", value: "center" },
    { property: "justify-self", value: "start" },
  ]);
});

void test("text-decoration expands line/style/color in any order", () => {
  assert.deepEqual(expandShorthand("text-decoration", "underline"), [
    { property: "text-decoration-line", value: "underline" },
  ]);
  assert.deepEqual(expandShorthand("text-decoration", "underline dotted red"), [
    { property: "text-decoration-line", value: "underline" },
    { property: "text-decoration-style", value: "dotted" },
    { property: "text-decoration-color", value: "red" },
  ]);
  assert.deepEqual(expandShorthand("text-decoration", "red line-through"), [
    { property: "text-decoration-line", value: "line-through" },
    { property: "text-decoration-color", value: "red" },
  ]);
  assert.equal(expandShorthand("text-decoration", "underline red dotted wavy"), null);
});

void test("font expands the dominant forms with size[/line-height] + family", () => {
  assert.deepEqual(expandShorthand("font", "16px sans-serif"), [
    { property: "font-size", value: "16px" },
    { property: "font-family", value: "sans-serif" },
  ]);
  assert.deepEqual(expandShorthand("font", "italic bold 14px/1.5 \"Helvetica Neue\", Arial"), [
    { property: "font-style", value: "italic" },
    { property: "font-weight", value: "bold" },
    { property: "font-size", value: "14px" },
    { property: "line-height", value: "1.5" },
    { property: "font-family", value: "\"Helvetica Neue\", Arial" },
  ]);
  assert.deepEqual(expandShorthand("font", "700 12px monospace"), [
    { property: "font-weight", value: "700" },
    { property: "font-size", value: "12px" },
    { property: "font-family", value: "monospace" },
  ]);
  assert.deepEqual(expandShorthand("font", "oblique 2em serif"), [
    { property: "font-style", value: "oblique" },
    { property: "font-size", value: "2em" },
    { property: "font-family", value: "serif" },
  ]);
  // System font keywords pass through as the family (honest single longhand).
  assert.deepEqual(expandShorthand("font", "system-ui"), [
    { property: "font-family", value: "system-ui" },
  ]);
  // Missing family = invalid per spec.
  assert.equal(expandShorthand("font", "bold 14px"), null);
  assert.equal(expandShorthand("font", ""), null);
});
