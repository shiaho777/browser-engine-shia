/**
 * RFC 0005 evidence: `FontRegistry` — family→index resolution order, weight
 * picks, generic aliases, and lazy file materialization into the append-only
 * master table.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { compileTrueType, type CompileFont } from "./compile.js";
import { FontRegistry } from "./registry.js";
import { parseTrueType } from "./truetype.js";

function face(
  names?: { family: string; subfamily?: string },
  os2?: CompileFont["os2"],
): CompileFont {
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

function registryWithFixtures(): FontRegistry {
  const registry = new FontRegistry();
  registry.register(parseTrueType(compileTrueType(face({ family: "Test Sans" }))));
  registry.register(
    parseTrueType(compileTrueType(face({ family: "Test Sans", subfamily: "Bold" }))),
    { weightClass: 700, subfamily: "Bold" },
  );
  return registry;
}

void test("resolve: requested family first, then the eager fallback chain", () => {
  const registry = registryWithFixtures();
  const order = registry.resolve(["test sans"], { weight: 400 });
  assert.ok(order.length >= 2);
  assert.equal(order[0], 0, "regular member wins for weight 400");
  assert.deepEqual(order, registry.resolve(["missing-family"], { weight: 400 }),
    "unknown family still ends at the default chain");
  // Family member is picked by weight, not registration order.
  assert.equal(registry.resolve(["test sans"], { weight: 700 })[0], 1);
});

void test("generic aliases route through registered families", () => {
  const registry = registryWithFixtures();
  registry.alias("monospace", "test sans");
  const order = registry.resolve(["monospace"], { weight: 400 });
  assert.equal(order[0], 0, "monospace alias lands on test sans");
});

void test("lazy registerFile materializes into the append-only master table", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "font-registry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "Lazy.ttf");
  writeFileSync(path, compileTrueType(face({ family: "Lazy Fam" })));

  const registry = registryWithFixtures();
  const before = registry.faces.length;
  assert.equal(registry.registerFile(path), 1);
  assert.equal(registry.faces.length, before, "probing never materializes");

  const order = registry.resolve(["lazy fam"], { weight: 400 });
  assert.equal(registry.faces.length, before + 1, "first selection parses the file");
  const idx = order[0]!;
  assert.ok(idx >= before);
  const faceObj = registry.faces[idx]!;
  assert.equal(faceObj.glyphIdForCodePoint(0x61), 1, "materialized face parses");
  // Repeated resolves hit the same slot — the master table is stable.
  assert.deepEqual(registry.resolve(["lazy fam"], { weight: 400 }), order);
});

void test("italic prefers the italic member; stretch prefers width class", () => {
  const registry = new FontRegistry();
  registry.register(parseTrueType(compileTrueType(face({ family: "F" }))));
  registry.register(
    parseTrueType(compileTrueType(face({ family: "F", subfamily: "Italic" }))),
    { italic: true, subfamily: "Italic" },
  );
  registry.register(
    parseTrueType(compileTrueType(face({ family: "F", subfamily: "Condensed" }))),
    { widthClass: 3, subfamily: "Condensed" },
  );
  assert.equal(registry.resolve(["f"], { italic: true })[0], 1);
  assert.equal(registry.resolve(["f"], { widthClass: 3 })[0], 2);
  assert.equal(registry.resolve(["f"], {})[0], 0);
});

void test("unreadable and non-sfnt probes contribute zero faces", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "font-registry-bad-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const registry = new FontRegistry();
  assert.equal(registry.registerFile(join(dir, "nope.ttf")), 0);
  const bad = join(dir, "bad.ttf");
  writeFileSync(bad, new Uint8Array([0, 1, 2, 3]));
  assert.equal(registry.registerFile(bad), 0);
});
