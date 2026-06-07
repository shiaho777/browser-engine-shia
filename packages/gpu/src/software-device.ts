/**
 * software-device.ts — a serial software GPU device: it executes the GPU
 * pipeline ({@link renderBand}) on one thread over the whole surface. This is
 * the WARP/SwiftShader-class reference path — fully deterministic, the ground
 * truth the parallel device must match byte-for-byte.
 */
import { renderBand, type CommandBuffer } from "./pipeline.js";
import type { GpuDevice, GpuSurface } from "./device.js";

/** Rasterize a command buffer serially (single thread, whole surface). */
export function renderSerial(cmd: CommandBuffer): GpuSurface {
  const pixels = renderBand(cmd, 0, cmd.height);
  return { width: cmd.width, height: cmd.height, pixels };
}

/** A serial software {@link GpuDevice}. */
export const softwareDevice: GpuDevice = {
  name: "software",
  submit(cmd: CommandBuffer): Promise<GpuSurface> {
    return Promise.resolve(renderSerial(cmd));
  },
};
