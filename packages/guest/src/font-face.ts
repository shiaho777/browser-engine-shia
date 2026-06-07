/**
 * `@font-face` web-font loading and application (task 7.8; design.md §3.1.F,
 * §11; Requirements 16.6, 8.1).
 *
 * Requirement 16.6: "WHERE a stylesheet declares a web font via @font-face, THE
 * Engine SHALL load and apply that font." This module implements that end-to-end:
 *
 *   1. **Parse** `@font-face` at-rules out of CSS text into {@link FontFaceRule}
 *      descriptors (family + `src` url + optional weight/style). The committed
 *      StyleSheet IR (`@browser-engine/ir`) models only style rules, not
 *      at-rules, so — exactly as the layout/paint branches read pending
 *      properties defensively — this extracts `@font-face` blocks from the raw
 *      CSS source. Wiring `@font-face` into the StyleSheet IR is a separate
 *      pending parser-extension task; the loader here consumes whichever
 *      descriptors it is given.
 *   2. **Load** each font's bytes through the SAME reused networking stack guest
 *      `fetch` uses (`./network.ts`; Requirement 8.1) — no separate font
 *      transport, no fabricated bytes.
 *   3. **Apply** the loaded font by registering its decoded bytes under its
 *      family (+ weight/style) in a {@link FontRegistry}, so the shaping/layout
 *      seam can resolve `font-family: <name>` to the downloaded face.
 *
 * Unsupported `src` forms (e.g. `local()`, data URIs) and load failures fail
 * loudly via {@link NotImplemented} / a rejected promise rather than silently
 * substituting a fallback face (design.md §12; Requirement 5.1).
 */
import { NotImplemented } from "@browser-engine/ir";

import type { NetworkStack } from "./network.js";

/** A parsed `@font-face` rule: the descriptors the loader needs. */
export interface FontFaceRule {
  /** The `font-family` name the face is registered under (unquoted). */
  readonly family: string;
  /** The first usable `url()` source from the `src` descriptor. */
  readonly src: string;
  /** The `font-weight` descriptor, normalised; defaults to `"normal"`. */
  readonly weight: string;
  /** The `font-style` descriptor, normalised; defaults to `"normal"`. */
  readonly style: string;
}

/** A loaded, applied web font: its descriptors plus the downloaded bytes. */
export interface LoadedFont {
  readonly family: string;
  readonly weight: string;
  readonly style: string;
  /** The downloaded font-file bytes (consumed by the rasterizer/shaper). */
  readonly data: Uint8Array;
}

// ---------------------------------------------------------------------------
// 1. Parse @font-face rules out of CSS text.
// ---------------------------------------------------------------------------

