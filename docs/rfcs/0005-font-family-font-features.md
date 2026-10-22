# RFC 0005: `font-family` selection + OpenType feature/variation plumbing

Status: Implemented

Owner: engine contributors

Labels: `rfc`, `stage:font`, `stage:layout`, `stage:cascade`

## Decision

Give the computed font properties real meaning end-to-end:

```text
computed style (font-family / font-feature-settings / font-kerning /
                font-variant / font-variant-numeric / font-variation-settings /
                font-optical-sizing / font-stretch / font-synthesis)
   -> ShapingFont.css (raw computed strings across the layout→shaper seam)
   -> FontRegistry.resolve  (family list -> ordered master-table indices)
   -> HarfBuzzShaper       (Feature[] + Variation[] -> hb_shape)
   -> glyph(faceIndex, gid) -> existing backends (unchanged)
```

Two seams, both already sanctioned: `ShapingFont` carries the CSS selection
verbatim (a `css` bag), and `packages/font` owns every parse of CSS font
micro-syntax. Layout copies strings; the font package interprets them.

### Family names

`FontFace` gains no fields; instead `names.ts` adds a **cheap sfnt reader**
`readSfntFaceInfo(bytes) → SfntFaceInfo[]` that reads the `name` table (IDs
16→1 family, 17→2 subfamily) and `OS/2` (`usWeightClass`, `fsSelection`
italic bit, `usWidthClass`) per face — `ttcf` collections included. It does
NOT parse glyph data: probing hundreds of system font files costs name-table
reads only.

`registry.ts` adds `FontRegistry`:

- `register(face)` — eager faces (the pipeline's preferred + builtin faces),
  metadata extracted from `face.data` or supplied explicitly.
- `registerFile(path)` — lazy: name/OS2 info only; the `FontFace` is
  materialized (`parseTrueType`) on first resolve hit and appended to the
  registry's append-only master table.
- `faces` — the live master array exported as `pipelineFaceTable`; backends
  already index it per glyph and cache per-face lazily, so late appends work.
- `alias(generic, family)` — maps CSS generic families (`sans-serif`,
  `serif`, `monospace`, `cursive`, `fantasy`, `system-ui`) onto registered
  families.
- `resolve(requested, {weight, italic, widthClass}) → number[]` — per CSS
  font matching §5.2 (simplified honestly): requested families in order, each
  mapped to its best-weight member, then the generic alias target, then the
  registry's default fallback chain. Every entry is a master-table index;
  missing families skip loudly-okay (uninstalled families are normal).

`parseTrueType` gains an optional `faceIndex` so `ttcf` members materialize;
`compileTrueType` gains an optional `names` block so tests can mint
family-named fonts deterministically.

### Features

`features.ts` parses the CSS strings into HarfBuzz arguments:

- `parseFontFamilyList` — comma list, unquotes `"…"/'…'`, preserves generics.
- `parseFontFeatureSettings` — `"tag" <int|on|off>` entries → `Feature` specs;
  hb accepts the quoted-CSS form natively (`Feature.fromString`).
- `cssFontFeatures({kerning, variant, variantNumeric, featureSettings})` —
  maps `font-kerning: none` → `-kern`; `font-variant: small-caps` → `+smcp`;
  `font-variant-numeric` keywords → `lnum/onum/pnum/tnum/frac/afrc/ordn/zero`;
  then appends `font-feature-settings` entries last (per CSS Fonts §7 they
  override the shorthand-derived features).
- `parseVariationSettings` — `"wght" 700, "wdth" 75` → `{tag, value}[]`;
  `font-optical-sizing: auto` contributes `opsz = fontSize`.
- `font-stretch` maps to `usWidthClass` preference in `resolve` (percentage
  keywords land on the standard 1–9 class scale).

### Shaper

`HarfBuzzShaper.shape(text, order, options)` gains `features?: FeatureSpec[]`
and `variations?: {tag, value}[]`. Features go straight to
`hb.shape(font, buf, Feature[])`; variations call `font.setVariations` around
the shape (the per-face hb font cache resets them afterward so a variant set
never leaks into the next run).

`cli/fonts.ts` builds the registry: preferred regular+bold+builtin registered
eagerly, then every `*.ttf/.otf/.ttc` under `discoverSystemFontDirs()` gets a
`registerFile` probe. `pipelineShaper` resolves `font.css` per run.

## Non-goals

- `@font-face` / web fonts — downloads are a networking+stylesheet feature;
  the registry accepts them later via `register`.
- `font-variant-ligatures/-east-asian/-alternates` — the property table only
  ships `font-variant` + `font-variant-numeric`; adding them is a generator
  row, not an architecture change.
- `font-size-adjust`, `font-synthesis` control — parsed but not yet honored
  (synthetic bold currently follows the raster oracle's ≥600 rule; exposing
  `font-synthesis: none` is a follow-up).
- `unicode-range`-driven family splitting — coverage-based per-glyph fallback
  already does the honest equivalent for our face tables.

## Evidence

- `names.test.ts`: compiled test fonts carry a real `name` table;
  `readSfntFaceInfo` recovers family/subfamily/weight incl. ttcf members.
- `features.test.ts`: family-list/quote parse, `"kern" 0`→`-kern`,
  variant keyword → tag map, variation parse, precedence order.
- `registry.test.ts`: resolve order, weight pick, generic alias, lazy
  materialization appends master-table indices stably.
- `harfbuzz.test.ts` (conditional on a system font with `kern`): shaping with
  `kern` disabled widens a kerning pair measurably — the features reach hb.
- `inline.test.ts`: a capturing shaper asserts `font.css` fields flow from
  computed style into the shaping seam.

## Rollback

`ShapingFont.css` is optional; a shaper ignoring it degenerates to RFC 0004
behavior (family-insensitive default table, no explicit features). The
registry is additive beside `loadPreferredSystemFont`.
