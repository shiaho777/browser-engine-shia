/**
 * a11y.ts — RFC 0037: the accessibility tree.
 *
 * Browsers ship a parallel object model to assistive technology: DOM+style+
 * layout → an AX tree of roles/names/states/geometry → a platform bridge
 * (AT-SPI/NSAccessibility/UIA). This module builds the tree honestly from the
 * same computed style + fragment geometry paint uses:
 *
 *  - **Roles**: implicit HTML→ARIA mappings (a[href]→link, h1–h6→heading+level,
 *    nav→navigation, input[type]→checkbox/textbox/…, table family, landmark
 *    elements) with `role=` override honored.
 *  - **Names**: the accName order — `aria-labelledby` (IDREF → labelled text) →
 *    `aria-label` → element semantics (`alt`, `<label for>`/wrapping, `value`
 *    on button inputs) → text subtree.
 *  - **States**: focused/checked/selected/disabled/required/readonly/expanded/
 *    pressed/invalid/busy/level/multiline…, plus `value` for range/text-like
 *    controls.
 *  - **Pruning**: `display:none`/`visibility:hidden|collapse`/`hidden`/
 *    `aria-hidden="true"` and non-rendered subtrees (head/script/style/…)
 *    never enter the tree; whitespace-only text nodes are dropped.
 *  - **Geometry**: each AX node carries its border-box rect in absolute
 *    page coordinates — the same walk paint uses for images.
 *  - **Text**: rendered text nodes appear as `StaticText` children so the
 *    reading order of the tree mirrors the reading order of the page.
 *
 * Platform bridges (AT-SPI over D-Bus, NSAccessibility, UIA) require native
 * IPC — a documented boundary. What ships here is the real tree plus a
 * serializable snapshot + an `AXBridge` seam; {@link jsonAxBridge} is the
 * reference consumer (tree diffs/dumps for automation + tests).
 */
import type { DomNode, DomTree, FragmentId, FragmentTree, NodeId } from "@browser-engine/ir";

import type { EditFocus } from "./focus-overlay.js";

type StyleOf = (id: NodeId) => Record<string, unknown>;

// ---------------------------------------------------------------------------
// AX node model
// ---------------------------------------------------------------------------

