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
  Color,
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

import { buildRuleIndex, matchPseudoRules, matchRulesForIndexed } from "./rule-index.js";
import type { RuleIndex, CascadeOrigin, IndexedPseudoElement, IndexedRule } from "./rule-index.js";
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
  matchPseudoRules,
  matchRulesByScan,
  candidateRulesFor,
  ruleMatches,
  selectorTargetsHost,
} from "./rule-index.js";
export type { RuleIndex, IndexedRule, SupportedPseudoClass, CascadeOrigin } from "./rule-index.js";

// Form-control semantics shared by the state pseudo-classes AND the
// script bridge's validation API — one pure source of truth (RFC 0021).
export {
  computeValidity,
  controlChecked,
  controlDisabled,
  controlSelected,
  controlValueOf,
  inputType,
  isFormControl,
  ownerFormOf,
  radioGroupPeers,
  selectOptions,
  valueAsNumber,
  willValidate,
} from "./form-state.js";
export type { ValidityFlags } from "./form-state.js";

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
  options?: CascadeOptions,
): ComputedStyle {
  const index = buildRuleIndex(sheets, origins, layerOrder);
  return cascadeWithIndex(dom, index, node, viewport, layerOrder, undefined, undefined, options);
}

export function createComputedStyleResolver(
  dom: DomTree,
  sheets: readonly StyleSheet[],
  viewport: Viewport = DEFAULT_VIEWPORT,
  origins?: readonly CascadeOrigin[],
  layerOrder?: readonly (readonly string[])[],
  options?: CascadeOptions,
): (node: NodeId) => ComputedStyle {
  const index = buildRuleIndex(sheets, origins, layerOrder);
  const cache = new Map<NodeId, ComputedStyle>();
  return (node: NodeId): ComputedStyle => cascadeWithIndex(dom, index, node, viewport, layerOrder, cache, undefined, options);
}

export function cascadeWithRuleIndex(
  dom: DomTree,
  index: RuleIndex,
  node: NodeId,
  viewport: Viewport = DEFAULT_VIEWPORT,
  layerOrder?: readonly (readonly string[])[],
  cache?: Map<NodeId, ComputedStyle>,
  /** Shadow DOM: `:host` rules from the element's own shadow root, applied to
   * `extras.node` only (the host) at `shadow-host` origin — below every
   * document rule for normal declarations (CSS Scoping §2.4). */
  extras?: { readonly node: NodeId; readonly rules: readonly IndexedRule[] },
  options?: CascadeOptions,
): ComputedStyle {
  return cascadeWithIndex(dom, index, node, viewport, layerOrder, cache, extras, options);
}

