/**
 * dom-codegen.test.ts — the COMPLETE guest-visible DOM surface (task 7.3).
 *
 * Built by `tsc` then run with: `node --test packages/generator/dist/*.test.js`.
 *
 * Covers design.md §4.2 and Requirements 16.2, 6.3:
 *   - 16.2: the Code_Generator produces the COMPLETE DOM API surface from the
 *     WebIDL-style interface table — the mainstream inheritance chain
 *     (`EventTarget → Node → …`) plus the common HTML element interfaces, with
 *     real members.
 *   - 6.3: that surface is generated FROM the IDL table — one TypeScript
 *     interface per row, attributes as typed fields and operations as typed
 *     methods, plus the runtime `DOM_SURFACE` descriptor table — exercising the
 *     full IDL type vocabulary (interface refs, nullable, sequence).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  DOM_INTERFACES,
  arg,
  attribute,
  iface,
  nullable,
  operation,
  sequence,
  type IdlInterface,
} from "./dom-interfaces.idl.js";
import { emitDomSurface } from "./emit/dom-codegen.js";

/**
 * A representative CORE of the mainstream surface every B-tier engine exposes
 * (Requirement 16.2). This is intentionally a SUBSET, not the whole table:
 * growing the surface is "add a row", so pinning an exact list would make every
 * new interface a breaking change. The tests below assert these are PRESENT and
 * carry the right heritage; the full table is free to grow past them.
 */
const CORE_INTERFACES = [
  "EventTarget",
  "Event",
  "Node",
  "CharacterData",
  "Text",
  "Comment",
  "DocumentFragment",
  "Element",
  "Document",
  "HTMLElement",
  "HTMLDivElement",
  "HTMLAnchorElement",
  "HTMLInputElement",
  "CanvasRenderingContext2D",
  "HTMLCanvasElement",
  "HTMLVideoElement",
] as const;

/** Heritage relationships that must hold (base → derived); a SUBSET check. */
const EXPECTED_HERITAGE: ReadonlyArray<readonly [string, string | undefined]> = [
  ["EventTarget", undefined],
  ["Node", "EventTarget"],
  ["CharacterData", "Node"],
  ["Text", "CharacterData"],
  ["Comment", "CharacterData"],
  ["DocumentFragment", "Node"],
  ["Element", "Node"],
  ["Document", "Node"],
  ["HTMLElement", "Element"],
  ["HTMLDivElement", "HTMLElement"],
  ["HTMLAnchorElement", "HTMLElement"],
  ["HTMLInputElement", "HTMLElement"],
  ["CanvasRenderingContext2D", undefined],
  ["HTMLCanvasElement", "HTMLElement"],
  ["HTMLVideoElement", "HTMLElement"],
];

void test("Req 16.2: the IDL table covers the complete mainstream surface", () => {
  const names = new Set(DOM_INTERFACES.map((i) => i.name));
  for (const core of CORE_INTERFACES) {
    assert.ok(names.has(core), `mainstream surface must include ${core}`);
  }
  // The table grows past the core; it never shrinks below it.
  assert.ok(DOM_INTERFACES.length >= CORE_INTERFACES.length);
});

void test("Req 16.2: interface names are unique (no duplicate rows)", () => {
  const names = DOM_INTERFACES.map((i) => i.name);
  assert.equal(new Set(names).size, names.length, "every interface name is distinct");
});

void test("Req 16.2: every declared supertype is itself an interface in the table", () => {
  // A row may only inherit from another row — the heritage graph is closed, so
  // the emitted surface always typechecks regardless of how the table grows.
  const names = new Set(DOM_INTERFACES.map((i) => i.name));
  for (const iface_ of DOM_INTERFACES) {
    if (iface_.inherits !== undefined) {
      assert.ok(
        names.has(iface_.inherits),
        `${iface_.name} inherits from unknown ${iface_.inherits}`,
      );
    }
  }
});

void test("Req 16.2: every interface declares at least one own member", () => {
  // A B-tier surface is substantive: no interface is a bare alias of its
  // supertype (which would also trip @typescript-eslint/no-empty-object-type in
  // the emitted file).
  for (const iface_ of DOM_INTERFACES) {
    assert.ok(iface_.members.length > 0, `${iface_.name} must have members`);
  }
});

void test("Req 6.3: emits one TypeScript interface per IDL row, with heritage", () => {
  const { contents } = emitDomSurface(DOM_INTERFACES);
  for (const name of CORE_INTERFACES) {
    assert.ok(
      contents.includes(`export interface ${name}`),
      `must emit interface ${name}`,
    );
  }
  for (const [name, parent] of EXPECTED_HERITAGE) {
    if (parent !== undefined) {
      assert.ok(
        contents.includes(`export interface ${name} extends ${parent}`),
        `${name} must extend ${parent}`,
      );
    }
  }
});

