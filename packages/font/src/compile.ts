/**
 * `compile.ts` — a real TrueType (`glyf`) font COMPILER: assemble valid `sfnt`
 * bytes (cmap/glyf/head/hhea/hmtx/loca/maxp, correct table directory + sfnt and
 * head checksums) from glyph outlines, advances, and a Unicode→glyph map.
 *
 * Why a compiler: it lets the engine ship a deterministic built-in vector font
 * as SOURCE DATA (no committed binary blob), and gives the parser/rasterizer a
 * real `.ttf` to be tested against. The bytes it emits are parsed back by the
 * same {@link import("./truetype.js").parseTrueType} the engine uses for any
 * real font — proving the format end to end.
 */
import { Writer, checksum } from "./sfnt.js";
import type { Contour } from "./types.js";

/** A glyph to compile: its contours (font units) and advance width. */
export interface CompileGlyph {
  readonly contours: readonly Contour[];
  readonly advanceWidth: number;
}

/** A font to compile. `glyphs[0]` is `.notdef`; `cmap` maps code points to ids. */
export interface CompileFont {
  readonly unitsPerEm: number;
  readonly ascent: number;
  readonly descent: number;
  readonly glyphs: readonly CompileGlyph[];
  readonly cmap: ReadonlyMap<number, number>;
}

const MAGIC = 0x5f0f3cf5;
const CHECKSUM_MAGIC = 0xb1b0afba;

