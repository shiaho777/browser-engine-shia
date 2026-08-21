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
// The shorthand→expander table.
// ---------------------------------------------------------------------------

const SHORTHAND_TABLE: Readonly<Record<string, ShorthandExpander>> = {
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
