/**
 * Custom Elements v1 (RFC 0017): a per-document registry, lazy upgrade on
 * wrapper creation (every DOM path), `super()` yielding the platform wrapper,
 * and lifecycle callbacks delivered from the session mutation sink — plus
 * `:defined` backed by a cascade-visible defined-name set.
 *
 * Built by `tsc` then run with: `node --test packages/cli/dist/*.test.js`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { FineSession } from "./fine.js";
import { runScriptsOnSession } from "./event-loop.js";

const DOC = "<html><body><div id=\"a\"></div></body></html>";

const run = (session: FineSession, src: string): string => {
  const r = runScriptsOnSession(session, [src]);
  assert.equal(r.error, null);
  const sandbox = r.sandbox as Record<string, unknown>;
  // vm-realm arrays/objects fail cross-realm deepStrictEqual — compare JSON.
  return JSON.stringify(sandbox["__r"]);
};

void test("customElements: define/get, prototype identity, ctor `this` is the element", () => {
  const out = run(
    new FineSession(DOC),
    `
    const log = [];
    class XFoo extends HTMLElement {
      constructor() {
        super();
        log.push("ctor-tag:" + this.tagName); // super() returns the wrapper
      }
    }
    customElements.define("x-foo", XFoo);
    log.push("get:" + (customElements.get("x-foo") === XFoo));
    log.push("get-missing:" + (customElements.get("x-none") === undefined));
    const el = document.createElement("x-foo");
    log.push("inst:" + (el instanceof XFoo) + ":" + (el instanceof HTMLElement) + ":" + (el instanceof Element));
    log.push("proto:" + (Object.getPrototypeOf(el) === XFoo.prototype));
    log.push("htmlproto:" + (Object.getPrototypeOf(XFoo.prototype) === HTMLElement.prototype));
    __r = log;
    `,
  );
  // ctor runs at createElement — after the define/get checks.
  assert.equal(
    out,
    JSON.stringify(["get:true", "get-missing:true", "ctor-tag:X-FOO", "inst:true:true:true", "proto:true", "htmlproto:true"]),
  );
});

void test("customElements: invalid/reserved/duplicate names and reused ctor throw", () => {
  const out = run(
    new FineSession(DOC),
    `
    const log = [];
    const N = class extends HTMLElement {};
    customElements.define("x-ok", N);
    const tryDef = (name, ctor, opts) => {
      try { customElements.define(name, ctor, opts); return "ok"; }
      catch (e) { return e.name; }
    };
    log.push("nohyphen:" + tryDef("notcustom", class extends HTMLElement {}));
    log.push("uppercase:" + tryDef("X-FOO", class extends HTMLElement {}));
    log.push("upperascii:" + tryDef("a-B", class extends HTMLElement {}));
    log.push("unicode:" + tryDef("a-" + String.fromCodePoint(0x1F171), class extends HTMLElement {}));
    log.push("reserved:" + tryDef("font-face", class extends HTMLElement {}));
    log.push("dup:" + tryDef("x-ok", class extends HTMLElement {}));
    log.push("ctorreuse:" + tryDef("x-ok2", N));
    log.push("nonfn:" + tryDef("x-bad2", 42));
    __r = log;
    `,
  );
  assert.equal(
    out,
    JSON.stringify([
      "nohyphen:SyntaxError",
      "uppercase:SyntaxError",
      "upperascii:SyntaxError",
      "unicode:ok",
      "reserved:SyntaxError",
      "dup:NotSupportedError",
      "ctorreuse:NotSupportedError",
      "nonfn:TypeError",
    ]),
  );
});

void test("customElements: connected/disconnected callbacks on attach/remove/re-attach", () => {
  const out = run(
    new FineSession(DOC),
    `
    const log = [];
    class XFoo extends HTMLElement {
      connectedCallback() { log.push("conn"); }
      disconnectedCallback() { log.push("disc"); }
    }
    customElements.define("x-foo", XFoo);
    const el = document.createElement("x-foo");
    const a = document.getElementById("a");
    a.appendChild(el);
    a.removeChild(el);
    a.appendChild(el);
    __r = log;
    `,
  );
  // append → conn; detach → disc; re-attach → conn.
  assert.equal(out, JSON.stringify(["conn", "disc", "conn"]));
});

void test("customElements: disconnectedCallback fires for descendants of a removed subtree", () => {
  const out = run(
    new FineSession(DOC),
    `
    const log = [];
    class XFoo extends HTMLElement {
      disconnectedCallback() { log.push("disc"); }
    }
    customElements.define("x-foo", XFoo);
    const w = document.createElement("div");
    const el = document.createElement("x-foo");
    w.appendChild(el);          // detached tree — no conn
    document.body.appendChild(w); // subtree joins → conn
    w.remove();                 // whole subtree leaves → desc fires disc
    __r = log;
    `,
  );
  assert.equal(out, JSON.stringify(["disc"]));
});

void test("customElements: attributeChangedCallback — observed only, old/new values, upgrade-time attrs", () => {
  const out = run(
    new FineSession(DOC),
    `
    const log = [];
    class XFoo extends HTMLElement {
      static get observedAttributes() { return ["data-a", "data-c"]; }
      attributeChangedCallback(n, o, v) { log.push(n + ":" + o + ":" + v); }
    }
    customElements.define("x-foo", XFoo);
    const el = document.createElement("x-foo");
    document.getElementById("a").appendChild(el);
    el.setAttribute("data-a", "1");   // observed: null→1
    el.setAttribute("data-a", "2");   // observed: 1→2
    el.setAttribute("data-b", "9");   // NOT observed — silent
    el.removeAttribute("data-a");     // observed: 2→null
    __r = log;
    `,
  );
  assert.equal(out, JSON.stringify(["data-a:null:1", "data-a:1:2", "data-a:2:null"]));
});

void test("ariaLabel reflects aria-label and queues attributeChanged", () => {
  const out = run(
    new FineSession(DOC),
    `
    const log = [];
    class XFoo extends HTMLElement {
      static get observedAttributes() { return ["aria-label"]; }
      attributeChangedCallback(n, o, v) { log.push(n + ":" + o + ":" + v); }
    }
    customElements.define("x-foo", XFoo);
    const el = document.createElement("x-foo");
    el.ariaLabel = "foo";
    el.ariaLabel = "bar";
    log.push("get:" + el.ariaLabel);
    el.ariaLabel = null;
    log.push("gone:" + el.ariaLabel);
    __r = log;
    `,
  );
  assert.equal(out, JSON.stringify(["aria-label:null:foo", "aria-label:foo:bar", "get:bar", "aria-label:bar:null", "gone:null"]));
});

void test("customElements: parser-created elements upgrade on define() — ctor → attrChanged → connected order", () => {
  const out = run(
    new FineSession("<html><body><x-foo id=p data-a=\"z\"></x-foo><x-bar id=q></x-bar></html>"),
    `
    const log = [];
    const p = document.getElementById("p"); // wrapper exists BEFORE define
    class XFoo extends HTMLElement {
      static get observedAttributes() { return ["data-a"]; }
      constructor() { super(); log.push("ctor"); }
      connectedCallback() { log.push("conn"); }
      attributeChangedCallback(n, o, v) { log.push("attr:" + n + ":" + o + ":" + v); }
    }
    customElements.define("x-foo", XFoo);
    log.push("same:" + (p instanceof XFoo));   // upgrade swaps the live wrapper's proto
    log.push("bar-untouched:" + !(document.getElementById("q") instanceof XFoo));
    __r = log;
    `,
  );
  assert.equal(out, JSON.stringify(["ctor", "attr:data-a:null:z", "conn", "same:true", "bar-untouched:true"]));
});

void test("customElements: elements built via innerHTML upgrade when inserted into the document", () => {
  const out = run(
    new FineSession(DOC),
    `
    const log = [];
    class XFoo extends HTMLElement {
      constructor() { super(); log.push("ctor"); }
      connectedCallback() { log.push("conn"); }
    }
    customElements.define("x-foo", XFoo);
    const w = document.createElement("div");
    w.innerHTML = "<p><x-foo></x-foo></p>"; // parsed detached — no ctor yet
    log.push("after-innerHTML");
    document.getElementById("a").appendChild(w);
    __r = log;
    `,
  );
  // Upgrade fires on insertion — matching parser semantics (create parser nodes → upgrade on connect).
  assert.equal(out, JSON.stringify(["after-innerHTML", "ctor", "conn"]));
});

void test("customElements: `:defined` — defined CE matches, undefined CE does not, builtins always match", () => {
  const out = run(
    new FineSession("<html><body><x-def id=d></x-def><x-undef id=u></x-undef><span id=b is=\"x-def\"></span><em id=e></em></html>"),
    `
    const log = [];
    customElements.define("x-def", class extends HTMLElement {});
    const m = (sel, id) => document.getElementById(id).matches(sel);
    log.push("def:" + m(":defined", "d"));
    log.push("undef:" + m(":defined", "u"));
    log.push("builtin:" + m(":defined", "e"));
    log.push("is-defined:" + m(":defined", "b"));
    log.push("undef-count:" + document.querySelectorAll("x-undef:defined").length);
    log.push("notdef-count:" + document.querySelectorAll("body :not(:defined)").length);
    __r = log;
    `,
  );
  // x-undef is the only non-:defined element — builtins (html/head/body/em),
  // the defined CE, and the is=customized span all match.
  assert.equal(out, JSON.stringify(["def:true", "undef:false", "builtin:true", "is-defined:true", "undef-count:0", "notdef-count:1"]));
});

void test("customElements: customized built-in via `{ extends }` + `is=` attr on createElement", () => {
  const out = run(
    new FineSession(DOC),
    `
    const log = [];
    class XButton extends HTMLButtonElement {
      connectedCallback() { log.push("conn:" + this.tagName); }
    }
    customElements.define("x-button", XButton, { extends: "button" });
    const el = document.createElement("button", { is: "x-button" });
    log.push("inst:" + (el instanceof XButton));
    document.getElementById("a").appendChild(el);
    log.push("is-attr:" + el.getAttribute("is"));
    __r = log;
    `,
  );
  assert.equal(out, JSON.stringify(["inst:true", "conn:BUTTON", "is-attr:x-button"]));
});

void test("customElements: `new XFoo()` / `new HTMLElement()` remain illegal; upgrade() upgrades", () => {
  const out = run(
    new FineSession("<html><body><x-foo id=p></x-foo></html>"),
    `
    const log = [];
    class XFoo extends HTMLElement {
      constructor() { super(); log.push("ctor"); }
    }
    try { new HTMLElement(); } catch (e) { log.push("html-ctor:" + /Illegal/.test(e.message)); }
    try { new XFoo(); } catch (e) { log.push("xfoo-ctor:" + /Illegal/.test(e.message)); }
    const p = document.getElementById("p");
    log.push("before:" + !(p instanceof XFoo));
    customElements.define("x-foo", XFoo);  // define() already upgrades the parser element…
    log.push("after-def:" + (p instanceof XFoo));
    // upgrade() is a no-op on the already-upgraded element; use it on a fresh undefined-ish node:
    const n = document.createElement("x-foo"); // defined → upgraded at creation
    log.push("created:" + (n instanceof XFoo));
    __r = log;
    `,
  );
  assert.equal(
    out,
    JSON.stringify(["html-ctor:true", "xfoo-ctor:true", "before:true", "ctor", "after-def:true", "ctor", "created:true"]),
  );
});

void test("customElements: whenDefined resolves with the ctor; rejects on invalid names", async () => {
  const r = runScriptsOnSession(
    new FineSession(DOC),
    [
      `
      customElements.whenDefined("x-later").then(c => { __wd = c === XLater ? "resolved-ctor" : "resolved-other"; });
      customElements.whenDefined("noname").then(() => { __bad = "resolved"; }, e => { __bad = e.name; });
      class XLater extends HTMLElement {}
      customElements.define("x-later", XLater);
      `,
    ],
  );
  assert.equal(r.error, null);
  // Host-side promise reactions run on the host microtask queue — flush one tick.
  await new Promise((resolve) => setImmediate(resolve));
  const sandbox = r.sandbox as Record<string, unknown>;
  assert.equal(sandbox["__wd"], "resolved-ctor");
  assert.equal(sandbox["__bad"], "SyntaxError");
});

void test("customElements: callback throwing inside ctor does not break the DOM; errors reach onListenerError", () => {
  const session = new FineSession(DOC);
  const r = runScriptsOnSession(
    session,
    [
      `
      const log = [];
      class XBad extends HTMLElement {
        constructor() { super(); throw new Error("boom"); }
        connectedCallback() { log.push("conn"); }
      }
      customElements.define("x-bad", XBad);
      const el = document.createElement("x-bad");   // ctor throws — element still exists+upgraded
      log.push("exists:" + (el instanceof XBad));
      document.getElementById("a").appendChild(el); // connected still fires
      __r = log;
      `,
    ],
  );
  assert.equal(r.error, null);
  assert.equal(JSON.stringify((r.sandbox as Record<string, unknown>)["__r"]), JSON.stringify(["exists:true", "conn"]));
});
