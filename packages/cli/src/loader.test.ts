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

import { renderUrlToPng, type ResourceTrace } from "./render.js";
import { discoverSubresources, documentBaseUrl, loadResources, loadResourcesWithTrace, resolveUrl, cacheLoader, type FetchFn } from "./loader.js";

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

/** A solid-colour PNG encoded as an inline data URL. */
function pngDataUrl(w: number, h: number, rgba: readonly [number, number, number, number]): string {
  return `data:image/png;base64,${Buffer.from(pngBytes(w, h, rgba)).toString("base64")}`;
}

async function renderStylesheetMediaCase(media: string): Promise<{
  readonly calls: readonly string[];
  readonly cssBytes: number;
  readonly pngBytes: number;
  readonly trace: ResourceTrace;
}> {
  const base = `https://site.test/media-${encodeURIComponent(media)}.html`;
  const html =
    `<html><head><link rel="stylesheet" media="${media}" href="/theme.css"></head>` +
    "<body><div>after</div></body></html>";
  const css = "div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }";
  const calls: string[] = [];
  const resources = new Map<string, Uint8Array>([
    [base, enc(html)],
    ["https://site.test/theme.css", enc(css)],
  ]);

  const result = await renderUrlToPng(
    base,
    (url) => {
      calls.push(url);
      return Promise.resolve(resources.get(url));
    },
    { trace: true },
  );
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  return Object.freeze({
    calls,
    cssBytes: enc(css).byteLength,
    pngBytes: result.png.byteLength,
    trace,
  });
}

// ---------------------------------------------------------------------------
// URL resolution + subresource discovery
// ---------------------------------------------------------------------------

void test("resolveUrl resolves relative hrefs against the document base", () => {
  assert.equal(resolveUrl("/a.css", "https://x.com/p/doc.html"), "https://x.com/a.css");
  assert.equal(resolveUrl("img.png", "https://x.com/p/doc.html"), "https://x.com/p/img.png");
  assert.equal(resolveUrl("https://y.com/z.css", "https://x.com/"), "https://y.com/z.css");
  assert.equal(resolveUrl("", "https://x.com/p/doc.html"), "https://x.com/p/doc.html");
  assert.equal(resolveUrl("#sheet", "https://x.com/p/doc.html"), "https://x.com/p/doc.html#sheet");
  assert.equal(resolveUrl("?sheet", "https://x.com/p/doc.html?old=1#frag"), "https://x.com/p/doc.html?sheet");
  assert.equal(resolveUrl("//cdn.test/s.css", "https://x.com/p/doc.html"), "https://cdn.test/s.css");
  assert.equal(resolveUrl("http://bad.test:99999/s.css", "https://x.com/p/doc.html"), null);
  assert.equal(resolveUrl(" /space.css ", "https://x.com/p/doc.html"), "https://x.com/space.css");
  assert.equal(resolveUrl("\n\t/controls.css\f", "https://x.com/p/doc.html"), "https://x.com/controls.css");
});

void test("documentBaseUrl freezes the first href base and ignores later base elements", () => {
  const dom = parseHtml(
    enc(
      '<html><head><base href="https://cdn.test/assets/"><base href="https://later.test/">' +
        '</head><body><img src="pic.png"></body></html>',
    ),
  );

  assert.equal(documentBaseUrl(dom, "https://site.test/pages/index.html"), "https://cdn.test/assets/");
});

void test("documentBaseUrl falls back when the first href base is invalid and ignores later bases", () => {
  const invalid = parseHtml(
    enc(
      '<html><head><base href="http://bad.test:99999/assets/"><base href="https://later.test/assets/"></head>' +
        '<body><img src="pic.png"></body></html>',
    ),
  );

  assert.equal(documentBaseUrl(invalid, "https://site.test/pages/index.html"), "https://site.test/pages/index.html");
});

void test("documentBaseUrl falls back to the document URL for missing or disallowed base hrefs", () => {
  const missing = parseHtml(enc('<html><head><base target="_blank"></head><body><img src="pic.png"></body></html>'));
  const data = parseHtml(enc('<html><head><base href="data:text/html,base"></head></html>'));
  const javascript = parseHtml(enc('<html><head><base href="javascript:alert(1)"></head></html>'));

  assert.equal(documentBaseUrl(missing, "https://site.test/pages/index.html"), "https://site.test/pages/index.html");
  assert.equal(documentBaseUrl(data, "https://site.test/pages/index.html"), "https://site.test/pages/index.html");
  assert.equal(documentBaseUrl(javascript, "https://site.test/pages/index.html"), "https://site.test/pages/index.html");
});

void test("discoverSubresources finds external <link>/<img>, resolves empty stylesheet href, skips data: and inline", () => {
  const dom = parseHtml(
    enc(
      '<html><head><link rel="stylesheet" href="/s.css"><link rel="stylesheet" href="">' +
        '<link rel="stylesheet" href="data:text/css,x"></head><body><img src="a/i.png">' +
        '<img src=""><img src="data:image/png;base64,zzz"></body></html>',
    ),
  );
  const urls = discoverSubresources(dom, "https://x.com/p/doc.html");
  assert.deepEqual(
    urls.sort(),
    ["https://x.com/p/a/i.png", "https://x.com/p/doc.html", "https://x.com/s.css"].sort(),
  );
});

void test("discoverSubresources resolves relative stylesheet and image URLs against base href", () => {
  const dom = parseHtml(
    enc(
      '<html><head><base href="https://cdn.test/assets/"><link rel="stylesheet" href="css/theme.css"></head>' +
        '<body><img src="img/pic.png"></body></html>',
    ),
  );
  const urls = discoverSubresources(dom, "https://site.test/pages/index.html");

  assert.deepEqual(urls, ["https://cdn.test/assets/css/theme.css", "https://cdn.test/assets/img/pic.png"]);
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

void test("loadResourcesWithTrace reports loaded and missing resources deterministically", async () => {
  const base = "https://x.com/doc.html";
  const css = enc("div { color: red }");
  const dom = parseHtml(enc('<link rel="stylesheet" href="/s.css"><img src="/missing.png">'));
  const result = await loadResourcesWithTrace(
    dom,
    base,
    mockFetch(new Map([["https://x.com/s.css", css]])),
  );

  assert.deepEqual(result.cache.get("https://x.com/s.css"), css);
  assert.deepEqual(
    result.events.map((event) => [event.url, event.status, event.byteLength]),
    [
      ["https://x.com/s.css", "loaded", css.byteLength],
      ["https://x.com/missing.png", "missing", 0],
    ],
  );
});

void test("loadResourcesWithTrace fetches a duplicate absolute resource URL only once", async () => {
  const base = "https://x.com/doc.html";
  const png = pngBytes(1, 1, [1, 2, 3, 255]);
  const dom = parseHtml(enc('<img src="/shared.png"><img src="shared.png"><img src="/shared.png">'));
  const calls: string[] = [];
  const result = await loadResourcesWithTrace(dom, base, (url) => {
    calls.push(url);
    return Promise.resolve(url === "https://x.com/shared.png" ? png : undefined);
  });

  assert.deepEqual(calls, ["https://x.com/shared.png"]);
  assert.deepEqual(
    result.events.map((event) => [event.url, event.status, event.byteLength]),
    [["https://x.com/shared.png", "loaded", png.byteLength]],
  );
  assert.deepEqual(result.cache.get("https://x.com/shared.png"), png);
});

void test("loadResourcesWithTrace and cacheLoader share the same base href resolution", async () => {
  const documentUrl = "https://site.test/pages/index.html";
  const baseUrl = "https://cdn.test/assets/";
  const css = enc("div { color: red }");
  const dom = parseHtml(
    enc('<html><head><base href="https://cdn.test/assets/"><link rel="stylesheet" href="css/theme.css"></head></html>'),
  );
  const result = await loadResourcesWithTrace(dom, documentUrl, (url) => (
    Promise.resolve(url === "https://cdn.test/assets/css/theme.css" ? css : undefined)
  ));

  assert.deepEqual(result.events.map((event) => event.url), ["https://cdn.test/assets/css/theme.css"]);
  assert.deepEqual(cacheLoader(result.cache, baseUrl)("css/theme.css"), css);
  assert.equal(cacheLoader(result.cache, documentUrl)("css/theme.css"), undefined);
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

void test("renderUrlToPng resolves stylesheet hrefs against base href", async () => {
  const documentUrl = "https://site.test/pages/index.html";
  const stylesheetUrl = "https://cdn.test/assets/css/theme.css";
  const html =
    '<html><head><base href="https://cdn.test/assets/"><link rel="stylesheet" href="css/theme.css"></head>' +
    "<body><div></div></body></html>";
  const css = "div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }";
  const calls: string[] = [];
  const resources = new Map<string, Uint8Array>([
    [documentUrl, enc(html)],
    [stylesheetUrl, enc(css)],
  ]);

  const result = await renderUrlToPng(
    documentUrl,
    (url) => {
      calls.push(url);
      return Promise.resolve(resources.get(url));
    },
    { trace: true },
  );
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  assert.deepEqual(calls, [documentUrl, stylesheetUrl], "stylesheet fetch follows the frozen first base href");
  assert.deepEqual(trace.discoveredResources, [stylesheetUrl]);
  assert.deepEqual(trace.loadedResources, [stylesheetUrl]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, enc(css).byteLength);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + base-resolved author sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(trace.paintOps.includes("rect"), "base-resolved stylesheet applies real CSS");

  const image = decodePng(result.png);
  const i = (10 * image.width + 10) * 4;
  assert.equal(image.data[i], 255, "base-resolved stylesheet paints the target red");
  assert.equal(image.data[i + 1], 0);
  assert.equal(image.data[i + 2], 0);
});

void test("renderUrlToPng resolves image srcs against base href", async () => {
  const documentUrl = "https://site.test/pages/index.html";
  const imageUrl = "https://cdn.test/assets/img/pic.png";
  const html =
    '<html><head><base href="https://cdn.test/assets/"><style>img { width: 30px; height: 20px }</style></head>' +
    '<body><img src="img/pic.png"></body></html>';
  const imageBytes = pngBytes(2, 2, [0, 0, 255, 255]);
  const calls: string[] = [];
  const resources = new Map<string, Uint8Array>([
    [documentUrl, enc(html)],
    [imageUrl, imageBytes],
  ]);

  const result = await renderUrlToPng(
    documentUrl,
    (url) => {
      calls.push(url);
      return Promise.resolve(resources.get(url));
    },
    { trace: true },
  );
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  assert.deepEqual(calls, [documentUrl, imageUrl], "image fetch follows the frozen first base href");
  assert.deepEqual(trace.discoveredResources, [imageUrl]);
  assert.deepEqual(trace.loadedResources, [imageUrl]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, imageBytes.byteLength);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + inline image sizing sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 2);
  assert.equal(trace.decodedImageCount, 1);
  assert.equal(trace.imagePaintCount, 1);
  assert.ok(trace.paintOps.includes("image"), "base-resolved image decodes and paints");

  const image = decodePng(result.png);
  // The UA sheet gives body an 8px margin, so the image paints at (8, 8);
  // sample inside it, clear of the margin.
  const i = (12 * image.width + 12) * 4;
  assert.equal(image.data[i], 0);
  assert.equal(image.data[i + 1], 0);
  assert.equal(image.data[i + 2], 255, "base-resolved image paints blue pixels");
});

void test("renderUrlToPng fetches duplicate stylesheet URLs once while preserving cascade participation", async () => {
  const base = "https://site.test/index.html";
  const html =
    '<html><head><link rel="stylesheet" href="/shared.css">' +
    "<style>div { width: 20px; height: 20px; background-color: rgb(0, 0, 255) }</style>" +
    '<link rel="stylesheet" href="shared.css"></head><body><div></div></body></html>';
  const css = "div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }";
  const calls: string[] = [];
  const resources = new Map<string, Uint8Array>([
    [base, enc(html)],
    ["https://site.test/shared.css", enc(css)],
  ]);

  const result = await renderUrlToPng(
    base,
    (url) => {
      calls.push(url);
      return Promise.resolve(resources.get(url));
    },
    { trace: true },
  );
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  assert.deepEqual(calls, [base, "https://site.test/shared.css"]);
  assert.deepEqual(trace.discoveredResources, ["https://site.test/shared.css"]);
  assert.deepEqual(trace.loadedResources, ["https://site.test/shared.css"]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, enc(css).byteLength);
  assert.equal(trace.stylesheetCount, 4, "UA sheet + two duplicate links + inline style");
  assert.equal(trace.authorStylesheetCount, 3);
  assert.equal(trace.authorRuleCount, 3);
  assert.equal(trace.authorDeclarationCount, 9);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(trace.paintOps.includes("rect"), "duplicate stylesheet cascade still paints the target");

  const image = decodePng(result.png);
  const i = (10 * image.width + 10) * 4;
  assert.equal(image.data[i], 255, "later duplicate stylesheet wins tied source order over inline blue rule");
  assert.equal(image.data[i + 1], 0);
  assert.equal(image.data[i + 2], 0);
});

void test("renderUrlToPng trace reports resource-loaded page evidence", async () => {
  const base = "https://site.test/index.html";
  const html =
    '<html><head><link rel="stylesheet" href="/style.css"></head>' +
    '<body><img src="/pic.png"><img src="/missing.png"></body></html>';
  const css = "img { width: 30px; height: 20px }";
  const png = pngBytes(2, 2, [0, 0, 255, 255]);
  const map = new Map<string, Uint8Array>([
    [base, enc(html)],
    ["https://site.test/style.css", enc(css)],
    ["https://site.test/pic.png", png],
  ]);

  const result = await renderUrlToPng(base, mockFetch(map), { trace: true });
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");
  assert.equal(trace.url, base);
  assert.equal(trace.rootBytes, enc(html).byteLength);
  assert.deepEqual(trace.discoveredResources, [
    "https://site.test/missing.png",
    "https://site.test/pic.png",
    "https://site.test/style.css",
  ]);
  assert.deepEqual(trace.loadedResources, ["https://site.test/pic.png", "https://site.test/style.css"]);
  assert.deepEqual(trace.missingResources, ["https://site.test/missing.png"]);
  assert.equal(trace.loadedBytes, enc(css).byteLength + png.byteLength);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + fetched author sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 2);
  assert.equal(trace.decodedImageCount, 1);
  assert.ok(trace.displayCommands > 0);
  assert.ok(trace.paintOps.includes("image"));
});

void test("renderUrlToPng trace reports a missing image without painting a fake image", async () => {
  const base = "https://site.test/index.html";
  const html = '<body><img src="/missing.png"><div>after</div></body>';
  const map = new Map<string, Uint8Array>([[base, enc(html)]]);

  const result = await renderUrlToPng(base, mockFetch(map), { trace: true });
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");
  assert.deepEqual(trace.discoveredResources, ["https://site.test/missing.png"]);
  assert.deepEqual(trace.loadedResources, []);
  assert.deepEqual(trace.missingResources, ["https://site.test/missing.png"]);
  assert.equal(trace.loadedBytes, 0);
  assert.equal(trace.decodedImageCount, 0, "missing external image is not decoded");
  assert.equal(trace.imagePaintCount, 0, "missing external image paints no image commands");
  assert.ok(!trace.paintOps.includes("image"), "missing external image does not synthesize an image paint op");
  assert.ok(trace.displayCommands > 0, "the rest of the page still renders");
  assert.ok(result.png.length > 0, "rendering continues despite the missing image");
});

void test("renderUrlToPng trace reports an invalid external image without painting a fake image", async () => {
  const base = "https://site.test/index.html";
  const html = '<body><img src="/bad.png"><div>after</div></body>';
  const badPng = enc("not a png");
  const map = new Map<string, Uint8Array>([
    [base, enc(html)],
    ["https://site.test/bad.png", badPng],
  ]);

  const result = await renderUrlToPng(base, mockFetch(map), { trace: true });
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");
  assert.deepEqual(trace.discoveredResources, ["https://site.test/bad.png"]);
  assert.deepEqual(trace.loadedResources, ["https://site.test/bad.png"]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, badPng.byteLength);
  assert.equal(trace.decodedImageCount, 0, "invalid external image bytes are not decoded");
  assert.equal(trace.imagePaintCount, 0, "invalid external image paints no image commands");
  assert.ok(!trace.paintOps.includes("image"), "invalid external image does not synthesize an image paint op");
  assert.ok(trace.displayCommands > 0, "the rest of the page still renders");
  assert.ok(result.png.length > 0, "rendering continues despite the invalid image");
});

void test("renderUrlToPng reuses one fetched image resource for multiple DOM references", async () => {
  const base = "https://site.test/index.html";
  const html =
    '<html><head><style>img { width: 10px; height: 10px }</style></head>' +
    '<body><img src="/shared.png"><img src="shared.png"></body></html>';
  const shared = pngBytes(2, 2, [0, 128, 255, 255]);
  const calls: string[] = [];
  const resources = new Map<string, Uint8Array>([
    [base, enc(html)],
    ["https://site.test/shared.png", shared],
  ]);
  const result = await renderUrlToPng(
    base,
    (url) => {
      calls.push(url);
      return Promise.resolve(resources.get(url));
    },
    { trace: true },
  );
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  assert.deepEqual(calls, [base, "https://site.test/shared.png"]);
  assert.deepEqual(trace.discoveredResources, ["https://site.test/shared.png"]);
  assert.deepEqual(trace.loadedResources, ["https://site.test/shared.png"]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, shared.byteLength);
  assert.equal(trace.decodedImageCount, 2, "both <img> nodes decode from the shared cached bytes");
  assert.equal(trace.imagePaintCount, 2, "both <img> nodes paint from the shared cached bytes");
  assert.equal(trace.paintOps.includes("image"), true);
  assert.ok(trace.displayCommands >= 2);
});

void test("renderUrlToPng consumes data: stylesheet and image without subresource fetches", async () => {
  const base = "https://site.test/index.html";
  const css = "div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) } img { width: 10px; height: 10px }";
  const cssUrl = `data:text/css;charset=utf-8;base64,${Buffer.from(css, "utf8").toString("base64")}`;
  const image = pngDataUrl(2, 2, [0, 128, 255, 255]);
  const html =
    `<html><head><link rel="stylesheet" href="${cssUrl}"></head>` +
    `<body><div></div><img src="${image}"></body></html>`;
  const calls: string[] = [];

  const result = await renderUrlToPng(
    base,
    (url) => {
      calls.push(url);
      return Promise.resolve(url === base ? enc(html) : undefined);
    },
    { trace: true },
  );
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  assert.deepEqual(calls, [base]);
  assert.deepEqual(trace.discoveredResources, []);
  assert.deepEqual(trace.loadedResources, []);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, 0);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + inline data: author sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 2);
  assert.equal(trace.authorDeclarationCount, 5);
  assert.equal(trace.decodedImageCount, 1, "inline data: image is decoded without network");
  assert.equal(trace.imagePaintCount, 1, "inline data: image paints through the normal image path");
  assert.ok(trace.paintOps.includes("rect"), "inline data: stylesheet applies author background rules");
  assert.ok(trace.paintOps.includes("image"));
});