export interface AXGeometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface AXNode {
  /** Stable id within this snapshot (post-order serial). */
  readonly id: number;
  /** DOM node this AX node was built from (`null` for synthetic roots). */
  readonly nodeId: NodeId | null;
  readonly role: string;
  readonly name: string;
  readonly description: string;
  readonly value: string | null;
  readonly states: readonly string[];
  readonly geometry: AXGeometry | null;
  readonly children: readonly AXNode[];
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/** Valid ARIA tokens for `role=` — unknown tokens fall through to implicit. */
const ARIA_ROLES = new Set([
  "alert", "alertdialog", "application", "article", "banner", "button",
  "cell", "checkbox", "columnheader", "combobox", "complementary",
  "contentinfo", "definition", "dialog", "directory", "document", "feed",
  "figure", "form", "grid", "gridcell", "group", "heading", "img", "link",
  "list", "listbox", "listitem", "log", "main", "marquee", "math", "menu",
  "menubar", "menuitem", "menuitemcheckbox", "menuitemradio", "navigation",
  "none", "note", "option", "presentation", "progressbar", "radio",
  "radiogroup", "region", "row", "rowgroup", "rowheader", "scrollbar",
  "search", "searchbox", "separator", "slider", "spinbutton", "status",
  "switch", "tab", "table", "tablist", "tabpanel", "term", "textbox",
  "timer", "toolbar", "tooltip", "tree", "treegrid", "treeitem",
]);

const INPUT_ROLES: Record<string, string> = {
  button: "button", checkbox: "checkbox", image: "button", radio: "radio",
  range: "slider", reset: "button", submit: "button",
  email: "textbox", number: "spinbutton", password: "textbox",
  search: "searchbox", tel: "textbox", text: "textbox", url: "textbox",
};

const TAG_ROLES: Record<string, string> = {
  article: "article", aside: "complementary", blockquote: "blockquote",
  button: "button", dd: "definition", details: "group", dialog: "dialog",
  dl: "list", dt: "term", fieldset: "group", figcaption: "caption",
  figure: "figure", footer: "contentinfo", form: "form", header: "banner",
  hr: "separator", img: "img", li: "listitem", main: "main", math: "math",
  meter: "meter", nav: "navigation", ol: "list", optgroup: "group",
  option: "option", output: "status", pre: "generic", progress: "progressbar",
  p: "paragraph", section: "generic", select: "listbox", summary: "button", table: "table",
  tbody: "rowgroup", td: "cell", textarea: "textbox", tfoot: "rowgroup",
  th: "columnheader", thead: "rowgroup", tr: "row", ul: "list",
};

/** Elements that never produce AX nodes (non-rendered machinery). */
const PRUNE_TAGS = new Set([
  "area", "base", "br", "col", "colgroup", "datalist", "embed", "head",
  "link", "map", "meta", "noscript", "param", "picture", "script",
  "slot", "source", "style", "template", "title", "track", "wbr",
]);

/** `role="none"/"presentation"` strips semantics but keeps descendants. */
const SEMANTIC_ERASERS = new Set(["none", "presentation"]);

function implicitRole(node: DomNode, dom: DomTree): string | null {
  const tag = node.tag ?? "";
  const attrs = node.attrs;
  switch (tag) {
    case "a":
    case "area":
      return attrs?.get("href") !== undefined ? "link" : "generic";
    case "input": {
      const t = (attrs?.get("type") ?? "text").toLowerCase();
      return INPUT_ROLES[t] ?? "textbox";
    }
    case "img":
      // Per ARIA-in-HTML: empty alt is presentation; absent/any alt is img.
      return attrs?.get("alt") === "" ? "none" : "img";
    case "select":
      return (Number(attrs?.get("size") ?? "1") > 1 || attrs?.has("multiple")) ? "listbox" : "combobox";
    case "header":
      // banner only at top level — inside article/section/etc it's generic.
      return isTopLevelBanner(node, dom) ? "banner" : "generic";
    case "footer":
      return isTopLevelBanner(node, dom) ? "contentinfo" : "generic";
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return "heading";
    default:
      return TAG_ROLES[tag] ?? null;
  }
}

function isTopLevelBanner(node: DomNode, dom: DomTree): boolean {
  let p = node.parent;
  while (p !== null && p !== undefined) {
    const n = dom.nodes.get(p);
    if (n === undefined) break;
    if (["article", "aside", "main", "nav", "section"].includes(n.tag ?? "")) return false;
    p = n.parent;
  }
  return true;
}

function roleOf(node: DomNode, dom: DomTree): string | null {
  const explicit = (node.attrs?.get("role") ?? "").trim().toLowerCase().split(/\s+/u)[0] ?? "";
  if (explicit !== "" && ARIA_ROLES.has(explicit)) return explicit;
  return implicitRole(node, dom);
}

// ---------------------------------------------------------------------------
// Name computation (accName-lite: IDREFs → aria-label → element → subtree)
// ---------------------------------------------------------------------------

/** ARIA "name from content" roles — only these take subtree text as name. */
const NAME_FROM_CONTENT = new Set([
  "button", "caption", "cell", "checkbox", "columnheader", "definition",
  "gridcell", "heading", "link", "listitem", "menuitem", "menuitemcheckbox",
  "menuitemradio", "option", "paragraph", "radio", "rowheader", "switch",
  "tab", "term", "tooltip", "treeitem",
]);

function elementText(dom: DomTree, id: NodeId, styleOf: StyleOf | null): string {
  const out: string[] = [];
  const visit = (nid: NodeId): void => {
    const n = dom.nodes.get(nid);
    if (n === undefined) return;
    if (n.kind === "text") {
      out.push(n.text ?? "");
      return;
    }
    if (n.kind !== "element") return;
    if (!isRendered(n, styleOf)) return;
    for (const c of n.children) visit(c);
  };
  visit(id);
  return out.join("").replace(/\s+/gu, " ").trim();
}

function labelledByText(dom: DomTree, ids: string, styleOf: StyleOf | null): string {
  const parts: string[] = [];
  for (const ref of ids.trim().split(/\s+/u)) {
    const target = findById(dom, ref);
    if (target !== undefined) parts.push(elementText(dom, target, styleOf));
  }
  return parts.join(" ").trim();
}

function findById(dom: DomTree, wanted: string): NodeId | undefined {
  for (const [id, n] of dom.nodes) {
    if (n.kind === "element" && n.attrs?.get("id") === wanted) return id;
  }
  return undefined;
}

/** `<label for=id>` or an ancestor-wrapping label → its text. */
function labelTextFor(dom: DomTree, node: DomNode, id: NodeId, styleOf: StyleOf | null): string | null {
  const myId = node.attrs?.get("id");
  if (myId !== undefined) {
    for (const [lid, n] of dom.nodes) {
      if (n.kind === "element" && n.tag === "label" && n.attrs?.get("for") === myId) {
        return elementText(dom, lid, styleOf);
      }
    }
  }
  let p = node.parent;
  while (p !== null && p !== undefined) {
    const n = dom.nodes.get(p);
    if (n === undefined || n.kind !== "element") break;
    if (n.tag === "label") {
      const t = elementText(dom, p, styleOf);
      return t === "" ? null : t;
    }
    p = n.parent;
    void id;
  }
  return null;
}

function accessibleName(dom: DomTree, node: DomNode, id: NodeId, role: string | null, styleOf: StyleOf | null): string {
  const attrs = node.attrs;
  const by = attrs?.get("aria-labelledby");
  if (by !== undefined && by.trim() !== "") {
    const t = labelledByText(dom, by, styleOf);
    if (t !== "") return t;
  }
  const label = attrs?.get("aria-label");
  if (label !== undefined && label.trim() !== "") return label.trim();
  switch (node.tag) {
    case "img":
      return (attrs?.get("alt") ?? attrs?.get("title") ?? "").trim();
    case "input": {
      const type = (attrs?.get("type") ?? "text").toLowerCase();
      if (type === "submit" || type === "reset" || type === "button" || type === "image") {
        const v = (attrs?.get("value") ?? "").trim();
        if (v !== "") return v;
        return type === "submit" ? "Submit" : type === "reset" ? "Reset" : "";
      }
      return labelTextFor(dom, node, id, styleOf) ?? (attrs?.get("placeholder") ?? "").trim();
    }
    case "textarea":
      return labelTextFor(dom, node, id, styleOf) ?? (attrs?.get("placeholder") ?? "").trim();
    case "select":
      return labelTextFor(dom, node, id, styleOf) ?? "";
    case "fieldset": {
      // name = first <legend> child text.
      for (const c of node.children) {
        const cn = dom.nodes.get(c);
        if (cn?.kind === "element" && cn.tag === "legend") return elementText(dom, c, styleOf);
      }
      return elementText(dom, id, styleOf);
    }
    case "iframe":
      return (attrs?.get("title") ?? "").trim();
    default:
      break;
  }
  // Only name-from-content roles take subtree text (links, headings,
  // buttons, listitems, cells…); landmarks/forms/regions stay unnamed unless
  // explicitly labelled.
  if (role !== null && NAME_FROM_CONTENT.has(role)) {
    return elementText(dom, id, styleOf);
  }
  return "";
}

// ---------------------------------------------------------------------------
// States & value
// ---------------------------------------------------------------------------

function truthy(v: string | undefined): boolean {
  return v !== undefined && v !== "false";
}

function statesOf(dom: DomTree, node: DomNode, id: NodeId, role: string | null, focus: EditFocus | null): string[] {
  const attrs = node.attrs;
  const out: string[] = [];
  const aria = (k: string): string | undefined => attrs?.get(`aria-${k}`);
  const t = node.tag;
  void dom;
  if (focus !== null && focus.nodeId === id) out.push("focused");
  if (attrs?.has("disabled") || truthy(aria("disabled"))) out.push("disabled");
  if (t === "input" && ["checkbox", "radio"].includes((attrs?.get("type") ?? "").toLowerCase())) {
    out.push(attrs?.has("checked") || aria("checked") === "true" ? "checked" : "unchecked");
  } else if (aria("checked") !== undefined) {
    out.push(aria("checked") === "true" ? "checked" : "unchecked");
  }
  if (aria("expanded") !== undefined) out.push(aria("expanded") === "true" ? "expanded" : "collapsed");
  if (aria("pressed") !== undefined) out.push(aria("pressed") === "true" ? "pressed" : "not pressed");
  if (aria("selected") !== undefined) out.push(aria("selected") === "true" ? "selected" : "not selected");
  if (t === "option" && attrs?.has("selected")) out.push("selected");
  if (attrs?.has("required") || truthy(aria("required"))) out.push("required");
  if (attrs?.has("readonly") || truthy(aria("readonly"))) out.push("readonly");
  if (aria("invalid") !== undefined && aria("invalid") !== "false") out.push("invalid");
  if (truthy(aria("busy"))) out.push("busy");
  if (truthy(aria("modal"))) out.push("modal");
  if (aria("multiline") === "true" || t === "textarea") out.push("multiline");
  if (attrs?.has("multiple") || aria("multiselectable") === "true") out.push("multiselectable");
  if (aria("live") !== undefined && aria("live") !== "off") out.push(`live:${aria("live")}`);
  if (aria("haspopup") !== undefined && aria("haspopup") !== "false") out.push("haspopup");
  if (role === "heading") {
    const lvl = (node.tag ?? "").match(/^h([1-6])$/u)?.[1] ?? aria("level") ?? "2";
    out.push(`level:${lvl}`);
  } else if (aria("level") !== undefined) {
    out.push(`level:${aria("level")}`);
  }
  if (aria("current") !== undefined && aria("current") !== "false") out.push("current");
  if (t === "details") out.push(attrs?.has("open") ? "expanded" : "collapsed");
  if (t === "a" && attrs?.has("href")) out.push("linked");
  if (t === "select") out.push("focusable");
  if (t === "input" || t === "textarea" || t === "button") out.push("focusable");
  return [...new Set(out)];
}


function valueOf(node: DomNode, role: string | null): string | null {
  const attrs = node.attrs;
  if (attrs?.has("aria-valuetext")) return attrs.get("aria-valuetext") ?? null;
  if (attrs?.has("aria-valuenow")) return attrs.get("aria-valuenow") ?? null;
  if (node.tag === "input") {
    const t = (attrs?.get("type") ?? "text").toLowerCase();
    if (["checkbox", "radio", "submit", "reset", "button", "image"].includes(t)) return null;
    return attrs?.get("value") ?? "";
  }
  if (node.tag === "textarea") return null; // live value is script-side; boundary.
  if (node.tag === "progress" || node.tag === "meter") return attrs?.get("value") ?? null;
  if (role === "slider" || role === "spinbutton") return attrs?.get("value") ?? null;
  return null;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

function absPositions(tree: FragmentTree): Map<FragmentId, { x: number; y: number }> {
  const out = new Map<FragmentId, { x: number; y: number }>();
  const walk = (id: FragmentId, ox: number, oy: number): void => {
    const frag = tree.fragments.get(id);
    if (frag === undefined) return;
    const x = ox + Number(frag.box.borderBox.x);
    const y = oy + Number(frag.box.borderBox.y);
    out.set(id, { x, y });
    const childOx = ox + Number(frag.box.marginBox.x);
    const childOy = oy + Number(frag.box.marginBox.y);
    for (const c of frag.children) walk(c, childOx, childOy);
  };
  walk(tree.root, 0, 0);
  return out;
}

function geometryOf(
  nodeId: NodeId,
  tree: FragmentTree,
  abs: Map<FragmentId, { x: number; y: number }>,
): AXGeometry | null {
  // First fragment for this node wins (multi-fragment inline splits take the
  // union of their fragments — keep it simple: union all matching fragments).
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [fid, frag] of tree.fragments) {
    if (frag.node !== nodeId) continue;
    const p = abs.get(fid);
    if (p === undefined) continue;
    const w = Number(frag.box.borderBox.width);
    const h = Number(frag.box.borderBox.height);
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x + w);
    y1 = Math.max(y1, p.y + h);
  }
  if (!Number.isFinite(x0)) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

// ---------------------------------------------------------------------------
// Tree construction
// ---------------------------------------------------------------------------

export interface AxTreeOptions {
  readonly focus?: EditFocus | null;
}

/** Whether a node renders (has fragments or is a text in a rendered line). */
function isRendered(node: DomNode, styleOf: StyleOf | null): boolean {
  if (node.kind !== "element") return true;
  if (node.attrs?.has("hidden")) return false;
  if (node.attrs?.get("aria-hidden") === "true") return false;
  if (PRUNE_TAGS.has(node.tag ?? "")) return false;
  if (styleOf !== null) {
    const st = styleOf(node.id);
    const disp = typeof st["display"] === "string" ? st["display"] : "";
    if (disp === "none") return false;
    const vis = typeof st["visibility"] === "string" ? st["visibility"] : "";
    if (vis === "hidden" || vis === "collapse") return false;
  }
  return true;
}

let axSerial = 0;

/**
 * Build the AX tree for a rendered document. `styleOf` may be null — in that
 * case visibility pruning falls back to attrs/fragments only.
 */
export function buildAxTree(
  dom: DomTree,
  styleOf: StyleOf | null,
  fragmentTree: FragmentTree,
  options: AxTreeOptions = {},
): AXNode | null {
  const abs = absPositions(fragmentTree);
  const focus = options.focus ?? null;
  axSerial = 0;

  const build = (id: NodeId): AXNode | null => {
    const node = dom.nodes.get(id);
    if (node === undefined) return null;
    if (node.kind === "text") {
      const t = (node.text ?? "").trim();
      if (t === "") return null;
      return {
        id: axSerial++, nodeId: id, role: "StaticText", name: t,
        description: "", value: null, states: [],
        geometry: null, children: [],
      };
    }
    if (node.kind === "document") {
      // The document root anchors the tree: role=document, name=<title>.
      const kids: AXNode[] = [];
      for (const c of node.children) {
        const k = build(c);
        if (k !== null) kids.push(k);
      }
      return {
        id: axSerial++, nodeId: id, role: "document", name: documentName(dom),
        description: "", value: null, states: [],
        geometry: null, children: kids,
      };
    }
    if (node.kind !== "element") return null;
    if (!isRendered(node, styleOf)) return null;

    const role = roleOf(node, dom);
    const kids: AXNode[] = [];
    for (const c of node.children) {
      const k = build(c);
      if (k !== null) kids.push(k);
    }

    // `role="none"/"presentation"` and unroled containers still appear as
    // `generic` (Chrome's genericContainer) — children are never promoted out
    // of order. The <html> root anchors the tree as `document` + page title.
    const isRoot = false;
    const effRole = isRoot ? "document" : (role === null || SEMANTIC_ERASERS.has(role) ? "generic" : role);
    const self: AXNode = {
      id: axSerial++, nodeId: id,
      role: effRole,
      name: isRoot ? documentName(dom) : accessibleName(dom, node, id, role, styleOf),
      description: (node.attrs?.get("aria-description") ?? node.attrs?.get("title") ?? "").trim(),
      value: valueOf(node, role),
      states: isRoot ? [] : statesOf(dom, node, id, effRole, focus),
      geometry: geometryOf(id, fragmentTree, abs),
      children: kids,
    };
    return self;
  };

  const root = build(dom.root);
  return root;
}

function documentName(dom: DomTree): string {
  for (const [, n] of dom.nodes) {
    if (n.kind === "element" && n.tag === "title") {
      for (const c of n.children) {
        const t = dom.nodes.get(c);
        if (t?.kind === "text") return (t.text ?? "").trim();
      }
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Bridge seam + serializable snapshot
// ---------------------------------------------------------------------------

/** Platform-AT bridge seam: the tree is pushed to whatever consumes it. */
export interface AXBridge {
  attach(root: AXNode | null): void;
  detach(): void;
}

/** Serialize an AX tree into a plain JSON-able structure (automation shape). */
export function axSnapshot(root: AXNode | null): unknown {
  if (root === null) return null;
  return {
    role: root.role,
    name: root.name,
    ...(root.description !== "" ? { description: root.description } : {}),
    ...(root.value !== null ? { value: root.value } : {}),
    ...(root.states.length > 0 ? { states: [...root.states] } : {}),
    ...(root.geometry !== null ? { geometry: root.geometry } : {}),
    children: root.children.map(axSnapshot),
  };
}

/** `chrome --dump-accessibility-tree`-style text dump — human/testing form. */
export function axDump(root: AXNode | null, indent = 0): string {
  if (root === null) return "";
  const pad = "  ".repeat(indent);
  const geo = root.geometry !== null
    ? ` (${root.geometry.x},${root.geometry.y} ${root.geometry.width}×${root.geometry.height})`
    : "";
  const name = root.name !== "" ? ` name="${root.name}"` : "";
  const val = root.value !== null ? ` value="${root.value}"` : "";
  const st = root.states.length > 0 ? ` [${root.states.join(",")}]` : "";
  const lines = [`${pad}${root.role}${name}${val}${st}${geo}`];
  for (const c of root.children) lines.push(axDump(c, indent + 1));
  return lines.filter((l) => l !== "").join("\n");
}

/** Reference consumer: keeps the latest snapshot + history of attaches. */
export function jsonAxBridge(): AXBridge & { readonly current: unknown } {
  let cur: unknown = null;
  return {
    attach(root) {
      cur = axSnapshot(root);
    },
    detach() {
      cur = null;
    },
    get current() {
      return cur;
    },
  };
}
