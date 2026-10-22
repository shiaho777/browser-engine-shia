/**
 * glsl.ts — a real GLSL ES 1.00 front-end: lexer → recursive-descent parser →
 * typed AST consumed by {@link ./interp.ts}.
 *
 * Honest scope: the shading-language SUBSET real pages use — global
 * `attribute`/`uniform`/`varying`/`const` declarations, function definitions,
 * `main()`, declarations/assignments (`=` `+=` `-=` `*=` `/=` and swizzle
 * l-values), `if/else`, `for`, `while`, `do/while`, `return`, `discard`,
 * `break`/`continue`, the full expression grammar (ternary, short-circuit
 * `&&`/`||`, swizzles, indexing, constructors `vec4(...)`, calls), and
 * `precision` statements (parsed, semantically ignored — everything runs
 * fp64). NOT implemented: preprocessor beyond stripping `#` directives,
 * structs, arrays beyond `type name[N]` declarations for uniforms, in/out
 * parameters (`inout` params are supported by copy-in/copy-out), bitwise ops,
 * and `? :` chains past right-associativity (which IS right-associative).
 *
 * Compile diagnostics are real: parse/semantic errors land in `infoLog` with
 * 1-based line numbers, so `getShaderInfoLog` reports like a real driver.
 */

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

export interface Token {
  readonly kind: "ident" | "num" | "punct" | "eof";
  readonly text: string;
  readonly line: number;
}

const KEYWORDS = new Set([
  "attribute", "uniform", "varying", "const", "precision", "highp", "mediump",
  "lowp", "invariant", "struct", "if", "else", "for", "while", "do", "return",
  "discard", "break", "continue", "void", "bool", "int", "float", "vec2",
  "vec3", "vec4", "bvec2", "bvec3", "bvec4", "ivec2", "ivec3", "ivec4",
  "mat2", "mat3", "mat4", "sampler2D", "samplerCube", "in", "out", "inout",
  "true", "false",
]);

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let line = 1;
  const push = (kind: Token["kind"], text: string): void => {
    out.push({ kind, text, line });
  };
  while (i < src.length) {
    const c = src[i] as string;
    if (c === "\n") {
      line += 1;
      i += 1;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i += 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") line += 1;
        i += 1;
      }
      i += 2;
      continue;
    }
    // Preprocessor directives are stripped (no macro expansion — documented).
    if (c === "#") {
      while (i < src.length && src[i] !== "\n") i += 1;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^(?:[0-9]+\.[0-9]*|[0-9]*\.[0-9]+|[0-9]+)(?:[eE][+-]?[0-9]+)?[fF]?/u.exec(src.slice(i));
      if (m !== null && m[0].length > 0) {
        push("num", m[0]);
        i += m[0].length;
        continue;
      }
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(src.slice(i)) as RegExpExecArray;
      push("ident", m[0]);
      i += m[0].length;
      continue;
    }
    const three = src.slice(i, i + 3);
    const two = src.slice(i, i + 2);
    if (["<<=", ">>="].includes(three)) {
      push("punct", three);
      i += 3;
      continue;
    }
    if (["++", "--", "+=", "-=", "*=", "/=", "%=", "==", "!=", "<=", ">=", "&&", "||", "^^", "<<", ">>", "&=", "|=", "^="].includes(two)) {
      push("punct", two);
      i += 2;
      continue;
    }
    push("punct", c);
    i += 1;
  }
  out.push({ kind: "eof", text: "", line });
  return out;
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

export type GLSLScalarType =
  | "void" | "bool" | "int" | "float"
  | "vec2" | "vec3" | "vec4"
  | "bvec2" | "bvec3" | "bvec4"
  | "ivec2" | "ivec3" | "ivec4"
  | "mat2" | "mat3" | "mat4"
  | "sampler2D" | "samplerCube";

export interface GLSLDecl {
  readonly kind: "decl";
  readonly type: GLSLScalarType;
  readonly name: string;
  readonly arraySize: number | null;
  readonly init: GLSLExpr | null;
  /** Storage class — "" for locals, or attribute/uniform/varying/const. */
  readonly qualifier: "" | "attribute" | "uniform" | "varying" | "const";
  readonly line: number;
}

