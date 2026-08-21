/**
 * True incremental kernel backend (design.md §7.1 "Phase 2+ 真增量") — task 5.9.
 *
 * This is the real backend that replaces the Phase 0 {@link NaiveDb}
 * full-recompute memo **without changing a single upstream query definition**
 * (Requirements 9.3, 15.6): it implements the exact same {@link Db} surface
 * (`getInput` / `query` / `setInput`) and nothing more on that surface. The CLI
 * is NOT switched over here (that is task 5.11); this backend is exported
 * additively so the differential harness can pin it byte-for-byte against the
 * naive baseline.
 *
 * It implements the design.md §7.1 algorithm faithfully:
 *
 *   - A global monotonic `revision` counter. A value-changing `setInput` bumps
 *     it; an equal-value `setInput` is a no-op and does NOT bump it (Req 2.6).
 *   - A memo keyed by `(QueryDef, key)` → `{ value, deps, verifiedAtRevision }`.
 *   - `query` records the dependency edge into the caller's capture frame, then
 *     returns the memoised value if `verifyClean` holds (NO recompute — Req
 *     2.4), else recomputes inside a fresh frame and stores the new entry.
 *   - `verifyClean` is self-adjusting with an **early stop**: a dependency whose
 *     value re-computes to an equal result does NOT propagate as a change, so
 *     its dependents stay cached.
 *
 * ── Memo keying strategy ───────────────────────────────────────────────────
 * The memo is `Map<QueryDef, Map<stableKey, entry>>`. Pipeline keys are URL
 * strings or small structural objects like `{ url, node }`, which JavaScript
 * `Map`s would compare by *reference*, not structure. We therefore derive a
 * **stable structural string key** from the key value (see {@link stableKey}):
 * primitives serialise as their JSON form (so the string `"5"` and the number
 * `5` never collide, and the type namespaces the value), and objects/arrays
 * serialise recursively with **sorted** object keys so that `{ url, node }` and
 * `{ node, url }` map to the same memo slot. Two structurally-equal keys thus
 * address one entry, regardless of property order or object identity.
 *
 * ── Value-change detection (the heart of early-stop) ───────────────────────
 * Each recorded dependency stores the exact value it OBSERVED at capture time,
 * so "did this dependency change?" is well-defined per edge:
 *   - **Input deps** compare the input's current value to the observed value
 *     with `Object.is` — the same identity rule `setInput` uses to decide
 *     whether to bump the revision, so the two are always consistent. (An input
 *     that is set to a new-but-equal value would bump and be seen as changed;
 *     an input set back to its original value reads as unchanged and the
 *     dependent stays cached — both match a from-scratch recompute.)
 *   - **Query deps** recursively ensure/verify the sub-query and compare its
 *     (possibly re-computed) value to the observed value with **deep structural
 *     equality** (see {@link deepEqual}). Query recomputation yields fresh
 *     object references each run, so `Object.is` would spuriously report
 *     "changed" and defeat early-stop; deep equality over the frozen plain-data
 *     IR is the correct, well-defined comparison. An equal re-computed value is
 *     therefore NOT a change and does not force dependents to recompute.
 *
 * ── Requirement 2.5 interpretation ─────────────────────────────────────────
 * "WHERE a cached value has been invalidated for a reason other than a
 * dependency change, THE Incremental_Kernel SHALL still return that cached
 * value when it remains available." This backend **never evicts a memo entry**:
 * entries persist for the lifetime of the db. The ONLY thing that bypasses the
 * cache is a *genuine* dependency change detected by `verifyClean`. A revision
 * bump (or any other global "invalidation" signal) does not, on its own, drop
 * an entry — it merely forces `verifyClean` to re-check the entry's deps, and
 * if none actually changed, the cached value is returned unchanged. So an entry
 * "invalidated for a non-dependency reason" still serves its cached value.
 */
import type { Db, InputSlot, QueryDef, QueryDefInternal } from "./db.js";
import { COMPUTE } from "./db.js";
import { InputNotSetError } from "./naive-db.js";

/**
 * One dependency edge recorded during a query execution, augmented (vs the
 * public {@link import("./db.js").Dependency}) with the VALUE observed at
 * capture time. Storing the observed value is what makes "this dep changed"
 * well-defined per edge and enables the self-adjusting early stop.
 */
