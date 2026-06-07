/**
 * dom-interfaces.idl.ts — WebIDL-style DOM interface definitions
 * (design.md §4.2; Requirements 6.3, 16.2).
 *
 * This is the *data* from which the generator emits the guest-visible DOM
 * surface (`emit/dom-codegen.ts`). It is deliberately independent of the CSS
 * property data table: the two generation paths share no inputs, so DOM-surface
 * generation can proceed even if CSS-parser generation fails (Requirement 6.4,
 * proven by `independence.test.ts`).
 *
 * Phase 1 needed only a minimal surface (`Node`, `Element`, `Document`). Task
 * 7.3 (逼近 B 档) grows this to a substantially COMPLETE mainstream surface — the
 * inheritance chain a B-tier engine exposes (`EventTarget → Node → …`) plus the
 * common HTML element interfaces — WITHOUT reshaping the table: growth is still
 * "add a row" (Requirement 16.2). To express real DOM members the IDL type
 * system is now structured: a member's type is a primitive keyword, a reference
 * to another interface (`iface("Node")`), a nullable wrapper (`nullable(…)` →
 * `T | null`), or a sequence (`sequence(…)` → `T[]`).
 */

// ---- the IDL type system --------------------------------------------------

/** A primitive WebIDL type keyword. */
export type IdlPrimitive =
  | "DOMString"
  | "boolean"
  | "long"
  | "unsigned long"
  | "unrestricted double"
  | "any"
  | "void";

/** A reference to another interface in the table (e.g. an attribute of type `Node`). */
export interface IdlInterfaceRef {
  readonly kind: "interface";
  readonly name: string;
}

/** A nullable type: the wrapped type or `null` (WebIDL `T?` → `T | null`). */
export interface IdlNullable {
  readonly kind: "nullable";
  readonly inner: IdlType;
}

/** A homogeneous sequence (WebIDL `sequence<T>` → `T[]`). */
export interface IdlSequence {
  readonly kind: "sequence";
  readonly element: IdlType;
}

/**
 * A WebIDL type: a primitive keyword, an interface reference, a nullable wrapper
 * or a sequence. The emitter's `tsTypeOf` maps each case to its TypeScript form.
 */
export type IdlType = IdlPrimitive | IdlInterfaceRef | IdlNullable | IdlSequence;

/** A read-only or read/write attribute on an interface. */
export interface IdlAttribute {
  readonly kind: "attribute";
  readonly name: string;
  readonly type: IdlType;
  /** When true the attribute has only a getter (no setter is emitted). */
  readonly readonly: boolean;
}

/** A single argument to an operation. */
export interface IdlArgument {
  readonly name: string;
  readonly type: IdlType;
}

/** A method (operation) on an interface. */
export interface IdlOperation {
  readonly kind: "operation";
  readonly name: string;
  readonly returnType: IdlType;
  readonly args: readonly IdlArgument[];
}

/** A member of an interface: either an attribute or an operation. */
export type IdlMember = IdlAttribute | IdlOperation;

/** A WebIDL-style interface definition. */
export interface IdlInterface {
  readonly name: string;
  /** The interface this one inherits from, if any (e.g. `Element : Node`). */
  readonly inherits?: string;
  readonly members: readonly IdlMember[];
}

// ---- ergonomic type constructors ------------------------------------------

/** A reference to another interface, by name. */
export function iface(name: string): IdlInterfaceRef {
  return { kind: "interface", name };
}

/** Wrap a type as nullable (`T` → `T | null`). */
export function nullable(inner: IdlType): IdlNullable {
  return { kind: "nullable", inner };
}

/** A sequence of a type (`sequence<T>` → `T[]`). */
export function sequence(element: IdlType): IdlSequence {
  return { kind: "sequence", element };
}

// ---- ergonomic member constructors ----------------------------------------

/** An attribute member. `readonly` defaults to false (read/write). */
export function attribute(
  name: string,
  type: IdlType,
  options: { readonly readonly?: boolean } = {},
): IdlAttribute {
  return { kind: "attribute", name, type, readonly: options.readonly ?? false };
}

/** An operation member with the given return type and arguments. */
export function operation(
  name: string,
  returnType: IdlType,
  args: readonly IdlArgument[] = [],
): IdlOperation {
  return { kind: "operation", name, returnType, args };
}

/** An argument with the given name and type (a small helper for readability). */
export function arg(name: string, type: IdlType): IdlArgument {
  return { name, type };
}

// ---- the DOM interface table ----------------------------------------------
//
// Ordered base → derived for readable, deterministic output. (TypeScript
// interfaces are order-independent within a module, so the emitted surface
// typechecks regardless; the order is purely for humans.)

/** The root of the event model: anything that can receive events. */
const EVENT_TARGET: IdlInterface = {
  name: "EventTarget",
  members: [
    operation("addEventListener", "void", [
      arg("type", "DOMString"),
      arg("listener", "any"),
    ]),
    operation("removeEventListener", "void", [
      arg("type", "DOMString"),
      arg("listener", "any"),
    ]),
    operation("dispatchEvent", "boolean", [arg("event", iface("Event"))]),
  ],
};

/** A dispatched event. */
const EVENT: IdlInterface = {
  name: "Event",
  members: [
    attribute("type", "DOMString", { readonly: true }),
    attribute("bubbles", "boolean", { readonly: true }),
    attribute("cancelable", "boolean", { readonly: true }),
    attribute("defaultPrevented", "boolean", { readonly: true }),
    operation("preventDefault", "void"),
    operation("stopPropagation", "void"),
  ],
};

/** The base class of every tree node. */
const NODE: IdlInterface = {
  name: "Node",
  inherits: "EventTarget",
  members: [
    attribute("nodeName", "DOMString", { readonly: true }),
    attribute("nodeType", "unsigned long", { readonly: true }),
    attribute("nodeValue", nullable("DOMString")),
    attribute("ownerDocument", nullable(iface("Document")), { readonly: true }),
    attribute("parentNode", nullable(iface("Node")), { readonly: true }),
    attribute("parentElement", nullable(iface("Element")), { readonly: true }),
    attribute("childNodes", sequence(iface("Node")), { readonly: true }),
    attribute("firstChild", nullable(iface("Node")), { readonly: true }),
    attribute("lastChild", nullable(iface("Node")), { readonly: true }),
    attribute("previousSibling", nullable(iface("Node")), { readonly: true }),
    attribute("nextSibling", nullable(iface("Node")), { readonly: true }),
    attribute("textContent", nullable("DOMString")),
    operation("hasChildNodes", "boolean"),
    operation("contains", "boolean", [arg("other", nullable(iface("Node")))]),
    operation("appendChild", iface("Node"), [arg("node", iface("Node"))]),
    operation("insertBefore", iface("Node"), [arg("node", iface("Node")), arg("child", nullable(iface("Node")))]),
    operation("replaceChild", iface("Node"), [arg("node", iface("Node")), arg("child", iface("Node"))]),
    operation("removeChild", iface("Node"), [arg("child", iface("Node"))]),
    operation("cloneNode", iface("Node"), [arg("deep", "boolean")]),
    operation("isEqualNode", "boolean", [arg("other", nullable(iface("Node")))]),
    operation("normalize", "void"),
  ],
};

/** The abstract base of text-bearing nodes (`Text`, `Comment`). */
const CHARACTER_DATA: IdlInterface = {
  name: "CharacterData",
  inherits: "Node",
  members: [
    attribute("data", "DOMString"),
    attribute("length", "unsigned long", { readonly: true }),
  ],
};

