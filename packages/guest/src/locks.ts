/**
 * Web Locks API (WICG web-locks): `navigator.locks` → {@link LockManager}.
 *
 * A single-manager implementation over an in-memory registry: exclusive and
 * shared modes, a FIFO request queue per resource name, `ifAvailable`
 * (non-blocking), `steal` (preempt held locks), `signal` (abort a pending
 * request), and `query()` state snapshots. The lock is held for the duration
 * of the request callback and released when it settles.
 */
import { AbortSignal, DOMException } from "./abort.js";

export type LockMode = "exclusive" | "shared";

export interface LockRequestOptions {
  mode?: LockMode;
  ifAvailable?: boolean;
  steal?: boolean;
  signal?: { aborted: boolean; addEventListener?: unknown } | null;
}

export interface LockInfo {
  name: string;
  mode: LockMode;
  clientId: string;
}

interface HeldLock extends LockInfo {
  /** Steal breaks a held lock: drop it AND reject its request promise. */
  breakLock(reason: unknown): void;
}

interface PendingRequest {
  name: string;
  mode: LockMode;
  clientId: string;
  ifAvailable: boolean;
  steal: boolean;
  signal: PendingSignal | null;
  grant: (lock: Lock | null) => void;
}

interface PendingSignal {
  aborted: boolean;
  reason?: unknown;
  addEventListener?: (type: string, fn: () => void) => void;
  removeEventListener?: (type: string, fn: () => void) => void;
}

const ABORT_ERROR_NAME = "AbortError";

function abortError(): Error {
  const e = new Error("The lock request was aborted");
  e.name = ABORT_ERROR_NAME;
  return e;
}

function notSupported(msg: string): DOMException {
  return new DOMException(msg, "NotSupportedError");
}

/**
 * The `Lock` interface — what the request callback receives. `name` and
 * `mode` echo the request; a failed `ifAvailable` request gets `null`.
 */
