/**
 * RFC 0006 evidence: `@font-face` end-to-end — a `data:`-embedded font inside
 * a real document reaches the registry under the page's scope, `font-family`
 * resolves it, and the DisplayList carries ITS (faceIndex, glyphId) — the
 * compiled fixture's `a` is glyph 1 on the registered face slot.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { compileTrueType } from "@browser-engine/font";

import { FineSession } from "./fine.js";
import { pipelineFontRegistry } from "./fonts.js";

function dataFont(family: string): string {
  const bytes = compileTrueType({
    unitsPerEm: 1000,
    ascent: 800,
    descent: -200,
    glyphs: [
      { contours: [], advanceWidth: 300 }, // 0
      { contours: [], advanceWidth: 900 }, // 'a' → gid 1 — wide, distinctive
    ],
    cmap: new Map([[0x61, 1]]),
    names: { family },
  });
  return `data:font/ttf;base64,${Buffer.from(bytes).toString("base64")}`;
}

/** Collect every text command's (faceIndex, glyphId) pairs from a list. */
function textGlyphs(list: { commands: readonly { op: string; glyphs?: readonly { glyphId: number; faceIndex?: number }[] }[] }) {
  const out: { glyphId: number; faceIndex: number }[] = [];
  for (const cmd of list.commands) {
    if (cmd.op !== "text") continue;
    for (const g of cmd.glyphs ?? []) {
      out.push({ glyphId: g.glyphId, faceIndex: g.faceIndex ?? -1 });
    }
  }
  return out;
}

void test("@font-face data: URL registers and resolves inside the page scope", () => {
  const url = "fine://webfont-page";
  const session = new FineSession(
    `<style>
       @font-face { font-family: "WebA"; src: url("${dataFont("WebA Real")}") }
       p { font-family: "WebA" }
     </style><p>a</p>`,
    url,
  );
  const list = session.render();
  const glyphs = textGlyphs(list);
  assert.ok(glyphs.length > 0, "text emitted");

  const webIdx = pipelineFontRegistry.resolve(["weba"], { weight: 400 }, url)[0]!;
  assert.ok(webIdx >= 0);
  assert.ok(
    glyphs.some((g) => g.faceIndex === webIdx && g.glyphId === 1),
    `the 'a' glyph is the WEB font's gid 1 on face ${webIdx}, not a system face`,
  );
  const face = pipelineFontRegistry.faces[webIdx]!;
  // The registered face carries the COMPILED table — 900-unit advance for 'a'.
  assert.equal(face.metricsOf(1).advanceWidth, 900);
});

void test("a @font-face family does not leak into another page's scope", () => {
  const urlA = "fine://page-a";
  const urlB = "fine://page-b";
  new FineSession(
    `<style>@font-face { font-family: "OnlyA"; src: url("${dataFont("OnlyA")}") }</style><p>x</p>`,
    urlA,
  ).render();
  const sessionB = new FineSession(`<p style="font-family: OnlyA">a</p>`, urlB);
  const glyphs = textGlyphs(sessionB.render());
  const leaked = glyphs.some(
    (g) => g.faceIndex === pipelineFontRegistry.resolve(["onlya"], {}, urlA)[0],
  );
  assert.equal(leaked, false, "page B's identical font-family cannot see page A's webfont");
});

void test("src: local() resolves a registered family without fetch", () => {
  const url = "fine://local-page";
  const builtinName = "browser-engine-builtin";
  const session = new FineSession(
    `<style>
       @font-face { font-family: "Alias"; src: local("${builtinName}") }
       p { font-family: "Alias" }
     </style><p>a</p>`,
    url,
  );
  const glyphs = textGlyphs(session.render());
  const aliasIdx = pipelineFontRegistry.resolve(["alias"], {}, url)[0]!;
  const builtinIdx = pipelineFontRegistry.findLocal(builtinName);
  assert.ok(glyphs.some((g) => g.faceIndex === aliasIdx));
  assert.equal(
    pipelineFontRegistry.faces[aliasIdx],
    pipelineFontRegistry.faces[builtinIdx],
    "local() re-registers the SAME FontFace object under the declared name",
  );
});

/** The `synthesizeBold` flag each text command carries (undefined = allowed). */
function synthFlags(list: { commands: readonly { op: string; synthesizeBold?: boolean }[] }): (boolean | undefined)[] {
  return list.commands.filter((c) => c.op === "text").map((c) => c.synthesizeBold);
}

void test("font-synthesis:none puts synthesizeBold:false on the text command", () => {
  const url = "fine://synth-page";
  const session = new FineSession(
    `<style>
       .no { font-weight: 700; font-synthesis: none }
       .yes { font-weight: 700 }
     </style><p class="no">a</p><p class="yes">b</p>`,
    url,
  );
  const flags = synthFlags(session.render());
  assert.ok(flags.includes(false), "font-synthesis:none suppresses fake bold on the command");
  assert.ok(
    flags.some((f) => f === undefined),
    "default synthesis leaves the flag unset (synthesis allowed)",
  );
});
