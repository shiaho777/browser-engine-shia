/**
 * Skia backend tests: per-op correctness PLUS a differential suite against the
 * CPU {@link ScreenshotBackend} oracle — the same honesty pattern as
 * `gpu-render.test.ts`. The Skia path is the production rasterizer (RFC 0001);
 * the CPU path is the correctness oracle.
 *
 * Tolerance policy (stated, not hidden):
 *   - Axis-aligned, integer-bound solid fills are bit-exact between engines
 *     (full coverage at pixel-grid boundaries) → diff tolerance 0.
 *   - Antialiased edges (rounded corners, strokes) and text legitimately differ:
 *     Skia's analytic AA / FreeType scaler vs the scanline coverage rasterizer →
 *     channel tolerance 32, and diffs must stay a small fraction of the image.
 *   - Layer composites/opacity round through premultiplied paths differently →
 *     channel tolerance 4.
 *
 * Built by `tsc` then run with: `node --test packages/backend/dist/*.test.js`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { Color, DisplayList, DecodedImage, PaintCmd, Rect } from "@browser-engine/ir";
import { px } from "@browser-engine/ir";
import { builtinFont } from "@browser-engine/font";

import { ScreenshotBackend } from "./screenshot.js";
import { createSurface, type Surface } from "./surface.js";
import { createSkiaBackend, type SkiaBackend } from "./skia.js";

/** The REAL glyph id of `cp` in the default face table (`[builtinFont]`, faceIndex 0). */
function gidOf(cp: number): number {
  return builtinFont().glyphIdForCodePoint(cp);
}

function displayList(commands: readonly PaintCmd[]): DisplayList {
  return Object.freeze({ commands: Object.freeze([...commands]) }) as unknown as DisplayList;
}
function rect(x: number, y: number, w: number, h: number): Rect {
  return { x: px(x), y: px(y), width: px(w), height: px(h) };
}
const RED: Color = { r: 255, g: 0, b: 0, a: 1 };
const BLUE: Color = { r: 0, g: 0, b: 255, a: 1 };
const BLACK: Color = { r: 0, g: 0, b: 0, a: 1 };
const GREEN: Color = { r: 0, g: 128, b: 0, a: 1 };

/** Count pixels differing by more than `tol` on any channel. */
function diffCount(a: Surface, b: Surface, tol: number): number {
  let diff = 0;
  for (let i = 0; i < a.pixels.length; i += 4) {
    for (let k = 0; k < 4; k += 1) {
      if (Math.abs((a.pixels[i + k] as number) - (b.pixels[i + k] as number)) > tol) {
        diff += 1;
        break;
      }
    }
  }
  return diff;
}

/** Count pixels whose channels moved away from the white background. */
function inkedCount(s: Surface): number {
  let n = 0;
  for (let i = 0; i < s.pixels.length; i += 4) {
    if (
      (s.pixels[i] as number) < 240 ||
      (s.pixels[i + 1] as number) < 240 ||
      (s.pixels[i + 2] as number) < 240
    ) {
      n += 1;
    }
  }
  return n;
}

function cpu(list: DisplayList, w: number, h: number): Surface {
  const s = createSurface(w, h);
  new ScreenshotBackend().render(list, s);
  return s;
}

async function skia(list: DisplayList, w: number, h: number): Promise<Surface> {
  const backend = await createSkiaBackend();
  const s = createSurface(w, h);
  backend.render(list, s);
  return s;
}

// ---------------------------------------------------------------------------
// Differential parity: geometry
// ---------------------------------------------------------------------------

void test("Skia renders solid rects bit-exactly like the CPU oracle", async () => {
  const list = displayList([
    { op: "rect", rect: rect(2, 2, 30, 20), fill: RED },
    { op: "rect", rect: rect(10, 10, 20, 10), fill: BLUE },
  ]);
  const a = cpu(list, 40, 30);
  const b = await skia(list, 40, 30);
  assert.equal(diffCount(a, b, 0), 0, "integer-bound solid fills are pixel-identical");
});