export class Lock {
  readonly #name: string;
  readonly #mode: LockMode;
  constructor(name: string, mode: LockMode) {
    this.#name = name;
    this.#mode = mode;
  }
  get name(): string { return this.#name; }
  get mode(): LockMode { return this.#mode; }
}

let clientCounter = 0;

export class LockManager {
  readonly #clientId = `client-${++clientCounter}-${Math.random().toString(36).slice(2)}`;
  readonly #held: HeldLock[] = [];
  readonly #pending: PendingRequest[] = [];

  get clientId(): string {
    return this.#clientId;
  }

  /**
   * `navigator.locks.request(name, [options], callback)`: queues a lock
   * request; resolves with the callback's return value once the callback
   * settles. Rejects immediately if the options are malformed, with
   * `AbortError` when `signal` aborts a still-pending request, and never
   * grants twice for one request.
   */
  request(
    name: unknown,
    optionsOrCallback?: LockRequestOptions | ((lock: Lock | null) => unknown),
    maybeCallback?: (lock: Lock | null) => unknown,
  ): Promise<unknown> {
    const lockName = String(name);
    let options: LockRequestOptions = {};
    let callback = maybeCallback;
    if (typeof optionsOrCallback === "function") {
      callback = optionsOrCallback;
    } else if (optionsOrCallback !== undefined && optionsOrCallback !== null) {
      options = optionsOrCallback;
    }
    if (typeof callback !== "function") {
      return Promise.reject(
        new TypeError("LockManager.request: callback argument is required"),
      );
    }
    const cb = callback;

    // WebIDL validation order (web-locks spec §request): name prefix, mode,
    // option combinations, then the signal's type and aborted state.
    if (lockName.startsWith("-")) {
      return Promise.reject(notSupported(`LockManager.request: resource name '${lockName}' must not start with '-'`));
    }
    const mode: LockMode = options.mode === "shared" ? "shared" : "exclusive";
    if (options.mode !== undefined && options.mode !== "exclusive" && options.mode !== "shared") {
      return Promise.reject(new TypeError(`LockManager.request: unsupported mode '${String(options.mode)}'`));
    }
    const ifAvailable = options.ifAvailable === true;
    const steal = options.steal === true;
    const signalRaw = options.signal ?? null;
    if (signalRaw !== null && !(signalRaw instanceof AbortSignal)) {
      return Promise.reject(new TypeError("LockManager.request: 'signal' must be an AbortSignal"));
    }
    const signal = signalRaw as PendingSignal | null;
    if (steal && ifAvailable) {
      return Promise.reject(notSupported("LockManager.request: 'steal' and 'ifAvailable' are mutually exclusive"));
    }
    if (steal && mode === "shared") {
      return Promise.reject(notSupported("LockManager.request: 'steal' requires mode 'exclusive'"));
    }
    if (signal !== null && steal) {
      return Promise.reject(notSupported("LockManager.request: 'signal' and 'steal' are mutually exclusive"));
    }
    if (signal !== null && ifAvailable) {
      return Promise.reject(notSupported("LockManager.request: 'signal' and 'ifAvailable' are mutually exclusive"));
    }
    if (signal !== null && signal.aborted) {
      // An already-aborted signal rejects with the signal's own reason —
      // a custom value or the default AbortError DOMException.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- abort reason is arbitrary
      return Promise.reject(signal.reason ?? abortError());
    }

    return new Promise<unknown>((resolve, reject) => {
      const runCallback = (lock: Lock | null): void => {
        if (lock === null) {
          // ifAvailable miss: the callback runs anyway with null.
          let result: unknown;
          try {
            result = cb(null);
          } catch (e) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- spec rejects verbatim
            reject(e);
            return;
          }
          Promise.resolve(result).then(resolve, reject);
          return;
        }
        const held: HeldLock = {
          name: lockName,
          mode,
          clientId: this.#clientId,
          breakLock: (reason: unknown) => {
            // Steal-time break: drop WITHOUT pumping the queue — the steal
            // request itself must win the freed slot, not the pending line.
            const idx = this.#held.indexOf(held);
            if (idx !== -1) this.#held.splice(idx, 1);
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- break reason is arbitrary
            reject(reason);
          },
        };
        // Register before invoking the callback: a synchronous query() inside
        // the callback must observe its own lock as held.
        this.#held.push(held);
        let result: unknown;
        try {
          result = cb(lock);
        } catch (e) {
          this.#dropHeld(held);
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- spec rejects verbatim
          reject(e);
          return;
        }
        Promise.resolve(result)
          .then(
            (v) => {
              this.#dropHeld(held);
              resolve(v);
            },
            (e) => {
              this.#dropHeld(held);
              // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- spec rejects verbatim
              reject(e);
            },
          );
      };

      const pending: PendingRequest = {
        name: lockName,
        mode,
        clientId: this.#clientId,
        ifAvailable,
        steal,
        signal,
        grant: (lock) => runCallback(lock),
      };

      const onAbort = (): void => {
        const idx = this.#pending.indexOf(pending);
        if (idx !== -1) {
          this.#pending.splice(idx, 1);
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- abort reason is arbitrary
          reject(signal?.reason ?? abortError());
        }
      };
      if (signal !== null && typeof signal.addEventListener === "function") {
        signal.addEventListener("abort", onAbort);
      }

      if (steal) {
        // Steal: break every held lock of this name — their request promises
        // reject with AbortError — then grant immediately, cutting the line
        // ahead of any pending requests.
        for (const h of [...this.#held]) {
          if (h.name === lockName) h.breakLock(abortError());
        }
        runCallback(new Lock(lockName, mode));
        return;
      }

      // Grant processing is asynchronous (spec: requests queue, then a
      // microtask pumps the queue). A synchronous signal.abort() right after
      // request() must still preempt an otherwise-grantable request.
      this.#pending.push(pending);
      queueMicrotask(() => this.#pumpQueue());
    }).then((v) => v);
  }

  /** `navigator.locks.query()` — snapshot of held and pending locks. The
   *  grant pump runs first: per spec the queue is processed in a task, so by
   *  the time script can observe state, grantable requests have been
   *  granted. */
  query(): Promise<{ held: LockInfo[]; pending: LockInfo[] }> {
    this.#pumpQueue();
    return Promise.resolve({
      held: this.#held.map(({ name, mode, clientId }) => ({ name, mode, clientId })),
      pending: this.#pending.map(({ name, mode, clientId }) => ({ name, mode, clientId })),
    });
  }

  #dropHeld(held: HeldLock): void {
    const idx = this.#held.indexOf(held);
    if (idx !== -1) this.#held.splice(idx, 1);
    this.#pumpQueue();
  }

  #compatible(name: string, mode: LockMode): boolean {
    for (const h of this.#held) {
      if (h.name !== name) continue;
      if (h.mode === "exclusive" || mode === "exclusive") return false;
    }
    return true;
  }

  /** Earlier pending requests for the same name block later ones (FIFO). */
  #blockedByPending(request: PendingRequest): boolean {
    for (const p of this.#pending) {
      if (p === request) return false;
      if (p.name !== request.name) continue;
      if (p.mode === "exclusive" || request.mode === "exclusive") return true;
    }
    return false;
  }

  #grantable(request: PendingRequest): boolean {
    return this.#compatible(request.name, request.mode) && !this.#blockedByPending(request);
  }

  #pumpQueue(): void {
    // Grant every newly-grantable request in FIFO order; a non-grantable
    // ifAvailable request resolves immediately with a null lock.
    for (const p of [...this.#pending]) {
      if (this.#grantable(p)) {
        this.#pending.splice(this.#pending.indexOf(p), 1);
        p.grant(new Lock(p.name, p.mode));
      } else if (p.ifAvailable) {
        this.#pending.splice(this.#pending.indexOf(p), 1);
        p.grant(null);
      }
    }
  }
}
