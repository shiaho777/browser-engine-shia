/**
 * Input fidelity (RFC 0020): typed platform events (PointerEvent family
 * through real guest classes, `isTrusted` on engine dispatch), the host's
 * UI-input synthesis surface (`run.ui`), focus machinery (focus/blur/
 * activeElement/hasFocus/tabIndex/autofocus/Tab traversal), keyboard text
 * editing via the input-event pipeline, and the incremental `DomTree.uiState`
 * feeding `:focus`, `:focus-within`, `:focus-visible`, `:active`, `:hover`.
 *
 * UI actions are host-driven on the returned `run.ui` object (the same
 * surface `clickElement`/`dispatchElementEvent` use); guest scripts register
 * listeners and leave results in `__r`.
 *
 * Built by `tsc` then run with: `node --test packages/cli/dist/*.test.js`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { NodeId } from "@browser-engine/ir";
import { FineSession } from "./fine.js";
import { runScriptsOnSession, type EventDrivenRun } from "./event-loop.js";

const BASE = "https://x.test/app/index.html";

/** The NodeId of the element with the given `id` attribute. */
const idOf = (session: FineSession, attrVal: string): NodeId => {
  for (const [id, n] of session.dom.nodes) {
    if (n.attrs?.get("id") === attrVal) return id;
  }
  throw new Error(`missing #${attrVal}`);
};

const run = (html: string, src = ""): { r: EventDrivenRun; s: FineSession } => {
  const s = new FineSession(html, BASE);
  const r = runScriptsOnSession(s, [src]);
  assert.equal(r.error, null);
  return { r, s };
};

const sandboxOf = (r: EventDrivenRun): Record<string, unknown> => r.sandbox as Record<string, unknown>;

/** vm-realm arrays/objects fail cross-realm deepStrictEqual — JSON round-trip. */
const j = (v: unknown): unknown => JSON.parse(JSON.stringify(v));
const rOf = (r: EventDrivenRun): unknown => j(sandboxOf(r)["__r"]);

void test("typed event constructors are guest-realm classes with spec fields", () => {
  const { r } = run("<body><p>x</p></body>", `
    __r = [];
    const pe = new PointerEvent("pointerdown", {
      pointerId: 7, pointerType: "pen", isPrimary: false, pressure: 0.5,
      tiltX: 12, tiltY: -8, twist: 45, width: 2, height: 3,
      clientX: 9, clientY: 8, button: 1, buttons: 2, ctrlKey: true,
    });
    __r.push(pe instanceof PointerEvent, pe instanceof MouseEvent,
             pe instanceof UIEvent, pe instanceof Event);
    __r.push(pe.pointerId, pe.pointerType, pe.isPrimary, pe.pressure,
             pe.tiltX, pe.tiltY, pe.twist, pe.width, pe.height,
             pe.clientX, pe.clientY, pe.button, pe.buttons, pe.ctrlKey);
    __r.push(pe.getCoalescedEvents().length, pe.isTrusted);
    const ke = new KeyboardEvent("keydown", { key: "a", code: "KeyA", repeat: true, location: 1 });
    __r.push(ke instanceof KeyboardEvent, ke.key, ke.code, ke.repeat, ke.location);
    const fe = new FocusEvent("focus", { relatedTarget: null });
    __r.push(fe instanceof FocusEvent);
    const ie = new InputEvent("beforeinput", { inputType: "insertText", data: "x" });
    __r.push(ie.inputType, ie.data);
    const we = new WheelEvent("wheel", { deltaX: 1, deltaY: -2, deltaMode: 1 });
    __r.push(we.deltaX, we.deltaY, we.deltaMode);
    const ce = new CompositionEvent("compositionstart", { data: "あ" });
    __r.push(ce.data);
    __r.push(new Event("x").isTrusted, new MouseEvent("y").isTrusted);
  `);
  assert.deepEqual(
    JSON.parse(JSON.stringify(sandboxOf(r)["__r"])),
    [true, true, true, true,
     7, "pen", false, 0.5, 12, -8, 45, 2, 3, 9, 8, 1, 2, true,
     1, false,
     true, "a", "KeyA", true, 1,
     true,
     "insertText", "x",
     1, -2, 1,
     "あ",
     false, false],
  );
});

