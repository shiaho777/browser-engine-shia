/**
 * The `CSS` namespace (CSS Conditional 3 §the CSS interface) exposed to guest
 * realms. `CSS.supports` is backed by the SAME evaluator the `@supports`
 * at-rule uses — the generated per-property value grammars decide the
 * declaration form and the cascade's selector parser decides `selector()`.
 * `CSS.escape` is CSSOM's serialize-an-identifier. Unit factories
 * (`CSS.px`…) and `CSS.registerProperty` come from the Typed OM module.
 */
import { cssSupports, cssSupportsDeclaration, cssEscape } from "@browser-engine/css-parser";
import { selectorParses } from "@browser-engine/cascade";
import {
  makeCssUnitFactories,
  makePropertyRegistry,
  type PropertyRegistry,
} from "./typed-om.js";

export interface CssNamespace {
  supports(conditionText: string): boolean;
  supports(property: string, value: string): boolean;
  escape(value: string): string;
  registerProperty(descriptor: unknown): void;
  [key: string]: unknown;
}

export function makeCssNamespace(registry: PropertyRegistry = makePropertyRegistry()): CssNamespace {
  const ns: CssNamespace = {
    ...makeCssUnitFactories(),
    supports(conditionOrProperty: string, value?: string): boolean {
      if (value === undefined) {
        return cssSupports(conditionOrProperty, selectorParses);
      }
      return cssSupportsDeclaration(conditionOrProperty, value);
    },
    escape(value: string): string {
      return cssEscape(value);
    },
    registerProperty(descriptor: unknown): void {
      registry.register(descriptor);
    },
  };
  return ns;
}

export { makePropertyRegistry, type PropertyRegistry };
