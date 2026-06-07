/**
 * Property 1: IR 不可变性 (IR immutability) — design.md §9.2.
 *
 * **Validates: Requirements 3.2**
 *
 * > ∀ tree, stage: 执行 stage(tree) 后,tree 的引用与结构内容不变。
 * > (When a downstream stage executes, every upstream IR value is left
 * >  unchanged in reference and structural content.)
 *
 * Phase 0 has no real pipeline stages yet (they signal `NotImplemented`), so we
 * validate the *enabling invariant* that makes Requirement 3.2 physically true
 * rather than merely conventional: an IR value built through `deepFreeze`
 * (packages/ir) is deeply immutable, so a downstream stage cannot mutate it.
 *
 * Two complementary facts are asserted under fast-check's ∀ quantification over
 * arbitrary `DomTree`-shaped IR:
 *
 *   1. Reference + structural-hash invariance under a downstream stage. A
 *      downstream stage is, by the IR's `readonly` types, a *read-only* function
 *      of its upstream input. We simulate one (it fully traverses the tree and
 *      derives a value, exactly as `cascadeAll(db, tree)` would) and assert the
 *      upstream tree's reference is identical and its structural hash is
 *      unchanged — this is the literal statement of Requirement 3.2 and mirrors
 *      the design's reference example (`structuralHash(tree) === before`).
 *
 *   2. Runtime backstop. `deepFreeze` closes the hole left by type erasure:
 *      every reachable object/array is `Object.isFrozen`, and any attempt to
 *      assign a property, add a key, or mutate an array (the operations the
 *      `readonly` types forbid at compile time) either throws or no-ops, leaving
 *      the structural hash identical. So even a type-erased / `any`-typed stage
 *      cannot silently corrupt upstream IR.
 *
 * Built by `tsc` then run with: `node --test packages/ir/dist/*.test.js`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { deepFreeze, nodeId } from "./index.js";
import type { DomTree, DomNode, NodeId } from "./index.js";

const NUM_RUNS = 200;

// ---------------------------------------------------------------------------
// structuralHash — deterministic, structure-capturing serialization.
//
// Two values share a hash iff they have the same structural content (handling
// nested objects with stable key order, arrays, Map, and Set). Used to prove an
// IR value is "unchanged in structural content" before vs after a stage runs.
// ---------------------------------------------------------------------------
function structuralHash(value: unknown): string {
  if (value === null) return "null";

  if (typeof value === "string") return `s:${JSON.stringify(value)}`;
  if (typeof value === "number") return `number:${value}`;
  if (typeof value === "boolean") return `boolean:${String(value)}`;
  if (typeof value === "bigint") return `bigint:${value.toString()}`;
  if (typeof value === "undefined") return "undefined";
  if (typeof value === "function") return "fn";
  if (typeof value === "symbol") return `sym:${value.toString()}`;

  if (Array.isArray(value)) {
    return `[${value.map(structuralHash).join(",")}]`;
  }

  if (value instanceof Map) {
    const entries = [...value.entries()]
      .map(([k, v]) => `${structuralHash(k)}=>${structuralHash(v)}`)
      .sort();
    return `Map{${entries.join(",")}}`;
  }

  if (value instanceof Set) {
    const items = [...value].map(structuralHash).sort();
    return `Set{${items.join(",")}}`;
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${structuralHash(obj[k])}`).join(",")}}`;
}

// ---------------------------------------------------------------------------
// arbDomTree — generates arbitrary DomTree-shaped IR, then `deepFreeze`s it.
// ---------------------------------------------------------------------------

/** A fast-check-generated, fully-required description of a DOM node. */
interface NodeSpec {
  readonly kind: "element" | "text";
  /** used when kind === "element" */
  readonly tag: string;
  /** used when kind === "text" */
  readonly text: string;
  /** used when kind === "element" */
  readonly attrs: ReadonlyArray<readonly [string, string]>;
  readonly children: readonly NodeSpec[];
}

