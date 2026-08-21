/**
 * fine.ts — FINE-GRAINED incremental session (M4: the performance flagship).
 *
 * ## The thesis, made measurable
 *
 * MANIFESTO: "performance comes from MECHANISM, not micro-optimization — the
 * incremental kernel makes 'recompute only what changed' the default." M3's
 * `LiveSession` proved the live loop but held the DOM as ONE input, so any
 * mutation re-verified every node's cascade (the early-stop pruned value-equal
 * dependents, but each cascade still ran). That is O(N) style recalc per edit.
 *
 * This session makes style recalc **O(affected), not O(document)** by changing
 * the DEPENDENCY GRANULARITY — without touching the cascade:
 *
 *   - the DOM is decomposed into PER-NODE kernel inputs ({@link NodeInput}),
 *     one slot per node id;
 *   - the cascade reads the DOM through a LAZY FACADE whose `nodes.get(id)`
 *     calls `db.getInput(NodeInput, …)`. Because the kernel records a dependency
 *     for every input read during a query, `qFineComputed(node)` ends up
 *     depending on EXACTLY the nodes the cascade touched — the node itself plus
 *     its ancestors (for inheritance + descendant/child combinators) — never the
 *     whole tree.
 *
 * So mutating node X's attribute bumps only `NodeInput[X]`; every node whose
 * cascade did not read X stays cache-clean and is NOT recomputed. On a flat list
 * of N items, editing one item recomputes O(1) cascades instead of O(N) — the
 * `recomputeDelta()` diagnostic proves it on hard data (`fine.bench.test`).
 *
 * Layout still walks the whole tree (it produces the whole FragmentTree), so a
 * single edit re-lays-out the document; per-SUBTREE layout incrementality is the
 * next step (M4.2) and slots in behind this same session API. The STYLE-recalc
 * win is real and measured today.
 *
 * The cascade and `collectStylesheets` are reused UNCHANGED: this is pure
 * dependency-graph plumbing, exactly the "mechanism, not micro-optimization"
 * the manifesto promises.
 */
import {
  type DisplayList,
  type DomNode,
  type DomTree,
  type NodeId,
  nodeId,
} from "@browser-engine/ir";
import {
  IncrementalDb,
  define,
  defineInput,
  type InputSlot,
  type QueryTraceObserver,
  type QueryDef,
} from "@browser-engine/kernel";
import { parseHtml } from "@browser-engine/html-parser";
import { cascade, cascadeWithRuleIndex, buildRuleIndex } from "@browser-engine/cascade";
import { layout } from "@browser-engine/layout";
import { paint } from "@browser-engine/paint";

import { documentStylesheets, type SheetLoader } from "./stylesheets.js";
import { collectImages } from "./images.js";
import { isActiveStylesheetLink } from "./link-rel.js";
import { cacheLoader, documentBaseUrl, resolveUrl } from "./loader.js";
import type { NodeRef, Url } from "./pipeline.js";

import { pipelineShaper } from "./fonts.js";

/**
 * Per-node STRUCTURE input (kind/tag/text/children/parent) — what LAYOUT reads
 * to walk the tree and size text. Keyed `${url}\u0000${nodeId}`.
 */
export const NodeStruct: InputSlot<string, DomNode> = defineInput<string, DomNode>("FineNodeStruct");
/**
 * Per-node ATTRIBUTES input — what the CASCADE reads for selector matching.
 * Split from structure so a class/style edit (attrs) does NOT invalidate LAYOUT
 * (which never reads attrs): the basis of paint-only invalidation at node level.
 */
export const NodeAttrs: InputSlot<string, ReadonlyMap<string, string>> =
  defineInput<string, ReadonlyMap<string, string>>("FineNodeAttrs");
/** The document root node id (a tiny per-document input the facade reads). */
export const DocRoot: InputSlot<Url, NodeId> = defineInput<Url, NodeId>("FineDocRoot");
/**
 * External stylesheet bytes loaded by the wiring layer before the pure query
 * graph runs. Keys are the raw `href` values from the DOM; callers that need
 * URL/base resolution do it before seeding this input.
 */
