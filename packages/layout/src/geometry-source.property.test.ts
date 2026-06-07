/**
 * Property 3: 几何来源唯一 (geometry single source) — design.md §9.2.
 *
 * **Validates: Requirements 3.4**
 *
 * > ∀ node:  gBCR(node) === layout(node).box.borderBox
 * > (getBoundingClientRect equals the node's FragmentTree borderBox — geometry's
 * >  single source.)
 *
 * This is the executable form of Requirement 3.4 ("WHEN getBoundingClientRect is
 * requested for a node, the Engine SHALL derive the returned rectangle from that
 * node's FragmentTree borderBox") and the direct counter-assertion to v0 bug#2,
 * where `getBoundingClientRect` reverse-read the WRONG field off the cascade
 * product instead of the layout product. The property proves the rectangle comes
 * **solely** from the {@link FragmentTree}: for an arbitrary DOM tree + an
 * arbitrary ComputedStyle assignment, we lay the document out and then, for
 * EVERY laid-out fragment, assert that `getBoundingClientRect(tree, node)` is
 * exactly that fragment's `box.borderBox`. Since `ComputedStyle` carries no
 * geometry at all (Requirement 3.3), there is no other field the rectangle could
 * have come from — the FragmentTree's borderBox is the single source.
 *
 * A companion property pins the documented absent-node case: a `display:none`
 * element (and its skipped subtree) has no fragment, so its rectangle is the
 * web-platform zero `DOMRect`.
 *
 * ## What is quantified
 *
 * fast-check generates, under ∀:
 *   - an arbitrary document whose descendants mix elements (each carrying an
 *     arbitrary Phase 1 ComputedStyle: display / width / height / margin /
 *     font-size), text nodes, and comment nodes, nested to a bounded depth, and
 *   - the per-node ComputedStyle table that the layout stage reads through its
 *     injected `computedStyleOf` callback.
 *
 * Because each DOM node produces at most one fragment and node ids are unique,
 * the fragment found by `getBoundingClientRect` for a given node id is exactly
 * that node's fragment — so the assertion is the literal Property-3 identity.
 *
 * ## Import surface (stage boundary — `local/no-cross-stage-import`)
 *
 * Layout is a *stage* package, so this test imports ONLY the frozen IR
 * (`@browser-engine/ir`) and the package under test (`layout` +
 * `getBoundingClientRect`, both re-exported from `./index.js`) — never the
 * html-parser or cascade. The DomTree input and the ComputedStyle table are
 * assembled here by hand as frozen IR values, exactly the shape the upstream
 * stages emit.
 *
 * Built by `tsc` then run with: `node --test packages/layout/dist/*.test.js`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { deepFreeze, nodeId, px } from "@browser-engine/ir";
import type {
  Color,
  ComputedStyle,
  DisplayValue,
  DomNode,
  DomTree,
  Edges,
  Fragment,
  FragmentTree,
  NodeId,
  Px,
  Rect,
} from "@browser-engine/ir";

import { getBoundingClientRect, layout } from "./index.js";

const NUM_RUNS = 200;

// ---------------------------------------------------------------------------
// Generated-scenario model.
//
// A scenario is a document's list of child node specs. An element spec carries
// its own ComputedStyle and (recursively) its children; text / comment specs
// are leaves. Walking the spec assigns each node a unique NodeId and fills both
// the DomTree and the per-node ComputedStyle table.
// ---------------------------------------------------------------------------

/** A generated Phase 1 style for one element. */
interface StyleSpec {
  readonly display: DisplayValue;
  readonly width: number | "auto";
  readonly height: number | "auto";
  readonly margin: Edges<Px>;
  readonly fontSize: number;
}

interface ElementSpec {
  readonly kind: "element";
  readonly tag: string;
  readonly style: StyleSpec;
  readonly children: readonly NodeSpec[];
}
interface TextSpec {
  readonly kind: "text";
  readonly text: string;
}
interface CommentSpec {
  readonly kind: "comment";
  readonly text: string;
}
type NodeSpec = ElementSpec | TextSpec | CommentSpec;

// ---------------------------------------------------------------------------
// ComputedStyle builders — frozen, geometry-free (mirrors the layout package's
// own tests; kept local so this file is self-contained).
// ---------------------------------------------------------------------------

const BLACK: Color = { r: 0, g: 0, b: 0, a: 1 };
const TRANSPARENT: Color = { r: 0, g: 0, b: 0, a: 0 };
const ZERO_EDGES: Edges<Px> = { top: px(0), right: px(0), bottom: px(0), left: px(0) };

