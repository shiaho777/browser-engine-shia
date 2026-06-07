/**
 * device.ts — the GPU device seam. A {@link GpuDevice} accepts a submitted
 * {@link CommandBuffer} and returns the rasterized {@link GpuSurface}. The
 * engine talks ONLY to this interface, so the concrete device is swappable:
 *
 *   - {@link import("./software-device.js").softwareDevice} — a serial
 *     software GPU (the WARP/SwiftShader approach);
 *   - {@link import("./parallel-device.js").parallelDevice} — the same
 *     pipeline executed across CPU cores via `worker_threads` (real multi-core
 *     hardware acceleration);
 *   - a hardware **WebGPU** device drops in here unchanged when a real
 *     `navigator.gpu` adapter is available — it implements the same `submit`.
 */
import type { CommandBuffer } from "./pipeline.js";

/** A device-owned RGBA8888 render target. */
export interface GpuSurface {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8ClampedArray;
}

/** A submittable GPU device — the single seam every backend (sw/parallel/WebGPU) implements. */
export interface GpuDevice {
  /** A human-readable device name (e.g. `"software"`, `"parallel(8)"`, `"webgpu"`). */
  readonly name: string;
  /** Rasterize a command buffer into a fresh surface. */
  submit(cmd: CommandBuffer): Promise<GpuSurface>;
}

/** Split `height` rows into up to `count` contiguous, disjoint bands. */
export function splitBands(height: number, count: number): { y0: number; y1: number }[] {
  const n = Math.max(1, Math.min(count, height));
  const bands: { y0: number; y1: number }[] = [];
  const per = Math.ceil(height / n);
  for (let y0 = 0; y0 < height; y0 += per) {
    bands.push({ y0, y1: Math.min(height, y0 + per) });
  }
  return bands;
}
