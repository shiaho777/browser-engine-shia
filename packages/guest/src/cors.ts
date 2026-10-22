/**
 * CORS machinery (RFC 0028) — the pure decision half of Fetch §3.3 /
 * HTML's CORS settings attributes. Transport-agnostic: the network stack
 * calls these around its own hop machinery; nothing here performs I/O.
 *
 * Implemented:
 *   - CORS-safelisted methods/headers detection (preflight trigger)
 *   - OPTIONS preflight construction + response validation + cache
 *     (`Access-Control-Max-Age`, 600s cap like shipping browsers)
 *   - per-response `Access-Control-Allow-Origin` / `-Allow-Credentials` check
 *   - response-header exposure filtering (safelist + `Expose-Headers`)
 *   - `crossorigin` attribute → { mode, credentials } mapping
 *
 * Bounds (documented): preflight follows a single OPTIONS hop (redirected
 * preflights are NOT re-preflighted); `Access-Control-Allow-Headers: *` does
 * not cover `authorization` (spec carve-out); private-network access is not
 * modeled; `null` origins (sandboxed/opaque) compare literally like spec.
 */

/** Fetch §CORS-safelisted methods — a request with any other method preflights. */
export const CORS_SAFELISTED_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "POST"]);

/** `Content-Type` values that keep a request safelisted (everything else preflights). */
const SAFELISTED_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "application/x-www-form-urlencoded",
  "multipart/form-data",
  "text/plain",
]);

/** Header names safelisted regardless of value. */
const SAFELISTED_HEADER_NAMES: ReadonlySet<string> = new Set([
  "accept",
  "accept-language",
  "content-language",
  // `range` is safelisted only for a single byte range; handled by value check.
]);

/** Whether (name, value) is a CORS-safelisted request header (Fetch §4.2.3). */
export function isCorsSafelistedRequestHeader(name: string, value: string): boolean {
  const n = name.toLowerCase();
  if (SAFELISTED_HEADER_NAMES.has(n)) return true;
  if (n === "content-type") {
    const mediaType = value.split(";")[0]?.trim().toLowerCase() ?? "";
    return SAFELISTED_CONTENT_TYPES.has(mediaType);
  }
  if (n === "range") {
    // Single byte-range only (`bytes=a-b`); suffix/multi ranges preflight.
    return /^bytes=\d+-\d*$/.test(value.trim());
  }
  return false;
}

/**
 * Forbidden request-header names (Fetch §4.2.2) — guest script can never set
 * these, so they neither trigger preflight nor ride an ACRH list.
 * `authorization` is NOT here: it IS script-settable and therefore always
 * preflights.
 */
const FORBIDDEN_HEADER_NAMES: ReadonlySet<string> = new Set([
  "accept-charset", "accept-encoding", "access-control-request-headers",
  "access-control-request-method", "connection", "content-length", "cookie",
  "cookie2", "date", "dnt", "expect", "host", "keep-alive", "origin",
  "referer", "te", "trailer", "transfer-encoding", "upgrade", "via",
]);

/** A header name that guest fetch must never emit (prefix rules included). */
export function isForbiddenHeaderName(name: string): boolean {
  const n = name.toLowerCase();
  return FORBIDDEN_HEADER_NAMES.has(n) || n.startsWith("proxy-") || n.startsWith("sec-");
}

/** Whether a cors-mode request needs an OPTIONS preflight (Fetch §"CORS-preflight fetch"). */
export function needsCorsPreflight(
  method: string,
  headers: Readonly<Record<string, string>>,
): boolean {
  if (!CORS_SAFELISTED_METHODS.has(method.toUpperCase())) return true;
  for (const [name, value] of Object.entries(headers)) {
    if (isForbiddenHeaderName(name)) continue;
    if (!isCorsSafelistedRequestHeader(name, value)) return true;
  }
  return false;
}

/**
 * `Access-Control-Allow-Origin` (+`-Allow-Credentials` under credentials)
 * verdict for a response. `origin` is the REQUESTER's serialized origin.
 */
export function acaoAllows(
  headers: Readonly<Record<string, string>>,
  origin: string,
  withCredentials: boolean,
): boolean {
  const acao = headers["access-control-allow-origin"];
  if (acao === undefined) return false;
  const value = acao.trim();
  const originOk = value === "*" ? !withCredentials : value === origin;
  if (!originOk) return false;
  if (withCredentials) {
    return headers["access-control-allow-credentials"]?.trim().toLowerCase() === "true";
  }
  return true;
}

/** Comma-list header → lowercased set. */
function listHeader(value: string | undefined): Set<string> {
  const out = new Set<string>();
  if (value === undefined) return out;
  for (const part of value.split(",")) {
    const v = part.trim().toLowerCase();
    if (v !== "") out.add(v);
  }
  return out;
}

