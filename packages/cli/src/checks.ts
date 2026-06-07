/**
 * Phase 0 constitution check gate (task 1.10; updated through task 3.10).
 *
 * design.md Phase 0 deliverable: "空管线能跑通'输入→各阶段空 IR→报错为
 * NotImplemented',CI 全绿". This module is the single place that *runs* the
 * pipeline as a constitution probe and aggregates the three check types into one
 * pass/fail status, exactly as CI consumes them:
 *
 *   1. WPT subset runner       — Requirement 10.1 (numerator source).
 *   2. reftest suite           — Requirement 10.4 (pixel comparison).
 *   3. differential harness    — Requirement 9.2 (naive vs incremental).
 *
 * plus the no-silent-stub invariant itself:
 *
 *   4. empty pipeline          — Requirements 12.5, 12.7: running the pipeline
 *      on an UNIMPLEMENTED capability must signal NotImplemented, NOT return a
 *      placeholder. A stage that returned a placeholder instead of throwing
 *      would fail THIS check (and `local/no-silent-stub` at lint time). Phase 0
 *      verified this on every (then-empty) stage; Phase 1 wires the stages up,
 *      so the probe now targets a capability the Phase 1 stages do not yet
 *      implement (a CSS at-rule), keeping the invariant genuinely tested as the
 *      pipeline fills in (Req 12.7).
 *
 * The honest Phase 1 reality (mirrors the existing scoreboard tests): the WPT
 * subset is empty (passCount 0, zero failures), there are no rendered outputs
 * yet so the reftest baseline set is empty, and the real incremental backend
 * does not exist yet so the differential harness compares naive-vs-naive. All
 * three pass, and the unimplemented-capability probe deterministically signals
 * NotImplemented — so the whole gate is green (Requirement 12.5).
 *
 * Requirement 12.6 (no commit → passing) is modelled by {@link statusForCommit}.
 */
import { isNotImplemented } from "@browser-engine/ir";
import { NaiveDb, type Db } from "@browser-engine/kernel";
import { checkWptRegression, runWptSubset, type WptSubset } from "@browser-engine/scoreboard";
import {
  canonicalJsonBytes,
  compareReftest,
  runDifferentialCampaign,
  type DbFactory,
  type InputEdit,
  type ReftestOptions,
  type RenderProbe,
} from "@browser-engine/test-harness";

import { qPaint, SourceBytes, type Url } from "./pipeline.js";
import { phase1Reftests } from "./phase1.js";
import { PHASE2_WPT_BASELINE, PHASE2_WPT_SUBSET } from "./phase2.js";

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/** One named check's verdict, with a human-readable detail for CI logs. */
export interface CheckResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

/** Aggregate of every configured Phase 0 check. */
export interface Phase0Status {
  /** True iff every configured check passed (Requirement 12.5). */
  readonly passed: boolean;
  readonly checks: readonly CheckResult[];
}

/** Commit-scoped status: whether checks ran, plus the aggregate verdict. */
export interface CommitStatus extends Phase0Status {
  /** False when no commit was submitted (Requirement 12.6). */
  readonly ran: boolean;
}

// ---------------------------------------------------------------------------
// Phase 0 configured check inputs (honest empty baselines)
// ---------------------------------------------------------------------------

/**
 * The honest-zero WPT subset (Requirement 10.1). This is the Phase 0 starting
 * point — an empty subset that passes with `passCount === 0`. The constitution
 * GATE ({@link runPhase0Checks}) now runs the Phase 2-4 subset
 * (`PHASE2_WPT_SUBSET` from `./phase2.ts`, task 5.12) so the scoreboard holds a
 * valid, larger pass count covering the three A-tier groups (Requirement 15.5);
 * this constant is retained as the documented empty baseline and as the default
 * for {@link checkWptSubset}.
 */
export const PHASE0_WPT_SUBSET: WptSubset = [];

/** A reftest baseline: a rendered PNG vs its reference within a threshold. */
export interface ReftestBaseline {
  readonly name: string;
  readonly rendered: Uint8Array;
  readonly reference: Uint8Array;
  readonly options?: ReftestOptions;
}

/**
 * The honest-zero reftest baselines (Requirement 10.4). Phase 0 had no rendered
 * output, so this set is empty (the suite passes vacuously) and remains the
 * default for {@link checkReftests}. The first REAL baseline
 * (`<div>hello</div>`) ships in task 3.12 and is run by the constitution GATE
 * ({@link runPhase0Checks}) via `phase1Reftests()` from `./phase1.ts`
 * (Requirement 14.3).
 */
export const PHASE0_REFTESTS: readonly ReftestBaseline[] = [];

