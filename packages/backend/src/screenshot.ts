/**
 * The Phase 1 software-raster screenshot backend (task 3.11; design.md §8.6).
 *
 * A {@link PaintBackend}'s single entry point consumes the {@link DisplayList}
 * and a {@link Surface}, and paints pixels. It receives NO upstream IR handle
 * (no FragmentTree/ComputedStyle), so v0-style cross-stage reverse reads are
 * structurally impossible (Requirement 3.5): `render(list, surface)` is the
 * whole contract.
 *
 * ## Reuse boundary (Requirement 8.1)
 *
 * The eventual production backend reuses an external rasterizer (Skia) and font
 * rasterizer (FreeType) — design.md §14 lists "default paint backend (Skia vs
 * SVG/Canvas)" as an OPEN question. Phase 1 only needs *a* screenshot to close
 * the end-to-end vertical slice, so this is a minimal **self-built software
 * raster** backend: it fills rectangles into an RGBA buffer and encodes PNG via
 * Node's `zlib`. The reuse-vs-build boundary is honoured *conceptually* — the
 * backend is the replaceable component behind the DisplayList, and swapping in a
 * Skia/FreeType backend later changes nothing upstream of this package.
 *
 * ## Phase 1 command handling (documented simplifications)
 *
 *   - **`rect`** — fills the rectangle region with its colour, alpha-blended
 *     (source-over) onto the surface and clipped to the current clip rect. This
 *     is the visible Phase 1 output (`background-color` boxes).
 *   - **`text`** — the Phase 1 DisplayList carries EMPTY glyph arrays (real
 *     shaping/HarfBuzz lands in task 5.7; the paint engine deliberately does not
 *     fabricate glyph geometry). With no glyphs and no font rasterizer yet, a
 *     `text` command paints nothing — documented here as the honest Phase 1
 *     choice rather than drawing fake blocks. Real glyph rasterization arrives
 *     with the FreeType reuse boundary in a later phase.
 *   - **`border`** — fills each non-`none` edge as a solid rectangle within the
 *     command's rect (Phase 1 boxes emit no borders yet, but the handler is here
 *     so the boundary is complete).
 *   - **`image`** — blits the decoded RGBA source into its rect (nearest-cell),
 *     clipped. Phase 1 emits no images; handled for completeness.
 *   - **`push-clip` / `pop-clip`** — maintain a clip-rect stack; subsequent
 *     draws are intersected with the top clip.
 *   - **`push-layer` / `pop-layer`** — maintain a layer opacity stack; the
 *     product of active opacities scales each draw's alpha. The `transform`
 *     matrix is NOT applied in Phase 1 (compositing/transforms land in Phase 8+
 *     per design.md §8.6); documented here so the no-op is intentional.
 *
 * This module imports ONLY `@browser-engine/ir` — the single sanctioned channel
 * — so the backend never reaches across a stage boundary
 * (`local/no-cross-stage-import`).
 */
import type {
  BorderSide,
  Color,
  DecodedImage,
  DisplayList,
  Edges,
  Matrix,
  PaintCmd,
  Rect,
} from "@browser-engine/ir";

import { clampAlpha, type Surface } from "./surface.js";
import { builtinFont, coverageSource, type GlyphCoverageSource } from "@browser-engine/font";

/** The default glyph source: the real built-in TrueType font (outline-rasterized). */
const DEFAULT_GLYPH_SOURCE: GlyphCoverageSource = coverageSource(builtinFont());

/** Every paint-command op the abstract DisplayList can carry. */
type PaintOp = PaintCmd["op"];

/** The ops the {@link ScreenshotBackend} can render by default. */
const DEFAULT_SUPPORTED_OPS: ReadonlySet<PaintOp> = new Set<PaintOp>([
  "rect",
  "border",
  "text",
  "image",
  "push-clip",
  "pop-clip",
  "push-layer",
  "pop-layer",
]);

/** The identity 2D affine transform (no translation/scale/skew/rotation). */
const IDENTITY_MATRIX: Matrix = [1, 0, 0, 1, 0, 0];

/** Whether a transform matrix is (within float tolerance) the identity. */
function isIdentityMatrix(m: Matrix): boolean {
  for (let i = 0; i < 6; i += 1) {
    if (Math.abs((m[i] as number) - (IDENTITY_MATRIX[i] as number)) > 1e-9) {
      return false;
    }
  }
  return true;
}

