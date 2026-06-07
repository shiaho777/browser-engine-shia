/**
 * Tests for the WPT testharness-compatible runner (#3). Proves the engine can
 * EXECUTE genuine WPT-format testharness source (the real `test()` + `assert_*`
 * API) against its own live DOM, and scores PASS/FAIL exactly as the harness
 * would — the same shape that produces a browser's WPT conformance number.
 *
 * Built by `tsc` then run with: `node --test packages/cli/dist/*.test.js`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { runWptHarness } from "./wpt.js";

const HTML = '<html><body><div id="a" class="box" data-x="7">hi</div><span></span></body></html>';

void test("WPT: a passing testharness file scores all subtests PASS", () => {
  const source = `
    test(function () {
      var el = document.getElementById("a");
      assert_true(el !== null, "element found");
      assert_equals(el.getAttribute("data-x"), "7", "attribute read");
      assert_equals(el.tagName, "DIV", "tagName uppercased");
    }, "getElementById + attributes");

    test(function () {
      assert_equals(document.querySelector(".box").textContent, "hi");
    }, "querySelector by class");
  `;
  const report = runWptHarness(HTML, source);
  assert.equal(report.harnessError, null);
  assert.equal(report.subtests.length, 2);
  assert.equal(report.passed, 2);
  assert.equal(report.failed, 0);
});

void test("WPT: a failing assertion is reported as FAIL with a message (not thrown)", () => {
  const source = `
    test(function () {
      assert_equals(document.getElementById("a").getAttribute("data-x"), "9", "wrong value");
    }, "deliberately failing");
    test(function () { assert_true(true); }, "passing alongside");
  `;
  const report = runWptHarness(HTML, source);
  assert.equal(report.passed, 1);
  assert.equal(report.failed, 1);
  const failing = report.subtests.find((t) => t.name === "deliberately failing");
  assert.ok(failing !== undefined && failing.status === "FAIL");
  assert.match(failing.message ?? "", /wrong value/);
});

void test("WPT: a real DOM mutation driven by the script is observable to later assertions", () => {
  const source = `
    test(function () {
      var el = document.getElementById("a");
      el.setAttribute("data-x", "42");
      assert_equals(el.getAttribute("data-x"), "42", "mutation visible");
    }, "setAttribute round-trips through the live session");
  `;
  const report = runWptHarness(HTML, source);
  assert.equal(report.passed, 1, JSON.stringify(report.subtests));
});

void test("WPT: assert_array_equals + assert_throws_js behave like the real harness", () => {
  const source = `
    test(function () { assert_array_equals([1,2,3], [1,2,3]); }, "array equal");
    test(function () { assert_array_equals([1,2], [1,2,3]); }, "array unequal");
    test(function () { assert_throws_js(TypeError, function () { throw new TypeError("x"); }); }, "throws");
  `;
  const report = runWptHarness(HTML, source);
  assert.equal(report.subtests.find((t) => t.name === "array equal")?.status, "PASS");
  assert.equal(report.subtests.find((t) => t.name === "array unequal")?.status, "FAIL");
  assert.equal(report.subtests.find((t) => t.name === "throws")?.status, "PASS");
});
