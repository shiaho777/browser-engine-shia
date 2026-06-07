/**
 * Tests for the differential testing harness (task 1.9).
 *
 * Built by `tsc` then run with: `node --test packages/test-harness/dist/*.test.js`.
 *
 * Validates the design.md §9.2 Property 2 machinery and Requirements 9.2 / 9.4 /
 * 13.4:
 *   - 9.2: FOR ALL input-edit sequences, two backends implementing the same
 *     `Db` interface produce byte-for-byte identical output. We exercise this
 *     property in Phase 0 with two independent `NaiveDb` instances (the real
 *     incremental backend arrives in task 5.9 and is wired here in task 5.11).
 *   - 9.4 / 13.4: ANY difference is detected and *blocks* (throws → fails the
 *     test process → blocks the merge). We prove the detector bites by diffing
 *     the naive backend against a deliberately faulty `Db` double; the reported
 *     first-diverging byte is the artefact for diagnosing against the naive
 *     (reference) backend.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  define,
  defineInput,
  NaiveDb,
  type Db,
  type InputSlot,
  type QueryDef,
} from "@browser-engine/kernel";

import {
  assertCampaignClean,
  assertDifferentialIdentical,
  canonicalJsonBytes,
  compareBytes,
  DifferentialMismatchError,
  runDifferential,
  runDifferentialCampaign,
  type DbFactory,
  type InputEdit,
  type RenderProbe,
} from "./differential.js";

// ---------------------------------------------------------------------------
// A tiny "render pipeline" written as a query, used as the probe target.
// ---------------------------------------------------------------------------

/** Fixed set of leaf-input keys the generated edit sequences operate over. */
const CELL_KEYS = ["a", "b", "c", "d"] as const;
type CellKey = (typeof CELL_KEYS)[number];

/** One leaf input: a "cell" mapping a key to an integer. */
const Cell: InputSlot<CellKey, number> = defineInput<CellKey, number>("Cell");

/**
 * The query under differential test: read every cell through the `Db` and emit
 * a deterministic report object. Reading goes exclusively through `db.getInput`
 * so the kernel can observe the dependencies (design.md §7.1).
 */
const qReport: QueryDef<null, { readonly cells: Record<string, number>; readonly sum: number }> =
  define((db: Db) => {
    const cells: Record<string, number> = {};
    let sum = 0;
    for (const key of CELL_KEYS) {
      const value = db.getInput(Cell, key);
      cells[key] = value;
      sum += value;
    }
    return { cells, sum };
  }, "qReport");

/** Probe: run the report query and serialise it to canonical JSON bytes. */
const reportProbe: RenderProbe = (db: Db) => canonicalJsonBytes(db.query(qReport, null));

/** Reference / candidate factories: in Phase 0 both are the naive backend. */
const naiveFactory: DbFactory = () => new NaiveDb();

// ---------------------------------------------------------------------------
// Edit-sequence generation
// ---------------------------------------------------------------------------

/**
 * Initialisation edits ensure every cell is set before the probe reads it (an
 * unset input fails loudly by design). Both backends receive the same prelude,
 * so byte-equality is unaffected.
 */
const initEdits: readonly InputEdit[] = CELL_KEYS.map((key) => ({
  input: Cell,
  key,
  value: 0,
}));

/** A fast-check arbitrary for a random sequence of cell edits. */
const arbInputEditSeq = fc
  .array(
    fc.record({
      key: fc.constantFrom(...CELL_KEYS),
      value: fc.integer({ min: -1000, max: 1000 }),
    }),
    { maxLength: 40 },
  )
  .map((raw): readonly InputEdit[] => [
    ...initEdits,
    ...raw.map((edit) => ({
      input: Cell,
      key: edit.key,
      value: edit.value,
    })),
  ]);

// ---------------------------------------------------------------------------
// Property 2 (byte-for-byte identical output across backends) — Req 9.2
// ---------------------------------------------------------------------------

void test("Property: two backends produce byte-for-byte identical output for any edit sequence", () => {
  // **Validates: Requirements 9.2**
  fc.assert(
    fc.property(arbInputEditSeq, (edits) => {
      const outcome = runDifferential(naiveFactory, naiveFactory, edits, reportProbe);
      assert.equal(outcome.identical, true, outcome.difference?.message ?? "unexpected mismatch");
    }),
  );
});

// ---------------------------------------------------------------------------
// The difference detector must BITE and BLOCK — Req 9.4, 13.4
// ---------------------------------------------------------------------------

/**
 * A deliberately faulty backend: it behaves like a `NaiveDb` except it corrupts
 * one cell's stored value (off-by-one). Stands in for "an incremental backend
 * with an invalidation bug" so we can prove the harness detects and blocks.
 */
class FaultyDb implements Db {
  readonly #inner = new NaiveDb();
  readonly #corruptKey: CellKey;

  constructor(corruptKey: CellKey) {
    this.#corruptKey = corruptKey;
  }

