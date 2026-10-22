/**
 * Fetch + XMLHttpRequest (RFC 0019): guest-realm Headers/Request/Response/
 * ReadableStream classes, a fetch facade over the injected transport core
 * (virtual resources for `runScriptsOnSession`, `browserFetch`/fetchFn for
 * the real runner), and XHR built on the same fetch with spec event
 * semantics — HTTP errors complete as `load`, transport errors as `error`.
 *
 * Async guest code (await fetch / XHR events) needs the host-microtask +
 * drain pump: guest promise jobs ride the REAL queue while the virtual
 * loop's thenables/timers need drain() — the returned drain() exists for
 * exactly this.
 *
 * Built by `tsc` then run with: `node --test packages/cli/dist/*.test.js`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { FineSession } from "./fine.js";
import { runScriptsOnSession, runScriptsOnSessionReal, type EventDrivenRun, type GuestBrowserFetch } from "./event-loop.js";

const DOC = "<html><body><p>doc</p></body></html>";
const BASE = "https://x.test/app/index.html";

const RESOURCES = new Map([
  ["https://x.test/app/data.json", JSON.stringify({ a: 1, list: [1, 2] })],
  ["https://x.test/app/hello.txt", "hello world"],
  ["https://x.test/app/blob.bin", "ABCD"],
]);

/** Pump host microtasks + virtual drains until __r exists (or bound hit). */
const pump = async (r: EventDrivenRun): Promise<Record<string, unknown>> => {
  assert.equal(r.error, null);
  const sandbox = r.sandbox as Record<string, unknown>;
  for (let i = 0; i < 80 && sandbox["__r"] === undefined; i += 1) {
    await new Promise((res) => setImmediate(res));
    r.drain?.();
  }
  return sandbox;
};

const runVirtual = async (
  src: string,
  resources: ReadonlyMap<string, string> = RESOURCES,
): Promise<{ __r: unknown }> => {
  const s = await pump(runScriptsOnSession(new FineSession(DOC, BASE), [src], resources));
  // vm-realm arrays/objects fail cross-realm deepStrictEqual — JSON round-trip.
  return { __r: JSON.parse(JSON.stringify(s["__r"])) as unknown };
};

void test("fetch api classes are guest-realm and spec-shaped", async () => {
  const s = await runVirtual(`
    (async () => {
      const R = [];
      R.push(typeof Headers + "/" + typeof Request + "/" + typeof Response + "/" + typeof ReadableStream);
      const h = new Headers([["X-A", "1"], ["x-a", "2"], ["Set-Cookie", "a=1"], ["Set-Cookie", "b=2"]]);
      R.push(h.get("X-A"));                 // combined, case-insensitive
      R.push(h.getSetCookie().join("|"));   // set-cookie stays un-combined
      h.set("x-a", "9");
      R.push(h.get("X-A") + "/" + h.has("X-A") + "/" + h.has("x-miss"));
      h.delete("x-a");
      R.push(String(h.get("x-a")));
      __r = R;
    })().catch(e => { __r = ["ERR:" + e.message]; })
  `);
  assert.deepEqual(s["__r"], [
    "function/function/function/function",
    "1, 2",
    "a=1|b=2",
    "9/true/false",
    "null",
  ]);
});

void test("Request resolves against document base, carries method/headers/body, instanceof holds", async () => {
  const s = await runVirtual(`
    (async () => {
      const R = [];
      const r = new Request("data.json", { method: "POST", headers: { "X-H": "v" }, body: "payload" });
      R.push(r.method + "/" + r.url + "/" + r.headers.get("x-h"));
      R.push(r instanceof Request);
      const r2 = new Request(r);             // Request-from-Request inherits
      R.push(r2.method + "/" + r2.url + "/" + r2.headers.get("x-h"));
      try { new Request("x", { method: "GET", body: "nope" }); R.push("getbody:MISS"); }
      catch (e) { R.push("getbody:" + (e instanceof TypeError)); }
      try { new Request("x", { method: "TRACE" }); R.push("method:MISS"); }
      catch (e) { R.push("method:" + (e instanceof TypeError)); }
      __r = R;
    })().catch(e => { __r = ["ERR:" + e.message]; })
  `);
  assert.deepEqual(s["__r"], [
    "POST/https://x.test/app/data.json/v",
    true,
    "POST/https://x.test/app/data.json/v",
    "getbody:true",
    "method:true",
  ]);
});

void test("Response: status/ok/url/headers, body consumers, bodyUsed, clone tee", async () => {
  const s = await runVirtual(`
    (async () => {
      const R = [];
      const res = await fetch("data.json");
      R.push(res.status + "/" + res.ok + "/" + res.url.split("/").pop() + "/" + (res instanceof Response));
      R.push(JSON.stringify(await res.json()));
      R.push(String(res.bodyUsed));
      try { await res.text(); R.push("reuse:MISS"); }
      catch (e) { R.push("reuse:" + (e instanceof TypeError)); }
      const res2 = await fetch("hello.txt");
      const cl = res2.clone();
      R.push(await res2.text() + "/" + await cl.text());
      const res3 = await fetch("hello.txt");
      const buf = await res3.arrayBuffer();
      R.push(buf.byteLength + "/" + new TextDecoder().decode(buf));
      __r = R;
    })().catch(e => { __r = ["ERR:" + e.message]; })
  `);
  assert.deepEqual(s["__r"], [
    "200/true/data.json/true",
    '{"a":1,"list":[1,2]}',
    "true",
    "reuse:true",
    "hello world/hello world",
    "11/hello world",
  ]);
});

