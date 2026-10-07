#!/usr/bin/env node
/**
 * import-properties.mjs — one-shot adapter: Ladybird's CSS property data table
 * (ladybird-master/Libraries/LibWeb/CSS/Properties.json, BSD-2-Clause,
 * https://github.com/LadybirdBrowser/ladybird) → our CssPropertyDef rows.
 *
 * Strategy (see docs/EVIDENCE.md "Platform-as-Data"):
 *   - properties whose value grammar is expressible in our closed ValueGrammar
 *     vocabulary become TYPED rows (keyword/length/percentage/color/integer/
 *     number/time/url/string);
 *   - everything else becomes a STRING-OPAQUE row — the project's established
 *     `stringProp` idiom: the value parses to its canonical string form and is
 *     stored honestly as a string for future typed upgrade (never a fake value);
 *   - names that already exist in our hand-tuned table are SKIPPED (ours win);
 *   - shorthands are imported as opaque rows carrying their longhands metadata;
 *   - legacy (-webkit-*) and logical aliases are captured as alias DATA
 *     (unwired — the aliasing mechanism is a follow-up).
 *
 * Output: packages/generator/src/generated/ladybird-properties.data.ts
 * (banner-marked, committed, excluded from the hand-written LOC denominator).
 *
 * Run: node tools/ladybird-import/import-properties.mjs
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LADYBIRD_JSON = path.join(ROOT, "ladybird-master/Libraries/LibWeb/CSS/Properties.json");
const OUT = path.join(ROOT, "packages/generator/src/generated/ladybird-properties.data.ts");

// ---- our existing property names (conflict detection) ----------------------
// Extract names from `name: "x"` row literals AND the known row-factory helper
// calls (`edgeLength("margin-top")`, `stringProp("aspect-ratio", …)`, …).
// Comments are stripped first so doc examples never register as properties.
const ROW_HELPERS = [
  "edgeLength", "sizing", "edgeColor", "edgeLineStyle", "stringProp",
  "lenProp", "numProp", "intProp", "colorProp",
];

function existingNames() {
  const names = new Set();
  const files = [
    "packages/generator/src/css-properties.data.ts",
    "packages/generator/src/shorthand-expansion.ts",
  ];
  for (const rel of files) {
    const src = readFileSync(path.join(ROOT, rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    for (const m of src.matchAll(/\bname:\s*"([^"]+)"/g)) names.add(m[1]);
    for (const helper of ROW_HELPERS) {
      const re = new RegExp(`\\b${helper}\\(\\s*"([^"]+)"`, "g");
      for (const m of src.matchAll(re)) names.add(m[1]);
    }
    // shorthand-expansion table keys:  margin: { ... }
    for (const m of src.matchAll(/^\s{2}"?([a-z][a-z0-9-]+)"?\s*:\s*\{/gm)) names.add(m[1]);
  }
  return names;
}

// ---- parsing Ladybird valid-types tokens ------------------------------------
// e.g. "length [0,∞]" → { base: "length", min: 0, max: undefined }
function parseTypeToken(token) {
  const m = /^([a-z-]+)(?:\s*\[([^\]]*)\])?$/.exec(token);
  if (!m) return { base: token, min: undefined, max: undefined };
  const bounds = (m[2] ?? "").split(",").map((s) => s.trim());
  const parseBound = (s) => {
    if (s === undefined || s === "" || s === "-∞" || s === "−∞") return undefined;
    if (s === "∞" || s === "+∞") return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  };
  return { base: m[1], min: parseBound(bounds[0]), max: parseBound(bounds[1]) };
}

// valid-identifiers occasionally uses "overlay>auto" (alias notation) — take
// the surface keyword. Drop tokens that are not plain identifiers.
function sanitizeIdentifiers(list) {
  const out = [];
  for (const raw of list ?? []) {
    const token = String(raw).split(">")[0].trim().toLowerCase();
    if (/^[a-z][a-z0-9-]*$/.test(token) && !out.includes(token)) out.push(token);
  }
  return out;
}

// ---- classification ----------------------------------------------------------
const LENGTH_TYPES = new Set(["length", "percentage", "fit-content"]);

function classify(name, entry) {
  const types = (entry["valid-types"] ?? []).map(parseTypeToken);
  const idents = sanitizeIdentifiers(entry["valid-identifiers"]);
  const bases = new Set(types.map((t) => t.base));

  // Strip fit-content into a keyword (its function form `fit-content(10px)`
  // is over-rejected for now — documented wave-1 gap).
  const kwExtra = bases.has("fit-content") ? ["fit-content"] : [];
  if (bases.has("fit-content")) bases.delete("fit-content");
  const keywords = [...new Set([...idents, ...kwExtra])];

  const boundsOf = (base) => {
    const t = types.find((x) => x.base === base);
    return { min: t?.min, max: t?.max };
  };

  // length / percentage families (our parseLength natively handles %, em,
  // rem, viewport units and calc() → SpecifiedLength / SpecifiedCalc).
  if (bases.size > 0 && [...bases].every((b) => LENGTH_TYPES.has(b))) {
    return { tier: "length", keywords, bounds: boundsOf("length") };
  }
  if (bases.size === 1 && bases.has("integer")) {
    return { tier: "integer", keywords, bounds: boundsOf("integer") };
  }
  if (bases.size === 1 && (bases.has("number") || bases.has("opacity-value"))) {
    const b = bases.has("opacity-value") ? { min: 0, max: 1 } : boundsOf("number");
    return { tier: "number", keywords, bounds: b };
  }
  if (bases.size === 1 && bases.has("color")) {
    // currentcolor / unknown-color-keyword initials can't be typed yet → opaque.
    if (keywords.length) return { tier: "string", keywords: [] };
    return { tier: "color", keywords };
  }
  if (bases.size === 1 && bases.has("time")) {
    return { tier: "time", keywords, bounds: { min: 0, max: undefined } };
  }
  if (bases.size === 1 && bases.has("url")) {
    return { tier: "url", keywords };
  }
  if (bases.size === 1 && bases.has("string") && idents.length === 0) {
    return { tier: "string", keywords: [] };
  }
  if (bases.size === 0 && idents.length > 0) {
    return { tier: "keyword", keywords };
  }
  // Named / composite grammars (align-content, image, position, transform-list,
  // dashed-ident, custom-ident, ratio, …) → honest opaque string rows.
  return { tier: "string", keywords: [] };
}

// ---- initial value interpretation --------------------------------------------
// Ladybird initials are strings ("0", "auto", "16", "transparent", …). Map to
// our typed initial for typed tiers; string tiers keep the string verbatim.
const COLOR_NAMES = new Set(["black", "white", "red", "green", "blue", "transparent"]);
const NAMED_COLOR_RGB = {
  black: { r: 0, g: 0, b: 0, a: 1 },
  white: { r: 255, g: 255, b: 255, a: 1 },
  red: { r: 255, g: 0, b: 0, a: 1 },
  green: { r: 0, g: 128, b: 0, a: 1 },
  blue: { r: 0, g: 0, b: 255, a: 1 },
  transparent: { r: 0, g: 0, b: 0, a: 0 },
};

function absolutePx(token) {
  const t = token.toLowerCase().trim();
  if (t === "0") return 0;
  const m = /^(-?(?:\d+\.?\d*|\.\d+))(px|in|pc|pt|cm|mm|q)$/.exec(t);
  if (!m) return null;
  const factors = { px: 1, in: 96, pc: 16, pt: 96 / 72, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 25.4 / 4 };
  return Number(m[1]) * factors[m[2]];
}

function typedInitial(tier, initialRaw, keywords) {
  const s = String(initialRaw ?? "").trim();
  const lower = s.toLowerCase();
  switch (tier) {
    case "keyword":
    case "string":
    case "url":
      return { expr: JSON.stringify(lower || s), ts: "string" };
    case "color": {
      if (COLOR_NAMES.has(lower)) return { expr: JSON.stringify(NAMED_COLOR_RGB[lower]), ts: "Color", colorLiteral: NAMED_COLOR_RGB[lower] };
      if (lower === "currentcolor") return { expr: JSON.stringify(lower), ts: "string" }; // keyword-opaque (defined resolution is a wave-2 mechanism)
      return null; // unparsable color initial → caller falls back to opaque
    }
    case "integer":
    case "number": {
      if (keywords.includes(lower)) return { expr: JSON.stringify(lower), ts: "number | " + JSON.stringify(lower) };
      const n = Number(s);
      if (Number.isFinite(n)) return { expr: String(n), ts: "number" };
      // e.g. font-weight "400" arrives as number already; "medium" handled by caller.
      return null;
    }
    case "time": {
      const n = Number(s.replace(/m?s$/, ""));
      if (Number.isFinite(n)) return { expr: String(s.endsWith("ms") ? n / 1000 : n), ts: "number" };
      return { expr: "0", ts: "number" };
    }
    case "length": {
      if (keywords.includes(lower)) {
        const kwTs = keywords.length === 1 && keywords[0] === "auto" ? "LengthOrAuto" : `Px | ${keywords.map((k) => JSON.stringify(k)).join(" | ")}`;
        return { expr: JSON.stringify(lower), ts: kwTs };
      }
      const pxv = absolutePx(s);
      if (pxv !== null) return { expr: `px(${pxv})`, ts: keywords.length ? `Px | ${keywords.map((k) => JSON.stringify(k)).join(" | ")}` : "Px" };
      const pct = /^(-?(?:\d+\.?\d*|\.\d+))%$/.exec(lower);
      if (pct) {
        return {
          expr: `{ kind: "specified-length", value: ${pct[1]}, unit: "%" }`,
          ts: `Px | SpecifiedLength${keywords.length ? " | " + keywords.map((k) => JSON.stringify(k)).join(" | ") : ""}`,
        };
      }
      return null; // e.g. "medium" for border widths — caller falls back
    }
  }
  return null;
}

// ---- grammar expression emission ----------------------------------------------
const kwList = (keywords) => keywords.map((k) => JSON.stringify(k)).join(", ");

function grammarExpr(tier, keywords, bounds) {
  switch (tier) {
    case "keyword": mark("keyword"); return `keyword(${kwList(keywords)})`;
    case "string": mark("stringValue"); return "stringValue()";
    case "url": mark("stringValue"); return "stringValue()";
    case "color": mark("color"); return "color()";
    case "integer": {
      const b = [];
      if (bounds.min !== undefined) b.push(`min: ${bounds.min}`);
      if (bounds.max !== undefined) b.push(`max: ${bounds.max}`);
      const boundsExpr = b.length ? `{ ${b.join(", ")} }` : "{}";
      if (keywords.length) {
        mark("integerOrKeyword");
        return `integerOrKeyword(${JSON.stringify(keywords)}, ${boundsExpr})`;
      }
      mark("integer");
      return `integer(${boundsExpr})`;
    }
    case "number": {
      const b = [];
      if (bounds.min !== undefined) b.push(`min: ${bounds.min}`);
      if (bounds.max !== undefined) b.push(`max: ${bounds.max}`);
      mark("number");
      return `number({${b.length ? " " + b.join(", ") + " " : ""}})`;
    }
    case "time": mark("number"); return `number({ min: ${bounds.min ?? 0} })`;
    case "length": {
      // lengthOr() already accepts px/absolute/em/rem/viewport/% and calc().
      mark("lengthOr");
      return keywords.length ? `lengthOr(${kwList(keywords)})` : "lengthOr()";
    }
  }
  throw new Error(`no grammar for tier ${tier}`);
}

// ---- metadata passthrough ------------------------------------------------------
const META_FIELDS = {
  "style-group": "styleGroup",
  "affects-layout": "affectsLayout",
  "affects-stacking-context": "affectsStackingContext",
  "affects-accumulated-visual-contexts": "affectsAccumulatedVisualContexts",
  "affects-scrollable-overflow": "affectsScrollableOverflow",
  "percentages-resolve-to": "percentagesResolveTo",
  "requires-computation": "requiresComputation",
  "needs-layout-for-getcomputedstyle": "needsLayoutForGetComputedStyle",
  "needs-layout-node-for-resolved-value": "needsLayoutNodeForResolvedValue",
  "quirks": "quirks",
  "longhands": "longhands",
  "multiplicity": "multiplicity",
};

function metaExpr(entry) {
  const lines = [];
  for (const [lb, ours] of Object.entries(META_FIELDS)) {
    if (entry[lb] !== undefined) lines.push(`  ${ours}: ${JSON.stringify(entry[lb])},`);
  }
  return lines.length ? "\n" + lines.join("\n") : "";
}

// ---- usage tracking for emission ---------------------------------------------
// `used` counts how many rows reference each symbol so the emitted import list
// is exact (noUnusedLocals fails the build on an unused import).
const used = new Map();
const mark = (sym, n = 1) => used.set(sym, (used.get(sym) ?? 0) + n);

// ---- main -----------------------------------------------------------------------
const ladybird = JSON.parse(readFileSync(LADYBIRD_JSON, "utf8"));
const ours = existingNames();

const rows = [];
const aliases = [];
const report = { conflicts: [], tiers: {}, fallback: [], skipped: [] };
const bump = (k) => { report.tiers[k] = (report.tiers[k] ?? 0) + 1; };

for (const [name, entry] of Object.entries(ladybird)) {
  // aliases — data only, mechanism is a follow-up.
  const legacy = entry["legacy-alias-for"];
  const logical = entry["logical-alias-for"];
  if (legacy || logical) {
    if (!ours.has(name)) {
      aliases.push({
        name,
        kind: legacy ? "legacy" : "logical",
        target: legacy ?? undefined,
        group: logical?.group,
        mapping: logical?.mapping,
      });
    }
    continue;
  }

  const isShorthand = Array.isArray(entry.longhands) && entry.longhands.length > 0 && entry["valid-types"] === undefined && entry["valid-identifiers"] === undefined;

  if (ours.has(name)) {
    report.conflicts.push(name);
    continue;
  }
  if (name.startsWith("-")) {
    report.skipped.push({ name, reason: "vendor-prefixed non-alias" });
    continue;
  }
  // The SVG `x`/`y` properties collide with the Req 3.3 constitution guard
  // ("ComputedStyle must not carry geometry field x/y"). Defer them until the
  // SVG layout phase revisits the guard with proper justification.
  if (name === "x" || name === "y") {
    report.skipped.push({ name, reason: "collides with Req 3.3 geometry guard; defer to SVG phase" });
    continue;
  }

  const inherited = entry.inherited === true;
  const animationType =
    entry["animation-type"] === "discrete" ? "discrete" : "by-computed-value";

  if (isShorthand) {
    rows.push({
      name, tier: "shorthand", inherited, animationType,
      initial: JSON.stringify(String(entry.initial ?? "none").toLowerCase()),
      ts: "string", grammar: "stringValue()", meta: metaExpr(entry),
    });
    bump("shorthand");
    continue;
  }

  let cls = classify(name, entry);
  let init = typedInitial(cls.tier, entry.initial ?? "", cls.keywords);
  if (init === null) {
    // Unrepresentable typed initial (e.g. "medium" border width, system color)
    // → honest opaque string row instead of a fabricated value.
    report.fallback.push({ name, from: cls.tier, initial: entry.initial });
    cls = { tier: "string", keywords: [] };
    init = { expr: JSON.stringify(String(entry.initial ?? "").toLowerCase()), ts: "string" };
  }

  rows.push({
    name, tier: cls.tier, inherited, animationType,
    initial: init.expr, ts: init.ts,
    grammar: grammarExpr(cls.tier, cls.keywords, cls.bounds ?? {}),
    meta: metaExpr(entry),
  });
  bump(cls.tier);
}

// ---- emit ----------------------------------------------------------------------
// Complete the usage map built by grammarExpr's mark() calls: px() initials and
// type names inside tsType strings (emitted as JSON strings — never real type
// references, so no type imports are needed for them).
for (const r of rows) {
  if (r.initial.includes("px(")) mark("px");
}
const ctorList = ["color", "integer", "integerOrKeyword", "keyword", "lengthOr", "number", "string as stringValue"]
  .filter((c) => used.has(c.replace("string as stringValue", "stringValue")));

const banner = `/**
 * @generated by tools/ladybird-import/import-properties.mjs — DO NOT EDIT.
 *
 * CSS property rows derived from Ladybird Browser's Properties.json
 * (BSD-2-Clause, https://github.com/LadybirdBrowser/ladybird).
 * Ladybird Copyright (c) the Ladybird authors.
 *
 * Rows whose value grammar is expressible in our ValueGrammar vocabulary are
 * typed; the rest are honest string-opaque rows (the project's stringProp
 * idiom) pending typed upgrades. Aliases are data only — the aliasing
 * mechanism is a follow-up.
 */`;

// Safety net: dedupe within the output (keep first), and re-check conflicts.
const seen = new Set();
const deduped = rows.filter((r) => {
  if (seen.has(r.name) || ours.has(r.name)) {
    report.lateConflicts = (report.lateConflicts ?? 0) + 1;
    return false;
  }
  seen.add(r.name);
  return true;
});
rows.length = 0;
rows.push(...deduped);

const rowSrc = rows.map((r) => `defineProperty({
  name: ${JSON.stringify(r.name)},
  inherited: ${r.inherited},
  initial: ${r.initial},
  syntax: ${r.grammar},
  computeValue: (s) => s,
  animationType: ${JSON.stringify(r.animationType)},
  tsType: ${JSON.stringify(r.ts)},${r.meta ?? ""}
})`).join(",\n");

const aliasSrc = aliases.map((a) => `  ${JSON.stringify(a)}`).join(",\n");

const out = `${banner}
${used.has("px") ? 'import { px } from "@browser-engine/ir";\n' : ""}import { defineProperty, type CssPropertyDef } from "../css-property-def.js";
import { ${ctorList.join(", ")} } from "../value-grammar.js";
/** Imported property rows (Ladybird-derived). See file banner. */
export const LADYBIRD_PROPERTIES: readonly CssPropertyDef[] = [
${rowSrc},
];

/** Alias mappings (legacy -webkit-* and logical), data only — unwired. */
export const LADYBIRD_ALIASES: readonly { name: string; kind: "legacy" | "logical"; target?: string; group?: string; mapping?: string }[] = [
${aliasSrc}
];
`;

writeFileSync(OUT, out);

console.log("== import-properties report ==");
console.log("tiers:", JSON.stringify(report.tiers, null, 2));
console.log("conflicts (ours win):", report.conflicts.length, "late-dedup:", report.lateConflicts ?? 0);
console.log("typed→opaque fallbacks:", report.fallback.length, JSON.stringify(report.fallback.slice(0, 10)));
console.log("skipped:", JSON.stringify(report.skipped));
console.log("aliases:", aliases.length);
console.log("total rows:", rows.length);
console.log("wrote", path.relative(ROOT, OUT));
