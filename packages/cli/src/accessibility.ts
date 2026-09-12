/**
 * Accessibility computation — the engine side of `test_driver.get_computed_role`
 * / `get_computed_label` / `get_accessibility_properties_for_element`.
 *
 * Implements the pieces of WAI-ARIA + HTML-AAM + AccName that the imported
 * WPT corpus exercises, as data tables plus small mechanisms:
 *
 *   - explicit `role` attribute resolution: ASCII-whitespace tokenization,
 *     first valid CONCRETE role wins (abstract roles are not usable), case
 *     folding, deprecated synonyms (`img`→`image`, `directory`→`list`),
 *     tokens skipped when the role requires an accessible name the element
 *     lacks (`region`, `form`), and presentational-conflict resolution
 *     (`none`/`presentation` rejected on elements with strong semantics or
 *     global ARIA attributes).
 *   - implicit roles from HTML-AAM / SVG-AAM mapping tables, with contextual
 *     rules (scoped header/footer, li in list context, select size, input
 *     types, table parts).
 *   - accessible-name computation (AccName): aria-labelledby (and the
 *     non-standard `aria-labeledby` fallback) → aria-label → host-language
 *     labelling (label elements, alt, value, legend/caption/figcaption,
 *     placeholder, title) → name-from-contents for roles that allow it.
 *   - hidden-subtree exclusion during name-from-contents, with the AccName
 *     "hidden but referenced" exception for aria-labelledby targets.
 *
 * The functions operate on the guest-facing element wrapper surface only —
 * they never touch engine internals (DomTree, kernel, IR). `getComputedStyle`
 * is injected so visibility checks consult the real cascade.
 */

/** The duck-typed slice of an element wrapper this module reads. */
export interface A11yElement {
  readonly nodeType: number;
  readonly localName: string;
  readonly data?: string;
  readonly id?: string;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  readonly parentElement: A11yElement | null;
  readonly childNodes: ArrayLike<A11yElement>;
  readonly children: ArrayLike<A11yElement>;
  readonly textContent: string;
}

export interface A11yContext {
  /** document.getElementById — resolves aria-labelledby IDREFs and label[for]. */
  getElementById(id: string): A11yElement | null;
  /** document.querySelectorAll — resolves label elements for labelable controls. */
  querySelectorAll(selector: string): ArrayLike<A11yElement>;
  /** window.getComputedStyle — real cascade output for visibility checks. */
  getComputedStyle(el: A11yElement): { getPropertyValue(name: string): string };
  /**
   * Element lookup for shadow-root traversal (host → shadow children).
   * Returns undefined when the element has NO shadow root (its light-DOM
   * children render normally); a present-but-empty root returns [].
   */
  shadowChildrenOf?(el: A11yElement): readonly A11yElement[] | undefined;
  /**
   * Nodes assigned to a `<slot>` (the shadow host's matching light-DOM
   * children). undefined = not a slot in a shadow tree → the slot's own
   * children are its rendered fallback content.
   */
  slotAssignmentOf?(slot: A11yElement): readonly A11yElement[] | undefined;
  /**
   * CSS generated content for the element's `::before`/`::after` pseudo —
   * AccName includes generated text in name-from-contents. Returns "" when
   * the engine has no generated-content resolution wired in.
   */
  pseudoContent?(el: A11yElement, which: "before" | "after"): string;
  /**
   * The document element — used to decide whether an element is connected
   * (a detached subtree tops out at an element that is not the document
   * element). Absent → everything counts as connected.
   */
  documentElement: A11yElement | undefined;
}

// ---------------------------------------------------------------------------
// Role tables (ARIA 1.3 role class hierarchy + HTML-AAM / SVG-AAM mappings)
// ---------------------------------------------------------------------------

/** Abstract roles — valid in the taxonomy but never assignable to elements. */
const ABSTRACT_ROLES = new Set([
  "command", "composite", "input", "landmark", "range", "roletype",
  "section", "sectionhead", "select", "structure", "widget", "window",
]);

/** Every concrete ARIA role. */
const CONCRETE_ROLES = new Set([
  "alert", "alertdialog", "application", "article", "banner", "blockquote",
  "button", "caption", "cell", "checkbox", "code", "columnheader", "combobox",
  "complementary", "contentinfo", "definition", "deletion", "dialog",
  "document", "emphasis", "feed", "figure", "form", "generic",
  "graphics-document", "graphics-object", "graphics-symbol", "grid",
  "gridcell", "group", "heading", "image", "insertion", "link", "list",
  "listbox", "listitem", "log", "main", "mark", "marquee", "math", "menu",
  "menubar", "menuitem", "menuitemcheckbox", "menuitemradio", "meter",
  "navigation", "none", "note", "option", "paragraph", "presentation",
  "progressbar", "radio", "radiogroup", "region", "row", "rowgroup",
  "rowheader", "scrollbar", "search", "searchbox", "sectionfooter",
  "sectionheader", "separator", "slider",
  "spinbutton", "status", "strong", "subscript", "suggestion", "superscript",
  "switch", "tab", "table", "tablist", "tabpanel", "term", "textbox", "time",
  "timer", "toolbar", "tooltip", "tree", "treegrid", "treeitem",
]);

/** Deprecated / renamed tokens normalized to their canonical role. */
const ROLE_SYNONYMS: Readonly<Record<string, string>> = {
  img: "image",
  directory: "list",
  presentation: "none",
};

