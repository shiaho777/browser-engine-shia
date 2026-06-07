/**
 * Property 6: 继承正确性 (inheritance correctness) — design.md §9.2.
 *
 * **Validates: Requirements 11.3**
 *
 * > ∀ node, 继承属性 p(node 无 p 的显式声明):  computed(node)[p] === computed(parent)[p]
 * > (For all nodes and inherited properties p where the node has no explicit
 * >  declaration for p, the node's computed value of p equals the parent's
 * >  computed value of p.)
 *
 * This is the executable form of Requirement 11.3 ("WHERE a node has no
 * declaration for an inherited property, the Cascade_Engine SHALL set that
 * property's computed value equal to the parent's computed value"). It is the
 * direct counter-assertion to v0's inheritance rot: an undeclared inherited
 * property must track the parent's *computed* value, never silently fall back
 * to the initial value or read a stale field.
 *
 * ## What is quantified
 *
 * fast-check generates, under ∀:
 *   - an arbitrary parent→child *element chain* (document → n0 → n1 → …), each
 *     element carrying a unique id and an optional class so selectors can target
 *     it, and
 *   - an arbitrary author StyleSheet of id / type / class rules whose blocks
 *     declare a mix of inherited (`color`, `font-size`) and non-inherited
 *     (`display`, `margin`) properties.
 *
 * For each trial we pick a target *child* node (any non-root element in the
 * chain) and an inherited property `p` (driven by the generator's own
 * `INHERITED_PROPERTY_NAMES`, so the test never hard-codes which properties
 * inherit). The scenario's stylesheet is then built so the precondition of
 * Requirement 11.3 holds *by construction*: every rule that matches the child is
 * stripped of any declaration for `p`, guaranteeing the child has no explicit
 * declaration for `p` while ancestors are free to declare it (exercising real
 * inheritance — possibly transitively up the chain, bottoming out at the
 * all-initial root). The assertion is exactly the design's invariant:
 *
 *     cascade(child)[p] === cascade(parent)[p]
 *
 * ## Import surface (stage boundary — `local/no-cross-stage-import`)
 *
 * The cascade is a *stage* package, so this test imports ONLY the frozen IR
 * (`@browser-engine/ir`) and the package under test. It also imports the
 * generator's `INHERITED_PROPERTY_NAMES` / `toCamelCase` — the generator is
 * *infrastructure* (not a stage), the same sanctioned data surface the cascade
 * itself consumes — to drive the inherited-property choice and the CSS-name →
 * ComputedStyle-field mapping from data rather than a hand-maintained list. The
 * DomTree / StyleSheet inputs are assembled here by hand as frozen IR values,
 * exactly the shape the upstream stages emit.
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
import { INHERITED_PROPERTY_NAMES, toCamelCase } from "@browser-engine/generator";

import { cascade } from "./index.js";

const NUM_RUNS = 200;

// ---------------------------------------------------------------------------
// Generated-scenario model.
//
// A scenario is an element chain plus an author stylesheet of simple
// (single-compound) rules. The rules' selectors are kept to the id / type /
// class forms so the test can decide, exactly, whether a rule matches the
// target child — which is all it needs to enforce Requirement 11.3's
// precondition (the child has no declaration for the chosen inherited property).
// ---------------------------------------------------------------------------

/** One generated element in the chain: a tag plus an optional class. */
interface ElementSpec {
  readonly tag: string;
  readonly cls: string | null;
}

/** A generated `property: value` declaration (always with valid, parseable value). */
interface GenDecl {
  readonly property: string;
  readonly value: string;
  readonly important: boolean;
}

/** A generated rule: a simple selector (id / type / class) plus its block. */
interface RuleSpec {
  readonly kind: "id" | "type" | "class";
  /** target element index for an `#n{idTarget}` selector. */
  readonly idTarget: number;
  /** tag for a type selector. */
  readonly tag: string;
  /** class for a `.{cls}` selector. */
  readonly cls: string;
  readonly decls: readonly GenDecl[];
}

/** A complete generated scenario. */
interface Scenario {
  readonly count: number;
  readonly elements: readonly ElementSpec[];
  readonly rules: readonly RuleSpec[];
  /** target child element index in `[1, count - 1]` (a non-root element). */
  readonly childIndex: number;
  /** the inherited property under test (a CSS name from INHERITED_PROPERTY_NAMES). */
  readonly inheritedProp: string;
}

// ---------------------------------------------------------------------------
// Value vocabularies — every generated value parses under the Phase 1 grammar,
// so a winning declaration becomes a real computed value (not a dropped invalid).
// ---------------------------------------------------------------------------

