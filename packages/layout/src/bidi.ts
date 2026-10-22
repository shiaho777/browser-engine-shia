/**
 * Bidirectional text ordering + complex-script support (task 9.1; design.md §5
 * Phase 8+; Requirement 17.1 — "THE Layout_Engine SHALL support bidirectional
 * text ordering and complex-script shaping").
 *
 * ## What this module owns vs reuses (the §11 boundary)
 *
 * The reuse boundary (Requirement 8.1, design.md §11) says complex-script
 * SHAPING (glyph selection, ligatures, mark positioning, reordering within a
 * cluster) is reused from HarfBuzz at the {@link TextShaper} seam. What the
 * ENGINE owns is the part that demonstrates "reading the Web": the **bidi
 * algorithm** that decides the VISUAL order of runs (UAX #9), and the
 * segmentation of a paragraph into directional + script runs that the shaper is
 * then invoked on. So this module:
 *
 *   1. classifies each character into the UAX #9 bidi classes — strongs
 *      (L / R / AL), weak types (EN / ES / ET / AN / CS / NSM), neutrals
 *      (B / S / WS / ON), boundary neutrals (BN) and the explicit-format
 *      characters (LRE / RLE / PDF / LRO / RLO / LRI / RLI / FSI / PDI);
 *   2. assigns each paragraph's base direction (explicit, or the first strong
 *      character — UAX #9 rules P1–P3);
 *   3. resolves per-character embedding levels: explicit embeddings,
 *      overrides and isolates on a directional-status stack (X1–X10), weak
 *      types (W1–W7), paired brackets and neutrals (N0–N2), and the implicit
 *      level assignment (I1/I2);
 *   4. produces the VISUAL run order by reversing maximal sequences at or
 *      above each level (the UAX #9 L2 reordering), so an RTL run inside LTR
 *      text is emitted right-to-left;
 *   5. itemizes multi-owner text — layout feeds a paragraph as ordered pieces
 *      (text members + U+FFFC placeholders for atomic inline boxes + injected
 *      element-scope control characters), and {@link visualOrderParts} hands
 *      back visual-order fragments tagged with their owner so each piece is
 *      shaped/measured with its own font.
 *
 * It also segments a string into **script runs** (Latin / Arabic / Hebrew /
 * Han / …) so a complex-script shaper is invoked per homogeneous run — the
 * standard "itemize, then shape each item" pipeline HarfBuzz expects.
 *
 * Honest bounds (kept deliberately): Bidi_Class lookup is range-table based,
 * not the full UCD (unlisted scripts default to ON, mirrored glyph
 * substitution is left to the font); the bracket-pair table covers the ASCII
 * pairs `()[]{}`; L1 (per-line trailing-whitespace level reset) is not run —
 * line breaking feeds the algorithm whole paragraphs.
 *
 * This module is part of the *layout* stage and imports ONLY the frozen IR — it
 * reaches across no stage boundary (`local/no-cross-stage-import`).
 */

/** A character's UAX #9 bidi class. */
export type BidiClass =
  | "L" // strong left-to-right
  | "R" // strong right-to-left (Hebrew, Samaritan, …)
  | "AL" // strong right-to-left Arabic (Arabic, Syriac, Thaana, …)
  | "EN" // European number
  | "ES" // European number separator (+ −)
  | "ET" // European number terminator ($ % ° currency signs)
  | "AN" // Arabic number
  | "CS" // common number separator (, . : /)
  | "NSM" // nonspacing mark
  | "BN" // boundary neutral (format chars, controls)
  | "B" // paragraph separator
  | "S" // segment separator (tab)
  | "WS" // whitespace
  | "ON" // other neutral
  | "LRE" | "RLE" | "PDF" // explicit embeddings
  | "LRO" | "RLO" // explicit overrides
  | "LRI" | "RLI" | "FSI" | "PDI"; // isolates

/** The base direction of a paragraph. */
export type Direction = "ltr" | "rtl";

/** The explicit-format control code points (UAX #9 X rules / HTML bidi). */
export const BIDI_CTRL = {
  LRE: 0x202a,
  RLE: 0x202b,
  PDF: 0x202c,
  LRO: 0x202d,
  RLO: 0x202e,
  LRI: 0x2066,
  RLI: 0x2067,
  FSI: 0x2068,
  PDI: 0x2069,
} as const;

/** One contiguous run of text at a single resolved embedding level. */
export interface BidiRun {
  /** Source start index (inclusive) of the run, in code points. */
  readonly start: number;
  /** Source end index (exclusive) of the run, in code points. */
  readonly end: number;
  /** The run's resolved embedding level (even = LTR, odd = RTL). */
  readonly level: number;
  /** The run's substring, in LOGICAL (source) order, control chars removed. */
  readonly text: string;
}

// ---------------------------------------------------------------------------
// Character classification (UAX #9 Bidi_Class, range-table approximation).
// ---------------------------------------------------------------------------

/** Whether `cp` (a code point) falls inside any `[from,to]` range. */
function inRanges(cp: number, ranges: readonly (readonly [number, number])[]): boolean {
  for (const [a, b] of ranges) {
    if (cp >= a && cp <= b) return true;
  }
  return false;
}

