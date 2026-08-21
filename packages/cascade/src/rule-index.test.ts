/**
 * Tests for the RuleIndex — the SOLE selector-matching entry point (task 5.3;
 * design.md §8.3; Requirements 4.1, 4.2, 4.4, 15.2).
 *
 * These tests prove the four guarantees of the indexed matcher:
 *
 *   1. **Bucketing correctness.** Each rule is filed into the bucket of its
 *      rightmost compound under the preference id > class > tag > universal,
 *      and a selector list files a rule into one bucket per entry.
 *
 *   2. **Brute-force equivalence (Req 4.3 — the invariant task 5.4 formalises
 *      as Property 4).** For many DOM/stylesheet/node combinations — including
 *      the new structural pseudo-classes — `matchRulesFor` returns EXACTLY the
 *      same rules, in the same document order, as the exhaustive
 *      `matchRulesByScan`. A fast-check property generalises this over
 *      arbitrary inputs; it complements (does not replace) the formal Property
 *      4 of task 5.4.
 *
 *   3. **Complexity (Req 4.4).** A node's candidate set is drawn ONLY from its
 *      own index buckets (`byTag[tag] ∪ universal ∪ byId[id] ∪ byClass[c]`),
 *      never the whole rule table — so candidate evaluations scale below
 *      total-rules × total-elements.
 *
 *   4. **Pseudo-class support (Req 15.2).** `:root`, `:first-child`,
 *      `:last-child` match exactly the DOM-decidable elements, and the cascade
 *      (which now routes through the index) produces correct ComputedStyle.
 *
 * The cascade is a *stage* package, so (per `local/no-cross-stage-import`) this
 * test imports ONLY the frozen IR and the package under test. DomTree /
 * StyleSheet inputs are assembled by hand as frozen IR, exactly the shape the
 * upstream stages emit.
 *
 * Built by `tsc` then run with: `node --test packages/cascade/dist/*.test.js`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { deepFreeze, nodeId } from "@browser-engine/ir";
import type {
  Color,
  Declaration,
  DomNode,
  DomTree,
  NodeId,
  Specificity,
  StyleRule,
  StyleSheet,
} from "@browser-engine/ir";

import { cascade } from "./index.js";
import {
  buildRuleIndex,
  candidateRulesFor,
  matchRulesByScan,
  matchRulesFor,
} from "./rule-index.js";
import type { RuleIndex } from "./rule-index.js";

// ---------------------------------------------------------------------------
// IR builders — assemble frozen DomTree / StyleSheet inputs by hand.
// ---------------------------------------------------------------------------

interface NodeSpec {
  readonly id: number;
  readonly kind: DomNode["kind"];
  readonly tag?: string;
  readonly attrs?: Readonly<Record<string, string>>;
  readonly text?: string;
  readonly children?: readonly number[];
  readonly parent: number | null;
}

/** Build a frozen DomTree from a flat list of node specs (root id 0). */
function buildDom(specs: readonly NodeSpec[]): DomTree {
  const nodes = new Map<NodeId, DomNode>();
  for (const spec of specs) {
    const base = {
      id: nodeId(spec.id),
      kind: spec.kind,
      children: (spec.children ?? []).map(nodeId),
      parent: spec.parent === null ? null : nodeId(spec.parent),
    };
    let node: DomNode;
    if (spec.kind === "element") {
      node = { ...base, tag: spec.tag ?? "", attrs: new Map(Object.entries(spec.attrs ?? {})) };
    } else if (spec.kind === "text" || spec.kind === "comment") {
      node = { ...base, text: spec.text ?? "" };
    } else {
      node = base;
    }
    nodes.set(node.id, node);
  }
  return deepFreeze({ root: nodeId(0), nodes } as unknown as DomTree);
}

interface RuleSpec {
  /** One selector, or a comma list of selectors sharing the block. */
  readonly selector: string | readonly string[];
  readonly specificity: Specificity;
  readonly declarations: readonly { property: string; value: string; important?: boolean }[];
}

