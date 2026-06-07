/**
 * Tests for quirks-mode DOCTYPE detection (task 9.4; design.md §5 Phase 8+;
 * Requirement 17.4 — "THE Engine SHALL support quirks-mode parsing").
 *
 * Built by `tsc` then run with: `node --test packages/html-parser/dist/*.test.js`.
 *
 * The parser's document-mode determination (HTML §13.2.6.1, a pragmatic subset)
 * is what drives quirks-mode LAYOUT (verified in the layout package). These
 * assert the parse-side classification:
 *   - NO DOCTYPE ⇒ quirks;
 *   - `<!DOCTYPE html>` ⇒ no-quirks (standards);
 *   - legacy transitional/frameset public id + system id ⇒ limited-quirks;
 *   - older / system-only / public-only legacy DOCTYPEs ⇒ quirks.
 * Detection never disturbs the produced DomTree (parsing is unaffected).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { detectDocumentMode, parseHtml, parseHtmlWithMetrics } from "./index.js";

const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

void test("Req 17.4: a document with NO DOCTYPE is quirks mode", () => {
  assert.equal(detectDocumentMode(encode("<div>hello</div>")), "quirks");
  assert.equal(detectDocumentMode(encode("<html><body>x</body></html>")), "quirks");
});

void test("Req 17.4: <!DOCTYPE html> is no-quirks (standards) mode", () => {
  assert.equal(detectDocumentMode(encode("<!DOCTYPE html><div>x</div>")), "no-quirks");
  // Case-insensitive DOCTYPE keyword + name.
  assert.equal(detectDocumentMode(encode("<!doctype HTML><p>x</p>")), "no-quirks");
});

void test("Req 17.4: a legacy HTML 3.2 public DOCTYPE is quirks mode", () => {
  const html = '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 3.2 Final//EN"><div>x</div>';
  assert.equal(detectDocumentMode(encode(html)), "quirks");
});

void test("Req 17.4: HTML4 transitional WITH a system id is limited-quirks", () => {
  const html =
    '<!DOCTYPE HTML PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" ' +
    '"http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd"><div>x</div>';
  assert.equal(detectDocumentMode(encode(html)), "limited-quirks");
});

void test("Req 17.4: XHTML 1.0 frameset WITH a system id is limited-quirks", () => {
  const html =
    '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Frameset//EN" ' +
    '"http://www.w3.org/TR/xhtml1/DTD/xhtml1-frameset.dtd"><div>x</div>';
  assert.equal(detectDocumentMode(encode(html)), "limited-quirks");
});

void test("Req 17.4: a transitional public id WITHOUT a system id is full quirks", () => {
  // Same public id but no system identifier ⇒ full quirks (not limited).
  const html = '<!DOCTYPE HTML PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN"><div>x</div>';
  assert.equal(detectDocumentMode(encode(html)), "quirks");
});

void test("Req 17.4: a bare <!DOCTYPE> with no name is quirks", () => {
  assert.equal(detectDocumentMode(encode("<!DOCTYPE><div>x</div>")), "quirks");
});

void test("parseHtmlWithMetrics surfaces the mode alongside the tree and recoveries", () => {
  const result = parseHtmlWithMetrics(encode("<!DOCTYPE html><div>hi</div>"));
  assert.equal(result.mode, "no-quirks");
  assert.ok(result.tree.nodes.size > 0);
  assert.deepEqual(result.recoveries, []);
});

void test("quirks detection does not disturb the produced DomTree", () => {
  // The same markup with and without a DOCTYPE produces the same element shape
  // (the DOCTYPE emits no node) — only the mode differs.
  const withDoctype = parseHtml(encode("<!DOCTYPE html><div>hello</div>"));
  const withoutDoctype = parseHtml(encode("<div>hello</div>"));
  // Both have document → div → text "hello" (3 nodes); DOCTYPE adds no node.
  assert.equal(withDoctype.nodes.size, withoutDoctype.nodes.size);
});