/** A text node. */
const TEXT: IdlInterface = {
  name: "Text",
  inherits: "CharacterData",
  members: [
    attribute("wholeText", "DOMString", { readonly: true }),
    operation("splitText", iface("Text"), [arg("offset", "unsigned long")]),
  ],
};

/** A comment node. `nodeType` is narrowed to the `COMMENT_NODE` constant (8). */
const COMMENT: IdlInterface = {
  name: "Comment",
  inherits: "CharacterData",
  members: [attribute("nodeType", "unsigned long", { readonly: true })],
};

/** A lightweight container that is not part of the active document tree. */
const DOCUMENT_FRAGMENT: IdlInterface = {
  name: "DocumentFragment",
  inherits: "Node",
  members: [
    attribute("childElementCount", "unsigned long", { readonly: true }),
    operation("getElementById", nullable(iface("Element")), [
      arg("elementId", "DOMString"),
    ]),
    operation("querySelector", nullable(iface("Element")), [
      arg("selectors", "DOMString"),
    ]),
  ],
};

/** A generic element. */
const ELEMENT: IdlInterface = {
  name: "Element",
  inherits: "Node",
  members: [
    attribute("tagName", "DOMString", { readonly: true }),
    attribute("id", "DOMString"),
    attribute("className", "DOMString"),
    attribute("classList", iface("DOMTokenList"), { readonly: true }),
    attribute("attributes", iface("NamedNodeMap"), { readonly: true }),
    attribute("children", sequence(iface("Element")), { readonly: true }),
    attribute("firstElementChild", nullable(iface("Element")), { readonly: true }),
    attribute("lastElementChild", nullable(iface("Element")), { readonly: true }),
    attribute("previousElementSibling", nullable(iface("Element")), { readonly: true }),
    attribute("nextElementSibling", nullable(iface("Element")), { readonly: true }),
    attribute("childElementCount", "unsigned long", { readonly: true }),
    attribute("shadowRoot", nullable(iface("ShadowRoot")), { readonly: true }),
    attribute("slot", "DOMString"),
    attribute("innerHTML", "DOMString"),
    attribute("outerHTML", "DOMString"),
    attribute("scrollLeft", "unrestricted double"),
    attribute("scrollTop", "unrestricted double"),
    attribute("scrollWidth", "long", { readonly: true }),
    attribute("scrollHeight", "long", { readonly: true }),
    attribute("clientWidth", "long", { readonly: true }),
    attribute("clientHeight", "long", { readonly: true }),
    attribute("clientTop", "long", { readonly: true }),
    attribute("clientLeft", "long", { readonly: true }),
    operation("getAttribute", nullable("DOMString"), [arg("name", "DOMString")]),
    operation("setAttribute", "void", [
      arg("name", "DOMString"),
      arg("value", "DOMString"),
    ]),
    operation("removeAttribute", "void", [arg("name", "DOMString")]),
    operation("toggleAttribute", "boolean", [arg("name", "DOMString")]),
    operation("hasAttribute", "boolean", [arg("name", "DOMString")]),
    operation("hasAttributes", "boolean"),
    operation("getAttributeNames", sequence("DOMString")),
    operation("getBoundingClientRect", iface("DOMRect")),
    operation("getClientRects", sequence(iface("DOMRect"))),
    operation("attachShadow", iface("ShadowRoot"), [arg("init", "any")]),
    operation("scrollIntoView", "void"),
    operation("insertAdjacentHTML", "void", [arg("position", "DOMString"), arg("text", "DOMString")]),
    operation("matches", "boolean", [arg("selectors", "DOMString")]),
    operation("closest", nullable(iface("Element")), [arg("selectors", "DOMString")]),
    operation("querySelector", nullable(iface("Element")), [
      arg("selectors", "DOMString"),
    ]),
    operation("querySelectorAll", sequence(iface("Element")), [
      arg("selectors", "DOMString"),
    ]),
    operation("getElementsByTagName", sequence(iface("Element")), [
      arg("qualifiedName", "DOMString"),
    ]),
    operation("getElementsByClassName", sequence(iface("Element")), [
      arg("classNames", "DOMString"),
    ]),
  ],
};

/** The document root object. */
const DOCUMENT: IdlInterface = {
  name: "Document",
  inherits: "Node",
  members: [
    attribute("documentElement", nullable(iface("Element")), { readonly: true }),
    attribute("body", nullable(iface("HTMLElement"))),
    attribute("head", nullable(iface("HTMLElement")), { readonly: true }),
    attribute("title", "DOMString"),
    attribute("characterSet", "DOMString", { readonly: true }),
    attribute("contentType", "DOMString", { readonly: true }),
    attribute("readyState", "DOMString", { readonly: true }),
    attribute("activeElement", nullable(iface("Element")), { readonly: true }),
    attribute("defaultView", nullable(iface("Window")), { readonly: true }),
    attribute("location", nullable(iface("Location")), { readonly: true }),
    attribute("cookie", "DOMString"),
    attribute("referrer", "DOMString", { readonly: true }),
    attribute("URL", "DOMString", { readonly: true }),
    attribute("domain", "DOMString"),
    attribute("forms", sequence(iface("HTMLFormElement")), { readonly: true }),
    attribute("images", sequence(iface("HTMLImageElement")), { readonly: true }),
    attribute("links", sequence(iface("HTMLAnchorElement")), { readonly: true }),
    attribute("scripts", sequence(iface("HTMLScriptElement")), { readonly: true }),
    attribute("styleSheets", sequence(iface("CSSStyleSheet")), { readonly: true }),
    operation("createElement", iface("Element"), [arg("localName", "DOMString")]),
    operation("createTextNode", iface("Text"), [arg("data", "DOMString")]),
    operation("createComment", iface("Comment"), [arg("data", "DOMString")]),
    operation("createDocumentFragment", iface("DocumentFragment")),
    operation("createRange", iface("Range")),
    operation("createEvent", iface("Event"), [arg("interfaceName", "DOMString")]),
    operation("getSelection", nullable(iface("Selection"))),
    operation("getElementById", nullable(iface("Element")), [
      arg("elementId", "DOMString"),
    ]),
    operation("getElementsByTagName", sequence(iface("Element")), [
      arg("qualifiedName", "DOMString"),
    ]),
    operation("getElementsByClassName", sequence(iface("Element")), [
      arg("classNames", "DOMString"),
    ]),
    operation("querySelector", nullable(iface("Element")), [
      arg("selectors", "DOMString"),
    ]),
    operation("querySelectorAll", sequence(iface("Element")), [
      arg("selectors", "DOMString"),
    ]),
  ],
};

/** The base of every HTML element. */
const HTML_ELEMENT: IdlInterface = {
  name: "HTMLElement",
  inherits: "Element",
  members: [
    attribute("title", "DOMString"),
    attribute("lang", "DOMString"),
    attribute("hidden", "boolean"),
    attribute("innerText", "DOMString"),
    operation("click", "void"),
    operation("focus", "void"),
    operation("blur", "void"),
  ],
};

/** A `<div>` element. */
const HTML_DIV_ELEMENT: IdlInterface = {
  name: "HTMLDivElement",
  inherits: "HTMLElement",
  members: [attribute("align", "DOMString")],
};

/** An `<a>` element. */
const HTML_ANCHOR_ELEMENT: IdlInterface = {
  name: "HTMLAnchorElement",
  inherits: "HTMLElement",
  members: [
    attribute("href", "DOMString"),
    attribute("target", "DOMString"),
    attribute("rel", "DOMString"),
  ],
};

