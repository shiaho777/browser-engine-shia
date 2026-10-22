/**
 * RFC 0039: retained-surface partial repaint — a damaged display list renders
 * into the PREVIOUS frame's pixel buffer, restricted to the damage rect, and
 * produces byte-identical output to a full render of the new list.
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { DisplayList, PaintCmd, Rect } from "@browser-engine/ir";
import { px } from "@browser-engine/ir";

import { renderDisplayListOnGpu } from "./gpu-render.js";

function displayList(commands: readonly PaintCmd[]): DisplayList {
  return Object.freeze({ commands: Object.freeze([...commands]) }) as unknown as DisplayList;
}
function rect(x: number, y: number, w: number, h: number): Rect {
  return { x: px(x), y: px(y), width: px(w), height: px(h) };
}
const RED = { r: 255, g: 0, b: 0, a: 1 };
const GREEN = { r: 0, g: 200, b: 0, a: 1 };
const BLUE = { r: 0, g: 0, b: 255, a: 1 };

function pixelsEqual(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

void test("changed rect repaints into the retained buffer — identical to a full render", () => {
  const w = 64;
  const h = 40;
  const prevList = displayList([
    { op: "rect", rect: rect(0, 0, 64, 8), fill: GREEN },
    { op: "rect", rect: rect(10, 12, 20, 10), fill: BLUE },
    { op: "rect", rect: rect(0, 32, 64, 8), fill: GREEN },
  ]);
  const first = renderDisplayListOnGpu(prevList, w, h);
  const nextList = displayList([
    { op: "rect", rect: rect(0, 0, 64, 8), fill: GREEN },
    { op: "rect", rect: rect(10, 12, 20, 10), fill: RED }, // colour change only
    { op: "rect", rect: rect(0, 32, 64, 8), fill: GREEN },
  ]);
  const partial = renderDisplayListOnGpu(nextList, w, h, undefined, {
    damage: rect(10, 12, 20, 10),
    into: first.pixels,
  });
  assert.ok(partial.pixels === first.pixels, "repairs in place, same buffer");
  const fresh = renderDisplayListOnGpu(nextList, w, h);
  assert.ok(pixelsEqual(partial.pixels, fresh.pixels), "partial == full render");
});

void test("a REMOVED rect clears its old bounds inside the damage rect", () => {
  const w = 32;
  const h = 32;
  const prevList = displayList([{ op: "rect", rect: rect(4, 4, 16, 16), fill: BLUE }]);
  const first = renderDisplayListOnGpu(prevList, w, h);
  const nextList = displayList([]);
  const partial = renderDisplayListOnGpu(nextList, w, h, undefined, {
    damage: rect(4, 4, 16, 16),
    into: first.pixels,
  });
  const fresh = renderDisplayListOnGpu(nextList, w, h);
  assert.ok(pixelsEqual(partial.pixels, fresh.pixels), "vanished content clears to background");
});

void test("an opacity layer's composite is scissored — partial == full", () => {
  const w = 48;
  const h = 48;
  const layer = (inner: PaintCmd): PaintCmd[] => [
    { op: "push-layer", opacity: 0.5, transform: [1, 0, 0, 1, 0, 0] },
    inner,
    { op: "pop-layer" },
  ];
  const prevList = displayList([
    ...layer({ op: "rect", rect: rect(8, 8, 16, 16), fill: BLUE }),
    { op: "rect", rect: rect(30, 30, 10, 10), fill: GREEN },
  ]);
  const first = renderDisplayListOnGpu(prevList, w, h);
  const nextList = displayList([
    ...layer({ op: "rect", rect: rect(8, 8, 16, 16), fill: RED }),
    { op: "rect", rect: rect(30, 30, 10, 10), fill: GREEN },
  ]);
  const partial = renderDisplayListOnGpu(nextList, w, h, undefined, {
    damage: rect(8, 8, 16, 16),
    into: first.pixels,
  });
  const fresh = renderDisplayListOnGpu(nextList, w, h);
  assert.ok(pixelsEqual(partial.pixels, fresh.pixels), "layer content repairs inside damage");
});

void test("a transformed layer DROPS the damage hint — full render, still correct", () => {
  const w = 48;
  const h = 48;
  const rotate: PaintCmd = {
    op: "push-layer",
    opacity: 0.9,
    transform: [0, -1, 1, 0, 20, 0],
  };
  const prevList = displayList([rotate, { op: "rect", rect: rect(4, 4, 8, 8), fill: BLUE }, { op: "pop-layer" }]);
  const first = renderDisplayListOnGpu(prevList, w, h);
  const nextList = displayList([rotate, { op: "rect", rect: rect(4, 4, 8, 8), fill: GREEN }, { op: "pop-layer" }]);
  // Damage is a lie here (transformed output lands outside it) — the executor
  // must refuse the hint and repaint the full frame into the retained buffer.
  const partial = renderDisplayListOnGpu(nextList, w, h, undefined, {
    damage: rect(4, 4, 8, 8),
    into: first.pixels,
  });
  const fresh = renderDisplayListOnGpu(nextList, w, h);
  assert.ok(pixelsEqual(partial.pixels, fresh.pixels), "transform layers force a full render");
});

void test("the damage scissor never writes outside its rect", () => {
  const w = 32;
  const h = 32;
  const list = displayList([{ op: "rect", rect: rect(0, 0, 32, 32), fill: BLUE }]);
  const junk = new Uint8ClampedArray(w * h * 4).fill(7);
  renderDisplayListOnGpu(list, w, h, undefined, { damage: rect(4, 4, 8, 8), into: junk });
  let outsideChanged = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (x >= 4 && x < 12 && y >= 4 && y < 12) continue;
      if (junk[(y * w + x) * 4] !== 7) outsideChanged += 1;
    }
  }
  assert.equal(outsideChanged, 0, "no pixel outside the damage rect was touched");
});

void test("no `into` buffer with a damage hint → clean full render", () => {
  const list = displayList([{ op: "rect", rect: rect(2, 2, 8, 8), fill: RED }]);
  const s = renderDisplayListOnGpu(list, 24, 24, undefined, { damage: rect(2, 2, 8, 8) });
  const fresh = renderDisplayListOnGpu(list, 24, 24);
  assert.ok(pixelsEqual(s.pixels, fresh.pixels));
});
