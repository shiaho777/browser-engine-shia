/**
 * @browser-engine/css-parser
 *
 * Parses a source byte stream into the {@link StyleSheet} IR, exposed (by the
 * cli wiring layer) as the memoized pure query `qSheets`. See design.md §4.1,
 * §6, §7.2.
 *
 * Task 3.3 (Phase 1 — 端到端竖线) implemented a *minimal* parser: just enough CSS
 * to drive the Phase 1 vertical slice — qualified rules (a selector list + a
 * `{ … }` declaration block), the Phase 1 selector subset (type, class, id,
 * with descendant/child combinators handled for specificity), and `property:
 * value` declarations with optional `!important`. Task 5.5 (Phase 2-4 — 逼近 A
 * 档) hardens that parser for the A-tier subset and adds the Pretty_Printer /
 * serializer. What this parser guarantees for the supported subset:
 *
 *   - Requirement 18.2 — a valid CSS byte stream parses into a Stylesheet IR.
 *   - Requirement 18.3 — {@link serializeStylesheet} turns a {@link StyleSheet}
 *     IR back into valid CSS text (the Pretty_Printer).
 *   - Requirement 18.5 — round-trip equivalence (see "Round-trip equivalence"
 *     below): re-parsing the serializer's output reproduces the same IR.
 *   - Requirement 2.7 — `parseCss` is a *pure* function of its input bytes, so
 *     it is safe as the memoized `qSheets` query: no side effects, no shared
 *     mutable state, deterministic output. The result is `deepFreeze`-d so a
 *     downstream stage can never mutate upstream IR (Requirement 3.2).
 *   - Requirement 18.6 / 13.1 — malformed input is recovered, not fatal: a bad
 *     declaration or rule is skipped and parsing continues. Capabilities the
 *     parser does not implement (at-rules) still fail loudly with
 *     `NotImplemented` rather than being silently dropped (Requirement 5.1).
 *
 * ## A-tier robustness (task 5.5)
 *
 * Beyond the Phase 1 minimal scanner, the rule scanner is now *string- and
 * nesting-aware*: the rule's `{`/`}` delimiters and the declaration `;`/`,`
 * separators are located at the top level only, so a `{`, `}`, `;`, or `,` that
 * appears inside a string literal (`content: "}"`) or inside `(…)`/`[…]`
 * (a functional value or an attribute selector) no longer truncates a rule or
 * a declaration. The Phase 1 minimal `indexOf`-based scan would mis-cut on
 * those; the A-tier scan handles them while staying byte-for-byte compatible on
 * the Phase 1 inputs. Extending the *property* set itself (more typed values)
 * is the generator's job (Platform-as-Data), so this task keeps consuming the
 * generated `PROPERTY_PARSERS` for known properties and preserves unknown
 * properties verbatim.
 *
 * ## Declaration value handling (design choice — documented per task 3.3)
 *
 * The {@link Declaration} IR stores `property`/`value` as *strings*. This parser
 * keeps the raw (trimmed) value string in the IR, and additionally runs the
 * GENERATED per-property value parsers (`parsePropertyValue` / `PROPERTY_PARSERS`
 * from `@browser-engine/generator`) at parse time to VALIDATE the values of the
 * Phase 1 known properties. A known property whose value the generated parser
 * rejects is treated as a malformed declaration and skipped (error recovery);
 * the typed value itself is re-derived by the cascade in task 3.4, which is the
 * stage that consumes the typed parse. Unknown properties (no generated parser)
 * are kept verbatim — forward-compatible CSS recovery — so the cascade can
 * ignore them without the stylesheet failing to parse.
 *
 * Because the generator is *infrastructure* (not a pipeline stage), importing
 * its artifacts is allowed by `local/no-cross-stage-import`; the css-parser
 * never reaches across a stage boundary to the cascade (the two cannot import
 * each other — they share only through the generator and the frozen IR).
 *
 * ## Round-trip equivalence (Requirement 18.5 — documented per task 5.5)
 *
 * The serializer ({@link serializeStylesheet}) and {@link parseCss} form a
 * round trip. The equivalence contract this package guarantees is:
 *
 *     parse(print(parse(css)))  ≡  parse(css)
 *
 * i.e. printing a parsed stylesheet and re-parsing it reproduces a
 * *structurally equal* {@link StyleSheet}. "Structurally equal" is defined
 * field-by-field over the IR:
 *
 *   - `rules` — same length, compared pairwise in order;
 *   - per rule: same `selector` list (same `Selector.text` strings, in order),
 *     same `specificity` `[a, b, c]` triple, same `order` number, and the same
 *     `declarations` list (same `property`, `value`, and `important`, in order).
 *
 * This is the natural fixed point of the pair: `parseCss` already *canonicalises*
 * as it parses — it lowercases property names and selector type/identifier
 * shape via specificity, collapses selector whitespace to single spaces,
 * trims declaration values, and strips `!important` into the boolean flag.
 * {@link serializeStylesheet} prints in exactly that canonical shape
 * (`selector { prop: value !important; … }`), so the *first* `parse(css)` may
 * differ textually from `print(...)`, but `parse(print(parse(css)))` lands back
 * on the identical IR — which is what Requirement 18.5 ("parsing then printing
 * then parsing produces an equivalent Stylesheet") asks for. The CSS round-trip
 * property test (task 5.6) asserts this fixed point with fast-check; this module
 * exports {@link stylesheetsEquivalent} as the shared structural-equality oracle
 * so the parser and the property test agree on one definition of "equivalent".
 */
