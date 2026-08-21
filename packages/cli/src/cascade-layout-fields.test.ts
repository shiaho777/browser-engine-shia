/**
 * Cascade tests for the newly-connected layout/compositing fields on REAL
 * parsed input (platform-as-data-layout spec, task 4.2; Requirements 3.1, 3.2,
 * 3.3, 3.4).
 *
 * Built by `tsc` then run with: `node --test packages/cli/dist/*.test.js`.
 *
 * These prove the dead branch is welded shut at the cascade: a real
 * `parseHtml` + `parseCss` document, run through the real `cascade`, now carries
 * the layout/compositing properties under their GENERATED camelCase fields
 * (`flexDirection`, `gridTemplateColumns`, `zIndex`, …) — no synthetic
 * ComputedStyle. Undeclared properties fall back to their initial value, and the
 * ComputedStyle still contains NO geometry field (Requirement 3.4).
 *
 * The cli is an orchestration layer (not a pipeline stage), so it may import the
 * html-parser, css-parser, and cascade stages together to drive real input.
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { DomTree, NodeId } from "@browser-engine/ir";
import { parseHtml } from "@browser-engine/html-parser";
import { parseCss } from "@browser-engine/css-parser";
import { cascade } from "@browser-engine/cascade";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Cascade the first element of `html` against `css` (a real end-to-end path). */
function cascadeFirstElement(html: string, css: string) {
  const dom: DomTree = parseHtml(enc(html));
  const sheets = [parseCss(enc(css))];
  let id: NodeId | undefined;
  for (const [nodeId, node] of dom.nodes) {
    if (node.kind === "element") {
      id = nodeId;
      break;
    }
  }
  if (id === undefined) {
    throw new Error("no element node in the parsed document");
  }
  return cascade(dom, sheets, id) as unknown as Record<string, unknown>;
}

void test("Req 3.1/3.2: real cascade surfaces flex-direction under camelCase flexDirection", () => {
  const cs = cascadeFirstElement("<div></div>", "div { display: flex; flex-direction: column }");
  assert.equal(cs["display"], "flex");
  assert.equal(cs["flexDirection"], "column", "flex-direction must surface as flexDirection");
});

void test("Req 3.1/3.2: real cascade surfaces grid-template-columns as gridTemplateColumns", () => {
  const cs = cascadeFirstElement("<div></div>", "div { display: grid; grid-template-columns: 3 }");
  assert.equal(cs["display"], "grid");
  assert.equal(cs["gridTemplateColumns"], "3");
});

void test("Req 3.1/3.2: real cascade surfaces position + insets", () => {
  const cs = cascadeFirstElement("<div></div>", "div { position: absolute; top: 10px; left: 20px }");
  assert.equal(cs["position"], "absolute");
  assert.equal(cs["top"], 10);
  assert.equal(cs["left"], 20);
});

void test("Req 3.1/3.2: real cascade surfaces float", () => {
  const cs = cascadeFirstElement("<div></div>", "div { float: left }");
  assert.equal(cs["float"], "left");
});

void test("Req 3.1/3.2: real cascade surfaces compositing fields (opacity / transform / zIndex)", () => {
  const cs = cascadeFirstElement(
    "<div></div>",
    "div { opacity: 0.5; transform: matrix(2,0,0,2,0,0); z-index: 7 }",
  );
  assert.equal(cs["opacity"], 0.5);
  assert.deepEqual(cs["transform"], [2, 0, 0, 2, 0, 0]);
  assert.equal(cs["zIndex"], 7);
});

void test("Req 3.1: display:table is an accepted keyword through the real pipeline", () => {
  const cs = cascadeFirstElement("<div></div>", "div { display: table }");
  assert.equal(cs["display"], "table");
});

void test("Req 3.3: undeclared new properties fall back to their initial value", () => {
  // A document declaring none of the new properties: each new field is initial.
  const cs = cascadeFirstElement("<div></div>", "div { color: red }");
  assert.equal(cs["position"], "static");
  assert.equal(cs["float"], "none");
  assert.equal(cs["flexDirection"], "row");
  assert.equal(cs["gridTemplateColumns"], "0");
  assert.equal(cs["opacity"], 1);
  assert.equal(cs["transform"], "none");
  assert.equal(cs["zIndex"], 0);
  assert.equal(cs["top"], "auto");
});

void test("Req 3.4: ComputedStyle carries NO geometry field after adding the new properties", () => {
  const cs = cascadeFirstElement("<div></div>", "div { display: flex; opacity: 0.5 }");
  // The geometry field names that must never appear on ComputedStyle.
  for (const geom of ["x", "y", "width", "height", "contentBox", "paddingBox", "borderBox", "marginBox"]) {
    // `width`/`height` ARE legal *style* properties (LengthOrAuto), but they are
    // never geometry boxes; the box-named fields must be wholly absent.
    if (geom === "width" || geom === "height") continue;
    assert.equal(geom in cs, false, `ComputedStyle must not carry geometry field "${geom}"`);
  }
  // The style `width`/`height` remain present as LengthOrAuto (not geometry).
  assert.ok("width" in cs && "height" in cs);
});

void test("Req 3.2: a malformed new-property value falls back to initial (no crash)", () => {
  // A `%` translate needs the box size (unavailable to the cascade) → fails to
  // parse → cascade uses the initial value rather than fabricating a matrix.
  const cs = cascadeFirstElement("<div></div>", "div { transform: translate(50%) }");
  assert.equal(cs["transform"], "none", "unparseable transform falls back to initial none");
});
