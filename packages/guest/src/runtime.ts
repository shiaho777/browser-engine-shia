/**
 * The V8 guest runtime: execute guest JavaScript through the embedded V8 engine,
 * across the kernel/guest boundary (task 7.6; design.md §3.1.F, §10, §11;
 * Requirements 16.3, 16.4, 8.1).
 *
 * ## Reuse boundary (Requirement 8.1, design.md §11)
 *
 * The engine does NOT implement a JavaScript engine — that is the canonical
 * "reuse the unavoidable hard infrastructure" case. We run on Node, which embeds
 * **V8**, and reuse it through Node's built-in `node:vm` module to create a V8
 * context (a fresh global object backed by the same V8 isolate) into which guest
 * code is compiled and run. Swapping this for a dedicated V8 isolate binding
 * (e.g. an out-of-process isolate) changes only this file; the boundary and
 * surface construction are unaffected.
 *
 * ## Kernel/guest boundary (Requirement 16.3, design.md §10)
 *
 * Guest code is executed across the kernel/guest boundary: the global object the
 * guest sees is assembled from EXACTLY the generated DOM surface
 * (`buildGuestGlobal`, see `./guest-global.ts`) plus the minimal JS scheduling
 * hooks (`queueMicrotask`, `setTimeout`, `Promise` — provided by V8 itself) and
 * NOTHING engine-internal. The module-private `INTERNAL` symbol and every
 * engine handle remain unreachable: they are never placed on the guest global,
 * and `vm` runs the code in a context whose global is the surface object we
 * built, so the guest cannot reach Node's `require`, `process`, or the engine's
 * own module scope.
 *
 * ## Event loop (Requirement 16.4)
 *
 * The runtime owns an {@link EventLoop}. `queueMicrotask` and `setTimeout` are
 * injected into the guest global and route to the loop's microtask / macrotask
 * queues, so guest-scheduled work runs with web-accurate ordering (microtasks
 * drained to empty between macrotasks). To make Promise reactions land on the
 * SAME loop, the runtime drives V8's microtask checkpoint from the loop: after
 * each step it runs `microtaskCheckpoint`, which flushes V8's native
 * Promise-reaction queue, then the loop's own microtask queue.
 *
 * Unimplemented paths throw {@link NotImplemented} rather than returning a
 * placeholder (design.md §12; Requirement 5.1) — there are no silent stubs here.
 */
import vm from "node:vm";

import { NotImplemented } from "@browser-engine/ir";

import { EventLoop } from "./event-loop.js";
import { createGuestFetch } from "./fetch.js";
import { buildGuestGlobal, type GuestGlobalOptions } from "./guest-global.js";
import { nodeFetchNetworkStack, type NetworkStack } from "./network.js";

/** Options for constructing a {@link GuestRuntime}. */
export interface GuestRuntimeOptions extends GuestGlobalOptions {
  /**
   * A hook V8 calls to flush its NATIVE microtask queue (Promise reactions).
   * Defaults to {@link defaultMicrotaskCheckpoint}, which uses the V8 context's
   * own job queue. Injectable so tests can observe/override checkpoint timing.
   */
  readonly microtaskCheckpoint?: () => void;
  /**
   * The reused networking stack guest `fetch` issues requests through
   * (Requirement 16.5, 8.1). Defaults to {@link nodeFetchNetworkStack} (the
   * reused undici/TLS stack via Node's global `fetch`); injectable so tests can
   * supply a deterministic stack without real network I/O.
   */
  readonly networkStack?: NetworkStack;
}

/** The result of running a guest script. */
export interface RunResult {
  /** The script's completion value (the value of its last expression). */
  readonly value: unknown;
}

/**
 * A V8-backed guest JavaScript runtime. Compiles and runs guest code in a `vm`
 * context whose global is the generated DOM surface plus JS scheduling hooks,
 * and drives an {@link EventLoop} with microtask scheduling.
 */
export class GuestRuntime {
  /** The event loop microtasks/macrotasks are scheduled on (Requirement 16.4). */
  readonly #loop: EventLoop;
  /** The V8 context object (the guest's `globalThis`), built across the boundary. */
  readonly #context: vm.Context;
  /** Flush V8's native Promise-reaction queue onto our checkpoint. */
  readonly #v8Checkpoint: () => void;
  /** Count of in-flight network requests, so {@link settle} knows to keep waiting. */
  #inFlight = 0;