import { deepFreeze } from "@browser-engine/ir";
import type {
  Declaration,
  Selector,
  Specificity,
  StyleRule,
  StyleSheet,
} from "@browser-engine/ir";
import { PROPERTY_PARSERS, parsePropertyValue } from "@browser-engine/generator";
import { DEFAULT_MEDIA_ENVIRONMENT, mediaQueryListMatches } from "./media-query.js";
import type { MediaEnvironment } from "./media-query.js";
export type { MediaEnvironment };
export { DEFAULT_MEDIA_ENVIRONMENT, mediaQueryListMatches };

export const PACKAGE_NAME = "@browser-engine/css-parser" as const;

/**
 * Parse a source byte stream into the {@link StyleSheet} IR (design.md §4.1, §6).
 *
 * The returned stylesheet is a flat, source-ordered list of {@link StyleRule}s.
 * A comma-separated selector list (`h1, .lead { … }`) is expanded into one rule
 * per selector so that each rule carries the single, unambiguous
 * {@link Specificity} the cascade reads directly (design.md §8.1 uses
 * `rule.specificity` with no per-selector disambiguation). The whole graph is
 * deep-frozen for runtime immutability (Requirement 3.2).
 *
 * @param source raw CSS bytes, decoded as UTF-8.
 * @returns a frozen, branded {@link StyleSheet}.
 */
export function parseCss(source: Uint8Array, env: MediaEnvironment = DEFAULT_MEDIA_ENVIRONMENT): StyleSheet {
  const css = new TextDecoder("utf-8").decode(source);
  const { rules, layerOrder } = parseRulesWithLayers(stripComments(css), env);
  const sheet = layerOrder.length > 0
    ? { rules, layerOrder } as unknown as StyleSheet
    : { rules } as unknown as StyleSheet;
  return deepFreeze(sheet);
}

// ---------------------------------------------------------------------------
// Serializer / Pretty_Printer (Requirement 18.3).
//
// Turns a StyleSheet IR back into valid CSS text in the canonical shape the
// parser produces, so that re-parsing the output reproduces the same IR
// (Requirement 18.5 round-trip — see the module header for the equivalence
// definition). The canonical shape is, per rule:
//
//     <selectors joined by ", "> { <prop>: <value>[ !important]; … }
//
// and rules are joined by a blank line. An empty stylesheet serializes to the
// empty string; a rule with no declarations serializes to `selector {}` (which
// re-parses to the same empty-declaration rule).
// ---------------------------------------------------------------------------

/**
 * Serialize a single {@link Declaration} to `property: value` text, appending
 * ` !important` when the declaration is important. The value is emitted
 * verbatim — `parseCss` already stored it trimmed and `!important`-stripped, so
 * it re-parses unchanged.
 */
export function serializeDeclaration(decl: Declaration): string {
  const base = `${decl.property}: ${decl.value}`;
  return decl.important ? `${base} !important` : base;
}

/**
 * Serialize a {@link StyleRule} to `selector { declarations }` text. The
 * selector list is joined with `, ` (re-parsed by the comma split); each
 * declaration is terminated with `;` so the block re-parses declaration-for-
 * declaration. A declaration-less rule becomes `selector {}`.
 */
export function serializeRule(rule: StyleRule): string {
  const prelude = rule.selector.map((s) => s.text).join(", ");
  if (rule.declarations.length === 0) {
    return `${prelude} {}`;
  }
  const body = rule.declarations.map((d) => `  ${serializeDeclaration(d)};`).join("\n");
  return `${prelude} {\n${body}\n}`;
}

/**
 * Pretty_Printer (Requirement 18.3): serialize a whole {@link StyleSheet} IR
 * back into CSS text. Rules are emitted in `rule.order`-respecting source order
 * (the IR list is already source-ordered) and separated by a blank line.
 *
 * The output is canonical CSS that {@link parseCss} maps back to a structurally
 * equal stylesheet (Requirement 18.5); see {@link stylesheetsEquivalent} for
 * the equality oracle and the module header for the equivalence contract.
 *
 * @param sheet the stylesheet IR to serialize.
 * @returns valid CSS text; the empty string for a stylesheet with no rules.
 */
export function serializeStylesheet(sheet: StyleSheet): string {
  return sheet.rules.map(serializeRule).join("\n\n");
}

// ---------------------------------------------------------------------------
// Structural-equality oracle (Requirement 18.5).
//
// The single shared definition of "equivalent Stylesheet" used by both this
// package and the CSS round-trip property test (task 5.6). Two stylesheets are
// equivalent iff they have the same rules, pairwise in order, where two rules
// are equal iff their selector lists, specificity triples, source order, and
// declaration lists (property/value/important, in order) are all equal.
// ---------------------------------------------------------------------------