void test("renderUrlToPng applies percent-encoded data:text/css;charset=utf-8 stylesheets without fetches", async () => {
  const base = "https://site.test/index.html";
  const css = "div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }";
  const cssUrl = `data:text/css;charset=utf-8,${encodeURIComponent(css)}`;
  const html = `<html><head><link rel="stylesheet" href="${cssUrl}"></head><body><div></div></body></html>`;
  const calls: string[] = [];

  const result = await renderUrlToPng(
    base,
    (url) => {
      calls.push(url);
      return Promise.resolve(url === base ? enc(html) : undefined);
    },
    { trace: true },
  );
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  assert.deepEqual(calls, [base], "percent-encoded charset data: CSS is decoded inline");
  assert.equal(calls.includes(cssUrl), false);
  assert.deepEqual(trace.discoveredResources, []);
  assert.deepEqual(trace.loadedResources, []);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, 0);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + percent-encoded charset data: author sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(trace.paintOps.includes("rect"), "charset data: stylesheet applies real author CSS");

  const image = decodePng(result.png);
  const i = (10 * image.width + 10) * 4;
  assert.equal(image.data[i], 255, "percent-encoded charset data: CSS paints red");
  assert.equal(image.data[i + 1], 0);
  assert.equal(image.data[i + 2], 0);
});

void test("renderUrlToPng applies base64 data:text/css;charset=utf-8 stylesheets without fetches", async () => {
  const base = "https://site.test/index.html";
  const css = "div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }";
  const cssUrl = `data:text/css;charset=utf-8;base64,${Buffer.from(css, "utf8").toString("base64")}`;
  const html = `<html><head><link rel="stylesheet" href="${cssUrl}"></head><body><div></div></body></html>`;
  const calls: string[] = [];

  const result = await renderUrlToPng(
    base,
    (url) => {
      calls.push(url);
      return Promise.resolve(url === base ? enc(html) : undefined);
    },
    { trace: true },
  );
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  assert.deepEqual(calls, [base], "base64 charset data: CSS is decoded inline");
  assert.equal(calls.includes(cssUrl), false);
  assert.deepEqual(trace.discoveredResources, []);
  assert.deepEqual(trace.loadedResources, []);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, 0);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + base64 charset data: author sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(trace.paintOps.includes("rect"), "base64 charset data: stylesheet applies real author CSS");

  const image = decodePng(result.png);
  const i = (10 * image.width + 10) * 4;
  assert.equal(image.data[i], 255, "base64 charset data: CSS paints red");
  assert.equal(image.data[i + 1], 0);
  assert.equal(image.data[i + 2], 0);
});

void test("renderUrlToPng skips unsupported data:text/css charset metadata without fake author rules", async () => {
  const base = "https://site.test/index.html";
  const css = "div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }";
  const cssUrl = `data:text/css;charset=iso-8859-1,${encodeURIComponent(css)}`;
  const html = `<html><head><link rel="stylesheet" href="${cssUrl}"></head><body><div>after</div></body></html>`;
  const calls: string[] = [];

  const result = await renderUrlToPng(
    base,
    (url) => {
      calls.push(url);
      return Promise.resolve(url === base ? enc(html) : undefined);
    },
    { trace: true },
  );
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  assert.deepEqual(calls, [base], "unsupported charset data: CSS is not fetched");
  assert.equal(calls.includes(cssUrl), false);
  assert.deepEqual(trace.discoveredResources, []);
  assert.deepEqual(trace.loadedResources, []);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, 0);
  assert.equal(trace.stylesheetCount, 1, "only the UA stylesheet is active");
  assert.equal(trace.authorStylesheetCount, 0, "unsupported charset does not enter author CSS");
  assert.equal(trace.authorRuleCount, 0);
  assert.equal(trace.authorDeclarationCount, 0);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(!trace.paintOps.includes("rect"), "unsupported charset does not synthesize a background rule");
  assert.ok(trace.paintOps.includes("text"), "the rest of the page still renders visible text");
  assert.ok(result.png.length > 0);
});

void test("renderUrlToPng lets a later external stylesheet override an earlier data: stylesheet", async () => {
  const base = "https://site.test/index.html";
  const external = "https://site.test/late.css";
  const dataCss = "div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }";
  const externalCss = "div { background-color: rgb(0, 0, 255) }";
  const dataCssUrl = `data:text/css,${encodeURIComponent(dataCss)}`;
  const html =
    `<html><head><link rel="stylesheet" href="${dataCssUrl}">` +
    '<link rel="stylesheet" href="/late.css"></head><body><div></div></body></html>';
  const calls: string[] = [];
  const resources = new Map<string, Uint8Array>([
    [base, enc(html)],
    [external, enc(externalCss)],
  ]);

  const result = await renderUrlToPng(
    base,
    (url) => {
      calls.push(url);
      return Promise.resolve(resources.get(url));
    },
    { trace: true },
  );
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  assert.deepEqual(calls, [base, external], "data: stylesheet is parsed inline and never fetched");
  assert.equal(calls.includes(dataCssUrl), false);
  assert.deepEqual(trace.discoveredResources, [external]);
  assert.deepEqual(trace.loadedResources, [external]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, enc(externalCss).byteLength);
  assert.equal(trace.stylesheetCount, 3, "UA sheet + data: author sheet + external author sheet");
  assert.equal(trace.authorStylesheetCount, 2);
  assert.equal(trace.authorRuleCount, 2);
  assert.equal(trace.authorDeclarationCount, 4);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(trace.paintOps.includes("rect"), "both author stylesheets participate in the cascade");

  const image = decodePng(result.png);
  const i = (10 * image.width + 10) * 4;
  assert.equal(image.data[i], 0, "later external stylesheet wins the background red channel");
  assert.equal(image.data[i + 1], 0);
  assert.equal(image.data[i + 2], 255, "later external stylesheet wins the background blue channel");
});

void test("renderUrlToPng lets a later data: stylesheet override an earlier external stylesheet", async () => {
  const base = "https://site.test/index.html";
  const external = "https://site.test/early.css";
  const externalCss = "div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }";
  const dataCss = "div { background-color: rgb(0, 0, 255) }";
  const dataCssUrl = `data:text/css,${encodeURIComponent(dataCss)}`;
  const html =
    '<html><head><link rel="stylesheet" href="/early.css">' +
    `<link rel="stylesheet" href="${dataCssUrl}"></head><body><div></div></body></html>`;
  const calls: string[] = [];
  const resources = new Map<string, Uint8Array>([
    [base, enc(html)],
    [external, enc(externalCss)],
  ]);

  const result = await renderUrlToPng(
    base,
    (url) => {
      calls.push(url);
      return Promise.resolve(resources.get(url));
    },
    { trace: true },
  );
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  assert.deepEqual(calls, [base, external], "data: stylesheet is parsed inline and never fetched");
  assert.equal(calls.includes(dataCssUrl), false);
  assert.deepEqual(trace.discoveredResources, [external]);
  assert.deepEqual(trace.loadedResources, [external]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, enc(externalCss).byteLength);
  assert.equal(trace.stylesheetCount, 3, "UA sheet + external author sheet + data: author sheet");
  assert.equal(trace.authorStylesheetCount, 2);
  assert.equal(trace.authorRuleCount, 2);
  assert.equal(trace.authorDeclarationCount, 4);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(trace.paintOps.includes("rect"), "both author stylesheets participate in the cascade");

  const image = decodePng(result.png);
  const i = (10 * image.width + 10) * 4;
  assert.equal(image.data[i], 0, "later data: stylesheet wins the background red channel");
  assert.equal(image.data[i + 1], 0);
  assert.equal(image.data[i + 2], 255, "later data: stylesheet wins the background blue channel");
});

void test("renderUrlToPng lets a later inline style override an earlier external stylesheet", async () => {
  const base = "https://site.test/index.html";
  const external = "https://site.test/early.css";
  const externalCss = "div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }";
  const html =
    '<html><head><link rel="stylesheet" href="/early.css">' +
    "<style>div { background-color: rgb(0, 0, 255) }</style></head><body><div></div></body></html>";
  const calls: string[] = [];
  const resources = new Map<string, Uint8Array>([
    [base, enc(html)],
    [external, enc(externalCss)],
  ]);

  const result = await renderUrlToPng(
    base,
    (url) => {
      calls.push(url);
      return Promise.resolve(resources.get(url));
    },
    { trace: true },
  );
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  assert.deepEqual(calls, [base, external]);
  assert.equal(calls.filter((url) => url === external).length, 1, "external stylesheet is fetched exactly once");
  assert.deepEqual(trace.discoveredResources, [external]);
  assert.deepEqual(trace.loadedResources, [external]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, enc(externalCss).byteLength);
  assert.equal(trace.stylesheetCount, 3, "UA sheet + external author sheet + inline author sheet");
  assert.equal(trace.authorStylesheetCount, 2);
  assert.equal(trace.authorRuleCount, 2);
  assert.equal(trace.authorDeclarationCount, 4);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(trace.paintOps.includes("rect"), "external and inline author sheets participate in the cascade");

  const image = decodePng(result.png);
  const i = (10 * image.width + 10) * 4;
  assert.equal(image.data[i], 0, "later inline style wins the background red channel");
  assert.equal(image.data[i + 1], 0);
  assert.equal(image.data[i + 2], 255, "later inline style wins the background blue channel");
});

