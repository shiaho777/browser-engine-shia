/**
 * live.ts — the live document session (M3: the interactive engine loop).
 *
 * The one-shot pipeline (`render.ts`) treats the DOM as DERIVED from the source
 * bytes forever, so it cannot represent script mutating the document. A real
 * browser's DOM is MUTABLE STATE: the parser produces the INITIAL DOM, then
 * script edits it and the engine re-renders. This module models exactly that on
 * the incremental kernel:
 *
 *   - the live DOM is a kernel **input** ({@link LiveDom}), seeded once from the
 *     parse and thereafter replaced by mutations;
 *   - `qLiveSheets → qLiveComputed → qLiveLayout → qLivePaint` are the same pure
 *     stages as the static pipeline, but keyed off the mutable DOM input;
 *   - a mutation produces a NEW {@link DomTree} that structurally SHARES every
 *     unchanged node (only the edited node object differs) and `setInput`s it;
 *     the kernel handles invalidation itself (no manual stale-marking).
 *
 * What this delivers (M3): the live loop is CORRECT and MEMOIZED — an
 * incremental re-render is byte-for-byte identical to a from-scratch render of
 * the mutated tree (kernel soundness), re-rendering without a mutation does ZERO
 * recompute, and an equal-value mutation disturbs nothing (Req 2.6).
 *
 * What is explicitly LATER (M4 — the performance flagship): FINE-GRAINED
 * O(changed) incrementality. Today the cascade/layout queries read the whole
 * DOM input, so any structural mutation re-verifies broadly (the early-stop
 * still prunes value-unchanged dependents). Making recompute proportional to the
 * edit needs per-node inputs + content-hashed IR so `verifyClean` is O(1) per
 * dependency — that is M4, and it slots in behind this exact session API.
 */
