/**
 * Tests for the Phase 1 software-raster screenshot backend (task 3.11).
 *
 * Built by `tsc` then run with: `node --test packages/backend/dist/*.test.js`.
 *
 * Covers the task's acceptance points:
 *   - the backend renders a DisplayList of `rect`s into a Surface with correct
 *     pixels (the visible Phase 1 output) — Requirement 14.1;
 *   - clip and layer-opacity commands are honoured;
 *   - the backend's ONLY input is `(DisplayList, Surface)` — it gets NO upstream
 *     IR handle (Requirement 3.5), asserted structurally on the `render`
 *     signature;
 *   - a `text` command (Phase 1 empty glyphs) is a documented no-op.
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { Color, DisplayList, PaintCmd, Rect } from "@browser-engine/ir";
import { px } from "@browser-engine/ir";

import { ScreenshotBackend, type PaintBackend } from "./screenshot.js";
import { createSurface, type Surface } from "./surface.js";

/** Build a frozen DisplayList from a plain command array (mirrors the IR shape). */
function displayList(commands: readonly PaintCmd[]): DisplayList {
  return Object.freeze({ commands: Object.freeze([...commands]) }) as unknown as DisplayList;
}

/** A CSS-pixel rectangle (the IR `Rect` is structurally `{x,y,width,height}`). */
function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height } as unknown as Rect;
}

/** Read pixel `(x, y)` as a 0..255 RGBA tuple. */
function pixelAt(surface: Surface, x: number, y: number): [number, number, number, number] {
  const i = (y * surface.width + x) * 4;
  return [
    surface.pixels[i] as number,
    surface.pixels[i + 1] as number,
    surface.pixels[i + 2] as number,
    surface.pixels[i + 3] as number,
  ];
}

const RED: Color = { r: 255, g: 0, b: 0, a: 1 };
const BLUE: Color = { r: 0, g: 0, b: 255, a: 1 };

void test("renders an opaque rect into the correct pixel region (Req 14.1)", () => {
  const surface = createSurface(10, 10);
  const backend = new ScreenshotBackend();
  backend.render(displayList([{ op: "rect", rect: rect(2, 3, 4, 5), fill: RED }]), surface);

  // Inside the rect: pure red.
  assert.deepEqual(pixelAt(surface, 2, 3), [255, 0, 0, 255]);
  assert.deepEqual(pixelAt(surface, 5, 7), [255, 0, 0, 255]);
  // Just outside the rect (half-open bounds): untouched white background.
  assert.deepEqual(pixelAt(surface, 6, 3), [255, 255, 255, 255]);
  assert.deepEqual(pixelAt(surface, 2, 8), [255, 255, 255, 255]);
  assert.deepEqual(pixelAt(surface, 0, 0), [255, 255, 255, 255]);
});

void test("later rects paint over earlier ones (paint order)", () => {
  const surface = createSurface(8, 8);
  new ScreenshotBackend().render(
    displayList([
      { op: "rect", rect: rect(0, 0, 8, 8), fill: RED },
      { op: "rect", rect: rect(2, 2, 4, 4), fill: BLUE },
    ]),
    surface,
  );
  assert.deepEqual(pixelAt(surface, 0, 0), [255, 0, 0, 255]); // only red here
  assert.deepEqual(pixelAt(surface, 3, 3), [0, 0, 255, 255]); // blue on top
});

void test("alpha-blends a translucent rect over the white background (source-over)", () => {
  const surface = createSurface(4, 4);
  new ScreenshotBackend().render(
    displayList([{ op: "rect", rect: rect(0, 0, 4, 4), fill: { r: 0, g: 0, b: 0, a: 0.5 } }]),
    surface,
  );
  // 0*0.5 + 255*0.5 = 127.5 → Uint8ClampedArray rounds to 128.
  assert.deepEqual(pixelAt(surface, 1, 1), [128, 128, 128, 255]);
});

void test("push-clip restricts subsequent draws; pop-clip restores", () => {
  const surface = createSurface(10, 10);
  new ScreenshotBackend().render(
    displayList([
      { op: "push-clip", rect: rect(0, 0, 5, 5) },
      { op: "rect", rect: rect(0, 0, 10, 10), fill: RED }, // clipped to 5x5
      { op: "pop-clip" },
    ]),
    surface,
  );
  assert.deepEqual(pixelAt(surface, 4, 4), [255, 0, 0, 255]); // inside clip
  assert.deepEqual(pixelAt(surface, 6, 6), [255, 255, 255, 255]); // clipped away
});

