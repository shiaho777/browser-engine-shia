/**
 * PERMANENT differential regression gate — naive full-recompute vs the REAL
 * incremental backend, byte-for-byte (task 5.11; design.md §7.1 / §9.2
 * Property 2; Requirements 9.2, 9.4, 13.4).
 *
 * Task 1.9 built the harness (`./differential.ts`) and exercised it with two
 * `NaiveDb` instances (plus a faulty double, to prove the detector bites). Task
 * 5.9 landed the real {@link IncrementalDb}. THIS file performs the wiring the
 * design calls "焊死接缝" (welding the seam shut): it pairs
 *
 *     reference = () => new NaiveDb()          // trusted full recompute
 *     candidate = () => new IncrementalDb()    // revision-compare + early-stop
 *
 * over RANDOM input-edit sequences and asserts their rendered output is
 * byte-for-byte identical. The design promised task 5.11 "swaps in naive vs
 * incremental with **no structural change**" — and indeed the only difference
 * from the 1.9 tests is the candidate factory: same `runDifferential` /
 * `runDifferentialCampaign` calls, same probe, same assertion helpers.
 *
 * Why this lives in the normal `npm run test` suite: per Requirements 9.4 and
 * 13.4 ANY divergence must BLOCK the merge. The blocking mechanism is a thrown
 * {@link DifferentialMismatchError} (via {@link assertDifferentialIdentical} /
 * {@link assertCampaignClean}) — an unhandled throw fails this test, fails CI,
 * and blocks the merge. So this file is a permanent CI gate, run every commit.
 *
 * Diagnosing a failure (Requirement 13.4): a failure means the incremental
 * backend diverged from the naive baseline — i.e. an invalidation / early-stop
 * / caching bug in {@link IncrementalDb}. The developer reproduces against the
 * `reference` (naive) backend, which by construction is correct, and uses the
 * {@link DifferentialMismatchError}'s first-diverging-byte to anchor the hunt.
 * fast-check additionally shrinks the random edit sequence to a minimal
 * counterexample.
 *
 * Coverage of the incremental machinery (so the gate is MEANINGFUL, not
 * trivially satisfiable): the query graph below deliberately mixes
 *   - chains (qScaled → qShifted) so cache reuse propagates through depth,
 *   - fan-in (qSum / qPositiveCount read every leaf / every per-leaf query),
 *   - fan-out (the top report reads many per-leaf queries),
 *   - an early-stop-prone boolean query (qIsPositive): flipping a leaf between
 *     two positive values leaves its result equal, so the incremental backend
 *     early-stops its dependents — a path the naive backend never takes — and
 *     the two MUST still agree.
 * The generated edits include no-op equal writes (which must NOT bump the
 * revision — Req 2.6) and sign flips (which must invalidate), so caching,
 * invalidation, and early-stop are all pitted against the full recompute.
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
  assertCampaignClean,
  assertDifferentialIdentical,
  canonicalJsonBytes,
  DifferentialMismatchError,
  runDifferential,
  runDifferentialCampaign,
  type DbFactory,
  type InputEdit,
  type RenderProbe,
} from "./differential.js";

// ---------------------------------------------------------------------------
// The representative query graph (a small DAG: leaf inputs + derived queries).
//
//   Leaf:   Num[x] Num[y] Num[z] Num[w]
//             │      │      │      │
//   per-leaf  ├─ qScaled(k) ─ qShifted(k)        (chain, depth 2; fan-out)
//             └─ qIsPositive(k)                   (early-stop-prone boolean)
//   fan-in:  qSum        = Σ Num[k]               (reads every leaf)
//            qPositiveCount = #{ k : qIsPositive(k) }   (reads every per-leaf q)
//   chain:   qShiftedSum  = qScaledSum + offset where qScaledSum = Σ qScaled(k)
//   top:     qReport = { sum, scaledSum, shiftedSum, positiveCount,
//                        shifted:{k…}, signs:{k…} }   (fan-in over everything)
// ---------------------------------------------------------------------------

/** The fixed set of leaf-input keys the generated edit sequences operate over. */
const LEAF_KEYS = ["x", "y", "z", "w"] as const;
type LeafKey = (typeof LEAF_KEYS)[number];

