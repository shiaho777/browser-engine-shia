/**
 * CSS Typed OM Level 1 (drafts.css-houdini.org/css-typed-om-1) plus the
 * CSSColorValue family — the `CSS.px(…)`/`CSSUnitValue`/`CSSStyleValue`
 * platform surface. Values are reified from cssText through the shared
 * component-value tokenizer; `parsePropertyValue` (generated grammars)
 * validates declarations so unsupported properties and bad values throw
 * `TypeError` exactly where the spec requires.
 *
 * Numeric algebra follows the spec's "type" model: a type is a map of base
 * exponents plus a `percentHint` recording which base type percent resolves
 * to. Addition/subtraction require compatible types; multiplication and
 * division combine exponents; `to()`/`equals()` convert through per-base
 * canonical units.
 */
import { DOMException } from "@browser-engine/guest";
import { parsePropertyValue, expandShorthand, isShorthandName, PROPERTY_PARSERS, parseColor, cssEscape } from "@browser-engine/css-parser";
import { CSS_PROPERTIES } from "@browser-engine/generator";
import { isNotImplemented } from "@browser-engine/ir";

// ---------------------------------------------------------------------------
// Component-value tokenizer
// ---------------------------------------------------------------------------

type Tok =
  | { t: "ws" }
  | { t: "comma" }
  | { t: "number"; v: number; raw: string }
  | { t: "dimension"; v: number; unit: string; raw: string }
  | { t: "percent"; v: number; raw: string }
  | { t: "ident"; name: string }
  | { t: "string"; raw: string }
  | { t: "func"; name: string; body: string }
  | { t: "delim"; ch: string };

const NUM_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
const IDENT_START = /[-_a-zA-Z-￿]/;
const IDENT_CHAR = /[-_a-zA-Z0-9-￿]/;

function tokenize(input: string): Tok[] {
  const s = input;
  const toks: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    // Comments produce no token but DO act as a token boundary — `bar/**/var()`
    // tokenizes as ident + function, never a merged `barvar(`.
    if (ch === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      i = end === -1 ? s.length : end + 2;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f") {
      let j = i + 1;
      while (j < s.length && " \t\n\r\f".includes(s[j]!)) j += 1;
      toks.push({ t: "ws" });
      i = j;
      continue;
    }
    const num = NUM_RE.exec(s.slice(i));
    if (num !== null) {
      const raw = num[0];
      const j = i + raw.length;
      if (s[j] === "%") {
        toks.push({ t: "percent", v: Number(raw), raw: raw + "%" });
        i = j + 1;
        continue;
      }
      let k = j;
      while (k < s.length && IDENT_CHAR.test(s[k]!)) k += 1;
      if (k > j) {
        const unit = s.slice(j, k);
        toks.push({ t: "dimension", v: Number(raw), unit, raw: s.slice(i, k) });
        i = k;
        continue;
      }
      toks.push({ t: "number", v: Number(raw), raw });
      i = j;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== ch) {
        j += s[j] === "\\" ? 2 : 1;
      }
      toks.push({ t: "string", raw: s.slice(i, Math.min(j + 1, s.length)) });
      i = Math.min(j + 1, s.length);
      continue;
    }
    if (
      (ch !== "-" && IDENT_START.test(ch)) ||
      (ch === "-" && IDENT_CHAR.test(s[i + 1] ?? ""))
    ) {
      let j = i + 1;
      while (j < s.length && IDENT_CHAR.test(s[j]!)) j += 1;
      const name = s.slice(i, j);
      if (s[j] === "(") {
        let depth = 1;
        let k = j + 1;
        while (k < s.length && depth > 0) {
          if (s[k] === "(") depth += 1;
          else if (s[k] === ")") depth -= 1;
          else if (s[k] === "'" || s[k] === '"') {
            const q = s[k];
            k += 1;
            while (k < s.length && s[k] !== q) k += s[k] === "\\" ? 2 : 1;
          }
          k += 1;
        }
        toks.push({ t: "func", name: name.toLowerCase(), body: s.slice(j + 1, k - 1) });
        i = k;
        continue;
      }
      toks.push({ t: "ident", name });
      i = j;
      continue;
    }
    if (ch === ",") {
      toks.push({ t: "comma" });
      i += 1;
      continue;
    }
    toks.push({ t: "delim", ch });
    i += 1;
  }
  return toks;
}

function significant(toks: Tok[]): Tok[] {
  return toks.filter((t) => t.t !== "ws");
}

// ---------------------------------------------------------------------------
// Numeric type algebra
// ---------------------------------------------------------------------------

type BaseType = "length" | "angle" | "time" | "frequency" | "resolution" | "flex" | "percent";
type TypeMap = Partial<Record<BaseType, number>>;

interface NumType {
  exps: TypeMap;
  hint: BaseType | null;
}

const UNIT_BASE: Record<string, BaseType> = {
  percent: "percent",
  em: "length", ex: "length", ch: "length", ic: "length", rem: "length",
  lh: "length", rlh: "length",
  cap: "length", rcap: "length", rch: "length", rex: "length", ric: "length",
  vw: "length", vh: "length", vi: "length", vb: "length", vmin: "length", vmax: "length",
  svw: "length", svh: "length", svi: "length", svb: "length", svmin: "length", svmax: "length",
  lvw: "length", lvh: "length", lvi: "length", lvb: "length", lvmin: "length", lvmax: "length",
  dvw: "length", dvh: "length", dvi: "length", dvb: "length", dvmin: "length", dvmax: "length",
  cqw: "length", cqh: "length", cqi: "length", cqb: "length", cqmin: "length", cqmax: "length",
  cm: "length", mm: "length", q: "length", in: "length", pt: "length", pc: "length", px: "length",
  deg: "angle", grad: "angle", rad: "angle", turn: "angle",
  s: "time", ms: "time",
  hz: "frequency", khz: "frequency",
  dpi: "resolution", dpcm: "resolution", dppx: "resolution", x: "resolution",
  fr: "flex",
};

/** Conversion ratios to each base's canonical unit. `null` = not inter-convertible. */
const UNIT_RATIO: Record<string, number> = {
  percent: 1,
  px: 1, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6, pt: 96 / 72, pc: 16,
  deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360,
  s: 1, ms: 1e-3,
  hz: 1, khz: 1e3,
  dppx: 1, dpi: 1 / 96, dpcm: 2.54 / 96, x: 1,
  fr: 1,
  number: 1,
};

const VALID_UNITS = new Set(Object.keys(UNIT_BASE));

function typeOf(v: CSSNumericValue): NumType {
  return v.numericType();
}

function cloneType(t: NumType): NumType {
  return { exps: { ...t.exps }, hint: t.hint };
}

/** Apply the percent hint: a percent exponent moves onto its hinted base. */
function applyHint(t: NumType): NumType {
  const out = cloneType(t);
  const p = out.exps.percent ?? 0;
  if (p !== 0 && out.hint !== null) {
    out.exps[out.hint] = (out.exps[out.hint] ?? 0) + p;
    delete out.exps.percent;
  }
  return out;
}

function nonPercent(t: NumType): TypeMap {
  const m: TypeMap = { ...t.exps };
  delete m.percent;
  return m;
}

function nonZeroKeys(m: TypeMap): BaseType[] {
  return (Object.keys(m) as BaseType[]).filter((k) => (m[k] ?? 0) !== 0);
}

function mapsEqual(a: TypeMap, b: TypeMap): boolean {
  const ka = nonZeroKeys(a);
  const kb = nonZeroKeys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => a[k] === b[k]);
}

function addTypes(a: NumType, b: NumType): NumType | null {
  const a2 = applyHint(a);
  const b2 = applyHint(b);
  const aNP = nonPercent(a2);
  const bNP = nonPercent(b2);
  const aP = (a2.exps.percent ?? 0) !== 0;
  const bP = (b2.exps.percent ?? 0) !== 0;
  const hints: Array<BaseType | null> = [a2.hint, b2.hint];
  const mergedHint = hints[0] ?? hints[1] ?? null;
  if (hints[0] !== null && hints[1] !== null && hints[0] !== hints[1]) return null;

  if (!aP && !bP) {
    if (!mapsEqual(aNP, bNP)) return null;
    return { exps: { ...aNP }, hint: mergedHint };
  }
  if (aP && bP) {
    if (nonZeroKeys(aNP).length !== 0 && nonZeroKeys(bNP).length !== 0 && !mapsEqual(aNP, bNP)) {
      return null;
    }
    const np = nonZeroKeys(aNP).length !== 0 ? aNP : bNP;
    return { exps: { ...np, percent: 1 }, hint: mergedHint };
  }
  // Exactly one side carries percent: it absorbs into the other side's type.
  const pctNP = aP ? aNP : bNP;
  const otherNP = aP ? bNP : aNP;
  if (nonZeroKeys(pctNP).length !== 0 && !mapsEqual(pctNP, otherNP)) return null;
  const keys = nonZeroKeys(otherNP);
  if (keys.length === 0) {
    return { exps: { percent: 1 }, hint: mergedHint };
  }
  if (keys.length > 1) return null;
  const base = keys[0]!;
  if (Math.abs(otherNP[base] ?? 0) !== 1) return null;
  if (mergedHint !== null && mergedHint !== base) return null;
  return { exps: { ...otherNP }, hint: base };
}

function multiplyTypes(a: NumType, b: NumType): NumType | null {
  const out = cloneType(a);
  for (const k of Object.keys(b.exps) as BaseType[]) {
    out.exps[k] = (out.exps[k] ?? 0) + (b.exps[k] ?? 0);
    if (out.exps[k] === 0) delete out.exps[k];
  }
  if (a.hint !== null && b.hint !== null && a.hint !== b.hint) return null;
  out.hint = a.hint ?? b.hint;
  const np = nonZeroKeys(nonPercent(out));
  if ((out.exps.percent ?? 0) !== 0 && np.length === 1) {
    if (out.hint !== null && out.hint !== np[0]) return null;
    out.hint = np[0]!;
  }
  if (np.length === 0 && (out.exps.percent ?? 0) !== 0) {
    // pure percent — fine
  }
  return out;
}

function invertType(t: NumType): NumType {
  const out = cloneType(t);
  for (const k of Object.keys(out.exps) as BaseType[]) {
    out.exps[k] = -(out.exps[k] ?? 0);
  }
  return out;
}

function typeToObject(t: NumType): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const k of ["length", "angle", "time", "frequency", "resolution", "flex", "percent"] as BaseType[]) {
    const v = t.exps[k] ?? 0;
    if (v !== 0) o[k] = v;
  }
  if (t.hint !== null) o["percentHint"] = t.hint;
  return o;
}

function serNumber(v: number): string {
  if (!Number.isFinite(v)) return v > 0 ? "infinity" : v < 0 ? "-infinity" : "NaN";
  return String(v);
}

function numVal(x: unknown): number {
  const n = Number(x);
  if (Number.isNaN(n)) throw new TypeError("value is not a number");
  return n;
}

function toNumeric(x: unknown): CSSNumericValue {
  if (typeof x === "number" || typeof x === "bigint") {
    const n = numVal(x);
    if (!Number.isFinite(n)) throw new TypeError("non-finite number");
    return new CSSUnitValue(n, "number");
  }
  if (x instanceof CSSNumericValue) return x;
  throw new TypeError("expected CSSNumberish");
}

// ---------------------------------------------------------------------------
// CSSStyleValue / CSSKeywordValue
// ---------------------------------------------------------------------------

export class CSSStyleValue {
  /** Base values parsed from cssText carry their serialization here. */
  _cssText: string | undefined;

  constructor() {
    // WebIDL: interfaces without a constructor throw on `new X()`.
    if (new.target === CSSStyleValue) throw new TypeError("Illegal constructor");
  }

  get [Symbol.toStringTag](): string {
    return this.constructor.name;
  }
  /**
   * The property a reified value was created for (spec's
   * [[associatedProperty]] internal slot). StylePropertyMap rejects values
   * associated with a different property.
   */
  _associatedProperty: string | undefined;

  toString(): string {
    if (!(this instanceof CSSStyleValue)) throw new TypeError("Illegal invocation");
    return this._cssText ?? "";
  }
}

/**
 * @internal Runs `ctor`'s constructor against a fresh object whose
 * [[Prototype]] is exactly `ctor.prototype` — internal reification entry point
 * for interfaces whose public constructor is "illegal". Equivalent to
 * `new ctor(...)` minus the new.target === ctor brand check.
 */
function constructInternal<A extends unknown[], R>(
  ctor: new (...a: A) => R,
  ...args: A
): R {
  function NewTarget(this: unknown) {}
  (NewTarget as { prototype: unknown }).prototype = ctor.prototype;
  return Reflect.construct(ctor, args, NewTarget as never);
}

export class CSSKeywordValue extends CSSStyleValue {
  #value: string;

  constructor(value: unknown) {
    super();
    const v = String(value);
    if (v === "") throw new TypeError("CSSKeywordValue requires a non-empty keyword");
    this.#value = v;
  }

  get value(): string {
    return this.#value;
  }

  set value(v: unknown) {
    const s = String(v);
    if (s === "") throw new TypeError("CSSKeywordValue requires a non-empty keyword");
    this.#value = s;
  }

  override toString(): string {
    return cssEscape(this.#value);
  }
}

// ---------------------------------------------------------------------------
// CSSNumericValue + CSSUnitValue + CSSMath*
// ---------------------------------------------------------------------------

export class CSSNumericValue extends CSSStyleValue {
  constructor() {
    super();
    if (new.target === CSSNumericValue) throw new TypeError("Illegal constructor");
  }

  numericType(): NumType {
    return { exps: {}, hint: null };
  }

  add(...values: unknown[]): CSSNumericValue {
    if (values.length === 0) return this;
    const self = this instanceof CSSMathSum ? this.values : [this];
    const terms = [...self, ...values.map(toNumeric)];
    return simplifySum(terms) ?? new CSSMathSum(...terms);
  }

  sub(...values: unknown[]): CSSNumericValue {
    if (values.length === 0) return this;
    const self = this instanceof CSSMathSum ? this.values : [this];
    const terms = [...self, ...values.map((v) => negateOperand(toNumeric(v)))];
    return simplifySum(terms) ?? new CSSMathSum(...terms);
  }

  mul(...values: unknown[]): CSSNumericValue {
    if (values.length === 0) return this;
    const self = this instanceof CSSMathProduct ? this.values : [this];
    const terms = [...self, ...values.map(toNumeric)];
    // CSS has no compound units: every non-number operand must share one base.
    let t = typeOf(terms[0]!);
    for (const v of terms.slice(1)) {
      const merged = multiplyTypes(t, typeOf(v));
      if (merged === null || nonZeroKeys(nonPercent(merged)).length > 1) {
        throw new TypeError("incompatible types in product");
      }
      t = merged;
    }
    return simplifyProduct(terms) ?? new CSSMathProduct(...terms);
  }

  div(...values: unknown[]): CSSNumericValue {
    if (values.length === 0) return this;
    const self = this instanceof CSSMathProduct ? this.values : [this];
    const terms = [...self, ...values.map((v) => invertOperand(toNumeric(v)))];
    let t = typeOf(terms[0]!);
    for (const v of terms.slice(1)) {
      const merged = multiplyTypes(t, typeOf(v));
      if (merged === null || nonZeroKeys(nonPercent(merged)).length > 1) {
        throw new TypeError("incompatible types in quotient");
      }
      t = merged;
    }
    return simplifyProduct(terms) ?? new CSSMathProduct(...terms);
  }

  min(...values: unknown[]): CSSNumericValue {
    if (values.length === 0) return this;
    const self = this instanceof CSSMathMin ? this.values : [this];
    const terms = [...self, ...values.map(toNumeric)];
    return simplifyMinMax(terms, Math.min) ?? new CSSMathMin(...terms);
  }

  max(...values: unknown[]): CSSNumericValue {
    if (values.length === 0) return this;
    const self = this instanceof CSSMathMax ? this.values : [this];
    const terms = [...self, ...values.map(toNumeric)];
    return simplifyMinMax(terms, Math.max) ?? new CSSMathMax(...terms);
  }

  equals(...values: unknown[]): boolean {
    const others = values.map(toNumeric);
    const t = applyHint(this.numericType());
    for (const o of others) {
      if (!numericEquals(this, o, t)) return false;
    }
    return true;
  }

  to(unit: unknown): CSSUnitValue {
    const u = validUnitOrThrow(unit);
    const sum = this.toSum(u);
    const first = sum.values.itemAt(0);
    if (sum.values.length !== 1 || !(first instanceof CSSUnitValue)) {
      throw new TypeError("cannot convert to that unit");
    }
    return first;
  }

  toSum(...units: unknown[]): CSSMathSum {
    const us = units.map(validUnitOrThrow);
    if (us.length > 1) {
      const base = unitKind(us[0]!);
      for (const u of us.slice(1)) {
        if (unitKind(u) !== base) {
          throw new TypeError("toSum units are not all compatible");
        }
      }
    }
    const terms = this instanceof CSSMathSum ? this.values : [this];
    if (us.length === 0) {
      // Each term keeps its own unit; the sum is sorted by unit name.
      const singles: CSSUnitValue[] = [];
      for (const term of terms) {
        const m = convertNumericTo(term, "");
        if (m === null) throw new TypeError("term cannot be reduced to a single unit");
        singles.push(m);
      }
      singles.sort((a, b) => (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0));
      return new CSSMathSum(...singles);
    }
    // One output term per requested unit; each source term goes to the first
    // unit it can convert to, unhit units get 0, unconvertible terms throw.
    const buckets = new Map<string, number>(us.map((u) => [u, 0]));
    for (const term of terms) {
      let hit: CSSUnitValue | null = null;
      for (const u of us) {
        hit = convertNumericTo(term, u);
        if (hit !== null) break;
      }
      if (hit === null) throw new TypeError("cannot convert term to any of the given units");
      buckets.set(hit.unit, (buckets.get(hit.unit) ?? 0) + hit.value);
    }
    return new CSSMathSum(...us.map((u) => new CSSUnitValue(buckets.get(u) ?? 0, u)));
  }

  type(): Record<string, unknown> {
    return typeToObject(this.numericType());
  }