  constructor(options: GuestRuntimeOptions = {}) {
    this.#loop = new EventLoop();

    // Build the guest global from EXACTLY the generated surface + scheduling
    // hooks routed to our loop. No engine-internal handle is placed here, so the
    // guest cannot reach kernel state (design.md §10; Requirement 16.3).
    const globalObject = buildGuestGlobal(options);
    globalObject["queueMicrotask"] = (callback: unknown): void => {
      assertCallable(callback, "queueMicrotask");
      this.#loop.queueMicrotask(() => (callback as () => void)());
    };
    globalObject["setTimeout"] = (callback: unknown, delay: unknown): void => {
      assertCallable(callback, "setTimeout");
      this.#loop.setTimer(() => (callback as () => void)(), toDelay(delay));
    };

    // Guest `fetch` over the reused networking stack (task 7.7; Requirement
    // 16.5, 8.1). This REPLACES the v0 hard-coded-404 stub: it issues a real
    // request through the stack. We wrap the stack to TRACK in-flight requests
    // so the async {@link settle} driver knows to keep yielding to the host
    // loop until the genuinely-asynchronous network work completes. The fetch
    // function holds no engine-internal handle, so it is safe on the guest
    // global.
    const networkStack = options.networkStack ?? nodeFetchNetworkStack;
    const trackedStack: NetworkStack = {
      request: async (req) => {
        this.#inFlight += 1;
        try {
          return await networkStack.request(req);
        } finally {
          this.#inFlight -= 1;
        }
      },
    };
    globalObject["fetch"] = createGuestFetch(trackedStack);

    // `vm.createContext` turns the surface object into a V8 context global,
    // backed by the same V8 isolate Node runs on (the reused JS engine —
    // Requirement 8.1). Promise / queueMicrotask semantics come from V8 itself.
    // `microtaskMode: "afterEvaluate"` gives this context its OWN microtask
    // queue that V8 drains to empty after every evaluation in the context — so
    // the checkpoint below (and the initial evaluate) flush Promise reactions
    // deterministically and synchronously, on demand, rather than waiting for
    // Node's own loop tick (Requirement 16.4).
    this.#context = vm.createContext(globalObject, {
      name: "guest",
      microtaskMode: "afterEvaluate",
      codeGeneration: { strings: true, wasm: false },
    });

    this.#v8Checkpoint = options.microtaskCheckpoint ?? defaultMicrotaskCheckpoint(this.#context);
  }

  /** The event loop this runtime schedules guest work on (read-only handle). */
  get loop(): EventLoop {
    return this.#loop;
  }

  /**
   * Compile and run `source` as a guest script in the V8 context, returning its
   * completion value. Synchronous top-level execution only — asynchronous
   * continuations (Promise reactions, timers) are scheduled on the loop and run
   * by {@link runEventLoop}.
   *
   * @throws SyntaxError if `source` does not compile (surfaced from V8).
   */
  evaluate(source: string): RunResult {
    const script = new vm.Script(source, { filename: "guest.js" });
    const value: unknown = script.runInContext(this.#context);
    return { value };
  }

  /**
   * Run the event loop to quiescence (Requirement 16.4): repeatedly flush V8's
   * native microtask checkpoint (Promise reactions) and the loop's own microtask
   * queue between macrotasks, until no work remains. Call after {@link evaluate}
   * to let scheduled guest continuations complete.
   */
  runEventLoop(): void {
    // Bridge V8's native Promise-reaction queue into the loop's microtask drain:
    // before each loop microtask drain, flush V8's checkpoint so reactions are
    // observed on the SAME loop step.
    const drainAll = (): void => {
      this.#v8Checkpoint();
      this.#loop.drainMicrotasks();
    };
    drainAll();
    while (this.#loop.hasPending) {
      this.#loop.run();
      drainAll();
      if (!this.#loop.hasPending) {
        break;
      }
    }
  }

  /**
   * Convenience: evaluate `source` then run the event loop to quiescence, so a
   * script using Promises/timers completes before this returns. Returns the
   * synchronous completion value of the script.
   */
  run(source: string): RunResult {
    const result = this.evaluate(source);
    this.runEventLoop();
    return result;
  }

  /**
   * Drive the runtime to quiescence INCLUDING genuinely-asynchronous network
   * work (Requirement 16.4, 16.5). Whereas {@link runEventLoop} is synchronous
   * (it cannot advance a real `fetch`, whose bytes arrive on a future host
   * tick), `settle` yields to the HOST event loop between microtask checkpoints
   * so the reused networking stack can make progress, then flushes V8's
   * Promise-reaction queue and the loop again.
   *
   * Termination: cross-realm Promise chains (a guest `await fetch()` then
   * `await response.text()`) settle over SEVERAL host ticks — a host microtask
   * resolves the guest-visible promise, whose guest reaction schedules the next
   * await, and so on. So `settle` does not stop the instant nothing is in
   * flight; it requires a short STREAK of fully-quiet host ticks (no loop work,
   * no in-flight request, and no guest reaction produced) so trailing
   * already-resolved host-promise chains flush before returning.
   *
   * This is the driver to `await` after `evaluate` when guest code uses `fetch`
   * (or any host-Promise-backed API): it bridges the guest realm's microtask
   * queue with the host's so cross-realm Promise adoption completes.
   *
   * @param maxTurns a safety bound on host-yield turns to avoid hanging on a
   *   never-settling request. Defaults to 10000.
   */
  async settle(maxTurns = 10_000): Promise<void> {
    const drainAll = (): void => {
      this.#v8Checkpoint();
      this.#loop.drainMicrotasks();
    };
    /** Host ticks with no observable work needed before declaring quiescence. */
    const QUIET_STREAK = 3;
    let quiet = 0;
    let turns = 0;
    drainAll();
    while (quiet < QUIET_STREAK) {
      if (turns++ >= maxTurns) {
        throw new Error(`GuestRuntime.settle exceeded ${maxTurns} turns (a request never settled)`);
      }
      const busy = this.#loop.hasPending || this.#inFlight > 0;
      if (this.#loop.hasPending) {
        this.#loop.run();
      }
      // Yield to the HOST loop so real network I/O / cross-realm Promise
      // adoption can advance, then re-flush the guest realm's reactions.
      await hostTick();
      drainAll();
      // A turn counts toward quiescence only if nothing was busy at its start
      // and nothing became pending while it ran.
      quiet = busy || this.#loop.hasPending || this.#inFlight > 0 ? 0 : quiet + 1;
    }
  }

  /**
   * Convenience: evaluate `source`, then `settle` the runtime (driving network
   * work to completion). Returns the synchronous completion value of the script.
   */
  async runAsync(source: string): Promise<RunResult> {
    const result = this.evaluate(source);
    await this.settle();
    return result;
  }
}

/** Yield one turn to the HOST event loop (lets real I/O / host Promises advance). */
function hostTick(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * The default V8 microtask checkpoint: run a no-op script in the context, which
 * causes V8 to perform a microtask checkpoint (flushing pending Promise
 * reactions) on return. `vm` contexts use V8's default microtask policy, so
 * touching the context after scheduling reactions drains them deterministically.
 */
function defaultMicrotaskCheckpoint(context: vm.Context): () => void {
  const checkpoint = new vm.Script("void 0", { filename: "microtask-checkpoint.js" });
  return () => {
    checkpoint.runInContext(context);
  };
}

/** Coerce a guest-provided delay argument to a non-negative integer (default 0). */
function toDelay(delay: unknown): number {
  if (typeof delay === "number" && Number.isFinite(delay)) {
    return Math.max(0, Math.floor(delay));
  }
  return 0;
}

/** Assert a guest-provided argument is callable, else fail loudly (no silent no-op). */
function assertCallable(value: unknown, api: string): void {
  if (typeof value !== "function") {
    throw new NotImplemented(`event-loop:${api}`, {
      category: "dom-api",
      detail: `${api} requires a function argument; non-callable schedulers are not supported`,
    });
  }
}