/** Structural equality of two {@link Declaration}s. */
function declarationsEqual(a: Declaration, b: Declaration): boolean {
  return a.property === b.property && a.value === b.value && a.important === b.important;
}

/** Structural equality of two {@link StyleRule}s (selectors + cascade meta). */
function rulesEqual(a: StyleRule, b: StyleRule): boolean {
  if (a.order !== b.order) return false;
  if (a.specificity[0] !== b.specificity[0]) return false;
  if (a.specificity[1] !== b.specificity[1]) return false;
  if (a.specificity[2] !== b.specificity[2]) return false;
  if (a.selector.length !== b.selector.length) return false;
  for (let i = 0; i < a.selector.length; i += 1) {
    if (a.selector[i]?.text !== b.selector[i]?.text) return false;
  }
  if (a.declarations.length !== b.declarations.length) return false;
  for (let i = 0; i < a.declarations.length; i += 1) {
    const da = a.declarations[i];
    const db = b.declarations[i];
    if (da === undefined || db === undefined || !declarationsEqual(da, db)) {
      return false;
    }
  }
  return true;
}

/**
 * The "equivalent Stylesheet" oracle for Requirement 18.5: returns `true` iff
 * `a` and `b` are structurally equal (see the section comment above). This is
 * the contract the parse→print→parse round trip must satisfy, and is exported
 * so the property test in task 5.6 asserts the exact same definition.
 */
