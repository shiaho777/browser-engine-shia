// NEGATIVE CONTROL — the COMPLIANT version of the cross-stage fixture.
//
// The paint stage consuming its upstream's output through the ONE sanctioned
// channel — the frozen, branded IR (`@browser-engine/ir`) — plus the kernel
// (the query substrate, not a pipeline stage). `local/no-cross-stage-import`
// MUST report ZERO errors here. This proves the guard bites only the real
// violation, not legitimate IR consumption (mirrors the rule's RuleTester
// `valid` cases).

import type { FragmentTree, DisplayList } from "@browser-engine/ir";
import { define } from "@browser-engine/kernel";

export const qPaintLike = define<FragmentTree, DisplayList>(
  (_db, _tree) => {
    throw new Error("fixture: not a real query");
  },
);
