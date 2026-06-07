/**
 * worker.ts — the `worker_threads` entry for the parallel GPU device. Each
 * worker runs on its OWN OS thread (a real CPU core); it receives a command
 * buffer + a band range, rasterizes that band with the SAME {@link renderBand}
 * core as the serial device, and transfers the band's pixel buffer back. This
 * is genuine multi-core hardware acceleration of rasterization.
 */
import { parentPort } from "node:worker_threads";

import { renderBand, type CommandBuffer } from "./pipeline.js";

interface BandRequest {
  readonly cmd: CommandBuffer;
  readonly y0: number;
  readonly y1: number;
}

parentPort?.on("message", (msg: BandRequest) => {
  const buf = renderBand(msg.cmd, msg.y0, msg.y1);
  // Transfer the underlying ArrayBuffer (zero-copy) back to the host.
  const buffer = buf.buffer as ArrayBuffer;
  parentPort?.postMessage({ y0: msg.y0, y1: msg.y1, buffer }, [buffer]);
});