void test("ui.click produces the full pointer+mouse sequence and focuses the control", () => {
  const { r, s } = run("<body><button id='b'>B</button></body>", `
    __r = [];
    for (const t of ["pointerover","pointerenter","mouseover","mouseenter",
                     "pointerdown","mousedown","focus","focusin",
                     "pointerup","mouseup","click"])
      document.getElementById("b").addEventListener(t, (e) =>
        __r.push(t + ":" + e.constructor.name + ":" + e.isTrusted + ":" +
          (e instanceof FocusEvent ? "-" : e.button)));
  `);
  r.ui!.click(idOf(s, "b"), { clientX: 4, clientY: 5 });
  const seq = (sandboxOf(r)["__r"] as string[]).join("|");
  assert.equal(
    seq,
    "pointerover:PointerEvent:true:-1|" +
    "pointerenter:PointerEvent:true:-1|" +
    "mouseover:MouseEvent:true:-1|" +
    "mouseenter:MouseEvent:true:-1|" +
    "pointerdown:PointerEvent:true:0|" +
    "mousedown:MouseEvent:true:0|" +
    "focus:FocusEvent:true:-|" +
    "focusin:FocusEvent:true:-|" +
    "pointerup:PointerEvent:true:0|" +
    "mouseup:MouseEvent:true:0|" +
    "click:PointerEvent:true:0",
  );
  // Focus moved as the mousedown default action.
  assert.equal(r.ui!.focusedId(), idOf(s, "b"));
});

void test("click on an unfocusable element moves focus to <body>", () => {
  const { r, s } = run("<body><input id='i'><div id='d'>x</div></body>", `
    document.getElementById("i").focus();
  `);
  assert.equal(r.ui!.focusedId(), idOf(s, "i"));
  r.ui!.click(idOf(s, "d"), {});
  // Chrome semantics: focus leaves the input and lands on <body>.
  assert.equal(
    (sandboxOf(r)["document"] as { activeElement: { tagName: string } }).activeElement.tagName,
    "BODY",
  );
  assert.notEqual(r.ui!.focusedId(), idOf(s, "i"));
});

void test("mousedown preventDefault suppresses the focus default action", () => {
  const { r, s } = run("<body><button id='b'>B</button></body>", `
    document.getElementById("b").addEventListener("mousedown", (e) => e.preventDefault());
  `);
  r.ui!.click(idOf(s, "b"), {});
  assert.equal(r.ui!.focusedId(), null);
});

void test("focus transitions fire blur→focusout→focus→focusin with relatedTarget", () => {
  const { r, s } = run("<body><input id='a'><input id='b'></body>", `
    __r = [];
    document.getElementById("a").addEventListener("blur", (e) =>
      __r.push("blur:" + e.constructor.name + ":" + e.bubbles + ":" + (e.relatedTarget && e.relatedTarget.id)));
    document.getElementById("a").addEventListener("focusout", (e) =>
      __r.push("focusout:" + e.bubbles));
    document.getElementById("b").addEventListener("focus", (e) =>
      __r.push("focus:" + e.bubbles + ":" + (e.relatedTarget && e.relatedTarget.id)));
    document.getElementById("b").addEventListener("focusin", (e) =>
      __r.push("focusin:" + e.bubbles));
    document.getElementById("a").focus();
    document.getElementById("b").focus();
  `);
  assert.deepEqual(
    rOf(r),
    ["blur:FocusEvent:false:b", "focusout:true", "focus:false:a", "focusin:true"],
  );
  assert.equal(r.ui!.focusedId(), idOf(s, "b"));
});

void test("activeElement falls back to body; hasFocus; tabIndex reflects markup and property sets it", () => {
  const { r } = run("<body><div id='d'>x</div><a id='l' href='#x'>l</a></body>", `
    __r = [];
    __r.push(document.activeElement.tagName, document.hasFocus());
    __r.push(document.getElementById("d").tabIndex);   // -1: not focusable
    __r.push(document.getElementById("l").tabIndex);   // 0: link with href
    document.getElementById("d").tabIndex = 3;
    __r.push(document.getElementById("d").tabIndex);
    document.getElementById("d").setAttribute("tabindex", "2");
    __r.push(document.getElementById("d").tabIndex);
  `);
  assert.deepEqual(rOf(r), ["BODY", true, -1, 0, 3, 2]);
});