/** Compile a {@link CompileFont} into TrueType `sfnt` bytes. */
export function compileTrueType(font: CompileFont): Uint8Array {
  const numGlyphs = font.glyphs.length;

  // ---- glyf + loca ---------------------------------------------------------
  const glyfW = new Writer();
  const locaOffsets: number[] = [0];
  let fontXMin = 0;
  let fontYMin = 0;
  let fontXMax = 0;
  let fontYMax = 0;
  let advanceWidthMax = 0;
  for (const glyph of font.glyphs) {
    advanceWidthMax = Math.max(advanceWidthMax, glyph.advanceWidth);
    if (glyph.contours.length > 0) {
      const bbox = encodeSimpleGlyph(glyfW, glyph.contours);
      fontXMin = Math.min(fontXMin, bbox.xMin);
      fontYMin = Math.min(fontYMin, bbox.yMin);
      fontXMax = Math.max(fontXMax, bbox.xMax);
      fontYMax = Math.max(fontYMax, bbox.yMax);
    }
    // Pad each glyph to a 2-byte boundary (short loca stores offset / 2).
    if (glyfW.length % 2 !== 0) glyfW.uint8(0);
    locaOffsets.push(glyfW.length);
  }
  const glyfBytes = glyfW.toBytes();

  const locaW = new Writer();
  for (const off of locaOffsets) locaW.uint16(off / 2); // short loca format.
  const locaBytes = locaW.toBytes();

  // ---- head ----------------------------------------------------------------
  const headW = new Writer();
  headW.uint32(0x00010000); // version
  headW.uint32(0x00010000); // fontRevision
  headW.uint32(0); // checkSumAdjustment (patched after assembly)
  headW.uint32(MAGIC);
  headW.uint16(0); // flags
  headW.uint16(font.unitsPerEm);
  headW.uint32(0); // created (hi/lo) — LONGDATETIME = 8 bytes
  headW.uint32(0);
  headW.uint32(0); // modified
  headW.uint32(0);
  headW.int16(fontXMin);
  headW.int16(fontYMin);
  headW.int16(fontXMax);
  headW.int16(fontYMax);
  headW.uint16(0); // macStyle
  headW.uint16(8); // lowestRecPPEM
  headW.int16(2); // fontDirectionHint
  headW.int16(0); // indexToLocFormat = short
  headW.int16(0); // glyphDataFormat
  const headBytes = headW.toBytes();

  // ---- hhea ----------------------------------------------------------------
  const hheaW = new Writer();
  hheaW.uint32(0x00010000);
  hheaW.int16(font.ascent);
  hheaW.int16(font.descent);
  hheaW.int16(0); // lineGap
  hheaW.uint16(advanceWidthMax);
  hheaW.int16(0); // minLeftSideBearing
  hheaW.int16(0); // minRightSideBearing
  hheaW.int16(fontXMax); // xMaxExtent
  hheaW.int16(1); // caretSlopeRise
  hheaW.int16(0); // caretSlopeRun
  hheaW.int16(0); // caretOffset
  hheaW.int16(0);
  hheaW.int16(0);
  hheaW.int16(0);
  hheaW.int16(0); // 4 reserved
  hheaW.int16(0); // metricDataFormat
  hheaW.uint16(numGlyphs); // numberOfHMetrics (full metrics for every glyph)
  const hheaBytes = hheaW.toBytes();

  // ---- hmtx ----------------------------------------------------------------
  const hmtxW = new Writer();
  for (const glyph of font.glyphs) {
    hmtxW.uint16(glyph.advanceWidth);
    hmtxW.int16(0); // left side bearing (xMin ≈ 0 for our glyphs)
  }
  const hmtxBytes = hmtxW.toBytes();

  // ---- maxp (v1.0) ---------------------------------------------------------
  const maxpW = new Writer();
  maxpW.uint32(0x00010000);
  maxpW.uint16(numGlyphs);
  for (let i = 0; i < 13; i += 1) maxpW.uint16(0); // maxPoints … maxComponentDepth
  const maxpBytes = maxpW.toBytes();

  // ---- cmap (format 4) -----------------------------------------------------
  const cmapBytes = encodeCmap(font.cmap);

  // ---- assemble: directory (alphabetical tags) + 4-padded table data -------
  const tables: { tag: string; bytes: Uint8Array }[] = [
    { tag: "cmap", bytes: cmapBytes },
    { tag: "glyf", bytes: glyfBytes },
    { tag: "head", bytes: headBytes },
    { tag: "hhea", bytes: hheaBytes },
    { tag: "hmtx", bytes: hmtxBytes },
    { tag: "loca", bytes: locaBytes },
    { tag: "maxp", bytes: maxpBytes },
  ];

  const numTables = tables.length;
  const entrySelector = Math.floor(Math.log2(numTables));
  const searchRange = 16 * 2 ** entrySelector;
  const rangeShift = numTables * 16 - searchRange;

  const headerSize = 12 + numTables * 16;
  let offset = headerSize;
  const placed = tables.map((t) => {
    const padded = pad4(t.bytes);
    const rec = { tag: t.tag, offset, length: t.bytes.length, padded };
    offset += padded.length;
    return rec;
  });

  const out = new Writer();
  out.uint32(0x00010000); // sfnt version (TrueType)
  out.uint16(numTables);
  out.uint16(searchRange);
  out.uint16(entrySelector);
  out.uint16(rangeShift);
  for (const rec of placed) {
    out.tag(rec.tag);
    out.uint32(checksum(rec.padded));
    out.uint32(rec.offset);
    out.uint32(rec.length);
  }
  for (const rec of placed) out.raw(rec.padded);

  const bytes = out.toBytes();

  // Patch head.checkSumAdjustment = MAGIC - checksum(whole font).
  const headRec = placed.find((p) => p.tag === "head")!;
  const adjustment = (CHECKSUM_MAGIC - checksum(bytes)) >>> 0;
  const adjOffset = headRec.offset + 8;
  bytes[adjOffset] = (adjustment >>> 24) & 0xff;
  bytes[adjOffset + 1] = (adjustment >>> 16) & 0xff;
  bytes[adjOffset + 2] = (adjustment >>> 8) & 0xff;
  bytes[adjOffset + 3] = adjustment & 0xff;
  return bytes;
}

