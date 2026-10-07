/**
 * FileReader (File API §4.3): asynchronous reads of Blob/File contents with
 * progress events. Reads run on a microtask boundary (the engine has no file
 * I/O for in-memory Blobs) and fire the spec event sequence:
 * loadstart → progress* → load → loadend (or error/abort paths).
 */
import { DOMException } from "./abort.js";
import { Event, EventTarget } from "./event-system.js";
import type { GuestBlob } from "./blob.js";

type ReaderState = 0 | 1 | 2;

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = i + 1 < bytes.length ? (bytes[i + 1] as number) : 0;
    const c = i + 2 < bytes.length ? (bytes[i + 2] as number) : 0;
    out += BASE64_ALPHABET[a >> 2];
    out += BASE64_ALPHABET[((a & 0b11) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? BASE64_ALPHABET[((b & 0b1111) << 2) | (c >> 6)] : "=";
    out += i + 2 < bytes.length ? BASE64_ALPHABET[c & 0b111111] : "=";
  }
  return out;
}

/** Latin-1 byte view: each byte becomes the same code point (File API binary string). */
function toBinaryString(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

interface BlobLike {
  readonly size: number;
  readonly type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export class FileReader extends EventTarget {
  static readonly EMPTY = 0;
  static readonly LOADING = 1;
  static readonly DONE = 2;
  readonly EMPTY = 0;
  readonly LOADING = 1;
  readonly DONE = 2;

  #readyState: ReaderState = 0;
  #result: string | ArrayBuffer | null = null;
  #error: DOMException | null = null;
  #aborted = false;

  onloadstart: ((this: FileReader, ev: Event) => void) | null = null;
  onprogress: ((this: FileReader, ev: Event) => void) | null = null;
  onload: ((this: FileReader, ev: Event) => void) | null = null;
  onabort: ((this: FileReader, ev: Event) => void) | null = null;
  onerror: ((this: FileReader, ev: Event) => void) | null = null;
  onloadend: ((this: FileReader, ev: Event) => void) | null = null;

  get readyState(): ReaderState { return this.#readyState; }
  get result(): string | ArrayBuffer | null { return this.#result; }
  get error(): DOMException | null { return this.#error; }

  #fire(type: string): void {
    const ev = new Event(type);
    const handler = (
      {
        loadstart: this.onloadstart,
        progress: this.onprogress,
        load: this.onload,
        abort: this.onabort,
        error: this.onerror,
        loadend: this.onloadend,
      } as Record<string, ((this: FileReader, ev: Event) => void) | null>
    )[type];
    if (typeof handler === "function") {
      try {
        handler.call(this, ev);
      } catch {
        // Guest handler errors never mask the read outcome.
      }
    }
    this.dispatchEvent(ev);
  }

  #beginRead(blob: BlobLike): Uint8Array | Promise<Uint8Array> | null {
    if (this.#readyState === 1) {
      throw new DOMException("The object is in an invalid state.", "InvalidStateError");
    }
    if (typeof blob !== "object" || blob === null || typeof blob.arrayBuffer !== "function") {
      throw new TypeError("Failed to execute read on 'FileReader': parameter is not of type 'Blob'.");
    }
    this.#readyState = 1;
    this.#result = null;
    this.#error = null;
    this.#aborted = false;
    return null;
  }

  #read(blob: BlobLike, finish: (bytes: Uint8Array, blob: BlobLike) => string | ArrayBuffer): void {
    void this.#beginRead(blob);
    void (async () => {
      this.#fire("loadstart");
      let bytes: Uint8Array;
      try {
        const buf = await blob.arrayBuffer();
        bytes = new Uint8Array(buf);
      } catch (e) {
        if (this.#aborted) return;
        this.#readyState = 2;
        this.#error = new DOMException(e instanceof Error ? e.message : String(e), "NotReadableError");
        this.#fire("error");
        this.#fire("loadend");
        return;
      }
      if (this.#aborted) return;
      this.#fire("progress");
      this.#readyState = 2;
      this.#result = finish(bytes, blob);
      this.#fire("load");
      this.#fire("loadend");
    })();
  }

  readAsArrayBuffer(blob: unknown): void {
    this.#read(blob as BlobLike, (bytes) => {
      const out = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(out).set(bytes);
      return out;
    });
  }

  readAsText(blob: unknown, encoding?: unknown): void {
        // eslint-disable-next-line @typescript-eslint/no-base-to-string -- DOMString coercion
    const label = encoding === undefined ? "utf-8" : String(encoding);
    this.#read(blob as BlobLike, (bytes) => new TextDecoder(label).decode(bytes));
  }

  readAsDataURL(blob: unknown): void {
    this.#read(blob as BlobLike, (bytes, b) => {
      const type = typeof b.type === "string" && b.type !== "" ? b.type : "application/octet-stream";
      return `data:${type};base64,${toBase64(bytes)}`;
    });
  }

  readAsBinaryString(blob: unknown): void {
    this.#read(blob as BlobLike, (bytes) => toBinaryString(bytes));
  }

  abort(): void {
    if (this.#readyState !== 1) return;
    this.#aborted = true;
    this.#readyState = 2;
    this.#result = null;
    this.#error = new DOMException("The read operation was aborted.", "AbortError");
    this.#fire("abort");
    this.#fire("loadend");
  }
}

export type { GuestBlob };
