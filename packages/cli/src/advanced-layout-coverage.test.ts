/**
 * Differential + reftest coverage for the Phase 5-7 ADVANCED LAYOUT modes
 * (task 7.2; design.md §8.2 note, §9.1/§9.2 Property 2; Requirements 9.2, 10.4,
 * and 16.1 by exercise).
 *
 * Built by `tsc` then run with: `node --test packages/cli/dist/*.test.js`.
 *
 * Task 7.1 added flex / grid / table / float / positioned layout as NEW layout
 * BRANCHES dispatched off `display` / `position` / `float`, WITHOUT changing the
 * FragmentTree IR boundary. This file is the regression coverage the task calls
 * for — "校验新布局模式下增量 == 朴素;reftest 在阈值内通过" — split into two
 * independent guarantees:
 *
 *   - **Differential (Requirement 9.2):** for every advanced layout mode, the
 *     real incremental backend ({@link IncrementalDb}) must produce BYTE-FOR-BYTE
 *     identical layout output to the naive full-recompute backend
 *     ({@link NaiveDb}) over arbitrary input-edit sequences that flip the scene
 *     between modes and resize it. This proves the advanced branches did not
 *     introduce an incremental/early-stop divergence (the welded-seam property
 *     from task 5.11, now extended to cover the new modes).
 *
 *   - **Reftest (Requirement 10.4):** an advanced-layout scene rendered through
 *     the real layout → paint → backend → PNG path must match an independently
 *     constructed reference image within a configured pixel-difference
 *     threshold. The reference is built by filling the rectangles where the box
 *     layout is EXPECTED to place each coloured child (an oracle independent of
 *     the layout engine's own computation), so a mis-placed box would fail the
 *     pixel comparison.
 *
 * ## Why a synthetic ComputedStyle (mirrors `layout/advanced-layout.test.ts`)
 *
 * The cascade generator does not yet emit `position` / `float` /
 * `flex-direction` / `grid-template-columns` / the `table` display keyword, so
 * the real cascade never triggers an advanced branch. Exactly as task 7.1's unit
 * tests do, this coverage drives the branches with a SYNTHETIC, frozen
 * ComputedStyle table that carries those properties on the IR's open
 * `[k: string]: unknown` index signature. The cli is an orchestration layer (not
 * a pipeline stage), so it may import the layout/paint/backend stages and the
 * kernel/test-harness infrastructure directly to compose this coverage.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { deepFreeze, nodeId, px } from "@browser-engine/ir";
import type {
  Color,
  ComputedStyle,
  DomNode,
  DomTree,
  Edges,
  Fragment,
  FragmentTree,
  NodeId,
  Px,
} from "@browser-engine/ir";
import {
  IncrementalDb,
  NaiveDb,
  define,
  defineInput,
  type Db,
  type InputSlot,
  type QueryDef,
} from "@browser-engine/kernel";
import { layout } from "@browser-engine/layout";
import { paint } from "@browser-engine/paint";
import { ScreenshotBackend, createSurface, encodeSurfaceToPng, type Surface } from "@browser-engine/backend";
import {
  assertCampaignClean,
  assertDifferentialIdentical,
  canonicalJsonBytes,
  compareReftest,
  decodePng,
  runDifferential,
  runDifferentialCampaign,
  type DbFactory,
  type InputEdit,
  type RenderProbe,
} from "@browser-engine/test-harness";

// ===========================================================================
// IR builders (frozen DomTree + geometry-free ComputedStyle), local to this
// file — the same shape the layout package's advanced-layout.test.ts uses.
// ===========================================================================

interface NodeSpec {
  readonly id: number;
  readonly kind: DomNode["kind"];
  readonly tag?: string;
  readonly children?: readonly number[];
  readonly parent: number | null;
}

/** Build a frozen DomTree from a flat list of node specs (root id 0). */
function buildDom(specs: readonly NodeSpec[]): DomTree {
  const nodes = new Map<NodeId, DomNode>();
  for (const spec of specs) {
    const base = {
      id: nodeId(spec.id),
      kind: spec.kind,
      children: (spec.children ?? []).map(nodeId),
      parent: spec.parent === null ? null : nodeId(spec.parent),
    };
    const node: DomNode =
      spec.kind === "element"
        ? { ...base, tag: spec.tag ?? "div", attrs: new Map<string, string>() }
        : base;
    nodes.set(node.id, node);
  }
  return deepFreeze({ root: nodeId(0), nodes } as unknown as DomTree);
}

