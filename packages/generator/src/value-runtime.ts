/**
 * Runtime value-parsing helpers (design.md §8.5).
 *
 * These are the small, hand-written primitives that the *generated* CSS parser
 * delegates to. The generator emits one parsing function per property whose
 * body is a single call into the matching helper here (chosen by the property's
 * {@link ValueGrammar}). Keeping the primitives hand-written and the per-
 * property wiring generated is what makes "add a property = add a data row"
 * true (Requirement 6.5): a new property reuses an existing primitive, so no
 * new hand-written parsing code is required.
 *
 * Every helper returns a discriminated {@link ParseResult} rather than throwing,
 * so the generated parser can report a parse failure for one declaration
 * without derailing the rest of the stylesheet (Requirement 13.1, applied by
 * the CSS parser in task 3.3).
 */
import { px, type Color, type DisplayValue, type Edges, type Px } from "@browser-engine/ir";
import type { LengthOrAuto, TransformValue } from "./value-grammar.js";

/** A successful or failed parse of one CSS value. */
export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

/** Build a success result. */
export function ok<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}

/** Build a failure result carrying a human-readable reason. */
export function err<T>(reason: string): ParseResult<T> {
  return { ok: false, reason };
}

/** Collapse runs of whitespace and trim, lowercasing for keyword matching. */
function normalize(input: string): string {
  return input.trim().replace(/\s+/g, " ");
}

// ---- keyword ---------------------------------------------------------------

/**
 * Parse `input` as one of `keywords` (case-insensitive). The returned string is
 * the canonical (lowercased) keyword.
 */
export function parseKeyword(
  input: string,
  keywords: readonly string[],
): ParseResult<string> {
  const token = normalize(input).toLowerCase();
  return keywords.includes(token)
    ? ok(token)
    : err(`expected one of ${keywords.join(" | ")}, got "${input.trim()}"`);
}

/**
 * Parse `input` as a {@link DisplayValue}. A thin wrapper over
 * {@link parseKeyword} that narrows the result to the IR's display union, used
 * by the generated `display` parser.
 */
export function parseDisplay(
  input: string,
  keywords: readonly string[],
): ParseResult<DisplayValue> {
  const result = parseKeyword(input, keywords);
  return result.ok ? ok(result.value as DisplayValue) : result;
}

// ---- length ----------------------------------------------------------------

/**
 * A CSS font-/root-/viewport-relative length that CANNOT be resolved to `px` at
 * parse time because it depends on context (font size, or the viewport size). It
 * is the SPECIFIED value; the cascade resolves it to a {@link Px} computed value
 * once the context is known (`em` → element font size, `rem` → root font size,
 * `vw`/`vh`/`vmin`/`vmax` → a percentage of the viewport's width/height/min/max).
 * Absolute units (`px`, `pt`, `pc`, `in`, `cm`, `mm`, `Q`) are resolved to `px`
 * immediately at parse time and never produce this shape.
 */
export interface SpecifiedLength {
  readonly kind: "specified-length";
  readonly value: number;
  readonly unit: "em" | "rem" | "ex" | "ch" | "ic" | "vw" | "vh" | "vmin" | "vmax" | "%";
}

/** Narrow a value to a {@link SpecifiedLength} (an unresolved relative length). */
export function isSpecifiedLength(v: unknown): v is SpecifiedLength {
  return typeof v === "object" && v !== null && (v as { kind?: unknown }).kind === "specified-length";
}

// ---------------------------------------------------------------------------
// calc() support (CSS Values 4 §10).
// ---------------------------------------------------------------------------

/**
 * A node in a `calc()` expression AST. Each leaf is either a resolved `Px`
 * (absolute length already in px) or a {@link SpecifiedLength} (relative,
 * resolved by the cascade). Internal nodes are `+`/`-`/`*`/`/` operations.
 */
export type CalcNode =
  | { readonly type: "px"; readonly value: number }
  | { readonly type: "len"; readonly value: number; readonly unit: SpecifiedLength["unit"] }
  | { readonly type: "num"; readonly value: number }
  | { readonly type: "add"; readonly left: CalcNode; readonly right: CalcNode }
  | { readonly type: "sub"; readonly left: CalcNode; readonly right: CalcNode }
  | { readonly type: "mul"; readonly left: CalcNode; readonly right: CalcNode }
  | { readonly type: "div"; readonly left: CalcNode; readonly right: CalcNode };

