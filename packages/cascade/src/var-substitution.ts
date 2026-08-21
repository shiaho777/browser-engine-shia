/**
 * CSS custom properties and `var()` substitution (CSS Variables Level 1;
 * ROADMAP Phase 2).
 *
 * Custom properties (`--foo: red`) are author-defined properties that inherit.
 * They are NOT in the generated `CSS_PROPERTIES` data table — they are dynamic,
 * user-authored names. The cascade collects them per-element (inheriting from
 * the parent), and `var(--foo, fallback)` references are substituted with the
 * resolved custom property value (or the fallback) BEFORE the standard
 * per-property parser runs.
 *
 * ## Substitution order (CSS Custom Properties §2)
 *
 * `var()` substitution happens at *computed-value time* — after the cascade
 * selects winners, but before the value is parsed by the property's grammar.
 * This means `var()` can appear inside any property value, including inside
 * `calc()` and shorthands. The substitution is a simple text replacement: the
 * `var(--foo)` token is replaced by the custom property's declared value string.
 *
 * ## Cycle detection
 *
 * If `--a: var(--b)` and `--b: var(--a)`, the substitution would loop forever.
 * The spec says the property becomes invalid (the initial value is used). We
 * detect cycles by tracking the set of custom property names currently being
 * resolved; a reference to one already in the set is a cycle → substitution
 * fails → the property uses its initial value.
 */

/** A map of resolved custom property names to their raw value strings. */
export type CustomPropertyMap = ReadonlyMap<string, string>;

/** Determine if a property name is a custom property (starts with `--`). */
export function isCustomProperty(name: string): boolean {
  return name.startsWith("--");
}

/**
 * Collect custom property declarations from the cascade winners map. Only
 * entries whose property name starts with `--` are included. The parent's
 * custom properties are inherited (the caller passes the parent's map, which
 * is merged with the node's own declarations — the node's override the
 * parent's).
 */
export function collectCustomProperties(
  winners: ReadonlyMap<string, { readonly value: string }>,
  parentCustom: CustomPropertyMap,
): CustomPropertyMap {
  const map = new Map<string, string>(parentCustom);
  for (const [name, candidate] of winners) {
    if (isCustomProperty(name)) {
      map.set(name, candidate.value);
    }
  }
  return map;
}

/**
 * Substitute all `var(--name, fallback)` references in a value string with
 * the resolved custom property value. If a custom property is not found or
 * a cycle is detected, the fallback is used; if there is no fallback, the
 * function returns `null` (meaning the value is invalid → initial).
 *
 * Custom property values themselves may contain `var()` references — these are
 * resolved recursively, with cycle detection.
 *
 * @param value the raw value string that may contain `var()` references.
 * @param custom the map of resolved custom properties for this element.
 * @param resolving the set of custom property names currently being resolved
 *   (for cycle detection). Callers should omit this; it is used internally.
 * @returns the value with all `var()` references substituted, or `null` if
 *   an unresolvable `var()` with no fallback is encountered.
 */
export function substituteVars(
  value: string,
  custom: CustomPropertyMap,
  resolving: ReadonlySet<string> = new Set(),
): string | null {
  // Find all var(...) references in the value, left to right.
  let result = "";
  let i = 0;
  while (i < value.length) {
    const lower = value.slice(i).toLowerCase();
    if (lower.startsWith("var(")) {
      // Find the matching closing paren.
      const varStart = i;
      let depth = 1;
      let j = i + 4; // skip "var("
      while (j < value.length && depth > 0) {
        if (value[j] === "(") depth += 1;
        else if (value[j] === ")") depth -= 1;
        if (depth === 0) break;
        j += 1;
      }
      if (depth !== 0) return null; // unbalanced parens
      const inner = value.slice(i + 4, j).trim();
      i = j + 1; // move past the closing ")"

      // Parse the custom property name and optional fallback.
      const commaIdx = findTopLevelComma(inner);
      let propName: string;
      let fallback: string | null = null;
      if (commaIdx === -1) {
        propName = inner.trim();
      } else {
        propName = inner.slice(0, commaIdx).trim();
        fallback = inner.slice(commaIdx + 1).trim();
      }

      // Resolve the custom property value.
      const resolved = resolveCustomProperty(propName, custom, resolving);
      if (resolved === null) {
        // Property not found or cycle — use fallback.
        if (fallback !== null) {
          // The fallback may itself contain var() references.
          const fallbackResolved = substituteVars(fallback, custom, resolving);
          if (fallbackResolved === null) return null;
          result += fallbackResolved;
        } else {
          return null; // no fallback → invalid
        }
      } else {
        result += resolved;
      }
      // Note: we don't use varStart here, but it's kept for debugging clarity.
      void varStart;
    } else {
      result += value[i];
      i += 1;
    }
  }
  return result;
}

/**
 * Resolve a custom property name to its value string, handling nested `var()`
 * references and cycle detection.
 */
function resolveCustomProperty(
  name: string,
  custom: CustomPropertyMap,
  resolving: ReadonlySet<string>,
): string | null {
  if (resolving.has(name)) {
    return null; // cycle detected
  }
  const raw = custom.get(name);
  if (raw === undefined) {
    return null; // not defined
  }
  // The custom property's value may contain var() references — resolve them.
  const newResolving = new Set(resolving);
  newResolving.add(name);
  return substituteVars(raw, custom, newResolving);
}

/**
 * Find the index of the first top-level comma in `s`, or -1 if there is none.
 * "Top-level" means not nested inside parentheses.
 */
function findTopLevelComma(s: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) return i;
  }
  return -1;
}