const TRANSPARENT: Color = { r: 0, g: 0, b: 0, a: 0 };
const ZERO_EDGES: Edges<Px> = { top: px(0), right: px(0), bottom: px(0), left: px(0) };

/** Per-node style overrides; advanced props ride the open index signature. */
interface StyleSpec {
  readonly display?: string;
  readonly width?: number | "auto";
  readonly height?: number | "auto";
  readonly backgroundColor?: Color;
  readonly position?: string;
  readonly float?: string;
  readonly top?: number;
  readonly left?: number;
  readonly "flex-direction"?: string;
  readonly "grid-template-columns"?: number;
}

/** Build a frozen, geometry-free ComputedStyle from a partial spec. */
function makeStyle(spec: StyleSpec = {}): ComputedStyle {
  const style: Record<string, unknown> = {
    display: spec.display ?? "inline",
    color: { r: 0, g: 0, b: 0, a: 1 },
    fontSize: px(16),
    margin: ZERO_EDGES,
    width: spec.width ?? "auto",
    height: spec.height ?? "auto",
    backgroundColor: spec.backgroundColor ?? TRANSPARENT,
  };
  if (spec.position !== undefined) style["position"] = spec.position;
  if (spec.float !== undefined) style["float"] = spec.float;
  if (spec.top !== undefined) style["top"] = spec.top;
  if (spec.left !== undefined) style["left"] = spec.left;
  // The layout engine reads the GENERATED camelCase fields (matching the real
  // cascade output), so the synthetic style writes them under those names.
  if (spec["flex-direction"] !== undefined) style["flexDirection"] = spec["flex-direction"];
  if (spec["grid-template-columns"] !== undefined) {
    style["gridTemplateColumns"] = spec["grid-template-columns"];
  }
  return deepFreeze(style as unknown as ComputedStyle);
}

/** Make a `computedStyleOf` callback from a per-node style map (default initial). */
function styleTable(map: ReadonlyMap<number, ComputedStyle>): (node: NodeId) => ComputedStyle {
  const fallback = makeStyle();
  return (node: NodeId) => map.get(Number(node)) ?? fallback;
}

// ===========================================================================
// Scene builders — one frozen FragmentTree per advanced layout mode.
//
// Each mode is a PURE function of a single `width` parameter, so the layout
// output is fully determined by the kernel inputs the differential query reads.
// ===========================================================================

/** The advanced layout modes this coverage exercises (Requirement 16.1). */
const MODES = [
  "flex-row",
  "flex-column",
  "grid",
  "table",
  "float",
  "absolute",
  "relative",
  "block",
] as const;
type Mode = (typeof MODES)[number];

