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

/**
 * A positioned, shaped glyph (produced by the text shaper, e.g. HarfBuzz —
 * RFC 0002). `glyphId` is a REAL font-local glyph index; `faceIndex` names the
 * face inside the pipeline font table the backend was constructed with. No
 * code-point semantics survive past the shaping stage.
 */
export interface Glyph {
  readonly glyphId: number;
  readonly faceIndex: number;
  readonly advance: Px;
  readonly offset: Point;
}

/** A decoded raster image (produced by a reused decode library). */
export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  /** RGBA8888 straight-alpha, length === width * height * 4 */
  readonly pixels: Uint8ClampedArray;
  /** Sniffed container format ("png" | "jpeg" | "webp" | …) for diagnostics. */
  readonly format?: string;
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
  | { readonly op: "rect"; readonly rect: Rect; readonly fill: Color; readonly radius?: Px }
  | { readonly op: "border"; readonly rect: Rect; readonly edges: Edges<BorderSide>; readonly radius?: Px }
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
      readonly fontWeight?: number;
      /** `italic` or `oblique` asks the backend for a synthetic shear. `normal` stays upright. */
      readonly fontStyle?: "normal" | "italic" | "oblique";
      /**
       * `font-synthesis` gate for fake bolding (RFC 0006): `false` when the
       * run's computed `font-synthesis` lacks `weight` — the backend must not
       * embolden. Absent ⇒ synthesis allowed (spec initial value).
       */
      readonly synthesizeBold?: boolean;
      /** `false` when `font-synthesis` lacks `style`. Absent ⇒ a shear is allowed. */
      readonly synthesizeStyle?: boolean;
    }
  | { readonly op: "line"; readonly from: Point; readonly to: Point; readonly fill: Color; readonly width: Px }
  | {
      readonly op: "linear-gradient";
      readonly rect: Rect;
      /** CSS angle in degrees. `0` is up, `90` is to the right, `180` is down. */
      readonly angle: number;
      readonly stops: readonly { readonly color: Color; readonly offset: number }[];
    }
  | {
      readonly op: "radial-gradient";
      readonly rect: Rect;
      /** First stop at the center, last stop at the farthest corner. */
      readonly stops: readonly { readonly color: Color; readonly offset: number }[];
    }
  | { readonly op: "image"; readonly rect: Rect; readonly src: DecodedImage; readonly radius?: Px }
  | {
      readonly op: "tile";
      /**
       * Painting area — the tiled image is clipped to this rect
       * (`background-clip`'s box; the position origin lives separately).
       */
      readonly area: Rect;
      /** Source image, drawn scaled to `tile` size. */
      readonly src: DecodedImage;
      /** Concrete tile dimensions (post `background-size`). */
      readonly tile: { readonly width: Px; readonly height: Px };
      /** Document-space position of the first tile (`background-position`). */
      readonly origin: Point;
      /**
       * Advance between tiles per axis — equal to `tile` for `repeat`/`round`,
       * tile-plus-gap for `space`. Ignored on a `no-repeat` axis.
       */
      readonly step: { readonly x: Px; readonly y: Px };
      /** `false` ⇒ a single tile is drawn on that axis (no repetition). */
      readonly repeatX: boolean;
      readonly repeatY: boolean;
      readonly radius?: Px;
    }
  | { readonly op: "push-clip"; readonly rect: Rect; readonly radius?: Px }
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
