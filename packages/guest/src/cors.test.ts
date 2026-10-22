/**
 * RFC 0028 — CORS machinery: safelists, preflight+cache, per-hop ACAO,
 * credentials modes, response filtering, `crossorigin` attribute mapping.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  CORS_SAFELISTED_METHODS,
  CorsCache,
  acaoAllows,
  crossoriginSettings,
  exposedHeaderNames,
  filterCorsResponseHeaders,
  isCorsSafelistedRequestHeader,
  needsCorsPreflight,
  nonSafelistedHeaderNames,
  validatePreflight,
  createBrowserNetworkStack,
  networkStackToBrowserFetch,
} from "./index.js";

const PAGE = "https://page.example/app";
const API = "https://api.example/data";

// ---------- unit: safelist + preflight need ----------

void test("safelist: methods GET/HEAD/POST; headers accept/content-type-limited", () => {
  assert.ok(CORS_SAFELISTED_METHODS.has("GET"));
  assert.ok(isCorsSafelistedRequestHeader("accept", "*/*"));
  assert.ok(isCorsSafelistedRequestHeader("Content-Type", "text/plain; charset=utf-8"));
  assert.ok(!isCorsSafelistedRequestHeader("Content-Type", "application/json"));
  assert.ok(!isCorsSafelistedRequestHeader("X-Requested-With", "fetch"));
  assert.ok(isCorsSafelistedRequestHeader("range", "bytes=0-100"));
  assert.ok(!isCorsSafelistedRequestHeader("range", "bytes=0-100,200-300"));
});

void test("needsPreflight: unsafe method or non-safelisted header", () => {
  assert.equal(needsCorsPreflight("GET", {}), false);
  assert.equal(needsCorsPreflight("PUT", {}), true);
  assert.equal(needsCorsPreflight("POST", { "content-type": "application/json" }), true);
  assert.equal(needsCorsPreflight("POST", { "content-type": "text/plain" }), false);
  assert.deepEqual(nonSafelistedHeaderNames({ "X-B": "1", "content-type": "text/plain", "x-a": "2" }), ["x-a", "x-b"]);
});

void test("acaoAllows: '*', exact origin, credentials require ACC:true", () => {
  assert.equal(acaoAllows({ "access-control-allow-origin": "*" }, "https://a.example", false), true);
  assert.equal(acaoAllows({ "access-control-allow-origin": "*" }, "https://a.example", true), false);
  assert.equal(
    acaoAllows(
      { "access-control-allow-origin": "https://a.example", "access-control-allow-credentials": "true" },
      "https://a.example",
      true,
    ),
    true,
  );
  assert.equal(acaoAllows({ "access-control-allow-origin": "https://b.example" }, "https://a.example", false), false);
  assert.equal(acaoAllows({}, "https://a.example", false), false);
});

void test("validatePreflight: status, method, headers, authorization carve-out", () => {
  const req = { origin: "https://a.example", method: "PUT", headerNames: ["x-api-key"], withCredentials: false };
  const ok = validatePreflight(
    { status: 200, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "*", "access-control-allow-headers": "*" } },
    req,
  );
  assert.equal(ok.ok, true);
  assert.equal(validatePreflight({ status: 404, headers: { "access-control-allow-origin": "*" } }, req).ok, false);
  assert.equal(
    validatePreflight({ status: 200, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET" } }, req).ok,
    false,
  );
  assert.equal(
    validatePreflight({ status: 200, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "*", "access-control-allow-headers": "x-other" } }, req).ok,
    false,
  );
  // `*` does not cover `authorization` (spec carve-out).
  const authReq = { ...req, headerNames: ["authorization"] };
  assert.equal(
    validatePreflight(
      { status: 200, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "*", "access-control-allow-headers": "*" } },
      authReq,
    ).ok,
    false,
  );
});

void test("filterCorsResponseHeaders: safelist ∪ Expose-Headers; '*' covers all", () => {
  const headers = {
    "content-type": "application/json",
    "x-secret": "hidden",
    "x-public": "shown",
    "access-control-expose-headers": "x-public",
  };
  const filtered = filterCorsResponseHeaders(headers);
  assert.equal(filtered["content-type"], "application/json");
  assert.equal(filtered["x-public"], "shown");
  assert.equal(filtered["x-secret"], undefined);
  const all = exposedHeaderNames({ ...headers, "access-control-expose-headers": "*" });
  assert.ok(all.has("x-secret"));
});

