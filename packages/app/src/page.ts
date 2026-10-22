import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { DecodedImage, DisplayList, DomNode, DomTree, FragmentTree, NodeId, Rect } from "@browser-engine/ir";
import { diffCommands, nodeId, px, unionRect } from "@browser-engine/ir";
import { parseHtml, IncrementalHtmlParser } from "@browser-engine/html-parser";
import { createComputedStyleResolver } from "@browser-engine/cascade";
import { layout } from "@browser-engine/layout";
import { paint } from "@browser-engine/paint";
import { hitTest } from "@browser-engine/layout";
import { encodeSurfaceToPng, renderDisplayListOnGpu } from "@browser-engine/backend";
import {
  cacheLoader,
  collectImagesAsync,
  decodeDataUrl,
  imageSourceCandidates,
  tryDecode,
  defaultFetch,
  collectCrossoriginSettings,
  collectSubresourceDestinations,
  documentBaseUrl,
  documentCsp,
  documentReferrerPolicy,
  documentStylesheets,
  loadResourcesWithTrace,
  warmDecodeImageBytes,
  pipelineFontRegistry,
  pipelineRasterSource,
  pipelinePrimaryFontName,
  pipelineShaperFor,
  registerFontFaces,
  withAppendChild,
  withAttribute,
  withNewNode,
  withText,
  type FetchFn,
} from "@browser-engine/cli";

import {
  DEMO_HTML,
  DEMO_URL,
  errorPageHtml,
  FONTS_HTML,
  FONTS_URL,
  FORM_HTML,
  FORM_URL,
  HOME_HTML,
  HOME_URL,
  LIVE_HTML,
  LIVE_URL,
} from "./home.js";
import {
  DEFAULT_APP_VIEWPORT,
  normalizeViewport,
  type EngineViewport,
} from "./host-api.js";
import { bootFineSession, createPageNetwork, type PageRuntime, type ScriptExecutionSummary } from "./engine-runtime.js";
import type { NavigationHost, SessionStorageBag } from "@browser-engine/cli";
import type { MediaEnvironment } from "@browser-engine/css-parser";
import type { BrowserNetworkStack, NetworkResponse } from "@browser-engine/guest";
import { networkStackToFetchFn, parseCoep } from "@browser-engine/guest";
import { focusOverlayBounds, normalizeFocus, paintFocusOverlay, type EditFocus } from "./focus-overlay.js";
import { buildAxTree } from "./a11y.js";
export type { EditFocus } from "./focus-overlay.js";

const PROFILE = process.env["ENGINE_PROFILE"] === "1";

/**
 * The `MediaEnvironment` for the live page pipeline — viewport dims, the real
 * DPR (for `(resolution: …)`/`srcset`-consistent media queries), and the
 * user's prefers-* settings arriving with the viewport (Electron
 * `nativeTheme`, shell chrome, or HTTP client hints).
 */
function mediaEnvironmentFor(viewport: EngineViewport) {
  return {
    type: "screen" as const,
    widthPx: viewport.width,
    heightPx: viewport.height,
    resolutionDppx: Math.max(1, Math.min(3, Number(viewport.devicePixelRatio ?? 1) || 1)),
    ...(viewport.prefersColorScheme !== undefined
      ? { prefersColorScheme: viewport.prefersColorScheme }
      : {}),
    ...(viewport.prefersReducedMotion === true ? { prefersReducedMotion: true } : {}),
  };
}

function mark(label: string, t0: number): number {
  if (PROFILE) {
    const now = performance.now();
    console.error(`[profile] ${label}=${Math.round(now - t0)}ms`);
    return now;
  }
  return t0;
}

export type { EngineViewport as Viewport };
export { DEFAULT_APP_VIEWPORT, normalizeViewport };
export type { ScriptExecutionSummary };

export interface PageFrame {
  readonly url: string;
  readonly title: string;
  readonly width: number;
  readonly height: number;
  readonly pngBase64: string;
  readonly bytes: number;
  readonly durationMs: number;
  readonly scriptsRun: number;
  readonly mutations: number;
  readonly scriptError: string | null;
  readonly engine: "fine";
  readonly frameRev: number;
  readonly scriptsLoaded: number;
  readonly scriptsFailed: number;
  readonly moduleUrls: number;
  readonly cookies: number;
  readonly networkEvents: number;
  readonly modulesEvaluated: number;
  readonly modulesLinked: number;
  readonly esmSupported: boolean;
}

export type PageImageFetch = (src: string) => Promise<Uint8Array | undefined>;

export interface PageState {
  readonly url: string;
  readonly title: string;
  readonly dom: DomTree;
  readonly fragmentTree: FragmentTree;
  readonly displayList: DisplayList;
  readonly frame: PageFrame;
  readonly viewport: EngineViewport;
  readonly scripts: ScriptExecutionSummary;
  readonly pngBytes: Uint8Array;
  readonly loader?: ReturnType<typeof cacheLoader>;
  readonly imageFetch?: PageImageFetch;
  readonly imageBytes?: Map<string, Uint8Array>;
  readonly decodedImages?: Map<NodeId, DecodedImage>;
  readonly bgImages?: Map<string, DecodedImage>;
  readonly scrollY: number;
  readonly contentHeight: number;
  readonly frameRev: number;
  readonly focus: EditFocus | null;
  /** Present when loaded with keepAlive: lets a host pump guest work + repaint. */
  readonly runtime?: PageRuntime;
  /**
   * RFC 0013: iframe nodeId → the child context's composited frame bitmap.
   * Lives on the page so EVERY repaint path (scroll, relayout, traversal)
   * keeps frames visible.
   */
  readonly frameImages?: ReadonlyMap<NodeId, DecodedImage>;
  /**
   * RFC 0027: the document's CSP context (response headers + `<meta>`), or
   * null when no policy applies. A PARENT context reads this to gate child
   * navigations with `frame-src`; violations accumulate on the context.
   */
  readonly csp?: import("@browser-engine/cli").CspContext | null;
  /** RFC 0027: the document's own `frame-ancestors` refused embedding —
   *  the caller (parent context) renders a blank frame instead. */
  readonly cspBlocked?: boolean;
  /** RFC 0028: cors-anonymous fetch channel for `@font-face` sources. */
  readonly fontFetch?: PageImageFetch;
  /**
   * RFC 0031: the document's isolation policies — parsed from its response
   * headers. A parent context reads `coep` to gate iframe subloads; the tab
   * strip reads `coop`/`crossOriginIsolated` for the chrome UI surface.
   */
  readonly coep?: import("@browser-engine/guest").Coep;
  readonly coop?: import("@browser-engine/guest").Coop;
  readonly originAgentCluster?: boolean;
  readonly crossOriginIsolated?: boolean;
  /** RFC 0037: the accessibility tree for the rendered document — rebuilt
   *  every finishPage so DOM/style/layout edits flow to AT consumers. */
  readonly axTree?: import("./a11y.js").AXNode | null;
  /**
   * RFC 0038: the session's live layout-damage store — carried on the page so
   * `repaintPage` feeds it back into `layout()`. Mutations the guest performs
   * mark it; a repaint consumes the marks and replays undamaged boundaries.
   */
  readonly layoutDamage?: import("@browser-engine/cli").LayoutDamageStore;
  /**
   * RFC 0038: the global inputs the last layout ran with — a change bumps the
   * damage store's epoch so stale entries can never hit.
   */
  readonly layoutInputs?: string;
  /**
   * RFC 0033: canvas engines outlive the sandbox — repaints (scroll,
   * relayout, traversal) must re-rasterize the op logs even when no live
   * `runtime` exists. Present whenever the page ran scripts.
   */
  readonly canvases?: {
    readonly bitmaps: () => ReadonlyMap<NodeId, DecodedImage>;
    readonly imageBox: { current: ReadonlyMap<NodeId, DecodedImage> | undefined };
  };
  /**
   * RFC 0035: the document's media engine — unconditional (scriptless pages
   * probe/frame too). `prime()` runs during each render's resource pass;
   * `frames()` merges current frames into the paint image map; `dispose()`
   * kills playback timers at context teardown.
   */
  readonly media?: import("@browser-engine/cli").MediaEngine;
  /**
   * RFC 0039: retained raster state — the previous frame's clipped command
   * list, its device-pixel buffer, and the focus overlay's paint bounds. The
   * next render diffs commands → damage rect → repairs `pixels` in place.
   */
  readonly raster?: {
    readonly commands: readonly import("@browser-engine/ir").PaintCmd[];
    readonly pixels: Uint8ClampedArray;
    readonly w: number;
    readonly h: number;
    readonly focusRect: Rect | null;
  } | null;
  /** RFC 0039: damage stats of the LAST render — evidence surface. */
  readonly paintDamage?: PaintDamageStats;
  /**
   * RFC 0040: present when the document body streamed in over the wire —
   * `received`/`total` are wire bytes, `snapshots` counts partial-DOM parses
   * the incremental parser produced mid-flight, `nodes` is the final count.
   */
  readonly documentStream?: {
    readonly received: number;
    readonly total: number | null;
    readonly snapshots: number;
    readonly nodes: number;
  };
}

export interface LoadPageOptions {
  readonly fetchFn?: FetchFn;
  readonly viewport?: EngineViewport;
  /** Embedded contexts legitimately render at iframe sizes — floor override. */
  readonly viewportMinEdge?: number;
  readonly runScripts?: boolean;
  /** Keep guest timers/rAF alive after load so pumpFrames can re-render. */
  readonly keepAlive?: boolean;
  /**
   * RFC 0010: the SESSION's shared network stack — cookie jar and HTTP cache
   * survive across navigations. When given, the document fetch goes through
   * it as a real navigation (destination=document, mode=navigate, Referer
   * from `initiator`), and the committed URL is the post-redirect `res.url`.
   */
  readonly network?: BrowserNetworkStack;
  /** RFC 0010: live location/history bridge for the guest sandbox. */
  readonly sessionHost?: NavigationHost;
  /** RFC 0010: session-scoped local/session storage. */
  readonly storage?: SessionStorageBag;
  /** The URL that initiated this navigation (Referer source, SameSite ctx). */
  readonly initiator?: string;
  /**
   * RFC 0011: navigation method/body — form POST submissions ride the
   * document request as a real POST through the owned redirect loop.
   */
  readonly method?: string;
  readonly body?: string;
  readonly contentType?: string;
  /** window.open noreferrer / explicit Referrer-Policy for the navigation. */
  readonly referrerPolicy?: string;
  /**
   * Called with the document response BEFORE parsing — returning "download"
   * consumes the response into the download path and `loadPage` returns null
   * (the navigation is never committed).
   */
  readonly onNavResponse?: (res: NetworkResponse) => "page" | "download" | Promise<"page" | "download">;
  /** RFC 0013: iframe nodeId → its child context's window proxy. */
  readonly frameLookup?: (nodeId: NodeId) => unknown;
  /**
   * RFC 0027: ancestor browsing-context origins (innermost parent first) —
   * a document's own `frame-ancestors` directive is checked against this
   * chain once its response headers are known.
   */
  readonly ancestorOrigins?: readonly string[];
  /**
   * RFC 0031: the EMBEDDER's COEP — a cross-origin iframe navigation under
   * `require-corp` must carry an allowing CORP (and itself be COEP'd).
   */
  readonly initiatorCoep?: import("@browser-engine/guest").Coep;
  /**
   * RFC 0031: the opener's identity+policy captured at `window.open` time —
   * the opened document's own COOP can sever the opener link once ITS
   * response headers are known (before any opened-document script runs).
   */
  readonly openerInfo?: {
    readonly origin: string | null;
    readonly coop: import("@browser-engine/guest").Coop;
    readonly popup: boolean;
  };
}

