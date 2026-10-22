/**
 * harfbuzz.ts — real text shaping via HarfBuzz WASM (RFC 0002; design.md §11's
 * named reuse: "HarfBuzz"). `harfbuzzjs` is the official WASM build maintained
 * by the HarfBuzz project itself; the engine does NOT reimplement shaping —
 * glyph selection, ligatures, kerning, mark positioning, Arabic joining, and
 * in-run bidirectional reordering are HarfBuzz's, reused behind this adapter.
 *
 * ## What this module owns vs reuses
 *
 * HarfBuzz shapes ONE run on ONE face; it deliberately does not do font
 * fallback. The engine-owned half here is therefore exactly the
 * `fallbackCoverageSource` job re-expressed at the right layer: shape a run on
 * the first candidate face, detect `.notdef` (gid 0) clusters, regroup the
 * contiguous missing spans, and re-shape those spans on the next face — so a
 * glyph stream can draw on several faces while staying in visual order.
 *
 * The product is a stream of REAL per-face glyph ids + positions + source
 * clusters (see {@link HarfBuzzGlyph}) in *em* units; callers scale by their
 * own pixel font-size. The module imports only `./types.js` — it is
 * infrastructure, consumed by stages through injected seams.
 *
 * The WASM module itself is loaded by the CALLER (`await import("harfbuzzjs")`
 * — the package self-initializes under a top-level await) and injected into
 * {@link HarfBuzzShaper}'s constructor, so this file stays synchronously
 * importable and testable.
 */
import type { FontFace } from "./types.js";
import type { FontFeatureSpec, FontVariation } from "./features.js";

/**
 * The `harfbuzzjs` module namespace — the shape the package's public export
 * takes once its top-level WASM init resolves.
 */
export type HarfBuzzApi = typeof import("harfbuzzjs");

/** Options for shaping one homogeneous run. */
export interface ShapeOptions {
  /** Resolved bidi direction of the run; default `"ltr"`. */
  readonly direction?: "ltr" | "rtl";
  /** ISO 15924 / OpenType script tag ("Latn", "Hebr", "Arab", "Hani", …). */
  readonly script?: string;
  /** BCP 47 language tag for language-sensitive shaping, if known. */
  readonly language?: string;
  /**
   * OpenType feature requests (RFC 0005 — `font-kerning`/`font-variant*`/
   * `font-feature-settings` folded into one ordered list by
   * {@link cssFontFeatures}); each becomes an `hb_feature_t` applied for the
   * whole buffer.
   */
  readonly features?: readonly FontFeatureSpec[];
  /**
   * Variation-axis settings (`font-variation-settings` + `font-optical-sizing`
   * → `opsz`). Each distinct set gets its own `hb_font` cache slot so a
   * variation never leaks into another run on the same face.
   */
  readonly variations?: readonly FontVariation[];
}

/**
 * One shaped glyph, in FONT units normalized to em fractions (positions divided
 * by the face's `unitsPerEm`): the caller multiplies by the pixel font-size.
 *
 * `glyphId` is the REAL font-local glyph index HarfBuzz selected on
 * `faceIndex` — an index into the face table handed to the constructor. `gid 0`
 * is the font's `.notdef` glyph and is emitted (not dropped) when the whole
 * face table fails to cover a span: missing coverage paints visibly.
 */
export interface HarfBuzzGlyph {
  readonly glyphId: number;
  readonly faceIndex: number;
  /** UTF-16 offset of the cluster's first code unit within the shaped text. */
  readonly cluster: number;
  /** Pen advance in ems. */
  readonly advanceEm: number;
  /** Draw offset from the pen position in ems (positive = up). */
  readonly xOffsetEm: number;
  readonly yOffsetEm: number;
}

/** A positioned glyph as returned by HarfBuzz (informal shape of the API). */
interface HbShapedGlyph {
  readonly codepoint: number; // the glyph id after shaping
  readonly cluster: number;
  readonly xAdvance?: number;
  readonly yAdvance?: number;
  readonly xOffset?: number;
  readonly yOffset?: number;
}