export interface PreflightVerdict {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * Validate an OPTIONS preflight response for (method, non-safelisted header
 * names). Origin/ACAO checked identically to an actual response.
 */
export function validatePreflight(
  res: { readonly status: number; readonly headers: Readonly<Record<string, string>> },
  request: {
    readonly origin: string;
    readonly method: string;
    /** The request's NON-safelisted header names (lowercased). */
    readonly headerNames: readonly string[];
    readonly withCredentials: boolean;
  },
): PreflightVerdict {
  if (res.status < 200 || res.status > 299) {
    return { ok: false, reason: `preflight status ${res.status}` };
  }
  if (!acaoAllows(res.headers, request.origin, request.withCredentials)) {
    return { ok: false, reason: "preflight lacks a matching Access-Control-Allow-Origin" };
  }
  const methods = listHeader(res.headers["access-control-allow-methods"]);
  if (!methods.has("*") && !methods.has(request.method.toLowerCase())) {
    return { ok: false, reason: `preflight does not allow method ${request.method}` };
  }
  const headers = listHeader(res.headers["access-control-allow-headers"]);
  const wildcard = headers.has("*");
  for (const name of request.headerNames) {
    // Spec carve-out: `*` in AC-Allow-Headers does NOT cover `authorization`.
    if (wildcard && name !== "authorization") continue;
    if (!headers.has(name)) {
      return { ok: false, reason: `preflight does not allow header ${name}` };
    }
  }
  return { ok: true };
}

/** Response headers a CORS response exposes to guest script (Fetch §"extract a length"). */
const SAFELISTED_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  "cache-control",
  "content-language",
  "content-length",
  "content-type",
  "expires",
  "last-modified",
  "pragma",
]);

/**
 * The header names a `cors`-mode response exposes to guest code: the response
 * safelist ∪ `Access-Control-Expose-Headers` (`*` ⇒ everything, credentials
 * nuance treated as covering all — a documented approximation).
 */
export function exposedHeaderNames(
  headers: Readonly<Record<string, string>>,
): Set<string> {
  const out = new Set<string>(SAFELISTED_RESPONSE_HEADERS);
  const exposed = listHeader(headers["access-control-expose-headers"]);
  if (exposed.has("*")) {
    for (const name of Object.keys(headers)) out.add(name.toLowerCase());
    return out;
  }
  for (const name of exposed) out.add(name);
  return out;
}

/** Filter a raw header map to what guest script may read under `mode: "cors"`. */
export function filterCorsResponseHeaders(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  const allowed = exposedHeaderNames(headers);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (allowed.has(name.toLowerCase())) out[name.toLowerCase()] = value;
  }
  return out;
}

/** The non-safelisted header names a request carries (preflight's ACRH list). */
export function nonSafelistedHeaderNames(
  headers: Readonly<Record<string, string>>,
): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (isForbiddenHeaderName(name)) continue;
    if (!isCorsSafelistedRequestHeader(name, value)) out.push(name.toLowerCase());
  }
  return out.sort();
}

/**
 * The CORS-preflight cache (Fetch §3.3.6). Entries are keyed by
 * (origin, url, credentials?) and expire at `Access-Control-Max-Age`
 * seconds (default 5, capped at 600 — Chromium's cap; the spec allows an
 * implementation-defined maximum).
 */
export class CorsCache {
  readonly #entries = new Map<
    string,
    { readonly methods: ReadonlySet<string>; readonly headers: ReadonlySet<string>; readonly expiresAt: number }
  >();

  static #key(origin: string, url: string, credentials: boolean): string {
    return `${origin}|${url}|${credentials ? "cred" : "anon"}`;
  }

  /** Whether a cached successful preflight covers this (method, headers). */
  lookup(
    origin: string,
    url: string,
    credentials: boolean,
    method: string,
    headerNames: readonly string[],
    now: number = Date.now(),
  ): boolean {
    const entry = this.#entries.get(CorsCache.#key(origin, url, credentials));
    if (entry === undefined) return false;
    if (now >= entry.expiresAt) {
      this.#entries.delete(CorsCache.#key(origin, url, credentials));
      return false;
    }
    if (!entry.methods.has("*") && !entry.methods.has(method.toLowerCase())) return false;
    for (const name of headerNames) {
      if (entry.headers.has("*") && name !== "authorization") continue;
      if (!entry.headers.has(name)) return false;
    }
    return true;
  }

  /** Cache a successful preflight. `maxAge` seconds; default 5, cap 600. */
  store(
    origin: string,
    url: string,
    credentials: boolean,
    preflightHeaders: Readonly<Record<string, string>>,
    now: number = Date.now(),
  ): void {
    const rawAge = Number(preflightHeaders["access-control-max-age"] ?? "5");
    const maxAge = Number.isFinite(rawAge) && rawAge > 0 ? Math.min(rawAge, 600) : 5;
    const methods = listHeader(preflightHeaders["access-control-allow-methods"]);
    const headers = listHeader(preflightHeaders["access-control-allow-headers"]);
    this.#entries.set(CorsCache.#key(origin, url, credentials), {
      methods,
      headers,
      expiresAt: now + maxAge * 1000,
    });
  }

  /** Evict everything (document unload / session teardown). */
  clear(): void {
    this.#entries.clear();
  }
}

export interface CorsSettings {
  readonly mode: "cors";
  readonly credentials: "same-origin" | "include";
}

/**
 * HTML's CORS settings attribute (`crossorigin`): present-but-empty and
 * `anonymous` (or an invalid keyword) map to the Anonymous state —
 * `mode: cors`, credentials `same-origin`; `use-credentials` ⇒ `include`.
 * An ABSENT attribute returns null (caller keeps the element's default
 * fetch mode — `no-cors` for images/stylesheets/scripts).
 */
export function crossoriginSettings(value: string | null | undefined): CorsSettings | null {
  if (value === null || value === undefined) return null;
  return value.toLowerCase() === "use-credentials"
    ? { mode: "cors", credentials: "include" }
    : { mode: "cors", credentials: "same-origin" };
}
