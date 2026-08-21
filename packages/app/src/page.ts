import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { DecodedImage, DisplayList, DomNode, DomTree, FragmentTree, NodeId } from "@browser-engine/ir";
import { nodeId, px } from "@browser-engine/ir";
import { parseHtml } from "@browser-engine/html-parser";
import { createComputedStyleResolver } from "@browser-engine/cascade";
import { layout } from "@browser-engine/layout";
import { paint } from "@browser-engine/paint";
import { hitTest } from "@browser-engine/layout";
import { encodeSurfaceToPng, renderDisplayListOnGpu } from "@browser-engine/backend";
import {
  cacheLoader,
  collectImagesAsync,
  imageSourceCandidates,
  defaultFetch,
  documentBaseUrl,
  documentStylesheets,
  loadResourcesWithTrace,
  warmDecodeImageBytes,
  pipelineGlyphSource,
  pipelinePrimaryFontName,
  pipelineShaper,
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
import { bootFineSession, createPageNetwork, type ScriptExecutionSummary } from "./engine-runtime.js";
import { networkStackToFetchFn } from "@browser-engine/guest";
import { normalizeFocus, paintFocusOverlay, type EditFocus } from "./focus-overlay.js";
export type { EditFocus } from "./focus-overlay.js";

const PROFILE = process.env["ENGINE_PROFILE"] === "1";
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
}

