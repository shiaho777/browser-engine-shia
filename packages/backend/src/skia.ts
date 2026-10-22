/**
 * skia.ts — the production raster backend (RFC 0001): real Skia behind the
 * {@link PaintBackend} seam, via `canvaskit-wasm` (the official Skia WASM
 * build). This is the Requirement 8.1 reuse boundary made real: the engine's
 * own pixel loops stop being the production rasterizer and become the
 * differential oracle.
 *
 * ## Contract
 *
 * {@link SkiaBackend.render} consumes ONLY the {@link DisplayList} + a
 * {@link Surface} — identical to {@link ScreenshotBackend}; no upstream IR
 * handle exists here (`local/no-cross-stage-import` keeps it physical).
 *
 * ## Command coverage
 *
 * All nine {@link PaintCmd} ops are rendered by real Skia calls — including
 * `line`, which neither existing backend draws (the GPU-path translator drops
 * it silently; the CPU oracle rejects it). Non-styled borders keep the
 * oracle's four-edge-fill semantics; dashed/dotted/double edge fidelity is
 * follow-up work.
 *
 *   - `rect`/`border` → `drawRect` / `drawRRect` (real AA corner radii)
 *   - `text` → `drawGlyphs`: DisplayList glyphs carry REAL `(faceIndex, gid)`
 *     pairs produced by the pipeline shaper (RFC 0002); `faceIndex` indexes the
 *     injected face table whose `FontFace.data` bytes become Skia typefaces —
 *     Skia's FreeType scaler rasterizes the very font file the shaper shaped
 *     against. `fontWeight ≥ 500` sets `Font.setEmbolden` (the same fake-bold
 *     band the coverage oracle applies).
 *   - `line` → `drawLine` (stroke paint)
 *   - `image` → `MakeImage` + `drawImageRect` (`fastSample` — the oracle's
 *     nearest-cell semantics)
 *   - `push-clip`/`pop-clip` → save/restore + `clipRect`/`clipRRect` (AA)
 *   - `push-layer`/`pop-layer` → offscreen raster `Surface` per layer; pop
 *     composites the snapshot under the layer's affine transform (row-major
 *     Skia `Matrix`) with a `Paint` carrying `alphaf` opacity and a real
 *     `ImageFilter` chain (`blur` → `MakeBlur`; colour filters →
 *     `ColorFilter.MakeMatrix` → `MakeColorFilter`, W3C filter-effects
 *     matrices, composed via `MakeCompose`).
 *
 * ## Documented semantic improvements over the CPU oracle
 *
 *   - Ancestor clips clip a composited layer (Skia applies the parent clip to
 *     the layer blit; the oracle's raw pixel composite did not) — the CSS
 *     behaviour.
 *   - `line` renders (new coverage, not a divergence).
 *   - Text edges and transformed layer resampling use Skia's AA/sampling —
 *     legitimately different pixel coverage than the scanline reference; the
 *     differential suite pins that with a stated tolerance.
 *
 * WASM objects (`Paint`/`Font`/`Image`/`ImageFilter`/offscreen `Surface`s) are
 * `.delete()`d after use; init is async exactly once at
 * {@link createSkiaBackend} so `render` stays synchronous per the contract.
 */
import { createRequire } from "node:module";

import type {
  Canvas,
  CanvasKit,
  CanvasKitInitOptions,
  ColorFilter,
  Font,
  ImageFilter,
  Surface as SkiaSurface,
  Typeface,
} from "canvaskit-wasm";

import type { BorderSide, Color, DisplayList, Edges, Matrix, PaintCmd, Rect } from "@browser-engine/ir";
import { builtinFont } from "@browser-engine/font";
import type { FontFace } from "@browser-engine/font";

import type { PaintBackend } from "./screenshot.js";
import { needsSyntheticBold, needsSyntheticItalic } from "./embolden.js";
import { gradientColor, gradientT, radialT } from "./gradient.js";
import { clampAlpha, type Surface } from "./surface.js";