export type GLSLStmt =
  | GLSLDecl
  | { readonly kind: "expr"; readonly expr: GLSLExpr }
  | { readonly kind: "if"; readonly cond: GLSLExpr; readonly then: GLSLStmt[]; readonly else: GLSLStmt[] | null }
  | {
      readonly kind: "for";
      readonly init: GLSLStmt | null;
      readonly cond: GLSLExpr | null;
      readonly step: GLSLExpr | null;
      readonly body: GLSLStmt[];
    }
  | { readonly kind: "while"; readonly cond: GLSLExpr; readonly body: GLSLStmt[] }
  | { readonly kind: "do"; readonly body: GLSLStmt[]; readonly cond: GLSLExpr }
  | { readonly kind: "return"; readonly value: GLSLExpr | null }
  | { readonly kind: "discard" }
  | { readonly kind: "break" }
  | { readonly kind: "continue" };

export type GLSLExpr =
  | { readonly kind: "num"; readonly value: number; readonly isInt: boolean }
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "ident"; readonly name: string; readonly line: number }
  | {
      readonly kind: "call";
      readonly callee: string;
      readonly args: readonly GLSLExpr[];
      readonly line: number;
    }
  | { readonly kind: "member"; readonly obj: GLSLExpr; readonly swizzle: string; readonly line: number }
  | { readonly kind: "index"; readonly obj: GLSLExpr; readonly index: GLSLExpr; readonly line: number }
  | { readonly kind: "unary"; readonly op: string; readonly operand: GLSLExpr }
  | { readonly kind: "postfix"; readonly op: "++" | "--"; readonly operand: GLSLExpr }
  | { readonly kind: "binary"; readonly op: string; readonly l: GLSLExpr; readonly r: GLSLExpr; readonly line: number }
  | { readonly kind: "cond"; readonly c: GLSLExpr; readonly t: GLSLExpr; readonly f: GLSLExpr }
  | { readonly kind: "assign"; readonly op: string; readonly target: GLSLExpr; readonly value: GLSLExpr; readonly line: number };

export interface GLSLFunction {
  readonly returnType: GLSLScalarType;
  readonly name: string;
  readonly params: readonly { readonly dir: "in" | "out" | "inout"; readonly type: GLSLScalarType; readonly name: string }[];
  readonly body: readonly GLSLStmt[];
  readonly line: number;
}

export type GLSLGlobal = GLSLDecl;

export interface GLSLProgram {
  readonly globals: readonly GLSLGlobal[];
  readonly functions: readonly GLSLFunction[];
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export class GLSLParseError extends Error {
  readonly line: number;
  constructor(msg: string, line: number) {
    super(`GLSL ${line}: ${msg}`);
    this.line = line;
  }
}

const TYPE_NAMES = new Set<GLSLScalarType>([
  "void", "bool", "int", "float", "vec2", "vec3", "vec4",
  "bvec2", "bvec3", "bvec4", "ivec2", "ivec3", "ivec4",
  "mat2", "mat3", "mat4", "sampler2D", "samplerCube",
]);

class Parser {
  #toks: readonly Token[];
  #i = 0;
  constructor(src: string) {
    this.#toks = tokenize(src);
  }

  #peek(): Token {
    return this.#toks[this.#i] as Token;
  }

