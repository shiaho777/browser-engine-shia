/**
 * Tests for CSS shorthand expansion (ROADMAP Phase 2).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { expandShorthand, expandDeclarations, serializeFlexFlow } from "./shorthand-expansion.js";
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

void test("flex-flow shorthand sets direction and wrap", () => {
  const column = expandShorthand("flex-flow", "nowrap column");
  assert.ok(column !== null);
  assert.equal(column.find((d) => d.property === "flex-direction")?.value, "column");
  assert.equal(column.find((d) => d.property === "flex-wrap")?.value, "nowrap");
  assert.equal(serializeFlexFlow("column", "nowrap"), "column");
  assert.equal(serializeFlexFlow("row", "wrap"), "wrap");
  assert.equal(serializeFlexFlow("row-reverse", "wrap"), "row-reverse wrap");
  assert.equal(serializeFlexFlow("row", "nowrap"), "row");
  assert.equal(expandShorthand("flex-flow", "wrap row balance"), null);
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
  assert.equal(expandShorthand("padding", "1px"), null);
  assert.equal(expandShorthand("display", "block"), null);
});

void test("invalid border value returns null", () => {
  assert.equal(expandShorthand("border", ""), null);
  assert.equal(expandShorthand("border", "foo bar baz qux"), null);
});

void test("font shorthand sets size, line-height, and family and resets the rest", () => {
  const result = expandShorthand("font", "20px/1 Ahem");
  assert.ok(result !== null);
  if (result === null) return;
  const byName = new Map(result.map((d) => [d.property, d.value]));
  assert.equal(byName.get("font-size"), "20px");
  assert.equal(byName.get("line-height"), "1");
  assert.equal(byName.get("font-family"), "Ahem");
  assert.equal(byName.get("font-weight"), "400");
  assert.equal(byName.get("font-style"), "normal");
});

void test("font shorthand accepts a leading weight and a quoted family", () => {
  const result = expandShorthand("font", "bold italic 16px/1.5 \"Times New Roman\", serif");
  assert.ok(result !== null);
  if (result === null) return;
  const byName = new Map(result.map((d) => [d.property, d.value]));
  assert.equal(byName.get("font-weight"), "700");
  assert.equal(byName.get("font-style"), "italic");
  assert.equal(byName.get("font-size"), "16px");
  assert.equal(byName.get("line-height"), "1.5");
  assert.equal(byName.get("font-family"), "\"Times New Roman\", serif");
});

void test("expandDeclarations expands font into font-variant longhands", () => {
  const result = expandDeclarations([
    { property: "font", value: "small-caps 20px Ahem", important: false },
  ]);
  const names = result.map((d) => d.property);
  assert.ok(names.includes("font-size"));
  assert.ok(names.includes("font-variant-caps"));
  assert.equal(result.find((d) => d.property === "font-variant-caps")?.value, "small-caps");
  assert.equal(result.find((d) => d.property === "font-variant"), undefined);
});

void test("inset and margin shorthands expand to the four edges", () => {
  const inset = expandShorthand("inset", "0");
  assert.ok(inset !== null);
  if (inset === null) return;
  assert.deepEqual(inset.map((d) => d.property), ["top", "right", "bottom", "left"]);
  assert.ok(inset.every((d) => d.value === "0"));
  const margin = expandShorthand("margin", "auto");
  assert.ok(margin !== null);
  if (margin === null) return;
  assert.equal(margin.find((d) => d.property === "margin-top")?.value, "auto");
  assert.equal(margin.find((d) => d.property === "margin-left")?.value, "auto");
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

// ---------------------------------------------------------------------------
// font-variant shorthand (RFC 0006): tokens route to the five longhands.
// ---------------------------------------------------------------------------

void test("font-variant: small-caps expands to font-variant-caps", () => {
  const result = expandShorthand("font-variant", "small-caps");
  assert.deepEqual(result, [{ property: "font-variant-caps", value: "small-caps" }]);
});

void test("font-variant routes each token class to its longhand", () => {
  const result = expandShorthand(
    "font-variant",
    "common-ligatures oldstyle-nums sub styleset(1, 4) jis04",
  );
  assert.ok(result !== null);
  const map = new Map(result.map((d) => [d.property, d.value]));
  assert.equal(map.get("font-variant-ligatures"), "common-ligatures");
  assert.equal(map.get("font-variant-numeric"), "oldstyle-nums");
  assert.equal(map.get("font-variant-position"), "sub");
  assert.equal(map.get("font-variant-alternates"), "styleset(1, 4)");
  assert.equal(map.get("font-variant-east-asian"), "jis04");
});

void test("font-variant: normal resets all longhands; none disables ligatures", () => {
  const normal = expandShorthand("font-variant", "normal");
  assert.ok(normal !== null);
  assert.equal(normal.length, 6);
  assert.ok(normal.every((d) => d.value === "normal"));
  assert.deepEqual(expandShorthand("font-variant", "none"), [
    { property: "font-variant-ligatures", value: "none" },
  ]);
});

void test("font-variant with an unknown token does not expand", () => {
  assert.equal(expandShorthand("font-variant", "small-caps bogus-token"), null);
});

// ---------------------------------------------------------------------------
// `background` (RFC 0008): layered shorthand → the seven longhand lists.
// ---------------------------------------------------------------------------

void test("background: color-only expands to just background-color", () => {
  const r = expandShorthand("background", "red");
  assert.ok(r !== null);
  const map = new Map(r.map((d) => [d.property, d.value]));
  assert.equal(map.get("background-color"), "red");
  assert.equal(map.get("background-image"), "none");
});

void test("background: url + repeat + position routes each token", () => {
  const r = expandShorthand("background", "url(bg.png) no-repeat center");
  assert.ok(r !== null);
  const map = new Map(r.map((d) => [d.property, d.value]));
  assert.equal(map.get("background-image"), "url(bg.png)");
  assert.equal(map.get("background-repeat"), "no-repeat");
  assert.equal(map.get("background-position"), "center");
  assert.equal(map.get("background-size"), "auto");
  assert.equal(map.get("background-color"), undefined, "no color in the layer");
});

void test("background: position/size split on the slash", () => {
  const r = expandShorthand("background", "url(a.png) center / cover no-repeat");
  assert.ok(r !== null);
  const map = new Map(r.map((d) => [d.property, d.value]));
  assert.equal(map.get("background-position"), "center");
  assert.equal(map.get("background-size"), "cover");
});

void test("background: box keywords map origin→clip in order", () => {
  const r = expandShorthand("background", "url(a.png) content-box border-box");
  assert.ok(r !== null);
  const map = new Map(r.map((d) => [d.property, d.value]));
  assert.equal(map.get("background-origin"), "content-box");
  assert.equal(map.get("background-clip"), "border-box");
});

void test("background: comma layers expand to parallel longhand lists", () => {
  const r = expandShorthand("background", "url(a.png) no-repeat, url(b.png) repeat-x fixed red");
  assert.ok(r !== null);
  const map = new Map(r.map((d) => [d.property, d.value]));
  assert.equal(map.get("background-image"), "url(a.png), url(b.png)");
  assert.equal(map.get("background-repeat"), "no-repeat, repeat-x");
  assert.equal(map.get("background-attachment"), "scroll, fixed");
  assert.equal(map.get("background-color"), "red", "color legal on the final layer");
});

void test("background: a color on a non-final layer is invalid (dropped)", () => {
  assert.equal(expandShorthand("background", "red, url(b.png)"), null);
});

void test("background: a size without a position is invalid", () => {
  assert.equal(expandShorthand("background", "url(a.png) / cover"), null);
});
