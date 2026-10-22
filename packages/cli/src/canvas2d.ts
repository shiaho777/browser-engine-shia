/**
 * canvas2d.ts — RFC 0033: a REAL CanvasRenderingContext2D backed by Skia.
 *
 * ## Model: recorded op log + lazy rasterization
 *
 * Guest calls record *resolved* raster ops (path in user space + the CTM at
 * call time, paint resolved to a PaintSpec, the clip stack snapshotted as
 * device-space path entries). Nothing is drawn at call time:
 * `rasterize()` replays the log onto a CanvasKit raster `Surface` and reads
 * back RGBA pixels. This mirrors the rest of the engine — the op log is the
 * IR, the bitmap is a view — and it is what makes a synchronous guest API
 * safe while CanvasKit's WASM init is asynchronous: ops record
 * unconditionally; the bitmap exists as soon as `loadCanvasKit()` has
 * settled anywhere in the process.
 *
 * ## Clip semantics
 *
 * `clip()` transforms the path into DEVICE space at record time and pushes
 * it onto the drawing state's clip list (spec: clipping is part of the
 * drawing state; later transforms don't move it). Each draw op carries the
 * clip list and the rasterizer reapplies every entry per op — save/restore
 * stay a pure state-stack affair.
 *
 * ## Honest boundaries (kept current in RFC 0033)
 *
 *  - Text is unshaped single-run `drawText` (no bidi/script shaping,
 *    one resolved family); `ctx.font` accepts the CSS `font` shorthand's
 *    style/weight/size/family subset — families resolve to the engine's
 *    built-in face.
 *  - `isPointInStroke` approximates stroke coverage as distance-to-
 *    flattened-centerline ≤ lineWidth/2 (joins/caps/dashes ignored).
 *  - `putImageData`'s optional dirty-rect is honored; compositing is the
 *    spec's raw splat (no transform/clip/blend — correct).
 *  - No `CanvasFilter` (`ctx.filter`), no `getContextAttributes` state
 *    beyond `{alpha:true}`, no `drawImage(video)` (no decoded frames).
 *  - A cold CanvasKit (nothing in the process ever rasterized) makes
 *    `getImageData`/`toDataURL` return correctly-sized transparent data —
 *    a documented honesty valve, not a stub: ops still record.
 */

import {
  canvasKitIfReady,
  encodeSurfaceToPng,
  loadCanvasKit,
} from "@browser-engine/backend";
import { builtinFontBytes } from "@browser-engine/font";
import type { Color, DecodedImage } from "@browser-engine/ir";
import type { Canvas, CanvasKit, Paint, Path, Typeface } from "canvaskit-wasm";

import { parseCanvasColor } from "./canvas-color.js";

/* ------------------------------------------------------------------ */
/* 2D affine — the engine's [a,b,c,d,e,f] convention                    */
/* ------------------------------------------------------------------ */

export type M6 = readonly [number, number, number, number, number, number];

const IDENTITY: M6 = [1, 0, 0, 1, 0, 0];

function mul(m: M6, n: M6): M6 {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function applyM(m: M6, x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/** Our [a,b,c,d,e,f] → Skia row-major 3×3 (same convention as skia.ts). */
function toSkiaMatrix(m: M6): number[] {
  return [m[0], m[2], m[4], m[1], m[3], m[5], 0, 0, 1];
}

/* ------------------------------------------------------------------ */
/* Path representation — serializable verb list                        */
/* ------------------------------------------------------------------ */

type Verb =
  | { readonly v: "M" | "L"; readonly x: number; readonly y: number }
  | { readonly v: "Q"; readonly cx: number; readonly cy: number; readonly x: number; readonly y: number }
  | { readonly v: "C"; readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number; readonly x: number; readonly y: number }
  | { readonly v: "Z" }
  | { readonly v: "A"; readonly cx: number; readonly cy: number; readonly r: number; readonly a0: number; readonly a1: number; readonly ccw: boolean }
  | { readonly v: "E"; readonly cx: number; readonly cy: number; readonly rx: number; readonly ry: number; readonly rot: number; readonly a0: number; readonly a1: number; readonly ccw: boolean }
  | { readonly v: "RR"; readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly radii: readonly number[] };

export type PathRep = readonly Verb[];

const DEG = 180 / Math.PI;

/** Replay a PathRep via PathBuilder → immutable Path (degrees per CanvasKit). */
function toSkiaPath(ck: CanvasKit, rep: PathRep, transform?: M6): Path {
  const b = new ck.PathBuilder();
  try {
    for (const v of rep) {
      switch (v.v) {
        case "M": b.moveTo(v.x, v.y); break;
        case "L": b.lineTo(v.x, v.y); break;
        case "Q": b.quadTo(v.cx, v.cy, v.x, v.y); break;
        case "C": b.cubicTo(v.x1, v.y1, v.x2, v.y2, v.x, v.y); break;
        case "Z": b.close(); break;
        case "A": {
          // arc → oval sweep; forceMoveTo=false stitches to the current point.
          const oval = ck.LTRBRect(v.cx - v.r, v.cy - v.r, v.cx + v.r, v.cy + v.r);
          b.arcToOval(oval, v.a0 * DEG, normSweep(v.a0, v.a1, v.ccw) * DEG, false);
          break;
        }
        case "E": {
          const oval = ck.LTRBRect(v.cx - v.rx, v.cy - v.ry, v.cx + v.rx, v.cy + v.ry);
          if (v.rot === 0) {
            b.arcToOval(oval, v.a0 * DEG, normSweep(v.a0, v.a1, v.ccw) * DEG, false);
          } else {
            // Rotated ellipse: build it unrotated, transform, extend.
            const sub = new ck.PathBuilder();
            sub.arcToOval(oval, v.a0 * DEG, normSweep(v.a0, v.a1, v.ccw) * DEG, false);
            const c = Math.cos(v.rot);
            const s = Math.sin(v.rot);
            sub.transform([c, s, v.cx * (1 - c) - v.cy * s, -s, c, v.cy * (1 - c) + v.cx * s, 0, 0, 1]);
            b.addPath(sub);
            sub.delete();
          }
          break;
        }
        case "RR": {
          const rr = ck.RRectXY(
            ck.LTRBRect(v.x, v.y, v.x + v.w, v.y + v.h),
            v.radii[0] ?? 0,
            v.radii[1] ?? v.radii[0] ?? 0,
          );
          b.addRRect(rr, true);
          break;
        }
      }
    }
    if (transform !== undefined) b.transform(toSkiaMatrix(transform));
    return b.snapshot();
  } finally {
    b.delete();
  }
}

/**
 * Flatten a path to device-space polygons (curves/arcs subdivided) — used by
 * hit-testing only; rasterization keeps the analytic path.
 */
function flattenPath(rep: PathRep, m: M6): { x: number; y: number }[][] {
  const polys: { x: number; y: number }[][] = [];
  let cur: { x: number; y: number }[] = [];
  let px = 0;
  let py = 0;
  let startX = 0;
  let startY = 0;
  const push = (x: number, y: number): void => {
    const p = applyM(m, x, y);
    cur.push(p);
    px = x;
    py = y;
  };
  const closeSub = (): void => {
    if (cur.length > 1) polys.push(cur);
    cur = [];
  };
  for (const v of rep) {
    switch (v.v) {
      case "M":
        closeSub();
        push(v.x, v.y);
        startX = v.x;
        startY = v.y;
        break;
      case "L":
        push(v.x, v.y);
        break;
      case "Q": {
        for (let i = 1; i <= 8; i += 1) {
          const t = i / 8;
          const u = 1 - t;
          push(
            u * u * px + 2 * u * t * v.cx + t * t * v.x,
            u * u * py + 2 * u * t * v.cy + t * t * v.y,
          );
        }
        break;
      }
      case "C": {
        for (let i = 1; i <= 10; i += 1) {
          const t = i / 10;
          const u = 1 - t;
          push(
            u * u * u * px + 3 * u * u * t * v.x1 + 3 * u * t * t * v.x2 + t * t * t * v.x,
            u * u * u * py + 3 * u * u * t * v.y1 + 3 * u * t * t * v.y2 + t * t * t * v.y,
          );
        }
        break;
      }
      case "Z":
        push(startX, startY);
        closeSub();
        break;
      case "A": {
        const sweep = normSweep(v.a0, v.a1, v.ccw);
        const steps = Math.max(4, Math.ceil(Math.abs(sweep) / (Math.PI / 12)));
        for (let i = 0; i <= steps; i += 1) {
          const a = v.a0 + (sweep * i) / steps;
          push(v.cx + v.r * Math.cos(a), v.cy + v.r * Math.sin(a));
        }
        break;
      }
      case "E": {
        const sweep = normSweep(v.a0, v.a1, v.ccw);
        const steps = Math.max(4, Math.ceil(Math.abs(sweep) / (Math.PI / 12)));
        const c = Math.cos(v.rot);
        const s = Math.sin(v.rot);
        for (let i = 0; i <= steps; i += 1) {
          const a = v.a0 + (sweep * i) / steps;
          const ex = v.rx * Math.cos(a);
          const ey = v.ry * Math.sin(a);
          push(v.cx + ex * c - ey * s, v.cy + ex * s + ey * c);
        }
        break;
      }
      case "RR": {
        const [r] = v.radii;
        const rr = Math.min(r ?? 0, Math.min(v.w, v.h) / 2);
        for (const [ax, ay, a0] of [
          [v.x + rr, v.y + rr, Math.PI],
          [v.x + v.w - rr, v.y + rr, -Math.PI / 2],
          [v.x + v.w - rr, v.y + v.h - rr, 0],
          [v.x + rr, v.y + v.h - rr, Math.PI / 2],
        ] as const) {
          for (let i = 0; i <= 4; i += 1) {
            const a = a0 + (Math.PI / 2) * (i / 4);
            push(ax + rr * Math.cos(a), ay + rr * Math.sin(a));
          }
        }
        closeSub();
        break;
      }
    }
  }
  closeSub();
  return polys;
}

/**
 * Signed sweep for a0→a1 honoring ccw (HTML §"arc" steps): equal angles →
 * empty; congruent-but-unequal angles → a full-circle sweep.
 */
function normSweep(a0: number, a1: number, ccw: boolean): number {
  const tau = Math.PI * 2;
  if (a0 === a1) return 0;
  let s = (a1 - a0) % tau;
  if (!ccw) {
    if (s <= 0) s += tau; // (0, 2π]; s==0 means congruent → full circle
    return s;
  }
  if (s >= 0) s -= tau; // [-2π, 0)
  return s;
}

/** Winding-rule point test over flattened device-space polys. */
function pointInPath(polys: { x: number; y: number }[][], x: number, y: number, evenOdd: boolean): boolean {
  let inside = false;
  let winding = 0;
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
      const a = poly[i]!;
      const b = poly[j]!;
      const crosses = (a.y > y) !== (b.y > y);
      if (crosses) {
        const xi = a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x);
        if (x < xi) {
          inside = !inside;
          winding += b.y > a.y ? 1 : -1;
        }
      }
    }
  }
  return evenOdd ? inside : winding !== 0;
}