void test("CorsCache: covers method+headers, expires, per-credentials key", () => {
  const cache = new CorsCache();
  cache.store("https://a.example", "https://api.example/x", false, {
    "access-control-allow-methods": "PUT, DELETE",
    "access-control-allow-headers": "x-a",
    "access-control-max-age": "60",
  });
  assert.equal(cache.lookup("https://a.example", "https://api.example/x", false, "PUT", ["x-a"]), true);
  assert.equal(cache.lookup("https://a.example", "https://api.example/x", false, "PATCH", []), false);
  assert.equal(cache.lookup("https://a.example", "https://api.example/x", false, "PUT", ["x-b"]), false);
  // Credentialed entries key separately.
  assert.equal(cache.lookup("https://a.example", "https://api.example/x", true, "PUT", ["x-a"]), false);
  // Expired entries miss.
  const stale = new CorsCache();
  stale.store("https://a.example", "https://api.example/x", false, {}, 0);
  assert.equal(stale.lookup("https://a.example", "https://api.example/x", false, "GET", [], Date.now() + 600_000), false);
});

void test("crossoriginSettings: absent→null, anonymous→same-origin, use-credentials→include", () => {
  assert.equal(crossoriginSettings(null), null);
  assert.equal(crossoriginSettings(undefined), null);
  assert.deepEqual(crossoriginSettings(""), { mode: "cors", credentials: "same-origin" });
  assert.deepEqual(crossoriginSettings("anonymous"), { mode: "cors", credentials: "same-origin" });
  assert.deepEqual(crossoriginSettings("bogus"), { mode: "cors", credentials: "same-origin" });
  assert.deepEqual(crossoriginSettings("use-credentials"), { mode: "cors", credentials: "include" });
});

// ---------- stack-level integration (stubbed transport) ----------

interface CapturedReq {
  url: string;
  method: string;
  headers: Record<string, string>;
}

/** Install a stub `fetch` driven by a per-URL responder map; returns the request log. */
async function withStubbedFetch<T>(
  responders: ReadonlyMap<string, (req: CapturedReq) => { status: number; headers?: Record<string, string>; body?: string }>,
  run: () => Promise<T>,
): Promise<{ result: T; requests: CapturedReq[] }> {
  const requests: CapturedReq[] = [];
  const orig = globalThis.fetch;
  const origEnv = process.env["BROWSER_ENGINE_USE_CURL"];
  process.env["BROWSER_ENGINE_USE_CURL"] = "0";
  globalThis.fetch = ((input: unknown, init?: { method?: string; headers?: Record<string, string> }) => {
    const url = typeof input === "string" ? input : (input as URL).href;
    const captured: CapturedReq = {
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      headers: { ...(init?.headers ?? {}) },
    };
    requests.push(captured);
    const responder = responders.get(url);
    if (responder === undefined) return Promise.resolve(new Response("nf", { status: 404 }));
    const r = responder(captured);
    return Promise.resolve(
      new Response(r.body ?? "", {
        status: r.status,
        ...(r.headers !== undefined ? { headers: r.headers } : {}),
      }),
    );
  }) as typeof fetch;
  try {
    return { result: await run(), requests };
  } finally {
    globalThis.fetch = orig;
    if (origEnv === undefined) delete process.env["BROWSER_ENGINE_USE_CURL"];
    else process.env["BROWSER_ENGINE_USE_CURL"] = origEnv;
  }
}

const stack = () => createBrowserNetworkStack({ baseUrl: PAGE });

void test("same-origin GET: no preflight, no CORS gate, full headers visible", async () => {
  const { requests, result } = await withStubbedFetch(
    new Map([[`${PAGE}/self`, () => ({ status: 200, body: "ok", headers: { "x-anything": "1" } })]]),
    () => stack().request({ url: `${PAGE}/self`, mode: "cors", destination: "empty" }),
  );
  assert.equal(result.body.length > 0, true);
  assert.equal(requests.length, 1, "no OPTIONS issued for a same-origin request");
  assert.equal(requests[0]?.method, "GET");
});