/**
 * Raised when a {@link PaintBackend} receives a {@link PaintCmd} it does not
 * support (design.md §12 "后端缺失命令"; Requirement 13.3). The error EXPLICITLY
 * identifies the offending command's `op` (and, when relevant, the specific
 * unsupported feature), so a developer can either switch backends or implement
 * the command — never a silent wrong render.
 */
export class UnsupportedPaintCommandError extends Error {
  /** The op of the command the backend could not render. */
  readonly op: PaintOp;
  /** Optional detail about the specific unsupported aspect (e.g. a transform). */
  readonly detail?: string;

  constructor(op: PaintOp, detail?: string) {
    super(
      `Paint_Backend received an unsupported PaintCmd: "${op}"` +
        (detail === undefined ? "" : ` — ${detail}`),
    );
    this.name = "UnsupportedPaintCommandError";
    this.op = op;
    if (detail !== undefined) {
      this.detail = detail;
    }
  }
}

/** Options controlling how a {@link ScreenshotBackend} treats commands. */
export interface ScreenshotBackendOptions {
  /**
   * The set of ops this backend is allowed to render. A command whose op is NOT
   * in this set raises {@link UnsupportedPaintCommandError} identifying it
   * (Requirement 13.3). Defaults to {@link DEFAULT_SUPPORTED_OPS} (all ops).
   * Restrict it to model a limited backend (e.g. one that cannot composite).
   */
  readonly supportedOps?: ReadonlySet<PaintOp>;
  /**
   * When `true`, the backend ERRORS on a feature it can decode but cannot
   * faithfully render rather than silently approximating it — specifically a
   * `push-layer` carrying a NON-identity `transform` (Phase 1 never applied the
   * matrix; a strict C-tier backend must not silently drop it). Defaults to
   * `false`, preserving the documented Phase 1 "transform is a no-op" behaviour.
   */
  readonly strictTransforms?: boolean;
  /**
   * The REAL-FONT glyph coverage source (from `@browser-engine/font`). `text`
   * commands rasterize genuine scalable vector outlines (parsed TrueType,
   * anti-aliased). Defaults to the built-in TrueType font; inject a parsed
   * `.ttf` face to render with any real font. The DisplayList is unchanged —
   * `text` glyph ids are treated as code points the source maps to its glyphs.
   */
  readonly glyphSource?: GlyphCoverageSource;
}

/**
 * The replaceable paint backend (design.md §8.6). Its single method consumes a
 * frozen {@link DisplayList} and renders into a {@link Surface}. The signature
 * is the entire contract: the backend never receives an upstream IR handle, so
 * reverse reads are impossible by construction (Requirement 3.5).
 */
export interface PaintBackend {
  render(list: DisplayList, surface: Surface): void;
}

/** An axis-aligned clip region in integer device-pixel bounds (half-open). */
interface ClipBounds {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly radius?: number;
  readonly rx?: number;
  readonly ry?: number;
  readonly rw?: number;
  readonly rh?: number;
}

/**
 * A minimal software-raster {@link PaintBackend}. Stateless across `render`
 * calls; all rasterization state lives in locals, so a single instance can
 * render many DisplayLists.
 */
export class ScreenshotBackend implements PaintBackend {
  /** The ops this backend will render; others raise an explicit error (Req 13.3). */
  readonly #supportedOps: ReadonlySet<PaintOp>;
  /** Whether a non-identity layer transform is an explicit error vs a no-op. */
  readonly #strictTransforms: boolean;
  /** The real-font glyph coverage source (defaults to the built-in TrueType font). */
  readonly #glyphSource: GlyphCoverageSource;

  constructor(options: ScreenshotBackendOptions = {}) {
    this.#supportedOps = options.supportedOps ?? DEFAULT_SUPPORTED_OPS;
    this.#strictTransforms = options.strictTransforms ?? false;
    this.#glyphSource = options.glyphSource ?? DEFAULT_GLYPH_SOURCE;
  }

