/**
 * csp.ts — Content-Security-Policy enforcement (RFC 0027).
 *
 * A document carries a POLICY LIST (every `Content-Security-Policy` and
 * `…-Report-Only` response header is a separate policy — comma-separated
 * headers split — plus `<meta http-equiv>` policies). Enforcement is a
 * conjunction: a fetch directive check passes only when EVERY enforce-mode
 * policy allows it; report-only policies still observe and report.
 *
 * This module is pure policy: parse → match → verdict. The wiring points
 * (script collection, stylesheet collection, subresource discovery, guest
 * connect-src, iframe navigation, frame-ancestors) live in their call sites
 * — the engine's CSP boundary is the call sites' job, exactly like a real
 * browser where the policy container sits on the environment and each
 * fetch/script/parse step consults it.
 */
import { createHash } from "node:crypto";

import type { DomTree } from "@browser-engine/ir";

/** One parsed policy: a directive map plus where it came from. */
export interface CspPolicy {
  readonly source: "header" | "meta";
  /** `Content-Security-Policy-Report-Only`: observes, never blocks. */
  readonly reportOnly: boolean;
  /** directive-name → source-expression list (names lowercased). */
  readonly directives: ReadonlyMap<string, readonly string[]>;
}

/** Fetch-destination families CSP gates. */
export type CspFetchKind =
  | "script"
  | "style"
  | "img"
  | "connect"
  | "font"
  | "frame"
  | "worker"
  | "media"
  | "manifest"
  | "object"
  | "prefetch";

/** What an inline check is gated on (a `<script>`/`<style>` block's contents or a `style=` attribute). */
export interface CspInlineTarget {
  /** The element's `nonce` attribute (HTML strips it from getAttribute; the DOM keeps it). */
  readonly nonce?: string | undefined;
  /** The inline text being executed/applied — hashed against `'sha256-…'` sources. */
  readonly text?: string | undefined;
}

/** One policy's verdict plus the violation it would report (when blocked). */
export interface CspViolation {
  /** The directive name as written (`script-src`), or the resolved fallback (`default-src`). */
  readonly directive: string;
  /** The directive the match was decided by after fallback resolution. */
  readonly effectiveDirective: string;
  readonly blockedUrl: string;
  readonly documentUrl: string;
  readonly disposition: "enforce" | "report";
  /** ≤40-char sample of the blocked inline source (spec's `sample` field). */
  readonly sample?: string;
}

export interface CspVerdict {
  readonly allowed: boolean;
  readonly violations: readonly CspViolation[];
}

/**
 * Directive fallback chain (CSP3 §6.1.14): `frame-src`/`worker-src` fall
 * through `child-src` (worker also through `script-src`); the `-elem`/`-attr`
 * split directives refine their parent. `frame-ancestors` and the
 * reporting/navigation directives have NO default-src fallback.
 */
const FALLBACK: Readonly<Record<string, readonly string[]>> = {
  "script-src-elem": ["script-src-elem", "script-src", "default-src"],
  "script-src-attr": ["script-src-attr", "script-src", "default-src"],
  "style-src-elem": ["style-src-elem", "style-src", "default-src"],
  "style-src-attr": ["style-src-attr", "style-src", "default-src"],
  "script-src": ["script-src", "default-src"],
  "style-src": ["style-src", "default-src"],
  "img-src": ["img-src", "default-src"],
  "connect-src": ["connect-src", "default-src"],
  "font-src": ["font-src", "default-src"],
  "media-src": ["media-src", "default-src"],
  "manifest-src": ["manifest-src", "default-src"],
  "object-src": ["object-src", "default-src"],
  "prefetch-src": ["prefetch-src", "default-src"],
  "frame-src": ["frame-src", "child-src", "default-src"],
  "worker-src": ["worker-src", "child-src", "script-src", "default-src"],
};

const KIND_DIRECTIVE: Readonly<Record<CspFetchKind, string>> = {
  script: "script-src",
  style: "style-src",
  img: "img-src",
  connect: "connect-src",
  font: "font-src",
  frame: "frame-src",
  worker: "worker-src",
  media: "media-src",
  manifest: "manifest-src",
  object: "object-src",
  prefetch: "prefetch-src",
};

