/**
 * css-properties.data.ts — the declarative CSS property data table
 * (design.md §4.2, §8.5; Requirement 6.1, 14.2).
 *
 * This file is the *data* in "Platform-as-Data". Every Phase 1 CSS property is
 * one row of pure declarative metadata plus its `computeValue` algorithm. The
 * code generator (`emit/css-codegen.ts`) reads `CSS_PROPERTIES` and emits, with
 * NO hand-written per-property boilerplate (Requirements 6.2, 6.5):
 *   - the parser (one function per `syntax`),
 *   - the initial-value table (from each `initial`),
 *   - the inheritance table (from each `inherited`),
 *   - the ComputedStyle field types (from each `tsType`).
 *
 * Adding a CSS property = adding one row here + its `computeValue`. Nothing
 * else is hand-written (proven by `add-property.test.ts`, Requirement 6.5).
 *
 * Phase 1 subset (Requirement 14.2): color, display, width, height, margin,
 * background-color, font-size.
 */
import { px, type Color, type DisplayValue, type Edges, type Px } from "@browser-engine/ir";
import type { FlexDirection, FloatValue, PositionValue } from "@browser-engine/ir";
import { defineProperty, type CssPropertyDef } from "./css-property-def.js";
import { color, edges, integer, keyword, length, lengthOr, number, string as stringValue, transform } from "./value-grammar.js";
import type { LengthOrAuto, LengthSizing, TransformValue } from "./value-grammar.js";

// ---- shared initial-value constants ---------------------------------------

const BLACK: Color = { r: 0, g: 0, b: 0, a: 1 };
const TRANSPARENT: Color = { r: 0, g: 0, b: 0, a: 0 };
const ZERO_EDGES: Edges<Px> = { top: px(0), right: px(0), bottom: px(0), left: px(0) };

/** The display outer/inner keywords supported in Phase 1 and beyond. */
const DISPLAY_KEYWORDS: readonly DisplayValue[] = [
  "block",
  "inline",
  "inline-block",
  "flex",
  "grid",
  "table",
  "none",
];

// ---- the rows --------------------------------------------------------------

/** `color` — inherited; the foreground/text color (initial: black). */
const COLOR: CssPropertyDef<Color, Color> = defineProperty<Color, Color>({
  name: "color",
  inherited: true,
  initial: BLACK,
  syntax: color(),
  computeValue: (specified) => specified,
  animationType: "by-computed-value",
  tsType: "Color",
});

/** `display` — not inherited; the box's display type (initial: inline). */
const DISPLAY: CssPropertyDef<DisplayValue, DisplayValue> = defineProperty<
  DisplayValue,
  DisplayValue
>({
  name: "display",
  inherited: false,
  initial: "inline",
  syntax: keyword(...DISPLAY_KEYWORDS),
  computeValue: (specified) => specified,
  animationType: "discrete",
  tsType: "DisplayValue",
});

/** `width` — not inherited; a `<length>` or `auto` (initial: auto). */
const WIDTH: CssPropertyDef<LengthOrAuto, LengthOrAuto> = defineProperty<
  LengthOrAuto,
  LengthOrAuto
>({
  name: "width",
  inherited: false,
  initial: "auto",
  syntax: lengthOr("auto"),
  computeValue: (specified) => specified,
  animationType: "by-computed-value",
  tsType: "LengthOrAuto",
});

/** `height` — not inherited; a `<length>` or `auto` (initial: auto). */
const HEIGHT: CssPropertyDef<LengthOrAuto, LengthOrAuto> = defineProperty<
  LengthOrAuto,
  LengthOrAuto
>({
  name: "height",
  inherited: false,
  initial: "auto",
  syntax: lengthOr("auto"),
  computeValue: (specified) => specified,
  animationType: "by-computed-value",
  tsType: "LengthOrAuto",
});

/** `margin` — not inherited; a 1-to-4 `<length>` quad (initial: 0 all edges). */
const MARGIN: CssPropertyDef<Edges<Px>, Edges<Px>> = defineProperty<Edges<Px>, Edges<Px>>({
  name: "margin",
  inherited: false,
  initial: ZERO_EDGES,
  syntax: edges(),
  computeValue: (specified) => specified,
  animationType: "by-computed-value",
  tsType: "Edges<Px>",
});

/** `background-color` — not inherited; a `<color>` (initial: transparent). */
const BACKGROUND_COLOR: CssPropertyDef<Color, Color> = defineProperty<Color, Color>({
  name: "background-color",
  inherited: false,
  initial: TRANSPARENT,
  syntax: color(),
  computeValue: (specified) => specified,
  animationType: "by-computed-value",
  tsType: "Color",
  // field defaults to "backgroundColor" via toCamelCase.
});

/** `font-size` — inherited; a `<length>` in px (initial: 16px medium). */
const FONT_SIZE: CssPropertyDef<Px, Px> = defineProperty<Px, Px>({
  name: "font-size",
  inherited: true,
  initial: px(16),
  syntax: length(),
  computeValue: (specified) => specified,
  animationType: "by-computed-value",
  tsType: "Px",
});

// ---------------------------------------------------------------------------
// Layout properties (platform-as-data-layout spec, Requirement 1.1). Each is a
// single declarative row reusing an existing or new grammar shape — no new
// per-property parsing/initial/inheritance/field code (the whole point).
// ---------------------------------------------------------------------------

/** `position` — not inherited; the positioning scheme (initial: static). */
const POSITION: CssPropertyDef<PositionValue, PositionValue> = defineProperty<
  PositionValue,
  PositionValue
>({
  name: "position",
  inherited: false,
  initial: "static",
  syntax: keyword("static", "relative", "absolute", "fixed", "sticky"),
  computeValue: (specified) => specified,
  animationType: "discrete",
  tsType: "PositionValue",
});

/** `float` — not inherited; the float scheme (initial: none). */
const FLOAT: CssPropertyDef<FloatValue, FloatValue> = defineProperty<FloatValue, FloatValue>({
  name: "float",
  inherited: false,
  initial: "none",
  syntax: keyword("none", "left", "right"),
  computeValue: (specified) => specified,
  animationType: "discrete",
  tsType: "FloatValue",
});

/** `top` — not inherited; a `<length>` or `auto` inset (initial: auto). */
const TOP: CssPropertyDef<LengthOrAuto, LengthOrAuto> = defineProperty<LengthOrAuto, LengthOrAuto>({
  name: "top",
  inherited: false,
  initial: "auto",
  syntax: lengthOr("auto"),
  computeValue: (specified) => specified,
  animationType: "by-computed-value",
  tsType: "LengthOrAuto",
});

/** `right` — not inherited; a `<length>` or `auto` inset (initial: auto). */
const RIGHT: CssPropertyDef<LengthOrAuto, LengthOrAuto> = defineProperty<LengthOrAuto, LengthOrAuto>({
  name: "right",
  inherited: false,
  initial: "auto",
  syntax: lengthOr("auto"),
  computeValue: (specified) => specified,
  animationType: "by-computed-value",
  tsType: "LengthOrAuto",
});

/** `bottom` — not inherited; a `<length>` or `auto` inset (initial: auto). */
const BOTTOM: CssPropertyDef<LengthOrAuto, LengthOrAuto> = defineProperty<LengthOrAuto, LengthOrAuto>({
  name: "bottom",
  inherited: false,
  initial: "auto",
  syntax: lengthOr("auto"),
  computeValue: (specified) => specified,
  animationType: "by-computed-value",
  tsType: "LengthOrAuto",
});

/** `left` — not inherited; a `<length>` or `auto` inset (initial: auto). */
const LEFT: CssPropertyDef<LengthOrAuto, LengthOrAuto> = defineProperty<LengthOrAuto, LengthOrAuto>({
  name: "left",
  inherited: false,
  initial: "auto",
  syntax: lengthOr("auto"),
  computeValue: (specified) => specified,
  animationType: "by-computed-value",
  tsType: "LengthOrAuto",
});

/** `flex-direction` — not inherited; the flex main axis (initial: row). */
const FLEX_DIRECTION: CssPropertyDef<FlexDirection, FlexDirection> = defineProperty<
  FlexDirection,
  FlexDirection
>({
  name: "flex-direction",
  inherited: false,
  initial: "row",
  syntax: keyword("row", "row-reverse", "column", "column-reverse"),
  computeValue: (specified) => specified,
  animationType: "discrete",
  tsType: "FlexDirection",
  // field defaults to "flexDirection" via toCamelCase.
});

/**
 * `grid-template-columns` — not inherited; modelled minimally as a positive
 * integer track count (initial: 0, which the layout engine reads as a single
 * column). A genuine track-list grammar is a later mechanism-level extension;
 * the integer shape suffices for the engine's current grid branch.
 */
const GRID_TEMPLATE_COLUMNS: CssPropertyDef<number, number> = defineProperty<number, number>({
  name: "grid-template-columns",
  inherited: false,
  initial: 0,
  syntax: integer({ min: 0 }),
  computeValue: (specified) => specified,
  animationType: "discrete",
  tsType: "number",
  // field defaults to "gridTemplateColumns" via toCamelCase.
});

// ---------------------------------------------------------------------------
// Compositing properties (platform-as-data-layout spec, Requirement 1.2).
// ---------------------------------------------------------------------------

/** `opacity` — not inherited; a `<number>` clamped to 0..1 (initial: 1). */
const OPACITY: CssPropertyDef<number, number> = defineProperty<number, number>({
  name: "opacity",
  inherited: false,
  initial: 1,
  syntax: number({ min: 0, max: 1 }),
  computeValue: (specified) => specified,
  animationType: "by-computed-value",
  tsType: "number",
});