/** An `<input>` element. */
const HTML_INPUT_ELEMENT: IdlInterface = {
  name: "HTMLInputElement",
  inherits: "HTMLElement",
  members: [
    attribute("value", "DOMString"),
    attribute("type", "DOMString"),
    attribute("checked", "boolean"),
    attribute("placeholder", "DOMString"),
    attribute("disabled", "boolean"),
  ],
};

/**
 * A 2D drawing context for `<canvas>` (a minimal, common subset). The guest
 * obtains one via `HTMLCanvasElement.getContext("2d")`; its operations are the
 * mainstream immediate-mode drawing surface (Requirement 17.3).
 */
const CANVAS_RENDERING_CONTEXT_2D: IdlInterface = {
  name: "CanvasRenderingContext2D",
  members: [
    attribute("fillStyle", "DOMString"),
    attribute("strokeStyle", "DOMString"),
    attribute("lineWidth", "unrestricted double"),
    operation("fillRect", "void", [
      arg("x", "unrestricted double"),
      arg("y", "unrestricted double"),
      arg("w", "unrestricted double"),
      arg("h", "unrestricted double"),
    ]),
    operation("clearRect", "void", [
      arg("x", "unrestricted double"),
      arg("y", "unrestricted double"),
      arg("w", "unrestricted double"),
      arg("h", "unrestricted double"),
    ]),
    operation("beginPath", "void"),
    operation("moveTo", "void", [arg("x", "unrestricted double"), arg("y", "unrestricted double")]),
    operation("lineTo", "void", [arg("x", "unrestricted double"), arg("y", "unrestricted double")]),
    operation("stroke", "void"),
    operation("fill", "void"),
  ],
};

/** A `<canvas>` element: an intrinsic-sized bitmap with a drawing context. */
const HTML_CANVAS_ELEMENT: IdlInterface = {
  name: "HTMLCanvasElement",
  inherits: "HTMLElement",
  members: [
    attribute("width", "unsigned long"),
    attribute("height", "unsigned long"),
    operation("getContext", nullable(iface("CanvasRenderingContext2D")), [
      arg("contextId", "DOMString"),
    ]),
    operation("toDataURL", "DOMString", [arg("type", "DOMString")]),
  ],
};

/**
 * A `<video>` element (the common media-element subset). Playback is driven by
 * `play`/`pause`; `currentSrc`/`videoWidth`/`videoHeight` expose the loaded
 * resource (Requirement 17.3).
 */
const HTML_VIDEO_ELEMENT: IdlInterface = {
  name: "HTMLVideoElement",
  inherits: "HTMLElement",
  members: [
    attribute("src", "DOMString"),
    attribute("currentSrc", "DOMString", { readonly: true }),
    attribute("width", "unsigned long"),
    attribute("height", "unsigned long"),
    attribute("videoWidth", "unsigned long", { readonly: true }),
    attribute("videoHeight", "unsigned long", { readonly: true }),
    attribute("currentTime", "unrestricted double"),
    attribute("duration", "unrestricted double", { readonly: true }),
    attribute("paused", "boolean", { readonly: true }),
    attribute("autoplay", "boolean"),
    attribute("loop", "boolean"),
    attribute("muted", "boolean"),
    operation("play", "void"),
    operation("pause", "void"),
  ],
};

// ---------------------------------------------------------------------------
// Breadth expansion (compat / DOM-surface battle). Each interface below is one
// more row built only from the existing IDL vocabulary — primitives, interface
// references, nullable wrappers, sequences. No emitter change: growth is "add a
// row" (Requirement 16.2). Mechanism-density rises as the hand-written emitter
// stays fixed.
// ---------------------------------------------------------------------------

/** A live, ordered set of space-separated tokens (`Element.classList`). */
const DOM_TOKEN_LIST: IdlInterface = {
  name: "DOMTokenList",
  members: [
    attribute("length", "unsigned long", { readonly: true }),
    attribute("value", "DOMString"),
    operation("item", nullable("DOMString"), [arg("index", "unsigned long")]),
    operation("contains", "boolean", [arg("token", "DOMString")]),
    operation("add", "void", [arg("token", "DOMString")]),
    operation("remove", "void", [arg("token", "DOMString")]),
    operation("toggle", "boolean", [arg("token", "DOMString")]),
    operation("replace", "boolean", [
      arg("oldToken", "DOMString"),
      arg("newToken", "DOMString"),
    ]),
  ],
};

/** A single attribute node (member of `NamedNodeMap`). */
const ATTR: IdlInterface = {
  name: "Attr",
  inherits: "Node",
  members: [
    attribute("name", "DOMString", { readonly: true }),
    attribute("localName", "DOMString", { readonly: true }),
    attribute("value", "DOMString"),
    attribute("ownerElement", nullable(iface("Element")), { readonly: true }),
  ],
};

/** The collection of an element's attribute nodes (`Element.attributes`). */
const NAMED_NODE_MAP: IdlInterface = {
  name: "NamedNodeMap",
  members: [
    attribute("length", "unsigned long", { readonly: true }),
    operation("item", nullable(iface("Attr")), [arg("index", "unsigned long")]),
    operation("getNamedItem", nullable(iface("Attr")), [arg("qualifiedName", "DOMString")]),
    operation("setNamedItem", nullable(iface("Attr")), [arg("attr", iface("Attr"))]),
    operation("removeNamedItem", iface("Attr"), [arg("qualifiedName", "DOMString")]),
  ],
};

/** A rectangle returned by geometry queries (`getBoundingClientRect`). */
const DOM_RECT: IdlInterface = {
  name: "DOMRect",
  members: [
    attribute("x", "unrestricted double"),
    attribute("y", "unrestricted double"),
    attribute("width", "unrestricted double"),
    attribute("height", "unrestricted double"),
    attribute("top", "unrestricted double", { readonly: true }),
    attribute("right", "unrestricted double", { readonly: true }),
    attribute("bottom", "unrestricted double", { readonly: true }),
    attribute("left", "unrestricted double", { readonly: true }),
  ],
};

/** A `<span>` element. */
const HTML_SPAN_ELEMENT: IdlInterface = {
  name: "HTMLSpanElement",
  inherits: "HTMLElement",
  members: [attribute("title", "DOMString")],
};

/** A `<p>` element. */
const HTML_PARAGRAPH_ELEMENT: IdlInterface = {
  name: "HTMLParagraphElement",
  inherits: "HTMLElement",
  members: [attribute("align", "DOMString")],
};

/** A heading element (`<h1>`…`<h6>`). */
const HTML_HEADING_ELEMENT: IdlInterface = {
  name: "HTMLHeadingElement",
  inherits: "HTMLElement",
  members: [attribute("align", "DOMString")],
};

/** An `<img>` element. */
const HTML_IMAGE_ELEMENT: IdlInterface = {
  name: "HTMLImageElement",
  inherits: "HTMLElement",
  members: [
    attribute("src", "DOMString"),
    attribute("alt", "DOMString"),
    attribute("width", "unsigned long"),
    attribute("height", "unsigned long"),
    attribute("naturalWidth", "unsigned long", { readonly: true }),
    attribute("naturalHeight", "unsigned long", { readonly: true }),
    attribute("complete", "boolean", { readonly: true }),
    attribute("loading", "DOMString"),
  ],
};

/** A `<button>` element. */
const HTML_BUTTON_ELEMENT: IdlInterface = {
  name: "HTMLButtonElement",
  inherits: "HTMLElement",
  members: [
    attribute("type", "DOMString"),
    attribute("value", "DOMString"),
    attribute("name", "DOMString"),
    attribute("disabled", "boolean"),
    attribute("form", nullable(iface("HTMLFormElement")), { readonly: true }),
  ],
};

