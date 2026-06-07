/**
 * parallel-device.ts — the multi-core GPU device. It splits the surface into
 * disjoint horizontal BANDS and rasterizes them concurrently on
 * `worker_threads` (each worker on a real CPU core), then assembles the bands
 * into one surface. Because bands are disjoint and {@link renderBand} is pure,
 * the result is byte-for-byte identical to the serial device — proven by the
 * differential test. This is real hardware (multi-core) acceleration of the GPU
 * pipeline; a WebGPU adapter would slot in at the same {@link GpuDevice} seam
 * to reach the graphics card.
 */
import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";

import type { CommandBuffer } from "./pipeline.js";
import { renderSerial } from "./software-device.js";
import { splitBands, type GpuDevice, type GpuSurface } from "./device.js";

const WORKER_URL = new URL("./worker.js", import.meta.url);

/** Result of a parallel render: the surface plus how many workers actually ran. */
export interface ParallelResult {
  readonly surface: GpuSurface;
  readonly workersUsed: number;
}

/**
 * Rasterize `cmd` across up to `workerCount` worker threads (default: the
 * machine's available parallelism). Returns the assembled surface and the
 * number of workers used. A degenerate 1-row/1-worker case renders serially.
 */
export async function renderParallel(
  cmd: CommandBuffer,
  workerCount: number = availableParallelism(),
): Promise<ParallelResult> {
  const bands = splitBands(cmd.height, Math.max(1, workerCount));
  if (bands.length <= 1) {
    return { surface: renderSerial(cmd), workersUsed: 1 };
  }
  const pixels = new Uint8ClampedArray(cmd.width * cmd.height * 4);
  await Promise.all(
    bands.map(
      (band) =>
        new Promise<void>((resolve, reject) => {
          const worker = new Worker(WORKER_URL);
          worker.once("message", (msg: { y0: number; buffer: ArrayBuffer }) => {
            pixels.set(new Uint8ClampedArray(msg.buffer), msg.y0 * cmd.width * 4);
            void worker.terminate();
            resolve();
          });
          worker.once("error", (err) => {
            void worker.terminate();
            reject(err);
          });
          worker.postMessage({ cmd, y0: band.y0, y1: band.y1 });
        }),
    ),
  );
  return { surface: { width: cmd.width, height: cmd.height, pixels }, workersUsed: bands.length };
}

/** A multi-core parallel {@link GpuDevice}. */
export function parallelDevice(workerCount?: number): GpuDevice {
  return {
    name: `parallel(${workerCount ?? availableParallelism()})`,
    async submit(cmd: CommandBuffer): Promise<GpuSurface> {
      const { surface } = await renderParallel(cmd, workerCount);
      return surface;
    },
  };
}

/** The resolved worker entry path (exposed for diagnostics/tests). */
export const workerPath = fileURLToPath(WORKER_URL);
