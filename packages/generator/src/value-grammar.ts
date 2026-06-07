/**
 * Declarative CSS value grammars (design.md §8.5, Requirement 6.1).
 *
 * A {@link ValueGrammar} is the *data* half of Platform-as-Data: each CSS
 * property in `css-properties.data.ts` declares how its value is parsed by
 * picking one of a small set of grammar shapes. The code generator
 * (`emit/css-codegen.ts`) reads these shapes to emit the per-property parsing
 * functions, and the runtime helpers (`value-runtime.ts`) implement the actual
 * parsing each shape maps to. Adding a property never requires hand-writing a
 * bespoke parser — only choosing (or, rarely, extending) a grammar shape.
 *
 * The Phase 1 subset (Requirement 14.2) only needs four shapes: enumerated
 * keywords, `<color>`, `<length>`, `<length>`-or-keyword, and a 1-to-4 edge
 * quad of `<length>` (the `margin` shorthand).
 */
import type { Px } from "@browser-engine/ir";

/**
 * A computed length that may instead be the keyword `auto` (e.g. `width`,
 * `height`). Kept here so both the runtime helpers and the generated
 * ComputedStyle field types can refer to one shared name.
 */
export type LengthOrAuto = Px | "auto";

/**
 * A min/max sizing value: a `<length>` or a sizing keyword (`auto` for min-*,
 * `none` for max-*). Shared so the sizing rows and the generated field types
 * name one type.
 */
export type LengthSizing = Px | "auto" | "none";

/**
 * A resolved CSS `transform`: a 2D affine matrix `[a, b, c, d, e, f]`, or the
 * keyword `none`. Defined here (NOT in the IR geometry module) so adding
 * `transform` as a data row introduces NO geometry into `ComputedStyle` — the
 * matrix is a plain number sextuple, a *style* value, never a `Rect`/`BoxGeometry`.
 */
export type TransformValue =
  | readonly [number, number, number, number, number, number]
  | "none";

/** Parse `value` as one of a fixed set of `keywords` (e.g. `display`). */
export interface KeywordGrammar {
  readonly kind: "keyword";
  readonly keywords: readonly string[];
}

/** Parse `value` as a `<color>` (named, hex, or `rgb()/rgba()`). */
export interface ColorGrammar {
  readonly kind: "color";
}

/** Parse `value` as a single `<length>` (Phase 1: `<number>px` or bare `0`). */
export interface LengthGrammar {
  readonly kind: "length";
}

/** Parse `value` as a `<length>` OR one of `keywords` (e.g. `width: auto`). */
export interface LengthOrKeywordGrammar {
  readonly kind: "length-or-keyword";
  readonly keywords: readonly string[];
}

/** Parse `value` as a 1-to-4 `<length>` quad expanded to four edges (`margin`). */
export interface EdgesGrammar {
  readonly kind: "edges";
  readonly of: "length";
}

/** Parse `value` as an `<integer>` (e.g. `z-index`, a grid track count). */
export interface IntegerGrammar {
  readonly kind: "integer";
  /** Optional inclusive lower bound the parsed integer is clamped to. */
  readonly min?: number;
  /** Optional inclusive upper bound the parsed integer is clamped to. */
  readonly max?: number;
}

/** Parse `value` as a `<number>` (e.g. `opacity`). */
export interface NumberGrammar {
  readonly kind: "number";
  /** Optional inclusive lower bound the parsed number is clamped to. */
  readonly min?: number;
  /** Optional inclusive upper bound the parsed number is clamped to. */
  readonly max?: number;
}

/** Parse `value` as a `<transform>` (`none` or `matrix(a,b,c,d,e,f)`). */
export interface TransformGrammar {
  readonly kind: "transform";
}

/**
 * Parse `value` as a free-form trimmed string (e.g. `font-family`, `content`,
 * `cursor` URLs). Any non-empty value parses; the canonical form is trimmed,
 * with collapsed internal whitespace. The broadest reusable shape — it unlocks
 * a whole class of string-valued properties with no new parser.
 */
export interface StringGrammar {
  readonly kind: "string";
}

/** The closed set of value grammars (Phase 1 subset + the layout/compositing shapes). */
export type ValueGrammar =
  | KeywordGrammar
  | ColorGrammar
  | LengthGrammar
  | LengthOrKeywordGrammar
  | EdgesGrammar
  | IntegerGrammar
  | NumberGrammar
  | TransformGrammar
  | StringGrammar;

// ---- ergonomic constructors for the data table ----------------------------

/** `keyword("block", "inline", …)` — an enumerated keyword grammar. */
export function keyword(...keywords: readonly string[]): KeywordGrammar {
  return { kind: "keyword", keywords };
}

/** `color()` — the `<color>` grammar. */
export function color(): ColorGrammar {
  return { kind: "color" };
}

/** `length()` — a single `<length>` grammar. */
export function length(): LengthGrammar {
  return { kind: "length" };
}

/** `lengthOr("auto")` — a `<length>` or one of the given keywords. */
export function lengthOr(...keywords: readonly string[]): LengthOrKeywordGrammar {
  return { kind: "length-or-keyword", keywords };
}

/** `edges()` — a 1-to-4 `<length>` quad (the shorthand expansion). */
export function edges(): EdgesGrammar {
  return { kind: "edges", of: "length" };
}

/** `integer({ min, max })` — an `<integer>` grammar, optionally clamped. */
export function integer(bounds: { readonly min?: number; readonly max?: number } = {}): IntegerGrammar {
  return { kind: "integer", ...bounds };
}

/** `number({ min, max })` — a `<number>` grammar, optionally clamped. */
export function number(bounds: { readonly min?: number; readonly max?: number } = {}): NumberGrammar {
  return { kind: "number", ...bounds };
}

/** `transform()` — the `<transform>` grammar (`none` or `matrix(...)`). */
export function transform(): TransformGrammar {
  return { kind: "transform" };
}

/** `string()` — a free-form trimmed string grammar (e.g. `font-family`). */
export function string(): StringGrammar {
  return { kind: "string" };
}