  /**
   * Rasterize `list` into `surface`. The DisplayList is the ONLY rendering input
   * — no upstream IR is consulted (Requirement 3.5). Commands paint in list
   * order (the paint engine already emitted them in paint order).
   *
   * If the list carries a command whose op this backend does not support, it
   * raises {@link UnsupportedPaintCommandError} identifying the command
   * (Requirement 13.3) rather than rendering it wrong or skipping it silently.
   */
  render(list: DisplayList, surface: Surface): void {
    const fullClip: ClipBounds = { x0: 0, y0: 0, x1: surface.width, y1: surface.height };
    const clipStack: ClipBounds[] = [fullClip];
    const currentClip = (): ClipBounds => clipStack[clipStack.length - 1] as ClipBounds;

    // The compositing layer stack. The base target is `surface`; each push-layer
    // allocates a TRANSPARENT offscreen target that draws accumulate into, and
    // pop-layer composites it onto the parent applying the layer's opacity and
    // (if non-identity) its affine transform. This is the real software
    // compositor: transforms are APPLIED (inverse-mapped sampling), and opacity
    // is correct GROUP opacity.
    const targets: Surface[] = [surface];
    const frames: LayerFrame[] = [];
    const currentTarget = (): Surface => targets[targets.length - 1] as Surface;

    const closeLayer = (): void => {
      const frame = frames.pop();
      if (frame === undefined) return;
      targets.pop();
      if (frame.filter !== undefined) applyFilter(frame.surface, frame.filter);
      compositeLayer(currentTarget(), frame.surface, frame.opacity, frame.transform);
      while (clipStack.length > frame.clipDepth) clipStack.pop();
    };

    for (const cmd of list.commands) {
      if (!this.#supportedOps.has(cmd.op)) {
        throw new UnsupportedPaintCommandError(cmd.op);
      }
      switch (cmd.op) {
        case "push-clip": {
          const next = intersect(currentClip(), rectToBounds(cmd.rect));
          const radius = cmd.radius !== undefined ? Number(cmd.radius) : 0;
          if (radius > 0) {
            clipStack.push({
              ...next,
              radius,
              rx: Number(cmd.rect.x),
              ry: Number(cmd.rect.y),
              rw: Number(cmd.rect.width),
              rh: Number(cmd.rect.height),
            });
          } else {
            clipStack.push(next);
          }
          break;
        }
        case "pop-clip":
          if (clipStack.length > 1) clipStack.pop();
          break;
        case "push-layer": {
          const nonIdentity = !isIdentityMatrix(cmd.transform);
          if (this.#strictTransforms && nonIdentity) {
            throw new UnsupportedPaintCommandError(
              "push-layer",
              "non-identity layer transform is not supported by this backend",
            );
          }
          const offscreen: Surface = {
            width: surface.width,
            height: surface.height,
            pixels: new Uint8ClampedArray(surface.width * surface.height * 4), // transparent
          };
          targets.push(offscreen);
          frames.push({
            surface: offscreen,
            opacity: clampAlpha(cmd.opacity),
            transform: nonIdentity ? cmd.transform : null,
            filter: cmd.filter !== undefined && cmd.filter !== "none" ? cmd.filter : undefined,
            clipDepth: clipStack.length,
          });
          break;
        }
        case "pop-layer":
          closeLayer();
          break;
        default:
          this.execute(cmd, currentTarget(), currentClip());
      }
    }
    // Composite any unbalanced open layers (defensive).
    while (frames.length > 0) closeLayer();
  }

