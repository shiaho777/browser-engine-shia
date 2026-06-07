/**
 * `ElementImpl` — a guest-visible DOM `Element` wrapper that demonstrates the
 * kernel/guest boundary (design.md §10; Requirement 7).
 *
 * The wrapper exposes ONLY the generated `Element` web surface (resolved across
 * its inheritance chain from `DOM_SURFACE`). Its engine-internal handle — the
 * {@link NodeId}, the Incremental_Kernel {@link Db}, and the fragment index — is
 * stored two ways, neither of which a guest can reach:
 *
 *   1. behind the module-private `INTERNAL` symbol in a package-private WeakMap
 *      (`./internal.ts` — the primary isolation), and
 *   2. in a `#private` class field (a second, independent layer of defense,
 *      per design.md §10).
 *
 * Concrete read members (`tagName`, `id`, `className`, `getAttribute`,
 * `hasAttribute`) read live DOM state *through the kernel* (`db.query`), so they
 * participate in automatic dependency tracking (design.md §7). Every other
 * generated member is installed as a loud `NotImplemented` thrower by
 * {@link installSurface} — never a silent placeholder (Requirement 5.1).
 */
import { NotImplemented } from "@browser-engine/ir";

import { attachInternal, type NodeInternal } from "./internal.js";
import { installSurface } from "./surface-members.js";

/** The generated interface name this wrapper implements. */
const INTERFACE_NAME = "Element";

export class ElementImpl {
  /**
   * Second layer of defense (design.md §10): a true `#private` field. It is
   * unreachable and unenumerable by guests independently of the WeakMap, and is
   * what the concrete members below read.
   */
  readonly #internal: NodeInternal;

  constructor(handle: NodeInternal) {
    this.#internal = handle;
    // Primary isolation: stash the handle behind the module-private symbol in
    // the guest-unreachable WeakMap.
    attachInternal(this, handle);
  }

  /** `Element.tagName` — the uppercased tag name (generated, readonly). */
  get tagName(): string {
    const { db, node, nodeQuery } = this.#internal;
    const dom = db.query(nodeQuery, node);
    if (dom.tag === undefined) {
      throw new NotImplemented("dom-api:Element.tagName", {
        category: "dom-api",
        detail: "wrapped node is not an element (has no tag)",
      });
    }
    return dom.tag.toUpperCase();
  }

  /** `Element.id` — the `id` attribute value, or empty string when absent. */
  get id(): string {
    return this.#attr("id");
  }

  /** `Element.className` — the `class` attribute value, or empty when absent. */
  get className(): string {
    return this.#attr("class");
  }

  /** `Element.getAttribute(name)` — the attribute value, or empty when absent. */
  getAttribute(name: string): string {
    return this.#attr(name);
  }

  /** `Element.hasAttribute(name)` — whether the named attribute is present. */
  hasAttribute(name: string): boolean {
    const { db, node, nodeQuery } = this.#internal;
    const dom = db.query(nodeQuery, node);
    return dom.attrs?.has(name) ?? false;
  }

  /** Read a single attribute through the kernel; empty string when absent. */
  #attr(name: string): string {
    const { db, node, nodeQuery } = this.#internal;
    const dom = db.query(nodeQuery, node);
    return dom.attrs?.get(name) ?? "";
  }
}

// Install every remaining generated `Element` surface member (and inherited
// `Node` / `EventTarget` members) as a loud NotImplemented thrower. Members
// already defined as concrete class accessors/methods above are skipped.
installSurface(ElementImpl.prototype, INTERFACE_NAME);

/**
 * Build a guest-visible `Element` wrapper from an engine-internal handle. The
 * only sanctioned way for in-package engine code to mint a wrapper; guests
 * receive the resulting object but never the `handle`.
 */
export function createElementWrapper(handle: NodeInternal): ElementImpl {
  return new ElementImpl(handle);
}