/** `transform` — not inherited; `none` or a `matrix(...)` (initial: none). */
const TRANSFORM: CssPropertyDef<TransformValue, TransformValue> = defineProperty<
  TransformValue,
  TransformValue
>({
  name: "transform",
  inherited: false,
  initial: "none",
  syntax: transform(),
  computeValue: (specified) => specified,
  animationType: "discrete",
  tsType: "TransformValue",
});

/**
 * `z-index` — not inherited; an `<integer>` stacking level (initial: 0, which
 * the paint engine reads as `auto`). Reuses the integer shape.
 */
const Z_INDEX: CssPropertyDef<number, number> = defineProperty<number, number>({
  name: "z-index",
  inherited: false,
  initial: 0,
  syntax: integer(),
  computeValue: (specified) => specified,
  animationType: "discrete",
  tsType: "number",
  // field defaults to "zIndex" via toCamelCase.
});

// ===========================================================================
// Breadth expansion (compat / CSS-coverage battle). Each property below is a
// single declarative row reusing an EXISTING grammar shape — zero new parser,
// initial, inheritance, or field code. This is Platform-as-Data closing the
// coverage gap one row at a time: CSS-property count and real pass count both
// rise while the hand-written surface barely moves.
// ===========================================================================

// ---- box model: padding + per-edge margin/padding longhands ---------------

/** `padding` — not inherited; a 1-to-4 `<length>` quad (initial: 0). */
const PADDING: CssPropertyDef<Edges<Px>, Edges<Px>> = defineProperty<Edges<Px>, Edges<Px>>({
  name: "padding",
  inherited: false,
  initial: ZERO_EDGES,
  syntax: edges(),
  computeValue: (s) => s,
  animationType: "by-computed-value",
  tsType: "Edges<Px>",
});

/** Build a per-edge `<length>` longhand row (margin-top, padding-left, …). */
function edgeLength(name: string): CssPropertyDef<Px, Px> {
  return defineProperty<Px, Px>({
    name,
    inherited: false,
    initial: px(0),
    syntax: length(),
    computeValue: (s) => s,
    animationType: "by-computed-value",
    tsType: "Px",
  });
}

const MARGIN_TOP = edgeLength("margin-top");
const MARGIN_RIGHT = edgeLength("margin-right");
const MARGIN_BOTTOM = edgeLength("margin-bottom");
const MARGIN_LEFT = edgeLength("margin-left");
const PADDING_TOP = edgeLength("padding-top");
const PADDING_RIGHT = edgeLength("padding-right");
const PADDING_BOTTOM = edgeLength("padding-bottom");
const PADDING_LEFT = edgeLength("padding-left");

/** Build a `<length>`-or-`auto`/`none` sizing row (min/max width/height). */
function sizing(name: string, keywordValue: "auto" | "none"): CssPropertyDef<LengthSizing, LengthSizing> {
  return defineProperty<LengthSizing, LengthSizing>({
    name,
    inherited: false,
    initial: keywordValue,
    syntax: lengthOr(keywordValue),
    computeValue: (s) => s,
    animationType: "by-computed-value",
    tsType: "LengthSizing",
  });
}

const MIN_WIDTH = sizing("min-width", "auto");
const MIN_HEIGHT = sizing("min-height", "auto");
const MAX_WIDTH = sizing("max-width", "none");
const MAX_HEIGHT = sizing("max-height", "none");

// ---- borders --------------------------------------------------------------

/** `border-width` — not inherited; a 1-to-4 `<length>` quad (initial: 0). */
const BORDER_WIDTH: CssPropertyDef<Edges<Px>, Edges<Px>> = defineProperty<Edges<Px>, Edges<Px>>({
  name: "border-width",
  inherited: false,
  initial: ZERO_EDGES,
  syntax: edges(),
  computeValue: (s) => s,
  animationType: "by-computed-value",
  tsType: "Edges<Px>",
});

/** `border-color` — not inherited; a `<color>` (initial: black, currentcolor-ish). */
const BORDER_COLOR: CssPropertyDef<Color, Color> = defineProperty<Color, Color>({
  name: "border-color",
  inherited: false,
  initial: BLACK,
  syntax: color(),
  computeValue: (s) => s,
  animationType: "by-computed-value",
  tsType: "Color",
});

/** The CSS line-style keywords shared by border-style / outline-style. */
const LINE_STYLE_KEYWORDS = [
  "none", "hidden", "dotted", "dashed", "solid", "double", "groove", "ridge", "inset", "outset",
] as const;

/** `border-style` — not inherited; a line-style keyword (initial: none). */
const BORDER_STYLE: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "border-style",
  inherited: false,
  initial: "none",
  syntax: keyword(...LINE_STYLE_KEYWORDS),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "string",
});

/** `border-radius` — not inherited; a `<length>` (initial: 0). */
const BORDER_RADIUS: CssPropertyDef<Px, Px> = defineProperty<Px, Px>({
  name: "border-radius",
  inherited: false,
  initial: px(0),
  syntax: length(),
  computeValue: (s) => s,
  animationType: "by-computed-value",
  tsType: "Px",
});

// ---- backgrounds + visual -------------------------------------------------

/** `background-image` — not inherited; a free-form value (initial: none). */
const BACKGROUND_IMAGE: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "background-image",
  inherited: false,
  initial: "none",
  syntax: stringValue(),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "string",
});

/** `background-repeat` — not inherited; a keyword (initial: repeat). */
const BACKGROUND_REPEAT: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "background-repeat",
  inherited: false,
  initial: "repeat",
  syntax: keyword("repeat", "repeat-x", "repeat-y", "no-repeat", "space", "round"),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "string",
});

/** `background-position` — not inherited; a free-form value (initial: 0% 0%). */
const BACKGROUND_POSITION: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "background-position",
  inherited: false,
  initial: "0% 0%",
  syntax: stringValue(),
  computeValue: (s) => s,
  animationType: "by-computed-value",
  tsType: "string",
});

/** `box-sizing` — not inherited; a keyword (initial: content-box). */
const BOX_SIZING: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "box-sizing",
  inherited: false,
  initial: "content-box",
  syntax: keyword("content-box", "border-box"),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "string",
});

/** `visibility` — inherited; a keyword (initial: visible). */
const VISIBILITY: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "visibility",
  inherited: true,
  initial: "visible",
  syntax: keyword("visible", "hidden", "collapse"),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "string",
});

/** `overflow` — not inherited; a keyword (initial: visible). */
const OVERFLOW: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "overflow",
  inherited: false,
  initial: "visible",
  syntax: keyword("visible", "hidden", "clip", "scroll", "auto"),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "string",
});

/** `cursor` — inherited; a keyword subset (initial: auto). */
const CURSOR: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "cursor",
  inherited: true,
  initial: "auto",
  syntax: keyword("auto", "default", "pointer", "text", "move", "not-allowed", "grab", "grabbing", "wait", "help", "crosshair"),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "string",
});

// ---- typography (mostly inherited) ----------------------------------------

/** `font-family` — inherited; a free-form family list (initial: sans-serif). */
const FONT_FAMILY: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "font-family",
  inherited: true,
  initial: "sans-serif",
  syntax: stringValue(),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "string",
});

/** `font-weight` — inherited; an `<integer>` 1..1000 (initial: 400). */
const FONT_WEIGHT: CssPropertyDef<number, number> = defineProperty<number, number>({
  name: "font-weight",
  inherited: true,
  initial: 400,
  syntax: integer({ min: 1, max: 1000 }),
  computeValue: (s) => s,
  animationType: "by-computed-value",
  tsType: "number",
});

/** `font-style` — inherited; a keyword (initial: normal). */
const FONT_STYLE: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "font-style",
  inherited: true,
  initial: "normal",
  syntax: keyword("normal", "italic", "oblique"),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "string",
});

/** `line-height` — inherited; a `<number>` multiplier (initial: 1.0 normal,
 * matching the metrics shaper's one-em line box; a declared value scales it). */
const LINE_HEIGHT: CssPropertyDef<number, number> = defineProperty<number, number>({
  name: "line-height",
  inherited: true,
  initial: 1.0,
  syntax: number({ min: 0 }),
  computeValue: (s) => s,
  animationType: "by-computed-value",
  tsType: "number",
});

/** `text-align` — inherited; a keyword (initial: start). */
const TEXT_ALIGN: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "text-align",
  inherited: true,
  initial: "start",
  syntax: keyword("start", "end", "left", "right", "center", "justify"),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "string",
});

/** `text-decoration-line` — not inherited; a keyword (initial: none). */
const TEXT_DECORATION_LINE: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "text-decoration-line",
  inherited: false,
  initial: "none",
  syntax: keyword("none", "underline", "overline", "line-through"),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "string",
});

/** `text-transform` — inherited; a keyword (initial: none). */
const TEXT_TRANSFORM: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "text-transform",
  inherited: true,
  initial: "none",
  syntax: keyword("none", "capitalize", "uppercase", "lowercase"),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "string",
});

/** `white-space` — inherited; a keyword (initial: normal). */
const WHITE_SPACE: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "white-space",
  inherited: true,
  initial: "normal",
  syntax: keyword("normal", "nowrap", "pre", "pre-wrap", "pre-line", "break-spaces"),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "string",
});

