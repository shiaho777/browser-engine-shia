/**
 * Stage 2 IR: StyleSheet (design.md §6).
 *
 * Output of the CSS parser. Immutable, branded `"StyleSheet"`.
 *
 * `SelectorList`, `Declaration`, and `Specificity` are defined here as the
 * minimal, fully-`readonly` shapes the boundary needs in Phase 0. Richer
 * grammar (combinators, pseudo-classes, typed values) is layered on by the CSS
 * parser / generator in later phases without changing this nominal boundary.
 */
import type { Branded } from "./brand.js";

/**
 * CSS specificity as the `[a, b, c]` triple used for cascade tie-breaking
 * (a = id, b = class/attr/pseudo-class, c = type/pseudo-element).
 */
export type Specificity = readonly [a: number, b: number, c: number];

/** A single simple/compound selector in its serialized form. */
export interface Selector {
  readonly text: string;
}

/** One or more comma-separated selectors that share a declaration block. */
export type SelectorList = readonly Selector[];

/** A single `property: value` declaration. */
export interface Declaration {
  readonly property: string;
  readonly value: string;
  readonly important: boolean;
}

/** A single style rule: selectors + declarations + cascade metadata. */
export interface StyleRule {
  readonly selector: SelectorList;
  readonly declarations: readonly Declaration[];
  readonly specificity: Specificity;
  /** source order, for tie-break */
  readonly order: number;
  /**
   * The cascade layer path this rule belongs to (e.g. `["theme", "buttons"]`
   * for a rule inside `@layer theme { @layer buttons { ... } }`). `undefined`
   * means the rule is UNLAYERED (higher cascade precedence than any layered
   * rule). CSS Cascading 5 §7.
   */
  readonly layer?: readonly string[] | undefined;
}

/** The parsed stylesheet. Nominally branded. */
export type StyleSheet = Branded<
  {
    readonly rules: readonly StyleRule[];
    /**
     * The cascade layer declaration order for this sheet — an array of layer
     * paths. Layers declared earlier have LOWER cascade precedence (CSS
     * Cascading 5 §7.3). `undefined` when no `@layer` declarations are present.
     */
    readonly layerOrder?: readonly (readonly string[])[] | undefined;
  },
  "StyleSheet"
>;