/** A `<label>` element. */
const HTML_LABEL_ELEMENT: IdlInterface = {
  name: "HTMLLabelElement",
  inherits: "HTMLElement",
  members: [
    attribute("htmlFor", "DOMString"),
    attribute("control", nullable(iface("HTMLElement")), { readonly: true }),
  ],
};

/** A `<select>` element. */
const HTML_SELECT_ELEMENT: IdlInterface = {
  name: "HTMLSelectElement",
  inherits: "HTMLElement",
  members: [
    attribute("value", "DOMString"),
    attribute("name", "DOMString"),
    attribute("disabled", "boolean"),
    attribute("multiple", "boolean"),
    attribute("selectedIndex", "long"),
    attribute("length", "unsigned long"),
    attribute("options", sequence(iface("HTMLOptionElement")), { readonly: true }),
    operation("add", "void", [arg("element", iface("HTMLOptionElement"))]),
    operation("remove", "void", [arg("index", "long")]),
  ],
};

/** An `<option>` element. */
const HTML_OPTION_ELEMENT: IdlInterface = {
  name: "HTMLOptionElement",
  inherits: "HTMLElement",
  members: [
    attribute("value", "DOMString"),
    attribute("text", "DOMString"),
    attribute("label", "DOMString"),
    attribute("selected", "boolean"),
    attribute("disabled", "boolean"),
    attribute("index", "long", { readonly: true }),
  ],
};

/** A `<textarea>` element. */
const HTML_TEXT_AREA_ELEMENT: IdlInterface = {
  name: "HTMLTextAreaElement",
  inherits: "HTMLElement",
  members: [
    attribute("value", "DOMString"),
    attribute("name", "DOMString"),
    attribute("placeholder", "DOMString"),
    attribute("rows", "unsigned long"),
    attribute("cols", "unsigned long"),
    attribute("disabled", "boolean"),
    attribute("readOnly", "boolean"),
  ],
};

/** A `<form>` element. */
const HTML_FORM_ELEMENT: IdlInterface = {
  name: "HTMLFormElement",
  inherits: "HTMLElement",
  members: [
    attribute("action", "DOMString"),
    attribute("method", "DOMString"),
    attribute("name", "DOMString"),
    attribute("enctype", "DOMString"),
    attribute("length", "unsigned long", { readonly: true }),
    operation("submit", "void"),
    operation("reset", "void"),
  ],
};

/** A `<ul>` element. */
const HTML_U_LIST_ELEMENT: IdlInterface = {
  name: "HTMLUListElement",
  inherits: "HTMLElement",
  members: [attribute("type", "DOMString")],
};

/** An `<ol>` element. */
const HTML_O_LIST_ELEMENT: IdlInterface = {
  name: "HTMLOListElement",
  inherits: "HTMLElement",
  members: [
    attribute("type", "DOMString"),
    attribute("start", "long"),
    attribute("reversed", "boolean"),
  ],
};

/** An `<li>` element. */
const HTML_LI_ELEMENT: IdlInterface = {
  name: "HTMLLIElement",
  inherits: "HTMLElement",
  members: [attribute("value", "long")],
};

/** A `<table>` element. */
const HTML_TABLE_ELEMENT: IdlInterface = {
  name: "HTMLTableElement",
  inherits: "HTMLElement",
  members: [
    attribute("caption", nullable(iface("HTMLElement"))),
    attribute("rows", sequence(iface("HTMLTableRowElement")), { readonly: true }),
    operation("insertRow", iface("HTMLTableRowElement"), [arg("index", "long")]),
    operation("deleteRow", "void", [arg("index", "long")]),
  ],
};

/** A `<tr>` element. */
const HTML_TABLE_ROW_ELEMENT: IdlInterface = {
  name: "HTMLTableRowElement",
  inherits: "HTMLElement",
  members: [
    attribute("rowIndex", "long", { readonly: true }),
    attribute("cells", sequence(iface("HTMLElement")), { readonly: true }),
    operation("insertCell", iface("HTMLElement"), [arg("index", "long")]),
    operation("deleteCell", "void", [arg("index", "long")]),
  ],
};

/** A `<script>` element. */
const HTML_SCRIPT_ELEMENT: IdlInterface = {
  name: "HTMLScriptElement",
  inherits: "HTMLElement",
  members: [
    attribute("src", "DOMString"),
    attribute("type", "DOMString"),
    attribute("async", "boolean"),
    attribute("defer", "boolean"),
    attribute("text", "DOMString"),
  ],
};

/** A `<link>` element. */
const HTML_LINK_ELEMENT: IdlInterface = {
  name: "HTMLLinkElement",
  inherits: "HTMLElement",
  members: [
    attribute("href", "DOMString"),
    attribute("rel", "DOMString"),
    attribute("type", "DOMString"),
    attribute("media", "DOMString"),
    attribute("disabled", "boolean"),
  ],
};

/** The global object exposed to script (`window`). */
const WINDOW: IdlInterface = {
  name: "Window",
  inherits: "EventTarget",
  members: [
    attribute("document", iface("Document"), { readonly: true }),
    attribute("location", iface("Location"), { readonly: true }),
    attribute("navigator", iface("Navigator"), { readonly: true }),
    attribute("screen", iface("Screen"), { readonly: true }),
    attribute("history", iface("History"), { readonly: true }),
    attribute("performance", iface("Performance"), { readonly: true }),
    attribute("localStorage", iface("Storage"), { readonly: true }),
    attribute("sessionStorage", iface("Storage"), { readonly: true }),
    attribute("innerWidth", "long", { readonly: true }),
    attribute("innerHeight", "long", { readonly: true }),
    attribute("outerWidth", "long", { readonly: true }),
    attribute("outerHeight", "long", { readonly: true }),
    attribute("scrollX", "unrestricted double", { readonly: true }),
    attribute("scrollY", "unrestricted double", { readonly: true }),
    attribute("devicePixelRatio", "unrestricted double", { readonly: true }),
    attribute("name", "DOMString"),
    operation("getComputedStyle", iface("CSSStyleDeclaration"), [
      arg("element", iface("Element")),
    ]),
    operation("getSelection", nullable(iface("Selection"))),
    operation("matchMedia", iface("MediaQueryList"), [arg("query", "DOMString")]),
    operation("scrollTo", "void", [arg("x", "unrestricted double"), arg("y", "unrestricted double")]),
    operation("scrollBy", "void", [arg("x", "unrestricted double"), arg("y", "unrestricted double")]),
    operation("alert", "void", [arg("message", "DOMString")]),
    operation("requestAnimationFrame", "unsigned long", [arg("callback", "any")]),
    operation("cancelAnimationFrame", "void", [arg("handle", "unsigned long")]),
    operation("setTimeout", "unsigned long", [
      arg("handler", "any"),
      arg("timeout", "unrestricted double"),
    ]),
    operation("clearTimeout", "void", [arg("id", "unsigned long")]),
    operation("setInterval", "unsigned long", [
      arg("handler", "any"),
      arg("timeout", "unrestricted double"),
    ]),
    operation("clearInterval", "void", [arg("id", "unsigned long")]),
    operation("queueMicrotask", "void", [arg("callback", "any")]),
  ],
};

/** A computed/inline style declaration (`getComputedStyle`, `element.style`). */
const CSS_STYLE_DECLARATION: IdlInterface = {
  name: "CSSStyleDeclaration",
  members: [
    attribute("cssText", "DOMString"),
    attribute("length", "unsigned long", { readonly: true }),
    operation("getPropertyValue", "DOMString", [arg("property", "DOMString")]),
    operation("setProperty", "void", [
      arg("property", "DOMString"),
      arg("value", "DOMString"),
    ]),
    operation("removeProperty", "DOMString", [arg("property", "DOMString")]),
    operation("item", "DOMString", [arg("index", "unsigned long")]),
  ],
};

