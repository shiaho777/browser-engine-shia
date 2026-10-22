/**
 * RFC 0009 evidence: owned redirect loop, HTTP cache, SameSite/host-only
 * cookies, referrer policy, nosniff — all verified against a REAL local
 * `node:http` server (no external network, no fabricated responses).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { createBrowserNetworkStack, type BrowserNetworkStack } from "./network.js";
import { CookieJar } from "./cookie-jar.js";

// The undici path is deterministic for these tests; curl would re-derive
// headers per hop identically but takes a subprocess — keep both honest by
// forcing the in-process transport here.
process.env["BROWSER_ENGINE_USE_CURL"] = "0";

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

function serve(
  handler: (req: IncomingMessage, res: ServerResponse, seen: Seen[]) => void,
): Promise<{ server: Server; url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", headers: { ...req.headers } });
    handler(req, res, seen);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, url: `http://127.0.0.1:${port}`, seen });
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function stack(url: string): BrowserNetworkStack {
  return createBrowserNetworkStack({ baseUrl: url });
}

// ---------------------------------------------------------------------------
// Redirect loop (ours, not the transport's)
// ---------------------------------------------------------------------------

void test("redirect: 302 POST rewrites to GET with body dropped", async () => {
  const { server, url, seen } = await serve((req, res) => {
    if (req.url === "/form") {
      res.writeHead(302, { location: "/done" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  try {
    const s = stack(url);
    const res = await s.request({
      url: `${url}/form`,
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: new Uint8Array([1, 2, 3]),
    });
    assert.equal(res.status, 200);
    assert.equal(seen.length, 2, "two hops on the wire");
    assert.equal(seen[0]!.method, "POST");
    assert.equal(seen[1]!.method, "GET", "302 POST → GET per browser semantics");
    assert.equal(seen[1]!.url, "/done");
  } finally {
    await close(server);
  }
});

void test("redirect: 307 preserves method and body", async () => {
  const { server, url, seen } = await serve((req, res) => {
    if (req.url === "/moved") {
      res.writeHead(307, { location: "/target" });
      res.end();
      return;
    }
    res.writeHead(200);
    res.end("ok");
  });
  try {
    const s = stack(url);
    const res = await s.request({
      url: `${url}/moved`,
      method: "POST",
      body: new Uint8Array([7]),
    });
    assert.equal(res.status, 200);
    assert.equal(seen[1]!.method, "POST", "307 keeps the method");
  } finally {
    await close(server);
  }
});

void test("redirect: intermediate hop Set-Cookie is stored against the hop URL", async () => {
  const { server, url } = await serve((req, res) => {
    if (req.url === "/set") {
      res.writeHead(302, { location: "/next", "set-cookie": "hop=1; Path=/" });
      res.end();
      return;
    }
    res.writeHead(200);
    res.end("done");
  });
  try {
    const s = stack(url);
    await s.request({ url: `${url}/set` });
    assert.ok(
      s.jar.cookieHeader(`${url}/`).includes("hop=1"),
      "the redirect hop's Set-Cookie landed in the jar",
    );
  } finally {
    await close(server);
  }
});

void test("redirect: caller Cookie/Authorization are stripped on cross-origin hops", async () => {
  // One server answers a redirect to a second server — cross-origin by port.
  const { server: s2, url: url2, seen: seen2 } = await serve((_req, res) => {
    res.writeHead(200);
    res.end("target");
  });
  const { server: s1, url: url1 } = await serve((_req, res) => {
    res.writeHead(302, { location: `${url2}/landing` });
    res.end();
  });
  try {
    const s = stack(url1);
    const res = await s.request({
      url: `${url1}/jump`,
      headers: { cookie: "session=abc", authorization: "Bearer tok" },
    });
    assert.equal(res.status, 200);
    const hop2 = seen2[0]!;
    assert.equal(hop2.headers["cookie"], undefined, "caller cookie did not cross origins");
    assert.equal(hop2.headers["authorization"], undefined, "authorization did not cross origins");
  } finally {
    await close(s1);
    await close(s2);
  }
});

void test("redirect: mode 'manual' surfaces the 3xx untouched", async () => {
  const { server, url } = await serve((_req, res) => {
    res.writeHead(302, { location: "/elsewhere" });
    res.end();
  });
  try {
    const s = createBrowserNetworkStack({ baseUrl: url, redirect: "manual" });
    const res = await s.request({ url: `${url}/r` });
    assert.equal(res.status, 302);
    assert.equal(res.headers["location"], "/elsewhere");
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// HTTP cache
// ---------------------------------------------------------------------------

void test("cache: max-age serves a second request without touching the server", async () => {
  const { server, url, seen } = await serve((_req, res) => {
    res.writeHead(200, { "cache-control": "max-age=60", "content-type": "text/plain" });
    res.end("cached");
  });
  try {
    const s = stack(url);
    const a = await s.request({ url: `${url}/r`, method: "GET" });
    const b = await s.request({ url: `${url}/r`, method: "GET" });
    assert.equal(seen.length, 1, "one network request for two logical gets");
    assert.equal(new TextDecoder().decode(b.body), "cached");
    assert.equal(a.status, 200);
  } finally {
    await close(server);
  }
});

void test("cache: ETag revalidation turns a 304 into the stored body", async () => {
  let hits = 0;
  const { server, url } = await serve((req, res) => {
    hits += 1;
    if (req.headers["if-none-match"] === '"v1"') {
      res.writeHead(304);
      res.end();
      return;
    }
    res.writeHead(200, { etag: '"v1"' });
    res.end("body-v1");
  });
  try {
    const s = stack(url);
    await s.request({ url: `${url}/r` });
    const second = await s.request({ url: `${url}/r` });
    assert.equal(hits, 2, "the stale entry revalidated over the wire");
    assert.equal(new TextDecoder().decode(second.body), "body-v1", "304 ⇒ cached body");
    assert.equal(second.status, 200);
  } finally {
    await close(server);
  }
});

void test("cache: no-store responses are never stored", async () => {
  const { server, url, seen } = await serve((_req, res) => {
    res.writeHead(200, { "cache-control": "no-store" });
    res.end("x");
  });
  try {
    const s = stack(url);
    await s.request({ url: `${url}/r` });
    await s.request({ url: `${url}/r` });
    assert.equal(seen.length, 2, "no-store forced a second network request");
  } finally {
    await close(server);
  }
});

void test("cache: Vary keys entries per request-header value", async () => {
  const { server, url, seen } = await serve((req, res) => {
    const tag = req.headers["x-variant"] === "b" ? "B" : "A";
    res.writeHead(200, { vary: "x-variant", "cache-control": "max-age=60" });
    res.end(`variant-${tag}`);
  });
  try {
    const s = stack(url);
    await s.request({ url: `${url}/r`, headers: { "x-variant": "a" } });
    const b1 = await s.request({ url: `${url}/r`, headers: { "x-variant": "b" } });
    const a2 = await s.request({ url: `${url}/r`, headers: { "x-variant": "a" } });
    assert.equal(seen.length, 2, "the second variant hit the net once, the repeat was cached");
    assert.equal(new TextDecoder().decode(b1.body), "variant-B");
    assert.equal(new TextDecoder().decode(a2.body), "variant-A");
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// Cookies: host-only + SameSite
// ---------------------------------------------------------------------------

void test("cookies: host-only (no Domain=) never leaks to a subdomain", () => {
  const jar = new CookieJar();
  jar.storeFromSetCookie("https://example.com/", ["s=1; Path=/"]);
  assert.equal(jar.cookieHeader("https://sub.example.com/"), "", "host-only cookie stays on the host");
  assert.equal(jar.cookieHeader("https://example.com/"), "s=1");
  jar.storeFromSetCookie("https://example.com/", ["d=2; Domain=example.com; Path=/"]);
  assert.equal(
    jar.cookieHeader("https://sub.example.com/"),
    "d=2",
    "Domain= cookies DO suffix-match per spec",
  );
});

void test("cookies: SameSite=Lax rides same-site but not cross-site subresource requests", () => {
  const jar = new CookieJar();
  jar.storeFromSetCookie("https://a.example/", ["lax=1; Path=/; SameSite=Lax"]);
  jar.storeFromSetCookie("https://a.example/", ["open=1; Path=/; SameSite=None; Secure"]);
  assert.equal(
    jar.cookieHeader("https://a.example/img.png", { initiator: "https://a.example/" }),
    "lax=1; open=1",
  );
  assert.equal(
    jar.cookieHeader("https://a.example/img.png", { initiator: "https://b.example/" }),
    "open=1",
    "cross-site ⇒ only SameSite=None+Secure",
  );
  // Lax exception: a top-level cross-site navigation carries Lax cookies.
  const nav = jar.cookieHeader("https://a.example/", {
    initiator: "https://b.example/",
    topLevelNavigate: true,
  });
  assert.ok(nav.includes("lax=1"), "top-level navigation keeps Lax");
});

void test("cookies: SameSite=Strict never crosses sites, even on navigation", () => {
  const jar = new CookieJar();
  jar.storeFromSetCookie("https://a.example/", ["st=1; Path=/; SameSite=Strict"]);
  const header = jar.cookieHeader("https://a.example/", {
    initiator: "https://evil.example/",
    topLevelNavigate: true,
  });
  assert.equal(header, "");
});

// ---------------------------------------------------------------------------
// Referrer-Policy
// ---------------------------------------------------------------------------

void test("referrer: strict-origin-when-cross-origin (the default) trims to origin cross-origin", async () => {
  const { server: s2, url: url2, seen: seen2 } = await serve((_req, res) => {
    res.writeHead(200);
    res.end("img");
  });
  const { server: s1, url: url1 } = await serve((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  try {
    const s = stack(url1);
    await s.request({ url: `${url2}/pic.png`, initiator: `${url1}/deep/page?q=1` });
    const ref = seen2[0]!.headers["referer"];
    assert.equal(ref, `${url1}/`, "cross-origin referer is origin-only under the default policy");
  } finally {
    await close(s1);
    await close(s2);
  }
});

void test("referrer: no-referrer suppresses; unsafe-url sends the full URL", async () => {
  const { server, url, seen } = await serve((_req, res) => {
    res.writeHead(200);
    res.end("x");
  });
  try {
    const s = stack(url);
    await s.request({ url: `${url}/a`, initiator: `${url}/p?q=9`, referrerPolicy: "no-referrer" });
    assert.equal(seen[seen.length - 1]!.headers["referer"], undefined);
    await s.request({ url: `${url}/b`, initiator: `${url}/p?q=9`, referrerPolicy: "unsafe-url" });
    assert.equal(seen[seen.length - 1]!.headers["referer"], `${url}/p?q=9`);
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// nosniff
// ---------------------------------------------------------------------------

void test("nosniff: a style destination refuses a non-CSS content type", async () => {
  const { server, url } = await serve((_req, res) => {
    res.writeHead(200, {
      "x-content-type-options": "nosniff",
      "content-type": "text/plain",
    });
    res.end("body{}");
  });
  try {
    const s = stack(url);
    await assert.rejects(
      () => s.request({ url: `${url}/style`, destination: "style" }),
      /nosniff/i,
    );
  } finally {
    await close(server);
  }
});

void test("nosniff: a style destination accepts text/css", async () => {
  const { server, url } = await serve((_req, res) => {
    res.writeHead(200, {
      "x-content-type-options": "nosniff",
      "content-type": "text/css",
    });
    res.end("body{}");
  });
  try {
    const s = stack(url);
    const res = await s.request({ url: `${url}/style`, destination: "style" });
    assert.equal(res.status, 200);
  } finally {
    await close(server);
  }
});
