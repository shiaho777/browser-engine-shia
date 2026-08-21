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
  readonly layer?: readonly string[];
}

/** Build a frozen StyleSheet, assigning each rule a source order in array order. */
function buildSheet(rules: readonly RuleSpec[], layerOrder?: readonly (readonly string[])[]): StyleSheet {
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
      layer: r.layer,
    };
  });
  const sheet = (layerOrder !== undefined
    ? { rules: styleRules, layerOrder }
    : { rules: styleRules }) as unknown as StyleSheet;
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

void test("inline style participates in the cascade above normal author rules", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", attrs: { style: "color: blue; width: 33px" }, parent: 0, children: [] },
  ]);
  const sheet = buildSheet([
    {
      selector: "div",
      specificity: [0, 0, 1],
      declarations: [
        { property: "color", value: "red" },
        { property: "width", value: "11px" },
      ],
    },
  ]);
  const style = cascade(dom, [sheet], nodeId(1));
  assert.deepEqual(style.color, BLUE);
  assert.deepEqual(style["width"], px(33));
});

void test("author !important beats normal inline style, inline !important beats author !important", () => {
  const authorImportant = buildSheet([
    {
      selector: "div",
      specificity: [0, 0, 1],
      declarations: [
        { property: "color", value: "red", important: true },
        { property: "width", value: "11px", important: true },
      ],
    },
  ]);
  const normalInline = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", attrs: { style: "color: blue; width: 33px" }, parent: 0, children: [] },
  ]);
  const importantInline = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    {
      id: 1,
      kind: "element",
      tag: "div",
      attrs: { style: "color: blue !important; width: 33px !important" },
      parent: 0,
      children: [],
    },
  ]);

  const normal = cascade(normalInline, [authorImportant], nodeId(1));
  assert.deepEqual(normal.color, RED);
  assert.deepEqual(normal["width"], px(11));

  const important = cascade(importantInline, [authorImportant], nodeId(1));
  assert.deepEqual(important.color, BLUE);
  assert.deepEqual(important["width"], px(33));
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