/** Build a frozen, geometry-free ComputedStyle from a style spec. */
function makeStyle(spec: StyleSpec): ComputedStyle {
  const style = {
    display: spec.display,
    color: BLACK,
    fontSize: px(spec.fontSize),
    margin: spec.margin,
    width: spec.width,
    height: spec.height,
    backgroundColor: TRANSPARENT,
  };
  return deepFreeze(style as unknown as ComputedStyle);
}

/** The Phase 1 initial style used for nodes with no spec (text / comment / document). */
const FALLBACK_STYLE: ComputedStyle = makeStyle({
  display: "inline",
  width: "auto",
  height: "auto",
  margin: ZERO_EDGES,
  fontSize: 16,
});

/** A `display:none` style, for the absent-node companion property. */
const NONE_STYLE_SPEC: StyleSpec = {
  display: "none",
  width: "auto",
  height: "auto",
  margin: ZERO_EDGES,
  fontSize: 16,
};

/** The web-platform zero `DOMRect` a non-laid-out node reports (design.md §8.4). */
const ZERO_RECT: Rect = { x: px(0), y: px(0), width: px(0), height: px(0) };

// ---------------------------------------------------------------------------
// Scenario → frozen IR.
// ---------------------------------------------------------------------------

interface BuiltDoc {
  readonly dom: DomTree;
  readonly styleOf: (node: NodeId) => ComputedStyle;
}

/**
 * Assemble a document (`nodeId(0)`) whose children are the given specs into a
 * frozen DomTree plus the `computedStyleOf` callback layout reads. Element specs
 * contribute their ComputedStyle to the table; text / comment / document nodes
 * fall back to the Phase 1 initial style.
 */
function buildDoc(children: readonly NodeSpec[]): BuiltDoc {
  const nodes = new Map<NodeId, DomNode>();
  const styleMap = new Map<NodeId, ComputedStyle>();
  let counter = 0;

  function walk(spec: NodeSpec, parent: NodeId): NodeId {
    const id = nodeId(counter++);
    if (spec.kind === "text" || spec.kind === "comment") {
      nodes.set(id, { id, kind: spec.kind, text: spec.text, children: [], parent });
      return id;
    }
    // element: assign id first so descendants can reference it as parent.
    const childIds = spec.children.map((child) => walk(child, id));
    nodes.set(id, {
      id,
      kind: "element",
      tag: spec.tag,
      attrs: new Map<string, string>(),
      children: childIds,
      parent,
    });
    styleMap.set(id, makeStyle(spec.style));
    return id;
  }

  const docId = nodeId(counter++); // root document = nodeId(0).
  const childIds = children.map((child) => walk(child, docId));
  nodes.set(docId, { id: docId, kind: "document", children: childIds, parent: null });

  const dom = deepFreeze({ root: docId, nodes } as unknown as DomTree);
  const styleOf = (node: NodeId): ComputedStyle => styleMap.get(node) ?? FALLBACK_STYLE;
  return { dom, styleOf };
}

