/**
 * AbortController / AbortSignal (DOM Standard §3.2 aborting).
 *
 * `AbortSignal` is an {@link EventTargetImpl}: aborting fires a plain
 * `"abort"` event, so listeners registered through `addEventListener` (and
 * `addEventListener(..., { signal })`) all observe it. The classes are
 * guest-constructible exactly as far as the platform exposes them —
 * `new AbortSignal()` is not platform surface, so the constructor is
 * internal-only while the statics (`abort`, `timeout`, `any`) and
 * `AbortController` cover every spec'd creation path.
 */
import { EventImpl, EventTargetImpl } from "./event-system.js";

/** Minimal DOMException shape (name + message) for abort reasons. */
export class DOMException extends Error {
  override readonly name: string;

  constructor(message: string, name: string) {
    super(message);
    this.name = name;
  }
}

const ABORT_ERROR_MESSAGE = "The operation was aborted.";
let CREATION_SEQUENCE = 0;
const TIMEOUT_MESSAGE = "The operation was aborted due to timeout";

export class AbortSignal extends EventTargetImpl {
  #aborted = false;
  #reason: unknown = undefined;
  #onabort: ((event: EventImpl) => void) | null = null;

  get aborted(): boolean {
    return this.#aborted;
  }

  get reason(): unknown {
    return this.#reason;
  }

  /** The `onabort` IDL attribute, backed by an internal event listener. */
  get onabort(): ((event: EventImpl) => void) | null {
    return this.#onabort;
  }

  set onabort(handler: ((event: EventImpl) => void) | null) {
    if (this.#onabort !== null) {
      this.removeEventListener("abort", this.#onabort);
    }
    this.#onabort = typeof handler === "function" ? handler : null;
    if (this.#onabort !== null) {
      this.addEventListener("abort", this.#onabort);
    }
  }

  throwIfAborted(): void {
    if (this.#aborted) {
      throw this.#reason;
    }
  }

  /**
   * The abort algorithm (DOM §3.2): idempotent; records the reason (defaulting
   * to an `"AbortError"` DOMException) and fires a plain `"abort"` event.
   * @internal
   */
  /**
   * The abort mechanics (DOM §3.2 "signal abort"): abort ALGORITHMS of a
   * signal (its dependents' propagation) all run BEFORE any "abort" event
   * fires, so dependents observe `aborted === true` inside earlier listeners.
   * Events then fire across the whole aborted group in signal-creation order —
   * the observable order official WPT asserts for composite signals.
   */
  readonly #createdAt = ++CREATION_SEQUENCE;
  readonly #abortAlgorithms = new Set<() => void>();

  /** The in-flight aborted group (null when no abort is being processed). */
  static #pendingGroup: AbortSignal[] | null = null;

  _abort(reason?: unknown): void {
    if (this.#aborted) return;
    const isRoot = AbortSignal.#pendingGroup === null;
    const group = (AbortSignal.#pendingGroup ??= []);
    this.#markAborted(reason === undefined ? new DOMException(ABORT_ERROR_MESSAGE, "AbortError") : reason, group);
    // Nested _abort calls (dependents reached via propagation algorithms) only
    // join the root's group; after the WHOLE group is marked, events fire in
    // signal-creation order.
    if (!isRoot) return;
    AbortSignal.#pendingGroup = null;
    group.sort((a, b) => a.#createdAt - b.#createdAt);
    for (const signal of group) {
      const event = new EventImpl("abort");
      event._setTrusted(true);
      signal.dispatchEvent(event);
    }
  }

  #markAborted(reason: unknown, queue: AbortSignal[]): void {
    if (this.#aborted) return;
    this.#aborted = true;
    this.#reason = reason;
    queue.push(this);
    // Run dependents' propagation first (they join the same aborted group).
    for (const algorithm of [...this.#abortAlgorithms]) algorithm();
  }

  /** Register a dependent-propagation algorithm run before abort events. @internal */
  _addAbortAlgorithm(algorithm: () => void): void {
    if (this.#aborted) {
      algorithm();
      return;
    }
    this.#abortAlgorithms.add(algorithm);
  }

  /** `AbortSignal.abort(reason)` — an already-aborted signal. */
  static abort(reason?: unknown): AbortSignal {
    const signal = new AbortSignal();
    signal._abort(reason);
    return signal;
  }

  /** `AbortSignal.timeout(ms)` — aborts with a `"TimeoutError"` after `ms`. */
  static timeout(ms: number): AbortSignal {
    const signal = new AbortSignal();
    setTimeout(() => {
      signal._abort(new DOMException(TIMEOUT_MESSAGE, "TimeoutError"));
    }, Math.max(0, Number(ms) || 0));
    return signal;
  }

  /** `AbortSignal.any(signals)` — aborts when any input signal aborts. */
  static any(signals: readonly AbortSignal[]): AbortSignal {
    const composite = new AbortSignal();
    for (const source of signals) {
      if (source.aborted) {
        composite._abort(source.reason);
        return composite;
      }
      source._addAbortAlgorithm(() => {
        composite._abort(source.reason);
      });
    }
    return composite;
  }
}

export class AbortController {
  readonly #signal = new AbortSignal();

  get signal(): AbortSignal {
    return this.#signal;
  }

  abort(reason?: unknown): void {
    this.#signal._abort(reason);
  }
}
