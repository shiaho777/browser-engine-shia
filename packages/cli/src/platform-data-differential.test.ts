/**
 * Differential gate for the newly-connected layout/compositing properties
 * (platform-as-data-layout spec, task 8.1; Requirements 8.1, 8.2).
 *
 * Built by `tsc` then run with: `node --test packages/cli/dist/*.test.js`.
 *
 * Connecting these properties must not introduce an incremental/stale-cache
 * divergence. This wraps the REAL pipeline (parse → cascade → layout → paint)
 * in a kernel query over a single CSS-source leaf input, then replays arbitrary
 * edit sequences that vary the new properties through BOTH the naive
 * full-recompute backend and the real incremental backend, asserting their
 * serialized output is byte-for-byte identical. Any divergence throws and blocks
 * the merge (Requirements 8.1, 8.2) — the permanent welded-seam discipline,
 * extended to the new properties.
 *
 * The cli is an orchestration layer, so it composes every stage + the kernel +
 * the differential harness.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import type { NodeId } from "@browser-engine/ir";
import {
  IncrementalDb,
  NaiveDb,
  define,
  defineInput,
  type Db,
  type InputSlot,
  type QueryDef,
} from "@browser-engine/kernel";
import { parseHtml } from "@browser-engine/html-parser";
import { parseCss } from "@browser-engine/css-parser";
import { cascade } from "@browser-engine/cascade";
import { layout } from "@browser-engine/layout";
import { paint } from "@browser-engine/paint";
import {
  assertDifferentialIdentical,
  canonicalJsonBytes,
  runDifferential,
  runDifferentialCampaign,
  assertCampaignClean,
  type DbFactory,
  type InputEdit,
  type RenderProbe,
} from "@browser-engine/test-harness";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** The leaf input: the document's `<style>` CSS text for a scene key. */
const CssInput: InputSlot<string, string> = defineInput<string, string>("PadlCss");
const SCENE = "padl://scene";

/** A fixed document the varied CSS is applied to (flex container + 3 children). */
const HTML = '<div class="box"><span class="i"></span><span class="i"></span><span class="i"></span></div>';

/**
 * The pipeline query under differential test: parse the fixed HTML, parse the
 * (varied) CSS leaf input, cascade + layout + paint, and serialize a digest of
 * the FragmentTree geometry + DisplayList ops. A pure function of the CSS input,
 * so it is a sound memoized query.
 */
const qRender: QueryDef<string, unknown> = define((db: Db, scene: string) => {
  const css = db.getInput(CssInput, scene);
  const dom = parseHtml(enc(HTML));
  const sheets = [parseCss(enc(css))];
  const styleOf = (node: NodeId) => cascade(dom, sheets, node);
  const tree = layout(dom, styleOf);
  const list = paint(tree, styleOf);
  const geometry = [...tree.fragments.values()]
    .map((f) => ({
      node: Number(f.node),
      x: Number(f.box.borderBox.x),
      y: Number(f.box.borderBox.y),
      w: Number(f.box.borderBox.width),
      h: Number(f.box.borderBox.height),
    }))
    .sort((a, b) => a.node - b.node);
  return { geometry, ops: list.commands.map((c) => c.op) };
}, "qRenderPadl");

const probe: RenderProbe = (db: Db) => canonicalJsonBytes(db.query(qRender, SCENE));

const naiveFactory: DbFactory = () => new NaiveDb();
const incrementalFactory: DbFactory = () => new IncrementalDb();

/** A set of CSS snippets exercising the new layout/compositing properties. */
const CSS_VARIANTS: readonly string[] = [
  ".box { width: 300px } .i { height: 30px }", // default block
  ".box { display: flex; width: 300px } .i { height: 30px }", // flex row
  ".box { display: flex; flex-direction: column; width: 300px } .i { height: 30px }",
  ".box { display: grid; grid-template-columns: 2; width: 300px } .i { height: 30px }",
  ".box { display: grid; grid-template-columns: 3; width: 300px } .i { height: 30px }",
  ".box { width: 300px } .i { float: left; width: 80px; height: 30px }",
  ".box { width: 300px } .i { position: absolute; top: 10px; left: 5px; height: 30px }",
  ".box { width: 300px } .i { position: relative; top: 4px; left: 6px; height: 30px }",
  ".box { width: 300px } .i { height: 30px; opacity: 0.5 }",
  ".box { width: 300px } .i { height: 30px; transform: matrix(2,0,0,2,0,0) }",
  ".box { width: 300px } .i { height: 30px; z-index: 2 }",
  ".box { display: table; width: 300px } .i { height: 30px }",
];

const initEdit: readonly InputEdit[] = [{ input: CssInput, key: SCENE, value: CSS_VARIANTS[0]! }];

/** Arbitrary edit sequences flipping the CSS among the variants. */
const arbEdits: fc.Arbitrary<readonly InputEdit[]> = fc
  .array(fc.constantFrom(...CSS_VARIANTS), { maxLength: 30 })
  .map((seq): readonly InputEdit[] => [
    ...initEdit,
    ...seq.map((css): InputEdit => ({ input: CssInput, key: SCENE, value: css })),
  ]);

void test("Req 8.1: incremental == naive for arbitrary edit sequences over the new properties", () => {
  // **Validates: Requirements 8.1, 8.2**
  fc.assert(
    fc.property(arbEdits, (edits) => {
      assertDifferentialIdentical(runDifferential(naiveFactory, incrementalFactory, edits, probe));
    }),
    { numRuns: 150 },
  );
});

void test("Req 8.1: a fast-check-seeded differential campaign over the new properties stays clean", () => {
  // **Validates: Requirements 8.1, 8.2**
  const sequences = fc.sample(arbEdits, 100);
  const result = runDifferentialCampaign(
    naiveFactory,
    incrementalFactory,
    probe,
    (run) => sequences[run] ?? initEdit,
    sequences.length,
  );
  assertCampaignClean(result);
  assert.equal(result.firstFailure, null);
});

void test("Req 8.1: each new-property variant in isolation — incremental equals naive", () => {
  for (const css of CSS_VARIANTS) {
    const edits: readonly InputEdit[] = [...initEdit, { input: CssInput, key: SCENE, value: css }];
    const outcome = runDifferential(naiveFactory, incrementalFactory, edits, probe);
    assert.equal(outcome.identical, true, `variant diverged: ${css} — ${outcome.difference?.message ?? ""}`);
  }
});

void test("the incremental backend genuinely caches the render query (gate is meaningful)", () => {
  const db = new IncrementalDb();
  db.setInput(CssInput, SCENE, CSS_VARIANTS[1]!);
  db.query(qRender, SCENE);
  const afterFirst = db.recomputeCount;
  db.query(qRender, SCENE);
  assert.equal(db.recomputeCount, afterFirst, "unchanged re-query must hit the cache");
});
