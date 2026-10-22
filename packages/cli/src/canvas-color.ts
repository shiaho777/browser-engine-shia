/**
 * canvas-color.ts — `<color>` parsing for the 2D canvas API (RFC 0033).
 *
 * Named colors, #hex, and rgb()/rgba() reuse the generator's CSS `<color>`
 * parser (one grammar, one table). Canvas additionally needs `hsl()/hsla()`
 * and percentage rgb channels, handled here as small extensions on top.
 */

import { parseColor } from "@browser-engine/generator";
import type { Color } from "@browser-engine/ir";

const clampByte = (n: number): number => Math.max(0, Math.min(255, Math.round(n)));

/** hsl(h, s, l[, a]) → Color; s/l may be % or bare numbers treated as %. */
function parseHsl(token: string): Color | undefined {
  const m = /^hsla?\(([^)]*)\)$/i.exec(token.trim());
  if (m === null) return undefined;
  const parts = m[1]!.split(/[\s,/]+/).filter((p) => p.length > 0);
  if (parts.length < 3 || parts.length > 4) return undefined;
  const h = Number(parts[0]);
  const s = parseFloat(parts[1]!);
  const l = parseFloat(parts[2]!);
  const a = parts[3] === undefined ? 1 : parseFloat(parts[3]);
  if (![h, s, l, a].every(Number.isFinite)) return undefined;
  const sat = Math.max(0, Math.min(100, s)) / 100;
  const lig = Math.max(0, Math.min(100, l)) / 100;
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const hue = ((h % 360) + 360) % 360;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const mv = lig - c / 2;
  const [r, g, b] =
    hue < 60 ? [c, x, 0]
      : hue < 120 ? [x, c, 0]
        : hue < 180 ? [0, c, x]
          : hue < 240 ? [0, x, c]
            : hue < 300 ? [x, 0, c]
              : [c, 0, x];
  return {
    r: clampByte((r + mv) * 255),
    g: clampByte((g + mv) * 255),
    b: clampByte((b + mv) * 255),
    a: Math.max(0, Math.min(1, a)),
  };
}

/** rgb() with percentage channels → normalized 0-255 string for parseColor. */
function normalizePercentRgb(token: string): string {
  const m = /^rgba?\(([^)]*)\)$/i.exec(token.trim());
  if (m === null) return token;
  const parts = m[1]!.split(/[\s,/]+/).filter((p) => p.length > 0);
  const out = parts.map((p, i) => {
    if (!p.endsWith("%")) return p;
    const n = parseFloat(p);
    if (!Number.isFinite(n)) return p;
    // The first three channels are 0-255 percentages; alpha is 0-1.
    return i < 3 ? String(Math.max(0, Math.min(255, (n / 100) * 255))) : String(Math.max(0, Math.min(1, n / 100)));
  });
  return `rgb(${out.join(" ")})`;
}

/**
 * Parse a canvas style string to a `Color`, or `undefined` when unparseable
 * (spec: setting an invalid fillStyle/strokeStyle is silently ignored).
 */
export function parseCanvasColor(input: string): Color | undefined {
  const token = input.trim();
  if (token.length === 0) return undefined;
  if (/^hsla?\(/i.test(token)) return parseHsl(token);
  const rgbAttempt = /^rgba?\(/i.test(token) ? normalizePercentRgb(token) : token;
  const parsed = parseColor(rgbAttempt);
  return parsed.ok ? parsed.value : undefined;
}