  getInput<K, V>(input: InputSlot<K, V>, key: K): V {
    return this.#inner.getInput(input, key);
  }

  query<K, V>(q: QueryDef<K, V>, key: K): V {
    return this.#inner.query(q, key);
  }

  setInput<K, V>(input: InputSlot<K, V>, key: K, value: V): void {
    // Corrupt only *non-zero* writes to the targeted key, so the all-zero init
    // prelude is stored faithfully (both backends agree until the corrupt key
    // is later written a meaningful value) — this models an invalidation bug
    // that only manifests on certain edits.
    if ((key as unknown) === this.#corruptKey && typeof value === "number" && value !== 0) {
      this.#inner.setInput(input, key, (value + 1) as V); // the injected bug
      return;
    }
    this.#inner.setInput(input, key, value);
  }
}

void test("Req 9.4/13.4: a divergent backend is detected and blocks (throws)", () => {
  const faultyFactory: DbFactory = () => new FaultyDb("c");
  const edits: readonly InputEdit[] = [
    ...initEdits,
    { input: Cell, key: "c", value: 5 },
  ];

  const outcome = runDifferential(naiveFactory, faultyFactory, edits, reportProbe);
  assert.equal(outcome.identical, false);
  assert.ok(outcome.difference !== null);

  // Blocking == throwing (an unhandled throw fails CI → blocks the merge).
  assert.throws(() => {
    assertDifferentialIdentical(outcome);
  }, DifferentialMismatchError);
});

void test("Req 9.2: identical backends do not block", () => {
  const edits: readonly InputEdit[] = [
    ...initEdits,
    { input: Cell, key: "a", value: 9 },
  ];
  const outcome = runDifferential(naiveFactory, naiveFactory, edits, reportProbe);
  assert.equal(outcome.identical, true);
  assert.doesNotThrow(() => {
    assertDifferentialIdentical(outcome);
  });
});

// ---------------------------------------------------------------------------
// Campaign driver
// ---------------------------------------------------------------------------

void test("campaign over many trials passes for matching backends and reports clean", () => {
  const result = runDifferentialCampaign(
    naiveFactory,
    naiveFactory,
    reportProbe,
    (run) => [
      ...initEdits,
      { input: Cell, key: "b", value: run },
    ],
    25,
  );
  assert.equal(result.runs, 25);
  assert.equal(result.firstFailure, null);
  assert.doesNotThrow(() => {
    assertCampaignClean(result);
  });
});

void test("campaign stops at and reports the first diverging trial", () => {
  // The candidate corrupts key "d"; trials that write "d" diverge, earlier ones do not.
  const faultyFactory: DbFactory = () => new FaultyDb("d");
  const result = runDifferentialCampaign(
    naiveFactory,
    faultyFactory,
    reportProbe,
    (run) =>
      run < 3
        ? [...initEdits, { input: Cell, key: "a", value: run }]
        : [...initEdits, { input: Cell, key: "d", value: run }],
    10,
  );

  assert.ok(result.firstFailure !== null);
  assert.equal(result.firstFailure.run, 3); // first trial that touches "d"
  assert.equal(result.runs, 4); // stopped right after the failure
  assert.throws(() => {
    assertCampaignClean(result);
  }, DifferentialMismatchError);
});

// ---------------------------------------------------------------------------
// Byte comparison + canonical serialisation primitives
// ---------------------------------------------------------------------------

void test("compareBytes returns null for byte-for-byte equal inputs", () => {
  assert.equal(compareBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])), null);
});

void test("compareBytes pinpoints the first differing byte", () => {
  const diff = compareBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 9, 3]));
  assert.ok(diff !== null);
  assert.equal(diff.byteIndex, 1);
  assert.equal(diff.referenceByte, 2);
  assert.equal(diff.candidateByte, 9);
});

void test("compareBytes reports a length mismatch", () => {
  const diff = compareBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]));
  assert.ok(diff !== null);
  assert.equal(diff.byteIndex, 2);
  assert.equal(diff.referenceByte, null);
  assert.equal(diff.candidateByte, 3);
});

void test("canonicalJsonBytes is insensitive to property insertion order", () => {
  const a = canonicalJsonBytes({ x: 1, y: 2 });
  const b = canonicalJsonBytes({ y: 2, x: 1 });
  assert.equal(compareBytes(a, b), null);
});

void test("Property: canonicalJsonBytes round-trips structurally-equal records identically", () => {
  // **Validates: Requirements 9.2**
  fc.assert(
    fc.property(
      fc.dictionary(fc.string(), fc.integer()),
      (record) => {
        const shuffled = Object.fromEntries(
          Object.entries(record).sort(() => (Math.random() < 0.5 ? -1 : 1)),
        );
        return compareBytes(canonicalJsonBytes(record), canonicalJsonBytes(shuffled)) === null;
      },
    ),
  );
});
