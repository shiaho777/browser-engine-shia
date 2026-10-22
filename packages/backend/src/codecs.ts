/**
 * Raster image decoding via the CanvasKit codec surface (RFC 0007).
 *
 * `MakeImageFromEncoded` decodes PNG/JPEG/WebP/GIF/BMP/ICO/AVIF in-process —
 * the same WASM Skia build that rasterizes for {@link SkiaBackend}. Pixels are
 * read back as straight-alpha RGBA8888, matching the `DecodedImage.pixels`
 * contract every backend already consumes. Decoding replaces the previous
 * subprocess shells (`dwebp`/`magick`/`sips` + temp files) entirely.
 *
 * Two entry points share one rule: the ASYNC path always has Skia (it awaits
 * {@link loadCanvasKit}); the SYNC path uses Skia only when the module is
 * already initialized, so a synchronous decode never blocks on WASM startup.
 */
import type { DecodedImage } from "@browser-engine/ir";

import { canvasKitIfReady, loadCanvasKit } from "./skia.js";

/** The raster formats {@link sniffImageFormat} recognizes (magic bytes). */
export type ImageFormat = "png" | "jpeg" | "webp" | "gif" | "bmp" | "ico" | "avif";

/** Pure magic-byte sniffing — no decode attempt, never throws. */
export function sniffImageFormat(bytes: Uint8Array): ImageFormat | undefined {
  const u32 = (off: number): number =>
    ((bytes[off]! << 24) | (bytes[off + 1]! << 16) | (bytes[off + 2]! << 8) | bytes[off + 3]!) >>> 0;
  if (bytes.length >= 8 && u32(0) === 0x89504e47) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  // RIFF....WEBP
  if (
    bytes.length >= 12 &&
    u32(0) === 0x52494646 &&
    u32(8) === 0x57454250
  ) {
    return "webp";
  }
  if (bytes.length >= 6 && u32(0) === 0x47494638 && (bytes[4] === 0x37 || bytes[4] === 0x39)) {
    return "gif";
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "bmp";
  if (bytes.length >= 4 && u32(0) === 0x00000100) return "ico";
  // ISOBMFF: size(4) + "ftyp" + brand — avif/avis (still or sequence).
  if (
    bytes.length >= 12 &&
    u32(4) === 0x66747970 &&
    (u32(8) === 0x61766966 || u32(8) === 0x61766973)
  ) {
    return "avif";
  }
  return undefined;
}

/**
 * Decode `bytes` through the ALREADY-INITIALIZED CanvasKit codec set.
 * Returns `undefined` when Skia is not warm or the bytes are not a supported
 * encoded image — callers chain fallbacks, nothing throws.
 */
export function decodeImageBytes(bytes: Uint8Array): DecodedImage | undefined {
  const ck = canvasKitIfReady();
  if (ck === undefined || bytes.length === 0) return undefined;
  const format = sniffImageFormat(bytes);
  if (format === undefined) return undefined;
  const image = ck.MakeImageFromEncoded(bytes);
  if (image === null) return undefined;
  try {
    const width = image.width();
    const height = image.height();
    if (!(width > 0) || !(height > 0)) return undefined;
    const pixels = image.readPixels(0, 0, {
      width,
      height,
      alphaType: ck.AlphaType.Unpremul,
      colorType: ck.ColorType.RGBA_8888,
      colorSpace: ck.ColorSpace.SRGB,
    });
    if (pixels === null || pixels.length < width * height * 4) return undefined;
    return {
      width,
      height,
      pixels: new Uint8ClampedArray(
        pixels.buffer,
        pixels.byteOffset,
        width * height * 4,
      ),
      format,
    };
  } finally {
    image.delete();
  }
}

/**
 * Decode `bytes` ensuring the CanvasKit module is loaded first — the async
 * resource phase's entry point (full format coverage, no host tools).
 */
export async function decodeImageBytesAsync(
  bytes: Uint8Array,
): Promise<DecodedImage | undefined> {
  try {
    await loadCanvasKit();
  } catch {
    return undefined;
  }
  return decodeImageBytes(bytes);
}
