import test from "node:test";
import assert from "node:assert/strict";

import {
  advanceEmForCodePoint,
  builtinFont,
  fallbackCoverageSource,
  loadPreferredSystemFont,
  loadTrueTypeFontFromPath,
} from "./index.js";

void test("preferred system font covers CJK when Arial Unicode is present", () => {
  const face = loadPreferredSystemFont();
  if (face === null) {
    assert.ok(true, "no system TTF available in this environment");
    return;
  }
  const gid = face.glyphIdForCodePoint("中".codePointAt(0)!);
  if (gid === 0) {
    assert.ok(face.numGlyphs > 0, "system font parsed without CJK coverage");
    return;
  }
  assert.ok(gid > 0);
  assert.ok(face.outlineOf(gid).contours.length > 0);
  const src = fallbackCoverageSource([face, builtinFont()]);
  const sid = src.glyphId("中".codePointAt(0)!);
  assert.ok(sid > 0);
  const r = src.raster(sid, 28);
  assert.ok(r.width > 0 && r.height > 0);
  let ink = 0;
  for (const c of r.coverage) if (c > 0) ink += 1;
  assert.ok(ink > 10, "CJK glyph paints ink");
});

void test("fallback coverage prefers first face then builtin", () => {
  const builtin = builtinFont();
  const system = loadTrueTypeFontFromPath("/Library/Fonts/Arial Unicode.ttf");
  const faces = system ? [system, builtin] : [builtin];
  const src = fallbackCoverageSource(faces);
  const H = src.glyphId("H".codePointAt(0)!);
  assert.ok(H > 0);
  assert.ok(src.advanceEm(H) > 0);
  assert.ok(advanceEmForCodePoint(faces, "i".codePointAt(0)!) > 0);
  if (system) {
    assert.ok(src.glyphId("测".codePointAt(0)!) > 0);
  }
});
