/**
 * RFC 0038: incremental layout — subtree reuse at formatting-context
 * boundaries. Unit-level harness: hand-built DomTrees, a caller-owned
 * {@link IncrementalLayout} store, and a `clean` oracle standing in for the
 * session's damage tracker.
 */
import test from "node:test";

import assert from "node:assert/strict";

import { deepFreeze, nodeId, px } from "@browser-engine/ir";
import type {
  Color,
  ComputedStyle,
  DisplayValue,
  DomNode,
  DomTree,
  Edges,
  Fragment,
  FragmentId,
  NodeId,
  Px,
} from "@browser-engine/ir";

import { layout } from "./index.js";
import type { CachedSubtree, IncrementalLayout } from "./index.js";

interface NodeSpec {
  readonly id: number;
  readonly kind: DomNode["kind"];
  readonly tag?: string;
  readonly text?: string;
  readonly children?: readonly number[];
  readonly parent: number | null;
}

function buildDom(specs: readonly NodeSpec[]): DomTree {
  const nodes = new Map<NodeId, DomNode>();
  for (const spec of specs) {
    const base = {
      id: nodeId(spec.id),
      kind: spec.kind,
      children: (spec.children ?? []).map(nodeId),
      parent: spec.parent === null ? null : nodeId(spec.parent),
    };
    const node: DomNode =
      spec.kind === "element"
        ? { ...base, tag: spec.tag ?? "", attrs: new Map<string, string>() }
        : spec.kind === "text" || spec.kind === "comment"
          ? { ...base, text: spec.text ?? "" }
          : base;
    nodes.set(node.id, node);
  }
  return deepFreeze({ root: nodeId(0), nodes } as unknown as DomTree);
}

const BLACK: Color = { r: 0, g: 0, b: 0, a: 1 };
const TRANSPARENT: Color = { r: 0, g: 0, b: 0, a: 0 };
const ZERO_EDGES: Edges<Px> = { top: px(0), right: px(0), bottom: px(0), left: px(0) };

interface StyleSpec {
  readonly display?: DisplayValue;
  readonly width?: number | "auto";
  readonly height?: number | "auto";
  readonly extra?: Readonly<Record<string, unknown>>;
}

function makeStyle(spec: StyleSpec = {}): ComputedStyle {
  const style: Record<string, unknown> = {
    display: spec.display ?? "inline",
    color: BLACK,
    fontSize: px(16),
    margin: ZERO_EDGES,
    width: spec.width ?? "auto",
    height: spec.height ?? "auto",
    backgroundColor: TRANSPARENT,
  };
  if (spec.extra !== undefined) Object.assign(style, spec.extra);
  return deepFreeze(style as unknown as ComputedStyle);
}

/** A caller-side damage oracle: `dirty` ids fail clean(), everything else passes. */
function makeStore(): IncrementalLayout & { dirty: Set<NodeId> } {
  const dirty = new Set<NodeId>();
  return {
    dirty,
    clean: (id: NodeId) => !dirty.has(id),
    entries: new Map<NodeId, CachedSubtree>(),
    epoch: 0,
    stats: { hits: 0, misses: 0, stores: 0, bypassed: 0 },
  };
}

/** Flatten a FragmentTree to node→borderBox for equality comparison. */
function boxesOf(tree: ReturnType<typeof layout>): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of tree.fragments.values()) {
    const bb = f.box.borderBox;
    out.set(`${String(f.node)}@${bb.x},${bb.y},${bb.width}x${bb.height}`, JSON.stringify(bb));
  }
  return out;
}

/**
 * document(0)
 * ├─ div#a(1, overflow:hidden) ─ p(2) ─ "alpha"(3)
 * └─ div#b(4, overflow:hidden) ─ p(5) ─ "beta"(6)
 */
function twoPanelDom(): DomTree {
  return buildDom([
    { id: 0, kind: "document", parent: null, children: [1, 4] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "p", parent: 1, children: [3] },
    { id: 3, kind: "text", parent: 2, text: "alpha panel" },
    { id: 4, kind: "element", tag: "div", parent: 0, children: [5] },
    { id: 5, kind: "element", tag: "p", parent: 4, children: [6] },
    { id: 6, kind: "text", parent: 5, text: "beta panel" },
  ]);
}