/** `letter-spacing` — inherited; a `<length>` (initial: 0 normal). */
const LETTER_SPACING: CssPropertyDef<Px, Px> = defineProperty<Px, Px>({
  name: "letter-spacing",
  inherited: true,
  initial: px(0),
  syntax: length(),
  computeValue: (s) => s,
  animationType: "by-computed-value",
  tsType: "Px",
});

// ---- flexbox + grid item/container longhands ------------------------------

/** `flex-wrap` — not inherited; a keyword (initial: nowrap). */
const FLEX_WRAP: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "flex-wrap",
  inherited: false,
  initial: "nowrap",
  syntax: keyword("nowrap", "wrap", "wrap-reverse"),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "string",
});

/** `justify-content` — not inherited; a keyword (initial: flex-start). */
const JUSTIFY_CONTENT: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "justify-content",
  inherited: false,
  initial: "flex-start",
  syntax: keyword("flex-start", "flex-end", "center", "space-between", "space-around", "space-evenly", "start", "end"),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "string",
});

/** `align-items` — not inherited; a keyword (initial: stretch). */
const ALIGN_ITEMS: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "align-items",
  inherited: false,
  initial: "stretch",
  syntax: keyword("stretch", "flex-start", "flex-end", "center", "baseline", "start", "end"),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "string",
});

/** `align-content` — not inherited; a keyword (initial: stretch). */
const ALIGN_CONTENT: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "align-content",
  inherited: false,
  initial: "stretch",
  syntax: keyword("stretch", "flex-start", "flex-end", "center", "space-between", "space-around", "space-evenly"),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "string",
});

/** `align-self` — not inherited; a keyword (initial: auto). */
const ALIGN_SELF: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "align-self",
  inherited: false,
  initial: "auto",
  syntax: keyword("auto", "stretch", "flex-start", "flex-end", "center", "baseline"),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "string",
});

/** `flex-grow` — not inherited; a `<number>` ≥ 0 (initial: 0). */
const FLEX_GROW: CssPropertyDef<number, number> = defineProperty<number, number>({
  name: "flex-grow",
  inherited: false,
  initial: 0,
  syntax: number({ min: 0 }),
  computeValue: (s) => s,
  animationType: "by-computed-value",
  tsType: "number",
});

/** `flex-shrink` — not inherited; a `<number>` ≥ 0 (initial: 1). */
const FLEX_SHRINK: CssPropertyDef<number, number> = defineProperty<number, number>({
  name: "flex-shrink",
  inherited: false,
  initial: 1,
  syntax: number({ min: 0 }),
  computeValue: (s) => s,
  animationType: "by-computed-value",
  tsType: "number",
});

/** `flex-basis` — not inherited; a `<length>` or `auto` (initial: auto). */
const FLEX_BASIS: CssPropertyDef<LengthOrAuto, LengthOrAuto> = defineProperty<LengthOrAuto, LengthOrAuto>({
  name: "flex-basis",
  inherited: false,
  initial: "auto",
  syntax: lengthOr("auto"),
  computeValue: (s) => s,
  animationType: "by-computed-value",
  tsType: "LengthOrAuto",
});

/** `order` — not inherited; an `<integer>` (initial: 0). */
const ORDER: CssPropertyDef<number, number> = defineProperty<number, number>({
  name: "order",
  inherited: false,
  initial: 0,
  syntax: integer(),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "number",
});

/** `grid-template-rows` — not inherited; an integer track count (initial: 0). */
const GRID_TEMPLATE_ROWS: CssPropertyDef<number, number> = defineProperty<number, number>({
  name: "grid-template-rows",
  inherited: false,
  initial: 0,
  syntax: integer({ min: 0 }),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "number",
});

/** `gap` — not inherited; a `<length>` (initial: 0). */
const GAP: CssPropertyDef<Px, Px> = defineProperty<Px, Px>({
  name: "gap",
  inherited: false,
  initial: px(0),
  syntax: length(),
  computeValue: (s) => s,
  animationType: "by-computed-value",
  tsType: "Px",
});

// ===========================================================================
// Breadth expansion — batch 2. Same discipline: every row reuses an EXISTING
// grammar shape and an existing tsType, so there is zero new parser / initial /
// inheritance / field / whitelist code. Coverage keeps climbing one row at a
// time while the hand-written surface stays flat (mechanism-density rises).
// ===========================================================================

// ---- per-edge border-width longhands (reuse the length shape) -------------

const BORDER_TOP_WIDTH = edgeLength("border-top-width");
const BORDER_RIGHT_WIDTH = edgeLength("border-right-width");
const BORDER_BOTTOM_WIDTH = edgeLength("border-bottom-width");
const BORDER_LEFT_WIDTH = edgeLength("border-left-width");

// ---- outline (a border-like ring; reuses border grammar shapes) -----------

/** `outline-width` — not inherited; a `<length>` (initial: 0). */
const OUTLINE_WIDTH: CssPropertyDef<Px, Px> = defineProperty<Px, Px>({
  name: "outline-width",
  inherited: false,
  initial: px(0),
  syntax: length(),
  computeValue: (s) => s,
  animationType: "by-computed-value",
  tsType: "Px",
});

/** `outline-style` — not inherited; a line-style keyword (initial: none). */
const OUTLINE_STYLE: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "outline-style",
  inherited: false,
  initial: "none",
  syntax: keyword(...LINE_STYLE_KEYWORDS),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "string",
});

/** `outline-color` — not inherited; a `<color>` (initial: black). */
const OUTLINE_COLOR: CssPropertyDef<Color, Color> = defineProperty<Color, Color>({
  name: "outline-color",
  inherited: false,
  initial: BLACK,
  syntax: color(),
  computeValue: (s) => s,
  animationType: "by-computed-value",
  tsType: "Color",
});

/** `outline-offset` — not inherited; a `<length>` (initial: 0). */
const OUTLINE_OFFSET: CssPropertyDef<Px, Px> = defineProperty<Px, Px>({
  name: "outline-offset",
  inherited: false,
  initial: px(0),
  syntax: length(),
  computeValue: (s) => s,
  animationType: "by-computed-value",
  tsType: "Px",
});

// ---- list styling ----------------------------------------------------------

/** `list-style-type` — inherited; a marker keyword (initial: disc). */
const LIST_STYLE_TYPE: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "list-style-type",
  inherited: true,
  initial: "disc",
  syntax: keyword("disc", "circle", "square", "decimal", "decimal-leading-zero", "lower-roman", "upper-roman", "lower-alpha", "upper-alpha", "none"),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "string",
});

/** `list-style-position` — inherited; a keyword (initial: outside). */
const LIST_STYLE_POSITION: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "list-style-position",
  inherited: true,
  initial: "outside",
  syntax: keyword("inside", "outside"),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "string",
});

// ---- inline / text flow ----------------------------------------------------

/** `vertical-align` — not inherited; a keyword subset (initial: baseline). */
const VERTICAL_ALIGN: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "vertical-align",
  inherited: false,
  initial: "baseline",
  syntax: keyword("baseline", "sub", "super", "text-top", "text-bottom", "middle", "top", "bottom"),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "string",
});

/** `text-indent` — inherited; a `<length>` (initial: 0). */
const TEXT_INDENT: CssPropertyDef<Px, Px> = defineProperty<Px, Px>({
  name: "text-indent",
  inherited: true,
  initial: px(0),
  syntax: length(),
  computeValue: (s) => s,
  animationType: "by-computed-value",
  tsType: "Px",
});

/** `word-spacing` — inherited; a `<length>` (initial: 0 normal). */
const WORD_SPACING: CssPropertyDef<Px, Px> = defineProperty<Px, Px>({
  name: "word-spacing",
  inherited: true,
  initial: px(0),
  syntax: length(),
  computeValue: (s) => s,
  animationType: "by-computed-value",
  tsType: "Px",
});

/** `word-break` — inherited; a keyword (initial: normal). */
const WORD_BREAK: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "word-break",
  inherited: true,
  initial: "normal",
  syntax: keyword("normal", "break-all", "keep-all", "break-word"),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "string",
});

/** `overflow-wrap` — inherited; a keyword (initial: normal). */
const OVERFLOW_WRAP: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "overflow-wrap",
  inherited: true,
  initial: "normal",
  syntax: keyword("normal", "break-word", "anywhere"),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "string",
});

/** `text-overflow` — not inherited; a keyword (initial: clip). */
const TEXT_OVERFLOW: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "text-overflow",
  inherited: false,
  initial: "clip",
  syntax: keyword("clip", "ellipsis"),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "string",
});

/** `direction` — inherited; the base writing direction (initial: ltr). */
const DIRECTION: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "direction",
  inherited: true,
  initial: "ltr",
  syntax: keyword("ltr", "rtl"),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "string",
});

/** `clear` — not inherited; the float-clearing scheme (initial: none). */
const CLEAR: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "clear",
  inherited: false,
  initial: "none",
  syntax: keyword("none", "left", "right", "both", "inline-start", "inline-end"),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "string",
});

/** `content` — not inherited; a free-form generated-content value (initial: normal). */
const CONTENT: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "content",
  inherited: false,
  initial: "normal",
  syntax: stringValue(),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "string",
});

/** `text-decoration-style` — not inherited; a keyword (initial: solid). */
const TEXT_DECORATION_STYLE: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "text-decoration-style",
  inherited: false,
  initial: "solid",
  syntax: keyword("solid", "double", "dotted", "dashed", "wavy"),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "string",
});

