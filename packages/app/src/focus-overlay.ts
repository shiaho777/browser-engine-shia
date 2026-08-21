import type { DomTree, FragmentTree, NodeId } from "@browser-engine/ir";
import { advanceEmForCodePoint, type FontFace } from "@browser-engine/font";
import { pipelineFaces } from "@browser-engine/cli";

export interface EditFocus {
  readonly nodeId: NodeId;
  readonly caret: number;
  readonly selStart: number;
  readonly selEnd: number;
}

export interface RgbaSurface {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8ClampedArray;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function fillRect(
  surface: RgbaSurface,
  x0: number,
  y0: number,
  w: number,
  h: number,
  r: number,
  g: number,
  b: number,
  a: number,
): void {
  const x1 = clamp(Math.floor(x0 + w), 0, surface.width);
  const y1 = clamp(Math.floor(y0 + h), 0, surface.height);
  const xs = clamp(Math.floor(x0), 0, surface.width);
  const ys = clamp(Math.floor(y0), 0, surface.height);
  if (x1 <= xs || y1 <= ys || a <= 0) return;
  for (let y = ys; y < y1; y += 1) {
    let i = (y * surface.width + xs) * 4;
    for (let x = xs; x < x1; x += 1) {
      const inv = 1 - a;
      surface.pixels[i] = r * a + (surface.pixels[i] as number) * inv;
      surface.pixels[i + 1] = g * a + (surface.pixels[i + 1] as number) * inv;
      surface.pixels[i + 2] = b * a + (surface.pixels[i + 2] as number) * inv;
      surface.pixels[i + 3] = 255;
      i += 4;
    }
  }
}

function strokeRect(
  surface: RgbaSurface,
  box: Box,
  thickness: number,
  r: number,
  g: number,
  b: number,
  a: number,
): void {
  const t = Math.max(1, Math.floor(thickness));
  fillRect(surface, box.x, box.y, box.width, t, r, g, b, a);
  fillRect(surface, box.x, box.y + box.height - t, box.width, t, r, g, b, a);
  fillRect(surface, box.x, box.y, t, box.height, r, g, b, a);
  fillRect(surface, box.x + box.width - t, box.y, t, box.height, r, g, b, a);
}

function elementText(dom: DomTree, element: NodeId): string {
  const node = dom.nodes.get(element);
  if (node === undefined) return "";
  if (node.kind === "element" && node.tag === "input") {
    return node.attrs?.get("value") ?? "";
  }
  const parts: string[] = [];
  const visit = (id: NodeId): void => {
    const n = dom.nodes.get(id);
    if (n === undefined) return;
    if (n.kind === "text" && n.text !== undefined) {
      parts.push(n.text);
      return;
    }
    for (const child of n.children) visit(child);
  };
  visit(element);
  return parts.join("");
}

function isDescendantOrSelf(dom: DomTree, node: NodeId, ancestor: NodeId): boolean {
  let cur: NodeId | null = node;
  while (cur !== null) {
    if (cur === ancestor) return true;
    const item = dom.nodes.get(cur);
    if (item === undefined) return false;
    cur = item.parent;
  }
  return false;
}

function borderBoxOf(tree: FragmentTree, dom: DomTree, element: NodeId): Box | null {
  let best: Box | null = null;
  let bestArea = -1;
  for (const fragment of tree.fragments.values()) {
    if (!isDescendantOrSelf(dom, fragment.node, element) && fragment.node !== element) continue;
    if (fragment.node !== element) continue;
    const b = fragment.box.borderBox;
    const box = {
      x: Number(b.x),
      y: Number(b.y),
      width: Number(b.width),
      height: Number(b.height),
    };
    const area = box.width * box.height;
    if (area >= bestArea) {
      best = box;
      bestArea = area;
    }
  }
  if (best !== null) return best;
  for (const fragment of tree.fragments.values()) {
    if (!isDescendantOrSelf(dom, fragment.node, element)) continue;
    const b = fragment.box.borderBox;
    return {
      x: Number(b.x),
      y: Number(b.y),
      width: Math.max(40, Number(b.width)),
      height: Math.max(24, Number(b.height)),
    };
  }
  return null;
}

function contentOrigin(tree: FragmentTree, dom: DomTree, element: NodeId): { x: number; y: number; fontSize: number } | null {
  for (const fragment of tree.fragments.values()) {
    if (!isDescendantOrSelf(dom, fragment.node, element)) continue;
    if (fragment.text === undefined || fragment.text.glyphs.length === 0) continue;
    const c = fragment.box.contentBox;
    return {
      x: Number(c.x),
      y: Number(c.y),
      fontSize: Math.max(12, Number(fragment.text.fontSize)),
    };
  }
  const box = borderBoxOf(tree, dom, element);
  if (box === null) return null;
  return { x: box.x + 8, y: box.y + 6, fontSize: 16 };
}

function measurePrefix(
  text: string,
  caret: number,
  fontSize: number,
  faces: readonly FontFace[],
): { x: number; line: number } {
  const safeCaret = clamp(caret, 0, text.length);
  const prefix = text.slice(0, safeCaret);
  const lines = prefix.split("\n");
  const lineText = lines[lines.length - 1] ?? "";
  let x = 0;
  for (const ch of lineText) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    x += fontSize * advanceEmForCodePoint(faces, cp);
  }
  return { x, line: Math.max(0, lines.length - 1) };
}

function selectionWidth(
  text: string,
  start: number,
  end: number,
  fontSize: number,
  faces: readonly FontFace[],
): number {
  const a = Math.min(start, end);
  const b = Math.max(start, end);
  let w = 0;
  for (const ch of text.slice(a, b)) {
    if (ch === "\n") break;
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    w += fontSize * advanceEmForCodePoint(faces, cp);
  }
  return w;
}

export function paintFocusOverlay(
  surface: RgbaSurface,
  tree: FragmentTree,
  dom: DomTree,
  focus: EditFocus,
  faces: readonly FontFace[] = pipelineFaces,
): void {
  const box = borderBoxOf(tree, dom, focus.nodeId);
  if (box === null) return;
  strokeRect(surface, box, 2, 56, 189, 248, 0.95);
  fillRect(surface, box.x, box.y, box.width, box.height, 56, 189, 248, 0.08);

  const origin = contentOrigin(tree, dom, focus.nodeId);
  if (origin === null) return;
  const text = elementText(dom, focus.nodeId);
  const fontSize = origin.fontSize;
  const lineHeight = fontSize * 1.25;

  const selA = clamp(focus.selStart, 0, text.length);
  const selB = clamp(focus.selEnd, 0, text.length);
  if (selA !== selB) {
    const start = measurePrefix(text, Math.min(selA, selB), fontSize, faces);
    const width = selectionWidth(text, selA, selB, fontSize, faces);
    fillRect(
      surface,
      origin.x + start.x,
      origin.y + start.line * lineHeight,
      Math.max(2, width),
      lineHeight,
      56,
      189,
      248,
      0.35,
    );
  }

  const caret = measurePrefix(text, focus.caret, fontSize, faces);
  const caretX = origin.x + caret.x;
  const caretY = origin.y + caret.line * lineHeight;
  fillRect(surface, caretX, caretY, 2, lineHeight, 248, 250, 252, 0.98);
}

export function normalizeFocus(
  focus: EditFocus,
  textLength: number,
): EditFocus {
  const caret = clamp(focus.caret, 0, textLength);
  const selStart = clamp(focus.selStart, 0, textLength);
  const selEnd = clamp(focus.selEnd, 0, textLength);
  return { nodeId: focus.nodeId, caret, selStart, selEnd };
}