void test("push-layer opacity scales subsequent draws' alpha", () => {
  const surface = createSurface(4, 4);
  new ScreenshotBackend().render(
    displayList([
      { op: "push-layer", opacity: 0.5, transform: [1, 0, 0, 1, 0, 0] },
      { op: "rect", rect: rect(0, 0, 4, 4), fill: { r: 0, g: 0, b: 0, a: 1 } },
      { op: "pop-layer" },
    ]),
    surface,
  );
  // opacity 0.5 over white ⇒ 128, same as a 0.5-alpha black fill.
  assert.deepEqual(pixelAt(surface, 0, 0), [128, 128, 128, 255]);
});

void test("a Phase 1 text command (empty glyphs) paints nothing (documented no-op)", () => {
  const surface = createSurface(4, 4);
  new ScreenshotBackend().render(
    displayList([{ op: "text", glyphs: [], at: { x: 0, y: 0 } as Rect, fill: RED, fontSize: px(16) }]),
    surface,
  );
  // The whole surface is still the untouched white background.
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      assert.deepEqual(pixelAt(surface, x, y), [255, 255, 255, 255]);
    }
  }
});

void test("Req 3.5: the backend's render signature takes ONLY (DisplayList, Surface) — no IR handle", () => {
  // Structural proof that the backend boundary admits no upstream IR handle:
  // `PaintBackend.render` is a 2-arity function whose only inputs are the
  // DisplayList and the Surface. There is no parameter through which a
  // FragmentTree/ComputedStyle could be smuggled in.
  const backend: PaintBackend = new ScreenshotBackend();
  assert.equal(backend.render.length, 2);

  // And running it consults nothing but the list it is handed: an empty list
  // leaves the surface at its initial background.
  const surface = createSurface(3, 3);
  backend.render(displayList([]), surface);
  assert.deepEqual(pixelAt(surface, 1, 1), [255, 255, 255, 255]);
});

void test("createSurface clamps degenerate dimensions to at least 1x1", () => {
  const surface = createSurface(0, -5);
  assert.equal(surface.width, 1);
  assert.equal(surface.height, 1);
  assert.equal(surface.pixels.length, 4);
});

// ---------------------------------------------------------------------------
// Real glyph rasterization (M1: visible text via the built-in bitmap font).
// ---------------------------------------------------------------------------

void test("a text command rasterizes a real glyph's coverage into pixels", () => {
  // Glyph id 0x48 = 'H'. At cell width 5 × height 7 (advance 5, fontSize 7) the
  // glyph maps 1 design unit → 1 device pixel, so the inked coverage of 'H' must
  // appear: its top-left pixel (0,0) is inked (left stem), and the cell's
  // top-right interior gap reflects the glyph shape (not a solid block).
  const surface = createSurface(8, 8);
  new ScreenshotBackend().render(
    displayList([
      {
        op: "text",
        glyphs: [{ glyphId: 0x48, advance: px(5), offset: { x: px(0), y: px(0) } }],
        at: { x: px(0), y: px(0) },
        fill: RED,
        fontSize: px(7),
      },
    ]),
    surface,
  );
  // 'H' top row art is "#...#": (0,0) inked, (1..3,0) blank, (4,0) inked.
  assert.deepEqual(pixelAt(surface, 0, 0), [255, 0, 0, 255], "left stem top is inked");
  assert.deepEqual(pixelAt(surface, 4, 0), [255, 0, 0, 255], "right stem top is inked");
  assert.deepEqual(pixelAt(surface, 2, 0), [255, 255, 255, 255], "the gap between stems is NOT inked");
  // Some ink exists overall (the glyph genuinely rasterized).
  let inked = 0;
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      if (pixelAt(surface, x, y)[0] === 255 && pixelAt(surface, x, y)[2] === 0) inked += 1;
    }
  }
  assert.ok(inked >= 10, "'H' inks a substantial number of pixels, not a solid block or nothing");
});

