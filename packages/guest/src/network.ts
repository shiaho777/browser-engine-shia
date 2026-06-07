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
import { NotImplemented } from "@browser-engine/ir";

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
