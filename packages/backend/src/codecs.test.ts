/**
 * `codecs.ts` — the Skia-backed image decode surface (RFC 0007).
 *
 * Fixtures are self-produced: PNG via the in-repo encoder, JPEG/WebP/ICO as
 * small embedded base64 constants (generated once with jpeg-js/cwebp/magick —
 * no host-tool dependency at test time), GIF/BMP hand-constructed byte-for-byte
 * below. AVIF is sniffed but its decode is build-dependent and NOT claimed here.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createSurface } from "./surface.js";
import { encodeSurfaceToPng } from "./png.js";
import {
  decodeImageBytes,
  decodeImageBytesAsync,
  sniffImageFormat,
} from "./codecs.js";
import { loadCanvasKit } from "./skia.js";

function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(b64, "base64"));
}

/** A 4×4 opaque tile PNG written by the in-repo encoder. */
function pngFixture(): Uint8Array {
  const surface = createSurface(4, 4);
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      const i = (y * 4 + x) * 4;
      surface.pixels[i] = 255;
      surface.pixels[i + 1] = x * 64;
      surface.pixels[i + 2] = y * 64;
      surface.pixels[i + 3] = 255;
    }
  }
  return encodeSurfaceToPng(surface);
}

/** 8×8 JPEG (jpeg-js encode of a gradient; lossy — we assert size only). */
const JPEG = fromBase64(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRQBAwQEBQQFCQUFCRQNCw0UFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFP/AABEIAAgACAMBEQACEQEDEQH/xAGiAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgsQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+gEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoLEQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/AOZ+FH7Kn+p/0P0/hr1c54w394jw249+D3z/AP/Z",
);

/** 8×8 WebP (cwebp of a flat tile). */
const WEBP = fromBase64(
  "UklGRjoAAABXRUJQVlA4IC4AAACwAQCdASoIAAgAAgA0JaACdLoABDAAAP7sl4/4DdfFtMv/sZv/ozf/Rm/rKAAA",
);

/** 8×8 ICO wrapping a BGRA bitmap (magick of a flat tile). */
const ICO = fromBase64(
  "AAABAAEACAgAAAEAIABIAQAAFgAAACgAAAAIAAAAEAAAAAEAIAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAABm5jP/ZuYz/2bmM/9m5jP/ZuYz/2bmM/9m5jP/ZuYz/2bmM/9m5jP/ZuYz/2bmM/9m5jP/ZuYz/2bmM/9m5jP/ZuYz/2bmM/9m5jP/ZuYz/2bmM/9m5jP/ZuYz/2bmM/9m5jP/ZuYz/2bmM/9m5jP/ZuYz/2bmM/9m5jP/ZuYz/2bmM/9m5jP/ZuYz/2bmM/9m5jP/ZuYz/2bmM/9m5jP/ZuYz/2bmM/9m5jP/ZuYz/2bmM/9m5jP/ZuYz/2bmM/9m5jP/ZuYz/2bmM/9m5jP/ZuYz/2bmM/9m5jP/ZuYz/2bmM/9m5jP/ZuYz/2bmM/9m5jP/ZuYz/2bmM/9m5jP/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
);

/** Minimal GIF89a: 2×1, two opaque pixels. */
const GIF = fromBase64("R0lGODlhAgABAPAAAP///wAAACH5BAEAAAAALAAAAAACAAEAAAICRAEAOw==");

/** Hand-constructed 2×2 24bpp BMP (bottom-up rows). */
function bmpFixture(): Uint8Array {
  const w = 2, h = 2;
  const rowSize = 8; // 2px × 3B padded to 4
  const b = Buffer.alloc(54 + rowSize * h);
  b.write("BM");
  b.writeUInt32LE(b.length, 2);
  b.writeUInt32LE(54, 10); // pixel-data offset
  b.writeUInt32LE(40, 14); // BITMAPINFOHEADER
  b.writeInt32LE(w, 18);
  b.writeInt32LE(h, 22); // positive = bottom-up
  b.writeUInt16LE(1, 26); // planes
  b.writeUInt16LE(24, 28); // bpp
  for (let i = 0; i < w * h; i += 1) {
    b[54 + i * 3] = 64; // B
    b[54 + i * 3 + 1] = 128; // G
    b[54 + i * 3 + 2] = 255; // R
  }
  return new Uint8Array(b);
}

void test("sniffImageFormat recognizes every supported container", () => {
  assert.equal(sniffImageFormat(pngFixture()), "png");
  assert.equal(sniffImageFormat(JPEG), "jpeg");
  assert.equal(sniffImageFormat(WEBP), "webp");
  assert.equal(sniffImageFormat(GIF), "gif");
  assert.equal(sniffImageFormat(bmpFixture()), "bmp");
  assert.equal(sniffImageFormat(ICO), "ico");
  assert.equal(sniffImageFormat(new Uint8Array([1, 2, 3, 4])), undefined);
  assert.equal(sniffImageFormat(new Uint8Array()), undefined);
});

void test("decodeImageBytesAsync decodes png/jpeg/webp/gif/bmp/ico through Skia", async () => {
  await loadCanvasKit();
  const cases: [string, Uint8Array, number, number][] = [
    ["png", pngFixture(), 4, 4],
    ["jpeg", JPEG, 8, 8],
    ["webp", WEBP, 8, 8],
    ["gif", GIF, 2, 1],
    ["bmp", bmpFixture(), 2, 2],
    ["ico", ICO, 8, 8],
  ];
  for (const [format, bytes, w, h] of cases) {
    const decoded = await decodeImageBytesAsync(bytes);
    assert.ok(decoded !== undefined, `${format} decodes`);
    assert.equal(decoded.width, w, `${format} width`);
    assert.equal(decoded.height, h, `${format} height`);
    assert.equal(decoded.pixels.length, w * h * 4);
    assert.equal(decoded.format, format);
  }
});

void test("decoded pixels are STRAIGHT-alpha RGBA (the DecodedImage contract)", async () => {
  // A semi-transparent pixel must read back alpha-preserving, NOT premultiplied.
  const surface = createSurface(1, 1);
  surface.pixels[0] = 255;
  surface.pixels[1] = 0;
  surface.pixels[2] = 0;
  surface.pixels[3] = 128; // straight-alpha 50%
  const png = encodeSurfaceToPng(surface);
  const decoded = await decodeImageBytesAsync(png);
  assert.ok(decoded !== undefined);
  assert.equal(decoded.pixels[0], 255, "R stays 255 — straight, not premul");
  assert.equal(decoded.pixels[3], 128, "alpha survives");
});

void test("decodeImageBytes (sync) works once the module is warm; garbage is rejected", async () => {
  await loadCanvasKit();
  const decoded = decodeImageBytes(WEBP);
  assert.ok(decoded !== undefined, "webp decodes synchronously when ck is warm");
  assert.equal(decoded.width, 8);
  assert.equal(decodeImageBytes(new Uint8Array([0, 1, 2, 3])), undefined);
  assert.equal(decodeImageBytes(new Uint8Array()), undefined);
});