export const FineExternalSheets: InputSlot<Url, ReadonlyMap<string, Uint8Array>> =
  defineInput<Url, ReadonlyMap<string, Uint8Array>>("FineExternalSheets");

const EMPTY_ATTRS: ReadonlyMap<string, string> = new Map();
const EMPTY_EXTERNAL_SHEETS: ReadonlyMap<string, Uint8Array> = new Map();

/** The memo key for a node's input slots. */
function nodeKey(url: Url, node: NodeId): string {
  return `${url}\u0000${String(node)}`;
}

/** The structure-only part of a DOM node (everything the cascade matches on — `attrs` — excluded). */
function structOf(node: DomNode): DomNode {
  const out: DomNode = {
    id: node.id,
    kind: node.kind,
    children: node.children,
    parent: node.parent,
  };
  return node.tag !== undefined
    ? node.text !== undefined
      ? { ...out, tag: node.tag, text: node.text }
      : { ...out, tag: node.tag }
    : node.text !== undefined
      ? { ...out, text: node.text }
      : out;
}

/**
 * Build a lazy {@link DomTree} facade over the per-node inputs. The `structOnly`
 * flavour reads ONLY `NodeStruct` (so the consumer — layout — depends only on
 * structure); the full flavour also merges `NodeAttrs` (so the consumer —
 * cascade / stylesheet / image collection — depends on attrs too). Every node a
 * consumer touches is recorded as a per-node dependency of the running query.
 */
function domFacade(
  db: { getInput: <K, V>(slot: InputSlot<K, V>, key: K) => V },
  url: Url,
  structOnly: boolean,
): DomTree {
  const root = db.getInput(DocRoot, url);
  const read = (id: NodeId): DomNode | undefined => {
    try {
      const struct = db.getInput(NodeStruct, nodeKey(url, id));
      if (structOnly) {
        return struct;
      }
      const attrs = db.getInput(NodeAttrs, nodeKey(url, id));
      return attrs === EMPTY_ATTRS ? struct : { ...struct, attrs };
    } catch {
      return undefined; // a node id not present in the document.
    }
  };
  const nodes = { get: read } as unknown as ReadonlyMap<NodeId, DomNode>;
  return { root, nodes } as unknown as DomTree;
}

/** `qFineSheets` — collect stylesheets from the live (full) DOM facade. */
export const qFineSheets = define((db, url: Url) => {
  const externalSheets = db.getInput(FineExternalSheets, url);
  const dom = domFacade(db, url, false);
  return documentStylesheets(dom, cacheLoader(externalSheets, documentBaseUrl(dom, url)));
}, "qFineSheets");

/**
 * `qFineComputed` — the cascade for one node, reading the DOM through the full
 * per-node facade so its dependency footprint is the node + its ancestors only.
 */
export const qFineRuleIndex: QueryDef<
  Url,
  { readonly index: ReturnType<typeof buildRuleIndex>; readonly layerOrder: readonly (readonly string[])[] | undefined }
> = define((db, url: Url) => {
  const sheets = db.query(qFineSheets, url);
  const origins: readonly ("ua" | "author")[] = sheets.map((_, i) => (i === 0 ? "ua" : "author"));
  const layerOrder: (readonly string[])[] = [];
  for (const sheet of sheets) {
    if (sheet.layerOrder) {
      for (const layer of sheet.layerOrder) {
        if (!layerOrder.some((l) => l.join(".") === layer.join("."))) {
          layerOrder.push(layer);
        }
      }
    }
  }
  return Object.freeze({
    index: buildRuleIndex(sheets, origins, layerOrder.length > 0 ? layerOrder : undefined),
    layerOrder: layerOrder.length > 0 ? layerOrder : undefined,
  });
}, "qFineRuleIndex");

export const qFineComputed: QueryDef<NodeRef, ReturnType<typeof cascade>> = define((db, ref: NodeRef) => {
  const dom = domFacade(db, ref.url, false);
  const { index, layerOrder } = db.query(qFineRuleIndex, ref.url);
  const cache = new Map<NodeId, ReturnType<typeof cascade>>();
  return cascadeWithRuleIndex(dom, index, ref.node, undefined, layerOrder, cache);
}, "qFineComputed");

