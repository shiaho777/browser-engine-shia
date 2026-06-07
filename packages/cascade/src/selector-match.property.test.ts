/**
 * Property 4: 选择器匹配等价 (selector match equivalence) — design.md §9.2.
 *
 * **Validates: Requirements 4.3**
 *
 * > ∀ node:  matchViaIndex(node) === matchByScanAllRules(node)
 * > 索引匹配恒等于朴素全表匹配 (index-based matching equals exhaustive
 * > full-table matching).
 *
 * This is the executable form of Requirement 4.3 ("FOR ALL nodes and
 * stylesheets, the set of rules returned by index-based matching SHALL equal
 * the set returned by an exhaustive scan of all rules"). It is the formal,
 * named **Property 4** — the direct counter-assertion to v0's bug#3 (the index
 * "did only half the job": `S_TAG_MAP` was defined but never used, so matching
 * silently fell back to an O(rules × elements) full scan). Here the index-routed
 * matcher (`matchRulesFor`, the cascade's SOLE matching entry point) and the
 * brute-force reference scan (`matchRulesByScan`) must agree exactly.
 *
 * ## What is quantified
 *
 * fast-check generates, under ∀:
 *   - an arbitrary frozen `DomTree` — a `document` wrapping an arbitrary element
 *     tree, whose elements carry ids / classes / tags from a small shared
 *     vocabulary (so generated selectors actually match a meaningful fraction of
 *     nodes) and whose interior mixes element and text nodes (so the structural
 *     pseudo-classes `:first-child` / `:last-child` skip text siblings), and
 *   - an arbitrary list of frozen `StyleSheet`s whose selectors span the
 *     supported subset: type, class, id, the universal `*`, descendant (` `) and
 *     child (`>`) combinators, the structural pseudo-classes `:root`,
 *     `:first-child`, `:last-child`, AND comma-separated selector lists.
 *
 * For an arbitrary picked node (including one deliberately out-of-tree id, whose
 * match set is empty on both sides) the property asserts:
 *
 *   1. **Set equality** — `setEqual(matchRulesFor(...), matchRulesByScan(...))`,
 *      exactly as design.md §9.2 phrases it (neither matcher returns a rule the
 *      other misses), and
 *   2. **Order equality** — the two return the SAME rule references in the SAME
 *      document order. The index guarantees document order (it merges candidate
 *      buckets back by global order), so the stronger order-equality must also
 *      hold; asserting it guards the source-order cascade tie-break that depends
 *      on it.
 *
 * ## Import surface (stage boundary — `local/no-cross-stage-import`)
 *
 * The cascade is a *stage* package, so this test imports ONLY the frozen IR
 * (`@browser-engine/ir`) and the package under test (the cascade's `index.js`,
 * which re-exports `buildRuleIndex` / `matchRulesFor` / `matchRulesByScan`). The
 * `DomTree` / `StyleSheet` inputs are assembled here by hand as frozen IR
 * values, exactly the shape the upstream html-parser / css-parser stages emit,
 * from fast-check-generated specs.
 *
 * Built by `tsc` then run with: `node --test packages/cascade/dist/*.test.js`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { deepFreeze, nodeId } from "@browser-engine/ir";
import type {
  Declaration,
  DomNode,
  DomTree,
  NodeId,
  Specificity,
  StyleRule,
  StyleSheet,
} from "@browser-engine/ir";

import { buildRuleIndex, matchRulesByScan, matchRulesFor } from "./index.js";

const NUM_RUNS = 300;

// A small shared vocabulary so generated selectors overlap the generated DOM
// and therefore match a meaningful fraction of the time (exercising real
// matching work, including combinators and pseudo-classes, rather than only the
// trivial empty-match case).
const TAGS = ["div", "span", "p", "section"] as const;
const CLASSES = ["box", "row", "col"] as const;
const IDS = ["main", "header", "para"] as const;
const PSEUDOS = [":root", ":first-child", ":last-child"] as const;

// ---------------------------------------------------------------------------
// Generated document spec → frozen DomTree IR.
// ---------------------------------------------------------------------------

interface ElementSpec {
  readonly kind: "element";
  readonly tag: string;
  readonly id: string | null;
  readonly classes: readonly string[];
  readonly children: readonly NodeSpecGen[];
}
interface TextSpec {
  readonly kind: "text";
}
type NodeSpecGen = ElementSpec | TextSpec;

// An interior node is either an element (recursing) or a text node — text
// siblings make `:first-child` / `:last-child` non-trivial (they must be
// skipped). Depth is bounded so trees stay small but can still nest combinators.
const { node: nodeSpecArb } = fc.letrec<{ node: NodeSpecGen }>((tie) => ({
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

/** The document's root is always an element (a `document` with one element child). */
const rootSpecArb: fc.Arbitrary<ElementSpec> = fc.record({
  kind: fc.constant("element" as const),
  tag: fc.constantFrom(...TAGS),
  id: fc.option(fc.constantFrom(...IDS), { nil: null }),
  classes: fc.array(fc.constantFrom(...CLASSES), { maxLength: 2 }),
  children: fc.array(nodeSpecArb, { maxLength: 4 }),
});