/** The document address the unimplemented-capability probe drives. */
const PROBE_URL: Url = "phase0://empty";
/**
 * Source bytes for the probe. Phase 1 wires the whole pipeline end-to-end, so a
 * fully-supported document (`<div>hello</div>`) now renders to a real
 * DisplayList rather than throwing. To keep the *no-silent-stub* invariant
 * (Req 12.7) genuinely tested, the probe drives a document that still exercises
 * an UNIMPLEMENTED capability — a CSS at-rule (`@media`), which the Phase 1
 * minimal CSS parser signals `NotImplemented` for (task 3.3; the A-tier subset
 * lands in task 5.5). Running `qPaint` flows parse → cascade (→ qSheets) and
 * surfaces that loud failure, exactly as the constitution requires.
 */
const PROBE_BYTES: Uint8Array = new TextEncoder().encode(
  "<style>@media screen { div { color: red } }</style>",
);
/** How many differential trials to run for the probe. */
const DIFFERENTIAL_RUNS = 16;

// ---------------------------------------------------------------------------
// The no-silent-stub probe (shared by the differential + loud-failure checks)
// ---------------------------------------------------------------------------

/**
 * Render the probe's observable output to bytes. Running `qPaint` drives the
 * whole pipeline (paint → layout → dom → input); for the probe document (a CSS
 * at-rule) that surfaces a `NotImplemented`, which we serialise *deterministically*
 * so two backends agree byte-for-byte. A real (non-`NotImplemented`) return for
 * an unimplemented capability would be a placeholder — captured here as
 * `kind: "value"` so the loud-failure check can reject it.
 */
const emptyPipelineProbe: RenderProbe = (db: Db) => {
  try {
    const displayList = db.query(qPaint, PROBE_URL);
    return canonicalJsonBytes({ kind: "value", value: displayList });
  } catch (error: unknown) {
    if (isNotImplemented(error)) {
      return canonicalJsonBytes({
        kind: "not-implemented",
        feature: error.feature,
        category: error.category,
      });
    }
    throw error;
  }
};

const naiveFactory: DbFactory = () => new NaiveDb();

/** The single edit that seeds the pipeline's only leaf input. */
const probeEdits: readonly InputEdit[] = [
  { input: SourceBytes, key: PROBE_URL, value: PROBE_BYTES },
];

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

/**
 * No-silent-stub invariant (Requirements 12.5, 12.7): running the pipeline on an
 * unimplemented capability must signal `NotImplemented` — never return a
 * placeholder. Passing means the stage failed loudly, the EXPECTED green state.
 * (Phase 0 verified this on every stage; Phase 1 keeps verifying it on the
 * capabilities not yet implemented — Req 12.7.)
 */
