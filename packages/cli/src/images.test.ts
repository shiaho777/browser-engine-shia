/**
 * RFC 0007 evidence: `images.ts` decodes through the Skia codec surface — no
 * subprocesses, no temp files, no host tools — across the formats that used to
 * shell out (webp) or fail outright (gif/bmp/ico).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { loadCanvasKit } from "@browser-engine/backend";
import { parseHtml } from "@browser-engine/html-parser";
import type { DomTree } from "@browser-engine/ir";

import { collectImages, collectImagesAsync, tryDecode, warmDecodeImageBytes } from "./images.js";

function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(b64, "base64"));
}

/** 8×8 WebP (lossy flat tile; same fixture as codecs.test.ts). */
const WEBP = fromBase64(
  "UklGRjoAAABXRUJQVlA4IC4AAACwAQCdASoIAAgAAgA0JaACdLoABDAAAP7sl4/4DdfFtMv/sZv/ozf/Rm/rKAAA",
);
/** 2×1 GIF89a. */
const GIF = fromBase64("R0lGODlhAgABAPAAAP///wAAACH5BAEAAAAALAAAAAACAAEAAAICRAEAOw==");

function imgDom(src: string): DomTree {
  return parseHtml(new TextEncoder().encode(`<html><body><img src="${src}"></body></html>`));
}

void test("webp data: URL decodes through the ASYNC chain with no subprocess", async () => {
  const dom = imgDom(`data:image/webp;base64,${Buffer.from(WEBP).toString("base64")}`);
  const images = await collectImagesAsync(dom);
  assert.equal(images.size, 1, "the webp <img> decoded in-process");
  const img = [...images.values()][0]!;
  assert.equal(img.width, 8);
  assert.equal(img.height, 8);
  assert.equal(img.format, "webp");
});

void test("gif data: URL decodes its first frame as a static poster", async () => {
  const dom = imgDom(`data:image/gif;base64,${Buffer.from(GIF).toString("base64")}`);
  const images = await collectImagesAsync(dom);
  assert.equal(images.size, 1);
  assert.equal([...images.values()][0]!.format, "gif");
});

void test("sync tryDecode covers webp once the codec surface is warm", async () => {
  await loadCanvasKit();
  const decoded = tryDecode(WEBP);
  assert.ok(decoded !== undefined, "warm sync decode handles webp");
  assert.equal(decoded.width, 8);
  const viaImg = collectImages(imgDom(`data:image/webp;base64,${Buffer.from(WEBP).toString("base64")}`));
  assert.equal(viaImg.size, 1, "sync collectImages decodes webp too");
});

void test("warmDecodeImageBytes returns undefined for garbage, not a throw", async () => {
  assert.equal(await warmDecodeImageBytes(new Uint8Array([9, 9, 9, 9])), undefined);
});

// ---------------------------------------------------------------------------
// RFC 0008: srcset w/x descriptors, sizes slot width, DPR-aware selection.
// ---------------------------------------------------------------------------

function imgNode(attrs: string): import("@browser-engine/ir").DomNode {
  const dom = parseHtml(new TextEncoder().encode(`<html><body><img ${attrs}></body></html>`));
  for (const node of dom.nodes.values()) {
    if (node.kind === "element" && node.tag === "img") return node;
  }
  throw new Error("no img node");
}

void test("parseSrcset reads w and x descriptors", async () => {
  const { parseSrcset } = await import("./images.js");
  const parts = parseSrcset("a-400.png 400w, a-800.png 800w, a-1x.png 1x");
  assert.equal(parts.length, 3);
  assert.equal(parts[0]!.width, 400);
  assert.equal(parts[1]!.width, 800);
  assert.equal(parts[2]!.density, 1);
});

void test("parseSizes evaluates media conditions against the viewport width", async () => {
  const { parseSizes } = await import("./images.js");
  assert.equal(parseSizes("(min-width:800px) 50vw, 100vw", 1000), 500);
  assert.equal(parseSizes("(min-width:800px) 50vw, 100vw", 600), 600, "falls to 100vw");
  assert.equal(parseSizes("300px", 900), 300);
  assert.equal(parseSizes("(max-width:600px) 200px, 50vw", 500), 200);
  assert.equal(parseSizes("garbage", 800), 800, "no match ⇒ 100vw default");
});

void test("srcset w descriptors resolve to densities via the slot width", async () => {
  const { imageSourceCandidates } = await import("./images.js");
  // slot 400px, dpr 2 → need ≥800w; smallest qualifying is 800w.
  const node = imgNode('srcset="s-400.png 400w, s-800.png 800w, s-1600.png 1600w" sizes="400px"');
  const order = imageSourceCandidates(node, { dpr: 2, viewportWidth: 800 });
  assert.equal(order[0], "s-800.png", "dpr 2 in a 400px slot picks the 800w source");
});

void test("srcset x descriptors select by device density directly", async () => {
  const { imageSourceCandidates } = await import("./images.js");
  const node = imgNode('srcset="d.png 1x, d-2x.png 2x, d-3x.png 3x"');
  const at2 = imageSourceCandidates(node, { dpr: 2 });
  assert.equal(at2[0], "d-2x.png", "the exact 2x density wins at dpr 2");
  const at1 = imageSourceCandidates(node, { dpr: 1 });
  assert.equal(at1[0], "d.png", "1x density wins at dpr 1");
  const at4 = imageSourceCandidates(node, { dpr: 4 });
  assert.equal(at4[0], "d-3x.png", "above the top density ⇒ the largest wins");
});

void test("sizes media conditions feed the w-descriptor slot width", async () => {
  const { imageSourceCandidates } = await import("./images.js");
  const node = imgNode(
    'srcset="w-320.png 320w, w-640.png 640w" sizes="(min-width:800px) 320px, 100vw"',
  );
  const wide = imageSourceCandidates(node, { dpr: 1, viewportWidth: 1000 });
  assert.equal(wide[0], "w-320.png", "slot 320px at 1x picks 320w");
  const narrow = imageSourceCandidates(node, { dpr: 1, viewportWidth: 500 });
  assert.equal(narrow[0], "w-640.png", "slot 500px at 1x needs the 640w source");
});

void test("preferSmall still orders candidates smallest-first", async () => {
  const { imageSourceCandidates } = await import("./images.js");
  const node = imgNode('srcset="b.png 800w, a.png 400w, c.png 1600w"');
  const order = imageSourceCandidates(node, { preferSmall: true });
  assert.equal(order[0], "a.png");
});