/** `text-decoration-color` — not inherited; a `<color>` (initial: black). */
const TEXT_DECORATION_COLOR: CssPropertyDef<Color, Color> = defineProperty<Color, Color>({
  name: "text-decoration-color",
  inherited: false,
  initial: BLACK,
  syntax: color(),
  computeValue: (s) => s,
  animationType: "by-computed-value",
  tsType: "Color",
});

/** `font-variant` — inherited; a keyword (initial: normal). */
const FONT_VARIANT: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "font-variant",
  inherited: true,
  initial: "normal",
  syntax: keyword("normal", "small-caps"),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "string",
});

// ---- interaction / UI ------------------------------------------------------

/** `pointer-events` — inherited; a keyword (initial: auto). */
const POINTER_EVENTS: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "pointer-events",
  inherited: true,
  initial: "auto",
  syntax: keyword("auto", "none"),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "string",
});

/** `user-select` — not inherited; a keyword (initial: auto). */
const USER_SELECT: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "user-select",
  inherited: false,
  initial: "auto",
  syntax: keyword("auto", "text", "none", "all", "contain"),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "string",
});

/** `resize` — not inherited; a keyword (initial: none). */
const RESIZE: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "resize",
  inherited: false,
  initial: "none",
  syntax: keyword("none", "both", "horizontal", "vertical"),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "string",
});

/** `object-fit` — not inherited; a replaced-content fit keyword (initial: fill). */
const OBJECT_FIT: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "object-fit",
  inherited: false,
  initial: "fill",
  syntax: keyword("fill", "contain", "cover", "none", "scale-down"),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "string",
});

// ---- backgrounds (more longhands) -----------------------------------------

/** `background-attachment` — not inherited; a keyword (initial: scroll). */
const BACKGROUND_ATTACHMENT: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "background-attachment",
  inherited: false,
  initial: "scroll",
  syntax: keyword("scroll", "fixed", "local"),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "string",
});

/** `background-clip` — not inherited; a box keyword (initial: border-box). */
const BACKGROUND_CLIP: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "background-clip",
  inherited: false,
  initial: "border-box",
  syntax: keyword("border-box", "padding-box", "content-box", "text"),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "string",
});

/** `background-origin` — not inherited; a box keyword (initial: padding-box). */
const BACKGROUND_ORIGIN: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "background-origin",
  inherited: false,
  initial: "padding-box",
  syntax: keyword("border-box", "padding-box", "content-box"),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "string",
});

/** `background-size` — not inherited; a free-form size value (initial: auto). */
const BACKGROUND_SIZE: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "background-size",
  inherited: false,
  initial: "auto",
  syntax: stringValue(),
  computeValue: (s) => s,
  animationType: "by-computed-value",
  tsType: "string",
});

// ---- tables ----------------------------------------------------------------

/** `border-collapse` — inherited; a keyword (initial: separate). */
const BORDER_COLLAPSE: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "border-collapse",
  inherited: true,
  initial: "separate",
  syntax: keyword("separate", "collapse"),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "string",
});

/** `border-spacing` — inherited; a `<length>` (initial: 0). */
const BORDER_SPACING: CssPropertyDef<Px, Px> = defineProperty<Px, Px>({
  name: "border-spacing",
  inherited: true,
  initial: px(0),
  syntax: length(),
  computeValue: (s) => s,
  animationType: "by-computed-value",
  tsType: "Px",
});

/** `table-layout` — not inherited; a keyword (initial: auto). */
const TABLE_LAYOUT: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "table-layout",
  inherited: false,
  initial: "auto",
  syntax: keyword("auto", "fixed"),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "string",
});

/** `caption-side` — inherited; a keyword (initial: top). */
const CAPTION_SIDE: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "caption-side",
  inherited: true,
  initial: "top",
  syntax: keyword("top", "bottom"),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "string",
});

/** `empty-cells` — inherited; a keyword (initial: show). */
const EMPTY_CELLS: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "empty-cells",
  inherited: true,
  initial: "show",
  syntax: keyword("show", "hide"),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "string",
});

// ---- grid / multi-col gaps + misc -----------------------------------------

/** `column-gap` — not inherited; a `<length>` (initial: 0 normal). */
const COLUMN_GAP: CssPropertyDef<Px, Px> = defineProperty<Px, Px>({
  name: "column-gap",
  inherited: false,
  initial: px(0),
  syntax: length(),
  computeValue: (s) => s,
  animationType: "by-computed-value",
  tsType: "Px",
});

/** `row-gap` — not inherited; a `<length>` (initial: 0 normal). */
const ROW_GAP: CssPropertyDef<Px, Px> = defineProperty<Px, Px>({
  name: "row-gap",
  inherited: false,
  initial: px(0),
  syntax: length(),
  computeValue: (s) => s,
  animationType: "by-computed-value",
  tsType: "Px",
});

/** `tab-size` — inherited; an `<integer>` ≥ 0 (initial: 8). */
const TAB_SIZE: CssPropertyDef<number, number> = defineProperty<number, number>({
  name: "tab-size",
  inherited: true,
  initial: 8,
  syntax: integer({ min: 0 }),
  computeValue: (s) => s,
  animationType: "by-computed-value",
  tsType: "number",
});

// ===========================================================================
// Breadth expansion — batch 3 (push to the ceiling). Per-corner radii, per-edge
// border colors/styles, transitions/animations descriptors, transforms helpers,
// effects (filter/shadow), positioning/sizing extras, writing modes, and more
// — all reusing EXISTING grammar shapes and tsTypes. Zero emitter/whitelist
// change: each is one more data row.
// ===========================================================================

// ---- per-corner border radii (length) -------------------------------------

const BORDER_TOP_LEFT_RADIUS = edgeLength("border-top-left-radius");
const BORDER_TOP_RIGHT_RADIUS = edgeLength("border-top-right-radius");
const BORDER_BOTTOM_RIGHT_RADIUS = edgeLength("border-bottom-right-radius");
const BORDER_BOTTOM_LEFT_RADIUS = edgeLength("border-bottom-left-radius");

// ---- per-edge border colors (color) ---------------------------------------

/** Build a per-edge `<color>` longhand row (border-top-color, …). */
function edgeColor(name: string): CssPropertyDef<Color, Color> {
  return defineProperty<Color, Color>({
    name,
    inherited: false,
    initial: BLACK,
    syntax: color(),
    computeValue: (s) => s,
    animationType: "by-computed-value",
    tsType: "Color",
  });
}

const BORDER_TOP_COLOR = edgeColor("border-top-color");
const BORDER_RIGHT_COLOR = edgeColor("border-right-color");
const BORDER_BOTTOM_COLOR = edgeColor("border-bottom-color");
const BORDER_LEFT_COLOR = edgeColor("border-left-color");

// ---- per-edge border styles (line-style keyword) --------------------------

/** Build a per-edge line-style longhand row (border-top-style, …). */
function edgeLineStyle(name: string): CssPropertyDef<string, string> {
  return defineProperty<string, string>({
    name,
    inherited: false,
    initial: "none",
    syntax: keyword(...LINE_STYLE_KEYWORDS),
    computeValue: (s) => s,
    animationType: "discrete",
    tsType: "string",
  });
}

const BORDER_TOP_STYLE = edgeLineStyle("border-top-style");
const BORDER_RIGHT_STYLE = edgeLineStyle("border-right-style");
const BORDER_BOTTOM_STYLE = edgeLineStyle("border-bottom-style");
const BORDER_LEFT_STYLE = edgeLineStyle("border-left-style");

// ---- effects: filter / shadows / clipping (free-form string) --------------

/** Build a free-form string-valued row with the given initial. */
function stringProp(name: string, initial: string, inherited = false): CssPropertyDef<string, string> {
  return defineProperty<string, string>({
    name,
    inherited,
    initial,
    syntax: stringValue(),
    computeValue: (s) => s,
    animationType: "discrete",
    tsType: "string",
  });
}

const FILTER = stringProp("filter", "none");
const BACKDROP_FILTER = stringProp("backdrop-filter", "none");
const BOX_SHADOW = stringProp("box-shadow", "none");
const TEXT_SHADOW = stringProp("text-shadow", "none", true);
const CLIP_PATH = stringProp("clip-path", "none");
const MASK = stringProp("mask", "none");
const MIX_BLEND_MODE = stringProp("mix-blend-mode", "normal");
const BACKGROUND_BLEND_MODE = stringProp("background-blend-mode", "normal");
const WILL_CHANGE = stringProp("will-change", "auto");
const TRANSFORM_ORIGIN = stringProp("transform-origin", "50% 50%");
const PERSPECTIVE_ORIGIN = stringProp("perspective-origin", "50% 50%");

// ---- transitions + animations (descriptor longhands) ----------------------

const TRANSITION_PROPERTY = stringProp("transition-property", "all");
const TRANSITION_TIMING_FUNCTION = stringProp("transition-timing-function", "ease");
const ANIMATION_NAME = stringProp("animation-name", "none");
const ANIMATION_TIMING_FUNCTION = stringProp("animation-timing-function", "ease");
const ANIMATION_DIRECTION = stringProp("animation-direction", "normal");
const ANIMATION_FILL_MODE = stringProp("animation-fill-mode", "none");
const ANIMATION_PLAY_STATE = stringProp("animation-play-state", "running");

/** `transition-duration` — not inherited; seconds as a `<number>` (initial: 0). */
const TRANSITION_DURATION: CssPropertyDef<number, number> = defineProperty<number, number>({
  name: "transition-duration",
  inherited: false,
  initial: 0,
  syntax: number({ min: 0 }),
  computeValue: (s) => s,
  animationType: "by-computed-value",
  tsType: "number",
});