/** Lay out the scene for `mode` at container `width`, returning the FragmentTree. */
function layoutScene(mode: Mode, width: number): FragmentTree {
  switch (mode) {
    case "flex-row": {
      const dom = buildDom([
        { id: 0, kind: "document", parent: null, children: [1] },
        { id: 1, kind: "element", parent: 0, children: [2, 3] },
        { id: 2, kind: "element", parent: 1 },
        { id: 3, kind: "element", parent: 1 },
      ]);
      return layout(
        dom,
        styleTable(
          new Map([
            [1, makeStyle({ display: "flex", width, height: 50 })],
            [2, makeStyle({ display: "block", height: 50 })],
            [3, makeStyle({ display: "block", height: 50 })],
          ]),
        ),
      );
    }
    case "flex-column": {
      const dom = buildDom([
        { id: 0, kind: "document", parent: null, children: [1] },
        { id: 1, kind: "element", parent: 0, children: [2, 3] },
        { id: 2, kind: "element", parent: 1 },
        { id: 3, kind: "element", parent: 1 },
      ]);
      return layout(
        dom,
        styleTable(
          new Map([
            [1, makeStyle({ display: "flex", "flex-direction": "column", width })],
            [2, makeStyle({ display: "block", height: 40 })],
            [3, makeStyle({ display: "block", height: 60 })],
          ]),
        ),
      );
    }
    case "grid": {
      const dom = buildDom([
        { id: 0, kind: "document", parent: null, children: [1] },
        { id: 1, kind: "element", parent: 0, children: [2, 3, 4, 5] },
        { id: 2, kind: "element", parent: 1 },
        { id: 3, kind: "element", parent: 1 },
        { id: 4, kind: "element", parent: 1 },
        { id: 5, kind: "element", parent: 1 },
      ]);
      const cell = makeStyle({ display: "block", height: 25 });
      return layout(
        dom,
        styleTable(
          new Map([
            [1, makeStyle({ display: "grid", width, "grid-template-columns": 2 })],
            [2, cell],
            [3, cell],
            [4, cell],
            [5, cell],
          ]),
        ),
      );
    }
    case "table": {
      const dom = buildDom([
        { id: 0, kind: "document", parent: null, children: [1] },
        { id: 1, kind: "element", tag: "table", parent: 0, children: [2, 3] },
        { id: 2, kind: "element", tag: "tr", parent: 1, children: [4, 5] },
        { id: 3, kind: "element", tag: "tr", parent: 1, children: [6, 7] },
        { id: 4, kind: "element", tag: "td", parent: 2 },
        { id: 5, kind: "element", tag: "td", parent: 2 },
        { id: 6, kind: "element", tag: "td", parent: 3 },
        { id: 7, kind: "element", tag: "td", parent: 3 },
      ]);
      return layout(
        dom,
        styleTable(
          new Map([
            [1, makeStyle({ display: "table", width })],
            [2, makeStyle({ display: "block" })],
            [3, makeStyle({ display: "block" })],
            [4, makeStyle({ display: "block", height: 30 })],
            [5, makeStyle({ display: "block", height: 20 })],
            [6, makeStyle({ display: "block", height: 15 })],
            [7, makeStyle({ display: "block", height: 25 })],
          ]),
        ),
      );
    }
    case "float": {
      const dom = buildDom([
        { id: 0, kind: "document", parent: null, children: [1] },
        { id: 1, kind: "element", parent: 0, children: [2, 3, 4] },
        { id: 2, kind: "element", parent: 1 },
        { id: 3, kind: "element", parent: 1 },
        { id: 4, kind: "element", parent: 1 },
      ]);
      return layout(
        dom,
        styleTable(
          new Map([
            [1, makeStyle({ display: "block", width })],
            [2, makeStyle({ display: "block", float: "left", width: 100, height: 50 })],
            [3, makeStyle({ display: "block", height: 20 })],
            [4, makeStyle({ display: "block", float: "right", width: 80, height: 30 })],
          ]),
        ),
      );
    }
    case "absolute": {
      const dom = buildDom([
        { id: 0, kind: "document", parent: null, children: [1] },
        { id: 1, kind: "element", parent: 0, children: [2, 3] },
        { id: 2, kind: "element", parent: 1 },
        { id: 3, kind: "element", parent: 1 },
      ]);
      return layout(
        dom,
        styleTable(
          new Map([
            [1, makeStyle({ display: "block", width })],
            [2, makeStyle({ display: "block", position: "absolute", top: 10, left: 20, height: 40 })],
            [3, makeStyle({ display: "block", height: 15 })],
          ]),
        ),
      );
    }
    case "relative": {
      const dom = buildDom([
        { id: 0, kind: "document", parent: null, children: [1] },
        { id: 1, kind: "element", parent: 0, children: [2, 3] },
        { id: 2, kind: "element", parent: 1 },
        { id: 3, kind: "element", parent: 1 },
      ]);
      return layout(
        dom,
        styleTable(
          new Map([
            [1, makeStyle({ display: "block", width })],
            [2, makeStyle({ display: "block", position: "relative", top: 5, left: 8, height: 40 })],
            [3, makeStyle({ display: "block", height: 30 })],
          ]),
        ),
      );
    }
    case "block": {
      const dom = buildDom([
        { id: 0, kind: "document", parent: null, children: [1] },
        { id: 1, kind: "element", parent: 0, children: [2, 3] },
        { id: 2, kind: "element", parent: 1 },
        { id: 3, kind: "element", parent: 1 },
      ]);
      return layout(
        dom,
        styleTable(
          new Map([
            [1, makeStyle({ display: "block", width })],
            [2, makeStyle({ display: "block", height: 10 })],
            [3, makeStyle({ display: "block", height: 20 })],
          ]),
        ),
      );
    }
  }
}

