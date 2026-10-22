/**
 * RFC 0033 — `<canvas>` end-to-end: a guest script draws on a real
 * CanvasKit-backed engine; the bitmap rides the same `imageOf` channel as
 * `<img>` into paint and lands in the rendered page PNG. Also under test:
 * the 300×150 default intrinsic size, replaced-element layout, and repaint
 * after post-load canvas mutation.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { decodePng } from "@browser-engine/test-harness";

import { loadPage, repaintPage } from "./page.js";

const VIEWPORT = { width: 800, height: 600, devicePixelRatio: 1 };

function pixelAt(png: Uint8Array, w: number, x: number, y: number): [number, number, number, number] {
  const d = decodePng(png).data;
  const i = (y * w + x) * 4;
  return [d[i]!, d[i + 1]!, d[i + 2]!, d[i + 3]!];
}

void test("a scripted canvas paints its bitmap into the rendered page PNG", async () => {
  const html = `<!doctype html><title>t</title><body>
    <canvas id="c" width="40" height="40"></canvas>
    <script>
      const ctx = document.getElementById("c").getContext("2d");
      ctx.fillStyle = "rgb(0,128,0)";
      ctx.fillRect(0, 0, 40, 40);
    </script></body>`;
  const page = await loadPage(html, { viewport: VIEWPORT, runScripts: true });
  assert.ok(page !== null && page.pngBytes !== undefined);
  // The canvas box starts under the body's top margin (8px) — sample inside it.
  const p = pixelAt(page.pngBytes, VIEWPORT.width, 20, 20);
  assert.equal(p[0], 0, `canvas should paint green, got ${p.join(",")}`);
  assert.equal(p[1], 128, `canvas should paint green, got ${p.join(",")}`);
  assert.equal(p[2], 0, `canvas should paint green, got ${p.join(",")}`);
});

void test("canvas default intrinsic size is 300×150 (replaced element)", async () => {
  const html = `<!doctype html><title>t</title><body style="margin:0"><canvas id="c"></canvas><script>
      const ctx = document.getElementById("c").getContext("2d");
      ctx.fillStyle = "red";
      ctx.fillRect(0, 0, 300, 150);   // fills the whole DEFAULT bitmap
    </script></body>`;
  const page = await loadPage(html, { viewport: VIEWPORT, runScripts: true });
  assert.ok(page !== null);
  // Measure the red rect's bounds — layout must reserve exactly 300×150.
  const d = decodePng(page.pngBytes).data;
  let minX = -1;
  let maxX = -1;
  let minY = -1;
  let maxY = -1;
  let reds = 0;
  for (let y = 0; y < VIEWPORT.height; y++) {
    for (let x = 0; x < VIEWPORT.width; x++) {
      const i = (y * VIEWPORT.width + x) * 4;
      if (d[i] === 255 && d[i + 1] === 0 && d[i + 2] === 0 && d[i + 3] === 255) {
        reds++;
        if (minX < 0 || x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (minY < 0 || y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  assert.ok(reds > 44_000, `expected ≈300×150=45000 red px, got ${reds}`);
  assert.equal(maxX - minX + 1, 300, "red region must be exactly 300 wide");
  assert.equal(maxY - minY + 1, 150, "red region must be exactly 150 tall");
});

void test("canvas repaint: post-load drawing is visible in the next render", async () => {
  const html = `<!doctype html><title>t</title><body style="margin:0"><canvas id="c" width="30" height="30" style="display:block"></canvas><script>
      const ctx = document.getElementById("c").getContext("2d");
      ctx.fillStyle = "blue"; ctx.fillRect(0, 0, 15, 15);
      window.__drawMore = () => { ctx.fillStyle = "yellow"; ctx.fillRect(15, 15, 15, 15); };
    </script></body>`;
  const page = await loadPage(html, { viewport: VIEWPORT, runScripts: true, keepAlive: true });
  assert.ok(page !== null);
  try {
    assert.deepEqual(pixelAt(page.pngBytes, VIEWPORT.width, 12, 12), [0, 0, 255, 255]);
    // Mutate the canvas after load and re-render — the op-log engine
    // re-rasterizes (dirty flag) and the new paint shows the yellow quadrant.
    const win = page.runtime?.globals as Record<string, unknown> | null;
    const drawMore = win?.["__drawMore"] as (() => void) | undefined;
    assert.ok(drawMore !== undefined, "keepAlive runtime must expose the guest hook");
    drawMore();
    const repainted = await repaintPage(page, page.viewport, page.focus, page.scrollY);
    const q = pixelAt(repainted.pngBytes, VIEWPORT.width, 25, 25);
    assert.equal(q[0], 255, `expected yellow, got ${q.join(",")}`);
    assert.equal(q[1], 255, `expected yellow, got ${q.join(",")}`);
  } finally {
    page.runtime?.disposeWorkers?.();
  }
});
