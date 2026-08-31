import type { DomTree, NodeId } from "@browser-engine/ir";
import {
  FineSession,
  defaultFetch,
  documentBaseUrl,
  isEsmSupported,
  runModuleScripts,
  runScriptsOnSessionReal,
  type EventDrivenRun,
  type FetchFn,
} from "@browser-engine/cli";
import {
  createBrowserNetworkStack,
  networkStackToFetchFn,
  networkStackToBrowserFetch,
  type BrowserNetworkStack,
} from "@browser-engine/guest";

export interface ScriptRecord {
  readonly kind: "classic" | "module";
  readonly inline: boolean;
  readonly url: string | null;
  readonly source: string | null;
  readonly nomodule: boolean;
  /** The <script> element node (present for inline scripts with a body). */
  readonly nodeId?: NodeId;
}

export interface CollectedScripts {
  readonly sources: readonly string[];
  readonly externalUrls: readonly string[];
  readonly skipped: number;
  readonly records: readonly ScriptRecord[];
  readonly moduleUrls: readonly string[];
  readonly classicExternalUrls: readonly string[];
}

export interface ScriptExecutionSummary {
  readonly scripts: number;
  readonly mutations: number;
  readonly microtasks: number;
  readonly timers: number;
  readonly frames: number;
  readonly error: string | null;
  readonly externalUrls: readonly string[];
  readonly moduleUrls: readonly string[];
  readonly scriptsLoaded: number;
  readonly scriptsFailed: number;
  readonly cookies: number;
  readonly networkEvents: number;
  readonly modulesEvaluated: number;
  readonly modulesLinked: number;
  readonly esmSupported: boolean;
}

function textContent(dom: DomTree, nodeId: NodeId): string {
  const node = dom.nodes.get(nodeId);
  if (node === undefined) return "";
  if (node.kind === "text" || node.kind === "comment") {
    return node.text ?? "";
  }
  let out = "";
  for (const child of node.children) {
    out += textContent(dom, child);
  }
  return out;
}

function isModuleType(typeAttr: string | undefined): boolean {
  return (typeAttr ?? "").trim().toLowerCase() === "module";
}

function isRunnableScriptType(typeAttr: string | undefined): boolean {
  if (typeAttr === undefined || typeAttr.trim() === "") return true;
  const t = typeAttr.trim().toLowerCase();
  return (
    t === "text/javascript" ||
    t === "application/javascript" ||
    t === "application/ecmascript" ||
    t === "text/ecmascript" ||
    t === "module"
  );
}

export function collectDocumentScripts(dom: DomTree, baseUrl: string): CollectedScripts {
  const sources: string[] = [];
  const externalUrls: string[] = [];
  const moduleUrls: string[] = [];
  const classicExternalUrls: string[] = [];
  const records: ScriptRecord[] = [];
  let skipped = 0;

  const visit = (id: NodeId): void => {
    const node = dom.nodes.get(id);
    if (node === undefined) return;
    if (node.kind === "element" && node.tag === "script") {
      if (!isRunnableScriptType(node.attrs?.get("type"))) {
        skipped += 1;
        return;
      }
      const nomodule = node.attrs?.has("nomodule") ?? false;
      const module = isModuleType(node.attrs?.get("type"));
      if (nomodule && module) {
        skipped += 1;
        return;
      }
      const src = node.attrs?.get("src")?.trim();
      if (src !== undefined && src !== "") {
        let abs = src;
        try {
          abs = new URL(src, baseUrl).href;
        } catch {
          // Invalid URL input: keep the raw/fallback value.
        }
        if (nomodule) {
          skipped += 1;
          records.push({ kind: "classic", inline: false, url: abs, source: null, nomodule: true });
          return;
        }
        externalUrls.push(abs);
        if (module) moduleUrls.push(abs);
        else classicExternalUrls.push(abs);
        records.push({
          kind: module ? "module" : "classic",
          inline: false,
          url: abs,
          source: null,
          nomodule: false,
        });
        return;
      }
      const body = textContent(dom, id).trim();
      if (body !== "") {
        if (nomodule) {
          skipped += 1;
          records.push({ kind: "classic", inline: true, url: null, source: body, nomodule: true });
          return;
        }
        if (!module) {
          sources.push(body);
        }
        records.push({
          kind: module ? "module" : "classic",
          inline: true,
          url: null,
          source: body,
          nodeId: id,
          nomodule: false,
        });
      }
      return;
    }
    for (const child of node.children) {
      visit(child);
    }
  };

  visit(dom.root);
  return { sources, externalUrls, skipped, records, moduleUrls, classicExternalUrls };
}