void test("legacy/vendor display values are accepted (not silently dropped)", () => {
  // -webkit-box / inline-flex / -ms-flexbox must PARSE and reach ComputedStyle
  // so the layout engine can normalize them to a real branch. Before the fix
  // these were rejected by the keyword parser and the element fell back to inline.
  const sheet = buildSheet([
    { selector: "div", specificity: [0, 0, 1], declarations: [{ property: "display", value: "-webkit-box" }] },
  ]);
  assert.equal(cascade(DOM, [sheet], nodeId(1)).display, "-webkit-box");
  const sheet2 = buildSheet([
    { selector: "div", specificity: [0, 0, 1], declarations: [{ property: "display", value: "inline-flex" }] },
  ]);
  assert.equal(cascade(DOM, [sheet2], nodeId(1)).display, "inline-flex");
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

// ---------------------------------------------------------------------------
// CSS shorthand expansion (ROADMAP Phase 2).
// ---------------------------------------------------------------------------

void test("border shorthand expands to per-edge width/style/color (Req 11.1)", () => {
  const sheet = buildSheet([{
    selector: "div",
    specificity: [0, 0, 1],
    declarations: [{ property: "border", value: "1px solid red" }],
  }]);
  const style = cascade(DOM, [sheet], nodeId(1));
  assert.equal(style["borderTopWidth"], px(1));
  assert.equal(style["borderTopStyle"], "solid");
  assert.deepEqual(style["borderTopColor"], { r: 255, g: 0, b: 0, a: 1 });
  assert.equal(style["borderLeftWidth"], px(1));
  assert.equal(style["borderLeftStyle"], "solid");
  assert.deepEqual(style["borderLeftColor"], { r: 255, g: 0, b: 0, a: 1 });
});

void test("border-top shorthand expands only the top edge", () => {
  const sheet = buildSheet([{
    selector: "div",
    specificity: [0, 0, 1],
    declarations: [{ property: "border-top", value: "2px dashed blue" }],
  }]);
  const style = cascade(DOM, [sheet], nodeId(1));
  assert.equal(style["borderTopWidth"], px(2));
  assert.equal(style["borderTopStyle"], "dashed");
  assert.deepEqual(style["borderTopColor"], { r: 0, g: 0, b: 255, a: 1 });
  // Other edges should remain at initial values.
  assert.equal(style["borderLeftStyle"], "none");
});

void test("flex shorthand expands to grow/shrink/basis", () => {
  const sheet = buildSheet([{
    selector: "div",
    specificity: [0, 0, 1],
    declarations: [{ property: "flex", value: "2 1 100px" }],
  }]);
  const style = cascade(DOM, [sheet], nodeId(1));
  assert.equal(style["flexGrow"], 2);
  assert.equal(style["flexShrink"], 1);
  assert.equal(style["flexBasis"], px(100));
});

void test("flex: none expands to 0 0 auto", () => {
  const sheet = buildSheet([{
    selector: "div",
    specificity: [0, 0, 1],
    declarations: [{ property: "flex", value: "none" }],
  }]);
  const style = cascade(DOM, [sheet], nodeId(1));
  assert.equal(style["flexGrow"], 0);
  assert.equal(style["flexShrink"], 0);
  assert.equal(style["flexBasis"], "auto");
});

void test("shorthand longhand can override one component (cascade order)", () => {
  // `border: 1px solid red` then `border-color: blue` — the longhand
  // overrides the color component, keeping width and style from the shorthand.
  const sheet = buildSheet([{
    selector: "div",
    specificity: [0, 0, 1],
    declarations: [
      { property: "border", value: "1px solid red" },
      { property: "border-color", value: "blue" },
    ],
  }]);
  const style = cascade(DOM, [sheet], nodeId(1));
  assert.equal(style["borderTopWidth"], px(1));
  assert.equal(style["borderTopStyle"], "solid");
  assert.deepEqual(style["borderTopColor"], { r: 0, g: 0, b: 255, a: 1 });
});

void test("inline style shorthand expands", () => {
  const dom = buildDom([
    { id: 0, kind: "document", children: [1], parent: null },
    { id: 1, kind: "element", tag: "div", attrs: { style: "flex: 1 0 auto" }, parent: 0 },
  ]);
  const style = cascade(dom, [], nodeId(1));
  assert.equal(style["flexGrow"], 1);
  assert.equal(style["flexShrink"], 0);
  assert.equal(style["flexBasis"], "auto");
});

// ---------------------------------------------------------------------------
// CSS calc() (ROADMAP Phase 2).
// ---------------------------------------------------------------------------

void test("calc() with absolute units resolves in cascade", () => {
  const sheet = buildSheet([{
    selector: "div",
    specificity: [0, 0, 1],
    declarations: [{ property: "width", value: "calc(100px + 50px)" }],
  }]);
  const style = cascade(DOM, [sheet], nodeId(1));
  assert.equal(style["width"], px(150));
});

void test("calc() with em resolves against element font-size", () => {
  // font-size: 20px → 1em = 20px → calc(100px + 2em) = 140px
  const sheet = buildSheet([{
    selector: "div",
    specificity: [0, 0, 1],
    declarations: [
      { property: "font-size", value: "20px" },
      { property: "width", value: "calc(100px + 2em)" },
    ],
  }]);
  const style = cascade(DOM, [sheet], nodeId(1));
  assert.equal(style["width"], px(140));
});

void test("calc() with vw resolves against viewport", () => {
  // viewport width = 800 → 50vw = 400 → calc(50vw - 100px) = 300px
  const sheet = buildSheet([{
    selector: "div",
    specificity: [0, 0, 1],
    declarations: [{ property: "width", value: "calc(50vw - 100px)" }],
  }]);
  const style = cascade(DOM, [sheet], nodeId(1));
  assert.equal(style["width"], px(300));
});

void test("calc() in margin shorthand edges", () => {
  const sheet = buildSheet([{
    selector: "div",
    specificity: [0, 0, 1],
    declarations: [{ property: "margin", value: "calc(10px + 5px) calc(20px - 5px)" }],
  }]);
  const style = cascade(DOM, [sheet], nodeId(1));
  const expected: Edges<Px> = { top: px(15), right: px(15), bottom: px(15), left: px(15) };
  assert.deepEqual(style.margin, expected);
});

void test("calc() with complex nested expression and rem", () => {
  // root font-size = 16px → 1rem = 16px
  // calc((100px + 2rem) * 2 - 50px) = (100 + 32) * 2 - 50 = 214
  const sheet = buildSheet([{
    selector: "div",
    specificity: [0, 0, 1],
    declarations: [{ property: "width", value: "calc((100px + 2rem) * 2 - 50px)" }],
  }]);
  const style = cascade(DOM, [sheet], nodeId(1));
  assert.equal(style["width"], px(214));
});

// ---------------------------------------------------------------------------
// CSS custom properties and var() (ROADMAP Phase 2).
// ---------------------------------------------------------------------------

void test("var() substitutes a custom property into a standard property", () => {
  const sheet = buildSheet([{
    selector: "div",
    specificity: [0, 0, 1],
    declarations: [
      { property: "--my-color", value: "red" },
      { property: "color", value: "var(--my-color)" },
    ],
  }]);
  const style = cascade(DOM, [sheet], nodeId(1));
  assert.deepEqual(style.color, { r: 255, g: 0, b: 0, a: 1 });
});

void test("var() with fallback when custom property is undefined", () => {
  const sheet = buildSheet([{
    selector: "div",
    specificity: [0, 0, 1],
    declarations: [
      { property: "color", value: "var(--missing, blue)" },
    ],
  }]);
  const style = cascade(DOM, [sheet], nodeId(1));
  assert.deepEqual(style.color, { r: 0, g: 0, b: 255, a: 1 });
});

void test("var() inside calc()", () => {
  const sheet = buildSheet([{
    selector: "div",
    specificity: [0, 0, 1],
    declarations: [
      { property: "--base-width", value: "100px" },
      { property: "width", value: "calc(var(--base-width) + 50px)" },
    ],
  }]);
  const style = cascade(DOM, [sheet], nodeId(1));
  assert.equal(style["width"], px(150));
});

void test("custom properties inherit from parent", () => {
  // Parent (node 0 is document, node 1 is div) declares --inherited-color.
  // Child (node 2 is span) uses var(--inherited-color).
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "span", parent: 1, children: [] },
  ]);
  const sheet = buildSheet([
    {
      selector: "div",
      specificity: [0, 0, 1],
      declarations: [{ property: "--inherited-color", value: "green" }],
    },
    {
      selector: "span",
      specificity: [0, 0, 1],
      declarations: [{ property: "color", value: "var(--inherited-color)" }],
    },
  ]);
  const style = cascade(dom, [sheet], nodeId(2));
  assert.deepEqual(style.color, { r: 0, g: 128, b: 0, a: 1 });
});

