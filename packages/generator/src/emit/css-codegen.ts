/**
 * css-codegen.ts — emit the CSS artifacts from the property data table
 * (design.md §4.2, §8.5; Requirement 6.2).
 *
 * Every function here takes the declarative `CSS_PROPERTIES` table (or any
 * compatible table — see `add-property.test.ts`, Requirement 6.5) and returns a
 * {@link GeneratedFile} of TypeScript *source*. Four artifacts are derived,
 * each with ZERO hand-written per-property boilerplate:
 *
 *   - `css-parsing.ts`        ← one value parser per property's `syntax`
 *   - `css-initial-values.ts` ← the initial-value table from each `initial`
 *   - `css-inheritance.ts`    ← the inheritance table from each `inherited`
 *   - `computed-style-fields.ts` ← the ComputedStyle field types from `tsType`
 *
 * Adding a CSS property is therefore "one data row + its `computeValue`": the
 * emitter rebuilds all four artifacts from the new table with no other change
 * (Requirement 6.5). Every emitted file opens with an `@generated` banner so the
 * Scoreboard excludes it from the compat-per-LOC denominator (Requirement 1.2).
 */
import type { CssPropertyDef } from "../css-property-def.js";
import type { ValueGrammar } from "../value-grammar.js";
import {
  banner,
  importLines,
  quote,
  stringArrayLiteral,
  type GeneratedFile,
} from "./emit-support.js";

/** Path (relative to the generated dir) of the emitted value-parser module. */
export const CSS_PARSER_FILE = "css-parsing.ts";
/** Path of the emitted initial-value table module. */
export const CSS_INITIAL_VALUES_FILE = "css-initial-values.ts";
/** Path of the emitted inheritance table module. */
export const CSS_INHERITANCE_FILE = "css-inheritance.ts";
/** Path of the emitted ComputedStyle field-types module. */
export const COMPUTED_STYLE_FIELDS_FILE = "computed-style-fields.ts";

// ---------------------------------------------------------------------------
// Type-import resolution for `tsType` strings.
// ---------------------------------------------------------------------------

/** Base type names exported by `@browser-engine/ir` that a `tsType` may name. */
const IR_TYPE_NAMES: ReadonlySet<string> = new Set([
  "Color",
  "DisplayValue",
  "Edges",
  "Px",
  "Rect",
  "Point",
  "BoxGeometry",
  "PositionValue",
  "FloatValue",
  "FlexDirection",
]);

/** Base type names exported by the generator's own value-grammar module. */
const GRAMMAR_TYPE_NAMES: ReadonlySet<string> = new Set(["LengthOrAuto", "LengthSizing", "TransformValue"]);

/** Extract the distinct identifier tokens that appear in a `tsType` string. */
function typeIdentifiers(tsType: string): readonly string[] {
  const matches = tsType.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  return [...new Set(matches)];
}

/**
 * Resolve the set of type identifiers used across all `tsType`s into the import
 * lines that supply them, split by their source module.
 */
function resolveTypeImports(properties: readonly CssPropertyDef[]): {
  readonly ir: readonly string[];
  readonly grammar: readonly string[];
} {
  const ir = new Set<string>();
  const grammar = new Set<string>();
  for (const property of properties) {
    for (const ident of typeIdentifiers(property.tsType)) {
      if (IR_TYPE_NAMES.has(ident)) {
        ir.add(ident);
      } else if (GRAMMAR_TYPE_NAMES.has(ident)) {
        grammar.add(ident);
      }
    }
  }
  return { ir: [...ir], grammar: [...grammar] };
}

// ---------------------------------------------------------------------------
// Value serialization (generic — drives the initial-value table).
// ---------------------------------------------------------------------------

/** Quote an object key as an identifier, or as a string literal when needed. */
function objectKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : quote(key);
}

/**
 * Serialize an arbitrary initial value into a TypeScript source expression.
 * Handles the JSON-shaped value space the data table uses (numbers, strings,
 * booleans, arrays, plain objects). Generic on purpose: a brand-new property
 * whose initial value is any such structure serializes with no new emitter code
 * (Requirement 6.5). Throws loudly on a value it cannot represent, so a
 * malformed data row fails generation rather than emitting `NaN`/`undefined`.
 */
