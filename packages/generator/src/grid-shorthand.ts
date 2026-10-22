/**
 * CSS Grid shorthand expansion and shortest serialization.
 *
 * `grid`, `grid-template`, `grid-area`, `grid-column`, and `grid-row` expand
 * into longhands. Reading the shorthand back rebuilds the canonical form from
 * those longhands (CSS Grid §8 placement shorthands and §7.2 grid-template).
 */

export interface GridDecl {
  readonly property: string;
  readonly value: string;
}

interface GridLine {
  readonly kind: "auto" | "ident" | "numeric" | "span";
  readonly integer?: string;
  readonly ident?: string;
}

interface AreaRow {
  readonly lead: readonly string[];
  readonly trail: readonly string[];
  readonly size: string;
  readonly cells: string;
}

/** Lex grid syntax: quoted strings, bracket groups, functions, and `/`. */
function lex(input: string): string[] | null {
  const out: string[] = [];
  const s = input.trim();
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i += 1;
      continue;
    }
    if (c === "/") {
      out.push("/");
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      let j = i + 1;
      while (j < s.length && s[j] !== q) j += 1;
      if (j >= s.length) return null;
      out.push(s.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (c === "[") {
      let j = i + 1;
      while (j < s.length && s[j] !== "]") j += 1;
      if (j >= s.length) return null;
      const inner = s.slice(i + 1, j).trim().replace(/\s+/g, " ");
      out.push(inner === "" ? "[]" : `[${inner}]`);
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < s.length && !" \t\n\r/[]\"'".includes(s[j]!)) {
      if (s[j] === "(") {
        let depth = 1;
        j += 1;
        while (j < s.length && depth > 0) {
          if (s[j] === "(") depth += 1;
          else if (s[j] === ")") depth -= 1;
          j += 1;
        }
        if (depth !== 0) return null;
        break;
      }
      j += 1;
    }
    if (j === i) return null;
    out.push(s.slice(i, j));
    i = j;
  }
  return out;
}

function canonInteger(token: string): string | null {
  const match = /^([+-]?)(\d+)$/.exec(token);
  if (match === null) return null;
  const n = Number(match[2]);
  // A grid line integer is never 0 (`grid-column: 0` is invalid).
  if (!Number.isFinite(n) || n === 0) return null;
  return match[1] === "-" ? `-${n}` : String(n);
}

function isCustomIdent(token: string): boolean {
  const lower = token.toLowerCase();
  if (
    lower === "auto" || lower === "span" || lower === "auto-flow" || lower === "dense" ||
    lower === "initial" || lower === "inherit" || lower === "unset" || lower === "revert" || lower === "revert-layer"
  ) return false;
  if (token.startsWith("--") || token.includes("\\")) return true;
  return /^[-_a-zA-Z\u0080-\uFFFF][-_a-zA-Z0-9\u0080-\uFFFF]*$/.test(token);
}

function isFunction(token: string): boolean {
  return token.includes("(") && token.endsWith(")");
}

function canonTrackToken(token: string): string {
  return /^[+-]?0+(?:\.0+)?$/.test(token) ? "0px" : token;
}

function bracketInner(token: string): string[] {
  if (!token.startsWith("[") || !token.endsWith("]")) return [];
  const inner = token.slice(1, -1).trim();
  return inner === "" ? [] : inner.split(" ");
}

function bracket(names: readonly string[]): string {
  return `[${names.join(" ")}]`;
}

function serializeLine(line: GridLine): string {
  if (line.kind === "auto") return "auto";
  if (line.kind === "ident") return line.ident ?? "";
  if (line.kind === "numeric") {
    return line.ident !== undefined ? `${line.integer} ${line.ident}` : (line.integer ?? "");
  }
  const parts = ["span"];
  if (line.integer !== undefined && !(line.integer === "1" && line.ident !== undefined)) parts.push(line.integer);
  if (line.ident !== undefined) parts.push(line.ident);
  return parts.join(" ");
}

