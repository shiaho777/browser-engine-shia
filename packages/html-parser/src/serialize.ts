/**
 * @browser-engine/html-parser — the HTML Pretty_Printer (task 5.2).
 *
 * Implements the DomTree → HTML half of the Pretty_Printer (Requirement 18.3)
 * and the shared structural-equality oracle that pins down what "an equivalent
 * DomTree" means for the round-trip guarantee (Requirement 18.4).
 *
 * ## Round-trip contract (Requirement 18.4 — documented per task 5.2)
 *
 * The serializer ({@link serializeDom}) and {@link parseHtml} form a round trip.
 * Like the CSS pretty printer (task 5.5/5.6), the contract is NOT raw-text
 * identity — `parseHtml` already *canonicalizes* its input: tags and attribute
 * names are lowercased, character references are decoded, the DOCTYPE is
 * dropped, adjacent character runs merge into one text node, and there is no
 * forced `html`/`head`/`body` wrapping. So the fixed point the engine
 * guarantees is the parse→print→parse identity:
 *
 *     parse(print(parse(x)))  ≡  parse(x)
 *
 * i.e. once a byte stream has been parsed into a DomTree, serializing it and
 * parsing again yields a *structurally equivalent* DomTree. {@link serializeDom}
 * prints in exactly the canonical shape `parseHtml` reads back unchanged:
 *
 *   - element  → `<tag attr="value" …>children</tag>`
 *   - void      → `<tag attr="value" …>` (no end tag, no children — HTML §13.1.2)
 *   - raw-text (`script`/`style`) → verbatim content between the tags (the
 *     parser keeps raw-text content un-decoded, so it must NOT be escaped)
 *   - escapable raw-text / RCDATA (`textarea`/`title`) → escaped content (the
 *     parser entity-decodes RCDATA content, so escaping round-trips through it)
 *   - text     → `&`, `<`, `>` entity-escaped so a literal re-parses faithfully
 *   - comment  → `<!--data-->`
 *
 * ### Faithfulness preconditions (documented limitations)
 *
 * A faithful round trip requires the serialized text to re-parse without
 * triggering error recovery. Two element-content shapes cannot be expressed in
 * HTML text and so are the serializer's documented preconditions (they never
 * arise from `parseHtml` output, which is the only producer of DomTrees in the
 * pipeline):
 *
 *   - raw-text content (`<script>`/`<style>`) must not contain that element's
 *     own end-tag opener (`</script` / `</style`), which would close it early;
 *   - comment data must not contain `-->`, which would close the comment early.
 *
 * `parseHtml` never produces either (it stops raw-text at the first `</name`
 * and a comment at the first `-->`), so the round trip is exact for every tree
 * the parser can emit.
 *
 * This module imports ONLY the frozen IR (`@browser-engine/ir`) — the single
 * sanctioned inter-stage channel (`local/no-cross-stage-import`).
 */
import type { DomNode, DomTree, NodeId } from "@browser-engine/ir";

// ---------------------------------------------------------------------------
// Element categories the serializer must treat specially. These mirror the
// (private) categories the tokenizer uses in index.ts; kept local so the
// serializer is self-contained and depends on no parser internals.
// ---------------------------------------------------------------------------

/** Void elements: serialized with no end tag and no children (HTML §13.1.2). */
const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

/** Raw-text elements: content is verbatim (NOT entity-decoded by the parser). */
const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set(["script", "style"]);

/**
 * How a text node's character data must be rendered, decided by its parent
 * element: `raw` (verbatim, for `script`/`style`) or `escaped` (entity-escaped,
 * for normal flow content AND for RCDATA, which the parser decodes back).
 */
type TextMode = "raw" | "escaped";

// ---------------------------------------------------------------------------
// Escaping. The parser's `decodeEntities` maps `&amp;`→`&`, `&lt;`→`<`,
// `&gt;`→`>`, `&quot;`→`"`, so escaping exactly those guarantees a faithful
// re-parse. `&` is replaced first so the escapes we introduce are not re-escaped.
// ---------------------------------------------------------------------------

/** Entity-escape character data so a literal value re-parses unchanged. */
function escapeText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Entity-escape an attribute value for inclusion in `"…"`. Only `&` and the
 * delimiting `"` need escaping; `<`/`>` are legal verbatim inside a quoted
 * attribute value and the parser reads the value up to the closing quote.
 */
