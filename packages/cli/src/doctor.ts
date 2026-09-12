/**
 * `doctor <input.html|URL>` — the headless diagnose-fix-verify loop.
 *
 * Why this exists: `diagnose --json` answers "what is wrong right now", but
 * fixing still meant a human re-running commands between edits. `doctor` closes
 * that loop without any window: it re-runs {@link diagnoseInput} headlessly
 * (pure pipeline + script runner + fetch — never the app shell), picks up file
 * edits between iterations, and stops when the page is clean or `--max` is
 * exhausted. An AI agent (or CI) drives it as: read JSON → patch → let the
 * loop verify → repeat until exit 0.
 *
 * Output contract:
 *   - human mode prints one line per iteration plus a final summary.
 *   - `--json` prints one machine-readable `DoctorResult` on stdout.
 *   - `--jsonl <path>` appends one full `DiagnoseReport` per iteration,
 *     so long loops stay tail-able without re-printing history.
 */
import { appendFileSync } from "node:fs";

import { diagnoseInput, type DiagnoseReport } from "./diagnose.js";

/** Parsed `doctor` command arguments. */
export interface DoctorArgs {
  readonly input: string;
  readonly max: number;
  readonly intervalMs: number;
  readonly json: boolean;
  readonly jsonl?: string | undefined;
}

export const DOCTOR_DEFAULT_MAX = 10;
export const DOCTOR_DEFAULT_INTERVAL_MS = 1000;

/** One loop verdict over one or more headless diagnoses. */
export interface DoctorResult {
  readonly input: string;
  readonly ok: boolean;
  readonly iterations: number;
  readonly stabilized: boolean;
  readonly reports: readonly DiagnoseReport[];
}

/**
 * Parse `doctor <input> [--max N] [--interval-ms M] [--json] [--jsonl path]`.
 *
 * @throws Error on missing input, unknown options, or invalid values.
 */
export function parseDoctorArgs(argv: readonly string[]): DoctorArgs {
  let input: string | undefined;
  let max = DOCTOR_DEFAULT_MAX;
  let intervalMs = DOCTOR_DEFAULT_INTERVAL_MS;
  let json = false;
  let jsonl: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--max") {
      const raw = argv[i + 1];
      if (raw === undefined) throw new Error("doctor: --max requires a number");
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`doctor: invalid --max value ${JSON.stringify(raw)}`);
      max = parsed;
      i += 1;
    } else if (arg === "--interval-ms") {
      const raw = argv[i + 1];
      if (raw === undefined) throw new Error("doctor: --interval-ms requires a number");
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`doctor: invalid --interval-ms value ${JSON.stringify(raw)}`);
      }
      intervalMs = Math.floor(parsed);
      i += 1;
    } else if (arg === "--jsonl") {
      const raw = argv[i + 1];
      if (raw === undefined) throw new Error("doctor: --jsonl requires a path");
      jsonl = raw;
      i += 1;
    } else if (arg !== undefined && arg.startsWith("-")) {
      throw new Error(`doctor: unknown option ${arg}`);
    } else {
      input ??= arg;
    }
  }
  if (input === undefined) {
    throw new Error("doctor: missing <input.html|URL> argument (usage: doctor <input.html|URL> [--max N] [--json])");
  }
  return jsonl === undefined ? { input, max, intervalMs, json } : { input, max, intervalMs, json, jsonl };
}

/** Stable per-report signature: bucket + first error line (or `ok`). */
export function doctorSignature(report: DiagnoseReport): string {
  const firstLine = report.error === null ? "ok" : (report.error.split("\n")[0] ?? report.error);
  return `${report.bucket}::${firstLine}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run the headless loop: diagnose, stop early on clean, otherwise wait
 * `intervalMs` and re-diagnose (re-reading the input, so external edits land).
 * `onIteration` fires after each diagnosis for progress/JSONL sinks.
 */
export async function runDoctor(
  input: string,
  options: { readonly max?: number; readonly intervalMs?: number } = {},
  onIteration?: (report: DiagnoseReport, iteration: number) => void,
): Promise<DoctorResult> {
  const max = options.max ?? DOCTOR_DEFAULT_MAX;
  const intervalMs = options.intervalMs ?? DOCTOR_DEFAULT_INTERVAL_MS;
  const reports: DiagnoseReport[] = [];
  for (let iteration = 1; iteration <= max; iteration += 1) {
    const report = await diagnoseInput(input);
    reports.push(report);
    onIteration?.(report, iteration);
    if (report.ok) break;
    if (iteration < max && intervalMs > 0) await sleep(intervalMs);
  }
  const signatures = reports.map(doctorSignature);
  const stabilized = signatures.length > 0 && signatures.every((s) => s === signatures[0]);
  const last = reports[reports.length - 1];
  return {
    input,
    ok: last !== undefined && last.ok,
    iterations: reports.length,
    stabilized,
    reports: Object.freeze([...reports]),
  };
}

/** Human-readable loop summary for terminal use. */
export function formatDoctorResult(result: DoctorResult): string {
  const lines: string[] = [
    `doctor: ${result.input}`,
    `verdict: ${result.ok ? "CLEAN" : "STILL FAILING"} iterations=${String(result.iterations)} stabilized=${String(result.stabilized)}`,
  ];
  for (let i = 0; i < result.reports.length; i += 1) {
    const report = result.reports[i];
    if (report === undefined) continue;
    const detail = report.error === null ? "ok" : (report.error.split("\n")[0] ?? report.error);
    lines.push(`  [${String(i + 1)}] ${report.ok ? "OK" : "FAIL"} bucket=${report.bucket} ${detail}`);
  }
  if (!result.ok) {
    const last = result.reports[result.reports.length - 1];
    if (last !== undefined) lines.push(`next: ${last.bucket} — see diagnose --json for console/trace.`);
  }
  return lines.join("\n");
}

/** Run the `doctor` subcommand and return a process exit code. */
export async function runDoctorCommand(argv: readonly string[]): Promise<number> {
  let args: DoctorArgs;
  try {
    args = parseDoctorArgs(argv);
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("usage: doctor <input.html|URL> [--max N] [--interval-ms M] [--json] [--jsonl path]");
    return 1;
  }
  try {
    const onIteration: ((report: DiagnoseReport, iteration: number) => void) | undefined =
      args.jsonl === undefined
        ? undefined
        : (report: DiagnoseReport): void => {
            appendFileSync(args.jsonl as string, `${JSON.stringify(report)}\n`);
          };
    const result = await runDoctor(
      args.input,
      { max: args.max, intervalMs: args.intervalMs },
      args.json
        ? onIteration
        : (report, iteration): void => {
            onIteration?.(report, iteration);
            const detail = report.error === null ? "ok" : (report.error.split("\n")[0] ?? report.error);
            console.log(`[${String(iteration)}] ${report.ok ? "OK" : "FAIL"} bucket=${report.bucket} ${detail}`);
          },
    );
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatDoctorResult(result));
    }
    return result.ok ? 0 : 1;
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