/** Roles that require an accessible name to be used at all (ARIA/HTML-AAM). */
const NAME_REQUIRED_ROLES = new Set(["region", "form"]);

/**
 * Roles whose computed name comes from descendant content when the author
 * did not name the element ("name from content" per AccName).
 */
const NAME_FROM_CONTENT_ROLES = new Set([
  "button", "caption", "cell", "checkbox", "code",
  "columnheader", "definition", "deletion", "emphasis", "gridcell",
  "heading", "image", "insertion", "link",
  "listitem", "menuitem", "menuitemcheckbox", "menuitemradio", "meter",
  "option", "paragraph", "radio", "row", "rowheader", "strong",
  "subscript", "superscript", "switch", "tab", "term", "time",
  "tooltip", "treeitem",
]);

/**
 * Roles that only apply inside their required context (ARIA "required context
 * role"): an explicit token whose ancestor context is absent is skipped, and
 * the element falls back to its implicit role (or "generic").
 */
const REQUIRED_CONTEXT: Readonly<Record<string, readonly string[]>> = {
  // gridcell is context-required (tentative spec); plain cell is NOT —
  // an orphaned `role="cell"` still reports cell.
  gridcell: ["row"],
  columnheader: ["row"],
  rowheader: ["row"],
  listitem: ["group", "list"],
  menuitem: ["group", "menu", "menubar"],
  menuitemcheckbox: ["group", "menu", "menubar"],
  menuitemradio: ["group", "menu", "menubar"],
  option: ["group", "listbox"],
  row: ["grid", "rowgroup", "table", "treegrid"],
  rowgroup: ["grid", "table", "treegrid"],
  tab: ["tablist"],
  treeitem: ["group", "tree", "treegrid"],
};

/** Roles that can NEVER be named (name prohibited) — computed name is "". */
const NAME_PROHIBITED_ROLES = new Set(["generic", "none"]);

// ---------------------------------------------------------------------------
// Implicit-role tables
// ---------------------------------------------------------------------------

type ImplicitRule =
  | { readonly kind: "fixed"; readonly role: string }
  | { readonly kind: "named"; readonly named: string; readonly unnamed: string }
  | { readonly kind: "fn"; readonly compute: (el: A11yElement, ctx: A11yContext) => string };

const fixed = (role: string): ImplicitRule => ({ kind: "fixed", role });
const named = (yes: string, no = "generic"): ImplicitRule => ({ kind: "named", named: yes, unnamed: no });
const fn = (compute: (el: A11yElement, ctx: A11yContext) => string): ImplicitRule => ({ kind: "fn", compute });

/** True when any ancestor (inclusive of document scope boundary) is a sectioning root. */
function scopedToSectioning(el: A11yElement): boolean {
  let cur = el.parentElement;
  while (cur !== null) {
    if (["article", "aside", "nav", "section", "blockquote", "details", "dialog", "fieldset", "figure", "td"].includes(cur.localName)) {
      return true;
    }
    cur = cur.parentElement;
  }
  return false;
}

/**
 * Sectioning scope plus `main`: per the tentative HTML-AAM proposal, a
 * footer/header inside main is `sectionfooter`/`sectionheader` (main is not
 * itself sectioning content for `aside`, but it does scope header/footer).
 */
function scopedToSectioningOrMain(el: A11yElement): boolean {
  let cur = el.parentElement;
  while (cur !== null) {
    if (["article", "aside", "main", "nav", "section", "blockquote", "details", "dialog", "fieldset", "figure", "td"].includes(cur.localName)) {
      return true;
    }
    cur = cur.parentElement;
  }
  return false;
}

/** True when the element has an SVG ancestor (namespace-adjacent approximation). */
function inSvg(el: A11yElement): boolean {
  let cur = el.parentElement;
  while (cur !== null) {
    if (cur.localName === "svg") return true;
    cur = cur.parentElement;
  }
  return false;
}

/** True for elements governed by SVG-AAM: the svg root and its descendants. */
function isSvgElement(el: A11yElement): boolean {
  return el.localName === "svg" || inSvg(el);
}

/**
 * SVG-AAM host-language label: the first `<title>` ELEMENT child names an
 * SVG element (comp_host_language_label: `circle > title` → "circle label").
 * Returns the title's text or null.
 */
function svgTitleText(el: A11yElement): string | null {
  const kids = el.children;
  for (let i = 0; i < kids.length; i += 1) {
    const kid = kids[i] as A11yElement;
    if (kid.localName === "title") {
      const text = (kid.textContent ?? "").trim();
      return text === "" ? null : text;
    }
  }
  return null;
}

const INPUT_TYPE_ROLES: Readonly<Record<string, string>> = {
  button: "button", submit: "button", reset: "button", image: "button",
  checkbox: "checkbox", radio: "radio", range: "slider", number: "spinbutton",
  search: "searchbox", hidden: "none",
  tel: "textbox", text: "textbox", url: "textbox", email: "textbox",
  password: "textbox", file: "button",
};

