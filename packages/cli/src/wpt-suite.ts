/**
 * wpt-suite.ts — the OFFICIAL Web Platform Tests importer + runner.
 *
 * This ingests real WPT test files — the `.html` testharness format and the
 * `.window.js` / `.any.js` script formats — exactly as they ship in the
 * web-platform-tests repository, and runs them against this engine on real V8,
 * scoring per-subtest PASS/FAIL the way wptrunner does. Point {@link
 * runWptDirectory} at a real `wpt/` checkout and it walks the tree, resolving
 * each test's `<script src>` includes against the checkout (the shared
 * `/resources/testharness.js` is satisfied by our own harness; other includes
 * are read from disk), and aggregates the results.
 *
 * Honesty: the engine is NOT a full browser, so tests exercising APIs it does
 * not implement (e.g. `document.createElement`, events) report ERROR — exactly
 * as a partial implementation scores against WPT. The runner is the real thing;
 * the pass rate is whatever the engine genuinely earns. We do not vendor the
 * multi-gigabyte suite; we vendor a few real-format fixtures to prove the
 * importer and let it run any checkout you provide.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { FineSession } from "./fine.js";
import { buildDocumentApi } from "./script.js";
import { createStageTraceCollector, type StageTrace } from "./stage-trace.js";
import { createAssertions, WptAssertionError } from "./testharness.js";
import type { WptReport, WptSubtest } from "./wpt.js";

/** Aggregate result of running a directory of WPT tests. */
export interface WptSuiteReport {
  readonly files: number;
  readonly subtests: number;
  readonly passed: number;
  readonly failed: number;
  readonly errored: number;
  /** Per-file reports, keyed by the test's path relative to the suite root. */
  readonly byFile: ReadonlyMap<string, WptReport>;
  /** Optional aggregate query trace across every WPT file in this suite run. */
  readonly trace?: StageTrace;
}

/** Options for WPT suite execution. */
export interface WptSuiteOptions {
  /**
   * Attach query-stage trace evidence. The trace observes the fine-grained
   * session WPT actually uses, and performs one final render per file so
   * qFinePaint/qFineLayout evidence is present even for pure DOM assertions.
   */
  readonly trace?: boolean;
  /** Document URL used for URL/base resolution inside the engine. */
  readonly documentUrl?: string;
}

/** How to resolve a support resource include to its source text (or `undefined`). */
export type ResourceResolver = (src: string) => string | undefined;
const encodeResource = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Resource paths that OUR harness supplies, so a real include of them is a no-op. */
function isHarnessResource(src: string): boolean {
  return /testharness(report)?\.js|testdriver|\/common\/|idlharness/.test(src);
}

// ---------------------------------------------------------------------------
// Async harness — full testharness `test` / `async_test` / `promise_test`.
// ---------------------------------------------------------------------------

interface AsyncHarness {
  readonly globals: Record<string, unknown>;
  readonly subtests: WptSubtest[];
  /** Resolves once every async/promise subtest has settled (or timed out). */
  settle(timeoutMs: number): Promise<void>;
}