void test("renderUrlToPng lets a later external stylesheet override an earlier inline style", async () => {
  const base = "https://site.test/index.html";
  const external = "https://site.test/late.css";
  const externalCss = "div { background-color: rgb(0, 0, 255) }";
  const html =
    "<html><head><style>div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }</style>" +
    '<link rel="stylesheet" href="/late.css"></head><body><div></div></body></html>';
  const calls: string[] = [];
  const resources = new Map<string, Uint8Array>([
    [base, enc(html)],
    [external, enc(externalCss)],
  ]);

  const result = await renderUrlToPng(
    base,
    (url) => {
      calls.push(url);
      return Promise.resolve(resources.get(url));
    },
    { trace: true },
  );
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  assert.deepEqual(calls, [base, external]);
  assert.equal(calls.filter((url) => url === external).length, 1, "external stylesheet is fetched exactly once");
  assert.deepEqual(trace.discoveredResources, [external]);
  assert.deepEqual(trace.loadedResources, [external]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, enc(externalCss).byteLength);
  assert.equal(trace.stylesheetCount, 3, "UA sheet + inline author sheet + external author sheet");
  assert.equal(trace.authorStylesheetCount, 2);
  assert.equal(trace.authorRuleCount, 2);
  assert.equal(trace.authorDeclarationCount, 4);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(trace.paintOps.includes("rect"), "inline and external author sheets participate in the cascade");

  const image = decodePng(result.png);
  const i = (10 * image.width + 10) * 4;
  assert.equal(image.data[i], 0, "later external stylesheet wins the background red channel");
  assert.equal(image.data[i + 1], 0);
  assert.equal(image.data[i + 2], 255, "later external stylesheet wins the background blue channel");
});

void test("renderUrlToPng skips non-CSS data: stylesheet media without network fetches or fake author rules", async () => {
  const base = "https://site.test/index.html";
  const css = "div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }";
  const html =
    `<html><head><link rel="stylesheet" href="data:text/plain,${encodeURIComponent(css)}"></head>` +
    "<body><div>after</div></body></html>";
  const calls: string[] = [];

  const result = await renderUrlToPng(
    base,
    (url) => {
      calls.push(url);
      return Promise.resolve(url === base ? enc(html) : undefined);
    },
    { trace: true },
  );
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  assert.deepEqual(calls, [base]);
  assert.deepEqual(trace.discoveredResources, []);
  assert.deepEqual(trace.loadedResources, []);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, 0);
  assert.equal(trace.stylesheetCount, 1, "only the UA stylesheet is present");
  assert.equal(trace.authorStylesheetCount, 0, "non-CSS data: stylesheet is not an author sheet");
  assert.equal(trace.authorRuleCount, 0);
  assert.equal(trace.authorDeclarationCount, 0);
  assert.equal(trace.decodedImageCount, 0);
  assert.equal(trace.imagePaintCount, 0);
  assert.ok(!trace.paintOps.includes("rect"), "non-CSS data: payload does not apply CSS-looking background");
  assert.ok(trace.paintOps.includes("text"), "the rest of the page still renders visible text");
  assert.ok(trace.displayCommands > 0);
  assert.ok(result.png.length > 0, "rendering continues despite the skipped non-CSS data stylesheet");
});

void test("renderUrlToPng reports an invalid data: stylesheet without subresource fetches or fake author declarations", async () => {
  const base = "https://site.test/index.html";
  const css = "div { width: bogus; height: nope; background-color: definitely-not-a-color }";
  const html =
    `<html><head><link rel="stylesheet" href="data:text/css,${encodeURIComponent(css)}"></head>` +
    "<body><div>after</div></body></html>";
  const calls: string[] = [];

  const result = await renderUrlToPng(
    base,
    (url) => {
      calls.push(url);
      return Promise.resolve(url === base ? enc(html) : undefined);
    },
    { trace: true },
  );
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  assert.deepEqual(calls, [base]);
  assert.deepEqual(trace.discoveredResources, []);
  assert.deepEqual(trace.loadedResources, []);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, 0);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + parsed-but-empty inline data: author sheet");
  assert.equal(trace.authorStylesheetCount, 1, "inline data: stylesheet is a real author sheet");
  assert.equal(trace.authorRuleCount, 1, "the selector may survive recovery");
  assert.equal(trace.authorDeclarationCount, 0, "invalid declarations do not enter the cascade");
  assert.equal(trace.decodedImageCount, 0);
  assert.equal(trace.imagePaintCount, 0);
  assert.ok(!trace.paintOps.includes("rect"), "invalid data: CSS does not synthesize a background rule");
  assert.ok(trace.paintOps.includes("text"), "the rest of the page still renders visible text");
  assert.ok(trace.displayCommands > 0);
  assert.ok(result.png.length > 0, "rendering continues despite invalid inline data CSS");
});

void test("renderUrlToPng reports an invalid data: image without subresource fetches or fake paint", async () => {
  const base = "https://site.test/index.html";
  const html =
    '<html><head><style>div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }</style></head>' +
    '<body><img src="data:image/png;base64,not-a-real-png"><div>after</div></body></html>';
  const calls: string[] = [];

  const result = await renderUrlToPng(
    base,
    (url) => {
      calls.push(url);
      return Promise.resolve(url === base ? enc(html) : undefined);
    },
    { trace: true },
  );
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  assert.deepEqual(calls, [base]);
  assert.deepEqual(trace.discoveredResources, []);
  assert.deepEqual(trace.loadedResources, []);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, 0);
  assert.equal(trace.decodedImageCount, 0, "invalid inline data: image is not decoded");
  assert.equal(trace.imagePaintCount, 0, "invalid inline data: image paints no image commands");
  assert.ok(!trace.paintOps.includes("image"), "invalid inline data: image does not synthesize an image paint op");
  assert.ok(trace.paintOps.includes("rect"), "the rest of the page still renders");
  assert.ok(trace.displayCommands > 0);
});

void test("renderUrlToPng trace reports a missing stylesheet without applying fake author rules", async () => {
  const base = "https://site.test/index.html";
  const html =
    '<html><head><link rel="stylesheet" href="/missing.css"></head>' +
    "<body><div>after</div></body></html>";
  const map = new Map<string, Uint8Array>([[base, enc(html)]]);

  const result = await renderUrlToPng(base, mockFetch(map), { trace: true });
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");
  assert.deepEqual(trace.discoveredResources, ["https://site.test/missing.css"]);
  assert.deepEqual(trace.loadedResources, []);
  assert.deepEqual(trace.missingResources, ["https://site.test/missing.css"]);
  assert.equal(trace.loadedBytes, 0);
  assert.equal(trace.stylesheetCount, 1, "only the UA stylesheet is present");
  assert.equal(trace.authorStylesheetCount, 0);
  assert.equal(trace.authorRuleCount, 0);
  assert.equal(trace.authorDeclarationCount, 0);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(!trace.paintOps.includes("rect"), "missing CSS does not synthesize a background rule");
  assert.ok(trace.displayCommands > 0, "the rest of the page still renders");
  assert.ok(result.png.length > 0, "rendering continues despite the missing stylesheet");
});

void test("renderUrlToPng ignores stylesheet links with no href without applying fake author rules", async () => {
  const base = "https://site.test/index.html";
  const html = '<html><head><link rel="stylesheet"></head><body><div>after</div></body></html>';
  const calls: string[] = [];

  const result = await renderUrlToPng(
    base,
    (url) => {
      calls.push(url);
      return Promise.resolve(url === base ? enc(html) : undefined);
    },
    { trace: true },
  );
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  assert.deepEqual(calls, [base]);
  assert.deepEqual(trace.discoveredResources, []);
  assert.deepEqual(trace.loadedResources, []);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, 0);
  assert.equal(trace.stylesheetCount, 1, "only the UA stylesheet is present");
  assert.equal(trace.authorStylesheetCount, 0);
  assert.equal(trace.authorRuleCount, 0);
  assert.equal(trace.authorDeclarationCount, 0);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(!trace.paintOps.includes("rect"), "missing href does not synthesize a background rule");
  assert.ok(trace.paintOps.includes("text"), "the rest of the page still renders visible text");
  assert.ok(trace.displayCommands > 0);
  assert.ok(result.png.length > 0, "rendering continues with the href-less stylesheet skipped");
});

void test("renderUrlToPng still loads a normal stylesheet beside a no-href stylesheet link", async () => {
  const base = "https://site.test/index.html";
  const html =
    '<html><head><link rel="stylesheet"><link rel="stylesheet" href="/theme.css"></head>' +
    "<body><div>after</div></body></html>";
  const css = "div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }";
  const calls: string[] = [];
  const resources = new Map<string, Uint8Array>([
    [base, enc(html)],
    ["https://site.test/theme.css", enc(css)],
  ]);

  const result = await renderUrlToPng(
    base,
    (url) => {
      calls.push(url);
      return Promise.resolve(resources.get(url));
    },
    { trace: true },
  );
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  assert.deepEqual(calls, [base, "https://site.test/theme.css"]);
  assert.deepEqual(trace.discoveredResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.loadedResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, enc(css).byteLength);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + one normal author sheet");
  assert.equal(trace.authorStylesheetCount, 1, "no-href link does not add a fake author sheet");
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(trace.paintOps.includes("rect"), "normal stylesheet still applies beside the no-href guard");
  assert.ok(result.png.length > 0);
});

void test("renderUrlToPng treats empty stylesheet href as the document URL without fake declarations", async () => {
  const base = "https://site.test/index.html";
  const html =
    '<html><head><link rel="stylesheet" href=""></head>' +
    "<body><div>after</div></body></html>";
  const calls: string[] = [];

  const result = await renderUrlToPng(
    base,
    (url) => {
      calls.push(url);
      return Promise.resolve(url === base ? enc(html) : undefined);
    },
    { trace: true },
  );
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  assert.deepEqual(calls, [base, base], "empty href resolves to the root document URL and is fetched as a subresource");
  assert.deepEqual(trace.discoveredResources, [base]);
  assert.deepEqual(trace.loadedResources, [base]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, enc(html).byteLength);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + parsed root bytes as an author sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorDeclarationCount, 0, "HTML bytes loaded via href='' do not create author declarations");
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(!trace.paintOps.includes("rect"), "HTML bytes loaded as CSS do not synthesize a background rule");
  assert.ok(trace.paintOps.includes("text"), "the rest of the page still renders visible text");
  assert.ok(trace.displayCommands > 0);
  assert.ok(result.png.length > 0, "rendering continues with the empty-href stylesheet loaded");
});

void test("renderUrlToPng still loads a normal stylesheet beside an empty href stylesheet link", async () => {
  const base = "https://site.test/index.html";
  const html =
    '<html><head><link rel="stylesheet" href=""><link rel="stylesheet" href="/theme.css"></head>' +
    "<body><div>after</div></body></html>";
  const css = "div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }";
  const calls: string[] = [];
  const resources = new Map<string, Uint8Array>([
    [base, enc(html)],
    ["https://site.test/theme.css", enc(css)],
  ]);

  const result = await renderUrlToPng(
    base,
    (url) => {
      calls.push(url);
      return Promise.resolve(resources.get(url));
    },
    { trace: true },
  );
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  assert.deepEqual(calls, [base, base, "https://site.test/theme.css"]);
  assert.deepEqual(trace.discoveredResources, [base, "https://site.test/theme.css"].sort());
  assert.deepEqual(trace.loadedResources, [base, "https://site.test/theme.css"].sort());
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, enc(html).byteLength + enc(css).byteLength);
  assert.equal(trace.stylesheetCount, 3, "UA sheet + empty-href author sheet + normal author sheet");
  assert.equal(trace.authorStylesheetCount, 2);
  assert.equal(trace.authorDeclarationCount, 3, "only the normal stylesheet contributes declarations");
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(trace.paintOps.includes("rect"), "normal stylesheet still applies beside the empty-href guard");
  assert.ok(result.png.length > 0);
});

void test("renderUrlToPng treats fragment-only stylesheet href as the document URL plus fragment without fake declarations", async () => {
  const base = "https://site.test/index.html";
  const fragment = `${base}#sheet`;
  const html =
    '<html><head><link rel="stylesheet" href="#sheet"></head>' +
    "<body><div>after</div></body></html>";
  const calls: string[] = [];

  const result = await renderUrlToPng(
    base,
    (url) => {
      calls.push(url);
      return Promise.resolve(url === base || url === fragment ? enc(html) : undefined);
    },
    { trace: true },
  );
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  assert.deepEqual(calls, [base, fragment], "fragment href resolves to the document URL with the fragment preserved");
  assert.deepEqual(trace.discoveredResources, [fragment]);
  assert.deepEqual(trace.loadedResources, [fragment]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, enc(html).byteLength);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + parsed fragment resource bytes as an author sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 0);
  assert.equal(trace.authorDeclarationCount, 0, "HTML bytes loaded via href='#sheet' do not create author declarations");
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(!trace.paintOps.includes("rect"), "HTML bytes loaded as CSS do not synthesize a background rule");
  assert.ok(trace.paintOps.includes("text"), "the rest of the page still renders visible text");
  assert.ok(trace.displayCommands > 0);
  assert.ok(result.png.length > 0, "rendering continues with the fragment-href stylesheet loaded");
});

