/**
 * Geometry value types (design.md §6).
 *
 * IMPORTANT: every type in this file is geometry. By construction these types
 * appear ONLY inside `FragmentTree` (via `BoxGeometry`) and inside abstract
 * paint commands. They MUST NOT be referenced by `ComputedStyle`
 * (Requirement 3.3): the FragmentTree is the single source of truth for
 * geometry, so `getBoundingClientRect` has exactly one legal field to read.
 */
import type { Px } from "./brand.js";

/** An axis-aligned rectangle, in CSS pixels, relative to its containing block. */
export interface Rect {
  readonly x: Px;
  readonly y: Px;
  readonly width: Px;
  readonly height: Px;
}

/** A 2D point in CSS pixels. */
export interface Point {
  readonly x: Px;
  readonly y: Px;
}

/**
 * The fully resolved geometry of a single fragment. This is the ONLY place
 * geometry exists in the entire IR; `getBoundingClientRect` derives its result
 * from `borderBox` here (Requirement 3.4).
 */
export interface BoxGeometry {
  readonly x: Px;
  readonly y: Px;
  readonly width: Px;
  readonly height: Px;
  readonly contentBox: Rect;
  readonly paddingBox: Rect;
  readonly borderBox: Rect;
  readonly marginBox: Rect;
}
