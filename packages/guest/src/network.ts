/**
 * The networking reuse boundary, made physical (tasks 7.7 / 7.8; design.md
 * §3.1.F, §11; Requirements 8.1, 16.5, 16.6).
 *
 * ## Why this module exists — the reuse boundary
 *
 * design.md §11 names the network stack / TLS as "irreducible dirty work" the
 * engine **reuses** rather than reimplements (Requirement 8.1). This module is
 * that boundary, expressed as a single narrow interface — {@link NetworkStack} —
 * so both consumers depend ONLY on the abstract stack, never on a concrete
 * networking implementation:
 *
 *   - guest `fetch` (task 7.7, Requirement 16.5) issues real requests through it;
 *   - `@font-face` web-font loading (task 7.8, Requirement 16.6) downloads font
 *     bytes through the SAME stack.
 *
 * The default adapter ({@link nodeFetchNetworkStack}) delegates to Node's global
 * `fetch` — i.e. the embedded **undici** HTTP client and Node's TLS stack — so
 * the engine reuses a production networking/TLS implementation rather than
 * writing one. Swapping in a different reused client (a libcurl binding, a proxy
 * transport) changes only this adapter; the boundary and its consumers are
 * unaffected.
 *
 * ## No silent stubs (Requirement 5.1, 5.4; design.md §2 bug#4)
 *
 * This deliberately REPLACES the v0 "fetch hard-coded to 404" stub. There is no
 * placeholder response: the default adapter performs a genuine request, and any
 * unsupported path (a non-HTTP(S) scheme, a missing global `fetch`) throws
 * {@link NotImplemented} identifying the gap — never a fabricated success.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotImplemented } from "@browser-engine/ir";
import { makeFetchApi, makeChannelStream } from "./fetch-api.js";
import { DOMException } from "./abort.js";
import { CookieJar } from "./cookie-jar.js";
import { HttpCache, type CacheEntry } from "./http-cache.js";
import {
  CorsCache,
  acaoAllows,
  needsCorsPreflight,
  nonSafelistedHeaderNames,
  validatePreflight,
  filterCorsResponseHeaders,
  CORS_SAFELISTED_METHODS,
  isCorsSafelistedRequestHeader,
} from "./cors.js";
import {
  HstsStore,
  mixedContentVerdict,
} from "./hsts.js";
import {
  coepApplies,
  corpAllows,
  parseCorp,
  parseCoep,
  type Coep,
} from "./coep.js";

/** A minimal, transport-agnostic network request. */
export interface NetworkRequest {
  /** Absolute request URL (the adapter validates the scheme). */
  readonly url: string;
  /** HTTP method; defaults to `GET` when omitted. */
  readonly method?: string;
  /** Request headers as plain name→value pairs. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Optional request body bytes. */
  readonly body?: Uint8Array;
  /**
   * Fetch Metadata destination (Fetch §4.3): "document", "script", "style",
   * "image", "empty", … — real browsers send Sec-Fetch-Dest on every request.
   */
  readonly destination?: string;
  /** Fetch Metadata request mode: "navigate" | "cors" | "no-cors" | "same-origin". */
  readonly mode?: string;
  /**
   * Fetch §4.2 credentials mode: "omit" | "same-origin" | "include".
   * "omit" suppresses Cookie/Authorization on every hop; "same-origin"
   * suppresses them when the target leaves the initiator's origin;
   * "include" attaches credentials even cross-origin (subject to the jar's
   * SameSite rules). Absent ⇒ "same-origin" (the fetch() default).
   */
  readonly credentials?: string;
  /**
   * The URL of the page/frame that caused this request (RFC 0009). Drives
   * Referer computation, SameSite cookie gating, and Sec-Fetch-Site; absent ⇒
   * the stack's `baseUrl` option, else the request is treated as initiatorless.
   */
  readonly initiator?: string;
  /** A Referrer-Policy token (e.g. `strict-origin-when-cross-origin`). */
  readonly referrerPolicy?: string;
  /**
   * RFC 0031: the initiator document's Cross-Origin-Embedder-Policy.
   * `require-corp` gates cross-origin `no-cors` subresources and iframe
   * navigations on `Cross-Origin-Resource-Policy`; `credentialless` strips
   * credentials on those same requests instead of requiring CORP.
   */
  readonly initiatorCoep?: Coep;
  /**
   * RFC 0034 internal marker — set by the registry's `networkFetch` loopback
   * for requests a service worker itself initiated (`fetch(e.request)` inside
   * a `fetch` handler). Skips SW interception so `respondWith(fetch(...))`
   * cannot recurse into the same handler. Not a web-facing field.
   */
  readonly skipServiceWorker?: boolean;
}

/**
 * RFC 0034: the seam between request-level gates and the wire. A handler
 * returns a synthesized {@link NetworkResponse} (from `respondWith`) or
 * `null` to fall through to the HTTP cache + wire. `networkFetch` is the
 * stack's own request path with interception disabled — what the SW realm's
 * `fetch()` resolves to.
 */
export interface ServiceWorkerInterceptor {
  handle(
    req: NetworkRequest,
    networkFetch: (req: NetworkRequest) => Promise<NetworkResponse>,
  ): Promise<NetworkResponse | null>;
}

/** A minimal network response: status, headers, and the raw body bytes. */
export interface NetworkResponse {
  /**
   * The URL that produced this response — the LAST hop under redirects
   * (RFC 0010: navigations commit this URL, not the requested one).
   */
  readonly url: string;
  /** HTTP status code (e.g. 200, 404). */
  readonly status: number;
  /** Whether the status is in the 2xx success range. */
  readonly ok: boolean;
  /** Response headers as plain name→value pairs (lowercased names). */
  readonly headers: Readonly<Record<string, string>>;
  /** The response body bytes (possibly empty). */
  readonly body: Uint8Array;
}

/**
 * The networking boundary (design.md §11). A stack turns a {@link NetworkRequest}
 * into a {@link NetworkResponse}. This is the ONLY surface guest fetch and the
 * web-font loader know about; the concrete stack — the {@link nodeFetchNetworkStack}
 * over reused undici today — is injected, so reuse happens here (Req 8.1).
 */
export interface NetworkStack {
  /** Perform a request and resolve with the response (rejects on transport error). */
  request(req: NetworkRequest): Promise<NetworkResponse>;
}

/** The HTTP(S) schemes the default adapter supports. */
const SUPPORTED_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:"]);

/**
 * The default network stack: delegates to Node's global `fetch` — the embedded
 * **undici** HTTP client + Node TLS — so the engine reuses a real networking
 * implementation (Requirement 8.1). Performs a genuine request; never fabricates
 * a response.
 *
 * @throws NotImplemented if global `fetch` is unavailable (an environment the
 *   engine does not yet support) or the URL scheme is not HTTP(S) — a loud
 *   failure rather than a silent stub (Requirement 5.1).
 */
