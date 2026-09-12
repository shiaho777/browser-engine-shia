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
function tokens(value: string): string[] {
  return value.trim().replace(/\s+/g, " ").split(" ").filter((t) => t.length > 0);
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
// Flex shorthand: `flex: <grow> <shrink>? <basis>?`
// Expands to flex-grow, flex-shrink, flex-basis.
// ---------------------------------------------------------------------------

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
    // A bare number → grow (first) or shrink (second).
    if (/^[+-]?\d+\.?\d*$/.test(tok) || /^[+-]?\.\d+$/.test(tok)) {
      if (grow === null) {
        grow = tok;
      } else if (shrink === null) {
        shrink = tok;
      } else {
        return null; // too many numbers
      }
    } else {
      // A length or keyword → basis.
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
// `inset` + logical inset shorthands (CSS Logical Properties §5): 1-to-4
// values expanded per the CSS quad rules.
// ---------------------------------------------------------------------------

/** Expand a 1-to-4 physical-position quad: a → a a a a, a b → b b (Y X), … */
function expandQuad(
  value: string,
  props: readonly [string, string, string, string],
): readonly ExpandedDeclaration[] | null {
  const toks = tokens(value);
  if (toks.length < 1 || toks.length > 4) return null;
  const [a, b = a, c = a, d = b] = toks as [string, string?, string?, string?];
  const [top, right, bottom, left] = props;
  return [
    { property: top, value: a }, // top / block-start
    { property: right, value: b }, // right / inline-end
    { property: bottom, value: c }, // bottom / block-end
    { property: left, value: d }, // left / inline-start
  ];
}

function expandInset(value: string): readonly ExpandedDeclaration[] | null {
  return expandQuad(value, ["top", "right", "bottom", "left"]);
}

function expandInsetBlock(value: string): readonly ExpandedDeclaration[] | null {
  const toks = tokens(value);
  if (toks.length < 1 || toks.length > 2) return null;
  const start = toks[0]!;
  const end = toks[1] ?? start;
  return [
    { property: "inset-block-start", value: start },
    { property: "inset-block-end", value: end },
  ];
}

function expandInsetInline(value: string): readonly ExpandedDeclaration[] | null {
  const toks = tokens(value);
  if (toks.length < 1 || toks.length > 2) return null;
  const start = toks[0]!;
  const end = toks[1] ?? start;
  return [
    { property: "inset-inline-start", value: start },
    { property: "inset-inline-end", value: end },
  ];
}

// ---------------------------------------------------------------------------
// `overflow` (CSS Overflow §3): 1 or 2 keywords → overflow-x / overflow-y.
// ---------------------------------------------------------------------------

const OVERFLOW_KEYWORDS = new Set(["visible", "hidden", "clip", "scroll", "auto", "overlay"]);

function expandOverflow(value: string): readonly ExpandedDeclaration[] | null {
  const toks = tokens(value);
  if (toks.length < 1 || toks.length > 2) return null;
  for (const tok of toks) {
    if (!OVERFLOW_KEYWORDS.has(tok.toLowerCase())) return null;
  }
  const x = toks[0]!.toLowerCase();
  const y = (toks[1] ?? x).toLowerCase();
  // `overlay` is the deprecated synonym of `auto` (Chrome shipped it for
  // years before it merged into `auto`): normalize it away.
  return [
    { property: "overflow-x", value: x === "overlay" ? "auto" : x },
    { property: "overflow-y", value: y === "overlay" ? "auto" : y },
  ];
}

// ---------------------------------------------------------------------------
// `place-items` / `place-content` / `place-self` (Box Alignment §5): the first
// value is align-* (block axis), the second justify-* (inline axis); one value
// sets both. `place-content` additionally allows the two-value `<align>
// <justify>` form where a lone value is doubled.
// ---------------------------------------------------------------------------

function makePlaceExpander(alignProp: string, justifyProp: string): ShorthandExpander {
  return (value: string): readonly ExpandedDeclaration[] | null => {
    const toks = tokens(value);
    if (toks.length < 1 || toks.length > 2) return null;
    const align = toks[0]!;
    const justify = toks[1] ?? align;
    return [
      { property: alignProp, value: align },
      { property: justifyProp, value: justify },
    ];
  };
}

// ---------------------------------------------------------------------------
// `text-decoration` (CSS Text Decoration §2): 1-to-3 tokens in any order —
// line keywords (underline/overline/line-through/none, space-combinable),
// a style keyword, and a color.
// ---------------------------------------------------------------------------

const TEXT_DECORATION_LINE_KEYWORDS = new Set([
  "underline",
  "overline",
  "line-through",
  "blink",
  "none",
]);
const TEXT_DECORATION_STYLE_KEYWORDS = new Set(["solid", "double", "dotted", "dashed", "wavy"]);

function expandTextDecoration(value: string): readonly ExpandedDeclaration[] | null {
  const toks = tokens(value);
  if (toks.length < 1 || toks.length > 4) return null;
  const line: string[] = [];
  let style: string | null = null;
  let color: string | null = null;
  for (const tok of toks) {
    const lower = tok.toLowerCase();
    if (TEXT_DECORATION_LINE_KEYWORDS.has(lower)) {
      line.push(lower);
      continue;
    }
    if (TEXT_DECORATION_STYLE_KEYWORDS.has(lower)) {
      if (style !== null) return null; // duplicate style
      style = lower;
      continue;
    }
    if (classifyBorderToken(tok)?.kind === "color") {
      if (color !== null) return null; // duplicate color
      color = tok;
      continue;
    }
    return null; // unrecognized token
  }
  const out: ExpandedDeclaration[] = [];
  if (line.length > 0) out.push({ property: "text-decoration-line", value: line.join(" ") });
  if (style !== null) out.push({ property: "text-decoration-style", value: style });
  if (color !== null) out.push({ property: "text-decoration-color", value: color });
  return out.length > 0 ? out : null;
}

// ---------------------------------------------------------------------------
// `font` (CSS Fonts §4), the DOMINANT real-world forms only:
//   - system / caption / icon | menu | message-box | small-caption | status-bar
//     (system fonts: not expandable, returned as font-family — browsers expose
//     them on the shorthand; our layout only consumes the listed longhands)
//   - `[ <style> || <weight> ]? <size>[/<line-height>]? <family>`
//     with style/weight optional, line-height optional, family REQUIRED and
//     = everything after the size token (families contain spaces).
// ---------------------------------------------------------------------------

const FONT_STYLE_KEYWORDS = new Set(["normal", "italic", "oblique"]);
const FONT_WEIGHT_KEYWORDS = new Set(["normal", "bold", "bolder", "lighter"]);

function expandFont(value: string): readonly ExpandedDeclaration[] | null {
  const v = value.trim();
  if (v.length === 0) return null;

  // Split into top-level tokens, but the FINAL segment (the font family list)
  // is everything after the size(/line-height) token — keep it verbatim so
  // multi-word families and quoted names survive.
  const toks = tokens(v);
  if (toks.length === 0) return null;

  let style: string | null = null;
  let weight: string | null = null;
  let i = 0;

  // Leading style/weight keywords (either order, both optional).
  while (i < toks.length) {
    const tok = toks[i]!;
    const lower = tok.toLowerCase();
    if (style === null && FONT_STYLE_KEYWORDS.has(lower) && lower !== "normal") {
      style = lower;
      i += 1;
      continue;
    }
    if (weight === null && FONT_WEIGHT_KEYWORDS.has(lower) && lower !== "normal" && (style !== null || !FONT_STYLE_KEYWORDS.has(lower))) {
      weight = lower;
      i += 1;
      continue;
    }
    if (lower === "normal" && (style === null || weight === null)) {
      // `normal` can stand for either; if unset, record and continue.
      if (style === null) style = "normal";
      else if (weight === null) weight = "normal";
      i += 1;
      continue;
    }
    if (/^[+-]?\d+$/.test(tok) || /^[+-]?\d+\.\d+$/.test(tok)) {
      // A bare number before the size is the weight (e.g. `font: 700 16px …`).
      weight = tok;
      i += 1;
      continue;
    }
    break; // the size token must come next.
  }

  // The size token (optionally followed by /line-height). The size must NOT
  // itself contain `/` — otherwise `14px/1.5` would swallow the line-height.
  const rest = toks.slice(i).join(" ");
  const sizeMatch = /^([^\s/]+)(?:\s*\/\s*(\S+))?\s+(.+)$/.exec(rest);
  if (sizeMatch === null) {
    // System font keywords: keep as font-family (honest pass-through).
    if (toks.length === 1 && /^(system-ui|caption|icon|menu|message-box|small-caption|status-bar)$/i.test(toks[0]!)) {
      return [{ property: "font-family", value: toks[0]! }];
    }
    return null;
  }
  const size = sizeMatch[1]!;
  const lineHeight = sizeMatch[2] ?? null;
  const family = sizeMatch[3]!.trim();
  if (family.length === 0) return null;

  const out: ExpandedDeclaration[] = [];
  if (style !== null && style !== "normal") out.push({ property: "font-style", value: style });
  if (weight !== null && weight !== "normal") out.push({ property: "font-weight", value: weight });
  out.push({ property: "font-size", value: size });
  if (lineHeight !== null) out.push({ property: "line-height", value: lineHeight });
  out.push({ property: "font-family", value: family });
  return out;
}

// ---------------------------------------------------------------------------
// `background` shorthand (CSS Backgrounds §3.2), scoped honestly.
//
// The full grammar (multi-layer lists, position/size with `/`, repeat,
// attachment, clip/origin boxes) is a parser project of its own. This
// expander covers the single-layer value forms that dominate real
// stylesheets — a lone color, `none`, or a lone `url()` — and returns `null`
// for everything else (gradients, multi-layer lists, position/size combos),
// which the caller drops exactly like the previous behavior of keeping an
// unread `background` string the paint stage never consumed.
// ---------------------------------------------------------------------------

/** CSS named colors recognized inside `background` (mirrors the border list). */
const BACKGROUND_NAMED_COLORS = new Set([
  "black", "white", "red", "green", "blue", "transparent", "yellow", "orange",
  "purple", "pink", "gray", "grey", "cyan", "magenta", "silver", "maroon",
  "olive", "navy", "teal", "aqua", "fuchsia", "lime", "currentcolor",
]);

/** Split a `background` value into top-level COMMA-separated layers. */
function backgroundLayers(value: string): string[] {
  const layers: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value.trim()) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      layers.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim() !== "") layers.push(current.trim());
  return layers;
}