  /** Dispatch a non-layer paint command into `target`, clipped to `clip`. */
  private execute(cmd: PaintCmd, target: Surface, clip: ClipBounds): void {
    switch (cmd.op) {
      case "rect":
        fillRect(target, cmd.rect, cmd.fill, clip, 1, cmd.radius !== undefined ? Number(cmd.radius) : 0);
        return;
      case "border":
        fillBorder(target, cmd.rect, cmd.edges, clip, 1);
        return;
      case "text":
        renderText(target, cmd, clip, 1, this.#glyphSource);
        return;
      case "image":
        blitImage(target, cmd.rect, cmd.src, clip, 1, cmd.radius !== undefined ? Number(cmd.radius) : 0);
        return;
      // push/pop-clip and push/pop-layer are handled in `render`.
      case "push-clip":
      case "pop-clip":
      case "push-layer":
      case "pop-layer":
        return;
    }
  }
}

/** A pushed compositing layer awaiting its `pop-layer` composite. */
interface LayerFrame {
  readonly surface: Surface;
  readonly opacity: number;
  /** The device-absolute affine transform, or `null` for an identity layer. */
  readonly transform: Matrix | null;
  /** CSS `filter` functions to apply before compositing, or `undefined`. */
  readonly filter: string | undefined;
  /** The clip-stack depth at push time, restored on pop. */
  readonly clipDepth: number;
}

/**
 * Composite an offscreen `layer` onto `dest` with `opacity`. For an identity
 * (null) transform this is a straight source-over of the layer's accumulated
 * pixels; otherwise each destination pixel is inverse-mapped through the
 * transform and BILINEARLY sampled from the layer — the real affine raster a
 * transform produces (translate/scale/rotate/skew). The destination keeps its
 * own alpha semantics (the opaque base stays opaque).
 */
function compositeLayer(dest: Surface, layer: Surface, opacity: number, transform: Matrix | null): void {
  if (opacity <= 0) return;
  const w = dest.width;
  const h = dest.height;
  const lp = layer.pixels;
  if (transform === null) {
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = (y * w + x) * 4;
        const a = (lp[i + 3] as number) / 255;
        if (a <= 0) continue;
        compositeStraight(dest, x, y, lp[i] as number, lp[i + 1] as number, lp[i + 2] as number, a * opacity);
      }
    }
    return;
  }
  const inv = invertMatrix(transform);
  if (inv === null) return; // singular transform collapses to nothing.
  const [ia, ib, ic, id, ie, iff] = inv;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const dx = x + 0.5;
      const dy = y + 0.5;
      const sx = ia * dx + ic * dy + ie - 0.5;
      const sy = ib * dx + id * dy + iff - 0.5;
      const sample = sampleBilinear(layer, sx, sy);
      if (sample === null || sample.a <= 0) continue;
      compositeStraight(dest, x, y, sample.r, sample.g, sample.b, sample.a * opacity);
    }
  }
}

/**
 * Apply a CSS `filter` functions string to an offscreen layer IN PLACE: real
 * software passes over the layer's straight-alpha pixels. Supported:
 * `blur(px)` (separable box blur ×3 ≈ Gaussian, on premultiplied colour),
 * `grayscale/sepia/saturate/invert/brightness/contrast/opacity(n)` (per-pixel
 * colour-matrix ops). Functions apply left-to-right, exactly as CSS composes
 * them. Unknown functions are skipped (no fabricated effect).
 */
function applyFilter(layer: Surface, filter: string): void {
  const fnRe = /([a-z-]+)\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(filter.toLowerCase())) !== null) {
    const fn = m[1] as string;
    const arg = (m[2] ?? "").trim();
    if (fn === "blur") {
      const radius = Number.parseFloat(arg.replace(/px$/, ""));
      if (Number.isFinite(radius) && radius > 0) boxBlur(layer, Math.round(radius));
    } else {
      const amt = parseFilterAmount(arg);
      const colorOp = colorMatrixOp(fn, amt);
      if (colorOp !== null) applyColorOp(layer, colorOp);
    }
  }
}

/** Parse a filter amount: a number or a `%` (→ 0..1+), default 1. */
function parseFilterAmount(arg: string): number {
  if (arg === "") return 1;
  if (arg.endsWith("%")) return Number.parseFloat(arg) / 100;
  const n = Number.parseFloat(arg);
  return Number.isFinite(n) ? n : 1;
}

/** A per-pixel colour transform `(r,g,b,a) → (r,g,b,a)` for the colour-matrix filters. */
type ColorOp = (r: number, g: number, b: number, a: number) => readonly [number, number, number, number];

/** Build the colour transform for a CSS colour-matrix filter, or `null` if unknown. */
function colorMatrixOp(fn: string, amt: number): ColorOp | null {
  switch (fn) {
    case "grayscale": {
      const t = Math.min(1, amt);
      return (r, g, b, a) => {
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        return [r + (l - r) * t, g + (l - g) * t, b + (l - b) * t, a];
      };
    }
    case "sepia": {
      const t = Math.min(1, amt);
      return (r, g, b, a) => {
        const sr = 0.393 * r + 0.769 * g + 0.189 * b;
        const sg = 0.349 * r + 0.686 * g + 0.168 * b;
        const sb = 0.272 * r + 0.534 * g + 0.131 * b;
        return [r + (sr - r) * t, g + (sg - g) * t, b + (sb - b) * t, a];
      };
    }
    case "invert": {
      const t = Math.min(1, amt);
      return (r, g, b, a) => [r + (255 - 2 * r) * t, g + (255 - 2 * g) * t, b + (255 - 2 * b) * t, a];
    }
    case "brightness":
      return (r, g, b, a) => [r * amt, g * amt, b * amt, a];
    case "contrast": {
      const off = 128 * (1 - amt);
      return (r, g, b, a) => [r * amt + off, g * amt + off, b * amt + off, a];
    }
    case "saturate":
      return (r, g, b, a) => {
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        return [l + (r - l) * amt, l + (g - l) * amt, l + (b - l) * amt, a];
      };
    case "opacity":
      return (r, g, b, a) => [r, g, b, a * Math.min(1, amt)];
    default:
      return null;
  }
}

