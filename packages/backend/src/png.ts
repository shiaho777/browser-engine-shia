/**
 * Minimal, dependency-free PNG encoder for the screenshot backend (task 3.11).
 *
 * The Phase 1 `render <html> -o out.png` command (Requirement 14.1) must turn a
 * rendered {@link Surface} into real PNG bytes. The backend is a *stage* and may
 * import ONLY `@browser-engine/ir` (`local/no-cross-stage-import`), so it cannot
 * reuse the test-harness codec — it owns its own encoder here. Node ships
 * `zlib` (the exact DEFLATE/zlib stream PNG uses), so a correct encoder for the
 * 8-bit, non-interlaced, RGBA PNGs a screenshot needs is only a few dozen lines,
 * which keeps the backend self-contained and matches the project's
 * compat-per-LOC ethos.
 *
 * Output subset: bit depth 8, color type 6 (RGBA), non-interlaced, filter 0
 * (None) on every scanline. This is the standard subset the reftest decoder
 * (`@browser-engine/test-harness`) reads back, so encoded screenshots round-trip
 * through the harness for pixel comparison (Requirement 10.4).
 */
import zlib from "node:zlib";

import type { Surface } from "./surface.js";

/** The 8-byte PNG file signature. */
const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Standard CRC-32 lookup table (PNG chunk integrity). */
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 of a byte range (PNG chunk checksum). */
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i] as number;
    const idx = (c ^ byte) & 0xff;
    c = (CRC_TABLE[idx] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Assemble one length-tagged, CRC-checked PNG chunk (`type` + `data`). */
function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) {
    chunk[4 + i] = type.charCodeAt(i);
  }
  chunk.set(data, 8);
  const crcInput = chunk.subarray(4, 8 + data.length);
  view.setUint32(8 + data.length, crc32(crcInput));
  return chunk;
}

/**
 * Encode a {@link Surface} (8-bit RGBA pixel buffer) into PNG bytes (color type
 * 6, non-interlaced, filter None). Round-trips with the reftest harness's
 * `decodePng`.
 *
 * @throws Error if the surface's pixel buffer length does not match its
 *   declared `width × height × 4` (a corrupt Surface).
 */
export interface EncodePngOptions {
  readonly level?: number;
}

export function encodeSurfaceToPng(surface: Surface, options: EncodePngOptions = {}): Uint8Array {
  const { width, height, pixels } = surface;
  if (pixels.length !== width * height * 4) {
    throw new Error(
      `Surface pixel length ${pixels.length} does not match ${width}x${height} RGBA (${width * height * 4})`,
    );
  }

  const stride = width * 4;
  // Filtered scanlines: a leading filter-type byte (0 = None) per row.
  const filtered = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    filtered[rowStart] = 0; // filter type None.
    const inStart = y * stride;
    for (let x = 0; x < stride; x += 1) {
      filtered[rowStart + 1 + x] = pixels[inStart + x] as number;
    }
  }

  const level = options.level ?? 1;
  const compressed = zlib.deflateSync(filtered, { level });

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression method (DEFLATE)
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace (none)

  const chunks = [
    makeChunk("IHDR", ihdr),
    makeChunk("IDAT", new Uint8Array(compressed)),
    makeChunk("IEND", new Uint8Array(0)),
  ];

  let total = PNG_SIGNATURE.length;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  out.set(PNG_SIGNATURE, 0);
  let pos = PNG_SIGNATURE.length;
  for (const chunk of chunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return out;
}