/** Parse one header/meta value into its (comma-separated) policy list. */
export function parseCspValue(value: string, source: "header" | "meta"): CspPolicy[] {
  const policies: CspPolicy[] = [];
  for (const policyText of value.split(",")) {
    const directives = new Map<string, string[]>();
    for (const part of policyText.split(";")) {
      const tokens = part.trim().split(/\s+/).filter(Boolean);
      if (tokens.length === 0) continue;
      const name = tokens[0]!.toLowerCase();
      // First occurrence wins per spec ("the first directive wins").
      if (!directives.has(name)) directives.set(name, tokens.slice(1));
    }
    if (directives.size > 0) {
      policies.push(
        Object.freeze({
          source,
          reportOnly: false,
          directives,
        }),
      );
    }
  }
  return policies;
}

/** Parse a response-header map into the enforcing + reporting policy list. */
export function cspFromHeaders(headers: Readonly<Record<string, string>>): CspPolicy[] {
  const out: CspPolicy[] = [];
  const enforce = headers["content-security-policy"];
  const reportOnly = headers["content-security-policy-report-only"];
  if (enforce !== undefined) {
    out.push(...parseCspValue(enforce, "header"));
  }
  if (reportOnly !== undefined) {
    out.push(...parseCspValue(reportOnly, "header").map((p) => ({ ...p, reportOnly: true })));
  }
  return out;
}

/**
 * `<meta http-equiv="Content-Security-Policy" content="…">` — meta policies
 * cannot carry `frame-ancestors`/`report-uri`/`sandbox` (the tokenizer keeps
 * them but enforcement ignores them — matching spec §meta-element behavior).
 */
export function cspFromMeta(dom: DomTree): CspPolicy[] {
  const out: CspPolicy[] = [];
  const visit = (id: DomTree["root"]): void => {
    const node = dom.nodes.get(id);
    if (node === undefined) return;
    if (node.kind === "element" && node.tag === "meta") {
      const equiv = node.attrs?.get("http-equiv")?.trim().toLowerCase();
      const content = node.attrs?.get("content");
      if (equiv === "content-security-policy" && content !== undefined) {
        for (const p of parseCspValue(content, "meta")) {
          const directives = new Map(p.directives);
          directives.delete("frame-ancestors");
          directives.delete("report-uri");
          directives.delete("sandbox");
          if (directives.size > 0) out.push(Object.freeze({ ...p, directives }));
        }
      }
    }
    for (const c of node.children) visit(c);
  };
  visit(dom.root);
  return out;
}

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.origin === "null" ? null : u.origin;
  } catch {
    return null;
  }
}

/**
 * `'self'`: same origin — and per CSP3 an http(s) document's `self` ALSO
 * matches the `ws:`/`wss:` socket schemes of the same host (websocket
 * connections are same-site even though the scheme differs).
 */
function matchesSelf(url: string, documentUrl: string): boolean {
  const doc = new URL(documentUrl);
  const target = new URL(url);
  if (target.origin === doc.origin && target.origin !== "null") return true;
  const docIsHttp = doc.protocol === "http:" || doc.protocol === "https:";
  const sameHost =
    target.hostname === doc.hostname &&
    (target.port || defaultPort(target.protocol)) === (doc.port || defaultPort(doc.protocol));
  if (!docIsHttp || !sameHost) return false;
  if (doc.protocol === "http:") return target.protocol === "ws:";
  return target.protocol === "wss:" || target.protocol === "https:";
}

function defaultPort(protocol: string): string {
  return protocol === "https:" || protocol === "wss:" ? "443" : protocol === "http:" || protocol === "ws:" ? "80" : "";
}

/**
 * Does a single source-expression match `url`? Scheme sources (`https:`),
 * host sources (`*.x.com`, `x.com`, `x.com:8443`, ports `x.com:*`), `*`,
 * and `'self'`; everything else (`'nonce-*'`, hashes, `'unsafe-*'`) is not a
 * URL source.
 */
