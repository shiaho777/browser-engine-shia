/**
 * Shared `<link rel>` predicates for the wiring layer.
 *
 * A link with both `alternate` and `stylesheet` is a stylesheet candidate, and
 * a link with the boolean `disabled` attribute is explicitly inactive. The
 * render environment is currently screen-like, so print-only links are inactive
 * too. Until style-set selection exists, only active stylesheet links enter
 * resource loading and the author cascade.
 */
import type { DomNode } from "@browser-engine/ir";

interface MediaEnvironment {
  readonly type: "screen";
  readonly widthPx: number;
  readonly heightPx: number;
}

const SCREEN_MEDIA_ENVIRONMENT: MediaEnvironment = Object.freeze({
  type: "screen",
  widthPx: 800,
  heightPx: 600,
});

/** Whether a `<link>` element is an active stylesheet link. */
export function isActiveStylesheetLink(link: DomNode): boolean {
  if (link.kind !== "element" || link.tag !== "link") {
    return false;
  }
  const tokens = relTokens(link.attrs);
  return (
    tokens.has("stylesheet") &&
    !tokens.has("alternate") &&
    link.attrs?.has("disabled") !== true &&
    mediaMatches(link.attrs?.get("media"), SCREEN_MEDIA_ENVIRONMENT)
  );
}

/** Lowercase rel tokens split on ASCII whitespace. */
function relTokens(attrs: ReadonlyMap<string, string> | undefined): ReadonlySet<string> {
  const tokens = new Set<string>();
  for (const token of (attrs?.get("rel") ?? "").toLowerCase().split(/\s+/)) {
    if (token.length > 0) {
      tokens.add(token);
    }
  }
  return tokens;
}

/** Whether the link's media list matches the current render target. */
function mediaMatches(media: string | undefined, environment: MediaEnvironment): boolean {
  if (media === undefined || media.trim().length === 0) {
    return true;
  }
  return media
    .split(",")
    .some((query) => simpleMediaQueryMatches(query.trim().toLowerCase(), environment));
}

/**
 * Minimal honest media-query matching for link activation. It covers media type,
 * `not` / `only`, top-level `and`, and simple viewport/orientation features
 * for the current screen-like target. More complex media queries do not match
 * until the real evaluator grows to cover them.
 */
function simpleMediaQueryMatches(query: string, environment: MediaEnvironment): boolean {
  if (query.length === 0) {
    return false;
  }
  const [firstPart, ...restParts] = query.split(/\s+and\s+/).map((part) => part.trim());
  if (firstPart === undefined) {
    return false;
  }
  let negated = false;
  let normalizedFirst = firstPart;
  if (normalizedFirst.startsWith("only ")) {
    normalizedFirst = normalizedFirst.slice("only ".length).trim();
  } else if (normalizedFirst.startsWith("not ")) {
    negated = true;
    normalizedFirst = normalizedFirst.slice("not ".length).trim();
  }

  const parts = [normalizedFirst, ...restParts];
  const clauses = splitMediaTypeAndFeatures(parts);
  if (clauses === null) {
    return false;
  }

  const matches = (
    mediaTypeMatches(clauses.mediaType, environment) &&
    clauses.features.every((feature) => mediaFeatureMatches(feature, environment))
  );
  return negated ? !matches : matches;
}

function splitMediaTypeAndFeatures(parts: readonly string[]): {
  readonly mediaType: string | null;
  readonly features: readonly string[];
} | null {
  const [first, ...rest] = parts;
  if (first === undefined || first.length === 0) {
    return null;
  }
  if (isMediaFeature(first)) {
    return { mediaType: null, features: parts };
  }
  if (first.includes(" ")) {
    return null;
  }
  return { mediaType: first, features: rest };
}

function mediaTypeMatches(mediaType: string | null, environment: MediaEnvironment): boolean {
  if (mediaType === null || mediaType === "all") {
    return true;
  }
  return mediaType === environment.type;
}

function isMediaFeature(value: string): boolean {
  return value.startsWith("(") && value.endsWith(")");
}

function mediaFeatureMatches(feature: string, environment: MediaEnvironment): boolean {
  const orientationMatch = /^\(\s*orientation\s*:\s*(landscape|portrait)\s*\)$/.exec(feature);
  if (orientationMatch !== null) {
    return orientationMatch[1] === orientationOf(environment);
  }

  const match = /^\(\s*(min-width|max-width|width|min-height|max-height|height)\s*:\s*([0-9]+(?:\.[0-9]+)?)px\s*\)$/.exec(feature);
  if (match === null) {
    return false;
  }
  const featureName = match[1];
  const rawValue = match[2];
  if (featureName === undefined || rawValue === undefined) {
    return false;
  }
  const value = Number(rawValue);
  if (!Number.isFinite(value)) {
    return false;
  }
  const actual = featureName.endsWith("height") ? environment.heightPx : environment.widthPx;
  if (featureName.startsWith("min-")) {
    return actual >= value;
  }
  if (featureName.startsWith("max-")) {
    return actual <= value;
  }
  return actual === value;
}

function orientationOf(environment: MediaEnvironment): "landscape" | "portrait" {
  return environment.widthPx >= environment.heightPx ? "landscape" : "portrait";
}
