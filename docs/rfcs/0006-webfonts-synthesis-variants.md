# RFC 0006: Web Font Loading (`@font-face`), `font-synthesis`, and the `font-variant-*` Longhands

- **Status**: Implemented
- **Depends on**: RFC 0002 (HarfBuzz shaping seam), RFC 0005 (family registry + CSS feature plumbing), RFC 0004 (web-content workers)

## Context

RFC 0005 wired the computed `font-*` strings through `ShapingFont.css` into a
real `FontRegistry` + HarfBuzz. Three deliberate gaps remained:

1. **`@font-face` was parsed-and-dropped** — the css-parser skipped the block,
   so no stylesheet could introduce a family. `font-family` could only name
   system fonts.
2. **`font-synthesis` was parsed but never honored** — the backends embolden
   every `fontWeight ≥ 500` run unconditionally (and double-bold real bold
   faces), with no way for CSS to suppress synthesis.
3. **`font-variant-*` longhands didn't exist** — only `font-variant`
   (normal/small-caps keyword) and `font-variant-numeric` were in the data
   table; `font-variant-ligatures`, `-caps`, `-position`, `-east-asian`, and
   `-alternates` (and the shorthand's full grammar) had no computed surface.

## Decision

### `@font-face`: descriptor collection → fetch → scoped registration

**IR** — `StyleSheet` gains `fontFaces: readonly FontFaceRule[]`. A
`FontFaceRule` is `{ declarations: readonly Declaration[] }` — the descriptor
block reuses the same declaration grammar as style rules.

**font package (`fontface.ts`)** — pure descriptor parsing, no I/O:

- `parseFontFaceRule(decls)` → `{ family, sources, weight, style, stretch }` —
  `src` items are `local(<name|string>)` or `url(<url>)` with optional
  `format(<str>)`/`tech(<str>)` hints. A `format()` we cannot rasterize
  (`woff2`, `opentype` inside a CFF container is fine, `woff` unwraps)
  disqualifies only THAT source — the spec's source-list walk.
- `woff.ts` — WOFF 1.0 unwrapping (zlib inflate per table → rebuilt sfnt
  bytes). `woff2` (brotli) is out of scope and skipped at the `format()` hint
  or the magic sniff.

**Registry scoping** — `register`/`resolve`/`findLocal` take an optional
`scope`. Page-registered faces are:

- reachable ONLY when the resolving scope matches (no cross-tab family leaks —
  page A's `"MyWebFont"` does not exist for page B), and
- EXCLUDED from the default fallback chain (per CSS Fonts §4 a webfont is used
  only when its declared family is named — it is never a generic substitute).

`findLocal(name, scope)` matches a `local()` source against registered
`postscriptName`/`fullName`/`family` (eager and probed entries — the probe has
already read the `name` table, so `local()` never materializes a file it
doesn't select).

**cli (`webfonts.ts`)** — the async seam, mirroring `loader.ts`'s model
(network is effectful and belongs outside the kernel): collect descriptors
from every sheet in document order; walk each `src` list in order — `local()`
hits the registry, `url()` resolves against the document base URL, decodes
`data:` payloads inline, then consults the prefetched `ResourceCache`, then
`fetchBytes` (default `defaultFetch`). The first source that yields a parseable
face is registered under the descriptor's declared metadata and the page's
scope; its diagnostics join `ResourceLoadEvent`-style records.

**Wiring** — `app/page.ts` `renderDom` registers sheets' faces under scope =
the page URL, then lays out with `pipelineShaperFor(scope)` — a factory over
the module registry so `resolve` sees the page's entries. `cli/render.ts` does
the same unscoped→page-scoped step for the static path. The synchronous kernel
pipeline is untouched: fonts are READY BEFORE layout because registration is a
phase before `layout()`, exactly like images before paint.

**Latent fix** — `qFineLayoutStyle`'s `LAYOUT_FIELDS` projection had never
carried ANY font field beyond `fontSize` (family/weight/style/features…), so
the incremental pipeline's layout silently ignored RFC-0005's font plumbing.
All layout-relevant font + bidi + text-transform fields are now whitelisted —
font changes correctly invalidate layout in the FineSession path.

### `font-synthesis`: an honest synthetic-bold gate

- Data-table initial corrected to the spec value `weight style small-caps`.
- Layout folds the computed value into `TextRun.synthesizeBold` (allowed iff
  the value contains `weight` or is `auto`; `none` and lists without `weight`
  disallow).
- Paint copies it to `PaintCmd.synthesizeBold`.
- All three backends share `needsSyntheticBold` (`backend/embolden.ts`):
  `weight ≥ 500 && synthesizeBold !== false && face.weight < weight` — the
  face-deficit clause also FIXES the double-bolding of a genuinely-bold
  selected face. `FontFace` gains `weight` (read from `OS/2.usWeightClass`).
- `style`/`small-caps` tokens are parsed but have no synthetic consumer (we do
  not fake oblique or small-caps) — recorded, not stubbed.

### `font-variant-*` longhands + the real shorthand

- Data table grows `font-variant-ligatures`, `font-variant-caps`,
  `font-variant-position`, `font-variant-east-asian`, `font-variant-alternates`
  (all inherited strings, initial `normal`).
- `font-variant` registers in the generator's shorthand table: a paren-aware
  tokenizer routes each token to its longhand (`small-caps` → `-caps`,
  ligature/numeric/east-asian/position keywords → their longhands, the six
  functional notations → `-alternates`).
- `features.ts` maps the longhands to hb tags: ligatures → `liga`/`clig`/
  `dlig`/`hlig`/`calt` on/off; caps → `smcp`/`c2sc`/`pcap`/`c2pc`/`unic`/`titl`;
  position → `subs`/`sups`; east-asian → `jp78`/`jp83`/`jp90`/`jp04`/`smpl`/
  `trad`/`fwid`/`pwid`/`ruby`; alternates → `ssNN`/`swsh`/`ornm`/`nalt`/
  `cvNN`/`hist`. `font-feature-settings` still overrides everything shorthand-
  derived (CSS Fonts §7).

## Non-goals / honesty ledger

- **WOFF2** (brotli) is not unwrapped; `format("woff2")` sources are skipped.
- **CFF-flavored `.otf`** faces still cannot materialize through
  `parseTrueType` (our glyf parser) — they remain selectable via `local()`/raw
  bytes for HarfBuzz+Skia but not via `registerFile`. Noted, not hidden.
- `unicode-range` is not implemented — coverage-driven fallback ordering is the
  engine's equivalent today.
- `font-synthesis` does not add synthetic oblique or fake small-caps (none
  exist to disable); only the synthetic-bold path is gated.
- Async font *swap-in* (FOUT relayout) is not modeled: faces resolve before the
  first layout, matching a zero-block-period `font-display: block` document.