// ===========================================================================
// Serialise a FragmentTree to a canonical, comparable plain value so the
// differential probe can render it to bytes (canonicalJsonBytes sorts object
// keys; a Map is converted to an id-sorted array of plain fragments).
// ===========================================================================

function serializeTree(tree: FragmentTree): unknown {
  const fragments = [...tree.fragments.entries()]
    .map(([id, frag]) => ({ id: Number(id), ...serializeFragment(frag) }))
    .sort((a, b) => a.id - b.id);
  return { root: Number(tree.root), fragments };
}

function serializeFragment(frag: Fragment): Record<string, unknown> {
  const { x, y, width, height, contentBox, paddingBox, borderBox, marginBox } = frag.box;
  const rect = (r: { x: Px; y: Px; width: Px; height: Px }) => ({
    x: Number(r.x),
    y: Number(r.y),
    width: Number(r.width),
    height: Number(r.height),
  });
  return {
    node: Number(frag.node),
    children: frag.children.map(Number),
    box: {
      x: Number(x),
      y: Number(y),
      width: Number(width),
      height: Number(height),
      contentBox: rect(contentBox),
      paddingBox: rect(paddingBox),
      borderBox: rect(borderBox),
      marginBox: rect(marginBox),
    },
  };
}

// ===========================================================================
// Part A — Differential (Requirement 9.2): incremental == naive for every mode.
// ===========================================================================

/** Leaf input: the advanced layout mode to lay out for a scene url. */
const ModeInput: InputSlot<string, Mode> = defineInput<string, Mode>("AdvancedLayoutMode");
/** Leaf input: the container width to lay out at. */
const WidthInput: InputSlot<string, number> = defineInput<string, number>("AdvancedLayoutWidth");

/** The layout query under differential test: a pure function of the two inputs. */
const qSceneTree: QueryDef<string, FragmentTree> = define(
  (db: Db, url: string) => layoutScene(db.getInput(ModeInput, url), db.getInput(WidthInput, url)),
  "qSceneTree",
);

/** Probe: lay out the scene and serialise the FragmentTree to canonical bytes. */
const treeProbe: RenderProbe = (db: Db) =>
  canonicalJsonBytes(serializeTree(db.query(qSceneTree, SCENE_URL)));

/** The single scene key both backends operate on. */
const SCENE_URL = "advanced://scene";

const naiveFactory: DbFactory = () => new NaiveDb();
const incrementalFactory: DbFactory = () => new IncrementalDb();

/** Seed both inputs before the query reads them (an unset input fails loudly). */
const initEdits: readonly InputEdit[] = [
  { input: ModeInput, key: SCENE_URL, value: "block" },
  { input: WidthInput, key: SCENE_URL, value: 200 },
];

