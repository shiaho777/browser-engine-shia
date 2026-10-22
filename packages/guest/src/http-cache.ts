/**
 * The shared HTTP cache (RFC 0009; RFC 9111 semantics). In-memory, per
 * network-stack instance — a real browser cache slice: freshness lifetimes,
 * validator revalidation (ETag/Last-Modified → conditional requests → 304
 * body reuse), `no-store`/`no-cache`, `Vary` keying, and heuristic freshness
 * (10% of Date−Last-Modified) when a response carries no explicit directive.
 */

import type { NetworkRequest, NetworkResponse } from "./network.js";

export interface CacheEntry {
  readonly url: string;
  readonly status: number;
  /** Response headers (lowercased names), minus per-request `Set-Cookie`. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  /** Wall-clock ms when the response completed (freshness baseline). */
  readonly storedAt: number;
  /** Request-header values for the response's `Vary` fields, sorted. */
  readonly varyKey: readonly string[];
  /** `Vary` field names this entry keys on. */
  readonly varyFields: readonly string[];
}

export type LookupResult =
  | { readonly kind: "fresh"; readonly entry: CacheEntry }
  | { readonly kind: "revalidate"; readonly entry: CacheEntry }
  | { readonly kind: "miss" };

function parseCacheControl(header: string | undefined): Map<string, string | true> {
  const out = new Map<string, string | true>();
  if (header === undefined) return out;
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) {
      const k = part.trim().toLowerCase();
      if (k !== "") out.set(k, true);
    } else {
      const k = part.slice(0, eq).trim().toLowerCase();
      const v = part.slice(eq + 1).trim().replace(/^"|"$/g, "");
      if (k !== "") out.set(k, v);
    }
  }
  return out;
}

/** `httpDate` → ms epoch, or NaN when unparseable. */
function parseHttpDate(value: string | undefined): number {
  if (value === undefined) return Number.NaN;
  const t = Date.parse(value);
  return Number.isNaN(t) ? Number.NaN : t;
}

/** The set of methods a cache may serve/store (safe + reusable by spec). */
const CACHEABLE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);
const STORABLE_STATUS: ReadonlySet<number> = new Set([200, 203, 204, 206, 301, 308, 404, 410]);

export class HttpCache {
  readonly #entries = new Map<string, CacheEntry[]>();

