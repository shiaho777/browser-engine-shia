/**
 * executor.ts — the full GPU compositor: it runs a {@link DisplayProgram} (the
 * flat command set PLUS compositing layers) on the GPU pipeline. Layers are
 * offscreen render targets; `pop-layer` applies the layer's CSS `filter` (real
 * separable box-blur + colour-matrix passes) and composites it onto the parent
 * with opacity and an affine transform (inverse-mapped bilinear sampling). This
 * is the self-developed software-GPU compositor — the same fixed-function +
 * programmable model a hardware GPU runs, in our own code.
 */
import {
  applyCommand,
  blendInto,
  clamp01,
  type ClipRect,
  type GpuColor,
  type GpuCommand,
} from "./pipeline.js";
import type { GpuSurface } from "./device.js";

/** A 2D affine transform `[a,b,c,d,e,f]` (device-absolute). */
export type Matrix6 = readonly [number, number, number, number, number, number];

export interface PushLayerCommand {
  readonly op: "push-layer";
  readonly opacity: number;
  readonly transform?: Matrix6;
  readonly filter?: string;
}
export interface PopLayerCommand {
  readonly op: "pop-layer";
}

/** A display command: a flat pipeline command or a compositing-layer command. */
export type DisplayCommand = GpuCommand | PushLayerCommand | PopLayerCommand;

/** A full display program (flat draws + clips + nested compositing layers). */
export interface DisplayProgram {
  readonly width: number;
  readonly height: number;
  readonly background: GpuColor;
  readonly commands: readonly DisplayCommand[];
}

interface LayerFrame {
  readonly buf: Uint8ClampedArray;
  readonly opacity: number;
  readonly transform: Matrix6 | null;
  readonly filter: string | undefined;
  readonly clipDepth: number;
  /** Drawn-content bounds in layer device px; filter/composite read only this. */
  inkX0: number;
  inkY0: number;
  inkX1: number;
  inkY1: number;
  /** A draw of unbounded extent (e.g. `clear`) landed in the layer. */
  unbounded: boolean;
}

/** Ink update: concrete device-px bounds, "unbounded", or nothing drawn (null). */
type InkBounds = readonly [number, number, number, number] | "unbounded" | null;

/** What a layer's filter/composite can touch — see {@link layerWindowOf}. */
type LayerWindow = readonly [number, number, number, number] | "unbounded" | "empty";

/**
 * Total box-blur radius a `filter` string applies: every `blur(N)` runs 3
 * box passes of radius `round(N)` (see `applyFilter`/`boxBlur`), so the
 * post-blur alpha support extends `3 * Σ radii` past the drawn ink. Parses
 * exactly like `applyFilter`'s blur branch (px optional, parseFloat prefix).
 */
function blurSpreadOf(filter: string | undefined): number {
  if (filter === undefined) return 0;
  let total = 0;
  const re = /blur\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(filter.toLowerCase())) !== null) {
    const r = Number.parseFloat((m[1] ?? "").trim().replace(/px$/, ""));
    if (Number.isFinite(r) && r > 0) total += Math.round(r);
  }
  return total;
}

/**
 * The region of a layer that its filter and composite can affect:
 *   - a window `[x0,y0,x1,y1)` fully containing everything: the drawn ink
 *     grown by the blur support plus one pixel of slack (the +1 makes the
 *     box-blur's window-edge clamps read zeros exactly where the unbounded
 *     pass reads transparent zeros, so the bounded pass is byte-identical to
 *     the full-frame one);
 *   - `"unbounded"` = unknown extent (`clear` drew here) — full-frame passes;
 *   - `"empty"` = nothing was drawn into the layer (every draw was clipped
 *     out) — the layer is fully transparent, so filter and composite are
 *     exact no-ops.
 */
function layerWindowOf(frame: LayerFrame, w: number, h: number): LayerWindow {
  if (frame.unbounded) return "unbounded";
  if (frame.inkX1 <= frame.inkX0 || frame.inkY1 <= frame.inkY0) return "empty";
  const pad = blurSpreadOf(frame.filter) * 3 + 1;
  return [
    Math.max(0, frame.inkX0 - pad),
    Math.max(0, frame.inkY0 - pad),
    Math.min(w, frame.inkX1 + pad),
    Math.min(h, frame.inkY1 + pad),
  ];
}