/** Locate the packaged `canvaskit.wasm` binary for Emscripten's loader. */
const require_ = createRequire(import.meta.url);
const WASM_PATH = require_.resolve("canvaskit-wasm/bin/canvaskit.wasm");

/**
 * `canvaskit-wasm` is a CommonJS module whose default export is the init
 * function; the repo builds strict NodeNext without `esModuleInterop`, so it is
 * loaded through `createRequire` rather than a default import.
 */
const CanvasKitInit = require_("canvaskit-wasm") as (
  options?: CanvasKitInitOptions,
) => Promise<CanvasKit>;

let initPromise: Promise<CanvasKit> | undefined;
let resolvedCk: CanvasKit | undefined;

/**
 * Load + instantiate the CanvasKit WASM module once per process. Shared by the
 * paint backend and the image-codec surface (`codecs.ts`).
 */
export function loadCanvasKit(): Promise<CanvasKit> {
  if (initPromise === undefined) {
    initPromise = CanvasKitInit({
      locateFile: (file: string) => (file === "canvaskit.wasm" ? WASM_PATH : file),
    }).then((ck) => {
      resolvedCk = ck;
      return ck;
    });
  }
  return initPromise;
}

/**
 * The resolved CanvasKit instance, or `undefined` until {@link loadCanvasKit}
 * has settled — lets synchronous callers (the image decode fast path) use
 * Skia exactly when it is already warm.
 */
export function canvasKitIfReady(): CanvasKit | undefined {
  return resolvedCk;
}

/** Options for {@link createSkiaBackend}. */
export interface SkiaBackendOptions {
  /**
   * The pipeline's master FACE TABLE — the same ordered `FontFace` list the
   * shaper resolved `faceIndex` against (regular + bold faces, deduped). Each
   * face's {@link FontFace.data} bytes become a Skia typeface, and a `text`
   * command's `(faceIndex, glyphId)` pair draws through that face — glyph and
   * font selection already happened upstream in the shaper. Faces without
   * `data` (programmatically constructed) cannot be scaled by Skia — their
   * glyphs are skipped loudly (the face cannot produce pixels here).
   */
  readonly faces?: readonly FontFace[];
  /**
   * Baseline ascent in ems — defaults to the primary face's own ascent; pass
   * the pipeline raster source's `ascentEm` to guarantee identical baselines
   * across backends.
   */
  readonly ascentEm?: number;
}

/** A `push-clip` held on some canvas (which canvas is recorded for restore). */
interface ClipEntry {
  readonly kind: "clip";
  readonly canvas: Canvas;
}

/** A `push-layer` offscreen surface awaiting composite at `pop-layer`. */
interface LayerEntry {
  readonly kind: "layer";
  readonly surface: SkiaSurface;
  readonly canvas: Canvas;
  readonly opacity: number;
  /** The layer affine transform applied at composite, or `null` (identity). */
  readonly transform: Matrix | null;
  readonly filter: string | undefined;
}

type StackEntry = ClipEntry | LayerEntry;

/** The identity 2D affine transform. */
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function isIdentity(m: Matrix): boolean {
  for (let i = 0; i < 6; i += 1) {
    if (Math.abs((m[i] as number) - (IDENTITY[i] as number)) > 1e-9) return false;
  }
  return true;
}

/** Our `[a,b,c,d,e,f]` affine → Skia's row-major 3×3 `Matrix`. */
function toSkiaMatrix(m: Matrix): number[] {
  return [m[0], m[2], m[4], m[1], m[3], m[5], 0, 0, 1];
}

function toColor4f(ck: CanvasKit, c: Color): Float32Array {
  return ck.Color4f(c.r / 255, c.g / 255, c.b / 255, clampAlpha(c.a));
}

function toRect(r: Rect): number[] {
  return [Number(r.x), Number(r.y), Number(r.x) + Number(r.width), Number(r.y) + Number(r.height)];
}

function toRRect(ck: CanvasKit, r: Rect, radius: number): Float32Array {
  return ck.RRectXY(toRect(r), radius, radius);
}

