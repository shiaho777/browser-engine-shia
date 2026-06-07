/**
 * `truetype.ts` — a real TrueType/OpenType (`glyf`-flavoured `sfnt`) PARSER.
 *
 * Parses the tables the engine needs to lay out and rasterize text:
 *   - `head`  — units-per-em + loca format;
 *   - `maxp`  — glyph count;
 *   - `hhea`/`hmtx` — ascent/descent + per-glyph advance & left side bearing;
 *   - `cmap`  — Unicode → glyph-id (format 4, the BMP workhorse; format 0 too);
 *   - `loca`/`glyf` — scalable glyph OUTLINES (simple + composite glyphs, with
 *     the full TrueType flag/delta/repeat coordinate encoding).
 *
 * Output is the read-only {@link FontFace}. Glyph outlines are decoded lazily +
 * memoized. This is genuine font technology (the FreeType-parsing analog), not a
 * placeholder; it reads the same `.ttf` files browsers and the OS ship.
 */
import { Reader } from "./sfnt.js";
import type { Contour, FontFace, GlyphMetrics, GlyphOutline, GlyphPoint } from "./types.js";

interface TableRec {
  readonly offset: number;
  readonly length: number;
}

/** Parse an sfnt byte buffer into a {@link FontFace}. Throws on malformed input. */
export function parseTrueType(bytes: Uint8Array): FontFace {
  const r = new Reader(bytes);
  const sfntVersion = r.uint32();
  // 0x00010000 = TrueType outlines; "true"/"ttcf" variants; "OTTO" = CFF (no glyf).
  if (sfntVersion === 0x4f54544f) {
    throw new Error("font: OpenType/CFF (OTTO) outlines are not supported — need a glyf-based TrueType font");
  }
  const numTables = r.uint16();
  r.skip(6); // searchRange, entrySelector, rangeShift.
  const tables = new Map<string, TableRec>();
  for (let i = 0; i < numTables; i += 1) {
    const tag = r.tag();
    r.uint32(); // checksum (not verified — parsers may ignore).
    const offset = r.uint32();
    const length = r.uint32();
    tables.set(tag, { offset, length });
  }

  const need = (tag: string): TableRec => {
    const t = tables.get(tag);
    if (t === undefined) throw new Error(`font: required table '${tag}' is missing`);
    return t;
  };

  // ---- head: unitsPerEm + indexToLocFormat ---------------------------------
  const head = need("head");
  r.seek(head.offset + 18);
  const unitsPerEm = r.uint16();
  r.seek(head.offset + 50);
  const indexToLocFormat = r.int16();

  // ---- maxp: glyph count ---------------------------------------------------
  const maxp = need("maxp");
  r.seek(maxp.offset + 4);
  const numGlyphs = r.uint16();

  // ---- hhea: ascent/descent + numberOfHMetrics -----------------------------
  const hhea = need("hhea");
  r.seek(hhea.offset + 4);
  const ascent = r.int16();
  const descent = r.int16();
  r.seek(hhea.offset + 34);
  const numberOfHMetrics = r.uint16();

  // ---- hmtx: advance widths + left side bearings ---------------------------
  const hmtx = need("hmtx");
  const advances = new Array<number>(numGlyphs);
  const lsbs = new Array<number>(numGlyphs);
  r.seek(hmtx.offset);
  let lastAdvance = 0;
  for (let i = 0; i < numGlyphs; i += 1) {
    if (i < numberOfHMetrics) {
      lastAdvance = r.uint16();
      lsbs[i] = r.int16();
    } else {
      lsbs[i] = r.int16();
    }
    advances[i] = lastAdvance;
  }

  // ---- loca: per-glyph glyf offsets ----------------------------------------
  const loca = need("loca");
  const glyfOffsets = new Array<number>(numGlyphs + 1);
  r.seek(loca.offset);
  if (indexToLocFormat === 0) {
    for (let i = 0; i <= numGlyphs; i += 1) glyfOffsets[i] = r.uint16() * 2;
  } else {
    for (let i = 0; i <= numGlyphs; i += 1) glyfOffsets[i] = r.uint32();
  }

  const glyf = need("glyf");
  const cmap = parseCmap(r, need("cmap").offset);

  const outlineCache = new Map<number, GlyphOutline>();
  const readOutline = (glyphId: number): GlyphOutline => {
    const cached = outlineCache.get(glyphId);
    if (cached !== undefined) return cached;
    const out = decodeGlyph(r, glyf.offset, glyfOffsets, glyphId, 0);
    outlineCache.set(glyphId, out);
    return out;
  };

  return {
    unitsPerEm,
    numGlyphs,
    ascent,
    descent,
    glyphIdForCodePoint: (cp: number): number => cmap.get(cp) ?? 0,
    metricsOf: (glyphId: number): GlyphMetrics => ({
      advanceWidth: advances[Math.min(glyphId, numGlyphs - 1)] ?? 0,
      leftSideBearing: lsbs[Math.min(glyphId, numGlyphs - 1)] ?? 0,
    }),
    outlineOf: (glyphId: number): GlyphOutline =>
      glyphId < 0 || glyphId >= numGlyphs ? EMPTY_OUTLINE : readOutline(glyphId),
  };
}

