import assert from "node:assert/strict";
import test from "node:test";

import { parseHtml } from "@browser-engine/html-parser";

import { bootFineSession, collectDocumentScripts } from "./engine-runtime.js";
import { LIVE_HTML } from "./home.js";

void test("collectDocumentScripts finds inline scripts", () => {
  const html = "<html><body><script>var a=1</script><script src='x.js'></script></body></html>";
  const dom = parseHtml(new TextEncoder().encode(html));
  const collected = collectDocumentScripts(dom, "https://example.test/");
  assert.equal(collected.sources.length, 1);
  assert.equal(collected.externalUrls.length, 1);
  assert.match(collected.externalUrls[0]!, /x\.js$/);
});

void test("bootFineSession runs live page scripts", async () => {
  const { session, scripts } = await bootFineSession(LIVE_HTML, "engine://live");
  assert.ok(scripts.scripts >= 1);
  assert.ok(scripts.mutations >= 1);
  assert.equal(scripts.error, null);
  assert.ok(session.dom.nodes.size > 5);
});