/**
 * The Skia paint backend. Created by {@link createSkiaBackend} (async init);
 * `render` itself is synchronous per the {@link PaintBackend} contract.
 */
export class SkiaBackend implements PaintBackend {
  readonly #ck: CanvasKit;
  /** The master face table — `text` `faceIndex` indexes into this list. */
  readonly #faces: readonly FontFace[];
  /** Baseline ascent in ems (mirrors the raster source's `ascentEm`). */
  readonly #ascentEm: number;
  /** Lazily-built Skia typeface per face (`null` = undecodable for Skia). */
  readonly #typefaces = new Map<FontFace, Typeface | null>();

  constructor(
    ck: CanvasKit,
    faces: readonly FontFace[],
    ascentEm: number,
  ) {
    this.#ck = ck;
    this.#faces = faces;
    this.#ascentEm = ascentEm;
  }

  /** Skia typeface for `face`, built once from its raw bytes (or `null`). */
  #typefaceOf(face: FontFace): Typeface | null {
    const cached = this.#typefaces.get(face);
    if (cached !== undefined) return cached;
    const bytes = face.data;
    const typeface =
      bytes === undefined
        ? null
        : this.#ck.Typeface.MakeFreeTypeFaceFromData(new Uint8Array(bytes).buffer);
    this.#typefaces.set(face, typeface);
    return typeface;
  }

  /**
   * Rasterize `list` into `surface` via Skia. The DisplayList is the ONLY
   * rendering input (Requirement 3.5); commands draw in list order.
   */
  render(list: DisplayList, surface: Surface): void {
    const ck = this.#ck;
    const w = surface.width;
    const h = surface.height;
    const target = ck.MakeSurface(w, h);
    if (target === null) {
      throw new Error(`SkiaBackend: MakeSurface(${w}x${h}) returned null`);
    }
    try {
      const base = target.getCanvas();
      // Seed the raster target with the surface's existing contents (the opaque
      // background createSurface wrote, or any prior painted state).
      const pixels = new Uint8Array(surface.pixels.buffer, surface.pixels.byteOffset, surface.pixels.byteLength);
      const seeded = base.writePixels(
        pixels,
        w,
        h,
        0,
        0,
        ck.AlphaType.Unpremul,
        ck.ColorType.RGBA_8888,
        ck.ColorSpace.SRGB,
      );
      if (!seeded) {
        const seed = ck.MakeImage(
          { width: w, height: h, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB },
          pixels,
          w * 4,
        );
        if (seed === null) {
          throw new Error("SkiaBackend: failed to seed the raster surface from the input Surface");
        }
        base.drawImage(seed, 0, 0, null);
        seed.delete();
      }

      const stack: StackEntry[] = [];
      const currentCanvas = (): Canvas => {
        for (let i = stack.length - 1; i >= 0; i -= 1) {
          const e = stack[i] as StackEntry;
          if (e.kind === "layer") return e.canvas;
        }
        return base;
      };

      const closeLayer = (entry: LayerEntry): void => {
        // Drain clips that were pushed inside this layer (they live on the
        // layer's canvas), then composite the layer snapshot onto the parent
        // canvas under the layer's transform/opacity/filter — the oracle's
        // bitmap-transform composite semantics, executed by Skia sampling.
        while (stack.length > 0 && stack[stack.length - 1] !== entry) {
          const top = stack.pop() as StackEntry;
          if (top.kind === "clip") top.canvas.restore();
        }
        stack.pop();
        const img = entry.surface.makeImageSnapshot();
        const parent = currentCanvas();
        const paint = new ck.Paint();
        let filter: ImageFilter | null = null;
        try {
          paint.setAlphaf(clampAlpha(entry.opacity));
          if (entry.filter !== undefined) {
            filter = this.#imageFilter(entry.filter);
            if (filter !== null) paint.setImageFilter(filter);
          }
          parent.save();
          if (entry.transform !== null) parent.concat(toSkiaMatrix(entry.transform));
          parent.drawImageOptions(img, 0, 0, ck.FilterMode.Linear, ck.MipmapMode.None, paint);
          parent.restore();
        } finally {
          paint.delete();
          filter?.delete();
          img.delete();
          entry.surface.delete();
        }
      };

      for (const cmd of list.commands) {
        switch (cmd.op) {
          case "push-clip": {
            const cv = currentCanvas();
            cv.save();
            const radius = cmd.radius !== undefined ? Number(cmd.radius) : 0;
            if (radius > 0) {
              cv.clipRRect(toRRect(ck, cmd.rect, radius), ck.ClipOp.Intersect, true);
            } else {
              cv.clipRect(toRect(cmd.rect), ck.ClipOp.Intersect, true);
            }
            stack.push({ kind: "clip", canvas: cv });
            break;
          }
          case "pop-clip": {
            for (let i = stack.length - 1; i >= 0; i -= 1) {
              const e = stack[i] as StackEntry;
              if (e.kind === "clip") {
                e.canvas.restore();
                stack.splice(i, 1);
                break;
              }
            }
            break;
          }
          case "push-layer": {
            const offscreen = ck.MakeSurface(w, h);
            if (offscreen === null) {
              throw new Error("SkiaBackend: MakeSurface for compositing layer returned null");
            }
            const cv = offscreen.getCanvas();
            cv.clear(ck.Color4f(0, 0, 0, 0));
            stack.push({
              kind: "layer",
              surface: offscreen,
              canvas: cv,
              opacity: clampAlpha(cmd.opacity),
              transform: isIdentity(cmd.transform) ? null : cmd.transform,
              filter: cmd.filter !== undefined && cmd.filter !== "none" ? cmd.filter : undefined,
            });
            break;
          }
          case "pop-layer": {
            const entry = stack[stack.length - 1];
            if (entry !== undefined && entry.kind === "layer") closeLayer(entry);
            break;
          }
          default:
            this.#draw(currentCanvas(), cmd);
        }
      }
      // Composite any unbalanced open layers (same defensive close as the oracle).
      while (stack.length > 0) {
        const entry = stack[stack.length - 1] as StackEntry;
        if (entry.kind !== "layer") {
          entry.canvas.restore();
          stack.pop();
          continue;
        }
        closeLayer(entry);
      }

      const out = base.readPixels(0, 0, {
        width: w,
        height: h,
        colorType: ck.ColorType.RGBA_8888,
        alphaType: ck.AlphaType.Unpremul,
        colorSpace: ck.ColorSpace.SRGB,
      });
      if (out === null || !(out instanceof Uint8Array)) {
        throw new Error("SkiaBackend: readPixels returned no RGBA data");
      }
      surface.pixels.set(out.subarray(0, surface.pixels.length));
    } finally {
      target.delete();
    }
  }

  /** Dispatch a non-stack paint command onto `cv`. */
  #draw(cv: Canvas, cmd: PaintCmd): void {
    switch (cmd.op) {
      case "rect":
        this.#fillRect(cv, cmd.rect, cmd.fill, cmd.radius !== undefined ? Number(cmd.radius) : 0);
        return;
      case "border":
        this.#fillBorder(cv, cmd.rect, cmd.edges);
        return;
      case "text":
        this.#drawText(cv, cmd);
        return;
      case "line":
        this.#strokeLine(cv, cmd);
        return;
      case "image":
        this.#drawImage(cv, cmd);
        return;
      case "tile":
        this.#drawTile(cv, cmd);
        return;
      case "linear-gradient":
        this.#drawLinearGradient(cv, cmd);
        return;
      case "radial-gradient":
        this.#drawRadialGradient(cv, cmd);
        return;
      case "push-clip":
      case "pop-clip":
      case "push-layer":
      case "pop-layer":
        return;
    }
  }

  #drawLinearGradient(cv: Canvas, cmd: Extract<PaintCmd, { op: "linear-gradient" }>): void {
    const x0 = Number(cmd.rect.x);
    const y0 = Number(cmd.rect.y);
    const w = Number(cmd.rect.width);
    const h = Number(cmd.rect.height);
    if (!(w > 0) || !(h > 0) || cmd.stops.length === 0) return;
    const rad = (cmd.angle * Math.PI) / 180;
    const horizontal = Math.abs(Math.sin(rad)) >= Math.abs(Math.cos(rad));
    const count = Math.max(1, Math.ceil(horizontal ? w : h));
    for (let i = 0; i < count; i += 1) {
      const strip = horizontal
        ? { x: x0 + i, y: y0, width: 1, height: h }
        : { x: x0, y: y0 + i, width: w, height: 1 };
      const t = gradientT(
        strip.x + strip.width / 2,
        strip.y + strip.height / 2,
        x0,
        y0,
        w,
        h,
        cmd.angle,
      );
      this.#fillRect(
        cv,
        { x: strip.x as Rect["x"], y: strip.y as Rect["y"], width: strip.width as Rect["width"], height: strip.height as Rect["height"] },
        gradientColor(cmd.stops, t),
        0,
      );
    }
  }

  #drawRadialGradient(cv: Canvas, cmd: Extract<PaintCmd, { op: "radial-gradient" }>): void {
    const x0 = Number(cmd.rect.x);
    const y0 = Number(cmd.rect.y);
    const w = Number(cmd.rect.width);
    const h = Number(cmd.rect.height);
    if (!(w > 0) || !(h > 0) || cmd.stops.length === 0) return;
    const cols = Math.max(1, Math.ceil(w));
    const rows = Math.max(1, Math.ceil(h));
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const cellX = x0 + col;
        const cellY = y0 + row;
        this.#fillRect(
          cv,
          { x: cellX as Rect["x"], y: cellY as Rect["y"], width: 1 as Rect["width"], height: 1 as Rect["height"] },
          gradientColor(cmd.stops, radialT(cellX + 0.5, cellY + 0.5, x0, y0, w, h)),
          0,
        );
      }
    }
  }

  #fillRect(cv: Canvas, rect: Rect, fill: Color, radius: number): void {
    if (fill.a <= 0) return;
    const paint = new this.#ck.Paint();
    try {
      paint.setColor(toColor4f(this.#ck, fill));
      paint.setAntiAlias(true);
      if (radius > 0) {
        cv.drawRRect(toRRect(this.#ck, rect, radius), paint);
      } else {
        cv.drawRect(toRect(rect), paint);
      }
    } finally {
      paint.delete();
    }
  }

  /** Four solid edge fills — the oracle's border semantics. */
  #fillBorder(cv: Canvas, rect: Rect, edges: Edges<BorderSide>): void {
    const x0 = Number(rect.x);
    const y0 = Number(rect.y);
    const x1 = x0 + Number(rect.width);
    const y1 = y0 + Number(rect.height);
    const edge = (
      side: BorderSide,
      ex0: number,
      ey0: number,
      ex1: number,
      ey1: number,
    ): void => {
      const w = Number(side.width);
      if (side.style === "none" || w <= 0 || side.color.a <= 0) return;
      const paint = new this.#ck.Paint();
      try {
        paint.setColor(toColor4f(this.#ck, side.color));
        paint.setAntiAlias(true);
        cv.drawRect([ex0, ey0, ex1, ey1], paint);
      } finally {
        paint.delete();
      }
    };
    const t = Number(edges.top.width);
    const b = Number(edges.bottom.width);
    const l = Number(edges.left.width);
    const r = Number(edges.right.width);
    edge(edges.top, x0, y0, x1, y0 + t);
    edge(edges.bottom, x0, y1 - b, x1, y1);
    edge(edges.left, x0, y0, x0 + l, y1);
    edge(edges.right, x1 - r, y0, x1, y1);
  }

  /**
   * Positioned glyphs through `drawGlyphs`: each DisplayList glyph carries its
   * REAL `(faceIndex, glyphId)` pair — the shaper's output (RFC 0002). Glyphs
   * are grouped into per-face runs (one `Font`/`Typeface` each) and drawn at
   * `at` + offset + ascent — `offset` is the pen position HarfBuzz produced,
   * already in CSS-pixel space. `fontWeight ≥ 500` sets `setEmbolden` — the
   * same fake-bold band the coverage oracle applies.
   */
  #drawText(cv: Canvas, cmd: Extract<PaintCmd, { op: "text" }>): void {
    const fontSize = Number(cmd.fontSize);
    if (fontSize <= 0 || cmd.fill.a <= 0 || cmd.glyphs.length === 0) return;
    const ck = this.#ck;
    const paint = new ck.Paint();
    const weight = cmd.fontWeight !== undefined ? Number(cmd.fontWeight) : 400;
    // Synthetic bold (RFC 0006): embolden only when the run ALLOWS synthesis
    // (`font-synthesis` gate) AND the selected face genuinely lacks the
    // requested weight — a real bold face is never double-bolded.
    const synthAllowed = cmd.synthesizeBold !== false;
    try {
      paint.setColor(toColor4f(ck, cmd.fill));
      paint.setAntiAlias(true);
      const atX = Number(cmd.at.x);
      const atY = Number(cmd.at.y);
      const ascentPx = this.#ascentEm * fontSize;
      let runFace: FontFace | null = null;
      let gids: number[] = [];
      let positions: number[] = [];
      const flush = (): void => {
        if (runFace === null || gids.length === 0) return;
        const typeface = this.#typefaceOf(runFace);
        if (typeface !== null) {
          const font: Font = new ck.Font(typeface, fontSize);
          try {
            if (needsSyntheticBold(weight, runFace.weight, synthAllowed)) {
              font.setEmbolden(true);
            }
            if (needsSyntheticItalic(cmd.fontStyle, cmd.synthesizeStyle !== false, runFace.italic === true)) {
              font.setSkewX(-0.2);
            }
            cv.drawGlyphs(gids, positions, 0, 0, font, paint);
          } finally {
            font.delete();
          }
        }
        gids = [];
        positions = [];
      };
      for (const glyph of cmd.glyphs) {
        const face = this.#faces[glyph.faceIndex];
        if (face === undefined) continue; // table slot missing — nothing to draw.
        if (face !== runFace) {
          flush();
          runFace = face;
        }
        gids.push(glyph.glyphId);
        positions.push(atX + Number(glyph.offset.x), atY + ascentPx + Number(glyph.offset.y));
      }
      flush();
    } finally {
      paint.delete();
    }
  }

  #strokeLine(cv: Canvas, cmd: Extract<PaintCmd, { op: "line" }>): void {
    if (cmd.fill.a <= 0) return;
    const paint = new this.#ck.Paint();
    try {
      paint.setColor(toColor4f(this.#ck, cmd.fill));
      paint.setAntiAlias(true);
      paint.setStyle(this.#ck.PaintStyle.Stroke);
      paint.setStrokeWidth(Math.max(0.1, Number(cmd.width)));
      cv.drawLine(Number(cmd.from.x), Number(cmd.from.y), Number(cmd.to.x), Number(cmd.to.y), paint);
    } finally {
      paint.delete();
    }
  }

  #drawImage(cv: Canvas, cmd: Extract<PaintCmd, { op: "image" }>): void {
    const src = cmd.src;
    if (src.width <= 0 || src.height <= 0) return;
    const ck = this.#ck;
    const img = ck.MakeImage(
      { width: src.width, height: src.height, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB },
      new Uint8Array(src.pixels.buffer, src.pixels.byteOffset, src.pixels.byteLength),
      src.width * 4,
    );
    if (img === null) {
      throw new Error(`SkiaBackend: MakeImage failed for ${src.width}x${src.height} image`);
    }
    const paint = new ck.Paint();
    try {
      paint.setAntiAlias(true);
      const radius = cmd.radius !== undefined ? Number(cmd.radius) : 0;
      if (radius > 0) {
        cv.save();
        cv.clipRRect(toRRect(ck, cmd.rect, radius), ck.ClipOp.Intersect, true);
      }
      cv.drawImageRect(
        img,
        [0, 0, src.width, src.height],
        toRect(cmd.rect),
        paint,
        true, // fastSample: nearest — the oracle's blit semantics.
      );
      if (radius > 0) cv.restore();
    } finally {
      paint.delete();
      img.delete();
    }
  }

  /**
   * `tile` (RFC 0008): draw `src` scaled to `tile` size, repeating on each
   * enabled axis from `origin` by `step`, clipped to `area` (rounded when
   * `radius` is set). Same blit semantics as the coverage oracle's blitTiled.
   */
  #drawTile(cv: Canvas, cmd: Extract<PaintCmd, { op: "tile" }>): void {
    const src = cmd.src;
    const tw = Number(cmd.tile.width);
    const th = Number(cmd.tile.height);
    if (src.width <= 0 || src.height <= 0 || tw <= 0 || th <= 0) return;
    const ck = this.#ck;
    const img = ck.MakeImage(
      { width: src.width, height: src.height, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB },
      new Uint8Array(src.pixels.buffer, src.pixels.byteOffset, src.pixels.byteLength),
      src.width * 4,
    );
    if (img === null) return;
    const paint = new ck.Paint();
    try {
      paint.setAntiAlias(true);
      const ax = Number(cmd.area.x);
      const ay = Number(cmd.area.y);
      const ax1 = ax + Number(cmd.area.width);
      const ay1 = ay + Number(cmd.area.height);
      const radius = cmd.radius !== undefined ? Number(cmd.radius) : 0;
      cv.save();
      if (radius > 0) {
        cv.clipRRect(toRRect(ck, cmd.area, radius), ck.ClipOp.Intersect, true);
      } else {
        cv.clipRect(toRect(cmd.area), ck.ClipOp.Intersect, true);
      }
      const ox = Number(cmd.origin.x);
      const oy = Number(cmd.origin.y);
      const stepX = Math.max(1, Number(cmd.step.x));
      const stepY = Math.max(1, Number(cmd.step.y));
      const ix0 = cmd.repeatX ? Math.floor((ax - ox) / stepX) : 0;
      const ix1 = cmd.repeatX ? Math.floor((ax1 - 1 - ox) / stepX) : 0;
      const iy0 = cmd.repeatY ? Math.floor((ay - oy) / stepY) : 0;
      const iy1 = cmd.repeatY ? Math.floor((ay1 - 1 - oy) / stepY) : 0;
      for (let iy = iy0; iy <= iy1; iy += 1) {
        for (let ix = ix0; ix <= ix1; ix += 1) {
          cv.drawImageRect(
            img,
            [0, 0, src.width, src.height],
            ck.XYWHRect(ox + ix * stepX, oy + iy * stepY, tw, th),
            paint,
            true,
          );
        }
      }
      cv.restore();
    } finally {
      paint.delete();
      img.delete();
    }
  }

  /**
   * Compile a CSS `filter` function string into a Skia ImageFilter chain:
   * `blur(r)` → Gaussian `MakeBlur` (the argument IS the std-deviation);
   * colour functions → the W3C filter-effects 4×5 matrices via
   * `ColorFilter.MakeMatrix` wrapped in `MakeColorFilter`. Unknown functions
   * are skipped (no fabricated effect), mirroring the oracle.
   */
  #imageFilter(filter: string): ImageFilter | null {
    const ck = this.#ck;
    const fnRe = /([a-z-]+)\(([^)]*)\)/g;
    let current: ImageFilter | null = null;
    let m: RegExpExecArray | null;
    while ((m = fnRe.exec(filter.toLowerCase())) !== null) {
      const fn = m[1] as string;
      const arg = (m[2] ?? "").trim();
      if (fn === "blur") {
        const sigma = Number.parseFloat(arg.replace(/px$/, ""));
        if (Number.isFinite(sigma) && sigma > 0) {
          const prev = current;
          current = ck.ImageFilter.MakeBlur(sigma, sigma, ck.TileMode.Clamp, current);
          prev?.delete();
        }
        continue;
      }
      const matrix = colorMatrix(fn, parseAmount(arg));
      if (matrix === null) continue;
      const cf: ColorFilter | null = ck.ColorFilter.MakeMatrix(matrix);
      if (cf === null) continue;
      const prev = current;
      current = ck.ImageFilter.MakeColorFilter(cf, current);
      cf.delete();
      prev?.delete();
    }
    return current;
  }
}

