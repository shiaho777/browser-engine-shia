/**
 * Generated-content resolution for accessibility name computation.
 *
 * The engine's layout/paint stages do not yet render pseudo-elements, but
 * AccName still needs `::before`/`::after` text — WPT's accname suite leans
 * on it heavily (strings, `attr()`, `counter()`, the `content: X / "alt"`
 * alternative-text syntax, and `counter-reset`/`counter-increment`/
 * `counter-set` state).
 *
 * This is a real mechanism, not a fixture: it resolves rules from the parsed
 * `StyleSheet[]` IR (kernel-produced, incremental), matches the element part
 * of pseudo selectors through the same matcher as `Element.matches`, applies
 * cascade ordering (specificity then source order), and walks the document in
 * tree order to maintain counter scopes.
 */
import type { Declaration, StyleRule, StyleSheet } from "@browser-engine/ir";
import type { A11yElement } from "./accessibility.js";

export type PseudoPosition = "before" | "after";

interface PseudoRule {
  readonly which: PseudoPosition;
  /** The selector with its `::before`/`::after` suffix stripped. */
  readonly elementSelector: string;
  readonly declarations: readonly Declaration[];
  readonly specificity: readonly [number, number, number];
  readonly order: number;
}

/** Element matcher injected by the caller (wrapper `matches`). */
export type ElementMatcher = (el: A11yElement, selector: string) => boolean;

/** Collect `X::before`/`X::after` rules (and legacy `:before`/`:after`). */
function pseudoRules(sheets: readonly StyleSheet[]): PseudoRule[] {
  const out: PseudoRule[] = [];
  const pseudoRe = /(::?)(before|after)\s*$/i;
  for (const sheet of sheets) {
    for (const rule of sheet.rules) {
      collectPseudoRule(rule, pseudoRe, out);
    }
  }
  return out;
}

function collectPseudoRule(rule: StyleRule, re: RegExp, out: PseudoRule[]): void {
  for (const sel of rule.selector) {
    const m = re.exec(sel.text);
    if (m === null) continue;
    const elementSelector = sel.text.slice(0, m.index).trim();
    if (elementSelector === "") continue;
    out.push({
      which: m[2]?.toLowerCase() === "after" ? "after" : "before",
      elementSelector,
      declarations: rule.declarations,
      specificity: rule.specificity,
      order: rule.order,
    });
  }
}

/** Rules whose element selector contains no pseudo-element (counter scopes). */
function elementRules(sheets: readonly StyleSheet[]): { selector: string; rule: StyleRule }[] {
  const out: { selector: string; rule: StyleRule }[] = [];
  for (const sheet of sheets) {
    for (const rule of sheet.rules) {
      for (const sel of rule.selector) {
        if (sel.text.includes("::") || /:(before|after)\b/i.test(sel.text)) continue;
        out.push({ selector: sel.text, rule });
      }
    }
  }
  return out;
}

/** Specificity comparison: (a, b, c) lexicographic, then source order. */
function beats(a: PseudoRule | { rule: StyleRule }, b: PseudoRule | { rule: StyleRule }): boolean {
  const sa = "specificity" in a ? a.specificity : a.rule.specificity;
  const sb = "specificity" in b ? b.specificity : b.rule.specificity;
  const oa = "order" in a ? a.order : a.rule.order;
  const ob = "order" in b ? b.order : b.rule.order;
  for (let i = 0; i < 3; i += 1) {
    if (sa[i] !== sb[i]) return (sa[i] ?? 0) > (sb[i] ?? 0);
  }
  return oa > ob;
}

/** The winning declaration value for `prop` among rules matching `el`. */
function winningValue(
  rules: readonly PseudoRule[],
  el: A11yElement,
  which: PseudoPosition,
  prop: string,
  match: ElementMatcher,
): string | null {
  let best: PseudoRule | null = null;
  let value: string | null = null;
  for (const rule of rules) {
    if (rule.which !== which) continue;
    let matched: boolean | null = null;
    for (const decl of rule.declarations) {
      if (decl.property !== prop) continue;
      matched ??= match(el, rule.elementSelector);
      if (matched !== true) break;
      // Within one declaration block the LAST declaration of a property wins;
      // across rules, cascade by specificity then source order.
      if (best === null || rule === best || beats(rule, best)) {
        best = rule;
        value = decl.value;
      }
    }
  }
  return value;
}