/** A fast-check arbitrary editing the mode + width across the advanced modes. */
const arbEditSeq: fc.Arbitrary<readonly InputEdit[]> = fc
  .array(
    fc.oneof(
      fc.record({ kind: fc.constant("mode" as const), mode: fc.constantFrom(...MODES) }),
      fc.record({ kind: fc.constant("width" as const), width: fc.integer({ min: 0, max: 400 }) }),
    ),
    { maxLength: 40 },
  )
  .map((raw): readonly InputEdit[] => [
    ...initEdits,
    ...raw.map((edit): InputEdit =>
      edit.kind === "mode"
        ? { input: ModeInput, key: SCENE_URL, value: edit.mode }
        : { input: WidthInput, key: SCENE_URL, value: edit.width },
    ),
  ]);

void test("Req 9.2: advanced layout — incremental is byte-for-byte identical to naive across edit sequences", () => {
  // **Validates: Requirements 9.2**
  fc.assert(
    fc.property(arbEditSeq, (edits) => {
      assertDifferentialIdentical(
        runDifferential(naiveFactory, incrementalFactory, edits, treeProbe),
      );
    }),
    { numRuns: 200 },
  );
});

void test("Req 9.2: advanced layout differential campaign (fast-check-seeded) stays clean", () => {
  // **Validates: Requirements 9.2**
  const sequences = fc.sample(arbEditSeq, 120);
  const result = runDifferentialCampaign(
    naiveFactory,
    incrementalFactory,
    treeProbe,
    (run) => sequences[run] ?? initEdits,
    sequences.length,
  );
  assertCampaignClean(result);
  assert.equal(result.firstFailure, null);
});

void test("Req 9.2: each advanced mode in isolation — incremental equals naive", () => {
  // A per-mode anchor so a regression names the offending mode directly.
  for (const mode of MODES) {
    const edits: readonly InputEdit[] = [
      ...initEdits,
      { input: ModeInput, key: SCENE_URL, value: mode },
      { input: WidthInput, key: SCENE_URL, value: 240 },
    ];
    const outcome = runDifferential(naiveFactory, incrementalFactory, edits, treeProbe);
    assert.equal(outcome.identical, true, `mode "${mode}" diverged: ${outcome.difference?.message ?? ""}`);
  }
});

void test("the incremental backend genuinely caches the advanced-layout query (gate is meaningful)", () => {
  const db = new IncrementalDb();
  db.setInput(ModeInput, SCENE_URL, "flex-row");
  db.setInput(WidthInput, SCENE_URL, 200);

  db.query(qSceneTree, SCENE_URL);
  const afterFirst = db.recomputeCount;
  // A re-query with no edits must be a full cache hit (no recompute).
  db.query(qSceneTree, SCENE_URL);
  assert.equal(db.recomputeCount, afterFirst, "unchanged re-query must hit the cache");

  // An equal write must not bump the revision (Req 2.6), so still cached.
  const rev = db.revision;
  db.setInput(WidthInput, SCENE_URL, 200);
  assert.equal(db.revision, rev, "equal write must not bump the revision");
  db.query(qSceneTree, SCENE_URL);
  assert.equal(db.recomputeCount, afterFirst, "equal write must leave the query cached");
});

// ===========================================================================
// Part B — Reftest (Requirement 10.4): render an advanced-layout scene to a PNG
// and compare against an independently-built reference within a threshold.
// ===========================================================================

const RED: Color = { r: 255, g: 0, b: 0, a: 1 };
const BLUE: Color = { r: 0, g: 0, b: 255, a: 1 };
const GREEN: Color = { r: 0, g: 128, b: 0, a: 1 };
const YELLOW: Color = { r: 255, g: 215, b: 0, a: 1 };