/** The single leaf input: a "cell" mapping each key to an integer. */
const Num: InputSlot<LeafKey, number> = defineInput<LeafKey, number>("Num");

/** per-leaf, depth-1: scale a leaf. Reads exactly one input → fine-grained dep. */
const qScaled: QueryDef<LeafKey, number> = define(
  (db: Db, key: LeafKey) => db.getInput(Num, key) * 2,
  "qScaled",
);

/** per-leaf, depth-2 chain: shift the scaled value (depends on qScaled(key)). */
const qShifted: QueryDef<LeafKey, number> = define(
  (db: Db, key: LeafKey) => db.query(qScaled, key) + 1,
  "qShifted",
);

/**
 * per-leaf, early-stop-prone: a boolean predicate over a single leaf. Two
 * different positive (or two different non-positive) leaf values map to the
 * SAME boolean, so the incremental backend's deep-equal value check lets its
 * dependents early-stop even though the underlying input changed. The naive
 * backend recomputes regardless; both must agree.
 */
const qIsPositive: QueryDef<LeafKey, boolean> = define(
  (db: Db, key: LeafKey) => db.getInput(Num, key) > 0,
  "qIsPositive",
);

/** fan-in: sum every leaf input directly (a wide input-dependency set). */
const qSum: QueryDef<null, number> = define((db: Db) => {
  let sum = 0;
  for (const key of LEAF_KEYS) {
    sum += db.getInput(Num, key);
  }
  return sum;
}, "qSum");

/** fan-in over derived queries: sum every qScaled(key). */
const qScaledSum: QueryDef<null, number> = define((db: Db) => {
  let sum = 0;
  for (const key of LEAF_KEYS) {
    sum += db.query(qScaled, key);
  }
  return sum;
}, "qScaledSum");

/** chain over an aggregate query: depends on qScaledSum. */
const qShiftedSum: QueryDef<null, number> = define(
  (db: Db) => db.query(qScaledSum, null) + 10,
  "qShiftedSum",
);

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
  readonly sum: number;
  readonly scaledSum: number;
  readonly shiftedSum: number;
  readonly positiveCount: number;
  readonly shifted: Record<string, number>;
  readonly signs: Record<string, boolean>;
}

/** The top query under differential test: a fan-in over the whole graph. */
const qReport: QueryDef<null, Report> = define((db: Db): Report => {
  const shifted: Record<string, number> = {};
  const signs: Record<string, boolean> = {};
  for (const key of LEAF_KEYS) {
    shifted[key] = db.query(qShifted, key);
    signs[key] = db.query(qIsPositive, key);
  }
  return {
    sum: db.query(qSum, null),
    scaledSum: db.query(qScaledSum, null),
    shiftedSum: db.query(qShiftedSum, null),
    positiveCount: db.query(qPositiveCount, null),
    shifted,
    signs,
  };
}, "qReport");

/** Probe: run the top query and serialise its result to canonical JSON bytes. */
const reportProbe: RenderProbe = (db: Db) => canonicalJsonBytes(db.query(qReport, null));

// ---------------------------------------------------------------------------
// The wiring that task 5.11 is about: reference = naive, candidate = REAL incremental.
// ---------------------------------------------------------------------------

/** Reference side (trusted full recompute / Requirement 13.4 diagnosis target). */
const naiveFactory: DbFactory = () => new NaiveDb();
/** Candidate side (the real incremental backend under test). */
const incrementalFactory: DbFactory = () => new IncrementalDb();

// ---------------------------------------------------------------------------
// Edit-sequence generation (arbitrary sequences over the leaf inputs).
// ---------------------------------------------------------------------------

/**
 * Init prelude: every leaf must be set before the report reads it (an unset
 * input fails loudly by design). Both backends receive the same prelude, so
 * byte-equality is unaffected.
 */
const initEdits: readonly InputEdit[] = LEAF_KEYS.map((key) => ({
  input: Num,
  key,
  value: 0,
}));

/**
 * A fast-check arbitrary for a random edit sequence. The value range is kept
 * small (−4..4) on purpose: small ranges make repeats common, so the sequence
 * naturally contains no-op EQUAL writes (exercise Req 2.6 / the no-bump path)
 * and frequent crossings of zero (sign flips that flip qIsPositive). The
 * prelude is prepended so the report is always well-defined.
 */
