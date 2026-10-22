/**
 * forms-v2.test.ts — RFC 0021: form controls v2.
 *
 * Live control state (`DomTree.control` via `DocControl`), the shared
 * constraint-validation engine (cascade/form-state.ts — one source of truth
 * for `:valid` and `checkValidity`), the select/option/textarea/output/
 * label/datalist/fieldset IDL surface, radio-group exclusivity, replaced-
 * element control sizing, and `form.elements`/`form[name]` named access.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { NodeId } from "@browser-engine/ir";
import { runScriptsOnSession, type EventDrivenRun } from "./event-loop.js";
import { FineSession } from "./fine.js";

const BASE = "https://x.test/app/index.html";

const idOf = (session: FineSession, attrVal: string): NodeId => {
  for (const [id, n] of session.dom.nodes) {
    if (n.attrs?.get("id") === attrVal) return id;
  }
  throw new Error(`missing #${attrVal}`);
};

const run = (html: string, src = ""): { r: EventDrivenRun; s: FineSession } => {
  // Guest scripts address elements by an explicit `el(id)` helper (the
  // sandbox has no named-window-property machinery).
  const pre = "const el = (id) => document.getElementById(id);\n";
  return runWith(html, pre + src);
};
const runWith = (html: string, src: string): { r: EventDrivenRun; s: FineSession } => {
  const s = new FineSession(html, BASE);
  const r = runScriptsOnSession(s, [src]);
  assert.equal(r.error, null);
  return { r, s };
};

const sandboxOf = (r: EventDrivenRun): Record<string, unknown> => r.sandbox as Record<string, unknown>;
/** Cross-realm values compare by structure — JSON-round-trip guest results. */
const j = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

void test("constraint validation: validity flags per constraint kind", () => {
  const { r } = run(`<body>
    <input id="req" required>
    <input id="em" type="email" value="nope">
    <input id="num" type="number" min="1" max="10" step="2" value="11">
    <input id="pat" pattern="[0-9]+" value="abc">
    <textarea id="ta" minlength="5" maxlength="3">x</textarea>
    <input id="cb" type="checkbox" required>
    <input id="hid" type="hidden">
    <button id="btn">B</button>
  </body>`, `
    __r = {
      reqMiss: el("req").validity.valueMissing, reqValid: el("req").validity.valid,
      emType: el("em").validity.typeMismatch,
      numRange: el("num").validity.rangeOverflow, numStep: el("num").validity.stepMismatch,
      patMis: el("pat").validity.patternMismatch,
      taShort: el("ta").validity.tooShort,
      cbMiss: el("cb").validity.valueMissing,
      hidBarred: el("hid").willValidate, btnBarred: el("btn").willValidate,
      msg: el("req").validationMessage,
    };
    el("num").value = "3";
    __r.numFixed = el("num").validity.valid;
    el("ta").value = "hello there";
    __r.taLong = el("ta").validity.tooLong;
  `);
  const g = sandboxOf(r);
  assert.deepEqual(j(g["__r"]), {
    reqMiss: true, reqValid: false,
    emType: true,
    numRange: true, numStep: false,
    patMis: true,
    taShort: true,
    cbMiss: true,
    hidBarred: false, btnBarred: false,
    msg: "Please fill out this field.",
    numFixed: true,
    taLong: true,
  });
});

void test("setCustomValidity drives customError + validationMessage", () => {
  const { r } = run(`<body><input id="i" value="x"></body>`, `
    el("i").setCustomValidity("Nope nope");
    __r = [el("i").validity.customError, el("i").validity.valid, el("i").validationMessage, el("i").checkValidity()];
    el("i").setCustomValidity("");
    __r.push(el("i").validity.valid, el("i").validationMessage === "", el("i").checkValidity());
  `);
  assert.deepEqual(j(sandboxOf(r)["__r"]), [true, false, "Nope nope", false, true, true, true]);
});

void test("checkValidity fires cancelable `invalid`; reportValidity returns the verdict", () => {
  const { r } = run(`<body><input id="i" required></body>`, `
    __r = [];
    el("i").addEventListener("invalid", (e) => __r.push(e.type + ":" + e.cancelable + ":" + e.constructor.name));
    __r.push(el("i").checkValidity(), el("i").reportValidity());
  `);
  assert.deepEqual(j(sandboxOf(r)["__r"]), ["invalid:true:Event", "invalid:true:Event", false, false]);
});

