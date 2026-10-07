/**
 * Hit-testing over the FragmentTree (Requirement 3.3: geometry has ONE truth
 * source — hit results derive from fragment border boxes and nothing else).
 *
 * The test walks the tree in PAINT ORDER (children after parents, siblings in
 * the fragment's child order — the same order `paint()` emits commands in,
 * including its z-index ordering of positioned children). Later-painted
 * candidates win over earlier ones, and among equal paint order the smallest
 * covering box wins — so an inner box beats its ancestors and a positioned
 * overlay beats the flow content beneath it, matching browser behaviour.
 *
 * `pointer-events: none` (inherited, per CSS) removes a fragment and its
 * subtree from the candidate set entirely.
 *
 * Coordinates are DOCUMENT coordinates (page space, pre-scroll); callers add
 * the current `scrollY` themselves.
 */
import type { ComputedStyle, FragmentTree, NodeId } from "@browser-engine/ir";
import type { Fragment } from "@browser-engine/ir";

export interface HitTestResult {
  readonly node: NodeId;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Narrow the computed `pointer-events` field; absent/invalid ⇒ `"auto"`. */
function pointerEventsOf(style: ComputedStyle | undefined): string {
  if (style === undefined) return "auto";
  const value = style["pointerEvents"];
  return value === "none" ? "none" : "auto";
}

export interface HitTestOptions {
  /** Per-node computed styles; lets the walk honour `pointer-events: none`. */
  readonly styleOf?: (node: NodeId) => ComputedStyle;
}

/**
 * Return the LAST fragment in paint order whose border box covers `(x, y)`,
 * breaking ties toward the smallest box. `null` when nothing covers the point
 * (or every covering fragment is `pointer-events: none`).
 */
export function hitTest(tree: FragmentTree, x: number, y: number, options?: HitTestOptions): HitTestResult | null {
  const styleOf = options?.styleOf;
  let best: HitTestResult | null = null;
  let bestArea = Number.POSITIVE_INFINITY;
  const visit = (fragment: Fragment): void => {
    const style = styleOf?.(fragment.node);
    if (pointerEventsOf(style) === "none") {
      return; // the subtree is transparent to input (CSS pointer-events).
    }
    const box = fragment.box.borderBox;
    const left = Number(box.x);
    const top = Number(box.y);
    const width = Number(box.width);
    const height = Number(box.height);
    if (width > 0 && height > 0 && x >= left && y >= top && x < left + width && y < top + height) {
      const area = width * height;
      // Later paint order always wins (overwrite); among the SAME order the
      // smallest area wins. Tree order = paint order, so plain recursion gives
      // the right precedence without an explicit order counter.
      if (area <= bestArea) {
        best = { node: fragment.node, x: left, y: top, width, height };
        bestArea = area;
      }
    }
    for (const childId of fragment.children) {
      const child = tree.fragments.get(childId);
      if (child !== undefined) visit(child);
    }
  };
  const root = tree.fragments.get(tree.root);
  if (root !== undefined) visit(root);
  return best;
}