/** Combining marks (Bidi_Class NSM). */
const NSM_RANGES: readonly (readonly [number, number])[] = [
  [0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x05bf, 0x05bf],
  [0x05c1, 0x05c2], [0x05c4, 0x05c5], [0x05c7, 0x05c7], [0x0610, 0x061a],
  [0x064b, 0x065f], [0x0670, 0x0670], [0x06d6, 0x06dc], [0x06df, 0x06e4],
  [0x06e7, 0x06e8], [0x06ea, 0x06ed], [0x20d0, 0x20f0], [0xfe00, 0xfe0f],
  [0xfe20, 0xfe2f], [0x0e31, 0x0e31], [0x0e34, 0x0e3a], [0x0e47, 0x0e4e],
];

/**
 * Boundary neutrals — zero-width/format characters dropped by rule X9.
 * U+00AD (SOFT HYPHEN), U+200B (ZERO WIDTH SPACE), U+2060/U+FEFF (word
 * joiners) are deliberately NOT here: all four carry UAX #14 semantics — shy
 * and ZWSP are conditional break opportunities, WJ forbids them — so they
 * flow through bidi as ON neutrals and the line-break stage consumes them
 * into unit boundaries (they still never reach the shaper).
 */
const BN_POINTS: ReadonlySet<number> = new Set([
  0x061c, 0x180e, 0x200c, 0x200d, 0x200e, 0x200f,
  0x2061, 0x2062, 0x2063, 0x2064,
]);

/** Classify a single code point's UAX #9 bidi class (range-table subset). */
export function bidiClass(ch: string): BidiClass {
  const cp = ch.codePointAt(0) ?? 0;

  // Explicit-format characters first — they drive the X rules.
  switch (cp) {
    case BIDI_CTRL.LRE: return "LRE";
    case BIDI_CTRL.RLE: return "RLE";
    case BIDI_CTRL.PDF: return "PDF";
    case BIDI_CTRL.LRO: return "LRO";
    case BIDI_CTRL.RLO: return "RLO";
    case BIDI_CTRL.LRI: return "LRI";
    case BIDI_CTRL.RLI: return "RLI";
    case BIDI_CTRL.FSI: return "FSI";
    case BIDI_CTRL.PDI: return "PDI";
    default: break;
  }

  // Paragraph separators (B) — hard paragraph boundaries.
  if (cp === 0x000a || cp === 0x000b || cp === 0x000c || cp === 0x000d ||
      cp === 0x0085 || cp === 0x2028 || cp === 0x2029) {
    return "B";
  }
  // Segment separator (S): tab.
  if (cp === 0x0009) return "S";
  // Whitespace.
  if (cp === 0x0020 || cp === 0x00a0 || cp === 0x1680 ||
      (cp >= 0x2000 && cp <= 0x200a) || cp === 0x202f || cp === 0x205f || cp === 0x3000) {
    return "WS";
  }
  // Boundary neutrals.
  if (BN_POINTS.has(cp) || (cp >= 0xfff9 && cp <= 0xfffb)) return "BN";

  // European numbers.
  if ((cp >= 0x0030 && cp <= 0x0039) || cp === 0x00b2 || cp === 0x00b3 || cp === 0x00b9 ||
      (cp >= 0x2070 && cp <= 0x2079) || (cp >= 0x2080 && cp <= 0x2089) ||
      (cp >= 0xff10 && cp <= 0xff19)) {
    return "EN";
  }
  // European number separators/terminators.
  if (cp === 0x002b || cp === 0x2212 || cp === 0xff0b) return "ES";
  if (
    cp === 0x0024 || cp === 0x0025 || cp === 0x0040 || (cp >= 0x00a2 && cp <= 0x00a5) ||
    cp === 0x058f || cp === 0x060b || cp === 0x09f2 || cp === 0x09f3 || cp === 0x0e3f ||
    cp === 0x17db || (cp >= 0x20a0 && cp <= 0x20bf) || cp === 0xfe69 || cp === 0xff04 ||
    cp === 0xff05 || cp === 0xffe0 || cp === 0xffe1 || cp === 0xffe5 || cp === 0xffe6
  ) {
    return "ET";
  }
  // Common number separators.
  if (
    cp === 0x002c || cp === 0x002e || cp === 0x002f || cp === 0x003a || cp === 0x00b7 ||
    cp === 0x060c || cp === 0x066b || cp === 0x066c || cp === 0xff0c || cp === 0xff0e ||
    cp === 0xff0f || cp === 0xff1a
  ) {
    return "CS";
  }
  // Arabic-Indic digits.
  if ((cp >= 0x0660 && cp <= 0x0669) || (cp >= 0x06f0 && cp <= 0x06f9)) return "AN";
  // Arabic number signs (U+0600–0605 have Bidi_Class ET per the UCD).
  if (cp >= 0x0600 && cp <= 0x0605) return "ET";

  // Strong RTL (R): Hebrew + Samaritan + Hebrew presentation forms + RTL
  // alphabetic plane-1 scripts (Phoenician/Imperial Aramaic/Lydian …).
  if (
    (cp >= 0x0590 && cp <= 0x05ff) || (cp >= 0xfb1d && cp <= 0xfb4f) ||
    (cp >= 0x0800 && cp <= 0x083f) || (cp >= 0x10800 && cp <= 0x10fff)
  ) {
    return "R";
  }
  // Strong Arabic (AL): Arabic, Arabic Supplement/Extended, Syriac, Thaana,
  // NKo, Mandaic + presentation forms.
  if (
    (cp >= 0x0600 && cp <= 0x06ff) || (cp >= 0x0750 && cp <= 0x077f) ||
    (cp >= 0x07c0 && cp <= 0x07ff) || (cp >= 0x0840 && cp <= 0x085f) ||
    (cp >= 0x08a0 && cp <= 0x08ff) || (cp >= 0xfb50 && cp <= 0xfdff) ||
    (cp >= 0xfe70 && cp <= 0xfeff)
  ) {
    return "AL";
  }
  // Syriac + Thaana.
  if ((cp >= 0x0700 && cp <= 0x074f) || (cp >= 0x0780 && cp <= 0x07bf)) return "AL";

  // Nonspacing marks.
  if (inRanges(cp, NSM_RANGES)) return "NSM";

  // Strong LTR (L): Latin, Greek, Cyrillic, Indic, Thai, CJK, Hangul and the
  // main alphabetic blocks (pragmatic coverage of the L-script space).
  if (
    (cp >= 0x0041 && cp <= 0x005a) || (cp >= 0x0061 && cp <= 0x007a) ||
    (cp >= 0x00c0 && cp <= 0x02af) || (cp >= 0x02b0 && cp <= 0x02ff) ||
    (cp >= 0x0370 && cp <= 0x058f) || // Greek, Cyrillic, Armenian
    (cp >= 0x0900 && cp <= 0x0d7f) || // Indic blocks
    (cp >= 0x0e00 && cp <= 0x0e7f) || // Thai, Lao
    (cp >= 0x10a0 && cp <= 0x10ff) || // Georgian
    (cp >= 0x1100 && cp <= 0x11ff) || // Hangul jamo
    (cp >= 0x1e00 && cp <= 0x1eff) || // Latin extended additional
    (cp >= 0x2e80 && cp <= 0x9fff) || // CJK
    (cp >= 0xa000 && cp <= 0xa4ff) || // Yi
    (cp >= 0xac00 && cp <= 0xd7af) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat ideographs
    (cp >= 0xff21 && cp <= 0xff3a) || (cp >= 0xff41 && cp <= 0xff5a)
  ) {
    return "L";
  }

  // Everything else (punctuation, symbols, emoji, unlisted scripts) is neutral.
  return "ON";
}

