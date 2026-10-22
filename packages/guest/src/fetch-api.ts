/**
 * Guest Fetch API primitives (Fetch §5, RFC 0019): spec-shaped `Headers`,
 * `Request`, `Response`, and a minimal `ReadableStream` — constructed per
 * document (the classes capture the document base URL for `Request`'s
 * URL resolution, matching the realm binding of real implementations).
 *
 * These REPLACE the injected host-undici classes on the guest global: the
 * responses `fetch()` returns are real `Response` instances (`instanceof`,
 * `clone()`, `bodyUsed`, `body` stream) instead of structural look-alikes.
 *
 * `makeFetchApi(baseUrl)` returns the classes plus {@link makeGuestFetch} —
 * the shared `(input, init)` normaliser used by every script runner, which
 * delegates the actual transport to an injected {@link FetchCore}. That
 * keeps request semantics (Request input, init merging, body extraction,
 * forbidden methods, abort) in ONE place; cores differ only in transport:
 * the real NetworkStack, the harness byte loader, or the in-memory
 * `resources` map.
 */

import { makeBlobClass } from "./blob.js";
import { DOMException } from "./abort.js";
import { coerceGuestString } from "./coerce.js";
import { NotImplemented } from "@browser-engine/ir";

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

export type HeadersInit =
  | ReadonlyArray<readonly [string, string]>
  | Readonly<Record<string, string>>
  | {
      readonly entries?: () => Iterable<[string, string]>;
      readonly get?: (n: unknown) => string | null;
      readonly has?: (n: unknown) => boolean;
      readonly forEach?: (fn: (v: string, k: string) => void) => void;
    }
  | null
  | undefined;

export interface GuestHeaders {
  append(name: unknown, value: unknown): void;
  delete(name: unknown): void;
  get(name: unknown): string | null;
  getSet(name: unknown): string[];
  getSetCookie(): string[];
  has(name: unknown): boolean;
  set(name: unknown, value: unknown): void;
  entries(): IterableIterator<[string, string]>;
  keys(): IterableIterator<string>;
  values(): IterableIterator<string>;
  forEach(fn: (value: string, key: string, parent: GuestHeaders) => void, thisArg?: unknown): void;
  [Symbol.iterator](): IterableIterator<[string, string]>;
  /** Internal: snapshot as a plain name→value map (names lowercased). */
  toJSON(): Record<string, string>;
}

/** Error constructors bound to a realm — swapped per vm context so guest
 * `e instanceof TypeError`/`DOMException` checks hold for errors the API
 * throws (host-constructed errors fail cross-realm instanceof). */
export interface RealmErrors {
  TypeError: new (message?: string) => Error;
  RangeError: new (message?: string) => Error;
  DOMException: new (message: string, name: string) => Error;
}

export const HOST_REALM_ERRORS: RealmErrors = { TypeError, RangeError, DOMException };

export function makeHeaders(init?: HeadersInit, errs: RealmErrors = HOST_REALM_ERRORS): GuestHeaders {
  const entries: [string, string][] = [];
  const find = (name: string): number[] => {
    const idx: number[] = [];
    for (let i = 0; i < entries.length; i += 1) if (entries[i]![0] === name) idx.push(i);
    return idx;
  };
  const api: GuestHeaders = {
    append(name: unknown, value: unknown): void {
      entries.push([coerceGuestString(name).toLowerCase(), coerceGuestString(value).trim()]);
    },
    delete(name: unknown): void {
      const key = coerceGuestString(name).toLowerCase();
      for (const i of find(key).reverse()) entries.splice(i, 1);
    },
    get(name: unknown): string | null {
      const idx = find(coerceGuestString(name).toLowerCase());
      if (idx.length === 0) return null;
      return idx.map((i) => entries[i]![1]).join(", ");
    },
    getSet(name: unknown): string[] {
      return find(coerceGuestString(name).toLowerCase()).map((i) => entries[i]![1]);
    },
    getSetCookie(): string[] {
      return api.getSet("set-cookie");
    },
    has(name: unknown): boolean {
      return find(coerceGuestString(name).toLowerCase()).length > 0;
    },
    set(name: unknown, value: unknown): void {
      const key = coerceGuestString(name).toLowerCase();
      for (const i of find(key).reverse()) entries.splice(i, 1);
      entries.push([key, coerceGuestString(value)]);
    },
    *entries(): IterableIterator<[string, string]> {
      yield* entries.map(([k, v]) => [k, v] as [string, string]);
    },
    *keys(): IterableIterator<string> {
      yield* entries.map(([k]) => k);
    },
    *values(): IterableIterator<string> {
      yield* entries.map(([, v]) => v);
    },
    forEach(fn: (value: string, key: string, parent: GuestHeaders) => void, thisArg?: unknown): void {
      for (const [k, v] of entries) fn.call(thisArg, v, k, api);
    },
    *[Symbol.iterator](): IterableIterator<[string, string]> {
      yield* api.entries();
    },
    toJSON(): Record<string, string> {
      const out: Record<string, string> = {};
      for (const [k] of entries) if (!(k in out)) out[k] = api.get(k)!;
      return out;
    },
  };
  if (init === undefined || init === null) return api;
  // Tuple sequence first — an Array init is ALWAYS a sequence-of-pairs
  // (a plain object with numeric keys is not a Headers init shape anyway).
  if (Array.isArray(init)) {
    for (const pair of init as readonly [string, string][]) {
      if (!Array.isArray(pair) || pair.length !== 2) {
        throw new errs.TypeError("Headers init: each entry must be a [name, value] pair");
      }
      api.append(pair[0], pair[1]);
    }
    return api;
  }
  const obj = init as {
    entries?: () => Iterable<[string, string]>;
    forEach?: (fn: (v: string, k: string) => void) => void;
    [Symbol.iterator]?: () => Iterator<[string, string]>;
  };
  if (typeof obj.entries === "function") {
    for (const [k, v] of obj.entries()) api.append(k, v);
  } else if (typeof obj[Symbol.iterator] === "function") {
    for (const pair of init as Iterable<[string, string]>) {
      if (Array.isArray(pair) && pair.length === 2) api.append(pair[0], pair[1]);
    }
  } else if (typeof obj.forEach === "function") {
    obj.forEach((v, k) => api.append(k, v));
  } else if (typeof init === "object") {
    for (const [k, v] of Object.entries(init as Record<string, unknown>)) api.append(k, String(v));
  }
  return api;
}