/**
 * The winning element-level declaration for `prop` (no pseudo-element) — used
 * for `counter-reset` scoping during the document-order walk.
 */
function winningElementValue(
  rules: readonly { selector: string; rule: StyleRule }[],
  el: A11yElement,
  prop: string,
  match: ElementMatcher,
): string | null {
  let best: { selector: string; rule: StyleRule } | null = null;
  let value: string | null = null;
  for (const entry of rules) {
    for (const decl of entry.rule.declarations) {
      if (decl.property !== prop) continue;
      if (!match(el, entry.selector)) break;
      if (best === null || entry.rule === best.rule || beats(entry, best)) {
        best = entry;
        value = decl.value;
      }
    }
  }
  return value;
}

// ---------------------------------------------------------------------------
// `content` value evaluation (a11y view)
// ---------------------------------------------------------------------------

/**
 * Split a `content` value into its main and alternative-text parts at the
 * top-level `/` separator (slashes inside strings/parens don't split).
 */
function splitAlt(value: string): [string, string | null] {
  let depth = 0;
  let inString: string | null = null;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (inString !== null) {
      if (ch === "\\") i += 1;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") inString = ch;
    else if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (ch === "/" && depth === 0) return [value.slice(0, i), value.slice(i + 1)];
  }
  return [value, null];
}