/** HTML-AAM: element → implicit-role rule. */
const HTML_IMPLICIT: Readonly<Record<string, ImplicitRule>> = {
  html: fixed("document"),
  body: fixed("generic"),
  address: fixed("group"),
  article: fixed("article"),
  // aside scoped inside sectioning content is generic UNLESS it carries an
  // accessible name (then the landmark is preserved). `main` is NOT
  // sectioning content — an aside inside main stays complementary.
  aside: fn((el, ctx) => (scopedToSectioning(el) ? (hasNameHint(el, ctx) ? "complementary" : "generic") : "complementary")),
  blockquote: fixed("blockquote"),
  br: fixed("none"),
  wbr: fixed("none"),
  button: fixed("button"),
  caption: fixed("caption"),
  code: fixed("code"),
  datalist: fixed("listbox"),
  dd: fixed("definition"),
  del: fixed("deletion"),
  details: fixed("group"),
  dfn: fixed("term"),
  dialog: fixed("dialog"),
  div: fixed("generic"),
  dl: fixed("generic"),
  dt: fixed("term"),
  em: fixed("emphasis"),
  fieldset: fixed("group"),
  figcaption: fixed("caption"),
  figure: fixed("figure"),
  // Tentative HTML-AAM: footer/header scoped to sectioning content OR main
  // (or carrying an accessible name anywhere) map to sectionfooter/
  // sectionheader; only a body-scoped, unnamed one is a page landmark.
  footer: fn((el, ctx) =>
    scopedToSectioningOrMain(el) || hasNameHint(el, ctx) ? "sectionfooter" : "contentinfo",
  ),
  form: named("form"),
  h1: fixed("heading"), h2: fixed("heading"), h3: fixed("heading"),
  h4: fixed("heading"), h5: fixed("heading"), h6: fixed("heading"),
  header: fn((el, ctx) =>
    scopedToSectioningOrMain(el) || hasNameHint(el, ctx) ? "sectionheader" : "banner",
  ),
  hgroup: fixed("group"),
  hr: fixed("separator"),
  iframe: fixed("none"),
  // alt="" normally means presentational, but an explicit author name
  // (aria-label/-labelledby/title) overrides that back to image.
  img: fn((el, ctx) => (el.getAttribute("alt") === "" && !hasExplicitAriaName(el, ctx) ? "none" : "image")),
  dir: fixed("list"),
  ins: fixed("insertion"),
  li: fn((el) => {
    let cur = el.parentElement;
    while (cur !== null) {
      if (["ul", "ol", "menu"].includes(cur.localName)) return "listitem";
      if (cur.localName === "li" || cur.localName === "body") break;
      cur = cur.parentElement;
    }
    // An orphaned <li> (no ul/ol/menu ancestor) is NOT a listitem.
    return "generic";
  }),
  main: fixed("main"),
  mark: fixed("mark"),
  menu: fixed("list"),
  meter: fixed("meter"),
  nav: fixed("navigation"),
  ol: fixed("list"),
  ul: fixed("list"),
  optgroup: fixed("group"),
  option: fixed("option"),
  output: fixed("status"),
  p: fixed("paragraph"),
  picture: fixed("none"),
  pre: fixed("generic"),
  progress: fixed("progressbar"),
  s: fixed("deletion"),
  search: fixed("search"),
  section: named("region"),
  select: fn((el) => {
    const multiple = el.hasAttribute("multiple");
    const size = Number(el.getAttribute("size") ?? "1");
    return multiple || size > 1 ? "listbox" : "combobox";
  }),
  span: fixed("generic"),
  strong: fixed("strong"),
  sub: fixed("subscript"),
  sup: fixed("superscript"),
  summary: fixed("button"),
  table: fixed("table"),
  tbody: fixed("rowgroup"),
  thead: fixed("rowgroup"),
  tfoot: fixed("rowgroup"),
  td: fixed("cell"),
  textarea: fixed("textbox"),
  th: fn((el) => {
    // HTML-AAM auto-scope: explicit scope wins; a th inside thead is a
    // columnheader; the FIRST cell of a tbody/tfoot row is a rowheader.
    const scope = (el.getAttribute("scope") ?? "").toLowerCase();
    if (scope === "row" || scope === "rowgroup") return "rowheader";
    if (scope === "col" || scope === "colgroup") return "columnheader";
    const tr = el.parentElement;
    if (tr === null || tr.localName !== "tr") return "columnheader";
    const section = tr.parentElement;
    if (section !== null && section.localName === "thead") return "columnheader";
    const cells = tr.children;
    if (cells.length > 0 && (cells[0] as A11yElement) === el) return "rowheader";
    return "columnheader";
  }),
  time: fixed("time"),
  tr: fixed("row"),
  a: fn((el) => (el.hasAttribute("href") ? "link" : "generic")),
  area: fn((el) => (el.hasAttribute("href") ? "link" : "generic")),
  input: fn((el) => {
    const type = (el.getAttribute("type") ?? "text").toLowerCase();
    if (type === "checkbox" && el.hasAttribute("switch")) return "switch";
    return INPUT_TYPE_ROLES[type] ?? "textbox";
  }),
};

/**
 * SVG-AAM "has an accessible name" probe for role selection: the ARIA name
 * hints PLUS the SVG host-language mechanisms — a `<title>` element child or
 * an `xlink:title` attribute make a shape/group named.
 */
function svgNameHint(el: A11yElement, ctx: A11yContext): boolean {
  if (hasNameHint(el, ctx)) return true;
  const xlinkTitle = el.getAttribute("xlink:title");
  if (xlinkTitle !== null && xlinkTitle.trim() !== "") return true;
  return svgTitleText(el) !== null;
}

const svgNamed = (yes: string): ImplicitRule =>
  fn((el, ctx) => (svgNameHint(el, ctx) ? yes : "generic"));