function parseLineTokens(tokens: readonly string[]): GridLine | null {
  if (tokens.length === 0) return null;
  const lower = tokens.map((token) => token.toLowerCase());
  if (tokens.length === 1 && lower[0] === "auto") return { kind: "auto" };
  const spanAt = lower.indexOf("span");
  if (spanAt !== -1) {
    if (lower.filter((token) => token === "span").length !== 1) return null;
    let integer: string | undefined;
    let ident: string | undefined;
    for (let i = 0; i < tokens.length; i += 1) {
      if (i === spanAt) continue;
      const token = tokens[i]!;
      const asInt = canonInteger(token);
      if (asInt !== null && asInt.startsWith("-")) return null;
      if (asInt !== null || isFunction(token)) {
        if (integer !== undefined) return null;
        integer = asInt ?? token;
      } else if (isCustomIdent(token)) {
        if (ident !== undefined) return null;
        ident = token;
      } else return null;
    }
    if (integer === undefined && ident === undefined) return null;
    return { kind: "span", ...(integer !== undefined ? { integer } : {}), ...(ident !== undefined ? { ident } : {}) };
  }
  if (tokens.length === 1) {
    const only = tokens[0];
    if (only === undefined) return null;
    const asInt = canonInteger(only);
    if (asInt !== null) return { kind: "numeric", integer: asInt };
    if (isCustomIdent(only)) return { kind: "ident", ident: only };
    return null;
  }
  if (tokens.length === 2) {
    const first = tokens[0];
    const second = tokens[1];
    if (first === undefined || second === undefined) return null;
    const left = canonInteger(first);
    const right = canonInteger(second);
    if (left !== null && isCustomIdent(second)) return { kind: "numeric", integer: left, ident: second };
    if (right !== null && isCustomIdent(first)) return { kind: "numeric", integer: right, ident: first };
    return null;
  }
  return null;
}

function parseLine(text: string): GridLine | null {
  const tokens = lex(text);
  if (tokens === null || tokens.includes("/")) return null;
  return parseLineTokens(tokens);
}

function splitSlash(tokens: readonly string[]): string[][] | null {
  const parts: string[][] = [[]];
  for (const token of tokens) {
    if (token === "/") {
      parts.push([]);
      if (parts.length > 4) return null;
    } else {
      parts[parts.length - 1]!.push(token);
    }
  }
  return parts;
}

function defaultEnd(line: GridLine): GridLine {
  return line.kind === "ident" ? line : { kind: "auto" };
}

function linesEqual(a: GridLine, b: GridLine): boolean {
  return serializeLine(a) === serializeLine(b);
}

/** Shortest `grid-column` / `grid-row` form. */
export function serializeGridPlacement(start: string, end: string): string {
  const startLine = parseLine(start);
  const endLine = parseLine(end);
  if (startLine === null || endLine === null) return end === "auto" ? start : `${start} / ${end}`;
  if (linesEqual(endLine, defaultEnd(startLine))) return serializeLine(startLine);
  return `${serializeLine(startLine)} / ${serializeLine(endLine)}`;
}

function oneValueArea(line: GridLine): readonly GridLine[] {
  if (line.kind === "ident") return [line, line, line, line];
  const auto: GridLine = { kind: "auto" };
  return [line, auto, auto, auto];
}

/** Shortest `grid-area` form. Trailing values that match the omitted default drop off. */
export function serializeGridArea(rowStart: string, columnStart: string, rowEnd: string, columnEnd: string): string {
  const lines = [rowStart, columnStart, rowEnd, columnEnd].map(parseLine);
  if (lines.some((line) => line === null)) return [rowStart, columnStart, rowEnd, columnEnd].join(" / ");
  const [rs, cs, re, ce] = lines as [GridLine, GridLine, GridLine, GridLine];
  const four = oneValueArea(rs);
  if (linesEqual(cs, four[1]!) && linesEqual(re, four[2]!) && linesEqual(ce, four[3]!)) {
    return serializeLine(rs);
  }
  const kept: GridLine[] = [rs, cs];
  const rowDefault = defaultEnd(rs);
  const colDefault = defaultEnd(cs);
  if (!linesEqual(re, rowDefault) || !linesEqual(ce, colDefault)) {
    kept.push(re);
    if (!linesEqual(ce, colDefault)) kept.push(ce);
  }
  return kept.map(serializeLine).join(" / ");
}