function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/** Serialize an element's attributes as ` name="value"` pairs, in map order. */
function serializeAttrs(attrs: ReadonlyMap<string, string> | undefined): string {
  if (attrs === undefined || attrs.size === 0) return "";
  let out = "";
  for (const [name, value] of attrs) {
    out += ` ${name}="${escapeAttr(value)}"`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Serialization.
// ---------------------------------------------------------------------------

/** Serialize the ordered children of `node`, rendering text per `mode`. */
function serializeChildren(tree: DomTree, node: DomNode, mode: TextMode): string {
  let out = "";
  for (const childId of node.children) {
    const child = tree.nodes.get(childId);
    if (child === undefined) continue;
    out += serializeNode(tree, child, mode);
  }
  return out;
}

/**
 * Serialize a single node. `mode` is the text-rendering mode inherited from the
 * parent element (raw-text parents render their text verbatim; everything else
 * entity-escapes), and only affects `text` nodes.
 */
function serializeNode(tree: DomTree, node: DomNode, mode: TextMode): string {
  switch (node.kind) {
    case "text":
      return mode === "raw" ? (node.text ?? "") : escapeText(node.text ?? "");

    case "comment":
      return `<!--${node.text ?? ""}-->`;

    case "document":
      // A document has no markup of its own; emit its children in order.
      return serializeChildren(tree, node, "escaped");

    case "element": {
      const tag = node.tag ?? "";
      const open = `<${tag}${serializeAttrs(node.attrs)}>`;
      if (VOID_ELEMENTS.has(tag)) {
        // Void elements never have children or an end tag.
        return open;
      }
      const childMode: TextMode = RAW_TEXT_ELEMENTS.has(tag) ? "raw" : "escaped";
      return `${open}${serializeChildren(tree, node, childMode)}</${tag}>`;
    }

    default: {
      // Exhaustiveness guard: every DomNodeKind is handled above.
      const _exhaustive: never = node.kind;
      return _exhaustive;
    }
  }
}

/**
 * Serialize a {@link DomTree} back into HTML text (Requirement 18.3 — the
 * Pretty_Printer). The output re-parses via {@link parseHtml} to a DomTree
 * structurally equivalent to the input (Requirement 18.4); see the module
 * header for the round-trip contract and {@link domTreesEquivalent} for the
 * equality oracle.
 *
 * @param tree the DomTree to serialize (its `root` is a `document` node).
 * @returns HTML text; the empty string for an empty document.
 */
export function serializeDom(tree: DomTree): string {
  const root = tree.nodes.get(tree.root);
  if (root === undefined) return "";
  return serializeChildren(tree, root, "escaped");
}

// ---------------------------------------------------------------------------
// Structural-equality oracle (Requirement 18.4).
//
// The single shared definition of "equivalent DomTree" used by both this
// package and the HTML round-trip property test (task 5.2). Two trees are
// equivalent iff a parallel walk from each root visits structurally identical
// nodes: same kind; for elements the same tag and the same attribute map
// (key→value, ORDER-INDEPENDENT — attribute order is not semantically
// significant); for text/comment the same character data; and the same child
// count with pairwise-equivalent children in order. NodeId numbering is ignored
// entirely — ids are assigned by parse order, so they carry no structure.
// ---------------------------------------------------------------------------

/** Order-independent equality of two attribute maps (key→value). */
function attrsEqual(
  a: ReadonlyMap<string, string> | undefined,
  b: ReadonlyMap<string, string> | undefined,
): boolean {
  const sizeA = a?.size ?? 0;
  const sizeB = b?.size ?? 0;
  if (sizeA !== sizeB) return false;
  if (a === undefined || b === undefined) return sizeA === 0 && sizeB === 0;
  for (const [name, value] of a) {
    if (b.get(name) !== value) return false;
  }
  return true;
}

/** Structural equality of two nodes (ignoring their ids), then their subtrees. */
function nodesEquivalent(a: DomTree, b: DomTree, aId: NodeId, bId: NodeId): boolean {
  const na = a.nodes.get(aId);
  const nb = b.nodes.get(bId);
  if (na === undefined || nb === undefined) return na === nb;
  if (na.kind !== nb.kind) return false;

  if (na.kind === "element") {
    if ((na.tag ?? "") !== (nb.tag ?? "")) return false;
    if (!attrsEqual(na.attrs, nb.attrs)) return false;
  } else if (na.kind === "text" || na.kind === "comment") {
    if ((na.text ?? "") !== (nb.text ?? "")) return false;
  }

  if (na.children.length !== nb.children.length) return false;
  for (let i = 0; i < na.children.length; i += 1) {
    const ca = na.children[i];
    const cb = nb.children[i];
    if (ca === undefined || cb === undefined) return false;
    if (!nodesEquivalent(a, b, ca, cb)) return false;
  }
  return true;
}

/**
 * The "equivalent DomTree" oracle for Requirement 18.4: returns `true` iff `a`
 * and `b` are structurally equal (see the section comment above). This is the
 * contract the parse→print→parse round trip must satisfy, exported so the
 * property test in task 5.2 asserts the exact same definition.
 */
export function domTreesEquivalent(a: DomTree, b: DomTree): boolean {
  return nodesEquivalent(a, b, a.root, b.root);
}
