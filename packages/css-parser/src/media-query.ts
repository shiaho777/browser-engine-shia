/**
 * CSS Media Query evaluation (CSS Conditional Rules 3 + Media Queries 4 range
 * syntax; ROADMAP Phase 2).
 *
 * A media query is a comma-separated list of query conditions. The stylesheet's
 * `@media` block is active iff ANY of the conditions match the current media
 * environment.
 *
 * Grammar (CSS Media Queries Level 4, the subset this engine implements):
 *   media-query-list  = media-query [ "," media-query ]*
 *   media-query       = [ "only" | "not" ]? media-type? [ "and" media-condition ]*
 *                     | media-condition
 *   media-condition   = media-feature | media-condition "and" media-condition
 *                     | media-condition "or" media-condition | "not" media-condition
 *   media-feature     = "(" [ name ":" value | name op value | value op name op value ] ")"
 *
 * Range syntax (MQ4 §4):
 *   (width >= 100px)        — feature compared to value
 *   (100px <= width)        — value compared to feature
 *   (100px <= width < 500px) — double comparison, feature must satisfy both
 *
 * Three layers, deliberately separated:
 *   1. tokenizer  — splits the query string into identifiers, operators, parens
 *   2. parser     — builds a small condition AST (feature/or/and/not)
 *   3. evaluator  — data-driven predicates per feature against MediaEnvironment
 *
 * Unknown or unsupported features are treated as NON-MATCHING (the query is
 * skipped, never silently passed — constitution: no silent success).
 */

/**
 * The media environment the engine renders for. Defaults model a desktop
 * screen browser; callers pass layout-real values.
 */
export interface MediaEnvironment {
  readonly type: "screen" | "print" | "all";
  readonly widthPx: number;
  readonly heightPx: number;
  /** Whether the primary input can hover over elements (desktop: true). */
  readonly hover?: boolean;
  /** Whether the primary pointer is fine (mouse/trackpad) vs coarse (touch). */
  readonly pointerFine?: boolean;
  /** The user's color scheme preference. */
  readonly colorScheme?: "light" | "dark";
  /** Whether the user prefers reduced motion. */
  readonly reducedMotion?: boolean;
  /** Whether the user prefers reduced data usage. */
  readonly reducedData?: boolean;
  /** The display mode (browser window vs standalone app). */
  readonly displayMode?: "browser" | "fullscreen" | "minimal-ui" | "standalone";
}

/** The default screen media environment (matches the layout default 800×600). */
export const DEFAULT_MEDIA_ENVIRONMENT: MediaEnvironment = Object.freeze({
  type: "screen",
  widthPx: 800,
  heightPx: 600,
  hover: true,
  pointerFine: true,
  colorScheme: "light",
  reducedMotion: false,
  reducedData: false,
  displayMode: "browser",
});

// ---------------------------------------------------------------------------
// Layer 1: tokenizer
// ---------------------------------------------------------------------------

type ComparisonOp = "<" | "<=" | ">" | ">=" | "=";

/** One token of a media query. */
type Token =
  | { readonly kind: "ident"; readonly value: string }
  | { readonly kind: "value"; readonly value: string } // 100px, dark, fine, 1.5
  | { readonly kind: "op"; readonly value: ComparisonOp }
  | { readonly kind: "("; }
  | { readonly kind: ")"; }
  | { readonly kind: ":"; }
  | { readonly kind: "and"; }
  | { readonly kind: "or"; }
  | { readonly kind: "not"; }
  | { readonly kind: "only"; }
  | { readonly kind: "comma"; };

/** Tokenize a media query string (lowercased for case-insensitive matching). */
function tokenize(input: string): readonly Token[] | null {
  const src = input.toLowerCase();
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === undefined) break;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "(") { tokens.push({ kind: "(" }); i += 1; continue; }
    if (ch === ")") { tokens.push({ kind: ")" }); i += 1; continue; }
    if (ch === ",") { tokens.push({ kind: "comma" }); i += 1; continue; }
    if (ch === ":") { tokens.push({ kind: ":" }); i += 1; continue; }
    if (ch === "<" || ch === ">") {
      const next = src[i + 1];
      if (next === "=") {
        tokens.push({ kind: "op", value: ch === "<" ? "<=" : ">=" });
        i += 2;
      } else {
        tokens.push({ kind: "op", value: ch === "<" ? "<" : ">" });
        i += 1;
      }
      continue;
    }
    if (ch === "=") {
      tokens.push({ kind: "op", value: "=" });
      i += 1;
      continue;
    }
    // Identifier or value: [a-z0-9_.%-]+ (covers "width", "100px", "dark",
    // "prefers-color-scheme", "1.5", "-0.5em").
    const rest = src.slice(i);
    const identMatch = /^[a-z0-9_.%-]+/.exec(rest);
    if (identMatch === null) return null; // unrecognized character
    const word = identMatch[0];
    if (word === "and") tokens.push({ kind: "and" });
    else if (word === "or") tokens.push({ kind: "or" });
    else if (word === "not") tokens.push({ kind: "not" });
    else if (word === "only") tokens.push({ kind: "only" });
    else if (/^[a-z]/.test(word)) tokens.push({ kind: "ident", value: word });
    else tokens.push({ kind: "value", value: word });
    i += word.length;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Layer 2: parser (condition AST)