/**
 * A HarfBuzz-backed run shaper over a fixed face table. One `hb_font` per face
 * is created lazily (scaled to `unitsPerEm` so positions come back in design
 * units); `shape` tries candidate faces in order and splices fallback results
 * in at the exact output position of the missing span.
 */
/** HarfBuzz's `Font` instance type, resolved off the injected module namespace. */
type HbFont = InstanceType<HarfBuzzApi["Font"]>;

export class HarfBuzzShaper {
  readonly #hb: HarfBuzzApi;
  readonly #faces: readonly FontFace[];
  /** `${faceIndex}` or `${faceIndex}|${variationKey}` → hb font. */
  readonly #hbFonts = new Map<string, { font: HbFont; upem: number } | null>();

  constructor(hb: HarfBuzzApi, faces: readonly FontFace[]) {
    this.#hb = hb;
    this.#faces = faces;
  }

  /** The faces this shaper resolves `faceIndex` against (the pipeline table). */
  get faces(): readonly FontFace[] {
    return this.#faces;
  }

  /**
   * The hb font for `faces[faceIndex]` under `variations`, or `null` when the
   * face has no byte data (programmatically constructed faces carry no sfnt —
   * they cannot be shaped, only rasterized through coverage).
   */
  #hbFont(
    faceIndex: number,
    variations?: readonly FontVariation[],
  ): { font: HbFont; upem: number } | null {
    const key =
      variations === undefined || variations.length === 0
        ? String(faceIndex)
        : `${faceIndex}|${variations.map((v) => `${v.tag}=${v.value}`).join(",")}`;
    const cached = this.#hbFonts.get(key);
    if (cached !== undefined) return cached;
    const face = this.#faces[faceIndex];
    let entry: { font: HbFont; upem: number } | null = null;
    if (face !== undefined && face.data !== undefined) {
      const blob = new this.#hb.Blob(face.data);
      const hbFace = new this.#hb.Face(blob, face.collectionIndex ?? 0);
      const font = new this.#hb.Font(hbFace);
      font.setScale(face.unitsPerEm, face.unitsPerEm);
      if (variations !== undefined && variations.length > 0) {
        font.setVariations(variations.map((v) => new this.#hb.Variation(v.tag, v.value)));
      }
      entry = { font, upem: face.unitsPerEm };
    }
    this.#hbFonts.set(key, entry);
    return entry;
  }

  /**
   * Shape `text` with `faces[faceIndex]`. Returns the raw glyph stream in
   * hb-visual order, or `null` when the face cannot be shaped (no `data`).
   */
  #shapeRun(text: string, faceIndex: number, options?: ShapeOptions): HbShapedGlyph[] | null {
    const entry = this.#hbFont(faceIndex, options?.variations);
    if (entry === null) return null;
    const buf = new this.#hb.Buffer();
    buf.addText(text);
    buf.guessSegmentProperties();
    // Explicit properties beat the guess; absent ⇒ keep the guessed values
    // (HarfBuzz's own script/direction detection stays the default).
    if (options?.direction !== undefined) {
      buf.setDirection(
        options.direction === "rtl" ? this.#hb.Direction.RTL : this.#hb.Direction.LTR,
      );
    }
    if (options?.script !== undefined) buf.setScript(options.script);
    if (options?.language !== undefined) buf.setLanguage(options.language);
    const features =
      options?.features === undefined
        ? []
        : options.features.map((f) => new this.#hb.Feature(f.tag, f.value));
    this.#hb.shape(entry.font, buf, features);
    return buf.getGlyphInfosAndPositions();
  }

  /**
   * Shape `text`, walking `faceOrder` for coverage. Emits a glyph stream in
   * VISUAL order (HarfBuzz output order — RTL runs already reversed) where
   * each glyph names the face that actually covers it.
   *
   * Glyphs the first face cannot map come back `gid === 0`; their contiguous
   * cluster spans are re-shaped on the next face and spliced in where the
   * missing glyphs sat, preserving the surrounding visual order. A span no
   * face covers keeps the primary face's `.notdef` output.
   */
  shape(text: string, faceOrder: readonly number[], options?: ShapeOptions): HarfBuzzGlyph[] {
    const out: HarfBuzzGlyph[] = [];
    this.#shapeInto(text, 0, faceOrder, options, out);
    return out;
  }

  #shapeInto(
    text: string,
    clusterBase: number,
    faceOrder: readonly number[],
    options: ShapeOptions | undefined,
    out: HarfBuzzGlyph[],
  ): void {
    const faceIndex = faceOrder.find(
      (i) => this.#hbFont(i, options?.variations) !== null,
    );
    if (faceIndex === undefined) return; // no shapable face in the table at all.
    const entry = this.#hbFont(faceIndex, options?.variations);
    if (entry === null) return; // unreachable: `find` already checked — defensive.
    const upem = entry.upem;
    const run = this.#shapeRun(text, faceIndex, options);
    if (run === null) return;
    const rest = faceOrder.filter((i) => i !== faceIndex);

    // Contiguous missing-cluster spans → the substrings to re-shape. Cluster
    // values are UTF-16 offsets into `text` (hb_buffer_add_utf16 semantics).
    const missing = missingSpans(run, text.length);
    if (missing.length === 0 || rest.length === 0) {
      for (const g of run) out.push(this.#toGlyph(g, faceIndex, upem, clusterBase));
      return;
    }
    // Walk the hb output in its own (visual) order; whenever a `.notdef` glyph
    // is hit, its whole missing span is contiguous in the output and gets
    // replaced by the span re-shaped on the next candidate face. Iterating by
    // output position — not by span order — is what keeps multi-span RTL runs
    // spliced at the right visual position.
    let cursor = 0;
    while (cursor < run.length) {
      const g = run[cursor]!;
      const span =
        g.codepoint === 0
          ? missing.find((s) => g.cluster >= s.start && g.cluster < s.end)
          : undefined;
      if (span === undefined) {
        out.push(this.#toGlyph(g, faceIndex, upem, clusterBase));
        cursor += 1;
        continue;
      }
      while (
        cursor < run.length &&
        run[cursor]!.codepoint === 0 &&
        run[cursor]!.cluster >= span.start &&
        run[cursor]!.cluster < span.end
      ) {
        cursor += 1;
      }
      this.#shapeInto(
        text.slice(span.start, span.end),
        clusterBase + span.start,
        rest,
        options,
        out,
      );
    }
  }

  #toGlyph(g: HbShapedGlyph, faceIndex: number, upem: number, clusterBase: number): HarfBuzzGlyph {
    return {
      glyphId: g.codepoint,
      faceIndex,
      cluster: g.cluster + clusterBase,
      advanceEm: (g.xAdvance ?? 0) / upem,
      xOffsetEm: (g.xOffset ?? 0) / upem,
      yOffsetEm: (g.yOffset ?? 0) / upem,
    };
  }
}

interface ClusterSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * The source-text spans that produced `.notdef` glyphs. A cluster start `c`
 * covers `text[c .. nextClusterStart)`; maximal adjacent missing ranges merge
 * into one span so the fallback face reshapes a contiguous substring.
 */
function missingSpans(run: readonly HbShapedGlyph[], textLength: number): ClusterSpan[] {
  const missing = new Set<number>();
  for (const g of run) {
    if (g.codepoint === 0) missing.add(g.cluster);
  }
  if (missing.size === 0) return [];
  const bounds = [...new Set(run.map((g) => g.cluster))].sort((a, b) => a - b);
  bounds.push(textLength);
  const spans: { start: number; end: number }[] = [];
  for (let i = 0; i + 1 < bounds.length; i += 1) {
    const c = bounds[i]!;
    if (!missing.has(c)) continue;
    const end = bounds[i + 1]!;
    const last = spans[spans.length - 1];
    if (last !== undefined && last.end === c) last.end = end;
    else spans.push({ start: c, end });
  }
  return spans;
}
