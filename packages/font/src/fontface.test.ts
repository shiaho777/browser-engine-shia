/**
 * RFC 0006 evidence: `@font-face` descriptor parsing (`src` source lists,
 * `local()`/`url()`/`format()`), scope-isolated registry resolution,
 * `findLocal` name matching, weight-range scoring, and the WOFF unwrapping
 * round-trip on compiled fixtures.
 */
import { deflateSync } from "node:zlib";
import test from "node:test";
import assert from "node:assert/strict";

import { compileTrueType, type CompileFont } from "./compile.js";
import {
  collectFontFaceDescriptors,
  faceFromSourceBytes,
  fontFaceFormatSupported,
  parseFontFaceRule,
} from "./fontface.js";
import { isWoff, unwrapWoff } from "./woff.js";
import { FontRegistry } from "./registry.js";
import { parseTrueType } from "./truetype.js";

function fixtureFace(family: string, weightClass?: number): CompileFont {
  return {
    unitsPerEm: 1000,
    ascent: 800,
    descent: -200,
    glyphs: [
      { contours: [], advanceWidth: 600 },
      { contours: [], advanceWidth: 512 },
    ],
    cmap: new Map([[0x61, 1]]),
    names: { family },
    ...(weightClass !== undefined ? { os2: { weightClass } } : {}),
  };
}

const decl = (property: string, value: string) => ({ property, value, important: false });

// ---------------------------------------------------------------------------
// Descriptor parsing.
// ---------------------------------------------------------------------------

void test("parseFontFaceRule: url + format + local sources, weight range", () => {
  const d = parseFontFaceRule([
    decl("font-family", "'My Webfont'"),
    decl("src", "local('System Font'), url(fonts/my.woff) format('woff'), url(fallback.ttf)"),
    decl("font-weight", "100 900"),
    decl("font-style", "italic"),
    decl("font-stretch", "condensed"),
  ]);
  assert.ok(d !== null);
  assert.equal(d.family, "my webfont");
  assert.deepEqual(
    d.sources,
    [
      { kind: "local", name: "System Font" },
      { kind: "url", url: "fonts/my.woff", format: "woff" },
      { kind: "url", url: "fallback.ttf" },
    ],
  );
  assert.deepEqual(d.weight, { lo: 100, hi: 900 });
  assert.equal(d.italic, true);
  assert.equal(d.widthClass, 3);
});

void test("parseFontFaceRule: missing family or empty src is dropped", () => {
  assert.equal(parseFontFaceRule([decl("src", "url(a.ttf)")]), null);
  assert.equal(parseFontFaceRule([decl("font-family", "X"), decl("src", "nonsense()")]), null);
});

void test("fontFaceFormatSupported: woff2/svg/eot rejected, truetype/woff ok", () => {
  assert.equal(fontFaceFormatSupported(undefined), true);
  assert.equal(fontFaceFormatSupported("truetype"), true);
  assert.equal(fontFaceFormatSupported("woff"), true);
  assert.equal(fontFaceFormatSupported("woff2"), false);
  assert.equal(fontFaceFormatSupported("svg"), false);
  assert.equal(fontFaceFormatSupported("embedded-opentype"), false);
});

void test("collectFontFaceDescriptors walks sheets in order", () => {
  const sheet = {
    fontFaces: [
      { declarations: [decl("font-family", "A"), decl("src", "url(a.ttf)")], order: 0 },
      { declarations: [decl("font-family", "B"), decl("src", "local(B)")], order: 1 },
    ],
  };
  const list = collectFontFaceDescriptors([{ fontFaces: [] }, sheet, {}]);
  assert.deepEqual(list.map((d) => d.family), ["a", "b"]);
});

// ---------------------------------------------------------------------------
// Registry scope + local() + weight ranges.
// ---------------------------------------------------------------------------

void test("scoped registrations are invisible to other scopes and fallbacks", () => {
  const registry = new FontRegistry();
  registry.register(parseTrueType(compileTrueType(fixtureFace("Global"))));
  registry.register(
    parseTrueType(compileTrueType(fixtureFace("ScopedFace"))),
    { family: "webfont" },
    "page-1",
  );

  // Unscoped resolve never sees the scoped face — not even by name.
  assert.equal(registry.resolve(["webfont"], {}, undefined)[0], 0);
  assert.equal(registry.resolve(["webfont"], {}, "other-page")[0], 0);
  // The owning scope resolves it.
  const scoped = registry.resolve(["webfont"], {}, "page-1");
  assert.equal(scoped[0], 1);
  // Scoped faces never enter the generic fallback chain.
  assert.deepEqual(registry.resolve(["global"], {}, "page-1")[0], 0);
  assert.ok(!registry.resolve(["global"], {}, "page-1").includes(1));
});

