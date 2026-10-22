/**
 * `fontface.ts` — `@font-face` descriptor parsing (RFC 0006).
 *
 * The css-parser preserves `@font-face` blocks as raw declaration lists on
 * `StyleSheet.fontFaces`; THIS module turns a declaration list into a typed
 * {@link FontFaceDescriptor}: the declared family, the ordered `src` source
 * list (`local()`/`url()` + `format()`/`tech()` hints), and the face
 * descriptors (`font-weight` incl. ranges, `font-style`, `font-stretch`) that
 * OVERRIDE the face's own name-table metadata when matching (CSS Fonts §4.3:
 * the descriptor describes the downloaded face — a Regular file declared as
 * `font-weight: 700` IS the family's bold member).
 *
 * Everything here is pure string parsing — no I/O. Fetching `url()` bytes and
 * resolving `local()` names belongs to the wiring layer (cli's webfonts.ts).
 */

/** One `src` item, in descriptor order. */
export type FontFaceSource =
  | { readonly kind: "local"; readonly name: string }
  | {
      readonly kind: "url";
      readonly url: string;
      /** Lowercased `format()` hint (`"truetype"`, `"woff"`, `"woff2"`, …). */
      readonly format?: string | undefined;
    };

/** The parsed `@font-face` block. */
export interface FontFaceDescriptor {
  /** The declared family name (required — a face with no family matches nothing). */
  readonly family: string;
  /** Ordered `src` candidates — first usable wins. */
  readonly sources: readonly FontFaceSource[];
  /** Declared weight: a single class, or an inclusive `[lo, hi]` range. */
  readonly weight: { readonly lo: number; readonly hi: number };
  /** Declared style: true ⇔ italic/oblique (angle unimplemented — oblique counts as italic). */
  readonly italic: boolean;
  /** Declared stretch as an OS/2 width class 1..9 (5 = normal). */
  readonly widthClass: number;
}

/** Minimal declaration shape — structurally satisfied by the IR `Declaration`. */
interface Decl {
  readonly property: string;
  readonly value: string;
}