/**
 * The ComputedStyle fields the LAYOUT engine actually reads (everything else —
 * `color`, `background*`, `border*Color`, `opacity`, `transform`, `zIndex`,
 * `visibility`, `overflow`, `cursor`, … — is PAINT-ONLY). Kept in sync with the
 * fields `@browser-engine/layout` consults; the differential test
 * (`fine renders identically to the static pipeline`) is the safety net that
 * fails loudly if a layout-relevant field is ever omitted here.
 */
const LAYOUT_FIELDS: ReadonlySet<string> = new Set([
  "display", "fontSize",
  "width", "height", "minWidth", "maxWidth", "minHeight", "maxHeight",
  "margin", "marginTop", "marginRight", "marginBottom", "marginLeft",
  "padding", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "borderWidth", "borderStyle",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  "borderTopStyle", "borderRightStyle", "borderBottomStyle", "borderLeftStyle",
  "boxSizing", "position", "top", "right", "bottom", "left", "float", "clear",
  "flexDirection", "flexGrow", "flexShrink", "flexBasis", "flexWrap",
  "justifyContent", "alignItems", "alignSelf", "alignContent", "order",
  "gap", "columnGap", "rowGap",
  "gridTemplateColumns", "gridTemplateRows",
  "lineHeight", "textAlign", "whiteSpace", "letterSpacing", "wordSpacing",
  "textIndent", "wordBreak", "overflowWrap",
]);

/** Project a full ComputedStyle to ONLY its layout-relevant fields (frozen). */
function projectLayoutStyle(full: ReturnType<typeof cascade>): ReturnType<typeof cascade> {
  const out: Record<string, unknown> = {};
  const src = full as Record<string, unknown>;
  for (const key of Object.keys(src)) {
    if (LAYOUT_FIELDS.has(key)) {
      out[key] = src[key];
    }
  }
  return Object.freeze(out) as unknown as ReturnType<typeof cascade>;
}

/**
 * `qFineLayoutStyle` — the LAYOUT-RELEVANT projection of a node's computed
 * style. This is the key to PAINT-ONLY INVALIDATION: when a mutation changes a
 * node's paint-only properties (e.g. `color`, hover/animation effects), this
 * projection re-computes to a DEEP-EQUAL value, so the kernel's early-stop keeps
 * `qFineLayout` cache-clean — the document re-PAINTS without re-LAYING-OUT, the
 * optimization real engines call "paint-only invalidation".
 */
export const qFineLayoutStyle: QueryDef<NodeRef, ReturnType<typeof cascade>> = define((db, ref: NodeRef) => {
  return projectLayoutStyle(db.query(qFineComputed, ref));
}, "qFineLayoutStyle");

/** `qFineLayout` — lay the document out, reading the layout-style projection.
 * Uses the STRUCT-ONLY facade, so it depends on node structure (+ layout style)
 * but NOT on attrs — a class/style edit that is paint-only never invalidates it. */
export const qFineLayout = define((db, url: Url) => {
  const dom = domFacade(db, url, true);
  return layout(dom, (node) => db.query(qFineLayoutStyle, { url, node }), { shaper: pipelineShaper });
}, "qFineLayout");

/** `qFinePaint` — the DisplayList for the live document. */
export const qFinePaint: QueryDef<Url, DisplayList> = define((db, url: Url) => {
  const dom = domFacade(db, url, false);
  const fragments = db.query(qFineLayout, url);
  const images = collectImages(dom);
  return paint(
    fragments,
    (node) => db.query(qFineComputed, { url, node }),
    (node) => images.get(node),
  );
}, "qFinePaint");

const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Options for {@link FineSession}. */
export interface FineSessionOptions {
  /** Read-only query observer for trace/profiling evidence. */
  readonly onQuery?: QueryTraceObserver;
  /**
   * Optional sync stylesheet resource loader supplied by the wiring layer.
   * Called during session construction, never from inside a query.
   */
  readonly loadExternalSheet?: SheetLoader;
}

/**
 * A fine-grained incremental document session. Same API surface as
 * {@link import("./live.js").LiveSession}, but the DOM is decomposed into
 * per-node inputs so a mutation recomputes only the cascades that actually read
 * the edited node.
 */