function isLowValueBootScript(url: string): boolean {
  const u = url.toLowerCase();
  return (
    u.includes("log-reporter") ||
    u.includes("bili-collect") ||
    u.includes("bilimirror") ||
    u.includes("b-mirror") ||
    u.includes("/bfs/seed/log/") ||
    u.includes("hm.baidu.com") ||
    u.includes("google-analytics") ||
    u.includes("googletagmanager") ||
    u.includes("/gtag/") ||
    u.includes("hotjar") ||
    u.includes("clarity.ms") ||
    u.includes("sentry") ||
    u.includes("sensorsdata") ||
    u.includes("umeng") ||
    u.includes("cnzz") ||
    u.includes("datareport") ||
    u.includes("report.biliapi") ||
    u.includes("data.bilibili.com") ||
    u.includes("cm.bilibili.com") ||
    u.includes("s1.hdslb.com/bfs/seed/") ||
    u.includes("pv.sohu.com") ||
    u.includes("push.zhanzhang.baidu")
  );
}

export async function loadExternalScripts(
  urls: readonly string[],
  fetchFn: FetchFn = defaultFetch,
): Promise<{ sources: string[]; failed: string[]; loaded: string[] }> {
  const decoder = new TextDecoder();
  const results = await Promise.all(
    urls.map(async (url) => {
      try {
        const bytes = await fetchFn(url);
        if (bytes === undefined) return { url, source: null as string | null };
        return { url, source: decoder.decode(bytes) };
      } catch {
        return { url, source: null as string | null };
      }
    }),
  );
  const sources: string[] = [];
  const failed: string[] = [];
  const loaded: string[] = [];
  for (const item of results) {
    if (item.source === null) {
      failed.push(item.url);
      continue;
    }
    sources.push(item.source);
    loaded.push(item.url);
  }
  return { sources, failed, loaded };
}

/**
 * A live guest runtime kept after boot: pumping it lets guest timers, rAF
 * callbacks, and microtasks keep mutating the DOM for continuous rendering.
 */
export interface PageRuntime {
  /** Drain the classic-run virtual event loop (timers + rAF + microtasks). */
  readonly drainClassic: () => void;
  /** Wait once for in-flight guest fetches (classic run). */
  readonly flushClassic: () => Promise<void>;
  /** Wait for in-flight module fetches/timers; null when ESM is off. */
  readonly settleModules: ((maxMs?: number) => Promise<void>) | null;
  /** Total guest DOM mutations so far (classic + modules). */
  readonly mutations: () => number;
}