/** Distance from p to segment ab — stroke hit-test approximation. */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/* ------------------------------------------------------------------ */
/* Paints — resolved at record time                                    */
/* ------------------------------------------------------------------ */

export type PaintSpec =
  | { readonly k: "color"; readonly c: Color }
  | { readonly k: "linear"; readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number; readonly stops: readonly { o: number; c: Color }[] }
  | { readonly k: "radial"; readonly x0: number; readonly y0: number; readonly r0: number; readonly x1: number; readonly y1: number; readonly r1: number; readonly stops: readonly { o: number; c: Color }[] }
  | { readonly k: "conic"; readonly startAngle: number; readonly x: number; readonly y: number; readonly stops: readonly { o: number; c: Color }[] }
  | { readonly k: "pattern"; readonly img: DecodedImage; readonly rep: "repeat" | "repeat-x" | "repeat-y" | "no-repeat"; readonly matrix?: M6 };

interface StrokeSpec {
  readonly width: number;
  readonly cap: "butt" | "round" | "square";
  readonly join: "miter" | "round" | "bevel";
  readonly miter: number;
  readonly dash: readonly number[];
  readonly dashOff: number;
}

interface ShadowSpec {
  readonly blur: number;
  readonly color: Color;
  readonly dx: number;
  readonly dy: number;
}

interface FontSpec {
  readonly sizePx: number;
  readonly style: "normal" | "italic" | "oblique";
  readonly weight: number;
  readonly family: string;
}

interface ClipEntry {
  readonly path: PathRep;
  readonly ctm: M6;
  readonly rule: "nonzero" | "evenodd";
}

interface DrawCommon {
  readonly ctm: M6;
  readonly clips: readonly ClipEntry[];
  readonly alpha: number;
  readonly blend: string;
  readonly shadow: ShadowSpec;
  readonly smoothing: boolean;
}

type RasterOp =
  | (DrawCommon & { readonly k: "fill"; readonly path: PathRep; readonly rule: "nonzero" | "evenodd"; readonly paint: PaintSpec })
  | (DrawCommon & { readonly k: "stroke"; readonly path: PathRep; readonly paint: PaintSpec; readonly stroke: StrokeSpec })
  | (DrawCommon & { readonly k: "image"; readonly src: DecodedImage; readonly sx: number; readonly sy: number; readonly sw: number; readonly sh: number; readonly dx: number; readonly dy: number; readonly dw: number; readonly dh: number })
  | (DrawCommon & { readonly k: "text"; readonly text: string; readonly x: number; readonly y: number; readonly font: FontSpec; readonly mode: "fill" | "stroke"; readonly paint: PaintSpec; readonly stroke: StrokeSpec; readonly align: DrawState["textAlign"]; readonly baseline: DrawState["textBaseline"] })
  | { readonly k: "clear"; readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly ctm: M6; readonly clips: readonly ClipEntry[] }
  | { readonly k: "raw"; readonly pixels: Uint8ClampedArray; readonly w: number; readonly h: number; readonly dx: number; readonly dy: number };

/** The per-context drawing state (save/restore snapshots this). */
interface DrawState {
  ctm: M6;
  clips: ClipEntry[];
  fill: PaintSpec;
  stroke: PaintSpec;
  line: StrokeSpec;
  alpha: number;
  blend: string;
  font: FontSpec;
  textAlign: "start" | "end" | "left" | "right" | "center";
  textBaseline: "alphabetic" | "top" | "hanging" | "middle" | "ideographic" | "bottom";
  direction: "ltr" | "rtl" | "inherit";
  shadow: ShadowSpec;
  smoothing: boolean;
  smoothingQuality: string;
  dash: number[];
}

function defaultState(): DrawState {
  const black: PaintSpec = { k: "color", c: { r: 0, g: 0, b: 0, a: 1 } };
  return {
    ctm: IDENTITY,
    clips: [],
    fill: black,
    stroke: black,
    line: { width: 1, cap: "butt", join: "miter", miter: 10, dash: [], dashOff: 0 },
    alpha: 1,
    blend: "source-over",
    font: { sizePx: 10, style: "normal", weight: 400, family: "sans-serif" },
    textAlign: "start",
    textBaseline: "alphabetic",
    direction: "inherit",
    shadow: { blur: 0, color: { r: 0, g: 0, b: 0, a: 0 }, dx: 0, dy: 0 },
    smoothing: true,
    smoothingQuality: "low",
    dash: [],
  };
}

function copyState(s: DrawState): DrawState {
  return { ...s, clips: [...s.clips], dash: [...s.dash] };
}

/** Parse `ctx.font`'s CSS shorthand subset — `<style>? <weight>? <size>[/<lh>]? <family>`. */
function parseFontSpec(raw: string): FontSpec | undefined {
  const m =
    /^\s*(?:(italic|oblique)\s+)?(?:(\d{3}|bold|bolder|lighter|normal)\s+)?(?:small-caps\s+)?([\d.]+)px(?:\s*\/\s*[^\s]+)?\s+(.+?)\s*$/i.exec(raw);
  if (m === null) return undefined;
  const weightTok = (m[2] ?? "normal").toLowerCase();
  const weight =
    weightTok === "bold" ? 700
      : weightTok === "normal" ? 400
        : /^\d{3}$/.test(weightTok) ? Number(weightTok)
          : 400;
  return {
    sizePx: Number(m[3]),
    style: (m[1]?.toLowerCase() ?? "normal") as FontSpec["style"],
    weight,
    family: m[4]!.trim(),
  };
}

/* ------------------------------------------------------------------ */
/* The engine — record side + rasterize side                           */
/* ------------------------------------------------------------------ */

/** A guest-visible gradient/pattern handle (opaque to the script). */
export interface CanvasStyleHandle {
  readonly spec: PaintSpec;
}

/** What a `drawImage` source resolved to. */
export interface ResolvedImageSource {
  readonly img: DecodedImage;
}

const BLEND_MODES: Record<string, string> = {
  "source-over": "SrcOver",
  "source-in": "SrcIn",
  "source-out": "SrcOut",
  "source-atop": "SrcATop",
  "destination-over": "DstOver",
  "destination-in": "DstIn",
  "destination-out": "DstOut",
  "destination-atop": "DstATop",
  lighter: "Plus",
  copy: "Src",
  xor: "Xor",
  multiply: "Multiply",
  screen: "Screen",
  overlay: "Overlay",
  darken: "Darken",
  lighten: "Lighten",
  "color-dodge": "ColorDodge",
  "color-burn": "ColorBurn",
  "hard-light": "HardLight",
  "soft-light": "SoftLight",
  difference: "Difference",
  exclusion: "Exclusion",
  hue: "Hue",
  saturation: "Saturation",
  color: "Color",
  luminosity: "Luminosity",
};

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * One canvas's backing store + draw state. Pure record/replay: guest calls
 * append ops and mutate state; `rasterize()` produces pixels via Skia when
 * CanvasKit is warm (kicked at construction so it usually is).
 */
