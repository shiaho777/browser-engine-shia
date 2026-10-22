/**
 * loader.ts — the resource-loading phase (M2.3: "open a real URL").
 *
 * ## Why a separate async phase (and not inside the kernel)
 *
 * The render pipeline (`qDom → … → qPaint`) is a graph of PURE, SYNCHRONOUS
 * kernel queries — that purity is what makes the incremental kernel sound. Real
 * networking is ASYNC and effectful, so it does NOT belong inside a query. This
 * module is the async phase that runs BEFORE the sync pipeline: it fetches the
 * document's subresources (external `<link rel=stylesheet>` and `<img>`) into a
 * content-addressed cache, then the existing sync collectors
 * (`collectStylesheets` / `collectImages`) read that cache through their
 * already-wired sync `loadExternal` / `ImageLoader` hooks. The pure pipeline is
 * untouched; async I/O is confined here (design.md §8.1: reuse the network
 * stack as irreducible infrastructure — here Node's global `fetch`).
 *
 * Resolution: subresource hrefs may be relative; they resolve against the
 * document's effective base URL (the frozen URL of the first `<base href>`, or
 * the document URL when that base is absent/invalid/disallowed) via the WHATWG
 * URL parser. A fetch that fails (network, 404, non-OK) yields `undefined` — a
 * broken subresource is a graceful web condition (the document renders without
 * it), never a thrown error.
 */
import type { DomNode, DomTree, NodeId } from "@browser-engine/ir";
import { crossoriginSettings } from "@browser-engine/guest";

import { isActiveStylesheetLink } from "./link-rel.js";

/** Fetch a URL to bytes, or `undefined` on any failure (injected for tests). */
export type FetchFn = (url: string) => Promise<Uint8Array | undefined>;

/** A loaded subresource cache, keyed by ABSOLUTE resolved URL. */
export type ResourceCache = ReadonlyMap<string, Uint8Array>;

/** Stable diagnostic for one attempted external resource fetch. */
export interface ResourceLoadEvent {
  readonly url: string;
  readonly status: "loaded" | "missing";
  readonly byteLength: number;
}

/** Loaded subresource cache plus stable fetch diagnostics. */
export interface ResourceLoadResult {
  readonly cache: ResourceCache;
  readonly events: readonly ResourceLoadEvent[];
}

export const DEFAULT_FETCH_TIMEOUT_MS = 8_000;

/**
 * The User-Agent sent for every resource fetch. A real browser UA string avoids
 * bot-detection walls (e.g. verification/captcha pages) that many sites serve to
 * bare Node fetch, which sends no `User-Agent` by default.
 */
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 BrowserEngineShia/0.0";

/** Default `Accept` for a top-level HTML navigation. */
const DEFAULT_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

/**
 * Content-type-aware `Accept` for subresources. Stylesheets get the CSS accept
 * list; images get the image accept list; everything else gets the default.
 */
function acceptFor(url: string): string {
  if (/\.css(\?|$)/i.test(url)) {
    return "text/css,*/*;q=0.1";
  }
  if (/\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)(\?|$)/i.test(url)) {
    return "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";
  }
  return DEFAULT_ACCEPT;
}

/**
 * Build the browser-like request headers for a single resource fetch. Mirrors
 * the headers a real browser sends for a top-level navigation / subresource so
 * the document and its external CSS/images are returned as real content rather
 * than bot walls.
 */
function browserHeaders(url: string): Record<string, string> {
  // Fetch Metadata destination follows the accept guess (script/style/image/
  // document); Chrome sends these on every request and bot-walls gate on them.
  const dest = /\.css(\?|$)/i.test(url)
    ? "style"
    : /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)(\?|$)/i.test(url)
      ? "image"
      : /\.m?js(\?|$)/i.test(url)
        ? "script"
        : "document";
  const mode = dest === "document" ? "navigate" : "no-cors";
  const headers: Record<string, string> = {
    "User-Agent": BROWSER_USER_AGENT,
    Accept: acceptFor(url),
    "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
    "Accept-Encoding": "gzip, deflate, br",
    "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "sec-fetch-dest": dest,
    "sec-fetch-mode": mode,
    "sec-fetch-site": "none",
  };
  if (dest === "document") {
    headers["sec-fetch-user"] = "?1";
    headers["Upgrade-Insecure-Requests"] = "1";
  }
  return headers;
}