  /** Count of stored entries — diagnostics/tests. */
  get size(): number {
    let n = 0;
    for (const list of this.#entries.values()) n += list.length;
    return n;
  }

  clear(): void {
    this.#entries.clear();
  }

  /**
   * Look up `req` in the cache. `fresh` ⇒ serve without hitting the network;
   * `revalidate` ⇒ the caller must make a conditional request (attach the
   * validators from {@link HttpCache.revalidationHeaders}) and call
   * {@link HttpCache.revalidated} on a 304.
   */
  lookup(url: string, req: NetworkRequest): LookupResult {
    const method = (req.method ?? "GET").toUpperCase();
    if (!CACHEABLE_METHODS.has(method)) return { kind: "miss" };
    const list = this.#entries.get(url);
    if (list === undefined || list.length === 0) return { kind: "miss" };
    const entry = list.find((e) => varyMatches(e, req));
    if (entry === undefined) return { kind: "miss" };
    // A request `Cache-Control: no-cache` forces revalidation regardless.
    const reqCc = parseCacheControl(req.headers?.["cache-control"]);
    if (reqCc.has("no-cache") || reqCc.has("no-store")) {
      return reqCc.has("no-store") ? { kind: "miss" } : { kind: "revalidate", entry };
    }
    return this.#isFresh(entry) ? { kind: "fresh", entry } : { kind: "revalidate", entry };
  }

  /**
   * Store a response under `url` if the response is cacheable. `no-store`
   * (either direction) and `Vary: *` never cache; non-storable statuses drop.
   */
  store(url: string, req: NetworkRequest, res: NetworkResponse): void {
    const method = (req.method ?? "GET").toUpperCase();
    if (!CACHEABLE_METHODS.has(method) || !STORABLE_STATUS.has(res.status)) return;
    const cc = parseCacheControl(res.headers["cache-control"]);
    const reqCc = parseCacheControl(req.headers?.["cache-control"]);
    if (cc.has("no-store") || reqCc.has("no-store")) return;
    const varyHeader = res.headers["vary"];
    const varyFields =
      varyHeader === undefined
        ? []
        : varyHeader.split(",").map((v) => v.trim().toLowerCase()).filter((v) => v !== "");
    if (varyFields.includes("*")) return;
    const varyKey = varyFields
      .map((f) => `${f}=${(req.headers?.[f] ?? "").toLowerCase()}`)
      .sort();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers)) {
      if (k === "set-cookie") continue; // set-cookie is state, not representation
      headers[k] = v;
    }
    const entry: CacheEntry = {
      url,
      status: res.status,
      headers,
      body: res.body,
      storedAt: Date.now(),
      varyKey,
      varyFields,
    };
    const list = this.#entries.get(url) ?? [];
    const idx = list.findIndex((e) => varyMatches(e, req));
    if (idx >= 0) list[idx] = entry;
    else list.push(entry);
    this.#entries.set(url, list);
  }

  /** Conditional request headers for a stale entry. */
  revalidationHeaders(entry: CacheEntry): Record<string, string> {
    const headers: Record<string, string> = {};
    const etag = entry.headers["etag"];
    const lastMod = entry.headers["last-modified"];
    if (etag !== undefined) headers["if-none-match"] = etag;
    if (lastMod !== undefined) headers["if-modified-since"] = lastMod;
    return headers;
  }

  /**
   * A 304 to a conditional request refreshes the stored headers (RFC 9111
   * §4.3.4) and returns the response the caller should serve: stored body,
   * merged headers, status 200.
   */
  revalidated(url: string, req: NetworkRequest, res304: NetworkResponse): NetworkResponse | null {
    const list = this.#entries.get(url);
    const idx = list?.findIndex((e) => varyMatches(e, req)) ?? -1;
    if (list === undefined || idx < 0) return null;
    const merged = { ...list[idx]!.headers };
    for (const [k, v] of Object.entries(res304.headers)) {
      if (k === "set-cookie") continue;
      merged[k] = v;
    }
    const refreshed: CacheEntry = { ...list[idx]!, headers: merged, storedAt: Date.now() };
    list[idx] = refreshed;
    return { url, status: refreshed.status, ok: true, headers: merged, body: refreshed.body };
  }

  /** Rebuild the served response for a fresh hit. */
  toResponse(entry: CacheEntry): NetworkResponse {
    const prior = Number(entry.headers["age"] ?? 0);
    const resident = Math.max(0, Math.floor((Date.now() - entry.storedAt) / 1000));
    const headers = { ...entry.headers, age: String(prior + resident) };
    return { url: entry.url, status: entry.status, ok: entry.status >= 200 && entry.status < 300, headers, body: entry.body };
  }

  #isFresh(entry: CacheEntry): boolean {
    const cc = parseCacheControl(entry.headers["cache-control"]);
    // `no-cache`/`must-revalidate` ⇒ always revalidate when stale (and our
    // entries age, so this effectively means always revalidate once stale).
    if (cc.has("no-cache")) return false;
    const now = Date.now();
    // Freshness lifetime: s-maxage ≻ max-age ≻ Expires ≻ heuristic.
    let lifetime = Number.NaN;
    const sMax = cc.get("s-maxage");
    const maxAge = cc.get("max-age");
    if (typeof sMax === "string") lifetime = Number(sMax) * 1000;
    else if (typeof maxAge === "string") lifetime = Number(maxAge) * 1000;
    else {
      const exp = parseHttpDate(entry.headers["expires"]);
      const date = parseHttpDate(entry.headers["date"]);
      if (!Number.isNaN(exp)) {
        lifetime = exp - (Number.isNaN(date) ? entry.storedAt : date);
      } else {
        const lastMod = parseHttpDate(entry.headers["last-modified"]);
        if (!Number.isNaN(lastMod) && !Number.isNaN(date)) {
          lifetime = Math.max(0, (date - lastMod) * 0.1);
        }
      }
    }
    if (Number.isNaN(lifetime) || lifetime <= 0) return false;
    // Apparent age: now − Date header, corrected by resident time (§4.2.3).
    const date = parseHttpDate(entry.headers["date"]);
    const apparent = Number.isNaN(date) ? 0 : Math.max(0, entry.storedAt - date);
    const age = apparent + (now - entry.storedAt) + Number(entry.headers["age"] ?? 0) * 1000;
    return age < lifetime;
  }
}

function varyMatches(entry: CacheEntry, req: NetworkRequest): boolean {
  if (entry.varyFields.length === 0) return entry.varyKey.length === 0;
  const key = entry.varyFields
    .map((f) => `${f}=${(req.headers?.[f] ?? "").toLowerCase()}`)
    .sort();
  return key.length === entry.varyKey.length && key.every((v, i) => v === entry.varyKey[i]);
}