function cascadeWithIndex(
  dom: DomTree,
  index: RuleIndex,
  node: NodeId,
  viewport: Viewport,
  layerOrder?: readonly (readonly string[])[],
  cache?: Map<NodeId, ComputedStyle>,
  extras?: { readonly node: NodeId; readonly rules: readonly IndexedRule[] },
  options?: CascadeOptions,
): ComputedStyle {
  if (cache !== undefined) {
    const hit = cache.get(node);
    if (hit !== undefined) return hit;
  }
  const domNode = dom.nodes.get(node);
  const parentStyle = resolveParentStyle(dom, index, domNode, viewport, layerOrder, cache, options);

  // 1) Collect the declarations of every rule matching this node, in document
  //    order (a stable per-declaration sequence drives the source-order
  //    tie-break across all sheets — design.md §8.1).
  const winners = selectWinners(dom, index, node, domNode, layerOrder, node === extras?.node ? extras.rules : undefined, options);
  const flowMapped = mapLogicalWinners(winners, parentStyle, layerOrder);

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
  const winnersForProps = flowMapped;

  // `font-size` must resolve FIRST: it is the `em` basis for every other length
  // on this element, while its OWN `em` is relative to the PARENT font size
  // (CSS Values 4 §6.1). Resolve it once up front, then reuse as the em basis.
  let fontSizePx = parentFontSizePx; // font-size inherits, so this is the default
  const fsWinner = winnersForProps.get("font-size");
  if (fsWinner !== undefined) {
    const fsValue = substituteVarInValue(fsWinner.value, custom);
    const fsSpec = fsValue !== null ? parseSpecified("font-size", fsValue) : { ok: false } as const;
    if (fsSpec.ok) {
      const resolved = resolveFontSizeLength(fsSpec.value, parentFontSizePx, remBasis, viewport);
      if (typeof resolved === "number") fontSizePx = resolved;
    }
  }

  const result: Record<string, unknown> = {};
  // Store the resolved custom properties via Symbol for inheritance.
  (result as unknown as Record<symbol, unknown>)[CUSTOM_PROPS] = custom;

  for (const prop of CSS_PROPERTIES) {
    const winner = winnersForProps.get(prop.name);
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
        const resolved =
          prop.name === "font-size"
            ? resolveFontSizeLength(specified.value, emBasis, remBasis, viewport)
            : resolveLengths(specified.value, emBasis, remBasis, viewport);
        result[prop.field] = prop.computeValue(resolved, parentStyle, ctx);
        continue;
      }
    }
    result[prop.field] = prop.inherited
      ? parentStyle[prop.field] // inherited, undeclared → parent's value (Req 11.3)
      : prop.initial; //           non-inherited, undeclared → initial (Req 11.4)
  }

  // `margin: 1px 2px` expands into longhands, so the shorthand field would
  // otherwise stay at its initial zero quad. A non-zero longhand wins that
  // side. A zero longhand leaves the shorthand side alone, which keeps
  // `calc()` margins that the expander does not claim.
  const marginBase = result["margin"] as { top?: unknown; right?: unknown; bottom?: unknown; left?: unknown };
  const marginSide = (key: "top" | "right" | "bottom" | "left", longhand: unknown): number => {
    if (typeof longhand === "number" && Number.isFinite(longhand) && longhand !== 0) return longhand;
    const prev = marginBase[key];
    return typeof prev === "number" && Number.isFinite(prev) ? prev : 0;
  };
  result["margin"] = {
    top: marginSide("top", result["marginTop"]),
    right: marginSide("right", result["marginRight"]),
    bottom: marginSide("bottom", result["marginBottom"]),
    left: marginSide("left", result["marginLeft"]),
  };

  // `::first-letter` / `::first-line` `font-size` rides on the element style
  // as data layout can read. Neither is a generated field, so each is omitted
  // when no such rule matches — the data-table key set stays exact. `em`/`%`
  // resolve against THIS element's font-size (the pseudo's parent).
  if (domNode?.kind === "element") {
    const letterPx = pseudoFontSizeOf(
      dom, index, node, fontSizePx, remBasis, viewport, custom, layerOrder, "first-letter",
    );
    const linePx = pseudoFontSizeOf(
      dom, index, node, fontSizePx, remBasis, viewport, custom, layerOrder, "first-line",
    );
    if (letterPx !== undefined) result["firstLetterFontSize"] = letterPx;
    if (linePx !== undefined) result["firstLineFontSize"] = linePx;
    const letterColor = pseudoColorOf(dom, index, node, custom, layerOrder, "first-letter");
    const lineColor = pseudoColorOf(dom, index, node, custom, layerOrder, "first-line");
    if (letterColor !== undefined) result["firstLetterColor"] = letterColor;
    if (lineColor !== undefined) result["firstLineColor"] = lineColor;
    const letterFloat = pseudoFloatOf(dom, index, node, custom, layerOrder);
    if (letterFloat !== undefined) result["firstLetterFloat"] = letterFloat;
    const letterWeight = pseudoFontWeightOf(dom, index, node, custom, layerOrder, "first-letter");
    const lineWeight = pseudoFontWeightOf(dom, index, node, custom, layerOrder, "first-line");
    if (letterWeight !== undefined) result["firstLetterFontWeight"] = letterWeight;
    if (lineWeight !== undefined) result["firstLineFontWeight"] = lineWeight;
    const letterStyle = pseudoFontStyleOf(dom, index, node, custom, layerOrder, "first-letter");
    const lineStyle = pseudoFontStyleOf(dom, index, node, custom, layerOrder, "first-line");
    if (letterStyle !== undefined) result["firstLetterFontStyle"] = letterStyle;
    if (lineStyle !== undefined) result["firstLineFontStyle"] = lineStyle;
    const letterTransform = pseudoTextTransformOf(dom, index, node, custom, layerOrder, "first-letter");
    const lineTransform = pseudoTextTransformOf(dom, index, node, custom, layerOrder, "first-line");
    if (letterTransform !== undefined) result["firstLetterTextTransform"] = letterTransform;
    if (lineTransform !== undefined) result["firstLineTextTransform"] = lineTransform;
    const letterWord = pseudoWordSpacingOf(
      dom, index, node, letterPx ?? fontSizePx, remBasis, viewport, custom, layerOrder, "first-letter",
    );
    const lineWord = pseudoWordSpacingOf(
      dom, index, node, linePx ?? fontSizePx, remBasis, viewport, custom, layerOrder, "first-line",
    );
    if (letterWord !== undefined) result["firstLetterWordSpacing"] = letterWord;
    if (lineWord !== undefined) result["firstLineWordSpacing"] = lineWord;
    const letterLeading = pseudoLineHeightOf(
      dom, index, node, letterPx ?? fontSizePx, remBasis, viewport, custom, layerOrder, "first-letter",
    );
    const lineLeading = pseudoLineHeightOf(
      dom, index, node, linePx ?? fontSizePx, remBasis, viewport, custom, layerOrder, "first-line",
    );
    if (letterLeading !== undefined) result["firstLetterLineHeight"] = letterLeading;
    if (lineLeading !== undefined) result["firstLineLineHeight"] = lineLeading;
    const letterAlign = pseudoVerticalAlignOf(
      dom, index, node, letterPx ?? fontSizePx, remBasis, viewport, custom, layerOrder,
    );
    if (letterAlign !== undefined) result["firstLetterVerticalAlign"] = letterAlign;
    const letterDeco = pseudoDecorationOf(dom, index, node, custom, layerOrder, "first-letter");
    const lineDeco = pseudoDecorationOf(dom, index, node, custom, layerOrder, "first-line");
    if (letterDeco !== undefined) result["firstLetterTextDecoration"] = letterDeco;
    if (lineDeco !== undefined) result["firstLineTextDecoration"] = lineDeco;
    // `em` in letter-spacing uses the pseudo's own font-size when that rule
    // sets one, otherwise the element's font-size.
    const letterTrack = pseudoLetterSpacingOf(
      dom, index, node, letterPx ?? fontSizePx, remBasis, viewport, custom, layerOrder, "first-letter",
    );
    const lineTrack = pseudoLetterSpacingOf(
      dom, index, node, linePx ?? fontSizePx, remBasis, viewport, custom, layerOrder, "first-line",
    );
    if (letterTrack !== undefined) result["firstLetterLetterSpacing"] = letterTrack;
    if (lineTrack !== undefined) result["firstLineLetterSpacing"] = lineTrack;
    const letterMargin = pseudoBoxEdgesOf(
      dom, index, node, letterPx ?? fontSizePx, remBasis, viewport, custom, layerOrder, "margin",
    );
    const letterPadding = pseudoBoxEdgesOf(
      dom, index, node, letterPx ?? fontSizePx, remBasis, viewport, custom, layerOrder, "padding",
    );
    if (letterMargin !== undefined) result["firstLetterMargin"] = letterMargin;
    if (letterPadding !== undefined) result["firstLetterPadding"] = letterPadding;
    const letterBorder = pseudoLetterBorderOf(
      dom, index, node, letterPx ?? fontSizePx, remBasis, viewport, custom, layerOrder,
      asColor(result["color"]) ?? { r: 0, g: 0, b: 0, a: 1 },
    );
    if (letterBorder !== undefined) result["firstLetterBorder"] = letterBorder;
    const letterBackground = pseudoBackgroundColorOf(dom, index, node, custom, layerOrder, "first-letter");
    const lineBackground = pseudoBackgroundColorOf(dom, index, node, custom, layerOrder, "first-line");
    if (letterBackground !== undefined) result["firstLetterBackgroundColor"] = letterBackground;
    if (lineBackground !== undefined) result["firstLineBackgroundColor"] = lineBackground;
    const letterImage = pseudoLetterImageOf(dom, index, node, custom, layerOrder, "first-letter");
    const lineImage = pseudoLetterImageOf(dom, index, node, custom, layerOrder, "first-line");
    if (letterImage !== undefined) result["firstLetterBackgroundImage"] = letterImage;
    if (lineImage !== undefined) result["firstLineBackgroundImage"] = lineImage;
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
    if (calcKeepsPercentage(value)) return value;
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

/**
 * The winning `font-size` of `::first-letter` or `::first-line` rules that
 * match `node`, in px. Absent when no such declaration wins. Color and the
 * other pseudo longhands are not applied here — layout only consumes the size.
 */
function pseudoFontSizeOf(
  dom: DomTree,
  index: RuleIndex,
  node: NodeId,
  elementFontSizePx: number,
  remBasis: number,
  viewport: Viewport,
  custom: CustomPropertyMap,
  layerOrder: readonly (readonly string[])[] | undefined,
  pseudo: IndexedPseudoElement,
): number | undefined {
  const raw = winningPseudoValue(dom, index, node, layerOrder, pseudo, "font-size");
  if (raw === undefined) return undefined;
  const fsValue = substituteVarInValue(raw, custom);
  if (fsValue === null) return undefined;
  const fsSpec = parseSpecified("font-size", fsValue);
  if (!fsSpec.ok) return undefined;
  const resolved = resolveFontSizeLength(fsSpec.value, elementFontSizePx, remBasis, viewport);
  return typeof resolved === "number" && Number.isFinite(resolved) && resolved > 0 ? resolved : undefined;
}

/**
 * The winning `color` of a `::first-letter` or `::first-line` rule, as a
 * concrete sRGB color. Absent when the pseudo sets no color (the element's
 * own color is used). `inherit` is the same outcome, so it stores nothing.
 */
function pseudoColorOf(
  dom: DomTree,
  index: RuleIndex,
  node: NodeId,
  custom: CustomPropertyMap,
  layerOrder: readonly (readonly string[])[] | undefined,
  pseudo: IndexedPseudoElement,
): Color | undefined {
  const raw = winningPseudoValue(dom, index, node, layerOrder, pseudo, "color");
  if (raw === undefined) return undefined;
  const value = substituteVarInValue(raw, custom);
  if (value === null) return undefined;
  const keyword = value.trim().toLowerCase();
  if (keyword === "inherit" || keyword === "unset" || keyword === "revert") return undefined;
  const specified = parseSpecified("color", keyword === "initial" ? "black" : value);
  if (!specified.ok) return undefined;
  return asColor(specified.value);
}

/**
 * The winning `font-weight` of a `::first-letter` or `::first-line` rule, as a
 * number (100–900). `bold` is 700 and `normal` is 400. `inherit` stores
 * nothing, so the element's own weight is used.
 */
function pseudoFontWeightOf(
  dom: DomTree,
  index: RuleIndex,
  node: NodeId,
  custom: CustomPropertyMap,
  layerOrder: readonly (readonly string[])[] | undefined,
  pseudo: IndexedPseudoElement,
): number | undefined {
  const raw = winningPseudoValue(dom, index, node, layerOrder, pseudo, "font-weight");
  if (raw === undefined) return undefined;
  const value = substituteVarInValue(raw, custom);
  if (value === null) return undefined;
  const keyword = value.trim().toLowerCase();
  if (keyword === "inherit" || keyword === "unset" || keyword === "revert") return undefined;
  if (keyword === "bold" || keyword === "bolder") return 700;
  if (keyword === "normal" || keyword === "lighter" || keyword === "initial") return 400;
  const specified = parseSpecified("font-weight", value);
  if (!specified.ok || typeof specified.value !== "number" || !Number.isFinite(specified.value)) {
    return undefined;
  }
  return specified.value;
}

/**
 * The winning `font-style` of a `::first-letter` or `::first-line` rule.
 * `italic` and `oblique` are stored as those keywords. `normal` is stored too,
 * so it can override the other pseudo. `inherit` stores nothing.
 */
function pseudoFontStyleOf(
  dom: DomTree,
  index: RuleIndex,
  node: NodeId,
  custom: CustomPropertyMap,
  layerOrder: readonly (readonly string[])[] | undefined,
  pseudo: IndexedPseudoElement,
): "normal" | "italic" | "oblique" | undefined {
  const raw = winningPseudoValue(dom, index, node, layerOrder, pseudo, "font-style");
  if (raw === undefined) return undefined;
  const value = substituteVarInValue(raw, custom);
  if (value === null) return undefined;
  const keyword = value.trim().toLowerCase();
  if (keyword === "inherit" || keyword === "unset" || keyword === "revert") return undefined;
  if (keyword === "normal" || keyword === "initial") return "normal";
  if (keyword === "italic" || keyword === "oblique") return keyword;
  const specified = parseSpecified("font-style", value);
  if (!specified.ok) return undefined;
  if (specified.value === "normal" || specified.value === "italic" || specified.value === "oblique") {
    return specified.value;
  }
  return undefined;
}

/**
 * The winning `letter-spacing` of a pseudo, in px. `normal` is 0, which
 * overrides an inherited spacing. `em` resolves against `emBasis` (the
 * pseudo's font-size, or the element's when the pseudo does not set one).
 */
function pseudoLetterSpacingOf(
  dom: DomTree,
  index: RuleIndex,
  node: NodeId,
  emBasis: number,
  remBasis: number,
  viewport: Viewport,
  custom: CustomPropertyMap,
  layerOrder: readonly (readonly string[])[] | undefined,
  pseudo: IndexedPseudoElement,
): number | undefined {
  const raw = winningPseudoValue(dom, index, node, layerOrder, pseudo, "letter-spacing");
  if (raw === undefined) return undefined;
  const value = substituteVarInValue(raw, custom);
  if (value === null) return undefined;
  const keyword = value.trim().toLowerCase();
  if (keyword === "inherit" || keyword === "unset" || keyword === "revert") return undefined;
  if (keyword === "normal" || keyword === "initial") return 0;
  const specified = parseSpecified("letter-spacing", value);
  if (!specified.ok) return undefined;
  const resolved = resolveLengths(specified.value, emBasis, remBasis, viewport);
  return typeof resolved === "number" && Number.isFinite(resolved) ? resolved : undefined;
}

/** Same resolution as `letter-spacing`, for `word-spacing`. */
function pseudoWordSpacingOf(
  dom: DomTree,
  index: RuleIndex,
  node: NodeId,
  emBasis: number,
  remBasis: number,
  viewport: Viewport,
  custom: CustomPropertyMap,
  layerOrder: readonly (readonly string[])[] | undefined,
  pseudo: IndexedPseudoElement,
): number | undefined {
  const raw = winningPseudoValue(dom, index, node, layerOrder, pseudo, "word-spacing");
  if (raw === undefined) return undefined;
  const value = substituteVarInValue(raw, custom);
  if (value === null) return undefined;
  const keyword = value.trim().toLowerCase();
  if (keyword === "inherit" || keyword === "unset" || keyword === "revert") return undefined;
  if (keyword === "normal" || keyword === "initial") return 0;
  const specified = parseSpecified("word-spacing", value);
  if (!specified.ok) return undefined;
  const resolved = resolveLengths(specified.value, emBasis, remBasis, viewport);
  return typeof resolved === "number" && Number.isFinite(resolved) ? resolved : undefined;
}

type TextTransformKeyword = "uppercase" | "lowercase" | "capitalize";

function pseudoTextTransformOf(
  dom: DomTree,
  index: RuleIndex,
  node: NodeId,
  custom: CustomPropertyMap,
  layerOrder: readonly (readonly string[])[] | undefined,
  pseudo: IndexedPseudoElement,
): TextTransformKeyword | undefined {
  const raw = winningPseudoValue(dom, index, node, layerOrder, pseudo, "text-transform");
  if (raw === undefined) return undefined;
  const value = substituteVarInValue(raw, custom);
  if (value === null) return undefined;
  const keyword = value.trim().toLowerCase();
  if (keyword === "inherit" || keyword === "unset" || keyword === "revert" || keyword === "none" || keyword === "initial") {
    return undefined;
  }
  if (keyword === "uppercase" || keyword === "lowercase" || keyword === "capitalize") return keyword;
  return undefined;
}

/** Used line-box height in px. A unitless number multiplies the pseudo's font-size. */
function pseudoLineHeightOf(
  dom: DomTree,
  index: RuleIndex,
  node: NodeId,
  emBasis: number,
  remBasis: number,
  viewport: Viewport,
  custom: CustomPropertyMap,
  layerOrder: readonly (readonly string[])[] | undefined,
  pseudo: IndexedPseudoElement,
): number | undefined {
  const raw = winningPseudoValue(dom, index, node, layerOrder, pseudo, "line-height");
  if (raw === undefined) return undefined;
  const value = substituteVarInValue(raw, custom);
  if (value === null) return undefined;
  const keyword = value.trim().toLowerCase();
  if (keyword === "inherit" || keyword === "unset" || keyword === "revert" || keyword === "normal" || keyword === "initial") {
    return undefined;
  }
  if (/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(keyword)) {
    const n = Number(keyword);
    return Number.isFinite(n) && n > 0 ? n * emBasis : undefined;
  }
  const specified = parseSpecified("letter-spacing", value);
  if (!specified.ok) return undefined;
  const resolved = resolveLengths(specified.value, emBasis, remBasis, viewport);
  return typeof resolved === "number" && Number.isFinite(resolved) && resolved > 0 ? resolved : undefined;
}

function pseudoVerticalAlignOf(
  dom: DomTree,
  index: RuleIndex,
  node: NodeId,
  emBasis: number,
  remBasis: number,
  viewport: Viewport,
  custom: CustomPropertyMap,
  layerOrder: readonly (readonly string[])[] | undefined,
): string | undefined {
  const raw = winningPseudoValue(dom, index, node, layerOrder, "first-letter", "vertical-align");
  if (raw === undefined) return undefined;
  const value = substituteVarInValue(raw, custom);
  if (value === null) return undefined;
  const keyword = value.trim().toLowerCase();
  if (keyword === "inherit" || keyword === "unset" || keyword === "revert" || keyword === "baseline" || keyword === "initial") {
    return undefined;
  }
  if (
    keyword === "sub" || keyword === "super" || keyword === "middle" ||
    keyword === "top" || keyword === "bottom" || keyword === "text-top" || keyword === "text-bottom"
  ) {
    return keyword;
  }
  const specified = parseSpecified("letter-spacing", value);
  if (!specified.ok) return undefined;
  const resolved = resolveLengths(specified.value, emBasis, remBasis, viewport);
  return typeof resolved === "number" && Number.isFinite(resolved) ? `${resolved}px` : undefined;
}

function pseudoDecorationOf(
  dom: DomTree,
  index: RuleIndex,
  node: NodeId,
  custom: CustomPropertyMap,
  layerOrder: readonly (readonly string[])[] | undefined,
  pseudo: IndexedPseudoElement,
): { line: "underline" | "overline" | "line-through"; color?: Color } | undefined {
  const rules = matchPseudoRules(index, dom, node, pseudo);
  if (rules.length === 0) return undefined;
  let line: "underline" | "overline" | "line-through" | undefined;
  let color: Color | undefined;
  let seq = 0;
  let lineWinner: Candidate | undefined;
  let colorWinner: Candidate | undefined;
  for (const indexed of rules) {
    for (const decl of expandDeclarations(indexed.rule.declarations)) {
      const property = decl.property;
      const rawLine = property === "text-decoration-line" || property === "text-decoration";
      const rawColor = property === "text-decoration-color" || property === "text-decoration";
      if (!rawLine && !rawColor) continue;
      const candidate: Candidate = {
        value: decl.value,
        important: decl.important,
        origin: indexed.origin,
        layer: indexed.layer,
        specificity: indexed.rule.specificity,
        seq: seq++,
      };
      if (rawLine && (lineWinner === undefined || beats(candidate, lineWinner, layerOrder ?? []))) lineWinner = candidate;
      if (rawColor && (colorWinner === undefined || beats(candidate, colorWinner, layerOrder ?? []))) {
        colorWinner = candidate;
      }
    }
  }
  if (lineWinner !== undefined) {
    const value = (substituteVarInValue(lineWinner.value, custom) ?? "").toLowerCase();
    if (value.includes("line-through")) line = "line-through";
    else if (value.includes("overline")) line = "overline";
    else if (value.includes("underline")) line = "underline";
  }
  if (colorWinner !== undefined) {
    const value = substituteVarInValue(colorWinner.value, custom);
    if (value !== null) {
      const token = value.trim().split(/\s+/).find((part) => parseSpecified("color", part).ok);
      const specified = token === undefined ? { ok: false as const } : parseSpecified("color", token);
      if (specified.ok) color = asColor(specified.value);
    }
  }
  if (line === undefined) return undefined;
  return color === undefined ? { line } : { line, color };
}

/**
 * The winning `margin` or `padding` of `::first-letter`, in px per edge. A
 * later longhand overrides that edge of an earlier shorthand. `em` uses the
 * pseudo's font-size when that rule sets one. Absent when the pseudo sets none.
 */
function pseudoBoxEdgesOf(
  dom: DomTree,
  index: RuleIndex,
  node: NodeId,
  emBasis: number,
  remBasis: number,
  viewport: Viewport,
  custom: CustomPropertyMap,
  layerOrder: readonly (readonly string[])[] | undefined,
  kind: "margin" | "padding",
): { top: number; right: number; bottom: number; left: number } | undefined {
  const rules = matchPseudoRules(index, dom, node, "first-letter");
  if (rules.length === 0) return undefined;
  const edges = ["top", "right", "bottom", "left"] as const;
  const winners = new Map<(typeof edges)[number], Candidate & { property: string }>();
  let seq = 0;
  const considerEdge = (
    edge: (typeof edges)[number],
    property: string,
    indexed: IndexedRule,
    value: string,
    important: boolean,
  ): void => {
    const candidate = {
      value,
      important,
      origin: indexed.origin,
      layer: indexed.layer,
      specificity: indexed.rule.specificity,
      seq: seq++,
      property,
    };
    const current = winners.get(edge);
    if (current === undefined || beats(candidate, current, layerOrder ?? [])) {
      winners.set(edge, candidate);
    }
  };
  for (const indexed of rules) {
    for (const decl of expandDeclarations(indexed.rule.declarations)) {
      if (decl.property === kind) {
        for (const edge of edges) considerEdge(edge, kind, indexed, decl.value, decl.important);
      } else if (decl.property.startsWith(`${kind}-`)) {
        const edge = decl.property.slice(kind.length + 1);
        if (edge === "top" || edge === "right" || edge === "bottom" || edge === "left") {
          considerEdge(edge, decl.property, indexed, decl.value, decl.important);
        }
      }
    }
  }
  if (winners.size === 0) return undefined;
  const resolved = { top: 0, right: 0, bottom: 0, left: 0 };
  for (const edge of edges) {
    const winner = winners.get(edge);
    if (winner === undefined) continue;
    const value = substituteVarInValue(winner.value, custom);
    if (value === null) continue;
    if (winner.property === kind) {
      const specified = parseSpecified(kind, value);
      if (!specified.ok) continue;
      const quad = resolveLengths(specified.value, emBasis, remBasis, viewport);
      const picked = edgeOf(quad, edge);
      if (picked !== undefined) resolved[edge] = picked;
    } else {
      const specified = parseSpecified(winner.property, value);
      if (!specified.ok) continue;
      const one = resolveLengths(specified.value, emBasis, remBasis, viewport);
      if (typeof one === "number" && Number.isFinite(one)) resolved[edge] = one;
    }
  }
  return resolved;
}

type LetterBorderSide = {
  width: number;
  style: "none" | "solid" | "dashed" | "dotted" | "double";
  color: Color;
};

/**
 * The winning `border` of `::first-letter`. Shorthand `border` expands to the
 * per-edge longhands; a later longhand overrides that edge. `em` on a width
 * uses the pseudo's font-size. A `none`/`hidden` style takes no space.
 * Absent when the pseudo sets no border. Missing color falls back to the
 * element's color.
 */
function pseudoLetterBorderOf(
  dom: DomTree,
  index: RuleIndex,
  node: NodeId,
  emBasis: number,
  remBasis: number,
  viewport: Viewport,
  custom: CustomPropertyMap,
  layerOrder: readonly (readonly string[])[] | undefined,
  fallbackColor: Color,
): { top: LetterBorderSide; right: LetterBorderSide; bottom: LetterBorderSide; left: LetterBorderSide } | undefined {
  const rules = matchPseudoRules(index, dom, node, "first-letter");
  if (rules.length === 0) return undefined;
  const winners = new Map<string, Candidate>();
  let seq = 0;
  let saw = false;
  for (const indexed of rules) {
    for (const decl of expandDeclarations(indexed.rule.declarations)) {
      const match = /^border-(top|right|bottom|left)-(width|style|color)$/.exec(decl.property);
      if (match === null) continue;
      saw = true;
      const key = `${match[1]}:${match[2]}`;
      const candidate: Candidate = {
        value: decl.value,
        important: decl.important,
        origin: indexed.origin,
        layer: indexed.layer,
        specificity: indexed.rule.specificity,
        seq: seq++,
      };
      const current = winners.get(key);
      if (current === undefined || beats(candidate, current, layerOrder ?? [])) {
        winners.set(key, candidate);
      }
    }
  }
  if (!saw) return undefined;
  const side = (edge: "top" | "right" | "bottom" | "left"): LetterBorderSide => {
    const widthRaw = winners.get(`${edge}:width`);
    const styleRaw = winners.get(`${edge}:style`);
    const colorRaw = winners.get(`${edge}:color`);
    const style = borderStyleOf(styleRaw === undefined ? "none" : resolvedText(styleRaw, custom));
    let width = widthRaw === undefined ? (style === "none" ? 0 : 3) : borderWidthOf(widthRaw, custom, emBasis, remBasis, viewport);
    if (style === "none" || !(width > 0)) width = 0;
    const color = colorRaw === undefined ? fallbackColor : (borderColorOf(colorRaw, custom) ?? fallbackColor);
    return { width, style, color };
  };
  return { top: side("top"), right: side("right"), bottom: side("bottom"), left: side("left") };
}

function resolvedText(winner: Candidate, custom: CustomPropertyMap): string {
  return substituteVarInValue(winner.value, custom) ?? winner.value;
}

function borderStyleOf(value: string): LetterBorderSide["style"] {
  const keyword = value.trim().toLowerCase();
  if (keyword === "solid" || keyword === "dashed" || keyword === "dotted" || keyword === "double") return keyword;
  return "none";
}

function borderWidthOf(
  winner: Candidate,
  custom: CustomPropertyMap,
  emBasis: number,
  remBasis: number,
  viewport: Viewport,
): number {
  const value = resolvedText(winner, custom).trim().toLowerCase();
  if (value === "thin") return 1;
  if (value === "medium") return 3;
  if (value === "thick") return 5;
  const specified = parseSpecified("border-top-width", value);
  if (!specified.ok) return 0;
  const resolved = resolveLengths(specified.value, emBasis, remBasis, viewport);
  return typeof resolved === "number" && Number.isFinite(resolved) ? resolved : 0;
}

function borderColorOf(winner: Candidate, custom: CustomPropertyMap): Color | undefined {
  const value = resolvedText(winner, custom);
  const specified = parseSpecified("color", value);
  if (!specified.ok) return undefined;
  return asColor(specified.value);
}

function edgeOf(value: unknown, edge: "top" | "right" | "bottom" | "left"): number | undefined {
  if (typeof value !== "object" || value === null || !(edge in value)) return undefined;
  const n = (value as Record<string, unknown>)[edge];
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/**
 * The winning `background-color` of `::first-letter` or `::first-line`.
 * `background` shorthand expands, and a later `background-color` overrides it.
 * Transparent and the initial value store nothing. The element's own background
 * stays untouched.
 */
function pseudoBackgroundColorOf(
  dom: DomTree,
  index: RuleIndex,
  node: NodeId,
  custom: CustomPropertyMap,
  layerOrder: readonly (readonly string[])[] | undefined,
  pseudo: IndexedPseudoElement,
): Color | undefined {
  const raw = winningPseudoValue(dom, index, node, layerOrder, pseudo, "background-color");
  if (raw === undefined) return undefined;
  const value = substituteVarInValue(raw, custom);
  if (value === null) return undefined;
  const keyword = value.trim().toLowerCase();
  if (
    keyword === "inherit" ||
    keyword === "unset" ||
    keyword === "revert" ||
    keyword === "initial" ||
    keyword === "transparent"
  ) {
    return undefined;
  }
  const specified = parseSpecified("background-color", value);
  if (!specified.ok) return undefined;
  const color = asColor(specified.value);
  if (color === undefined || !(color.a > 0)) return undefined;
  return color;
}

/**
 * The winning background image of `::first-letter` or `::first-line`. The
 * shorthand expands to image, repeat, size, and position; a later
 * `background-image` overrides only the url. A value with no `url()` stores
 * nothing. The element's own image stays initial.
 */
function isPaintedBackgroundImage(image: string): boolean {
  const trimmed = image.trim();
  return (
    image.toLowerCase().includes("url(") ||
    /^linear-gradient\(/i.test(trimmed) ||
    /^radial-gradient\(/i.test(trimmed)
  );
}

function pseudoLetterImageOf(
  dom: DomTree,
  index: RuleIndex,
  node: NodeId,
  custom: CustomPropertyMap,
  layerOrder: readonly (readonly string[])[] | undefined,
  pseudo: IndexedPseudoElement,
): { image: string; repeat: string; size: string; position: string } | undefined {
  const rules = matchPseudoRules(index, dom, node, pseudo);
  if (rules.length === 0) return undefined;
  const winners = new Map<string, Candidate>();
  let seq = 0;
  for (const indexed of rules) {
    for (const decl of expandDeclarations(indexed.rule.declarations)) {
      if (
        decl.property !== "background-image" &&
        decl.property !== "background-repeat" &&
        decl.property !== "background-size" &&
        decl.property !== "background-position"
      ) {
        continue;
      }
      const candidate: Candidate = {
        value: decl.value,
        important: decl.important,
        origin: indexed.origin,
        layer: indexed.layer,
        specificity: indexed.rule.specificity,
        seq: seq++,
      };
      const current = winners.get(decl.property);
      if (current === undefined || beats(candidate, current, layerOrder ?? [])) {
        winners.set(decl.property, candidate);
      }
    }
  }
  const imageWinner = winners.get("background-image");
  if (imageWinner === undefined) return undefined;
  const image = substituteVarInValue(imageWinner.value, custom);
  if (image === null || !isPaintedBackgroundImage(image)) {
    return undefined;
  }
  const textOf = (property: string, fallback: string): string => {
    const winner = winners.get(property);
    if (winner === undefined) return fallback;
    return substituteVarInValue(winner.value, custom) ?? fallback;
  };
  return {
    image,
    repeat: textOf("background-repeat", "repeat"),
    size: textOf("background-size", "auto"),
    position: textOf("background-position", "0% 0%"),
  };
}

/** `::first-letter { float: left | right }`. `none` stores nothing. */
function pseudoFloatOf(
  dom: DomTree,
  index: RuleIndex,
  node: NodeId,
  custom: CustomPropertyMap,
  layerOrder: readonly (readonly string[])[] | undefined,
): "left" | "right" | undefined {
  const raw = winningPseudoValue(dom, index, node, layerOrder, "first-letter", "float");
  if (raw === undefined) return undefined;
  const value = substituteVarInValue(raw, custom);
  if (value === null) return undefined;
  const keyword = value.trim().toLowerCase();
  if (keyword === "left" || keyword === "right") return keyword;
  return undefined;
}

/** The winning raw value of one property among a pseudo-element's rules. */
function winningPseudoValue(
  dom: DomTree,
  index: RuleIndex,
  node: NodeId,
  layerOrder: readonly (readonly string[])[] | undefined,
  pseudo: IndexedPseudoElement,
  property: string,
): string | undefined {
  const rules = matchPseudoRules(index, dom, node, pseudo);
  if (rules.length === 0) return undefined;
  let winner: Candidate | undefined;
  let seq = 0;
  for (const indexed of rules) {
    for (const decl of expandDeclarations(indexed.rule.declarations)) {
      if (decl.property !== property) continue;
      const candidate: Candidate = {
        value: decl.value,
        important: decl.important,
        origin: indexed.origin,
        layer: indexed.layer,
        specificity: indexed.rule.specificity,
        seq: seq++,
      };
      if (winner === undefined || beats(candidate, winner, layerOrder ?? [])) {
        winner = candidate;
      }
    }
  }
  return winner?.value;
}

function asColor(value: unknown): Color | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const c = value as Record<string, unknown>;
  if (
    typeof c["r"] !== "number" ||
    typeof c["g"] !== "number" ||
    typeof c["b"] !== "number" ||
    typeof c["a"] !== "number"
  ) {
    return undefined;
  }
  return { r: c["r"], g: c["g"], b: c["b"], a: c["a"] };
}

/**
 * `font-size` is the one property whose `<percentage>` resolves at cascade
 * time — against the PARENT's font size (CSS Fonts 4 §4.1), which `resolveOne`
 * receives as its em basis. Everywhere else a `%` survives into used-value
 * resolution (against the containing block), so this wrapper is
 * font-size-only.
 */
function resolveFontSizeLength(value: unknown, emBasis: number, remBasis: number, viewport: Viewport): unknown {
  if (isSpecifiedLength(value) && value.unit === "%") {
    return px((value.value * emBasis) / 100);
  }
  return resolveLengths(value, emBasis, remBasis, viewport);
}

/** Resolve a single value that may or may not be a relative length or calc(). */
function maybeResolve(value: unknown, emBasis: number, remBasis: number, viewport: Viewport): unknown {
  if (isSpecifiedLength(value)) return resolveOne(value, emBasis, remBasis, viewport);
  if (isSpecifiedCalc(value)) return calcKeepsPercentage(value) ? value : resolveCalc(value, emBasis, remBasis, viewport);
  return value;
}

/** A calc that still contains a percentage cannot resolve without the containing block. */
function calcKeepsPercentage(value: SpecifiedCalc): boolean {
  const walk = (node: CalcNode): boolean => {
    switch (node.type) {
      case "len":
        return node.unit === "%";
      case "px":
      case "num":
        return false;
      default:
        return walk(node.left) || walk(node.right);
    }
  };
  return walk(value.ast);
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
    case "ex":
    case "ch":
      // Initial-font fallback when the face has no x-height or "0" width: 0.5em.
      return px(len.value * emBasis * 0.5);
    case "ic":
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
  options?: CascadeOptions,
): ComputedStyle {
  if (domNode === undefined || domNode.parent === null) {
    return INITIAL_STYLE;
  }
  return cascadeWithIndex(dom, index, domNode.parent, viewport, layerOrder, cache, undefined, options);
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

// ---------------------------------------------------------------------------
// CSS Logical (RFC 0025): flow-relative property names map onto physical
// property names using the element's own `writing-mode` + `direction`. The
// mapping happens at cascade level — `margin-block-start` and `margin-top`
// compete for the SAME slot in horizontal-tb, so the mapped candidate
// re-enters cascade ordering against any physical winner via `beats`.
// ---------------------------------------------------------------------------

type AxisEdge = "top" | "right" | "bottom" | "left";

interface FlowEdges {
  readonly blockStart: AxisEdge;
  readonly blockEnd: AxisEdge;
  readonly inlineStart: AxisEdge;
  readonly inlineEnd: AxisEdge;
  /** true when the block axis is vertical (writing-mode is vertical-*). */
  readonly vertical: boolean;
}

/**
 * The flow axes for (writing-mode, direction) — CSS Writing Modes §5.1/§7.
 * `sideways-*` share their `vertical-*` partner's edge map (the text
 * orientation difference is a paint concern, not a mapping concern).
 */
function flowEdges(wm: string, dir: "ltr" | "rtl"): FlowEdges {
  // `sideways-*` rotate a horizontal box 90°: `sideways-rl` CW keeps the
  // ltr inline flow top→bottom; `sideways-lr` CCW sends ltr text
  // bottom→top (and rtl top→bottom) — the inline axis INVERTS vs the
  // `vertical-*` partners.
  switch (wm) {
    case "vertical-rl":
    case "sideways-rl":
      return {
        blockStart: "right", blockEnd: "left",
        inlineStart: dir === "ltr" ? "top" : "bottom",
        inlineEnd: dir === "ltr" ? "bottom" : "top",
        vertical: true,
      };
    case "vertical-lr":
      return {
        blockStart: "left", blockEnd: "right",
        inlineStart: dir === "ltr" ? "top" : "bottom",
        inlineEnd: dir === "ltr" ? "bottom" : "top",
        vertical: true,
      };
    case "sideways-lr":
      return {
        blockStart: "left", blockEnd: "right",
        inlineStart: dir === "ltr" ? "bottom" : "top",
        inlineEnd: dir === "ltr" ? "top" : "bottom",
        vertical: true,
      };
    default: // horizontal-tb and anything unrecognized
      return {
        blockStart: "top", blockEnd: "bottom",
        inlineStart: dir === "ltr" ? "left" : "right",
        inlineEnd: dir === "ltr" ? "right" : "left",
        vertical: false,
      };
  }
}

/**
 * Resolve the element's `writing-mode`/`direction` BEFORE the main property
 * loop — logical declarations need the final axes to map against. Honors the
 * cascade-wide keywords and inheritance from the parent's computed style.
 */
function resolveFlowAxes(
  winners: ReadonlyMap<string, Candidate>,
  parentStyle: ComputedStyle,
): FlowEdges {
  const kw = (name: string, field: string, fallback: string): string => {
    const w = winners.get(name);
    if (w === undefined) {
      const inh = (parentStyle as unknown as Record<string, unknown>)[field];
      return typeof inh === "string" ? inh : fallback;
    }
    const v = w.value.trim().toLowerCase();
    if (v === "inherit" || v === "unset") {
      const inh = (parentStyle as unknown as Record<string, unknown>)[field];
      return typeof inh === "string" ? inh : fallback;
    }
    if (v === "initial" || v === "revert") return fallback;
    return v;
  };
  const wm = kw("writing-mode", "writingMode", "horizontal-tb");
  const dir = kw("direction", "direction", "ltr");
  return flowEdges(wm, dir === "rtl" ? "rtl" : "ltr");
}

/**
 * Logical longhand name → physical property name under `edges`, or undefined
 * for a name that needs no remap (horizontal-tb `ltr` still maps — e.g.
 * `margin-inline-start` → `margin-left` — the map is produced for every
 * mode so logical declarations always land on their physical slot).
 */
function logicalPropTargets(edges: FlowEdges): Map<string, string> {
  const m = new Map<string, string>();
  const edge = {
    "block-start": edges.blockStart,
    "block-end": edges.blockEnd,
    "inline-start": edges.inlineStart,
    "inline-end": edges.inlineEnd,
  } as const;
  for (const stem of ["margin", "padding"] as const) {
    for (const [logical, phys] of Object.entries(edge)) {
      m.set(`${stem}-${logical}`, `${stem}-${phys}`);
    }
  }
  // `inset-*` longhands map to the bare `top`/`right`/`bottom`/`left`.
  for (const [logical, phys] of Object.entries(edge)) {
    m.set(`inset-${logical}`, phys);
  }
  for (const [logical, phys] of Object.entries(edge)) {
    for (const suffix of ["width", "color", "style"] as const) {
      m.set(`border-${logical}-${suffix}`, `border-${phys}-${suffix}`);
    }
  }
  // Corner radii: a physical corner name is `<vertical>-<horizontal>`.
  const corner = (blockE: AxisEdge, inlineE: AxisEdge): string => {
    const vEdge = blockE === "top" || blockE === "bottom" ? blockE : inlineE;
    const hEdge = blockE === "top" || blockE === "bottom" ? inlineE : blockE;
    return `${vEdge}-${hEdge}`;
  };
  m.set("border-start-start-radius", `border-${corner(edges.blockStart, edges.inlineStart)}-radius`);
  m.set("border-start-end-radius", `border-${corner(edges.blockStart, edges.inlineEnd)}-radius`);
  m.set("border-end-start-radius", `border-${corner(edges.blockEnd, edges.inlineStart)}-radius`);
  m.set("border-end-end-radius", `border-${corner(edges.blockEnd, edges.inlineEnd)}-radius`);
  // Sizing: the block axis maps to physical height horizontally, width in
  // vertical writing modes; the inline axis is the opposite.
  m.set("block-size", edges.vertical ? "width" : "height");
  m.set("inline-size", edges.vertical ? "height" : "width");
  m.set("min-block-size", edges.vertical ? "min-width" : "min-height");
  m.set("min-inline-size", edges.vertical ? "min-height" : "min-width");
  m.set("max-block-size", edges.vertical ? "max-width" : "max-height");
  m.set("max-inline-size", edges.vertical ? "max-height" : "max-width");
  return m;
}

/**
 * Merge logical winners into their physical slots: a logical declaration and
 * a physical declaration compete under the normal cascade order (origin →
 * layer → specificity → source order), exactly as if the logical name had
 * been written as the physical one. The logical fields themselves still
 * compute (harmless — nothing reads them).
 */
function mapLogicalWinners(
  winners: ReadonlyMap<string, Candidate>,
  parentStyle: ComputedStyle,
  layerOrder: readonly (readonly string[])[] | undefined,
): ReadonlyMap<string, Candidate> {
  const targets = logicalPropTargets(resolveFlowAxes(winners, parentStyle));
  const out = new Map<string, Candidate>(winners);
  for (const [name, cand] of winners) {
    const phys = targets.get(name);
    if (phys === undefined) continue;
    const cur = out.get(phys);
    if (cur === undefined || beats(cand, cur, layerOrder ?? [])) {
      out.set(phys, cand);
    }
  }
  return out;
}

/**
 * Walk every matching rule's declarations and keep, per property, the winning
 * candidate under the cascade order (origin/importance → specificity → source
 * order). Phase 1 has a single origin (author), so importance (`!important`)
 * is the first discriminator (Req 11.2).
 */
/**
 * Optional gates a host can attach to the cascade (RFC 0027): CSP
 * `style-src`/`style-src-attr` decides whether an element's `style`
 * attribute contributes declarations — a blocked attribute keeps its DOM
 * text but is ignored for styling (exactly the spec's "blocked by CSP"
 * outcome).
 */
export interface CascadeOptions {
  readonly inlineStyleAllowed?: (node: DomNode) => boolean;
}

function selectWinners(
  dom: DomTree,
  index: RuleIndex,
  node: NodeId,
  domNode: DomNode | undefined,
  layerOrder?: readonly (readonly string[])[],
  extraRules?: readonly IndexedRule[],
  options?: CascadeOptions,
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
  const consider = (indexed: IndexedRule): void => {
    for (const decl of expandDeclarations(indexed.rule.declarations)) {
      const candidate: Candidate = {
        value: decl.value,
        important: decl.important,
        origin: indexed.origin,
        layer: indexed.layer,
        specificity: indexed.rule.specificity,
        seq: seq++,
      };
      const current = winners.get(decl.property);
      if (current === undefined || beats(candidate, current, layerOrder ?? [])) {
        winners.set(decl.property, candidate);
      }
    }
  };
  for (const indexed of matchRulesForIndexed(index, dom, node)) {
    consider(indexed);
  }
  // Shadow DOM `:host` extras (CSS Scoping §2.4): applied only to the host
  // element's top-level winners, ranked by the `shadow-host` origin.
  if (extraRules !== undefined) {
    for (const indexed of extraRules) consider(indexed);
  }

  const inlineAttr =
    options?.inlineStyleAllowed === undefined || options.inlineStyleAllowed(domNode)
      ? domNode.attrs?.get("style") ?? ""
      : "";
  for (const decl of expandDeclarations(inlineDeclarations(inlineAttr))) {
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
      case "author": return 5;
      case "user": return 6;
      case "ua": return 7;
      // Shadow DOM (CSS Scoping §2.4): for the HOST element, inner-tree
      // declarations lose — but for !important the encapsulation-context
      // order REVERSES, so shadow-host important beats outer important.
      case "shadow-host": return 8;
      case "inline": return 9;
    }
  }
  switch (origin) {
    case "ua": return 0;
    case "shadow-host": return 1;
    case "user": return 2;
    case "author": return 3;
    case "inline": return 4;
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
    // CSS-wide keywords are not in the property grammar. Keep them so the
    // cascade can resolve initial / inherit / unset / revert.
    const wide = value.toLowerCase();
    const cssWide =
      wide === "inherit" ||
      wide === "initial" ||
      wide === "unset" ||
      wide === "revert" ||
      wide === "revert-layer";
    if (!cssWide && !parseSpecified(property, value).ok) continue;
    decls.push({ property, value: cssWide ? wide : value, important });
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
