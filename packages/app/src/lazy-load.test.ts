/**
 * RFC 0008: `loading`/`fetchpriority` gating on the app page path.
 * `loading=lazy` defers fetches for images outside the near-viewport window;
 * eager/default images are still requested; `fetchpriority` orders the queue.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { loadPage } from "./page.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function spyFetch(calls: string[]) {
  return (url: string): Promise<Uint8Array | undefined> => {
    calls.push(url);
    return Promise.resolve(new Uint8Array(PNG_1X1));
  };
}

const VIEWPORT = { width: 800, height: 600, devicePixelRatio: 1 };

void test("loading=lazy defers an off-window image; eager still fetches", async () => {
  const html = `<html><body>
    <div style="height:3000px"></div>
    <img src="http://img.test/lazy.png" loading="lazy" width="60" height="60">
    <img src="http://img.test/eager.png" width="60" height="60">
  </body></html>`;
  const calls: string[] = [];
  await loadPage(html, { fetchFn: spyFetch(calls), viewport: VIEWPORT, runScripts: false });
  assert.ok(calls.some((u) => u.includes("eager.png")), "eager image was fetched despite being below the fold");
  assert.ok(!calls.some((u) => u.includes("lazy.png")), "lazy image below the fetch window is deferred");
});

void test("a lazy image inside the window IS fetched", async () => {
  const html = `<html><body>
    <img src="http://img.test/near.png" loading="lazy" width="60" height="60">
  </body></html>`;
  const calls: string[] = [];
  await loadPage(html, { fetchFn: spyFetch(calls), viewport: VIEWPORT, runScripts: false });
  assert.ok(calls.some((u) => u.includes("near.png")), "lazy image in viewport loads");
});

void test("fetchpriority=high warms before an earlier auto image", async () => {
  const html = `<html><body>
    <img src="http://img.test/auto.png" width="60" height="60">
    <img src="http://img.test/hero.png" fetchpriority="high" width="60" height="60">
  </body></html>`;
  const calls: string[] = [];
  await loadPage(html, { fetchFn: spyFetch(calls), viewport: VIEWPORT, runScripts: false });
  const hi = calls.findIndex((u) => u.includes("hero.png"));
  const auto = calls.findIndex((u) => u.includes("auto.png"));
  assert.ok(hi >= 0 && auto >= 0, "both images were requested");
  assert.ok(hi < auto, "fetchpriority=high precedes the document-earlier auto image");
});
