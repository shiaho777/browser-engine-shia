/**
 * Render-pipeline stage tracing.
 *
 * This is the public proof surface for the engine's incremental thesis: every
 * render can report which query stages actually ran, which were served from the
 * cache, how much time they consumed, and how many immediate dependencies they
 * read. The collector lives in the CLI wiring layer, not inside parser/cascade/
 * layout/paint, so the stage packages remain pure functions over frozen IR.
 */
import type { QueryTraceEvent, QueryTraceObserver } from "@browser-engine/kernel";

/** The named pipeline stages the render/query graph exposes today. */
export type PipelineStage =
  | "qDom"
  | "qSheets"
  | "qComputed"
  | "qLayout"
  | "qPaint";

/** One traced query event with the query object stripped down to stable data. */
export interface StageTraceEvent {
  readonly stage: string;
  readonly key: unknown;
  readonly durationMs: number;
  readonly dependencyCount: number;
  readonly cacheStatus: "miss" | "hit" | "verified-hit";
}

/** Aggregate data for one stage/query name. */
export interface StageTraceSummary {
  readonly stage: string;
  readonly calls: number;
  readonly recomputes: number;
  readonly cacheHits: number;
  readonly verifiedCacheHits: number;
  readonly totalDurationMs: number;
  readonly maxDurationMs: number;
  readonly totalDependencyCount: number;
}

/** A complete trace for one render/probe. */
export interface StageTrace {
  readonly events: readonly StageTraceEvent[];
  readonly summaries: readonly StageTraceSummary[];
  readonly totalCalls: number;
  readonly totalRecomputes: number;
  readonly totalCacheHits: number;
  readonly totalDurationMs: number;
}

interface MutableSummary {
  stage: string;
  calls: number;
  recomputes: number;
  cacheHits: number;
  verifiedCacheHits: number;
  totalDurationMs: number;
  maxDurationMs: number;
  totalDependencyCount: number;
}

const PIPELINE_STAGE_ORDER: readonly PipelineStage[] = [
  "qDom",
  "qSheets",
  "qComputed",
  "qLayout",
  "qPaint",
];

/**
 * Collect read-only query events and turn them into a stable render trace. The
 * collector itself has no access to invalidation or memo state; it only observes
 * the events a kernel backend chooses to emit.
 */
export class StageTraceCollector {
  readonly #events: StageTraceEvent[] = [];

  /** Observer suitable for `new NaiveDb({ onQuery })` / `new IncrementalDb(...)`. */
  readonly onQuery: QueryTraceObserver = (event) => {
    this.#events.push(toStageEvent(event));
  };

  /** Snapshot the current trace. */
  trace(): StageTrace {
    const byStage = new Map<string, MutableSummary>();
    for (const event of this.#events) {
      let summary = byStage.get(event.stage);
      if (summary === undefined) {
        summary = {
          stage: event.stage,
          calls: 0,
          recomputes: 0,
          cacheHits: 0,
          verifiedCacheHits: 0,
          totalDurationMs: 0,
          maxDurationMs: 0,
          totalDependencyCount: 0,
        };
        byStage.set(event.stage, summary);
      }
      summary.calls += 1;
      summary.totalDurationMs += event.durationMs;
      summary.maxDurationMs = Math.max(summary.maxDurationMs, event.durationMs);
      summary.totalDependencyCount += event.dependencyCount;
      if (event.cacheStatus === "miss") {
        summary.recomputes += 1;
      } else if (event.cacheStatus === "verified-hit") {
        summary.cacheHits += 1;
        summary.verifiedCacheHits += 1;
      } else {
        summary.cacheHits += 1;
      }
    }

    const summaries = [...byStage.values()]
      .map(freezeSummary)
      .sort((a, b) => stageOrder(a.stage) - stageOrder(b.stage) || a.stage.localeCompare(b.stage));
    const totalCalls = summaries.reduce((sum, s) => sum + s.calls, 0);
    const totalRecomputes = summaries.reduce((sum, s) => sum + s.recomputes, 0);
    const totalCacheHits = summaries.reduce((sum, s) => sum + s.cacheHits, 0);
    const totalDurationMs = summaries.reduce((sum, s) => sum + s.totalDurationMs, 0);
    return Object.freeze({
      events: Object.freeze([...this.#events]),
      summaries: Object.freeze(summaries),
      totalCalls,
      totalRecomputes,
      totalCacheHits,
      totalDurationMs,
    });
  }
}

/** Convenience helper for one-shot tracing. */
export function createStageTraceCollector(): StageTraceCollector {
  return new StageTraceCollector();
}

function toStageEvent(event: QueryTraceEvent): StageTraceEvent {
  return Object.freeze({
    stage: event.queryName,
    key: event.key,
    durationMs: event.durationMs,
    dependencyCount: event.dependencyCount,
    cacheStatus: event.cacheStatus,
  });
}

function freezeSummary(summary: MutableSummary): StageTraceSummary {
  return Object.freeze({ ...summary });
}

function stageOrder(stage: string): number {
  const idx = PIPELINE_STAGE_ORDER.indexOf(stage as PipelineStage);
  return idx < 0 ? PIPELINE_STAGE_ORDER.length : idx;
}
