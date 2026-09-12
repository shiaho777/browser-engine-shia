/**
 * stylesheets.ts — collect a document's stylesheets from its DOM (the real
 * `collectStylesheets(db, qDom, url)` of design.md §7.2).
 *
 * Task 3.3 shipped a deliberate Phase-1 hack: `qSheets` parsed the document's
 * OWN source bytes as one CSS sheet. That is wrong for a real HTML document,
 * whose styles live in `<style>` elements and external `<link rel=stylesheet>`s,
 * not in the markup bytes. This module replaces that hack with real collection:
 *
 *   - **`<style>` elements** — the concatenated text of the element's children
 *     is parsed as a CSS sheet (the tokenizer emits `<style>` content as a
 *     single RAWTEXT characters node, so this is just its `text`).
 *   - **`<link rel="stylesheet" href="data:…">`** — an inline `data:` URL whose
 *     explicit `text/css` payload is decoded and parsed. External `http(s)` links need
 *     the resource loader (M2's networking sub-step) and are collected via the
 *     injected `fetchSheet` hook when provided; with no hook an external link is
 *     SKIPPED (a stylesheet that fails to load is a real, graceful web
 *     condition — the document renders unstyled — NOT an unimplemented
 *     capability, so it does not throw).
 *
 * Sheets are returned in DOCUMENT ORDER (a depth-first walk from the root), so
 * the cascade's source-order tie-breaking matches the document.
 *
 * The cli is the wiring layer, so it may import the css-parser stage to build
 * the sheets; the stage-boundary rule polices stage→stage imports, not wiring.
 */
import type { DomNode, DomTree, NodeId, StyleSheet } from "@browser-engine/ir";
import { parseCss } from "@browser-engine/css-parser";
import type { MediaEnvironment } from "@browser-engine/css-parser";

import { isActiveStylesheetLink } from "./link-rel.js";

const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * The minimal user-agent (UA) default stylesheet. Non-rendered elements
 * (`head` and its metadata children) are `display:none` so their text content
 * never paints — the browser default that, without it, would render a
 * `<style>`/`<script>` element's source as visible body text. This is the UA
 * origin expressed as DATA (Platform-as-Data); author rules override it by the
 * normal cascade (it is the LOWEST-precedence sheet, prepended first).
 */
const UA_CSS =
  "html, body, div, p, h1, h2, h3, h4, h5, h6, section, article, header, footer, main, nav, " +
  "ul, ol, li, form, blockquote, pre, hr, figure, figcaption, address, " +
  "fieldset, legend { display: block }" +
  // Table elements get their real CSS display values (css-tables-3 / HTML
  // rendering): tables lay out as tables, rows as rows, cells as cells. The
  // layout tree builder (layout/src/tree-builder.ts) wraps any misplaced
  // content (bare text in tables, naked cells) into anonymous wrappers.
  " table { display: table }" +
  " tr { display: table-row }" +
  " td, th { display: table-cell }" +
  " thead, tbody, tfoot { display: table-row-group }" +
  " head, style, script, title, meta, link, base, noscript, template { display: none }" +
  " body { margin: 8px }" +
  " h1 { font-size: 2em; margin: 0.67em 0 }" +
  " h2 { font-size: 1.5em; margin: 0.75em 0 }" +
  " h3 { font-size: 1.17em; margin: 0.83em 0 }" +
  " h4 { font-size: 1em; margin: 1.12em 0 }" +
  " h5 { font-size: 0.83em; margin: 1.5em 0 }" +
  " h6 { font-size: 0.67em; margin: 1.67em 0 }" +
  " p { margin: 1em 0 }" +
  " ul, ol { margin: 1em 0; padding-left: 40px }" +
  " a { color: #0000ee }" +
  " strong, b { font-weight: 700 }" +
  " em, i { font-style: italic }" +
  " .lqip { opacity: 0 !important; pointer-events: none !important }" +
  " img { object-fit: cover }";

let uaSheetCache: StyleSheet | undefined;

/** The parsed UA default stylesheet (built once). */
export function uaStylesheet(): StyleSheet {
  uaSheetCache ??= parseCss(encode(UA_CSS));
  return uaSheetCache;
}

/**
 * The full stylesheet list the cascade sees for a document: the UA default
 * sheet FIRST (lowest precedence), then the document's own collected sheets.
 * This is the single point the live/static pipelines feed the cascade, so UA
 * defaults apply everywhere uniformly.
 */
export function documentStylesheets(
  dom: DomTree,
  loadExternal?: SheetLoader,
  media?: MediaEnvironment,
): StyleSheet[] {
  return [uaStylesheet(), ...collectStylesheets(dom, loadExternal, media)];
}

/** Optional hook to load an external stylesheet by URL (M2 networking). */
export type SheetLoader = (href: string) => Uint8Array | undefined;

/**
 * Collect the document's stylesheets in document order. `<style>` elements and
 * inline `data:` `<link>`s are always collected; an external `<link>` is loaded
 * via `loadExternal` when provided, else skipped.
 */