const TAGS = ["div", "span", "p", "section", "a"] as const;
const CLASSES = ["a", "b", "c"] as const;
const COLORS = ["red", "green", "blue", "black", "white"] as const;
const FONT_SIZES = ["0", "8px", "12px", "16px", "24px"] as const;
const DISPLAYS = ["block", "inline", "inline-block", "flex", "grid", "none"] as const;
const MARGINS = ["0", "1px", "2px 4px", "5px 6px 7px 8px"] as const;

/** A valid value arbitrary for a given CSS property. */
function valueArbFor(property: string): fc.Arbitrary<string> {
  switch (property) {
    case "color":
      return fc.constantFrom(...COLORS);
    case "font-size":
      return fc.constantFrom(...FONT_SIZES);
    case "display":
      return fc.constantFrom(...DISPLAYS);
    default: // "margin"
      return fc.constantFrom(...MARGINS);
  }
}

/** A single declaration over the Phase 1 property subset, with a valid value. */
const declArb: fc.Arbitrary<GenDecl> = fc
  .constantFrom("color", "font-size", "display", "margin")
  .chain((property) =>
    fc.record({
      property: fc.constant(property),
      value: valueArbFor(property),
      important: fc.boolean(),
    }),
  );

/** A rule arbitrary whose `idTarget` is constrained to the chain's node range. */
function ruleArb(count: number): fc.Arbitrary<RuleSpec> {
  return fc.record({
    kind: fc.constantFrom("id" as const, "type" as const, "class" as const),
    idTarget: fc.integer({ min: 0, max: count - 1 }),
    tag: fc.constantFrom(...TAGS),
    cls: fc.constantFrom(...CLASSES),
    decls: fc.array(declArb, { minLength: 1, maxLength: 3 }),
  });
}

/** The scenario arbitrary: an element chain plus a stylesheet and the target. */
const scenarioArb: fc.Arbitrary<Scenario> = fc.integer({ min: 2, max: 5 }).chain((count) =>
  fc.record({
    count: fc.constant(count),
    elements: fc.array(fc.record({ tag: fc.constantFrom(...TAGS), cls: fc.option(fc.constantFrom(...CLASSES), { nil: null }) }), {
      minLength: count,
      maxLength: count,
    }),
    rules: fc.array(ruleArb(count), { maxLength: 8 }),
    childIndex: fc.integer({ min: 1, max: count - 1 }),
    inheritedProp: fc.constantFrom(...INHERITED_PROPERTY_NAMES),
  }),
);

// ---------------------------------------------------------------------------
// Scenario → frozen IR.
// ---------------------------------------------------------------------------

interface BuiltScenario {
  readonly dom: DomTree;
  readonly sheet: StyleSheet;
  readonly childId: NodeId;
  readonly parentId: NodeId;
  /** the ComputedStyle field name for the inherited property under test. */
  readonly field: string;
}

/** The specificity triple implied by a simple selector's form. */
function specificityOf(rule: RuleSpec): Specificity {
  switch (rule.kind) {
    case "id":
      return [1, 0, 0];
    case "class":
      return [0, 1, 0];
    default: // type
      return [0, 0, 1];
  }
}

/** The selector text for a simple rule (`#n2`, `div`, `.a`). */
function selectorText(rule: RuleSpec): string {
  switch (rule.kind) {
    case "id":
      return `#n${rule.idTarget}`;
    case "class":
      return `.${rule.cls}`;
    default: // type
      return rule.tag;
  }
}

/** Does `rule` match the target child element? Exact for single-compound selectors. */
function ruleMatchesChild(rule: RuleSpec, child: ElementSpec, childIndex: number): boolean {
  switch (rule.kind) {
    case "id":
      return rule.idTarget === childIndex;
    case "type":
      return rule.tag === child.tag;
    default: // class
      return child.cls !== null && rule.cls === child.cls;
  }
}

/**
 * Assemble the scenario into frozen DomTree + StyleSheet IR. Element `i` becomes
 * `nodeId(i + 1)` under the document (`nodeId(0)`); rules that match the target
 * child are stripped of the inherited property under test, so the child
 * provably has no declaration for it (Requirement 11.3's precondition).
 */
