/**
 * Synthetic-bold decision shared by every raster backend (RFC 0006).
 *
 * `font-synthesis` allows the run (`synthesisAllowed`), the run asks for a
 * bold-ish weight (`>= 500`, matching the historical fake-bold band), and the
 * face the shaper selected genuinely lacks that weight — a real bold face is
 * never emboldened twice.
 */
export function needsSyntheticBold(
  requestedWeight: number | undefined,
  faceWeight: number | undefined,
  synthesisAllowed: boolean,
): boolean {
  const weight = requestedWeight ?? 400;
  return synthesisAllowed && weight >= 500 && (faceWeight ?? 400) < weight;
}

/**
 * Synthetic italic. `italic` and `oblique` shear by the same amount the canvas
 * text path uses (`setSkewX(-0.2)`). `font-synthesis` without `style` suppresses
 * it. A face that is already italic is not detected here.
 */
export function needsSyntheticItalic(
  style: string | undefined,
  synthesisAllowed: boolean,
  faceItalic = false,
): boolean {
  return synthesisAllowed && !faceItalic && (style === "italic" || style === "oblique");
}

/** Horizontal pixel shift of one coverage row under `setSkewX(-0.2)`. Row 0 is the top. */
export function syntheticItalicShift(rowFromTop: number): number {
  const shift = Math.round(-0.2 * rowFromTop);
  return shift === 0 ? 0 : shift;
}