function expandPlacement(startProp: string, endProp: string, value: string): readonly GridDecl[] | null {
  const tokens = lex(value);
  if (tokens === null) return null;
  const parts = splitSlash(tokens);
  if (parts === null || parts.length < 1 || parts.length > 2 || parts.some((part) => part.length === 0)) return null;
  const start = parseLineTokens(parts[0]!);
  if (start === null) return null;
  const end = parts.length === 2 ? parseLineTokens(parts[1]!) : defaultEnd(start);
  if (end === null) return null;
  return [
    { property: startProp, value: serializeLine(start) },
    { property: endProp, value: serializeLine(end) },
  ];
}

export function expandGridColumn(value: string): readonly GridDecl[] | null {
  return expandPlacement("grid-column-start", "grid-column-end", value);
}

export function expandGridRow(value: string): readonly GridDecl[] | null {
  return expandPlacement("grid-row-start", "grid-row-end", value);
}

export function expandGridArea(value: string): readonly GridDecl[] | null {
  const tokens = lex(value);
  if (tokens === null) return null;
  const parts = splitSlash(tokens);
  if (parts === null || parts.length < 1 || parts.length > 4 || parts.some((part) => part.length === 0)) return null;
  const parsed = parts.map(parseLineTokens);
  if (parsed.some((line) => line === null)) return null;
  const lines = parsed as GridLine[];
  let four: GridLine[];
  if (lines.length === 1) four = [...oneValueArea(lines[0]!)];
  else if (lines.length === 2) four = [lines[0]!, lines[1]!, defaultEnd(lines[0]!), defaultEnd(lines[1]!)];
  else if (lines.length === 3) four = [lines[0]!, lines[1]!, lines[2]!, defaultEnd(lines[1]!)];
  else four = [lines[0]!, lines[1]!, lines[2]!, lines[3]!];
  return [
    { property: "grid-row-start", value: serializeLine(four[0]!) },
    { property: "grid-column-start", value: serializeLine(four[1]!) },
    { property: "grid-row-end", value: serializeLine(four[2]!) },
    { property: "grid-column-end", value: serializeLine(four[3]!) },
  ];
}

function trackList(tokens: readonly string[]): string | null {
  if (tokens.length === 1 && tokens[0]!.toLowerCase() === "none") return "none";
  const parts: string[] = [];
  for (const token of tokens) {
    if (token.startsWith('"') || token.startsWith("'")) return null;
    if (token === "[]") continue;
    if (token.startsWith("[")) {
      parts.push(token);
      continue;
    }
    if (token.toLowerCase() === "auto-flow" || token.toLowerCase() === "dense" || token.toLowerCase() === "none") return null;
    if (isFunction(token) && !/^(?:minmax|fit-content|repeat|calc|min|max)\(/i.test(token)) return null;
    parts.push(canonTrackToken(token));
  }
  return parts.length === 0 ? null : parts.join(" ");
}

function parseAreas(tokens: readonly string[]): { rows: string; columns: string; areas: string; shorthand: string } | null {
  let i = 0;
  const rows: AreaRow[] = [];
  while (i < tokens.length && tokens[i] !== "/") {
    const lead = tokens[i]?.startsWith("[") ? bracketInner(tokens[i]!) : [];
    if (tokens[i]?.startsWith("[")) i += 1;
    const cells = tokens[i];
    if (cells === undefined || !(cells.startsWith('"') || cells.startsWith("'"))) return null;
    i += 1;
    let size = "auto";
    const next = tokens[i];
    if (next !== undefined && next !== "/" && !next.startsWith("[") && !next.startsWith('"') && !next.startsWith("'")) {
      if (next.toLowerCase() === "none") return null;
      size = canonTrackToken(next);
      i += 1;
    }
    const trail = tokens[i]?.startsWith("[") ? bracketInner(tokens[i]!) : [];
    if (tokens[i]?.startsWith("[")) i += 1;
    rows.push({ lead, trail, size, cells });
  }
  if (rows.length === 0) return null;
  let columns = "none";
  if (tokens[i] === "/") {
    i += 1;
    const parsed = trackList(tokens.slice(i));
    if (parsed === null || parsed === "none") return null;
    columns = parsed;
  }
  const rowParts: string[] = [];
  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r]!;
    if (r === 0) {
      if (row.lead.length > 0) rowParts.push(bracket(row.lead));
    } else {
      const merged = [...rows[r - 1]!.trail, ...row.lead];
      if (merged.length > 0) rowParts.push(bracket(merged));
    }
    rowParts.push(row.size);
  }
  const tail = rows[rows.length - 1]!.trail;
  if (tail.length > 0) rowParts.push(bracket(tail));
  return {
    rows: rowParts.join(" "),
    columns,
    areas: rows.map((row) => row.cells).join(" "),
    shorthand: serializeAreas(rows, columns),
  };
}

