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
import { CSS_PROPERTIES, PROPERTY_PARSERS, isSpecifiedLength, isSpecifiedCalc, expandDeclarations, parseLength } from "@browser-engine/generator";
import type { ComputeCtx, SpecifiedLength, SpecifiedCalc, CalcNode } from "@browser-engine/generator";

import { buildRuleIndex, collectCandidates, classListOf, ruleMatches, type InteractionState } from "./rule-index.js";
import type { RuleIndex, CascadeOrigin, IndexedRule } from "./rule-index.js";
import type { StyleRule } from "@browser-engine/ir";
import { collectCustomProperties, substituteVars } from "./var-substitution.js";
import type { CustomPropertyMap } from "./var-substitution.js";

/**
 * A Symbol key used to store the resolved custom property map on a
 * ComputedStyle object. Using a Symbol (not a string key) ensures it does NOT
 * appear in `Object.keys()` — the cascade's field-set invariant (every key is
 * a data-table field) is preserved. The value is inherited by child nodes.
 */
const CUSTOM_PROPS: unique symbol = Symbol("__custom__");

/** Read a node's resolved custom properties (`--*` → substituted text). */
export function customPropertiesOf(style: unknown): CustomPropertyMap | undefined {
  return (style as Record<symbol, unknown> | null | undefined)?.[CUSTOM_PROPS] as CustomPropertyMap | undefined;
}

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
  selectorParses,
} from "./rule-index.js";
export type { RuleIndex, IndexedRule, SupportedPseudoClass, CascadeOrigin, InteractionState } from "./rule-index.js";

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
/** Index cache: the same sheets array reuses the built RuleIndex (and the
 * sharing cache it keys), so repeated cascade() calls with one stylesheet
 * both save the index build and actually HIT the sharing cache. */
const indexCache = new WeakMap<readonly StyleSheet[], RuleIndex>();

export function cascade(
  dom: DomTree,
  sheets: readonly StyleSheet[],
  node: NodeId,
  viewport: Viewport = DEFAULT_VIEWPORT,
  origins?: readonly CascadeOrigin[],
  layerOrder?: readonly (readonly string[])[],
  interaction?: InteractionState,
): ComputedStyle {
  let index = indexCache.get(sheets);
  if (index === undefined) {
    index = buildRuleIndex(sheets, origins, layerOrder);
    indexCache.set(sheets, index);
  }
  return cascadeWithIndex(dom, index, node, viewport, layerOrder, undefined, interaction);
}

export function createComputedStyleResolver(
  dom: DomTree,
  sheets: readonly StyleSheet[],
  viewport: Viewport = DEFAULT_VIEWPORT,
  origins?: readonly CascadeOrigin[],
  layerOrder?: readonly (readonly string[])[],
  interaction?: InteractionState,
): (node: NodeId) => ComputedStyle {
  return createComputedStyleResolverWithCache(dom, sheets, viewport, origins, layerOrder, undefined, interaction).styleOf;
}

/**
 * Resolver + its per-node cache exposed. Callers that re-cascade the SAME
 * unchanged DOM across renders (pure repaints, settle frames) can pass the
 * previous cache back in and skip the cascade for every node entirely.
 * Only reuse a cache when the DOM and sheets are verbatim unchanged —
 * there is no per-node invalidation here.
 */
export function createComputedStyleResolverWithCache(
  dom: DomTree,
  sheets: readonly StyleSheet[],
  viewport: Viewport = DEFAULT_VIEWPORT,
  origins?: readonly CascadeOrigin[],
  layerOrder?: readonly (readonly string[])[],
  previousCache?: Map<NodeId, ComputedStyle>,
  interaction?: InteractionState,
): { readonly styleOf: (node: NodeId) => ComputedStyle; readonly cache: Map<NodeId, ComputedStyle> } {
  const index = buildRuleIndex(sheets, origins, layerOrder);
  const cache = previousCache ?? new Map<NodeId, ComputedStyle>();
  const styleOf = (node: NodeId): ComputedStyle => cascadeWithIndex(dom, index, node, viewport, layerOrder, cache, interaction);
  return { styleOf, cache };
}