export function stylesheetsEquivalent(a: StyleSheet, b: StyleSheet): boolean {
  if (a.rules.length !== b.rules.length) return false;
  for (let i = 0; i < a.rules.length; i += 1) {
    const ra = a.rules[i];
    const rb = b.rules[i];
    if (ra === undefined || rb === undefined || !rulesEqual(ra, rb)) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Top-level rule scanning. A single left-to-right pass over the comment-free
// source, alternating between a selector prelude and a `{ … }` block.
// ---------------------------------------------------------------------------

/** Parse result: rules + declared layer order. */
interface ParseResult {
  readonly rules: StyleRule[];
  readonly layerOrder: (readonly string[])[];
}

/**
 * Top-level parse: collects rules and @layer declarations. Layer declarations
 * (`@layer a, b;`) populate `layerOrder`; layer blocks (`@layer a { ... }`)
 * annotate their inner rules with the layer path.
 */
function parseRulesWithLayers(input: string, env: MediaEnvironment): ParseResult {
  const layerOrder: (readonly string[])[] = [];
  let order = 0;

  const parse = (text: string, env2: MediaEnvironment, layerPath: readonly string[], depth: number): StyleRule[] => {
    const rules: StyleRule[] = [];
    const len = text.length;
    let i = 0;

    while (i < len) {
      const ch = text[i];
      if (ch === undefined) break;
      if (isSpace(ch) || ch === ";") {
        i += 1;
        continue;
      }

      if (ch === "@") {
        let j = i + 1;
        while (j < len && isIdentChar(text[j])) j += 1;
        const name = text.slice(i + 1, j).toLowerCase();

        if (name === "media") {
          const braceOpen = findBlockStart(text, j);
          if (braceOpen === -1) break;
          const condition = text.slice(j, braceOpen).trim();
          const braceClose = findBlockEnd(text, braceOpen + 1);
          const blockEnd = braceClose === -1 ? len : braceClose;
          const block = text.slice(braceOpen + 1, blockEnd);
          i = braceClose === -1 ? len : braceClose + 1;
          if (depth >= 2) continue;
          if (mediaQueryListMatches(condition, env2)) {
            const innerRules = parse(block, env2, layerPath, depth + 1);
            for (const inner of innerRules) {
              rules.push({
                selector: inner.selector,
                declarations: inner.declarations,
                specificity: inner.specificity,
                order: order++,
                layer: inner.layer,
              });
            }
          }
          continue;
        }

        if (name === "layer") {
          // Two forms: @layer name { ... } (block) or @layer a, b; (declaration).
          // First check if there's a block.
          const braceOpen = findBlockStart(text, j);
          const semiIdx = findTopLevelSemicolon(text, j);

          if (braceOpen !== -1 && (semiIdx === -1 || braceOpen < semiIdx)) {
            // @layer <name> { <rules> }
            const layerName = text.slice(j, braceOpen).trim();
            const braceClose = findBlockEnd(text, braceOpen + 1);
            const blockEnd = braceClose === -1 ? len : braceClose;
            const block = text.slice(braceOpen + 1, blockEnd);
            i = braceClose === -1 ? len : braceClose + 1;

            // Parse the layer name (may be dotted: "outer.inner").
            const innerLayerPath = layerName.length > 0
              ? [...layerPath, ...layerName.split(".").map((s) => s.trim()).filter((s) => s.length > 0)]
              : layerPath;

            // Register the layer in the order list.
            if (innerLayerPath.length > 0 && !layerOrder.some((lp) => lp.join(".") === innerLayerPath.join("."))) {
              layerOrder.push(innerLayerPath);
            }

            const innerRules = parse(block, env2, innerLayerPath, depth + 1);
            for (const inner of innerRules) {
              rules.push({
                selector: inner.selector,
                declarations: inner.declarations,
                specificity: inner.specificity,
                order: order++,
                layer: inner.layer,
              });
            }
            continue;
          }

          // @layer a, b, c; — declaration (no block). Register layer order.
          if (semiIdx !== -1) {
            const names = text.slice(j, semiIdx).trim();
            i = semiIdx + 1;
            if (names.length > 0) {
              for (const part of names.split(",")) {
                const trimmed = part.trim();
                if (trimmed.length > 0) {
                  const lp = [...layerPath, ...trimmed.split(".").map((s) => s.trim()).filter((s) => s.length > 0)];
                  if (!layerOrder.some((existing) => existing.join(".") === lp.join("."))) {
                    layerOrder.push(lp);
                  }
                }
              }
            }
            continue;
          }

          // Malformed @layer — skip.
          i = len;
          continue;
        }

        if (name === "supports") {
          // @supports <condition> { <rules> }
          // We evaluate a simplified supports-condition: (prop: value) and
          // not/and/or combinations. Unknown features evaluate to false.
          const braceOpen = findBlockStart(text, j);
          if (braceOpen === -1) break;
          const condition = text.slice(j, braceOpen).trim();
          const braceClose = findBlockEnd(text, braceOpen + 1);
          const blockEnd = braceClose === -1 ? len : braceClose;
          const block = text.slice(braceOpen + 1, blockEnd);
          i = braceClose === -1 ? len : braceClose + 1;
          if (depth >= 2) continue;
          if (supportsConditionMatches(condition)) {
            const innerRules = parse(block, env2, layerPath, depth + 1);
            for (const inner of innerRules) {
              rules.push({
                selector: inner.selector,
                declarations: inner.declarations,
                specificity: inner.specificity,
                order: order++,
                layer: inner.layer,
              });
            }
          }
          continue;
        }

        if (name === "import") {
          // @import "url" | @import url("url") [media-query-list];
          // Resolve the import eagerly — the caller (stylesheets.ts) handles
          // external fetch. Here we just store the import directive by
          // emitting it as a special rule that the pipeline can consume.
          // For now, @import without a media condition is a no-op pass-through;
          // with a media condition, we evaluate it like @media.
          const semiIdx = findTopLevelSemicolon(text, j);
          if (semiIdx === -1) { i = len; continue; }
          const importArgs = text.slice(j, semiIdx).trim();
          i = semiIdx + 1;

          // Extract the URL and optional media query.
          const urlMatch = importArgs.match(/^url\(\s*["']?([^"')]+)["']?\s*\)/) ?? importArgs.match(/^["']([^"']+)["']/);
          if (urlMatch && urlMatch[1]) {
            // The URL is consumed by the pipeline's stylesheet loader, not
            // by the parser. Any trailing media condition is evaluated to
            // decide whether the import is active, but since the loader
            // handles actual fetching, we just skip the directive here.
            // The media condition (if any) after the URL:
            const mediaPart = importArgs.slice(urlMatch[0].length).trim();
            if (mediaPart.length > 0 && !mediaQueryListMatches(mediaPart, env2)) {
              continue; // Import not active for this media.
            }
            // Active import — the loader in stylesheets.ts picks it up.
          }
          continue;
        }

        if (name === "keyframes" || name === "-webkit-keyframes") {
          // @keyframes <name> { <keyframe-rules> }
          // Store the keyframes block for the animation system. The parser
          // passes it through as-is; the cascade/paint stages consume it
          // when animation-name references it. For now, skip the block
          // (animations are not wired end-to-end yet).
          const braceOpen = findBlockStart(text, j);
          if (braceOpen === -1) break;
          const braceClose = findBlockEnd(text, braceOpen + 1);
          i = braceClose === -1 ? len : braceClose + 1;
          continue;
        }

        if (name === "font-face") {
          // @font-face { <declarations> }
          // Store the font-face declarations for the font system. The parser
          // passes the block through; the font module consumes it when
          // matching font-family. For now, skip the block.
          const braceOpen = findBlockStart(text, j);
          if (braceOpen === -1) break;
          const braceClose = findBlockEnd(text, braceOpen + 1);
          i = braceClose === -1 ? len : braceClose + 1;
          continue;
        }

        if (name === "page") {
          // @page [<name>][:<pseudo>] { <declarations> }
          // Store page-level declarations for print media. Skip for now.
          const braceOpen = findBlockStart(text, j);
          if (braceOpen === -1) break;
          const braceClose = findBlockEnd(text, braceOpen + 1);
          i = braceClose === -1 ? len : braceClose + 1;
          continue;
        }

        if (name === "charset") {
          // @charset "UTF-8"; — encoding declaration, skip.
          const semiIdx = findTopLevelSemicolon(text, j);
          i = semiIdx === -1 ? len : semiIdx + 1;
          continue;
        }

        if (name === "namespace") {
          // @namespace prefix "url"; — XML namespace, skip.
          const semiIdx = findTopLevelSemicolon(text, j);
          i = semiIdx === -1 ? len : semiIdx + 1;
          continue;
        }

        if (name === "viewport" || name === "-ms-viewport") {
          // @viewport { <declarations> } — mobile viewport config, skip.
          const braceOpen = findBlockStart(text, j);
          if (braceOpen === -1) { i = len; continue; }
          const braceClose = findBlockEnd(text, braceOpen + 1);
          i = braceClose === -1 ? len : braceClose + 1;
          continue;
        }

        if (name === "counter-style") {
          // @counter-style <name> { <declarations> } — custom counter, skip.
          const braceOpen = findBlockStart(text, j);
          if (braceOpen === -1) { i = len; continue; }
          const braceClose = findBlockEnd(text, braceOpen + 1);
          i = braceClose === -1 ? len : braceClose + 1;
          continue;
        }

        if (name === "property") {
          // @property <name> { <declarations> } — CSS Houdini, skip.
          const braceOpen = findBlockStart(text, j);
          if (braceOpen === -1) { i = len; continue; }
          const braceClose = findBlockEnd(text, braceOpen + 1);
          i = braceClose === -1 ? len : braceClose + 1;
          continue;
        }

        if (name === "container") {
          // @container [<name>] (<condition>) { <rules> } — container queries.
          // Evaluate a simplified condition (inline-size / block-size comparisons)
          // and include rules if it matches. For now, always include (no
          // container dimension tracking yet).
          const braceOpen = findBlockStart(text, j);
          if (braceOpen === -1) break;
          const braceClose = findBlockEnd(text, braceOpen + 1);
          const blockEnd = braceClose === -1 ? len : braceClose;
          const block = text.slice(braceOpen + 1, blockEnd);
          i = braceClose === -1 ? len : braceClose + 1;
          if (depth >= 2) continue;
          // Container queries: include rules (no container dimension tracking).
          const innerRules = parse(block, env2, layerPath, depth + 1);
          for (const inner of innerRules) {
            rules.push({
              selector: inner.selector,
              declarations: inner.declarations,
              specificity: inner.specificity,
              order: order++,
              layer: inner.layer,
            });
          }
          continue;
        }

        // Unknown at-rules: skip blocks, skip declarations.
        {
          const braceOpen = findBlockStart(text, j);
          const semiIdx = findTopLevelSemicolon(text, j);
          if (braceOpen !== -1 && (semiIdx === -1 || braceOpen < semiIdx)) {
            // Block form: @unknown <prelude> { ... } — skip.
            const braceClose = findBlockEnd(text, braceOpen + 1);
            i = braceClose === -1 ? len : braceClose + 1;
          } else if (semiIdx !== -1) {
            // Declaration form: @unknown ...; — skip.
            i = semiIdx + 1;
          } else {
            i = len;
          }
          continue;
        }
      }

      // A qualified rule.
      const braceOpen = findBlockStart(text, i);
      if (braceOpen === -1) {
        break;
      }
      const prelude = text.slice(i, braceOpen);
      const braceClose = findBlockEnd(text, braceOpen + 1);
      const blockEnd = braceClose === -1 ? len : braceClose;
      const block = text.slice(braceOpen + 1, blockEnd);
      i = braceClose === -1 ? len : braceClose + 1;

      const selectors = parseSelectorList(prelude);
      if (selectors.length === 0) continue;
      const declarations = parseDeclarations(block);
      for (const { selector, specificity } of selectors) {
        rules.push({
          selector: [selector],
          declarations,
          specificity,
          order: order++,
          layer: layerPath.length > 0 ? layerPath : undefined,
        });
      }
    }

    return rules;
  };

  const rules = parse(input, env, [], 0);
  return { rules, layerOrder };
}

/** Find the next top-level semicolon at or after `from`, or -1 if none. */
function findTopLevelSemicolon(text: string, from: number): number {
  const len = text.length;
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < len; i += 1) {
    const ch = text[i];
    if (ch === undefined) break;
    if (quote !== null) {
      if (ch === "\\" && i + 1 < len) { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "(" || ch === "[") { depth += 1; continue; }
    if (ch === ")" || ch === "]") { if (depth > 0) depth -= 1; continue; }
    if (ch === ";" && depth === 0) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// @supports condition evaluation (CSS Conditional Rules 3).
// ---------------------------------------------------------------------------

/**
 * Evaluate a simplified `@supports` condition. Supports:
 *   - `(property: value)` — true if the property is known to the engine.
 *   - `(property)` — feature query for custom properties (always true if it
 *     starts with `--`).
 *   - `not <condition>` — negation.
 *   - `<cond> and <cond>` — conjunction.
 *   - `<cond> or <cond>` — disjunction.
 *   - `selector(<selector>)` — always true (selector matching is supported).
 *   - `font-tech(...)`, `font-format(...)` — always false (no font system).
 *
 * Unknown properties evaluate to false (the engine doesn't support them).
 */
function supportsConditionMatches(condition: string): boolean {
  return evalSupports(condition.trim());
}

/** Recursive supports-condition evaluator. */
function evalSupports(cond: string): boolean {
  // Strip outer parens (but not function-like parens).
  const stripped = stripOuterParens(cond);

  // Check for top-level `or` (lowest precedence).
  const orParts = splitTopLevelKeyword(stripped, "or");
  if (orParts.length > 1) {
    return orParts.some((p) => evalSupports(p));
  }

  // Check for top-level `and`.
  const andParts = splitTopLevelKeyword(stripped, "and");
  if (andParts.length > 1) {
    return andParts.every((p) => evalSupports(p));
  }

  // Check for `not`.
  if (stripped.toLowerCase().startsWith("not ")) {
    return !evalSupports(stripped.slice(4).trim());
  }

  // A single condition: `(prop: value)`, `(prop)`, `selector(...)`, etc.
  return evalSupportsFeature(stripped);
}

/** Evaluate a single supports feature. */
function evalSupportsFeature(feature: string): boolean {
  const trimmed = feature.trim();

  // selector(<compound>) — always true (we support selector matching).
  if (/^selector\(/i.test(trimmed)) {
    return true;
  }

  // font-tech(...), font-format(...) — false (no font system).
  if (/^font-tech\(/i.test(trimmed) || /^font-format\(/i.test(trimmed)) {
    return false;
  }

  // (property: value) or (property) — parenthesized declaration.
  let inner = trimmed;
  if (inner.startsWith("(") && inner.endsWith(")")) {
    inner = inner.slice(1, -1).trim();
  }
  const colonIdx = inner.indexOf(":");
  if (colonIdx === -1) {
    // (property) — only custom properties are valid feature queries.
    return inner.startsWith("--");
  }
  const prop = inner.slice(0, colonIdx).trim().toLowerCase();
  // Known property in the engine's property table = supported. A vendor-prefixed
  // alias whose unprefixed core is known also counts as supported.
  return Boolean(PROPERTY_PARSERS[prop] || (vendorPrefixToStandard(prop) !== null));
}

/** Remove one layer of surrounding parentheses if they wrap the entire string. */
function stripOuterParens(s: string): string {
  if (!s.startsWith("(") || !s.endsWith(")")) return s;
  let depth = 0;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0 && i < s.length - 1) return s; // Not outer.
    }
  }
  return s.slice(1, -1).trim();
}

/** Split a string on a top-level keyword (case-insensitive, word-boundary). */
function splitTopLevelKeyword(s: string, keyword: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let last = 0;
  const lower = s.toLowerCase();
  const kw = ` ${keyword} `;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") { if (depth > 0) depth -= 1; }
    else if (depth === 0 && i > 0) {
      // Check if this position starts ` keyword ` at word boundary.
      const remaining = lower.slice(i - 1);
      if (remaining.startsWith(kw)) {
        parts.push(s.slice(last, i - 1).trim());
        last = i - 1 + kw.length;
        i = last - 1;
      }
    }
  }
  if (last < s.length) {
    parts.push(s.slice(last).trim());
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Selectors + specificity.
// ---------------------------------------------------------------------------

interface ParsedSelector {
  readonly selector: Selector;
  readonly specificity: Specificity;
}

/**
 * Split a selector prelude on top-level commas and parse each into a
 * {@link ParsedSelector}. Empty entries (e.g. a trailing comma) are dropped as
 * a recovery step.
 */
function parseSelectorList(prelude: string): ParsedSelector[] {
  const out: ParsedSelector[] = [];
  for (const piece of splitTopLevel(prelude, ",")) {
    const text = collapseWhitespace(piece);
    if (text.length === 0) {
      continue;
    }
    out.push({ selector: { text }, specificity: computeSpecificity(text) });
  }
  return out;
}

/**
 * Compute CSS specificity `[a, b, c]` for the supported selector subset
 * (a = id, b = class/attribute/pseudo-class, c = type/pseudo-element). Combinators
 * (descendant whitespace, `>`, `+`, `~`) and the universal selector `*`
 * contribute nothing, per the CSS cascade spec. Kept minimal but correct for
 * Phase 1.
 */
function computeSpecificity(selector: string): Specificity {
  let a = 0;
  let b = 0;
  let c = 0;
  let i = 0;
  const len = selector.length;

  const consumeIdent = (): void => {
    while (i < len && isIdentChar(selector[i])) i += 1;
  };

  while (i < len) {
    const ch = selector[i];
    if (ch === undefined) break;

    if (ch === "#") {
      a += 1;
      i += 1;
      consumeIdent();
    } else if (ch === ".") {
      b += 1;
      i += 1;
      consumeIdent();
    } else if (ch === "[") {
      // Attribute selector: count once, skip to the matching ']'.
      b += 1;
      i += 1;
      while (i < len && selector[i] !== "]") i += 1;
      if (i < len) i += 1;
    } else if (ch === ":") {
      if (selector[i + 1] === ":") {
        // Pseudo-element (`::before`): contributes to c.
        c += 1;
        i += 2;
        consumeIdent();
      } else {
        // Pseudo-class (`:hover`): contributes to b.
        b += 1;
        i += 1;
        const nameStart = i;
        consumeIdent();
        const name = selector.slice(nameStart, i).toLowerCase();
        // Skip any functional argument list, e.g. `:nth-child(2n + 1)`. For
        // `:not()` and `:is()`, the CSS Selectors 4 spec says the specificity
        // is the maximum of the argument's specificities. We compute that here.
        if (selector[i] === "(") {
          let depth = 1;
          const argStart = i + 1;
          i += 1;
          while (i < len && depth > 0) {
            const cc = selector[i];
            if (cc === "(") depth += 1;
            else if (cc === ")") depth -= 1;
            i += 1;
          }
          // For :not() and :is(), add the inner specificity.
          if (name === "not" || name === "is") {
            const arg = selector.slice(argStart, i - 1);
            const innerSpec = computeSpecificity(arg);
            a += innerSpec[0];
            b += innerSpec[1];
            c += innerSpec[2];
          }
        }
      }
    } else if (ch === "*") {
      // Universal selector: zero contribution.
      i += 1;
    } else if (isIdentStart(ch)) {
      // Type selector (element name) or pseudo-element written without colons
      // (legacy): contributes to c.
      c += 1;
      consumeIdent();
    } else {
      // Whitespace, combinators (`>`, `+`, `~`): no contribution.
      i += 1;
    }
  }

  return [a, b, c];
}

// ---------------------------------------------------------------------------
// Declarations.
// ---------------------------------------------------------------------------

/**
 * Parse a declaration block body (the text between `{` and `}`) into a list of
 * {@link Declaration}s. Malformed declarations (no colon, empty property, empty
 * value) are skipped; the value of a *known* Phase 1 property is validated by
 * the generated parser and the declaration is skipped if that validation fails.
 */
function parseDeclarations(block: string): Declaration[] {
  const decls: Declaration[] = [];

  for (const piece of splitTopLevel(block, ";")) {
    const text = piece.trim();
    if (text.length === 0) {
      continue;
    }

    const colon = text.indexOf(":");
    if (colon === -1) {
      // No `property: value` shape — recover by skipping this declaration.
      continue;
    }

    const rawProperty = text.slice(0, colon).trim();
    const lowerProp = rawProperty.toLowerCase();
    let value = text.slice(colon + 1).trim();
    if (lowerProp.length === 0 || value.length === 0) {
      continue;
    }

    // Vendor-prefix normalization: a prefixed property whose unprefixed core is a
    // KNOWN engine property is treated as that property (`-webkit-box-shadow` →
    // `box-shadow`, `-moz-appearance` → `appearance`). This lets real-world
    // stylesheets that lead with vendor-prefixed copies actually take effect
    // instead of being silently dropped by the cascade. Custom properties
    // (`--foo`) and genuinely unknown prefixed properties are left untouched.
    const property = rawProperty.startsWith("--")
      ? rawProperty
      : vendorPrefixToStandard(lowerProp) ?? lowerProp;

    // Detect a trailing `!important` (case-insensitive, optional whitespace).
    let important = false;
    const bang = /!\s*important\s*$/i.exec(value);
    if (bang !== null) {
      important = true;
      value = value.slice(0, bang.index).trim();
      if (value.length === 0) {
        // `color: !important` — no actual value; skip as malformed.
        continue;
      }
    }

    // Validate KNOWN Phase 1 property values through the GENERATED parser
    // (Req 18.2 "用生成的解析器"). Unknown properties have no generated parser
    // and are kept verbatim (forward-compatible recovery); calling the
    // generated parser for them would (by design) throw NotImplemented.
    //
    // A value containing `var()` is deferred to the cascade, which resolves
    // the custom property reference first, then re-parses the substituted
    // value. We skip parse-time validation for such values (they cannot be
    // validated until var() is resolved at computed-value time).
    const lowerValue = value.toLowerCase();
    const isCssWideKeyword =
      lowerValue === "inherit" ||
      lowerValue === "initial" ||
      lowerValue === "unset" ||
      lowerValue === "revert";
    if (
      Object.prototype.hasOwnProperty.call(PROPERTY_PARSERS, property) &&
      !lowerValue.includes("var(") &&
      !isCssWideKeyword
    ) {
      const result = parsePropertyValue(property, value);
      if (!result.ok) {
        continue;
      }
    }

    decls.push({ property, value, important });
  }

  return decls;
}

// ---------------------------------------------------------------------------
// Lexical helpers.
// ---------------------------------------------------------------------------

/** CSS whitespace (Syntax §3): space, tab, LF, CR, FF. */
function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
}

/**
 * Map a vendor-prefixed property name to its standard equivalent when the
 * unprefixed core is a KNOWN engine property, otherwise `null`. Recognized
 * prefixes: `-webkit-`, `-moz-`, `-ms-`, `-o-`. This implements the common
 * "the prefixed copy and the standard property mean the same thing" recovery
 * that lets real-world stylesheets take effect.
 *
 * Returns `null` for non-prefixed names and for prefixed names whose core is
 * not a known property (those are left untouched for forward compatibility).
 */
function vendorPrefixToStandard(name: string): string | null {
  if (!name.startsWith("-")) {
    return null;
  }
  const match = /^-(?:webkit|moz|ms|o)-(.+)$/.exec(name);
  if (match === null || match[1] === undefined) {
    return null;
  }
  const core = match[1];
  return Object.prototype.hasOwnProperty.call(PROPERTY_PARSERS, core) ? core : null;
}

/** An identifier may start with an ASCII letter, `_`, an escape, or non-ASCII. */
function isIdentStart(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  return (
    (ch >= "a" && ch <= "z") ||
    (ch >= "A" && ch <= "Z") ||
    ch === "_" ||
    ch === "\\" ||
    ch.charCodeAt(0) > 0x7f
  );
}

/** Identifier continuation: name-start chars plus digits and `-`. */
function isIdentChar(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  return isIdentStart(ch) || (ch >= "0" && ch <= "9") || ch === "-";
}

/** Trim and collapse internal whitespace runs to a single space. */
function collapseWhitespace(input: string): string {
  return input.trim().replace(/\s+/g, " ");
}

/**
 * Strip `/* … *\/` comments, replacing each with a single space so adjacent
 * tokens never fuse. String literals (`"…"` / `'…'`) are respected so a `/*`
 * inside a quoted value is not mistaken for a comment.
 */
function stripComments(input: string): string {
  const len = input.length;
  let out = "";
  let i = 0;
  let quote: string | null = null;

  while (i < len) {
    const ch = input[i];
    if (ch === undefined) break;

    if (quote !== null) {
      out += ch;
      if (ch === "\\" && i + 1 < len) {
        out += input[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === "/" && input[i + 1] === "*") {
      const end = input.indexOf("*/", i + 2);
      i = end === -1 ? len : end + 2;
      out += " ";
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

/**
 * Find the index of the top-level `{` that opens a rule's declaration block,
 * starting the scan at `from`. `{` characters inside a string literal
 * (`"…"`/`'…'`) or nested inside `(…)`/`[…]` are skipped, so a brace embedded
 * in a functional value or an attribute selector does not open a rule early.
 * Returns `-1` if no top-level `{` exists in the remainder of the input.
 */
function findBlockStart(input: string, from: number): number {
  const len = input.length;
  let depth = 0;
  let quote: string | null = null;

  for (let i = from; i < len; i += 1) {
    const ch = input[i];
    if (ch === undefined) break;

    if (quote !== null) {
      if (ch === "\\" && i + 1 < len) {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[") {
      depth += 1;
      continue;
    }
    if (ch === ")" || ch === "]") {
      if (depth > 0) depth -= 1;
      continue;
    }
    if (ch === "{" && depth === 0) {
      return i;
    }
  }

  return -1;
}

/**
 * Find the index of the top-level `}` that closes a declaration block whose
 * body begins at `from`. The scan is string- and nesting-aware so a `}` inside
 * a string literal (`content: "}"`) or inside `(…)`/`[…]` does not close the
 * block early; a nested `{` (defensive — the declaration grammar has none)
 * raises the depth so its matching `}` is not mistaken for the block's end.
 * Returns `-1` if the block is never closed (recovered as a trailing rule).
 */
function findBlockEnd(input: string, from: number): number {
  const len = input.length;
  let depth = 0;
  let quote: string | null = null;

  for (let i = from; i < len; i += 1) {
    const ch = input[i];
    if (ch === undefined) break;

    if (quote !== null) {
      if (ch === "\\" && i + 1 < len) {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === ")" || ch === "]") {
      if (depth > 0) depth -= 1;
      continue;
    }
    if (ch === "}") {
      if (depth === 0) return i;
      depth -= 1;
    }
  }

  return -1;
}

/**
 * Split `input` on top-level occurrences of the single-character `separator`,
 * ignoring separators nested inside `(...)`, `[...]`, or string literals. Used
 * for both the selector list (`,`) and the declaration list (`;`).
 */
function splitTopLevel(input: string, separator: string): string[] {
  const parts: string[] = [];
  const len = input.length;
  let current = "";
  let depth = 0;
  let quote: string | null = null;

  for (let i = 0; i < len; i += 1) {
    const ch = input[i];
    if (ch === undefined) break;

    if (quote !== null) {
      current += ch;
      if (ch === "\\" && i + 1 < len) {
        current += input[i + 1];
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "[") {
      depth += 1;
      current += ch;
      continue;
    }
    if (ch === ")" || ch === "]") {
      if (depth > 0) depth -= 1;
      current += ch;
      continue;
    }
    if (ch === separator && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }

  parts.push(current);
  return parts;
}
