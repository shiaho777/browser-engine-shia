/**
 * RFC 0034 — the service-worker REALM (the script side of
 * `navigator.serviceWorker.register()`).
 *
 * A `worker_threads` entry like RFC 0032's dedicated worker, but the global
 * is a `ServiceWorkerGlobalScope`: event-driven (`install`/`activate`/
 * `fetch`/`message`), `ExtendableEvent.waitUntil`/`FetchEvent.respondWith`
 * lifetime semantics, `self.registration`, `self.clients`, `skipWaiting`,
 * and a per-worker `caches` (CacheStorage). `fetch` inside the realm is NOT
 * raw undici — it loop-backs to the parent, which re-enters the page's
 * network stack with `skipServiceWorker` set (so cookies/CORS/COEP apply
 * and a SW handler can never intercept itself).
 *
 * Honest boundaries:
 * - `caches` lives in the worker thread — real Cache API semantics but not
 *   shared across realms and not persisted to disk;
 * - `clients.matchAll()` returns only the clients the registry knows (the
 *   registering page), `Client.postMessage` delivers to that page's
 *   `navigator.serviceWorker` message listeners;
 * - `skipWaiting()`/`clients.claim()` resolve immediately — there is no
 *   incumbent-worker waiting state to skip;
 * - no `FetchEvent.handled`, `preloadResponse`, `navigationPreload`,
 *   `isReload`, `resultingClientId`, `replacesClientId`, `push`/`sync`/
 *   `notificationclick` events, and no `importScripts` beyond the dedicated-
 *   worker channel.
 */
import { parentPort, workerData } from "node:worker_threads";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const data = workerData as {
  source: string;
  url: string;
  scope: string;
};

