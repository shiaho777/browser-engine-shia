/**
 * @browser-engine/cascade
 *
 * Cascade / computed-style engine (design.md §8.1; Requirement 11). A
 * deterministic, PURE query `cascade` that resolves EVERY CSS property in the
 * data table to a computed value for one node:
 *
 *   1. collect the declarations of all rules whose selector matches the node,
 *      via the {@link RuleIndex} as the SOLE matching entry point (design.md
 *      §8.3; Req 4.1, 4.2 — no bypass path),
 *   2. pick the winning declaration per property by
 *      (origin/importance → specificity → source order) (Req 11.2),
 *   3. for every property in the generated data table produce a computed value:
 *      - a winner's parsed value run through the property's `computeValue`
 *        (Req 11.1), else
 *      - the parent's computed value if the property inherits (Req 11.3), else
 *      - the property's initial value (Req 11.4).
 *
 * The result is a geometry-free {@link ComputedStyle} (Requirement 3.3),
 * deep-frozen for runtime immutability (Requirement 3.2), and deterministic for
 * identical inputs (Req 11.5).
 *
 * ## Platform-as-Data
 *
 * The per-property knowledge — which properties exist, whether each inherits,
 * its initial value, how its value parses, and its `computeValue` — is consumed
 * from the GENERATED data table (`@browser-engine/generator`: `CSS_PROPERTIES`
 * with its `inherited`/`initial`/`computeValue`, and `PROPERTY_PARSERS`). These
 * are the same rows the generator emits the `INHERITED_PROPERTIES` /
 * `INITIAL_VALUES` tables from, so the cascade hand-writes no per-property
 * branch (Requirement 6.5). The generator is *infrastructure*, not a pipeline
 * stage, so importing its artifacts is allowed by `local/no-cross-stage-import`;
 * the cascade never reaches across a stage boundary (it cannot import
 * html-parser / css-parser / layout / paint — they share only via the frozen IR
 * and the generator).
 *
 * ## Inheritance & the existing signature (design choice — documented)
 *
 * design.md §8.1 resolves the parent's computed value recursively
 * (`parent ← cascade(db, dom.nodes[node].parent)`), which needs the parent's
 * `ComputedStyle`. The Phase-1 signature `cascade(dom, sheets, node)` does not
 * receive a parent style, so this implementation RESOLVES THE PARENT INTERNALLY
 * by recursing up the DOM (option (a)): a node's parent style is `cascade` of
 * its parent, and the document root (parent `null`) bottoms out at the
 * all-initial baseline. This keeps the `qComputed` wiring in `cli/pipeline.ts`
 * unchanged and the function pure and deterministic. The recursion terminates
 * because a DomTree is acyclic. (When the true incremental kernel lands, the
 * design's `db`-keyed recursion memoizes each node's style; the naive Phase-1
 * recompute here is observationally identical — Requirement 9.1.)
 */
import { deepFreeze, px } from "@browser-engine/ir";
import type {
  ComputedStyle,
  DomNode,
  DomTree,
  NodeId,
  Px,
  Specificity,
  StyleSheet,
} from "@browser-engine/ir";
import { CSS_PROPERTIES, PROPERTY_PARSERS, isSpecifiedLength } from "@browser-engine/generator";
import type { ComputeCtx, SpecifiedLength } from "@browser-engine/generator";

import { buildRuleIndex, matchRulesFor } from "./rule-index.js";
import type { RuleIndex } from "./rule-index.js";

export const PACKAGE_NAME = "@browser-engine/cascade" as const;

// Re-export the index-backed selector matcher (design.md §8.3): the cascade's
// SOLE path to matching rules, plus the brute-force reference matcher the
// equivalence property (task 5.4 / Req 4.3) asserts against. Exported here so
// the package surface advertises the index as the single entry point.
export {
  buildRuleIndex,
  matchRulesFor,
  matchRulesByScan,
  candidateRulesFor,
  ruleMatches,
} from "./rule-index.js";
export type { RuleIndex, IndexedRule, SupportedPseudoClass } from "./rule-index.js";

