/**
 * CSS Media Query evaluation (CSS Conditional Rules 3 + Media Queries 4/5;
 * ROADMAP Phase 1).
 *
 * A media query list is comma-separated: the `@media` block is active iff ANY
 * query matches the environment. Each query is:
 *
 *   `[only | not]? <media-type>? [and (<feature>)]*  [or (<feature>)...]*`
 *
 * or a bare feature list `(min-width: 800px) and (orientation: landscape)`.
 * Media Queries Level 4 RANGE syntax is supported —
 * `(width >= 800px)`, `(400px <= width <= 1200px)`, `(aspect-ratio > 16/9)` —
 * alongside the legacy `min-`/`max-` prefixes.
 *
 * A query matches only when its truth value is `true`. Unknown features and
 * ill-typed values are a third state: they do not match, and `not` does not
 * flip them into a match (Media Queries 4). That is what lets
 * `matchMedia("query, not all and query")` tell a known feature from an
 * unknown one.
 */

/** The media environment the engine renders for. */
export interface MediaEnvironment {
  readonly type: "screen" | "print" | "all";
  readonly widthPx: number;
  readonly heightPx: number;
  /** Output surface size — defaults to the viewport (no OS screen probe). */
  readonly deviceWidthPx?: number;
  readonly deviceHeightPx?: number;
  /** Device pixel ratio — `(resolution: 2dppx)`, `srcset` DPR pairing. */
  readonly resolutionDppx?: number;
  /** User/system preferences (prefers-* media features). */
  readonly prefersColorScheme?: "light" | "dark";
  readonly prefersReducedMotion?: boolean;
  readonly prefersReducedTransparency?: boolean;
  readonly prefersReducedData?: boolean;
  readonly prefersContrast?: "no-preference" | "less" | "more" | "custom";
  readonly forcedColors?: "none" | "active";
  /** Input capabilities. */
  readonly hover?: "none" | "hover";
  readonly pointer?: "none" | "coarse" | "fine";
  readonly anyHover?: "none" | "hover";
  readonly anyPointer?: "none" | "coarse" | "fine";
  /** Output surface traits. */
  readonly colorBits?: number;
  readonly monochrome?: boolean;
  readonly colorGamut?: "srgb" | "p3" | "rec2020";
  readonly displayMode?: "browser" | "fullscreen" | "minimal-ui" | "standalone";
  /** `scripting` — whether the realm runs scripts (nav documents do). */
  readonly scripting?: boolean;
}

/** The default screen media environment (matches the layout default 800×600). */
export const DEFAULT_MEDIA_ENVIRONMENT: MediaEnvironment = Object.freeze({
  type: "screen",
  widthPx: 800,
  heightPx: 600,
});

interface ResolvedEnv {
  readonly type: "screen" | "print" | "all";
  readonly widthPx: number;
  readonly heightPx: number;
  readonly deviceWidthPx: number;
  readonly deviceHeightPx: number;
  readonly resolutionDppx: number;
  readonly prefersColorScheme: "light" | "dark";
  readonly prefersReducedMotion: boolean;
  readonly prefersReducedTransparency: boolean;
  readonly prefersReducedData: boolean;
  readonly prefersContrast: "no-preference" | "less" | "more" | "custom";
  readonly forcedColors: "none" | "active";
  readonly hover: "none" | "hover";
  readonly pointer: "none" | "coarse" | "fine";
  readonly anyHover: "none" | "hover";
  readonly anyPointer: "none" | "coarse" | "fine";
  readonly colorBits: number;
  readonly monochrome: boolean;
  readonly colorGamut: "srgb" | "p3" | "rec2020";
  readonly displayMode: "browser" | "fullscreen" | "minimal-ui" | "standalone";
  readonly scripting: boolean;
}