/** Split on commas not inside parentheses or quotes (for `src` lists). */
function splitTopLevelCommas(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]!;
    if (quote !== null) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "(") { depth += 1; continue; }
    if (ch === ")") { depth = Math.max(0, depth - 1); continue; }
    if (ch === "," && depth === 0) {
      out.push(value.slice(start, i));
      start = i + 1;
    }
  }
  out.push(value.slice(start));
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Strip surrounding quotes from a `local()` argument / bare string, and fold
 * CSS escapes minimally (`\"` → `"`, `\\` → `\` — the common cases).
 */
function unquote(s: string): string {
  const t = s.trim();
  const m = /^(['"])(.*)\1$/s.exec(t);
  const inner = m !== null ? (m[2] ?? "") : t;
  return inner.replace(/\\(.)/g, "$1").trim();
}

/** Parse one `src` item into a source, or `null` when unparseable. */
function parseSource(item: string): FontFaceSource | null {
  let m = /^local\(\s*(.*?)\s*\)\s*(.*)$/is.exec(item);
  if (m !== null) {
    const name = unquote(m[1] ?? "");
    if (name === "") return null;
    // Trailing `format()`/`tech()` after local() is malformed; accept anyway.
    return { kind: "local", name };
  }
  m = /^url\(\s*(.*?)\s*\)\s*(.*)$/is.exec(item);
  if (m === null) return null;
  const url = unquote(m[1] ?? "");
  if (url === "") return null;
  const rest = (m[2] ?? "").trim();
  const fm = /^format\(\s*(.*?)\s*\)/is.exec(rest);
  const tm = /^tech\(\s*(.*?)\s*\)/is.exec(rest);
  const format = fm !== null ? unquote(fm[1] ?? "").toLowerCase() : undefined;
  if (tm !== null) {
    // `tech()` we don't implement (variations/color/palettes negotiated
    // elsewhere) — any declared tech we can't satisfy disqualifies the source.
    const techs = unquote(tm[1] ?? "").toLowerCase();
    const known = new Set(["variations", "color-cbdt", "color-colrv0", "color-colrv1", "color-sbix", "color-svg", "palettes", "incremental"]);
    if (techs.split(/\s+/).some((t) => !known.has(t))) return null;
  }
  return format === undefined
    ? { kind: "url", url }
    : { kind: "url", url, format };
}

const STRETCH_CLASSES: Readonly<Record<string, number>> = {
  "ultra-condensed": 1,
  "extra-condensed": 2,
  condensed: 3,
  "semi-condensed": 4,
  normal: 5,
  "semi-expanded": 6,
  expanded: 7,
  "extra-expanded": 8,
  "ultra-expanded": 9,
};

/** Parse a `font-stretch` DESCRIPTOR value (keyword or %) → width class 1..9. */
function stretchDescriptor(value: string): number {
  const v = value.trim().toLowerCase();
  if (v in STRETCH_CLASSES) return STRETCH_CLASSES[v] ?? 5;
  const pct = Number.parseFloat(v);
  if (v.endsWith("%") && !Number.isNaN(pct) && pct > 0) {
    const bands = [50, 62.5, 75, 87.5, 100, 112.5, 125, 150, 200];
    let best = 5;
    let dist = Infinity;
    bands.forEach((b, i) => {
      const d = Math.abs(pct - b);
      if (d < dist) { dist = d; best = i + 1; }
    });
    return best;
  }
  return 5;
}

/**
 * Parse an `@font-face` declaration list into a descriptor. Returns `null`
 * when the block lacks the two REQUIRED descriptors (`font-family` or a usable
 * `src`) — per CSS Fonts §4.4 the rule is then invalid and dropped.
 */
export function parseFontFaceRule(decls: readonly Decl[]): FontFaceDescriptor | null {
  let family: string | null = null;
  const sources: FontFaceSource[] = [];
  let weight: { lo: number; hi: number } = { lo: 400, hi: 400 };
  let italic = false;
  let widthClass = 5;

  for (const decl of decls) {
    const prop = decl.property.trim().toLowerCase();
    const value = decl.value.trim();
    switch (prop) {
      case "font-family": {
        family = unquote(value).toLowerCase();
        break;
      }
      case "src": {
        for (const item of splitTopLevelCommas(value)) {
          const src = parseSource(item);
          if (src !== null) sources.push(src);
        }
        break;
      }
      case "font-weight": {
        const nums = value.split(/\s+/).map((t) => Number.parseInt(t, 10)).filter((n) => !Number.isNaN(n));
        if (nums.length >= 2) weight = { lo: Math.min(nums[0]!, nums[1]!), hi: Math.max(nums[0]!, nums[1]!) };
        else if (nums.length === 1) weight = { lo: nums[0]!, hi: nums[0]! };
        else if (value.toLowerCase() === "bold") weight = { lo: 700, hi: 700 };
        else if (value.toLowerCase() === "normal") weight = { lo: 400, hi: 400 };
        break;
      }
      case "font-style": {
        const v = value.toLowerCase();
        italic = v.startsWith("italic") || v.startsWith("oblique");
        break;
      }
      case "font-stretch": {
        widthClass = stretchDescriptor(value);
        break;
      }
      default:
        break; // unicode-range/font-display/feature descriptors — not consumed.
    }
  }

  if (family === null || family === "" || sources.length === 0) return null;
  return { family, sources, weight, italic, widthClass };
}

/** Extract the descriptors of every `fontFaces` rule on a sheet list. */
export function collectFontFaceDescriptors(
  sheets: readonly { readonly fontFaces?: readonly { readonly declarations: readonly Decl[] }[] | undefined }[],
): FontFaceDescriptor[] {
  const out: FontFaceDescriptor[] = [];
  for (const sheet of sheets) {
    for (const rule of sheet.fontFaces ?? []) {
      const d = parseFontFaceRule(rule.declarations);
      if (d !== null) out.push(d);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Source bytes → FontFace (pure decode — no I/O).
// ---------------------------------------------------------------------------

import { parseTrueType } from "./truetype.js";
import { isWoff, unwrapWoff } from "./woff.js";
import type { FontFace } from "./types.js";

/** sfnt flavor magics we can decode: TrueType, ttcf collections, `true`. */
function isSfnt(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
  return v === 0x00010000 || v === 0x74746366 || v === 0x74727565;
}

/**
 * Whether a declared `format()` hint names a container we can decode. An
 * unsupported format disqualifies only that `src` item (CSS Fonts §4.3 walks
 * the list). `undefined` (no hint) is optimistic — the byte sniff decides.
 */
export function fontFaceFormatSupported(format: string | undefined): boolean {
  if (format === undefined) return true;
  return new Set([
    "truetype",
    "opentype",
    "truetype-variations",
    "opentype-variations",
    "woff",
    "collection",
  ]).has(format);
}

/**
 * Decode `src: url()` bytes into the first usable {@link FontFace}: WOFF is
 * unwrapped to sfnt, then `parseTrueType` builds face 0. Returns `null` for
 * formats we cannot rasterize (WOFF2/brotli, CFF-only `.otf`) — the caller
 * moves to the next `src` item, exactly the spec's source-list walk.
 */
export function faceFromSourceBytes(bytes: Uint8Array): FontFace | null {
  try {
    const sfnt = isWoff(bytes) ? unwrapWoff(bytes) : isSfnt(bytes) ? bytes : null;
    if (sfnt === null) return null;
    return parseTrueType(sfnt, 0);
  } catch {
    return null;
  }
}
