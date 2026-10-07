/**
 * mutation-observer.test.ts — unit tests for the MutationObserverController.
 *
 * The controller is engine-free: it works on plain numbers (node ids) and an
 * injected parentOf lookup. These tests exercise the DOM Standard algorithm
 * (options filter, subtree propagation, oldValue mapping, microtask batching)
 * without any engine involved.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { MutationObserverController, type QueuedRecord } from "./mutation-observer.js";

/** A small fake tree:
 *    1 (root)
 *    └── 2 (div)
 *        └── 3 (span)
 *            └── 4 (text)
 */
const PARENTS = new Map([
  [2, 1],
  [3, 2],
  [4, 3],
]);
const parentOf = (id: number): number | null => PARENTS.get(id) ?? null;

type Delivery = { readonly records: readonly QueuedRecord[]; readonly observer: unknown };

/** Collect delivered callbacks for assertions. */
function makeHarness() {
  const delivered: Delivery[] = [];
  const controller = new MutationObserverController(parentOf, (fn) => {
    // Run the "microtask" immediately — the tests assert the batching logic,
    // not the event loop timing (that is the scheduler's job).
    fn();
  });
  const cb = (records: readonly QueuedRecord[], observer: unknown): void => {
    delivered.push({ records, observer });
  };
  return { controller, delivered, cb };
}

void test("attributes record reaches an observer watching the target directly", () => {
  const { controller, delivered, cb } = makeHarness();
  controller.observe("obs", cb, 3, { attributes: true });

  controller.queueMutation({ kind: "attributes", target: 3, attributeName: "class", oldValue: "a" });

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]!.records.length, 1);
  assert.equal(delivered[0]!.records[0]!.type, "attributes");
  assert.equal(delivered[0]!.records[0]!.target, 3);
  assert.equal(delivered[0]!.records[0]!.attributeName, "class");
});

void test("an observer on the target does NOT see child mutations without subtree", () => {
  const { controller, delivered, cb } = makeHarness();
  controller.observe("obs", cb, 2, { childList: true });

  controller.queueMutation({ kind: "childList", target: 3, added: [4] });

  assert.equal(delivered.length, 0, "without subtree, mutations on children must not notify");
});

void test("subtree propagates records up the ancestor chain", () => {
  const { controller, delivered, cb } = makeHarness();
  controller.observe("obs", cb, 1, { childList: true, subtree: true });

  controller.queueMutation({ kind: "childList", target: 3, added: [4] });

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]!.records[0]!.target, 3);
});

void test("attributeFilter limits which attribute mutations notify", () => {
  const { controller, delivered, cb } = makeHarness();
  controller.observe("obs", cb, 3, { attributeFilter: ["class"] });

  controller.queueMutation({ kind: "attributes", target: 3, attributeName: "style", oldValue: null });
  assert.equal(delivered.length, 0, "style is not in the filter");

  controller.queueMutation({ kind: "attributes", target: 3, attributeName: "class", oldValue: "x" });
  assert.equal(delivered.length, 1, "class is in the filter");
});

void test("oldValue is mapped per observer: only observers that asked receive it", () => {
  const { controller, delivered, cb } = makeHarness();
  controller.observe("plain", cb, 3, { attributes: true });
  controller.observe("historian", cb, 3, { attributeOldValue: true });

  controller.queueMutation({ kind: "attributes", target: 3, attributeName: "id", oldValue: "old-id" });

  assert.equal(delivered.length, 2);
  const plain = delivered.find((d) => d.observer === "plain");
  const historian = delivered.find((d) => d.observer === "historian");
  assert.equal(plain!.records[0]!.oldValue, null);
  assert.equal(historian!.records[0]!.oldValue, "old-id");
});

void test("characterData record with oldValue", () => {
  const { controller, delivered, cb } = makeHarness();
  controller.observe("obs", cb, 4, { characterData: true, characterDataOldValue: true });

  controller.queueMutation({ kind: "characterData", target: 4, oldValue: "alter Text" });

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]!.records[0]!.type, "characterData");
  assert.equal(delivered[0]!.records[0]!.oldValue, "alter Text");
});

void test("childList record carries added/removed nodes and siblings", () => {
  const { controller, delivered, cb } = makeHarness();
  controller.observe("obs", cb, 2, { childList: true });

  controller.queueMutation({
    kind: "childList",
    target: 2,
    added: [5],
    previousSibling: 3,
    nextSibling: null,
  });

  const record = delivered[0]!.records[0]!;
  assert.deepEqual(record.addedNodes, [5]);
  assert.deepEqual(record.removedNodes, []);
  assert.equal(record.previousSibling, 3);
  assert.equal(record.nextSibling, null);
});

void test("disconnect stops all future notifications", () => {
  const { controller, delivered, cb } = makeHarness();
  controller.observe("obs", cb, 2, { childList: true, subtree: true });
  controller.queueMutation({ kind: "childList", target: 3, added: [4] });
  assert.equal(delivered.length, 1);

  controller.disconnect("obs");
  controller.queueMutation({ kind: "childList", target: 3, added: [6] });
  assert.equal(delivered.length, 1, "no delivery after disconnect");
});

void test("multiple mutations batch into ONE microtask delivery", () => {
  const delivered: Delivery[] = [];
  // Simulate a real microtask queue: collect the flush function, run manually.
  let flush: (() => void) | null = null;
  const controller = new MutationObserverController(parentOf, (fn) => {
    flush = fn;
  });
  const cb = (records: readonly QueuedRecord[], observer: unknown): void => {
    delivered.push({ records, observer });
  };
  controller.observe("obs", cb, 2, { childList: true, subtree: true, attributes: true });

  controller.queueMutation({ kind: "childList", target: 3, added: [4] });
  controller.queueMutation({ kind: "childList", target: 3, added: [5] });
  controller.queueMutation({ kind: "attributes", target: 3, attributeName: "id" });

  assert.equal(delivered.length, 0, "nothing delivered before the microtask runs");
  flush!();

  assert.equal(delivered.length, 1, "one batched callback, not three");
  assert.equal(delivered[0]!.records.length, 3, "all three records in one batch");
});

void test("takeRecords drains the queue without waiting for the callback", () => {
  const delivered: string[] = [];
  let flush: (() => void) | null = null;
  const controller = new MutationObserverController(parentOf, (fn) => {
    flush = fn;
  });
  controller.observe("obs", () => delivered.push("cb"), 2, { childList: true });

  controller.queueMutation({ kind: "childList", target: 2, added: [9] });
  const taken = controller.takeRecords("obs");
  assert.equal(taken.length, 1);
  assert.equal(taken[0]!.type, "childList");

  flush!();
  assert.equal(delivered.length, 0, "queue was drained by takeRecords — callback gets nothing");
});
