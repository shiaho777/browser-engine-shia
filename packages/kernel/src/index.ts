/**
 * @browser-engine/kernel
 *
 * Incremental computation kernel (first-class citizen). Query-based, with
 * automatic dependency tracking and NO manual stale-marking API. See design.md
 * §7. The query interface is introduced in its final form in task 1.5, backed
 * first by a naive full-recompute memo and later by a true incremental backend
 * with the upstream queries unchanged.
 *
 * Public surface:
 *   - Types `Query`, `Db`, `QueryDef`, `InputSlot`, `Dependency` — the final
 *     query interface both backends implement (Requirements 2.x, 9.1, 9.3).
 *   - Constructors `define` (derived query) and `defineInput` (leaf input).
 *   - `NaiveDb` — the Phase 0 full-recompute backend / differential baseline.
 *   - `IncrementalDb` — the Phase 2+ true incremental backend (revision compare
 *     + dependency-graph early-stop), same `Db` interface, queries unchanged.
 *
 * Deliberately NOT exported: the module-private `COMPUTE` symbol and
 * `QueryDefInternal`, so a `QueryDef`'s compute function is unreachable by
 * package consumers and guest code; and any "mark stale"/"invalidate" surface,
 * which does not exist (Requirement 2.3).
 */
export const PACKAGE_NAME = "@browser-engine/kernel" as const;

// ---- the final query interface (one shape for both backends) --------------
export type {
  Query,
  Db,
  QueryDef,
  InputSlot,
  Dependency,
} from "./db.js";
export { define, defineInput } from "./db.js";

// ---- Phase 0 naive full-recompute backend (differential baseline) ---------
export type { TraceResult } from "./naive-db.js";
export { NaiveDb, InputNotSetError } from "./naive-db.js";

// ---- Phase 2+ true incremental backend (revision compare + early-stop) -----
// Slots in behind the SAME `Db` interface with the upstream query definitions
// unchanged (Requirements 2.2, 2.4, 2.5, 2.6, 9.3, 15.6). Exported additively;
// the CLI switch-over happens in task 5.11.
export { IncrementalDb } from "./incremental-db.js";
