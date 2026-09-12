/**
 * Channel messaging — MessageChannel / MessagePort / BroadcastChannel.
 *
 * Same-realm implementations over our own EventTarget/MessageEvent: a posted
 * message is queued on the microtask queue and delivered to the entangled
 * port (MessageChannel) or every other open channel with the same name
 * (BroadcastChannel). Structured-clone validation rejects uncloneable values
 * (symbols, functions, untransferred ports) with DataCloneError.
 */
import { EventTarget, MessageEvent, type AddEventListenerOptions } from "./event-system.js";
import { DOMException } from "./abort.js";

/**
 * Minimal structured-clone validation (HTML §2.7): symbols and functions are
 * never cloneable; a MessagePort is only cloneable inside the transfer list.
 * Returns the list of transferred ports.
 */
function validateClonable(value: unknown, transfer: readonly MessagePort[], source: MessagePort | null, seen: Set<unknown>): void {
  if (typeof value === "symbol" || typeof value === "function") {
    throw new DOMException(
      "Failed to execute 'postMessage': the provided value could not be cloned.",
      "DataCloneError",
    );
  }
  if (value instanceof MessagePort) {
    if (source !== null && value === source) {
      throw new DOMException(
        "Failed to execute 'postMessage': the source port cannot be transferred or cloned.",
        "DataCloneError",
      );
    }
    if (!transfer.includes(value)) {
      throw new DOMException(
        "Failed to execute 'postMessage': a MessagePort must be transferred.",
        "DataCloneError",
      );
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const v of value) validateClonable(v, transfer, source, seen);
    } else {
      for (const v of Object.values(value)) validateClonable(v, transfer, source, seen);
    }
  }
}

function normalizeTransfer(second: unknown): readonly MessagePort[] {
  if (second === undefined || second === null) return [];
  const list = Array.isArray(second)
    ? second
    : typeof second === "object" && "transfer" in (second as object)
      ? (second as { transfer?: unknown }).transfer
      : undefined;
  if (!Array.isArray(list)) return [];
  for (const p of list) {
    if (!(p instanceof MessagePort)) {
      throw new DOMException(
        "Failed to execute 'postMessage': transfer list entries must be MessagePorts.",
        "DataCloneError",
      );
    }
  }
  return list as readonly MessagePort[];
}

/** A message port — one end of an entangled pair. */
export class MessagePort extends EventTarget {
  #other: MessagePort | null = null;
  #closed = false;
  #started = false;
  /** Messages posted to an unstarted port queue until start()/onmessage. */
  #pending: MessageEvent[] = [];
  #onmessage: ((e: MessageEvent) => void) | null = null;
  #onmessageerror: ((e: MessageEvent) => void) | null = null;

  /** @internal — ports are created by MessageChannel / transfer. */
  _entangle(other: MessagePort): void {
    this.#other = other;
  }

  /** @internal — true once close() has run. */
  get _closed(): boolean {
    return this.#closed;
  }

