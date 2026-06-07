/**
 * The query-based incremental-kernel interface — **final form** (design.md §7.1).
 *
 * Core idea (design.md §7.1, Requirement 2): there is **no "mark stale" API**.
 * Every computation is written as a `Query` (a pure function that reads its
 * inputs/other queries only through the `Db`). The kernel records, on each
 * execution, exactly which inputs and which other queries a query read
 * (Requirement 2.1). When an input changes, the kernel — *not the caller* —
 * decides what to invalidate (Requirement 2.3). This makes the v0 "dirty bit
 * set but never consumed" bug class structurally impossible.
 *
 * This module defines the interface that callers (and the §7.2 render-pipeline
 * queries) program against. The interface is the *final* shape: Phase 0 backs
 * it with a deliberately naive "never cache, always recompute" implementation
 * (see `./naive-db.ts`); Phase 2+ swaps in a true incremental backend
 * (revision compare + dependency-graph early-stop) **without changing a single
 * line of the upstream query definitions** (Requirements 9.1, 9.3).
 */

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * A query: `(db, key) => value`. MUST be a pure function whose only reads of
 * external state go through `db.getInput` / `db.query`, so the kernel can fully
 * observe its dependencies (design.md §7.1 precondition; Requirement 2.1).
 */
export type Query<K, V> = (db: Db, key: K) => V;

// ---------------------------------------------------------------------------
// Inputs and query definitions (opaque, nominally-typed handles)
// ---------------------------------------------------------------------------

/**
 * Identity of a leaf **input** (the only thing a caller may write). Create one
 * with {@link defineInput}. The phantom `[K, V]` carries the key/value types so
 * `db.getInput` / `db.setInput` are type-checked; it never exists at runtime.
 *
 * The phantom appears in a *covariant* (read) position only, so an
 * `InputSlot<K, V>` is assignable to `InputSlot<unknown, unknown>` (used for
 * type-erased dependency records) without exposing any mutation surface.
 */
export interface InputSlot<K, V> {
  readonly name: string;
  /** Phantom carrier for `K`/`V`; present only in the type system. */
  readonly __phantom?: readonly [K, V];
}

/**
 * Identity of a **derived query**. Create one with {@link define}. Like
 * {@link InputSlot}, this is an opaque handle: the query's `compute` function is
 * stored behind a module-private symbol so neither callers nor guest code can
 * reach it, and so the public type stays variance-clean.
 */
export interface QueryDef<K, V> {
  readonly name: string;
  /** Phantom carrier for `K`/`V`; present only in the type system. */
  readonly __phantom?: readonly [K, V];
}

/**
 * Module-private carrier for a {@link QueryDef}'s compute function.
 *
 * @internal Exported only so the backend in `./naive-db.ts` (and the future
 * incremental backend) can read it. It is intentionally NOT re-exported from
 * the package entry point, so it is unreachable by package consumers.
 */
export const COMPUTE: unique symbol = Symbol("@browser-engine/kernel:compute");

/** A {@link QueryDef} together with its hidden compute function. @internal */
export interface QueryDefInternal<K, V> extends QueryDef<K, V> {
  readonly [COMPUTE]: Query<K, V>;
}

// ---------------------------------------------------------------------------
// Dependency records (what a single query execution read)
// ---------------------------------------------------------------------------

/**
 * One edge recorded during a query execution (Requirement 2.1): either a leaf
 * input read or another query read, each at a specific key. The naive backend
 * records these faithfully even though it does not (yet) use them to skip work;
 * the recording is what lets the future incremental backend slot in unchanged.
 */
export type Dependency =
  | { readonly kind: "input"; readonly input: InputSlot<unknown, unknown>; readonly key: unknown }
  | { readonly kind: "query"; readonly query: QueryDef<unknown, unknown>; readonly key: unknown };

// ---------------------------------------------------------------------------
// The database surface — the ONE interface every backend implements
// ---------------------------------------------------------------------------

/**
 * The kernel database. This is the entire surface a query (or a caller) uses.
 *
 * Note what is **absent**: there is no `invalidate`, `markStale`, `setDirty`,
 * or `bump`. Cache invalidation is performed entirely by the kernel as a
 * consequence of {@link Db.setInput} (Requirement 2.3). Both the naive and the
 * incremental backends implement exactly this interface (Requirement 9.1).
 */
export interface Db {
  /** Read a leaf input, recording the current query's dependency on it. */
  getInput<K, V>(input: InputSlot<K, V>, key: K): V;
  /** Read a derived query, recording the dependency and returning its value. */
  query<K, V>(q: QueryDef<K, V>, key: K): V;
  /** Write a leaf input; the kernel invalidates the affected queries itself. */
  setInput<K, V>(input: InputSlot<K, V>, key: K, value: V): void;
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/**
 * Define a leaf input slot. `name` is for diagnostics only; identity is the
 * returned object reference.
 */
export function defineInput<K, V>(name: string): InputSlot<K, V> {
  return { name };
}

/**
 * Define a derived query from its (pure) compute function — see the §7.2
 * pipeline queries, e.g. `const qDom = define((db, url) => parseHtml(...))`.
 * Identity is the returned object reference; `name` defaults to the function's
 * name (falling back to `"anonymous"` for inline arrows).
 */
export function define<K, V>(compute: Query<K, V>, name?: string): QueryDef<K, V> {
  const def: QueryDefInternal<K, V> = {
    name: name ?? (compute.name || "anonymous"),
    [COMPUTE]: compute,
  };
  return def;
}