/**
 * Run one event-loop turn against a live page — timers, rAF, microtasks —
 * so pending guest work mutates the DOM, then repaint. Returns the new state, or
 * the same state unchanged when the page has no live runtime.
 */
export async function pumpFrame(page: PageState, settleMs = 200): Promise<PageState> {
  const runtime = page.runtime;
  if (runtime === undefined) return page;
  runtime.drainClassic();
  await runtime.flushClassic();
  if (runtime.settleModules !== null) {
    await runtime.settleModules(settleMs);
  }
  return repaintPage(page, page.viewport, page.focus, page.scrollY);
}

/** Pump up to `count` frames, stopping early when guest work stops mutating the DOM. */
export async function pumpFrames(
  page: PageState,
  count: number,
  options: { readonly settleMs?: number; readonly idleStop?: boolean } = {},
): Promise<{ page: PageState; frames: number; mutations: number }> {
  const settleMs = options.settleMs ?? 200;
  const startMutations = page.runtime?.mutations() ?? 0;
  let current = page;
  let frames = 0;
  for (let i = 0; i < count; i += 1) {
    const before = current.runtime?.mutations() ?? 0;
    const next = await pumpFrame(current, settleMs);
    frames += 1;
    current = next;
    if (options.idleStop === true && (current.runtime?.mutations() ?? 0) === before) break;
  }
  return {
    page: current,
    frames,
    mutations: (current.runtime?.mutations() ?? 0) - startMutations,
  };
}

export interface EditableHit {
  readonly nodeId: string;
  readonly tag: string;
  readonly value: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly multiline: boolean;
}

/**
 * RFC 0038: fingerprint of the layout-global inputs — viewport box, scroll
 * offset, dpr. Any drift between renders invalidates every cached boundary
 * (fixed pinning, sticky clamping, %-sizes all read these).
 */
function layoutInputKey(viewport: EngineViewport, scrollY: number): string {
  return [
    viewport.width,
    viewport.height,
    scrollY,
    Number(viewport.devicePixelRatio ?? 1) || 1,
  ].join(",");
}

function titleOf(dom: DomTree): string {
  for (const node of dom.nodes.values()) {
    if (node.kind === "element" && node.tag === "title") {
      const texts: string[] = [];
      for (const childId of node.children) {
        const child = dom.nodes.get(childId);
        if (child?.kind === "text" && child.text !== undefined) {
          texts.push(child.text);
        }
      }
      const title = texts.join("").trim();
      if (title !== "") return title;
    }
  }
  return "browser-engine-shia";
}

function commandVisibleInViewport(
  cmd: DisplayList["commands"][number],
  maxY: number,
  maxX: number,
): boolean {
  switch (cmd.op) {
    case "push-clip":
      return true;
    case "rect":
    case "border":
    case "image": {
      const x = Number(cmd.rect.x);
      const y = Number(cmd.rect.y);
      const w = Number(cmd.rect.width);
      const h = Number(cmd.rect.height);
      if (!(w > 0) || !(h > 0)) return false;
      if (y >= maxY || y + h <= 0) return false;
      if (x >= maxX || x + w <= 0) return false;
      return true;
    }
    case "text": {
      const y = Number(cmd.at.y);
      const x = Number(cmd.at.x);
      if (y >= maxY + 64 || y + 64 <= 0) return false;
      if (x >= maxX + 64) return false;
      return true;
    }
    case "line": {
      const y0 = Number(cmd.from.y);
      const y1 = Number(cmd.to.y);
      const x0 = Number(cmd.from.x);
      const x1 = Number(cmd.to.x);
      if (Math.min(y0, y1) >= maxY || Math.max(y0, y1) <= 0) return false;
      if (Math.min(x0, x1) >= maxX) return false;
      return true;
    }
    case "tile": {
      const x = Number(cmd.area.x);
      const y = Number(cmd.area.y);
      const w = Number(cmd.area.width);
      const h = Number(cmd.area.height);
      if (!(w > 0) || !(h > 0)) return false;
      return !(y >= maxY || y + h <= 0 || x >= maxX || x + w <= 0);
    }
    case "pop-clip":
    case "push-layer":
    case "pop-layer":
      return true;
    default:
      return true;
  }
}

function clipDisplayListToViewport(
  list: DisplayList,
  maxHeight: number,
  maxWidth: number,
): DisplayList {
  const commands = list.commands.filter((cmd) =>
    commandVisibleInViewport(cmd, maxHeight, maxWidth),
  );
  return { commands } as unknown as DisplayList;
}

