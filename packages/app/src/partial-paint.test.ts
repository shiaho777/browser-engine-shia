import assert from "node:assert/strict";
import { test } from "node:test";
import { loadPage, repaintPage } from "./page.js";

const VIEWPORT = { width: 320, height: 240, devicePixelRatio: 1 };

/**
 * RFC 0039 retained raster: a repaint after a small DOM mutation must repair
 * the SAME pixel buffer in place (damage-scissored) and produce output that
 * is byte-identical to a from-scratch load of the mutated document.
 */
const PANELS = (label: string) => `<!doctype html><html><head><style>
  .band { background: #204060; height: 40px; }
  .edit { background: #603020; color: #fff; }
  </style></head><body>
  <div class="band"></div>
  <div class="edit"><p id="t">${label}</p></div>
  <div class="band"></div>
  </body></html>`;

void test("partial repaint repairs the retained buffer — PNG identical to fresh", async () => {
  const page = await loadPage(
    `${PANELS("before")}<script>window.__mutate = () => {
      document.getElementById('t').textContent = 'after MUTATED content';
      return true;
    };</script>`,
    { viewport: VIEWPORT, runScripts: true, keepAlive: true },
  );
  assert.ok(page !== null);
  try {
    const retained = page.raster;
    assert.ok(retained != null, "first render must publish its raster");
    const win = page.runtime?.globals as Record<string, unknown> | null;
    const mutate = win?.["__mutate"] as (() => boolean) | undefined;
    assert.ok(mutate !== undefined);
    mutate();
    const next = await repaintPage(page, page.viewport, page.focus, page.scrollY);
    // The retained buffer is repaired IN PLACE — same allocation survives.
    assert.ok(next.raster != null);
    assert.equal(next.raster?.pixels, retained.pixels, "partial repaint reused the buffer");
    const fresh = await loadPage(PANELS("after MUTATED content"), {
      viewport: VIEWPORT,
      runScripts: false,
    });
    assert.ok(fresh !== null);
    assert.deepEqual(next.pngBytes, fresh.pngBytes, "damaged render == full render");
  } finally {
    page.runtime?.disposeWorkers?.();
  }
});

void test("a no-change repaint short-circuits to the retained pixels", async () => {
  const page = await loadPage(PANELS("static"), { viewport: VIEWPORT });
  assert.ok(page !== null);
  const retained = page.raster;
  const next = await repaintPage(page, page.viewport, page.focus, page.scrollY);
  assert.equal(next.raster?.pixels, retained?.pixels);
  assert.deepEqual(next.pngBytes, page.pngBytes, "unchanged input ⇒ unchanged frame");
});
