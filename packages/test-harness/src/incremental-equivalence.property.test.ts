/**
 * Property 2: 增量等价 (incremental equivalence) — the FORMAL named correctness
 * property (design.md §9.2 Property 2; Requirements 9.2, 2.2).
 *
 * **Validates: Requirements 9.2, 2.2**
 *
 *   > ∀ inputSeq:  runIncremental(seq) === runFromScratch(seq.last)
 *   > 增量结果恒等于全量重算结果。
 *   > Example: bytesEqual(render(applyIncremental(seq)),
 *   >                     render(computeFromScratch(seq.finalState)))
 *
 * This is the "反命题" of v0's stale-cache bug#1 written as an executable
 * assertion: an incremental backend that, after an ARBITRARY edit history,
 * served even one byte that disagreed with a clean from-scratch recompute would
 * fail here and turn CI red. It also pins transitive invalidation (Req 2.2 — an
 * input change must invalidate every query whose recorded deps transitively
 * include that input): the top query fans in over chains/aggregates, so a stale
 * leaf would surface as a byte mismatch in the rendered report.
 *
 * ── How this DIFFERS from task 5.11's stateless differential gate ───────────
 * `pipeline-differential.test.ts` (task 5.11) wires the harness's
 * {@link runDifferential}, which is **stateless / history-insensitive**: it
 * applies the *same full edit sequence* to TWO FRESH backends (naive vs
 * incremental) and compares. Both sides see the identical sequence from a clean
 * slate; it asks "given the same history from scratch, do the two backends
 * agree?".
 *
 * Property 2 here is deliberately **history-SENSITIVE**, matching the design's
 * `runIncremental(seq) === runFromScratch(seq.last)` exactly:
 *
 *   - `runIncrementalWithHistory(history)` is ONE long-lived
 *     {@link IncrementalDb} that has the WHOLE edit sequence applied
 *     incrementally, **probing after every edit** so the memo accumulates real
 *     cached entries and real invalidations / early-stops across the entire
 *     history, before a final probe.
 *   - `runFromScratch(finalState)` is a FRESH {@link NaiveDb} seeded with ONLY
 *     the final per-key value (the sequence's last write per key) — `seq.last`,
 *     the trusted full recompute — and probed once.
 *
 * So this property proves something 5.11 cannot: that the incremental cache,
 * after an arbitrary accumulated EDIT HISTORY, holds *exactly* the value a
 * clean from-scratch computation of the FINAL state would produce — i.e. no
 * stale entry survives the history. (5.11 never reuses a backend across a
 * sequence, so it cannot expose a "history left a stale entry behind" bug; this
 * file does.)
 *
 * Constraints: this file imports only the test-harness's own `./differential.js`
 * (for `compareBytes` / `canonicalJsonBytes` / the blocking helper) and
 * `@browser-engine/kernel`; the query graph below is defined locally rather than
 * shared with 5.11, so the two gates stay independent.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  define,
  defineInput,
  IncrementalDb,
  NaiveDb,
  type Db,
  type InputSlot,
  type QueryDef,
} from "@browser-engine/kernel";

import {
  assertDifferentialIdentical,
  canonicalJsonBytes,
  compareBytes,
  type DifferentialOutcome,
  type InputEdit,
  type RenderProbe,
} from "./differential.js";

// ---------------------------------------------------------------------------
// A representative query graph (local to this file).
//
//   Leaf:   Cell[a] Cell[b] Cell[c]
//             │       │       │
//   per-leaf  ├─ qDouble(k) ─ qChain(k)            (chain, depth 2; fan-out)
//             └─ qIsPositive(k)                     (early-stop-prone boolean)
//   fan-in:  qTotal       = Σ Cell[k]              (reads every leaf input)
//            qChainTotal  = Σ qChain(k)            (reads every per-leaf chain)
//            qPositiveCount = #{ k : qIsPositive(k) }   (reads every boolean q)
//   top:     qTop = { total, chainTotal, positiveCount,
//                     chains:{k…}, signs:{k…} }    (fan-in over everything)
//
// The mix is deliberate: chains exercise transitive invalidation (Req 2.2),
// fan-in exercises wide dependency sets, and qIsPositive is early-stop-prone
// (two distinct positive values map to the SAME boolean), so an arbitrary
// history drives genuine cache hits, invalidations, AND early-stops before the
// final probe.
// ---------------------------------------------------------------------------

/** The fixed set of leaf-input keys the generated histories operate over. */
const LEAF_KEYS = ["a", "b", "c"] as const;
type LeafKey = (typeof LEAF_KEYS)[number];

