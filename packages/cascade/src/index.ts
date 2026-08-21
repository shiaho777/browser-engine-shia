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
  Declaration,
  DomNode,
  DomTree,
  NodeId,
  Px,
  Specificity,
  StyleSheet,
} from "@browser-engine/ir";
import { CSS_PROPERTIES, PROPERTY_PARSERS, isSpecifiedLength, isSpecifiedCalc, expandDeclarations } from "@browser-engine/generator";
import type { ComputeCtx, SpecifiedLength, SpecifiedCalc, CalcNode } from "@browser-engine/generator";

import { buildRuleIndex, matchRulesForIndexed } from "./rule-index.js";
import type { RuleIndex, CascadeOrigin } from "./rule-index.js";
import { collectCustomProperties, substituteVars } from "./var-substitution.js";
import type { CustomPropertyMap } from "./var-substitution.js";

/**
 * A Symbol key used to store the resolved custom property map on a
 * ComputedStyle object. Using a Symbol (not a string key) ensures it does NOT
 * appear in `Object.keys()` — the cascade's field-set invariant (every key is
 * a data-table field) is preserved. The value is inherited by child nodes.
 */
const CUSTOM_PROPS: unique symbol = Symbol("__custom__");

export const PACKAGE_NAME = "@browser-engine/cascade" as const;

// Re-export the index-backed selector matcher (design.md §8.3): the cascade's
// SOLE path to matching rules, plus the brute-force reference matcher the
// equivalence property (task 5.4 / Req 4.3) asserts against. Exported here so
// the package surface advertises the index as the single entry point.
export {
  buildRuleIndex,
  matchRulesFor,
  matchRulesForIndexed,
  matchRulesByScan,
  candidateRulesFor,
  ruleMatches,
} from "./rule-index.js";
export type { RuleIndex, IndexedRule, SupportedPseudoClass, CascadeOrigin } from "./rule-index.js";

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
 * @param origins optional per-sheet cascade origin labels (default: all
 *   `"author"`). When provided, must be the same length as `sheets`. The first
 *   sheet should typically be `"ua"` (the UA default stylesheet) so author
 *   rules always override UA rules regardless of specificity.
 * @returns the node's frozen, geometry-free ComputedStyle (Requirements 3.3, 11.1).
 */
export function cascade(
  dom: DomTree,
  sheets: readonly StyleSheet[],
  node: NodeId,
  viewport: Viewport = DEFAULT_VIEWPORT,
  origins?: readonly CascadeOrigin[],
  layerOrder?: readonly (readonly string[])[],
): ComputedStyle {
  const index = buildRuleIndex(sheets, origins, layerOrder);
  return cascadeWithIndex(dom, index, node, viewport, layerOrder);
}

export function createComputedStyleResolver(
  dom: DomTree,
  sheets: readonly StyleSheet[],
  viewport: Viewport = DEFAULT_VIEWPORT,
  origins?: readonly CascadeOrigin[],
  layerOrder?: readonly (readonly string[])[],
): (node: NodeId) => ComputedStyle {
  const index = buildRuleIndex(sheets, origins, layerOrder);
  const cache = new Map<NodeId, ComputedStyle>();
  return (node: NodeId): ComputedStyle => cascadeWithIndex(dom, index, node, viewport, layerOrder, cache);
}

export function cascadeWithRuleIndex(
  dom: DomTree,
  index: RuleIndex,
  node: NodeId,
  viewport: Viewport = DEFAULT_VIEWPORT,
  layerOrder?: readonly (readonly string[])[],
  cache?: Map<NodeId, ComputedStyle>,
): ComputedStyle {
  return cascadeWithIndex(dom, index, node, viewport, layerOrder, cache);
}

