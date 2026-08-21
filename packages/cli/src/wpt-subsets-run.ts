/**
 * CLI wrapper for maintained WPT subset manifests.
 */
import path from "node:path";

import { formatStageTrace } from "./render.js";
import {
  defaultWptSubsetDir,
  runWptSubsetManifestDir,
  type WptSubsetManifestRun,
  type WptSubsetManifestRunSummary,
} from "./wpt-manifest.js";

/** Parsed args for `wpt-subsets [manifest-dir] [--wpt-root path] [--json]`. */
export interface WptSubsetCommandArgs {
  readonly manifestDir: string;
  readonly wptRootOverride?: string;
  readonly json: boolean;
  readonly trace: boolean;
}

/** Parse the `wpt-subsets` command line. */
export function parseWptSubsetArgs(argv: readonly string[]): WptSubsetCommandArgs {
  let manifestDir: string | undefined;
  let wptRootOverride: string | undefined;
  let json = false;
  let trace = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--trace") {
      trace = true;
      continue;
    }
    if (arg === "--wpt-root") {
      const raw = argv[i + 1];
      if (raw === undefined) {
        throw new Error("wpt-subsets: --wpt-root requires a path");
      }
      wptRootOverride = path.resolve(raw);
      i += 1;
      continue;
    }
    if (arg !== undefined && arg.startsWith("-")) {
      throw new Error(`wpt-subsets: unknown option ${arg}`);
    }
    manifestDir ??= arg;
  }

  const parsed: WptSubsetCommandArgs = {
    manifestDir: path.resolve(manifestDir ?? defaultWptSubsetDir()),
    json,
    trace,
  };
  return wptRootOverride === undefined ? parsed : { ...parsed, wptRootOverride };
}

/** Run every maintained WPT subset manifest and return a process exit code. */
export async function runWptSubsetsCommand(argv: readonly string[]): Promise<number> {
  let args: WptSubsetCommandArgs;
  try {
    args = parseWptSubsetArgs(argv);
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("usage: wpt-subsets [manifest-dir] [--wpt-root path] [--json]");
    return 1;
  }

  try {
    const options = {
      ...(args.wptRootOverride === undefined ? {} : { wptRootOverride: args.wptRootOverride }),
      ...(args.trace ? { trace: true } : {}),
    };
    const summary = await runWptSubsetManifestDir(args.manifestDir, options);
    if (args.json) {
      console.log(JSON.stringify(serializableSummary(summary), null, 2));
    } else {
      console.log(formatWptSubsetSummary(summary));
    }
    return summary.passedGate ? 0 : 1;
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

/** Human-readable maintained-subset report. */
export function formatWptSubsetSummary(summary: WptSubsetManifestRunSummary): string {
  const lines: string[] = [
    `WPT subset manifests: ${summary.manifestDir}`,
    `subsets: ${summary.runs.length}`,
    `gate: ${summary.passedGate ? "PASS" : "FAIL"}`,
  ];

  for (const run of summary.runs) {
    lines.push(formatRunLine(run));
    if (run.regression.blocked) {
      lines.push(
        `  regression: candidate ${String(run.regression.candidate)} < baseline ${String(run.regression.baseline)}`,
      );
    }
    if (run.report.trace !== undefined) {
      lines.push(indent(formatStageTrace(run.report.trace), "  "));
    }
  }

  return lines.join("\n");
}

function formatRunLine(run: WptSubsetManifestRun): string {
  return [
    `- ${run.manifest.name}`,
    `owner=${run.manifest.owner}`,
    `files=${String(run.report.files)}`,
    `subtests=${String(run.report.subtests)}`,
    `passed=${String(run.report.passed)}`,
    `failed=${String(run.report.failed)}`,
    `errored=${String(run.report.errored)}`,
    `baseline=${String(run.manifest.baselinePassCount)}`,
    `delta=${String(run.regression.delta)}`,
    `gate=${run.passedGate ? "PASS" : "FAIL"}`,
  ].join(" ");
}

function serializableSummary(summary: WptSubsetManifestRunSummary): object {
  return {
    manifestDir: summary.manifestDir,
    passedGate: summary.passedGate,
    runs: summary.runs.map((run) => ({
      manifest: run.manifest,
      root: run.root,
      regression: run.regression,
      passedGate: run.passedGate,
      report: {
        files: run.report.files,
        subtests: run.report.subtests,
        passed: run.report.passed,
        failed: run.report.failed,
        errored: run.report.errored,
        trace: run.report.trace,
        byFile: Object.fromEntries(run.report.byFile),
      },
    })),
  };
}

function indent(text: string, prefix: string): string {
  return text.split("\n").map((line) => `${prefix}${line}`).join("\n");
}
