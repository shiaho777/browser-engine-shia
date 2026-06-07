/**
 * `sfnt.ts` — a tiny big-endian binary reader for the TrueType/OpenType `sfnt`
 * container, plus a matching writer used by the in-repo font compiler. All sfnt
 * integers are big-endian; these helpers are the single place that knows it.
 */

/** Big-endian cursor over a byte buffer (the sfnt reading primitive). */
export class Reader {
  #pos = 0;
  readonly #view: DataView;
  readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** Current byte offset. */
  get pos(): number {
    return this.#pos;
  }

  /** Seek to an absolute byte offset. */
  seek(pos: number): void {
    this.#pos = pos;
  }

  /** Advance the cursor by `n` bytes. */
  skip(n: number): void {
    this.#pos += n;
  }

  uint8(): number {
    const v = this.#view.getUint8(this.#pos);
    this.#pos += 1;
    return v;
  }

  int8(): number {
    const v = this.#view.getInt8(this.#pos);
    this.#pos += 1;
    return v;
  }

  uint16(): number {
    const v = this.#view.getUint16(this.#pos, false);
    this.#pos += 2;
    return v;
  }

  int16(): number {
    const v = this.#view.getInt16(this.#pos, false);
    this.#pos += 2;
    return v;
  }

  uint32(): number {
    const v = this.#view.getUint32(this.#pos, false);
    this.#pos += 4;
    return v;
  }

  /** Read a 4-byte ASCII tag (e.g. `"glyf"`). */
  tag(): string {
    let s = "";
    for (let i = 0; i < 4; i += 1) s += String.fromCharCode(this.uint8());
    return s;
  }
}

/** A growable big-endian byte sink (the sfnt writing primitive). */
export class Writer {
  #buf: number[] = [];

  get length(): number {
    return this.#buf.length;
  }

  uint8(v: number): void {
    this.#buf.push(v & 0xff);
  }

  int8(v: number): void {
    this.#buf.push(v & 0xff);
  }

  uint16(v: number): void {
    this.#buf.push((v >>> 8) & 0xff, v & 0xff);
  }

  int16(v: number): void {
    const u = v < 0 ? v + 0x10000 : v;
    this.uint16(u);
  }

  uint32(v: number): void {
    this.#buf.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  }

  /** Write a 4-char ASCII tag. */
  tag(s: string): void {
    for (let i = 0; i < 4; i += 1) this.uint8(s.charCodeAt(i));
  }

  /** Append raw bytes. */
  raw(bytes: Iterable<number>): void {
    for (const b of bytes) this.#buf.push(b & 0xff);
  }

  /** Pad with zero bytes until the length is a multiple of 4 (sfnt alignment). */
  pad4(): void {
    while (this.#buf.length % 4 !== 0) this.#buf.push(0);
  }

  toBytes(): Uint8Array {
    return Uint8Array.from(this.#buf);
  }
}

/** The sfnt table checksum: sum of big-endian uint32s over the (4-padded) table. */
export function checksum(bytes: Uint8Array): number {
  let sum = 0;
  const n = bytes.length;
  for (let i = 0; i < n; i += 4) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const b3 = bytes[i + 3] ?? 0;
    sum = (sum + (((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0)) >>> 0;
  }
  return sum >>> 0;
}
