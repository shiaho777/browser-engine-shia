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
      });
    } else if (command.op === "pop-layer") {
      const frame = frames.pop();
      if (frame === undefined) continue;
      targets.pop();
      if (frame.filter !== undefined) applyFilter(frame.buf, w, h, frame.filter);
      compositeLayer(current(), frame.buf, w, h, frame.opacity, frame.transform);
      while (clipStack.length > frame.clipDepth) clipStack.pop();
    } else {
      applyCommand(current(), w, 0, h, clipStack, command);
    }
  }
  while (frames.length > 0) {
    const frame = frames.pop() as LayerFrame;
    targets.pop();
    if (frame.filter !== undefined) applyFilter(frame.buf, w, h, frame.filter);
    compositeLayer(current(), frame.buf, w, h, frame.opacity, frame.transform);
  }

  return { width: w, height: h, pixels: base };
}

function isIdentity(m: Matrix6): boolean {
  return m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;
}

/** Composite an offscreen layer onto `dest` (opacity + optional affine transform). */
function compositeLayer(
  dest: Uint8ClampedArray,
  layer: Uint8ClampedArray,
  w: number,
  h: number,
  opacity: number,
  transform: Matrix6 | null,
): void {
  if (opacity <= 0) return;
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
