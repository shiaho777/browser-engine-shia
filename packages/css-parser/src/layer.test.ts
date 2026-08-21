/**
 * Tests for CSS @layer cascade layers (CSS Cascading 5 §7; ROADMAP Phase 2).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseCss } from "./index.js";

void test("@layer block annotates rules with layer path", () => {
  const css = "@layer base { div { color: red } }";
  const sheet = parseCss(new TextEncoder().encode(css));
  assert.equal(sheet.rules.length, 1);
  assert.deepEqual(sheet.rules[0]!.layer, ["base"]);
});

void test("@layer declaration registers layer order", () => {
  const css = "@layer base, theme, utilities;";
  const sheet = parseCss(new TextEncoder().encode(css));
  assert.equal(sheet.rules.length, 0);
  assert.ok(sheet.layerOrder);
  assert.equal(sheet.layerOrder.length, 3);
  assert.deepEqual(sheet.layerOrder[0], ["base"]);
  assert.deepEqual(sheet.layerOrder[1], ["theme"]);
  assert.deepEqual(sheet.layerOrder[2], ["utilities"]);
});

void test("unlayered rules have undefined layer", () => {
  const css = "div { color: red }";
  const sheet = parseCss(new TextEncoder().encode(css));
  assert.equal(sheet.rules.length, 1);
  assert.equal(sheet.rules[0]!.layer, undefined);
});

void test("@layer with dotted name creates nested layer path", () => {
  const css = "@layer theme.buttons { div { color: red } }";
  const sheet = parseCss(new TextEncoder().encode(css));
  assert.equal(sheet.rules.length, 1);
  assert.deepEqual(sheet.rules[0]!.layer, ["theme", "buttons"]);
});

void test("@layer can contain @media", () => {
  const css = "@layer base { @media screen { div { color: red } } }";
  const sheet = parseCss(new TextEncoder().encode(css));
  assert.equal(sheet.rules.length, 1);
  assert.deepEqual(sheet.rules[0]!.layer, ["base"]);
});

void test("multiple @layer blocks register layers in order", () => {
  const css = "@layer base { div { color: red } } @layer theme { div { color: blue } }";
  const sheet = parseCss(new TextEncoder().encode(css));
  assert.equal(sheet.rules.length, 2);
  assert.deepEqual(sheet.rules[0]!.layer, ["base"]);
  assert.deepEqual(sheet.rules[1]!.layer, ["theme"]);
  assert.ok(sheet.layerOrder);
  assert.equal(sheet.layerOrder.length, 2);
});

void test("@layer declaration then block reuses same layer", () => {
  const css = "@layer base, theme; @layer base { div { color: red } }";
  const sheet = parseCss(new TextEncoder().encode(css));
  assert.equal(sheet.rules.length, 1);
  assert.deepEqual(sheet.rules[0]!.layer, ["base"]);
  assert.ok(sheet.layerOrder);
  assert.equal(sheet.layerOrder.length, 2); // base, theme (no duplicate)
});

void test("unlayered rules mix with layered rules", () => {
  const css = "div { color: green } @layer base { div { color: red } }";
  const sheet = parseCss(new TextEncoder().encode(css));
  assert.equal(sheet.rules.length, 2);
  assert.equal(sheet.rules[0]!.layer, undefined); // unlayered
  assert.deepEqual(sheet.rules[1]!.layer, ["base"]); // layered
});
