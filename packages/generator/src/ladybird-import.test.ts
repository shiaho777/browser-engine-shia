/**
 * ladybird-import.test.ts — integrity guards for the Ladybird-derived property
 * rows (`generated/ladybird-properties.data.ts`).
 *
 * The import adapter (tools/ladybird-import/import-properties.mjs) is a one-shot
 * tool; these tests are the permanent guard that keeps its committed output
 * honest: no name may collide with the hand-written table, every grammar must
 * be one of the closed ValueGrammar kinds, and every row must carry a
 * well-formed initial / tsType.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { CSS_PROPERTIES } from "./css-properties.data.js";
import { LADYBIRD_PROPERTIES, LADYBIRD_ALIASES } from "./generated/ladybird-properties.data.js";

const VALID_GRAMMAR_KINDS = new Set([
  "keyword", "color", "length", "length-or-keyword", "edges",
  "integer", "integer-or-keyword", "number", "transform", "string",
]);

void test("imported row names are unique and never collide with hand-written rows", () => {
  const importedNames = LADYBIRD_PROPERTIES.map((p) => p.name);
  assert.equal(new Set(importedNames).size, importedNames.length, "duplicate names inside the import");

  const handWritten = CSS_PROPERTIES.filter((p) => !importedNames.includes(p.name)).map((p) => p.name);
  for (const name of importedNames) {
    assert.equal(handWritten.includes(name), false, `${name} collides with a hand-written row`);
  }
});

void test("every imported row uses a closed-vocabulary grammar and well-formed fields", () => {
  for (const row of LADYBIRD_PROPERTIES) {
    assert.ok(VALID_GRAMMAR_KINDS.has(row.syntax.kind), `${row.name}: unknown grammar kind ${row.syntax.kind}`);
    assert.notEqual(row.initial, undefined, `${row.name}: missing initial`);
    assert.notEqual(row.tsType, "", `${row.name}: empty tsType`);
    assert.match(row.field, /^[a-zA-Z][a-zA-Z0-9]*$/, `${row.name}: bad field ${row.field}`);
    assert.ok(
      row.animationType === "discrete" || row.animationType === "by-computed-value" || row.animationType === "none",
      `${row.name}: bad animationType ${row.animationType}`,
    );
  }
});

void test("aliases are mappings only (never shadow real rows, valid shape)", () => {
  const propertyNames = new Set(CSS_PROPERTIES.map((p) => p.name));
  for (const alias of LADYBIRD_ALIASES) {
    assert.equal(propertyNames.has(alias.name), false, `alias ${alias.name} shadows a real row`);
    assert.ok(alias.kind === "legacy" || alias.kind === "logical", `alias ${alias.name}: bad kind`);
    if (alias.kind === "legacy") {
      assert.equal(typeof alias.target, "string", `legacy alias ${alias.name}: missing target`);
    }
    if (alias.kind === "logical") {
      assert.equal(typeof alias.group, "string", `logical alias ${alias.name}: missing group`);
      assert.equal(typeof alias.mapping, "string", `logical alias ${alias.name}: missing mapping`);
    }
  }
});

void test("the import landed a meaningful breadth expansion", () => {
  // Guard against an accidentally-empty or truncated regeneration.
  assert.ok(LADYBIRD_PROPERTIES.length >= 100, `expected ≥100 imported rows, got ${LADYBIRD_PROPERTIES.length}`);
});
