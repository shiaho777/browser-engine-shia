// NEGATIVE CONTROL — the COMPLIANT version of the silent-stub fixture.
//
// Every unimplemented path fails LOUDLY by throwing the sanctioned
// NotImplemented (or calling the notImplemented helper), identifying the
// missing capability (Requirements 5.1, 5.3). `local/no-silent-stub` MUST
// report ZERO errors here — proving the guard bites only the placeholder
// returns, not legitimate loud failures.

import { NotImplemented, notImplemented } from "@browser-engine/ir";

// @stub
export function fetchImpl(_url: string): never {
  throw new NotImplemented("dom-api:fetch", { category: "dom-api" });
}

// @unimplemented
export function computedWidthOf(): number {
  return notImplemented("css-property:width", { category: "css-property" });
}

// @not-implemented
export const gridLayout = (): never => notImplemented("layout-mode:grid", { category: "layout-mode" });