void test("Skia renders four-edge borders matching the CPU oracle", async () => {
  const list = displayList([
    { op: "rect", rect: rect(4, 4, 30, 20), fill: RED },
    {
      op: "border",
      rect: rect(4, 4, 30, 20),
      edges: {
        top: { width: px(2), style: "solid", color: BLACK },
        right: { width: px(3), style: "solid", color: GREEN },
        bottom: { width: px(2), style: "solid", color: BLACK },
        left: { width: px(1), style: "none", color: BLACK },
      },
    },
  ]);
  const a = cpu(list, 40, 30);
  const b = await skia(list, 40, 30);
  assert.equal(diffCount(a, b, 0), 0, "solid edge fills are pixel-identical");
});

void test("Skia honours clip: nothing paints outside the clip rect", async () => {
  const list = displayList([
    { op: "push-clip", rect: rect(8, 8, 16, 16) },
    { op: "rect", rect: rect(0, 0, 40, 40), fill: RED },
    { op: "pop-clip" },
  ]);
  const b = await skia(list, 40, 40);
  // Outside the clip must remain white.
  const corner = (1 * 40 + 1) * 4;
  assert.equal(b.pixels[corner + 1], 255, "outside-clip pixel untouched");
  const inside = (16 * 40 + 16) * 4;
  assert.equal(b.pixels[inside], 255, "inside-clip pixel is red");
  assert.equal(b.pixels[inside + 1], 0);
});

void test("Skia honours a rounded clip (AA corners are a stated tolerance)", async () => {
  const list = displayList([
    { op: "push-clip", rect: rect(4, 4, 32, 32), radius: px(8) },
    { op: "rect", rect: rect(0, 0, 40, 40), fill: BLUE },
    { op: "pop-clip" },
  ]);
  const a = cpu(list, 40, 40);
  const b = await skia(list, 40, 40);
  const diff = diffCount(a, b, 32);
  assert.ok(diff < 40, `rounded-corner AA delta stays small (diff=${diff})`);
  assert.ok(inkedCount(b) > 500, "the clipped disc visibly painted");
});

// ---------------------------------------------------------------------------
// Differential parity: compositing
// ---------------------------------------------------------------------------

void test("Skia composites an opacity layer like the CPU oracle", async () => {
  const list = displayList([
    { op: "rect", rect: rect(0, 0, 40, 40), fill: BLUE },
    { op: "push-layer", opacity: 0.5, transform: [1, 0, 0, 1, 0, 0] },
    { op: "rect", rect: rect(10, 10, 20, 20), fill: RED },
    { op: "pop-layer" },
  ]);
  const a = cpu(list, 40, 40);
  const b = await skia(list, 40, 40);
  // Half-strength red over blue: both engines land within a rounding step.
  assert.ok(diffCount(a, b, 4) === 0, "opacity composite matches within rounding");
});

void test("Skia applies a translate layer transform", async () => {
  const list = displayList([
    { op: "push-layer", opacity: 1, transform: [1, 0, 0, 1, 5, 0] },
    { op: "rect", rect: rect(0, 0, 4, 4), fill: RED },
    { op: "pop-layer" },
  ]);
  const a = cpu(list, 40, 40);
  const b = await skia(list, 40, 40);
  // Integer translation is bit-exact even through different sampling paths.
  assert.equal(diffCount(a, b, 0), 0, "integer-translated layer composite is identical");
});

// ---------------------------------------------------------------------------
// Text — real glyph rasterization through Skia's FreeType scaler
// ---------------------------------------------------------------------------

void test("Skia rasterizes real glyphs (ink present where the run draws)", async () => {
  const list = displayList([
    {
      op: "text",
      at: { x: px(4), y: px(4) },
      fill: BLACK,
      fontSize: px(16),
      glyphs: [
        { glyphId: gidOf(72), faceIndex: 0, advance: px(10), offset: { x: px(0), y: px(0) } }, // 'H'
        { glyphId: gidOf(105), faceIndex: 0, advance: px(5), offset: { x: px(10), y: px(0) } }, // 'i'
      ],
    },
  ]);
  const a = cpu(list, 40, 24);
  const b = await skia(list, 40, 24);
  assert.ok(inkedCount(b) > 10, "Skia drew glyph ink");
  // Same font bytes, different AA engine: diff exists but stays small.
  const diff = diffCount(a, b, 32);
  assert.ok(diff < inkedCount(b) * 4, `text AA delta bounded (diff=${diff})`);
});

// ---------------------------------------------------------------------------
// New capability: `line` (text-decoration) — the oracle cannot render it
// ---------------------------------------------------------------------------

