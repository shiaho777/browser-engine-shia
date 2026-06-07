/**
 * Property 5: 级联确定性 (cascade determinism) — design.md §9.2.
 *
 * **Validates: Requirements 11.5**
 *
 * > ∀ node: cascade(node) === cascade(node)
 * > 纯函数,同输入恒同输出 (pure function, same input always yields the same
 * > output).
 *
 * `cascade(dom, sheets, node)` is a pure, deterministic query (design.md §8.1):
 * for identical inputs it must return an equal `ComputedStyle`. This file proves
 * that under fast-check's ∀ quantification over arbitrary frozen `DomTree` /
 * `StyleSheet[]` IR and an arbitrary picked node, with two complementary
 * statements of "same input ⇒ same output":
 *
 *   1. **Idempotent recomputation.** Calling `cascade` twice on the *same* frozen
 *      IR values and the *same* node yields deep-equal results. This is the
 *      literal Property 5 assertion and mirrors the design's reference
 *      (`deepEqual(cascade(db, n), cascade(db, n))`).
 *
 *   2. **Structural stability across fresh inputs.** Building two *independent*
 *      frozen IR values from the same logical document/stylesheet spec and
 *      cascading the same node yields deep-equal results — so the output depends
 *      only on the inputs' structural content, never on object identity, Map
 *      iteration nonce, or any hidden state.
 *
 * The cascade lives in a *stage* package, so (per `local/no-cross-stage-import`)
 * this test may import ONLY the frozen IR (`@browser-engine/ir`) and the package
 * under test. The `DomTree` / `StyleSheet` inputs are therefore built here by
 * hand as frozen IR — exactly the shape the upstream html-parser / css-parser
 * stages emit — from fast-check-generated specs.
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
  StyleRule,
  StyleSheet,
} from "@browser-engine/ir";

import { cascade } from "./index.js";

const NUM_RUNS = 200;

// A small shared vocabulary so generated selectors overlap the generated DOM
// and therefore actually match a meaningful fraction of the time (exercising
// real cascade work rather than only the all-initial fallback).
const TAGS = ["div", "span", "p", "section"] as const;
const CLASSES = ["box", "main", "row", "col"] as const;
const IDS = ["root", "header", "content"] as const;

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
  readonly text: string;
}
type NodeSpecGen = ElementSpec | TextSpec;

const { node: nodeSpecArb } = fc.letrec<{ node: NodeSpecGen }>((tie) => ({
  node: fc.oneof(
    { maxDepth: 3, depthSize: "small" },
    fc.record({ kind: fc.constant("text" as const), text: fc.string() }),
    fc.record({
      kind: fc.constant("element" as const),
      tag: fc.constantFrom(...TAGS),
      id: fc.option(fc.constantFrom(...IDS), { nil: null }),
      classes: fc.array(fc.constantFrom(...CLASSES), { maxLength: 2 }),
      children: fc.array(tie("node"), { maxLength: 3 }),
    }),
  ),
}));

/** The document's root is always an element (a document with one element child). */
const rootSpecArb: fc.Arbitrary<ElementSpec> = fc.record({
  kind: fc.constant("element" as const),
  tag: fc.constantFrom(...TAGS),
  id: fc.option(fc.constantFrom(...IDS), { nil: null }),
  classes: fc.array(fc.constantFrom(...CLASSES), { maxLength: 2 }),
  children: fc.array(nodeSpecArb, { maxLength: 4 }),
});

/**
 * Materialize a generated `ElementSpec` into a frozen `DomTree` IR: a synthetic
 * `document` node (id 0) wrapping the generated root element. Node ids are
 * assigned by a deterministic pre-order walk, so building the SAME spec twice
 * produces structurally identical trees with identical ids — the basis of the
 * "fresh inputs" stability property.
 */
function buildDom(root: ElementSpec): { readonly dom: DomTree; readonly count: number } {
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
      nodes.set(id, { id, kind: "text", text: spec.text, children: [], parent });
    }
    return id;
  }

  const rootId = walk(root, documentId);
  nodes.set(documentId, { id: documentId, kind: "document", children: [rootId], parent: null });
  const dom = deepFreeze({ root: documentId, nodes } as unknown as DomTree);
  return { dom, count: counter };
}

// ---------------------------------------------------------------------------
// Generated stylesheet spec → frozen StyleSheet[] IR.
// ---------------------------------------------------------------------------