async function renderDom(
  dom: DomTree,
  pageUrl: string,
  viewport: EngineViewport,
  load?: ReturnType<typeof cacheLoader>,
  focus: EditFocus | null = null,
  imageFetch?: (src: string) => Promise<Uint8Array | undefined>,
  scrollYInput = 0,
  frameImages?: ReadonlyMap<NodeId, DecodedImage>,
  csp?: import("@browser-engine/cli").CspContext | null,
  /** RFC 0028: `@font-face` fetches are cors-mode+anonymous by spec — a
   *  dedicated channel; falls back to the generic image fetch. */
  fontFetch?: (src: string) => Promise<Uint8Array | undefined>,
  /** RFC 0033: canvas plumbing — bitmaps merge into paint's image map and
   *  the freshest `decodedImages` publish to `imageBox` each render so
   *  drawImage(imgEl) sees the same images the paint pass used. */
  canvases?: {
    readonly bitmaps: () => ReadonlyMap<NodeId, DecodedImage>;
    readonly imageBox: { current: ReadonlyMap<NodeId, DecodedImage> | undefined };
  } | null,
  /** RFC 0035: media engine — `prime()` fetches/probes in this resource
   *  pass; `frames()` merges the current video frames into paint's map. */
  media?: import("@browser-engine/cli").MediaEngine | null,
  /** RFC 0038: live damage store for incremental layout — when present, the
   *  layout pass replays undamaged formatting-context boundaries. */
  incremental?: import("@browser-engine/cli").LayoutDamageStore,
  /** RFC 0039: previous frame's retained raster — diffs into a damage rect. */
  retained?: PageState["raster"],
): Promise<{
  fragmentTree: FragmentTree;
  displayList: DisplayList;
  width: number;
  height: number;
  png: Uint8Array;
  contentHeight: number;
  scrollY: number;
  decodedImages: Map<NodeId, DecodedImage>;
  bgImages: Map<string, DecodedImage>;
  /** RFC 0037: computed-style resolver — the AX tree reads display/visibility. */
  styleOf: ReturnType<typeof createComputedStyleResolver>;
  /** RFC 0039: retained raster state for the next partial repaint. */
  raster: PageState["raster"];
  /** RFC 0039: damage stats for THIS render — evidence surface. */
  paintDamage: PaintDamageStats;
}> {
  let t = performance.now();
  const viewportBox = { width: viewport.width, height: viewport.height };
  const height = viewport.height;
  const widthLimit = viewport.width;
  const dpr = Math.max(1, Math.min(3, Number(viewport.devicePixelRatio ?? 1) || 1));
  const scrollY = Math.max(0, scrollYInput);
  const maxVisibleImages = 220;
  // RFC 0027: `style-src-elem` gates `<style>`/`<link>` at collection.
  const sheets = documentStylesheets(dom, load, mediaEnvironmentFor(viewport), csp ?? null);
  t = mark("sheets", t);
  // `@font-face` phase (RFC 0006): fetch + register each sheet's webfonts under
  // THIS page's scope before layout — the scoped shaper then resolves them.
  // RFC 0027: font URLs are `font-src` fetches.
  await registerFontFaces(sheets, pipelineFontRegistry, documentBaseUrl(dom, pageUrl), pageUrl, {
    ...(load !== undefined ? { load } : {}),
    ...(fontFetch !== undefined
      ? { fetchBytes: fontFetch }
      : imageFetch !== undefined
        ? { fetchBytes: imageFetch }
        : {}),
    ...(csp !== undefined ? { csp } : {}),
  });
  t = mark("webfonts", t);
  const origins = sheets.map((_, i) => (i === 0 ? ("ua" as const) : ("author" as const)));
  // RFC 0027: `style-src-attr`/`style-src` without 'unsafe-inline' suppresses
  // `style=` declarations at cascade time (attribute kept, declarations win
  // nothing).
  const styleGate =
    csp !== null && csp !== undefined
      ? {
          inlineStyleAllowed: (node: DomNode) =>
            csp.checkInline(
              "style",
              { text: node.attrs?.get("style") ?? "" },
              "attr",
            ).allowed,
        }
      : undefined;
  const styleOf = createComputedStyleResolver(
    dom,
    sheets,
    viewportBox,
    origins,
    undefined,
    styleGate,
  );
  t = mark("styleResolver", t);
  if (incremental !== undefined) {
    // RFC 0038: declare whether any selector can restyle SIBLINGS — a
    // `:first-child`, `+`/`~` combinator, or `:has()` rule makes childList
    // and attribute edits fan out to all of the touched parent's children.
    let structural = false;
    const scan = (rules: readonly { selector?: readonly { text: string }[]; rules?: readonly unknown[] }[]): void => {
      for (const rule of rules) {
        for (const sel of rule.selector ?? []) {
          if (/:?(first-child|last-child|only-child|nth-child|nth-of-type|nth-last-child|nth-last-of-type|empty|has|not)\b|[+~]/.test(sel.text)) {
            structural = true;
            return;
          }
        }
        if (rule.rules !== undefined) scan(rule.rules as typeof rules);
      }
    };
    scan(sheets);
    incremental.siblingSelectors = structural;
  }
  const fragmentTree = layout(dom, styleOf, {
    shaper: pipelineShaperFor(pageUrl),
    viewportWidth: px(viewport.width),
    viewportHeight: px(viewport.height),
    clipMaxY: viewport.height + 80,
    // Real scroll offset: `fixed` boxes pin to the ICB and `sticky` boxes
    // clamp against their thresholds inside the scrollport.
    scrollY,
    ...(incremental !== undefined ? { incremental } : {}),
  });
  t = mark("layout+cascade", t);
  // RFC 0038: this render committed the accumulated damage — clear it so the
  // NEXT mutations mark fresh dirt. Consuming here (not in finishPage) keeps
  // the window tight against mutations landing between layout and paint.
  incremental?.consume();
  const absPos = new Map<import("@browser-engine/ir").FragmentId, { x: number; y: number }>();
  const walkAbs = (id: import("@browser-engine/ir").FragmentId, ox: number, oy: number): void => {
    const frag = fragmentTree.fragments.get(id);
    if (frag === undefined) return;
    const x = ox + Number(frag.box.borderBox.x);
    const y = oy + Number(frag.box.borderBox.y);
    absPos.set(id, { x, y });
    const childOx = ox + Number(frag.box.marginBox.x);
    const childOy = oy + Number(frag.box.marginBox.y);
    for (const childId of frag.children) walkAbs(childId, childOx, childOy);
  };
  walkAbs(fragmentTree.root, 0, 0);
  const rankedImgs: { id: NodeId; y: number; x: number; w: number; h: number; area: number }[] = [];
  const farImgs: { id: NodeId; y: number; x: number; w: number; h: number; area: number }[] = [];
  const imgSlot = new Map<NodeId, number>();
  const imgAttr = (id: NodeId, name: string): string => {
    const node = dom.nodes.get(id);
    return (node?.attrs?.get(name) ?? "").trim().toLowerCase();
  };
  const seenImg = new Set<NodeId>();
  for (const [fragId, frag] of fragmentTree.fragments) {
    const node = dom.nodes.get(frag.node);
    if (node?.kind !== "element" || node.tag !== "img" || seenImg.has(frag.node)) continue;
    const w = Number(frag.box.borderBox.width);
    const h = Number(frag.box.borderBox.height);
    if (!(w >= 20 && h >= 18)) continue;
    const pos = absPos.get(fragId) ?? { x: Number(frag.box.borderBox.x), y: Number(frag.box.borderBox.y) };
    const x = pos.x;
    const y = pos.y;
    imgSlot.set(frag.node, w);
    seenImg.add(frag.node);
    if (y < scrollY + height + 520 && y + h > scrollY - 120 && x < widthLimit + 40 && x + w > -40) {
      rankedImgs.push({
        id: frag.node,
        y,
        x,
        w,
        h,
        area: Math.max(0, w) * Math.max(0, h),
      });
    } else {
      farImgs.push({
        id: frag.node,
        y,
        x,
        w,
        h,
        area: Math.max(0, w) * Math.max(0, h),
      });
    }
  }
  // `loading=lazy` defers fetches until the image nears the viewport — images
  // outside the fetch window are dropped. Eager/absent images are still
  // requested (bounded by the overall budget below), matching spec default.
  // `fetchpriority` orders within each band: high first, low last.
  const prioRank = (id: NodeId): number => {
    const p = imgAttr(id, "fetchpriority");
    return p === "high" ? 0 : p === "low" ? 2 : 1;
  };
  const eagerFar = farImgs
    .filter((item) => imgAttr(item.id, "loading") !== "lazy")
    .sort((a, b) => prioRank(a.id) - prioRank(b.id) || a.y - b.y);
  const visibleEnough = rankedImgs.filter((item) => {
    const x0 = Math.max(0, item.x);
    const y0 = Math.max(scrollY, item.y);
    const x1 = Math.min(widthLimit, item.x + item.w);
    const y1 = Math.min(scrollY + height + 160, item.y + item.h);
    const vis = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
    if (vis <= 0) return false;
    const ratio = vis / Math.max(1, item.area);
    if (item.w >= 400 && item.h >= 200 && ratio < 0.35) return false;
    if (item.w >= 200 && item.h >= 100 && item.w <= 420 && ratio >= 0.08) return true;
    if (item.w >= 120 && item.h >= 60 && ratio >= 0.15) return true;
    if (item.w >= 20 && item.h >= 18 && ratio >= 0.4 && vis >= 400) return true;
    return ratio >= 0.12 || vis >= 4_000;
  });
  visibleEnough.sort((a, b) => b.area - a.area || a.y - b.y || a.x - b.x);
  const stripBand = new Map<number, (typeof visibleEnough)[number]>();
  const withoutExtraStrips: typeof visibleEnough = [];
  for (const item of visibleEnough) {
    if (item.w >= 400 && item.h >= 200) {
      const band = Math.round(item.y / 16);
      const prev = stripBand.get(band);
      if (prev !== undefined && prev.x <= item.x) continue;
      if (prev !== undefined) {
        const idx = withoutExtraStrips.findIndex((p) => p.id === prev.id);
        if (idx >= 0) withoutExtraStrips.splice(idx, 1);
      }
      stripBand.set(band, item);
    }
    withoutExtraStrips.push(item);
  }
  withoutExtraStrips.sort(
    (a, b) => prioRank(a.id) - prioRank(b.id) || b.area - a.area || a.y - b.y || a.x - b.x,
  );
  const picked: typeof rankedImgs = [];
  const geoCount = new Map<string, number>();
  for (const item of withoutExtraStrips) {
    const key = `${Math.round(item.x / 8)}:${Math.round(item.y / 8)}:${Math.round(item.w / 8)}:${Math.round(item.h / 8)}`;
    const n = geoCount.get(key) ?? 0;
    if (n >= 2) continue;
    geoCount.set(key, n + 1);
    picked.push(item);
    if (picked.length >= maxVisibleImages) break;
  }
  for (const item of eagerFar) {
    if (picked.length >= maxVisibleImages) break;
    picked.push(item);
  }
  const visibleImgIds = new Set<NodeId>(picked.map((item) => item.id));
  if (PROFILE) console.error(`[profile] visibleImgs=${visibleImgIds.size} ranked=${rankedImgs.length} frags=${fragmentTree.fragments.size}`);
  // RFC 0027: `img-src` — every image fetch (element, srcset, CSS url()) is a
  // subresource fetch gated by URL; a refused URL yields no bytes so the
  // element renders its broken/placeholder path like a network failure.
  const gateImg =
    csp !== null && csp !== undefined
      ? (src: string): string | null => {
          let abs = src;
          try {
            abs = new URL(src, documentBaseUrl(dom, pageUrl)).href;
          } catch {
            /* keep raw */
          }
          const gated = csp.gateSubresourceUrl(abs);
          if (gated.blocked) return null;
          return csp.check("img", gated.url).allowed ? gated.url : null;
        }
      : null;
  const gatedImageFetch =
    imageFetch === undefined
      ? undefined
      : gateImg === null
        ? imageFetch
        : async (src: string): Promise<Uint8Array | undefined> => {
            const ok = gateImg(src);
            if (ok === null) return undefined;
            return imageFetch(ok);
          };
  // RFC 0035: media elements load in the same resource pass — probe +
  // frame materialization runs parallel with image collection.
  const mediaPrime = media?.prime() ?? null;
  const images = await collectImagesAsync(dom, load, {
    concurrency: 32,
    onlyNodes: visibleImgIds,
    maxImages: maxVisibleImages,
    timeoutMs: 4500,
    ...(gatedImageFetch !== undefined ? { fetchFn: gatedImageFetch } : {}),
    sourceContext: (node) => ({
      dpr,
      viewportWidth: viewport.width,
      ...(imgSlot.has(node.id) ? { slotWidth: imgSlot.get(node.id)! } : {}),
    }),
  });
  await mediaPrime;
  t = mark("images", t);
  if (PROFILE) console.error(`[profile] decodedImgs=${images.size}`);
  const bgDecoded = new Map<string, import("@browser-engine/ir").DecodedImage>();
  const bgSeen = new Set<string>();
  const bgJobs: string[] = [];
  for (const [fragId, frag] of fragmentTree.fragments) {
    const pos = absPos.get(fragId);
    const y = pos?.y ?? Number(frag.box.borderBox.y);
    const h = Number(frag.box.borderBox.height);
    if (y > scrollY + height + 400 || y + h < scrollY - 100) continue;
    const st = styleOf(frag.node);
    const bg = st["backgroundImage"];
    if (typeof bg !== "string" || bg === "none" || !bg.includes("url(")) continue;
    for (const m of bg.matchAll(/url\((['"]?)([^)'"]+)\1\)/gi)) {
      const raw = m[2]!.trim();
      if (raw.startsWith("data:") || bgSeen.has(raw)) continue;
      // RFC 0027: CSS url() images are `img-src` fetches too.
      if (gateImg !== null && gateImg(raw) === null) continue;
      bgSeen.add(raw);
      bgJobs.push(raw);
      if (bgJobs.length >= 48) break;
    }
    if (bgJobs.length >= 48) break;
  }
  if (bgJobs.length > 0 && (load !== undefined || imageFetch !== undefined)) {
    const base = pageUrl;
    await Promise.all(
      bgJobs.slice(0, 32).map(async (src) => {
        try {
          let abs = src;
          try { abs = new URL(src, base).href; } catch { /* invalid URL: keep original src */ }
          let bytes = load?.(abs) ?? load?.(src);
          if (bytes === undefined && imageFetch !== undefined) {
            bytes = await imageFetch(abs);
          }
          if (bytes === undefined) return;
          const decoded = await warmDecodeImageBytes(bytes);
          if (decoded !== undefined) {
            bgDecoded.set(src, decoded);
            bgDecoded.set(abs, decoded);
          }
        } catch { /* warm-up failures are non-fatal */ }
      }),
    );
  }
  const bgDataCache = new Map<string, import("@browser-engine/ir").DecodedImage | undefined>();
  const imageBySrc = (src: string) => {
    const hit = bgDecoded.get(src);
    if (hit !== undefined) return hit;
    if (!src.startsWith("data:")) return undefined;
    if (bgDataCache.has(src)) return bgDataCache.get(src);
    const bytes = decodeDataUrl(src);
    const decoded = bytes === undefined ? undefined : tryDecode(bytes);
    bgDataCache.set(src, decoded);
    return decoded;
  };
  const rootFrag = fragmentTree.fragments.get(fragmentTree.root);
  const contentHeight = Math.max(
    height,
    rootFrag !== undefined ? Number(rootFrag.box.marginBox.height) : height,
  );
  const maxScroll = Math.max(0, contentHeight - height);
  const scrollYClamped = Math.min(scrollY, maxScroll);
  // RFC 0013: iframe elements composite their child context's rendered frame
  // bitmap through the same imageOf channel <img> uses.
  if (frameImages !== undefined) {
    for (const [node, img] of frameImages) {
      if (img !== undefined) images.set(node, img);
    }
  }
  // RFC 0033: `<canvas>` elements paint their Skia-rasterized bitmap through
  // the same channel — rasterized lazily at this exact point each render.
  if (canvases !== null && canvases !== undefined) {
    for (const [node, img] of canvases.bitmaps()) {
      if (img !== undefined) images.set(node, img);
    }
    // …and publish the decoded-image map for drawImage(imgEl) resolution.
    canvases.imageBox.current = images;
  }
  // RFC 0035: a <video>'s current frame is just another DecodedImage —
  // poster or the decoded frame at currentTime, through the same channel.
  if (media !== null && media !== undefined) {
    for (const [node, img] of media.frames()) {
      images.set(node, img);
    }
  }
  const fullDisplayList = paint(fragmentTree, styleOf, (node) => images.get(node), {
    clipMaxY: height,
    scrollY: scrollYClamped,
    imageBySrc,
    // Screen-space viewport rect — `background-attachment: fixed` positions
    // against it (paint emits screen-space commands post scroll shift).
    viewport: { x: px(0), y: px(0), width: px(widthLimit), height: px(height) },
  });
  t = mark("paint", t);
  if (PROFILE) console.error(`[profile] paintCmds=${fullDisplayList.commands.length} bg=${bgDecoded.size} dpr=${dpr}`);
  const displayList = clipDisplayListToViewport(fullDisplayList, height, widthLimit);
  if (PROFILE) console.error(`[profile] clippedCmds=${displayList.commands.length}`);
  t = mark("clip", t);
  const width = widthLimit;
  const newFocusRect = focus !== null ? focusOverlayBounds(fragmentTree, dom, focus) : null;
  const rasterPass = renderWithDamage(displayList, width, height, dpr, retained ?? null, newFocusRect);
  const surface = rasterPass;
  t = mark("gpu", t);
  if (focus !== null) {
    paintFocusOverlay(surface, fragmentTree, dom, focus);
  }
  const png = encodeSurfaceToPng(surface, { level: 1 });
  mark("png", t);
  return {
    fragmentTree,
    displayList: fullDisplayList,
    width,
    height,
    png,
    contentHeight,
    scrollY: scrollYClamped,
    decodedImages: images,
    bgImages: bgDecoded,
    styleOf,
    raster: {
      commands: displayList.commands,
      pixels: surface.pixels,
      w: surface.width,
      h: surface.height,
      focusRect: newFocusRect,
    },
    paintDamage: rasterPass.stats,
  };
}

/**
 * RFC 0039: retained-surface render — diffs the previous clipped command list
 * against the new one; the damage union (plus previous/next focus-overlay
 * bounds) is repaired in place in `prev.pixels`. An identical diff short-
 * circuits rasterization entirely.
 */
export interface PaintDamageStats {
  /** Commands identical between frames (aligned prefix+suffix). */
  readonly unchangedCommands: number;
  /** Commands inside the changed spans. */
  readonly changedCommands: number;
  /** Damage-union area in CSS px² — 0 for an identical frame. */
  readonly damageArea: number;
  readonly viewportArea: number;
  /** The diff produced no damage — the retained buffer was returned as-is. */
  readonly identical: boolean;
  /** A damage-scissored in-place repair actually ran. */
  readonly repaired: boolean;
}

function renderWithDamage(
  displayList: DisplayList,
  width: number,
  height: number,
  dpr: number,
  prev: PageState["raster"] | null,
  focusRect: Rect | null,
): { width: number; height: number; pixels: Uint8ClampedArray; stats: PaintDamageStats } {
  const devW = Math.max(1, Math.round(width * dpr));
  const devH = Math.max(1, Math.round(height * dpr));
  const viewportCss: Rect = { x: px(0), y: px(0), width: px(width), height: px(height) };
  let damage: Rect | null = null;
  let diff: { readonly damage: Rect | null; unchanged: number; changed: number } = {
    damage: null,
    unchanged: 0,
    changed: 0,
  };
  if (prev != null && prev.w === devW && prev.h === devH) {
    diff = diffCommands(prev.commands, displayList.commands, viewportCss);
    damage = unionRect(unionRect(diff.damage, prev.focusRect), focusRect);
    if (damage === null) {
      // Identical frame — the retained buffer already IS the output.
      return {
        width: devW,
        height: devH,
        pixels: prev.pixels,
        stats: {
          unchangedCommands: diff.unchanged,
          changedCommands: diff.changed,
          damageArea: 0,
          viewportArea: width * height,
          identical: true,
          repaired: false,
        },
      };
    }
    const x0 = Math.max(0, Number(damage.x));
    const y0 = Math.max(0, Number(damage.y));
    const x1 = Math.min(width, Number(damage.x) + Number(damage.width));
    const y1 = Math.min(height, Number(damage.y) + Number(damage.height));
    damage = x1 <= x0 || y1 <= y0
      ? null
      : { x: px(x0), y: px(y0), width: px(x1 - x0), height: px(y1 - y0) };
    if (damage === null) {
      return {
        width: devW,
        height: devH,
        pixels: prev.pixels,
        stats: {
          unchangedCommands: diff.unchanged,
          changedCommands: diff.changed,
          damageArea: 0,
          viewportArea: width * height,
          identical: true,
          repaired: false,
        },
      };
    }
  }
  const surface = renderDisplayListOnGpu(displayList, width, height, pipelineRasterSource, {
    clipMaxY: height,
    clipMaxX: width,
    pixelRatio: dpr,
    ...(damage !== null && prev != null ? { damage, into: prev.pixels } : {}),
  });
  return {
    width: surface.width,
    height: surface.height,
    pixels: surface.pixels,
    stats: {
      unchangedCommands: diff.unchanged,
      changedCommands: diff.changed,
      damageArea:
        damage === null ? width * height : Number(damage.width) * Number(damage.height),
      viewportArea: width * height,
      identical: false,
      repaired: damage !== null && prev != null,
    },
  };
}

function toFrame(
  url: string,
  title: string,
  width: number,
  height: number,
  png: Uint8Array,
  durationMs: number,
  scripts: ScriptExecutionSummary,
  frameRev: number,
): PageFrame {
  return {
    url,
    title,
    width,
    height,
    pngBase64: Buffer.from(png).toString("base64"),
    bytes: png.byteLength,
    durationMs,
    scriptsRun: scripts.scripts,
    mutations: scripts.mutations,
    scriptError: scripts.error,
    engine: "fine",
    frameRev,
    scriptsLoaded: scripts.scriptsLoaded,
    scriptsFailed: scripts.scriptsFailed,
    moduleUrls: scripts.moduleUrls.length,
    cookies: scripts.cookies,
    networkEvents: scripts.networkEvents,
    modulesEvaluated: scripts.modulesEvaluated,
    modulesLinked: scripts.modulesLinked,
    esmSupported: scripts.esmSupported,
  };
}

function resolveImageKey(src: string, baseUrl: string): string {
  try {
    return new URL(src, baseUrl).href;
  } catch {
    return src;
  }
}

function makeCombinedImageLoader(
  loader: ReturnType<typeof cacheLoader> | undefined,
  imageBytes: Map<string, Uint8Array> | undefined,
  baseUrl: string,
): ((href: string) => Uint8Array | undefined) | undefined {
  if (loader === undefined && (imageBytes === undefined || imageBytes.size === 0)) {
    return undefined;
  }
  return (href: string): Uint8Array | undefined => {
    const key = resolveImageKey(href, baseUrl);
    const cached = imageBytes?.get(key) ?? imageBytes?.get(href);
    if (cached !== undefined) return cached;
    return loader?.(href);
  };
}

function makeCachingImageFetch(
  fetchFn: PageImageFetch | undefined,
  imageBytes: Map<string, Uint8Array>,
  baseUrl: string,
): PageImageFetch | undefined {
  if (fetchFn === undefined) return undefined;
  return async (src: string): Promise<Uint8Array | undefined> => {
    const key = resolveImageKey(src, baseUrl);
    const hit = imageBytes.get(key) ?? imageBytes.get(src);
    if (hit !== undefined) return hit;
    try {
      const bytes = await fetchFn(src);
      if (bytes !== undefined) {
        imageBytes.set(key, bytes);
        if (src !== key) imageBytes.set(src, bytes);
      }
      return bytes;
    } catch {
      return undefined;
    }
  };
}

function finishPage(
  url: string,
  dom: DomTree,
  rendered: Awaited<ReturnType<typeof renderDom>>,
  viewport: EngineViewport,
  scripts: ScriptExecutionSummary,
  started: number,
  loader: ReturnType<typeof cacheLoader> | undefined,
  frameRev: number,
  focus: EditFocus | null,
  imageFetch?: PageImageFetch,
  imageBytes?: Map<string, Uint8Array>,
  fontFetch?: PageImageFetch,
  canvases?: PageState["canvases"],
  media?: PageState["media"],
): PageState {
  const title = titleOf(dom);
  const state: PageState = {
    url,
    title,
    dom,
    fragmentTree: rendered.fragmentTree,
    displayList: rendered.displayList,
    viewport,
    scripts,
    pngBytes: rendered.png,
    scrollY: rendered.scrollY,
    contentHeight: rendered.contentHeight,
    frameRev,
    focus,
    frame: toFrame(
      url,
      title,
      rendered.width,
      rendered.height,
      rendered.png,
      performance.now() - started,
      scripts,
      frameRev,
    ),
  };
  // RFC 0037: build the AX tree off the same style+layout+focus inputs paint
  // used — AT consumers see exactly what was rendered.
  const axTree = buildAxTree(dom, rendered.styleOf, rendered.fragmentTree, { focus });
  let out: PageState = { ...state, axTree };
  if (loader !== undefined) out = { ...out, loader };
  if (imageFetch !== undefined) out = { ...out, imageFetch };
  if (fontFetch !== undefined) out = { ...out, fontFetch };
  if (imageBytes !== undefined) out = { ...out, imageBytes };
  if (rendered.decodedImages !== undefined) out = { ...out, decodedImages: rendered.decodedImages };
  if (rendered.bgImages !== undefined) out = { ...out, bgImages: rendered.bgImages };
  if (canvases !== undefined) out = { ...out, canvases };
  if (media !== undefined) out = { ...out, media };
  if (rendered.raster !== undefined) out = { ...out, raster: rendered.raster };
  out = { ...out, paintDamage: rendered.paintDamage };
  return out;
}

function collectDocumentImageSrcs(dom: DomTree, maxImages = 120): string[] {
  // Prefetch order: `loading=lazy` images are SKIPPED here entirely (the whole
  // point of lazy is not fetching until the image nears the viewport — layout
  // gating happens later in renderDom). `fetchpriority` orders the warm queue:
  // high first, low last, stable otherwise.
  const entries: { src: string; prio: number; seq: number }[] = [];
  const visit = (id: NodeId): void => {
    const node = dom.nodes.get(id);
    if (node === undefined) return;
    if (node.kind === "element" && node.tag === "img") {
      const loading = (node.attrs?.get("loading") ?? "").trim().toLowerCase();
      if (loading !== "lazy") {
        const p = (node.attrs?.get("fetchpriority") ?? "").trim().toLowerCase();
        const prio = p === "high" ? 0 : p === "low" ? 2 : 1;
        for (const src of imageSourceCandidates(node, true)) {
          if (src.startsWith("data:")) continue;
          if (!entries.some((e) => e.src === src)) {
            entries.push({ src, prio, seq: entries.length });
          }
          break;
        }
      }
    }
    for (const child of node.children) visit(child);
  };
  visit(dom.root);
  entries.sort((a, b) => a.prio - b.prio || a.seq - b.seq);
  return entries.slice(0, maxImages).map((e) => e.src);
}

async function renderHtmlEngine(
  html: string,
  url: string,
  viewport: EngineViewport,
  options: {
    readonly fetchFn?: FetchFn;
    readonly runScripts?: boolean;
    readonly loadExternalSheet?: (href: string) => Uint8Array | undefined;
    readonly resourceLoader?: ReturnType<typeof cacheLoader>;
    readonly resourceCache?: Map<string, Uint8Array> | ReadonlyMap<string, Uint8Array>;
    readonly network?: ReturnType<typeof createPageNetwork>;
    readonly keepAlive?: boolean;
    /** RFC 0010: session navigation bridge → live location/history. */
    readonly sessionHost?: NavigationHost;
    /** RFC 0010: session-scoped storage pair. */
    readonly storage?: SessionStorageBag;
    /** RFC 0013: iframe nodeId → its child context's window proxy. */
    readonly frameLookup?: (nodeId: NodeId) => unknown;
    /** RFC 0027: the navigation response's headers — `content-security-policy*`
     *  entries become the document's enforce/report policies. */
    readonly responseHeaders?: Readonly<Record<string, string>>;
    /** RFC 0027: ancestor browsing-context origins for `frame-ancestors`. */
    readonly ancestorOrigins?: readonly string[];
    /** RFC 0031: the opener's identity+policy for COOP sever decisions —
     *  the opened doc's own COOP resolves against it before scripts run. */
    readonly openerInfo?: {
      readonly origin: string | null;
      readonly coop: import("@browser-engine/guest").Coop;
      readonly popup: boolean;
    };
    /** RFC 0040: streaming-document counters from the fetch loop. */
    readonly documentStream?: PageState["documentStream"];
  } = {},
): Promise<PageState> {
  const started = performance.now();
  // RFC 0010: the new document's URL is committed BEFORE its scripts run —
  // `location.href`/`assign` resolve against THIS document's URL during boot
  // (previously the host still pointed at the outgoing page, so resolves
  // against a stale base silently dropped navigation intents).
  options.sessionHost?.commit(url, null);
  const network = options.network ?? (options.fetchFn === undefined ? createPageNetwork(url) : undefined);
  // The document's referrer policy is known only after parse — the getter is
  // read lazily per request (RFC 0009). Initiator is the page URL so Referer /
  // SameSite cookies / Sec-Fetch-Site all derive from the real origin.
  let docReferrerPolicy: string | undefined;
  // RFC 0028: `crossorigin` attributes pin cors-mode fetches per URL; the
  // pre-boot parse supplies the map (the DOM is stable at parse time).
  const earlyDomForCors = options.fetchFn === undefined && network !== undefined
    ? parseHtml(new TextEncoder().encode(html))
    : null;
  const corsMap =
    earlyDomForCors !== null ? collectCrossoriginSettings(earlyDomForCors, url) : null;
  // RFC 0029: the destination map feeds Mixed Content Level 2 + correct
  // Sec-Fetch-Dest — subresource loads carry their real destination
  // (image/style) instead of falling into the GET-default "navigate" lane.
  const destMap =
    earlyDomForCors !== null ? collectSubresourceDestinations(earlyDomForCors, url) : null;
  // RFC 0031: the document's COEP is only known once its own headers parse
  // inside boot — the resource channel reads it lazily per request.
  const coepRef: { current: import("@browser-engine/guest").Coep } = {
    current: "unsafe-none",
  };
  const fetchForResources =
    options.fetchFn ??
    (network !== undefined
      ? networkStackToFetchFn(network, {
          initiator: url,
          referrerPolicy: () => docReferrerPolicy,
          // HTML §fetch a style/script-like subresource: unmarked loads are
          // no-cors + credentials include (SameSite rules apply in the jar).
          mode: "no-cors",
          credentials: "include",
          get initiatorCoep() {
            return coepRef.current;
          },
          requestFor: (u) => {
            const c = corsMap?.get(u);
            const d = destMap?.get(u);
            if (c === undefined && d === undefined) return undefined;
            return { ...(d !== undefined ? { destination: d } : {}), ...(c ?? {}) };
          },
        })
      : undefined);
  // RFC 0028: `@font-face` sources are ALWAYS cors-anonymous fetches (CSS
  // Fonts 4 §4.9) — a dedicated adapter, not the default channel.
  const fetchForFonts =
    options.fetchFn ??
    (network !== undefined
      ? networkStackToFetchFn(network, {
          initiator: url,
          referrerPolicy: () => docReferrerPolicy,
          destination: "font",
          mode: "cors",
          credentials: "same-origin",
        })
      : undefined);
  const warmImageBytes = new Map<string, Uint8Array>();
  const warmImageInflight = new Map<string, Promise<Uint8Array | undefined>>();
  const bootOptions: {
    fetchFn?: FetchFn;
    runScripts?: boolean;
    loadExternalSheet?: (href: string) => Uint8Array | undefined;
    network?: ReturnType<typeof createPageNetwork>;
    onAfterClassic?: (session: { readonly dom: DomTree }) => void | Promise<void>;
    keepAlive?: boolean;
    sessionHost?: NavigationHost;
    storage?: SessionStorageBag;
    frameLookup?: (nodeId: NodeId) => unknown;
    responseHeaders?: Readonly<Record<string, string>>;
    ancestorOrigins?: readonly string[];
    mediaEnv?: MediaEnvironment;
    openerInfo?: {
      readonly origin: string | null;
      readonly coop: import("@browser-engine/guest").Coop;
      readonly popup: boolean;
    };
  } = {};
  if (options.fetchFn !== undefined) bootOptions.fetchFn = options.fetchFn;
  if (options.runScripts !== undefined) bootOptions.runScripts = options.runScripts;
  if (options.loadExternalSheet !== undefined) bootOptions.loadExternalSheet = options.loadExternalSheet;
  if (network !== undefined) bootOptions.network = network;
  if (options.keepAlive) bootOptions.keepAlive = true;
  if (options.sessionHost !== undefined) bootOptions.sessionHost = options.sessionHost;
  if (options.storage !== undefined) bootOptions.storage = options.storage;
  if (options.frameLookup !== undefined) bootOptions.frameLookup = options.frameLookup;
  if (options.responseHeaders !== undefined) bootOptions.responseHeaders = options.responseHeaders;
  if (options.ancestorOrigins !== undefined) bootOptions.ancestorOrigins = options.ancestorOrigins;
  // RFC 0035: <source media="…"> evaluates against the REAL viewport, not
  // the decoder's default environment.
  bootOptions.mediaEnv = mediaEnvironmentFor(viewport);
  if (options.openerInfo !== undefined) bootOptions.openerInfo = options.openerInfo;
  // RFC 0027: the session's CSP exists only after boot parses `<meta>` —
  // warm-path closures consult this cell once it is populated.
  const cspRef: { current: import("@browser-engine/cli").CspContext | null } = { current: null };
  if (fetchForResources !== undefined) {
    bootOptions.onAfterClassic = (session) => {
      cspRef.current = (session as { csp?: import("@browser-engine/cli").CspContext | null }).csp ?? null;
      coepRef.current =
        (session as { isolation?: { readonly coep?: import("@browser-engine/guest").Coep } })
          .isolation?.coep ?? "unsafe-none";
      const base = documentBaseUrl(session.dom, url);
      docReferrerPolicy = documentReferrerPolicy(session.dom);
      let srcs: string[] = [];
      try {
        srcs = collectDocumentImageSrcs(session.dom, 180);
      } catch {
        srcs = [];
      }
      if (PROFILE) console.error(`[profile] prefetchImgs=${srcs.length}`);
      for (const src of srcs) {
        let abs = src;
        try {
          abs = new URL(src, base).href;
        } catch {
          // Invalid URL input: keep the raw/fallback value.
        }
        // RFC 0027: warm-image prefetch is an `img-src` subresource fetch.
        const warmCsp = cspRef.current;
        if (warmCsp !== null) {
          const gated = warmCsp.gateSubresourceUrl(abs);
          if (gated.blocked || !warmCsp.check("img", gated.url).allowed) continue;
          abs = gated.url;
        }
        if (warmImageBytes.has(abs) || warmImageInflight.has(abs)) continue;
        const job = fetchForResources(abs)
          .then((bytes) => {
            if (bytes !== undefined) {
              warmImageBytes.set(abs, bytes);
              void warmDecodeImageBytes(bytes);
            }
            return bytes;
          })
          .catch(() => undefined)
          .finally(() => {
            warmImageInflight.delete(abs);
          });
        warmImageInflight.set(abs, job);
      }
    };
  }
  let tBoot = performance.now();
  // Reuse the pre-boot parse for stylesheet prefetch AND the cors map when
  // the network path owns fetching (the fetchFn-injected path re-parses).
  const earlyDom =
    earlyDomForCors ??
    (fetchForResources !== undefined ? parseHtml(new TextEncoder().encode(html)) : null);
  // RFC 0027: gate the early stylesheet prefetch with the policies derivable
  // pre-boot — response headers + `<meta>` in the provisional DOM.
  const earlyCsp =
    earlyDom !== null ? documentCsp(earlyDom, url, options.responseHeaders) : null;
  const earlyCssWork =
    earlyDom !== null
      ? loadResourcesWithTrace(earlyDom, url, fetchForResources, {
          stylesheetsOnly: true,
          ...(options.resourceCache !== undefined ? { existing: options.resourceCache } : {}),
          ...(earlyCsp !== null && !earlyCsp.empty ? { csp: earlyCsp } : {}),
        })
      : null;
  const boot = await bootFineSession(html, url, bootOptions);
  tBoot = mark("boot", tBoot);
  cspRef.current = boot.session.csp ?? null;
  // Seed the COEP gate from the parsed session — `onAfterClassic` only fires
  // on the runScripts path, so a scriptless load would otherwise leave the
  // ref at "unsafe-none" and the warm-image CORP check would never engage.
  coepRef.current = boot.session.isolation.coep;
  docReferrerPolicy = documentReferrerPolicy(boot.session.dom);
  const baseForImages = documentBaseUrl(boot.session.dom, url);
  const startWarm = (src: string): void => {
    if (fetchForResources === undefined) return;
    let abs = src;
    try {
      abs = new URL(src, baseForImages).href;
    } catch {
      // Invalid URL input: keep the raw/fallback value.
    }
    // RFC 0027: warm-image fetches are `img-src` subresources.
    if (cspRef.current !== null) {
      const gated = cspRef.current.gateSubresourceUrl(abs);
      if (gated.blocked || !cspRef.current.check("img", gated.url).allowed) return;
      abs = gated.url;
    }
    if (warmImageBytes.has(abs) || warmImageInflight.has(abs)) return;
    const job = fetchForResources(abs)
      .then((bytes) => {
        if (bytes !== undefined) {
          warmImageBytes.set(abs, bytes);
          void warmDecodeImageBytes(bytes);
        }
        return bytes;
      })
      .catch(() => undefined)
      .finally(() => {
        warmImageInflight.delete(abs);
      });
    warmImageInflight.set(abs, job);
  };
  for (const src of collectDocumentImageSrcs(boot.session.dom, 48)) startWarm(src);

  let resourceLoader = options.resourceLoader;
  if (fetchForResources !== undefined) {
    const mergedCache = new Map<string, Uint8Array>();
    if (options.resourceCache !== undefined) {
      for (const [k, v] of options.resourceCache) mergedCache.set(k, v);
    }
    if (earlyCssWork !== null) {
      try {
        const early = await Promise.race([
          earlyCssWork,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 2500)),
        ]);
        if (early !== null) {
          for (const [k, v] of early.cache) mergedCache.set(k, v);
        }
      } catch {
        // Guest/page code may throw here; swallowed by design.
      }
    }
    const postCssWork = loadResourcesWithTrace(boot.session.dom, url, fetchForResources, {
      stylesheetsOnly: true,
      existing: mergedCache,
      ...(cspRef.current !== null ? { csp: cspRef.current } : {}),
    });
    let postDone: { cache: Map<string, Uint8Array> } | null = null;
    try {
      const postOutcome = await Promise.race([
        postCssWork.then((post) => ({ done: true as const, post })),
        new Promise<{ done: false }>((resolve) => setTimeout(() => resolve({ done: false }), 4000)),
      ]);
      if (postOutcome.done) {
        postDone = { cache: new Map(postOutcome.post.cache) };
      } else {
        const late = await Promise.race([
          postCssWork,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
        ]);
        if (late !== null) {
          postDone = { cache: new Map(late.cache) };
        }
      }
    } catch {
      // Guest/page code may throw here; swallowed by design.
    }
    if (postDone !== null) {
      for (const [k, v] of postDone.cache) mergedCache.set(k, v);
      const postLoad = cacheLoader(postDone.cache, documentBaseUrl(boot.session.dom, url));
      const prior = options.resourceLoader;
      resourceLoader =
        prior === undefined
          ? postLoad
          : (href: string) => postLoad(href) ?? prior(href);
    } else if (mergedCache.size > 0) {
      const earlyLoad = cacheLoader(mergedCache, documentBaseUrl(boot.session.dom, url));
      const prior = options.resourceLoader;
      resourceLoader =
        prior === undefined
          ? earlyLoad
          : (href: string) => earlyLoad(href) ?? prior(href);
    }
  }
  tBoot = mark("postCss", tBoot);
  if (resourceLoader !== undefined) {
    boot.session.setExternalSheetLoader(resourceLoader);
  }
  const combinedLoad =
    resourceLoader === undefined && warmImageBytes.size === 0
      ? undefined
      : (href: string): Uint8Array | undefined => {
          try {
            const abs = new URL(href, baseForImages).href;
            const warm = warmImageBytes.get(abs) ?? warmImageBytes.get(href);
            if (warm !== undefined) return warm;
          } catch {
            const warm = warmImageBytes.get(href);
            if (warm !== undefined) return warm;
          }
          return resourceLoader?.(href);
        };
  const rawImageFetch =
    fetchForResources !== undefined
      ? async (src: string): Promise<Uint8Array | undefined> => {
          try {
            const abs = new URL(src, baseForImages).href;
            const warm = warmImageBytes.get(abs);
            if (warm !== undefined) return warm;
            const inflight = warmImageInflight.get(abs);
            if (inflight !== undefined) {
              const bytes = await inflight;
              if (bytes !== undefined) warmImageBytes.set(abs, bytes);
              return bytes;
            }
            const bytes = await fetchForResources(abs);
            if (bytes !== undefined) warmImageBytes.set(abs, bytes);
            return bytes;
          } catch {
            return undefined;
          }
        }
      : undefined;
  const imageFetch = makeCachingImageFetch(rawImageFetch, warmImageBytes, baseForImages);
  tBoot = mark("prefetchWait", tBoot);
  if (PROFILE) console.error(`[profile] warmBytes=${warmImageBytes.size} warmInflight=${warmImageInflight.size}`);
  const rendered = await renderDom(
    boot.session.dom,
    url,
    viewport,
    combinedLoad,
    null,
    imageFetch,
    0,
    undefined,
    cspRef.current,
    fetchForFonts,
    boot.canvas,
    boot.media,
    boot.session.layoutDamage,
  );
  mark("renderDom", tBoot);
  const page0 = finishPage(
    url,
    boot.session.dom,
    rendered,
    viewport,
    boot.scripts,
    started,
    resourceLoader,
    1,
    null,
    imageFetch,
    warmImageBytes,
    fetchForFonts,
    boot.canvas,
    boot.media,
  );
  // RFC 0027: expose the document's policy context on the page — a PARENT
  // context reads it for `frame-src` gating of child navigations; a refused
  // `frame-ancestors` verdict propagates as `cspBlocked`.
  let page: PageState = page0;
  if (cspRef.current !== null) page = { ...page, csp: cspRef.current };
  if (boot.cspBlocked === true) page = { ...page, cspBlocked: true };
  // RFC 0038: carry the session's damage store + the input fingerprint so
  // repaints feed the cache and detect global-input changes.
  page = {
    ...page,
    layoutDamage: boot.session.layoutDamage,
    layoutInputs: layoutInputKey(viewport, 0),
  };
  // RFC 0031: isolation state survives on the page — a parent context reads
  // `coep` to gate this document's iframe subloads; chrome reads `coop`/
  // `crossOriginIsolated` off NavState.
  page = {
    ...page,
    coep: boot.session.isolation.coep,
    coop: boot.session.isolation.coop,
    originAgentCluster: boot.session.isolation.originAgentCluster,
    crossOriginIsolated: boot.session.isolation.crossOriginIsolated,
  };
  if (options.documentStream !== undefined) {
    page = { ...page, documentStream: options.documentStream };
  }
  if (boot.runtime !== undefined && options.keepAlive) {
    return { ...page, runtime: boot.runtime };
  }
  return page;
}

export function findLinkHref(dom: DomTree, node: NodeId): string | null {
  let current: NodeId | null = node;
  while (current !== null) {
    const item = dom.nodes.get(current);
    if (item === undefined) {
      return null;
    }
    if (item.kind === "element") {
      const attrs = item.attrs;
      if (attrs !== undefined) {
        if (item.tag === "a") {
          const href = attrs.get("href");
          if (href !== undefined && href.trim() !== "" && href.trim() !== "#") {
            return href.trim();
          }
        }
        const dataHref = attrs.get("data-href") ?? attrs.get("data-url") ?? attrs.get("data-target-url");
        if (dataHref !== undefined && dataHref.trim() !== "") {
          return dataHref.trim();
        }
        const role = attrs.get("role");
        if (role === "link") {
          const href = attrs.get("href");
          if (href !== undefined && href.trim() !== "") return href.trim();
        }
      }
    }
    current = item.parent;
  }
  return null;
}

export function resolveNavigationTarget(href: string, baseUrl: string): string {
  const trimmed = href.trim();
  if (trimmed === "" || trimmed === "#") {
    return baseUrl;
  }
  if (/^(https?:\/\/|engine:\/\/|file:\/\/|about:)/i.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith("//")) {
    try {
      const base = new URL(baseUrl);
      return `${base.protocol}${trimmed}`;
    } catch {
      return `https:${trimmed}`;
    }
  }
  try {
    return new URL(trimmed, baseUrl).href;
  } catch {
    return trimmed;
  }
}

export function tagOf(dom: DomTree, node: NodeId): string | null {
  const item = dom.nodes.get(node);
  if (item === undefined) return null;
  if (item.kind === "element") return item.tag ?? null;
  return item.kind;
}

function maxNodeId(dom: DomTree): number {
  let max = 0;
  for (const id of dom.nodes.keys()) {
    const n = Number(id);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

function elementText(dom: DomTree, element: NodeId): string {
  const node = dom.nodes.get(element);
  if (node === undefined) return "";
  if (node.kind === "element" && node.tag === "input") {
    return node.attrs?.get("value") ?? "";
  }
  const parts: string[] = [];
  const visit = (id: NodeId): void => {
    const n = dom.nodes.get(id);
    if (n === undefined) return;
    if (n.kind === "text" && n.text !== undefined) {
      parts.push(n.text);
      return;
    }
    for (const child of n.children) visit(child);
  };
  visit(element);
  return parts.join("");
}

export function findEditableNode(dom: DomTree, from: NodeId): NodeId | null {
  let current: NodeId | null = from;
  while (current !== null) {
    const item = dom.nodes.get(current);
    if (item === undefined) return null;
    if (item.kind === "element") {
      const tag = item.tag ?? "";
      if (tag === "textarea") return current;
      if (tag === "input") {
        // Only text-entry input kinds are editable — button/checkable inputs
        // (submit/checkbox/radio/…) activate, they don't take a caret.
        const type = (item.attrs?.get("type") ?? "").toLowerCase();
        const textLike =
          type === "" ||
          type === "text" ||
          type === "search" ||
          type === "url" ||
          type === "tel" ||
          type === "password" ||
          type === "email" ||
          type === "number";
        if (textLike) return current;
      }
      if (item.attrs?.has("data-editable")) return current;
    }
    current = item.parent;
  }
  return null;
}

export function setElementText(dom: DomTree, element: NodeId, text: string): DomTree {
  const node = dom.nodes.get(element);
  if (node === undefined || node.kind !== "element") return dom;
  let next = dom;
  if (node.tag === "input") {
    next = withAttribute(next, element, "value", text);
  }
  let textChild: NodeId | null = null;
  for (const child of node.children) {
    const c = next.nodes.get(child);
    if (c?.kind === "text") {
      textChild = child;
      break;
    }
  }
  if (textChild !== null) {
    return withText(next, textChild, text);
  }
  if (node.tag === "input" && text === (node.attrs?.get("value") ?? "")) {
    return next;
  }
  const id = nodeId(maxNodeId(next) + 1);
  const created: DomNode = {
    id,
    kind: "text",
    text,
    children: [],
    parent: null,
  };
  next = withNewNode(next, created);
  next = withAppendChild(next, element, id);
  return next;
}


export function fastScrollPaint(
  page: PageState,
  viewport: EngineViewport,
  scrollYInput: number,
  options: { readonly pixelRatio?: number; readonly quality?: "fast" | "full" } = {},
): Promise<PageState> {
  const started = performance.now();
  const height = viewport.height;
  const width = viewport.width;
  const dprIn = options.pixelRatio ?? viewport.devicePixelRatio ?? 1;
  const dpr =
    options.quality === "fast"
      ? Math.max(1, Math.min(1.5, Number(dprIn) || 1))
      : Math.max(1, Math.min(3, Number(dprIn) || 1));
  const rootFrag = page.fragmentTree.fragments.get(page.fragmentTree.root);
  const contentHeight = Math.max(
    height,
    page.contentHeight || (rootFrag !== undefined ? Number(rootFrag.box.marginBox.height) : height),
  );
  const maxScroll = Math.max(0, contentHeight - height);
  const scrollY = Math.max(0, Math.min(maxScroll, scrollYInput));
  const sheets = documentStylesheets(page.dom, page.loader, mediaEnvironmentFor(viewport));
  const origins = sheets.map((_, i) => (i === 0 ? ("ua" as const) : ("author" as const)));
  const styleOf = createComputedStyleResolver(page.dom, sheets, { width, height }, origins);
  const decoded = new Map(page.decodedImages ?? []);
  // RFC 0013: iframe frame bitmaps composite through the same image channel.
  if (page.frameImages !== undefined) {
    for (const [n, img] of page.frameImages) {
      if (img !== undefined) decoded.set(n, img);
    }
  }
  const bgImages = page.bgImages ?? new Map<string, DecodedImage>();
  const imageBySrc = (src: string) => bgImages.get(src);
  // `fixed`/`sticky` boxes move per scroll offset: re-layout when any exist
  // (cheap enough at engine scale) — otherwise reuse the cached tree.
  let fragmentTree = page.fragmentTree;
  let hasViewportPinned = false;
  for (const [id, node] of page.dom.nodes) {
    if (node.kind !== "element") continue;
    const pos = styleOf(id)["position"];
    if (pos === "fixed" || pos === "sticky") {
      hasViewportPinned = true;
      break;
    }
  }
  if (hasViewportPinned) {
    fragmentTree = layout(page.dom, styleOf, {
      shaper: pipelineShaperFor(page.url),
      viewportWidth: px(width),
      viewportHeight: px(height),
      clipMaxY: height + 80,
      scrollY,
    });
  }
  const fullDisplayList = paint(
    fragmentTree,
    styleOf,
    (node) => decoded.get(node),
    {
      clipMaxY: height,
      scrollY,
      imageBySrc,
      viewport: { x: px(0), y: px(0), width: px(width), height: px(height) },
    },
  );
  const displayList = clipDisplayListToViewport(fullDisplayList, height, width);
  const newFocusRect =
    page.focus !== null ? focusOverlayBounds(fragmentTree, page.dom, page.focus) : null;
  const rasterPass = renderWithDamage(displayList, width, height, dpr, page.raster ?? null, newFocusRect);
  const surface = rasterPass;
  if (page.focus !== null) {
    paintFocusOverlay(surface, fragmentTree, page.dom, page.focus);
  }
  const png = encodeSurfaceToPng(surface, { level: 1 });
  const frame = toFrame(
    page.url,
    page.title,
    width,
    height,
    png,
    performance.now() - started,
    page.scripts,
    page.frameRev + 1,
  );
  return Promise.resolve({
    ...page,
    displayList: fullDisplayList,
    pngBytes: png,
    scrollY,
    contentHeight,
    frameRev: page.frameRev + 1,
    frame,
    viewport,
    decodedImages: decoded,
    bgImages,
    raster: {
      commands: displayList.commands,
      pixels: surface.pixels,
      w: surface.width,
      h: surface.height,
      focusRect: newFocusRect,
    },
    paintDamage: rasterPass.stats,
    ...(page.frameImages !== undefined ? { frameImages: page.frameImages } : {}),
  });
}

export async function repaintPage(
  page: PageState,
  viewport: EngineViewport,
  focus: EditFocus | null = page.focus,
  scrollY: number = page.scrollY ?? 0,
  options: { readonly frameImages?: ReadonlyMap<NodeId, DecodedImage> } = {},
): Promise<PageState> {
  const started = performance.now();
  const imageBytes = page.imageBytes ?? new Map<string, Uint8Array>();
  const combinedLoad = makeCombinedImageLoader(page.loader, imageBytes, page.url);
  const imageFetch = makeCachingImageFetch(page.imageFetch, imageBytes, page.url);
  const frameImages = options.frameImages ?? page.frameImages;
  const damage = page.layoutDamage;
  const nextLayoutInputs = layoutInputKey(viewport, scrollY);
  if (damage !== undefined && page.layoutInputs !== nextLayoutInputs) {
    // Viewport/scroll/dpr moved — every cached boundary's external inputs
    // changed; bump the epoch so the entries can never hit.
    damage.epoch += 1;
  }
  const rendered = await renderDom(
    page.dom,
    page.url,
    viewport,
    combinedLoad,
    focus,
    imageFetch,
    scrollY,
    frameImages,
    page.csp ?? null,
    page.fontFetch,
    page.canvases ?? null,
    page.media ?? null,
    damage,
    page.raster ?? null,
  );
  const next = finishPage(
    page.url,
    page.dom,
    rendered,
    viewport,
    page.scripts,
    started,
    page.loader,
    page.frameRev + 1,
    focus,
    page.imageFetch ?? imageFetch,
    imageBytes,
    page.fontFetch,
    page.canvases,
    page.media,
  );
  const carried =
    frameImages !== undefined ? { ...next, frameImages } : next;
  const withCsp =
    page.csp !== undefined ? { ...carried, csp: page.csp } : carried;
  const withIso = carryIsolation(page, withCsp);
  const withDamage: PageState = {
    ...withIso,
    ...(damage !== undefined ? { layoutDamage: damage, layoutInputs: nextLayoutInputs } : {}),
  };
  return page.runtime !== undefined ? { ...withDamage, runtime: page.runtime } : withDamage;
}

/** Carry a page's RFC 0031 isolation state onto a rebuilt PageState. */
function carryIsolation(from: PageState, to: PageState): PageState {
  return {
    ...to,
    ...(from.coep !== undefined ? { coep: from.coep } : {}),
    ...(from.coop !== undefined ? { coop: from.coop } : {}),
    ...(from.originAgentCluster !== undefined
      ? { originAgentCluster: from.originAgentCluster }
      : {}),
    ...(from.crossOriginIsolated !== undefined
      ? { crossOriginIsolated: from.crossOriginIsolated }
      : {}),
  };
}

export async function applyTextEdit(
  page: PageState,
  element: NodeId,
  text: string,
  viewport: EngineViewport,
  focusInput: Omit<EditFocus, "nodeId"> | null = null,
): Promise<PageState> {
  const dom = setElementText(page.dom, element, text);
  const focus =
    focusInput === null
      ? null
      : normalizeFocus(
          {
            nodeId: element,
            caret: focusInput.caret,
            selStart: focusInput.selStart,
            selEnd: focusInput.selEnd,
          },
          text.length,
        );
  const started = performance.now();
  const imageBytes = page.imageBytes ?? new Map<string, Uint8Array>();
  const combinedLoad = makeCombinedImageLoader(page.loader, imageBytes, page.url);
  const imageFetch = makeCachingImageFetch(page.imageFetch, imageBytes, page.url);
  const rendered = await renderDom(
    dom,
    page.url,
    viewport,
    combinedLoad,
    focus,
    imageFetch,
    page.scrollY ?? 0,
    page.frameImages,
    page.csp ?? null,
    page.fontFetch,
    page.canvases ?? null,
    page.media ?? null,
  );
  const finished = finishPage(
    page.url,
    dom,
    rendered,
    viewport,
    page.scripts,
    started,
    page.loader,
    page.frameRev + 1,
    focus,
    page.imageFetch ?? imageFetch,
    imageBytes,
    page.fontFetch,
    page.canvases,
    page.media,
  );
  const carried =
    page.frameImages !== undefined ? { ...finished, frameImages: page.frameImages } : finished;
  const withCsp =
    page.csp !== undefined ? { ...carried, csp: page.csp } : carried;
  const withIso = carryIsolation(page, withCsp);
  // Editing must not kill the live runtime — guest listeners/activation stay.
  return page.runtime !== undefined ? { ...withIso, runtime: page.runtime } : withIso;
}

export async function applyFocus(page: PageState, focus: EditFocus | null): Promise<PageState> {
  const textLen =
    focus === null ? 0 : elementText(page.dom, focus.nodeId).length;
  const nextFocus = focus === null ? null : normalizeFocus(focus, textLen);
  return repaintPage(page, page.viewport, nextFocus);
}

export function editableHitFromPoint(page: PageState, x: number, y: number): EditableHit | null {
  const scrollY = page.scrollY ?? 0;
  const hit = hitTest(page.fragmentTree, x, y + scrollY);
  if (hit === null) return null;
  const editable = findEditableNode(page.dom, hit.node);
  if (editable === null) return null;
  const node = page.dom.nodes.get(editable);
  if (node === undefined || node.kind !== "element") return null;
  let box = { x: hit.x, y: hit.y - scrollY, width: hit.width, height: hit.height };
  for (const fragment of page.fragmentTree.fragments.values()) {
    if (fragment.node === editable) {
      const b = fragment.box.borderBox;
      box = {
        x: Number(b.x),
        y: Number(b.y) - scrollY,
        width: Number(b.width),
        height: Number(b.height),
      };
      break;
    }
  }
  const tag = node.tag ?? "div";
  return {
    nodeId: String(editable),
    tag,
    value: elementText(page.dom, editable),
    x: box.x,
    y: box.y,
    width: Math.max(box.width, 40),
    height: Math.max(box.height, 24),
    multiline: tag === "textarea" || node.attrs?.get("data-editable") === "multiline",
  };
}

export async function loadPage(
  target: string,
  options: LoadPageOptions | FetchFn = {},
): Promise<PageState | null> {
  const opts: LoadPageOptions =
    typeof options === "function" ? { fetchFn: options } : options;
  const viewport = normalizeViewport(opts.viewport, undefined, opts.viewportMinEdge ?? 200);
  const runScripts = opts.runScripts ?? true;
  const trimmed = target.trim();
  const networkBase =
    trimmed === "" ||
    trimmed === HOME_URL ||
    trimmed === "about:home" ||
    trimmed === "engine://home" ||
    trimmed === "/"
      ? HOME_URL
      : trimmed;
  // RFC 0010: prefer the SESSION's shared stack — its cookie jar and HTTP
  // cache survive navigation. A caller-supplied fetchFn (tests) still wins.
  const network = opts.network ?? (opts.fetchFn === undefined ? createPageNetwork(networkBase) : null);
  // When the session stack exists, leave `fetchFn` UNDEFINED so
  // renderHtmlEngine builds its own gated subresource channel (no-cors mode,
  // destination map, lazy COEP ref). A bare adapter here would shadow that
  // channel and silently drop CORP/mixed-content/destination semantics.
  const fetchFn: FetchFn | undefined =
    opts.fetchFn ?? (network !== null ? undefined : defaultFetch);
  const fetchOpt = fetchFn !== undefined ? { fetchFn } : {};
  const sessionOpts = {
    ...(opts.sessionHost !== undefined ? { sessionHost: opts.sessionHost } : {}),
    ...(opts.storage !== undefined ? { storage: opts.storage } : {}),
    ...(opts.frameLookup !== undefined ? { frameLookup: opts.frameLookup } : {}),
  };

  if (
    trimmed === "" ||
    trimmed === HOME_URL ||
    trimmed === "about:home" ||
    trimmed === "engine://home" ||
    trimmed === "/"
  ) {
    return renderHtmlEngine(HOME_HTML, HOME_URL, viewport, { ...fetchOpt, runScripts, ...(network !== null ? { network } : {}), ...sessionOpts });
  }

  if (trimmed === DEMO_URL || trimmed === "engine://demo") {
    return renderHtmlEngine(DEMO_HTML, DEMO_URL, viewport, { ...fetchOpt, runScripts, ...(network !== null ? { network } : {}), ...sessionOpts });
  }

  if (trimmed === LIVE_URL || trimmed === "engine://live") {
    return renderHtmlEngine(LIVE_HTML, LIVE_URL, viewport, { ...fetchOpt, runScripts, ...(network !== null ? { network } : {}), ...sessionOpts });
  }

  if (trimmed === FONTS_URL || trimmed === "engine://fonts") {
    const html = FONTS_HTML.replaceAll("{{FONT_STACK}}", pipelinePrimaryFontName());
    return renderHtmlEngine(html, FONTS_URL, viewport, { ...fetchOpt, runScripts, ...(network !== null ? { network } : {}), ...sessionOpts });
  }

  if (trimmed === FORM_URL || trimmed === "engine://form") {
    return renderHtmlEngine(FORM_HTML, FORM_URL, viewport, { ...fetchOpt, runScripts, ...(network !== null ? { network } : {}), ...sessionOpts });
  }

  if (trimmed.startsWith("file://")) {
    const filePath = fileURLToPath(trimmed);
    const html = readFileSync(filePath, "utf8");
    const url = pathToFileURL(filePath).href;
    return renderHtmlEngine(html, url, viewport, { ...fetchOpt, runScripts, ...(network !== null ? { network } : {}), ...(opts.keepAlive ? { keepAlive: true } : {}), ...sessionOpts });
  }

  if (!/^(https?:\/\/|engine:\/\/)/i.test(trimmed)) {
    const asPath = resolve(trimmed);
    if (existsSync(asPath)) {
      return loadPage(pathToFileURL(asPath).href, opts);
    }
    if (trimmed.includes("<") && trimmed.includes(">")) {
      return renderHtmlEngine(trimmed, "engine://inline", viewport, { ...fetchOpt, runScripts, ...(network !== null ? { network } : {}), ...(opts.keepAlive ? { keepAlive: true } : {}), ...sessionOpts });
    }
    return loadPage(`https://${trimmed}`, opts);
  }

  let rootBytes: Uint8Array | undefined;
  let documentUrl = trimmed;
  // RFC 0027: the navigation response's headers feed the document's CSP
  // (content-security-policy + -report-only entries).
  let navHeaders: Readonly<Record<string, string>> | undefined;
  // RFC 0040: populated when the document streamed in — wire-byte counters
  // and how many partial-DOM snapshots the incremental parser produced.
  let documentStream: PageState["documentStream"];
  try {
    if (network !== null) {
      // RFC 0010: the document fetch IS a navigation — destination=document,
      // mode=navigate, initiator=the referring document. The session stack's
      // owned redirect loop means `res.url` is where we actually landed.
      const navReq = {
        url: trimmed,
        // RFC 0029: child-context navigations declare destination "iframe"
        // (Fetch Metadata §4.3 — the true Sec-Fetch-Dest for frames) so
        // baseline mixed-content can BLOCK them while top-level navigations
        // stay exempt. `ancestorOrigins` is only set for frame loads.
        destination: opts.ancestorOrigins !== undefined ? ("iframe" as const) : ("document" as const),
        mode: "navigate" as const,
        ...(opts.method !== undefined ? { method: opts.method } : {}),
        ...(opts.body !== undefined ? { body: new TextEncoder().encode(opts.body) } : {}),
        ...(opts.contentType !== undefined
          ? { headers: { "content-type": opts.contentType } }
          : {}),
        ...(opts.initiator !== undefined ? { initiator: opts.initiator } : {}),
        ...(opts.initiatorCoep !== undefined
          ? { initiatorCoep: opts.initiatorCoep }
          : {}),
        ...(opts.referrerPolicy !== undefined
          ? { referrerPolicy: opts.referrerPolicy }
          : {}),
      };
      const stackStreaming =
        (network as { requestStream?: unknown }).requestStream !== undefined
          ? (network as {
              requestStream(r: typeof navReq): Promise<import("@browser-engine/guest").StreamingNetworkResponse>;
            })
          : null;
      if (stackStreaming !== null) {
        // RFC 0040: the body streams off the wire — each chunk feeds the
        // incremental parser; a snapshot per chunk polls the partial DOM.
        const streaming = await stackStreaming.requestStream(navReq);
        const head = {
          url: streaming.url,
          status: streaming.status,
          ok: streaming.ok,
          headers: streaming.headers,
          body: new Uint8Array(),
        };
        // A response can veto the commit — Content-Disposition: attachment
        // routes to the download path and the navigation evaporates. The veto
        // consumes `res.body` for the saved file, so drain the wire first.
        if (opts.onNavResponse !== undefined) {
          const payload = await streaming.collect();
          const full = { ...head, body: payload };
          const verdict = await opts.onNavResponse(full);
          if (verdict === "download") return null;
          // "page": the drained bytes are the document — feed them through
          // the incremental parser as one chunk (nothing left on the wire).
          if (full.ok) {
            const parser = new IncrementalHtmlParser();
            parser.write(payload);
            const final = parser.finish();
            rootBytes = payload;
            documentUrl = full.url !== "" ? full.url : trimmed;
            navHeaders = full.headers;
            documentStream = {
              received: parser.receivedBytes,
              total: streaming.totalBytes,
              snapshots: parser.snapshots,
              nodes: final.tree.nodes.size,
            };
          }
        } else if (head.ok) {
          const parser = new IncrementalHtmlParser();
          const parts: Uint8Array[] = [];
          let received = 0;
          for await (const chunk of streaming.bodyStream) {
            parser.write(chunk);
            parser.snapshot(); // partial-DOM poll — memoized per byte count
            parts.push(chunk);
            received += chunk.byteLength;
          }
          const final = parser.finish();
          const collected = new Uint8Array(received);
          let off = 0;
          for (const p of parts) {
            collected.set(p, off);
            off += p.byteLength;
          }
          rootBytes = collected;
          documentUrl = head.url !== "" ? head.url : trimmed;
          navHeaders = head.headers;
          documentStream = {
            received: parser.receivedBytes,
            total: streaming.totalBytes,
            snapshots: parser.snapshots,
            nodes: final.tree.nodes.size,
          };
        }
      } else {
        const res = await network.request(navReq);
        if (opts.onNavResponse !== undefined && (await opts.onNavResponse(res)) === "download") {
          return null;
        }
        if (res.ok) {
          rootBytes = res.body;
          documentUrl = res.url !== "" ? res.url : trimmed;
          navHeaders = res.headers;
        }
      }
    } else {
      rootBytes = await (fetchFn ?? defaultFetch)(trimmed);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return renderHtmlEngine(errorPageHtml(trimmed, message), trimmed, viewport, {
      ...fetchOpt,
      runScripts: false,
    });
  }
  if (rootBytes === undefined) {
    return renderHtmlEngine(
      errorPageHtml(trimmed, "failed to fetch (network, timeout, or non-OK HTTP status)"),
      trimmed,
      viewport,
      { ...fetchOpt, runScripts: false, ...(network !== null ? { network } : {}) },
    );
  }
  let html = new TextDecoder().decode(rootBytes);
  if (isBilibiliRiskCaptcha(html) && isBilibiliHomeUrl(trimmed)) {
    const fallback = bilibiliHomeShellUrl(trimmed);
    try {
      const alt = await (network !== null
        ? networkStackToFetchFn(network)
        : (fetchFn ?? defaultFetch))(fallback);
      if (alt !== undefined) {
        const altHtml = new TextDecoder().decode(alt);
        if (!isBilibiliRiskCaptcha(altHtml) && alt.byteLength > rootBytes.byteLength) {
          rootBytes = alt;
          html = altHtml;
          documentUrl = fallback;
        }
      }
    } catch {
      // Guest/page code may throw here; swallowed by design.
    }
  }
  const provisionalDom = parseHtml(rootBytes);
  const baseUrl = documentBaseUrl(provisionalDom, documentUrl);
  // Stylesheet preload counts as a subresource fetch from this document —
  // carry it as initiator so Referer/SameSite/Fetch-Site derive correctly.
  // RFC 0031: the document's COEP is ALREADY known from its response headers
  // (boot hasn't run) — the preload channel is gated by it too.
  const navCoep = parseCoep(navHeaders?.["cross-origin-embedder-policy"]);
  const subresourceFetch =
    opts.fetchFn === undefined && network !== null
      ? networkStackToFetchFn(network, {
          initiator: documentUrl,
          ...(navCoep !== "unsafe-none" ? { initiatorCoep: navCoep } : {}),
        })
      : fetchFn;
  const resourceLoad = await loadResourcesWithTrace(provisionalDom, documentUrl, subresourceFetch, {
    stylesheetsOnly: true,
  });
  const load = cacheLoader(resourceLoad.cache, baseUrl);
  const loadExternalSheet = (href: string): Uint8Array | undefined => {
    try {
      const absolute = new URL(href, baseUrl).href;
      return resourceLoad.cache.get(absolute) ?? resourceLoad.cache.get(href);
    } catch {
      return resourceLoad.cache.get(href);
    }
  };
  return renderHtmlEngine(html, documentUrl, viewport, {
    ...fetchOpt,
    runScripts,
    loadExternalSheet,
    resourceLoader: load,
    resourceCache: resourceLoad.cache,
    ...(network !== null ? { network } : {}),
    ...(opts.keepAlive ? { keepAlive: true } : {}),
    ...(navHeaders !== undefined ? { responseHeaders: navHeaders } : {}),
    ...(opts.ancestorOrigins !== undefined ? { ancestorOrigins: opts.ancestorOrigins } : {}),
    ...(opts.openerInfo !== undefined ? { openerInfo: opts.openerInfo } : {}),
    ...(documentStream !== undefined ? { documentStream } : {}),
    ...sessionOpts,
  });
}

function isBilibiliHomeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!/(^|\.)bilibili\.com$/i.test(u.hostname)) return false;
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return path === "/" || path === "/index.html" || path === "/index.htm";
  } catch {
    return false;
  }
}

function bilibiliHomeShellUrl(url: string): string {
  try {
    const u = new URL(url);
    u.pathname = "/index.html";
    u.search = "";
    u.hash = "";
    return u.href;
  } catch {
    return "https://www.bilibili.com/index.html";
  }
}

function isBilibiliRiskCaptcha(html: string): boolean {
  return (
    html.includes("验证码_哔哩哔哩") ||
    html.includes("risk-captcha") ||
    html.includes("window._riskdata_") ||
    html.includes("v_voucher")
  );
}

export async function loadHtmlDocument(
  html: string,
  url = "engine://upload",
  viewportInput?: EngineViewport,
  options: {
    readonly runScripts?: boolean;
    readonly keepAlive?: boolean;
    readonly sessionHost?: NavigationHost;
    readonly storage?: SessionStorageBag;
    readonly frameLookup?: (nodeId: NodeId) => unknown;
    /** Embedded contexts legitimately render at iframe sizes (<200px). */
    readonly viewportMinEdge?: number;
    /** RFC 0027: response headers of a synthetic/in-memory navigation —
     *  `content-security-policy*` entries apply like a network response. */
    readonly responseHeaders?: Readonly<Record<string, string>>;
    /** RFC 0027: ancestor origins for `frame-ancestors` (embedded docs). */
    readonly ancestorOrigins?: readonly string[];
    /** RFC 0031: opener identity for synthetic loads — the document's own
     *  COOP (from `responseHeaders`) can sever `window.opener` pre-script. */
    readonly openerInfo?: {
      readonly origin: string | null;
      readonly coop: import("@browser-engine/guest").Coop;
      readonly popup: boolean;
    };
  } | boolean = true,
): Promise<PageState> {
  const viewport = normalizeViewport(
    viewportInput,
    undefined,
    typeof options === "boolean" ? 200 : (options.viewportMinEdge ?? 200),
  );
  const opts = typeof options === "boolean" ? { runScripts: options } : options;
  return renderHtmlEngine(html, url, viewport, {
    ...(opts.runScripts !== undefined ? { runScripts: opts.runScripts } : {}),
    ...(opts.keepAlive === true ? { keepAlive: true } : {}),
    ...(opts.sessionHost !== undefined ? { sessionHost: opts.sessionHost } : {}),
    ...(opts.storage !== undefined ? { storage: opts.storage } : {}),
    ...(opts.frameLookup !== undefined ? { frameLookup: opts.frameLookup } : {}),
    ...(opts.responseHeaders !== undefined ? { responseHeaders: opts.responseHeaders } : {}),
    ...(opts.ancestorOrigins !== undefined ? { ancestorOrigins: opts.ancestorOrigins } : {}),
    ...(opts.openerInfo !== undefined ? { openerInfo: opts.openerInfo } : {}),
  });
}
