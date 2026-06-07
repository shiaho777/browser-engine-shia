/**
 * Text shaping seam (design.md §8.2; Requirements 15.3, 8.1, 8.3).
 *
 * ## Why this module exists — the reuse boundary, made physical
 *
 * The reuse-vs-build boundary (Requirement 8.1 / 8.3) says text shaping is a
 * piece of "irreducible dirty work" the engine **reuses** rather than
 * reimplements: design.md §11 names **HarfBuzz**. Inline layout (Requirement
 * 15.3) must "perform text shaping and line breaking through the reused
 * text-shaping library". This module is that boundary, expressed as a single
 * narrow interface — {@link TextShaper} — so the layout engine depends ONLY on
 * the abstract shaper and never on a concrete shaping implementation.
 *
 *   - **(a) This is the integration seam for HarfBuzz (Req 8.3).** A production
 *     HarfBuzz / harfbuzz-wasm binding implements `TextShaper.shapeLine` (font +
 *     text → glyph advances/positions) and is injected via
 *     `layout(..., { shaper })`. Dropping in the real library changes NOTHING in
 *     the layout algorithm: line breaking already consumes only the abstract
 *     {@link ShapedRun} (advances), so the dependency points the right way
 *     (layout → shaper interface ← HarfBuzz adapter), never the wrong way.
 *
 *   - **(b) Phase 1's "no real shaping" is gone.** The Phase 1 text box was a
 *     single crude line with an advance *estimate* and no break logic
 *     (`packages/layout` task 3.7). Inline layout now runs a real shape-then-
 *     break ALGORITHM (see `index.ts` `layoutInline`) that consumes this
 *     shaper's output to measure runs and wrap lines.
 *
 *   - **(c) The default shaper is a PLACEHOLDER for the native library, not a
 *     reimplementation of it.** {@link metricsShaper} computes advances from a
 *     fixed per-em ratio (a monospace-style metric) so the engine has a
 *     dependency-light, deterministic stand-in until the HarfBuzz adapter is
 *     wired in. It deliberately does NOT attempt HarfBuzz's actual intelligence
 *     (real font metrics, kerning, ligatures, complex-script reordering, bidi);
 *     reimplementing that would VIOLATE the reuse boundary. It is honest scaffold
 *     at the seam, clearly labelled, swappable in one line.
 *
 * The interface returns per-glyph advances (and a total) so that, once a real
 * shaper lands, paint can carry the actual {@link Glyph} run; this phase uses
 * only the advances to drive inline width + line breaking.
 *
 * This module is part of the *layout* stage and imports ONLY the frozen IR
 * (`@browser-engine/ir`) — the single sanctioned inter-stage channel.
 */
import { px } from "@browser-engine/ir";
import type { Px } from "@browser-engine/ir";

/**
 * The font parameters a shaper needs. Phase 2-4 carries only `fontSize` (the
 * one font property the cascade resolves); a real HarfBuzz adapter extends this
 * (family, weight, style, language, script) WITHOUT changing the layout caller,
 * which only ever passes the resolved style through.
 */
export interface ShapingFont {
  /** The computed `font-size`, in CSS pixels — the per-em the metric scales by. */
  readonly fontSize: Px;
}

/**
 * One shaped glyph: the horizontal advance the pen moves after drawing it. A
 * real shaper also fills positional offsets and a glyph id; this seam needs only
 * the advance to measure runs, so the placeholder leaves richer fields to the
 * HarfBuzz adapter (which produces the IR {@link Glyph} for paint).
 */
export interface ShapedGlyph {
  /** Horizontal advance contributed by this glyph, in CSS pixels. */
  readonly advance: Px;
}

/**
 * The result of shaping a single run of text: the per-glyph advances and their
 * exact sum. `advance` is the run's total inline extent — the number inline
 * layout measures against the available width when breaking lines.
 */
export interface ShapedRun {
  /** Total inline advance of the run (the exact sum of `glyphs[*].advance`). */
  readonly advance: Px;
  /** Per-glyph advances, in run order. */
  readonly glyphs: readonly ShapedGlyph[];
}

/**
 * The text-shaping boundary (design.md §8.2 "layoutInline 内部调 HarfBuzz").
 *
 * A shaper turns a run of text plus a font into positioned glyph advances. This
 * is the ONLY surface the layout engine knows about; the concrete shaper —
 * the {@link metricsShaper} placeholder today, a HarfBuzz adapter tomorrow — is
 * injected, so reuse happens at this seam (Req 8.1 / 8.3).
 */
export interface TextShaper {
  /**
   * Shape a single run of text (no line breaking — that is layout's job, fed by
   * the returned advances) into glyph advances under `font`.
   */
  shapeLine(text: string, font: ShapingFont): ShapedRun;
}

/**
 * The per-em advance ratio the placeholder metric uses: each code unit advances
 * `fontSize * RATIO`. 0.5 approximates a monospace half-em glyph and matches the
 * Phase 1 text box's crude estimate (`fontSize * 0.5`), so swapping the Phase 1
 * single-line box for real shape+break does not perturb the existing
 * `<div>hello</div>` geometry. This constant lives ONLY in the placeholder; a
 * real shaper reads true font metrics instead.
 */
export const METRICS_ADVANCE_RATIO = 0.5;

