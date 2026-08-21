/**
 * AbortController / AbortSignal (DOM Standard §3.2 aborting).
 *
 * `AbortSignalImpl` is an {@link EventTargetImpl}: aborting fires a plain
 * `"abort"` event, so listeners registered through `addEventListener` (and
 * `addEventListener(..., { signal })`) all observe it. The classes are
 * guest-constructible exactly as far as the platform exposes them —
 * `new AbortSignal()` is not platform surface, so the constructor is
 * internal-only while the statics (`abort`, `timeout`, `any`) and
 * `AbortController` cover every spec'd creation path.
 */
import { EventImpl, EventTargetImpl } from "./event-system.js";

/** Minimal DOMException shape (name + message) for abort reasons. */
export class DOMExceptionImpl extends Error {
  override readonly name: string;

  constructor(message: string, name: string) {
    super(message);
    this.name = name;
  }
}

const ABORT_ERROR_MESSAGE = "The operation was aborted.";
const TIMEOUT_MESSAGE = "The operation was aborted due to timeout";

export class AbortSignalImpl extends EventTargetImpl {
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
  _abort(reason?: unknown): void {
    if (this.#aborted) return;
    this.#aborted = true;
    this.#reason = reason === undefined ? new DOMExceptionImpl(ABORT_ERROR_MESSAGE, "AbortError") : reason;
    this.dispatchEvent(new EventImpl("abort"));
  }

  /** `AbortSignal.abort(reason)` — an already-aborted signal. */
  static abort(reason?: unknown): AbortSignalImpl {
    const signal = new AbortSignalImpl();
    signal._abort(reason);
    return signal;
  }

  /** `AbortSignal.timeout(ms)` — aborts with a `"TimeoutError"` after `ms`. */
  static timeout(ms: number): AbortSignalImpl {
    const signal = new AbortSignalImpl();
    setTimeout(() => {
      signal._abort(new DOMExceptionImpl(TIMEOUT_MESSAGE, "TimeoutError"));
    }, Math.max(0, Number(ms) || 0));
    return signal;
  }

  /** `AbortSignal.any(signals)` — aborts when any input signal aborts. */
  static any(signals: readonly AbortSignalImpl[]): AbortSignalImpl {
    const composite = new AbortSignalImpl();
    for (const source of signals) {
      if (source.aborted) {
        composite._abort(source.reason);
        return composite;
      }
      source.addEventListener("abort", () => {
        composite._abort(source.reason);
      });
    }
    return composite;
  }
}

export class AbortControllerImpl {
  readonly #signal = new AbortSignalImpl();

  get signal(): AbortSignalImpl {
    return this.#signal;
  }

  abort(reason?: unknown): void {
    this.#signal._abort(reason);
  }
}