/** Matches a whole `@font-face { ... }` block (one capture: the body). */
const FONT_FACE_BLOCK = /@font-face\s*\{([^}]*)\}/gi;
/** Matches the first `url(...)` token in a `src` descriptor. */
const URL_TOKEN = /url\(\s*(['"]?)([^'")]+)\1\s*\)/i;

/**
 * Extract every `@font-face` rule from CSS `source`. Returns one
 * {@link FontFaceRule} per block that carries both a `font-family` and a usable
 * `url()` `src`. A block missing either is skipped (it declares no loadable web
 * font), matching the spec's "ignore an unusable @font-face" behaviour.
 */
export function parseFontFaceRules(source: string): readonly FontFaceRule[] {
  const rules: FontFaceRule[] = [];
  for (const match of source.matchAll(FONT_FACE_BLOCK)) {
    const body = match[1] ?? "";
    const descriptors = parseDescriptors(body);

    const family = unquote(descriptors["font-family"]);
    const src = descriptors["src"];
    if (family === undefined || family.length === 0 || src === undefined) {
      continue; // not a loadable web font.
    }
    const url = firstUrl(src);
    if (url === null) {
      continue; // no usable url() source (e.g. only local()).
    }
    rules.push({
      family,
      src: url,
      weight: normaliseDescriptor(descriptors["font-weight"], "normal"),
      style: normaliseDescriptor(descriptors["font-style"], "normal"),
    });
  }
  return rules;
}

/** Split a declaration block body into a `name → value` map (lowercased names). */
function parseDescriptors(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of body.split(";")) {
    const colon = part.indexOf(":");
    if (colon === -1) {
      continue;
    }
    const name = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).trim();
    if (name.length > 0 && value.length > 0) {
      out[name] = value;
    }
  }
  return out;
}

/** The first `url()` target in a `src` descriptor, or `null` when none. */
function firstUrl(src: string): string | null {
  const match = URL_TOKEN.exec(src);
  return match ? (match[2] ?? null) : null;
}

/** Strip surrounding quotes from a descriptor value (e.g. a quoted family). */
function unquote(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Normalise an optional descriptor to a trimmed value or a default. */
function normaliseDescriptor(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? fallback : trimmed;
}

// ---------------------------------------------------------------------------
// 2/3. Load each font's bytes through the reused stack and register them.
// ---------------------------------------------------------------------------

/**
 * The applied-font registry: the place a loaded web font is "applied" so the
 * shaping/layout seam can resolve a `font-family` to its downloaded face
 * (Requirement 16.6). Keyed by family + weight + style.
 */
export class FontRegistry {
  /** key (`family|weight|style`, lowercased family) → loaded font. */
  readonly #fonts = new Map<string, LoadedFont>();

  /** Register (apply) a loaded font so lookups for its family resolve to it. */
  register(font: LoadedFont): void {
    this.#fonts.set(keyOf(font.family, font.weight, font.style), font);
  }

  /**
   * Resolve a loaded web font for `family` (and optional weight/style). Returns
   * `undefined` when no web font has been applied for that family — the caller
   * then falls back to a system font (handled by the shaper), NOT a silent fake.
   */
  resolve(family: string, weight = "normal", style = "normal"): LoadedFont | undefined {
    return this.#fonts.get(keyOf(family, weight, style));
  }

  /** Whether any web font has been applied for `family` (any weight/style). */
  has(family: string): boolean {
    const prefix = `${family.toLowerCase()}|`;
    for (const key of this.#fonts.keys()) {
      if (key.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }

  /** The number of applied font faces. */
  get size(): number {
    return this.#fonts.size;
  }
}

/** The registry key for a face (family is case-insensitive; CSS folds it). */
function keyOf(family: string, weight: string, style: string): string {
  return `${family.toLowerCase()}|${weight}|${style}`;
}

/**
 * Load and apply every `@font-face` web font declared in CSS `source`
 * (Requirement 16.6). Each face's bytes are downloaded through the reused
 * networking `stack` (Requirement 8.1) and registered in `registry` so layout/
 * shaping can resolve the family to the downloaded face. Relative `src` URLs are
 * resolved against `baseUrl` when provided.
 *
 * @returns the loaded faces, in declaration order.
 * @throws Error (rejected promise) if a declared font fails to download — a loud
 *   failure, never a silent fallback substitution (design.md §12).
 */
export async function loadFontFaces(
  source: string,
  stack: NetworkStack,
  registry: FontRegistry,
  baseUrl?: string,
): Promise<readonly LoadedFont[]> {
  const rules = parseFontFaceRules(source);
  const loaded: LoadedFont[] = [];
  for (const rule of rules) {
    const font = await loadFontFace(rule, stack, baseUrl);
    registry.register(font);
    loaded.push(font);
  }
  return loaded;
}

/** Download a single `@font-face` rule's bytes through the reused stack. */
export async function loadFontFace(
  rule: FontFaceRule,
  stack: NetworkStack,
  baseUrl?: string,
): Promise<LoadedFont> {
  const url = resolveUrl(rule.src, baseUrl);
  const response = await stack.request({ url });
  if (!response.ok) {
    // A failed download is a loud failure — the face is not "applied" as some
    // fabricated fallback (design.md §12; Requirement 5.1 spirit).
    throw new Error(`@font-face "${rule.family}" failed to load: ${url} → HTTP ${response.status}`);
  }
  return {
    family: rule.family,
    weight: rule.weight,
    style: rule.style,
    data: response.body,
  };
}

/** Resolve a possibly-relative font `src` against an optional base URL. */
function resolveUrl(src: string, baseUrl?: string): string {
  try {
    return baseUrl === undefined ? new URL(src).href : new URL(src, baseUrl).href;
  } catch {
    throw new NotImplemented("font-face:src", {
      category: "other",
      detail: `@font-face src is not a resolvable URL: ${src}${baseUrl === undefined ? " (no base URL)" : ""}`,
    });
  }
}
