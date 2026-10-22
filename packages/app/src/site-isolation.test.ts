/**
 * RFC 0030 — site isolation: cross-origin iframes run in their own worker
 * (OOPIF). The Phase-4 done-when fixture: a cross-origin iframe proves NO
 * DOM reach across the process boundary, and postMessage still routes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { TabSession } from "./tab-session.js";
import { BrowsingContext } from "./browsing-context.js";
import { IsolatedFrame } from "./isolated-frame.js";
import { siteIsolationKey, shouldIsolateFrame } from "./site-isolation.js";

process.env["BROWSER_ENGINE_USE_CURL"] = "0";

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

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));



const HTML = (body: string): string =>
  `<!doctype html><html><body>${body}</body></html>`;

// ---------- unit ----------

void test("siteIsolationKey: origin-keyed; non-http(s) never isolates", () => {
  assert.equal(siteIsolationKey("https://a.example/x"), "https://a.example");
  assert.equal(siteIsolationKey("https://a.example:8443/x"), "https://a.example:8443");
  assert.equal(siteIsolationKey("about:blank"), null);
  assert.equal(siteIsolationKey("data:text/html,x"), null);
  assert.equal(siteIsolationKey("file:///tmp/a"), null);
  assert.equal(
    shouldIsolateFrame("https://a.example/", "https://b.example/f"),
    true,
  );
  assert.equal(
    shouldIsolateFrame("https://a.example/", "https://a.example/sub"),
    false,
    "same-origin stays in-process",
  );
  assert.equal(
    shouldIsolateFrame("http://127.0.0.1:1/", "http://127.0.0.1:2/f"),
    true,
    "different ports = different origins = isolated",
  );
});

// ---------- integration: real OOPIF over real loopback http ----------

void test("cross-origin iframe runs in an isolated worker; no DOM reach; bitmap composites", async () => {
  const { server: childSrv, url: childUrl } = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(HTML(`<p style="background:#f00;height:50px">REMOTE</p>`));
  });
  const { server: parentSrv, url: parentUrl } = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      HTML(
        `<iframe id="f" src="${childUrl}/child" style="width:200px;height:100px"></iframe>` +
          `<script>` +
          `const f=document.getElementById('f');` +
          `f.addEventListener('load',()=>{` +
          `window.__win=typeof f.contentWindow.postMessage==='function';` +
          `window.__doc=f.contentWindow.document;` +
          `window.__cd=f.contentDocument;` +
          `});` +
          `</script>`,
      ),
    );
  });
  try {
    const tab = new TabSession(1);
    await tab.navigate(parentUrl);
    await tab.pump(2);
    const child = [...tab.context.frames.values()][0]!;
    assert.ok(child instanceof IsolatedFrame, "cross-origin child is an OOPIF");
    assert.equal(child.url, `${childUrl}/child`, "remote frame committed its URL");
    assert.equal(child.page, null, "no in-process page — the document lives in the worker");
    assert.equal(child.globals, null);
    assert.ok(
      (child.framePngBytes?.byteLength ?? 0) > 0,
      "the remote frame produced a composited bitmap",
    );
    // Phase-4 done-when: no DOM reach across the process boundary.
    await sleep(200);
    assert.equal(tab.context.globals?.["__win"], true, "WindowProxy.postMessage exists");
    assert.equal(tab.context.globals?.["__doc"], undefined, "cross-origin proxy exposes NO document");
    assert.equal(
      tab.context.globals?.["__cd"],
      null,
      "contentDocument is null across the boundary",
    );
    tab.dispose();
  } finally {
    await close(parentSrv);
    await close(childSrv);
  }
});

void test("same-origin iframe stays in-process (DOM reach intact)", async () => {
  const { server, url } = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      req.url === "/kid"
        ? HTML(`<p>kid</p>`)
        : HTML(`<iframe id="f" src="/kid" style="width:200px;height:100px"></iframe>`),
    );
  });
  try {
    const tab = new TabSession(1);
    await tab.navigate(url);
    const child = [...tab.context.frames.values()][0]!;
    assert.ok(child instanceof BrowsingContext, "same-origin child is in-process");
    assert.notEqual(child.page, null);
  } finally {
    await close(server);
  }
});

void test("OOPIF postMessage: parent→child and child→parent route over the port", async () => {
  const { server: childSrv, url: childUrl } = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      HTML(
        `<script>` +
          `window.addEventListener('message',(e)=>{` +
          `if(e.data&&e.data.ping===1){` +
          `e.source.postMessage({pong:1,origin:e.origin,parentOk:window.parent!==window},'*');` +
          `}` +
          `});` +
          `</script>`,
      ),
    );
  });
  const { server: parentSrv, url: parentUrl } = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      HTML(
        `<iframe id="f" src="${childUrl}/kid" style="width:200px;height:100px"></iframe>` +
          `<script>` +
          `const f=document.getElementById('f');` +
          `window.addEventListener('message',(e)=>{` +
          `if(e.data&&e.data.pong===1){window.__pong=e.data;}` +
          `});` +
          `f.addEventListener('load',()=>{` +
          `f.contentWindow.postMessage({ping:1},'*');` +
          `});` +
          `</script>`,
      ),
    );
  });
  try {
    const tab = new TabSession(1);
    await tab.navigate(parentUrl);
    await tab.pump(2);
    // Port round-trips are async — pump + wall-clock settle.
    for (let i = 0; i < 8; i += 1) {
      await sleep(100);
      await tab.pump(1);
      if (tab.context.globals?.["__pong"] !== undefined) break;
    }
    const pong = tab.context.globals?.["__pong"] as
      | { pong: number; origin: string; parentOk: boolean }
      | undefined;
    assert.equal(pong?.pong, 1, "parent→child deliver + child reply over the port");
    assert.equal(pong?.origin, parentUrl, "event.origin names the sender (the embedder)");
    assert.equal(
      pong?.parentOk,
      true,
      "the remote frame's window.parent is the remote embedder, not self",
    );
    tab.dispose(); // terminate OOPIF workers
  } finally {
    await close(parentSrv);
    await close(childSrv);
  }
});
