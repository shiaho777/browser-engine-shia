import type { DecodedImage, DomNode, DomTree, NodeId } from "@browser-engine/ir";
import { decodePng } from "@browser-engine/test-harness";
import {
  decodeImageBytes,
  decodeImageBytesAsync,
  sniffImageFormat,
} from "@browser-engine/backend";
import { canvasKitIfReady } from "@browser-engine/backend";
import { decode as decodeJpeg } from "jpeg-js";
import { createHash } from "node:crypto";

export type ImageLoader = (src: string) => Uint8Array | undefined;

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

export type AsyncImageLoader = (src: string) => Promise<Uint8Array | undefined>;

export async function collectImagesAsync(
  dom: DomTree,
  loadExternal?: ImageLoader,
  options: {
    readonly concurrency?: number;
    readonly onlyNodes?: ReadonlySet<NodeId>;
    readonly fetchFn?: AsyncImageLoader;
    readonly maxImages?: number;
    readonly timeoutMs?: number;
    /** Per-node srcset selection context (dpr / slot width from layout). */
    readonly sourceContext?: (node: DomNode) => ImageSourceContext | undefined;
  } = {},
): Promise<Map<NodeId, DecodedImage>> {
  const only = options.onlyNodes;
  const fetchFn = options.fetchFn;
  const maxImages = options.maxImages;
  const timeoutMs = options.timeoutMs;
  const targets: DomNode[] = [];
  const visit = (id: NodeId): void => {
    const node = dom.nodes.get(id);
    if (node === undefined) return;
    if (node.kind === "element" && node.tag === "img") {
      if (only === undefined || only.has(node.id)) targets.push(node);
    }
    for (const child of node.children) visit(child);
  };
  visit(dom.root);
  const limited =
    maxImages !== undefined && maxImages >= 0 && targets.length > maxImages
      ? targets.slice(0, maxImages)
      : targets;

  const jobs: { id: NodeId; bytes: Uint8Array }[] = [];
  const deadline =
    timeoutMs !== undefined && timeoutMs > 0 ? Date.now() + Math.max(timeoutMs, 200) * 2 : null;
  const resolveOne = async (node: DomNode): Promise<void> => {
    if (deadline !== null && Date.now() >= deadline) return;
    let bytes = imageBytes(node, loadExternal, options.sourceContext?.(node));
    if (bytes === undefined && fetchFn !== undefined) {
      const candidates = imageSourceCandidates(node, options.sourceContext?.(node) ?? false).filter(
        (src) => !src.startsWith("data:"),
      );
      const tryList = candidates.slice(0, 2);
      for (const src of tryList) {
        if (deadline !== null && Date.now() >= deadline) break;
        try {
          const fetched = fetchFn(src);
          bytes =
            timeoutMs !== undefined && timeoutMs > 0
              ? await raceTimeout(fetched, timeoutMs)
              : await fetched;
        } catch {
          bytes = undefined;
        }
        if (bytes !== undefined) break;
      }
    }
    if (bytes !== undefined) jobs.push({ id: node.id, bytes });
  };

  const concurrency = Math.max(1, options.concurrency ?? 16);
  let cursor = 0;
  const fetchWorkers = Array.from(
    { length: Math.min(concurrency, Math.max(1, limited.length)) },
    async () => {
      while (true) {
        const i = cursor;
        cursor += 1;
        if (i >= limited.length) return;
        await resolveOne(limited[i]!);
      }
    },
  );
  const fetchPhase =
    limited.length > 0
      ? Promise.all(fetchWorkers)
      : Promise.resolve();
  if (timeoutMs !== undefined && timeoutMs > 0) {
    await raceTimeout(fetchPhase.then(() => true), Math.max(timeoutMs, 200) * 2);
  } else {
    await fetchPhase;
  }

  const images = new Map<NodeId, DecodedImage>();
  let next = 0;
  const decodeWorkers = Array.from(
    { length: Math.min(concurrency, Math.max(1, jobs.length)) },
    async () => {
      while (true) {
        const i = next;
        next += 1;
        if (i >= jobs.length) return;
        const job = jobs[i]!;
        const decoded = await tryDecodeAsync(job.bytes);
        if (decoded !== undefined) images.set(job.id, decoded);
      }
    },
  );
  const decodePhase = jobs.length > 0 ? Promise.all(decodeWorkers) : Promise.resolve();
  if (timeoutMs !== undefined && timeoutMs > 0) {
    await raceTimeout(decodePhase.then(() => true), Math.max(400, timeoutMs));
  } else {
    await decodePhase;
  }
  return images;
}