const EMPTY_OUTLINE: GlyphOutline = { contours: [], xMin: 0, yMin: 0, xMax: 0, yMax: 0 };

// ---------------------------------------------------------------------------
// glyf decoding
// ---------------------------------------------------------------------------

const ON_CURVE = 0x01;
const X_SHORT = 0x02;
const Y_SHORT = 0x04;
const REPEAT = 0x08;
const X_SAME_OR_POS = 0x10;
const Y_SAME_OR_POS = 0x20;

// composite component flags
const ARG_1_AND_2_ARE_WORDS = 0x0001;
const ARGS_ARE_XY_VALUES = 0x0002;
const WE_HAVE_A_SCALE = 0x0008;
const MORE_COMPONENTS = 0x0020;
const WE_HAVE_AN_X_AND_Y_SCALE = 0x0040;
const WE_HAVE_A_TWO_BY_TWO = 0x0080;

function decodeGlyph(
  r: Reader,
  glyfBase: number,
  offsets: readonly number[],
  glyphId: number,
  depth: number,
): GlyphOutline {
  const start = offsets[glyphId] ?? 0;
  const end = offsets[glyphId + 1] ?? start;
  if (end <= start) return EMPTY_OUTLINE; // empty glyph (e.g. space).
  r.seek(glyfBase + start);
  const numberOfContours = r.int16();
  const xMin = r.int16();
  const yMin = r.int16();
  const xMax = r.int16();
  const yMax = r.int16();
  if (numberOfContours < 0) {
    return decodeComposite(r, glyfBase, offsets, depth, xMin, yMin, xMax, yMax);
  }
  return decodeSimple(r, numberOfContours, xMin, yMin, xMax, yMax);
}

function decodeSimple(
  r: Reader,
  numberOfContours: number,
  xMin: number,
  yMin: number,
  xMax: number,
  yMax: number,
): GlyphOutline {
  const endPts: number[] = [];
  for (let i = 0; i < numberOfContours; i += 1) endPts.push(r.uint16());
  const numPoints = numberOfContours === 0 ? 0 : (endPts[numberOfContours - 1] ?? -1) + 1;
  const instructionLength = r.uint16();
  r.skip(instructionLength);

  // Flags (with run-length REPEAT compression).
  const flags = new Array<number>(numPoints);
  for (let i = 0; i < numPoints; ) {
    const f = r.uint8();
    flags[i] = f;
    i += 1;
    if ((f & REPEAT) !== 0) {
      let count = r.uint8();
      while (count > 0 && i < numPoints) {
        flags[i] = f;
        i += 1;
        count -= 1;
      }
    }
  }

  // X then Y coordinates, delta-encoded against the running position.
  const xs = readCoords(r, flags, numPoints, X_SHORT, X_SAME_OR_POS);
  const ys = readCoords(r, flags, numPoints, Y_SHORT, Y_SAME_OR_POS);

  const contours: Contour[] = [];
  let p = 0;
  for (let c = 0; c < numberOfContours; c += 1) {
    const last = endPts[c] ?? -1;
    const pts: GlyphPoint[] = [];
    for (; p <= last; p += 1) {
      pts.push({ x: xs[p] ?? 0, y: ys[p] ?? 0, onCurve: ((flags[p] ?? 0) & ON_CURVE) !== 0 });
    }
    if (pts.length > 0) contours.push(pts);
  }
  return { contours, xMin, yMin, xMax, yMax };
}

/** Decode the delta-encoded coordinate stream for one axis. */
function readCoords(
  r: Reader,
  flags: readonly number[],
  numPoints: number,
  shortBit: number,
  sameOrPosBit: number,
): number[] {
  const coords = new Array<number>(numPoints);
  let value = 0;
  for (let i = 0; i < numPoints; i += 1) {
    const f = flags[i] ?? 0;
    if ((f & shortBit) !== 0) {
      const delta = r.uint8();
      value += (f & sameOrPosBit) !== 0 ? delta : -delta;
    } else if ((f & sameOrPosBit) === 0) {
      value += r.int16();
    } // else: same as previous (delta 0).
    coords[i] = value;
  }
  return coords;
}

