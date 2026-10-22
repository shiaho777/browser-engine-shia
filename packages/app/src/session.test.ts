/**
 * RFC 0010 evidence: structured session history, the guest↔host navigation
 * bridge, storage lifetimes, fragment navigation, scroll restoration — end
 * to end over a real local `node:http` server.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";

import { TabSession } from "./tab-session.js";
import {
  LocalStorageRegistry,
  SessionHistory,
  SessionHost,
  sameDocumentUrl,
  fragmentOf,
} from "./session.js";

process.env["BROWSER_ENGINE_USE_CURL"] = "0";

interface Seen {
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

function serve(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", headers: { ...req.headers } });
    handler(req, res);
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

// ---------------------------------------------------------------------------
// SessionHistory unit semantics
// ---------------------------------------------------------------------------

void test("history: push truncates forward entries, traverse restores in order", () => {
  const h = new SessionHistory();
  h.push("https://a/1", "one");
  h.push("https://a/2", "two");
  h.push("https://a/3", "three");
  assert.equal(h.length, 3);
  assert.equal(h.traverse(-2)?.url, "https://a/1");
  h.push("https://a/4", "four");
  assert.equal(h.length, 2, "forward branch truncated on new commit");
  assert.equal(h.current?.url, "https://a/4");
});

void test("history: scroll positions ride entries; pushState hops share the document", () => {
  const h = new SessionHistory();
  const doc = h.push("https://a/", "doc");
  h.recordScroll(400);
  h.pushStateEntry("https://a/#s2", { tab: 2 });
  assert.equal(h.length, 2);
  assert.equal(h.traverse(-1)?.documentKey, doc.documentKey, "same-doc traversal keeps the key");
  assert.equal(h.current?.scrollY, 400, "scroll restored from the entry");
});

void test("host: pushState updates URL synchronously, rejects cross-origin", () => {
  const host = new SessionHost();
  host.commit("https://a.example/path");
  host.pushState({ x: 1 }, "next?q=1");
  assert.equal(host.currentUrl, "https://a.example/next?q=1", "sync URL update (spec)");
  assert.equal(host.currentState && (host.currentState as { x: number }).x, 1);
  assert.throws(
    () => host.pushState({}, "https://evil.example/"),
    /different origin/,
  );
  assert.equal(host.drainIntents().length, 1);
});

void test("urls: sameDocumentUrl ignores only the fragment", () => {
  assert.ok(sameDocumentUrl("https://a/p#x", "https://a/p#y"));
  assert.ok(!sameDocumentUrl("https://a/p#x", "https://a/q#x"));
  assert.equal(fragmentOf("https://a/p#frag"), "frag");
});

// ---------------------------------------------------------------------------
// TabSession end-to-end over a real HTTP server
// ---------------------------------------------------------------------------

void test("session: cookie jar + HTTP cache SURVIVE navigation (one stack per tab)", async () => {
  let pageHits = 0;
  const { server, url, seen } = await serve((req, res) => {
    if (req.url === "/set") {
      res.writeHead(200, { "set-cookie": "sess=42; Path=/", "content-type": "text/html" });
      res.end("<html><body><a href='/other'>go</a></body></html>");
      return;
    }
    if (req.url === "/other") {
      pageHits += 1;
      res.writeHead(200, {
        "content-type": "text/html",
        "cache-control": "max-age=60",
      });
      res.end("<html><body>other</body></html>");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  try {
    const tab = new TabSession(1);
    await tab.navigate(`${url}/set`);
    // The SAME session stack means /set's Set-Cookie rides the next nav…
    await tab.navigate(`${url}/other`);
    const otherReq = seen.filter((s) => s.url === "/other")[0]!;
    assert.equal(otherReq.headers["cookie"], "sess=42", "cookie persisted across navigation");
    // …and traversal reuses its HTTP cache instead of reloading blindly.
    await tab.back();
    await tab.forward();
    assert.equal(pageHits, 1, "cached page re-served without a second hit");
  } finally {
    await close(server);
  }
});

void test("session: committed URL is the post-redirect landing URL", async () => {
  const { server, url } = await serve((req, res) => {
    if (req.url === "/redir") {
      res.writeHead(302, { location: "/landing" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><title>landed</title><body>hi</body></html>");
  });
  try {
    const tab = new TabSession(1);
    await tab.navigate(`${url}/redir`);
    assert.equal(tab.url, `${url}/landing`, "history commits where the browser landed");
    assert.equal(tab.title, "landed");
  } finally {
    await close(server);
  }
});

void test("session: link navigation sends Referer of the previous document", async () => {
  const { server, url, seen } = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body>page</body></html>");
  });
  try {
    // Flip transport per-test: unset env so a session constructed here prefers
    // curl (verbatim headers) when available — undici clamps navigate→cors.
    const prevCurl = process.env["BROWSER_ENGINE_USE_CURL"];
    delete process.env["BROWSER_ENGINE_USE_CURL"];
    const curlAvailable = spawnSync("curl", ["--version"]).status === 0;
    const tab = new TabSession(1);
    await tab.navigate(`${url}/first`);
    await tab.navigate(`${url}/second`);
    if (prevCurl !== undefined) process.env["BROWSER_ENGINE_USE_CURL"] = prevCurl;
    const secondReq = seen.filter((s) => s.url === "/second")[0]!;
    assert.equal(
      secondReq.headers["referer"],
      `${url}/first`,
      "navigation carries the referring document as Referer (same-origin ⇒ full URL)",
    );
    assert.equal(secondReq.headers["sec-fetch-dest"], "document");
    assert.equal(secondReq.headers["sec-fetch-user"], "?1");
    // Honest transport boundary: undici's fetch() forbids Request.mode
    // "navigate" and clamps Sec-Fetch-Mode to the request's internal mode
    // (cors). The curl transport sends it verbatim.
    assert.equal(
      secondReq.headers["sec-fetch-mode"],
      curlAvailable ? "navigate" : "cors",
    );
  } finally {
    await close(server);
  }
});

void test("session: fragment hop is same-document — no reload, hashchange fires", async () => {
  let hits = 0;
  const { server, url } = await serve((_req, res) => {
    hits += 1;
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      `<html><body>` +
        `<div style="height:2000px">tall</div>` +
        `<h2 id="target">anchored</h2>` +
        `<script>sessionStorage.setItem('hc','0');` +
        `window.addEventListener('hashchange',(e)=>{` +
        `sessionStorage.setItem('hc',String(Number(sessionStorage.getItem('hc'))+1));` +
        `sessionStorage.setItem('hc_new',e.newURL);` +
        `})</script>` +
        `</body></html>`,
    );
  });
  try {
    const tab = new TabSession(1);
    await tab.navigate(url, { keepAlive: true });
    const hitsAfterLoad = hits;
    await tab.navigate(`${url}/#target`);
    assert.equal(hits, hitsAfterLoad, "fragment navigation did NOT reload the document");
    assert.equal(tab.url, `${url}/#target`);
    assert.ok(tab.canGoBack());
    // The live page heard hashchange — guest code wrote into session storage,
    // which the session owns (observable, no sandbox poking).
    assert.equal(tab.sessionStorage.getItem("hc"), "1", "hashchange fired once");
    assert.equal(tab.sessionStorage.getItem("hc_new"), `${url}/#target`);
    // …and the fragment scrolled the page to the anchor (tall div pushed it down).
    assert.ok(tab.scrollY > 0, `scrolled to anchor: ${tab.scrollY}`);
  } finally {
    await close(server);
  }
});

void test("session: guest location/history queue REAL navigation intents", async () => {
  const { server, url, seen } = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    // Only /src carries the assign script — the target is a quiet document
    // (otherwise each landing would re-queue a navigation forever).
    res.end(
      req.url === "/src"
        ? `<html><body><script>location.assign('/target');</script><p>src</p></body></html>`
        : `<html><body><p>target</p></body></html>`,
    );
  });
  try {
    const tab = new TabSession(1);
    await tab.navigate(`${url}/src`);
    // The script's location.assign ran during boot → the session drained the
    // intent and actually navigated (real browsers do this post-task).
    assert.equal(tab.url, `${url}/target`, "guest location.assign navigated for real");
    assert.ok(
      seen.some((s) => s.url === "/target"),
      "the target request hit the wire",
    );
  } finally {
    await close(server);
  }
});

void test("session: history.pushState rewrites the URL without fetching", async () => {
  const { server, url, seen } = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      `<html><body><script>` +
        `history.pushState({s:1}, '', '/spa/state-1');` +
        `history.pushState({s:2}, '', '/spa/state-2');` +
        `</script><p>spa</p></body></html>`,
    );
  });
  try {
    const tab = new TabSession(1);
    await tab.navigate(url);
    assert.equal(tab.url, `${url}/spa/state-2`, "pushState URL is committed");
    assert.equal(tab.historyList.length, 3, "two same-document entries pushed");
    const hits = seen.length;
    // Same-document traversal back across pushState entries: NO reload.
    await tab.back();
    assert.equal(tab.url, `${url}/spa/state-1`);
    assert.equal(seen.length, hits, "pushState traversal never touched the network");
    await tab.back();
    assert.equal(tab.url, `${url}/`, "back across the pushState boundary lands on the doc entry");
  } finally {
    await close(server);
  }
});

void test("session: scroll restoration on traverse", async () => {
  const { server, url } = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      req.url === "/tall"
        ? `<html><body><div style="height:5000px">tall</div></body></html>`
        : `<html><body><p>short</p></body></html>`,
    );
  });
  try {
    const tab = new TabSession(1);
    await tab.navigate(`${url}/tall`);
    await tab.scrollBy(0, 800, { settle: true });
    const scrolled = tab.scrollY;
    assert.ok(scrolled > 100, `scrolled to ${scrolled}`);
    await tab.navigate(`${url}/short`);
    await tab.back();
    assert.equal(tab.scrollY, scrolled, "back() restored the tall page's scroll position");
  } finally {
    await close(server);
  }
});

void test("registry: same origin shares storage; different origins isolate", () => {
  const reg = new LocalStorageRegistry();
  const a1 = reg.forOrigin("https://a.example/x");
  const a2 = reg.forOrigin("https://a.example/y");
  const b = reg.forOrigin("https://b.example/");
  a1.setItem("k", "v");
  assert.equal(a2.getItem("k"), "v", "same origin ⇒ same store");
  assert.equal(b.getItem("k"), null, "other origin ⇒ isolated");
});