// The CSS Transitions / Web Animations value-interpolation core (timing
// functions + data-driven per-property interpolation), consuming the same
// `animationType`/`tsType` data rows the cascade resolves from.
export {
  parseEasing,
  sampleEasing,
  interpolateValue,
  interpolateStyle,
  animationProgress,
} from "./interpolate.js";
export type { Easing, StepPosition } from "./interpolate.js";

/**
 * The document root font size in px used to build the `computeValue` context.
 * The Phase 1 `<length>` grammar resolves only `px`/`0` (no relative units), so
 * no Phase 1 property actually reads `rootFontSize`; it is carried as the
 * property table's initial font size so the context shape is already final and
 * deterministic (later phases thread the true root size without changing this
 * signature).
 */
const ROOT_FONT_SIZE = 16;

/** The viewport (initial containing block) size in px, the basis for `vw`/`vh`. */
export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/**
 * The default viewport (initial containing block) for `vw`/`vh`/`vmin`/`vmax`
 * resolution when a caller does not supply one. Matches the layout engine's
 * 800px default viewport width (see cli `render.ts` `DEFAULT_CANVAS_WIDTH`); the
 * 600px height is the conventional companion. A caller that lays out at a
 * different viewport should pass the SAME size here so viewport units agree
 * with layout.
 */
const DEFAULT_VIEWPORT: Viewport = { width: 800, height: 600 };

/**
 * Compute the {@link ComputedStyle} for one node from the upstream DOM and
 * stylesheets (design.md §8.1). Reads ONLY frozen upstream IR.
 *
 * @param dom the frozen DomTree IR.
 * @param sheets the frozen StyleSheet IR list matched against the node.
 * @param node the node whose computed style is requested.
 * @param viewport the viewport size for `vw`/`vh`/`vmin`/`vmax` (defaults to
 *   {@link DEFAULT_VIEWPORT}); pass the layout viewport to keep units in sync.
 * @returns the node's frozen, geometry-free ComputedStyle (Requirements 3.3, 11.1).
 */
export function cascade(
  dom: DomTree,
  sheets: readonly StyleSheet[],
  node: NodeId,
  viewport: Viewport = DEFAULT_VIEWPORT,
): ComputedStyle {
  // Selector matching routes through the RuleIndex as its SOLE entry point
  // (design.md §8.3; Req 4.1, 4.2). Build it once and thread it through the
  // parent recursion so every match request — this node's and every ancestor's
  // — goes through the index, never an exhaustive scan.
  const index = buildRuleIndex(sheets);
  return cascadeWithIndex(dom, index, node, viewport);
}