function resolve(env: MediaEnvironment): ResolvedEnv {
  return {
    type: env.type,
    widthPx: env.widthPx,
    heightPx: env.heightPx,
    deviceWidthPx: env.deviceWidthPx ?? env.widthPx,
    deviceHeightPx: env.deviceHeightPx ?? env.heightPx,
    resolutionDppx: env.resolutionDppx ?? 1,
    prefersColorScheme: env.prefersColorScheme ?? "light",
    prefersReducedMotion: env.prefersReducedMotion ?? false,
    prefersReducedTransparency: env.prefersReducedTransparency ?? false,
    prefersReducedData: env.prefersReducedData ?? false,
    prefersContrast: env.prefersContrast ?? "no-preference",
    forcedColors: env.forcedColors ?? "none",
    hover: env.hover ?? "hover",
    pointer: env.pointer ?? "fine",
    anyHover: env.anyHover ?? env.hover ?? "hover",
    anyPointer: env.anyPointer ?? env.pointer ?? "fine",
    colorBits: env.colorBits ?? 8,
    monochrome: env.monochrome ?? false,
    colorGamut: env.colorGamut ?? "srgb",
    displayMode: env.displayMode ?? "browser",
    scripting: env.scripting ?? true,
  };
}

/**
 * Evaluate a full media query list (comma-separated). `true` if ANY query
 * matches; `false` for an empty/invalid query — except the empty string,
 * which matches per spec ("no condition" = `all`).
 */
/** `true`, `false`, or MQ4 `unknown` (negation does not turn unknown into true). */
type Tri = true | false | "unknown";

function triAnd(a: Tri, b: Tri): Tri {
  if (a === false || b === false) return false;
  if (a === "unknown" || b === "unknown") return "unknown";
  return true;
}

function triNot(value: Tri): Tri {
  if (value === "unknown") return "unknown";
  return !value;
}

function triOr(parts: readonly Tri[]): Tri {
  if (parts.some((part) => part === true)) return true;
  if (parts.some((part) => part === "unknown")) return "unknown";
  return false;
}

export function mediaQueryListMatches(queryList: string, env: MediaEnvironment): boolean {
  const trimmed = queryList.trim();
  if (trimmed.length === 0) {
    return true;
  }
  const e = resolve(env);
  return trimmed
    .split(",")
    .some((query) => mediaQueryTruth(query.trim().toLowerCase(), e) === true);
}

export function mediaQueryMatches(query: string, env: MediaEnvironment): boolean {
  return mediaQueryTruth(query, resolve(env)) === true;
}

function mediaQueryTruth(query: string, env: ResolvedEnv): Tri {
  if (query.length === 0) return false;
  const orParts = splitTopLevel(query, "or");
  return triOr(orParts.map((branch) => matchAndBranch(branch, env)));
}

function matchAndBranch(branch: string, env2: ResolvedEnv): Tri {
  const parts = splitOnAnd(branch);
  if (parts.length === 0) return false;

  let negated = false;
  let firstPart = parts[0]!;
  if (firstPart.startsWith("only ")) {
    firstPart = firstPart.slice(5).trim();
    parts[0] = firstPart;
  } else if (firstPart.startsWith("not ")) {
    negated = true;
    firstPart = firstPart.slice(4).trim();
    parts[0] = firstPart;
  }

  let mediaType: string | null = null;
  const features: string[] = [];
  const first = parts[0];
  if (first !== undefined && first.length > 0) {
    if (isMediaFeature(first)) {
      features.push(first);
    } else if (!first.includes(" ")) {
      mediaType = first;
    } else {
      return false;
    }
  }
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    if (part === undefined || !isMediaFeature(part)) return false;
    features.push(part);
  }

  let acc: Tri = mediaTypeMatches(mediaType, env2) ? true : false;
  for (const feature of features) acc = triAnd(acc, mediaFeatureMatches(feature, env2));
  return negated ? triNot(acc) : acc;
}

/** Split on a top-level keyword boundary, respecting parens. */
function splitTopLevel(text: string, keyword: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let i = 0;
  const re = new RegExp(`^\\s+${keyword}\\b`, "i");
  while (i < text.length) {
    const ch = text[i];
    if (ch === undefined) break;
    if (ch === "(") {
      depth += 1;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      current += ch;
      i += 1;
      continue;
    }
    if (depth === 0) {
      const rest = text.slice(i);
      if (re.test(rest) && current.trim().length > 0) {
        parts.push(current.trim());
        current = "";
        i += rest.match(re)![0].length;
        continue;
      }
      if (current.endsWith(")") && new RegExp(`^${keyword}\\b`, "i").test(rest)) {
        parts.push(current.trim());
        current = "";
        i += rest.match(new RegExp(`^${keyword}\\b`, "i"))![0].length;
        continue;
      }
    }
    current += ch;
    i += 1;
  }
  if (current.trim().length > 0) parts.push(current.trim());
  return parts;
}