/** Build a frozen `DomTree` IR value from a generated `NodeSpec`. */
function buildDomTree(spec: NodeSpec): DomTree {
  const nodes = new Map<NodeId, DomNode>();
  let counter = 0;

  function walk(s: NodeSpec, parent: NodeId | null): NodeId {
    const id = nodeId(counter++);
    const childIds = s.children.map((child) => walk(child, id));
    const node: DomNode =
      s.kind === "element"
        ? {
            id,
            kind: "element",
            tag: s.tag,
            attrs: new Map(s.attrs),
            children: childIds,
            parent,
          }
        : { id, kind: "text", text: s.text, children: childIds, parent };
    nodes.set(id, node);
    return id;
  }

  const root = walk(spec, null);
  const tree = { root, nodes } as unknown as DomTree;
  return deepFreeze(tree);
}

const tagArb = fc.constantFrom("div", "span", "p", "section", "ul", "li", "a");
const attrsArb = fc.array(fc.tuple(fc.string(), fc.string()), { maxLength: 3 });

const leafSpecArb: fc.Arbitrary<NodeSpec> = fc.record({
  kind: fc.constant("text" as const),
  tag: fc.constant(""),
  text: fc.string(),
  attrs: fc.constant<ReadonlyArray<readonly [string, string]>>([]),
  children: fc.constant<readonly NodeSpec[]>([]),
});

const { node: nodeSpecArb } = fc.letrec<{ node: NodeSpec }>((tie) => ({
  node: fc.oneof(
    { maxDepth: 3, depthSize: "small" },
    leafSpecArb,
    fc.record({
      kind: fc.constant("element" as const),
      tag: tagArb,
      text: fc.constant(""),
      attrs: attrsArb,
      children: fc.array(tie("node"), { maxLength: 3 }),
    }),
  ),
}));

/** Arbitrary frozen `DomTree` IR values. */
function arbDomTree(): fc.Arbitrary<DomTree> {
  return nodeSpecArb.map(buildDomTree);
}

// ---------------------------------------------------------------------------
// Downstream-stage simulation.
// ---------------------------------------------------------------------------

/**
 * A *well-typed* downstream stage: a read-only function of upstream IR. It fully
 * traverses the tree and derives a value (here: the node count), exactly as a
 * real `cascade` / `layout` stage reads `DomTree` without writing to it.
 */
function readOnlyDownstreamStage(tree: DomTree): number {
  let count = 0;
  for (const node of tree.nodes.values()) {
    count += 1;
    count += node.children.length;
    if (node.attrs) {
      for (const _value of node.attrs.values()) count += 1;
    }
  }
  return count;
}

/**
 * A *type-erased* (hostile/buggy) downstream stage. Through `unknown`/cast it
 * tries every forbidden in-place mutation on each reachable object/array. With
 * `deepFreeze` in place these throw (strict mode) or no-op, so the IR is left
 * structurally unchanged. The throws are swallowed so the "stage" runs to
 * completion — what matters is that the upstream IR survives intact.
 */
function mutationAttemptingDownstreamStage(value: unknown, seen: Set<object> = new Set()): void {
  if (value === null || typeof value !== "object") return;
  const obj = value;
  if (seen.has(obj)) return;
  seen.add(obj);

  if (Array.isArray(value)) {
    const arr = value as unknown[];
    try {
      arr.push("__tamper__");
    } catch {
      /* mutation correctly rejected by Object.freeze */
    }
    try {
      if (arr.length > 0) (arr as Record<number, unknown>)[0] = "__tamper__";
    } catch {
      /* mutation correctly rejected by Object.freeze */
    }
    for (const item of value) mutationAttemptingDownstreamStage(item, seen);
    return;
  }

  if (value instanceof Map) {
    for (const [k, v] of value) {
      mutationAttemptingDownstreamStage(k, seen);
      mutationAttemptingDownstreamStage(v, seen);
    }
    return;
  }

  const rec = value as Record<string, unknown>;
  try {
    rec["__tamper__"] = "__tamper__";
  } catch {
    /* mutation correctly rejected by Object.freeze */
  }
  for (const key of Object.keys(rec)) {
    const current = rec[key];
    try {
      rec[key] = "__tamper__";
    } catch {
      /* mutation correctly rejected by Object.freeze */
    }
    mutationAttemptingDownstreamStage(current, seen);
  }
}

