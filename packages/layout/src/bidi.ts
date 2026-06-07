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
 *   1. assigns a base paragraph direction (explicit, or the first strong
 *      character — UAX #9 rule P2/P3);
 *   2. classifies each character's bidi type into L / R / AL / EN / AN / WS /
 *      neutral (a pragmatic subset of UAX #9);
 *   3. resolves embedding levels for a single paragraph (the common LTR-base /
 *      RTL-base case with neutral resolution), and
 *   4. produces the VISUAL run order by reversing maximal runs of
 *      higher-than-base level (the UAX #9 L2 reordering), so an RTL run inside
 *      LTR text is emitted right-to-left.
 *
 * It also segments a string into **script runs** (Latin / Arabic / Hebrew /
 * Han / …) so a complex-script shaper is invoked per homogeneous run — the
 * standard "itemize, then shape each item" pipeline HarfBuzz expects.
 *
 * This module is part of the *layout* stage and imports ONLY the frozen IR — it
 * reaches across no stage boundary (`local/no-cross-stage-import`).
 */

/** A character's (pragmatically reduced) UAX #9 bidi class. */
export type BidiClass =
  | "L" // strong left-to-right
  | "R" // strong right-to-left (Hebrew etc.)
  | "AL" // strong right-to-left Arabic
  | "EN" // European number
  | "AN" // Arabic number
  | "WS" // whitespace
  | "ON"; // other neutral

/** The base direction of a paragraph. */
export type Direction = "ltr" | "rtl";

/** One contiguous run of text at a single resolved embedding level. */
export interface BidiRun {
  /** Source start index (inclusive) of the run. */
  readonly start: number;
  /** Source end index (exclusive) of the run. */
  readonly end: number;
  /** The run's resolved embedding level (even = LTR, odd = RTL). */
  readonly level: number;
  /** The run's substring, in LOGICAL (source) order. */
  readonly text: string;
}

// ---------------------------------------------------------------------------
// Character classification (UAX #9 bidi class, reduced subset).
// ---------------------------------------------------------------------------

/** Classify a single code point's bidi class (a pragmatic UAX #9 subset). */
export function bidiClass(ch: string): BidiClass {
  const cp = ch.codePointAt(0) ?? 0;

  // Arabic letters (strong AL): Arabic + Arabic Supplement + Presentation Forms.
  if (
    (cp >= 0x0600 && cp <= 0x06ff) ||
    (cp >= 0x0750 && cp <= 0x077f) ||
    (cp >= 0xfb50 && cp <= 0xfdff) ||
    (cp >= 0xfe70 && cp <= 0xfeff)
  ) {
    // Arabic-Indic digits are AN; the rest are AL.
    if (cp >= 0x0660 && cp <= 0x0669) return "AN";
    return "AL";
  }

  // Hebrew (strong R).
  if (cp >= 0x0590 && cp <= 0x05ff) {
    return "R";
  }

  // European numbers.
  if (cp >= 0x0030 && cp <= 0x0039) {
    return "EN";
  }

  // Whitespace.
  if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f") {
    return "WS";
  }

  // ASCII letters + most of the BMP Latin/Han/etc. are strong L for our subset.
  if (
    (cp >= 0x0041 && cp <= 0x005a) ||
    (cp >= 0x0061 && cp <= 0x007a) ||
    (cp >= 0x00c0 && cp <= 0x024f) || // Latin extended
    (cp >= 0x2e80 && cp <= 0x9fff) || // CJK
    (cp >= 0xac00 && cp <= 0xd7af) // Hangul
  ) {
    return "L";
  }

  // Everything else (punctuation, symbols) is treated as neutral.
  return "ON";
}

/** Whether a bidi class is a strong right-to-left type (R or AL). */
function isRtlStrong(cls: BidiClass): boolean {
  return cls === "R" || cls === "AL";
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
// Embedding levels (a pragmatic single-paragraph UAX #9 resolution).
// ---------------------------------------------------------------------------

/**
 * Resolve a per-character embedding level for `text` under base direction
 * `base`. A pragmatic UAX #9 subset sufficient for single-paragraph mixed text:
 *
 *   - the base level is 0 (LTR) or 1 (RTL);
 *   - a strong R/AL character is level (base==rtl ? 1 : 1) — i.e. odd (RTL);
 *   - a strong L character is even (LTR);
 *   - numbers (EN/AN) take an even level one above an RTL context (so digits
 *     read left-to-right within RTL text — UAX #9's "numbers are LTR");
 *   - neutrals (WS/ON) take the level of the surrounding text, resolving to the
 *     base level at run boundaries (a simplification of rules N1/N2).
 */
export function resolveLevels(text: string, base: Direction): number[] {
  const chars = [...text];
  const baseLevel = base === "rtl" ? 1 : 0;
  const classes = chars.map(bidiClass);
  const levels = new Array<number>(chars.length).fill(baseLevel);

  for (let i = 0; i < chars.length; i += 1) {
    const cls = classes[i]!;
    if (cls === "L") {
      levels[i] = 0;
    } else if (cls === "R" || cls === "AL") {
      levels[i] = 1;
    } else if (cls === "EN" || cls === "AN") {
      // Numbers are LTR but sit one level above an RTL context.
      levels[i] = baseLevel === 1 ? 2 : 0;
    } else {
      // Neutral: resolve later from neighbours.
      levels[i] = -1;
    }
  }

  // Resolve neutrals (N1/N2 simplification): a neutral takes the level of the
  // surrounding strong text when both sides agree, else the base level.
  for (let i = 0; i < levels.length; i += 1) {
    if (levels[i] !== -1) continue;
    const left = prevResolved(levels, i);
    const right = nextResolved(levels, i);
    levels[i] = left !== null && left === right ? left : baseLevel;
  }
  return levels;
}

/** The nearest resolved level to the left of `i`, or null. */
function prevResolved(levels: readonly number[], i: number): number | null {
  for (let k = i - 1; k >= 0; k -= 1) {
    if (levels[k] !== -1) return levels[k]!;
  }
  return null;
}

/** The nearest resolved level to the right of `i`, or null. */
function nextResolved(levels: readonly number[], i: number): number | null {
  for (let k = i + 1; k < levels.length; k += 1) {
    if (levels[k] !== -1) return levels[k]!;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Visual reordering (UAX #9 rule L2).
// ---------------------------------------------------------------------------

/**
 * Reorder `text` from LOGICAL into VISUAL order (UAX #9 rule L2): from the
 * highest level down to the lowest odd level, reverse every contiguous run at
 * or above that level. The result is the sequence of code points in the order
 * they should be painted left-to-right.
 *
 * @param text the logical-order paragraph.
 * @param override an explicit base direction (else auto-detected).
 * @returns the visual-order string.
 */
export function reorderVisual(text: string, override?: Direction): string {
  const chars = [...text];
  if (chars.length === 0) {
    return "";
  }
  const base = baseDirection(text, override);
  const levels = resolveLevels(text, base);

  const maxLevel = levels.reduce((m, l) => Math.max(m, l), 0);
  let minOdd = Number.POSITIVE_INFINITY;
  for (const l of levels) {
    if (l % 2 === 1) minOdd = Math.min(minOdd, l);
  }
  if (!Number.isFinite(minOdd)) {
    return chars.join(""); // no RTL content ⇒ visual === logical.
  }

  const order = chars.slice();
  const lvl = levels.slice();
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
  return order.join("");
}

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

// ---------------------------------------------------------------------------
// Directional run segmentation (for per-run shaping).
// ---------------------------------------------------------------------------

/**
 * Split `text` into maximal {@link BidiRun}s of equal resolved embedding level,
 * in LOGICAL order. Each run is homogeneous in direction, so a complex-script
 * shaper can be invoked once per run (the "itemize then shape" pipeline). The
 * visual order of the runs themselves is given by {@link reorderVisual} / the
 * level array.
 */
export function bidiRuns(text: string, override?: Direction): readonly BidiRun[] {
  const chars = [...text];
  if (chars.length === 0) {
    return [];
  }
  const base = baseDirection(text, override);
  const levels = resolveLevels(text, base);

  const runs: BidiRun[] = [];
  let start = 0;
  for (let i = 1; i <= chars.length; i += 1) {
    if (i === chars.length || levels[i] !== levels[start]) {
      runs.push({
        start,
        end: i,
        level: levels[start]!,
        text: chars.slice(start, i).join(""),
      });
      start = i;
    }
  }
  return runs;
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
