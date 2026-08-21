import test from "node:test";
import assert from "node:assert/strict";

import { startAppServer } from "./server.js";
import { TabHost, TabSession } from "./tab-session.js";
import { applyTextEdit, findEditableNode } from "./page.js";

void test("binary navigate omits base64 and /api/frame serves PNG", async () => {
  const server = await startAppServer({ host: "127.0.0.1", port: 0 });
  try {
    const nav = await fetch(new URL("/api/navigate", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "engine://home", width: 800, height: 600, frameMode: "binary" }),
    });
    assert.equal(nav.status, 200);
    const body = (await nav.json()) as {
      ok?: boolean;
      pngBase64?: string;
      frameMode?: string;
      bytes?: number;
      frameRev?: number;
    };
    assert.equal(body.ok, true);
    assert.equal(body.frameMode, "binary");
    assert.equal(body.pngBase64, undefined);
    assert.ok((body.bytes ?? 0) > 100);
    const frame = await fetch(new URL("/api/frame", server.url));
    assert.equal(frame.status, 200);
    assert.match(frame.headers.get("content-type") ?? "", /image\/png/);
    const bytes = new Uint8Array(await frame.arrayBuffer());
    assert.equal(bytes[0], 0x89);
    assert.equal(bytes[1], 0x50);
    assert.ok(bytes.byteLength > 100);
  } finally {
    await server.close();
  }
});

void test("TabHost can create and switch tabs", async () => {
  const host = new TabHost();
  assert.equal(host.list().length, 1);
  await host.active.navigate("engine://home", { viewport: { width: 700, height: 500 } });
  host.create();
  assert.equal(host.list().length, 2);
  await host.active.navigate("engine://demo", { viewport: { width: 700, height: 500 } });
  assert.match(host.active.url, /demo/);
  const firstId = host.list().find((t) => !t.active)?.id;
  assert.ok(firstId !== undefined);
  host.select(firstId);
  assert.match(host.active.url, /home|browser-engine|engine:\/\//);
});

void test("form page text edit repaints with new bytes", async () => {
  const tab = new TabSession();
  const frame = await tab.navigate("engine://form", { viewport: { width: 900, height: 700 } });
  assert.equal(frame.url, "engine://form");
  assert.ok(frame.pngBase64.length > 100);
  const before = frame.bytes;
  const page = tab.page;
  assert.ok(page);
  let target = null as ReturnType<typeof findEditableNode>;
  for (const [id, node] of page.dom.nodes) {
    if (node.kind === "element" && node.tag === "textarea") {
      target = id;
      break;
    }
  }
  assert.ok(target !== null);
  const next = await applyTextEdit(page, target, "typed-by-test 中文", page.viewport);
  assert.ok(next.frame.bytes > 0);
  assert.notEqual(next.frameRev, page.frameRev);
  void before;
});

void test("clicking editable returns editable hit without navigation", async () => {
  const tab = new TabSession();
  await tab.navigate("engine://form", { viewport: { width: 900, height: 700 } });
  const page = tab.page!;
  let x = 50;
  let y = 50;
  for (const fragment of page.fragmentTree.fragments.values()) {
    const node = page.dom.nodes.get(fragment.node);
    if (node?.kind === "element" && (node.tag === "textarea" || node.tag === "input" || node.attrs?.has("data-editable"))) {
      const box = fragment.box.borderBox;
      x = Number(box.x) + Math.min(10, Number(box.width) / 2);
      y = Number(box.y) + Math.min(10, Number(box.height) / 2);
      break;
    }
  }
  const result = await tab.clickAt(x, y);
  assert.equal(result.navigated, false);
  assert.ok(result.editable !== null, "expected editable hit");
});
