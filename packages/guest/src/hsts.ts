/**
 * HSTS + baseline mixed content (RFC 0029) — `Strict-Transport-Security`
 * parsing/storage and the Mixed Content Level 2 block/upgrade decision.
 * Pure policy: the network stack consults this before the wire and
 * observes STS headers on live HTTPS responses.
 *
 * Scope: in-memory store with `serialize`/`restore` hooks so a host can
 * persist it; `preload` lists are not shipped (documented bound).
 */

interface HstsEntry {
  readonly expiresAt: number;
  readonly includeSubDomains: boolean;
}

/**
 * Per-origin HSTS policy store (RFC 6797 §6.1). `max-age=0` deletes;
 * entries over insecure transports are ignored by the caller (the stack
 * only observes HTTPS hops).
 */
export class HstsStore {
  readonly #entries = new Map<string, HstsEntry>();

  /** Record a `Strict-Transport-Security` header value for `host`. */
  observe(host: string, header: string | undefined, now: number = Date.now()): void {
    if (header === undefined) return;
    const h = host.toLowerCase();
    let maxAge = 0;
    let includeSubDomains = false;
    let valid = false;
    for (const part of header.split(";")) {
      const eq = part.indexOf("=");
      const name = (eq === -1 ? part : part.slice(0, eq)).trim().toLowerCase();
      const value = eq === -1 ? "" : part.slice(eq + 1).trim().replace(/^"|"$/g, "");
      // First directive wins for duplicates (RFC 6797 §6.1) — only the
      // FIRST max-age seen is authoritative.
      if (name === "max-age") {
        const n = Number(value);
        if (!valid && Number.isFinite(n) && n >= 0) {
          maxAge = n;
          valid = true;
        }
      } else if (name === "includesubdomains") {
        includeSubDomains = true;
      }
    }
    if (!valid) return;
    if (maxAge === 0) {
      this.#entries.delete(h);
      return;
    }
    this.#entries.set(h, { expiresAt: now + maxAge * 1000, includeSubDomains });
  }

  /** Whether an http:// request to `host` must upgrade to https:. */
  shouldUpgrade(host: string, now: number = Date.now()): boolean {
    const lower = host.toLowerCase();
    let h = lower;
    for (;;) {
      const entry = this.#entries.get(h);
      if (entry !== undefined) {
        if (now < entry.expiresAt) {
          // Exact-host hits always apply; an ancestor entry only covers when
          // it declared includeSubDomains — and a non-ISD ancestor does NOT
          // stop the walk (a higher ISD ancestor can still cover).
          if (h === lower || entry.includeSubDomains) return true;
        } else {
          this.#entries.delete(h);
        }
      }
      const dot = h.indexOf(".");
      if (dot === -1) return false;
      h = h.slice(dot + 1);
    }
  }

  /** Serialisable state for host-level persistence (explicit opt-in). */
  serialize(now: number = Date.now()): Record<string, { maxAgeSeconds: number; includeSubDomains: boolean }> {
    const out: Record<string, { maxAgeSeconds: number; includeSubDomains: boolean }> = {};
    for (const [host, entry] of this.#entries) {
      const remaining = Math.floor((entry.expiresAt - now) / 1000);
      if (remaining > 0) {
        out[host] = { maxAgeSeconds: remaining, includeSubDomains: entry.includeSubDomains };
      }
    }
    return out;
  }

  /** Restore a {@link serialize} payload (host-opt-in persistence). */
  restore(data: Record<string, { maxAgeSeconds: number; includeSubDomains: boolean }>, now: number = Date.now()): void {
    for (const [host, entry] of Object.entries(data)) {
      if (entry.maxAgeSeconds > 0) {
        this.#entries.set(host.toLowerCase(), {
          expiresAt: now + entry.maxAgeSeconds * 1000,
          includeSubDomains: entry.includeSubDomains,
        });
      }
    }
  }
}

/** Destinations Mixed Content Level 2 blocks outright ("blockable" content). */
const BLOCKABLE_DESTINATIONS: ReadonlySet<string> = new Set([
  "script", "style", "font", "iframe", "object", "embed", "manifest",
  "worker", "sharedworker", "serviceworker", "track", "xslt", "audioworklet",
  // fetch()/XHR/EventSource/beacon land on the empty destination.
  "empty",
]);

/** Passive content modern browsers UPGRADE a posteriori instead of blocking. */
const UPGRADABLE_DESTINATIONS: ReadonlySet<string> = new Set([
  "image", "audio", "video",
]);

/**
 * Whether a URL describes a potentially trustworthy context (Secure
 * Contexts §3.2 — https, wss, localhost/loopback, file:).
 */
export function isPotentiallyTrustworthyUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === "https:" || u.protocol === "wss:" || u.protocol === "file:") return true;
    if (u.protocol === "http:" || u.protocol === "ws:") {
      const host = u.hostname.toLowerCase();
      return host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]" || host === "::1";
    }
    return false;
  } catch {
    return false;
  }
}

export type MixedContentVerdict =
  | { readonly action: "allow" }
  | { readonly action: "upgrade"; readonly url: string }
  | { readonly action: "block"; readonly reason: string };

/**
 * Mixed Content Level 2 for a SUBRESOURCE request issued from a secure
 * context. `initiator` is the requesting page; `destination` the Fetch
 * destination; `mode` distinguishes navigations (exempt) from subresource
 * fetch. HSTS has already been applied by the caller — a still-http target
 * is genuinely insecure.
 */
export function mixedContentVerdict(
  targetUrl: string,
  initiator: string | undefined,
  destination: string | undefined,
  mode: string | undefined,
): MixedContentVerdict {
  // Only http: targets of secure-context initiators are mixed content;
  // navigations (top-level) are exempt — framing subloads use dest iframe.
  if (initiator === undefined || !isPotentiallyTrustworthyUrl(initiator)) {
    return { action: "allow" };
  }
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    return { action: "allow" };
  }
  // Only INSECURE http targets count — a loopback/localhost http URL is
  // itself potentially trustworthy (Secure Contexts §3.2), not mixed.
  if (target.protocol !== "http:" || isPotentiallyTrustworthyUrl(targetUrl)) {
    return { action: "allow" };
  }
  if (mode === "navigate" && destination !== "iframe") return { action: "allow" };
  const dest = destination ?? "empty";
  if (BLOCKABLE_DESTINATIONS.has(dest)) {
    return {
      action: "block",
      reason: `mixed-content:block: ${dest} request to insecure ${targetUrl} from secure ${initiator}`,
    };
  }
  if (UPGRADABLE_DESTINATIONS.has(dest)) {
    const upgraded = new URL(targetUrl);
    upgraded.protocol = "https:";
    return { action: "upgrade", url: upgraded.href };
  }
  return { action: "allow" };
}
