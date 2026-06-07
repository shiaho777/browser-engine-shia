/**
 * Progressive per-Phase WPT pass-rate thresholds — the "逐 9 递进" gate
 * (task 9.6; design.md §5 "每个 9 约花一个数量级力气"; Requirement 17.5).
 *
 * Requirement 17.5: "WHEN a successive WPT pass-rate target ('9') is configured
 * for a Phase, THE WPT subset pass rate SHALL meet or exceed that configured
 * threshold." design.md §3.2 / §14 note that the per-Phase target percentages
 * are CONFIGURABLE open values; this module is the single place they live, as an
 * ascending ladder of "nines":
 *
 *   Phase 1   (vertical slice)  → a real, small number (a "0.x" — just > 0)
 *   Phase 2-4 (A 档)            → the first "9"  (≈ 0.9 of its configured subset)
 *   Phase 5-7 (B 档)            → the second "9" (≈ 0.99)
 *   Phase 8+  (C 档)            → 三个 9 及以上 (≈ 0.999+)
 *
 * Each Phase's CONFIGURED subset (`./phase1.ts`, `./phase2.ts`, `./phase3.ts`)
 * is authored to match the engine's real behaviour, so the engine genuinely
 * passes 100% of each subset — comfortably meeting its (lower) configured
 * threshold. The threshold is expressed against the configured subset (the
 * compat *numerator's* denominator), exactly as Requirements 15.5 / 16.x phrase
 * it, NOT against all of WPT.
 *
 * Two checks live here, both pure decision points CI consults:
 *   1. {@link checkPhaseThreshold} — the live pass rate meets/exceeds the
 *      configured Phase target (Requirement 17.5);
 *   2. {@link checkProgressiveThresholds} — the configured targets are a
 *      MONOTONICALLY non-decreasing ladder (each "9" ≥ the previous), so the
 *      progression itself can never silently regress.
 *
 * The cli is an orchestration layer, so it may import the phase subsets + the
 * scoreboard runner to compose the gate here.
 */
import { runWptSubset, type WptSubset } from "@browser-engine/scoreboard";

import { PHASE1_WPT_SUBSET } from "./phase1.js";
import { PHASE2_WPT_SUBSET } from "./phase2.js";
import { PHASE3_WPT_SUBSET } from "./phase3.js";

/** A configured Phase: its name, WPT subset, and "9"-ladder target pass rate. */
export interface PhaseTarget {
  /** Human-readable phase id (e.g. "phase-2-4 / A 档"). */
  readonly id: string;
  /** The configured WPT subset whose pass rate is measured. */
  readonly subset: WptSubset;
  /**
   * The configured target pass RATE (0..1) — the Phase's "9". The live rate must
   * meet or exceed it (Requirement 17.5). Ascending across phases (the ladder).
   */
  readonly targetPassRate: number;
}

/**
 * The configured "逐 9" ladder, one rung per Phase. The targets are an ascending
 * sequence of nines (0.x → 0.9 → 0.99 → 0.999); each Phase's authored subset
 * passes 100%, so the engine clears every rung. Tune a rung in ONE place here.
 */
export const PHASE_TARGETS: readonly PhaseTarget[] = [
  { id: "phase-1 / vertical-slice", subset: PHASE1_WPT_SUBSET, targetPassRate: 0.1 },
  { id: "phase-2-4 / A-tier", subset: PHASE2_WPT_SUBSET, targetPassRate: 0.9 },
  { id: "phase-5-7 / B-tier", subset: PHASE3_WPT_SUBSET, targetPassRate: 0.99 },
  // Phase 8+ (C 档) reuses the B-tier subset as its measured base for now, with
  // the configured "three nines" target; as C-tier WPT groups are added their
  // subset slots in here without changing the gate.
  { id: "phase-8 / C-tier", subset: PHASE3_WPT_SUBSET, targetPassRate: 0.999 },
] as const;

/** The verdict of a single Phase threshold check (Requirement 17.5). */
export interface PhaseThresholdResult {
  readonly id: string;
  /** The live pass rate (passing / total) of the Phase's subset. */
  readonly passRate: number;
  /** The configured "9" target the rate is compared against. */
  readonly target: number;
  /** Number of passing / total tests behind the rate (for CI logs). */
  readonly passCount: number;
  readonly total: number;
  /**
   * True iff the live rate MEETS OR EXCEEDS the configured target (Req 17.5).
   * False ⇒ the Phase regressed below its configured "9" and CI must block.
   */
  readonly meetsTarget: boolean;
}

/**
 * Run a Phase's configured subset and decide whether its live pass rate meets or
 * exceeds the configured "9" target (Requirement 17.5). An empty subset has a
 * vacuous rate of 1 (meets any target ≤ 1). Pure / side-effect free.
 */
export function checkPhaseThreshold(target: PhaseTarget): PhaseThresholdResult {
  const summary = runWptSubset(target.subset);
  const passRate = summary.total === 0 ? 1 : summary.passCount / summary.total;
  return {
    id: target.id,
    passRate,
    target: target.targetPassRate,
    passCount: summary.passCount,
    total: summary.total,
    // Use a tiny epsilon so floating-point equality (e.g. 0.99 === 0.99) is not
    // tripped by representation error.
    meetsTarget: passRate >= target.targetPassRate - 1e-9,
  };
}

/** The verdict of checking every configured Phase against its target. */
export interface ProgressiveThresholdResult {
  /** Per-Phase results, in ladder order. */
  readonly phases: readonly PhaseThresholdResult[];
  /** True iff EVERY Phase meets its configured target (Requirement 17.5). */
  readonly allMet: boolean;
  /**
   * True iff the configured targets form a MONOTONICALLY non-decreasing ladder
   * (each "9" ≥ the previous). A broken ladder is a configuration error.
   */
  readonly ladderMonotonic: boolean;
}

/**
 * Check the whole "逐 9" ladder: every Phase's live rate meets its configured
 * target, AND the configured targets ascend monotonically (each rung ≥ the
 * previous). This is the single gate CI consults for Requirement 17.5.
 */
export function checkProgressiveThresholds(
  targets: readonly PhaseTarget[] = PHASE_TARGETS,
): ProgressiveThresholdResult {
  const phases = targets.map((t) => checkPhaseThreshold(t));
  let ladderMonotonic = true;
  for (let i = 1; i < targets.length; i += 1) {
    if (targets[i]!.targetPassRate < targets[i - 1]!.targetPassRate - 1e-9) {
      ladderMonotonic = false;
      break;
    }
  }
  return {
    phases,
    allMet: phases.every((p) => p.meetsTarget),
    ladderMonotonic,
  };
}