  static parse(cssText: unknown): CSSNumericValue {
    if (cssText === undefined) throw new TypeError("cssText argument is required");
    return parseNumeric(domStr(cssText));
  }
}

function validUnitOrThrow(unit: unknown): string {
  if (unit === undefined) throw new TypeError("unit argument is required");
  const u = domStr(unit).toLowerCase();
  if (u === "number") return u;
  if (!VALID_UNITS.has(u)) throw new DOMException(`"${u}" is not a valid unit`, "SyntaxError");
  return u;
}

function unitKind(u: string): string {
  return u === "number" ? "number" : UNIT_BASE[u]!;
}

/**
 * Fully evaluate a numeric tree to a canonical value: `value` is expressed in
 * each exponent's canonical unit (the one with a UNIT_RATIO entry; units
 * without ratios keep their own name as the key). `exps` maps unit-name →
 * exponent. Returns null when the tree isn't resolvable to a closed form.
 */
function evalNumeric(v: CSSNumericValue): { value: number; exps: Map<string, number> } | null {
  const canonical = (unit: string): { key: string; factor: number } => {
    const r = UNIT_RATIO[unit];
    if (r === undefined || unit === "number") return { key: unit, factor: 1 };
    const canonUnit = Object.keys(UNIT_RATIO).find((u) => UNIT_RATIO[u] === 1 && UNIT_BASE[u] === UNIT_BASE[unit]);
    return { key: canonUnit ?? unit, factor: r };
  };
  const mulExps = (a: Map<string, number>, b: Map<string, number>, sign: 1 | -1): Map<string, number> => {
    const out = new Map(a);
    for (const [k, e] of b) {
      const n = (out.get(k) ?? 0) + sign * e;
      if (n === 0) out.delete(k);
      else out.set(k, n);
    }
    return out;
  };
  const sameExps = (a: Map<string, number>, b: Map<string, number>): boolean => {
    if (a.size !== b.size) return false;
    for (const [k, e] of a) if (b.get(k) !== e) return false;
    return true;
  };
  const foldSameType = (
    vals: CSSNumericValue[],
    pick: (xs: number[]) => number,
  ): { value: number; exps: Map<string, number> } | null => {
    const evs = vals.map(evalNumeric);
    if (evs.some((e) => e === null)) return null;
    const list = evs as Array<{ value: number; exps: Map<string, number> }>;
    for (const e of list.slice(1)) {
      if (!sameExps(list[0]!.exps, e.exps)) return null;
    }
    return { value: pick(list.map((e) => e.value)), exps: list[0]!.exps };
  };
  if (v instanceof CSSUnitValue) {
    if (v.unit === "number") return { value: v.value, exps: new Map() };
    const c = canonical(v.unit);
    return { value: v.value * c.factor, exps: new Map([[c.key, 1]]) };
  }
  if (v instanceof CSSMathNegate) {
    const e = evalNumeric(v.value);
    return e === null ? null : { value: -e.value, exps: e.exps };
  }
  if (v instanceof CSSMathInvert) {
    const e = evalNumeric(v.value);
    if (e === null || e.value === 0) return null;
    return { value: 1 / e.value, exps: mulExps(new Map(), e.exps, -1) };
  }
  if (v instanceof CSSMathProduct) {
    let value = 1;
    let exps = new Map<string, number>();
    for (const term of v.values) {
      const e = evalNumeric(term);
      if (e === null) return null;
      value *= e.value;
      exps = mulExps(exps, e.exps, 1);
    }
    return { value, exps };
  }
  if (v instanceof CSSMathSum) {
    const evs = [...v.values].map(evalNumeric);
    if (evs.some((e) => e === null)) return null;
    const list = evs as Array<{ value: number; exps: Map<string, number> }>;
    for (const e of list.slice(1)) {
      if (!sameExps(list[0]!.exps, e.exps)) return null;
    }
    return { value: list.reduce((s, e) => s + e.value, 0), exps: list[0]!.exps };
  }
  if (v instanceof CSSMathMin) return foldSameType([...v.values], (xs) => Math.min(...xs));
  if (v instanceof CSSMathMax) return foldSameType([...v.values], (xs) => Math.max(...xs));
  if (v instanceof CSSMathClamp) {
    return foldSameType([v.lower, v.value, v.upper], ([l, m, u]) => Math.min(Math.max(m!, l!), u!));
  }
  return null;
}

/** Convert a numeric value to `unit`; `""` means "keep the term's own unit". */
function convertNumericTo(v: CSSNumericValue, unit: string): CSSUnitValue | null {
  const e = evalNumeric(v);
  if (e === null) return null;
  if (unit === "") {
    if (e.exps.size === 0) return new CSSUnitValue(e.value, "number");
    if (e.exps.size !== 1) return null;
    const [key, exp] = [...e.exps][0]!;
    if (exp !== 1) return null;
    return new CSSUnitValue(e.value, key);
  }
  if (unit === "number") {
    return e.exps.size === 0 ? new CSSUnitValue(e.value, "number") : null;
  }
  const rt = UNIT_RATIO[unit];
  if (rt !== undefined) {
    const canonUnit = Object.keys(UNIT_RATIO).find((u) => UNIT_RATIO[u] === 1 && UNIT_BASE[u] === UNIT_BASE[unit]);
    const key = canonUnit ?? unit;
    if (e.exps.size === 1 && e.exps.get(key) === 1) {
      return new CSSUnitValue(e.value / rt, unit);
    }
    return null;
  }
  // Non-ratio unit (em, vw, …): only same-unit terms qualify.
  if (e.exps.size === 1 && e.exps.get(unit) === 1) return new CSSUnitValue(e.value, unit);
  return null;
}

/** All-unit-value same-unit sums fold into a single CSSUnitValue. */
/** Negate an operand for `sub()`: unit values fold, `negate` unwraps. */
function negateOperand(v: CSSNumericValue): CSSNumericValue {
  if (v instanceof CSSUnitValue) return new CSSUnitValue(-v.value, v.unit);
  if (v instanceof CSSMathNegate) return v.value;
  return new CSSMathNegate(v);
}

/**
 * Invert an operand for `div()`: number-typed unit values fold to their
 * reciprocal (a zero throws RangeError), `invert` unwraps; anything else wraps
 * in a CSSMathInvert — CSS has no compound/inverted units.
 */
function invertOperand(v: CSSNumericValue): CSSNumericValue {
  if (v instanceof CSSMathInvert) return v.value;
  if (v instanceof CSSUnitValue && v.unit === "number") {
    if (v.value === 0) throw new RangeError("division by zero");
    return new CSSUnitValue(1 / v.value, "number");
  }
  return new CSSMathInvert(v);
}

/** Sums collapse only when every member is a unit value with the same unit. */
function simplifySum(terms: CSSNumericValue[]): CSSUnitValue | null {
  let unit: string | null = null;
  let acc = 0;
  for (const t of terms) {
    if (!(t instanceof CSSUnitValue)) return null;
    if (unit === null) unit = t.unit;
    if (t.unit !== unit) return null;
    acc += t.value;
  }
  return unit === null ? null : new CSSUnitValue(acc, unit);
}

/** Products collapse when at most one factor has a non-number unit. */
function simplifyProduct(terms: CSSNumericValue[]): CSSUnitValue | null {
  let unit = "number";
  let acc = 1;
  let nonNumbers = 0;
  for (const t of terms) {
    if (!(t instanceof CSSUnitValue)) return null;
    if (t.unit !== "number") {
      nonNumbers += 1;
      if (nonNumbers > 1) return null;
      unit = t.unit;
    }
    acc *= t.value;
  }
  return new CSSUnitValue(acc, unit);
}

function simplifyMinMax(terms: CSSNumericValue[], pick: (...v: number[]) => number): CSSUnitValue | null {
  const flat: CSSUnitValue[] = [];
  const expand = (t: CSSNumericValue): void => {
    if (t instanceof CSSMathMin && pick === Math.min) for (const m of t.values) expand(m);
    else if (t instanceof CSSMathMax && pick === Math.max) for (const m of t.values) expand(m);
    else flat.push(t as CSSUnitValue);
  };
  for (const t of terms) expand(t);
  let unit: string | null = null;
  for (const v of flat) {
    if (!(v instanceof CSSUnitValue)) return null;
    if (unit === null) unit = v.unit;
    if (v.unit !== unit) return null;
  }
  if (unit === null) return null;
  return new CSSUnitValue(pick(...flat.map((t) => t.value)), unit);
}

function canonicalNumeric(v: CSSNumericValue): { map: TypeMap; vals: number[] } | null {
  if (!(v instanceof CSSUnitValue)) return null;
  const base = UNIT_BASE[v.unit];
  if (base === undefined) return null;
  const ratio = UNIT_RATIO[v.unit];
  if (ratio === undefined) return null;
  const map: TypeMap = {};
  map[base] = 1;
  return { map, vals: [v.value * ratio] };
}

function numericEquals(a: CSSNumericValue, b: CSSNumericValue, _t: NumType): boolean {
  const ca = canonicalNumeric(a);
  const cb = canonicalNumeric(b);
  if (ca !== null && cb !== null && mapsEqual(ca.map, cb.map)) {
    return Math.abs(ca.vals[0]! - cb.vals[0]!) < 1e-9 * Math.max(1, Math.abs(ca.vals[0]!));
  }
  return a.toString() === b.toString();
}

export class CSSUnitValue extends CSSNumericValue {
  #value: number;
  #unit: string;

  constructor(value: unknown, unit: unknown) {
    super();
    const n = numVal(value);
    const u = domStr(unit).toLowerCase();
    if (!VALID_UNITS.has(u) && u !== "number") throw new TypeError(`invalid unit "${domStr(unit)}"`);
    this.#value = n;
    this.#unit = u;
  }

  get value(): number {
    return this.#value;
  }

  set value(v: unknown) {
    this.#value = numVal(v);
  }

  get unit(): string {
    return this.#unit;
  }