void test("an uncovered glyph id paints nothing (a missing glyph, never a fake block)", () => {
  // U+E000 (a Private Use Area code point) is not in the built-in font.
  const surface = createSurface(8, 8);
  new ScreenshotBackend().render(
    displayList([
      {
        op: "text",
        glyphs: [{ glyphId: 0xe000, advance: px(5), offset: { x: px(0), y: px(0) } }],
        at: { x: px(0), y: px(0) },
        fill: RED,
        fontSize: px(7),
      },
    ]),
    surface,
  );
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      assert.deepEqual(pixelAt(surface, x, y), [255, 255, 255, 255], `(${x},${y}) stays blank`);
    }
  }
});

void test("glyphs are positioned by their offset within the run", () => {
  // Two 'H' glyphs, the second offset right by 5px: ink must appear in both cells.
  const surface = createSurface(16, 8);
  new ScreenshotBackend().render(
    displayList([
      {
        op: "text",
        glyphs: [
          { glyphId: 0x48, advance: px(5), offset: { x: px(0), y: px(0) } },
          { glyphId: 0x48, advance: px(5), offset: { x: px(6), y: px(0) } },
        ],
        at: { x: px(0), y: px(0) },
        fill: BLUE,
        fontSize: px(7),
      },
    ]),
    surface,
  );
  assert.deepEqual(pixelAt(surface, 0, 0), [0, 0, 255, 255], "first glyph inked at x=0");
  assert.deepEqual(pixelAt(surface, 6, 0), [0, 0, 255, 255], "second glyph inked at x=6 (offset)");
});

void test("text rasterization is clipped to the current clip rect", () => {
  // Clip to the left half; a glyph drawn across the boundary only inks inside.
  const surface = createSurface(16, 8);
  new ScreenshotBackend().render(
    displayList([
      { op: "push-clip", rect: { x: px(0), y: px(0), width: px(3), height: px(8) } as unknown as Rect },
      {
        op: "text",
        glyphs: [{ glyphId: 0x48, advance: px(5), offset: { x: px(0), y: px(0) } }],
        at: { x: px(0), y: px(0) },
        fill: RED,
        fontSize: px(7),
      },
      { op: "pop-clip" },
    ]),
    surface,
  );
  assert.deepEqual(pixelAt(surface, 0, 0), [255, 0, 0, 255], "inside the clip: inked");
  assert.deepEqual(pixelAt(surface, 4, 0), [255, 255, 255, 255], "outside the clip: untouched");
});

void test("glyphs are ANTI-ALIASED at non-integer scale (partial-coverage edge pixels)", () => {
  // Scale the 5×7 'H' into a 13×17 cell (advance 13, fontSize 17) — a non-integer
  // per-unit scale, so cell edges straddle device pixels and must produce
  // PARTIAL coverage (alpha-blended grey), not just pure red / pure white.
  const surface = createSurface(20, 20);
  new ScreenshotBackend().render(
    displayList([
      {
        op: "text",
        glyphs: [{ glyphId: 0x48, advance: px(13), offset: { x: px(0), y: px(0) } }],
        at: { x: px(0), y: px(0) },
        fill: { r: 255, g: 0, b: 0, a: 1 },
        fontSize: px(17),
      },
    ]),
    surface,
  );

  let fullInk = 0;
  let partial = 0;
  for (let y = 0; y < 20; y += 1) {
    for (let x = 0; x < 20; x += 1) {
      const [r, g, b] = pixelAt(surface, x, y);
      if (r === 255 && g === 0 && b === 0) fullInk += 1;
      // A blended edge pixel: red bleeding toward white ⇒ g and b lifted off 0
      // but not yet fully white. This is the anti-aliasing signal.
      else if (g > 0 && g < 255 && r === 255) partial += 1;
    }
  }
  assert.ok(fullInk > 0, "the glyph core is fully inked");
  assert.ok(partial > 0, "anti-aliasing produced partial-coverage edge pixels (smooth, not blocky)");
});

void test("coverage rasterization is deterministic (same command ⇒ identical pixels)", () => {
  const cmd: PaintCmd = {
    op: "text",
    glyphs: [{ glyphId: 0x41, advance: px(11), offset: { x: px(0), y: px(0) } }],
    at: { x: px(1), y: px(1) },
    fill: { r: 0, g: 0, b: 0, a: 1 },
    fontSize: px(15),
  } as unknown as PaintCmd;
  const a = createSurface(16, 18);
  const b = createSurface(16, 18);
  new ScreenshotBackend().render(displayList([cmd]), a);
  new ScreenshotBackend().render(displayList([cmd]), b);
  assert.deepEqual([...a.pixels], [...b.pixels]);
});