/** SVG-AAM: element → implicit role when inside an SVG context. Unlabeled
 *  graphics elements are `generic` (SVG-AAM §5.1.2); a name (ARIA hints,
 *  `<title>` child, `xlink:title`) promotes shapes to `graphics-symbol` and
 *  containers to `group`. */
const SVG_IMPLICIT: Readonly<Record<string, ImplicitRule>> = {
  svg: fixed("graphics-document"),
  symbol: fixed("graphics-object"),
  use: fixed("graphics-object"),
  image: fixed("image"),
  g: svgNamed("group"),
  foreignObject: svgNamed("group"),
  a: fn((el) => (el.hasAttribute("href") || el.hasAttribute("xlink:href") ? "link" : "generic")),
  desc: fixed("group"),
  title: fixed("group"),
  circle: svgNamed("graphics-symbol"),
  ellipse: svgNamed("graphics-symbol"),
  line: svgNamed("graphics-symbol"),
  path: svgNamed("graphics-symbol"),
  polygon: svgNamed("graphics-symbol"),
  polyline: svgNamed("graphics-symbol"),
  rect: svgNamed("graphics-symbol"),
  text: fixed("group"),
};

// ---------------------------------------------------------------------------
// Hidden / naming helpers
// ---------------------------------------------------------------------------

/** ASCII whitespace only (HTML infra): NOT \s (excludes U+00A0, U+2800, …). */
const ASCII_WS = /[\t\n\f\r ]+/;

/**
 * ARIA GLOBAL states and properties only (aria-level, aria-checked etc. are
 * role-specific — they do not trigger presentational conflict rejection).
 */
const GLOBAL_ARIA_ATTRS = new Set([
  "aria-atomic", "aria-busy", "aria-controls", "aria-current",
  "aria-describedby", "aria-description", "aria-details", "aria-disabled",
  "aria-dropeffect", "aria-errormessage", "aria-flowto", "aria-grabbed",
  "aria-haspopup", "aria-hidden", "aria-invalid", "aria-keyshortcuts",
  "aria-label", "aria-labelledby", "aria-labeledby", "aria-live", "aria-owns",
  "aria-relevant", "aria-roledescription",
]);

function hasGlobalAriaAttribute(el: A11yElement): boolean {
  for (const name of GLOBAL_ARIA_ATTRS) {
    if (el.hasAttribute(name)) return true;
  }
  return false;
}

function isFocusable(el: A11yElement): boolean {
  if (el.hasAttribute("tabindex") || el.hasAttribute("contenteditable")) return true;
  const tag = el.localName;
  switch (tag) {
    case "a":
    case "area":
      return el.hasAttribute("href");
    case "input":
      return (el.getAttribute("type") ?? "").toLowerCase() !== "hidden";
    case "button":
    case "select":
    case "textarea":
    case "summary":
    case "iframe":
      return true;
    case "audio":
    case "video":
      return el.hasAttribute("controls");
    default:
      return false;
  }
}

/**
 * Cheap "would this element have an accessible name" probe used INSIDE role
 * computation — it must not recurse through {@link accessibleName} (which
 * itself consults the computed role). Covers the author-provided mechanisms
 * the corpus exercises: aria-label, aria-labelledby/labeledby, title.
 */
function hasNameHint(el: A11yElement, ctx: A11yContext): boolean {
  const label = el.getAttribute("aria-label");
  if (label !== null && label.trim() !== "") return true;
  const by = el.getAttribute("aria-labelledby") ?? el.getAttribute("aria-labeledby");
  if (by !== null && by.trim() !== "") {
    // A labelledby that resolves no element does not count as a name.
    for (const id of by.split(ASCII_WS)) {
      if (id !== "" && ctx.getElementById(id) !== null) return true;
    }
  }
  const title = el.getAttribute("title");
  if (title !== null && title !== "") return true;
  return false;
}

/**
 * Narrower probe for presentational overrides: only explicit ARIA naming
 * (aria-label / resolvable aria-labelledby) — NOT title. An `img alt=""`
 * stays presentational when it only has a title (html-aam el-img-empty-alt-
 * title → none), but an aria-label re-elevates it to image.
 */
function hasExplicitAriaName(el: A11yElement, ctx: A11yContext): boolean {
  const label = el.getAttribute("aria-label");
  if (label !== null && label.trim() !== "") return true;
  const by = el.getAttribute("aria-labelledby") ?? el.getAttribute("aria-labeledby");
  if (by === null || by.trim() === "") return false;
  for (const id of by.split(ASCII_WS)) {
    if (id !== "" && ctx.getElementById(id) !== null) return true;
  }
  return false;
}

/**
 * How an element is excluded from the accessibility tree:
 *   - "subtree": the whole subtree is hidden (display:none, hidden attribute,
 *     aria-hidden) — children cannot be re-exposed.
 *   - "self": the element itself is hidden but descendants may re-appear
 *     (visibility:hidden/collapse is overridable by children).
 */
function hiddenState(el: A11yElement, ctx: A11yContext): "subtree" | "self" | null {
  if (el.hasAttribute("hidden")) return "subtree";
  if (el.getAttribute("aria-hidden") === "true") return "subtree";
  try {
    const style = ctx.getComputedStyle(el);
    if (style.getPropertyValue("display") === "none") return "subtree";
    const visibility = style.getPropertyValue("visibility");
    if (visibility === "hidden" || visibility === "collapse") return "self";
  } catch {
    // getComputedStyle may be unavailable in minimal harnesses — attribute
    // checks above still apply.
  }
  return null;
}

