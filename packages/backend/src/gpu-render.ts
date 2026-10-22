/**
 * gpu-render.ts — render a paint {@link DisplayList} entirely through the GPU
 * pipeline (`@browser-engine/gpu`). EVERY paint op becomes a GPU command +
 * fragment shader:
 *   - `rect`   → a solid quad;
 *   - `border` → four solid edge quads;
 *   - `text`   → one `coverage`-shaded quad per glyph (the glyph's rasterized
 *     alpha mask × the fill colour) — text on the GPU;
 *   - `image`  → an `image`-sampled quad;
 *   - `push/pop-clip`  → GPU clip-stack ops;
 *   - `push/pop-layer` → GPU compositing layers (opacity + affine transform +
 *     CSS filter passes), origin already baked into the matrix by paint.
 *
 * The result is validated byte-for-pixel against the CPU {@link ScreenshotBackend}
 * reference (the differential oracle) within tolerance. This is the path real
 * screenshots take: the whole DisplayList rasterized by the GPU compositor.
 */
import type { Color, DisplayList, PaintCmd, Rect } from "@browser-engine/ir";
import { paintCmdBounds } from "@browser-engine/ir";
import {
  renderProgram,
  type DisplayCommand,
  type GpuColor,
  type GpuSurface,
} from "@browser-engine/gpu";
import type { GlyphRasterSource } from "@browser-engine/font";

import { builtinFont, faceTableRasterSource } from "@browser-engine/font";
import { needsSyntheticBold, needsSyntheticItalic, syntheticItalicShift } from "./embolden.js";
import { gradientColor, gradientT, radialT } from "./gradient.js";

const DEFAULT_SOURCE: GlyphRasterSource = faceTableRasterSource([builtinFont()]);
const WHITE: GpuColor = { r: 255, g: 255, b: 255, a: 1 };

function toGpu(c: Color): GpuColor {
  return { r: c.r, g: c.g, b: c.b, a: c.a };
}

/** Render a DisplayList through the GPU compositor into an RGBA surface. */
export function renderDisplayListOnGpu(
  list: DisplayList,
  width: number,
  height: number,
  rasterSource: GlyphRasterSource = DEFAULT_SOURCE,
  options?: {
    readonly clipMaxY?: number;
    readonly clipMaxX?: number;
    readonly pixelRatio?: number;
    /**
     * RFC 0039 partial repaint: a CSS-px damage rect produced by
     * `diffCommands`. Commands whose bounds don't intersect it are skipped at
     * translate time; remaining draws are scissored to it in the executor.
     * Only honoured together with `into` — and dropped to a full render when
     * the list contains a transformed/filtered layer (those resample or write
     * outside their own content bounds).
     */
    readonly damage?: Rect;
    /** Previous frame's pixel buffer to repair in place (device px). */
    readonly into?: Uint8ClampedArray;
  },
): GpuSurface {
  const prRaw = options?.pixelRatio ?? 1;
  const pr = Number.isFinite(prRaw) ? Math.max(1, Math.min(3, prRaw)) : 1;
  const outW = Math.max(1, Math.round(width * pr));
  const outH = Math.max(1, Math.round(height * pr));
  const into = options?.into;
  let damage = options?.damage;
  if (damage !== undefined && (into === undefined || into.length !== outW * outH * 4)) {
    damage = undefined;
  }
  const commands: DisplayCommand[] = [];
  const clipMaxY = (options?.clipMaxY ?? height) * pr;
  const clipMaxX = (options?.clipMaxX ?? width) * pr;
  for (const cmd of list.commands) {
    if (damage !== undefined && cmd.op !== "push-clip" && cmd.op !== "pop-clip" && cmd.op !== "push-layer" && cmd.op !== "pop-layer") {
      const bounds = paintCmdBounds(cmd);
      // Envelope commands are never skipped — a clip's bound is not the bound
      // of the content it gates. Draw ops whose bounds miss the damage rect
      // cannot produce changed pixels inside it.
      if (
        bounds !== null &&
        (Number(bounds.x) + Number(bounds.width) <= Number(damage.x) ||
          Number(bounds.y) + Number(bounds.height) <= Number(damage.y) ||
          Number(bounds.x) >= Number(damage.x) + Number(damage.width) ||
          Number(bounds.y) >= Number(damage.y) + Number(damage.height))
      ) {
        continue;
      }
    }
    translate(cmd, commands, rasterSource, clipMaxX, clipMaxY, pr);
  }
  const deviceDamage =
    damage === undefined
      ? undefined
      : {
          x0: Math.max(0, Math.floor(Number(damage.x) * pr)),
          y0: Math.max(0, Math.floor(Number(damage.y) * pr)),
          x1: Math.min(outW, Math.ceil((Number(damage.x) + Number(damage.width)) * pr)),
          y1: Math.min(outH, Math.ceil((Number(damage.y) + Number(damage.height)) * pr)),
        };
  return renderProgram(
    { width: outW, height: outH, background: WHITE, commands },
    deviceDamage === undefined || into === undefined
      ? undefined
      : { damage: deviceDamage, into },
  );
}

