/**
 * Unit tests for the cascade / computed-style engine (task 3.4; Requirement 11).
 *
 * Built by `tsc` then run with: `node --test packages/cascade/dist/*.test.js`.
 *
 * The cascade test lives inside a *stage* package, so (per
 * `local/no-cross-stage-import`) it may import ONLY the frozen IR
 * (`@browser-engine/ir`) and the package under test — never html-parser /
 * css-parser. The DomTree and StyleSheet inputs are therefore built here by
 * hand as frozen IR values, exactly the shape those upstream stages emit.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { deepFreeze, nodeId, px } from "@browser-engine/ir";
import type {
  Color,
  Declaration,
  DomNode,
  DomTree,
  Edges,
  NodeId,
  Px,
  Specificity,
  StyleRule,
  StyleSheet,
} from "@browser-engine/ir";

import { cascade } from "./index.js";
import { CSS_PROPERTIES } from "@browser-engine/generator";

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
      node = {
        ...base,
        tag: spec.tag ?? "",
        attrs: new Map(Object.entries(spec.attrs ?? {})),
      };
    } else if (spec.kind === "text" || spec.kind === "comment") {
      node = { ...base, text: spec.text ?? "" };
    } else {
      node = base;
    }
    nodes.set(node.id, node);
  }
  const tree = { root: nodeId(0), nodes } as unknown as DomTree;
  return deepFreeze(tree);
}

interface RuleSpec {
  readonly selector: string;
  readonly specificity: Specificity;
  readonly declarations: readonly { property: string; value: string; important?: boolean }[];
}

/** Build a frozen StyleSheet, assigning each rule a source order in array order. */
function buildSheet(rules: readonly RuleSpec[]): StyleSheet {
  const styleRules: StyleRule[] = rules.map((r, order) => {
    const declarations: Declaration[] = r.declarations.map((d) => ({
      property: d.property,
      value: d.value,
      important: d.important ?? false,
    }));
    return {
      selector: [{ text: r.selector }],
      declarations,
      specificity: r.specificity,
      order,
    };
  });
  const sheet = { rules: styleRules } as unknown as StyleSheet;
  return deepFreeze(sheet);
}

// Shared colors (matching the value-runtime named-color table).
const RED: Color = { r: 255, g: 0, b: 0, a: 1 };
const BLUE: Color = { r: 0, g: 0, b: 255, a: 1 };
const GREEN: Color = { r: 0, g: 128, b: 0, a: 1 };
const BLACK: Color = { r: 0, g: 0, b: 0, a: 1 };

// A tiny document: document → div.box#main → span.
const DOM = buildDom([
  { id: 0, kind: "document", parent: null, children: [1] },
  { id: 1, kind: "element", tag: "div", attrs: { id: "main", class: "box" }, parent: 0, children: [2] },
  { id: 2, kind: "element", tag: "span", parent: 1, children: [] },
]);

// ---------------------------------------------------------------------------
// Req 11.1 — a matching rule produces the property's computed value.
// ---------------------------------------------------------------------------

void test("a property from a matching type rule is computed (Req 11.1)", () => {
  const sheet = buildSheet([{ selector: "div", specificity: [0, 0, 1], declarations: [{ property: "color", value: "red" }] }]);
  const style = cascade(DOM, [sheet], nodeId(1));
  assert.deepEqual(style.color, RED);
});

void test("a class selector matches via the class attribute (Req 11.1)", () => {
  const sheet = buildSheet([{ selector: ".box", specificity: [0, 1, 0], declarations: [{ property: "color", value: "green" }] }]);
  const style = cascade(DOM, [sheet], nodeId(1));
  assert.deepEqual(style.color, GREEN);
});

void test("an id selector matches via the id attribute (Req 11.1)", () => {
  const sheet = buildSheet([{ selector: "#main", specificity: [1, 0, 0], declarations: [{ property: "color", value: "blue" }] }]);
  const style = cascade(DOM, [sheet], nodeId(1));
  assert.deepEqual(style.color, BLUE);
});

void test("a descendant combinator matches an ancestor chain (Req 11.1)", () => {
  // `div span` should match the span (id 2) under div (id 1).
  const sheet = buildSheet([{ selector: "div span", specificity: [0, 0, 2], declarations: [{ property: "color", value: "blue" }] }]);
  const style = cascade(DOM, [sheet], nodeId(2));
  assert.deepEqual(style.color, BLUE);
});

