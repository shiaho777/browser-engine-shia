/**
 * LiveDom — a mutable DOM layer that wraps the immutable {@link DomTree} IR
 * (design.md §6, §10; Requirement 7).
 *
 * The IR `DomTree` is `deepFreeze`d and must never be mutated (Requirement 3.1).
 * But the DOM API surface (appendChild, setAttribute, removeChild, …) is
 * inherently mutable — guest JavaScript expects `el.appendChild(child)` to
 * change the tree. `LiveDom` resolves this by maintaining its OWN mutable copy
 * of the node map, seeded from the frozen `DomTree`. All wrapper reads go
 * through `LiveDom`, not the IR. Writes mutate the `LiveDom` and then push the
 * changed node back into the kernel via `setInput`, so downstream stages
 * (cascade, layout, paint) see the mutation on the next recompute.
 *
 * `LiveDom` lives entirely on the kernel side of the boundary. It is never
 * exposed to guest code; only the `NodeInternal` handle references it.
 */
import type { DomNode, DomTree, NodeId } from "@browser-engine/ir";
import { nodeId } from "@browser-engine/ir";
import type { Db, InputSlot } from "@browser-engine/kernel";

/**
 * A mutable DOM node — the live counterpart of the frozen {@link DomNode}.
 * `attrs` is a mutable `Map` and `children` is a mutable array so the DOM API
 * can modify them in-place.
 */
export interface LiveNode {
  readonly id: NodeId;
  readonly kind: DomNode["kind"];
  tag: string | undefined;
  attrs: Map<string, string> | undefined;
  text: string | undefined;
  children: NodeId[];
  parent: NodeId | null;
}

/**
 * The mutable DOM layer. Owns a `Map<NodeId, LiveNode>` seeded from the
 * original `DomTree`, plus a monotonic next-id counter for nodes created by
 * guest JS (`document.createElement`, `createTextNode`, …).
 */
export class LiveDom {
  /** Mutable node storage. */
  readonly #nodes = new Map<NodeId, LiveNode>();
  /** The root node id (the document node). */
  readonly #root: NodeId;
  /** Next available NodeId for guest-created nodes. */
  #nextId: number;

  constructor(dom: DomTree) {
    this.#root = dom.root;
    let maxId = 0;
    for (const [id, node] of dom.nodes) {
      const live: LiveNode = {
        id,
        kind: node.kind,
        tag: node.tag,
        attrs: node.attrs !== undefined ? new Map(node.attrs) : undefined,
        text: node.text,
        children: [...node.children],
        parent: node.parent,
      };
      this.#nodes.set(id, live);
      const numericId = id as unknown as number;
      if (numericId > maxId) maxId = numericId;
    }
    this.#nextId = maxId + 1;
  }

  /** The root node id (document). */
  get root(): NodeId {
    return this.#root;
  }

  /** Get a live node by id, or `undefined`. */
  get(id: NodeId): LiveNode | undefined {
    return this.#nodes.get(id);
  }

