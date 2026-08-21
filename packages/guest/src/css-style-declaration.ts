/**
 * CSSStyleDeclaration — the return type of `window.getComputedStyle(element)`.
 *
 * Reads computed style values from the engine's cascade output. The computed
 * style is a `ComputedStyle` record stored in the kernel. This wrapper exposes
 * it via the standard CSSStyleDeclaration interface: getPropertyValue(),
 * setProperty(), removeProperty(), cssText, length, item().
 *
 * Note: setProperty/removeProperty are no-ops on computed styles (computed
 * styles are read-only per spec). They are included for interface completeness.
 */
import type { ComputedStyle } from "@browser-engine/ir";

export class CSSStyleDeclarationImpl {
  readonly #style: ComputedStyle;

  constructor(style: ComputedStyle) {
    this.#style = style;
  }

  get cssText(): string {
    let result = "";
    for (const [key, value] of Object.entries(this.#style)) {
      if (value !== undefined && value !== null) {
        result += `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}; `;
      }
    }
    return result.trimEnd();
  }
  set cssText(_value: string) {
    // Computed style is read-only; ignore writes.
  }

  get length(): number {
    return Object.keys(this.#style).filter((k) => {
      const v = (this.#style as Record<string, unknown>)[k];
      return v !== undefined && v !== null;
    }).length;
  }

  getPropertyValue(property: string): string {
    const camelKey = cssToCamel(property);
    const value = (this.#style as Record<string, unknown>)[camelKey];
    if (value === undefined || value === null) return "";
    if (typeof value === "object" && value !== null) {
      // Color objects {r,g,b,a} → "rgb(r, g, b)" or "rgba(r, g, b, a)"
      const c = value as { r: number; g: number; b: number; a?: number };
      if (typeof c.r === "number" && typeof c.g === "number" && typeof c.b === "number") {
        if (c.a !== undefined && c.a < 1) {
          return `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})`;
        }
        return `rgb(${c.r}, ${c.g}, ${c.b})`;
      }
      return typeof value === "string" ? value : JSON.stringify(value);
    }
    return typeof value === "string" ? value : JSON.stringify(value);
  }

  setProperty(_property: string, _value: string): void {
    // Computed style is read-only; ignore writes.
  }

  removeProperty(_property: string): string {
    return ""; // Computed style is read-only.
  }

  item(index: number): string {
    const keys = Object.keys(this.#style).filter((k) => {
      const v = (this.#style as Record<string, unknown>)[k];
      return v !== undefined && v !== null;
    });
    if (index < 0 || index >= keys.length) return "";
    return camelToCss(keys[index]!);
  }
}

/** Convert CSS property name (kebab-case) to camelCase. */
function cssToCamel(s: string): string {
  return s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Convert camelCase to CSS property name (kebab-case). */
function camelToCss(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}
