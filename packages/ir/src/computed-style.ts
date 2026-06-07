/**
 * Stage 3 IR: ComputedStyle (design.md §6, Requirement 3.3).
 *
 * Output of the cascade engine, one per element, every field already a
 * *computed value*. Nominally branded `"ComputedStyle"`.
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  THIS TYPE CONTAINS NO GEOMETRY FIELDS. (Requirement 3.3)              ║
 * ║  No `x`, `y`, `width`, `height`, `*Box`, `Rect`, `Point`, or          ║
 * ║  `BoxGeometry`. Geometry lives ONLY in `FragmentTree`. This module     ║
 * ║  deliberately does not import from `./geometry.js`, so a stray         ║
 * ║  geometry field cannot even be typed here — the v0 "getBoundingClient  ║
 * ║  Rect reads the wrong field" bug becomes a compile error.              ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * Note: `margin` here is the *style* property (an `Edges<Px>` of computed
 * lengths), not a resolved geometric margin box. The resolved geometry of the
 * margin box lives in `BoxGeometry.marginBox` (FragmentTree).
 */
import type { Branded } from "./brand.js";
import type { Color, DisplayValue, Edges, Px } from "./values.js";

/** The cascade product for one element. Nominally branded.
 *
 * The Phase 1 property subset is spelled out explicitly; the open index
 * signature is where the `generator` injects the remaining typed properties.
 * Crucially, the index signature's value type is `unknown` (never a geometry
 * type), so it cannot be used to smuggle geometry past Requirement 3.3.
 */
export type ComputedStyle = Branded<
  {
    readonly display: DisplayValue;
    readonly color: Color;
    readonly fontSize: Px;
    readonly margin: Edges<Px>;
    // ... remaining properties injected by the generator
    readonly [k: string]: unknown;
  },
  "ComputedStyle"
>;
