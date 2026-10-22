/**
 * `names.ts` — the CHEAP half of font discovery (RFC 0005): read an sfnt's
 * `name` + `OS/2` tables without touching glyph data. `readSfntFaceInfo`
 * scans a font file (or a `ttcf` collection — every member) and returns the
 * metadata `font-family` matching needs: family/subfamily names, weight and
 * width classes, italic flag.
 *
 * This is the ONLY reader of the `name`/`OS/2` tables; {@link parseTrueType}
 * keeps parsing metrics/outlines and callers combine the two views.
 */
import { closeSync, openSync, readSync } from "node:fs";

import { Reader } from "./sfnt.js";

/** name-table IDs we consume (OpenType spec, `name` table). */
const NAME = {
  family: 1, // legacy family ("Arial Bold" style)
  subfamily: 2, // legacy subfamily ("Bold")
  fullName: 4,
  postscriptName: 6,
  typographicFamily: 16, // preferred family ("Arial")
  typographicSubfamily: 17, // preferred subfamily ("Bold")
} as const;

/** Per-face discovery record — what `font-family`/`font-weight` match on. */
export interface SfntFaceInfo {
  /** Index inside a `ttcf` collection (0 for a standalone sfnt). */
  readonly faceIndex: number;
  /** CSS `font-family` name (typographic family preferred, else legacy). */
  readonly family: string | null;
  /** Subfamily/style name ("Regular", "Bold", "Italic", …). */
  readonly subfamily: string | null;
  readonly fullName: string | null;
  readonly postscriptName: string | null;
  /** OS/2 `usWeightClass` (1–1000); `null` when the table is absent. */
  readonly weightClass: number | null;
  /** OS/2 `usWidthClass` (1–9); `null` when absent. */
  readonly widthClass: number | null;
  /** fsSelection bit 0 (ITALIC) or an italic-looking subfamily name. */
  readonly italic: boolean;
  /**
   * `@font-face` weight RANGE descriptor (RFC 0006): when a stylesheet declares
   * `font-weight: 100 900`, the face serves the whole span — matching treats a
   * request inside the range as an exact hit, not a distance. Absent ⇒ the
   * single `weightClass` applies.
   */
  readonly weightRange?: readonly [number, number] | undefined;
}

interface TableRec {
  readonly offset: number;
  readonly length: number;
}

/** Read the sfnt table directory at `base` (0 for standalone files). */
function readTableDir(r: Reader, base: number): Map<string, TableRec> {
  r.seek(base);
  const sfntVersion = r.uint32();
  if (sfntVersion === 0x74746366) {
    throw new Error("font: ttcf passed to readTableDir — iterate members instead");
  }
  // 0x00010000 / "true" / "typ1" / "OTTO" all share the directory layout.
  if (
    sfntVersion !== 0x00010000 &&
    sfntVersion !== 0x74727565 &&
    sfntVersion !== 0x74797031 &&
    sfntVersion !== 0x4f54544f
  ) {
    throw new Error(`font: not an sfnt (magic 0x${sfntVersion.toString(16)})`);
  }
  const numTables = r.uint16();
  r.skip(6); // searchRange, entrySelector, rangeShift
  const tables = new Map<string, TableRec>();
  for (let i = 0; i < numTables; i += 1) {
    const tag = r.tag();
    r.uint32(); // checksum
    const offset = r.uint32();
    const length = r.uint32();
    tables.set(tag, { offset, length });
  }
  return tables;
}

/** Decode one name record: Windows/Unicode platforms are UTF-16BE; Mac is byte-safe. */
function decodeName(
  bytes: Uint8Array,
  platformId: number,
  offset: number,
  length: number,
): string {
  const slice = bytes.subarray(offset, offset + length);
  if (platformId === 0 || platformId === 3) {
    let out = "";
    for (let i = 0; i + 1 < slice.length; i += 2) {
      out += String.fromCharCode(((slice[i] ?? 0) << 8) | (slice[i + 1] ?? 0));
    }
    return out;
  }
  // Macintosh platform names are MacRoman; the ASCII range round-trips and
  // that is all real family names need.
  return String.fromCharCode(...slice);
}

interface NameRecord {
  readonly platformId: number;
  readonly languageId: number;
  readonly nameId: number;
  readonly text: string;
}

function readNameTable(r: Reader, rec: TableRec): NameRecord[] {
  r.seek(rec.offset);
  r.uint16(); // format
  const count = r.uint16();
  const storage = rec.offset + r.uint16();
  const records: NameRecord[] = [];
  for (let i = 0; i < count; i += 1) {
    const platformId = r.uint16();
    r.uint16(); // encodingID
    const languageId = r.uint16();
    const nameId = r.uint16();
    const length = r.uint16();
    const offset = r.uint16();
    if (offset + length <= rec.length) {
      records.push({
        platformId,
        languageId,
        nameId,
        text: decodeName(r.bytes, platformId, storage + offset, length),
      });
    }
  }
  return records;
}

/**
 * Pick the best record for `nameId`: Windows-English and Unicode platforms
 * first, then anything at all (a Japanese-only name beats no name).
 */
function pick(records: readonly NameRecord[], nameId: number): string | null {
  let fallback: string | null = null;
  for (const rec of records) {
    if (rec.nameId !== nameId || rec.text.length === 0) continue;
    if (fallback === null) fallback = rec.text;
    if (rec.platformId === 3 && (rec.languageId === 0x409 || fallback === null)) return rec.text;
    if (rec.platformId === 0) return rec.text;
  }
  return fallback;
}