void test("renderUrlToPng still loads a normal stylesheet beside a fragment-only stylesheet link", async () => {
  const base = "https://site.test/index.html";
  const fragment = `${base}#sheet`;
  const html =
    '<html><head><link rel="stylesheet" href="#sheet"><link rel="stylesheet" href="/theme.css"></head>' +
    "<body><div>after</div></body></html>";
  const css = "div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }";
  const calls: string[] = [];
  const resources = new Map<string, Uint8Array>([
    [base, enc(html)],
    [fragment, enc(html)],
    ["https://site.test/theme.css", enc(css)],
  ]);

  const result = await renderUrlToPng(
    base,
    (url) => {
      calls.push(url);
      return Promise.resolve(resources.get(url));
    },
    { trace: true },
  );
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  assert.deepEqual(calls, [base, fragment, "https://site.test/theme.css"]);
  assert.deepEqual(trace.discoveredResources, [fragment, "https://site.test/theme.css"].sort());
  assert.deepEqual(trace.loadedResources, [fragment, "https://site.test/theme.css"].sort());
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, enc(html).byteLength + enc(css).byteLength);
  assert.equal(trace.stylesheetCount, 3, "UA sheet + fragment-href author sheet + normal author sheet");
  assert.equal(trace.authorStylesheetCount, 2);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3, "only the normal stylesheet contributes declarations");
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(trace.paintOps.includes("rect"), "normal stylesheet still applies beside the fragment-href guard");
  assert.ok(result.png.length > 0);
});

void test("renderUrlToPng treats query-only stylesheet href as the document URL with a replacement query", async () => {
  const base = "https://site.test/path/index.html?old=1#frag";
  const queryUrl = "https://site.test/path/index.html?sheet";
  const html =
    '<html><head><link rel="stylesheet" href="?sheet"></head>' +
    "<body><div>after</div></body></html>";
  const calls: string[] = [];

  const result = await renderUrlToPng(
    base,
    (url) => {
      calls.push(url);
      return Promise.resolve(url === base || url === queryUrl ? enc(html) : undefined);
    },
    { trace: true },
  );
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  assert.deepEqual(calls, [base, queryUrl], "query-only href replaces the base query and clears the fragment");
  assert.deepEqual(trace.discoveredResources, [queryUrl]);
  assert.deepEqual(trace.loadedResources, [queryUrl]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, enc(html).byteLength);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + parsed query resource bytes as an author sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 0);
  assert.equal(trace.authorDeclarationCount, 0, "HTML bytes loaded via href='?sheet' do not create author declarations");
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(!trace.paintOps.includes("rect"), "HTML bytes loaded as CSS do not synthesize a background rule");
  assert.ok(trace.paintOps.includes("text"), "the rest of the page still renders visible text");
  assert.ok(trace.displayCommands > 0);
  assert.ok(result.png.length > 0, "rendering continues with the query-only stylesheet loaded");
});

void test("renderUrlToPng still loads a normal stylesheet beside a query-only stylesheet link", async () => {
  const base = "https://site.test/path/index.html?old=1#frag";
  const queryUrl = "https://site.test/path/index.html?sheet";
  const html =
    '<html><head><link rel="stylesheet" href="?sheet"><link rel="stylesheet" href="/theme.css"></head>' +
    "<body><div>after</div></body></html>";
  const css = "div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }";
  const calls: string[] = [];
  const resources = new Map<string, Uint8Array>([
    [base, enc(html)],
    [queryUrl, enc(html)],
    ["https://site.test/theme.css", enc(css)],
  ]);

  const result = await renderUrlToPng(
    base,
    (url) => {
      calls.push(url);
      return Promise.resolve(resources.get(url));
    },
    { trace: true },
  );
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  assert.deepEqual(calls, [base, queryUrl, "https://site.test/theme.css"]);
  assert.deepEqual(trace.discoveredResources, [queryUrl, "https://site.test/theme.css"].sort());
  assert.deepEqual(trace.loadedResources, [queryUrl, "https://site.test/theme.css"].sort());
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, enc(html).byteLength + enc(css).byteLength);
  assert.equal(trace.stylesheetCount, 3, "UA sheet + query-only author sheet + normal author sheet");
  assert.equal(trace.authorStylesheetCount, 2);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3, "only the normal stylesheet contributes declarations");
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(trace.paintOps.includes("rect"), "normal stylesheet still applies beside the query-only guard");
  assert.ok(result.png.length > 0);
});

void test("renderUrlToPng resolves protocol-relative stylesheet href against the document scheme", async () => {
  const base = "https://site.test/index.html";
  const cdn = "https://cdn.test/theme.css";
  const html =
    '<html><head><link rel="stylesheet" href="//cdn.test/theme.css"></head>' +
    "<body><div></div></body></html>";
  const css = "div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }";
  const calls: string[] = [];
  const resources = new Map<string, Uint8Array>([
    [base, enc(html)],
    [cdn, enc(css)],
  ]);

  const result = await renderUrlToPng(
    base,
    (url) => {
      calls.push(url);
      return Promise.resolve(resources.get(url));
    },
    { trace: true },
  );
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  assert.deepEqual(calls, [base, cdn], "protocol-relative href inherits the document scheme");
  assert.deepEqual(trace.discoveredResources, [cdn]);
  assert.deepEqual(trace.loadedResources, [cdn]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, enc(css).byteLength);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + protocol-relative author sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(trace.paintOps.includes("rect"), "protocol-relative stylesheet applies real author CSS");
  assert.ok(result.png.length > 0);
});

void test("renderUrlToPng preserves source order with protocol-relative and relative stylesheets", async () => {
  const base = "https://site.test/index.html";
  const cdn = "https://cdn.test/theme.css";
  const relative = "https://site.test/local.css";
  const html =
    '<html><head><link rel="stylesheet" href="//cdn.test/theme.css">' +
    '<link rel="stylesheet" href="/local.css"></head><body><div></div></body></html>';
  const cdnCss = "div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }";
  const localCss = "div { background-color: rgb(0, 0, 255) }";
  const calls: string[] = [];
  const resources = new Map<string, Uint8Array>([
    [base, enc(html)],
    [cdn, enc(cdnCss)],
    [relative, enc(localCss)],
  ]);

  const result = await renderUrlToPng(
    base,
    (url) => {
      calls.push(url);
      return Promise.resolve(resources.get(url));
    },
    { trace: true },
  );
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  assert.deepEqual(calls, [base, cdn, relative]);
  assert.deepEqual(trace.discoveredResources, [cdn, relative].sort());
  assert.deepEqual(trace.loadedResources, [cdn, relative].sort());
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, enc(cdnCss).byteLength + enc(localCss).byteLength);
  assert.equal(trace.stylesheetCount, 3, "UA sheet + protocol-relative author sheet + relative author sheet");
  assert.equal(trace.authorStylesheetCount, 2);
  assert.equal(trace.authorRuleCount, 2);
  assert.equal(trace.authorDeclarationCount, 4);
  assert.ok(trace.paintOps.includes("rect"), "both stylesheets participate in the cascade");

  const image = decodePng(result.png);
  const i = (10 * image.width + 10) * 4;
  assert.equal(image.data[i], 0, "later relative stylesheet wins the background red channel");
  assert.equal(image.data[i + 1], 0);
  assert.equal(image.data[i + 2], 255, "later relative stylesheet wins the background blue channel");
});

void test("renderUrlToPng accepts ASCII-whitespace separated stylesheet rel tokens", async () => {
  const base = "https://site.test/index.html";
  const html =
    '<html><head><link rel=" preload\tstylesheet\n " href="/theme.css"></head>' +
    "<body><div></div></body></html>";
  const css = "div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }";
  const calls: string[] = [];
  const resources = new Map<string, Uint8Array>([
    [base, enc(html)],
    ["https://site.test/theme.css", enc(css)],
  ]);

  const result = await renderUrlToPng(
    base,
    (url) => {
      calls.push(url);
      return Promise.resolve(resources.get(url));
    },
    { trace: true },
  );
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  assert.deepEqual(calls, [base, "https://site.test/theme.css"]);
  assert.deepEqual(trace.discoveredResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.loadedResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, enc(css).byteLength);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + whitespace-separated author sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(trace.paintOps.includes("rect"), "whitespace-separated rel stylesheet applies real CSS");
  assert.ok(result.png.length > 0);
});

void test("renderUrlToPng treats mixed-case stylesheet rel tokens as active", async () => {
  const base = "https://site.test/index.html";
  const html =
    '<html><head><link rel="preload\tStyleSheet\n" href="/theme.css"></head>' +
    "<body><div></div></body></html>";
  const css = "div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }";
  const resources = new Map<string, Uint8Array>([
    [base, enc(html)],
    ["https://site.test/theme.css", enc(css)],
  ]);

  const result = await renderUrlToPng(base, mockFetch(resources), { trace: true });
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  assert.deepEqual(trace.discoveredResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.loadedResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + mixed-case rel author sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.ok(trace.paintOps.includes("rect"), "mixed-case rel stylesheet applies real CSS");
});

void test("renderUrlToPng keeps whitespace-separated alternate stylesheet rel inactive", async () => {
  const base = "https://site.test/index.html";
  const html =
    '<html><head><link rel=" alternate\tstylesheet\n " href="/theme.css"></head>' +
    "<body><div>after</div></body></html>";
  const css = "div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }";
  const calls: string[] = [];
  const resources = new Map<string, Uint8Array>([
    [base, enc(html)],
    ["https://site.test/theme.css", enc(css)],
  ]);

  const result = await renderUrlToPng(
    base,
    (url) => {
      calls.push(url);
      return Promise.resolve(resources.get(url));
    },
    { trace: true },
  );
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  assert.deepEqual(calls, [base]);
  assert.deepEqual(trace.discoveredResources, []);
  assert.deepEqual(trace.loadedResources, []);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, 0);
  assert.equal(trace.stylesheetCount, 1, "only the UA stylesheet is active");
  assert.equal(trace.authorStylesheetCount, 0, "alternate token remains inactive by default");
  assert.equal(trace.authorRuleCount, 0);
  assert.equal(trace.authorDeclarationCount, 0);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(!trace.paintOps.includes("rect"), "inactive alternate CSS does not paint a background");
  assert.ok(trace.paintOps.includes("text"), "the rest of the page still renders visible text");
  assert.ok(result.png.length > 0);
});

void test("renderUrlToPng preserves source order with whitespace-heavy rel and normal stylesheets", async () => {
  const base = "https://site.test/index.html";
  const early = "https://site.test/early.css";
  const late = "https://site.test/late.css";
  const html =
    '<html><head><link rel=" preload\tstylesheet\n " href="/early.css">' +
    '<link rel="stylesheet" href="/late.css"></head><body><div></div></body></html>';
  const earlyCss = "div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }";
  const lateCss = "div { background-color: rgb(0, 0, 255) }";
  const calls: string[] = [];
  const resources = new Map<string, Uint8Array>([
    [base, enc(html)],
    [early, enc(earlyCss)],
    [late, enc(lateCss)],
  ]);

  const result = await renderUrlToPng(
    base,
    (url) => {
      calls.push(url);
      return Promise.resolve(resources.get(url));
    },
    { trace: true },
  );
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  assert.deepEqual(calls, [base, early, late]);
  assert.deepEqual(trace.discoveredResources, [early, late]);
  assert.deepEqual(trace.loadedResources, [early, late]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, enc(earlyCss).byteLength + enc(lateCss).byteLength);
  assert.equal(trace.stylesheetCount, 3, "UA sheet + whitespace-heavy rel sheet + normal sheet");
  assert.equal(trace.authorStylesheetCount, 2);
  assert.equal(trace.authorRuleCount, 2);
  assert.equal(trace.authorDeclarationCount, 4);
  assert.ok(trace.paintOps.includes("rect"), "both stylesheets participate in the cascade");

  const image = decodePng(result.png);
  const i = (10 * image.width + 10) * 4;
  assert.equal(image.data[i], 0, "later normal stylesheet wins the background red channel");
  assert.equal(image.data[i + 1], 0);
  assert.equal(image.data[i + 2], 255, "later normal stylesheet wins the background blue channel");
});

void test("renderUrlToPng accepts duplicate stylesheet rel tokens without duplicate fetches or cascade slots", async () => {
  const base = "https://site.test/index.html";
  const html =
    '<html><head><link rel="stylesheet stylesheet" href="/theme.css"></head>' +
    "<body><div></div></body></html>";
  const css = "div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }";
  const calls: string[] = [];
  const resources = new Map<string, Uint8Array>([
    [base, enc(html)],
    ["https://site.test/theme.css", enc(css)],
  ]);

  const result = await renderUrlToPng(
    base,
    (url) => {
      calls.push(url);
      return Promise.resolve(resources.get(url));
    },
    { trace: true },
  );
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  assert.deepEqual(calls, [base, "https://site.test/theme.css"]);
  assert.deepEqual(trace.discoveredResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.loadedResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, enc(css).byteLength);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + one duplicate-rel author sheet");
  assert.equal(trace.authorStylesheetCount, 1, "duplicate rel token does not create a second author sheet");
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(trace.paintOps.includes("rect"), "duplicate-rel stylesheet applies real CSS");
  assert.ok(result.png.length > 0);
});