export async function bootFineSession(
  html: string,
  url: string,
  options: {
    readonly fetchFn?: FetchFn;
    readonly runScripts?: boolean;
    readonly loadExternalSheet?: (href: string) => Uint8Array | undefined;
    readonly network?: BrowserNetworkStack;
    readonly onAfterClassic?: (session: FineSession) => void | Promise<void>;
    /** Keep guest timers/rAF alive after boot so a host can pump frames. */
    readonly keepAlive?: boolean;
  } = {},
): Promise<{
  session: FineSession;
  scripts: ScriptExecutionSummary;
  network: BrowserNetworkStack | null;
  /** Present only with keepAlive: hooks to pump guest work after boot. */
  runtime?: PageRuntime;
}> {
  const network = options.network ?? null;
  const fetchFn =
    options.fetchFn ??
    (network !== null ? networkStackToFetchFn(network) : defaultFetch);
  const runScripts = options.runScripts ?? true;
  const sessionOpts =
    options.loadExternalSheet === undefined
      ? {}
      : { loadExternalSheet: options.loadExternalSheet };
  const session = new FineSession(html, url, sessionOpts);
  if (!runScripts) {
    return {
      session,
      network,
      scripts: {
        scripts: 0,
        mutations: 0,
        microtasks: 0,
        timers: 0,
        frames: 0,
        error: null,
        externalUrls: [],
        moduleUrls: [],
        scriptsLoaded: 0,
        scriptsFailed: 0,
        cookies: network?.jar.size ?? 0,
        networkEvents: network?.events.length ?? 0,
        modulesEvaluated: 0,
        modulesLinked: 0,
        esmSupported: isEsmSupported(),
      },
    };
  }

  const profile = process.env["ENGINE_PROFILE"] === "1";
  const mark = (label: string, t0: number): number => {
    if (!profile) return t0;
    const now = performance.now();
    console.error(`[profile] boot.${label}=${Math.round(now - t0)}ms`);
    return now;
  };
  let t = performance.now();
  const base = documentBaseUrl(session.dom, url);
  const collected = collectDocumentScripts(session.dom, base);
  const classicUrls = collected.classicExternalUrls.filter((u) => !isLowValueBootScript(u));
  const moduleUrls = collected.moduleUrls.filter((u) => !isLowValueBootScript(u));
  if (profile) {
    console.error(
      `[profile] boot.scripts classic=${classicUrls.length} module=${moduleUrls.length} inline=${collected.sources.length}`,
    );
  }
  const [classicExternal, moduleExternal] = await Promise.all([
    loadExternalScripts(classicUrls, fetchFn),
    loadExternalScripts(moduleUrls, fetchFn),
  ]);
  t = mark("fetchScripts", t);
  const classicSources = [...collected.sources, ...classicExternal.sources];
  // Aligned with classicSources: inline sources map to their <script> nodes (record
  // order), external sources have no node here. Drives document.currentScript.
  const classicScriptNodeIds: (NodeId | null)[] = [];
  for (const rec of collected.records) {
    if (rec.kind === "classic" && rec.inline && !rec.nomodule) {
      classicScriptNodeIds.push(rec.nodeId ?? null);
    }
  }
  while (classicScriptNodeIds.length < classicSources.length) classicScriptNodeIds.push(null);
  const browserFetch =
    network !== null ? networkStackToBrowserFetch(network, base) : undefined;
  const netOpts: {
    browserFetch?: NonNullable<typeof browserFetch>;
    keepAlive?: boolean;
    scriptNodeIds?: (NodeId | null)[];
    currentScriptBox?: { current: NodeId | null };
  } = browserFetch !== undefined ? { browserFetch } : {};
  if (options.keepAlive) netOpts.keepAlive = true;
  netOpts.scriptNodeIds = classicScriptNodeIds;
  const currentScriptBox: { current: NodeId | null } = { current: null };
  netOpts.currentScriptBox = currentScriptBox;
  let run: EventDrivenRun = {
    microtasks: 0,
    timers: 0,
    frames: 0,
    mutations: 0,
    error: null,
  };
  if (classicSources.length > 0) {
    run = await runScriptsOnSessionReal(session, classicSources, fetchFn, netOpts);
  }
  t = mark("classic", t);
  if (options.onAfterClassic !== undefined) {
    await options.onAfterClassic(session);
    t = mark("afterClassic", t);
  }

  const moduleEntries = moduleExternal.loaded.map((modUrl, i) => ({
    url: modUrl,
    source: moduleExternal.sources[i] ?? "",
  }));
  const inlineModules = collected.records.filter((r) => r.kind === "module" && r.inline && r.source);
  for (const rec of inlineModules) {
    if (rec.source === null) continue;
    moduleEntries.push({
      url: `${url}#inline-module-${moduleEntries.length}`,
      source: rec.source,
    });
  }

  const moduleOpts: {
    inheritWindow?: Record<string, unknown>;
    browserFetch?: NonNullable<typeof browserFetch>;
    settleMs?: number;
    budgetMs?: number;
    keepAlive?: boolean;
  } = { settleMs: 400, budgetMs: 16_000 };
  if (browserFetch !== undefined) {
    moduleOpts.browserFetch = browserFetch;
  }
  if (options.keepAlive) moduleOpts.keepAlive = true;
  if (run.sandbox !== undefined) moduleOpts.inheritWindow = run.sandbox;
  const moduleRun = await runModuleScripts(session, moduleEntries, fetchFn, moduleOpts);
  mark("modules", t);
  if (run.drain !== undefined) {
    try {
      run.drain();
    } catch {
      // Guest/page code may throw here; swallowed by design.
    }
  }
  if (run.getMutations !== undefined) {
    run = {
      ...run,
      mutations: run.getMutations() + (moduleRun.mutations ?? 0),
    };
  } else if ((moduleRun.mutations ?? 0) > 0) {
    run = {
      ...run,
      mutations: run.mutations + moduleRun.mutations,
    };
  }

  const errorParts: string[] = [];
  if (run.error !== null) errorParts.push(run.error);
  if (classicExternal.failed.length > 0) {
    errorParts.push(
      `classic fail ${classicExternal.failed.length}: ${classicExternal.failed[0]}${
        classicExternal.failed.length > 1 ? ` (+${classicExternal.failed.length - 1})` : ""
      }`,
    );
  }
  if (moduleExternal.failed.length > 0) {
    errorParts.push(
      `module fetch fail ${moduleExternal.failed.length}: ${moduleExternal.failed[0]}${
        moduleExternal.failed.length > 1 ? ` (+${moduleExternal.failed.length - 1})` : ""
      }`,
    );
  }
  if (!moduleRun.supported && moduleEntries.length > 0) {
    errorParts.push(moduleRun.errors[0] ?? "ESM unsupported");
  }
  if (moduleRun.supported && moduleRun.errors.length > 0) {
    errorParts.push(`esm: ${moduleRun.errors[0]}`);
    if (moduleRun.errors.length > 1) {
      errorParts.push(`(+${moduleRun.errors.length - 1} more module errors)`);
    }
  }

  return {
    session,
    network,
    ...(options.keepAlive
      ? {
          runtime: {
            drainClassic: () => {
              try {
                run.drain?.();
              } catch {
                // Guest/page code may throw here; swallowed by design.
              }
            },
            flushClassic: async (): Promise<void> => {
              try {
                await run.flushAsync?.();
              } catch {
                // Guest/page code may throw here; swallowed by design.
              }
            },
            settleModules:
              moduleRun.settle === undefined ? null : (maxMs?: number) => moduleRun.settle!(maxMs),
            mutations: (): number =>
              (run.getMutations?.() ?? run.mutations) + (moduleRun.getMutations?.() ?? 0),
          },
        }
      : {}),
    scripts: {
      scripts: classicSources.length + moduleEntries.length,
      mutations: run.mutations,
      microtasks: run.microtasks,
      timers: run.timers,
      frames: run.frames,
      error: (classicExternal.failed.length + moduleExternal.failed.length + moduleRun.failed === 0 ? (errorParts.length === 0 ? null : errorParts.join("; ")) : null),
      externalUrls: collected.externalUrls,
      moduleUrls: collected.moduleUrls,
      scriptsLoaded:
        classicExternal.loaded.length + moduleExternal.loaded.length + collected.sources.length,
      scriptsFailed: classicExternal.failed.length + moduleExternal.failed.length + moduleRun.failed,
      cookies: network?.jar.size ?? 0,
      networkEvents: network?.events.length ?? 0,
      modulesEvaluated: moduleRun.evaluated,
      modulesLinked: moduleRun.linked,
      esmSupported: moduleRun.supported,
    },
  };
}

export function createPageNetwork(baseUrl?: string): BrowserNetworkStack {
  return createBrowserNetworkStack({
    timeoutMs: 8_000,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  });
}