export const nodeFetchNetworkStack: NetworkStack = {
  async request(req: NetworkRequest): Promise<NetworkResponse> {
    const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
    if (typeof fetchFn !== "function") {
      throw new NotImplemented("network:fetch", {
        category: "other",
        detail: "the host provides no global fetch; a reused HTTP client is required",
      });
    }

    let parsed: URL;
    try {
      parsed = new URL(req.url);
    } catch {
      throw new NotImplemented("network:invalid-url", {
        category: "other",
        detail: `not an absolute URL: ${req.url}`,
      });
    }
    if (!SUPPORTED_SCHEMES.has(parsed.protocol)) {
      throw new NotImplemented(`network:scheme:${parsed.protocol}`, {
        category: "other",
        detail: `only http(s) is supported by the reused stack; got ${parsed.protocol}`,
      });
    }

    const method = (req.method ?? "GET").toUpperCase();
    const init: RequestInit = { method };
    // Browser-default request fingerprint (Fetch §4.3 + UA-CH hints): direct
    // stack users (resource loader, dynamic scripts) send what a real browser
    // sends — no bare requests that bot-walls reject on sight.
    const defaultHeaders: Record<string, string> = {
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      accept:
        req.destination === "script"
          ? "*/*"
          : req.destination === "style"
            ? "text/css,*/*;q=0.1"
            : req.destination === "image"
              ? "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
              : "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"macOS"',
      "sec-fetch-dest": req.destination ?? "empty",
      "sec-fetch-mode": req.mode ?? "cors",
      "sec-fetch-site": secFetchSite(parsed, undefined),
    };
    if (req.mode === "navigate" || req.destination === "document") {
      defaultHeaders["sec-fetch-user"] = "?1";
      defaultHeaders["upgrade-insecure-requests"] = "1";
    }
    init.headers = { ...defaultHeaders, ...(req.headers ?? {}) };
    if (req.body !== undefined) {
      // Copy into a fresh ArrayBuffer-backed view for the fetch body.
      init.body = req.body.slice();
    }

    const response = await fetchFn(parsed.href, init);
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const buffer = new Uint8Array(await response.arrayBuffer());
    return {
      url: response.url || parsed.href,
      status: response.status,
      ok: response.ok,
      headers,
      body: buffer,
    };
  },
};


export const DEFAULT_BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface BrowserNetworkOptions {
  readonly baseUrl?: string;
  readonly jar?: CookieJar;
  /** RFC 0029: injected HSTS store — a session/profile shares one across stacks. */
  readonly hsts?: HstsStore;
  readonly userAgent?: string;
  readonly timeoutMs?: number;
  readonly redirect?: "follow" | "error" | "manual";
  /**
   * RFC 0034: service-worker interception — consulted after the request-level
   * gates (HSTS/mixed-content/same-origin/COEP mode) and BEFORE the HTTP cache
   * consult, matching Fetch's "handle fetch" ordering (the handler may answer
   * from `caches` or synthesize; a null return falls through normally).
   */
  readonly serviceWorker?: ServiceWorkerInterceptor;
  /**
   * RFC 0042: opaque per-stack attachment for the shared-worker registry —
   * the stack itself never reads it; callers who share the stack (a
   * browsing context's documents + same-origin iframes) share its workers.
   */
  readonly sharedWorkers?: unknown;
}

export interface BrowserNetworkStack extends NetworkStack {
  readonly jar: CookieJar;
  readonly events: readonly BrowserNetworkEvent[];
  /** RFC 0040: per-chunk wire-byte progress samples across requests. */
  readonly progress: readonly NetworkProgressEvent[];
  /**
   * RFC 0040: run the full gate pipeline (HSTS/mixed-content/same-origin/
   * CORS-preflight/COEP/redirects/cache/SW interception) but return a LIVE
   * body — `bodyStream` yields wire chunks as they land; `collect()` drains.
   * Cache-hit and SW-synthesized responses still arrive as a one-chunk
   * stream (they never touched the wire). Both transports stream for real:
   * curl runs unbuffered (`-N`, body on stdout, `-D` header file resolves
   * the head), undici keeps `response.body` live.
   */
  requestStream(req: NetworkRequest): Promise<StreamingNetworkResponse>;
  /** The per-stack shared HTTP cache (RFC 0009). */
  readonly cache: HttpCache;
  /** RFC 0029: the stack's HSTS policy store (serialize/restore for persistence). */
  readonly hsts: HstsStore;
  /** RFC 0034: the stack's service-worker interceptor, if one is attached. */
  readonly serviceWorker?: ServiceWorkerInterceptor;
  /** RFC 0042: opaque per-stack shared-worker registry attachment. */
  readonly sharedWorkers?: unknown;
}

export interface BrowserNetworkEvent {
  readonly url: string;
  readonly method: string;
  readonly status: number;
  readonly ok: boolean;
  readonly byteLength: number;
  readonly setCookie: number;
}

/**
 * RFC 0040: a wire-byte progress sample — appended per body chunk as it
 * lands, not after full-buffer collection. `total` is Content-Length when
 * the server declares it, else null (chunked/unknown).
 */
export interface NetworkProgressEvent {
  readonly url: string;
  readonly receivedBytes: number;
  readonly totalBytes: number | null;
}

/** A body that arrives progressively off the wire (RFC 0040). */
export interface StreamingNetworkResponse {
  readonly url: string;
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Record<string, string>;
  /** Body chunks in wire order — pull-driven; blocks until the next lands. */
  readonly bodyStream: AsyncIterable<Uint8Array> & { getReader?(): unknown };
  /** Bytes observed so far (monotonically increasing as chunks land). */
  bytesReceived(): number;
  /** Content-Length when declared, else null. */
  readonly totalBytes: number | null;
  /** Drain the remaining stream into a single buffer. */
  collect(): Promise<Uint8Array>;
  /** RFC 0040: abort the wire read — releases the transport (curl child or
   *  undici body) so a cancelled consumer never drains the rest. */
  cancel?(): void;
}

