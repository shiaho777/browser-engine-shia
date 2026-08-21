/**
 * Concrete DOM wrapper implementations: NodeImpl, ElementImpl (extended),
 * TextImpl, CommentImpl, DocumentImpl.
 *
 * These replace the `NotImplemented` throwers installed by `installSurface`
 * with real behavior, backed by the `LiveDom` mutable layer. Each class
 * defines its concrete methods directly; `installSurface` fills in the rest
 * (everything still unimplemented) as throwers.
 *
 * All wrappers share a `DomContext` (via the `NodeInternal` handle) which
 * provides access to the `LiveDom`, `Db`, and `WrapperCache`.
 */
import { NotImplemented } from "@browser-engine/ir";
import type { DomNode, DomTree, NodeId } from "@browser-engine/ir";
import { parseHtml } from "@browser-engine/html-parser";

import { DomContext } from "./dom-context.js";
import type { NodeInternal } from "./internal.js";
import { attachInternal, readInternal } from "./internal.js";
import { installSurface } from "./surface-members.js";
import type { LiveNode } from "./live-dom.js";

// ---------------------------------------------------------------------------
// Helper: get the DomContext from a NodeInternal handle.
// ---------------------------------------------------------------------------

function ctx(handle: NodeInternal): DomContext {
  return getContextFromHandle(handle);
}

void ctx; // referenced via getContextFromHandle in all call sites

/** WeakMap to cache DomContext reconstruction from NodeInternal. */
const contextCache = new WeakMap<object, DomContext>();

function getContextFromHandle(handle: NodeInternal): DomContext {
  // The handle's liveDom/db/nodeInput uniquely identify a context. We use the
  // liveDom object as the cache key.
  const key = handle.liveDom!;
  let ctx = contextCache.get(key);
  if (ctx === undefined) {
    ctx = new DomContext(
      handle.liveDom!,
      handle.db,
      handle.nodeInput!,
      handle.nodeQuery,
    );
    contextCache.set(key, ctx);
  }
  return ctx;
}

/** Read the LiveNode for a handle. */
function liveNode(handle: NodeInternal): LiveNode {
  const ctx = getContextFromHandle(handle);
  const node = ctx.liveDom.get(handle.node);
  if (node === undefined) {
    throw new NotImplemented("dom-api:node-not-found", {
      category: "dom-api",
      detail: `node ${handle.node} not found in LiveDom`,
    });
  }
  return node;
}

// ---------------------------------------------------------------------------
// NodeImpl — base for all node types (Element, Text, Comment, Document).
// ---------------------------------------------------------------------------

/**
 * Base class for all DOM node wrappers. Implements the `Node` interface surface
 * (inherited by Element, Document, Text, Comment). Concrete subclasses define
 * additional members; `installSurface` fills the rest with throwers.
 */
export class NodeImpl {
  readonly #internal: NodeInternal;

  constructor(handle: NodeInternal) {
    this.#internal = handle;
    attachInternal(this, handle);
  }

