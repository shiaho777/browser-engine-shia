/**
 * The event loop with microtask scheduling (task 7.6; design.md §3.1.F, §11;
 * Requirement 16.4 — "THE Engine SHALL provide an event loop with microtask
 * scheduling").
 *
 * Browsers run guest work on a single-threaded event loop: a queue of
 * **macrotasks** (timers, events, the initial script), and a **microtask** queue
 * (Promise reactions, queueMicrotask) that is drained to EMPTY after each
 * macrotask — and after the currently-running synchronous step — before the next
 * macrotask runs. This module implements exactly that ordering discipline so the
 * V8 guest runtime (`./runtime.ts`) can schedule Promise reactions and timers
 * with web-accurate semantics, without depending on Node's own loop tick timing.
 *
 * Why a self-built loop rather than leaning on Node's: the engine must control
 * the *interleaving* (microtasks fully drained between macrotasks) determinist  *
 * ically and synchronously for tests and for the differential harness. Node's
 * loop reuses V8's microtask checkpoint, but the engine's macrotask scheduling
 * (DOM events, timers) is the engine's own concern (the "脏活" boundary in §11
 * is JS *execution*, not task scheduling). The loop holds no engine-internal
 * handle, so it lives outside the kernel/guest isolation surface.
 *
 * Ordering guarantees (the invariants the tests pin):
 *   1. Microtasks run in FIFO order.
 *   2. The microtask queue is drained to empty before the next macrotask.
 *   3. A microtask enqueued by a microtask runs in the SAME drain (still before
 *      the next macrotask).
 *   4. Macrotasks run in FIFO order, each followed by a full microtask drain.
 */

/** A unit of work scheduled on the loop. */
export type Task = () => void;

/**
 * A single-threaded event loop with a macrotask queue and a microtask queue.
 *
 * The loop is explicitly driven (`run` / `drainMicrotasks`) rather than tied to
 * wall-clock time, so scheduling is deterministic and synchronously testable.
 * Timers are modelled as macrotasks ordered by their requested delay then
 * insertion order (a stable monotonic clock), which is enough for web-accurate
 * task/microtask interleaving without real time.
 */
export class EventLoop {
  /** FIFO macrotask queue (events, the initial script, fired timers). */
  readonly #macrotasks: Task[] = [];
  /** FIFO microtask queue (Promise reactions, queueMicrotask callbacks). */
  readonly #microtasks: Task[] = [];
  /** Pending timers, each with a due time and stable insertion order. */
  readonly #timers: { readonly due: number; readonly seq: number; readonly task: Task }[] = [];
  /** A logical clock advanced as timers fire (no dependency on real time). */
  #clock = 0;
  /** Monotonic sequence for stable ordering of equal-delay timers. */
  #seq = 0;
  /** Guard so a re-entrant `run()` cannot interleave two drains. */
  #running = false;

  /** Schedule a macrotask to run after the current step + microtask drain. */
  queueMacrotask(task: Task): void {
    this.#macrotasks.push(task);
  }

  /** Schedule a microtask; it runs in the current drain (before the next macrotask). */
  queueMicrotask(task: Task): void {
    this.#microtasks.push(task);
  }

  /**
   * Schedule a timer macrotask after `delayMs` logical milliseconds. Timers fire
   * in due-time order; equal due times preserve insertion order. Returns nothing
   * (cancellation is out of scope for this minimal loop).
   */
  setTimer(task: Task, delayMs = 0): void {
    const delay = Math.max(0, Math.floor(delayMs));
    this.#timers.push({ due: this.#clock + delay, seq: this.#seq++, task });
  }

  /** Whether any work (macrotask, microtask, or timer) remains. */
  get hasPending(): boolean {
    return (
      this.#macrotasks.length > 0 ||
      this.#microtasks.length > 0 ||
      this.#timers.length > 0
    );
  }

  /**
   * Drain the microtask queue to EMPTY, running microtasks in FIFO order. A
   * microtask that enqueues another microtask extends the SAME drain (the new
   * one runs before this method returns) — matching the web's "checkpoint"
   * semantics.
   */
  drainMicrotasks(): void {
    while (this.#microtasks.length > 0) {
      const task = this.#microtasks.shift() as Task;
      task();
    }
  }

  /**
   * Run the loop to quiescence: drain microtasks, then repeatedly take the next
   * macrotask (a queued macrotask first, else the earliest-due timer), run it,
   * and drain microtasks again — until nothing is pending. This is the canonical
   * "run a macrotask, then empty the microtask queue" cycle.
   *
   * @param maxSteps a safety bound on macrotask iterations to avoid a runaway
   *   loop (a macrotask that perpetually reschedules itself). Defaults to 100000.
   */
  run(maxSteps = 100_000): void {
    if (this.#running) {
      return; // re-entrant run() is a no-op; the outer run owns the drain.
    }
    this.#running = true;
    try {
      // An initial microtask checkpoint (the web drains microtasks before the
      // first macrotask boundary too).
      this.drainMicrotasks();
      let steps = 0;
      while (this.hasPending) {
        if (steps++ >= maxSteps) {
          throw new Error(`EventLoop.run exceeded ${maxSteps} steps (possible runaway task)`);
        }
        const next = this.#takeNextMacrotask();
        if (next === null) {
          break; // only microtasks remained; already drained above/below.
        }
        next();
        this.drainMicrotasks();
      }
    } finally {
      this.#running = false;
    }
  }

  /**
   * Take the next macrotask to run: a queued macrotask (FIFO) takes priority
   * over timers; otherwise the earliest-due timer fires (advancing the logical
   * clock to its due time). Returns `null` when neither queue has work.
   */
  #takeNextMacrotask(): Task | null {
    if (this.#macrotasks.length > 0) {
      return this.#macrotasks.shift() as Task;
    }
    if (this.#timers.length === 0) {
      return null;
    }
    // Find the earliest-due timer (ties broken by insertion sequence).
    let bestIndex = 0;
    for (let i = 1; i < this.#timers.length; i += 1) {
      const a = this.#timers[i]!;
      const b = this.#timers[bestIndex]!;
      if (a.due < b.due || (a.due === b.due && a.seq < b.seq)) {
        bestIndex = i;
      }
    }
    const [timer] = this.#timers.splice(bestIndex, 1);
    this.#clock = Math.max(this.#clock, timer!.due); // advance the logical clock.
    return timer!.task;
  }
}
