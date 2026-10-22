import test from "node:test";
import assert from "node:assert/strict";

import { HOME_URL } from "./home.js";
import { TabHost } from "./tab-host.js";
import type { PageFrame } from "./page.js";

function okFrame(host: TabHost, frame: PageFrame) {
  return {
    ok: true as const,
    frame,
    nav: {
      canGoBack: host.active.canGoBack(),
      canGoForward: host.active.canGoForward(),
      url: host.active.url,
    },
    viewport: host.active.viewport,
    tabs: host.list(),
    activeTabId: host.activeId,
    frameMode: "base64" as const,
    pngBase64: frame.pngBase64,
  };
}

void test("electron-shaped host supports tabs type and form edit", async (t) => {
  const host = new TabHost();
  t.after(async () => host.dispose());
  const home = await host.active.navigate(HOME_URL, { viewport: { width: 900, height: 700 } });
  const homePayload = okFrame(host, home);
  assert.equal(homePayload.ok, true);
  assert.ok((homePayload.pngBase64?.length ?? 0) > 100);
  assert.equal(homePayload.tabs.length, 1);

  host.create();
  const demo = await host.active.navigate("engine://form", { viewport: { width: 900, height: 700 } });
  assert.equal(host.list().length, 2);
  assert.equal(demo.url, "engine://form");

  // The renderer owns the fragment tree — find the editable node the same
  // way the chrome does: hit-testing over the wire.
  let found: { x: number; y: number } | null = null;
  for (let y = 0; y < demo.height && found === null; y += 8) {
    for (let x = 0; x < demo.width; x += 8) {
      const hit = await host.active.hitTestAt(x, y);
      if (hit.editable !== null) {
        found = { x, y };
        break;
      }
    }
  }
  assert.ok(found !== null, "expected an editable hit on the form page");

  const click = await host.active.clickAt(found.x, found.y);
  assert.equal(click.navigated, false);
  assert.ok(click.editable);

  const typed = await host.active.commitText(click.editable.nodeId, "electron type 中文");
  assert.ok(typed);
  assert.ok(typed.bytes > 0);
  assert.ok(typed.frameRev >= 2);

  const first = host.list().find((tab) => tab.id !== host.activeId);
  assert.ok(first);
  host.select(first.id);
  assert.ok(host.active.frame !== null);
});