/**
 * A `calc()` expression that cannot be fully resolved at parse time because it
 * contains relative-length operands. The cascade resolves it to `Px` once the
 * `em`/`rem`/`vw`/`vh`/`vmin`/`vmax` context is known.
 */
export interface SpecifiedCalc {
  readonly kind: "specified-calc";
  readonly ast: CalcNode;
}

/** Narrow a value to a {@link SpecifiedCalc} (an unresolved calc() expression). */
export function isSpecifiedCalc(v: unknown): v is SpecifiedCalc {
  return typeof v === "object" && v !== null && (v as { kind?: unknown }).kind === "specified-calc";
}

/**
 * Tokenize a `calc()` inner expression into numbers, units, operators, and
 * parentheses. Whitespace is collapsed; `+` and `-` need surrounding whitespace
 * per spec (to disambiguate from signs), but `*` and `/` do not.
 */
function tokenizeCalc(expr: string): string[] | null {
  const tokens: string[] = [];
  let i = 0;
  const len = expr.length;
  while (i < len) {
    const ch = expr[i];
    if (ch === undefined) break;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f") {
      i += 1;
      continue;
    }
    if (ch === "(" || ch === ")") {
      tokens.push(ch);
      i += 1;
      continue;
    }
    // * and / are single-char operators.
    if (ch === "*" || ch === "/") {
      tokens.push(ch);
      i += 1;
      continue;
    }
    // + and - are operators ONLY when preceded by whitespace or at the start
    // of a sub-expression; otherwise they are part of a signed number.
    if (ch === "+" || ch === "-") {
      const prev = tokens[tokens.length - 1];
      const isOperator =
        prev === undefined || prev === "(" ||
        prev === "+" || prev === "-" || prev === "*" || prev === "/";
      if (isOperator) {
        // Could be a sign on the next number. Peek ahead: if the next non-space
        // char is a digit or dot, treat this as part of a signed number.
        let j = i + 1;
        while (j < len && (expr[j] === " " || expr[j] === "\t")) j += 1;
        const nextCh = expr[j];
        if (nextCh !== undefined && ((nextCh >= "0" && nextCh <= "9") || nextCh === ".")) {
          // Signed number — fall through to number parsing.
        } else {
          tokens.push(ch);
          i += 1;
          continue;
        }
      } else {
        tokens.push(ch);
        i += 1;
        continue;
      }
    }
    // Number (possibly signed) + optional unit.
    const numMatch = /^[-+]?(?:\d+\.?\d*|\.\d+)/.exec(expr.slice(i));
    if (numMatch !== null) {
      const numStr = numMatch[0];
      let j = i + numStr.length;
      // Optional unit.
      const unitMatch = /^[a-z%]+/.exec(expr.slice(j));
      const unitStr = unitMatch !== null ? unitMatch[0] : "";
      if (unitStr.length > 0) j += unitStr.length;
      tokens.push(numStr + unitStr);
      i = j;
      continue;
    }
    return null; // unrecognized token
  }
  return tokens;
}

/** Parser state for recursive-descent parsing of calc() expressions. */
interface CalcParser {
  readonly tokens: readonly string[];
  pos: number;
}

/** Peek the current token without consuming. */
function peek(p: CalcParser): string | undefined {
  return p.tokens[p.pos];
}

/** Consume and return the current token. */
function consume(p: CalcParser): string | undefined {
  return p.tokens[p.pos++];
}

/**
 * Parse a `calc()` expression with standard operator precedence:
 * `*` and `/` bind tighter than `+` and `-`. Parentheses group.
 * Returns the AST root or `null` on a parse error.
 */
function parseCalcExpr(p: CalcParser): CalcNode | null {
  return parseAddSub(p);
}

/** Parse addition and subtraction (lowest precedence). */
function parseAddSub(p: CalcParser): CalcNode | null {
  let left = parseMulDiv(p);
  if (left === null) return null;
  while (peek(p) === "+" || peek(p) === "-") {
    const op = consume(p)!;
    const right = parseMulDiv(p);
    if (right === null) return null;
    left = op === "+" ? { type: "add", left, right } : { type: "sub", left, right };
  }
  return left;
}