/** The single leaf input: a "cell" mapping each key to an integer. */
const Cell: InputSlot<LeafKey, number> = defineInput<LeafKey, number>("Cell");

/** per-leaf, depth-1: double a leaf (reads exactly one input → fine dep). */
const qDouble: QueryDef<LeafKey, number> = define(
  (db: Db, key: LeafKey) => db.getInput(Cell, key) * 2,
  "qDouble",
);

/** per-leaf, depth-2 chain: shift the doubled value (depends on qDouble(key)). */
const qChain: QueryDef<LeafKey, number> = define(
  (db: Db, key: LeafKey) => db.query(qDouble, key) + 1,
  "qChain",
);

/** per-leaf, early-stop-prone boolean predicate over a single leaf. */
const qIsPositive: QueryDef<LeafKey, boolean> = define(
  (db: Db, key: LeafKey) => db.getInput(Cell, key) > 0,
  "qIsPositive",
);

/** fan-in: sum every leaf input directly (a wide input-dependency set). */
const qTotal: QueryDef<null, number> = define((db: Db) => {
  let sum = 0;
  for (const key of LEAF_KEYS) {
    sum += db.getInput(Cell, key);
  }
  return sum;
}, "qTotal");

/** fan-in over a derived chain query: sum every qChain(key). */
const qChainTotal: QueryDef<null, number> = define((db: Db) => {
  let sum = 0;
  for (const key of LEAF_KEYS) {
    sum += db.query(qChain, key);
  }
  return sum;
}, "qChainTotal");

/** fan-in over the early-stop-prone predicate: count positive leaves. */
const qPositiveCount: QueryDef<null, number> = define((db: Db) => {
  let count = 0;
  for (const key of LEAF_KEYS) {
    if (db.query(qIsPositive, key)) {
      count += 1;
    }
  }
  return count;
}, "qPositiveCount");

/** Shape of the top-level report serialised by the probe. */
interface Report {
  readonly total: number;
  readonly chainTotal: number;
  readonly positiveCount: number;
  readonly chains: Record<string, number>;
  readonly signs: Record<string, boolean>;
}

/** The top query under test: a fan-in over the whole graph. */
const qTop: QueryDef<null, Report> = define((db: Db): Report => {
  const chains: Record<string, number> = {};
  const signs: Record<string, boolean> = {};
  for (const key of LEAF_KEYS) {
    chains[key] = db.query(qChain, key);
    signs[key] = db.query(qIsPositive, key);
  }
  return {
    total: db.query(qTotal, null),
    chainTotal: db.query(qChainTotal, null),
    positiveCount: db.query(qPositiveCount, null),
    chains,
    signs,
  };
}, "qTop");

/** Probe: run the top query and serialise its result to canonical JSON bytes. */
const reportProbe: RenderProbe = (db: Db) => canonicalJsonBytes(db.query(qTop, null));

// ---------------------------------------------------------------------------
// State seeding and final-state computation.
// ---------------------------------------------------------------------------

/**
 * Every leaf must be defined before the FIRST probe (an unset input fails
 * loudly by design — `InputNotSetError`). This seed sets all leaves to 0 so the
 * report is well-defined from the very first probe; any leaf the generated
 * history never touches keeps this seeded value as its final value.
 */
const SEED_VALUE = 0;

/**
 * The "last write wins" final state of `seed ∘ history`: the value each leaf
 * holds after the whole sequence — design's `seq.finalState` / `seq.last`.
 * Starts from the all-leaves seed so every key is present.
 */
function finalStateOf(history: readonly InputEdit[]): Map<LeafKey, number> {
  const state = new Map<LeafKey, number>();
  for (const key of LEAF_KEYS) {
    state.set(key, SEED_VALUE);
  }
  for (const edit of history) {
    state.set(edit.key as LeafKey, edit.value as number);
  }
  return state;
}