function serializeAreas(rows: readonly AreaRow[], columns: string): string {
  const parts: string[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (i === 0) {
      if (row.lead.length > 0) parts.push(bracket(row.lead));
    } else {
      const merged = [...rows[i - 1]!.trail, ...row.lead];
      if (merged.length > 0) parts.push(bracket(merged));
    }
    parts.push(row.cells);
    if (row.size !== "auto") parts.push(row.size);
  }
  const tail = rows[rows.length - 1]!.trail;
  if (tail.length > 0) parts.push(bracket(tail));
  if (columns !== "none") parts.push("/", columns);
  return parts.join(" ");
}

interface Template {
  readonly rows: string;
  readonly columns: string;
  readonly areas: string;
}

function parseTemplate(value: string): Template | null {
  const tokens = lex(value);
  if (tokens === null || tokens.length === 0) return null;
  if (tokens.length === 1 && tokens[0]!.toLowerCase() === "none") {
    return { rows: "none", columns: "none", areas: "none" };
  }
  if (tokens.some((token) => token.toLowerCase() === "auto-flow")) return null;
  if (tokens.some((token) => token.startsWith('"') || token.startsWith("'"))) {
    const areas = parseAreas(tokens);
    if (areas === null) return null;
    return { rows: areas.rows, columns: areas.columns, areas: areas.areas };
  }
  const slash = tokens.indexOf("/");
  if (slash <= 0 || slash !== tokens.lastIndexOf("/")) return null;
  const rows = trackList(tokens.slice(0, slash));
  const columns = trackList(tokens.slice(slash + 1));
  if (rows === null || columns === null) return null;
  return { rows, columns, areas: "none" };
}

function templateDecls(template: Template): GridDecl[] {
  return [
    { property: "grid-template-rows", value: template.rows },
    { property: "grid-template-columns", value: template.columns },
    { property: "grid-template-areas", value: template.areas },
  ];
}

export function expandGridTemplate(value: string): readonly GridDecl[] | null {
  const template = parseTemplate(value);
  return template === null ? null : templateDecls(template);
}

function parseAutoFlow(tokens: readonly string[]): { dense: boolean; track: string | null } | null {
  let dense = false;
  let flow = false;
  let track: string | null = null;
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower === "auto-flow") {
      if (flow) return null;
      flow = true;
    } else if (lower === "dense") {
      if (dense) return null;
      dense = true;
    } else if (token.startsWith("[") || token.startsWith('"') || token.startsWith("'")) {
      return null;
    } else if (isFunction(token) && !/^(?:minmax|fit-content|repeat|calc|min|max)\(/i.test(token)) {
      return null;
    } else {
      if (track !== null) return null;
      track = canonTrackToken(token);
    }
  }
  if (!flow) return null;
  return { dense, track };
}

