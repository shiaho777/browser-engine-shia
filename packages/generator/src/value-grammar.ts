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
  | "none"
  /**
   * Well-formed transform functions that cannot collapse to a 2D matrix —
   * `translate(50%)`, `perspective(10em)`, `matrix3d(…)`. The specified text is
   * preserved so computed-style surfaces reify the component list (Typed OM)
   * instead of fabricating a wrong matrix.
   */
  | { readonly kind: "unresolved"; readonly text: string };

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

/** Parse `value` as a `<color>` OR one of `keywords` (e.g. `outline-color: invert`). */
export interface ColorOrKeywordGrammar {
  readonly kind: "color-or-keyword";
  readonly keywords: readonly string[];
}

/** Parse `value` as a 1-to-4 `<length>` quad expanded to four edges (`margin`). */
export interface EdgesGrammar {
  readonly kind: "edges";
  readonly of: "length";
}

/** Parse `value` as an `<integer>` OR one of `keywords` (e.g. `column-count: auto`). */
export interface IntegerOrKeywordGrammar {
  readonly kind: "integer-or-keyword";
  readonly keywords: readonly string[];
  /** Optional inclusive lower bound the parsed integer is clamped to. */
  readonly min?: number;
  /** Optional inclusive upper bound the parsed integer is clamped to. */
  readonly max?: number;
}

/** Parse `value` as an `<integer>` OR one of `keywords` (e.g. `column-count: auto`). */
export interface IntegerOrKeywordGrammar {
  readonly kind: "integer-or-keyword";
  readonly keywords: readonly string[];
  /** Optional inclusive lower bound the parsed integer is clamped to. */
  readonly min?: number;
  /** Optional inclusive upper bound the parsed integer is clamped to. */
  readonly max?: number;
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

/** Parse `value` as a `<time>` (`Ns`/`Nms`), stored as SECONDS (number). */
export interface TimeGrammar {
  readonly kind: "time";
  /** Optional inclusive lower bound the parsed time is clamped to. */
  readonly min?: number;
  /** Optional inclusive upper bound the parsed time is clamped to. */
  readonly max?: number;
}

/** Parse `value` as a comma-separated `<time>#` list, stored as SECONDS[]. */
export interface TimesGrammar {
  readonly kind: "times";
  readonly min?: number;
  readonly max?: number;
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

/**
 * Parse `value` as a `<display>` (css-display-3): a single keyword from the
 * outside/inside/internal/box/legacy sets, an `[ <display-outside> ||
 * <display-inside> ]` pair (either order), or a `<display-listitem>`
 * combination (`<display-outside>? && [ flow | flow-root ]? && list-item`).
 * Stored as normalized text — the multi-keyword space has no narrower shape.
 */
export interface DisplayGrammar {
  readonly kind: "display";
}

/**
 * Parse `value` as a `cursor` list (css-ui-4):
 * `[ [ <url> | <image> ] [ <number>{2} ]? ,]* <cursor-keyword>` — zero or
 * more image items with optional hotspot coordinates, ending in a mandatory
 * keyword. Stored as normalized text.
 */
export interface CursorGrammar {
  readonly kind: "cursor";
}

/** The closed set of value grammars (Phase 1 subset + the layout/compositing shapes). */
export type ValueGrammar =
  | KeywordGrammar
  | ColorGrammar
  | ColorOrKeywordGrammar
  | LengthGrammar
  | LengthOrKeywordGrammar
  | EdgesGrammar
  | IntegerGrammar
  | IntegerOrKeywordGrammar
  | NumberGrammar
  | TransformGrammar
  | TimeGrammar
  | TimesGrammar
  | StringGrammar
  | DisplayGrammar
  | CursorGrammar;

// ---- ergonomic constructors for the data table ----------------------------

/** `keyword("block", "inline", …)` — an enumerated keyword grammar. */
export function keyword(...keywords: readonly string[]): KeywordGrammar {
  return { kind: "keyword", keywords };
}

/** `color()` — the `<color>` grammar. */
export function color(): ColorGrammar {
  return { kind: "color" };
}

/** `colorOr("invert")` — a `<color>` or one of the given keywords. */
export function colorOr(...keywords: readonly string[]): ColorOrKeywordGrammar {
  return { kind: "color-or-keyword", keywords };
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

/** `integerOrKeyword(["auto"], { min })` — an `<integer>` or one of the given keywords. */
export function integerOrKeyword(
  keywords: readonly string[],
  bounds: { readonly min?: number; readonly max?: number } = {},
): IntegerOrKeywordGrammar {
  return { kind: "integer-or-keyword", keywords, ...bounds };
}

/** `number({ min, max })` — a `<number>` grammar, optionally clamped. */
export function number(bounds: { readonly min?: number; readonly max?: number } = {}): NumberGrammar {
  return { kind: "number", ...bounds };
}

/** `time({ min, max })` — a `<time>` grammar (seconds as number), optionally clamped. */
export function time(bounds: { readonly min?: number; readonly max?: number } = {}): TimeGrammar {
  return { kind: "time", ...bounds };
}

/** `times({ min, max })` — a `<time>#` list grammar (seconds[]), optionally clamped. */
export function times(bounds: { readonly min?: number; readonly max?: number } = {}): TimesGrammar {
  return { kind: "times", ...bounds };
}

/** `transform()` — the `<transform>` grammar (`none` or `matrix(...)`). */
export function transform(): TransformGrammar {
  return { kind: "transform" };
}

/** `string()` — a free-form trimmed string grammar (e.g. `font-family`). */
export function string(): StringGrammar {
  return { kind: "string" };
}

/** `display()` — the multi-keyword `<display>` grammar. */
export function display(): DisplayGrammar {
  return { kind: "display" };
}

/** `cursor()` — the `<cursor>` image-list + keyword grammar. */
export function cursor(): CursorGrammar {
  return { kind: "cursor" };
}

// The unresolved-length specified forms are part of the value vocabulary a
// `tsType` may name (e.g. imported rows whose initial keeps a percentage), so
// the computed-style-fields emitter can import them through this module.
export type { SpecifiedCalc, SpecifiedLength } from "./value-runtime.js";
