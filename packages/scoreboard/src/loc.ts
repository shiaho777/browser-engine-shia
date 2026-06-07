/**
 * Lines-of-code accounting for the North Star metric (design.md §1.3, §4;
 * Requirements 1.1, 1.2, 1.3).
 *
 * compat-per-LOC = (passing WPT subset tests) / (hand-written source lines).
 * The denominator is the project's whole point: it counts ONLY hand-written
 * lines and deliberately EXCLUDES Code_Generator output (Platform-as-Data, §4),
 * because the thing being optimised is "small, readable, hand-maintained
 * surface", not "small total system size". The honest counterpart (Req 1.3) is
 * that generated code is still code: when the Scoreboard reports *total* system
 * size it INCLUDES generator output.
 *
 * So we must be able to tell generated code apart from hand-written code. A
 * file is treated as generated when EITHER:
 *   - it lives under a `generated/` directory (any path segment named
 *     `generated`, case-insensitive), OR
 *   - it carries a generated marker comment (`@generated`) within its first
 *     few lines — the de-facto convention emitted by code generators.
 *
 * "Source line" here means a non-blank physical line. Blank lines are excluded
 * so trivial reformatting cannot move the metric; comment lines are counted as
 * code (a deliberately conservative choice that never *understates* the
 * hand-written surface). This definition is intentionally simple and is the
 * single place it lives.
 */

/** Whether a file's lines count toward the hand-written denominator. */
export type CodeOrigin = "hand-written" | "generated";

/** A source file to be measured: its path and full text content. */
export interface SourceFileInput {
  /** File path (POSIX or Windows separators accepted). */
  readonly path: string;
  /** Full text content of the file. */
  readonly content: string;
}

/** A file after classification and line counting. */
export interface ClassifiedFile {
  readonly path: string;
  readonly origin: CodeOrigin;
  /** Non-blank physical line count (see {@link countSourceLines}). */
  readonly lines: number;
}

/** Aggregate line counts split by origin (design.md §1.3; Req 1.2, 1.3). */
export interface LocTally {
  /** Hand-written lines — the compat-per-LOC denominator (Req 1.1, 1.2). */
  readonly handWritten: number;
  /** Generated lines — excluded from the denominator (Req 1.2). */
  readonly generated: number;
  /** Total system size = handWritten + generated (Req 1.3). */
  readonly total: number;
}

/** Marker comment emitted by code generators to flag a file as generated. */
const GENERATED_MARKER = /@generated\b/;

/** How many leading lines to scan for a {@link GENERATED_MARKER}. */
const MARKER_SCAN_LINES = 5;

/** Split text into physical lines, tolerant of LF, CRLF and lone CR. */
function toLines(content: string): readonly string[] {
  if (content.length === 0) {
    return [];
  }
  return content.split(/\r\n|\r|\n/);
}

/**
 * Count the source lines in `content`: every physical line that is not blank
 * (after trimming whitespace). An empty file counts as zero.
 */
export function countSourceLines(content: string): number {
  let count = 0;
  for (const line of toLines(content)) {
    if (line.trim().length > 0) {
      count += 1;
    }
  }
  return count;
}

/**
 * True when `path` sits under a `generated/` directory. The check is on path
 * *segments*, so it matches `pkg/generated/x.ts` and `generated/x.ts` but not a
 * hand-written file whose name merely contains the substring "generated"
 * (e.g. `generated-helpers.ts`).
 */
export function isGeneratedPath(path: string): boolean {
  const segments = path.split(/[\\/]+/);
  return segments.some((segment) => segment.toLowerCase() === "generated");
}

/** True when one of the first {@link MARKER_SCAN_LINES} lines is a generated marker. */
export function hasGeneratedMarker(content: string): boolean {
  const lines = toLines(content);
  const scanned = lines.slice(0, MARKER_SCAN_LINES);
  return scanned.some((line) => GENERATED_MARKER.test(line));
}

/**
 * Classify a file as generated or hand-written (design.md §4; Req 1.2). A file
 * is generated when it is either located under a `generated/` directory or
 * marked with a generated marker comment near the top.
 */
export function classifyOrigin(file: SourceFileInput): CodeOrigin {
  if (isGeneratedPath(file.path) || hasGeneratedMarker(file.content)) {
    return "generated";
  }
  return "hand-written";
}

/** Classify a single file and count its source lines. */
export function classifyFile(file: SourceFileInput): ClassifiedFile {
  return {
    path: file.path,
    origin: classifyOrigin(file),
    lines: countSourceLines(file.content),
  };
}

/**
 * Tally a set of files into hand-written / generated / total line counts
 * (Req 1.2, 1.3). Hand-written lines feed the compat-per-LOC denominator;
 * total includes generator output for the honest system-size report.
 */
export function tallyLoc(files: Iterable<SourceFileInput>): LocTally {
  let handWritten = 0;
  let generated = 0;
  for (const file of files) {
    const classified = classifyFile(file);
    if (classified.origin === "generated") {
      generated += classified.lines;
    } else {
      handWritten += classified.lines;
    }
  }
  return { handWritten, generated, total: handWritten + generated };
}
