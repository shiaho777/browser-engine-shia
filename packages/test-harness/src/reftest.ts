/**
 * Reftest (screenshot) harness — task 1.8.
 *
 * design.md §9.1 ("截图(reftest)测试") and Requirement 10.4:
 *   "WHEN a reftest runs, THE Engine SHALL compare the rendered PNG against its
 *    reference image within the configured pixel-difference threshold."
 *
 * This module decodes a rendered PNG and a reference PNG into raw RGBA pixels,
 * counts how many pixels differ beyond a per-channel colour tolerance, and
 * decides pass/fail against a *configurable* threshold. The threshold can be
 * expressed either as an absolute pixel count or as a fraction of total pixels,
 * so callers can tune sensitivity per baseline (the "configured threshold").
 *
 * The comparison is the real thing: actual PNG decode + per-pixel diff. The
 * Phase 1 `<div>hello</div>` baseline (Requirement 14.3) consumes this API.
 */
import { decodePng, type RawImage } from "./png.js";

/**
 * Configuration for a single reftest comparison.
 *
 * Exactly the threshold knobs are configurable (Requirement 10.4). All fields
 * are optional; sensible defaults make an exact-match comparison.
 */
export interface ReftestOptions {
  /**
   * Maximum number of differing pixels allowed for the test to still pass, as
   * an ABSOLUTE count. A value of 0 means the images must match exactly.
   * Mutually combinable with {@link maxDiffRatio}: if both are given, the
   * effective allowance is the larger of the two (the more permissive bound).
   * Defaults to 0 when neither absolute nor ratio threshold is supplied.
   */
  readonly maxDiffPixels?: number;
  /**
   * Maximum fraction (0..1) of differing pixels allowed for the test to pass,
   * relative to the total pixel count. Example: 0.01 allows up to 1% of pixels
   * to differ. Combined with {@link maxDiffPixels} as described above.
   */
  readonly maxDiffRatio?: number;
  /**
   * Per-channel colour tolerance (0..255). Two pixels are considered "the same"
   * when every RGBA channel differs by at most this amount. Lets anti-aliasing
   * / rounding noise pass without inflating the diff count. Defaults to 0
   * (a pixel differs if any channel differs at all).
   */
  readonly colorTolerance?: number;
}

/** Result of a reftest comparison. */
export interface ReftestResult {
  /** Whether the rendered image matched the reference within the threshold. */
  readonly pass: boolean;
  /** Number of pixels that differed beyond {@link ReftestOptions.colorTolerance}. */
  readonly diffPixels: number;
  /** Total number of pixels compared (width * height). */
  readonly totalPixels: number;
  /** Fraction of pixels that differed (diffPixels / totalPixels), 0 when empty. */
  readonly diffRatio: number;
  /** The effective absolute allowance the result was judged against. */
  readonly allowedDiffPixels: number;
  /** Image dimensions that were compared. */
  readonly width: number;
  readonly height: number;
}

/** Thrown when two images cannot be compared because their sizes differ. */
export class DimensionMismatchError extends Error {
  readonly rendered: { readonly width: number; readonly height: number };
  readonly reference: { readonly width: number; readonly height: number };

  constructor(rendered: RawImage, reference: RawImage) {
    super(
      `reftest dimension mismatch: rendered ${rendered.width}x${rendered.height} ` +
        `vs reference ${reference.width}x${reference.height}`,
    );
    this.name = "DimensionMismatchError";
    this.rendered = { width: rendered.width, height: rendered.height };
    this.reference = { width: reference.width, height: reference.height };
  }
}

/**
 * Count the pixels that differ between two equally-sized RGBA rasters, where a
 * pixel "differs" when any channel differs by more than `colorTolerance`.
 *
 * @throws DimensionMismatchError if the rasters have different dimensions.
 */
export function diffRawImages(
  rendered: RawImage,
  reference: RawImage,
  colorTolerance = 0,
): number {
  if (rendered.width !== reference.width || rendered.height !== reference.height) {
    throw new DimensionMismatchError(rendered, reference);
  }
  const a = rendered.data;
  const b = reference.data;
  const pixels = rendered.width * rendered.height;
  let diff = 0;
  for (let p = 0; p < pixels; p += 1) {
    const i = p * 4;
    const dr = Math.abs((a[i] as number) - (b[i] as number));
    const dg = Math.abs((a[i + 1] as number) - (b[i + 1] as number));
    const db = Math.abs((a[i + 2] as number) - (b[i + 2] as number));
    const da = Math.abs((a[i + 3] as number) - (b[i + 3] as number));
    if (dr > colorTolerance || dg > colorTolerance || db > colorTolerance || da > colorTolerance) {
      diff += 1;
    }
  }
  return diff;
}

/** Resolve the absolute pixel allowance from the (possibly partial) options. */
function resolveAllowance(totalPixels: number, options: ReftestOptions): number {
  const { maxDiffPixels, maxDiffRatio } = options;
  const hasAbsolute = maxDiffPixels !== undefined;
  const hasRatio = maxDiffRatio !== undefined;

  const absolute = maxDiffPixels !== undefined ? Math.max(0, Math.floor(maxDiffPixels)) : 0;
  const fromRatio =
    maxDiffRatio !== undefined ? Math.floor(clamp01(maxDiffRatio) * totalPixels) : 0;

  if (hasAbsolute && hasRatio) return Math.max(absolute, fromRatio);
  if (hasAbsolute) return absolute;
  if (hasRatio) return fromRatio;
  return 0; // neither configured → exact match required.
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Compare two already-decoded rasters against a configurable threshold.
 *
 * @throws DimensionMismatchError if the images differ in size.
 */
export function compareRawImages(
  rendered: RawImage,
  reference: RawImage,
  options: ReftestOptions = {},
): ReftestResult {
  const totalPixels = rendered.width * rendered.height;
  const diffPixels = diffRawImages(rendered, reference, options.colorTolerance ?? 0);
  const allowedDiffPixels = resolveAllowance(totalPixels, options);
  const diffRatio = totalPixels === 0 ? 0 : diffPixels / totalPixels;
  return {
    pass: diffPixels <= allowedDiffPixels,
    diffPixels,
    totalPixels,
    diffRatio,
    allowedDiffPixels,
    width: rendered.width,
    height: rendered.height,
  };
}

/**
 * Compare a rendered PNG against a reference PNG within a configurable
 * pixel-difference threshold (Requirement 10.4).
 *
 * @param renderedPng raw bytes of the freshly rendered PNG.
 * @param referencePng raw bytes of the stored reference (baseline) PNG.
 * @param options threshold configuration; see {@link ReftestOptions}.
 * @returns a {@link ReftestResult} describing the comparison and its verdict.
 * @throws DimensionMismatchError if the two images have different dimensions.
 */
export function compareReftest(
  renderedPng: Uint8Array,
  referencePng: Uint8Array,
  options: ReftestOptions = {},
): ReftestResult {
  const rendered = decodePng(renderedPng);
  const reference = decodePng(referencePng);
  return compareRawImages(rendered, reference, options);
}
