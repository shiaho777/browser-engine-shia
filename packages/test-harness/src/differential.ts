/**
 * Differential testing harness — naive full-recompute vs incremental, byte-for-byte
 * (design.md §9.1 / §9.2 Property 2; Requirements 9.2, 9.4, 13.4).
 *
 * The constitution's pragmatic-incrementality bet (design.md §7.1) is that a
 * deliberately slow "always recompute from scratch" backend and a true
 * incremental backend implement the **same** `Db` query interface and therefore
 * MUST produce identical output for every input-edit sequence. This module is
 * the permanent machine that proves it:
 *
 *     generate an input-edit sequence
 *       → apply the SAME sequence to two backends
 *       → render each backend's output to bytes
 *       → compare byte-for-byte
 *       → on ANY difference, report it so CI can block the merge.
 *
 * In Phase 0 the real incremental backend does not exist yet (it arrives in
 * task 5.9 and is wired in permanently in task 5.11). So this harness is built
 * against the kernel's `Db` *interface* and can diff **any two** `Db`
 * implementations: today we exercise it with two `NaiveDb` instances (and a
 * deliberately faulty `Db` double, to prove the difference detector actually
 * blocks); task 5.11 swaps in `naive` vs `incremental` with **no structural
 * change** — same `runDifferential(reference, candidate, edits, probe)` call.
 *
 * Diagnosis path (Requirement 13.4): when a difference is found the developer
 * diagnoses against the naive backend, which is exactly the `reference`
 * argument here. The returned {@link ByteDifference} pinpoints the first
 * diverging byte to anchor that investigation.
 */
import type { Db, InputSlot } from "@browser-engine/kernel";

// ---------------------------------------------------------------------------
// Inputs to the harness
// ---------------------------------------------------------------------------

/**
 * A factory that produces a *fresh* backend. The harness needs a clean state
 * per run (and one per side), so it takes factories rather than instances. In
 * Phase 0 this is `() => new NaiveDb()`; in task 5.11 the `candidate` side
 * becomes `() => new IncrementalDb()` with nothing else changing.
 */
export type DbFactory = () => Db;

/**
 * One input edit: write `value` into leaf input `input` at `key`. Type-erased
 * (`unknown`) so a single sequence can touch many differently-typed inputs;
 * {@link applyEdits} re-applies it through the `Db` interface. Edits are the
 * ONLY way to mutate state — there is no manual stale-marking surface
 * (design.md §7.1; Requirement 2.3).
 */
export interface InputEdit {
  readonly input: InputSlot<unknown, unknown>;
  readonly key: unknown;
  readonly value: unknown;
}

/**
 * Render a backend's observable output to a byte string. This mirrors Property
 * 2's `render(...)`: in Phase 0 it serialises a query result (see
 * {@link canonicalJsonBytes}); from Phase 1 it can render an actual PNG/display
 * list. Two backends are "equal" iff their probes return identical bytes.
 */
export type RenderProbe = (db: Db) => Uint8Array;

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * The first point at which two byte strings diverge — either a differing byte
 * or a length mismatch. `referenceByte` / `candidateByte` are `null` when one
 * side ran out of bytes (length mismatch). This is the artefact a developer
 * uses to diagnose against the naive backend (Requirement 13.4).
 */
export interface ByteDifference {
  /** Offset of the first divergence (or the shorter length on a size mismatch). */
  readonly byteIndex: number;
  readonly referenceLength: number;
  readonly candidateLength: number;
  /** Byte value on the reference side at `byteIndex`, or `null` if past its end. */
  readonly referenceByte: number | null;
  /** Byte value on the candidate side at `byteIndex`, or `null` if past its end. */
  readonly candidateByte: number | null;
  /** Human-readable summary for CI logs. */
  readonly message: string;
}

/** Outcome of diffing one edit sequence across the two backends. */
export interface DifferentialOutcome {
  /** True iff both backends rendered byte-for-byte identical output. */
  readonly identical: boolean;
  /** Number of edits applied to each backend before probing. */
  readonly editCount: number;
  /** The first divergence, or `null` when `identical` is true. */
  readonly difference: ByteDifference | null;
}

// ---------------------------------------------------------------------------
// Byte comparison
// ---------------------------------------------------------------------------

/**
 * Compare two byte strings. Returns `null` when they are byte-for-byte equal,
 * otherwise the first {@link ByteDifference}. This is the literal expression of
 * Requirement 9.2 ("byte-for-byte identical rendered output").
 */