void test("var() with nested custom property references", () => {
  const sheet = buildSheet([{
    selector: "div",
    specificity: [0, 0, 1],
    declarations: [
      { property: "--base", value: "80px" },
      { property: "--derived", value: "calc(var(--base) * 2)" },
      { property: "width", value: "var(--derived)" },
    ],
  }]);
  const style = cascade(DOM, [sheet], nodeId(1));
  assert.equal(style["width"], px(160));
});

void test("var() cycle detection falls back to initial", () => {
  const sheet = buildSheet([{
    selector: "div",
    specificity: [0, 0, 1],
    declarations: [
      { property: "--a", value: "var(--b)" },
      { property: "--b", value: "var(--a)" },
      { property: "color", value: "var(--a, red)" },
    ],
  }]);
  const style = cascade(DOM, [sheet], nodeId(1));
  // Cycle → fallback "red" is used.
  assert.deepEqual(style.color, { r: 255, g: 0, b: 0, a: 1 });
});

// ---------------------------------------------------------------------------
// CSS Cascade Origin (CSS Cascade 4 §6.3; ROADMAP Phase 2).
// ---------------------------------------------------------------------------

void test("author origin overrides UA origin regardless of specificity", () => {
  // UA sheet has a high-specificity rule (#main → display: block).
  // Author sheet has a low-specificity rule (div → display: flex).
  // Author should win because author > UA in cascade origin.
  const uaSheet = buildSheet([{
    selector: "#main",
    specificity: [1, 0, 0],
    declarations: [{ property: "display", value: "block" }],
  }]);
  const authorSheet = buildSheet([{
    selector: "div",
    specificity: [0, 0, 1],
    declarations: [{ property: "display", value: "flex" }],
  }]);
  const style = cascade(DOM, [uaSheet, authorSheet], nodeId(1), undefined, ["ua", "author"]);
  assert.equal(style.display, "flex", "author overrides UA despite lower specificity");
});

