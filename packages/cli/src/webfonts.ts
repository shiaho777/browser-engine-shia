/**
 * `webfonts.ts` — the `@font-face` loading phase (RFC 0006).
 *
 * Same architecture as `loader.ts`'s image/stylesheet model: real fetching is
 * async and effectful, so it happens in a phase BEFORE the synchronous render
 * pipeline — never inside a kernel query. The flow per descriptor:
 *
 *   parseFontFaceRule → walk `src` in order →
 *     `local(name)`   → `registry.findLocal` (no fetch — name-table match)
 *     `url(u)`        → `data:` payload decoded inline → prefetched
 *                       ResourceCache → `fetchBytes` → sniff sfnt/WOFF →
 *                       faceFromSourceBytes → registry.register(scope)
 *
 * The FIRST usable source wins (CSS Fonts §4.3 source-list semantics). A
 * registered face is tagged with the page's `scope` so it resolves only for
 * that page's shaper — never another tab's `font-family`, never the generic
 * fallback chain.
 */
import type { StyleSheet } from "@browser-engine/ir";
import {
  collectFontFaceDescriptors,
  faceFromSourceBytes,
  fontFaceFormatSupported,
  FontRegistry,
  type FontFaceDescriptor,
} from "@browser-engine/font";

import { defaultFetch, resolveUrl, type FetchFn, type ResourceCache } from "./loader.js";

/** Stable diagnostic for one attempted `@font-face` registration. */
export interface WebFontEvent {
  readonly family: string;
  readonly status: "registered" | "all-sources-failed";
  /** The source that succeeded (`url:`, `local:`), or the last failure reason. */
  readonly detail: string;
}

/** Options for {@link registerFontFaces}. */
export interface WebFontOptions {
  /** The resource cache the loader phase already filled (optional). */
  readonly cache?: ResourceCache | undefined;
  /**
   * A synchronous href→bytes loader (the document's `cacheLoader`) — consulted
   * before `fetchBytes`; resolves relative hrefs itself.
   */
  readonly load?: ((href: string) => Uint8Array | undefined) | undefined;
  /** Fetch for non-cached URLs (defaults to Node's real `fetch`). */
  readonly fetchBytes?: FetchFn | undefined;
  /** RFC 0027: the document's CSP — `font-src` gates `url()` sources
   *  (`local()` is not a fetch). A refused source is skipped like a 404. */
  readonly csp?: import("./csp.js").CspContext | null;
}

/** Decode a `data:` URL payload (base64 or percent-encoded) → bytes. */
function decodeDataUrlBytes(url: string): Uint8Array | undefined {
  const comma = url.indexOf(",");
  if (comma === -1 || url.slice(0, 5).toLowerCase() !== "data:") return undefined;
  const meta = url.slice(5, comma);
  const payload = url.slice(comma + 1);
  if (/(?:^|;)base64/i.test(meta)) {
    try {
      return Uint8Array.from(Buffer.from(payload, "base64"));
    } catch {
      return undefined;
    }
  }
  try {
    return new TextEncoder().encode(decodeURIComponent(payload));
  } catch {
    return undefined;
  }
}

/**
 * Register every usable `@font-face` descriptor from `sheets` against
 * `registry`, scoped to `scope`. Returns per-descriptor diagnostics. Faces are
 * registered under the DESCRIPTOR metadata (`font-weight: 400 700` →
 * `weightRange`), overriding the file's own name-table values per CSS Fonts
 * §4.3.
 */
/**
 * Idempotency guard: `(registry → registered keys)` — the kernel/harness paths
 * re-run the sync pass on every render, and a registered face must not be
 * appended twice (the table is append-only and per-scope).
 */
const registeredKeys = new WeakMap<FontRegistry, Set<string>>();
function markRegistered(registry: FontRegistry, scope: unknown, key: string): boolean {
  let set = registeredKeys.get(registry);
  if (set === undefined) {
    set = new Set();
    registeredKeys.set(registry, set);
  }
  const k = `${String(scope)}\u0000${key}`;
  if (set.has(k)) return false;
  set.add(k);
  return true;
}