void test(":focus / :focus-within / :focus-visible / :active / :hover react to uiState", () => {
  const { r, s } = run(
    `<body><style>
       #wrap:focus-within { color: green }
       #b:focus { outline-color: blue }
       #b:focus-visible { outline-color: purple }
       #b:hover { color: pink }
       #i:active { color: orange }
     </style><div id='wrap'><button id='b'>B</button><input id='i'></div></body>`,
  );
  const b = idOf(s, "b");
  const wrap = idOf(s, "wrap");
  const gcs = (id: NodeId, prop: string) =>
    (sandboxOf(r)["getComputedStyle"] as (el: unknown) => Record<string, string>)(
      (sandboxOf(r)["document"] as { getElementById: (x: string) => unknown }).getElementById(
        s.dom.nodes.get(id)?.attrs?.get("id") ?? "",
      ),
    )[prop];
  // Pointer click: focused but NOT focus-visible; wrap matches :focus-within.
  r.ui!.click(b, {});
  assert.equal(gcs(b, "outlineColor"), "rgb(0, 0, 255)");
  assert.equal(gcs(wrap, "color"), "rgb(0, 128, 0)");
  // Keyboard modality → :focus-visible.
  r.ui!.tab(1); // b → i
  r.ui!.tab(-1); // back to b
  assert.equal(gcs(b, "outlineColor"), "rgb(128, 0, 128)");
  // :hover on pointerMove.
  r.ui!.pointerMove(b, {});
  assert.equal(gcs(b, "color"), "rgb(255, 192, 203)");
});

void test("hover enter/over → move → out/leave sequences fire in UA order", () => {
  const { r, s } = run("<body><div id='a'>A</div><div id='b'>B</div></body>", `
    __r = [];
    for (const el of ["a", "b"])
      for (const t of ["pointerover","pointerenter","mouseover","mouseenter",
                       "pointermove","mousemove","pointerout","pointerleave",
                       "mouseout","mouseleave"])
        document.getElementById(el).addEventListener(t, (e) => __r.push(el + ":" + t));
  `);
  r.ui!.pointerMove(idOf(s, "a"), {});
  r.ui!.pointerMove(idOf(s, "b"), {});
  assert.deepEqual(rOf(r), [
    "a:pointerover", "a:pointerenter", "a:mouseover", "a:mouseenter",
    "a:pointermove", "a:mousemove",
    "a:pointerout", "a:pointerleave", "a:mouseout", "a:mouseleave",
    "b:pointerover", "b:pointerenter", "b:mouseover", "b:mouseenter",
    "b:pointermove", "b:mousemove",
  ]);
});

void test("contextmenu rides a right-button sequence; auxclick for middle; dblclick after two clicks", () => {
  const { r, s } = run("<body><div id='m'>M</div></body>", `
    __r = [];
    for (const t of ["pointerdown","mousedown","contextmenu","pointerup","mouseup","auxclick","click","dblclick"])
      document.getElementById("m").addEventListener(t, (e) => __r.push(t + ":" + e.button));
  `);
  r.ui!.contextMenu(idOf(s, "m"), {});
  assert.deepEqual(rOf(r), [
    "pointerdown:2", "mousedown:2", "contextmenu:2", "pointerup:2", "mouseup:2",
  ]);
  (sandboxOf(r)["__r"] as unknown[]).length = 0;
  r.ui!.click(idOf(s, "m"), { button: 1 });
  assert.deepEqual(rOf(r), [
    "pointerdown:1", "mousedown:1", "pointerup:1", "mouseup:1", "auxclick:1",
  ]);
  (sandboxOf(r)["__r"] as unknown[]).length = 0;
  r.ui!.dblClick(idOf(s, "m"), {});
  assert.deepEqual(rOf(r), [
    "pointerdown:0", "mousedown:0", "pointerup:0", "mouseup:0", "click:0",
    "pointerdown:0", "mousedown:0", "pointerup:0", "mouseup:0", "click:0",
    "dblclick:0",
  ]);
});

void test("keyboard input: keydown→keypress→beforeinput→input→keyup with value editing; keydown preventDefault suppresses; Backspace skips keypress", () => {
  const { r, s } = run("<body><input id='i' value='ab'></body>", `
    __r = [];
    const i = document.getElementById("i");
    for (const t of ["keydown","keypress","beforeinput","input","keyup"])
      i.addEventListener(t, (e) =>
        __r.push(t + ":" + e.constructor.name + ":" + (e.key ?? e.inputType ?? "")));
    i.focus();
  `);
  r.ui!.key({ key: "x" });
  r.ui!.key({ key: "Backspace" });
  void s;
  const log = (sandboxOf(r)["__r"] as string[]).join("|");
  assert.equal(
    log,
    "keydown:KeyboardEvent:x|keypress:KeyboardEvent:x|" +
    "beforeinput:InputEvent:insertText|input:InputEvent:insertText|keyup:KeyboardEvent:x|" +
    "keydown:KeyboardEvent:Backspace|" +
    "beforeinput:InputEvent:deleteContentBackward|input:InputEvent:deleteContentBackward|" +
    "keyup:KeyboardEvent:Backspace",
  );
  // 'ab' + 'x' − backspace → 'ab'
  assert.equal(
    (sandboxOf(r)["document"] as { getElementById: (x: string) => { value: string } })
      .getElementById("i").value,
    "ab",
  );
});

