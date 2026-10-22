/**
 * Shadow DOM v1 (RFC 0018): attachShadow modes, slot assignment + slotchange,
 * composed-tree layout, scoped stylesheets (:host / no leak), event
 * retargeting + composed/composedPath, and CE-in-shadow lifecycle.
 *
 * Built by `tsc` then run with: `node --test packages/cli/dist/*.test.js`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { FineSession } from "./fine.js";
import { runScriptsOnSession } from "./event-loop.js";

const DOC = '<html><body><div id="h"><span id="a" slot="x">A</span><b id="b">B</b></div></body></html>';

const run = (session: FineSession, src: string): string => {
  const r = runScriptsOnSession(session, [src]);
  assert.equal(r.error, null);
  return JSON.stringify((r.sandbox as Record<string, unknown>)["__r"]);
};

void test("attachShadow: open/closed modes, host/instanceof, double-attach + bad-host errors", () => {
  const out = run(
    new FineSession(DOC),
    `
    const log = [];
    const h = document.getElementById("h");
    const sr = h.attachShadow({ mode: "open" });
    log.push("sr:" + (sr instanceof ShadowRoot) + ":" + (sr.host === h) + ":" + (h.shadowRoot === sr));
    try { h.attachShadow({ mode: "open" }); } catch (e) { log.push("double:" + e.name); }
    const bad = document.createElement("input");
    try { bad.attachShadow({ mode: "open" }); } catch (e) { log.push("badhost:" + e.name); }
    const c = document.createElement("section");
    const csr = c.attachShadow({ mode: "closed" });
    log.push("closed:" + (c.shadowRoot === null) + ":" + (csr instanceof ShadowRoot) + ":" + csr.mode);
    __r = log;
    `,
  );
  assert.equal(
    out,
    JSON.stringify([
      "sr:true:true:true",
      "double:NotSupportedError",
      "badhost:NotSupportedError",
      "closed:true:true:closed",
    ]),
  );
});

void test("slot assignment: named/default slots, assignedNodes, assignedSlot, fallback content", () => {
  const out = run(
    new FineSession(DOC),
    `
    const log = [];
    const sr = document.getElementById("h").attachShadow({ mode: "open" });
    sr.innerHTML = '<div><slot name="x" id="sx"></slot><slot id="sd"><i id="fb">FALLBACK</i></slot></div>';
    const sx = sr.querySelector("#sx");
    const sd = sr.querySelector("#sd");
    log.push("sx:" + sx.assignedNodes().length + ":" + sx.assignedNodes()[0].id);
    log.push("sd:" + sd.assignedNodes().length + ":" + sd.assignedNodes()[0].tagName);
    log.push("slotof:" + (document.getElementById("a").assignedSlot === sx) + ":" + (document.getElementById("b").assignedSlot === sd));
    log.push("els:" + sd.assignedElements().length);
    // fallback: a named slot nobody matches shows its own children
    sr.innerHTML += '<slot name="zzz" id="sz"><u id="fb2">F2</u></slot>';
    log.push("fallback:" + sr.querySelector("#sz").assignedNodes().length);
    __r = log;
    `,
  );
  assert.equal(
    out,
    JSON.stringify(["sx:1:a", "sd:1:B", "slotof:true:true", "els:1", "fallback:0"]),
  );
});

void test("composed-tree layout: host renders shadow children, slot draws slotted content", () => {
  const session = new FineSession(
    '<html><body><div id="h" style="width:300px"><span id="a">LIGHT</span></div></body></html>',
  );
  const r = runScriptsOnSession(session, [
    `
    const sr = document.getElementById("h").attachShadow({ mode: "open" });
    sr.innerHTML = '<div id="si" style="height:50px"><slot></slot></div><b id="after">TAIL</b>';
    __r = true;
    `,
  ]);
  assert.equal(r.error, null);
  const dom = session.dom;
  const find = (pred: (n: { tag?: string; kind: string; attrs?: ReadonlyMap<string, string>; text?: string }) => boolean): number | undefined => {
    for (const [id, n] of dom.nodes) if (pred(n)) return id;
    return undefined;
  };
  const si = find((n) => n.attrs?.get("id") === "si")!;
  const after = find((n) => n.attrs?.get("id") === "after")!;
  const light = find((n) => n.kind === "text" && n.text === "LIGHT")!;
  const tree = session.layoutTree();
  const fragOf = (nid: number) => {
    for (const [, f] of tree.fragments) {
      if (Number(f.node) === nid) return f as { box: { borderBox: { x: number; y: number; width: number; height: number } } };
    }
    return undefined;
  };
  const fSi = fragOf(si)!;
  const fLight = fragOf(light)!;
  const fAfter = fragOf(after)!;
  assert.equal(fSi.box.borderBox.width, 300);
  assert.equal(fSi.box.borderBox.height, 50);
  // Slotted text renders INSIDE the slot's region (y ≈ si's content top).
  assert.ok(Math.abs(fLight.box.borderBox.y - fSi.box.borderBox.y) < 1, `light y=${fLight.box.borderBox.y} vs si y=${fSi.box.borderBox.y}`);
  assert.ok(fAfter.box.borderBox.y >= 50, `after y=${fAfter.box.borderBox.y}`);
});

void test("style scoping: shadow sheets style shadow nodes only; :host reaches the host", () => {
  const session = new FineSession(
    '<html><body><style>.inner { color: red }</style><div id="h"><span id="a">A</span></div><div id="plain"><span class="inner" id="o">O</span></div></body></html>',
  );
  const r = runScriptsOnSession(session, [
    `
    const sr = document.getElementById("h").attachShadow({ mode: "open" });
    sr.innerHTML = '<style>:host { outline-style: solid } .inner { color: blue; font-weight: normal }</style><div class="inner" id="si"><slot></slot></div>';
    __r = true;
    `,
  ]);
  assert.equal(r.error, null);
  const dom = session.dom;
  const findId = (pred: (n: { tag?: string; kind: string; attrs?: ReadonlyMap<string, string>; parent: unknown }) => boolean): number => {
    for (const [id, n] of dom.nodes) if (pred(n)) return id;
    throw new Error("not found");
  };
  const inShadow = (n: { parent: unknown }): boolean => {
    let c = n.parent as number | null;
    while (c !== null) {
      const p = dom.nodes.get(c as never);
      if (p?.tag === "#shadow-root") return true;
      c = p?.parent ?? null;
    }
    return false;
  };
  const siId = findId((n) => n.attrs?.get("id") === "si" && inShadow(n));
  const oId = findId((n) => n.attrs?.get("id") === "o");
  const hId = findId((n) => n.attrs?.get("id") === "h");
  const csSi = session.computed(siId as never);
  const csO = session.computed(oId as never);
  const csH = session.computed(hId as never);
  assert.deepEqual(csSi.color, { r: 0, g: 0, b: 255, a: 1 }, "shadow .inner is blue");
  assert.equal(csSi["fontWeight"], 400, "shadow font-weight beats nothing — document div rule must not leak");
  assert.deepEqual(csO.color, { r: 255, g: 0, b: 0, a: 1 }, "document .inner is red — shadow sheet did not leak out");
  assert.equal(csH["outlineStyle"], "solid", ":host rule applied to host");
});

void test("event scoping: non-composed trapped at shadow root; composed retargets to host", () => {
  const out = run(
    new FineSession(DOC),
    `
    const log = [];
    const sr = document.getElementById("h").attachShadow({ mode: "open" });
    sr.innerHTML = '<div id="si"><slot name="x"></slot></div>';
    const inner = sr.querySelector("#si");
    let docTarget = null, srTarget = null, plen = 0;
    document.body.addEventListener("evt", (e) => { docTarget = e.target && e.target.id; });
    sr.addEventListener("evt", (e) => { srTarget = e.target && e.target.id; plen = e.composedPath().length; });
    inner.dispatchEvent(new Event("evt", { bubbles: true }));               // non-composed
    log.push("nc:" + docTarget + "/" + srTarget + "/" + plen);
    docTarget = null;
    inner.dispatchEvent(new Event("evt", { bubbles: true, composed: true })); // composed
    log.push("c:" + docTarget + "/" + srTarget);
    // same-scope listeners see the real target; document sees the HOST.
    __r = log;
    `,
  );
  // non-composed: document never fired; shadow listener saw "si"; path = si→sr→h→body→html→root = 6.
  // composed: document sees host "h" (retarget), shadow sees "si".
  assert.equal(out, JSON.stringify(["nc:null/si/6", "c:h/si"]));
});

void test("slotted-node events propagate through the flattened tree", () => {
  const out = run(
    new FineSession(DOC),
    `
    const log = [];
    const sr = document.getElementById("h").attachShadow({ mode: "open" });
    sr.innerHTML = '<div id="wrap"><slot name="x" id="sx"></slot></div>';
    const a = document.getElementById("a"); // light child, slot="x"
    sr.querySelector("#wrap").addEventListener("evt", (e) => log.push("wrap:" + e.target.id));
    sr.addEventListener("evt", (e) => log.push("sr:" + e.target.id));
    a.dispatchEvent(new Event("evt", { bubbles: true, composed: true }));
    __r = log;
    `,
  );
  // Flattened-tree routing (DOM spec): a slotted light child's shadow-
  // including parent is its <slot>, so the path runs a→slot→wrap→shadowroot
  // →host→body→…. Listeners inside the shadow tree see the UNretargeted
  // target "a" (slotted content is visible to its slot's tree scope).
  assert.equal(out, JSON.stringify(["wrap:a", "sr:a"]));
});

void test("slotchange fires when assignment changes; CE inside shadow gets lifecycle", () => {
  const out = run(
    new FineSession(DOC),
    `
    const log = [];
    const sr = document.getElementById("h").attachShadow({ mode: "open" });
    sr.innerHTML = '<slot name="x" id="sx"></slot><x-ins id="c"></x-ins>';
    class XIns extends HTMLElement {
      connectedCallback() { log.push("conn"); }
      disconnectedCallback() { log.push("disc"); }
    }
    customElements.define("x-ins", XIns);
    const sx = sr.querySelector("#sx");
    sx.addEventListener("slotchange", () => log.push("slotchange"));
    const a = document.getElementById("a");
    a.setAttribute("slot", "y");       // leaves slot x → change
    queueMicrotask(() => {
      a.setAttribute("slot", "x");     // returns → change
      setTimeout(() => {
        document.body.removeChild(document.getElementById("h"));
        setTimeout(() => { __r = log; }, 0);
      }, 0);
    });
    `,
  );
  // innerHTML: x-ins upgrades+connects (and slot gains its assignment → one
  // slotchange); reassign out → slotchange; back → slotchange; removal → disc.
  const entries = JSON.parse(out) as string[];
  assert.equal(entries.filter((e) => e === "conn").length, 1);
  assert.equal(entries.filter((e) => e === "disc").length, 1);
  assert.ok(entries.filter((e) => e === "slotchange").length >= 2, `slotchanges: ${entries.join(",")}`);
  assert.equal(entries[0], "conn");
  assert.equal(entries[entries.length - 1], "disc");
});

void test("getRootNode + composed flag on ShadowRoot accessors", () => {
  const out = run(
    new FineSession(DOC),
    `
    const log = [];
    const sr = document.getElementById("h").attachShadow({ mode: "open" });
    sr.innerHTML = '<p id="ip">T</p>';
    const ip = sr.querySelector("#ip");
    log.push("root:" + (ip.getRootNode() === sr) + ":" + (ip.getRootNode({ composed: true }) === document));
    log.push("lightroot:" + (document.getElementById("a").getRootNode() === document));
    log.push("docget:" + (document.querySelector("#ip") === null) + ":" + (sr.getElementById("ip") === ip));
    __r = log;
    `,
  );
  assert.equal(out, JSON.stringify(["root:true:true", "lightroot:true", "docget:true:true"]));
});