/** Split one layer into top-level whitespace-separated tokens (paren-aware). */
function backgroundTokens(layer: string): string[] {
  const toks: string[] = [];
  let depth = 0;
  let current = "";
  const flush = (): void => {
    if (current !== "") {
      toks.push(current);
      current = "";
    }
  };
  for (const ch of layer.trim()) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if ((ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f") && depth === 0) {
      flush();
    } else {
      current += ch;
    }
  }
  flush();
  return toks;
}

/** Is `token` a CSS color (hex, rgb()/hsl() function, named, transparent)? */
function isBackgroundColorToken(token: string): boolean {
  if (/^#[0-9a-fA-F]{3,8}$/.test(token)) return true;
  if (/^(rgba?|hsla?)\(.*\)$/i.test(token)) return true;
  return BACKGROUND_NAMED_COLORS.has(token.toLowerCase());
}

/**
 * Expand `background: <color> | none | url(...)` into `background-color`
 * (+ `background-image: none` for the `none` reset). Anything richer
 * returns `null` (caller drops it — same effective rendering as today).
 */
function expandBackground(value: string): readonly ExpandedDeclaration[] | null {
  const v = value.trim();
  if (v === "") return null;
  if (v.toLowerCase() === "none") {
    return [
      { property: "background-color", value: "transparent" },
      { property: "background-image", value: "none" },
    ];
  }
  if (backgroundLayers(v).length !== 1) return null; // multi-layer: out of scope.
  const toks = backgroundTokens(v);
  if (toks.length === 1) {
    const tok = toks[0] as string;
    if (isBackgroundColorToken(tok)) return [{ property: "background-color", value: tok }];
    if (/^url\(.*\)$/i.test(tok)) return [{ property: "background-image", value: tok }];
    // A lone var() reference cannot be classified here (custom properties
    // resolve later, per-winner, in the cascade): pass it through as the
    // color longhand so substitution still happens. If it resolves to a
    // color the background paints; anything else fails longhand parsing
    // and falls back exactly as an unrecognized value would.
    if (/^var\(.*\)$/i.test(tok)) return [{ property: "background-color", value: tok }];
  }
  return null;
}

// ---------------------------------------------------------------------------
// The shorthand→expander table.
// ---------------------------------------------------------------------------

const SHORTHAND_TABLE: Readonly<Record<string, ShorthandExpander>> = {
  background: expandBackground,
  border: expandBorder,
  "border-top": expandBorderEdge("top"),
  "border-right": expandBorderEdge("right"),
  "border-bottom": expandBorderEdge("bottom"),
  "border-left": expandBorderEdge("left"),
  "border-color": expandBorderColor,
  "border-style": expandBorderStyle,
  "border-width": expandBorderWidth,
  flex: expandFlex,
  gap: expandGap,
  "grid-gap": expandGap,
  "grid-row-gap": expandGridRowGap,
  "grid-column-gap": expandGridColumnGap,
  // Import wave (A5): high-frequency positional/2-value shorthands.
  inset: expandInset,
  "inset-block": expandInsetBlock,
  "inset-inline": expandInsetInline,
  overflow: expandOverflow,
  "overflow-block": (value) => [{ property: "overflow-y", value: value.trim().toLowerCase() }],
  "overflow-inline": (value) => [{ property: "overflow-x", value: value.trim().toLowerCase() }],
  "place-items": makePlaceExpander("align-items", "justify-items"),
  "place-content": makePlaceExpander("align-content", "justify-content"),
  "place-self": makePlaceExpander("align-self", "justify-self"),
  "text-decoration": expandTextDecoration,
  font: expandFont,
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
  for (const decl of decls) {
    const expanded = expandShorthand(decl.property, decl.value);
    if (expanded === null) {
      out.push(decl);
    } else {
      for (const e of expanded) {
        out.push({ property: e.property, value: e.value, important: decl.important });
      }
    }
  }
  return out;
}
