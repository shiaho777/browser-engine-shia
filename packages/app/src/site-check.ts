import { readFileSync } from "node:fs";
import type { Frame } from "@browser-engine/ipc";
import { WebContentClient } from "./webcontent-client.js";
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

function metricOf(frame: Frame, name: string): number | boolean {
  switch (name) {
    case "scriptsRun": return frame.scriptsRun;
    case "scriptsFailed": return frame.scriptsFailed;
    case "modulesEvaluated": return frame.modulesEvaluated;
    case "modulesLinked": return frame.modulesLinked;
    case "mutations": return frame.mutations;
    case "networkEvents": return frame.networkEvents;
    case "esmSupported": return frame.esmSupported;
    case "contentHeight": return frame.contentHeight;
    default: return 0;
  }
}

function runStaticCheck(frame: Frame, check: ManifestCheck, viewportHeight: number): SiteCheckResult {
  const fail = (detail: string): SiteCheckResult => ({ id: check.id, passed: false, detail });
  const pass = (detail: string): SiteCheckResult => ({ id: check.id, passed: true, detail });
  switch (check.kind) {
    case "title-equals":
      return frame.title === check.value
        ? pass(`title=${JSON.stringify(frame.title)}`)
        : fail(`title=${JSON.stringify(frame.title)} expected ${JSON.stringify(check.value)}`);
    case "title-contains": {
      const needle = typeof check.value === "string" ? check.value : "";
      return frame.title.includes(needle)
        ? pass(`title=${JSON.stringify(frame.title)} contains ${JSON.stringify(needle)}`)
        : fail(`title=${JSON.stringify(frame.title)} missing ${JSON.stringify(needle)}`);
    }
    case "min-metric": {
      const value = metricOf(frame, check.metric ?? "");
      if (typeof value !== "number") return fail(`metric ${check.metric} is not numeric`);
      return value >= (check.min ?? 0)
        ? pass(`${check.metric}=${value}`)
        : fail(`${check.metric}=${value} < min ${check.min}`);
    }
    case "metric-equals": {
      const value = metricOf(frame, check.metric ?? "");
      return value === check.value
        ? pass(`${check.metric}=${String(value)}`)
        : fail(`${check.metric}=${String(value)} expected ${String(check.value)}`);
    }
    case "content-height-gt-viewport":
      return frame.contentHeight > viewportHeight
        ? pass(`contentHeight=${frame.contentHeight} > viewport=${viewportHeight}`)
        : fail(`contentHeight=${frame.contentHeight} <= viewport=${viewportHeight}`);
    case "boot-error-free":
      return frame.scriptError === null
        ? pass("boot completed with no script error")
        : fail(`boot script error: ${String(frame.scriptError).slice(0, 160)}`);
    default:
      return fail(`unknown check kind ${check.kind}`);
  }
}

/**
 * Run one site's manifest against the live engine — over the same IPC the
 * shell uses, so the harness exercises the real process boundary (RFC 0004).
 * Network access is real; failures classify loudly.
 */
/** Load one page with one bounded retry — real sites rate-limit rapid repeated hits. */
async function loadWithRetry(
  client: WebContentClient,
  url: string,
  viewport: EngineViewport,
  attempts = 2,
): Promise<Frame> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const { frame } = await client.navigate(url, viewport, { keepAlive: true });
      if (frame === null) {
        lastError = new Error("navigate produced no frame");
      } else if (frame.title === "Load error" && /^https?:\/\//i.test(url)) {
        // Treat a rendered error page for http(s) targets as retryable.
        lastError = new Error("page rendered the engine error page (root fetch failed)");
      } else {
        return frame;
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
  const client = new WebContentClient();
  const metricsOf = (frame: Frame | null) => ({
    scriptsRun: frame?.scriptsRun ?? 0,
    scriptsFailed: frame?.scriptsFailed ?? 0,
    modulesEvaluated: frame?.modulesEvaluated ?? 0,
    modulesLinked: frame?.modulesLinked ?? 0,
    mutations: frame?.mutations ?? 0,
    networkEvents: frame?.networkEvents ?? 0,
    contentHeight: frame?.contentHeight ?? 0,
    viewportHeight: viewport.height,
    pngBytes: frame?.png.byteLength ?? 0,
    durationMs: performance.now() - started,
  });
  try {
    let frame: Frame;
    try {
      frame = await loadWithRetry(client, manifest.url, viewport);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        site: manifest.site,
        url: manifest.url,
        passed: false,
        failedCount: manifest.checks.length,
        checks: manifest.checks.map((c) => ({
          id: c.id,
          passed: false,
          detail: `load failed: ${message}`,
        })),
        metrics: metricsOf(null),
      };
    }

    const results: SiteCheckResult[] = [];
    let current = frame;
    let currentUrl = manifest.url;
    for (const check of manifest.checks) {
      // Page-scoped check: switch to (or load) its URL first.
      if (check.url !== undefined && check.url !== currentUrl) {
        try {
          current = await loadWithRetry(client, check.url, viewport);
          currentUrl = check.url;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          results.push({ id: check.id, passed: false, detail: `load ${check.url} failed: ${message}` });
          continue;
        }
      }
      if (check.kind === "pump-mutations") {
        const pump = await client.pump(check.frames ?? 1, { settleMs: 250, idleStop: true });
        if (pump.frame !== null) current = pump.frame;
        const grew = pump.mutations >= (check.minNewMutations ?? 1);
        results.push(grew
          ? { id: check.id, passed: true, detail: `pump ${check.frames ?? 1} frames: +${pump.mutations} mutations` }
          : { id: check.id, passed: false, detail: `pump ${check.frames ?? 1} frames: +${pump.mutations} < min ${check.minNewMutations}` });
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
      metrics: metricsOf(current),
    };
  } finally {
    await client.terminate();
  }
}