/**
 * The default, dependency-light shaper: a deterministic **metrics placeholder**
 * standing in for the native HarfBuzz integration (see the module doc, point c).
 * Every code unit is given the same advance (`fontSize * {@link
 * METRICS_ADVANCE_RATIO}`), so a run's total advance is
 * `text.length * fontSize * RATIO`.
 *
 * This is NOT a reimplementation of HarfBuzz — it has no font tables, kerning,
 * ligatures, clusters, or complex-script handling. It exists so inline layout
 * has real, deterministic advances to break lines with until the HarfBuzz
 * adapter is injected via `layout(..., { shaper })`.
 */
export const metricsShaper: TextShaper = {
  shapeLine(text: string, font: ShapingFont): ShapedRun {
    const perGlyph = font.fontSize * METRICS_ADVANCE_RATIO;
    const glyphs: ShapedGlyph[] = [];
    // One advance per UTF-16 code unit. Sufficient for a metric placeholder;
    // a real shaper clusters code points into glyphs.
    for (let i = 0; i < text.length; i += 1) {
      glyphs.push({ advance: px(perGlyph) });
    }
    return { advance: px(text.length * perGlyph), glyphs };
  },
};

/** The shaper used when a caller does not inject one (the metrics placeholder). */
export const defaultShaper: TextShaper = metricsShaper;

// ---------------------------------------------------------------------------
// Proportional metrics — a PLATFORM-AS-DATA upgrade to the monospace placeholder
// ---------------------------------------------------------------------------

/**
 * Per-glyph advance widths in EM units, expressed as DATA (one bucket per
 * width-class). This is the honest next step beyond {@link metricsShaper}'s one
 * monospace ratio: real fonts give `i` a far narrower advance than `m`, so text
 * width — and therefore line breaking — becomes PROPORTIONAL. These ratios are a
 * compact metrics table calibrated to a typical sans-serif; they are still a
 * METRIC PLACEHOLDER (no kerning, ligatures, clusters, or complex-script
 * shaping — that intelligence is HarfBuzz's, reused at the {@link TextShaper}
 * seam), but they are proportional rather than fixed-pitch.
 *
 * Adding/adjusting a glyph's advance is adding/editing ONE data row here; the
 * shaper, layout, paint, and rasterizer all consume the resulting advance with
 * no code change (Platform-as-Data).
 */
const ADVANCE_EM_BY_CLASS = {
  /** `i j l I . , ! ' : ; |` — the thinnest glyphs. */
  thin: 0.26,
  /** `f t r ( ) [ ] { } / \\ " space` — narrow glyphs. */
  narrow: 0.34,
  /** the default advance for an unlisted glyph (most lowercase + punctuation). */
  normal: 0.52,
  /** digits + most uppercase — a touch wider than lowercase. */
  wide: 0.62,
  /** `m w M W @` — the widest glyphs. */
  widest: 0.86,
} as const;

/** Membership lists driving {@link proportionalAdvanceEm} (DATA, one char per cell). */
const THIN_CHARS = "ijlI.,!':;|`";
const NARROW_CHARS = "ftr()[]{}/\\\" ";
const WIDE_CHARS = "0123456789ABCDEFGHIJKLNOPQRSTUVXYZ";
const WIDEST_CHARS = "mwMW@";

const ADVANCE_EM: ReadonlyMap<number, number> = (() => {
  const map = new Map<number, number>();
  const put = (chars: string, em: number): void => {
    for (const ch of chars) map.set(ch.codePointAt(0)!, em);
  };
  // Order matters least-to-most specific; later puts win for any overlap.
  put(WIDE_CHARS, ADVANCE_EM_BY_CLASS.wide);
  put(NARROW_CHARS, ADVANCE_EM_BY_CLASS.narrow);
  put(THIN_CHARS, ADVANCE_EM_BY_CLASS.thin);
  put(WIDEST_CHARS, ADVANCE_EM_BY_CLASS.widest);
  return map;
})();

/** The EM-advance of one code point under the proportional metrics table. */
export function proportionalAdvanceEm(codePoint: number): number {
  return ADVANCE_EM.get(codePoint) ?? ADVANCE_EM_BY_CLASS.normal;
}

/**
 * A PROPORTIONAL metrics shaper: each code unit advances `fontSize ×
 * proportionalAdvanceEm(cp)` rather than a single fixed ratio, so `"Wi"` and
 * `"il"` measure differently and line breaking honours real glyph widths. Still
 * a metrics placeholder at the HarfBuzz seam (no shaping intelligence), but
 * proportional — the honest fidelity step the pipeline injects via
 * `layout(..., { shaper: proportionalShaper })`.
 */
export const proportionalShaper: TextShaper = {
  shapeLine(text: string, font: ShapingFont): ShapedRun {
    const glyphs: ShapedGlyph[] = [];
    let total = 0;
    for (const ch of text) {
      // Iterating by code point (not UTF-16 unit) so astral glyphs measure once.
      const adv = font.fontSize * proportionalAdvanceEm(ch.codePointAt(0)!);
      for (let u = 0; u < ch.length; u += 1) {
        // Attribute the cluster advance to its first unit; trailing surrogate
        // halves contribute zero, keeping `glyphs.length === text.length`.
        glyphs.push({ advance: px(u === 0 ? adv : 0) });
      }
      total += adv;
    }
    return { advance: px(total), glyphs };
  },
};
