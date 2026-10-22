import assert from "node:assert/strict";
import { test } from "node:test";
import { loadPage, repaintPage } from "./page.js";

const VIEWPORT = { width: 320, height: 240, devicePixelRatio: 1 };

/**
 * A page with two BFC-root panels (`overflow:hidden`) and a plain-flow
 * footer: mutating inside `.b` must replay `.a` from the fragment cache
 * while `.b` re-lays out — and the painted result must be BYTE-IDENTICAL
 * to a fresh full load of the post-mutation document.
 */
const PANELS = `<!doctype html><html><head><style>
  .a { overflow: hidden; background: #204060; color: #fff; }
  .b { overflow: hidden; background: #603020; color: #fff; padding: 4px; }
  </style></head><body>
  <div class="a"><p>alpha panel content</p></div>
  <div class="b"><p id="t">beta original</p></div>
  <footer>tail</footer>
  </body></html>`;

const PANELS_AFTER = `<!doctype html><html><head><style>
  .a { overflow: hidden; background: #204060; color: #fff; }
  .b { overflow: hidden; background: #603020; color: #fff; padding: 4px; }
  </style></head><body>
  <div class="a"><p>alpha panel content</p></div>
  <div class="b"><p id="t">beta MUTATED much longer so it definitely wraps onto a second line now</p></div>
  <footer>tail</footer>
  </body></html>`;

void test("incremental layout replays undamaged boundaries; PNG identical to fresh load", async () => {
  const page = await loadPage(
    `${PANELS}<script>window.__mutate = () => {
      document.getElementById('t').textContent =
        'beta MUTATED much longer so it definitely wraps onto a second line now';
      return true;
    };</script>`,
    { viewport: VIEWPORT, runScripts: true, keepAlive: true },
  );
  assert.ok(page !== null);
  try {
    const win = page.runtime?.globals as Record<string, unknown> | null;
    const mutate = win?.["__mutate"] as (() => boolean) | undefined;
    assert.ok(mutate !== undefined);
    assert.equal(mutate(), true);
    const next = await repaintPage(page, page.viewport, page.focus, page.scrollY);
    const stats = next.layoutDamage?.stats;
    assert.ok(stats !== undefined, "repaint must carry the damage store");
    assert.ok(stats.hits >= 1, `expected ≥1 boundary replay, got ${JSON.stringify(stats)}`);
    assert.ok(stats.stores >= 1, `the damaged boundary must re-store, got ${JSON.stringify(stats)}`);

    // Ground truth: a fresh load of the already-mutated document paints the
    // same pixels — the replayed fragments must be geometrically exact.
    const fresh = await loadPage(PANELS_AFTER, { viewport: VIEWPORT, runScripts: false });
    assert.ok(fresh !== null);
    assert.deepEqual(next.pngBytes, fresh.pngBytes);
  } finally {
    page.runtime?.disposeWorkers?.();
  }
});

void test("attribute mutation deep inside a boundary taints only that subtree", async () => {
  const page = await loadPage(
    `${PANELS}<script>window.__mutate = () => {
      document.getElementById('t').setAttribute('style', 'color:#ffff00');
      return true;
    };</script>`,
    { viewport: VIEWPORT, runScripts: true, keepAlive: true },
  );
  assert.ok(page !== null);
  try {
    const win = page.runtime?.globals as Record<string, unknown> | null;
    (win?.["__mutate"] as () => boolean)();
    const next = await repaintPage(page, page.viewport, page.focus, page.scrollY);
    const stats = next.layoutDamage?.stats;
    // The edit lands inside `.b` — `.b` re-lays out, `.a` replays clean.
    assert.ok(stats !== undefined && stats.hits >= 1, JSON.stringify(stats));
  } finally {
    page.runtime?.disposeWorkers?.();
  }
});

void test("scroll repaint bumps the epoch — pinned/fixed geometry never serves stale entries", async () => {
  const page = await loadPage(
    `<!doctype html><body style="margin:0">
      <div style="overflow:hidden;height:400px"><p>tall</p></div>
      <div style="overflow:hidden;position:fixed;top:0">pinned</div>
    </body>`,
    { viewport: VIEWPORT, runScripts: true, keepAlive: true },
  );
  assert.ok(page !== null);
  try {
    const before = page.layoutDamage?.stats.hits ?? 0;
    const next = await repaintPage(page, page.viewport, page.focus, 120);
    const stats = next.layoutDamage?.stats;
    // The scroll-Y change bumped the epoch: this frame may not hit at all.
    assert.ok(stats !== undefined && stats.hits === before, JSON.stringify(stats));
    assert.equal(next.layoutInputs, "320,240,120,1");
  } finally {
    page.runtime?.disposeWorkers?.();
  }
});

void test("inserted <style> marks global damage — nothing replays stale", async () => {
  const page = await loadPage(
    `${PANELS}<script>window.__mutate = () => {
      const st = document.createElement('style');
      st.textContent = '.a { background: #660000; }';
      document.head.appendChild(st); return true;
    };</script>`,
    { viewport: VIEWPORT, runScripts: true, keepAlive: true },
  );
  assert.ok(page !== null);
  try {
    const win = page.runtime?.globals as Record<string, unknown> | null;
    (win?.["__mutate"] as () => boolean)();
    // The inserted <style> is a global restyle source — every boundary must
    // miss on the next layout rather than replay against the new sheet.
    assert.equal(page.layoutDamage?.global, true);
    const next = await repaintPage(page, page.viewport, page.focus, page.scrollY);
    assert.ok(next.pngBytes !== undefined);
    assert.ok(next.layoutDamage !== undefined);
    // consume() ran during the render — the flag cleared for the next frame.
    assert.equal(next.layoutDamage?.global, false);
  } finally {
    page.runtime?.disposeWorkers?.();
  }
});