function readOs2(r: Reader, rec: TableRec | undefined): {
  weightClass: number | null;
  widthClass: number | null;
  italic: boolean;
} {
  if (rec === undefined || rec.length < 64) {
    return { weightClass: null, widthClass: null, italic: false };
  }
  r.seek(rec.offset + 4);
  const weightClass = r.uint16();
  const widthClass = r.uint16();
  r.seek(rec.offset + 62); // fsSelection
  const fsSelection = r.uint16();
  return { weightClass, widthClass, italic: (fsSelection & 0x1) !== 0 };
}

function faceInfoAt(r: Reader, base: number, faceIndex: number): SfntFaceInfo {
  const tables = readTableDir(r, base);
  const nameRec = tables.get("name");
  let family: string | null = null;
  let subfamily: string | null = null;
  let fullName: string | null = null;
  let postscriptName: string | null = null;
  if (nameRec !== undefined) {
    const records = readNameTable(r, nameRec);
    family = pick(records, NAME.typographicFamily) ?? pick(records, NAME.family);
    subfamily = pick(records, NAME.typographicSubfamily) ?? pick(records, NAME.subfamily);
    fullName = pick(records, NAME.fullName);
    postscriptName = pick(records, NAME.postscriptName);
  }
  const os2 = readOs2(r, tables.get("OS/2"));
  const italic = os2.italic || /italic|oblique/i.test(subfamily ?? "");
  return {
    faceIndex,
    family,
    subfamily,
    fullName,
    postscriptName,
    weightClass: os2.weightClass,
    widthClass: os2.widthClass,
    italic,
  };
}

/**
 * Read face metadata from an sfnt buffer — every member of a `ttcf` collection,
 * or the single face of a standalone font. Throws only on non-sfnt bytes.
 */
export function readSfntFaceInfo(bytes: Uint8Array): SfntFaceInfo[] {
  const r = new Reader(bytes);
  const magic = r.uint32();
  if (magic === 0x74746366) {
    // "ttcf": version(4) numFonts(4) offsets[numFonts]
    r.skip(4);
    const numFonts = r.uint32();
    const infos: SfntFaceInfo[] = [];
    for (let i = 0; i < numFonts; i += 1) {
      const base = r.uint32();
      infos.push(faceInfoAt(new Reader(bytes), base, i));
    }
    return infos;
  }
  return [faceInfoAt(r, 0, 0)];
}

/**
 * The file-backed variant for registry probing (RFC 0005): reads ONLY the
 * sfnt directory plus the `name`/`OS/2` table ranges — a font directory scan
 * never loads glyph data, so probing a whole system font folder is cheap.
 */
export function readSfntFaceInfoFromFile(path: string): SfntFaceInfo[] {
  const fd = openSync(path, "r");
  try {
    const read = (offset: number, length: number): Uint8Array => {
      const buf = new Uint8Array(length);
      const got = readSync(fd, buf, 0, length, offset);
      return buf.subarray(0, got);
    };
    const header = read(0, 16 * 1024); // directory (+ ttcf member dirs) fits.
    if (header.length < 12) return [];
    const hr = new Reader(header);
    const magic = hr.uint32();
    const bases: number[] = [];
    if (magic === 0x74746366) {
      hr.skip(4);
      const numFonts = hr.uint32();
      for (let i = 0; i < numFonts; i += 1) {
        const off = hr.uint32();
        const memberDir = read(off, 4);
        if (memberDir.length < 4) continue;
        bases.push(off);
      }
    } else {
      bases.push(0);
    }
    const infos: SfntFaceInfo[] = [];
    for (let i = 0; i < bases.length; i += 1) {
      const base = bases[i]!;
      const dirBytes = base === 0 ? header : read(base, 16 * 1024);
      const dr = new Reader(dirBytes);
      const tables = readTableDir(dr, 0);
      const nameRec = tables.get("name");
      const os2Rec = tables.get("OS/2");
      if (nameRec === undefined) {
        infos.push({
          faceIndex: i,
          family: null,
          subfamily: null,
          fullName: null,
          postscriptName: null,
          weightClass: null,
          widthClass: null,
          italic: false,
        });
        continue;
      }
      const nameBytes = read(nameRec.offset, nameRec.length);
      const nr = new Reader(nameBytes);
      const records = readNameTable(nr, { offset: 0, length: nameBytes.length });
      const family = pick(records, NAME.typographicFamily) ?? pick(records, NAME.family);
      const os2 =
        os2Rec === undefined
          ? { weightClass: null, widthClass: null, italic: false }
          : readOs2(new Reader(read(os2Rec.offset, Math.min(os2Rec.length, 78))), {
              offset: 0,
              length: Math.min(os2Rec.length, 78),
            });
      const subfamily =
        pick(records, NAME.typographicSubfamily) ?? pick(records, NAME.subfamily);
      infos.push({
        faceIndex: i,
        family,
        subfamily,
        fullName: pick(records, NAME.fullName),
        postscriptName: pick(records, NAME.postscriptName),
        weightClass: os2.weightClass,
        widthClass: os2.widthClass,
        italic: os2.italic || /italic|oblique/i.test(subfamily ?? ""),
      });
    }
    return infos;
  } finally {
    closeSync(fd);
  }
}
