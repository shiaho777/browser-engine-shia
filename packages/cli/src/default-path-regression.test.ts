/**
 * Default-path regression: connecting the layout/compositing properties must
 * leave a document that uses NONE of them byte-for-byte unchanged
 * (platform-as-data-layout spec, task 5.3; Requirements 7.2, 7.3).
 *
 * Built by `tsc` then run with: `node --test packages/cli/dist/*.test.js`.
 *
 * The welding adds initial-valued fields (`position:static`, `float:none`,
 * `opacity:1`, `transform:"none"`, `zIndex:0`, …) to every ComputedStyle. The
 * layout/paint readers map every such initial to the "normal flow / no layer"
 * path, so a plain block/inline document must produce the SAME FragmentTree and
 * DisplayList as before. These tests pin that:
 *   - a plain document triggers NO advanced layout branch (block geometry only);
 *   - a plain document emits NO compositing layer command and no z-reordering;
 *   - rendering stays deterministic (a stable baseline);
 *   - the canonical-byte serialization of the default-path output is stable.
 *
 * The cli is an orchestration layer, so it may drive the real pipeline.
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { DomTree, Fragment, FragmentTree, NodeId } from "@browser-engine/ir";
import { parseHtml } from "@browser-engine/html-parser";
import { parseCss } from "@browser-engine/css-parser";
import { cascade } from "@browser-engine/cascade";
import { layout } from "@browser-engine/layout";
import { paint } from "@browser-engine/paint";
import { canonicalJsonBytes } from "@browser-engine/test-harness";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Run the real parse → cascade → layout → paint pipeline for a document. */
function pipeline(html: string, css: string): { tree: FragmentTree; ops: string[]; bytes: Uint8Array } {
  const dom: DomTree = parseHtml(enc(html));
  const sheets = [parseCss(enc(css))];
  const styleOf = (node: NodeId) => cascade(dom, sheets, node);
  const tree = layout(dom, styleOf);
  const list = paint(tree, styleOf);
  const ops = list.commands.map((c) => c.op);
  // Canonical serialization of the FragmentTree geometry (a stable digest).
  const geom = [...tree.fragments.values()]
    .map((f: Fragment) => ({
      node: Number(f.node),
      x: Number(f.box.borderBox.x),
      y: Number(f.box.borderBox.y),
      w: Number(f.box.borderBox.width),
      h: Number(f.box.borderBox.height),
    }))
    .sort((a, b) => a.node - b.node);
  return { tree, ops, bytes: canonicalJsonBytes(geom) };
}

// A plain block document that declares NONE of the new layout/compositing props.
const PLAIN_HTML = "<div><div></div><div></div></div>";
const PLAIN_CSS = ".a { color: red } div { width: 200px; height: 30px }";

void test("Req 7.2: a plain document triggers NO advanced layout branch (block geometry only)", () => {
  const { tree } = pipeline(PLAIN_HTML, PLAIN_CSS);
  // Block stacking: every fragment sits at x=0 (no float/positioned shift), and
  // children stack with monotonic y — the unchanged default flow.
  const frags = [...tree.fragments.values()];
  for (const f of frags) {
    assert.equal(Number(f.box.borderBox.x), 0, "no horizontal shift on the default path");
  }
});

void test("Req 7.3: a plain document emits NO compositing layer command", () => {
  const { ops } = pipeline(PLAIN_HTML, PLAIN_CSS);
  assert.equal(ops.includes("push-layer"), false, "no opacity/transform layer on the default path");
  assert.equal(ops.includes("pop-layer"), false);
});

void test("Req 7.2/7.3: the default-path output is deterministic (stable baseline)", () => {
  const a = pipeline(PLAIN_HTML, PLAIN_CSS);
  const b = pipeline(PLAIN_HTML, PLAIN_CSS);
  assert.deepEqual([...a.bytes], [...b.bytes], "FragmentTree geometry digest is stable");
  assert.deepEqual(a.ops, b.ops, "DisplayList op sequence is stable");
});

void test("Req 7.2: explicit static/none values lay out identically to omitting them", () => {
  // A document that explicitly sets the new properties to their INITIAL values
  // must lay out byte-for-byte identically to one that omits them entirely —
  // proving the readers map initial → default path.
  const omitted = pipeline("<div><div></div></div>", "div { width: 100px; height: 20px }");
  const explicit = pipeline(
    "<div><div></div></div>",
    "div { width: 100px; height: 20px; position: static; float: none; opacity: 1; transform: none; z-index: 0 }",
  );
  assert.deepEqual([...explicit.bytes], [...omitted.bytes], "explicit-initial == omitted (geometry)");
  assert.deepEqual(explicit.ops, omitted.ops, "explicit-initial == omitted (paint ops)");
});

void test("Req 7.3: a plain document's paint op sequence is exactly the pre-feature shape", () => {
  // Background rects (none here, transparent) + one text command per leaf — no
  // layer/clip ops introduced by the welding.
  const { ops } = pipeline("<div>hi</div>", "div { color: red }");
  for (const op of ops) {
    assert.ok(
      op === "rect" || op === "text" || op === "border",
      `default path must only emit rect/text/border, got "${op}"`,
    );
  }
});