/** Render a scene (frozen DomTree + style table) to PNG bytes at a fixed size. */
function renderSceneToPng(
  dom: DomTree,
  styleOf: (node: NodeId) => ComputedStyle,
  width: number,
  height: number,
): Uint8Array {
  const tree = layout(dom, styleOf, { viewportWidth: px(width) });
  const list = paint(tree, styleOf);
  const surface = createSurface(width, height);
  new ScreenshotBackend().render(list, surface);
  return encodeSurfaceToPng(surface);
}

/** Fill an opaque solid rectangle directly into a surface (reference oracle). */
function fillSolid(surface: Surface, x: number, y: number, w: number, h: number, color: Color): void {
  const x1 = Math.min(surface.width, x + w);
  const y1 = Math.min(surface.height, y + h);
  for (let py = Math.max(0, y); py < y1; py += 1) {
    for (let pxx = Math.max(0, x); pxx < x1; pxx += 1) {
      const i = (py * surface.width + pxx) * 4;
      surface.pixels[i] = color.r;
      surface.pixels[i + 1] = color.g;
      surface.pixels[i + 2] = color.b;
      surface.pixels[i + 3] = 255;
    }
  }
}

/** Encode an independently-built reference surface to PNG bytes. */
function referencePng(width: number, height: number, draw: (s: Surface) => void): Uint8Array {
  const surface = createSurface(width, height);
  draw(surface);
  return encodeSurfaceToPng(surface);
}

void test("Req 10.4: a flex-row scene renders coloured halves matching the reference within threshold", () => {
  // container(200×50) flex row of two auto-width children ⇒ 100px each, side by
  // side: child A red on the left, child B blue on the right.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", parent: 1 },
    { id: 3, kind: "element", parent: 1 },
  ]);
  const styleOf = styleTable(
    new Map([
      [1, makeStyle({ display: "flex", width: 200, height: 50 })],
      [2, makeStyle({ display: "block", height: 50, backgroundColor: RED })],
      [3, makeStyle({ display: "block", height: 50, backgroundColor: BLUE })],
    ]),
  );

  const rendered = renderSceneToPng(dom, styleOf, 200, 50);
  // Reference: the EXPECTED placement (left half red, right half blue), built
  // without consulting the layout engine.
  const reference = referencePng(200, 50, (s) => {
    fillSolid(s, 0, 0, 100, 50, RED);
    fillSolid(s, 100, 0, 100, 50, BLUE);
  });

  const result = compareReftest(rendered, reference, { maxDiffPixels: 0, colorTolerance: 0 });
  assert.equal(result.pass, true, `flex-row diff ${result.diffPixels}/${result.totalPixels} px`);
  assert.equal(result.diffPixels, 0);

  // Sanity: the rendered image is a real PNG of the expected size.
  const decoded = decodePng(rendered);
  assert.equal(decoded.width, 200);
  assert.equal(decoded.height, 50);
});

void test("Req 10.4: a 2×2 grid scene renders four coloured cells matching the reference within threshold", () => {
  // container(200×50) grid, 2 columns, 4 cells (25px tall) ⇒ a 2×2 arrangement
  // of 100×25 cells.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", parent: 0, children: [2, 3, 4, 5] },
    { id: 2, kind: "element", parent: 1 },
    { id: 3, kind: "element", parent: 1 },
    { id: 4, kind: "element", parent: 1 },
    { id: 5, kind: "element", parent: 1 },
  ]);
  const styleOf = styleTable(
    new Map([
      [1, makeStyle({ display: "grid", width: 200, "grid-template-columns": 2 })],
      [2, makeStyle({ display: "block", height: 25, backgroundColor: RED })],
      [3, makeStyle({ display: "block", height: 25, backgroundColor: BLUE })],
      [4, makeStyle({ display: "block", height: 25, backgroundColor: GREEN })],
      [5, makeStyle({ display: "block", height: 25, backgroundColor: YELLOW })],
    ]),
  );

  const rendered = renderSceneToPng(dom, styleOf, 200, 50);
  // Row-major 2×2 cells: (0,0)=red (100,0)=blue (0,25)=green (100,25)=yellow.
  const reference = referencePng(200, 50, (s) => {
    fillSolid(s, 0, 0, 100, 25, RED);
    fillSolid(s, 100, 0, 100, 25, BLUE);
    fillSolid(s, 0, 25, 100, 25, GREEN);
    fillSolid(s, 100, 25, 100, 25, YELLOW);
  });

  const result = compareReftest(rendered, reference, { maxDiffPixels: 0, colorTolerance: 0 });
  assert.equal(result.pass, true, `grid diff ${result.diffPixels}/${result.totalPixels} px`);
  assert.equal(result.diffPixels, 0);
});