function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(undefined);
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

/** Parsed srcset candidate — `w` width descriptor or `x` density descriptor. */
export interface SrcsetCandidate {
  readonly url: string;
  /** Source width in px (`w` descriptor). */
  readonly width?: number;
  /** Source density (`x` descriptor; default 1 when descriptors are `x`-typed). */
  readonly density?: number;
}

/**
 * Parse a `srcset` attribute into candidates. Per spec the URL runs to the
 * first comma or whitespace; a trailing comma inside a URL is consumed as part
 * of it. Malformed descriptors are ignored (the candidate is kept — the HTML
 * spec only drops entries whose descriptor makes the candidate unusable).
 */
export function parseSrcset(srcset: string): readonly SrcsetCandidate[] {
  const out: SrcsetCandidate[] = [];
  for (const part of srcset.split(",")) {
    const bits = part.trim().split(/\s+/);
    const url = bits[0];
    if (url === undefined || url.length === 0) continue;
    let width: number | undefined;
    let density: number | undefined;
    for (let i = 1; i < bits.length; i += 1) {
      const d = bits[i]!.toLowerCase();
      if (d.endsWith("w")) {
        const n = Number(d.slice(0, -1));
        if (Number.isFinite(n) && n > 0) width = n;
      } else if (d.endsWith("x")) {
        const n = Number(d.slice(0, -1));
        if (Number.isFinite(n) && n > 0) density = n;
      } else if (d.endsWith("h")) {
        const n = Number(d.slice(0, -1));
        if (Number.isFinite(n) && n > 0) {
          // `h` without `w` is meaningless; spec requires w+h pairs.
          // We accept it but keep it out of density computation.
        }
      }
    }
    out.push({ url, ...(width !== undefined ? { width } : {}), ...(density !== undefined ? { density } : {}) });
  }
  return out;
}

/**
 * Resolve a `sizes` attribute to a slot width in CSS px for a given viewport
 * width. `<sizes> = <source-size-list>`: a comma list of `(<media-condition>)
 * <length>` entries plus a trailing bare length; the first matching entry wins.
 * Supported conditions: `min-width`/`max-width` in px; supported lengths: px,
 * vw, em/rem (16px base). Unknown/invalid → falls through to the next entry;
 * no match and no bare default → `100vw`.
 */
export function parseSizes(sizes: string, viewportWidth: number): number {
  const entries = sizes.split(",");
  let fallback: number | undefined;
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const m = /^\(\s*(min|max)-width\s*:\s*([\d.]+)px\s*\)\s*(.+)$/.exec(trimmed);
    if (m !== null) {
      const condPx = Number(m[2]);
      const ok = m[1] === "min" ? viewportWidth >= condPx : viewportWidth <= condPx;
      if (ok) {
        const v = parseSlotLength(m[3]!.trim(), viewportWidth);
        if (v !== undefined) return v;
      }
      continue;
    }
    // Bare length (the list default) — only the LAST entry may be bare.
    const v = parseSlotLength(trimmed, viewportWidth);
    if (v !== undefined) fallback = v;
  }
  return fallback ?? viewportWidth;
}

