/**
 * gradient-e2e.test.ts — linear-gradient end-to-end through the WHOLE engine:
 * CSS parse → cascade → paint emission → backend rasterization (sampled
 * pixels). Lives in the cli wiring layer (the one place allowed to import
 * every stage).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { ScreenshotBackend, createSurface } from "@browser-engine/backend";
import { FineSession } from "./fine.js";

void test("e2e: a linear-gradient background rasterizes with interpolated pixels", () => {
  const html = [
    "<style>",
    "div { width: 200px; height: 100px; background-image: linear-gradient(to right, red, blue) }",
    "</style>",
    "<div></div>",
  ].join("");
  const session = new FineSession(html);
  const list = session.render();

  // The paint stage emits exactly one gradient command with the parsed stops.
  const gradientCmds = list.commands.filter((c) => c.op === "gradient");
  assert.equal(gradientCmds.length, 1, "one gradient command");
  const cmd = gradientCmds[0]!;
  assert.equal(cmd.op === "gradient" ? cmd.angle : null, 90, "to right = 90deg");

  // The backend rasterizes it; sample near the gradient's ends and middle.
  const surface = createSurface(800, 600);
  new ScreenshotBackend().render(list, surface);
  const px = (x: number, y: number): number[] => {
    const i = (y * 800 + x) * 4;
    return [surface.pixels[i]!, surface.pixels[i + 1]!, surface.pixels[i + 2]!, surface.pixels[i + 3]!];
  };
  // The div starts at body margin x=8; sample inside it near the ends + middle.
  const left = px(9, 50);
  const middle = px(108, 50);
  const right = px(206, 50);
  assert.ok(left[0]! > 200 && left[1]! < 30 && left[2]! < 30, `left is red: ${JSON.stringify(left)}`);
  assert.ok(right[2]! > 200 && right[0]! < 30, `right is blue: ${JSON.stringify(right)}`);
  assert.ok(
    Math.abs(middle[0]! - middle[2]!) < 20 && middle[0]! > 100 && middle[0]! < 160,
    `middle is the red/blue mix: ${JSON.stringify(middle)}`,
  );
});

void test("e2e: a vertical multi-stop gradient rasterizes top→middle→bottom", () => {
  const html = [
    "<style>",
    "div { width: 100px; height: 90px; background-image: linear-gradient(red, yellow 50%, blue) }",
    "</style>",
    "<div></div>",
  ].join("");
  const session = new FineSession(html);
  const list = session.render();
  const surface = createSurface(800, 600);
  new ScreenshotBackend().render(list, surface);
  const px = (x: number, y: number): number[] => {
    const i = (y * 800 + x) * 4;
    return [surface.pixels[i]!, surface.pixels[i + 1]!, surface.pixels[i + 2]!];
  };
  // The div starts at y=8 (body margin): top ≈ red, middle ≈ yellow, bottom ≈ blue.
  const top = px(50, 10);
  const middle = px(50, 53);
  const bottom = px(50, 95);
  assert.ok(top[0]! > 200 && top[1]! < 60, `top is red: ${JSON.stringify(top)}`);
  assert.ok(middle[0]! > 180 && middle[1]! > 180 && middle[2]! < 80, `middle is yellow: ${JSON.stringify(middle)}`);
  assert.ok(bottom[2]! > 180 && bottom[1]! < 80, `bottom is blue: ${JSON.stringify(bottom)}`);
});
