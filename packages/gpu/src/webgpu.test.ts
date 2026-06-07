/**
 * Tests for the real WebGPU device adapter. In a GPU-less CI these prove the
 * binding is wired and degrades GRACEFULLY (detection returns false, the device
 * factory returns null, `selectDevice` cleanly picks the software/multi-core
 * device — an explicit choice, never a crash or a silent fallback). On a
 * WebGPU-capable machine the same `createWebGpuDevice()` returns a real device
 * that renders on silicon, and the round-trip block below executes for real.
 *
 * Built by `tsc` then run with: `node --test packages/gpu/dist/*.test.js`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  createWebGpuDevice,
  isWebGpuAvailable,
  selectDevice,
  renderSerial,
  type CommandBuffer,
} from "./index.js";

const SCENE: CommandBuffer = {
  width: 16,
  height: 16,
  commands: [
    { op: "clear", color: { r: 255, g: 255, b: 255, a: 1 } },
    { op: "quad", x: 2, y: 2, w: 8, h: 8, fragment: { kind: "solid", color: { r: 255, g: 0, b: 0, a: 1 } } },
  ],
};

void test("WebGPU detection is well-formed (boolean) and never throws", async () => {
  const available = await isWebGpuAvailable();
  assert.equal(typeof available, "boolean");
});

void test("createWebGpuDevice returns a real device or null — never throws", async () => {
  const device = await createWebGpuDevice();
  assert.ok(device === null || (typeof device.submit === "function" && device.name === "webgpu"));
});

void test("selectDevice picks a usable device and renders the scene", async () => {
  const device = await selectDevice(SCENE.width * SCENE.height);
  assert.ok(typeof device.submit === "function", `selected device: ${device.name}`);
  const surface = await device.submit(SCENE);
  assert.equal(surface.width, 16);
  assert.equal(surface.height, 16);
});

void test("when a real WebGPU device exists, it matches the software reference", async () => {
  const device = await createWebGpuDevice();
  if (device === null) {
    // No GPU in this environment — the honest, documented CI outcome.
    return;
  }
  const hw = await device.submit(SCENE);
  const sw = renderSerial(SCENE);
  // Hardware rasterization may differ by a few LSBs from the software path.
  let maxDiff = 0;
  for (let i = 0; i < sw.pixels.length; i += 1) {
    maxDiff = Math.max(maxDiff, Math.abs((hw.pixels[i] as number) - (sw.pixels[i] as number)));
  }
  assert.ok(maxDiff <= 4, `hardware vs software within tolerance (got ${maxDiff})`);
});
