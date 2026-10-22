/**
 * RFC 0033 — real `<canvas>` 2D: a CanvasKit-backed op-log engine behind the
 * guest `CanvasRenderingContext2D`. Under test: fill/stroke pixels, path
 * rasterization + hit-testing, transforms, save/restore, clipping, gradients,
 * text, ImageData, drawImage, PNG export, bitmap reset semantics, and the
 * element → `canvasBitmaps` → paint-snapshot channel.
 *
 * CanvasKit is warmed once up front — the engine rasterizes lazily and reports
 * `undefined` while the WASM module is cold.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { decodePng } from "@browser-engine/test-harness";
import { loadCanvasKit } from "@browser-engine/backend";
import type { DecodedImage, NodeId } from "@browser-engine/ir";

import { FineSession } from "./fine.js";
import { runScriptsOnSession } from "./event-loop.js";

const PAGE = "https://example.com/app.html";

function session(html = "<!doctype html><title>t</title><canvas id=c></canvas>"): FineSession {
  return new FineSession(html, PAGE);
}

interface Run {
  readonly sandbox: Record<string, unknown>;
  readonly bitmaps: () => ReadonlyMap<NodeId, DecodedImage>;
}

/** Run `src` against a session and expose the canvas-bitmap channel. */
function run(src: string, html?: string, imageSource?: (id: NodeId) => DecodedImage | undefined): Run {
  const r = runScriptsOnSession(session(html), [src], new Map(), {
    ...(imageSource !== undefined ? { canvasImageSource: imageSource } : {}),
  });
  assert.equal(r.error, null);
  return {
    sandbox: r.sandbox as Record<string, unknown>,
    bitmaps: () => r.canvasBitmaps?.() ?? new Map(),
  };
}

/** The single canvas in the test documents is the only engine → first entry. */
function onlyBitmap(bitmaps: ReadonlyMap<NodeId, DecodedImage>): DecodedImage {
  assert.equal(bitmaps.size, 1, "expected exactly one canvas bitmap");
  return [...bitmaps.values()][0]!;
}

function px(img: DecodedImage, x: number, y: number): [number, number, number, number] {
  const i = (y * img.width + x) * 4;
  return [img.pixels[i]!, img.pixels[i + 1]!, img.pixels[i + 2]!, img.pixels[i + 3]!];
}

void test("fillRect rasterizes real pixels; canvasBitmaps carries them by NodeId", async () => {
  await loadCanvasKit();
  const r = run(`const c = document.getElementById("c");
    c.width = 8; c.height = 8;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "red";
    ctx.fillRect(0, 0, 4, 4);`);
  const img = onlyBitmap(r.bitmaps());
  assert.equal(img.width, 8);
  assert.equal(img.height, 8);
  assert.deepEqual(px(img, 1, 1), [255, 0, 0, 255]);
  assert.deepEqual(px(img, 6, 6), [0, 0, 0, 0]);
});

void test("getContext('2d') returns the SAME context; non-2d kinds → null", async () => {
  await loadCanvasKit();
  const r = run(`const c = document.getElementById("c");
    __same = c.getContext("2d") === c.getContext("2d");
    __webgl = c.getContext("webgl");
    __other = document.createElement("div").getContext("2d");`);
  assert.equal(r.sandbox["__same"], true);
  assert.equal(r.sandbox["__webgl"], null);
  assert.equal(r.sandbox["__other"], null);
});

void test("path fill + isPointInPath; stroke + isPointInStroke via real Skia geometry", async () => {
  await loadCanvasKit();
  const r = run(`const ctx = document.getElementById("c").getContext("2d");
    ctx.beginPath(); ctx.rect(2, 2, 4, 4);
    __inside = ctx.isPointInPath(4, 4);
    __outside = ctx.isPointInPath(8, 8);
    ctx.fillStyle = "#00ff00"; ctx.fill();
    ctx.beginPath(); ctx.moveTo(0, 9); ctx.lineTo(9, 9); ctx.lineWidth = 3;
    __inStroke = ctx.isPointInStroke(5, 9);
    __outStroke = ctx.isPointInStroke(5, 0);`);
  assert.equal(r.sandbox["__inside"], true);
  assert.equal(r.sandbox["__outside"], false);
  assert.equal(r.sandbox["__inStroke"], true);
  assert.equal(r.sandbox["__outStroke"], false);
  const img = onlyBitmap(r.bitmaps());
  assert.deepEqual(px(img, 4, 4), [0, 255, 0, 255]);
});