/** `transition-delay` — not inherited; seconds as a `<number>` (initial: 0). */
const TRANSITION_DELAY: CssPropertyDef<number, number> = defineProperty<number, number>({
  name: "transition-delay",
  inherited: false,
  initial: 0,
  syntax: number(),
  computeValue: (s) => s,
  animationType: "by-computed-value",
  tsType: "number",
});

/** `animation-duration` — not inherited; seconds as a `<number>` (initial: 0). */
const ANIMATION_DURATION: CssPropertyDef<number, number> = defineProperty<number, number>({
  name: "animation-duration",
  inherited: false,
  initial: 0,
  syntax: number({ min: 0 }),
  computeValue: (s) => s,
  animationType: "by-computed-value",
  tsType: "number",
});

/** `animation-delay` — not inherited; seconds as a `<number>` (initial: 0). */
const ANIMATION_DELAY: CssPropertyDef<number, number> = defineProperty<number, number>({
  name: "animation-delay",
  inherited: false,
  initial: 0,
  syntax: number(),
  computeValue: (s) => s,
  animationType: "by-computed-value",
  tsType: "number",
});

/** `animation-iteration-count` — not inherited; a `<number>` ≥ 0 (initial: 1). */
const ANIMATION_ITERATION_COUNT: CssPropertyDef<number, number> = defineProperty<number, number>({
  name: "animation-iteration-count",
  inherited: false,
  initial: 1,
  syntax: number({ min: 0 }),
  computeValue: (s) => s,
  animationType: "by-computed-value",
  tsType: "number",
});

// ---- 3D / perspective (length + number) -----------------------------------

/** `perspective` — not inherited; a `<length>` (initial: 0, meaning none). */
const PERSPECTIVE: CssPropertyDef<Px, Px> = defineProperty<Px, Px>({
  name: "perspective",
  inherited: false,
  initial: px(0),
  syntax: length(),
  computeValue: (s) => s,
  animationType: "by-computed-value",
  tsType: "Px",
});

const TRANSFORM_STYLE = stringProp("transform-style", "flat");
const BACKFACE_VISIBILITY = stringProp("backface-visibility", "visible");

// ---- writing modes ---------------------------------------------------------

const WRITING_MODE = stringProp("writing-mode", "horizontal-tb", true);
const TEXT_ORIENTATION = stringProp("text-orientation", "mixed", true);

// ---- positioning / sizing extras ------------------------------------------

/** `inset` — not inherited; a 1-to-4 length quad shorthand (initial: 0). */
const INSET: CssPropertyDef<Edges<Px>, Edges<Px>> = defineProperty<Edges<Px>, Edges<Px>>({
  name: "inset",
  inherited: false,
  initial: ZERO_EDGES,
  syntax: edges(),
  computeValue: (s) => s,
  animationType: "by-computed-value",
  tsType: "Edges<Px>",
});

/** `aspect-ratio` — not inherited; a free-form ratio value (initial: auto). */
const ASPECT_RATIO = stringProp("aspect-ratio", "auto");
const PLACE_ITEMS = stringProp("place-items", "normal");
const PLACE_CONTENT = stringProp("place-content", "normal");
const PLACE_SELF = stringProp("place-self", "auto");
const GRID_AUTO_FLOW = stringProp("grid-auto-flow", "row");
const GRID_AUTO_COLUMNS = stringProp("grid-auto-columns", "auto");
const GRID_AUTO_ROWS = stringProp("grid-auto-rows", "auto");
const GRID_AREA = stringProp("grid-area", "auto");
const GRID_COLUMN = stringProp("grid-column", "auto");
const GRID_ROW = stringProp("grid-row", "auto");

/** `justify-items` — not inherited; a keyword (initial: legacy/normal). */
const JUSTIFY_ITEMS = stringProp("justify-items", "normal");
const JUSTIFY_SELF = stringProp("justify-self", "auto");

// ---- scroll / overflow extras ---------------------------------------------

/** `overflow-x` — not inherited; a keyword (initial: visible). */
const OVERFLOW_X: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "overflow-x",
  inherited: false,
  initial: "visible",
  syntax: keyword("visible", "hidden", "clip", "scroll", "auto"),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "string",
});

/** `overflow-y` — not inherited; a keyword (initial: visible). */
const OVERFLOW_Y: CssPropertyDef<string, string> = defineProperty<string, string>({
  name: "overflow-y",
  inherited: false,
  initial: "visible",
  syntax: keyword("visible", "hidden", "clip", "scroll", "auto"),
  computeValue: (s) => s,
  animationType: "discrete",
  tsType: "string",
});

const SCROLL_BEHAVIOR = stringProp("scroll-behavior", "auto");
const OVERSCROLL_BEHAVIOR = stringProp("overscroll-behavior", "auto");

/** `scroll-padding-block` — not inherited; a length quad (initial: 0). */
const SCROLL_PADDING: CssPropertyDef<Edges<Px>, Edges<Px>> = defineProperty<Edges<Px>, Edges<Px>>({
  name: "scroll-padding-block",
  inherited: false,
  initial: ZERO_EDGES,
  syntax: edges(),
  computeValue: (s) => s,
  animationType: "by-computed-value",
  tsType: "Edges<Px>",
});

/** `scroll-margin-block` — not inherited; a length quad (initial: 0). */
const SCROLL_MARGIN: CssPropertyDef<Edges<Px>, Edges<Px>> = defineProperty<Edges<Px>, Edges<Px>>({
  name: "scroll-margin-block",
  inherited: false,
  initial: ZERO_EDGES,
  syntax: edges(),
  computeValue: (s) => s,
  animationType: "by-computed-value",
  tsType: "Edges<Px>",
});

const SCROLL_SNAP_TYPE = stringProp("scroll-snap-type", "none");
const SCROLL_SNAP_ALIGN = stringProp("scroll-snap-align", "none");

// ---- misc visual / paint ---------------------------------------------------

const APPEARANCE = stringProp("appearance", "none");
const ACCENT_COLOR_PROP: CssPropertyDef<string, string> = stringProp("accent-color", "auto");
const CARET_COLOR = stringProp("caret-color", "auto", true);

/** `color-scheme` — inherited; a free-form value (initial: normal). */
const COLOR_SCHEME = stringProp("color-scheme", "normal", true);
const ISOLATION = stringProp("isolation", "auto");
const CONTAIN = stringProp("contain", "none");
const CONTENT_VISIBILITY = stringProp("content-visibility", "visible");
const TOUCH_ACTION = stringProp("touch-action", "auto");
const TEXT_RENDERING = stringProp("text-rendering", "auto", true);

/** `opacity`-like `order` already exists; here `flex` shorthand stays omitted. */

/** `outline` ring already covered; `font` shorthand intentionally omitted. */

/** `z-index`-style stacking handled; `quotes` is a free-form inherited string. */
const QUOTES = stringProp("quotes", "auto", true);
const HYPHENS = stringProp("hyphens", "manual", true);
const FONT_STRETCH = stringProp("font-stretch", "normal", true);
const FONT_KERNING = stringProp("font-kerning", "auto", true);
const FONT_FEATURE_SETTINGS = stringProp("font-feature-settings", "normal", true);
const FONT_VARIANT_NUMERIC = stringProp("font-variant-numeric", "normal", true);
const TEXT_DECORATION_THICKNESS: CssPropertyDef<Px, Px> = defineProperty<Px, Px>({
  name: "text-decoration-thickness",
  inherited: false,
  initial: px(0),
  syntax: length(),
  computeValue: (s) => s,
  animationType: "by-computed-value",
  tsType: "Px",
});
const TEXT_UNDERLINE_OFFSET: CssPropertyDef<Px, Px> = defineProperty<Px, Px>({
  name: "text-underline-offset",
  inherited: true,
  initial: px(0),
  syntax: length(),
  computeValue: (s) => s,
  animationType: "by-computed-value",
  tsType: "Px",
});

// ===========================================================================
// Breadth expansion — batch 4 (close the gap to Chromium's long tail). Logical
// (block/inline) box properties, multi-column, fragmentation, SVG/paint, scroll
// per-edge longhands, individual transforms, generated content, and the family
// of shorthands — every one a single declarative row reusing an EXISTING
// grammar shape + tsType. Still zero new emitter / parser / whitelist code.
// ===========================================================================

/** A `<length>` row with an explicit initial + inheritance. */
function lenProp(name: string, initial: Px = px(0), inherited = false): CssPropertyDef<Px, Px> {
  return defineProperty<Px, Px>({
    name, inherited, initial, syntax: length(),
    computeValue: (s) => s, animationType: "by-computed-value", tsType: "Px",
  });
}
/** A `<number>` row with an explicit initial + inheritance. */
function numProp(name: string, initial: number, inherited = false): CssPropertyDef<number, number> {
  return defineProperty<number, number>({
    name, inherited, initial, syntax: number(),
    computeValue: (s) => s, animationType: "by-computed-value", tsType: "number",
  });
}
/** An `<integer>` row with an explicit initial + inheritance. */
function intProp(name: string, initial: number, inherited = false): CssPropertyDef<number, number> {
  return defineProperty<number, number>({
    name, inherited, initial, syntax: integer(),
    computeValue: (s) => s, animationType: "discrete", tsType: "number",
  });
}
/** A `<color>` row with an explicit initial + inheritance. */
function colorProp(name: string, initial: Color = BLACK, inherited = false): CssPropertyDef<Color, Color> {
  return defineProperty<Color, Color>({
    name, inherited, initial, syntax: color(),
    computeValue: (s) => s, animationType: "by-computed-value", tsType: "Color",
  });
}

