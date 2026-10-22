/**
 * Content-Security-Policy — RFC 0027. Under test:
 *
 *   1. Parsing: `parseCspValue` multi-policy split / first-occurrence-wins;
 *      `cspFromHeaders` enforce + report-only; `cspFromMeta` `<meta
 *      http-equiv>` with the meta-forbidden directives stripped.
 *   2. Source matching: `'self'` (incl. the ws/wss same-site rule), `'none'`,
 *      `*`, scheme sources (`https:`, `data:`), host sources
 *      (`x.com`, `*.x.com`, `x.com:8443`, `x.com:*`), nonces, and
 *      `sha256-` hashes (with 'unsafe-inline' suppression + the attr-variant
 *      'unsafe-hashes' requirement).
 *   3. Fallback chains (`*-elem`/`-attr` → parent → default-src),
 *      `frame-ancestors` (navigation directive: no fallback), `report-uri`,
 *      `upgrade-insecure-requests`, `block-all-mixed-content`, `unsafe-eval`.
 *   4. Pipeline: `script-src` gates inline `<script>` (nonce/hash escape),
 *      injected dynamic scripts, `on*` handler attributes, and eval;
 *      `style-src-elem` gates `<style>`/`<link>`; `style-src-attr` suppresses
 *      `style=` at cascade time; `connect-src` gates guest fetch/XHR.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";

import type { DomTree, NodeId } from "@browser-engine/ir";
import { parseHtml } from "@browser-engine/html-parser";

import {
  CspContext,
  cspFromHeaders,
  cspFromMeta,
  cspHash,
  documentCsp,
  parseCspValue,
} from "./csp.js";
import { FineSession } from "./fine.js";
import { runScriptsOnSession } from "./event-loop.js";
import { buildDocumentApi } from "./script.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const DOC_URL = "https://example.com/dir/page.html";

function dom(html: string): DomTree {
  const parsed = parseHtml(enc(html));
  return { root: parsed.root, nodes: parsed.nodes } as DomTree;
}

function ctxOf(header: string, url = DOC_URL): CspContext {
  return new CspContext(cspFromHeaders({ "content-security-policy": header }), url);
}

function nodeByAttr(tree: DomTree, name: string, value: string): NodeId {
  for (const [id, node] of tree.nodes) {
    if (node.kind === "element" && node.attrs?.get(name) === value) return id;
  }
  throw new Error(`no element with ${name}=${value}`);
}

// ---------------------------------------------------------------------------
// 1. Parsing
// ---------------------------------------------------------------------------

void test("parseCspValue: directive list + multi-policy split + first-wins", () => {
  const [p] = parseCspValue("script-src 'self' https://cdn.example.com; img-src *", "header");
  assert.deepEqual(p?.directives.get("script-src"), ["'self'", "https://cdn.example.com"]);
  assert.deepEqual(p?.directives.get("img-src"), ["*"]);

  const two = parseCspValue("default-src 'self', script-src 'none'", "header");
  assert.equal(two.length, 2, "comma splits into two policies");

  const [dup] = parseCspValue("img-src 'self'; img-src 'none'", "header");
  assert.deepEqual(dup?.directives.get("img-src"), ["'self'"], "first directive wins");
});

void test("cspFromHeaders: enforce + report-only become two policies", () => {
  const policies = cspFromHeaders({
    "content-security-policy": "script-src 'self'",
    "content-security-policy-report-only": "img-src 'none'",
  });
  assert.equal(policies.length, 2);
  assert.equal(policies[0]?.reportOnly, false);
  assert.equal(policies[1]?.reportOnly, true);
});

void test("cspFromMeta: meta policy parsed; forbidden directives stripped", () => {
  const tree = dom(
    `<html><head><meta http-equiv="Content-Security-Policy" content="script-src 'none'; frame-ancestors 'none'; report-uri /r"></head><body></body></html>`,
  );
  const policies = cspFromMeta(tree);
  assert.equal(policies.length, 1);
  assert.equal(policies[0]?.source, "meta");
  assert.deepEqual(policies[0]?.directives.get("script-src"), ["'none'"]);
  assert.equal(policies[0]?.directives.has("frame-ancestors"), false, "meta cannot frame-ancestors");
  assert.equal(policies[0]?.directives.has("report-uri"), false, "meta cannot report-uri");
});

void test("documentCsp: headers + meta merge into one context", () => {
  const tree = dom(
    `<html><head><meta http-equiv="Content-Security-Policy" content="img-src 'self'"></head><body></body></html>`,
  );
  const csp = documentCsp(tree, DOC_URL, { "content-security-policy": "script-src 'self'" });
  assert.equal(csp.policies.length, 2);
  assert.equal(csp.check("img", "https://example.com/a.png").allowed, true, "meta policy allows same-origin img");
  assert.equal(csp.check("script", "https://evil.example/x.js").allowed, false, "header policy blocks cross-origin script");
});

// ---------------------------------------------------------------------------
// 2. Source matching
// ---------------------------------------------------------------------------

void test("'self': same-origin only; https doc admits wss on same host", () => {
  const csp = ctxOf("img-src 'self'");
  assert.equal(csp.check("img", "https://example.com/a.png").allowed, true);
  assert.equal(csp.check("img", "https://cdn.example.com/a.png").allowed, false);
  assert.equal(csp.check("img", "https://example.com:8443/a.png").allowed, false, "different port is not self");
  // ws/wss same-site rule (CSP3): an https document's 'self' covers wss:same-host.
  const cws = ctxOf("connect-src 'self'");
  assert.equal(cws.check("connect", "wss://example.com/socket").allowed, true);
  assert.equal(cws.check("connect", "ws://example.com/socket").allowed, false, "https doc does not self-match ws:");
});

void test("'none': blocks everything incl. self", () => {
  const csp = ctxOf("script-src 'none'");
  assert.equal(csp.check("script", "https://example.com/x.js").allowed, false);
  assert.equal(csp.check("script", DOC_URL).allowed, false);
});

void test("'*': any network URL, never data:/blob:", () => {
  const csp = ctxOf("img-src *");
  assert.equal(csp.check("img", "https://anything.example/x.png").allowed, true);
  assert.equal(csp.check("img", "data:image/png;base64,AAA").allowed, false, "data: needs an explicit source");
});

void test("scheme + host sources: https:, data:, hosts, wildcard hosts, ports", () => {
  const csp = ctxOf("img-src https: data:");
  assert.equal(csp.check("img", "https://x.example/a.png").allowed, true);
  assert.equal(csp.check("img", "http://x.example/a.png").allowed, false, "https: does not admit http:");
  assert.equal(csp.check("img", "data:image/png;base64,AAA").allowed, true);

  const host = ctxOf("script-src https://cdn.example.com *.subs.example.com assets.example.com:8443");
  assert.equal(host.check("script", "https://cdn.example.com/a.js").allowed, true);
  assert.equal(host.check("script", "https://x.subs.example.com/a.js").allowed, true);
  // CSP3 §match-hosts: `*.h` covers subdomains AND the apex itself.
  assert.equal(host.check("script", "https://subs.example.com/a.js").allowed, true, "*.h covers the apex");
  assert.equal(host.check("script", "https://assets.example.com/a.js").allowed, false, "port restriction blocks default port");
  assert.equal(host.check("script", "https://assets.example.com:8443/a.js").allowed, true);
});

void test("nonce and hash sources unblock inline blocks; attr needs unsafe-hashes", () => {
  const csp = ctxOf("script-src 'nonce-abc' 'sha256-x'");
  assert.equal(
    csp.checkInline("script", { nonce: "abc" }, "elem").allowed,
    true,
    "matching nonce unblocks element",
  );
  assert.equal(
    csp.checkInline("script", { nonce: "zzz" }, "elem").allowed,
    false,
    "wrong nonce stays blocked",
  );
  // attr-variant: nonces never apply to on*= handlers / style= attributes.
  assert.equal(
    csp.checkInline("script", { nonce: "abc" }, "attr").allowed,
    false,
    "nonce does not apply to attribute blocks",
  );

  const hash = cspHash("sha256", "alert(1)");
  const hcsp = ctxOf(`script-src 'sha256-${hash}'`);
  assert.equal(
    hcsp.checkInline("script", { text: "alert(1)" }, "elem").allowed,
    true,
    "matching sha256 unblocks",
  );
  assert.equal(hcsp.checkInline("script", { text: "alert(2)" }, "elem").allowed, false);
  // attr-variant hashes additionally need 'unsafe-hashes'.
  assert.equal(
    hcsp.checkInline("script", { text: "alert(1)" }, "attr").allowed,
    false,
    "attr hash needs 'unsafe-hashes'",
  );
  const hattr = ctxOf(`script-src 'unsafe-hashes' 'sha256-${hash}'`);
  assert.equal(hattr.checkInline("script", { text: "alert(1)" }, "attr").allowed, true);
});

void test("'unsafe-inline' is suppressed when a nonce/hash source shares the list", () => {
  const csp = ctxOf("script-src 'unsafe-inline' 'nonce-abc'");
  assert.equal(
    csp.checkInline("script", { text: "x()" }, "elem").allowed,
    false,
    "unsafe-inline inert next to nonce sources",
  );
  const plain = ctxOf("script-src 'unsafe-inline'");
  assert.equal(plain.checkInline("script", { text: "x()" }, "elem").allowed, true);
});

// ---------------------------------------------------------------------------
// 3. Fallback chains + navigation/reporting/upgrade directives
// ---------------------------------------------------------------------------

void test("fallback: -elem → -src → default-src; per-directive independence", () => {
  const csp = ctxOf("default-src 'none'; script-src 'self'");
  assert.equal(csp.check("img", "https://x.example/a.png").allowed, false, "img-src falls to default-src 'none'");
  assert.equal(csp.check("script", "https://example.com/a.js").allowed, true, "script-src overrides default-src");

  const elem = ctxOf("default-src 'none'; script-src 'self'; script-src-elem 'nonce-n1'");
  // -elem has its own list (nonce only) — 'self' does NOT fall through.
  assert.equal(
    elem.checkInline("script", { nonce: "n1" }, "elem").allowed,
    true,
  );
  assert.equal(
    elem.check("script", "https://example.com/a.js", "elem").allowed,
    false,
    "script-src-elem shadows script-src for element checks",
  );
  // …but a non-element script fetch (module import) still uses script-src.
  assert.equal(
    elem.check("script", "https://example.com/a.js").allowed,
    true,
    "plain script checks still resolve to script-src",
  );
});

void test("frame-ancestors: self/none/hosts; no default-src fallback", () => {
  const deny = ctxOf("frame-ancestors 'none'");
  assert.equal(deny.checkAncestors(["https://example.com"]), false);

  const selfOnly = ctxOf("frame-ancestors 'self'");
  assert.equal(selfOnly.checkAncestors(["https://example.com"]), true, "same-origin ancestor ok");
  assert.equal(selfOnly.checkAncestors(["https://evil.example"]), false);

  const listed = ctxOf("frame-ancestors https://parent.example");
  assert.equal(listed.checkAncestors(["https://parent.example"]), true);
  assert.equal(listed.checkAncestors(["https://parent.example", "https://stray.example"]), false,
    "EVERY ancestor must match a source");

  const noFallback = ctxOf("default-src 'none'");
  assert.equal(noFallback.checkAncestors(["https://anywhere.example"]), true,
    "frame-ancestors absent ⇒ unrestricted (no default-src fallback)");
});

void test("report-uri endpoints collect across policies", () => {
  const csp = new CspContext(
    cspFromHeaders({
      "content-security-policy": "script-src 'none'; report-uri /csp-a",
      "content-security-policy-report-only": "img-src 'none'; report-uri /csp-b",
    }),
    DOC_URL,
  );
  assert.deepEqual(csp.reportEndpoints(), ["/csp-a", "/csp-b"]);
  const v = csp.check("script", "https://x.example/a.js").violations[0]!;
  const body = JSON.parse(csp.reportBody(v)) as { "csp-report": Record<string, string> };
  assert.equal(body["csp-report"]["violated-directive"], "script-src");
  assert.equal(body["csp-report"]["document-uri"], DOC_URL);
});

void test("upgrade-insecure-requests rewrites http subresources; mixed-content blocks", () => {
  const up = ctxOf("upgrade-insecure-requests");
  assert.equal(up.gateSubresourceUrl("http://cdn.example.com/a.png").url, "https://cdn.example.com/a.png");
  assert.equal(up.gateSubresourceUrl("https://cdn.example.com/a.png").url, "https://cdn.example.com/a.png");
  const httpDoc = new CspContext(parseCspValue("upgrade-insecure-requests", "header"), "http://insecure.example/p");
  assert.equal(httpDoc.upgradeInsecure, false, "upgrade only applies to secure documents");

  const mixed = ctxOf("block-all-mixed-content");
  const gate = mixed.gateSubresourceUrl("http://cdn.example.com/a.png");
  assert.equal(gate.blocked, true);
  assert.equal(mixed.violations.length, 1);
});

void test("allowsEval: script-src without 'unsafe-eval' bans it; absent policy allows", () => {
  assert.equal(ctxOf("script-src 'self'").allowsEval, false);
  assert.equal(ctxOf("script-src 'self' 'unsafe-eval'").allowsEval, true);
  assert.equal(new CspContext([], DOC_URL).allowsEval, true, "no policy ⇒ eval allowed");
  // report-only must not enforce.
  const ro = new CspContext(
    cspFromHeaders({ "content-security-policy-report-only": "script-src 'none'" }),
    DOC_URL,
  );
  assert.equal(ro.allowsEval, true, "report-only does not enforce");
});

void test("report-only records violations without blocking", () => {
  const csp = new CspContext(
    cspFromHeaders({ "content-security-policy-report-only": "img-src 'self'" }),
    DOC_URL,
  );
  const verdict = csp.check("img", "https://evil.example/a.png");
  assert.equal(verdict.allowed, true, "report-only never blocks");
  assert.equal(verdict.violations.length, 1);
  assert.equal(verdict.violations[0]?.disposition, "report");
});

// ---------------------------------------------------------------------------
// 4. Pipeline: session-level enforcement
// ---------------------------------------------------------------------------

void test("style-src-attr: style= declarations suppressed at cascade time", () => {
  const RED = { r: 255, g: 0, b: 0, a: 1 };
  const html = `<html><body><div id="a" style="color: rgb(255, 0, 0)">x</div></body></html>`;
  const session = new FineSession(html, DOC_URL, {
    csp: ctxOf("style-src 'self'"),
  });
  const id = nodeByAttr(session.dom, "id", "a");
  assert.notDeepEqual(
    session.computed(id)["color"],
    RED,
    "inline style contributes nothing",
  );

  const allowed = new FineSession(html, DOC_URL, { csp: ctxOf("style-src 'unsafe-inline'") });
  assert.deepEqual(
    allowed.computed(id)["color"],
    RED,
    "'unsafe-inline' keeps the attribute style",
  );
});

void test("script-src-attr: on* handler attributes never compile", () => {
  const session = new FineSession(
    `<html><body><button id="b" onclick="__hit=1"></button></body></html>`,
    DOC_URL,
    { csp: ctxOf("script-src 'none'") },
  );
  // Inline handlers compile through the injected compiler (same wiring the
  // WPT harness uses); the dispatch path consults CSP before compiling.
  const sandbox: Record<string, unknown> = {};
  const vmCtx = vm.createContext(sandbox);
  const { document } = buildDocumentApi(session, {
    inlineHandlerCompiler: (body): unknown =>
      vm.runInContext(`(function (event) {\n${body}\n})`, vmCtx),
  });
  sandbox["document"] = document;
  const btn = (document as { getElementById: (id: string) => unknown }).getElementById("b") as {
    dispatchEvent: (e: unknown) => boolean;
  };
  btn.dispatchEvent({ type: "click" });
  assert.equal(sandbox["__hit"], undefined, "handler attribute was blocked");
  assert.equal(
    session.csp?.violations.some((v) => v.directive === "script-src-attr"),
    true,
  );
});

void test("unsafe-eval: eval()/Function() throw EvalError under script-src", () => {
  const session = new FineSession(`<html><body></body></html>`, DOC_URL, {
    csp: ctxOf("script-src 'self'"),
  });
  const r = runScriptsOnSession(session, [
    `try { eval("1") } catch (e) { __kind = e instanceof EvalError ? "EvalError" : String(e); }
     try { new Function("1")() } catch (e) { __fn = e instanceof EvalError ? "EvalError" : String(e); }`,
  ]);
  const sandbox = r.sandbox as Record<string, unknown>;
  assert.equal(sandbox["__kind"], "EvalError");
  assert.equal(sandbox["__fn"], "EvalError");
});

void test("connect-src: guest fetch() to a refused origin stays unresolved", () => {
  const session = new FineSession(`<html><body></body></html>`, DOC_URL, {
    csp: ctxOf("connect-src 'self'"),
  });
  const r = runScriptsOnSession(session, [
    `fetch("https://api.evil.example/x").then(() => { __hit = 1; }).catch(() => { __hit = "blocked"; });`,
    `fetch("https://example.com/ok").then(() => { __ok = 1; });`,
  ], new Map([["https://example.com/ok", "hi"]]));
  r.drain?.();
  const sandbox = r.sandbox as Record<string, unknown>;
  assert.equal(sandbox["__hit"], "blocked", "connect-src refused the cross-origin fetch");
  assert.equal(sandbox["__ok"], 1, "same-origin fetch still served");
});