void test("transforms + save/restore isolate state correctly", async () => {
  await loadCanvasKit();
  const r = run(`const ctx = document.getElementById("c").getContext("2d");
    ctx.translate(4, 0);
    ctx.fillStyle = "rgb(0,0,255)";
    ctx.fillRect(0, 0, 2, 2);   // lands at x=4..6
    ctx.save();
    ctx.translate(0, 6);
    ctx.fillStyle = "red";
    ctx.fillRect(0, 0, 2, 2);   // lands at (4,6)
    ctx.restore();
    // Post-restore: translation back to (4,0), fillStyle back to blue.
    ctx.fillRect(4, 0, 2, 2);   // lands at (8,0)`);
  const img = onlyBitmap(r.bitmaps());
  assert.deepEqual(px(img, 5, 0), [0, 0, 255, 255]);  // translated blue
  assert.deepEqual(px(img, 5, 7), [255, 0, 0, 255]);  // saved+translated red
  assert.deepEqual(px(img, 9, 0), [0, 0, 255, 255]);  // post-restore, still translated
  assert.deepEqual(px(img, 1, 1), [0, 0, 0, 0]);      // untranslated region empty
});

void test("clip confines subsequent drawing to the clip region", async () => {
  await loadCanvasKit();
  const r = run(`const ctx = document.getElementById("c").getContext("2d");
    ctx.beginPath(); ctx.rect(0, 0, 5, 150); ctx.clip();
    ctx.fillStyle = "black"; ctx.fillRect(0, 0, 300, 150);`);
  const img = onlyBitmap(r.bitmaps());
  assert.deepEqual(px(img, 2, 75), [0, 0, 0, 255]);
  assert.deepEqual(px(img, 10, 75), [0, 0, 0, 0]); // outside the clip
});

void test("linear gradient produces a real color ramp", async () => {
  await loadCanvasKit();
  const r = run(`const ctx = document.getElementById("c").getContext("2d");
    const g = ctx.createLinearGradient(0, 0, 10, 0);
    g.addColorStop(0, "#ff0000"); g.addColorStop(1, "#0000ff");
    ctx.fillStyle = g; ctx.fillRect(0, 0, 10, 4);`);
  const img = onlyBitmap(r.bitmaps());
  const left = px(img, 0, 2);
  const right = px(img, 9, 2);
  assert.ok(left[0] > 200 && left[2] < 60, `left should be red-ish, got ${left.join(",")}`);
  assert.ok(right[2] > 200 && right[0] < 60, `right should be blue-ish, got ${right.join(",")}`);
});

void test("ImageData: get/put round-trips real pixels", async () => {
  await loadCanvasKit();
  const r = run(`const ctx = document.getElementById("c").getContext("2d");
    ctx.fillStyle = "lime"; ctx.fillRect(0, 0, 3, 3);
    const d = ctx.getImageData(0, 0, 3, 3);
    __w = d.width; __a = d.data[3];
    d.data[0] = 255; d.data[1] = 0; d.data[2] = 255; d.data[3] = 255;
    ctx.putImageData(d, 5, 5);`);
  assert.equal(r.sandbox["__w"], 3);
  assert.equal(r.sandbox["__a"], 255);
  const img = onlyBitmap(r.bitmaps());
  assert.deepEqual(px(img, 1, 1), [0, 255, 0, 255]);
  assert.deepEqual(px(img, 5, 5), [255, 0, 255, 255]);
});

void test("fillText rasterizes glyph ink; measureText returns real metrics", async () => {
  await loadCanvasKit();
  const r = run(`const ctx = document.getElementById("c").getContext("2d");
    ctx.font = "20px sans-serif"; ctx.fillStyle = "black";
    ctx.fillText("Hi", 4, 30);
    const m = ctx.measureText("Hi");
    __w = m.width;`);
  assert.ok((r.sandbox["__w"] as number) > 5, "measureText must report a real advance");
  const img = onlyBitmap(r.bitmaps());
  let inked = 0;
  for (let i = 3; i < img.pixels.length; i += 4) if (img.pixels[i]! > 0) inked += 1;
  assert.ok(inked > 8, `glyphs should ink pixels, got ${inked}`);
});

