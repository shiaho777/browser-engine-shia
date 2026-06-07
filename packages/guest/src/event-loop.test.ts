/**
 * Tests for the event loop with microtask scheduling (task 7.6; design.md §3.1.F,
 * §11; Requirement 16.4).
 *
 * Built by `tsc` then run with: `node --test packages/guest/dist/*.test.js`.
 *
 * These pin the ordering discipline a browser event loop must obey:
 *   1. microtasks run FIFO;
 *   2. the microtask queue is drained to EMPTY before the next macrotask;
 *   3. a microtask enqueued by a microtask runs in the SAME drain;
 *   4. macrotasks run FIFO, each followed by a full microtask drain;
 *   5. timers fire in due-time order (with a deterministic logical clock).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { EventLoop } from "./event-loop.js";

void test("Req 16.4: microtasks run in FIFO order and drain to empty", () => {
  const loop = new EventLoop();
  const order: number[] = [];
  loop.queueMicrotask(() => order.push(1));
  loop.queueMicrotask(() => order.push(2));
  loop.queueMicrotask(() => order.push(3));
  loop.drainMicrotasks();
  assert.deepEqual(order, [1, 2, 3]);
  assert.equal(loop.hasPending, false);
});

void test("Req 16.4: a microtask enqueued by a microtask runs in the SAME drain", () => {
  const loop = new EventLoop();
  const order: string[] = [];
  loop.queueMicrotask(() => {
    order.push("a");
    loop.queueMicrotask(() => order.push("a.nested"));
  });
  loop.queueMicrotask(() => order.push("b"));
  loop.drainMicrotasks();
  // The nested microtask runs after b (FIFO) but still within this drain.
  assert.deepEqual(order, ["a", "b", "a.nested"]);
  assert.equal(loop.hasPending, false);
});

void test("Req 16.4: the microtask queue is fully drained BEFORE the next macrotask", () => {
  const loop = new EventLoop();
  const order: string[] = [];
  loop.queueMacrotask(() => {
    order.push("macro-1");
    loop.queueMicrotask(() => order.push("micro-from-macro-1"));
  });
  loop.queueMacrotask(() => order.push("macro-2"));
  loop.run();
  // micro-from-macro-1 must run before macro-2 (microtasks drained between
  // macrotasks).
  assert.deepEqual(order, ["macro-1", "micro-from-macro-1", "macro-2"]);
});

void test("Req 16.4: macrotasks run FIFO, each followed by a full microtask drain", () => {
  const loop = new EventLoop();
  const order: string[] = [];
  loop.queueMacrotask(() => {
    order.push("m1");
    loop.queueMicrotask(() => order.push("u1a"));
    loop.queueMicrotask(() => order.push("u1b"));
  });
  loop.queueMacrotask(() => {
    order.push("m2");
    loop.queueMicrotask(() => order.push("u2"));
  });
  loop.run();
  assert.deepEqual(order, ["m1", "u1a", "u1b", "m2", "u2"]);
});

void test("Req 16.4: an initial microtask checkpoint runs before the first macrotask", () => {
  const loop = new EventLoop();
  const order: string[] = [];
  loop.queueMacrotask(() => order.push("macro"));
  loop.queueMicrotask(() => order.push("micro"));
  loop.run();
  assert.deepEqual(order, ["micro", "macro"]);
});

void test("timers fire in due-time order regardless of insertion order", () => {
  const loop = new EventLoop();
  const order: number[] = [];
  loop.setTimer(() => order.push(30), 30);
  loop.setTimer(() => order.push(10), 10);
  loop.setTimer(() => order.push(20), 20);
  loop.run();
  assert.deepEqual(order, [10, 20, 30]);
});

void test("equal-delay timers preserve insertion order (stable)", () => {
  const loop = new EventLoop();
  const order: string[] = [];
  loop.setTimer(() => order.push("first"), 5);
  loop.setTimer(() => order.push("second"), 5);
  loop.run();
  assert.deepEqual(order, ["first", "second"]);
});

void test("queued macrotasks take priority over a same-tick (0ms) timer", () => {
  const loop = new EventLoop();
  const order: string[] = [];
  loop.setTimer(() => order.push("timer"), 0);
  loop.queueMacrotask(() => order.push("macro"));
  loop.run();
  // A directly-queued macrotask is taken before a 0ms timer.
  assert.deepEqual(order, ["macro", "timer"]);
});

void test("run() drives to quiescence and reports no pending work afterwards", () => {
  const loop = new EventLoop();
  let count = 0;
  // A macrotask that schedules a timer that schedules a microtask.
  loop.queueMacrotask(() => {
    count += 1;
    loop.setTimer(() => {
      count += 1;
      loop.queueMicrotask(() => {
        count += 1;
      });
    }, 1);
  });
  loop.run();
  assert.equal(count, 3);
  assert.equal(loop.hasPending, false);
});

void test("run() throws on a runaway self-rescheduling macrotask (safety bound)", () => {
  const loop = new EventLoop();
  loop.queueMacrotask(function reschedule() {
    loop.queueMacrotask(reschedule);
  });
  assert.throws(() => loop.run(50), /exceeded 50 steps/);
});

void test("a re-entrant run() inside a task is a no-op (outer run owns the drain)", () => {
  const loop = new EventLoop();
  const order: string[] = [];
  loop.queueMacrotask(() => {
    order.push("outer");
    loop.queueMacrotask(() => order.push("inner"));
    loop.run(); // must be a no-op; the outer run continues the drain.
  });
  loop.run();
  assert.deepEqual(order, ["outer", "inner"]);
});