/** Run a full display program serially on the GPU pipeline; returns the surface. */
export function renderProgram(program: DisplayProgram): GpuSurface {
  const w = program.width;
  const h = program.height;
  const base = new Uint8ClampedArray(w * h * 4);
  // Initialise the base target to the (opaque) background.
  for (let i = 0; i < w * h; i += 1) {
    base[i * 4] = program.background.r;
    base[i * 4 + 1] = program.background.g;
    base[i * 4 + 2] = program.background.b;
    base[i * 4 + 3] = clamp01(program.background.a) * 255;
  }

  const targets: Uint8ClampedArray[] = [base];
  const frames: LayerFrame[] = [];
  const clipStack: ClipRect[] = [{ x0: 0, y0: 0, x1: w, y1: h }];
  const current = (): Uint8ClampedArray => targets[targets.length - 1] as Uint8ClampedArray;

  for (const command of program.commands) {
    if (command.op === "push-layer") {
      const transform =
        command.transform !== undefined && !isIdentity(command.transform) ? command.transform : null;
      targets.push(new Uint8ClampedArray(w * h * 4)); // transparent offscreen.
      frames.push({
        buf: current(),
        opacity: clamp01(command.opacity),
        transform,
        filter: command.filter !== undefined && command.filter !== "none" ? command.filter : undefined,
        clipDepth: clipStack.length,
        inkX0: w, inkY0: h, inkX1: 0, inkY1: 0,
        unbounded: false,
      });
    } else if (command.op === "pop-layer") {
      const frame = frames.pop();
      if (frame === undefined) continue;
      targets.pop();
      const parent = frames[frames.length - 1];
      // The window the filter may have written (ink + blur support) is what
      // this pop can deposit into the parent — propagate THAT as parent ink,
      // not the pre-filter ink (a blur spreads alpha past the drawn bounds).
      const filterWin = layerWindowOf(frame, w, h);
      if (frame.filter !== undefined) applyFilterBounded(frame.buf, w, h, frame.filter, frame);
      const composited = compositeLayerBounded(current(), frame.buf, w, h, frame.opacity, frame.transform, frame);
      if (parent !== undefined && composited !== null) {
        // The pixels this pop wrote into the parent are the parent's ink too —
        // a nested layer's content must constrain the parent's filter window.
        if (composited === "unbounded" || filterWin === "unbounded") {
          parent.unbounded = true;
        } else if (filterWin !== "empty") {
          parent.inkX0 = Math.min(parent.inkX0, filterWin[0], composited[0]);
          parent.inkY0 = Math.min(parent.inkY0, filterWin[1], composited[1]);
          parent.inkX1 = Math.max(parent.inkX1, filterWin[2], composited[2]);
          parent.inkY1 = Math.max(parent.inkY1, filterWin[3], composited[3]);
        }
      }
      while (clipStack.length > frame.clipDepth) clipStack.pop();
    } else {
      applyCommand(current(), w, 0, h, clipStack, command);
      const frame = frames[frames.length - 1];
      if (frame !== undefined) {
        const bounds = commandBounds(command, clipStack[clipStack.length - 1] as ClipRect, w, h);
        if (bounds === "unbounded") {
          frame.unbounded = true;
        } else if (bounds !== null) {
          frame.inkX0 = Math.min(frame.inkX0, bounds[0]);
          frame.inkY0 = Math.min(frame.inkY0, bounds[1]);
          frame.inkX1 = Math.max(frame.inkX1, bounds[2]);
          frame.inkY1 = Math.max(frame.inkY1, bounds[3]);
        }
      }
    }
  }
  while (frames.length > 0) {
    const frame = frames.pop() as LayerFrame;
    targets.pop();
    const parent = frames[frames.length - 1];
    const filterWin = layerWindowOf(frame, w, h);
    if (frame.filter !== undefined) applyFilterBounded(frame.buf, w, h, frame.filter, frame);
    const composited = compositeLayerBounded(current(), frame.buf, w, h, frame.opacity, frame.transform, frame);
    if (parent !== undefined && composited !== null) {
      if (composited === "unbounded" || filterWin === "unbounded") {
        parent.unbounded = true;
      } else if (filterWin !== "empty") {
        parent.inkX0 = Math.min(parent.inkX0, filterWin[0], composited[0]);
        parent.inkY0 = Math.min(parent.inkY0, filterWin[1], composited[1]);
        parent.inkX1 = Math.max(parent.inkX1, filterWin[2], composited[2]);
        parent.inkY1 = Math.max(parent.inkY1, filterWin[3], composited[3]);
      }
    }
  }

  return { width: w, height: h, pixels: base };
}