export function createBrowserNetworkStack(options: BrowserNetworkOptions = {}): BrowserNetworkStack {
  const jar = options.jar ?? new CookieJar();
  const userAgent = options.userAgent ?? DEFAULT_BROWSER_UA;
  const baseUrl = options.baseUrl;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const redirect = options.redirect ?? "follow";
  const events: BrowserNetworkEvent[] = [];
  const progress: NetworkProgressEvent[] = [];
  const cache = new HttpCache();
  const hsts = options.hsts ?? new HstsStore();
  const preferCurl = process.env["BROWSER_ENGINE_USE_CURL"] !== "0";

  /**
   * Build headers for ONE hop. `hopUrl` is this hop's target; `refererFrom`
   * is the URL that caused the hop (the initiator page on hop 0, the previous
   * response URL on redirects); `credentialsAllowed` (credentials mode +
   * per-hop origin relation) removes caller-supplied Cookie/Authorization AND
   * suppresses the jar attach (Fetch §4.4.17 + credentials mode).
   * `stripNonCorsHeaders` (no-cors mode) drops every non-safelisted caller
   * header per Fetch §"CORS-safelisted request-header".
   */
  function buildHeaders(
    req: NetworkRequest,
    hopUrl: URL,
    refererFrom: string | undefined,
    credentialsAllowed: boolean,
    hopMethod?: string,
    stripNonCorsHeaders = false,
  ): Record<string, string> {
    const method = (hopMethod ?? req.method ?? "GET").toUpperCase();
    const initiator = req.initiator ?? baseUrl;
    const callerHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      if (stripNonCorsHeaders && !isCorsSafelistedRequestHeader(k, v)) continue;
      callerHeaders[k] = v;
    }
    if (!credentialsAllowed) {
      for (const k of Object.keys(callerHeaders)) {
        const lk = k.toLowerCase();
        if (lk === "cookie" || lk === "authorization" || lk === "proxy-authorization") {
          delete callerHeaders[k];
        }
      }
    }
    const headers: Record<string, string> = {
      accept:
        method === "GET" || method === "HEAD"
          ? "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8"
          : "*/*",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      "user-agent": userAgent,
      "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"macOS"',
      "upgrade-insecure-requests": "1",
      // Fetch Metadata (Fetch §4.3): Chrome sends Sec-Fetch-* on every request
      // and server bot-walls gate on them. dest/mode come from the request
      // when known; navigations default to document/navigate.
      "sec-fetch-dest": req.destination ?? (method === "GET" && req.mode === undefined ? "document" : "empty"),
      "sec-fetch-mode": req.mode ?? (req.destination === undefined && method === "GET" ? "navigate" : "cors"),
      "sec-fetch-site": secFetchSite(hopUrl, initiator),
      ...callerHeaders,
    };
    // sec-fetch-user is sent ONLY on navigations (Fetch Metadata: user activation hint)
    if (req.mode === "navigate" || req.destination === "document") {
      headers["sec-fetch-user"] = "?1";
    }
    for (const key of Object.keys(headers)) {
      if (headers[key] === undefined) delete headers[key];
    }
    const lower = new Set(Object.keys(headers).map((k) => k.toLowerCase()));
    if (!lower.has("user-agent")) headers["user-agent"] = userAgent;
    if (initiator !== undefined) {
      try {
        const base = new URL(initiator);
        if (!lower.has("referer")) {
          const referer = computeReferer(
            req.referrerPolicy ?? DEFAULT_REFERRER_POLICY,
            refererFrom,
            hopUrl,
          );
          if (referer !== null) headers["referer"] = referer;
        }
        // Origin rides every CORS-mode request (Fetch §3.2.3) and every
        // non-GET/HEAD request (same-origin POSTs already carried it).
        if (!lower.has("origin") && (req.mode === "cors" || (method !== "GET" && method !== "HEAD"))) {
          headers["origin"] = base.origin;
        }
      } catch {
        // Invalid URL input: keep the raw/fallback value.
      }
    }
    if (!lower.has("cookie") && credentialsAllowed) {
      const cookie = jar.cookieHeader(hopUrl.href, {
        initiator,
        topLevelNavigate: req.mode === "navigate" || req.destination === "document",
      });
      if (cookie !== "") headers["cookie"] = cookie;
    }
    return headers;
  }

  function recordAndReturn(
    url: string,
    method: string,
    status: number,
    headers: Record<string, string>,
    body: Uint8Array,
    setCookieCount: number,
  ): NetworkResponse {
    events.push({
      url,
      method,
      status,
      ok: status >= 200 && status < 300,
      byteLength: body.byteLength,
      setCookie: setCookieCount,
    });
    return {
      url,
      status,
      ok: status >= 200 && status < 300,
      headers,
      body,
    };
  }

  async function requestViaCurl(
    parsed: URL,
    method: string,
    headers: Record<string, string>,
    body: Uint8Array | undefined,
  ): Promise<NetworkResponse | null> {
    if (!preferCurl || !curlIsAvailable()) return null;
    const dir = mkdtempSync(join(tmpdir(), "be-net-"));
    const headerPath = join(dir, "headers.txt");
    const bodyPath = join(dir, "body.bin");
    const bodyInPath = join(dir, "body-in.bin");
    try {
      const args: string[] = [
        "-sS",
        "--compressed",
        "-D",
        headerPath,
        "-o",
        bodyPath,
        "-w",
        "%{http_code}\\n%{url_effective}",
        "--max-time",
        String(Math.max(1, Math.ceil(timeoutMs / 1000))),
        "-X",
        method,
        "-A",
        userAgent,
      ];
      // No `-L`: the stack owns the redirect loop so per-hop header/cookie
      // semantics are identical across transports (RFC 0009).
      for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === "user-agent") continue;
        args.push("-H", `${key}: ${value}`);
      }
      if (body !== undefined && body.byteLength > 0) {
        writeFileSync(bodyInPath, body);
        args.push("--data-binary", `@${bodyInPath}`);
      }
      args.push(parsed.href);
      const result = await runCurl(args, timeoutMs + 2_000);
      if (result.code !== 0 && result.stdout.trim() === "") {
        return null;
      }
      const lines = result.stdout.trim().split("\n");
      const statusLine = lines.length >= 2 ? lines[lines.length - 2]! : lines[0] ?? "0";
      const effectiveUrl = lines.length >= 2 ? lines[lines.length - 1]! : parsed.href;
      const status = Number(statusLine) || 0;
      let rawHeaders = "";
      try {
        rawHeaders = readFileSync(headerPath, "utf8");
      } catch {
        rawHeaders = "";
      }
      const headerBlocks = rawHeaders.split(/\r?\n\r?\n/).filter((b) => b.trim().length > 0);
      const lastBlock = headerBlocks[headerBlocks.length - 1] ?? "";
      const outHeaders: Record<string, string> = {};
      const setCookies: string[] = [];
      for (const line of lastBlock.split(/\r?\n/)) {
        const idx = line.indexOf(":");
        if (idx <= 0) continue;
        const name = line.slice(0, idx).trim().toLowerCase();
        const value = line.slice(idx + 1).trim();
        if (name === "set-cookie") {
          setCookies.push(value);
          const prev = outHeaders["set-cookie"];
          outHeaders["set-cookie"] = prev ? `${prev},${value}` : value;
        } else {
          outHeaders[name] = value;
        }
      }
      if (setCookies.length > 0) {
        jar.storeFromSetCookie(effectiveUrl || parsed.href, setCookies);
      }
      let buffer = new Uint8Array(0);
      try {
        buffer = new Uint8Array(readFileSync(bodyPath));
      } catch {
        buffer = new Uint8Array(0);
      }
      return recordAndReturn(effectiveUrl || parsed.href, method, status, outHeaders, buffer, setCookies.length);
    } catch {
      return null;
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Guest/page code may throw here; swallowed by design.
      }
    }
  }

  /**
   * RFC 0040: transport-neutral live response head — headers/status resolved,
   * body still on the wire as a pull stream. Both transports (undici, curl
   * subprocess) produce this shape; `chunks` yields wire bytes as they land
   * and `cancel` aborts a partially-consumed body + releases the transport.
   */
  interface LiveHead {
    readonly url: string;
    readonly status: number;
    readonly headers: Record<string, string>;
    readonly setCookieCount: number;
    readonly chunks: AsyncIterable<Uint8Array>;
    readonly cancel: () => void;
  }

  /**
   * RFC 0040: undici leg — resolve at headers, keep `response.body` live.
   * Buffered callers drain it via `bufferBody` below.
   */
  async function requestHeadViaFetch(
    parsed: URL,
    method: string,
    headers: Record<string, string>,
    body: Uint8Array | undefined,
  ): Promise<LiveHead> {
    const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
    if (typeof fetchFn !== "function") {
      throw new NotImplemented("network:fetch", {
        category: "other",
        detail: "the host provides no global fetch; a reused HTTP client is required",
      });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const init: RequestInit = {
        method,
        headers,
        // "manual" — the stack owns the redirect loop (RFC 0009): per-hop
        // header re-derivation, credential stripping, and Set-Cookie storage.
        redirect: "manual",
        signal: controller.signal,
      };
      if (body !== undefined) {
        init.body = body.slice();
      }
      const response = await fetchFn(parsed.href, init);
      const setCookie =
        typeof response.headers.getSetCookie === "function"
          ? response.headers.getSetCookie()
          : [];
      if (setCookie.length > 0) {
        jar.storeFromSetCookie(response.url || parsed.href, setCookie);
      } else {
        const single = response.headers.get("set-cookie");
        if (single !== null && single !== "") {
          jar.storeFromSetCookie(response.url || parsed.href, [single]);
        }
      }
      const outHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        outHeaders[key.toLowerCase()] = value;
      });
      const stream = response.body;
      let finished = false;
      const cancel = (): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        void stream?.cancel().catch(() => undefined);
      };
      const chunks = (async function* (): AsyncGenerator<Uint8Array> {
        try {
          if (stream === null) return;
          const reader = stream.getReader();
          for (;;) {
            const chunk = (await reader.read()) as { value?: Uint8Array; done: boolean };
            if (chunk.done) break;
            if (chunk.value !== undefined) yield chunk.value;
          }
        } finally {
          finished = true;
          clearTimeout(timer);
        }
      })();
      return {
        url: response.url || parsed.href,
        status: response.status,
        headers: outHeaders,
        setCookieCount: setCookie.length,
        chunks,
        cancel,
      };
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }

  /**
   * RFC 0040: the curl leg, streamed — curl runs `-N` (unbuffered) with the
   * body on stdout; `-D` lands the header block on disk so the head resolves
   * the moment the header terminator appears. stdout chunks are the wire
   * body; `cancel` kills the process.
   */
  async function requestHeadViaCurl(
    parsed: URL,
    method: string,
    headers: Record<string, string>,
    body: Uint8Array | undefined,
  ): Promise<LiveHead | null> {
    if (!preferCurl || !curlIsAvailable()) return null;
    const dir = mkdtempSync(join(tmpdir(), "be-net-stream-"));
    const headerPath = join(dir, "headers.txt");
    const bodyInPath = join(dir, "body-in.bin");
    const args: string[] = [
      "-sS",
      "-N",
      "--compressed",
      "-D",
      headerPath,
      "-o",
      "-",
      "--max-time",
      String(Math.max(1, Math.ceil(timeoutMs / 1000))),
      "-X",
      method,
      "-A",
      userAgent,
    ];
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === "user-agent") continue;
      args.push("-H", `${key}: ${value}`);
    }
    if (body !== undefined && body.byteLength > 0) {
      writeFileSync(bodyInPath, body);
      args.push("--data-binary", `@${bodyInPath}`);
    }
    args.push(parsed.href);
    const proc = spawn("curl", args, { stdio: ["ignore", "pipe", "ignore"] });
    const cleanup = (): void => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Guest/page code may throw here; swallowed by design.
      }
    };
    // Wait for curl to land a complete header block (or die trying).
    const deadline = Date.now() + timeoutMs;
    let exited = false;
    let exitCode: number | null = null;
    proc.on("exit", (code) => {
      exited = true;
      exitCode = code;
    });
    proc.on("error", () => {
      // spawn failure (ENOENT etc.) — treat as exited; the head poll falls
      // through to the undici leg.
      exited = true;
    });
    // Wire the stdout feed into a pull queue IMMEDIATELY — a fast local
    // response can complete AND close the process before the header poll
    // returns; listeners attached afterwards would miss data/end/close and
    // the consumer would sleep on a dead stream. Waiters is a LIST: every
    // event notifies all suspended readers, so a wakeup can never land in
    // the gap between a reader's empty-check and its suspension.
    const queue: Uint8Array[] = [];
    const waiters: Array<() => void> = [];
    let streamDone = false;
    let streamError: unknown = null;
    const notify = (): void => {
      const pending = waiters.splice(0);
      for (const w of pending) w();
    };
    proc.stdout.on("data", (chunk: Buffer) => {
      queue.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      notify();
    });
    proc.stdout.on("end", () => {
      streamDone = true;
      notify();
    });
    proc.stdout.on("error", (e) => {
      streamError = e;
      streamDone = true;
      notify();
    });
    proc.on("close", () => {
      streamDone = true;
      notify();
      cleanup();
    });
    let rawHeaders = "";
    for (;;) {
      try {
        rawHeaders = readFileSync(headerPath, "utf8");
      } catch {
        rawHeaders = "";
      }
      const blocks = rawHeaders.split(/\r?\n\r?\n/).filter((b) => b.trim().length > 0);
      const last = blocks[blocks.length - 1] ?? "";
      // A complete response block starts with the status line and the file
      // ends at (or past) the blank line that terminates it.
      if (/^HTTP\/\d/.test(last.trimStart()) && /\r?\n\r?\n$/.test(rawHeaders)) break;
      if (exited) {
        cleanup();
        return null;
      }
      if (Date.now() > deadline) {
        proc.kill();
        cleanup();
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const blocks = rawHeaders.split(/\r?\n\r?\n/).filter((b) => b.trim().length > 0);
    const lastBlock = blocks[blocks.length - 1] ?? "";
    const blockLines = lastBlock.split(/\r?\n/);
    const statusMatch = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(blockLines[0] ?? "");
    const status = statusMatch !== null ? Number(statusMatch[1]) : 0;
    const outHeaders: Record<string, string> = {};
    const setCookies: string[] = [];
    for (const line of blockLines.slice(1)) {
      const idx = line.indexOf(":");
      if (idx <= 0) continue;
      const name = line.slice(0, idx).trim().toLowerCase();
      const value = line.slice(idx + 1).trim();
      if (name === "set-cookie") {
        setCookies.push(value);
        const prev = outHeaders["set-cookie"];
        outHeaders["set-cookie"] = prev ? `${prev},${value}` : value;
      } else {
        outHeaders[name] = value;
      }
    }
    if (setCookies.length > 0) {
      jar.storeFromSetCookie(parsed.href, setCookies);
    }
    if (exited && exitCode !== 0) {
      cleanup();
      return null;
    }
    let cancelled = false;
    const cancel = (): void => {
      if (cancelled) return;
      cancelled = true;
      streamDone = true;
      try {
        proc.kill();
      } catch {
        // Already exited — kill() on a dead child is a no-op on POSIX but
        // throws on some platforms; either way the transport is gone.
      }
      notify();
      cleanup();
    };
    const chunks = (async function* (): AsyncGenerator<Uint8Array> {
      try {
        for (;;) {
          const next = queue.shift();
          if (next !== undefined) {
            yield next;
            continue;
          }
          if (streamDone) {
            if (streamError !== null) {
              throw streamError instanceof Error
                ? streamError
                : new Error(JSON.stringify(streamError));
            }
            if (!cancelled && exitCode !== null && exitCode !== 0) {
              throw new Error(`network:curl exited ${String(exitCode)} mid-body`);
            }
            return;
          }
          await new Promise<void>((resolve) => {
            waiters.push(resolve);
          });
        }
      } finally {
        cancel();
      }
    })();
    return {
      url: parsed.href,
      status,
      headers: outHeaders,
      setCookieCount: setCookies.length,
      chunks,
      cancel,
    };
  }

  /** Drain a response body into one buffer, emitting per-chunk progress. */
  async function bufferBody(head: LiveHead): Promise<Uint8Array> {
    const total = Number.parseInt(head.headers["content-length"] ?? "", 10);
    const totalBytes = Number.isFinite(total) ? total : null;
    let received = 0;
    const parts: Uint8Array[] = [];
    try {
      for await (const value of head.chunks) {
        parts.push(value);
        received += value.byteLength;
        progress.push({ url: head.url, receivedBytes: received, totalBytes });
      }
    } finally {
      head.cancel();
    }
    const out = new Uint8Array(received);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.byteLength;
    }
    return out;
  }

  async function requestViaFetch(
    parsed: URL,
    method: string,
    headers: Record<string, string>,
    body: Uint8Array | undefined,
  ): Promise<NetworkResponse> {
    const head = await requestHeadViaFetch(parsed, method, headers, body);
    const buffer = await bufferBody(head);
    return recordAndReturn(
      head.url,
      method,
      head.status,
      head.headers,
      buffer,
      head.setCookieCount,
    );
  }

  /** RFC 0040: build the live-body response for a stream-mode final hop.
   *  The event record and HTTP-cache store happen when the stream completes
   *  inside `collect()` — a partially consumed body is never cached. */
  function streamingResult(
    head: LiveHead,
    requestedUrl: string,
    req: NetworkRequest,
    landed: URL,
  ): StreamingNetworkResponse {
    const total = Number.parseInt(head.headers["content-length"] ?? "", 10);
    const totalBytes = Number.isFinite(total) ? total : null;
    let received = 0;
    let recorded = false;
    const finish = (collected: Uint8Array): void => {
      if (recorded) return;
      recorded = true;
      events.push({
        url: head.url,
        method: req.method ?? "GET",
        status: head.status,
        ok: head.status >= 200 && head.status < 300,
        byteLength: collected.byteLength,
        setCookie: head.setCookieCount,
      });
      const live: NetworkResponse = {
        url: head.url,
        status: head.status,
        ok: head.status >= 200 && head.status < 300,
        headers: head.headers,
        body: collected,
      };
      cache.store(requestedUrl, req, live);
      if (landed.href !== requestedUrl) cache.store(landed.href, req, live);
    };
    const bodyStream = (async function* (): AsyncGenerator<Uint8Array> {
      try {
        for await (const value of head.chunks) {
          received += value.byteLength;
          progress.push({ url: head.url, receivedBytes: received, totalBytes });
          yield value;
        }
      } finally {
        head.cancel();
      }
    })() as AsyncIterable<Uint8Array> & { getReader?(): unknown };
    return {
      url: head.url,
      status: head.status,
      ok: head.status >= 200 && head.status < 300,
      headers: head.headers,
      bodyStream,
      bytesReceived: () => received,
      totalBytes,
      cancel: () => head.cancel(),
      async collect(): Promise<Uint8Array> {
        const parts: Uint8Array[] = [];
        for await (const chunk of bodyStream) parts.push(chunk);
        const out = new Uint8Array(received);
        let off = 0;
        for (const p of parts) {
          out.set(p, off);
          off += p.byteLength;
        }
        finish(out);
        return out;
      },
    };
  }

  /** RFC 0028: the CORS-preflight cache — one per stack (per user agent). */
  const corsCache = new CorsCache();

  /**
   * RFC 0028: an OPTIONS preflight rides the SAME transports (curl or undici)
   * so TLS/proxy behavior matches actual requests. Single hop — a redirected
   * preflight fails its 2xx check rather than re-preflighting (conservative;
   * documented bound).
   */
  async function corsPreflight(
    target: URL,
    method: string,
    requestHeaders: Readonly<Record<string, string>>,
    origin: string,
    withCredentials: boolean,
  ): Promise<{ ok: boolean; reason?: string }> {
    const headerNames = nonSafelistedHeaderNames(requestHeaders);
    const headers: Record<string, string> = {
      origin,
      "access-control-request-method": method,
      accept: "*/*",
      "user-agent": userAgent,
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
    };
    if (headerNames.length > 0) {
      headers["access-control-request-headers"] = headerNames.join(",");
    }
    const viaCurl = await requestViaCurl(target, "OPTIONS", headers, undefined);
    const res = viaCurl ?? (await requestViaFetch(target, "OPTIONS", headers, undefined));
    if (target.protocol === "https:") {
      hsts.observe(target.hostname, res.headers["strict-transport-security"]);
    }
    const verdict = validatePreflight(res, {
      origin,
      method,
      headerNames,
      withCredentials,
    });
    if (verdict.ok) {
      corsCache.store(origin, target.href, withCredentials, res.headers);
    }
    return verdict;
  }

  const stack: BrowserNetworkStack = {
    jar,
    cache,
    hsts,
    ...(options.serviceWorker !== undefined ? { serviceWorker: options.serviceWorker } : {}),
    ...(options.sharedWorkers !== undefined ? { sharedWorkers: options.sharedWorkers } : {}),
    get events() {
      return events;
    },
    get progress() {
      return progress;
    },
    async request(req: NetworkRequest): Promise<NetworkResponse> {
      const out = await requestImpl(req, false);
      return out as NetworkResponse;
    },
    async requestStream(req: NetworkRequest): Promise<StreamingNetworkResponse> {
      const out = await requestImpl(req, true);
      if ((out as StreamingNetworkResponse).bodyStream !== undefined) {
        return out as StreamingNetworkResponse;
      }
      // Cache hits, SW-synthesized answers and 304 merges never touched the
      // wire — the buffered payload is replayed as a one-chunk stream so the
      // consumer-facing contract stays uniform.
      const buffered = out as NetworkResponse;
      const total = buffered.body.byteLength;
      let received = 0;
      const bodyStream = (async function* (): AsyncGenerator<Uint8Array> {
        await Promise.resolve(); // yield asynchronously like a wire chunk
        received = total;
        progress.push({ url: buffered.url, receivedBytes: total, totalBytes: total });
        yield buffered.body;
      })();
      return {
        url: buffered.url,
        status: buffered.status,
        ok: buffered.ok,
        headers: buffered.headers,
        bodyStream,
        bytesReceived: () => received,
        totalBytes: total,
        cancel: () => undefined,
        collect: () => Promise.resolve(buffered.body),
      };
    },
  };
  return stack;

  async function requestImpl(req: NetworkRequest, streamBody: boolean): Promise<NetworkResponse | StreamingNetworkResponse> {
      let parsed: URL;
      try {
        parsed = new URL(req.url);
      } catch {
        try {
          const base = baseUrl ?? "https://localhost/";
          parsed = new URL(req.url, base);
        } catch {
          throw new NotImplemented("network:invalid-url", {
            category: "other",
            detail: `not an absolute URL: ${req.url}`,
          });
        }
      }
      if (!SUPPORTED_SCHEMES.has(parsed.protocol)) {
        throw new NotImplemented(`network:scheme:${parsed.protocol}`, {
          category: "other",
          detail: `only http(s) is supported by the reused stack; got ${parsed.protocol}`,
        });
      }
      let method = (req.method ?? "GET").toUpperCase();
      let body = req.body;
      // RFC 0028: CORS mode + credentials mode resolved once per request.
      // The initiator's ORIGIN is the CORS principal; initiatorless requests
      // (internal callers) skip CORS entirely.
      const mode = req.mode ?? (req.destination === undefined && method === "GET" ? "navigate" : "cors");
      const credentials = req.credentials ?? "same-origin";
      const initiator = req.initiator ?? baseUrl;
      let origin: string | null = null;
      try {
        if (initiator !== undefined) origin = new URL(initiator).origin;
      } catch {
        origin = null;
      }
      // RFC 0029: HSTS upgrades http: → https: BEFORE any policy check or
      // wire byte — navigations and subresources alike; everything below
      // (CORS origin math, cache key, Referer) sees the UPGRADED URL.
      if (parsed.protocol === "http:" && hsts.shouldUpgrade(parsed.hostname)) {
        parsed.protocol = "https:";
      }
      // RFC 0029: baseline Mixed Content Level 2 — blockable destinations
      // (scripts/styles/frames/fetch…) hard-fail from a secure initiator;
      // optionally-blockable media upgrades a posteriori. Runs AFTER HSTS:
      // an STS-bearing site rescues its own http: subresources.
      const mixed = mixedContentVerdict(parsed.href, initiator, req.destination, mode);
      if (mixed.action === "block") throw new Error(mixed.reason);
      if (mixed.action === "upgrade") parsed = new URL(mixed.url);
      const requestedUrl = parsed.href;
      const crossOriginStart = origin !== null && parsed.origin !== origin;
      if (mode === "same-origin" && crossOriginStart) {
        throw new Error(
          `network:same-origin: cross-origin request to ${parsed.href} blocked (mode "same-origin")`,
        );
      }
      const noCors = mode === "no-cors";
      if (noCors && !CORS_SAFELISTED_METHODS.has(method)) {
        throw new Error(
          `network:no-cors-method: ${method} is not a CORS-safelisted method`,
        );
      }
      // CORS-preflight fetch (Fetch §"CORS-preflight fetch"): only for
      // cors-mode cross-origin requests that aren't trivially safelisted,
      // and only when the cache can't cover (method + non-safelisted headers).
      if (mode === "cors" && crossOriginStart && needsCorsPreflight(method, req.headers ?? {})) {
        const withCredentials = credentials === "include";
        if (!corsCache.lookup(origin!, requestedUrl, withCredentials, method, nonSafelistedHeaderNames(req.headers ?? {}))) {
          const verdict = await corsPreflight(
            parsed,
            method,
            req.headers ?? {},
            origin!,
            withCredentials,
          );
          if (!verdict.ok) {
            throw new Error(
              `network:cors-preflight: ${verdict.reason ?? "preflight failed"} for ${method} ${requestedUrl}`,
            );
          }
        }
      }
      // RFC 0031 COEP: does this request answer to the initiator's
      // embedder policy? (no-cors subresources + iframe navigations only.)
      const initiatorCoep = req.initiatorCoep ?? "unsafe-none";
      const coepGated =
        initiatorCoep !== "unsafe-none" && coepApplies(mode, req.destination);
      // Per-hop credentials decision: "omit" ⇒ never attach; "same-origin"
      // ⇒ only while the hop stays on the initiator's origin; "include" ⇒
      // always (SameSite rules in the jar still apply on top).
      // COEP `credentialless`: cross-origin hops of gated requests go out
      // anonymous (the whole point of the mode — no CORP needed in return).
      const hopCredentialsAllowed = (): boolean =>
        !(
          coepGated &&
          initiatorCoep === "credentialless" &&
          origin !== null &&
          parsed.origin !== origin
        ) &&
        (credentials === "include" ||
          (credentials === "same-origin" && origin !== null && parsed.origin === origin));
      // RFC 0034: service-worker interception — post request-gates, pre HTTP
      // cache. A synthesized/`caches`-matched answer never reaches the wire;
      // `networkFetch` re-enters request() with the recursion marker set so a
      // handler calling fetch(e.request) passes every gate and hits the wire.
      if (options.serviceWorker !== undefined && req.skipServiceWorker !== true) {
        const networkFetch = (r: NetworkRequest): Promise<NetworkResponse> =>
          stack.request({ ...r, skipServiceWorker: true });
        const synthesized = await options.serviceWorker.handle(req, networkFetch);
        if (synthesized !== null) {
          events.push({
            url: requestedUrl,
            method,
            status: synthesized.status,
            ok: synthesized.ok,
            byteLength: synthesized.body.byteLength,
            setCookie: 0,
          });
          return synthesized;
        }
      }
      // RFC 0009: the redirect loop is ours — every hop re-derives headers for
      // its target origin, stores that hop's Set-Cookie, and rewrites the
      // method per Fetch semantics. Transports follow NOTHING themselves.
      let refererFrom = req.initiator ?? baseUrl;
      // HTTP cache consult (GET/HEAD; keyed on the requested URL).
      let revalidating: CacheEntry | null = null;
      const hit = cache.lookup(requestedUrl, req);
      if (hit.kind === "fresh") {
        const res = cache.toResponse(hit.entry);
        events.push({
          url: requestedUrl,
          method,
          status: res.status,
          ok: res.ok,
          byteLength: res.body.byteLength,
          setCookie: 0,
        });
        return res;
      }
      if (hit.kind === "revalidate") {
        revalidating = hit.entry;
      }
      const MAX_REDIRECTS = 20; // undici's default cap — loop protection.
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const headers = buildHeaders(
          req,
          parsed,
          refererFrom,
          hopCredentialsAllowed(),
          method,
          noCors,
        );
        if (revalidating !== null) {
          Object.assign(headers, cache.revalidationHeaders(revalidating));
        }
        const viaCurl = streamBody ? null : await requestViaCurl(parsed, method, headers, body);
        // RFC 0040: streamed hops try the live curl leg first (unbuffered
        // stdout chunks) and fall back to undici's live ReadableStream —
        // both land as a transport-neutral LiveHead.
        const head =
          viaCurl === null
            ? streamBody
              ? (await requestHeadViaCurl(parsed, method, headers, body)) ??
                (await requestHeadViaFetch(parsed, method, headers, body))
              : await requestHeadViaFetch(parsed, method, headers, body)
            : null;
        const res: NetworkResponse & { readonly live?: LiveHead } =
          viaCurl !== null
            ? viaCurl
            : streamBody && head !== null
              ? {
                  url: head.url,
                  status: head.status,
                  ok: head.status >= 200 && head.status < 300,
                  headers: head.headers,
                  body: new Uint8Array(),
                  live: head,
                }
              : head !== null
                ? recordAndReturn(
                    head.url,
                    method,
                    head.status,
                    head.headers,
                    await bufferBody(head),
                    head.setCookieCount,
                  )
                : await requestViaFetch(parsed, method, headers, body);
        try {
        // RFC 0029: Strict-Transport-Security is honored ONLY over secure
        // transports (RFC 6797 §8.1) — an http hop cannot plant a policy.
        if (parsed.protocol === "https:") {
          hsts.observe(parsed.hostname, res.headers["strict-transport-security"]);
        }
        // RFC 0028: every hop of a cors-mode request that is (or has become)
        // cross-origin must carry a matching ACAO — this is the per-response
        // CORS check, so redirect chains can't launder a foreign payload
        // through an ACAO:* first hop.
        if (mode === "cors" && origin !== null && parsed.origin !== origin) {
          if (!acaoAllows(res.headers, origin, credentials === "include")) {
            throw new Error(
              `network:cors: response from ${parsed.href} lacks Access-Control-Allow-Origin for ${origin}`,
            );
          }
        }
        // RFC 0031 COEP `require-corp`: a cross-origin gated response must
        // carry an allowing Cross-Origin-Resource-Policy; iframe subloads
        // additionally need a compatible COEP of their own (the child of a
        // require-corp embedder cannot relax to unsafe-none).
        if (coepGated && origin !== null && parsed.origin !== origin) {
          const corp = parseCorp(res.headers["cross-origin-resource-policy"]);
          if (initiatorCoep === "require-corp" && !corpAllows(corp, initiator ?? "", parsed.href)) {
            throw new Error(
              `network:coep: response from ${parsed.href} lacks an allowing Cross-Origin-Resource-Policy (initiator require-corp)`,
            );
          }
          if (req.destination === "iframe" && initiatorCoep === "require-corp") {
            const childCoep = parseCoep(res.headers["cross-origin-embedder-policy"]);
            if (childCoep === "unsafe-none") {
              throw new Error(
                `network:coep: cross-origin iframe ${parsed.href} lacks Cross-Origin-Embedder-Policy under a require-corp embedder`,
              );
            }
          }
        }
        const location = res.headers["location"];
        const canFollow =
          redirect === "follow" &&
          isRedirectStatus(res.status) &&
          location !== undefined &&
          location !== "";
        if (!canFollow) {
          if (redirect === "error" && isRedirectStatus(res.status)) {
            throw new NotImplemented("network:redirect-error", {
              category: "other",
              detail: `redirect mode "error" hit a ${res.status} for ${parsed.href}`,
            });
          }
          // A 304 answering our conditional request reuses the stored body.
          if (res.status === 304 && revalidating !== null) {
            if (res.live !== undefined) {
              res.live.cancel();
            }
            const merged = cache.revalidated(requestedUrl, req, res);
            if (merged !== null) return merged;
          }
          if (nosniffBlocks(req.destination, res.headers)) {
            throw new NotImplemented("network:nosniff", {
              category: "other",
              detail: `X-Content-Type-Options: nosniff blocks ${req.destination ?? "unknown"} response type "${res.headers["content-type"] ?? ""}" for ${parsed.href}`,
            });
          }
          // Cache under the requested URL AND the hop's URL (a redirect's
          // target is itself cacheable). A LIVE leg defers the store to
          // collect() — only a fully drained body is cacheable.
          if (res.live === undefined) {
            cache.store(requestedUrl, req, res);
            if (parsed.href !== requestedUrl) {
              cache.store(parsed.href, req, res);
            }
            return res;
          }
          return streamingResult(res.live, requestedUrl, req, parsed);
        }
        // A redirect hop's live body is never consumed — drop it and its
        // timeout before the next wire hit.
        if (res.live !== undefined) {
          res.live.cancel();
        }
        const next = new URL(location, parsed.href);
        const rewrite = redirectRewrite(res.status, method);
        method = rewrite.method;
        if (rewrite.dropBody) body = undefined;
        refererFrom = parsed.href;
        parsed = next;
        // RFC 0029: redirect hops re-run HSTS + mixed-content — a redirect
        // to http: on a secure page is itself mixed content, and an HSTS
        // target upgrades before the next wire hit.
        if (parsed.protocol === "http:") {
          if (hsts.shouldUpgrade(parsed.hostname)) {
            parsed.protocol = "https:";
          }
          const hopMixed = mixedContentVerdict(parsed.href, initiator, req.destination, mode);
          if (hopMixed.action === "block") throw new Error(hopMixed.reason);
          if (hopMixed.action === "upgrade") parsed = new URL(hopMixed.url);
        }
        revalidating = null;
        } catch (e) {
          // RFC 0040: a gate rejection with a live body in flight releases
          // the transport — a leaking curl child or undici socket hangs the
          // caller's event loop long after the error propagates.
          res.live?.cancel();
          throw e;
        }
      }
      throw new NotImplemented("network:redirect-loop", {
        category: "other",
        detail: `redirect chain exceeded ${MAX_REDIRECTS} hops for ${requestedUrl}`,
      });
    }
}

