/**
 * CSS shorthand expansion (design.md §8.5; ROADMAP Phase 2).
 *
 * A shorthand like `border: 1px solid red` declares THREE concepts (width,
 * style, color) that the cascade must resolve as separate longhand properties
 * (`border-top-width`, `border-top-style`, `border-top-color`, and the other
 * three edges). The CSS Cascade spec (§4.1) requires shorthands to expand
 * BEFORE the cascade sorts declarations, so a longhand can override one
 * component of a shorthand declared earlier.
 *
 * This module is the *mechanism*: a data-driven table of shorthand→longhand
 * expanders. Each expander takes the shorthand's raw value string and returns
 * a list of `{ property, value }` longhand declarations. The cascade calls
 * {@link expandShorthand} for every declaration it encounters; a non-shorthand
 * returns `null` (meaning "keep as-is").
 *
 * Adding a new shorthand = adding one expander function here. No change to the
 * cascade, the parser, or the data table (Requirement 6.5 spirit).
 */
import type { Declaration } from "@browser-engine/ir";

import {
  expandGrid,
  expandGridArea,
  expandGridColumn,
  expandGridRow,
  expandGridTemplate,
} from "./grid-shorthand.js";

/** A longhand declaration produced by shorthand expansion. */
export interface ExpandedDeclaration {
  readonly property: string;
  readonly value: string;
}

/** An expander: takes a shorthand value, returns longhand declarations or `null` if unparseable. */
export type ShorthandExpander = (value: string) => readonly ExpandedDeclaration[] | null;

// ---------------------------------------------------------------------------
// Value tokenization helpers.
// ---------------------------------------------------------------------------

