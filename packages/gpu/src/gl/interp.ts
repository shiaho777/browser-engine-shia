/**
 * interp.ts — the GLSL evaluator: executes a parsed {@link GLSLProgram}
 * against a host-provided environment (attributes/uniforms/varyings in,
 * `gl_Position`/`gl_FragColor` out). This is the programmable-shader stage of
 * the software GL — a tree-walking interpreter, the same role SwiftShader's
 * JIT'd shader plays but honest about the cost (no JIT: documented boundary).
 *
 * Runtime value model (plain JS shapes, checked by OPERATION not by static
 * type — GLSL's static typing is enforced by the parser's symbol table at a
 * shallow level; full type checking is a documented boundary):
 *   float/int      → number
 *   bool           → boolean
 *   vecN / ivecN   → number[] (length 2–4)
 *   bvecN          → { b: boolean[] }
 *   matN           → { m: number[]; dim: N } — column-major, dim·dim entries
 *   sampler2D      → { sampler: number } — a texture-unit index
 *   T[N] arrays    → Value[]
 *
 * Assignment targets evaluate to {@link Cell}s (get/set closures), which makes
 * swizzle stores (`v.xy = …`), indexed stores (`a[2] = …`), and `inout`
 * parameters uniform.
 */
import type {
  GLSLDecl,
  GLSLExpr,
  GLSLFunction,
  GLSLGlobal,
  GLSLProgram,
  GLSLStmt,
} from "./glsl.js";

// ---------------------------------------------------------------------------
// Runtime values
// ---------------------------------------------------------------------------

export type GLValue =
  | number
  | boolean
  | number[]
  | { b: boolean[] }
  | { m: number[]; dim: number }
  | { sampler: number }
  | GLValue[];

export interface Cell {
  get(): GLValue;
  set(v: GLValue): void;
}

/** Thrown by `discard` — the rasterizer treats it as a killed fragment. */
export class DiscardSignal extends Error {}

interface RetSignal {
  readonly value: GLValue | undefined;
}
interface FlowSignal {
  readonly kind: "break" | "continue";
}

const RET = (value: GLValue | undefined): RetSignal => ({ value });

