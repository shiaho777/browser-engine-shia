/**
 * mutation-observer.ts — a real MutationObserver (DOM Standard §mutation-observers).
 *
 * The previous sandbox global was a dead stub that never called back — a
 * constitution violation ("no silent stubs"). This controller implements the
 * spec algorithm ("queue a mutation record") with NO engine dependencies: the
 * FineSession reports raw mutations (NodeId-level), this module decides which
 * registered observers are interested, batches records per observer, and
 * delivers them through an injected `queueMicrotask` (the sandbox's real
 * microtask, so ordering matches a browser).
 *
 * Algorithm (mirrors DOM Standard and Ladybird's Node::queue_mutation_record):
 *   1. walk the inclusive ancestors of the mutation target;
 *   2. for each registered observer on each ancestor, apply the options filter
 *      (subtree / attributes / attributeFilter / characterData / childList);
 *   3. collect interested observers, mapping oldValue per observer (an
 *      observer only receives oldValue if it asked for it);
 *   4. enqueue a record per interested observer and mark it pending;
 *   5. queue ONE microtask: drain each pending observer's record queue and
 *      invoke its callback (records, observer).
 */

/** The subtree relationship the controller needs; injected to stay engine-free. */
export type ParentOf = (id: number) => number | null;

/** Raw mutation reported by the engine (NodeId-level, pre-wrapping). */
export interface RawMutation {
  readonly kind: "attributes" | "characterData" | "childList";
  readonly target: number;
  readonly attributeName?: string | undefined;
  readonly attributeNamespace?: string | null | undefined;
  readonly oldValue?: string | null | undefined;
  readonly added?: readonly number[] | undefined;
  readonly removed?: readonly number[] | undefined;
  readonly previousSibling?: number | null | undefined;
  readonly nextSibling?: number | null | undefined;
}

/** Observer options per DOM Standard `MutationObserverInit`. */
export interface ObserverOptions {
  readonly childList?: boolean | undefined;
  readonly attributes?: boolean | undefined;
  readonly characterData?: boolean | undefined;
  readonly subtree?: boolean | undefined;
  readonly attributeOldValue?: boolean | undefined;
  readonly characterDataOldValue?: boolean | undefined;
  readonly attributeFilter?: readonly string[] | undefined;
}

/** Options after observe()-time defaulting (no undefined members). */
interface NormalizedOptions {
  readonly childList: boolean;
  readonly attributes: boolean;
  readonly characterData: boolean;
  readonly subtree: boolean;
  readonly attributeOldValue: boolean;
  readonly characterDataOldValue: boolean;
  readonly attributeFilter: readonly string[];
}

interface RegisteredObserver {
  readonly observer: unknown;
  readonly target: number;
  readonly options: NormalizedOptions;
}

/** A queued record before delivery; NodeIds wrapped by the caller at delivery. */
export interface QueuedRecord {
  readonly type: "attributes" | "characterData" | "childList";
  readonly target: number;
  readonly addedNodes: readonly number[];
  readonly removedNodes: readonly number[];
  readonly previousSibling: number | null;
  readonly nextSibling: number | null;
  readonly attributeName: string | null;
  readonly attributeNamespace: string | null;
  readonly oldValue: string | null;
}

type Callback = (records: readonly QueuedRecord[], observer: unknown) => void;

export class MutationObserverController {
  /** target NodeId → registrations on that exact node. */
  readonly #byTarget = new Map<number, RegisteredObserver[]>();
  /** observer → its record queue. */
  readonly #queues = new Map<unknown, QueuedRecord[]>();
  readonly #callbacks = new Map<unknown, Callback>();
  readonly #parentOf: ParentOf;
  readonly #queueMicrotask: (fn: () => void) => void;
  #microtaskQueued = false;
  /** observers pending delivery, in registration order (spec: per-agent list). */
  readonly #pending: unknown[] = [];

  constructor(parentOf: ParentOf, queueMicrotask: (fn: () => void) => void) {
    this.#parentOf = parentOf;
    this.#queueMicrotask = queueMicrotask;
  }

