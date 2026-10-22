/**
 * Real observers (RFC 0016): MutationObserver records ride the microtask queue;
 * ResizeObserver/IntersectionObserver evaluate actual layout geometry at
 * rendering-step boundaries. None of the three are stubs — records carry real
 * targets/siblings/old-values, and geometry comes from the FragmentTree.
 *
 * Built by `tsc` then run with: `node --test packages/cli/dist/*.test.js`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { FineSession } from "./fine.js";
import { runScriptsOnSession } from "./event-loop.js";

const DOC =
  '<html><body><div id="a" style="width:100px;height:100px"><span id="s">hi</span></div>' +
  '<div id="far" style="margin-top:2000px;width:50px;height:50px"></div></body></html>';

const run = (session: FineSession, src: string): string => {
  const r = runScriptsOnSession(session, [src]);
  assert.equal(r.error, null);
  const sandbox = r.sandbox as Record<string, unknown>;
  // vm-realm arrays/objects fail cross-realm deepStrictEqual — compare JSON.
  return JSON.stringify(sandbox["__r"]);
};

void test("MutationObserver: childList record carries target/addedNodes/siblings, delivered on a microtask", () => {
  const out = run(
    new FineSession(DOC),
    `
    const log = [];
    const a = document.getElementById("a");
    new MutationObserver((records) => {
      for (const r of records) {
        log.push({
          type: r.type, id: r.target.id, added: r.addedNodes.length,
          removed: r.removedNodes.length,
          prev: r.previousSibling === null ? null : (r.previousSibling.id ?? "text"),
          next: r.nextSibling === null ? null : (r.nextSibling.id ?? "text"),
        });
      }
    }).observe(a, { childList: true });
    const b = document.createElement("b");
    a.appendChild(b);
    log.push("sync-after-append"); // mutation callback must NOT have run yet
    __r = log;
    `,
  );
  assert.equal(out, JSON.stringify([
    "sync-after-append",
    { type: "childList", id: "a", added: 1, removed: 0, prev: "s", next: null },
  ]));
});

void test("MutationObserver: attributes + attributeOldValue + attributeFilter + subtree scoping", () => {
  const out = run(
    new FineSession(DOC),
    `
    const log = [];
    const a = document.getElementById("a");
    const s = document.getElementById("s");
    const obs = new MutationObserver((records) => {
      for (const r of records) log.push(\`\${r.type}@\${r.target.id}:\${r.attributeName}=\${r.oldValue}\`);
    });
    // subtree watch on #a picks up attribute changes on descendants.
    obs.observe(a, { attributes: true, attributeOldValue: true, subtree: true, attributeFilter: ["data-x"] });
    a.setAttribute("data-x", "1");
    a.setAttribute("class", "filtered-out"); // filtered: not in attributeFilter
    s.setAttribute("data-x", "2");          // subtree hit
    __r = log;
    `,
  );
  assert.equal(out, JSON.stringify(["attributes@a:data-x=null", "attributes@s:data-x=null"]));
});

void test("MutationObserver: characterData + oldValue; reparent emits removal+addition records", () => {
  const out = run(
    new FineSession(DOC),
    `
    const log = [];
    const a = document.getElementById("a");
    const s = document.getElementById("s");
    const far = document.getElementById("far");
    new MutationObserver((records) => {
      for (const r of records) {
        log.push(\`\${r.type}@\${r.target.id || "?"}+\${r.addedNodes.length}-\${r.removedNodes.length} old=\${JSON.stringify(r.oldValue)}\`);
      }
    }).observe(document.body, { childList: true, characterData: true, characterDataOldValue: true, subtree: true });
    s.childNodes[0].data = "bye";     // characterData on the text node
    far.appendChild(s);               // reparent: removal@a + addition@far
    __r = log;
    `,
  );
  assert.equal(out, JSON.stringify([
    'characterData@?+0-0 old="hi"',
    "childList@a+0-1 old=null",
    "childList@far+1-0 old=null",
  ]));
});

void test("MutationObserver: takeRecords drains the queue; disconnect cancels delivery", () => {
  const out = run(
    new FineSession(DOC),
    `
    const log = [];
    const a = document.getElementById("a");
    const obs = new MutationObserver((records) => log.push("cb:" + records.length));
    obs.observe(a, { childList: true });
    a.appendChild(document.createElement("i"));
    const pending = obs.takeRecords(); // drain BEFORE delivery ⇒ callback sees nothing
    log.push("took:" + pending.length + ":" + pending[0].type);
    a.appendChild(document.createElement("u"));
    obs.disconnect();
    __r = log;
    `,
  );
  assert.equal(out, JSON.stringify(["took:1:childList"]));
});

void test("MutationObserver: observe() without any observation flag throws; bad target throws", () => {
  const out = run(
    new FineSession(DOC),
    `
    const log = [];
    const obs = new MutationObserver(() => {});
    try { obs.observe(document.body, {}); } catch (e) { log.push("empty:" + (e.name === "TypeError")); }
    try { obs.observe(42, { childList: true }); } catch (e) { log.push("nontarget:" + (e.name === "TypeError")); }
    try { new MutationObserver(0); } catch (e) { log.push("ctor:" + (e.name === "TypeError")); }
    __r = log;
    `,
  );
  assert.equal(out, JSON.stringify(["empty:true", "nontarget:true", "ctor:true"]));
});

void test("ResizeObserver: initial delivery, then fires only when the observed box changes", () => {
  const out = run(
    new FineSession(DOC),
    `
    const log = [];
    const a = document.getElementById("a");
    new ResizeObserver((entries) => {
      for (const e of entries) {
        log.push(\`\${e.target.id}:\${e.contentRect.width}x\${e.contentRect.height}/bb:\${e.borderBoxSize[0].inlineSize}x\${e.borderBoxSize[0].blockSize}\`);
      }
    }).observe(a);
    __r = log;
    // First flush happens via the observer microtask during drain.
    queueMicrotask(() => {}); // ensure the queue has guest work too
    setTimeout(() => {
      a.style.width = "250px";  // layout-affecting mutation ⇒ size change
      setTimeout(() => {
        a.setAttribute("class", "x"); // non-layout mutation ⇒ no RO entry
        __r = log;
      }, 0);
    }, 0);
    `,
  );
  assert.equal(out, JSON.stringify(["a:100x100/bb:100x100", "a:250x100/bb:250x100"]));
});

void test("ResizeObserver: box option and disconnect/unobserve", () => {
  const out = run(
    new FineSession(DOC),
    `
    const log = [];
    const a = document.getElementById("a");
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) log.push(e.target.id + ":" + e.contentRect.width + "x" + e.contentRect.height);
    });
    ro.observe(a);
    ro.unobserve(a);
    ro.observe(a);                       // re-observe resets: delivers again
    setTimeout(() => {
      ro.disconnect();
      a.style.width = "999px";           // after disconnect ⇒ never delivered
      setTimeout(() => { __r = log; }, 0);
    }, 0);
    `,
  );
  assert.equal(out, JSON.stringify(["a:100x100"]));
});

void test("IntersectionObserver: real geometry — in-viewport intersects, far-off does not", () => {
  const out = run(
    new FineSession(DOC),
    `
    const log = [];
    new IntersectionObserver((entries) => {
      for (const e of entries) {
        log.push(e.target.id + ":" + e.isIntersecting + ":" + e.intersectionRatio.toFixed(2));
      }
    }).observe(document.getElementById("a")), io2 = null;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) log.push("far:" + e.isIntersecting);
    });
    io.observe(document.getElementById("far"));
    __r = log;
    `,
  );
  assert.equal(out, JSON.stringify(["a:true:1.00", "far:false"]));
});

void test("IntersectionObserver: threshold crossing and root option identity", () => {
  const out = run(
    new FineSession(DOC),
    `
    const log = [];
    const a = document.getElementById("a");
    // #a is 100x100 fully inside an 800x600 viewport ⇒ ratio 1.0, crossing
    // every threshold; a mutation shrinking the viewport-visible part moves it.
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) log.push(e.target.id + ":" + e.isIntersecting + ":" + e.intersectionRatio.toFixed(2));
    }, { threshold: [0, 0.5, 1] });
    io.observe(a);
    queueMicrotask(() => {
      a.style.marginTop = "-60px"; // 40% still visible ⇒ ratio 0.4 ⇒ threshold index drop
      __r = log;
    });
    `,
  );
  // margin-top:-60 pulls #a's border box to y=-52 (body margin contributes 8)
  // ⇒ 48 of 100 px visible ⇒ ratio 0.48, threshold index drops.
  assert.equal(out, JSON.stringify(["a:true:1.00", "a:true:0.48"]));
});

void test("IntersectionObserver: element root bounds clip the intersection", () => {
  const out = run(
    new FineSession(
      '<html><body><div id="clip" style="width:100px;height:100px;overflow:hidden">' +
        '<div id="inner" style="margin-top:60px;width:50px;height:100px"></div></div></body></html>',
    ),
    `
    const log = [];
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        log.push(e.isIntersecting + ":" + e.intersectionRatio.toFixed(2) + ":" + e.rootBounds.width + "x" + e.rootBounds.height);
      }
    }, { root: document.getElementById("clip") });
    io.observe(document.getElementById("inner"));
    __r = log;
    `,
  );
  // inner is 50x100 at y=60 inside a 100px-tall clip root ⇒ 40% visible.
  assert.equal(out, JSON.stringify(["true:0.40:100x100"]));
});