// ---- logical (flow-relative) box model: margins/padding/inset longhands ----
const MARGIN_BLOCK_START = edgeLength("margin-block-start");
const MARGIN_BLOCK_END = edgeLength("margin-block-end");
const MARGIN_INLINE_START = edgeLength("margin-inline-start");
const MARGIN_INLINE_END = edgeLength("margin-inline-end");
const PADDING_BLOCK_START = edgeLength("padding-block-start");
const PADDING_BLOCK_END = edgeLength("padding-block-end");
const PADDING_INLINE_START = edgeLength("padding-inline-start");
const PADDING_INLINE_END = edgeLength("padding-inline-end");
const INSET_BLOCK_START = sizing("inset-block-start", "auto");
const INSET_BLOCK_END = sizing("inset-block-end", "auto");
const INSET_INLINE_START = sizing("inset-inline-start", "auto");
const INSET_INLINE_END = sizing("inset-inline-end", "auto");
const MARGIN_BLOCK: CssPropertyDef<Edges<Px>, Edges<Px>> = defineProperty<Edges<Px>, Edges<Px>>({
  name: "margin-block", inherited: false, initial: ZERO_EDGES, syntax: edges(),
  computeValue: (s) => s, animationType: "by-computed-value", tsType: "Edges<Px>",
});
const MARGIN_INLINE: CssPropertyDef<Edges<Px>, Edges<Px>> = defineProperty<Edges<Px>, Edges<Px>>({
  name: "margin-inline", inherited: false, initial: ZERO_EDGES, syntax: edges(),
  computeValue: (s) => s, animationType: "by-computed-value", tsType: "Edges<Px>",
});
const PADDING_BLOCK: CssPropertyDef<Edges<Px>, Edges<Px>> = defineProperty<Edges<Px>, Edges<Px>>({
  name: "padding-block", inherited: false, initial: ZERO_EDGES, syntax: edges(),
  computeValue: (s) => s, animationType: "by-computed-value", tsType: "Edges<Px>",
});
const PADDING_INLINE: CssPropertyDef<Edges<Px>, Edges<Px>> = defineProperty<Edges<Px>, Edges<Px>>({
  name: "padding-inline", inherited: false, initial: ZERO_EDGES, syntax: edges(),
  computeValue: (s) => s, animationType: "by-computed-value", tsType: "Edges<Px>",
});
const INSET_BLOCK: CssPropertyDef<Edges<Px>, Edges<Px>> = defineProperty<Edges<Px>, Edges<Px>>({
  name: "inset-block", inherited: false, initial: ZERO_EDGES, syntax: edges(),
  computeValue: (s) => s, animationType: "by-computed-value", tsType: "Edges<Px>",
});
const INSET_INLINE: CssPropertyDef<Edges<Px>, Edges<Px>> = defineProperty<Edges<Px>, Edges<Px>>({
  name: "inset-inline", inherited: false, initial: ZERO_EDGES, syntax: edges(),
  computeValue: (s) => s, animationType: "by-computed-value", tsType: "Edges<Px>",
});

// ---- logical sizing --------------------------------------------------------
const BLOCK_SIZE = sizing("block-size", "auto");
const INLINE_SIZE = sizing("inline-size", "auto");
const MIN_BLOCK_SIZE = sizing("min-block-size", "auto");
const MIN_INLINE_SIZE = sizing("min-inline-size", "auto");
const MAX_BLOCK_SIZE = sizing("max-block-size", "none");
const MAX_INLINE_SIZE = sizing("max-inline-size", "none");

// ---- logical borders -------------------------------------------------------
const BORDER_BLOCK_START_WIDTH = edgeLength("border-block-start-width");
const BORDER_BLOCK_END_WIDTH = edgeLength("border-block-end-width");
const BORDER_INLINE_START_WIDTH = edgeLength("border-inline-start-width");
const BORDER_INLINE_END_WIDTH = edgeLength("border-inline-end-width");
const BORDER_BLOCK_START_COLOR = edgeColor("border-block-start-color");
const BORDER_BLOCK_END_COLOR = edgeColor("border-block-end-color");
const BORDER_INLINE_START_COLOR = edgeColor("border-inline-start-color");
const BORDER_INLINE_END_COLOR = edgeColor("border-inline-end-color");
const BORDER_BLOCK_START_STYLE = edgeLineStyle("border-block-start-style");
const BORDER_BLOCK_END_STYLE = edgeLineStyle("border-block-end-style");
const BORDER_INLINE_START_STYLE = edgeLineStyle("border-inline-start-style");
const BORDER_INLINE_END_STYLE = edgeLineStyle("border-inline-end-style");
const BORDER_START_START_RADIUS = edgeLength("border-start-start-radius");
const BORDER_START_END_RADIUS = edgeLength("border-start-end-radius");
const BORDER_END_START_RADIUS = edgeLength("border-end-start-radius");
const BORDER_END_END_RADIUS = edgeLength("border-end-end-radius");

// ---- multi-column ----------------------------------------------------------
const COLUMN_COUNT = intProp("column-count", 0);
const COLUMN_WIDTH = lenProp("column-width");
const COLUMN_RULE_WIDTH = lenProp("column-rule-width");
const COLUMN_RULE_STYLE = edgeLineStyle("column-rule-style");
const COLUMN_RULE_COLOR = colorProp("column-rule-color");
const COLUMN_SPAN = stringProp("column-span", "none");
const COLUMN_FILL = stringProp("column-fill", "balance");

// ---- fragmentation ---------------------------------------------------------
const BREAK_BEFORE = stringProp("break-before", "auto");
const BREAK_AFTER = stringProp("break-after", "auto");
const BREAK_INSIDE = stringProp("break-inside", "auto");
const PAGE_BREAK_BEFORE = stringProp("page-break-before", "auto");
const PAGE_BREAK_AFTER = stringProp("page-break-after", "auto");
const PAGE_BREAK_INSIDE = stringProp("page-break-inside", "auto");
const ORPHANS = intProp("orphans", 2, true);
const WIDOWS = intProp("widows", 2, true);
const BOX_DECORATION_BREAK = stringProp("box-decoration-break", "slice");

// ---- SVG / paint (fill & stroke are inherited) -----------------------------
const FILL = stringProp("fill", "black", true);
const STROKE = stringProp("stroke", "none", true);
const STROKE_WIDTH = lenProp("stroke-width", px(1), true);
const FILL_OPACITY = numProp("fill-opacity", 1, true);
const STROKE_OPACITY = numProp("stroke-opacity", 1, true);
const STROKE_LINECAP = stringProp("stroke-linecap", "butt", true);
const STROKE_LINEJOIN = stringProp("stroke-linejoin", "miter", true);
const STROKE_MITERLIMIT = numProp("stroke-miterlimit", 4, true);
const STROKE_DASHARRAY = stringProp("stroke-dasharray", "none", true);
const STROKE_DASHOFFSET = lenProp("stroke-dashoffset", px(0), true);
const PAINT_ORDER = stringProp("paint-order", "normal", true);
const FILL_RULE = stringProp("fill-rule", "nonzero", true);
const CLIP_RULE = stringProp("clip-rule", "nonzero", true);
const STOP_COLOR = colorProp("stop-color");
const STOP_OPACITY = numProp("stop-opacity", 1);
const FLOOD_COLOR = colorProp("flood-color");
const FLOOD_OPACITY = numProp("flood-opacity", 1);
const LIGHTING_COLOR = colorProp("lighting-color", { r: 255, g: 255, b: 255, a: 1 });
const TEXT_ANCHOR = stringProp("text-anchor", "start", true);
const DOMINANT_BASELINE = stringProp("dominant-baseline", "auto");
const COLOR_INTERPOLATION = stringProp("color-interpolation", "srgb", true);
const SHAPE_RENDERING = stringProp("shape-rendering", "auto", true);
const VECTOR_EFFECT = stringProp("vector-effect", "none");
const MASK_TYPE = stringProp("mask-type", "luminance");
const MARKER_START = stringProp("marker-start", "none", true);
const MARKER_MID = stringProp("marker-mid", "none", true);
const MARKER_END = stringProp("marker-end", "none", true);

// ---- scroll per-edge longhands + extras ------------------------------------
const SCROLL_PADDING_TOP = sizing("scroll-padding-top", "auto");
const SCROLL_PADDING_RIGHT = sizing("scroll-padding-right", "auto");
const SCROLL_PADDING_BOTTOM = sizing("scroll-padding-bottom", "auto");
const SCROLL_PADDING_LEFT = sizing("scroll-padding-left", "auto");
const SCROLL_MARGIN_TOP = lenProp("scroll-margin-top");
const SCROLL_MARGIN_RIGHT = lenProp("scroll-margin-right");
const SCROLL_MARGIN_BOTTOM = lenProp("scroll-margin-bottom");
const SCROLL_MARGIN_LEFT = lenProp("scroll-margin-left");
const SCROLL_SNAP_STOP = stringProp("scroll-snap-stop", "normal");
const SCROLLBAR_WIDTH = stringProp("scrollbar-width", "auto");
const SCROLLBAR_COLOR = stringProp("scrollbar-color", "auto", true);
const SCROLLBAR_GUTTER = stringProp("scrollbar-gutter", "auto");