let curlAvailableCache: boolean | null = null;

function curlIsAvailable(): boolean {
  if (curlAvailableCache !== null) return curlAvailableCache;
  try {
    const result = spawnSync("curl", ["--version"], { encoding: "utf8" });
    curlAvailableCache = result.status === 0;
  } catch {
    curlAvailableCache = false;
  }
  return curlAvailableCache;
}

function runCurl(
  args: readonly string[],
  killAfterMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("curl", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Guest/page code may throw here; swallowed by design.
      }
    }, killAfterMs);
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export function networkStackToFetchFn(
  stack: NetworkStack,
  context: {
    readonly initiator?: string;
    /** Static policy or a lazy getter (document meta may not be parsed yet). */
    readonly referrerPolicy?: string | (() => string | undefined);
    readonly destination?: string;
    /**
     * RFC 0028: fetch `mode`/`credentials` for every request this adapter
     * issues (e.g. `mode:"cors"` + `credentials:"same-origin"` for
     * `@font-face` — fonts are ALWAYS CORS anonymous fetches). Per-URL
     * overrides ride `requestFor` (a `crossorigin` attribute map).
     */
    readonly mode?: string;
    readonly credentials?: string;
    /** Per-URL request overrides — e.g. a crossorigin-attribute map or a
     *  destination map (RFC 0029: mixed content needs the real destination). */
    readonly requestFor?: (
      url: string,
    ) => {
      readonly mode?: string;
      readonly credentials?: string;
      readonly destination?: string;
    } | undefined;
    /**
     * RFC 0031: the document's COEP — forwarded as `initiatorCoep` on every
     * request so require-corp/credentialless rules apply to subresources.
     */
    readonly initiatorCoep?: Coep;
  } = {},
): (url: string) => Promise<Uint8Array | undefined> {
  return async (url: string): Promise<Uint8Array | undefined> => {
    try {
      const policy =
        typeof context.referrerPolicy === "function"
          ? context.referrerPolicy()
          : context.referrerPolicy;
      const perUrl = context.requestFor?.(url);
      const res = await stack.request({
        url,
        ...(context.initiator !== undefined ? { initiator: context.initiator } : {}),
        ...(policy !== undefined ? { referrerPolicy: policy } : {}),
        ...(perUrl?.destination !== undefined || context.destination !== undefined
          ? { destination: perUrl?.destination ?? context.destination! }
          : {}),
        ...(perUrl?.mode !== undefined || context.mode !== undefined
          ? { mode: perUrl?.mode ?? context.mode! }
          : {}),
        ...(perUrl?.credentials !== undefined || context.credentials !== undefined
          ? { credentials: perUrl?.credentials ?? context.credentials! }
          : {}),
        ...(context.initiatorCoep !== undefined
          ? { initiatorCoep: context.initiatorCoep }
          : {}),
      });
      if (!res.ok) return undefined;
      return res.body;
    } catch {
      return undefined;
    }
  };
}


