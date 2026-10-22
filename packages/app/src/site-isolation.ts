/**
 * RFC 0030 — site isolation: which nested navigables get their own
 * process (a `worker_threads` worker inside the web-content process).
 *
 * ## Isolation key: ORIGIN, not site
 *
 * Real browsers isolate by *site* (scheme + registrable domain — needs the
 * Public Suffix List). We isolate by **origin** (scheme + host + port):
 * strictly finer than site, so it can only ever over-isolate — never share
 * a process across a boundary the spec calls separate. The PSL table is a
 * documented bound (no bundled list); `a.example.com` vs `b.example.com`
 * get separate workers where Chrome would share one. Same-*origin*
 * children keep the in-process path so `contentDocument` still reaches.
 */

/** The isolation key for a URL, or null when the URL is never isolated. */
export function siteIsolationKey(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * Whether the child document at `childUrl` embeds cross-site relative to
 * `embedderUrl`. `about:blank`/`srcdoc`/`data:`/`file:` documents inherit
 * the embedder's origin — never isolated (callers resolve srcdoc before
 * asking). Non-http(s) child URLs are never isolated either.
 */
export function shouldIsolateFrame(embedderUrl: string, childUrl: string): boolean {
  const embedder = siteIsolationKey(embedderUrl);
  const child = siteIsolationKey(childUrl);
  return embedder !== null && child !== null && embedder !== child;
}
