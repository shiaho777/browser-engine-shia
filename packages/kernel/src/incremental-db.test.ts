/**
 * Tests for the true incremental kernel backend (task 5.9).
 *
 * Built by `tsc` then run with: `node --test packages/kernel/dist/*.test.js`.
 *
 * Covers the design.md §7.1 incremental semantics and Requirement 2 / 9 /15:
 *   - 2.4: a repeated query with unchanged deps returns the cached value and
 *     does NOT recompute (compute runs exactly once).
 *   - 2.2: changing an input recomputes the transitively-dependent queries.
 *   - 2.6: an equal-value `setInput` does not bump the revision and leaves the
 *     dependent cached (compute count unchanged).
 *   - Early-stop: a sub-query that re-runs to an EQUAL value does not force its
 *     dependents to recompute.
 *   - Independence: changing input A does not recompute a query that depends
 *     only on input B.
 *   - 9.3 / sanity: IncrementalDb returns the SAME values as NaiveDb across a
 *     sequence of edits (the upstream query code is identical for both).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { define, defineInput, type Db } from "./index.js";
import { IncrementalDb } from "./incremental-db.js";
import { NaiveDb } from "./naive-db.js";

void test("Req 2.4: repeated query with unchanged deps runs compute exactly once", () => {
  const db = new IncrementalDb();
  const X = defineInput<string, number>("X");
  let runs = 0;
  const qId = define<string, number>((d: Db, key) => {
    runs += 1;
    return d.getInput(X, key);
  }, "qId");

  db.setInput(X, "k", 1);
  assert.equal(db.query(qId, "k"), 1);
  assert.equal(db.query(qId, "k"), 1);
  assert.equal(db.query(qId, "k"), 1);

  assert.equal(runs, 1, "unchanged dependencies must be served from cache");
  assert.equal(db.recomputeCount, 1, "recomputeCount confirms a single compute");
});

void test("Req 2.2: changing an input recomputes transitively-dependent queries (qA→qB→qC)", () => {
  const db = new IncrementalDb();
  const A = defineInput<string, number>("A");
  let aRuns = 0;
  let bRuns = 0;
  let cRuns = 0;

  const qA = define<string, number>((d: Db, key) => {
    aRuns += 1;
    return d.getInput(A, key) + 1;
  }, "qA");
  const qB = define<string, number>((d: Db, key) => {
    bRuns += 1;
    return d.query(qA, key) * 2;
  }, "qB");
  const qC = define<string, number>((d: Db, key) => {
    cRuns += 1;
    return d.query(qB, key) + 10;
  }, "qC");

  db.setInput(A, "k", 1);
  // (1+1)=2 → *2=4 → +10=14
  assert.equal(db.query(qC, "k"), 14);
  assert.equal(aRuns, 1);
  assert.equal(bRuns, 1);
  assert.equal(cRuns, 1);

  // Change the leaf input: the whole chain must recompute transitively.
  db.setInput(A, "k", 5);
  // (5+1)=6 → *2=12 → +10=22
  assert.equal(db.query(qC, "k"), 22);
  assert.equal(aRuns, 2, "qA recomputes on input change");
  assert.equal(bRuns, 2, "qB recomputes transitively");
  assert.equal(cRuns, 2, "qC recomputes transitively");
});

void test("Req 2.6: equal-value setInput does not bump revision and dependent stays cached", () => {
  const db = new IncrementalDb();
  const X = defineInput<string, number>("X");
  let runs = 0;
  const qId = define<string, number>((d: Db, key) => {
    runs += 1;
    return d.getInput(X, key);
  }, "qId");

  db.setInput(X, "k", 7);
  assert.equal(db.query(qId, "k"), 7);
  assert.equal(runs, 1);

  const revBefore = db.revision;
  db.setInput(X, "k", 7); // equal value
  assert.equal(db.revision, revBefore, "equal write must not bump the revision");

  assert.equal(db.query(qId, "k"), 7);
  assert.equal(runs, 1, "an equal-value write leaves the dependent cached (Req 2.6)");
});

void test("early-stop: a sub-query re-running to an EQUAL value does not recompute its dependents", () => {
  const db = new IncrementalDb();
  const Raw = defineInput<string, number>("Raw");
  let innerRuns = 0;
  let outerRuns = 0;

  // qInner collapses many inputs to a single bit: is Raw positive? Changing Raw
  // among positive values changes the input (revision bumps, qInner reruns) but
  // qInner's VALUE is unchanged, so qOuter must early-stop.
  const qInner = define<string, boolean>((d: Db, key) => {
    innerRuns += 1;
    return d.getInput(Raw, key) > 0;
  }, "qInner");
  const qOuter = define<string, string>((d: Db, key) => {
    outerRuns += 1;
    return d.query(qInner, key) ? "positive" : "non-positive";
  }, "qOuter");

  db.setInput(Raw, "k", 1);
  assert.equal(db.query(qOuter, "k"), "positive");
  assert.equal(innerRuns, 1);
  assert.equal(outerRuns, 1);

  // Change Raw to another positive value: input changed → qInner reruns, but it
  // returns the SAME boolean, so qOuter must NOT recompute (self-adjusting).
  db.setInput(Raw, "k", 42);
  assert.equal(db.query(qOuter, "k"), "positive");
  assert.equal(innerRuns, 2, "qInner reruns because its input changed");
  assert.equal(outerRuns, 1, "qOuter early-stops: qInner's value did not change");

  // Now flip the bit: qInner's value changes → qOuter must recompute.
  db.setInput(Raw, "k", -3);
  assert.equal(db.query(qOuter, "k"), "non-positive");
  assert.equal(innerRuns, 3);
  assert.equal(outerRuns, 2, "qOuter recomputes when qInner's value actually changes");
});

void test("independence: changing input A does not recompute a query depending only on input B", () => {
  const db = new IncrementalDb();
  const A = defineInput<string, number>("A");
  const B = defineInput<string, number>("B");
  let aRuns = 0;
  let bRuns = 0;

  const qFromA = define<string, number>((d: Db, key) => {
    aRuns += 1;
    return d.getInput(A, key);
  }, "qFromA");
  const qFromB = define<string, number>((d: Db, key) => {
    bRuns += 1;
    return d.getInput(B, key);
  }, "qFromB");

  db.setInput(A, "k", 1);
  db.setInput(B, "k", 2);
  assert.equal(db.query(qFromA, "k"), 1);
  assert.equal(db.query(qFromB, "k"), 2);
  assert.equal(aRuns, 1);
  assert.equal(bRuns, 1);

  // Change A only: qFromB must stay cached.
  db.setInput(A, "k", 100);
  assert.equal(db.query(qFromA, "k"), 100);
  assert.equal(db.query(qFromB, "k"), 2);
  assert.equal(aRuns, 2, "qFromA recomputes because A changed");
  assert.equal(bRuns, 1, "qFromB stays cached: it does not depend on A");
});

void test("structural keys: queries keyed by {url,node} cache by structure, not reference", () => {
  const db = new IncrementalDb();
  type Key = { readonly url: string; readonly node: number };
  const Src = defineInput<string, string>("Src");
  let runs = 0;
  const qLabel = define<Key, string>((d: Db, key) => {
    runs += 1;
    return `${d.getInput(Src, key.url)}#${String(key.node)}`;
  }, "qLabel");

  db.setInput(Src, "a.html", "DOC");
  assert.equal(db.query(qLabel, { url: "a.html", node: 3 }), "DOC#3");
  // A structurally-equal key with different property order / identity must hit
  // the same memo entry (no recompute).
  assert.equal(db.query(qLabel, { node: 3, url: "a.html" }), "DOC#3");
  assert.equal(runs, 1, "structurally-equal keys share one memo entry");

  // A genuinely different key recomputes.
  assert.equal(db.query(qLabel, { url: "a.html", node: 4 }), "DOC#4");
  assert.equal(runs, 2);
});

void test("Map-valued query dependencies invalidate dependents when their entries change", () => {
  const db = new IncrementalDb();
  const Text = defineInput<string, string>("Text");
  let mapRuns = 0;
  let valueRuns = 0;

  // DomTree.nodes is a ReadonlyMap; the incremental backend must compare Map
  // contents structurally, not treat every Map as an empty plain object.
  const qMap = define<string, ReadonlyMap<number, string>>((d: Db, key) => {
    mapRuns += 1;
    return new Map([[0, d.getInput(Text, key)]]);
  }, "qMap");
  const qValue = define<string, string>((d: Db, key) => {
    valueRuns += 1;
    return d.query(qMap, key).get(0) ?? "";
  }, "qValue");

  db.setInput(Text, "k", "before");
  assert.equal(db.query(qValue, "k"), "before");
  assert.equal(mapRuns, 1);
  assert.equal(valueRuns, 1);

  db.setInput(Text, "k", "after");
  assert.equal(db.query(qValue, "k"), "after");
  assert.equal(mapRuns, 2, "the Map-producing query rechecks its changed input");
  assert.equal(valueRuns, 2, "the dependent recomputes because the Map entry changed");
});

void test("Set-valued query dependencies invalidate dependents when their members change", () => {
  const db = new IncrementalDb();
  const Text = defineInput<string, string>("Text");
  let setRuns = 0;
  let valueRuns = 0;

  const qSet = define<string, ReadonlySet<string>>((d: Db, key) => {
    setRuns += 1;
    return new Set([d.getInput(Text, key)]);
  }, "qSet");
  const qValue = define<string, string>((d: Db, key) => {
    valueRuns += 1;
    return [...d.query(qSet, key)].join(",");
  }, "qSetValue");

  db.setInput(Text, "k", "alpha");
  assert.equal(db.query(qValue, "k"), "alpha");
  assert.equal(setRuns, 1);
  assert.equal(valueRuns, 1);

  db.setInput(Text, "k", "beta");
  assert.equal(db.query(qValue, "k"), "beta");
  assert.equal(setRuns, 2, "the Set-producing query rechecks its changed input");
  assert.equal(valueRuns, 2, "the dependent recomputes because the Set member changed");
});

void test("Req 9.3 sanity: IncrementalDb returns the SAME values as NaiveDb over a few edits", () => {
  const A = defineInput<string, number>("A");
  const B = defineInput<string, number>("B");
  // A small pipeline of queries shared verbatim by both backends.
  const qSum = define<string, number>(
    (d: Db, key) => d.getInput(A, key) + d.getInput(B, key),
    "qSum",
  );
  const qScaled = define<string, number>((d: Db, key) => d.query(qSum, key) * 3, "qScaled");
  const qReport = define<string, string>(
    (d: Db, key) => `sum=${String(d.query(qSum, key))} scaled=${String(d.query(qScaled, key))}`,
    "qReport",
  );

  const naive = new NaiveDb();
  const incr = new IncrementalDb();

  const edits: ReadonlyArray<readonly [number, number]> = [
    [1, 2],
    [1, 2], // equal write (no-op)
    [10, 2], // change A
    [10, 20], // change B
    [10, 20], // equal write (no-op)
    [0, 0], // change both
  ];

  for (const [a, b] of edits) {
    naive.setInput(A, "k", a);
    naive.setInput(B, "k", b);
    incr.setInput(A, "k", a);
    incr.setInput(B, "k", b);

    assert.equal(incr.query(qSum, "k"), naive.query(qSum, "k"), "qSum agrees");
    assert.equal(incr.query(qScaled, "k"), naive.query(qScaled, "k"), "qScaled agrees");
    assert.equal(incr.query(qReport, "k"), naive.query(qReport, "k"), "qReport agrees");
  }
});

void test("Req 2.3: IncrementalDb exposes no manual stale-marking API", () => {
  const db = new IncrementalDb();
  const surface = db as unknown as Record<string, unknown>;
  for (const forbidden of ["invalidate", "markStale", "setDirty", "bump", "markDirty"]) {
    assert.equal(typeof surface[forbidden], "undefined", `unexpected ${forbidden} API`);
  }
});