function cascadeWithIndex(
  dom: DomTree,
  index: RuleIndex,
  node: NodeId,
  viewport: Viewport,
  layerOrder?: readonly (readonly string[])[],
  cache?: Map<NodeId, ComputedStyle>,
): ComputedStyle {
  if (cache !== undefined) {
    const hit = cache.get(node);
    if (hit !== undefined) return hit;
  }
  const domNode = dom.nodes.get(node);
  const parentStyle = resolveParentStyle(dom, index, domNode, viewport, layerOrder, cache);

  // 1) Collect the declarations of every rule matching this node, in document
  //    order (a stable per-declaration sequence drives the source-order
  //    tie-break across all sheets — design.md §8.1).
  const winners = selectWinners(dom, index, node, domNode, layerOrder);

  // Collect custom properties (--foo) for var() substitution. Custom properties
  // inherit, so merge the parent's resolved custom properties with this node's
  // own declarations.
  const parentCustom = (parentStyle as unknown as Record<symbol, unknown>)[CUSTOM_PROPS] as CustomPropertyMap | undefined;
  const custom = collectCustomProperties(
    winners,
    parentCustom ?? new Map(),
  );

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
    const fsValue = substituteVarInValue(fsWinner.value, custom);
    const fsSpec = fsValue !== null ? parseSpecified("font-size", fsValue) : { ok: false } as const;
    if (fsSpec.ok) {
      const resolved = resolveLengths(fsSpec.value, parentFontSizePx, remBasis, viewport);
      if (typeof resolved === "number") fontSizePx = resolved;
    }
  }

  const result: Record<string, unknown> = {};
  // Store the resolved custom properties via Symbol for inheritance.
  (result as unknown as Record<symbol, unknown>)[CUSTOM_PROPS] = custom;

  for (const prop of CSS_PROPERTIES) {
    const winner = winners.get(prop.name);
    if (winner !== undefined) {
      const valueWithVars = substituteVarInValue(winner.value, custom);
      if (valueWithVars === null) {
        result[prop.field] = prop.inherited ? parentStyle[prop.field] : prop.initial;
        continue;
      }
      const keyword = valueWithVars.trim().toLowerCase();
      if (keyword === "inherit") {
        result[prop.field] = parentStyle[prop.field];
        continue;
      }
      if (keyword === "initial") {
        result[prop.field] = prop.initial;
        continue;
      }
      if (keyword === "unset") {
        result[prop.field] = prop.inherited ? parentStyle[prop.field] : prop.initial;
        continue;
      }
      if (keyword === "revert") {
        result[prop.field] = prop.inherited ? parentStyle[prop.field] : prop.initial;
        continue;
      }
      const specified = parseSpecified(prop.name, valueWithVars);
      if (specified.ok) {
        const emBasis = prop.name === "font-size" ? parentFontSizePx : fontSizePx;
        const resolved = resolveLengths(specified.value, emBasis, remBasis, viewport);
        result[prop.field] = prop.computeValue(resolved, parentStyle, ctx);
        continue;
      }
    }
    result[prop.field] = prop.inherited
      ? parentStyle[prop.field] // inherited, undeclared → parent's value (Req 11.3)
      : prop.initial; //           non-inherited, undeclared → initial (Req 11.4)
  }

  const frozen = deepFreeze(result as unknown as ComputedStyle);
  if (cache !== undefined) cache.set(node, frozen);
  return frozen;
}

/**
 * Substitute `var()` references in a property value string. Returns `null` if
 * substitution fails (an unresolvable var() with no fallback).
 */
