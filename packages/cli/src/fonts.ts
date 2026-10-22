import { readdirSync } from "node:fs";
import { join } from "node:path";

import { px } from "@browser-engine/ir";
import {
  builtinFont,
  cssFontFeatures,
  discoverSystemFontDirs,
  faceTableRasterSource,
  fontStretchWidthClass,
  FontRegistry,
  HarfBuzzShaper,
  loadPreferredSystemBoldFont,
  loadPreferredSystemFont,
  parseFontFamilyList,
  readSfntFaceInfo,
  parseVariationSettings,
  type FontFace,
  type GlyphRasterSource,
} from "@browser-engine/font";
import type { ShapingFont, ShapedRun, TextShaper } from "@browser-engine/layout";

// `harfbuzzjs` self-initializes under a top-level await (RFC 0002): the import
// promise resolves only after the WASM module is instantiated, so Node ESM
// evaluates every importer of this file AFTER HarfBuzz is ready — the shaper
// below is synchronously callable at query time with no init plumbing.
const hb = await import("harfbuzzjs");

// ---------------------------------------------------------------------------
// The pipeline font registry (RFC 0005): eager default chain + lazily probed
// system font files. `registry.faces` is the master table — append-only, the
// same array the shaper's faceIndex and the backends' raster sources index.
// ---------------------------------------------------------------------------
const registry = new FontRegistry();

const systemRegular = loadPreferredSystemFont();
if (systemRegular !== null) registry.register(systemRegular, { weightClass: 400 });
const systemBold = loadPreferredSystemBoldFont();
if (systemBold !== null) registry.register(systemBold, { weightClass: 700 });
registry.register(builtinFont(), {
  family: "browser-engine-builtin",
  weightClass: 400,
});

// Probe the platform font directories: `name`/`OS/2` tables only — glyph data
// materializes lazily on first selection (registry.registerFile).
for (const dir of discoverSystemFontDirs()) {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    continue;
  }
  for (const name of entries) {
    if (!/\.(ttf|ttc|otf)$/i.test(name)) continue;
    registry.registerFile(join(dir, name));
  }
}

// ---- generic family aliases ------------------------------------------------
// `sans-serif`/`system-ui` anchor on the pipeline's preferred face's own
// family name; the others pick the first probed candidate that exists.
const SANS_FAMILY = (() => {
  if (systemRegular === null || systemRegular.data === undefined) return null;
  try {
    const info = readSfntFaceInfo(systemRegular.data)[systemRegular.collectionIndex ?? 0];
    return info?.family ?? null;
  } catch {
    return null;
  }
})();

function firstFamily(candidates: readonly string[]): string | null {
  const known = new Set(registry.families());
  for (const c of candidates) {
    if (known.has(c.toLowerCase())) return c;
  }
  return null;
}

const SERIF_FAMILY = firstFamily([
  "times new roman",
  "times",
  "georgia",
  "new york",
  "noto serif",
  "dejavu serif",
  "songti sc",
  "simsun",
]);
const MONO_FAMILY = firstFamily([
  "menlo",
  "courier new",
  "courier",
  "monaco",
  "dejavu sans mono",
  "noto sans mono",
  "sf mono",
]);
const CURSIVE_FAMILY = firstFamily([
  "comic sans ms",
  "apple chancery",
  "snell roundhand",
  "caveat",
]);
const FANTASY_FAMILY = firstFamily(["papyrus", "impact", "copperplate"]);
const MATH_FAMILY = firstFamily(["stix two math", "cambria math", "latin modern math"]);

registry.alias("sans-serif", SANS_FAMILY ?? "sans-serif");
if (SANS_FAMILY !== null) {
  registry.alias("system-ui", SANS_FAMILY);
  registry.alias("ui-sans-serif", SANS_FAMILY);
}
if (SERIF_FAMILY !== null) {
  registry.alias("serif", SERIF_FAMILY);
  registry.alias("ui-serif", SERIF_FAMILY);
}
if (MONO_FAMILY !== null) {
  registry.alias("monospace", MONO_FAMILY);
  registry.alias("ui-monospace", MONO_FAMILY);
}
if (CURSIVE_FAMILY !== null) registry.alias("cursive", CURSIVE_FAMILY);
if (FANTASY_FAMILY !== null) registry.alias("fantasy", FANTASY_FAMILY);
if (MATH_FAMILY !== null) registry.alias("math", MATH_FAMILY);
registry.alias("ui-rounded", CURSIVE_FAMILY ?? SANS_FAMILY ?? "sans-serif");
registry.alias(
  "emoji",
  firstFamily(["apple color emoji", "noto color emoji", "segoe ui emoji"]) ?? "sans-serif",
);
registry.alias("fangsong", firstFamily(["fangsong", "stfangsong", "songti sc"]) ?? "serif");

/** The pipeline's live font registry — exported for tests and tooling. */
export const pipelineFontRegistry: FontRegistry = registry;

const FACES: readonly FontFace[] = registry.faces.slice(0, registry.defaultOrder().length);
const BOLD_FACES: readonly FontFace[] = [
  ...(systemBold !== null ? [systemBold] : []),
  ...FACES.filter((f) => f !== systemBold),
];

export const pipelineFaces: readonly FontFace[] = FACES;
export const pipelineBoldFaces: readonly FontFace[] = BOLD_FACES;

/**
 * The MASTER FACE TABLE — the registry's live append-only array: a shaped
 * glyph's `faceIndex` resolves against it on BOTH sides of the DisplayList
 * boundary (shaper emits, backends consume). Late `registerFile`
 * materializations append here — index stability is guaranteed because the
 * table only ever grows.
 */