void test("findLocal matches postscript/full/family names inside scope", () => {
  const registry = new FontRegistry();
  // "Local One"/"Regular" → postscriptName "LocalOne-Regular", fullName
  // "Local One Regular" (compile.ts derives them).
  registry.register(parseTrueType(compileTrueType(fixtureFace("Local One"))));
  registry.register(parseTrueType(compileTrueType(fixtureFace("Scoped Local"))), { family: "scoped local" }, "s1");

  assert.equal(registry.findLocal("localone-regular"), 0, "postscript name");
  assert.equal(registry.findLocal("Local One Regular"), 0, "full name");
  assert.equal(registry.findLocal("local one"), 0, "family name");
  assert.equal(registry.findLocal("scoped local", "s2"), -1, "scoped face invisible elsewhere");
  assert.equal(registry.findLocal("scoped local", "s1"), 1);
  assert.equal(registry.findLocal("does not exist"), -1);
});

void test("weightRange descriptors match in-range weights exactly", () => {
  const registry = new FontRegistry();
  registry.register(parseTrueType(compileTrueType(fixtureFace("Regular", 400))));
  registry.register(
    parseTrueType(compileTrueType(fixtureFace("Var"))),
    { family: "vf", weightRange: [100, 900] },
    "p",
  );
  // An in-range request hits the variable face with weight distance 0.
  const order = registry.resolve(["vf"], { weight: 700 }, "p");
  assert.equal(order[0], 1);
});

// ---------------------------------------------------------------------------
// Source bytes → face (sfnt / WOFF).
// ---------------------------------------------------------------------------

void test("faceFromSourceBytes: raw sfnt and WOFF round-trip", () => {
  const sfnt = compileTrueType(fixtureFace("Roundtrip", 700));
  const face = faceFromSourceBytes(sfnt);
  assert.ok(face !== null);
  assert.equal(face.weight, 700, "OS/2 usWeightClass flows through");

  // Wrap the sfnt into a WOFF 1.0 container: deflate each table.
  const woff = wrapWoff(sfnt);
  assert.ok(isWoff(woff));
  const unwrapped = unwrapWoff(woff);
  const face2 = faceFromSourceBytes(woff);
  assert.ok(face2 !== null);
  assert.equal(face2.glyphIdForCodePoint(0x61), face.glyphIdForCodePoint(0x61));
  assert.equal(face2.weight, 700);
  assert.ok(unwrapped.byteLength > 44);
});

void test("faceFromSourceBytes rejects woff2 and garbage", () => {
  assert.equal(faceFromSourceBytes(new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0])), null);
  assert.equal(faceFromSourceBytes(new Uint8Array([1, 2, 3, 4])), null);
});

/** Minimal WOFF 1.0 wrapper for tests (tables deflated, directory honest). */
function wrapWoff(sfnt: Uint8Array): Uint8Array {
  const v = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
  const flavor = v.getUint32(0, false);
  const numTables = v.getUint16(4, false);
  const recs: { tag: number; data: Uint8Array; checksum: number }[] = [];
  for (let i = 0; i < numTables; i += 1) {
    const o = 12 + i * 16;
    recs.push({
      tag: v.getUint32(o, false),
      checksum: v.getUint32(o + 4, false),
      data: sfnt.subarray(v.getUint32(o + 8, false), v.getUint32(o + 8, false) + v.getUint32(o + 12, false)),
    });
  }
  // WOFF spec: a table is stored uncompressed when deflate would not shrink it.
  const compressed = recs.map((r) => {
    const deflated = new Uint8Array(deflateSync(r.data));
    return { ...r, comp: deflated.byteLength < r.data.byteLength ? deflated : r.data };
  });
  const headSize = 44 + numTables * 20;
  let cursor = headSize;
  const offsets = compressed.map((c) => {
    const o = cursor;
    cursor += c.comp.byteLength + ((4 - (c.comp.byteLength % 4)) % 4);
    return o;
  });
  const out = new Uint8Array(cursor);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, 0x774f4646, false); // "wOFF"
  ov.setUint32(4, flavor, false);
  ov.setUint32(8, out.byteLength, false);
  ov.setUint16(12, numTables, false);
  ov.setUint32(16, sfnt.byteLength, false); // totalSfntSize
  compressed.forEach((c, i) => {
    const o = 44 + i * 20;
    ov.setUint32(o, c.tag, false);
    ov.setUint32(o + 4, offsets[i] ?? headSize, false);
    ov.setUint32(o + 8, c.comp.byteLength, false);
    ov.setUint32(o + 12, c.data.byteLength, false);
    ov.setUint32(o + 16, c.checksum, false);
    out.set(c.comp, offsets[i] ?? headSize);
  });
  return out;
}
