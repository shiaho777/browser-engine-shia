/**
 * `woff.ts` — WOFF 1.0 unwrapping (RFC 0006).
 *
 * A WOFF file is an sfnt font plus a compression layer: a 44-byte header, a
 * table directory whose entries carry BOTH the compressed length and the
 * original length, and zlib-deflated table payloads. Unwrapping is mechanical:
 * inflate each table, emit a standard sfnt directory, concatenate. WOFF2
 * (brotli) is NOT handled — its transform pipeline is a different (and much
 * larger) format; `isWoff` is the gate, `unwrapWoff` throws on anything else.
 */
import { inflateSync } from "node:zlib";

const WOFF_MAGIC = 0x774f4646; // "wOFF"

/** True when `bytes` starts with the WOFF 1.x signature. */
export function isWoff(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return v.getUint32(0, false) === WOFF_MAGIC;
}

/**
 * Rebuild the equivalent sfnt bytes from a WOFF file. Throws on malformed
 * input (truncated header/directory, impossible offsets, bad inflate) — the
 * caller treats a throw as "source unusable", like a corrupt font file.
 */
export function unwrapWoff(bytes: Uint8Array): Uint8Array {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.byteLength < 44 || v.getUint32(0, false) !== WOFF_MAGIC) {
    throw new Error("not a WOFF file");
  }
  const flavor = v.getUint32(4, false);
  const numTables = v.getUint16(12, false);
  const dirStart = 44;
  if (dirStart + numTables * 20 > v.byteLength) {
    throw new Error("WOFF table directory truncated");
  }

  interface T {
    tag: number;
    data: Uint8Array;
    checksum: number;
  }
  const tables: T[] = [];
  for (let i = 0; i < numTables; i += 1) {
    const o = dirStart + i * 20;
    const tag = v.getUint32(o, false);
    const offset = v.getUint32(o + 4, false);
    const compLength = v.getUint32(o + 8, false);
    const origLength = v.getUint32(o + 12, false);
    const origChecksum = v.getUint32(o + 16, false);
    if (offset + compLength > v.byteLength) {
      throw new Error("WOFF table data out of range");
    }
    const raw = bytes.subarray(offset, offset + compLength);
    const data =
      compLength < origLength
        ? new Uint8Array(inflateSync(raw))
        : Uint8Array.from(raw);
    if (data.byteLength !== origLength) {
      throw new Error("WOFF table decompress length mismatch");
    }
    tables.push({ tag, data, checksum: origChecksum });
  }

  // sfnt directory: searchRange/entrySelector/rangeShift for numTables.
  const pow2 = 1 << Math.floor(Math.log2(Math.max(1, numTables)));
  const searchRange = pow2 * 16;
  const entrySelector = Math.floor(Math.log2(Math.max(1, numTables)));
  const rangeShift = numTables * 16 - searchRange;

  const headSize = 12 + numTables * 16;
  let cursor = headSize;
  const offsets: number[] = [];
  for (const t of tables) {
    offsets.push(cursor);
    cursor += t.data.byteLength + ((4 - (t.data.byteLength % 4)) % 4);
  }
  const out = new Uint8Array(cursor);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, flavor, false);
  ov.setUint16(4, numTables, false);
  ov.setUint16(6, searchRange, false);
  ov.setUint16(8, entrySelector, false);
  ov.setUint16(10, rangeShift, false);
  tables.forEach((t, i) => {
    const o = 12 + i * 16;
    ov.setUint32(o, t.tag, false);
    ov.setUint32(o + 4, t.checksum, false);
    ov.setUint32(o + 8, offsets[i] ?? headSize, false);
    ov.setUint32(o + 12, t.data.byteLength, false);
    out.set(t.data, offsets[i] ?? headSize);
  });
  return out;
}