export class FineSession {
  readonly #db: IncrementalDb;
  readonly #url: Url;
  #loadExternalSheet: SheetLoader | undefined;
  #dom: DomTree;
  #nodes: Map<NodeId, DomNode>;
  #root: NodeId;
  #pendingStructSeeds: Set<NodeId> = new Set();
  #pendingAttrSeeds: Set<NodeId> = new Set();
  /** Next free node id for created nodes (one past the current maximum). */
  #nextId: number;

  constructor(html: string, url: Url = "fine://doc", options: FineSessionOptions = {}) {
    this.#db = new IncrementalDb(options.onQuery === undefined ? {} : { onQuery: options.onQuery });
    this.#url = url;
    this.#loadExternalSheet = options.loadExternalSheet;
    const parsed = parseHtml(encode(html));
    this.#root = parsed.root;
    this.#nodes = new Map(parsed.nodes);
    this.#dom = { root: this.#root, nodes: this.#nodes } as unknown as DomTree;
    let max = 0;
    for (const id of this.#nodes.keys()) max = Math.max(max, Number(id));
    this.#nextId = max + 1;
    this.#seed(this.#dom);
  }

  /** Seed the document root + every node's structure/attrs + external sheets. */
  #seed(dom: DomTree): void {
    this.#db.setInput(DocRoot, this.#url, dom.root);
    this.#syncExternalSheets();
    for (const [id, node] of dom.nodes) {
      this.#db.setInput(NodeStruct, nodeKey(this.#url, id), structOf(node));
      this.#db.setInput(NodeAttrs, nodeKey(this.#url, id), node.attrs ?? EMPTY_ATTRS);
    }
  }

  /** The current DOM tree. */
  get dom(): DomTree {
    return this.#dom;
  }

  /** The immutable document URL that keys this session. */
  get url(): Url {
    return this.#url;
  }

  /** The current effective base URL exposed to resource loading and guest DOM APIs. */
  get baseUrl(): string {
    return this.#documentBaseUrl();
  }

  /** Diagnostic: total compute-fn executions so far. */
  get recomputeCount(): number {
    return this.#db.recomputeCount;
  }

  /** Render the current document to a DisplayList (incrementally). */
  render(): DisplayList {
    this.#flushSeeds();
    return this.#db.query(qFinePaint, this.#url);
  }

  /**
   * The current FragmentTree (layout product). Exposed so callers can observe
   * layout caching: across a PAINT-ONLY mutation the kernel returns the SAME
   * frozen FragmentTree reference (layout did not recompute — paint-only
   * invalidation); a layout-affecting mutation returns a fresh one.
   */
  layoutTree(): ReturnType<typeof layout> {
    this.#flushSeeds();
    return this.#db.query(qFineLayout, this.#url);
  }

  /** The current ComputedStyle of a node (via the kernel). */
  computed(node: NodeId): ReturnType<typeof cascade> {
    this.#flushSeeds();
    return this.#db.query(qFineComputed, { url: this.#url, node });
  }

  setExternalSheetLoader(loader: SheetLoader | undefined): void {
    this.#loadExternalSheet = loader;
    this.#syncExternalSheets();
  }

  setText(node: NodeId, text: string): void {
    const existing = this.#nodes.get(node);
    if (existing === undefined) return;
    const updated: DomNode = { ...existing, text };
    this.#nodes.set(node, updated);
    this.#seedStruct(node);
  }

  setAttribute(node: NodeId, name: string, value: string): void {
    const previousBaseUrl = this.#documentBaseUrl();
    const existing = this.#nodes.get(node);
    if (existing === undefined || existing.kind !== "element") return;
    const attrs = new Map(existing.attrs ?? []);
    attrs.set(name, value);
    const updated: DomNode = { ...existing, attrs };
    this.#nodes.set(node, updated);
    this.#seedAttrs(node);
    this.#syncExternalSheetsIfAttributeMutation(updated, name, previousBaseUrl);
  }

