/**
 * Competitor_Registry — cited competitor (Chromium / Chrome) data points
 * (compete-with-google-benchmark spec; Requirement 2).
 *
 * The honesty rule that governs this whole battle: every competitor number is a
 * CITED reference snapshot, never a re-run and never invented. Each datum
 * carries its source name, URL, as-of date, methodology, and a confidence
 * marker. A metric we cannot source is recorded with `value: null` and
 * confidence `needs-source` — surfaced in the report as a gap to fill, NOT
 * faked. We never re-run a Chromium benchmark.
 */

/** How trustworthy a competitor data point is. */
export type Confidence = "verified" | "cited" | "order-of-magnitude" | "needs-source";

/** One cited competitor fact. */
export interface CompetitorDatum {
  /** The competitor engine/product. */
  readonly engine: string;
  /** A stable metric id this datum reports (joins to a benchmark dimension). */
  readonly metric: string;
  /** The numeric value, or `null` when no citation could be obtained. */
  readonly value: number | null;
  /** The unit of `value` (e.g. "lines", "%", "count"). */
  readonly unit: string;
  /** Human-readable source name. */
  readonly sourceName: string;
  /** Verifiable source URL (empty only when confidence is needs-source). */
  readonly sourceUrl: string;
  /** When the figure was published / collected (ISO date or year). */
  readonly asOf: string;
  /** How the figure was measured / what its scope is. */
  readonly methodology: string;
  /** Confidence in the figure. */
  readonly confidence: Confidence;
}

/**
 * The cited competitor facts. Two are backed by real, checkable citations; the
 * rest are deliberately recorded as `needs-source` (value `null`) so the report
 * shows them as honest gaps rather than fabricating numbers.
 *
 * Sources (checkable):
 *   - Chromium source size: Wikipedia "Chromium (web browser)".
 *   - Interop 2024 pass rate: WebKit blog "The success of Interop 2024".
 */
export const COMPETITORS: readonly CompetitorDatum[] = [
  {
    engine: "Chromium / Chrome",
    metric: "hand-written-lines",
    value: 36_000_000,
    unit: "lines",
    sourceName: "Wikipedia — Chromium (web browser)",
    sourceUrl: "https://en.wikipedia.org/wiki/Chromium_(web_browser)",
    asOf: "2025",
    methodology:
      "Reported as 'over 36 million source lines of code, excluding comments and blank lines' for the whole Chromium codebase (not just the rendering engine).",
    confidence: "cited",
  },
  {
    engine: "Chromium / Chrome",
    metric: "wpt-interop-pass-rate",
    value: 95,
    unit: "%",
    sourceName: "WebKit blog — The success of Interop 2024",
    sourceUrl: "https://webkit.org/blog/16413/the-success-of-interop-2024/",
    asOf: "2024-12",
    methodology:
      "Interop 2024: ~95% of the Interop test set passed in Chrome 131 (and Edge 131, Firefox 133, Safari 18.2) by end of Dec 2024. This is the curated Interop focus-area set, not all of WPT.",
    confidence: "cited",
  },
  {
    engine: "Chromium / Chrome",
    metric: "compat-per-loc",
    value: null,
    unit: "passes/line",
    sourceName: "",
    sourceUrl: "",
    asOf: "",
    methodology:
      "No published figure expresses Chromium compatibility per hand-written line; deriving one requires a common WPT pass-count numerator over its ~36M-line denominator. Recorded as needs-source rather than invented.",
    confidence: "needs-source",
  },
  {
    engine: "Chromium / Chrome",
    metric: "runtime-performance-speedometer",
    value: null,
    unit: "runs/min",
    sourceName: "",
    sourceUrl: "",
    asOf: "",
    methodology:
      "Speedometer scores are hardware- and version-specific and must be measured on identical hardware to be comparable. We have no co-located Chromium run, so no honest head-to-head number exists here.",
    confidence: "needs-source",
  },
];

/** Look up a competitor datum by its metric id, or `undefined`. */
export function competitorFor(metric: string): CompetitorDatum | undefined {
  return COMPETITORS.find((d) => d.metric === metric);
}