// ---------------------------------------------------------------------------

type FeatureValue = { readonly kind: "plain"; readonly name: string; readonly value: string }
  | { readonly kind: "range"; readonly name: string; readonly left: { readonly op: ComparisonOp; readonly value: string } | null; readonly right: { readonly op: ComparisonOp; readonly value: string } | null };

type Condition =
  | { readonly kind: "feature"; readonly feature: FeatureValue }
  | { readonly kind: "and"; readonly parts: readonly Condition[] }
  | { readonly kind: "or"; readonly parts: readonly Condition[] }
  | { readonly kind: "not"; readonly inner: Condition };

/** Parser state over the token stream. */
interface Parser {
  readonly tokens: readonly Token[];
  pos: number;
}

function peek(p: Parser): Token | undefined {
  return p.tokens[p.pos];
}

function consume(p: Parser): Token | undefined {
  return p.tokens[p.pos++];
}

/** Parse a comma-separated media query LIST: query ["," query]*. */
function parseQueryList(input: string): readonly (Condition | null)[] | null {
  const tokens = tokenize(input);
  if (tokens === null) return null;
  const queries: (Condition | null)[] = [];
  let current: Token[] = [];
  for (const token of tokens) {
    if (token.kind === "comma") {
      queries.push(parseQueryTokens(current));
      current = [];
    } else {
      current.push(token);
    }
  }
  queries.push(parseQueryTokens(current));
  return queries;
}

/**
 * Parse one media query's tokens into a condition (or null for a pure
 * media-type query that matches by type).
 */
function parseQueryTokens(tokens: readonly Token[]): Condition | null {
  if (tokens.length === 0) return null;
  const p: Parser = { tokens, pos: 0 };
  let negated = false;
  let mediaType: string | null = null;

  // Leading [only|not] media-type?
  const first = peek(p);
  if (first !== undefined && (first.kind === "only" || first.kind === "not")) {
    consume(p);
    if (first.kind === "not") negated = true;
    const next = peek(p);
    if (next !== undefined && next.kind === "ident" && !isMediaType(next.value)) {
      // `not (width >= 100px)` — negated condition, no media type
      const inner = parseCondition(p);
      return inner === null ? null : { kind: "not", inner };
    }
    if (next !== undefined && next.kind === "ident" && isMediaType(next.value)) {
      mediaType = next.value;
      consume(p);
    }
  } else if (first !== undefined && first.kind === "ident" && isMediaType(first.value)) {
    mediaType = first.value;
    consume(p);
  }

  // Rest: ["and" condition]+ (when a media type was present) or a bare
  // condition sequence (no media type — `and`/`or` join the features).
  if (mediaType !== null) {
    const features: Condition[] = [];
    while (peek(p)?.kind === "and") {
      consume(p);
      const cond = parseCondition(p);
      if (cond === null) return null;
      features.push(cond);
    }
    if (p.pos !== p.tokens.length) return null; // leftover tokens = malformed
    const typeMatch: Condition = { kind: "feature", feature: { kind: "plain", name: "__type", value: mediaType } };
    const condition: Condition = features.length > 0
      ? { kind: "and", parts: [typeMatch, ...features] }
      : typeMatch;
    return negated ? { kind: "not", inner: condition } : condition;
  }
  const rest = parseConditionSequence(p);
  if (rest === null) return null;
  return negated ? { kind: "not", inner: rest } : rest;
}

function isMediaType(word: string): boolean {
  return word === "screen" || word === "print" || word === "all";
}

/** Parse [condition ("and"|"or") condition]* — left-associative, no precedence. */
function parseConditionSequence(p: Parser): Condition | null {
  let left = parseCondition(p);
  if (left === null) return null;
  for (;;) {
    const next = peek(p);
    if (next === undefined) break;
    if (next.kind === "and") {
      consume(p);
      const right = parseCondition(p);
      if (right === null) return null;
      left = left.kind === "and"
        ? { kind: "and", parts: [...left.parts, right] }
        : { kind: "and", parts: [left, right] };
      continue;
    }
    if (next.kind === "or") {
      consume(p);
      const right = parseCondition(p);
      if (right === null) return null;
      left = left.kind === "or"
        ? { kind: "or", parts: [...left.parts, right] }
        : { kind: "or", parts: [left, right] };
      continue;
    }
    break;
  }
  // All tokens must be consumed; leftovers mean malformed input.
  return p.pos === p.tokens.length ? left : null;
}

