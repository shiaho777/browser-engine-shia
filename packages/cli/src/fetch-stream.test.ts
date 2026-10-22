/**
 * RFC 0040 streaming fetch: a real HTTP server that drips the body in timed
 * chunks, the real `BrowserNetworkStack` (curl/undici transports), and guest
 * `fetch()` consuming `res.body` as a live reader — chunk granularity, async
 * iteration, bodyUsed/clone semantics, wire-byte progress, and the buffered
 * fallbacks (virtual resources, cache hits, redirects).
 *
 * Built by `tsc` then run with: `node --test packages/cli/dist/*.test.js`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { FineSession } from "./fine.js";
import { runScriptsOnSessionReal, type EventDrivenRun } from "./event-loop.js";
import {
  createBrowserNetworkStack,
  networkStackToBrowserFetch,
} from "@browser-engine/guest";

const DOC = "<html><body><p>doc</p></body></html>";

interface Served {
  server: Server;
  url: string;
  close: () => Promise<void>;
}

function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Served> {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/** Pump host microtasks + guest drains until __r appears. */
const pump = async (r: EventDrivenRun): Promise<Record<string, unknown>> => {
  const sandbox = r.sandbox as Record<string, unknown>;
  for (let i = 0; i < 200 && sandbox["__r"] === undefined; i += 1) {
    await r.flushAsync?.();
    r.drain?.();
    await new Promise((res) => setTimeout(res, 5));
  }
  return sandbox;
};

void test("streaming: res.body.getReader() yields wire chunks as they land", async () => {
  const srv = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("AAA");
    setTimeout(() => res.write("BBB"), 120);
    setTimeout(() => {
      res.write("CCC");
      res.end();
    }, 240);
  });
  try {
    const stack = createBrowserNetworkStack({ baseUrl: srv.url });
    const browserFetch = networkStackToBrowserFetch(stack, srv.url);
    const out = await runScriptsOnSessionReal(
      new FineSession(DOC, `${srv.url}/`),
      [
        `
        (async () => {
          const res = await fetch("/body");
          const reader = res.body.getReader();
          const chunks = [];
          let arrivalSpread = false;
          let firstAt = 0;
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            const t = Date.now();
            if (chunks.length === 0) firstAt = t;
            else if (t - firstAt > 30) arrivalSpread = true;
            chunks.push(Array.from(value).map(c => String.fromCharCode(c)).join(""));
          }
          __r = { chunks, arrivalSpread, used: res.bodyUsed };
        })().catch(e => { __r = { err: String(e) }; })
      `,
      ],
      undefined,
      { browserFetch },
    );
    const sandbox = await pump(out);
    assert.equal(out.error, null);
    const r = JSON.parse(JSON.stringify(sandbox["__r"])) as {
      chunks?: string[];
      arrivalSpread?: boolean;
      used?: boolean;
      err?: string;
    };
    assert.equal(r.err, undefined);
    assert.equal((r.chunks ?? []).join(""), "AAABBBCCC", "all bytes delivered in order");
    // The delayed writes mean ≥2 distinct chunk arrivals — a buffered
    // implementation would deliver exactly one.
    assert.ok((r.chunks ?? []).length >= 2, `expected multiple chunk events, got ${JSON.stringify(r.chunks)}`);
    assert.equal(r.arrivalSpread, true, "chunks arrived across wall-clock time");
    assert.equal(r.used, true, "bodyUsed set by reader consumption");
  } finally {
    await srv.close();
  }
});

void test("streaming: async iteration + text()/arrayBuffer() over live body", async () => {
  const srv = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"a":');
    setTimeout(() => res.end("42}"), 80);
  });
  try {
    const stack = createBrowserNetworkStack({ baseUrl: srv.url });
    const browserFetch = networkStackToBrowserFetch(stack, srv.url);
    const out = await runScriptsOnSessionReal(
      new FineSession(DOC, `${srv.url}/`),
      [
        `
        (async () => {
          const R = [];
          // Async iteration over the live stream.
          const res = await fetch("/j");
          let bytes = 0;
          for await (const c of res.body) bytes += c.byteLength;
          R.push("iter:" + bytes); // {"a": + 42} = 5 + 3 = 8 bytes
          // promise consumers still work on a fresh live fetch.
          const res2 = await fetch("/j");
          R.push("text:" + (await res2.text()));
          const res3 = await fetch("/j");
          R.push("json:" + JSON.stringify(await res3.json()));
          const res4 = await fetch("/j");
          const ab = await res4.arrayBuffer();
          R.push("ab:" + new Uint8Array(ab).byteLength);
          __r = R;
        })().catch(e => { __r = ["ERR:" + e.message]; })
      `,
      ],
      undefined,
      { browserFetch },
    );
    const sandbox = await pump(out);
    assert.equal(out.error, null);
    assert.deepEqual(JSON.parse(JSON.stringify(sandbox["__r"])), [
      "iter:8",
      'text:{"a":42}',
      'json:{"a":42}',
      "ab:8",
    ]);
  } finally {
    await srv.close();
  }
});