  override numericType(): NumType {
    const exps: TypeMap = {};
    if (this.#unit !== "number") exps[UNIT_BASE[this.#unit]!] = 1;
    return { exps, hint: null };
  }

  override toString(): string {
    if (this.#unit === "percent") return `${serNumber(this.#value)}%`;
    if (this.#unit === "number") return serNumber(this.#value);
    return `${serNumber(this.#value)}${this.#unit.toString()}`;
  }
}

export class CSSMathValue extends CSSNumericValue {
  constructor() {
    super();
    if (new.target === CSSMathValue) throw new TypeError("Illegal constructor");
  }

  get operator(): string {
    return "";
  }
}

function serMathMember(v: CSSNumericValue, ctx: "sum" | "product" | "toplevel", index: number): string {
  if (v instanceof CSSMathNegate) {
    if (ctx === "sum" && index > 0) return `- ${serMathMember(v.value, "product", 0)}`;
    return `(-${serMathMember(v.value, "product", 0)})`;
  }
  // min()/max()/clamp() arguments ARE <calc-sum>s — a nested sum serializes
  // bare (`max(1 + 2, 3)`), not wrapped in parens or calc().
  if (v instanceof CSSMathSum) return ctx === "toplevel" ? serSum(v) : `(${serSum(v)})`;
  // A nested product serializes as its member list in parens (`(1 * 2)`).
  if (v instanceof CSSMathProduct) return `(${serProduct(v)})`;
  if (v instanceof CSSMathInvert) return ctx === "toplevel" ? serInvert(v) : `(1 / ${serMathMember(v.value, "product", 0)})`;
  // min()/max()/clamp() are self-delimiting function tokens — no parens.
  if (v instanceof CSSMathValue) return v.toString();
  return canonicalLeaf(v).toString();
}

/**
 * Canonical unit table for math-node serialization: mutually convertible
 * absolute units serialize in the type's canonical unit (`turn` → `deg`,
 * `ms` → `s`, `cm` → `px`…). Relative units (`em`, `vw`…) are kept as-is.
 */
const CANONICAL_UNIT: Record<string, readonly [string, number]> = {
  deg: ["deg", 1], grad: ["deg", 0.9], rad: ["deg", 180 / Math.PI], turn: ["deg", 360],
  px: ["px", 1], cm: ["px", 96 / 2.54], mm: ["px", 96 / 25.4], q: ["px", 96 / 101.6],
  in: ["px", 96], pc: ["px", 16], pt: ["px", 96 / 72],
  s: ["s", 1], ms: ["s", 0.001],
  hz: ["hz", 1], khz: ["hz", 1000],
  dppx: ["dppx", 1], dpi: ["dppx", 1 / 96], dpcm: ["dppx", 2.54 / 96], x: ["dppx", 1],
};

function canonicalLeaf(v: CSSNumericValue): CSSNumericValue {
  if (v instanceof CSSUnitValue) {
    const c = CANONICAL_UNIT[v.unit];
    if (c !== undefined && c[0] !== v.unit) return new CSSUnitValue(v.value * c[1], c[0]);
  }
  return v;
}

/** Sum sort key: dimension members sort by unit; everything else keeps order. */
function sumSortKey(v: CSSNumericValue): string {
  const leaf = canonicalLeaf(v);
  return leaf instanceof CSSUnitValue && leaf.unit !== "number" ? leaf.unit : "";
}

function serSum(v: CSSMathSum): string {
  const members = [...v.values]
    .map((m) => canonicalLeaf(m))
    .slice()
    .sort((a, b) => (sumSortKey(a) < sumSortKey(b) ? -1 : sumSortKey(a) > sumSortKey(b) ? 1 : 0));
  return members.map((m, i) => {
    if (i === 0) return serMathMember(m, "sum", 0);
    if (m instanceof CSSMathNegate) return ` - ${serMathMember(m.value, "product", 0)}`;
    // Negative literal terms serialize with `-` (`100% - 32px`).
    if (m instanceof CSSUnitValue && m.value < 0) {
      return ` - ${new CSSUnitValue(-m.value, m.unit).toString()}`;
    }
    return ` + ${serMathMember(m, "sum", i)}`;
  }).join("");
}

function serInvert(v: CSSMathInvert): string {
  return `1 / ${serMathMember(v.value, "product", 0)}`;
}

/** Product member list: `1 / 2 * 3` — inverted members join with `/`. */
function serProduct(v: CSSMathProduct): string {
  const members = [...v.values].map((m) => canonicalLeaf(m));
  let out = "";
  const emit = (s: string): void => {
    out = out === "" ? s : `${out} * ${s}`;
  };
  const render = (m: CSSNumericValue): string => {
    if (m instanceof CSSMathNegate) return `(-${serMathMember(m.value, "product", 0)})`;
    if (m instanceof CSSMathSum) return `(${serSum(m)})`;
    if (m instanceof CSSMathProduct) return `(${serProduct(m)})`;
    if (m instanceof CSSMathInvert) return `(${serInvert(m)})`;
    return m.toString(); // min()/max()/clamp() and leaf values
  };
  for (let i = 0; i < members.length; i++) {
    const m = members[i]!;
    if (m instanceof CSSMathInvert) {
      // `/ x` joins to the following member's serialization; a trailing invert
      // can't use that form and a leading one has nothing to divide into.
      if (out === "" || i === members.length - 1) emit(`(${serInvert(m)})`);
      else out += ` / ${render(m.value)}`;
      continue;
    }
    // Compound math nodes emit in place — number-first sorting only applies
    // within a run of plain unit values.
    if (m instanceof CSSMathValue) {
      emit(render(m));
      continue;
    }
    let j = i;
    while (j < members.length && !(members[j]! instanceof CSSMathValue)) j += 1;
    const run = members.slice(i, j);
    i = j - 1;
    run.sort((a, b) => {
      const an = a instanceof CSSUnitValue && a.unit === "number" ? 0 : 1;
      const bn = b instanceof CSSUnitValue && b.unit === "number" ? 0 : 1;
      return an - bn;
    });
    for (const mm of run) emit(render(mm));
  }
  return out;
}

// ---------------------------------------------------------------------------
// CSSNumericArray — the `values` attribute type of CSSMathSum/Product/Min/Max.
// It has NO public constructor (per the IDL) — instances are only created by
// math values. Platform-object shape: length + indexed getter + iterable.
// ---------------------------------------------------------------------------

// Item storage lives in a WeakMap rather than a private field: methods are
// invoked through the index proxy, and private fields brand-check `this`
// against the proxy (not the target) and fail.
const NUMERIC_ARRAY_ITEMS = new WeakMap<object, readonly CSSNumericValue[]>();

export class CSSNumericArray {
  /** @internal */
  constructor(items?: readonly CSSNumericValue[], internal?: boolean) {
    if (internal !== true) throw new TypeError("Illegal constructor");
    const arr = items ?? [];
    const proxy = new Proxy(this, {
      get(target, prop): unknown {
        if (typeof prop === "string" && /^\d+$/.test(prop)) {
          return target.itemAt(Number(prop));
        }
        return Reflect.get(target, prop, target);
      },
      has(target, prop): boolean {
        if (typeof prop === "string" && /^\d+$/.test(prop)) {
          return target.itemAt(Number(prop)) !== undefined;
        }
        return Reflect.has(target, prop);
      },
      getOwnPropertyDescriptor(target, prop): PropertyDescriptor | undefined {
        if (typeof prop === "string" && /^\d+$/.test(prop)) {
          const item = target.itemAt(Number(prop));
          return item === undefined
            ? undefined
            : { value: item, writable: false, enumerable: true, configurable: true };
        }
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
    });
    NUMERIC_ARRAY_ITEMS.set(this, arr);
    NUMERIC_ARRAY_ITEMS.set(proxy, arr);
    return proxy;
  }

  /** @internal Indexed getter reads. */
  itemAt(index: number): CSSNumericValue | undefined {
    return NUMERIC_ARRAY_ITEMS.get(this)?.[index];
  }

  get length(): number {
    return NUMERIC_ARRAY_ITEMS.get(this)?.length ?? 0;
  }

  *keys(): IterableIterator<number> {
    yield* (NUMERIC_ARRAY_ITEMS.get(this) ?? []).keys();
  }

  *values(): IterableIterator<CSSNumericValue> {
    yield* NUMERIC_ARRAY_ITEMS.get(this) ?? [];
  }

  *entries(): IterableIterator<[number, CSSNumericValue]> {
    yield* (NUMERIC_ARRAY_ITEMS.get(this) ?? []).entries();
  }

  forEach(
    cb: (value: CSSNumericValue, index: number, array: CSSNumericArray) => void,
    ...rest: unknown[]
  ): void {
    (NUMERIC_ARRAY_ITEMS.get(this) ?? []).forEach((v, i) => cb.call(rest[0], v, i, this));
  }

  [Symbol.iterator](): IterableIterator<CSSNumericValue> {
    return (NUMERIC_ARRAY_ITEMS.get(this) ?? [])[Symbol.iterator]();
  }
}

function makeNumericArray(items: readonly CSSNumericValue[]): CSSNumericArray {
  return new CSSNumericArray(items, true);
}

export class CSSMathSum extends CSSMathValue {
  readonly #items: CSSNumericValue[];
  #type: NumType;

  constructor(...args: unknown[]) {
    super();
    if (args.length === 0) throw new TypeError("CSSMathSum requires at least one argument");
    const vals = args.map(toNumeric);
    let t = typeOf(vals[0]!);
    for (const v of vals.slice(1)) {
      const merged = addTypes(t, typeOf(v));
      if (merged === null) throw new TypeError("incompatible types in sum");
      t = merged;
    }
    this.#items = vals;
    this.#type = t;
  }

  get values(): CSSNumericArray {
    return makeNumericArray(this.#items);
  }

  override get operator(): string {
    return "sum";
  }

  override numericType(): NumType {
    return this.#type;
  }

  override toString(): string {
    return `calc(${serSum(this)})`;
  }
}

export class CSSMathProduct extends CSSMathValue {
  readonly #items: CSSNumericValue[];
  #type: NumType;

  constructor(...args: unknown[]) {
    super();
    if (args.length === 0) throw new TypeError("CSSMathProduct requires at least one argument");
    const vals = args.map(toNumeric);
    let t = typeOf(vals[0]!);
    for (const v of vals.slice(1)) {
      const merged = multiplyTypes(t, typeOf(v));
      if (merged === null) throw new TypeError("incompatible types in product");
      t = merged;
    }
    this.#items = vals;
    this.#type = t;
  }

  get values(): CSSNumericArray {
    return makeNumericArray(this.#items);
  }

  override get operator(): string {
    return "product";
  }

  override numericType(): NumType {
    return this.#type;
  }

  override toString(): string {
    return `calc(${serProduct(this)})`;
  }
}

export class CSSMathNegate extends CSSMathValue {
  readonly #value: CSSNumericValue;

  constructor(arg: unknown) {
    super();
    this.#value = toNumeric(arg);
  }

  get value(): CSSNumericValue {
    return this.#value;
  }

  override get operator(): string {
    return "negate";
  }

  override numericType(): NumType {
    return typeOf(this.#value);
  }

  override toString(): string {
    return `calc(-${serMathMember(this.#value, "product", 0)})`;
  }
}

export class CSSMathInvert extends CSSMathValue {
  readonly #value: CSSNumericValue;

  constructor(arg: unknown) {
    super();
    this.#value = toNumeric(arg);
  }

  get value(): CSSNumericValue {
    return this.#value;
  }

  override get operator(): string {
    return "invert";
  }

  override numericType(): NumType {
    return invertType(typeOf(this.#value));
  }

  override toString(): string {
    return `calc(${serInvert(this)})`;
  }
}

function sameTypeList(vals: Iterable<CSSNumericValue>): NumType {
  const list = [...vals];
  let t = typeOf(list[0]!);
  for (const v of list.slice(1)) {
    const merged = addTypes(t, typeOf(v));
    if (merged === null) throw new TypeError("incompatible types");
    t = merged;
  }
  return t;
}

export class CSSMathMin extends CSSMathValue {
  readonly #items: CSSNumericValue[];
  #type: NumType;

  constructor(...args: unknown[]) {
    super();
    if (args.length === 0) throw new TypeError("CSSMathMin requires arguments");
    this.#items = args.map(toNumeric);
    this.#type = sameTypeList(this.#items);
  }

  get values(): CSSNumericArray {
    return makeNumericArray(this.#items);
  }

  override get operator(): string {
    return "min";
  }

  override numericType(): NumType {
    return this.#type;
  }

  override toString(): string {
    return `min(${[...this.values].map((m) => serMathMember(m, "toplevel", 0)).join(", ")})`;
  }
}

export class CSSMathMax extends CSSMathValue {
  readonly #items: CSSNumericValue[];
  #type: NumType;

  constructor(...args: unknown[]) {
    super();
    if (args.length === 0) throw new TypeError("CSSMathMax requires arguments");
    this.#items = args.map(toNumeric);
    this.#type = sameTypeList(this.#items);
  }

  get values(): CSSNumericArray {
    return makeNumericArray(this.#items);
  }

  override get operator(): string {
    return "max";
  }

  override numericType(): NumType {
    return this.#type;
  }

  override toString(): string {
    return `max(${[...this.values].map((m) => serMathMember(m, "toplevel", 0)).join(", ")})`;
  }
}

export class CSSMathClamp extends CSSMathValue {
  readonly #lower: CSSNumericValue;
  readonly #value: CSSNumericValue;
  readonly #upper: CSSNumericValue;
  #type: NumType;

  constructor(lower: unknown, value: unknown, upper: unknown) {
    super();
    this.#lower = toNumeric(lower);
    this.#value = toNumeric(value);
    this.#upper = toNumeric(upper);
    this.#type = sameTypeList([this.#lower, this.#value, this.#upper]);
  }

  get lower(): CSSNumericValue {
    return this.#lower;
  }

  get value(): CSSNumericValue {
    return this.#value;
  }

  get upper(): CSSNumericValue {
    return this.#upper;
  }

  override get operator(): string {
    return "clamp";
  }

  override numericType(): NumType {
    return this.#type;
  }

  override toString(): string {
    return `clamp(${[this.#lower, this.#value, this.#upper].map((m) => serMathMember(m, "toplevel", 0)).join(", ")})`;
  }
}

// ---------------------------------------------------------------------------
// calc() expression parser → CSSMath*
// ---------------------------------------------------------------------------

interface CalcTok {
  kind: "num" | "dim" | "pct" | "op" | "lp" | "rp" | "comma" | "fn";
  v?: number;
  unit?: string;
  op?: string;
  name?: string;
}

function calcTokens(body: string): CalcTok[] {
  const toks = tokenize(body);
  const out: CalcTok[] = [];
  for (const t of toks) {
    if (t.t === "ws") continue;
    if (t.t === "number") out.push({ kind: "num", v: t.v });
    else if (t.t === "dimension") out.push({ kind: "dim", v: t.v, unit: t.unit.toLowerCase() });
    else if (t.t === "percent") out.push({ kind: "pct", v: t.v });
    else if (t.t === "comma") out.push({ kind: "comma" });
    else if (t.t === "func") {
      // Re-tokenize function bodies lazily inside parsePrimary.
      out.push({ kind: "fn", name: t.name });
      // Stash the body on the token for the parser.
      (out[out.length - 1] as CalcTok & { body: string }).body = t.body;
    } else if (t.t === "delim") {
      if (t.ch === "+" || t.ch === "-" || t.ch === "*" || t.ch === "/") out.push({ kind: "op", op: t.ch });
      else if (t.ch === "(") out.push({ kind: "lp" });
      else if (t.ch === ")") out.push({ kind: "rp" });
      else throw new DOMException(`unexpected '${t.ch}' in calc`, "SyntaxError");
    } else {
      throw new DOMException("unexpected token in calc", "SyntaxError");
    }
  }
  return out;
}

class CalcParser {
  #toks: CalcTok[];
  #pos = 0;

  constructor(body: string) {
    this.#toks = calcTokens(body);
  }

  peek(): CalcTok | undefined {
    return this.#toks[this.#pos];
  }

  next(): CalcTok | undefined {
    return this.#toks[this.#pos++];
  }

  atEnd(): boolean {
    return this.#pos >= this.#toks.length;
  }

  parseExpression(): CSSNumericValue {
    let lhs = this.parseProduct();
    for (;;) {
      const t = this.peek();
      if (t === undefined || t.kind !== "op" || (t.op !== "+" && t.op !== "-")) return lhs;
      this.next();
      const rhs = this.parseProduct();
      lhs = foldSum(lhs, t.op === "-" ? negateValue(rhs) : rhs);
    }
  }

  parseProduct(): CSSNumericValue {
    let lhs = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t === undefined || t.kind !== "op" || (t.op !== "*" && t.op !== "/")) return lhs;
      this.next();
      const rhs = this.parseUnary();
      lhs = t.op === "*" ? foldProduct(lhs, rhs) : foldProduct(lhs, invertValue(rhs));
    }
  }

  parseUnary(): CSSNumericValue {
    const t = this.peek();
    if (t !== undefined && t.kind === "op" && (t.op === "-" || t.op === "+")) {
      this.next();
      const v = this.parseUnary();
      return t.op === "-" ? negateValue(v) : v;
    }
    return this.parsePrimary();
  }

  parsePrimary(): CSSNumericValue {
    const t = this.next();
    if (t === undefined) throw new DOMException("unexpected end of calc", "SyntaxError");
    if (t.kind === "num") return new CSSUnitValue(t.v ?? 0, "number");
    if (t.kind === "dim") return new CSSUnitValue(t.v ?? 0, t.unit ?? "px");
    if (t.kind === "pct") return new CSSUnitValue(t.v ?? 0, "percent");
    if (t.kind === "lp") {
      const v = this.parseExpression();
      const close = this.next();
      if (close === undefined || close.kind !== "rp") throw new DOMException("unbalanced (", "SyntaxError");
      return v;
    }
    if (t.kind === "fn") {
      const body = (t as CalcTok & { body: string }).body;
      const name = t.name ?? "";
      if (name === "calc") {
        return new CalcParser(body).parseAll();
      }
      const args = splitCalcArgs(body).map((b) => new CalcParser(b).parseAll());
      if (name === "min") return new CSSMathMin(...args);
      if (name === "max") return new CSSMathMax(...args);
      if (name === "clamp") {
        if (args.length !== 3) throw new DOMException("clamp() takes three arguments", "SyntaxError");
        return new CSSMathClamp(args[0], args[1], args[2]);
      }
      throw new DOMException(`unsupported calc function ${name}()`, "SyntaxError");
    }
    throw new DOMException("unexpected token in calc", "SyntaxError");
  }

  parseAll(): CSSNumericValue {
    const v = this.parseExpression();
    if (!this.atEnd()) throw new DOMException("trailing tokens in calc", "SyntaxError");
    return v;
  }
}

function splitCalcArgs(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

function negateValue(v: CSSNumericValue): CSSNumericValue {
  if (v instanceof CSSUnitValue) return new CSSUnitValue(-v.value, v.unit);
  return new CSSMathNegate(v);
}

function invertValue(v: CSSNumericValue): CSSNumericValue {
  if (v instanceof CSSUnitValue && v.unit === "number" && v.value !== 0) {
    return new CSSUnitValue(1 / v.value, "number");
  }
  return new CSSMathInvert(v);
}

function foldSum(a: CSSNumericValue, b: CSSNumericValue): CSSNumericValue {
  if (a instanceof CSSUnitValue && b instanceof CSSUnitValue) {
    try {
      const conv = b.to(a.unit);
      return new CSSUnitValue(a.value + conv.value, a.unit);
    } catch {
      // incompatible — keep the math node
    }
  }
  const flat = a instanceof CSSMathSum ? a.values : [a];
  return new CSSMathSum(...flat, b);
}

function foldProduct(a: CSSNumericValue, b: CSSNumericValue): CSSNumericValue {
  if (a instanceof CSSUnitValue && b instanceof CSSUnitValue) {
    if (b.unit === "number") return new CSSUnitValue(a.value * b.value, a.unit);
    if (a.unit === "number") return new CSSUnitValue(a.value * b.value, b.unit);
  }
  return new CSSMathProduct(a, b);
}

function parseNumeric(cssText: string): CSSNumericValue {
  const toks = significant(tokenize(cssText));
  if (toks.length !== 1) throw new DOMException("expected a single numeric value", "SyntaxError");
  const t = toks[0]!;
  if (t.t === "number") return new CSSUnitValue(t.v, "number");
  if (t.t === "percent") return new CSSUnitValue(t.v, "percent");
  if (t.t === "dimension") {
    if (!VALID_UNITS.has(t.unit.toLowerCase())) {
      throw new DOMException(`invalid unit ${t.unit}`, "SyntaxError");
    }
    return new CSSUnitValue(t.v, t.unit.toLowerCase());
  }
  if (t.t === "func" && (t.name === "calc" || t.name === "min" || t.name === "max" || t.name === "clamp")) {
    if (t.name === "calc") {
      const inner = new CalcParser(t.body).parseAll();
      return inner instanceof CSSMathValue ? inner : new CSSMathSum(inner);
    }
    const args = splitCalcArgs(t.body).map((b) => new CalcParser(b).parseAll());
    if (t.name === "min") return new CSSMathMin(...args);
    if (t.name === "max") return new CSSMathMax(...args);
    if (args.length !== 3) throw new DOMException("clamp() takes three arguments", "SyntaxError");
    return new CSSMathClamp(args[0], args[1], args[2]);
  }
  throw new DOMException("expected a numeric value", "SyntaxError");
}

// ---------------------------------------------------------------------------
// CSSUnparsedValue / CSSVariableReferenceValue
// ---------------------------------------------------------------------------

export class CSSVariableReferenceValue {
  #variable: string;
  #fallback: CSSUnparsedValue | null;

  constructor(variable: unknown, fallback?: unknown) {
    const v = String(variable);
    if (!/^--.+$/s.test(v)) throw new TypeError("variable must be a custom property name");
    this.#variable = v;
    if (fallback === undefined || fallback === null) {
      this.#fallback = null;
    } else if (fallback instanceof CSSUnparsedValue) {
      this.#fallback = fallback;
    } else {
      throw new TypeError("fallback must be a CSSUnparsedValue");
    }
  }

  get variable(): string {
    return this.#variable;
  }

  set variable(v: unknown) {
    const s = String(v);
    if (!/^--.+$/s.test(s)) throw new TypeError("variable must be a custom property name");
    this.#variable = s;
  }

  get fallback(): CSSUnparsedValue | null {
    return this.#fallback;
  }

  toString(): string {
    return this.#fallback === null
      ? `var(${this.#variable.toString()})`
      : `var(${this.#variable.toString()},${this.#fallback.toString()})`;
  }
}

type UnparsedMember = string | CSSVariableReferenceValue;

function serUnparsedMember(m: UnparsedMember): string {
  return typeof m === "string" ? m : m.toString();
}

function wouldMerge(a: string, b: string): boolean {
  if (a === "" || b === "") return false;
  const last = a[a.length - 1]!;
  const first = b[0]!;
  const identish = (c: string): boolean => /[-\w%]/.test(c) || c.charCodeAt(0) >= 0x80;
  return identish(last) && identish(first);
}

export class CSSUnparsedValue extends CSSStyleValue {
  readonly members: UnparsedMember[];

  constructor(members: Iterable<UnparsedMember>) {
    super();
    this.members = [...members];
    return new Proxy(this, {
      get(target, prop): unknown {
        if (typeof prop === "string" && /^\d+$/.test(prop)) {
          return target.members[Number(prop)];
        }
        return Reflect.get(target, prop, target);
      },
      set(target, prop, value): boolean {
        if (typeof prop === "string" && /^\d+$/.test(prop)) {
          const i = Number(prop);
          if (i > target.members.length) {
            throw new RangeError("index out of range for CSSUnparsedValue");
          }
          if (typeof value !== "string" && !(value instanceof CSSVariableReferenceValue)) {
            throw new TypeError("CSSUnparsedValue members are strings or CSSVariableReferenceValue");
          }
          if (i === target.members.length) target.members.push(value);
          else target.members[i] = value;
          return true;
        }
        return Reflect.set(target, prop, value);
      },
      has(target, prop): boolean {
        if (typeof prop === "string" && /^\d+$/.test(prop)) {
          return Number(prop) < target.members.length;
        }
        return Reflect.has(target, prop);
      },
    });
  }

  get length(): number {
    return this.members.length;
  }

  *keys(): IterableIterator<number> {
    yield* this.members.keys();
  }

  *values(): IterableIterator<UnparsedMember> {
    yield* this.members;
  }

  *entries(): IterableIterator<[number, UnparsedMember]> {
    yield* this.members.entries();
  }

  forEach(
    cb: (value: UnparsedMember, index: number, array: CSSUnparsedValue) => void,
    ...rest: unknown[]
  ): void {
    this.members.forEach((m, i) => cb.call(rest[0], m, i, this));
  }

  *[Symbol.iterator](): Iterator<UnparsedMember> {
    yield* this.members;
  }

  override toString(): string {
    let out = "";
    for (const m of this.members) {
      const s = serUnparsedMember(m);
      if (out !== "" && wouldMerge(out, s)) out += "/**/";
      out += s;
    }
    return out;
  }
}

function parseUnparsed(cssText: string): CSSUnparsedValue {
  const members: UnparsedMember[] = [];
  let cur = "";
  const flush = (): void => {
    if (cur !== "") {
      members.push(cur);
      cur = "";
    }
  };
  // var()/env() references become members at ANY nesting depth — a non-var
  // function contributes its `name(` + `)` as string fragments around the
  // recursively-split body members.
  const append = (text: string): void => {
    for (const t of tokenize(text)) {
      if (t.t === "func" && (t.name === "var" || t.name === "env")) {
        flush();
        members.push(parseVarRef(t.name, t.body));
        continue;
      }
      if (t.t === "func") {
        // `name(` merges into the running string member — `calc(42px + ` is
        // ONE member; a var() in the body flushes it.
        cur += `${t.name}(`;
        append(t.body);
        cur += ")";
        continue;
      }
      cur += tokRaw(t);
    }
  };
  append(cssText);
  flush();
  return new CSSUnparsedValue(members);
}

function tokRaw(t: Tok): string {
  switch (t.t) {
    case "ws": return " ";
    case "comma": return ",";
    case "number": case "dimension": case "percent": return t.raw;
    case "ident": return t.name;
    case "string": return t.raw;
    case "func": return `${t.name}(${t.body})`;
    case "delim": return t.ch;
  }
}

function parseVarRef(_name: string, body: string): CSSVariableReferenceValue {
  const m = /^(\s*)(--[^\s,]+)\s*(?:,([\s\S]*))?$/.exec(body);
  if (m === null) return new CSSVariableReferenceValue("--invalid");
  const variable = m[2]!;
  const fb = m[3];
  return new CSSVariableReferenceValue(
    variable,
    fb === undefined ? undefined : parseUnparsed(fb),
  );
}

// ---------------------------------------------------------------------------
// DOMMatrixReadOnly / DOMMatrix (minimal geometry for transforms)
// ---------------------------------------------------------------------------

export class DOMMatrixReadOnly {
  /** Row-major 4x4: m[row*4+col] = m_{row+1,col+1}; m41/m42/m43 = translation. */
  readonly m: Float64Array;
  #is2D: boolean;

  get is2D(): boolean {
    return this.#is2D;
  }

  constructor(init?: unknown) {
    let a = 1, b = 0, c = 0, d = 1, e = 0, f = 0;
    const is2d = true;
    if (init instanceof DOMMatrixReadOnly) {
      this.m = Float64Array.from(init.m);
      this.#is2D = init.is2D;
      return;
    }
    if (typeof init === "string" && init !== "") {
      const m = /^matrix3d?\(([^)]*)\)$/.exec(init.trim());
      if (m === null) throw new DOMException("invalid matrix string", "SyntaxError");
      const nums = m[1]!.split(",").map((x) => Number(x.trim()));
      const is3d = init.trim().startsWith("matrix3d");
      if (is3d && nums.length === 16) {
        // Spec: the 16-element form lists m11..m44 in order — row-major.
        this.m = Float64Array.from(nums);
        this.#is2D = false;
        return;
      }
      if (!is3d && nums.length === 6) {
        [a, b, c, d, e, f] = nums as [number, number, number, number, number, number];
      } else {
        throw new DOMException("invalid matrix string", "SyntaxError");
      }
    } else if (Array.isArray(init) || ArrayBuffer.isView(init)) {
      const arr = Array.from(init as ArrayLike<number>).map(Number);
      if (arr.length === 6) {
        [a, b, c, d, e, f] = arr as [number, number, number, number, number, number];
      } else if (arr.length === 16) {
        // Row-major input: seq elements are m11..m44 in order.
        this.m = Float64Array.from(arr);
        // 2D iff the 3rd row/column are identity: m13=m14=m23=m24=m31=m32=
        // m34=m43=0 and m33=m44=1 (row-major indices).
        this.#is2D = arr[2] === 0 && arr[3] === 0 && arr[6] === 0 && arr[7] === 0
          && arr[8] === 0 && arr[9] === 0 && arr[11] === 0 && arr[14] === 0
          && arr[10] === 1 && arr[15] === 1;
        return;
      } else {
        throw new TypeError("matrix sequence must have 6 or 16 elements");
      }
    }
    this.m = Float64Array.from([a, b, 0, 0, c, d, 0, 0, 0, 0, 1, 0, e, f, 0, 1]);
    this.#is2D = is2d;
  }

  get a(): number { return this.m[0]!; }
  get b(): number { return this.m[1]!; }
  get c(): number { return this.m[4]!; }
  get d(): number { return this.m[5]!; }
  get e(): number { return this.m[12]!; }
  get f(): number { return this.m[13]!; }
  get m11(): number { return this.m[0]!; }
  get m12(): number { return this.m[1]!; }
  get m13(): number { return this.m[2]!; }
  get m14(): number { return this.m[3]!; }
  get m21(): number { return this.m[4]!; }
  get m22(): number { return this.m[5]!; }
  get m23(): number { return this.m[6]!; }
  get m24(): number { return this.m[7]!; }
  get m31(): number { return this.m[8]!; }
  get m32(): number { return this.m[9]!; }
  get m33(): number { return this.m[10]!; }
  get m34(): number { return this.m[11]!; }
  get m41(): number { return this.m[12]!; }
  get m42(): number { return this.m[13]!; }
  get m43(): number { return this.m[14]!; }
  get m44(): number { return this.m[15]!; }

  /** Internal: mark the matrix as 3D (is2D can only ever go false). */
  markNot2D(): void {
    this.#is2D = false;
  }

  multiply(other?: unknown): DOMMatrix {
    const o = other instanceof DOMMatrixReadOnly ? other : new DOMMatrixReadOnly(other);
    const a = this.m;
    const b = o.m;
    const r = new Float64Array(16);
    for (let row = 0; row < 4; row += 1) {
      for (let col = 0; col < 4; col += 1) {
        let s = 0;
        for (let k = 0; k < 4; k += 1) s += a[row * 4 + k]! * b[k * 4 + col]!;
        r[row * 4 + col] = s;
      }
    }
    const out = new DOMMatrix();
    out.m.set(r);
    if (!o.is2D) out.markNot2D();
    return out;
  }

  translate(x?: unknown, y?: unknown, z?: unknown): DOMMatrix {
    const m = new DOMMatrix();
    m.m[12] = Number(x) || 0;
    m.m[13] = Number(y) || 0;
    m.m[14] = Number(z) || 0;
    if (m.m[14] !== 0) m.markNot2D();
    return this.multiply(m);
  }

  scale(x?: unknown, y?: unknown, z?: unknown, originX?: unknown, originY?: unknown, originZ?: unknown): DOMMatrix {
    const sx = Number(x ?? 1);
    const sy = Number(y ?? sx);
    const sz = Number(z ?? 1);
    const m = new DOMMatrix();
    m.m[0] = sx; m.m[5] = sy; m.m[10] = sz;
    if (sz !== 1) m.markNot2D();
    let out: DOMMatrix = this.multiply(m);
    if (originX !== undefined || originY !== undefined || originZ !== undefined) {
      out = this.translate(originX, originY, originZ).multiply(m).translate(-(Number(originX) || 0), -(Number(originY) || 0), -(Number(originZ) || 0));
    }
    return out;
  }

  rotate(rotX?: unknown, rotY?: unknown, rotZ?: unknown, originX?: unknown, originY?: unknown, originZ?: unknown): DOMMatrix {
    let rx = Number(rotX) || 0;
    let ry = Number(rotY) || 0;
    let rz = Number(rotZ) || 0;
    if (rotY === undefined && rotZ === undefined) { rz = rx; rx = 0; ry = 0; }
    const base: DOMMatrix = originX === undefined && originY === undefined && originZ === undefined
      ? new DOMMatrix([...this.m])
      : this.translate(originX, originY, originZ);
    let m = base;
    if (rz !== 0) {
      const rad = (rz * Math.PI) / 180;
      const cos = Math.cos(rad), sin = Math.sin(rad);
      const r = new DOMMatrix();
      r.m[0] = cos; r.m[1] = sin; r.m[4] = -sin; r.m[5] = cos;
      m = m.multiply(r);
    }
    if (ry !== 0) {
      const rad = (ry * Math.PI) / 180;
      const cos = Math.cos(rad), sin = Math.sin(rad);
      const r = new DOMMatrix();
      r.markNot2D();
      r.m[0] = cos; r.m[2] = -sin; r.m[8] = sin; r.m[10] = cos;
      m = m.multiply(r);
    }
    if (rx !== 0) {
      const rad = (rx * Math.PI) / 180;
      const cos = Math.cos(rad), sin = Math.sin(rad);
      const r = new DOMMatrix();
      r.markNot2D();
      r.m[5] = cos; r.m[6] = sin; r.m[9] = -sin; r.m[10] = cos;
      m = m.multiply(r);
    }
    if (originX !== undefined || originY !== undefined || originZ !== undefined) {
      m = m.translate(-(Number(originX) || 0), -(Number(originY) || 0), -(Number(originZ) || 0));
    }
    return m;
  }

  /** Rodrigues rotation about an arbitrary (unnormalized) axis. */
  rotateAxisAngle(x?: unknown, y?: unknown, z?: unknown, angle?: unknown): DOMMatrix {
    const ax = Number(x) || 0;
    const ay = Number(y) || 0;
    const az = Number(z) || 0;
    const len = Math.hypot(ax, ay, az);
    if (len === 0) return new DOMMatrix([...this.m]);
    const u = ax / len, v = ay / len, w = az / len;
    const rad = (Number(angle) || 0) * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad), t = 1 - cos;
    const r = new DOMMatrix();
    r.markNot2D();
    r.m[0] = t * u * u + cos; r.m[1] = t * u * v + w * sin; r.m[2] = t * u * w - v * sin;
    r.m[4] = t * u * v - w * sin; r.m[5] = t * v * v + cos; r.m[6] = t * v * w + u * sin;
    r.m[8] = t * u * w + v * sin; r.m[9] = t * v * w - u * sin; r.m[10] = t * w * w + cos;
    return this.multiply(r);
  }

  skewX(sx?: unknown): DOMMatrix {
    const r = new DOMMatrix();
    r.m[4] = Math.tan((Number(sx) || 0) * Math.PI / 180);
    return this.multiply(r);
  }

  skewY(sy?: unknown): DOMMatrix {
    const r = new DOMMatrix();
    r.m[1] = Math.tan((Number(sy) || 0) * Math.PI / 180);
    return this.multiply(r);
  }

  flipX(): DOMMatrix {
    return this.scale(-1, 1);
  }

  flipY(): DOMMatrix {
    return this.scale(1, -1);
  }

  inverse(): DOMMatrix {
    const inv = invert4x4(this.m);
    if (inv === null) throw new DOMException("matrix is not invertible", "NotSupportedError");
    const out = new DOMMatrix();
    out.m.set(inv);
    return out;
  }

  transformPoint(point?: unknown): { x: number; y: number; z: number; w: number } {
    const p = (point ?? {}) as { x?: number; y?: number; z?: number; w?: number };
    const x = Number(p.x) || 0;
    const y = Number(p.y) || 0;
    const z = Number(p.z) || 0;
    const w = p.w === undefined ? 1 : Number(p.w);
    const m = this.m;
    return {
      x: m[0]! * x + m[4]! * y + m[8]! * z + m[12]! * w,
      y: m[1]! * x + m[5]! * y + m[9]! * z + m[13]! * w,
      z: m[2]! * x + m[6]! * y + m[10]! * z + m[14]! * w,
      w: m[3]! * x + m[7]! * y + m[11]! * z + m[15]! * w,
    };
  }

  /** Column-major (spec order: m11,m21,m31,m41,m12,…) — NOT the row-major layout. */
  toFloat64Array(): Float64Array {
    const out = new Float64Array(16);
    for (let r = 0; r < 4; r += 1) {
      for (let c = 0; c < 4; c += 1) out[c * 4 + r] = this.m[r * 4 + c]!;
    }
    return out;
  }

  toFloat32Array(): Float32Array {
    return Float32Array.from(this.toFloat64Array());
  }

  toString(): string {
    if (this.is2D) {
      return `matrix(${[this.a, this.b, this.c, this.d, this.e, this.f].map(serNumber).join(", ")})`;
    }
    return `matrix3d(${[...this.m].map(serNumber).join(", ")})`;
  }
}

/** Invert a ROW-major 4x4. Returns null for singular matrices. */
function invert4x4(m: Float64Array): Float64Array | null {
  const n = 4;
  const a: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => m[i * n + j]!));
  const inv: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let col = 0; col < n; col += 1) {
    let piv = col;
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(a[r]![col]!) > Math.abs(a[piv]![col]!)) piv = r;
    }
    if (Math.abs(a[piv]![col]!) < 1e-12) return null;
    [a[col], a[piv]] = [a[piv]!, a[col]!];
    [inv[col], inv[piv]] = [inv[piv]!, inv[col]!];
    const d = a[col]![col]!;
    for (let j = 0; j < n; j += 1) { a[col]![j] = a[col]![j]! / d; inv[col]![j] = inv[col]![j]! / d; }
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const f = a[r]![col]!;
      const ar = a[r]!;
      const ir = inv[r]!;
      const ac = a[col]!;
      const ic = inv[col]!;
      for (let j = 0; j < n; j += 1) {
        ar[j] = ar[j]! - f * ac[j]!;
        ir[j] = ir[j]! - f * ic[j]!;
      }
    }
  }
  const out = new Float64Array(16);
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) out[i * n + j] = inv[i]![j]!;
  }
  return out;
}

export class DOMMatrix extends DOMMatrixReadOnly {
  override set is2D(v: boolean) {
    if (v === false) this.markNot2D();
  }
  override get is2D(): boolean {
    return super.is2D;
  }

