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
): GpuSurface {
  const commands: DisplayCommand[] = [];
  for (const cmd of list.commands) {
    translate(cmd, commands, glyphSource);
  }
  return renderProgram({ width, height, background: WHITE, commands });
}

function translate(cmd: PaintCmd, out: DisplayCommand[], glyphSource: GlyphCoverageSource): void {
  switch (cmd.op) {
    case "rect":
      out.push({
        op: "quad",
        x: Number(cmd.rect.x),
        y: Number(cmd.rect.y),
        w: Number(cmd.rect.width),
        h: Number(cmd.rect.height),
        fragment: { kind: "solid", color: toGpu(cmd.fill) },
      });
      return;
    case "border":
      translateBorder(cmd, out);
      return;
    case "text":
      translateText(cmd, out, glyphSource);
      return;
    case "image":
      out.push({
        op: "quad",
        x: Number(cmd.rect.x),
        y: Number(cmd.rect.y),
        w: Number(cmd.rect.width),
        h: Number(cmd.rect.height),
        fragment: {
          kind: "image",
          width: cmd.src.width,
          height: cmd.src.height,
          rgba: cmd.src.pixels,
        },
      });
      return;
    case "push-clip":
      out.push({ op: "push-clip", x: Number(cmd.rect.x), y: Number(cmd.rect.y), w: Number(cmd.rect.width), h: Number(cmd.rect.height) });
      return;
    case "pop-clip":
      out.push({ op: "pop-clip" });
      return;
    case "push-layer":
      out.push({
        op: "push-layer",
        opacity: cmd.opacity,
        transform: cmd.transform,
        ...(cmd.filter !== undefined ? { filter: cmd.filter } : {}),
      });
      return;
    case "pop-layer":
      out.push({ op: "pop-layer" });
      return;
  }
}
function translateBorder(cmd: Extract<PaintCmd, { op: "border" }>, out: DisplayCommand[]): void {
  const x0 = Math.round(Number(cmd.rect.x));
  const y0 = Math.round(Number(cmd.rect.y));
  const x1 = Math.round(Number(cmd.rect.x) + Number(cmd.rect.width));
  const y1 = Math.round(Number(cmd.rect.y) + Number(cmd.rect.height));
  const top = Math.round(Number(cmd.edges.top.width));
  const right = Math.round(Number(cmd.edges.right.width));
  const bottom = Math.round(Number(cmd.edges.bottom.width));
  const left = Math.round(Number(cmd.edges.left.width));
  const edge = (drawn: boolean, color: Color, x: number, y: number, w: number, h: number): void => {
    if (!drawn || w <= 0 || h <= 0) return;
    out.push({ op: "quad", x, y, w, h, fragment: { kind: "solid", color: toGpu(color) } });
  };
  edge(cmd.edges.top.style !== "none" && top > 0, cmd.edges.top.color, x0, y0, x1 - x0, top);
  edge(cmd.edges.bottom.style !== "none" && bottom > 0, cmd.edges.bottom.color, x0, y1 - bottom, x1 - x0, bottom);
  edge(cmd.edges.left.style !== "none" && left > 0, cmd.edges.left.color, x0, y0, left, y1 - y0);
  edge(cmd.edges.right.style !== "none" && right > 0, cmd.edges.right.color, x1 - right, y0, right, y1 - y0);
}

/** One coverage-shaded quad per glyph (the GPU text path). */
function translateText(
  cmd: Extract<PaintCmd, { op: "text" }>,
  out: DisplayCommand[],
  source: GlyphCoverageSource,
): void {
  const fontSize = Number(cmd.fontSize);
  if (fontSize <= 0) return;
  const ascentPx = source.ascentEm * fontSize;
  for (const glyph of cmd.glyphs) {
    const gid = source.glyphId(glyph.glyphId);
    if (gid === 0) continue;
    const r = source.raster(gid, fontSize);
    if (r.width === 0 || r.height === 0) continue;
    const x = Math.round(Number(cmd.at.x) + Number(glyph.offset.x) + r.left);
    const y = Math.round(Number(cmd.at.y) + Number(glyph.offset.y) + ascentPx - r.top);
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