function inClip(x: number, y: number, w: number, h: number, maxX: number, maxY: number): boolean {
  if (!(w > 0) || !(h > 0)) return false;
  if (y >= maxY || y + h <= 0) return false;
  if (x >= maxX || x + w <= 0) return false;
  return true;
}

function translate(
  cmd: PaintCmd,
  out: DisplayCommand[],
  rasterSource: GlyphRasterSource,
  clipMaxX: number,
  clipMaxY: number,
  pr = 1,
): void {
  switch (cmd.op) {
    case "rect": {
      const x = Number(cmd.rect.x) * pr;
      const y = Number(cmd.rect.y) * pr;
      const w = Number(cmd.rect.width) * pr;
      const h = Number(cmd.rect.height) * pr;
      if (!inClip(x, y, w, h, clipMaxX, clipMaxY)) return;
      if (cmd.fill.a <= 0) return;
      const radius = cmd.radius !== undefined ? Number(cmd.radius) * pr : 0;
      out.push(
        radius > 0
          ? { op: "quad", x, y, w, h, fragment: { kind: "solid", color: toGpu(cmd.fill) }, radius }
          : { op: "quad", x, y, w, h, fragment: { kind: "solid", color: toGpu(cmd.fill) } },
      );
      return;
    }
    case "border":
      translateBorder(cmd, out, clipMaxX, clipMaxY, pr);
      return;
    case "text":
      translateText(cmd, out, rasterSource, clipMaxX, clipMaxY, pr);
      return;
    case "image": {
      const x = Number(cmd.rect.x) * pr;
      const y = Number(cmd.rect.y) * pr;
      const w = Number(cmd.rect.width) * pr;
      const h = Number(cmd.rect.height) * pr;
      if (!inClip(x, y, w, h, clipMaxX, clipMaxY)) return;
      const radius = cmd.radius !== undefined ? Number(cmd.radius) * pr : 0;
      const fragment = {
        kind: "image" as const,
        width: cmd.src.width,
        height: cmd.src.height,
        rgba: cmd.src.pixels,
      };
      out.push(radius > 0 ? { op: "quad", x, y, w, h, fragment, radius } : { op: "quad", x, y, w, h, fragment });
      return;
    }
    case "tile": {
      // Per-tile quads under an area clip — same semantics as the CPU oracle's
      // blitTiled (radius rounds the AREA via a clip, never each tile).
      const ax = Number(cmd.area.x) * pr;
      const ay = Number(cmd.area.y) * pr;
      const aw = Number(cmd.area.width) * pr;
      const ah = Number(cmd.area.height) * pr;
      if (!inClip(ax, ay, aw, ah, clipMaxX, clipMaxY)) return;
      const tw = Number(cmd.tile.width) * pr;
      const th = Number(cmd.tile.height) * pr;
      const stepX = Math.max(1, Number(cmd.step.x) * pr);
      const stepY = Math.max(1, Number(cmd.step.y) * pr);
      if (tw <= 0 || th <= 0) return;
      const ox = Number(cmd.origin.x) * pr;
      const oy = Number(cmd.origin.y) * pr;
      const x0 = Math.max(0, ax);
      const y0 = Math.max(0, ay);
      const x1 = Math.min(clipMaxX, ax + aw);
      const y1 = Math.min(clipMaxY, ay + ah);
      const ix0 = cmd.repeatX ? Math.floor((x0 - ox) / stepX) : 0;
      const ix1 = cmd.repeatX ? Math.floor((x1 - 1 - ox) / stepX) : 0;
      const iy0 = cmd.repeatY ? Math.floor((y0 - oy) / stepY) : 0;
      const iy1 = cmd.repeatY ? Math.floor((y1 - 1 - oy) / stepY) : 0;
      const radius = cmd.radius !== undefined ? Number(cmd.radius) * pr : 0;
      const fragment = {
        kind: "image" as const,
        width: cmd.src.width,
        height: cmd.src.height,
        rgba: cmd.src.pixels,
      };
      out.push(
        radius > 0
          ? { op: "push-clip", x: ax, y: ay, w: aw, h: ah, radius }
          : { op: "push-clip", x: ax, y: ay, w: aw, h: ah },
      );
      for (let iy = iy0; iy <= iy1; iy += 1) {
        for (let ix = ix0; ix <= ix1; ix += 1) {
          out.push({ op: "quad", x: ox + ix * stepX, y: oy + iy * stepY, w: tw, h: th, fragment });
        }
      }
      out.push({ op: "pop-clip" });
      return;
    }
    case "push-clip": {
      const radius = cmd.radius !== undefined ? Number(cmd.radius) * pr : 0;
      out.push(
        radius > 0
          ? {
              op: "push-clip",
              x: Number(cmd.rect.x) * pr,
              y: Number(cmd.rect.y) * pr,
              w: Number(cmd.rect.width) * pr,
              h: Number(cmd.rect.height) * pr,
              radius,
            }
          : {
              op: "push-clip",
              x: Number(cmd.rect.x) * pr,
              y: Number(cmd.rect.y) * pr,
              w: Number(cmd.rect.width) * pr,
              h: Number(cmd.rect.height) * pr,
            },
      );
      return;
    }
    case "pop-clip":
      out.push({ op: "pop-clip" });
      return;
    case "push-layer": {
      let transform = cmd.transform;
      if (transform !== undefined && pr !== 1) {
        const m = transform;
        transform = [m[0], m[1], m[2], m[3], m[4] * pr, m[5] * pr];
      }
      out.push({
        op: "push-layer",
        opacity: cmd.opacity,
        transform,
        ...(cmd.filter !== undefined ? { filter: cmd.filter } : {}),
      });
      return;
    }
    case "pop-layer":
      out.push({ op: "pop-layer" });
      return;
    case "linear-gradient": {
      const x0 = Number(cmd.rect.x) * pr;
      const y0 = Number(cmd.rect.y) * pr;
      const w = Number(cmd.rect.width) * pr;
      const h = Number(cmd.rect.height) * pr;
      if (!inClip(x0, y0, w, h, clipMaxX, clipMaxY) || cmd.stops.length === 0) return;
      const rad = (cmd.angle * Math.PI) / 180;
      const horizontal = Math.abs(Math.sin(rad)) >= Math.abs(Math.cos(rad));
      const count = Math.max(1, Math.ceil(horizontal ? w : h));
      for (let i = 0; i < count; i += 1) {
        const strip = horizontal
          ? { x: x0 + i, y: y0, w: 1, h }
          : { x: x0, y: y0 + i, w, h: 1 };
        const t = gradientT(strip.x + strip.w / 2, strip.y + strip.h / 2, x0, y0, w, h, cmd.angle);
        const color = gradientColor(cmd.stops, t);
        if (color.a <= 0) continue;
        out.push({ op: "quad", x: strip.x, y: strip.y, w: strip.w, h: strip.h, fragment: { kind: "solid", color: toGpu(color) } });
      }
      return;
    }
    case "radial-gradient": {
      const x0 = Number(cmd.rect.x) * pr;
      const y0 = Number(cmd.rect.y) * pr;
      const w = Number(cmd.rect.width) * pr;
      const h = Number(cmd.rect.height) * pr;
      if (!inClip(x0, y0, w, h, clipMaxX, clipMaxY) || cmd.stops.length === 0) return;
      const cols = Math.max(1, Math.ceil(w));
      const rows = Math.max(1, Math.ceil(h));
      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
          const t = radialT(x0 + col + 0.5, y0 + row + 0.5, x0, y0, w, h);
          const color = gradientColor(cmd.stops, t);
          if (color.a <= 0) continue;
          out.push({ op: "quad", x: x0 + col, y: y0 + row, w: 1, h: 1, fragment: { kind: "solid", color: toGpu(color) } });
        }
      }
      return;
    }
  }
}
function translateBorder(
  cmd: Extract<PaintCmd, { op: "border" }>,
  out: DisplayCommand[],
  clipMaxX: number,
  clipMaxY: number,
  pr = 1,
): void {
  const x0 = Math.round(Number(cmd.rect.x) * pr);
  const y0 = Math.round(Number(cmd.rect.y) * pr);
  const x1 = Math.round((Number(cmd.rect.x) + Number(cmd.rect.width)) * pr);
  const y1 = Math.round((Number(cmd.rect.y) + Number(cmd.rect.height)) * pr);
  if (!inClip(x0, y0, x1 - x0, y1 - y0, clipMaxX, clipMaxY)) return;
  const top = Math.round(Number(cmd.edges.top.width) * pr);
  const right = Math.round(Number(cmd.edges.right.width) * pr);
  const bottom = Math.round(Number(cmd.edges.bottom.width) * pr);
  const left = Math.round(Number(cmd.edges.left.width) * pr);
  const edge = (drawn: boolean, color: Color, x: number, y: number, w: number, h: number): void => {
    if (!drawn || w <= 0 || h <= 0) return;
    if (color.a <= 0) return;
    if (!inClip(x, y, w, h, clipMaxX, clipMaxY)) return;
    out.push({ op: "quad", x, y, w, h, fragment: { kind: "solid", color: toGpu(color) } });
  };
  edge(cmd.edges.top.style !== "none" && top > 0, cmd.edges.top.color, x0, y0, x1 - x0, top);
  edge(cmd.edges.bottom.style !== "none" && bottom > 0, cmd.edges.bottom.color, x0, y1 - bottom, x1 - x0, bottom);
  edge(cmd.edges.left.style !== "none" && left > 0, cmd.edges.left.color, x0, y0, left, y1 - y0);
  edge(cmd.edges.right.style !== "none" && right > 0, cmd.edges.right.color, x1 - right, y0, right, y1 - y0);
}