export function expandGrid(value: string): readonly GridDecl[] | null {
  const tokens = lex(value);
  if (tokens === null) return null;
  const slash = tokens.indexOf("/");
  const left = slash === -1 ? tokens : tokens.slice(0, slash);
  const right = slash === -1 ? [] : tokens.slice(slash + 1);
  const leftFlow = left.some((token) => token.toLowerCase() === "auto-flow");
  const rightFlow = right.some((token) => token.toLowerCase() === "auto-flow");
  if (leftFlow && rightFlow) return null;
  const reset = (template: Template, flow: string, autoRows: string, autoCols: string): GridDecl[] => [
    ...templateDecls(template),
    { property: "grid-auto-rows", value: autoRows },
    { property: "grid-auto-columns", value: autoCols },
    { property: "grid-auto-flow", value: flow },
  ];
  if (rightFlow) {
    const rows = trackList(left);
    const flow = parseAutoFlow(right);
    if (rows === null || flow === null) return null;
    return reset(
      { rows, columns: "none", areas: "none" },
      flow.dense ? "column dense" : "column",
      "auto",
      flow.track ?? "auto",
    );
  }
  if (leftFlow) {
    if (slash === -1) return null;
    const flow = parseAutoFlow(left);
    const columns = trackList(right);
    if (flow === null || columns === null) return null;
    return reset(
      { rows: "none", columns, areas: "none" },
      flow.dense ? "dense" : "row",
      flow.track ?? "auto",
      "auto",
    );
  }
  const template = parseTemplate(value);
  if (template === null) return null;
  return reset(template, "row", "auto", "auto");
}

const GRID_LINE_PROPS = new Set([
  "grid-row-start",
  "grid-row-end",
  "grid-column-start",
  "grid-column-end",
]);

export function isGridLineProperty(property: string): boolean {
  return GRID_LINE_PROPS.has(property);
}

/** Canonical grid line, or null when `value` is not a `<grid-line>`. */
export function canonicalGridLine(property: string, value: string): string | null {
  if (!GRID_LINE_PROPS.has(property)) return null;
  const line = parseLine(value);
  return line === null ? null : serializeLine(line);
}

function areaCount(areas: string): number | null {
  const tokens = lex(areas);
  if (tokens === null || tokens.length === 0) return null;
  if (tokens.some((token) => !token.startsWith('"') && !token.startsWith("'"))) return null;
  return tokens.length;
}

function trackCount(rows: string): number | null {
  if (rows === "none" || rows === "") return 0;
  const tokens = lex(rows);
  if (tokens === null) return null;
  return tokens.filter((token) => !token.startsWith("[")).length;
}

/** Rebuild `grid-template` from its three longhands. Empty when the longhands cannot round-trip. */
export function serializeGridTemplate(rows: string, columns: string, areas: string): string {
  if (areas !== "none" && areas !== "") {
    const areasN = areaCount(areas);
    const rowsN = trackCount(rows);
    if (areasN === null || rowsN === null || areasN !== rowsN || rowsN === 0) return "";
    const areaTokens = lex(areas);
    const rowTokens = lex(rows);
    if (areaTokens === null || rowTokens === null) return rows;
    const strings = areaTokens.filter((token) => token.startsWith('"') || token.startsWith("'"));
    const pieces: AreaRow[] = [];
    let i = 0;
    for (const cells of strings) {
      const lead = rowTokens[i]?.startsWith("[") ? bracketInner(rowTokens[i]!) : [];
      if (rowTokens[i]?.startsWith("[")) i += 1;
      const size = rowTokens[i] ?? "auto";
      if (rowTokens[i] !== undefined && !rowTokens[i]!.startsWith("[")) i += 1;
      pieces.push({ lead, trail: [], size, cells });
    }
    if (rowTokens[i]?.startsWith("[")) {
      const tail = bracketInner(rowTokens[i]!);
      const last = pieces[pieces.length - 1];
      if (last !== undefined) pieces[pieces.length - 1] = { ...last, trail: tail };
    }
    return serializeAreas(pieces, columns);
  }
  if (rows === "none" && columns === "none") return "none";
  return `${rows} / ${columns}`;
}

