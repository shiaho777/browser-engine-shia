/**
 * Tests for the reftest (screenshot) harness (task 1.8).
 *
 * Built by `tsc` then run with: `node --test packages/test-harness/dist/*.test.js`.
 *
 * Covers design.md §9.1 and Requirement 10.4 — comparing a rendered PNG against
 * a reference image within the *configured* pixel-difference threshold:
 *   - identical images pass (threshold 0, exact match);
 *   - images differing within the configured threshold pass (absolute & ratio);
 *   - images exceeding the configured threshold fail;
 *   - colour tolerance absorbs small per-channel noise;
 *   - mismatched dimensions surface a loud, descriptive error;
 *   - the PNG codec round-trips across every scanline filter and color type so
 *     the diff operates on real decoded pixels (not a stub).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { decodePng, encodePng, type RawImage } from "./png.js";
import {
  compareRawImages,
  compareReftest,
  DimensionMismatchError,
  diffRawImages,
} from "./reftest.js";

/** Build a solid-colour RGBA image. */
function solid(width: number, height: number, rgba: readonly [number, number, number, number]): RawImage {
  const data = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p += 1) {
    data[p * 4] = rgba[0];
    data[p * 4 + 1] = rgba[1];
    data[p * 4 + 2] = rgba[2];
    data[p * 4 + 3] = rgba[3];
  }
  return { width, height, data };
}

/** A small deterministic gradient image, useful for round-trip/filter tests. */
function gradient(width: number, height: number): RawImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      data[i] = (x * 7 + y * 3) & 0xff;
      data[i + 1] = (x * 13 + y * 5) & 0xff;
      data[i + 2] = (x * 17 + y * 11) & 0xff;
      data[i + 3] = (x + y) % 5 === 0 ? 200 : 255;
    }
  }
  return { width, height, data };
}

/** Copy an image and flip `n` pixels to a clearly different colour. */
function withDifferingPixels(base: RawImage, n: number): RawImage {
  const data = base.data.slice();
  for (let p = 0; p < n; p += 1) {
    const i = p * 4;
    data[i] = data[i] === 0 ? 255 : 0;
    data[i + 1] = 255 - (data[i + 1] as number);
    data[i + 2] = 255 - (data[i + 2] as number);
    data[i + 3] = 255;
  }
  return { width: base.width, height: base.height, data };
}

void test("identical images pass with an exact (zero) threshold", () => {
  const img = gradient(16, 12);
  const png = encodePng(img);
  const result = compareReftest(png, png);
  assert.equal(result.pass, true);
  assert.equal(result.diffPixels, 0);
  assert.equal(result.totalPixels, 16 * 12);
  assert.equal(result.diffRatio, 0);
});

void test("Req 10.4: images differing within the configured absolute threshold pass", () => {
  const ref = solid(20, 10, [10, 20, 30, 255]);
  const rendered = withDifferingPixels(ref, 5);

  // 5 differing pixels, allowance of 5 → pass.
  const within = compareReftest(encodePng(rendered), encodePng(ref), { maxDiffPixels: 5 });
  assert.equal(within.diffPixels, 5);
  assert.equal(within.allowedDiffPixels, 5);
  assert.equal(within.pass, true);
});

void test("Req 10.4: images exceeding the configured threshold fail", () => {
  const ref = solid(20, 10, [10, 20, 30, 255]);
  const rendered = withDifferingPixels(ref, 6);

  // 6 differing pixels, allowance of 5 → fail.
  const exceeds = compareReftest(encodePng(rendered), encodePng(ref), { maxDiffPixels: 5 });
  assert.equal(exceeds.diffPixels, 6);
  assert.equal(exceeds.allowedDiffPixels, 5);
  assert.equal(exceeds.pass, false);
});

void test("Req 10.4: the threshold is configurable as a ratio of total pixels", () => {
  const ref = solid(10, 10, [0, 0, 0, 255]); // 100 pixels
  const rendered = withDifferingPixels(ref, 3);

  // 3% differ; 5% allowed → pass.
  const pass = compareReftest(encodePng(rendered), encodePng(ref), { maxDiffRatio: 0.05 });
  assert.equal(pass.diffPixels, 3);
  assert.equal(pass.allowedDiffPixels, 5);
  assert.equal(pass.pass, true);

  // 3% differ; 2% allowed → fail.
  const fail = compareReftest(encodePng(rendered), encodePng(ref), { maxDiffRatio: 0.02 });
  assert.equal(fail.allowedDiffPixels, 2);
  assert.equal(fail.pass, false);
});

void test("absolute and ratio thresholds combine to the more permissive bound", () => {
  const ref = solid(10, 10, [0, 0, 0, 255]); // 100 pixels
  const rendered = withDifferingPixels(ref, 4);

  // ratio 0.02 → 2 px, absolute 5 → 5 px; effective allowance = max(2,5) = 5.
  const result = compareReftest(encodePng(rendered), encodePng(ref), {
    maxDiffPixels: 5,
    maxDiffRatio: 0.02,
  });
  assert.equal(result.allowedDiffPixels, 5);
  assert.equal(result.pass, true);
});

void test("default threshold requires an exact match", () => {
  const ref = solid(8, 8, [100, 100, 100, 255]);
  const rendered = withDifferingPixels(ref, 1);
  const result = compareReftest(encodePng(rendered), encodePng(ref));
  assert.equal(result.allowedDiffPixels, 0);
  assert.equal(result.pass, false);
});

void test("colorTolerance absorbs small per-channel noise", () => {
  const ref = solid(8, 8, [100, 100, 100, 255]);
  // Nudge every pixel by 2 on one channel.
  const data = ref.data.slice();
  for (let p = 0; p < 8 * 8; p += 1) data[p * 4] = 102;
  const rendered: RawImage = { width: 8, height: 8, data };

  // tolerance 1 → all pixels count as different → fail at exact threshold.
  const strict = compareRawImages(rendered, ref, { colorTolerance: 1 });
  assert.equal(strict.diffPixels, 64);
  assert.equal(strict.pass, false);

  // tolerance 2 → within noise → no diffs → pass.
  const lenient = compareRawImages(rendered, ref, { colorTolerance: 2 });
  assert.equal(lenient.diffPixels, 0);
  assert.equal(lenient.pass, true);
});

void test("mismatched dimensions raise a descriptive DimensionMismatchError", () => {
  const a = encodePng(solid(4, 4, [0, 0, 0, 255]));
  const b = encodePng(solid(4, 5, [0, 0, 0, 255]));
  assert.throws(() => compareReftest(a, b), DimensionMismatchError);
  assert.throws(
    () => diffRawImages(solid(4, 4, [0, 0, 0, 255]), solid(5, 4, [0, 0, 0, 255])),
    /dimension mismatch/,
  );
});

void test("PNG codec round-trips RGBA across every scanline filter", () => {
  const img = gradient(9, 7);
  for (const filter of [0, 1, 2, 3, 4] as const) {
    const decoded = decodePng(encodePng(img, { filter }));
    assert.equal(decoded.width, img.width);
    assert.equal(decoded.height, img.height);
    assert.deepEqual(decoded.data, img.data, `filter ${filter} must round-trip`);
  }
});

void test("decodePng rejects non-PNG input loudly", () => {
  assert.throws(() => decodePng(Uint8Array.from([1, 2, 3])), /invalid PNG/);
});