/** Apply a per-pixel colour op across a layer's straight-alpha pixels. */
function applyColorOp(layer: Surface, op: ColorOp): void {
  const px = layer.pixels;
  for (let i = 0; i < px.length; i += 4) {
    if ((px[i + 3] as number) === 0) continue; // skip fully transparent.
    const [r, g, b, a] = op(px[i] as number, px[i + 1] as number, px[i + 2] as number, (px[i + 3] as number) / 255);
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = a * 255;
  }
}

/** Separable box blur (3 passes ≈ Gaussian) on PREMULTIPLIED colour, in place. */
function boxBlur(layer: Surface, radius: number): void {
  const w = layer.width;
  const h = layer.height;
  const n = w * h;
  // To premultiplied float channels.
  const pr = new Float64Array(n);
  const pg = new Float64Array(n);
  const pb = new Float64Array(n);
  const pa = new Float64Array(n);
  const src = layer.pixels;
  for (let i = 0; i < n; i += 1) {
    const a = (src[i * 4 + 3] as number) / 255;
    pr[i] = (src[i * 4] as number) * a;
    pg[i] = (src[i * 4 + 1] as number) * a;
    pb[i] = (src[i * 4 + 2] as number) * a;
    pa[i] = a;
  }
  for (let pass = 0; pass < 3; pass += 1) {
    boxBlurPass(pr, w, h, radius);
    boxBlurPass(pg, w, h, radius);
    boxBlurPass(pb, w, h, radius);
    boxBlurPass(pa, w, h, radius);
  }
  // Back to straight-alpha bytes.
  for (let i = 0; i < n; i += 1) {
    const a = pa[i] as number;
    if (a <= 0) {
      src[i * 4] = 0;
      src[i * 4 + 1] = 0;
      src[i * 4 + 2] = 0;
      src[i * 4 + 3] = 0;
      continue;
    }
    src[i * 4] = (pr[i] as number) / a;
    src[i * 4 + 1] = (pg[i] as number) / a;
    src[i * 4 + 2] = (pb[i] as number) / a;
    src[i * 4 + 3] = a * 255;
  }
}

/** One separable box-blur pass (horizontal then vertical) over a float channel. */
function boxBlurPass(chan: Float64Array, w: number, h: number, radius: number): void {
  const win = 2 * radius + 1;
  const tmp = new Float64Array(chan.length);
  // Horizontal.
  for (let y = 0; y < h; y += 1) {
    const row = y * w;
    let sum = 0;
    for (let k = -radius; k <= radius; k += 1) sum += chan[row + clampIdx(k, w)] as number;
    for (let x = 0; x < w; x += 1) {
      tmp[row + x] = sum / win;
      const out = row + clampIdx(x - radius, w);
      const inc = row + clampIdx(x + radius + 1, w);
      sum += (chan[inc] as number) - (chan[out] as number);
    }
  }
  // Vertical.
  for (let x = 0; x < w; x += 1) {
    let sum = 0;
    for (let k = -radius; k <= radius; k += 1) sum += tmp[clampIdx(k, h) * w + x] as number;
    for (let y = 0; y < h; y += 1) {
      chan[y * w + x] = sum / win;
      const out = clampIdx(y - radius, h) * w + x;
      const inc = clampIdx(y + radius + 1, h) * w + x;
      sum += (tmp[inc] as number) - (tmp[out] as number);
    }
  }
}

/** Clamp an index to `[0, size)` (edge-extend for the blur window). */
function clampIdx(i: number, size: number): number {
  return i < 0 ? 0 : i >= size ? size - 1 : i;
}

/** Invert an affine matrix `[a,b,c,d,e,f]`, or `null` when singular. */
function invertMatrix(m: Matrix): Matrix | null {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return null;
  const ia = d / det;
  const ib = -b / det;
  const ic = -c / det;
  const id = a / det;
  return [ia, ib, ic, id, -(ia * e + ic * f), -(ib * e + id * f)];
}