/** Split a query on top-level `and`, respecting parens. */
function splitOnAnd(query: string): string[] {
  return splitTopLevel(query, "and");
}

function mediaTypeMatches(mediaType: string | null, env: ResolvedEnv): boolean {
  if (mediaType === null || mediaType === "all") return true;
  // Deprecated types (tv/tty/handheld/...) never match a screen engine —
  // they are real media types that simply don't describe us.
  return mediaType === env.type;
}

function isMediaFeature(value: string): boolean {
  return value.startsWith("(") && value.endsWith(")");
}

/* ------------------------------------------------------------------ */
/* Media features                                                      */
/* ------------------------------------------------------------------ */

const LENGTH_UNITS: Readonly<Record<string, number>> = {
  px: 1,
  em: 16, // media queries resolve em/rem against the INITIAL font size
  rem: 16,
  ex: 8, // 0.5em, the same fallback the cascade uses for width: Nex
  ch: 8,
  ic: 16,
  vw: Number.NaN, // resolved against the env below
  vh: Number.NaN,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
  pt: 96 / 72,
  pc: 16,
};

/** Parse a `<length>` token into CSS pixels (viewport units use the env). */
function parseLength(token: string, env: ResolvedEnv): number | null {
  const m = /^(-?[0-9]+(?:\.[0-9]+)?)(px|em|rem|ex|ch|ic|vw|vh|in|cm|mm|q|pt|pc)?$/.exec(token.trim());
  if (m === null) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  const unit = m[2] ?? (value === 0 ? "px" : null);
  if (unit === null) return null; // non-zero unitless length
  if (unit === "vw") return (value * env.widthPx) / 100;
  if (unit === "vh") return (value * env.heightPx) / 100;
  const scale = LENGTH_UNITS[unit];
  return scale === undefined ? null : value * scale;
}

/** Parse a `<ratio>` (`a/b` or a bare number). */
function parseRatio(token: string): number | null {
  const m = /^([0-9]+(?:\.[0-9]+)?)(?:\s*\/\s*([0-9]+(?:\.[0-9]+)?))?$/.exec(token.trim());
  if (m === null) return null;
  const num = Number(m[1]);
  const den = m[2] === undefined ? 1 : Number(m[2]);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  return num / den;
}

/** Parse a `<resolution>` into dppx (`dpi`, `dpcm`, `x` synonyms). */
function parseResolution(token: string): number | null {
  const m = /^([0-9]+(?:\.[0-9]+)?)(dppx|dpi|dpcm|x)$/.exec(token.trim());
  if (m === null) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = m[2];
  if (unit === "dpi") return value / 96;
  if (unit === "dpcm") return (value * 2.54) / 96;
  return value; // dppx / x
}

type Cmp = "eq" | "min" | "max";

/** Keyword features the engine knows. A value outside the list is unknown, not false. */
/** Boolean context is false when the feature's current value is this keyword. */
const DISCRETE_BOOLEAN_ZERO: Readonly<Record<string, string>> = {
  "forced-colors": "none",
  "inverted-colors": "none",
  "navigation-controls": "none",
  "nav-controls": "none",
  "prefers-contrast": "no-preference",
  "prefers-reduced-data": "no-preference",
  "prefers-reduced-motion": "no-preference",
  "prefers-reduced-transparency": "no-preference",
  "overflow-block": "none",
  "overflow-inline": "none",
  scripting: "none",
  update: "none",
  hover: "none",
  "any-hover": "none",
  pointer: "none",
  "any-pointer": "none",
  resizable: "false",
};