/** Parse one condition: "(" ... ")" | "not" condition. */
function parseCondition(p: Parser): Condition | null {
  const next = peek(p);
  if (next === undefined) return null;
  if (next.kind === "not") {
    consume(p);
    const inner = parseCondition(p);
    return inner === null ? null : { kind: "not", inner };
  }
  if (next.kind !== "(") return null;
  consume(p);
  const inner = parseParenContents(p);
  if (inner === null) return null;
  const close = peek(p);
  if (close === undefined || close.kind !== ")") return null;
  consume(p);
  return inner;
}

/**
 * Parse the contents of one parenthesized feature. Forms:
 *   name ":" value                 — plain (min-width: 800px)
 *   name op value                  — range (width >= 100px)
 *   value op name                  — range (100px <= width)
 *   value op name op value         — double range (100px <= width < 500px)
 *   condition ("and"|"or") condition — nested (not handled: MQ4 general
 *                                     encapsulation is a follow-up)
 */
function parseParenContents(p: Parser): Condition | null {
  // Scan the tokens until the matching ")" and classify by shape.
  const start = p.pos;
  let depth = 0;
  let end = start;
  while (end < p.tokens.length) {
    const t = p.tokens[end];
    if (t === undefined) break;
    if (t.kind === "(") depth += 1;
    if (t.kind === ")") {
      if (depth === 0) break;
      depth -= 1;
    }
    end += 1;
  }
  const inner = p.tokens.slice(start, end);
  p.pos = end;
  if (inner.length === 0) return null;

  // Nested parenthesized condition: "(" condition ")" inside — evaluate as a
  // group by recursing on the inner tokens (strips the outer parens).
  const first = inner[0];
  if (first !== undefined && first.kind === "not") {
    const sub: Parser = { tokens: inner.slice(1), pos: 0 };
    const innerCond = parseCondition(sub);
    if (innerCond === null || sub.pos !== sub.tokens.length) return null;
    return { kind: "not", inner: innerCond };
  }

  // Shape 1: ident ":" value  (plain feature)
  if (inner.length === 3 && inner[0]?.kind === "ident" && inner[1]?.kind === ":" && isValueToken(inner[2])) {
    return { kind: "feature", feature: { kind: "plain", name: inner[0].value, value: (inner[2] as { value: string }).value } };
  }
  // Shape 2: ident op value  (range: width >= 100px)
  if (inner.length === 3 && inner[0]?.kind === "ident" && inner[1]?.kind === "op" && isValueToken(inner[2])) {
    return {
      kind: "feature",
      feature: {
        kind: "range",
        name: inner[0].value,
        left: null,
        right: { op: inner[1].value, value: (inner[2] as { value: string }).value },
      },
    };
  }
  // Shape 3: value op ident  (range: 100px <= width)
  if (inner.length === 3 && isValueToken(inner[0]) && inner[1]?.kind === "op" && inner[2]?.kind === "ident") {
    return {
      kind: "feature",
      feature: {
        kind: "range",
        name: inner[2].value,
        left: { op: flipOp(inner[1].value), value: (inner[0] as { value: string }).value },
        right: null,
      },
    };
  }
  // Shape 4: value op ident op value  (double range: 100px <= width < 500px)
  if (
    inner.length === 5 && isValueToken(inner[0]) && inner[1]?.kind === "op" &&
    inner[2]?.kind === "ident" && inner[3]?.kind === "op" && isValueToken(inner[4])
  ) {
    return {
      kind: "feature",
      feature: {
        kind: "range",
        name: inner[2].value,
        left: { op: flipOp(inner[1].value), value: (inner[0] as { value: string }).value },
        right: { op: inner[3].value, value: (inner[4] as { value: string }).value },
      },
    };
  }
  return null; // unrecognized feature shape
}

function isValueToken(t: Token | undefined): boolean {
  return t !== undefined && (t.kind === "value" || t.kind === "ident");
}

/** Flip a comparison operator (used when the value comes first). */
function flipOp(op: ComparisonOp): ComparisonOp {
  switch (op) {
    case "<": return ">";
    case "<=": return ">=";
    case ">": return "<";
    case ">=": return "<=";
    case "=": return "=";
  }
}

// ---------------------------------------------------------------------------
// Layer 3: evaluator (data-driven feature predicates)
// ---------------------------------------------------------------------------

/**
 * Evaluate a full media query list (comma-separated). Returns `true` if ANY
 * query in the list matches the environment, `false` if none match, and `true`
 * for an empty query (matching the CSS spec: empty = "all").
 */