/** Bilinearly sample a layer's straight-alpha pixel at fractional `(x,y)`. */
function sampleBilinear(
  layer: Surface,
  x: number,
  y: number,
): { r: number; g: number; b: number; a: number } | null {
  const w = layer.width;
  const h = layer.height;
  if (x < -0.5 || y < -0.5 || x > w - 0.5 || y > h - 0.5) return null;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const at = (px: number, py: number): readonly [number, number, number, number] => {
    if (px < 0 || py < 0 || px >= w || py >= h) return [0, 0, 0, 0];
    const i = (py * w + px) * 4;
    return [layer.pixels[i] as number, layer.pixels[i + 1] as number, layer.pixels[i + 2] as number, (layer.pixels[i + 3] as number) / 255];
  };
  const p00 = at(x0, y0);
  const p10 = at(x0 + 1, y0);
  const p01 = at(x0, y0 + 1);
  const p11 = at(x0 + 1, y0 + 1);
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
  const mix = (k: number): number =>
    lerp(lerp(p00[k]!, p10[k]!, fx), lerp(p01[k]!, p11[k]!, fx), fy);
  return { r: mix(0), g: mix(1), b: mix(2), a: mix(3) };
}

// ---------------------------------------------------------------------------
// Rasterization primitives. All draws are alpha-blended (source-over), clipped
// to integer device-pixel bounds, and scaled by the active layer opacity.
// ---------------------------------------------------------------------------

/** Convert a CSS-pixel {@link Rect} to half-open integer device bounds. */
function rectToBounds(rect: Rect): ClipBounds {
  const x0 = Math.round(rect.x);
  const y0 = Math.round(rect.y);
  const x1 = Math.round(rect.x + rect.width);
  const y1 = Math.round(rect.y + rect.height);
  return { x0, y0, x1, y1 };
}

/** Intersect two half-open bounds (the smaller, overlapping region). */
function intersect(a: ClipBounds, b: ClipBounds): ClipBounds {
  return {
    x0: Math.max(a.x0, b.x0),
    y0: Math.max(a.y0, b.y0),
    x1: Math.min(a.x1, b.x1),
    y1: Math.min(a.y1, b.y1),
  };
}

function roundedCover(
  px: number,
  py: number,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): number {
  if (!(radius > 0) || !(w > 0) || !(h > 0)) return 1;
  const r = Math.min(radius, w * 0.5, h * 0.5);
  if (!(r > 0)) return 1;
  const lx = px - x;
  const ly = py - y;
  if (lx < 0 || ly < 0 || lx > w || ly > h) return 0;
  let cx: number | null = null;
  let cy: number | null = null;
  if (lx < r && ly < r) {
    cx = x + r;
    cy = y + r;
  } else if (lx > w - r && ly < r) {
    cx = x + w - r;
    cy = y + r;
  } else if (lx < r && ly > h - r) {
    cx = x + r;
    cy = y + h - r;
  } else if (lx > w - r && ly > h - r) {
    cx = x + w - r;
    cy = y + h - r;
  } else {
    return 1;
  }
  const dx = px - (cx);
  const dy = py - (cy);
  const d2 = dx * dx + dy * dy;
  const inner = r - 0.5;
  if (inner > 0 && d2 <= inner * inner) return 1;
  const outer = r + 0.5;
  if (d2 >= outer * outer) return 0;
  const d = Math.sqrt(d2);
  return Math.max(0, Math.min(1, outer - d));
}

function clipPixelCover(clip: ClipBounds, x: number, y: number): number {
  if (x < clip.x0 || x >= clip.x1 || y < clip.y0 || y >= clip.y1) return 0;
  const r = clip.radius ?? 0;
  if (!(r > 0)) return 1;
  const rx = clip.rx ?? clip.x0;
  const ry = clip.ry ?? clip.y0;
  const rw = clip.rw ?? clip.x1 - clip.x0;
  const rh = clip.rh ?? clip.y1 - clip.y0;
  return roundedCover(x + 0.5, y + 0.5, rx, ry, rw, rh, r);
}

