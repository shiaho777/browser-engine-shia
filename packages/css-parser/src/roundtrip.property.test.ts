/**
 * CSS round-trip property test (task 5.6) — the parse → print → parse fixed
 * point, asserted with fast-check over generated CSS.
 *
 * **Validates: Requirements 18.5**
 *
 * Requirement 18.5 (design.md §4.1/§6, requirements.md §18): "FOR ALL valid
 * Stylesheet IR values, parsing then printing then parsing SHALL produce an
 * equivalent Stylesheet." Phrased as the fixed point this package guarantees
 * (see the `index.ts` module header, "Round-trip equivalence"):
 *
 *     parse(print(parse(css)))  ≡  parse(css)
 *
 * where `print` is {@link serializeStylesheet}, `parse` is {@link parseCss},
 * and `≡` is the package's shared structural-equality oracle
 * {@link stylesheetsEquivalent}. We assert the *fixed point* rather than raw
 * text identity because {@link parseCss} canonicalises as it parses: it
 * lowercases property names, collapses selector whitespace to single spaces,
 * trims declaration values, expands a comma selector list into one rule per
 * selector, and strips a trailing `!important` into the boolean
 * {@link Declaration.important} flag. So the *first* `parse(css)` may differ
 * textually from `print(parse(css))`, but re-parsing that printed text lands
 * back on the identical IR — which is exactly what 18.5 asks for.
 *
 * ## Equivalence definition (reused, not redefined)
 *
 * This test deliberately reuses the SAME oracle the parser/serializer module
 * exports — {@link stylesheetsEquivalent} — so the property and the production
 * code agree on one definition of "equivalent Stylesheet". Two stylesheets are
 * equivalent iff they have the same `rules`, pairwise in source order, where
 * two rules are equal iff their selector text list, specificity `[a, b, c]`
 * triple, source `order`, and declaration list (`property` / `value` /
 * `important`, in order) are all equal.
 *
 * ## Generators
 *
 * The arbitraries below emit *well-formed CSS strings* drawn from the supported
 * A-tier subset: selectors built from type / class / id / attribute / pseudo
 * tokens joined by descendant / child / sibling combinators, gathered into
 * comma selector lists, with declaration blocks of the known Phase 1 properties
 * (`color`, `background-color`, `display`, `width`, `height`, `margin`,
 * `font-size`) carrying values the GENERATED per-property parsers accept (so
 * the declarations survive parsing instead of being dropped as malformed),
 * plus an optional `!important`. Generating values from the accepted input
 * space is what makes each case exercise real declarations rather than the
 * empty-rule degenerate path.
 *
 * Built by `tsc` then run with: `node --test packages/css-parser/dist/*.test.js`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { parseCss, serializeStylesheet, stylesheetsEquivalent } from "./index.js";

/** A generous case count for the round-trip fixed point (§9.2 property style). */
const NUM_RUNS = 300;

const parse = (css: string): ReturnType<typeof parseCss> =>
  parseCss(new TextEncoder().encode(css));

// ---------------------------------------------------------------------------
// Value generators — every emitted value is one the GENERATED Phase 1 parser
// accepts, so the declaration is kept (not dropped) by `parseCss`. Values are
// stored verbatim (trimmed) in the IR, so they re-serialize and re-parse
// unchanged.
// ---------------------------------------------------------------------------

/** A `<color>`: named, #hex (3/4/6/8 digit), or rgb()/rgba(). */
const colorValueArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom("red", "green", "blue", "black", "white", "transparent"),
  fc.constantFrom("#fff", "#abc", "#abcd", "#aabbcc", "#11223344"),
  fc
    .tuple(fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }))
    .map(([r, g, b]) => `rgb(${r}, ${g}, ${b})`),
  fc
    .tuple(
      fc.integer({ min: 0, max: 255 }),
      fc.integer({ min: 0, max: 255 }),
      fc.integer({ min: 0, max: 255 }),
      fc.constantFrom("0", "0.25", "0.5", "1"),
    )
    .map(([r, g, b, a]) => `rgba(${r}, ${g}, ${b}, ${a})`),
);

/** A `<length>`: a bare `0` or a `<number>px`. */
const lengthValueArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant("0"),
  fc.integer({ min: 0, max: 999 }).map((n) => `${n}px`),
  fc
    .tuple(fc.integer({ min: 0, max: 200 }), fc.integer({ min: 1, max: 99 }))
    .map(([whole, frac]) => `${whole}.${frac}px`),
);

/** A `<length>` or `auto` (for `width` / `height`). */
const lengthOrAutoValueArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant("auto"),
  lengthValueArb,
);

/** A `display` keyword. */
const displayValueArb: fc.Arbitrary<string> = fc.constantFrom(
  "block",
  "inline",
  "inline-block",
  "flex",
  "grid",
  "none",
);

/** A 1-to-4 `<length>` quad for the `margin` shorthand. */
const marginValueArb: fc.Arbitrary<string> = fc
  .array(lengthValueArb, { minLength: 1, maxLength: 4 })
  .map((parts) => parts.join(" "));

