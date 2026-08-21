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
import type { Color, DisplayList, PaintCmd } from "@browser-engine/ir";
import {
  renderProgram,
  type DisplayCommand,
  type GpuColor,
  type GpuSurface,
} from "@browser-engine/gpu";
import type { GlyphCoverageSource } from "@browser-engine/font";

import { builtinFont, coverageSource } from "@browser-engine/font";

const DEFAULT_SOURCE: GlyphCoverageSource = coverageSource(builtinFont());
const WHITE: GpuColor = { r: 255, g: 255, b: 255, a: 1 };

function toGpu(c: Color): GpuColor {
  return { r: c.r, g: c.g, b: c.b, a: c.a };
}

/** Render a DisplayList through the GPU compositor into an RGBA surface. */
export function renderDisplayListOnGpu(
  list: DisplayList,
  width: number,
  height: number,
  glyphSource: GlyphCoverageSource = DEFAULT_SOURCE,
  options?: { readonly clipMaxY?: number; readonly clipMaxX?: number; readonly pixelRatio?: number },
): GpuSurface {
  const prRaw = options?.pixelRatio ?? 1;
  const pr = Number.isFinite(prRaw) ? Math.max(1, Math.min(3, prRaw)) : 1;
  const outW = Math.max(1, Math.round(width * pr));
  const outH = Math.max(1, Math.round(height * pr));
  const commands: DisplayCommand[] = [];
  const clipMaxY = (options?.clipMaxY ?? height) * pr;
  const clipMaxX = (options?.clipMaxX ?? width) * pr;
  for (const cmd of list.commands) {
    translate(cmd, commands, glyphSource, clipMaxX, clipMaxY, pr);
  }
  return renderProgram({ width: outW, height: outH, background: WHITE, commands });
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
  glyphSource: GlyphCoverageSource,
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
      translateText(cmd, out, glyphSource, clipMaxX, clipMaxY, pr);
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
  source: GlyphCoverageSource,
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
    const gid = source.glyphId(glyph.glyphId);
    if (gid === 0) continue;
    let r = source.raster(gid, fontSize);
    if (r.width === 0 || r.height === 0) continue;
    if (weight >= 500) {
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