function parseSlotLength(token: string, viewportWidth: number): number | undefined {
  const m = /^([\d.]+)(px|vw|em|rem)$/.exec(token);
  if (m === null) return token === "0" ? 0 : undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  switch (m[2]) {
    case "vw": return (n / 100) * viewportWidth;
    case "em":
    case "rem": return n * 16;
    default: return n;
  }
}

/** Context for source selection — all fields optional. */
export interface ImageSourceContext {
  /** Prefer the smallest candidate (thumbnail/first-paint mode). */
  readonly preferSmall?: boolean;
  /** Device pixel ratio used for `w`/`x` source selection (default 1). */
  readonly dpr?: number;
  /** CSS-px slot the image will occupy (default: `sizes` attr, else 100vw). */
  readonly slotWidth?: number;
  /** Viewport width in CSS px — evaluates `sizes` media conditions. */
  readonly viewportWidth?: number;
}

/**
 * Ordered URL preference list for an `<img>` — `src`, then `data-*` fallbacks,
 * then `srcset` ranked by density fit for `ctx.dpr`. `w` descriptors become
 * effective densities via `width / slotWidth`; `x` descriptors are densities.
 * Pick rule (WHATWG): smallest density ≥ dpr wins; if none qualifies, the
 * largest density wins. Remaining candidates follow in descending density so
 * fallbacks degrade gracefully.
 */
export function imageSourceCandidates(
  img: DomNode,
  ctx: boolean | ImageSourceContext = false,
): string[] {
  const options: ImageSourceContext = typeof ctx === "boolean" ? { preferSmall: ctx } : ctx;
  const out: string[] = [];
  const push = (v: string | undefined): void => {
    if (v !== undefined && v.length > 0 && !out.includes(v)) out.push(v);
  };
  push(img.attrs?.get("src"));
  push(img.attrs?.get("data-src"));
  push(img.attrs?.get("data-src-img"));
  const srcset = img.attrs?.get("srcset") ?? img.attrs?.get("data-srcset");
  if (srcset !== undefined && srcset.length > 0) {
    const parts = [...parseSrcset(srcset)];
    const dpr = options.dpr ?? 1;
    const slot =
      options.slotWidth ??
      (() => {
        const sizes = img.attrs?.get("sizes") ?? img.attrs?.get("data-sizes");
        return sizes !== undefined ? parseSizes(sizes, options.viewportWidth ?? 800) : undefined;
      })();
    const densityOf = (c: SrcsetCandidate): number => {
      if (c.density !== undefined) return c.density;
      if (c.width !== undefined) return slot !== undefined && slot > 0 ? c.width / slot : c.width / 800;
      return 1;
    };
    if (options.preferSmall === true) {
      parts.sort((a, b) => densityOf(a) - densityOf(b));
    } else {
      // Best fit first: smallest density ≥ dpr, else the largest available.
      const above = parts.filter((c) => densityOf(c) >= dpr).sort((a, b) => densityOf(a) - densityOf(b));
      const below = parts.filter((c) => densityOf(c) < dpr).sort((a, b) => densityOf(b) - densityOf(a));
      parts.length = 0;
      parts.push(...above, ...below);
    }
    for (const p of parts) push(p.url);
  }
  return out;
}

function imageBytes(
  img: DomNode,
  loadExternal?: ImageLoader,
  ctx?: ImageSourceContext,
): Uint8Array | undefined {
  for (const src of imageSourceCandidates(img, ctx ?? false)) {
    const data = decodeDataUrl(src);
    if (data !== undefined) return data;
    const external = loadExternal?.(src);
    if (external !== undefined) return external;
  }
  return undefined;
}

const decodeCache = new Map<string, DecodedImage | null>();
const decodeAsyncInflight = new Map<string, Promise<DecodedImage | undefined>>();

function bytesKey(bytes: Uint8Array): string {
  return createHash("sha1").update(bytes).digest("hex");
}

/**
 * JPEG via jpeg-js — kept only as the SYNC-path fallback for JPEG when the
 * CanvasKit module is not initialized yet. Every other raster format decodes
 * through the Skia codec surface (RFC 0007).
 */