// ---------------------------------------------------------------------------
// runIncrementalWithHistory — HISTORY-SENSITIVE (the heart of Property 2).
//
// ONE long-lived IncrementalDb that has the WHOLE edit sequence applied
// incrementally, PROBING AFTER EACH EDIT so the memo accumulates real cached
// entries and real invalidations / early-stops across the entire history. This
// is precisely what 5.11's stateless `runDifferential` does NOT do: it applies
// a sequence to a FRESH backend with no probing in between. Returns the FINAL
// probe bytes (design's `render(applyIncremental(seq))`).
// ---------------------------------------------------------------------------
function runIncrementalWithHistory(
  history: readonly InputEdit[],
  probe: RenderProbe,
): Uint8Array {
  const db = new IncrementalDb();
  // Seed every leaf, then probe once to populate the initial memo.
  for (const key of LEAF_KEYS) {
    db.setInput(Cell, key, SEED_VALUE);
  }
  probe(db);
  // Replay the history; probe after EVERY edit so the cache is repeatedly
  // populated, invalidated (Req 2.2 transitive invalidation), and early-stopped
  // — accumulating real history before the final probe.
  for (const edit of history) {
    db.setInput(edit.input, edit.key, edit.value);
    probe(db);
  }
  return probe(db);
}

// ---------------------------------------------------------------------------
// runFromScratch — the trusted full recompute over ONLY the final state.
//
// A FRESH NaiveDb (which never caches — always recomputes) seeded with ONLY the
// final per-key value (`seq.last`), then probed once. This is design's
// `render(computeFromScratch(seq.finalState))`.
// ---------------------------------------------------------------------------
function runFromScratch(finalState: ReadonlyMap<LeafKey, number>, probe: RenderProbe): Uint8Array {
  const db = new NaiveDb();
  for (const key of LEAF_KEYS) {
    db.setInput(Cell, key, finalState.get(key) ?? SEED_VALUE);
  }
  return probe(db);
}

/**
 * A FRESH IncrementalDb seeded with ONLY the final state, probed once. Used for
 * the converse-stability check: the history-driven incremental result must
 * equal the no-history incremental result, proving the accumulated edit HISTORY
 * introduces no drift in the incremental cache itself.
 */
function runIncrementalFromScratch(
  finalState: ReadonlyMap<LeafKey, number>,
  probe: RenderProbe,
): Uint8Array {
  const db = new IncrementalDb();
  for (const key of LEAF_KEYS) {
    db.setInput(Cell, key, finalState.get(key) ?? SEED_VALUE);
  }
  return probe(db);
}

/** Build a {@link DifferentialOutcome} so we can reuse the harness's blocking
 * machinery (a thrown {@link import("./differential.js").DifferentialMismatchError}
 * with the first diverging byte) for diagnosis (Req 13.4-style). */
function outcomeOf(reference: Uint8Array, candidate: Uint8Array, editCount: number): DifferentialOutcome {
  const difference = compareBytes(reference, candidate);
  return { identical: difference === null, editCount, difference };
}

// ---------------------------------------------------------------------------
// Edit-history generation (arbitrary sequences over the leaf inputs).
// ---------------------------------------------------------------------------

/**
 * A fast-check arbitrary for a random edit HISTORY. The value range is small
 * (−3..3) on purpose: small ranges make repeats common, so the history
 * naturally contains no-op EQUAL writes (Req 2.6 / the no-bump path) and
 * frequent crossings of zero (sign flips that flip `qIsPositive` and force true
 * transitive invalidation — Req 2.2).
 */
const arbHistory: fc.Arbitrary<readonly InputEdit[]> = fc
  .array(
    fc.record({
      key: fc.constantFrom(...LEAF_KEYS),
      value: fc.integer({ min: -3, max: 3 }),
    }),
    { maxLength: 40 },
  )
  .map((raw): readonly InputEdit[] =>
    raw.map((edit) => ({ input: Cell, key: edit.key, value: edit.value })),
  );

/** Total trials for the formal Property-2 gate (generous; runs every commit). */
const PROPERTY_RUNS = 300;

// ---------------------------------------------------------------------------
// Property 2 (Req 9.2, 2.2): runIncremental(seq) === runFromScratch(seq.last).
// ---------------------------------------------------------------------------

void test("Property 2 (Req 9.2, 2.2): runIncrementalWithHistory(seq) is byte-for-byte identical to runFromScratch(seq.finalState)", () => {
  // **Validates: Requirements 9.2, 2.2** — Property 2: 增量等价.
  fc.assert(
    fc.property(arbHistory, (history) => {
      const incrementalBytes = runIncrementalWithHistory(history, reportProbe);
      const fromScratchBytes = runFromScratch(finalStateOf(history), reportProbe);
      // Any divergence THROWS DifferentialMismatchError → fails the test →
      // fails CI → blocks the merge (Req 9.4 / 13.4). The thrown error
      // pinpoints the first diverging byte for diagnosis against the naive
      // (from-scratch) backend.
      assertDifferentialIdentical(outcomeOf(fromScratchBytes, incrementalBytes, history.length));
    }),
    { numRuns: PROPERTY_RUNS },
  );
});