/** Parse multiplication and division (higher precedence). */
function parseMulDiv(p: CalcParser): CalcNode | null {
  let left = parsePrimary(p);
  if (left === null) return null;
  while (peek(p) === "*" || peek(p) === "/") {
    const op = consume(p)!;
    const right = parsePrimary(p);
    if (right === null) return null;
    left = op === "*" ? { type: "mul", left, right } : { type: "div", left, right };
  }
  return left;
}

/** Parse a primary: a number+unit, or a parenthesized sub-expression. */
function parsePrimary(p: CalcParser): CalcNode | null {
  const tok = peek(p);
  if (tok === undefined) return null;
  if (tok === "(") {
    consume(p); // consume (
    const inner = parseCalcExpr(p);
    if (peek(p) !== ")") return null;
    consume(p); // consume )
    return inner;
  }
  // A number + optional unit.
  const match = /^([-+]?(?:\d+\.?\d*|\.\d+))([a-z%]*)$/.exec(tok);
  if (match === null) return null;
  consume(p);
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return null;
  const unit = match[2] ?? "";
  if (unit === "") {
    return { type: "num", value: n };
  }
  const factor = ABSOLUTE_PX_PER_UNIT[unit];
  if (factor !== undefined) {
    return { type: "px", value: n * factor };
  }
  if (unit === "em" || unit === "rem" || unit === "ex" || unit === "ch" || unit === "ic" || unit === "vw" || unit === "vh" || unit === "vmin" || unit === "vmax" || unit === "%") {
    return { type: "len", value: n, unit };
  }
  return null; // unsupported unit
}

/**
 * Try to evaluate a calc() AST to a pure number (when all leaves are `px` or
 * `num`). Returns `null` if the AST contains relative-length leaves that need
 * cascade context to resolve.
 */
function tryEvalCalc(ast: CalcNode): number | SpecifiedCalc {
  switch (ast.type) {
    case "px":
      return ast.value;
    case "num":
      return ast.value;
    case "len":
      return { kind: "specified-calc", ast };
    case "add": {
      const l = tryEvalCalc(ast.left);
      const r = tryEvalCalc(ast.right);
      if (typeof l === "number" && typeof r === "number") return l + r;
      return { kind: "specified-calc", ast };
    }
    case "sub": {
      const l = tryEvalCalc(ast.left);
      const r = tryEvalCalc(ast.right);
      if (typeof l === "number" && typeof r === "number") return l - r;
      return { kind: "specified-calc", ast };
    }
    case "mul": {
      const l = tryEvalCalc(ast.left);
      const r = tryEvalCalc(ast.right);
      if (typeof l === "number" && typeof r === "number") return l * r;
      return { kind: "specified-calc", ast };
    }
    case "div": {
      const l = tryEvalCalc(ast.left);
      const r = tryEvalCalc(ast.right);
      if (typeof l === "number" && typeof r === "number" && r !== 0) return l / r;
      return { kind: "specified-calc", ast };
    }
  }
}

/**
 * Parse a `calc(...)` expression string (without the `calc` prefix — just the
 * inner expression). Returns a {@link SpecifiedCalc} (if it contains relative
 * lengths) or a resolved `Px` (if all operands are absolute). Returns `null`
 * on a parse failure.
 */
function parseCalcExpression(expr: string): Px | SpecifiedCalc | null {
  const tokens = tokenizeCalc(expr);
  if (tokens === null || tokens.length === 0) return null;
  const parser: CalcParser = { tokens, pos: 0 };
  const ast = parseCalcExpr(parser);
  if (ast === null) return null;
  // All tokens must be consumed.
  if (parser.pos !== tokens.length) return null;
  const result = tryEvalCalc(ast);
  if (typeof result === "number") {
    return px(result);
  }
  return result;
}

/**
 * Absolute length units and their ratio to one CSS pixel (CSS Values 4 §6.2).
 * `1in = 96px`; the rest derive from that exact definition.
 */
const ABSOLUTE_PX_PER_UNIT: Readonly<Record<string, number>> = {
  px: 1,
  in: 96,
  pc: 16, // 1pc = 1/6 in
  pt: 96 / 72, // 1pt = 1/72 in
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 25.4 / 4, // 1Q = 1/40 cm
};

/**
 * Parse `input` as a CSS `<length>`. Absolute units (`px`/`in`/`pc`/`pt`/`cm`/
 * `mm`/`Q`) and a bare `0` resolve to a branded {@link Px} immediately; the
 * font-relative units `em`/`rem` cannot be resolved without context, so they
 * return a {@link SpecifiedLength} the cascade resolves once the font size is
 * known. A `calc()` expression is parsed into an AST; if all operands are
 * absolute it resolves immediately to `Px`, otherwise it returns a
 * {@link SpecifiedCalc} the cascade resolves. An unknown unit, or a missing
 * unit on a non-zero number, fails.
 */
