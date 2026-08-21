/**
 * CSS Media Query evaluation (CSS Conditional Rules 3; ROADMAP Phase 2).
 *
 * A media query is a comma-separated list of query conditions. The stylesheet's
 * `@media` block is active iff ANY of the conditions match the current media
 * environment.
 *
 * Each condition is: `[only | not]? <media-type>? and (<feature>)*`
 * e.g. `screen and (min-width: 800px)`, `not print`, `(orientation: landscape)`.
 *
 * This module is the *mechanism*: a data-driven predicate evaluator. It covers
 * media types (`screen`/`print`/`all`), `not`/`only` prefix, `and` conjunction,
 * and the common viewport features: `width`/`min-width`/`max-width`/
 * `height`/`min-height`/`max-height`/`orientation`. Unsupported features
 * (range syntax, `hover`, `prefers-color-scheme`, etc.) are treated as
 * non-matching — the query is skipped, not silently passed.
 */

/**
 * The media environment the engine renders for. Currently always a "screen"
 * with the layout viewport dimensions.
 */
export interface MediaEnvironment {
  readonly type: "screen" | "print" | "all";
  readonly widthPx: number;
  readonly heightPx: number;
}

/** The default screen media environment (matches the layout default 800×600). */
export const DEFAULT_MEDIA_ENVIRONMENT: MediaEnvironment = Object.freeze({
  type: "screen",
  widthPx: 800,
  heightPx: 600,
});

/**
 * Evaluate a full media query list (comma-separated). Returns `true` if ANY
 * query in the list matches the environment, `false` if none match, and `false`
 * for an empty/invalid query (matching the CSS spec: an unknown media type or
 * unparseable query does not match).
 */
export function mediaQueryListMatches(queryList: string, env: MediaEnvironment): boolean {
  const trimmed = queryList.trim();
  if (trimmed.length === 0) {
    return true; // no media query = always match (spec: empty = "all")
  }
  return trimmed
    .split(",")
    .some((query) => mediaQueryMatches(query.trim().toLowerCase(), env));
}

/**
 * Evaluate a single media query (no commas). A query is:
 *   `[only | not]? <media-type>? [and (<feature>)]*`
 */
export function mediaQueryMatches(query: string, env: MediaEnvironment): boolean {
  if (query.length === 0) {
    return false;
  }

  // Split on top-level `and` (case-insensitive, word-boundary).
  const parts = splitOnAnd(query);
  if (parts.length === 0) {
    return false;
  }

  let negated = false;
  let firstPart = parts[0]!;
  if (firstPart === undefined) return false;

  // Handle `only` / `not` prefix on the media type.
  if (firstPart.startsWith("only ")) {
    firstPart = firstPart.slice("only ".length).trim();
    parts[0] = firstPart;
  } else if (firstPart.startsWith("not ")) {
    negated = true;
    firstPart = firstPart.slice("not ".length).trim();
    parts[0] = firstPart;
  }

  // The first part is either a media type or a bare media feature.
  let mediaType: string | null = null;
  const features: string[] = [];

  const first = parts[0];
  if (first !== undefined && first.length > 0) {
    if (isMediaFeature(first)) {
      // Bare feature: `(min-width: 800px)` — no media type, implied "all".
      features.push(first);
    } else if (!first.includes(" ")) {
      // Single token media type: `screen`, `print`, `all`.
      mediaType = first;
    } else {
      return false; // malformed
    }
  }

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    if (part === undefined || !isMediaFeature(part)) {
      return false; // non-feature after media type = malformed
    }
    features.push(part);
  }

  const matches =
    mediaTypeMatches(mediaType, env) &&
    features.every((f) => mediaFeatureMatches(f, env));

  return negated ? !matches : matches;
}

/** Split a query on top-level `and` (optional surrounding whitespace), respecting parens. */
function splitOnAnd(query: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let i = 0;
  while (i < query.length) {
    const ch = query[i];
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
      const rest = query.slice(i);
      if (/^\s+and\b/i.test(rest) && current.trim().length > 0) {
        parts.push(current.trim());
        current = "";
        i += rest.match(/^\s+and\b/i)![0].length;
        continue;
      }
      if (current.endsWith(")") && /^and\b/i.test(rest)) {
        parts.push(current.trim());
        current = "";
        i += rest.match(/^and\b/i)![0].length;
        continue;
      }
    }
    current += ch;
    i += 1;
  }
  if (current.trim().length > 0) parts.push(current.trim());
  return parts;
}

function mediaTypeMatches(mediaType: string | null, env: MediaEnvironment): boolean {
  if (mediaType === null || mediaType === "all") return true;
  return mediaType === env.type;
}

function isMediaFeature(value: string): boolean {
  return value.startsWith("(") && value.endsWith(")");
}

function mediaFeatureMatches(feature: string, env: MediaEnvironment): boolean {
  // orientation: landscape | portrait
  const orientationMatch = /^\(\s*orientation\s*:\s*(landscape|portrait)\s*\)$/.exec(feature);
  if (orientationMatch !== null) {
    const orientation = env.widthPx >= env.heightPx ? "landscape" : "portrait";
    return orientationMatch[1] === orientation;
  }

  // width / min-width / max-width / height / min-height / max-height: <length>px
  const match = /^\(\s*(min-width|max-width|width|min-height|max-height|height)\s*:\s*([0-9]+(?:\.[0-9]+)?)px\s*\)$/.exec(feature);
  if (match === null) return false;
  const featureName = match[1];
  const rawValue = match[2];
  if (featureName === undefined || rawValue === undefined) return false;
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return false;

  const actual = featureName.endsWith("height") ? env.heightPx : env.widthPx;
  if (featureName.startsWith("min-")) return actual >= value;
  if (featureName.startsWith("max-")) return actual <= value;
  return actual === value; // exact width/height
}
