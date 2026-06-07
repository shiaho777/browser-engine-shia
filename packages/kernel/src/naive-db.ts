/**
 * Naive full-recompute kernel backend (design.md §7.1 "务实落地策略").
 *
 * This is the Phase 0-1 backend: **behaviourally correct but deliberately
 * slow**. It implements the *final* {@link Db} interface (Requirement 9.1) and
 * faithfully records, on every execution, every input and every query a query
 * reads (Requirement 2.1) — but it intentionally **never consults a memo**:
 * `query` recomputes from scratch each time. The recorded dependencies are
 * captured exactly as the real incremental backend will need them; the naive
 * backend simply discards them instead of using them to skip work.
 *
 * Because nothing is cached, "invalidation" is trivial: {@link NaiveDb.setInput}
 * just stores the new value and bumps a monotonically increasing revision. No
 * caller ever marks anything stale (Requirement 2.3) — there is no API to do so.
 *
 * Per design.md §7.1, this naive backend is the **permanent differential-test
 * baseline** (Requirement 9.2): the future incremental backend (task 5.9) must
 * produce byte-for-byte identical output for every input-edit sequence, and it
 * slots in behind this very interface with the upstream query definitions
 * unchanged (Requirement 9.3).
 */
import type {
  Db,
  Dependency,
  InputSlot,
  QueryDef,
  QueryDefInternal,
} from "./db.js";
import { COMPUTE } from "./db.js";

/** Reading an input that was never `setInput`-ed is a caller error, not a
 * silent default — fail loudly (cf. the constitution's "no silent stub" stance,
 * design.md §2 bug#4) rather than fabricate a value. */
export class InputNotSetError extends Error {
  constructor(inputName: string, key: unknown) {
    super(`input "${inputName}" has no value for key ${formatKey(key)}`);
    this.name = "InputNotSetError";
  }
}

function formatKey(key: unknown): string {
  if (typeof key === "string") return JSON.stringify(key);
  if (typeof key === "number" || typeof key === "boolean" || key == null) {
    return String(key);
  }
  return Object.prototype.toString.call(key);
}

/** A dependency-capture frame: the edges read during one query execution. */
interface Frame {
  readonly deps: Dependency[];
}

/** The result of {@link NaiveDb.trace}: a query's value plus the immediate
 * dependencies it recorded. A read-only diagnostic — NOT a stale-marking hook. */
export interface TraceResult<V> {
  readonly value: V;
  readonly dependencies: readonly Dependency[];
}

/**
 * The naive backend. Implements {@link Db} and nothing more on that surface;
 * the extra members here (`revision`, `recomputeCount`, `trace`) are read-only
 * diagnostics used by tests and the differential harness, never invalidation
 * controls.
 */
export class NaiveDb implements Db {
  /** input identity → (key → value). */
  readonly #inputs = new Map<InputSlot<unknown, unknown>, Map<unknown, unknown>>();
  /** Monotonic global revision; bumped on every value-changing setInput. */
  #revision = 0;
  /** Stack of active dependency-capture frames (one per in-flight query). */
  readonly #frames: Frame[] = [];
  /** How many times `compute` has run — proves "never cached" for tests. */
  #recomputeCount = 0;

  /** The current global revision (diagnostic; see design.md §7.1 algorithm). */
  get revision(): number {
    return this.#revision;
  }

  /** Total number of query recomputations performed so far (diagnostic). */
  get recomputeCount(): number {
    return this.#recomputeCount;
  }

  /** Read a leaf input, recording the current query's dependency (Req 2.1). */
  getInput<K, V>(input: InputSlot<K, V>, key: K): V {
    this.#record({ kind: "input", input, key });
    const slot = this.#inputs.get(input);
    if (slot === undefined || !slot.has(key)) {
      throw new InputNotSetError(input.name, key);
    }
    return slot.get(key) as V;
  }

  /**
   * Read a derived query. Records the dependency on `(q, key)` into the calling
   * query's frame (Req 2.1), then ALWAYS recomputes from scratch — the naive
   * backend never hits a memo (design.md §7.1 baseline).
   */
  query<K, V>(q: QueryDef<K, V>, key: K): V {
    this.#record({ kind: "query", query: q, key });
    return this.#compute(q, key);
  }

  /**
   * Write a leaf input. Invalidation is the kernel's job and is implicit: when
   * the value actually changes we bump the global revision (Req 2.3 — no manual
   * stale-marking surface exists). Writing an equal value is a no-op so nothing
   * downstream is disturbed (Req 2.6).
   */
  setInput<K, V>(input: InputSlot<K, V>, key: K, value: V): void {
    const handle = input as InputSlot<unknown, unknown>;
    let slot = this.#inputs.get(handle);
    if (slot !== undefined && slot.has(key) && Object.is(slot.get(key), value)) {
      return; // Requirement 2.6: equal value → leave dependents untouched.
    }
    if (slot === undefined) {
      slot = new Map<unknown, unknown>();
      this.#inputs.set(handle, slot);
    }
    slot.set(key, value);
    this.#revision += 1; // Requirement 2.3: invalidation via revision bump.
  }

  /**
   * Run a query once with a fresh capture frame and return its value together
   * with the dependencies it recorded. Read-only diagnostic used to verify
   * dependency tracking (Requirement 2.1) and by the differential harness; it
   * grants no way to mark anything stale.
   */
  trace<K, V>(q: QueryDef<K, V>, key: K): TraceResult<V> {
    const frame: Frame = { deps: [] };
    this.#frames.push(frame);
    try {
      const value = this.#runCompute(q, key);
      return { value, dependencies: frame.deps };
    } finally {
      this.#frames.pop();
    }
  }

  /** Push a capture frame, run the query's compute, discard the frame (naive). */
  #compute<K, V>(q: QueryDef<K, V>, key: K): V {
    const frame: Frame = { deps: [] };
    this.#frames.push(frame);
    try {
      return this.#runCompute(q, key);
    } finally {
      // Naive backend: dependencies were recorded but are not memoised.
      this.#frames.pop();
    }
  }

  /** Execute the hidden compute function behind a QueryDef, counting the run. */
  #runCompute<K, V>(q: QueryDef<K, V>, key: K): V {
    const compute = (q as QueryDefInternal<K, V>)[COMPUTE];
    this.#recomputeCount += 1;
    return compute(this, key);
  }

  /** Append an edge to the innermost active frame, if any (top-level reads
   * have no enclosing query and so record nothing). */
  #record(dep: Dependency): void {
    const frame = this.#frames[this.#frames.length - 1];
    if (frame !== undefined) {
      frame.deps.push(dep);
    }
  }
}
