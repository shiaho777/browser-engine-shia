/**
 * Tests for CSS @media query parsing and evaluation (ROADMAP Phase 2).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { mediaQueryListMatches, mediaQueryMatches, DEFAULT_MEDIA_ENVIRONMENT } from "./media-query.js";
import type { MediaEnvironment } from "./media-query.js";
import { parseCss } from "./index.js";

const SCREEN: MediaEnvironment = { type: "screen", widthPx: 800, heightPx: 600 };
const PRINT: MediaEnvironment = { type: "print", widthPx: 800, heightPx: 600 };
const NARROW: MediaEnvironment = { type: "screen", widthPx: 400, heightPx: 600 };

void test("empty media query list matches (spec: empty = all)", () => {
  assert.ok(mediaQueryListMatches("", SCREEN));
  assert.ok(mediaQueryListMatches("   ", SCREEN));
});

void test("media type screen matches screen environment", () => {
  assert.ok(mediaQueryMatches("screen", SCREEN));
  assert.ok(!mediaQueryMatches("print", SCREEN));
  assert.ok(mediaQueryMatches("all", SCREEN));
});

void test("media type print matches print environment", () => {
  assert.ok(mediaQueryMatches("print", PRINT));
  assert.ok(!mediaQueryMatches("screen", PRINT));
});

void test("not screen matches when environment is print", () => {
  assert.ok(mediaQueryMatches("not screen", PRINT));
  assert.ok(!mediaQueryMatches("not screen", SCREEN));
});

void test("only screen matches", () => {
  assert.ok(mediaQueryMatches("only screen", SCREEN));
  assert.ok(!mediaQueryMatches("only print", SCREEN));
});

void test("min-width feature", () => {
  assert.ok(mediaQueryMatches("screen and (min-width: 800px)", SCREEN));
  assert.ok(!mediaQueryMatches("screen and (min-width: 801px)", SCREEN));
  assert.ok(mediaQueryMatches("(min-width: 1px)", SCREEN));
});

void test("max-width feature", () => {
  assert.ok(mediaQueryMatches("screen and (max-width: 800px)", SCREEN));
  assert.ok(!mediaQueryMatches("screen and (max-width: 799px)", SCREEN));
});

void test("width exact match", () => {
  assert.ok(mediaQueryMatches("(width: 800px)", SCREEN));
  assert.ok(!mediaQueryMatches("(width: 801px)", SCREEN));
});

void test("min-height feature", () => {
  assert.ok(mediaQueryMatches("(min-height: 600px)", SCREEN));
  assert.ok(!mediaQueryMatches("(min-height: 601px)", SCREEN));
});

void test("orientation landscape on wide screen", () => {
  assert.ok(mediaQueryMatches("(orientation: landscape)", SCREEN));
  assert.ok(!mediaQueryMatches("(orientation: portrait)", SCREEN));
});

void test("orientation portrait on tall screen", () => {
  const tall: MediaEnvironment = { type: "screen", widthPx: 400, heightPx: 600 };
  assert.ok(mediaQueryMatches("(orientation: portrait)", tall));
  assert.ok(!mediaQueryMatches("(orientation: landscape)", tall));
});

void test("comma-separated list matches if any matches", () => {
  assert.ok(mediaQueryListMatches("print, screen", SCREEN));
  assert.ok(mediaQueryListMatches("screen, print", SCREEN));
  assert.ok(!mediaQueryListMatches("print, tv", SCREEN));
});

void test("combined features with and", () => {
  assert.ok(mediaQueryMatches("screen and (min-width: 1px) and (orientation: landscape)", SCREEN));
  assert.ok(!mediaQueryMatches("screen and (min-width: 801px) and (orientation: landscape)", SCREEN));
});

void test("unknown media feature does not match", () => {
  assert.ok(!mediaQueryMatches("(hover: hover)", SCREEN));
  assert.ok(!mediaQueryMatches("(unknown-feature: 5)", SCREEN));
});

void test("parseCss includes @media rules when condition matches", () => {
  const css = "@media screen { div { color: red } }";
  const sheet = parseCss(new TextEncoder().encode(css), SCREEN);
  assert.equal(sheet.rules.length, 1);
  assert.equal(sheet.rules[0]!.selector[0]!.text, "div");
  assert.equal(sheet.rules[0]!.declarations[0]!.property, "color");
});

void test("parseCss excludes @media rules when condition does not match", () => {
  const css = "@media print { div { color: red } }";
  const sheet = parseCss(new TextEncoder().encode(css), SCREEN);
  assert.equal(sheet.rules.length, 0);
});

void test("parseCss handles @media with min-width matching", () => {
  const css = "@media screen and (min-width: 500px) { div { width: 100px } }";
  const sheetWide = parseCss(new TextEncoder().encode(css), SCREEN);
  assert.equal(sheetWide.rules.length, 1);

  const sheetNarrow = parseCss(new TextEncoder().encode(css), NARROW);
  assert.equal(sheetNarrow.rules.length, 0); // 400px < 500px
});

void test("parseCss mixes @media and non-media rules", () => {
  const css = "p { color: blue } @media screen { div { color: red } } @media print { span { color: green } }";
  const sheet = parseCss(new TextEncoder().encode(css), SCREEN);
  assert.equal(sheet.rules.length, 2); // p + div (print span excluded)
  assert.equal(sheet.rules[0]!.selector[0]!.text, "p");
  assert.equal(sheet.rules[1]!.selector[0]!.text, "div");
});

void test("parseCss handles comma-separated media types in @media", () => {
  const css = "@media screen, print { div { color: red } }";
  const sheetScreen = parseCss(new TextEncoder().encode(css), SCREEN);
  assert.equal(sheetScreen.rules.length, 1);

  const sheetPrint = parseCss(new TextEncoder().encode(css), PRINT);
  assert.equal(sheetPrint.rules.length, 1);
});

void test("parseCss uses default media environment when none given", () => {
  const css = "@media screen { div { color: red } }";
  const sheet = parseCss(new TextEncoder().encode(css));
  assert.equal(sheet.rules.length, 1); // default is screen 800×600
});

void test("parseCss @media with not prefix", () => {
  const css = "@media not print { div { color: red } }";
  const sheetScreen = parseCss(new TextEncoder().encode(css), SCREEN);
  assert.equal(sheetScreen.rules.length, 1);

  const sheetPrint = parseCss(new TextEncoder().encode(css), PRINT);
  assert.equal(sheetPrint.rules.length, 0);
});

void test("DEFAULT_MEDIA_ENVIRONMENT is screen 800x600", () => {
  assert.equal(DEFAULT_MEDIA_ENVIRONMENT.type, "screen");
  assert.equal(DEFAULT_MEDIA_ENVIRONMENT.widthPx, 800);
  assert.equal(DEFAULT_MEDIA_ENVIRONMENT.heightPx, 600);
});

void test("minified and without spaces around and matches", () => {
  const env: MediaEnvironment = { type: "screen", widthPx: 1280, heightPx: 800 };
  assert.ok(mediaQueryListMatches("(min-width:1100px)and (max-width:1366.9px)", env));
  assert.ok(mediaQueryListMatches("(min-width:1140px)and (max-width:1299.9px)and (min-width:1140px)and (max-width:1299.9px)", env));
  assert.ok(!mediaQueryListMatches("(min-width:1400px)and (max-width:1559.9px)", env));
});

void test("parseCss includes minified media-query rules for bilibili-style breakpoints", () => {
  const css = "@media(min-width:1140px)and (max-width:1299.9px){.container{grid-template-columns:repeat(4,1fr)}}";
  const env: MediaEnvironment = { type: "screen", widthPx: 1280, heightPx: 800 };
  const sheet = parseCss(new TextEncoder().encode(css), env);
  assert.equal(sheet.rules.length, 1);
  assert.equal(sheet.rules[0]!.declarations[0]!.property, "grid-template-columns");
  assert.equal(sheet.rules[0]!.declarations[0]!.value, "repeat(4,1fr)");

  const narrow: MediaEnvironment = { type: "screen", widthPx: 800, heightPx: 600 };
  const sheetNarrow = parseCss(new TextEncoder().encode(css), narrow);
  assert.equal(sheetNarrow.rules.length, 0);
});