/**
 * Whether a child element sits on its own line for naming purposes: AccName
 * joins block-level contributions with a space; inline content concatenates
 * directly. Missing/"contents"/"none" styles count as inline.
 */
function isInlineLevel(el: A11yElement, ctx: A11yContext): boolean {
  try {
    const display = ctx.getComputedStyle(el).getPropertyValue("display");
    return display === "" || display === "inline" || display === "contents" || display === "none";
  } catch {
    return true;
  }
}

function computedStyleProp(el: A11yElement, ctx: A11yContext, prop: string): string {
  try {
    return ctx.getComputedStyle(el).getPropertyValue(prop);
  } catch {
    return "";
  }
}

/** CSS text-transform applied to a text contribution. */
function applyTextTransform(text: string, transform: string): string {
  switch (transform) {
    case "uppercase":
      return text.toUpperCase();
    case "lowercase":
      return text.toLowerCase();
    case "capitalize":
      return text.replace(/(^|\s)(\S)/g, (_m, ws: string, c: string) => ws + c.toUpperCase());
    default:
      return text;
  }
}

// ---------------------------------------------------------------------------
// Computed role
// ---------------------------------------------------------------------------

function implicitRole(el: A11yElement, ctx: A11yContext): string {
  const tag = el.localName;
  const rule = inSvg(el) ? (SVG_IMPLICIT[tag] ?? HTML_IMPLICIT[tag]) : HTML_IMPLICIT[tag];
  if (rule === undefined) return "generic";
  switch (rule.kind) {
    case "fixed":
      return rule.role;
    case "named":
      return hasNameHint(el, ctx) ? rule.named : rule.unnamed;
    case "fn":
      return rule.compute(el, ctx);
  }
}

/**
 * DOM `isConnected`: the element's ancestor chain tops out at the document
 * element. Detached elements are not in the accessibility tree — test_driver
 * returns "" for them.
 */
export function isConnectedToDocument(el: A11yElement, ctx: A11yContext): boolean {
  if (ctx.documentElement === undefined) return true;
  let cur = el;
  while (cur.parentElement !== null) cur = cur.parentElement;
  return cur === ctx.documentElement;
}

/** Walk ancestors: does any compute to one of the required context roles? */
function hasAncestorRole(el: A11yElement, ctx: A11yContext, roles: readonly string[]): boolean {
  let cur = el.parentElement;
  while (cur !== null) {
    if (roles.includes(computedRole(cur, ctx))) return true;
    cur = cur.parentElement;
  }
  return false;
}

/**
 * The element's computed ARIA role:
 *   explicit role tokens (first valid concrete role that can apply) →
 *   implicit HTML-AAM / SVG-AAM mapping → "generic".
 */
export function computedRole(el: A11yElement, ctx: A11yContext): string {
  const roleAttr = el.getAttribute("role");
  if (roleAttr !== null && roleAttr !== undefined) {
    for (const raw of roleAttr.split(ASCII_WS)) {
      if (raw === "") continue;
      let token = raw.toLowerCase();
      if (token in ROLE_SYNONYMS) token = ROLE_SYNONYMS[token] as string;
      if (!CONCRETE_ROLES.has(token) || ABSTRACT_ROLES.has(token)) continue;
      if (NAME_REQUIRED_ROLES.has(token) && !hasNameHint(el, ctx)) continue;
      const required = REQUIRED_CONTEXT[token];
      if (required !== undefined && !hasAncestorRole(el, ctx, required)) continue;
      if (token === "none") {
        // Presentational conflict: none/presentation is rejected on elements
        // with STRONG native semantics (interactive widgets), focusability,
        // or global ARIA attributes. Structurally-marking roles like
        // paragraph/heading/listitem are NOT strong — `role="none"` applies
        // and the element drops out of the tree (reported as "generic").
        if (isFocusable(el) || hasGlobalAriaAttribute(el)) continue;
        if (STRONG_IMPLICIT_ROLES.has(implicitRole(el, ctx))) continue;
        return "generic";
      }
      return token;
    }
  }
  const implicit = implicitRole(el, ctx);
  // A resolved none/presentation (explicit or implicit, e.g. img alt="")
  // reports as "generic" — the element is absent from the a11y tree.
  return implicit === "none" || implicit === "presentation" ? "generic" : implicit;
}

/**
 * Implicit roles carrying strong native (interactive-widget) semantics —
 * `role="none"`/`presentation` is rejected on these per ARIA's
 * presentational-conflict resolution.
 */
const STRONG_IMPLICIT_ROLES = new Set([
  "link", "button", "textbox", "searchbox", "checkbox", "radio", "switch",
  "combobox", "listbox", "slider", "spinbutton", "tab", "menuitem",
  "menuitemcheckbox", "menuitemradio", "option", "treeitem", "gridcell",
  "cell", "columnheader", "rowheader", "document", "application",
]);

// ---------------------------------------------------------------------------
// Accessible name (AccName)
// ---------------------------------------------------------------------------

/** Roles whose embedded elements contribute a control VALUE as their name. */
/** Walk every descendant element (light DOM, then shadow children). */
function descendants(el: A11yElement, ctx: A11yContext, out: A11yElement[] = []): A11yElement[] {
  const kids = el.children;
  for (let i = 0; i < kids.length; i += 1) {
    const kid = kids[i] as A11yElement;
    out.push(kid);
    descendants(kid, ctx, out);
  }
  const shadowKids = ctx.shadowChildrenOf?.(el);
  if (shadowKids !== undefined) {
    for (const kid of shadowKids) {
      out.push(kid);
      descendants(kid, ctx, out);
    }
  }
  return out;
}