void test("a layer transform is APPLIED: translate moves the drawn content", () => {
  // Draw a 4×4 red square inside a layer translated by (+4, +4) on a 12×12 canvas.
  const surface = createSurface(12, 12);
  new ScreenshotBackend().render(
    displayList([
      { op: "push-layer", opacity: 1, transform: [1, 0, 0, 1, 4, 4] },
      { op: "rect", rect: rect(0, 0, 4, 4), fill: RED },
      { op: "pop-layer" },
    ]),
    surface,
  );
  // The square now sits at (4,4)..(8,8), NOT at the origin.
  assert.deepEqual(pixelAt(surface, 1, 1), [255, 255, 255, 255], "origin is empty (content moved)");
  assert.deepEqual(pixelAt(surface, 5, 5), [255, 0, 0, 255], "content shifted by the translate");
});

void test("a layer scale transform enlarges the drawn content about the canvas origin", () => {
  // scale(2) about origin: a 3×3 square at the origin covers ~6×6 after scaling.
  const surface = createSurface(16, 16);
  new ScreenshotBackend().render(
    displayList([
      { op: "push-layer", opacity: 1, transform: [2, 0, 0, 2, 0, 0] },
      { op: "rect", rect: rect(0, 0, 3, 3), fill: RED },
      { op: "pop-layer" },
    ]),
    surface,
  );
  // (4,4) is outside the original 3×3 square but inside the 6×6 scaled one,
  // and far enough from the edge to sample pure red — proving the scale applied.
  assert.equal(pixelAt(surface, 4, 4)[0], 255, "scaled content reaches (4,4)");
  assert.equal(pixelAt(surface, 4, 4)[2], 0);
});

void test("filter: grayscale(1) desaturates a layer's pixels", () => {
  const surface = createSurface(6, 6);
  new ScreenshotBackend().render(
    displayList([
      { op: "push-layer", opacity: 1, transform: [1, 0, 0, 1, 0, 0], filter: "grayscale(1)" },
      { op: "rect", rect: rect(0, 0, 6, 6), fill: { r: 255, g: 0, b: 0, a: 1 } },
      { op: "pop-layer" },
    ]),
    surface,
  );
  // Pure red (luma ≈ 54) becomes a neutral grey: r ≈ g ≈ b.
  const [r, g, b] = pixelAt(surface, 3, 3);
  assert.ok(Math.abs(r - g) <= 1 && Math.abs(g - b) <= 1, `grey expected, got ${r},${g},${b}`);
  assert.ok(r > 40 && r < 70, "grey near red's luma");
});

void test("filter: invert(1) inverts a layer's colours", () => {
  const surface = createSurface(4, 4);
  new ScreenshotBackend().render(
    displayList([
      { op: "push-layer", opacity: 1, transform: [1, 0, 0, 1, 0, 0], filter: "invert(1)" },
      { op: "rect", rect: rect(0, 0, 4, 4), fill: { r: 255, g: 0, b: 0, a: 1 } },
      { op: "pop-layer" },
    ]),
    surface,
  );
  // invert(red) = cyan (0, 255, 255).
  assert.deepEqual(pixelAt(surface, 2, 2), [0, 255, 255, 255]);
});

void test("filter: blur spreads a hard square's coverage beyond its edges", () => {
  const surface = createSurface(20, 20);
  new ScreenshotBackend().render(
    displayList([
      { op: "push-layer", opacity: 1, transform: [1, 0, 0, 1, 0, 0], filter: "blur(2px)" },
      { op: "rect", rect: rect(8, 8, 4, 4), fill: { r: 0, g: 0, b: 0, a: 1 } },
      { op: "pop-layer" },
    ]),
    surface,
  );
  // A pixel just OUTSIDE the original 4×4 square now has some ink (blurred edge).
  const [r] = pixelAt(surface, 6, 10);
  assert.ok(r < 255, "blur bled ink outside the original square");
  assert.ok(r > 150, "but it is a soft, partial tint (not full black)");
});
