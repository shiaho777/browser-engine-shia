/**
 * `CSS.supports` and the CSSOM rule for dropping a declaration the engine
 * cannot parse. Known properties accept only values their grammar accepts,
 * plus the CSS-wide keywords. Custom properties accept any value.
 */
import { CSS_PROPERTIES, PROPERTY_PARSERS, isSpecifiedCalc, isSpecifiedLength, parsePropertyValue } from "@browser-engine/generator";
import type { CalcNode } from "@browser-engine/generator";
import { supportsConditionMatches } from "@browser-engine/css-parser";

const CSS_WIDE_KEYWORDS = new Set(["inherit", "initial", "unset", "revert", "revert-layer"]);

export function cssValueAccepted(property: string, value: string): boolean {
  const name = property.trim().toLowerCase();
  const text = value.trim();
  if (name === "" || text === "") return false;
  if (name.startsWith("--")) return true;
  if (!Object.prototype.hasOwnProperty.call(PROPERTY_PARSERS, name)) return false;
  if (CSS_WIDE_KEYWORDS.has(text.toLowerCase())) return true;
  try {
    return parsePropertyValue(name, text).ok === true;
  } catch {
    return false;
  }
}

/** The specified value CSSOM stores, or null when the declaration is dropped. */
export function canonicalCssValue(property: string, value: string): string | null {
  const name = property.trim().toLowerCase();
  const text = value.trim();
  if (!cssValueAccepted(name, text)) return null;
  if (name.startsWith("--")) return text;
  const wide = text.toLowerCase();
  if (CSS_WIDE_KEYWORDS.has(wide)) return wide;
  try {
    const result = parsePropertyValue(name, text);
    if (!result.ok) return null;
    const canonical = canonicalizeParsed(name, result.value);
    return canonical === "" ? text : canonical;
  } catch {
    return null;
  }
}

function sideText(value: unknown): string {
  if (typeof value === "number") return `${value}px`;
  if (typeof value === "string") return value;
  if (isSpecifiedLength(value)) return `${value.value}${value.unit}`;
  if (isSpecifiedCalc(value)) return `calc(${serializeCalc(value.ast)})`;
  return "";
}

/** One specified value when every side canonicalizes to the same text. */
function uniformQuad(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const quad = value as { top?: unknown; right?: unknown; bottom?: unknown; left?: unknown; kind?: unknown };
  if (quad.kind !== undefined || quad.top === undefined) return null;
  const sides = [quad.top, quad.right, quad.bottom, quad.left].map(sideText);
  if (sides.some((side) => side === "") || !sides.every((side) => side === sides[0])) return null;
  return sides[0] ?? null;
}

function canonicalizeParsed(name: string, value: unknown): string {
  const uniform = uniformQuad(value);
  if (uniform !== null) return uniform;
  if (typeof value === "string") return value;
  if (typeof value === "number") {
    const property = CSS_PROPERTIES.find((row) => row.name === name);
    const kind = property?.syntax.kind;
    // Integers and numbers stay bare (`z-index: 123`, `opacity: 0.5`).
    // Lengths gain a px unit (`top: 10` → `10px`).
    if (kind === "integer" || kind === "number" || property?.tsType === "number") return String(value);
    return `${value}px`;
  }
  if (isSpecifiedLength(value)) return `${value.value}${value.unit}`;
  if (isSpecifiedCalc(value)) return `calc(${serializeCalc(value.ast)})`;
  return "";
}

function serializeCalc(node: CalcNode): string {
  switch (node.type) {
    case "px":
      return `${node.value}px`;
    case "len":
      return `${node.value}${node.unit}`;
    case "num":
      return String(node.value);
    case "add":
      return `${serializeCalc(node.left)} + ${serializeCalc(node.right)}`;
    case "sub":
      return `${serializeCalc(node.left)} - ${serializeCalc(node.right)}`;
    case "mul":
      return `${serializeCalc(node.left)} * ${serializeCalc(node.right)}`;
    case "div":
      return `${serializeCalc(node.left)} / ${serializeCalc(node.right)}`;
  }
}

function cssString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return "";
}

export function cssSupports(propertyOrCondition: unknown, value?: unknown): boolean {
  if (value !== undefined) return cssValueAccepted(cssString(propertyOrCondition), cssString(value));
  return supportsConditionMatches(cssString(propertyOrCondition));
}

export const CSS = {
  supports: cssSupports,
};