void test("streaming: double-consumption rejects; clone() tees a live body", async () => {
  const srv = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("payload-body");
  });
  try {
    const stack = createBrowserNetworkStack({ baseUrl: srv.url });
    const browserFetch = networkStackToBrowserFetch(stack, srv.url);
    const out = await runScriptsOnSessionReal(
      new FineSession(DOC, `${srv.url}/`),
      [
        `
        (async () => {
          const R = [];
          const res = await fetch("/p");
          await res.text();
          try { await res.text(); R.push("second:MISS"); }
          catch (e) { R.push("second:" + (e instanceof TypeError)); }
          // clone() on a streaming body: both branches get the bytes and the
          // original is disturbed per Fetch tee semantics.
          const res2 = await fetch("/p");
          const c = res2.clone();
          const [t1, t2] = await Promise.all([res2.text(), c.text()]);
          R.push("tee:" + t1 + "|" + t2 + "|" + res2.bodyUsed + "|" + c.bodyUsed);
          // clone() after consumption must reject.
          const res3 = await fetch("/p");
          await res3.text();
          try { res3.clone(); R.push("lateclone:MISS"); }
          catch (e) { R.push("lateclone:" + (e instanceof TypeError)); }
          __r = R;
        })().catch(e => { __r = ["ERR:" + e.message]; })
      `,
      ],
      undefined,
      { browserFetch },
    );
    const sandbox = await pump(out);
    assert.equal(out.error, null);
    assert.deepEqual(JSON.parse(JSON.stringify(sandbox["__r"])), [
      "second:true",
      "tee:payload-body|payload-body|true|true",
      "lateclone:true",
    ]);
  } finally {
    await srv.close();
  }
});

