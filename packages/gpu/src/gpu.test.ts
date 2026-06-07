/**
 * Tests for the GPU pipeline: the software device renders correctly, fragment
 * shaders (solid + gradient) evaluate, and — the headline — the MULTI-CORE
 * parallel device (real `worker_threads`) produces BYTE-FOR-BYTE identical
 * output to the serial device while genuinely fanning out across workers.
 *
 * Built by `tsc` then run with: `node --test packages/gpu/dist/*.test.js`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  renderSerial,
  renderParallel,
  shade,
  type CommandBuffer,
  type GpuColor,
} from "./index.js";

const RED: GpuColor = { r: 255, g: 0, b: 0, a: 1 };
const BLUE: GpuColor = { r: 0, g: 0, b: 255, a: 1 };
const WHITE: GpuColor = { r: 255, g: 255, b: 255, a: 1 };

function pixel(s: { width: number; pixels: Uint8ClampedArray }, x: number, y: number): number[] {
  const i = (y * s.width + x) * 4;
  return [s.pixels[i]!, s.pixels[i + 1]!, s.pixels[i + 2]!, s.pixels[i + 3]!];
}

void test("the software device clears and draws a solid quad", () => {
  const cmd: CommandBuffer = {
    width: 8,
    height: 8,
    commands: [
      { op: "clear", color: WHITE },
      { op: "quad", x: 2, y: 2, w: 4, h: 4, fragment: { kind: "solid", color: RED } },
    ],
  };
  const s = renderSerial(cmd);
  assert.deepEqual(pixel(s, 0, 0), [255, 255, 255, 255], "cleared white outside the quad");
  assert.deepEqual(pixel(s, 3, 3), [255, 0, 0, 255], "red inside the quad");
});

void test("a linear-gradient fragment shader interpolates across the quad", () => {
  const mid = shade({ kind: "linear-gradient", from: RED, to: BLUE, axis: "x" }, 0.5, 0);
  assert.ok(Math.abs(mid.r - 127.5) < 1 && Math.abs(mid.b - 127.5) < 1, "midpoint blends red↔blue");
});

void test("HEADLINE: the multi-core parallel device matches the serial device byte-for-byte", async () => {
  // A non-trivial scene that spans many bands.
  const cmd: CommandBuffer = {
    width: 64,
    height: 64,
    commands: [
      { op: "clear", color: WHITE },
      { op: "quad", x: 0, y: 0, w: 64, h: 64, fragment: { kind: "linear-gradient", from: RED, to: BLUE, axis: "y" } },
      { op: "quad", x: 10, y: 10, w: 30, h: 40, fragment: { kind: "solid", color: { r: 0, g: 200, b: 0, a: 0.5 } } },
    ],
  };
  const serial = renderSerial(cmd);
  const { surface: parallel, workersUsed } = await renderParallel(cmd, 4);

  assert.ok(workersUsed > 1, `genuinely parallel across ${workersUsed} worker threads`);
  assert.deepEqual([...parallel.pixels], [...serial.pixels], "parallel raster == serial raster, exactly");
});

void test("the parallel device degenerates to serial for a 1-worker request", async () => {
  const cmd: CommandBuffer = {
    width: 4,
    height: 4,
    commands: [{ op: "clear", color: BLUE }],
  };
  const { surface, workersUsed } = await renderParallel(cmd, 1);
  assert.equal(workersUsed, 1);
  assert.deepEqual([...surface.pixels], [...renderSerial(cmd).pixels]);
});

import { displayListToCommandBuffer } from "./index.js";
import type { DisplayList } from "@browser-engine/ir";

void test("a paint DisplayList's rects render through the GPU device", async () => {
  const list = {
    commands: [
      { op: "rect", rect: { x: 1, y: 1, width: 6, height: 6 }, fill: RED },
      { op: "rect", rect: { x: 3, y: 3, width: 2, height: 2 }, fill: BLUE },
      // a non-rect op is skipped by the bridge (documented).
      { op: "text", glyphs: [], at: { x: 0, y: 0 }, fill: RED, fontSize: 16 },
    ],
  } as unknown as DisplayList;

  const cmd = displayListToCommandBuffer(list, 8, 8);
  const s = renderSerial(cmd);
  assert.deepEqual(pixel(s, 0, 0), [255, 255, 255, 255], "white clear outside any rect");
  assert.deepEqual(pixel(s, 1, 1), [255, 0, 0, 255], "first rect (red)");
  assert.deepEqual(pixel(s, 3, 3), [0, 0, 255, 255], "second rect (blue) paints over red");

  // The same buffer renders identically on the multi-core device.
  const { surface } = await renderParallel(cmd, 4);
  assert.deepEqual([...surface.pixels], [...s.pixels]);
});