function sourceMatchesUrl(source: string, url: string, _documentUrl: string): boolean {
  const s = source.toLowerCase();
  if (s === "'none'" || s.startsWith("'")) return false;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (s === "*") {
    // `*` matches any URL except the non-network schemes (CSP3: data:, blob:,
    // filesystem: are never covered by a bare wildcard).
    return (
      target.protocol !== "data:" &&
      target.protocol !== "blob:" &&
      target.protocol !== "filesystem:"
    );
  }
  if (s.endsWith(":")) {
    // scheme source — `https:` ALSO admits `wss:`? No: scheme matching is
    // exact except that `http:`/`https:` upgrade-matches (http: source covers
    // https: targets per CSP3 scheme-source rules).
    const scheme = s.slice(0, -1);
    if (scheme === "http") return target.protocol === "http:" || target.protocol === "https:";
    if (scheme === "ws") return target.protocol === "ws:" || target.protocol === "wss:";
    return target.protocol === `${scheme}:`;
  }
  if (s === "'self'") return false; // handled earlier — defensive
  // host-source: [*.]host[:port]  (optionally scheme://host[:port])
  let host = s;
  const schemeSplit = s.indexOf("://");
  let schemeRestriction: string | null = null;
  if (schemeSplit >= 0) {
    schemeRestriction = s.slice(0, schemeSplit);
    host = s.slice(schemeSplit + 3);
    if (schemeRestriction === "http" && target.protocol === "https:") {
      // http: scheme source covers https: targets.
      schemeRestriction = null;
    }
    if (schemeRestriction !== null && target.protocol !== `${schemeRestriction}:`) return false;
  }
  const portSplit = host.lastIndexOf(":");
  let portRestriction: string | null = null;
  if (portSplit >= 0 && !host.endsWith("]")) {
    portRestriction = host.slice(portSplit + 1);
    host = host.slice(0, portSplit);
  }
  if (host.startsWith("*.")) {
    const suffix = host.slice(2);
    if (!(target.hostname === suffix || target.hostname.endsWith(`.${suffix}`))) return false;
  } else if (host !== "*" && target.hostname !== host) {
    return false;
  }
  if (portRestriction !== null && portRestriction !== "*") {
    const tp = target.port || defaultPort(target.protocol);
    if (tp !== portRestriction) return false;
  }
  return true;
}

/** Base64 digest of the inline source under `alg` ("sha256" | "sha384" | "sha512"). */
export function cspHash(alg: string, text: string): string {
  return createHash(alg).update(text, "utf8").digest("base64");
}

/** The directive's source list, following the fallback chain; `undefined` = unrestricted. */
function directiveSources(policy: CspPolicy, directive: string): readonly string[] | undefined {
  for (const name of FALLBACK[directive] ?? [directive, "default-src"]) {
    const v = policy.directives.get(name);
    if (v !== undefined) return v;
  }
  return undefined;
}

function resolvedDirectiveName(policy: CspPolicy, directive: string): string {
  for (const name of FALLBACK[directive] ?? [directive, "default-src"]) {
    if (policy.directives.has(name)) return name;
  }
  return directive;
}

/**
 * `'unsafe-inline'` is ignored when the SAME directive also lists a nonce or
 * hash source (CSP3 §6.7.2.4 — you cannot opt back into inline code you
 * just opted out of by committing to nonces); `'strict-dynamic'` likewise
 * suppresses it for script-src.
 */
function unsafeInlineEffective(sources: readonly string[]): boolean {
  if (!sources.includes("'unsafe-inline'")) return false;
  const hasNonceOrHash = sources.some(
    (s) => s.startsWith("'nonce-") || s.startsWith("'sha256-") || s.startsWith("'sha384-") || s.startsWith("'sha512-"),
  );
  return !hasNonceOrHash;
}

function inlineAllowedBy(
  policy: CspPolicy,
  directive: string,
  target: CspInlineTarget,
): boolean {
  const sources = directiveSources(policy, directive);
  if (sources === undefined) return true;
  if (unsafeInlineEffective(sources)) return true;
  // Attributes vs elements (CSP3 §6.7.2.3): nonces apply to ELEMENTS only —
  // `style=`/`on*=` attributes carry no nonce; attribute blocks instead open
  // hash matching only when the list carries 'unsafe-hashes'.
  const isAttr = directive.endsWith("-attr");
  if (!isAttr && target.nonce !== undefined && target.nonce !== "") {
    const needle = `'nonce-${target.nonce}'`;
    if (sources.some((s) => s.toLowerCase() === needle)) return true;
  }
  const hashApplies = !isAttr || sources.includes("'unsafe-hashes'");
  if (hashApplies && target.text !== undefined) {
    for (const s of sources) {
      // The algorithm prefix is case-insensitive; the base64 DIGEST is not —
      // lowercasing the whole source would corrupt it.
      const m = /^'(sha256|sha384|sha512)-(.+)'$/i.exec(s);
      if (m !== null && m[2] === cspHash(m[1]!.toLowerCase(), target.text)) return true;
    }
  }
  return false;
}