/**
 * Device-px bounds a draw command touches (clamped to the current clip):
 * `null` = draws nothing, `"unbounded"` = full-surface/unknown extent.
 */
function commandBounds(command: DisplayCommand, clip: ClipRect, w: number, h: number): InkBounds {
  if (command.op === "quad") {
    const x0 = Math.max(clip.x0, Math.floor(command.x));
    const y0 = Math.max(clip.y0, Math.floor(command.y));
    const x1 = Math.min(clip.x1, Math.ceil(command.x + command.w));
    const y1 = Math.min(clip.y1, Math.ceil(command.y + command.h));
    if (x1 <= x0 || y1 <= y0) return null;
    // Concrete clamped bounds are exact even for full-width/full-height
    // quads: rows/cols outside them are untouched, and the blur padding
    // grows the window only by the finite blur support.
    return [Math.max(0, x0), Math.max(0, y0), Math.min(w, x1), Math.min(h, y1)];
  }
  // `clear` resets the full surface (genuinely unbounded). Clip push/pop draw
  // nothing — they only constrain later draws, whose bounds we already track.
  if (command.op === "clear") return "unbounded";
  if (command.op === "push-clip" || command.op === "pop-clip") return null;
  return "unbounded";
}

function isIdentity(m: Matrix6): boolean {
  return m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;
}

/**
 * Composite only the layer's filter window (see {@link layerWindowOf}) —
 * untouched layer pixels outside contribute nothing, so the composed frame is
 * identical to the full-buffer pass. Transformed layers composite unbounded.
 * `frame === null` runs the unbounded full-buffer path.
 *
 * Returns the destination region actually written (grown by any transform
 * feedback, so a parent layer can treat it as its own ink), "unbounded" when
 * that can't be known, or null when nothing was composited.
 */
function compositeLayerBounded(
  dest: Uint8ClampedArray,
  layer: Uint8ClampedArray,
  w: number,
  h: number,
  opacity: number,
  transform: Matrix6 | null,
  frame: LayerFrame | null,
): InkBounds {
  if (opacity <= 0) return null;
  // An untouched layer is transparent regardless of transform: nothing to
  // filter, nothing to blend (the empty check must precede the transform
  // branch — a transformed-but-empty layer would otherwise scan the frame).
  if (frame !== null && !frame.unbounded && frame.inkX1 <= frame.inkX0 && frame.inkY1 <= frame.inkY0) {
    return null;
  }
  const win = frame !== null && frame.transform === null ? layerWindowOf(frame, w, h) : "unbounded";
  if (win === "unbounded") {
    if (transform === null) {
      compositeLayerUnbounded(dest, layer, w, h, opacity, null);
      return [0, 0, w, h];
    }
    // Transformed: scan only the dest region the layer's ink window maps to.
    // The ink window tracks what was DRAWN even on transformed layers; the
    // bilinear sampler reads at most 1px past a sample, so a 1px pad keeps
    // the result identical to the full-frame scan.
    const inkWin: readonly [number, number, number, number] | null =
      frame !== null && !frame.unbounded && frame.inkX1 > frame.inkX0 && frame.inkY1 > frame.inkY0
        ? [Math.max(0, frame.inkX0 - 1), Math.max(0, frame.inkY0 - 1), Math.min(w, frame.inkX1 + 1), Math.min(h, frame.inkY1 + 1)]
        : null;
    const destWin = inkWin !== null ? transformDestBounds(transform, inkWin[2] - inkWin[0], inkWin[3] - inkWin[1], inkWin[0], inkWin[1], w, h) : null;
    if (destWin !== null && destWin !== "unbounded") {
      compositeLayerWindow(dest, layer, w, h, opacity, transform, destWin);
      return destWin;
    }
    compositeLayerUnbounded(dest, layer, w, h, opacity, transform);
    return transformDestBounds(transform, w, h);
  }
  if (win === "empty") return null; // fully transparent layer: blend nothing
  // Bounded identity-transform composite: only the window can hold alpha > 0.
  for (let y = win[1]; y < win[3]; y += 1) {
    const rowBase = y * w;
    for (let x = win[0]; x < win[2]; x += 1) {
      const p = rowBase + x;
      const a = (layer[p * 4 + 3] as number) / 255;
      if (a <= 0) continue;
      blendInto(dest, p * 4, {
        r: layer[p * 4] as number,
        g: layer[p * 4 + 1] as number,
        b: layer[p * 4 + 2] as number,
        a: a * opacity,
      });
    }
  }
  return [win[0], win[1], win[2], win[3]] as const;
}

