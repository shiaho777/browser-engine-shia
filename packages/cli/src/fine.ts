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
import { cascade, cascadeWithRuleIndex, buildRuleIndex, type InteractionState } from "@browser-engine/cascade";
import { layout, type ShadowComposition } from "@browser-engine/layout";
import type { TextShaper } from "@browser-engine/layout";
import { paint } from "@browser-engine/paint";

import { documentStylesheets, type SheetLoader } from "./stylesheets.js";
import { collectImages } from "./images.js";
import { isActiveStylesheetLink } from "./link-rel.js";
import { cacheLoader, documentBaseUrl, resolveUrl } from "./loader.js";
import type { NodeRef, Url } from "./pipeline.js";

import { resolvePipelineShaper } from "./fonts.js";

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

/**
 * The per-document INTERACTION STATE input (D4): which nodes are hovered /
 * active / focused. The cascade queries read it so `:hover`/`:active`/
 * `:focus` match live UI state; changing it (via `setInteractionState`)
 * invalidates exactly the queries that read it — a re-cascade, not a rebuild.
 */
export const FineInteractionState: InputSlot<Url, InteractionState> =
  defineInput<Url, InteractionState>("FineInteractionState");

/** The empty interaction state: no node hovered/active/focused. */
export const NO_INTERACTION: InteractionState = Object.freeze({
  hovered: new Set<NodeId>(),
  active: new Set<NodeId>(),
  focused: new Set<NodeId>(),
});

/**
 * The per-document SHADOW COMPOSITION input (D6): the flat-tree view (shadow
 * hosts → shadow children, slots → assigned light children). The layout
 * queries read it through `buildLayoutTree`'s composition parameter; changing
 * it (attachShadow / slot changes) re-runs exactly the layout queries that
 * read the affected nodes' children.
 */
export const FineComposition: InputSlot<Url, ShadowComposition | null> =
  defineInput<Url, ShadowComposition | null>("FineComposition");

const EMPTY_ATTRS: ReadonlyMap<string, string> = new Map();
const EMPTY_DIRTY: ReadonlySet<NodeId> = new Set();
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
  const interaction = db.getInput(FineInteractionState, ref.url);
  const cache = new Map<NodeId, ReturnType<typeof cascade>>();
  return cascadeWithRuleIndex(dom, index, ref.node, undefined, layerOrder, cache, interaction);
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
  // B-group additions the layout engine reads.
  "verticalAlign",
  "borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor",
  "borderColor",
  // E2: the rendered-text view (text-transform drives shaping).
  "textTransform",
  "fontWeight",
  "fontStyle",
  "overflowX", "overflowY",
  "contain",
  "contentVisibility",
  "containIntrinsicSize",
  "gridAutoFlow", "gridAutoColumns", "gridAutoRows",
  "gridColumn", "gridRow", "gridArea",
  "insetBlockStart", "insetBlockEnd", "insetInlineStart", "insetInlineEnd",
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
  const composition = db.getInput(FineComposition, url);
  const layoutOptions: { shaper: TextShaper; composition?: ShadowComposition } = { shaper: resolvePipelineShaper() };
  if (composition !== null) layoutOptions.composition = composition;
  return layout(dom, (node) => db.query(qFineLayoutStyle, { url, node }), layoutOptions);
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
/**
 * A raw DOM mutation at the NodeId level, reported by FineSession after each
 * mutating method. This is the seam the guest MutationObserver wires into
 * (see mutation-observer.ts): the session stays engine-pure, observers are a
 * guest concept layered on top.
 */
export interface FineMutation {
  readonly kind: "attributes" | "characterData" | "childList";
  readonly target: NodeId;
  /** For "attributes": the mutated attribute's (lowercased) name. */
  readonly attributeName?: string;
  /** The value BEFORE the mutation (old attribute/text content). */
  readonly oldValue?: string | null;
  /** For "childList": nodes inserted / removed at `target`. */
  readonly added?: readonly NodeId[];
  readonly removed?: readonly NodeId[];
  /** Siblings of the mutated child at record time (null when absent). */
  readonly previousSibling?: NodeId | null;
  readonly nextSibling?: NodeId | null;
}