/** Split a value string into top-level space-separated tokens (collapsing whitespace). */
/** Split on whitespace, keeping `calc(...)` and other parenthesized functions intact. */
function tokens(value: string): string[] {
  const out: string[] = [];
  let current = "";
  let depth = 0;
  for (const ch of value.trim()) {
    if (ch === "(") depth += 1;
    else if (ch === ")" && depth > 0) depth -= 1;
    if (depth === 0 && ch.trim() === "") {
      if (current.length > 0) out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** A `calc()` whose result is a number, not a length (`calc(2 + 1)`, not `calc(1px)`). */
function isUnitlessCalc(token: string): boolean {
  if (!/^calc\(/i.test(token) || !token.endsWith(")")) return false;
  return !/[a-z%]/i.test(token.slice(5, -1));
}

// ---------------------------------------------------------------------------
// Border-style keyword set (must match css-properties.data.ts LINE_STYLE_KEYWORDS).
// ---------------------------------------------------------------------------

const LINE_STYLES = new Set([
  "none",
  "hidden",
  "dotted",
  "dashed",
  "solid",
  "double",
  "groove",
  "ridge",
  "inset",
  "outset",
]);

// ---------------------------------------------------------------------------
// Border shorthand: `border: <width> <style> <color>` (any order, all optional).
// Expands to all 12 longhands (4 edges × 3 components).
// ---------------------------------------------------------------------------

/**
 * Classify a single border shorthand token as width, style, or color.
 * Returns at most one classification per token (border spec: ambiguous → style
 * wins for keywords like `solid`, then color for named/hex, then width).
 */
function classifyBorderToken(
  token: string,
): { kind: "width"; value: string } | { kind: "style"; value: string } | { kind: "color"; value: string } | null {
  // Style keyword?
  if (LINE_STYLES.has(token.toLowerCase())) {
    return { kind: "style", value: token.toLowerCase() };
  }
  // A bare 0 or a length (px/em/etc.)?
  if (token === "0" || /^[+-]?(\d+\.?\d*|\.\d+)(px|em|rem|vw|vh|vmin|vmax|pt|pc|in|cm|mm|q)?$/.test(token)) {
    return { kind: "width", value: token };
  }
  // A color: named, hex, or rgb()/rgba()?
  if (
    token.startsWith("#") ||
    /^rgba?\(/i.test(token) ||
    /^(black|white|red|green|blue|transparent|yellow|orange|purple|pink|gray|grey|cyan|magenta|silver|maroon|olive|navy|teal|aqua|fuchsia|lime)$/i.test(token)
  ) {
    return { kind: "color", value: token };
  }
  // Could also be a `thin`/`medium`/`thick` width keyword.
  if (/^(thin|medium|thick)$/i.test(token)) {
    return { kind: "width", value: token.toLowerCase() };
  }
  return null;
}

/**
 * Expand `border: <width>? <style>? <color>?` into 12 longhand declarations.
 * Tokens may appear in any order; each component is optional (omitted → `initial`).
 */
function expandBorder(value: string): readonly ExpandedDeclaration[] | null {
  const toks = tokens(value);
  if (toks.length === 0 || toks.length > 3) return null;

  let width: string | null = null;
  let style: string | null = null;
  let colorVal: string | null = null;

  for (const tok of toks) {
    const classified = classifyBorderToken(tok);
    if (classified === null) return null;
    switch (classified.kind) {
      case "width":
        if (width !== null) return null; // duplicate
        width = classified.value;
        break;
      case "style":
        if (style !== null) return null;
        style = classified.value;
        break;
      case "color":
        if (colorVal !== null) return null;
        colorVal = classified.value;
        break;
    }
  }

  const out: ExpandedDeclaration[] = [];
  for (const edge of ["top", "right", "bottom", "left"] as const) {
    if (width !== null) out.push({ property: `border-${edge}-width`, value: width });
    if (style !== null) out.push({ property: `border-${edge}-style`, value: style });
    if (colorVal !== null) out.push({ property: `border-${edge}-color`, value: colorVal });
  }
  return out;
}

/**
 * Expand `border-top/right/bottom/left: <width>? <style>? <color>?` into 3 longhands.
 */
function expandBorderEdge(edge: string): ShorthandExpander {
  return (value: string): readonly ExpandedDeclaration[] | null => {
    const toks = tokens(value);
    if (toks.length === 0 || toks.length > 3) return null;

    let width: string | null = null;
    let style: string | null = null;
    let colorVal: string | null = null;

    for (const tok of toks) {
      const classified = classifyBorderToken(tok);
      if (classified === null) return null;
      switch (classified.kind) {
        case "width":
          if (width !== null) return null;
          width = classified.value;
          break;
        case "style":
          if (style !== null) return null;
          style = classified.value;
          break;
        case "color":
          if (colorVal !== null) return null;
          colorVal = classified.value;
          break;
      }
    }

    const out: ExpandedDeclaration[] = [];
    if (width !== null) out.push({ property: `border-${edge}-width`, value: width });
    if (style !== null) out.push({ property: `border-${edge}-style`, value: style });
    if (colorVal !== null) out.push({ property: `border-${edge}-color`, value: colorVal });
    return out;
  };
}

// ---------------------------------------------------------------------------
// Logical shorthands (CSS Logical §4): expand into LOGICAL longhands —
// `margin-block: a b` → margin-block-start + margin-block-end. The cascade
// then maps the logical names onto physical ones per the element's
// writing-mode (RFC 0025), so source order stays honest.
// ---------------------------------------------------------------------------

/**
 * `inset` / `margin`: a 1-to-4 edge list. Each token is a length or `auto`.
 * `inset` expands to the physical sides; `margin` expands to its longhands
 * so one side can override the shorthand.
 */
function expandBoxEdges(
  topName: string,
  rightName: string,
  bottomName: string,
  leftName: string,
): ShorthandExpander {
  return (value: string): readonly ExpandedDeclaration[] | null => {
    const parts = tokens(value);
    if (parts.length < 1 || parts.length > 4) return null;
    const lengthOrAuto = /^(?:auto|0|[+-]?(?:\d+\.?\d*|\.\d+)(?:px|em|rem|ex|ch|ic|vw|vh|vmin|vmax|pt|pc|in|cm|mm|q|%)?)$/i;
    if (!parts.every((part) => lengthOrAuto.test(part))) return null;
    const top = parts[0]!;
    const right = parts[1] ?? top;
    const bottom = parts.length >= 3 ? parts[2]! : top;
    const left = parts.length === 4 ? parts[3]! : parts.length >= 2 ? right : top;
    return [
      { property: topName, value: top },
      { property: rightName, value: right },
      { property: bottomName, value: bottom },
      { property: leftName, value: left },
    ];
  };
}

/** `X-block|X-inline: <a> <b>?` → `X-{block|inline}-start` + `-end`. */
function expandLogicalPair(stem: string): ShorthandExpander {
  return (value: string): readonly ExpandedDeclaration[] | null => {
    const parts = value.trim().split(/\s+/).filter((p) => p.length > 0);
    if (parts.length === 0 || parts.length > 2) return null;
    const start = parts[0]!;
    const end = parts[1] ?? start;
    return [
      { property: `${stem}-start`, value: start },
      { property: `${stem}-end`, value: end },
    ];
  };
}

/** `border-{block|inline}-{width|style|color}` → start + end longhands. */
function expandBorderLogicalSuffix(axis: "block" | "inline", suffix: string): ShorthandExpander {
  return (value: string): readonly ExpandedDeclaration[] | null => {
    const v = value.trim();
    if (v === "") return null;
    return [
      { property: `border-${axis}-start-${suffix}`, value: v },
      { property: `border-${axis}-end-${suffix}`, value: v },
    ];
  };
}

/**
 * `border-block` / `border-inline`: a border shorthand for BOTH edges of one
 * axis — same token classification as `border`, emitted as logical longhands.
 */
function expandBorderLogical(axis: "block" | "inline"): ShorthandExpander {
  return (value: string): readonly ExpandedDeclaration[] | null => {
    const toks = tokens(value);
    if (toks.length === 0 || toks.length > 3) return null;
    let width: string | null = null;
    let style: string | null = null;
    let colorVal: string | null = null;
    for (const tok of toks) {
      const classified = classifyBorderToken(tok);
      if (classified === null) return null;
      if (classified.kind === "width") {
        if (width !== null) return null;
        width = classified.value;
      } else if (classified.kind === "style") {
        if (style !== null) return null;
        style = classified.value;
      } else {
        if (colorVal !== null) return null;
        colorVal = classified.value;
      }
    }
    const out: ExpandedDeclaration[] = [];
    for (const side of ["start", "end"] as const) {
      if (width !== null) out.push({ property: `border-${axis}-${side}-width`, value: width });
      if (style !== null) out.push({ property: `border-${axis}-${side}-style`, value: style });
      if (colorVal !== null) out.push({ property: `border-${axis}-${side}-color`, value: colorVal });
    }
    return out;
  };
}

/**
 * Expand `flex: <grow> <shrink>? <basis>?` into flex-grow, flex-shrink, flex-basis.
 *
 * Spec (CSS Flexbox §1.1): `flex: none` → `0 0 auto`; a single number → grow
 * (shrink=1, basis=0%); two numbers → grow + shrink (basis=0%); a number then a
 * width → grow + basis; `auto` → `1 1 auto`; initial → `0 1 auto`.
 */
function expandFlex(value: string): readonly ExpandedDeclaration[] | null {
  const toks = tokens(value);
  if (toks.length === 0 || toks.length > 3) return null;

  // Special keyword forms.
  const single = toks[0]!.toLowerCase();
  if (toks.length === 1) {
    if (single === "none") {
      return [
        { property: "flex-grow", value: "0" },
        { property: "flex-shrink", value: "0" },
        { property: "flex-basis", value: "auto" },
      ];
    }
    if (single === "auto") {
      return [
        { property: "flex-grow", value: "1" },
        { property: "flex-shrink", value: "1" },
        { property: "flex-basis", value: "auto" },
      ];
    }
    if (single === "initial") {
      return [
        { property: "flex-grow", value: "0" },
        { property: "flex-shrink", value: "1" },
        { property: "flex-basis", value: "auto" },
      ];
    }
  }

  let grow: string | null = null;
  let shrink: string | null = null;
  let basis: string | null = null;

  for (const tok of toks) {
    // A bare number, or a unitless calc(), is grow then shrink. A third number
    // is not a basis (`flex: 1 2 calc(0)` is invalid).
    const numeric = /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(tok) || isUnitlessCalc(tok);
    if (numeric) {
      // A bare 0 after grow and shrink is a <length> basis (`flex: 1 2 0`).
      // Any other third number (`flex: 2 3 4`, `flex: 1 2 calc(0)`) is invalid.
      if (grow !== null && shrink !== null && basis === null && /^0(?:\.0+)?$/.test(tok)) {
        basis = tok;
      } else if (grow === null) {
        grow = tok;
      } else if (shrink === null) {
        shrink = tok;
      } else {
        return null;
      }
    } else {
      if (basis !== null) return null;
      basis = tok;
    }
  }

  // Defaults per spec.
  if (grow === null) grow = "1"; // `flex: <basis>` → grow=1
  if (shrink === null) shrink = "1";
  if (basis === null) basis = "0%"; // grow/shrink without basis → 0%

  return [
    { property: "flex-grow", value: grow },
    { property: "flex-shrink", value: shrink },
    { property: "flex-basis", value: basis },
  ];
}

const FLEX_FLOW_DIRECTION = new Set(["row", "row-reverse", "column", "column-reverse"]);
const FLEX_FLOW_WRAP = new Set(["nowrap", "wrap", "wrap-reverse", "balance"]);

/** `flex-flow: <flex-direction> || <flex-wrap>`. A missing side stays at its initial. */
function expandFlexFlow(value: string): readonly ExpandedDeclaration[] | null {
  const toks = tokens(value).map((tok) => tok.toLowerCase());
  if (toks.length < 1 || toks.length > 2) return null;
  let direction: string | null = null;
  let wrap: string | null = null;
  for (const tok of toks) {
    if (direction === null && FLEX_FLOW_DIRECTION.has(tok)) direction = tok;
    else if (wrap === null && FLEX_FLOW_WRAP.has(tok)) wrap = tok;
    else return null;
  }
  if (direction === null && wrap === null) return null;
  return [
    { property: "flex-direction", value: direction ?? "row" },
    { property: "flex-wrap", value: wrap ?? "nowrap" },
  ];
}

/** Longhands a shorthand resets. Absent when `property` is not one of these. */
export function shorthandLonghands(property: string): readonly string[] | null {
  switch (property) {
    case "flex":
      return ["flex-grow", "flex-shrink", "flex-basis"];
    case "flex-flow":
      return ["flex-direction", "flex-wrap"];
    case "grid":
      return [
        "grid-template-rows",
        "grid-template-columns",
        "grid-template-areas",
        "grid-auto-rows",
        "grid-auto-columns",
        "grid-auto-flow",
      ];
    case "grid-template":
      return ["grid-template-rows", "grid-template-columns", "grid-template-areas"];
    case "grid-area":
      return ["grid-row-start", "grid-column-start", "grid-row-end", "grid-column-end"];
    case "grid-column":
      return ["grid-column-start", "grid-column-end"];
    case "grid-row":
      return ["grid-row-start", "grid-row-end"];
    default:
      return null;
  }
}

/**
 * Specified `flex-flow` serialization. An initial longhand is omitted, except
 * that the all-initial value is `row` (not the empty string, and not `row nowrap`).
 */
export function serializeFlexFlow(direction: string, wrap: string): string {
  const dir = direction === "" ? "row" : direction;
  const wr = wrap === "" ? "nowrap" : wrap;
  if (wr === "nowrap") return dir;
  if (dir === "row") return wr;
  return `${dir} ${wr}`;
}

// ---------------------------------------------------------------------------
// border-color / border-style / border-width shorthands.
// These expand to the 4 per-edge longhands using the 1-to-4 edge expansion rules.
// ---------------------------------------------------------------------------

/** Parse a 1-to-4 token list into 4 edges per CSS shorthand rules. */
function expandEdgeTokens(toks: string[]): [string, string, string, string] | null {
  if (toks.length < 1 || toks.length > 4) return null;
  const [a, b = a, c = a, d = b] = toks;
  return [a!, b!, c!, d!];
}

/** Expand `border-color: <1-4 colors>` into 4 per-edge color longhands. */
function expandBorderColor(value: string): readonly ExpandedDeclaration[] | null {
  const toks = tokens(value);
  const edges = expandEdgeTokens(toks);
  if (edges === null) return null;
  const [top, right, bottom, left] = edges;
  return [
    { property: "border-top-color", value: top },
    { property: "border-right-color", value: right },
    { property: "border-bottom-color", value: bottom },
    { property: "border-left-color", value: left },
  ];
}

/** Expand `border-style: <1-4 styles>` into 4 per-edge style longhands. */
function expandBorderStyle(value: string): readonly ExpandedDeclaration[] | null {
  const toks = tokens(value);
  const edges = expandEdgeTokens(toks);
  if (edges === null) return null;
  const [top, right, bottom, left] = edges;
  return [
    { property: "border-top-style", value: top },
    { property: "border-right-style", value: right },
    { property: "border-bottom-style", value: bottom },
    { property: "border-left-style", value: left },
  ];
}

/** Expand `border-width: <1-4 widths>` into 4 per-edge width longhands. */
function expandBorderWidth(value: string): readonly ExpandedDeclaration[] | null {
  const toks = tokens(value);
  const edges = expandEdgeTokens(toks);
  if (edges === null) return null;
  const [top, right, bottom, left] = edges;
  return [
    { property: "border-top-width", value: top },
    { property: "border-right-width", value: right },
    { property: "border-bottom-width", value: bottom },
    { property: "border-left-width", value: left },
  ];
}


function expandGap(value: string): readonly ExpandedDeclaration[] | null {
  const toks = tokens(value);
  if (toks.length < 1 || toks.length > 2) return null;
  const row = toks[0]!;
  const col = toks[1] ?? row;
  return [
    { property: "row-gap", value: row },
    { property: "column-gap", value: col },
  ];
}

function expandGridRowGap(value: string): readonly ExpandedDeclaration[] | null {
  const v = value.trim();
  if (v.length === 0) return null;
  return [{ property: "row-gap", value: v }];
}

function expandGridColumnGap(value: string): readonly ExpandedDeclaration[] | null {
  const v = value.trim();
  if (v.length === 0) return null;
  return [{ property: "column-gap", value: v }];
}

// ---------------------------------------------------------------------------
// font-variant shorthand (RFC 0006): tokens route to the five longhands.
// Functional notations (`styleset(1, 2)`) carry inner whitespace → tokenize
// with parenthesis awareness.
// ---------------------------------------------------------------------------

/** Split on whitespace NOT inside parentheses. */
function functionAwareTokens(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i <= value.length; i += 1) {
    const ch = value[i];
    const ws = ch === undefined || ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
    if (!ws && start === -1) start = i;
    if (ch === "(") depth += 1;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ws && start !== -1 && depth === 0) {
      out.push(value.slice(start, i));
      start = -1;
    }
  }
  return out;
}

const VARIANT_LIGATURE_KEYS = new Set([
  "common-ligatures", "no-common-ligatures", "discretionary-ligatures",
  "no-discretionary-ligatures", "historical-ligatures", "no-historical-ligatures",
  "contextual", "no-contextual",
]);
const VARIANT_CAPS_KEYS = new Set([
  "small-caps", "all-small-caps", "petite-caps", "all-petite-caps", "unicase", "titling-caps",
]);
const VARIANT_NUMERIC_KEYS = new Set([
  "lining-nums", "oldstyle-nums", "proportional-nums", "tabular-nums",
  "diagonal-fractions", "stacked-fractions", "ordinal", "slashed-zero",
]);
const VARIANT_EAST_ASIAN_KEYS = new Set([
  "jis78", "jis83", "jis90", "jis04", "simplified", "traditional",
  "full-width", "proportional-width", "ruby",
]);
const VARIANT_POSITION_KEYS = new Set(["sub", "sup"]);
const VARIANT_ALTERNATE_FNS = /^(stylistic|styleset|character-variant|swash|ornaments|annotation)\(.*\)$/is;

/**
 * Expand `font-variant: <tokens>` → the five `font-variant-*` longhands.
 * `normal` resets every longhand; `none` disables ligatures only (spec: all
 * other longhands get `normal`).
 */
function expandFontVariant(value: string): readonly ExpandedDeclaration[] | null {
  const toks = functionAwareTokens(value.trim().toLowerCase());
  if (toks.length === 0) return null;
  if (toks.length === 1 && toks[0] === "normal") {
    return [
      { property: "font-variant-ligatures", value: "normal" },
      { property: "font-variant-caps", value: "normal" },
      { property: "font-variant-numeric", value: "normal" },
      { property: "font-variant-east-asian", value: "normal" },
      { property: "font-variant-position", value: "normal" },
      { property: "font-variant-alternates", value: "normal" },
    ];
  }
  if (toks.length === 1 && toks[0] === "none") {
    return [{ property: "font-variant-ligatures", value: "none" }];
  }
  const bucket = new Map<string, string[]>();
  for (const tok of toks) {
    const prop = VARIANT_LIGATURE_KEYS.has(tok)
      ? "font-variant-ligatures"
      : VARIANT_CAPS_KEYS.has(tok)
        ? "font-variant-caps"
        : VARIANT_NUMERIC_KEYS.has(tok)
          ? "font-variant-numeric"
          : VARIANT_EAST_ASIAN_KEYS.has(tok)
            ? "font-variant-east-asian"
            : VARIANT_POSITION_KEYS.has(tok)
              ? "font-variant-position"
              : tok === "historical-forms" || VARIANT_ALTERNATE_FNS.test(tok)
                ? "font-variant-alternates"
                : null;
    if (prop === null) return null; // an unknown token invalidates the whole value.
    const list = bucket.get(prop) ?? [];
    list.push(tok);
    bucket.set(prop, list);
  }
  const out: ExpandedDeclaration[] = [];
  for (const [prop, list] of bucket) {
    out.push({ property: prop, value: list.join(" ") });
  }
  return out;
}

// ---------------------------------------------------------------------------
// `background` — the layered shorthand (RFC 0008). Each comma layer carries
// `[ <bg-image> || <position> [ / <bg-size> ]? || <repeat> || <attachment> ||
// <box>{1,2} ]`; only the FINAL layer may also carry `<bg-color>`.
// ---------------------------------------------------------------------------

const BG_REPEAT_KEYS = new Set(["repeat", "repeat-x", "repeat-y", "no-repeat", "space", "round"]);
const BG_ATTACHMENT_KEYS = new Set(["scroll", "fixed", "local"]);
const BG_BOX_KEYS = new Set(["border-box", "padding-box", "content-box"]);

/** Split on top-level commas (paren-aware). */
function commaSplit(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      out.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(value.slice(start).trim());
  return out.filter((s) => s.length > 0);
}

/** `url(...)`, `rgb(...)` etc. or `#hex` or a named color → layer color token. */
function isColorToken(t: string): boolean {
  return (
    t.startsWith("#") ||
    /^(rgb|hsl|hwb|lab|lch|oklab|oklch|color)a?\(/i.test(t) ||
    /^(black|white|red|green|blue|transparent|yellow|orange|purple|pink|gray|grey|cyan|magenta|silver|maroon|olive|navy|teal|aqua|fuchsia|lime|currentcolor)$/i.test(t)
  );
}

/**
 * Expand `background: <layer>[, <layer>]*` into the longhand lists. Position
 * and size share a `/`; box keywords go origin→clip in order; a color is legal
 * only in the final layer. Any unparseable layer → `null` (the declaration is
 * dropped, matching invalid-value recovery).
 */
function expandBackground(value: string): readonly ExpandedDeclaration[] | null {
  const layers = commaSplit(value);
  if (layers.length === 0) return null;
  const images: string[] = [];
  const positions: string[] = [];
  const sizesOut: string[] = [];
  const repeats: string[] = [];
  const attachments: string[] = [];
  const origins: string[] = [];
  const clips: string[] = [];
  let color: string | null = null;
  for (let li = 0; li < layers.length; li += 1) {
    const last = li === layers.length - 1;
    const toks = functionAwareTokens(layers[li]!);
    if (toks.length === 0) return null;
    let image: string | null = null;
    const pos: string[] = [];
    const size: string[] = [];
    const rep: string[] = [];
    const box: string[] = [];
    let attach: string | null = null;
    let slash = false;
    for (const tok of toks) {
      if (tok === "/") { slash = true; continue; }
      const lower = tok.toLowerCase();
      if (lower === "none" || /^url\(/i.test(tok)) {
        if (image !== null) return null;
        image = tok;
        continue;
      }
      if (isColorToken(tok)) {
        if (!last || color !== null) return null;
        color = tok;
        continue;
      }
      if (BG_REPEAT_KEYS.has(lower)) { rep.push(lower); continue; }
      if (BG_ATTACHMENT_KEYS.has(lower)) {
        if (attach !== null) return null;
        attach = lower;
        continue;
      }
      if (BG_BOX_KEYS.has(lower)) { box.push(lower); continue; }
      // `pos / size` may arrive glued inside one token ("center/cover").
      const parts = tok.split("/");
      if (parts.length > 2) return null;
      const [posPart, sizePart] = parts;
      if (posPart !== undefined && posPart !== "") {
        (slash ? size : pos).push(posPart);
      }
      if (sizePart !== undefined && sizePart !== "") {
        slash = true;
        size.push(sizePart);
      }
    }
    if (size.length > 0 && pos.length === 0) return null; // size without position is invalid
    images.push(image ?? "none");
    positions.push(pos.length > 0 ? pos.join(" ") : "0% 0%");
    sizesOut.push(size.length > 0 ? size.join(" ") : "auto");
    repeats.push(rep.length > 0 ? rep.join(" ") : "repeat");
    attachments.push(attach ?? "scroll");
    origins.push(box[0] ?? "padding-box");
    clips.push(box[1] ?? box[0] ?? "border-box");
  }
  const out: ExpandedDeclaration[] = [
    { property: "background-image", value: images.join(", ") },
    { property: "background-position", value: positions.join(", ") },
    { property: "background-size", value: sizesOut.join(", ") },
    { property: "background-repeat", value: repeats.join(", ") },
    { property: "background-attachment", value: attachments.join(", ") },
    { property: "background-origin", value: origins.join(", ") },
    { property: "background-clip", value: clips.join(", ") },
  ];
  if (color !== null) out.push({ property: "background-color", value: color });
  return out;
}

// ---------------------------------------------------------------------------
// `font` shorthand (CSS Fonts §2.1).
//
//   font: [ <style> || <variant> || <weight> || <stretch> ]? <size> [ / <line-height> ]? <family>
//
// Omitted sub-properties reset to their initial values. `font-weight` is
// emitted as an integer because that longhand's grammar does not accept the
// `normal` / `bold` keywords. System-font keywords stay unexpanded.
// ---------------------------------------------------------------------------

const FONT_SYSTEM = new Set([
  "caption", "icon", "menu", "message-box", "small-caption", "status-bar",
]);
const FONT_STRETCHES = new Set([
  "ultra-condensed", "extra-condensed", "condensed", "semi-condensed",
  "semi-expanded", "expanded", "extra-expanded", "ultra-expanded",
]);

function isFontSizeToken(token: string): boolean {
  if (token === "0") return true;
  return /^(?:[+-]?(?:\d+\.?\d*|\.\d+))(?:px|em|rem|ex|ch|ic|vw|vh|vmin|vmax|pt|pc|in|cm|mm|q|%)$/i.test(token);
}

function isFontLineHeight(token: string): boolean {
  if (/^normal$/i.test(token)) return true;
  return /^(?:0|[+-]?(?:\d+\.?\d*|\.\d+))(?:px|em|rem|ex|ch|ic|vw|vh|vmin|vmax|pt|pc|in|cm|mm|q|%)?$/i.test(token);
}

/** `bold` → `700`. Relative keywords collapse to the same absolute stand-ins layout already uses. */
function fontWeightNumber(token: string): string | null {
  const lower = token.toLowerCase();
  if (lower === "normal" || lower === "lighter") return "400";
  if (lower === "bold" || lower === "bolder") return "700";
  if (/^[1-9]\d{0,2}$/.test(lower) || lower === "1000") {
    const n = Number(lower);
    if (n >= 1 && n <= 1000) return String(n);
  }
  return null;
}

/** Quote-aware tokens. `/` and `,` are their own tokens so `20px/1` splits. */
function fontTokens(value: string): string[] | null {
  const out: string[] = [];
  let i = 0;
  while (i < value.length) {
    const ch = value[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f") {
      i += 1;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      const start = i;
      i += 1;
      while (i < value.length && value[i] !== ch) i += 1;
      if (i >= value.length) return null;
      i += 1;
      out.push(value.slice(start, i));
      continue;
    }
    if (ch === "/" || ch === ",") {
      out.push(ch);
      i += 1;
      continue;
    }
    const start = i;
    while (i < value.length) {
      const c = value[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "/" || c === ",") break;
      i += 1;
    }
    out.push(value.slice(start, i));
  }
  return out;
}

function expandFont(value: string): readonly ExpandedDeclaration[] | null {
  const trimmed = value.trim();
  if (trimmed === "" || FONT_SYSTEM.has(trimmed.toLowerCase())) return null;
  const toks = fontTokens(trimmed);
  if (toks === null || toks.length < 2) return null;

  let style: string | null = null;
  let variant: string | null = null;
  let weight: string | null = null;
  let stretch: string | null = null;
  let i = 0;
  while (i < toks.length && !isFontSizeToken(toks[i]!)) {
    const tok = toks[i]!;
    const lower = tok.toLowerCase();
    if (lower === "normal") {
      i += 1;
      continue;
    }
    if ((lower === "italic" || lower === "oblique") && style === null) {
      style = lower;
      i += 1;
      continue;
    }
    if (lower === "small-caps" && variant === null) {
      variant = "small-caps";
      i += 1;
      continue;
    }
    const asWeight = fontWeightNumber(tok);
    if (asWeight !== null && weight === null) {
      weight = asWeight;
      i += 1;
      continue;
    }
    if (FONT_STRETCHES.has(lower) && stretch === null) {
      stretch = lower;
      i += 1;
      continue;
    }
    return null;
  }
  if (i >= toks.length || !isFontSizeToken(toks[i]!)) return null;
  const size = toks[i]!;
  i += 1;
  let lineHeight: string | null = null;
  if (i < toks.length && toks[i] === "/") {
    i += 1;
    const lh = toks[i];
    if (lh === undefined || !isFontLineHeight(lh)) return null;
    lineHeight = lh;
    i += 1;
  }
  if (i >= toks.length) return null;
  let family = "";
  for (const tok of toks.slice(i)) {
    if (tok === ",") {
      family = family.replace(/\s*$/, "") + ", ";
    } else if (family === "" || family.endsWith(", ")) {
      family += tok;
    } else {
      family += ` ${tok}`;
    }
  }
  if (family.trim() === "" || family.endsWith(", ")) return null;

  return [
    { property: "font-style", value: style ?? "normal" },
    { property: "font-variant", value: variant ?? "normal" },
    { property: "font-weight", value: weight ?? "400" },
    { property: "font-stretch", value: stretch ?? "normal" },
    { property: "font-size", value: size },
    { property: "line-height", value: lineHeight ?? "normal" },
    { property: "font-family", value: family.trim() },
  ];
}

// ---------------------------------------------------------------------------
// The shorthand→expander table.
// ---------------------------------------------------------------------------

const SHORTHAND_TABLE: Readonly<Record<string, ShorthandExpander>> = {
  border: expandBorder,
  "border-top": expandBorderEdge("top"),
  "border-right": expandBorderEdge("right"),
  "border-bottom": expandBorderEdge("bottom"),
  "border-left": expandBorderEdge("left"),
  // CSS Logical edge shorthands (RFC 0025): expand to logical longhands;
  // the cascade maps them to physical names per writing-mode/direction.
  "border-block": expandBorderLogical("block"),
  "border-inline": expandBorderLogical("inline"),
  "border-block-start": expandBorderEdge("block-start"),
  "border-block-end": expandBorderEdge("block-end"),
  "border-inline-start": expandBorderEdge("inline-start"),
  "border-inline-end": expandBorderEdge("inline-end"),
  "border-block-width": expandBorderLogicalSuffix("block", "width"),
  "border-block-style": expandBorderLogicalSuffix("block", "style"),
  "border-block-color": expandBorderLogicalSuffix("block", "color"),
  "border-inline-width": expandBorderLogicalSuffix("inline", "width"),
  "border-inline-style": expandBorderLogicalSuffix("inline", "style"),
  "border-inline-color": expandBorderLogicalSuffix("inline", "color"),
  "margin-block": expandLogicalPair("margin-block"),
  "margin-inline": expandLogicalPair("margin-inline"),
  "padding-block": expandLogicalPair("padding-block"),
  "padding-inline": expandLogicalPair("padding-inline"),
  "inset-block": expandLogicalPair("inset-block"),
  "inset-inline": expandLogicalPair("inset-inline"),
  inset: expandBoxEdges("top", "right", "bottom", "left"),
  margin: expandBoxEdges("margin-top", "margin-right", "margin-bottom", "margin-left"),
  "border-color": expandBorderColor,
  "border-style": expandBorderStyle,
  "border-width": expandBorderWidth,
  flex: expandFlex,
  "flex-flow": expandFlexFlow,
  grid: expandGrid,
  "grid-template": expandGridTemplate,
  "grid-area": expandGridArea,
  "grid-column": expandGridColumn,
  "grid-row": expandGridRow,
  gap: expandGap,
  "grid-gap": expandGap,
  "grid-row-gap": expandGridRowGap,
  "grid-column-gap": expandGridColumnGap,
  "font-variant": expandFontVariant,
  font: expandFont,
  background: expandBackground,
  "-webkit-line-clamp": (value: string) => [{ property: "line-clamp", value: value.trim().toLowerCase() === "none" ? "0" : value }],
};

/**
 * If `property` is a shorthand, expand its `value` into longhand declarations.
 * Returns `null` for a non-shorthand (the caller keeps it as-is) or when the
 * shorthand value cannot be parsed (the caller treats it as no declaration,
 * matching the CSS parser's invalid-value-recovery behavior).
 */
export function expandShorthand(
  property: string,
  value: string,
): readonly ExpandedDeclaration[] | null {
  const expander = SHORTHAND_TABLE[property];
  if (expander === undefined) {
    return null;
  }
  return expander(value);
}

/**
 * Expand all shorthands in a list of declarations, producing a new list where
 * every shorthand is replaced by its longhand declarations. Non-shorthand
 * declarations pass through unchanged. A shorthand whose value fails to expand
 * is dropped (matching CSS error recovery). Declaration order is preserved
 * (longhands from a shorthand appear in the shorthand's position, in the order
 * the expander emits them).
 *
 * The `important` flag and the cascade metadata (`specificity`, `seq`) are
 * carried through unchanged — the caller attaches them after expansion.
 */
export function expandDeclarations(
  decls: readonly Declaration[],
): readonly Declaration[] {
  const out: Declaration[] = [];
  const pushExpanded = (decl: Declaration): void => {
    const expanded = expandShorthand(decl.property, decl.value);
    if (expanded === null) {
      out.push(decl);
      return;
    }
    // A shorthand may emit another shorthand (`font` → `font-variant`).
    for (const e of expanded) {
      pushExpanded({ property: e.property, value: e.value, important: decl.important });
    }
  };
  for (const decl of decls) {
    pushExpanded(decl);
  }
  return out;
}
