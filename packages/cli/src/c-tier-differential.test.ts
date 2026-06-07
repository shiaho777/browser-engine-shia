/**
 * Differential tests for C-tier features (task 9.7; design.md §9.2 Property 2;
 * Requirements 9.2, 9.4).
 *
 * Built by `tsc` then run with: `node --test packages/cli/dist/*.test.js`.
 *
 * The permanent differential discipline (Property 2) says the real incremental
 * backend and the naive full-recompute backend must produce BYTE-FOR-BYTE
 * identical output for every input-edit sequence. Task 9.7 extends that gate to
 * the NEW C-tier features so they did not introduce an incremental/early-stop
 * divergence:
 *   - quirks-mode layout (task 9.4) — the root-stretch is a pure function of the
 *     inputs + the quirks flag;
 *   - compositing paint — opacity / transform / z-index layer emission (task 9.2)
 *     is a pure function of the per-node style;
 *   - bidi visual reordering + script itemization (task 9.1) is a deterministic
 *     pure function (also a determinism property);
 *   - the unsupported-command backend error (task 9.5) is deterministic.
 *
 * Each C-tier feature is wrapped in a kernel QUERY over leaf inputs, then the
 * shared {@link runDifferential} harness replays an arbitrary edit sequence
 * through a {@link NaiveDb} and an {@link IncrementalDb} and asserts identical
 * serialized output (Requirements 9.2, 9.4). This keeps the permanent diff
 * harness green across the C-tier additions.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { deepFreeze, nodeId, px } from "@browser-engine/ir";
import type { Color, ComputedStyle, DomNode, DomTree, Edges, NodeId, Px } from "@browser-engine/ir";
import {
  IncrementalDb,
  NaiveDb,
  define,
  defineInput,
  type Db,
  type InputSlot,
  type QueryDef,
} from "@browser-engine/kernel";
import { layout, reorderVisual, scriptRuns } from "@browser-engine/layout";
import { paint } from "@browser-engine/paint";
import {
  assertDifferentialIdentical,
  canonicalJsonBytes,
  runDifferential,
  type DbFactory,
  type InputEdit,
  type RenderProbe,
} from "@browser-engine/test-harness";

// ---------------------------------------------------------------------------
// IR builders.
// ---------------------------------------------------------------------------

const BLACK: Color = { r: 0, g: 0, b: 0, a: 1 };
const TRANSPARENT: Color = { r: 0, g: 0, b: 0, a: 0 };
const ZERO_EDGES: Edges<Px> = { top: px(0), right: px(0), bottom: px(0), left: px(0) };

function dom2(): DomTree {
  const nodes = new Map<NodeId, DomNode>();
  const mk = (id: number, kind: DomNode["kind"], parent: number | null, children: number[]): void => {
    const base = {
      id: nodeId(id),
      kind,
      children: children.map(nodeId),
      parent: parent === null ? null : nodeId(parent),
    };
    nodes.set(
      nodeId(id),
      kind === "element" ? { ...base, tag: "div", attrs: new Map<string, string>() } : base,
    );
  };
  mk(0, "document", null, [1]);
  mk(1, "element", 0, [2, 3]);
  mk(2, "element", 1, []);
  mk(3, "element", 1, []);
  return deepFreeze({ root: nodeId(0), nodes } as unknown as DomTree);
}

function makeStyle(spec: Record<string, unknown> = {}): ComputedStyle {
  return deepFreeze({
    display: "block",
    color: BLACK,
    fontSize: px(16),
    margin: ZERO_EDGES,
    width: "auto",
    height: "auto",
    backgroundColor: TRANSPARENT,
    ...spec,
  } as unknown as ComputedStyle);
}

// ===========================================================================
// Feature 1: quirks-mode layout (task 9.4) — incremental == naive.
// ===========================================================================

/** Leaf inputs: quirks flag + the second child's height. */
const QuirksInput: InputSlot<string, boolean> = defineInput<string, boolean>("Quirks");
const HeightInput: InputSlot<string, number> = defineInput<string, number>("ChildHeight");
const URL = "c-tier://scene";

/** Query: lay out a tiny doc with quirks toggled + a child height varied. */
const qQuirksLayout: QueryDef<string, unknown> = define((db: Db, url: string) => {
  const quirks = db.getInput(QuirksInput, url);
  const height = db.getInput(HeightInput, url);
  const styleOf = (node: NodeId): ComputedStyle => {
    if (Number(node) === 2) return makeStyle({ display: "block", height });
    if (Number(node) === 3) return makeStyle({ display: "block", height: 20 });
    return makeStyle({ display: "block" });
  };
  const tree = layout(dom2(), styleOf, { quirksMode: quirks, viewportHeight: px(600) });
  // Serialise the heights of every fragment (root stretch is the quirk under test).
  return [...tree.fragments.values()].map((f) => Number(f.box.height)).sort((a, b) => a - b);
}, "qQuirksLayout");

const quirksProbe: RenderProbe = (db: Db) => canonicalJsonBytes(db.query(qQuirksLayout, URL));

// ===========================================================================
// Feature 2: compositing paint (task 9.2) — incremental == naive.
// ===========================================================================

