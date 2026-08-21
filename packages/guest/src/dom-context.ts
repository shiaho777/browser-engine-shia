/**
 * DomContext — the shared context all DOM wrapper implementations read through.
 *
 * Each wrapper's `NodeInternal` handle references a `LiveDom`, `Db`, and
 * `InputSlot`. But wrappers also need to mint NEW wrappers (e.g.
 * `element.childNodes` returns an array of Node wrappers, `document.createElement`
 * creates a new node + wrapper). Rather than threading these through every
 * call, the `DomContext` bundles everything needed to create and manage
 * wrappers, and is shared across all wrappers in a document.
 */
import type { DomNode, NodeId } from "@browser-engine/ir";
import type { Db, InputSlot, QueryDef } from "@browser-engine/kernel";
import type { LiveDom } from "./live-dom.js";
import { WrapperCache } from "./wrapper-cache.js";
import type { NodeInternal } from "./internal.js";

/**
 * The shared DOM context. A single instance is created per guest runtime /
 * document, and all wrappers created from it share the same `LiveDom`, `Db`,
 * `InputSlot`, and `WrapperCache`.
 */
export class DomContext {
  readonly liveDom: LiveDom;
  readonly db: Db;
  readonly nodeInput: InputSlot<NodeId, DomNode>;
  readonly nodeQuery: QueryDef<NodeId, DomNode>;
  readonly #wrapperCache = new WrapperCache();
  /** Fragment geometry (optional — layout may not have run). */
  fragmentIndex: Map<number, unknown> | undefined;

  constructor(
    liveDom: LiveDom,
    db: Db,
    nodeInput: InputSlot<NodeId, DomNode>,
    nodeQuery: QueryDef<NodeId, DomNode>,
  ) {
    this.liveDom = liveDom;
    this.db = db;
    this.nodeInput = nodeInput;
    this.nodeQuery = nodeQuery;
  }

  /**
   * Build the `NodeInternal` handle for a given NodeId. The handle is what
   * `attachInternal` stores behind the module-private symbol.
   */
  makeHandle(node: NodeId): NodeInternal {
    return {
      node,
      db: this.db,
      nodeQuery: this.nodeQuery,
      liveDom: this.liveDom,
      nodeInput: this.nodeInput,
      wrapperCache: this.#wrapperCache,
    };
  }

  /**
   * Get or create a wrapper for `node`. The wrapper is cached so repeated calls
   * return the SAME object (reference identity, as real browsers guarantee).
   *
   * The `factory` creates the wrapper if it doesn't exist. Different node kinds
   * (element, text, document, comment) get different wrapper classes.
   */
  getOrCreateWrapper<T extends object>(node: NodeId, factory: (handle: NodeInternal) => T): T {
    const numericId = node as unknown as number;
    const existing = this.#wrapperCache.get(numericId);
    if (existing !== undefined) return existing as T;
    const wrapper = factory(this.makeHandle(node));
    return this.#wrapperCache.set(numericId, wrapper) as T;
  }

  /** Push a live node's state into the kernel. */
  syncNode(node: NodeId): void {
    const live = this.liveDom.get(node);
    if (live === undefined) return;
    this.db.setInput(this.nodeInput, node, this.liveDom.toDomNode(live));
  }

  /** Push a node and all its ancestors into the kernel (for structural changes). */
  syncNodeAndAncestors(node: NodeId): void {
    let current: NodeId | null = node;
    while (current !== null) {
      this.syncNode(current);
      const live = this.liveDom.get(current);
      current = live?.parent ?? null;
    }
  }
}