function translateText(
  cmd: Extract<PaintCmd, { op: "text" }>,
  out: DisplayCommand[],
  source: GlyphRasterSource,
  clipMaxX: number,
  clipMaxY: number,
  pr = 1,
): void {
  const fontSize = Number(cmd.fontSize) * pr;
  if (fontSize <= 0) return;
  if (cmd.fill.a <= 0) return;
  const baseY = Number(cmd.at.y) * pr;
  if (baseY >= clipMaxY + fontSize * 2 || baseY + fontSize * 2 <= 0) return;
  const ascentPx = source.ascentEm * fontSize;
  const weight = cmd.fontWeight !== undefined ? Number(cmd.fontWeight) : 400;
  for (const glyph of cmd.glyphs) {
    // Real shaped (faceIndex, glyphId) — gid 0 is the face's own .notdef box.
    let r = source.raster(glyph.faceIndex, glyph.glyphId, fontSize);
    if (r.width === 0 || r.height === 0) continue;
    // Synthetic bold (RFC 0006): only when allowed AND the face lacks the weight.
    if (needsSyntheticBold(weight, source.faceWeight?.(glyph.faceIndex), cmd.synthesizeBold !== false)) {
      const w = r.width + 1;
      const h = r.height;
      const mask = new Float64Array(w * h);
      for (let yy = 0; yy < r.height; yy += 1) {
        for (let xx = 0; xx < r.width; xx += 1) {
          const v = r.coverage[yy * r.width + xx] ?? 0;
          if (v <= 0) continue;
          const i0 = yy * w + xx;
          mask[i0] = Math.max(mask[i0] ?? 0, v);
          mask[i0 + 1] = Math.max(mask[i0 + 1] ?? 0, v);
        }
      }
      r = { width: w, height: h, coverage: mask, left: r.left, top: r.top };
    }
    if (needsSyntheticItalic(cmd.fontStyle, cmd.synthesizeStyle !== false, source.faceItalic?.(glyph.faceIndex) === true) && r.height > 1) {
      let min = 0;
      let max = 0;
      for (let y = 0; y < r.height; y += 1) {
        const s = syntheticItalicShift(y);
        if (s < min) min = s;
        if (s > max) max = s;
      }
      const pad = max - min;
      if (pad !== 0) {
        const width = r.width + pad;
        const coverage = new Float64Array(width * r.height);
        for (let y = 0; y < r.height; y += 1) {
          const dx = syntheticItalicShift(y) - min;
          for (let x = 0; x < r.width; x += 1) {
            coverage[y * width + x + dx] = r.coverage[y * r.width + x] ?? 0;
          }
        }
        r = { width, height: r.height, coverage, left: r.left + min, top: r.top };
      }
    }
    const x = Math.round(Number(cmd.at.x) * pr + Number(glyph.offset.x) * pr + r.left);
    const y = Math.round(baseY + Number(glyph.offset.y) * pr + ascentPx - r.top);
    if (!inClip(x, y, r.width, r.height, clipMaxX, clipMaxY)) continue;
    out.push({
      op: "quad",
      x,
      y,
      w: r.width,
      h: r.height,
      fragment: { kind: "coverage", width: r.width, height: r.height, mask: r.coverage, color: toGpu(cmd.fill) },
    });
  }
}