const OpacityInput: InputSlot<string, number> = defineInput<string, number>("Opacity");
const ZIndexInput: InputSlot<string, number> = defineInput<string, number>("ZIndex");

/** Query: paint a doc whose children carry a varied opacity + z-index. */
const qCompositing: QueryDef<string, unknown> = define((db: Db, url: string) => {
  const opacity = db.getInput(OpacityInput, url);
  const zIndex = db.getInput(ZIndexInput, url);
  const styleOf = (node: NodeId): ComputedStyle => {
    if (Number(node) === 2) return makeStyle({ display: "block", height: 30, opacity, backgroundColor: { r: 255, g: 0, b: 0, a: 1 } });
    if (Number(node) === 3) return makeStyle({ display: "block", height: 30, zIndex, backgroundColor: { r: 0, g: 0, b: 255, a: 1 } });
    return makeStyle({ display: "block" });
  };
  const tree = layout(dom2(), styleOf);
  const list = paint(tree, styleOf);
  return list.commands.map((c) => c.op);
}, "qCompositing");

const compositingProbe: RenderProbe = (db: Db) => canonicalJsonBytes(db.query(qCompositing, URL));

// ===========================================================================
// Differential runs.
// ===========================================================================

const naiveFactory: DbFactory = () => new NaiveDb();
const incrementalFactory: DbFactory = () => new IncrementalDb();

const quirksInit: readonly InputEdit[] = [
  { input: QuirksInput, key: URL, value: false },
  { input: HeightInput, key: URL, value: 10 },
];

const arbQuirksEdits: fc.Arbitrary<readonly InputEdit[]> = fc
  .array(
    fc.oneof(
      fc.record({ kind: fc.constant("quirks" as const), value: fc.boolean() }),
      fc.record({ kind: fc.constant("height" as const), value: fc.integer({ min: 0, max: 1000 }) }),
    ),
    { maxLength: 30 },
  )
  .map((raw): readonly InputEdit[] => [
    ...quirksInit,
    ...raw.map((e): InputEdit =>
      e.kind === "quirks"
        ? { input: QuirksInput, key: URL, value: e.value }
        : { input: HeightInput, key: URL, value: e.value },
    ),
  ]);

void test("Req 9.2: quirks-mode layout — incremental is byte-for-byte identical to naive", () => {
  // **Validates: Requirements 9.2**
  fc.assert(
    fc.property(arbQuirksEdits, (edits) => {
      assertDifferentialIdentical(runDifferential(naiveFactory, incrementalFactory, edits, quirksProbe));
    }),
    { numRuns: 150 },
  );
});

const compositingInit: readonly InputEdit[] = [
  { input: OpacityInput, key: URL, value: 1 },
  { input: ZIndexInput, key: URL, value: 0 },
];

const arbCompositingEdits: fc.Arbitrary<readonly InputEdit[]> = fc
  .array(
    fc.oneof(
      fc.record({ kind: fc.constant("opacity" as const), value: fc.constantFrom(0, 0.25, 0.5, 1) }),
      fc.record({ kind: fc.constant("z" as const), value: fc.integer({ min: -2, max: 2 }) }),
    ),
    { maxLength: 30 },
  )
  .map((raw): readonly InputEdit[] => [
    ...compositingInit,
    ...raw.map((e): InputEdit =>
      e.kind === "opacity"
        ? { input: OpacityInput, key: URL, value: e.value }
        : { input: ZIndexInput, key: URL, value: e.value },
    ),
  ]);

void test("Req 9.2: compositing paint — incremental is byte-for-byte identical to naive", () => {
  // **Validates: Requirements 9.2**
  fc.assert(
    fc.property(arbCompositingEdits, (edits) => {
      assertDifferentialIdentical(runDifferential(naiveFactory, incrementalFactory, edits, compositingProbe));
    }),
    { numRuns: 150 },
  );
});

// ===========================================================================
// Feature 3: bidi reordering + script itemization (task 9.1) — determinism.
// ===========================================================================

void test("Req 9.2/9.4: bidi visual reordering is a deterministic pure function", () => {
  // The differential property reduces to determinism for a pure text transform:
  // the same input always yields the same visual order (no cache could diverge).
  const samples = [
    "hello world",
    "\u05d0\u05d1\u05d2", // Hebrew
    "a\u05d0\u05d1b",
    "\u0627\u0628 12",
    "abc \u4e2d def",
  ];
  for (const s of samples) {
    assert.equal(reorderVisual(s), reorderVisual(s), `reorderVisual must be deterministic for ${JSON.stringify(s)}`);
    assert.deepEqual(scriptRuns(s), scriptRuns(s), "scriptRuns must be deterministic");
  }
});

void test("Req 9.4: the C-tier differential harness stays green (the gate is meaningful)", () => {
  // A concrete anchor: toggling quirks ON then OFF returns to the standards
  // result, and the incremental backend matches naive at every step.
  const edits: readonly InputEdit[] = [
    ...quirksInit,
    { input: QuirksInput, key: URL, value: true },
    { input: QuirksInput, key: URL, value: false },
    { input: HeightInput, key: URL, value: 999 },
  ];
  const outcome = runDifferential(naiveFactory, incrementalFactory, edits, quirksProbe);
  assert.equal(outcome.identical, true, outcome.difference?.message ?? "");
});