export const defaultFetch: FetchFn = async (url: string) => {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, DEFAULT_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: browserHeaders(url),
    });
    if (!res.ok) {
      return undefined;
    }
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
};

/** Resolve a possibly-relative href against the document base URL, or `null`. */
export function resolveUrl(href: string, baseUrl: string): string | null {
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return null;
  }
}

/** The URL base used for document subresources: frozen first `<base href>`, else the document URL. */
export function documentBaseUrl(dom: DomTree, documentUrl: string): string {
  for (const node of documentOrder(dom)) {
    if (node.kind !== "element" || node.tag !== "base") {
      continue;
    }
    const href = node.attrs?.get("href");
    if (href === undefined) {
      continue;
    }
    const resolved = resolveUrl(href, documentUrl);
    return resolved === null || isDisallowedBaseUrl(resolved) ? documentUrl : resolved;
  }
  return documentUrl;
}

/** HTML disallows data:/javascript: document bases; they freeze back to the fallback URL. */
function isDisallowedBaseUrl(url: string): boolean {
  try {
    const scheme = new URL(url).protocol;
    return scheme === "data:" || scheme === "javascript:";
  } catch {
    return true;
  }
}

/**
 * Discover the absolute URLs of a document's EXTERNAL subresources — external
 * `<link rel=stylesheet href>` and `<img src>` (inline `data:` URLs need no
 * fetch and are skipped). Deduplicated, in document order.
 */
export function discoverSubresources(
  dom: DomTree,
  documentUrl: string,
  options: {
    readonly stylesheetsOnly?: boolean;
    /** RFC 0027: the document's CSP — `style-src`/`img-src` gate each
     *  discovered URL; `upgrade-insecure-requests`/`block-all-mixed-content`
     *  rewrite/refuse http targets. */
    readonly csp?: import("./csp.js").CspContext | null;
  } = {},
): string[] {
  const baseUrl = documentBaseUrl(dom, documentUrl);
  const urls = new Set<string>();
  const stylesheetsOnly = options.stylesheetsOnly === true;
  const csp = options.csp ?? null;
  const add = (
    href: string | undefined,
    opts: { readonly allowEmpty?: boolean; readonly kind: "img" | "style" },
  ): void => {
    if (href === undefined || (!opts.allowEmpty && href.length === 0) || isDataUrl(href)) {
      return;
    }
    const abs = resolveUrl(href, baseUrl);
    if (abs !== null) {
      if (csp !== null) {
        const gated = csp.gateSubresourceUrl(abs);
        if (gated.blocked || !csp.check(opts.kind, gated.url).allowed) return;
        urls.add(gated.url);
        return;
      }
      urls.add(abs);
    }
  };
  for (const node of documentOrder(dom)) {
    if (node.kind !== "element") {
      continue;
    }
    if (isActiveStylesheetLink(node)) {
      add(node.attrs?.get("href"), { allowEmpty: true, kind: "style" });
    } else if (!stylesheetsOnly && node.tag === "img") {
      add(node.attrs?.get("src"), { kind: "img" });
      const srcset = node.attrs?.get("srcset");
      if (srcset !== undefined && srcset.length > 0) {
        const first = srcset.split(",")[0]?.trim().split(/\s+/)[0];
        add(first, { kind: "img" });
      }
    } else if (node.tag === "source") {
      add(node.attrs?.get("src"), { kind: "img" });
      const srcset = node.attrs?.get("srcset");
      if (srcset !== undefined && srcset.length > 0) {
        const first = srcset.split(",")[0]?.trim().split(/\s+/)[0];
        add(first, { kind: "img" });
      }
    }
  }
  return [...urls];
}

/**
 * RFC 0028: the document's `crossorigin` attributes as a per-URL request
 * map — `img[src|srcset]`, `source`, `link[rel=stylesheet]`, and
 * `script[src]` elements carrying a CORS settings attribute pin the fetch
 * mode/credentials of their resolved URL. Absent attribute ⇒ the URL is
 * absent from the map (the element keeps its default no-cors fetch).
 */