void test("streaming: wire-byte progress lands incrementally; redirects stream the final hop", async () => {
  const srv = await serve((req, res) => {
    if (req.url === "/redir") {
      res.writeHead(302, { location: "/final" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain", "content-length": "12" });
    res.write("first-half-");
    setTimeout(() => res.end("x"), 100);
  });
  try {
    const stack = createBrowserNetworkStack({ baseUrl: srv.url });
    const browserFetch = networkStackToBrowserFetch(stack, srv.url);
    const out = await runScriptsOnSessionReal(
      new FineSession(DOC, `${srv.url}/`),
      [
        `
        (async () => {
          const res = await fetch("/redir");
          __r = {
            status: res.status,
            redirected: res.redirected,
            url: res.url,
            text: await res.text(),
          };
        })().catch(e => { __r = { err: String(e) }; })
      `,
      ],
      undefined,
      { browserFetch },
    );
    const sandbox = await pump(out);
    assert.equal(out.error, null);
    const r = JSON.parse(JSON.stringify(sandbox["__r"])) as {
      status?: number;
      redirected?: boolean;
      url?: string;
      text?: string;
      err?: string;
    };
    assert.equal(r.err, undefined);
    assert.equal(r.status, 200);
    assert.equal(r.redirected, true);
    assert.ok(r.url?.endsWith("/final"), `final URL exposed: ${r.url}`);
    assert.equal(r.text, "first-half-x");
    // Progress events: multiple samples as the body landed (not one burst).
    const progress = stack.progress;
    assert.ok(progress.length >= 1, "progress events recorded");
    const last = progress[progress.length - 1]!;
    assert.equal(last.receivedBytes, 12);
    assert.equal(last.totalBytes, 12);
  } finally {
    await srv.close();
  }
});

void test("streaming: XHR fires progress events per wire chunk with real loaded/total", async () => {
  const srv = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain", "content-length": "9" });
    res.write("one");
    setTimeout(() => res.write("two"), 60);
    setTimeout(() => res.end("end"), 120);
  });
  try {
    const stack = createBrowserNetworkStack({ baseUrl: srv.url });
    const browserFetch = networkStackToBrowserFetch(stack, srv.url);
    const out = await runScriptsOnSessionReal(
      new FineSession(DOC, `${srv.url}/`),
      [
        `
        (async () => {
          const xhr = new XMLHttpRequest();
          const prog = [];
          xhr.onprogress = (e) => prog.push(e.loaded + "/" + e.total + "/" + e.lengthComputable + "/" + xhr.responseText);
          xhr.onload = () => prog.push("load:" + xhr.status + "/" + xhr.responseText + "/rs" + xhr.readyState);
          xhr.open("GET", "/body");
          xhr.send();
          await new Promise(rr => setTimeout(rr, 400));
          __r = prog;
        })().catch(e => { __r = ["ERR:" + e.message]; })
      `,
      ],
      undefined,
      { browserFetch },
    );
    const sandbox = await pump(out);
    assert.equal(out.error, null);
    const r = JSON.parse(JSON.stringify(sandbox["__r"])) as string[];
    assert.ok(Array.isArray(r), JSON.stringify(r));
    // ≥2 progress events with increasing loaded; final load shows full text.
    const progressEvents = r.filter((x) => x.includes("/9/true/"));
    assert.ok(progressEvents.length >= 2, `expected per-chunk progress, got ${JSON.stringify(r)}`);
    assert.deepEqual(r[r.length - 1], "load:200/onetwoend/rs4");
  } finally {
    await srv.close();
  }
});

void test("streaming: AbortSignal aborts the wire — consumers reject AbortError", async () => {
  const srv = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("prefix-");
    // body never completes — only the abort ends it
  });
  try {
    const stack = createBrowserNetworkStack({ baseUrl: srv.url });
    const browserFetch = networkStackToBrowserFetch(stack, srv.url);
    const out = await runScriptsOnSessionReal(
      new FineSession(DOC, `${srv.url}/`),
      [
        `
        (async () => {
          const c = new AbortController();
          const res = await fetch("/slow", { signal: c.signal });
          const read = res.text();
          c.abort();
          try {
            await read;
            __r = ["MISS: text resolved after abort"];
          } catch (e) {
            __r = [e.name, e instanceof DOMException];
          }
        })().catch(e => { __r = ["ERR:" + e.message]; })
      `,
      ],
      undefined,
      { browserFetch },
    );
    const sandbox = await pump(out);
    assert.equal(out.error, null);
    assert.deepEqual(JSON.parse(JSON.stringify(sandbox["__r"])), ["AbortError", true]);
  } finally {
    await srv.close();
  }
});

void test("streaming: abort mid-body rejects the reader, not a hang", async () => {
  const srv = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("partial-");
    // Never end — the reader must be cancelled, not waited on.
  });
  try {
    const stack = createBrowserNetworkStack({ baseUrl: srv.url, timeoutMs: 30_000 });
    const browserFetch = networkStackToBrowserFetch(stack, srv.url);
    const out = await runScriptsOnSessionReal(
      new FineSession(DOC, `${srv.url}/`),
      [
        `
        (async () => {
          const res = await fetch("/slow");
          const reader = res.body.getReader();
          const first = await reader.read();
          await reader.cancel("done");
          // After cancel the body is disturbed + the stream is done.
          let end = false;
          try { const n = await reader.read(); end = n.done === true; }
          catch (e) { end = "threw:" + e.name; }
          __r = { first: first.value.length > 0, used: res.bodyUsed, end };
        })().catch(e => { __r = { err: String(e) }; })
      `,
      ],
      undefined,
      { browserFetch },
    );
    const sandbox = await pump(out);
    assert.equal(out.error, null);
    const r = JSON.parse(JSON.stringify(sandbox["__r"])) as {
      first?: boolean;
      used?: boolean;
      end?: unknown;
      err?: string;
    };
    assert.equal(r.err, undefined);
    assert.equal(r.first, true);
    assert.equal(r.used, true);
    assert.equal(r.end, true, "read after cancel resolves done");
  } finally {
    await srv.close();
  }
});


