/**
 * Line breaking (UAX #14) — RFC 0024; Requirement 17.x "THE Layout_Engine
 * SHALL break lines per the Unicode Line Breaking Algorithm for the supported
 * script coverage".
 *
 * ## What this module owns
 *
 * The greedy line packer in `index.ts` consumes maximal *unbreakable units*;
 * producing them from raw text is the UAX #14 pair-table's job, and that job
 * lives here:
 *
 *   1. {@link lbClass} classifies a code point into a pragmatic subset of the
 *      UAX #14 classes (BK, SP, ZW, WJ, GL, SHY, BA, HY, CL, OP, EX, IS, QU,
 *      NU, PR, PO, ID, CJ, RI, AL) over range tables;
 *   2. {@link pairBreak} answers "may a line break between class A and class
 *      B" — the UAX #14 pair rules (mandatory after BK, around spaces, the
 *      closing-punctuation/open-bracket protections, number groups,
 *      ideographic × ideographic, soft hyphens, …) as adjusted by the
 *      `word-break` / `line-break` / `overflow-wrap` keywords;
 *   3. {@link breakUnits} consumes a paragraph piece and emits the ordered
 *      {@link BreakUnit}s — each boundary it creates is a legal break, so the
 *      packer never has to consult the table again.
 *
 * Honest bounds (documented in RFC 0024): the class table is a hand-audited
 * range set, not the generated UCD; Thai/Lao/Khmer/Myanmar dictionary break
 * iterators are absent (those scripts keep word-level breaking —
 * `SA`-without-dictionary); `line-break:strict` currently resolves to the
 * `normal` ruleset (our table has nothing stricter to forbid); RI stays
 * unconditionally paired (the real rule alternates); `hyphens:auto` has no
 * language dictionaries yet, so it behaves as `manual`.
 *
 * This module is part of the *layout* stage and imports only its own types —
 * no stage boundary is crossed (`local/no-cross-stage-import`).
 */

// ---------------------------------------------------------------------------
// Break classes (UAX #14 subset)
// ---------------------------------------------------------------------------

export type LBClass =
  | "BK" // mandatory break (newline etc.)
  | "SP" // space
  | "ZW" // zero-width space (invisible break point)
  | "WJ" // word joiner
  | "GL" // glue (NBSP etc.)
  | "SHY" // soft hyphen (break shows a visible hyphen)
  | "BA" // break-after (dashes)
  | "HY" // hyphen-minus (break-after except before digits)
  | "CL" // closing punctuation
  | "OP" // opening punctuation
  | "EX" // exclamation / interrogation
  | "IS" // infix separators (, . : ;)
  | "QU" // quotation marks
  | "NU" // digits
  | "PR" // numeric prefix ($ € £ ¥)
  | "PO" // numeric postfix (% ° ‰)
  | "ID" // ideographic / wide (CJK, Hangul, emoji, fullwidth)
  | "CJ" // conditional Japanese starters (small kana, iteration marks)
  | "RI" // regional indicators (flags)
  | "AL"; // alphabetic / everything else

const inRanges = (cp: number, ranges: readonly (readonly [number, number])[]): boolean => {
  for (const [a, b] of ranges) {
    if (cp >= a && cp <= b) return true;
  }
  return false;
};

const ID_RANGES: readonly (readonly [number, number])[] = [
  [0x2e80, 0x2fdf], [0x2ff0, 0x2fff], [0x3000, 0x3000], [0x3040, 0x309f],
  [0x30a0, 0x30ff], [0x3400, 0x9fff], [0xac00, 0xd7af], [0xf900, 0xfaff],
  [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1100, 0x11ff], [0xa960, 0xa97f],
  [0xd7b0, 0xd7ff], [0x1f300, 0x1faff], [0x20000, 0x2ffff],
];