export function mediaQueryListMatches(queryList: string, env: MediaEnvironment): boolean {
  const trimmed = queryList.trim();
  if (trimmed.length === 0) {
    return true; // no media query = always match (spec: empty = "all")
  }
  const queries = parseQueryList(trimmed);
  if (queries === null) return false;
  return queries.some((q) => q === null ? false : evalCondition(q, env));
}

/**
 * Evaluate a single media query (no commas). A query is:
 *   `[only | not]? <media-type>? [and (<feature>)]*` or a bare condition.
 */
export function mediaQueryMatches(query: string, env: MediaEnvironment): boolean {
  const trimmed = query.trim();
  if (trimmed.length === 0) return false;
  const condition = parseQueryTokens(tokenize(trimmed) ?? []);
  return condition === null ? false : evalCondition(condition, env);
}

function evalCondition(cond: Condition, env: MediaEnvironment): boolean {
  switch (cond.kind) {
    case "and": return cond.parts.every((part) => evalCondition(part, env));
    case "or": return cond.parts.some((part) => evalCondition(part, env));
    case "not": return !evalCondition(cond.inner, env);
    case "feature": return evalFeature(cond.feature, env);
  }
}

/** Evaluate one media feature against the environment (data-driven). */
function evalFeature(feature: FeatureValue, env: MediaEnvironment): boolean {
  if (feature.kind === "plain") {
    return evalPlainFeature(feature.name, feature.value, env);
  }
  // Range feature: the feature's actual value must satisfy every comparison.
  const actual = featureNumericValue(feature.name, env);
  if (actual === null) return false; // unknown or non-numeric feature
  if (feature.left !== null && !compare(actual, feature.left.op, feature.left.value)) return false;
  if (feature.right !== null && !compare(actual, feature.right.op, feature.right.value)) return false;
  return true;
}

/** The numeric value of a range-capable feature, or null if unknown. */
function featureNumericValue(name: string, env: MediaEnvironment): number | null {
  switch (name) {
    case "width": return env.widthPx;
    case "height": return env.heightPx;
    default: return null; // unknown features never match (no silent pass)
  }
}

function compare(actual: number, op: ComparisonOp, rawValue: string): boolean {
  const value = parsePx(rawValue);
  if (value === null) return false;
  switch (op) {
    case "<": return actual < value;
    case "<=": return actual <= value;
    case ">": return actual > value;
    case ">=": return actual >= value;
    case "=": return actual === value;
  }
}

/** Parse a px length ("800px", "12.5px") to a number; bare "0" is 0. */
function parsePx(raw: string): number | null {
  if (raw === "0") return 0;
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(raw);
  if (match === null) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

/** Evaluate a `name: value` feature (prefix syntax + enumerated features). */
function evalPlainFeature(name: string, value: string, env: MediaEnvironment): boolean {
  // Internal media-type pseudo-feature (from parseQueryTokens).
  if (name === "__type") {
    return value === "all" || value === env.type;
  }

  switch (name) {
    // Viewport sizes (prefix syntax).
    case "min-width": { const v = parsePx(value); return v !== null && env.widthPx >= v; }
    case "max-width": { const v = parsePx(value); return v !== null && env.widthPx <= v; }
    case "width": { const v = parsePx(value); return v !== null && env.widthPx === v; }
    case "min-height": { const v = parsePx(value); return v !== null && env.heightPx >= v; }
    case "max-height": { const v = parsePx(value); return v !== null && env.heightPx <= v; }
    case "height": { const v = parsePx(value); return v !== null && env.heightPx === v; }
    // Orientation.
    case "orientation": {
      const orientation = env.widthPx >= env.heightPx ? "landscape" : "portrait";
      return value === orientation;
    }
    // Input capabilities.
    case "hover": return value === (env.hover === true ? "hover" : "none");
    case "any-hover": return value === (env.hover === true ? "hover" : "none");
    case "pointer": {
      if (value === "none") return env.pointerFine !== true;
      if (value === "fine") return env.pointerFine === true;
      if (value === "coarse") return env.pointerFine === false;
      return false;
    }
    case "any-pointer": {
      if (value === "none") return env.pointerFine !== true;
      if (value === "fine") return env.pointerFine === true;
      if (value === "coarse") return env.pointerFine === false;
      return false;
    }
    // User preferences.
    case "prefers-color-scheme": return value === (env.colorScheme ?? "light");
    case "prefers-reduced-motion": return value === (env.reducedMotion === true ? "reduce" : "no-preference");
    case "prefers-reduced-data": return value === (env.reducedData === true ? "reduce" : "no-preference");
    // Display.
    case "display-mode": return value === (env.displayMode ?? "browser");
    case "update": return value === "fast"; // software raster is effectively fast
    default:
      return false; // unknown feature: never match (no silent pass)
  }
}