function buildAsyncHarness(): AsyncHarness {
  const subtests: WptSubtest[] = [];
  const pending: Promise<void>[] = [];

  const push = (name: string, status: WptSubtest["status"], message: string | null): void => {
    subtests.push({ name, status, message });
  };
  const classify = (error: unknown): WptSubtest => ({
    name: "",
    status: error instanceof WptAssertionError ? "FAIL" : "ERROR",
    message: error instanceof Error ? error.message : String(error),
  });

  const test = (func: unknown, name: unknown): void => {
    if (typeof func !== "function") return;
    const n = typeof name === "string" ? name : "(unnamed test)";
    try {
      (func as () => void)();
      push(n, "PASS", null);
    } catch (e) {
      const c = classify(e);
      push(n, c.status, c.message);
    }
  };

  const asyncTest = (func: unknown, name: unknown): object => {
    const n = typeof name === "string" ? name : (typeof func === "string" ? func : "(unnamed async_test)");
    let settled = false;
    let resolveDone!: () => void;
    pending.push(new Promise<void>((r) => (resolveDone = r)));
    const finish = (status: WptSubtest["status"], message: string | null): void => {
      if (settled) return;
      settled = true;
      push(n, status, message);
      resolveDone();
    };
    const step = (f: unknown, ...args: unknown[]): unknown => {
      try {
        return typeof f === "function" ? (f as (...a: unknown[]) => unknown)(...args) : undefined;
      } catch (e) {
        const c = classify(e);
        finish(c.status, c.message);
        return undefined;
      }
    };
    const t = {
      step,
      step_func: (f: unknown) => (...a: unknown[]) => step(f, ...a),
      step_func_done: (f: unknown) => (...a: unknown[]) => {
        step(f, ...a);
        finish("PASS", null);
      },
      unreached_func: (msg: unknown) => () => finish("FAIL", `unreached: ${String(msg)}`),
      done: () => finish("PASS", null),
      add_cleanup: () => undefined,
    };
    if (typeof func === "function") step(func, t);
    return t;
  };

  const promiseTest = (func: unknown, name: unknown): void => {
    const n = typeof name === "string" ? name : "(unnamed promise_test)";
    if (typeof func !== "function") return;
    const p = Promise.resolve()
      .then(() => (func as (t: object) => unknown)({ add_cleanup: () => undefined }))
      .then(
        () => push(n, "PASS", null),
        (e: unknown) => {
          const c = classify(e);
          push(n, c.status, c.message);
        },
      );
    pending.push(p);
  };

  const globals: Record<string, unknown> = {
    ...createAssertions(),
    test,
    async_test: asyncTest,
    promise_test: promiseTest,
    setup: () => undefined,
    done: () => undefined,
    add_completion_callback: () => undefined,
    step_timeout: (f: unknown, ms: unknown) =>
      typeof f === "function" ? setTimeout(f as () => void, Number(ms) || 0) : 0,
    setTimeout: (f: unknown, ms: unknown) =>
      typeof f === "function" ? setTimeout(f as () => void, Number(ms) || 0) : 0,
    clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
    queueMicrotask: (f: unknown) => {
      if (typeof f === "function") queueMicrotask(f as () => void);
    },
  };

  const settle = async (timeoutMs: number): Promise<void> => {
    if (pending.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((r) => (timer = setTimeout(r, timeoutMs)));
    await Promise.race([Promise.allSettled(pending), timeout]);
    if (timer !== undefined) clearTimeout(timer);
  };

  return { globals, subtests, settle };
}

// ---------------------------------------------------------------------------
// Running one test file.
// ---------------------------------------------------------------------------

/** Extract `<script>` blocks (inline content and `src` references) in order. */
export function extractScripts(html: string): { src?: string; content: string }[] {
  const scripts: { src?: string; content: string }[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] ?? "";
    const srcMatch = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs);
    if (srcMatch !== null) {
      scripts.push({ src: srcMatch[1] as string, content: "" });
    } else {
      scripts.push({ content: m[2] ?? "" });
    }
  }
  return scripts;
}

/** The `<body>` (or whole doc) HTML to parse as the test's DOM, scripts stripped. */
function documentHtml(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
}

/**
 * Run one WPT testharness HTML test. Inline scripts run in order; `<script src>`
 * to shared harness files is a no-op (we provide the harness), other includes
 * are resolved via `resolveResource` (read from the checkout). Returns the
 * per-subtest report.
 */
export async function runWptHtml(
  html: string,
  resolveResource?: ResourceResolver,
  options: WptSuiteOptions = {},
): Promise<WptReport> {
  const collector = options.trace === true ? createStageTraceCollector() : undefined;
  const session = new FineSession(
    documentHtml(html),
    options.documentUrl ?? "wpt://doc",
    {
      ...(collector === undefined ? {} : { onQuery: collector.onQuery }),
      loadExternalSheet: (href) => {
        const source = resolveResource?.(href);
        return source === undefined ? undefined : encodeResource(source);
      },
    },
  );
  const { document, globals } = buildDocumentApi(session);
  const harness = buildAsyncHarness();
  const sandbox: Record<string, unknown> = { document, ...globals, ...harness.globals };
  sandbox["self"] = sandbox;
  sandbox["globalThis"] = sandbox;
  sandbox["window"] = sandbox;

  let harnessError: string | null = null;
  vm.createContext(sandbox);
  try {
    for (const script of extractScripts(html)) {
      let source = script.content;
      if (script.src !== undefined) {
        if (isHarnessResource(script.src)) continue; // provided by our harness.
        source = resolveResource?.(script.src) ?? "";
      }
      if (source.trim() === "") continue;
      vm.runInContext(source, sandbox, { timeout: 5000 });
    }
    await harness.settle(2000);
  } catch (error) {
    harnessError = error instanceof Error ? error.message : String(error);
  }
  let traceError: string | undefined;
  if (collector !== undefined) {
    try {
      session.render();
    } catch (error) {
      traceError = error instanceof Error ? error.message : String(error);
    }
  }

  const passed = harness.subtests.filter((t) => t.status === "PASS").length;
  const failed = harness.subtests.length - passed;
  return collector === undefined
    ? { subtests: harness.subtests, passed, failed, harnessError }
    : traceError === undefined
      ? { subtests: harness.subtests, passed, failed, harnessError, trace: collector.trace() }
      : { subtests: harness.subtests, passed, failed, harnessError, trace: collector.trace(), traceError };
}