/** Whether a bidi class is a strong right-to-left type (R or AL). */
function isRtlStrong(cls: BidiClass): boolean {
  return cls === "R" || cls === "AL";
}

/** Strong-type direction for neutral/bracket resolution: EN/AN count as R. */
function strongOf(cls: BidiClass): "L" | "R" | null {
  if (cls === "L") return "L";
  if (cls === "R" || cls === "AL" || cls === "EN" || cls === "AN") return "R";
  return null;
}

// ---------------------------------------------------------------------------
// Base direction (UAX #9 P2/P3): first strong character decides, default LTR.
// ---------------------------------------------------------------------------

/**
 * Determine a paragraph's base direction (UAX #9 P2/P3): the direction of the
 * first STRONG character (L ⇒ ltr, R/AL ⇒ rtl); with no strong character the
 * base is LTR. An explicit `override` short-circuits the heuristic.
 */
export function baseDirection(text: string, override?: Direction): Direction {
  if (override !== undefined) {
    return override;
  }
  for (const ch of text) {
    const cls = bidiClass(ch);
    if (cls === "L") return "ltr";
    if (isRtlStrong(cls)) return "rtl";
  }
  return "ltr";
}

// ---------------------------------------------------------------------------
// Embedding-level resolution — UAX #9 X + W + N + I rules.
// ---------------------------------------------------------------------------

/** Max explicit embedding depth (UAX #9 X2 note / implementations cap at 125). */
const MAX_DEPTH = 125;

/** One entry of the directional-status stack used by the X rules. */
interface StatusFrame {
  readonly level: number;
  readonly override: "L" | "R" | "neutral";
  readonly isolate: boolean;
}

/** The least embedding level above `cur` with parity `even`. */
function bumpLevel(cur: number, even: boolean): number {
  const next = cur + 1;
  return next % 2 === (even ? 0 : 1) ? next : next + 1;
}

/**
 * The first strong type inside the isolate opened at `fsiIndex` (UAX #9 X5c):
 * scan forward to the matching PDI counting only depth-1 content (nested
 * isolates' interiors are skipped); default "L" when none is found.
 */