export function serializeValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "number": {
      if (!Number.isFinite(value)) {
        throw new Error(`cannot serialize non-finite number: ${String(value)}`);
      }
      return Object.is(value, -0) ? "0" : String(value);
    }
    case "string":
      return quote(value);
    case "boolean":
      return value ? "true" : "false";
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map(serializeValue).join(", ")}]`;
      }
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 0) {
        return "{}";
      }
      const parts = entries.map(
        ([key, val]) => `${objectKey(key)}: ${serializeValue(val)}`,
      );
      return `{ ${parts.join(", ")} }`;
    }
    default:
      throw new Error(`cannot serialize value of type ${typeof value}`);
  }
}

// ---------------------------------------------------------------------------
// Parser emission.
// ---------------------------------------------------------------------------

/** A runtime parsing primitive call plus the primitive name it depends on. */
interface ParserCall {
  readonly expr: string;
  readonly primitive: string;
}

/** Map a declarative {@link ValueGrammar} to the runtime primitive call. */
function parserCallFor(grammar: ValueGrammar): ParserCall {
  switch (grammar.kind) {
    case "keyword":
      return {
        expr: `parseKeyword(value, ${stringArrayLiteral(grammar.keywords)})`,
        primitive: "parseKeyword",
      };
    case "color":
      return { expr: "parseColor(value)", primitive: "parseColor" };
    case "length":
      return { expr: "parseLength(value)", primitive: "parseLength" };
    case "length-or-keyword":
      return {
        expr: `parseLengthOrKeyword(value, ${stringArrayLiteral(grammar.keywords)})`,
        primitive: "parseLengthOrKeyword",
      };
    case "edges":
      return { expr: "parseEdgesLength(value)", primitive: "parseEdgesLength" };
    case "integer":
      return {
        expr: `parseInteger(value, ${boundsLiteral(grammar.min, grammar.max)})`,
        primitive: "parseInteger",
      };
    case "number":
      return {
        expr: `parseNumber(value, ${boundsLiteral(grammar.min, grammar.max)})`,
        primitive: "parseNumber",
      };
    case "transform":
      return { expr: "parseTransform(value)", primitive: "parseTransform" };
    case "string":
      return { expr: "parseString(value)", primitive: "parseString" };
    default: {
      const never: never = grammar;
      throw new Error(`unknown value grammar: ${JSON.stringify(never)}`);
    }
  }
}

/** Serialize the optional `{min,max}` bounds of an integer/number grammar. */
function boundsLiteral(min?: number, max?: number): string {
  const parts: string[] = [];
  if (min !== undefined) parts.push(`min: ${serializeValue(min)}`);
  if (max !== undefined) parts.push(`max: ${serializeValue(max)}`);
  return parts.length === 0 ? "{}" : `{ ${parts.join(", ")} }`;
}

/** The emitted per-property parser function name, e.g. `parseColorValue`. */
function parserFnName(property: CssPropertyDef): string {
  const field = property.field;
  return `parse${field[0]?.toUpperCase() ?? ""}${field.slice(1)}Value`;
}

/**
 * Emit `css-parsing.ts`: one value parser per property delegating to the
 * hand-written runtime primitives (`value-runtime.ts`) chosen by each
 * property's `syntax`, a `PROPERTY_PARSERS` lookup keyed by CSS property name,
 * and a `parsePropertyValue` dispatcher that throws `NotImplemented` for an
 * unknown property (Requirement 5.1).
 */
export function emitCssParser(properties: readonly CssPropertyDef[]): GeneratedFile {
  const usedPrimitives = new Set<string>();
  const fnBlocks: string[] = [];
  const tableRows: string[] = [];

  for (const property of properties) {
    const call = parserCallFor(property.syntax);
    usedPrimitives.add(call.primitive);
    const fn = parserFnName(property);
    fnBlocks.push(
      [
        `/** Parse a \`${property.name}\` value. */`,
        `export function ${fn}(value: string): ParseResult<unknown> {`,
        `  return ${call.expr};`,
        `}`,
      ].join("\n"),
    );
    tableRows.push(`  ${quote(property.name)}: ${fn},`);
  }

  const runtimeImport = importLines(
    "../value-runtime.js",
    [...usedPrimitives].sort(),
    ["ParseResult"],
  );

  const contents = `${banner(
    "CSS value parsers — one per property's declarative grammar (Requirement 6.2).",
  )}
${runtimeImport}
import { notImplemented } from "@browser-engine/ir";

/** A parser from a raw declaration value string to a typed parse result. */
export type PropertyValueParser = (value: string) => ParseResult<unknown>;

${fnBlocks.join("\n\n")}

/** Every property's value parser, keyed by its CSS property name. */
export const PROPERTY_PARSERS: Readonly<Record<string, PropertyValueParser>> = {
${tableRows.join("\n")}
};

/**
 * Parse the value of \`property\`. A known property returns a {@link ParseResult}
 * (\`ok\` value or \`reason\`); an unknown property is an unimplemented capability
 * and throws \`NotImplemented\` (Requirement 5.1).
 */
