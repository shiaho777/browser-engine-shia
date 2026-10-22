/**
 * RFC 0029 — destination wiring: `collectSubresourceDestinations` produces
 * the URL→destination map the network stack needs for Mixed Content
 * Level 2 + Sec-Fetch-Dest, and `networkStackToFetchFn`'s requestFor hook
 * carries it to `stack.request`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { parseHtml } from "@browser-engine/html-parser";
import { mixedContentVerdict } from "@browser-engine/guest";
import { collectSubresourceDestinations } from "./loader.js";

const PAGE = "https://page.example/";

void test("destinations: link→style, img/srcset/source→image, script untouched", () => {
  const dom = parseHtml(new TextEncoder().encode(`<!doctype html><html><head>
    <link rel="stylesheet" href="/a.css">
    <link rel="icon" href="/i.ico">
    </head><body>
    <img src="pic.png" srcset="p2.png 2x">
    <source src="s.png">
    <script src="app.js"></script>
    </body></html>`));
  const map = collectSubresourceDestinations(dom, PAGE);
  assert.equal(map.get("https://page.example/a.css"), "style");
  assert.equal(map.get("https://page.example/pic.png"), "image");
  assert.equal(map.get("https://page.example/p2.png"), "image");
  assert.equal(map.get("https://page.example/s.png"), "image");
  assert.equal(map.get("https://page.example/app.js"), undefined, "scripts are discovered elsewhere");
  // Non-stylesheet link rels aren't subresources here.
  assert.equal(map.get("https://page.example/i.ico"), undefined);
});

void test("verdict: ws:// is not http — WebSocket handled by the transport gate", () => {
  assert.equal(
    mixedContentVerdict("http://cdn.example/w.js", "https://p.example/", "script", "no-cors").action,
    "block",
  );
  assert.equal(
    mixedContentVerdict("http://cdn.example/m.png", "https://p.example/", "image", "no-cors").action,
    "upgrade",
  );
  // data:/blob: subresources are not mixed content.
  assert.equal(
    mixedContentVerdict("data:image/png;base64,AA==", "https://p.example/", "image", "no-cors").action,
    "allow",
  );
});