export interface LoadPageOptions {
  readonly fetchFn?: FetchFn;
  readonly viewport?: EngineViewport;
  readonly runScripts?: boolean;
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
}> {
  let t = performance.now();
  const viewportBox = { width: viewport.width, height: viewport.height };
  const height = viewport.height;
  const widthLimit = viewport.width;
  const dpr = Math.max(1, Math.min(3, Number(viewport.devicePixelRatio ?? 1) || 1));
  const scrollY = Math.max(0, scrollYInput);
  const maxVisibleImages = 220;
  const sheets = documentStylesheets(dom, load, {
    type: "screen",
    widthPx: viewport.width,
    heightPx: viewport.height,
  });
  t = mark("sheets", t);
  const origins = sheets.map((_, i) => (i === 0 ? ("ua" as const) : ("author" as const)));
  const styleOf = createComputedStyleResolver(dom, sheets, viewportBox, origins);
  t = mark("styleResolver", t);
  const fragmentTree = layout(dom, styleOf, {
    shaper: pipelineShaper,
    viewportWidth: px(viewport.width),
    viewportHeight: px(viewport.height),
    clipMaxY: viewport.height + 80,
  });
  t = mark("layout+cascade", t);
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
    if (y < scrollY + height + 520 && y + h > scrollY - 120 && x < widthLimit + 40 && x + w > -40) {
      seenImg.add(frag.node);
      rankedImgs.push({
        id: frag.node,
        y,
        x,
        w,
        h,
        area: Math.max(0, w) * Math.max(0, h),
      });
    }
  }
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
  withoutExtraStrips.sort((a, b) => b.area - a.area || a.y - b.y || a.x - b.x);
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
  const visibleImgIds = new Set<NodeId>(picked.map((item) => item.id));
  if (PROFILE) console.error(`[profile] visibleImgs=${visibleImgIds.size} ranked=${rankedImgs.length} frags=${fragmentTree.fragments.size}`);
  const images = await collectImagesAsync(dom, load, {
    concurrency: 32,
    onlyNodes: visibleImgIds,
    maxImages: maxVisibleImages,
    timeoutMs: 4500,
    ...(imageFetch !== undefined ? { fetchFn: imageFetch } : {}),
  });
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
    const m = /url\((['"]?)([^)'"]+)\1\)/i.exec(bg);
    if (m === null) continue;
    const raw = m[2]!.trim();
    if (raw.startsWith("data:") || bgSeen.has(raw)) continue;
    bgSeen.add(raw);
    bgJobs.push(raw);
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
  const imageBySrc = (src: string) => bgDecoded.get(src);
  const rootFrag = fragmentTree.fragments.get(fragmentTree.root);
  const contentHeight = Math.max(
    height,
    rootFrag !== undefined ? Number(rootFrag.box.marginBox.height) : height,
  );
  const maxScroll = Math.max(0, contentHeight - height);
  const scrollYClamped = Math.min(scrollY, maxScroll);
  const fullDisplayList = paint(fragmentTree, styleOf, (node) => images.get(node), {
    clipMaxY: height,
    scrollY: scrollYClamped,
    imageBySrc,
  });
  t = mark("paint", t);
  if (PROFILE) console.error(`[profile] paintCmds=${fullDisplayList.commands.length} bg=${bgDecoded.size} dpr=${dpr}`);
  const displayList = clipDisplayListToViewport(fullDisplayList, height, widthLimit);
  if (PROFILE) console.error(`[profile] clippedCmds=${displayList.commands.length}`);
  t = mark("clip", t);
  const width = widthLimit;
  const surface = renderDisplayListOnGpu(displayList, width, height, pipelineGlyphSource, {
    clipMaxY: height,
    clipMaxX: widthLimit,
    pixelRatio: dpr,
  });
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
  let out = state;
  if (loader !== undefined) out = { ...out, loader };
  if (imageFetch !== undefined) out = { ...out, imageFetch };
  if (imageBytes !== undefined) out = { ...out, imageBytes };
  if (rendered.decodedImages !== undefined) out = { ...out, decodedImages: rendered.decodedImages };
  if (rendered.bgImages !== undefined) out = { ...out, bgImages: rendered.bgImages };
  return out;
}

function collectDocumentImageSrcs(dom: DomTree, maxImages = 120): string[] {
  const srcs: string[] = [];
  const visit = (id: NodeId): void => {
    if (srcs.length >= maxImages) return;
    const node = dom.nodes.get(id);
    if (node === undefined) return;
    if (node.kind === "element" && node.tag === "img") {
      for (const src of imageSourceCandidates(node, true)) {
        if (src.startsWith("data:")) continue;
        if (!srcs.includes(src)) srcs.push(src);
        break;
      }
    }
    for (const child of node.children) visit(child);
  };
  visit(dom.root);
  return srcs;
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
  } = {},
): Promise<PageState> {
  const started = performance.now();
  const network = options.network ?? (options.fetchFn === undefined ? createPageNetwork(url) : undefined);
  const fetchForResources =
    options.fetchFn ??
    (network !== undefined ? networkStackToFetchFn(network) : undefined);
  const warmImageBytes = new Map<string, Uint8Array>();
  const warmImageInflight = new Map<string, Promise<Uint8Array | undefined>>();
  const bootOptions: {
    fetchFn?: FetchFn;
    runScripts?: boolean;
    loadExternalSheet?: (href: string) => Uint8Array | undefined;
    network?: ReturnType<typeof createPageNetwork>;
    onAfterClassic?: (session: { readonly dom: DomTree }) => void | Promise<void>;
  } = {};
  if (options.fetchFn !== undefined) bootOptions.fetchFn = options.fetchFn;
  if (options.runScripts !== undefined) bootOptions.runScripts = options.runScripts;
  if (options.loadExternalSheet !== undefined) bootOptions.loadExternalSheet = options.loadExternalSheet;
  if (network !== undefined) bootOptions.network = network;
  if (fetchForResources !== undefined) {
    bootOptions.onAfterClassic = (session) => {
      const base = documentBaseUrl(session.dom, url);
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
  const earlyCssWork =
    fetchForResources !== undefined
      ? loadResourcesWithTrace(parseHtml(new TextEncoder().encode(html)), url, fetchForResources, {
          stylesheetsOnly: true,
          ...(options.resourceCache !== undefined ? { existing: options.resourceCache } : {}),
        })
      : null;
  const boot = await bootFineSession(html, url, bootOptions);
  tBoot = mark("boot", tBoot);
  const baseForImages = documentBaseUrl(boot.session.dom, url);
  const startWarm = (src: string): void => {
    if (fetchForResources === undefined) return;
    let abs = src;
    try {
      abs = new URL(src, baseForImages).href;
    } catch {
      // Invalid URL input: keep the raw/fallback value.
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
  );
  mark("renderDom", tBoot);
  return finishPage(
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
  );
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
      if (tag === "textarea" || tag === "input") return current;
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
  const sheets = documentStylesheets(page.dom, page.loader, {
    type: "screen",
    widthPx: width,
    heightPx: height,
  });
  const origins = sheets.map((_, i) => (i === 0 ? ("ua" as const) : ("author" as const)));
  const styleOf = createComputedStyleResolver(page.dom, sheets, { width, height }, origins);
  const decoded = page.decodedImages ?? new Map<NodeId, DecodedImage>();
  const bgImages = page.bgImages ?? new Map<string, DecodedImage>();
  const imageBySrc = (src: string) => bgImages.get(src);
  const fullDisplayList = paint(
    page.fragmentTree,
    styleOf,
    (node) => decoded.get(node),
    {
      clipMaxY: height,
      scrollY,
      imageBySrc,
    },
  );
  const displayList = clipDisplayListToViewport(fullDisplayList, height, width);
  const surface = renderDisplayListOnGpu(displayList, width, height, pipelineGlyphSource, {
    clipMaxY: height,
    clipMaxX: width,
    pixelRatio: dpr,
  });
  if (page.focus !== null) {
    paintFocusOverlay(surface, page.fragmentTree, page.dom, page.focus);
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
  });
}

export async function repaintPage(
  page: PageState,
  viewport: EngineViewport,
  focus: EditFocus | null = page.focus,
  scrollY: number = page.scrollY ?? 0,
): Promise<PageState> {
  const started = performance.now();
  const imageBytes = page.imageBytes ?? new Map<string, Uint8Array>();
  const combinedLoad = makeCombinedImageLoader(page.loader, imageBytes, page.url);
  const imageFetch = makeCachingImageFetch(page.imageFetch, imageBytes, page.url);
  const rendered = await renderDom(page.dom, page.url, viewport, combinedLoad, focus, imageFetch, scrollY);
  return finishPage(
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
  );
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
  const rendered = await renderDom(dom, page.url, viewport, combinedLoad, focus, imageFetch, page.scrollY ?? 0);
  return finishPage(
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
  );
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
): Promise<PageState> {
  const opts: LoadPageOptions =
    typeof options === "function" ? { fetchFn: options } : options;
  const viewport = normalizeViewport(opts.viewport);
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
  const network = opts.fetchFn === undefined ? createPageNetwork(networkBase) : null;
  const fetchFn = opts.fetchFn ?? (network !== null ? networkStackToFetchFn(network) : defaultFetch);

  if (
    trimmed === "" ||
    trimmed === HOME_URL ||
    trimmed === "about:home" ||
    trimmed === "engine://home" ||
    trimmed === "/"
  ) {
    return renderHtmlEngine(HOME_HTML, HOME_URL, viewport, { fetchFn, runScripts, ...(network !== null ? { network } : {}) });
  }

  if (trimmed === DEMO_URL || trimmed === "engine://demo") {
    return renderHtmlEngine(DEMO_HTML, DEMO_URL, viewport, { fetchFn, runScripts, ...(network !== null ? { network } : {}) });
  }

  if (trimmed === LIVE_URL || trimmed === "engine://live") {
    return renderHtmlEngine(LIVE_HTML, LIVE_URL, viewport, { fetchFn, runScripts, ...(network !== null ? { network } : {}) });
  }

  if (trimmed === FONTS_URL || trimmed === "engine://fonts") {
    const html = FONTS_HTML.replaceAll("{{FONT_STACK}}", pipelinePrimaryFontName());
    return renderHtmlEngine(html, FONTS_URL, viewport, { fetchFn, runScripts, ...(network !== null ? { network } : {}) });
  }

  if (trimmed === FORM_URL || trimmed === "engine://form") {
    return renderHtmlEngine(FORM_HTML, FORM_URL, viewport, { fetchFn, runScripts, ...(network !== null ? { network } : {}) });
  }

  if (trimmed.startsWith("file://")) {
    const filePath = fileURLToPath(trimmed);
    const html = readFileSync(filePath, "utf8");
    const url = pathToFileURL(filePath).href;
    return renderHtmlEngine(html, url, viewport, { fetchFn, runScripts, ...(network !== null ? { network } : {}) });
  }

  if (!/^(https?:\/\/|engine:\/\/)/i.test(trimmed)) {
    const asPath = resolve(trimmed);
    if (existsSync(asPath)) {
      return loadPage(pathToFileURL(asPath).href, opts);
    }
    if (trimmed.includes("<") && trimmed.includes(">")) {
      return renderHtmlEngine(trimmed, "engine://inline", viewport, { fetchFn, runScripts, ...(network !== null ? { network } : {}) });
    }
    return loadPage(`https://${trimmed}`, opts);
  }

  let rootBytes: Uint8Array | undefined;
  let documentUrl = trimmed;
  try {
    rootBytes = await fetchFn(trimmed);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return renderHtmlEngine(errorPageHtml(trimmed, message), trimmed, viewport, {
      fetchFn,
      runScripts: false,
    });
  }
  if (rootBytes === undefined) {
    return renderHtmlEngine(
      errorPageHtml(trimmed, "failed to fetch (network, timeout, or non-OK HTTP status)"),
      trimmed,
      viewport,
      { fetchFn, runScripts: false, ...(network !== null ? { network } : {}) },
    );
  }
  let html = new TextDecoder().decode(rootBytes);
  if (isBilibiliRiskCaptcha(html) && isBilibiliHomeUrl(trimmed)) {
    const fallback = bilibiliHomeShellUrl(trimmed);
    try {
      const alt = await fetchFn(fallback);
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
  const resourceLoad = await loadResourcesWithTrace(provisionalDom, documentUrl, fetchFn, {
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
    fetchFn,
    runScripts,
    loadExternalSheet,
    resourceLoader: load,
    resourceCache: resourceLoad.cache,
    ...(network !== null ? { network } : {}),
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
  runScripts = true,
): Promise<PageState> {
  const viewport = normalizeViewport(viewportInput);
  return renderHtmlEngine(html, url, viewport, { runScripts });
}