void test("UA important overrides author normal", () => {
  const uaSheet = buildSheet([{
    selector: "div",
    specificity: [0, 0, 1],
    declarations: [{ property: "display", value: "block", important: true }],
  }]);
  const authorSheet = buildSheet([{
    selector: "div",
    specificity: [0, 0, 1],
    declarations: [{ property: "display", value: "flex" }],
  }]);
  const style = cascade(DOM, [uaSheet, authorSheet], nodeId(1), undefined, ["ua", "author"]);
  assert.equal(style.display, "block", "UA important overrides author normal");
});

void test("UA important overrides author important (important reverses origin order)", () => {
  // Per CSS Cascade 4: for important declarations, the origin order is REVERSED:
  // author important < user important < UA important.
  // So UA important beats author important.
  const uaSheet = buildSheet([{
    selector: "div",
    specificity: [0, 0, 1],
    declarations: [{ property: "display", value: "block", important: true }],
  }]);
  const authorSheet = buildSheet([{
    selector: "div",
    specificity: [0, 0, 1],
    declarations: [{ property: "display", value: "flex", important: true }],
  }]);
  const style = cascade(DOM, [uaSheet, authorSheet], nodeId(1), undefined, ["ua", "author"]);
  assert.equal(style.display, "block", "UA important beats author important");
});

void test("inline normal overrides author normal", () => {
  const authorSheet = buildSheet([{
    selector: "div",
    specificity: [1, 0, 0],
    declarations: [{ property: "color", value: "red" }],
  }]);
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", attrs: { style: "color: blue" }, parent: 0, children: [] },
  ]);
  const style = cascade(dom, [authorSheet], nodeId(1), undefined, ["author"]);
  assert.deepEqual(style.color, { r: 0, g: 0, b: 255, a: 1 }, "inline overrides author");
});

void test("author important overrides inline normal", () => {
  const authorSheet = buildSheet([{
    selector: "div",
    specificity: [0, 0, 1],
    declarations: [{ property: "color", value: "red", important: true }],
  }]);
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", attrs: { style: "color: blue" }, parent: 0, children: [] },
  ]);
  const style = cascade(dom, [authorSheet], nodeId(1), undefined, ["author"]);
  assert.deepEqual(style.color, { r: 255, g: 0, b: 0, a: 1 }, "author important overrides inline normal");
});

// ---------------------------------------------------------------------------
// CSS @layer cascade layers (CSS Cascading 5 §7; ROADMAP Phase 2).
// ---------------------------------------------------------------------------

void test("unlayered rules override layered rules regardless of specificity", () => {
  // Layered rule has high specificity (#main), unlayered has low (div).
  // Unlayered should win because unlayered > any layer.
  const sheet = buildSheet(
    [
      { selector: "#main", specificity: [1, 0, 0], declarations: [{ property: "color", value: "red" }], layer: ["base"] },
      { selector: "div", specificity: [0, 0, 1], declarations: [{ property: "color", value: "blue" }] },
    ],
    [["base"]],
  );
  const style = cascade(DOM, [sheet], nodeId(1), undefined, undefined, [["base"]]);
  assert.deepEqual(style.color, { r: 0, g: 0, b: 255, a: 1 }, "unlayered overrides layered");
});