export function cascadeWithRuleIndex(
  dom: DomTree,
  index: RuleIndex,
  node: NodeId,
  viewport: Viewport = DEFAULT_VIEWPORT,
  layerOrder?: readonly (readonly string[])[],
  cache?: Map<NodeId, ComputedStyle>,
  interaction?: InteractionState,
  shadow?: ShadowCascadeContext,
): ComputedStyle {
  return cascadeWithIndex(dom, index, node, viewport, layerOrder, cache, interaction, shadow);
}

/**
 * Shadow-DOM host styling channel (CSS Scoping §4): when `node` is a shadow
 * HOST, `:host`-subject rules from its shadow scope also apply — at the LOWEST
 * cascade precedence (outer-tree declarations always beat `:host` rules).
 */
export interface ShadowCascadeContext {
  /** The shadow-root id when `node` hosts a shadow tree, else null. */
  readonly hostRootOf: (node: NodeId) => NodeId | null;
  /** The host element id for a shadow root, else null. */
  readonly hostOf: (rootId: NodeId) => NodeId | null;
  /** The sheets applicable inside a shadow root's scope. */
  readonly sheetsOf: (rootId: NodeId) => readonly StyleSheet[];
  /**
   * A node's computed style in its OWN tree scope — used when inheritance hops
   * the shadow boundary (the host lives in the outer scope, whose rule index
   * differs from the shadow child's).
   */
  readonly computedOf?: (node: NodeId) => ComputedStyle;
}

function cascadeWithIndex(
  dom: DomTree,
  index: RuleIndex,
  node: NodeId,
  viewport: Viewport,
  layerOrder?: readonly (readonly string[])[],
  cache?: Map<NodeId, ComputedStyle>,
  interaction?: InteractionState,
  shadow?: ShadowCascadeContext,
): ComputedStyle {
  if (cache !== undefined) {
    const hit = cache.get(node);
    if (hit !== undefined) return hit;
  }
  const domNode = dom.nodes.get(node);
  const parentStyle = resolveParentStyle(dom, index, domNode, viewport, layerOrder, cache, interaction, shadow);

  // 1) Collect the declarations of every rule matching this node, in document
  //    order (a stable per-declaration sequence drives the source-order
  //    tie-break across all sheets — design.md §8.1). `hostRules` carries the
  //    `:host`-subject rules of the node's own shadow scope (CSS Scoping §4).
  const hostScope = shadow !== undefined ? collectHostRules(dom, node, shadow, interaction) : null;
  const hostRules = hostScope?.matches ?? [];
  const winners = selectWinners(dom, index, node, domNode, layerOrder, interaction, hostRules);

  // ---- F2: STYLE SHARING lookup --------------------------------------------
  // Two elements with the same tag + classes + matched-rule sequence + the
  // same inheritable parent fields compute IDENTICAL styles. The first miss
  // computes and stores; every subsequent element with the same signature
  // REUSES the frozen style object (a Tailwind-class O(1) path).
  const element = domNode?.kind === "element" ? domNode : undefined;
  const canShare = element !== undefined && winners.size > 0;
  let shareKey = "";
  if (canShare) {
    const classes = [...classListOf(element)].sort();
    // The matched rule ORDER sequence uniquely determines the cascade result —
    // NOT the winners' per-call `seq` counters (those differ per node).
    const matched = matchRulesMemoized(index, dom, node, element, interaction);
    const ruleSeq = matched.map((m) => m.order).join(",");
    // The INLINE style is part of the cascade input: two elements matching the
    // same rules with different inline styles compute different results, so it
    // MUST be in the share key (the class-only key would wrongly share them).
    const inlineStyle = element.attrs?.get("style") ?? "";
    // `:host` matches are part of the cascade input but live OUTSIDE the rule
    // index — without them in the key, a shadow host would share styles with a
    // same-signature non-host element (or with a host matching different
    // `:host(...)` conditions).
    const hostKey = hostScope === null || hostScope.rootId === null
      ? ""
      : `|h${hostScope.rootId}:${hostRules.map((h) => h.id).join("+")}`;
    shareKey = `${element.tag ?? ""}|${classes.join(" ")}|${ruleSeq}|${inlineStyle}|${interaction !== undefined ? "i" : "n"}${hostKey}`;
    const shareMap = styleShareCache.get(index);
    if (shareMap !== undefined) {
      const shared = shareMap.get(shareKey);
      if (shared !== undefined && shared.parentKey === parentShareKey(parentStyle)) {
        styleShareHits += 1;
        if (cache !== undefined) cache.set(node, shared.style);
        return shared.style;
      }
    }
    styleShareMisses += 1;
  }

  const frozen = finishCompute(winners, parentStyle, viewport);
  if (cache !== undefined) cache.set(node, frozen);

  // F2: store into the sharing cache (the NEXT element with this signature
  // reuses this frozen style object).
  if (canShare && shareKey !== "") {
    let shareMap = styleShareCache.get(index);
    if (shareMap === undefined) {
      shareMap = new Map();
      styleShareCache.set(index, shareMap);
    }
    shareMap.set(shareKey, { parentKey: parentShareKey(parentStyle), style: frozen });
  }
  return frozen;
}
/**
 * `winners`+`parentStyle` → frozen ComputedStyle — the second half of the
 * cascade shared by {@link cascadeWithIndex} (element styles) and
 * {@link cascadePseudo} (pseudo-element styles): custom-property merge, the
 * font-size pre-pass, and the per-property declared→computed loop.
 */