function urlAllowedBy(policy: CspPolicy, directive: string, url: string, documentUrl: string): boolean {
  const sources = directiveSources(policy, directive);
  if (sources === undefined) return true;
  for (const s of sources) {
    if (s === "'self'") {
      try {
        if (matchesSelf(url, documentUrl)) return true;
      } catch {
        /* unparsable doc URL — cannot be self */
      }
      continue;
    }
    if (sourceMatchesUrl(s, url, documentUrl)) return true;
  }
  return false;
}

function makeViolation(
  policy: CspPolicy,
  directive: string,
  url: string,
  documentUrl: string,
  sample?: string,
): CspViolation {
  return {
    directive,
    effectiveDirective: resolvedDirectiveName(policy, directive),
    blockedUrl: url,
    documentUrl,
    disposition: policy.reportOnly ? "report" : "enforce",
    ...(sample !== undefined ? { sample: sample.slice(0, 40) } : {}),
  };
}

/**
 * The document's enforcement context: every check returns allowed?
 * + violations; the caller posts `reportViolation`s through its own
 * reporter so this module never does I/O itself.
 */
export class CspContext {
  readonly policies: readonly CspPolicy[];
  readonly documentUrl: string;
  readonly violations: CspViolation[] = [];

  constructor(policies: readonly CspPolicy[], documentUrl: string) {
    this.policies = policies;
    this.documentUrl = documentUrl;
  }

  /** True when no CSP applies at all — fast path for policy-free documents. */
  get empty(): boolean {
    return this.policies.length === 0;
  }

  /**
   * Fetch-directive check for a subresource URL (`script-src`, `img-src`,
   * `connect-src`, …). Allowed only when EVERY enforce-mode policy allows;
   * report-only policies still record a violation.
   */
  check(kind: CspFetchKind, url: string, variant?: "elem" | "attr"): CspVerdict {
    // `-elem`/`-attr` refine the fetch directive for element-originated
    // requests (`<script src>` is a script-src-elem fetch; a module specifier
    // import is plain script-src) — the fallback table supplies the chain.
    const directive =
      variant !== undefined ? `${KIND_DIRECTIVE[kind]}-${variant}` : KIND_DIRECTIVE[kind];
    const violations: CspViolation[] = [];
    let blocked = false;
    for (const policy of this.policies) {
      if (urlAllowedBy(policy, directive, url, this.documentUrl)) continue;
      violations.push(makeViolation(policy, directive, url, this.documentUrl));
      if (!policy.reportOnly) blocked = true;
    }
    this.violations.push(...violations);
    return { allowed: !blocked, violations };
  }

  /**
   * Inline check for `<script>`/`<style>` element bodies and `style=`
   * attributes. `elemKind` refines the directive (`style-src-attr` for
   * attributes, `…-elem` for elements).
   */
  checkInline(
    kind: "script" | "style",
    target: CspInlineTarget,
    variant: "elem" | "attr" = "elem",
  ): CspVerdict {
    const directive = `${kind}-src-${variant}`;
    const violations: CspViolation[] = [];
    let blocked = false;
    for (const policy of this.policies) {
      if (inlineAllowedBy(policy, directive, target)) continue;
      violations.push(
        makeViolation(policy, directive, "inline", this.documentUrl, target.text),
      );
      if (!policy.reportOnly) blocked = true;
    }
    this.violations.push(...violations);
    return { allowed: !blocked, violations };
  }

