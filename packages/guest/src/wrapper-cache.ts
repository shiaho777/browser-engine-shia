/**
 * Wrapper cache — ensures one wrapper instance per NodeId so that
 * `document.getElementById('x') === document.getElementById('x')` holds
 * (reference equality, as real browsers guarantee).
 *
 * The cache is a `Map<NodeId, WeakRef<Wrapper>>` paired with a `FinalizationRegistry`
 * that cleans up entries when wrappers are GC'd. This prevents unbounded growth
 * while maintaining identity during active use.
 */

/** A weak reference to a wrapper, with a registry token for cleanup. */
interface CachedEntry {
  readonly ref: WeakRef<object>;
}

/**
 * A per-LiveDom wrapper cache. Each NodeId maps to at most one live wrapper.
 * When a wrapper is GC'd, its entry is lazily cleaned on next access.
 */
export class WrapperCache {
  readonly #entries = new Map<number, CachedEntry>();
  readonly #registry: FinalizationRegistry<number>;

  constructor() {
    this.#registry = new FinalizationRegistry<number>((id) => {
      const entry = this.#entries.get(id);
      // Only delete if the weak ref is truly dead (avoids ABA: a new wrapper
      // for the same id may have been created after the old one was finalized).
      if (entry !== undefined && entry.ref.deref() === undefined) {
        this.#entries.delete(id);
      }
    });
  }

  /**
   * Get the cached wrapper for `id`, or `undefined` if none is alive.
   */
  get(id: number): object | undefined {
    const entry = this.#entries.get(id);
    if (entry === undefined) return undefined;
    const wr = entry.ref.deref();
    if (wr === undefined) {
      this.#entries.delete(id);
      return undefined;
    }
    return wr;
  }

  /**
   * Store `wrapper` for `id`. If a live wrapper already exists for `id`, it is
   * NOT replaced (the first cached instance wins, preserving identity). Returns
   * the canonical wrapper for `id` (which may be the existing one).
   */
  set(id: number, wrapper: object): object {
    const existing = this.get(id);
    if (existing !== undefined) return existing;
    this.#entries.set(id, { ref: new WeakRef(wrapper) });
    this.#registry.register(wrapper, id, wrapper);
    return wrapper;
  }

  /** Check whether a live wrapper exists for `id`. */
  has(id: number): boolean {
    return this.get(id) !== undefined;
  }
}