export function collectCrossoriginSettings(
  dom: DomTree,
  documentUrl: string,
): ReadonlyMap<string, { readonly mode: "cors"; readonly credentials: "same-origin" | "include" }> {
  const baseUrl = documentBaseUrl(dom, documentUrl);
  const out = new Map<string, { mode: "cors"; credentials: "same-origin" | "include" }>();
  const collect = (
    href: string | undefined,
    settings: { readonly mode: "cors"; readonly credentials: "same-origin" | "include" } | null,
  ): void => {
    if (settings === null || href === undefined || href.length === 0 || isDataUrl(href)) return;
    const abs = resolveUrl(href, baseUrl);
    if (abs !== null) out.set(abs, settings);
  };
  for (const node of documentOrder(dom)) {
    if (node.kind !== "element") continue;
    const settings = crossoriginSettings(node.attrs?.get("crossorigin"));
    if (settings === null) continue;
    if (node.tag === "img" || (node.tag === "source" &&
        (node.parent === null || node.parent === undefined ||
          (dom.nodes.get(node.parent)?.tag !== "video" && dom.nodes.get(node.parent)?.tag !== "audio")))) {
      collect(node.attrs?.get("src"), settings);
      const srcset = node.attrs?.get("srcset");
      if (srcset !== undefined && srcset.length > 0) {
        collect(srcset.split(",")[0]?.trim().split(/\s+/)[0], settings);
      }
    } else if (node.tag === "video" || node.tag === "audio") {
      // RFC 0035: `crossorigin` media fetches are cors-mode too (the media
      // element's own src, its <source> children, and the poster image).
      collect(node.attrs?.get("src"), settings);
      collect(node.tag === "video" ? node.attrs?.get("poster") : undefined, settings);
      for (const childId of node.children) {
        const c = dom.nodes.get(childId);
        if (c?.tag === "source") collect(c.attrs?.get("src"), settings);
      }
    } else if (isActiveStylesheetLink(node) || (node.tag === "script" && node.attrs?.has("src"))) {
      collect(node.attrs?.get("href") ?? node.attrs?.get("src"), settings);
    }
  }
  return out;
}

/**
 * RFC 0029: resolved subresource URL → Fetch destination map. Same
 * discovery rules as {@link discoverSubresources} (link stylesheet →
 * "style"; img/source/srcset → "image") so the network stack can apply
 * Mixed Content Level 2 (image upgrades; style blocks) and correct
 * Sec-Fetch-* metadata. CSP gating is NOT repeated here — the discovery
 * pass owns it.
 */
export function collectSubresourceDestinations(
  dom: DomTree,
  documentUrl: string,
): ReadonlyMap<string, "image" | "style" | "video" | "audio"> {
  const baseUrl = documentBaseUrl(dom, documentUrl);
  const out = new Map<string, "image" | "style" | "video" | "audio">();
  const add = (href: string | undefined, dest: "image" | "style" | "video" | "audio"): void => {
    if (href === undefined || href.length === 0 || isDataUrl(href)) return;
    const abs = resolveUrl(href, baseUrl);
    if (abs !== null) out.set(abs, dest);
  };
  for (const node of documentOrder(dom)) {
    if (node.kind !== "element") continue;
    if (isActiveStylesheetLink(node)) {
      add(node.attrs?.get("href"), "style");
    } else if (node.tag === "img") {
      add(node.attrs?.get("src"), "image");
      const srcset = node.attrs?.get("srcset");
      if (srcset !== undefined && srcset.length > 0) {
        add(srcset.split(",")[0]?.trim().split(/\s+/)[0], "image");
      }
    } else if (node.tag === "video" || node.tag === "audio") {
      // RFC 0035: media elements declare their real Fetch destinations —
      // "video"/"audio" for the resource + <source> children, "image" for
      // the poster frame.
      const dest = node.tag === "video" ? "video" : "audio";
      add(node.attrs?.get("src"), dest);
      add(node.tag === "video" ? node.attrs?.get("poster") : undefined, "image");
      for (const childId of node.children) {
        const c = dom.nodes.get(childId);
        if (c?.tag === "source") add(c.attrs?.get("src"), dest);
      }
    } else if (node.tag === "source") {
      // A <source> under a media element was already collected by its
      // parent's branch above; here only <picture> image sources remain.
      const parent = node.parent !== null && node.parent !== undefined
        ? dom.nodes.get(node.parent)?.tag
        : undefined;
      if (parent === "video" || parent === "audio") continue;
      add(node.attrs?.get("src"), "image");
      const srcset = node.attrs?.get("srcset");
      if (srcset !== undefined && srcset.length > 0) {
        add(srcset.split(",")[0]?.trim().split(/\s+/)[0], "image");
      }
    }
  }
  return out;
}

