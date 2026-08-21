/**
 * Tests for the Phase 0 query kernel (task 1.5).
 *
 * Built by `tsc` then run with: `node --test packages/kernel/dist/*.test.js`.
 *
 * Covers the interface contract and naive-backend semantics from design.md §7.1
 * and Requirement 2 / Requirement 9:
 *   - 2.1: each query execution records every input and query it reads.
 *   - 2.3: invalidation is automatic; no manual stale-marking API exists.
 *   - 2.6: setting an input to its current value disturbs nothing.
 *   - 9.1 / 9.3: the naive backend implements the final `Db` interface so the
 *     upstream query definitions need no change when the incremental backend
 *     replaces it. (The naive backend "never caches": recomputeCount grows.)
 */
import test from "node:test";
import assert from "node:assert/strict";

import { define, defineInput, type Db, type QueryTraceEvent } from "./index.js";
import { InputNotSetError, NaiveDb } from "./naive-db.js";

void test("getInput returns the value last written for a key", () => {
  const db = new NaiveDb();
  const SourceBytes = defineInput<string, string>("SourceBytes");

  db.setInput(SourceBytes, "a.html", "<div/>");
  assert.equal(db.getInput(SourceBytes, "a.html"), "<div/>");

  db.setInput(SourceBytes, "a.html", "<p/>");
  assert.equal(db.getInput(SourceBytes, "a.html"), "<p/>");
});

void test("reading an unset input fails loudly (no silent default)", () => {
  const db = new NaiveDb();
  const Missing = defineInput<string, number>("Missing");
  assert.throws(() => db.getInput(Missing, "nope"), InputNotSetError);
});

void test("a derived query reads inputs through the db and returns the computed value", () => {
  const db = new NaiveDb();
  const Text = defineInput<string, string>("Text");
  const qUpper = define<string, string>((d: Db, key) =>
    d.getInput(Text, key).toUpperCase(),
  );

  db.setInput(Text, "k", "hello");
  assert.equal(db.query(qUpper, "k"), "HELLO");
});

void test("Req 2.1: execution records every input and query that was read", () => {
  const db = new NaiveDb();
  const A = defineInput<string, number>("A");
  const B = defineInput<string, number>("B");
  const qSum = define<string, number>(
    (d: Db, key) => d.getInput(A, key) + d.getInput(B, key),
    "qSum",
  );
  const qDouble = define<string, number>((d: Db, key) => d.query(qSum, key) * 2, "qDouble");

  db.setInput(A, "k", 3);
  db.setInput(B, "k", 4);

  // qSum reads exactly inputs A and B at key "k".
  const sumTrace = db.trace(qSum, "k");
  assert.equal(sumTrace.value, 7);
  assert.deepEqual(
    sumTrace.dependencies.map((dep) => (dep.kind === "input" ? dep.input.name : dep.query.name)),
    ["A", "B"],
  );

  // qDouble reads exactly the query qSum at key "k".
  const doubleTrace = db.trace(qDouble, "k");
  assert.equal(doubleTrace.value, 14);
  assert.equal(doubleTrace.dependencies.length, 1);
  const [only] = doubleTrace.dependencies;
  assert.ok(only !== undefined && only.kind === "query" && only.key === "k");
});

void test("naive backend never caches: every query call recomputes", () => {
  const db = new NaiveDb();
  const X = defineInput<string, number>("X");
  let computeRuns = 0;
  const qId = define<string, number>((d: Db, key) => {
    computeRuns += 1;
    return d.getInput(X, key);
  });

  db.setInput(X, "k", 1);
  db.query(qId, "k");
  db.query(qId, "k");
  db.query(qId, "k");
  // Same key, same inputs — a memoising backend would compute once; the naive
  // baseline recomputes every time (design.md §7.1).
  assert.equal(computeRuns, 3);
});

void test("query observer reports naive recomputes as read-only diagnostics", () => {
  const events: QueryTraceEvent[] = [];
  const db = new NaiveDb({ onQuery: (event) => events.push(event) });
  const X = defineInput<string, number>("X");
  const qId = define<string, number>((d: Db, key) => d.getInput(X, key), "qId");

  db.setInput(X, "k", 9);
  assert.equal(db.query(qId, "k"), 9);

  assert.equal(events.length, 1);
  const event = events[0];
  assert.ok(event !== undefined);
  assert.equal(event.queryName, "qId");
  assert.equal(event.cacheStatus, "miss");
  assert.equal(event.dependencyCount, 1);
  assert.equal(typeof event.durationMs, "number");
  assert.ok(event.durationMs >= 0);
});

void test("Req 2.3: setInput bumps revision automatically; no stale-marking API", () => {
  const db = new NaiveDb();
  const V = defineInput<string, number>("V");

  // The interface exposes no manual invalidation surface.
  const surface = db as unknown as Record<string, unknown>;
  for (const forbidden of ["invalidate", "markStale", "setDirty", "bump", "markDirty"]) {
    assert.equal(typeof surface[forbidden], "undefined", `unexpected ${forbidden} API`);
  }

  const before = db.revision;
  db.setInput(V, "k", 1);
  assert.ok(db.revision > before, "changing an input must advance the revision");
});

void test("Req 2.6: setting an input to its current value is a no-op", () => {
  const db = new NaiveDb();
  const V = defineInput<string, number>("V");

  db.setInput(V, "k", 42);
  const afterFirstWrite = db.revision;

  db.setInput(V, "k", 42); // equal value
  assert.equal(db.revision, afterFirstWrite, "equal write must not bump revision");
});
