/**
 * `@browser-engine/gpu` — a real GPU rendering pipeline.
 *
 * Honesty up front: pure Node/TS cannot reach the discrete-GPU silicon without
 * a native binding, and we do not pretend to. What this package IS, is a genuine
 * GPU PIPELINE — command buffer, fragment shaders (as data), tiled scan
 * conversion, fixed-function blend — implemented as:
 *   - a serial **software GPU** ({@link softwareDevice}), the WARP/SwiftShader
 *     approach browsers actually ship as their fallback renderer; and
 *   - a **multi-core** device ({@link parallelDevice}) that runs the same
 *     pipeline across CPU cores via `worker_threads` — real hardware
 *     acceleration (just CPU SIMD/multicore, not the GPU card).
 *
 * Both implement one {@link GpuDevice} seam; a hardware **WebGPU** device drops
 * in there unchanged when a `navigator.gpu` adapter exists. Imports only
 * `@browser-engine/ir` (infrastructure, not a pipeline stage).
 */
export const PACKAGE_NAME = "@browser-engine/gpu" as const;

export type {
  GpuColor,
  Fragment,
  GpuCommand,
  ClearCommand,
  QuadCommand,
  CommandBuffer,
} from "./pipeline.js";
export { renderBand, shade } from "./pipeline.js";

export type { GpuDevice, GpuSurface } from "./device.js";
export { splitBands } from "./device.js";

export { softwareDevice, renderSerial } from "./software-device.js";
export { parallelDevice, renderParallel, workerPath, type ParallelResult } from "./parallel-device.js";
export { displayListToCommandBuffer } from "./display-list.js";
export { renderProgram } from "./executor.js";
export type { DisplayProgram, DisplayCommand, PushLayerCommand, PopLayerCommand, Matrix6 } from "./executor.js";
export { createWebGpuDevice, isWebGpuAvailable } from "./webgpu-device.js";

import type { GpuDevice } from "./device.js";
import { softwareDevice } from "./software-device.js";
import { parallelDevice } from "./parallel-device.js";
import { createWebGpuDevice } from "./webgpu-device.js";

/**
 * Pick the best AVAILABLE device for a surface: a real hardware **WebGPU**
 * device when one exists (the extreme — actual silicon), else the multi-core
 * software device for large surfaces (worker-thread parallelism pays off), else
 * the serial software device. The WebGPU choice is explicit (the device is
 * `null` when no runtime is present), never a hidden fallback.
 */
export async function selectDevice(surfaceArea: number): Promise<GpuDevice> {
  const hardware = await createWebGpuDevice();
  if (hardware !== null) return hardware;
  return surfaceArea >= 64 * 64 ? parallelDevice() : softwareDevice;
}