/** Default referrer policy when no meta/attribute overrides (RFC 0009). */
const DEFAULT_REFERRER_POLICY = "strict-origin-when-cross-origin";

/**
 * Referrer computation per Referrer-Policy. `refererFrom` is the URL that
 * caused the request (page/initiator URL, or the previous hop after a
 * redirect); `target` is the request URL. Returns the `Referer` value or null.
 * Downgrade = secure initiator → insecure target.
 */
function computeReferer(policy: string, refererFrom: string | undefined, target: URL): string | null {
  if (refererFrom === undefined) return null;
  let from: URL;
  try {
    from = new URL(refererFrom);
  } catch {
    return null;
  }
  const p = policy.trim().toLowerCase();
  const sameOrigin = from.origin === target.origin;
  const downgrade = from.protocol === "https:" && target.protocol === "http:";
  // Never leak credentials/fragment in a Referer (spec strips them anyway).
  const full = (): string => {
    const u = new URL(from.href);
    u.username = "";
    u.password = "";
    u.hash = "";
    return u.href;
  };
  const origin = (): string => `${from.origin}/`;
  switch (p) {
    case "":
    case "strict-origin-when-cross-origin":
      if (downgrade) return null;
      return sameOrigin ? full() : origin();
    case "no-referrer":
      return null;
    case "no-referrer-when-downgrade":
      return downgrade ? null : full();
    case "origin":
      return origin();
    case "origin-when-cross-origin":
      return sameOrigin ? full() : origin();
    case "same-origin":
      return sameOrigin ? full() : null;
    case "strict-origin":
      return downgrade ? null : origin();
    case "unsafe-url":
      return full();
    default:
      return downgrade ? null : sameOrigin ? full() : origin();
  }
}