function decodeComposite(
  r: Reader,
  glyfBase: number,
  offsets: readonly number[],
  depth: number,
  xMin: number,
  yMin: number,
  xMax: number,
  yMax: number,
): GlyphOutline {
  if (depth > 5) return EMPTY_OUTLINE; // defensive recursion guard.
  const contours: Contour[] = [];
  let more = true;
  while (more) {
    const flags = r.uint16();
    const componentGlyph = r.uint16();
    let arg1: number;
    let arg2: number;
    if ((flags & ARG_1_AND_2_ARE_WORDS) !== 0) {
      arg1 = r.int16();
      arg2 = r.int16();
    } else {
      arg1 = r.int8();
      arg2 = r.int8();
    }
    let a = 1;
    let b = 0;
    let c = 0;
    let d = 1;
    if ((flags & WE_HAVE_A_SCALE) !== 0) {
      a = d = f2dot14(r.int16());
    } else if ((flags & WE_HAVE_AN_X_AND_Y_SCALE) !== 0) {
      a = f2dot14(r.int16());
      d = f2dot14(r.int16());
    } else if ((flags & WE_HAVE_A_TWO_BY_TWO) !== 0) {
      a = f2dot14(r.int16());
      b = f2dot14(r.int16());
      c = f2dot14(r.int16());
      d = f2dot14(r.int16());
    }
    const dx = (flags & ARGS_ARE_XY_VALUES) !== 0 ? arg1 : 0;
    const dy = (flags & ARGS_ARE_XY_VALUES) !== 0 ? arg2 : 0;

    const savedPos = r.pos;
    const sub = decodeGlyph(r, glyfBase, offsets, componentGlyph, depth + 1);
    r.seek(savedPos);
    for (const contour of sub.contours) {
      contours.push(
        contour.map((pt) => ({
          x: a * pt.x + c * pt.y + dx,
          y: b * pt.x + d * pt.y + dy,
          onCurve: pt.onCurve,
        })),
      );
    }
    more = (flags & MORE_COMPONENTS) !== 0;
  }
  return { contours, xMin, yMin, xMax, yMax };
}

/** Convert a TrueType F2Dot14 fixed-point value to a float. */
function f2dot14(v: number): number {
  return v / 16384;
}

// ---------------------------------------------------------------------------
// cmap (Unicode → glyph id)
// ---------------------------------------------------------------------------

/** Parse the `cmap` table, returning a Unicode→glyphId map from the best subtable. */
function parseCmap(r: Reader, base: number): Map<number, number> {
  r.seek(base + 2);
  const numSub = r.uint16();
  let best = -1;
  let bestScore = -1;
  for (let i = 0; i < numSub; i += 1) {
    const platformId = r.uint16();
    const encodingId = r.uint16();
    const offset = r.uint32();
    // Prefer Unicode BMP (3,1) > Unicode (0,*) > (3,0) symbol > Mac (1,0).
    const score =
      platformId === 3 && encodingId === 1
        ? 4
        : platformId === 0
          ? 3
          : platformId === 3 && encodingId === 0
            ? 2
            : platformId === 1
              ? 1
              : 0;
    if (score > bestScore) {
      bestScore = score;
      best = base + offset;
    }
  }
  if (best < 0) return new Map();
  r.seek(best);
  const format = r.uint16();
  if (format === 0) return parseCmap0(r);
  if (format === 4) return parseCmap4(r, best);
  return new Map();
}

/** cmap format 0: a 256-entry byte map (legacy Mac). */
function parseCmap0(r: Reader): Map<number, number> {
  r.uint16(); // length
  r.uint16(); // language
  const map = new Map<number, number>();
  for (let i = 0; i < 256; i += 1) {
    const g = r.uint8();
    if (g !== 0) map.set(i, g);
  }
  return map;
}

/** cmap format 4: segmented BMP coverage (the standard Unicode subtable). */
function parseCmap4(r: Reader, subtableStart: number): Map<number, number> {
  r.uint16(); // length
  r.uint16(); // language
  const segCountX2 = r.uint16();
  const segCount = segCountX2 / 2;
  r.skip(6); // searchRange, entrySelector, rangeShift.
  const endCodes = readU16Array(r, segCount);
  r.uint16(); // reservedPad
  const startCodes = readU16Array(r, segCount);
  const idDeltas = readU16Array(r, segCount);
  const idRangeOffsetPos = r.pos;
  const idRangeOffsets = readU16Array(r, segCount);

  const map = new Map<number, number>();
  for (let s = 0; s < segCount; s += 1) {
    const start = startCodes[s] ?? 0;
    const end = endCodes[s] ?? 0;
    const delta = idDeltas[s] ?? 0;
    const rangeOffset = idRangeOffsets[s] ?? 0;
    if (start > end || start === 0xffff) continue;
    for (let cp = start; cp <= end; cp += 1) {
      let gid: number;
      if (rangeOffset === 0) {
        gid = (cp + delta) & 0xffff;
      } else {
        // Spec's glyphIdArray indexing trick, resolved to an absolute offset.
        const addr = idRangeOffsetPos + s * 2 + rangeOffset + (cp - start) * 2;
        r.seek(addr);
        const g = r.uint16();
        gid = g === 0 ? 0 : (g + delta) & 0xffff;
      }
      if (gid !== 0) map.set(cp, gid);
    }
  }
  void subtableStart;
  return map;
}

function readU16Array(r: Reader, n: number): number[] {
  const out = new Array<number>(n);
  for (let i = 0; i < n; i += 1) out[i] = r.uint16();
  return out;
}
