/**
 * gradient.ts — `linear-gradient()` parsing for the paint stage (CSS Images §4).
 *
 * The computed `background-image` is a string row (opaque at cascade time);
 * the paint stage resolves the FIRST layer's `linear-gradient(...)` here into
 * a typed value the display list can carry: the gradient angle (normalized to
 * degrees clockwise from "to top") and the color stops (positions normalized
 * to `[0,1]`, even distribution when the author omits them).
 *
 * Anything unparseable returns `null` — the caller simply does not paint a
 * gradient (the same recovery a browser shows for an invalid declaration).
 */
import type { Color } from "@browser-engine/ir";

/** The parsed shape of one `linear-gradient()`. */
export interface LinearGradient {
  /** Degrees clockwise from "to top" (0 = up, 90 = right, 180 = down). */
  readonly angle: number;
  /** Color stops ordered by position; the first is at 0, the last at 1. */
  readonly stops: readonly { readonly color: Color; readonly position: number }[];
}

/**
 * Parse the first `linear-gradient(...)` in a `background-image` value.
 * Grammar (the dominant real-world subset):
 *
 *   linear-gradient( [<angle> | to <side-or-corner>]?, <color-stop>[, <color-stop>]+ )
 *   angle          := <number>deg
 *   side-or-corner := left | right | top | bottom (one or two, e.g. `to top left`)
 *   color-stop     := <color> [ <percentage> | <length> ]?
 *
 * `%` positions map to `[0,1]` directly; a bare `<length>` is px scaled by the
 * gradient-line length the PAINTER knows (the rect), so this parser emits it
 * as a px marker the caller converts; lengths are rare and fall back to even
 * distribution when the caller cannot scale them.
 */
export function parseLinearGradient(value: string): LinearGradient | null {
  const idx = value.indexOf("linear-gradient(");
  if (idx === -1) return null;
  // Find the matching close paren of the gradient function.
  let depth = 0;
  let end = -1;
  for (let i = idx + "linear-gradient(".length - 1; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;
  const inner = value.slice(idx + "linear-gradient(".length, end);
  const parts = splitTopLevel(inner);
  if (parts.length < 2) return null;

  // The first part is the direction when it is an angle or `to <side>`.
  let angle = 180; // CSS default: "to bottom".
  let start = 0;
  const first = parts[0]!.trim();
  const angleMatch = /^([+-]?\d+(?:\.\d+)?)deg$/i.exec(first);
  const toMatch = /^to\s+([a-z\s]+)$/i.exec(first);
  if (angleMatch !== null) {
    angle = Number(angleMatch[1]);
    start = 1;
  } else if (toMatch !== null) {
    const dir = keywordsToAngle(toMatch[1]!.trim().toLowerCase());
    if (dir === null) return null;
    angle = dir;
    start = 1;
  }

  // Color stops: `<color> [pos]?` each; positions may be `%` or px.
  const rawStops: { color: string; pos: string | null }[] = [];
  for (let i = start; i < parts.length; i += 1) {
    const part = parts[i]!.trim();
    const m = /^(.+?)\s+(.+)$/.exec(part);
    if (m !== null) {
      rawStops.push({ color: m[1]!.trim(), pos: m[2]!.trim() });
    } else {
      rawStops.push({ color: part, pos: null });
    }
  }
  if (rawStops.length < 2) return null;

  // Normalize positions to plain numbers, then distribute the omitted ones:
  // (1) % → [0,1]; px lengths scale against a 400px reference (rare in real
  //     stylesheets; the gradient-line-relative exact scale needs the rect).
  // (2) CSS Images §4: the first stop sits at 0 and the last at 1 when the
  //     author omits their positions.
  // (3) Omitted MIDDLE stops distribute evenly between their defined
  //     neighbors.
  const positions: (number | null)[] = rawStops.map((s) => {
    if (s.pos === null) return null;
    if (s.pos.endsWith("%")) {
      const n = Number(s.pos.slice(0, -1));
      return Number.isFinite(n) ? n / 100 : null;
    }
    if (/px$/i.test(s.pos)) {
      const n = Number(s.pos.slice(0, -2));
      return Number.isFinite(n) ? Math.min(1, Math.max(0, n / 400)) : null;
    }
    return null;
  });
  if (positions.length > 0 && positions[0] === null) positions[0] = 0;
  if (positions.length > 1 && positions[positions.length - 1] === null) {
    positions[positions.length - 1] = 1;
  }
  for (let i = 0; i < positions.length; i += 1) {
    if (positions[i] !== null) continue;
    // The previous defined stop (always exists: index 0 is defined).
    let prev = i - 1;
    while (prev >= 0 && positions[prev] === null) prev -= 1;
    // The next defined stop (always exists: the last is defined).
    let next = i + 1;
    while (next < positions.length && positions[next] === null) next += 1;
    const prevPos = (positions[prev] as number) ?? 0;
    const nextPos = (positions[next] as number) ?? 1;
    const span = next - prev || 1;
    positions[i] = prevPos + ((nextPos - prevPos) * (i - prev)) / span;
  }

  const stops: { color: Color; position: number }[] = [];
  for (let i = 0; i < rawStops.length; i += 1) {
    const color = parseCssColor(rawStops[i]!.color);
    if (color === null) return null;
    stops.push({ color, position: Math.min(1, Math.max(0, positions[i] ?? 0)) });
  }
  // The endpoints always touch 0 and 1 (CSS Images §4).
  stops[0] = { ...stops[0]!, position: 0 };
  stops[stops.length - 1] = { ...stops[stops.length - 1]!, position: 1 };
  return { angle, stops };
}

/** `to top` → 0, `to right` → 90, corners → 45/135/225/315; null if invalid. */
function keywordsToAngle(keywords: string): number | null {
  const parts = keywords.split(/\s+/).filter((p) => p.length > 0);
  if (parts.length < 1 || parts.length > 2) return null;
  const valid = new Set(["top", "bottom", "left", "right"]);
  for (const p of parts) {
    if (!valid.has(p)) return null;
  }
  if (parts.length === 1) {
    switch (parts[0]) {
      case "top": return 0;
      case "right": return 90;
      case "bottom": return 180;
      case "left": return 270;
    }
  }
  // A corner: one vertical + one horizontal side.
  const vert = parts.find((p) => p === "top" || p === "bottom");
  const horiz = parts.find((p) => p === "left" || p === "right");
  if (vert === undefined || horiz === undefined) return null;
  if (vert === "top") return horiz === "right" ? 45 : 315;
  return horiz === "right" ? 135 : 225;
}

/** Split on top-level commas (respecting nested parens). */
function splitTopLevel(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of inner) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) out.push(current);
  return out;
}