// ---------------------------------------------------------------------------
// ReadableStream — buffered source (the transport delivers whole bodies; the
// stream is the spec's CONSUMPTION surface, not wire chunking).
// ---------------------------------------------------------------------------

export interface GuestStreamReader {
  read(): Promise<{ value: Uint8Array | undefined; done: boolean }>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock(): void;
  readonly closed: Promise<void>;
}

export interface GuestReadableStream {
  readonly locked: boolean;
  cancel(reason?: unknown): Promise<void>;
  getReader(): GuestStreamReader;
  [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array>;
}

/**
 * A push-backed live stream — chunks arrive AS the transport yields them
 * (RFC 0040). `push`/`close`/`error` are the producer's handle; readers block
 * on a pending `read()` until the next chunk lands.
 */
export interface ChannelStream extends GuestReadableStream {
  push(chunk: Uint8Array): void;
  close(): void;
  error(e: unknown): void;
  /** True once closed/cancelled/errored — producers should stop feeding. */
  readonly closed: boolean;
  /** Register a callback fired when a consumer cancels the stream. */
  onCancel(cb: () => void): void;
}

export function makeChannelStream(): ChannelStream {
  const queue: Uint8Array[] = [];
  let done = false;
  let locked = false;
  let failure: unknown = undefined;
  const waiters: (() => void)[] = [];
  const cancelHooks: (() => void)[] = [];
  const wake = (): void => {
    for (const w of waiters.splice(0)) w();
  };
  const stream: ChannelStream = {
    get locked() {
      return locked;
    },
    get closed() {
      return done;
    },
    push(chunk: Uint8Array): void {
      if (done) return;
      queue.push(chunk);
      wake();
    },
    close(): void {
      done = true;
      wake();
    },
    error(e: unknown): void {
      failure = e;
      done = true;
      wake();
    },
    cancel(_reason?: unknown): Promise<void> {
      const wasDone = done;
      done = true;
      queue.length = 0;
      wake(); // suspended readers must observe the cancellation
      if (!wasDone) for (const cb of cancelHooks.splice(0)) cb();
      return Promise.resolve();
    },
    onCancel(cb: () => void): void {
      if (done) cb();
      else cancelHooks.push(cb);
    },
    getReader(): GuestStreamReader {
      if (locked) throw new TypeError("ReadableStream is locked");
      locked = true;
      let resolveClosed: (() => void) | null = null;
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      return {
        async read(): Promise<{ value: Uint8Array | undefined; done: boolean }> {
          for (;;) {
            if (failure !== undefined) {
              throw failure instanceof Error
                ? failure
                : new Error(failure === null ? "stream error" : JSON.stringify(failure));
            }
            const next = queue.shift();
            if (next !== undefined) return { value: next, done: false };
            if (done) {
              resolveClosed?.();
              return { value: undefined, done: true };
            }
            await new Promise<void>((resolve) => waiters.push(resolve));
          }
        },
        cancel(reason?: unknown): Promise<void> {
          return stream.cancel(reason);
        },
        releaseLock(): void {
          locked = false;
        },
        closed,
      };
    },
    async *[Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
      const reader = stream.getReader();
      try {
        for (;;) {
          const { value, done: d } = await reader.read();
          if (d) return;
          if (value !== undefined) yield value;
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
  return stream;
}

/**
 * RFC 0040: tee a live body source into two independent branches. Each
 * source chunk is fanned into both channels as it lands — consumers read at
 * their own pace (channels buffer). Cancellation of BOTH branches cancels
 * the source; one branch cancelling keeps the other alive.
 */
export function teeStream(src: GuestReadableStream): [GuestReadableStream, GuestReadableStream] {
  const a = makeChannelStream();
  const b = makeChannelStream();
  let cancelled = false;
  const pump = (async () => {
    try {
      for await (const chunk of src) {
        if (cancelled) break;
        a.push(chunk);
        b.push(chunk);
      }
      a.close();
      b.close();
    } catch (e) {
      a.error(e);
      b.error(e);
    }
  })();
  void pump.catch(() => undefined);
  // If BOTH branches are cancelled the wire pull stops — one branch
  // cancelling alone keeps the other alive (spec tee semantics).
  const wrapCancel = (branch: ChannelStream, other: ChannelStream): void => {
    const orig = branch.cancel.bind(branch);
    branch.cancel = (reason?: unknown): Promise<void> => {
      void orig(reason);
      (branch as { __cancelled?: boolean }).__cancelled = true;
      if ((other as { __cancelled?: boolean }).__cancelled === true) {
        cancelled = true;
        void src.cancel(reason);
      }
      return Promise.resolve();
    };
  };
  wrapCancel(a, b);
  wrapCancel(b, a);
  return [a, b];
}

/** Drain any pull source (guest stream or a web ReadableStream) into bytes. */
export async function drainStream(
  src: { getReader(): { read(): Promise<{ value: unknown; done: boolean }> } },
): Promise<Uint8Array> {
  const reader = src.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    const chunk =
      value instanceof Uint8Array
        ? value
        : new Uint8Array(value as ArrayBufferLike);
    parts.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

export function makeBufferedStream(chunks: readonly Uint8Array[]): GuestReadableStream {
  const queue = [...chunks];
  let locked = false;
  const stream: GuestReadableStream = {
    get locked() {
      return locked;
    },
    cancel(_reason?: unknown): Promise<void> {
      queue.length = 0;
      return Promise.resolve();
    },
    getReader() {
      if (locked) throw new TypeError("ReadableStream is locked");
      locked = true;
      let resolveClosed: (() => void) | null = null;
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      return {
        read(): Promise<{ value: Uint8Array | undefined; done: boolean }> {
          const next = queue.shift();
          if (next === undefined) {
            if (resolveClosed !== null) resolveClosed();
            return Promise.resolve({ value: undefined, done: true });
          }
          return Promise.resolve({ value: next, done: false });
        },
        cancel(reason?: unknown): Promise<void> {
          return stream.cancel(reason);
        },
        releaseLock(): void {
          locked = false;
        },
        closed,
      };
    },
    async *[Symbol.asyncIterator]() {
      const reader = stream.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          if (value !== undefined) yield value;
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
  return stream;
}

// ---------------------------------------------------------------------------
// Body helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Convert a platform body type to bytes synchronously; null when absent. */
/** True for guest `ReadableStream` impls AND host/undici/web-streams bodies. */
function isReadableStreamLike(body: unknown): boolean {
  return (
    body !== null &&
    typeof body === "object" &&
    typeof (body as { getReader?: unknown }).getReader === "function"
  );
}

export function bodyToBytes(body: unknown): Uint8Array | null {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return encoder.encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
  }
  if (body instanceof URLSearchParams) return encoder.encode(body.toString());
  const fd = body as { entries?: () => IterableIterator<[string, unknown]>; getBoundary?: () => string };
  if (typeof fd.entries === "function") {
    // FormData-ish (host undici or any iterable-of-pairs shape): multipart
    // encode with the boundary the object reports (undici) or a stable one.
    const boundary = typeof fd.getBoundary === "function" ? fd.getBoundary() : "----guestboundary9f2e1a";
    const parts: string[] = [];
    for (const [name, value] of fd.entries()) {
      parts.push(
        `--${boundary}\r\nContent-Disposition: form-data; name="${String(name)}"\r\n\r\n${String(value)}\r\n`,
      );
    }
    parts.push(`--${boundary}--\r\n`);
    return encoder.encode(parts.join(""));
  }
  return null;
}

/** The content-type a body form implies (null = leave to the caller). */
export function impliedBodyContentType(body: unknown): string | null {
  if (typeof body === "string") return "text/plain;charset=UTF-8";
  if (body instanceof URLSearchParams) return "application/x-www-form-urlencoded;charset=UTF-8";
  const fd = body as { getBoundary?: () => string; entries?: () => IterableIterator<[string, unknown]> };
  if (body !== null && typeof body === "object" && typeof fd.entries === "function") {
    const boundary = typeof fd.getBoundary === "function" ? fd.getBoundary() : "----guestboundary9f2e1a";
    return `multipart/form-data; boundary=${boundary}`;
  }
  const blob = body as { type?: unknown };
  if (body !== null && typeof body === "object" && typeof blob.type === "string" && blob.type !== "") {
    return blob.type;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Normalized request + transport core
// ---------------------------------------------------------------------------

/** A normalized request — the single shape every transport core accepts. */
export interface NormalizedRequest {
  readonly url: string;
  readonly method: string;
  /** Plain lowercased-name map for transport (network stack shape). */
  readonly headers: Record<string, string>;
  /** The guest Headers instance (enumerable — XHR needs the full list). */
  readonly headersList: GuestHeaders;
  readonly body: Uint8Array | undefined;
  readonly mode: string;
  readonly credentials: string;
  readonly redirect: string;
  readonly referrer: string;
  readonly referrerPolicy: string;
  readonly signal: unknown;
}

/** The transport-level result a core produces. `body` carries the buffered
 * payload for buffered transports; RFC 0040's `bodyStream` carries a live
 * body arriving off the wire (guest `res.body` reads chunks as they land). */
export interface RawFetchResult {
  readonly status: number;
  readonly statusText?: string;
  /** The FINAL url — last hop under redirects (drives responseURL). */
  readonly url: string;
  readonly headers: Record<string, string> | Iterable<readonly [string, string]> | GuestHeaders;
  readonly body: Uint8Array;
  /**
   * RFC 0040: when present, the body is a LIVE chunk stream arriving off the
   * wire — `body` is empty and the Response's `body`/`text()`/`json()` drain
   * it. Absent ⇒ `body` is the whole buffered payload.
   */
  readonly bodyStream?: GuestReadableStream;
  readonly redirected?: boolean;
  readonly type?: string;
}

/** Transport injection: normalized request → buffered raw response. Reject
 * to model a network failure (spec: fetch REJECTS on transport error). */
export type FetchCore = (request: NormalizedRequest) => Promise<RawFetchResult>;

/** Common header names probed when a structural response can't enumerate. */
const PROBED_HEADER_NAMES = [
  "content-type",
  "content-length",
  "etag",
  "last-modified",
  "cache-control",
  "expires",
  "date",
  "server",
  "location",
  "set-cookie",
];

/** Probe a get/has-only header facade for the names consumers actually read. */
export function probeHeaders(
  h: { get(name: unknown): string | null },
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of PROBED_HEADER_NAMES) {
    const v = h.get(name);
    if (v !== null) out[name] = v;
  }
  return out;
}

/**
 * Adapt a structural "response-like" object (the GuestBrowserFetch shape and
 * hand-rolled stubs) to {@link RawFetchResult}: headers are enumerated via
 * `entries()`/`forEach()`/`[Symbol.iterator]` when the object can, else
 * probed via {@link PROBED_HEADER_NAMES}; the body comes from
 * `arrayBuffer()` or `text()`.
 */
export async function adaptResponseLike(
  res: object,
  fallbackUrl: string,
): Promise<RawFetchResult> {
  const r = res as {
    status?: unknown;
    statusText?: unknown;
    url?: unknown;
    redirected?: unknown;
    type?: unknown;
    headers?: unknown;
    arrayBuffer?: unknown;
    text?: unknown;
  };
  const h = r.headers as
    | {
        entries?: () => Iterable<[string, string]>;
        forEach?: (fn: (v: string, k: string) => void) => void;
        get?: (n: unknown) => string | null;
        [Symbol.iterator]?: () => Iterator<[string, string]>;
      }
    | undefined;
  const headers: Record<string, string> = {};
  if (h !== undefined && h !== null) {
    if (typeof h.entries === "function") {
      for (const [k, v] of h.entries()) headers[k.toLowerCase()] = v;
    } else if (typeof h[Symbol.iterator] === "function") {
      for (const pair of h as unknown as Iterable<[string, string]>) {
        if (Array.isArray(pair) && pair.length === 2) headers[pair[0].toLowerCase()] = pair[1];
      }
    } else if (typeof h.forEach === "function") {
      h.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
    } else if (typeof h.get === "function") {
      Object.assign(headers, probeHeaders({ get: h.get }));
    } else {
      // A plain record like { "content-type": "text/html" } — the lowest-
      // ceremony shape stub fetches hand back.
      for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
        headers[k.toLowerCase()] = String(v);
      }
    }
  }
  let body = new Uint8Array();
  let bodyStream: GuestReadableStream | undefined;
  const liveBody = (r as { body?: unknown }).body;
  if (
    liveBody !== null &&
    liveBody !== undefined &&
    typeof (liveBody as GuestReadableStream).getReader === "function"
  ) {
    // RFC 0040: a live ReadableStream body tees into a guest channel —
    // chunks reach script readers as they land on the wire, not after a
    // full-buffer await. The web stream's reader interface matches ours.
    bodyStream = liveBody as GuestReadableStream;
  } else if (typeof r.arrayBuffer === "function") {
    body = new Uint8Array(await (r.arrayBuffer as () => Promise<ArrayBuffer>).call(res));
  } else if (typeof r.text === "function") {
    body = encoder.encode(await (r.text as () => Promise<string>).call(res));
  }
  return {
    status: Number(r.status ?? 0),
    statusText: typeof r.statusText === "string" ? r.statusText : "",
    url:
      r.url instanceof URL
        ? r.url.href
        : typeof r.url === "string" && r.url !== ""
          ? r.url
          : fallbackUrl,
    headers,
    body,
    ...(bodyStream !== undefined ? { bodyStream } : {}),
    redirected: r.redirected === true,
    ...(typeof r.type === "string" ? { type: r.type } : {}),
  };
}

export interface GuestRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: GuestHeaders;
  readonly mode: string;
  readonly credentials: string;
  readonly redirect: string;
  readonly referrer: string;
  readonly referrerPolicy: string;
  readonly signal: unknown;
  readonly body: GuestReadableStream | null;
  readonly bodyUsed: boolean;
  readonly destination: string;
  clone(): GuestRequest;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json(): Promise<unknown>;
  blob(): Promise<object>;
  /** Internal: raw request body bytes for the transport. */
  readonly bodyBytes: Uint8Array | undefined;
}

export interface GuestResponse {
  readonly type: string;
  readonly url: string;
  readonly redirected: boolean;
  readonly status: number;
  readonly ok: boolean;
  readonly statusText: string;
  readonly headers: GuestHeaders;
  readonly body: GuestReadableStream | null;
  readonly bodyUsed: boolean;
  clone(): GuestResponse;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json(): Promise<unknown>;
  blob(): Promise<object>;
  formData(): Promise<object>;
}

export interface FetchApi {
  readonly Headers: new (init?: unknown) => GuestHeaders;
  readonly Request: new (input: unknown, init?: unknown) => GuestRequest;
  readonly Response: {
    new (body?: unknown, init?: unknown): GuestResponse;
    error(): GuestResponse;
    redirect(url: unknown, status?: unknown): GuestResponse;
    json(data: unknown, init?: unknown): GuestResponse;
  };
  readonly ReadableStream: new () => GuestReadableStream;
  /** Build a guest Response from a transport-level result. */
  responseFromRaw(raw: RawFetchResult): GuestResponse;
  /** fetch(input, init) riding an injected transport core. */
  makeFetch(core: FetchCore): (input: unknown, init?: unknown) => Promise<GuestResponse>;
  /** Swap the error constructors to a vm realm's intrinsics (call once the
   * context exists) so API-thrown errors pass guest `instanceof` checks. */
  bindRealmErrors(errors: Partial<RealmErrors>): void;
}

const FORBIDDEN_METHODS = new Set(["CONNECT", "TRACE", "TRACK"]);

export function makeFetchApi(baseUrl: string): FetchApi {
  const errs: RealmErrors = { ...HOST_REALM_ERRORS };
  const resolveUrl = (raw: string): string => {
    try {
      return new URL(raw, baseUrl).href;
    } catch {
      throw new errs.TypeError(`Failed to fetch/construct: '${raw}' is not a valid URL`);
    }
  };

  class Headers {
    readonly #inner: GuestHeaders;
    constructor(init?: unknown) {
      this.#inner = makeHeaders(init as HeadersInit, errs);
    }
    append(name: unknown, value: unknown): void { this.#inner.append(name, value); }
    delete(name: unknown): void { this.#inner.delete(name); }
    get(name: unknown): string | null { return this.#inner.get(name); }
    getSet(name: unknown): string[] { return this.#inner.getSet(name); }
    getSetCookie(): string[] { return this.#inner.getSetCookie(); }
    has(name: unknown): boolean { return this.#inner.has(name); }
    set(name: unknown, value: unknown): void { this.#inner.set(name, value); }
    entries(): IterableIterator<[string, string]> { return this.#inner.entries(); }
    keys(): IterableIterator<string> { return this.#inner.keys(); }
    values(): IterableIterator<string> { return this.#inner.values(); }
    forEach(fn: (value: string, key: string, parent: GuestHeaders) => void, thisArg?: unknown): void {
      this.#inner.forEach(fn, thisArg);
    }
    [Symbol.iterator](): IterableIterator<[string, string]> { return this.#inner.entries(); }
    /** Internal: transport view as a plain lowercased-name record. */
    toJSON(): Record<string, string> { return this.#inner.toJSON(); }
  }

  class BodyState {
    readonly bytes: Uint8Array | null;
    used = false;
    stream: GuestReadableStream | null;
    /** RFC 0040: true when the body is a LIVE chunk source (still arriving). */
    readonly live: boolean;
    /** The RAW live source (unwrapped) — clone() tees this, not the facade. */
    #inner: GuestReadableStream | null = null;
    get innerStream(): GuestReadableStream | null {
      return this.#inner;
    }
    constructor(body: Uint8Array | GuestReadableStream | null) {
      if (body !== null && body !== undefined && typeof (body as GuestReadableStream).getReader === "function") {
        this.bytes = null;
        this.live = true;
        this.stream = null;
        this.replaceStream(body as GuestReadableStream);
      } else {
        this.bytes = body as Uint8Array | null;
        this.live = false;
        this.stream = body !== null && body !== undefined
          ? makeBufferedStream([body as Uint8Array])
          : null;
      }
    }
    /**
     * RFC 0040: swap the live source (clone-tee installs a branch). Wraps it
     * so any pull — getReader().read() or async iteration — marks the body
     * disturbed (Fetch §"bodyUsed").
     */
    replaceStream(inner: GuestReadableStream): void {
      this.#inner = inner;
      const markUsed = (): void => {
        this.used = true;
      };
      this.stream = {
        get locked() {
          return inner.locked;
        },
        getReader() {
          const reader = inner.getReader();
          return {
            ...reader,
            read(): Promise<{ value: Uint8Array | undefined; done: boolean }> {
              markUsed();
              return reader.read();
            },
          };
        },
        cancel: (reason?: unknown) => inner.cancel(reason),
        async *[Symbol.asyncIterator]() {
          markUsed();
          yield* inner[Symbol.asyncIterator]();
        },
      };
    }
    async #drain(): Promise<Uint8Array> {
      if (this.stream === null) return new Uint8Array();
      if (this.live) return drainStream(this.stream);
      return this.bytes ?? new Uint8Array();
    }
    consume(kind: "text" | "json" | "arraybuffer"): Promise<unknown> {
      if (this.used) {
        return Promise.reject(new errs.TypeError("Body has already been consumed"));
      }
      this.used = true;
      const finish = (raw: Uint8Array): unknown => {
        if (kind === "arraybuffer") {
          return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
        }
        const text = decoder.decode(raw);
        if (kind === "text") return text;
        return JSON.parse(text) as unknown;
      };
      return this.#drain().then(finish, (error: unknown) => {
        throw error instanceof Error ? error : new Error(String(error));
      });
    }
  }

  class Request {
    #state: BodyState;
    readonly url: string;
    readonly method: string;
    readonly headers: Headers;
    readonly mode: string;
    readonly credentials: string;
    readonly redirect: string;
    readonly referrer: string;
    readonly referrerPolicy: string;
    readonly signal: unknown;
    readonly destination = "";
    constructor(input: unknown, init?: unknown) {
      if (input === null || input === undefined) {
        throw new errs.TypeError("Failed to construct 'Request': 1 argument required");
      }
      const opts = (typeof init === "object" && init !== null ? init : {}) as Record<string, unknown>;
      const src = input instanceof Request ? input : undefined;
      // URL: Request input → its url; {url} request-like → that url; else the
      // input coerced to string.
      const rawUrl = typeof input === "string"
        ? input
        : src !== undefined
          ? src.url
          : (input as Record<string, unknown>)["url"] ?? input;
      this.url = resolveUrl(coerceGuestString(rawUrl));
      this.method = coerceGuestString(opts["method"] ?? src?.method ?? "GET").toUpperCase();
      if (FORBIDDEN_METHODS.has(this.method)) {
        throw new errs.TypeError(`Failed to construct 'Request': '${this.method}' is unsupported`);
      }
      // Headers: init REPLACES the copied set (Fetch §5.4 request init).
      this.headers =
        opts["headers"] !== undefined
          ? new Headers(opts["headers"])
          : new Headers(src?.headers);
      this.mode = opts["mode"] === undefined ? (src?.mode ?? "cors") : coerceGuestString(opts["mode"]);
      this.credentials =
        opts["credentials"] === undefined ? (src?.credentials ?? "same-origin") : coerceGuestString(opts["credentials"]);
      this.redirect = opts["redirect"] === undefined ? (src?.redirect ?? "follow") : coerceGuestString(opts["redirect"]);
      this.referrer =
        opts["referrer"] === undefined ? (src?.referrer ?? "about:client") : coerceGuestString(opts["referrer"]);
      this.referrerPolicy =
        opts["referrerPolicy"] === undefined ? (src?.referrerPolicy ?? "") : coerceGuestString(opts["referrerPolicy"]);
      this.signal = opts["signal"] ?? src?.signal ?? new AbortController().signal;
      let bodyBytes = src?.bodyBytes ?? null;
      if (opts["body"] !== undefined) bodyBytes = bodyToBytes(opts["body"]);
      if (bodyBytes !== null && (this.method === "GET" || this.method === "HEAD")) {
        throw new errs.TypeError("Failed to construct 'Request': Request with GET/HEAD cannot have a body");
      }
      if (bodyBytes !== null && opts["body"] !== undefined && !this.headers.has("content-type")) {
        const implied = impliedBodyContentType(opts["body"]);
        if (implied !== null) this.headers.set("content-type", implied);
      }
      this.#state = new BodyState(bodyBytes);
    }
    get body(): GuestReadableStream | null { return this.#state.stream; }
    get bodyUsed(): boolean { return this.#state.used; }
    get bodyBytes(): Uint8Array | undefined { return this.#state.bytes ?? undefined; }
    arrayBuffer(): Promise<ArrayBuffer> { return this.#state.consume("arraybuffer") as Promise<ArrayBuffer>; }
    text(): Promise<string> { return this.#state.consume("text") as Promise<string>; }
    json(): Promise<unknown> { return this.#state.consume("json"); }
    blob(): Promise<object> {
      const BlobCtor = makeBlobClass();
      const type = this.headers.get("content-type") ?? "";
      return this.#state.consume("arraybuffer").then((buf) => new BlobCtor([buf], { type }) as object);
    }
    clone(): Request {
      if (this.#state.used) throw new errs.TypeError("Failed to clone: body has already been consumed");
      const r = new Request(this.url, {
        method: this.method,
        headers: this.headers,
        mode: this.mode,
        credentials: this.credentials,
        redirect: this.redirect,
        referrer: this.referrer,
        referrerPolicy: this.referrerPolicy,
        signal: this.signal,
      });
      r.#state = new BodyState(this.#state.bytes);
      return r;
    }
  }

  class Response {
    #state: BodyState;
    readonly type: string;
    readonly url: string;
    readonly redirected: boolean;
    readonly status: number;
    readonly statusText: string;
    readonly headers: Headers;
    constructor(body?: unknown, init?: unknown) {
      const opts = (typeof init === "object" && init !== null ? init : {}) as Record<string, unknown>;
      this.status = opts["status"] === undefined ? 200 : Number(opts["status"]);
      if (this.status < 200 || this.status > 599) {
        throw new errs.RangeError("Failed to construct 'Response': status must be in the range 200 to 599");
      }
      this.statusText = opts["statusText"] === undefined ? "" : coerceGuestString(opts["statusText"]);
      this.headers = new Headers(opts["headers"]);
      this.url = "";
      this.redirected = false;
      this.type = "default";
      // RFC 0040: a ReadableStream body stays LIVE — it is not byte-coercible
      // (bodyToBytes would return null and silently drop the payload).
      this.#state = new BodyState(
        isReadableStreamLike(body) ? (body as GuestReadableStream) : bodyToBytes(body),
      );
      if (body !== null && body !== undefined && !this.headers.has("content-type")) {
        const implied = impliedBodyContentType(body);
        if (implied !== null) this.headers.set("content-type", implied);
      }
    }
    get ok(): boolean { return this.status >= 200 && this.status < 300; }
    get body(): GuestReadableStream | null { return this.#state.stream; }
    get bodyUsed(): boolean { return this.#state.used; }
    arrayBuffer(): Promise<ArrayBuffer> { return this.#state.consume("arraybuffer") as Promise<ArrayBuffer>; }
    text(): Promise<string> { return this.#state.consume("text") as Promise<string>; }
    json(): Promise<unknown> { return this.#state.consume("json"); }
    blob(): Promise<object> {
      const BlobCtor = makeBlobClass();
      const type = this.headers.get("content-type") ?? "";
      return this.#state.consume("arraybuffer").then((buf) => new BlobCtor([buf], { type }) as object);
    }
    formData(): Promise<object> {
      const ct = this.headers.get("content-type") ?? "";
      return this.text().then((text) => {
        if (ct.includes("application/x-www-form-urlencoded")) {
          const params = new URLSearchParams(text);
          const out = new Map<string, string>();
          params.forEach((v, k) => out.set(k, v));
          return out;
        }
        throw new NotImplemented("dom-api:formData:multipart", {
          category: "dom-api",
          detail: "multipart/form-data body decoding is not implemented; use urlencoded or read arrayBuffer()",
        });
      });
    }
    clone(): Response {
      if (this.#state.used) throw new errs.TypeError("Failed to clone: body has already been consumed");
      // RFC 0040: a live-stream body tees — the RAW source is drained into
      // two channels; per Fetch the tee is internal so this response's
      // bodyUsed stays false until its own branch is consumed.
      if (this.#state.live && this.#state.innerStream !== null) {
        const [a, b] = teeStream(this.#state.innerStream);
        this.#state.replaceStream(a);
        const r = new Response(b, {
          status: this.status,
          statusText: this.statusText,
          headers: this.headers,
        });
        const mut = r as unknown as { url: string; redirected: boolean; type: string };
        mut.url = this.url;
        mut.redirected = this.redirected;
        mut.type = this.type;
        return r;
      }
      const r = new Response(this.#state.bytes, {
        status: this.status,
        statusText: this.statusText,
        headers: this.headers,
      });
      const mut = r as unknown as { url: string; redirected: boolean; type: string };
      mut.url = this.url;
      mut.redirected = this.redirected;
      mut.type = this.type;
      return r;
    }
    static error(): Response {
      // Spec: error responses have status 0 — bypass the public range check
      // by constructing a legal status then mutating the internal fields.
      const r = new Response(null, { status: 200 });
      const mut = r as unknown as { type: string; status: number };
      mut.type = "error";
      mut.status = 0;
      return r;
    }
    static redirect(url: unknown, status?: unknown): Response {
      const code = status === undefined ? 302 : Number(status);
      if (![301, 302, 303, 307, 308].includes(code)) {
        throw new errs.RangeError("Failed to call 'redirect': invalid redirect status");
      }
      const r = new Response(null, { status: code });
      r.headers.set("location", resolveUrl(coerceGuestString(url)));
      return r;
    }
    static json(data: unknown, init?: unknown): Response {
      const opts = (typeof init === "object" && init !== null ? init : {}) as Record<string, unknown>;
      const headers = new Headers(opts["headers"]);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
      return new Response(JSON.stringify(data), { ...opts, headers });
    }
  }

  class ReadableStreamImpl {
    readonly #inner = makeBufferedStream([]);
    get locked(): boolean { return this.#inner.locked; }
    cancel(reason?: unknown): Promise<void> { return this.#inner.cancel(reason); }
    getReader(): GuestStreamReader { return this.#inner.getReader(); }
    [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> { return this.#inner[Symbol.asyncIterator](); }
  }

  const headersInto = (headers: Headers, source: RawFetchResult["headers"]): void => {
    const obj = source as { entries?: () => Iterable<[string, string]>; forEach?: (fn: (v: string, k: string) => void) => void; [Symbol.iterator]?: () => Iterator<[string, string]> };
    if (typeof obj?.entries === "function") {
      for (const [k, v] of obj.entries()) headers.append(k, v);
    } else if (typeof obj?.[Symbol.iterator] === "function") {
      for (const pair of source as Iterable<[string, string]>) {
        if (Array.isArray(pair) && pair.length === 2) headers.append(pair[0], pair[1]);
      }
    } else if (typeof obj?.forEach === "function") {
      obj.forEach((v, k) => headers.append(k, v));
    } else if (typeof source === "object" && source !== null) {
      for (const [k, v] of Object.entries(source as Record<string, string>)) headers.set(k, v);
    }
  };

  const responseFromRaw = (raw: RawFetchResult): GuestResponse => {
    const headers = new Headers();
    headersInto(headers, raw.headers);
    // Responses from the network may carry a 0 status (transport-level
    // failures a core resolved instead of rejecting — e.g. the budget filter).
    const status = raw.status === 0 ? 200 : raw.status;
    // RFC 0040: a live `bodyStream` becomes the Response's body source —
    // `res.body.getReader()` yields real wire chunks as they arrive.
    const r = new Response(raw.bodyStream ?? raw.body, {
      status,
      statusText: raw.statusText ?? "",
      headers,
    });
    const mut = r as unknown as { url: string; redirected: boolean; type: string; status: number };
    mut.status = raw.status;
    mut.url = raw.url;
    mut.redirected = raw.redirected === true;
    mut.type =
      raw.type ??
      (() => {
        try {
          return new URL(raw.url).origin === new URL(baseUrl).origin ? "basic" : "cors";
        } catch {
          return "basic";
        }
      })();
    return r;
  };

  return {
    Headers,
    Request,
    Response,
    ReadableStream: ReadableStreamImpl,
    responseFromRaw,
    bindRealmErrors(errors: Partial<RealmErrors>): void {
      if (errors.TypeError !== undefined) errs.TypeError = errors.TypeError;
      if (errors.RangeError !== undefined) errs.RangeError = errors.RangeError;
      if (errors.DOMException !== undefined) errs.DOMException = errors.DOMException;
    },
    makeFetch(core: FetchCore): (input: unknown, init?: unknown) => Promise<GuestResponse> {
      return (input: unknown, init?: unknown): Promise<GuestResponse> => {
        // Argument normalization is SYNCHRONOUS — a malformed call throws
        // before any I/O, matching the platform.
        const request = new Request(input, init);
        const signal = request.signal as
          | { aborted?: boolean; addEventListener?: (t: string, fn: () => void) => void }
          | null
          | undefined;
        const coreWork = (): Promise<GuestResponse> =>
          Promise.resolve(
            core({
              url: request.url,
              method: request.method,
              headers: request.headers.toJSON(),
              headersList: request.headers,
              body: request.bodyBytes,
              mode: request.mode,
              credentials: request.credentials,
              redirect: request.redirect,
              referrer: request.referrer,
              referrerPolicy: request.referrerPolicy,
              signal: request.signal,
            }),
          ).then(responseFromRaw, (e: unknown) => {
            // Fetch §4.2: a transport-level rejection is surfaced to script as
            // a TypeError (the spec's "network error" — distinct from an
            // HTTP-level failure which resolves with ok=false).
            if (e instanceof DOMException && e.name === "AbortError") throw e;
            throw new errs.TypeError(e instanceof Error ? e.message : String(e));
          });
        if (signal?.aborted === true) {
          return Promise.reject(new errs.DOMException("The operation was aborted.", "AbortError"));
        }
        if (signal !== null && signal !== undefined && typeof signal.addEventListener === "function") {
          const abortRejection = new Promise<never>((_resolve, reject) => {
            signal.addEventListener!("abort", () =>
              reject(new errs.DOMException("The operation was aborted.", "AbortError")),
            );
          });
          void abortRejection.catch(() => undefined);
          return Promise.race([coreWork(), abortRejection]);
        }
        return coreWork();
      };
    },
  };
}