function buildScenario(s: Scenario): BuiltScenario {
  const childSpec = s.elements[s.childIndex] as ElementSpec;

  // --- DOM: document → n0 → n1 → … → n{count-1} (a single chain). ---
  const nodes = new Map<NodeId, DomNode>();
  nodes.set(nodeId(0), {
    id: nodeId(0),
    kind: "document",
    children: [nodeId(1)],
    parent: null,
  });
  for (let i = 0; i < s.count; i++) {
    const spec = s.elements[i] as ElementSpec;
    const attrs = new Map<string, string>([["id", `n${i}`]]);
    if (spec.cls !== null) {
      attrs.set("class", spec.cls);
    }
    nodes.set(nodeId(i + 1), {
      id: nodeId(i + 1),
      kind: "element",
      tag: spec.tag,
      attrs,
      children: i + 1 < s.count ? [nodeId(i + 2)] : [],
      parent: nodeId(i), // element 0's parent is the document (nodeId 0).
    });
  }
  const dom = deepFreeze({ root: nodeId(0), nodes } as unknown as DomTree);

  // --- StyleSheet: simple rules, with the child's `p` declarations removed. ---
  const styleRules: StyleRule[] = s.rules.map((rule, order) => {
    const matchesChild = ruleMatchesChild(rule, childSpec, s.childIndex);
    const declarations: Declaration[] = rule.decls
      .filter((d) => !(matchesChild && d.property === s.inheritedProp))
      .map((d) => ({ property: d.property, value: d.value, important: d.important }));
    return {
      selector: [{ text: selectorText(rule) }],
      declarations,
      specificity: specificityOf(rule),
      order,
    };
  });
  const sheet = deepFreeze({ rules: styleRules } as unknown as StyleSheet);

  return {
    dom,
    sheet,
    childId: nodeId(s.childIndex + 1),
    parentId: nodeId(s.childIndex), // the parent element's nodeId.
    field: toCamelCase(s.inheritedProp),
  };
}

/** Read a ComputedStyle field by its (generated) name. */
function fieldValue(style: ReturnType<typeof cascade>, field: string): unknown {
  return (style as unknown as Record<string, unknown>)[field];
}

// ---------------------------------------------------------------------------
// Property 6: 继承正确性 (inheritance correctness)
// **Validates: Requirements 11.3**
// ---------------------------------------------------------------------------
void test("Property 6: an undeclared inherited property equals the parent's computed value (Req 11.3)", () => {
  fc.assert(
    fc.property(scenarioArb, (scenario) => {
      const { dom, sheet, childId, parentId, field } = buildScenario(scenario);

      const childStyle = cascade(dom, [sheet], childId);
      const parentStyle = cascade(dom, [sheet], parentId);

      // ∀: the child declares no value for the inherited property, so its
      // computed value must equal the parent's computed value for it.
      assert.deepEqual(fieldValue(childStyle, field), fieldValue(parentStyle, field));
    }),
    { numRuns: NUM_RUNS },
  );
});

// ---------------------------------------------------------------------------
// Concrete examples — deterministic anchors that complement the property.
// ---------------------------------------------------------------------------

void test("example: a child with no declarations inherits both inherited properties (Req 11.3)", () => {
  const scenario: Scenario = {
    count: 2,
    elements: [
      { tag: "div", cls: null },
      { tag: "span", cls: null },
    ],
    // Parent (#n0) declares both inherited properties; child (#n1) declares none.
    rules: [
      {
        kind: "id",
        idTarget: 0,
        tag: "div",
        cls: "a",
        decls: [
          { property: "color", value: "red", important: false },
          { property: "font-size", value: "24px", important: false },
        ],
      },
    ],
    childIndex: 1,
    inheritedProp: "color",
  };
  const { dom, sheet, childId, parentId } = buildScenario(scenario);
  const child = cascade(dom, [sheet], childId);
  const parent = cascade(dom, [sheet], parentId);

  assert.deepEqual(child.color, parent.color);
  assert.deepEqual(child.color, { r: 255, g: 0, b: 0, a: 1 });
  assert.deepEqual(child.fontSize, parent.fontSize); // inherits transitively too.
});

void test("example: inheritance flows transitively through an intermediate ancestor (Req 11.3)", () => {
  // color declared only on the topmost element (#n0); the leaf inherits it
  // through the (also-undeclared) middle element.
  const scenario: Scenario = {
    count: 3,
    elements: [
      { tag: "section", cls: null },
      { tag: "div", cls: null },
      { tag: "span", cls: null },
    ],
    rules: [
      {
        kind: "id",
        idTarget: 0,
        tag: "section",
        cls: "a",
        decls: [{ property: "color", value: "green", important: false }],
      },
    ],
    childIndex: 2,
    inheritedProp: "color",
  };
  const { dom, sheet, childId, parentId } = buildScenario(scenario);
  const child = cascade(dom, [sheet], childId);
  const parent = cascade(dom, [sheet], parentId);

  assert.deepEqual(child.color, parent.color);
  assert.deepEqual(child.color, { r: 0, g: 128, b: 0, a: 1 }); // green, inherited.
});