/** Traverse connected nodes in tree order without assuming `dom.nodes` is a concrete Map. */
function documentOrder(dom: DomTree): DomNode[] {
  const out: DomNode[] = [];
  const visit = (id: NodeId): void => {
    const node = dom.nodes.get(id);
    if (node === undefined) {
      return;
    }
    out.push(node);
    for (const child of node.children) {
      visit(child);
    }
  };
  visit(dom.root);
  return out;
}

/** URL schemes are ASCII case-insensitive. */
function isDataUrl(href: string): boolean {
  return href.slice(0, 5).toLowerCase() === "data:";
}

/**
 * Fetch every external subresource of `dom` (resolved against `baseUrl`) into a
 * {@link ResourceCache}. Fetches run concurrently; a failed fetch is simply
 * absent from the cache (the collectors then skip that resource gracefully).
 */
export async function loadResources(
  dom: DomTree,
  baseUrl: string,
  fetchFn: FetchFn = defaultFetch,
): Promise<ResourceCache> {
  return (await loadResourcesWithTrace(dom, baseUrl, fetchFn)).cache;
}

/** Fetch subresources and retain deterministic per-resource diagnostics. */
export async function loadResourcesWithTrace(
  dom: DomTree,
  baseUrl: string,
  fetchFn: FetchFn = defaultFetch,
  options: {
    readonly stylesheetsOnly?: boolean;
    readonly existing?: ResourceCache;
    /** RFC 0027: CSP gate for the discovered URLs (style-src/img-src +
     *  upgrade/mixed-content). */
    readonly csp?: import("./csp.js").CspContext | null;
  } = {},
): Promise<ResourceLoadResult> {
  const urls = discoverSubresources(dom, baseUrl, options);
  const cache = new Map<string, Uint8Array>();
  if (options.existing !== undefined) {
    for (const [k, v] of options.existing) cache.set(k, v);
  }
  const pending = urls.filter((url) => !cache.has(url));
  const events = await Promise.all(
    pending.map(async (url): Promise<ResourceLoadEvent> => {
      const bytes = await fetchFn(url);
      if (bytes !== undefined) {
        cache.set(url, bytes);
        return Object.freeze({ url, status: "loaded", byteLength: bytes.byteLength });
      }
      return Object.freeze({ url, status: "missing", byteLength: 0 });
    }),
  );
  return Object.freeze({
    cache,
    events: Object.freeze(events),
  });
}

/**
 * Build the SYNC `loadExternal` hook the collectors call: it resolves a raw
 * href against the document's effective base URL and returns the pre-fetched
 * bytes from the cache (or `undefined` if the resource was not loaded).
 */
export function cacheLoader(
  cache: ResourceCache,
  baseUrl: string,
): (href: string) => Uint8Array | undefined {
  return (href: string) => {
    const abs = resolveUrl(href, baseUrl);
    return abs === null ? undefined : cache.get(abs);
  };
}

/**
 * The document's referrer policy from `<meta name="referrer" content="…">`
 * (RFC 0009). Per HTML, the LAST element in tree order whose content is a
 * recognized policy wins; unrecognized/empty values and absent metas fall back
 * to `undefined` (the caller applies the network stack's default).
 */
export function documentReferrerPolicy(dom: DomTree): string | undefined {
  const KNOWN: ReadonlySet<string> = new Set([
    "no-referrer",
    "no-referrer-when-downgrade",
    "origin",
    "origin-when-cross-origin",
    "same-origin",
    "strict-origin",
    "strict-origin-when-cross-origin",
    "unsafe-url",
  ]);
  let policy: string | undefined;
  for (const node of documentOrder(dom)) {
    if (node.kind !== "element" || node.tag !== "meta") continue;
    const name = node.attrs?.get("name");
    if (name === undefined || name.trim().toLowerCase() !== "referrer") continue;
    const content = node.attrs?.get("content");
    if (content === undefined) continue;
    const v = content.trim().toLowerCase();
    if (KNOWN.has(v)) policy = v;
  }
  return policy;
}

/** Re-export the NodeId type position used by image-cache callers. */
export type { NodeId };