/** Rebuild `grid` from its six longhands. */
export function serializeGrid(
  rows: string,
  columns: string,
  areas: string,
  autoRows: string,
  autoColumns: string,
  flow: string,
): string {
  const dense = flow.split(/\s+/).includes("dense");
  const column = flow.split(/\s+/).includes("column");
  let candidate: string;
  if (!column && autoRows === "auto" && autoColumns === "auto" && (flow === "row" || flow === "")) {
    candidate = serializeGridTemplate(rows, columns, areas);
  } else if (column) {
    const track = autoColumns !== "auto" ? ` ${autoColumns}` : "";
    candidate = `${rows} / auto-flow${dense ? " dense" : ""}${track}`;
  } else {
    const track = autoRows !== "auto" ? ` ${autoRows}` : "";
    candidate = `auto-flow${dense ? " dense" : ""}${track} / ${columns}`;
  }
  if (candidate === "") return "";
  const expanded = expandGrid(candidate);
  if (expanded === null) return "";
  const got = new Map(expanded.map((decl) => [decl.property, decl.value]));
  const expect: Record<string, string> = {
    "grid-template-rows": rows,
    "grid-template-columns": columns,
    "grid-template-areas": areas,
    "grid-auto-rows": autoRows,
    "grid-auto-columns": autoColumns,
    "grid-auto-flow": flow,
  };
  for (const [key, value] of Object.entries(expect)) {
    if (got.get(key) !== value) return "";
  }
  return candidate;
}

/** Ident code point inside a grid-template-areas string. `$` and `%` are not. */
function isAreaNameCode(code: number): boolean {
  if (code === 0x2d || code === 0x5f) return true;
  if (code >= 0x30 && code <= 0x39) return true;
  if (code >= 0x41 && code <= 0x5a) return true;
  if (code >= 0x61 && code <= 0x7a) return true;
  return code >= 0x80;
}

function areaCells(content: string): string[] | null {
  const cells: string[] = [];
  let i = 0;
  while (i < content.length) {
    const code = content.codePointAt(i)!;
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0c) {
      i += 1;
      continue;
    }
    if (code === 0x2e) {
      i += 1;
      while (content.codePointAt(i) === 0x2e) i += 1;
      cells.push(".");
      continue;
    }
    if (!isAreaNameCode(code)) return null;
    const start = i;
    i += code > 0xffff ? 2 : 1;
    while (i < content.length) {
      const next = content.codePointAt(i)!;
      if (!isAreaNameCode(next)) break;
      i += next > 0xffff ? 2 : 1;
    }
    cells.push(content.slice(start, i));
  }
  return cells;
}

function areasAreRectangular(rows: readonly (readonly string[])[]): boolean {
  const width = rows[0]?.length ?? 0;
  if (width === 0 || rows.some((row) => row.length !== width)) return false;
  const seen = new Map<string, number>();
  const bounds = new Map<string, { r0: number; r1: number; c0: number; c1: number }>();
  rows.forEach((row, r) => {
    row.forEach((cell, c) => {
      if (cell === ".") return;
      seen.set(cell, (seen.get(cell) ?? 0) + 1);
      const box = bounds.get(cell);
      if (box === undefined) bounds.set(cell, { r0: r, r1: r, c0: c, c1: c });
      else {
        box.r0 = Math.min(box.r0, r);
        box.r1 = Math.max(box.r1, r);
        box.c0 = Math.min(box.c0, c);
        box.c1 = Math.max(box.c1, c);
      }
    });
  });
  for (const [name, count] of seen) {
    const box = bounds.get(name)!;
    if (count !== (box.r1 - box.r0 + 1) * (box.c1 - box.c0 + 1)) return false;
  }
  return true;
}

/**
 * Canonical `grid-template-areas`, or null when the value is not `none` or a
 * rectangular area map. Dot runs are one null cell. Names may start with a digit.
 */
export function canonicalGridAreas(value: string): string | null {
  const text = value.trim();
  if (text.toLowerCase() === "none") return "none";
  const rows: string[][] = [];
  let i = 0;
  while (i < text.length) {
    const code = text.codePointAt(i)!;
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0c) {
      i += 1;
      continue;
    }
    if (code !== 0x22 && code !== 0x27) return null;
    const quote = text[i]!;
    i += 1;
    let content = "";
    let closed = false;
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === "\\") return null;
      if (ch === quote) {
        closed = true;
        i += 1;
        break;
      }
      content += ch;
      i += 1;
    }
    if (!closed) return null;
    const cells = areaCells(content);
    if (cells === null) return null;
    rows.push(cells);
  }
  if (!areasAreRectangular(rows)) return null;
  return rows.map((row) => `"${row.join(" ")}"`).join(" ");
}