export class Canvas2DEngine {
  /** Bitmap dimensions — the element's `width`/`height` attribute values. */
  #w: number;
  #h: number;
  #st: DrawState = defaultState();
  #stack: DrawState[] = [];
  #path: Verb[] = [];
  #ops: RasterOp[] = [];
  #raster: DecodedImage | null = null;
  #dirty = true;
  #typeface: Typeface | null | undefined;
  readonly #opaque: boolean;

  constructor(width: number, height: number, options: { opaque?: boolean } = {}) {
    this.#w = Math.max(0, Math.floor(width));
    this.#h = Math.max(0, Math.floor(height));
    this.#opaque = options.opaque === true;
    // Warm the WASM module proactively — by the time paint/getImageData
    // asks for pixels, init has usually settled.
    if (canvasKitIfReady() === undefined) void loadCanvasKit();
  }

  get bitmapWidth(): number {
    return this.#w;
  }

  get bitmapHeight(): number {
    return this.#h;
  }

  /** `canvas.width =` / `height =` reset: new dims + cleared state (spec). */
  resize(width: number, height: number): void {
    this.#w = Math.max(0, Math.floor(width));
    this.#h = Math.max(0, Math.floor(height));
    this.reset();
  }

  /** `ctx.reset()` — drop state stack, path, ops (leaves dims). */
  reset(): void {
    this.#st = defaultState();
    this.#stack = [];
    this.#path = [];
    this.#ops = [];
    this.#dirty = true;
  }