void test("a child combinator only matches a direct parent (Req 11.1)", () => {
  // `document > span` must NOT match the span (its parent is div, not document).
  const matchSheet = buildSheet([{ selector: "div > span", specificity: [0, 0, 2], declarations: [{ property: "color", value: "blue" }] }]);
  assert.deepEqual(cascade(DOM, [matchSheet], nodeId(2)).color, BLUE);

  const noMatchSheet = buildSheet([{ selector: "span > span", specificity: [0, 0, 2], declarations: [{ property: "color", value: "blue" }] }]);
  assert.deepEqual(cascade(DOM, [noMatchSheet], nodeId(2)).color, BLACK); // initial.
});

// ---------------------------------------------------------------------------
// Req 11.2 — winning declaration: specificity → source order → importance.
// ---------------------------------------------------------------------------

void test("higher specificity wins over a lower one (Req 11.2)", () => {
  const sheet = buildSheet([
    { selector: "div", specificity: [0, 0, 1], declarations: [{ property: "color", value: "red" }] },
    { selector: "#main", specificity: [1, 0, 0], declarations: [{ property: "color", value: "blue" }] },
  ]);
  // #main (a=1) beats div (c=1) regardless of source order.
  assert.deepEqual(cascade(DOM, [sheet], nodeId(1)).color, BLUE);
});

void test("source order breaks a specificity tie — later wins (Req 11.2)", () => {
  const sheet = buildSheet([
    { selector: "div", specificity: [0, 0, 1], declarations: [{ property: "color", value: "red" }] },
    { selector: "div", specificity: [0, 0, 1], declarations: [{ property: "color", value: "blue" }] },
  ]);
  assert.deepEqual(cascade(DOM, [sheet], nodeId(1)).color, BLUE);
});

void test("source order breaks a tie across multiple sheets — later sheet wins (Req 11.2)", () => {
  const a = buildSheet([{ selector: "div", specificity: [0, 0, 1], declarations: [{ property: "color", value: "red" }] }]);
  const b = buildSheet([{ selector: "div", specificity: [0, 0, 1], declarations: [{ property: "color", value: "green" }] }]);
  assert.deepEqual(cascade(DOM, [a, b], nodeId(1)).color, GREEN);
});

void test("!important wins over higher specificity (Req 11.2)", () => {
  const sheet = buildSheet([
    { selector: "#main", specificity: [1, 0, 0], declarations: [{ property: "color", value: "blue" }] },
    { selector: "div", specificity: [0, 0, 1], declarations: [{ property: "color", value: "red", important: true }] },
  ]);
  // Author !important beats a normal higher-specificity declaration.
  assert.deepEqual(cascade(DOM, [sheet], nodeId(1)).color, RED);
});

// ---------------------------------------------------------------------------
// Req 11.3 / 11.4 — inherited vs initial fallback for undeclared properties.
// ---------------------------------------------------------------------------

void test("an inherited property with no declaration takes the parent's value (Req 11.3)", () => {
  const sheet = buildSheet([
    { selector: "div", specificity: [0, 0, 1], declarations: [{ property: "color", value: "red" }, { property: "font-size", value: "20px" }] },
  ]);
  const parent = cascade(DOM, [sheet], nodeId(1));
  const child = cascade(DOM, [sheet], nodeId(2)); // span declares nothing.
  assert.deepEqual(child.color, parent.color);
  assert.deepEqual(child.color, RED);
  assert.deepEqual(child.fontSize, parent.fontSize);
  assert.deepEqual(child.fontSize, px(20));
});

void test("inheritance chains through multiple ancestors (Req 11.3)", () => {
  // color declared only on div (id 1); span (id 2) inherits transitively.
  const sheet = buildSheet([{ selector: ".box", specificity: [0, 1, 0], declarations: [{ property: "color", value: "green" }] }]);
  assert.deepEqual(cascade(DOM, [sheet], nodeId(2)).color, GREEN);
});

void test("a non-inherited property with no declaration takes its initial value (Req 11.4)", () => {
  const sheet = buildSheet([{ selector: "div", specificity: [0, 0, 1], declarations: [{ property: "color", value: "red" }] }]);
  const style = cascade(DOM, [sheet], nodeId(1));
  // display / margin / width / height / background-color are non-inherited.
  assert.equal(style.display, "inline"); // initial.
  const zero: Edges<Px> = { top: px(0), right: px(0), bottom: px(0), left: px(0) };
  assert.deepEqual(style.margin, zero);
  assert.equal(style["width"], "auto");
  assert.equal(style["height"], "auto");
  assert.deepEqual(style["backgroundColor"], { r: 0, g: 0, b: 0, a: 0 });
});