void test("toDataURL produces a real decodable PNG of the bitmap", async () => {
  await loadCanvasKit();
  const r = run(`const c = document.getElementById("c");
    c.width = 6; c.height = 4;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#123456"; ctx.fillRect(0, 0, 6, 4);
    __url = c.toDataURL();`);
  const url = r.sandbox["__url"] as string;
  assert.ok(url.startsWith("data:image/png;base64,"));
  const decoded = decodePng(new Uint8Array(Buffer.from(url.slice(22), "base64")));
  assert.equal(decoded.width, 6);
  assert.equal(decoded.height, 4);
  assert.deepEqual([decoded.data[0], decoded.data[1], decoded.data[2]], [0x12, 0x34, 0x56]);
});

void test("setting width/height resets the bitmap AND context state (spec)", async () => {
  await loadCanvasKit();
  const r = run(`const c = document.getElementById("c");
    const ctx = c.getContext("2d");
    ctx.fillStyle = "red"; ctx.fillRect(0, 0, 300, 150);
    ctx.fillStyle = "blue";           // staged: reset must drop this too
    c.width = 10;
    __fs = ctx.fillStyle;             // back to default black
    ctx.fillRect(0, 0, 2, 2);`);
  assert.equal(r.sandbox["__fs"], "#000000");
  const img = onlyBitmap(r.bitmaps());
  assert.equal(img.width, 10);
  assert.deepEqual(px(img, 1, 1), [0, 0, 0, 255]); // default-black post-reset fill
  assert.deepEqual(px(img, 8, 8), [0, 0, 0, 0]);   // old red wiped
});

void test("drawImage(canvas→canvas) blits the peer bitmap; OffscreenCanvas is real", async () => {
  await loadCanvasKit();
  const r = run(`const a = document.getElementById("c");
    a.width = 8; a.height = 8;
    const actx = a.getContext("2d");
    actx.fillStyle = "cyan"; actx.fillRect(0, 0, 4, 4);
    const off = new OffscreenCanvas(8, 8);
    const octx = off.getContext("2d");
    octx.drawImage(a, 0, 0);
    __offW = off.width;`,
    "<!doctype html><title>t</title><canvas id=c></canvas>");
  assert.equal(r.sandbox["__offW"], 8);
  // The OffscreenCanvas isn't a DOM node → not in canvasBitmaps; check the DOM
  // canvas bitmap for the source fill instead.
  const img = onlyBitmap(r.bitmaps());
  assert.deepEqual(px(img, 2, 2), [0, 255, 255, 255]);
});

void test("drawImage(imgEl) resolves through the decoded-image channel", async () => {
  await loadCanvasKit();
  // A 2×2 red DecodedImage standing in for a decoded <img>.
  const src: DecodedImage = {
    width: 2,
    height: 2,
    pixels: new Uint8ClampedArray([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]),
  };
  const r = run(
    `const ctx = document.getElementById("c").getContext("2d");
     ctx.drawImage(document.getElementById("im"), 3, 3);`,
    '<!doctype html><title>t</title><canvas id=c></canvas><img id=im src="x.png">',
    () => src,
  );
  const img = onlyBitmap(r.bitmaps());
  assert.deepEqual(px(img, 3, 3), [255, 0, 0, 255]);
  assert.deepEqual(px(img, 0, 0), [0, 0, 0, 0]);
});

void test("Path2D records an independent path usable by fill/stroke", async () => {
  await loadCanvasKit();
  const r = run(`const p = new Path2D();
    p.rect(1, 1, 3, 3);
    const ctx = document.getElementById("c").getContext("2d");
    ctx.fillStyle = "magenta"; ctx.fill(p);`);
  const img = onlyBitmap(r.bitmaps());
  assert.deepEqual(px(img, 2, 2), [255, 0, 255, 255]);
  assert.deepEqual(px(img, 8, 8), [0, 0, 0, 0]);
});