  /**
   * `frame-ancestors`: this document's OWN policies gate the ancestor
   * origins embedding it — the check runs on the EMBEDDED document. Every
   * ancestor origin must match SOME source in the list (`self` = the
   * document's own origin). No `default-src` fallback (spec: it is a
   * navigation directive).
   */
  checkAncestors(ancestorOrigins: readonly string[]): boolean {
    if (ancestorOrigins.length === 0) return true;
    for (const policy of this.policies) {
      if (policy.reportOnly) continue;
      const sources = policy.directives.get("frame-ancestors");
      if (sources === undefined) continue;
      if (sources.length === 0 || sources.includes("'none'")) return false;
      for (const origin of ancestorOrigins) {
        const ok = sources.some((s) => {
          if (s === "'self'") return origin === originOf(this.documentUrl);
          if (s === "*") return true;
          return sourceMatchesUrl(s, origin, this.documentUrl);
        });
        if (!ok) return false;
      }
    }
    return true;
  }

  /**
   * `upgrade-insecure-requests` (CSP3 §upgrade): with the directive present
   * on ANY enforce policy, `http:` subresource URLs of a secure document are
   * rewritten to `https:` before fetch — same-site AND cross-site for
   * subresources (the nav-only exemption is a documented bound).
   */
  get upgradeInsecure(): boolean {
    if (!/^https:/i.test(this.documentUrl)) return false;
    return this.policies.some((p) => p.directives.has("upgrade-insecure-requests"));
  }

  /** `block-all-mixed-content`: http subresources of a secure doc hard-block. */
  get blockMixed(): boolean {
    if (!/^https:/i.test(this.documentUrl)) return false;
    return this.policies.some((p) => p.directives.has("block-all-mixed-content"));
  }

  /** Apply `upgrade-insecure-requests` to a subresource URL. */
  upgrade(url: string): string {
    if (!this.upgradeInsecure || !/^http:\/\//i.test(url)) return url;
    return `https://${url.slice(7)}`;
  }

  /**
   * Mixed-content + upgrade gate ahead of a subresource fetch. Upgrade first
   * (it can rescue an http URL), then hard-block under
   * `block-all-mixed-content`; an http target on an https doc without
   * `block-all-mixed-content` passes through here — the network stack then
   * applies the BASELINE Mixed Content Level 2 rules (RFC 0029: blockable
   * destinations reject, optionally-blockable media upgrades).
   */
  gateSubresourceUrl(url: string): { url: string; blocked: boolean } {
    const upgraded = this.upgrade(url);
    if (this.blockMixed && /^http:\/\//i.test(upgraded)) {
      this.violations.push({
        directive: "block-all-mixed-content",
        effectiveDirective: "block-all-mixed-content",
        blockedUrl: url,
        documentUrl: this.documentUrl,
        disposition: "enforce",
      });
      return { url: upgraded, blocked: true };
    }
    return { url: upgraded, blocked: false };
  }

  /**
   * `unsafe-eval` — guest `eval()`/`new Function()` are allowed only when no
   * enforcing `script-src`/`default-src` policy omits the keyword. With no
   * policy the realm behaves as today (allowed).
   */
  get allowsEval(): boolean {
    for (const p of this.policies) {
      if (p.reportOnly) continue;
      const name = resolvedDirectiveName(p, "script-src");
      const sources = directiveSources(p, name);
      if (sources !== undefined && !sources.includes("'unsafe-eval'")) return false;
    }
    return true;
  }

  /** All report-uri endpoints across the policy list. */
  reportEndpoints(): string[] {
    const out: string[] = [];
    for (const p of this.policies) {
      for (const u of p.directives.get("report-uri") ?? []) out.push(u);
    }
    return out;
  }

  /** The report JSON body for a violation (spec's `csp-report` shape). */
  reportBody(v: CspViolation): string {
    return JSON.stringify({
      "csp-report": {
        "document-uri": v.documentUrl,
        "violated-directive": v.directive,
        "effective-directive": v.effectiveDirective,
        "blocked-uri": v.blockedUrl,
        disposition: v.disposition,
        ...(v.sample !== undefined ? { "script-sample": v.sample } : {}),
      },
    });
  }
}

/**
 * Assemble a document's policy context from its response headers + meta
 * elements. `headers` may be absent (harness/static paths) — meta policies
 * still apply.
 */
export function documentCsp(
  dom: DomTree,
  documentUrl: string,
  headers?: Readonly<Record<string, string>>,
): CspContext {
  const policies: CspPolicy[] = [
    ...(headers !== undefined ? cspFromHeaders(headers) : []),
    ...cspFromMeta(dom),
  ];
  return new CspContext(policies, documentUrl);
}