/** Find the fragment whose back-reference is `node` (or undefined). */
function fragmentOf(tree: FragmentTree, node: NodeId): Fragment | undefined {
  for (const frag of tree.fragments.values()) {
    if (frag.node === node) return frag;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Arbitraries.
// ---------------------------------------------------------------------------

const TAGS = ["div", "span", "p", "section", "a"] as const;

/** A length that is either `auto` (the initial value) or a non-negative px length. */
const lengthArb: fc.Arbitrary<number | "auto"> = fc.oneof(
  fc.constant<"auto">("auto"),
  fc.integer({ min: 0, max: 400 }),
);

const edgeArb: fc.Arbitrary<Px> = fc.integer({ min: 0, max: 40 }).map(px);

const marginArb: fc.Arbitrary<Edges<Px>> = fc.record({
  top: edgeArb,
  right: edgeArb,
  bottom: edgeArb,
  left: edgeArb,
});

const styleArb: fc.Arbitrary<StyleSpec> = fc.record({
  display: fc.constantFrom<DisplayValue>("block", "inline", "inline-block", "flex", "grid", "none"),
  width: lengthArb,
  height: lengthArb,
  margin: marginArb,
  fontSize: fc.integer({ min: 0, max: 48 }),
});

const textSpecArb: fc.Arbitrary<NodeSpec> = fc.record({
  kind: fc.constant<"text">("text"),
  text: fc.string(),
});

const commentSpecArb: fc.Arbitrary<NodeSpec> = fc.record({
  kind: fc.constant<"comment">("comment"),
  text: fc.string(),
});

/** A recursive node spec: an element (with style + children), text, or comment. */
const { node: nodeSpecArb } = fc.letrec<{ node: NodeSpec }>((tie) => ({
  node: fc.oneof(
    { maxDepth: 3, depthSize: "small" },
    textSpecArb,
    commentSpecArb,
    fc.record({
      kind: fc.constant<"element">("element"),
      tag: fc.constantFrom(...TAGS),
      style: styleArb,
      children: fc.array(tie("node"), { maxLength: 3 }),
    }),
  ),
}));

/** A document's child list — the top-level scenario the property quantifies over. */
const docArb: fc.Arbitrary<readonly NodeSpec[]> = fc.array(nodeSpecArb, { maxLength: 4 });

// ---------------------------------------------------------------------------
// Property 3: 几何来源唯一 (geometry single source)
// **Validates: Requirements 3.4**
// ---------------------------------------------------------------------------
void test("Property 3: ∀ laid-out node, gBCR(node) === its FragmentTree fragment's box.borderBox (Req 3.4)", () => {
  fc.assert(
    fc.property(docArb, (children) => {
      const { dom, styleOf } = buildDoc(children);
      const tree = layout(dom, styleOf);

      // ∀ fragment: the rectangle getBoundingClientRect returns for that node is
      // exactly the fragment's borderBox — geometry's single source. The deep
      // equality is the design's `rectEqual`; the reference identity is the
      // stronger statement that the value is literally the FragmentTree's
      // borderBox and not a copy derived from anywhere else.
      for (const frag of tree.fragments.values()) {
        const rect = getBoundingClientRect(tree, frag.node);
        assert.deepEqual(rect, frag.box.borderBox);
        assert.equal(rect, frag.box.borderBox);
      }
    }),
    { numRuns: NUM_RUNS },
  );
});

// ---------------------------------------------------------------------------
// Property 3 (absent node): a display:none node (and its skipped subtree)
// reports the documented zero rect (design.md §8.4; Requirement 3.4).
// ---------------------------------------------------------------------------
void test("Property 3: a display:none node and its subtree report the documented zero rect (Req 3.4)", () => {
  fc.assert(
    fc.property(fc.array(nodeSpecArb, { maxLength: 3 }), (subtree) => {
      // document → div(display:none){ arbitrary subtree }. The none element and
      // its entire subtree are skipped, so ONLY the document lays out.
      const { dom, styleOf } = buildDoc([
        { kind: "element", tag: "div", style: NONE_STYLE_SPEC, children: subtree },
      ]);
      const tree = layout(dom, styleOf);

      // Every node except the document produced no fragment ⇒ zero rect.
      for (const node of dom.nodes.values()) {
        if (node.kind === "document") continue;
        assert.equal(fragmentOf(tree, node.id), undefined);
        assert.deepEqual(getBoundingClientRect(tree, node.id), ZERO_RECT);
      }
    }),
    { numRuns: NUM_RUNS },
  );
});

// ---------------------------------------------------------------------------
// Concrete examples — deterministic anchors that complement the property.
// ---------------------------------------------------------------------------

void test("example: a laid-out block's gBCR is exactly its fragment's borderBox (Req 3.4)", () => {
  const { dom, styleOf } = buildDoc([
    {
      kind: "element",
      tag: "div",
      style: { display: "block", width: 120, height: 50, margin: ZERO_EDGES, fontSize: 16 },
      children: [],
    },
  ]);
  const tree = layout(dom, styleOf);

  const div = fragmentOf(tree, nodeId(1));
  assert.ok(div !== undefined);
  const rect = getBoundingClientRect(tree, nodeId(1));
  assert.deepEqual(rect, div.box.borderBox);
  assert.equal(rect, div.box.borderBox); // single source: the very same object.
  assert.equal(rect.width, px(120));
  assert.equal(rect.height, px(50));
});

void test("example: a display:none node returns the zero rect (Req 3.4)", () => {
  const { dom, styleOf } = buildDoc([
    {
      kind: "element",
      tag: "div",
      style: NONE_STYLE_SPEC,
      children: [{ kind: "text", text: "hidden" }],
    },
  ]);
  const tree = layout(dom, styleOf);

  assert.equal(fragmentOf(tree, nodeId(1)), undefined);
  assert.deepEqual(getBoundingClientRect(tree, nodeId(1)), ZERO_RECT);
});