export function parseLength(input: string): ParseResult<Px | SpecifiedLength | SpecifiedCalc> {
  const token = normalize(input).toLowerCase();
  if (token === "0") {
    return ok(px(0));
  }
  // calc() expression.
  if (token.startsWith("calc(") && token.endsWith(")")) {
    const inner = input.trim().slice(5, -1); // preserve original case for units
    const result = parseCalcExpression(inner);
    if (result === null) {
      return err(`invalid calc() expression "${input.trim()}"`);
    }
    return ok(result);
  }
  const match = /^(-?(?:\d+\.?\d*|\.\d+))([a-z%]+)$/.exec(token);
  if (match === null) {
    return err(`expected a <length>, got "${input.trim()}"`);
  }
  const n = Number(match[1]);
  const unit = match[2] ?? "";
  if (!Number.isFinite(n)) {
    return err(`invalid number in "${input.trim()}"`);
  }
  const factor = ABSOLUTE_PX_PER_UNIT[unit];
  if (factor !== undefined) {
    return ok(px(n * factor));
  }
  if (unit === "em" || unit === "rem" || unit === "ex" || unit === "ch" || unit === "ic" || unit === "vw" || unit === "vh" || unit === "vmin" || unit === "vmax" || unit === "%") {
    return ok({ kind: "specified-length", value: n, unit });
  }
  return err(`unsupported <length> unit "${unit}" in "${input.trim()}"`);
}

/**
 * Parse `input` as a `<length>` or one of `keywords` (e.g. `width: auto`).
 * Keywords are returned verbatim (lowercased); lengths are returned as {@link Px}
 * (absolute) or a {@link SpecifiedLength} (relative, resolved by the cascade).
 */
export function parseLengthOrKeyword(
  input: string,
  keywords: readonly string[],
): ParseResult<LengthOrAuto | SpecifiedLength | SpecifiedCalc> {
  const token = normalize(input).toLowerCase();
  if (keywords.includes(token)) {
    return ok(token as LengthOrAuto);
  }
  const len = parseLength(input);
  return len.ok ? ok(len.value) : err(`expected <length> or ${keywords.join(" | ")}`);
}

// ---- edges (1-to-4 length quad) --------------------------------------------

/**
 * Parse `input` as a 1-to-4 `<length>` quad and expand it to four edges, per
 * the CSS shorthand rules:
 *   - `a`           → top=right=bottom=left=a
 *   - `a b`         → top=bottom=a, right=left=b
 *   - `a b c`       → top=a, right=left=b, bottom=c
 *   - `a b c d`     → top=a, right=b, bottom=c, left=d
 */
export function parseEdgesLength(
  input: string,
  keywords: readonly string[] = [],
): ParseResult<Edges<Px | SpecifiedLength | SpecifiedCalc | string>> {
  // Split on top-level spaces, respecting parentheses (calc() contains spaces).
  const tokens = splitEdgeTokens(normalize(input));
  if (tokens.length < 1 || tokens.length > 4) {
    return err(`expected 1 to 4 <length> values, got ${tokens.length}`);
  }
  const lengths: (Px | SpecifiedLength | SpecifiedCalc | string)[] = [];
  for (const token of tokens) {
    const keyword = keywords.find((word) => word.toLowerCase() === token.toLowerCase());
    if (keyword !== undefined) {
      lengths.push(keyword);
      continue;
    }
    const len = parseLength(token);
    if (!len.ok) {
      return err(len.reason);
    }
    lengths.push(len.value);
  }
  const [a, b = a, c = a, d = b] = lengths as [
    Px | SpecifiedLength | SpecifiedCalc,
    (Px | SpecifiedLength | SpecifiedCalc)?,
    (Px | SpecifiedLength | SpecifiedCalc)?,
    (Px | SpecifiedLength | SpecifiedCalc)?,
  ];
  return ok({ top: a, right: b, bottom: c, left: d });
}

/**
 * Split a 1-to-4 edge value on top-level spaces, respecting parentheses so
 * `calc(10px + 5px)` is treated as a single token. After `normalize`, runs of
 * whitespace are single spaces; we split on a space that is NOT inside `()`.
 */
