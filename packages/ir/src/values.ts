/**
 * CSS computed-value types and generic value containers (design.md §6, §6.css).
 *
 * These are *style* values (color, display keyword, edge quad of lengths), not
 * geometry. The Phase 1 property subset is hand-written here; from Phase 1 the
 * `generator` package emits the full set of typed fields from
 * `css-properties.data.ts`. Keeping these distinct from `geometry.ts` makes the
 * "ComputedStyle has no geometry" boundary (Requirement 3.3) legible at the
 * module level.
 */
import type { Px } from "./brand.js";

/** The four edges of a box, each carrying a value of type `T`. */
export interface Edges<T> {
  readonly top: T;
  readonly right: T;
  readonly bottom: T;
  readonly left: T;
}

/** An sRGB color with straight (non-premultiplied) alpha, channels in 0..255 / 0..1. */
export interface Color {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** The `display` outer/inner keyword (Phase 1 subset; extended by generator). */
export type DisplayValue =
  | "block"
  | "inline"
  | "inline-block"
  | "flex"
  | "grid"
  | "table"
  | "none";

/**
 * The `position` keyword (CSS positioning scheme). A *style* value, not
 * geometry — it selects which layout branch a box takes, never a resolved box.
 */
export type PositionValue = "static" | "relative" | "absolute" | "fixed" | "sticky";

/** The `float` keyword. A *style* value (selects the float branch). */
export type FloatValue = "none" | "left" | "right";

/** The `flex-direction` keyword (the flex container's main-axis direction). */
export type FlexDirection = "row" | "row-reverse" | "column" | "column-reverse";

/** Re-export `Px` so style consumers need not reach into the brand module. */
export type { Px };
