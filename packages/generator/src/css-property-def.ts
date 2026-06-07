/**
 * The shape of one row in the CSS property data table (design.md §8.5,
 * Requirement 6.1).
 *
 * A {@link CssPropertyDef} is fully declarative *data* (plus one `computeValue`
 * algorithm). It is the single source of truth from which the code generator
 * derives, for every property and with zero hand-written per-property
 * boilerplate (Requirements 6.2, 6.5):
 *   - the parser function (from `syntax`),
 *   - the initial-value table entry (from `initial`),
 *   - the inheritance table entry (from `inherited`),
 *   - the ComputedStyle field type (from `tsType`).
 *
 * `Specified` is the type a value has right after parsing; `Computed` is its
 * type after `computeValue` resolves it against the parent style and context.
 * For Phase 1 most properties are already computed at parse time, so the two
 * usually coincide.
 */
import type { ComputedStyle } from "@browser-engine/ir";
import type { ValueGrammar } from "./value-grammar.js";

/**
 * Context passed to `computeValue` (e.g. the root font size for `em`
 * resolution in later phases). Phase 1 keeps it minimal but present, so the
 * `computeValue` signature is already its final shape (no churn when later
 * properties need context).
 */
export interface ComputeCtx {
  /** The document root font size in px, for relative-length resolution. */
  readonly rootFontSize: number;
}

/**
 * How a property animates (Requirement 6.1). Carried as data now; consumed by
 * the animation system in a later phase. Present from day one so the data
 * table's shape never has to change to add it.
 */
export type AnimationType = "discrete" | "by-computed-value" | "none";

/**
 * One declarative CSS property definition. `Specified`/`Computed` default to
 * `unknown` so the heterogeneous `CSS_PROPERTIES` array can hold rows of
 * differing value types behind one element type.
 */
export interface CssPropertyDef<Specified = unknown, Computed = unknown> {
  /** The CSS property name as it appears in a declaration, e.g. `"color"`. */
  readonly name: string;
  /** Whether the property inherits when a node has no declaration for it. */
  readonly inherited: boolean;
  /** The property's initial (computed) value. */
  readonly initial: Computed;
  /** The declarative parsing grammar (drives generated parser emission). */
  readonly syntax: ValueGrammar;
  /**
   * Resolve a specified value to a computed value against the parent style and
   * context. Pure; called once per element per property by the cascade
   * (task 3.4). For most Phase 1 properties this is the identity.
   */
  readonly computeValue: (
    specified: Specified,
    parent: ComputedStyle,
    ctx: ComputeCtx,
  ) => Computed;
  /** How the property animates (carried as data; Requirement 6.1). */
  readonly animationType: AnimationType;
  /**
   * The TypeScript type of this property's field on `ComputedStyle`, as a
   * source string the generator emits verbatim (e.g. `"Color"`, `"Px"`,
   * `"Edges<Px>"`). It must name a type exported by `@browser-engine/ir` or by
   * the generator's value modules; the generated field-types file imports it.
   */
  readonly tsType: string;
  /**
   * The camelCase field name used on `ComputedStyle` (e.g. `background-color`
   * → `backgroundColor`). Defaults to {@link name} when the property name is
   * already a single identifier-safe token.
   */
  readonly field: string;
}

/**
 * Convenience constructor that fills the camelCase `field` from `name` when not
 * given, so a data row only spells `field` out for multi-word properties.
 */
export function defineProperty<Specified, Computed>(
  def: Omit<CssPropertyDef<Specified, Computed>, "field"> & { readonly field?: string },
): CssPropertyDef<Specified, Computed> {
  const { field, ...rest } = def;
  return { ...rest, field: field ?? toCamelCase(def.name) };
}

/** Convert a hyphenated CSS property name to a camelCase identifier. */
export function toCamelCase(name: string): string {
  return name.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
}