function finishCompute(
  winners: ReadonlyMap<string, Candidate>,
  parentStyle: ComputedStyle,
  viewport: Viewport,
): ComputedStyle {
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
      if (typeof resolved === "number") {
        fontSizePx = resolved;
      } else if (
        typeof resolved === "object" &&
        resolved !== null &&
        "kind" in resolved &&
        (resolved as { kind?: unknown }).kind === "specified-length" &&
        (resolved as { unit?: unknown }).unit === "%"
      ) {
        // CSS Fonts §4: a percentage font-size is relative to the PARENT's
        // font size (`font-size: 100%` = inherit, `80%` = 0.8 × parent) — NOT
        // the containing-block width that `resolveOne`'s generic % path defers
        // to. Resolve it here so the computed fontSize is always a px number.
        const pct = (resolved as { value?: unknown }).value;
        if (typeof pct === "number" && Number.isFinite(pct)) {
          fontSizePx = (parentFontSizePx * pct) / 100;
        }
      }
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
        // `font-size` stores the ALREADY-RESOLVED px value computed above (its
        // em basis is the PARENT's font size, and its % form resolves against
        // the parent too — CSS Fonts §4), never a raw specified-length object.
        if (prop.name === "font-size") {
          result[prop.field] = fontSizePx;
          continue;
        }
        // `line-height` is a free-form grammar that accepts <number>, <length>,
        // and <percentage> beside `normal` (CSS 2.1 §10.8). Normalize the
        // numeric forms here so the computed value carries real units: bare
        // numbers stay numbers, %/em resolve against the element's OWN font
        // size (unlike every other property, line-height % uses the computed
        // font-size of the element itself).
        if (prop.name === "line-height" && typeof specified.value === "string") {
          const v = specified.value.trim().toLowerCase();
          if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(v)) {
            result[prop.field] = v;
            continue;
          }
          // Lengths, percentages and calc() resolve to px against the
          // element's OWN font-size; a pure-number calc() keeps <number>
          // semantics (`calc(2 + 3)` computes to `5`, not `5px`).
          const pl = parseLength(v);
          if (pl.ok) {
            const lv = pl.value;
            if (v.startsWith("calc(") && !/[a-z%]/i.test(v.slice(5, -1))) {
              // Dimensionless calc → <number> result.
              const n = typeof lv === "number" ? lv
                : isSpecifiedCalc(lv) ? resolveCalc(lv, fontSizePx, remBasis, viewport, fontSizePx) : 0;
              result[prop.field] = String(typeof n === "number" ? n : 0);
              continue;
            }
            if (typeof lv === "number") {
              result[prop.field] = lv;
              continue;
            }
            if (isSpecifiedLength(lv)) {
              if (lv.unit === "%") {
                result[prop.field] = px((fontSizePx * lv.value) / 100);
                continue;
              }
              result[prop.field] = resolveOne(lv, fontSizePx, remBasis, viewport);
              continue;
            }
            result[prop.field] = resolveCalc(lv, fontSizePx, remBasis, viewport, fontSizePx);
            continue;
          }
        }
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

  return deepFreeze(result as unknown as ComputedStyle);
}