function splitEdgeTokens(normalized: string): string[] {
  const tokens: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === undefined) break;
    if (ch === "(") {
      depth += 1;
      current += ch;
    } else if (ch === ")") {
      if (depth > 0) depth -= 1;
      current += ch;
    } else if (ch === " " && depth === 0) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

// ---- integer / number ------------------------------------------------------

/** Clamp `n` to the optional inclusive `[min, max]` bounds. */
function clampToBounds(n: number, min?: number, max?: number): number {
  let v = n;
  if (min !== undefined && v < min) v = min;
  if (max !== undefined && v > max) v = max;
  return v;
}

/**
 * Parse `input` as a CSS `<integer>` (an optional sign + decimal digits),
 * clamped to the optional inclusive `[min, max]` bounds. Used by any property
 * whose value is an integer (e.g. `z-index`, a grid track count) — a single
 * reusable primitive, so adding such a property needs no new parsing code.
 */
export function parseInteger(
  input: string,
  bounds: { readonly min?: number; readonly max?: number } = {},
  keywords: readonly string[] = [],
): ParseResult<number | string> {
  const token = normalize(input);
  const keyword = keywords.find((word) => word.toLowerCase() === token.toLowerCase());
  if (keyword !== undefined) return ok(keyword);
  if (/^calc\(/i.test(token) && token.endsWith(")")) {
    const folded = parseCalcExpression(token.slice(5, -1));
    if (typeof folded === "number" && Number.isInteger(folded)) {
      return ok(clampToBounds(folded, bounds.min, bounds.max));
    }
    return err(`expected an <integer>, got "${input.trim()}"`);
  }
  if (!/^[+-]?\d+$/.test(token)) {
    return err(`expected an <integer>, got "${input.trim()}"`);
  }
  const n = Number.parseInt(token, 10);
  if (!Number.isFinite(n)) {
    return err(`invalid integer "${input.trim()}"`);
  }
  return ok(clampToBounds(n, bounds.min, bounds.max));
}

/**
 * Parse `input` as a CSS `<number>` (a decimal, optionally signed, with an
 * optional fractional part), clamped to the optional inclusive `[min, max]`
 * bounds. Used by any numeric property (e.g. `opacity` with `{min:0,max:1}`) —
 * a single reusable primitive.
 */
export function parseNumber(
  input: string,
  bounds: { readonly min?: number; readonly max?: number } = {},
): ParseResult<number> {
  const token = normalize(input);
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(token)) {
    return err(`expected a <number>, got "${input.trim()}"`);
  }
  const n = Number(token);
  if (!Number.isFinite(n)) {
    return err(`invalid number "${input.trim()}"`);
  }
  return ok(clampToBounds(n, bounds.min, bounds.max));
}

// ---- transform -------------------------------------------------------------

/**
 * Parse `input` as a CSS `<transform>`: the keyword `none`, or a SPACE-separated
 * list of transform FUNCTIONS — `translate[XY]`, `scale[XY]`, `rotate`,
 * `skew[XY]`, and `matrix` — composed (left-to-right) into a single 2D affine
 * {@link TransformValue} matrix `[a,b,c,d,e,f]`. Lengths are `px` (or bare `0`);
 * angles accept `deg`/`rad`/`grad`/`turn`. A `%` translate (which needs the box
 * size) or any malformed/unknown function fails the whole value, so the cascade
 * falls back to the initial rather than fabricating a wrong matrix (no stub).
 */
export function parseTransform(input: string): ParseResult<TransformValue> {
  const token = normalize(input).toLowerCase();
  if (token === "none" || token === "") {
    return ok("none");
  }
  const fnRe = /([a-z0-9]+)\(([^)]*)\)/g;
  let acc: Matrix6 = [1, 0, 0, 1, 0, 0];
  let matched = false;
  let consumed = 0;
  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(token)) !== null) {
    matched = true;
    consumed += m[0].length;
    const fn = m[1] as string;
    const args = (m[2] ?? "").split(/[\s,]+/).filter((p) => p.length > 0);
    const next = transformFunctionMatrix(fn, args);
    if (next === null) {
      return err(`unsupported or malformed transform function "${fn}(...)"`);
    }
    acc = multiplyMatrix(acc, next);
  }
  if (!matched) {
    return err(`expected "none" or transform functions, got "${input.trim()}"`);
  }
  // Reject trailing garbage between/after functions (only whitespace allowed).
  const leftover = token.replace(fnRe, "").replace(/\s+/g, "");
  if (leftover.length > 0 || consumed === 0) {
    return err(`malformed transform "${input.trim()}"`);
  }
  return ok(acc);
}

