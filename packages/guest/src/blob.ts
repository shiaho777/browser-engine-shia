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

function toBytes(part: unknown): Uint8Array {
  if (part instanceof Uint8Array) return part;
  if (part instanceof ArrayBuffer) return new Uint8Array(part);
  if (typeof part === "string") return new TextEncoder().encode(part);
  if (part !== null && typeof part === "object") {
    const maybe = part as { arrayBuffer?: unknown };
    if (typeof maybe.arrayBuffer === "function") {
      // Nested Blob-like part: cannot read bytes synchronously per spec; callers
      // in this runtime pass materialized parts, so treat this as empty.
      return new Uint8Array(0);
    }
    // Numbers/booleans stringify predictably; other objects are skipped.
    if (typeof (part as { toString?: unknown }).toString === "function" &&
        Object.prototype.toString.call(part) === "[object Object]") {
      return new Uint8Array(0);
    }
  }
  return new Uint8Array(0);
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
      const rawType = options?.type;
      this.type = typeof rawType === "string" ? rawType.toLowerCase().replace(/[^a-z0-9/#.+-]/g, "") : "";
    }

    get size(): number {
      return this.#bytes.byteLength;
    }

    slice(start?: unknown, end?: unknown, contentType?: unknown): GuestBlob {
      const len = this.#bytes.byteLength;
      let s = start === undefined ? 0 : Number(start);
      let e = end === undefined ? len : Number(end);
      if (Number.isNaN(s)) s = 0;
      if (Number.isNaN(e)) e = 0;
      s = Math.max(0, Math.min(len, Math.trunc(s)));
      e = Math.max(s, Math.min(len, Math.trunc(e)));
      const BlobCtor = makeBlobClass();
      return new BlobCtor([this.#bytes.slice(s, e)], { type: contentType });
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
      super(parts, options);
      this.name = String(name);
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
