/**
 * The Scoreboard: compat-per-LOC, capability reporting, and public publication
 * of the WPT pass count (design.md §1.3, §9; Requirements 1.1–1.6, 10.1, 10.3).
 *
 * It ties together the two halves of the North Star metric:
 *   - numerator  — passing WPT subset tests (from {@link runWptSubset});
 *   - denominator — hand-written source lines (from {@link tallyLoc}), which
 *     deliberately EXCLUDES Code_Generator output (Req 1.2). The honest total
 *     system size INCLUDES generator output (Req 1.3, via `LocTally.total`).
 *
 * It also decides capability status: a web-facing capability is reported as
 * NOT implemented unless it has a passing WPT test OR a passing reftest
 * (Req 1.4). And it publishes the pass count publicly (Req 10.3) in a way that
 * degrades gracefully — a CI/network publish failure must NOT block the commit
 * (Req 1.6).
 */
import { tallyLoc, type LocTally, type SourceFileInput } from "./loc.js";
import { runWptSubset, type WptRunSummary, type WptSubset } from "./wpt.js";

/** Implementation status of a single web-facing capability (Req 1.4). */
export type CapabilityStatus = "implemented" | "not-implemented";

/**
 * Reftest evidence for a capability: which capability a reftest covers and
 * whether it currently passes (design.md §9.1; Requirement 10.4 produces these
 * pass/fail verdicts elsewhere — here we only consume the verdict).
 */
export interface ReftestEvidence {
  readonly capability: string;
  readonly pass: boolean;
}

/** A capability and its computed implementation status, with the evidence. */
export interface CapabilityReport {
  readonly capability: string;
  readonly status: CapabilityStatus;
  /** True when a WPT test for this capability passed. */
  readonly hasPassingWpt: boolean;
  /** True when a reftest for this capability passed. */
  readonly hasPassingReftest: boolean;
}

/** The full, publishable scoreboard snapshot. */
export interface Scoreboard {
  /** Passing WPT subset tests — the metric numerator (Req 1.1). */
  readonly passCount: number;
  /** Hand-written / generated / total line counts (Req 1.2, 1.3). */
  readonly loc: LocTally;
  /**
   * compat-per-LOC = passCount / handWritten lines (Req 1.1). `null` when the
   * denominator is zero (undefined ratio) rather than a misleading 0 or ∞.
   */
  readonly compatPerLoc: number | null;
  /** Per-capability implementation status (Req 1.4). */
  readonly capabilities: readonly CapabilityReport[];
  /** The underlying WPT run summary the numbers were derived from. */
  readonly wpt: WptRunSummary;
}

/** Inputs needed to compute a {@link Scoreboard}. */
export interface ScoreboardInput {
  /** The configured WPT subset to run (Req 1.5, 10.1). */
  readonly wptSubset: WptSubset;
  /** Project source files to measure for the LOC denominator (Req 1.1, 1.2). */
  readonly sourceFiles: Iterable<SourceFileInput>;
  /**
   * Web-facing capabilities the engine claims to expose. Every one of these is
   * reported with a status; those lacking passing evidence are "not-implemented"
   * (Req 1.4).
   */
  readonly capabilities: readonly string[];
  /** Passing/failing reftest evidence, contributing to capability status. */
  readonly reftests?: readonly ReftestEvidence[];
}

/**
 * Compute compat-per-LOC. Returns `null` for a zero denominator so callers can
 * distinguish "no hand-written code yet" from a real ratio of zero.
 */
export function computeCompatPerLoc(passCount: number, handWrittenLines: number): number | null {
  if (handWrittenLines <= 0) {
    return null;
  }
  return passCount / handWrittenLines;
}

/**
 * Report each capability's implementation status (Requirement 1.4). A
 * capability is "implemented" only when it has a passing WPT test OR a passing
 * reftest; otherwise it is "not-implemented". Capabilities are de-duplicated and
 * reported in first-seen order.
 */
export function reportCapabilities(
  capabilities: readonly string[],
  passingWptCapabilities: ReadonlySet<string>,
  reftests: readonly ReftestEvidence[] = [],
): readonly CapabilityReport[] {
  const passingReftestCapabilities = new Set<string>();
  for (const evidence of reftests) {
    if (evidence.pass) {
      passingReftestCapabilities.add(evidence.capability);
    }
  }

  const reports: CapabilityReport[] = [];
  const seen = new Set<string>();
  for (const capability of capabilities) {
    if (seen.has(capability)) {
      continue;
    }
    seen.add(capability);

    const hasPassingWpt = passingWptCapabilities.has(capability);
    const hasPassingReftest = passingReftestCapabilities.has(capability);
    reports.push({
      capability,
      hasPassingWpt,
      hasPassingReftest,
      status: hasPassingWpt || hasPassingReftest ? "implemented" : "not-implemented",
    });
  }
  return reports;
}

/**
 * Run the configured WPT subset and assemble the full scoreboard snapshot
 * (Requirements 1.1–1.4, 1.5, 10.1). Pure and side-effect free: publishing is a
 * separate, fallible step (see {@link publishScoreboard}).
 */
export function computeScoreboard(input: ScoreboardInput): Scoreboard {
  const wpt = runWptSubset(input.wptSubset);
  const loc = tallyLoc(input.sourceFiles);
  const compatPerLoc = computeCompatPerLoc(wpt.passCount, loc.handWritten);
  const capabilities = reportCapabilities(
    input.capabilities,
    wpt.passingCapabilities,
    input.reftests ?? [],
  );
  return { passCount: wpt.passCount, loc, compatPerLoc, capabilities, wpt };
}

/** Sink that publishes the pass count publicly (Req 10.3); may fail in CI. */
export type ScoreboardPublisher = (scoreboard: Scoreboard) => void | Promise<void>;

/** Result of an attempt to publish the scoreboard (Req 1.6, 10.3). */
export interface PublishResult {
  /** Whether publication succeeded. */
  readonly published: boolean;
  /**
   * Always `true`: a commit is allowed to proceed regardless of whether
   * publishing succeeded (Requirement 1.6). Surfaced explicitly so the CI
   * pipeline can assert it.
   */
  readonly commitAllowed: true;
  /** The publish failure reason, when `published === false`. */
  readonly error?: string;
}

/** Render an unknown thrown value as a stable, human-readable string. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Publish the scoreboard's WPT pass count publicly (Requirement 10.3), allowing
 * the commit to proceed even if publication fails due to a CI/network error
 * (Requirement 1.6).
 *
 * This NEVER throws and NEVER blocks: a publisher that throws (or rejects) is
 * caught, recorded as a non-fatal `error`, and the commit is still allowed. A
 * successful publish reports `published: true`.
 */
export async function publishScoreboard(
  scoreboard: Scoreboard,
  publish: ScoreboardPublisher,
): Promise<PublishResult> {
  try {
    await publish(scoreboard);
    return { published: true, commitAllowed: true };
  } catch (error: unknown) {
    // CI/network failure to publish must not block the commit (Req 1.6).
    return { published: false, commitAllowed: true, error: describeError(error) };
  }
}
