/**
 * Kernel/guest boundary isolation tests (task 7.5; design.md §10, §3.1.E;
 * Requirements 7.2, 7.4).
 *
 * Built by `tsc` then run with: `node --test packages/guest/dist/*.test.js`.
 *
 * Task 7.4 stores every engine-internal handle a DOM wrapper needs — the
 * {@link NodeId}, the Incremental_Kernel {@link Db}, and the fragment index —
 * behind the module-private `INTERNAL` symbol inside a package-private
 * `WeakMap` (see `./internal.ts`). This suite is the executable proof that the
 * isolation actually holds, asserting the two observable guarantees a guest
 * could try to break:
 *
 *   - **Requirement 7.2** — when guest JS enumerates a DOM object's keys, ALL
 *     engine-internal state is excluded. We check the THREE enumeration surfaces
 *     a guest can reach — `Object.keys`, `for…in` (own + inherited enumerable),
 *     and `Reflect.ownKeys` (own string + symbol keys) — across the wrapper AND
 *     its entire prototype chain, and assert none of them ever yields the
 *     internal handle, the `INTERNAL` symbol, or an internal field name
 *     (`node` / `db` / `nodeQuery` / `fragmentIndex`).
 *   - **Requirement 7.4** — when guest JS tries to ACCESS an internal handle by
 *     any key it can actually form (a string it guesses, or a fresh symbol of
 *     its own), it gets `undefined` — never the `NodeId` / `Db` / fragment
 *     index.
 *
 * The contrast that makes the test meaningful: trusted in-package code CAN
 * retrieve the handle through the sanctioned `readInternal` path (positive
 * control), so the WeakMap genuinely holds it — the guest simply has no path to
 * it because neither the map nor the `INTERNAL` symbol is exported.
 *
 * The guest package is NOT a pipeline stage, so it may import the frozen IR and
 * the kernel directly to assemble a realistic wrapper handle for the test.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { deepFreeze, nodeId } from "@browser-engine/ir";
import type { DomNode, NodeId } from "@browser-engine/ir";
import {
  NaiveDb,
  define,
  defineInput,
  type Db,
  type InputSlot,
  type QueryDef,
} from "@browser-engine/kernel";

import { createElementWrapper } from "./element.js";
import { attachInternal, readInternal, type NodeInternal } from "./internal.js";

// ---------------------------------------------------------------------------
// A realistic engine-internal handle, built the way trusted in-package code
// would: a NaiveDb plus a `nodeQuery` that resolves a NodeId → DomNode through
// the kernel (so the wrapper participates in dependency tracking).
// ---------------------------------------------------------------------------

/** Leaf input mapping a NodeId to its frozen DomNode (stand-in for the DomTree). */
const NodeInput: InputSlot<NodeId, DomNode> = defineInput<NodeId, DomNode>("TestNode");

/** The query the wrapper reads DOM state through (mirrors the real nodeQuery). */
const nodeQuery: QueryDef<NodeId, DomNode> = define<NodeId, DomNode>(
  (db: Db, node: NodeId) => db.getInput(NodeInput, node),
  "qTestNode",
);

/** The node identifiers used by the fixtures. */
const ELEMENT_NODE: NodeId = nodeId(1);

/** Build a frozen element DomNode carrying id/class attributes. */
function makeElement(): DomNode {
  return deepFreeze({
    id: ELEMENT_NODE,
    kind: "element",
    tag: "div",
    attrs: new Map<string, string>([
      ["id", "main"],
      ["class", "box"],
    ]),
    children: [],
    parent: null,
  } as unknown as DomNode);
}

/** Seed a NaiveDb with the element node and return an engine-internal handle. */
function makeHandle(): { db: NaiveDb; handle: NodeInternal } {
  const db = new NaiveDb();
  db.setInput(NodeInput, ELEMENT_NODE, makeElement());
  const handle: NodeInternal = { node: ELEMENT_NODE, db, nodeQuery };
  return { db, handle };
}

/** A built guest-visible Element wrapper over a fresh handle. */
function makeWrapper(): ReturnType<typeof createElementWrapper> {
  const { handle } = makeHandle();
  return createElementWrapper(handle);
}

/** The engine-internal field names a guest must never be able to surface. */
const INTERNAL_FIELD_NAMES = ["node", "db", "nodeQuery", "fragmentIndex"] as const;

