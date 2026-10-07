/**
 * `diagnose <input.html|URL>` — the single console-to-cause entry point.
 *
 * Why this exists: debugging used to mean running `render`, `wpt`, and
 * `site-check` separately and correlating their outputs by hand. This command
 * merges the three signals an AI (or human) needs to locate a page problem
 * without blind re-testing into one report:
 *
 *   1. guest console (`console.*` + uncaught errors + script error),
 *   2. pipeline evidence (`StageTrace` for files, `ResourceTrace` for URLs),
 *   3. a WPT-War-Room failure bucket (`parser/cascade/layout/paint/backend/
 *      guest/network/harness/engine-bug`) pointing at the owning stage.
 *
 * The cli is the wiring layer, so composing the pipeline + script runner +
 * loader here is legal (the `local/no-cross-stage-import` rule polices
 * stage→stage imports, not the wiring layer).
 */
import { readFileSync } from "node:fs";

import { defaultFetch, type FetchFn } from "./loader.js";
import { renderHtmlToPng, renderUrlToPng, formatStageTrace, formatResourceTrace } from "./render.js";
import { FineSession } from "./fine.js";
import { runScriptsOnSession, type GuestDiagnostics } from "./event-loop.js";
import { extractScripts } from "./wpt-suite.js";
import type { ResourceTrace } from "./render.js";
import type { StageTrace } from "./stage-trace.js";

/** Parsed `diagnose` command arguments. */
export interface DiagnoseArgs {
  readonly input: string;
  readonly json: boolean;
}

/** WPT-War-Room failure buckets (+ `ok` when the page renders cleanly). */
export type DiagnoseBucket =
  | "ok"
  | "parser-gap"
  | "cascade-gap"
  | "layout-gap"
  | "paint-gap"
  | "backend-gap"
  | "guest-gap"
  | "network-gap"
  | "harness-gap"
  | "engine-bug";

/** One machine-readable diagnosis for an input document. */
export interface DiagnoseReport {
  readonly input: string;
  readonly kind: "file" | "url";
  readonly ok: boolean;
  readonly error: string | null;
  readonly bucket: DiagnoseBucket;
  readonly scripts: { readonly total: number; readonly inline: number; readonly executed: boolean };
  readonly console: readonly { readonly level: string; readonly message: string }[];
  readonly errors: readonly string[];
  readonly scriptError: string | null;
  readonly resourceTrace?: ResourceTrace | undefined;
  readonly stageTrace?: StageTrace | undefined;
  readonly png?: { readonly width: number; readonly height: number; readonly bytes: number; readonly paintOps?: readonly string[] | undefined } | undefined;
}

/**
 * Parse `diagnose <input> [--json]` argv (the slice after the subcommand).
 * Accepts `--json` before or after the positional input.
 *
 * @throws Error on missing input or unknown options.
 */
export function parseDiagnoseArgs(argv: readonly string[]): DiagnoseArgs {
  let input: string | undefined;
  let json = false;
  for (const arg of argv) {
    if (arg === "--json") {
      json = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`diagnose: unknown option ${arg}`);
    } else {
      input ??= arg;
    }
  }
  if (input === undefined) {
    throw new Error("diagnose: missing <input.html|URL> argument (usage: diagnose <input.html|URL> [--json])");
  }
  return { input, json };
}

/**
 * Map an error message (or lack thereof) to a WPT-War-Room bucket.
 * `NotImplemented [category]` maps by category; fetch failures map to
 * `network-gap`; script/console failures with a clean pipeline map to
 * `guest-gap`; anything else is an `engine-bug`.
 */
export function classifyDiagnoseBucket(error: string | null, scriptFailed: boolean): DiagnoseBucket {
  if (error === null) return scriptFailed ? "guest-gap" : "ok";
  const lower = error.toLowerCase();
  if (/failed to fetch|fetch failed|network|404|enotfound|econn|timeout|abort/i.test(error)) return "network-gap";
  const categoryMatch = /notimplemented \[([^\]]+)\]/i.exec(error);
  if (categoryMatch !== null) {
    const category = (categoryMatch[1] ?? "").toLowerCase();
    if (category.includes("css-property") || category.includes("selector")) return "cascade-gap";
    if (category.includes("dom-api")) return "guest-gap";
    if (category.includes("layout-mode")) return "layout-gap";
    if (category.includes("paint-command")) return "paint-gap";
    if (category.includes("pipeline-stage")) return "harness-gap";
    return "engine-bug";
  }
  if (/parse|tokeniz|tree construction|quirks/i.test(lower)) return "parser-gap";
  if (/cascade|specificity|selector|inherit|custom propert|var\(\)/i.test(lower)) return "cascade-gap";
  if (/layout|fragment|margin|flex|grid|float|position/i.test(lower)) return "layout-gap";
  if (/paint|displaylist|display list|composit/i.test(lower)) return "paint-gap";
  if (/backend|raster|png|surface|glyph|font|shap/i.test(lower)) return "backend-gap";
  if (/script|console|event|dom|webidl|document\./i.test(lower)) return "guest-gap";
  if (/harness|testharness|fixture/i.test(lower)) return "harness-gap";
  return "engine-bug";
}

