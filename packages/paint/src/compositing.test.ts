/**
 * Tests for compositing layers — z-index / opacity / transform (task 9.2;
 * design.md §8.6 push-layer/pop-layer; Requirement 17.2 — "THE Paint_Engine
 * SHALL support compositing layers, including z-index, opacity, and transform").
 *
 * Built by `tsc` then run with: `node --test packages/paint/dist/*.test.js`.
 *
 * The paint engine wraps a fragment that establishes a stacking layer (a
 * non-default `opacity` or a `transform`) in a `push-layer` / `pop-layer` pair,
 * and orders sibling paint by `z-index`. These assert:
 *   - an `opacity` < 1 fragment emits push-layer(opacity)/pop-layer around its content;
 *   - a `transform` fragment emits push-layer carrying the affine matrix;
 *   - `z-index` reorders sibling paint (higher z paints later / on top);
 *   - a plain document (no opacity/transform/z-index) emits NO layer commands —
 *     byte-for-byte unchanged from prior phases.
 *
 * As in the task 7.1 / 5.8 tests, the compositing properties ride on
 * ComputedStyle's open index signature (the generator does not emit them yet),
 * so a SYNTHETIC ComputedStyle drives the branch.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { deepFreeze, fragmentId, nodeId, px } from "@browser-engine/ir";
import type {
  Color,
  ComputedStyle,
  Edges,
  Fragment,
  FragmentTree,
  Matrix,
  NodeId,
  PaintCmd,
  Px,
  Rect,
} from "@browser-engine/ir";

import { paint } from "./index.js";

const BLACK: Color = { r: 0, g: 0, b: 0, a: 1 };
const RED: Color = { r: 255, g: 0, b: 0, a: 1 };
const BLUE: Color = { r: 0, g: 0, b: 255, a: 1 };
const TRANSPARENT: Color = { r: 0, g: 0, b: 0, a: 0 };
const ZERO_EDGES: Edges<Px> = { top: px(0), right: px(0), bottom: px(0), left: px(0) };

function box(x: number, y: number, w: number, h: number) {
  const rect: Rect = { x: px(x), y: px(y), width: px(w), height: px(h) };
  return {
    x: px(x),
    y: px(y),
    width: px(w),
    height: px(h),
    contentBox: rect,
    paddingBox: rect,
    borderBox: rect,
    marginBox: rect,
  };
}

interface FragSpec {
  readonly id: number;
  readonly node: number;
  readonly box: ReturnType<typeof box>;
  readonly children?: readonly number[];
}

/** Build a frozen FragmentTree from flat specs (root id 0). */
function buildTree(specs: readonly FragSpec[]): FragmentTree {
  const fragments = new Map<ReturnType<typeof fragmentId>, Fragment>();
  for (const spec of specs) {
    const frag: Fragment = {
      node: nodeId(spec.node),
      box: spec.box,
      children: (spec.children ?? []).map((c) => fragmentId(c)),
    };
    fragments.set(fragmentId(spec.id), frag);
  }
  return deepFreeze({ root: fragmentId(0), fragments } as unknown as FragmentTree);
}

interface StyleSpec {
  readonly backgroundColor?: Color;
  readonly opacity?: number;
  readonly transform?: Matrix;
  readonly zIndex?: number;
}

function makeStyle(spec: StyleSpec = {}): ComputedStyle {
  const style: Record<string, unknown> = {
    display: "block",
    color: BLACK,
    fontSize: px(16),
    margin: ZERO_EDGES,
    width: "auto",
    height: "auto",
    backgroundColor: spec.backgroundColor ?? TRANSPARENT,
  };
  if (spec.opacity !== undefined) style["opacity"] = spec.opacity;
  if (spec.transform !== undefined) style["transform"] = spec.transform;
  if (spec.zIndex !== undefined) style["zIndex"] = spec.zIndex;
  return deepFreeze(style as unknown as ComputedStyle);
}

function styleTable(map: ReadonlyMap<number, ComputedStyle>): (node: NodeId) => ComputedStyle {
  const fallback = makeStyle();
  return (node: NodeId) => map.get(Number(node)) ?? fallback;
}

/** The ops of a command list, in order. */
function ops(commands: readonly PaintCmd[]): string[] {
  return commands.map((c) => c.op);
}

// ===========================================================================
// opacity
// ===========================================================================

void test("Req 17.2: a fragment with opacity < 1 is wrapped in push-layer/pop-layer", () => {
  const tree = buildTree([
    { id: 0, node: 0, box: box(0, 0, 100, 100), children: [1] },
    { id: 1, node: 1, box: box(0, 0, 50, 50) },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ opacity: 0.5, backgroundColor: RED })],
    ]),
  );
  const list = paint(tree, styles);
  // The opacity:0.5 fragment (node 1) is wrapped: push-layer, its rect, pop-layer.
  const pushIndex = list.commands.findIndex((c) => c.op === "push-layer");
  const popIndex = list.commands.findIndex((c) => c.op === "pop-layer");
  assert.ok(pushIndex !== -1 && popIndex !== -1, "a layer must be pushed and popped");
  assert.ok(pushIndex < popIndex, "push precedes pop");
  const push = list.commands[pushIndex]!;
  assert.equal(push.op === "push-layer" && push.opacity, 0.5, "layer carries the opacity");
});

void test("Req 17.2: an opaque (opacity 1) fragment emits NO layer", () => {
  const tree = buildTree([
    { id: 0, node: 0, box: box(0, 0, 100, 100), children: [1] },
    { id: 1, node: 1, box: box(0, 0, 50, 50) },
  ]);
  const styles = styleTable(new Map([[1, makeStyle({ opacity: 1, backgroundColor: RED })]]));
  const list = paint(tree, styles);
  assert.equal(list.commands.some((c) => c.op === "push-layer"), false);
});