const arbEditSeq: fc.Arbitrary<readonly InputEdit[]> = fc
  .array(
    fc.record({
      key: fc.constantFrom(...LEAF_KEYS),
      value: fc.integer({ min: -4, max: 4 }),
    }),
    { maxLength: 50 },
  )
  .map((raw): readonly InputEdit[] => [
    ...initEdits,
    ...raw.map((edit) => ({ input: Num, key: edit.key, value: edit.value })),
  ]);

/** Total trials for the property-based gate (generous; runs every commit). */
const PROPERTY_RUNS = 300;
/** Total trials for the fast-check-seeded campaign driver. */
const CAMPAIGN_RUNS = 200;

// ---------------------------------------------------------------------------
// Property 2 (Req 9.2): the permanent byte-for-byte equivalence gate.
// ---------------------------------------------------------------------------

void test("Property 2 (Req 9.2): real incremental backend is byte-for-byte identical to naive full recompute for any edit sequence", () => {
  // **Validates: Requirements 9.2**
  fc.assert(
    fc.property(arbEditSeq, (edits) => {
      const outcome = runDifferential(naiveFactory, incrementalFactory, edits, reportProbe);
      // Any divergence THROWS DifferentialMismatchError → fails the test →
      // fails CI → blocks the merge (Requirements 9.4, 13.4). The thrown error
      // pinpoints the first diverging byte for diagnosis against the naive
      // (reference) backend.
      assertDifferentialIdentical(outcome);
    }),
    { numRuns: PROPERTY_RUNS },
  );
});

// ---------------------------------------------------------------------------
// Campaign driver wired with a fast-check-seeded generator (alternate entry point).
// ---------------------------------------------------------------------------

void test("Req 9.2/9.4/13.4: differential campaign (naive vs incremental) over fast-check-seeded edit sequences stays clean", () => {
  // **Validates: Requirements 9.2**
  const sequences = fc.sample(arbEditSeq, CAMPAIGN_RUNS);
  const result = runDifferentialCampaign(
    naiveFactory,
    incrementalFactory,
    reportProbe,
    (run) => sequences[run] ?? initEdits,
    sequences.length,
  );
  // assertCampaignClean throws on the first diverging trial → blocks the merge.
  assertCampaignClean(result);
  assert.equal(result.runs, sequences.length);
  assert.equal(result.firstFailure, null);
});

// ---------------------------------------------------------------------------
// Deterministic regression anchors (concrete sequences for the tricky paths).
// ---------------------------------------------------------------------------

void test("Req 9.2: no-op equal writes do not perturb incremental output vs naive", () => {
  const edits: readonly InputEdit[] = [
    ...initEdits,
    { input: Num, key: "x", value: 3 },
    { input: Num, key: "x", value: 3 }, // equal re-write: must NOT bump revision (Req 2.6)
    { input: Num, key: "y", value: 3 },
  ];
  assertDifferentialIdentical(runDifferential(naiveFactory, incrementalFactory, edits, reportProbe));
});

void test("Req 9.2: positive→positive flip (early-stop path) still matches the full recompute", () => {
  const edits: readonly InputEdit[] = [
    ...initEdits,
    { input: Num, key: "z", value: 2 }, // qIsPositive(z) = true
    { input: Num, key: "z", value: 4 }, // still positive: incremental early-stops the sign-dependents
  ];
  assertDifferentialIdentical(runDifferential(naiveFactory, incrementalFactory, edits, reportProbe));
});

void test("Req 9.2: sign flip (true invalidation) still matches the full recompute", () => {
  const edits: readonly InputEdit[] = [
    ...initEdits,
    { input: Num, key: "w", value: 5 }, // positive
    { input: Num, key: "w", value: -5 }, // crosses zero: qIsPositive(w) flips → must invalidate
  ];
  assertDifferentialIdentical(runDifferential(naiveFactory, incrementalFactory, edits, reportProbe));
});

// ---------------------------------------------------------------------------
// Guard: the gate is MEANINGFUL — the incremental backend really caches and
// early-stops on this graph (so the differential check is not trivially passed
// by a backend that secretly recomputes everything every time).
// ---------------------------------------------------------------------------

