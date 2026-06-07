/**
 * Tests for `@font-face` web-font loading and application (task 7.8; design.md
 * §11; Requirements 16.6, 8.1).
 *
 * Built by `tsc` then run with: `node --test packages/guest/dist/*.test.js`.
 *
 * These prove the three stages of Requirement 16.6:
 *   - PARSE: `@font-face` rules are extracted from CSS text (family + url src +
 *     weight/style), and unusable blocks (no family / no url() src) are skipped;
 *   - LOAD: each face's bytes are downloaded through the SAME reused networking
 *     stack guest fetch uses (Requirement 8.1) — a deterministic in-memory stack
 *     stands in for the network here;
 *   - APPLY: a loaded face is registered under its family (+ weight/style) so a
 *     `font-family` lookup resolves to the downloaded bytes.
 *
 * Loud-failure behaviour (design.md §12): a face that fails to download rejects,
 * and an unresolvable `src` throws NotImplemented — never a silent fallback.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { isNotImplemented } from "@browser-engine/ir";

import {
  FontRegistry,
  loadFontFaces,
  parseFontFaceRules,
  loadFontFace,
} from "./font-face.js";
import type { NetworkRequest, NetworkResponse, NetworkStack } from "./network.js";

/** A deterministic in-memory stack returning canned font bytes by URL. */
function fontStack(routes: Record<string, Uint8Array>): NetworkStack & { calls: NetworkRequest[] } {
  const calls: NetworkRequest[] = [];
  return {
    calls,
    request(req: NetworkRequest): Promise<NetworkResponse> {
      calls.push(req);
      const bytes = routes[req.url];
      if (bytes === undefined) {
        return Promise.resolve({ status: 404, ok: false, headers: {}, body: new Uint8Array() });
      }
      return Promise.resolve({
        status: 200,
        ok: true,
        headers: { "content-type": "font/woff2" },
        body: bytes,
      });
    },
  };
}

/** Fake font bytes (a recognisable marker; the engine never parses these here). */
const FONT_BYTES = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 1, 2, 3, 4]); // "wOF2"...

// ---------------------------------------------------------------------------
// PARSE
// ---------------------------------------------------------------------------

void test("parseFontFaceRules extracts family + url src (Req 16.6)", () => {
  const css = `
    @font-face {
      font-family: "Inter";
      src: url("https://fonts.example.com/inter.woff2") format("woff2");
      font-weight: 700;
      font-style: italic;
    }
  `;
  const rules = parseFontFaceRules(css);
  assert.equal(rules.length, 1);
  assert.equal(rules[0]!.family, "Inter");
  assert.equal(rules[0]!.src, "https://fonts.example.com/inter.woff2");
  assert.equal(rules[0]!.weight, "700");
  assert.equal(rules[0]!.style, "italic");
});

void test("parseFontFaceRules defaults weight/style to normal when absent", () => {
  const css = `@font-face { font-family: Roboto; src: url(https://f.example.com/r.woff2); }`;
  const rules = parseFontFaceRules(css);
  assert.equal(rules.length, 1);
  assert.equal(rules[0]!.family, "Roboto");
  assert.equal(rules[0]!.weight, "normal");
  assert.equal(rules[0]!.style, "normal");
});

void test("parseFontFaceRules extracts multiple faces in declaration order", () => {
  const css = `
    @font-face { font-family: "A"; src: url(https://f/a.woff2); }
    body { color: red }
    @font-face { font-family: "B"; src: url(https://f/b.woff2); }
  `;
  const rules = parseFontFaceRules(css);
  assert.deepEqual(rules.map((r) => r.family), ["A", "B"]);
});

void test("parseFontFaceRules skips unusable blocks (no family, or no url() src)", () => {
  const css = `
    @font-face { src: url(https://f/x.woff2); }            /* no family */
    @font-face { font-family: "LocalOnly"; src: local("X"); } /* no url() */
    @font-face { font-family: "Good"; src: url(https://f/g.woff2); }
  `;
  const rules = parseFontFaceRules(css);
  assert.deepEqual(rules.map((r) => r.family), ["Good"]);
});

// ---------------------------------------------------------------------------
// LOAD + APPLY
// ---------------------------------------------------------------------------