  removeAttribute(node: NodeId, name: string): void {
    const previousBaseUrl = this.#documentBaseUrl();
    const existing = this.#nodes.get(node);
    if (existing === undefined || existing.kind !== "element") return;
    const attrs = new Map(existing.attrs ?? []);
    attrs.delete(name);
    const updated: DomNode = { ...existing, attrs };
    this.#nodes.set(node, updated);
    this.#seedAttrs(node);
    this.#syncExternalSheetsIfAttributeMutation(updated, name, previousBaseUrl);
  }

  #seedNode(node: NodeId): void {
    this.#pendingStructSeeds.add(node);
    this.#pendingAttrSeeds.add(node);
  }

  #seedStruct(node: NodeId): void {
    this.#pendingStructSeeds.add(node);
  }

  #seedAttrs(node: NodeId): void {
    this.#pendingAttrSeeds.add(node);
  }

  #flushSeeds(): void {
    if (this.#pendingStructSeeds.size === 0 && this.#pendingAttrSeeds.size === 0) return;
    for (const node of this.#pendingStructSeeds) {
      const updated = this.#nodes.get(node);
      if (updated === undefined) continue;
      this.#db.setInput(NodeStruct, nodeKey(this.#url, node), structOf(updated));
    }
    for (const node of this.#pendingAttrSeeds) {
      const updated = this.#nodes.get(node);
      if (updated === undefined) continue;
      this.#db.setInput(NodeAttrs, nodeKey(this.#url, node), updated.attrs ?? EMPTY_ATTRS);
    }
    this.#pendingStructSeeds.clear();
    this.#pendingAttrSeeds.clear();
  }

  #detachChild(child: NodeId): void {
    const c = this.#nodes.get(child);
    if (c === undefined || c.parent === null) return;
    const old = this.#nodes.get(c.parent);
    if (old === undefined) return;
    this.#nodes.set(old.id, {
      ...old,
      children: old.children.filter((id) => id !== child),
    });
  }

  createElement(tag: string): NodeId {
    const id = nodeId(this.#nextId);
    this.#nextId += 1;
    const node: DomNode = {
      id,
      kind: "element",
      tag: tag.toLowerCase(),
      attrs: new Map(),
      children: [],
      parent: null,
    };
    this.#nodes.set(id, node);
    this.#seedNode(id);
    return id;
  }

  createTextNode(text: string): NodeId {
    const id = nodeId(this.#nextId);
    this.#nextId += 1;
    const node: DomNode = { id, kind: "text", text, children: [], parent: null };
    this.#nodes.set(id, node);
    this.#seedNode(id);
    return id;
  }

  createComment(text: string): NodeId {
    const id = nodeId(this.#nextId);
    this.#nextId += 1;
    const node: DomNode = { id, kind: "comment", text, children: [], parent: null };
    this.#nodes.set(id, node);
    this.#seedNode(id);
    return id;
  }

  appendChild(parent: NodeId, child: NodeId): void {
    const previousBaseUrl = this.#documentBaseUrl();
    const p = this.#nodes.get(parent);
    const c = this.#nodes.get(child);
    if (p === undefined || c === undefined || parent === child) return;
    const oldParent = c.parent;
    this.#detachChild(child);
    const freshParent = this.#nodes.get(parent);
    if (freshParent === undefined) return;
    this.#nodes.set(parent, {
      ...freshParent,
      children: [...freshParent.children.filter((id) => id !== child), child],
    });
    this.#nodes.set(child, { ...c, parent });
    this.#seedStruct(parent);
    this.#seedStruct(child);
    if (oldParent !== null && oldParent !== parent) this.#seedStruct(oldParent);
    this.#syncExternalSheetsIfSubtreeMutationCanAffectResources(child, previousBaseUrl);
  }

  insertBefore(parent: NodeId, child: NodeId, ref: NodeId | null): void {
    const previousBaseUrl = this.#documentBaseUrl();
    const p = this.#nodes.get(parent);
    const c = this.#nodes.get(child);
    if (p === undefined || c === undefined || parent === child) return;
    const oldParent = c.parent;
    this.#detachChild(child);
    const freshParent = this.#nodes.get(parent);
    if (freshParent === undefined) return;
    const kids = freshParent.children.filter((id) => id !== child);
    const at = ref === null ? kids.length : kids.indexOf(ref);
    const idx = at < 0 ? kids.length : at;
    this.#nodes.set(parent, {
      ...freshParent,
      children: [...kids.slice(0, idx), child, ...kids.slice(idx)],
    });
    this.#nodes.set(child, { ...c, parent });
    this.#seedStruct(parent);
    this.#seedStruct(child);
    if (oldParent !== null && oldParent !== parent) this.#seedStruct(oldParent);
    this.#syncExternalSheetsIfSubtreeMutationCanAffectResources(child, previousBaseUrl);
  }

  removeChild(parent: NodeId, child: NodeId): void {
    const previousBaseUrl = this.#documentBaseUrl();
    const p = this.#nodes.get(parent);
    const c = this.#nodes.get(child);
    if (p === undefined || c === undefined) return;
    this.#nodes.set(parent, {
      ...p,
      children: p.children.filter((id) => id !== child),
    });
    this.#nodes.set(child, { ...c, parent: null });
    this.#seedStruct(parent);
    this.#seedStruct(child);
    this.#syncExternalSheetsIfSubtreeMutationCanAffectResources(child, previousBaseUrl);
  }

  /** Recompute the external stylesheet input from the current DOM. */
  #syncExternalSheets(): void {
    this.#db.setInput(FineExternalSheets, this.#url, loadExternalStylesheets(this.#dom, this.#url, this.#loadExternalSheet));
  }

  /** The document's current effective base URL for resolving external resources. */
  #documentBaseUrl(): string {
    return documentBaseUrl(this.#dom, this.#url);
  }

  /** Rescan stylesheet resources only for mutations that can change external sheet URLs. */
  #syncExternalSheetsIfAttributeMutation(node: DomNode | undefined, name: string, previousBaseUrl: string): void {
    if (
      this.#documentBaseUrl() !== previousBaseUrl ||
      node?.kind === "element" &&
      node.tag === "link" &&
      (name === "href" || name === "rel" || name === "disabled" || name === "media")
    ) {
      this.#syncExternalSheets();
    }
  }

  /** Rescan when moving/removing a stylesheet link or changing the document base URL. */
  #syncExternalSheetsIfSubtreeMutationCanAffectResources(node: NodeId, previousBaseUrl: string): void {
    if (this.#documentBaseUrl() !== previousBaseUrl || subtreeHasStylesheetLink(this.#dom, node)) {
      this.#syncExternalSheets();
    }
  }
}