export function checkEmptyPipeline(): CheckResult {
  const name = "empty-pipeline";
  const db = new NaiveDb();
  db.setInput(SourceBytes, PROBE_URL, PROBE_BYTES);
  try {
    db.query(qPaint, PROBE_URL);
    return {
      name,
      passed: false,
      detail:
        "pipeline returned a placeholder value instead of throwing NotImplemented (constitution violation)",
    };
  } catch (error: unknown) {
    if (isNotImplemented(error)) {
      return {
        name,
        passed: true,
        detail: `unimplemented capability signals NotImplemented as expected (${error.feature})`,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { name, passed: false, detail: `unexpected non-NotImplemented error: ${message}` };
  }
}

/**
 * WPT subset check (Requirement 10.1): run the configured subset and pass iff
 * no test failed. An empty subset passes with `passCount === 0`.
 */
export function checkWptSubset(subset: WptSubset = PHASE0_WPT_SUBSET): CheckResult {
  const summary = runWptSubset(subset);
  return {
    name: "wpt-subset",
    passed: summary.failCount === 0,
    detail: `${summary.passCount} passing / ${summary.total} total (${summary.failCount} failing)`,
  };
}

/**
 * WPT pass-count regression gate (Requirement 10.2): the forward-only
 * compatibility discipline. Run the configured subset and compare its live pass
 * count against the stored `baseline` through `checkWptRegression` (task 1.11);
 * a commit whose pass count drops BELOW the baseline is blocked (the check
 * fails), while a flat or higher count is allowed. This is the single place the
 * gate enforces "通过率回退的提交被阻断" for the Phase 2-4 subset.
 *
 * @param subset the configured WPT subset to measure (defaults to Phase 2-4).
 * @param baseline the stored forward-only baseline pass count to defend.
 */
export function checkWptRegressionGate(
  subset: WptSubset = PHASE2_WPT_SUBSET,
  baseline: number = PHASE2_WPT_BASELINE,
): CheckResult {
  const summary = runWptSubset(subset);
  const verdict = checkWptRegression(baseline, summary.passCount);
  return {
    name: "wpt-regression",
    // The gate PASSES when the merge is NOT blocked (no regression).
    passed: !verdict.blocked,
    detail: verdict.blocked
      ? `WPT pass count regressed: ${verdict.candidate} < baseline ${verdict.baseline} (Δ ${verdict.delta}) — merge blocked`
      : `WPT pass count ${verdict.candidate} ≥ baseline ${verdict.baseline} (Δ ${verdict.delta})`,
  };
}

/**
 * Reftest suite check (Requirement 10.4): every configured baseline must pass
 * its pixel comparison within the configured threshold. An empty baseline set
 * passes vacuously (Phase 0 has no rendered output yet).
 */
export function checkReftests(baselines: readonly ReftestBaseline[] = PHASE0_REFTESTS): CheckResult {
  let failing = 0;
  for (const baseline of baselines) {
    const result = compareReftest(baseline.rendered, baseline.reference, baseline.options ?? {});
    if (!result.pass) {
      failing += 1;
    }
  }
  return {
    name: "reftest-suite",
    passed: failing === 0,
    detail: `${baselines.length - failing} passing / ${baselines.length} baselines`,
  };
}

/**
 * Differential harness check (Requirement 9.2): replay the same input-edit
 * sequence through two backends and require byte-for-byte identical output. In
 * Phase 0 the real incremental backend does not exist (task 5.9), so both sides
 * are the naive backend; task 5.11 swaps the candidate factory with no other
 * change. The probe's deterministic NotImplemented signal makes both
 * sides agree.
 */
export function checkDifferential(): CheckResult {
  const result = runDifferentialCampaign(
    naiveFactory,
    naiveFactory,
    emptyPipelineProbe,
    () => probeEdits,
    DIFFERENTIAL_RUNS,
  );
  const passed = result.firstFailure === null;
  return {
    name: "differential-harness",
    passed,
    detail: passed
      ? `${result.runs} trials, naive vs naive byte-for-byte identical`
      : `divergence at trial ${result.firstFailure?.run}: ${result.firstFailure?.outcome.difference?.message ?? "unknown"}`,
  };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/**
 * Run every configured check and aggregate the verdict. Through Phase 2-4 (task
 * 5.12) the gate runs the A-tier artifacts so measured compatibility is a
 * genuine, larger number:
 *   - the Phase 2-4 WPT subset (`PHASE2_WPT_SUBSET`) — a meaningful set of
 *     checks driving the real stage code across the three configured groups
 *     (html-parsing + css-cascade + css-layout block/inline; Req 15.5);
 *   - the WPT pass-count REGRESSION gate (`checkWptRegressionGate`) — blocks a
 *     commit that lowers the pass count below the forward-only baseline
 *     (Req 10.2);
 *   - the real reftest baseline (`<div>hello</div>` vs its committed reference,
 *     Req 14.3).
 * The empty-pipeline invariant (unimplemented capability → NotImplemented) and
 * the differential harness still run, so the whole gate stays green while now
 * holding a valid Phase 2-4 pass count (Requirements 12.4, 12.5, 14.3, 15.5,
 * 10.2).
 */
export function runPhase0Checks(): Phase0Status {
  const checks: readonly CheckResult[] = [
    checkEmptyPipeline(),
    checkWptSubset(PHASE2_WPT_SUBSET),
    checkWptRegressionGate(),
    checkReftests(phase1Reftests()),
    checkDifferential(),
  ];
  return { passed: checks.every((c) => c.passed), checks };
}

/** A minimal commit handle — identity is all the status gate needs. */
export interface Commit {
  readonly id: string;
}

/**
 * Report the CI status for a (possibly absent) commit.
 *
 * Requirement 12.6: WHERE no commit is submitted, the pipeline reports a
 * passing status — there is nothing to invalidate the green baseline, so the
 * status stays passing with no checks run. When a commit IS submitted, the full
 * Phase 0 check gate runs (Requirements 12.4, 12.5).
 */
export function statusForCommit(commit: Commit | null): CommitStatus {
  if (commit === null) {
    return {
      passed: true,
      ran: false,
      checks: [],
    };
  }
  const status = runPhase0Checks();
  return { passed: status.passed, ran: true, checks: status.checks };
}

/** Format a {@link Phase0Status} for human-readable CI output. */
export function formatStatus(status: Phase0Status): string {
  const lines = status.checks.map(
    (c) => `  ${c.passed ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`,
  );
  const header = status.passed
    ? "Constitution check gate: all configured checks pass."
    : "Constitution checks FAILED.";
  return [header, ...lines].join("\n");
}