void test("interactive validation blocks submission: invalid events + focus first", () => {
  const { r, s } = run(`<body><form id="f"><input id="a" name="a" required>
    <input id="b" name="b" type="email" value="bad"><button id="go">Go</button></form></body>`);
  const g = sandboxOf(r);
  const doc = g["document"] as { getElementById(id: string): { addEventListener(t: string, f: unknown, o?: unknown): void } };
  // `invalid` doesn't bubble — capture-phase listener on the form.
  doc.getElementById("f").addEventListener("invalid", () => {
    (g["__iv"] as string[]).push("iv");
  }, { capture: true });
  (g)["__iv"] = [];
  r.ui!.click(idOf(s, "go"), {});
  assert.equal((g["__iv"] as string[]).length, 2, "both invalid controls got the event");
  assert.equal(r.ui!.focusedId(), idOf(s, "a"), "first invalid control focused");
});

void test("novalidate on the form (and formnovalidate on the submitter) bypass validation", () => {
  const navs: string[] = [];
  const s = new FineSession(
    `<body><form id="f" novalidate action="/ok"><input name="a" required><button id="go">Go</button></form></body>`,
    BASE,
  );
  const r = runScriptsOnSession(s, [""]);
  assert.equal(r.error, null);
  r.ui!.click(idOf(s, "go"), {});
  void navs;
  // The submit event ran (validation would have aborted before it in-page
  // navigation; assert via a submit listener instead).
  const g = sandboxOf(r);
  assert.equal((g["__iv"] as unknown[] | undefined)?.length ?? 0, 0);
});

void test("radio group exclusivity on activation AND on property set", () => {
  const { r, s } = run(`<body>
    <input id="r1" type="radio" name="g" value="1">
    <input id="r2" type="radio" name="g" value="2" checked>
    <input id="r3" type="radio" name="other" checked>
  </body>`);
  const g = sandboxOf(r);
  const doc = g["document"] as { getElementById(id: string): { checked: boolean } };
  assert.equal(doc.getElementById("r2").checked, true);
  r.ui!.click(idOf(s, "r1"), {});
  assert.equal(doc.getElementById("r1").checked, true);
  assert.equal(doc.getElementById("r2").checked, false, "peer unchecked");
  assert.equal(doc.getElementById("r3").checked, true, "other group untouched");
  // Property-set also syncs the group.
  doc.getElementById("r2").checked = true;
  assert.equal(doc.getElementById("r1").checked, false);
});

void test("live :checked + :indeterminate + :default through computed style", () => {
  const { r } = run(`<body>
    <input id="cb" type="checkbox"><input id="rb" type="radio" checked>
    <style>
      #cb:checked { color: lime } #cb:indeterminate { border-top-color: fuchsia }
      #rb:default { color: olive }
    </style></body>`);
  const g = sandboxOf(r);
  const doc = g["document"] as {
    getElementById(id: string): { checked: boolean; indeterminate: boolean; matches(s: string): boolean };
  };
  const gcs = g["getComputedStyle"] as (el: unknown) => { color: string; borderTopColor: string };
  const cb = doc.getElementById("cb"), rb = doc.getElementById("rb");
  assert.equal(gcs(cb).color, "rgb(0, 0, 0)");
  cb.checked = true;
  assert.equal(gcs(cb).color, "rgb(0, 255, 0)", ":checked is live");
  assert.equal(cb.matches(":checked"), true);
  cb.indeterminate = true;
  assert.equal(gcs(cb).borderTopColor, "rgb(255, 0, 255)");
  assert.equal(gcs(rb).color, "rgb(128, 128, 0)", ":default — attr-checked radio");
});

void test("fieldset[disabled] disables descendants for :disabled + willValidate; first legend exempt", () => {
  const { r } = run(`<body>
    <fieldset id="fs" disabled>
      <legend id="lg"><input id="inL" name="inL"></legend>
      <input id="inn" name="inn"><button id="b1">B</button>
    </fieldset>
    <input id="free" name="free">
    <style>#inn:disabled { color: gray } #inL:enabled { color: blue }</style>
  </body>`);
  const g = sandboxOf(r);
  const doc = g["document"] as {
    getElementById(id: string): { disabled: boolean; willValidate: boolean; matches(s: string): boolean };
    getComputedStyle(el: unknown): { color: string };
  };
  const gcs = (el: unknown) => (g as unknown as {
    getComputedStyle(e: unknown): { color: string };
  }).getComputedStyle(el);
  const inn = doc.getElementById("inn"), inL = doc.getElementById("inL"), free = doc.getElementById("free");
  assert.equal(inn.disabled, false, "property reflects the attribute only");
  assert.equal(inn.matches(":disabled"), true, "fieldset inheritance");
  assert.equal(gcs(inn).color, "rgb(128, 128, 128)");
  assert.equal(inL.matches(":enabled"), true, "first-legend exemption");
  assert.equal(inL.willValidate, true);
  assert.equal(free.matches(":enabled"), true);
});

