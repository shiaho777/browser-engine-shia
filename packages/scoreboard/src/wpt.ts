/**
 * WPT subset runner prototype + pass-count statistics (design.md §9.1;
 * Requirements 1.5, 10.1, 10.3).
 *
 * The North Star metric's *numerator* is "passing WPT subset tests". This
 * module is the real pass-counter: it executes a configured subset of Web
 * Platform Tests and tallies how many pass. In Phase 0 the engine has no real
 * web-facing capabilities yet, so the configured subset is empty/placeholder —
 * but the counting logic is real, total, and tested, ready to receive actual
 * tests as later Phases add capabilities.
 *
 * Test model (mirrors how a WPT testharness test reports): a test PASSES when
 * its `run` completes without throwing (or explicitly returns `true`), and
 * FAILS when it throws (an assertion failure, or a `NotImplemented` raised by
 * an unimplemented path — design.md §12) or explicitly returns `false`. A
 * thrown error is captured as the failure reason rather than propagated, so one
 * failing test never aborts the whole subset run.
 */

/** Pass/fail verdict for a single WPT test. */
export type WptVerdict = "pass" | "fail";

/**
 * One executable WPT subset test. `run` asserts the behaviour under test:
 *   - completing normally (or returning `true`) ⇒ pass;
 *   - throwing, or returning `false` ⇒ fail.
 */
export interface WptTestCase {
  /** Stable identifier for the test (e.g. the WPT path). */
  readonly id: string;
  /**
   * The web-facing capability this test exercises. Used by the Scoreboard to
   * decide whether a capability has passing evidence (Requirement 1.4).
   */
  readonly capability: string;
  /** Execute the test. Throw or return `false` to fail; otherwise it passes. */
  readonly run: () => boolean | void;
}

/** A configured WPT subset: the set of tests CI runs on every commit. */
export type WptSubset = readonly WptTestCase[];

/** Outcome of running a single {@link WptTestCase}. */
export interface WptTestResult {
  readonly id: string;
  readonly capability: string;
  readonly verdict: WptVerdict;
  /** Failure reason when `verdict === "fail"` and the cause was a throw. */
  readonly error?: string;
}

/** Aggregate result of running a whole {@link WptSubset}. */
export interface WptRunSummary {
  /** Number of tests in the subset. */
  readonly total: number;
  /** Number of tests that passed — the compat-per-LOC numerator (Req 1.1). */
  readonly passCount: number;
  /** Number of tests that failed. */
  readonly failCount: number;
  /** Per-test results, in subset order. */
  readonly results: readonly WptTestResult[];
  /** Capabilities with at least one passing test (Requirement 1.4). */
  readonly passingCapabilities: ReadonlySet<string>;
}

/** Render an unknown thrown value as a stable, human-readable string. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Run one test case, converting a thrown error or a `false` return into a
 * `"fail"` verdict. Never throws.
 */
export function runWptTest(test: WptTestCase): WptTestResult {
  try {
    const returned = test.run();
    if (returned === false) {
      return { id: test.id, capability: test.capability, verdict: "fail" };
    }
    return { id: test.id, capability: test.capability, verdict: "pass" };
  } catch (error: unknown) {
    return {
      id: test.id,
      capability: test.capability,
      verdict: "fail",
      error: describeError(error),
    };
  }
}

/**
 * Run a configured WPT subset and tally the passes (Requirements 1.5, 10.1).
 *
 * The pass count is the metric's numerator. An empty subset yields a summary
 * with `passCount === 0` (the honest Phase 0 starting point), and no run ever
 * throws regardless of how individual tests behave.
 */
export function runWptSubset(subset: WptSubset): WptRunSummary {
  const results: WptTestResult[] = [];
  const passingCapabilities = new Set<string>();
  let passCount = 0;

  for (const test of subset) {
    const result = runWptTest(test);
    results.push(result);
    if (result.verdict === "pass") {
      passCount += 1;
      passingCapabilities.add(result.capability);
    }
  }

  return {
    total: subset.length,
    passCount,
    failCount: subset.length - passCount,
    results,
    passingCapabilities,
  };
}