  /** Pixels — rasterizes the op log via Skia; `undefined` while ck is cold. */
  rasterize(): DecodedImage | undefined {
    if (!this.#dirty && this.#raster !== null) return this.#raster;
    const ck = canvasKitIfReady();
    if (ck === undefined) return undefined;
    this.#raster = rasterizeOps(ck, this.#ops, this.#w, this.#h, () => this.#typefaceOf(ck), this.#opaque);
    this.#dirty = false;
    return this.#raster;
  }

  /** PNG bytes via the repo encoder; `undefined` while ck is cold. */
  toPngBytes(): Uint8Array | undefined {
    const img = this.rasterize();
    if (img === undefined) return undefined;
    return encodeSurfaceToPng(
      { width: img.width, height: img.height, pixels: img.pixels },
      { level: 6 },
    );
  }

  #typefaceOf(ck: CanvasKit): Typeface | null {
    if (this.#typeface === undefined) {
      this.#typeface = ck.Typeface.MakeFreeTypeFaceFromData(
        builtinFontBytes().buffer as ArrayBuffer,
      );
    }
    return this.#typeface;
  }

  /* -------- state -------- */

  save(): void {
    this.#stack.push(copyState(this.#st));
  }

  restore(): void {
    const prev = this.#stack.pop();
    if (prev !== undefined) this.#st = prev;
  }

  get state(): DrawState {
    return this.#st;
  }

  setState(patch: Partial<DrawState>): void {
    this.#st = { ...this.#st, ...patch };
  }

  setPaint(which: "fill" | "stroke", raw: unknown): void {
    const spec = coercePaint(raw);
    if (spec === undefined) return; // unparseable style is ignored per spec
    this.#st = { ...this.#st, [which]: spec };
  }

  setFont(raw: string): void {
    const spec = parseFontSpec(raw);
    if (spec === undefined) return;
    this.#st = { ...this.#st, font: spec };
  }

  /* -------- transforms -------- */

  transformOps(m: M6): void {
    this.#st = { ...this.#st, ctm: mul(this.#st.ctm, m) };
  }

  setTransform(m: M6): void {
    this.#st = { ...this.#st, ctm: m };
  }

  get ctm(): M6 {
    return this.#st.ctm;
  }

  /* -------- path construction -------- */

  beginPath(): void {
    this.#path = [];
  }

  path(): PathRep {
    return this.#path;
  }

  pushVerb(v: Verb): void {
    this.#path.push(v);
  }

  private common(): DrawCommon {
    const s = this.#st;
    return {
      ctm: s.ctm,
      clips: s.clips,
      alpha: s.alpha,
      blend: s.blend,
      shadow: s.shadow,
      smoothing: s.smoothing,
    };
  }

  #record(op: RasterOp): void {
    this.#ops.push(op);
    this.#dirty = true;
  }

  /* -------- drawing verbs -------- */

  fillPath(path: PathRep, rule: "nonzero" | "evenodd"): void {
    if (path.length === 0) return;
    this.#record({ k: "fill", path, rule, paint: this.#st.fill, ...this.common() });
  }

  strokePath(path: PathRep): void {
    if (path.length === 0) return;
    this.#record({
      k: "stroke",
      path,
      paint: this.#st.stroke,
      stroke: { ...this.#st.line, dash: this.#st.dash },
      ...this.common(),
    });
  }

  clipPath(path: PathRep, rule: "nonzero" | "evenodd"): void {
    if (path.length === 0) return;
    this.#st.clips = [...this.#st.clips, { path, ctm: this.#st.ctm, rule }];
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    if (w <= 0 || h <= 0) return;
    this.#record({ k: "clear", x, y, w, h, ctm: this.#st.ctm, clips: this.#st.clips });
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    if (w === 0 || h === 0) return;
    this.#record({
      k: "fill",
      path: rectPath(x, y, w, h),
      rule: "nonzero",
      paint: this.#st.fill,
      ...this.common(),
    });
  }

  strokeRect(x: number, y: number, w: number, h: number): void {
    this.#record({
      k: "stroke",
      path: rectPath(x, y, w, h),
      paint: this.#st.stroke,
      stroke: { ...this.#st.line, dash: this.#st.dash },
      ...this.common(),
    });
  }

  drawImage(src: DecodedImage, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void {
    if (sw <= 0 || sh <= 0 || dw === 0 || dh === 0 || src.width <= 0 || src.height <= 0) return;
    this.#record({ k: "image", src, sx, sy, sw, sh, dx, dy, dw, dh, ...this.common() });
  }

  text(mode: "fill" | "stroke", text: string, x: number, y: number): void {
    if (text.length === 0) return;
    this.#record({
      k: "text",
      text,
      x,
      y,
      font: this.#st.font,
      mode,
      paint: mode === "fill" ? this.#st.fill : this.#st.stroke,
      stroke: { ...this.#st.line, dash: this.#st.dash },
      align: this.#st.textAlign,
      baseline: this.#st.textBaseline,
      ...this.common(),
    });
  }

  /**
   * `measureText` — real glyph metrics when CanvasKit is warm; a 0-advance
   * (but correctly-shaped) metrics object when cold.
   */
  measureText(text: string): {
    width: number;
    actualBoundingBoxLeft: number;
    actualBoundingBoxRight: number;
    actualBoundingBoxAscent: number;
    actualBoundingBoxDescent: number;
    fontBoundingBoxAscent: number;
    fontBoundingBoxDescent: number;
    emHeightAscent: number;
    emHeightDescent: number;
    hangingBaseline: number;
    alphabeticBaseline: number;
    ideographicBaseline: number;
  } {
    const s = this.#st;
    let width = 0;
    let ascent = s.font.sizePx * 0.8;
    let descent = s.font.sizePx * 0.2;
    const ck = canvasKitIfReady();
    if (ck !== undefined) {
      const face = this.#typefaceOf(ck);
      if (face !== null) {
        const font = new ck.Font(face, Math.max(0.01, s.font.sizePx));
        try {
          const ids = font.getGlyphIDs(text);
          const widths = font.getGlyphWidths(ids);
          width = widths.reduce((a, b) => a + b, 0);
          const m = font.getMetrics();
          ascent = -m.ascent;
          descent = m.descent;
        } finally {
          font.delete();
        }
      }
    }
    return {
      width,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: width,
      actualBoundingBoxAscent: ascent,
      actualBoundingBoxDescent: descent,
      fontBoundingBoxAscent: ascent,
      fontBoundingBoxDescent: descent,
      emHeightAscent: ascent,
      emHeightDescent: descent,
      hangingBaseline: ascent * 0.8,
      alphabeticBaseline: 0,
      ideographicBaseline: -descent,
    };
  }

  putImageData(
    img: { data: ArrayLike<number> & { buffer?: ArrayBufferLike }; width: number; height: number },
    dx: number,
    dy: number,
    dirty?: { x: number; y: number; w: number; h: number },
  ): void {
    // Normalize to a host Uint8ClampedArray — guest-realm views copy across.
    const src = img.data instanceof Uint8ClampedArray ? img.data : new Uint8ClampedArray(Array.from(img.data));
    if (img.width <= 0 || img.height <= 0) return;
    // dirty-rect crops the source region (spec §4.12.5.13).
    let px = src;
    let w = img.width;
    let h = img.height;
    let ox = dx;
    let oy = dy;
    if (dirty !== undefined && (dirty.w < img.width || dirty.h < img.height || dirty.x > 0 || dirty.y > 0)) {
      const cx0 = Math.max(0, Math.floor(dirty.x));
      const cy0 = Math.max(0, Math.floor(dirty.y));
      const cx1 = Math.min(img.width, cx0 + Math.max(0, Math.floor(dirty.w)));
      const cy1 = Math.min(img.height, cy0 + Math.max(0, Math.floor(dirty.h)));
      if (cx1 <= cx0 || cy1 <= cy0) return;
      const cw = cx1 - cx0;
      const ch = cy1 - cy0;
      const out = new Uint8ClampedArray(cw * ch * 4);
      for (let row = 0; row < ch; row += 1) {
        out.set(
          src.subarray(((cy0 + row) * img.width + cx0) * 4, ((cy0 + row) * img.width + cx0 + cw) * 4),
          row * cw * 4,
        );
      }
      px = out;
      w = cw;
      h = ch;
      ox = dx + cx0;
      oy = dy + cy0;
    }
    this.#record({ k: "raw", pixels: px, w, h, dx: ox, dy: oy });
  }

  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray; width: number; height: number } {
    const iw = Math.max(0, Math.floor(w));
    const ih = Math.max(0, Math.floor(h));
    const out = new Uint8ClampedArray(iw * ih * 4);
    const img = this.rasterize();
    if (img === undefined) return { data: out, width: iw, height: ih };
    const sx0 = Math.floor(x);
    const sy0 = Math.floor(y);
    for (let row = 0; row < ih; row += 1) {
      const sy = sy0 + row;
      if (sy < 0 || sy >= img.height) continue;
      const cx0 = Math.max(0, -sx0);
      const cx1 = Math.min(iw, img.width - sx0);
      if (cx1 <= cx0) continue;
      out.set(
        img.pixels.subarray((sy * img.width + sx0 + cx0) * 4, (sy * img.width + sx0 + cx1) * 4),
        (row * iw + cx0) * 4,
      );
    }
    return { data: out, width: iw, height: ih };
  }

  /* -------- hit testing -------- */

  isPointInPath(path: PathRep, x: number, y: number, rule: "nonzero" | "evenodd"): boolean {
    const ck = canvasKitIfReady();
    if (ck !== undefined) {
      // Real path containment — curves stay analytic (no flattening).
      const p = toSkiaPath(ck, path, this.#st.ctm);
      try {
        p.setFillType(rule === "evenodd" ? ck.FillType.EvenOdd : ck.FillType.Winding);
        return p.contains(x, y);
      } finally {
        p.delete();
      }
    }
    // Cold-ck fallback: flattened-polygon winding test (same semantics).
    return pointInPath(flattenPath(path, this.#st.ctm), x, y, rule === "evenodd");
  }

  isPointInStroke(path: PathRep, x: number, y: number): boolean {
    const ck = canvasKitIfReady();
    if (ck !== undefined) {
      const p = toSkiaPath(ck, path, this.#st.ctm);
      try {
        const stroked = p.makeStroked({
          width: Math.max(0, this.#st.line.width),
          cap:
            this.#st.line.cap === "round" ? ck.StrokeCap.Round
              : this.#st.line.cap === "square" ? ck.StrokeCap.Square
                : ck.StrokeCap.Butt,
          join:
            this.#st.line.join === "round" ? ck.StrokeJoin.Round
              : this.#st.line.join === "bevel" ? ck.StrokeJoin.Bevel
                : ck.StrokeJoin.Miter,
          miter_limit: this.#st.line.miter,
        });
        if (stroked === null) return false;
        try {
          return stroked.contains(x, y);
        } finally {
          stroked.delete();
        }
      } finally {
        p.delete();
      }
    }
    const polys = flattenPath(path, this.#st.ctm);
    const half = this.#st.line.width / 2;
    for (const poly of polys) {
      for (let i = 1; i < poly.length; i += 1) {
        if (segDist(x, y, poly[i - 1]!.x, poly[i - 1]!.y, poly[i]!.x, poly[i]!.y) <= half) {
          return true;
        }
      }
    }
    return false;
  }
}

function rectPath(x: number, y: number, w: number, h: number): PathRep {
  return [
    { v: "M", x, y },
    { v: "L", x: x + w, y },
    { v: "L", x: x + w, y: y + h },
    { v: "L", x, y: y + h },
    { v: "Z" },
  ];
}

/** Guest style coercion: string → parsed color; CanvasStyleHandle passes. */
function coercePaint(raw: unknown): PaintSpec | undefined {
  if (typeof raw === "object" && raw !== null && "spec" in (raw as Record<string, unknown>)) {
    return (raw as CanvasStyleHandle).spec;
  }
  const c = parseCanvasColor(String(raw));
  return c === undefined ? undefined : { k: "color", c };
}

/* ------------------------------------------------------------------ */
/* Rasterization                                                       */
/* ------------------------------------------------------------------ */

function toSkiaPaint(
  ck: CanvasKit,
  spec: PaintSpec,
  alpha: number,
  blend: string,
): { paint: Paint; disposables: { delete(): void }[] } {
  const paint = new ck.Paint();
  const disposables: { delete(): void }[] = [paint];
  paint.setAntiAlias(true);
  const modeName = BLEND_MODES[blend];
  const mode =
    modeName === undefined
      ? ck.BlendMode.SrcOver
      : ((ck.BlendMode as unknown as Record<string, typeof ck.BlendMode.SrcOver>)[modeName] ?? ck.BlendMode.SrcOver);
  paint.setBlendMode(mode);
  const applyAlpha = (c: Color): Float32Array =>
    ck.Color4f(c.r / 255, c.g / 255, c.b / 255, Math.max(0, Math.min(1, c.a * alpha)));
  switch (spec.k) {
    case "color":
      paint.setColor(applyAlpha(spec.c));
      break;
    case "linear": {
      const stops = normalizeStops(spec.stops);
      const shader = ck.Shader.MakeLinearGradient(
        [spec.x0, spec.y0],
        [spec.x1, spec.y1],
        stops.map((s) => applyAlpha(s.c)),
        stops.map((s) => s.o),
        ck.TileMode.Clamp,
      );
      if (shader !== null) {
        paint.setShader(shader);
        disposables.push(shader);
        if (alpha < 1) paint.setAlphaf(alpha);
      }
      break;
    }
    case "radial": {
      const stops = normalizeStops(spec.stops);
      const shader = ck.Shader.MakeTwoPointConicalGradient(
        [spec.x0, spec.y0],
        Math.max(0, spec.r0),
        [spec.x1, spec.y1],
        Math.max(0, spec.r1),
        stops.map((s) => applyAlpha(s.c)),
        stops.map((s) => s.o),
        ck.TileMode.Clamp,
      );
      if (shader !== null) {
        paint.setShader(shader);
        disposables.push(shader);
        if (alpha < 1) paint.setAlphaf(alpha);
      }
      break;
    }
    case "conic": {
      const stops = normalizeStops(spec.stops);
      const shader = ck.Shader.MakeSweepGradient(
        spec.x,
        spec.y,
        stops.map((s) => applyAlpha(s.c)),
        stops.map((s) => s.o),
        ck.TileMode.Clamp,
        null,
        0,
        spec.startAngle * DEG,
        spec.startAngle * DEG + 360,
      );
      if (shader !== null) {
        paint.setShader(shader);
        disposables.push(shader);
        if (alpha < 1) paint.setAlphaf(alpha);
      }
      break;
    }
    case "pattern": {
      const img = ck.MakeImage(
        {
          width: spec.img.width,
          height: spec.img.height,
          colorType: ck.ColorType.RGBA_8888,
          alphaType: ck.AlphaType.Unpremul,
          colorSpace: ck.ColorSpace.SRGB,
        },
        new Uint8Array(spec.img.pixels.buffer, spec.img.pixels.byteOffset, spec.img.pixels.byteLength),
        spec.img.width * 4,
      );
      if (img !== null) {
        disposables.push(img);
        const tx = spec.rep === "repeat" || spec.rep === "repeat-x" ? ck.TileMode.Repeat : ck.TileMode.Decal;
        const ty = spec.rep === "repeat" || spec.rep === "repeat-y" ? ck.TileMode.Repeat : ck.TileMode.Decal;
        const shader = img.makeShaderOptions(
          tx,
          ty,
          ck.FilterMode.Nearest,
          ck.MipmapMode.None,
          spec.matrix !== undefined ? toSkiaMatrix(spec.matrix) : undefined,
        );
        if (shader !== null) {
          paint.setShader(shader);
          disposables.push(shader);
        }
        if (alpha < 1) paint.setAlphaf(alpha);
      }
      break;
    }
  }
  return { paint, disposables };
}

function normalizeStops(stops: readonly { o: number; c: Color }[]): { o: number; c: Color }[] {
  if (stops.length === 0) return [{ o: 0, c: { r: 0, g: 0, b: 0, a: 0 } }];
  const sorted = [...stops].sort((a, b) => a.o - b.o);
  // Clamp offsets into [0,1] monotonically (spec: earlier stops clamp later).
  let max = 0;
  return sorted.map((s) => {
    const o = Math.max(max, Math.min(1, s.o));
    max = o;
    return { o, c: s.c };
  });
}

function applyClips(ck: CanvasKit, cv: Canvas, clips: readonly ClipEntry[]): Path[] {
  const made: Path[] = [];
  for (const clip of clips) {
    // Clip lands in device space at clip() time — transform at build.
    const p = toSkiaPath(ck, clip.path, clip.ctm);
    p.setFillType(clip.rule === "evenodd" ? ck.FillType.EvenOdd : ck.FillType.Winding);
    cv.clipPath(p, ck.ClipOp.Intersect, true);
    made.push(p);
  }
  return made;
}

function buildStrokePaint(
  ck: CanvasKit,
  common: DrawCommon,
  spec: PaintSpec,
  stroke: StrokeSpec,
): { paint: Paint; disposables: { delete(): void }[] } {
  const { paint, disposables } = toSkiaPaint(ck, spec, common.alpha, common.blend);
  paint.setStyle(ck.PaintStyle.Stroke);
  paint.setStrokeWidth(Math.max(0, stroke.width));
  paint.setStrokeCap(
    stroke.cap === "round" ? ck.StrokeCap.Round
      : stroke.cap === "square" ? ck.StrokeCap.Square
        : ck.StrokeCap.Butt,
  );
  paint.setStrokeJoin(
    stroke.join === "round" ? ck.StrokeJoin.Round
      : stroke.join === "bevel" ? ck.StrokeJoin.Bevel
        : ck.StrokeJoin.Miter,
  );
  paint.setStrokeMiter(stroke.miter);
  if (stroke.dash.length > 0) {
    // Odd-length dash lists double per spec (on,off,on,off,on,off).
    const iv = stroke.dash.length % 2 === 0 ? [...stroke.dash] : [...stroke.dash, ...stroke.dash];
    const fx = ck.PathEffect.MakeDash(iv, stroke.dashOff);
    if (fx !== null) {
      paint.setPathEffect(fx);
      disposables.push(fx);
    }
  }
  return { paint, disposables };
}

function applyShadow(ck: CanvasKit, paint: Paint, disposables: { delete(): void }[], shadow: ShadowSpec): void {
  if (shadow.color.a <= 0 || (shadow.blur === 0 && shadow.dx === 0 && shadow.dy === 0)) return;
  const sigma = Math.max(0, shadow.blur) / 2; // CSS blur-radius → sigma ≈ /2
  const filter = ck.ImageFilter.MakeDropShadowOnly(
    shadow.dx,
    shadow.dy,
    sigma,
    sigma,
    ck.Color4f(shadow.color.r / 255, shadow.color.g / 255, shadow.color.b / 255, Math.max(0, Math.min(1, shadow.color.a))),
    null,
  );
  if (filter !== null) {
    paint.setImageFilter(filter);
    disposables.push(filter);
  }
}

/**
 * Replay the op log onto a fresh transparent Skia raster surface and return
 * premultiplied-safe RGBA pixels (Unpremul readback — the DecodedImage
 * convention the rest of the pipeline uses).
 */
function rasterizeOps(
  ck: CanvasKit,
  ops: readonly RasterOp[],
  w: number,
  h: number,
  typeface: () => Typeface | null,
  opaque: boolean,
): DecodedImage {
  const surface = ck.MakeSurface(Math.max(1, w), Math.max(1, h));
  if (surface === null) {
    return { width: w, height: h, pixels: new Uint8ClampedArray(Math.max(0, w * h * 4)), format: "png" };
  }
  try {
    const cv = surface.getCanvas();
    // alpha:false canvases start opaque black and never gain alpha.
    cv.clear(opaque ? ck.Color4f(0, 0, 0, 1) : ck.Color4f(0, 0, 0, 0));
    for (const op of ops) {
      if (op.k === "raw") {
        // putImageData: untransformed, unclipped, unblended pixel splat.
        cv.writePixels(
          new Uint8Array(op.pixels.buffer, op.pixels.byteOffset, op.pixels.byteLength),
          op.w,
          op.h,
          Math.round(op.dx),
          Math.round(op.dy),
          ck.AlphaType.Unpremul,
          ck.ColorType.RGBA_8888,
          ck.ColorSpace.SRGB,
        );
        continue;
      }
      cv.save();
      const clipPaths = applyClips(ck, cv, op.clips);
      try {
        cv.concat(toSkiaMatrix(op.ctm));
        switch (op.k) {
          case "clear": {
            const p = new ck.Paint();
            try {
              p.setBlendMode(ck.BlendMode.Clear);
              cv.drawRect([op.x, op.y, op.x + op.w, op.y + op.h], p);
            } finally {
              p.delete();
            }
            break;
          }
          case "fill": {
            const { paint, disposables } = toSkiaPaint(ck, op.paint, op.alpha, op.blend);
            try {
              applyShadow(ck, paint, disposables, op.shadow);
              const p = toSkiaPath(ck, op.path);
              try {
                p.setFillType(op.rule === "evenodd" ? ck.FillType.EvenOdd : ck.FillType.Winding);
                cv.drawPath(p, paint);
              } finally {
                p.delete();
              }
            } finally {
              for (const d of disposables) d.delete();
            }
            break;
          }
          case "stroke": {
            const { paint, disposables } = buildStrokePaint(ck, op, op.paint, op.stroke);
            try {
              applyShadow(ck, paint, disposables, op.shadow);
              const p = toSkiaPath(ck, op.path);
              try {
                cv.drawPath(p, paint);
              } finally {
                p.delete();
              }
            } finally {
              for (const d of disposables) d.delete();
            }
            break;
          }
          case "image": {
            const { paint, disposables } = toSkiaPaint(
              ck,
              { k: "color", c: { r: 255, g: 255, b: 255, a: 1 } },
              op.alpha,
              op.blend,
            );
            try {
              applyShadow(ck, paint, disposables, op.shadow);
              const img = ck.MakeImage(
                {
                  width: op.src.width,
                  height: op.src.height,
                  colorType: ck.ColorType.RGBA_8888,
                  alphaType: ck.AlphaType.Unpremul,
                  colorSpace: ck.ColorSpace.SRGB,
                },
                new Uint8Array(op.src.pixels.buffer, op.src.pixels.byteOffset, op.src.pixels.byteLength),
                op.src.width * 4,
              );
              if (img !== null) {
                try {
                  const fm = op.smoothing ? ck.FilterMode.Linear : ck.FilterMode.Nearest;
                  cv.drawImageRectOptions(
                    img,
                    [op.sx, op.sy, op.sx + op.sw, op.sy + op.sh],
                    [op.dx, op.dy, op.dx + op.dw, op.dy + op.dh],
                    fm,
                    ck.MipmapMode.None,
                    paint,
                  );
                } finally {
                  img.delete();
                }
              }
            } finally {
              for (const d of disposables) d.delete();
            }
            break;
          }
          case "text": {
            const face = typeface();
            if (face === null) break;
            const font = new ck.Font(face, Math.max(0.01, op.font.sizePx));
            const { paint, disposables } =
              op.mode === "fill"
                ? toSkiaPaint(ck, op.paint, op.alpha, op.blend)
                : buildStrokePaint(ck, op, op.paint, op.stroke);
            try {
              applyShadow(ck, paint, disposables, op.shadow);
              if (op.font.style !== "normal") font.setSkewX(-0.2);
              if (op.font.weight >= 600) font.setEmbolden(true);
              // textAlign shifts x by the measured advance; textBaseline
              // shifts the baseline origin by the font's real metrics.
              const ids = font.getGlyphIDs(op.text);
              const widths = font.getGlyphWidths(ids);
              const advance = widths.reduce((a, b) => a + b, 0);
              const metrics = font.getMetrics();
              const asc = -metrics.ascent;
              const desc = metrics.descent;
              const align = op.align === "end" || op.align === "right" ? "right"
                : op.align === "center" ? "center" : "left";
              const x = align === "right" ? op.x - advance
                : align === "center" ? op.x - advance / 2 : op.x;
              const dy =
                op.baseline === "top" ? asc
                  : op.baseline === "hanging" ? asc * 0.8
                    : op.baseline === "middle" ? asc / 2
                      : op.baseline === "ideographic" || op.baseline === "bottom" ? -desc
                        : 0;
              cv.drawText(op.text, x, op.y + dy, paint, font);
            } finally {
              font.delete();
              for (const d of disposables) d.delete();
            }
            break;
          }
        }
      } finally {
        for (const p of clipPaths) p.delete();
        cv.restore();
      }
    }
    const out = cv.readPixels(0, 0, {
      width: Math.max(1, w),
      height: Math.max(1, h),
      colorType: ck.ColorType.RGBA_8888,
      alphaType: ck.AlphaType.Unpremul,
      colorSpace: ck.ColorSpace.SRGB,
    });
    if (out === null) {
      return { width: w, height: h, pixels: new Uint8ClampedArray(Math.max(0, w * h * 4)), format: "png" };
    }
    const pixels = new Uint8ClampedArray(Math.max(0, w * h * 4));
    pixels.set(new Uint8ClampedArray(out.buffer as ArrayBuffer, 0, Math.min(out.length, pixels.length)));
    if (opaque) {
      for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
    }
    return { width: w, height: h, pixels, format: "png" };
  } finally {
    surface.delete();
  }
}

/* ------------------------------------------------------------------ */
/* Guest-facing surface — CanvasRenderingContext2D + Path2D             */
/* ------------------------------------------------------------------ */

const str = (v: unknown): string => String(v);

/** A guest-side `Path2D`: an owned, mutable verb list. */
export class Path2DImpl {
  #verbs: Verb[] = [];

  constructor(source?: PathRep | Path2DImpl | string) {
    if (source instanceof Path2DImpl) this.#verbs = [...source.rep];
    else if (Array.isArray(source)) this.#verbs = [...(source as Verb[])];
    // `new Path2D("M10 10 ...")` SVG path data is an honest boundary —
    // the parser is a follow-up; an empty path results.
  }

  get rep(): PathRep {
    return this.#verbs;
  }

  moveTo(x: unknown, y: unknown): void {
    this.#verbs.push({ v: "M", x: num(x), y: num(y) });
  }

  lineTo(x: unknown, y: unknown): void {
    this.#verbs.push({ v: "L", x: num(x), y: num(y) });
  }

  quadraticCurveTo(cx: unknown, cy: unknown, x: unknown, y: unknown): void {
    this.#verbs.push({ v: "Q", cx: num(cx), cy: num(cy), x: num(x), y: num(y) });
  }

  bezierCurveTo(x1: unknown, y1: unknown, x2: unknown, y2: unknown, x: unknown, y: unknown): void {
    this.#verbs.push({ v: "C", x1: num(x1), y1: num(y1), x2: num(x2), y2: num(y2), x: num(x), y: num(y) });
  }

  arc(x: unknown, y: unknown, r: unknown, a0: unknown, a1: unknown, ccw?: unknown): void {
    const radius = num(r);
    if (radius < 0) throw new RangeError("Path2D.arc: negative radius");
    this.#verbs.push({ v: "A", cx: num(x), cy: num(y), r: radius, a0: num(a0), a1: num(a1), ccw: ccw === true });
  }

  ellipse(x: unknown, y: unknown, rx: unknown, ry: unknown, rot: unknown, a0: unknown, a1: unknown, ccw?: unknown): void {
    const rxn = num(rx);
    const ryn = num(ry);
    if (rxn < 0 || ryn < 0) throw new RangeError("Path2D.ellipse: negative radius");
    this.#verbs.push({ v: "E", cx: num(x), cy: num(y), rx: rxn, ry: ryn, rot: num(rot), a0: num(a0), a1: num(a1), ccw: ccw === true });
  }

  arcTo(x1: unknown, y1: unknown, x2: unknown, y2: unknown, r: unknown): void {
    // arcTo = tangent arc between the line to (x1,y1) and (x1,y1)-(x2,y2).
    // Compute the tangent-circle center geometrically (spec algorithm).
    const x1n = num(x1);
    const y1n = num(y1);
    const x2n = num(x2);
    const y2n = num(y2);
    const radius = num(r);
    if (radius < 0) throw new RangeError("Path2D.arcTo: negative radius");
    const verbs = this.#verbs;
    const last = verbs[verbs.length - 1];
    if (last === undefined || !("x" in last)) {
      verbs.push({ v: "L", x: x1n, y: y1n });
      return;
    }
    const x0 = (last as { x: number }).x;
    const y0 = (last as { y: number }).y;
    // Tangent geometry: unit vectors from (x1,y1) towards (x0,y0) and (x2,y2).
    const dx1 = x0 - x1n;
    const dy1 = y0 - y1n;
    const dx2 = x2n - x1n;
    const dy2 = y2n - y1n;
    const l1 = Math.hypot(dx1, dy1);
    const l2 = Math.hypot(dx2, dy2);
    if (l1 === 0 || l2 === 0 || radius === 0) {
      verbs.push({ v: "L", x: x1n, y: y1n });
      return;
    }
    const u1x = dx1 / l1;
    const u1y = dy1 / l1;
    const u2x = dx2 / l2;
    const u2y = dy2 / l2;
    const cosHalf = (u1x * u2x + u1y * u2y + 1) / 2;
    if (cosHalf <= 1e-9) {
      // Parallel lines — no arc.
      verbs.push({ v: "L", x: x1n, y: y1n });
      return;
    }
    const halfAng = Math.acos(Math.min(1, Math.sqrt(cosHalf)));
    const tanDist = radius / Math.tan(halfAng);
    // Tangent points along each line from the vertex.
    const t1x = x1n + u1x * tanDist;
    const t1y = y1n + u1y * tanDist;
    const t2x = x1n + u2x * tanDist;
    const t2y = y1n + u2y * tanDist;
    // Bisector direction → circle center at distance r/sin(halfAng).
    let bx = u1x + u2x;
    let by = u1y + u2y;
    const bl = Math.hypot(bx, by);
    if (bl === 0) {
      verbs.push({ v: "L", x: x1n, y: y1n });
      return;
    }
    bx /= bl;
    by /= bl;
    const cdist = radius / Math.sin(halfAng);
    const cx = x1n + bx * cdist;
    const cy = y1n + by * cdist;
    const a0 = Math.atan2(t1y - cy, t1x - cx);
    const a1 = Math.atan2(t2y - cy, t2x - cx);
    // Line to the first tangent point, then the arc sweep.
    verbs.push({ v: "L", x: t1x, y: t1y });
    // Choose the sweep direction matching the turn (cross product sign).
    const cross = dx1 * dy2 - dy1 * dx2;
    verbs.push({ v: "A", cx, cy, r: radius, a0, a1, ccw: cross < 0 });
  }

  rect(x: unknown, y: unknown, w: unknown, h: unknown): void {
    this.#verbs.push(...(rectPath(num(x), num(y), num(w), num(h)) as Verb[]));
  }

  roundRect(x: unknown, y: unknown, w: unknown, h: unknown, radii?: unknown): void {
    const rs = Array.isArray(radii) ? radii.map(num) : [num(radii)];
    this.#verbs.push({ v: "RR", x: num(x), y: num(y), w: num(w), h: num(h), radii: rs });
  }

  closePath(): void {
    this.#verbs.push({ v: "Z" });
  }

  addPath(other: Path2DImpl, matrix?: { a?: number; b?: number; c?: number; d?: number; e?: number; f?: number }): void {
    const m: M6 = [
      matrix?.a ?? 1, matrix?.b ?? 0, matrix?.c ?? 0,
      matrix?.d ?? 1, matrix?.e ?? 0, matrix?.f ?? 0,
    ];
    for (const v of other.rep) {
      this.#verbs.push(...transformVerb(v, m));
    }
  }
}

/** Transform one verb by `m` — arcs flatten to line segments under affine. */
function transformVerb(v: Verb, m: M6): Verb[] {
  switch (v.v) {
    case "M":
    case "L": {
      const p = applyM(m, v.x, v.y);
      return [{ v: v.v, x: p.x, y: p.y }];
    }
    case "Q": {
      const c = applyM(m, v.cx, v.cy);
      const p = applyM(m, v.x, v.y);
      return [{ v: "Q", cx: c.x, cy: c.y, x: p.x, y: p.y }];
    }
    case "C": {
      const p1 = applyM(m, v.x1, v.y1);
      const p2 = applyM(m, v.x2, v.y2);
      const p = applyM(m, v.x, v.y);
      return [{ v: "C", x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, x: p.x, y: p.y }];
    }
    case "Z":
      return [v];
    case "RR": {
      const p = applyM(m, v.x, v.y);
      const p2 = applyM(m, v.x + v.w, v.y + v.h);
      const x = Math.min(p.x, p2.x);
      const y = Math.min(p.y, p2.y);
      return [{
        v: "RR",
        x,
        y,
        w: Math.abs(p2.x - p.x),
        h: Math.abs(p2.y - p.y),
        radii: v.radii,
      }];
    }
    case "A":
    case "E": {
      // Non-uniform affine turns arcs into non-ellipses — degrade to a
      // flattened polyline (documented approximation for addPath(matrix)).
      const flat = flattenPath([v], m);
      const out: Verb[] = [];
      for (const poly of flat) {
        for (const pt of poly) out.push({ v: "L", x: pt.x, y: pt.y });
      }
      return out;
    }
  }
}

export interface Canvas2DApiDeps {
  /** Resolve a drawImage source: HTMLImageElement node → decoded pixels. */
  readonly resolveImage?: (source: unknown) => DecodedImage | undefined;
  /** Resolve a canvas element/offscreen → its peer engine's bitmap. */
  readonly resolveCanvas?: (source: unknown) => Canvas2DEngine | undefined;
  /** The element wrapper for `ctx.canvas`. */
  readonly canvasRef: () => unknown;
}

/** A guest-side gradient/pattern factory result (opaque handle). */
function styleHandle(spec: PaintSpec): CanvasStyleHandle & Record<string, unknown> {
  const h: CanvasStyleHandle & Record<string, unknown> = { spec };
  if (spec.k === "linear" || spec.k === "radial" || spec.k === "conic") {
    const stops: { o: number; c: Color }[] = [];
    h["addColorStop"] = (offset: unknown, color: unknown): void => {
      const o = num(offset);
      if (o < 0 || o > 1) throw new RangeError("CanvasGradient.addColorStop: offset out of range");
      const c = parseCanvasColor(str(color));
      if (c === undefined) throw new SyntaxError(`addColorStop: unparseable color "${str(color)}"`);
      stops.push({ o, c });
      // Re-spec: keep the live stops list.
      (h as { spec: PaintSpec }).spec = { ...spec, stops };
    };
  } else if (spec.k === "pattern") {
    h["setTransform"] = (m?: { a?: number; b?: number; c?: number; d?: number; e?: number; f?: number }): void => {
      const mm: M6 = [m?.a ?? 1, m?.b ?? 0, m?.c ?? 0, m?.d ?? 1, m?.e ?? 0, m?.f ?? 0];
      (h as { spec: PaintSpec }).spec = { ...spec, matrix: mm };
    };
  }
  return h;
}

/**
 * Build the guest-facing `CanvasRenderingContext2D` object for `engine`.
 * All state accessors read/write the engine's DrawState live; drawing verbs
 * record ops; `getImageData`/`toDataURL` rasterize on demand.
 */
export function canvas2dApi(engine: Canvas2DEngine, deps: Canvas2DApiDeps): Record<string, unknown> {
  const st = (): DrawState => engine.state;

  const parseFillArgs = (args: unknown[]): { path: PathRep; rule: "nonzero" | "evenodd" } => {
    let path = engine.path();
    let rule: "nonzero" | "evenodd" = "nonzero";
    for (const a of args) {
      if (a instanceof Path2DImpl) path = a.rep;
      else if (typeof a === "string" && (a === "evenodd" || a === "nonzero")) rule = a;
      else if (a !== null && typeof a === "object" && "rep" in (a as Record<string, unknown>)) {
        path = (a as Path2DImpl).rep;
      }
    }
    return { path, rule };
  };

  const ctx: Record<string, unknown> = {
    canvas: undefined,

    /* -------- state -------- */
    save: () => engine.save(),
    restore: () => engine.restore(),
    reset: () => engine.reset(),
    getContextAttributes: () => ({ alpha: true, colorSpace: "srgb", desynchronized: false, willReadFrequently: false }),

    get fillStyle() { return st().fill.k === "color" ? colorToCss((st().fill as { c: Color }).c) : st().fill; },
    set fillStyle(v: unknown) { engine.setPaint("fill", v); },
    get strokeStyle() { return st().stroke.k === "color" ? colorToCss((st().stroke as { c: Color }).c) : st().stroke; },
    set strokeStyle(v: unknown) { engine.setPaint("stroke", v); },
    get lineWidth() { return st().line.width; },
    set lineWidth(v: unknown) {
      const n = num(v);
      if (n > 0) engine.setState({ line: { ...st().line, width: n } });
    },
    get lineCap() { return st().line.cap; },
    set lineCap(v: unknown) {
      const s = str(v);
      if (s === "butt" || s === "round" || s === "square") engine.setState({ line: { ...st().line, cap: s } });
    },
    get lineJoin() { return st().line.join; },
    set lineJoin(v: unknown) {
      const s = str(v);
      if (s === "miter" || s === "round" || s === "bevel") engine.setState({ line: { ...st().line, join: s } });
    },
    get miterLimit() { return st().line.miter; },
    set miterLimit(v: unknown) {
      const n = num(v);
      if (n > 0) engine.setState({ line: { ...st().line, miter: n } });
    },
    get lineDashOffset() { return st().line.dashOff; },
    set lineDashOffset(v: unknown) {
      engine.setState({ line: { ...st().line, dashOff: num(v) } });
    },
    get globalAlpha() { return st().alpha; },
    set globalAlpha(v: unknown) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0 && n <= 1) engine.setState({ alpha: n });
    },
    get globalCompositeOperation() { return st().blend; },
    set globalCompositeOperation(v: unknown) {
      const s = str(v);
      if (s in BLEND_MODES) engine.setState({ blend: s });
    },
    get font() { return fontToCss(st().font); },
    set font(v: unknown) { engine.setFont(str(v)); },
    get textAlign() { return st().textAlign; },
    set textAlign(v: unknown) {
      const s = str(v);
      if (s === "start" || s === "end" || s === "left" || s === "right" || s === "center") {
        engine.setState({ textAlign: s });
      }
    },
    get textBaseline() { return st().textBaseline; },
    set textBaseline(v: unknown) {
      const s = str(v);
      if (s === "alphabetic" || s === "top" || s === "hanging" || s === "middle" || s === "ideographic" || s === "bottom") {
        engine.setState({ textBaseline: s });
      }
    },
    get direction() { return st().direction; },
    set direction(v: unknown) {
      const s = str(v);
      if (s === "ltr" || s === "rtl" || s === "inherit") engine.setState({ direction: s });
    },
    get shadowBlur() { return st().shadow.blur; },
    set shadowBlur(v: unknown) {
      const n = num(v);
      if (n >= 0) engine.setState({ shadow: { ...st().shadow, blur: n } });
    },
    get shadowColor() { return colorToCss(st().shadow.color); },
    set shadowColor(v: unknown) {
      const c = parseCanvasColor(str(v));
      if (c !== undefined) engine.setState({ shadow: { ...st().shadow, color: c } });
    },
    get shadowOffsetX() { return st().shadow.dx; },
    set shadowOffsetX(v: unknown) { engine.setState({ shadow: { ...st().shadow, dx: num(v) } }); },
    get shadowOffsetY() { return st().shadow.dy; },
    set shadowOffsetY(v: unknown) { engine.setState({ shadow: { ...st().shadow, dy: num(v) } }); },
    get imageSmoothingEnabled() { return st().smoothing; },
    set imageSmoothingEnabled(v: unknown) { engine.setState({ smoothing: Boolean(v) }); },
    get imageSmoothingQuality() { return st().smoothingQuality; },
    set imageSmoothingQuality(v: unknown) {
      const s = str(v);
      if (s === "low" || s === "medium" || s === "high") engine.setState({ smoothingQuality: s });
    },

    /* -------- transforms -------- */
    scale: (x: unknown, y: unknown) => engine.transformOps([num(x), 0, 0, num(y), 0, 0]),
    rotate: (a: unknown) => {
      const r = num(a);
      engine.transformOps([Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]);
    },
    translate: (x: unknown, y: unknown) => engine.transformOps([1, 0, 0, 1, num(x), num(y)]),
    transform: (a: unknown, b: unknown, c: unknown, d: unknown, e: unknown, f: unknown) =>
      engine.transformOps([num(a), num(b), num(c), num(d), num(e), num(f)]),
    setTransform: (a?: unknown, b?: unknown, c?: unknown, d?: unknown, e?: unknown, f?: unknown) => {
      if (typeof a === "object" && a !== null) {
        const m = a as { a?: number; b?: number; c?: number; d?: number; e?: number; f?: number };
        engine.setTransform([m.a ?? 1, m.b ?? 0, m.c ?? 0, m.d ?? 1, m.e ?? 0, m.f ?? 0]);
      } else {
        engine.setTransform([num(a ?? 1), num(b ?? 0), num(c ?? 0), num(d ?? 1), num(e ?? 0), num(f ?? 0)]);
      }
    },
    resetTransform: () => engine.setTransform([1, 0, 0, 1, 0, 0]),
    getTransform: () => {
      const m = engine.ctm;
      return { a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] };
    },

    /* -------- path construction -------- */
    beginPath: () => engine.beginPath(),
    closePath: () => engine.pushVerb({ v: "Z" }),
    moveTo: (x: unknown, y: unknown) => engine.pushVerb({ v: "M", x: num(x), y: num(y) }),
    lineTo: (x: unknown, y: unknown) => engine.pushVerb({ v: "L", x: num(x), y: num(y) }),
    quadraticCurveTo: (cx: unknown, cy: unknown, x: unknown, y: unknown) =>
      engine.pushVerb({ v: "Q", cx: num(cx), cy: num(cy), x: num(x), y: num(y) }),
    bezierCurveTo: (x1: unknown, y1: unknown, x2: unknown, y2: unknown, x: unknown, y: unknown) =>
      engine.pushVerb({ v: "C", x1: num(x1), y1: num(y1), x2: num(x2), y2: num(y2), x: num(x), y: num(y) }),
    arc: (x: unknown, y: unknown, r: unknown, a0: unknown, a1: unknown, ccw?: unknown) => {
      const radius = num(r);
      if (radius < 0 || !Number.isFinite(radius)) throw new RangeError("arc: negative radius");
      engine.pushVerb({ v: "A", cx: num(x), cy: num(y), r: radius, a0: num(a0), a1: num(a1), ccw: ccw === true });
    },
    ellipse: (x: unknown, y: unknown, rx: unknown, ry: unknown, rot: unknown, a0: unknown, a1: unknown, ccw?: unknown) => {
      const rxn = num(rx);
      const ryn = num(ry);
      if (rxn < 0 || ryn < 0) throw new RangeError("ellipse: negative radius");
      engine.pushVerb({ v: "E", cx: num(x), cy: num(y), rx: rxn, ry: ryn, rot: num(rot), a0: num(a0), a1: num(a1), ccw: ccw === true });
    },
    arcTo: (x1: unknown, y1: unknown, x2: unknown, y2: unknown, r: unknown) => {
      const p = new Path2DImpl(engine.path());
      p.arcTo(x1, y1, x2, y2, r);
      engine.beginPath();
      for (const v of p.rep) engine.pushVerb(v);
    },
    rect: (x: unknown, y: unknown, w: unknown, h: unknown) => {
      for (const v of rectPath(num(x), num(y), num(w), num(h))) engine.pushVerb(v);
    },
    roundRect: (x: unknown, y: unknown, w: unknown, h: unknown, radii?: unknown) => {
      const rs = Array.isArray(radii) ? radii.map(num) : [num(radii)];
      engine.pushVerb({ v: "RR", x: num(x), y: num(y), w: num(w), h: num(h), radii: rs });
    },

    /* -------- drawing -------- */
    fill: (...args: unknown[]) => {
      const { path, rule } = parseFillArgs(args);
      engine.fillPath(path, rule);
    },
    stroke: (path?: unknown) => {
      engine.strokePath(path instanceof Path2DImpl ? path.rep : engine.path());
    },
    clip: (...args: unknown[]) => {
      const { path, rule } = parseFillArgs(args);
      engine.clipPath(path, rule);
    },
    clearRect: (x: unknown, y: unknown, w: unknown, h: unknown) =>
      engine.clearRect(num(x), num(y), num(w), num(h)),
    fillRect: (x: unknown, y: unknown, w: unknown, h: unknown) =>
      engine.fillRect(num(x), num(y), num(w), num(h)),
    strokeRect: (x: unknown, y: unknown, w: unknown, h: unknown) =>
      engine.strokeRect(num(x), num(y), num(w), num(h)),

    /* -------- text -------- */
    fillText: (t: unknown, x: unknown, y: unknown, _maxW?: unknown) =>
      engine.text("fill", str(t), num(x), num(y)),
    strokeText: (t: unknown, x: unknown, y: unknown, _maxW?: unknown) =>
      engine.text("stroke", str(t), num(x), num(y)),
    measureText: (t: unknown): object => engine.measureText(str(t)),

    /* -------- images -------- */
    drawImage: (...args: unknown[]): void => {
      const src = resolveDrawSource(args[0], deps);
      if (src === undefined) {
        // Spec: an image that isn't fully decodable draws nothing (no throw).
        return;
      }
      const rest = args.slice(1).map(num);
      if (rest.length === 2) {
        engine.drawImage(src, 0, 0, src.width, src.height, rest[0]!, rest[1]!, src.width, src.height);
      } else if (rest.length === 4) {
        engine.drawImage(src, 0, 0, src.width, src.height, rest[0]!, rest[1]!, rest[2]!, rest[3]!);
      } else if (rest.length === 8) {
        engine.drawImage(src, rest[0]!, rest[1]!, rest[2]!, rest[3]!, rest[4]!, rest[5]!, rest[6]!, rest[7]!);
      } else {
        throw new TypeError("drawImage: expected 3, 5, or 9 arguments");
      }
    },
    createImageData: (w: unknown, h?: unknown): object => {
      const iw = typeof w === "object" && w !== null && "width" in (w)
        ? num((w).width)
        : num(w);
      const ih = typeof w === "object" && w !== null && "height" in (w)
        ? num((w).height)
        : num(h);
      const width = Math.max(0, Math.floor(Math.abs(iw)));
      const height = Math.max(0, Math.floor(Math.abs(ih)));
      return { width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: "srgb" };
    },
    getImageData: (x: unknown, y: unknown, w: unknown, h: unknown): object => {
      const r = engine.getImageData(num(x), num(y), num(w), num(h));
      return { data: r.data, width: r.width, height: r.height, colorSpace: "srgb" };
    },
    putImageData: (data: unknown, x: unknown, y: unknown, ...rest: unknown[]): void => {
      if (typeof data !== "object" || data === null) throw new TypeError("putImageData: not an ImageData");
      const img = data as { data?: ArrayLike<number> & { buffer?: ArrayBufferLike }; width?: number; height?: number };
      // Structural check (realm-agnostic): a byte-ish view + numeric dims.
      if (
        img.data === undefined ||
        typeof img.data.length !== "number" ||
        typeof img.width !== "number" ||
        typeof img.height !== "number" ||
        img.width * img.height * 4 > img.data.length
      ) {
        throw new TypeError("putImageData: not an ImageData");
      }
      const dirty =
        rest.length >= 4
          ? { x: num(rest[0]), y: num(rest[1]), w: num(rest[2]), h: num(rest[3]) }
          : undefined;
      engine.putImageData(
        { data: img.data, width: img.width, height: img.height },
        num(x),
        num(y),
        dirty,
      );
    },

    /* -------- gradients / patterns -------- */
    createLinearGradient: (x0: unknown, y0: unknown, x1: unknown, y1: unknown): object =>
      styleHandle({ k: "linear", x0: num(x0), y0: num(y0), x1: num(x1), y1: num(y1), stops: [] }),
    createRadialGradient: (x0: unknown, y0: unknown, r0: unknown, x1: unknown, y1: unknown, r1: unknown): object =>
      styleHandle({ k: "radial", x0: num(x0), y0: num(y0), r0: num(r0), x1: num(x1), y1: num(y1), r1: num(r1), stops: [] }),
    createConicGradient: (start: unknown, x: unknown, y: unknown): object =>
      styleHandle({ k: "conic", startAngle: num(start), x: num(x), y: num(y), stops: [] }),
    createPattern: (img: unknown, rep: unknown): object | null => {
      const src = resolveDrawSource(img, deps);
      if (src === undefined) return null;
      const r = str(rep);
      const repetition = r === "repeat" || r === "repeat-x" || r === "repeat-y" || r === "no-repeat" ? r : "repeat";
      return styleHandle({ k: "pattern", img: src, rep: repetition });
    },

    /* -------- hit testing -------- */
    setLineDash: (seg: unknown): void => {
      if (!Array.isArray(seg)) return;
      const parts = seg.map(num);
      if (parts.some((n) => n < 0)) return;
      engine.setState({ dash: parts });
    },
    getLineDash: (): number[] => [...st().dash],
    isPointInPath: (...args: unknown[]): boolean => {
      const { path, rule } = parseFillArgs(args.slice(0, -2));
      return engine.isPointInPath(path, num(args[args.length - 2]), num(args[args.length - 1]), rule);
    },
    isPointInStroke: (...args: unknown[]): boolean => {
      const tail = args.slice(-2);
      const path = args.length >= 3 && args[0] instanceof Path2DImpl ? (args[0]).rep : engine.path();
      return engine.isPointInStroke(path, num(tail[0]), num(tail[1]));
    },

    /* -------- misc -------- */
    drawFocusIfNeeded: (_el?: unknown): void => {
      // Focus-ring drawing needs the a11y focus path — honest no-op for now.
    },
    isContextLost: (): boolean => false,
  };
  Object.defineProperty(ctx, "canvas", {
    get: () => deps.canvasRef(),
    enumerable: true,
    configurable: false,
  });
  return ctx;
}

/** Resolve a drawImage/createPattern source to pixels. */
function resolveDrawSource(src: unknown, deps: Canvas2DApiDeps): DecodedImage | undefined {
  if (src === null || src === undefined || typeof src !== "object") return undefined;
  const viaCanvas = deps.resolveCanvas?.(src);
  if (viaCanvas !== undefined) return viaCanvas.rasterize();
  return deps.resolveImage?.(src);
}

function colorToCss(c: Color): string {
  const hex = (n: number): string => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");
  return c.a >= 1
    ? `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`
    : `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${Math.round(c.a * 1000) / 1000})`;
}

function fontToCss(f: FontSpec): string {
  const style = f.style === "normal" ? "" : `${f.style} `;
  const weight = f.weight === 400 ? "" : `${f.weight} `;
  return `${style}${weight}${f.sizePx}px ${f.family}`;
}