const DISCRETE_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  orientation: ["portrait", "landscape"],
  "prefers-color-scheme": ["light", "dark"],
  "prefers-reduced-motion": ["no-preference", "reduce"],
  "prefers-reduced-transparency": ["no-preference", "reduce"],
  "prefers-reduced-data": ["no-preference", "reduce"],
  "prefers-contrast": ["no-preference", "less", "more", "custom"],
  "forced-colors": ["none", "active"],
  "inverted-colors": ["none", "inverted"],
  hover: ["none", "hover"],
  "any-hover": ["none", "hover"],
  pointer: ["none", "coarse", "fine"],
  "any-pointer": ["none", "coarse", "fine"],
  "display-mode": ["browser", "fullscreen", "minimal-ui", "standalone", "picture-in-picture", "unframed", "window-controls-overlay"],
  "display-state": ["normal", "minimized", "maximized", "fullscreen"],
  "color-gamut": ["srgb", "p3", "rec2020"],
  "dynamic-range": ["standard", "high"],
  "video-dynamic-range": ["standard", "high"],
  update: ["none", "slow", "fast"],
  "overflow-block": ["none", "scroll", "paged"],
  "overflow-inline": ["none", "scroll"],
  scripting: ["enabled", "initial-only", "none"],
  "navigation-controls": ["none", "back-button"],
  "nav-controls": ["none", "back-button"],
  resizable: ["true", "false"],
};

/** The environment's current keyword for a known discrete feature. */
function discreteActual(name: string, env: ResolvedEnv): string {
  switch (name) {
    case "orientation":
      // Square viewports are portrait: height >= width (Media Queries 4).
      return env.heightPx >= env.widthPx ? "portrait" : "landscape";
    case "prefers-color-scheme":
      return env.prefersColorScheme;
    case "prefers-reduced-motion":
      return env.prefersReducedMotion ? "reduce" : "no-preference";
    case "prefers-reduced-transparency":
      return env.prefersReducedTransparency ? "reduce" : "no-preference";
    case "prefers-reduced-data":
      return env.prefersReducedData ? "reduce" : "no-preference";
    case "prefers-contrast":
      return env.prefersContrast;
    case "forced-colors":
      return env.forcedColors;
    case "inverted-colors":
      return "none";
    case "hover":
      return env.hover;
    case "any-hover":
      return env.anyHover;
    case "pointer":
      return env.pointer;
    case "any-pointer":
      return env.anyPointer;
    case "display-mode":
      return env.displayMode;
    case "display-state":
      return "normal";
    case "color-gamut":
      return env.colorGamut;
    case "dynamic-range":
    case "video-dynamic-range":
      return "standard";
    case "update":
      return "fast";
    case "overflow-block":
    case "overflow-inline":
      return "scroll";
    case "scripting":
      return env.scripting ? "enabled" : "none";
    case "navigation-controls":
    case "nav-controls":
      return "none";
    case "resizable":
      return "true";
    default:
      return "";
  }
}

function discreteFeature(name: string, value: string, env: ResolvedEnv): Tri {
  const allowed = DISCRETE_KEYWORDS[name];
  if (allowed === undefined || !allowed.includes(value)) return "unknown";
  return value === discreteActual(name, env);
}

/** Numeric feature actuals for range/legacy-prefix comparison. */
function numeric(name: string, env: ResolvedEnv): { value: number; unit: "length" | "ratio" | "resolution" | "integer" } | null {
  switch (name) {
    case "width":
      return { value: env.widthPx, unit: "length" };
    case "height":
      return { value: env.heightPx, unit: "length" };
    case "device-width":
      return { value: env.deviceWidthPx, unit: "length" };
    case "device-height":
      return { value: env.deviceHeightPx, unit: "length" };
    case "aspect-ratio":
      // spec: aspect-ratio is the VIEWPORT ratio; device-* is the surface's.
      return { value: env.widthPx / env.heightPx, unit: "ratio" };
    case "device-aspect-ratio":
      return { value: env.deviceWidthPx / env.deviceHeightPx, unit: "ratio" };
    case "resolution":
      return { value: env.resolutionDppx, unit: "resolution" };
    case "color":
      return { value: env.colorBits, unit: "integer" };
    case "monochrome":
      return { value: env.monochrome ? env.colorBits : 0, unit: "integer" };
    case "grid":
      return { value: 0, unit: "integer" }; // bitmap output, not tty grid
    default:
      return null;
  }
}