export function compareBytes(
  reference: Uint8Array,
  candidate: Uint8Array,
): ByteDifference | null {
  const min = Math.min(reference.length, candidate.length);
  for (let i = 0; i < min; i++) {
    const r = reference[i];
    const c = candidate[i];
    if (r !== c) {
      return {
        byteIndex: i,
        referenceLength: reference.length,
        candidateLength: candidate.length,
        referenceByte: r ?? null,
        candidateByte: c ?? null,
        message: `byte ${i} differs: reference=0x${(r ?? 0).toString(16)} candidate=0x${(c ?? 0).toString(16)}`,
      };
    }
  }
  if (reference.length !== candidate.length) {
    return {
      byteIndex: min,
      referenceLength: reference.length,
      candidateLength: candidate.length,
      referenceByte: reference[min] ?? null,
      candidateByte: candidate[min] ?? null,
      message: `length mismatch: reference has ${reference.length} bytes, candidate has ${candidate.length}`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Canonical serialisation (default probe helper)
// ---------------------------------------------------------------------------

const ENCODER = new TextEncoder();

/**
 * Serialise a value to a *canonical* (key-sorted) JSON byte string, so that two
 * structurally-equal results always produce identical bytes regardless of
 * property insertion order. The default building block for a {@link RenderProbe}
 * until a real pixel/display-list renderer exists.
 */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  return ENCODER.encode(canonicalJson(value));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(",")}}`;
}

// ---------------------------------------------------------------------------
// The harness core
// ---------------------------------------------------------------------------

/** Replay an edit sequence against a backend through the `Db` interface. */
export function applyEdits(db: Db, edits: readonly InputEdit[]): void {
  for (const edit of edits) {
    db.setInput(edit.input, edit.key, edit.value);
  }
}

/**
 * Run ONE differential trial: spin up a fresh backend on each side, apply the
 * SAME `edits` to both, probe each to bytes, and compare.
 *
 * `reference` is the trusted full-recompute backend (the naive backend in task
 * 5.11); `candidate` is the backend under test (the incremental backend). The
 * symmetry is deliberate — swapping the candidate factory is the *only* change
 * task 5.11 needs.
 */
export function runDifferential(
  reference: DbFactory,
  candidate: DbFactory,
  edits: readonly InputEdit[],
  probe: RenderProbe,
): DifferentialOutcome {
  const referenceDb = reference();
  const candidateDb = candidate();

  applyEdits(referenceDb, edits);
  applyEdits(candidateDb, edits);

  const referenceBytes = probe(referenceDb);
  const candidateBytes = probe(candidateDb);

  const difference = compareBytes(referenceBytes, candidateBytes);
  return {
    identical: difference === null,
    editCount: edits.length,
    difference,
  };
}

// ---------------------------------------------------------------------------
// Campaign driver (generator-agnostic; the permanent CI entry point)
// ---------------------------------------------------------------------------

/**
 * Produces the edit sequence for trial `run`. Decoupled from any particular
 * generator so the harness works with a fast-check arbitrary's samples, a
 * seeded RNG, or hand-written regression sequences alike — this is the
 * "arbitrary edit-sequence generator" the task calls for.
 */
export type EditSequenceGenerator = (run: number) => readonly InputEdit[];

/** Result of a multi-trial campaign: the first failing trial, if any. */
export interface CampaignResult {
  /** How many trials were executed. */
  readonly runs: number;
  /** The first trial that diverged, or `null` if every trial matched. */
  readonly firstFailure: {
    readonly run: number;
    readonly edits: readonly InputEdit[];
    readonly outcome: DifferentialOutcome;
  } | null;
}

/**
 * Drive `runs` trials, stopping at the first divergence. Returns a structured
 * result rather than throwing, so callers can decide how to surface it; CI
 * typically pairs this with {@link assertCampaignClean} to fail the build
 * (Requirements 9.4, 13.4).
 */
export function runDifferentialCampaign(
  reference: DbFactory,
  candidate: DbFactory,
  probe: RenderProbe,
  generator: EditSequenceGenerator,
  runs: number,
): CampaignResult {
  for (let run = 0; run < runs; run++) {
    const edits = generator(run);
    const outcome = runDifferential(reference, candidate, edits, probe);
    if (!outcome.identical) {
      return { runs: run + 1, firstFailure: { run, edits, outcome } };
    }
  }
  return { runs, firstFailure: null };
}

// ---------------------------------------------------------------------------
// Blocking helpers (Requirements 9.4, 13.4)
// ---------------------------------------------------------------------------

/**
 * Thrown when the incremental backend diverges from the full-recompute
 * baseline. A thrown error is how the harness "blocks": an unhandled throw
 * fails the test process, which fails CI and blocks the merge (Requirements
 * 9.4, 13.4). Carries the diagnostic {@link ByteDifference}.
 */
export class DifferentialMismatchError extends Error {
  readonly difference: ByteDifference;
  readonly editCount: number;

  constructor(outcome: DifferentialOutcome) {
    if (outcome.difference === null) {
      throw new RangeError(
        "DifferentialMismatchError requires an outcome with a difference",
      );
    }
    super(
      `differential mismatch after ${outcome.editCount} edit(s): ${outcome.difference.message}. ` +
        `Diagnose against the reference (naive) backend.`,
    );
    this.name = "DifferentialMismatchError";
    this.difference = outcome.difference;
    this.editCount = outcome.editCount;
  }
}

/** Block (throw) if a single trial diverged; no-op when identical. */
export function assertDifferentialIdentical(outcome: DifferentialOutcome): void {
  if (!outcome.identical) {
    throw new DifferentialMismatchError(outcome);
  }
}

/** Block (throw) if any trial in a campaign diverged; no-op when all matched. */
export function assertCampaignClean(result: CampaignResult): void {
  if (result.firstFailure !== null) {
    throw new DifferentialMismatchError(result.firstFailure.outcome);
  }
}