// ===========================================================================
// Breadth expansion — batch 3 (push to the ceiling). Live collections, the
// event-object hierarchy, ranges/selection, observers, and the ambient host
// objects (window's neighbourhood) — plus a long tail of HTML element
// interfaces. Every one is built ONLY from the existing IDL vocabulary, so the
// emitter is untouched: each is one more row, mechanism-density climbs, the
// hand-written surface does not.
// ===========================================================================

// ---- live collections -----------------------------------------------------

/** An ordered live collection of nodes (`childNodes`, `querySelectorAll`). */
const NODE_LIST: IdlInterface = {
  name: "NodeList",
  members: [
    attribute("length", "unsigned long", { readonly: true }),
    operation("item", nullable(iface("Node")), [arg("index", "unsigned long")]),
  ],
};

/** A live collection of elements (`children`, `getElementsByTagName`). */
const HTML_COLLECTION: IdlInterface = {
  name: "HTMLCollection",
  members: [
    attribute("length", "unsigned long", { readonly: true }),
    operation("item", nullable(iface("Element")), [arg("index", "unsigned long")]),
    operation("namedItem", nullable(iface("Element")), [arg("name", "DOMString")]),
  ],
};

/** An immutable rectangle (the base of `DOMRect`). */
const DOM_RECT_READ_ONLY: IdlInterface = {
  name: "DOMRectReadOnly",
  members: [
    attribute("x", "unrestricted double", { readonly: true }),
    attribute("y", "unrestricted double", { readonly: true }),
    attribute("width", "unrestricted double", { readonly: true }),
    attribute("height", "unrestricted double", { readonly: true }),
    attribute("top", "unrestricted double", { readonly: true }),
    attribute("right", "unrestricted double", { readonly: true }),
    attribute("bottom", "unrestricted double", { readonly: true }),
    attribute("left", "unrestricted double", { readonly: true }),
  ],
};

// ---- the event-object hierarchy -------------------------------------------

/** A UI event (the base of mouse/keyboard/etc.). */
const UI_EVENT: IdlInterface = {
  name: "UIEvent",
  inherits: "Event",
  members: [
    attribute("detail", "long", { readonly: true }),
    attribute("view", nullable(iface("Window")), { readonly: true }),
  ],
};

/** A mouse event. */
const MOUSE_EVENT: IdlInterface = {
  name: "MouseEvent",
  inherits: "UIEvent",
  members: [
    attribute("screenX", "unrestricted double", { readonly: true }),
    attribute("screenY", "unrestricted double", { readonly: true }),
    attribute("clientX", "unrestricted double", { readonly: true }),
    attribute("clientY", "unrestricted double", { readonly: true }),
    attribute("pageX", "unrestricted double", { readonly: true }),
    attribute("pageY", "unrestricted double", { readonly: true }),
    attribute("button", "long", { readonly: true }),
    attribute("buttons", "unsigned long", { readonly: true }),
    attribute("ctrlKey", "boolean", { readonly: true }),
    attribute("shiftKey", "boolean", { readonly: true }),
    attribute("altKey", "boolean", { readonly: true }),
    attribute("metaKey", "boolean", { readonly: true }),
    attribute("relatedTarget", nullable(iface("EventTarget")), { readonly: true }),
    operation("getModifierState", "boolean", [arg("keyArg", "DOMString")]),
  ],
};

/** A pointer (mouse/pen/touch) event. */
const POINTER_EVENT: IdlInterface = {
  name: "PointerEvent",
  inherits: "MouseEvent",
  members: [
    attribute("pointerId", "long", { readonly: true }),
    attribute("width", "unrestricted double", { readonly: true }),
    attribute("height", "unrestricted double", { readonly: true }),
    attribute("pressure", "unrestricted double", { readonly: true }),
    attribute("pointerType", "DOMString", { readonly: true }),
    attribute("isPrimary", "boolean", { readonly: true }),
  ],
};

/** A wheel (scroll) event. */
const WHEEL_EVENT: IdlInterface = {
  name: "WheelEvent",
  inherits: "MouseEvent",
  members: [
    attribute("deltaX", "unrestricted double", { readonly: true }),
    attribute("deltaY", "unrestricted double", { readonly: true }),
    attribute("deltaZ", "unrestricted double", { readonly: true }),
    attribute("deltaMode", "unsigned long", { readonly: true }),
  ],
};

/** A keyboard event. */
const KEYBOARD_EVENT: IdlInterface = {
  name: "KeyboardEvent",
  inherits: "UIEvent",
  members: [
    attribute("key", "DOMString", { readonly: true }),
    attribute("code", "DOMString", { readonly: true }),
    attribute("location", "unsigned long", { readonly: true }),
    attribute("ctrlKey", "boolean", { readonly: true }),
    attribute("shiftKey", "boolean", { readonly: true }),
    attribute("altKey", "boolean", { readonly: true }),
    attribute("metaKey", "boolean", { readonly: true }),
    attribute("repeat", "boolean", { readonly: true }),
    attribute("isComposing", "boolean", { readonly: true }),
    operation("getModifierState", "boolean", [arg("keyArg", "DOMString")]),
  ],
};

/** An editing input event. */
const INPUT_EVENT: IdlInterface = {
  name: "InputEvent",
  inherits: "UIEvent",
  members: [
    attribute("data", nullable("DOMString"), { readonly: true }),
    attribute("inputType", "DOMString", { readonly: true }),
    attribute("isComposing", "boolean", { readonly: true }),
  ],
};

/** A focus-change event. */
const FOCUS_EVENT: IdlInterface = {
  name: "FocusEvent",
  inherits: "UIEvent",
  members: [
    attribute("relatedTarget", nullable(iface("EventTarget")), { readonly: true }),
  ],
};

/** A custom (script-dispatched) event carrying an arbitrary detail. */
const CUSTOM_EVENT: IdlInterface = {
  name: "CustomEvent",
  inherits: "Event",
  members: [attribute("detail", "any", { readonly: true })],
};

// ---- ranges, selection, observers -----------------------------------------

/** A contiguous range of the document tree. */
const RANGE: IdlInterface = {
  name: "Range",
  members: [
    attribute("collapsed", "boolean", { readonly: true }),
    attribute("startContainer", iface("Node"), { readonly: true }),
    attribute("endContainer", iface("Node"), { readonly: true }),
    attribute("startOffset", "unsigned long", { readonly: true }),
    attribute("endOffset", "unsigned long", { readonly: true }),
    operation("setStart", "void", [arg("node", iface("Node")), arg("offset", "unsigned long")]),
    operation("setEnd", "void", [arg("node", iface("Node")), arg("offset", "unsigned long")]),
    operation("selectNode", "void", [arg("node", iface("Node"))]),
    operation("collapse", "void", [arg("toStart", "boolean")]),
    operation("deleteContents", "void"),
    operation("cloneRange", iface("Range")),
    operation("getBoundingClientRect", iface("DOMRect")),
  ],
};

/** The current text selection. */
const SELECTION: IdlInterface = {
  name: "Selection",
  members: [
    attribute("anchorNode", nullable(iface("Node")), { readonly: true }),
    attribute("focusNode", nullable(iface("Node")), { readonly: true }),
    attribute("rangeCount", "unsigned long", { readonly: true }),
    attribute("isCollapsed", "boolean", { readonly: true }),
    operation("getRangeAt", iface("Range"), [arg("index", "unsigned long")]),
    operation("addRange", "void", [arg("range", iface("Range"))]),
    operation("removeAllRanges", "void"),
    operation("collapse", "void", [arg("node", nullable(iface("Node"))), arg("offset", "unsigned long")]),
  ],
};

