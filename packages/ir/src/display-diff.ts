/**
 * Stage 5b: display-list DIFFING — the paint-invalidation input for the
 * retained-surface rasterizer (RFC 0039).
 *
 * Two consecutive display lists for the same document+scroll state are
 * compared command-by-command. The longest identical prefix and suffix are
 * trimmed; the remaining middle ranges are the changed span. Their paint
 * bounds union into the damage rect the rasterizer must repair — every
 * command outside the union could not have produced different pixels.
 *
 * Honest model, deliberately conservative:
 *  - `image`/`tile` commands compare `src` by IDENTITY. Engines mint a fresh
 *    `DecodedImage` when pixels change (canvas rasterize returns a new object
 *    when dirty; media materializes a new frame per timestamp), so identity
 *    change ⇒ changed pixels. A mutable-in-place bitmap would defeat this —
 *    no producer does that.
 *  - Commands with no paint bound (`pop-clip`, `push-layer`, `pop-layer`)
 *    found inside the changed span damage the whole unbounded region the
 *    caller supplies — a changed clip/layer envelope can redirect output far
 *    from its own origin.
 *  - This is a prefix/suffix trim, NOT a full LCS — a mid-list insertion
 *    realigns via the suffix, but an arbitrary shuffle damages the union of
 *    both middles. Over-damage is always safe.
 */
import type { Matrix, PaintCmd } from "./display-list.js";
import type { Point, Rect } from "./geometry.js";
import type { Color, Edges, Px } from "./values.js";

/** Paint bounds of one command — `null` ⇒ unbounded (conservative). */
export function paintCmdBounds(cmd: PaintCmd): Rect | null {
  switch (cmd.op) {
    case "rect":
    case "border":
    case "image":
    case "linear-gradient":
    case "radial-gradient":
      return cmd.rect;
    case "tile":
      return cmd.area;
    case "push-clip":
      return cmd.rect;
    case "text":
      return textBounds(cmd);
    case "line": {
      const half = Number(cmd.width) / 2;
      const x0 = Math.min(Number(cmd.from.x), Number(cmd.to.x)) - half;
      const y0 = Math.min(Number(cmd.from.y), Number(cmd.to.y)) - half;
      const x1 = Math.max(Number(cmd.from.x), Number(cmd.to.x)) + half;
      const y1 = Math.max(Number(cmd.from.y), Number(cmd.to.y)) + half;
      return { x: x0 as Rect["x"], y: y0 as Rect["y"], width: x1 - x0 as Rect["width"], height: y1 - y0 as Rect["height"] };
    }
    case "pop-clip":
    case "push-layer":
    case "pop-layer":
      return null;
  }
}

function textBounds(cmd: Extract<PaintCmd, { op: "text" }>): Rect | null {
  if (cmd.glyphs.length === 0) return null;
  const ax = Number(cmd.at.x);
  const ay = Number(cmd.at.y);
  const fs = Number(cmd.fontSize);
  let x0 = 0;
  let y0 = 0;
  let x1 = 0;
  let y1 = 0;
  for (const g of cmd.glyphs) {
    const gx = Number(g.offset.x);
    const gy = Number(g.offset.y);
    x0 = Math.min(x0, gx);
    y0 = Math.min(y0, gy);
    x1 = Math.max(x1, gx + Math.max(Number(g.advance), fs * 0.5));
    y1 = Math.max(y1, gy + fs);
  }
  return {
    x: (ax + x0) as Rect["x"],
    y: (ay + y0) as Rect["y"],
    width: (x1 - x0) as Rect["width"],
    height: (y1 - y0) as Rect["height"],
  };
}