function isolateInnerDirection(classes: readonly BidiClass[], fsiIndex: number): "L" | "R" {
  let depth = 1;
  for (let i = fsiIndex + 1; i < classes.length; i += 1) {
    const c = classes[i]!;
    if (c === "LRI" || c === "RLI" || c === "FSI") {
      depth += 1;
    } else if (c === "PDI") {
      depth -= 1;
      if (depth === 0) break;
    } else if (depth === 1) {
      if (c === "L") return "L";
      if (isRtlStrong(c)) return "R";
    }
  }
  return "L";
}

interface ResolvedParagraph {
  /** Per-index final embedding level (removed chars get the paragraph base). */
  readonly levels: number[];
  /** Per-index removal flag (explicit-format + BN characters; X9/X10). */
  readonly removed: boolean[];
}

/**
 * The canonical pair-matching brackets we resolve in N0 (BidiBrackets subset:
 * the three ASCII pairs — the documented honest bound).
 */
const BRACKET_OPEN = new Map<string, string>([["(", ")"], ["[", "]"], ["{", "}"]]);
const BRACKET_CLOSE = new Map<string, string>([[")", "("], ["]", "["], ["}", "{"]]);

/**
 * Resolve embedding levels for ONE paragraph (`classes`/`chars` are parallel
 * code-point arrays with no B-class entries) under base level `baseLevel`.
 * Runs X1–X10 (explicit embeddings/overrides/isolates), W1–W7 (weak types),
 * N0–N2 (brackets + neutrals) and I1/I2 (implicit levels) in order.
 */