/** Build a frozen StyleSheet, assigning each rule a source order in array order. */
function buildSheet(rules: readonly RuleSpec[]): StyleSheet {
  const styleRules: StyleRule[] = rules.map((r, order) => {
    const selectors = typeof r.selector === "string" ? [r.selector] : r.selector;
    const declarations: Declaration[] = r.declarations.map((d) => ({
      property: d.property,
      value: d.value,
      important: d.important ?? false,
    }));
    return {
      selector: selectors.map((text) => ({ text })),
      declarations,
      specificity: r.specificity,
      order,
    };
  });
  return deepFreeze({ rules: styleRules } as unknown as StyleSheet);
}

// A document used across several cases:
//   document(0)
//     └─ div#main.box.row (1)
//          ├─ span.row (2)        ← first element child
//          ├─ text (3)
//          └─ p#para.row (4)      ← last element child
const DOM = buildDom([
  { id: 0, kind: "document", parent: null, children: [1] },
  { id: 1, kind: "element", tag: "div", attrs: { id: "main", class: "box row" }, parent: 0, children: [2, 3, 4] },
  { id: 2, kind: "element", tag: "span", attrs: { class: "row" }, parent: 1, children: [] },
  { id: 3, kind: "text", text: "x", parent: 1, children: [] },
  { id: 4, kind: "element", tag: "p", attrs: { id: "para", class: "row" }, parent: 1, children: [] },
]);

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** The set of `order` values present in a bucket (so we can name rules by order). */
function ordersIn(index: RuleIndex, bucket: "universal" | { id: string } | { cls: string } | { tag: string }): number[] {
  let rules: readonly { order: number }[];
  if (bucket === "universal") {
    rules = index.universal;
  } else if ("id" in bucket) {
    rules = index.byId.get(bucket.id) ?? [];
  } else if ("cls" in bucket) {
    rules = index.byClass.get(bucket.cls) ?? [];
  } else {
    rules = index.byTag.get(bucket.tag) ?? [];
  }
  return rules.map((r) => r.order).sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// 1) Bucketing correctness (design.md §8.3).
// ---------------------------------------------------------------------------

void test("rules bucket by their rightmost compound: id > class > tag > universal", () => {
  const sheet = buildSheet([
    { selector: "div", specificity: [0, 0, 1], declarations: [{ property: "color", value: "red" }] }, // 0 → byTag.div
    { selector: ".box", specificity: [0, 1, 0], declarations: [{ property: "color", value: "red" }] }, // 1 → byClass.box
    { selector: "#main", specificity: [1, 0, 0], declarations: [{ property: "color", value: "red" }] }, // 2 → byId.main
    { selector: "*", specificity: [0, 0, 0], declarations: [{ property: "color", value: "red" }] }, // 3 → universal
    { selector: "div.box#main", specificity: [1, 1, 1], declarations: [{ property: "color", value: "red" }] }, // 4 → byId.main (id wins)
    { selector: "a > .box", specificity: [0, 1, 1], declarations: [{ property: "color", value: "red" }] }, // 5 → byClass.box (rightmost)
    { selector: "section p", specificity: [0, 0, 2], declarations: [{ property: "color", value: "red" }] }, // 6 → byTag.p (rightmost)
  ]);
  const index = buildRuleIndex([sheet]);

  assert.deepEqual(ordersIn(index, { tag: "div" }), [0]);
  assert.deepEqual(ordersIn(index, { cls: "box" }), [1, 5]);
  assert.deepEqual(ordersIn(index, { id: "main" }), [2, 4]);
  assert.deepEqual(ordersIn(index, "universal"), [3]);
  assert.deepEqual(ordersIn(index, { tag: "p" }), [6]);
});

void test("a pseudo-class-only rightmost compound buckets in universal; a typed one keeps its key", () => {
  const sheet = buildSheet([
    { selector: ":root", specificity: [0, 1, 0], declarations: [{ property: "color", value: "red" }] }, // 0 → universal
    { selector: ":first-child", specificity: [0, 1, 0], declarations: [{ property: "color", value: "red" }] }, // 1 → universal
    { selector: "div:last-child", specificity: [0, 1, 1], declarations: [{ property: "color", value: "red" }] }, // 2 → byTag.div
    { selector: ".row:first-child", specificity: [0, 2, 0], declarations: [{ property: "color", value: "red" }] }, // 3 → byClass.row
  ]);
  const index = buildRuleIndex([sheet]);

  assert.deepEqual(ordersIn(index, "universal"), [0, 1]);
  assert.deepEqual(ordersIn(index, { tag: "div" }), [2]);
  assert.deepEqual(ordersIn(index, { cls: "row" }), [3]);
});

void test("a selector list files the rule into one bucket per entry (de-duped per bucket)", () => {
  const sheet = buildSheet([
    { selector: ["div", ".box", "#main"], specificity: [1, 1, 1], declarations: [{ property: "color", value: "red" }] }, // 0
    { selector: [".row", ".row"], specificity: [0, 1, 0], declarations: [{ property: "color", value: "red" }] }, // 1 (dup class → once)
  ]);
  const index = buildRuleIndex([sheet]);

  assert.deepEqual(ordersIn(index, { tag: "div" }), [0]);
  assert.deepEqual(ordersIn(index, { cls: "box" }), [0]);
  assert.deepEqual(ordersIn(index, { id: "main" }), [0]);
  // The duplicate `.row, .row` rule appears in byClass.row exactly once.
  assert.deepEqual(ordersIn(index, { cls: "row" }), [1]);
});

void test("global document order is assigned across sheets, ascending", () => {
  const a = buildSheet([{ selector: "div", specificity: [0, 0, 1], declarations: [{ property: "color", value: "red" }] }]);
  const b = buildSheet([{ selector: "div", specificity: [0, 0, 1], declarations: [{ property: "color", value: "red" }] }]);
  const index = buildRuleIndex([a, b]);
  // Sheet a's rule gets order 0, sheet b's rule order 1.
  assert.deepEqual(ordersIn(index, { tag: "div" }), [0, 1]);
});

// ---------------------------------------------------------------------------
// 2) matchRulesFor === matchRulesByScan (Req 4.3) for enumerated selectors.
// ---------------------------------------------------------------------------

/** Assert the indexed matcher returns the SAME rule references, same order, as the scan. */
function assertEquivalent(sheets: readonly StyleSheet[], dom: DomTree, node: NodeId): StyleRule[] {
  const index = buildRuleIndex(sheets);
  const viaIndex = matchRulesFor(index, dom, node);
  const viaScan = matchRulesByScan(sheets, dom, node);
  assert.equal(viaIndex.length, viaScan.length, "match count differs");
  for (let i = 0; i < viaScan.length; i++) {
    assert.equal(viaIndex[i], viaScan[i], `match #${i} differs (reference identity / order)`);
  }
  return viaIndex;
}

void test("matchRulesFor equals brute-force scan across type / class / id / combinator selectors", () => {
  const sheet = buildSheet([
    { selector: "div", specificity: [0, 0, 1], declarations: [{ property: "color", value: "red" }] },
    { selector: "span", specificity: [0, 0, 1], declarations: [{ property: "color", value: "red" }] },
    { selector: ".row", specificity: [0, 1, 0], declarations: [{ property: "color", value: "red" }] },
    { selector: ".box", specificity: [0, 1, 0], declarations: [{ property: "color", value: "red" }] },
    { selector: "#main", specificity: [1, 0, 0], declarations: [{ property: "color", value: "red" }] },
    { selector: "#para", specificity: [1, 0, 0], declarations: [{ property: "color", value: "red" }] },
    { selector: "div span", specificity: [0, 0, 2], declarations: [{ property: "color", value: "red" }] },
    { selector: "div > p", specificity: [0, 0, 2], declarations: [{ property: "color", value: "red" }] },
    { selector: "div > span", specificity: [0, 0, 2], declarations: [{ property: "color", value: "red" }] },
    { selector: "*", specificity: [0, 0, 0], declarations: [{ property: "color", value: "red" }] },
    { selector: "section p", specificity: [0, 0, 2], declarations: [{ property: "color", value: "red" }] }, // never matches
  ]);
  for (const id of [0, 1, 2, 3, 4, 99]) {
    assertEquivalent([sheet], DOM, nodeId(id));
  }
});

void test("matchRulesFor equals brute-force scan for the new pseudo-classes", () => {
  const sheet = buildSheet([
    { selector: ":root", specificity: [0, 1, 0], declarations: [{ property: "color", value: "red" }] },
    { selector: ":first-child", specificity: [0, 1, 0], declarations: [{ property: "color", value: "red" }] },
    { selector: ":last-child", specificity: [0, 1, 0], declarations: [{ property: "color", value: "red" }] },
    { selector: "div:root", specificity: [0, 1, 1], declarations: [{ property: "color", value: "red" }] },
    { selector: "span:first-child", specificity: [0, 1, 1], declarations: [{ property: "color", value: "red" }] },
    { selector: "p:last-child", specificity: [0, 1, 1], declarations: [{ property: "color", value: "red" }] },
    { selector: ".row:last-child", specificity: [0, 2, 0], declarations: [{ property: "color", value: "red" }] },
    { selector: "div > span:first-child", specificity: [0, 1, 2], declarations: [{ property: "color", value: "red" }] },
  ]);
  for (const id of [0, 1, 2, 3, 4]) {
    assertEquivalent([sheet], DOM, nodeId(id));
  }
});

// ---------------------------------------------------------------------------
// 3) Pseudo-class semantics — exact matched node sets.
// ---------------------------------------------------------------------------

/** The ids (in 1..4) whose element matches `selector` per the indexed matcher. */
function matchedElementIds(selector: string): number[] {
  const sheet = buildSheet([{ selector, specificity: [0, 1, 0], declarations: [{ property: "color", value: "red" }] }]);
  const index = buildRuleIndex([sheet]);
  const ids: number[] = [];
  for (const id of [1, 2, 3, 4]) {
    if (matchRulesFor(index, DOM, nodeId(id)).length > 0) {
      ids.push(id);
    }
  }
  return ids;
}

void test(":root matches only the document-rooted element (Req 15.2)", () => {
  // div (1) is the only element whose parent is the document node.
  assert.deepEqual(matchedElementIds(":root"), [1]);
});

void test(":first-child / :last-child skip text siblings and match element edges (Req 15.2)", () => {
  // Under div(1): span(2) is the first element child; p(4) the last (text 3 ignored).
  assert.deepEqual(matchedElementIds(":first-child"), [1, 2]); // div is first child of document, span first under div.
  assert.deepEqual(matchedElementIds(":last-child"), [1, 4]); // div is last child of document, p last under div.
});

void test("an unsupported pseudo-class never matches (out-of-subset → safe no-match)", () => {
  assert.deepEqual(matchedElementIds(":hover"), []); // dynamic state, not statically decidable.
  assert.deepEqual(matchedElementIds("::before"), []); // pseudo-element, not supported yet.
});

void test(":has() relative selector matches elements with matching descendants", () => {
  // div(1) has span(2) and p(4) as element descendants.
  assert.deepEqual(matchedElementIds(":has(span)"), [1]);
  assert.deepEqual(matchedElementIds(":has(p)"), [1]);
  // No element has a div descendant (div is the root element).
  assert.deepEqual(matchedElementIds(":has(div)"), []);
});

void test("the expanded DOM-decidable pseudo-classes match correct nodes", () => {
  // Element children of div(1): span(2) is element-index 1, p(4) is index 2 (text 3 skipped).
  assert.deepEqual(matchedElementIds(":nth-child(2)"), [4]);
  assert.deepEqual(matchedElementIds(":nth-child(odd)"), [1, 2]); // div(1) index1, span(2) index1.
  assert.deepEqual(matchedElementIds(":only-of-type"), [1, 2, 4]); // span & p are each the only one of their type.
});

// ---------------------------------------------------------------------------
// 4) Complexity (Req 4.4): candidates come ONLY from a node's buckets.
// ---------------------------------------------------------------------------

void test("a node's candidates are a subset of its own buckets, not the whole table", () => {
  const sheet = buildSheet([
    { selector: "div", specificity: [0, 0, 1], declarations: [{ property: "color", value: "red" }] }, // matches div(1)
    { selector: "span", specificity: [0, 0, 1], declarations: [{ property: "color", value: "red" }] }, // span only
    { selector: "p", specificity: [0, 0, 1], declarations: [{ property: "color", value: "red" }] }, // p only
    { selector: ".other", specificity: [0, 1, 0], declarations: [{ property: "color", value: "red" }] }, // nobody
    { selector: "#nope", specificity: [1, 0, 0], declarations: [{ property: "color", value: "red" }] }, // nobody
    { selector: "*", specificity: [0, 0, 0], declarations: [{ property: "color", value: "red" }] }, // universal
  ]);
  const index = buildRuleIndex([sheet]);

  // The div(1) candidate set must exclude span / p / .other / #nope rules:
  // only byTag.div ∪ universal ∪ byId.main ∪ (byClass.box, byClass.row) apply.
  const candidates = candidateRulesFor(index, DOM, nodeId(1));
  const candidateSelectors = candidates.map((r) => r.selector[0]?.text);
  assert.equal(candidateSelectors.includes("div"), true);
  assert.equal(candidateSelectors.includes("*"), true);
  assert.equal(candidateSelectors.includes("span"), false, "span rule must not be a div candidate");
  assert.equal(candidateSelectors.includes("p"), false, "p rule must not be a div candidate");
  assert.equal(candidateSelectors.includes(".other"), false);
  assert.equal(candidateSelectors.includes("#nope"), false);

  // And the candidate set is strictly smaller than the full rule table here.
  assert.ok(candidates.length < sheet.rules.length, "candidates must be fewer than all rules");
});

void test("candidate set is always a subset of the full rule table, and matches ⊆ candidates", () => {
  const sheet = buildSheet([
    { selector: "div span", specificity: [0, 0, 2], declarations: [{ property: "color", value: "red" }] },
    { selector: ".row", specificity: [0, 1, 0], declarations: [{ property: "color", value: "red" }] },
    { selector: "p:last-child", specificity: [0, 1, 1], declarations: [{ property: "color", value: "red" }] },
    { selector: "*", specificity: [0, 0, 0], declarations: [{ property: "color", value: "red" }] },
  ]);
  const index = buildRuleIndex([sheet]);
  const allRules = new Set(sheet.rules);
  for (const id of [1, 2, 3, 4]) {
    const candidates = candidateRulesFor(index, DOM, nodeId(id));
    const matched = matchRulesFor(index, DOM, nodeId(id));
    for (const c of candidates) {
      assert.ok(allRules.has(c), "candidate must be drawn from the rule table");
    }
    const candidateSet = new Set(candidates);
    for (const m of matched) {
      assert.ok(candidateSet.has(m), "every match must be a candidate (matches ⊆ candidates)");
    }
  }
});

// ---------------------------------------------------------------------------
// 5) The cascade (now index-routed) still produces correct ComputedStyle.
// ---------------------------------------------------------------------------

const RED: Color = { r: 255, g: 0, b: 0, a: 1 };
const GREEN: Color = { r: 0, g: 128, b: 0, a: 1 };
const BLUE: Color = { r: 0, g: 0, b: 255, a: 1 };
const BLACK: Color = { r: 0, g: 0, b: 0, a: 1 };

void test("cascade via the index resolves a :root rule onto the rooted element", () => {
  const sheet = buildSheet([{ selector: ":root", specificity: [0, 1, 0], declarations: [{ property: "color", value: "red" }] }]);
  assert.deepEqual(cascade(DOM, [sheet], nodeId(1)).color, RED); // div is :root.
  // span(2) inherits the inherited `color` from its :root ancestor div(1).
  assert.deepEqual(cascade(DOM, [sheet], nodeId(2)).color, RED);
});

void test("cascade via the index resolves :first-child / :last-child onto the right elements", () => {
  const sheet = buildSheet([
    { selector: "span:first-child", specificity: [0, 1, 1], declarations: [{ property: "color", value: "green" }] },
    { selector: "p:last-child", specificity: [0, 1, 1], declarations: [{ property: "color", value: "blue" }] },
  ]);
  assert.deepEqual(cascade(DOM, [sheet], nodeId(2)).color, GREEN); // span is first element child.
  assert.deepEqual(cascade(DOM, [sheet], nodeId(4)).color, BLUE); // p is last element child.
  // div(1) declares no color of its own and inherits initial black (its parent is the document).
  assert.deepEqual(cascade(DOM, [sheet], nodeId(1)).color, BLACK);
});

// ---------------------------------------------------------------------------
// 6) Property: matchRulesFor set-equals matchRulesByScan over arbitrary inputs.
//
// This supporting property generalises the enumerated equivalence cases above.
// It complements — and does not replace — the formal Property 4 (task 5.4,
// Validates Requirements 4.3), which owns the named correctness property.
// ---------------------------------------------------------------------------

const TAGS = ["div", "span", "p", "section"] as const;
const CLASSES = ["box", "row", "col"] as const;
const IDS = ["main", "header", "para"] as const;

interface ElementSpec {
  readonly kind: "element";
  readonly tag: string;
  readonly id: string | null;
  readonly classes: readonly string[];
  readonly children: readonly GenSpec[];
}
interface TextSpec {
  readonly kind: "text";
}
type GenSpec = ElementSpec | TextSpec;

const { node: nodeArb } = fc.letrec<{ node: GenSpec }>((tie) => ({
  node: fc.oneof(
    { maxDepth: 3, depthSize: "small" },
    fc.record({ kind: fc.constant("text" as const) }),
    fc.record({
      kind: fc.constant("element" as const),
      tag: fc.constantFrom(...TAGS),
      id: fc.option(fc.constantFrom(...IDS), { nil: null }),
      classes: fc.array(fc.constantFrom(...CLASSES), { maxLength: 2 }),
      children: fc.array(tie("node"), { maxLength: 3 }),
    }),
  ),
}));

const rootArb: fc.Arbitrary<ElementSpec> = fc.record({
  kind: fc.constant("element" as const),
  tag: fc.constantFrom(...TAGS),
  id: fc.option(fc.constantFrom(...IDS), { nil: null }),
  classes: fc.array(fc.constantFrom(...CLASSES), { maxLength: 2 }),
  children: fc.array(nodeArb, { maxLength: 4 }),
});

/** Materialize a generated element spec into a frozen DomTree (document wraps root). */
function materialize(root: ElementSpec): { readonly dom: DomTree; readonly count: number } {
  const nodes = new Map<NodeId, DomNode>();
  let counter = 0;
  const documentId = nodeId(counter++);
  function walk(spec: GenSpec, parent: NodeId): NodeId {
    const id = nodeId(counter++);
    if (spec.kind === "element") {
      const childIds = spec.children.map((c) => walk(c, id));
      const attrs = new Map<string, string>();
      if (spec.id !== null) attrs.set("id", spec.id);
      if (spec.classes.length > 0) attrs.set("class", spec.classes.join(" "));
      nodes.set(id, { id, kind: "element", tag: spec.tag, attrs, children: childIds, parent });
    } else {
      nodes.set(id, { id, kind: "text", text: "t", children: [], parent });
    }
    return id;
  }
  const rootId = walk(root, documentId);
  nodes.set(documentId, { id: documentId, kind: "document", children: [rootId], parent: null });
  return { dom: deepFreeze({ root: documentId, nodes } as unknown as DomTree), count: counter };
}

/** A compound that may carry tag/id/class plus an optional supported pseudo-class. */
const compoundArb: fc.Arbitrary<string> = fc
  .record({
    tag: fc.option(fc.constantFrom(...TAGS), { nil: null }),
    id: fc.option(fc.constantFrom(...IDS), { nil: null }),
    classes: fc.array(fc.constantFrom(...CLASSES), { maxLength: 2 }),
    pseudo: fc.option(fc.constantFrom(":root", ":first-child", ":last-child"), { nil: null }),
  })
  .map(({ tag, id, classes, pseudo }) => {
    let text = tag ?? "";
    if (id !== null) text += `#${id}`;
    for (const c of classes) text += `.${c}`;
    if (pseudo !== null) text += pseudo;
    return text.length === 0 ? "*" : text;
  });

const selectorArb: fc.Arbitrary<string> = fc.oneof(
  compoundArb,
  fc.tuple(compoundArb, fc.constantFrom(" ", " > "), compoundArb).map(([l, c, r]) => `${l}${c}${r}`),
);

const ruleArb: fc.Arbitrary<RuleSpec> = fc.record({
  selector: fc.oneof(selectorArb, fc.array(selectorArb, { minLength: 1, maxLength: 3 })),
  specificity: fc.tuple(
    fc.integer({ min: 0, max: 2 }),
    fc.integer({ min: 0, max: 2 }),
    fc.integer({ min: 0, max: 2 }),
  ),
  declarations: fc.constant([{ property: "color", value: "red" }]),
});

const sheetsArb: fc.Arbitrary<readonly (readonly RuleSpec[])[]> = fc.array(
  fc.array(ruleArb, { maxLength: 6 }),
  { minLength: 1, maxLength: 3 },
);

void test("matchRulesFor set-equals matchRulesByScan for arbitrary docs, sheets, and nodes (Req 4.3)", () => {
  fc.assert(
    fc.property(rootArb, sheetsArb, fc.nat({ max: 64 }), (rootSpec, sheetsSpec, pick) => {
      const { dom, count } = materialize(rootSpec);
      const sheets = sheetsSpec.map((rules) => buildSheet(rules));
      const node = nodeId(pick % (count + 1)); // includes one out-of-tree id.

      const index = buildRuleIndex(sheets);
      const viaIndex = matchRulesFor(index, dom, node);
      const viaScan = matchRulesByScan(sheets, dom, node);

      // Same length, same rule references in the same document order.
      assert.equal(viaIndex.length, viaScan.length);
      for (let i = 0; i < viaScan.length; i++) {
        assert.equal(viaIndex[i], viaScan[i]);
      }
    }),
    { numRuns: 300 },
  );
});

// ---------------------------------------------------------------------------
// 4) Attribute selectors + sibling combinators (the breadth expansion).
// ---------------------------------------------------------------------------

/** A form-ish DOM: div(1) → [input(2), input(3), a(4), span(5)]. */
const FORM_DOM: DomTree = buildDom([
  { id: 0, kind: "document", parent: null, children: [1] },
  { id: 1, kind: "element", tag: "div", parent: 0, children: [2, 3, 4, 5] },
  { id: 2, kind: "element", tag: "input", parent: 1, attrs: { type: "text", required: "" } },
  { id: 3, kind: "element", tag: "input", parent: 1, attrs: { type: "checkbox", checked: "", disabled: "" } },
  { id: 4, kind: "element", tag: "a", parent: 1, attrs: { href: "/x", class: "btn nav" } },
  { id: 5, kind: "element", tag: "span", parent: 1 },
]);

/** The ids (1..5) of FORM_DOM elements matching `selector` via the index. */
function formMatches(selector: string): number[] {
  const sheet = buildSheet([{ selector, specificity: [0, 1, 0], declarations: [{ property: "color", value: "red" }] }]);
  const index = buildRuleIndex([sheet]);
  const ids: number[] = [];
  for (const id of [1, 2, 3, 4, 5]) {
    if (matchRulesFor(index, FORM_DOM, nodeId(id)).length > 0) ids.push(id);
  }
  // Brute-force equivalence holds for every new feature too.
  for (const id of [0, 1, 2, 3, 4, 5]) {
    assert.deepEqual(
      matchRulesFor(index, FORM_DOM, nodeId(id)).map((r) => r.selector[0]?.text),
      matchRulesByScan([sheet], FORM_DOM, nodeId(id)).map((r) => r.selector[0]?.text),
      `index == scan for #${id} on '${selector}'`,
    );
  }
  return ids;
}

void test("attribute selectors: presence, equality, and substring operators", () => {
  assert.deepEqual(formMatches("[type]"), [2, 3]);
  assert.deepEqual(formMatches("[type=text]"), [2]);
  assert.deepEqual(formMatches('input[type="checkbox"]'), [3]);
  assert.deepEqual(formMatches('[class~="btn"]'), [4]);
  assert.deepEqual(formMatches('[href^="/"]'), [4]);
  assert.deepEqual(formMatches('[href$="x"]'), [4]);
  assert.deepEqual(formMatches('[class*="a"]'), [4]); // "nav" contains 'a'.
});

void test("attribute-state pseudo-classes read the static HTML attributes", () => {
  assert.deepEqual(formMatches(":checked"), [3]);
  assert.deepEqual(formMatches(":disabled"), [3]);
  assert.deepEqual(formMatches(":required"), [2]);
  assert.deepEqual(formMatches(":enabled"), [2]); // input2 is the only enabled control.
  assert.deepEqual(formMatches(":any-link"), [4]);
});

void test("sibling combinators: adjacent (+) and general (~)", () => {
  assert.deepEqual(formMatches("input + input"), [3]); // input3 immediately follows input2.
  assert.deepEqual(formMatches("a + span"), [5]);
  assert.deepEqual(formMatches("input ~ span"), [5]); // span follows inputs (not adjacent).
  assert.deepEqual(formMatches("input + span"), []); // span's immediate prev is <a>, not input.
});

void test(":not() excludes the inner compound", () => {
  assert.deepEqual(formMatches("input:not([type=text])"), [3]);
  assert.deepEqual(formMatches("div > :not(input)"), [4, 5]);
});
