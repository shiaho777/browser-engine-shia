import type { DecodedImage, DomTree, NodeId } from "@browser-engine/ir";
import { MediaEngine, ServiceWorkerRegistry, SharedWorkerRegistry } from "@browser-engine/cli";
import type { MediaFetchInit } from "@browser-engine/cli";
import { decodeImageBytesAsync } from "@browser-engine/backend";
import {
  FineSession,
  collectCrossoriginSettings,
  defaultFetch,
  documentBaseUrl,
  documentCsp,
  documentReferrerPolicy,
  isEsmSupported,
  runModuleScripts,
  runScriptsOnSessionReal,
  type EventDrivenRun,
  type FetchFn,
  type NavigationHost,
  type SessionStorageBag,
} from "@browser-engine/cli";
import {
  createBrowserNetworkStack,
  networkStackToFetchFn,
  networkStackToBrowserFetch,
  parseCoep,
  parseCoop,
  crossOriginIsolated,
  coopSeversOpenerLink,
  type BrowserNetworkStack,
} from "@browser-engine/guest";

export interface ScriptRecord {
  readonly kind: "classic" | "module";
  readonly inline: boolean;
  readonly url: string | null;
  readonly source: string | null;
  readonly nomodule: boolean;
  /** RFC 0027: true when a `script-src` policy refused this script —
   *  the record exists for diagnostics but contributes no fetch/source. */
  readonly blocked?: boolean;
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

export function collectDocumentScripts(
  dom: DomTree,
  baseUrl: string,
  csp?: import("@browser-engine/cli").CspContext | null,
): CollectedScripts {
  const sources: string[] = [];
  const externalUrls: string[] = [];
  const moduleUrls: string[] = [];
  const classicExternalUrls: string[] = [];
  const records: ScriptRecord[] = [];
  let skipped = 0;
  const hasCsp = csp !== null && csp !== undefined && !csp.empty;

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
        // RFC 0027: `script-src` gates the EXTERNAL fetch target. A refused
        // script is recorded (diagnostics) but contributes no fetch/source.
        if (hasCsp) {
          const gated = csp.gateSubresourceUrl(abs);
          // `<script src>` is a script-src-ELEM fetch (CSP3) — the elem chain
          // refines script-src/default-src.
          if (gated.blocked || !csp.check("script", gated.url, "elem").allowed) {
            skipped += 1;
            records.push({
              kind: module ? "module" : "classic",
              inline: false,
              url: abs,
              source: null,
              nomodule: false,
              blocked: true,
            });
            return;
          }
          abs = gated.url;
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
        // RFC 0027: `script-src-elem`/`script-src` gates the INLINE body —
        // 'unsafe-inline'/'unsafe-hashes'/nonce sources may unblock it.
        if (hasCsp &&
          !csp.checkInline(
            "script",
            { nonce: node.attrs?.get("nonce"), text: body },
            "elem",
          ).allowed) {
          skipped += 1;
          records.push({
            kind: module ? "module" : "classic",
            inline: true,
            url: null,
            source: body,
            nodeId: id,
            nomodule: false,
            blocked: true,
          });
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
  /**
   * RFC 0010: dispatch a window-level event into the live sandbox
   * (hashchange/popstate/pageshow…). Null when no live sandbox exists.
   */
  /** Dispatch a host-originated event; result = continued (not canceled). */
  readonly fireEvent: ((type: string, payload?: Record<string, unknown>) => boolean) | null;
  /**
   * RFC 0011: dispatch a click at a DOM node through the live sandbox —
   * identical to `el.click()` (listeners + activation behavior). Null when no
   * live runtime exists (scriptless pages take the host's direct path).
   */
  readonly clickElement: ((nodeId: NodeId) => void) | null;
  /**
   * RFC 0013: dispatch an event AT an element (iframe `load` …). Null without
   * a live runtime.
   */
  readonly dispatchElementEvent:
    | ((nodeId: NodeId, type: string, init?: Record<string, unknown>) => void)
    | null;
  /**
   * RFC 0013: the live sandbox globals — the frame host injects
   *   `parent`/`top`/`frames` proxies and iframe `load` delivery here.
   */
  readonly globals: Record<string, unknown> | null;
  /** RFC 0032: terminate every dedicated `Worker` this document spawned. */
  readonly disposeWorkers: (() => void) | null;
  /**
   * RFC 0033: rasterize every live `<canvas>`'s op log to its current
   * bitmap — the paint path pulls this lazily per render.
   */
  readonly canvasBitmaps: (() => ReadonlyMap<NodeId, DecodedImage>) | null;
  /**
   * RFC 0033: the mutable holder behind `drawImage(imgEl)` resolution —
   * each render publishes the freshest `decodedImages` here so canvas
   * draws see the same images the paint pass used.
   */
  readonly canvasImageBox: { current: ReadonlyMap<NodeId, DecodedImage> | undefined };
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
    /** RFC 0010: the session's navigation bridge for live location/history. */
    readonly sessionHost?: NavigationHost;
    /** RFC 0010: session-scoped local/session storage. */
    readonly storage?: SessionStorageBag;
    /** RFC 0013: iframe nodeId → child context window proxy. */
    readonly frameLookup?: (nodeId: NodeId) => unknown;
    /**
     * RFC 0027: the document response's headers (lowercase names) — the
     * `content-security-policy*` entries become the session's enforce/report
     * policies, together with `<meta http-equiv>` tags parsed from `html`.
     */
    readonly responseHeaders?: Readonly<Record<string, string>>;
    /**
     * RFC 0027: ancestor browsing-context origins (innermost parent first) —
     * consulted by this document's OWN `frame-ancestors` directive.
     */
    readonly ancestorOrigins?: readonly string[];
    /**
     * RFC 0035: the page's real media environment (viewport px, DPR,
     * prefers-*) — `<source media="…">` selection evaluates against it.
     */
    readonly mediaEnv?: import("@browser-engine/css-parser").MediaEnvironment;
    /**
     * RFC 0031: the opener's identity+COOP captured when this document's tab
     * was created. Once THIS document's COOP is parsed (headers, pre-script)
     * the pair is re-checked — a severed link nulls `window.opener` before
     * any of the opened document's scripts observe it.
     */
    readonly openerInfo?: {
      readonly origin: string | null;
      readonly coop: import("@browser-engine/guest").Coop;
      readonly popup: boolean;
    };
  } = {},
): Promise<{
  session: FineSession;
  scripts: ScriptExecutionSummary;
  network: BrowserNetworkStack | null;
  /**
   * RFC 0033: canvas plumbing survives the boot even WITHOUT keepAlive —
   * every repaint (scroll/relayout) must re-rasterize the op logs, and the
   * drawImage(imgEl) box publishes each render's decodedImages. The engines
   * live behind these closures; the guest sandbox itself may be gone.
   */
  canvas: {
    readonly bitmaps: () => ReadonlyMap<NodeId, DecodedImage>;
    readonly imageBox: { current: ReadonlyMap<NodeId, DecodedImage> | undefined };
  };
  /**
   * RFC 0035: the document's media engine — unconditional like `canvas` so
   * scriptless pages still probe/frame <video>/<audio>; PageState carries it
   * for repaint and teardown (`dispose()` kills playback timers).
   */
  media: MediaEngine;
  /** Present only with keepAlive: hooks to pump guest work after boot. */
  runtime?: PageRuntime;
  /** RFC 0027: `frame-ancestors` refused this embedding — the document must
   *  not render (the caller decides whether to even construct a session). */
  cspBlocked?: boolean;
}> {
  const network = options.network ?? null;
  const runScripts = options.runScripts ?? true;
  const sessionOpts =
    options.loadExternalSheet === undefined
      ? {}
      : { loadExternalSheet: options.loadExternalSheet };
  const session = new FineSession(html, url, sessionOpts);
  // RFC 0027: assemble the document's CSP — response headers (navigation-time)
  // plus `<meta http-equiv>` tags from the just-parsed DOM — then install it
  // as a session input BEFORE any style/script query runs. `frame-ancestors`
  // is a navigation directive: a refused embedding yields `cspBlocked` and the
  // document never proceeds to script/style work.
  const csp = documentCsp(session.dom, url, options.responseHeaders);
  session.setCsp(csp.empty ? null : csp);
  // RFC 0031: COEP/COOP/`Origin-Agent-Cluster` response headers — installed
  // before any script runs so `crossOriginIsolated`/`originAgentCluster`
  // globals and subresource COEP gates see them from script-time zero.
  {
    const h = options.responseHeaders ?? {};
    const coep = parseCoep(h["cross-origin-embedder-policy"]);
    const coop = parseCoop(h["cross-origin-opener-policy"]);
    session.setIsolation({
      coep,
      coop,
      originAgentCluster:
        h["origin-agent-cluster"]?.trim() === "?1",
      crossOriginIsolated: crossOriginIsolated(coep, coop),
    });
    // COOP sever (HTML §7.1.3.1): the pair keeps `window.opener` iff BOTH
    // policies tolerate the pairing. The opener-side half ran at open time
    // (target-URL origin); this half resolves once THIS response's COOP is
    // known — before any of this document's scripts run.
    if (options.openerInfo !== undefined && options.sessionHost !== undefined) {
      const info = options.openerInfo;
      let ownOrigin: string | null = null;
      try {
        ownOrigin = new URL(url).origin;
      } catch {
        ownOrigin = null;
      }
      const sameOrigin = ownOrigin !== null && ownOrigin === info.origin;
      const severed =
        coopSeversOpenerLink(info.coop, coop, sameOrigin, info.popup) ||
        coopSeversOpenerLink(coop, info.coop, sameOrigin, info.popup);
      if (severed) options.sessionHost.openerTabId = null;
    }
  }
  const cspBlocked =
    options.ancestorOrigins !== undefined && options.ancestorOrigins.length > 0
      ? !csp.checkAncestors(options.ancestorOrigins)
      : false;
  // RFC 0035: the media engine — created BEFORE the runScripts gate so
  // scriptless documents still fetch/probe/frame <video>/<audio> through the
  // document's real network channel (media-src CSP, COEP, referrer policy,
  // mixed content — the adapter is the stack, not a side channel).
  const mediaDocPolicy = documentReferrerPolicy(session.dom);
  const fetchMedia =
    options.fetchFn !== undefined
      ? async (u: string): Promise<{ bytes: Uint8Array; mime?: string } | null> => {
          const b = await options.fetchFn!(u).catch(() => undefined);
          return b === undefined ? null : { bytes: b };
        }
      : network !== null
        ? async (
            u: string,
            init: MediaFetchInit,
          ): Promise<{ bytes: Uint8Array; mime?: string } | null> => {
            try {
              const res = await network.request({
                url: u,
                destination: init.destination,
                // HTML §media element fetch: no-cors+include by default;
                // `crossorigin` upgrades to cors (anonymous→same-origin creds).
                mode: init.cors === undefined ? "no-cors" : "cors",
                credentials: init.cors?.credentials ?? "include",
                initiator: url,
                ...(mediaDocPolicy !== undefined ? { referrerPolicy: mediaDocPolicy } : {}),
                ...(session.isolation.coep !== "unsafe-none"
                  ? { initiatorCoep: session.isolation.coep }
                  : {}),
              });
              if (!res.ok) return null;
              const mime = res.headers["content-type"];
              return { bytes: res.body, ...(mime !== undefined ? { mime } : {}) };
            } catch {
              return null;
            }
          }
        : undefined;
  const fetchPoster =
    options.fetchFn !== undefined
      ? async (u: string) => {
          const b = await options.fetchFn!(u).catch(() => undefined);
          return b === undefined ? undefined : decodeImageBytesAsync(b);
        }
      : network !== null
        ? async (u: string) => {
            // The poster is an ordinary image fetch — destination "image",
            // img-src gated below via the same csp the element consults.
            try {
              const res = await network.request({
                url: u,
                destination: "image",
                mode: "no-cors",
                credentials: "include",
                initiator: url,
                ...(mediaDocPolicy !== undefined ? { referrerPolicy: mediaDocPolicy } : {}),
                ...(session.isolation.coep !== "unsafe-none"
                  ? { initiatorCoep: session.isolation.coep }
                  : {}),
              });
              if (!res.ok) return undefined;
              return decodeImageBytesAsync(res.body);
            } catch {
              return undefined;
            }
          }
        : undefined;
  const media = new MediaEngine({
    dom: () => session.dom,
    baseUrl: () => documentBaseUrl(session.dom, url),
    setAttribute: (id: NodeId, name: string, v: string) => session.setAttribute(id, name, v),
    removeAttribute: (id: NodeId, name: string) => session.removeAttribute(id, name),
    ...(options.mediaEnv !== undefined ? { mediaEnv: options.mediaEnv } : {}),
    ...(fetchMedia !== undefined ? { fetchMedia } : {}),
    ...(fetchPoster !== undefined ? { fetchPoster } : {}),
    mediaAllowed: (u: string) => {
      if (csp.empty) return true;
      const gated = csp.gateSubresourceUrl(u);
      if (gated.blocked) return false;
      return csp.check("media", gated.url).allowed;
    },
  });
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
      // No scripts ran → no canvas engines exist; empty plumbing keeps the
      // renderDom signature uniform.
      canvas: {
        bitmaps: () => new Map<NodeId, DecodedImage>(),
        imageBox: { current: undefined },
      },
      media,
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
  // RFC 0009/0010: script fetches are subresource requests OF this document —
  // initiator = the document URL, referrer policy = the document's own meta
  // (parsed by now), destination routed per script kind. A caller fetchFn
  // (tests/harness) still wins.
  const docPolicy = documentReferrerPolicy(session.dom);
  // RFC 0028: `<script crossorigin>` upgrades the element's fetch to
  // cors-mode (anonymous or use-credentials); unmarked scripts stay
  // no-cors legacy loads.
  const crossMap = collectCrossoriginSettings(session.dom, url);
  const collected = collectDocumentScripts(session.dom, base, csp);
  const classicUrls = collected.classicExternalUrls.filter((u) => !isLowValueBootScript(u));
  const moduleUrls = collected.moduleUrls.filter((u) => !isLowValueBootScript(u));
  // RFC 0029: script loads declare destination "script" — a classic script
  // fetches as no-cors + credentials include. `crossorigin` attributes
  // override via crossMap.
  const fetchFn =
    options.fetchFn ??
    (network !== null
      ? networkStackToFetchFn(network, {
          initiator: url,
          ...(docPolicy !== undefined ? { referrerPolicy: docPolicy } : {}),
          destination: "script",
          mode: "no-cors",
          credentials: "include",
          // RFC 0031: the document's COEP gates its no-cors subresources.
          ...(session.isolation.coep !== "unsafe-none"
            ? { initiatorCoep: session.isolation.coep }
            : {}),
          ...(crossMap.size > 0 ? { requestFor: (u) => crossMap.get(u) } : {}),
        })
      : defaultFetch);
  // A MODULE graph request is ALWAYS a cors fetch with same-origin
  // credentials (HTML §fetch a module worker/module script graph) — the
  // whole import graph shares it, so the channel can't key off the URL set.
  const fetchFnModules =
    options.fetchFn ??
    (network !== null
      ? networkStackToFetchFn(network, {
          initiator: url,
          ...(docPolicy !== undefined ? { referrerPolicy: docPolicy } : {}),
          destination: "script",
          mode: "cors",
          credentials: "same-origin",
          ...(session.isolation.coep !== "unsafe-none"
            ? { initiatorCoep: session.isolation.coep }
            : {}),
          ...(crossMap.size > 0 ? { requestFor: (u) => crossMap.get(u) } : {}),
        })
      : defaultFetch);
  if (profile) {
    console.error(
      `[profile] boot.scripts classic=${classicUrls.length} module=${moduleUrls.length} inline=${collected.sources.length}`,
    );
  }
  const [classicExternal, moduleExternal] = await Promise.all([
    loadExternalScripts(classicUrls, fetchFn),
    loadExternalScripts(moduleUrls, fetchFnModules),
  ]);
  t = mark("fetchScripts", t);
  const classicSources = [...collected.sources, ...classicExternal.sources];
  // Aligned with classicSources: each source's URL (inline = null) so vm stack
  // frames name the script they came from.
  const classicScriptUrls: (string | null)[] = [];
  for (const rec of collected.records) {
    if (rec.kind === "classic" && rec.inline && !rec.nomodule) {
      classicScriptUrls.push(null);
    }
  }
  while (classicScriptUrls.length < classicSources.length) {
    const extIdx = classicScriptUrls.length - collected.sources.length;
    classicScriptUrls.push(classicUrls[extIdx] ?? null);
  }
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
    network !== null
      ? networkStackToBrowserFetch(
          network,
          base,
          // RFC 0031: the document's own COEP gates its guest `fetch` calls.
          session.isolation.coep,
        )
      : undefined;
  // RFC 0032: classic worker scripts are same-origin-restricted fetches —
  // `destination:"worker"`, `mode:"same-origin"`, creds same-origin (Fetch
  // §"fetch a classic worker script"), gated by the document's COEP.
  const fetchWorkerSource =
    options.fetchFn ??
    (network !== null
      ? networkStackToFetchFn(network, {
          initiator: url,
          ...(docPolicy !== undefined ? { referrerPolicy: docPolicy } : {}),
          destination: "worker",
          mode: "same-origin",
          credentials: "same-origin",
          ...(session.isolation.coep !== "unsafe-none"
            ? { initiatorCoep: session.isolation.coep }
            : {}),
        })
      : undefined);
  const netOpts: {
    browserFetch?: NonNullable<typeof browserFetch>;
    keepAlive?: boolean;
    scriptNodeIds?: (NodeId | null)[];
    scriptUrls?: (string | null)[];
    currentScriptBox?: { current: NodeId | null };
    sessionHost?: NavigationHost;
    storage?: SessionStorageBag;
    frameLookup?: (nodeId: NodeId) => unknown;
    csp?: typeof csp;
    fetchWorkerSource?: (u: string) => Promise<Uint8Array | undefined>;
    canvasImageSource?: (nodeId: NodeId) => DecodedImage | undefined;
    serviceWorkerRegistry?: ServiceWorkerRegistry;
    sharedWorkerRegistry?: SharedWorkerRegistry;
    fetchSharedWorkerSource?: (u: string) => Promise<Uint8Array | undefined>;
    media?: MediaEngine;
  } = browserFetch !== undefined ? { browserFetch } : {};
  // RFC 0033: mutable decoded-image holder — each render publishes the
  // freshest map; `drawImage(imgEl)` resolves through it.
  const canvasImageBox: { current: ReadonlyMap<NodeId, DecodedImage> | undefined } = {
    current: undefined,
  };
  netOpts.canvasImageSource = (nodeId) => canvasImageBox.current?.get(nodeId);
  if (!csp.empty) netOpts.csp = csp;
  if (options.keepAlive) netOpts.keepAlive = true;
  if (options.sessionHost !== undefined) netOpts.sessionHost = options.sessionHost;
  if (options.storage !== undefined) netOpts.storage = options.storage;
  if (options.frameLookup !== undefined) netOpts.frameLookup = options.frameLookup;
  if (fetchWorkerSource !== undefined) netOpts.fetchWorkerSource = fetchWorkerSource;
  netOpts.media = media;
  // RFC 0034: the stack's attached registry doubles as the navigator.
  // serviceWorker container's backing — one registry, two faces.
  const swRegistry = network?.serviceWorker;
  if (swRegistry instanceof ServiceWorkerRegistry) netOpts.serviceWorkerRegistry = swRegistry;
  // RFC 0042: same play for SharedWorker — the stack-bound registry is the
  // sharing scope; the script channel rides destination:"sharedworker".
  const shRegistry = network?.sharedWorkers;
  if (shRegistry instanceof SharedWorkerRegistry && network !== null && network !== undefined) {
    netOpts.sharedWorkerRegistry = shRegistry;
    netOpts.fetchSharedWorkerSource = networkStackToFetchFn(network, {
      initiator: url,
      ...(docPolicy !== undefined ? { referrerPolicy: docPolicy } : {}),
      destination: "sharedworker",
      mode: "same-origin",
      credentials: "same-origin",
      ...(session.isolation.coep !== "unsafe-none"
        ? { initiatorCoep: session.isolation.coep }
        : {}),
    });
  }
  // (moduleOpts gets the same registry below — module scripts share the face)
  netOpts.scriptNodeIds = classicScriptNodeIds;
  netOpts.scriptUrls = classicScriptUrls;
  const currentScriptBox: { current: NodeId | null } = { current: null };
  netOpts.currentScriptBox = currentScriptBox;
  let run: EventDrivenRun = {
    microtasks: 0,
    timers: 0,
    frames: 0,
    mutations: 0,
    error: null,
  };
  // keepAlive boots the document API even with ZERO scripts — a scriptless
  // page still has a live DOM: click activation and form submission (RFC 0011)
  // need its listeners/dispatch machinery.
  if (classicSources.length > 0 || options.keepAlive === true) {
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
    sessionHost?: NavigationHost;
    storage?: SessionStorageBag;
    frameLookup?: (nodeId: NodeId) => unknown;
    settleMs?: number;
    budgetMs?: number;
    keepAlive?: boolean;
    csp?: typeof csp;
    canvasImageSource?: (nodeId: NodeId) => DecodedImage | undefined;
    serviceWorkerRegistry?: ServiceWorkerRegistry;
    sharedWorkerRegistry?: SharedWorkerRegistry;
    fetchSharedWorkerSource?: (u: string) => Promise<Uint8Array | undefined>;
    media?: MediaEngine;
  } = { settleMs: 400, budgetMs: 16_000 };
  moduleOpts.canvasImageSource = (nodeId) => canvasImageBox.current?.get(nodeId);
  if (!csp.empty) moduleOpts.csp = csp;
  if (options.sessionHost !== undefined) moduleOpts.sessionHost = options.sessionHost;
  if (options.storage !== undefined) moduleOpts.storage = options.storage;
  if (options.frameLookup !== undefined) moduleOpts.frameLookup = options.frameLookup;
  if (swRegistry instanceof ServiceWorkerRegistry) moduleOpts.serviceWorkerRegistry = swRegistry;
  if (shRegistry instanceof SharedWorkerRegistry) {
    moduleOpts.sharedWorkerRegistry = shRegistry;
    if (netOpts.fetchSharedWorkerSource !== undefined) {
      moduleOpts.fetchSharedWorkerSource = netOpts.fetchSharedWorkerSource;
    }
  }
  moduleOpts.media = media;
  if (browserFetch !== undefined) {
    moduleOpts.browserFetch = browserFetch;
  }
  if (options.keepAlive) moduleOpts.keepAlive = true;
  if (run.sandbox !== undefined) moduleOpts.inheritWindow = run.sandbox;
  const moduleRun = await runModuleScripts(session, moduleEntries, fetchFnModules, moduleOpts);
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

  // RFC 0027: `report-uri` delivery — one POST per violation per endpoint
  // through the document's network stack (best-effort, fire-and-forget so a
  // dead endpoint cannot stall boot). Without a network stack (tests) the
  // violation list on the context remains the observable artifact;
  // `report-to`/Reporting-API groups are a documented bound.
  if (network !== null && csp.violations.length > 0) {
    for (const endpoint of csp.reportEndpoints()) {
      let abs = endpoint;
      try {
        abs = new URL(endpoint, base).href;
      } catch {
        continue;
      }
      for (const v of csp.violations) {
        void network
          .request({
            url: abs,
            method: "POST",
            headers: { "content-type": "application/csp-report" },
            body: new TextEncoder().encode(csp.reportBody(v)),
            initiator: url,
          })
          .catch(() => undefined);
      }
    }
  }

  // RFC 0033: classic and module runs build SEPARATE document apis — merge
  // both engine maps (same session/dom ⇒ same NodeIds).
  const mergedCanvasBitmaps = (): ReadonlyMap<NodeId, DecodedImage> => {
    const a = run.canvasBitmaps?.();
    const b = moduleRun.canvasBitmaps?.();
    if ((a === undefined || a.size === 0) && (b === undefined || b.size === 0)) {
      return a ?? b ?? new Map();
    }
    if (b === undefined || b.size === 0) return a!;
    if (a === undefined || a.size === 0) return b;
    const merged = new Map(a);
    for (const [k, v] of b) merged.set(k, v);
    return merged;
  };

  return {
    session,
    network,
    canvas: { bitmaps: mergedCanvasBitmaps, imageBox: canvasImageBox },
    media,
    ...(cspBlocked ? { cspBlocked } : {}),
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
            fireEvent: (type: string, payload?: Record<string, unknown>): boolean => {
              const dispatch = run.sandbox?.["dispatchEvent"] as
                | ((event: unknown) => boolean)
                | undefined;
              if (typeof dispatch !== "function") return true;
              try {
                return dispatch({ type, ...(payload ?? {}) });
              } catch {
                // Guest/page code may throw here; a throwing dispatch path
                // does not veto host actions.
                return true;
              }
            },
            clickElement:
              run.clickElement ?? moduleRun.clickElement ?? null,
            dispatchElementEvent:
              run.dispatchElementEvent ?? moduleRun.dispatchElementEvent ?? null,
            globals: run.sandbox ?? null,
            disposeWorkers: run.disposeWorkers ?? null,
            canvasBitmaps: mergedCanvasBitmaps,
            canvasImageBox,
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

/**
 * RFC 0034: the session network stack WITH a service-worker registry wired
 * in — the registry double-serves as the stack's interception seam and the
 * script-fetch client for `register()`. Pass an existing registry to share
 * registrations across stacks (e.g. a whole profile); absent ⇒ a fresh one.
 */
export function createPageNetwork(
  baseUrl?: string,
  swRegistry?: ServiceWorkerRegistry,
  sharedWorkers?: SharedWorkerRegistry,
): BrowserNetworkStack {
  const registry = swRegistry ?? new ServiceWorkerRegistry({
    // Lazy capture: the registry needs the stack to fetch worker scripts,
    // and the stack needs the registry as its interceptor — resolved after
    // construction (register() only ever runs post-construction).
    fetchScript: async (scriptUrl, pageUrl) => {
      const res = await stack.request({
        url: scriptUrl,
        initiator: pageUrl,
        destination: "serviceworker",
        mode: "same-origin",
        credentials: "same-origin",
        skipServiceWorker: true,
      });
      return res.body;
    },
  });
  const stack = createBrowserNetworkStack({
    timeoutMs: 8_000,
    serviceWorker: registry,
    // RFC 0042: the stack doubles as the shared-worker scope — documents
    // sharing the stack (context tree, navigations) share worker realms.
    sharedWorkers: sharedWorkers ?? new SharedWorkerRegistry(),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  });
  return stack;
}
