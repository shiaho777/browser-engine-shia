/**
 * event-loop.ts — a deterministic event loop + async networking for real JS
 * (#4: the event-loop / network half of "be a real browser").
 *
 * The browser event loop is microtasks (promise reactions, `queueMicrotask`)
 * drained to empty after each macrotask, and macrotasks (timers) ordered by due
 * time. This module models exactly that on a VIRTUAL CLOCK so it is fully
 * deterministic and testable: real JavaScript (V8 via `node:vm`) schedules work
 * through `setTimeout` / `queueMicrotask` / `fetch`, those callbacks mutate the
 * live {@link FineSession} DOM, and {@link EventDrivenRun} drains the loop to a
 * fixed point — exactly the ordering a browser guarantees (all microtasks
 * before the next timer).
 *
 * Networking is an injected, deterministic resolver (a `url → body` map — the
 * same shape the resource loader uses), surfaced to scripts as a `fetch()`
 * returning a thenable `Response` with `.text()`. No real sockets: the resolver
 * is the seam where a real transport would plug in. The async DATA FLOW
 * (fetch → promise reaction → DOM mutation → re-render) is real and ordered.
 */
import vm from "node:vm";

import { FineSession } from "./fine.js";
import { buildDocumentApi } from "./script.js";
import { defaultFetch, type FetchFn } from "./loader.js";

/** The outcome of an event-driven run: work performed + DOM mutations. */
export interface EventDrivenRun {
  /** Microtasks drained. */
  readonly microtasks: number;
  /** Timer callbacks fired. */
  readonly timers: number;
  /** Animation frames flushed (`requestAnimationFrame` callbacks). */
  readonly frames: number;
  /** DOM mutations performed across the whole run. */
  readonly mutations: number;
  /** A top-level error from the initial synchronous script, if any. */
  readonly error: string | null;
}

/** A minimal Promise-shaped thenable scheduled on the virtual loop's microtasks. */
class Thenable<T> {
  #value: T | undefined;
  #settled = false;
  readonly #cbs: ((v: T) => void)[] = [];
  constructor(private readonly loop: VirtualEventLoop) {}

  resolve(value: T): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#value = value;
    for (const cb of this.#cbs) this.loop.microtask(() => cb(value));
    this.#cbs.length = 0;
  }

