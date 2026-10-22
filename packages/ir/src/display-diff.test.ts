import assert from "node:assert/strict";
import test from "node:test";

import { px } from "./brand.js";
import type { PaintCmd } from "./display-list.js";
import { diffCommands, paintCmdBounds, paintCmdEqual } from "./display-diff.js";

const R = (x: number, y: number, w: number, h: number) =>
  ({ x: px(x), y: px(y), width: px(w), height: px(h) });
const WHITE = { r: 255, g: 255, b: 255, a: 1 };
const BLACK = { r: 0, g: 0, b: 0, a: 1 };
const VIEWPORT = R(0, 0, 320, 240);

const rect = (x: number, y: number, w: number, h: number, fill = WHITE): PaintCmd =>
  ({ op: "rect", rect: R(x, y, w, h), fill });
const img = (x: number, src: object): PaintCmd =>
  ({
    op: "image",
    rect: R(x, 0, 10, 10),
    src: src as unknown as Extract<PaintCmd, { op: "image" }>["src"],
  });

void test("identical lists diff to no damage", () => {
  const list = [rect(0, 0, 10, 10), rect(20, 20, 10, 10, BLACK)];
  const d = diffCommands(list, list, VIEWPORT);
  assert.equal(d.damage, null);
  assert.equal(d.changed, 0);
});

void test("a mid-list changed rect damages only its old+new bounds", () => {
  const prev = [rect(0, 0, 10, 10), rect(40, 40, 10, 10), rect(200, 200, 10, 10)];
  const next = [rect(0, 0, 10, 10), rect(40, 40, 20, 8, BLACK), rect(200, 200, 10, 10)];
  const d = diffCommands(prev, next, VIEWPORT);
  assert.ok(d.damage !== null);
  // old bound (40,40,10,10) ∪ new bound (40,40,20,8) → (40,40,20,10)
  assert.equal(Number(d.damage.x), 40);
  assert.equal(Number(d.damage.width), 20);
  assert.equal(Number(d.damage.height), 10);
  assert.ok(d.unchanged >= 2 * 2, `prefix+suffix must stay intact, got ${d.unchanged}`);
});

void test("a moved rect damages old and new positions", () => {
  const prev = [rect(0, 0, 10, 10)];
  const next = [rect(100, 100, 10, 10)];
  const d = diffCommands(prev, next, VIEWPORT);
  assert.ok(d.damage !== null);
  assert.equal(Number(d.damage.x), 0); // union starts at the OLD rect
  assert.equal(Number(d.damage.width), 110);
});

void test("a changed push-layer damages the whole unbounded region", () => {
  // Changing the layer's opacity puts a BOUNDLESS envelope op inside the
  // trimmed middle — the union can't bound it, so the viewport is damaged.
  const prev = [
    rect(0, 0, 5, 5),
    { op: "push-layer", opacity: 0.5, transform: [1, 0, 0, 1, 0, 0] } as PaintCmd,
    rect(10, 10, 5, 5),
    { op: "pop-layer" } as PaintCmd,
    rect(200, 200, 5, 5),
  ];
  const next = [
    rect(0, 0, 5, 5),
    { op: "push-layer", opacity: 0.8, transform: [1, 0, 0, 1, 0, 0] } as PaintCmd,
    rect(10, 10, 5, 5),
    { op: "pop-layer" } as PaintCmd,
    rect(200, 200, 5, 5),
  ];
  const d = diffCommands(prev, next, VIEWPORT);
  assert.ok(d.damage !== null);
  assert.equal(Number(d.damage.width), 320); // whole viewport — conservative
});

void test("image commands compare src by identity", () => {
  const src = { width: 1, height: 1, pixels: new Uint8ClampedArray(4) };
  const other = { width: 1, height: 1, pixels: new Uint8ClampedArray(4) };
  assert.ok(paintCmdEqual(img(0, src), img(0, src)));
  assert.ok(!paintCmdEqual(img(0, src), img(0, other)));
});

void test("text bounds cover glyph cells around the pen", () => {
  const text: PaintCmd = {
    op: "text",
    at: { x: px(10), y: px(20) },
    fill: BLACK,
    fontSize: px(10),
    glyphs: [
      { glyphId: 5, faceIndex: 0, advance: px(6), offset: { x: px(0), y: px(0) } },
      { glyphId: 6, faceIndex: 0, advance: px(6), offset: { x: px(6), y: px(-2) } },
    ],
  };
  const b = paintCmdBounds(text);
  assert.ok(b !== null);
  assert.equal(Number(b.x), 10);
  assert.equal(Number(b.y), 18);
  assert.equal(Number(b.width), 12);
});