/** A compound selector token drawn from the shared vocabulary (or `*`). */
const compoundArb: fc.Arbitrary<string> = fc
  .record({
    tag: fc.option(fc.constantFrom(...TAGS), { nil: null }),
    id: fc.option(fc.constantFrom(...IDS), { nil: null }),
    classes: fc.array(fc.constantFrom(...CLASSES), { maxLength: 2 }),
  })
  .map(({ tag, id, classes }) => {
    let text = tag ?? "";
    if (id !== null) {
      text += `#${id}`;
    }
    for (const cls of classes) {
      text += `.${cls}`;
    }
    return text.length === 0 ? "*" : text;
  });

/** A selector: one compound, or two joined by a descendant / child combinator. */
const selectorTextArb: fc.Arbitrary<string> = fc.oneof(
  compoundArb,
  fc
    .tuple(compoundArb, fc.constantFrom(" ", " > "), compoundArb)
    .map(([left, combinator, right]) => `${left}${combinator}${right}`),
);

// Per-property value generators that produce strings the generated Phase 1
// parsers accept (plus an occasional invalid value, which the cascade treats as
// "no declaration" — determinism must hold regardless).
const colorValueArb = fc.constantFrom(
  "red",
  "green",
  "blue",
  "black",
  "white",
  "transparent",
  "#fff",
  "#abcdef",
  "rgb(1, 2, 3)",
  "rgba(0, 0, 0, 0.5)",
);
const lengthValueArb = fc.oneof(
  fc.constant("0"),
  fc.integer({ min: 0, max: 500 }).map((n) => `${n}px`),
);
const lengthOrAutoValueArb = fc.oneof(fc.constant("auto"), lengthValueArb);
const displayValueArb = fc.constantFrom("block", "inline", "inline-block", "flex", "grid", "none");
const marginValueArb = fc
  .array(lengthValueArb, { minLength: 1, maxLength: 4 })
  .map((parts) => parts.join(" "));

interface DeclSpec {
  readonly property: string;
  readonly value: string;
  readonly important: boolean;
}

const importantArb = fc.boolean();

const declArb: fc.Arbitrary<DeclSpec> = fc.oneof(
  fc.record({ property: fc.constant("color"), value: colorValueArb, important: importantArb }),
  fc.record({ property: fc.constant("background-color"), value: colorValueArb, important: importantArb }),
  fc.record({ property: fc.constant("display"), value: displayValueArb, important: importantArb }),
  fc.record({ property: fc.constant("width"), value: lengthOrAutoValueArb, important: importantArb }),
  fc.record({ property: fc.constant("height"), value: lengthOrAutoValueArb, important: importantArb }),
  fc.record({ property: fc.constant("margin"), value: marginValueArb, important: importantArb }),
  fc.record({ property: fc.constant("font-size"), value: lengthValueArb, important: importantArb }),
  // An occasional value the parser rejects: the winner fails to parse and is
  // ignored. Determinism (Req 11.5) must still hold.
  fc.record({
    property: fc.constantFrom("color", "width", "font-size", "margin"),
    value: fc.constant("not-a-valid-value"),
    important: importantArb,
  }),
);

interface RuleSpecGen {
  readonly selector: string;
  readonly specificity: readonly [number, number, number];
  readonly declarations: readonly DeclSpec[];
}

const ruleArb: fc.Arbitrary<RuleSpecGen> = fc.record({
  selector: selectorTextArb,
  specificity: fc.tuple(
    fc.integer({ min: 0, max: 3 }),
    fc.integer({ min: 0, max: 3 }),
    fc.integer({ min: 0, max: 3 }),
  ),
  declarations: fc.array(declArb, { minLength: 1, maxLength: 4 }),
});

/** One-to-three stylesheets, each a list of rules (multiple sheets exercise the
 * cross-sheet source-order tie-break). */
const sheetsSpecArb: fc.Arbitrary<readonly (readonly RuleSpecGen[])[]> = fc.array(
  fc.array(ruleArb, { maxLength: 5 }),
  { minLength: 1, maxLength: 3 },
);