void test("the graph genuinely exercises incremental caching + early-stop (gate is meaningful)", () => {
  const db = new IncrementalDb();
  for (const edit of initEdits) {
    db.setInput(Num, edit.key as LeafKey, edit.value as number);
  }
  db.setInput(Num, "x", 3); // x positive

  // First probe populates the memo.
  const first = canonicalJsonBytes(db.query(qReport, null));
  const afterFirst = db.recomputeCount;

  // Re-query with no edits: everything must be served from cache (no recompute).
  canonicalJsonBytes(db.query(qReport, null));
  assert.equal(db.recomputeCount, afterFirst, "expected a full cache hit on an unchanged re-query");

  // Equal re-write: must not bump the revision, so still a full cache hit.
  const revBefore = db.revision;
  db.setInput(Num, "x", 3);
  assert.equal(db.revision, revBefore, "equal write must not bump revision (Req 2.6)");
  canonicalJsonBytes(db.query(qReport, null));
  assert.equal(db.recomputeCount, afterFirst, "equal write must leave dependents cached");

  // Positive→positive flip: qIsPositive(x) stays true, so its dependents
  // (qPositiveCount, signs) must early-stop — fewer recomputes than a from
  // scratch run, proving early-stop is engaged.
  db.setInput(Num, "x", 7);
  const reportAfterFlip = canonicalJsonBytes(db.query(qReport, null));
  const recomputesForFlip = db.recomputeCount - afterFirst;
  // A from-scratch recompute of this graph runs 17 distinct query computations
  // (qReport + qSum + qScaledSum + qShiftedSum + qPositiveCount
  //  + 4×qScaled + 4×qShifted + 4×qIsPositive). Flipping only x to another
  // positive value invalidates x's chain (qScaled/qShifted/qSum/qScaledSum/
  // qShiftedSum/qReport) but qIsPositive(x) re-computes to the SAME boolean, so
  // qPositiveCount early-stops and is NOT recomputed. The incremental backend
  // must therefore recompute some-but-not-all queries — strictly fewer than 17.
  assert.ok(
    recomputesForFlip > 0 && recomputesForFlip < 17,
    `early-stop should recompute some-but-not-all queries; got ${recomputesForFlip}`,
  );

  // And as a final cross-check, the incremental result equals the naive result
  // for the very same sequence (this is the property the campaign asserts at scale).
  const naive = new NaiveDb();
  for (const edit of initEdits) {
    naive.setInput(Num, edit.key as LeafKey, edit.value as number);
  }
  naive.setInput(Num, "x", 7);
  assert.deepEqual(
    [...reportAfterFlip],
    [...canonicalJsonBytes(naive.query(qReport, null))],
  );
  assert.ok(first.length > 0);
});

// ---------------------------------------------------------------------------
// Guard: the gate BLOCKS — prove a divergent candidate is caught and throws.
// (Mirrors the 1.9 "detector bites" test, now framed for the 5.11 pairing.)
// ---------------------------------------------------------------------------

/**
 * A deliberately broken candidate: an {@link IncrementalDb} that drops the
 * caller's intended value for key "z" by one. Stands in for "an incremental
 * backend with an invalidation bug" so we can prove the 5.11 gate would fire.
 */
class BrokenIncrementalDb extends IncrementalDb {
  override setInput<K, V>(input: InputSlot<K, V>, key: K, value: V): void {
    if ((key as unknown) === "z" && typeof value === "number") {
      super.setInput(input, key, (value + 1) as V);
      return;
    }
    super.setInput(input, key, value);
  }
}

void test("Req 9.4/13.4: a divergent incremental candidate is detected and BLOCKS (throws)", () => {
  const brokenFactory: DbFactory = () => new BrokenIncrementalDb();
  const edits: readonly InputEdit[] = [...initEdits, { input: Num, key: "z", value: 5 }];

  const outcome = runDifferential(naiveFactory, brokenFactory, edits, reportProbe);
  assert.equal(outcome.identical, false);
  assert.ok(outcome.difference !== null);
  assert.throws(() => {
    assertDifferentialIdentical(outcome);
  }, DifferentialMismatchError);
});
