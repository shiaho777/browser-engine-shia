/**
 * Tests for DOM-surface generation and its independence from CSS-parser
 * generation (task 3.2).
 *
 * Covers design.md §4.2 and Requirements 6.3, 6.4:
 *   - 6.3: the guest-visible DOM surface is generated from the IDL table — one
 *     interface per row, with attributes and operations.
 *   - 6.4: DOM-surface generation is INDEPENDENT of CSS-parser generation. A
 *     thrown error in the CSS path must NOT block the DOM path: `generate()`
 *     isolates the two so the DOM surface is still produced.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { DOM_INTERFACES } from "./dom-interfaces.idl.js";
import { emitDomArtifacts, emitDomSurface } from "./emit/dom-codegen.js";
import { generate } from "./emit/generate.js";
import type { CssPropertyDef } from "./css-property-def.js";
import { DOM_SURFACE_FILE } from "./emit/dom-codegen.js";

void test("Req 6.3: DOM surface is emitted with one interface per IDL row", () => {
  const file = emitDomSurface(DOM_INTERFACES);
  assert.equal(file.path, DOM_SURFACE_FILE);
  assert.match(file.contents, /@generated\b/);
  for (const iface of DOM_INTERFACES) {
    assert.ok(
      file.contents.includes(`export interface ${iface.name}`),
      `must emit interface ${iface.name}`,
    );
  }
  // attributes become typed fields; operations become typed methods
  assert.match(file.contents, /readonly nodeName: string;/);
  assert.match(file.contents, /hasChildNodes\(\): boolean;/);
  assert.match(file.contents, /getAttribute\(name: string\): string \| null;/);
  // inheritance is carried through
  assert.match(file.contents, /export interface Element extends Node/);
  // the runtime descriptor table is emitted
  assert.match(file.contents, /export const DOM_SURFACE/);
});

void test("Req 6.3: emitDomArtifacts yields the DOM-surface file", () => {
  const files = emitDomArtifacts(DOM_INTERFACES);
  assert.equal(files.length, 1);
  assert.equal(files[0]?.path, DOM_SURFACE_FILE);
});

void test("Req 6.4: generate() runs CSS and DOM paths and both succeed by default", () => {
  const result = generate();
  assert.equal(result.css.ok, true);
  assert.equal(result.dom.ok, true);
  assert.equal(result.ok, true);
  // produced files include both CSS artifacts and the DOM surface
  const paths = result.files.map((f) => f.path);
  assert.ok(paths.includes("css-parsing.ts"));
  assert.ok(paths.includes(DOM_SURFACE_FILE));
});

void test("Req 6.4: a failing CSS path does NOT block DOM generation", () => {
  // A malformed property row whose `initial` value cannot be serialized makes
  // the CSS emitter throw. The DOM path shares no input with it, so it must
  // still succeed.
  const poison = {
    name: "broken",
    inherited: false,
    initial: () => 0, // a function is not serializable → CSS emit throws
    syntax: { kind: "color" },
    computeValue: (s: unknown) => s,
    animationType: "none",
    tsType: "Color",
    field: "broken",
  } as unknown as CssPropertyDef;

  const result = generate({ properties: [poison] });

  // CSS path failed...
  assert.equal(result.css.ok, false);
  assert.ok(!result.css.ok && result.css.error.length > 0);
  // ...but DOM path is unaffected and still produced its surface.
  assert.equal(result.dom.ok, true);
  assert.ok(result.dom.ok && result.dom.files.length === 1);
  assert.equal(result.dom.ok && result.dom.files[0]?.path, DOM_SURFACE_FILE);
  // the overall files still include the DOM surface despite the CSS failure
  assert.ok(result.files.some((f) => f.path === DOM_SURFACE_FILE));
  // and the overall run reports not-ok because one path failed
  assert.equal(result.ok, false);
});

void test("Req 6.4: a failing DOM path does NOT block CSS generation", () => {
  // A malformed interface (unknown IDL type) makes the DOM emitter throw; the
  // CSS path must still succeed independently.
  const poison = {
    name: "Bad",
    members: [{ kind: "attribute", name: "x", type: "NopeType", readonly: true }],
  } as unknown as (typeof DOM_INTERFACES)[number];

  const result = generate({ interfaces: [poison] });

  assert.equal(result.dom.ok, false);
  assert.equal(result.css.ok, true);
  assert.ok(result.css.ok && result.css.files.length === 4);
  assert.ok(result.files.some((f) => f.path === "css-parsing.ts"));
  assert.equal(result.ok, false);
});
