import assert from "node:assert/strict";
import test from "node:test";

import { TabSession } from "./tab-session.js";

void test("TabSession home render and link hit-test", async () => {
  const tab = new TabSession();
  const frame = await tab.navigate("engine://home", { viewport: { width: 900, height: 700 } });
  assert.equal(frame.url, "engine://home");
  assert.ok(frame.pngBase64.length > 100);
  assert.ok(frame.width >= 900);
  assert.equal(tab.viewport.width, 900);
  assert.equal(frame.engine, "fine");
  assert.ok(frame.scriptsRun >= 1);

  let found: { x: number; y: number; href: string } | null = null;
  for (let y = 0; y < frame.height; y += 8) {
    for (let x = 0; x < Math.min(frame.width, 500); x += 8) {
      const hit = tab.hitTestAt(x, y);
      if (hit.href !== null) {
        found = { x, y, href: hit.href };
        break;
      }
    }
    if (found !== null) break;
  }
  assert.ok(found !== null, "expected a link hit on the home page");
  const click = await tab.clickAt(found.x, found.y);
  assert.equal(click.navigated, true);
  assert.ok(click.frame.url.length > 0);
});

void test("TabSession demo navigation runs scripts", async () => {
  const tab = new TabSession();
  const frame = await tab.navigate("engine://demo");
  assert.equal(frame.url, "engine://demo");
  assert.match(frame.title, /demo/i);
  assert.ok(frame.scriptsRun >= 1);
  assert.equal(frame.scriptError, null);
});

void test("TabSession live page drains timers via FineSession", async () => {
  const tab = new TabSession();
  const frame = await tab.navigate("engine://live", { viewport: { width: 900, height: 700 } });
  assert.equal(frame.url, "engine://live");
  assert.ok(frame.scriptsRun >= 1);
  assert.ok(frame.mutations >= 1, "expected DOM mutations from live script");
  assert.equal(frame.scriptError, null);
});

void test("TabSession viewport relayout grows canvas", async () => {
  const tab = new TabSession();
  await tab.navigate("engine://home", { viewport: { width: 800, height: 600 } });
  const small = tab.frame;
  assert.ok(small !== null);
  const grown = await tab.applyViewport({ width: 1200, height: 800 });
  assert.ok(grown !== null);
  assert.ok(grown.width >= 1200);
  assert.equal(tab.viewport.width, 1200);
});

void test("keepAlive page pumps guest timers into new frames", async () => {
  const tab = new TabSession();
  const html = `<!doctype html><html><body><div id="out">0</div><script>
      var n = 0;
      setInterval(function () { n += 1; document.getElementById("out").textContent = String(n); }, 30);
    </script></body></html>`;
  await tab.navigate(html, { viewport: { width: 600, height: 400 }, keepAlive: true });
  const before = tab.page;
  assert.ok(before !== null);
  assert.ok(before.runtime !== undefined, "keepAlive navigate must expose a runtime");
  const baseline = before.runtime.mutations();

  // The classic runner uses real host intervals: give the first 30ms tick time to fire,
  // then pump frames and confirm the guest kept mutating.
  await new Promise((resolve) => setTimeout(resolve, 120));
  const afterWait = (tab.page?.runtime?.mutations() ?? 0);
  assert.ok(afterWait > baseline, "guest interval must tick while the page is live");

  const first = await tab.pump(3, { settleMs: 120, idleStop: false });
  assert.ok(first.frames >= 1);
  assert.ok(first.frameRev > (before.frameRev ?? 1));
  assert.ok(
    (tab.page?.runtime?.mutations() ?? 0) >= afterWait,
    "pumping must preserve the live runtime",
  );

  // The interval text must have actually changed: find the #out node and check
  // its text is now a positive integer (it started as "0").
  let outText: string | null = null;
  const nodes = tab.page?.dom.nodes;
  if (nodes !== undefined) {
    for (const node of nodes.values()) {
      if (node.kind === "element" && node.tag === "div" && node.attrs?.get("id") === "out") {
        for (const child of node.children) {
          const t = nodes.get(child);
          if (t?.text !== undefined) outText = t.text;
        }
      }
    }
  }
  assert.ok(outText !== null && outText !== "0" && Number(outText) > 0, "interval must have ticked");
  assert.ok((tab.page?.pngBytes.byteLength ?? 0) > 100);
});