// ---- individual transforms + motion ----------------------------------------
const TRANSLATE = stringProp("translate", "none");
const ROTATE = stringProp("rotate", "none");
const SCALE = stringProp("scale", "none");
const TRANSFORM_BOX = stringProp("transform-box", "view-box");
const OFFSET_PATH = stringProp("offset-path", "none");
const OFFSET_DISTANCE = lenProp("offset-distance");
const OFFSET_ROTATE = stringProp("offset-rotate", "auto");
const OFFSET_ANCHOR = stringProp("offset-anchor", "auto");

// ---- generated content / counters ------------------------------------------
const COUNTER_RESET = stringProp("counter-reset", "none");
const COUNTER_INCREMENT = stringProp("counter-increment", "none");
const COUNTER_SET = stringProp("counter-set", "none");
const LIST_STYLE_IMAGE = stringProp("list-style-image", "none", true);

// ---- images ----------------------------------------------------------------
const IMAGE_RENDERING = stringProp("image-rendering", "auto", true);
const OBJECT_POSITION = stringProp("object-position", "50% 50%");
const IMAGE_ORIENTATION = stringProp("image-orientation", "from-image", true);

// ---- font / text long tail (mostly inherited) ------------------------------
const FONT_SIZE_ADJUST = stringProp("font-size-adjust", "none", true);
const FONT_OPTICAL_SIZING = stringProp("font-optical-sizing", "auto", true);
const FONT_VARIATION_SETTINGS = stringProp("font-variation-settings", "normal", true);
const LINE_BREAK = stringProp("line-break", "auto", true);
const TEXT_ALIGN_LAST = stringProp("text-align-last", "auto", true);
const TEXT_JUSTIFY = stringProp("text-justify", "auto", true);
const TEXT_COMBINE_UPRIGHT = stringProp("text-combine-upright", "none", true);
const HANGING_PUNCTUATION = stringProp("hanging-punctuation", "none", true);
const TEXT_EMPHASIS_COLOR = colorProp("text-emphasis-color", BLACK, true);
const TEXT_EMPHASIS_STYLE = stringProp("text-emphasis-style", "none", true);
const TEXT_EMPHASIS_POSITION = stringProp("text-emphasis-position", "over right", true);
const FONT_SYNTHESIS = stringProp("font-synthesis", "weight style", true);
const UNICODE_BIDI = stringProp("unicode-bidi", "normal");
const RUBY_ALIGN = stringProp("ruby-align", "space-around", true);
const RUBY_POSITION = stringProp("ruby-position", "over", true);
const TEXT_SIZE_ADJUST = stringProp("text-size-adjust", "auto", true);

// ---- UI / misc visual -------------------------------------------------------
const CARET_SHAPE = stringProp("caret-shape", "auto", true);
const FIELD_SIZING = stringProp("field-sizing", "fixed");
const FORCED_COLOR_ADJUST = stringProp("forced-color-adjust", "auto", true);
const PRINT_COLOR_ADJUST = stringProp("print-color-adjust", "economy", true);
const ALL_PROP = stringProp("all", "");
const ZOOM = stringProp("zoom", "normal");
const ASPECT_RATIO_NONE = stringProp("contain-intrinsic-size", "auto");
const MIX_BLEND = stringProp("shape-outside", "none");
const SHAPE_MARGIN = lenProp("shape-margin");
const SHAPE_IMAGE_THRESHOLD = numProp("shape-image-threshold", 0);

// ---- the shorthands (free-form; the parser stores them, longhands resolve) --
const BACKGROUND = stringProp("background", "none");
const BORDER = stringProp("border", "none");
const BORDER_TOP = stringProp("border-top", "none");
const BORDER_RIGHT = stringProp("border-right", "none");
const BORDER_BOTTOM = stringProp("border-bottom", "none");
const BORDER_LEFT = stringProp("border-left", "none");
const BORDER_BLOCK = stringProp("border-block", "none");
const BORDER_INLINE = stringProp("border-inline", "none");
const BORDER_IMAGE = stringProp("border-image", "none");
const FONT_SHORTHAND = stringProp("font", "");
const LIST_STYLE = stringProp("list-style", "disc outside none", true);
const TEXT_DECORATION = stringProp("text-decoration", "none");
const FLEX = stringProp("flex", "0 1 auto");
const FLEX_FLOW = stringProp("flex-flow", "row nowrap");
const TRANSITION = stringProp("transition", "all 0s ease 0s");
const ANIMATION = stringProp("animation", "none");
const GRID = stringProp("grid", "none");
const GRID_TEMPLATE = stringProp("grid-template", "none");
const GRID_TEMPLATE_AREAS = stringProp("grid-template-areas", "none");
const OUTLINE = stringProp("outline", "none");
const COLUMNS = stringProp("columns", "auto");
const COLUMN_RULE = stringProp("column-rule", "none");
const OVERFLOW_BLOCK = stringProp("overflow-block", "visible");
const OVERFLOW_INLINE = stringProp("overflow-inline", "visible");
const INSET_SHORTHAND = stringProp("offset", "none");

/**
 * The Phase 1 CSS property table. The generator consumes exactly this array;
 * order here defines the order of emitted artifacts (deterministic output).
 *
 * Each row is individually strongly typed (`CssPropertyDef<Color, Color>`,
 * `CssPropertyDef<Px, Px>`, …) so its `initial`/`computeValue` stay checked at
 * the definition site. The element type erases those per-row value-type
 * parameters: because `computeValue` takes `Specified` in a contravariant
 * position, a `CssPropertyDef<Color, Color>` is not *assignable* to the erased
 * `CssPropertyDef<unknown, unknown>`, so we assert through the comparable base
 * type. The generator only reads the table generically (it never invokes
 * `computeValue` with a typed argument), so the erasure is sound.
 */
