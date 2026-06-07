/**
 * testharness.ts — the assertion core of a real `testharness.js`-compatible
 * harness (the API behind every WPT testharness test). Factored out so BOTH the
 * inline runner ({@link import("./wpt.js")}) and the HTML/suite importer
 * ({@link import("./wpt-suite.js")}) share ONE implementation of the `assert_*`
 * family — no duplicated assertion logic.
 *
 * Each `assert_*` throws {@link WptAssertionError} on failure (exactly the
 * shape WPT's harness uses); the surrounding `test()` wrapper records the
 * outcome. The functions are context-free, so any runner can install them.
 */

/** Thrown by the `assert_*` family — carries the failure message. */
export class WptAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssertionError";
  }
}

/** WPT's `format_value`: a compact, debuggable rendering of any value. */
export function formatValue(v: unknown): string {
  switch (typeof v) {
    case "string":
      return `"${v}"`;
    case "number":
    case "boolean":
    case "bigint":
      return v.toString();
    case "symbol":
      return v.toString();
    case "undefined":
      return "undefined";
    case "function":
      return "function";
  }
  if (v === null) return "null";
  if (Array.isArray(v)) return `[${v.map(formatValue).join(", ")}]`;
  const ctor = (v as { constructor?: { name?: string } }).constructor;
  return ctor?.name !== undefined && ctor.name !== "Object" ? `object "${ctor.name}"` : "object";
}

/** Build the full `assert_*` family (each throws {@link WptAssertionError} on failure). */
export function createAssertions(): Record<string, (...args: never[]) => unknown> {
  const fail = (message: string, desc: unknown): never => {
    const label = typeof desc === "string" && desc !== "" ? `${desc}: ` : "";
    throw new WptAssertionError(`${label}${message}`);
  };

  const asserts = {
    assert_true(actual: unknown, desc?: unknown): void {
      if (actual !== true) fail(`expected true got ${formatValue(actual)}`, desc);
    },
    assert_false(actual: unknown, desc?: unknown): void {
      if (actual !== false) fail(`expected false got ${formatValue(actual)}`, desc);
    },
    assert_equals(actual: unknown, expected: unknown, desc?: unknown): void {
      if (!sameValue(actual, expected)) {
        fail(`expected ${formatValue(expected)} but got ${formatValue(actual)}`, desc);
      }
    },
    assert_not_equals(actual: unknown, expected: unknown, desc?: unknown): void {
      if (sameValue(actual, expected)) fail(`got disallowed value ${formatValue(actual)}`, desc);
    },
    assert_array_equals(actual: unknown, expected: unknown, desc?: unknown): void {
      const a = actual as unknown[];
      const e = expected as unknown[];
      if (!Array.isArray(a) || !Array.isArray(e)) fail("not an array", desc);
      if (a.length !== e.length) fail(`lengths differ: ${a.length} vs ${e.length}`, desc);
      for (let i = 0; i < e.length; i += 1) {
        if (!sameValue(a[i], e[i])) fail(`element ${i}: ${formatValue(a[i])} != ${formatValue(e[i])}`, desc);
      }
    },
    assert_in_array(actual: unknown, expected: unknown, desc?: unknown): void {
      if (!Array.isArray(expected) || !expected.some((e) => sameValue(e, actual))) {
        fail(`${formatValue(actual)} not in array`, desc);
      }
    },
    assert_greater_than(a: unknown, b: unknown, desc?: unknown): void {
      if (!((a as number) > (b as number))) fail(`${formatValue(a)} not > ${formatValue(b)}`, desc);
    },
    assert_greater_than_equal(a: unknown, b: unknown, desc?: unknown): void {
      if (!((a as number) >= (b as number))) fail(`${formatValue(a)} not >= ${formatValue(b)}`, desc);
    },
    assert_less_than(a: unknown, b: unknown, desc?: unknown): void {
      if (!((a as number) < (b as number))) fail(`${formatValue(a)} not < ${formatValue(b)}`, desc);
    },
    assert_less_than_equal(a: unknown, b: unknown, desc?: unknown): void {
      if (!((a as number) <= (b as number))) fail(`${formatValue(a)} not <= ${formatValue(b)}`, desc);
    },
    assert_approx_equals(a: unknown, b: unknown, epsilon: unknown, desc?: unknown): void {
      if (Math.abs((a as number) - (b as number)) > (epsilon as number)) {
        fail(`${formatValue(a)} not within ${formatValue(epsilon)} of ${formatValue(b)}`, desc);
      }
    },
    assert_regexp_match(actual: unknown, re: unknown, desc?: unknown): void {
      if (!(re instanceof RegExp) || !re.test(String(actual))) fail(`${formatValue(actual)} did not match`, desc);
    },
    assert_class_string(obj: unknown, expected: unknown, desc?: unknown): void {
      const cls = Object.prototype.toString.call(obj).slice(8, -1);
      if (cls !== expected) fail(`class "${cls}" != "${String(expected)}"`, desc);
    },
    assert_own_property(obj: unknown, name: unknown, desc?: unknown): void {
      if (typeof obj !== "object" || obj === null || !Object.prototype.hasOwnProperty.call(obj, String(name))) {
        fail(`missing own property ${formatValue(name)}`, desc);
      }
    },
    assert_throws_js(_ctor: unknown, func: unknown, desc?: unknown): void {
      try {
        (func as () => void)();
      } catch {
        return;
      }
      fail("expected an exception", desc);
    },
    assert_throws_dom(_type: unknown, func: unknown, desc?: unknown): void {
      try {
        (func as () => void)();
      } catch {
        return;
      }
      fail("expected a DOMException", desc);
    },
    assert_unreached(desc?: unknown): void {
      fail("reached unreachable code", desc);
    },
    assert_not_own_property(obj: unknown, name: unknown, desc?: unknown): void {
      if (typeof obj === "object" && obj !== null && Object.prototype.hasOwnProperty.call(obj, String(name))) {
        fail(`unexpected own property ${formatValue(name)}`, desc);
      }
    },
  };
  return asserts;
}

/** WPT's `same_value` (treats `NaN` equal and `±0` distinct, like `assert_equals`). */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return a !== 0 || 1 / (a as number) === 1 / (b as number);
  return a !== a && b !== b; // both NaN.
}