/** A single mutation recorded by a `MutationObserver`. */
const MUTATION_RECORD: IdlInterface = {
  name: "MutationRecord",
  members: [
    attribute("type", "DOMString", { readonly: true }),
    attribute("target", iface("Node"), { readonly: true }),
    attribute("addedNodes", iface("NodeList"), { readonly: true }),
    attribute("removedNodes", iface("NodeList"), { readonly: true }),
    attribute("attributeName", nullable("DOMString"), { readonly: true }),
    attribute("oldValue", nullable("DOMString"), { readonly: true }),
  ],
};

/** Observes changes to the DOM tree. */
const MUTATION_OBSERVER: IdlInterface = {
  name: "MutationObserver",
  members: [
    operation("observe", "void", [arg("target", iface("Node")), arg("options", "any")]),
    operation("disconnect", "void"),
    operation("takeRecords", sequence(iface("MutationRecord"))),
  ],
};

/** A signal that a tree element should abort its work. */
const ABORT_SIGNAL: IdlInterface = {
  name: "AbortSignal",
  inherits: "EventTarget",
  members: [
    attribute("aborted", "boolean", { readonly: true }),
    attribute("reason", "any", { readonly: true }),
    operation("throwIfAborted", "void"),
  ],
};

/** Controls one or more `AbortSignal`s. */
const ABORT_CONTROLLER: IdlInterface = {
  name: "AbortController",
  members: [
    attribute("signal", iface("AbortSignal"), { readonly: true }),
    operation("abort", "void", [arg("reason", "any")]),
  ],
};

// ---- CSS object model ------------------------------------------------------

/** A single rule in a stylesheet. */
const CSS_RULE: IdlInterface = {
  name: "CSSRule",
  members: [
    attribute("cssText", "DOMString"),
    attribute("type", "unsigned long", { readonly: true }),
  ],
};

/** A parsed stylesheet. */
const CSS_STYLE_SHEET: IdlInterface = {
  name: "CSSStyleSheet",
  members: [
    attribute("disabled", "boolean"),
    attribute("href", nullable("DOMString"), { readonly: true }),
    attribute("title", nullable("DOMString"), { readonly: true }),
    attribute("cssRules", sequence(iface("CSSRule")), { readonly: true }),
    operation("insertRule", "unsigned long", [arg("rule", "DOMString"), arg("index", "unsigned long")]),
    operation("deleteRule", "void", [arg("index", "unsigned long")]),
  ],
};

/** A live media-query match (`window.matchMedia`). */
const MEDIA_QUERY_LIST: IdlInterface = {
  name: "MediaQueryList",
  inherits: "EventTarget",
  members: [
    attribute("media", "DOMString", { readonly: true }),
    attribute("matches", "boolean", { readonly: true }),
  ],
};

// ---- the ambient host objects (window's neighbourhood) --------------------

/** High-resolution timing (`performance`). */
const PERFORMANCE: IdlInterface = {
  name: "Performance",
  inherits: "EventTarget",
  members: [
    attribute("timeOrigin", "unrestricted double", { readonly: true }),
    operation("now", "unrestricted double"),
  ],
};

/** The document's address (`location`). */
const LOCATION: IdlInterface = {
  name: "Location",
  members: [
    attribute("href", "DOMString"),
    attribute("protocol", "DOMString"),
    attribute("host", "DOMString"),
    attribute("hostname", "DOMString"),
    attribute("port", "DOMString"),
    attribute("pathname", "DOMString"),
    attribute("search", "DOMString"),
    attribute("hash", "DOMString"),
    attribute("origin", "DOMString", { readonly: true }),
    operation("assign", "void", [arg("url", "DOMString")]),
    operation("replace", "void", [arg("url", "DOMString")]),
    operation("reload", "void"),
  ],
};

/** Information about the user agent (`navigator`). */
const NAVIGATOR: IdlInterface = {
  name: "Navigator",
  members: [
    attribute("userAgent", "DOMString", { readonly: true }),
    attribute("appName", "DOMString", { readonly: true }),
    attribute("platform", "DOMString", { readonly: true }),
    attribute("language", "DOMString", { readonly: true }),
    attribute("languages", sequence("DOMString"), { readonly: true }),
    attribute("onLine", "boolean", { readonly: true }),
    attribute("cookieEnabled", "boolean", { readonly: true }),
    attribute("hardwareConcurrency", "unsigned long", { readonly: true }),
    attribute("maxTouchPoints", "unsigned long", { readonly: true }),
  ],
};

/** The output device's screen (`screen`). */
const SCREEN: IdlInterface = {
  name: "Screen",
  members: [
    attribute("width", "long", { readonly: true }),
    attribute("height", "long", { readonly: true }),
    attribute("availWidth", "long", { readonly: true }),
    attribute("availHeight", "long", { readonly: true }),
    attribute("colorDepth", "unsigned long", { readonly: true }),
    attribute("pixelDepth", "unsigned long", { readonly: true }),
  ],
};

/** The session history (`history`). */
const HISTORY: IdlInterface = {
  name: "History",
  members: [
    attribute("length", "unsigned long", { readonly: true }),
    attribute("scrollRestoration", "DOMString"),
    operation("back", "void"),
    operation("forward", "void"),
    operation("go", "void", [arg("delta", "long")]),
    operation("pushState", "void", [arg("data", "any"), arg("unused", "DOMString"), arg("url", "DOMString")]),
    operation("replaceState", "void", [arg("data", "any"), arg("unused", "DOMString"), arg("url", "DOMString")]),
  ],
};

/** Key/value web storage (`localStorage`, `sessionStorage`). */
const STORAGE: IdlInterface = {
  name: "Storage",
  members: [
    attribute("length", "unsigned long", { readonly: true }),
    operation("key", nullable("DOMString"), [arg("index", "unsigned long")]),
    operation("getItem", nullable("DOMString"), [arg("key", "DOMString")]),
    operation("setItem", "void", [arg("key", "DOMString"), arg("value", "DOMString")]),
    operation("removeItem", "void", [arg("key", "DOMString")]),
    operation("clear", "void"),
  ],
};

/** A shadow tree's root (`Element.attachShadow`). */
const SHADOW_ROOT: IdlInterface = {
  name: "ShadowRoot",
  inherits: "DocumentFragment",
  members: [
    attribute("mode", "DOMString", { readonly: true }),
    attribute("host", iface("Element"), { readonly: true }),
    attribute("innerHTML", "DOMString"),
  ],
};

// ---- HTML element long tail (all primitive members, inherit HTMLElement) ---

/** Build a plain HTML element interface from a flat list of string attributes. */
function htmlElement(name: string, stringAttrs: readonly string[]): IdlInterface {
  return {
    name,
    inherits: "HTMLElement",
    members: stringAttrs.map((attr) => attribute(attr, "DOMString")),
  };
}

const HTML_HTML_ELEMENT = htmlElement("HTMLHtmlElement", ["version"]);
const HTML_HEAD_ELEMENT: IdlInterface = { name: "HTMLHeadElement", inherits: "HTMLElement", members: [attribute("profile", "DOMString")] };
const HTML_BODY_ELEMENT = htmlElement("HTMLBodyElement", ["bgColor", "text", "link", "vLink", "aLink", "background"]);
const HTML_TITLE_ELEMENT: IdlInterface = { name: "HTMLTitleElement", inherits: "HTMLElement", members: [attribute("text", "DOMString")] };
const HTML_META_ELEMENT = htmlElement("HTMLMetaElement", ["name", "content", "httpEquiv", "charset", "media"]);
const HTML_BASE_ELEMENT = htmlElement("HTMLBaseElement", ["href", "target"]);