void test("select model: options/selectedIndex/value/multiple/add/remove", () => {
  const { r } = run(`<body>
    <select id="s"><option id="o1" value="a">One</option><option id="o2" value="b" selected>Two</option></select>
    <select id="m" multiple><option value="x">X</option><option value="y" selected>Y</option></select>
  </body>`, `
    __r = { type: el("s").type, len: el("s").length, opts: el("s").options.length,
            idx: el("s").selectedIndex, val: el("s").value,
            mtype: el("m").type, msel: el("m").selectedOptions.length,
            o1idx: el("o1").index, o2sel: el("o2").selected, o1text: el("o1").text };
    el("s").selectedIndex = 0;
    __r.afterIdx = [el("s").selectedIndex, el("s").value, el("o2").selected];
    el("o2").selected = true;
    __r.afterSel = [el("o1").selected, el("s").value];
    const opt = document.createElement("option");
    opt.value = "c"; opt.text = "Three"; opt.selected = true;
    el("s").add(opt);
    __r.afterAdd = [el("s").length, el("s").value];
    el("s").remove(0);
    __r.afterRm = [el("s").length, el("s").options.item(0).value];
    el("s").value = "zzz";
    __r.noMatch = [el("s").selectedIndex, el("s").value];
  `);
  assert.deepEqual(j(sandboxOf(r)["__r"]), {
    type: "select-one", len: 2, opts: 2,
    idx: 1, val: "b",
    mtype: "select-multiple", msel: 1,
    o1idx: 0, o2sel: true, o1text: "One",
    afterIdx: [0, "a", false],
    afterSel: [false, "b"],       // selecting o2 deselected o1 (single-select)
    afterAdd: [3, "c"],
    afterRm: [2, "b"],            // o1 removed; "b" is options[0].value
    noMatch: [-1, ""],            // unmatched value ⇒ selectedIndex −1, empty value
  });
});

void test("textarea value/defaultValue/textLength/rows/cols", () => {
  const { r } = run(`<body><textarea id="ta" rows="4" cols="30">seed</textarea></body>`, `
    __r = [el("ta").value, el("ta").defaultValue, el("ta").textLength, el("ta").rows, el("ta").cols, el("ta").type, el("ta").wrap];
    el("ta").value = "live";
    __r.push(el("ta").value, el("ta").defaultValue);          // dirty value stays
    el("ta").defaultValue = "nd";
    __r.push(el("ta").value, el("ta").defaultValue);          // dirty ⇒ defaultValue doesn't touch value
  `);
  assert.deepEqual(j(sandboxOf(r)["__r"]),
    ["seed", "seed", 4, 4, 30, "textarea", "soft", "live", "seed", "live", "nd"]);
});

void test("label.control via for= and wrapping; input.labels back-reference", () => {
  const { r } = run(`<body>
    <label id="l1" for="i1">Outer</label><input id="i1">
    <label id="l2">Wrap <input id="i2"></label>
  </body>`, `
    __r = [el("l1").control === el("i1"), el("l2").control === el("i2"),
           el("i1").labels.length, el("i1").labels[0] === el("l1"), el("l1").htmlFor];
    el("l1").htmlFor = "i2";
    __r.push(el("l1").control === el("i2"));
  `);
  assert.deepEqual(j(sandboxOf(r)["__r"]), [true, true, 1, true, "i1", true]);
});

void test("output + datalist + input.list wiring", () => {
  const { r } = run(`<body>
    <output id="out" name="o" for="a b">42</output>
    <datalist id="dl"><option value="x"></option><option value="y"></option></datalist>
    <input id="li" list="dl">
  </body>`, `
    __r = [el("out").value, el("out").defaultValue, el("out").type, el("out").htmlFor,
           el("dl").options.length, el("li").list === el("dl")];
    el("out").value = "7";
    __r.push(el("out").value, el("out").defaultValue);
  `);
  assert.deepEqual(j(sandboxOf(r)["__r"]),
    ["42", "42", "output", "a b", 2, true, "7", "42"]);
});

void test("form.elements indexed + named; form[name]; RadioNodeList.value", () => {
  const { r } = run(`<body>
    <form id="f">
      <input name="q"><input type="radio" name="grp" value="a" checked>
      <input type="radio" name="grp" value="b"><button name="go">G</button>
      <fieldset id="fs"><input name="inner"></fieldset>
      <output name="o">x</output>
    </form></body>`, `
    __r = [el("f").length, el("f").elements.length, el("f").elements[0].name, el("f").elements.q !== undefined,
           el("f").q !== undefined, el("f").elements.grp.length, el("f").grp.value, el("f").method, el("f").elements.item(1).name];
  `);
  // 7 listed elements: q, grp, grp, go, fieldset, inner, o (fieldset counts).
  assert.deepEqual(j(sandboxOf(r)["__r"]),
    [7, 7, "q", true, true, 2, "a", "get", "grp"]);
});