/** Cascade one node against a prebuilt {@link RuleIndex} (the recursion core). */
function cascadeWithIndex(dom: DomTree, index: RuleIndex, node: NodeId, viewport: Viewport): ComputedStyle {
  const domNode = dom.nodes.get(node);
  // A node absent from the DomTree has no style of its own; fall back to the
  // all-initial baseline (inherited and non-inherited alike resolve to initial).
  const parentStyle = resolveParentStyle(dom, index, domNode, viewport);

  // 1) Collect the declarations of every rule matching this node, in document
  //    order (a stable per-declaration sequence drives the source-order
  //    tie-break across all sheets — design.md §8.1).
  const winners = selectWinners(dom, index, node, domNode);

  // 2 & 3) Resolve every property in the data table to a computed value.
  const ctx: ComputeCtx = { rootFontSize: ROOT_FONT_SIZE };
  const remBasis = ROOT_FONT_SIZE;
  const parentFontSize = (parentStyle as unknown as Record<string, unknown>)["fontSize"];
  const parentFontSizePx = typeof parentFontSize === "number" ? parentFontSize : ROOT_FONT_SIZE;

  // `font-size` must resolve FIRST: it is the `em` basis for every other length
  // on this element, while its OWN `em` is relative to the PARENT font size
  // (CSS Values 4 §6.1). Resolve it once up front, then reuse as the em basis.
  let fontSizePx = parentFontSizePx; // font-size inherits, so this is the default
  const fsWinner = winners.get("font-size");
  if (fsWinner !== undefined) {
    const fsSpec = parseSpecified("font-size", fsWinner.value);
    if (fsSpec.ok) {
      const resolved = resolveLengths(fsSpec.value, parentFontSizePx, remBasis, viewport);
      if (typeof resolved === "number") fontSizePx = resolved;
    }
  }

  const result: Record<string, unknown> = {};
  for (const prop of CSS_PROPERTIES) {
    const winner = winners.get(prop.name);
    if (winner !== undefined) {
      const specified = parseSpecified(prop.name, winner.value);
      if (specified.ok) {
        // `em` on font-size is relative to the parent; on everything else it is
        // relative to this element's own (now resolved) font size.
        const emBasis = prop.name === "font-size" ? parentFontSizePx : fontSizePx;
        const resolved = resolveLengths(specified.value, emBasis, remBasis, viewport);
        result[prop.field] = prop.computeValue(resolved, parentStyle, ctx);
        continue;
      }
      // A winner whose value fails to parse is treated as no declaration
      // (defensive: the css-parser already drops invalid known-property values).
    }
    result[prop.field] = prop.inherited
      ? parentStyle[prop.field] // inherited, undeclared → parent's value (Req 11.3)
      : prop.initial; //           non-inherited, undeclared → initial (Req 11.4)
  }

  return deepFreeze(result as unknown as ComputedStyle);
}

/**
 * Resolve any font-relative {@link SpecifiedLength} in a specified value to an
 * absolute {@link Px}, given the `em` basis (a font size in px) and the `rem`
 * basis (the root font size). Handles a bare length, an `Edges` quad of lengths
 * (e.g. `margin`/`padding`), and passes through every other shape (keywords,
 * colors, numbers, already-resolved `Px`) untouched. Absolute lengths were
 * already resolved to `Px` at parse time, so they arrive as plain numbers.
 */
function resolveLengths(value: unknown, emBasis: number, remBasis: number, viewport: Viewport): unknown {
  if (isSpecifiedLength(value)) {
    return resolveOne(value, emBasis, remBasis, viewport);
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "top" in value &&
    "right" in value &&
    "bottom" in value &&
    "left" in value
  ) {
    const e = value as Record<"top" | "right" | "bottom" | "left", unknown>;
    return {
      top: maybeResolve(e.top, emBasis, remBasis, viewport),
      right: maybeResolve(e.right, emBasis, remBasis, viewport),
      bottom: maybeResolve(e.bottom, emBasis, remBasis, viewport),
      left: maybeResolve(e.left, emBasis, remBasis, viewport),
    };
  }
  return value;
}

/** Resolve a single value that may or may not be a relative length. */
function maybeResolve(value: unknown, emBasis: number, remBasis: number, viewport: Viewport): unknown {
  return isSpecifiedLength(value) ? resolveOne(value, emBasis, remBasis, viewport) : value;
}

/** Resolve one {@link SpecifiedLength} to `px` against its unit's basis. */
function resolveOne(len: SpecifiedLength, emBasis: number, remBasis: number, viewport: Viewport): Px {
  switch (len.unit) {
    case "rem":
      return px(len.value * remBasis);
    case "em":
      return px(len.value * emBasis);
    case "vw":
      return px((len.value * viewport.width) / 100);
    case "vh":
      return px((len.value * viewport.height) / 100);
    case "vmin":
      return px((len.value * Math.min(viewport.width, viewport.height)) / 100);
    case "vmax":
      return px((len.value * Math.max(viewport.width, viewport.height)) / 100);
  }
}

// ---------------------------------------------------------------------------
// Parent resolution + the all-initial baseline.
// ---------------------------------------------------------------------------

