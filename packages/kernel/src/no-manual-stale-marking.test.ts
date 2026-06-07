/**
 * Constitution Class 3 — "no manual stale-marking" guard (task 1.11).
 *
 * Built by `tsc` then run with: `node --test packages/kernel/dist/*.test.js`.
 *
 * design.md §2 bug#1 / §7.1 and Requirements 2.3, 12.3: v0 rotted because cache
 * invalidation was a *manual* affair — a dirty bit set in one place and never
 * consumed in another. The architecture's answer is to make manual stale-marking
 * **structurally impossible**: the kernel's only surface is read/write
 * (`getInput`, `query`, `setInput`); invalidation is the kernel's own job, a
 * consequence of `setInput` (Requirement 2.3). There is deliberately NO
 * `invalidate` / `markStale` / `setDirty` / `bump` / `markDirty` operation.
 *
 * This suite proves that absence two ways:
 *   - **Type level** — `keyof Db` is *exactly* the three sanctioned methods, so
 *     a PR that adds a manual-invalidation method to the `Db` interface would
 *     fail to compile here (tsc --strict is part of CI: a deliberate violation
 *     turns the build RED — Requirement 12.3).
 *   - **Runtime** — a live `NaiveDb` exposes none of the forbidden members on
 *     itself or anywhere up its prototype chain, and no member name even hints
 *     at manual invalidation.
 *
 * The constitution-guards harness (tools/constitution-fixtures) re-asserts the
 * runtime half so the "all four violation classes are rejected" checklist is
 * complete in one place.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { NaiveDb, type Db } from "./index.js";

// ---------------------------------------------------------------------------
// Type-level proof (checked at compile time by `tsc --strict`)
// ---------------------------------------------------------------------------

/** Compile-time assertion helper: `Expect<false>` violates `T extends true`. */
type Expect<T extends true> = T;

/** Exact type equality (distributes nothing; tolerant of optional/readonly). */
type Equals<A, B> = (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B
  ? 1
  : 2
  ? true
  : false;

/** The names a manual dirty-bit / stale-marking surface would introduce. */
type ForbiddenStaleApi =
  | "invalidate"
  | "markStale"
  | "setDirty"
  | "bump"
  | "markDirty";

/**
 * 1. The `Db` surface is EXACTLY the three read/write methods — there is no
 *    manual stale-marking operation on it (Requirement 2.3). If a future PR
 *    widens `Db` with, say, `invalidate`, this equality breaks and the build
 *    fails (Requirement 12.3).
 */
type _DbSurfaceIsExactlyReadWrite = Expect<
  Equals<keyof Db, "getInput" | "query" | "setInput">
>;

/**
 * 2. None of the forbidden manual-invalidation names exist on `Db`. (Redundant
 *    with #1 today, but it pins the specific prohibition so the intent survives
 *    even if the surface legitimately grows another read-only accessor.)
 */
type _NoForbiddenStaleApiOnDb = Expect<
  Equals<Extract<keyof Db, ForbiddenStaleApi>, never>
>;

// Reference the type-level assertions so their intent is documented as values
// too (and so `verbatimModuleSyntax`/lint never flags them as dead): a `true`
// literal typed by each alias only compiles while the assertion holds.
const _dbSurfaceProof: _DbSurfaceIsExactlyReadWrite = true;
const _noForbiddenProof: _NoForbiddenStaleApiOnDb = true;
void _dbSurfaceProof;
void _noForbiddenProof;

// ---------------------------------------------------------------------------
// Runtime proof
// ---------------------------------------------------------------------------

/** The manual-invalidation members that MUST NOT exist (Requirement 2.3). */
const FORBIDDEN_STALE_API = [
  "invalidate",
  "markStale",
  "setDirty",
  "bump",
  "markDirty",
] as const;

/** The sanctioned read/write surface that MUST exist (positive control). */
const SANCTIONED_SURFACE = ["getInput", "query", "setInput"] as const;

void test("Req 2.3/12.3: NaiveDb exposes no manual stale-marking API at runtime", () => {
  const db = new NaiveDb();
  const surface = db as unknown as Record<string, unknown>;
  for (const name of FORBIDDEN_STALE_API) {
    assert.equal(
      name in db,
      false,
      `manual stale-marking member must not exist anywhere on the Db: ${name}`,
    );
    assert.equal(
      typeof surface[name],
      "undefined",
      `manual stale-marking member must be undefined: ${name}`,
    );
  }
});

void test("the sanctioned read/write surface IS present (positive control)", () => {
  const db = new NaiveDb();
  const surface = db as unknown as Record<string, unknown>;
  for (const name of SANCTIONED_SURFACE) {
    assert.equal(typeof surface[name], "function", `expected Db.${name} to exist`);
  }
});

void test("no member name up the prototype chain hints at manual invalidation", () => {
  // Scan EVERY own-property name on the instance and up its whole prototype
  // chain, so an inherited or accidentally-added stale-marking member could not
  // slip past the explicit forbidden-name list.
  const hint = /invalidate|mark.?stale|set.?dirty|mark.?dirty|\bbump\b|dirty|stale/i;
  const names = new Set<string>();
  let cursor: object | null = new NaiveDb();
  while (cursor !== null && cursor !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(cursor)) names.add(name);
    cursor = Object.getPrototypeOf(cursor) as object | null;
  }
  const offenders = [...names].filter((n) => hint.test(n));
  assert.deepEqual(
    offenders,
    [],
    `unexpected manual-invalidation surface on NaiveDb: ${offenders.join(", ")}`,
  );
});