/** One declaration's CSS text, e.g. `color: red !important`. */
const declarationTextArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.oneof(
      fc.record({ property: fc.constant("color"), value: colorValueArb }),
      fc.record({ property: fc.constant("background-color"), value: colorValueArb }),
      fc.record({ property: fc.constant("display"), value: displayValueArb }),
      fc.record({ property: fc.constant("width"), value: lengthOrAutoValueArb }),
      fc.record({ property: fc.constant("height"), value: lengthOrAutoValueArb }),
      fc.record({ property: fc.constant("margin"), value: marginValueArb }),
      fc.record({ property: fc.constant("font-size"), value: lengthValueArb }),
    ),
    fc.boolean(),
  )
  .map(([{ property, value }, important]) =>
    important ? `${property}: ${value} !important` : `${property}: ${value}`,
  );

// ---------------------------------------------------------------------------
// Selector generators — the supported subset: type / class / id / attribute /
// pseudo, joined by combinators, gathered into comma selector lists.
// ---------------------------------------------------------------------------

const TYPE_NAMES = ["div", "span", "p", "a", "h1", "section", "ul", "li"] as const;
const IDS = ["main", "root", "header", "content"] as const;
const CLASSES = ["box", "lead", "row", "col", "active"] as const;
const ATTRS = ["[href]", "[type]", '[type="text"]', "[data-x]"] as const;
const PSEUDO_CLASSES = [":hover", ":focus", ":first-child", ":last-child"] as const;
const PSEUDO_ELEMENTS = ["::before", "::after"] as const;

/** A compound selector (no combinator): a run of simple-selector tokens. */
const compoundArb: fc.Arbitrary<string> = fc
  .record({
    type: fc.option(fc.constantFrom(...TYPE_NAMES), { nil: null }),
    id: fc.option(fc.constantFrom(...IDS), { nil: null }),
    classes: fc.array(fc.constantFrom(...CLASSES), { maxLength: 2 }),
    attr: fc.option(fc.constantFrom(...ATTRS), { nil: null }),
    pseudoClass: fc.option(fc.constantFrom(...PSEUDO_CLASSES), { nil: null }),
    pseudoElement: fc.option(fc.constantFrom(...PSEUDO_ELEMENTS), { nil: null }),
  })
  .map(({ type, id, classes, attr, pseudoClass, pseudoElement }) => {
    let text = type ?? "";
    if (id !== null) text += `#${id}`;
    for (const cls of classes) text += `.${cls}`;
    if (attr !== null) text += attr;
    if (pseudoClass !== null) text += pseudoClass;
    if (pseudoElement !== null) text += pseudoElement;
    // Never emit the empty compound: fall back to the universal selector.
    return text.length === 0 ? "*" : text;
  });

const COMBINATORS = [" ", " > ", " + ", " ~ "] as const;

/** A complex selector: 1-3 compounds joined by combinators. */
const complexSelectorArb: fc.Arbitrary<string> = fc
  .array(compoundArb, { minLength: 1, maxLength: 3 })
  .chain((compounds) =>
    fc
      .array(fc.constantFrom(...COMBINATORS), {
        minLength: compounds.length - 1,
        maxLength: compounds.length - 1,
      })
      .map((combinators) =>
        compounds.reduce(
          (acc, compound, i) => (i === 0 ? compound : `${acc}${combinators[i - 1] ?? " "}${compound}`),
          "",
        ),
      ),
  );

/** A selector list: 1-3 complex selectors joined by `, `. */
const selectorListArb: fc.Arbitrary<string> = fc
  .array(complexSelectorArb, { minLength: 1, maxLength: 3 })
  .map((selectors) => selectors.join(", "));

// ---------------------------------------------------------------------------
// Rule + stylesheet generators.
// ---------------------------------------------------------------------------

/** A full qualified rule: `<selector list> { <declarations> }`. */
const ruleTextArb: fc.Arbitrary<string> = fc
  .tuple(selectorListArb, fc.array(declarationTextArb, { minLength: 0, maxLength: 4 }))
  .map(([selectors, decls]) =>
    decls.length === 0
      ? `${selectors} {}`
      : `${selectors} { ${decls.join("; ")} }`,
  );

/** A whole stylesheet: 0-5 rules. Joins with a newline (matches CSS layout). */
const stylesheetTextArb: fc.Arbitrary<string> = fc
  .array(ruleTextArb, { minLength: 0, maxLength: 5 })
  .map((rules) => rules.join("\n\n"));

// ---------------------------------------------------------------------------
// Requirement 18.5 — the parse → print → parse fixed point.
// ---------------------------------------------------------------------------

void test("Req 18.5: parse → print → parse is a fixed point for all generated CSS", () => {
  fc.assert(
    fc.property(stylesheetTextArb, (css) => {
      const once = parse(css);
      const twice = parse(serializeStylesheet(once));
      // parse(print(parse(css))) ≡ parse(css), using the shared oracle.
      assert.ok(
        stylesheetsEquivalent(once, twice),
        `round-trip equivalence failed for CSS:\n${css}`,
      );
    }),
    { numRuns: NUM_RUNS },
  );
});

/**
 * The serializer's *text* output is itself a fixed point once the input has
 * been canonicalised by one parse: printing the re-parsed stylesheet yields
 * byte-identical CSS. This is a stronger, text-level corroboration of the same
 * 18.5 contract — if the printed form re-parsed to a different IR, this would
 * also fail.
 */
void test("Req 18.5: serialize(parse(·)) text is stable under another round trip", () => {
  fc.assert(
    fc.property(stylesheetTextArb, (css) => {
      const printedOnce = serializeStylesheet(parse(css));
      const printedTwice = serializeStylesheet(parse(printedOnce));
      assert.equal(printedTwice, printedOnce, `serialize text drifted for CSS:\n${css}`);
    }),
    { numRuns: NUM_RUNS },
  );
});
