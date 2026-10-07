/**
 * D2 tests — HTML §4.12.1 script execution semantics: defer/async phases,
 * document-order assembly, and the load event on external script elements.
 *
 * The old assembly ran EVERY inline script before EVERY external one (breaking
 * cross-source ordering) and ignored defer/async entirely. These tests pin the
 * corrected behavior: one document-order list, three execution phases,
 * DCL after defer.
 *
 * Execution order is observed through the DOM: each script APPENDS its label to
 * a data attribute on <body>, and the test reads the attribute after boot.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { parseHtml } from "@browser-engine/html-parser";

import { bootFineSession, collectDocumentScripts } from "./engine-runtime.js";

/** A script body that appends `label` to body[data-order]. */
const log = (label: string): string =>
  `document.body.setAttribute("data-order", ((document.body.getAttribute("data-order") || "") + " " + ${JSON.stringify(label)}).trim());`;

/** Build a page with mixed-phase scripts + the fetch map for externals. */
function orderPage(): { readonly html: string; readonly fetches: Map<string, string> } {
  const fetches = new Map<string, string>();
  const html = [
    "<html><body>",
    `<script>${log("inline-1")}</script>`,
    "<script src='ext-blocking.js'></script>",
    `<script>${log("inline-2")}</script>`,
    "<script src='ext-defer.js' defer></script>",
    `<script>${log("inline-3")}</script>`,
    "<script src='ext-async.js' async></script>",
    "</body></html>",
  ].join("");
  fetches.set("https://example.test/ext-blocking.js", log("ext-blocking"));
  fetches.set("https://example.test/ext-defer.js", log("ext-defer"));
  fetches.set("https://example.test/ext-async.js", log("ext-async"));
  return { html, fetches };
}

/** Boot `page` and read body[data-order] — the scripts' execution order. */
async function bootOrder(
  page: { readonly html: string; readonly fetches: ReadonlyMap<string, string> },
): Promise<{ order: string; error: string | null }> {
  const { session, scripts } = await bootFineSession(page.html, "https://example.test/", {
    fetchFn: async (url) => {
      const body = page.fetches.get(url);
      return Promise.resolve(body === undefined ? undefined : new TextEncoder().encode(body));
    },
  });
  const body = [...session.dom.nodes.values()].find((n) => n.tag === "body");
  return { order: body?.attrs?.get("data-order") ?? "", error: scripts.error };
}

void test("collectDocumentScripts classifies defer and async external scripts", () => {
  const html = [
    "<html><body>",
    "<script src='a.js'></script>",
    "<script src='b.js' defer></script>",
    "<script src='c.js' async></script>",
    "<script src='d.js' defer async></script>",
    "</body></html>",
  ].join("");
  const dom = parseHtml(new TextEncoder().encode(html));
  const collected = collectDocumentScripts(dom, "https://example.test/");
  assert.equal(collected.records.length, 4);
  assert.equal(collected.records[0]?.defer, false);
  assert.equal(collected.records[0]?.async, false);
  assert.equal(collected.records[1]?.defer, true);
  assert.equal(collected.records[1]?.async, false);
  assert.equal(collected.records[2]?.defer, false);
  assert.equal(collected.records[2]?.async, true);
  // async wins when both flags are present (HTML: async takes precedence).
  assert.equal(collected.records[3]?.defer, false);
  assert.equal(collected.records[3]?.async, true);
});

void test("collectDocumentScripts: inline scripts are always blocking (flags ignored)", () => {
  const html = "<html><body><script defer>var a=1</script></body></html>";
  const dom = parseHtml(new TextEncoder().encode(html));
  const collected = collectDocumentScripts(dom, "https://example.test/");
  assert.equal(collected.records.length, 1);
  assert.equal(collected.records[0]?.inline, true);
  assert.equal(collected.records[0]?.defer, false);
  assert.equal(collected.records[0]?.async, false);
});

void test("scripts execute in document order within phases: blocking → defer → async", async () => {
  const { order, error } = await bootOrder(orderPage());
  assert.equal(error, null, "no script errors");
  // All three blocking scripts run first in DOCUMENT order (interleaved
  // inline/external — the old inline-first bug would put all inline first),
  // then the defer script, then the async script.
  assert.equal(
    order,
    "inline-1 ext-blocking inline-2 inline-3 ext-defer ext-async",
    `execution order was: ${order}`,
  );
});

void test("document-order assembly: external runs between its inline neighbors", async () => {
  const page = {
    html: [
      "<html><body>",
      `<script>${log("first")}</script>`,
      "<script src='mid.js'></script>",
      `<script>${log("third")}</script>`,
      "</body></html>",
    ].join(""),
    fetches: new Map([["https://example.test/mid.js", log("mid")]]),
  };
  const { order, error } = await bootOrder(page);
  assert.equal(error, null);
  assert.equal(order, "first mid third", `execution order was: ${order}`);
});

void test("defer scripts run before DOMContentLoaded", async () => {
  const page = {
    html: [
      "<html><body>",
      "<script src='deferred.js' defer></script>",
      `<script>`,
      `document.addEventListener("DOMContentLoaded", function () { ${log("dcl")} });`,
      `</script>`,
      "</body></html>",
    ].join(""),
    fetches: new Map([
      ["https://example.test/deferred.js", log("deferred")],
    ]),
  };
  const { order, error } = await bootOrder(page);
  assert.equal(error, null);
  assert.equal(order, "deferred dcl", "defer script must run before DCL fires");
});

void test("failed external script never runs and does not break the rest", async () => {
  const page = {
    html: [
      "<html><body>",
      `<script>${log("one")}</script>`,
      "<script src='missing.js'></script>",
      `<script>${log("two")}</script>`,
      "</body></html>",
    ].join(""),
    fetches: new Map<string, string>(),
  };
  const { order, error } = await bootOrder(page);
  assert.equal(error, null, "a failed fetch is not a guest error");
  assert.equal(order, "one two");
});

void test("static external scripts fire their load event after execution", async () => {
  const page = {
    html: [
      "<html><body>",
      "<script src='loaded.js'></script>",
      `<script id='after'>${log("after")}</script>`,
      "</body></html>",
    ].join(""),
    fetches: new Map([
      // The external script attaches its own load listener: it must fire
      // AFTER the script body ran (handler sees the side effect).
      ["https://example.test/loaded.js",
        "window.sideEffect = 1;\ndocument.currentScript.addEventListener('load', function () { if (window.sideEffect === 1) { document.body.setAttribute('data-order', 'load-fired'); } });"],
    ]),
  };
  const { session, scripts } = await bootFineSession(page.html, "https://example.test/", {
    fetchFn: async (url) => {
      const body = page.fetches.get(url);
      return Promise.resolve(body === undefined ? undefined : new TextEncoder().encode(body));
    },
  });
  assert.equal(scripts.error, null);
  const body = [...session.dom.nodes.values()].find((n) => n.tag === "body");
  assert.equal(
    body?.attrs?.get("data-order"),
    "load-fired after",
    "script load event fired after execution (before the next inline script)",
  );
});
