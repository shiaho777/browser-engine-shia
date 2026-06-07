// DELIBERATE CONSTITUTION VIOLATION — do NOT "fix" this file.
//
// Class 1: cross-stage import of another stage's internal mutable type
// (design.md §2 bug#2, §3.C; Requirements 3.2, 12.1, 12.7).
//
// This file lives (logically) in the `paint` stage. Paint is downstream of
// layout and must consume layout's output ONLY through the frozen IR
// (`@browser-engine/ir`). Reaching directly into `@browser-engine/layout` hands
// paint that stage's internal, mutable types — exactly the cross-stage reverse
// read that rotted v0. `local/no-cross-stage-import` MUST flag every line below.
//
// It is parked under tools/ (excluded from the real build + lint via
// eslint.config.js `ignores: ["tools/**"]`) so it can never turn the MAIN CI
// red by accident; the constitution-guards test lints it on purpose and asserts
// the guard bites.

// Bare scoped import of another stage.
import { internalBox } from "@browser-engine/layout";

// Reaching into another stage's *internal* submodule (the mutable-type leak).
import type { MutableFragment } from "@browser-engine/layout/src/internal";

// `export … from` another stage is cross-stage coupling too.
export { Fragment } from "@browser-engine/layout";

// Relative path that escapes paint and dives into layout's source tree.
import { cursor } from "../../layout/src/internal.js";

export const leak = { internalBox, cursor } as unknown as MutableFragment;
