/**
 * CLI wrapper for the official-WPT importer.
 *
 * The importer itself lives in `wpt-suite.ts`; this module turns it into a root
 * workflow command: `npm run wpt -- [wpt-root] [--limit N] [--json]`.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runWptDirectory, type WptSuiteReport } from "./wpt-suite.js";

/** Parsed arguments for the `wpt` subcommand. */
export interface WptCommandArgs {
  readonly root: string;
  readonly limit: number;
  readonly json: boolean;
}

const DEFAULT_FIXTURE_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "wpt-fixtures",
);

/**
 * Parse `wpt [root] [--limit N] [--json]`.
 *
 * With no root, the command runs the vendored WPT-format fixtures so the
 * workflow is always runnable after clone/install. A real WPT checkout or
 * subdirectory can be supplied as the first positional argument.
 */
export function parseWptArgs(argv: readonly string[]): WptCommandArgs {
  let root: string | undefined;
  let limit = Infinity;
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--limit") {
      const raw = argv[i + 1];
      if (raw === undefined) {
        throw new Error("wpt: --limit requires a positive number");
      }
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`wpt: invalid --limit value ${JSON.stringify(raw)}`);
      }
      limit = Math.floor(parsed);
      i += 1;
      continue;
    }
    if (arg !== undefined && arg.startsWith("-")) {
      throw new Error(`wpt: unknown option ${arg}`);
    }
    root ??= arg;
  }

  return {
    root: path.resolve(root ?? DEFAULT_FIXTURE_ROOT),
    limit,
    json,
  };
}

/** Run the `wpt` subcommand and return a process exit code. */
export async function runWptCommand(argv: readonly string[]): Promise<number> {
  let args: WptCommandArgs;
  try {
    args = parseWptArgs(argv);
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("usage: wpt [wpt-root] [--limit N] [--json]");
    return 1;
  }

  try {
    const report = await runWptDirectory(args.root, args.limit);
    if (args.json) {
      console.log(JSON.stringify(serializableReport(report), null, 2));
    } else {
      console.log(formatWptReport(args.root, report));
    }
    return report.files > 0 && report.failed === 0 && report.errored === 0 ? 0 : 1;
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

/** Human-readable report for terminal use. */
export function formatWptReport(root: string, report: WptSuiteReport): string {
  const lines: string[] = [
    `WPT root: ${root}`,
    `files: ${report.files}`,
    `subtests: ${report.subtests}`,
    `passed: ${report.passed}`,
    `failed: ${report.failed}`,
    `errored: ${report.errored}`,
  ];

  const failingFiles = [...report.byFile.entries()].filter(([, file]) => file.failed > 0 || file.harnessError !== null);
  if (failingFiles.length > 0) {
    lines.push("", "Failing files:");
    for (const [file, fileReport] of failingFiles.slice(0, 20)) {
      const errored = fileReport.subtests.filter((t) => t.status === "ERROR").length;
      lines.push(`- ${file}: passed=${fileReport.passed} failed=${fileReport.failed} errored=${errored}`);
      if (fileReport.harnessError !== null) {
        lines.push(`  harnessError=${fileReport.harnessError}`);
      }
    }
    if (failingFiles.length > 20) {
      lines.push(`- ... ${String(failingFiles.length - 20)} more failing files`);
    }
  }

  return lines.join("\n");
}

/** Convert Maps to plain values for `--json`. */
function serializableReport(report: WptSuiteReport): object {
  return {
    files: report.files,
    subtests: report.subtests,
    passed: report.passed,
    failed: report.failed,
    errored: report.errored,
    byFile: Object.fromEntries(report.byFile),
  };
}