/** Load the external stylesheets currently referenced by the parsed document. */
function loadExternalStylesheets(
  dom: DomTree,
  documentUrl: string,
  loadExternal?: SheetLoader,
): ReadonlyMap<string, Uint8Array> {
  if (loadExternal === undefined) {
    return EMPTY_EXTERNAL_SHEETS;
  }
  const baseUrl = documentBaseUrl(dom, documentUrl);
  const sheets = new Map<string, Uint8Array>();
  const visit = (id: NodeId): void => {
    const node = dom.nodes.get(id);
    if (node === undefined) {
      return;
    }
    if (!isActiveStylesheetLink(node)) {
      for (const child of node.children) {
        visit(child);
      }
      return;
    }
    const href = node.attrs?.get("href");
    if (href !== undefined && href.length > 0 && !isDataUrl(href)) {
      const abs = resolveUrl(href, baseUrl);
      if (abs !== null) {
        const bytes = loadExternal(abs);
        if (bytes !== undefined) {
          sheets.set(abs, bytes);
        }
      }
    }
    for (const child of node.children) {
      visit(child);
    }
  };
  visit(dom.root);
  return sheets.size === 0 ? EMPTY_EXTERNAL_SHEETS : sheets;
}

/** Whether a subtree contains at least one stylesheet link element. */
function subtreeHasStylesheetLink(dom: DomTree, id: NodeId): boolean {
  const node = dom.nodes.get(id);
  if (node === undefined) return false;
  if (node.kind === "element" && node.tag === "link") return true;
  if (node.children.length === 0) return false;
  for (const child of node.children) {
    if (subtreeHasStylesheetLink(dom, child)) return true;
  }
  return false;
}

/** URL schemes are ASCII case-insensitive. */
function isDataUrl(href: string): boolean {
  return href.slice(0, 5).toLowerCase() === "data:";
}