void test("a non-inherited property does NOT inherit from the parent (Req 11.4)", () => {
  // display:block on div must NOT flow to the undeclared span.
  const sheet = buildSheet([{ selector: "div", specificity: [0, 0, 1], declarations: [{ property: "display", value: "block" }] }]);
  assert.equal(cascade(DOM, [sheet], nodeId(1)).display, "block");
  assert.equal(cascade(DOM, [sheet], nodeId(2)).display, "inline"); // initial, not inherited.
});

void test("the document root falls back to the all-initial baseline", () => {
  // A node whose only ancestor is the document: inherited props bottom out at
  // their initial value when no ancestor declares them.
  const sheet = buildSheet([]);
  const style = cascade(DOM, [sheet], nodeId(1));
  assert.deepEqual(style.color, BLACK); // initial of the inherited `color`.
  assert.deepEqual(style.fontSize, px(16));
});

// ---------------------------------------------------------------------------
// Req 11.1 — every property present; Req 3.3 — no geometry fields.
// ---------------------------------------------------------------------------

void test("every data-table property is present, with no extra (geometry) fields (Req 11.1, 3.3)", () => {
  const sheet = buildSheet([{ selector: "div", specificity: [0, 0, 1], declarations: [{ property: "color", value: "red" }] }]);
  const style = cascade(DOM, [sheet], nodeId(1));

  // Derive the expected field set from the LIVE data table, so adding a CSS
  // property (Platform-as-Data) never breaks this test — the cascade must
  // surface exactly the generated fields, no more, no less.
  const keys = new Set(Object.keys(style));
  const expected = new Set(CSS_PROPERTIES.map((p) => p.field));
  assert.deepEqual(keys, expected);
  // Sanity: the Phase 1 subset is among them.
  for (const field of ["color", "display", "width", "height", "margin", "backgroundColor", "fontSize"]) {
    assert.ok(keys.has(field), `Phase 1 field ${field} must be present`);
  }

  // No geometry fields may leak into ComputedStyle (Requirement 3.3).
  for (const forbidden of ["x", "y", "box", "rect", "point", "marginBox", "borderBox", "contentBox"]) {
    assert.equal(forbidden in style, false, `ComputedStyle must not carry geometry field ${forbidden}`);
  }
});

// ---------------------------------------------------------------------------
// Req 2.7 / 11.5 — purity, determinism, frozen output.
// ---------------------------------------------------------------------------

void test("the cascade is deterministic: same inputs ⇒ equal ComputedStyle (Req 11.5)", () => {
  const sheet = buildSheet([
    { selector: "div", specificity: [0, 0, 1], declarations: [{ property: "color", value: "red" }, { property: "display", value: "block" }] },
    { selector: ".box", specificity: [0, 1, 0], declarations: [{ property: "color", value: "green" }] },
  ]);
  const a = cascade(DOM, [sheet], nodeId(1));
  const b = cascade(DOM, [sheet], nodeId(1));
  assert.deepEqual(a, b);
});

void test("the output ComputedStyle is deep-frozen (Req 3.2)", () => {
  const sheet = buildSheet([{ selector: "div", specificity: [0, 0, 1], declarations: [{ property: "margin", value: "1px 2px" }] }]);
  const style = cascade(DOM, [sheet], nodeId(1));
  assert.ok(Object.isFrozen(style));
  assert.ok(Object.isFrozen(style.margin)); // nested objects frozen too.
});

void test("an unmatched declaration is ignored; the margin shorthand expands (Req 11.1)", () => {
  const sheet = buildSheet([{ selector: "div", specificity: [0, 0, 1], declarations: [{ property: "margin", value: "1px 2px 3px 4px" }] }]);
  const style = cascade(DOM, [sheet], nodeId(1));
  const expected: Edges<Px> = { top: px(1), right: px(2), bottom: px(3), left: px(4) };
  assert.deepEqual(style.margin, expected);
});

void test("a node absent from the DomTree resolves to the all-initial baseline", () => {
  const sheet = buildSheet([{ selector: "div", specificity: [0, 0, 1], declarations: [{ property: "color", value: "red" }] }]);
  const style = cascade(DOM, [sheet], nodeId(99));
  assert.deepEqual(style.color, BLACK);
  assert.equal(style.display, "inline");
});