void test("Response.body is a real ReadableStream (getReader/read chunks)", async () => {
  const s = await runVirtual(`
    (async () => {
      const res = await fetch("hello.txt");
      const reader = res.body.getReader();
      const c1 = await reader.read();
      const c2 = await reader.read();
      __r = [c1.done, new TextDecoder().decode(c1.value), c2.done];
    })().catch(e => { __r = ["ERR:" + e.message]; })
  `);
  assert.deepEqual(s["__r"], [false, "hello world", true]);
});

void test("HTTP failure resolves with ok=false; network failure and abort REJECT", async () => {
  const s = await runVirtual(`
    (async () => {
      const R = [];
      const res = await fetch("missing.txt");
      R.push(res.status + "/" + res.ok + "/" + await res.text());
      const ac = new AbortController();
      ac.abort();
      try { await fetch("hello.txt", { signal: ac.signal }); R.push("abort:MISS"); }
      catch (e) { R.push("abort:" + e.name + "/" + (e instanceof DOMException)); }
      __r = R;
    })().catch(e => { __r = ["ERR:" + e.message]; })
  `);
  assert.deepEqual(s["__r"], [
    "404/false/",
    "abort:AbortError/true",
  ]);
});

void test("XHR: readyState march + load/loadend ordering, responseURL, responseText", async () => {
  const s = await runVirtual(`
    (async () => {
      const xhr = new XMLHttpRequest();
      const events = [];
      xhr.onreadystatechange = () => events.push("rs" + xhr.readyState);
      xhr.onloadstart = () => events.push("start");
      xhr.onload = () => events.push("load" + xhr.status);
      xhr.onloadend = () => events.push("end" + xhr.readyState);
      xhr.open("GET", "data.json");
      xhr.setRequestHeader("X-Test", "v");
      xhr.send();
      for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0));
      __r = [events.join(","), xhr.responseURL.split("/").pop(), xhr.responseText];
    })().catch(e => { __r = ["ERR:" + e.message]; })
  `);
  const r0 = s["__r"] as [string, string, string];
  const events = r0[0];
  // rs1 (open) → rs2 (headers) → rs3 (loading) → rs4 (done) → load → loadend
  assert.ok(events.startsWith("rs1,"));
  assert.ok(events.includes("rs2"));
  assert.ok(events.includes("rs4"));
  assert.ok(events.includes("load200"));
  assert.ok(events.endsWith("end4"));
  assert.equal(r0[1], "data.json");
  assert.equal(r0[2], JSON.stringify({ a: 1, list: [1, 2] }));
});

void test("XHR: response headers readable; responseType json/arraybuffer decode", async () => {
  const s = await runVirtual(`
    (async () => {
      const R = [];
      const xhr = new XMLHttpRequest();
      xhr.open("GET", "hello.txt");
      xhr.onloadend = () => {
        R.push(xhr.getResponseHeader("content-type"));
        R.push(xhr.getAllResponseHeaders().trim().toLowerCase().includes("content-type"));
      };
      xhr.send();
      for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0));
      const xhr2 = new XMLHttpRequest();
      xhr2.responseType = "json";
      xhr2.open("GET", "data.json");
      xhr2.onloadend = () => R.push(JSON.stringify(xhr2.response));
      xhr2.send();
      for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0));
      const xhr3 = new XMLHttpRequest();
      xhr3.responseType = "arraybuffer";
      xhr3.open("GET", "blob.bin");
      xhr3.onloadend = () => R.push(new TextDecoder().decode(xhr3.response));
      xhr3.send();
      for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0));
      __r = R;
    })().catch(e => { __r = ["ERR:" + e.message]; })
  `);
  assert.deepEqual(s["__r"], [
    "text/plain; charset=utf-8",
    true,
    '{"a":1,"list":[1,2]}',
    "ABCD",
  ]);
});

void test("XHR: HTTP 404 completes as load (not error); send() state errors are DOMExceptions", async () => {
  const s = await runVirtual(`
    (async () => {
      const R = [];
      const xhr = new XMLHttpRequest();
      xhr.open("GET", "missing.txt");
      xhr.onload = () => R.push("load" + xhr.status);
      xhr.onerror = () => R.push("error");
      xhr.send();
      for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0));
      const bad = new XMLHttpRequest();
      try { bad.send(); R.push("send:MISS"); }
      catch (e) { R.push("send:" + e.name + "/" + (e instanceof DOMException)); }
      try { bad.setRequestHeader("x", "y"); R.push("hdr:MISS"); }
      catch (e) { R.push("hdr:" + e.name); }
      const sync = new XMLHttpRequest();
      try { sync.open("GET", "hello.txt", false); R.push("sync:MISS"); }
      catch (e) { R.push("sync:" + e.name); }
      __r = R;
    })().catch(e => { __r = ["ERR:" + e.message]; })
  `);
  assert.deepEqual(s["__r"], [
    "load404",
    "send:InvalidStateError/true",
    "hdr:InvalidStateError",
    "sync:InvalidAccessError",
  ]);
});