  #next(): Token {
    return this.#toks[this.#i++] as Token;
  }

  #isPunct(p: string): boolean {
    const t = this.#peek();
    return t.kind === "punct" && t.text === p;
  }

  #expectPunct(p: string): Token {
    const t = this.#peek();
    if (t.kind !== "punct" || t.text !== p) {
      throw new GLSLParseError(`expected '${p}', got '${t.text === "" ? "EOF" : t.text}'`, t.line);
    }
    return this.#next();
  }

  #expectIdent(): Token {
    const t = this.#peek();
    if (t.kind !== "ident" || KEYWORDS.has(t.text) && !TYPE_NAMES.has(t.text as GLSLScalarType)) {
      throw new GLSLParseError(`expected identifier, got '${t.text}'`, t.line);
    }
    return this.#next();
  }

  parse(): GLSLProgram {
    const globals: GLSLGlobal[] = [];
    const functions: GLSLFunction[] = [];
    for (;;) {
      const t = this.#peek();
      if (t.kind === "eof") break;
      // precision statement — parsed and ignored (everything is fp64). The
      // precision word itself is a keyword (lowp/mediump/highp), so read raw
      // idents rather than #expectIdent.
      if (t.text === "precision") {
        this.#next();
        for (let n = 0; n < 2; n += 1) {
          const w = this.#next();
          if (w.kind !== "ident") {
            throw new GLSLParseError(`precision: expected a word, got '${w.text}'`, w.line);
          }
        }
        this.#expectPunct(";");
        continue;
      }
      if (t.text === "invariant") {
        this.#next(); // `invariant varying vec4 v;` — qualifier ignored.
        continue;
      }
      let qualifier: GLSLGlobal["qualifier"] = "";
      if (t.text === "const") {
        this.#next();
        qualifier = "const";
      } else if (t.text === "attribute" || t.text === "uniform" || t.text === "varying") {
        qualifier = this.#next().text as GLSLGlobal["qualifier"];
      }
      // `const float X = 1.0;` — const + base type.
      const typeTok = this.#next();
      const type = typeTok.text as GLSLScalarType;
      if (!TYPE_NAMES.has(type)) {
        throw new GLSLParseError(`expected a type name, got '${typeTok.text}'`, typeTok.line);
      }
      const nameTok = this.#expectIdent();
      // function definition?
      if (this.#isPunct("(")) {
        if (qualifier !== "") {
          throw new GLSLParseError("function cannot have a storage qualifier", nameTok.line);
        }
        functions.push(this.#function(type, nameTok));
        continue;
      }
      // Variable declaration (possibly comma-separated).
      const decl = this.#declarator(qualifier, type, nameTok);
      globals.push(decl);
      while (this.#isPunct(",")) {
        this.#next();
        const nTok = this.#expectIdent();
        globals.push(this.#declarator(qualifier, type, nTok));
      }
      this.#expectPunct(";");
    }
    return { globals, functions };
  }

  /** Parse one declarator: `name`, `name[N]`, `name = expr`, `name[N] = expr`. */
  #declarator(qualifier: GLSLGlobal["qualifier"], type: GLSLScalarType, nameTok: Token): GLSLGlobal {
    let arraySize: number | null = null;
    let init: GLSLExpr | null = null;
    if (this.#isPunct("[")) {
      this.#next();
      const sz = this.#expr();
      this.#expectPunct("]");
      if (sz.kind !== "num" || !Number.isInteger(sz.value)) {
        throw new GLSLParseError("array size must be a constant integer", nameTok.line);
      }
      arraySize = sz.value;
    }
    if (this.#isPunct("=")) {
      this.#next();
      init = this.#expr();
    }
    return { kind: "decl", qualifier, type, name: nameTok.text, arraySize, init, line: nameTok.line };
  }

  #function(ret: GLSLScalarType, nameTok: Token): GLSLFunction {
    this.#expectPunct("(");
    const params: GLSLFunction["params"][number][] = [];
    if (!this.#isPunct(")")) {
      for (;;) {
        let dir: "in" | "out" | "inout" = "in";
        const t = this.#peek();
        if (t.text === "in" || t.text === "out" || t.text === "inout") {
          dir = this.#next().text as typeof dir;
        }
        const pt = this.#next();
        if (!TYPE_NAMES.has(pt.text as GLSLScalarType)) {
          throw new GLSLParseError(`parameter type expected, got '${pt.text}'`, pt.line);
        }
        const pn = this.#expectIdent();
        // array param suffix `float v[4]` — treat as unindexed (documented).
        if (this.#isPunct("[")) {
          this.#next();
          this.#expectPunct("]");
        }
        params.push({ dir, type: pt.text as GLSLScalarType, name: pn.text });
        if (!this.#isPunct(",")) break;
        this.#next();
      }
    }
    this.#expectPunct(")");
    this.#expectPunct("{");
    const body = this.#block();
    return { returnType: ret, name: nameTok.text, params, body, line: nameTok.line };
  }

  #block(): GLSLStmt[] {
    const out: GLSLStmt[] = [];
    while (!this.#isPunct("}")) {
      if (this.#peek().kind === "eof") {
        throw new GLSLParseError("unterminated block", this.#peek().line);
      }
      const st = this.#stmt();
      out.push(st);
      // `float a, b = 1.0, c[4];` desugars to one decl per statement — the
      // parser queues the tail declarators on a side channel.
      const extra = this.takePendingDecls();
      if (extra !== null) {
        for (const d of extra) out.push(d);
      }
    }
    this.#expectPunct("}");
    return out;
  }

  #stmt(): GLSLStmt {
    const t = this.#peek();
    if (this.#isPunct("{")) {
      // A bare nested block — desugar to a statement list via a synthetic
      // `if (true)` so #block's pending-decl splice still applies.
      this.#next();
      return { kind: "if", cond: { kind: "bool", value: true }, then: this.#block(), else: null };
    }
    if (t.text === "if") {
      this.#next();
      this.#expectPunct("(");
      const cond = this.#expr();
      this.#expectPunct(")");
      const then = this.#stmtOrBlock();
      let els: GLSLStmt[] | null = null;
      if (this.#peek().text === "else") {
        this.#next();
        els = this.#stmtOrBlock();
      }
      return { kind: "if", cond, then, else: els };
    }
    if (t.text === "for") {
      this.#next();
      this.#expectPunct("(");
      const init = this.#isPunct(";") ? null : this.#declOrExprStmt();
      this.#expectPunct(";");
      const cond = this.#isPunct(";") ? null : this.#expr();
      this.#expectPunct(";");
      const step = this.#isPunct(")") ? null : this.#expr();
      this.#expectPunct(")");
      return { kind: "for", init, cond, step, body: this.#stmtOrBlock() };
    }
    if (t.text === "while") {
      this.#next();
      this.#expectPunct("(");
      const cond = this.#expr();
      this.#expectPunct(")");
      return { kind: "while", cond, body: this.#stmtOrBlock() };
    }
    if (t.text === "do") {
      this.#next();
      const body = this.#stmtOrBlock();
      const w = this.#next();
      if (w.text !== "while") throw new GLSLParseError("expected 'while' after do-body", w.line);
      this.#expectPunct("(");
      const cond = this.#expr();
      this.#expectPunct(")");
      this.#expectPunct(";");
      return { kind: "do", body, cond };
    }
    if (t.text === "return") {
      this.#next();
      const value = this.#isPunct(";") ? null : this.#expr();
      this.#expectPunct(";");
      return { kind: "return", value };
    }
    if (t.text === "discard") {
      this.#next();
      this.#expectPunct(";");
      return { kind: "discard" };
    }
    if (t.text === "break") {
      this.#next();
      this.#expectPunct(";");
      return { kind: "break" };
    }
    if (t.text === "continue") {
      this.#next();
      this.#expectPunct(";");
      return { kind: "continue" };
    }
    // declaration or expression statement
    const stmt = this.#declOrExprStmt();
    this.#expectPunct(";");
    return stmt;
  }

  #stmtOrBlock(): GLSLStmt[] {
    if (this.#isPunct("{")) {
      this.#next();
      return this.#block();
    }
    return [this.#stmt()];
  }

  #declOrExprStmt(): GLSLStmt {
    const t = this.#peek();
    if (t.text === "const" || TYPE_NAMES.has(t.text as GLSLScalarType)) {
      let qualifier: GLSLDecl["qualifier"] = "";
      if (t.text === "const") {
        this.#next();
        qualifier = "const";
      }
      const typeTok = this.#next();
      const type = typeTok.text as GLSLScalarType;
      const nameTok = this.#expectIdent();
      const decl = this.#declarator(qualifier, type, nameTok);
      // Multi-declarator `float a, b;` — emit as a synthetic comma chain is
      // overkill; wrap extra declarators as expr-less decls in sequence is not
      // representable in a single GLSLStmt, so support ONE decl per statement
      // when comma-separated by desugaring inside blocks (see #block guard).
      if (this.#isPunct(",")) {
        // Comma-separated declarators share the type+qualifier: `float a, b=1.0;`
        // desugars to sequential decls, queued for #block to splice in order.
        this.#pendingDecls = [decl];
        while (this.#isPunct(",")) {
          this.#next();
          const nTok = this.#expectIdent();
          this.#pendingDecls.push(this.#declarator(qualifier, type, nTok));
        }
      }
      return decl;
    }
    const e = this.#expr();
    return { kind: "expr", expr: e };
  }

  #pendingDecls: GLSLDecl[] | null = null;

  /** Consume declarators queued by a comma-separated declaration. */
  takePendingDecls(): GLSLDecl[] | null {
    const d = this.#pendingDecls;
    this.#pendingDecls = null;
    return d;
  }

  // ---- expression grammar (precedence climbing) ----

  #expr(): GLSLExpr {
    return this.#assign();
  }

  #assign(): GLSLExpr {
    const l = this.#cond();
    const t = this.#peek();
    if (t.kind === "punct" && ["=", "+=", "-=", "*=", "/=", "%="].includes(t.text)) {
      this.#next();
      const r = this.#assign();
      return { kind: "assign", op: t.text, target: l, value: r, line: t.line };
    }
    return l;
  }

  #cond(): GLSLExpr {
    const c = this.#binary(0);
    if (this.#isPunct("?")) {
      this.#next();
      const t = this.#expr();
      this.#expectPunct(":");
      const f = this.#cond();
      return { kind: "cond", c, t, f };
    }
    return c;
  }

  static readonly #PRECEDENCE: readonly (readonly string[])[] = [
    ["||"],
    ["^^"],
    ["&&"],
    ["|"],
    ["^"],
    ["&"],
    ["==", "!="],
    ["<", "<=", ">", ">="],
    ["<<", ">>"],
    ["+", "-"],
    ["*", "/", "%"],
  ];

  #binary(level: number): GLSLExpr {
    if (level >= Parser.#PRECEDENCE.length) return this.#unary();
    let l = this.#binary(level + 1);
    for (;;) {
      const t = this.#peek();
      if (t.kind !== "punct" || !Parser.#PRECEDENCE[level]!.includes(t.text)) break;
      this.#next();
      const r = this.#binary(level + 1);
      l = { kind: "binary", op: t.text, l, r, line: t.line };
    }
    return l;
  }

  #unary(): GLSLExpr {
    const t = this.#peek();
    if (t.kind === "punct" && ["-", "!", "~", "+", "++", "--"].includes(t.text)) {
      this.#next();
      return { kind: "unary", op: t.text, operand: this.#unary() };
    }
    return this.#postfix();
  }

  #postfix(): GLSLExpr {
    let e = this.#primary();
    for (;;) {
      const t = this.#peek();
      if (t.kind === "punct" && t.text === ".") {
        this.#next();
        const m = this.#expectIdent();
        e = { kind: "member", obj: e, swizzle: m.text, line: m.line };
        continue;
      }
      if (t.kind === "punct" && t.text === "[") {
        this.#next();
        const idx = this.#expr();
        this.#expectPunct("]");
        e = { kind: "index", obj: e, index: idx, line: t.line };
        continue;
      }
      if (t.kind === "punct" && (t.text === "++" || t.text === "--")) {
        this.#next();
        e = { kind: "postfix", op: t.text, operand: e };
        continue;
      }
      break;
    }
    return e;
  }

  #primary(): GLSLExpr {
    const t = this.#peek();
    if (t.kind === "num") {
      this.#next();
      const txt = t.text.replace(/f$/u, "");
      const isInt = !txt.includes(".") && !/[eE]/u.test(txt);
      return { kind: "num", value: Number(txt), isInt };
    }
    if (t.kind === "ident") {
      if (t.text === "true" || t.text === "false") {
        this.#next();
        return { kind: "bool", value: t.text === "true" };
      }
      this.#next();
      if (this.#isPunct("(")) {
        this.#next();
        const args: GLSLExpr[] = [];
        if (!this.#isPunct(")")) {
          for (;;) {
            args.push(this.#expr());
            if (!this.#isPunct(",")) break;
            this.#next();
          }
        }
        this.#expectPunct(")");
        return { kind: "call", callee: t.text, args, line: t.line };
      }
      return { kind: "ident", name: t.text, line: t.line };
    }
    if (this.#isPunct("(")) {
      this.#next();
      const e = this.#expr();
      this.#expectPunct(")");
      return e;
    }
    throw new GLSLParseError(`unexpected '${t.text === "" ? "EOF" : t.text}'`, t.line);
  }
}

export interface GLSLCompileResult {
  readonly ok: boolean;
  readonly program: GLSLProgram | null;
  readonly infoLog: string;
}

/** Compile a GLSL ES source string into a typed AST + diagnostics. */
export function compileGlsl(source: string): GLSLCompileResult {
  try {
    const program = new Parser(source).parse();
    const errors: string[] = [];
    // Semantic pass: global names unique; a `main` function exists; no
    // attribute in a fragment shader's place (caller enforces per-stage).
    const seen = new Set<string>();
    for (const g of program.globals) {
      if (seen.has(g.name)) {
        errors.push(`GLSL ${g.line}: redefinition of '${g.name}'`);
      }
      seen.add(g.name);
    }
    for (const f of program.functions) {
      if (seen.has(f.name)) {
        errors.push(`GLSL ${f.line}: '${f.name}' is both a variable and a function`);
      }
      seen.add(f.name);
    }
    if (!program.functions.some((f) => f.name === "main")) {
      errors.push("GLSL: no main() function");
    }
    if (errors.length > 0) {
      return { ok: false, program: null, infoLog: errors.join("\n") };
    }
    return { ok: true, program, infoLog: "" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, program: null, infoLog: msg };
  }
}