void test("Req 16.6/8.1: loadFontFaces downloads through the reused stack and applies the face", async () => {
  const css = `@font-face { font-family: "Inter"; src: url(https://fonts.example.com/inter.woff2); }`;
  const stack = fontStack({ "https://fonts.example.com/inter.woff2": FONT_BYTES });
  const registry = new FontRegistry();

  const loaded = await loadFontFaces(css, stack, registry);

  // Downloaded through the SAME reused networking stack.
  assert.equal(stack.calls.length, 1);
  assert.equal(stack.calls[0]!.url, "https://fonts.example.com/inter.woff2");
  // The face is loaded with its real bytes.
  assert.equal(loaded.length, 1);
  assert.deepEqual(loaded[0]!.data, FONT_BYTES);
  // …and APPLIED: a family lookup resolves to the downloaded face.
  assert.equal(registry.has("Inter"), true);
  const resolved = registry.resolve("Inter");
  assert.deepEqual(resolved?.data, FONT_BYTES);
});

void test("Req 16.6: an applied face is resolvable by family + weight + style", async () => {
  const css = `@font-face { font-family: "Inter"; src: url(https://f/i.woff2); font-weight: 700; }`;
  const stack = fontStack({ "https://f/i.woff2": FONT_BYTES });
  const registry = new FontRegistry();
  await loadFontFaces(css, stack, registry);

  // Exact weight/style match resolves; a mismatched weight does not.
  assert.ok(registry.resolve("Inter", "700", "normal"));
  assert.equal(registry.resolve("Inter", "400", "normal"), undefined);
  // Family match is case-insensitive (CSS folds family names).
  assert.ok(registry.resolve("inter", "700", "normal"));
});

void test("Req 16.6: relative @font-face src resolves against a base URL", async () => {
  const css = `@font-face { font-family: "Rel"; src: url(fonts/rel.woff2); }`;
  const stack = fontStack({ "https://site.example.com/assets/fonts/rel.woff2": FONT_BYTES });
  const registry = new FontRegistry();
  await loadFontFaces(css, stack, registry, "https://site.example.com/assets/page.css");
  assert.equal(stack.calls[0]!.url, "https://site.example.com/assets/fonts/rel.woff2");
  assert.ok(registry.has("Rel"));
});

void test("multiple faces all download and apply", async () => {
  const css = `
    @font-face { font-family: "A"; src: url(https://f/a.woff2); }
    @font-face { font-family: "B"; src: url(https://f/b.woff2); }
  `;
  const stack = fontStack({
    "https://f/a.woff2": new Uint8Array([1]),
    "https://f/b.woff2": new Uint8Array([2]),
  });
  const registry = new FontRegistry();
  const loaded = await loadFontFaces(css, stack, registry);
  assert.equal(loaded.length, 2);
  assert.equal(registry.size, 2);
  assert.ok(registry.has("A"));
  assert.ok(registry.has("B"));
});

// ---------------------------------------------------------------------------
// Loud failures (design.md §12): no silent fallback substitution.
// ---------------------------------------------------------------------------

void test("a failed font download rejects loudly (never silently falls back)", async () => {
  const css = `@font-face { font-family: "Missing"; src: url(https://f/missing.woff2); }`;
  const stack = fontStack({}); // every URL 404s.
  const registry = new FontRegistry();
  await assert.rejects(() => loadFontFaces(css, stack, registry), /failed to load/);
  // Nothing was applied — no fabricated fallback face.
  assert.equal(registry.size, 0);
  assert.equal(registry.has("Missing"), false);
});

void test("an unresolvable src (no base URL for a relative path) throws NotImplemented", async () => {
  const stack = fontStack({});
  await assert.rejects(
    () => loadFontFace({ family: "X", src: "fonts/x.woff2", weight: "normal", style: "normal" }, stack),
    (error: unknown) => isNotImplemented(error),
  );
});

void test("resolve returns undefined for an unregistered family (caller falls back, not us)", () => {
  const registry = new FontRegistry();
  assert.equal(registry.resolve("NeverLoaded"), undefined);
  assert.equal(registry.has("NeverLoaded"), false);
});