/**
 * The text a listbox/combobox contributes when embedded in another name: the
 * selected option's contents (`aria-selected`/`selected`, else the first
 * option for a native `select`).
 */
function selectedOptionText(el: A11yElement, ctx: A11yContext, visited: Set<A11yElement>): string | null {
  const options = descendants(el, ctx).filter(
    (d) => d.localName === "option" || computedRole(d, ctx) === "option",
  );
  if (options.length === 0) return null;
  for (const option of options) {
    if (option.getAttribute("aria-selected") === "true" || option.hasAttribute("selected")) {
      visited.add(option);
      return contentsName(option, ctx, visited);
    }
  }
  if (el.localName === "select") {
    visited.add(options[0] as A11yElement);
    return contentsName(options[0] as A11yElement, ctx, visited);
  }
  return null;
}

/**
 * Embedded-widget contribution per AccName §"Embedded Control": when a widget
 * sits inside another element's name-from-contents, it contributes its VALUE
 * rather than its own accessible name.
 *   - range widgets (slider/spinbutton/progressbar/meter): aria-valuetext →
 *     aria-valuenow → value attribute
 *   - textbox/searchbox: value attribute
 *   - combobox: own value → selected option → embedded textbox value → contents
 *   - listbox: selected option text
 * Returns undefined when the element is not an embedded widget.
 */
function embeddedControlValue(el: A11yElement, role: string, ctx: A11yContext, visited: Set<A11yElement>): string | undefined {
  switch (role) {
    case "slider":
    case "spinbutton":
    case "progressbar":
    case "meter": {
      return el.getAttribute("aria-valuetext") ?? el.getAttribute("aria-valuenow") ?? el.getAttribute("value") ?? "";
    }
    case "textbox":
    case "searchbox": {
      return el.getAttribute("value") ?? "";
    }
    case "combobox": {
      const own = el.getAttribute("value");
      if (own !== null) return own;
      const selected = selectedOptionText(el, ctx, visited);
      if (selected !== null) return selected;
      const textbox = descendants(el, ctx).find(
        (d) => computedRole(d, ctx) === "textbox" || computedRole(d, ctx) === "searchbox",
      );
      if (textbox !== undefined) return textbox.getAttribute("value") ?? "";
      return contentsName(el, ctx, visited);
    }
    case "listbox": {
      return selectedOptionText(el, ctx, visited) ?? "";
    }
    default:
      return undefined;
  }
}

/**
 * One child's contribution to a name-from-contents computation: its own
 * accessible name when it has author/host naming, its control value when it
 * is an embedded widget, or the recursion into its subtree otherwise.
 */
function childContribution(child: A11yElement, ctx: A11yContext, visited: Set<A11yElement>, ignoreHidden = false): string {
  if (child.nodeType !== 1) return "";
  if (child.localName === "br") return " ";
  if (child.localName === "slot" && ctx.slotAssignmentOf !== undefined) {
    return slotContribution(child, ctx, visited, ignoreHidden);
  }
  if (visited.has(child)) return "";
  visited.add(child);
  const hidden = ignoreHidden ? null : hiddenState(child, ctx);
  if (hidden === "subtree") return "";
  if (hidden === "self") {
    // visibility:hidden — the element itself contributes nothing, but its
    // descendants may re-expose themselves with visibility:visible.
    let out = "";
    const grand = child.children;
    for (let i = 0; i < grand.length; i += 1) {
      const part = childContribution(grand[i] as A11yElement, ctx, visited, ignoreHidden);
      if (part !== "") out += isInlineLevel(grand[i] as A11yElement, ctx) ? part : ` ${part} `;
    }
    return out;
  }
  const embedded = embeddedControlValue(child, computedRole(child, ctx), ctx, visited);
  if (embedded !== undefined) return embedded;
  const named = authorProvidedName(child, ctx, visited);
  if (named !== "") return named;
  return contentsName(child, ctx, visited, true, ignoreHidden);
}

/**
 * Flatten descendant text for name-from-contents. `includeText=false` skips
 * direct text nodes (visibility:hidden parents) while still letting element
 * descendants contribute. `ignoreHidden` suspends all hidden checks — the
 * subtree of a hidden-but-referenced element is traversed as if rendered.
 * Block-level children are space-separated.
 */
function contentsName(el: A11yElement, ctx: A11yContext, visited: Set<A11yElement>, includeText = true, ignoreHidden = false): string {
  // `::before` generated content renders as the element's first child.
  let out = ctx.pseudoContent?.(el, "before") ?? "";
  const transform = computedStyleProp(el, ctx, "text-transform");
  // Flat-tree semantics: a host with a shadow root renders ONLY its shadow
  // children; light-DOM children re-enter exclusively through `<slot>`s.
  const kids = ctx.shadowChildrenOf?.(el) ?? el.childNodes;
  out += nodeListContribution(kids, ctx, visited, includeText, ignoreHidden, transform);
  out += ctx.pseudoContent?.(el, "after") ?? "";
  return out;
}

/** Contribution of a node list (light children, shadow children, or the
 *  nodes assigned to a slot) to a name-from-contents traversal. */