void test("XHR: abort() fires abort + resets state (and suppresses load)", async () => {
  const s = await runVirtual(
    `
    (async () => {
      const R = [];
      const xhr = new XMLHttpRequest();
      xhr.open("GET", "data.json");
      xhr.onabort = () => R.push("abort" + xhr.readyState);
      xhr.onload = () => R.push("load" + xhr.readyState); // must NOT fire post-abort
      xhr.onloadend = () => R.push("end" + xhr.readyState);
      xhr.send();
      xhr.abort();
      for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0));
      __r = R;
    })().catch(e => { __r = ["ERR:" + e.message]; })
  `,
  );
  const arr = s["__r"] as unknown[];
  // abort → readyState 0, abort + loadend events, and the in-flight fetch's
  // later resolution must NOT resurrect a load/readystatechange.
  assert.deepEqual(arr, ["abort0", "end0"]);
});

void test("real runner: browserFetch receives method/headers/body; responses adapt to guest Response", async () => {
  const calls: string[] = [];
  const browserFetch: GuestBrowserFetch = (url: unknown, init?: unknown) => {
    const i = init as { method?: string; headers?: Record<string, string>; body?: unknown };
    calls.push(`${String(url)}|${i?.method ?? "?"}|${JSON.stringify(i?.headers ?? {})}`);
    const ok = String(url).endsWith("data.json");
    const body = ok ? '{"ok":true}' : "";
    return Promise.resolve({
      ok,
      status: ok ? 200 : 404,
      url: String(url),
      headers: {
        get: (n: unknown) =>
          ({ "content-type": "application/json", "x-c": "9" })[String(n).toLowerCase()] ?? null,
        has: (n: unknown) => String(n).toLowerCase() in { "content-type": 1, "x-c": 1 },
        // Enumerable so adaptResponseLike captures every header (a
        // get/has-only facade can only probe the common-name list).
        entries: function* () {
          yield ["content-type", "application/json"] as [string, string];
          yield ["x-c", "9"] as [string, string];
        },
      },
      text: () => Promise.resolve(body),
      json: () => Promise.resolve(JSON.parse(body) as unknown),
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode(body).buffer),
    });
  };
  const out = await runScriptsOnSessionReal(
    new FineSession(DOC, BASE),
    [`
      (async () => {
        const R = [];
        const r = new Request("data.json", { method: "PUT", headers: { "X-H": "v" }, body: "B" });
        const res = await fetch(r);
        R.push(res.status + "/" + res.ok + "/" + (res instanceof Response));
        R.push(JSON.stringify(await res.json()) + "/" + res.headers.get("x-c"));
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "data.json");
        xhr.setRequestHeader("X-Q", "1");
        xhr.onload = () => R.push("xhr:" + xhr.status + "/" + xhr.responseText);
        xhr.send("xbody");
        await new Promise(rr => setTimeout(rr, 20));
        __r = R;
      })().catch(e => { __r = ["ERR:" + e.message]; })
    `],
    undefined,
    { browserFetch },
  );
  const sandbox = out.sandbox as Record<string, unknown>;
  for (let i = 0; i < 40 && sandbox["__r"] === undefined; i += 1) {
    await out.flushAsync?.();
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(out.error, null);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox["__r"])), [
    "200/true/true",
    '{"ok":true}/9',
    "xhr:200/{\"ok\":true}",
  ]);
  assert.equal(calls.length, 2);
  const [u0, m0, h0] = calls[0]!.split("|");
  assert.equal(u0, "https://x.test/app/data.json");
  assert.equal(m0, "PUT");
  assert.equal((JSON.parse(h0!) as Record<string, string>)["x-h"], "v");
  assert.equal(calls[1]!.split("|")[1], "POST");
  assert.equal((JSON.parse(calls[1]!.split("|")[2]!) as Record<string, string>)["x-q"], "1");
});

void test("real runner: transport rejection surfaces as realm TypeError", async () => {
  const browserFetch: GuestBrowserFetch = () => {
    throw new Error("socket reset");
  };
  const out = await runScriptsOnSessionReal(
    new FineSession(DOC, BASE),
    [`
      (async () => {
        try { await fetch("boom"); __r = ["MISS"]; }
        catch (e) { __r = [e.name, e instanceof TypeError, e.message]; }
      })().catch(e => { __r = ["ERR:" + e.message]; })
    `],
    undefined,
    { browserFetch },
  );
  const sandbox = out.sandbox as Record<string, unknown>;
  for (let i = 0; i < 20 && sandbox["__r"] === undefined; i += 1) {
    await out.flushAsync?.();
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox["__r"])), ["TypeError", true, "socket reset"]);
});
