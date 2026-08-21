/** Tests for AbortController / AbortSignal (DOM §3.2) and the `{ signal }`
 * addEventListener option on the shared EventTarget implementation. */
import test from "node:test";
import assert from "node:assert/strict";

import { AbortController, AbortSignal, DOMException } from "./index.js";
import { Event, EventTarget } from "./event-system.js";

void test("AbortController.abort flips aborted, sets a default AbortError reason, and fires abort once", () => {
  const controller = new AbortController();
  const signal = controller.signal;
  assert.equal(signal.aborted, false);
  assert.equal(signal.reason, undefined);

  let fires = 0;
  signal.addEventListener("abort", () => {
    fires += 1;
    assert.equal(signal.aborted, true);
  });

  controller.abort();
  assert.equal(fires, 1);
  assert.equal(signal.aborted, true);
  const reason = signal.reason as unknown as DOMException;
  assert.equal(reason.name, "AbortError");

  // The abort algorithm is idempotent: a second abort is a no-op.
  controller.abort();
  assert.equal(fires, 1);
});

void test("abort(reason) records the given reason verbatim and throwIfAborted throws it", () => {
  const controller = new AbortController();
  const reason = new Error("stop");
  controller.abort(reason);
  assert.equal(controller.signal.reason, reason);
  assert.throws(() => controller.signal.throwIfAborted(), (e: unknown) => e === reason);
});

void test("AbortSignal.abort() returns an already-aborted signal", () => {
  const signal = AbortSignal.abort();
  assert.equal(signal.aborted, true);
  assert.equal((signal.reason as DOMException).name, "AbortError");
});

void test("addEventListener({ signal }) removes the listener when the signal aborts", () => {
  const controller = new AbortController();
  const target = new EventTarget();
  let calls = 0;
  target.addEventListener("ping", () => {
    calls += 1;
  }, { signal: controller.signal });

  target.dispatchEvent(new Event("ping"));
  assert.equal(calls, 1);

  controller.abort();
  target.dispatchEvent(new Event("ping"));
  assert.equal(calls, 1, "the abort removed the listener");
});

void test("an already-aborted signal never registers the listener", () => {
  const signal = AbortSignal.abort();
  const target = new EventTarget();
  let calls = 0;
  target.addEventListener("ping", () => {
    calls += 1;
  }, { signal });
  target.dispatchEvent(new Event("ping"));
  assert.equal(calls, 0);
});

void test("the signal option composes with once and with explicit removal", () => {
  const controller = new AbortController();
  const target = new EventTarget();
  let calls = 0;
  const handler = (): void => {
    calls += 1;
  };
  target.addEventListener("ping", handler, { once: true, signal: controller.signal });
  target.dispatchEvent(new Event("ping"));
  target.dispatchEvent(new Event("ping"));
  assert.equal(calls, 1, "once fired exactly once");

  target.addEventListener("pong", handler, { signal: controller.signal });
  target.removeEventListener("pong", handler);
  controller.abort();
  target.dispatchEvent(new Event("pong"));
  assert.equal(calls, 1, "explicit removal wins and abort is a no-op afterwards");
});

void test("onabort observes aborts and can be detached", () => {
  const signal = new AbortSignal();
  let calls = 0;
  signal.onabort = () => {
    calls += 1;
  };
  assert.equal(signal.onabort !== null, true);
  signal._abort();
  signal._abort();
  assert.equal(calls, 1, "idempotent abort fires onabort once");

  signal.onabort = null;
  assert.equal(signal.onabort, null);
});

void test("AbortSignal.any aborts when any input aborts, with the source's reason", () => {
  const a = new AbortController();
  const b = new AbortController();
  const composite = AbortSignal.any([a.signal, b.signal]);
  assert.equal(composite.aborted, false);

  const reason = new Error("from b");
  b.abort(reason);
  assert.equal(composite.aborted, true);
  assert.equal(composite.reason, reason);
});
