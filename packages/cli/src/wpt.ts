/**
 * wpt.ts — a real `testharness.js`-compatible runner for INLINE source.
 *
 * A WPT "testharness" test is plain JavaScript that calls `test(fn, name)` and
 * the `assert_*` family, reporting per-subtest PASS/FAIL. This runs that on real
 * V8 (`node:vm`), bound to the engine's live DOM surface ({@link
 * buildDocumentApi}), sharing the ONE assertion implementation in
 * {@link createAssertions}. The HTML-file / directory importer that ingests an
 * actual WPT checkout lives in {@link import("./wpt-suite.js")}.
 */
import vm from "node:vm";

import { FineSession } from "./fine.js";
import { buildDocumentApi } from "./script.js";
import { createAssertions, WptAssertionError } from "./testharness.js";
import type { StageTrace } from "./stage-trace.js";

/** A single subtest's outcome, mirroring testharness statuses. */
export interface WptSubtest {
  readonly name: string;
  readonly status: "PASS" | "FAIL" | "ERROR";
  readonly message: string | null;
}

/** The aggregate result of running a WPT testharness file. */
export interface WptReport {
  readonly subtests: readonly WptSubtest[];
  readonly passed: number;
  readonly failed: number;
  /** A harness-level error (e.g. the script threw before any test ran). */
  readonly harnessError: string | null;
  /** Optional query trace evidence for WPT runs that ask for it. */
  readonly trace?: StageTrace;
  /** Trace/render evidence failure, kept separate from WPT harness scoring. */
  readonly traceError?: string;
}

/**
 * Run a WPT testharness `source` against a document parsed from `html`. Returns
 * the per-subtest PASS/FAIL report. The script sees a real `document` surface
 * and the standard `test` / `assert_*` harness globals, executed on V8.
 */
export function runWptHarness(html: string, source: string): WptReport {
  const session = new FineSession(html);
  const { document, globals } = buildDocumentApi(session);
  const subtests: WptSubtest[] = [];

  const sandbox: Record<string, unknown> = { document, ...globals, ...buildSyncHarness(subtests) };
  sandbox["self"] = sandbox;
  sandbox["globalThis"] = sandbox;

  let harnessError: string | null = null;
  try {
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { timeout: 2000 });
  } catch (error) {
    harnessError = error instanceof Error ? error.message : String(error);
  }

  const passed = subtests.filter((t) => t.status === "PASS").length;
  const failed = subtests.length - passed;
  return { subtests, passed, failed, harnessError };
}

/** The synchronous `test()` harness + the shared `assert_*` family. */
function buildSyncHarness(subtests: WptSubtest[]): Record<string, unknown> {
  const record = (name: string, body: () => void): void => {
    try {
      body();
      subtests.push({ name, status: "PASS", message: null });
    } catch (error) {
      if (error instanceof WptAssertionError) {
        subtests.push({ name, status: "FAIL", message: error.message });
      } else {
        subtests.push({ name, status: "ERROR", message: error instanceof Error ? error.message : String(error) });
      }
    }
  };
  return {
    ...createAssertions(),
    test(func: unknown, name: unknown): void {
      if (typeof func !== "function") return;
      record(typeof name === "string" ? name : "(unnamed test)", () => (func as () => void)());
    },
    setup(): void {
      /* options ignored in the sync runner */
    },
    done(): void {
      /* no-op for synchronous tests */
    },
  };
}