/** Deep equality between two paint commands. */
export function paintCmdEqual(a: PaintCmd, b: PaintCmd): boolean {
  if (a.op !== b.op) return false;
  switch (a.op) {
    case "rect": {
      const c = b as Extract<PaintCmd, { op: "rect" }>;
      return eqRect(a.rect, c.rect) && eqColor(a.fill, c.fill) && a.radius === c.radius;
    }
    case "border": {
      const c = b as Extract<PaintCmd, { op: "border" }>;
      return (
        eqRect(a.rect, c.rect) &&
        a.radius === c.radius &&
        eqEdges(a.edges, c.edges)
      );
    }
    case "text": {
      const c = b as Extract<PaintCmd, { op: "text" }>;
      if (
        !eqPoint(a.at, c.at) ||
        !eqColor(a.fill, c.fill) ||
        a.fontSize !== c.fontSize ||
        a.fontWeight !== c.fontWeight ||
        a.fontStyle !== c.fontStyle ||
        a.synthesizeBold !== c.synthesizeBold ||
        a.synthesizeStyle !== c.synthesizeStyle ||
        a.glyphs.length !== c.glyphs.length
      ) {
        return false;
      }
      for (let i = 0; i < a.glyphs.length; i += 1) {
        const ga = a.glyphs[i] as (typeof a.glyphs)[number];
        const gb = c.glyphs[i] as (typeof c.glyphs)[number];
        if (
          ga.glyphId !== gb.glyphId ||
          ga.faceIndex !== gb.faceIndex ||
          ga.advance !== gb.advance ||
          ga.offset.x !== gb.offset.x ||
          ga.offset.y !== gb.offset.y
        ) {
          return false;
        }
      }
      return true;
    }
    case "line": {
      const c = b as Extract<PaintCmd, { op: "line" }>;
      return eqPoint(a.from, c.from) && eqPoint(a.to, c.to) && eqColor(a.fill, c.fill) && a.width === c.width;
    }
    case "linear-gradient": {
      const c = b as Extract<PaintCmd, { op: "linear-gradient" }>;
      if (!eqRect(a.rect, c.rect) || a.angle !== c.angle || a.stops.length !== c.stops.length) return false;
      for (let i = 0; i < a.stops.length; i += 1) {
        const sa = a.stops[i]!;
        const sb = c.stops[i]!;
        if (sa.offset !== sb.offset || !eqColor(sa.color, sb.color)) return false;
      }
      return true;
    }
    case "radial-gradient": {
      const c = b as Extract<PaintCmd, { op: "radial-gradient" }>;
      if (!eqRect(a.rect, c.rect) || a.stops.length !== c.stops.length) return false;
      for (let i = 0; i < a.stops.length; i += 1) {
        const sa = a.stops[i]!;
        const sb = c.stops[i]!;
        if (sa.offset !== sb.offset || !eqColor(sa.color, sb.color)) return false;
      }
      return true;
    }
    case "image": {
      const c = b as Extract<PaintCmd, { op: "image" }>;
      // `src` compares by IDENTITY — see the file header. Equal-identity
      // images are the same bitmap; different identity could still decode
      // equal but we cannot prove it, so it counts as changed.
      return eqRect(a.rect, c.rect) && a.src === c.src && a.radius === c.radius;
    }
    case "tile": {
      const c = b as Extract<PaintCmd, { op: "tile" }>;
      return (
        eqRect(a.area, c.area) &&
        a.src === c.src &&
        a.tile.width === c.tile.width &&
        a.tile.height === c.tile.height &&
        eqPoint(a.origin, c.origin) &&
        a.step.x === c.step.x &&
        a.step.y === c.step.y &&
        a.repeatX === c.repeatX &&
        a.repeatY === c.repeatY &&
        a.radius === c.radius
      );
    }
    case "push-clip": {
      const c = b as Extract<PaintCmd, { op: "push-clip" }>;
      return eqRect(a.rect, c.rect) && a.radius === c.radius;
    }
    case "pop-clip":
    case "pop-layer":
      return true;
    case "push-layer": {
      const c = b as Extract<PaintCmd, { op: "push-layer" }>;
      return a.opacity === c.opacity && eqMatrix(a.transform, c.transform) && a.filter === c.filter;
    }
  }
}

export interface ListDiff {
  /**
   * Union of the changed commands' paint bounds — `null` when the lists are
   * identical (no repaint needed at all). May equal `unbounded` when the
   * changed span contains envelope commands whose effect can't be bounded.
   */
  readonly damage: Rect | null;
  /** Commands aligned identical in the trimmed prefix+suffix. */
  readonly unchanged: number;
  /** Commands inside the changed spans (prev + next). */
  readonly changed: number;
}

/**
 * Diff two command lists; `unbounded` is the rect unbounded commands damage
 * (the caller passes the viewport). Screen-space of the list coordinates.
 */
export function diffCommands(
  prev: readonly PaintCmd[],
  next: readonly PaintCmd[],
  unbounded: Rect,
): ListDiff {
  let lo = 0;
  const minLen = Math.min(prev.length, next.length);
  while (lo < minLen && paintCmdEqual(prev[lo] as PaintCmd, next[lo] as PaintCmd)) lo += 1;
  let hiPrev = prev.length;
  let hiNext = next.length;
  while (
    hiPrev > lo &&
    hiNext > lo &&
    paintCmdEqual(prev[hiPrev - 1] as PaintCmd, next[hiNext - 1] as PaintCmd)
  ) {
    hiPrev -= 1;
    hiNext -= 1;
  }
  const changed = hiPrev - lo + (hiNext - lo);
  const unchanged = prev.length + next.length - changed;
  if (changed === 0) return { damage: null, unchanged, changed: 0 };
  let damage: Rect | null = null;
  const acc = (cmd: PaintCmd): void => {
    const b = paintCmdBounds(cmd);
    damage = unionRect(damage, b ?? unbounded);
  };
  for (let i = lo; i < hiPrev; i += 1) acc(prev[i] as PaintCmd);
  for (let i = lo; i < hiNext; i += 1) acc(next[i] as PaintCmd);
  return { damage, unchanged, changed };
}

export function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (a === null) return b;
  if (b === null) return a;
  const x0 = Math.min(Number(a.x), Number(b.x));
  const y0 = Math.min(Number(a.y), Number(b.y));
  const x1 = Math.max(Number(a.x) + Number(a.width), Number(b.x) + Number(b.width));
  const y1 = Math.max(Number(a.y) + Number(a.height), Number(b.y) + Number(b.height));
  return { x: x0 as Rect["x"], y: y0 as Rect["y"], width: (x1 - x0) as Rect["width"], height: (y1 - y0) as Rect["height"] };
}

function eqRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
function eqPoint(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y;
}
function eqColor(a: Color, b: Color): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
}
function eqEdges(a: Edges<BorderSideLike>, b: Edges<BorderSideLike>): boolean {
  return eqSide(a.top, b.top) && eqSide(a.right, b.right) && eqSide(a.bottom, b.bottom) && eqSide(a.left, b.left);
}
type BorderSideLike = { readonly width: Px; readonly style: string; readonly color: Color };
function eqSide(a: BorderSideLike, b: BorderSideLike): boolean {
  return a.width === b.width && a.style === b.style && eqColor(a.color, b.color);
}
function eqMatrix(a: Matrix, b: Matrix): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3] && a[4] === b[4] && a[5] === b[5];
}
