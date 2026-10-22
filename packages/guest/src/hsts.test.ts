/**
 * RFC 0029 — HSTS (RFC 6797) store + baseline Mixed Content Level 2:
 * parsing/storage/expiry, per-hop upgrades, block/upgrade verdicts,
 * stack integration over the redirect loop.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  HstsStore,
  createBrowserNetworkStack,
  isPotentiallyTrustworthyUrl,
  mixedContentVerdict,
} from "./index.js";

const PAGE = "https://page.example/app";

// ---------- unit: HstsStore ----------

void test("observe: max-age stores; host upgrades; unrelated hosts do not", () => {
  const s = new HstsStore();
  s.observe("example.com", "max-age=3600");
  assert.equal(s.shouldUpgrade("example.com"), true);
  assert.equal(s.shouldUpgrade("sub.example.com"), false, "host-only by default");
  assert.equal(s.shouldUpgrade("other.com"), false);
});

void test("observe: includeSubDomains covers descendants but not apex of parents", () => {
  const s = new HstsStore();
  s.observe("example.com", "max-age=3600; includeSubDomains");
  assert.equal(s.shouldUpgrade("a.b.example.com"), true);
  assert.equal(s.shouldUpgrade("example.com"), true);
  assert.equal(s.shouldUpgrade("notexample.com"), false);
});

void test("observe: max-age=0 removes; expiry via now; first max-age wins", () => {
  const s = new HstsStore();
  s.observe("a.com", "max-age=10", 1_000);
  assert.equal(s.shouldUpgrade("a.com", 5_000), true);
  assert.equal(s.shouldUpgrade("a.com", 11_500), false, "expired");
  s.observe("b.com", "max-age=100; max-age=0", 0);
  assert.equal(s.shouldUpgrade("b.com", 50_000), true, "first directive wins (RFC 6797)");
  s.observe("b.com", "max-age=0", 60_000);
  assert.equal(s.shouldUpgrade("b.com", 61_000), false, "max-age=0 clears");
});

void test("serialize/restore round-trip keeps includeSubDomains + remaining age", () => {
  const s = new HstsStore();
  s.observe("x.com", "max-age=60; includeSubDomains", 0);
  const data = s.serialize(10_000);
  assert.equal(data["x.com"]?.maxAgeSeconds, 50);
  const t = new HstsStore();
  t.restore(data, 10_000);
  assert.equal(t.shouldUpgrade("sub.x.com", 20_000), true);
  assert.equal(t.shouldUpgrade("sub.x.com", 70_500), false, "remaining age honored");
});

// ---------- unit: mixed content verdict ----------

void test("potentially trustworthy: https/localhost/loopback/file yes; http/ws no", () => {
  assert.equal(isPotentiallyTrustworthyUrl("https://a.com/x"), true);
  assert.equal(isPotentiallyTrustworthyUrl("http://localhost:8080/"), true);
  assert.equal(isPotentiallyTrustworthyUrl("http://127.0.0.1/"), true);
  assert.equal(isPotentiallyTrustworthyUrl("file:///tmp/a"), true);
  assert.equal(isPotentiallyTrustworthyUrl("http://a.com/"), false);
  assert.equal(isPotentiallyTrustworthyUrl("ws://a.com/"), false);
});

void test("verdict: secure page + http script blocks; image upgrades; nav exempt", () => {
  assert.equal(mixedContentVerdict("http://cdn.example/a.js", PAGE, "script", "no-cors").action, "block");
  assert.equal(mixedContentVerdict("http://cdn.example/xhr", PAGE, "empty", "cors").action, "block");
  const img = mixedContentVerdict("http://cdn.example/a.png", PAGE, "image", "no-cors");
  assert.equal(img.action, "upgrade");
  if (img.action === "upgrade") assert.equal(img.url, "https://cdn.example/a.png");
  assert.equal(
    mixedContentVerdict("http://elsewhere.example/", PAGE, "document", "navigate").action,
    "allow",
    "top-level navigations are never mixed content",
  );
  assert.equal(
    mixedContentVerdict("http://f.example/", PAGE, "iframe", "navigate").action,
    "block",
    "frame subloads are blockable even in navigate mode",
  );
  assert.equal(
    mixedContentVerdict("http://cdn.example/a.js", "http://plain.example/", "script", "no-cors").action,
    "allow",
    "insecure pages load http freely",
  );
});

// ---------- stack integration (undici path, stubbed global fetch) ----------

interface CapturedReq {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
}

type Responder = (req: CapturedReq) => { status: number; headers?: Record<string, string>; body?: string };

async function withStubbedFetch<T>(
  responders: ReadonlyMap<string, Responder>,
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

void test("STS observed on https response → later http request upgrades before the wire", async () => {
  const { requests } = await withStubbedFetch(
    new Map([
      [
        "https://site.example/",
        () => ({ status: 200, headers: { "strict-transport-security": "max-age=600", "content-type": "text/html" }, body: "hi" }),
      ],
      ["https://site.example/next", () => ({ status: 200, body: "upgraded-hit" })],
    ]),
    async () => {
      const s = createBrowserNetworkStack({ baseUrl: PAGE });
      await s.request({ url: "https://site.example/", mode: "navigate", destination: "document" });
      return s.request({ url: "http://site.example/next", mode: "navigate", destination: "document" });
    },
  );
  assert.equal(requests.length, 2);
  assert.equal(requests[1]?.url, "https://site.example/next", "http request rewritten to https");
});

void test("STS header over an INSECURE transport is ignored (RFC 6797 §8.1)", async () => {
  const { requests } = await withStubbedFetch(
    new Map([
      ["http://insecure.example/", () => ({ status: 200, headers: { "strict-transport-security": "max-age=600" }, body: "x" })],
      ["http://insecure.example/two", () => ({ status: 200, body: "y" })],
    ]),
    async () => {
      const s = createBrowserNetworkStack({ baseUrl: "http://a.example/" });
      await s.request({ url: "http://insecure.example/", mode: "navigate", destination: "document", initiator: "http://a.example/" });
      return s.request({ url: "http://insecure.example/two", mode: "navigate", destination: "document", initiator: "http://a.example/" });
    },
  );
  assert.equal(requests[1]?.url, "http://insecure.example/two", "no upgrade — header arrived over http");
});

void test("mixed content: secure initiator + http script rejects before the wire", async () => {
  const { requests } = await withStubbedFetch(new Map(), async () => {
    const s = createBrowserNetworkStack({ baseUrl: PAGE });
    await assert.rejects(
      s.request({ url: "http://cdn.example/a.js", initiator: PAGE, destination: "script", mode: "no-cors" }),
      /mixed-content:block/i,
    );
  });
  assert.equal(requests.length, 0, "blocked without touching the wire");
});

void test("mixed content: http image from secure page upgrades a posteriori", async () => {
  const { requests, result } = await withStubbedFetch(
    new Map([["https://cdn.example/a.png", () => ({ status: 200, body: "png" })]]),
    () =>
      createBrowserNetworkStack({ baseUrl: PAGE }).request({
        url: "http://cdn.example/a.png",
        initiator: PAGE,
        destination: "image",
        mode: "no-cors",
      }),
  );
  assert.equal(requests[0]?.url, "https://cdn.example/a.png");
  assert.equal(new TextDecoder().decode(result.body), "png");
});

void test("redirect hop re-runs policy: https→http redirect blocks for scripts", async () => {
  await withStubbedFetch(
    new Map([
      ["https://cdn.example/a.js", () => ({ status: 302, headers: { location: "http://cdn.example/a.js" } })],
    ]),
    async () => {
      const s = createBrowserNetworkStack({ baseUrl: PAGE });
      await assert.rejects(
        s.request({ url: "https://cdn.example/a.js", initiator: PAGE, destination: "script", mode: "no-cors" }),
        /mixed-content:block/i,
      );
    },
  );
});

void test("redirect hop applies HSTS to a covered target mid-chain", async () => {
  const { requests, result } = await withStubbedFetch(
    new Map<string, Responder>([
      ["https://cdn.example/go", () => ({ status: 302, headers: { location: "http://dest.example/x" } })],
      ["https://dest.example/x", () => ({ status: 200, body: "landed" })],
    ]),
    () => {
      const s = createBrowserNetworkStack({ baseUrl: PAGE });
      s.hsts.observe("dest.example", "max-age=600");
      return s.request({ url: "https://cdn.example/go", initiator: PAGE, destination: "script", mode: "no-cors" });
    },
  );
  assert.equal(requests[1]?.url, "https://dest.example/x", "HSTS covered the redirect target");
  assert.equal(new TextDecoder().decode(result.body), "landed");
});

void test("shared HstsStore: policy learned by one stack applies to the next", async () => {
  const shared = new HstsStore();
  const { requests } = await withStubbedFetch(
    new Map([
      ["https://shared.example/", () => ({ status: 200, headers: { "strict-transport-security": "max-age=600" }, body: "a" })],
      ["https://shared.example/img", () => ({ status: 200, body: "b" })],
    ]),
    async () => {
      const s1 = createBrowserNetworkStack({ baseUrl: PAGE, hsts: shared });
      const s2 = createBrowserNetworkStack({ baseUrl: PAGE, hsts: shared });
      await s1.request({ url: "https://shared.example/", mode: "navigate", destination: "document" });
      return s2.request({ url: "http://shared.example/img", mode: "navigate", destination: "document" });
    },
  );
  assert.equal(requests[1]?.url, "https://shared.example/img", "policy survived the stack boundary (session-level)");
});