function decodeJpegFallback(bytes: Uint8Array): DecodedImage | undefined {
  if (sniffImageFormat(bytes) !== "jpeg") return undefined;
  const raw = decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true });
  return {
    width: raw.width,
    height: raw.height,
    pixels: new Uint8ClampedArray(raw.data),
    format: "jpeg",
  };
}

/**
 * Synchronous decode — used by the kernel/pipeline paths. PNG goes through the
 * in-repo decoder; everything else goes through the Skia codecs when the WASM
 * module is already warm (it is, once any Skia backend exists), with jpeg-js
 * as the JPEG-only last resort.
 */
export function tryDecode(bytes: Uint8Array): DecodedImage | undefined {
  const key = bytesKey(bytes);
  if (decodeCache.has(key)) {
    return decodeCache.get(key) ?? undefined;
  }
  let decoded: DecodedImage | undefined;
  let verdict = false; // whether "failed" is a real verdict vs codec-not-warm
  try {
    if (sniffImageFormat(bytes) === "png") {
      verdict = true;
      const raw = decodePng(bytes);
      decoded = {
        width: raw.width,
        height: raw.height,
        pixels: new Uint8ClampedArray(raw.data),
        format: "png",
      };
    } else {
      decoded = decodeImageBytes(bytes) ?? decodeJpegFallback(bytes);
      // A cold CanvasKit means "decode not attempted" for non-JPEG formats —
      // do not cache the miss or the bytes stay undecodable forever.
      verdict =
        decoded !== undefined ||
        sniffImageFormat(bytes) === "jpeg" ||
        canvasKitIfReady() !== undefined;
    }
  } catch {
    decoded = undefined;
  }
  if (decoded !== undefined || verdict) decodeCache.set(key, decoded ?? null);
  return decoded;
}

export function warmDecodeImageBytes(bytes: Uint8Array): Promise<DecodedImage | undefined> {
  return tryDecodeAsync(bytes);
}

export function collectFirstImageNodes(dom: DomTree, maxImages: number): NodeId[] {
  const ids: NodeId[] = [];
  const visit = (id: NodeId): void => {
    if (ids.length >= maxImages) return;
    const node = dom.nodes.get(id);
    if (node === undefined) return;
    if (node.kind === "element" && node.tag === "img") {
      ids.push(node.id);
    }
    for (const child of node.children) visit(child);
  };
  visit(dom.root);
  return ids;
}

/**
 * Async decode — the app/resource phase. PNG stays in-repo; all other formats
 * decode through CanvasKit (`decodeImageBytesAsync` awaits WASM init, so WebP/
 * GIF/BMP/ICO/AVIF always work without any host tool).
 */
async function tryDecodeAsync(bytes: Uint8Array): Promise<DecodedImage | undefined> {
  const key = bytesKey(bytes);
  if (decodeCache.has(key)) {
    return decodeCache.get(key) ?? undefined;
  }
  const existing = decodeAsyncInflight.get(key);
  if (existing !== undefined) return existing;

  const work = (async (): Promise<DecodedImage | undefined> => {
    try {
      if (sniffImageFormat(bytes) === "png") {
        const raw = decodePng(bytes);
        return {
          width: raw.width,
          height: raw.height,
          pixels: new Uint8ClampedArray(raw.data),
          format: "png",
        };
      }
      return (await decodeImageBytesAsync(bytes)) ?? decodeJpegFallback(bytes);
    } catch {
      return undefined;
    }
  })();

  decodeAsyncInflight.set(key, work);
  try {
    const decoded = await work;
    decodeCache.set(key, decoded ?? null);
    return decoded;
  } finally {
    decodeAsyncInflight.delete(key);
  }
}

/** Decode a `data:` URL to bytes (base64 or percent-encoded). */
export function decodeDataUrl(src: string): Uint8Array | undefined {
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