  // DOMMatrix is the mutable counterpart: every element assignment writes
  // through to the internal row-major buffer.
  private _set(i: number, v: unknown): void { this.m[i] = Number(v); }
  override get a(): number { return this.m[0]!; } override set a(v: number) { this._set(0, v); }
  override get b(): number { return this.m[1]!; } override set b(v: number) { this._set(1, v); }
  override get c(): number { return this.m[4]!; } override set c(v: number) { this._set(4, v); }
  override get d(): number { return this.m[5]!; } override set d(v: number) { this._set(5, v); }
  override get e(): number { return this.m[12]!; } override set e(v: number) { this._set(12, v); }
  override get f(): number { return this.m[13]!; } override set f(v: number) { this._set(13, v); }
  override get m11(): number { return this.m[0]!; } override set m11(v: number) { this._set(0, v); }
  override get m12(): number { return this.m[1]!; } override set m12(v: number) { this._set(1, v); }
  override get m13(): number { return this.m[2]!; } override set m13(v: number) { this._set(2, v); }
  override get m14(): number { return this.m[3]!; } override set m14(v: number) { this._set(3, v); }
  override get m21(): number { return this.m[4]!; } override set m21(v: number) { this._set(4, v); }
  override get m22(): number { return this.m[5]!; } override set m22(v: number) { this._set(5, v); }
  override get m23(): number { return this.m[6]!; } override set m23(v: number) { this._set(6, v); }
  override get m24(): number { return this.m[7]!; } override set m24(v: number) { this._set(7, v); }
  override get m31(): number { return this.m[8]!; } override set m31(v: number) { this._set(8, v); }
  override get m32(): number { return this.m[9]!; } override set m32(v: number) { this._set(9, v); }
  override get m33(): number { return this.m[10]!; } override set m33(v: number) { this._set(10, v); }
  override get m34(): number { return this.m[11]!; } override set m34(v: number) { this._set(11, v); }
  override get m41(): number { return this.m[12]!; } override set m41(v: number) { this._set(12, v); }
  override get m42(): number { return this.m[13]!; } override set m42(v: number) { this._set(13, v); }
  override get m43(): number { return this.m[14]!; } override set m43(v: number) { this._set(14, v); }
  override get m44(): number { return this.m[15]!; } override set m44(v: number) { this._set(15, v); }

  multiplySelf(other?: unknown): this {
    const r = this.multiply(other);
    this.m.set(r.m);
    if (!r.is2D) this.is2D = false;
    return this;
  }
  preMultiplySelf(other?: unknown): this {
    const r = new DOMMatrixReadOnly(other).multiply(this);
    this.m.set(r.m);
    if (!r.is2D) this.is2D = false;
    return this;
  }
  translateSelf(x?: unknown, y?: unknown, z?: unknown): this {
    const r = this.translate(x, y, z);
    this.m.set(r.m);
    if (!r.is2D) this.is2D = false;
    return this;
  }
  scaleSelf(x?: unknown, y?: unknown, z?: unknown, originX?: unknown, originY?: unknown, originZ?: unknown): this {
    const r = this.scale(x, y, z, originX, originY, originZ);
    this.m.set(r.m);
    if (!r.is2D) this.is2D = false;
    return this;
  }
  scale3dSelf(s?: unknown, originX?: unknown, originY?: unknown, originZ?: unknown): this {
    return this.scaleSelf(s, s, s, originX, originY, originZ);
  }
  scaleNonUniformSelf(x?: unknown, y?: unknown): this {
    return this.scaleSelf(x, y, 1);
  }
  rotateSelf(x?: unknown, y?: unknown, z?: unknown, originX?: unknown, originY?: unknown, originZ?: unknown): this {
    const r = this.rotate(x, y, z, originX, originY, originZ);
    this.m.set(r.m);
    if (!r.is2D) this.is2D = false;
    return this;
  }
  rotateAxisAngleSelf(x?: unknown, y?: unknown, z?: unknown, angle?: unknown): this {
    const r = this.rotateAxisAngle(x, y, z, angle);
    this.m.set(r.m);
    this.is2D = false;
    return this;
  }
  rotateFromVectorSelf(x?: unknown, y?: unknown): this {
    const r = this.multiply(new DOMMatrix().rotate(Math.atan2(Number(y) || 0, Number(x) || 0) * 180 / Math.PI));
    this.m.set(r.m);
    return this;
  }
  skewXSelf(sx?: unknown): this {
    const r = this.skewX(sx);
    this.m.set(r.m);
    return this;
  }
  skewYSelf(sy?: unknown): this {
    const r = this.skewY(sy);
    this.m.set(r.m);
    return this;
  }
  invertSelf(): this {
    const inv = invert4x4(this.m);
    if (inv === null) {
      this.m.fill(NaN);
    } else {
      this.m.set(inv);
    }
    return this;
  }
  setMatrixValue(transformList: unknown): this {
    const r = new DOMMatrixReadOnly(transformList);
    this.m.set(r.m);
    if (!r.is2D) this.is2D = false;
    return this;
  }
  static fromMatrix(other?: unknown): DOMMatrix {
    return new DOMMatrix([...new DOMMatrixReadOnly(other).m]);
  }
  static fromFloat32Array(a: ArrayLike<number>): DOMMatrix {
    const arr = Array.from(a).map(Number);
    if (arr.length !== 16) throw new TypeError("expected 16 elements");
    return new DOMMatrix(arr);
  }
  static fromFloat64Array(a: ArrayLike<number>): DOMMatrix {
    return DOMMatrix.fromFloat32Array(a);
  }
  static fromMatrixInit(init?: unknown): DOMMatrix {
    return DOMMatrix.fromMatrix(init);
  }
}

// ---------------------------------------------------------------------------
// CSSTransformValue + components
// ---------------------------------------------------------------------------

/** Match <length-percentage>: single length exponent, or a percent that may resolve to length. */
function matchLengthPercentage(v: unknown, allowPercent: boolean): CSSNumericValue {
  const n = toNumeric(v);
  const t = typeOf(n);
  const keys = nonZeroKeys(nonPercent(t));
  const hasPct = (t.exps.percent ?? 0) !== 0;
  if (hasPct && t.hint !== null && t.hint !== "length") {
    throw new TypeError("expected <length-percentage>");
  }
  if (keys.length === 0) {
    if (!hasPct || !allowPercent) throw new TypeError("expected <length-percentage>");
    return n;
  }
  if (!(keys.length === 1 && keys[0] === "length" && t.exps.length === 1)) {
    throw new TypeError("expected <length-percentage>");
  }
  if (hasPct && !allowPercent) throw new TypeError("percent not allowed");
  return n;
}

function matchAngle(v: unknown): CSSNumericValue {
  const n = toNumeric(v);
  const t = typeOf(n);
  const keys = nonZeroKeys(t.exps);
  if (!(keys.length === 1 && keys[0] === "angle" && t.exps.angle === 1)) {
    throw new TypeError("expected <angle>");
  }
  return n;
}

function matchNumber(v: unknown): CSSNumericValue {
  const n = toNumeric(v);
  if (nonZeroKeys(typeOf(n).exps).length !== 0) throw new TypeError("expected <number>");
  return n;
}

function matchLengthOnly(v: unknown): CSSNumericValue {
  const n = toNumeric(v);
  const t = typeOf(n);
  const keys = nonZeroKeys(t.exps);
  if (!(keys.length === 1 && keys[0] === "length" && t.exps.length === 1)) {
    throw new TypeError("expected <length>");
  }
  return n;
}

// Per css-typed-om.idl, CSSTransformComponent is a ROOT interface (it does not
// inherit CSSStyleValue) — `transformValue[0]` is not a style value.
export class CSSTransformComponent {
  #is2D: boolean | undefined;

  constructor() {
    if (new.target === CSSTransformComponent) throw new TypeError("Illegal constructor");
  }

  get is2D(): boolean {
    return this.#is2D ?? true;
  }

  /** Setting is2D flattens 3D components; always-2D components ignore `false`. */
  set is2D(v: boolean) {
    this.#is2D = Boolean(v);
  }

  protected _setIs2D(v: boolean): void {
    this.#is2D = v;
  }

  toMatrix(): DOMMatrix {
    return new DOMMatrix();
  }

  toString(): string {
    return "";
  }
}

export class CSSTranslate extends CSSTransformComponent {
  #x: CSSNumericValue;
  #y: CSSNumericValue;
  #z: CSSNumericValue;

