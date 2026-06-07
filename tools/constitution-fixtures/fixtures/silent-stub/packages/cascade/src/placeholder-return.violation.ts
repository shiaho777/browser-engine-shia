// DELIBERATE CONSTITUTION VIOLATION — do NOT "fix" this file.
//
// Class 2: an unimplemented path returns a PLACEHOLDER value instead of
// throwing NotImplemented (design.md §2 bug#4, §12; Requirements 5.1, 5.2,
// 12.2). This is the exact "wired but not connected" stub that let v0's
// fake fetch/location/focus masquerade as working features.
//
// `local/no-silent-stub` MUST flag each marked stub below. Parked under tools/
// (excluded from the real build + lint) so it never reddens the MAIN CI by
// accident; the constitution-guards test lints it on purpose.

// A marked stub that returns a fake object instead of failing loudly.
// @stub
export function fetchImpl(_url: string) {
  return { status: 404, body: "" };
}

// A marked stub that returns a fake primitive.
// @unimplemented
export function computedWidthOf(): number {
  return 0;
}

// An arrow stub whose expression body is a placeholder.
// @not-implemented
export const fakeLocation = () => ({ href: "about:blank" });

// A marked stub that silently does nothing (v0's empty focus/blur).
// @stub
export function focus() {}

// A generic Error announcing "not implemented" instead of the sanctioned
// NotImplemented — the scoreboard can't identify the missing capability.
export function paintUnsupported() {
  throw new Error("not implemented yet");
}