function resolveParagraph(
  chars: readonly string[],
  classes: readonly BidiClass[],
  baseLevel: number,
): ResolvedParagraph {
  const n = chars.length;
  const types: BidiClass[] = classes.slice();
  const levels = new Array<number>(n).fill(baseLevel);
  const removed = new Array<boolean>(n).fill(false);

  // ---- X rules: embeddings, overrides, isolates on a status stack ---------
  const stack: StatusFrame[] = [{ level: baseLevel, override: "neutral", isolate: false }];
  const top = (): StatusFrame => stack[stack.length - 1]!;
  for (let i = 0; i < n; i += 1) {
    const cls = classes[i]!;
    switch (cls) {
      case "LRE":
      case "RLE":
      case "LRO":
      case "RLO": {
        removed[i] = true;
        const even = cls === "LRE" || cls === "LRO";
        const newLevel = bumpLevel(top().level, even);
        if (newLevel <= MAX_DEPTH) {
          const override = cls === "LRO" ? "L" : cls === "RLO" ? "R" : "neutral";
          stack.push({ level: newLevel, override, isolate: false });
        }
        break;
      }
      case "LRI":
      case "RLI":
      case "FSI": {
        removed[i] = true;
        const dir = cls === "LRI" ? "L" : cls === "RLI" ? "R" : isolateInnerDirection(classes, i);
        const newLevel = bumpLevel(top().level, dir === "L");
        if (newLevel <= MAX_DEPTH) {
          stack.push({ level: newLevel, override: "neutral", isolate: true });
        }
        break;
      }
      case "PDI": {
        removed[i] = true;
        // Pop everything up to and including the nearest isolate entry.
        for (let k = stack.length - 1; k >= 1; k -= 1) {
          if (stack[k]!.isolate) {
            stack.length = k;
            break;
          }
        }
        break;
      }
      case "PDF": {
        removed[i] = true;
        if (!top().isolate && stack.length > 1) {
          stack.pop();
        }
        break;
      }
      case "BN": {
        // Boundary neutrals (X9): they still live inside embeddings but carry
        // no glyph — dropped from runs like the explicit controls.
        removed[i] = true;
        break;
      }
      default: {
        levels[i] = top().level;
        const ov = top().override;
        if (ov !== "neutral" && (cls === "L" || cls === "R" || cls === "AL")) {
          types[i] = ov;
        }
        break;
      }
    }
  }

  // Indices that participate in W/N/I (all non-removed characters).
  const kept: number[] = [];
  for (let i = 0; i < n; i += 1) {
    if (!removed[i]) kept.push(i);
  }
  if (kept.length === 0) {
    return { levels, removed };
  }
  const sos: "L" | "R" = baseLevel === 1 ? "R" : "L";

  // ---- W1: NSM takes the preceding character's class ----------------------
  for (let k = 0; k < kept.length; k += 1) {
    const i = kept[k]!;
    if (types[i] === "NSM") {
      types[i] = k === 0 ? sos : types[kept[k - 1]!]!;
    }
  }

  // ---- W2: EN preceded by AL becomes AN ------------------------------------
  {
    let lastStrong: "L" | "R" | "AL" = sos === "R" ? "R" : "L";
    for (const i of kept) {
      const t = types[i]!;
      if (t === "EN" && lastStrong === "AL") {
        types[i] = "AN";
      } else if (t === "L" || t === "R" || t === "AL") {
        lastStrong = t;
      }
    }
  }

  // ---- W4: single ES/CS between matching digits ----------------------------
  for (let k = 1; k + 1 < kept.length; k += 1) {
    const i = kept[k]!;
    const t = types[i]!;
    const prev = types[kept[k - 1]!]!;
    const next = types[kept[k + 1]!]!;
    if (t === "ES" && prev === "EN" && next === "EN") {
      types[i] = "EN";
    } else if (t === "CS" && ((prev === "EN" && next === "EN") || (prev === "AN" && next === "AN"))) {
      types[i] = prev;
    }
  }

  // ---- W5: ET adjacent to EN becomes EN ------------------------------------
  for (let k = 0; k < kept.length; k += 1) {
    const i = kept[k]!;
    if (types[i] !== "ET") continue;
    let end = k;
    while (end + 1 < kept.length && types[kept[end + 1]!] === "ET") end += 1;
    const touches =
      (k > 0 && types[kept[k - 1]!] === "EN") ||
      (end + 1 < kept.length && types[kept[end + 1]!] === "EN");
    if (touches) {
      for (let j = k; j <= end; j += 1) types[kept[j]!] = "EN";
    }
    k = end;
  }

  // ---- W6: remaining ES/ET/CS become ON ------------------------------------
  for (const i of kept) {
    const t = types[i]!;
    if (t === "ES" || t === "ET" || t === "CS") types[i] = "ON";
  }

  // ---- W7: EN preceded by an L strong becomes L ----------------------------
  {
    let lastStrong: "L" | "R" = sos;
    for (const i of kept) {
      const t = types[i]!;
      if (t === "EN" && lastStrong === "L") {
        types[i] = "L";
      } else if (t === "L" || t === "R" || t === "AL" || t === "AN") {
        lastStrong = t === "L" ? "L" : "R";
      }
    }
  }

  // ---- N0: paired brackets --------------------------------------------------
  {
    const openStack: number[] = [];
    const found: [number, number][] = [];
    for (const i of kept) {
      const ch = chars[i]!;
      if (types[i] !== "ON") continue;
      if (BRACKET_OPEN.has(ch)) {
        openStack.push(i);
      } else if (BRACKET_CLOSE.has(ch)) {
        // Pop back to the matching opener of the right kind.
        for (let k = openStack.length - 1; k >= 0; k -= 1) {
          const o = openStack[k]!;
          if (BRACKET_OPEN.get(chars[o]!) === ch) {
            found.push([o, i]);
            openStack.length = k;
            break;
          }
        }
      }
    }
    for (const [o, c] of found) {
      const emb: "L" | "R" = levels[o]! % 2 === 1 ? "R" : "L";
      let innerEmb = false;
      let innerOpp = false;
      for (const i of kept) {
        if (i <= o || i >= c) continue;
        const s = strongOf(types[i]!);
        if (s === emb) innerEmb = true;
        else if (s !== null) innerOpp = true;
      }
      let dir: "L" | "R" | null = null;
      if (innerEmb) {
        dir = emb;
      } else if (innerOpp) {
        // Resolve by the surrounding strongs (the N1 context rule).
        let prev: "L" | "R" = sos;
        for (let k = 0; k < kept.length && kept[k]! < o; k += 1) {
          const s = strongOf(types[kept[k]!]!);
          if (s !== null) prev = s;
        }
        let next: "L" | "R" = sos;
        for (let k = kept.length - 1; k >= 0 && kept[k]! > c; k -= 1) {
          const s = strongOf(types[kept[k]!]!);
          if (s !== null) next = s;
        }
        dir = prev === next ? prev : emb;
      }
      if (dir !== null) {
        types[o] = dir;
        types[c] = dir;
      }
    }
  }

  // ---- N1/N2: neutrals between equal strongs take that direction -----------
  {
    let k = 0;
    while (k < kept.length) {
      const i = kept[k]!;
      const t = types[i]!;
      const s = strongOf(t);
      if (s !== null || t === "NSM") {
        k += 1;
        continue;
      }
      // Neutral run [k, end): WS, S, ON and anything not resolved strong.
      let end = k;
      while (end + 1 < kept.length) {
        const tt = types[kept[end + 1]!]!;
        if (strongOf(tt) !== null) break;
        end += 1;
      }
      let prev: "L" | "R" = sos;
      for (let j = k - 1; j >= 0; j -= 1) {
        const ss = strongOf(types[kept[j]!]!);
        if (ss !== null) {
          prev = ss;
          break;
        }
      }
      let next: "L" | "R" = sos;
      for (let j = end + 1; j < kept.length; j += 1) {
        const ss = strongOf(types[kept[j]!]!);
        if (ss !== null) {
          next = ss;
          break;
        }
      }
      const resolved = prev === next ? prev : (levels[i]! % 2 === 1 ? "R" : "L");
      for (let j = k; j <= end; j += 1) types[kept[j]!] = resolved;
      k = end + 1;
    }
  }

  // ---- I1/I2: implicit levels ----------------------------------------------
  for (const i of kept) {
    const t = types[i]!;
    const lev = levels[i]!;
    if (lev % 2 === 0) {
      if (t === "R") levels[i] = lev + 1;
      else if (t === "AN" || t === "EN") levels[i] = lev + 2;
    } else {
      if (t === "L" || t === "EN" || t === "AN") levels[i] = lev + 1;
    }
  }
  return { levels, removed };
}