void test("Req 6.3: interface-typed members emit the referenced interface name", () => {
  const { contents } = emitDomSurface(DOM_INTERFACES);
  // operation returning + taking an interface
  assert.match(contents, /appendChild\(node: Node\): Node;/);
  // Document factory methods return concrete interfaces
  assert.match(contents, /createTextNode\(data: string\): Text;/);
});

void test("Req 6.3: nullable members emit `T | null`", () => {
  const { contents } = emitDomSurface(DOM_INTERFACES);
  assert.match(contents, /readonly parentNode: Node \| null;/);
  assert.match(contents, /textContent: string \| null;/);
  assert.match(contents, /querySelector\(selectors: string\): Element \| null;/);
});

void test("Req 6.3: sequence members emit `T[]`", () => {
  const { contents } = emitDomSurface(DOM_INTERFACES);
  assert.match(contents, /readonly childNodes: Node\[\];/);
  assert.match(contents, /querySelectorAll\(selectors: string\): Element\[\];/);
});

void test("Req 6.3: the descriptor table includes every interface and member", () => {
  const { contents } = emitDomSurface(DOM_INTERFACES);
  for (const iface_ of DOM_INTERFACES) {
    assert.ok(
      contents.includes(`name: "${iface_.name}"`),
      `descriptor table must include ${iface_.name}`,
    );
    for (const member of iface_.members) {
      assert.ok(
        contents.includes(`name: "${member.name}"`),
        `descriptor for ${iface_.name}.${member.name}`,
      );
    }
  }
  // DOM_INTERFACE_NAMES lists every interface in table order
  for (const name of CORE_INTERFACES) {
    assert.ok(contents.includes(`"${name}",`), `names list must include ${name}`);
  }
});

void test("Req 6.3: HTML element interfaces expose their headline members", () => {
  const { contents } = emitDomSurface(DOM_INTERFACES);
  assert.match(contents, /href: string;/); // HTMLAnchorElement
  assert.match(contents, /checked: boolean;/); // HTMLInputElement
  assert.match(contents, /addEventListener\(type: string, listener: unknown\): void;/);
});

void test("Req 6.3: the IDL type vocabulary maps onto TypeScript correctly", () => {
  // A synthetic interface exercising every IdlType case in one place.
  const probe: IdlInterface = {
    name: "Probe",
    members: [
      attribute("str", "DOMString", { readonly: true }),
      attribute("flag", "boolean"),
      attribute("count", "unsigned long", { readonly: true }),
      attribute("ratio", "unrestricted double", { readonly: true }),
      attribute("anything", "any"),
      attribute("ref", iface("Node")),
      attribute("maybe", nullable(iface("Element"))),
      attribute("list", sequence(iface("Node")), { readonly: true }),
      attribute("maybeList", sequence(nullable(iface("Node"))), { readonly: true }),
      operation("noop", "void"),
      operation("pick", nullable(iface("Element")), [arg("q", "DOMString")]),
    ],
  };
  const { contents } = emitDomSurface([probe]);
  assert.match(contents, /readonly str: string;/);
  assert.match(contents, /flag: boolean;/);
  assert.match(contents, /readonly count: number;/);
  assert.match(contents, /readonly ratio: number;/);
  assert.match(contents, /anything: unknown;/);
  assert.match(contents, /ref: Node;/);
  assert.match(contents, /maybe: Element \| null;/);
  assert.match(contents, /readonly list: Node\[\];/);
  // a sequence of a union parenthesises the element type
  assert.match(contents, /readonly maybeList: \(Node \| null\)\[\];/);
  assert.match(contents, /noop\(\): void;/);
  assert.match(contents, /pick\(q: string\): Element \| null;/);
});

void test("Req 16.2: growing the surface is 'add a row' — no emitter change", () => {
  // Append one new interface built only from the existing IDL vocabulary; it
  // must flow through to BOTH the emitted TS interface and the descriptor table
  // with no hand-written emitter code.
  const HTMLMarqueeElement: IdlInterface = {
    name: "HTMLMarqueeElement",
    inherits: "HTMLElement",
    members: [
      attribute("behavior", "DOMString"),
      attribute("direction", "DOMString"),
      attribute("loop", "long", { readonly: true }),
    ],
  };
  const before = emitDomSurface(DOM_INTERFACES).contents;
  const after = emitDomSurface([...DOM_INTERFACES, HTMLMarqueeElement]).contents;

  assert.ok(!before.includes("HTMLMarqueeElement"), "baseline lacks the new row");
  assert.ok(after.includes("export interface HTMLMarqueeElement extends HTMLElement"));
  assert.match(after, /readonly loop: number;/);
  assert.ok(after.includes('name: "HTMLMarqueeElement"'), "descriptor table gains the row");
  assert.ok(after.includes('"HTMLMarqueeElement",'), "names list gains the row");
});

void test("emitter output is deterministic for a given table", () => {
  const a = emitDomSurface(DOM_INTERFACES).contents;
  const b = emitDomSurface(DOM_INTERFACES).contents;
  assert.equal(a, b);
});
