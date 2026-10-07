/**
 * Blob / File / object-URL platform surface for the guest runtime.
 *
 * A real (minimal) Blob: eager bytes, `size`, `type`, `slice`, `arrayBuffer`,
 * `text`, plus `URL.createObjectURL`/`revokeObjectURL` over an in-memory
 * registry. Object URLs are `blob:<origin>/<uuid>` per spec shape and resolve
 * only through the same registry that minted them.
 */
import { randomUUID } from "node:crypto";

export interface GuestBlob {
  readonly size: number;
  readonly type: string;
  slice(start?: unknown, end?: unknown, contentType?: unknown): GuestBlob;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

export interface GuestFile extends GuestBlob {
  readonly name: string;
  readonly lastModified: number;
}

/**
 * Bytes backing each Blob produced by this module. Keyed by instance so any
 * Blob/File — including ones minted by a *different* `makeBlobClass()` call —
 * contributes its bytes when used as a blob part.
 */
const blobBytes = new WeakMap<object, Uint8Array>();

/**
 * WebIDL blob-part conversion: BufferSource bytes, nested Blob bytes, or
 * USVString conversion for anything else (numbers, booleans, plain objects
 * all stringify).
 */
function toBytes(part: unknown): Uint8Array {
  if (typeof part === "object" && part !== null) {
    const nested = blobBytes.get(part);
    if (nested !== undefined) return nested;
    // ArrayBuffer.isView and Symbol.toStringTag work across realms (the guest
    // vm context produces foreign-realm buffers where instanceof fails).
    if (ArrayBuffer.isView(part)) {
      return new Uint8Array(part.buffer, part.byteOffset, part.byteLength).slice();
    }
    const tag = Object.prototype.toString.call(part);
    if (tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]") {
      return new Uint8Array(part as ArrayBuffer);
    }
  }
  return new TextEncoder().encode(String(part));
}

/**
 * `long long` argument conversion as WPT expects: round to nearest integer,
 * ties to even (0.5→0, 1.5→2, 2.5→2, 3.5→4).
 */
function roundHalfEven(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Negative offsets index from the end; results clamp to [0, length]. */
function clampIndex(value: number, length: number): number {
  const i = value < 0 ? length + value : value;
  return Math.max(0, Math.min(length, i));
}

/**
 * contentType normalization: any character outside printable ASCII
 * (0x20–0x7E) discards the type entirely; otherwise lowercase.
 */
function normalizeType(raw: unknown): string {
  // Absent (undefined) → "". Everything else is USVString-converted first
  // (null → "null", 5 → "5"), then any character outside printable ASCII
  // discards the type entirely.
  if (raw === undefined) return "";
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- DOMString coercion
  const str = String(raw);
  if (!/^[\x20-\x7e]*$/.test(str)) return "";
  return str.toLowerCase();
}

export function makeBlobClass(): new (parts?: readonly unknown[], options?: { readonly type?: unknown }) => GuestBlob {
  class Blob implements GuestBlob {
    readonly #bytes: Uint8Array;
    readonly type: string;

    constructor(parts?: readonly unknown[], options?: { readonly type?: unknown }) {
      const chunks = (parts ?? []).map(toBytes);
      const total = chunks.reduce((n, c) => n + c.byteLength, 0);
      const bytes = new Uint8Array(total);
      let at = 0;
      for (const c of chunks) {
        bytes.set(c, at);
        at += c.byteLength;
      }
      this.#bytes = bytes;
      blobBytes.set(this, bytes);
      this.type = normalizeType(options?.type);
    }

    get size(): number {
      return this.#bytes.byteLength;
    }

    slice(start?: unknown, end?: unknown, contentType?: unknown): GuestBlob {
      const len = this.#bytes.byteLength;
      const s = clampIndex(roundHalfEven(start === undefined ? 0 : Number(start)), len);
      const e = clampIndex(roundHalfEven(end === undefined ? len : Number(end)), len);
      // The inner `Blob` binding refers to this same class, so slices are
      // `instanceof Blob` — and per spec slice() never returns a File.
      return new Blob([this.#bytes.slice(s, Math.max(s, e))], { type: contentType });
    }

    arrayBuffer(): Promise<ArrayBuffer> {
      const out = new ArrayBuffer(this.#bytes.byteLength);
      new Uint8Array(out).set(this.#bytes);
      return Promise.resolve(out);
    }

    text(): Promise<string> {
      return Promise.resolve(new TextDecoder().decode(this.#bytes));
    }
  }
  return Blob;
}

export function makeFileClass(): new (parts: readonly unknown[], name: string, options?: { readonly type?: unknown; readonly lastModified?: unknown }) => GuestFile {
  const BlobCtor = makeBlobClass();
  class File extends BlobCtor implements GuestFile {
    readonly name: string;
    readonly lastModified: number;

    constructor(parts: readonly unknown[], name: string, options?: { readonly type?: unknown; readonly lastModified?: unknown }) {
      if (arguments.length < 2) {
        throw new TypeError(`Failed to construct 'File': 2 arguments required, but only ${arguments.length} present.`);
      }
      super(parts, options);
      // File names cannot contain '/' (spec: replaced with ':').
      this.name = String(name).replace(/\//g, ":");
      const lm = options?.lastModified;
      this.lastModified = typeof lm === "number" ? lm : Date.now();
    }
  }
  return File;
}

/** Object-URL registry: minted URLs resolve to their backing Blob. */
export class ObjectUrlRegistry {
  readonly #urls = new Map<string, GuestBlob>();

  createObjectURL(blob: unknown): string {
    if (blob === null || typeof blob !== "object" || !("size" in blob)) {
      throw new TypeError("createObjectURL requires a Blob");
    }
    const url = `blob:null/${randomUUID()}`;
    this.#urls.set(url, blob as GuestBlob);
    return url;
  }

  revokeObjectURL(url: unknown): void {
    this.#urls.delete(String(url));
  }

  /** Fetch the Blob behind a minted URL (host-side use). */
  resolve(url: string): GuestBlob | undefined {
    return this.#urls.get(url);
  }

  get size(): number {
    return this.#urls.size;
  }
}

/** Process-wide object-URL registry shared by all guest sandboxes. */
export const globalObjectUrls = new ObjectUrlRegistry();