/** A `<style>` element. */
const HTML_STYLE_ELEMENT: IdlInterface = {
  name: "HTMLStyleElement",
  inherits: "HTMLElement",
  members: [
    attribute("media", "DOMString"),
    attribute("type", "DOMString"),
    attribute("disabled", "boolean"),
    attribute("sheet", nullable(iface("CSSStyleSheet")), { readonly: true }),
  ],
};

const HTML_BR_ELEMENT: IdlInterface = { name: "HTMLBRElement", inherits: "HTMLElement", members: [attribute("clear", "DOMString")] };
const HTML_HR_ELEMENT = htmlElement("HTMLHRElement", ["color", "size", "width", "align"]);
const HTML_PRE_ELEMENT: IdlInterface = { name: "HTMLPreElement", inherits: "HTMLElement", members: [attribute("width", "long")] };
const HTML_QUOTE_ELEMENT: IdlInterface = { name: "HTMLQuoteElement", inherits: "HTMLElement", members: [attribute("cite", "DOMString")] };
const HTML_MOD_ELEMENT = htmlElement("HTMLModElement", ["cite", "dateTime"]);
const HTML_TIME_ELEMENT: IdlInterface = { name: "HTMLTimeElement", inherits: "HTMLElement", members: [attribute("dateTime", "DOMString")] };
const HTML_DATA_ELEMENT: IdlInterface = { name: "HTMLDataElement", inherits: "HTMLElement", members: [attribute("value", "DOMString")] };
const HTML_D_LIST_ELEMENT: IdlInterface = { name: "HTMLDListElement", inherits: "HTMLElement", members: [attribute("compact", "boolean")] };
const HTML_MENU_ELEMENT: IdlInterface = { name: "HTMLMenuElement", inherits: "HTMLElement", members: [attribute("type", "DOMString")] };
const HTML_DIRECTORY_ELEMENT: IdlInterface = { name: "HTMLDirectoryElement", inherits: "HTMLElement", members: [attribute("compact", "boolean")] };

/** A `<fieldset>` element. */
const HTML_FIELD_SET_ELEMENT: IdlInterface = {
  name: "HTMLFieldSetElement",
  inherits: "HTMLElement",
  members: [
    attribute("name", "DOMString"),
    attribute("disabled", "boolean"),
    attribute("type", "DOMString", { readonly: true }),
    attribute("form", nullable(iface("HTMLFormElement")), { readonly: true }),
  ],
};

const HTML_LEGEND_ELEMENT: IdlInterface = { name: "HTMLLegendElement", inherits: "HTMLElement", members: [attribute("align", "DOMString")] };
const HTML_DATA_LIST_ELEMENT: IdlInterface = { name: "HTMLDataListElement", inherits: "HTMLElement", members: [attribute("name", "DOMString")] };
const HTML_OPT_GROUP_ELEMENT = htmlElement("HTMLOptGroupElement", ["label"]);

/** An `<output>` element. */
const HTML_OUTPUT_ELEMENT: IdlInterface = {
  name: "HTMLOutputElement",
  inherits: "HTMLElement",
  members: [
    attribute("name", "DOMString"),
    attribute("value", "DOMString"),
    attribute("defaultValue", "DOMString"),
    attribute("type", "DOMString", { readonly: true }),
  ],
};

/** A `<progress>` element. */
const HTML_PROGRESS_ELEMENT: IdlInterface = {
  name: "HTMLProgressElement",
  inherits: "HTMLElement",
  members: [
    attribute("value", "unrestricted double"),
    attribute("max", "unrestricted double"),
    attribute("position", "unrestricted double", { readonly: true }),
  ],
};

/** A `<meter>` element. */
const HTML_METER_ELEMENT: IdlInterface = {
  name: "HTMLMeterElement",
  inherits: "HTMLElement",
  members: [
    attribute("value", "unrestricted double"),
    attribute("min", "unrestricted double"),
    attribute("max", "unrestricted double"),
    attribute("low", "unrestricted double"),
    attribute("high", "unrestricted double"),
    attribute("optimum", "unrestricted double"),
  ],
};

/** The shared media-element subset (`<audio>` reuses it directly). */
const HTML_AUDIO_ELEMENT: IdlInterface = {
  name: "HTMLAudioElement",
  inherits: "HTMLElement",
  members: [
    attribute("src", "DOMString"),
    attribute("currentSrc", "DOMString", { readonly: true }),
    attribute("currentTime", "unrestricted double"),
    attribute("duration", "unrestricted double", { readonly: true }),
    attribute("paused", "boolean", { readonly: true }),
    attribute("volume", "unrestricted double"),
    attribute("muted", "boolean"),
    attribute("autoplay", "boolean"),
    attribute("loop", "boolean"),
    attribute("controls", "boolean"),
    operation("play", "void"),
    operation("pause", "void"),
  ],
};

const HTML_SOURCE_ELEMENT = htmlElement("HTMLSourceElement", ["src", "type", "srcset", "sizes", "media"]);

/** A `<track>` element. */
const HTML_TRACK_ELEMENT: IdlInterface = {
  name: "HTMLTrackElement",
  inherits: "HTMLElement",
  members: [
    attribute("kind", "DOMString"),
    attribute("src", "DOMString"),
    attribute("srclang", "DOMString"),
    attribute("label", "DOMString"),
    attribute("default", "boolean"),
  ],
};

const HTML_PICTURE_ELEMENT: IdlInterface = { name: "HTMLPictureElement", inherits: "HTMLElement", members: [attribute("title", "DOMString")] };
const HTML_MAP_ELEMENT: IdlInterface = { name: "HTMLMapElement", inherits: "HTMLElement", members: [attribute("name", "DOMString")] };

/** An `<area>` element. */
const HTML_AREA_ELEMENT: IdlInterface = {
  name: "HTMLAreaElement",
  inherits: "HTMLElement",
  members: [
    attribute("alt", "DOMString"),
    attribute("coords", "DOMString"),
    attribute("shape", "DOMString"),
    attribute("href", "DOMString"),
    attribute("target", "DOMString"),
    attribute("rel", "DOMString"),
  ],
};

/** An `<iframe>` element. */
const HTML_IFRAME_ELEMENT: IdlInterface = {
  name: "HTMLIFrameElement",
  inherits: "HTMLElement",
  members: [
    attribute("src", "DOMString"),
    attribute("srcdoc", "DOMString"),
    attribute("name", "DOMString"),
    attribute("width", "DOMString"),
    attribute("height", "DOMString"),
    attribute("allow", "DOMString"),
    attribute("contentDocument", nullable(iface("Document")), { readonly: true }),
    attribute("contentWindow", nullable(iface("Window")), { readonly: true }),
  ],
};

/** An `<object>` element. */
const HTML_OBJECT_ELEMENT: IdlInterface = {
  name: "HTMLObjectElement",
  inherits: "HTMLElement",
  members: [
    attribute("data", "DOMString"),
    attribute("type", "DOMString"),
    attribute("name", "DOMString"),
    attribute("width", "DOMString"),
    attribute("height", "DOMString"),
    attribute("contentDocument", nullable(iface("Document")), { readonly: true }),
  ],
};

const HTML_EMBED_ELEMENT = htmlElement("HTMLEmbedElement", ["src", "type", "width", "height"]);