// ===========================================================================
// transform
// ===========================================================================

void test("Req 17.2: a fragment with a transform emits push-layer carrying the matrix", () => {
  const scale2: Matrix = [2, 0, 0, 2, 0, 0];
  const tree = buildTree([
    { id: 0, node: 0, box: box(0, 0, 100, 100), children: [1] },
    { id: 1, node: 1, box: box(0, 0, 50, 50) },
  ]);
  const styles = styleTable(new Map([[1, makeStyle({ transform: scale2, backgroundColor: RED })]]));
  const list = paint(tree, styles);
  const push = list.commands.find((c) => c.op === "push-layer");
  assert.ok(push !== undefined && push.op === "push-layer");
  // Paint bakes the transform-origin (border-box centre = (25,25) for the 50×50
  // child) into the matrix so the backend applies it about device origin:
  // T(c)·scale(2)·T(−c) ⇒ e=f=−25. The scale part is unchanged.
  assert.deepEqual([...push.transform], [2, 0, 0, 2, -25, -25], "layer carries the origin-baked transform");
  assert.equal(push.opacity, 1, "a transform-only layer keeps full opacity");
});

void test("Req 17.2: an identity transform establishes NO layer", () => {
  const identity: Matrix = [1, 0, 0, 1, 0, 0];
  const tree = buildTree([
    { id: 0, node: 0, box: box(0, 0, 100, 100), children: [1] },
    { id: 1, node: 1, box: box(0, 0, 50, 50) },
  ]);
  const styles = styleTable(new Map([[1, makeStyle({ transform: identity, backgroundColor: RED })]]));
  const list = paint(tree, styles);
  assert.equal(list.commands.some((c) => c.op === "push-layer"), false);
});

// ===========================================================================
// z-index
// ===========================================================================

void test("Req 17.2: z-index reorders sibling paint (higher z paints later / on top)", () => {
  // Two siblings: child A (node 1, z=2, red) declared first; child B (node 2,
  // z=1, blue) declared second. Paint order must put B (lower z) BEFORE A.
  const tree = buildTree([
    { id: 0, node: 0, box: box(0, 0, 100, 100), children: [1, 2] },
    { id: 1, node: 1, box: box(0, 0, 50, 50) },
    { id: 2, node: 2, box: box(0, 0, 50, 50) },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ zIndex: 2, backgroundColor: RED })],
      [2, makeStyle({ zIndex: 1, backgroundColor: BLUE })],
    ]),
  );
  const list = paint(tree, styles);
  const rects = list.commands.filter((c) => c.op === "rect");
  // The first painted rect is the LOWER z-index (blue, node 2); red paints after.
  assert.equal(rects.length, 2);
  assert.ok(rects[0]!.op === "rect" && rects[0]!.fill.b === 255, "lower z (blue) paints first");
  assert.ok(rects[1]!.op === "rect" && rects[1]!.fill.r === 255, "higher z (red) paints last/on top");
});

void test("Req 17.2: equal z-index preserves document order (stable)", () => {
  const tree = buildTree([
    { id: 0, node: 0, box: box(0, 0, 100, 100), children: [1, 2] },
    { id: 1, node: 1, box: box(0, 0, 50, 50) },
    { id: 2, node: 2, box: box(0, 0, 50, 50) },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ zIndex: 0, backgroundColor: RED })],
      [2, makeStyle({ zIndex: 0, backgroundColor: BLUE })],
    ]),
  );
  const list = paint(tree, styles);
  const rects = list.commands.filter((c) => c.op === "rect");
  assert.ok(rects[0]!.op === "rect" && rects[0]!.fill.r === 255, "document order preserved for equal z");
  assert.ok(rects[1]!.op === "rect" && rects[1]!.fill.b === 255);
});

// ===========================================================================
// No regression: a plain document emits no layer commands.
// ===========================================================================

void test("a plain document (no opacity/transform/z-index) emits NO layer commands", () => {
  const tree = buildTree([
    { id: 0, node: 0, box: box(0, 0, 100, 100), children: [1, 2] },
    { id: 1, node: 1, box: box(0, 0, 50, 50) },
    { id: 2, node: 2, box: box(0, 50, 50, 50) },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ backgroundColor: RED })],
      [2, makeStyle({ backgroundColor: BLUE })],
    ]),
  );
  const list = paint(tree, styles);
  assert.equal(list.commands.some((c) => c.op === "push-layer" || c.op === "pop-layer"), false);
  // Command stream is just the document-order rects + leaf text commands.
  assert.ok(!ops(list.commands).includes("push-layer"));
});

void test("nested layers: a transformed parent with an opaque child nests push/pop correctly", () => {
  const scale2: Matrix = [2, 0, 0, 2, 0, 0];
  const tree = buildTree([
    { id: 0, node: 0, box: box(0, 0, 100, 100), children: [1] },
    { id: 1, node: 1, box: box(0, 0, 80, 80), children: [2] },
    { id: 2, node: 2, box: box(0, 0, 40, 40) },
  ]);
  const styles = styleTable(
    new Map([
      [1, makeStyle({ transform: scale2, backgroundColor: RED })],
      [2, makeStyle({ opacity: 0.25, backgroundColor: BLUE })],
    ]),
  );
  const list = paint(tree, styles);
  const layerOps = ops(list.commands).filter((o) => o === "push-layer" || o === "pop-layer");
  // Two layers, properly nested: push (node1), push (node2), pop (node2), pop (node1).
  assert.deepEqual(layerOps, ["push-layer", "push-layer", "pop-layer", "pop-layer"]);
});