  then(onFulfilled: (v: T) => unknown): Thenable<unknown> {
    const next = new Thenable<unknown>(this.loop);
    const run = (v: T): void => {
      const result = onFulfilled(v);
      if (result instanceof Thenable) {
        result.then((r) => next.resolve(r));
      } else {
        next.resolve(result);
      }
    };
    if (this.#settled) {
      this.loop.microtask(() => run(this.#value as T));
    } else {
      this.#cbs.push(run);
    }
    return next;
  }
}

interface Timer {
  readonly id: number;
  readonly due: number;
  readonly fn: () => void;
  cancelled: boolean;
}

/** A virtual-clock event loop: microtask FIFO + due-ordered macrotask timers. */
class VirtualEventLoop {
  readonly #microtasks: (() => void)[] = [];
  readonly #timers: Timer[] = [];
  #raf: { id: number; cb: (t: number) => void; cancelled: boolean }[] = [];
  #clock = 0;
  #nextTimerId = 1;
  #nextRafId = 1;
  #onFrame: ((now: number) => void) | undefined;
  #frameWork: (() => boolean) | undefined;
  microtaskCount = 0;
  timerCount = 0;
  frameCount = 0;

  /**
   * Register a per-frame HOOK driven by the same clock as `requestAnimationFrame`:
   * `onFrame(now)` runs at the start of every flushed frame (before the rAF
   * callbacks, matching the HTML "update the rendering" order), and `hasWork`
   * lets a frame be produced even when no rAF callback is queued (so a running
   * CSS animation keeps the clock ticking until it finishes).
   */
  onAnimationFrame(onFrame: (now: number) => void, hasWork: () => boolean): void {
    this.#onFrame = onFrame;
    this.#frameWork = hasWork;
  }

  microtask(fn: () => void): void {
    this.#microtasks.push(fn);
  }

  setTimeout(fn: () => void, delay: number): number {
    const id = this.#nextTimerId++;
    this.#timers.push({ id, due: this.#clock + Math.max(0, delay || 0), fn, cancelled: false });
    return id;
  }

  clearTimeout(id: number): void {
    const t = this.#timers.find((x) => x.id === id);
    if (t !== undefined) t.cancelled = true;
  }

  requestAnimationFrame(cb: (t: number) => void): number {
    const id = this.#nextRafId++;
    this.#raf.push({ id, cb, cancelled: false });
    return id;
  }

  cancelAnimationFrame(id: number): void {
    const r = this.#raf.find((x) => x.id === id);
    if (r !== undefined) r.cancelled = true;
  }

  /** Make a fresh loop-bound {@link Thenable}. */
  deferred<T>(): Thenable<T> {
    return new Thenable<T>(this);
  }

  /**
   * Drain microtasks, then either flush one ANIMATION FRAME (the queued
   * `requestAnimationFrame` callbacks, advancing the clock ~16ms) or fire the
   * earliest timer — repeating to a fixed point. The frame budget caps runaway
   * self-scheduling rAF loops (a real engine bounds them by wall-clock; we bound
   * by `maxFrames`).
   */
  drain(maxSteps = 100000, maxFrames = 1000): void {
    let steps = 0;
    for (;;) {
      while (this.#microtasks.length > 0) {
        if (steps++ > maxSteps) return;
        const fn = this.#microtasks.shift() as () => void;
        this.microtaskCount += 1;
        fn();
      }
      const frame = this.#raf.filter((r) => !r.cancelled);
      const pending = this.#timers.filter((t) => !t.cancelled);
      const animating = this.#frameWork?.() ?? false;
      // Flush a frame when a rAF callback is queued OR a CSS animation is still
      // running — either way the frame clock must advance ~16ms.
      if ((frame.length > 0 || animating) && this.frameCount < maxFrames) {
        this.#raf = [];
        this.#clock += 16;
        this.frameCount += 1;
        // "Update the rendering": sample animations FIRST, then run rAF callbacks.
        if (steps++ > maxSteps) return;
        this.#onFrame?.(this.#clock);
        for (const r of frame) {
          if (steps++ > maxSteps) return;
          r.cb(this.#clock);
        }
        continue;
      }
      if (pending.length === 0) return;
      // Fire the earliest-due timer (ties: insertion order via stable id).
      pending.sort((a, b) => (a.due !== b.due ? a.due - b.due : a.id - b.id));
      const next = pending[0] as Timer;
      next.cancelled = true;
      this.#clock = Math.max(this.#clock, next.due);
      this.timerCount += 1;
      if (steps++ > maxSteps) return;
      next.fn();
    }
  }
}

/**
 * Run `source` as real JavaScript against a document parsed from `html`, with a
 * deterministic event loop and an injected `fetch` resolver, then drain the loop
 * to completion. `resources` maps a URL to its response body text.
 */
export function runEventDriven(
  html: string,
  source: string,
  resources: ReadonlyMap<string, string> = new Map(),
): EventDrivenRun {
  const session = new FineSession(html);
  const { document, globals: domGlobals, mutations, tickAnimations, hasActiveAnimations } =
    buildDocumentApi(session);
  const loop = new VirtualEventLoop();
  loop.onAnimationFrame(tickAnimations, hasActiveAnimations);

  const fetchFn = (url: unknown): Thenable<object> => {
    const deferred = loop.deferred<object>();
    const body = resources.get(String(url));
    // Resolve on a microtask (network completion is always async).
    loop.microtask(() =>
      deferred.resolve({
        ok: body !== undefined,
        status: body !== undefined ? 200 : 404,
        text: (): Thenable<string> => {
          const t = loop.deferred<string>();
          loop.microtask(() => t.resolve(body ?? ""));
          return t;
        },
      }),
    );
    return deferred;
  };

  const sandbox: Record<string, unknown> = {
    document,
    ...domGlobals,
    setTimeout: (fn: unknown, delay: unknown) =>
      typeof fn === "function" ? loop.setTimeout(fn as () => void, Number(delay) || 0) : 0,
    clearTimeout: (id: unknown) => loop.clearTimeout(Number(id)),
    queueMicrotask: (fn: unknown) => {
      if (typeof fn === "function") loop.microtask(fn as () => void);
    },
    requestAnimationFrame: (fn: unknown) =>
      typeof fn === "function" ? loop.requestAnimationFrame(fn as (t: number) => void) : 0,
    cancelAnimationFrame: (id: unknown) => loop.cancelAnimationFrame(Number(id)),
    fetch: fetchFn,
  };
  sandbox["self"] = sandbox;
  sandbox["globalThis"] = sandbox;

  let error: string | null = null;
  try {
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { timeout: 2000 });
    loop.drain();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return {
    microtasks: loop.microtaskCount,
    timers: loop.timerCount,
    frames: loop.frameCount,
    mutations: mutations(),
    error,
  };
}

/**
 * Like {@link runEventDriven}, but `fetch` uses a REAL network transport
 * (`fetchFn`, defaulting to Node's global `fetch` — real HTTP/TLS via
 * {@link defaultFetch}). The run is async: it runs the script, drains the loop,
 * then awaits each in-flight real fetch and re-drains, repeating to a fixed
 * point — so genuine network completion drives promise reactions and DOM
 * mutations in the correct event-loop order. Tests inject a deterministic
 * `fetchFn`; production uses the real socket-backed default.
 */
export async function runEventDrivenReal(
  html: string,
  source: string,
  fetchFn: FetchFn = defaultFetch,
): Promise<EventDrivenRun> {
  const session = new FineSession(html);
  const { document, globals: domGlobals, mutations, tickAnimations, hasActiveAnimations } =
    buildDocumentApi(session);
  const loop = new VirtualEventLoop();
  loop.onAnimationFrame(tickAnimations, hasActiveAnimations);
  const decoder = new TextDecoder();
  const inflight = new Set<Promise<void>>();

  const fetchImpl = (url: unknown): Thenable<object> => {
    const deferred = loop.deferred<object>();
    const job = (async (): Promise<void> => {
      const bytes = await fetchFn(String(url));
      const ok = bytes !== undefined;
      const body = ok ? decoder.decode(bytes) : "";
      loop.microtask(() =>
        deferred.resolve({
          ok,
          status: ok ? 200 : 404,
          text: (): Thenable<string> => {
            const t = loop.deferred<string>();
            loop.microtask(() => t.resolve(body));
            return t;
          },
        }),
      );
    })();
    const tracked = job.finally(() => inflight.delete(tracked));
    inflight.add(tracked);
    return deferred;
  };

  const sandbox: Record<string, unknown> = {
    document,
    ...domGlobals,
    setTimeout: (fn: unknown, delay: unknown) =>
      typeof fn === "function" ? loop.setTimeout(fn as () => void, Number(delay) || 0) : 0,
    clearTimeout: (id: unknown) => loop.clearTimeout(Number(id)),
    queueMicrotask: (fn: unknown) => {
      if (typeof fn === "function") loop.microtask(fn as () => void);
    },
    requestAnimationFrame: (fn: unknown) =>
      typeof fn === "function" ? loop.requestAnimationFrame(fn as (t: number) => void) : 0,
    cancelAnimationFrame: (id: unknown) => loop.cancelAnimationFrame(Number(id)),
    fetch: fetchImpl,
  };
  sandbox["self"] = sandbox;
  sandbox["globalThis"] = sandbox;

  let error: string | null = null;
  try {
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { timeout: 2000 });
    loop.drain();
    // Await real network completions, re-draining after each wave (chained
    // fetches enqueue more in-flight jobs, so loop until quiescent).
    while (inflight.size > 0) {
      await Promise.all([...inflight]);
      loop.drain();
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return {
    microtasks: loop.microtaskCount,
    timers: loop.timerCount,
    frames: loop.frameCount,
    mutations: mutations(),
    error,
  };
}