void test("renderUrlToPng keeps duplicate-token alternate stylesheet rel inactive", async () => {
  const base = "https://site.test/index.html";
  const html =
    '<html><head><link rel="alternate stylesheet stylesheet" href="/theme.css"></head>' +
    "<body><div>after</div></body></html>";
  const css = "div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }";
  const calls: string[] = [];
  const resources = new Map<string, Uint8Array>([
    [base, enc(html)],
    ["https://site.test/theme.css", enc(css)],
  ]);

  const result = await renderUrlToPng(
    base,
    (url) => {
      calls.push(url);
      return Promise.resolve(resources.get(url));
    },
    { trace: true },
  );
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  assert.deepEqual(calls, [base]);
  assert.deepEqual(trace.discoveredResources, []);
  assert.deepEqual(trace.loadedResources, []);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, 0);
  assert.equal(trace.stylesheetCount, 1, "only the UA stylesheet is active");
  assert.equal(trace.authorStylesheetCount, 0, "alternate token remains inactive despite duplicates");
  assert.equal(trace.authorRuleCount, 0);
  assert.equal(trace.authorDeclarationCount, 0);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(!trace.paintOps.includes("rect"), "inactive duplicate-token alternate CSS does not paint a background");
  assert.ok(trace.paintOps.includes("text"), "the rest of the page still renders visible text");
  assert.ok(result.png.length > 0);
});

void test("renderUrlToPng preserves source order with duplicate-rel and normal stylesheets", async () => {
  const base = "https://site.test/index.html";
  const early = "https://site.test/early.css";
  const late = "https://site.test/late.css";
  const html =
    '<html><head><link rel="stylesheet stylesheet" href="/early.css">' +
    '<link rel="stylesheet" href="/late.css"></head><body><div></div></body></html>';
  const earlyCss = "div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }";
  const lateCss = "div { background-color: rgb(0, 0, 255) }";
  const calls: string[] = [];
  const resources = new Map<string, Uint8Array>([
    [base, enc(html)],
    [early, enc(earlyCss)],
    [late, enc(lateCss)],
  ]);

  const result = await renderUrlToPng(
    base,
    (url) => {
      calls.push(url);
      return Promise.resolve(resources.get(url));
    },
    { trace: true },
  );
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  assert.deepEqual(calls, [base, early, late]);
  assert.deepEqual(trace.discoveredResources, [early, late]);
  assert.deepEqual(trace.loadedResources, [early, late]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, enc(earlyCss).byteLength + enc(lateCss).byteLength);
  assert.equal(trace.stylesheetCount, 3, "UA sheet + duplicate-rel sheet + normal sheet");
  assert.equal(trace.authorStylesheetCount, 2, "duplicate rel token does not add extra cascade slots");
  assert.equal(trace.authorRuleCount, 2);
  assert.equal(trace.authorDeclarationCount, 4);
  assert.ok(trace.paintOps.includes("rect"), "both stylesheets participate in the cascade");

  const image = decodePng(result.png);
  const i = (10 * image.width + 10) * 4;
  assert.equal(image.data[i], 0, "later normal stylesheet wins the background red channel");
  assert.equal(image.data[i + 1], 0);
  assert.equal(image.data[i + 2], 255, "later normal stylesheet wins the background blue channel");
});

void test("renderUrlToPng trims stylesheet href attribute whitespace through URL resolution", async () => {
  const base = "https://site.test/index.html";
  const resolved = "https://site.test/theme.css";
  const html =
    '<html><head><link rel="stylesheet" href=" /theme.css "></head>' +
    "<body><div></div></body></html>";
  const css = "div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }";
  const calls: string[] = [];
  const resources = new Map<string, Uint8Array>([
    [base, enc(html)],
    [resolved, enc(css)],
  ]);

  const result = await renderUrlToPng(
    base,
    (url) => {
      calls.push(url);
      return Promise.resolve(resources.get(url));
    },
    { trace: true },
  );
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  assert.deepEqual(calls, [base, resolved], "fetch sees the URL parser's resolved URL, not raw href whitespace");
  assert.deepEqual(trace.discoveredResources, [resolved]);
  assert.deepEqual(trace.loadedResources, [resolved]);
  assert.deepEqual(trace.missingResources, []);
  assert.ok(!trace.discoveredResources.includes(" /theme.css "), "trace does not report raw whitespace href text");
  assert.equal(trace.loadedBytes, enc(css).byteLength);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + whitespace-trimmed author sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(trace.paintOps.includes("rect"), "whitespace-trimmed href stylesheet applies real CSS");
  assert.ok(result.png.length > 0);
});

void test("renderUrlToPng resolves stylesheet href control characters through the URL parser", async () => {
  const base = "https://site.test/index.html";
  const resolved = "https://site.test/theme.css";
  const rawHref = "\n\t/theme.css\f";
  const html =
    `<html><head><link rel="stylesheet" href="${rawHref}"></head>` +
    "<body><div></div></body></html>";
  const css = "div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }";
  const calls: string[] = [];
  const resources = new Map<string, Uint8Array>([
    [base, enc(html)],
    [resolved, enc(css)],
  ]);

  const result = await renderUrlToPng(
    base,
    (url) => {
      calls.push(url);
      return Promise.resolve(resources.get(url));
    },
    { trace: true },
  );
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  assert.deepEqual(calls, [base, resolved], "fetch sees the canonical URL, not the raw control-character href");
  assert.deepEqual(trace.discoveredResources, [resolved]);
  assert.deepEqual(trace.loadedResources, [resolved]);
  assert.deepEqual(trace.missingResources, []);
  assert.ok(!trace.discoveredResources.includes(rawHref), "trace does not report raw control-character href text");
  assert.equal(trace.loadedBytes, enc(css).byteLength);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + control-character href author sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(trace.paintOps.includes("rect"), "control-character href stylesheet applies real CSS");
  assert.ok(result.png.length > 0);
});

void test("renderUrlToPng preserves source order with whitespace href and normal stylesheets", async () => {
  const base = "https://site.test/index.html";
  const early = "https://site.test/early.css";
  const late = "https://site.test/late.css";
  const html =
    '<html><head><link rel="stylesheet" href=" /early.css ">' +
    '<link rel="stylesheet" href="/late.css"></head><body><div></div></body></html>';
  const earlyCss = "div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }";
  const lateCss = "div { background-color: rgb(0, 0, 255) }";
  const calls: string[] = [];
  const resources = new Map<string, Uint8Array>([
    [base, enc(html)],
    [early, enc(earlyCss)],
    [late, enc(lateCss)],
  ]);

  const result = await renderUrlToPng(
    base,
    (url) => {
      calls.push(url);
      return Promise.resolve(resources.get(url));
    },
    { trace: true },
  );
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  assert.deepEqual(calls, [base, early, late]);
  assert.deepEqual(trace.discoveredResources, [early, late]);
  assert.deepEqual(trace.loadedResources, [early, late]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, enc(earlyCss).byteLength + enc(lateCss).byteLength);
  assert.equal(trace.stylesheetCount, 3, "UA sheet + whitespace-href sheet + normal sheet");
  assert.equal(trace.authorStylesheetCount, 2);
  assert.equal(trace.authorRuleCount, 2);
  assert.equal(trace.authorDeclarationCount, 4);
  assert.ok(trace.paintOps.includes("rect"), "both stylesheets participate in the cascade");

  const image = decodePng(result.png);
  const i = (10 * image.width + 10) * 4;
  assert.equal(image.data[i], 0, "later normal stylesheet wins the background red channel");
  assert.equal(image.data[i + 1], 0);
  assert.equal(image.data[i + 2], 255, "later normal stylesheet wins the background blue channel");
});

void test("renderUrlToPng preserves source order with control-character href and normal stylesheets", async () => {
  const base = "https://site.test/index.html";
  const early = "https://site.test/early.css";
  const late = "https://site.test/late.css";
  const html =
    '<html><head><link rel="stylesheet" href="\n\t/early.css\f">' +
    '<link rel="stylesheet" href="/late.css"></head><body><div></div></body></html>';
  const earlyCss = "div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }";
  const lateCss = "div { background-color: rgb(0, 0, 255) }";
  const calls: string[] = [];
  const resources = new Map<string, Uint8Array>([
    [base, enc(html)],
    [early, enc(earlyCss)],
    [late, enc(lateCss)],
  ]);

  const result = await renderUrlToPng(
    base,
    (url) => {
      calls.push(url);
      return Promise.resolve(resources.get(url));
    },
    { trace: true },
  );
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  assert.deepEqual(calls, [base, early, late]);
  assert.deepEqual(trace.discoveredResources, [early, late]);
  assert.deepEqual(trace.loadedResources, [early, late]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, enc(earlyCss).byteLength + enc(lateCss).byteLength);
  assert.equal(trace.stylesheetCount, 3, "UA sheet + control-character href sheet + normal sheet");
  assert.equal(trace.authorStylesheetCount, 2);
  assert.equal(trace.authorRuleCount, 2);
  assert.equal(trace.authorDeclarationCount, 4);
  assert.ok(trace.paintOps.includes("rect"), "both stylesheets participate in the cascade");

  const image = decodePng(result.png);
  const i = (10 * image.width + 10) * 4;
  assert.equal(image.data[i], 0, "later normal stylesheet wins the background red channel");
  assert.equal(image.data[i + 1], 0);
  assert.equal(image.data[i + 2], 255, "later normal stylesheet wins the background blue channel");
});

void test("renderUrlToPng skips invalid stylesheet href URLs without fake fetches or declarations", async () => {
  const base = "https://site.test/index.html";
  const html =
    '<html><head><link rel="stylesheet" href="http://bad.test:99999/theme.css"></head>' +
    "<body><div>after</div></body></html>";
  const calls: string[] = [];

  const result = await renderUrlToPng(
    base,
    (url) => {
      calls.push(url);
      return Promise.resolve(url === base ? enc(html) : undefined);
    },
    { trace: true },
  );
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  assert.deepEqual(calls, [base], "invalid stylesheet URL is not fetched as a subresource");
  assert.deepEqual(trace.discoveredResources, []);
  assert.deepEqual(trace.loadedResources, []);
  assert.deepEqual(trace.missingResources, [], "invalid URL is skipped before missing-resource accounting");
  assert.equal(trace.loadedBytes, 0);
  assert.equal(trace.stylesheetCount, 1, "only the UA stylesheet is active");
  assert.equal(trace.authorStylesheetCount, 0);
  assert.equal(trace.authorRuleCount, 0);
  assert.equal(trace.authorDeclarationCount, 0);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(!trace.paintOps.includes("rect"), "invalid URL does not synthesize author background CSS");
  assert.ok(trace.paintOps.includes("text"), "the rest of the page still renders visible text");
  assert.ok(result.png.length > 0);
});

void test("renderUrlToPng still loads normal stylesheets beside invalid stylesheet href URLs", async () => {
  const base = "https://site.test/index.html";
  const cssUrl = "https://site.test/theme.css";
  const html =
    '<html><head><style>div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }</style>' +
    '<link rel="stylesheet" href="http://bad.test:99999/theme.css">' +
    '<link rel="stylesheet" href="/theme.css"></head><body><div></div></body></html>';
  const css = "div { background-color: rgb(0, 0, 255) }";
  const calls: string[] = [];
  const resources = new Map<string, Uint8Array>([
    [base, enc(html)],
    [cssUrl, enc(css)],
  ]);

  const result = await renderUrlToPng(
    base,
    (url) => {
      calls.push(url);
      return Promise.resolve(resources.get(url));
    },
    { trace: true },
  );
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  assert.deepEqual(calls, [base, cssUrl]);
  assert.deepEqual(trace.discoveredResources, [cssUrl]);
  assert.deepEqual(trace.loadedResources, [cssUrl]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, enc(css).byteLength);
  assert.equal(trace.stylesheetCount, 3, "UA sheet + inline sheet + one normal external sheet");
  assert.equal(trace.authorStylesheetCount, 2, "invalid URL does not add an author sheet");
  assert.equal(trace.authorRuleCount, 2);
  assert.equal(trace.authorDeclarationCount, 4);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(trace.paintOps.includes("rect"), "normal stylesheet still applies beside the invalid href");

  const image = decodePng(result.png);
  const i = (10 * image.width + 10) * 4;
  assert.equal(image.data[i], 0, "later normal stylesheet wins the background red channel");
  assert.equal(image.data[i + 1], 0);
  assert.equal(image.data[i + 2], 255, "later normal stylesheet wins the background blue channel");
});

void test("renderUrlToPng trace reports an invalid external stylesheet load without fake author declarations", async () => {
  const base = "https://site.test/index.html";
  const html =
    '<html><head><link rel="stylesheet" href="/bad.css"></head>' +
    "<body><div>after</div></body></html>";
  const badCss = enc("div { width: bogus; height: nope; background-color: definitely-not-a-color }");
  const map = new Map<string, Uint8Array>([
    [base, enc(html)],
    ["https://site.test/bad.css", badCss],
  ]);

  const result = await renderUrlToPng(base, mockFetch(map), { trace: true });
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");
  assert.deepEqual(trace.discoveredResources, ["https://site.test/bad.css"]);
  assert.deepEqual(trace.loadedResources, ["https://site.test/bad.css"]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, badCss.byteLength, "invalid CSS bytes still loaded as a resource");
  assert.equal(trace.stylesheetCount, 2, "UA sheet + parsed-but-empty fetched author sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1, "the selector may survive parser recovery");
  assert.equal(trace.authorDeclarationCount, 0, "invalid external declarations do not enter the cascade");
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(!trace.paintOps.includes("rect"), "invalid external CSS does not synthesize a background rule");
  assert.ok(trace.paintOps.includes("text"), "the rest of the page still renders visible text");
  assert.ok(trace.displayCommands > 0);
  assert.ok(result.png.length > 0, "rendering continues despite invalid external CSS");
});

void test("renderUrlToPng skips alternate stylesheet links until stylesheet selection exists", async () => {
  const base = "https://site.test/index.html";
  const html =
    '<html><head><link rel="alternate stylesheet" href="/theme.css"></head>' +
    "<body><div>after</div></body></html>";
  const css = "div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }";
  const calls: string[] = [];
  const resources = new Map<string, Uint8Array>([
    [base, enc(html)],
    ["https://site.test/theme.css", enc(css)],
  ]);

  const result = await renderUrlToPng(
    base,
    (url) => {
      calls.push(url);
      return Promise.resolve(resources.get(url));
    },
    { trace: true },
  );
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  assert.deepEqual(calls, [base]);
  assert.deepEqual(trace.discoveredResources, []);
  assert.deepEqual(trace.loadedResources, []);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, 0);
  assert.equal(trace.stylesheetCount, 1, "only the UA stylesheet is active");
  assert.equal(trace.authorStylesheetCount, 0, "alternate stylesheet is not active by default");
  assert.equal(trace.authorRuleCount, 0);
  assert.equal(trace.authorDeclarationCount, 0);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(!trace.paintOps.includes("rect"), "inactive alternate CSS does not paint a background");
  assert.ok(trace.paintOps.includes("text"), "the rest of the page still renders visible text");
  assert.ok(trace.displayCommands > 0);
  assert.ok(result.png.length > 0, "rendering continues with the inactive alternate stylesheet skipped");
});

