export interface StoredCookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly secure: boolean;
  readonly expires: number | null;
}

function defaultPath(pathname: string): string {
  if (!pathname || pathname === "/") return "/";
  const idx = pathname.lastIndexOf("/");
  if (idx <= 0) return "/";
  return pathname.slice(0, idx + 1);
}

function domainMatches(cookieDomain: string, host: string): boolean {
  const cd = cookieDomain.replace(/^\./, "").toLowerCase();
  const h = host.toLowerCase();
  if (h === cd) return true;
  return h.endsWith("." + cd);
}

function pathMatches(cookiePath: string, pathname: string): boolean {
  if (cookiePath === "/") return true;
  if (pathname === cookiePath) return true;
  if (!pathname.startsWith(cookiePath)) return false;
  if (cookiePath.endsWith("/")) return true;
  return pathname.charAt(cookiePath.length) === "/";
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

  cookieHeader(requestUrl: string): string {
    let req: URL;
    try {
      req = new URL(requestUrl);
    } catch {
      return "";
    }
    const now = Date.now();
    const parts: string[] = [];
    for (const c of this.#cookies) {
      if (c.expires !== null && c.expires <= now) continue;
      if (c.secure && req.protocol !== "https:") continue;
      if (!domainMatches(c.domain, req.hostname)) continue;
      if (!pathMatches(c.path, req.pathname || "/")) continue;
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
  let path = defaultPath(page.pathname || "/");
  let secure = false;
  let expires: number | null = null;

  for (let i = 1; i < segments.length; i += 1) {
    const seg = segments[i] ?? "";
    const e = seg.indexOf("=");
    const key = (e >= 0 ? seg.slice(0, e) : seg).trim().toLowerCase();
    const val = e >= 0 ? seg.slice(e + 1).trim() : "";
    if (key === "domain" && val !== "") {
      domain = val.replace(/^\./, "").toLowerCase();
    } else if (key === "path" && val !== "") {
      path = val.startsWith("/") ? val : `/${val}`;
    } else if (key === "secure") {
      secure = true;
    } else if (key === "max-age") {
      const n = Number(val);
      if (Number.isFinite(n)) expires = Date.now() + n * 1000;
    } else if (key === "expires") {
      const t = Date.parse(val);
      if (!Number.isNaN(t)) expires = t;
    }
  }

  return { name, value, domain, path, secure, expires };
}