export function parsePropertyValue(
  property: string,
  value: string,
): ParseResult<unknown> {
  const parser = PROPERTY_PARSERS[property];
  if (parser === undefined) {
    return notImplemented(\`css-property:\${property}\`, {
      category: "css-property",
      detail: "no parser is generated for this property (not in the data table)",
    });
  }
  return parser(value);
}
`;

  return { path: CSS_PARSER_FILE, contents };
}

/**
 * Emit `css-initial-values.ts`: the initial computed value for every property,
 * keyed by ComputedStyle field name, typed by the generated field interface.
 */
export function emitInitialValues(properties: readonly CssPropertyDef[]): GeneratedFile {
  const rows = properties.map(
    (property) => `  ${objectKey(property.field)}: ${serializeValue(property.initial)},`,
  );

  const contents = `${banner(
    "Initial computed values, one per property (Requirement 6.2).",
  )}
import type { GeneratedComputedStyleFields } from "./computed-style-fields.js";

/**
 * The initial (computed) value of every CSS property, keyed by its ComputedStyle
 * field name. The cascade uses these for any non-inherited property a node does
 * not declare (Requirement 11.4). Branded numeric fields (e.g. \`Px\`) are widened
 * here as plain numbers and recovered by the field-typed assertion.
 */
export const INITIAL_VALUES = {
${rows.join("\n")}
} as GeneratedComputedStyleFields;
`;

  return { path: CSS_INITIAL_VALUES_FILE, contents };
}

/**
 * Emit `css-inheritance.ts`: whether each property inherits, keyed by CSS
 * property name. The cascade uses this for any property a node does not declare
 * (Requirement 11.3 / 11.4).
 */
export function emitInheritance(properties: readonly CssPropertyDef[]): GeneratedFile {
  const rows = properties.map(
    (property) => `  ${objectKey(property.name)}: ${property.inherited ? "true" : "false"},`,
  );

  const contents = `${banner(
    "Inheritance flags, one per property (Requirement 6.2).",
  )}
/**
 * Whether each CSS property inherits, keyed by its CSS property name. Consumed
 * by the cascade to choose between the parent value (inherited) and the initial
 * value (non-inherited) when a node has no declaration (Requirements 11.3, 11.4).
 */
export const INHERITED_PROPERTIES: Readonly<Record<string, boolean>> = {
${rows.join("\n")}
};

/** The names of the properties that inherit. */
export const INHERITED_PROPERTY_NAMES: readonly string[] = [
${properties
  .filter((p) => p.inherited)
  .map((p) => `  ${quote(p.name)},`)
  .join("\n")}
];
`;

  return { path: CSS_INHERITANCE_FILE, contents };
}

/**
 * Emit `computed-style-fields.ts`: the typed ComputedStyle field for every
 * property (from each `tsType`), plus the list of field names. This is the
 * single generated description of the cascade's output shape (Requirement 6.2).
 */
export function emitComputedStyleFields(
  properties: readonly CssPropertyDef[],
): GeneratedFile {
  const { ir, grammar } = resolveTypeImports(properties);
  const imports = [
    importLines("@browser-engine/ir", [], ir),
    importLines("../value-grammar.js", [], grammar),
  ]
    .filter((line) => line.length > 0)
    .join("\n");

  const fieldLines = properties.map(
    (property) => `  readonly ${property.field}: ${property.tsType};`,
  );

  const nameLines = properties.map((property) => `  ${quote(property.field)},`);

  const contents = `${banner(
    "ComputedStyle field types, one per property (Requirement 6.2).",
  )}
${imports}

/**
 * The typed fields the cascade produces, one per CSS property in the data table.
 * Every field carries a computed value (Requirement 11.1); this interface is the
 * generated source of truth for that shape.
 */
export interface GeneratedComputedStyleFields {
${fieldLines.join("\n")}
}

/** The ComputedStyle field names, in data-table order. */
export const COMPUTED_STYLE_FIELD_NAMES: readonly string[] = [
${nameLines.join("\n")}
];
`;

  return { path: COMPUTED_STYLE_FIELDS_FILE, contents };
}

/**
 * Emit all four CSS artifacts from the property table (Requirement 6.2). The
 * order is deterministic and stable across runs for a given table.
 */
export function emitCssArtifacts(
  properties: readonly CssPropertyDef[],
): readonly GeneratedFile[] {
  return [
    emitComputedStyleFields(properties),
    emitInitialValues(properties),
    emitInheritance(properties),
    emitCssParser(properties),
  ];
}