void test("later-declared layer overrides earlier-declared layer", () => {
  // Two layers: base (first) and theme (second). Theme should win.
  const sheet = buildSheet(
    [
      { selector: "div", specificity: [0, 0, 1], declarations: [{ property: "color", value: "red" }], layer: ["base"] },
      { selector: "div", specificity: [0, 0, 1], declarations: [{ property: "color", value: "blue" }], layer: ["theme"] },
    ],
    [["base"], ["theme"]],
  );
  const style = cascade(DOM, [sheet], nodeId(1), undefined, undefined, [["base"], ["theme"]]);
  assert.deepEqual(style.color, { r: 0, g: 0, b: 255, a: 1 }, "theme layer overrides base layer");
});

void test("layer order is independent of source order in the sheet", () => {
  // theme rule appears BEFORE base rule in source, but theme is declared later
  // in the layer order, so theme should still win.
  const sheet = buildSheet(
    [
      { selector: "div", specificity: [0, 0, 1], declarations: [{ property: "color", value: "blue" }], layer: ["theme"] },
      { selector: "div", specificity: [0, 0, 1], declarations: [{ property: "color", value: "red" }], layer: ["base"] },
    ],
    [["base"], ["theme"]],
  );
  const style = cascade(DOM, [sheet], nodeId(1), undefined, undefined, [["base"], ["theme"]]);
  assert.deepEqual(style.color, { r: 0, g: 0, b: 255, a: 1 }, "theme wins regardless of source order");
});

void test("specificity still matters within the same layer", () => {
  const sheet = buildSheet(
    [
      { selector: "div", specificity: [0, 0, 1], declarations: [{ property: "color", value: "red" }], layer: ["base"] },
      { selector: "#main", specificity: [1, 0, 0], declarations: [{ property: "color", value: "blue" }], layer: ["base"] },
    ],
    [["base"]],
  );
  const style = cascade(DOM, [sheet], nodeId(1), undefined, undefined, [["base"]]);
  assert.deepEqual(style.color, { r: 0, g: 0, b: 255, a: 1 }, "higher specificity wins within same layer");
});

void test("case-sensitive custom properties resolve bilibili tokens", () => {
  const sheet = buildSheet([
    {
      selector: ":root",
      specificity: [0, 1, 0],
      declarations: [
        { property: "--Ga10", value: "#18191C" },
        { property: "--text1", value: "var(--Ga10)" },
      ],
    },
    {
      selector: "div",
      specificity: [0, 0, 1],
      declarations: [
        { property: "color", value: "var(--text1)" },
      ],
    },
  ]);
  const style = cascade(DOM, [sheet], nodeId(1));
  assert.equal(style.color.r, 0x18);
  assert.equal(style.color.g, 0x19);
  assert.equal(style.color.b, 0x1c);
});

void test("color: inherit on a beats UA link blue via parent", () => {
  const dom = buildDom([
    { id: 0, kind: "document", parent: null, children: [1] },
    { id: 1, kind: "element", tag: "div", parent: 0, children: [2] },
    { id: 2, kind: "element", tag: "a", parent: 1, children: [] },
  ]);
  const ua = buildSheet([{ selector: "a", specificity: [0, 0, 1], declarations: [{ property: "color", value: "#0000ee" }] }]);
  const author = buildSheet([
    { selector: "div", specificity: [0, 0, 1], declarations: [{ property: "color", value: "#61666D" }] },
    { selector: "a", specificity: [0, 0, 1], declarations: [{ property: "color", value: "inherit" }] },
  ]);
  const style = cascade(dom, [ua, author], nodeId(2));
  assert.equal(style.color.r, 0x61);
  assert.equal(style.color.g, 0x66);
  assert.equal(style.color.b, 0x6d);
});
