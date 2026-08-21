/**
 * Resource loader — loads external resources referenced by `<img>`, `<script>`,
 * `<link>` elements. Uses the existing `NetworkStack` for HTTP requests.
 *
 * For images: loads the image bytes and decodes dimensions (natural width/
 * height). For scripts: loads the JS source and feeds it to the GuestRuntime
 * for evaluation. For stylesheets: loads the CSS text and feeds it to the
 * CSS parser. For fonts: loads the font bytes and feeds them to the font
 * subsystem.
 */
import type { NetworkStack } from "./network.js";

export interface LoadedResource {
  readonly url: string;
  readonly type: "image" | "script" | "style" | "font" | "other";
  readonly bytes: Uint8Array;
  readonly text: string;
  readonly status: number;
  readonly ok: boolean;
  readonly error?: string;
}

/**
 * Load a resource from `url`. Returns a promise that resolves with the
 * loaded bytes (and decoded text). Network errors resolve with `ok: false`
 * rather than rejecting, so callers can fire `error` events.
 */
export async function loadResource(
  stack: NetworkStack,
  url: string,
  type: LoadedResource["type"],
): Promise<LoadedResource> {
  try {
    const response = await stack.request({
      method: "GET",
      url,
      headers: {},
    });
    const bytes = response.body;
    const text = new TextDecoder().decode(bytes);
    return {
      url,
      type,
      bytes,
      text,
      status: response.status,
      ok: response.ok,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      url,
      type,
      bytes: new Uint8Array(0),
      text: "",
      status: 0,
      ok: false,
      error: message,
    };
  }
}

/**
 * Resolve a relative URL against a base URL.
 * Handles the common cases: absolute URLs pass through, relative URLs are
 * joined to the base.
 */
export function resolveUrl(base: string, relative: string): string {
  if (relative.startsWith("http://") || relative.startsWith("https://") || relative.startsWith("data:")) {
    return relative;
  }
  if (relative.startsWith("//")) {
    // Protocol-relative URL.
    const protocol = base.startsWith("https") ? "https:" : "http:";
    return protocol + relative;
  }
  if (relative.startsWith("/")) {
    // Absolute path relative to domain root.
    const m = /^[^/]+\/\/[^/]+/.exec(base);
    if (m !== null) return m[0] + relative;
    return relative;
  }
  // Relative path.
  const lastSlash = base.lastIndexOf("/");
  if (lastSlash === -1) return relative;
  // Strip everything after the last slash in the base path.
  const baseDir = base.slice(0, lastSlash + 1);
  return baseDir + relative;
}