export function collectStylesheets(
  dom: DomTree,
  loadExternal?: SheetLoader,
  media?: MediaEnvironment,
): StyleSheet[] {
  const sheets: StyleSheet[] = [];
  const root = dom.nodes.get(dom.root);
  if (root === undefined) {
    return sheets;
  }

  const visit = (id: NodeId): void => {
    const node = dom.nodes.get(id);
    if (node === undefined) {
      return;
    }
    if (node.kind === "element" && node.tag === "style") {
      sheets.push(media !== undefined ? parseCss(encode(styleText(dom, node)), media) : parseCss(encode(styleText(dom, node))));
    } else if (isActiveStylesheetLink(node)) {
      const bytes = loadLinkedSheet(node, loadExternal);
      if (bytes !== undefined) {
        const href = node.attrs?.get("href") ?? "";
        sheets.push(...parseExternalSheetCached(href, bytes, media));
      }
    }
    for (const child of node.children) {
      visit(child);
    }
  };

  visit(dom.root);
  return sheets;
}

/** The concatenated text content of a `<style>` element's child text nodes. */
function styleText(dom: DomTree, style: DomNode): string {
  let text = "";
  for (const childId of style.children) {
    const child = dom.nodes.get(childId);
    if (child !== undefined && child.kind === "text") {
      text += child.text ?? "";
    }
  }
  return text;
}

/**
 * Resolve a `<link rel=stylesheet>`'s bytes: an inline `data:` URL is decoded
 * here; any other URL is loaded via the injected `loadExternal` hook (M2
 * networking), else skipped (returns `undefined`).
 */
function loadLinkedSheet(link: DomNode, loadExternal?: SheetLoader): Uint8Array | undefined {
  const href = link.attrs?.get("href");
  if (href === undefined) {
    return undefined;
  }
  if (isDataUrl(href)) {
    return decodeCssDataUrl(href);
  }
  return loadExternal?.(href);
}

/**
 * Parse cache for EXTERNAL sheets keyed by href + byteLength + a cheap
 * head/tail checksum. `documentStylesheets` runs on every repaint/pump of a
 * keepAlive page; re-parsing megabytes of minified CSS each render is pure
 * waste when the bytes are identical. Entries keep a stable StyleSheet
 * identity so downstream index caches can key on them. Small LRU (8 entries
 * covers a multi-sheet site plus a couple of tabs).
 */
const EXTERNAL_SHEET_CACHE = new Map<string, StyleSheet[]>();
const EXTERNAL_SHEET_CACHE_MAX = 8;

function parseExternalSheetCached(href: string, bytes: Uint8Array, media?: MediaEnvironment): StyleSheet[] {
  const head = bytes.subarray(0, 64).reduce((acc, b) => (acc * 31 + b) | 0, 0);
  const tail = bytes.subarray(Math.max(0, bytes.length - 64)).reduce((acc, b) => (acc * 33 + b) | 0, 0);
  const key = `${href}|${bytes.byteLength}|${head}|${tail}|${media?.type ?? ""}|${media?.widthPx ?? ""}x${media?.heightPx ?? ""}`;
  const hit = EXTERNAL_SHEET_CACHE.get(key);
  if (hit !== undefined) {
    // Refresh LRU position.
    EXTERNAL_SHEET_CACHE.delete(key);
    EXTERNAL_SHEET_CACHE.set(key, hit);
    return hit;
  }
  const sheets = media !== undefined ? [parseCss(bytes, media)] : [parseCss(bytes)];
  EXTERNAL_SHEET_CACHE.set(key, sheets);
  while (EXTERNAL_SHEET_CACHE.size > EXTERNAL_SHEET_CACHE_MAX) {
    const oldest = EXTERNAL_SHEET_CACHE.keys().next().value;
    if (oldest === undefined) break;
    EXTERNAL_SHEET_CACHE.delete(oldest);
  }
  return sheets;
}

/**
 * Decode a CSS `data:` URL's payload to bytes, or `undefined` when the media
 * type is not explicitly CSS-compatible. Supports
 * `data:text/css[;charset=...][;base64],<data>` (the `;base64` flag selects
 * base64 vs percent-decoded text).
 */
function decodeCssDataUrl(href: string): Uint8Array | undefined {
  const comma = href.indexOf(",");
  if (comma === -1) {
    return undefined;
  }
  const meta = href.slice(5, comma);
  if (!isCssDataMediaType(meta)) {
    return undefined;
  }
  const payload = href.slice(comma + 1);
  if (hasBase64Flag(meta)) {
    return Uint8Array.from(Buffer.from(payload, "base64"));
  }
  try {
    return encode(decodeURIComponent(payload));
  } catch {
    return undefined;
  }
}

/** URL schemes are ASCII case-insensitive. */
function isDataUrl(href: string): boolean {
  return href.slice(0, 5).toLowerCase() === "data:";
}

/** Only explicit text/css data URLs with supported metadata participate as linked CSS. */
function isCssDataMediaType(meta: string): boolean {
  const [type = ""] = meta.split(";", 1);
  if (type.trim().toLowerCase() !== "text/css") {
    return false;
  }
  return meta
    .split(";")
    .slice(1)
    .every((part) => {
      const normalized = part.trim().toLowerCase();
      return normalized === "" || normalized === "base64" || normalized === "charset=utf-8";
    });
}

/** Whether the data URL metadata carries a standalone ;base64 flag. */
function hasBase64Flag(meta: string): boolean {
  return meta
    .split(";")
    .slice(1)
    .some((part) => part.trim().toLowerCase() === "base64");
}