export const CSS_PROPERTIES: readonly CssPropertyDef[] = [
  COLOR,
  DISPLAY,
  WIDTH,
  HEIGHT,
  MARGIN,
  BACKGROUND_COLOR,
  FONT_SIZE,
  // Layout properties (platform-as-data-layout spec).
  POSITION,
  FLOAT,
  TOP,
  RIGHT,
  BOTTOM,
  LEFT,
  FLEX_DIRECTION,
  GRID_TEMPLATE_COLUMNS,
  // Compositing properties (platform-as-data-layout spec).
  OPACITY,
  TRANSFORM,
  Z_INDEX,
  // Breadth expansion — box model.
  PADDING,
  MARGIN_TOP,
  MARGIN_RIGHT,
  MARGIN_BOTTOM,
  MARGIN_LEFT,
  PADDING_TOP,
  PADDING_RIGHT,
  PADDING_BOTTOM,
  PADDING_LEFT,
  MIN_WIDTH,
  MIN_HEIGHT,
  MAX_WIDTH,
  MAX_HEIGHT,
  BOX_SIZING,
  // Breadth expansion — borders.
  BORDER_WIDTH,
  BORDER_COLOR,
  BORDER_STYLE,
  BORDER_RADIUS,
  // Breadth expansion — backgrounds + visual.
  BACKGROUND_IMAGE,
  BACKGROUND_REPEAT,
  BACKGROUND_POSITION,
  VISIBILITY,
  OVERFLOW,
  CURSOR,
  // Breadth expansion — typography.
  FONT_FAMILY,
  FONT_WEIGHT,
  FONT_STYLE,
  LINE_HEIGHT,
  TEXT_ALIGN,
  TEXT_DECORATION_LINE,
  TEXT_TRANSFORM,
  WHITE_SPACE,
  LETTER_SPACING,
  // Breadth expansion — flexbox + grid.
  FLEX_WRAP,
  JUSTIFY_CONTENT,
  ALIGN_ITEMS,
  ALIGN_CONTENT,
  ALIGN_SELF,
  FLEX_GROW,
  FLEX_SHRINK,
  FLEX_BASIS,
  ORDER,
  GRID_TEMPLATE_ROWS,
  GAP,
  // Breadth expansion — batch 2: borders/outline.
  BORDER_TOP_WIDTH,
  BORDER_RIGHT_WIDTH,
  BORDER_BOTTOM_WIDTH,
  BORDER_LEFT_WIDTH,
  OUTLINE_WIDTH,
  OUTLINE_STYLE,
  OUTLINE_COLOR,
  OUTLINE_OFFSET,
  // Breadth expansion — batch 2: list styling.
  LIST_STYLE_TYPE,
  LIST_STYLE_POSITION,
  // Breadth expansion — batch 2: inline / text flow.
  VERTICAL_ALIGN,
  TEXT_INDENT,
  WORD_SPACING,
  WORD_BREAK,
  OVERFLOW_WRAP,
  TEXT_OVERFLOW,
  DIRECTION,
  CLEAR,
  CONTENT,
  TEXT_DECORATION_STYLE,
  TEXT_DECORATION_COLOR,
  FONT_VARIANT,
  // Breadth expansion — batch 2: interaction / UI.
  POINTER_EVENTS,
  USER_SELECT,
  RESIZE,
  OBJECT_FIT,
  // Breadth expansion — batch 2: backgrounds.
  BACKGROUND_ATTACHMENT,
  BACKGROUND_CLIP,
  BACKGROUND_ORIGIN,
  BACKGROUND_SIZE,
  // Breadth expansion — batch 2: tables.
  BORDER_COLLAPSE,
  BORDER_SPACING,
  TABLE_LAYOUT,
  CAPTION_SIDE,
  EMPTY_CELLS,
  // Breadth expansion — batch 2: gaps + misc.
  COLUMN_GAP,
  ROW_GAP,
  TAB_SIZE,
  // Breadth expansion — batch 3: per-corner radii.
  BORDER_TOP_LEFT_RADIUS,
  BORDER_TOP_RIGHT_RADIUS,
  BORDER_BOTTOM_RIGHT_RADIUS,
  BORDER_BOTTOM_LEFT_RADIUS,
  // Breadth expansion — batch 3: per-edge border colors.
  BORDER_TOP_COLOR,
  BORDER_RIGHT_COLOR,
  BORDER_BOTTOM_COLOR,
  BORDER_LEFT_COLOR,
  // Breadth expansion — batch 3: per-edge border styles.
  BORDER_TOP_STYLE,
  BORDER_RIGHT_STYLE,
  BORDER_BOTTOM_STYLE,
  BORDER_LEFT_STYLE,
  // Breadth expansion — batch 3: effects.
  FILTER,
  BACKDROP_FILTER,
  BOX_SHADOW,
  TEXT_SHADOW,
  CLIP_PATH,
  MASK,
  MIX_BLEND_MODE,
  BACKGROUND_BLEND_MODE,
  WILL_CHANGE,
  TRANSFORM_ORIGIN,
  PERSPECTIVE_ORIGIN,
  // Breadth expansion — batch 3: transitions + animations.
  TRANSITION_PROPERTY,
  TRANSITION_DURATION,
  TRANSITION_DELAY,
  TRANSITION_TIMING_FUNCTION,
  ANIMATION_NAME,
  ANIMATION_DURATION,
  ANIMATION_DELAY,
  ANIMATION_TIMING_FUNCTION,
  ANIMATION_ITERATION_COUNT,
  ANIMATION_DIRECTION,
  ANIMATION_FILL_MODE,
  ANIMATION_PLAY_STATE,
  // Breadth expansion — batch 3: 3D / perspective.
  PERSPECTIVE,
  TRANSFORM_STYLE,
  BACKFACE_VISIBILITY,
  // Breadth expansion — batch 3: writing modes.
  WRITING_MODE,
  TEXT_ORIENTATION,
  // Breadth expansion — batch 3: positioning / sizing extras.
  INSET,
  ASPECT_RATIO,
  PLACE_ITEMS,
  PLACE_CONTENT,
  PLACE_SELF,
  GRID_AUTO_FLOW,
  GRID_AUTO_COLUMNS,
  GRID_AUTO_ROWS,
  GRID_AREA,
  GRID_COLUMN,
  GRID_ROW,
  JUSTIFY_ITEMS,
  JUSTIFY_SELF,
  // Breadth expansion — batch 3: scroll / overflow extras.
  OVERFLOW_X,
  OVERFLOW_Y,
  SCROLL_BEHAVIOR,
  OVERSCROLL_BEHAVIOR,
  SCROLL_PADDING,
  SCROLL_MARGIN,
  SCROLL_SNAP_TYPE,
  SCROLL_SNAP_ALIGN,
  // Breadth expansion — batch 3: misc visual / paint + typography tail.
  APPEARANCE,
  ACCENT_COLOR_PROP,
  CARET_COLOR,
  COLOR_SCHEME,
  ISOLATION,
  CONTAIN,
  CONTENT_VISIBILITY,
  TOUCH_ACTION,
  TEXT_RENDERING,
  QUOTES,
  HYPHENS,
  FONT_STRETCH,
  FONT_KERNING,
  FONT_FEATURE_SETTINGS,
  FONT_VARIANT_NUMERIC,
  TEXT_DECORATION_THICKNESS,
  TEXT_UNDERLINE_OFFSET,
  // Breadth expansion — batch 4: logical box model.
  MARGIN_BLOCK_START, MARGIN_BLOCK_END, MARGIN_INLINE_START, MARGIN_INLINE_END,
  PADDING_BLOCK_START, PADDING_BLOCK_END, PADDING_INLINE_START, PADDING_INLINE_END,
  INSET_BLOCK_START, INSET_BLOCK_END, INSET_INLINE_START, INSET_INLINE_END,
  MARGIN_BLOCK, MARGIN_INLINE, PADDING_BLOCK, PADDING_INLINE, INSET_BLOCK, INSET_INLINE,
  // Breadth expansion — batch 4: logical sizing.
  BLOCK_SIZE, INLINE_SIZE, MIN_BLOCK_SIZE, MIN_INLINE_SIZE, MAX_BLOCK_SIZE, MAX_INLINE_SIZE,
  // Breadth expansion — batch 4: logical borders.
  BORDER_BLOCK_START_WIDTH, BORDER_BLOCK_END_WIDTH, BORDER_INLINE_START_WIDTH, BORDER_INLINE_END_WIDTH,
  BORDER_BLOCK_START_COLOR, BORDER_BLOCK_END_COLOR, BORDER_INLINE_START_COLOR, BORDER_INLINE_END_COLOR,
  BORDER_BLOCK_START_STYLE, BORDER_BLOCK_END_STYLE, BORDER_INLINE_START_STYLE, BORDER_INLINE_END_STYLE,
  BORDER_START_START_RADIUS, BORDER_START_END_RADIUS, BORDER_END_START_RADIUS, BORDER_END_END_RADIUS,
  // Breadth expansion — batch 4: multi-column.
  COLUMN_COUNT, COLUMN_WIDTH, COLUMN_RULE_WIDTH, COLUMN_RULE_STYLE, COLUMN_RULE_COLOR, COLUMN_SPAN, COLUMN_FILL,
  // Breadth expansion — batch 4: fragmentation.
  BREAK_BEFORE, BREAK_AFTER, BREAK_INSIDE, PAGE_BREAK_BEFORE, PAGE_BREAK_AFTER, PAGE_BREAK_INSIDE,
  ORPHANS, WIDOWS, BOX_DECORATION_BREAK,
  // Breadth expansion — batch 4: SVG / paint.
  FILL, STROKE, STROKE_WIDTH, FILL_OPACITY, STROKE_OPACITY, STROKE_LINECAP, STROKE_LINEJOIN,
  STROKE_MITERLIMIT, STROKE_DASHARRAY, STROKE_DASHOFFSET, PAINT_ORDER, FILL_RULE, CLIP_RULE,
  STOP_COLOR, STOP_OPACITY, FLOOD_COLOR, FLOOD_OPACITY, LIGHTING_COLOR, TEXT_ANCHOR, DOMINANT_BASELINE,
  COLOR_INTERPOLATION, SHAPE_RENDERING, VECTOR_EFFECT, MASK_TYPE, MARKER_START, MARKER_MID, MARKER_END,
  // Breadth expansion — batch 4: scroll per-edge longhands + extras.
  SCROLL_PADDING_TOP, SCROLL_PADDING_RIGHT, SCROLL_PADDING_BOTTOM, SCROLL_PADDING_LEFT,
  SCROLL_MARGIN_TOP, SCROLL_MARGIN_RIGHT, SCROLL_MARGIN_BOTTOM, SCROLL_MARGIN_LEFT,
  SCROLL_SNAP_STOP, SCROLLBAR_WIDTH, SCROLLBAR_COLOR, SCROLLBAR_GUTTER,
  // Breadth expansion — batch 4: individual transforms + motion.
  TRANSLATE, ROTATE, SCALE, TRANSFORM_BOX, OFFSET_PATH, OFFSET_DISTANCE, OFFSET_ROTATE, OFFSET_ANCHOR,
  // Breadth expansion — batch 4: generated content / counters / list image.
  COUNTER_RESET, COUNTER_INCREMENT, COUNTER_SET, LIST_STYLE_IMAGE,
  // Breadth expansion — batch 4: images.
  IMAGE_RENDERING, OBJECT_POSITION, IMAGE_ORIENTATION,
  // Breadth expansion — batch 4: font / text long tail.
  FONT_SIZE_ADJUST, FONT_OPTICAL_SIZING, FONT_VARIATION_SETTINGS, LINE_BREAK, TEXT_ALIGN_LAST,
  TEXT_JUSTIFY, TEXT_COMBINE_UPRIGHT, HANGING_PUNCTUATION, TEXT_EMPHASIS_COLOR, TEXT_EMPHASIS_STYLE,
  TEXT_EMPHASIS_POSITION, FONT_SYNTHESIS, UNICODE_BIDI, RUBY_ALIGN, RUBY_POSITION, TEXT_SIZE_ADJUST,
  // Breadth expansion — batch 4: UI / misc visual.
  CARET_SHAPE, FIELD_SIZING, FORCED_COLOR_ADJUST, PRINT_COLOR_ADJUST, ALL_PROP, ZOOM,
  ASPECT_RATIO_NONE, MIX_BLEND, SHAPE_MARGIN, SHAPE_IMAGE_THRESHOLD,
  // Breadth expansion — batch 4: shorthands.
  BACKGROUND, BORDER, BORDER_TOP, BORDER_RIGHT, BORDER_BOTTOM, BORDER_LEFT, BORDER_BLOCK, BORDER_INLINE,
  BORDER_IMAGE, FONT_SHORTHAND, LIST_STYLE, TEXT_DECORATION, FLEX, FLEX_FLOW, TRANSITION, ANIMATION,
  GRID, GRID_TEMPLATE, GRID_TEMPLATE_AREAS, OUTLINE, COLUMNS, COLUMN_RULE, OVERFLOW_BLOCK, OVERFLOW_INLINE,
  INSET_SHORTHAND,
] as readonly CssPropertyDef[];