function nodeListContribution(
  kids: ArrayLike<A11yElement>,
  ctx: A11yContext,
  visited: Set<A11yElement>,
  includeText: boolean,
  ignoreHidden: boolean,
  transform: string,
): string {
  let out = "";
  for (let i = 0; i < kids.length; i += 1) {
    const kid = kids[i] as A11yElement;
    if (kid.nodeType === 3) {
      if (includeText) out += applyTextTransform(kid.data ?? "", transform);
      continue;
    }
    if (kid.nodeType !== 1) continue;
    const part = childContribution(kid, ctx, visited, ignoreHidden);
    if (part !== "") out += isInlineLevel(kid, ctx) ? part : ` ${part} `;
  }
  return out;
}

/**
 * A `<slot>`'s contribution: its assigned nodes (the shadow host's matching
 * light-DOM children), or its own fallback content when nothing is assigned.
 * Per AccName the slot's own aria-label does not substitute slotted text.
 */
function slotContribution(slot: A11yElement, ctx: A11yContext, visited: Set<A11yElement>, ignoreHidden: boolean): string {
  const assigned = ctx.slotAssignmentOf?.(slot);
  if (assigned === undefined) return contentsName(slot, ctx, visited, true, ignoreHidden);
  if (assigned.length === 0) return contentsName(slot, ctx, visited, true, ignoreHidden);
  return nodeListContribution(assigned, ctx, visited, true, ignoreHidden, "");
}

/** Host-language labelling: label elements, alt, value, legend/caption, etc. */
function hostLanguageName(el: A11yElement, ctx: A11yContext, visited: Set<A11yElement>): string {
  // An element can never contribute to its own name: mark it visited so a
  // wrapping <label> (or legend) traversal skips the control itself rather
  // than re-entering this path and double-counting the label text.
  visited.add(el);
  const tag = el.localName;
  if (tag === "img" || tag === "area" || (tag === "input" && el.getAttribute("type") === "image")) {
    const alt = el.getAttribute("alt");
    if (alt !== null) return alt;
  }
  if (tag === "input") {
    const type = (el.getAttribute("type") ?? "text").toLowerCase();
    if (type === "button" || type === "submit" || type === "reset") {
      const value = el.getAttribute("value");
      if (value !== null && value !== "") return value;
      if (type === "submit") return "Submit";
      if (type === "reset") return "Reset";
      return "";
    }
  }
  if (["input", "textarea", "select", "meter", "output", "progress"].includes(tag)) {
    // label[for=id] association, then a wrapping <label>. The label's name is
    // its CONTENTS (embedded controls contribute their values), not raw
    // textContent.
    const id = el.getAttribute("id");
    if (id !== null && id !== "") {
      const labels = ctx.querySelectorAll("label");
      const parts: string[] = [];
      for (let i = 0; i < labels.length; i += 1) {
        const label = labels[i] as A11yElement;
        if (label.getAttribute("for") === id) {
          visited.add(label);
          parts.push(contentsName(label, ctx, visited, true));
        }
      }
      const joined = parts.filter((p) => p !== "").join(" ");
      if (joined !== "") return joined;
    }
    let cur = el.parentElement;
    while (cur !== null) {
      if (cur.localName === "label") {
        visited.add(cur);
        const name = contentsName(cur, ctx, visited, true);
        if (name !== "") return name;
      }
      cur = cur.parentElement;
    }
    // For labelable controls `title` outranks `placeholder` (comp_tooltip).
    const title = el.getAttribute("title");
    if (title !== null && title !== "") return title;
    const placeholder = el.getAttribute("placeholder");
    if (placeholder !== null && placeholder !== "") return placeholder;
  }
  // SVG-AAM §8.1: a `<title>` element child names its SVG element, and the
  // deprecated `xlink:title` attribute is the other host-language label.
  // (The link cases — `a > svg > title` — resolve through the svg's own
  // author-provided name bubbling up as its content contribution.)
  if (isSvgElement(el)) {
    const kids = el.children;
    for (let i = 0; i < kids.length; i += 1) {
      const kid = kids[i] as A11yElement;
      if (kid.localName === "title") {
        visited.add(kid);
        const text = contentsName(kid, ctx, visited, true);
        if (text.trim() !== "") return text;
      }
    }
    const xlinkTitle = el.getAttribute("xlink:title");
    if (xlinkTitle !== null && xlinkTitle !== "") return xlinkTitle;
  }
  // details is NOT named by its summary (html-aam/names: "details no name"
  // expects "") — only fieldset/figure/table take a caption-element name.
  if (tag === "fieldset" || tag === "figure" || tag === "table") {
    const wanted = tag === "fieldset" ? "legend" : tag === "figure" ? "figcaption" : "caption";
    const kids = el.children;
    for (let i = 0; i < kids.length; i += 1) {
      const kid = kids[i] as A11yElement;
      if (kid.localName === wanted) {
        visited.add(kid);
        return contentsName(kid, ctx, visited, true);
      }
    }
  }
  return "";
}

/**
 * The element's accessible name (AccName). `visited` guards the labelledby
 * recursion against cycles. Elements referenced by aria-labelledby contribute
 * their name even when hidden ("hidden but referenced").
 */
/**
 * Author-provided naming only — aria-labelledby/labeledby, aria-label,
 * host-language labelling (label/alt/value/legend/placeholder), title.
 * Never recurses into name-from-contents.
 */
