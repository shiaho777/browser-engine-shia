/**
 * Minimal, dependency-free PNG codec for the reftest harness (task 1.8).
 *
 * The reftest harness (design.md §9.1, Requirement 10.4) compares a rendered
 * PNG against a reference PNG within a configurable pixel-difference threshold.
 * To do real per-pixel work we must decode PNG bytes into raw RGBA pixels.
 *
 * We deliberately avoid an external image library here: Node ships `zlib`
 * (the exact DEFLATE/zlib stream PNG uses), so a compact, correct decoder for
 * the 8-bit, non-interlaced PNGs a renderer emits is only a few dozen lines —
 * which keeps the harness self-contained and serves the project's
 * compat-per-LOC ethos. A matching encoder lets tests build fixtures and lets
 * callers persist a diff/baseline image.
 *
 * Supported subset (sufficient for reftest baselines):
 *   - bit depth 8
 *   - color types 0 (grayscale), 2 (RGB), 4 (grayscale+alpha), 6 (RGBA)
 *   - non-interlaced
 *   - all five scanline filters (None/Sub/Up/Average/Paeth) on decode
 * Anything outside this subset throws a descriptive error rather than guessing.
 */
import zlib from "node:zlib";

/** A decoded raster: row-major, 8-bit RGBA, length === width * height * 4. */
export interface RawImage {
  readonly width: number;
  readonly height: number;
  /** RGBA bytes, 4 per pixel, row-major (top-to-bottom, left-to-right). */
  readonly data: Uint8Array;
}

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Channel count per pixel for each supported PNG color type. */
const CHANNELS_BY_COLOR_TYPE: Readonly<Record<number, number>> = {
  0: 1, // grayscale
  2: 3, // RGB
  4: 2, // grayscale + alpha
  6: 4, // RGBA
};

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

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i] as number;
    const idx = (c ^ byte) & 0xff;
    c = (CRC_TABLE[idx] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Decode a PNG byte buffer into an 8-bit RGBA {@link RawImage}.
 *
 * @throws Error if the bytes are not a PNG, are truncated/corrupt, or use an
 *   encoding outside the supported subset documented above.
 */
export function decodePng(bytes: Uint8Array): RawImage {
  if (bytes.length < PNG_SIGNATURE.length) {
    throw new Error("invalid PNG: buffer shorter than the 8-byte signature");
  }
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) {
      throw new Error("invalid PNG: bad signature");
    }
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = PNG_SIGNATURE.length;

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  const idatChunks: Uint8Array[] = [];
  let sawIhdr = false;
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
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) {
      throw new Error(`invalid PNG: chunk "${type}" runs past end of buffer`);
    }
    const data = bytes.subarray(dataStart, dataEnd);

    if (type === "IHDR") {
      width = view.getUint32(dataStart);
      height = view.getUint32(dataStart + 4);
      bitDepth = bytes[dataStart + 8] as number;
      colorType = bytes[dataStart + 9] as number;
      interlace = bytes[dataStart + 12] as number;
      sawIhdr = true;
    } else if (type === "PLTE") {
      palette = data.slice();
    } else if (type === "IDAT") {
      idatChunks.push(data.slice());
    } else if (type === "IEND") {
      sawIend = true;
      break;
    }

    offset = dataEnd + 4; // skip the chunk's trailing CRC.
  }

  if (!sawIhdr) throw new Error("invalid PNG: missing IHDR chunk");
  if (!sawIend) throw new Error("invalid PNG: missing IEND chunk");
  if (bitDepth !== 8) {
    throw new Error(`unsupported PNG: bit depth ${bitDepth} (reftest decoder handles 8-bit only)`);
  }
  if (interlace !== 0) {
    throw new Error("unsupported PNG: interlaced images are not handled by the reftest decoder");
  }

  const isPalette = colorType === 3;
  const channels = isPalette ? 1 : CHANNELS_BY_COLOR_TYPE[colorType];
  if (channels === undefined) {
    throw new Error(`unsupported PNG: color type ${colorType}`);
  }
  if (isPalette && palette === null) {
    throw new Error("invalid PNG: palette color type without a PLTE chunk");
  }

  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const bytesPerPixel = channels;
  const stride = width * bytesPerPixel;
  const expected = (stride + 1) * height;
  if (raw.length < expected) {
    throw new Error(
      `invalid PNG: decompressed data too short (got ${raw.length}, need ${expected})`,
    );
  }

  // Reverse the per-scanline filters in place, producing the raw samples.
  const samples = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filterType = raw[y * (stride + 1)] as number;
    const rowStart = y * (stride + 1) + 1;
    const outStart = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const filt = raw[rowStart + x] as number;
      const a = x >= bytesPerPixel ? (samples[outStart + x - bytesPerPixel] as number) : 0;
      const b = y > 0 ? (samples[outStart - stride + x] as number) : 0;
      const c =
        y > 0 && x >= bytesPerPixel ? (samples[outStart - stride + x - bytesPerPixel] as number) : 0;
      let value: number;
      switch (filterType) {
        case 0:
          value = filt;
          break;
        case 1:
          value = filt + a;
          break;
        case 2:
          value = filt + b;
          break;
        case 3:
          value = filt + ((a + b) >> 1);
          break;
        case 4:
          value = filt + paethPredictor(a, b, c);
          break;
        default:
          throw new Error(`invalid PNG: unknown scanline filter type ${filterType}`);
      }
      samples[outStart + x] = value & 0xff;
    }
  }

  // Expand whatever color type we decoded into uniform RGBA.
  const rgba = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p += 1) {
    const src = p * channels;
    const dst = p * 4;
    let r: number;
    let g: number;
    let bch: number;
    let alpha: number;
    switch (colorType) {
      case 0: {
        const v = samples[src] as number;
        r = v;
        g = v;
        bch = v;
        alpha = 255;
        break;
      }
      case 4: {
        const v = samples[src] as number;
        r = v;
        g = v;
        bch = v;
        alpha = samples[src + 1] as number;
        break;
      }
      case 2: {
        r = samples[src] as number;
        g = samples[src + 1] as number;
        bch = samples[src + 2] as number;
        alpha = 255;
        break;
      }
      case 6: {
        r = samples[src] as number;
        g = samples[src + 1] as number;
        bch = samples[src + 2] as number;
        alpha = samples[src + 3] as number;
        break;
      }
      case 3: {
        const pal = palette as Uint8Array;
        const index = (samples[src] as number) * 3;
        r = pal[index] as number;
        g = pal[index + 1] as number;
        bch = pal[index + 2] as number;
        alpha = 255;
        break;
      }
      default:
        throw new Error(`unsupported PNG: color type ${colorType}`);
    }
    rgba[dst] = r;
    rgba[dst + 1] = g;
    rgba[dst + 2] = bch;
    rgba[dst + 3] = alpha;
  }

  return { width, height, data: rgba };
}