void test("Skia renders line commands the CPU oracle rejects", async () => {
  const list = displayList([
    { op: "line", from: { x: px(4), y: px(10) }, to: { x: px(36), y: px(10) }, fill: BLACK, width: px(1) },
  ]);
  // The documented coverage gap: the CPU oracle throws on `line`.
  assert.throws(() => cpu(list, 40, 20), /unsupported PaintCmd: "line"/);
  const b = await skia(list, 40, 20);
  let darkRow = -1;
  for (let y = 0; y < 20 && darkRow < 0; y += 1) {
    const i = (y * 40 + 20) * 4;
    if ((b.pixels[i] as number) < 128) darkRow = y;
  }
  assert.ok(darkRow >= 9 && darkRow <= 11, `1px stroke lands at y≈10 (got row ${darkRow})`);
});

// ---------------------------------------------------------------------------
// Filters on composited layers
// ---------------------------------------------------------------------------

void test("Skia applies a grayscale layer filter within tolerance", async () => {
  const list = displayList([
    { op: "push-layer", opacity: 1, transform: [1, 0, 0, 1, 0, 0], filter: "grayscale(1)" },
    { op: "rect", rect: rect(4, 4, 16, 16), fill: RED },
    { op: "pop-layer" },
  ]);
  const a = cpu(list, 40, 40);
  const b = await skia(list, 40, 40);
  const i = (10 * 40 + 10) * 4;
  // Grayscale red → equal channels (~76 luminance either way).
  assert.ok(
    Math.abs((b.pixels[i] as number) - (b.pixels[i + 1] as number)) < 8,
    "filtered pixel is achromatic",
  );
  assert.ok(diffCount(a, b, 32) < 64, "grayscale result tracks the oracle's luminance");
});

void test("Skia applies a blur filter (soft edges exist)", async () => {
  const list = displayList([
    { op: "push-layer", opacity: 1, transform: [1, 0, 0, 1, 0, 0], filter: "blur(2px)" },
    { op: "rect", rect: rect(10, 10, 20, 20), fill: RED },
    { op: "pop-layer" },
  ]);
  const b = await skia(list, 40, 40);
  // A blurred rect bleeds colour past its edge (x=30): partially-inked pixel.
  const bleed = (20 * 40 + 31) * 4;
  const g = b.pixels[bleed + 1] as number;
  assert.ok(g < 250 && g > 5, `blur softens the edge (green=${g})`);
});

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

void test("Skia blits a decoded image like the CPU oracle", async () => {
  const img: DecodedImage = {
    width: 4,
    height: 4,
    pixels: new Uint8ClampedArray(4 * 4 * 4).fill(255),
  };
  for (let i = 0; i < img.pixels.length; i += 4) {
    img.pixels[i] = 0;
    img.pixels[i + 1] = 200;
    img.pixels[i + 2] = 0;
  }
  const list = displayList([{ op: "image", rect: rect(8, 8, 4, 4), src: img }]);
  const a = cpu(list, 24, 24);
  const b = await skia(list, 24, 24);
  assert.equal(diffCount(a, b, 0), 0, "1:1 image blit is identical");
});

// ---------------------------------------------------------------------------
// Contract shape
// ---------------------------------------------------------------------------

void test("SkiaBackend implements the same synchronous PaintBackend contract", async () => {
  const backend: SkiaBackend = await createSkiaBackend();
  const s = createSurface(16, 16);
  backend.render(displayList([{ op: "rect", rect: rect(0, 0, 8, 8), fill: RED }]), s);
  assert.equal(s.pixels[(4 * 16 + 4) * 4], 255);
});

void test("Skia draws a `tile` command identically to the CPU oracle (RFC 0008)", async () => {
  const img: DecodedImage = {
    width: 2,
    height: 2,
    pixels: new Uint8ClampedArray([
      255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255, 255, 0, 0, 255,
    ]),
  };
  const list = displayList([
    {
      op: "tile",
      area: rect(1, 1, 10, 6),
      src: img,
      tile: { width: px(2), height: px(2) },
      origin: { x: px(-1), y: px(0) },
      step: { x: px(2), y: px(2) },
      repeatX: true,
      repeatY: true,
    },
  ]);
  const a = cpu(list, 16, 10);
  const b = await skia(list, 16, 10);
  assert.equal(diffCount(a, b, 0), 0, "integer-scale tiling is bit-exact");
});