type RecordedDep =
  | {
      readonly kind: "input";
      readonly input: InputSlot<unknown, unknown>;
      readonly key: unknown;
      readonly observed: unknown;
    }
  | {
      readonly kind: "query";
      readonly query: QueryDef<unknown, unknown>;
      readonly key: unknown;
      readonly observed: unknown;
    };

/** A dependency-capture frame: the edges read during one query execution. */
interface Frame {
  readonly deps: RecordedDep[];
}

/**
 * A memo entry: the cached value, the dependencies the computation read (with
 * their observed values), and the revision at which the entry was last verified
 * clean. `verifiedAtRevision` is the only mutable field — bumping it on a clean
 * verify is the fast-path memo for repeated reads within one revision.
 */
interface MemoEntry {
  readonly value: unknown;
  readonly deps: readonly RecordedDep[];
  verifiedAtRevision: number;
}

/**
 * The true incremental backend. Implements {@link Db} and nothing more on that
 * surface; the extra `revision` / `recomputeCount` getters are read-only
 * diagnostics used by tests and the differential harness — never invalidation
 * controls (there is deliberately no manual stale-marking API — Req 2.3).
 */
export class IncrementalDb implements Db {
  /** input identity → (raw key → value). Mirrors {@link NaiveDb} exactly so
   * the two backends agree byte-for-byte on input storage semantics. */
  readonly #inputs = new Map<InputSlot<unknown, unknown>, Map<unknown, unknown>>();
  /** query identity → (stable structural key → memo entry). */
  readonly #memo = new Map<QueryDef<unknown, unknown>, Map<string, MemoEntry>>();
  /** Monotonic global revision; bumped on every value-changing setInput. */
  #revision = 0;
  /** Stack of active dependency-capture frames (one per in-flight query). */
  readonly #frames: Frame[] = [];
  /** How many times a compute fn has actually run — proves caching for tests. */
  #recomputeCount = 0;

  /** The current global revision (diagnostic; see design.md §7.1 algorithm). */
  get revision(): number {
    return this.#revision;
  }

  /** Total number of compute-fn executions performed so far (diagnostic). */
  get recomputeCount(): number {
    return this.#recomputeCount;
  }

