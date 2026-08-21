import assert from "node:assert/strict";
import test from "node:test";

import { renderTarget, startAppServer } from "./server.js";
import { HOME_URL, LIVE_URL } from "./home.js";

void test("renderTarget renders engine home", async () => {
  const result = await renderTarget({ target: HOME_URL, width: 960, height: 640 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.width >= 960);
  assert.ok(result.height >= 640);
  assert.ok((result.pngBase64 ?? "").length > 100);
  assert.equal(result.source, HOME_URL);
});

void test("app server health navigate live scripts and viewport endpoints", async () => {
  const server = await startAppServer({ port: 0 });
  try {
    const health = await fetch(new URL("/api/health", server.url));
    assert.equal(health.status, 200);
    const healthBody = (await health.json()) as { ok: boolean };
    assert.equal(healthBody.ok, true);

    const page = await fetch(server.url);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /browser-engine-shia/);
    assert.match(html, /setViewport/);

    const nav = await fetch(new URL("/api/navigate", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "engine://home", width: 1000, height: 700 }),
    });
    assert.equal(nav.status, 200);
    const body = (await nav.json()) as {
      ok: boolean;
      pngBase64?: string;
      width?: number;
      scriptsRun?: number;
      engine?: string;
    };
    assert.equal(body.ok, true);
    assert.ok((body.pngBase64?.length ?? 0) > 100);
    assert.ok((body.width ?? 0) >= 1000);
    assert.equal(body.engine, "fine");
    assert.ok((body.scriptsRun ?? 0) >= 1);

    const live = await fetch(new URL("/api/navigate", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: LIVE_URL, width: 1000, height: 700 }),
    });
    assert.equal(live.status, 200);
    const liveBody = (await live.json()) as {
      ok: boolean;
      mutations?: number;
      scriptsRun?: number;
      scriptError?: string | null;
    };
    assert.equal(liveBody.ok, true);
    assert.ok((liveBody.scriptsRun ?? 0) >= 1);
    assert.ok((liveBody.mutations ?? 0) >= 1);
    assert.equal(liveBody.scriptError ?? null, null);

    const resize = await fetch(new URL("/api/viewport", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ width: 1280, height: 800 }),
    });
    assert.equal(resize.status, 200);
    const resized = (await resize.json()) as { ok: boolean; width?: number };
    assert.equal(resized.ok, true);
    assert.ok((resized.width ?? 0) >= 1280);
  } finally {
    await server.close();
  }
});