  /** Register `observer` (with `callback`) on `target` per DOM Standard. */
  observe(observer: unknown, callback: Callback, target: number, options: ObserverOptions): void {
    this.#callbacks.set(observer, callback);
    // DOM Standard observe() defaults: attributeOldValue/attributeFilter imply
    // attributes; characterDataOldValue implies characterData — but ONLY when
    // the base flag is omitted (??), so an explicit `false` wins.
    const opts: NormalizedOptions = {
      childList: options.childList ?? false,
      subtree: options.subtree ?? false,
      attributeOldValue: options.attributeOldValue ?? false,
      characterDataOldValue: options.characterDataOldValue ?? false,
      attributes:
        options.attributes ??
        (options.attributeOldValue === true || options.attributeFilter !== undefined),
      characterData: options.characterData ?? options.characterDataOldValue === true,
      attributeFilter: options.attributeFilter ?? [],
    };

    const list = this.#byTarget.get(target) ?? [];
    // Replace an existing registration for the same observer (spec behavior).
    const next = list.filter((r) => r.observer !== observer);
    next.push({ observer, target, options: opts });
    this.#byTarget.set(target, next);
    if (!this.#queues.has(observer)) this.#queues.set(observer, []);
  }

  disconnect(observer: unknown): void {
    for (const [target, list] of this.#byTarget) {
      const next = list.filter((r) => r.observer !== observer);
      if (next.length === 0) this.#byTarget.delete(target);
      else this.#byTarget.set(target, next);
    }
    this.#queues.set(observer, []);
  }

  takeRecords(observer: unknown): readonly QueuedRecord[] {
    const queue = this.#queues.get(observer) ?? [];
    this.#queues.set(observer, []);
    return queue;
  }

  /** The DOM Standard "queue a mutation record" algorithm. */
  queueMutation(mutation: RawMutation): void {
    // 1-3. Collect interested observers up the inclusive ancestor chain,
    //      mapping oldValue per observer.
    const interested = new Map<unknown, string | null>();
    let node: number | null = mutation.target;
    while (node !== null) {
      const list = this.#byTarget.get(node);
      if (list !== undefined) {
        for (const registered of list) {
          const options = registered.options;
          const isTarget = node === mutation.target;
          if (!isTarget && !options.subtree) continue;
          if (mutation.kind === "attributes") {
            if (!options.attributes) continue;
            if (
              options.attributeFilter.length > 0 &&
              (mutation.attributeNamespace != null ||
                mutation.attributeName === undefined ||
                !options.attributeFilter.includes(mutation.attributeName))
            ) {
              continue;
            }
          }
          if (mutation.kind === "characterData" && !options.characterData) continue;
          if (mutation.kind === "childList" && !options.childList) continue;

          const observer = registered.observer;
          if (!interested.has(observer)) interested.set(observer, null);
          const wantsOldValue =
            (mutation.kind === "attributes" && options.attributeOldValue) ||
            (mutation.kind === "characterData" && options.characterDataOldValue);
          if (wantsOldValue) {
            interested.set(observer, mutation.oldValue ?? null);
          }
        }
      }
      node = this.#parentOf(node);
    }

    if (interested.size === 0) return; // zero-cost path when nobody listens.

    // 4. Enqueue a record per interested observer.
    for (const [observer, mappedOldValue] of interested) {
      const record: QueuedRecord = {
        type: mutation.kind,
        target: mutation.target,
        addedNodes: mutation.added ?? [],
        removedNodes: mutation.removed ?? [],
        previousSibling: mutation.previousSibling ?? null,
        nextSibling: mutation.nextSibling ?? null,
        attributeName: mutation.attributeName ?? null,
        attributeNamespace: mutation.attributeNamespace ?? null,
        oldValue: mappedOldValue,
      };
      const queue = this.#queues.get(observer);
      if (queue !== undefined) queue.push(record);
      if (!this.#pending.includes(observer)) this.#pending.push(observer);
    }

    // 5. Queue ONE microtask for the whole batch.
    if (this.#microtaskQueued) return;
    this.#microtaskQueued = true;
    this.#queueMicrotask(() => {
      this.#microtaskQueued = false;
      const pending = this.#pending.splice(0, this.#pending.length);
      for (const observer of pending) {
        const records = this.takeRecords(observer);
        if (records.length === 0) continue;
        const callback = this.#callbacks.get(observer);
        if (callback === undefined) continue;
        try {
          callback(records, observer);
        } catch {
          // Guest callback errors must not break the agent's microtask queue.
        }
      }
    });
  }
}
