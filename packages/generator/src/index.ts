/**
 * @browser-engine/generator
 *
 * Platform-as-Data code generator (design.md §4.2, §8.5). It produces, FROM the
 * declarative data tables and with zero hand-written per-property boilerplate:
 *   - the CSS value parser, initial-value table, inheritance table, and
 *     ComputedStyle field types (from `CSS_PROPERTIES`; Requirement 6.2), and
 *   - the guest-visible DOM surface (from `DOM_INTERFACES`; Requirement 6.3).
 *
 * DOM-surface generation is INDEPENDENT of CSS-parser generation: a failure in
 * one path does not block the other (Requirement 6.4 — see {@link generate}).
 * Adding a CSS property is one data-table row plus its `computeValue`; every
 * artifact is regenerated from the table with no other hand-written change
 * (Requirement 6.5).
 *
 * Generated output lives in `./generated/*` (committed, `@generated`-marked so
 * the Scoreboard excludes it from the compat-per-LOC denominator —
 * Requirement 1.2). Because the generator is *infrastructure* (not a pipeline
 * stage), downstream stages — both the css-parser (task 3.3) and the cascade
 * (task 3.4) — import these artifacts from here, the single sanctioned,
 * lint-clean surface, instead of from each other (which `no-cross-stage-import`
 * would forbid).
 */
export const PACKAGE_NAME = "@browser-engine/generator" as const;

// ---- data tables (the "data" half of Platform-as-Data) --------------------
export { CSS_PROPERTIES } from "./css-properties.data.js";
export {
  DOM_INTERFACES,
  arg,
  attribute,
  iface,
  nullable,
  operation,
  sequence,
} from "./dom-interfaces.idl.js";
export { defineProperty, toCamelCase } from "./css-property-def.js";
export type {
  AnimationType,
  ComputeCtx,
  CssPropertyDef,
} from "./css-property-def.js";
export type {
  IdlArgument,
  IdlAttribute,
  IdlInterface,
  IdlInterfaceRef,
  IdlMember,
  IdlNullable,
  IdlOperation,
  IdlPrimitive,
  IdlSequence,
  IdlType,
} from "./dom-interfaces.idl.js";

// ---- declarative value grammars + runtime parsing primitives --------------
export { color, edges, integer, keyword, length, lengthOr, number, string, transform } from "./value-grammar.js";
export type {
  ColorGrammar,
  EdgesGrammar,
  IntegerGrammar,
  KeywordGrammar,
  LengthGrammar,
  LengthOrAuto,
  LengthOrKeywordGrammar,
  LengthSizing,
  NumberGrammar,
  StringGrammar,
  TransformGrammar,
  TransformValue,
  ValueGrammar,
} from "./value-grammar.js";
export {
  err,
  isSpecifiedLength,
  ok,
  parseColor,
  parseDisplay,
  parseEdgesLength,
  parseInteger,
  parseKeyword,
  parseLength,
  parseLengthOrKeyword,
  parseNumber,
  parseString,
  parseTransform,
} from "./value-runtime.js";
export type { ParseResult, SpecifiedLength } from "./value-runtime.js";

// ---- the emitters (the "code generation" half) ----------------------------
export {
  COMPUTED_STYLE_FIELDS_FILE,
  CSS_INHERITANCE_FILE,
  CSS_INITIAL_VALUES_FILE,
  CSS_PARSER_FILE,
  emitComputedStyleFields,
  emitCssArtifacts,
  emitCssParser,
  emitInheritance,
  emitInitialValues,
  serializeValue,
} from "./emit/css-codegen.js";
export {
  DOM_SURFACE_FILE,
  emitDomArtifacts,
  emitDomSurface,
} from "./emit/dom-codegen.js";
export { banner } from "./emit/emit-support.js";
export type { GeneratedFile } from "./emit/emit-support.js";

// ---- the top-level isolated generation entry (Requirement 6.4) ------------
export { generate } from "./emit/generate.js";
export type {
  GenerateInput,
  GenerateResult,
  PathResult,
} from "./emit/generate.js";

// ---- re-export the committed generated artifacts -------------------------
// Downstream stages import the generated CSS parser, initial-value table,
// inheritance table, ComputedStyle field types, and DOM surface from here.
export {
  PROPERTY_PARSERS,
  parsePropertyValue,
  type PropertyValueParser,
} from "./generated/css-parsing.js";
export { INITIAL_VALUES } from "./generated/css-initial-values.js";
export {
  INHERITED_PROPERTIES,
  INHERITED_PROPERTY_NAMES,
} from "./generated/css-inheritance.js";
export {
  COMPUTED_STYLE_FIELD_NAMES,
  type GeneratedComputedStyleFields,
} from "./generated/computed-style-fields.js";
export {
  DOM_INTERFACE_NAMES,
  DOM_SURFACE,
  type AttributeDescriptor,
  type InterfaceDescriptor,
  type MemberDescriptor,
  type OperationDescriptor,
} from "./generated/dom-surface.js";
