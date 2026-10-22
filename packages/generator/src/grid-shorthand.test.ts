import test from "node:test";
import assert from "node:assert/strict";

import { expandShorthand } from "./shorthand-expansion.js";
import { canonicalGridAreas, serializeGrid, serializeGridArea, serializeGridPlacement } from "./grid-shorthand.js";

void test("grid-column copies a custom ident to both lines and leaves a number's end auto", () => {
  const ident = expandShorthand("grid-column", "last");
  assert.deepEqual(ident, [
    { property: "grid-column-start", value: "last" },
    { property: "grid-column-end", value: "last" },
  ]);
  const line = expandShorthand("grid-column", "3 last");
  assert.equal(line?.[0]?.value, "3 last");
  assert.equal(line?.[1]?.value, "auto");
  assert.equal(serializeGridPlacement("10", "auto"), "10");
  assert.equal(serializeGridPlacement("first", "first"), "first");
  assert.equal(serializeGridPlacement("2 j", "span 3 k"), "2 j / span 3 k");
});

void test("grid-area fills omitted lines from custom idents", () => {
  const two = expandShorthand("grid-area", "a / b");
  assert.deepEqual(two?.map((decl) => decl.value), ["a", "b", "a", "b"]);
  const one = expandShorthand("grid-area", "1");
  assert.deepEqual(one?.map((decl) => decl.value), ["1", "auto", "auto", "auto"]);
  assert.equal(serializeGridArea("auto", "i", "auto", "i"), "auto / i");
  assert.equal(serializeGridArea("1", "auto", "auto", "auto"), "1");
  assert.equal(serializeGridArea("1", "auto", "i", "auto"), "1 / auto / i");
  assert.equal(serializeGridArea("i", "auto", "i", "auto"), "i / auto");
});

void test("grid-template areas merge adjacent line names and grid resets the auto properties", () => {
  const template = expandShorthand(
    "grid-template",
    '[header-top] "a a a" [header-bottom] [main-top] "b b b" 1fr [main-bottom] / auto 1fr auto',
  );
  assert.equal(
    template?.find((decl) => decl.property === "grid-template-rows")?.value,
    "[header-top] auto [header-bottom main-top] 1fr [main-bottom]",
  );
  assert.equal(template?.find((decl) => decl.property === "grid-template-areas")?.value, '"a a a" "b b b"');
  const grid = expandShorthand("grid", "10px / auto-flow dense 20px");
  assert.equal(grid?.find((decl) => decl.property === "grid-auto-flow")?.value, "column dense");
  assert.equal(grid?.find((decl) => decl.property === "grid-auto-columns")?.value, "20px");
  assert.equal(grid?.find((decl) => decl.property === "grid-template-columns")?.value, "none");
  assert.equal(
    serializeGrid("10px", "none", "none", "auto", "20px", "column dense"),
    "10px / auto-flow dense 20px",
  );
  assert.equal(expandShorthand("grid", "10px"), null);
  assert.equal(expandShorthand("grid-template", "10px"), null);
});

void test("grid-template-areas canonicalizes cells and rejects a broken rectangle", () => {
  assert.equal(canonicalGridAreas("none"), "none");
  assert.equal(canonicalGridAreas('"a b""c d"'), '"a b" "c d"');
  assert.equal(canonicalGridAreas('".. a ..." "b a c"'), '". a ." "b a c"');
  assert.equal(canonicalGridAreas('"...header header...."'), '". header header ."');
  assert.equal(canonicalGridAreas('"a b a"'), null);
  assert.equal(canonicalGridAreas('"a" "b c"'), null);
  assert.equal(canonicalGridAreas('"10%"'), null);
  assert.equal(canonicalGridAreas("a"), null);
});