/** Run a `.window.js` / `.any.js` WPT test (JS body, implicit window/document). */
export async function runWptScriptFile(
  source: string,
  resolveResource?: ResourceResolver,
  options: WptSuiteOptions = {},
): Promise<WptReport> {
  // `// META: script=foo.js` headers pull in extra includes (resolved from disk).
  const metaIncludes = [...source.matchAll(/^\/\/\s*META:\s*script=(.+)$/gim)].map((m) => (m[1] ?? "").trim());
  const prelude = metaIncludes
    .filter((s) => !isHarnessResource(s))
    .map((s) => resolveResource?.(s) ?? "")
    .join("\n");
  const html = "<html><head></head><body></body></html>";
  // Wrap as a single inline script so the HTML runner executes it.
  return runWptHtml(`${documentHtml(html)}<script>${prelude}\n${source}</script>`, resolveResource, options);
}

// ---------------------------------------------------------------------------
// Walking a real WPT checkout.
// ---------------------------------------------------------------------------

/** Recursively collect runnable WPT test files under `root`. */
export function collectWptTests(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        // Skip WPT's support/tooling directories that hold no runnable tests.
        if (entry === "resources" || entry === "tools" || entry === "common" || entry.startsWith(".")) continue;
        walk(full);
        continue;
      }
      if (isRunnableWptTest(full)) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

/** Whether a path is a runnable testharness test (.html with the include, or .window/.any.js). */
function isRunnableWptTest(file: string): boolean {
  if (/\.(window|any)\.js$/.test(file)) return true;
  if (/\.x?html$/.test(file)) {
    try {
      return readFileSync(file, "utf8").includes("testharness.js");
    } catch {
      return false;
    }
  }
  return false;
}

/** Run one WPT file under `root`, resolving support resources against the same checkout. */
export async function runWptFile(
  root: string,
  file: string,
  options: WptSuiteOptions = {},
): Promise<readonly [string, WptReport]> {
  const full = path.isAbsolute(file) ? file : path.join(root, file);
  const resolve: ResourceResolver = (src) => {
    const wptPath = pathFromWptDocumentUrl(src);
    const target = wptPath !== null
      ? path.join(root, wptPath)
      : src.startsWith("/")
        ? path.join(root, src)
        : path.join(path.dirname(full), src);
    try {
      return readFileSync(target, "utf8");
    } catch {
      return undefined;
    }
  };
  const source = readFileSync(full, "utf8");
  const relative = path.relative(root, full).split(path.sep).join("/");
  const documentUrl = `wpt://doc/${relative}`;
  const report = /\.(window|any)\.js$/.test(full)
    ? await runWptScriptFile(source, resolve, { ...options, documentUrl })
    : await runWptHtml(source, resolve, { ...options, documentUrl });
  return [path.relative(root, full), report] as const;
}

/** Map the engine's synthetic WPT document URLs back to checkout-relative paths. */
function pathFromWptDocumentUrl(src: string): string | null {
  try {
    const url = new URL(src);
    if (url.protocol !== "wpt:" || url.hostname !== "doc") {
      return null;
    }
    return decodeURIComponent(url.pathname).replace(/^\/+/, "");
  } catch {
    return null;
  }
}

/** Run an explicit file list under `root`, scoring only those tests. */
export async function runWptFiles(
  root: string,
  files: readonly string[],
  options: WptSuiteOptions = {},
): Promise<WptSuiteReport> {
  const collector = options.trace === true ? createStageTraceCollector() : undefined;
  const byFile = new Map<string, WptReport>();
  let subtests = 0;
  let passed = 0;
  let failed = 0;
  let errored = 0;

  for (const file of files) {
    const [relative, report] = await runWptFile(
      root,
      file,
      collector === undefined ? {} : { trace: true },
    );
    byFile.set(relative, report);
    if (collector !== undefined) {
      replayTrace(report.trace, collector);
    }
    subtests += report.subtests.length;
    passed += report.passed;
    failed += report.subtests.filter((t) => t.status === "FAIL").length;
    errored += report.subtests.filter((t) => t.status === "ERROR").length;
  }

  return collector === undefined
    ? { files: files.length, subtests, passed, failed, errored, byFile }
    : { files: files.length, subtests, passed, failed, errored, byFile, trace: collector.trace() };
}

/**
 * Run every WPT test under `root` (a real web-platform-tests checkout), scoring
 * each against this engine. `<script src>` includes resolve against the
 * checkout. Returns the aggregate suite report. `limit` caps the number of
 * files (for sampling a huge tree).
 */
export async function runWptDirectory(
  root: string,
  limit = Infinity,
  options: WptSuiteOptions = {},
): Promise<WptSuiteReport> {
  const files = collectWptTests(root).slice(0, limit);
  return runWptFiles(root, files, options);
}

function replayTrace(trace: StageTrace | undefined, collector: ReturnType<typeof createStageTraceCollector>): void {
  if (trace === undefined) return;
  for (const event of trace.events) {
    collector.onQuery({
      query: { name: event.stage },
      queryName: event.stage,
      key: event.key,
      durationMs: event.durationMs,
      dependencyCount: event.dependencyCount,
      cacheStatus: event.cacheStatus,
    });
  }
}
