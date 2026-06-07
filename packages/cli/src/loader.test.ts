/**
 * Tests for the M2.3 resource-loading phase: external `<link>`/`<img>` are
 * fetched (deterministic mock) and the document renders with them applied.
 *
 * Built by `tsc` then run with: `node --test packages/cli/dist/*.test.js`.
 *
 * The cli is the wiring/orchestration layer, so it may import every stage and
 * the test-harness codec to assemble fixtures and assertions.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { parseHtml } from "@browser-engine/html-parser";
import { decodePng, encodePng } from "@browser-engine/test-harness";

import { renderUrlToPng } from "./render.js";
import { discoverSubresources, loadResources, resolveUrl, cacheLoader, type FetchFn } from "./loader.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A deterministic fetch backed by a fixed URL→bytes map (no network). */
function mockFetch(map: ReadonlyMap<string, Uint8Array>): FetchFn {
  return (url: string) => Promise.resolve(map.get(url));
}

/** A solid-colour w×h PNG's bytes. */
function pngBytes(w: number, h: number, rgba: readonly [number, number, number, number]): Uint8Array {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    data[i * 4] = rgba[0];
    data[i * 4 + 1] = rgba[1];
    data[i * 4 + 2] = rgba[2];
    data[i * 4 + 3] = rgba[3];
  }
  return encodePng({ width: w, height: h, data });
}

// ---------------------------------------------------------------------------
// URL resolution + subresource discovery
// ---------------------------------------------------------------------------

void test("resolveUrl resolves relative hrefs against the document base", () => {
  assert.equal(resolveUrl("/a.css", "https://x.com/p/doc.html"), "https://x.com/a.css");
  assert.equal(resolveUrl("img.png", "https://x.com/p/doc.html"), "https://x.com/p/img.png");
  assert.equal(resolveUrl("https://y.com/z.css", "https://x.com/"), "https://y.com/z.css");
});

void test("discoverSubresources finds external <link>/<img>, skips data: and inline", () => {
  const dom = parseHtml(
    enc(
      '<html><head><link rel="stylesheet" href="/s.css"><link rel="stylesheet" href="data:text/css,x">' +
        '</head><body><img src="a/i.png"><img src="data:image/png;base64,zzz"></body></html>',
    ),
  );
  const urls = discoverSubresources(dom, "https://x.com/p/doc.html");
  assert.deepEqual(urls.sort(), ["https://x.com/p/a/i.png", "https://x.com/s.css"].sort());
});

// ---------------------------------------------------------------------------
// loadResources + cacheLoader
// ---------------------------------------------------------------------------

void test("loadResources fetches every external subresource into the cache (concurrently)", async () => {
  const base = "https://x.com/doc.html";
  const css = enc("div { color: red }");
  const dom = parseHtml(enc('<link rel="stylesheet" href="/s.css"><img src="/i.png">'));
  const map = new Map<string, Uint8Array>([
    ["https://x.com/s.css", css],
    ["https://x.com/i.png", pngBytes(1, 1, [1, 2, 3, 255])],
  ]);
  const cache = await loadResources(dom, base, mockFetch(map));
  assert.deepEqual(cacheLoader(cache, base)("/s.css"), css);
  assert.ok(cacheLoader(cache, base)("/i.png") !== undefined);
});

void test("a failed subresource fetch is simply absent from the cache (graceful)", async () => {
  const base = "https://x.com/doc.html";
  const dom = parseHtml(enc('<link rel="stylesheet" href="/missing.css">'));
  const cache = await loadResources(dom, base, mockFetch(new Map()));
  assert.equal(cacheLoader(cache, base)("/missing.css"), undefined);
});

// ---------------------------------------------------------------------------
// renderUrlToPng — the end-to-end "open a real URL" path
// ---------------------------------------------------------------------------

void test("renderUrlToPng applies an EXTERNAL stylesheet fetched from the network (mock)", async () => {
  const base = "https://site.test/index.html";
  const html =
    '<html><head><link rel="stylesheet" href="/style.css"></head>' +
    "<body><div>hi</div></body></html>";
  const css = "div { width: 50px; height: 40px; background-color: red }";
  const map = new Map<string, Uint8Array>([
    [base, enc(html)],
    ["https://site.test/style.css", enc(css)],
  ]);

  const { png } = await renderUrlToPng(base, mockFetch(map));
  const img = decodePng(png);
  // The external rule painted a 50×40 red box; sample inside it but BELOW/right
  // of the top-left black "hi" text (which now renders over the background).
  const i = (30 * img.width + 40) * 4;
  assert.equal(img.data[i], 255, "external stylesheet colored the div red (R)");
  assert.equal(img.data[i + 1], 0, "G");
  assert.equal(img.data[i + 2], 0, "B");
});

void test("renderUrlToPng blits an EXTERNAL <img> fetched from the network (mock)", async () => {
  const base = "https://site.test/index.html";
  const html =
    '<html><head><style>img { width: 30px; height: 20px }</style></head>' +
    '<body><img src="/pic.png"></body></html>';
  const map = new Map<string, Uint8Array>([
    [base, enc(html)],
    ["https://site.test/pic.png", pngBytes(2, 2, [0, 0, 255, 255])],
  ]);

  const { png } = await renderUrlToPng(base, mockFetch(map));
  const img = decodePng(png);
  const i = (5 * img.width + 5) * 4;
  assert.equal(img.data[i + 2], 255, "external image blitted blue pixels (B)");
  assert.equal(img.data[i], 0, "R");
});

void test("renderUrlToPng throws only when the ROOT document cannot be fetched", async () => {
  await assert.rejects(
    () => renderUrlToPng("https://nope.test/", mockFetch(new Map())),
    /failed to fetch the document/,
  );
});

void test("renderUrlToPng renders gracefully when a subresource 404s (no throw)", async () => {
  const base = "https://site.test/index.html";
  const html = '<html><head><link rel="stylesheet" href="/missing.css"></head><body><div>hi</div></body></html>';
  const map = new Map<string, Uint8Array>([[base, enc(html)]]);
  const { png } = await renderUrlToPng(base, mockFetch(map));
  assert.ok(png.length > 0, "the document still renders without the missing stylesheet");
});