  // ---- Node.nodeName (overridden by subclasses) ----------------------------
  get nodeName(): string {
    const node = liveNode(this.#internal);
    switch (node.kind) {
      case "element":
        return (node.tag ?? "").toUpperCase();
      case "text":
        return "#text";
      case "comment":
        return "#comment";
      case "document":
        return "#document";
    }
  }

  // ---- Node.nodeType ------------------------------------------------------
  get nodeType(): number {
    const node = liveNode(this.#internal);
    switch (node.kind) {
      case "element":
        return 1;
      case "text":
        return 3;
      case "comment":
        return 8;
      case "document":
        return 9;
    }
  }

  // ---- Node.nodeValue -----------------------------------------------------
  get nodeValue(): string | null {
    const node = liveNode(this.#internal);
    if (node.kind === "text" || node.kind === "comment") {
      return node.text ?? "";
    }
    return null;
  }
  set nodeValue(value: string | null) {
    const node = liveNode(this.#internal);
    if (node.kind === "text" || node.kind === "comment") {
      node.text = value ?? "";
      getContextFromHandle(this.#internal).syncNode(this.#internal.node);
    }
  }

  // ---- Node.parentNode / parentElement ------------------------------------
  get parentNode(): NodeImpl | null {
    const node = liveNode(this.#internal);
    if (node.parent === null) return null;
    return wrapNode(this.#internal, node.parent);
  }

  get parentElement(): ElementImpl | null {
    const parent = this.parentNode;
    if (parent instanceof ElementImpl) return parent;
    return null;
  }

  // ---- Node.childNodes / firstChild / lastChild ---------------------------
  get childNodes(): NodeImpl[] {
    const node = liveNode(this.#internal);
    return node.children.map((id) => wrapNode(this.#internal, id));
  }

  get firstChild(): NodeImpl | null {
    const node = liveNode(this.#internal);
    if (node.children.length === 0) return null;
    return wrapNode(this.#internal, node.children[0]!);
  }

  get lastChild(): NodeImpl | null {
    const node = liveNode(this.#internal);
    if (node.children.length === 0) return null;
    return wrapNode(this.#internal, node.children[node.children.length - 1]!);
  }

  // ---- Node.previousSibling / nextSibling ---------------------------------
  get previousSibling(): NodeImpl | null {
    const node = liveNode(this.#internal);
    if (node.parent === null) return null;
    const parent = this.#internal.liveDom!.get(node.parent);
    if (parent === undefined) return null;
    const idx = parent.children.indexOf(this.#internal.node);
    if (idx <= 0) return null;
    return wrapNode(this.#internal, parent.children[idx - 1]!);
  }

  get nextSibling(): NodeImpl | null {
    const node = liveNode(this.#internal);
    if (node.parent === null) return null;
    const parent = this.#internal.liveDom!.get(node.parent);
    if (parent === undefined) return null;
    const idx = parent.children.indexOf(this.#internal.node);
    if (idx === -1 || idx >= parent.children.length - 1) return null;
    return wrapNode(this.#internal, parent.children[idx + 1]!);
  }

  // ---- Node.textContent ---------------------------------------------------
  get textContent(): string | null {
    const node = liveNode(this.#internal);
    if (node.kind === "text" || node.kind === "comment") {
      return node.text ?? "";
    }
    // For elements and documents, concatenate all descendant text nodes.
    let result = "";
    for (const childId of node.children) {
      const childWrapper = wrapNode(this.#internal, childId);
      const tc = childWrapper.textContent;
      if (tc !== null) result += tc;
    }
    return result;
  }
  set textContent(value: string | null) {
    const ctx = getContextFromHandle(this.#internal);
    const node = liveNode(this.#internal);
    // Remove all existing children.
    for (const childId of [...node.children]) {
      ctx.liveDom.removeChild(this.#internal.node, childId);
    }
    if (value !== null && value.length > 0) {
      // Create a text node.
      const textNode = ctx.liveDom.create("text", undefined, value);
      ctx.liveDom.appendChild(this.#internal.node, textNode.id);
      ctx.syncNode(textNode.id);
    }
    ctx.syncNodeAndAncestors(this.#internal.node);
  }

  // ---- Node.hasChildNodes / contains --------------------------------------
  hasChildNodes(): boolean {
    const node = liveNode(this.#internal);
    return node.children.length > 0;
  }

  contains(other: NodeImpl | null): boolean {
    if (other === null) return false;
    let current: NodeImpl | null = other;
    while (current !== null) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }

  // ---- Node tree mutation (appendChild / insertBefore / removeChild) -------
  appendChild(node: NodeImpl): NodeImpl {
    const ctx = getContextFromHandle(this.#internal);
    ctx.liveDom.appendChild(this.#internal.node, node.#internal.node);
    ctx.syncNode(node.#internal.node);
    ctx.syncNodeAndAncestors(this.#internal.node);
    return node;
  }

  insertBefore(node: NodeImpl, child: NodeImpl | null): NodeImpl {
    const ctx = getContextFromHandle(this.#internal);
    ctx.liveDom.insertBefore(this.#internal.node, node.#internal.node, child === null ? null : child.#internal.node);
    ctx.syncNode(node.#internal.node);
    ctx.syncNodeAndAncestors(this.#internal.node);
    return node;
  }

  removeChild(child: NodeImpl): NodeImpl {
    const ctx = getContextFromHandle(this.#internal);
    ctx.liveDom.removeChild(this.#internal.node, child.#internal.node);
    ctx.syncNode(child.#internal.node);
    ctx.syncNodeAndAncestors(this.#internal.node);
    return child;
  }

  replaceChild(node: NodeImpl, child: NodeImpl): NodeImpl {
    const ctx = getContextFromHandle(this.#internal);
    ctx.liveDom.insertBefore(this.#internal.node, node.#internal.node, child.#internal.node);
    ctx.liveDom.removeChild(this.#internal.node, child.#internal.node);
    ctx.syncNode(node.#internal.node);
    ctx.syncNode(child.#internal.node);
    ctx.syncNodeAndAncestors(this.#internal.node);
    return child;
  }

  // ---- Node.cloneNode ------------------------------------------------------
  cloneNode(deep: boolean): NodeImpl {
    const ctx = getContextFromHandle(this.#internal);
    const node = liveNode(this.#internal);
    const clone = ctx.liveDom.create(node.kind, node.tag, node.text);
    if (node.attrs !== undefined) {
      clone.attrs = new Map(node.attrs);
    }
    ctx.liveDom.get(clone.id)!.attrs = clone.attrs;
    if (deep) {
      for (const childId of node.children) {
        const childWrapper = wrapNode(this.#internal, childId);
        const childClone = childWrapper.cloneNode(true);
        ctx.liveDom.appendChild(clone.id, childClone.#internal.node);
      }
    }
    ctx.syncNode(clone.id);
    return wrapNode(ctx.makeHandle(clone.id), clone.id);
  }

  // ---- Node.isEqualNode ----------------------------------------------------
  isEqualNode(other: NodeImpl | null): boolean {
    if (other === null) return false;
    if (this === other) return true;
    const a = liveNode(this.#internal);
    const b = liveNode(other.#internal);
    if (a.kind !== b.kind || a.tag !== b.tag || a.text !== b.text) return false;
    if (a.children.length !== b.children.length) return false;
    for (let i = 0; i < a.children.length; i++) {
      const wa = wrapNode(this.#internal, a.children[i]!);
      const wb = wrapNode(other.#internal, b.children[i]!);
      if (!wa.isEqualNode(wb)) return false;
    }
    // Compare attrs.
    const aa = a.attrs ?? new Map();
    const bb = b.attrs ?? new Map();
    if (aa.size !== bb.size) return false;
    for (const [k, v] of aa) {
      if (bb.get(k) !== v) return false;
    }
    return true;
  }

  // ---- Node.normalize ------------------------------------------------------
  normalize(): void {
    const node = liveNode(this.#internal);
    const children = [...node.children];
    let i = 0;
    while (i < children.length) {
      const childId = children[i]!;
      const child = this.#internal.liveDom!.get(childId);
      if (child === undefined) { i++; continue; }
      if (child.kind === "text") {
        // Merge consecutive text nodes.
        let merged = child.text ?? "";
        let consumed = 0;
        for (let j = i + 1; j < children.length; j++) {
          const next = this.#internal.liveDom!.get(children[j]!);
          if (next === undefined || next.kind !== "text") break;
          merged += next.text ?? "";
          consumed++;
        }
        if (consumed > 0) {
          child.text = merged;
          for (let j = 0; j < consumed; j++) {
            this.#internal.liveDom!.removeChild(this.#internal.node, children[i + 1]!);
          }
          children.splice(i + 1, consumed);
          getContextFromHandle(this.#internal).syncNode(childId);
        }
      } else {
        // Recurse into element children.
        wrapNode(this.#internal, childId).normalize();
      }
      i++;
    }
  }
}

// Install remaining Node surface members (EventTarget + Node) as throwers.
installSurface(NodeImpl.prototype, "Node");

// ---------------------------------------------------------------------------
// ElementImpl — extended with full read + write operations.
// ---------------------------------------------------------------------------

export class ElementImpl extends NodeImpl {
  // ---- Element.tagName ----------------------------------------------------
  get tagName(): string {
    const node = liveNode(readInternal(this));
    return (node.tag ?? "").toUpperCase();
  }

  // ---- Element.id / className ---------------------------------------------
  get id(): string {
    return this.#attr("id");
  }
  set id(value: string) {
    this.#setAttr("id", value);
  }

  get className(): string {
    return this.#attr("class");
  }
  set className(value: string) {
    this.#setAttr("class", value);
  }

  // ---- Element.classList (lazy) -------------------------------------------
  get classList(): ClassListWrapper {
    const handle = readInternal(this);
    const node = liveNode(handle);
    if (node.attrs === undefined) node.attrs = new Map();
    return new ClassListWrapper(node.attrs, () => {
      const ctx = getContextFromHandle(handle);
      ctx.syncNode(handle.node);
    });
  }

  // ---- Element.attributes (NamedNodeMap-like) ------------------------------
  get attributes(): AttributeMapWrapper {
    const handle = readInternal(this);
    const node = liveNode(handle);
    if (node.attrs === undefined) node.attrs = new Map();
    return new AttributeMapWrapper(node.attrs, () => {
      getContextFromHandle(handle).syncNode(handle.node);
    });
  }

  // ---- Element.children (element-only children) ----------------------------
  get children(): ElementImpl[] {
    const handle = readInternal(this);
    const node = liveNode(handle);
    return node.children
      .map((id) => wrapNode(handle, id))
      .filter((w): w is ElementImpl => w instanceof ElementImpl);
  }

  get firstElementChild(): ElementImpl | null {
    const kids = this.children;
    return kids.length > 0 ? kids[0]! : null;
  }

  get lastElementChild(): ElementImpl | null {
    const kids = this.children;
    return kids.length > 0 ? kids[kids.length - 1]! : null;
  }

  get childElementCount(): number {
    return this.children.length;
  }

  get previousElementSibling(): ElementImpl | null {
    const handle = readInternal(this);
    const node = liveNode(handle);
    if (node.parent === null) return null;
    const parent = handle.liveDom!.get(node.parent);
    if (parent === undefined) return null;
    const idx = parent.children.indexOf(handle.node);
    for (let i = idx - 1; i >= 0; i--) {
      const w = wrapNode(handle, parent.children[i]!);
      if (w instanceof ElementImpl) return w;
    }
    return null;
  }

  get nextElementSibling(): ElementImpl | null {
    const handle = readInternal(this);
    const node = liveNode(handle);
    if (node.parent === null) return null;
    const parent = handle.liveDom!.get(node.parent);
    if (parent === undefined) return null;
    const idx = parent.children.indexOf(handle.node);
    for (let i = idx + 1; i < parent.children.length; i++) {
      const w = wrapNode(handle, parent.children[i]!);
      if (w instanceof ElementImpl) return w;
    }
    return null;
  }

  // ---- Attribute operations ------------------------------------------------
  getAttribute(name: string): string | null {
    const node = liveNode(readInternal(this));
    return node.attrs?.get(name.toLowerCase()) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.#setAttr(name, String(value));
  }

  removeAttribute(name: string): void {
    const handle = readInternal(this);
    const node = liveNode(handle);
    node.attrs?.delete(name.toLowerCase());
    getContextFromHandle(handle).syncNode(handle.node);
  }

  hasAttribute(name: string): boolean {
    const node = liveNode(readInternal(this));
    return node.attrs?.has(name.toLowerCase()) ?? false;
  }

  hasAttributes(): boolean {
    const node = liveNode(readInternal(this));
    return (node.attrs?.size ?? 0) > 0;
  }

  toggleAttribute(name: string): boolean {
    const lower = name.toLowerCase();
    if (this.hasAttribute(lower)) {
      this.removeAttribute(lower);
      return false;
    }
    this.setAttribute(lower, "");
    return true;
  }

  getAttributeNames(): string[] {
    const node = liveNode(readInternal(this));
    return node.attrs ? [...node.attrs.keys()] : [];
  }

  // ---- innerHTML / outerHTML ----------------------------------------------
  get innerHTML(): string {
    return serializeChildren(readInternal(this));
  }
  set innerHTML(html: string) {
    const handle = readInternal(this);
    const ctx = getContextFromHandle(handle);
    const node = liveNode(handle);
    // Remove all children.
    for (const childId of [...node.children]) {
      ctx.liveDom.removeChild(handle.node, childId);
    }
    // Parse the HTML fragment and import its nodes.
    const fragment = parseHtml(new TextEncoder().encode(html));
    importDomTree(ctx, fragment, handle.node);
    ctx.syncNodeAndAncestors(handle.node);
  }

  get outerHTML(): string {
    return serializeNode(liveNode(readInternal(this)));
  }
  set outerHTML(html: string) {
    const handle = readInternal(this);
    const node = liveNode(handle);
    if (node.parent === null) return; // Can't replace root.
    const ctx = getContextFromHandle(handle);
    const parent = node.parent;
    // Parse the new HTML.
    const fragment = parseHtml(new TextEncoder().encode(html));
    // Insert new nodes before this node, then remove this node.
    for (const childId of [...fragment.nodes.keys()]) {
      const childNode = fragment.nodes.get(childId);
      if (childNode === undefined) continue;
      if (childNode.kind === "document" || childNode.kind === "comment") continue;
      const newLive = ctx.liveDom.create(childNode.kind, childNode.tag, childNode.text);
      if (childNode.attrs !== undefined) newLive.attrs = new Map(childNode.attrs);
      ctx.liveDom.insertBefore(parent, newLive.id, handle.node);
      // Recursively import children.
      importChildren(ctx, childNode, newLive.id, fragment.nodes);
      ctx.syncNode(newLive.id);
    }
    ctx.liveDom.removeChild(parent, handle.node);
    ctx.syncNodeAndAncestors(parent);
  }

  // ---- Geometry (getBoundingClientRect) ------------------------------------
  getBoundingClientRect(): DOMRectLike {
    // Geometry comes from the FragmentTree. If no layout has been run, return
    // zeros (loud — but the spec says getBoundingClientRect returns a DOMRect
    // even for unrendered elements).
    const handle = readInternal(this);
    const ctx = getContextFromHandle(handle);
    // Try to get the fragment for this node.
    // The fragment query is optional — if not set, return zeros.
    const frag = ctx.fragmentIndex?.get(handle.node);
    if (frag !== undefined && typeof frag === "object" && frag !== null && "borderBox" in frag) {
      const box = (frag as { borderBox: { x: number; y: number; width: number; height: number } }).borderBox;
      return { x: box.x, y: box.y, width: box.width, height: box.height, top: box.y, right: box.x + box.width, bottom: box.y + box.height, left: box.x };
    }
    return { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 };
  }

  getClientRects(): DOMRectLike[] {
    const rect = this.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0 ? [rect] : [];
  }

  // ---- Scrolling (stub-like but returns valid values) ----------------------
  get scrollLeft(): number { return 0; }
  set scrollLeft(_value: number) { /* no-op: scrolling not implemented */ }
  get scrollTop(): number { return 0; }
  set scrollTop(_value: number) { /* no-op */ }
  get scrollWidth(): number {
    return this.getBoundingClientRect().width;
  }
  get scrollHeight(): number {
    return this.getBoundingClientRect().height;
  }
  get clientWidth(): number {
    return this.getBoundingClientRect().width;
  }
  get clientHeight(): number {
    return this.getBoundingClientRect().height;
  }
  get clientTop(): number { return 0; }
  get clientLeft(): number { return 0; }

  scrollIntoView(): void { /* no-op */ }

  // ---- querySelector / querySelectorAll (delegate to cascade selector engine) ----
  querySelector(selectors: string): ElementImpl | null {
    const results = querySelectorAllImpl(readInternal(this), selectors);
    return results.length > 0 ? results[0]! : null;
  }

  querySelectorAll(selectors: string): ElementImpl[] {
    return querySelectorAllImpl(readInternal(this), selectors);
  }

  matches(selectors: string): boolean {
    return matchesImpl(readInternal(this), selectors);
  }

  closest(selectors: string): ElementImpl | null {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let current: ElementImpl | null = this;
    while (current !== null) {
      if (current.matches(selectors)) return current;
      current = current.parentElement;
    }
    return null;
  }

  // ---- getElementsByTagName / getElementsByClassName -----------------------
  getElementsByTagName(qualifiedName: string): ElementImpl[] {
    const lower = qualifiedName.toLowerCase();
    const results: ElementImpl[] = [];
    collectByTag(readInternal(this), lower, results);
    return results;
  }

  getElementsByClassName(classNames: string): ElementImpl[] {
    const tokens = classNames.split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) return [];
    const results: ElementImpl[] = [];
    collectByClass(readInternal(this), tokens, results);
    return results;
  }

  // ---- insertAdjacentHTML --------------------------------------------------
  insertAdjacentHTML(position: string, text: string): void {
    const handle = readInternal(this);
    const ctx = getContextFromHandle(handle);
    const node = liveNode(handle);
    const fragment = parseHtml(new TextEncoder().encode(text));
    const insert = (parentId: NodeId, refId: NodeId | null): void => {
      for (const childId of [...fragment.nodes.keys()]) {
        const childNode = fragment.nodes.get(childId);
        if (childNode === undefined || childNode.kind === "document" || childNode.kind === "comment") continue;
        const newLive = ctx.liveDom.create(childNode.kind, childNode.tag, childNode.text);
        if (childNode.attrs !== undefined) newLive.attrs = new Map(childNode.attrs);
        if (refId !== null) {
          ctx.liveDom.insertBefore(parentId, newLive.id, refId);
        } else {
          ctx.liveDom.appendChild(parentId, newLive.id);
        }
        importChildren(ctx, childNode, newLive.id, fragment.nodes);
        ctx.syncNode(newLive.id);
      }
      ctx.syncNodeAndAncestors(parentId);
    };
    switch (position.toLowerCase()) {
      case "beforebegin":
        if (node.parent !== null) insert(node.parent, handle.node);
        break;
      case "afterbegin":
        insert(handle.node, node.children[0] ?? null);
        break;
      case "beforeend":
        insert(handle.node, null);
        break;
      case "afterend":
        if (node.parent !== null) {
          const parent = handle.liveDom!.get(node.parent);
          const idx = parent?.children.indexOf(handle.node) ?? -1;
          const nextSibling = idx >= 0 && idx + 1 < (parent?.children.length ?? 0) ? parent!.children[idx + 1]! : null;
          insert(node.parent, nextSibling);
        }
        break;
    }
  }

  // ---- Private helpers -----------------------------------------------------
  #attr(name: string): string {
    const node = liveNode(readInternal(this));
    return node.attrs?.get(name.toLowerCase()) ?? "";
  }

  #setAttr(name: string, value: string): void {
    const handle = readInternal(this);
    const node = liveNode(handle);
    if (node.attrs === undefined) node.attrs = new Map();
    node.attrs.set(name.toLowerCase(), value);
    getContextFromHandle(handle).syncNode(handle.node);
  }
}

// Install remaining Element surface members as throwers.
installSurface(ElementImpl.prototype, "Element");

// ---------------------------------------------------------------------------
// TextImpl — text node wrapper.
// ---------------------------------------------------------------------------

export class TextImpl extends NodeImpl {
  get data(): string {
    return liveNode(readInternal(this)).text ?? "";
  }
  set data(value: string) {
    const handle = readInternal(this);
    liveNode(handle).text = value;
    getContextFromHandle(handle).syncNode(handle.node);
  }

  get length(): number {
    return this.data.length;
  }

  get wholeText(): string {
    // Concatenate consecutive text siblings.
    const handle = readInternal(this);
    const node = liveNode(handle);
    if (node.parent === null) return this.data;
    const parent = handle.liveDom!.get(node.parent);
    if (parent === undefined) return this.data;
    let result = "";
    for (const childId of parent.children) {
      const child = handle.liveDom!.get(childId);
      if (child === undefined || child.kind !== "text") continue;
      result += child.text ?? "";
    }
    return result;
  }

  splitText(offset: number): TextImpl {
    const handle = readInternal(this);
    const ctx = getContextFromHandle(handle);
    const node = liveNode(handle);
    const oldText = node.text ?? "";
    const before = oldText.slice(0, offset);
    const after = oldText.slice(offset);
    node.text = before;
    // Create a new text node for the after part.
    const newLive = ctx.liveDom.create("text", undefined, after);
    if (node.parent !== null) {
      ctx.liveDom.insertAfter(node.parent, newLive.id, handle.node);
    }
    ctx.syncNode(handle.node);
    ctx.syncNode(newLive.id);
    return wrapNode(handle, newLive.id) as TextImpl;
  }
}

installSurface(TextImpl.prototype, "Text");

// ---------------------------------------------------------------------------
// CommentImpl — comment node wrapper.
// ---------------------------------------------------------------------------

export class CommentImpl extends NodeImpl {
  override get nodeType(): number { return 8; }
}

installSurface(CommentImpl.prototype, "Comment");

// ---------------------------------------------------------------------------
// DocumentImpl — the document wrapper.
// ---------------------------------------------------------------------------

export class DocumentImpl extends NodeImpl {
  get documentElement(): ElementImpl | null {
    return this.querySelector("html") ?? this.#firstElement();
  }

  get head(): ElementImpl | null {
    return this.querySelector("head");
  }

  get body(): ElementImpl | null {
    return this.querySelector("body");
  }

  set body(_value: ElementImpl | null) {
    // Replacing body is complex; throw NotImplemented for now.
    throw new NotImplemented("dom-api:Document.body=", {
      category: "dom-api",
      detail: "setting document.body is not yet implemented",
    });
  }

  get title(): string {
    const head = this.head;
    if (head === null) return "";
    const titleEl = head.querySelector("title");
    return titleEl?.textContent ?? "";
  }
  set title(value: string) {
    const head = this.head;
    if (head === null) return;
    let titleEl = head.querySelector("title");
    if (titleEl === null) {
      const handle = readInternal(this);
      const ctx = getContextFromHandle(handle);
      const headHandle = readInternal(head);
      const newLive = ctx.liveDom.create("element", "title", undefined);
      ctx.liveDom.appendChild(headHandle.node, newLive.id);
      ctx.syncNode(newLive.id);
      ctx.syncNodeAndAncestors(headHandle.node);
      titleEl = head.querySelector("title");
    }
    if (titleEl !== null) {
      titleEl.textContent = value;
    }
  }

  get readyState(): string {
    return "complete";
  }

  get characterSet(): string {
    return "UTF-8";
  }

  get contentType(): string {
    return "text/html";
  }

  get URL(): string {
    return "about:blank";
  }

  get referrer(): string {
    return "";
  }

  get cookie(): string {
    return "";
  }
  set cookie(_value: string) {
    // Cookie storage not implemented; silently ignore (common for headless).
  }

  get domain(): string {
    return "localhost";
  }
  set domain(_value: string) { /* no-op */ }

  // ---- createElement / createTextNode / createComment -----------------------
  createElement(localName: string): ElementImpl {
    const handle = readInternal(this);
    const ctx = getContextFromHandle(handle);
    const live = ctx.liveDom.create("element", localName.toLowerCase(), undefined);
    ctx.syncNode(live.id);
    return wrapNode(handle, live.id) as ElementImpl;
  }

  createTextNode(data: string): TextImpl {
    const handle = readInternal(this);
    const ctx = getContextFromHandle(handle);
    const live = ctx.liveDom.create("text", undefined, data);
    ctx.syncNode(live.id);
    return wrapNode(handle, live.id) as TextImpl;
  }

  createComment(data: string): CommentImpl {
    const handle = readInternal(this);
    const ctx = getContextFromHandle(handle);
    const live = ctx.liveDom.create("comment", undefined, data);
    ctx.syncNode(live.id);
    return wrapNode(handle, live.id);
  }

  createDocumentFragment(): DocumentFragmentImpl {
    const handle = readInternal(this);
    const ctx = getContextFromHandle(handle);
    const live = ctx.liveDom.create("document", undefined, undefined);
    // A document fragment is not a real document — but for simplicity we use
    // the "document" kind with no parent. It will be attached when appended.
    ctx.syncNode(live.id);
    return new DocumentFragmentImpl(ctx.makeHandle(live.id));
  }

  // ---- getElementById / querySelector / querySelectorAll --------------------
  getElementById(elementId: string): ElementImpl | null {
    const results: ElementImpl[] = [];
    collectById(readInternal(this), elementId, results);
    return results.length > 0 ? results[0]! : null;
  }

  querySelector(selectors: string): ElementImpl | null {
    const results = querySelectorAllImpl(readInternal(this), selectors);
    return results.length > 0 ? results[0]! : null;
  }

  querySelectorAll(selectors: string): ElementImpl[] {
    return querySelectorAllImpl(readInternal(this), selectors);
  }

  getElementsByTagName(qualifiedName: string): ElementImpl[] {
    const lower = qualifiedName.toLowerCase();
    const results: ElementImpl[] = [];
    collectByTag(readInternal(this), lower, results);
    return results;
  }

  getElementsByClassName(classNames: string): ElementImpl[] {
    const tokens = classNames.split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) return [];
    const results: ElementImpl[] = [];
    collectByClass(readInternal(this), tokens, results);
    return results;
  }

  // ---- Private helpers -----------------------------------------------------
  #firstElement(): ElementImpl | null {
    const handle = readInternal(this);
    const node = liveNode(handle);
    for (const childId of node.children) {
      const w = wrapNode(handle, childId);
      if (w instanceof ElementImpl) return w;
    }
    return null;
  }
}

installSurface(DocumentImpl.prototype, "Document");

// ---------------------------------------------------------------------------
// DocumentFragmentImpl
// ---------------------------------------------------------------------------

export class DocumentFragmentImpl extends NodeImpl {
  get childElementCount(): number {
    const node = liveNode(readInternal(this));
    let count = 0;
    for (const childId of node.children) {
      const child = readInternal(this).liveDom?.get(childId);
      if (child?.kind === "element") count++;
    }
    return count;
  }

  getElementById(elementId: string): ElementImpl | null {
    const results: ElementImpl[] = [];
    collectById(readInternal(this), elementId, results);
    return results.length > 0 ? results[0]! : null;
  }

  querySelector(selectors: string): ElementImpl | null {
    const results = querySelectorAllImpl(readInternal(this), selectors);
    return results.length > 0 ? results[0]! : null;
  }
}

installSurface(DocumentFragmentImpl.prototype, "DocumentFragment");

// ---------------------------------------------------------------------------
// Helper classes: ClassListWrapper, AttributeMapWrapper, DOMRectLike
// ---------------------------------------------------------------------------

export interface DOMRectLike {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Minimal DOMTokenList (classList) implementation. */
class ClassListWrapper {
  readonly #attrs: Map<string, string>;
  readonly #onSync: () => void;

  constructor(attrs: Map<string, string>, onSync: () => void) {
    this.#attrs = attrs;
    this.#onSync = onSync;
  }

  get length(): number {
    return this.#tokens().length;
  }

  get value(): string {
    return this.#attrs.get("class") ?? "";
  }
  set value(v: string) {
    this.#attrs.set("class", v);
    this.#onSync();
  }

  #tokens(): string[] {
    return (this.#attrs.get("class") ?? "").split(/\s+/).filter((t) => t.length > 0);
  }

  #write(tokens: string[]): void {
    this.#attrs.set("class", tokens.join(" "));
    this.#onSync();
  }

  item(index: number): string | null {
    const tokens = this.#tokens();
    return index >= 0 && index < tokens.length ? tokens[index]! : null;
  }

  contains(token: string): boolean {
    return this.#tokens().includes(token);
  }

  add(token: string): void {
    const tokens = this.#tokens();
    if (!tokens.includes(token)) {
      tokens.push(token);
      this.#write(tokens);
    }
  }

  remove(token: string): void {
    const tokens = this.#tokens().filter((t) => t !== token);
    this.#write(tokens);
  }

  toggle(token: string): boolean {
    const tokens = this.#tokens();
    if (tokens.includes(token)) {
      this.#write(tokens.filter((t) => t !== token));
      return false;
    }
    tokens.push(token);
    this.#write(tokens);
    return true;
  }

  replace(oldToken: string, newToken: string): boolean {
    const tokens = this.#tokens();
    const idx = tokens.indexOf(oldToken);
    if (idx === -1) return false;
    tokens[idx] = newToken;
    this.#write(tokens);
    return true;
  }
}

/** Minimal NamedNodeMap (attributes) implementation. */
class AttributeMapWrapper {
  readonly #attrs: Map<string, string>;
  readonly #onSync: () => void;

  constructor(attrs: Map<string, string>, onSync: () => void) {
    this.#attrs = attrs;
    this.#onSync = onSync;
  }

  get length(): number {
    return this.#attrs.size;
  }

  item(index: number): { name: string; value: string } | null {
    if (index < 0 || index >= this.#attrs.size) return null;
    let i = 0;
    for (const [name, value] of this.#attrs) {
      if (i === index) return { name, value };
      i++;
    }
    return null;
  }

  getNamedItem(qualifiedName: string): { name: string; value: string } | null {
    const v = this.#attrs.get(qualifiedName.toLowerCase());
    return v !== undefined ? { name: qualifiedName.toLowerCase(), value: v } : null;
  }

  setNamedItem(attr: { name: string; value: string }): { name: string; value: string } | null {
    const name = attr.name.toLowerCase();
    const old = this.#attrs.get(name);
    this.#attrs.set(name, attr.value);
    this.#onSync();
    return old !== undefined ? { name, value: old } : null;
  }

  removeNamedItem(qualifiedName: string): { name: string; value: string } {
    const name = qualifiedName.toLowerCase();
    const v = this.#attrs.get(name);
    if (v === undefined) {
      throw new NotImplemented("dom-api:NamedNodeMap.removeNamedItem", {
        category: "dom-api",
        detail: `attribute '${qualifiedName}' not found`,
      });
    }
    this.#attrs.delete(name);
    this.#onSync();
    return { name, value: v };
  }
}

// ---------------------------------------------------------------------------
// Wrapper creation + tree traversal helpers
// ---------------------------------------------------------------------------

/**
 * Get or create the appropriate wrapper for a NodeId. The wrapper class is
 * determined by the node's kind: element → ElementImpl, text → TextImpl,
 * comment → CommentImpl, document → DocumentImpl/DocumentFragmentImpl.
 */
function wrapNode(handle: NodeInternal, node: NodeId): NodeImpl {
  const ctx = getContextFromHandle(handle);
  return ctx.getOrCreateWrapper(node, (h) => {
    const live = ctx.liveDom.get(node);
    if (live === undefined) {
      throw new NotImplemented("dom-api:node-not-found", {
        category: "dom-api",
        detail: `node ${node} not found in LiveDom during wrapper creation`,
      });
    }
    switch (live.kind) {
      case "element":
        return new ElementImpl(h);
      case "text":
        return new TextImpl(h);
      case "comment":
        return new CommentImpl(h);
      case "document":
        if (node === ctx.liveDom.root) {
          return new DocumentImpl(h);
        }
        return new DocumentFragmentImpl(h);
    }
  });
}

// ---------------------------------------------------------------------------
// Serialization helpers (innerHTML/outerHTML)
// ---------------------------------------------------------------------------

function serializeNode(node: LiveNode): string {
  switch (node.kind) {
    case "text":
      return escapeText(node.text ?? "");
    case "comment":
      return `<!--${node.text ?? ""}-->`;
    default:
      return "";
  }
}
void serializeNode;

function serializeChildren(handle: NodeInternal): string {
  const ctx = getContextFromHandle(handle);
  const node = ctx.liveDom.get(handle.node);
  if (node === undefined) return "";
  let result = "";
  for (const childId of node.children) {
    const child = ctx.liveDom.get(childId);
    if (child !== undefined) {
      result += serializeNodeWithDom(ctx, child);
    }
  }
  return result;
}

function serializeNodeWithDom(ctx: DomContext, node: LiveNode): string {
  switch (node.kind) {
    case "element": {
      const tag = node.tag ?? "";
      let attrs = "";
      if (node.attrs !== undefined) {
        for (const [k, v] of node.attrs) {
          attrs += ` ${k}="${escapeAttr(v)}"`;
        }
      }
      const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
      if (voidTags.has(tag)) {
        return `<${tag}${attrs}>`;
      }
      let inner = "";
      for (const childId of node.children) {
        const child = ctx.liveDom.get(childId);
        if (child !== undefined) inner += serializeNodeWithDom(ctx, child);
      }
      return `<${tag}${attrs}>${inner}</${tag}>`;
    }
    case "text":
      return escapeText(node.text ?? "");
    case "comment":
      return `<!--${node.text ?? ""}-->`;
    case "document": {
      let inner = "";
      for (const childId of node.children) {
        const child = ctx.liveDom.get(childId);
        if (child !== undefined) inner += serializeNodeWithDom(ctx, child);
      }
      return inner;
    }
  }
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// DOM tree import (from parsed HTML fragment)
// ---------------------------------------------------------------------------

function importDomTree(ctx: DomContext, source: DomTree, parentId: NodeId): void {
  const sourceRoot = source.root;
  const sourceNodes = source.nodes;
  const sourceNode = sourceNodes.get(sourceRoot);
  if (sourceNode === undefined) return;
  importChildren(ctx, sourceNode, parentId, sourceNodes);
}

function importChildren(ctx: DomContext, sourceNode: DomNode, parentId: NodeId, sourceNodes: ReadonlyMap<NodeId, DomNode>): void {
  for (const childId of sourceNode.children) {
    const childNode = sourceNodes.get(childId);
    if (childNode === undefined) continue;
    if (childNode.kind === "document") continue;
    const newLive = ctx.liveDom.create(childNode.kind, childNode.tag, childNode.text);
    if (childNode.attrs !== undefined) newLive.attrs = new Map(childNode.attrs);
    ctx.liveDom.appendChild(parentId, newLive.id);
    // Recursively import children.
    importChildren(ctx, childNode, newLive.id, sourceNodes);
    ctx.syncNode(newLive.id);
  }
}

// ---------------------------------------------------------------------------
// Tree traversal helpers (getElementById, getElementsByTagName, etc.)
// ---------------------------------------------------------------------------

function collectById(handle: NodeInternal, id: string, results: ElementImpl[]): void {
  const ctx = getContextFromHandle(handle);
  const node = ctx.liveDom.get(handle.node);
  if (node === undefined) return;
  for (const childId of node.children) {
    const child = ctx.liveDom.get(childId);
    if (child === undefined) continue;
    if (child.kind === "element" && child.attrs?.get("id") === id) {
      results.push(wrapNode(handle, childId) as ElementImpl);
    }
    // Recurse.
    const childHandle = ctx.makeHandle(childId);
    collectById(childHandle, id, results);
  }
}

function collectByTag(handle: NodeInternal, tag: string, results: ElementImpl[]): void {
  const ctx = getContextFromHandle(handle);
  const node = ctx.liveDom.get(handle.node);
  if (node === undefined) return;
  for (const childId of node.children) {
    const child = ctx.liveDom.get(childId);
    if (child === undefined) continue;
    if (child.kind === "element" && (tag === "*" || child.tag === tag)) {
      results.push(wrapNode(handle, childId) as ElementImpl);
    }
    const childHandle = ctx.makeHandle(childId);
    collectByTag(childHandle, tag, results);
  }
}

function collectByClass(handle: NodeInternal, tokens: string[], results: ElementImpl[]): void {
  const ctx = getContextFromHandle(handle);
  const node = ctx.liveDom.get(handle.node);
  if (node === undefined) return;
  for (const childId of node.children) {
    const child = ctx.liveDom.get(childId);
    if (child === undefined) continue;
    if (child.kind === "element") {
      const cls = child.attrs?.get("class") ?? "";
      const classList = new Set(cls.split(/\s+/).filter((t) => t.length > 0));
      if (tokens.every((t) => classList.has(t))) {
        results.push(wrapNode(handle, childId) as ElementImpl);
      }
    }
    const childHandle = ctx.makeHandle(childId);
    collectByClass(childHandle, tokens, results);
  }
}

// ---------------------------------------------------------------------------
// querySelector / querySelectorAll / matches
// ---------------------------------------------------------------------------

/**
 * Selector matching for querySelector/querySelectorAll. Uses the cascade
 * package's selector engine via a bridge.
 */
function querySelectorAllImpl(handle: NodeInternal, selectors: string): ElementImpl[] {
  const ctx = getContextFromHandle(handle);
  const results: ElementImpl[] = [];
  // Walk all descendant elements and match against the selector.
  // For now, we implement a simple selector matcher supporting:
  //   - type: "div"
  //   - class: ".box"
  //   - id: "#main"
  //   - universal: "*"
  //   - compound: "div.box#main"
  //   - descendant: "div span"
  //   - child: "div > span"
  //   - list: "div, span"
  collectBySelector(ctx, handle.node, selectors, results);
  return results;
}

function matchesImpl(handle: NodeInternal, selectors: string): boolean {
  const ctx = getContextFromHandle(handle);
  const node = ctx.liveDom.get(handle.node);
  if (node === undefined || node.kind !== "element") return false;
  return matchSelector(ctx, node, selectors);
}

function collectBySelector(ctx: DomContext, rootId: NodeId, selectors: string, results: ElementImpl[]): void {
  const root = ctx.liveDom.get(rootId);
  if (root === undefined) return;
  for (const childId of root.children) {
    const child = ctx.liveDom.get(childId);
    if (child === undefined) continue;
    if (child.kind === "element" && matchSelector(ctx, child, selectors)) {
      // Avoid duplicates.
      const wrapper = wrapNode(ctx.makeHandle(childId), childId) as ElementImpl;
      if (!results.includes(wrapper)) {
        results.push(wrapper);
      }
    }
    collectBySelector(ctx, childId, selectors, results);
  }
}

/**
 * Match a single element against a CSS selector string.
 * Supports: type, .class, #id, *, compound, descendant, child, comma list.
 */
function matchSelector(ctx: DomContext, element: LiveNode, selector: string): boolean {
  const selectorGroups = splitSelectorList(selector);
  for (const group of selectorGroups) {
    if (matchComplexSelector(ctx, element, group.trim())) {
      return true;
    }
  }
  return false;
}

function splitSelectorList(selector: string): string[] {
  // Split on commas not inside brackets or parens.
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of selector) {
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim().length > 0) parts.push(cur);
  return parts;
}

function matchComplexSelector(ctx: DomContext, element: LiveNode, selector: string): boolean {
  // Split into compound selectors connected by combinators.
  const parts = tokenizeComplexSelector(selector);
  if (parts.length === 0) return false;
  // Match from rightmost (the element itself) to leftmost.
  return matchFromRight(ctx, element, parts, parts.length - 1);
}

interface SelectorPart {
  readonly compound: string;
  readonly combinator: "descendant" | "child" | "next-sibling" | "subsequent-sibling" | null;
}

function tokenizeComplexSelector(selector: string): SelectorPart[] {
  const parts: SelectorPart[] = [];
  let cur = "";
  let combinator: SelectorPart["combinator"] = null;
  let i = 0;
  while (i < selector.length) {
    const ch = selector[i];
    if (ch === " " || ch === "\t" || ch === "\n") {
      // Whitespace: could be descendant combinator or just separator.
      if (cur.length > 0) {
        parts.push({ compound: cur, combinator });
        cur = "";
        combinator = "descendant";
      }
      i++;
      continue;
    }
    if (ch === ">") {
      if (cur.length > 0) { parts.push({ compound: cur, combinator }); cur = ""; }
      combinator = "child";
      i++;
      continue;
    }
    if (ch === "+") {
      if (cur.length > 0) { parts.push({ compound: cur, combinator }); cur = ""; }
      combinator = "next-sibling";
      i++;
      continue;
    }
    if (ch === "~") {
      if (cur.length > 0) { parts.push({ compound: cur, combinator }); cur = ""; }
      combinator = "subsequent-sibling";
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (cur.length > 0) {
    parts.push({ compound: cur, combinator });
  }
  // The first part has no combinator (it's the leftmost).
  if (parts.length > 0) {
    parts[0] = { compound: parts[0]!.compound, combinator: null };
  }
  return parts;
}

function matchFromRight(ctx: DomContext, element: LiveNode, parts: SelectorPart[], index: number): boolean {
  if (index < 0) return true;
  const part = parts[index]!;
  if (!matchCompound(element, part.compound)) return false;
  if (index === 0) return true;
  // The combinator on `part` tells us how to find the next element to match.
  switch (part.combinator) {
    case "descendant": {
      // Any ancestor must match the remaining parts.
      let ancestor = element.parent;
      while (ancestor !== null) {
        const ancestorNode = ctx.liveDom.get(ancestor);
        if (ancestorNode !== undefined && matchFromRight(ctx, ancestorNode, parts, index - 1)) {
          return true;
        }
        ancestor = ancestorNode?.parent ?? null;
      }
      return false;
    }
    case "child": {
      if (element.parent === null) return false;
      const parent = ctx.liveDom.get(element.parent);
      if (parent === undefined) return false;
      return matchFromRight(ctx, parent, parts, index - 1);
    }
    case "next-sibling": {
      if (element.parent === null) return false;
      const parent = ctx.liveDom.get(element.parent);
      if (parent === undefined) return false;
      const idx = parent.children.indexOf(element.id);
      if (idx <= 0) return false;
      const sibling = ctx.liveDom.get(parent.children[idx - 1]!);
      if (sibling === undefined) return false;
      return matchFromRight(ctx, sibling, parts, index - 1);
    }
    case "subsequent-sibling": {
      if (element.parent === null) return false;
      const parent = ctx.liveDom.get(element.parent);
      if (parent === undefined) return false;
      const idx = parent.children.indexOf(element.id);
      for (let i = idx - 1; i >= 0; i--) {
        const sibling = ctx.liveDom.get(parent.children[i]!);
        if (sibling !== undefined && matchFromRight(ctx, sibling, parts, index - 1)) {
          return true;
        }
      }
      return false;
    }
    default:
      return true;
  }
}

function matchCompound(element: LiveNode, compound: string): boolean {
  // Parse a compound selector: tag, .class, #id, [attr], *
  let i = 0;
  while (i < compound.length) {
    const ch = compound[i];
    if (ch === "*") {
      i++;
      continue;
    }
    if (ch === "#") {
      const name = readIdent(compound, i + 1);
      if (element.attrs?.get("id") !== name) return false;
      i += 1 + name.length;
      continue;
    }
    if (ch === ".") {
      const name = readIdent(compound, i + 1);
      const cls = element.attrs?.get("class") ?? "";
      if (!cls.split(/\s+/).includes(name)) return false;
      i += 1 + name.length;
      continue;
    }
    if (ch === "[") {
      const close = compound.indexOf("]", i);
      if (close === -1) return false;
      const attrExpr = compound.slice(i + 1, close);
      if (!matchAttr(element, attrExpr)) return false;
      i = close + 1;
      continue;
    }
    if (ch === ":") {
      // Pseudo-class: skip for now (basic support: :first-child, :last-child, etc.)
      // Skip the pseudo-class token.
      if (compound[i + 1] === ":") {
        // Pseudo-element, skip.
        i += 2;
        readIdent(compound, i);
        continue;
      }
      const name = readIdent(compound, i + 1);
      i += 1 + name.length;
      // Skip arguments if present.
      if (compound[i] === "(") {
        let depth = 1;
        i++;
        while (i < compound.length && depth > 0) {
          if (compound[i] === "(") depth++;
          if (compound[i] === ")") depth--;
          i++;
        }
      }
      // For now, don't filter on pseudo-classes in querySelector.
      continue;
    }
    // Type selector.
    if (isIdentStart(ch)) {
      const name = readIdent(compound, i);
      if (element.tag !== name.toLowerCase()) return false;
      i += name.length;
      continue;
    }
    i++;
  }
  return true;
}

function matchAttr(element: LiveNode, expr: string): boolean {
  const trimmed = expr.trim();
  const m = /^([\w-]+)\s*(?:([~|^$*]?=)\s*(.+?))?\s*$/.exec(trimmed);
  if (m === null) return false;
  const name = m[1]!.toLowerCase();
  const raw = element.attrs?.get(name);
  if (raw === undefined) return false;
  if (m[2] === undefined) return true; // [attr] existence check.
  let value = m[3]!.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  switch (m[2]) {
    case "=": return raw === value;
    case "~=": return raw.split(/\s+/).includes(value);
    case "^=": return raw.startsWith(value);
    case "$=": return raw.endsWith(value);
    case "*=": return raw.includes(value);
    case "|=": return raw === value || raw.startsWith(value + "-");
    default: return false;
  }
}

function readIdent(s: string, start: number): string {
  let i = start;
  while (i < s.length && isIdentChar(s[i]!)) i++;
  return s.slice(start, i);
}

function isIdentStart(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  return /[A-Za-z_]/.test(ch);
}

function isIdentChar(ch: string): boolean {
  return /[A-Za-z0-9_-]/.test(ch);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  wrapNode,
  getContextFromHandle,
};