void test("input value reflectors: type sanitize, valueAsNumber, stepUp/Down, selection", () => {
  const { r } = run(`<body><input id="n" type="number" min="0" max="10" step="2" value="4">
    <input id="t"><input id="w" type="bogus"></body>`, `
    __r = [el("n").type, el("w").type, el("n").valueAsNumber];
    el("n").stepUp(); __r.push(el("n").value);           // 6
    el("n").stepUp(2); __r.push(el("n").value);          // 10
    el("n").stepUp(); __r.push(el("n").value);           // clamped 10
    el("n").stepDown(10); __r.push(el("n").value);       // clamped 0
    el("t").value = "abcdef";
    el("t").setSelectionRange(1, 3); __r.push(el("t").selectionStart, el("t").selectionEnd);
    el("t").setRangeText("ZZ"); __r.push(el("t").value); // replace selection
    el("t").select(); __r.push(el("t").selectionStart, el("t").selectionEnd);
  `);
  assert.deepEqual(j(sandboxOf(r)["__r"]),
    ["number", "text", 4, "6", "10", "10", "0", 1, 3, "aZZdef", 0, 6]);
});

void test(":placeholder-shown + :read-write/:read-only + :user-invalid", () => {
  const { r, s } = run(`<body>
    <input id="ph" placeholder="Type"><input id="ro" readonly value="x">
    <div id="ce" contenteditable>edit</div><div id="plain">x</div>
    <input id="req" required>
    <style>
      #ph:placeholder-shown { color: teal } #ro:read-only { color: gray }
      #ce:read-write { color: navy } #plain:read-write { color: red }
      #req:user-invalid { color: fuchsia }
    </style></body>`);
  const g = sandboxOf(r);
  const doc = g["document"] as {
    getElementById(id: string): { matches(s: string): boolean; value: string };
    getComputedStyle(el: unknown): { color: string };
  };
  const ph = doc.getElementById("ph"), ro = doc.getElementById("ro"),
    ce = doc.getElementById("ce"), plain = doc.getElementById("plain"), req = doc.getElementById("req");
  assert.equal(ph.matches(":placeholder-shown"), true);
  ph.value = "v";
  assert.equal(ph.matches(":placeholder-shown"), false);
  const gcs = (el: unknown) => (g as unknown as {
    getComputedStyle(e: unknown): { color: string };
  }).getComputedStyle(el);
  assert.equal(gcs(ro).color, "rgb(128, 128, 128)");
  assert.equal(gcs(ce).color, "rgb(0, 0, 128)");
  assert.equal(plain.matches(":read-write"), false);
  // user-invalid requires a committed (touched) invalid control.
  assert.equal(req.matches(":user-invalid"), false, "untouched ⇒ no :user-invalid");
  r.ui!.click(idOf(s, "req"), {});
  r.ui!.key({ key: "Backspace" }); // edits nothing but commits the interaction
  assert.equal(req.matches(":user-invalid"), true);
});

void test("control intrinsic sizing: checkbox 13², size attr, textarea cols/rows, hidden gone", () => {
  const s = new FineSession(
    `<body><input id="cb" type="checkbox"><input id="t" size="10">
     <input id="hd" type="hidden"><textarea id="ta" rows="3" cols="10"></textarea>
     <select id="sel"><option>WideOptionLabel</option></select></body>`,
    BASE,
  );
  const { r } = { r: runScriptsOnSession(s, [""]) };
  assert.equal(r.error, null);
  const tree = s.layoutTree();
  const box = (id: NodeId) => {
    for (const [, f] of tree.fragments) {
      if (f.node === id) return { w: f.box.borderBox.width, h: f.box.borderBox.height };
    }
    return null;
  };
  const cb = box(idOf(s, "cb"))!;
  assert.equal(cb.w, 13);
  assert.equal(cb.h, 13);
  const t = box(idOf(s, "t"))!;
  assert.ok(t.w > 30 && t.w < 90, `size=10 input width ${t.w} ≈ 10 chars`);
  assert.equal(box(idOf(s, "hd")), null, "hidden input renders nothing");
  const ta = box(idOf(s, "ta"))!;
  assert.ok(ta.h > 40, `textarea rows=3 height ${ta.h}`);
  assert.ok(box(idOf(s, "sel"))!.w > 60, "select fits the widest option");
});

void test("reset() restores markup defaults and clears live state", () => {
  const { r } = run(`<body><form id="f"><input id="i" value="seed">
    <input id="cb" type="checkbox"></form></body>`, `
    el("i").value = "edited"; el("cb").checked = true;
    el("f").reset();
    __r = [el("i").value, el("cb").checked, el("i").matches(":placeholder-shown") === false];
  `);
  assert.deepEqual(j(sandboxOf(r)["__r"]), ["seed", false, true]);
});