/**
 * Materialize a generated `ElementSpec` into a frozen `DomTree` IR: a synthetic
 * `document` node (id 0) wrapping the generated root element. Ids are assigned
 * by a deterministic pre-order walk; `count` is the number of allocated ids, so
 * `count` itself is a valid out-of-tree id for the empty-match case.
 */
function materialize(root: ElementSpec): { readonly dom: DomTree; readonly count: number } {
  const nodes = new Map<NodeId, DomNode>();
  let counter = 0;
  const documentId = nodeId(counter++);

  function walk(spec: NodeSpecGen, parent: NodeId): NodeId {
    const id = nodeId(counter++);
    if (spec.kind === "element") {
      const childIds = spec.children.map((child) => walk(child, id));
      const attrs = new Map<string, string>();
      if (spec.id !== null) {
        attrs.set("id", spec.id);
      }
      if (spec.classes.length > 0) {
        attrs.set("class", spec.classes.join(" "));
      }
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

// ---------------------------------------------------------------------------
// Generated stylesheet spec → frozen StyleSheet[] IR.
// ---------------------------------------------------------------------------

/** A compound selector token: optional tag/id/classes plus an optional pseudo-class. */
const compoundArb: fc.Arbitrary<string> = fc
  .record({
    tag: fc.option(fc.constantFrom(...TAGS), { nil: null }),
    id: fc.option(fc.constantFrom(...IDS), { nil: null }),
    classes: fc.array(fc.constantFrom(...CLASSES), { maxLength: 2 }),
    pseudo: fc.option(fc.constantFrom(...PSEUDOS), { nil: null }),
  })
  .map(({ tag, id, classes, pseudo }) => {
    let text = tag ?? "";
    if (id !== null) {
      text += `#${id}`;
    }
    for (const cls of classes) {
      text += `.${cls}`;
    }
    if (pseudo !== null) {
      text += pseudo;
    }
    // An empty compound (no tag/id/class/pseudo) becomes the universal selector.
    return text.length === 0 ? "*" : text;
  });

/** A selector: one compound, or two joined by a descendant / child combinator. */
const selectorTextArb: fc.Arbitrary<string> = fc.oneof(
  compoundArb,
  fc
    .tuple(compoundArb, fc.constantFrom(" ", " > "), compoundArb)
    .map(([left, combinator, right]) => `${left}${combinator}${right}`),
);

interface RuleSpec {
  /** A single selector, or a comma list of selectors sharing the block. */
  readonly selector: string | readonly string[];
  readonly specificity: Specificity;
}

const ruleArb: fc.Arbitrary<RuleSpec> = fc.record({
  // A bare selector or a selector list (comma-separated) so list filing is exercised.
  selector: fc.oneof(selectorTextArb, fc.array(selectorTextArb, { minLength: 1, maxLength: 3 })),
  specificity: fc.tuple(
    fc.integer({ min: 0, max: 2 }),
    fc.integer({ min: 0, max: 2 }),
    fc.integer({ min: 0, max: 2 }),
  ),
});

/** One-to-three stylesheets, each a list of rules (multiple sheets exercise the
 * cross-sheet global document order the index must reproduce). */
const sheetsSpecArb: fc.Arbitrary<readonly (readonly RuleSpec[])[]> = fc.array(
  fc.array(ruleArb, { maxLength: 6 }),
  { minLength: 1, maxLength: 3 },
);

/** Materialize generated rule specs into frozen `StyleSheet` IR (order by index). */
function buildSheets(spec: readonly (readonly RuleSpec[])[]): readonly StyleSheet[] {
  return spec.map((rules) => {
    const styleRules: StyleRule[] = rules.map((rule, order) => {
      const selectors = typeof rule.selector === "string" ? [rule.selector] : rule.selector;
      // The declaration block content is irrelevant to *matching*; a single
      // placeholder keeps the rule well-formed.
      const declarations: Declaration[] = [{ property: "color", value: "red", important: false }];
      return {
        selector: selectors.map((text) => ({ text })),
        declarations,
        specificity: rule.specificity,
        order,
      };
    });
    return deepFreeze({ rules: styleRules } as unknown as StyleSheet);
  });
}

// ---------------------------------------------------------------------------
// The scenario: a document spec, stylesheet specs, and a node picker.
// ---------------------------------------------------------------------------

interface Scenario {
  readonly docSpec: ElementSpec;
  readonly sheetsSpec: readonly (readonly RuleSpec[])[];
  /** Mapped (mod count + 1) into the id space; the `count` slot is an
   * out-of-tree id whose match set is empty on both matchers. */
  readonly pick: number;
}

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  docSpec: rootSpecArb,
  sheetsSpec: sheetsSpecArb,
  pick: fc.nat({ max: 64 }),
});

/** Are two rule arrays equal as SETS (same members, ignoring order)? */
function setEqual(a: readonly StyleRule[], b: readonly StyleRule[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) {
    return false; // a matcher returned a duplicate the other did not.
  }
  for (const rule of setA) {
    if (!setB.has(rule)) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Property 4: 选择器匹配等价 (selector match equivalence)
// **Validates: Requirements 4.3**
// ---------------------------------------------------------------------------

void test("Property 4: index-based matching set-equals an exhaustive scan for arbitrary docs, sheets, and nodes (Req 4.3)", () => {
  fc.assert(
    fc.property(scenarioArb, ({ docSpec, sheetsSpec, pick }) => {
      const { dom, count } = materialize(docSpec);
      const sheets = buildSheets(sheetsSpec);
      const node = nodeId(pick % (count + 1)); // includes one out-of-tree id.

      // ∀ node: matchViaIndex(node) === matchByScanAllRules(node).
      const viaIndex = matchRulesFor(buildRuleIndex(sheets), dom, node);
      const viaScan = matchRulesByScan(sheets, dom, node);

      // (1) Set equality — exactly as design.md §9.2 phrases it.
      assert.ok(
        setEqual(viaIndex, viaScan),
        "index-based match set must equal the exhaustive scan's set",
      );

      // (2) Order equality — the index guarantees document order, so the
      //     stronger same-references-same-order invariant must also hold.
      assert.equal(viaIndex.length, viaScan.length, "match count differs");
      for (let i = 0; i < viaScan.length; i++) {
        assert.equal(viaIndex[i], viaScan[i], `match #${i} differs (reference identity / order)`);
      }
    }),
    { numRuns: NUM_RUNS },
  );
});
