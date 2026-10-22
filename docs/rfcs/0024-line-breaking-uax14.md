# RFC 0024 — Line breaking (UAX #14): break-class table, pair rules, CSS Text keywords

Status: implemented (pragmatic class-table subset, documented bounds)
Packages: `layout` (`linebreak.ts` — new; `index.ts` — unit pipeline in both
inline paths, boundary-space carry, soft-hyphen glyphs), `cli`
(`linebreak.test.ts`)

## Decision

**The line packer consumes maximal *unbreakable units*; producing them is the
pair table's job.** Before this RFC the packer's unit was a whitespace-split
"word": `text.split(/\s+/)` made every boundary a break and re-emitted a
space advance between *all* adjacent words — which broke CJK text (no breaks
between ideographs), glued adjacent text nodes with phantom spaces, and let
`break-all` insert space advances between characters. The new
`linebreak.ts` owns the classification and the pair rules:

- **`lbClass`** — a pragmatic subset of the UAX #14 classes over range
  tables: `BK` (mandatory), `SP` (space/tab fold), `ZW` (U+200B invisible
  break), `WJ` (U+2060/U+FEFF word joiners), `GL` (NBSP family), `SHY`
  (U+00AD), `BA`/`HY` (break-after dashes / hyphen-minus), `CL`/`OP`
  (closing/opening punctuation incl. CJK `、。》` and ASCII `)]}`/`([{`),
  `EX`, `IS`, `QU`, `NU`, `PR`/`PO` (currency prefix/postfix), `ID`
  (ideographic + Hangul + kana + fullwidth + emoji), `CJ` (conditional
  Japanese starters — small kana, iteration marks), `RI` (flags), `AL`
  fallback. Combining marks fold into `AL` (LB9 spirit).
- **`pairBreak(a, b, opts)`** — the pair rules: `BK` forces a break after;
  spaces are consumed by the fold; `WJ`/`GL` never separate; no break before
  `CL`/`EX` or after `OP`; `HY`/`BA` break after except `HY`×`NU` (LB22);
  number groups `NU`×`NU`/`NU`×`IS`/`IS`×`NU`/`NU`×`PO`/`PR`×`NU` stay glued;
  `ID` breaks freely either side; `CJ` never starts a line unless
  `line-break: loose`; `RI` stays paired; `AL`/`NU`/`QU` clusters are intact
  unless `break-all`; `anywhere` overrides everything.
- **`breakUnits(text, opts)`** emits ordered `BreakUnit`s
  (`text`/`spaceBefore`/`hardBreaksBefore`/`shyAfter`): whitespace runs fold
  into `spaceBefore` flags, `BK` into `hardBreaksBefore`, `ZW`/`SHY` emit
  boundaries without shaping text, and `WJ`/`SHY` chars are stripped from
  unit text (WJ glues; SHY only materializes as an emitted `-` glyph when a
  break is actually taken at it).

## CSS keyword plumbing

`breakOptionsOf(style)` maps the already-inherited computed values into
`BreakOptions`: `word-break: break-all`/`keep-all`, `line-break:
loose`/`normal`/`strict`/`anywhere`, `overflow-wrap: anywhere` (mapped onto
the any-boundary path; `break-word` stays an overflow-only mid-word split in
the packer), `hyphens: none`/`manual`/`auto`.

Both inline paths consume units: `layoutInline` (single text node) via
`visualTokens` (bidi → per-part `breakUnits` → odd-level unit reversal via
`reverseUnits`, which migrates `spaceBefore` so a space stays between the
same two units), and `layoutInlineRun` (multi-member paragraph) via
`emitTextChunk`. A part boundary carries the union of both sides' whitespace
(`prevPartEndsWs || startsWs(part)`) — the boundary space belongs to neither
part's own stream.

## Pipeline note — why BN no longer removes U+200B/U+00AD/U+2060/U+FEFF

UAX #9 classifies all four as `BN` (X9-removable), but removing them at bidi
time would destroy the very characters the line breaker needs: ZWSP is a
zero-width break opportunity, SHY a conditional one, WJ a break suppressor.
They now flow through bidi as `ON` neutrals and are consumed into unit
boundaries (or stripped from unit text) by `breakUnits` — still never
reaching the shaper.

## Evidence

- `linebreak.test.ts` — **22/22**: class coverage; pair rules
  (ID×ID/keep-all, CL/OP protection, number groups, break-all, GL/WJ, CJ +
  loose/strict, RI, anywhere); `breakUnits` whitespace fold, ZW/SHY/WJ
  handling, `hardBreaksBefore`; and layout-level CJK wrapping, closing-punct
  line-head protection, keep-all, break-all, ZWSP, shy `-` emission +
  `hyphens:none`, `line-break:loose` small-kana split, adjacent-node space
  absence, real space gaps, `break-word` overflow split.
- Existing suites unchanged: `bidi.test.ts` (15 + 23), full `npm test`
  **1532/1532**, `npm run ci` all gates green, WPT subsets **462/462**.

## Honest bounds

1. The class table is a hand-audited range set, not the generated UCD —
   esoteric assignments (e.g. `CM` classes beyond the combining ranges) fold
   to `AL`.
2. **Thai/Lao/Khmer/Myanmar have no dictionary iterator** — `SA` text keeps
   word-level breaking (the honest fallback; ICU/dictionary data is a
   follow-up, not a stub).
3. `line-break: strict` resolves to the `normal` ruleset — our subset has no
   looser rules to tighten (strict additionally forbids breaks before small
   kana, which `normal` already does here).
4. `RI` stays unconditionally paired — the real rule alternates per RI
   count; emoji-ZWJ sequences are not modeled (ZWJ is stripped as `BN`).
5. `hyphens: auto` ≡ `manual` — no language dictionaries yet; `none`
   suppresses the break and the char (per spec it's invisible either way).
6. A soft-hyphen break between two *different* text members drops the hyphen
   glyph (the `shyAfter` flag lives on the owning member's last unit).
7. The mid-word `break-word` path does not emit the shy marker (overflow
   splitting is a different mechanism).
8. Break positions are greedy-maximal: no stretch/shrink scoring, no
   `text-wrap: pretty/balance`.