void test("renderUrlToPng still loads a normal stylesheet beside the alternate-link guard", async () => {
  const base = "https://site.test/index.html";
  const html =
    '<html><head><link rel="stylesheet" href="/theme.css"></head>' +
    "<body><div>after</div></body></html>";
  const css = "div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }";
  const resources = new Map<string, Uint8Array>([
    [base, enc(html)],
    ["https://site.test/theme.css", enc(css)],
  ]);

  const result = await renderUrlToPng(base, mockFetch(resources), { trace: true });
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  assert.deepEqual(trace.discoveredResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.loadedResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, enc(css).byteLength);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + active author sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.ok(trace.paintOps.includes("rect"), "normal stylesheet still applies");
});

void test("renderUrlToPng skips disabled stylesheet links until they are enabled", async () => {
  const base = "https://site.test/index.html";
  const html =
    '<html><head><link rel="stylesheet" disabled href="/theme.css"></head>' +
    "<body><div>after</div></body></html>";
  const css = "div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }";
  const calls: string[] = [];
  const resources = new Map<string, Uint8Array>([
    [base, enc(html)],
    ["https://site.test/theme.css", enc(css)],
  ]);

  const result = await renderUrlToPng(
    base,
    (url) => {
      calls.push(url);
      return Promise.resolve(resources.get(url));
    },
    { trace: true },
  );
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  assert.deepEqual(calls, [base]);
  assert.deepEqual(trace.discoveredResources, []);
  assert.deepEqual(trace.loadedResources, []);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, 0);
  assert.equal(trace.stylesheetCount, 1, "only the UA stylesheet is active");
  assert.equal(trace.authorStylesheetCount, 0, "disabled stylesheet is not active by default");
  assert.equal(trace.authorRuleCount, 0);
  assert.equal(trace.authorDeclarationCount, 0);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(!trace.paintOps.includes("rect"), "disabled CSS does not paint a background");
  assert.ok(trace.paintOps.includes("text"), "the rest of the page still renders visible text");
  assert.ok(trace.displayCommands > 0);
  assert.ok(result.png.length > 0, "rendering continues with the disabled stylesheet skipped");
});

void test("renderUrlToPng skips print-only stylesheets in the screen-like render environment", async () => {
  const base = "https://site.test/index.html";
  const html =
    '<html><head><link rel="stylesheet" media="print" href="/theme.css"></head>' +
    "<body><div>after</div></body></html>";
  const css = "div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }";
  const calls: string[] = [];
  const resources = new Map<string, Uint8Array>([
    [base, enc(html)],
    ["https://site.test/theme.css", enc(css)],
  ]);

  const result = await renderUrlToPng(
    base,
    (url) => {
      calls.push(url);
      return Promise.resolve(resources.get(url));
    },
    { trace: true },
  );
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  assert.deepEqual(calls, [base]);
  assert.deepEqual(trace.discoveredResources, []);
  assert.deepEqual(trace.loadedResources, []);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, 0);
  assert.equal(trace.stylesheetCount, 1, "only the UA stylesheet is active");
  assert.equal(trace.authorStylesheetCount, 0, "print-only stylesheet is not active for screen rendering");
  assert.equal(trace.authorRuleCount, 0);
  assert.equal(trace.authorDeclarationCount, 0);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(!trace.paintOps.includes("rect"), "print-only CSS does not paint a screen background");
  assert.ok(trace.paintOps.includes("text"), "the rest of the page still renders visible text");
  assert.ok(trace.displayCommands > 0);
  assert.ok(result.png.length > 0, "rendering continues with the print-only stylesheet skipped");
});

void test("renderUrlToPng still loads screen media stylesheets", async () => {
  const base = "https://site.test/index.html";
  const html =
    '<html><head><link rel="stylesheet" media="screen" href="/theme.css"></head>' +
    "<body><div>after</div></body></html>";
  const css = "div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }";
  const resources = new Map<string, Uint8Array>([
    [base, enc(html)],
    ["https://site.test/theme.css", enc(css)],
  ]);

  const result = await renderUrlToPng(base, mockFetch(resources), { trace: true });
  const trace = result.resourceTrace;
  assert.ok(trace !== undefined, "URL render trace must attach resource evidence");

  assert.deepEqual(trace.discoveredResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.loadedResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, enc(css).byteLength);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + screen author sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.ok(trace.paintOps.includes("rect"), "screen stylesheet still applies");
});

void test("renderUrlToPng treats empty stylesheet media as active", async () => {
  const { calls, cssBytes, trace } = await renderStylesheetMediaCase("");

  assert.deepEqual(calls, ["https://site.test/media-.html", "https://site.test/theme.css"]);
  assert.deepEqual(trace.discoveredResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.loadedResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, cssBytes);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + empty-media author sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.ok(trace.paintOps.includes("rect"), "empty media behaves like omitted media");
});

void test("renderUrlToPng treats whitespace-only stylesheet media as active", async () => {
  const { calls, cssBytes, trace } = await renderStylesheetMediaCase("   ");

  assert.deepEqual(calls, ["https://site.test/media-%20%20%20.html", "https://site.test/theme.css"]);
  assert.deepEqual(trace.discoveredResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.loadedResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, cssBytes);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + whitespace-only-media author sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.ok(trace.paintOps.includes("rect"), "whitespace-only media behaves like omitted media");
});

void test("renderUrlToPng treats stylesheet media as a list where one matching item activates", async () => {
  const { calls, cssBytes, trace } = await renderStylesheetMediaCase("print, screen");

  assert.deepEqual(calls, ["https://site.test/media-print%2C%20screen.html", "https://site.test/theme.css"]);
  assert.deepEqual(trace.discoveredResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.loadedResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, cssBytes);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + matching media-list author sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.ok(trace.paintOps.includes("rect"), "media list item matching screen applies the stylesheet");
});

void test("renderUrlToPng trims whitespace around stylesheet media-list separators", async () => {
  const { calls, cssBytes, trace } = await renderStylesheetMediaCase(" print , screen ");

  assert.equal(calls.length, 2);
  assert.equal(calls[1], "https://site.test/theme.css");
  assert.deepEqual(trace.discoveredResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.loadedResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, cssBytes);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + whitespace-trimmed matching media-list author sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.ok(trace.paintOps.includes("rect"), "whitespace around separators does not stop the screen item");
});

void test("renderUrlToPng ignores an empty media-list item before screen", async () => {
  const { calls, cssBytes, trace } = await renderStylesheetMediaCase(", screen");

  assert.deepEqual(calls, ["https://site.test/media-%2C%20screen.html", "https://site.test/theme.css"]);
  assert.deepEqual(trace.discoveredResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.loadedResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, cssBytes);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + non-empty screen list item");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.ok(trace.paintOps.includes("rect"), "screen item applies after an empty list item");
});

void test("renderUrlToPng ignores an empty media-list item after screen", async () => {
  const { calls, cssBytes, trace } = await renderStylesheetMediaCase("screen,");

  assert.deepEqual(calls, ["https://site.test/media-screen%2C.html", "https://site.test/theme.css"]);
  assert.deepEqual(trace.discoveredResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.loadedResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, cssBytes);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + leading screen list item");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.ok(trace.paintOps.includes("rect"), "screen item applies before an empty list item");
});

void test("renderUrlToPng keeps media lists with only empty items inactive", async () => {
  const { calls, pngBytes, trace } = await renderStylesheetMediaCase(",");

  assert.deepEqual(calls, ["https://site.test/media-%2C.html"]);
  assert.deepEqual(trace.discoveredResources, []);
  assert.deepEqual(trace.loadedResources, []);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, 0);
  assert.equal(trace.stylesheetCount, 1, "only the UA stylesheet is active");
  assert.equal(trace.authorStylesheetCount, 0);
  assert.equal(trace.authorRuleCount, 0);
  assert.equal(trace.authorDeclarationCount, 0);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(!trace.paintOps.includes("rect"), "empty-only media list does not apply");
  assert.ok(trace.paintOps.includes("text"), "the rest of the page still renders visible text");
  assert.ok(pngBytes > 0);
});

void test("renderUrlToPng ignores unsupported media-list items when a later item matches", async () => {
  const { calls, cssBytes, trace } = await renderStylesheetMediaCase("(dynamic-range: high), screen");

  assert.equal(calls.length, 2);
  assert.equal(calls[1], "https://site.test/theme.css");
  assert.deepEqual(trace.discoveredResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.loadedResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, cssBytes);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + later matching media-list author sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.ok(trace.paintOps.includes("rect"), "later screen list item applies despite the unsupported item");
});

void test("renderUrlToPng keeps unsupported single-item media lists inactive", async () => {
  const { calls, pngBytes, trace } = await renderStylesheetMediaCase("(dynamic-range: high)");

  assert.equal(calls.length, 1);
  assert.deepEqual(trace.discoveredResources, []);
  assert.deepEqual(trace.loadedResources, []);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, 0);
  assert.equal(trace.stylesheetCount, 1, "only the UA stylesheet is active");
  assert.equal(trace.authorStylesheetCount, 0);
  assert.equal(trace.authorRuleCount, 0);
  assert.equal(trace.authorDeclarationCount, 0);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(!trace.paintOps.includes("rect"), "unsupported single-item media list does not apply");
  assert.ok(trace.paintOps.includes("text"), "the rest of the page still renders visible text");
  assert.ok(pngBytes > 0);
});

void test("renderUrlToPng keeps unknown media types inactive", async () => {
  const { calls, pngBytes, trace } = await renderStylesheetMediaCase("projection");

  assert.deepEqual(calls, ["https://site.test/media-projection.html"]);
  assert.deepEqual(trace.discoveredResources, []);
  assert.deepEqual(trace.loadedResources, []);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, 0);
  assert.equal(trace.stylesheetCount, 1, "only the UA stylesheet is active");
  assert.equal(trace.authorStylesheetCount, 0);
  assert.equal(trace.authorRuleCount, 0);
  assert.equal(trace.authorDeclarationCount, 0);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(!trace.paintOps.includes("rect"), "unknown media type does not apply");
  assert.ok(trace.paintOps.includes("text"), "the rest of the page still renders visible text");
  assert.ok(pngBytes > 0);
});

void test("renderUrlToPng applies media lists with an unknown type followed by screen", async () => {
  const { calls, cssBytes, trace } = await renderStylesheetMediaCase("projection, screen");

  assert.deepEqual(calls, ["https://site.test/media-projection%2C%20screen.html", "https://site.test/theme.css"]);
  assert.deepEqual(trace.discoveredResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.loadedResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, cssBytes);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + later matching media-type list item");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.ok(trace.paintOps.includes("rect"), "later screen media type applies after an unknown type");
});

void test("renderUrlToPng treats uppercase screen media keywords as active", async () => {
  const { calls, cssBytes, trace } = await renderStylesheetMediaCase("SCREEN");

  assert.equal(calls.length, 2);
  assert.equal(calls[1], "https://site.test/theme.css");
  assert.deepEqual(trace.discoveredResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.loadedResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, cssBytes);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + uppercase screen author sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.ok(trace.paintOps.includes("rect"), "uppercase screen media keyword applies");
});

void test("renderUrlToPng treats mixed-case only screen media as active", async () => {
  const { calls, cssBytes, trace } = await renderStylesheetMediaCase("Only Screen");

  assert.equal(calls.length, 2);
  assert.equal(calls[1], "https://site.test/theme.css");
  assert.deepEqual(trace.discoveredResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.loadedResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, cssBytes);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + mixed-case only-screen author sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.ok(trace.paintOps.includes("rect"), "mixed-case only-screen media applies");
});

void test("renderUrlToPng tolerates whitespace after only stylesheet media modifiers", async () => {
  const { calls, cssBytes, trace } = await renderStylesheetMediaCase("only   screen");

  assert.equal(calls.length, 2);
  assert.equal(calls[1], "https://site.test/theme.css");
  assert.deepEqual(trace.discoveredResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.loadedResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, cssBytes);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + spaced only-screen author sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.ok(trace.paintOps.includes("rect"), "extra whitespace after only keeps screen media active");
});

void test("renderUrlToPng treats uppercase print media keywords as inactive for screen rendering", async () => {
  const { calls, pngBytes, trace } = await renderStylesheetMediaCase("PRINT");

  assert.equal(calls.length, 1);
  assert.deepEqual(trace.discoveredResources, []);
  assert.deepEqual(trace.loadedResources, []);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, 0);
  assert.equal(trace.stylesheetCount, 1, "only the UA stylesheet is active");
  assert.equal(trace.authorStylesheetCount, 0);
  assert.equal(trace.authorRuleCount, 0);
  assert.equal(trace.authorDeclarationCount, 0);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(!trace.paintOps.includes("rect"), "uppercase print media remains inactive for screen rendering");
  assert.ok(trace.paintOps.includes("text"), "the rest of the page still renders visible text");
  assert.ok(pngBytes > 0);
});

