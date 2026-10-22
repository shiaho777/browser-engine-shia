/**
 * RFC 0034 — Service Workers end-to-end: `navigator.serviceWorker.register`
 * spawns the real sw-realm worker, drives install → activate through
 * waitUntil, then `fetch` events intercept navigations AND subresources on
 * the shared session network stack — with `respondWith`, `caches`, and the
 * `fetch` loopback all live.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { loadPage } from "./page.js";
import { createPageNetwork } from "./engine-runtime.js";

process.env["BROWSER_ENGINE_USE_CURL"] = "0";

const VP = { width: 800, height: 600, devicePixelRatio: 1 };

function serve(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    req.on("end", () => handler(req, res));
    req.resume();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Pump the page's runtime until `predicate` holds in the sandbox or we give up. */
async function until(
  page: { runtime?: { globals: Record<string, unknown> | null; drainClassic: () => void } | null },
  key: string,
  ms = 15_000,
): Promise<unknown> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    page.runtime?.drainClassic();
    const v = page.runtime?.globals?.[key];
    if (v !== undefined && v !== null) return v;
    await new Promise((r) => setTimeout(r, 15));
  }
  return undefined;
}

void test("serviceWorker: register → install → activate, fetch intercepted via respondWith", async () => {
  const swSource = `
    self.addEventListener("install", (e) => { self.__installed = true; e.waitUntil(Promise.resolve()); });
    self.addEventListener("activate", (e) => { self.__activated = true; e.waitUntil(Promise.resolve()); });
    self.addEventListener("fetch", (e) => {
      if (e.request.url.endsWith("/data.txt")) {
        e.respondWith(new Response("sw-synthetic", { status: 200, headers: { "content-type": "text/plain" } }));
      }
    });
  `;
  const { server, url } = await serve((req, res) => {
    if (req.url === "/sw.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(swSource);
      return;
    }
    if (req.url === "/data.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("real-network-body");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>sw</title><script>
      window.__swFace = typeof navigator.serviceWorker;
      navigator.serviceWorker.register("/sw.js").then((reg) => {
        window.__scope = reg.scope;
        window.__ctl = navigator.serviceWorker.controller !== null;
        return fetch("/data.txt");
      }).then((r) => r.text()).then((t) => { window.__data = t; window.__done = true; })
        .catch((e) => { window.__err = String(e); window.__done = true; });
    </script>`);
  });
  try {
    // A shared stack keeps the registration across this page's requests.
    const network = createPageNetwork(url);
    const page = await loadPage(url, { runScripts: true, keepAlive: true, network, viewport: VP });
    assert.ok(page !== null);
    assert.equal(await until(page, "__swFace"), "object", "navigator.serviceWorker exists");
    assert.equal(await until(page, "__done"), true, "register → fetch chain settled");
    const g = page.runtime?.globals;
    assert.equal(g?.["__scope"], `${url}/`, "default scope = script directory");
    assert.equal(g?.["__ctl"], true, "page is controlled after activation");
    assert.equal(
      g?.["__data"],
      "sw-synthetic",
      "fetch() was intercepted by the SW, never reaching the wire body",
    );
    assert.equal(g?.["__err"], undefined);
  } finally {
    await close(server);
  }
});

void test("serviceWorker: navigation interception + caches offline path", async () => {
  let dataServeCount = 0;
  const swSource = `
    self.addEventListener("install", (e) => {
      e.waitUntil(caches.open("v1").then((c) => c.put("/asset.txt", new Response("cached-asset"))));
    });
    self.addEventListener("fetch", (e) => {
      if (e.request.url.endsWith("/asset.txt")) {
        e.respondWith(caches.match("/asset.txt").then((r) => r || fetch(e.request)));
      }
      if (e.request.url.endsWith("/nav2.html")) {
        e.respondWith(new Response("<!doctype html><title>sw-nav</title>intercepted-nav", { headers: { "content-type": "text/html" } }));
      }
    });
  `;
  const { server, url } = await serve((req, res) => {
    if (req.url === "/sw.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(swSource);
      return;
    }
    if (req.url === "/asset.txt") {
      dataServeCount += 1;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("wire-asset");
      return;
    }
    if (req.url === "/nav2.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><title>wire-nav</title>real-nav");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>sw</title><script>
      navigator.serviceWorker.register("/sw.js").then(() => { window.__reg = true; });
    </script>`);
  });
  try {
    const network = createPageNetwork(url);
    const page = await loadPage(url, { runScripts: true, keepAlive: true, network, viewport: VP });
    assert.ok(page !== null);
    assert.equal(await until(page, "__reg"), true, "registration completed (install+activate settled)");

    // Navigation to an in-scope URL — the SW answers with synthetic HTML.
    const page2 = await loadPage(`${url}/nav2.html`, { runScripts: true, keepAlive: true, network, viewport: VP });
    assert.ok(page2 !== null);
    assert.equal(page2.title, "sw-nav", "SW respondWith served the navigation, not the wire");

    // Cache hit: the install-populated cache answers /asset.txt — the wire
    // counter must not move (fetch is the guest realm's own callable).
    const g = page.runtime?.globals;
    assert.ok(g !== null && g !== undefined);
    const guestFetch = g["fetch"] as (u: string) => Promise<{ text(): Promise<string> }>;
    let cached: string | undefined;
    void guestFetch(`${url}/asset.txt`)
      .then((r) => r.text())
      .then((t) => {
        cached = t;
      });
    const deadline = Date.now() + 10_000;
    while (cached === undefined && Date.now() < deadline) {
      page.runtime?.drainClassic();
      await new Promise((r) => setTimeout(r, 15));
    }
    assert.equal(cached, "cached-asset", "install-time caches.put answered the fetch");
    assert.equal(dataServeCount, 0, "cache hit never touched the wire");
  } finally {
    await close(server);
  }
});

void test("serviceWorker: out-of-scope clients stay uncontrolled (no interception)", async () => {
  const swSource = `
    self.addEventListener("install", (e) => e.waitUntil(Promise.resolve()));
    self.addEventListener("fetch", (e) => { e.respondWith(new Response("sw-body")); });
  `;
  const { server, url } = await serve((req, res) => {
    if (req.url === "/sw.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(swSource);
      return;
    }
    if (req.url === "/data.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("wire-body");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>sw</title><script>
      // Scope narrowed to /scoped/ — THIS page sits outside it.
      navigator.serviceWorker.register("/sw.js", { scope: "/scoped/" })
        .then(() => fetch("/data.txt"))
        .then((r) => r.text())
        .then((t) => { window.__data = t; window.__ctl = navigator.serviceWorker.controller; window.__done = true; })
        .catch((e) => { window.__err = String(e); window.__done = true; });
    </script>`);
  });
  try {
    const network = createPageNetwork(url);
    const page = await loadPage(url, { runScripts: true, keepAlive: true, network, viewport: VP });
    assert.ok(page !== null);
    assert.equal(await until(page, "__done"), true, "register → fetch chain settled");
    const g = page.runtime?.globals;
    assert.equal(g?.["__ctl"], null, "page outside the scope is not controlled");
    assert.equal(
      g?.["__data"],
      "wire-body",
      "uncontrolled client's fetch hit the wire — no SW interception",
    );
    assert.equal(g?.["__err"], undefined);
  } finally {
    await close(server);
  }
});