/**
 * The all-initial {@link ComputedStyle}: every property at its initial value.
 * Used as the parent of the document root, so an inherited property with no
 * ancestor declaration resolves to its initial value (Req 11.3 bottoming out at
 * Req 11.4). Built once from the data table; frozen so it can serve as a shared
 * immutable parent.
 */
const INITIAL_STYLE: ComputedStyle = (() => {
  const base: Record<string, unknown> = {};
  for (const prop of CSS_PROPERTIES) {
    base[prop.field] = prop.initial;
  }
  return deepFreeze(base as unknown as ComputedStyle);
})();

/** Resolve the parent node's computed style, or the initial baseline at the root. */
function resolveParentStyle(
  dom: DomTree,
  index: RuleIndex,
  domNode: DomNode | undefined,
  viewport: Viewport,
): ComputedStyle {
  if (domNode === undefined || domNode.parent === null) {
    return INITIAL_STYLE;
  }
  return cascadeWithIndex(dom, index, domNode.parent, viewport);
}

// ---------------------------------------------------------------------------
// Cascade sort — winning declaration per property.
// ---------------------------------------------------------------------------

/** A candidate declaration with the metadata the cascade order compares. */
interface Candidate {
  readonly value: string;
  readonly important: boolean;
  readonly specificity: Specificity;
  /** Global document-order sequence for the source-order tie-break (Req 11.2). */
  readonly seq: number;
}

/**
 * Walk every matching rule's declarations and keep, per property, the winning
 * candidate under the cascade order (origin/importance → specificity → source
 * order). Phase 1 has a single origin (author), so importance (`!important`)
 * is the first discriminator (Req 11.2).
 */
function selectWinners(
  dom: DomTree,
  index: RuleIndex,
  node: NodeId,
  domNode: DomNode | undefined,
): ReadonlyMap<string, Candidate> {
  const winners = new Map<string, Candidate>();
  if (domNode === undefined || domNode.kind !== "element") {
    // Only elements match selectors; non-elements declare nothing.
    return winners;
  }

  let seq = 0;
  // matchRulesFor is the SOLE entry point to matching (design.md §8.3): it
  // returns, in document order, exactly the rules an exhaustive scan would —
  // but verifies only index-bucket candidates (Req 4.1, 4.2, 4.4).
  for (const rule of matchRulesFor(index, dom, node)) {
    for (const decl of rule.declarations) {
      const candidate: Candidate = {
        value: decl.value,
        important: decl.important,
        specificity: rule.specificity,
        seq: seq++,
      };
      const current = winners.get(decl.property);
      if (current === undefined || beats(candidate, current)) {
        winners.set(decl.property, candidate);
      }
    }
  }
  return winners;
}

/** Does `candidate` win over `current` under the cascade order (Req 11.2)? */
function beats(candidate: Candidate, current: Candidate): boolean {
  if (candidate.important !== current.important) {
    return candidate.important; // !important beats normal (same author origin).
  }
  const cmp = compareSpecificity(candidate.specificity, current.specificity);
  if (cmp !== 0) {
    return cmp > 0; // higher specificity wins.
  }
  // Same importance and specificity: the later declaration in document order
  // wins. `candidate` is processed after `current`, so it has the higher seq.
  return candidate.seq >= current.seq;
}

/** Lexicographically compare two `[a, b, c]` specificity triples. */
function compareSpecificity(a: Specificity, b: Specificity): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}

// ---------------------------------------------------------------------------
// Value parsing — delegate to the generated per-property parser.
// ---------------------------------------------------------------------------

/** A parsed specified value, or a failure. */
type Specified = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

/**
 * Parse a winner's raw value string with the GENERATED per-property parser.
 * Every property iterated here comes from `CSS_PROPERTIES`, so a parser always
 * exists; the `undefined` guard keeps the access type-safe and future-proof.
 */
function parseSpecified(property: string, value: string): Specified {
  const parser = PROPERTY_PARSERS[property];
  if (parser === undefined) {
    return { ok: false };
  }
  const result = parser(value);
  return result.ok ? { ok: true, value: result.value } : { ok: false };
}
