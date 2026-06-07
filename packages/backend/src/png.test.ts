/**
 * Tests for the backend's self-contained PNG encoder (task 3.11).
 *
 * Built by `tsc` then run with: `node --test packages/backend/dist/*.test.js`.
 *
 * The backend may import ONLY `@browser-engine/ir`, so it cannot reuse the
 * test-harness PNG codec. These tests therefore verify the encoder's output
 * with a tiny, local filter-0 RGBA decoder (built on Node's `zlib`, which is
 * exactly the stream PNG uses) — proving the produced bytes are a *valid,
 * decodable* PNG (Requirement 14.1) without crossing the stage boundary.
 */
import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";

import { encodeSurfaceToPng } from "./png.js";
import { createSurface, type Surface } from "./surface.js";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A decoded RGBA raster. */
interface Decoded {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/**
 * Minimal decoder for the exact subset the backend emits (8-bit, color type 6
 * RGBA, non-interlaced, filter None on every scanline). Throws on anything else
 * so a malformed encode is caught loudly.
 */
function decode(bytes: Uint8Array): Decoded {
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    assert.equal(bytes[i], PNG_SIGNATURE[i], `bad PNG signature at byte ${i}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  let sawIend = false;

  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      bytes[offset + 4] as number,
      bytes[offset + 5] as number,
      bytes[offset + 6] as number,
      bytes[offset + 7] as number,
    );
    const dataStart = offset + 8;
    if (type === "IHDR") {
      width = view.getUint32(dataStart);
      height = view.getUint32(dataStart + 4);
      assert.equal(bytes[dataStart + 8], 8, "expected bit depth 8");
      assert.equal(bytes[dataStart + 9], 6, "expected color type 6 (RGBA)");
      assert.equal(bytes[dataStart + 12], 0, "expected non-interlaced");
    } else if (type === "IDAT") {
      idat.push(bytes.subarray(dataStart, dataStart + length));
    } else if (type === "IEND") {
      sawIend = true;
      break;
    }
    offset = dataStart + length + 4; // skip the trailing CRC.
  }
  assert.ok(sawIend, "PNG missing IEND chunk");

  const raw = new Uint8Array(zlib.inflateSync(Buffer.concat(idat.map((c) => Buffer.from(c)))));
  const stride = width * 4;
  const data = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filterType = raw[y * (stride + 1)] as number;
    assert.equal(filterType, 0, "backend encodes filter None only");
    const rowStart = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x += 1) {
      data[y * stride + x] = raw[rowStart + x] as number;
    }
  }
  return { width, height, data };
}

void test("encodes a Surface to valid, decodable PNG bytes with the right dimensions", () => {
  const surface = createSurface(3, 2);
  const png = encodeSurfaceToPng(surface);
  const decoded = decode(png);
  assert.equal(decoded.width, 3);
  assert.equal(decoded.height, 2);
  assert.equal(decoded.data.length, 3 * 2 * 4);
});

void test("round-trips pixel values byte-for-byte", () => {
  // Build a surface with distinct per-pixel colors, then decode and compare.
  const surface: Surface = createSurface(2, 2);
  const colors = [
    [255, 0, 0, 255],
    [0, 255, 0, 255],
    [0, 0, 255, 255],
    [10, 20, 30, 255],
  ];
  for (let p = 0; p < 4; p += 1) {
    const c = colors[p] as number[];
    for (let ch = 0; ch < 4; ch += 1) {
      surface.pixels[p * 4 + ch] = c[ch] as number;
    }
  }
  const decoded = decode(encodeSurfaceToPng(surface));
  for (let i = 0; i < surface.pixels.length; i += 1) {
    assert.equal(decoded.data[i], surface.pixels[i], `pixel byte ${i} mismatch`);
  }
});

void test("throws on a corrupt Surface whose pixel length disagrees with its dimensions", () => {
  const bad: Surface = { width: 2, height: 2, pixels: new Uint8ClampedArray(4) };
  assert.throws(() => encodeSurfaceToPng(bad), /does not match/);
});
