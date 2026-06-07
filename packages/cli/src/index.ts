/**
 * @browser-engine/cli
 *
 * Command-line entry point and the pipeline *wiring layer*. The
 * `render <html> -o out.png` command drives the full parse → cascade → layout →
 * paint → **backend** pipeline (task 3.11; see `./render.ts`).
 *
 * Two invocation modes (dispatched in {@link runCli}):
 *   - `browser-engine render <input.html> -o <out.png>` — render a document to a
 *     PNG screenshot through the whole pipeline (Requirement 14.1).
 *   - `browser-engine` (no subcommand) — run the Phase 0 / constitution check
 *     gate and print its status (the historical default behaviour).
 *
 * Phase 0 (task 1.10): this package wires "input → each stage's IR" (see
 * `./pipeline.ts`) and aggregates the three constitution check types — WPT
 * subset, reftest suite, differential harness — plus the empty-pipeline
 * invariant into a single pass/fail gate (see `./checks.ts`). Running the gate
 * prints the status and exits non-zero only if a check fails, so CI can gate on
 * it. With the implemented Phase 1 stages and the empty WPT/reftest baselines,
 * the gate is green — the EXPECTED state (Requirement 12.5).
 */
export const PACKAGE_NAME = "@browser-engine/cli" as const;

// ---- §7.2 render-pipeline queries (wired, Phase 0 stages throw) -----------
export {
  qDom,
  qSheets,
  qComputed,
  qLayout,
  qPaint,
  SourceBytes,
  type NodeRef,
  type Url,
} from "./pipeline.js";

// ---- Phase 0 check gate (WPT + reftest + differential + empty pipeline) ----
export {
  checkDifferential,
  checkEmptyPipeline,
  checkReftests,
  checkWptSubset,
  checkWptRegressionGate,
  formatStatus,
  runPhase0Checks,
  statusForCommit,
  PHASE0_REFTESTS,
  PHASE0_WPT_SUBSET,
  type CheckResult,
  type Commit,
  type CommitStatus,
  type Phase0Status,
  type ReftestBaseline,
} from "./checks.js";

import { formatStatus, runPhase0Checks } from "./checks.js";
import { runRender } from "./render.js";

// ---- §3.11 render command (full parse → … → paint → backend → PNG) --------
export {
  renderHtmlToPng,
  renderFileToPng,
  renderUrlToPng,
  surfaceSizeFor,
  parseRenderArgs,
  runRender,
  DEFAULT_CANVAS_WIDTH,
  DEFAULT_CANVAS_HEIGHT,
  type RenderResult,
} from "./render.js";

export {
  collectStylesheets,
  type SheetLoader,
} from "./stylesheets.js";
export {
  collectImages,
  type ImageLoader,
} from "./images.js";
export {
  loadResources,
  discoverSubresources,
  resolveUrl,
  cacheLoader,
  defaultFetch,
  type FetchFn,
  type ResourceCache,
} from "./loader.js";

// ---- M3: the live document session (DOM mutation → incremental re-render) ---
export {
  LiveSession,
  LiveDom,
  qLiveSheets,
  qLiveComputed,
  qLiveLayout,
  qLivePaint,
  withText,
  withAttribute,
} from "./live.js";

// ---- M4: fine-grained incremental session (per-node inputs, O(changed) recalc) ---
export {
  FineSession,
  NodeStruct,
  NodeAttrs,
  DocRoot,
  qFineSheets,
  qFineComputed,
  qFineLayoutStyle,
  qFineLayout,
  qFinePaint,
} from "./fine.js";

// ---- M3.2: scripting bridge (real V8 JavaScript drives the DOM) ------------
export { runScript, buildDocumentApi, type ScriptResult } from "./script.js";

// ---- WPT testharness-compatible runner (real conformance format) -----------
export { runWptHarness, type WptReport, type WptSubtest } from "./wpt.js";

// ---- Official WPT suite importer (ingests a real wpt/ checkout) -------------
export {
  runWptHtml,
  runWptScriptFile,
  runWptDirectory,
  collectWptTests,
  extractScripts,
  type WptSuiteReport,
  type ResourceResolver,
} from "./wpt-suite.js";

// ---- Deterministic event loop + async fetch (real event-loop semantics) ----
export { runEventDriven, runEventDrivenReal, type EventDrivenRun } from "./event-loop.js";

// ---- UA + document stylesheet collection -----------------------------------
export { documentStylesheets, uaStylesheet } from "./stylesheets.js";

// ---- §3.12 Phase 1 vertical-slice fixtures (reftest baseline + scoreboard) -
// The `<div>hello</div>` reftest baseline (Req 14.3) and the first real WPT
// subset + scoreboard whose pass count is valid independent of display success
// (Req 14.4). The check gate (`runChecks`) runs these.
export {
  DIV_HELLO_SOURCE,
  DIV_HELLO_REFERENCE_PATH,
  PHASE1_CAPABILITIES,
  PHASE1_WPT_SUBSET,
  computePhase1Scoreboard,
  divHelloBaseline,
  loadDivHelloReference,
  phase1Reftests,
  renderDivHelloPng,
  type Phase1ScoreboardOptions,
} from "./phase1.js";

// ---- §5.12 Phase 2-4 WPT subset + configured threshold + regression gate ---
// The configured A-tier WPT subset (html-parsing + css-cascade + css-layout
// block/inline; Req 15.5), the configured target pass rate, the forward-only
// pass-count baseline (Req 10.2), and the Phase 2-4 scoreboard. The check gate
// (`runChecks`) runs this subset and the regression gate.
export {
  PHASE2_CAPABILITIES,
  PHASE2_GROUPS,
  PHASE2_GROUP_NAMES,
  PHASE2_WPT_SUBSET,
  PHASE2_TARGET_PASS_RATE,
  PHASE2_WPT_BASELINE,
  computePhase2Scoreboard,
  phase2PassRate,
  runPhase2WptSubset,
  type Phase2ScoreboardOptions,
} from "./phase2.js";

/**
 * Run the Phase 0 check gate and print a human-readable report. Returns the
 * process exit code: 0 when every configured check passes (the EXPECTED Phase 0
 * green state — Requirement 12.5), non-zero otherwise so CI fails loudly.
 */
export function runChecks(): number {
  const status = runPhase0Checks();
  console.log(formatStatus(status));
  return status.passed ? 0 : 1;
}

/**
 * Dispatch the CLI from its argument vector (the slice after `node dist/index.js`).
 * `render` drives the full screenshot pipeline (task 3.11); any other / no
 * subcommand runs the constitution check gate (the historical default).
 */
export async function runCli(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "render") {
    return runRender(rest);
  }
  return runChecks();
}

// Execute when invoked directly (the `browser-engine` bin / `node dist/index.js`).
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await runCli();
}
