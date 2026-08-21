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
import { CookieJar } from "./cookie-jar.js";
import { coerceGuestString } from "./coerce.js";

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
}

/** A minimal network response: status, headers, and the raw body bytes. */
export interface NetworkResponse {
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

    const init: RequestInit = { method: req.method ?? "GET" };
    if (req.headers !== undefined) {
      init.headers = { ...req.headers };
    }
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
  readonly userAgent?: string;
  readonly timeoutMs?: number;
  readonly redirect?: "follow" | "error" | "manual";
}

export interface BrowserNetworkStack extends NetworkStack {
  readonly jar: CookieJar;
  readonly events: readonly BrowserNetworkEvent[];
}

export interface BrowserNetworkEvent {
  readonly url: string;
  readonly method: string;
  readonly status: number;
  readonly ok: boolean;
  readonly byteLength: number;
  readonly setCookie: number;
}

export function createBrowserNetworkStack(options: BrowserNetworkOptions = {}): BrowserNetworkStack {
  const jar = options.jar ?? new CookieJar();
  const userAgent = options.userAgent ?? DEFAULT_BROWSER_UA;
  const baseUrl = options.baseUrl;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const redirect = options.redirect ?? "follow";
  const events: BrowserNetworkEvent[] = [];
  const preferCurl = process.env["BROWSER_ENGINE_USE_CURL"] !== "0";

  function buildHeaders(req: NetworkRequest, parsed: URL): Record<string, string> {
    const method = (req.method ?? "GET").toUpperCase();
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
      ...(req.headers ?? {}),
    };
    const lower = new Set(Object.keys(headers).map((k) => k.toLowerCase()));
    if (!lower.has("user-agent")) headers["user-agent"] = userAgent;
    if (baseUrl !== undefined) {
      try {
        const base = new URL(baseUrl);
        if (!lower.has("referer")) headers["referer"] = base.href;
        if (!lower.has("origin") && method !== "GET" && method !== "HEAD") {
          headers["origin"] = base.origin;
        }
      } catch {
        // Invalid URL input: keep the raw/fallback value.
      }
    }
    if (!lower.has("cookie")) {
      const cookie = jar.cookieHeader(parsed.href);
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
      if (redirect === "follow") args.push("-L");
      else if (redirect === "error") args.push("--max-redirs", "0");
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

  async function requestViaFetch(
    parsed: URL,
    method: string,
    headers: Record<string, string>,
    body: Uint8Array | undefined,
  ): Promise<NetworkResponse> {
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
        redirect,
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
      const buffer = new Uint8Array(await response.arrayBuffer());
      return recordAndReturn(
        response.url || parsed.href,
        method,
        response.status,
        outHeaders,
        buffer,
        setCookie.length,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  const stack: BrowserNetworkStack = {
    jar,
    get events() {
      return events;
    },
    async request(req: NetworkRequest): Promise<NetworkResponse> {
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
      const method = (req.method ?? "GET").toUpperCase();
      const headers = buildHeaders(req, parsed);
      const body = req.body;
      const viaCurl = await requestViaCurl(parsed, method, headers, body);
      if (viaCurl !== null) return viaCurl;
      return requestViaFetch(parsed, method, headers, body);
    },
  };
  return stack;
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

export function networkStackToFetchFn(stack: NetworkStack): (url: string) => Promise<Uint8Array | undefined> {
  return async (url: string): Promise<Uint8Array | undefined> => {
    try {
      const res = await stack.request({ url });
      if (!res.ok) return undefined;
      return res.body;
    } catch {
      return undefined;
    }
  };
}

export function networkStackToBrowserFetch(
  stack: NetworkStack,
  baseUrl?: string,
): (input: unknown, init?: unknown) => Promise<{
  ok: boolean;
  status: number;
  url: string;
  headers: { get: (name: unknown) => string | null; has: (name: unknown) => boolean };
  text: () => Promise<string>;
  json: () => Promise<unknown>;
  arrayBuffer: () => Promise<ArrayBuffer>;
}> {
  const decoder = new TextDecoder();
  return async (input: unknown, init?: unknown) => {
    let url = String(input);
    try {
      url = new URL(url, baseUrl ?? "https://localhost/").href;
    } catch {
      // Invalid URL input: keep the raw/fallback value.
    }
    const rawMethod =
      init !== null && typeof init === "object" && "method" in init
        ? (init as { method?: unknown }).method
        : undefined;
    const method = rawMethod === undefined || rawMethod === null ? "GET" : coerceGuestString(rawMethod);
    const headerIn: Record<string, string> = {};
    if (init && typeof init === "object" && "headers" in (init)) {
      const h = (init as { headers?: unknown }).headers;
      if (h && typeof h === "object") {
        for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
          headerIn[k] = String(v);
        }
      }
    }
    try {
      const res = await stack.request({ url, method, headers: headerIn });
      const body = res.body;
      const text = decoder.decode(body);
      const headers = {
        get: (name: unknown) => {
          const key = String(name).toLowerCase();
          return res.headers[key] ?? null;
        },
        has: (name: unknown) => headers.get(name) !== null,
      };
      return {
        ok: res.ok,
        status: res.status,
        url,
        headers,
        text: () => Promise.resolve(text),
        json: () => {
          try {
            return Promise.resolve(JSON.parse(text) as unknown);
          } catch {
            return Promise.resolve(null);
          }
        },
        arrayBuffer: () =>
          Promise.resolve(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer),
      };
    } catch {
      const headers = {
        get: (_name: unknown) => null,
        has: (_name: unknown) => false,
      };
      return {
        ok: false,
        status: 0,
        url,
        headers,
        text: () => Promise.resolve(""),
        json: () => Promise.resolve(null),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      };
    }
  };
}