/** Parse a filter amount: a number or a `%` (→ 0..1+), default 1. */
function parseAmount(arg: string): number {
  if (arg === "") return 1;
  if (arg.endsWith("%")) return Number.parseFloat(arg) / 100;
  const n = Number.parseFloat(arg);
  return Number.isFinite(n) ? n : 1;
}

/** The W3C filter-effects 4×5 colour matrix for `fn`, or `null` if unknown. */
function colorMatrix(fn: string, t: number): number[] | null {
  const s = 1 - t;
  switch (fn) {
    case "grayscale":
      return [
        0.2126 + 0.7874 * s, 0.7152 - 0.7152 * s, 0.0722 - 0.0722 * s, 0, 0,
        0.2126 - 0.2126 * s, 0.7152 + 0.2848 * s, 0.0722 - 0.0722 * s, 0, 0,
        0.2126 - 0.2126 * s, 0.7152 - 0.7152 * s, 0.0722 + 0.9278 * s, 0, 0,
        0, 0, 0, 1, 0,
      ];
    case "sepia":
      return [
        0.393 + 0.607 * s, 0.769 - 0.769 * s, 0.189 - 0.189 * s, 0, 0,
        0.349 - 0.349 * s, 0.686 + 0.314 * s, 0.168 - 0.168 * s, 0, 0,
        0.272 - 0.272 * s, 0.534 - 0.534 * s, 0.131 + 0.869 * s, 0, 0,
        0, 0, 0, 1, 0,
      ];
    case "saturate":
      return [
        0.213 + 0.787 * t, 0.715 - 0.715 * t, 0.072 - 0.072 * t, 0, 0,
        0.213 - 0.213 * t, 0.715 + 0.285 * t, 0.072 - 0.072 * t, 0, 0,
        0.213 - 0.213 * t, 0.715 - 0.715 * t, 0.072 + 0.928 * t, 0, 0,
        0, 0, 0, 1, 0,
      ];
    case "invert":
      return [
        1 - 2 * t, 0, 0, 0, t,
        0, 1 - 2 * t, 0, 0, t,
        0, 0, 1 - 2 * t, 0, t,
        0, 0, 0, 1, 0,
      ];
    case "brightness":
      return [
        t, 0, 0, 0, 0,
        0, t, 0, 0, 0,
        0, 0, t, 0, 0,
        0, 0, 0, 1, 0,
      ];
    case "contrast": {
      const o = 0.5 * (1 - t);
      return [
        t, 0, 0, 0, o,
        0, t, 0, 0, o,
        0, 0, t, 0, o,
        0, 0, 0, 1, 0,
      ];
    }
    case "opacity":
      return [
        1, 0, 0, 0, 0,
        0, 1, 0, 0, 0,
        0, 0, 1, 0, 0,
        0, 0, 0, t, 0,
      ];
    default:
      return null;
  }
}

/**
 * Async factory: load the CanvasKit WASM module once and return a ready,
 * synchronously-rendering {@link SkiaBackend}. `faces` defaults to the in-repo
 * compiled TrueType face table; pass the pipeline's master face table +
 * `ascentEm` to render the same font stack the shaping stage resolved.
 */
export async function createSkiaBackend(options: SkiaBackendOptions = {}): Promise<SkiaBackend> {
  const ck = await loadCanvasKit();
  const faces = options.faces ?? [builtinFont()];
  const primary = faces[0];
  const ascentEm =
    options.ascentEm ?? (primary === undefined ? 1 : primary.ascent / primary.unitsPerEm);
  return new SkiaBackend(ck, faces, ascentEm);
}
