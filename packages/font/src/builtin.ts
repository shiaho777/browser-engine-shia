/**
 * `builtin.ts` — the deterministic built-in vector font.
 *
 * Each printable-ASCII glyph's {@link import("./glyph-art.js")} pixel grid is
 * converted to real filled OUTLINE contours (inked cells merged into horizontal
 * rectangle runs), given a PROPORTIONAL advance from its inked width, and the
 * whole set is compiled to genuine TrueType `sfnt` bytes
 * ({@link compileTrueType}) — then parsed back through the same
 * {@link parseTrueType} used for any real `.ttf`. So the engine renders real
 * scalable vector text out of the box, with NO committed binary asset, fully
 * deterministic (pure functions of the source data).
 *
 * Fidelity is bounded by the 5×7 source grid (blocky glyphs); swapping in a
 * higher-quality outline source — or loading a real font — is a data change, not
 * an engine change. The format, metrics, rasterizer, and seams are all real.
 */
import { compileTrueType, type CompileFont, type CompileGlyph } from "./compile.js";
import { parseTrueType } from "./truetype.js";
import {
  GLYPH_ART_BY_CODEPOINT,
  GLYPH_HEIGHT,
  GLYPH_WIDTH,
} from "./glyph-art.js";
import type { Contour, FontFace, GlyphPoint } from "./types.js";

/** Font units per design-grid cell; em = GLYPH_HEIGHT × CELL. */
const CELL = 200;
const UNITS_PER_EM = GLYPH_HEIGHT * CELL; // 1400
/** Inter-glyph gap added to each advance, in font units. */
const SIDE_GAP = Math.round(CELL * 0.6);

/** Build the rectangle-run outline + advance for one string-art grid. */
function glyphFromArt(art: readonly string[]): CompileGlyph {
  const inked: boolean[][] = art.map((row) => {
    const cells: boolean[] = [];
    for (let x = 0; x < GLYPH_WIDTH; x += 1) cells.push(row[x] === "#");
    return cells;
  });

  let minCol = GLYPH_WIDTH;
  let maxCol = -1;
  for (let gy = 0; gy < GLYPH_HEIGHT; gy += 1) {
    for (let gx = 0; gx < GLYPH_WIDTH; gx += 1) {
      if (inked[gy]?.[gx]) {
        minCol = Math.min(minCol, gx);
        maxCol = Math.max(maxCol, gx);
      }
    }
  }
  if (maxCol < 0) {
    // No ink (space): a blank glyph with a sensible advance.
    return { contours: [], advanceWidth: Math.round(3.2 * CELL) };
  }

  const shiftX = minCol * CELL;
  const contours: Contour[] = [];
  for (let gy = 0; gy < GLYPH_HEIGHT; gy += 1) {
    let gx = 0;
    while (gx < GLYPH_WIDTH) {
      if (!inked[gy]?.[gx]) {
        gx += 1;
        continue;
      }
      let run = gx;
      while (run < GLYPH_WIDTH && inked[gy]?.[run]) run += 1; // [gx, run) inked.
      const x0 = gx * CELL - shiftX;
      const x1 = run * CELL - shiftX;
      // Font y is up, baseline at 0; row gy sits at [bottom, top).
      const yBottom = (GLYPH_HEIGHT - 1 - gy) * CELL;
      const yTop = yBottom + CELL;
      contours.push(rect(x0, yBottom, x1, yTop));
      gx = run;
    }
  }
  const advanceWidth = (maxCol - minCol + 1) * CELL + SIDE_GAP;
  return { contours, advanceWidth };
}

/** A closed axis-aligned rectangle contour (consistent winding). */
function rect(x0: number, y0: number, x1: number, y1: number): Contour {
  const on = (x: number, y: number): GlyphPoint => ({ x, y, onCurve: true });
  return [on(x0, y0), on(x1, y0), on(x1, y1), on(x0, y1)];
}

/** Assemble the built-in {@link CompileFont} from the glyph-art data. */
export function builtinCompileFont(): CompileFont {
  const glyphs: CompileGlyph[] = [{ contours: [], advanceWidth: Math.round(3.2 * CELL) }]; // 0 = .notdef
  const cmap = new Map<number, number>();
  for (const cp of [...GLYPH_ART_BY_CODEPOINT.keys()].sort((a, b) => a - b)) {
    const id = glyphs.length;
    glyphs.push(glyphFromArt(GLYPH_ART_BY_CODEPOINT.get(cp)!));
    cmap.set(cp, id);
  }
  return {
    unitsPerEm: UNITS_PER_EM,
    ascent: GLYPH_HEIGHT * CELL,
    descent: 0,
    glyphs,
    cmap,
  };
}

/** The compiled built-in font's raw TrueType bytes (deterministic). */
export function builtinFontBytes(): Uint8Array {
  return compileTrueType(builtinCompileFont());
}

let cached: FontFace | undefined;

/** The built-in {@link FontFace}, parsed once from the compiled bytes. */
export function builtinFont(): FontFace {
  cached ??= parseTrueType(builtinFontBytes());
  return cached;
}
