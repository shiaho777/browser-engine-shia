/**
 * Stage 5 IR: DisplayList (design.md §6, §10).
 *
 * Output of the paint engine: a backend-agnostic sequence of abstract paint
 * commands. Nominally branded `"DisplayList"`. The Paint_Backend consumes ONLY
 * this value (Requirement 3.5) — it receives no handle to any upstream IR, so
 * reverse reads are structurally impossible.
 *
 * The backend value types below (`BorderSide`, `Glyph`, `DecodedImage`,
 * `Matrix`) are minimal Phase 0 shapes sufficient to type the boundary; the
 * paint engine / backends refine them in later phases without changing the
 * nominal brand.
 */
import type { Branded } from "./brand.js";
import type { Point, Rect } from "./geometry.js";
import type { Color, Edges, Px } from "./values.js";

/** Styling of a single box border edge. */
export interface BorderSide {
  readonly width: Px;
  readonly style: "none" | "solid" | "dashed" | "dotted" | "double";
  readonly color: Color;
}

/** A positioned, shaped glyph (produced by the text shaper, e.g. HarfBuzz). */
export interface Glyph {
  readonly glyphId: number;
  readonly advance: Px;
  readonly offset: Point;
}

/** A decoded raster image (produced by a reused decode library). */
export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  /** RGBA8888, length === width * height * 4 */
  readonly pixels: Uint8ClampedArray;
}

/** A 2D affine transform `[a, b, c, d, e, f]`. */
export type Matrix = readonly [
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
];

/** A backend-agnostic paint command. Skia/Canvas/SVG backends each interpret these. */
export type PaintCmd =
  | { readonly op: "rect"; readonly rect: Rect; readonly fill: Color }
  | { readonly op: "border"; readonly rect: Rect; readonly edges: Edges<BorderSide> }
  | {
      readonly op: "text";
      readonly glyphs: readonly Glyph[];
      readonly at: Point;
      readonly fill: Color;
      /**
       * The cell height (computed `font-size`, CSS px) the backend scales each
       * glyph bitmap to. A glyph's `advance` is the horizontal cell width and
       * `offset` its position relative to `at`, so the backend rasterizes each
       * glyph into `[at + offset, advance × fontSize]`.
       */
      readonly fontSize: Px;
    }
  | { readonly op: "image"; readonly rect: Rect; readonly src: DecodedImage }
  | { readonly op: "push-clip"; readonly rect: Rect }
  | { readonly op: "pop-clip" }
  | {
      readonly op: "push-layer";
      readonly opacity: number;
      readonly transform: Matrix;
      /** CSS `filter` functions to apply to the layer before compositing (e.g. `blur(4px) grayscale(1)`); absent / `"none"` ⇒ no filter. */
      readonly filter?: string;
    }
  | { readonly op: "pop-layer" };

/** The abstract paint output. Nominally branded. */
export type DisplayList = Branded<
  {
    readonly commands: readonly PaintCmd[];
  },
  "DisplayList"
>;