import {
  deepFreeze,
  nodeId as makeNodeId,
  type DisplayList,
  type DomNode,
  type DomTree,
  type NodeId,
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
import { pipelineShaper } from "./fonts.js";

/** The live, mutable DOM — a kernel INPUT (seeded from parse, edited by script). */
export const LiveDom: InputSlot<Url, DomTree> = defineInput<Url, DomTree>("LiveDom");

/** `qLiveSheets` — collect stylesheets from the live DOM. */
export const qLiveSheets = define((db, url: Url) => documentStylesheets(db.getInput(LiveDom, url)), "qLiveSheets");

/** `qLiveComputed` — the cascade product for one node off the live DOM. */
export const qLiveComputed: QueryDef<NodeRef, ReturnType<typeof cascade>> = define((db, ref: NodeRef) => {
  const dom = db.getInput(LiveDom, ref.url);
  const sheets = db.query(qLiveSheets, ref.url);
  return cascade(dom, sheets, ref.node);
}, "qLiveComputed");

/** `qLiveLayout` — lay the live DOM out into a FragmentTree. */
export const qLiveLayout = define((db, url: Url) => {
  const dom = db.getInput(LiveDom, url);
  return layout(dom, (node) => db.query(qLiveComputed, { url, node }), { shaper: pipelineShaper });
}, "qLiveLayout");

/** `qLivePaint` — the DisplayList for the live document. */
export const qLivePaint: QueryDef<Url, DisplayList> = define((db, url: Url) => {
  const dom = db.getInput(LiveDom, url);
  const fragments = db.query(qLiveLayout, url);
  const images = collectImages(dom);
  return paint(
    fragments,
    (node) => db.query(qLiveComputed, { url, node }),
    (node) => images.get(node),
  );
}, "qLivePaint");

const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * A live document session: a mutable DOM on the incremental kernel. Construct
 * from HTML, `render()` to a DisplayList, and apply DOM mutations (which produce
 * a structurally-shared new tree and re-seed the kernel input). The kernel
 * memoizes and invalidates automatically.
 */
export class LiveSession {
  readonly #db = new IncrementalDb();
  readonly #url: Url;
  #dom: DomTree;

  constructor(html: string, url: Url = "live://doc") {
    this.#url = url;
    this.#dom = parseHtml(encode(html));
    this.#db.setInput(LiveDom, url, this.#dom);
  }

  /** The current (mutable) DOM tree. */
  get dom(): DomTree {
    return this.#dom;
  }

  /** Diagnostic: total compute-fn executions so far (proves memoization). */
  get recomputeCount(): number {
    return this.#db.recomputeCount;
  }

  /** Render the current DOM to a DisplayList (incrementally, via the kernel). */
  render(): DisplayList {
    return this.#db.query(qLivePaint, this.#url);
  }

  /** The current ComputedStyle of a node (via the kernel). */
  computed(node: NodeId): ReturnType<typeof cascade> {
    return this.#db.query(qLiveComputed, { url: this.#url, node });
  }

  /** Replace the live DOM with `next` (a script mutation). */
  setDom(next: DomTree): void {
    this.#dom = next;
    this.#db.setInput(LiveDom, this.#url, next);
  }

  /** Mutate the text of a text node, re-seeding the kernel input. */
  setText(node: NodeId, text: string): void {
    this.setDom(withText(this.#dom, node, text));
  }

  /** Mutate an element's attribute, re-seeding the kernel input. */
  setAttribute(node: NodeId, name: string, value: string): void {
    this.setDom(withAttribute(this.#dom, node, name, value));
  }
}

// ---------------------------------------------------------------------------
// Pure DOM mutations: produce a NEW frozen DomTree that structurally SHARES
// every unchanged node (only the edited node object is replaced).
// ---------------------------------------------------------------------------

/** A new DomTree with `node`'s text replaced (must be a text/comment node). */
export function withText(dom: DomTree, node: NodeId, text: string): DomTree {
  return replaceNode(dom, node, (n) => ({ ...n, text }));
}

/** A new DomTree with `node`'s attribute `name` set to `value` (an element). */
export function withAttribute(dom: DomTree, node: NodeId, name: string, value: string): DomTree {
  return replaceNode(dom, node, (n) => {
    const attrs = new Map(n.attrs ?? []);
    attrs.set(name, value);
    return { ...n, attrs };
  });
}

/** A new DomTree with `node`'s attribute `name` removed (an element). */
export function withRemoveAttribute(dom: DomTree, node: NodeId, name: string): DomTree {
  return replaceNode(dom, node, (n) => {
    const attrs = new Map(n.attrs ?? []);
    attrs.delete(name);
    return { ...n, attrs };
  });
}

/** Build a new frozen DomTree with exactly one node transformed by `edit`. */
function replaceNode(dom: DomTree, node: NodeId, edit: (n: DomNode) => DomNode): DomTree {
  const existing = dom.nodes.get(node);
  if (existing === undefined) {
    return dom; // editing a non-existent node is a no-op.
  }
  const nodes = new Map(dom.nodes); // structural share: same node objects, one replaced.
  nodes.set(node, edit(existing));
  return deepFreeze({ root: dom.root, nodes } as unknown as DomTree);
}

/** Rebuild a frozen DomTree after an arbitrary multi-node mutation. */
function rebuild(dom: DomTree, mutate: (nodes: Map<NodeId, DomNode>) => void): DomTree {
  const nodes = new Map(dom.nodes);
  mutate(nodes);
  return deepFreeze({ root: dom.root, nodes } as unknown as DomTree);
}

/** A new DomTree with a freshly-created (detached) node added to the node set. */
export function withNewNode(dom: DomTree, node: DomNode): DomTree {
  return rebuild(dom, (nodes) => {
    nodes.set(node.id, node);
  });
}

/** Detach `child` from its current parent's children list (helper). */
function detach(nodes: Map<NodeId, DomNode>, child: NodeId): void {
  const c = nodes.get(child);
  if (c === undefined || c.parent === null) return;
  const old = nodes.get(c.parent);
  if (old !== undefined) {
    nodes.set(old.id, { ...old, children: old.children.filter((id) => id !== child) });
  }
}

/** A new DomTree with `child` appended as the last child of `parent` (reparenting). */
export function withAppendChild(dom: DomTree, parent: NodeId, child: NodeId): DomTree {
  return rebuild(dom, (nodes) => {
    const p = nodes.get(parent);
    const c = nodes.get(child);
    if (p === undefined || c === undefined || parent === child) return;
    detach(nodes, child);
    const freshParent = nodes.get(parent) as DomNode;
    nodes.set(parent, { ...freshParent, children: [...freshParent.children.filter((id) => id !== child), child] });
    nodes.set(child, { ...c, parent });
  });
}

/** A new DomTree with `child` inserted before `ref` among `parent`'s children. */
export function withInsertBefore(dom: DomTree, parent: NodeId, child: NodeId, ref: NodeId | null): DomTree {
  return rebuild(dom, (nodes) => {
    const p = nodes.get(parent);
    const c = nodes.get(child);
    if (p === undefined || c === undefined || parent === child) return;
    detach(nodes, child);
    const freshParent = nodes.get(parent) as DomNode;
    const kids = freshParent.children.filter((id) => id !== child);
    const at = ref === null ? kids.length : kids.indexOf(ref);
    const idx = at < 0 ? kids.length : at;
    nodes.set(parent, { ...freshParent, children: [...kids.slice(0, idx), child, ...kids.slice(idx)] });
    nodes.set(child, { ...c, parent });
  });
}

/** A new DomTree with `child` removed from `parent` (child becomes detached). */
export function withRemoveChild(dom: DomTree, parent: NodeId, child: NodeId): DomTree {
  return rebuild(dom, (nodes) => {
    const p = nodes.get(parent);
    const c = nodes.get(child);
    if (p === undefined || c === undefined) return;
    nodes.set(parent, { ...p, children: p.children.filter((id) => id !== child) });
    nodes.set(child, { ...c, parent: null });
  });
}

/** Re-export so callers can build node ids for mutations. */
export { makeNodeId as nodeId };
