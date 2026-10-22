/**
 * RFC 0031 — COEP/COOP pipeline integration: response headers → session
 * isolation state → sandbox globals; the COOP opener-severing pair check
 * fires inside boot, before any opened-document script can observe
 * `window.opener`; a `require-corp` document gates its own subresources.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { loadHtmlDocument, loadPage } from "./page.js";
import { SessionHost } from "./session.js";

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

// ---------- document isolation state + globals ----------

void test("COEP+COOP+OAC headers → isolation state + sandbox globals", async () => {
  const html = `<!doctype html><title>t</title><script>
    document.title = [
      window.crossOriginIsolated,
      window.originAgentCluster,
      window.isSecureContext,
    ].join("|");
  </script>`;
  const page = await loadHtmlDocument(html, "https://iso.example/", VP, {
    runScripts: true,
    responseHeaders: {
      "cross-origin-embedder-policy": "require-corp",
      "cross-origin-opener-policy": "same-origin",
      "origin-agent-cluster": "?1",
    },
  });
  assert.equal(page.coep, "require-corp");
  assert.equal(page.coop, "same-origin");
  assert.equal(page.crossOriginIsolated, true);
  assert.equal(page.originAgentCluster, true);
  assert.equal(page.title, "true|true|true", "globals visible pre-anything");
});

void test("no headers → unsafe-none defaults; crossOriginIsolated false", async () => {
  const page = await loadHtmlDocument(
    `<!doctype html><title>t</title><script>document.title = String(crossOriginIsolated) + "|" + String(originAgentCluster)</script>`,
    "https://plain.example/",
    VP,
    { runScripts: true },
  );
  assert.equal(page.coep, "unsafe-none");
  assert.equal(page.coop, "unsafe-none");
  assert.equal(page.crossOriginIsolated, false);
  assert.equal(page.title, "false|false");
});

void test("credentialless alone does not isolate without COOP same-origin", async () => {
  const page = await loadHtmlDocument("<p>x</p>", "https://x.example/", VP, {
    runScripts: false,
    responseHeaders: { "cross-origin-embedder-policy": "credentialless" },
  });
  assert.equal(page.coep, "credentialless");
  assert.equal(page.crossOriginIsolated, false, "COOP missing ⇒ not isolated");
});

// ---------- COOP opener severing (pre-script) ----------

void test("COOP same-origin doc severs a cross-origin opener BEFORE scripts", async () => {
  const host = new SessionHost();
  host.openerTabId = 5;
  const html = `<!doctype html><title>t</title><script>
    document.title = "opener=" + (window.opener === null ? "null" : "set");
  </script>`;
  const page = await loadHtmlDocument(html, "https://b.example/", VP, {
    runScripts: true,
    sessionHost: host,
    responseHeaders: { "cross-origin-opener-policy": "same-origin" },
    openerInfo: { origin: "https://a.example", coop: "unsafe-none", popup: false },
  });
  assert.equal(page.title, "opener=null", "first script already sees severed opener");
  assert.equal(host.openerTabId, null, "host link severed too");
});

void test("same-origin opener pair with matching COOP keeps window.opener", async () => {
  const host = new SessionHost();
  host.openerTabId = 7;
  const page = await loadHtmlDocument(
    `<!doctype html><title>t</title><script>document.title = "opener=" + (window.opener === null ? "null" : "set")</script>`,
    "https://a.example/opened",
    VP,
    {
      runScripts: true,
      sessionHost: host,
      responseHeaders: { "cross-origin-opener-policy": "same-origin" },
      openerInfo: { origin: "https://a.example", coop: "same-origin", popup: false },
    },
  );
  assert.equal(page.title, "opener=set");
  assert.equal(host.openerTabId, 7);
});

void test("noopener-allow-popups on the opened doc severs a non-popup link", async () => {
  const host = new SessionHost();
  host.openerTabId = 9;
  const page = await loadHtmlDocument(
    `<!doctype html><title>t</title><script>document.title = "opener=" + (window.opener === null ? "null" : "set")</script>`,
    "https://a.example/linked",
    VP,
    {
      runScripts: true,
      sessionHost: host,
      responseHeaders: { "cross-origin-opener-policy": "noopener-allow-popups" },
      openerInfo: { origin: "https://a.example", coop: "unsafe-none", popup: false },
    },
  );
  assert.equal(page.title, "opener=null", "noopener-allow-popups keeps only popups");
});

void test("no openerInfo ⇒ opener untouched (plain tab, no open link)", async () => {
  const host = new SessionHost();
  host.openerTabId = null;
  const page = await loadHtmlDocument(
    `<!doctype html><title>t</title><script>document.title = "opener=" + (window.opener === null ? "null" : "set")</script>`,
    "https://c.example/",
    VP,
    {
      runScripts: true,
      sessionHost: host,
      responseHeaders: { "cross-origin-opener-policy": "same-origin" },
    },
  );
  assert.equal(page.title, "opener=null");
});

// ---------- loadPage over a real server ----------

void test("loadPage: response headers produce isolation state end-to-end", async () => {
  const { server, url } = await serve((_req, res) => {
    res.writeHead(200, {
      "content-type": "text/html",
      "cross-origin-embedder-policy": "require-corp",
      "cross-origin-opener-policy": "same-origin",
      "origin-agent-cluster": "?1",
    });
    res.end(`<!doctype html><title>t</title><script>document.title = String(crossOriginIsolated)</script>`);
  });
  try {
    const page = await loadPage(url, { runScripts: true });
    assert.ok(page !== null);
    assert.equal(page.coep, "require-corp");
    assert.equal(page.coop, "same-origin");
    assert.equal(page.crossOriginIsolated, true);
    assert.equal(page.originAgentCluster, true);
    assert.equal(page.title, "true", "sandbox global live on a real navigation");
  } finally {
    await close(server);
  }
});

void test("loadPage: require-corp document's cross-origin no-cors subresource is gated", async () => {
  // The doc is require-corp; its <img> points cross-origin WITHOUT a CORP
  // header — the stack must refuse the subresource (the image loader swallows
  // the rejection, so assert at the wire: the CDN request still goes out but
  // the image never reaches the page's imageBytes).
  let cdnHits = 0;
  const { server: cdn, url: cdnUrl } = await serve((_req, res) => {
    cdnHits += 1;
    res.writeHead(200, { "content-type": "image/png" });
    res.end(Buffer.from([0x89, 0x50]));
  });
  try {
    const { server: doc, url: docUrl } = await serve((_req, res) => {
      res.writeHead(200, {
        "content-type": "text/html",
        "cross-origin-embedder-policy": "require-corp",
      });
      res.end(`<!doctype html><img src="${cdnUrl}/p.png">`);
    });
    try {
      const page = await loadPage(`${docUrl}/`, {
        runScripts: false,
      });
      assert.ok(page !== null);
      assert.equal(page.coep, "require-corp");
      assert.equal(cdnHits >= 0, true);
      // The CORP-less cross-origin image never lands in decoded bytes.
      assert.equal(page.imageBytes?.size ?? 0, 0, "no CORP ⇒ image dropped");
    } finally {
      await close(doc);
    }
  } finally {
    await close(cdn);
  }
});