/**
 * Split classified indices into paragraphs at B-class entries. Each paragraph
 * is `[start,end)` index ranges into the shared arrays; the B indices
 * themselves are returned separately so callers can emit hard-break markers.
 */
interface ParagraphSpan {
  readonly start: number;
  readonly end: number;
}

function paragraphSpans(classes: readonly BidiClass[]): {
  readonly spans: readonly ParagraphSpan[];
  readonly breaks: readonly number[];
} {
  const spans: ParagraphSpan[] = [];
  const breaks: number[] = [];
  let start = 0;
  for (let i = 0; i <= classes.length; i += 1) {
    if (i === classes.length || classes[i] === "B") {
      spans.push({ start, end: i });
      if (i < classes.length) breaks.push(i);
      start = i + 1;
    }
  }
  return { spans, breaks };
}

/**
 * Resolve a per-character embedding level for `text` under base direction
 * `base` (UAX #9: X + W + N + I over each paragraph; explicit-format chars
 * resolve to the paragraph level and are marked removed for run extraction).
 */
export function resolveLevels(text: string, base: Direction): number[] {
  const { levels } = resolveText(text, base);
  return levels;
}

interface ResolvedText {
  readonly levels: number[];
  /** X9/X10-removed characters (format controls + BN). */
  readonly removed: boolean[];
  /** Paragraph-separator (B-class) indices — hard break positions. */
  readonly breaks: readonly number[];
  /** Per-paragraph base level actually used (index = span order). */
  readonly paraBases: readonly number[];
  readonly spans: readonly ParagraphSpan[];
}

/** Shared resolver: classify, split paragraphs, resolve each. */
function resolveText(text: string, override?: Direction): ResolvedText {
  const chars = [...text];
  const classes = chars.map(bidiClass);
  const { spans, breaks } = paragraphSpans(classes);
  const levels = new Array<number>(chars.length).fill(0);
  const removed = new Array<boolean>(chars.length).fill(false);
  const paraBases: number[] = [];
  for (const span of spans) {
    const slice = chars.slice(span.start, span.end).join("");
    const base = baseDirection(slice, override);
    const baseLevel = base === "rtl" ? 1 : 0;
    paraBases.push(baseLevel);
    const sub = resolveParagraph(
      chars.slice(span.start, span.end),
      classes.slice(span.start, span.end),
      baseLevel,
    );
    for (let i = 0; i < sub.levels.length; i += 1) {
      levels[span.start + i] = sub.levels[i]!;
      removed[span.start + i] = sub.removed[i]!;
    }
  }
  // B characters render at their paragraph's base level and are neither
  // removed nor part of a directional run.
  for (let k = 0; k < breaks.length; k += 1) {
    const idx = breaks[k]!;
    levels[idx] = paraBases[Math.min(k, paraBases.length - 1)]!;
  }
  return { levels, removed, breaks, paraBases, spans };
}

// ---------------------------------------------------------------------------
// Visual reordering (UAX #9 rule L2).
// ---------------------------------------------------------------------------

/** Reverse `arr[from..to]` in place (inclusive). */
function reverseRange<T>(arr: T[], from: number, to: number): void {
  let a = from;
  let b = to;
  while (a < b) {
    const tmp = arr[a]!;
    arr[a] = arr[b]!;
    arr[b] = tmp;
    a += 1;
    b -= 1;
  }
}

/**
 * Reorder `text` from LOGICAL into VISUAL order (UAX #9 rule L2): from the
 * highest level down to the lowest odd level, reverse every contiguous run at
 * or above that level — applied per paragraph at each paragraph's resolved
 * base. Explicit-format and BN characters are dropped from the output (they
 * carry no glyph). The result is the sequence of code points in the order
 * they should be painted left-to-right.
 */
export function reorderVisual(text: string, override?: Direction): string {
  const chars = [...text];
  if (chars.length === 0) {
    return "";
  }
  const { levels, removed } = resolveText(text, override);
  const keptIdx: number[] = [];
  for (let i = 0; i < chars.length; i += 1) {
    if (!removed[i]) keptIdx.push(i);
  }
  const maxLevel = keptIdx.reduce((m, i) => Math.max(m, levels[i]!), 0);
  let minOdd = Number.POSITIVE_INFINITY;
  for (const i of keptIdx) {
    if (levels[i]! % 2 === 1) minOdd = Math.min(minOdd, levels[i]!);
  }
  const order = keptIdx.slice();
  const lvl = keptIdx.map((i) => levels[i]!);
  if (Number.isFinite(minOdd)) {
    for (let level = maxLevel; level >= minOdd; level -= 1) {
      let i = 0;
      while (i < order.length) {
        if (lvl[i]! >= level) {
          let j = i;
          while (j < order.length && lvl[j]! >= level) j += 1;
          reverseRange(order, i, j - 1);
          i = j;
        } else {
          i += 1;
        }
      }
    }
  }
  return order.map((i) => chars[i]!).join("");
}

// ---------------------------------------------------------------------------
// Directional run segmentation (for per-run shaping).
// ---------------------------------------------------------------------------

