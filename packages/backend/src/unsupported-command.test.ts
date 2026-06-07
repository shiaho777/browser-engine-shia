/**
 * Tests for explicit backend errors on unsupported paint commands (task 9.5;
 * design.md §12 "后端缺失命令"; Requirement 13.3).
 *
 * Built by `tsc` then run with: `node --test packages/backend/dist/*.test.js`.
 *
 * Requirement 13.3: "IF a Paint_Backend receives a PaintCmd it does not support,
 * THEN THE Paint_Backend SHALL raise an explicit error that identifies the
 * command." These assert:
 *   - a backend configured WITHOUT a given op raises {@link
 *     UnsupportedPaintCommandError} carrying that op (the command is identified);
 *   - a strict-transform backend errors on a non-identity layer transform it
 *     cannot faithfully render, rather than silently dropping it;
 *   - the default backend still renders every standard op without error (the
 *     error path is opt-in / capability-scoped, not a regression).
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { Color, DisplayList, Matrix, PaintCmd, Rect } from "@browser-engine/ir";
import { px } from "@browser-engine/ir";

import { ScreenshotBackend, UnsupportedPaintCommandError } from "./screenshot.js";
import { createSurface } from "./surface.js";

/** Build a frozen DisplayList from a plain command array. */
function displayList(commands: readonly PaintCmd[]): DisplayList {
  return Object.freeze({ commands: Object.freeze([...commands]) }) as unknown as DisplayList;
}

function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height } as unknown as Rect;
}

const RED: Color = { r: 255, g: 0, b: 0, a: 1 };
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

void test("Req 13.3: a backend without 'push-layer' support raises an error identifying the command", () => {
  // A backend that cannot composite (no push-layer/pop-layer).
  const backend = new ScreenshotBackend({
    supportedOps: new Set(["rect", "border", "text", "image", "push-clip", "pop-clip"]),
  });
  const surface = createSurface(10, 10);
  const list = displayList([
    { op: "rect", rect: rect(0, 0, 10, 10), fill: RED },
    { op: "push-layer", opacity: 0.5, transform: IDENTITY },
    { op: "pop-layer" },
  ]);
  try {
    backend.render(list, surface);
    assert.fail("expected an UnsupportedPaintCommandError");
  } catch (error: unknown) {
    assert.ok(error instanceof UnsupportedPaintCommandError);
    assert.equal(error.op, "push-layer", "the error must identify the unsupported command");
    assert.match(error.message, /push-layer/);
  }
});

void test("Req 13.3: the error identifies whichever specific op is unsupported", () => {
  // A minimal backend that only fills rects (no images).
  const backend = new ScreenshotBackend({ supportedOps: new Set(["rect"]) });
  const surface = createSurface(4, 4);
  const list = displayList([
    {
      op: "image",
      rect: rect(0, 0, 4, 4),
      src: { width: 1, height: 1, pixels: new Uint8ClampedArray([0, 0, 0, 255]) },
    },
  ]);
  assert.throws(
    () => backend.render(list, surface),
    (error: unknown) =>
      error instanceof UnsupportedPaintCommandError && error.op === "image",
  );
});

void test("Req 13.3: strict-transform backend errors on a non-identity layer transform", () => {
  const backend = new ScreenshotBackend({ strictTransforms: true });
  const surface = createSurface(8, 8);
  // A scale(2) transform the software rasterizer cannot faithfully apply.
  const scale2: Matrix = [2, 0, 0, 2, 0, 0];
  const list = displayList([{ op: "push-layer", opacity: 1, transform: scale2 }]);
  try {
    backend.render(list, surface);
    assert.fail("expected an error on a non-identity transform in strict mode");
  } catch (error: unknown) {
    assert.ok(error instanceof UnsupportedPaintCommandError);
    assert.equal(error.op, "push-layer");
    assert.match(error.message, /transform/);
    assert.ok(error.detail !== undefined, "the error carries a specific detail");
  }
});

void test("strict-transform backend still accepts an identity-transform layer", () => {
  const backend = new ScreenshotBackend({ strictTransforms: true });
  const surface = createSurface(8, 8);
  const list = displayList([
    { op: "push-layer", opacity: 0.5, transform: IDENTITY },
    { op: "rect", rect: rect(0, 0, 8, 8), fill: RED },
    { op: "pop-layer" },
  ]);
  assert.doesNotThrow(() => backend.render(list, surface));
});

void test("the DEFAULT backend supports every standard op (no regression)", () => {
  const backend = new ScreenshotBackend();
  const surface = createSurface(8, 8);
  const list = displayList([
    { op: "push-clip", rect: rect(0, 0, 8, 8) },
    { op: "rect", rect: rect(0, 0, 8, 8), fill: RED },
    {
      op: "border",
      rect: rect(0, 0, 8, 8),
      edges: {
        top: { width: px(1), style: "solid", color: RED },
        right: { width: px(1), style: "solid", color: RED },
        bottom: { width: px(1), style: "solid", color: RED },
        left: { width: px(1), style: "solid", color: RED },
      },
    },
    { op: "text", glyphs: [], at: { x: px(0), y: px(0) }, fill: RED, fontSize: px(16) },
    { op: "push-layer", opacity: 1, transform: IDENTITY },
    { op: "pop-layer" },
    { op: "pop-clip" },
  ]);
  assert.doesNotThrow(() => backend.render(list, surface));
});

void test("UnsupportedPaintCommandError carries op and detail fields", () => {
  const withDetail = new UnsupportedPaintCommandError("push-layer", "non-identity transform");
  assert.equal(withDetail.name, "UnsupportedPaintCommandError");
  assert.equal(withDetail.op, "push-layer");
  assert.equal(withDetail.detail, "non-identity transform");

  const withoutDetail = new UnsupportedPaintCommandError("image");
  assert.equal(withoutDetail.op, "image");
  assert.equal(withoutDetail.detail, undefined);
  assert.match(withoutDetail.message, /image/);
});
