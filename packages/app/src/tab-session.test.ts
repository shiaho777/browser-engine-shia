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