export const pipelineFaceTable: readonly FontFace[] = registry.faces;

const hbShaper = new HarfBuzzShaper(hb, pipelineFaceTable);

/**
 * The pipeline's real shaper (RFC 0002 + RFC 0005): HarfBuzz WASM behind the
 * `TextShaper` seam. `font.css` carries the computed font-selection strings —
 * `font-family` resolves against the registry (requested family → best
 * weight/style member → generic alias → default chain); `font-kerning`,
 * `font-variant*`, and `font-feature-settings` fold into hb feature specs;
 * `font-variation-settings` + `font-optical-sizing` become hb variations.
 */
/**
 * Build a `TextShaper` bound to a font scope (RFC 0006): `scope` is the page
 * identity a `@font-face` registration is tagged with — the resolver sees the
 * page's webfonts only when its scope matches. `pipelineShaperFor(undefined)`
 * sees global faces only.
 */
export function pipelineShaperFor(scope?: unknown): TextShaper {
  return {
    shapeLine(text: string, font: ShapingFont): ShapedRun {
      const css = font.css;
      const weight = font.fontWeight ?? 400;
      const style = (css?.style ?? "normal").toLowerCase();
      const order = registry.resolve(
        parseFontFamilyList(css?.family ?? "sans-serif"),
        {
          weight,
          italic: style === "italic" || style.startsWith("oblique"),
          widthClass: fontStretchWidthClass(css?.stretch ?? "normal") ?? 5,
        },
        scope,
      );
      const features = cssFontFeatures({
        ...(css?.kerning !== undefined ? { kerning: css.kerning } : {}),
        ...(css?.variantLigatures !== undefined ? { variantLigatures: css.variantLigatures } : {}),
        ...(css?.variantCaps !== undefined ? { variantCaps: css.variantCaps } : {}),
        ...(css?.variantPosition !== undefined ? { variantPosition: css.variantPosition } : {}),
        ...(css?.variantEastAsian !== undefined ? { variantEastAsian: css.variantEastAsian } : {}),
        ...(css?.variantAlternates !== undefined ? { variantAlternates: css.variantAlternates } : {}),
        ...(css?.variantNumeric !== undefined ? { variantNumeric: css.variantNumeric } : {}),
        ...(css?.featureSettings !== undefined ? { featureSettings: css.featureSettings } : {}),
      });
      const variations = [...parseVariationSettings(css?.variationSettings ?? "")];
      if (
        (css?.opticalSizing ?? "auto") === "auto" &&
        !variations.some((v) => v.tag === "opsz")
      ) {
        variations.push({ tag: "opsz", value: Number(font.fontSize) });
      }
      const shaped = hbShaper.shape(text, order, {
        ...(font.direction === undefined ? {} : { direction: font.direction }),
        ...(font.script === undefined ? {} : { script: font.script }),
        ...(font.language === undefined ? {} : { language: font.language }),
        features,
        variations,
      });
      const size = font.fontSize;
      const glyphs: ShapedRun["glyphs"][number][] = [];
      let total = 0;
      for (const g of shaped) {
        const advance = px(g.advanceEm * size);
        glyphs.push({
          advance,
          glyphId: g.glyphId,
          faceIndex: g.faceIndex,
          xOffset: px(g.xOffsetEm * size),
          yOffset: px(-g.yOffsetEm * size),
          cluster: g.cluster,
        });
        total += Number(advance);
      }
      return { advance: px(total), glyphs };
    },
    fontMetrics(font: ShapingFont) {
      const css = font.css;
      const weight = font.fontWeight ?? 400;
      const style = (css?.style ?? "normal").toLowerCase();
      const order = registry.resolve(
        parseFontFamilyList(css?.family ?? "sans-serif"),
        {
          weight,
          italic: style === "italic" || style.startsWith("oblique"),
          widthClass: fontStretchWidthClass(css?.stretch ?? "normal") ?? 5,
        },
        scope,
      );
      const face = pipelineFaceTable[order[0] ?? 0];
      if (face === undefined || face.unitsPerEm <= 0) return undefined;
      return {
        ...(face.xHeight !== undefined ? { xHeightEm: face.xHeight / face.unitsPerEm } : {}),
        ...(face.subscriptOffset !== undefined ? { subscriptEm: -face.subscriptOffset / face.unitsPerEm } : {}),
        ...(face.superscriptOffset !== undefined ? { superscriptEm: face.superscriptOffset / face.unitsPerEm } : {}),
      };
    },
  };
}

/**
 * The pipeline's real shaper (RFC 0002 + RFC 0005): HarfBuzz WASM behind the
 * `TextShaper` seam. `font.css` carries the computed font-selection strings —
 * `font-family` resolves against the registry (requested family → best
 * weight/style member → generic alias → default chain); `font-kerning`,
 * `font-variant*`, and `font-feature-settings` fold into hb feature specs;
 * `font-variation-settings` + `font-optical-sizing` become hb variations.
 * The unscoped default — `@font-face` pages use {@link pipelineShaperFor}.
 */
export const pipelineShaper: TextShaper = pipelineShaperFor();

/**
 * The backend glyph raster source over the master face table (RFC 0002):
 * `raster(faceIndex, gid, sizePx)` draws the real shaped glyph. Replaces the
 * code-point-slot-id `pipelineGlyphSource` — resolution lives in the shaper.
 */
export const pipelineRasterSource: GlyphRasterSource = faceTableRasterSource(pipelineFaceTable);

export function pipelinePrimaryFontName(): string {
  const family = SANS_FAMILY;
  return family !== null ? family : "builtin";
}
