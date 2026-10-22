/**
 * RFC 0005 evidence: `readSfntFaceInfo` recovers family/subfamily/weight from
 * compiled fixtures — single sfnt and `ttcf` members — and the file-backed
 * variant reads only the directory + name/OS2 ranges.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { compileTrueType, compileTrueTypeCollection, type CompileFont } from "./compile.js";
import { readSfntFaceInfo, readSfntFaceInfoFromFile } from "./names.js";
import { parseTrueType } from "./truetype.js";

function face(names?: { family: string; subfamily?: string }, os2?: CompileFont["os2"]): CompileFont {
  return {
    unitsPerEm: 1000,
    ascent: 800,
    descent: -200,
    glyphs: [
      { contours: [], advanceWidth: 600 },
      { contours: [], advanceWidth: 500 },
    ],
    cmap: new Map([[0x61, 1]]),
    ...(names !== undefined ? { names } : {}),
    ...(os2 !== undefined ? { os2 } : {}),
  };
}

void test("name + OS/2 metadata survives the compile→read round-trip", () => {
  const bytes = compileTrueType(
    face({ family: "Test Serif", subfamily: "Bold" }, { weightClass: 700, widthClass: 5 }),
  );
  const [info] = readSfntFaceInfo(bytes);
  assert.equal(info?.family, "Test Serif");
  assert.equal(info?.subfamily, "Bold");
  assert.equal(info?.weightClass, 700);
  assert.equal(info?.widthClass, 5);
  assert.equal(info?.italic, false);
  assert.equal(info?.faceIndex, 0);
});

void test("italic marks come from OS/2 fsSelection or the subfamily name", () => {
  const byOs2 = readSfntFaceInfo(
    compileTrueType(face({ family: "Test Italic" }, { italic: true })),
  )[0];
  assert.equal(byOs2?.italic, true);
  const byName = readSfntFaceInfo(
    compileTrueType(face({ family: "Test Italic", subfamily: "Italic" })),
  )[0];
  assert.equal(byName?.italic, true);
});

void test("a compiled ttcf exposes per-member families with correct faceIndex", () => {
  const bytes = compileTrueTypeCollection([
    face({ family: "Coll One" }),
    face({ family: "Coll Two" }, { weightClass: 300 }),
  ]);
  const infos = readSfntFaceInfo(bytes);
  assert.equal(infos.length, 2);
  assert.equal(infos[0]?.family, "Coll One");
  assert.equal(infos[0]?.faceIndex, 0);
  assert.equal(infos[1]?.family, "Coll Two");
  assert.equal(infos[1]?.faceIndex, 1);
  assert.equal(infos[1]?.weightClass, 300);
  // And the members really parse as faces at their indices.
  assert.equal(parseTrueType(bytes, 0).glyphIdForCodePoint(0x61), 1);
  assert.equal(parseTrueType(bytes, 1).glyphIdForCodePoint(0x61), 1);
  assert.equal(parseTrueType(bytes, 1).collectionIndex, 1);
});

void test("readSfntFaceInfoFromFile reads a probed file without glyph data", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "font-names-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "Probe.ttf");
  writeFileSync(path, compileTrueType(face({ family: "Probe Fam" }, { weightClass: 500 })));
  const [info] = readSfntFaceInfoFromFile(path);
  assert.equal(info?.family, "Probe Fam");
  assert.equal(info?.weightClass, 500);
});

void test("a fontless name table yields a null family, not a crash", () => {
  const [info] = readSfntFaceInfo(compileTrueType(face()));
  assert.equal(info?.family, null);
});