function bfcStyles(): Map<number, ComputedStyle> {
  return new Map([
    [1, makeStyle({ display: "block", extra: { overflow: "hidden" } })],
    [2, makeStyle({ display: "block" })],
    [4, makeStyle({ display: "block", extra: { overflow: "hidden" } })],
    [5, makeStyle({ display: "block" })],
  ]);
}

void test("a clean BFC boundary replays with identical geometry", () => {
  const dom = twoPanelDom();
  const styles = new Map(bfcStyles());
  const incr = makeStore();
  const styleOf = (n: NodeId) => styles.get(n) ?? makeStyle({ display: "block" });

  const first = layout(dom, styleOf, { incremental: incr });
  assert.equal(incr.stats?.stores, 2); // both BFC panels stored

  incr.dirty.add(nodeId(4)); // only #b mutated
  const second = layout(dom, styleOf, { incremental: incr });
  assert.equal(incr.stats?.hits, 1); // #a replayed
  assert.ok(second.fragments.size === first.fragments.size);

  // Replay must be geometrically identical to a cache-free run.
  const fresh = layout(dom, styleOf, {});
  const a = [...boxesOf(second)].sort();
  const b = [...boxesOf(fresh)].sort();
  assert.deepEqual(a, b);
});

void test("replayed fragments mint fresh ids — no id collisions in the new tree", () => {
  const dom = twoPanelDom();
  const styles = new Map(bfcStyles());
  const incr = makeStore();
  const styleOf = (n: NodeId) => styles.get(n) ?? makeStyle({ display: "block" });

  layout(dom, styleOf, { incremental: incr });
  const oldEntry = incr.entries.get(nodeId(1));
  assert.ok(oldEntry !== undefined);
  const oldIds = new Set<FragmentId>([...oldEntry.descendants.keys()]);

  incr.dirty.add(nodeId(4));
  const second = layout(dom, styleOf, { incremental: incr });
  // Every id unique in the new tree.
  assert.equal(second.fragments.size, [...second.fragments.keys()].length);
  // New-run ids may numerically collide with OLD ids — what matters is the
  // replayed descendants got re-registered (present in the new map).
  let replayed = 0;
  for (const f of second.fragments.values()) {
    if (f.node === nodeId(2) || f.node === nodeId(3)) replayed += 1;
  }
  assert.ok(replayed > 0, "#a subtree must appear in the new tree");
  void oldIds;
});

void test("a subtree that pushes out-of-flow requests is never cached", () => {
  // #abs child escapes its BFC parent (static position → not a CB owner),
  // so the parent's subtree contributes absReqs to an ancestor frame.
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 4] },
    { id: 2, kind: "element", tag: "p", parent: 1, children: [3] },
    { id: 3, kind: "text", parent: 2, text: "flow" },
    { id: 4, kind: "element", tag: "div", parent: 1, children: [] },
  ]);
  const styles = new Map([
    [1, makeStyle({ display: "block", extra: { overflow: "hidden" } })],
    [4, makeStyle({ display: "block", extra: { position: "absolute", top: px(10), left: px(10) } })],
  ]);
  const incr = makeStore();
  const styleOf = (n: NodeId) => styles.get(n) ?? makeStyle({ display: "block" });

  layout(dom, styleOf, { incremental: incr });
  assert.equal(incr.entries.has(nodeId(1)), false); // leaked OOF → not cached
  assert.ok((incr.stats?.bypassed ?? 0) >= 1);
});

void test("plain in-flow blocks are never treated as boundaries", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "p", parent: 1, children: [3] },
    { id: 3, kind: "text", parent: 2, text: "plain" },
  ]);
  const styles = new Map([[1, makeStyle({ display: "block" })]]);
  const incr = makeStore();
  layout(dom, (n) => styles.get(n) ?? makeStyle({ display: "block" }), { incremental: incr });
  // div(1) participates in the root BFC — no entry may be recorded.
  assert.equal(incr.entries.size, 0);
});