/** A pragmatic CSS color parser for gradient stops (named/hex/rgb[a]). */
export function parseCssColor(input: string): Color | null {
  const v = input.trim().toLowerCase();
  if (v.length === 0) return null;
  // Hex.
  if (v.startsWith("#")) {
    const hex = v.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const [r = "", g = "", b = "", a = "f"] = [...hex];
      return {
        r: parseInt(r + r, 16),
        g: parseInt(g + g, 16),
        b: parseInt(b + b, 16),
        a: parseInt(a + a, 16) / 255,
      };
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
      if ([r, g, b, a * 255].every((n) => Number.isFinite(n))) {
        return { r, g, b, a };
      }
    }
    return null;
  }
  // rgb()/rgba().
  if (/^rgba?\(/.test(v) && v.endsWith(")")) {
    const parts = v
      .slice(v.indexOf("(") + 1, -1)
      .split(/[\s,/]+/)
      .filter((p) => p.length > 0)
      .map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
      const [r, g, b, a = 1] = parts as [number, number, number, number?];
      return {
        r: Math.max(0, Math.min(255, Math.round(r))),
        g: Math.max(0, Math.min(255, Math.round(g))),
        b: Math.max(0, Math.min(255, Math.round(b))),
        a: Math.max(0, Math.min(1, a)),
      };
    }
    return null;
  }
  // Extended named colors (the paint stage's common set).
  const named = NAMED_COLORS[v];
  return named === undefined ? null : named;
}

/** Named colors beyond the runtime parser's six (the high-frequency tail). */
const NAMED_COLORS: Readonly<Record<string, Color>> = {
  black: { r: 0, g: 0, b: 0, a: 1 },
  white: { r: 255, g: 255, b: 255, a: 1 },
  red: { r: 255, g: 0, b: 0, a: 1 },
  green: { r: 0, g: 128, b: 0, a: 1 },
  blue: { r: 0, g: 0, b: 255, a: 1 },
  yellow: { r: 255, g: 255, b: 0, a: 1 },
  orange: { r: 255, g: 165, b: 0, a: 1 },
  purple: { r: 128, g: 0, b: 128, a: 1 },
  pink: { r: 255, g: 192, b: 203, a: 1 },
  gray: { r: 128, g: 128, b: 128, a: 1 },
  grey: { r: 128, g: 128, b: 128, a: 1 },
  silver: { r: 192, g: 192, b: 192, a: 1 },
  maroon: { r: 128, g: 0, b: 0, a: 1 },
  olive: { r: 128, g: 128, b: 0, a: 1 },
  navy: { r: 0, g: 0, b: 128, a: 1 },
  teal: { r: 0, g: 128, b: 128, a: 1 },
  aqua: { r: 0, g: 255, b: 255, a: 1 },
  cyan: { r: 0, g: 255, b: 255, a: 1 },
  fuchsia: { r: 255, g: 0, b: 255, a: 1 },
  magenta: { r: 255, g: 0, b: 255, a: 1 },
  lime: { r: 0, g: 255, b: 0, a: 1 },
  transparent: { r: 0, g: 0, b: 0, a: 0 },
};