/** Collect every own key (string + symbol) across an object's prototype chain. */
function ownKeysAcrossChain(obj: object): (string | symbol)[] {
  const keys: (string | symbol)[] = [];
  let cursor: object | null = obj;
  while (cursor !== null && cursor !== Object.prototype) {
    for (const key of Reflect.ownKeys(cursor)) {
      keys.push(key);
    }
    cursor = Object.getPrototypeOf(cursor) as object | null;
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Positive control: the wrapper genuinely works and the handle IS retrievable
// through the sanctioned in-package path (so isolation is non-trivial).
// ---------------------------------------------------------------------------

void test("the wrapper exposes its generated web surface (tagName reads through the kernel)", () => {
  const el = makeWrapper();
  // Reading a concrete generated member proves the wrapper is wired to a real
  // handle + Db — so the isolation asserted below is hiding something real.
  assert.equal(el.tagName, "DIV");
  assert.equal(el.id, "main");
  assert.equal(el.className, "box");
});

void test("trusted in-package code CAN retrieve the handle via readInternal (positive control)", () => {
  const { handle } = makeHandle();
  const el = createElementWrapper(handle);
  const recovered = readInternal(el);
  // The sanctioned path returns the very handle that the guest cannot reach.
  assert.equal(recovered.node, ELEMENT_NODE);
  assert.equal(recovered.db, handle.db);
  assert.equal(recovered.nodeQuery, nodeQuery);
});

// ---------------------------------------------------------------------------
// Requirement 7.2 — enumeration excludes ALL engine-internal state.
// ---------------------------------------------------------------------------

void test("Req 7.2: Object.keys excludes all engine-internal state", () => {
  const el = makeWrapper();
  const keys = Object.keys(el);
  // No own enumerable string keys at all — the handle lives in a WeakMap, the
  // #private field is not an own property, and surface members are
  // non-enumerable prototype accessors. An empty key set trivially excludes
  // every internal field name (asserted explicitly on the prototype chain below).
  assert.deepEqual(keys, []);
});

void test("Req 7.2: for…in (own + inherited enumerable) excludes engine-internal state", () => {
  const el = makeWrapper();
  const enumerated: string[] = [];
  for (const key in el) {
    enumerated.push(key);
  }
  // Surface members are installed non-enumerable, so for…in surfaces nothing —
  // and therefore never an internal field name.
  assert.deepEqual(enumerated, []);
});

void test("Req 7.2: Reflect.ownKeys on the instance yields no internal keys or symbols", () => {
  const el = makeWrapper();
  const own = Reflect.ownKeys(el);
  // The instance carries no own property keys (string OR symbol): the handle is
  // off-object in a WeakMap and the #private field is not reflected.
  assert.deepEqual(own, []);
  const symbols = own.filter((k) => typeof k === "symbol");
  assert.deepEqual(symbols, [], "no internal symbol key is exposed on the instance");
});

void test("Req 7.2: no internal field name or symbol appears anywhere on the prototype chain", () => {
  const el = makeWrapper();
  const keys = ownKeysAcrossChain(el);

  // The only own keys across the chain are the generated web surface (strings
  // like tagName/id/getAttribute) plus `constructor` — never an internal name.
  for (const name of INTERNAL_FIELD_NAMES) {
    assert.equal(
      keys.includes(name),
      false,
      `prototype chain leaked internal field "${name}"`,
    );
  }

  // The module-private INTERNAL symbol lives ONLY as the key of the WeakMap's
  // record objects — never on the wrapper or any prototype. So there must be no
  // symbol-keyed own property anywhere on the chain for a guest to discover.
  const symbols = keys.filter((k) => typeof k === "symbol");
  assert.deepEqual(
    symbols,
    [],
    `prototype chain exposed symbol keys: ${symbols.map((s) => String(s)).join(", ")}`,
  );
});

// ---------------------------------------------------------------------------
// Requirement 7.4 — accessing an internal handle by any guessable key is undefined.
// ---------------------------------------------------------------------------

void test("Req 7.4: accessing internal handles by a guessed string key yields undefined", () => {
  const el = makeWrapper();
  const probe = el as unknown as Record<string, unknown>;
  // Every name a guest might guess for the hidden handle resolves to undefined.
  for (const guess of [
    ...INTERNAL_FIELD_NAMES,
    "internal",
    "__internal",
    "_internal",
    "INTERNAL",
    "handle",
    "engine",
    "slots",
  ]) {
    assert.equal(probe[guess], undefined, `internal access via "${guess}" was not undefined`);
  }
});

void test("Req 7.4: accessing via a fresh guest-made symbol yields undefined", () => {
  const el = makeWrapper();
  // A guest can only ever mint its OWN symbols; it cannot name the module's
  // INTERNAL symbol. Indexing by a fresh symbol must miss entirely.
  const guestSymbol = Symbol("guest-probe");
  const probe = el as unknown as Record<symbol, unknown>;
  assert.equal(probe[guestSymbol], undefined);
  // Even a same-description symbol is a DIFFERENT symbol, so it also misses.
  const lookalike = Symbol("engine-internal");
  assert.equal(probe[lookalike], undefined);
});

void test("Req 7.4: a non-engine object has no handle — readInternal fails loudly, access is undefined", () => {
  // An object the guest fabricates is not an engine-built wrapper, so it has no
  // attached handle: the sanctioned path throws NotImplemented (no silent
  // undefined sneaking through trusted code), and naive key access is undefined.
  const fake = {} as Record<string, unknown>;
  assert.throws(() => readInternal(fake));
  assert.equal(fake["node"], undefined);
  assert.equal(fake["db"], undefined);
});

// ---------------------------------------------------------------------------
// The WeakMap slot itself is unreachable: attaching a handle adds NO own/symbol
// key to the object, so even attachInternal leaves enumeration clean.
// ---------------------------------------------------------------------------

void test("attachInternal adds no enumerable/own key to the target (slot is off-object)", () => {
  const { handle } = makeHandle();
  const target = {} as Record<string, unknown>;
  const before = Reflect.ownKeys(target);
  attachInternal(target, handle);
  const after = Reflect.ownKeys(target);
  // Storing the handle did not add any key to the object — it went into the
  // WeakMap keyed by the module-private symbol, which the object never carries.
  assert.deepEqual(after, before);
  assert.deepEqual(Object.keys(target), []);
  // …yet the handle is retrievable through the sanctioned path.
  assert.equal(readInternal(target).node, handle.node);
});