/** Options controlling {@link encodePng}. */
export interface EncodePngOptions {
  /**
   * Scanline filter applied to every row (0=None, 1=Sub, 2=Up, 3=Average,
   * 4=Paeth). Defaults to 0 (None). Exposed mainly so tests can exercise every
   * unfilter branch of {@link decodePng}.
   */
  readonly filter?: 0 | 1 | 2 | 3 | 4;
}

/**
 * Encode an 8-bit RGBA {@link RawImage} into PNG bytes (color type 6,
 * non-interlaced). Round-trips with {@link decodePng}.
 */
export function encodePng(image: RawImage, options: EncodePngOptions = {}): Uint8Array {
  const { width, height, data } = image;
  if (data.length !== width * height * 4) {
    throw new Error(
      `RawImage data length ${data.length} does not match ${width}x${height} RGBA (${width * height * 4})`,
    );
  }
  const filter = options.filter ?? 0;
  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;

  // Build filtered scanlines: one filter-type byte followed by `stride` bytes.
  const filtered = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    filtered[rowStart] = filter;
    const inStart = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = data[inStart + x] as number;
      const a = x >= bytesPerPixel ? (data[inStart + x - bytesPerPixel] as number) : 0;
      const b = y > 0 ? (data[inStart - stride + x] as number) : 0;
      const c =
        y > 0 && x >= bytesPerPixel ? (data[inStart - stride + x - bytesPerPixel] as number) : 0;
      let filt: number;
      switch (filter) {
        case 0:
          filt = value;
          break;
        case 1:
          filt = value - a;
          break;
        case 2:
          filt = value - b;
          break;
        case 3:
          filt = value - ((a + b) >> 1);
          break;
        case 4:
          filt = value - paethPredictor(a, b, c);
          break;
        default:
          throw new Error(`unsupported encode filter ${String(filter)}`);
      }
      filtered[rowStart + 1 + x] = filt & 0xff;
    }
  }

  const compressed = zlib.deflateSync(filtered);

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace

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