  /** Read a leaf input, recording the current query's dependency on it along
   * with the observed value (Req 2.1). Reading an unset input throws. */
  getInput<K, V>(input: InputSlot<K, V>, key: K): V {
    const value = this.#readInput(input, key);
    this.#record({
      kind: "input",
      input,
      key,
      observed: value,
    });
    return value;
  }

  /**
   * Read a derived query. Returns the memoised value if its recorded
   * dependencies are all unchanged (Req 2.4 — no recompute), otherwise
   * recomputes. Either way, records the `(q, key)` edge — with the returned
   * value as the observed value — into the caller's frame (Req 2.1).
   */
  query<K, V>(q: QueryDef<K, V>, key: K): V {
    const value = this.#fetch(q, key);
    this.#record({
      kind: "query",
      query: q,
      key,
      observed: value,
    });
    return value;
  }

  /**
   * Write a leaf input. Invalidation is the kernel's job and is implicit: when
   * the value actually changes we bump the global revision (Req 2.2 — no manual
   * stale-marking surface exists). Writing an equal value (by `Object.is`) is a
   * no-op so nothing downstream is disturbed (Req 2.6).
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
    this.#revision += 1; // Requirement 2.2: invalidation via revision bump.
  }

  /**
   * Ensure a memo entry for `(q, key)` and return its value. Cache hit when an
   * entry exists and {@link IncrementalDb.#verifyClean} holds; otherwise push a
   * fresh capture frame, run the compute, pop, and store a new entry stamped at
   * the current revision (design.md §7.1 `Db.query`).
   */
  #fetch<K, V>(q: QueryDef<K, V>, key: K): V {
    const cached = this.#lookup(q, key);
    if (cached !== undefined && this.#verifyClean(cached)) {
      return cached.value as V;
    }

    const frame: Frame = { deps: [] };
    this.#frames.push(frame);
    let value: V;
    try {
      value = this.#runCompute(q, key);
    } finally {
      this.#frames.pop();
    }

    this.#store(q, key, {
      value,
      deps: frame.deps,
      verifiedAtRevision: this.#revision,
    });
    return value;
  }

  /**
   * Is this entry still valid at the current revision? (design.md §7.1
   * `verifyClean`.) Fast path: already verified this revision. Otherwise check
   * each dependency; if NONE changed, stamp the entry as verified-now and
   * return true (the early stop — an unchanged-value dep does not propagate).
   * The first changed dependency short-circuits to false.
   */
  #verifyClean(entry: MemoEntry): boolean {
    if (entry.verifiedAtRevision === this.#revision) {
      return true;
    }
    for (const dep of entry.deps) {
      if (this.#depChanged(dep)) {
        return false;
      }
    }
    entry.verifiedAtRevision = this.#revision;
    return true;
  }

  /**
   * Did a single recorded dependency change vs the value observed at capture?
   *   - input: identity compare (`Object.is`) of current vs observed.
   *   - query: recursively ensure/verify the sub-query (which may itself early
   *     stop), then deep-structurally compare its value vs observed.
   */
  #depChanged(dep: RecordedDep): boolean {
    if (dep.kind === "input") {
      const current = this.#readInput(dep.input, dep.key);
      return !Object.is(current, dep.observed);
    }
    const current = this.#fetch(dep.query, dep.key);
    return !deepEqual(current, dep.observed);
  }

  /** Look up the memo entry for `(q, key)`, or undefined if absent. */
  #lookup<K, V>(q: QueryDef<K, V>, key: K): MemoEntry | undefined {
    const byKey = this.#memo.get(q);
    return byKey?.get(stableKey(key));
  }

  /** Store (or replace) the memo entry for `(q, key)`. */
  #store<K, V>(q: QueryDef<K, V>, key: K, entry: MemoEntry): void {
    const handle = q as QueryDef<unknown, unknown>;
    let byKey = this.#memo.get(handle);
    if (byKey === undefined) {
      byKey = new Map<string, MemoEntry>();
      this.#memo.set(handle, byKey);
    }
    byKey.set(stableKey(key), entry);
  }

  /** Read an input's stored value without recording a dependency (used during
   * `verifyClean`). Throws {@link InputNotSetError} for an unset input. */
  #readInput<K, V>(input: InputSlot<K, V>, key: K): V {
    const slot = this.#inputs.get(input);
    if (slot === undefined || !slot.has(key)) {
      throw new InputNotSetError(input.name, key);
    }
    return slot.get(key) as V;
  }

  /** Execute the hidden compute function behind a QueryDef, counting the run. */
  #runCompute<K, V>(q: QueryDef<K, V>, key: K): V {
    const compute = (q as QueryDefInternal<K, V>)[COMPUTE];
    this.#recomputeCount += 1;
    return compute(this, key);
  }

  /** Append an edge to the innermost active frame, if any (top-level reads
   * have no enclosing query and so record nothing). */
  #record(dep: RecordedDep): void {
    const frame = this.#frames[this.#frames.length - 1];
    if (frame !== undefined) {
      frame.deps.push(dep);
    }
  }
}

// ---------------------------------------------------------------------------
// Stable structural key for the memo (see header "Memo keying strategy")
// ---------------------------------------------------------------------------

/** Derive a stable structural string key for a memo key value. */
function stableKey(key: unknown): string {
  return stableStringify(key);
}

/**
 * Serialise `value` to a stable string: primitives as their JSON form (so types
 * namespace the value and never collide), arrays/objects recursively with
 * object keys SORTED so structurally-equal keys produce identical strings.
 */