void test("cors GET: Origin header sent; missing ACAO rejects; ACAO:* passes", async () => {
  const { requests: denyReqs } = await withStubbedFetch(new Map([[API, () => ({ status: 200, body: "x" })]]), async () => {
    await assert.rejects(() => stack().request({ url: API, mode: "cors", initiator: PAGE }), /cors/i);
  });
  assert.equal(denyReqs.length, 1);
  assert.equal(denyReqs[0]?.headers["origin"], "https://page.example", "Origin rides the cors request");

  const { result } = await withStubbedFetch(
    new Map([[API, () => ({ status: 200, body: "y", headers: { "access-control-allow-origin": "*" } })]]),
    () => stack().request({ url: API, mode: "cors", initiator: PAGE }),
  );
  assert.equal(new TextDecoder().decode(result.body), "y");
});

void test("cors PUT preflights with OPTIONS+ACRM/ACRH; failure rejects before actual request", async () => {
  let s: ReturnType<typeof stack>;
  const { requests } = await withStubbedFetch(
    new Map([
      [API, (req) =>
        req.method === "OPTIONS"
          ? {
              status: 200,
              headers: {
                "access-control-allow-origin": "https://page.example",
                "access-control-allow-methods": "PUT",
                "access-control-allow-headers": "content-type",
              },
            }
          : { status: 200, body: "done", headers: { "access-control-allow-origin": "https://page.example" } }],
    ]),
    async () => {
      s = stack();
      const res = await s.request({
        url: API,
        method: "PUT",
        mode: "cors",
        initiator: PAGE,
        headers: { "content-type": "application/json" },
      });
      return res.status;
    },
  );
  assert.equal(requests[0]?.method, "OPTIONS", "preflight issued first");
  assert.equal(requests[0]?.headers["access-control-request-method"], "PUT");
  assert.equal(requests[0]?.headers["access-control-request-headers"], "content-type");
  assert.equal(requests[1]?.method, "PUT", "actual request follows a passing preflight");
});

void test("failed preflight blocks the actual request entirely", async () => {
  const { requests } = await withStubbedFetch(
    new Map([[API, () => ({ status: 200, body: "x" })]]), // no ACAO anywhere
    async () => {
      await assert.rejects(
        () => stack().request({ url: API, method: "DELETE", mode: "cors", initiator: PAGE }),
        /preflight/i,
      );
    },
  );
  assert.equal(requests.length, 1, "only the OPTIONS hit the wire");
  assert.equal(requests[0]?.method, "OPTIONS");
});

void test("preflight cache: the second PUT sends no OPTIONS", async () => {
  let s: ReturnType<typeof stack>;
  const responders = new Map([
    [API, (req: CapturedReq) =>
      req.method === "OPTIONS"
        ? {
            status: 200,
            headers: {
              "access-control-allow-origin": "*",
              "access-control-allow-methods": "*",
              "access-control-allow-headers": "*",
              "access-control-max-age": "600",
            },
          }
        : { status: 200, body: "done", headers: { "access-control-allow-origin": "*" } }],
  ]);
  const { requests } = await withStubbedFetch(responders, async () => {
    s = stack();
    await s.request({ url: API, method: "PUT", mode: "cors", initiator: PAGE, headers: { "x-a": "1" } });
    await s.request({ url: API, method: "PUT", mode: "cors", initiator: PAGE, headers: { "x-a": "1" } });
  });
  assert.deepEqual(requests.map((r) => r.method), ["OPTIONS", "PUT", "PUT"]);
});

void test("same-origin mode rejects cross-origin without touching the wire", async () => {
  const { requests } = await withStubbedFetch(new Map(), async () => {
    await assert.rejects(
      () => stack().request({ url: API, mode: "same-origin", initiator: PAGE }),
      /same-origin/i,
    );
  });
  assert.equal(requests.length, 0);
});