/**
 * Split `text` into maximal {@link BidiRun}s of equal resolved embedding level,
 * in LOGICAL order. Each run is homogeneous in direction, so a complex-script
 * shaper can be invoked once per run (the "itemize then shape" pipeline).
 * Removed characters (explicit controls, BN) keep their indices so runs still
 * cover the source contiguously, but contribute no text.
 */
export function bidiRuns(text: string, override?: Direction): readonly BidiRun[] {
  const chars = [...text];
  if (chars.length === 0) {
    return [];
  }
  const { levels, removed } = resolveText(text, override);

  const runs: BidiRun[] = [];
  let start = 0;
  for (let i = 1; i <= chars.length; i += 1) {
    if (i === chars.length || levels[i] !== levels[start]) {
      runs.push({
        start,
        end: i,
        level: levels[start]!,
        text: chars
          .slice(start, i)
          .filter((_, k) => !removed[start + k])
          .join(""),
      });
      start = i;
    }
  }
  return runs;
}

/**
 * The runs of {@link bidiRuns} reordered into VISUAL order — UAX #9 rule L2
 * applied at RUN granularity: from the highest level down to the lowest odd
 * level, reverse every contiguous run of runs at or above that level. This is
 * the order the shaper's per-run output is concatenated into the painted glyph
 * sequence (RFC 0002); runs with even levels are already left-to-right.
 */
export function bidiVisualRuns(text: string, override?: Direction): readonly BidiRun[] {
  const runs = bidiRuns(text, override);
  if (runs.length <= 1) return runs;
  const order = runs.slice();
  const maxLevel = runs.reduce((m, r) => Math.max(m, r.level), 0);
  let minOdd = Number.POSITIVE_INFINITY;
  for (const r of runs) {
    if (r.level % 2 === 1) minOdd = Math.min(minOdd, r.level);
  }
  if (!Number.isFinite(minOdd)) return runs;
  for (let level = maxLevel; level >= minOdd; level -= 1) {
    let i = 0;
    while (i < order.length) {
      if (order[i]!.level >= level) {
        let j = i;
        while (j < order.length && order[j]!.level >= level) j += 1;
        order.splice(i, j - i, ...order.slice(i, j).reverse());
        i = j;
      } else {
        i += 1;
      }
    }
  }
  return order;
}

// ---------------------------------------------------------------------------
// Multi-owner paragraph itemization (layout's text-member bidi).
// ---------------------------------------------------------------------------

/**
 * One piece of a paragraph as layout feeds it: raw text belonging to a single
 * layout member (a text node, an injected element-scope control string, or a
 * U+FFFC placeholder standing in for an atomic inline box). Piece index in the
 * array is the piece's owner tag.
 */
export interface BidiPiece {
  readonly text: string;
}

/**
 * A visual-order fragment of a resolved paragraph: text belonging to piece
 * `owner` at embedding `level`, or a paragraph-separator marker
 * (`hardBreak`). Fragments arrive in paint order; an odd level means the
 * fragment's own word order must additionally be reversed by the caller.
 */
export interface VisualPart {
  readonly owner: number;
  readonly level: number;
  readonly text: string;
  readonly hardBreak?: true;
}

/**
 * Resolve a whole paragraph built from several pieces and return its fragments
 * in VISUAL order (UAX #9 P + X + W + N + I + L2), each tagged with the piece
 * index it came from. B-class characters inside any piece split the stream
 * into separate paragraphs — each with its own first-strong base when
 * `baseOverride` is absent — and surface as `hardBreak` parts at their visual
 * position. Removed characters never appear in fragment text.
 */
