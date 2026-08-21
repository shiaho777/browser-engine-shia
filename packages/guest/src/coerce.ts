/**
 * Spec-like ToString for values crossing the guest boundary.
 *
 * Guest JavaScript hands the host `unknown` values (event types, HTML
 * strings, cookie payloads, fetch options). The web platform's `String()`
 * coercion is the contract, but a blind `String(unknown)` is both a lint
 * violation and a real hazard: objects without a meaningful `toString`
 * stringify as `[object Object]`. This helper mirrors `String(value)`
 * for every primitive and falls back to a guest object's own callable
 * `toString` when present.
 */
export function coerceGuestString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  const toString = (value as { toString?: unknown }).toString;
  if (typeof toString !== "function") {
    return "";
  }
  const out = (toString as (...args: unknown[]) => unknown).call(value);
  return typeof out === "string" ? out : "";
}