void test("no-cors strips non-safelisted headers; non-safelisted method rejects", async () => {
  const { requests } = await withStubbedFetch(
    new Map([[API, () => ({ status: 200, body: "ok" })]]),
    async () => {
      await stack().request({
        url: API,
        mode: "no-cors",
        initiator: PAGE,
        headers: { "x-custom": "gone", accept: "kept" },
      });
    },
  );
  assert.equal(requests[0]?.headers["x-custom"], undefined, "non-safelisted header stripped");
  assert.ok(requests[0]?.headers["accept"] !== undefined, "safelisted header survives");

  await withStubbedFetch(new Map(), async () => {
    await assert.rejects(
      () => stack().request({ url: API, method: "DELETE", mode: "no-cors", initiator: PAGE }),
      /no-cors/,
    );
  });
});

void test("credentials: omit suppresses Cookie, same-origin suppresses cross-origin", async () => {
  const responders = new Map<string, (req: CapturedReq) => { status: number; headers?: Record<string, string>; body?: string }>([
    [API, () => ({ status: 200, body: "x", headers: { "access-control-allow-origin": "*" } })],
    // Credentialed responses must echo the origin + ACC:true — `*` can't.
    [`${API}-cred`, (req) => ({
      status: 200,
      body: "x",
      headers: {
        "access-control-allow-origin": req.headers["origin"] ?? "",
        "access-control-allow-credentials": "true",
      },
    })],
  ]);
  const { requests: omitReqs } = await withStubbedFetch(responders, () =>
    stack().request({ url: API, mode: "cors", credentials: "omit", initiator: PAGE, headers: { cookie: "a=b" } }),
  );
  assert.equal(omitReqs[0]?.headers["cookie"], undefined, "omit strips caller cookie");

  const { requests: inclReqs } = await withStubbedFetch(responders, () =>
    stack().request({ url: `${API}-cred`, mode: "cors", credentials: "include", initiator: PAGE, headers: { cookie: "a=b" } }),
  );
  assert.equal(inclReqs[0]?.headers["cookie"], "a=b", "include keeps caller cookie");
});

void test("credentialed cors requires ACAO origin match + ACC:true", async () => {
  await withStubbedFetch(
    new Map([[API, () => ({ status: 200, headers: { "access-control-allow-origin": "*" }, body: "x" })]]),
    () =>
      assert.rejects(
        () => stack().request({ url: API, mode: "cors", credentials: "include", initiator: PAGE }),
        /cors/i,
      ),
  );
});

void test("redirect into a foreign origin without ACAO still fails (per-hop check)", async () => {
  const foreign = "https://evil.example/x";
  const { requests } = await withStubbedFetch(
    new Map<string, (req: CapturedReq) => { status: number; headers?: Record<string, string>; body?: string }>([
      [`${PAGE}/redir`, () => ({ status: 302, headers: { location: foreign } })],
      [foreign, () => ({ status: 200, body: "leak" })], // no ACAO on hop 2
    ]),
    async () => {
      await assert.rejects(() => stack().request({ url: `${PAGE}/redir`, mode: "cors", initiator: PAGE }), /cors/i);
    },
  );
  assert.deepEqual(requests.map((r) => r.url), [`${PAGE}/redir`, foreign]);
});

void test("networkStackToBrowserFetch: no-cors → opaque; cors → filtered headers", async () => {
  let fetch: ReturnType<typeof networkStackToBrowserFetch>;
  const { result } = await withStubbedFetch(
    new Map([
      [API, () => ({ status: 200, body: "x", headers: { "access-control-allow-origin": "*", "x-secret": "s", "x-open": "o", "access-control-expose-headers": "x-open" } })],
    ]),
    async () => {
      fetch = networkStackToBrowserFetch(stack(), PAGE);
      const corsRes = await fetch(API, { mode: "cors" });
      const opaqueRes = await fetch(API, { mode: "no-cors" });
      return { corsRes, opaqueRes };
    },
  );
  assert.equal(result.corsRes.status, 200);
  assert.equal((result.corsRes.headers as { get(n: string): string | null }).get("x-secret"), null, "non-exposed header hidden");
  assert.equal((result.corsRes.headers as { get(n: string): string | null }).get("x-open"), "o", "exposed header visible");
  assert.equal(result.opaqueRes.status, 0, "opaque response status is 0");
  assert.equal(result.opaqueRes.ok, false);
});
