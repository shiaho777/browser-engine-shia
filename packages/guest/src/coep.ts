/**
 * RFC 0031 — cross-origin *embedder/opener/resource* policies:
 *
 * - **COEP** (`Cross-Origin-Embedder-Policy`): `require-corp` makes every
 *   cross-origin `no-cors` subresource (and cross-origin iframe navigation)
 *   carry an allowing `Cross-Origin-Resource-Policy`; `credentialless`
 *   substitutes credential stripping for the CORP requirement.
 * - **CORP** (`Cross-Origin-Resource-Policy`): the resource's reply —
 *   `same-origin` / `same-site` / `cross-origin`.
 * - **COOP** (`Cross-Origin-Opener-Policy`): decides whether a `window.open`/
 *   `_blank` pair keeps an opener relationship or is severed into separate
 *   browsing-context groups (HTML §7.1.3.1 "obtain a browsing context group").
 * - **`Origin-Agent-Cluster: ?1`** — requests an origin-keyed agent cluster;
 *   this engine's site isolation is ALWAYS origin-keyed, so the flag is
 *   observational (`window.originAgentCluster`), not behavioral.
 *
 * Pure policy — no I/O, like cors.ts/hsts.ts.
 */

export type Coep = "unsafe-none" | "require-corp" | "credentialless";
export type Coop =
  | "unsafe-none"
  | "same-origin"
  | "same-origin-allow-popups"
  | "noopener-allow-popups";
export type Corp = "same-origin" | "same-site" | "cross-origin";

export function parseCoep(value: string | null | undefined): Coep {
  const v = value?.trim().toLowerCase();
  if (v === "require-corp") return "require-corp";
  if (v === "credentialless") return "credentialless";
  return "unsafe-none";
}

export function parseCoop(value: string | null | undefined): Coop {
  const v = value?.trim().toLowerCase();
  if (v === "same-origin") return "same-origin";
  if (v === "same-origin-allow-popups") return "same-origin-allow-popups";
  if (v === "noopener-allow-popups") return "noopener-allow-popups";
  return "unsafe-none";
}

export function parseCorp(value: string | null | undefined): Corp | null {
  const v = value?.trim().toLowerCase();
  if (v === "same-origin" || v === "same-site" || v === "cross-origin") return v;
  return null;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Site = scheme + registrable-ish host tail (eTLD-free approximation:
 *  last two labels — honest boundary, documented). */
function siteOf(url: string): string | null {
  const origin = originOf(url);
  if (origin === null || origin === "null") return null;
  try {
    const u = new URL(origin);
    const parts = u.hostname.split(".");
    const reg = parts.length >= 2 ? parts.slice(-2).join(".") : u.hostname;
    return `${u.protocol}//${reg}`;
  } catch {
    return null;
  }
}

/**
 * `corpAllows` — whether a CORP response header permits the cross-origin
 * fetch (Fetch §"cross-origin resource policy check"):
 *  - `cross-origin` allows everyone;
 *  - `same-site` requires same site;
 *  - `same-origin` requires same origin;
 *  - absent ⇒ only same-origin requests pass (the header's default).
 */
export function corpAllows(
  corp: Corp | null,
  requestOrigin: string,
  resourceOrigin: string,
): boolean {
  const req = originOf(requestOrigin);
  const res = originOf(resourceOrigin);
  if (req === null || res === null) return corp === "cross-origin";
  const sameOrigin = req === res;
  const sameSite = siteOf(requestOrigin) === siteOf(resourceOrigin);
  switch (corp) {
    case "cross-origin":
      return true;
    case "same-site":
      return sameOrigin || sameSite;
    case "same-origin":
      return sameOrigin;
    default:
      return sameOrigin;
  }
}

/**
 * Whether `initiatorCoep` subjects a request to CORP/credentialless rules.
 * Per Fetch: only `no-cors` cross-origin fetches and cross-origin iframe
 * navigations are gated (CORS requests authorize via CORS itself;
 * `mode:"navigate"` top-level loads are exempt, but `destination:"iframe"`
 * subloads are not).
 */
export function coepApplies(mode: string, destination?: string): boolean {
  return mode === "no-cors" || (mode === "navigate" && destination === "iframe");
}

/**
 * `coopSeversOpenerLink` — the HTML spec table for whether an opened
 * auxiliary context keeps `window.opener`:
 *  - `same-origin`: severs unless BOTH docs are same-origin AND the openee
 *    also carries `same-origin`.
 *  - `same-origin-allow-popups`: severs unless same-origin openee whose
 *    coop is `unsafe-none`/`same-origin-allow-popups` — OR a cross-origin
 *    *popup* whose coop is `unsafe-none`.
 *  - `noopener-allow-popups`: severs unless the openee is a popup (any
 *    origin) — popups keep a window reference but no opener.
 *  - `unsafe-none`: never severs.
 *
 * `sameOrigin` compares the two DOCUMENT origins; `popup` is the
 * `window.open` feature bit (target=_blank links are not popups).
 */
export function coopSeversOpenerLink(
  openerCoop: Coop,
  openedCoop: Coop,
  sameOrigin: boolean,
  popup: boolean,
): boolean {
  switch (openerCoop) {
    case "unsafe-none":
      return false;
    case "same-origin":
      return !(sameOrigin && openedCoop === "same-origin");
    case "same-origin-allow-popups":
      return !(
        (sameOrigin &&
          (openedCoop === "unsafe-none" || openedCoop === "same-origin-allow-popups")) ||
        (!sameOrigin && popup && openedCoop === "unsafe-none")
      );
    case "noopener-allow-popups":
      return !popup;
  }
}

/**
 * `crossOriginIsolated` — the gate real browsers put on SharedArrayBuffer /
 * high-res timers: top-level COOP `same-origin` AND COEP `require-corp`
 * (or `credentialless`). Ancestor COEP consistency is enforced separately
 * (a require-corp embedder already blocks non-CORP'd children).
 */
export function crossOriginIsolated(coep: Coep, coop: Coop): boolean {
  return coop === "same-origin" && (coep === "require-corp" || coep === "credentialless");
}
