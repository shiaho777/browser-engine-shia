import { readFileSync } from "node:fs";
import { loadPage, pumpFrames, type PageState } from "./page.js";
import type { EngineViewport } from "./host-api.js";
import { normalizeViewport } from "./host-api.js";

/** One assertion from a site manifest check list. */
export interface SiteCheckResult {
  readonly id: string;
  readonly passed: boolean;
  readonly detail: string;
}

/** The outcome of running a whole site manifest. */
export interface SiteCheckReport {
  readonly site: string;
  readonly url: string;
  readonly passed: boolean;
  readonly failedCount: number;
  readonly checks: readonly SiteCheckResult[];
  readonly metrics: {
    readonly scriptsRun: number;
    readonly scriptsFailed: number;
    readonly modulesEvaluated: number;
    readonly modulesLinked: number;
    readonly mutations: number;
    readonly networkEvents: number;
    readonly contentHeight: number;
    readonly viewportHeight: number;
    readonly pngBytes: number;
    readonly durationMs: number;
  };
}

interface ManifestCheck {
  readonly id: string;
  readonly kind: string;
  readonly metric?: string;
  readonly min?: number;
  readonly value?: unknown;
  readonly frames?: number;
  readonly minNewMutations?: number;
  /** Page-scoped checks load this URL before running (default: the manifest URL). */
  readonly url?: string;
}

interface SiteManifest {
  readonly site: string;
  readonly url: string;
  readonly checks: readonly ManifestCheck[];
}

function metricOf(page: PageState, name: string): number | boolean {
  switch (name) {
    case "scriptsRun": return page.scripts.scripts;
    case "scriptsFailed": return page.scripts.scriptsFailed;
    case "modulesEvaluated": return page.scripts.modulesEvaluated;
    case "modulesLinked": return page.scripts.modulesLinked;
    case "mutations": return page.scripts.mutations;
    case "networkEvents": return page.scripts.networkEvents;
    case "esmSupported": return page.scripts.esmSupported;
    case "contentHeight": return page.contentHeight;
    default: return 0;
  }
}

function runStaticCheck(page: PageState, check: ManifestCheck, viewportHeight: number): SiteCheckResult {
  const fail = (detail: string): SiteCheckResult => ({ id: check.id, passed: false, detail });
  const pass = (detail: string): SiteCheckResult => ({ id: check.id, passed: true, detail });
  switch (check.kind) {
    case "title-equals":
      return page.title === check.value
        ? pass(`title=${JSON.stringify(page.title)}`)
        : fail(`title=${JSON.stringify(page.title)} expected ${JSON.stringify(check.value)}`);
    case "title-contains": {
      const needle = typeof check.value === "string" ? check.value : "";
      return page.title.includes(needle)
        ? pass(`title=${JSON.stringify(page.title)} contains ${JSON.stringify(needle)}`)
        : fail(`title=${JSON.stringify(page.title)} missing ${JSON.stringify(needle)}`);
    }
    case "min-metric": {
      const value = metricOf(page, check.metric ?? "");
      if (typeof value !== "number") return fail(`metric ${check.metric} is not numeric`);
      return value >= (check.min ?? 0)
        ? pass(`${check.metric}=${value}`)
        : fail(`${check.metric}=${value} < min ${check.min}`);
    }
    case "metric-equals": {
      const value = metricOf(page, check.metric ?? "");
      return value === check.value
        ? pass(`${check.metric}=${String(value)}`)
        : fail(`${check.metric}=${String(value)} expected ${String(check.value)}`);
    }
    case "content-height-gt-viewport":
      return page.contentHeight > viewportHeight
        ? pass(`contentHeight=${page.contentHeight} > viewport=${viewportHeight}`)
        : fail(`contentHeight=${page.contentHeight} <= viewport=${viewportHeight}`);
    case "boot-error-free":
      return page.scripts.error === null
        ? pass("boot completed with no script error")
        : fail(`boot script error: ${String(page.scripts.error).slice(0, 160)}`);
    default:
      return fail(`unknown check kind ${check.kind}`);
  }
}

/**
 * Run one site's manifest against the live engine: load the URL with
 * keepAlive, pump extra frames for continuous-rendering checks, and verify
 * every declared check. Network access is real; failures classify loudly.
 */
/** Load one page with one bounded retry — real sites rate-limit rapid repeated hits. */
async function loadWithRetry(url: string, viewport: EngineViewport, attempts = 2): Promise<PageState> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const page = await loadPage(url, { viewport, keepAlive: true });
      // Treat a rendered error page for http(s) targets as a retryable failure.
      if (page.title === "Load error" && /^https?:\/\//i.test(url)) {
        lastError = new Error("page rendered the engine error page (root fetch failed)");
      } else {
        return page;
      }
    } catch (error) {
      lastError = error;
    }
    if (i + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function checkSite(
  manifestPath: string,
  options: { readonly viewport?: Partial<EngineViewport>; readonly pumpFrames?: number } = {},
): Promise<SiteCheckReport> {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as SiteManifest;
  const viewport = normalizeViewport(options.viewport ?? { width: 1280, height: 800 });
  const started = performance.now();
  let page: PageState;
  try {
    page = await loadWithRetry(manifest.url, viewport);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      site: manifest.site,
      url: manifest.url,
      passed: false,
      failedCount: manifest.checks.length,
      checks: manifest.checks.map((c) => ({ id: c.id, passed: false, detail: `load failed: ${message}` })),
      metrics: {
        scriptsRun: 0, scriptsFailed: 0, modulesEvaluated: 0, modulesLinked: 0,
        mutations: 0, networkEvents: 0, contentHeight: 0, viewportHeight: viewport.height,
        pngBytes: 0, durationMs: performance.now() - started,
      },
    };
  }

  const results: SiteCheckResult[] = [];
  let current = page;
  let currentUrl = manifest.url;
  for (const check of manifest.checks) {
    // Page-scoped check: switch to (or load) its URL first.
    if (check.url !== undefined && check.url !== currentUrl) {
      try {
        current = await loadWithRetry(check.url, viewport);
        currentUrl = check.url;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ id: check.id, passed: false, detail: `load ${check.url} failed: ${message}` });
        continue;
      }
    }
    if (check.kind === "pump-mutations") {
      const before = current.runtime?.mutations() ?? 0;
      const pump = await pumpFrames(current, check.frames ?? 1, { settleMs: 250, idleStop: true });
      current = pump.page;
      const after = current.runtime?.mutations() ?? 0;
      const grew = after - before >= (check.minNewMutations ?? 1);
      results.push(grew
        ? { id: check.id, passed: true, detail: `pump ${check.frames ?? 1} frames: +${after - before} mutations` }
        : { id: check.id, passed: false, detail: `pump ${check.frames ?? 1} frames: +${after - before} < min ${check.minNewMutations}` });
      continue;
    }
    results.push(runStaticCheck(current, check, viewport.height));
  }

  const failed = results.filter((r) => !r.passed).length;
  return {
    site: manifest.site,
    url: manifest.url,
    passed: failed === 0,
    failedCount: failed,
    checks: results,
    metrics: {
      scriptsRun: current.scripts.scripts,
      scriptsFailed: current.scripts.scriptsFailed,
      modulesEvaluated: current.scripts.modulesEvaluated,
      modulesLinked: current.scripts.modulesLinked,
      mutations: current.runtime?.mutations() ?? current.scripts.mutations,
      networkEvents: current.scripts.networkEvents,
      contentHeight: current.contentHeight,
      viewportHeight: viewport.height,
      pngBytes: current.pngBytes.byteLength,
      durationMs: performance.now() - started,
    },
  };
}
