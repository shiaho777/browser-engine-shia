/**
 * display-classification.ts — the display/float/position classification the
 * layout stage shares between the tree builder (tree-builder.ts) and the
 * layout dispatcher (index.ts).
 *
 * The tree builder consumes the raw (`table-row` / `table-cell` /
 * `table-row-group`) display values as STRUCTURAL markers to wrap misplaced
 * content into anonymous tables/rows/cells (css-tables-3 fixup); the layout
 * dispatcher only ever sees values that have a real layout branch.
 */
import type { ComputedStyle, DomNode } from "@browser-engine/ir";

/**
 * The set of display values the layout dispatcher recognizes as real layout
 * branches. Legacy/vendor values are normalized INTO these by {@link readDisplay}.
 */
export const LAYOUT_DISPLAYS: ReadonlySet<string> = new Set([
  "block",
  "inline",
  "inline-block",
  "flex",
  "grid",
  "table",
  "none",
]);

/** Table-internal display values (css-tables-3) — structural, not layout branches. */
export const TABLE_ROW_DISPLAYS: ReadonlySet<string> = new Set(["table-row"]);
export const TABLE_ROW_GROUP_DISPLAYS: ReadonlySet<string> = new Set(["table-row-group"]);
export const TABLE_CELL_DISPLAYS: ReadonlySet<string> = new Set(["table-cell"]);

/**
 * Read the computed `display` and NORMALIZE legacy / vendor / inline-variant
 * values into a layout branch the engine actually implements:
 *
 *   - `-webkit-box` / `-webkit-inline-box` / `-ms-flexbox` / `-ms-inline-flexbox`
 *     / `-webkit-inline-flex` → `flex` (every modern browser maps old flexbox
 *     to standard flex).
 *   - `inline-flex` / `inline-grid` / `inline-table` → the inner layout
 *     (`flex` / `grid` / `table`); the inline *outer* role awaits a real inline
 *     formatting context, so the box currently participates as a block — but its
 *     CHILDREN get the correct inner layout, which is where the visible damage
 *     was (children stacking vertically instead of flowing along a flex axis).
 *   - `list-item` → `block` (list markers are not yet rendered).
 *   - `table-row` / `table-row-group` / `table-cell` pass through unchanged:
 *     they are structural markers the tree builder consumes (wrapping
 *     misplaced content); the layout dispatcher never branches on them.
 *
 * Unrecognized / absent values fall back to the initial `inline`.
 */
export function readDisplay(style: ComputedStyle): string {
  const value = style["display"];
  if (typeof value !== "string") {
    return "inline";
  }
  switch (value) {
    case "-webkit-box":
    case "-webkit-inline-box":
    case "-ms-flexbox":
    case "-ms-inline-flexbox":
    case "-webkit-inline-flex":
      return "flex";
    case "inline-flex":
      return "flex";
    case "inline-grid":
      return "grid";
    case "inline-table":
      return "table";
    case "list-item":
      return "block";
    default:
      return LAYOUT_DISPLAYS.has(value) ||
        TABLE_ROW_DISPLAYS.has(value) ||
        TABLE_ROW_GROUP_DISPLAYS.has(value) ||
        TABLE_CELL_DISPLAYS.has(value)
        ? value
        : "inline";
  }
}

/**
 * Is this child an INLINE-LEVEL box (a member of the inline formatting context)?
 * Text nodes always are; elements are when they are in-flow, non-floated, and
 * declare `display: inline` / `inline-block`. Everything else (block/flex/grid/
 * table/none, positioned, floated) is block-level and BREAKS an inline run.
 * The raw `display` value is consulted (not the normalized one) so `inline-block`
 * participates in the run while `inline-flex` (normalized to flex) does not.
 */
export function isInlineLevelChild(node: DomNode, style: ComputedStyle | null): boolean {
  if (node.kind === "text") {
    return true;
  }
  if (node.kind !== "element" || style === null) {
    return false;
  }
  if (readPosition(style) === "absolute" || readPosition(style) === "fixed") {
    return false;
  }
  if (readFloat(style) !== "none") {
    return false;
  }
  const display = style["display"];
  return display === "inline" || display === "inline-block";
}

/** The recognised `float` keywords; anything else (incl. absent) ⇒ `"none"`. */
export const FLOAT_VALUES: ReadonlySet<string> = new Set(["left", "right", "none"]);

/**
 * The computed `float` (initial `"none"`). Narrowed from the open index
 * signature; an absent or unrecognised value is the initial `"none"`, so a
 * non-floated element takes the normal-flow path unchanged.
 */
export function readFloat(style: ComputedStyle): "left" | "right" | "none" {
  const value = style["float"];
  if (typeof value === "string" && FLOAT_VALUES.has(value)) {
    return value as "left" | "right" | "none";
  }
  return "none";
}

/**
 * Read the `clear` keyword (initial `none`). Recognized values: `none`, `left`,
 * `right`, `both`, `inline-start`, `inline-end`. Anything else ⇒ `none`.
 */
export function readClear(style: ComputedStyle): string {
  const value = style["clear"];
  if (
    typeof value === "string" &&
    (value === "none" ||
      value === "left" ||
      value === "right" ||
      value === "both" ||
      value === "inline-start" ||
      value === "inline-end")
  ) {
    return value;
  }
  return "none";
}

/** The recognised `position` keywords; anything else (incl. absent) ⇒ `"static"`. */
export const POSITION_VALUES: ReadonlySet<string> = new Set([
  "static",
  "relative",
  "absolute",
  "fixed",
  "sticky",
]);

/**
 * The computed `position` (initial `"static"`). Narrowed from the open index
 * signature; an absent or unrecognised value is the initial `"static"`, so a
 * statically positioned element takes the normal-flow path unchanged. (Only
 * `relative` / `absolute` are acted on by the block branch today; `fixed` /
 * `sticky` fall back to static flow.)
 */
export function readPosition(style: ComputedStyle): "static" | "relative" | "absolute" | "fixed" {
  const value = style["position"];
  if (value === "relative") return "relative";
  if (value === "absolute") return "absolute";
  if (value === "fixed") return "fixed";
  if (typeof value === "string" && POSITION_VALUES.has(value)) return "static";
  return "static";
}

/** The element's display, classified for table fixup: is it a table row? */
export function isTableRow(node: DomNode, style: ComputedStyle | null): boolean {
  return (
    node.kind === "element" &&
    style !== null &&
    typeof style["display"] === "string" &&
    TABLE_ROW_DISPLAYS.has(style["display"])
  );
}

/** The element's display, classified for table fixup: is it a row group? */
export function isTableRowGroup(node: DomNode, style: ComputedStyle | null): boolean {
  return (
    node.kind === "element" &&
    style !== null &&
    typeof style["display"] === "string" &&
    TABLE_ROW_GROUP_DISPLAYS.has(style["display"])
  );
}

/** The element's display, classified for table fixup: is it a cell? */
export function isTableCell(node: DomNode, style: ComputedStyle | null): boolean {
  return (
    node.kind === "element" &&
    style !== null &&
    typeof style["display"] === "string" &&
    TABLE_CELL_DISPLAYS.has(style["display"])
  );
}

/** The element's display, classified for table fixup: is it a table root? */
export function isTableRoot(node: DomNode, style: ComputedStyle | null): boolean {
  return (
    node.kind === "element" &&
    style !== null &&
    style["display"] === "table"
  );
}