function authorProvidedName(el: A11yElement, ctx: A11yContext, visited: Set<A11yElement>): string {
  for (const attr of ["aria-labelledby", "aria-labeledby"]) {
    const refs = el.getAttribute(attr);
    if (refs === null || refs.trim() === "") continue;
    const parts: string[] = [];
    for (const id of refs.split(ASCII_WS)) {
      if (id === "") continue;
      const target = ctx.getElementById(id);
      if (target === null || visited.has(target)) continue;
      visited.add(target);
      parts.push(referencedName(target, ctx, visited));
    }
    const joined = parts.filter((p) => p !== "").join(" ");
    if (joined !== "") return joined;
  }
  const label = el.getAttribute("aria-label");
  if (label !== null && label.trim() !== "") return label;
  const host = hostLanguageName(el, ctx, visited);
  if (host !== "") return host;
  return "";
}

/**
 * The element's accessible name (AccName). `visited` guards the labelledby
 * recursion against cycles. Elements referenced by aria-labelledby contribute
 * their name even when hidden ("hidden but referenced").
 */
export function accessibleName(el: A11yElement, ctx: A11yContext, visited: Set<A11yElement>): string {
  const named = authorProvidedName(el, ctx, visited);
  if (named !== "") return collapseName(named);
  // A present `alt` (even empty) is definitive for images — it suppresses
  // the title fallback: `img alt="" title="x"` has NO accessible name.
  const tag = el.localName;
  if (tag === "img" || tag === "area" || (tag === "input" && (el.getAttribute("type") ?? "").toLowerCase() === "image")) {
    const alt = el.getAttribute("alt");
    if (alt !== null) return collapseName(alt);
  }
  const role = computedRole(el, ctx);
  // `title` is the tooltip / last-resort name — it applies AFTER
  // name-from-contents for content-named roles, and as the only fallback
  // for author-named AND name-prohibited roles (comp_tooltip: an abbr or
  // iframe — both generic/none — still reports its title).
  const title = el.getAttribute("title");
  if (NAME_PROHIBITED_ROLES.has(role) || !NAME_FROM_CONTENT_ROLES.has(role)) {
    return title !== null && title !== "" ? collapseName(title) : "";
  }
  visited.add(el);
  const fromContents = contentsName(el, ctx, visited, true);
  if (fromContents.trim() !== "") return collapseName(fromContents);
  return title !== null && title !== "" ? collapseName(title) : "";
}

/**
 * AccName whitespace normalization: collapse runs of ASCII whitespace and
 * trim. `&nbsp;` (\u00A0) is NOT ASCII whitespace — it is a real character
 * and must be preserved (comp_text_node / comp_label nbsp tests).
 */
function collapseName(name: string): string {
  return name.replace(/[ \t\n\f\r]+/g, " ").replace(/^[ \t\n\f\r]+|[ \t\n\f\r]+$/g, "");
}

/**
 * Name of an element reached through aria-labelledby. Two differences from a
 * normal accessibleName call:
 *   - hidden elements still contribute ("hidden but referenced"),
 *   - the referenced element's own aria-labelledby is NOT chained — its
 *     contribution is aria-label → host-language naming → subtree contents.
 *     (Without this, a self-referencing `aria-labelledby="self heading"`
 *     would consume the heading twice.)
 */
function referencedName(el: A11yElement, ctx: A11yContext, visited: Set<A11yElement>): string {
  const label = el.getAttribute("aria-label");
  if (label !== null && label.trim() !== "") return label;
  const host = hostLanguageName(el, ctx, visited);
  if (host !== "") return host;
  // "Hidden but referenced": when the referenced element itself is hidden,
  // its whole subtree is traversed AS IF RENDERED (hidden checks suspended —
  // comp_labelledby_hidden_nodes: a hidden span's nested spans contribute).
  // A VISIBLE referenced element's descendants are hidden-checked normally.
  const contents = contentsName(el, ctx, visited, true, hiddenState(el, ctx) !== null);
  if (contents.trim() !== "") return contents;
  const title = el.getAttribute("title");
  return title !== null && title !== "" ? title : "";
}

// ---------------------------------------------------------------------------
// Accessibility properties bundle (test_driver shape)
// ---------------------------------------------------------------------------

/**
 * `get_accessibility_properties_for_element`: {role, label, …aria states}.
 * `children` carries per-element a11y node ids (see {@link A11yRegistry}) so
 * `get_accessibility_properties_for_accessibility_node` can walk the tree.
 */
export function accessibilityProperties(el: A11yElement, ctx: A11yContext, idFor?: (el: A11yElement) => string): Record<string, unknown> {
  const role = computedRole(el, ctx);
  const props: Record<string, unknown> = {
    role,
    label: accessibleName(el, ctx, new Set()),
  };
  const boolAttrs: Record<string, string> = {
    "aria-pressed": "pressed",
    "aria-checked": "checked",
    "aria-expanded": "expanded",
    "aria-selected": "selected",
    "aria-disabled": "disabled",
    "aria-readonly": "readonly",
    "aria-required": "required",
  };
  for (const [attr, key] of Object.entries(boolAttrs)) {
    const v = el.getAttribute(attr);
    if (v !== null) props[key] = v;
  }
  const level = el.getAttribute("aria-level");
  if (level !== null) props["level"] = level;
  const children: string[] = [];
  const kids = el.children;
  for (let i = 0; i < kids.length; i += 1) {
    const kid = kids[i] as A11yElement;
    if (hiddenState(kid, ctx) !== null) continue;
    children.push(idFor === undefined ? String(i) : idFor(kid));
  }
  props["children"] = children;
  return props;
}
