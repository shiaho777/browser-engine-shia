/**
 * Tests for CSS custom properties and var() substitution (ROADMAP Phase 2).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { substituteVars, collectCustomProperties, isCustomProperty } from "./var-substitution.js";

void test("isCustomProperty detects -- prefixed names", () => {
  assert.ok(isCustomProperty("--foo"));
  assert.ok(isCustomProperty("--my-color"));
  assert.ok(!isCustomProperty("color"));
  assert.ok(!isCustomProperty("width"));
});

void test("substituteVars replaces a simple var() reference", () => {
  const custom = new Map([["--color", "red"]]);
  const result = substituteVars("var(--color)", custom);
  assert.equal(result, "red");
});

void test("substituteVars replaces var() inside a larger value", () => {
  const custom = new Map([["--w", "100px"]]);
  const result = substituteVars("calc(var(--w) + 50px)", custom);
  assert.equal(result, "calc(100px + 50px)");
});

void test("substituteVars uses fallback when property is undefined", () => {
  const custom = new Map<string, string>();
  const result = substituteVars("var(--missing, blue)", custom);
  assert.equal(result, "blue");
});

void test("substituteVars returns null when no fallback and undefined", () => {
  const custom = new Map<string, string>();
  const result = substituteVars("var(--missing)", custom);
  assert.equal(result, null);
});

void test("substituteVars resolves nested custom property references", () => {
  const custom = new Map([
    ["--base", "10px"],
    ["--derived", "calc(var(--base) * 2)"],
  ]);
  const result = substituteVars("var(--derived)", custom);
  assert.equal(result, "calc(10px * 2)");
});

void test("substituteVars detects cycles and returns null", () => {
  const custom = new Map([
    ["--a", "var(--b)"],
    ["--b", "var(--a)"],
  ]);
  const result = substituteVars("var(--a)", custom);
  assert.equal(result, null);
});

void test("substituteVars handles var() with fallback containing var()", () => {
  const custom = new Map([["--fallback", "green"]]);
  // --missing is undefined, fallback is var(--fallback)
  const result = substituteVars("var(--missing, var(--fallback))", custom);
  assert.equal(result, "green");
});

void test("substituteVars handles multiple var() in one value", () => {
  const custom = new Map([
    ["--w", "100px"],
    ["--h", "50px"],
  ]);
  const result = substituteVars("var(--w) var(--h)", custom);
  assert.equal(result, "100px 50px");
});

void test("substituteVars passes through values without var()", () => {
  const custom = new Map([["--foo", "red"]]);
  assert.equal(substituteVars("100px", custom), "100px");
  assert.equal(substituteVars("red", custom), "red");
  assert.equal(substituteVars("calc(100px + 50px)", custom), "calc(100px + 50px)");
});

void test("collectCustomProperties merges parent and node declarations", () => {
  const parentCustom = new Map([["--inherited", "blue"]]);
  const winners = new Map([
    ["--inherited", { value: "red" }], // override
    ["--own", { value: "green" }],
    ["color", { value: "var(--own)" }], // not a custom property
  ]);
  const result = collectCustomProperties(winners, parentCustom);
  assert.equal(result.get("--inherited"), "red"); // overridden
  assert.equal(result.get("--own"), "green");
  assert.equal(result.size, 2); // "color" is not a custom property
});

void test("collectCustomProperties inherits parent properties not overridden", () => {
  const parentCustom = new Map([["--from-parent", "inherited"]]);
  const winners = new Map([["--own", { value: "own" }]]);
  const result = collectCustomProperties(winners, parentCustom);
  assert.equal(result.get("--from-parent"), "inherited");
  assert.equal(result.get("--own"), "own");
});