/**
 * Inverse-mapped composite over dest window `[dx0,dy0)..[dx1,dy1)` — the same
 * loop as the transformed branch of {@link compositeLayerUnbounded}, restricted
 * to a window (pixel-identical output, since each dest pixel is independent).
 */
function compositeLayerWindow(
  dest: Uint8ClampedArray,
  layer: Uint8ClampedArray,
  w: number,
  h: number,
  opacity: number,
  transform: Matrix6,
  destWin: readonly [number, number, number, number],
): void {
  const inv = invert(transform);
  if (inv === null) return;
  const [ia, ib, ic, id, ie, iff] = inv;
  for (let y = destWin[1]; y < destWin[3]; y += 1) {
    for (let x = destWin[0]; x < destWin[2]; x += 1) {
      const dx = x + 0.5;
      const dy = y + 0.5;
      const sample = bilinear(layer, w, h, ia * dx + ic * dy + ie - 0.5, ib * dx + id * dy + iff - 0.5);
      if (sample === null || sample.a <= 0) continue;
      blendInto(dest, (y * w + x) * 4, { r: sample.r, g: sample.g, b: sample.b, a: sample.a * opacity });
    }
  }
}

/**
 * Destination bounds the forward transform `m` maps `[ox,oy)..[ox+sw,oy+sh)`
 * to: map the window's four corners into dest space, bounding box, clamped.
 */
function transformDestBounds(m: Matrix6, sw: number, sh: number, ox = 0, oy = 0, dw?: number, dh?: number): InkBounds {
  const W = dw ?? sw;
  const H = dh ?? sh;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [px, py] of [[ox, oy], [ox + sw, oy], [ox, oy + sh], [ox + sw, oy + sh]] as const) {
    xs.push(m[0] * px + m[2] * py + m[4]);
    ys.push(m[1] * px + m[3] * py + m[5]);
  }
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const x1 = Math.min(W, Math.ceil(Math.max(...xs)));
  const y1 = Math.min(H, Math.ceil(Math.max(...ys)));
  if (x1 <= x0 || y1 <= y0) return null;
  return [x0, y0, x1, y1];
}

function compositeLayerUnbounded(
  dest: Uint8ClampedArray,
  layer: Uint8ClampedArray,
  w: number,
  h: number,
  opacity: number,
  transform: Matrix6 | null,
): void {
  if (transform === null) {
    for (let p = 0; p < w * h; p += 1) {
      const a = (layer[p * 4 + 3] as number) / 255;
      if (a <= 0) continue;
      blendInto(dest, p * 4, {
        r: layer[p * 4] as number,
        g: layer[p * 4 + 1] as number,
        b: layer[p * 4 + 2] as number,
        a: a * opacity,
      });
    }
    return;
  }
  const inv = invert(transform);
  if (inv === null) return;
  const [ia, ib, ic, id, ie, iff] = inv;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const dx = x + 0.5;
      const dy = y + 0.5;
      const sample = bilinear(layer, w, h, ia * dx + ic * dy + ie - 0.5, ib * dx + id * dy + iff - 0.5);
      if (sample === null || sample.a <= 0) continue;
      blendInto(dest, (y * w + x) * 4, { r: sample.r, g: sample.g, b: sample.b, a: sample.a * opacity });
    }
  }
}

