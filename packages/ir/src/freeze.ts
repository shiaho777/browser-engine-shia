/**
 * Runtime immutability for IR values (design.md §6, Requirement 3.1/3.2).
 *
 * The `readonly` types make mutation a *compile-time* error. `deepFreeze`
 * closes the runtime hole: even code that has type-erased an IR value (e.g.
 * across a JS boundary, or via `any`) cannot mutate it in place. Freezing from
 * both the type layer and the value layer is what makes "upstream IR is left
 * unchanged" (Requirement 3.2) physically true, not merely a convention.
 *
 * `Map` instances are frozen as objects; their structural immutability is
 * additionally guaranteed by exposing them only as `ReadonlyMap` in the IR
 * types, so downstream code has no typed `set`/`delete`/`clear` to call.
 */

type Freezable = object;

/**
 * Recursively freeze `value` and everything reachable from it (own enumerable
 * properties, array elements, and Map/Set entries). Returns the same reference,
 * now frozen. Already-frozen objects are skipped to keep this safe on shared,
 * cyclic graphs.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return value;
  }

  // Typed arrays / DataViews (e.g. a DecodedImage's RGBA `pixels`) cannot be
  // frozen while they hold elements — `Object.freeze` throws on an array-buffer
  // view with elements. Their immutability is carried by the `readonly` IR
  // types instead; leave the binary buffer alone rather than crash the freeze.
  if (ArrayBuffer.isView(value)) {
    return value;
  }

  const obj = value as Freezable;
  if (Object.isFrozen(obj)) {
    return value;
  }

  // Freeze first to break cycles: re-entrant visits hit the isFrozen guard.
  Object.freeze(obj);

  if (obj instanceof Map) {
    for (const [k, v] of obj) {
      deepFreeze(k);
      deepFreeze(v);
    }
    return value;
  }

  if (obj instanceof Set) {
    for (const v of obj) {
      deepFreeze(v);
    }
    return value;
  }

  for (const key of Reflect.ownKeys(obj)) {
    deepFreeze((obj as Record<PropertyKey, unknown>)[key]);
  }

  return value;
}