/** A `<td>`/`<th>` table cell. */
const HTML_TABLE_CELL_ELEMENT: IdlInterface = {
  name: "HTMLTableCellElement",
  inherits: "HTMLElement",
  members: [
    attribute("colSpan", "unsigned long"),
    attribute("rowSpan", "unsigned long"),
    attribute("headers", "DOMString"),
    attribute("scope", "DOMString"),
    attribute("abbr", "DOMString"),
    attribute("cellIndex", "long", { readonly: true }),
  ],
};

/** A `<thead>`/`<tbody>`/`<tfoot>` table section. */
const HTML_TABLE_SECTION_ELEMENT: IdlInterface = {
  name: "HTMLTableSectionElement",
  inherits: "HTMLElement",
  members: [
    attribute("align", "DOMString"),
    attribute("rows", sequence(iface("HTMLTableRowElement")), { readonly: true }),
    operation("insertRow", iface("HTMLTableRowElement"), [arg("index", "long")]),
    operation("deleteRow", "void", [arg("index", "long")]),
  ],
};

/** A `<col>`/`<colgroup>` element. */
const HTML_TABLE_COL_ELEMENT: IdlInterface = {
  name: "HTMLTableColElement",
  inherits: "HTMLElement",
  members: [attribute("span", "unsigned long"), attribute("width", "DOMString")],
};

const HTML_TABLE_CAPTION_ELEMENT: IdlInterface = { name: "HTMLTableCaptionElement", inherits: "HTMLElement", members: [attribute("align", "DOMString")] };

/** A `<details>` element. */
const HTML_DETAILS_ELEMENT: IdlInterface = {
  name: "HTMLDetailsElement",
  inherits: "HTMLElement",
  members: [attribute("open", "boolean")],
};

/** A `<dialog>` element. */
const HTML_DIALOG_ELEMENT: IdlInterface = {
  name: "HTMLDialogElement",
  inherits: "HTMLElement",
  members: [
    attribute("open", "boolean"),
    attribute("returnValue", "DOMString"),
    operation("show", "void"),
    operation("showModal", "void"),
    operation("close", "void", [arg("returnValue", "DOMString")]),
  ],
};

/** A `<template>` element. */
const HTML_TEMPLATE_ELEMENT: IdlInterface = {
  name: "HTMLTemplateElement",
  inherits: "HTMLElement",
  members: [attribute("content", iface("DocumentFragment"), { readonly: true })],
};

/** A `<slot>` element. */
const HTML_SLOT_ELEMENT: IdlInterface = {
  name: "HTMLSlotElement",
  inherits: "HTMLElement",
  members: [
    attribute("name", "DOMString"),
    operation("assignedNodes", sequence(iface("Node"))),
    operation("assignedElements", sequence(iface("Element"))),
  ],
};

/**
 * The DOM interface table. The generator consumes exactly this array; order
 * defines emission order (deterministic output). Growing the surface is "add a
 * row" (Requirement 16.2) — no emitter change is needed for a new interface or
 * member built from the existing IDL type vocabulary.
 */
export const DOM_INTERFACES: readonly IdlInterface[] = [
  EVENT_TARGET,
  EVENT,
  NODE,
  CHARACTER_DATA,
  TEXT,
  COMMENT,
  DOCUMENT_FRAGMENT,
  ELEMENT,
  DOCUMENT,
  HTML_ELEMENT,
  HTML_DIV_ELEMENT,
  HTML_ANCHOR_ELEMENT,
  HTML_INPUT_ELEMENT,
  CANVAS_RENDERING_CONTEXT_2D,
  HTML_CANVAS_ELEMENT,
  HTML_VIDEO_ELEMENT,
  // Breadth expansion — supporting collection/geometry types.
  DOM_TOKEN_LIST,
  ATTR,
  NAMED_NODE_MAP,
  DOM_RECT,
  // Breadth expansion — common HTML element interfaces.
  HTML_SPAN_ELEMENT,
  HTML_PARAGRAPH_ELEMENT,
  HTML_HEADING_ELEMENT,
  HTML_IMAGE_ELEMENT,
  HTML_BUTTON_ELEMENT,
  HTML_LABEL_ELEMENT,
  HTML_SELECT_ELEMENT,
  HTML_OPTION_ELEMENT,
  HTML_TEXT_AREA_ELEMENT,
  HTML_FORM_ELEMENT,
  HTML_U_LIST_ELEMENT,
  HTML_O_LIST_ELEMENT,
  HTML_LI_ELEMENT,
  HTML_TABLE_ELEMENT,
  HTML_TABLE_ROW_ELEMENT,
  HTML_SCRIPT_ELEMENT,
  HTML_LINK_ELEMENT,
  // Breadth expansion — global + style objects.
  WINDOW,
  CSS_STYLE_DECLARATION,
  // Breadth expansion — batch 3: live collections.
  NODE_LIST,
  HTML_COLLECTION,
  DOM_RECT_READ_ONLY,
  // Breadth expansion — batch 3: the event-object hierarchy.
  UI_EVENT,
  MOUSE_EVENT,
  POINTER_EVENT,
  WHEEL_EVENT,
  KEYBOARD_EVENT,
  INPUT_EVENT,
  FOCUS_EVENT,
  CUSTOM_EVENT,
  // Breadth expansion — batch 3: ranges, selection, observers.
  RANGE,
  SELECTION,
  MUTATION_RECORD,
  MUTATION_OBSERVER,
  ABORT_SIGNAL,
  ABORT_CONTROLLER,
  // Breadth expansion — batch 3: CSS object model.
  CSS_RULE,
  CSS_STYLE_SHEET,
  MEDIA_QUERY_LIST,
  // Breadth expansion — batch 3: ambient host objects.
  PERFORMANCE,
  LOCATION,
  NAVIGATOR,
  SCREEN,
  HISTORY,
  STORAGE,
  SHADOW_ROOT,
  // Breadth expansion — batch 3: HTML element long tail.
  HTML_HTML_ELEMENT,
  HTML_HEAD_ELEMENT,
  HTML_BODY_ELEMENT,
  HTML_TITLE_ELEMENT,
  HTML_META_ELEMENT,
  HTML_BASE_ELEMENT,
  HTML_STYLE_ELEMENT,
  HTML_BR_ELEMENT,
  HTML_HR_ELEMENT,
  HTML_PRE_ELEMENT,
  HTML_QUOTE_ELEMENT,
  HTML_MOD_ELEMENT,
  HTML_TIME_ELEMENT,
  HTML_DATA_ELEMENT,
  HTML_D_LIST_ELEMENT,
  HTML_MENU_ELEMENT,
  HTML_DIRECTORY_ELEMENT,
  HTML_FIELD_SET_ELEMENT,
  HTML_LEGEND_ELEMENT,
  HTML_DATA_LIST_ELEMENT,
  HTML_OPT_GROUP_ELEMENT,
  HTML_OUTPUT_ELEMENT,
  HTML_PROGRESS_ELEMENT,
  HTML_METER_ELEMENT,
  HTML_AUDIO_ELEMENT,
  HTML_SOURCE_ELEMENT,
  HTML_TRACK_ELEMENT,
  HTML_PICTURE_ELEMENT,
  HTML_MAP_ELEMENT,
  HTML_AREA_ELEMENT,
  HTML_IFRAME_ELEMENT,
  HTML_OBJECT_ELEMENT,
  HTML_EMBED_ELEMENT,
  HTML_TABLE_CELL_ELEMENT,
  HTML_TABLE_SECTION_ELEMENT,
  HTML_TABLE_COL_ELEMENT,
  HTML_TABLE_CAPTION_ELEMENT,
  HTML_DETAILS_ELEMENT,
  HTML_DIALOG_ELEMENT,
  HTML_TEMPLATE_ELEMENT,
  HTML_SLOT_ELEMENT,
] as const;
