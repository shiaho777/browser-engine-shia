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
  type QueryDef,
} from "@browser-engine/kernel";
import { parseHtml } from "@browser-engine/html-parser";
import { cascade } from "@browser-engine/cascade";
import { layout } from "@browser-engine/layout";
import { paint } from "@browser-engine/paint";

import { documentStylesheets } from "./stylesheets.js";
import { collectImages } from "./images.js";
import type { NodeRef, Url } from "./pipeline.js";
import { withAttribute, withText, withNewNode, withAppendChild, withInsertBefore, withRemoveChild } from "./live.js";
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

const EMPTY_ATTRS: ReadonlyMap<string, string> = new Map();

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
export const qFineSheets = define((db, url: Url) => documentStylesheets(domFacade(db, url, false)), "qFineSheets");

/**
 * `qFineComputed` — the cascade for one node, reading the DOM through the full
 * per-node facade so its dependency footprint is the node + its ancestors only.
 */
export const qFineComputed: QueryDef<NodeRef, ReturnType<typeof cascade>> = define((db, ref: NodeRef) => {
  const dom = domFacade(db, ref.url, false);
  const sheets = db.query(qFineSheets, ref.url);
  return cascade(dom, sheets, ref.node);
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
  "boxSizing", "position", "top", "right", "bottom", "left", "float",
  "flexDirection", "gridTemplateColumns",
  "lineHeight", "textAlign", "whiteSpace", "letterSpacing", "wordSpacing",
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

/**
 * A fine-grained incremental document session. Same API surface as
 * {@link import("./live.js").LiveSession}, but the DOM is decomposed into
 * per-node inputs so a mutation recomputes only the cascades that actually read
 * the edited node.
 */
export class FineSession {
  readonly #db = new IncrementalDb();
  readonly #url: Url;
  #dom: DomTree;
  /** Next free node id for created nodes (one past the current maximum). */
  #nextId: number;

  constructor(html: string, url: Url = "fine://doc") {
    this.#url = url;
    this.#dom = parseHtml(encode(html));
    let max = 0;
    for (const id of this.#dom.nodes.keys()) max = Math.max(max, Number(id));
    this.#nextId = max + 1;
    this.#seed(this.#dom);
  }

  /** Seed the document root + every node's structure and attributes as inputs. */
  #seed(dom: DomTree): void {
    this.#db.setInput(DocRoot, this.#url, dom.root);
    for (const [id, node] of dom.nodes) {
      this.#db.setInput(NodeStruct, nodeKey(this.#url, id), structOf(node));
      this.#db.setInput(NodeAttrs, nodeKey(this.#url, id), node.attrs ?? EMPTY_ATTRS);
    }
  }

  /** The current DOM tree. */
  get dom(): DomTree {
    return this.#dom;
  }

  /** Diagnostic: total compute-fn executions so far. */
  get recomputeCount(): number {
    return this.#db.recomputeCount;
  }

  /** Render the current document to a DisplayList (incrementally). */
  render(): DisplayList {
    return this.#db.query(qFinePaint, this.#url);
  }

  /**
   * The current FragmentTree (layout product). Exposed so callers can observe
   * layout caching: across a PAINT-ONLY mutation the kernel returns the SAME
   * frozen FragmentTree reference (layout did not recompute — paint-only
   * invalidation); a layout-affecting mutation returns a fresh one.
   */
  layoutTree(): ReturnType<typeof layout> {
    return this.#db.query(qFineLayout, this.#url);
  }

  /** The current ComputedStyle of a node (via the kernel). */
  computed(node: NodeId): ReturnType<typeof cascade> {
    return this.#db.query(qFineComputed, { url: this.#url, node });
  }

  /** Mutate the text of a text node (re-seeds only that node's STRUCTURE input). */
  setText(node: NodeId, text: string): void {
    this.#dom = withText(this.#dom, node, text);
    const updated = this.#dom.nodes.get(node);
    if (updated !== undefined) {
      this.#db.setInput(NodeStruct, nodeKey(this.#url, node), structOf(updated));
    }
  }

  /** Mutate an element's attribute (re-seeds ONLY that node's ATTRS input, so
   * a paint-only attribute change never invalidates layout). */
  setAttribute(node: NodeId, name: string, value: string): void {
    this.#dom = withAttribute(this.#dom, node, name, value);
    const updated = this.#dom.nodes.get(node);
    if (updated !== undefined) {
      this.#db.setInput(NodeAttrs, nodeKey(this.#url, node), updated.attrs ?? EMPTY_ATTRS);
    }
  }

  /** Re-seed one node's structure + attribute inputs from the current DOM. */
  #seedNode(node: NodeId): void {
    const updated = this.#dom.nodes.get(node);
    if (updated === undefined) return;
    this.#db.setInput(NodeStruct, nodeKey(this.#url, node), structOf(updated));
    this.#db.setInput(NodeAttrs, nodeKey(this.#url, node), updated.attrs ?? EMPTY_ATTRS);
  }

  /** Create a detached element node (`document.createElement`); returns its id. */
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
    this.#dom = withNewNode(this.#dom, node);
    this.#seedNode(id);
    return id;
  }

  /** Create a detached text node (`document.createTextNode`); returns its id. */
  createTextNode(text: string): NodeId {
    const id = nodeId(this.#nextId);
    this.#nextId += 1;
    const node: DomNode = { id, kind: "text", text, children: [], parent: null };
    this.#dom = withNewNode(this.#dom, node);
    this.#seedNode(id);
    return id;
  }

  /** Append `child` as the last child of `parent` (`Node.appendChild`). */
  appendChild(parent: NodeId, child: NodeId): void {
    const oldParent = this.#dom.nodes.get(child)?.parent ?? null;
    this.#dom = withAppendChild(this.#dom, parent, child);
    this.#seedNode(parent);
    this.#seedNode(child);
    if (oldParent !== null && oldParent !== parent) this.#seedNode(oldParent);
  }

  /** Insert `child` before `ref` among `parent`'s children (`Node.insertBefore`). */
  insertBefore(parent: NodeId, child: NodeId, ref: NodeId | null): void {
    const oldParent = this.#dom.nodes.get(child)?.parent ?? null;
    this.#dom = withInsertBefore(this.#dom, parent, child, ref);
    this.#seedNode(parent);
    this.#seedNode(child);
    if (oldParent !== null && oldParent !== parent) this.#seedNode(oldParent);
  }

  /** Remove `child` from `parent` (`Node.removeChild`); child becomes detached. */
  removeChild(parent: NodeId, child: NodeId): void {
    this.#dom = withRemoveChild(this.#dom, parent, child);
    this.#seedNode(parent);
    this.#seedNode(child);
  }
}