/** Fill `rect` with `fill`, clipped to `clip` and scaled by `opacity`. */
function fillRect(
  surface: Surface,
  rect: Rect,
  fill: Color,
  clip: ClipBounds,
  opacity: number,
  radius = 0,
): void {
  const region = intersect(rectToBounds(rect), clip);
  const clipRounded = (clip.radius ?? 0) > 0;
  if (!(radius > 0) && !clipRounded) {
    blendRegion(surface, region, fill, opacity);
    return;
  }
  const bx = Number(rect.x);
  const by = Number(rect.y);
  const bw = Number(rect.width);
  const bh = Number(rect.height);
  for (let y = region.y0; y < region.y1; y += 1) {
    for (let x = region.x0; x < region.x1; x += 1) {
      let cover = 1;
      if (clipRounded) {
        cover = clipPixelCover(clip, x, y);
        if (cover <= 0) continue;
      }
      if (radius > 0) {
        cover *= roundedCover(x + 0.5, y + 0.5, bx, by, bw, bh, radius);
        if (cover <= 0) continue;
      }
      blendPixel(surface, x, y, fill, opacity * cover);
    }
  }
}

/** Fill the four border edges that are not `none`, within `rect`. */
function fillBorder(
  surface: Surface,
  rect: Rect,
  edges: Edges<BorderSide>,
  clip: ClipBounds,
  opacity: number,
): void {
  const b = rectToBounds(rect);
  const draw = (edge: BorderSide, region: ClipBounds): void => {
    if (edge.style === "none" || edge.width <= 0) return;
    blendRegion(surface, intersect(region, clip), edge.color, opacity);
  };
  const top = Math.round(edges.top.width);
  const right = Math.round(edges.right.width);
  const bottom = Math.round(edges.bottom.width);
  const left = Math.round(edges.left.width);
  draw(edges.top, { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y0 + top });
  draw(edges.bottom, { x0: b.x0, y0: b.y1 - bottom, x1: b.x1, y1: b.y1 });
  draw(edges.left, { x0: b.x0, y0: b.y0, x1: b.x0 + left, y1: b.y1 });
  draw(edges.right, { x0: b.x1 - right, y0: b.y0, x1: b.x1, y1: b.y1 });
}

/**
 * Rasterize a `text` paint command with ANTI-ALIASING: each glyph's built-in
 * bitmap is mapped into its cell `[at + offset, advance × fontSize]`, and every
 * device pixel is blended in `fill` weighted by the FRACTIONAL COVERAGE of the
 * inked design cells it overlaps (a box-filter / area-coverage AA — the standard
 * rasterizer mechanism, not per-glyph tuning). Clipped + opacity-scaled. An
 * uncovered glyph id is skipped (a missing glyph), never a fabricated block.
 *
 * This replaces the earlier nearest-cell block fill: glyph GEOMETRY is unchanged
 * (the cell is still `[offset, advance]×fontSize`, so layout/paint contracts and
 * every geometry test are untouched), only edge pixels gain partial coverage —
 * the fidelity a real glyph rasterizer (FreeType) provides, behind this same
 * DisplayList boundary.
 */
/**
 * Rasterize a `text` command using REAL FONT outlines via the glyph
 * {@link GlyphCoverageSource}. Each IR glyph id is treated as a Unicode code
 * point, mapped to the font's glyph id, rasterized to anti-aliased coverage at
 * `fontSize`, and blitted at the pen position with correct baseline placement
 * (`em-box top + ascent − glyph-top`). Clipped + opacity-scaled. A code point
 * the font lacks (glyph id 0), or a blank glyph (space), paints nothing. This is
 * the ONE glyph path — genuine scalable vector outlines, no bitmap fallback.
 */
function renderText(
  surface: Surface,
  cmd: Extract<PaintCmd, { readonly op: "text" }>,
  clip: ClipBounds,
  opacity: number,
  source: GlyphCoverageSource,
): void {
  const fontSize = cmd.fontSize;
  if (fontSize <= 0) return;
  const ascentPx = source.ascentEm * fontSize;
  const weight = cmd.fontWeight !== undefined ? Number(cmd.fontWeight) : 400;
  const boldOffset = weight >= 700 ? 1 : weight >= 500 ? 1 : 0;
  for (const glyph of cmd.glyphs) {
    const gid = source.glyphId(glyph.glyphId);
    if (gid === 0) continue; // missing glyph ⇒ blank, never a fabricated block.
    const r = source.raster(gid, fontSize);
    if (r.width === 0 || r.height === 0) continue; // blank glyph (e.g. space).
    const stamps = boldOffset > 0 ? [0, boldOffset] : [0];
    for (const dx of stamps) {
      const gridLeft = Math.round(cmd.at.x + glyph.offset.x + r.left + dx);
      const gridTop = Math.round(cmd.at.y + glyph.offset.y + ascentPx - r.top);
      for (let ry = 0; ry < r.height; ry += 1) {
        const py = gridTop + ry;
        if (py < clip.y0 || py >= clip.y1) continue;
        const rowBase = ry * r.width;
        for (let rx = 0; rx < r.width; rx += 1) {
          const px = gridLeft + rx;
          if (px < clip.x0 || px >= clip.x1) continue;
          const cov = r.coverage[rowBase + rx] ?? 0;
          if (cov <= 0) continue;
          blendPixel(surface, px, py, cmd.fill, opacity * cov);
        }
      }
    }
  }
}

