/**
 * Block formatting context (RFC 0003) — the first-class owner of the two kinds
 * of state CSS 2.1 §9.4.1 attaches to a BFC:
 *
 *   - the **float registry** — every float's margin-box rectangle, recorded in
 *     BFC coordinates (anchored at the BFC root's content-box origin), so any
 *     descendant participating in this BFC can query intrusion at its own
 *     position; and
 *   - the **margin-collapse chain** — a run of adjoining vertical margins,
 *     folded pairwise by {@link collapseMargins}.
 *
 * A `layoutBlock` that does not establish a BFC SHARES its parent's instance,
 * so floats floated by ancestor siblings keep intruding into its line boxes;
 * a BFC-establishing block opens a fresh one and the registry stops there —
 * which is exactly what a formatting-context boundary means.
 */

/** A float's margin-box rect in BFC coordinates (y1 exclusive). */
export interface FloatRect {
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
  readonly side: "left" | "right";
}

/** The collapsed value of a run of adjoining margins (CSS 2.1 §8.3.1): the
 * largest positive margin plus the most-negative negative margin. */
export function collapseMargins(...margins: readonly number[]): number {
  let pos = 0;
  let neg = 0;
  for (const m of margins) {
    if (m > pos) pos = m;
    if (m < neg) neg = m;
  }
  return pos + neg;
}

export class BlockFormattingContext {
  private readonly floats: FloatRect[] = [];

  /**
   * The free horizontal interval at BFC-y inside `[x0, x1]`, after clipping
   * out every float spanning that y. Left-edge floats push `x0` right,
   * right-edge floats pull `x1` left; an interior float (a float contained
   * by a narrower nested block) yields to whichever side keeps the wider
   * gap.
   */
  intrusion(y: number, x0: number, x1: number): { x0: number; x1: number } {
    let lo = x0;
    let hi = x1;
    for (const f of this.floats) {
      if (!(f.y0 <= y && y < f.y1)) continue;
      if (f.x0 <= lo) {
        lo = Math.max(lo, f.x1);
      } else if (f.x1 >= hi) {
        hi = Math.min(hi, f.x0);
      } else if (f.x0 - lo >= hi - f.x1) {
        hi = Math.min(hi, f.x0);
      } else {
        lo = Math.max(lo, f.x1);
      }
    }
    if (hi < lo) hi = lo;
    return { x0: lo, x1: hi };
  }

  /** The BFC-y at which `clear` must place a box (0 when nothing to clear). */
  clearanceY(clear: string): number {
    let bottom = 0;
    for (const f of this.floats) {
      const matches =
        clear === "both" ||
        clear === "inline-start" ||
        clear === "inline-end" ||
        f.side === clear;
      if (matches) bottom = Math.max(bottom, f.y1);
    }
    return bottom;
  }

  /** The deepest float bottom — a BFC grows to contain its floats. */
  floatsBottom(): number {
    let bottom = 0;
    for (const f of this.floats) bottom = Math.max(bottom, f.y1);
    return bottom;
  }

  /**
   * The earliest BFC-y ≥ `minY` where a `w`-wide box inside `[cx0, cx1]`
   * fits beside the floats — descending past expiring float bottoms when the
   * current y cannot hold it (the spec's fit-or-drop rule).
   */
  fitY(minY: number, w: number, cx0: number, cx1: number): number {
    let y = minY;
    for (let guard = 0; guard <= this.floats.length; guard += 1) {
      const free = this.intrusion(y, cx0, cx1);
      if (free.x1 - free.x0 >= w) return y;
      let next = Number.POSITIVE_INFINITY;
      for (const f of this.floats) {
        if (f.y1 > y) next = Math.min(next, f.y1);
      }
      if (!Number.isFinite(next)) return y;
      y = next;
    }
    return y;
  }

  /**
   * Place a float's margin box against the containing block's content edges
   * `[cx0, cx1]` at the earliest legal y ≥ `minY`; registers the rect.
   */
  placeFloat(
    side: "left" | "right",
    w: number,
    h: number,
    minY: number,
    cx0: number,
    cx1: number,
  ): { x: number; y: number } {
    const y = this.fitY(minY, w, cx0, cx1);
    const free = this.intrusion(y, cx0, cx1);
    const x = side === "left" ? free.x0 : free.x1 - w;
    this.floats.push({ x0: x, x1: x + w, y0: y, y1: y + h, side });
    return { x, y };
  }
}