type Matrix6 = readonly [number, number, number, number, number, number];

/** Compose two affine matrices: result applies `n` then `mtx` (CSS left-outermost). */
function multiplyMatrix(mtx: Matrix6, n: Matrix6): Matrix6 {
  const [a1, b1, c1, d1, e1, f1] = mtx;
  const [a2, b2, c2, d2, e2, f2] = n;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

/** Build the affine matrix for one transform function, or `null` if invalid. */
function transformFunctionMatrix(fn: string, args: readonly string[]): Matrix6 | null {
  const len = (s: string | undefined): number | null => {
    if (s === undefined) return null;
    if (s === "0") return 0;
    if (s.endsWith("px")) {
      const n = Number(s.slice(0, -2));
      return Number.isFinite(n) ? n : null;
    }
    return null; // %, em, etc. need context → reject (no silent wrong value).
  };
  const num = (s: string | undefined): number | null => {
    if (s === undefined) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  const ang = (s: string | undefined): number | null => {
    if (s === undefined) return null;
    const match = /^(-?[\d.]+)(deg|rad|grad|turn)?$/.exec(s);
    if (match === null) return null;
    const v = Number(match[1]);
    if (!Number.isFinite(v)) return null;
    switch (match[2]) {
      case "rad":
        return v;
      case "grad":
        return (v * Math.PI) / 200;
      case "turn":
        return v * 2 * Math.PI;
      case "deg":
      default:
        return (v * Math.PI) / 180;
    }
  };
  switch (fn) {
    case "translate": {
      const x = len(args[0]);
      const y = args.length > 1 ? len(args[1]) : 0;
      return x === null || y === null ? null : [1, 0, 0, 1, x, y];
    }
    case "translatex": {
      const x = len(args[0]);
      return x === null ? null : [1, 0, 0, 1, x, 0];
    }
    case "translatey": {
      const y = len(args[0]);
      return y === null ? null : [1, 0, 0, 1, 0, y];
    }
    case "scale": {
      const x = num(args[0]);
      const y = args.length > 1 ? num(args[1]) : x;
      return x === null || y === null ? null : [x, 0, 0, y, 0, 0];
    }
    case "scalex": {
      const x = num(args[0]);
      return x === null ? null : [x, 0, 0, 1, 0, 0];
    }
    case "scaley": {
      const y = num(args[0]);
      return y === null ? null : [1, 0, 0, y, 0, 0];
    }
    case "rotate":
    case "rotatez": {
      const a = ang(args[0]);
      if (a === null) return null;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      return [cos, sin, -sin, cos, 0, 0];
    }
    case "skew": {
      const ax = ang(args[0]);
      const ay = args.length > 1 ? ang(args[1]) : 0;
      return ax === null || ay === null ? null : [1, Math.tan(ay), Math.tan(ax), 1, 0, 0];
    }
    case "skewx": {
      const ax = ang(args[0]);
      return ax === null ? null : [1, 0, Math.tan(ax), 1, 0, 0];
    }
    case "skewy": {
      const ay = ang(args[0]);
      return ay === null ? null : [1, Math.tan(ay), 0, 1, 0, 0];
    }
    case "matrix": {
      if (args.length !== 6) return null;
      const nums = args.map(Number);
      if (nums.some((x) => !Number.isFinite(x))) return null;
      return [nums[0]!, nums[1]!, nums[2]!, nums[3]!, nums[4]!, nums[5]!];
    }
    default:
      return null;
  }
}

// ---- string ----------------------------------------------------------------

/**
 * Parse `input` as a free-form string value: any non-empty token, trimmed with
 * internal whitespace collapsed. A single reusable primitive that unlocks a
 * whole class of string-valued properties (font-family, content, cursor, …)
 * with no new per-property parser. An empty value fails to parse.
 */
export function parseString(input: string): ParseResult<string> {
  const token = normalize(input);
  return token.length > 0 ? ok(token) : err("expected a non-empty value");
}

/** The complete CSS Color 4 named-color keyword table (spec §4.3), plus
 * `transparent`. Stored once as data; `gray`/`grey` and `aqua`/`cyan`-style
 * spec synonyms are separate entries. */
const NAMED_COLORS: Readonly<Record<string, Color>> = Object.fromEntries(
  ([
    ["aliceblue", "#f0f8ff"], ["antiquewhite", "#faebd7"], ["aqua", "#00ffff"],
    ["aquamarine", "#7fffd4"], ["azure", "#f0ffff"], ["beige", "#f5f5dc"],
    ["bisque", "#ffe4c4"], ["black", "#000000"], ["blanchedalmond", "#ffebcd"],
    ["blue", "#0000ff"], ["blueviolet", "#8a2be2"], ["brown", "#a52a2a"],
    ["burlywood", "#deb887"], ["cadetblue", "#5f9ea0"], ["chartreuse", "#7fff00"],
    ["chocolate", "#d2691e"], ["coral", "#ff7f50"], ["cornflowerblue", "#6495ed"],
    ["cornsilk", "#fff8dc"], ["crimson", "#dc143c"], ["cyan", "#00ffff"],
    ["darkblue", "#00008b"], ["darkcyan", "#008b8b"], ["darkgoldenrod", "#b8860b"],
    ["darkgray", "#a9a9a9"], ["darkgreen", "#006400"], ["darkgrey", "#a9a9a9"],
    ["darkkhaki", "#bdb76b"], ["darkmagenta", "#8b008b"], ["darkolivegreen", "#556b2f"],
    ["darkorange", "#ff8c00"], ["darkorchid", "#9932cc"], ["darkred", "#8b0000"],
    ["darksalmon", "#e9967a"], ["darkseagreen", "#8fbc8f"], ["darkslateblue", "#483d8b"],
    ["darkslategray", "#2f4f4f"], ["darkslategrey", "#2f4f4f"], ["darkturquoise", "#00ced1"],
    ["darkviolet", "#9400d3"], ["deeppink", "#ff1493"], ["deepskyblue", "#00bfff"],
    ["dimgray", "#696969"], ["dimgrey", "#696969"], ["dodgerblue", "#1e90ff"],
    ["firebrick", "#b22222"], ["floralwhite", "#fffaf0"], ["forestgreen", "#228b22"],
    ["fuchsia", "#ff00ff"], ["gainsboro", "#dcdcdc"], ["ghostwhite", "#f8f8ff"],
    ["gold", "#ffd700"], ["goldenrod", "#daa520"], ["gray", "#808080"],
    ["green", "#008000"], ["greenyellow", "#adff2f"], ["grey", "#808080"],
    ["honeydew", "#f0fff0"], ["hotpink", "#ff69b4"], ["indianred", "#cd5c5c"],
    ["indigo", "#4b0082"], ["ivory", "#fffff0"], ["khaki", "#f0e68c"],
    ["lavender", "#e6e6fa"], ["lavenderblush", "#fff0f5"], ["lawngreen", "#7cfc00"],
    ["lemonchiffon", "#fffacd"], ["lightblue", "#add8e6"], ["lightcoral", "#f08080"],
    ["lightcyan", "#e0ffff"], ["lightgoldenrodyellow", "#fafad2"], ["lightgray", "#d3d3d3"],
    ["lightgreen", "#90ee90"], ["lightgrey", "#d3d3d3"], ["lightpink", "#ffb6c1"],
    ["lightsalmon", "#ffa07a"], ["lightseagreen", "#20b2aa"], ["lightskyblue", "#87cefa"],
    ["lightslategray", "#778899"], ["lightslategrey", "#778899"], ["lightsteelblue", "#b0c4de"],
    ["lightyellow", "#ffffe0"], ["lime", "#00ff00"], ["limegreen", "#32cd32"],
    ["linen", "#faf0e6"], ["magenta", "#ff00ff"], ["maroon", "#800000"],
    ["mediumaquamarine", "#66cdaa"], ["mediumblue", "#0000cd"], ["mediumorchid", "#ba55d3"],
    ["mediumpurple", "#9370db"], ["mediumseagreen", "#3cb371"], ["mediumslateblue", "#7b68ee"],
    ["mediumspringgreen", "#00fa9a"], ["mediumturquoise", "#48d1cc"], ["mediumvioletred", "#c71585"],
    ["midnightblue", "#191970"], ["mintcream", "#f5fffa"], ["mistyrose", "#ffe4e1"],
    ["moccasin", "#ffe4b5"], ["navajowhite", "#ffdead"], ["navy", "#000080"],
    ["oldlace", "#fdf5e6"], ["olive", "#808000"], ["olivedrab", "#6b8e23"],
    ["orange", "#ffa500"], ["orangered", "#ff4500"], ["orchid", "#da70d6"],
    ["palegoldenrod", "#eee8aa"], ["palegreen", "#98fb98"], ["paleturquoise", "#afeeee"],
    ["palevioletred", "#db7093"], ["papayawhip", "#ffefd5"], ["peachpuff", "#ffdab9"],
    ["peru", "#cd853f"], ["pink", "#ffc0cb"], ["plum", "#dda0dd"],
    ["powderblue", "#b0e0e6"], ["purple", "#800080"], ["rebeccapurple", "#663399"],
    ["red", "#ff0000"], ["rosybrown", "#bc8f8f"], ["royalblue", "#4169e1"],
    ["saddlebrown", "#8b4513"], ["salmon", "#fa8072"], ["sandybrown", "#f4a460"],
    ["seagreen", "#2e8b57"], ["seashell", "#fff5ee"], ["sienna", "#a0522d"],
    ["silver", "#c0c0c0"], ["skyblue", "#87ceeb"], ["slateblue", "#6a5acd"],
    ["slategray", "#708090"], ["slategrey", "#708090"], ["snow", "#fffafa"],
    ["springgreen", "#00ff7f"], ["steelblue", "#4682b4"], ["tan", "#d2b48c"],
    ["teal", "#008080"], ["thistle", "#d8bfd8"], ["tomato", "#ff6347"],
    ["turquoise", "#40e0d0"], ["violet", "#ee82ee"], ["wheat", "#f5deb3"],
    ["white", "#ffffff"], ["whitesmoke", "#f5f5f5"], ["yellow", "#ffff00"],
    ["yellowgreen", "#9acd32"],
  ] as const).map(([name, hex]) => {
    const v = parseHexColor(hex);
    if (!v.ok) throw new Error(`bad named color ${name}`);
    return [name, v.value];
  }),
);
(NAMED_COLORS as Record<string, Color>)["transparent"] = { r: 0, g: 0, b: 0, a: 0 };

function clampChannel(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function clampAlpha(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function parseHexColor(token: string): ParseResult<Color> {
  const hex = token.slice(1);
  const expand = (s: string): string => s + s;
  if (hex.length === 3 || hex.length === 4) {
    const [r, g, b, a = "f"] = [...hex];
    return ok({
      r: parseInt(expand(r as string), 16),
      g: parseInt(expand(g as string), 16),
      b: parseInt(expand(b as string), 16),
      a: parseInt(expand(a), 16) / 255,
    });
  }
  if (hex.length === 6 || hex.length === 8) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    return ok({ r, g, b, a });
  }
  return err(`invalid hex color "${token}"`);
}

function parseFunctionalColor(token: string): ParseResult<Color> {
  const match = /^rgba?\(([^)]*)\)$/.exec(token);
  if (match === null) {
    return err(`invalid color "${token}"`);
  }
  const parts = (match[1] ?? "")
    .split(/[\s,/]+/)
    .filter((p) => p.length > 0)
    .map(Number);
  if (parts.length < 3 || parts.length > 4 || parts.some((n) => !Number.isFinite(n))) {
    return err(`invalid rgb()/rgba() components in "${token}"`);
  }
  const [r, g, b, a = 1] = parts as [number, number, number, number?];
  return ok({
    r: clampChannel(r),
    g: clampChannel(g),
    b: clampChannel(b),
    a: clampAlpha(a),
  });
}

/**
 * Parse `input` as a `<color>`: a named color, a `#hex` (3/4/6/8 digit), or an
 * `rgb()/rgba()` function. Channels are clamped to 0..255 and alpha to 0..1.
 */
export function parseColor(input: string): ParseResult<Color> {
  const token = normalize(input).toLowerCase();
  if (token.length === 0) {
    return err("expected a <color>, got empty value");
  }
  if (Object.prototype.hasOwnProperty.call(NAMED_COLORS, token)) {
    return ok(NAMED_COLORS[token] as Color);
  }
  if (token.startsWith("#")) {
    return parseHexColor(token);
  }
  if (token.startsWith("rgb")) {
    return parseFunctionalColor(token);
  }
  return err(`unrecognized <color> "${input.trim()}"`);
}