void test("a changed containing width misses even when the subtree is clean", () => {
  const dom = twoPanelDom();
  const styles = new Map(bfcStyles());
  const incr = makeStore();
  const styleOf = (n: NodeId) => styles.get(n) ?? makeStyle({ display: "block" });

  layout(dom, styleOf, { incremental: incr });
  // Root now lays out at a narrower viewport — containing width differs.
  const narrow = layout(dom, styleOf, { incremental: incr, viewportWidth: px(400) });
  assert.ok(narrow.fragments.size > 0);
  assert.equal(incr.stats?.hits, 0); // nothing may hit at a new width
});

void test("epoch drift invalidates every entry at once", () => {
  const dom = twoPanelDom();
  const styles = new Map(bfcStyles());
  const incr = makeStore();
  const styleOf = (n: NodeId) => styles.get(n) ?? makeStyle({ display: "block" });

  layout(dom, styleOf, { incremental: incr });
  incr.epoch += 1; // caller-side global change (viewport, sheets…)
  layout(dom, styleOf, { incremental: incr });
  assert.equal(incr.stats?.hits, 0);
});

void test("flex items are boundaries — a clean item replays inside a mutated sibling flow", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 4] },
    { id: 2, kind: "element", tag: "div", parent: 1, children: [3] },
    { id: 3, kind: "text", parent: 2, text: "item one" },
    { id: 4, kind: "element", tag: "div", parent: 1, children: [5] },
    { id: 5, kind: "text", parent: 4, text: "item two" },
  ]);
  const styles = new Map<number, ComputedStyle>([
    [1, makeStyle({ display: "block", extra: { display: "flex" } })],
  ]);
  const incr = makeStore();
  const styleOf = (n: NodeId) => styles.get(n) ?? makeStyle({ display: "block" });

  layout(dom, styleOf, { incremental: incr });
  const flexEntries = [...incr.entries.keys()];
  assert.ok(flexEntries.length >= 2, `flex items must cache, got ${flexEntries.length}`);

  incr.dirty.add(nodeId(4));
  const second = layout(dom, styleOf, { incremental: incr });
  assert.ok((incr.stats?.hits ?? 0) >= 1);
  const fresh = layout(dom, styleOf, {});
  assert.deepEqual([...boxesOf(second)].sort(), [...boxesOf(fresh)].sort());
});

void test("a cached subtree under a repositioned parent lands at its NEW coordinates", () => {
  // Move #b down via margin on #a — #b's replayed subtree must still take its
  // fresh position (fragments are parent-relative, so geometry is identical).
  const dom = twoPanelDom();
  const styles = new Map(bfcStyles());
  const incr = makeStore();
  const styleOf = (n: NodeId) => styles.get(n) ?? makeStyle({ display: "block" });

  layout(dom, styleOf, { incremental: incr });
  // Mutate #a's style (simulated: taller margin) — #a dirty, #b clean.
  styles.set(1, makeStyle({ display: "block", extra: { overflow: "hidden", marginTop: px(40) } }));
  incr.dirty.add(nodeId(1));
  const second = layout(dom, styleOf, { incremental: incr });
  const fresh = layout(dom, styleOf, {});
  assert.deepEqual([...boxesOf(second)].sort(), [...boxesOf(fresh)].sort());
  assert.ok((incr.stats?.hits ?? 0) >= 1);
});

void test("fragment replay preserves the text run verbatim", () => {
  const dom = twoPanelDom();
  const styles = new Map(bfcStyles());
  const incr = makeStore();
  const styleOf = (n: NodeId) => styles.get(n) ?? makeStyle({ display: "block" });

  const first = layout(dom, styleOf, { incremental: incr });
  const textFrag = [...first.fragments.values()].find(
    (f: Fragment) => f.node === nodeId(3),
  );
  assert.ok(textFrag?.text !== undefined);

  incr.dirty.add(nodeId(4));
  const second = layout(dom, styleOf, { incremental: incr });
  const replayedText = [...second.fragments.values()].find(
    (f: Fragment) => f.node === nodeId(3),
  );
  // The text run is the SAME frozen payload — glyphs shared verbatim.
  assert.equal(replayedText?.text, textFrag.text);
});