/** Collect every reachable object/array/Map/Set, to assert all are frozen. */
function collectReachable(value: unknown, acc: object[] = [], seen: Set<object> = new Set()): object[] {
  if (value === null || typeof value !== "object") return acc;
  const obj = value;
  if (seen.has(obj)) return acc;
  seen.add(obj);
  acc.push(obj);

  if (Array.isArray(value)) {
    for (const item of value) collectReachable(item, acc, seen);
    return acc;
  }
  if (value instanceof Map) {
    for (const [k, v] of value) {
      collectReachable(k, acc, seen);
      collectReachable(v, acc, seen);
    }
    return acc;
  }
  if (value instanceof Set) {
    for (const v of value) collectReachable(v, acc, seen);
    return acc;
  }
  const rec = value as Record<string, unknown>;
  for (const key of Object.keys(rec)) collectReachable(rec[key], acc, seen);
  return acc;
}

// ---------------------------------------------------------------------------
// Property 1: IR 不可变性 (IR immutability)
// **Validates: Requirements 3.2**
// ---------------------------------------------------------------------------
void test("Property 1: IR immutability — downstream stage leaves upstream IR unchanged (Req 3.2)", () => {
  fc.assert(
    fc.property(arbDomTree(), (tree) => {
      const hashBefore = structuralHash(tree);

      // (1) A well-typed, read-only downstream stage runs over the IR.
      readOnlyDownstreamStage(tree);
      // (2) Even a type-erased stage attempts every forbidden mutation.
      mutationAttemptingDownstreamStage(tree);

      // Reference is preserved: deepFreeze returned the same object, and the
      // stages never replaced it.
      assert.equal(deepFreeze(tree), tree);
      // Every reachable object/array is frozen (runtime backstop).
      for (const reachable of collectReachable(tree)) {
        assert.ok(Object.isFrozen(reachable), "every reachable IR object must be frozen");
      }
      // Structural content is unchanged after the downstream stages ran.
      assert.equal(structuralHash(tree), hashBefore);
    }),
    { numRuns: NUM_RUNS },
  );
});

// ---------------------------------------------------------------------------
// Unit tests — concrete examples and edge cases that complement the property.
// ---------------------------------------------------------------------------
void test("design reference example: structuralHash(tree) is identical before and after a stage", () => {
  const root = nodeId(0);
  const child = nodeId(1);
  const nodes = new Map<NodeId, DomNode>([
    [root, { id: root, kind: "element", tag: "div", attrs: new Map(), children: [child], parent: null }],
    [child, { id: child, kind: "text", text: "hello", children: [], parent: root }],
  ]);
  const tree = deepFreeze({ root, nodes } as unknown as DomTree);

  const before = structuralHash(tree);
  readOnlyDownstreamStage(tree);
  mutationAttemptingDownstreamStage(tree);
  assert.equal(structuralHash(tree), before);
});

void test("deepFreeze returns the same reference and freezes nested objects, arrays, and Maps", () => {
  const root = nodeId(0);
  const nodes = new Map<NodeId, DomNode>([
    [root, { id: root, kind: "element", tag: "div", attrs: new Map([["class", "x"]]), children: [], parent: null }],
  ]);
  const tree = { root, nodes } as unknown as DomTree;

  assert.equal(deepFreeze(tree), tree, "deepFreeze must return the same reference");
  assert.ok(Object.isFrozen(tree));
  assert.ok(Object.isFrozen(tree.nodes));
  const node = tree.nodes.get(root);
  assert.ok(node !== undefined);
  assert.ok(Object.isFrozen(node));
  assert.ok(Object.isFrozen(node.children));
  assert.ok(node.attrs !== undefined && Object.isFrozen(node.attrs));
});

void test("attempting to mutate a frozen IR object throws and does not change structure", () => {
  const root = nodeId(0);
  const nodes = new Map<NodeId, DomNode>([
    [root, { id: root, kind: "element", tag: "div", attrs: new Map(), children: [], parent: null }],
  ]);
  const tree = deepFreeze({ root, nodes } as unknown as DomTree);
  const node = tree.nodes.get(root);
  assert.ok(node !== undefined);

  // Assigning a property of a frozen object throws in strict mode (ESM).
  assert.throws(() => {
    (node as unknown as Record<string, unknown>)["tag"] = "span";
  }, TypeError);
  assert.equal(node.tag, "div", "structure must be unchanged after a rejected mutation");
});