function compareNumeric(
  actual: number,
  cmp: Cmp,
  wanted: number,
): boolean {
  if (cmp === "min") return actual >= wanted;
  if (cmp === "max") return actual <= wanted;
  return Math.abs(actual - wanted) < 1e-9;
}

function parseWanted(raw: string, unit: "length" | "ratio" | "resolution" | "integer", env: ResolvedEnv): number | null {
  switch (unit) {
    case "length":
      return parseLength(raw, env);
    case "ratio":
      return parseRatio(raw);
    case "resolution":
      return parseResolution(raw);
    case "integer":
      return /^[0-9]+$/.test(raw.trim()) ? Number(raw.trim()) : null;
  }
}

function mediaFeatureMatches(feature: string, env: ResolvedEnv): Tri {
  const inner = feature.slice(1, -1).trim();
  if (inner === "") return false;

  // MQ4 range syntax: `(a <= f <= b)` / `(f >= a)` / `(f < a)` — resolve the
  // feature name (the ident) and each bound, then compare.
  const range =
    /^\s*([a-z-]+)\s*(>=|<=|>|<)\s*(.+)$/.exec(inner) ??
    /^\s*(.+?)\s*(>=|<=|>|<)\s*([a-z-]+)\s*(?:(>=|<=|>|<)\s*(.+))?$/.exec(inner);
  if (range !== null) {
    const nameFirst = /^[a-z-]+$/.test(range[1]!.trim());
    if (nameFirst) {
      // `(feature op value)`
      const name = range[1]!.trim();
      const op = range[2]!;
      const raw = range[3]!.trim();
      const spec = numeric(name, env);
      if (spec === null) return "unknown";
      const wanted = parseWanted(raw, spec.unit, env);
      if (wanted === null) return "unknown";
      switch (op) {
        case ">=": return spec.value >= wanted;
        case "<=": return spec.value <= wanted;
        case ">": return spec.value > wanted;
        case "<": return spec.value < wanted;
        default: return false;
      }
    }
    // `(value op feature [op value])`
    const rawLo = range[1]!.trim();
    const op1 = range[2]!;
    const name = range[3]!.trim();
    const op2 = range[4];
    const rawHi = range[5]?.trim();
    const spec = numeric(name, env);
    if (spec === null) return "unknown";
    const lo = parseWanted(rawLo, spec.unit, env);
    if (lo === null) return "unknown";
    const loOk = op1 === "<=" ? lo <= spec.value : op1 === "<" ? lo < spec.value
      : op1 === ">=" ? lo >= spec.value : lo > spec.value;
    if (!loOk) return false;
    if (op2 !== undefined) {
      const hi = rawHi !== undefined && rawHi !== "" ? parseWanted(rawHi, spec.unit, env) : null;
      if (hi === null) return "unknown";
      return op2 === "<=" ? spec.value <= hi : op2 === "<" ? spec.value < hi
        : op2 === ">=" ? spec.value >= hi : spec.value > hi;
    }
    return true;
  }

  // `(name)` boolean context. Keyword features whose zero value is `none` or
  // `no-preference` match only when the environment is not that value.
  // `(color)` matches when the channel count is non-zero; `(monochrome)` does not.
  if (/^[a-z-]+$/.test(inner)) {
    if (DISCRETE_KEYWORDS[inner] !== undefined) {
      const zero = DISCRETE_BOOLEAN_ZERO[inner];
      return zero === undefined ? true : discreteActual(inner, env) !== zero;
    }
    const spec = numeric(inner, env);
    if (spec !== null) return spec.value !== 0;
    return "unknown";
  }

  // `(name: value)` — legacy prefixes min-/max- plus exact.
  const colon = inner.indexOf(":");
  if (colon === -1) return false;
  let name = inner.slice(0, colon).trim();
  const value = inner.slice(colon + 1).trim();
  if (name === "" || value === "") return false;

  let cmp: Cmp = "eq";
  if (name.startsWith("min-")) {
    cmp = "min";
    name = name.slice(4);
  } else if (name.startsWith("max-")) {
    cmp = "max";
    name = name.slice(4);
  }

  const num = numeric(name, env);
  if (num !== null) {
    const wanted = parseWanted(value, num.unit, env);
    if (wanted === null) return "unknown";
    return compareNumeric(num.value, cmp, wanted);
  }

  if (cmp !== "eq") return "unknown";
  return discreteFeature(name, value, env);
}