/** Blocking fetch for `importScripts` — identical to the dedicated worker. */
function syncFetch(url: string): Uint8Array | undefined {
  try {
    if (url.startsWith("data:")) {
      const comma = url.indexOf(",");
      if (comma < 0) return undefined;
      const meta = url.slice(5, comma);
      const body = url.slice(comma + 1);
      return new TextEncoder().encode(
        meta.endsWith(";base64") ? Buffer.from(body, "base64").toString("utf8") : decodeURIComponent(body),
      );
    }
    if (url.startsWith("file://")) {
      return new Uint8Array(readFileSync(fileURLToPath(url)));
    }
    if (/^https?:/i.test(url)) {
      const out = execFileSync("curl", ["-sfL", "--max-time", "10", url], {
        maxBuffer: 8 * 1024 * 1024,
      });
      return new Uint8Array(out);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// ---- protocol -------------------------------------------------------------
// Inbound (parent → worker):
//   {type:"dispatch", id, event:"install"|"activate"|"fetch"|"message", request?}
// Outbound (worker → parent):
//   {type:"evaluated"}            — top-level script eval finished
//   {type:"result", id, response?}— dispatch settled (fetch events carry a
//                                 serialized respondWith response or none)
//   {type:"swFetch", id, req}     — realm's fetch() → parent's network stack
//   {type:"clientMessage", msg, clientId} — Client.postMessage → the page's
//                                 navigator.serviceWorker message listeners
// Inbound reply:
//   {type:"swFetchResult", id, ok, response?, error?}
// ---------------------------------------------------------------------------

interface SerializedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Uint8Array;
  clientId?: string;
}
interface SerializedResponse {
  url: string;
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: Uint8Array;
}

const listeners = new Map<string, ((ev: unknown) => void)[]>();
let swFetchSeq = 0;
const swFetchPending = new Map<number, { resolve: (r: unknown) => void; reject: (e: unknown) => void }>();

/** Loop-back fetch: parent does the real request through the page's stack. */
function realmFetch(url: unknown, init?: { method?: string; headers?: Record<string, string>; body?: Uint8Array }): Promise<unknown> {
  const resolved = new URL(String(url instanceof RequestShim ? url.url : url), data.url).href;
  const id = swFetchSeq++;
  const p = new Promise<unknown>((resolve, reject) => swFetchPending.set(id, { resolve, reject }));
  parentPort?.postMessage({
    type: "swFetch",
    id,
    req: {
      url: resolved,
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      ...(init?.body !== undefined ? { body: init.body } : {}),
    },
  });
  return p;
}

// ---- minimal fetch API surface (Headers/Request/Response) -----------------
class HeadersShim {
  readonly #map = new Map<string, string>();
  constructor(init?: Record<string, string> | [string, string][] | HeadersShim) {
    if (init instanceof HeadersShim) {
      for (const [k, v] of init.#map) this.#map.set(k, v);
    } else if (Array.isArray(init)) {
      for (const [k, v] of init) this.#map.set(String(k).toLowerCase(), String(v));
    } else if (init !== undefined && init !== null) {
      for (const [k, v] of Object.entries(init)) this.#map.set(k.toLowerCase(), String(v));
    }
  }
  get(name: string): string | null {
    return this.#map.get(String(name).toLowerCase()) ?? null;
  }
  set(name: string, value: string): void {
    this.#map.set(String(name).toLowerCase(), String(value));
  }
  has(name: string): boolean {
    return this.#map.has(String(name).toLowerCase());
  }
  append(name: string, value: string): void {
    const k = String(name).toLowerCase();
    this.#map.set(k, this.#map.has(k) ? `${this.#map.get(k)!}, ${value}` : String(value));
  }
  delete(name: string): void {
    this.#map.delete(String(name).toLowerCase());
  }
  entries(): IterableIterator<[string, string]> {
    return this.#map.entries();
  }
  [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.#map.entries();
  }
  toJSON(): Record<string, string> {
    return Object.fromEntries(this.#map);
  }
}

function bodyBytes(body: unknown): Uint8Array {
  if (body === undefined || body === null) return new Uint8Array(0);
  if (body instanceof Uint8Array) return body;
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (typeof body === "object" || typeof body === "number" || typeof body === "boolean") {
    return new TextEncoder().encode(JSON.stringify(body));
  }
  return new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body) ?? "");
}

class RequestShim {
  readonly url: string;
  readonly method: string;
  readonly headers: HeadersShim;
  readonly #body: Uint8Array;
  readonly clientId: string | undefined;
  constructor(url: unknown, init?: { method?: string; headers?: unknown; body?: unknown; clientId?: string }) {
    if (url instanceof RequestShim) {
      this.url = url.url;
      this.method = init?.method ?? url.method;
      this.headers = new HeadersShim(url.headers);
      this.#body = init?.body !== undefined ? bodyBytes(init.body) : url.#body;
    } else {
      this.url = new URL(String(url), data.url).href;
      this.method = (init?.method ?? "GET").toUpperCase();
      this.headers = new HeadersShim(init?.headers as Record<string, string> | undefined);
      this.#body = bodyBytes(init?.body);
    }
    this.clientId = init?.clientId;
  }
  clone(): RequestShim {
    return new RequestShim(this);
  }
  text(): Promise<string> {
    return Promise.resolve(new TextDecoder().decode(this.#body));
  }
  arrayBuffer(): Promise<ArrayBuffer> {
    return Promise.resolve(this.#body.slice().buffer);
  }
  json(): Promise<unknown> {
    return Promise.resolve(JSON.parse(new TextDecoder().decode(this.#body)) as unknown);
  }
  toWire(): SerializedRequest {
    const r: SerializedRequest = {
      url: this.url,
      method: this.method,
      headers: this.headers.toJSON(),
      ...(this.#body.byteLength > 0 ? { body: this.#body } : {}),
      ...(this.clientId !== undefined ? { clientId: this.clientId } : {}),
    };
    return r;
  }
}

class ResponseShim {
  readonly status: number;
  readonly headers: HeadersShim;
  readonly url: string;
  readonly #body: Uint8Array;
  constructor(body?: unknown, init?: { status?: number; headers?: unknown; url?: string }) {
    this.status = init?.status ?? 200;
    this.headers = new HeadersShim(init?.headers as Record<string, string> | undefined);
    this.#body = bodyBytes(body);
    this.url = init?.url ?? "";
  }
  static fromWire(r: SerializedResponse): ResponseShim {
    const res = new ResponseShim(r.body, { status: r.status, headers: r.headers, url: r.url });
    return res;
  }
  get ok(): boolean {
    return this.status >= 200 && this.status < 300;
  }
  get statusText(): string {
    return this.status === 200 ? "OK" : "";
  }
  clone(): ResponseShim {
    return new ResponseShim(this.#body.slice(), { status: this.status, headers: this.headers, url: this.url });
  }
  text(): Promise<string> {
    return Promise.resolve(new TextDecoder().decode(this.#body));
  }
  arrayBuffer(): Promise<ArrayBuffer> {
    return Promise.resolve(this.#body.slice().buffer);
  }
  json(): Promise<unknown> {
    return Promise.resolve(JSON.parse(new TextDecoder().decode(this.#body)) as unknown);
  }
  toWire(): SerializedResponse {
    return {
      url: this.url,
      status: this.status,
      ok: this.ok,
      headers: this.headers.toJSON(),
      body: this.#body,
    };
  }
}

// ---- CacheStorage (worker-local, per Cache API semantics) ------------------
function reqKey(input: unknown): string {
  return input instanceof RequestShim ? input.url : new URL(String(input), data.url).href;
}
class CacheShim {
  readonly #entries = new Map<string, ResponseShim>();
  match(input: unknown): Promise<unknown> {
    const hit = this.#entries.get(reqKey(input));
    return Promise.resolve(hit === undefined ? undefined : hit.clone());
  }
  put(request: unknown, response: unknown): Promise<void> {
    if (!(response instanceof ResponseShim)) return Promise.reject(new TypeError("Cache.put: response must be a Response"));
    this.#entries.set(reqKey(request), response.clone());
    return Promise.resolve();
  }
  async add(request: unknown): Promise<void> {
    const res = (await realmFetch(request)) as ResponseShim;
    this.#entries.set(reqKey(request), res.clone());
  }
  delete(request: unknown): Promise<boolean> {
    return Promise.resolve(this.#entries.delete(reqKey(request)));
  }
  keys(): Promise<unknown[]> {
    return Promise.resolve([...this.#entries.keys()].map((url) => new RequestShim(url)));
  }
}
const cacheStores = new Map<string, CacheShim>();
const cachesShim = {
  open: (name: unknown): Promise<CacheShim> => {
    const key = String(name);
    let c = cacheStores.get(key);
    if (c === undefined) {
      c = new CacheShim();
      cacheStores.set(key, c);
    }
    return Promise.resolve(c);
  },
  match: async (input: unknown): Promise<unknown> => {
    for (const c of cacheStores.values()) {
      const hit = await c.match(input);
      if (hit !== undefined) return hit;
    }
    return undefined;
  },
  keys: (): Promise<string[]> => Promise.resolve([...cacheStores.keys()]),
  has: (name: unknown): Promise<boolean> => Promise.resolve(cacheStores.has(String(name))),
  delete: (name: unknown): Promise<boolean> => Promise.resolve(cacheStores.delete(String(name))),
};

// ---- ExtendableEvent / FetchEvent ------------------------------------------
class ExtendableEventShim {
  readonly type: string;
  readonly #until: Promise<unknown>[] = [];
  constructor(type: string) {
    this.type = type;
  }
  waitUntil(p: unknown): void {
    if (p !== undefined && p !== null && typeof (p as Promise<unknown>).then === "function") {
      this.#until.push(p as Promise<unknown>);
    }
  }
  async settle(): Promise<void> {
    // Newly-added promises are also awaited (nested waitUntil).
    for (let i = 0; i < this.#until.length; i += 1) {
      await this.#until[i];
    }
  }
}

class FetchEventShim extends ExtendableEventShim {
  readonly request: RequestShim;
  readonly clientId: string | undefined;
  #responded: Promise<unknown> | null = null;
  constructor(payload: SerializedRequest) {
    super("fetch");
    this.request = new RequestShim(payload.url, {
      method: payload.method,
      headers: payload.headers,
      ...(payload.body !== undefined ? { body: payload.body } : {}),
      ...(payload.clientId !== undefined ? { clientId: payload.clientId } : {}),
    });
    this.clientId = payload.clientId;
  }
  respondWith(r: unknown): void {
    if (this.#responded !== null) throw new Error("respondWith already called");
    const p = Promise.resolve(r);
    this.#responded = p;
    this.waitUntil(p.then(() => undefined).catch(() => undefined));
  }
  get responded(): Promise<unknown> | null {
    return this.#responded;
  }
}

class MessageEventShim extends ExtendableEventShim {
  readonly data: unknown;
  readonly source: unknown;
  constructor(payload: { data: unknown; clientId?: string }) {
    super("message");
    this.data = payload.data;
    this.source =
      payload.clientId !== undefined
        ? {
            id: payload.clientId,
            postMessage: (msg: unknown): void => {
              parentPort?.postMessage({ type: "clientMessage", msg, clientId: payload.clientId });
            },
          }
        : null;
  }
}

// ---- the global scope -------------------------------------------------------
const sandbox: Record<string, unknown> = {
  location: { href: data.url, toString: () => data.url },
  registration: {
    scope: data.scope,
    // `active`/`installing`/`waiting` handles are the same worker face
    // back-referenced by the parent's registration record.
    active: null,
    installing: null,
    waiting: null,
    unregister: (): Promise<boolean> => Promise.resolve(false),
  },
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  queueMicrotask,
  console,
  caches: cachesShim,
  fetch: (url: unknown, init?: unknown): Promise<unknown> =>
    realmFetch(url, init as { method?: string; headers?: Record<string, string>; body?: Uint8Array }).then(
      (wire) => ResponseShim.fromWire(wire as SerializedResponse),
    ),
  Headers: HeadersShim,
  Request: RequestShim,
  Response: ResponseShim,
  skipWaiting: (): Promise<void> => Promise.resolve(),
  clients: {
    claim: (): Promise<void> => Promise.resolve(),
    matchAll: (): Promise<unknown[]> => Promise.resolve([]),
  },
  importScripts: (...urls: unknown[]): void => {
    for (const raw of urls) {
      const resolved = new URL(String(raw), data.url).href;
      const bytes = syncFetch(resolved);
      if (bytes === undefined) {
        throw new Error(`importScripts: failed to load '${resolved}'`);
      }
      vm.runInContext(new TextDecoder().decode(bytes), ctx, { filename: resolved });
    }
  },
  addEventListener: (type: unknown, fn: unknown): void => {
    if (typeof fn !== "function") return;
    const t = String(type);
    const list = listeners.get(t) ?? [];
    list.push(fn as (ev: unknown) => void);
    listeners.set(t, list);
  },
  removeEventListener: (type: unknown, fn: unknown): void => {
    const list = listeners.get(String(type));
    if (list === undefined) return;
    const i = list.indexOf(fn as (ev: unknown) => void);
    if (i >= 0) list.splice(i, 1);
  },
};
sandbox["self"] = sandbox;
sandbox["globalThis"] = sandbox;
sandbox["oninstall"] = null;
sandbox["onactivate"] = null;
sandbox["onfetch"] = null;
sandbox["onmessage"] = null;

const ctx = vm.createContext(sandbox);

async function dispatchEvent(name: string, ev: ExtendableEventShim): Promise<void> {
  const prop = `on${name}`;
  const handler = sandbox[prop];
  if (typeof handler === "function") (handler as (e: unknown) => void)(ev);
  for (const fn of [...(listeners.get(name) ?? [])]) fn(ev);
  await ev.settle();
}

parentPort?.on("message", (msg: { type: string; id?: number; event?: string; request?: SerializedRequest; data?: unknown; clientId?: string; ok?: boolean; response?: SerializedResponse; error?: string }) => {
  if (msg.type === "dispatch" && msg.id !== undefined) {
    const id = msg.id;
    const run = async (): Promise<void> => {
      const name = msg.event ?? "";
      if (name === "fetch") {
        const ev = new FetchEventShim(msg.request ?? { url: "", method: "GET", headers: {} });
        await dispatchEvent("fetch", ev);
        let response: SerializedResponse | null = null;
        if (ev.responded !== null) {
          // Non-Response respondWith is a spec error → treat as unhandled
          // (falls through to the wire) rather than synthesizing garbage.
          const r = await ev.responded.catch(() => null);
          if (r instanceof ResponseShim) response = r.toWire();
        }
        parentPort?.postMessage({ type: "result", id, response });
      } else if (name === "message") {
        await dispatchEvent("message", new MessageEventShim({ data: msg.data, ...(msg.clientId !== undefined ? { clientId: msg.clientId } : {}) }));
        parentPort?.postMessage({ type: "result", id });
      } else {
        await dispatchEvent(name, new ExtendableEventShim(name));
        parentPort?.postMessage({ type: "result", id });
      }
    };
    run().catch((err: unknown) => {
      parentPort?.postMessage({ type: "result", id, error: String(err) });
    });
    return;
  }
  if (msg.type === "swFetchResult" && msg.id !== undefined) {
    const pending = swFetchPending.get(msg.id);
    if (pending === undefined) return;
    swFetchPending.delete(msg.id);
    if (msg.ok === true && msg.response !== undefined) pending.resolve(msg.response);
    else pending.reject(new Error(msg.error ?? "swFetch failed"));
  }
});

// Top-level evaluation — listeners register synchronously; `evaluated` tells
// the parent the realm is ready to receive event dispatches.
vm.runInContext(data.source, ctx, { filename: data.url });
parentPort?.postMessage({ type: "evaluated" });
