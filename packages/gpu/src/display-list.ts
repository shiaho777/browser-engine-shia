/**
 * display-list.ts — bridge the engine's paint {@link DisplayList} into a GPU
 * {@link CommandBuffer}, so the renderer can submit real engine output to a GPU
 * device (software, multi-core, or — at the same seam — hardware WebGPU).
 *
 * This maps the `rect` fills (the backbone of backgrounds/shadows) to solid
 * quads over a white clear. Text/border/clip/layer ops are richer fixed-plus-
 * programmable work; they map onto further GPU passes (documented next step),
 * not fabricated here. Imports only the frozen IR.
 */
import type { Color, DisplayList } from "@browser-engine/ir";

import type { CommandBuffer, GpuColor, GpuCommand } from "./pipeline.js";

const WHITE: GpuColor = { r: 255, g: 255, b: 255, a: 1 };

/** Convert an IR {@link Color} (alpha 0..1) to a {@link GpuColor}. */
function toGpuColor(c: Color): GpuColor {
  return { r: c.r, g: c.g, b: c.b, a: c.a };
}

/**
 * Build a GPU command buffer from a {@link DisplayList}: a white clear followed
 * by one solid quad per `rect` command (in paint order). Non-`rect` commands
 * are skipped (their GPU passes are a documented follow-on, not faked).
 */
export function displayListToCommandBuffer(
  list: DisplayList,
  width: number,
  height: number,
): CommandBuffer {
  const commands: GpuCommand[] = [{ op: "clear", color: WHITE }];
  for (const cmd of list.commands) {
    if (cmd.op === "rect") {
      commands.push({
        op: "quad",
        x: Number(cmd.rect.x),
        y: Number(cmd.rect.y),
        w: Number(cmd.rect.width),
        h: Number(cmd.rect.height),
        fragment: { kind: "solid", color: toGpuColor(cmd.fill) },
      });
    }
  }
  return { width, height, commands };
}
