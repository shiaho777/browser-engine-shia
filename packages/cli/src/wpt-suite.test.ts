/**
 * Tests for the official-WPT importer. Proves the engine ingests and runs real
 * WPT-format test files — `.html` testharness tests (with `/resources/
 * testharness.js` includes) and `.window.js` script tests — resolving includes
 * against a checkout, running `test` / `async_test` / `promise_test` on V8, and
 * scoring per-subtest PASS/FAIL exactly as wptrunner does. Vendored real-format
 * fixtures stand in for a multi-gigabyte checkout; `runWptDirectory` runs ANY
 * checkout the same way.
 *
 * Built by `tsc` then run with: `node --test packages/cli/dist/*.test.js`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  runWptHtml,
  runWptScriptFile,
  runWptDirectory,
  collectWptTests,
  extractScripts,
} from "./wpt-suite.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "wpt-fixtures");

void test("extractScripts pulls inline and src scripts in document order", () => {
  const scripts = extractScripts(
    '<script src="/resources/testharness.js"></script><div></div><script>test();</script>',
  );
  assert.equal(scripts.length, 2);
  assert.equal(scripts[0]!.src, "/resources/testharness.js");
  assert.match(scripts[1]!.content, /test\(\)/);
});

void test("runWptHtml runs a real testharness .html test and scores subtests", async () => {
  const html = `<!DOCTYPE html><title>t</title>
    <script src="/resources/testharness.js"></script>
    <body><div id="x" data-k="v">hi</div>
    <script>
      test(function () { assert_equals(document.getElementById("x").getAttribute("data-k"), "v"); }, "attr");
      test(function () { assert_equals(document.getElementById("x").textContent, "hi"); }, "text");
      test(function () { assert_equals(document.getElementById("nope"), null); }, "absent");
    </script></body>`;
  const report = await runWptHtml(html);
  assert.equal(report.harnessError, null);
  assert.equal(report.subtests.length, 3);
  assert.equal(report.passed, 3, JSON.stringify(report.subtests));
});

void test("runWptHtml resolves external stylesheet support resources into the cascade", async () => {
  const html = `<!DOCTYPE html><title>external stylesheet</title>
    <script src="/resources/testharness.js"></script>
    <link rel="stylesheet" href="support/external.css">
    <body><div id="target">external</div>
    <script>
      test(function () {
        assert_equals(getComputedStyle(document.getElementById("target")).color, "rgb(0, 128, 255)");
      }, "external stylesheet color");
      test(function () {
        assert_equals(getComputedStyle(document.getElementById("target")).getPropertyValue("width"), "64px");
      }, "external stylesheet width");
    </script></body>`;
  const calls: string[] = [];
  const report = await runWptHtml(
    html,
    (src) => {
      calls.push(src);
      return src === "wpt://doc/support/external.css" ? "#target { color: #0080ff; width: 64px }" : undefined;
    },
  );
  assert.equal(report.harnessError, null);
  assert.equal(report.passed, 2, JSON.stringify(report.subtests));
  assert.deepEqual(calls, ["wpt://doc/support/external.css"]);
});

void test("runWptHtml resolves external stylesheets against the document base URL", async () => {
  const html = `<!DOCTYPE html><title>base href stylesheet</title>
    <script src="/resources/testharness.js"></script>
    <base href="https://cdn.test/assets/">
    <link rel="stylesheet" href="theme.css">
    <body><div id="target">external</div>
    <script>
      test(function () {
        assert_equals(getComputedStyle(document.getElementById("target")).color, "rgb(0, 128, 255)");
      }, "base href stylesheet color");
    </script></body>`;
  const calls: string[] = [];
  const report = await runWptHtml(
    html,
    (src) => {
      calls.push(src);
      return src === "https://cdn.test/assets/theme.css" ? "#target { color: #0080ff }" : undefined;
    },
    { documentUrl: "https://site.test/pages/index.html" },
  );

  assert.equal(report.harnessError, null);
  assert.equal(report.passed, 1, JSON.stringify(report.subtests));
  assert.deepEqual(calls, ["https://cdn.test/assets/theme.css"]);
});

void test("runWptHtml with trace reports the actual fine-grained WPT query graph", async () => {
  const html = `<!DOCTYPE html><title>t</title>
    <script src="/resources/testharness.js"></script>
    <head><style>#x { color: red }</style></head>
    <body><div id="x">hi</div>
    <script>
      test(function () {
        assert_equals(getComputedStyle(document.getElementById("x")).color, "rgb(255, 0, 0)");
      }, "computed style");
    </script></body>`;
  const report = await runWptHtml(html, undefined, { trace: true });
  assert.equal(report.harnessError, null);
  assert.equal(report.traceError, undefined);
  assert.equal(report.passed, 1, JSON.stringify(report.subtests));
  const stages = new Set(report.trace?.summaries.map((summary) => summary.stage));
  assert.ok(stages.has("qFineSheets"));
  assert.ok(stages.has("qFineComputed"));
  assert.ok(stages.has("qFineLayout"));
  assert.ok(stages.has("qFinePaint"));
});

void test("runWptHtml reports a failing subtest as FAIL (not a thrown error)", async () => {
  const html = `<script src="/resources/testharness.js"></script><div id="x">hi</div>
    <script>
      test(function () { assert_equals(document.getElementById("x").textContent, "WRONG"); }, "bad");
      test(function () { assert_true(true); }, "good");
    </script>`;
  const report = await runWptHtml(html);
  assert.equal(report.passed, 1);
  assert.equal(report.subtests.find((s) => s.name === "bad")?.status, "FAIL");
});

void test("runWptHtml runs async_test and promise_test to completion", async () => {
  const html = `<script src="/resources/testharness.js"></script>
    <script>
      async_test(function (t) { setTimeout(t.step_func_done(function () { assert_true(true); }), 0); }, "async");
      promise_test(function () { return Promise.resolve(1).then(function (v) { assert_equals(v, 1); }); }, "promise");
    </script>`;
  const report = await runWptHtml(html);
  assert.equal(report.passed, 2, JSON.stringify(report.subtests));
});

void test("collectWptTests finds the vendored real-format fixtures", () => {
  const tests = collectWptTests(FIXTURES);
  assert.ok(tests.some((t) => t.endsWith("getelementbyid.html")));
  assert.ok(tests.some((t) => t.endsWith("attributes.window.js")));
});

void test("runWptScriptFile runs a .window.js test", async () => {
  const report = await runWptScriptFile(
    'test(function () { assert_array_equals([1,2], [1,2]); }, "arr");',
  );
  assert.equal(report.passed, 1);
});

void test("runWptDirectory runs the whole fixture suite and aggregates PASS/FAIL", async () => {
  const suite = await runWptDirectory(FIXTURES);
  assert.ok(suite.files >= 3, "all fixture files were discovered and run");
  assert.ok(suite.subtests >= 7, "subtests across files were scored");
  assert.ok(suite.passed >= 7, `most fixture subtests pass: ${suite.passed}/${suite.subtests}`);
  assert.equal(suite.failed, 0, "no fixture subtest fails");
});

void test("runWptDirectory with trace aggregates per-file WPT evidence", async () => {
  const suite = await runWptDirectory(FIXTURES, 2, { trace: true });
  assert.equal(suite.files, 2);
  assert.ok(suite.trace !== undefined, "suite trace is attached");
  assert.ok(suite.trace.totalCalls > 0);
  assert.ok(suite.trace.summaries.some((summary) => summary.stage === "qFinePaint"));
});

void test("WPT: a test that dynamically builds DOM (createElement/appendChild) now passes", async () => {
  // The shape of a real WPT dom/nodes test: construct nodes, wire them, assert.
  const html = `<script src="/resources/testharness.js"></script><body></body>
    <script>
      test(function () {
        var el = document.createElement("section");
        el.id = "made";
        el.setAttribute("data-k", "v");
        document.querySelector("body").appendChild(el);
        var found = document.getElementById("made");
        assert_true(found !== null, "created element is findable");
        assert_equals(found.tagName, "SECTION", "tagName reflects createElement");
        assert_equals(found.getAttribute("data-k"), "v", "attribute set on a created node");
      }, "document.createElement + appendChild + getElementById");

      test(function () {
        var p = document.createElement("p");
        var t = document.createTextNode("hi there");
        p.appendChild(t);
        document.querySelector("body").appendChild(p);
        assert_equals(p.textContent, "hi there", "text node content flows through");
      }, "createTextNode + appendChild");
    </script>`;
  const report = await runWptHtml(html);
  assert.equal(report.harnessError, null);
  assert.equal(report.passed, 2, JSON.stringify(report.subtests));
});

void test("WPT: DOM events — addEventListener, capture/bubble, click, preventDefault", async () => {
  const html = `<script src="/resources/testharness.js"></script>
    <body><div id="outer"><button id="btn">go</button></div></body>
    <script>
      test(function () {
        var order = [];
        var outer = document.getElementById("outer");
        var btn = document.getElementById("btn");
        outer.addEventListener("click", function () { order.push("outer-capture"); }, true);
        outer.addEventListener("click", function () { order.push("outer-bubble"); }, false);
        btn.addEventListener("click", function () { order.push("target"); });
        btn.click();
        assert_array_equals(order, ["outer-capture", "target", "outer-bubble"], "capture → target → bubble");
      }, "click propagates capture → target → bubble");

      test(function () {
        var btn = document.getElementById("btn");
        btn.addEventListener("click", function (e) { e.stopPropagation(); });
        var bubbled = false;
        document.getElementById("outer").addEventListener("click", function () { bubbled = true; });
        btn.dispatchEvent(new Event("click", { bubbles: true }));
        assert_false(bubbled, "stopPropagation halts bubbling");
      }, "stopPropagation");

      test(function () {
        var btn = document.getElementById("btn");
        btn.addEventListener("click", function (e) { e.preventDefault(); });
        var notCancelled = btn.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
        assert_false(notCancelled, "dispatchEvent returns false when default prevented");
      }, "preventDefault + dispatchEvent return value");
    </script>`;
  const report = await runWptHtml(html);
  assert.equal(report.harnessError, null);
  assert.equal(report.passed, 3, JSON.stringify(report.subtests));
});

void test("WPT: classList / dataset / style reflection", async () => {
  const html = `<script src="/resources/testharness.js"></script>
    <body><div id="el" class="a b"></div></body>
    <script>
      test(function () {
        var el = document.getElementById("el");
        assert_true(el.classList.contains("a"));
        assert_equals(el.classList.length, 2);
        el.classList.add("c");
        assert_true(el.classList.contains("c"));
        el.classList.remove("a");
        assert_false(el.classList.contains("a"));
        assert_equals(el.classList.toggle("d"), true);
        assert_equals(el.classList.toggle("d"), false);
      }, "classList add/remove/toggle/contains");

      test(function () {
        var el = document.getElementById("el");
        el.dataset.fooBar = "7";
        assert_equals(el.getAttribute("data-foo-bar"), "7", "camelCase maps to data-foo-bar");
        assert_equals(el.dataset.fooBar, "7", "dataset reads back");
      }, "dataset reflects data-* attributes");

      test(function () {
        var el = document.getElementById("el");
        el.style.setProperty("color", "red");
        assert_equals(el.style.getPropertyValue("color"), "red");
        assert_true(el.getAttribute("style").indexOf("color") >= 0, "style attribute updated");
      }, "style.setProperty reflects the style attribute");
    </script>`;
  const report = await runWptHtml(html);
  assert.equal(report.harnessError, null);
  assert.equal(report.passed, 3, JSON.stringify(report.subtests));
});

void test("WPT: getComputedStyle reads the resolved cascade values (CSSOM)", async () => {
  const html = `<script src="/resources/testharness.js"></script>
    <head><style>#el { color: red; width: 40px; font-size: 20px }</style></head>
    <body><div id="el">hi</div></body>
    <script>
      test(function () {
        var cs = getComputedStyle(document.getElementById("el"));
        assert_equals(cs.getPropertyValue("color"), "rgb(255, 0, 0)", "color resolves to rgb()");
        assert_equals(cs.getPropertyValue("width"), "40px", "width resolves with px unit");
        assert_equals(cs.getPropertyValue("font-size"), "20px", "font-size resolves");
        assert_equals(cs.color, "rgb(255, 0, 0)", "named camelCase access works too");
      }, "getComputedStyle returns resolved CSSOM strings");

      test(function () {
        // Initial values resolve through the cascade (height defaults to auto).
        var cs = getComputedStyle(document.getElementById("el"));
        assert_equals(cs.getPropertyValue("height"), "auto", "an unset length resolves to its initial");
      }, "getComputedStyle reflects initial values");
    </script>`;
  const report = await runWptHtml(html);
  assert.equal(report.harnessError, null);
  assert.equal(report.passed, 2, JSON.stringify(report.subtests));
});

void test("WPT: getBoundingClientRect reads the laid-out geometry", async () => {
  const html = `<script src="/resources/testharness.js"></script>
    <head><style>#b { width: 40px; height: 30px }</style></head>
    <body><div id="b"></div></body>
    <script>
      test(function () {
        var r = document.getElementById("b").getBoundingClientRect();
        assert_equals(r.width, 40, "width from the FragmentTree");
        assert_equals(r.height, 30, "height from the FragmentTree");
        assert_equals(r.right, r.left + r.width, "right = left + width");
        assert_equals(r.bottom, r.top + r.height, "bottom = top + height");
      }, "getBoundingClientRect returns layout geometry");
    </script>`;
  const report = await runWptHtml(html);
  assert.equal(report.harnessError, null);
  assert.equal(report.passed, 1, JSON.stringify(report.subtests));
});

void test("WPT: querySelectorAll uses the full selector engine", async () => {
  const html = `<script src="/resources/testharness.js"></script>
    <body>
      <ul id="list">
        <li class="item" data-k="1">a</li>
        <li class="item active" data-k="2">b</li>
        <li class="item" data-k="3">c</li>
      </ul>
      <p>outside</p>
    </body>
    <script>
      test(function () {
        assert_equals(document.querySelectorAll(".item").length, 3, "class selector matches all items");
        assert_equals(document.querySelectorAll("li.active").length, 1, "compound selector");
        assert_equals(document.querySelectorAll("[data-k=\\"2\\"]").length, 1, "attribute selector");
        assert_equals(document.querySelectorAll("li:first-child").length, 1, "structural pseudo-class");
      }, "querySelectorAll across selector features");

      test(function () {
        var list = document.getElementById("list");
        assert_equals(list.querySelectorAll(".item").length, 3, "scoped to descendants");
        assert_equals(list.querySelector(".item").getAttribute("data-k"), "1", "first match in order");
        // A <p> outside the list is not a descendant of #list.
        assert_equals(list.querySelectorAll("p").length, 0, "scope excludes non-descendants");
      }, "element.querySelectorAll is descendant-scoped");
    </script>`;
  const report = await runWptHtml(html);
  assert.equal(report.harnessError, null);
  assert.equal(report.passed, 2, JSON.stringify(report.subtests));
});

void test("WPT: Element.matches() and closest() reuse the selector engine", async () => {
  const html = `<script src="/resources/testharness.js"></script>
    <body><section class="card"><div id="inner" class="body"><span id="leaf">x</span></div></section></body>
    <script>
      test(function () {
        var inner = document.getElementById("inner");
        assert_true(inner.matches(".body"), "matches own class");
        assert_true(inner.matches("div.body"), "matches compound");
        assert_false(inner.matches(".card"), "does not match a non-applying selector");
      }, "Element.matches");

      test(function () {
        var leaf = document.getElementById("leaf");
        assert_equals(leaf.closest(".card").tagName, "SECTION", "closest walks up to the card");
        assert_equals(leaf.closest("#inner").getAttribute("id"), "inner", "closest finds nearer ancestor");
        assert_equals(leaf.closest("span"), leaf, "closest matches self first");
        assert_equals(leaf.closest(".nope"), null, "no ancestor matches → null");
      }, "Element.closest");
    </script>`;
  const report = await runWptHtml(html);
  assert.equal(report.harnessError, null);
  assert.equal(report.passed, 2, JSON.stringify(report.subtests));
});

void test("WPT: DOM traversal (parent/sibling/childElementCount/remove)", async () => {
  const html = `<script src="/resources/testharness.js"></script>
    <body><ul id="u"><li id="a">a</li><li id="b">b</li><li id="c">c</li></ul></body>
    <script>
      test(function () {
        var b = document.getElementById("b");
        assert_equals(b.parentElement.getAttribute("id"), "u", "parentElement");
        assert_equals(b.nextElementSibling.getAttribute("id"), "c", "nextElementSibling");
        assert_equals(b.previousElementSibling.getAttribute("id"), "a", "previousElementSibling");
        assert_equals(document.getElementById("a").previousElementSibling, null, "first has no prev");
      }, "parent + sibling traversal");

      test(function () {
        var u = document.getElementById("u");
        assert_equals(u.childElementCount, 3, "three element children");
        document.getElementById("b").remove();
        assert_equals(u.childElementCount, 2, "remove() detaches the node");
        assert_equals(document.getElementById("a").nextElementSibling.getAttribute("id"), "c", "siblings re-link");
      }, "childElementCount + remove()");
    </script>`;
  const report = await runWptHtml(html);
  assert.equal(report.harnessError, null);
  assert.equal(report.passed, 2, JSON.stringify(report.subtests));
});