void test("Req 10.4: a left-floated box renders at the container's left edge (reftest within threshold)", () => {
  // container(200×60); a 100×50 box floated left sits at (0,0); a following
  // in-flow box (height 20, full content width) starts at y=0 BESIDE the float
  // — but with auto width it fills the container, so it paints across the row.
  // To make the float visually distinguishable we colour only the float and a
  // narrower in-flow box is not used; we assert the float occupies its corner.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", parent: 0, children: [2] },
    { id: 2, kind: "element", parent: 1 },
  ]);
  const styleOf = styleTable(
    new Map([
      [1, makeStyle({ display: "block", width: 200 })],
      [2, makeStyle({ display: "block", float: "left", width: 100, height: 50, backgroundColor: GREEN })],
    ]),
  );

  const rendered = renderSceneToPng(dom, styleOf, 200, 60);
  const reference = referencePng(200, 60, (s) => {
    fillSolid(s, 0, 0, 100, 50, GREEN);
  });

  const result = compareReftest(rendered, reference, { maxDiffPixels: 0, colorTolerance: 0 });
  assert.equal(result.pass, true, `float diff ${result.diffPixels}/${result.totalPixels} px`);
});

void test("Req 10.4: the reftest threshold is genuinely enforced — a mis-placed box fails", () => {
  // Prove the reftest can FAIL: compare the flex-row render against a reference
  // that swaps the colours (red/blue reversed). The pixel difference (the two
  // 100×50 halves) far exceeds a zero threshold, so the comparison must fail —
  // demonstrating the gate is meaningful, not vacuous.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", parent: 1 },
    { id: 3, kind: "element", parent: 1 },
  ]);
  const styleOf = styleTable(
    new Map([
      [1, makeStyle({ display: "flex", width: 200, height: 50 })],
      [2, makeStyle({ display: "block", height: 50, backgroundColor: RED })],
      [3, makeStyle({ display: "block", height: 50, backgroundColor: BLUE })],
    ]),
  );
  const rendered = renderSceneToPng(dom, styleOf, 200, 50);
  const wrongReference = referencePng(200, 50, (s) => {
    fillSolid(s, 0, 0, 100, 50, BLUE); // swapped on purpose.
    fillSolid(s, 100, 0, 100, 50, RED);
  });

  const result = compareReftest(rendered, wrongReference, { maxDiffPixels: 0, colorTolerance: 0 });
  assert.equal(result.pass, false, "a swapped-colour reference must fail the pixel comparison");
  assert.ok(result.diffPixels > 0, "the colour swap must register a non-zero pixel difference");
});

void test("advanced-layout rendering is deterministic (a stable reftest baseline)", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", parent: 0, children: [2, 3] },
    { id: 2, kind: "element", parent: 1 },
    { id: 3, kind: "element", parent: 1 },
  ]);
  const styleOf = styleTable(
    new Map([
      [1, makeStyle({ display: "flex", width: 200, height: 50 })],
      [2, makeStyle({ display: "block", height: 50, backgroundColor: RED })],
      [3, makeStyle({ display: "block", height: 50, backgroundColor: BLUE })],
    ]),
  );
  assert.deepEqual(
    [...renderSceneToPng(dom, styleOf, 200, 50)],
    [...renderSceneToPng(dom, styleOf, 200, 50)],
  );
});
