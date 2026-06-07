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
 * document's base URL via the WHATWG URL parser. A fetch that fails (network,
 * 404, non-OK) yields `undefined` — a broken subresource is a graceful web
 * condition (the document renders without it), never a thrown error.
 */
import type { DomTree, NodeId } from "@browser-engine/ir";

/** Fetch a URL to bytes, or `undefined` on any failure (injected for tests). */
export type FetchFn = (url: string) => Promise<Uint8Array | undefined>;

/** A loaded subresource cache, keyed by ABSOLUTE resolved URL. */
export type ResourceCache = ReadonlyMap<string, Uint8Array>;

/** The default fetch: Node's global `fetch`, failures mapped to `undefined`. */
export const defaultFetch: FetchFn = async (url: string) => {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      return undefined;
    }
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return undefined;
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

/**
 * Discover the absolute URLs of a document's EXTERNAL subresources — external
 * `<link rel=stylesheet href>` and `<img src>` (inline `data:` URLs need no
 * fetch and are skipped). Deduplicated, in document order.
 */
export function discoverSubresources(dom: DomTree, baseUrl: string): string[] {
  const urls = new Set<string>();
  const add = (href: string | undefined): void => {
    if (href === undefined || href.length === 0 || href.startsWith("data:")) {
      return;
    }
    const abs = resolveUrl(href, baseUrl);
    if (abs !== null) {
      urls.add(abs);
    }
  };
  for (const node of dom.nodes.values()) {
    if (node.kind !== "element") {
      continue;
    }
    if (node.tag === "link" && linkIsStylesheet(node.attrs)) {
      add(node.attrs?.get("href"));
    } else if (node.tag === "img") {
      add(node.attrs?.get("src"));
    }
  }
  return [...urls];
}

/** Whether a `<link>`'s `rel` marks it a stylesheet. */
function linkIsStylesheet(attrs: ReadonlyMap<string, string> | undefined): boolean {
  return (attrs?.get("rel") ?? "")
    .toLowerCase()
    .split(/\s+/)
    .includes("stylesheet");
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
  const urls = discoverSubresources(dom, baseUrl);
  const cache = new Map<string, Uint8Array>();
  await Promise.all(
    urls.map(async (url) => {
      const bytes = await fetchFn(url);
      if (bytes !== undefined) {
        cache.set(url, bytes);
      }
    }),
  );
  return cache;
}

/**
 * Build the SYNC `loadExternal` hook the collectors call: it resolves a raw
 * href against the document base URL and returns the pre-fetched bytes from the
 * cache (or `undefined` if the resource was not loaded).
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

/** Re-export the NodeId type position used by image-cache callers. */
export type { NodeId };