  postMessage(message?: unknown, transfer?: unknown): void {
    if (arguments.length === 0) {
      throw new TypeError("Failed to execute 'postMessage': 1 argument required, but only 0 present.");
    }
    const ports = normalizeTransfer(transfer);
    if (ports.includes(this)) {
      throw new DOMException(
        "Failed to execute 'postMessage': the source port cannot be in the transfer list.",
        "DataCloneError",
      );
    }
    validateClonable(message, ports, this, new Set());
    const target = this.#other;
    if (target === null || target.#closed) return; // disentangled/dead → drop
    for (const p of ports) {
      // Transferred ports arrive inside the delivered event's `ports`.
      p._entangle(target);
    }
    const event = new MessageEvent("message", {
      data: message,
      ports: ports.length > 0 ? [...ports] : [],
    });
    target.#deliver(event);
  }

  /** @internal — queue, then dispatch once the port has been started. */
  #deliver(event: MessageEvent): void {
    if (this.#closed) return;
    this.#pending.push(event);
    queueMicrotask(() => this.#flush());
  }

  #flush(): void {
    if (this.#closed || !this.#started) return;
    const events = this.#pending.splice(0);
    for (const event of events) this.dispatchEvent(event);
  }

  /** Event-handler IDL attributes behave as ordinary listeners. */
  get onmessage(): ((e: MessageEvent) => void) | null {
    return this.#onmessage;
  }

  set onmessage(fn: unknown) {
    if (this.#onmessage !== null) this.removeEventListener("message", this.#onmessage);
    this.#onmessage = typeof fn === "function" ? (fn as (e: MessageEvent) => void) : null;
    if (this.#onmessage !== null) {
      this.addEventListener("message", this.#onmessage);
      this.start();
    }
  }

  get onmessageerror(): ((e: MessageEvent) => void) | null {
    return this.#onmessageerror;
  }

  set onmessageerror(fn: unknown) {
    if (this.#onmessageerror !== null) this.removeEventListener("messageerror", this.#onmessageerror);
    this.#onmessageerror = typeof fn === "function" ? (fn as (e: MessageEvent) => void) : null;
    if (this.#onmessageerror !== null) this.addEventListener("messageerror", this.#onmessageerror);
  }

  override addEventListener(type: string, listener: unknown, options?: AddEventListenerOptions | boolean): void {
    super.addEventListener(type, listener, options);
    // Registering a message listener starts the port (HTML §9.3.2).
    if (type === "message") this.start();
  }

  start(): void {
    this.#started = true;
    this.#flush();
  }

  close(): void {
    this.#closed = true;
    this.#other = null;
  }
}

/** An entangled MessagePort pair. */
export class MessageChannel {
  readonly port1: MessagePort;
  readonly port2: MessagePort;

  constructor() {
    this.port1 = new MessagePort();
    this.port2 = new MessagePort();
    this.port1._entangle(this.port2);
    this.port2._entangle(this.port1);
  }
}

/**
 * BroadcastChannel with a PER-CLASS registry: each sandbox/realm builds its
 * own class via {@link makeBroadcastChannelClass} so channels never leak
 * across test files. Delivery follows registry insertion order — channels
 * receive messages in creation order, as the spec requires.
 */
export function makeBroadcastChannelClass(originOf: () => string): typeof BroadcastChannel {
  const registry = new Map<string, Set<BroadcastChannelImpl>>();

  class BroadcastChannelImpl extends EventTarget {
    readonly #name: string;
    #closed = false;
    #onmessage: ((e: MessageEvent) => void) | null = null;
    #onmessageerror: ((e: MessageEvent) => void) | null = null;

    constructor(name?: unknown) {
      super();
      if (arguments.length === 0) {
        throw new TypeError("Failed to construct 'BroadcastChannel': 1 argument required, but only 0 present.");
      }
      this.#name = String(name);
      let set = registry.get(this.#name);
      if (set === undefined) {
        set = new Set();
        registry.set(this.#name, set);
      }
      set.add(this);
    }

    get name(): string {
      return this.#name;
    }

    get onmessage(): ((e: MessageEvent) => void) | null {
      return this.#onmessage;
    }

    set onmessage(fn: unknown) {
      if (this.#onmessage !== null) this.removeEventListener("message", this.#onmessage);
      this.#onmessage = typeof fn === "function" ? (fn as (e: MessageEvent) => void) : null;
      if (this.#onmessage !== null) this.addEventListener("message", this.#onmessage);
    }

    get onmessageerror(): ((e: MessageEvent) => void) | null {
      return this.#onmessageerror;
    }

    set onmessageerror(fn: unknown) {
      if (this.#onmessageerror !== null) this.removeEventListener("messageerror", this.#onmessageerror);
      this.#onmessageerror = typeof fn === "function" ? (fn as (e: MessageEvent) => void) : null;
      if (this.#onmessageerror !== null) this.addEventListener("messageerror", this.#onmessageerror);
    }

    postMessage(message?: unknown): void {
      if (arguments.length === 0) {
        throw new TypeError("Failed to execute 'postMessage': 1 argument required, but only 0 present.");
      }
      if (this.#closed) {
        throw new DOMException(
          "Failed to execute 'postMessage': the BroadcastChannel is closed.",
          "InvalidStateError",
        );
      }
      validateClonable(message, [], null, new Set());
      for (const ch of registry.get(this.#name) ?? []) {
        if (ch === this || ch.#closed) continue;
        // A fresh event per channel — dispatch mutates `target`, and tests
        // retain events to check `.target` after all deliveries run.
        const event = new MessageEvent("message", { data: message, origin: originOf() });
        queueMicrotask(() => {
          if (!ch.#closed) ch.dispatchEvent(event);
        });
      }
    }

    close(): void {
      if (this.#closed) return;
      this.#closed = true;
      registry.get(this.#name)?.delete(this);
    }
  }

  return BroadcastChannelImpl as unknown as typeof BroadcastChannel;
}

/** Nominal type exposed for the factory's return signature. */
export declare class BroadcastChannel extends EventTarget {
  constructor(name: string);
  readonly name: string;
  onmessage: ((e: MessageEvent) => void) | null;
  onmessageerror: ((e: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
  close(): void;
}