/** Small kana / iteration marks — no break BEFORE them unless `loose`. */
const CJ_POINTS: ReadonlySet<number> = new Set([
  0x3041, 0x3043, 0x3045, 0x3047, 0x3049, 0x3063, 0x3083, 0x3085, 0x3087,
  0x308e, 0x3095, 0x3096, 0x30a1, 0x30a3, 0x30a5, 0x30a7, 0x30a9, 0x30c3,
  0x30e3, 0x30e5, 0x30e7, 0x30ee, 0x30f5, 0x30f6, 0x3005, 0x303b, 0x309d,
  0x309e, 0x30fd, 0x30fe,
]);

const CJ_RANGES: readonly (readonly [number, number])[] = [
  [0x31f0, 0x31ff], [0xff67, 0xff70],
];

const CL_RANGES: readonly (readonly [number, number])[] = [
  [0x3001, 0x3002], [0x3009, 0x3009], [0x300b, 0x300b], [0x300d, 0x300d],
  [0x300f, 0x300f], [0x3011, 0x3011], [0x3015, 0x3015], [0x3017, 0x3017],
  [0x3019, 0x301b], [0x301e, 0x301f], [0xff01, 0xff02], [0xff09, 0xff09],
  [0xff0c, 0xff0d], [0xff0e, 0xff0e], [0xff1a, 0xff1b], [0xff1d, 0xff1d],
  [0xff1f, 0xff20], [0xff3d, 0xff3d], [0xff5d, 0xff5d], [0xff60, 0xff61],
  [0xff63, 0xff65], [0xfe50, 0xfe52], [0xfe54, 0xfe58],
];

const OP_RANGES: readonly (readonly [number, number])[] = [
  [0x3008, 0x3008], [0x300a, 0x300a], [0x300c, 0x300c], [0x300e, 0x300e],
  [0x3010, 0x3010], [0x3014, 0x3014], [0x3016, 0x3016], [0x3018, 0x3018],
  [0x301a, 0x301a], [0x301d, 0x301d], [0xff08, 0xff08], [0xff3b, 0xff3b],
  [0xff5b, 0xff5b], [0xff5f, 0xff5f], [0xff62, 0xff62],
];

/** Classify a code point into the pragmatic UAX #14 class set. */
export function lbClass(cp: number): LBClass {
  // Mandatory breaks.
  if (cp === 0x000a || cp === 0x000b || cp === 0x000c || cp === 0x000d ||
      cp === 0x0085 || cp === 0x2028 || cp === 0x2029) {
    return "BK";
  }
  if (cp === 0x0020) return "SP";
  if (cp === 0x0009) return "SP"; // tab folds into the space run here.
  if (cp === 0x200b) return "ZW";
  if (cp === 0x2060 || cp === 0xfeff) return "WJ";
  if (cp === 0x00a0 || cp === 0x2011 || cp === 0x202f || cp === 0x0f0c) return "GL";
  if (cp === 0x00ad) return "SHY";
  // Break-after dashes.
  if ((cp >= 0x2010 && cp <= 0x2015) || cp === 0x2e17 || cp === 0x2e40) return "BA";
  // Hyphen-minus / hebrew maqaf.
  if (cp === 0x002d || cp === 0x058a || cp === 0x05be) return "HY";
  // Combining marks inherit the preceding class (UAX #14 LB9 spirit).
  if (inRanges(cp, [[0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd],
    [0x05bf, 0x05bf], [0x05c1, 0x05c2], [0x05c4, 0x05c5], [0x05c7, 0x05c7],
    [0x0610, 0x061a], [0x064b, 0x065f], [0x0670, 0x0670], [0x20d0, 0x20f0],
    [0xfe00, 0xfe0f], [0xfe20, 0xfe2f]])) {
    return "AL"; // fold into the preceding letter — AL never splits words.
  }
  if (cp === 0x0029 || cp === 0x005d || cp === 0x007d) return "CL";
  if (inRanges(cp, CL_RANGES)) return "CL";
  if (cp === 0x0028 || cp === 0x005b || cp === 0x007b) return "OP";
  if (inRanges(cp, OP_RANGES)) return "OP";
  if (cp === 0x0021 || cp === 0x003f) return "EX";
  if (cp === 0x002c || cp === 0x002e || cp === 0x003a || cp === 0x003b ||
      cp === 0x0589 || cp === 0x037e) {
    return "IS";
  }
  if (cp === 0x0022 || cp === 0x0027 || cp === 0x00ab || cp === 0x00bb ||
      (cp >= 0x2018 && cp <= 0x201d)) {
    return "QU";
  }
  if ((cp >= 0x0030 && cp <= 0x0039) || (cp >= 0x0660 && cp <= 0x0669) ||
      (cp >= 0x06f0 && cp <= 0x06f9) || (cp >= 0xff10 && cp <= 0xff19)) {
    return "NU";
  }
  if (cp === 0x0024 || cp === 0x00a3 || cp === 0x00a5 || cp === 0x058f ||
      cp === 0x060b || (cp >= 0x20a0 && cp <= 0x20bf) || cp === 0xff04 ||
      cp === 0xffe1 || cp === 0xffe5 || cp === 0xffe6) {
    return "PR";
  }
  if (cp === 0x0025 || cp === 0x00a2 || cp === 0x00b0 || cp === 0x2030 ||
      cp === 0x2031 || (cp >= 0x2032 && cp <= 0x2037) || cp === 0xff05 ||
      cp === 0xffe0) {
    return "PO";
  }
  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return "RI";
  if (CJ_POINTS.has(cp) || inRanges(cp, CJ_RANGES)) return "CJ";
  if (inRanges(cp, ID_RANGES)) return "ID";
  return "AL";
}