/** Blit a decoded RGBA image into `rect` (nearest-cell), clipped + scaled. */
function blitImage(
  surface: Surface,
  rect: Rect,
  src: DecodedImage,
  clip: ClipBounds,
  opacity: number,
  radius = 0,
): void {
  const bounds = rectToBounds(rect);
  const dst = intersect(bounds, clip);
  const destW = bounds.x1 - bounds.x0;
  const destH = bounds.y1 - bounds.y0;
  if (destW <= 0 || destH <= 0 || src.width <= 0 || src.height <= 0) return;
  const originX = bounds.x0;
  const originY = bounds.y0;
  const clipRounded = (clip.radius ?? 0) > 0;
  const bx = Number(rect.x);
  const by = Number(rect.y);
  const bw = Number(rect.width);
  const bh = Number(rect.height);
  for (let y = dst.y0; y < dst.y1; y += 1) {
    const sy = Math.min(src.height - 1, Math.floor(((y - originY) / destH) * src.height));
    for (let x = dst.x0; x < dst.x1; x += 1) {
      let cover = 1;
      if (clipRounded) {
        cover = clipPixelCover(clip, x, y);
        if (cover <= 0) continue;
      }
      if (radius > 0) {
        cover *= roundedCover(x + 0.5, y + 0.5, bx, by, bw, bh, radius);
        if (cover <= 0) continue;
      }
      const sx = Math.min(src.width - 1, Math.floor(((x - originX) / destW) * src.width));
      const si = (sy * src.width + sx) * 4;
      const color: Color = {
        r: src.pixels[si] as number,
        g: src.pixels[si + 1] as number,
        b: src.pixels[si + 2] as number,
        a: (src.pixels[si + 3] as number) / 255,
      };
      blendPixel(surface, x, y, color, opacity * cover);
    }
  }
}

/** Alpha-blend a solid colour across every pixel of a half-open `region`. */
function blendRegion(surface: Surface, region: ClipBounds, color: Color, opacity: number): void {
  const x0 = Math.max(0, region.x0);
  const y0 = Math.max(0, region.y0);
  const x1 = Math.min(surface.width, region.x1);
  const y1 = Math.min(surface.height, region.y1);
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      blendPixel(surface, x, y, color, opacity);
    }
  }
}

/** Source-over blend of one straight-alpha `color` onto pixel `(x, y)`. */
function blendPixel(surface: Surface, x: number, y: number, color: Color, opacity: number): void {
  if (x < 0 || y < 0 || x >= surface.width || y >= surface.height) return;
  const sa = clampAlpha(color.a) * clampAlpha(opacity);
  if (sa <= 0) return;
  compositeStraight(surface, x, y, color.r, color.g, color.b, sa);
}

/**
 * Alpha-correct source-over of a straight-alpha source `(r,g,b,sa)` onto pixel
 * `(x,y)`. Tracks the destination alpha so OFFSCREEN layer buffers (which start
 * transparent) accumulate coverage correctly; on the opaque base surface
 * (`dstA = 1`) it reduces to the classic `src·a + dst·(1−a)` with alpha staying
 * 255 — so the base render path is unchanged.
 */
function compositeStraight(
  surface: Surface,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
  sa: number,
): void {
  const i = (y * surface.width + x) * 4;
  const px = surface.pixels;
  const dstA = (px[i + 3] as number) / 255;
  const outA = sa + dstA * (1 - sa);
  if (outA <= 0) {
    px[i] = 0;
    px[i + 1] = 0;
    px[i + 2] = 0;
    px[i + 3] = 0;
    return;
  }
  const k = dstA * (1 - sa);
  px[i] = (r * sa + (px[i] as number) * k) / outA;
  px[i + 1] = (g * sa + (px[i + 1] as number) * k) / outA;
  px[i + 2] = (b * sa + (px[i + 2] as number) * k) / outA;
  px[i + 3] = outA * 255;
}