/** Diagnose one input (file path or http(s) URL) and return the report. */
export async function diagnoseInput(input: string, fetchFn: FetchFn = defaultFetch): Promise<DiagnoseReport> {
  const isUrl = /^https?:\/\//i.test(input);
  return isUrl ? diagnoseUrl(input, fetchFn) : diagnoseFile(input);
}

function diagnoseFile(inputPath: string): DiagnoseReport {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(inputPath));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      input: inputPath,
      kind: "file",
      ok: false,
      error: `read failed: ${message}`,
      bucket: "harness-gap",
      scripts: { total: 0, inline: 0, executed: false },
      console: [],
      errors: [],
      scriptError: null,
    };
  }
  const text = Buffer.from(bytes).toString("utf8");
  const scripts = extractScripts(text);
  const inlineSources = scripts.filter((s) => s.src === undefined).map((s) => s.content).filter((s) => s.trim() !== "");

  // Guest console: run inline scripts against a live session with a diagnostics
  // sink, so `console.*` + uncaught errors are captured without a debugger.
  const diagnostics: GuestDiagnostics = { console: [], errors: [] };
  let scriptError: string | null = null;
  let sessionOk = true;
  try {
    const session = new FineSession(text, `file://${inputPath}`);
    const run = runScriptsOnSession(session, inlineSources, new Map(), { diagnostics });
    scriptError = run.error;
  } catch (error: unknown) {
    sessionOk = false;
    scriptError = error instanceof Error ? error.message : String(error);
  }

  // Pipeline evidence: full render with stage tracing.
  try {
    const result = renderHtmlToPng(bytes, `file://${inputPath}`, { trace: true });
    // The pipeline rendered: any script/console failure owns the diagnosis.
    const guestFailed = scriptError !== null || diagnostics.errors.length > 0;
    const bucket: DiagnoseBucket = guestFailed ? "guest-gap" : "ok";
    return {
      input: inputPath,
      kind: "file",
      ok: scriptError === null && diagnostics.errors.length === 0,
      error: scriptError,
      bucket,
      scripts: { total: scripts.length, inline: inlineSources.length, executed: true },
      console: Object.freeze([...diagnostics.console]),
      errors: Object.freeze([...diagnostics.errors]),
      scriptError,
      stageTrace: result.trace,
      png: { width: result.width, height: result.height, bytes: result.png.length },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      input: inputPath,
      kind: "file",
      ok: false,
      error: message,
      bucket: classifyDiagnoseBucket(message, false),
      scripts: { total: scripts.length, inline: inlineSources.length, executed: sessionOk },
      console: Object.freeze([...diagnostics.console]),
      errors: Object.freeze([...diagnostics.errors]),
      scriptError,
    };
  }
}

async function diagnoseUrl(url: string, fetchFn: FetchFn): Promise<DiagnoseReport> {
  let rootBytes: Uint8Array | undefined;
  try {
    rootBytes = await fetchFn(url);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      input: url,
      kind: "url",
      ok: false,
      error: `fetch failed: ${message}`,
      bucket: "network-gap",
      scripts: { total: 0, inline: 0, executed: false },
      console: [],
      errors: [],
      scriptError: null,
    };
  }
  if (rootBytes === undefined) {
    return {
      input: url,
      kind: "url",
      ok: false,
      error: `fetch failed: no bytes for ${url}`,
      bucket: "network-gap",
      scripts: { total: 0, inline: 0, executed: false },
      console: [],
      errors: [],
      scriptError: null,
    };
  }
  const text = Buffer.from(rootBytes).toString("utf8");
  const scripts = extractScripts(text);
  const inline = scripts.filter((s) => s.src === undefined).length;
  try {
    const result = await renderUrlToPng(url, fetchFn, { trace: true });
    const missing = result.resourceTrace?.missingResources ?? [];
    // URL script execution needs network-fetched resources; v1 reports the
    // script inventory without executing, so the report stays honest.
    return {
      input: url,
      kind: "url",
      ok: missing.length === 0,
      error: missing.length > 0 ? `missing resources: ${missing.join(", ")}` : null,
      bucket: missing.length > 0 ? "network-gap" : "ok",
      scripts: { total: scripts.length, inline, executed: false },
      console: [],
      errors: [],
      scriptError: null,
      resourceTrace: result.resourceTrace,
      png:
        result.resourceTrace === undefined
          ? { width: result.width, height: result.height, bytes: result.png.length }
          : {
              width: result.width,
              height: result.height,
              bytes: result.png.length,
              paintOps: result.resourceTrace.paintOps,
            },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      input: url,
      kind: "url",
      ok: false,
      error: message,
      bucket: classifyDiagnoseBucket(message, false),
      scripts: { total: scripts.length, inline, executed: false },
      console: [],
      errors: [],
      scriptError: null,
    };
  }
}