// ---------------------------------------------------------------------------
// Converse stability (Req 2.2): the accumulated history introduces no drift in
// the incremental cache — a history-driven IncrementalDb equals a fresh
// IncrementalDb seeded with only the final state.
// ---------------------------------------------------------------------------

void test("Property 2 (Req 9.2, 2.2): edit HISTORY introduces no cache drift — history-driven incremental equals no-history incremental on the same final state", () => {
  // **Validates: Requirements 9.2, 2.2** — Property 2: 增量等价 (converse stability).
  fc.assert(
    fc.property(arbHistory, (history) => {
      const finalState = finalStateOf(history);
      const withHistory = runIncrementalWithHistory(history, reportProbe);
      const noHistory = runIncrementalFromScratch(finalState, reportProbe);
      assertDifferentialIdentical(outcomeOf(noHistory, withHistory, history.length));
    }),
    { numRuns: PROPERTY_RUNS },
  );
});

// ---------------------------------------------------------------------------
// Deterministic regression anchors for the history-sensitive paths.
// ---------------------------------------------------------------------------

void test("Property 2 (Req 2.2): a sign-flip history leaves no stale cache (transitive invalidation)", () => {
  // History drives qIsPositive(a) true → false → true; the final probe must
  // equal the from-scratch result for the final value.
  const history: readonly InputEdit[] = [
    { input: Cell, key: "a", value: 2 }, // positive
    { input: Cell, key: "a", value: -2 }, // crosses zero: must transitively invalidate
    { input: Cell, key: "a", value: 3 }, // positive again, new magnitude
  ];
  const incremental = runIncrementalWithHistory(history, reportProbe);
  const fromScratch = runFromScratch(finalStateOf(history), reportProbe);
  assert.equal(compareBytes(fromScratch, incremental), null);
});

void test("Property 2 (Req 2.6): an equal-write history does not perturb the from-scratch result", () => {
  const history: readonly InputEdit[] = [
    { input: Cell, key: "b", value: 1 },
    { input: Cell, key: "b", value: 1 }, // equal re-write: must NOT bump revision
    { input: Cell, key: "c", value: -1 },
  ];
  const incremental = runIncrementalWithHistory(history, reportProbe);
  const fromScratch = runFromScratch(finalStateOf(history), reportProbe);
  assert.equal(compareBytes(fromScratch, incremental), null);
});

// ---------------------------------------------------------------------------
// Guard: the property is MEANINGFUL — the history-sensitive runner genuinely
// accumulates cache + early-stops (so it is not trivially satisfiable by a
// backend that secretly recomputes everything on every probe), AND the
// from-scratch reference is a real full recompute.
// ---------------------------------------------------------------------------

void test("the history-sensitive runner genuinely caches + early-stops (property is meaningful)", () => {
  const db = new IncrementalDb();
  for (const key of LEAF_KEYS) {
    db.setInput(Cell, key, SEED_VALUE);
  }
  db.setInput(Cell, "a", 3); // a positive

  // First probe populates the memo.
  reportProbe(db);
  const afterFirst = db.recomputeCount;

  // Re-probe with no edits: everything served from cache (no recompute).
  reportProbe(db);
  assert.equal(db.recomputeCount, afterFirst, "expected a full cache hit on an unchanged re-probe");

  // Positive→positive flip: qIsPositive(a) stays true, so qPositiveCount must
  // early-stop — strictly fewer recomputes than a from-scratch run of the
  // whole graph (which would recompute every query).
  db.setInput(Cell, "a", 7);
  reportProbe(db);
  const recomputesForFlip = db.recomputeCount - afterFirst;
  // From scratch this graph runs 14 distinct computations: qTop + qTotal +
  // qChainTotal + qPositiveCount + 3×qDouble + 3×qChain + 3×qIsPositive.
  // Flipping only `a` to another positive value invalidates a's chain but
  // qIsPositive(a) re-computes to the SAME boolean, so qPositiveCount
  // early-stops and is NOT recomputed → strictly fewer than 14.
  assert.ok(
    recomputesForFlip > 0 && recomputesForFlip < 14,
    `early-stop should recompute some-but-not-all queries; got ${recomputesForFlip}`,
  );
});