/** Iterate the comma-free space-separated items of a content component. */
function contentItems(part: string): string[] {
  const items: string[] = [];
  let i = 0;
  while (i < part.length) {
    while (i < part.length && /\s/.test(part[i] ?? "")) i += 1;
    if (i >= part.length) break;
    const ch = part[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      while (j < part.length && part[j] !== quote) {
        if (part[j] === "\\") j += 1;
        j += 1;
      }
      items.push(part.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    // function or identifier: read to whitespace at paren-depth 0
    let j = i;
    let depth = 0;
    while (j < part.length) {
      const c = part[j] ?? "";
      if (c === "(") depth += 1;
      else if (c === ")") depth -= 1;
      else if (depth === 0 && /\s/.test(c)) break;
      j += 1;
    }
    items.push(part.slice(i, j));
    i = j;
  }
  return items;
}

function fnCall(item: string): { name: string; arg: string } | null {
  const m = /^([a-zA-Z-]+)\((.*)\)$/s.exec(item);
  return m === null ? null : { name: (m[1] ?? "").toLowerCase(), arg: (m[2] ?? "").trim() };
}

function unquote(s: string): string {
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) {
    return s.slice(1, -1);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

/** Parse `counter-reset/increment/set` values: "name num name2 num2 …". */
function counterPairs(value: string | null, defaults: number): [string, number][] {
  if (value === null || value === "none") return [];
  const tokens = value.trim().split(/\s+/);
  const out: [string, number][] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const name = tokens[i] ?? "";
    const next = tokens[i + 1];
    const num = next !== undefined && /^-?\d+$/.test(next) ? Number(next) : defaults;
    if (next !== undefined && /^-?\d+$/.test(next)) i += 1;
    out.push([name, num]);
  }
  return out;
}

/**
 * Resolve `counter(name)` at `el`'s ::before/::after position by walking the
 * document in tree order, maintaining per-name scope stacks.
 *
 * Spec scope simplification: a `counter-reset` scope covers the resetting
 * element and its descendants. The full spec also extends the scope to
 * following siblings; WPT's accname counter tests only exercise the
 * descendant scope, which this models exactly.
 */
function counterValueAt(
  el: A11yElement,
  which: PseudoPosition,
  name: string,
  pseudo: readonly PseudoRule[],
  element: readonly { selector: string; rule: StyleRule }[],
  match: ElementMatcher,
  root: A11yElement,
): number {
  const scopes = new Map<string, number[]>();
  const current = (n: string): number => {
    const stack = scopes.get(n);
    return stack !== undefined && stack.length > 0 ? (stack[stack.length - 1] ?? 0) : 0;
  };
  const setTop = (n: string, v: number): void => {
    const stack = scopes.get(n);
    if (stack === undefined || stack.length === 0) scopes.set(n, [v]);
    else stack[stack.length - 1] = v;
  };
  const bump = (n: string, d: number): void => setTop(n, current(n) + d);

  const applyMutations = (x: A11yElement, pos: PseudoPosition): void => {
    for (const [n, v] of counterPairs(winningValue(pseudo, x, pos, "counter-set", match), 0)) {
      setTop(n, v);
    }
    for (const [n, v] of counterPairs(winningValue(pseudo, x, pos, "counter-increment", match), 1)) {
      bump(n, v);
    }
  };

  let found: number | null = null;
  const walk = (x: A11yElement): boolean => {
    if (found !== null) return true;
    const pushed: string[] = [];
    for (const [n, v] of counterPairs(winningElementValue(element, x, "counter-reset", match), 0)) {
      const stack = scopes.get(n) ?? [];
      stack.push(v);
      scopes.set(n, stack);
      pushed.push(n);
    }
    // Element-level counter-set/increment apply before the ::before position.
    for (const [n, v] of counterPairs(winningElementValue(element, x, "counter-set", match), 0)) {
      setTop(n, v);
    }
    for (const [n, v] of counterPairs(winningElementValue(element, x, "counter-increment", match), 1)) {
      bump(n, v);
    }
    applyMutations(x, "before");
    if (x === el && which === "before") {
      found = current(name);
      return true;
    }
    const kids = x.children;
    for (let i = 0; i < kids.length; i += 1) {
      if (walk(kids[i] as A11yElement)) return true;
    }
    applyMutations(x, "after");
    if (x === el && which === "after") {
      found = current(name);
      return true;
    }
    for (const n of pushed) scopes.get(n)?.pop();
    return false;
  };
  walk(root);
  return found ?? 0;
}

// ---------------------------------------------------------------------------
// Public seam
// ---------------------------------------------------------------------------

export interface GeneratedContentResolver {
  (el: A11yElement, which: PseudoPosition): string;
}

/**
 * Build the `pseudoContent` hook: resolve `content` for `el`'s pseudo of the
 * given position — a11y consumes the `/ <alt>` alternative text when present,
 * else the textual items (strings, attr(), counters); images/urls and
 * `none`/`normal` contribute nothing.
 *
 * `root` is the document element (counter scopes walk from it in tree order).
 */
export function makeGeneratedContentResolver(
  sheets: readonly StyleSheet[],
  root: A11yElement,
  match: ElementMatcher,
): GeneratedContentResolver {
  const pseudo = pseudoRules(sheets);
  const element = elementRules(sheets);
  return (el, which) => {
    const raw = winningValue(pseudo, el, which, "content", match);
    if (raw === null) return "";
    const trimmed = raw.trim();
    if (trimmed === "none" || trimmed === "normal") return "";
    const [main, alt] = splitAlt(trimmed);
    // Alternative-text syntax (`content: X / alt`): the alt text is what
    // accessibility consumes, contributed as its own unit — browsers join it
    // to adjacent content with a space. Plain content concatenates raw.
    const part = alt !== null ? alt : main;
    let out = "";
    for (const item of contentItems(part)) {
      const ch = item[0] ?? "";
      if (ch === '"' || ch === "'") {
        out += unquote(item);
        continue;
      }
      const call = fnCall(item);
      if (call === null) continue; // bare keywords/identifiers contribute nothing
      if (call.name === "attr") {
        out += el.getAttribute(call.arg) ?? "";
      } else if (call.name === "counter" || call.name === "counters") {
        const counterName = call.arg.split(",")[0]?.trim() ?? "";
        out += String(counterValueAt(el, which, counterName, pseudo, element, match, root));
      }
      // url()/image()/gradient() items contribute no accessible text.
    }
    return alt !== null && out !== "" ? ` ${out} ` : out;
  };
}