/** Human-readable diagnosis for terminal use. */
export function formatDiagnoseReport(report: DiagnoseReport): string {
  const lines: string[] = [
    `diagnose: ${report.input} (${report.kind})`,
    `status: ${report.ok ? "OK" : "FAIL"} bucket=${report.bucket}`,
  ];
  if (report.error !== null) lines.push(`error: ${report.error}`);
  lines.push(`scripts: total=${String(report.scripts.total)} inline=${String(report.scripts.inline)} executed=${String(report.scripts.executed)}`);
  if (report.console.length > 0) {
    lines.push(`console (${String(report.console.length)}):`);
    for (const entry of report.console.slice(0, 20)) lines.push(`  [${entry.level}] ${entry.message}`);
    if (report.console.length > 20) lines.push(`  ... ${String(report.console.length - 20)} more`);
  } else {
    lines.push("console: (none)");
  }
  if (report.errors.length > 0) {
    lines.push(`guest errors (${String(report.errors.length)}):`);
    for (const entry of report.errors.slice(0, 20)) lines.push(`  - ${entry}`);
    if (report.errors.length > 20) lines.push(`  ... ${String(report.errors.length - 20)} more`);
  } else {
    lines.push("guest errors: (none)");
  }
  if (report.png !== undefined) {
    lines.push(`png: ${String(report.png.width)}x${String(report.png.height)} ${String(report.png.bytes)} bytes`);
  }
  if (report.resourceTrace !== undefined) lines.push("", formatResourceTrace(report.resourceTrace));
  if (report.stageTrace !== undefined) lines.push("", formatStageTrace(report.stageTrace));
  lines.push("", nextActionFor(report.bucket));
  return lines.join("\n");
}

function nextActionFor(bucket: DiagnoseBucket): string {
  switch (bucket) {
    case "ok": return "next: no action — page renders cleanly.";
    case "parser-gap": return "next: inspect html-parser stage (stage:html-parser).";
    case "cascade-gap": return "next: inspect cascade/selectors (stage:cascade).";
    case "layout-gap": return "next: inspect layout FragmentTree (stage:layout).";
    case "paint-gap": return "next: inspect paint DisplayList (stage:paint).";
    case "backend-gap": return "next: inspect backend raster/fonts (stage:backend).";
    case "guest-gap": return "next: inspect guest DOM/event-loop (stage:guest).";
    case "network-gap": return "next: inspect loader/fetch resources (stage:network).";
    case "harness-gap": return "next: inspect test harness/fixture wiring.";
    case "engine-bug": return "next: treat as engine-bug — mechanism exists but returns the wrong result.";
  }
}

/** Run the `diagnose` subcommand and return a process exit code. */
export async function runDiagnoseCommand(argv: readonly string[]): Promise<number> {
  let args: DiagnoseArgs;
  try {
    args = parseDiagnoseArgs(argv);
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("usage: diagnose <input.html|URL> [--json]");
    return 1;
  }
  try {
    const report = await diagnoseInput(args.input);
    if (args.json) {
      console.log(JSON.stringify(serializableDiagnose(report), null, 2));
    } else {
      console.log(formatDiagnoseReport(report));
    }
    return report.ok ? 0 : 1;
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function serializableDiagnose(report: DiagnoseReport): object {
  return {
    input: report.input,
    kind: report.kind,
    ok: report.ok,
    error: report.error,
    bucket: report.bucket,
    scripts: report.scripts,
    console: report.console,
    errors: report.errors,
    scriptError: report.scriptError,
    resourceTrace: report.resourceTrace,
    stageTrace: report.stageTrace,
    png: report.png,
  };
}