interface BBox {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

/** Encode one simple glyph (no short/repeat compression — int16 deltas). */
function encodeSimpleGlyph(w: Writer, contours: readonly Contour[]): BBox {
  const allPts = contours.flat();
  let xMin = Infinity;
  let yMin = Infinity;
  let xMax = -Infinity;
  let yMax = -Infinity;
  for (const p of allPts) {
    xMin = Math.min(xMin, p.x);
    yMin = Math.min(yMin, p.y);
    xMax = Math.max(xMax, p.x);
    yMax = Math.max(yMax, p.y);
  }
  w.int16(contours.length);
  w.int16(Math.floor(xMin));
  w.int16(Math.floor(yMin));
  w.int16(Math.ceil(xMax));
  w.int16(Math.ceil(yMax));
  let cumulative = -1;
  for (const c of contours) {
    cumulative += c.length;
    w.uint16(cumulative); // endPtsOfContours
  }
  w.uint16(0); // instructionLength
  // Flags: ON_CURVE bit only; every coordinate stored as a full int16 delta.
  for (const p of allPts) w.uint8(p.onCurve ? 0x01 : 0x00);
  let prev = 0;
  for (const p of allPts) {
    w.int16(p.x - prev);
    prev = p.x;
  }
  prev = 0;
  for (const p of allPts) {
    w.int16(p.y - prev);
    prev = p.y;
  }
  return { xMin: Math.floor(xMin), yMin: Math.floor(yMin), xMax: Math.ceil(xMax), yMax: Math.ceil(yMax) };
}

/** Encode a `cmap` table with a single format-4 Unicode subtable. */
function encodeCmap(map: ReadonlyMap<number, number>): Uint8Array {
  // One segment per code point (simple + always correct), plus the 0xFFFF guard.
  const cps = [...map.keys()].filter((cp) => cp < 0xffff).sort((a, b) => a - b);
  const segStart: number[] = [];
  const segEnd: number[] = [];
  const segDelta: number[] = [];
  for (const cp of cps) {
    const gid = map.get(cp)!;
    segStart.push(cp);
    segEnd.push(cp);
    segDelta.push((gid - cp) & 0xffff);
  }
  // Required final segment: 0xFFFF → glyph 0.
  segStart.push(0xffff);
  segEnd.push(0xffff);
  segDelta.push(1);

  const segCount = segStart.length;
  const sub = new Writer();
  const entrySelector = Math.floor(Math.log2(segCount));
  const searchRange = 2 * 2 ** entrySelector;
  const rangeShift = 2 * segCount - searchRange;
  sub.uint16(4); // format
  const lengthPos = sub.length;
  sub.uint16(0); // length (patched below)
  sub.uint16(0); // language
  sub.uint16(2 * segCount);
  sub.uint16(searchRange);
  sub.uint16(entrySelector);
  sub.uint16(rangeShift);
  for (const e of segEnd) sub.uint16(e);
  sub.uint16(0); // reservedPad
  for (const s of segStart) sub.uint16(s);
  for (const d of segDelta) sub.int16(d);
  for (let i = 0; i < segCount; i += 1) sub.uint16(0); // idRangeOffset (all 0)
  const subBytes = sub.toBytes();
  // Patch subtable length.
  subBytes[lengthPos] = (subBytes.length >>> 8) & 0xff;
  subBytes[lengthPos + 1] = subBytes.length & 0xff;

  const cmap = new Writer();
  cmap.uint16(0); // version
  cmap.uint16(1); // numTables
  cmap.uint16(3); // platformID = Windows
  cmap.uint16(1); // encodingID = Unicode BMP
  cmap.uint32(12); // offset to subtable (4-byte header + one 8-byte record)
  cmap.raw(subBytes);
  return cmap.toBytes();
}

/** Zero-pad a byte array up to a multiple of 4 (sfnt table alignment). */
function pad4(bytes: Uint8Array): Uint8Array {
  const rem = bytes.length % 4;
  if (rem === 0) return bytes;
  const out = new Uint8Array(bytes.length + (4 - rem));
  out.set(bytes);
  return out;
}