function invert(m: Matrix6): Matrix6 | null {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return null;
  const ia = d / det;
  const ib = -b / det;
  const ic = -c / det;
  const id = a / det;
  return [ia, ib, ic, id, -(ia * e + ic * f), -(ib * e + id * f)];
}

function bilinear(buf: Uint8ClampedArray, w: number, h: number, x: number, y: number): GpuColor | null {
  if (x < -0.5 || y < -0.5 || x > w - 0.5 || y > h - 0.5) return null;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const at = (px: number, py: number): readonly [number, number, number, number] => {
    if (px < 0 || py < 0 || px >= w || py >= h) return [0, 0, 0, 0];
    const i = (py * w + px) * 4;
    return [buf[i] as number, buf[i + 1] as number, buf[i + 2] as number, (buf[i + 3] as number) / 255];
  };
  const p00 = at(x0, y0);
  const p10 = at(x0 + 1, y0);
  const p01 = at(x0, y0 + 1);
  const p11 = at(x0 + 1, y0 + 1);
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
  const mix = (k: number): number => lerp(lerp(p00[k]!, p10[k]!, fx), lerp(p01[k]!, p11[k]!, fx), fy);
  return { r: mix(0), g: mix(1), b: mix(2), a: mix(3) };
}

// ---- filters (real software passes) ---------------------------------------

/**
 * Apply `filter` to the layer, processing only the drawn-content window (see
 * {@link layerWindowOf}). Everything outside is untouched transparent layer,
 * so the bounded result is identical to the unbounded pass — falls back to
 * full-frame when bounds are unknown.
 */
function applyFilterBounded(buf: Uint8ClampedArray, w: number, h: number, filter: string, frame: LayerFrame): void {
  const win = layerWindowOf(frame, w, h);
  if (win === "empty") return; // nothing drawn → the blur of nothing is nothing
  if (win === "unbounded") {
    applyFilter(buf, w, h, filter);
    return;
  }
  applyFilterWindow(buf, w, filter, win[0], win[1], win[2], win[3]);
}

/**
 * Run `applyFilter` over the window `[wx0,wy0)..[wx1,wy1)` only: crop the
 * window into a scratch buffer, run the existing per-pixel kernels there, and
 * write it back. The box-blur's edge clamp makes row/col runs independent of
 * pixels outside the window, so the result matches the full-frame pass
 * wherever the window's own pixels end up — and outside it, the layer is
 * transparent both before and after, so the composed frame is identical.
 */
function applyFilterWindow(
  buf: Uint8ClampedArray,
  w: number,
  filter: string,
  wx0: number,
  wy0: number,
  wx1: number,
  wy1: number,
): void {
  const winW = wx1 - wx0;
  const winH = wy1 - wy0;
  if (winW <= 0 || winH <= 0) return;
  const window = new Uint8ClampedArray(winW * winH * 4);
  for (let y = wy0; y < wy1; y += 1) {
    const srcRow = y * w * 4;
    const dstRow = (y - wy0) * winW * 4;
    for (let x = wx0; x < wx1; x += 1) {
      const s = srcRow + x * 4;
      const d = dstRow + (x - wx0) * 4;
      window[d] = buf[s] as number;
      window[d + 1] = buf[s + 1] as number;
      window[d + 2] = buf[s + 2] as number;
      window[d + 3] = buf[s + 3] as number;
    }
  }
  applyFilter(window, winW, winH, filter);
  for (let y = wy0; y < wy1; y += 1) {
    const dstRow = y * w * 4;
    const srcRow = (y - wy0) * winW * 4;
    for (let x = wx0; x < wx1; x += 1) {
      const d = dstRow + x * 4;
      const s = srcRow + (x - wx0) * 4;
      buf[d] = window[s] as number;
      buf[d + 1] = window[s + 1] as number;
      buf[d + 2] = window[s + 2] as number;
      buf[d + 3] = window[s + 3] as number;
    }
  }
}