export class FineSession {
  readonly #db: IncrementalDb;
  readonly #url: Url;
  #loadExternalSheet: SheetLoader | undefined;
  #dom: DomTree;
  #nodes: Map<NodeId, DomNode>;
  #root: NodeId;
  #pendingStructSeeds: Set<NodeId> = new Set();
  #pendingAttrSeeds: Set<NodeId> = new Set();
  /**
   * Every node whose structure or attributes changed since the host last
   * drained this set. The kernel's own invalidation is query-level; this is
   * the NODE-level record a renderer needs to invalidate exactly the cascade
   * results a mutation could have changed (see `takeDirtyNodes`).
   */
  #dirtySinceDrain: Set<NodeId> = new Set();
  /** Next free node id for created nodes (one past the current maximum). */
  #nextId: number;
  /**
   * MutationObserver seam: when set, every DOM mutation reports here AFTER the
   * tree update (the record semantics are pre-mutation for oldValue/siblings).
   * Null = zero-cost path (no observer anywhere).
   */
  #mutationListener: ((mutation: FineMutation) => void) | null = null;

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
    this.#db.setInput(FineInteractionState, this.#url, NO_INTERACTION);
    this.#db.setInput(FineComposition, this.#url, null);
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
    const oldValue = existing.text ?? "";
    const updated: DomNode = { ...existing, text };
    this.#nodes.set(node, updated);
    this.#seedStruct(node);
    this.#mutationListener?.({ kind: "characterData", target: node, oldValue });
  }

  setAttribute(node: NodeId, name: string, value: string): void {
    const previousBaseUrl = this.#documentBaseUrl();
    const existing = this.#nodes.get(node);
    if (existing === undefined || existing.kind !== "element") return;
    const oldValue = existing.attrs?.get(name) ?? null;
    const attrs = new Map(existing.attrs ?? []);
    attrs.set(name, value);
    const updated: DomNode = { ...existing, attrs };
    this.#nodes.set(node, updated);
    this.#seedAttrs(node);
    this.#syncExternalSheetsIfAttributeMutation(updated, name, previousBaseUrl);
    this.#mutationListener?.({ kind: "attributes", target: node, attributeName: name, oldValue });
  }

  removeAttribute(node: NodeId, name: string): void {
    const previousBaseUrl = this.#documentBaseUrl();
    const existing = this.#nodes.get(node);
    if (existing === undefined || existing.kind !== "element") return;
    const oldValue = existing.attrs?.get(name) ?? null;
    const attrs = new Map(existing.attrs ?? []);
    const had = attrs.delete(name);
    const updated: DomNode = { ...existing, attrs };
    this.#nodes.set(node, updated);
    this.#seedAttrs(node);
    this.#syncExternalSheetsIfAttributeMutation(updated, name, previousBaseUrl);
    // Spec: removing an absent attribute queues no record.
    if (had) {
      this.#mutationListener?.({ kind: "attributes", target: node, attributeName: name, oldValue });
    }
  }

  /** Register the mutation listener (MutationObserver seam; null disables). */
  setMutationListener(listener: ((mutation: FineMutation) => void) | null): void {
    this.#mutationListener = listener;
  }

  /**
   * D4 — set the document's INTERACTION STATE (`:hover` / `:active` /
   * `:focus`). Setting a NEW state object re-seeds the kernel input, which
   * invalidates exactly the cascade queries that read the state (the rule
   * index does NOT rebuild — the DOM and sheets are unchanged).
   */
  setInteractionState(state: InteractionState): void {
    this.#db.setInput(FineInteractionState, this.#url, state);
  }

  /**
   * D6 — set the SHADOW COMPOSITION (the flat-tree view). Passing `null`
   * clears it (pure light DOM). Re-seeding invalidates the layout queries
   * that read the affected nodes' children.
   */
  setComposition(composition: ShadowComposition | null): void {
    this.#db.setInput(FineComposition, this.#url, composition);
  }

  /**
   * D6 — a composition controller for the document API: `attachShadow` /
   * slot assignment mutate the flat-tree view through it, re-seeding the
   * kernel input on every change (host registration and slot assignment both
   * re-run the affected layout queries only).
   */
  createCompositionController(): {
    registerHost(hostId: NodeId, shadowRootId: NodeId): void;
    assignSlot(slotId: NodeId, assigned: readonly NodeId[]): void;
    read(): ShadowComposition | null;
  } {
    // Live mutable maps → frozen views re-seeded into the kernel input.
    const hosts = new Map<NodeId, readonly NodeId[]>();
    const slots = new Map<NodeId, readonly NodeId[]>();
    const commit = (): void => {
      if (hosts.size === 0 && slots.size === 0) {
        this.#db.setInput(FineComposition, this.#url, null);
        return;
      }
      this.#db.setInput(FineComposition, this.#url, {
        hosts: new Map(hosts),
        slots: new Map(slots),
      });
    };
    return {
      registerHost: (hostId, shadowRootId) => {
        // The host renders the shadow ROOT's children (not the root itself).
        const sync = (): void => {
          const kids = this.#nodes.get(shadowRootId)?.children ?? [];
          hosts.set(hostId, [...kids]);
          commit(); // re-seed the kernel input so layout sees the flat tree.
        };
        sync();
        // Keep the composition fresh when the shadow tree mutates: piggyback
        // on the mutation listener seam (the same one MutationObserver uses).
        // A full slot-assignment engine is the follow-up; host children
        // syncing covers the dominant custom-element render pattern.
        const previous = this.#mutationListener;
        this.#mutationListener = (m) => {
          if (m.target === shadowRootId || m.target === hostId) sync();
          previous?.(m);
        };
      },
      assignSlot: (slotId, assigned) => {
        slots.set(slotId, [...assigned]);
        commit();
      },
      read: () => {
        if (hosts.size === 0 && slots.size === 0) return null;
        return { hosts: new Map(hosts), slots: new Map(slots) };
      },
    };
  }

  #seedNode(node: NodeId): void {
    this.#pendingStructSeeds.add(node);
    this.#pendingAttrSeeds.add(node);
    this.#dirtySinceDrain.add(node);
  }

  #seedStruct(node: NodeId): void {
    this.#pendingStructSeeds.add(node);
    this.#dirtySinceDrain.add(node);
  }

  #seedAttrs(node: NodeId): void {
    this.#pendingAttrSeeds.add(node);
    this.#dirtySinceDrain.add(node);
  }

  /**
   * Drain the set of nodes mutated since the last call. A renderer uses it to
   * evict exactly the cascade entries a mutation could have invalidated
   * (the node, its subtree via inheritance, and its following siblings via
   * sibling combinators) instead of re-cascading the whole document.
   */
  takeDirtyNodes(): ReadonlySet<NodeId> {
    if (this.#dirtySinceDrain.size === 0) return EMPTY_DIRTY;
    const drained = this.#dirtySinceDrain;
    this.#dirtySinceDrain = new Set();
    return drained;
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

  /** Siblings of `child` within `parent`'s current child list (null when absent). */
  #siblingsOf(parent: DomNode, child: NodeId): { prev: NodeId | null; next: NodeId | null } {
    const idx = parent.children.indexOf(child);
    if (idx < 0) return { prev: null, next: null };
    return {
      prev: idx > 0 ? (parent.children[idx - 1] ?? null) : null,
      next: idx + 1 < parent.children.length ? (parent.children[idx + 1] ?? null) : null,
    };
  }

  /** Emit the childList record for detaching `child` from its old parent, if any. */
  #emitDetach(child: NodeId, oldParent: NodeId | null): void {
    if (this.#mutationListener === null || oldParent === null) return;
    const parentNode = this.#nodes.get(oldParent);
    if (parentNode === undefined) return;
    const { prev, next } = this.#siblingsOf(parentNode, child);
    this.#mutationListener({
      kind: "childList",
      target: oldParent,
      removed: [child],
      previousSibling: prev,
      nextSibling: next,
    });
  }

  appendChild(parent: NodeId, child: NodeId): void {
    const previousBaseUrl = this.#documentBaseUrl();
    const p = this.#nodes.get(parent);
    const c = this.#nodes.get(child);
    if (p === undefined || c === undefined || parent === child) return;
    const oldParent = c.parent;
    this.#emitDetach(child, oldParent);
    this.#detachChild(child);
    const freshParent = this.#nodes.get(parent);
    if (freshParent === undefined) return;
    const previousSibling = freshParent.children.length > 0
      ? (freshParent.children[freshParent.children.length - 1] ?? null)
      : null;
    this.#nodes.set(parent, {
      ...freshParent,
      children: [...freshParent.children.filter((id) => id !== child), child],
    });
    this.#nodes.set(child, { ...c, parent });
    this.#seedStruct(parent);
    this.#seedStruct(child);
    if (oldParent !== null && oldParent !== parent) this.#seedStruct(oldParent);
    this.#syncExternalSheetsIfSubtreeMutationCanAffectResources(child, previousBaseUrl);
    this.#mutationListener?.({
      kind: "childList",
      target: parent,
      added: [child],
      previousSibling,
      nextSibling: null,
    });
  }

  insertBefore(parent: NodeId, child: NodeId, ref: NodeId | null): void {
    const previousBaseUrl = this.#documentBaseUrl();
    const p = this.#nodes.get(parent);
    const c = this.#nodes.get(child);
    if (p === undefined || c === undefined || parent === child) return;
    const oldParent = c.parent;
    this.#emitDetach(child, oldParent);
    this.#detachChild(child);
    const freshParent = this.#nodes.get(parent);
    if (freshParent === undefined) return;
    const kids = freshParent.children.filter((id) => id !== child);
    const at = ref === null ? kids.length : kids.indexOf(ref);
    const idx = at < 0 ? kids.length : at;
    const previousSibling = idx > 0 ? (kids[idx - 1] ?? null) : null;
    const nextSibling = idx < kids.length ? (kids[idx] ?? null) : null;
    this.#nodes.set(parent, {
      ...freshParent,
      children: [...kids.slice(0, idx), child, ...kids.slice(idx)],
    });
    this.#nodes.set(child, { ...c, parent });
    this.#seedStruct(parent);
    this.#seedStruct(child);
    if (oldParent !== null && oldParent !== parent) this.#seedStruct(oldParent);
    this.#syncExternalSheetsIfSubtreeMutationCanAffectResources(child, previousBaseUrl);
    this.#mutationListener?.({
      kind: "childList",
      target: parent,
      added: [child],
      previousSibling,
      nextSibling,
    });
  }

  removeChild(parent: NodeId, child: NodeId): void {
    const previousBaseUrl = this.#documentBaseUrl();
    const p = this.#nodes.get(parent);
    const c = this.#nodes.get(child);
    if (p === undefined || c === undefined) return;
    const { prev, next } = this.#siblingsOf(p, child);
    this.#nodes.set(parent, {
      ...p,
      children: p.children.filter((id) => id !== child),
    });
    this.#nodes.set(child, { ...c, parent: null });
    this.#seedStruct(parent);
    this.#seedStruct(child);
    this.#syncExternalSheetsIfSubtreeMutationCanAffectResources(child, previousBaseUrl);
    this.#mutationListener?.({
      kind: "childList",
      target: parent,
      removed: [child],
      previousSibling: prev,
      nextSibling: next,
    });
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
