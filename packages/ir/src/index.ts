/**
 * @browser-engine/ir
 *
 * Strongly-typed, immutable, nominally-branded inter-stage IR boundary
 * (design.md §6). Each pipeline stage produces exactly one frozen, branded IR
 * value; stages communicate ONLY through these values (single-direction data
 * flow), which makes v0-style cross-stage reverse reads and wrong-field reads
 * structurally impossible:
 *
 *   - Requirement 3.1 — every stage output (DomTree, StyleSheet, ComputedStyle,
 *     FragmentTree, DisplayList) is an immutable IR value with a *distinct*
 *     nominal brand (see `Branded` in `./brand.js`). The brand is phantom, so
 *     branding is free at runtime; immutability is enforced at runtime by
 *     `deepFreeze` (`./freeze.js`).
 *   - Requirement 3.3 — `ComputedStyle` carries NO geometry fields. Geometry
 *     types live in `./geometry.js` and appear only inside `FragmentTree` and
 *     paint commands; `./computed-style.js` does not import them at all.
 */
export const PACKAGE_NAME = "@browser-engine/ir" as const;

// ---- branding + runtime immutability --------------------------------------
export type { Branded, Px, NodeId, FragmentId } from "./brand.js";
export { px, nodeId, fragmentId } from "./brand.js";
export { deepFreeze } from "./freeze.js";

// ---- NotImplemented: the single sanctioned "unimplemented path" signal -----
// (design.md §2 bug#4, §12; Requirement 5). Stages and the wiring layer throw
// this to fail loudly instead of returning a placeholder; the Scoreboard reads
// the carried `feature`/`category` to mark a capability not implemented (5.4).
export type { NotImplementedCategory, NotImplementedOptions } from "./not-implemented.js";
export { NotImplemented, notImplemented, isNotImplemented } from "./not-implemented.js";

// ---- shared value + geometry types ----------------------------------------
export type { Color, DisplayValue, Edges, FlexDirection, FloatValue, PositionValue } from "./values.js";
export type { Rect, Point, BoxGeometry } from "./geometry.js";

// ---- stage 1: DOM ----------------------------------------------------------
export type { DomTree, DomNode, DomNodeKind } from "./dom.js";

// ---- stage 2: Stylesheet ---------------------------------------------------
export type {
  StyleSheet,
  StyleRule,
  Declaration,
  Selector,
  SelectorList,
  Specificity,
} from "./stylesheet.js";

// ---- stage 3: ComputedStyle (NO geometry — Requirement 3.3) ----------------
export type { ComputedStyle } from "./computed-style.js";

// ---- stage 4: FragmentTree (single source of geometry truth) ---------------
export type { FragmentTree, Fragment, LaidGlyph, TextRun } from "./fragment-tree.js";

// ---- stage 5: DisplayList --------------------------------------------------
export type {
  DisplayList,
  PaintCmd,
  BorderSide,
  Glyph,
  DecodedImage,
  Matrix,
} from "./display-list.js";