export async function registerFontFaces(
  sheets: readonly StyleSheet[],
  registry: FontRegistry,
  baseUrl: string,
  scope: unknown,
  options: WebFontOptions = {},
): Promise<WebFontEvent[]> {
  const fetchBytes = options.fetchBytes ?? defaultFetch;
  const events: WebFontEvent[] = [];

  const tryDescriptor = async (d: FontFaceDescriptor): Promise<WebFontEvent> => {
    if (!markRegistered(registry, scope, `d:${d.family}|${JSON.stringify(d.sources)}`)) {
      return { family: d.family, status: "registered", detail: "already-registered" };
    }
    for (const src of d.sources) {
      if (src.kind === "local") {
        const idx = registry.findLocal(src.name, scope);
        if (idx < 0) continue;
        // Re-register the SAME face under the declared descriptors — the
        // `local()` hit may be a differently-named/styled family member.
        const face = registry.faces[idx];
        if (face === undefined) continue;
        registry.register(face, descriptorInfo(d), scope);
        return { family: d.family, status: "registered", detail: `local:${src.name}` };
      }
      if (!fontFaceFormatSupported(src.format)) continue;
      let abs = resolveUrl(src.url, baseUrl);
      if (abs === null) continue;
      // RFC 0027: `font-src` gates the `url()` fetch target (data: decodes
      // still count — `data:` requires an explicit source). Mixed-content
      // upgrade rewrites http targets before the check.
      if (options.csp !== null && options.csp !== undefined) {
        const gated = options.csp.gateSubresourceUrl(abs);
        if (gated.blocked || !options.csp.check("font", gated.url).allowed) continue;
        abs = gated.url;
      }
      const bytes =
        decodeDataUrlBytes(abs) ??
        options.cache?.get(abs) ??
        options.load?.(src.url) ??
        (await fetchBytes(abs));
      if (bytes === undefined) continue;
      const face = faceFromSourceBytes(bytes);
      if (face === null) continue;
      registry.register(face, descriptorInfo(d), scope);
      return { family: d.family, status: "registered", detail: `url:${abs}` };
    }
    return { family: d.family, status: "all-sources-failed", detail: "" };
  };

  for (const d of collectFontFaceDescriptors(sheets)) {
    events.push(await tryDescriptor(d));
  }
  return events;
}

/**
 * The SYNCHRONOUS subset of {@link registerFontFaces} — `local()` sources and
 * `data:` `url()`s only (no network). For the in-memory/kernel pipeline paths
 * (`LiveSession`, `FineSession`, `qLayout`) whose document load has no async
 * phase: a self-contained data-URL webfont in a test page still resolves.
 */
export function registerFontFacesSync(
  sheets: readonly StyleSheet[],
  registry: FontRegistry,
  baseUrl: string,
  scope: unknown,
  options: Pick<WebFontOptions, "cache" | "load" | "csp"> = {},
): WebFontEvent[] {
  const events: WebFontEvent[] = [];
  for (const d of collectFontFaceDescriptors(sheets)) {
    if (!markRegistered(registry, scope, `d:${d.family}|${JSON.stringify(d.sources)}`)) {
      events.push({ family: d.family, status: "registered", detail: "already-registered" });
      continue;
    }
    let done: WebFontEvent | null = null;
    for (const src of d.sources) {
      if (src.kind === "local") {
        const idx = registry.findLocal(src.name, scope);
        const face = idx >= 0 ? registry.faces[idx] : undefined;
        if (face === undefined) continue;
        registry.register(face, descriptorInfo(d), scope);
        done = { family: d.family, status: "registered", detail: `local:${src.name}` };
        break;
      }
      if (!fontFaceFormatSupported(src.format)) continue;
      let abs = resolveUrl(src.url, baseUrl);
      if (abs === null) continue;
      if (options.csp !== null && options.csp !== undefined) {
        const gated = options.csp.gateSubresourceUrl(abs);
        if (gated.blocked || !options.csp.check("font", gated.url).allowed) continue;
        abs = gated.url;
      }
      const bytes =
        decodeDataUrlBytes(abs) ?? options.cache?.get(abs) ?? options.load?.(src.url);
      if (bytes === undefined) continue; // network source — the async phase's job.
      const face = faceFromSourceBytes(bytes);
      if (face === null) continue;
      registry.register(face, descriptorInfo(d), scope);
      done = { family: d.family, status: "registered", detail: `url:${abs}` };
      break;
    }
    events.push(done ?? { family: d.family, status: "all-sources-failed", detail: "" });
  }
  return events;
}

/**
 * Descriptor → registry metadata: the DECLARED family/weight/style/stretch
 * override the face's own name-table values (a file declared `font-weight:
 * 700` IS the family's bold member even if its OS/2 says 400). A weight RANGE
 * registers `weightRange` so scoring treats in-range requests as exact hits.
 */
function descriptorInfo(d: FontFaceDescriptor): {
  family: string;
  italic: boolean;
  widthClass: number;
  weightClass?: number;
  weightRange?: readonly [number, number];
} {
  return {
    family: d.family,
    italic: d.italic,
    widthClass: d.widthClass,
    ...(d.weight.lo === d.weight.hi
      ? { weightClass: d.weight.lo }
      : { weightRange: [d.weight.lo, d.weight.hi] }),
  };
}