function stableStringify(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value !== "object") {
    switch (typeof value) {
      case "string":
      case "number":
      case "boolean":
        return JSON.stringify(value);
      case "bigint":
        return `bigint:${value.toString()}`;
      default:
        // symbol / function / undefined are not expected as pipeline keys.
        return `other:${typeof value}`;
    }
  }
  if (Array.isArray(value)) {
    const arr = value as readonly unknown[];
    return `[${arr.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

// ---------------------------------------------------------------------------
// Deep structural equality for query value-change detection
// ---------------------------------------------------------------------------

/**
 * Deep structural equality over frozen IR values (primitives, arrays, typed
 * arrays, Map, Set, and plain objects). Leaves compare with `Object.is` (so
 * `NaN` equals `NaN` and `+0`/`-0` differ). This is the comparison used to
 * decide whether a sub-query's re-computed value actually changed — equal
 * values early-stop and do not force dependents to recompute.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
    return false;
  }

  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    return ArrayBuffer.isView(a) && ArrayBuffer.isView(b) && viewsEqual(a, b);
  }

  if (a instanceof Map || b instanceof Map) {
    return a instanceof Map && b instanceof Map && mapsEqual(a, b);
  }

  if (a instanceof Set || b instanceof Set) {
    return a instanceof Set && b instanceof Set && setsEqual(a, b);
  }

  const aArray = Array.isArray(a);
  const bArray = Array.isArray(b);
  if (aArray !== bArray) {
    return false;
  }
  if (aArray) {
    const arrA = a as readonly unknown[];
    const arrB = b as readonly unknown[];
    if (arrA.length !== arrB.length) {
      return false;
    }
    for (let i = 0; i < arrA.length; i += 1) {
      if (!deepEqual(arrA[i], arrB[i])) {
        return false;
      }
    }
    return true;
  }
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);
  if (keysA.length !== keysB.length) {
    return false;
  }
  for (const k of keysA) {
    if (!Object.prototype.hasOwnProperty.call(objB, k)) {
      return false;
    }
    if (!deepEqual(objA[k], objB[k])) {
      return false;
    }
  }
  return true;
}

/** Byte-for-byte equality for typed-array/DataView IR payloads. */
function viewsEqual(a: ArrayBufferView, b: ArrayBufferView): boolean {
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b) || a.byteLength !== b.byteLength) {
    return false;
  }
  const bytesA = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const bytesB = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < bytesA.length; i += 1) {
    if (bytesA[i] !== bytesB[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Order-insensitive structural equality for Map-valued IR such as DomTree.nodes.
 *
 * Fast path first: when both maps iterate in the SAME order — the common case,
 * since engine IR is rebuilt deterministically from equal inputs — entries
 * compare pairwise with no intermediate allocation. Only a mid-walk mismatch
 * falls back to order-insensitive multiset matching over b's entries, where an
 * `Object.is` pre-check keeps reference-distinct primitive keys from paying a
 * full `deepEqual` (which allocates `Object.keys` arrays) per failed probe.
 */
function mapsEqual(a: ReadonlyMap<unknown, unknown>, b: ReadonlyMap<unknown, unknown>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  const iterB = b.entries();
  let ordered = true;
  for (const [keyA, valueA] of a) {
    const step = iterB.next();
    if (step.done || !keysEqual(keyA, step.value[0]) || !deepEqual(valueA, step.value[1])) {
      ordered = false;
      break;
    }
  }
  if (ordered) {
    return true;
  }
  const unmatched = [...b.entries()];
  for (const [keyA, valueA] of a) {
    const index = unmatched.findIndex(([keyB, valueB]) => keysEqual(keyA, keyB) && deepEqual(valueA, valueB));
    if (index === -1) {
      return false;
    }
    unmatched.splice(index, 1);
  }
  return true;
}

/**
 * Order-insensitive structural equality for Set-valued IR/diagnostic values,
 * with the same ordered fast path + multiset fallback as {@link mapsEqual}.
 */
function setsEqual(a: ReadonlySet<unknown>, b: ReadonlySet<unknown>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  const iterB = b.values();
  let ordered = true;
  for (const valueA of a) {
    const step = iterB.next();
    if (step.done || !(Object.is(valueA, step.value) || deepEqual(valueA, step.value))) {
      ordered = false;
      break;
    }
  }
  if (ordered) {
    return true;
  }
  const unmatched = [...b.values()];
  for (const valueA of a) {
    const index = unmatched.findIndex((valueB) => Object.is(valueA, valueB) || deepEqual(valueA, valueB));
    if (index === -1) {
      return false;
    }
    unmatched.splice(index, 1);
  }
  return true;
}

/** Key equality for map entries: identity first (free), then structural. */
function keysEqual(a: unknown, b: unknown): boolean {
  return Object.is(a, b) || deepEqual(a, b);
}