void test(":active matches while the press is held (sampled inside mouseup)", () => {
  const { r, s } = run(
    `<body><style>#i:active { color: orange }</style><input id='i'></body>`,
    `__r = [];
     document.getElementById("i").addEventListener("mouseup", () =>
       __r.push(getComputedStyle(document.getElementById("i")).color));
     document.getElementById("i").addEventListener("pointerdown", () =>
       __r.push(getComputedStyle(document.getElementById("i")).color));`,
  );
  r.ui!.click(idOf(s, "i"), {});
  // pointerdown (before activation) → default color; mouseup (still held) → :active.
  assert.deepEqual(rOf(r), ["rgb(0, 0, 0)", "rgb(255, 165, 0)"]);
});

void test("keydown preventDefault suppresses text insertion and keypress", () => {
  const { r } = run("<body><input id='i'></body>", `
    __r = [];
    const i = document.getElementById("i");
    i.addEventListener("keydown", (e) => { __r.push("kd"); e.preventDefault(); });
    i.addEventListener("keypress", () => __r.push("kp"));
    i.addEventListener("input", () => __r.push("in"));
    i.addEventListener("keyup", () => __r.push("ku"));
    i.focus();
  `);
  r.ui!.key({ key: "z" });
  // keydown cancellation suppresses keypress AND the editing default action.
  assert.deepEqual(rOf(r), ["kd", "ku"]);
  assert.equal(
    (sandboxOf(r)["document"] as { getElementById: (x: string) => { value: string } })
      .getElementById("i").value,
    "",
  );
});

void test("Tab traversal: positive tabindex first, then natural order; Shift+Tab reverses; wraps around", () => {
  const { r, s } = run(
    "<body><input id='a'><span id='b' tabindex='2'>B</span><em id='c' tabindex='1'>C</em><button id='d'>D</button></body>",
  );
  const gcs_active = () =>
    (sandboxOf(r)["document"] as { activeElement: { id: string } }).activeElement.id;
  r.ui!.tab(1); // c (tabindex 1) — nothing focused → first in order
  assert.equal(gcs_active(), "c");
  r.ui!.tab(1); // b (tabindex 2)
  assert.equal(gcs_active(), "b");
  r.ui!.tab(1); // a (natural group, doc order)
  assert.equal(gcs_active(), "a");
  r.ui!.tab(1); // d
  assert.equal(gcs_active(), "d");
  r.ui!.tab(1); // wraps to c
  assert.equal(gcs_active(), "c");
  r.ui!.tab(-1); // backwards → d
  assert.equal(gcs_active(), "d");
  void s;
});

void test("autofocus: parser-inserted element takes focus on the microtask flush, once per document", () => {
  const s = new FineSession("<body><input id='x'><input id='y' autofocus></body>", BASE);
  const r = runScriptsOnSession(s, [""]);
  // The virtual loop's drain flushes the autofocus microtask.
  r.drain?.();
  assert.equal(
    (r.sandbox as Record<string, unknown>)["document"] !== undefined
      ? ((r.sandbox as Record<string, unknown>)["document"] as { activeElement: { id: string } }).activeElement.id
      : null,
    "y",
  );
});

void test("detaching the focused element resets focus to nothing (no events on dead nodes)", () => {
  const { r, s } = run("<body><input id='i'><div id='p'><button id='b'>B</button></div></body>", `
    document.getElementById("b").focus();
    document.getElementById("p").remove();
  `);
  assert.equal(r.ui!.focusedId(), null);
  // :focus no longer matches the dead button; activeElement is body.
  assert.equal(
    (sandboxOf(r)["document"] as { activeElement: { tagName: string } }).activeElement.tagName,
    "BODY",
  );
  void s;
});

void test("checkbox activation still rides click; el.click() is a PointerEvent and does not steal focus", () => {
  const { r, s } = run("<body><input id='cb' type='checkbox'><input id='t'></body>", `
    __r = [];
    const cb = document.getElementById("cb");
    cb.addEventListener("click", (e) => __r.push("click:" + e.constructor.name));
    document.getElementById("t").focus();
    cb.click();
    __r.push("checked:" + cb.checked, "ae:" + document.activeElement.id);
  `);
  assert.deepEqual(rOf(r), ["click:PointerEvent", "checked:true", "ae:t"]);
  void s;
});
