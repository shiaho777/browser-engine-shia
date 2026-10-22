export interface StoredCookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly secure: boolean;
  readonly expires: number | null;
  /**
   * RFC 6265 §5.3: a Set-Cookie WITHOUT a `Domain` attribute is host-only —
   * it must NOT match subdomains. A `Domain=` attribute opts into suffix
   * matching (the leading dot is ignored by spec since 2011).
   */
  readonly hostOnly: boolean;
  /**
   * SameSite enforcement tier. "lax" is the modern default (Chrome 80+);
   * "none" requires `Secure` per spec — a non-Secure `None` is treated as
   * `lax`. Unknown values fall back to `lax`.
   */
  readonly sameSite: "lax" | "strict" | "none";
}

/**
 * The initiator context for a cookie send decision. `initiator` is the URL of
 * the page/frame that caused the request; `topLevelNavigate` marks the
 * document navigation case (SameSite=Lax allows top-level cross-site GETs).
 */
export interface CookieSendContext {
  /** URL of the initiating page/frame. Absent ⇒ same-site assumed (legacy). */
  readonly initiator?: string | undefined;
  /** True when this request is a top-level navigation (mode "navigate"). */
  readonly topLevelNavigate?: boolean;
}

function defaultPath(pathname: string): string {
  if (!pathname || pathname === "/") return "/";
  const idx = pathname.lastIndexOf("/");
  if (idx <= 0) return "/";
  return pathname.slice(0, idx + 1);
}

function domainMatches(cookie: StoredCookie, host: string): boolean {
  const cd = cookie.domain.toLowerCase();
  const h = host.toLowerCase();
  if (h === cd) return true;
  // Host-only cookies never suffix-match; Domain cookies do.
  return !cookie.hostOnly && h.endsWith("." + cd);
}

function pathMatches(cookiePath: string, pathname: string): boolean {
  if (cookiePath === "/") return true;
  if (pathname === cookiePath) return true;
  if (!pathname.startsWith(cookiePath)) return false;
  if (cookiePath.endsWith("/")) return true;
  return pathname.charAt(cookiePath.length) === "/";
}

/**
 * Same-site test per the cookies spec's registrable-domain notion, minus a
 * public-suffix list: same origin is same-site; otherwise compare the last two
 * labels of each hostname (the same approximation Sec-Fetch-Site already uses
 * in this codebase).
 */
function sameSiteAs(requestHost: string, initiatorHost: string): boolean {
  const siteOf = (host: string): string => {
    const parts = host.toLowerCase().split(".");
    return parts.length >= 2 ? parts.slice(-2).join(".") : host.toLowerCase();
  };
  return siteOf(requestHost) === siteOf(initiatorHost);
}

export class CookieJar {
  readonly #cookies: StoredCookie[] = [];

  get size(): number {
    return this.#cookies.length;
  }

  clear(): void {
    this.#cookies.length = 0;
  }

  storeFromSetCookie(pageUrl: string, setCookieLines: readonly string[]): void {
    let page: URL;
    try {
      page = new URL(pageUrl);
    } catch {
      return;
    }
    for (const line of setCookieLines) {
      const parsed = parseSetCookie(line, page);
      if (parsed === null) continue;
      this.#upsert(parsed);
    }
  }

  cookieHeader(requestUrl: string, context: CookieSendContext = {}): string {
    let req: URL;
    try {
      req = new URL(requestUrl);
    } catch {
      return "";
    }
    let initiator: URL | null = null;
    if (context.initiator !== undefined) {
      try {
        initiator = new URL(context.initiator);
      } catch {
        initiator = null;
      }
    }
    const crossSite =
      initiator !== null && !sameSiteAs(req.hostname, initiator.hostname);
    const now = Date.now();
    const parts: string[] = [];
    for (const c of this.#cookies) {
      if (c.expires !== null && c.expires <= now) continue;
      if (c.secure && req.protocol !== "https:") continue;
      if (!domainMatches(c, req.hostname)) continue;
      if (!pathMatches(c.path, req.pathname || "/")) continue;
      // SameSite enforcement (Cookies spec §5.5 / modern defaults):
      //   cross-site ⇒ None+Secure only, plus Lax on top-level navigations.
      if (crossSite) {
        if (c.sameSite === "strict") continue;
        if (c.sameSite === "lax" && context.topLevelNavigate !== true) continue;
        if (c.sameSite === "none" && !c.secure) continue;
      }
      parts.push(`${c.name}=${c.value}`);
    }
    return parts.join("; ");
  }

  snapshot(): readonly StoredCookie[] {
    return [...this.#cookies];
  }

  #upsert(cookie: StoredCookie): void {
    const idx = this.#cookies.findIndex(
      (c) => c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path,
    );
    if (cookie.expires !== null && cookie.expires <= Date.now()) {
      if (idx >= 0) this.#cookies.splice(idx, 1);
      return;
    }
    if (idx >= 0) this.#cookies[idx] = cookie;
    else this.#cookies.push(cookie);
  }
}

function parseSetCookie(line: string, page: URL): StoredCookie | null {
  const segments = line.split(";").map((s) => s.trim());
  const first = segments[0];
  if (first === undefined || first === "") return null;
  const eq = first.indexOf("=");
  if (eq <= 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (name === "") return null;

  let domain = page.hostname;
  let hostOnly = true;
  let path = defaultPath(page.pathname || "/");
  let secure = false;
  let sameSite: StoredCookie["sameSite"] = "lax";
  let expires: number | null = null;

  for (let i = 1; i < segments.length; i += 1) {
    const seg = segments[i] ?? "";
    const e = seg.indexOf("=");
    const key = (e >= 0 ? seg.slice(0, e) : seg).trim().toLowerCase();
    const val = e >= 0 ? seg.slice(e + 1).trim() : "";
    if (key === "domain" && val !== "") {
      const d = val.replace(/^\./, "").toLowerCase();
      // A Domain attribute that does NOT suffix-match the host is rejected
      // (a site may not set cookies for other hosts).
      const h = page.hostname.toLowerCase();
      if (h === d || h.endsWith("." + d)) {
        domain = d;
        hostOnly = false;
      }
    } else if (key === "path" && val !== "") {
      path = val.startsWith("/") ? val : `/${val}`;
    } else if (key === "secure") {
      secure = true;
    } else if (key === "samesite") {
      const v = val.toLowerCase();
      sameSite = v === "strict" ? "strict" : v === "none" ? "none" : "lax";
    } else if (key === "max-age") {
      const n = Number(val);
      if (Number.isFinite(n)) expires = Date.now() + n * 1000;
    } else if (key === "expires") {
      const t = Date.parse(val);
      if (!Number.isNaN(t)) expires = t;
    }
  }

  // `SameSite=None` requires Secure — a non-Secure None cookie acts as Lax
  // (the "reject insecure" half of the spec is a deprecation path; treating it
  // as Lax is the interoperable behavior).
  if (sameSite === "none" && !secure) sameSite = "lax";

  return { name, value, domain, path, secure, expires, hostOnly, sameSite };
}