void test("renderUrlToPng applies all media stylesheets in the screen-like render environment", async () => {
  const { calls, cssBytes, trace } = await renderStylesheetMediaCase("all");

  assert.deepEqual(calls, ["https://site.test/media-all.html", "https://site.test/theme.css"]);
  assert.deepEqual(trace.discoveredResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.loadedResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, cssBytes);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + all-media author sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.ok(trace.paintOps.includes("rect"), "all media applies to the current render environment");
});

void test("renderUrlToPng applies only-all media stylesheets in the screen-like render environment", async () => {
  const { calls, cssBytes, trace } = await renderStylesheetMediaCase("only all");

  assert.deepEqual(calls, ["https://site.test/media-only%20all.html", "https://site.test/theme.css"]);
  assert.deepEqual(trace.discoveredResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.loadedResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, cssBytes);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + only-all author sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.ok(trace.paintOps.includes("rect"), "only all media applies to the current render environment");
});

void test("renderUrlToPng keeps not-all media stylesheets inactive", async () => {
  const { calls, pngBytes, trace } = await renderStylesheetMediaCase("not all");

  assert.deepEqual(calls, ["https://site.test/media-not%20all.html"]);
  assert.deepEqual(trace.discoveredResources, []);
  assert.deepEqual(trace.loadedResources, []);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, 0);
  assert.equal(trace.stylesheetCount, 1, "only the UA stylesheet is active");
  assert.equal(trace.authorStylesheetCount, 0);
  assert.equal(trace.authorRuleCount, 0);
  assert.equal(trace.authorDeclarationCount, 0);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(!trace.paintOps.includes("rect"), "not all media stays inactive");
  assert.ok(trace.paintOps.includes("text"), "the rest of the page still renders visible text");
  assert.ok(pngBytes > 0);
});

void test("renderUrlToPng keeps spaced not-all media stylesheets inactive", async () => {
  const { calls, pngBytes, trace } = await renderStylesheetMediaCase("not   all");

  assert.equal(calls.length, 1);
  assert.deepEqual(trace.discoveredResources, []);
  assert.deepEqual(trace.loadedResources, []);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, 0);
  assert.equal(trace.stylesheetCount, 1, "only the UA stylesheet is active");
  assert.equal(trace.authorStylesheetCount, 0);
  assert.equal(trace.authorRuleCount, 0);
  assert.equal(trace.authorDeclarationCount, 0);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(!trace.paintOps.includes("rect"), "spaced not-all remains inactive");
  assert.ok(trace.paintOps.includes("text"), "the rest of the page still renders visible text");
  assert.ok(pngBytes > 0);
});

void test("renderUrlToPng applies not-print media stylesheets in the screen-like render environment", async () => {
  const { calls, cssBytes, trace } = await renderStylesheetMediaCase("not print");

  assert.deepEqual(calls, ["https://site.test/media-not%20print.html", "https://site.test/theme.css"]);
  assert.deepEqual(trace.discoveredResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.loadedResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, cssBytes);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + not-print author sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.ok(trace.paintOps.includes("rect"), "not print matches the current screen-like environment");
});

void test("renderUrlToPng tolerates whitespace after not stylesheet media modifiers", async () => {
  const { calls, cssBytes, trace } = await renderStylesheetMediaCase("not   print");

  assert.equal(calls.length, 2);
  assert.equal(calls[1], "https://site.test/theme.css");
  assert.deepEqual(trace.discoveredResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.loadedResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, cssBytes);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + spaced not-print author sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.ok(trace.paintOps.includes("rect"), "extra whitespace after not keeps not-print active");
});

void test("renderUrlToPng skips only-print media stylesheets for screen rendering", async () => {
  const { calls, pngBytes, trace } = await renderStylesheetMediaCase("only print");

  assert.deepEqual(calls, ["https://site.test/media-only%20print.html"]);
  assert.deepEqual(trace.discoveredResources, []);
  assert.deepEqual(trace.loadedResources, []);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, 0);
  assert.equal(trace.stylesheetCount, 1, "only the UA stylesheet is active");
  assert.equal(trace.authorStylesheetCount, 0);
  assert.equal(trace.authorRuleCount, 0);
  assert.equal(trace.authorDeclarationCount, 0);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(!trace.paintOps.includes("rect"), "only print does not match screen rendering");
  assert.ok(trace.paintOps.includes("text"), "the rest of the page still renders visible text");
  assert.ok(pngBytes > 0);
});

void test("renderUrlToPng keeps spaced only-print media stylesheets inactive", async () => {
  const { calls, pngBytes, trace } = await renderStylesheetMediaCase("only   print");

  assert.equal(calls.length, 1);
  assert.deepEqual(trace.discoveredResources, []);
  assert.deepEqual(trace.loadedResources, []);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, 0);
  assert.equal(trace.stylesheetCount, 1, "only the UA stylesheet is active");
  assert.equal(trace.authorStylesheetCount, 0);
  assert.equal(trace.authorRuleCount, 0);
  assert.equal(trace.authorDeclarationCount, 0);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(!trace.paintOps.includes("rect"), "spaced only-print remains inactive for screen rendering");
  assert.ok(trace.paintOps.includes("text"), "the rest of the page still renders visible text");
  assert.ok(pngBytes > 0);
});

void test("renderUrlToPng applies screen min-width media-feature stylesheets", async () => {
  const { calls, cssBytes, trace } = await renderStylesheetMediaCase("screen and (min-width: 1px)");

  assert.equal(calls.length, 2);
  assert.equal(calls[1], "https://site.test/theme.css");
  assert.deepEqual(trace.discoveredResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.loadedResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, cssBytes);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + matching min-width author sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.ok(trace.paintOps.includes("rect"), "screen min-width media feature applies");
});

void test("renderUrlToPng treats uppercase media feature names as active when they match", async () => {
  const { calls, cssBytes, trace } = await renderStylesheetMediaCase("screen and (MIN-WIDTH: 1px)");

  assert.equal(calls.length, 2);
  assert.equal(calls[1], "https://site.test/theme.css");
  assert.deepEqual(trace.discoveredResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.loadedResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, cssBytes);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + uppercase feature-name author sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.ok(trace.paintOps.includes("rect"), "uppercase min-width media feature applies");
});

void test("renderUrlToPng applies decimal screen min-width media-feature stylesheets", async () => {
  const { calls, cssBytes, trace } = await renderStylesheetMediaCase("screen and (min-width: 799.5px)");

  assert.equal(calls.length, 2);
  assert.equal(calls[1], "https://site.test/theme.css");
  assert.deepEqual(trace.discoveredResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.loadedResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, cssBytes);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + decimal min-width author sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.ok(trace.paintOps.includes("rect"), "decimal min-width below the viewport applies");
});

void test("renderUrlToPng tolerates whitespace around media-feature operators", async () => {
  const { calls, cssBytes, trace } = await renderStylesheetMediaCase("screen  and  ( min-width : 1px )");

  assert.equal(calls.length, 2);
  assert.equal(calls[1], "https://site.test/theme.css");
  assert.deepEqual(trace.discoveredResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.loadedResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, cssBytes);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + spaced media-feature author sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.ok(trace.paintOps.includes("rect"), "spaced matching media feature applies");
});

void test("renderUrlToPng applies bare min-width media-feature stylesheets", async () => {
  const { calls, cssBytes, trace } = await renderStylesheetMediaCase("(min-width: 1px)");

  assert.equal(calls.length, 2);
  assert.equal(calls[1], "https://site.test/theme.css");
  assert.deepEqual(trace.discoveredResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.loadedResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, cssBytes);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + matching bare media-feature author sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.ok(trace.paintOps.includes("rect"), "bare min-width media feature applies");
});

void test("renderUrlToPng applies all-and min-width media-feature stylesheets", async () => {
  const { calls, cssBytes, trace } = await renderStylesheetMediaCase("all and (min-width: 1px)");

  assert.equal(calls.length, 2);
  assert.equal(calls[1], "https://site.test/theme.css");
  assert.deepEqual(trace.discoveredResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.loadedResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, cssBytes);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + all-and min-width author sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.ok(trace.paintOps.includes("rect"), "all and matching min-width applies");
});

void test("renderUrlToPng keeps all-and max-width media-feature stylesheets inactive when the feature misses", async () => {
  const { calls, pngBytes, trace } = await renderStylesheetMediaCase("all and (max-width: 1px)");

  assert.equal(calls.length, 1);
  assert.deepEqual(trace.discoveredResources, []);
  assert.deepEqual(trace.loadedResources, []);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, 0);
  assert.equal(trace.stylesheetCount, 1, "only the UA stylesheet is active");
  assert.equal(trace.authorStylesheetCount, 0);
  assert.equal(trace.authorRuleCount, 0);
  assert.equal(trace.authorDeclarationCount, 0);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(!trace.paintOps.includes("rect"), "all and non-matching max-width stays inactive");
  assert.ok(trace.paintOps.includes("text"), "the rest of the page still renders visible text");
  assert.ok(pngBytes > 0);
});

void test("renderUrlToPng applies only-all-and media-feature stylesheets", async () => {
  const { calls, cssBytes, trace } = await renderStylesheetMediaCase("only all and (min-width: 1px)");

  assert.equal(calls.length, 2);
  assert.equal(calls[1], "https://site.test/theme.css");
  assert.deepEqual(trace.discoveredResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.loadedResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, cssBytes);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + only-all-and author sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.ok(trace.paintOps.includes("rect"), "only all and matching min-width applies");
});

void test("renderUrlToPng keeps unsupported range media-feature syntax inactive", async () => {
  const { calls, pngBytes, trace } = await renderStylesheetMediaCase("screen and (width >= 1px)");

  assert.equal(calls.length, 1);
  assert.deepEqual(trace.discoveredResources, []);
  assert.deepEqual(trace.loadedResources, []);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, 0);
  assert.equal(trace.stylesheetCount, 1, "only the UA stylesheet is active");
  assert.equal(trace.authorStylesheetCount, 0);
  assert.equal(trace.authorRuleCount, 0);
  assert.equal(trace.authorDeclarationCount, 0);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(!trace.paintOps.includes("rect"), "unsupported range syntax does not fake a match");
  assert.ok(trace.paintOps.includes("text"), "the rest of the page still renders visible text");
  assert.ok(pngBytes > 0);
});

void test("renderUrlToPng applies a later media-list item after unsupported range syntax", async () => {
  const { calls, cssBytes, trace } = await renderStylesheetMediaCase("(width >= 1px), screen");

  assert.equal(calls.length, 2);
  assert.equal(calls[1], "https://site.test/theme.css");
  assert.deepEqual(trace.discoveredResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.loadedResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, cssBytes);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + later screen media-list item");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.ok(trace.paintOps.includes("rect"), "a later supported media-list item still applies");
});

void test("renderUrlToPng keeps unsupported calc media-feature lengths inactive", async () => {
  const { calls, pngBytes, trace } = await renderStylesheetMediaCase("screen and (min-width: calc(1px))");

  assert.equal(calls.length, 1);
  assert.deepEqual(trace.discoveredResources, []);
  assert.deepEqual(trace.loadedResources, []);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, 0);
  assert.equal(trace.stylesheetCount, 1, "only the UA stylesheet is active");
  assert.equal(trace.authorStylesheetCount, 0);
  assert.equal(trace.authorRuleCount, 0);
  assert.equal(trace.authorDeclarationCount, 0);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(!trace.paintOps.includes("rect"), "unsupported calc length does not fake a match");
  assert.ok(trace.paintOps.includes("text"), "the rest of the page still renders visible text");
  assert.ok(pngBytes > 0);
});

void test("renderUrlToPng keeps unsupported hover media-feature syntax inactive", async () => {
  const { calls, pngBytes, trace } = await renderStylesheetMediaCase("screen and (hover: hover)");

  assert.equal(calls.length, 1);
  assert.deepEqual(trace.discoveredResources, []);
  assert.deepEqual(trace.loadedResources, []);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, 0);
  assert.equal(trace.stylesheetCount, 1, "only the UA stylesheet is active");
  assert.equal(trace.authorStylesheetCount, 0);
  assert.equal(trace.authorRuleCount, 0);
  assert.equal(trace.authorDeclarationCount, 0);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(!trace.paintOps.includes("rect"), "unsupported hover feature does not fake a match");
  assert.ok(trace.paintOps.includes("text"), "the rest of the page still renders visible text");
  assert.ok(pngBytes > 0);
});

void test("renderUrlToPng keeps empty media-feature syntax inactive", async () => {
  const { calls, pngBytes, trace } = await renderStylesheetMediaCase("screen and ()");

  assert.equal(calls.length, 1);
  assert.deepEqual(trace.discoveredResources, []);
  assert.deepEqual(trace.loadedResources, []);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, 0);
  assert.equal(trace.stylesheetCount, 1, "only the UA stylesheet is active");
  assert.equal(trace.authorStylesheetCount, 0);
  assert.equal(trace.authorRuleCount, 0);
  assert.equal(trace.authorDeclarationCount, 0);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(!trace.paintOps.includes("rect"), "empty feature syntax does not fake a match");
  assert.ok(trace.paintOps.includes("text"), "the rest of the page still renders visible text");
  assert.ok(pngBytes > 0);
});