  /** Allocate a fresh NodeId for a guest-created node. */
  nextId(): NodeId {
    return nodeId(this.#nextId++);
  }

  /** Create and register a new live node. Returns the node. */
  create(kind: DomNode["kind"], tag?: string, text?: string): LiveNode {
    const id = this.nextId();
    const node: LiveNode = {
      id,
      kind,
      tag,
      attrs: kind === "element" ? new Map() : undefined,
      text,
      children: [],
      parent: null,
    };
    this.#nodes.set(id, node);
    return node;
  }

  /** Insert `childId` as the last child of `parentId`. */
  appendChild(parentId: NodeId, childId: NodeId): LiveNode {
    const parent = this.#nodes.get(parentId);
    const child = this.#nodes.get(childId);
    if (parent === undefined || child === undefined) {
      throw new Error(`LiveDom.appendChild: node not found (parent=${parentId}, child=${childId})`);
    }
    // Detach from current parent first.
    if (child.parent !== null) {
      const oldParent = this.#nodes.get(child.parent);
      if (oldParent !== undefined) {
        const idx = oldParent.children.indexOf(childId);
        if (idx !== -1) oldParent.children.splice(idx, 1);
      }
    }
    child.parent = parentId;
    parent.children.push(childId);
    return child;
  }

  /**
   * Insert `childId` before `refId` under `parentId`. If `refId` is null,
   * appends to the end.
   */
  insertBefore(parentId: NodeId, childId: NodeId, refId: NodeId | null): LiveNode {
    if (refId === null) {
      return this.appendChild(parentId, childId);
    }
    const parent = this.#nodes.get(parentId);
    const child = this.#nodes.get(childId);
    if (parent === undefined || child === undefined) {
      throw new Error(`LiveDom.insertBefore: node not found`);
    }
    // Detach from current parent.
    if (child.parent !== null) {
      const oldParent = this.#nodes.get(child.parent);
      if (oldParent !== undefined) {
        const idx = oldParent.children.indexOf(childId);
        if (idx !== -1) oldParent.children.splice(idx, 1);
      }
    }
    const refIdx = parent.children.indexOf(refId);
    if (refIdx === -1) {
      throw new Error(`LiveDom.insertBefore: ref child not found under parent`);
    }
    child.parent = parentId;
    parent.children.splice(refIdx, 0, childId);
    return child;
  }

  /** Remove `childId` from its parent. Returns the removed node. */
  removeChild(parentId: NodeId, childId: NodeId): LiveNode {
    const parent = this.#nodes.get(parentId);
    const child = this.#nodes.get(childId);
    if (parent === undefined || child === undefined) {
      throw new Error(`LiveDom.removeChild: node not found`);
    }
    const idx = parent.children.indexOf(childId);
    if (idx === -1) {
      throw new Error(`LiveDom.removeChild: child not found under parent`);
    }
    parent.children.splice(idx, 1);
    child.parent = null;
    return child;
  }

  /**
   * Insert `childId` immediately after `refId` under the same parent.
   * Used by `Text.splitText()`.
   */
  insertAfter(parentId: NodeId, childId: NodeId, refId: NodeId): LiveNode {
    const parent = this.#nodes.get(parentId);
    const child = this.#nodes.get(childId);
    if (parent === undefined || child === undefined) {
      throw new Error(`LiveDom.insertAfter: node not found`);
    }
    // Detach from current parent.
    if (child.parent !== null) {
      const oldParent = this.#nodes.get(child.parent);
      if (oldParent !== undefined) {
        const idx = oldParent.children.indexOf(childId);
        if (idx !== -1) oldParent.children.splice(idx, 1);
      }
    }
    const refIdx = parent.children.indexOf(refId);
    if (refIdx === -1) {
      throw new Error(`LiveDom.insertAfter: ref child not found under parent`);
    }
    child.parent = parentId;
    parent.children.splice(refIdx + 1, 0, childId);
    return child;
  }

  /**
   * Snapshot a `LiveNode` back into an immutable `DomNode` for the kernel.
   * The returned object is frozen to maintain IR immutability.
   */
  toDomNode(live: LiveNode): DomNode {
    return Object.freeze({
      id: live.id,
      kind: live.kind,
      tag: live.tag,
      attrs: live.attrs !== undefined ? new Map(live.attrs) : undefined,
      text: live.text,
      children: Object.freeze([...live.children]),
      parent: live.parent,
    }) as DomNode;
  }
}

/**
 * Push a live node's current state into the kernel so downstream stages see
 * the mutation. Called after any DOM write.
 */
export function syncNodeToKernel(
  liveDom: LiveDom,
  node: NodeId,
  db: Db,
  input: InputSlot<NodeId, DomNode>,
): void {
  const live = liveDom.get(node);
  if (live === undefined) return;
  db.setInput(input, node, liveDom.toDomNode(live));
}

/**
 * Push ALL live nodes into the kernel (bulk sync after structural changes).
 */
export function syncAllToKernel(
  liveDom: LiveDom,
  db: Db,
  input: InputSlot<NodeId, DomNode>,
): void {
  for (const [id, live] of liveDom.get(liveDom.root) !== undefined ? allNodes(liveDom) : []) {
    db.setInput(input, id, liveDom.toDomNode(live));
  }
}

/** Iterate all live nodes. */
function* allNodes(liveDom: LiveDom): Generator<[NodeId, LiveNode]> {
  // We need to iterate all nodes, not just root's subtree. Use the internal map.
  // Since LiveDom doesn't expose the map directly, we walk from root.
  yield* walkFrom(liveDom, liveDom.root);
}

/** Recursively yield all nodes under (and including) `root`. */
function* walkFrom(liveDom: LiveDom, root: NodeId): Generator<[NodeId, LiveNode]> {
  const node = liveDom.get(root);
  if (node === undefined) return;
  yield [root, node];
  for (const childId of node.children) {
    yield* walkFrom(liveDom, childId);
  }
}
