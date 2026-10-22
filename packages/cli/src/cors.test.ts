/**
 * RFC 0028 — loop-level CORS semantics: `same-origin` rejects before the
 * wire on every transport; `no-cors` fetches resolve as opaque responses
 * on the virtual transport (the real stack adds ACAO/preflight machinery).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { FineSession } from "./fine.js";
import { runScriptsOnSession } from "./event-loop.js";

const DOC_URL = "https://example.com/page";

void test("same-origin mode: cross-origin fetch rejects before the wire", () => {
  const session = new FineSession(`<html><body></body></html>`, DOC_URL);
  const r = runScriptsOnSession(session, [
    `fetch("https://api.evil.example/x", { mode: "same-origin" })
       .then(() => { __r = "resolved"; })
       .catch((e) => { __r = e instanceof TypeError ? "typeerror" : "other"; });`,
    `fetch("https://example.com/ok", { mode: "same-origin" }).then((r2) => { __ok = r2.status; });`,
  ], new Map([["https://example.com/ok", "hi"]]));
  r.drain?.();
  const sandbox = r.sandbox as Record<string, unknown>;
  assert.equal(sandbox["__r"], "typeerror", "same-origin cross-origin rejects TypeError");
  assert.equal(sandbox["__ok"], 200, "same-origin fetch still served");
});

void test("no-cors fetch resolves as an opaque response", () => {
  const session = new FineSession(`<html><body></body></html>`, DOC_URL);
  const r = runScriptsOnSession(session, [
    `fetch("https://cdn.evil.example/lib.js", { mode: "no-cors" })
       .then((res) => { __t = res.type; __s = res.status; __ok = res.ok; });`,
  ], new Map([["https://cdn.evil.example/lib.js", "alert(1)"]]));
  r.drain?.();
  const sandbox = r.sandbox as Record<string, unknown>;
  assert.equal(sandbox["__t"], "opaque", "type is opaque");
  assert.equal(sandbox["__s"], 0, "opaque status is 0");
  assert.equal(sandbox["__ok"], false, "opaque is never ok");
});