void test("renderUrlToPng keeps unsupported boolean width media-feature syntax inactive", async () => {
  const { calls, pngBytes, trace } = await renderStylesheetMediaCase("screen and (width)");

  assert.equal(calls.length, 1);
  assert.deepEqual(trace.discoveredResources, []);
  assert.deepEqual(trace.loadedResources, []);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, 0);
  assert.equal(trace.stylesheetCount, 1, "only the UA stylesheet is active");
  assert.equal(trace.authorStylesheetCount, 0);
  assert.equal(trace.authorRuleCount, 0);
  assert.equal(trace.authorDeclarationCount, 0);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(!trace.paintOps.includes("rect"), "unsupported boolean width syntax does not fake a match");
  assert.ok(trace.paintOps.includes("text"), "the rest of the page still renders visible text");
  assert.ok(pngBytes > 0);
});

void test("renderUrlToPng keeps unknown media-feature syntax inactive", async () => {
  const { calls, pngBytes, trace } = await renderStylesheetMediaCase("screen and (unknown-feature)");

  assert.equal(calls.length, 1);
  assert.deepEqual(trace.discoveredResources, []);
  assert.deepEqual(trace.loadedResources, []);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, 0);
  assert.equal(trace.stylesheetCount, 1, "only the UA stylesheet is active");
  assert.equal(trace.authorStylesheetCount, 0);
  assert.equal(trace.authorRuleCount, 0);
  assert.equal(trace.authorDeclarationCount, 0);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(!trace.paintOps.includes("rect"), "unknown media feature does not fake a match");
  assert.ok(trace.paintOps.includes("text"), "the rest of the page still renders visible text");
  assert.ok(pngBytes > 0);
});

void test("renderUrlToPng applies a later media-list item after empty media-feature syntax", async () => {
  const { calls, cssBytes, trace } = await renderStylesheetMediaCase("screen and (), screen");

  assert.equal(calls.length, 2);
  assert.equal(calls[1], "https://site.test/theme.css");
  assert.deepEqual(trace.discoveredResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.loadedResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, cssBytes);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + later screen media-list item");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.ok(trace.paintOps.includes("rect"), "a later supported media-list item still applies");
});

void test("renderUrlToPng skips screen max-width media-feature stylesheets that miss the viewport", async () => {
  const { calls, pngBytes, trace } = await renderStylesheetMediaCase("screen and (max-width: 1px)");

  assert.equal(calls.length, 1);
  assert.deepEqual(trace.discoveredResources, []);
  assert.deepEqual(trace.loadedResources, []);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, 0);
  assert.equal(trace.stylesheetCount, 1, "only the UA stylesheet is active");
  assert.equal(trace.authorStylesheetCount, 0);
  assert.equal(trace.authorRuleCount, 0);
  assert.equal(trace.authorDeclarationCount, 0);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(!trace.paintOps.includes("rect"), "non-matching max-width feature does not apply");
  assert.ok(trace.paintOps.includes("text"), "the rest of the page still renders visible text");
  assert.ok(pngBytes > 0);
});

void test("renderUrlToPng keeps decimal screen max-width media-feature stylesheets inactive", async () => {
  const { calls, pngBytes, trace } = await renderStylesheetMediaCase("screen and (max-width: 799.5px)");

  assert.equal(calls.length, 1);
  assert.deepEqual(trace.discoveredResources, []);
  assert.deepEqual(trace.loadedResources, []);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, 0);
  assert.equal(trace.stylesheetCount, 1, "only the UA stylesheet is active");
  assert.equal(trace.authorStylesheetCount, 0);
  assert.equal(trace.authorRuleCount, 0);
  assert.equal(trace.authorDeclarationCount, 0);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(!trace.paintOps.includes("rect"), "decimal max-width below the viewport remains inactive");
  assert.ok(trace.paintOps.includes("text"), "the rest of the page still renders visible text");
  assert.ok(pngBytes > 0);
});

void test("renderUrlToPng keeps spaced non-matching media-feature stylesheets inactive", async () => {
  const { calls, pngBytes, trace } = await renderStylesheetMediaCase("screen  and  ( max-width : 1px )");

  assert.equal(calls.length, 1);
  assert.deepEqual(trace.discoveredResources, []);
  assert.deepEqual(trace.loadedResources, []);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, 0);
  assert.equal(trace.stylesheetCount, 1, "only the UA stylesheet is active");
  assert.equal(trace.authorStylesheetCount, 0);
  assert.equal(trace.authorRuleCount, 0);
  assert.equal(trace.authorDeclarationCount, 0);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(!trace.paintOps.includes("rect"), "spaced non-matching feature remains inactive");
  assert.ok(trace.paintOps.includes("text"), "the rest of the page still renders visible text");
  assert.ok(pngBytes > 0);
});

void test("renderUrlToPng applies screen min-height media-feature stylesheets", async () => {
  const { calls, cssBytes, trace } = await renderStylesheetMediaCase("screen and (min-height: 1px)");

  assert.equal(calls.length, 2);
  assert.equal(calls[1], "https://site.test/theme.css");
  assert.deepEqual(trace.discoveredResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.loadedResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, cssBytes);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + matching min-height author sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.ok(trace.paintOps.includes("rect"), "screen min-height media feature applies");
});

void test("renderUrlToPng skips screen max-height media-feature stylesheets that miss the viewport", async () => {
  const { calls, pngBytes, trace } = await renderStylesheetMediaCase("screen and (max-height: 1px)");

  assert.equal(calls.length, 1);
  assert.deepEqual(trace.discoveredResources, []);
  assert.deepEqual(trace.loadedResources, []);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, 0);
  assert.equal(trace.stylesheetCount, 1, "only the UA stylesheet is active");
  assert.equal(trace.authorStylesheetCount, 0);
  assert.equal(trace.authorRuleCount, 0);
  assert.equal(trace.authorDeclarationCount, 0);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(!trace.paintOps.includes("rect"), "non-matching max-height feature does not apply");
  assert.ok(trace.paintOps.includes("text"), "the rest of the page still renders visible text");
  assert.ok(pngBytes > 0);
});

void test("renderUrlToPng applies exact screen width media-feature stylesheets", async () => {
  const { calls, cssBytes, trace } = await renderStylesheetMediaCase("screen and (width: 800px)");

  assert.equal(calls.length, 2);
  assert.equal(calls[1], "https://site.test/theme.css");
  assert.deepEqual(trace.discoveredResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.loadedResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, cssBytes);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + exact-width author sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.ok(trace.paintOps.includes("rect"), "exact screen width media feature applies");
});

void test("renderUrlToPng applies decimal exact screen width media-feature stylesheets", async () => {
  const { calls, cssBytes, trace } = await renderStylesheetMediaCase("screen and (width: 800.0px)");

  assert.equal(calls.length, 2);
  assert.equal(calls[1], "https://site.test/theme.css");
  assert.deepEqual(trace.discoveredResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.loadedResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, cssBytes);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + decimal exact-width author sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.ok(trace.paintOps.includes("rect"), "decimal exact width equal to the viewport applies");
});

void test("renderUrlToPng applies exact screen height media-feature stylesheets", async () => {
  const { calls, cssBytes, trace } = await renderStylesheetMediaCase("screen and (height: 600px)");

  assert.equal(calls.length, 2);
  assert.equal(calls[1], "https://site.test/theme.css");
  assert.deepEqual(trace.discoveredResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.loadedResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, cssBytes);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + exact-height author sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.ok(trace.paintOps.includes("rect"), "exact screen height media feature applies");
});

void test("renderUrlToPng skips exact screen height media-feature stylesheets that miss the viewport", async () => {
  const { calls, pngBytes, trace } = await renderStylesheetMediaCase("screen and (height: 1px)");

  assert.equal(calls.length, 1);
  assert.deepEqual(trace.discoveredResources, []);
  assert.deepEqual(trace.loadedResources, []);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, 0);
  assert.equal(trace.stylesheetCount, 1, "only the UA stylesheet is active");
  assert.equal(trace.authorStylesheetCount, 0);
  assert.equal(trace.authorRuleCount, 0);
  assert.equal(trace.authorDeclarationCount, 0);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(!trace.paintOps.includes("rect"), "non-matching exact height feature does not apply");
  assert.ok(trace.paintOps.includes("text"), "the rest of the page still renders visible text");
  assert.ok(pngBytes > 0);
});

void test("renderUrlToPng skips negated matching media-feature stylesheets", async () => {
  const { calls, pngBytes, trace } = await renderStylesheetMediaCase("not screen and (min-width: 1px)");

  assert.equal(calls.length, 1);
  assert.deepEqual(trace.discoveredResources, []);
  assert.deepEqual(trace.loadedResources, []);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, 0);
  assert.equal(trace.stylesheetCount, 1, "only the UA stylesheet is active");
  assert.equal(trace.authorStylesheetCount, 0);
  assert.equal(trace.authorRuleCount, 0);
  assert.equal(trace.authorDeclarationCount, 0);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(!trace.paintOps.includes("rect"), "negating a matching media feature prevents activation");
  assert.ok(trace.paintOps.includes("text"), "the rest of the page still renders visible text");
  assert.ok(pngBytes > 0);
});

void test("renderUrlToPng applies negated non-matching media-feature stylesheets", async () => {
  const { calls, cssBytes, trace } = await renderStylesheetMediaCase("not screen and (max-width: 1px)");

  assert.equal(calls.length, 2);
  assert.equal(calls[1], "https://site.test/theme.css");
  assert.deepEqual(trace.discoveredResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.loadedResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, cssBytes);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + negated non-matching author sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.ok(trace.paintOps.includes("rect"), "negating a non-matching media feature activates");
});

void test("renderUrlToPng applies landscape orientation media-feature stylesheets", async () => {
  const { calls, cssBytes, trace } = await renderStylesheetMediaCase("screen and (orientation: landscape)");

  assert.equal(calls.length, 2);
  assert.equal(calls[1], "https://site.test/theme.css");
  assert.deepEqual(trace.discoveredResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.loadedResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, cssBytes);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + matching landscape author sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.ok(trace.paintOps.includes("rect"), "landscape orientation media feature applies");
});

void test("renderUrlToPng treats uppercase orientation media feature values as active when they match", async () => {
  const { calls, cssBytes, trace } = await renderStylesheetMediaCase("screen and (ORIENTATION: LANDSCAPE)");

  assert.equal(calls.length, 2);
  assert.equal(calls[1], "https://site.test/theme.css");
  assert.deepEqual(trace.discoveredResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.loadedResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, cssBytes);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + uppercase landscape author sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.ok(trace.paintOps.includes("rect"), "uppercase landscape orientation media feature applies");
});

void test("renderUrlToPng skips portrait orientation media-feature stylesheets", async () => {
  const { calls, pngBytes, trace } = await renderStylesheetMediaCase("screen and (orientation: portrait)");

  assert.equal(calls.length, 1);
  assert.deepEqual(trace.discoveredResources, []);
  assert.deepEqual(trace.loadedResources, []);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, 0);
  assert.equal(trace.stylesheetCount, 1, "only the UA stylesheet is active");
  assert.equal(trace.authorStylesheetCount, 0);
  assert.equal(trace.authorRuleCount, 0);
  assert.equal(trace.authorDeclarationCount, 0);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(!trace.paintOps.includes("rect"), "non-matching portrait feature does not apply");
  assert.ok(trace.paintOps.includes("text"), "the rest of the page still renders visible text");
  assert.ok(pngBytes > 0);
});

void test("renderUrlToPng keeps uppercase orientation media feature values inactive when they miss", async () => {
  const { calls, pngBytes, trace } = await renderStylesheetMediaCase("screen and (ORIENTATION: PORTRAIT)");

  assert.equal(calls.length, 1);
  assert.deepEqual(trace.discoveredResources, []);
  assert.deepEqual(trace.loadedResources, []);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, 0);
  assert.equal(trace.stylesheetCount, 1, "only the UA stylesheet is active");
  assert.equal(trace.authorStylesheetCount, 0);
  assert.equal(trace.authorRuleCount, 0);
  assert.equal(trace.authorDeclarationCount, 0);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(!trace.paintOps.includes("rect"), "uppercase portrait feature remains inactive");
  assert.ok(trace.paintOps.includes("text"), "the rest of the page still renders visible text");
  assert.ok(pngBytes > 0);
});

void test("renderUrlToPng applies combined media features only when every feature matches", async () => {
  const { calls, cssBytes, trace } = await renderStylesheetMediaCase(
    "screen and (min-width: 1px) and (orientation: landscape)",
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[1], "https://site.test/theme.css");
  assert.deepEqual(trace.discoveredResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.loadedResources, ["https://site.test/theme.css"]);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, cssBytes);
  assert.equal(trace.stylesheetCount, 2, "UA sheet + matching combined-feature author sheet");
  assert.equal(trace.authorStylesheetCount, 1);
  assert.equal(trace.authorRuleCount, 1);
  assert.equal(trace.authorDeclarationCount, 3);
  assert.ok(trace.paintOps.includes("rect"), "all matching combined media features apply");
});

void test("renderUrlToPng skips combined media features when a later feature misses", async () => {
  const { calls, pngBytes, trace } = await renderStylesheetMediaCase(
    "screen and (min-width: 1px) and (orientation: portrait)",
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(trace.discoveredResources, []);
  assert.deepEqual(trace.loadedResources, []);
  assert.deepEqual(trace.missingResources, []);
  assert.equal(trace.loadedBytes, 0);
  assert.equal(trace.stylesheetCount, 1, "only the UA stylesheet is active");
  assert.equal(trace.authorStylesheetCount, 0);
  assert.equal(trace.authorRuleCount, 0);
  assert.equal(trace.authorDeclarationCount, 0);
  assert.equal(trace.decodedImageCount, 0);
  assert.ok(!trace.paintOps.includes("rect"), "a later non-matching media feature prevents stylesheet activation");
  assert.ok(trace.paintOps.includes("text"), "the rest of the page still renders visible text");
  assert.ok(pngBytes > 0);
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
  // Sample inside the image, clear of the UA body margin (8px).
  const i = (12 * img.width + 12) * 4;
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