export function visualOrderParts(
  pieces: readonly BidiPiece[],
  baseOverride?: Direction,
): readonly VisualPart[] {
  const text = pieces.map((p) => p.text).join("");
  const chars = [...text];
  if (chars.length === 0) return [];
  const owners = new Array<number>(chars.length).fill(0);
  {
    let at = 0;
    for (let p = 0; p < pieces.length; p += 1) {
      const len = [...pieces[p]!.text].length;
      owners.fill(p, at, at + len);
      at += len;
    }
  }
  const classes = chars.map(bidiClass);
  const { spans, breaks } = paragraphSpans(classes);
  const breakSet = new Set(breaks);

  const out: VisualPart[] = [];
  for (const span of spans) {
    const slice = chars.slice(span.start, span.end).join("");
    const base = baseDirection(slice, baseOverride);
    const baseLevel = base === "rtl" ? 1 : 0;
    const sub = resolveParagraph(
      chars.slice(span.start, span.end),
      classes.slice(span.start, span.end),
      baseLevel,
    );

    // Stream-order kept indices of this paragraph.
    const kept: number[] = [];
    for (let i = 0; i < sub.levels.length; i += 1) {
      if (!sub.removed[i]) kept.push(span.start + i);
    }
    if (kept.length > 0) {
      // Level runs (logical order).
      const runs: { level: number; idx: number[] }[] = [];
      let rStart = 0;
      for (let i = 1; i <= kept.length; i += 1) {
        if (
          i === kept.length ||
          sub.levels[kept[i]! - span.start] !== sub.levels[kept[rStart]! - span.start]
        ) {
          runs.push({ level: sub.levels[kept[rStart]! - span.start]!, idx: kept.slice(rStart, i) });
          rStart = i;
        }
      }
      // L2 reorder of the runs.
      const order = runs.slice();
      const maxLevel = runs.reduce((m, r) => Math.max(m, r.level), 0);
      let minOdd = Number.POSITIVE_INFINITY;
      for (const r of runs) {
        if (r.level % 2 === 1) minOdd = Math.min(minOdd, r.level);
      }
      if (Number.isFinite(minOdd)) {
        for (let level = maxLevel; level >= minOdd; level -= 1) {
          let i = 0;
          while (i < order.length) {
            if (order[i]!.level >= level) {
              let j = i;
              while (j < order.length && order[j]!.level >= level) j += 1;
              order.splice(i, j - i, ...order.slice(i, j).reverse());
              i = j;
            } else {
              i += 1;
            }
          }
        }
      }
      // Emit per-owner fragments within each run (visual order).
      for (const run of order) {
        let s = 0;
        for (let i = 1; i <= run.idx.length; i += 1) {
          if (i === run.idx.length || owners[run.idx[i]!] !== owners[run.idx[s]!]) {
            out.push({
              owner: owners[run.idx[s]!]!,
              level: run.level,
              text: run.idx
                .slice(s, i)
                .map((ci) => chars[ci]!)
                .join(""),
            });
            s = i;
          }
        }
      }
    }
    // A B-class character directly after this span emits a hard break.
    const bIdx = span.end;
    if (bIdx < chars.length && breakSet.has(bIdx)) {
      out.push({ owner: owners[bIdx]!, level: baseLevel, text: "", hardBreak: true });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Script itemization (for complex-script shaping — Requirement 17.1).
// ---------------------------------------------------------------------------

/** A recognised script for itemization (a pragmatic subset). */
export type Script = "latin" | "arabic" | "hebrew" | "han" | "common";

/** One contiguous run of a single script, in logical order. */
export interface ScriptRun {
  readonly start: number;
  readonly end: number;
  readonly script: Script;
  readonly text: string;
}

/** Classify a code point's script (pragmatic subset; `common` for shared chars). */
export function scriptOf(ch: string): Script {
  const cp = ch.codePointAt(0) ?? 0;
  if (
    (cp >= 0x0600 && cp <= 0x06ff) ||
    (cp >= 0x0750 && cp <= 0x077f) ||
    (cp >= 0xfb50 && cp <= 0xfdff) ||
    (cp >= 0xfe70 && cp <= 0xfeff)
  ) {
    return "arabic";
  }
  if (cp >= 0x0590 && cp <= 0x05ff) return "hebrew";
  if (cp >= 0x2e80 && cp <= 0x9fff) return "han";
  if (
    (cp >= 0x0041 && cp <= 0x005a) ||
    (cp >= 0x0061 && cp <= 0x007a) ||
    (cp >= 0x00c0 && cp <= 0x024f)
  ) {
    return "latin";
  }
  return "common"; // digits, punctuation, whitespace — shaped with neighbours.
}

/**
 * Itemize `text` into maximal {@link ScriptRun}s of one script (a `common`
 * character extends the current run rather than splitting it, so "abc 123"
 * stays one Latin run). This is the segmentation a complex-script shaper
 * (HarfBuzz) is invoked on per run (Requirement 17.1).
 */
export function scriptRuns(text: string): readonly ScriptRun[] {
  const chars = [...text];
  if (chars.length === 0) {
    return [];
  }
  const runs: ScriptRun[] = [];
  let start = 0;
  let current: Script = firstNonCommon(chars) ?? "common";
  // Recompute current as we go, but a `common` char never forces a split.
  current = scriptOf(chars[0]!) === "common" ? current : scriptOf(chars[0]!);

  for (let i = 1; i <= chars.length; i += 1) {
    if (i === chars.length) {
      runs.push({ start, end: i, script: current, text: chars.slice(start, i).join("") });
      break;
    }
    const s = scriptOf(chars[i]!);
    if (s !== "common" && s !== current) {
      runs.push({ start, end: i, script: current, text: chars.slice(start, i).join("") });
      start = i;
      current = s;
    }
  }
  return runs;
}

/** The first non-`common` script in the string, or null. */
function firstNonCommon(chars: readonly string[]): Script | null {
  for (const ch of chars) {
    const s = scriptOf(ch);
    if (s !== "common") return s;
  }
  return null;
}

/** OpenType/ISO-15924 script tags the shaper (`hb_buffer_set_script`) takes. */
const OT_SCRIPT_TAG: Record<Script, string> = {
  latin: "Latn",
  arabic: "Arab",
  hebrew: "Hebr",
  han: "Hani",
  common: "Zyyy",
};

/**
 * The dominant script of a run as an OpenType tag: the first non-`common`
 * script in `text`, `"Zyyy"` (common) when there is none. Itemization feeds
 * this to the shaper alongside the run's direction (RFC 0002).
 */
export function runScriptTag(text: string): string {
  const s = firstNonCommon([...text]);
  return OT_SCRIPT_TAG[s ?? "common"];
}