/** Whether a response is a redirect the stack should follow. */
function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** Method/body rewrite on redirect (Fetch spec + browser behavior). */
function redirectRewrite(
  status: number,
  method: string,
): { method: string; dropBody: boolean } {
  if (status === 303) {
    return method === "HEAD" ? { method, dropBody: false } : { method: "GET", dropBody: true };
  }
  if ((status === 301 || status === 302) && method === "POST") {
    return { method: "GET", dropBody: true };
  }
  return { method, dropBody: false };
}

const JAVASCRIPT_MIMES: ReadonlySet<string> = new Set([
  "application/javascript",
  "application/ecmascript",
  "application/x-javascript",
  "text/javascript",
  "text/ecmascript",
  "text/jscript",
]);

/**
 * `X-Content-Type-Options: nosniff` enforcement (Fetch §4.4 + WHATWG MIME
 * sniffing): stylesheets must be `text/css`, scripts a JavaScript MIME —
 * anything else is a network-level refusal, never a silent pass.
 */
function nosniffBlocks(destination: string | undefined, headers: Readonly<Record<string, string>>): boolean {
  const nosniff = headers["x-content-type-options"];
  if (nosniff === undefined || !nosniff.toLowerCase().includes("nosniff")) return false;
  const ct = (headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (destination === "style") return ct !== "text/css";
  if (destination === "script") return !JAVASCRIPT_MIMES.has(ct);
  return false;
}

/** Fetch Metadata §4.3 Sec-Fetch-Site: the request initiator's relationship to the target. */
function secFetchSite(parsed: URL, baseUrl: string | undefined): string {
  if (baseUrl === undefined) return "none";
  try {
    const base = new URL(baseUrl);
    if (base.origin === parsed.origin) return "same-origin";
    // same-site = registrable domains equal; approximate with the last two
    // labels (public-suffix-free approximation, matching common cases).
    const siteOf = (host: string): string => {
      const parts = host.split(".");
      return parts.length >= 2 ? parts.slice(-2).join(".") : host;
    };
    return siteOf(base.hostname) === siteOf(parsed.hostname) ? "same-site" : "cross-site";
  } catch {
    return "none";
  }
}

/**
 * `networkStackToBrowserFetch` (RFC 0019): the engine's REAL guest `fetch` —
 * the shared {@link makeFetchApi} facade over {@link NetworkStack.request}.
 *
 * Full init fidelity now reaches the wire: `method`, `headers` (any init
 * shape — tuples, record, Headers), `body` (string/BufferSource/FormData/
 * URLSearchParams), `mode`/`credentials`, `referrerPolicy`; `input` may be a
 * `Request` object. The response is a real guest `Response` instance —
 * `instanceof`, `clone()`, `bodyUsed`, `body` stream, enumerable `headers`
 * (XHR's `getAllResponseHeaders` reads them). `res.url` is the LAST hop —
 * the stack owns the redirect loop, so `redirected` is observable.
 *
 * Honest boundary: `redirect` is stack-level policy (the stack owns per-hop
 * handling); per-request `redirect:"manual"|"error"` isn't switchable yet.
 * `credentials:"omit"` can't retract the cookie jar's existing state — the
 * jar's initiator/scope rules still apply.
 */
export function networkStackToBrowserFetch(
  stack: NetworkStack,
  baseUrl?: string,
  /** RFC 0031: the calling document's COEP — gates cross-origin fetches. */
  initiatorCoep?: Coep,
): (input: unknown, init?: unknown) => Promise<{
  ok: boolean;
  status: number;
  url: string;
  headers: { get: (name: unknown) => string | null; has: (name: unknown) => boolean };
  text: () => Promise<string>;
  json: () => Promise<unknown>;
  arrayBuffer: () => Promise<ArrayBuffer>;
}> {
  const api = makeFetchApi(baseUrl ?? "https://localhost/");
  return api.makeFetch(async (req) => {
    // RFC 0040: streamed stacks resolve at headers — the guest Response's
    // `body` yields wire chunks as they land. Buffered-only stacks (or an
    // adapter that lacks requestStream) keep the old collect-then-serve path.
    const streamingStack =
      typeof (stack as { requestStream?: unknown }).requestStream === "function"
        ? (stack as unknown as { requestStream(r: NetworkRequest): Promise<StreamingNetworkResponse> })
        : null;
    if (streamingStack !== null) {
      const sres = await streamingStack.requestStream({
        url: req.url,
        method: req.method,
        headers: req.headers,
        ...(req.body !== undefined ? { body: req.body } : {}),
        destination: "empty",
        mode: req.mode,
        credentials: req.credentials,
        ...(req.referrer !== "about:client" && req.referrer !== ""
          ? { initiator: req.referrer }
          : baseUrl !== undefined
            ? { initiator: baseUrl }
            : {}),
        ...(req.referrerPolicy !== "" ? { referrerPolicy: req.referrerPolicy } : {}),
        ...(initiatorCoep !== undefined ? { initiatorCoep } : {}),
      });
      if (req.mode === "no-cors") {
        // Opaque: drain silently so the wire releases, surface nothing.
        void sres.collect().catch(() => undefined);
        return {
          status: 0,
          url: "",
          headers: {},
          body: new Uint8Array(0),
          redirected: false,
          type: "opaque",
        };
      }
      // Bridge the wire AsyncIterable into the guest channel stream. A
      // cancelled channel stops the pump, which terminates the wire read
      // (for-await return → transport cancel) instead of draining a body
      // nobody will consume.
      const ch = makeChannelStream();
      ch.onCancel(() => sres.cancel?.());
      // Fetch §4.7.4: abort propagates to the wire — cancel kills the curl
      // child / undici body so the socket is released, not just the promise.
      // Consumers of the partial body reject AbortError, matching Fetch's
      // "abort the fetch" on the response body stream.
      const sig = req.signal as
        | { aborted?: boolean; addEventListener?: (t: string, fn: () => void) => void }
        | null
        | undefined;
      const abortNow = (): void => {
        sres.cancel?.();
        ch.error(new DOMException("The operation was aborted.", "AbortError"));
      };
      if (sig?.aborted === true) {
        abortNow();
      } else {
        sig?.addEventListener?.("abort", abortNow);
      }
      // Pump wire bytes into the guest channel. `ch.closed` short-circuits
      // the loop on consumer cancellation; the for-await return then runs
      // the transport's own cleanup (curl kill / undici body cancel).
      void (async (): Promise<void> => {
        try {
          for await (const chunk of sres.bodyStream) {
            if (ch.closed) return;
            ch.push(chunk);
          }
          ch.close();
        } catch (e) {
          if (!ch.closed) ch.error(e);
        }
      })();
      return {
        status: sres.status,
        url: sres.url,
        headers: req.mode === "cors" ? filterCorsResponseHeaders(sres.headers) : sres.headers,
        body: new Uint8Array(),
        bodyStream: ch,
        redirected: sres.url !== req.url,
        type: req.mode === "cors" ? "cors" : "basic",
      };
    }
    const res = await stack.request({
      url: req.url,
      method: req.method,
      headers: req.headers,
      ...(req.body !== undefined ? { body: req.body } : {}),
      destination: "empty",
      mode: req.mode,
      credentials: req.credentials,
      // The document URL is the initiator (Referer + SameSite gating); an
      // explicit `referrer` overrides it only when set on the request.
      ...(req.referrer !== "about:client" && req.referrer !== ""
        ? { initiator: req.referrer }
        : baseUrl !== undefined
          ? { initiator: baseUrl }
          : {}),
      ...(req.referrerPolicy !== "" ? { referrerPolicy: req.referrerPolicy } : {}),
      ...(initiatorCoep !== undefined ? { initiatorCoep } : {}),
    });
    // RFC 0028: response-type machinery per Fetch §"filtered response".
    // `no-cors` ⇒ OPAQUE — status 0, empty header list, empty body, type
    // "opaque". `cors` ⇒ type "cors" with headers filtered to the exposure
    // safelist ∪ Access-Control-Expose-Headers (the stack already enforced
    // ACAO per hop — reaching here means the check passed).
    if (req.mode === "no-cors") {
      return {
        status: 0,
        url: "",
        headers: {},
        body: new Uint8Array(0),
        redirected: false,
        type: "opaque",
      };
    }
    return {
      status: res.status,
      url: res.url,
      headers: req.mode === "cors" ? filterCorsResponseHeaders(res.headers) : res.headers,
      body: res.body,
      redirected: res.url !== req.url,
      type: req.mode === "cors" ? "cors" : "basic",
    };
  });
}
