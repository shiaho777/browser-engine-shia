/**
 * RFC 0011/0012/0013 evidence: activation behavior (links, forms, targets),
 * bounded bfcache retention with pagehide/pageshow, and nested browsing
 * contexts (iframe loading, bitmap compositing, WindowProxy, postMessage,
 * sandbox isolation) — end to end over real local `node:http` servers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TabSession } from "./tab-session.js";
import { TabHost } from "./tab-host.js";
import { LocalStorageRegistry, parseWindowFeatures } from "./session.js";
import { existsSync, readFileSync } from "node:fs";

process.env["BROWSER_ENGINE_USE_CURL"] = "0";

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string | string[] | undefined>;
  body: string;
}

function serve(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const rec: Seen = {
      url: req.url ?? "",
      method: req.method ?? "",
      headers: { ...req.headers },
      body: "",
    };
    seen.push(rec);
    req.on("data", (chunk: Buffer) => {
      rec.body += chunk.toString("utf8");
    });
    req.on("end", () => handler(req, res));
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

const HTML = (body: string): string =>
  `<!doctype html><html><body>${body}</body></html>`;

// ---------------------------------------------------------------------------
// RFC 0011 — activation behavior
// ---------------------------------------------------------------------------

void test("activation: clicking a link navigates for real (guest event path)", async () => {
  const { server, url, seen } = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      req.url === "/"
        ? HTML(`<a href="/target" style="display:block;width:300px;height:60px">go</a>`)
        : HTML(`<p>target-landed</p>`),
    );
  });
  try {
    const tab = new TabSession(1);
    await tab.navigate(`${url}/`);
    const result = await tab.clickAt(10, 10);
    assert.ok(result.navigated, "clickAt reports the navigation");
    assert.equal(tab.url, `${url}/target`, "link activation navigated the tab");
    const targetReq = seen.find((s) => s.url === "/target")!;
    assert.equal(targetReq.headers["sec-fetch-dest"], "document");
    assert.equal(targetReq.method, "GET");
  } finally {
    await close(server);
  }
});

void test("activation: preventDefault on a click listener cancels navigation", async () => {
  const { server, url, seen } = await serve((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      HTML(
        `<a id="x" href="/target" style="display:block;width:300px;height:60px">go</a>` +
          `<script>document.getElementById('x').addEventListener('click',(e)=>e.preventDefault());</script>`,
      ),
    );
  });
  try {
    const tab = new TabSession(1);
    await tab.navigate(url);
    const result = await tab.clickAt(10, 10);
    assert.equal(tab.url, `${url}/`, "preventDefault stopped the navigation");
    assert.equal(result.navigated, false);
    assert.ok(
      seen.every((s) => s.url === "/"),
      "no request left the origin document",
    );
  } finally {
    await close(server);
  }
});

void test("activation: target=_blank hands the URL to the tab owner", async () => {
  const { server, url } = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      HTML(`<a href="/popped" target="_blank" style="display:block;width:300px;height:60px">x</a>`),
    );
  });
  try {
    const tab = new TabSession(1);
    const opened: string[] = [];
    tab.onNewTab = (u) => opened.push(u);
    await tab.navigate(url);
    await tab.clickAt(10, 10);
    assert.deepEqual(opened, [`${url}/popped`], "_blank routed to onNewTab");
    assert.equal(tab.url, `${url}/`, "the opener did not navigate");
  } finally {
    await close(server);
  }
});

void test("activation: GET form submission appends urlencoded data", async () => {
  const { server, url, seen } = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      HTML(
        `<form action="/search">` +
          `<input name="q" value="hello world">` +
          `<input type="checkbox" name="flag" value="yes" checked>` +
          `<input type="checkbox" name="off" value="no">` +
          // RFC 0021: inputs now carry real intrinsic size — the button
          // shares their line unless it establishes a block box.
          `<button name="go" value="1" style="display:block;width:200px;height:40px">Search</button>` +
          `</form>`,
      ),
    );
  });
  try {
    const tab = new TabSession(1);
    await tab.navigate(url);
    await tab.clickAt(20, 40); // the submit button, below the inputs' line
    assert.ok(tab.url.startsWith(`${url}/search?`), `GET query URL: ${tab.url}`);
    const query = tab.url.split("?")[1]!;
    const params = new URLSearchParams(query);
    assert.equal(params.get("q"), "hello world");
    assert.equal(params.get("flag"), "yes");
    assert.equal(params.get("off"), null, "unchecked control is not successful");
    assert.equal(params.get("go"), "1", "the activating submitter contributes");
    assert.ok(seen.some((s) => s.url.startsWith("/search?")), "request hit the wire");
  } finally {
    await close(server);
  }
});

void test("activation: POST form carries method+body+content-type on the wire", async () => {
  const { server, url, seen } = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      req.url === "/"
        ? HTML(
            `<form action="/submit" method="post">` +
              // Submit first in DOM order → clickAt hits it unambiguously;
              // successful-control collection is order-independent anyway.
              `<input type="submit" value="Send" style="display:block;width:200px;height:40px">` +
              `<input name="a" value="1"><input name="b" value="two">` +
              `</form>`,
          )
        : HTML(`<p>posted</p>`),
    );
  });
  try {
    const tab = new TabSession(1);
    await tab.navigate(`${url}/`);
    await tab.clickAt(20, 20);
    assert.equal(tab.url, `${url}/submit`);
    const post = seen.find((s) => s.url === "/submit")!;
    assert.equal(post.method, "POST");
    assert.equal(post.body, "a=1&b=two");
    assert.equal(
      post.headers["content-type"],
      "application/x-www-form-urlencoded",
    );
  } finally {
    await close(server);
  }
});

void test("activation: form.submit() skips the submit event; requestSubmit fires it", async () => {
  const { server, url, seen } = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      req.url === "/"
        ? HTML(
            `<form id="f" action="/via-submit">` +
              `<input name="k" value="v">` +
              `</form>` +
              `<script>` +
              `const f=document.getElementById('f');` +
              `f.addEventListener('submit',(e)=>{` +
              `e.preventDefault();sessionStorage.setItem('ev','1');` +
              `});` +
              `f.submit();` + // spec: skips the submit event → intent queued
              `f.requestSubmit();` + // fires submit → preventDefault → suppressed
              `</script>`,
          )
        : HTML(`<p>landed</p>`),
    );
  });
  try {
    const tab = new TabSession(1);
    await tab.navigate(`${url}/`);
    // submit() bypassed the cancelable listener → the tab navigated.
    assert.equal(tab.url, `${url}/via-submit?k=v`);
    assert.ok(seen.some((s) => s.url === "/via-submit?k=v"));
    // …and requestSubmit's event DID fire before that navigation — the marker
    // survives it because sessionStorage is per-(tab,origin), not per-page.
    assert.equal(
      tab.sessionStorage.getItem("ev"),
      "1",
      "requestSubmit dispatched the cancelable submit event",
    );
  } finally {
    await close(server);
  }
});

void test("activation: reset restores control state end-to-end via re-submit", async () => {
  const { server, url } = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      req.url === "/"
        ? HTML(
            `<form action="/r" id="f">` +
              `<input type="reset" value="R">` +
              `<input type="checkbox" name="c" checked>` +
              `<input type="submit" name="s" value="1">` +
              `</form>` +
              `<script>` +
              `document.getElementById('f').addEventListener('reset',()=>{` +
              `sessionStorage.setItem('rs','1');});` +
              `</script>`,
          )
        : HTML(`<p>${req.url}</p>`),
    );
  });
  try {
    const tab = new TabSession(1);
    await tab.navigate(`${url}/`);
    const dom = tab.context.page!.dom;
    const inputOf = (type: string) =>
      [...dom.nodes.entries()].find(
        ([, n]) => n.kind === "element" && n.tag === "input" && n.attrs?.get("type") === type,
      )![0];
    const click = (id: number): void => {
      tab.context.page!.runtime!.clickElement!(id as never);
    };
    click(inputOf("checkbox")); // toggle off — nodeState now overrides the attr
    click(inputOf("reset")); // resets: markup default (checked) returns
    click(inputOf("submit"));
    await tab.context.drainIntents();
    // The reset event marker survives the submit navigation (sessionStorage
    // is tab×origin scoped, not page scoped).
    assert.equal(tab.sessionStorage.getItem("rs"), "1", "reset event fired");
    assert.equal(tab.url, `${url}/r?c=on&s=1`, "reset restored checked ⇒ successful control");
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// RFC 0012 — bounded bfcache
// ---------------------------------------------------------------------------

void test("bfcache: traversal restores the retained page — no refetch, events fire", async () => {
  let hitsA = 0;
  const { server, url } = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    if (req.url === "/a") {
      hitsA += 1;
      res.end(
        HTML(
          `<script>` +
            `window.__log=[];` +
            `window.addEventListener('pagehide',(e)=>__log.push('hide:'+e.persisted));` +
            `window.addEventListener('pageshow',(e)=>__log.push('show:'+e.persisted));` +
            `</script><div style="height:3000px">A</div>`,
        ),
      );
      return;
    }
    res.end(HTML(`<p>B</p>`));
  });
  try {
    const tab = new TabSession(1);
    await tab.navigate(`${url}/a`);
    await tab.scrollBy(0, 400, { settle: true });
    const y = tab.scrollY;
    assert.ok(y > 0);
    await tab.navigate(`${url}/b`);
    assert.equal(tab.url, `${url}/b`);
    const hitsBeforeBack = hitsA;
    await tab.back();
    assert.equal(tab.url, `${url}/a`);
    assert.equal(hitsA, hitsBeforeBack, "bfcache restore did NOT refetch /a");
    assert.equal(tab.scrollY, y, "scroll position restored from the entry");
    const log = tab.context.globals?.["__log"] as string[];
    // `log` is a VM-realm Array — join to a primitive before asserting.
    assert.equal(log.join(","), "show:false,hide:true,show:true", "lifecycle order");
  } finally {
    await close(server);
  }
});

void test("bfcache: retention cap evicts — distant entries refetch", async () => {
  const hits = new Map<string, number>();
  const { server, url } = await serve((req, res) => {
    hits.set(req.url ?? "", (hits.get(req.url ?? "") ?? 0) + 1);
    res.writeHead(200, { "content-type": "text/html" });
    res.end(HTML(`<p>${req.url}</p>`));
  });
  try {
    const tab = new TabSession(1);
    for (const p of ["/p0", "/p1", "/p2", "/p3", "/p4"]) {
      await tab.navigate(`${url}${p}`);
    }
    // Retention cap is 3 → /p0's page was evicted when /p3 was stashed.
    await tab.back(); // p4 → p3 (retained)
    assert.equal(hits.get("/p3"), 1, "p3 restored from retention");
    // Drain back to p0 — cap eviction means it must reload.
    await tab.back(); // p3 → p2 (retained)
    await tab.back(); // p2 → p1 (retained)
    await tab.back(); // p1 → p0 — EVICTED, refetches
    assert.equal(tab.url, `${url}/p0`);
    assert.equal(hits.get("/p0"), 2, "evicted entry reloaded over the wire");
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// RFC 0013 — nested browsing contexts
// ---------------------------------------------------------------------------

void test("frames: iframe src loads a child context and composites its bitmap", async () => {
  const { server, url } = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      req.url === "/child"
        ? HTML(`<div style="background:#f00;width:100%;height:100%">child</div>`)
        : HTML(
            `<iframe src="/child" style="width:200px;height:100px;border:0"></iframe>`,
          ),
    );
  });
  try {
    const tab = new TabSession(1);
    await tab.navigate(url);
    const frames = tab.context.frames;
    assert.equal(frames.size, 1, "one child context discovered");
    const child = [...frames.values()][0]!;
    assert.equal(child.url, `${url}/child`, "child history committed its URL");
    assert.ok(child.page !== null && child.page.pngBytes !== undefined);
    const images = tab.page?.frameImages;
    assert.ok(images !== undefined && images.size === 1, "child bitmap composited");
    const img = [...images.values()][0]!;
    assert.ok(img.width >= 199 && img.width <= 201, `bitmap at iframe size: ${img.width}`);
    assert.ok(img.height >= 99 && img.height <= 101, `bitmap height: ${img.height}`);
  } finally {
    await close(server);
  }
});

void test("frames: srcdoc renders without touching the network", async () => {
  let childHits = 0;
  const { server, url } = await serve((req, res) => {
    if (req.url !== "/") childHits += 1;
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      HTML(
        `<iframe srcdoc="<p>srcdoc-content</p>" style="width:200px;height:100px"></iframe>`,
      ),
    );
  });
  try {
    const tab = new TabSession(1);
    await tab.navigate(url);
    assert.equal(childHits, 0, "srcdoc never fetched");
    const child = [...tab.context.frames.values()][0]!;
    assert.ok(child.page !== null, "child page exists");
    assert.equal(childHits, 0);
  } finally {
    await close(server);
  }
});

void test("frames: postMessage crosses contexts with source identity", async () => {
  const { server, url } = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      req.url === "/child"
        ? HTML(
            `<script>` +
              `window.addEventListener('message',(e)=>{` +
              `window.__cgot=e.data;` +
              `e.source.postMessage('ack:'+e.data,'*');` +
              `});` +
              `</script><p>child</p>`,
          )
        : HTML(
            `<iframe id="f" src="/child" style="width:200px;height:100px"></iframe>` +
              `<script>` +
              `document.getElementById('f').addEventListener('load',()=>{` +
              `window.__len=window.length;` +
              `frames[0].postMessage('hello','*');` +
              `});` +
              `window.addEventListener('message',(e)=>{` +
              `window.__pm=e.data;` +
              `window.__srcOk=(e.source===frames[0]);` +
              `});` +
              `</script>`,
          ),
    );
  });
  try {
    const tab = new TabSession(1);
    await tab.navigate(url);
    await tab.pump(2); // let the queued cross-context work settle
    const g = tab.context.globals!;
    assert.equal(g["__len"], 1, "window.length reflects the live child frame");
    assert.equal(g["__pm"], "ack:hello", "child replied through its source proxy");
    assert.equal(g["__srcOk"], true, "event.source is the same WindowProxy as frames[0]");
    const child = [...tab.context.frames.values()][0]!;
    assert.equal(child.globals?.["__cgot"], "hello", "child received the message");
  } finally {
    await close(server);
  }
});

void test("frames: sandbox without allow-scripts runs the child scriptless", async () => {
  const { server, url } = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      req.url === "/child"
        ? HTML(`<script>window.__evil=1;</script><p>sandboxed</p>`)
        : HTML(`<iframe sandbox src="/child" style="width:200px;height:100px"></iframe>`),
    );
  });
  try {
    const tab = new TabSession(1);
    await tab.navigate(url);
    const child = [...tab.context.frames.values()][0]!;
    assert.ok(child.page !== null, "sandboxed child still renders");
    assert.equal(
      child.globals?.["__evil"],
      undefined,
      "sandbox blocked the child's script",
    );
  } finally {
    await close(server);
  }
});

void test("frames: target=_top inside an iframe navigates the root context", async () => {
  const { server, url } = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      req.url === "/child"
        ? HTML(`<a href="/popped-top" target="_top" id="x">esc</a>`)
        : req.url === "/popped-top"
          ? HTML(`<p>escaped</p>`)
          : HTML(`<iframe src="/child" style="width:200px;height:100px"></iframe>`),
    );
  });
  try {
    const tab = new TabSession(1);
    await tab.navigate(url);
    const child = [...tab.context.frames.values()][0]!;
    // Click the link inside the CHILD's live runtime (a guest path, same as
    // a real click routed through the child's event dispatch).
    const aId = [...child.page!.dom.nodes.entries()].find(
      ([, n]) => n.kind === "element" && n.tag === "a",
    )![0];
    child.page!.runtime!.clickElement!(aId);
    await child.drainIntents();
    // The parent's _top dispatch is async (queued like a real task) — pump.
    await tab.pump(2);
    assert.equal(tab.url, `${url}/popped-top`, "_top escaped to the root context");
  } finally {
    await close(server);
  }
});

void test("frames: named target navigates the same-named child frame", async () => {
  const { server, url } = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      req.url === "/slot-target"
        ? HTML(`<p>into-named-frame</p>`)
        : req.url === "/child"
          ? HTML(`<p>child</p>`)
          : HTML(
              `<a href="/slot-target" target="slot" id="x">into frame</a>` +
                `<iframe name="slot" src="/child" style="width:200px;height:100px"></iframe>`,
            ),
    );
  });
  try {
    const tab = new TabSession(1);
    await tab.navigate(url);
    const child = [...tab.context.frames.values()][0]!;
    assert.equal(child.url, `${url}/child`);
    const aId = [...tab.context.page!.dom.nodes.entries()].find(
      ([, n]) => n.kind === "element" && n.tag === "a",
    )![0];
    tab.context.page!.runtime!.clickElement!(aId);
    await tab.context.drainIntents();
    await tab.pump(2); // named dispatch queues the child's own drain
    assert.equal(tab.url, `${url}/`, "the opener stayed put");
    assert.equal(child.url, `${url}/slot-target`, "named target navigated THAT frame");
  } finally {
    await close(server);
  }
});

void test("frames: iframe load event fires on the element after boot", async () => {
  const { server, url } = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      req.url === "/child"
        ? HTML(`<p>child</p>`)
        : HTML(
            `<iframe id="f" src="/child" style="width:200px;height:100px"></iframe>` +
              `<script>` +
              `document.getElementById('f').addEventListener('load',()=>{window.__fload=1;});` +
              `</script>`,
          ),
    );
  });
  try {
    const tab = new TabSession(1);
    await tab.navigate(url);
    assert.equal(tab.context.globals?.["__fload"], 1, "iframe load event fired");
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// Frame-tree reconciliation: src/srcdoc mutation, insertion, removal
// ---------------------------------------------------------------------------

void test("frames: iframe.setAttribute('src') re-navigates the child context", async () => {
  const { server, url, seen } = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      req.url === "/a" || req.url === "/b"
        ? HTML(`<p>${req.url}</p>`)
        : HTML(
            // Click-driven so the drift happens AFTER the initial child load.
            `<button id="x" style="display:block;width:200px;height:40px">mutate</button>` +
              `<iframe id="f" src="/a" style="width:200px;height:100px"></iframe>` +
              `<script>` +
              `document.getElementById('x').addEventListener('click',()=>{` +
              `document.getElementById('f').setAttribute('src','/b');});` +
              `</script>`,
          ),
    );
  });
  try {
    const tab = new TabSession(1);
    await tab.navigate(url);
    const child = [...tab.context.frames.values()][0]!;
    assert.equal(child.url, `${url}/a`);
    await tab.clickAt(50, 20); // hit the button → setAttribute('src','/b')
    assert.equal(child.url, `${url}/b`, "src drift navigated the child");
    assert.ok(seen.some((s) => s.url === "/b"), "the child reload hit the wire");
    assert.ok(child.canGoBack(), "the mutation pushed a child history entry");
  } finally {
    await close(server);
  }
});

void test("frames: script-inserted iframe loads; detached iframe drops context", async () => {
  const { server, url } = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      req.url === "/c"
        ? HTML(`<p>inserted</p>`)
        : HTML(
            `<iframe id="gone" src="/c" style="width:120px;height:60px"></iframe>` +
              `<script>` +
              `setTimeout(()=>{` +
              `const f=document.createElement('iframe');` +
              `f.setAttribute('src','/c');` +
              `f.setAttribute('style','width:100px;height:50px');` +
              `document.body.appendChild(f);` +
              `document.getElementById('gone').remove();` +
              `},0);` +
              `</script>`,
          ),
    );
  });
  try {
    const tab = new TabSession(1);
    await tab.navigate(url);
    assert.equal(tab.context.frames.size, 1);
    await tab.pump(3);
    assert.equal(tab.context.frames.size, 1, "one removed, one inserted — net 1");
    const child = [...tab.context.frames.values()][0]!;
    // The LIVE child is the inserted one (same URL, different node identity).
    assert.equal(child.url, `${url}/c`);
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// beforeunload → chrome prompt hook
// ---------------------------------------------------------------------------

void test("beforeunload: canceled event consults confirmBeforeLeave; decline aborts", async () => {
  const { server, url } = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      req.url === "/guard"
        ? HTML(
            `<script>` +
              `window.addEventListener('beforeunload',(e)=>{e.preventDefault();});` +
              `</script><p>guarded</p>`,
          )
        : HTML(`<p>free</p>`),
    );
  });
  try {
    const tab = new TabSession(1);
    tab.confirmBeforeLeave = () => false; // user clicks "stay"
    await tab.navigate(`${url}/guard`);
    await tab.navigate(`${url}/free`);
    assert.equal(tab.url, `${url}/guard`, "declined prompt aborted the navigation");
    // No phantom entry was written either.
    assert.equal(tab.historyList.length, 1);
    tab.confirmBeforeLeave = () => true; // user clicks "leave"
    await tab.navigate(`${url}/free`);
    assert.equal(tab.url, `${url}/free`, "accepted prompt let the navigation through");
  } finally {
    await close(server);
  }
});

void test("beforeunload: legacy returnValue string also triggers the prompt gate", async () => {
  const { server, url } = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      req.url === "/guard"
        ? HTML(
            `<script>window.onbeforeunload=()=>"leave?";</script><p>guarded</p>`,
          )
        : HTML(`<p>free</p>`),
    );
  });
  try {
    const tab = new TabSession(1);
    let prompts = 0;
    tab.confirmBeforeLeave = () => {
      prompts += 1;
      return false;
    };
    await tab.navigate(`${url}/guard`);
    await tab.navigate(`${url}/free`);
    assert.equal(tab.url, `${url}/guard`, "returnValue string prompted, decline aborted");
    assert.equal(prompts, 1, "the chrome hook was consulted exactly once");
    // Traversal gating is checked on the GUARDED document: seed a forward
    // entry (/free), go back (leaving quiet /free needs no prompt), then
    // forward() away from /guard — declined prompt must block the traverse.
    tab.confirmBeforeLeave = () => true;
    await tab.navigate(`${url}/free`);
    await tab.back(); // /free's outgoing doc has no handler — traverses fine
    assert.equal(tab.url, `${url}/guard`);
    tab.confirmBeforeLeave = () => false;
    await tab.forward();
    assert.equal(tab.url, `${url}/guard`, "declined prompt blocked traversal");
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// sessionStorage cloning + _blank → real tab (remote shell path)
// ---------------------------------------------------------------------------

void test("sessionStorage clone: snapshot→restore starts equal, then diverges", async () => {
  const { server, url } = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(HTML(`<script>sessionStorage.setItem('k','v');</script><p>x</p>`));
  });
  try {
    const a = new TabSession(1);
    await a.navigate(url);
    const b = new TabSession(2);
    b.importSessionStorage(a.exportSessionStorage());
    await b.navigate(url); // same origin → the cloned store is live
    assert.equal(b.sessionStorage.getItem("k"), "v", "clone inherited the entry");
    // …then they diverge (spec: the copy is a snapshot, not a link).
    b.sessionStorage.setItem("k", "changed");
    b.sessionStorage.setItem("only-b", "1");
    assert.equal(a.sessionStorage.getItem("k"), "v", "opener unaffected");
    assert.equal(a.sessionStorage.getItem("only-b"), null);
  } finally {
    await close(server);
  }
});

void test("_blank opens a REAL tab with cloned sessionStorage over IPC", async () => {
  const { server, url } = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      req.url === "/pop"
        ? HTML(
            // Readback channel: hash-navigation reflects in the tab's URL.
            `<script>location.hash=sessionStorage.getItem('k')??'none';</script><p>pop</p>`,
          )
        : HTML(
            `<script>sessionStorage.setItem('k','v');</script>` +
              `<a href="/pop" target="_blank" style="display:block;width:300px;height:60px">x</a>`,
          ),
    );
  });
  try {
    const host = new TabHost();
    try {
      await host.active.navigate(url);
      await host.active.clickAt(10, 10);
      // onNewTabRequest → openInNewTab is async (export → spawn → import → nav);
      // poll until the new tab both exists AND has landed on the target.
      for (
        let i = 0;
        i < 200 && (host.list().length < 2 || !host.active.url.includes("#"));
        i += 1
      ) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(host.list().length, 2, "_blank spawned a real second tab");
      assert.equal(
        host.active.url,
        `${url}/pop#v`,
        "new tab navigated to the target AND inherited the cloned sessionStorage",
      );
    } finally {
      await host.dispose();
    }
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// Joint session history (HTML §7.4.1): the tab's back/forward walks ONE log
// spanning every frame — an iframe's own navigation rewinds the frame.
// ---------------------------------------------------------------------------

void test("joint history: child iframe navigation rewinds the FRAME on back()", async () => {
  const { server, url } = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    const u = req.url ?? "";
    res.end(
      u === "/first"
        ? HTML(`<p>first</p>`)
        : u === "/a"
          ? HTML(`<p>frame a</p>`)
          : u === "/b"
            ? HTML(`<p>frame b</p>`)
            : HTML(`<iframe src="/a" style="width:200px;height:100px"></iframe>`),
    );
  });
  try {
    const tab = new TabSession(1);
    await tab.navigate(`${url}/first`);
    await tab.navigate(`${url}/shell`);
    const child = [...tab.context.frames.values()][0]!;
    assert.equal(child.url, `${url}/a`);
    // The child navigates itself (a link click inside the frame would do the
    // same — the intent joins the joint log either way).
    await child.navigate(`${url}/b`);
    assert.equal(child.url, `${url}/b`);
    assert.equal(tab.url, `${url}/shell`, "child nav doesn't move the parent");
    // back(): the LAST joint step was the child's → the frame rewinds.
    await tab.back();
    assert.equal(child.url, `${url}/a`, "back() rewound the child frame");
    assert.equal(tab.url, `${url}/shell`, "parent stayed put on frame rewind");
    // forward(): the frame re-advances.
    await tab.forward();
    assert.equal(child.url, `${url}/b`, "forward() re-advanced the frame");
    // back, back: first unwinds the frame again, then the parent entry.
    await tab.back();
    await tab.back();
    assert.equal(tab.url, `${url}/first`, "then the parent's own entry wins");
  } finally {
    await close(server);
  }
});

void test("joint history: bfcache keeps a restored parent's children live", async () => {
  const { server, url } = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    const u = req.url ?? "";
    res.end(
      u === "/a"
        ? HTML(`<p>a</p>`)
        : u === "/other"
          ? HTML(`<p>other</p>`)
          : HTML(`<iframe src="/a" style="width:200px;height:100px"></iframe>`),
    );
  });
  try {
    const tab = new TabSession(1);
    await tab.navigate(`${url}/shell`);
    const child = [...tab.context.frames.values()][0]!;
    await child.navigate(`${url}/a`); // push a second child entry (same url)
    await tab.navigate(`${url}/other`);
    await tab.back(); // restores the retained parent page WITH its child
    assert.equal(tab.url, `${url}/shell`);
    assert.equal(tab.context.frames.size, 1, "the child context was retained");
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// localStorage persistence: one profile file, cold-start reload
// ---------------------------------------------------------------------------

void test("localStorage persists to a profile file across cold starts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "be-profile-"));
  const file = join(dir, "local-storage.json");
  const { server, url } = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      req.url === "/read"
        ? HTML(`<script>location.hash=localStorage.getItem('k')??'none';</script><p>r</p>`)
        : HTML(`<script>localStorage.setItem('k','v');</script><p>w</p>`),
    );
  });
  try {
    // Process 1 writes through the persisting registry.
    const a = new TabSession(1, new LocalStorageRegistry(file));
    await a.navigate(`${url}/write`);
    // Process 2: a brand-new registry on the same file (cold start).
    const b = new TabSession(2, new LocalStorageRegistry(file));
    await b.navigate(`${url}/read`);
    assert.ok(
      b.url.endsWith("#v"),
      `cold-started profile reloaded localStorage (url=${b.url})`,
    );
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// contentDocument: same-origin DOM bridge across VM contexts
// ---------------------------------------------------------------------------

void test("contentDocument: same-origin parent reaches into the child DOM", async () => {
  const { server, url } = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      req.url === "/kid"
        ? HTML(`<p id="t">hi</p>`)
        : HTML(
            `<iframe id="f" src="/kid" style="width:200px;height:100px"></iframe>` +
              `<script>` +
              `document.getElementById('f').addEventListener('load',()=>{` +
              `const d=document.getElementById('f').contentDocument;` +
              `window.__read = d===null ? 'null' : d.getElementById('t').textContent;` +
              `d.getElementById('t').textContent='mutated-from-parent';` +
              `});` +
              `</script>`,
          ),
    );
  });
  try {
    const tab = new TabSession(1);
    await tab.navigate(`${url}/shell`);
    assert.equal(
      tab.context.globals?.["__read"],
      "hi",
      "same-origin contentDocument read the child's DOM",
    );
    // The mutation landed on the CHILD's live session DOM.
    const child = [...tab.context.frames.values()][0]!;
    let mutated = "";
    for (const [, n] of child.page!.dom.nodes) {
      if (n.kind === "element" && n.tag === "p") {
        // text lives in child text nodes
      }
      if (n.kind === "text" && n.text !== undefined) mutated = n.text;
    }
    assert.equal(mutated, "mutated-from-parent", "writes flow to the child session");
  } finally {
    await close(server);
  }
});

void test("contentDocument: cross-origin and opaque-sandboxed children stay sealed", async () => {
  const { server: inner, url: innerUrl } = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(HTML(`<p>other-origin</p>`));
  });
  const { server, url } = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      HTML(
        `<iframe id="xo" src="${innerUrl}/kid" style="width:200px;height:60px"></iframe>` +
          `<iframe id="sb" sandbox="allow-scripts" src="/local" style="width:200px;height:60px"></iframe>` +
          `<script>` +
          `document.getElementById('xo').addEventListener('load',()=>{` +
          `window.__xo = document.getElementById('xo').contentDocument===null ? 'sealed' : 'open';});` +
          `document.getElementById('sb').addEventListener('load',()=>{` +
          `window.__sb = document.getElementById('sb').contentDocument===null ? 'sealed' : 'open';});` +
          `</script>`,
      ),
    );
  });
  try {
    const tab = new TabSession(1);
    await tab.navigate(`${url}/shell`);
    assert.equal(tab.context.globals?.["__xo"], "sealed", "cross-origin sealed");
    assert.equal(tab.context.globals?.["__sb"], "sealed", "opaque origin sealed");
    tab.dispose(); // RFC 0030: terminate the cross-origin child's worker
  } finally {
    await close(server);
    await close(inner);
  }
});

// ---------------------------------------------------------------------------
// window.open (HTML §7.2.2): feature strings, synchronous proxy returns,
// noopener/noreferrer plumbing through SessionHost → BrowsingContext → TabHost.
// ---------------------------------------------------------------------------

void test("window.open features: parse popup/geometry/noopener/noreferrer", () => {
  const f = parseWindowFeatures("width=400,height=300,left=10,popup");
  assert.deepEqual(
    { popup: f.popup, width: f.width, height: f.height, left: f.left, noopener: f.noopener, noreferrer: f.noreferrer },
    { popup: true, width: 400, height: 300, left: 10, noopener: false, noreferrer: false },
  );
  // Spec: noreferrer implies noopener (one flag opens detached).
  const nr = parseWindowFeatures("noreferrer");
  assert.equal(nr.noreferrer, true);
  assert.equal(nr.noopener, true, "noreferrer implies noopener");
  assert.equal(nr.popup, false, "no geometry ⇒ not popup-shaped");
  assert.equal(parseWindowFeatures("noopener=yes").noopener, true);
  assert.equal(parseWindowFeatures("").popup, false);
});

void test("window.open: _self returns own proxy; noopener _blank queues a tab", async () => {
  const { server, url } = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      (req.url ?? "") === "/two"
        ? HTML(`<p>two</p>`)
        : HTML(
            `<script>` +
              `sessionStorage.setItem('sp', String(window.open('/two','_self')===window));` +
              `sessionStorage.setItem('n', String(window.open('/x','_blank','noopener')===null));` +
              `</script>`,
          ),
    );
  });
  try {
    const tab = new TabSession(1);
    // The _self intent drains inside navigate — flags ride sessionStorage.
    await tab.navigate(`${url}/shell`);
    assert.equal(tab.url, `${url}/two`, "_self navigated this context");
    assert.equal(tab.sessionStorage.getItem("sp"), "true", "_self returns THE window proxy");
    assert.equal(tab.sessionStorage.getItem("n"), "true", "noopener returns null");
    // The noopener _blank call queued a real new-tab request for the shell.
    const reqs = tab.takeNewTabRequests();
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0]!.url, `${url}/x`);
  } finally {
    await close(server);
  }
});

void test("window.open: named target lands in the matching iframe", async () => {
  const { server, url } = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      (req.url ?? "") === "/kid"
        ? HTML(`<p>kid</p>`)
        : HTML(
            `<iframe id="fr" name="fr" src="about:blank" style="width:100px;height:50px"></iframe>` +
              // open() at boot precedes frame creation — gate on the iframe's
              // load event so the named context exists (spec: unknown names
              // would create a new named traversable).
              `<script>document.getElementById('fr').addEventListener('load',` +
              `()=>sessionStorage.setItem('pr', String(window.open('/kid','fr')!==null)));</script>`,
          ),
    );
  });
  try {
    const tab = new TabSession(1);
    await tab.navigate(`${url}/shell`);
    assert.equal(tab.sessionStorage.getItem("pr"), "true", "named target returns a proxy");
    // The open() fired during the child's load event — its drain races the
    // parent's frame setup; pump until the queued child nav lands.
    for (let i = 0; i < 50; i += 1) {
      await tab.context.drainIntents();
      const c = [...tab.context.frames.values()][0];
      if (c !== undefined && c.url === `${url}/kid`) break;
      await new Promise((r) => setTimeout(r, 5)); // real-time hop for the fetch
    }
    const child = [...tab.context.frames.values()][0]!;
    assert.equal(child.url, `${url}/kid`, "named target navigated the iframe");
  } finally {
    await close(server);
  }
});

void test("window.open noreferrer: _blank new tab navigation sends no Referer", async () => {
  const { server, url, seen } = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      (_req.url ?? "") === "/dest"
        ? HTML(`<p>dest</p>`)
        : HTML(`<script>window.open('/dest','_blank','noreferrer');</script>`),
    );
  });
  try {
    const host = new TabHost();
    try {
      await host.active.navigate(`${url}/shell`);
      for (
        let i = 0;
        i < 200 && (host.list().length < 2 || host.active.url !== `${url}/dest`);
        i += 1
      ) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(host.list().length, 2, "window.open spawned a real second tab");
      assert.equal(host.active.url, `${url}/dest`);
      const destReq = seen.find((r) => r.url === "/dest" && r.headers["referer"] !== undefined);
      assert.equal(destReq, undefined, "noreferrer suppressed Referer on the new tab's navigation");
      assert.ok(seen.some((r) => r.url === "/dest"), "destination was fetched");
    } finally {
      await host.dispose();
    }
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// Downloads: a[download] same-origin save + Content-Disposition: attachment
// consumes the navigation without committing a document.
// ---------------------------------------------------------------------------

void test("downloads: a[download] saves same-origin, attachment consumes nav", async () => {
  const dir = mkdtempSync(join(tmpdir(), "be-dl-"));
  const { server, url } = await serve((req, res) => {
    const u = req.url ?? "";
    if (u === "/file.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("file-bytes-123");
      return;
    }
    if (u === "/report") {
      res.writeHead(200, {
        "content-type": "text/csv",
        "content-disposition": 'attachment; filename="report.csv"',
      });
      res.end("a,b\n1,2\n");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      HTML(
        `<a id="dl" href="/file.txt" download="saved.txt">dl</a>` +
          `<a id="go" href="/report">go</a>`,
      ),
    );
  });
  try {
    const tab = new TabSession(1);
    tab.downloadsDir = dir;
    // Lifecycle events: started → (progress) → completed, with byte totals.
    const events: { filename: string; bytes: number; total: number | null; state: string }[] = [];
    tab.onDownload = (f) =>
      events.push({ filename: f.filename, bytes: f.bytes, total: f.totalBytes, state: f.state });
    await tab.navigate(`${url}/home`);
    const aId = [...tab.context.page!.dom.nodes.entries()].find(
      ([, n]) => n.kind === "element" && n.tag === "a" && n.attrs?.get("id") === "dl",
    )![0];
    tab.context.page!.runtime!.clickElement!(aId);
    await tab.context.drainIntents();
    const dl = events.filter((e) => e.filename === "saved.txt");
    assert.deepEqual(
      dl.map((e) => e.state),
      ["started", "completed"],
      "a[download] lifecycle: started → completed (small body ⇒ no progress)",
    );
    assert.equal(dl[1]!.bytes, 14);
    assert.equal(dl[1]!.total, 14, "Content-Length flowed into totalBytes");
    assert.equal(readFileSync(join(dir, "saved.txt"), "utf8"), "file-bytes-123");
    assert.equal(tab.url, `${url}/home`, "download did not navigate");
    // Content-Disposition: attachment on a top-level navigation is consumed.
    await tab.navigate(`${url}/report`);
    assert.equal(tab.url, `${url}/home`, "attachment response committed no document");
    const rep = events.filter((e) => e.filename === "report.csv" && e.state === "completed");
    assert.equal(rep.length, 1);
    assert.equal(rep[0]!.bytes, 8, "Content-Disposition filename honored");
    assert.equal(readFileSync(join(dir, "report.csv"), "utf8"), "a,b\n1,2\n");
    // No phantom history entry for the consumed download.
    assert.equal(tab.canGoBack(), false, "no phantom history entry for downloads");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await close(server);
  }
});

void test("downloads: cross-origin a[download] falls through to navigation", async () => {
  const { server: other, url: otherUrl } = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(HTML(`<p>other site</p>`));
  });
  const { server, url } = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(HTML(`<a id="x" href="${otherUrl}/p" download="s.bin">x</a>`));
  });
  const dir = mkdtempSync(join(tmpdir(), "be-dl-xo-"));
  try {
    const tab = new TabSession(1);
    tab.downloadsDir = dir;
    await tab.navigate(`${url}/home`);
    const aId = [...tab.context.page!.dom.nodes.entries()].find(
      ([, n]) => n.kind === "element" && n.tag === "a" && n.attrs?.get("id") === "x",
    )![0];
    tab.context.page!.runtime!.clickElement!(aId);
    await tab.context.drainIntents();
    assert.equal(tab.url, `${otherUrl}/p`, "cross-origin download attr ignored ⇒ navigated");
    assert.equal(existsSync(join(dir, "s.bin")), false, "no file for cross-origin");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await close(server);
    await close(other);
  }
});

// ---------------------------------------------------------------------------
// Joint history.length: every context observes the traversable-wide count.
// ---------------------------------------------------------------------------

void test("history.length is the JOINT traversable count in parent and child", async () => {
  const { server, url } = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    const u = req.url ?? "";
    res.end(
      u === "/a" || u === "/b"
        ? HTML(`<p>frame</p>`)
        : HTML(`<iframe src="/a" style="width:100px;height:50px"></iframe>`),
    );
  });
  try {
    const tab = new TabSession(1);
    await tab.navigate(`${url}/first`);
    await tab.navigate(`${url}/shell`);
    const child = [...tab.context.frames.values()][0]!;
    const parentLen = () =>
      (tab.context.globals?.["history"] as { length: number }).length;
    const childLen = () =>
      (child.globals?.["history"] as { length: number }).length;
    // Two committed steps: /first, /shell (the iframe's first load joins the
    // parent's step — no extra stop).
    assert.equal(parentLen(), 2);
    assert.equal(childLen(), 2, "child sees the same joint length");
    await child.navigate(`${url}/b`);
    assert.equal(parentLen(), 3, "child nav extended the joint log");
    assert.equal(childLen(), 3);
    await tab.back();
    assert.equal(child.url, `${url}/a`, "back() rewound the child");
    assert.equal(parentLen(), 3, "traversal never changes the log length");
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// Session history persistence: snapshot → cold restore → reload + traversal.
// ---------------------------------------------------------------------------

void test("session history: export/import restores entries and traverses", async () => {
  const { server, url, seen } = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(HTML(`<p>${req.url ?? ""}</p>`));
  });
  try {
    const tab = new TabSession(1);
    await tab.navigate(`${url}/a`);
    await tab.navigate(`${url}/b`);
    const snap = tab.exportSessionHistory();
    assert.equal(snap.entries.length, 2);
    assert.equal(snap.index, 1);
    assert.equal(snap.entries[0]!.url, `${url}/a`);

    // Cold start: a fresh session imports the snapshot — the current entry
    // reloads (documents come back fresh, live state never serializes).
    const cold = new TabSession(2);
    const hitsBefore = seen.length;
    await cold.importSessionHistory(snap);
    assert.equal(cold.url, `${url}/b`, "restore landed on the current entry");
    assert.ok(seen.length > hitsBefore, "restored entry refetched over the network");
    assert.ok(cold.canGoBack(), "restored history is traversable");
    await cold.back();
    assert.equal(cold.url, `${url}/a`, "back() after restart reaches /a");
    await cold.forward();
    assert.equal(cold.url, `${url}/b`);
  } finally {
    await close(server);
  }
});

void test("session history: TabHost export/restore round-trips over IPC", async () => {
  const { server, url } = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(HTML(`<p>${req.url ?? ""}</p>`));
  });
  const host = new TabHost();
  const host2 = new TabHost();
  try {
    await host.active.navigate(`${url}/a`);
    await host.active.navigate(`${url}/b`);
    const saved = await host.exportSession();
    assert.equal(saved.tabs.length, 1);
    assert.equal(saved.tabs[0]!.history.entries.length, 2);
    await host2.restoreSession(saved);
    await host2.active.pump(1);
    for (let i = 0; i < 100 && host2.active.url !== `${url}/b`; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(host2.active.url, `${url}/b`, "restored tab reloaded its current entry");
    assert.equal(host2.list().length, 1);
    assert.equal(host2.active.navState().canGoBack, true, "restored entries traverse");
  } finally {
    await host.dispose();
    await host2.dispose();
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// window.close / window.opener / named traversables / download lifecycle
// ---------------------------------------------------------------------------

void test("window.close: script-opened tab closes itself; a plain tab is ignored", async () => {
  const { server, url } = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      req.url === "/victim"
        ? HTML(`<script>window.close()</script>`)
        : // The parent's own close() is ignored (not script-closable); its
          // open() spawns a victim whose own close() IS honored.
          HTML(`<script>window.close();window.open('/victim','pop')</script>`),
    );
  });
  const host = new TabHost();
  try {
    await host.active.navigate(`${url}/home`);
    for (let i = 0; i < 200 && host.list().length < 2; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(host.list().length, 2, "window.open spawned a real tab");
    // The victim may already be gone (self-close races the poll) — assert on
    // the parent tab handle, which must not have moved or closed.
    assert.equal(host.tab(1) !== undefined, true, "parent's window.close() was ignored");
    assert.equal(host.tab(1)!.url, `${url}/home`);
    for (let i = 0; i < 200 && host.list().length > 1; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(host.list().length, 1, "script-opened tab self-closed");
    assert.equal(host.active.url, `${url}/home`, "parent tab survived");
  } finally {
    await host.dispose();
    await close(server);
  }
});

void test("window.opener.postMessage routes tab→tab over IPC, and e.source replies", async () => {
  const { server, url } = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      req.url === "/child"
        ? HTML(
            `<script>` +
              `window.addEventListener('message',e=>sessionStorage.setItem('ack',String(e.data)));` +
              `if(window.opener)window.opener.postMessage({hi:1},'*');` +
              `</script>`,
          )
        : HTML(
            `<script>` +
              `window.addEventListener('message',e=>{` +
              `sessionStorage.setItem('from',JSON.stringify(e.data)+':'+e.origin);` +
              `e.source.postMessage('ack','*');});` +
              `window.open('/child','pop');` +
              `</script>`,
          ),
    );
  });
  const host = new TabHost();
  try {
    await host.active.navigate(`${url}/home`);
    const parent = host.tab(1)!;
    for (let i = 0; i < 200 && host.list().length < 2; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const child = host.list().find((t) => t.id !== parent.id)!;
    const childTab = host.tab(child.id)!;
    const storeOf = async (t: typeof parent, key: string): Promise<string | null> => {
      const areas = await t.exportSessionStorage();
      const area = areas.find((a) => a.origin === url);
      const idx = area?.keys.indexOf(key) ?? -1;
      return idx >= 0 ? (area!.values[idx] ?? null) : null;
    };
    // Child → parent: the opener proxy's postMessage crossed the wire.
    let from: string | null = null;
    for (let i = 0; i < 200 && from === null; i += 1) {
      from = await storeOf(parent, "from");
      if (from === null) await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(from, `{"hi":1}:${url}`, "parent saw child's message + origin");
    // Parent → child via e.source: the reply proxy routes back the same way.
    let ack: string | null = null;
    for (let i = 0; i < 200 && ack === null; i += 1) {
      ack = await storeOf(childTab, "ack");
      if (ack === null) await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(ack, "ack", "child received the e.source reply");
  } finally {
    await host.dispose();
    await close(server);
  }
});

void test("named traversable: a second open('u','w1') navigates the SAME tab", async () => {
  const { server, url } = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    const u = req.url ?? "";
    res.end(
      u === "/a" || u === "/b"
        ? HTML(`<p>${u}</p>`)
        : u === "/p2"
          ? HTML(`<script>window.open('/b','w1')</script>`)
          : HTML(`<script>window.open('/a','w1')</script>`),
    );
  });
  const host = new TabHost();
  try {
    await host.active.navigate(`${url}/p1`);
    for (let i = 0; i < 200 && host.list().length < 2; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(host.list().length, 2, "'w1' registered a named tab");
    const w1 = host.list().find((t) => t.id !== 1)!;
    for (let i = 0; i < 200 && host.tab(w1.id)!.url !== `${url}/a`; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    // Second open with the same name REUSES the tab (no third tab).
    await host.tab(1)!.navigate(`${url}/p2`);
    for (let i = 0; i < 200 && host.tab(w1.id)!.url !== `${url}/b`; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(host.list().length, 2, "named reuse spawned no extra tab");
    assert.equal(host.tab(w1.id)!.url, `${url}/b`, "the named tab navigated");
  } finally {
    await host.dispose();
    await close(server);
  }
});

void test("download lifecycle: chunked progress events + a failed download reports", async () => {
  const dir = mkdtempSync(join(tmpdir(), "be-dl-prog-"));
  const big = Buffer.alloc(200 * 1024, 0x61); // > 64KB ⇒ progress events
  const { server, url } = await serve((req, res) => {
    const u = req.url ?? "";
    if (u === "/big.bin") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(big);
      return;
    }
    if (u === "/die") {
      req.socket.destroy(); // connection reset — the fetch throws
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      HTML(
        `<a id="big" href="/big.bin" download="big.bin">b</a>` +
          `<a id="die" href="/die" download="die.bin">d</a>`,
      ),
    );
  });
  try {
    const tab = new TabSession(1);
    tab.downloadsDir = dir;
    const events: { filename: string; state: string; bytes: number; error: string | null }[] = [];
    tab.onDownload = (f) =>
      events.push({ filename: f.filename, state: f.state, bytes: f.bytes, error: f.error });
    await tab.navigate(`${url}/home`);
    const click = async (id: string): Promise<void> => {
      const nid = [...tab.context.page!.dom.nodes.entries()].find(
        ([, n]) => n.kind === "element" && n.tag === "a" && n.attrs?.get("id") === id,
      )![0];
      tab.context.page!.runtime!.clickElement!(nid);
      await tab.context.drainIntents();
    };
    await click("big");
    const bigEvents = events.filter((e) => e.filename === "big.bin");
    assert.equal(bigEvents[0]!.state, "started");
    assert.equal(bigEvents[bigEvents.length - 1]!.state, "completed");
    const progresses = bigEvents.filter((e) => e.state === "progress");
    assert.ok(progresses.length >= 2, "200KB ⇒ multiple 64KB-chunk progress events");
    for (let i = 1; i < progresses.length; i += 1) {
      assert.ok(progresses[i]!.bytes > progresses[i - 1]!.bytes, "progress bytes increase");
    }
    const done = bigEvents[bigEvents.length - 1]!;
    assert.equal(done.bytes, 200 * 1024);
    assert.equal(readFileSync(join(dir, "big.bin")).byteLength, 200 * 1024);
    // A dead fetch reports 'failed' instead of vanishing silently.
    await click("die");
    const failed = events.filter((e) => e.state === "failed");
    assert.equal(failed.length, 1, "one failed-download event");
    assert.equal(failed[0]!.filename, "die.bin", "failed event carries the hint");
    assert.ok(failed[0]!.error !== null && failed[0]!.error !== "", "error message present");
    assert.equal(existsSync(join(dir, "die.bin")), false, "no file on failure");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// Referrer-Policy: element-level attrs override the document policy, which is
// itself set by the Referrer-Policy RESPONSE HEADER (header > meta > default).
// ---------------------------------------------------------------------------

void test("referrer-policy: element attrs + response header document policy", async () => {
  const { server, url, seen } = await serve((req, res) => {
    if (req.url === "/p/home") {
      res.writeHead(200, {
        "content-type": "text/html",
        "referrer-policy": "no-referrer",
      });
      res.end(
        HTML(
          `<a id="o" href="/a1" referrerpolicy="unsafe-url" style="display:block;width:200px;height:40px">o</a>` +
            `<a id="d" href="/a2" style="display:block;width:200px;height:40px">d</a>` +
            `<form action="/f" referrerpolicy="origin">` +
              `<input id="s" type="submit" value="s">` +
            `</form>`,
        ),
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(HTML(`<p>land</p>`));
  });
  try {
    const tab = new TabSession(1);
    const click = async (id: string): Promise<void> => {
      const nid = [...tab.context.page!.dom.nodes.entries()].find(
        ([, n]) => n.kind === "element" && n.attrs?.get("id") === id,
      )![0];
      tab.context.page!.runtime!.clickElement!(nid);
      await tab.context.drainIntents();
      await tab.pump(2);
    };
    await tab.navigate(`${url}/p/home`);
    await click("o");
    assert.equal(
      seen.find((r) => r.url === "/a1")?.headers["referer"],
      `${url}/p/home`,
      "element referrerpolicy=unsafe-url beats the document's no-referrer",
    );
    await tab.navigate(`${url}/p/home`);
    await click("d");
    assert.equal(
      seen.find((r) => r.url === "/a2")?.headers["referer"],
      undefined,
      "no element attr ⇒ document header policy (no-referrer) applies",
    );
    await tab.navigate(`${url}/p/home`);
    await click("s");
    const fReq = seen.find((r) => r.url.startsWith("/f"));
    assert.equal(
      fReq?.headers["referer"],
      `${url}/`,
      "form referrerpolicy=origin sends the bare origin",
    );
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// Cross-tab focus: window.focus() / opener.focus() ride focusRequests through
// NavState → browser process → tab-strip activation (spec: focus a browsing
// context asks the OS window/chrome to bring it forward).
// ---------------------------------------------------------------------------

void test("focus: opener.focus() routes through chrome and re-activates the opener tab", async () => {
  const { server, url } = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      req.url === "/popup"
        ? HTML(`<script>window.opener.focus();</script><p>pop</p>`)
        : HTML(`<script>window.open('/popup','_blank');</script>`),
    );
  });
  try {
    const host = new TabHost();
    try {
      await host.active.navigate(`${url}/shell`);
      // Popup opens (active = new tab), its boot script asks chrome to focus
      // the opener → the tab strip re-selects tab 1.
      for (
        let i = 0;
        i < 200 && !(host.list().length === 2 && host.list()[0]!.active);
        i += 1
      ) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(host.list().length, 2, "window.open spawned the popup tab");
      assert.equal(
        host.list().findIndex((t) => t.active),
        0,
        "opener.focus() re-selected the opener tab",
      );
    } finally {
      await host.dispose();
    }
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// Same-origin SCRIPTLESS child: iframe sandbox="allow-same-origin" keeps the
// origin but runs no runtime — contentDocument answers a read facade over
// the committed DomTree instead of null.
// ---------------------------------------------------------------------------

void test("frames: scriptless same-origin child answers contentDocument facade", async () => {
  const { server, url } = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      req.url === "/child"
        ? HTML(`<p id="hi">facade-text</p><div class="x"><span>deep</span></div>`)
        : HTML(
            `<iframe id="f" sandbox="allow-same-origin" src="/child" style="width:200px;height:60px"></iframe>` +
              `<script>` +
                `document.getElementById('f').addEventListener('load',function(){` +
                `var d=document.getElementById('f').contentDocument;` +
                `window.__fac=d===null?{t:'NULL'}:{` +
                `t:d.getElementById('hi').textContent.trim(),` +
                `tag:d.querySelector('.x span').tagName,` +
                `u:d.URL,` +
                `eq:d.getElementById('hi')===d.querySelector('#hi'),` +
                `body:d.body.textContent.indexOf('facade-text')>=0` +
                `};` +
                `});` +
              `</script>`,
          ),
    );
  });
  try {
    const tab = new TabSession(1);
    await tab.navigate(url);
    for (
      let i = 0;
      i < 100 && tab.context.page!.runtime!.globals?.["__fac"] === undefined;
      i += 1
    ) {
      await new Promise((r) => setTimeout(r, 20));
      await tab.pump(1);
    }
    const fac = tab.context.page!.runtime!.globals?.["__fac"] as
      | Record<string, unknown>
      | undefined;
    assert.ok(fac !== undefined && fac["t"] !== "NULL", "facade answered a document");
    assert.equal(fac["t"], "facade-text", "getElementById+textContent work");
    assert.equal(fac["tag"], "SPAN", "querySelector with descendant+class works");
    assert.equal(fac["eq"], true, "node identity is stable inside the facade");
    assert.equal(fac["body"], true, "document.body reads the child DOM");
    assert.ok(String(fac["u"]).endsWith("/child"), "document.URL is the child's");
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// HTTP shell: GET /api/downloads surfaces the lifecycle event log to chrome
// that isn't Electron (spec boundary — chrome owns UI, content owns bytes).
// ---------------------------------------------------------------------------

void test("shell: GET /api/downloads exposes the download event log", async () => {
  const dir = mkdtempSync(join(tmpdir(), "be-dl-http-"));
  const { server, url } = await serve((req, res) => {
    if (req.url === "/f.txt") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end("payload");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      HTML(
        `<a id="g" href="/f.txt" download="g.txt" style="display:block;width:400px;height:200px">g</a>`,
      ),
    );
  });
  const { startAppServer } = await import("./server.js");
  const app = await startAppServer({ port: 0, downloadsDir: dir });
  try {
    await fetch(`${app.url}api/navigate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: url }),
    });
    // The link fills the viewport — a real coordinate click drives it.
    await fetch(`${app.url}api/click`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x: 60, y: 60 }),
    });
    let downloads: { state: string; filename: string }[] = [];
    for (let i = 0; i < 100; i += 1) {
      const res = await fetch(`${app.url}api/downloads`);
      const body = (await res.json()) as {
        downloads: { state: string; filename: string }[];
      };
      downloads = body.downloads;
      if (downloads.some((d) => d.state === "completed")) break;
      await fetch(`${app.url}api/pump`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(
      downloads.some((d) => d.state === "started" && d.filename === "g.txt"),
      "started event reached the HTTP chrome surface",
    );
    const done = downloads.find((d) => d.state === "completed");
    assert.equal(done?.filename, "g.txt", "completed event reached chrome");
    assert.equal(readFileSync(join(dir, "g.txt"), "utf8"), "payload", "bytes landed");
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
    await close(server);
  }
});
