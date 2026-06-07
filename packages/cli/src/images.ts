/**
 * images.ts — decode a document's `<img>` resources into the IR
 * {@link DecodedImage}s paint blits (the resource-layer half of replaced-element
 * rendering).
 *
 * Decoding is "irreducible dirty work" the engine REUSES rather than
 * reimplements (design.md §8.1, §11): the dependency-free PNG codec already
 * built for the reftest harness (`@browser-engine/test-harness`, which the cli
 * wiring already depends on) does the DEFLATE + unfilter work via Node's
 * `zlib`. This module is the wiring that maps each `<img>` node to its decoded
 * bitmap; paint receives the result through an injected `imageOf` resolver (the
 * same injection shape as `styleOf`), so the paint STAGE stays pure and free of
 * any codec/resource knowledge.
 *
 * Coverage: inline `data:image/png` sources (base64 or percent-encoded), which
 * are fully deterministic and need no network. External `http(s)` `<img src>`
 * needs the resource loader (M2 networking sub-step) and is collected via the
 * injected `loadExternal` hook when provided, else skipped (a broken image is a
 * graceful web condition, not an unimplemented capability).
 */
import type { DecodedImage, DomNode, DomTree, NodeId } from "@browser-engine/ir";
import { decodePng } from "@browser-engine/test-harness";

/** Optional hook to load an external image resource by URL (M2 networking). */
export type ImageLoader = (src: string) => Uint8Array | undefined;

/**
 * Decode every `<img>` element's source into a {@link DecodedImage}, keyed by
 * node id. Inline `data:image/png` sources are decoded here; an external source
 * is loaded via `loadExternal` when provided, else skipped. A source that fails
 * to decode is skipped (a broken image renders nothing — never throws).
 */
export function collectImages(
  dom: DomTree,
  loadExternal?: ImageLoader,
): Map<NodeId, DecodedImage> {
  const images = new Map<NodeId, DecodedImage>();
  const visit = (id: NodeId): void => {
    const node = dom.nodes.get(id);
    if (node === undefined) {
      return;
    }
    if (node.kind === "element" && node.tag === "img") {
      const bytes = imageBytes(node, loadExternal);
      if (bytes !== undefined) {
        const decoded = tryDecode(bytes);
        if (decoded !== undefined) {
          images.set(node.id, decoded);
        }
      }
    }
    for (const child of node.children) {
      visit(child);
    }
  };
  visit(dom.root);
  return images;
}

/** Resolve an `<img>`'s source bytes (inline `data:` here, external via hook). */
function imageBytes(img: DomNode, loadExternal?: ImageLoader): Uint8Array | undefined {
  const src = img.attrs?.get("src");
  if (src === undefined || src.length === 0) {
    return undefined;
  }
  const data = decodeDataUrl(src);
  if (data !== undefined) {
    return data;
  }
  return loadExternal?.(src);
}

/** Decode PNG bytes into the IR {@link DecodedImage}, or `undefined` on failure. */
function tryDecode(bytes: Uint8Array): DecodedImage | undefined {
  try {
    const raw = decodePng(bytes);
    return {
      width: raw.width,
      height: raw.height,
      pixels: new Uint8ClampedArray(raw.data),
    };
  } catch {
    return undefined; // an undecodable/unsupported image renders nothing.
  }
}

/** Decode a `data:` URL payload to bytes, or `undefined` for a non-`data:` URL. */
function decodeDataUrl(src: string): Uint8Array | undefined {
  if (!src.startsWith("data:")) {
    return undefined;
  }
  const comma = src.indexOf(",");
  if (comma === -1) {
    return undefined;
  }
  const meta = src.slice(5, comma);
  const payload = src.slice(comma + 1);
  if (meta.toLowerCase().includes(";base64")) {
    return Uint8Array.from(Buffer.from(payload, "base64"));
  }
  return new TextEncoder().encode(decodeURIComponent(payload));
}