  constructor(x: unknown, y: unknown, z?: unknown) {
    super();
    this.#x = matchLengthPercentage(x, true);
    this.#y = matchLengthPercentage(y, true);
    this._setIs2D(z === undefined);
    this.#z = z === undefined ? new CSSUnitValue(0, "px") : matchLengthOnly(z);
  }

  get x(): CSSNumericValue { return this.#x; }
  set x(v: unknown) { this.#x = matchLengthPercentage(v, true); }
  get y(): CSSNumericValue { return this.#y; }
  set y(v: unknown) { this.#y = matchLengthPercentage(v, true); }
  get z(): CSSNumericValue { return this.#z; }
  set z(v: unknown) { this.#z = matchLengthOnly(v); }

  override toMatrix(): DOMMatrix {
    const px = (v: CSSNumericValue): number => {
      if (v instanceof CSSUnitValue && v.unit === "px") return v.value;
      throw new TypeError("toMatrix() cannot resolve non-px lengths");
    };
    return this.is2D
      ? new DOMMatrix().translate(px(this.#x), px(this.#y))
      : new DOMMatrix().translate(px(this.#x), px(this.#y), px(this.#z));
  }

  override toString(): string {
    if (this.is2D) return `translate(${this.#x.toString()}, ${this.#y.toString()})`;
    return `translate3d(${this.#x.toString()}, ${this.#y.toString()}, ${this.#z.toString()})`;
  }
}

export class CSSRotate extends CSSTransformComponent {
  #x: CSSNumericValue;
  #y: CSSNumericValue;
  #z: CSSNumericValue;
  #angle: CSSNumericValue;

  constructor(...args: unknown[]) {
    super();
    if (args.length === 1) {
      this.#angle = matchAngle(args[0]);
      this.#x = new CSSUnitValue(0, "number");
      this.#y = new CSSUnitValue(0, "number");
      this.#z = new CSSUnitValue(1, "number");
      this._setIs2D(true);
    } else if (args.length === 4) {
      this.#x = matchNumber(args[0]);
      this.#y = matchNumber(args[1]);
      this.#z = matchNumber(args[2]);
      this.#angle = matchAngle(args[3]);
      this._setIs2D(false);
    } else {
      throw new TypeError("CSSRotate takes 1 or 4 arguments");
    }
  }

  get x(): CSSNumericValue { return this.#x; }
  set x(v: unknown) { this.#x = matchNumber(v); }
  get y(): CSSNumericValue { return this.#y; }
  set y(v: unknown) { this.#y = matchNumber(v); }
  get z(): CSSNumericValue { return this.#z; }
  set z(v: unknown) { this.#z = matchNumber(v); }
  get angle(): CSSNumericValue { return this.#angle; }
  set angle(v: unknown) { this.#angle = matchAngle(v); }

  override toMatrix(): DOMMatrix {
    const deg = (v: CSSNumericValue): number => {
      if (v instanceof CSSUnitValue) return v.to("deg").value;
      throw new TypeError("toMatrix() cannot resolve non-angle units");
    };
    const a = deg(this.#angle);
    if (this.is2D) return new DOMMatrix().rotate(a);
    const num = (v: CSSNumericValue): number => (v instanceof CSSUnitValue ? v.value : NaN);
    return new DOMMatrix().rotateAxisAngle(num(this.#x), num(this.#y), num(this.#z), a);
  }

  override toString(): string {
    if (this.is2D) return `rotate(${this.#angle.toString()})`;
    return `rotate3d(${this.#x.toString()}, ${this.#y.toString()}, ${this.#z.toString()}, ${this.#angle.toString()})`;
  }
}

export class CSSScale extends CSSTransformComponent {
  #x: CSSNumericValue;
  #y: CSSNumericValue;
  #z: CSSNumericValue;

  constructor(x: unknown, y: unknown, z?: unknown) {
    super();
    this.#x = matchNumber(x);
    this.#y = matchNumber(y);
    this._setIs2D(z === undefined);
    this.#z = z === undefined ? new CSSUnitValue(1, "number") : matchNumber(z);
  }

  get x(): CSSNumericValue { return this.#x; }
  set x(v: unknown) { this.#x = matchNumber(v); }
  get y(): CSSNumericValue { return this.#y; }
  set y(v: unknown) { this.#y = matchNumber(v); }
  get z(): CSSNumericValue { return this.#z; }
  set z(v: unknown) { this.#z = matchNumber(v); }

  override toMatrix(): DOMMatrix {
    const num = (v: CSSNumericValue): number => (v instanceof CSSUnitValue ? v.value : NaN);
    return this.is2D
      ? new DOMMatrix().scale(num(this.#x), num(this.#y))
      : new DOMMatrix().scale(num(this.#x), num(this.#y), num(this.#z));
  }

  override toString(): string {
    if (this.is2D) return `scale(${this.#x.toString()}, ${this.#y.toString()})`;
    return `scale3d(${this.#x.toString()}, ${this.#y.toString()}, ${this.#z.toString()})`;
  }
}

export class CSSSkew extends CSSTransformComponent {
  #ax: CSSNumericValue;
  #ay: CSSNumericValue;

  constructor(ax: unknown, ay: unknown) {
    super();
    this.#ax = matchAngle(ax);
    this.#ay = matchAngle(ay);
  }

  override get is2D(): boolean {
    return true;
  }

  override set is2D(_v: boolean) {
    // skew() is always 2D — setting the flag is a no-op.
  }



  get ax(): CSSNumericValue { return this.#ax; }
  set ax(v: unknown) { this.#ax = matchAngle(v); }
  get ay(): CSSNumericValue { return this.#ay; }
  set ay(v: unknown) { this.#ay = matchAngle(v); }

  override toMatrix(): DOMMatrix {
    const deg = (v: CSSNumericValue): number =>
      v instanceof CSSUnitValue ? v.to("deg").value : NaN;
    const m = new DOMMatrix();
    m.m[4] = Math.tan(deg(this.#ax) * Math.PI / 180);
    m.m[1] = Math.tan(deg(this.#ay) * Math.PI / 180);
    return m;
  }

  override toString(): string {
    // skew() with a zero y angle serializes as a single-argument function.
    const ayZero = this.#ay instanceof CSSUnitValue && this.#ay.to("deg").value === 0;
    return ayZero ? `skew(${this.#ax.toString()})` : `skew(${this.#ax.toString()}, ${this.#ay.toString()})`;
  }
}

export class CSSSkewX extends CSSTransformComponent {
  #ax: CSSNumericValue;

  constructor(ax: unknown) {
    super();
    this.#ax = matchAngle(ax);
  }

  override get is2D(): boolean {
    return true;
  }

  override set is2D(_v: boolean) {
    // skewX() is always 2D.
  }

  get ax(): CSSNumericValue { return this.#ax; }
  set ax(v: unknown) { this.#ax = matchAngle(v); }

  override toMatrix(): DOMMatrix {
    const m = new DOMMatrix();
    m.m[4] = Math.tan((this.#ax instanceof CSSUnitValue ? this.#ax.to("deg").value : NaN) * Math.PI / 180);
    return m;
  }

  override toString(): string {
    return `skewX(${this.#ax.toString()})`;
  }
}

export class CSSSkewY extends CSSTransformComponent {
  #ay: CSSNumericValue;

  constructor(ay: unknown) {
    super();
    this.#ay = matchAngle(ay);
  }

  override get is2D(): boolean {
    return true;
  }

  override set is2D(_v: boolean) {
    // skewY() is always 2D.
  }

  get ay(): CSSNumericValue { return this.#ay; }
  set ay(v: unknown) { this.#ay = matchAngle(v); }

  override toMatrix(): DOMMatrix {
    const m = new DOMMatrix();
    m.m[1] = Math.tan((this.#ay instanceof CSSUnitValue ? this.#ay.to("deg").value : NaN) * Math.PI / 180);
    return m;
  }

  override toString(): string {
    return `skewY(${this.#ay.toString()})`;
  }
}

export class CSSPerspective extends CSSTransformComponent {
  #length: CSSNumericValue | CSSKeywordValue;

  constructor(length: unknown) {
    super();
    this.#length = matchPerspectiveLength(length);
  }

  get length(): CSSNumericValue | CSSKeywordValue { return this.#length; }
  set length(v: unknown) { this.#length = matchPerspectiveLength(v); }

  override get is2D(): boolean {
    return false;
  }

  override set is2D(_v: boolean) {
    // perspective() is never 2D — per spec the flag stays false.
  }

  override toMatrix(): DOMMatrix {
    if (!(this.#length instanceof CSSUnitValue) || this.#length.unit !== "px") {
      throw new TypeError("toMatrix() cannot resolve a non-px perspective length");
    }
    const d = this.#length.value;
    const m = new DOMMatrix();
    m.m[11] = d === 0 ? NaN : -1 / d;
    m.markNot2D();
    return m;
  }

  override toString(): string {
    // A negative perspective length serializes wrapped in calc().
    const l = this.#length;
    if (l instanceof CSSUnitValue && l.value < 0) {
      return `perspective(calc(${l.value}${l.unit}))`;
    }
    return `perspective(${l.toString()})`;
  }
}

function matchPerspectiveLength(v: unknown): CSSNumericValue | CSSKeywordValue {
  // CSSKeywordish: a CSSKeywordValue instance or a bare keyword string.
  const kw = v instanceof CSSKeywordValue ? v : typeof v === "string" ? new CSSKeywordValue(v) : null;
  if (kw !== null) {
    if (kw.value !== "none") throw new TypeError("perspective keyword must be 'none'");
    return kw;
  }
  return matchLengthOnly(v);
}

export class CSSMatrixComponent extends CSSTransformComponent {
  #matrix: DOMMatrixReadOnly;

  constructor(matrix: unknown, options?: unknown) {
    super();
    this.#matrix = matrix instanceof DOMMatrixReadOnly ? matrix : new DOMMatrixReadOnly(matrix);
    const is2d = (options as { is2D?: boolean } | undefined)?.is2D;
    this.#is2DFlag = is2d === undefined ? undefined : Boolean(is2d);
  }

  get matrix(): DOMMatrixReadOnly {
    return this.#matrix;
  }

  set matrix(v: unknown) {
    this.#matrix = v instanceof DOMMatrixReadOnly ? v : new DOMMatrixReadOnly(v);
  }

  #is2DFlag: boolean | undefined;

  override get is2D(): boolean {
    return this.#is2DFlag ?? this.#matrix.is2D;
  }

  override set is2D(v: boolean) {
    this.#is2DFlag = Boolean(v);
  }

  override toMatrix(): DOMMatrix {
    const src = this.#matrix.m;
    if (this.is2D) {
      const m = new DOMMatrix();
      m.m.set([src[0]!, src[1]!, 0, 0, src[4]!, src[5]!, 0, 0, 0, 0, 1, 0, src[12]!, src[13]!, 0, 1]);
      return m;
    }
    const m = new DOMMatrix();
    m.m.set(src);
    m.is2D = false;
    return m;
  }

  override toString(): string {
    return this.#matrix.toString();
  }
}

export class CSSTransformValue extends CSSStyleValue {
  readonly components: CSSTransformComponent[];

  constructor(components: Iterable<CSSTransformComponent>) {
    super();
    if (components === undefined || components === null) {
      throw new TypeError("CSSTransformValue requires at least one component");
    }
    const list = [...components];
    if (list.length === 0) throw new TypeError("CSSTransformValue requires at least one component");
    for (const c of list) {
      if (!(c instanceof CSSTransformComponent)) throw new TypeError("expected transform components");
    }
    this.components = list;
    return new Proxy(this, {
      get(target, prop): unknown {
        if (typeof prop === "string" && /^\d+$/.test(prop)) {
          return target.components[Number(prop)];
        }
        return Reflect.get(target, prop, target);
      },
      set(target, prop, value): boolean {
        if (typeof prop === "string" && /^\d+$/.test(prop)) {
          const i = Number(prop);
          if (i >= target.components.length) {
            target.components.push(value as CSSTransformComponent);
          } else {
            target.components[i] = value as CSSTransformComponent;
          }
          return true;
        }
        return Reflect.set(target, prop, value);
      },
      has(target, prop): boolean {
        if (typeof prop === "string" && /^\d+$/.test(prop)) {
          return Number(prop) < target.components.length;
        }
        return Reflect.has(target, prop);
      },
    });
  }

  get length(): number {
    return this.components.length;
  }

  get is2D(): boolean {
    return this.components.every((c) => c.is2D);
  }

  *keys(): IterableIterator<number> {
    yield* this.components.keys();
  }

  *values(): IterableIterator<CSSTransformComponent> {
    yield* this.components;
  }

  *entries(): IterableIterator<[number, CSSTransformComponent]> {
    yield* this.components.entries();
  }

  forEach(
    cb: (value: CSSTransformComponent, index: number, array: CSSTransformValue) => void,
    ...rest: unknown[]
  ): void {
    this.components.forEach((c, i) => cb.call(rest[0], c, i, this));
  }

  *[Symbol.iterator](): Iterator<CSSTransformComponent> {
    yield* this.components;
  }

  toMatrix(): DOMMatrix {
    let m = new DOMMatrix();
    for (const c of this.components) m = m.multiply(c.toMatrix());
    return m;
  }

  override toString(): string {
    return this.components.map((c) => c.toString()).join(" ");
  }
}

function parseTransformComponent(name: string, body: string): CSSTransformComponent {
  const args = significant(tokenize(body)).filter((t) => t.t !== "comma");
  // A bare `0` in a length/angle position parses as px(0)/deg(0) per the
  // transform grammar — `zeroUnit` supplies that contextual unit.
  const num = (t: Tok | undefined, zeroUnit?: string): CSSNumericValue => {
    if (t === undefined) throw new TypeError("missing transform argument");
    if (t.t === "dimension") return new CSSUnitValue(t.v, t.unit.toLowerCase());
    if (t.t === "percent") return new CSSUnitValue(t.v, "percent");
    if (t.t === "number") {
      if (t.v === 0 && zeroUnit !== undefined) return new CSSUnitValue(0, zeroUnit);
      return new CSSUnitValue(t.v, "number");
    }
    if (t.t === "func") return parseNumeric(`${t.name}(${t.body})`);
    throw new TypeError("bad transform argument");
  };
  switch (name) {
    case "translate": return new CSSTranslate(num(args[0], "px"), args[1] === undefined ? new CSSUnitValue(0, "px") : num(args[1], "px"));
    case "translatex": return new CSSTranslate(num(args[0], "px"), new CSSUnitValue(0, "px"));
    case "translatey": return new CSSTranslate(new CSSUnitValue(0, "px"), num(args[0], "px"));
    case "translatez": return new CSSTranslate(new CSSUnitValue(0, "px"), new CSSUnitValue(0, "px"), num(args[0], "px"));
    case "translate3d": return new CSSTranslate(num(args[0], "px"), num(args[1], "px"), num(args[2], "px"));
    case "rotate": return new CSSRotate(num(args[0], "deg"));
    case "rotatex": return new CSSRotate(new CSSUnitValue(1, "number"), new CSSUnitValue(0, "number"), new CSSUnitValue(0, "number"), num(args[0], "deg"));
    case "rotatey": return new CSSRotate(new CSSUnitValue(0, "number"), new CSSUnitValue(1, "number"), new CSSUnitValue(0, "number"), num(args[0], "deg"));
    case "rotatez": return new CSSRotate(new CSSUnitValue(0, "number"), new CSSUnitValue(0, "number"), new CSSUnitValue(1, "number"), num(args[0], "deg"));
    case "rotate3d": return new CSSRotate(num(args[0]), num(args[1]), num(args[2]), num(args[3], "deg"));
    case "scale": {
      const x = num(args[0]);
      const y = args[1] === undefined ? x : num(args[1]);
      return new CSSScale(x, y);
    }
    case "scalex": return new CSSScale(num(args[0]), new CSSUnitValue(1, "number"));
    case "scaley": return new CSSScale(new CSSUnitValue(1, "number"), num(args[0]));
    case "scalez": return new CSSScale(new CSSUnitValue(1, "number"), new CSSUnitValue(1, "number"), num(args[0]));
    case "scale3d": return new CSSScale(num(args[0]), num(args[1]), num(args[2]));
    case "skew": return new CSSSkew(num(args[0], "deg"), args[1] === undefined ? new CSSUnitValue(0, "deg") : num(args[1], "deg"));
    case "skewx": return new CSSSkewX(num(args[0], "deg"));
    case "skewy": return new CSSSkewY(num(args[0], "deg"));
    case "perspective": {
      if (args[0]?.t === "ident" && args[0].name === "none") {
        return new CSSPerspective(new CSSKeywordValue("none"));
      }
      return new CSSPerspective(num(args[0], "px"));
    }
    case "matrix": {
      const vals = args.map((t) => (t.t === "number" ? t.v : NaN));
      if (vals.length !== 6 || vals.some((v) => !Number.isFinite(v))) {
        throw new TypeError("matrix() takes six numbers");
      }
      return new CSSMatrixComponent(new DOMMatrix(vals));
    }
    case "matrix3d": {
      const vals = args.map((t) => (t.t === "number" ? t.v : NaN));
      if (vals.length !== 16 || vals.some((v) => !Number.isFinite(v))) {
        throw new TypeError("matrix3d() takes sixteen numbers");
      }
      return new CSSMatrixComponent(new DOMMatrix(vals));
    }
    default:
      throw new TypeError(`unsupported transform function ${name}()`);
  }
}

// ---------------------------------------------------------------------------
// CSSImageValue + CSSColorValue family
// ---------------------------------------------------------------------------

export class CSSImageValue extends CSSStyleValue {
  #url: string;

  constructor(url?: string) {
    super();
    if (new.target === CSSImageValue) throw new TypeError("Illegal constructor");
    this.#url = url ?? "";
  }

  get url(): string {
    return this.#url;
  }

  override toString(): string {
    return `url("${this.#url.replace(/["\\]/g, "\\$&")}")`;
  }
}

/** @internal url()/image() reification uses this entry point. */
const newImageValue = (url: string): CSSImageValue =>
  constructInternal(CSSImageValue, url);

// ---------------------------------------------------------------------------
// Reification: cssText → CSSStyleValue
// ---------------------------------------------------------------------------

const NUMERIC_FUNCS = new Set(["calc", "min", "max", "clamp"]);
const VAR_FUNCS = new Set(["var", "env"]);

/** Properties whose values may be <color>s (level-1 Typed OM reifies them as base values). */
const COLORISH_PROPS = new Set([
  "background-color", "border-color", "border-top-color", "border-right-color",
  "border-bottom-color", "border-left-color", "outline-color", "text-decoration-color",
  "caret-color", "fill", "stroke", "flood-color", "lighting-color", "stop-color",
  "column-rule-color", "text-emphasis-color", "accent-color",
]);

function reifySingle(prop: string, t: Tok, computed: boolean): CSSStyleValue {
  if (t.t === "dimension") return new CSSUnitValue(t.v, t.unit.toLowerCase());
  if (t.t === "percent") return new CSSUnitValue(t.v, "percent");
  if (t.t === "number") {
    // A unitless zero on a property that takes <length> but not <number>
    // normalizes to `0px` (CSS Values 4: zeros need no unit).
    if (t.v === 0) {
      const accepted = acceptedNumericTypes(prop);
      if (!accepted.has("number") && accepted.has("length")) {
        return new CSSUnitValue(0, "px");
      }
    }
    return new CSSUnitValue(t.v, "number");
  }
  if (t.t === "ident") {
    const ident = t.name.toLowerCase();
    // <color> keywords have no level-1 Typed OM representation — they reify
    // as the opaque base CSSStyleValue. Keyword colors (currentcolor/system)
    // stay keywords at specified-value time; the computed value is the color.
    if (prop === "color" || COLORISH_PROPS.has(prop)) {
      try {
        const pc = parseColor(ident);
        if (pc.ok) {
          const v = pc.value as unknown;
          if (typeof v === "string") return computed ? baseStyleValue(ident) : new CSSKeywordValue(ident);
          return baseStyleValue(ident);
        }
      } catch { /* not a color */ }
    }
    return new CSSKeywordValue(ident);
  }
  if (t.t === "func") {
    if (NUMERIC_FUNCS.has(t.name)) {
      try {
        return simplifyNumeric(parseNumeric(`${t.name}(${t.body})`));
      } catch {
        return baseStyleValue(`${t.name}(${t.body})`);
      }
    }
    // url() reifies as CSSImageValue only where the grammar accepts <image>;
    // on other properties (cursor…) it stays an opaque base CSSStyleValue.
    if (t.name === "url" && IMAGE_PROPS.has(prop)) {
      return newImageValue(t.body.trim().replace(/^['"]|['"]$/g, ""));
    }
    // <gradient> functions reify as CSSImageValue wherever the grammar
    // accepts <image>.
    if (/gradient$/i.test(t.name) && IMAGE_PROPS.has(prop)) {
      return newImageValue(`${t.name}(${t.body})`);
    }
    if (prop === "transform") {
      try {
        return new CSSTransformValue([parseTransformComponent(t.name, t.body)]);
      } catch {
        return baseStyleValue(`${t.name}(${t.body})`);
      }
    }
    return baseStyleValue(`${t.name}(${t.body})`);
  }
  if (t.t === "string") return baseStyleValue(t.raw);
  return baseStyleValue(tokRaw(t));
}

/**
 * Spec-level calc() simplification: nested sums flatten, members are
 * canonicalized to their type's canonical unit (ms → s, rad → deg, cm → px…)
 * and same-unit leaves merge (first-seen unit order), products fold to a unit
 * value when they hold at most one dimensioned factor. A `calc()` ALWAYS
 * reifies as a CSSMathSum — even reduced to a single member — because the
 * math function shape is part of the specified value. Invert/negate nodes
 * simplify their payload but keep their wrapper — `calc(1 / 0)` is a valid
 * (infinite) value.
 */
function simplifyNumeric(v: CSSNumericValue): CSSNumericValue {
  if (v instanceof CSSMathSum) {
    const terms: CSSNumericValue[] = [];
    const push = (t: CSSNumericValue): void => {
      const s = simplifyNumeric(t);
      if (s instanceof CSSMathSum) for (const m of s.values) push(m);
      else terms.push(s);
    };
    for (const m of v.values) push(m);
    const unitOrder: string[] = [];
    const unitSum = new Map<string, number>();
    const rest: CSSNumericValue[] = [];
    for (const t of terms) {
      if (t instanceof CSSUnitValue) {
        const [unit, factor] = CANONICAL_UNIT[t.unit] ?? [t.unit, 1];
        if (!unitSum.has(unit)) unitOrder.push(unit);
        unitSum.set(unit, (unitSum.get(unit) ?? 0) + t.value * factor);
      } else {
        rest.push(t);
      }
    }
    const merged: CSSNumericValue[] = [
      ...unitOrder.map((u) => new CSSUnitValue(unitSum.get(u)!, u)),
      ...rest,
    ];
    if (merged.length === 0) merged.push(new CSSUnitValue(0, "number"));
    return new CSSMathSum(...merged);
  }
  if (v instanceof CSSMathProduct) {
    const members = [...v.values].map((m) => simplifyNumeric(m));
    return simplifyProduct(members) ?? new CSSMathProduct(...members);
  }
  if (v instanceof CSSMathNegate) return negateOperand(simplifyNumeric(v.value));
  if (v instanceof CSSMathInvert) return new CSSMathInvert(simplifyNumeric(v.value));
  if (v instanceof CSSMathMin) return new CSSMathMin(...[...v.values].map((m) => simplifyNumeric(m)));
  if (v instanceof CSSMathMax) return new CSSMathMax(...[...v.values].map((m) => simplifyNumeric(m)));
  if (v instanceof CSSMathClamp) {
    return new CSSMathClamp(simplifyNumeric(v.lower), simplifyNumeric(v.value), simplifyNumeric(v.upper));
  }
  return v;
}

function baseStyleValue(cssText: string): CSSStyleValue {
  const v = constructInternal(CSSStyleValue);
  v._cssText = cssText;
  return v;
}

/**
 * Reify a declared value. Follows the spec: custom properties and any value
 * containing var()/env() become CSSUnparsedValue; shorthands become a base
 * CSSStyleValue; list-valued properties split on top-level commas.
 */
export function reifyPropertyValue(prop: string, cssText: string, computed = false): CSSStyleValue[] {
  const name = prop.trim().toLowerCase();
  const text = cssText.trim();
  const tag = (vals: CSSStyleValue[]): CSSStyleValue[] => {
    for (const v of vals) v._associatedProperty = name;
    return vals;
  };
  // Unparsed values keep their raw whitespace — it is member data.
  if (name.startsWith("--")) return tag([parseUnparsed(cssText)]);
  const toks = tokenize(text);
  if (containsVarRef(toks)) {
    return tag([parseUnparsed(cssText)]);
  }
  // CSS-wide keywords reify as CSSKeywordValue even on shorthands.
  {
    const sig = significant(toks);
    if (sig.length === 1 && sig[0]!.t === "ident" && CSS_WIDE_KEYWORDS.has(sig[0]!.name.toLowerCase())) {
      return tag([new CSSKeywordValue(sig[0]!.name.toLowerCase())]);
    }
  }
  if (expandShorthand(name, text) !== null) return tag([baseStyleValue(text)]);
  if (name === "transform" && text !== "none") {
    const fns = significant(toks).filter((t): t is Extract<Tok, { t: "func" }> => t.t === "func");
    if (fns.length > 0 && fns.length === significant(toks).length) {
      try {
        return tag([new CSSTransformValue(fns.map((f) => parseTransformComponent(f.name, f.body)))]);
      } catch {
        return tag([baseStyleValue(text)]);
      }
    }
  }
  const groups: Tok[][] = [[]];
  for (const t of significant(toks)) {
    if (t.t === "comma") groups.push([]);
    else groups[groups.length - 1]!.push(t);
  }
  // Only `#`-multiplied properties split at commas into per-item values. For
  // every other property a comma is just part of the value's syntax
  // (`cursor: url(a), pointer`, `font-family: a, b`) — the whole thing reifies
  // as one opaque CSSStyleValue.
  if (groups.length > 1 && isListValued(name)) {
    return tag(groups
      .filter((g) => g.length > 0)
      .map((g) => (g.length === 1 ? reifySingle(name, g[0]!, computed) : baseStyleValue(g.map(tokRaw).join(" ")))));
  }
  const sig = significant(toks);
  if (sig.length === 0) return tag([baseStyleValue(text)]);
  let out: CSSStyleValue[];
  if (sig.length === 1) {
    out = [reifySingle(name, sig[0]!, computed)];
  } else if (!isListValued(name)) {
    // A non-list property whose value is several component tokens reifies as a
    // single plain CSSStyleValue — only list-valued properties yield arrays.
    out = [baseStyleValue(text)];
  } else {
    out = sig.map((t) => reifySingle(name, t, computed));
  }
  // Computed values of non-negative properties are clamped to the range — the
  // `-3.14%` that could not be a literal becomes `0%` here.
  if (computed && NON_NEGATIVE_PROPS.has(name)) {
    out = out.map((v) =>
      v instanceof CSSUnitValue && v.value < 0 ? new CSSUnitValue(0, v.unit) : v,
    );
  }
  return tag(out);
}

// ---------------------------------------------------------------------------
// CSSStyleValue.parse / parseAll (installed onto the class)
// ---------------------------------------------------------------------------

/** Split `text` at top-level commas (paren-depth aware). */
function splitTopLevelCommas(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

/**
 * True when a token stream contains a var()/env() reference at any depth —
 * such declarations are substitution-pending and reify as CSSUnparsedValue.
 */
function containsVarRef(toks: readonly Tok[]): boolean {
  for (const t of toks) {
    if (t.t !== "func") continue;
    if (VAR_FUNCS.has(t.name) || containsVarRef(tokenize(t.body))) return true;
  }
  return false;
}

function checkDeclaration(prop: string, cssText: string): void {
  // A var()/env() reference makes the whole declaration substitution-pending:
  // any token stream is valid until substituted.
  if (containsVarRef(tokenize(cssText))) return;
  const tryParse = (v: string): boolean => {
    try {
      return parsePropertyValue(prop, v).ok;
    } catch (e) {
      if (isNotImplemented(e)) throw new TypeError(`unsupported property ${prop}`);
      return false;
    }
  };
  if (tryParse(cssText)) return;
  // `transform` validates component-wise: the computed-value grammar composes
  // functions into a matrix and rejects %-lengths it cannot resolve, but the
  // *specified* grammar admits them — validate each function on its own.
  if (prop === "transform") {
    const sig = significant(tokenize(cssText));
    if (sig.length === 1 && sig[0]!.t === "ident" && sig[0]!.name.toLowerCase() === "none") return;
    if (sig.length > 0 && sig.every((t) => t.t === "func")) {
      try {
        for (const t of sig) {
          const f = t;
          parseTransformComponent(f.name, f.body);
        }
        return;
      } catch {
        /* fall through to the TypeError below */
      }
    }
  }
  // `#`-multiplied (list-valued) properties take comma-separated repetitions.
  if (cssText.includes(",") && isListValued(prop)) {
    const parts = splitTopLevelCommas(cssText);
    if (parts.length > 1 && parts.every((p) => tryParse(p.trim()))) return;
  }
  // A lone math function: the generated literal grammar does not model
  // calc()/min()/max()/clamp(), but Typed OM does — validate by evaluating the
  // numeric tree and checking the resulting type against the property.
  {
    const sig = significant(tokenize(cssText));
    if (sig.length === 1 && sig[0]!.t === "func" && NUMERIC_FUNCS.has(sig[0]!.name)) {
      try {
        checkNumericFit(prop, parseNumeric(cssText));
        return;
      } catch {
        /* fall through to the TypeError below */
      }
    }
  }
  throw new TypeError(`invalid value for ${prop}`);
}

/**
 * Boolean form of {@link checkDeclaration} — used by the CSSOM declaration
 * path (inline `style` attributes, `CSSStyleRule.style`) where an invalid
 * declaration is dropped rather than thrown.
 */
export function isDeclarationValueValid(prop: string, cssText: string): boolean {
  try {
    checkDeclaration(prop, cssText);
    return true;
  } catch {
    return false;
  }
}

(CSSStyleValue as unknown as Record<string, unknown>)["parse"] = function parse(
  property: unknown,
  cssText: unknown,
): CSSStyleValue {
  if (property === undefined || cssText === undefined) {
    throw new TypeError("parse() requires a property name and cssText");
  }
  const prop = domStr(property).trim().toLowerCase();
  const css = domStr(cssText);
  if (prop === "") throw new TypeError("empty property name");
  if (prop.startsWith("--")) {
    if (css.trim() === "") throw new TypeError("empty custom property value");
    const v = parseUnparsed(css.trim());
    v._associatedProperty = prop;
    return v;
  }
  checkDeclaration(prop, css);
  const values = reifyPropertyValue(prop, css);
  return values[0]!;
};

(CSSStyleValue as unknown as Record<string, unknown>)["parseAll"] = function parseAll(
  property: unknown,
  cssText: unknown,
): CSSStyleValue[] {
  if (property === undefined || cssText === undefined) {
    throw new TypeError("parseAll() requires a property name and cssText");
  }
  const prop = domStr(property).trim().toLowerCase();
  const css = domStr(cssText);
  if (prop === "") throw new TypeError("empty property name");
  if (prop.startsWith("--")) {
    if (css.trim() === "") throw new TypeError("empty custom property value");
    const v = parseUnparsed(css.trim());
    v._associatedProperty = prop;
    return [v];
  }
  checkDeclaration(prop, css);
  return reifyPropertyValue(prop, css);
};

// ---------------------------------------------------------------------------
// StylePropertyMap
// ---------------------------------------------------------------------------

export interface StyleMapBacking {
  /** Declared (kebab-case) entries in declaration order. */
  entries(): Array<[string, string]>;
  get(prop: string): string | null;
  set(prop: string, text: string): void;
  remove(prop: string): string;
  /** Computed-map backings reify computed values (e.g. color keywords → base). */
  computed?: boolean;
}

function assertValidProperty(prop: unknown): string {
  const name = String(prop).trim();
  if (name === "") throw new TypeError("empty property name");
  if (name.startsWith("--")) return name;
  const lower = name.toLowerCase();
  if (!(lower in PROPERTY_PARSERS)) throw new TypeError(`unsupported property ${name}`);
  return lower;
}

/**
 * The CSS-numeric base types a property accepts, derived from its generated
 * grammar kind. Needed because text-level validation conflates `<number>` with
 * `<length>`: `width: 0` parses (unitless-zero quirk) but a dimensionless
 * `CSS.number(0)` is NOT a `<length>` and must throw TypeError (Typed OM §
 * "set a value"). Conversely `line-height` is a free-form string grammar that
 * nonetheless accepts numbers, lengths and percentages.
 */
const NUMERIC_TYPES_BY_KIND: Readonly<Record<string, ReadonlySet<string>>> = {
  length: new Set(["length", "percent"]),
  "length-or-keyword": new Set(["length", "percent"]),
  // The edges grammar is only used by the margin/padding SHORTHANDS — a lone
  // <percentage> is not a valid shorthand value (each edge is a separate
  // component), so typed percents throw here while longhands accept them.
  edges: new Set(["length"]),
  time: new Set(["time"]),
  times: new Set(["time"]),
  number: new Set(["number"]),
  integer: new Set(["number"]),
  "integer-or-keyword": new Set(["number"]),
};

const NUMERIC_TYPES_BY_PROP: Readonly<Record<string, ReadonlySet<string>>> = {
  "line-height": new Set(["number", "length", "percent"]),
};

const SYNTAX_KIND_BY_PROP: ReadonlyMap<string, string> = new Map(
  CSS_PROPERTIES.map((p) => [p.name, (p.syntax as { kind?: string }).kind ?? "string"]),
);

const NO_NUMERIC_TYPES: ReadonlySet<string> = new Set();

function acceptedNumericTypes(prop: string): ReadonlySet<string> {
  return NUMERIC_TYPES_BY_PROP[prop] ?? NUMERIC_TYPES_BY_KIND[SYNTAX_KIND_BY_PROP.get(prop) ?? ""] ?? NO_NUMERIC_TYPES;
}

/**
 * Properties whose grammar bounds the value to [0, ∞). A typed negative value
 * for these is grammatically invalid as a literal but valid inside `calc()`
 * (range checks apply at used-value time), so `set()` wraps it in a
 * CSSMathSum — matching how browsers reify `width: -1em` as `calc(-1em)`.
 */
/** CSS-wide keywords — valid on every property, including shorthands. */
const CSS_WIDE_KEYWORDS: ReadonlySet<string> = new Set([
  "initial", "inherit", "unset", "revert", "revert-layer",
]);

const NON_NEGATIVE_PROPS: ReadonlySet<string> = new Set([
  "width", "height", "min-width", "min-height", "max-width", "max-height",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "line-height", "font-size",
  "border-width", "border-top-width", "border-right-width",
  "border-bottom-width", "border-left-width",
]);

/** Properties whose grammar accepts <image> values (url()/gradients). */
const IMAGE_PROPS: ReadonlySet<string> = new Set([
  "background-image", "list-style-image", "content", "border-image-source",
  "mask-image", "cursor-image", "fill", "shape-outside", "offset-path",
]);

/**
 * Type-check one value against the property's accepted numeric types, and
 * reject structural values (transform lists, images, colors) on properties
 * whose grammar cannot hold them.
 */
function checkNumericFit(prop: string, v: unknown): void {
  // Shorthands have no typed representation: they accept only CSS-wide
  // keywords, var()-carrying CSSUnparsedValue, or the opaque base value
  // (round-tripping text a declaration block already admitted).
  if (
    isShorthandName(prop) &&
    v instanceof CSSStyleValue &&
    v.constructor !== CSSStyleValue &&
    !(v instanceof CSSKeywordValue) &&
    !(v instanceof CSSUnparsedValue)
  ) {
    throw new TypeError(`shorthand ${prop} does not take a typed value`);
  }
  if (v instanceof CSSTransformValue) {
    if (prop !== "transform" && SYNTAX_KIND_BY_PROP.get(prop) !== "transform") {
      throw new TypeError(`a transform value is not compatible with ${prop}`);
    }
    return;
  }
  if (v instanceof CSSTransformComponent) {
    if (prop !== "transform" && SYNTAX_KIND_BY_PROP.get(prop) !== "transform") {
      throw new TypeError(`a transform component is not compatible with ${prop}`);
    }
    return;
  }
  if (v instanceof CSSImageValue) {
    if (!IMAGE_PROPS.has(prop)) {
      throw new TypeError(`an image value is not compatible with ${prop}`);
    }
    return;
  }
  if (v instanceof CSSColorValue) {
    if (SYNTAX_KIND_BY_PROP.get(prop) !== "color") {
      throw new TypeError(`a color value is not compatible with ${prop}`);
    }
    return;
  }
  if (!(v instanceof CSSNumericValue)) return;
  const type = v.type() as Record<string, number>;
  const dims = Object.keys(type).filter((k) => k !== "percentHint" && type[k] !== 0);
  const required = dims.length === 0 ? ["number"] : dims;
  const accepted = acceptedNumericTypes(prop);
  for (const d of required) {
    if (!accepted.has(d)) {
      throw new TypeError(`value type ${d} is not compatible with ${prop}`);
    }
  }
}

/** WebIDL DOMString coercion — String() on `unknown` guest values. */
const domStr = (v: unknown): string => String(v);

function serializeStyleValueArg(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof CSSStyleValue || v instanceof CSSTransformComponent) return v.toString();
  if (typeof v === "number") return String(v);
  throw new TypeError("expected CSSStyleValue or string");
}

function checkAssociatedProperty(name: string, v: unknown): void {
  if (v instanceof CSSStyleValue && v._associatedProperty !== undefined && v._associatedProperty !== name) {
    throw new TypeError("value is associated with a different property");
  }
}

export class StylePropertyMapReadOnly {
  #backing: StyleMapBacking;

  constructor(backing: StyleMapBacking) {
    if (new.target === StylePropertyMapReadOnly) throw new TypeError("Illegal constructor");
    this.#backing = backing;
  }

  get [Symbol.toStringTag](): string {
    return "StylePropertyMapReadOnly";
  }

  get size(): number {
    return this.#backing.entries().length;
  }

  get(property: unknown): CSSStyleValue | undefined {
    const name = assertValidProperty(property);
    const text = this.#backing.get(name);
    if (text === null) return undefined;
    if (name.startsWith("--")) return parseUnparsed(text);
    return reifyPropertyValue(name, text, this.#backing.computed === true)[0];
  }

  getAll(property: unknown): CSSStyleValue[] {
    const name = assertValidProperty(property);
    const text = this.#backing.get(name);
    if (text === null) return [];
    if (name.startsWith("--")) return [parseUnparsed(text)];
    return reifyPropertyValue(name, text, this.#backing.computed === true);
  }

  has(property: unknown): boolean {
    return this.#backing.get(assertValidProperty(property)) !== null;
  }

  *entries(): IterableIterator<[string, CSSStyleValue[]]> {
    for (const [prop, text] of this.#backing.entries()) {
      yield [prop, reifyPropertyValue(prop, text, this.#backing.computed === true)];
    }
  }

  *keys(): IterableIterator<string> {
    for (const [prop] of this.#backing.entries()) yield prop;
  }

  *values(): IterableIterator<CSSStyleValue[]> {
    for (const [prop, text] of this.#backing.entries()) {
      yield reifyPropertyValue(prop, text, this.#backing.computed === true);
    }
  }

  forEach(cb: (value: CSSStyleValue[], key: string, map: this) => void, ...rest: unknown[]): void {
    for (const [prop, text] of this.#backing.entries()) {
      cb.call(rest[0], reifyPropertyValue(prop, text, this.#backing.computed === true), prop, this);
    }
  }

  [Symbol.iterator](): IterableIterator<[string, CSSStyleValue[]]> {
    return this.entries();
  }
}

export class StylePropertyMap extends StylePropertyMapReadOnly {
  #backing: StyleMapBacking;

  constructor(backing: StyleMapBacking) {
    super(backing);
    if (new.target === StylePropertyMap) throw new TypeError("Illegal constructor");
    this.#backing = backing;
  }

  override get [Symbol.toStringTag](): string {
    return "StylePropertyMap";
  }

  set(property: unknown, ...values: unknown[]): void {
    const name = assertValidProperty(property);
    if (values.length === 0) throw new TypeError("set() requires a value");
    for (const v of values) checkAssociatedProperty(name, v);
    for (const v of values) checkNumericFit(name, v);
    const texts = values.map((v) => {
      const t = serializeStyleValueArg(v);
      // Out-of-range literals (negative sizes) reify as `calc(v)` — the range
      // check defers to used-value time inside the math function.
      if (v instanceof CSSUnitValue && v.value < 0 && NON_NEGATIVE_PROPS.has(name)) {
        return `calc(${t})`;
      }
      return t;
    });
    if (values.length > 1) {
      if (values.some((v) => v instanceof CSSUnparsedValue)) {
        throw new TypeError("CSSUnparsedValue must be the sole value");
      }
      if (texts.some((t) => /var\(/.test(t))) {
        throw new TypeError("var() references must be the sole value");
      }
      if (!isListValued(name)) throw new TypeError("property does not take a list of values");
    }
    const final = texts.join(", ");
    // Opaque base CSSStyleValues carry text already admitted by a declaration
    // block (e.g. `display: block math`, `cursor: url(x) 4 12, auto`) — they
    // round-trip without revalidation against our narrower grammar.
    const allOpaque = values.every(
      (v) => v instanceof CSSStyleValue && v.constructor === CSSStyleValue,
    );
    // var() references substitute at computed-value time — store unparsed.
    if (!name.startsWith("--") && !/var\(/.test(final) && !allOpaque) checkDeclaration(name, final);
    this.#backing.set(name, final);
  }

  append(property: unknown, ...values: unknown[]): void {
    const name = assertValidProperty(property);
    if (values.length === 0) throw new TypeError("append() requires a value");
    for (const v of values) checkAssociatedProperty(name, v);
    for (const v of values) checkNumericFit(name, v);
    // A var()-carrying value cannot be appended — the pending-substitution
    // token stream is not a list item.
    if (
      values.some((v) => v instanceof CSSUnparsedValue) ||
      values.some((v) => typeof v === "string" && /\bvar\(/.test(v))
    ) {
      throw new TypeError("var() references cannot be appended");
    }
    const texts = values.map(serializeStyleValueArg);
    if (!isListValued(name)) throw new TypeError("property does not take a list of values");
    const existing = this.#backing.get(name);
    // Cannot append onto a pending-substitution or CSS-wide keyword value.
    if (existing !== null && existing !== "") {
      const cur = existing.trim().toLowerCase();
      if (/\bvar\(/.test(cur) || CSS_WIDE_KEYWORDS.has(cur)) {
        throw new TypeError(`cannot append to the current '${name}' value`);
      }
    }
    const final = existing === null || existing === "" ? texts.join(", ") : `${existing}, ${texts.join(", ")}`;
    if (!name.startsWith("--") && !/var\(/.test(final)) checkDeclaration(name, final);
    this.#backing.set(name, final);
  }

  delete(property: unknown): void {
    this.#backing.remove(assertValidProperty(property));
  }

  clear(): void {
    for (const [prop] of this.#backing.entries()) this.#backing.remove(prop);
  }
}

/** @internal */
export function makeStylePropertyMap(backing: StyleMapBacking): StylePropertyMap {
  return constructInternal(StylePropertyMap, backing);
}

/** @internal */
export function makeStylePropertyMapReadOnly(backing: StyleMapBacking): StylePropertyMapReadOnly {
  return constructInternal(StylePropertyMapReadOnly, backing);
}

/** Properties that accept a comma-separated list (subset needed by WPT). */
const LIST_VALUED = new Set([
  "transition-duration", "transition-delay", "transition-property", "transition-timing-function",
  "animation-duration", "animation-delay", "animation-name", "animation-timing-function",
  "animation-iteration-count", "animation-direction", "animation-fill-mode", "animation-play-state",
  "background-image", "background-position", "background-size", "background-repeat",
  "font-family", "will-change", "transform-origin",
]);

function isListValued(prop: string): boolean {
  return LIST_VALUED.has(prop);
}

// ---------------------------------------------------------------------------
// CSSColorValue subclasses
// ---------------------------------------------------------------------------

function colorSyntaxErr(): DOMException {
  return new DOMException("invalid color channel", "SyntaxError");
}

type ColorChannel = CSSNumericValue | CSSKeywordValue;

/** Hue: an <angle> or keyword. `numberToDeg`: raw numbers become deg (HSL/LCH). */
function matchHue(v: unknown, numberToDeg: boolean): ColorChannel {
  // CSSHSL/CSSLCH hue is (CSSNumberish | CSSKeywordish): undefined becomes the
  // keyword "undefined". CSSHWB hue is CSSNumberish only — undefined throws.
  if (v === undefined) {
    if (numberToDeg) return new CSSKeywordValue("undefined");
    throw new TypeError("hue is a required argument");
  }
  if (typeof v === "number" || typeof v === "bigint") {
    if (!numberToDeg) throw new TypeError("hue must be a CSSNumericValue");
    return new CSSUnitValue(numVal(v), "deg");
  }
  if (v instanceof CSSKeywordValue) return v;
  if (v instanceof CSSUnitValue && UNIT_BASE[v.unit] === "angle") return v;
  if (v instanceof CSSMathValue) {
    const t = applyHint(v.numericType());
    if (nonZeroKeys(t.exps).length === 1 && t.exps.angle === 1) return v;
  }
  throw colorSyntaxErr();
}

/** Percent channel: raw numbers scale to percent; CSS numbers need `allowNumber`. */
function matchPercent(v: unknown, allowNumber: boolean): ColorChannel {
  if (v === undefined) throw new TypeError("color channel is a required argument");
  if (typeof v === "number" || typeof v === "bigint") {
    return new CSSUnitValue(numVal(v) * 100, "percent");
  }
  if (v instanceof CSSKeywordValue) return v;
  if (v instanceof CSSUnitValue) {
    if (v.unit === "percent" || (allowNumber && v.unit === "number")) return v;
    throw colorSyntaxErr();
  }
  if (v instanceof CSSMathValue) {
    const t = applyHint(v.numericType());
    const keys = nonZeroKeys(t.exps);
    if (keys.length === 0 || (keys.length === 1 && keys[0] === "percent")) return v;
    throw colorSyntaxErr();
  }
  throw colorSyntaxErr();
}

/** Alpha is percent-only (raw numbers scale). */
function matchAlpha(v: unknown): ColorChannel {
  return matchPercent(v, false);
}

/** Lab-style a/b channel: number or percent. */
function matchNumberOrPercent(v: unknown): ColorChannel {
  if (v === undefined) throw new TypeError("color channel is a required argument");
  if (typeof v === "number" || typeof v === "bigint") {
    return new CSSUnitValue(numVal(v), "number");
  }
  if (v instanceof CSSKeywordValue) return v;
  if (v instanceof CSSUnitValue && (v.unit === "number" || v.unit === "percent")) return v;
  if (v instanceof CSSMathValue) {
    const t = applyHint(v.numericType());
    const keys = nonZeroKeys(t.exps);
    if (keys.length === 0 || (keys.length === 1 && keys[0] === "percent")) return v;
    throw colorSyntaxErr();
  }
  throw colorSyntaxErr();
}

export class CSSColorValue extends CSSStyleValue {
  constructor() {
    super();
    if (new.target === CSSColorValue) throw new TypeError("Illegal constructor");
  }
}

function alphaSuffix(a: ColorChannel): string {
  return a instanceof CSSUnitValue && a.unit === "percent" && a.value === 100 ? "" : ` / ${a.toString()}`;
}

export class CSSRGB extends CSSColorValue {
  #r: ColorChannel;
  #g: ColorChannel;
  #b: ColorChannel;
  #alpha: ColorChannel;

  constructor(r: unknown, g: unknown, b: unknown, alpha?: unknown) {
    super();
    this.#r = matchPercent(r, true);
    this.#g = matchPercent(g, true);
    this.#b = matchPercent(b, true);
    this.#alpha = alpha === undefined ? new CSSUnitValue(100, "percent") : matchAlpha(alpha);
  }

  get r(): ColorChannel { return this.#r; }
  set r(v: unknown) { this.#r = matchPercent(v, true); }
  get g(): ColorChannel { return this.#g; }
  set g(v: unknown) { this.#g = matchPercent(v, true); }
  get b(): ColorChannel { return this.#b; }
  set b(v: unknown) { this.#b = matchPercent(v, true); }
  get alpha(): ColorChannel { return this.#alpha; }
  set alpha(v: unknown) { this.#alpha = matchAlpha(v); }

  override toString(): string {
    return `rgb(${this.#r.toString()} ${this.#g.toString()} ${this.#b.toString()}${alphaSuffix(this.#alpha)})`;
  }
}

export class CSSHSL extends CSSColorValue {
  #h: ColorChannel;
  #s: ColorChannel;
  #l: ColorChannel;
  #alpha: ColorChannel;

  constructor(h: unknown, s: unknown, l: unknown, alpha?: unknown) {
    super();
    this.#h = matchHue(h, true);
    this.#s = matchPercent(s, false);
    this.#l = matchPercent(l, false);
    this.#alpha = alpha === undefined ? new CSSUnitValue(100, "percent") : matchAlpha(alpha);
  }

  get h(): ColorChannel { return this.#h; }
  set h(v: unknown) { this.#h = matchHue(v, true); }
  get s(): ColorChannel { return this.#s; }
  set s(v: unknown) { this.#s = matchPercent(v, false); }
  get l(): ColorChannel { return this.#l; }
  set l(v: unknown) { this.#l = matchPercent(v, false); }
  get alpha(): ColorChannel { return this.#alpha; }
  set alpha(v: unknown) { this.#alpha = matchAlpha(v); }

  override toString(): string {
    return `hsl(${this.#h.toString()} ${this.#s.toString()} ${this.#l.toString()}${alphaSuffix(this.#alpha)})`;
  }
}

export class CSSHWB extends CSSColorValue {
  #h: ColorChannel;
  #w: ColorChannel;
  #b: ColorChannel;
  #alpha: ColorChannel;

  constructor(h: unknown, w: unknown, b: unknown, alpha?: unknown) {
    super();
    this.#h = matchHue(h, false);
    this.#w = matchPercent(w, false);
    this.#b = matchPercent(b, false);
    this.#alpha = alpha === undefined ? new CSSUnitValue(100, "percent") : matchAlpha(alpha);
  }

  get h(): ColorChannel { return this.#h; }
  set h(v: unknown) { this.#h = matchHue(v, false); }
  get w(): ColorChannel { return this.#w; }
  set w(v: unknown) { this.#w = matchPercent(v, false); }
  get b(): ColorChannel { return this.#b; }
  set b(v: unknown) { this.#b = matchPercent(v, false); }
  get alpha(): ColorChannel { return this.#alpha; }
  set alpha(v: unknown) { this.#alpha = matchAlpha(v); }

  override toString(): string {
    return `hwb(${this.#h.toString()} ${this.#w.toString()} ${this.#b.toString()}${alphaSuffix(this.#alpha)})`;
  }
}

// `lab()`/`oklab()` share an identical channel layout; WebIDL has no common
// intermediate interface, so each concrete class extends `CSSColorValue`
// directly (a shared `extends` base would break `super()` once the
// constructor's [[Prototype]] is reparented to the IDL parent).
export class CSSLab extends CSSColorValue {
  #l: ColorChannel;
  #a: ColorChannel;
  #b: ColorChannel;
  #alpha: ColorChannel;

  constructor(l: unknown, a: unknown, b: unknown, alpha?: unknown) {
    super();
    this.#l = matchPercent(l, false);
    this.#a = matchNumberOrPercent(a);
    this.#b = matchNumberOrPercent(b);
    this.#alpha = alpha === undefined ? new CSSUnitValue(100, "percent") : matchAlpha(alpha);
  }

  get l(): ColorChannel { return this.#l; }
  set l(v: unknown) { this.#l = matchPercent(v, false); }
  get a(): ColorChannel { return this.#a; }
  set a(v: unknown) { this.#a = matchNumberOrPercent(v); }
  get b(): ColorChannel { return this.#b; }
  set b(v: unknown) { this.#b = matchNumberOrPercent(v); }
  get alpha(): ColorChannel { return this.#alpha; }
  set alpha(v: unknown) { this.#alpha = matchAlpha(v); }

  override toString(): string {
    return `lab(${this.#l.toString()} ${this.#a.toString()} ${this.#b.toString()}${alphaSuffix(this.#alpha)})`;
  }
}

export class CSSOKLab extends CSSColorValue {
  #l: ColorChannel;
  #a: ColorChannel;
  #b: ColorChannel;
  #alpha: ColorChannel;

  constructor(l: unknown, a: unknown, b: unknown, alpha?: unknown) {
    super();
    this.#l = matchPercent(l, false);
    this.#a = matchNumberOrPercent(a);
    this.#b = matchNumberOrPercent(b);
    this.#alpha = alpha === undefined ? new CSSUnitValue(100, "percent") : matchAlpha(alpha);
  }

  get l(): ColorChannel { return this.#l; }
  set l(v: unknown) { this.#l = matchPercent(v, false); }
  get a(): ColorChannel { return this.#a; }
  set a(v: unknown) { this.#a = matchNumberOrPercent(v); }
  get b(): ColorChannel { return this.#b; }
  set b(v: unknown) { this.#b = matchNumberOrPercent(v); }
  get alpha(): ColorChannel { return this.#alpha; }
  set alpha(v: unknown) { this.#alpha = matchAlpha(v); }

  override toString(): string {
    return `oklab(${this.#l.toString()} ${this.#a.toString()} ${this.#b.toString()}${alphaSuffix(this.#alpha)})`;
  }
}

export class CSSLCH extends CSSColorValue {
  #l: ColorChannel;
  #c: ColorChannel;
  #h: ColorChannel;
  #alpha: ColorChannel;

  constructor(l: unknown, c: unknown, h: unknown, alpha?: unknown) {
    super();
    this.#l = matchPercent(l, false);
    this.#c = matchPercent(c, false);
    this.#h = matchHue(h, true);
    this.#alpha = alpha === undefined ? new CSSUnitValue(100, "percent") : matchAlpha(alpha);
  }

  get l(): ColorChannel { return this.#l; }
  set l(v: unknown) { this.#l = matchPercent(v, false); }
  get c(): ColorChannel { return this.#c; }
  set c(v: unknown) { this.#c = matchPercent(v, false); }
  get h(): ColorChannel { return this.#h; }
  set h(v: unknown) { this.#h = matchHue(v, true); }
  get alpha(): ColorChannel { return this.#alpha; }
  set alpha(v: unknown) { this.#alpha = matchAlpha(v); }

  override toString(): string {
    return `lch(${this.#l.toString()} ${this.#c.toString()} ${this.#h.toString()}${alphaSuffix(this.#alpha)})`;
  }
}

export class CSSOKLCH extends CSSColorValue {
  #l: ColorChannel;
  #c: ColorChannel;
  #h: ColorChannel;
  #alpha: ColorChannel;

  constructor(l: unknown, c: unknown, h: unknown, alpha?: unknown) {
    super();
    this.#l = matchPercent(l, false);
    this.#c = matchPercent(c, false);
    this.#h = matchHue(h, true);
    this.#alpha = alpha === undefined ? new CSSUnitValue(100, "percent") : matchAlpha(alpha);
  }

  get l(): ColorChannel { return this.#l; }
  set l(v: unknown) { this.#l = matchPercent(v, false); }
  get c(): ColorChannel { return this.#c; }
  set c(v: unknown) { this.#c = matchPercent(v, false); }
  get h(): ColorChannel { return this.#h; }
  set h(v: unknown) { this.#h = matchHue(v, true); }
  get alpha(): ColorChannel { return this.#alpha; }
  set alpha(v: unknown) { this.#alpha = matchAlpha(v); }

  override toString(): string {
    return `oklch(${this.#l.toString()} ${this.#c.toString()} ${this.#h.toString()}${alphaSuffix(this.#alpha)})`;
  }
}

/**
 * `CSSColor` — the generic `color(<space> c… / a)` interface (CSS Color 5 +
 * Typed OM). `colorSpace` is a keyword (predefined spaces or a custom
 * `--ident` profile), `channels` is the component list (number/percent/none),
 * `alpha` defaults to `1` (`100%`).
 */
const COLOR_SPACES = new Set([
  "srgb", "srgb-linear", "display-p3", "a98-rgb", "prophoto-rgb", "rec2020",
  "xyz", "xyz-d50", "xyz-d65",
]);

function matchColorSpace(v: unknown): CSSKeywordValue {
  const kw = v instanceof CSSKeywordValue ? v : new CSSKeywordValue(String(v));
  const name = kw.value.toLowerCase();
  if (!COLOR_SPACES.has(name) && !name.startsWith("--")) {
    throw new DOMException(`invalid color space "${String(v)}"`, "SyntaxError");
  }
  return new CSSKeywordValue(name);
}

export class CSSColor extends CSSColorValue {
  #colorSpace: CSSKeywordValue;
  #channels: ColorChannel[];
  #alpha: CSSNumericValue | CSSKeywordValue;

  constructor(colorSpace: unknown, channels: unknown, alpha?: unknown) {
    super();
    this.#colorSpace = matchColorSpace(colorSpace);
    const list = (channels as Iterable<unknown> | null)?.[Symbol.iterator] !== undefined
      ? [...(channels as Iterable<unknown>)]
      : null;
    if (list === null) throw new TypeError("channels must be a sequence");
    this.#channels = list.map(matchNumberOrPercent);
    this.#alpha = alpha === undefined
      ? new CSSUnitValue(1, "number")
      : matchNumberOrPercent(alpha);
  }

  get colorSpace(): CSSKeywordValue { return this.#colorSpace; }
  set colorSpace(v: unknown) { this.#colorSpace = matchColorSpace(v); }
  get channels(): ColorChannel[] { return this.#channels; }
  set channels(v: unknown) {
    const list = (v as Iterable<unknown> | null)?.[Symbol.iterator] !== undefined
      ? [...(v as Iterable<unknown>)]
      : null;
    if (list === null) throw new TypeError("channels must be a sequence");
    this.#channels = list.map(matchNumberOrPercent);
  }
  get alpha(): CSSNumericValue | CSSKeywordValue { return this.#alpha; }
  set alpha(v: unknown) { this.#alpha = matchNumberOrPercent(v); }

  override toString(): string {
    const a = this.#alpha;
    const suffix = a instanceof CSSUnitValue && a.unit === "number" && a.value === 1 ? "" : ` / ${a.toString()}`;
    return `color(${this.#colorSpace.value} ${this.#channels.join(" ")}${suffix})`;
  }
}

/** Parse a functional color's channel tokens: numbers/percentages + optional `/` alpha. */
function colorChannels(body: string): { chans: Tok[]; alpha: Tok | null } | null {
  const toks = significant(tokenize(body));
  const hasCommas = toks.some((t) => t.t === "comma");
  const parts: Tok[] = [];
  let alpha: Tok | null = null;
  let slashSeen = false;
  let commas = 0;
  for (const t of toks) {
    if (t.t === "comma") {
      if (!hasCommas || slashSeen) return null;
      commas += 1;
      continue;
    }
    if (t.t === "delim" && t.ch === "/") {
      if (slashSeen || hasCommas) return null;
      slashSeen = true;
      continue;
    }
    if (slashSeen) {
      if (alpha !== null) return null;
      alpha = t;
      continue;
    }
    parts.push(t);
  }
  if (hasCommas) {
    // Legacy comma syntax: rgba()/hsla() carry a fourth comma-separated alpha.
    if (parts.length === 4 && commas === 3 && alpha === null) {
      return { chans: parts.slice(0, 3), alpha: parts[3]! };
    }
    if (parts.length !== 3 || commas !== 2) return null;
    return { chans: parts, alpha: null };
  }
  return { chans: parts, alpha };
}

function chanTok(v: Tok, kind: "number" | "percent" | "angle"): CSSNumericValue | null {
  if (v.t === "number") {
    return kind === "angle" ? new CSSUnitValue(v.v, "deg") : new CSSUnitValue(v.v, "number");
  }
  if (v.t === "percent") return new CSSUnitValue(v.v, "percent");
  if (v.t === "dimension" && kind === "angle" && UNIT_BASE[v.unit.toLowerCase()] === "angle") {
    return new CSSUnitValue(v.v, v.unit.toLowerCase());
  }
  if (v.t === "ident" && v.name === "none") return null; // 'none' keyword channel
  return null;
}

(CSSColorValue as unknown as Record<string, unknown>)["parse"] = function parse(
  cssText: unknown,
): CSSColorValue | CSSKeywordValue {
  const text = domStr(cssText).trim();
  const toks = significant(tokenize(text));
  if (toks.length === 1 && toks[0]!.t === "func") {
    const f = toks[0] as Extract<Tok, { t: "func" }>;
    const parsed = colorChannels(f.body);
    const chan = (t: Tok, kind: "number" | "percent" | "angle"): ColorChannel => {
      if (t.t === "ident" && t.name === "none") return new CSSKeywordValue("none");
      const c = chanTok(t, kind);
      if (c === null) throw new DOMException(`invalid color "${text}"`, "SyntaxError");
      return c;
    };
    // Alpha is always a percentage internally: a number token is a 0..1
    // factor that serializes/converts as `percent(v * 100)`.
    const alphaChan = (t: Tok | null): ColorChannel => {
      if (t === null) return new CSSUnitValue(100, "percent");
      if (t.t === "number") return new CSSUnitValue(numVal(t.v) * 100, "percent");
      if (t.t === "percent") return new CSSUnitValue(t.v, "percent");
      if (t.t === "ident" && t.name === "none") return new CSSKeywordValue("none");
      throw new DOMException(`invalid color "${text}"`, "SyntaxError");
    };
    if (parsed !== null) {
      if ((f.name === "rgb" || f.name === "rgba") && parsed.chans.length === 3) {
        return new CSSRGB(
          chan(parsed.chans[0]!, "number"),
          chan(parsed.chans[1]!, "number"),
          chan(parsed.chans[2]!, "number"),
          alphaChan(parsed.alpha),
        );
      }
      if ((f.name === "hsl" || f.name === "hsla") && parsed.chans.length === 3) {
        return new CSSHSL(
          chan(parsed.chans[0]!, "angle"),
          chan(parsed.chans[1]!, "percent"),
          chan(parsed.chans[2]!, "percent"),
          alphaChan(parsed.alpha),
        );
      }
      if (f.name === "hwb" && parsed.chans.length === 3) {
        return new CSSHWB(
          chan(parsed.chans[0]!, "angle"),
          chan(parsed.chans[1]!, "percent"),
          chan(parsed.chans[2]!, "percent"),
          alphaChan(parsed.alpha),
        );
      }
    }
    throw new DOMException(`invalid color "${text}"`, "SyntaxError");
  }
  const r = parseColor(text);
  if (!r.ok || r.value === undefined) {
    throw new DOMException(`invalid color "${text}"`, "SyntaxError");
  }
  const v = r.value as unknown;
  if (typeof v === "string") {
    return new CSSKeywordValue(v.toLowerCase());
  }
  const c = v as { r: number; g: number; b: number; a: number };
  return new CSSRGB(
    new CSSUnitValue(c.r, "number"),
    new CSSUnitValue(c.g, "number"),
    new CSSUnitValue(c.b, "number"),
    new CSSUnitValue(c.a * 100, "percent"),
  );
};

// ---------------------------------------------------------------------------
// CSS namespace additions: unit factories + registerProperty
// ---------------------------------------------------------------------------

export interface RegisteredProperty {
  name: string;
  syntax: string;
  inherits: boolean;
  initialValue: string | null;
}

export interface PropertyRegistry {
  register(descriptor: unknown): void;
  get(name: string): RegisteredProperty | undefined;
}

export function makePropertyRegistry(): PropertyRegistry {
  const registry = new Map<string, RegisteredProperty>();
  const SYNTAX_COMPONENT = /^<[-a-z]+>[+*#?!]?$/;
  return {
    register(descriptor: unknown): void {
      if (typeof descriptor !== "object" || descriptor === null) {
        throw new TypeError("registerProperty requires a dictionary");
      }
      const d = descriptor as Record<string, unknown>;
      const rawName = d["name"];
      const name = String(rawName);
      if (rawName === undefined || !/^--[\s\S]+$/.test(name) || name.startsWith("\\")) {
        throw new DOMException("invalid custom property name", "SyntaxError");
      }
      const syntax = d["syntax"] === undefined ? "*" : domStr(d["syntax"]).trim();
      const syntaxOk =
        syntax === "*" ||
        (syntax !== "" &&
          syntax.split("|").every((part) => {
            const p = part.trim();
            if (p === "") return false;
            return p.split(/\s+/).every((tok) => SYNTAX_COMPONENT.test(tok));
          }));
      if (!syntaxOk) throw new DOMException("invalid syntax descriptor", "SyntaxError");
      const initial = d["initialValue"];
      if (initial === undefined && syntax !== "*") {
        throw new DOMException("initialValue is required unless syntax is '*'", "SyntaxError");
      }
      if (!("inherits" in d)) throw new TypeError("inherits is required");
      const inherits = Boolean(d["inherits"]);
      if (registry.has(name)) {
        throw new DOMException("property already registered", "InvalidModificationError");
      }
      registry.set(name, {
        name,
        syntax,
        inherits,
        initialValue: initial === undefined ? null : domStr(initial),
      });
    },
    get(name: string): RegisteredProperty | undefined {
      return registry.get(name);
    },
  };
}

/** `CSS.*` factory names differ from unit strings for `Q`/`Hz`/`kHz`. */
const FACTORY_NAME: Record<string, string> = { q: "Q", hz: "Hz", khz: "kHz" };

/** Build the `CSS.*` numeric factory functions. */
export function makeCssUnitFactories(): Record<string, (v: unknown) => CSSUnitValue> {
  const out: Record<string, (v: unknown) => CSSUnitValue> = {
    number: (v) => new CSSUnitValue(numVal(v), "number"),
    percent: (v) => new CSSUnitValue(numVal(v), "percent"),
  };
  for (const unit of Object.keys(UNIT_BASE)) {
    if (unit === "percent") continue;
    out[FACTORY_NAME[unit] ?? unit] = (v) => new CSSUnitValue(numVal(v), unit);
  }
  return out;
}

/** All Typed OM constructor globals to install into a guest realm. */
export const TYPED_OM_GLOBALS: Record<string, unknown> = {
  CSSStyleValue,
  CSSKeywordValue,
  CSSNumericValue,
  CSSUnitValue,
  CSSMathValue,
  CSSMathSum,
  CSSMathProduct,
  CSSMathNegate,
  CSSMathInvert,
  CSSMathMin,
  CSSMathMax,
  CSSMathClamp,
  CSSUnparsedValue,
  CSSVariableReferenceValue,
  CSSTransformValue,
  CSSTransformComponent,
  CSSTranslate,
  CSSRotate,
  CSSScale,
  CSSSkew,
  CSSSkewX,
  CSSSkewY,
  CSSPerspective,
  CSSMatrixComponent,
  CSSImageValue,
  CSSColorValue,
  CSSRGB,
  CSSHSL,
  CSSHWB,
  CSSLab,
  CSSOKLab,
  CSSLCH,
  CSSOKLCH,
  CSSColor,
  CSSNumericArray,
  StylePropertyMap,
  StylePropertyMapReadOnly,
  DOMMatrix,
  DOMMatrixReadOnly,
};

// WebIDL: interface objects carry their declared constructor's `length` —
// the number of required arguments (0 when the interface has no constructor).
const IDL_CTOR_LENGTH = new Map<object, number>([
  [CSSStyleValue, 0],
  [CSSKeywordValue, 1],
  [CSSNumericValue, 0],
  [CSSUnitValue, 2],
  [CSSMathValue, 0],
  [CSSMathSum, 0],
  [CSSMathProduct, 0],
  [CSSMathMin, 0],
  [CSSMathMax, 0],
  [CSSMathNegate, 1],
  [CSSMathInvert, 1],
  [CSSMathClamp, 3],
  [CSSUnparsedValue, 1],
  [CSSVariableReferenceValue, 1],
  [CSSTransformValue, 1],
  [CSSTransformComponent, 0],
  [CSSTranslate, 2],
  [CSSRotate, 1],
  [CSSScale, 2],
  [CSSSkew, 2],
  [CSSSkewX, 1],
  [CSSSkewY, 1],
  [CSSPerspective, 1],
  [CSSMatrixComponent, 1],
  [CSSImageValue, 0],
  [CSSColorValue, 0],
  [CSSRGB, 3],
  [CSSHSL, 3],
  [CSSHWB, 3],
  [CSSLab, 3],
  [CSSLCH, 3],
  [CSSOKLab, 3],
  [CSSOKLCH, 3],
  [CSSColor, 2],
  [CSSNumericArray, 0],
  [StylePropertyMap, 0],
  [StylePropertyMapReadOnly, 0],
  [DOMMatrix, 0],
  [DOMMatrixReadOnly, 0],
]);

for (const [ctor, len] of IDL_CTOR_LENGTH) {
  Object.defineProperty(ctor, "length", { value: len, configurable: true });
}

// WebIDL: static operations are installed as OWN properties on every
// descendant interface object (`CSSUnitValue.parse` is own, not inherited —
// idlharness asserts own-property on each object's constructor). For
// same-named statics the *rootmost* ancestor's version wins (`parse` on a
// descendant is the 2-argument `CSSStyleValue.parse`, which is what
// idlharness's missing-argument TypeError checks rely on).
for (const ctor of Object.values(TYPED_OM_GLOBALS)) {
  const inherited = new Map<PropertyKey, PropertyDescriptor>();
  let cur = Object.getPrototypeOf(ctor) as object | null;
  while (cur !== null && cur !== Function.prototype) {
    for (const key of [
      ...Object.getOwnPropertyNames(cur),
      ...Object.getOwnPropertySymbols(cur),
    ]) {
      if (
        key === "prototype" || key === "length" || key === "name" ||
        key === "constructor" || key === "arguments" || key === "caller"
      ) continue;
      const d = Object.getOwnPropertyDescriptor(cur, key);
      if (d !== undefined) inherited.set(key, d);
    }
    cur = Object.getPrototypeOf(cur) as object | null;
  }
  for (const [key, d] of inherited) {
    if (Object.prototype.hasOwnProperty.call(ctor as object, key)) continue;
    Object.defineProperty(ctor, key, { ...d, enumerable: true });
  }
}

// WebIDL: every member defined on an interface prototype (methods, accessors,
// Symbol-keyed entries like @@iterator) is enumerable. Class syntax defaults
// them non-enumerable, so flip the flag here — `constructor` itself stays
// non-enumerable per WebIDL's prototype-object rules. The same applies to
// static operations on the interface object, and @@toStringTag defaults to
// the interface name on prototypes that lack an own getter.
//
// Every member is ALSO wrapped with a WebIDL brand check — calling an
// operation or touching an attribute on `this` that isn't an instance of the
// interface throws TypeError (idlharness pokes members with this = {} / null).
function brandCheckWrap(
  fn: (...a: never[]) => unknown,
  owner: object,
): (this: unknown, ...args: unknown[]) => unknown {
  const wrapped = function (this: unknown, ...args: unknown[]): unknown {
    if (!(this instanceof (owner as never))) {
      throw new TypeError("Illegal invocation");
    }
    return (fn as (...a: unknown[]) => unknown).apply(this, args);
  };
  Object.defineProperty(wrapped, "name", { value: fn.name });
  Object.defineProperty(wrapped, "length", { value: fn.length });
  return wrapped;
}

for (const [name, ctor] of Object.entries(TYPED_OM_GLOBALS)) {
  const fn = ctor as { prototype?: object };
  let proto = fn.prototype ?? null;
  while (proto !== null && proto !== Object.prototype) {
    const owner = (proto as { constructor?: object }).constructor ?? (ctor as object);
    for (const key of [
      ...Object.getOwnPropertyNames(proto),
      ...Object.getOwnPropertySymbols(proto),
    ]) {
      if (key === "constructor") continue;
      const d = Object.getOwnPropertyDescriptor(proto, key);
      if (d === undefined) continue;
      if (d.get !== undefined) {
        // eslint-disable-next-line @typescript-eslint/unbound-method
        d.get = brandCheckWrap(d.get as (...a: never[]) => unknown, owner);
      }
      if (d.set !== undefined) {
        // eslint-disable-next-line @typescript-eslint/unbound-method
        d.set = brandCheckWrap(d.set as (...a: never[]) => unknown, owner);
      }
      if (typeof d.value === "function" && key !== Symbol.toStringTag) {
        d.value = brandCheckWrap(d.value as (...a: never[]) => unknown, owner);
        d.writable = true;
      }
      if (!d.enumerable && key !== Symbol.iterator && key !== Symbol.toStringTag) {
        d.enumerable = true;
      }
      Object.defineProperty(proto, key, d);
    }
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  const ownProto = fn.prototype;
  if (ownProto !== undefined) {
    for (const key of [
      ...Object.getOwnPropertyNames(ctor),
      ...Object.getOwnPropertySymbols(ctor),
    ]) {
      if (key === "prototype" || key === "length" || key === "name") continue;
      const d = Object.getOwnPropertyDescriptor(ctor, key);
      if (d !== undefined && !d.enumerable) {
        Object.defineProperty(ctor, key, { ...d, enumerable: true });
      }
    }
    if (Object.getOwnPropertyDescriptor(ownProto, Symbol.toStringTag) === undefined) {
      Object.defineProperty(ownProto, Symbol.toStringTag, {
        get() {
          if (!(this instanceof (ctor as never))) {
            throw new TypeError("Illegal invocation");
          }
          return name;
        },
        configurable: true,
      });
    }
  }
}

// WebIDL iterable members: pair iterables alias @@iterator to `entries`
// (non-enumerable); indexed iterables alias it to `values`. The sandbox
// replaces the indexed-iterable method set with the realm's own
// Array.prototype functions (WebIDL requires identity with them).
for (const proto of [StylePropertyMapReadOnly.prototype, StylePropertyMap.prototype]) {
  const entries = (proto as { entries?: unknown }).entries;
  if (typeof entries === "function") {
    Object.defineProperty(proto, Symbol.iterator, {
      value: entries,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
}
for (const proto of [
  CSSUnparsedValue.prototype,
  CSSTransformValue.prototype,
  CSSNumericArray.prototype,
]) {
  const values = (proto as { values?: unknown }).values;
  if (typeof values === "function") {
    Object.defineProperty(proto, Symbol.iterator, {
      value: values,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
}
