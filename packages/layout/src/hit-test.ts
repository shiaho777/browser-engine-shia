import type { FragmentTree, NodeId } from "@browser-engine/ir";

export interface HitTestResult {
  readonly node: NodeId;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function hitTest(tree: FragmentTree, x: number, y: number): HitTestResult | null {
  let best: HitTestResult | null = null;
  let bestArea = Number.POSITIVE_INFINITY;
  let bestOrder = -1;
  let order = 0;
  for (const fragment of tree.fragments.values()) {
    const box = fragment.box.borderBox;
    const left = Number(box.x);
    const top = Number(box.y);
    const width = Number(box.width);
    const height = Number(box.height);
    if (width <= 0 || height <= 0) {
      order += 1;
      continue;
    }
    if (x < left || y < top || x >= left + width || y >= top + height) {
      order += 1;
      continue;
    }
    const area = width * height;
    if (best === null || area < bestArea || (area === bestArea && order >= bestOrder)) {
      best = {
        node: fragment.node,
        x: left,
        y: top,
        width,
        height,
      };
      bestArea = area;
      bestOrder = order;
    }
    order += 1;
  }
  return best;
}