/**
 * Pseudo-element computed style — `getComputedStyle(el, "::before")` (CSSOM
 * §6.1). Pseudo-elements are not DOM nodes: their declarations come from rules
 * whose selector's LAST compound carries a matching `::name`/`:name` suffix and
 * whose element-part selector matches the originating node. The pseudo's own
 * declarations cascade among themselves (origin → importance → specificity →
 * source order); every other property inherits from the ELEMENT's computed
 * style — the originating element is the pseudo's inheritance parent.
 */
export function cascadePseudo(
  dom: DomTree,
  sheets: readonly StyleSheet[],
  node: NodeId,
  pseudo: string,
  viewport: Viewport = DEFAULT_VIEWPORT,
  origins?: readonly CascadeOrigin[],
  layerOrder?: readonly (readonly string[])[],
  interaction?: InteractionState,
): ComputedStyle {
  let index = indexCache.get(sheets);
  if (index === undefined) {
    index = buildRuleIndex(sheets, origins, layerOrder);
    indexCache.set(sheets, index);
  }
  const parentStyle = cascadeWithIndex(dom, index, node, viewport, layerOrder, new Map(), interaction);
  const winners = new Map<string, Candidate>();
  const lower = pseudo.toLowerCase();
  let seq = 0;
  for (let s = 0; s < sheets.length; s += 1) {
    const sheet = sheets[s];
    if (sheet === undefined) continue;
    const origin = origins?.[s] ?? "author";
    for (const rule of sheet.rules) {
      let matched = false;
      for (const sel of rule.selector) {
        const t = sel.text.replace(/\s+$/, "");
        const m = /(::?)([a-zA-Z][\w-]*)$/.exec(t);
        if (m === null || (m[2] as string).toLowerCase() !== lower) continue;
        const elemText = t.slice(0, m.index).trimEnd() || "*";
        const probe = { ...rule, selector: [{ text: elemText }] } as unknown as StyleRule;
        if (ruleMatches(probe, dom, node, interaction)) {
          matched = true;
          break;
        }
      }
      if (!matched) continue;
      for (const decl of expandDeclarations(rule.declarations)) {
        const candidate: Candidate = {
          value: decl.value,
          important: decl.important,
          origin,
          layer: rule.layer,
          // A pseudo-element contributes one "type" slot to specificity
          // (Selectors 4 §17) — relative order among pseudo rules is preserved.
          specificity: [rule.specificity[0], rule.specificity[1], rule.specificity[2] + 1],
          seq: seq++,
        };
        const current = winners.get(decl.property);
        if (current === undefined || beats(candidate, current, layerOrder ?? [])) {
          winners.set(decl.property, candidate);
        }
      }
    }
  }
  const style = finishCompute(winners, parentStyle, viewport);
  // CSS Display 3 §2.7 blockification: a pseudo-element box inside a flex/grid
  // container (or one that is floated / absolutely positioned) has its
  // inline-level display blockified. `contents`/`none` survive untouched.
  const rec = style as unknown as Record<string, unknown>;
  const display = rec["display"];
  const position = rec["position"];
  const float = rec["float"];
  const parentDisplay = (parentStyle as unknown as Record<string, unknown>)["display"];
  const needsBlockify =
    parentDisplay === "flex" || parentDisplay === "inline-flex" ||
    parentDisplay === "grid" || parentDisplay === "inline-grid" ||
    position === "absolute" || position === "fixed" ||
    float === "left" || float === "right";
  const BLOCKIFY: Readonly<Record<string, string>> = {
    "inline": "block",
    "inline-block": "block",
    "inline-flex": "flex",
    "inline-grid": "grid",
    "inline-table": "table",
    "table-row-group": "table",
    "table-header-group": "table",
    "table-footer-group": "table",
    "table-row": "table",
    "table-cell": "table",
    "table-caption": "table",
    "table-column-group": "table",
    "table-column": "table",
    "list-item": "block",
  };
  if (!needsBlockify || typeof display !== "string") return style;
  const next = BLOCKIFY[display];
  if (next === undefined) return style;
  return deepFreeze({ ...rec, display: next }) as unknown as ComputedStyle;
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
 * Resolve a {@link SpecifiedCalc} (a `calc()` AST) against the em/rem/viewport
 * context, then fold the arithmetic. Evaluation tracks THREE channels —
 * dimensionless `num`, absolute `px`, and unresolved `pct` — so percentages
 * survive to the computed value (CSS Values 4: `calc(0% + 0%)` computes to
 * `0%`, not `0px`). A mixed px+% result serializes back to a `calc()` string
 * for the Typed OM to reify. Division by zero yields 0 (defensive — the spec
 * says the declaration is invalid, but we already validated at parse time).
 */
function resolveCalc(
  calc: SpecifiedCalc,
  emBasis: number,
  remBasis: number,
  viewport: Viewport,
  pctBasis?: number,
): Px | SpecifiedLength | string {
  // `pct` is nullable: null = no percentage anywhere, 0 is a REAL zero-percent
  // (presence matters — `calc(0% + 0%)` computes to `0%`, not `0px`). When
  // `pctBasis` is provided (line-height resolves % against its own font-size),
  // percentages resolve to px instead of surviving.
  type Ev = { num: number; px: number; pct: number | null };
  const scalar = (e: Ev): boolean => e.px === 0 && e.pct === null;
  const scale = (e: Ev, f: number): Ev => ({ num: e.num * f, px: e.px * f, pct: e.pct === null ? null : e.pct * f });
  const combine = (a: number | null, b: number | null, s: 1 | -1): number | null =>
    a === null ? (b === null ? null : s * b) : b === null ? a : a + s * b;
  const evalNode = (node: CalcNode): Ev => {
    switch (node.type) {
      case "px":
        return { num: 0, px: node.value, pct: null };
      case "num":
        return { num: node.value, px: 0, pct: null };
      case "len": {
        if (node.unit === "%" && pctBasis !== undefined) {
          return { num: 0, px: (node.value * pctBasis) / 100, pct: null };
        }
        const r = resolveOne({ kind: "specified-length", value: node.value, unit: node.unit }, emBasis, remBasis, viewport);
        if (typeof r === "number") return { num: 0, px: r, pct: null };
        if (r !== undefined && r.unit === "%") return { num: 0, px: 0, pct: r.value };
        return { num: 0, px: 0, pct: null };
      }
      case "add":
      case "sub": {
        const a = evalNode(node.left);
        const b = evalNode(node.right);
        const s = node.type === "add" ? 1 : -1;
        return { num: a.num + s * b.num, px: a.px + s * b.px, pct: combine(a.pct, b.pct, s) };
      }
      case "mul": {
        const a = evalNode(node.left);
        const b = evalNode(node.right);
        if (scalar(a)) return scale(b, a.num);
        if (scalar(b)) return scale(a, b.num);
        return { num: 0, px: 0, pct: null };
      }
      case "div": {
        const a = evalNode(node.left);
        const b = evalNode(node.right);
        if (b.num === 0) return { num: 0, px: 0, pct: null };
        if (scalar(a)) return { num: a.num / b.num, px: 0, pct: null };
        if (scalar(b)) return scale(a, 1 / b.num);
        return { num: 0, px: 0, pct: null };
      }
    }
  };
  const ev = evalNode(calc.ast);
  if (ev.pct !== null && ev.px === 0 && ev.num === 0) {
    return { kind: "specified-length", value: ev.pct, unit: "%" };
  }
  if (ev.pct !== null) {
    const pctPart = ev.pct >= 0 ? `+ ${ev.pct}%` : `- ${-ev.pct}%`;
    return `calc(${ev.px + ev.num}px ${pctPart})`;
  }
  return px(ev.px + ev.num);
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
  interaction?: InteractionState,
  shadow?: ShadowCascadeContext,
): ComputedStyle {
  if (domNode === undefined || domNode.parent === null) {
    return INITIAL_STYLE;
  }
  // Flat-tree inheritance (CSS Scoping §3.4): a shadow child's inheriting
  // parent is the shadow HOST, not the shadow-root node.
  let parent = domNode.parent;
  const parentNode = dom.nodes.get(parent);
  // Document boundary: children of an iframe's nested document root inherit
  // from NOTHING (they're a new document's tree, not the iframe element's).
  if (parentNode?.kind === "element" && parentNode.tag === "#iframe-document") {
    return INITIAL_STYLE;
  }
  if (parentNode?.kind === "element" && parentNode.tag === "#shadow-root") {
    const host = shadow?.hostOf(parent) ?? null;
    if (host === null) return INITIAL_STYLE;
    // The host lives in the OUTER scope — its rules aren't in this index —
    // so its computed style must come through the query layer, not a
    // same-index recursion.
    if (shadow?.computedOf !== undefined) return shadow.computedOf(host);
    parent = host;
  }
  return cascadeWithIndex(dom, index, parent, viewport, layerOrder, cache, interaction, shadow);
}

// ---------------------------------------------------------------------------
// Cascade sort — winning declaration per property.
// ---------------------------------------------------------------------------

/** A candidate declaration with the metadata the cascade order compares. */
interface Candidate {
  readonly value: string;
  readonly important: boolean;
  /** The cascade origin of this declaration (ua/user/author/inline/shadow). */
  readonly origin: CascadeOrigin | "inline" | "shadow";
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
// Structural-pattern detector for the match memo: rules whose selectors
// depend on tree position (:nth-*, :first-/:last-/:only-*, sibling
// combinators) can match differently for two nodes with identical tag +
// class list, so they must bypass the memo. WeakMap keeps it O(1) per rule
// across renders.
// Only plain tag/class/descendant selectors are memo-safe. Anything else —
// pseudo-classes (:hover, :nth…), attribute ([data-x]), ID (#x — binds the
// rule to ONE node), or sibling combinators (+, ~) — can differ between two
// nodes sharing tag + class list, so those rules bypass the memo.
const STRUCTURAL_PATTERN = /[:[#]|\s[+~]\s|[+~](?=[\s.[:a-zA-Z])/;
const structurallySafe = new WeakMap<StyleRule, boolean>();

function ruleIsStructurallySafe(rule: StyleRule): boolean {
  const hit = structurallySafe.get(rule);
  if (hit !== undefined) return hit;
  let safe = true;
  for (const selector of rule.selector) {
    if (STRUCTURAL_PATTERN.test(selector.text)) {
      safe = false;
      break;
    }
  }
  structurallySafe.set(rule, safe);
  return safe;
}

// Match memo: sites like video grids render hundreds of cards with the SAME
// tag + class list; each one re-ran full selector verification over its
// candidate bucket. Keying by tag + sorted classes collapses them to one
// match. Cached per RuleIndex (WeakMap) so a rebuilt index never sees stale
// entries.
interface MemoEntry {
  readonly safe: readonly IndexedRule[];
  readonly unsafe: readonly IndexedRule[];
}
const matchMemo = new WeakMap<RuleIndex, Map<string, MemoEntry>>();

// ---------------------------------------------------------------------------
// F2 — STYLE SHARING cache (Ladybird `StyleComputer` `m_style_sharing_cache`).
//
// When two elements have the SAME cascade inputs (same tag, same sorted class
// list, same matching rule ORDER sequence, same interaction pseudoclass state,
// and the SAME parent computed style), their computed styles are IDENTICAL —
// so the second (and every subsequent) element can REUSE the first's frozen
// ComputedStyle object. Tailwind-class utility pages put thousands of
// elements through one class set: this turns O(N × properties) into O(1) per
// shared element after the first computes.
//
// The cache keys on the FULL cascade signature (a stable string of tag +
// classes + the matched rules' order sequence); the parent style identity is
// checked by deep equality on a cheap projection (the fields the cascade
// inherits FROM — a mismatch parent invalidates the share). Cached per
// RuleIndex (WeakMap) so a rebuilt index never sees stale entries.
// ---------------------------------------------------------------------------

/** A cheap inheritable-fields projection of a parent style for sharing keys. */
function parentShareKey(style: ComputedStyle): string {
  // The fields children inherit: font, color, text, writing direction, and
  // the interaction pseudo-classes. A stable JSON of just these is enough to
  // differentiate parents for sharing purposes.
  return JSON.stringify([
    style["color"],
    style["fontSize"],
    style["fontStyle"],
    style["fontWeight"],
    style["lineHeight"],
    style["textAlign"],
    style["textTransform"],
    style["letterSpacing"],
    style["wordSpacing"],
    style["whiteSpace"],
    style["direction"],
    style["visibility"],
  ]);
}

/** The style-sharing cache entry: signature → computed style. */
interface StyleShareEntry {
  readonly parentKey: string;
  readonly style: ComputedStyle;
}

/** The per-RuleIndex style-sharing cache (WeakMap so rebuilds are fresh). */
const styleShareCache = new WeakMap<RuleIndex, Map<string, StyleShareEntry>>();

/** Statistics: how many times a style was REUSED (a share hit). */
let styleShareHits = 0;
/** Statistics: how many times a style was COMPUTED (a share miss). */
let styleShareMisses = 0;

/** The current style-sharing statistics (for evidence reporting). */
export function styleSharingStats(): { hits: number; misses: number } {
  return { hits: styleShareHits, misses: styleShareMisses };
}

function matchRulesMemoized(
  index: RuleIndex,
  dom: DomTree,
  node: NodeId,
  domNode: DomNode,
  interaction: InteractionState | undefined,
): readonly IndexedRule[] {
  let memo = matchMemo.get(index);
  if (memo === undefined) {
    memo = new Map();
    matchMemo.set(index, memo);
  }
  const classes = [...classListOf(domNode)].sort();
  const key = `${domNode.tag ?? ""}|${classes.join(" ")}`;
  const hit = memo.get(key);
  const candidates = collectCandidates(index, dom, node);
  const safe: IndexedRule[] = [];
  const unsafe: IndexedRule[] = [];
  const fromMemo = new Set<number>();
  if (hit !== undefined) {
    for (const indexed of hit.safe) {
      safe.push(indexed);
      fromMemo.add(indexed.order);
    }
  }
  const matched: IndexedRule[] = [];
  for (const candidate of candidates) {
    if (hit !== undefined && fromMemo.has(candidate.order)) {
      matched.push(candidate); // reuse memo verdict (order-sorted below)
      continue;
    }
    if (ruleMatches(candidate.rule, dom, node, interaction)) {
      matched.push(candidate);
      if (ruleIsStructurallySafe(candidate.rule)) safe.push(candidate);
      else unsafe.push(candidate);
    }
  }
  if (hit === undefined) {
    memo.set(key, { safe, unsafe });
  }
  matched.sort((a, b) => a.order - b.order);
  return matched;
}

function selectWinners(
  dom: DomTree,
  index: RuleIndex,
  node: NodeId,
  domNode: DomNode | undefined,
  layerOrder?: readonly (readonly string[])[],
  interaction?: InteractionState,
  hostRules: readonly { rule: StyleRule; id: string }[] = [],
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
  for (const indexed of matchRulesMemoized(index, dom, node, domNode, interaction)) {
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

  // `:host` rules from the node's OWN shadow scope (CSS Scoping §4): the host
  // element is in the DOCUMENT scope but its shadow tree's `:host` rules still
  // target it — always at the lowest precedence (outer tree wins).
  for (const hm of hostRules) {
    for (const decl of expandDeclarations(hm.rule.declarations)) {
      const candidate: Candidate = {
        value: decl.value,
        important: decl.important,
        origin: "shadow",
        layer: hm.rule.layer,
        specificity: hm.rule.specificity,
        seq: seq++,
      };
      const current = winners.get(decl.property);
      if (current === undefined || beats(candidate, current, layerOrder ?? [])) {
        winners.set(decl.property, candidate);
      }
    }
  }

  return winners;
}

/**
 * The `:host`-subject rules of a node's own shadow scope that match it. Returns
 * the shadow root id plus the matched rules tagged with a stable position id —
 * the id list feeds the style-sharing key so two hosts under different shadow
 * trees (or matching different `:host(...)` conditions) never share a style.
 */
export function collectHostRules(
  dom: DomTree,
  node: NodeId,
  shadow: ShadowCascadeContext,
  interaction?: InteractionState,
): { rootId: NodeId | null; matches: readonly { rule: StyleRule; id: string }[] } {
  const rootId = shadow.hostRootOf(node);
  if (rootId === null) return { rootId: null, matches: [] };
  const matches: { rule: StyleRule; id: string }[] = [];
  const sheets = shadow.sheetsOf(rootId);
  for (let si = 0; si < sheets.length; si++) {
    const rules = sheets[si]!.rules;
    for (let ri = 0; ri < rules.length; ri++) {
      const rule = rules[ri]!;
      for (const sel of rule.selector) {
        const t = sel.text.trim();
        const m = /:host(?:\(([^()]*)\))?\s*$/.exec(t);
        if (m === null) continue;
        const before = t.slice(0, m.index);
        // `:host` must be in the SUBJECT compound — a combinator before it
        // means the selector targets a deeper element, not the host.
        if (/[\s>+~]/.test(before) || before.endsWith(",")) continue;
        const arg = (m[1] ?? "").trim();
        const constraint = `${before}${arg}` !== "" ? `${before}${arg}` : "*";
        const probe = {
          selector: [{ text: constraint }],
          declarations: [],
          specificity: rule.specificity,
          order: 0,
        } as unknown as StyleRule;
        if (ruleMatches(probe, dom, node, interaction)) {
          // The declaration text is part of the identity: `replaceSync` swaps
          // rule contents in place, so position alone would alias old/new
          // declarations in the style-sharing cache.
          const fp = rule.declarations
            .map((d) => `${d.property}:${d.value}${d.important ? "!" : ""}`)
            .join(";");
          matches.push({ rule, id: `${si}.${ri}(${fp})` });
          break;
        }
      }
    }
  }
  return { rootId, matches };
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
function cascadeRank(origin: CascadeOrigin | "inline" | "shadow", important: boolean): number {
  // "shadow" = `:host` rules applied from an element's OWN shadow scope: they
  // rank below every outer-tree declaration (CSS Scoping §4.1 — the document
  // always wins over the shadow tree when styling the host).
  if (important) {
    switch (origin) {
      case "shadow": return -1;
      case "author": return 4;
      case "user": return 5;
      case "ua": return 6;
      case "inline": return 7;
    }
  }
  switch (origin) {
    case "shadow": return -1;
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
    // Custom properties accept ANY token stream verbatim — no grammar check.
    // var()/env()-bearing values are substitution-pending: the token stream
    // is valid until substituted at computed-value time.
    if (
      !property.startsWith("--") &&
      !/\b(?:var|env)\(/.test(value) &&
      !parseSpecified(property, value).ok
    ) continue;
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