function applyFilter(buf: Uint8ClampedArray, w: number, h: number, filter: string): void {
  const re = /([a-z-]+)\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(filter.toLowerCase())) !== null) {
    const fn = m[1] as string;
    const arg = (m[2] ?? "").trim();
    if (fn === "blur") {
      const r = Number.parseFloat(arg.replace(/px$/, ""));
      if (Number.isFinite(r) && r > 0) boxBlur(buf, w, h, Math.round(r));
    } else {
      const amt = parseAmount(arg);
      const op = colorOp(fn, amt);
      if (op !== null) {
        for (let i = 0; i < buf.length; i += 4) {
          if ((buf[i + 3] as number) === 0) continue;
          const [r, g, b, a] = op(buf[i] as number, buf[i + 1] as number, buf[i + 2] as number, (buf[i + 3] as number) / 255);
          buf[i] = r;
          buf[i + 1] = g;
          buf[i + 2] = b;
          buf[i + 3] = a * 255;
        }
      }
    }
  }
}

function parseAmount(arg: string): number {
  if (arg === "") return 1;
  if (arg.endsWith("%")) return Number.parseFloat(arg) / 100;
  const n = Number.parseFloat(arg);
  return Number.isFinite(n) ? n : 1;
}

type ColorOp = (r: number, g: number, b: number, a: number) => readonly [number, number, number, number];

function colorOp(fn: string, amt: number): ColorOp | null {
  switch (fn) {
    case "grayscale": {
      const t = Math.min(1, amt);
      return (r, g, b, a) => {
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        return [r + (l - r) * t, g + (l - g) * t, b + (l - b) * t, a];
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
    case "sepia": {
      const t = Math.min(1, amt);
      return (r, g, b, a) => {
        const sr = 0.393 * r + 0.769 * g + 0.189 * b;
        const sg = 0.349 * r + 0.686 * g + 0.168 * b;
        const sb = 0.272 * r + 0.534 * g + 0.131 * b;
        return [r + (sr - r) * t, g + (sg - g) * t, b + (sb - b) * t, a];
      };
    }
    default:
      return null;
  }
}

function boxBlur(buf: Uint8ClampedArray, w: number, h: number, radius: number): void {
  const n = w * h;
  const pr = new Float64Array(n);
  const pg = new Float64Array(n);
  const pb = new Float64Array(n);
  const pa = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const a = (buf[i * 4 + 3] as number) / 255;
    pr[i] = (buf[i * 4] as number) * a;
    pg[i] = (buf[i * 4 + 1] as number) * a;
    pb[i] = (buf[i * 4 + 2] as number) * a;
    pa[i] = a;
  }
  for (let pass = 0; pass < 3; pass += 1) {
    for (const ch of [pr, pg, pb, pa]) blurPass(ch, w, h, radius);
  }
  for (let i = 0; i < n; i += 1) {
    const a = pa[i] as number;
    if (a <= 0) {
      buf[i * 4] = buf[i * 4 + 1] = buf[i * 4 + 2] = buf[i * 4 + 3] = 0;
      continue;
    }
    buf[i * 4] = (pr[i] as number) / a;
    buf[i * 4 + 1] = (pg[i] as number) / a;
    buf[i * 4 + 2] = (pb[i] as number) / a;
    buf[i * 4 + 3] = a * 255;
  }
}

function blurPass(chan: Float64Array, w: number, h: number, radius: number): void {
  const win = 2 * radius + 1;
  const tmp = new Float64Array(chan.length);
  const cl = (i: number, size: number): number => (i < 0 ? 0 : i >= size ? size - 1 : i);
  for (let y = 0; y < h; y += 1) {
    const row = y * w;
    let sum = 0;
    for (let k = -radius; k <= radius; k += 1) sum += chan[row + cl(k, w)] as number;
    for (let x = 0; x < w; x += 1) {
      tmp[row + x] = sum / win;
      sum += (chan[row + cl(x + radius + 1, w)] as number) - (chan[row + cl(x - radius, w)] as number);
    }
  }
  for (let x = 0; x < w; x += 1) {
    let sum = 0;
    for (let k = -radius; k <= radius; k += 1) sum += tmp[cl(k, h) * w + x] as number;
    for (let y = 0; y < h; y += 1) {
      chan[y * w + x] = sum / win;
      sum += (tmp[cl(y + radius + 1, h) * w + x] as number) - (tmp[cl(y - radius, h) * w + x] as number);
    }
  }
}
