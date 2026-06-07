/**
 * Differential test: the GPU compositor ({@link renderDisplayListOnGpu}) renders
 * the WHOLE paint DisplayList — rects, borders, text (coverage), clips, and
 * opacity layers — and its output matches the CPU {@link ScreenshotBackend}
 * reference oracle pixel-for-pixel (within a tiny tolerance for independent
 * rounding). This is how "everything goes through GPU" stays honest: the CPU
 * path is the correctness oracle, the GPU path is the renderer.
 *
 * Built by `tsc` then run with: `node --test packages/backend/dist/*.test.js`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { Color, DisplayList, PaintCmd, Rect } from "@browser-engine/ir";
import { px } from "@browser-engine/ir";

import { ScreenshotBackend } from "./screenshot.js";
import { createSurface, type Surface } from "./surface.js";
import { renderDisplayListOnGpu } from "./gpu-render.js";

function displayList(commands: readonly PaintCmd[]): DisplayList {
  return Object.freeze({ commands: Object.freeze([...commands]) }) as unknown as DisplayList;
}
function rect(x: number, y: number, w: number, h: number): Rect {
  return { x: px(x), y: px(y), width: px(w), height: px(h) };
}
const RED: Color = { r: 255, g: 0, b: 0, a: 1 };
const BLUE: Color = { r: 0, g: 0, b: 255, a: 1 };
const BLACK: Color = { r: 0, g: 0, b: 0, a: 1 };

/** Count pixels differing by more than `tol` per channel between two surfaces. */
function diffCount(a: Surface, gpu: { pixels: Uint8ClampedArray }, tol: number): number {
  let diff = 0;
  for (let i = 0; i < a.pixels.length; i += 4) {
    for (let k = 0; k < 3; k += 1) {
      if (Math.abs((a.pixels[i + k] as number) - (gpu.pixels[i + k] as number)) > tol) {
        diff += 1;
        break;
      }
    }
  }
  return diff;
}

function cpu(list: DisplayList, w: number, h: number): Surface {
  const s = createSurface(w, h);
  new ScreenshotBackend().render(list, s);
  return s;
}

void test("GPU renders rects + borders identically to the CPU reference", () => {
  const list = displayList([
    { op: "rect", rect: rect(2, 2, 30, 20), fill: RED },
    {
      op: "border",
      rect: rect(2, 2, 30, 20),
      edges: {
        top: { width: px(2), style: "solid", color: BLACK },
        right: { width: px(2), style: "solid", color: BLACK },
        bottom: { width: px(2), style: "solid", color: BLACK },
        left: { width: px(2), style: "solid", color: BLACK },
      },
    },
  ]);
  const w = 40;
  const h = 30;
  const ref = cpu(list, w, h);
  const gpu = renderDisplayListOnGpu(list, w, h);
  assert.equal(diffCount(ref, gpu, 0), 0, "rects + borders are byte-identical");
});

void test("GPU renders text (coverage) within tolerance of the CPU reference", () => {
  const list = displayList([
    {
      op: "text",
      glyphs: [
        { glyphId: 0x48, advance: px(10), offset: { x: px(0), y: px(0) } },
        { glyphId: 0x69, advance: px(10), offset: { x: px(12), y: px(0) } },
      ],
      at: { x: px(2), y: px(2) },
      fill: BLACK,
      fontSize: px(24),
    },
  ]);
  const w = 40;
  const h = 32;
  const ref = cpu(list, w, h);
  const gpu = renderDisplayListOnGpu(list, w, h);
  // Coverage sampling is identical (nearest at cell centres), so expect exact.
  assert.equal(diffCount(ref, gpu, 0), 0, "GPU text matches the CPU glyph raster");
});

void test("GPU composites an opacity layer + clip identically to the CPU reference", () => {
  const list = displayList([
    { op: "rect", rect: rect(0, 0, 30, 30), fill: BLUE },
    { op: "push-clip", rect: rect(5, 5, 20, 20) },
    { op: "push-layer", opacity: 0.5, transform: [1, 0, 0, 1, 0, 0] },
    { op: "rect", rect: rect(0, 0, 30, 30), fill: RED },
    { op: "pop-layer" },
    { op: "pop-clip" },
  ]);
  const w = 30;
  const h = 30;
  const ref = cpu(list, w, h);
  const gpu = renderDisplayListOnGpu(list, w, h);
  // Independent compositing math may differ by ±1 in a handful of blended pixels.
  assert.ok(diffCount(ref, gpu, 1) === 0, "opacity layer + clip matches within ±1");
});