function isRet(x: unknown): x is RetSignal {
  return typeof x === "object" && x !== null && "value" in x;
}
function isFlow(x: unknown): x is FlowSignal {
  return typeof x === "object" && x !== null && "kind" in x;
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/** Host-provided global bindings for one shader invocation. */
export interface ShaderEnv {
  /** Read a global's current value (attribute/uniform/varying/builtin). */
  read(name: string): GLValue | undefined;
  /** Write a global (varyings out, `gl_Position`, `gl_FragColor`, …). */
  write(name: string, v: GLValue): void;
  /** `texture2D`/`textureCube` sampling — returns an RGBA vec4 in 0..1. */
  sample?(unit: GLValue, uv: number[]): number[];
}

/** Max loop iterations — a degenerate `while(true)` must not hang the host. */
const MAX_ITERATIONS = 1_000_000;
/** Max function-call depth — runaway recursion fails, not the process. */
const MAX_CALL_DEPTH = 256;

// ---------------------------------------------------------------------------
// Builtins
// ---------------------------------------------------------------------------

type Vec = number[];

const isVec = (v: GLValue): v is Vec => Array.isArray(v) && typeof v[0] === "number" || (Array.isArray(v) && v.length === 0);
const isMat = (v: GLValue): v is { m: number[]; dim: number } =>
  typeof v === "object" && v !== null && "m" in v && "dim" in v;
const isBvec = (v: GLValue): v is { b: boolean[] } =>
  typeof v === "object" && v !== null && "b" in v;
const isSampler = (v: GLValue): v is { sampler: number } =>
  typeof v === "object" && v !== null && "sampler" in v;

const num = (v: GLValue): number => {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (isVec(v) && v.length === 1) return v[0] as number;
  throw new GLError("scalar expected");
};

const vec = (v: GLValue): Vec => {
  if (isVec(v)) return v;
  if (typeof v === "number") return [v];
  throw new GLError("vector expected");
};

class GLError extends Error {}

/** Element-wise map for vector/scalar pairs. */
const vmap = (v: GLValue, f: (x: number) => number): GLValue =>
  isVec(v) ? v.map(f) : isBvec(v) ? { b: (v.b).map((x) => f(x ? 1 : 0) !== 0) } : f(num(v));

/** Pairwise combine for vec/vec, vec/scalar, scalar/vec, scalar/scalar. */
const vzip = (a: GLValue, b: GLValue, f: (x: number, y: number) => number): GLValue => {
  if (isMat(a) || isMat(b)) throw new GLError("matrix needs a matrix operator");
  if (isVec(a) && isVec(b)) {
    const n = Math.max(a.length, b.length);
    const out: number[] = [];
    for (let i = 0; i < n; i += 1) out.push(f(a[Math.min(i, a.length - 1)] as number, b[Math.min(i, b.length - 1)] as number));
    return out;
  }
  if (isVec(a)) return a.map((x) => f(x, num(b)));
  if (isVec(b)) return b.map((y) => f(num(a), y));
  return f(num(a), num(b));
};

/** GLSL `*` — matrix multiply when either side is a matrix. */
const mul = (a: GLValue, b: GLValue): GLValue => {
  if (isMat(a) && isMat(b)) {
    const n = a.dim;
    const out: number[] = new Array<number>(n * n).fill(0);
    for (let c = 0; c < n; c += 1)
      for (let r = 0; r < n; r += 1)
        for (let k = 0; k < n; k += 1)
          out[c * n + r] = (out[c * n + r] as number) + (a.m[k * n + r] as number) * (b.m[c * n + k] as number);
    return { m: out, dim: n };
  }
  if (isMat(a) && isVec(b)) {
    const n = a.dim;
    const out: number[] = new Array<number>(n).fill(0);
    for (let r = 0; r < n; r += 1)
      for (let c = 0; c < n; c += 1)
        out[r] = (out[r] as number) + (a.m[c * n + r] as number) * (b[c] as number);
    return out;
  }
  if (isVec(a) && isMat(b)) {
    const n = b.dim;
    const out: number[] = new Array<number>(n).fill(0);
    for (let c = 0; c < n; c += 1)
      for (let r = 0; r < n; r += 1)
        out[c] = (out[c] as number) + (a[r] as number) * (b.m[c * n + r] as number);
    return out;
  }
  if (isMat(a)) return { m: a.m.map((x) => x * num(b)), dim: a.dim };
  if (isMat(b)) return { m: b.m.map((x) => x * num(a)), dim: b.dim };
  return vzip(a, b, (x, y) => x * y);
};

const identity = (n: number): { m: number[]; dim: number } => {
  const m: number[] = new Array<number>(n * n).fill(0);
  for (let i = 0; i < n; i += 1) m[i * n + i] = 1;
  return { m, dim: n };
};

const flatten = (args: readonly GLValue[]): number[] => {
  const out: number[] = [];
  for (const a of args) {
    if (isVec(a)) out.push(...a);
    else if (isMat(a)) out.push(...a.m);
    else if (typeof a === "number") out.push(a);
    else if (typeof a === "boolean") out.push(a ? 1 : 0);
    else throw new GLError("constructor arg not numeric");
  }
  return out;
};

type Builtin = (args: readonly GLValue[], env: ShaderEnv) => GLValue;

const BUILTINS: Record<string, Builtin> = {
  radians: (a) => vmap(a[0] as GLValue, (x) => (x * Math.PI) / 180),
  degrees: (a) => vmap(a[0] as GLValue, (x) => (x * 180) / Math.PI),
  sin: (a) => vmap(a[0] as GLValue, Math.sin),
  cos: (a) => vmap(a[0] as GLValue, Math.cos),
  tan: (a) => vmap(a[0] as GLValue, Math.tan),
  asin: (a) => vmap(a[0] as GLValue, Math.asin),
  acos: (a) => vmap(a[0] as GLValue, Math.acos),
  atan: (a) => (a.length > 1 ? vzip(a[0] as GLValue, a[1] as GLValue, Math.atan2) : vmap(a[0] as GLValue, Math.atan)),
  pow: (a) => vzip(a[0] as GLValue, a[1] as GLValue, Math.pow),
  exp: (a) => vmap(a[0] as GLValue, Math.exp),
  log: (a) => vmap(a[0] as GLValue, Math.log),
  exp2: (a) => vmap(a[0] as GLValue, (x) => 2 ** x),
  log2: (a) => vmap(a[0] as GLValue, Math.log2),
  sqrt: (a) => vmap(a[0] as GLValue, Math.sqrt),
  inversesqrt: (a) => vmap(a[0] as GLValue, (x) => 1 / Math.sqrt(x)),
  abs: (a) => vmap(a[0] as GLValue, Math.abs),
  sign: (a) => vmap(a[0] as GLValue, Math.sign),
  floor: (a) => vmap(a[0] as GLValue, Math.floor),
  ceil: (a) => vmap(a[0] as GLValue, Math.ceil),
  fract: (a) => vmap(a[0] as GLValue, (x) => x - Math.floor(x)),
  trunc: (a) => vmap(a[0] as GLValue, Math.trunc),
  round: (a) => vmap(a[0] as GLValue, Math.round),
  mod: (a) => vzip(a[0] as GLValue, a[1] as GLValue, (x, y) => x - y * Math.floor(x / y)),
  min: (a) => vzip(a[0] as GLValue, a[1] as GLValue, Math.min),
  max: (a) => vzip(a[0] as GLValue, a[1] as GLValue, Math.max),
  clamp: (a) => {
    const x = a[0] as GLValue;
    const lo = a[1] as GLValue;
    const hi = a[2] as GLValue;
    return vzip(vzip(x, lo, Math.max), hi, Math.min);
  },

  step: (a) => vzip(a[1] as GLValue, a[0] as GLValue, (x, e) => (x < e ? 0 : 1)),
  smoothstep: (a) => {
    const e0 = num(a[0] as GLValue);
    const e1 = num(a[1] as GLValue);
    const x = a[2] as GLValue;
    const cl = (v: number): number => {
      const t = Math.min(Math.max((v - e0) / (e1 - e0), 0), 1);
      return t * t * (3 - 2 * t);
    };
    return vmap(x, cl);
  },
  length: (a) => Math.hypot(...vec(a[0] as GLValue)),
  distance: (a) => {
    const p = vec(a[0] as GLValue);
    const q = vec(a[1] as GLValue);
    return Math.hypot(...p.map((x, i) => x - (q[i] as number)));
  },
  dot: (a) => {
    const p = vec(a[0] as GLValue);
    const q = vec(a[1] as GLValue);
    return p.reduce((s, x, i) => s + x * (q[i] as number), 0);
  },
  cross: (a) => {
    const p = vec(a[0] as GLValue);
    const q = vec(a[1] as GLValue);
    return [
      (p[1] as number) * (q[2] as number) - (p[2] as number) * (q[1] as number),
      (p[2] as number) * (q[0] as number) - (p[0] as number) * (q[2] as number),
      (p[0] as number) * (q[1] as number) - (p[1] as number) * (q[0] as number),
    ];
  },
  normalize: (a) => {
    const v = vec(a[0] as GLValue);
    const l = Math.hypot(...v) || 1;
    return v.map((x) => x / l);
  },
  faceforward: (a) => {
    const n = vec(a[0] as GLValue);
    const i = vec(a[1] as GLValue);
    const nr = vec(a[2] as GLValue);
    const d = nr.reduce((s, x, k) => s + x * (i[k] as number), 0);
    return d < 0 ? n : n.map((x) => -x);
  },
  reflect: (a) => {
    const i = vec(a[0] as GLValue);
    const n = vec(a[1] as GLValue);
    const d = 2 * n.reduce((s, x, k) => s + x * (i[k] as number), 0);
    return i.map((x, k) => x - d * (n[k] as number));
  },
  refract: (a) => {
    const i = vec(a[0] as GLValue);
    const n = vec(a[1] as GLValue);
    const eta = num(a[2] as GLValue);
    const d = n.reduce((s, x, k) => s + x * (i[k] as number), 0);
    const k = 1 - eta * eta * (1 - d * d);
    if (k < 0) return n.map(() => 0);
    const f = eta * d + Math.sqrt(k);
    return i.map((x, j) => eta * x - f * (n[j] as number));
  },
  matrixCompMult: (a) => {
    const x = a[0] as { m: number[]; dim: number };
    const y = a[1] as { m: number[]; dim: number };
    return { m: x.m.map((v, i) => v * (y.m[i] as number)), dim: x.dim };
  },
  texture2D: (a, env) => {
    if (env.sample === undefined) throw new GLError("texture sampling unavailable");
    return env.sample(a[0] as GLValue, vec(a[1] as GLValue));
  },
  texture2DProj: (a, env) => {
    if (env.sample === undefined) throw new GLError("texture sampling unavailable");
    const uv = vec(a[1] as GLValue);
    const w = uv[uv.length - 1] ?? 1;
    return env.sample(a[0] as GLValue, uv.slice(0, 2).map((x) => x / w));
  },
  textureCube: (a, env) => {
    if (env.sample === undefined) throw new GLError("texture sampling unavailable");
    return env.sample(a[0] as GLValue, vec(a[1] as GLValue));
  },
  float: (a) => num(a[0] as GLValue),
  int: (a) => Math.trunc(num(a[0] as GLValue)),
  bool: (a) => {
    const v = a[0] as GLValue;
    return typeof v === "boolean" ? v : num(v) !== 0;
  },
  any: (a) => {
    const v = a[0] as GLValue;
    return isBvec(v) ? v.b.some(Boolean) : Boolean(v);
  },
  all: (a) => {
    const v = a[0] as GLValue;
    return isBvec(v) ? v.b.every(Boolean) : Boolean(v);
  },
  not: (a) => {
    const v = a[0] as GLValue;
    return isBvec(v) ? { b: v.b.map((x) => !x) } : !v;
  },
  dFdx: () => 0, // derivative ops: honest 0 (single-quad shading boundary).
  dFdy: () => 0,
  fwidth: () => 0,
};

// `mix(x, y, t)` = x*(1-t) + y*t, component-wise with t broadcast:
BUILTINS["mix"] = (a) => {
  const x = a[0] as GLValue;
  const y = a[1] as GLValue;
  const t = a[2] as GLValue;
  // x*(1-t) + y*t — broadcast t
  const one = vzip(x, t, (p, u) => p * (1 - u));
  const two = vzip(y, t, (q, u) => q * u);
  return vzip(one, two, (p, q) => p + q);
};

const CONSTRUCTOR_RE = /^(vec[234]|bvec[234]|ivec[234]|mat[234]|float|int|bool)$/;

/** Build a vec/bvec/ivec/mat constructor call. */
function construct(name: string, args: readonly GLValue[]): GLValue {
  if (name.startsWith("mat")) {
    const dim = Number(name.slice(3));
    if (args.length === 1 && typeof args[0] === "number") {
      const id = identity(dim);
      return { m: id.m.map((v, i) => (i % (dim + 1) === 0 ? (args[0] as number) : v)), dim };
    }
    const flat = flatten(args);
    if (flat.length !== dim * dim) throw new GLError(`${name} needs ${dim * dim} components`);
    return { m: flat, dim };
  }
  if (name.startsWith("bvec")) {
    const dim = Number(name.slice(4));
    const flat = args.map((x) => Boolean(num(x) !== 0));
    while (flat.length < dim) flat.push(false);
    return { b: flat.slice(0, dim) };
  }
  const dim = Number(name.slice(3));
  if (!Number.isNaN(dim) && name.startsWith("vec") || name.startsWith("ivec")) {
    const flat = flatten(args);
    if (args.length === 1 && typeof args[0] === "number") {
      return new Array<number>(dim).fill(args[0]);
    }
    if (flat.length < dim) throw new GLError(`${name}: only ${flat.length} components`);
    return flat.slice(0, dim);
  }
  if (name === "float") return num(args[0] as GLValue);
  if (name === "int") return Math.trunc(num(args[0] as GLValue));
  if (name === "bool") {
    const v = args[0] as GLValue;
    return typeof v === "boolean" ? v : num(v) !== 0;
  }
  throw new GLError(`unknown constructor ${name}`);
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

interface Scope {
  readonly vars: Map<string, Cell>;
}

export class GlslRunner {
  readonly #program: GLSLProgram;
  readonly #functions: Map<string, GLSLFunction>;
  readonly #globals: Map<string, GLSLGlobal>;
  readonly #env: ShaderEnv;
  #depth = 0;

  constructor(program: GLSLProgram, env: ShaderEnv) {
    this.#program = program;
    this.#env = env;
    this.#functions = new Map();
    this.#globals = new Map();
    for (const f of program.functions) {
      // overloads share a name — last wins (shallow; documented).
      this.#functions.set(f.name, f);
    }
    for (const g of program.globals) this.#globals.set(g.name, g);
  }

  get globals(): readonly GLSLGlobal[] {
    return this.#program.globals;
  }

  /** Run a named function (usually `main`) against the bound environment. */
  run(name = "main", args: readonly GLValue[] = []): GLValue | undefined {
    const fn = this.#functions.get(name);
    if (fn === undefined) throw new GLError(`no function ${name}`);
    const scopes: Scope[] = [{ vars: new Map() }];
    this.#bindGlobals(scopes[0] as Scope);
    const params = fn.params.map((_p, i) => args[i]);
    return this.#call(fn, params, scopes);
  }

  #bindGlobals(scope: Scope): void {
    for (const g of this.#program.globals) {
      scope.vars.set(g.name, this.#globalCell(g));
    }
  }

  #globalCell(g: GLSLGlobal): Cell {
    const env = this.#env;
    const name = g.name;
    // const-declared globals evaluate their init once lazily.
    if (g.qualifier === "const" || g.qualifier === "") {
      let memo: GLValue | undefined;
      return {
        get: () => {
          if (memo === undefined) {
            memo = g.init !== null
              ? this.#eval(g.init, [{ vars: new Map() }])
              : this.#zeroFor(g);
          }
          return memo;
        },
        set: () => {
          throw new GLError(`cannot assign to global ${name}`);
        },
      };
    }
    return {
      get: () => {
        const v = env.read(name);
        if (v === undefined) return this.#zeroFor(g);
        return v;
      },
      set: (v) => env.write(name, v),
    };
  }

  #zeroFor(g: GLSLGlobal): GLValue {
    const t = g.type;
    if (t === "bool") return false;
    if (t === "sampler2D" || t === "samplerCube") return { sampler: 0 };
    if (t.startsWith("bvec")) return { b: new Array<boolean>(Number(t.slice(4))).fill(false) };
    if (t.startsWith("mat")) return { m: new Array<number>(Number(t.slice(3)) ** 2).fill(0), dim: Number(t.slice(3)) };
    if (t.startsWith("vec") || t.startsWith("ivec")) return new Array<number>(Number(t.slice(3))).fill(0);
    if (g.arraySize !== null) return new Array<GLValue>(g.arraySize).fill(0);
    return 0;
  }

  #call(fn: GLSLFunction, args: readonly (GLValue | undefined)[], callerScopes: Scope[]): GLValue | undefined {
    if (this.#depth >= MAX_CALL_DEPTH) throw new GLError("call depth exceeded");
    this.#depth += 1;
    try {
      const scope: Scope = { vars: new Map() };
      // inout/out params keep a cell binding back to the caller's l-value —
      // encoded by the caller passing {cell} markers.
      fn.params.forEach((p, i) => {
        const a = args[i];
        if (a !== undefined && typeof a === "object" && a !== null && "cell" in (a as object)) {
          const cell = (a as unknown as { cell: Cell }).cell;
          if (p.dir === "out") cell.set(this.#defaultFor(p.type));
          scope.vars.set(p.name, cell);
        } else {
          const v = a === undefined ? this.#defaultFor(p.type) : a;
          scope.vars.set(p.name, { get: () => v, set: () => undefined });
        }
      });
      const r = this.#exec(fn.body, [scope, ...callerScopes]);
      if (isRet(r)) return r.value ?? (fn.returnType === "void" ? undefined : this.#defaultFor(fn.returnType));
      return undefined;
    } finally {
      this.#depth -= 1;
    }
  }

  /** Call from inside an expression — packs caller l-values for out/inout. */
  #callExpr(fn: GLSLFunction, argExprs: readonly GLSLExpr[], scopes: Scope[]): GLValue {
    const args = argExprs.map((e, i) => {
      const p = fn.params[i];
      if (p !== undefined && (p.dir === "out" || p.dir === "inout")) {
        return { cell: this.#lvalue(e, scopes) } as unknown as GLValue;
      }
      return this.#eval(e, scopes);
    });
    return this.#call(fn, args, scopes) as GLValue;
  }

  #exec(body: readonly GLSLStmt[], scopes: Scope[]): RetSignal | FlowSignal | undefined {
    for (const st of body) {
      const r = this.#stmt(st, scopes);
      if (r !== undefined) return r;
    }
    return undefined;
  }

  #stmt(st: GLSLStmt, scopes: Scope[]): RetSignal | FlowSignal | undefined {
    switch (st.kind) {
      case "decl": {
        const cell = this.#localCell(st, scopes);
        (scopes[0] as Scope).vars.set(st.name, cell);
        return undefined;
      }
      case "expr":
        this.#eval(st.expr, scopes);
        return undefined;
      case "if": {
        const c = this.#truthy(this.#eval(st.cond, scopes));
        return this.#exec(c ? st.then : (st.else ?? []), scopes);
      }
      case "for": {
        const scope: Scope = { vars: new Map() };
        const inner = [scope, ...scopes];
        if (st.init !== null) this.#stmt(st.init, inner);
        let iters = 0;
        for (;;) {
          if (st.cond !== null && !this.#truthy(this.#eval(st.cond, inner))) break;
          if (iters++ > MAX_ITERATIONS) throw new GLError("iteration limit");
          const r = this.#exec(st.body, inner);
          if (isRet(r)) return r;
          if (isFlow(r)) {
            if (r.kind === "break") break;
          }
          if (st.step !== null) this.#eval(st.step, inner);
        }
        return undefined;
      }
      case "while": {
        let iters = 0;
        while (this.#truthy(this.#eval(st.cond, scopes))) {
          if (iters++ > MAX_ITERATIONS) throw new GLError("iteration limit");
          const r = this.#exec(st.body, scopes);
          if (isRet(r)) return r;
          if (isFlow(r) && r.kind === "break") break;
        }
        return undefined;
      }
      case "do": {
        let iters = 0;
        do {
          if (iters++ > MAX_ITERATIONS) throw new GLError("iteration limit");
          const r = this.#exec(st.body, scopes);
          if (isRet(r)) return r;
          if (isFlow(r) && r.kind === "break") break;
        } while (this.#truthy(this.#eval(st.cond, scopes)));
        return undefined;
      }
      case "return":
        return RET(st.value === null ? undefined : this.#eval(st.value, scopes));
      case "discard":
        throw new DiscardSignal();
      case "break":
        return { kind: "break" };
      case "continue":
        return { kind: "continue" };
    }
  }

  #localCell(d: GLSLDecl, scopes: Scope[]): Cell {
    let v: GLValue;
    if (d.init !== null) {
      v = this.#eval(d.init, scopes);
      v = this.#coerceToType(v, d.type);
    } else if (d.arraySize !== null) {
      v = new Array<GLValue>(d.arraySize).fill(this.#defaultFor(d.type));
    } else {
      v = this.#defaultFor(d.type);
    }
    return {
      get: () => v,
      set: (nv) => {
        v = this.#coerceToType(nv, d.type);
      },
    };
  }

  #defaultFor(t: GLSLGlobal["type"]): GLValue {
    if (t === "bool") return false;
    if (t === "sampler2D" || t === "samplerCube") return { sampler: 0 };
    if (t.startsWith("bvec")) return { b: new Array<boolean>(Number(t.slice(4))).fill(false) };
    if (t.startsWith("mat")) return { m: new Array<number>(Number(t.slice(3)) ** 2).fill(0), dim: Number(t.slice(3)) };
    if (t.startsWith("vec") || t.startsWith("ivec")) return new Array<number>(Number(t.slice(3))).fill(0);
    return 0;
  }

  #coerceToType(v: GLValue, t: GLSLGlobal["type"]): GLValue {
    if (t === "bool") return this.#truthy(v);
    if (t.startsWith("bvec")) {
      const n = Number(t.slice(4));
      if (isBvec(v)) return { b: v.b.slice(0, n) };
      if (typeof v === "boolean") return { b: new Array<boolean>(n).fill(v) };
      return { b: new Array<boolean>(n).fill(false) };
    }
    if (t.startsWith("mat")) {
      const dim = Number(t.slice(3));
      if (isMat(v)) return { m: [...v.m], dim };
      if (typeof v === "number") {
        const id = identity(dim);
        return { m: id.m.map((x, i) => (i % (dim + 1) === 0 ? v : x)), dim };
      }
      return { m: new Array<number>(dim * dim).fill(0), dim };
    }
    if (t.startsWith("vec") || t.startsWith("ivec")) {
      const n = Number(t.slice(3));
      if (isVec(v)) {
        const out = v.slice(0, n);
        while (out.length < n) out.push(0);
        return out;
      }
      if (typeof v === "number") return new Array<number>(n).fill(v);
      if (typeof v === "boolean") return new Array<number>(n).fill(v ? 1 : 0);
      return new Array<number>(n).fill(0);
    }
    if (typeof v === "boolean") return v ? 1 : 0;
    if (isVec(v)) return v[0] ?? 0;
    if (isBvec(v)) return v.b[0] === true ? 1 : 0;
    if (isMat(v)) return v.m[0] ?? 0;
    if (Array.isArray(v)) return v[0] ?? 0;
    return v;
  }

  #truthy(v: GLValue): boolean {
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    if (isBvec(v)) return v.b.some(Boolean);
    if (isVec(v)) return v.some((x) => x !== 0);
    if (isMat(v)) return v.m.some((x) => x !== 0);
    if (isSampler(v)) return true;
    if (Array.isArray(v)) return v.length > 0;
    return Boolean(v);
  }

  // ---- expressions ----

  #eval(e: GLSLExpr, scopes: Scope[]): GLValue {
    switch (e.kind) {
      case "num":
        return e.value;
      case "bool":
        return e.value;
      case "ident": {
        const cell = this.#lookup(e.name, scopes);
        if (cell === undefined) throw new GLError(`${e.line}: undefined identifier '${e.name}'`);
        return cell.get();
      }
      case "member":
        return this.#member(e, scopes).get();
      case "index":
        return this.#index(e, scopes).get();
      case "unary":
        return this.#unary(e, scopes);
      case "postfix": {
        const cell = this.#lvalue(e.operand, scopes);
        const old = cell.get();
        const d = e.op === "++" ? 1 : -1;
        cell.set(vmap(old, (x) => x + d));
        return old;
      }
      case "binary":
        return this.#binary(e, scopes);
      case "cond": {
        const c = this.#truthy(this.#eval(e.c, scopes));
        return this.#eval(c ? e.t : e.f, scopes);
      }
      case "assign": {
        const cell = this.#lvalue(e.target, scopes);
        const rhs = this.#eval(e.value, scopes);
        const v = e.op === "=" ? rhs : this.#applyAssignOp(e.op, cell.get(), rhs, e.line);
        cell.set(v);
        return v;
      }
      case "call":
        return this.#callExprDispatch(e, scopes);
    }
  }

  #applyAssignOp(op: string, l: GLValue, r: GLValue, line: number): GLValue {
    switch (op) {
      case "+=": return vzip(l, r, (a, b) => a + b);
      case "-=": return vzip(l, r, (a, b) => a - b);
      case "*=": return mul(l, r);
      case "/=": return vzip(l, r, (a, b) => a / b);
      case "%=": return vzip(l, r, (a, b) => a % b);
      default: throw new GLError(`${line}: unsupported assign op ${op}`);
    }
  }

  #lookup(name: string, scopes: Scope[]): Cell | undefined {
    for (const s of scopes) {
      const c = s.vars.get(name);
      if (c !== undefined) return c;
    }
    // env-provided builtins (gl_Position/gl_FragColor/gl_FragCoord…)
    if (name.startsWith("gl_")) {
      const env = this.#env;
      return { get: () => env.read(name) ?? 0, set: (v) => env.write(name, v) };
    }
    return undefined;
  }

  #lvalue(e: GLSLExpr, scopes: Scope[]): Cell {
    if (e.kind === "ident") {
      const c = this.#lookup(e.name, scopes);
      if (c === undefined) throw new GLError(`${e.line}: undefined identifier '${e.name}'`);
      return c;
    }
    if (e.kind === "member") return this.#member(e, scopes);
    if (e.kind === "index") return this.#index(e, scopes);
    throw new GLError("expression is not assignable");
  }

  #member(e: Extract<GLSLExpr, { kind: "member" }>, scopes: Scope[]): Cell {
    const target = this.#lvalue(e.obj, scopes);
    const comps = e.swizzle;
    const at = (v: GLValue): number[] => {
      if (isVec(v)) return v;
      if (isMat(v)) return v.m;
      if (Array.isArray(v)) return v as number[];
      if (typeof v === "number" || typeof v === "boolean") return [Number(v)];
      if (isBvec(v)) return v.b.map(Number);
      throw new GLError(`${e.line}: '${e.swizzle}' on non-vector`);
    };
    const offset = (ch: string): number => {
      const xi = "xyzw".indexOf(ch);
      if (xi >= 0) return xi;
      const ri = "rgba".indexOf(ch);
      if (ri >= 0) return ri;
      const si = "stpq".indexOf(ch);
      if (si >= 0) return si;
      throw new GLError(`${e.line}: bad swizzle component '${ch}'`);
    };
    return {
      get: () => {
        const v = at(target.get());
        const out = comps.split("").map((ch) => v[offset(ch)] ?? 0);
        return out.length === 1 ? (out[0] as number) : out;
      },
      set: (nv) => {
        const cur = at(target.get()).slice();
        const incoming = isVec(nv) ? nv : [num(nv)];
        const seen = new Set<number>();
        comps.split("").forEach((ch, i) => {
          const o = offset(ch);
          if (seen.has(o)) throw new GLError(`${e.line}: swizzle dup '${ch}'`);
          seen.add(o);
          cur[o] = incoming[i] ?? 0;
        });
        const orig = target.get();
        if (isVec(orig)) target.set(cur.slice(0, orig.length));
        else if (Array.isArray(orig) && !isBvec(orig)) target.set(cur);
        else target.set(cur[0] ?? 0);
      },
    };
  }

  #index(e: Extract<GLSLExpr, { kind: "index" }>, scopes: Scope[]): Cell {
    const target = this.#lvalue(e.obj, scopes);
    return {
      get: () => {
        const v = target.get();
        const idx = Math.trunc(num(this.#eval(e.index, scopes)));
        if (isMat(v)) {
          // m[i] is the i-th COLUMN as vecN.
          const dim = v.dim;
          return v.m.slice(idx * dim, idx * dim + dim);
        }
        if (Array.isArray(v)) {
          const x = v[idx];
          if (typeof x === "object" && x !== null) return x;
          return (x ?? 0);
        }
        if (isBvec(v)) return v.b[idx] ?? false;
        throw new GLError(`${e.line}: index on non-indexable`);
      },
      set: (nv) => {
        const v = target.get();
        const idx = Math.trunc(num(this.#eval(e.index, scopes)));
        if (isMat(v)) {
          const dim = v.dim;
          const next = [...v.m];
          const col = isVec(nv) ? nv : [num(nv)];
          for (let i = 0; i < dim; i += 1) next[idx * dim + i] = col[i] ?? 0;
          target.set({ m: next, dim });
          return;
        }
        if (Array.isArray(v) && !isBvec(v)) {
          const next = [...v] as GLValue[];
          next[idx] = nv;
          target.set(next);
          return;
        }
        if (isBvec(v)) {
          const next = [...v.b];
          next[idx] = this.#truthy(nv);
          target.set({ b: next });
          return;
        }
        throw new GLError(`${e.line}: index assign on non-indexable`);
      },
    };
  }

  #unary(e: Extract<GLSLExpr, { kind: "unary" }>, scopes: Scope[]): GLValue {
    if (e.op === "++" || e.op === "--") {
      const cell = this.#lvalue(e.operand, scopes);
      const d = e.op === "++" ? 1 : -1;
      const nv = vmap(cell.get(), (x) => x + d);
      cell.set(nv);
      return nv;
    }
    const v = this.#eval(e.operand, scopes);
    switch (e.op) {
      case "-": return vmap(v, (x) => -x);
      case "+": return v;
      case "!": {
        if (isBvec(v)) return { b: v.b.map((x) => !x) };
        return !this.#truthy(v);
      }
      case "~": return vmap(v, (x) => ~x);
      default: throw new GLError(`bad unary ${e.op}`);
    }
  }

  #binary(e: Extract<GLSLExpr, { kind: "binary" }>, scopes: Scope[]): GLValue {
    if (e.op === "&&") {
      const l = this.#eval(e.l, scopes);
      if (!this.#truthy(l)) return false;
      return this.#truthy(this.#eval(e.r, scopes));
    }
    if (e.op === "||") {
      const l = this.#eval(e.l, scopes);
      if (this.#truthy(l)) return true;
      return this.#truthy(this.#eval(e.r, scopes));
    }
    const l = this.#eval(e.l, scopes);
    const r = this.#eval(e.r, scopes);
    switch (e.op) {
      case "+": return vzip(l, r, (a, b) => a + b);
      case "-": return vzip(l, r, (a, b) => a - b);
      case "*": return mul(l, r);
      case "/": return vzip(l, r, (a, b) => a / b);
      case "%": return vzip(l, r, (a, b) => a % b);
      case "<<": return vzip(l, r, (a, b) => a << b);
      case ">>": return vzip(l, r, (a, b) => a >> b);
      case "&": return vzip(l, r, (a, b) => a & b);
      case "|": return vzip(l, r, (a, b) => a | b);
      case "^": return vzip(l, r, (a, b) => a ^ b);
      case "^^": return this.#truthy(l) !== this.#truthy(r);
      case "==": return this.#equal(l, r);
      case "!=": return !this.#equal(l, r);
      case "<": return this.#cmp(l, r, (a, b) => a < b, e.line);
      case "<=": return this.#cmp(l, r, (a, b) => a <= b, e.line);
      case ">": return this.#cmp(l, r, (a, b) => a > b, e.line);
      case ">=": return this.#cmp(l, r, (a, b) => a >= b, e.line);
      default: throw new GLError(`${e.line}: bad op ${e.op}`);
    }
  }

  #cmp(l: GLValue, r: GLValue, f: (a: number, b: number) => boolean, line: number): GLValue {
    if (isVec(l) || isVec(r)) {
      // Vector relational ops return bvecN.
      const out = vzip(l, r, (a, b) => (f(a, b) ? 1 : 0));
      if (isVec(out)) return { b: out.map((x) => x !== 0) };
      return out;
    }
    if (isMat(l) || isMat(r)) throw new GLError(`${line}: relational on matrix`);
    return f(num(l), num(r));
  }

  #equal(a: GLValue, b: GLValue): boolean {
    if (isMat(a) && isMat(b)) return a.dim === b.dim && a.m.every((x, i) => x === b.m[i]);
    if (isVec(a) && isVec(b)) return a.length === b.length && a.every((x, i) => x === b[i]);
    if (isBvec(a) && isBvec(b)) return a.b.every((x, i) => x === b.b[i]);
    if (isSampler(a) && isSampler(b)) return a.sampler === b.sampler;
    if (Array.isArray(a) && Array.isArray(b)) {
      return a.length === b.length && a.every((x, i) => this.#equal(x, b[i] as GLValue));
    }
    if (typeof a === "number" && typeof b === "number") return a === b;
    if (typeof a === "boolean" && typeof b === "boolean") return a === b;
    return false;
  }

  #callExprDispatch(e: Extract<GLSLExpr, { kind: "call" }>, scopes: Scope[]): GLValue {
    const name = e.callee;
    if (CONSTRUCTOR_RE.test(name)) {
      const args = e.args.map((a) => this.#eval(a, scopes));
      return construct(name, args);
    }
    const builtin = BUILTINS[name];
    if (builtin !== undefined) {
      const args = e.args.map((a) => this.#eval(a, scopes));
      return builtin(args, this.#env);
    }
    const fn = this.#functions.get(name);
    if (fn !== undefined) {
      return this.#callExpr(fn, e.args, scopes);
    }
    throw new GLError(`${e.line}: undefined function '${name}'`);
  }
}

export interface ShaderRunResult {
  readonly value: GLValue | undefined;
  readonly error: string | null;
}

/** Convenience wrapper — run `main` capturing shader faults as diagnostics. */
export function runShader(program: GLSLProgram, env: ShaderEnv): ShaderRunResult {
  try {
    const r = new GlslRunner(program, env);
    const value = r.run("main");
    return { value, error: null };
  } catch (e) {
    if (e instanceof DiscardSignal) throw e;
    return { value: undefined, error: e instanceof Error ? e.message : String(e) };
  }
}