// ---------------------------------------------------------------------------
// Options: CSS Text `word-break` / `line-break` / `overflow-wrap` / `hyphens`.
// ---------------------------------------------------------------------------

export interface BreakOptions {
  /** `word-break: break-all` — break between any two letters. */
  readonly breakAll?: boolean;
  /** `word-break: keep-all` — suppress ideographic × ideographic breaks. */
  readonly keepAll?: boolean;
  /** `line-break` keyword (`strict` resolves to `normal` — see module docs). */
  readonly lineBreak?: "auto" | "loose" | "normal" | "strict" | "anywhere";
  /** `overflow-wrap: anywhere` — every boundary is a break. */
  readonly anywhere?: boolean;
  /** `hyphens`: `none` disables soft-hyphen breaks; `auto` ≙ manual today. */
  readonly hyphens?: "none" | "manual" | "auto";
}

/**
 * The UAX #14 pair rule (subset): whether a break is ALLOWED between a unit
 * ending in class `a` and a unit starting in class `b`. `opts` carries the
 * CSS keyword adjustments; both callers pass classified neighbours.
 */
export function pairBreak(a: LBClass, b: LBClass, opts: BreakOptions): boolean {
  if (opts.anywhere === true) return true;
  // Word joiner / glue never separates (LB8a, LB11).
  if (a === "WJ" || b === "WJ" || a === "GL" || b === "GL") return false;
  // Spaces are consumed by the caller's fold logic.
  if (a === "SP" || b === "SP") return a === "SP";
  // ZW, SHY, BA, HY — break after (HY not before a digit: LB22).
  if (a === "ZW" || b === "ZW") return true;
  if (a === "BA") return true;
  if (a === "HY") return b !== "NU";
  // No break before closing punctuation / exclamation (LB13/LB30ish).
  if (b === "CL" || b === "EX") return false;
  // No break after an opening bracket (LB14).
  if (a === "OP") return false;
  // Quotes bind to adjacent letters/digits like AL (pragmatic QU).
  const quoteBound =
    (a === "QU" || b === "QU") &&
    ((a === "QU" && (b === "AL" || b === "NU" || b === "QU" || b === "ID")) ||
      (b === "QU" && (a === "AL" || a === "NU" || a === "PR" || a === "ID")));
  if (quoteBound) return opts.breakAll === true && (a === "AL" || b === "AL");
  // Conditional Japanese starters: no break before (LB30) unless loose.
  if (b === "CJ") {
    return opts.lineBreak === "loose" || opts.lineBreak === "anywhere";
  }
  // Number groups: NU can't split from NU/IS/PO, PR/IS can't split to NU.
  if (a === "NU" && (b === "NU" || b === "IS" || b === "PO")) return false;
  if ((a === "PR" || a === "IS") && b === "NU") return false;
  if (a === "NU" && b === "PR") return false;
  if (a === "PR" && b === "AL") return false;
  // Regional indicators stay paired (simplified: never split).
  if (a === "RI" && b === "RI") return false;
  // Ideographic / wide: free breaks either side, unless keep-all joins them.
  if (a === "ID" || b === "ID" || a === "CJ") {
    if (opts.keepAll === true && a === "ID" && b === "ID") return false;
    return true;
  }
  // Alphabetic words and digits: intact unless break-all/anywhere.
  if (
    (a === "AL" || a === "NU" || a === "QU") &&
    (b === "AL" || b === "NU" || b === "QU")
  ) {
    return opts.breakAll === true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Unit production
// ---------------------------------------------------------------------------

/**
 * A maximal unbreakable unit of a line. `spaceBefore` records that real
 * whitespace separated this unit from the previous one (the packer inserts
 * the space advance — a unit boundary alone never implies a space).
 * `hardBreaksBefore` counts mandatory breaks (B-class characters) preceding
 * the unit; `shyAfter` marks a soft-hyphen break point — a break taken there
 * shows a visible hyphen at the line end.
 */
export interface BreakUnit {
  readonly text: string;
  readonly spaceBefore: boolean;
  readonly hardBreaksBefore: number;
  readonly shyAfter: boolean;
}

/**
 * Produce the ordered {@link BreakUnit}s for `text`. Whitespace runs fold
 * into `spaceBefore`; BK characters fold into `hardBreaksBefore`; ZW and
 * SHY emit boundaries without text; every other boundary comes from
 * {@link pairBreak}. Surrogate-pair-safe (iterates code points).
 */
export function breakUnits(text: string, opts: BreakOptions): BreakUnit[] {
  const chars = [...text];
  const classes = chars.map((ch) => lbClass(ch.codePointAt(0) ?? 0));
  interface MutableUnit {
    text: string;
    spaceBefore: boolean;
    hardBreaksBefore: number;
    shyAfter: boolean;
  }
  const units: MutableUnit[] = [];
  let curStart = -1; // char index of the unit under construction
  let pendingSpace = false;
  let pendingBreaks = 0;
  const flush = (end: number): void => {
    if (curStart < 0) return;
    // Invisible glue/format chars never shape: word joiners glue the pair;
    // soft hyphens only render as the emitted "-" glyph when a break is taken.
    const text = chars
      .slice(curStart, end)
      .filter((ch) => {
        const cls = lbClass(ch.codePointAt(0) ?? 0);
        return cls !== "WJ" && cls !== "SHY";
      })
      .join("");
    units.push({
      text,
      spaceBefore: pendingSpace,
      hardBreaksBefore: pendingBreaks,
      shyAfter: false,
    });
    pendingSpace = false;
    pendingBreaks = 0;
    curStart = -1;
  };

  const shyAllowed = opts.hyphens !== "none";
  let prevCls: LBClass | null = null;
  for (let i = 0; i < chars.length; i += 1) {
    const cls = classes[i]!;
    if (cls === "BK") {
      flush(i);
      pendingBreaks += 1;
      prevCls = null;
      continue;
    }
    if (cls === "SP") {
      flush(i);
      pendingSpace = true;
      prevCls = "SP";
      continue;
    }
    if (cls === "ZW") {
      flush(i);
      prevCls = null; // ZW permits a break AFTER it too.
      continue;
    }
    if (cls === "SHY") {
      if (!shyAllowed) continue; // hyphens:none — the char vanishes entirely.
      flush(i);
      if (units.length > 0) {
        units[units.length - 1]!.shyAfter = true;
      }
      prevCls = null; // the shy boundary itself is the break.
      continue;
    }
    if (curStart < 0) {
      curStart = i;
      prevCls = cls;
      continue;
    }
    if (prevCls !== null && pairBreak(prevCls, cls, opts)) {
      flush(i);
      curStart = i;
    }
    prevCls = cls;
  }
  flush(chars.length);
  return units;
}