/**
 * Serialize a media query list the way `MediaQueryList.media` does:
 * trim, close a missing `)`, reject a stray `)`, join with `", "`, and
 * canonicalize `calc(<resolution>)` units to `dppx`. A query the syntax
 * cannot recover is `not all`. The empty list stays empty.
 */
export function serializeMediaQueryList(input: string): string {
  if (input.trim() === "") return "";
  return splitCommas(input).map((part) => foldResolutionCalcs(canonicalizeQuery(part))).join(", ");
}

function splitCommas(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  for (const ch of input) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

const RESERVED_MEDIA_TYPE = new Set(["not", "and", "only", "or", "layer"]);

/** `not` / `and` / `only` / `or` used as a media type makes the query `not all`. */
function usesReservedMediaType(query: string): boolean {
  if (query.includes("(")) return false;
  const parts = query.toLowerCase().split(/\s+/).filter((part) => part.length > 0);
  if (parts.length === 0) return true;
  const head = parts[0] ?? "";
  if (head === "not" || head === "only") {
    if (parts.length === 1) return true;
    return RESERVED_MEDIA_TYPE.has(parts[1] ?? "");
  }
  return RESERVED_MEDIA_TYPE.has(head);
}

function canonicalizeQuery(raw: string): string {
  let text = raw.trim();
  if (text === "") return "not all";
  // Escaped identifiers (`\{screen`, `--\(FOO`) keep their source spelling.
  if (text.includes("\\")) return text.replace(/[ \t\n\r\f]+/g, " ").trim();
  if (usesReservedMediaType(text)) return "not all";
  let depth = 0;
  for (const ch of text) {
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth < 0) return "not all";
    }
  }
  while (depth > 0) {
    text += ")";
    depth -= 1;
  }
  text = text.replace(/\s+/g, " ").trim();
  text = text.replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");
  text = text.replace(/\s*:\s*/g, ": ");
  text = text.replace(
    /\((aspect-ratio|device-aspect-ratio): (\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)\)/gi,
    "($1: $2 / $3)",
  );
  return text;
}

/** `calc(1x + 2x)` serializes as `calc(3dppx)`; a bare `1x` stays `1x`. */
function foldResolutionCalcs(text: string): string {
  return text.replace(/calc\(([^()]*)\)/gi, (_match, inner: string) => {
    const norm = inner.replace(/(\d+(?:\.\d+)?)x\b/gi, "$1dppx").replace(/\s+/g, " ").trim();
    const add = /^(\d+(?:\.\d+)?)dppx\s*([+-])\s*(\d+(?:\.\d+)?)dppx$/i.exec(norm);
    if (add !== null) {
      const value = add[2] === "+" ? Number(add[1]) + Number(add[3]) : Number(add[1]) - Number(add[3]);
      return `calc(${value}dppx)`;
    }
    const mul = /^(\d+(?:\.\d+)?)dppx\s*\*\s*(\d+(?:\.\d+)?)$/i.exec(norm)
      ?? /^(\d+(?:\.\d+)?)\s*\*\s*(\d+(?:\.\d+)?)dppx$/i.exec(norm);
    if (mul !== null) return `calc(${Number(mul[1]) * Number(mul[2])}dppx)`;
    const div = /^(\d+(?:\.\d+)?)dppx\s*\/\s*(\d+(?:\.\d+)?)$/i.exec(norm);
    if (div !== null) return `calc(${Number(div[1]) / Number(div[2])}dppx)`;
    return `calc(${norm})`;
  });
}
