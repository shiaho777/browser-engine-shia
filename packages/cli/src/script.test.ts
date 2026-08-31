/**
 * Tests for the M3.2 scripting bridge: REAL JavaScript (executed by V8 via
 * `node:vm`) mutates the DOM, and the fine-grained session re-renders to reflect
 * it. This is the interactive loop end-to-end: script → DOM mutation →
 * incremental re-render.
 *
 * Built by `tsc` then run with: `node --test packages/cli/dist/*.test.js`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { PaintCmd } from "@browser-engine/ir";

import { FineSession } from "./fine.js";
import { runScript } from "./script.js";

const styled =
  "<html><head><style>.box { width: 10px; height: 10px; background-color: red }" +
  " .hot { background-color: blue }</style></head>" +
  '<body><div id="a" class="box">hi</div></body></html>';

function rectFills(list: { commands: readonly PaintCmd[] }): { r: number; g: number; b: number }[] {
  return list.commands
    .filter((c): c is Extract<PaintCmd, { op: "rect" }> => c.op === "rect")
    .map((c) => ({ r: c.fill.r, g: c.fill.g, b: c.fill.b }));
}

function textGlyphIds(list: { commands: readonly PaintCmd[] }): number[] {
  return list.commands
    .filter((c): c is Extract<PaintCmd, { op: "text" }> => c.op === "text")
    .flatMap((c) => c.glyphs.map((g) => g.glyphId));
}

void test("real JS setAttribute mutates the DOM and the engine re-renders the new style", () => {
  const session = new FineSession(styled);
  // Before: the div is `.box` ⇒ red.
  assert.deepEqual(rectFills(session.render()), [{ r: 255, g: 0, b: 0 }]);

  // Real V8-executed JavaScript toggles the class.
  const result = runScript(session, `document.getElementById("a").setAttribute("class", "box hot");`);
  assert.equal(result.mutations, 1);

  // After re-render: the `.hot` rule wins ⇒ blue.
  assert.deepEqual(rectFills(session.render()), [{ r: 0, g: 0, b: 255 }]);
});

void test("real JS textContent assignment changes the rendered glyph run", () => {
  const session = new FineSession(styled);
  assert.deepEqual(textGlyphIds(session.render()), [0x68, 0x69]); // "hi"

  runScript(session, `document.getElementById("a").textContent = "ok";`);

  assert.deepEqual(textGlyphIds(session.render()), [0x6f, 0x6b]); // "ok"
});

void test("real JS textContent reads descendants and replaces the child subtree", () => {
  const session = new FineSession(
    '<html><body><div id="host"><span id="first">hello</span><span> world</span></div></body></html>',
  );

  runScript(
    session,
    `const host = document.getElementById("host");
     if (host.textContent !== "hello world") throw new Error("read failed: " + host.textContent);
     host.textContent = "updated";
     if (host.textContent !== "updated") throw new Error("write failed: " + host.textContent);
     if (host.querySelector("span") !== null) throw new Error("old child subtree survived");`,
  );

  assert.deepEqual(textGlyphIds(session.render()), [0x75, 0x70, 0x64, 0x61, 0x74, 0x65, 0x64]); // "updated"
});

void test("real JS can read back the DOM it mutated (getAttribute / textContent)", () => {
  const session = new FineSession(styled);
  session.render();
  // The script reads, mutates, and the assertions ride on a returned marker
  // attribute so we observe the script's own view of the DOM.
  runScript(
    session,
    `const el = document.querySelector("#a");
     if (el.getAttribute("class") !== "box") throw new Error("read failed: " + el.getAttribute("class"));
     el.setAttribute("data-seen", el.textContent);`,
  );
  // The script wrote its observed textContent ("hi") into data-seen.
  const a = [...session.dom.nodes.values()].find((n) => n.attrs?.get("id") === "a");
  assert.equal(a?.attrs?.get("data-seen"), "hi");
});

void test("real JS observes document and node baseURI through the shared document base URL", () => {
  const session = new FineSession(
    '<html><head><base id="first-base" href="https://cdn.test/assets/">' +
      '<base id="later-base" href="https://ignored.test/assets/"></head><body><div id="x"></div></body></html>',
    "https://site.test/pages/index.html",
  );

  const result = runScript(
    session,
    `const x = document.getElementById("x");
     const first = document.getElementById("first-base");
     const later = document.getElementById("later-base");
     if (document.URL !== "https://site.test/pages/index.html") throw new Error("document URL mismatch: " + document.URL);
     if (document.documentURI !== document.URL) throw new Error("documentURI mismatch: " + document.documentURI);
     if (document.baseURI !== "https://cdn.test/assets/") throw new Error("baseURI read failed: " + document.baseURI);
     if (x.baseURI !== document.baseURI) throw new Error("node baseURI mismatch: " + x.baseURI);
     later.setAttribute("href", "https://later.test/assets/");
     if (document.baseURI !== "https://cdn.test/assets/") throw new Error("later base changed baseURI: " + document.baseURI);
     first.setAttribute("href", "https://other.test/root/");
     if (document.baseURI !== "https://other.test/root/") throw new Error("first base mutation not reflected: " + document.baseURI);
     if (x.baseURI !== "https://other.test/root/") throw new Error("node baseURI not updated: " + x.baseURI);`,
  );

  assert.equal(result.mutations, 2);
});

void test("real JS observes document URL as baseURI when the first base href is invalid or missing", () => {
  const missing = new FineSession('<html><body><div id="x"></div></body></html>', "https://site.test/pages/index.html");
  runScript(
    missing,
    `if (document.baseURI !== "https://site.test/pages/index.html") throw new Error("missing base fallback failed");
     if (document.getElementById("x").baseURI !== document.baseURI) throw new Error("node missing base fallback failed");`,
  );

  const invalid = new FineSession(
    '<html><head><base href="http://bad.test:99999/assets/"><base href="https://later.test/assets/"></head>' +
      '<body><div id="x"></div></body></html>',
    "https://site.test/pages/index.html",
  );
  runScript(
    invalid,
    `if (document.baseURI !== "https://site.test/pages/index.html") throw new Error("invalid first base fallback failed: " + document.baseURI);
     if (document.getElementById("x").baseURI !== document.baseURI) throw new Error("node invalid base fallback failed");`,
  );
});

void test("real JS removeAttribute deletes the key and updates selector-driven style", () => {
  const session = new FineSession(
    '<html><head><style>[data-on]{width:12px;height:12px;background-color:red}</style></head><body><div id="x" data-on="yes"></div></body></html>',
  );
  assert.ok(session.render().commands.some((c) => c.op === "rect" && c.fill.r === 255), "precondition: attr rule paints");

  const result = runScript(
    session,
    `const x = document.getElementById("x");
     x.removeAttribute("data-on");
     if (x.hasAttribute("data-on")) throw new Error("attribute key survived");
     if (x.getAttribute("data-on") !== null) throw new Error("getAttribute did not return null");
     if (x.matches("[data-on]")) throw new Error("presence selector still matches");`,
  );

  assert.equal(result.mutations, 1);
  assert.ok(!session.render().commands.some((c) => c.op === "rect" && c.fill.r === 255), "attr rule no longer paints");
});

void test("real JS toggleAttribute mutates only when the final attribute presence changes", () => {
  const session = new FineSession(
    '<html><head><style>[data-on]{width:12px;height:12px;background-color:red}</style></head><body><div id="x"></div></body></html>',
  );
  assert.ok(!session.render().commands.some((c) => c.op === "rect" && c.fill.r === 255), "precondition: attr rule absent");

  const result = runScript(
    session,
    `const x = document.getElementById("x");
     if (x.toggleAttribute("data-on") !== true) throw new Error("missing no-force toggle did not return true");
     if (x.getAttribute("data-on") !== "") throw new Error("new boolean attribute value mismatch");
     if (!x.matches("[data-on]")) throw new Error("presence selector does not match after add");
     if (getComputedStyle(x).getPropertyValue("height") !== "12px") throw new Error("computed style did not update after add");
     if (x.toggleAttribute("data-on", true) !== true) throw new Error("force=true did not return true");
     if (x.toggleAttribute("data-on") !== false) throw new Error("present no-force toggle did not return false");
     if (x.hasAttribute("data-on")) throw new Error("attribute survived no-force removal");
     if (x.matches("[data-on]")) throw new Error("presence selector still matches after remove");
     if (getComputedStyle(x).getPropertyValue("height") !== "auto") throw new Error("computed style did not update after remove");
     if (x.toggleAttribute("data-on", false) !== false) throw new Error("force=false did not return false");`,
  );

  assert.equal(result.mutations, 2);
  assert.ok(!session.render().commands.some((c) => c.op === "rect" && c.fill.r === 255), "attr rule remains absent");
});

void test("real JS getAttributeNames reports live insertion order and HTML-normalized names", () => {
  const session = new FineSession(
    '<html><body><div id="x" DATA-FIRST="a" class="box" data-second="b"></div></body></html>',
  );

  const result = runScript(
    session,
    `const x = document.getElementById("x");
     const initial = x.getAttributeNames();
     if (initial.join("|") !== "id|data-first|class|data-second") throw new Error("initial order mismatch: " + initial.join("|"));
     x.setAttribute("DATA-LATE", "c");
     if (x.getAttribute("data-late") !== "c") throw new Error("setAttribute did not normalize lookup name");
     if (!x.hasAttribute("data-late")) throw new Error("hasAttribute missed normalized name");
     if (x.getAttributeNames().join("|") !== "id|data-first|class|data-second|data-late") {
       throw new Error("late insertion order mismatch: " + x.getAttributeNames().join("|"));
     }
     x.removeAttribute("CLASS");
     if (x.hasAttribute("class")) throw new Error("removeAttribute did not normalize removal name");
     if (x.getAttributeNames().join("|") !== "id|data-first|data-second|data-late") {
       throw new Error("removal order mismatch: " + x.getAttributeNames().join("|"));
     }
     x.toggleAttribute("DATA-FLAG", true);
     if (x.getAttributeNames().join("|") !== "id|data-first|data-second|data-late|data-flag") {
       throw new Error("toggle insertion order mismatch: " + x.getAttributeNames().join("|"));
     }`,
  );

  assert.equal(result.mutations, 3);
});

void test("real JS cloneNode creates independent shallow and deep detached copies", () => {
  const session = new FineSession(
    '<html><head><style>.copied{width:12px;height:12px;background-color:red}</style></head>' +
      '<body><section id="host"><article id="source" class="copied" data-k="v"><span id="inner">hello</span></article></section></body></html>',
  );

  const result = runScript(
    session,
    `const host = document.getElementById("host");
     const source = document.getElementById("source");
     const shallow = source.cloneNode(false);
     if (shallow === source) throw new Error("shallow clone reused the original wrapper");
     if (shallow.tagName !== "ARTICLE") throw new Error("shallow clone tag mismatch: " + shallow.tagName);
     if (shallow.getAttribute("class") !== "copied") throw new Error("shallow clone lost class");
     if (shallow.getAttribute("data-k") !== "v") throw new Error("shallow clone lost data attr");
     if (shallow.childNodes.length !== 0) throw new Error("shallow clone copied children");

     const deep = source.cloneNode(true);
     if (deep.childNodes.length !== 1) throw new Error("deep clone child count mismatch");
     if (deep.querySelector("span").textContent !== "hello") throw new Error("deep clone lost descendant text");
     source.setAttribute("data-k", "changed");
     source.querySelector("span").textContent = "source";
     if (deep.getAttribute("data-k") !== "v") throw new Error("deep clone shares attributes with original");
     if (deep.querySelector("span").textContent !== "hello") throw new Error("deep clone shares text with original");

     deep.setAttribute("id", "clone");
     deep.querySelector("span").setAttribute("id", "clone-inner");
     deep.querySelector("span").textContent = "clone";
     host.appendChild(deep);
     if (document.getElementById("clone") !== deep) throw new Error("appended clone not queryable");
     if (document.getElementById("clone-inner").textContent !== "clone") throw new Error("clone descendant not queryable");
     if (document.getElementById("inner").textContent !== "source") throw new Error("original descendant was mutated by clone edit");`,
  );

  assert.equal(result.mutations, 6);
  assert.equal(session.render().commands.filter((c) => c.op === "rect" && c.fill.r === 255).length, 2);
});

void test("real JS append and prepend insert strings and nodes in order", () => {
  const session = new FineSession(
    '<html><head><style>.made{width:12px;height:12px;background-color:red}</style></head>' +
      '<body><section id="host"><span id="middle">M</span></section><aside id="old"><b id="moved">X</b></aside></body></html>',
  );

  const result = runScript(
    session,
    `const host = document.getElementById("host");
     const middle = document.getElementById("middle");
     const tail = document.createElement("i");
     tail.id = "tail";
     tail.className = "made";
     tail.textContent = "T";
     host.append("A", tail, "Z");
     if (host.textContent !== "MA TZ".replace(" ", "")) throw new Error("append order mismatch: " + host.textContent);
     if (host.lastChild.textContent !== "Z") throw new Error("append string did not become a trailing text node");
     if (document.getElementById("tail") !== tail) throw new Error("appended node not queryable");

     const head = document.createElement("em");
     head.id = "head";
     head.textContent = "H";
     host.prepend("L", head);
     if (host.textContent !== "LHMATZ") throw new Error("prepend order mismatch: " + host.textContent);
     if (host.firstChild.textContent !== "L") throw new Error("prepend string did not become a leading text node");
     if (host.children[0] !== head) throw new Error("prepended element is not the first element child");

     const moved = document.getElementById("moved");
     host.prepend(moved, "Q");
     if (document.getElementById("old").textContent !== "") throw new Error("reparent left stale text in old parent");
     if (moved.parentElement !== host) throw new Error("moved node parent mismatch");
     if (host.textContent !== "XQLHMATZ") throw new Error("reparent prepend order mismatch: " + host.textContent);
     if (host.querySelector("#moved") !== moved) throw new Error("fresh scoped query missed moved node");`,
  );

  assert.equal(result.mutations, 10);
  assert.equal(session.render().commands.filter((c) => c.op === "rect" && c.fill.r === 255).length, 1);
});

void test("real JS before and after insert strings and nodes around the receiver", () => {
  const session = new FineSession(
    '<html><head><style>.made{width:12px;height:12px;background-color:red}</style></head>' +
      '<body><section id="host"><span id="left">L</span><span id="target">T</span><span id="right">R</span></section>' +
      '<aside id="old"><b id="moved">X</b></aside></body></html>',
  );

  const result = runScript(
    session,
    `const host = document.getElementById("host");
     const target = document.getElementById("target");
     const beforeNode = document.createElement("i");
     beforeNode.id = "before-node";
     beforeNode.textContent = "B";
     target.before("a", beforeNode);
     if (host.textContent !== "LaBTR") throw new Error("before order mismatch: " + host.textContent);
     if (host.children[1] !== beforeNode) throw new Error("before element position mismatch");

     const afterNode = document.createElement("em");
     afterNode.id = "after-node";
     afterNode.className = "made";
     afterNode.textContent = "A";
     target.after(afterNode, "z");
     if (host.textContent !== "LaBTAzR") throw new Error("after order mismatch: " + host.textContent);
     if (document.getElementById("after-node") !== afterNode) throw new Error("after node not queryable");

     const moved = document.getElementById("moved");
     target.after(moved, "q");
     if (document.getElementById("old").textContent !== "") throw new Error("reparent left stale text in old parent");
     if (moved.parentElement !== host) throw new Error("moved node parent mismatch");
     if (host.textContent !== "LaBTXqAzR") throw new Error("after reparent order mismatch: " + host.textContent);
     if (host.querySelector("#moved") !== moved) throw new Error("fresh scoped query missed moved node");

     const detached = document.createElement("p");
     detached.before("ignored");
     detached.after("ignored");
     if (detached.textContent !== "") throw new Error("detached before/after should be no-op");`,
  );

  assert.equal(result.mutations, 11);
  assert.equal(session.render().commands.filter((c) => c.op === "rect" && c.fill.r === 255).length, 1);
});

void test("real JS replaceWith replaces the receiver with strings and nodes", () => {
  const session = new FineSession(
    '<html><head><style>.made{width:12px;height:12px;background-color:red}</style></head>' +
      '<body><section id="host"><span id="left">L</span><span id="target">T</span><span id="right">R</span></section>' +
      '<aside id="old"><b id="moved">X</b></aside><section id="remove-host"><span id="remove-target">bye</span></section></body></html>',
  );

  const result = runScript(
    session,
    `const host = document.getElementById("host");
     const target = document.getElementById("target");
     const replacement = document.createElement("i");
     replacement.id = "replacement";
     replacement.className = "made";
     replacement.textContent = "N";
     target.replaceWith("a", replacement, "b");
     if (host.textContent !== "LaNbR") throw new Error("replaceWith order mismatch: " + host.textContent);
     if (target.parentNode !== null) throw new Error("receiver was not detached");
     if (document.getElementById("target") !== null) throw new Error("detached receiver remained queryable");
     if (host.children[1] !== replacement) throw new Error("replacement element position mismatch");
     if (getComputedStyle(replacement).getPropertyValue("width") !== "12px") throw new Error("replacement style did not apply");

     const moved = document.getElementById("moved");
     replacement.replaceWith(moved, "q");
     if (document.getElementById("old").textContent !== "") throw new Error("reparent left stale text in old parent");
     if (moved.parentElement !== host) throw new Error("moved node parent mismatch");
     if (replacement.parentNode !== null) throw new Error("replaced element was not detached");
     if (host.textContent !== "LaXqbR") throw new Error("replaceWith reparent order mismatch: " + host.textContent);
     if (host.querySelector("#moved") !== moved) throw new Error("fresh scoped query missed moved node");

     const removeTarget = document.getElementById("remove-target");
     removeTarget.replaceWith();
     if (document.getElementById("remove-target") !== null) throw new Error("empty replaceWith did not remove receiver");
     if (document.getElementById("remove-host").textContent !== "") throw new Error("empty replaceWith left text behind");

     const detached = document.createElement("p");
     detached.replaceWith("ignored");
     if (detached.textContent !== "") throw new Error("detached replaceWith should be no-op");
     if (document.querySelector("p") !== null) throw new Error("detached receiver entered the document");`,
  );

  assert.equal(result.mutations, 8);
  assert.equal(session.render().commands.filter((c) => c.op === "rect" && c.fill.r === 255).length, 0);
});

void test("real JS createComment creates traversable comments that do not render text", () => {
  const session = new FineSession(
    '<html><body><section id="host"><span id="visible">V</span></section></body></html>',
  );

  const result = runScript(
    session,
    `const host = document.getElementById("host");
     const visible = document.getElementById("visible");
     const comment = document.createComment("secret");
     if (comment.textContent !== "secret") throw new Error("comment textContent mismatch");
     if (comment.parentNode !== null) throw new Error("fresh comment should be detached");
     comment.textContent = "hidden";
     host.appendChild(comment);
     if (comment.parentNode !== host) throw new Error("comment parent mismatch after append");
     if (host.childNodes.length !== 2) throw new Error("comment missing from childNodes");
     if (host.childNodes[1] !== comment) throw new Error("comment childNodes position mismatch");
     if (host.children.length !== 1 || host.children[0] !== visible) throw new Error("comment leaked into children");
     if (host.textContent !== "V") throw new Error("comment contributed to host textContent: " + host.textContent);
     if (host.querySelector("comment") !== null) throw new Error("comment matched as an element");

     const clone = host.cloneNode(true);
     if (clone.childNodes.length !== 2) throw new Error("deep clone lost comment child");
     if (clone.childNodes[1].textContent !== "hidden") throw new Error("deep clone lost comment text");
     if (clone.children.length !== 1) throw new Error("comment leaked into clone children");
     if (clone.textContent !== "V") throw new Error("cloned comment contributed to textContent");`,
  );

  assert.equal(result.mutations, 3);
  assert.deepEqual(textGlyphIds(session.render()), [0x56]); // "V"; comment text is not rendered.
});

void test("real JS CharacterData.data reflects text and comment node data", () => {
  const session = new FineSession(
    '<html><body><section id="host"><span id="visible">V</span></section></body></html>',
  );

  const result = runScript(
    session,
    `const host = document.getElementById("host");
     const visible = document.getElementById("visible");
     const text = document.createTextNode("alpha");
     host.appendChild(text);
     if (text.data !== "alpha") throw new Error("text data read mismatch: " + text.data);
     if (text.textContent !== "alpha") throw new Error("text textContent precondition failed");
     text.data = "beta";
     if (text.textContent !== "beta") throw new Error("textContent did not follow data setter");
     text.textContent = "gamma";
     if (text.data !== "gamma") throw new Error("data did not follow textContent setter");

     const comment = document.createComment("secret");
     host.appendChild(comment);
     if (comment.data !== "secret") throw new Error("comment data read mismatch");
     comment.data = "hidden";
     if (comment.textContent !== "hidden") throw new Error("comment textContent did not follow data setter");
     comment.textContent = "quiet";
     if (comment.data !== "quiet") throw new Error("comment data did not follow textContent setter");
     if (host.childNodes[2] !== comment) throw new Error("comment missing from childNodes");
     if (host.textContent !== "Vgamma") throw new Error("comment data contributed to parent textContent: " + host.textContent);
     if (visible.textContent !== "V") throw new Error("visible text changed unexpectedly");`,
  );

  assert.equal(result.mutations, 8);
  assert.deepEqual(textGlyphIds(session.render()), [0x56, 0x67, 0x61, 0x6d, 0x6d, 0x61]);
});

void test("real JS hasChildNodes reflects live child-list mutations", () => {
  const session = new FineSession(
    '<html><body><section id="host"><span id="filled">V</span><span id="empty"></span></section><aside id="old"></aside></body></html>',
  );

  const result = runScript(
    session,
    `const host = document.getElementById("host");
     const filled = document.getElementById("filled");
     const empty = document.getElementById("empty");
     const old = document.getElementById("old");
     if (!document.hasChildNodes()) throw new Error("document should have an html child");
     if (!host.hasChildNodes()) throw new Error("host should have children");
     if (!filled.hasChildNodes()) throw new Error("filled span should have its text child");
     if (empty.hasChildNodes()) throw new Error("empty element should report false");

     const text = document.createTextNode("leaf");
     const comment = document.createComment("note");
     if (text.hasChildNodes()) throw new Error("text node should be a leaf");
     if (comment.hasChildNodes()) throw new Error("comment node should be a leaf");

     empty.appendChild(text);
     if (!empty.hasChildNodes()) throw new Error("appendChild text did not update child state");
     empty.removeChild(text);
     if (empty.hasChildNodes()) throw new Error("removeChild last child did not update child state");

     empty.appendChild(comment);
     if (!empty.hasChildNodes()) throw new Error("appendChild comment did not update child state");
     old.appendChild(comment);
     if (empty.hasChildNodes()) throw new Error("reparenting last child left stale true");
     if (!old.hasChildNodes()) throw new Error("new parent did not observe moved child");
     old.removeChild(comment);
     if (old.hasChildNodes()) throw new Error("removing moved child left stale true");`,
  );

  assert.equal(result.mutations, 7);
});

void test("real JS isEqualNode compares DOM structure rather than wrapper identity", () => {
  const session = new FineSession(
    '<html><body><article id="source" data-a="1" data-b="2"><span>text</span></article></body></html>',
  );

  const result = runScript(
    session,
    `const source = document.getElementById("source");
     source.appendChild(document.createComment("note"));
     const clone = source.cloneNode(true);
     if (source === clone) throw new Error("clone unexpectedly reused wrapper identity");
     if (!source.isEqualNode(clone)) throw new Error("deep clone should be structurally equal");
     if (source.isEqualNode(null)) throw new Error("null should not be equal");
     if (source.isEqualNode(document.createTextNode(source.textContent))) throw new Error("different node kind compared equal");

     const reorderedAttrs = document.createElement("article");
     reorderedAttrs.setAttribute("data-b", "2");
     reorderedAttrs.setAttribute("data-a", "1");
     reorderedAttrs.setAttribute("id", "source");
     reorderedAttrs.appendChild(document.createElement("span"));
     reorderedAttrs.children[0].textContent = "text";
     reorderedAttrs.appendChild(document.createComment("note"));
     if (!source.isEqualNode(reorderedAttrs)) throw new Error("attribute insertion order affected equality");

     clone.setAttribute("data-b", "changed");
     if (source.isEqualNode(clone)) throw new Error("attribute value change did not affect equality");
     clone.setAttribute("data-b", "2");
     clone.childNodes[0].textContent = "other";
     if (source.isEqualNode(clone)) throw new Error("text data change did not affect equality");
     clone.childNodes[0].textContent = "text";
     clone.childNodes[1].textContent = "changed";
     if (source.isEqualNode(clone)) throw new Error("comment data change did not affect equality");

     const wrongOrder = document.createElement("article");
     wrongOrder.setAttribute("data-a", "1");
     wrongOrder.setAttribute("data-b", "2");
     wrongOrder.setAttribute("id", "source");
     wrongOrder.appendChild(document.createComment("note"));
     const span = document.createElement("span");
     span.textContent = "text";
     wrongOrder.appendChild(span);
     if (source.isEqualNode(wrongOrder)) throw new Error("child order did not affect equality");`,
  );

  assert.equal(result.mutations, 26);
});

void test("real JS normalize merges adjacent text nodes and removes empty text nodes", () => {
  const session = new FineSession(
    '<html><body><section id="host"><span id="left">L</span><!--gap--><span id="nested"></span><span id="right">R</span></section></body></html>',
  );

  const result = runScript(
    session,
    `const host = document.getElementById("host");
     const left = document.getElementById("left");
     const nested = document.getElementById("nested");
     const right = document.getElementById("right");

     host.insertBefore(document.createTextNode("a"), left);
     host.insertBefore(document.createTextNode(""), left);
     host.insertBefore(document.createTextNode("b"), left);
     host.insertBefore(document.createTextNode("c"), right);
     host.insertBefore(document.createTextNode(""), right);
     host.insertBefore(document.createTextNode("d"), right);
     nested.appendChild(document.createTextNode("x"));
     nested.appendChild(document.createTextNode(""));
     nested.appendChild(document.createTextNode("y"));

     host.normalize();
     if (host.textContent !== "abLxycdR") throw new Error("unexpected host textContent: " + host.textContent);
     if (host.childNodes.length !== 6) throw new Error("host child count mismatch after normalize: " + host.childNodes.length);
     if (host.childNodes[0].textContent !== "ab") throw new Error("leading text run did not merge");
     if (host.childNodes[1] !== left) throw new Error("left element boundary moved");
     if (host.childNodes[2].textContent !== "gap") throw new Error("comment boundary changed");
     if (host.childNodes[3] !== nested) throw new Error("nested element boundary moved");
     if (nested.childNodes.length !== 1 || nested.firstChild.textContent !== "xy") throw new Error("nested text run did not normalize");
     if (host.childNodes[4].textContent !== "cd") throw new Error("post-nested text run did not merge");
     if (host.childNodes[5] !== right) throw new Error("right element boundary moved");

     const before = host.childNodes.length + ":" + host.textContent + ":" + nested.childNodes.length;
     host.normalize();
     const after = host.childNodes.length + ":" + host.textContent + ":" + nested.childNodes.length;
     if (before !== after) throw new Error("second normalize changed an already-normal subtree");`,
  );

  assert.equal(result.mutations, 19);
  assert.deepEqual(textGlyphIds(session.render()), [0x61, 0x62, 0x4c, 0x78, 0x79, 0x63, 0x64, 0x52]);
});

void test("real JS compareDocumentPosition reports live document order and disconnected nodes", () => {
  const session = new FineSession(
    '<html><body><section id="host"><article id="a"><span id="a-child"></span></article><article id="b"></article><article id="c"></article></section></body></html>',
  );

  const result = runScript(
    session,
    `const D = Node.DOCUMENT_POSITION_DISCONNECTED;
     const P = Node.DOCUMENT_POSITION_PRECEDING;
     const F = Node.DOCUMENT_POSITION_FOLLOWING;
     const C = Node.DOCUMENT_POSITION_CONTAINS;
     const CB = Node.DOCUMENT_POSITION_CONTAINED_BY;
     const I = Node.DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC;
     const host = document.getElementById("host");
     const a = document.getElementById("a");
     const aChild = document.getElementById("a-child");
     const b = document.getElementById("b");
     const c = document.getElementById("c");

     if (a.compareDocumentPosition(a) !== 0) throw new Error("same node should compare as zero");
     if (a.DOCUMENT_POSITION_FOLLOWING !== F) throw new Error("node constant mismatch");
     if (document.compareDocumentPosition(document) !== 0) throw new Error("document should compare to itself as zero");
     if (a.compareDocumentPosition(b) !== F) throw new Error("b should follow a");
     if (b.compareDocumentPosition(a) !== P) throw new Error("a should precede b");
     if (document.compareDocumentPosition(host) !== (CB | F)) throw new Error("document containment flags mismatch");
     if (host.compareDocumentPosition(aChild) !== (CB | F)) throw new Error("descendant flags mismatch");
     if (aChild.compareDocumentPosition(host) !== (C | P)) throw new Error("ancestor flags mismatch");

     host.insertBefore(c, a);
     if (c.compareDocumentPosition(a) !== F) throw new Error("reparented c should now precede a");
     if (a.compareDocumentPosition(c) !== P) throw new Error("a should now follow reparented c");

     b.remove();
     const detached = document.createElement("aside");
     const removed = b.compareDocumentPosition(a);
     const fresh = detached.compareDocumentPosition(a);
     if ((removed & D) === 0 || (removed & I) === 0) throw new Error("removed node did not report disconnected");
     if ((fresh & D) === 0 || (fresh & I) === 0) throw new Error("fresh node did not report disconnected");
     if (removed === 0 || fresh === 0) throw new Error("disconnected nodes compared as equal");`,
  );

  assert.equal(result.mutations, 3);
});

void test("a script that mutates nothing performs zero mutations and changes no output", () => {
  const session = new FineSession(styled);
  const before = rectFills(session.render());
  const result = runScript(session, `var x = document.getElementById("a").getAttribute("class");`);
  assert.equal(result.mutations, 0);
  assert.deepEqual(rectFills(session.render()), before);
});

void test("scripted mutation re-renders incrementally (only the edited node recomputes)", () => {
  // A list with many items; a script edits ONE — the per-node session recomputes
  // only that item's cascade (the M4 win, now driven by real JS).
  const items = Array.from({ length: 40 }, (_, i) => `<div id="i${i}" class="box">x</div>`).join("");
  const html =
    "<html><head><style>.box { width: 5px; height: 5px; background-color: red } .hot { background-color: blue }</style></head>" +
    `<body>${items}</body></html>`;
  const session = new FineSession(html);
  session.render();
  const before = session.recomputeCount;

  runScript(session, `document.getElementById("i20").setAttribute("class", "box hot");`);
  session.render();
  const delta = session.recomputeCount - before;

  // Constant-ish work for one scripted edit, NOT ~40 cascades.
  assert.ok(delta < 10, `one scripted edit recomputes O(1), not O(N): delta=${delta}`);
  // And exactly one box turned blue.
  assert.equal(session.render().commands.filter((c) => c.op === "rect" && c.fill.b === 255).length, 1);
});

void test("innerHTML parses table rows with implied tbody (HTML5 in-table insertion)", async () => {
  const { runScriptsOnSessionReal } = await import("./event-loop.js");
  const session = new FineSession(
    "<html><body><div id='host'></div></body></html>",
    "https://example.test/",
  );
  const run = await runScriptsOnSessionReal(
    session,
    [
      `var p = document.getElementById("host");
p.innerHTML = "<div>A</div><table><tr><td>B</td></tr></table>";
var e = p.firstChild;
var table = e.nextSibling;
globalThis.shape = JSON.stringify({
  e: e.tagName,
  table: table.tagName,
  tbody: table.firstChild ? table.firstChild.tagName : "NULL",
  tr: table.firstChild && table.firstChild.firstChild ? table.firstChild.firstChild.tagName : "NULL",
  td: table.firstChild && table.firstChild.firstChild && table.firstChild.firstChild.firstChild
    ? table.firstChild.firstChild.firstChild.tagName : "NULL"
});`,
    ],
    undefined,
    {},
  );
  assert.equal(run.error, null);
  assert.deepEqual(JSON.parse(String(run.sandbox?.["shape"])), {
    e: "DIV",
    table: "TABLE",
    tbody: "TBODY",
    tr: "TR",
    td: "TD",
  });
});

void test("innerHTML flattens synthesized document outline (no head/body leakage)", async () => {
  const { runScriptsOnSessionReal } = await import("./event-loop.js");
  const session = new FineSession(
    "<html><body><div id='host'></div></body></html>",
    "https://example.test/",
  );
  const run = await runScriptsOnSessionReal(
    session,
    [
      `var p = document.getElementById("host");
p.innerHTML = "<span>x</span>";
var tags = [];
for (var c = p.firstChild; c; c = c.nextSibling) tags.push(c.tagName);
globalThis.tags = tags.join(",");`,
    ],
    undefined,
    {},
  );
  assert.equal(run.error, null);
  assert.equal(run.sandbox?.["tags"], "SPAN");
});

void test("document.scripts + currentScript support self-locating inline scripts", async () => {
  const { runScriptsOnSessionReal } = await import("./event-loop.js");
  const session = new FineSession(
    "<html><body><div id='app'></div></body></html>",
    "https://example.test/",
  );
  const src = `var host = document.getElementById("app");
var sc = document.createElement("script");
host.appendChild(sc);
var s = document.currentScript || document.scripts[document.scripts.length - 1];
globalThis.scriptsLen = document.scripts.length;
globalThis.removed = (s.parentNode ? "has-parent" : "no-parent");`;
  const run = await runScriptsOnSessionReal(session, [src], undefined, {});
  assert.equal(run.error, null);
  assert.ok(Number(run.sandbox?.["scriptsLen"]) >= 1);
  assert.equal(run.sandbox?.["removed"], "has-parent");
});

void test("a/area URL decomposition IDL attributes resolve href (axios anchor parse)", async () => {
  const { runScriptsOnSessionReal } = await import("./event-loop.js");
  const session = new FineSession(
    "<html><body></body></html>",
    "https://www.bilibili.com/video/BV1GJ411x7h7/?spm=a",
  );
  const run = await runScriptsOnSessionReal(session, [`
    const a = document.createElement("a");
    a.setAttribute("href", "https://s1.hdslb.com/bfs/static/player/main/core.js?ver=3");
    globalThis.decomp = {
      protocol: a.protocol, host: a.host, hostname: a.hostname, port: a.port,
      pathname: a.pathname, search: a.search, origin: a.origin,
      pathnameStartsWithSlash: a.pathname.charAt(0) === "/",
    };
    const rel = document.createElement("a");
    rel.setAttribute("href", "/video/BV2/?p=1");
    globalThis.rel = { host: rel.host, pathname: rel.pathname };
    const empty = document.createElement("a");
    globalThis.empty = { href: empty.href, protocol: empty.protocol, pathname: empty.pathname };
    a.hash = "#frag";
    globalThis.afterHash = a.href;
  `], undefined, {});
  assert.equal(run.error, null);
  const decomp = (run.sandbox?.["decomp"] ?? {}) as Record<string, unknown>;
  assert.equal(decomp['protocol'], "https:");
  assert.equal(decomp['host'], "s1.hdslb.com");
  assert.equal(decomp['hostname'], "s1.hdslb.com");
  assert.equal(decomp['port'], "");
  assert.equal(decomp['pathname'], "/bfs/static/player/main/core.js");
  assert.equal(decomp['search'], "?ver=3");
  assert.equal(decomp['origin'], "https://s1.hdslb.com");
  assert.ok(decomp['pathnameStartsWithSlash'], "pathname must be defined and start with / (axios reads charAt)");
  const rel = (run.sandbox?.["rel"] ?? {}) as Record<string, unknown>;
  assert.equal(rel['host'], "www.bilibili.com", "relative href resolves against document base");
  assert.equal(rel['pathname'], "/video/BV2/");
  const empty = (run.sandbox?.["empty"] ?? {}) as Record<string, unknown>;
  assert.equal(empty['href'], "");
  assert.equal(empty['protocol'], "", "no href → spec's no-resolved-URL state: components are empty");
  assert.equal(empty['pathname'], "");
  assert.equal(run.sandbox?.["afterHash"], "https://s1.hdslb.com/bfs/static/player/main/core.js?ver=3#frag");
});