/** Materialize generated rule specs into frozen `StyleSheet` IR. */
function buildSheets(spec: readonly (readonly RuleSpecGen[])[]): readonly StyleSheet[] {
  return spec.map((rules) => {
    const styleRules: StyleRule[] = rules.map((rule, order) => {
      const declarations: Declaration[] = rule.declarations.map((decl) => ({
        property: decl.property,
        value: decl.value,
        important: decl.important,
      }));
      return {
        selector: [{ text: rule.selector }],
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
  readonly sheetsSpec: readonly (readonly RuleSpecGen[])[];
  /** Mapped (mod count + 1) into the id space; the `count` slot is an
   * out-of-tree id that resolves to the all-initial baseline. */
  readonly pick: number;
}

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  docSpec: rootSpecArb,
  sheetsSpec: sheetsSpecArb,
  pick: fc.nat({ max: 64 }),
});

// ---------------------------------------------------------------------------
// Property 5: 级联确定性 (cascade determinism)
// **Validates: Requirements 11.5**
// ---------------------------------------------------------------------------

void test("Property 5: cascade is deterministic — same inputs ⇒ equal ComputedStyle (Req 11.5)", () => {
  fc.assert(
    fc.property(scenarioArb, ({ docSpec, sheetsSpec, pick }) => {
      const { dom, count } = buildDom(docSpec);
      const sheets = buildSheets(sheetsSpec);
      const node = nodeId(pick % (count + 1));

      const first = cascade(dom, sheets, node);
      const second = cascade(dom, sheets, node);

      // ∀ node: cascade(node) === cascade(node) — pure, same output every time.
      assert.deepEqual(first, second);
    }),
    { numRuns: NUM_RUNS },
  );
});

void test("Property 5: cascade output is stable across independent fresh inputs (Req 11.5)", () => {
  fc.assert(
    fc.property(scenarioArb, ({ docSpec, sheetsSpec, pick }) => {
      // Two independently-built frozen IR values for the SAME logical document
      // and stylesheets: equal structural content, different object identity.
      const built = buildDom(docSpec);
      const rebuilt = buildDom(docSpec);
      const sheets = buildSheets(sheetsSpec);
      const freshSheets = buildSheets(sheetsSpec);
      const node = nodeId(pick % (built.count + 1));

      // Output depends only on input structure, not on identity/hidden state.
      assert.deepEqual(cascade(built.dom, sheets, node), cascade(rebuilt.dom, freshSheets, node));
    }),
    { numRuns: NUM_RUNS },
  );
});

// ---------------------------------------------------------------------------
// Unit tests — concrete examples complementing the property.
// ---------------------------------------------------------------------------

/** A fixed three-node document: document → div.box#root → span.row. */
function fixedDom(): DomTree {
  const nodes = new Map<NodeId, DomNode>([
    [nodeId(0), { id: nodeId(0), kind: "document", children: [nodeId(1)], parent: null }],
    [
      nodeId(1),
      {
        id: nodeId(1),
        kind: "element",
        tag: "div",
        attrs: new Map([
          ["id", "root"],
          ["class", "box"],
        ]),
        children: [nodeId(2)],
        parent: nodeId(0),
      },
    ],
    [
      nodeId(2),
      {
        id: nodeId(2),
        kind: "element",
        tag: "span",
        attrs: new Map([["class", "row"]]),
        children: [],
        parent: nodeId(1),
      },
    ],
  ]);
  return deepFreeze({ root: nodeId(0), nodes } as unknown as DomTree);
}

void test("recomputing the cascade twice on a fixed document yields deep-equal styles (Req 11.5)", () => {
  const dom = fixedDom();
  const sheets = buildSheets([
    [
      { selector: "div", specificity: [0, 0, 1], declarations: [{ property: "color", value: "red", important: false }] },
      { selector: ".box", specificity: [0, 1, 0], declarations: [{ property: "font-size", value: "20px", important: false }] },
      { selector: "#root", specificity: [1, 0, 0], declarations: [{ property: "display", value: "block", important: false }] },
    ],
  ]);

  for (const id of [nodeId(0), nodeId(1), nodeId(2)]) {
    assert.deepEqual(cascade(dom, sheets, id), cascade(dom, sheets, id));
  }
});

void test("two independently-built identical inputs cascade to deep-equal styles (Req 11.5)", () => {
  const sheetsSpec: readonly (readonly RuleSpecGen[])[] = [
    [
      { selector: "div span", specificity: [0, 0, 2], declarations: [{ property: "color", value: "blue", important: false }] },
      { selector: ".row", specificity: [0, 1, 0], declarations: [{ property: "margin", value: "1px 2px", important: true }] },
    ],
  ];
  const a = cascade(fixedDom(), buildSheets(sheetsSpec), nodeId(2));
  const b = cascade(fixedDom(), buildSheets(sheetsSpec), nodeId(2));
  assert.deepEqual(a, b);
});