function substituteVarInValue(value: string, custom: CustomPropertyMap): string | null {
  if (!value.includes("var(")) return value;
  return substituteVars(value, custom);
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
  if (isSpecifiedCalc(value)) {
    return resolveCalc(value, emBasis, remBasis, viewport);
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

/** Resolve a single value that may or may not be a relative length or calc(). */
function maybeResolve(value: unknown, emBasis: number, remBasis: number, viewport: Viewport): unknown {
  if (isSpecifiedLength(value)) return resolveOne(value, emBasis, remBasis, viewport);
  if (isSpecifiedCalc(value)) return resolveCalc(value, emBasis, remBasis, viewport);
  return value;
}

/** Resolve one {@link SpecifiedLength} to `px` against its unit's basis. */
function resolveOne(len: SpecifiedLength, emBasis: number, remBasis: number, viewport: Viewport): Px | SpecifiedLength {
  switch (len.unit) {
    case "%":
      return len;
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

/**
 * Resolve a {@link SpecifiedCalc} (a `calc()` AST) to `px` by evaluating each
 * leaf length against the em/rem/viewport context, then folding the arithmetic.
 * Division by zero yields 0 (defensive — the spec says the declaration is
 * invalid, but we already validated at parse time; a runtime zero divisor from
 * a calc like `100px / (1 - 1)` is clamped to avoid NaN).
 */
function resolveCalc(calc: SpecifiedCalc, emBasis: number, remBasis: number, viewport: Viewport): Px {
  const evalNode = (node: CalcNode): number => {
    switch (node.type) {
      case "px":
        return node.value;
      case "num":
        return node.value;
      case "len": {
        const r = resolveOne({ kind: "specified-length", value: node.value, unit: node.unit }, emBasis, remBasis, viewport);
        return typeof r === "number" ? r : 0;
      }
      case "add":
        return evalNode(node.left) + evalNode(node.right);
      case "sub":
        return evalNode(node.left) - evalNode(node.right);
      case "mul":
        return evalNode(node.left) * evalNode(node.right);
      case "div": {
        const r = evalNode(node.right);
        return r === 0 ? 0 : evalNode(node.left) / r;
      }
    }
  };
  return px(evalNode(calc.ast));
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
  layerOrder?: readonly (readonly string[])[],
  cache?: Map<NodeId, ComputedStyle>,
): ComputedStyle {
  if (domNode === undefined || domNode.parent === null) {
    return INITIAL_STYLE;
  }
  return cascadeWithIndex(dom, index, domNode.parent, viewport, layerOrder, cache);
}

// ---------------------------------------------------------------------------
// Cascade sort — winning declaration per property.
// ---------------------------------------------------------------------------

/** A candidate declaration with the metadata the cascade order compares. */
interface Candidate {
  readonly value: string;
  readonly important: boolean;
  /** The cascade origin of this declaration (ua/user/author/inline). */
  readonly origin: CascadeOrigin | "inline";
  /** The cascade layer path this declaration belongs to (`undefined` = unlayered). */
  readonly layer?: readonly string[] | undefined;
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
  layerOrder?: readonly (readonly string[])[],
): ReadonlyMap<string, Candidate> {
  const winners = new Map<string, Candidate>();
  if (domNode === undefined || domNode.kind !== "element") {
    // Only elements match selectors; non-elements declare nothing.
    return winners;
  }

  let seq = 0;
  // matchRulesFor returns rules in document order, but each rule now carries
  // its origin (ua/user/author) via the IndexedRule wrapper. The cascade rank
  // (see beats) ensures author rules always override UA rules regardless of
  // specificity (CSS Cascade 4 §6.3).
  for (const indexed of matchRulesForIndexed(index, dom, node)) {
    const rule = indexed.rule;
    for (const decl of expandDeclarations(rule.declarations)) {
      const candidate: Candidate = {
        value: decl.value,
        important: decl.important,
        origin: indexed.origin,
        layer: indexed.layer,
        specificity: rule.specificity,
        seq: seq++,
      };
      const current = winners.get(decl.property);
      if (current === undefined || beats(candidate, current, layerOrder ?? [])) {
        winners.set(decl.property, candidate);
      }
    }
  }

  for (const decl of expandDeclarations(inlineDeclarations(domNode.attrs?.get("style") ?? ""))) {
    const candidate: Candidate = {
      value: decl.value,
      important: decl.important,
      origin: "inline",
      specificity: [1, 0, 0],
      seq: seq++,
    };
    const current = winners.get(decl.property);
    if (current === undefined || beats(candidate, current, layerOrder ?? [])) {
      winners.set(decl.property, candidate);
    }
  }

  return winners;
}

/**
 * Compute the cascade precedence rank for a declaration (CSS Cascade 4 §6.3).
 * Higher rank wins. The order is (low to high):
 *
 *   0. UA normal
 *   1. User normal
 *   2. Author normal
 *   3. Inline normal (inline style attribute)
 *   4. Author important
 *   5. User important
 *   6. UA important
 *   7. Inline important
 *
 * Note: important declarations are partially REVERSED — UA important beats
 * author important, unlike normal where author beats UA. Inline always wins
 * within its importance class.
 */
function cascadeRank(origin: CascadeOrigin | "inline", important: boolean): number {
  if (important) {
    switch (origin) {
      case "author": return 4;
      case "user": return 5;
      case "ua": return 6;
      case "inline": return 7;
    }
  }
  switch (origin) {
    case "ua": return 0;
    case "user": return 1;
    case "author": return 2;
    case "inline": return 3;
  }
}

/**
 * Compute the layer precedence of a declaration (CSS Cascading 5 §7).
 * Higher number wins. Unlayered rules have the highest precedence.
 * Layered rules are ordered by their declaration order: later layers win.
 *
 * @param layer the rule's layer path (`undefined` = unlayered).
 * @param layerOrder the declared layer order (first = lowest precedence).
 * @returns a numeric precedence (higher = wins).
 */
function layerPrecedence(
  layer: readonly string[] | undefined,
  layerOrder: readonly (readonly string[])[],
): number {
  // Unlayered rules always beat layered rules.
  if (layer === undefined || layer.length === 0) return layerOrder.length;
  // Find the index of this layer in the declared order. A layer declared later
  // has a higher index = higher precedence.
  const layerKey = layer.join(".");
  for (let i = 0; i < layerOrder.length; i++) {
    if (layerOrder[i]?.join(".") === layerKey) return i;
  }
  // A layer that was not explicitly declared: treat it as declared at its
  // first-seen position (same as the index where it would be inserted).
  return layerOrder.length;
}

/** Does `candidate` win over `current` under the cascade order (Req 11.2)? */
function beats(
  candidate: Candidate,
  current: Candidate,
  layerOrder: readonly (readonly string[])[],
): boolean {
  const candidateRank = cascadeRank(candidate.origin, candidate.important);
  const currentRank = cascadeRank(current.origin, current.important);
  if (candidateRank !== currentRank) {
    return candidateRank > currentRank;
  }
  // Same origin+importance: compare cascade layer precedence. Unlayered rules
  // beat layered rules; later-declared layers beat earlier ones.
  const candidateLayer = layerPrecedence(candidate.layer, layerOrder);
  const currentLayer = layerPrecedence(current.layer, layerOrder);
  if (candidateLayer !== currentLayer) {
    return candidateLayer > currentLayer;
  }
  const cmp = compareSpecificity(candidate.specificity, current.specificity);
  if (cmp !== 0) {
    return cmp > 0; // higher specificity wins.
  }
  // Same importance, origin, layer, and specificity: the later declaration in
  // document order wins. `candidate` is processed after `current`.
  return candidate.seq >= current.seq;
}

/** Parse an element's inline `style` attribute into declaration candidates. */
function inlineDeclarations(style: string): Declaration[] {
  const decls: Declaration[] = [];
  for (const piece of splitInlineDeclarations(style)) {
    const idx = piece.indexOf(":");
    if (idx <= 0) continue;
    const rawProperty = piece.slice(0, idx).trim();
    const property = rawProperty.startsWith("--") ? rawProperty : rawProperty.toLowerCase();
    let value = piece.slice(idx + 1).trim();
    if (property.length === 0 || value.length === 0) continue;

    let important = false;
    const bang = /!\s*important\s*$/i.exec(value);
    if (bang !== null) {
      important = true;
      value = value.slice(0, bang.index).trim();
      if (value.length === 0) continue;
    }
    if (!parseSpecified(property, value).ok) continue;
    decls.push({ property, value, important });
  }
  return decls;
}

/** Split inline style declarations on top-level semicolons. */
function splitInlineDeclarations(input: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const prev = i > 0 ? input[i - 1] : "";
    if (quote !== null) {
      if (ch === quote && prev !== "\\") quote = null;
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
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (ch === ";" && depth === 0) {
      parts.push(input.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(input.slice(start).trim());
  return parts.filter((p) => p.length > 0);
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
