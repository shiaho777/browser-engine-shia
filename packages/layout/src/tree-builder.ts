/**
 * tree-builder.ts — the layout tree builder (B1; css2.1 §9.2.1.1 anonymous
 * blocks + css-tables-3 fixup).
 *
 * Between the DOM and layout, this pass normalizes each container's children
 * into a layout-ready sequence:
 *
 *   - **Block containers**: consecutive inline-level children (text nodes,
 *     `display:inline`/`inline-block` elements) are grouped into pre-collected
 *     `inline-run` entries — the semantic equivalent of CSS's anonymous block
 *     boxes. A run consisting ENTIRELY of collapsible whitespace is dropped
 *     (css2.1: it generates no anonymous block and no line boxes).
 *   - **Table containers** (`display:table`): the raw children are normalized
 *     into a rows/cells structure — row groups expand transparently, non-row
 *     content wraps into an anonymous row, non-cell content inside a row wraps
 *     into an anonymous cell. Bare text in tables is therefore NEVER dropped
 *     (the pre-B1 `layoutTable` silently discarded it).
 *   - **Naked table parts** (a `display:table-cell`/`table-row` element under a
 *     non-table parent): consecutive sequences wrap into an anonymous table.
 *
 * Reference: Ladybird `Rust/src/layout/tree_builder.rs` (`insertion_parent_for_
 * inline_node`, `fixup_tables`) — same invariants, expressed as one pure pass
 * over the immutable DOM instead of a mutable arena.
 *
 * Anonymous boxes are TRANSPARENT downstream: they produce no fragments and
 * carry no NodeId. Their laid-out content attaches to the nearest real
 * ancestor fragment (see index.ts), so the FragmentTree's consumers
 * (gBCR, hit-testing, paint) are unaffected.
 */
import type { ComputedStyle, DomNode, DomTree, NodeId } from "@browser-engine/ir";

import {
  isInlineLevelChild,
  isTableCell,
  isTableRow,
  isTableRowGroup,
  isTableRoot,
} from "./display-classification.js";

/**
 * The Shadow DOM composition view (D6, DOM Standard §2.2.3): which children a
 * node renders in the FLAT TREE. `hosts` maps a shadow host to its shadow
 * tree's children; `slots` maps a `<slot>` element to its assigned light-DOM
 * children (empty array = render the slot's fallback content). Nodes absent
 * from both render their regular children.
 */
export interface ShadowComposition {
  readonly hosts: ReadonlyMap<NodeId, readonly NodeId[]>;
  readonly slots: ReadonlyMap<NodeId, readonly NodeId[]>;
}

/** One child entry of a block container after fixup. */
export type LayoutChild =
  /** A DOM-backed box the layout dispatcher handles (block/flex/grid/table/float/abs…). */
  | { readonly kind: "box"; readonly node: NodeId }
  /** A pre-collected run of consecutive inline-level children (anonymous block). */
  | { readonly kind: "inline-run"; readonly nodes: readonly NodeId[] }
  /** An anonymous table wrapping a naked row/cell sequence in a block container. */
  | { readonly kind: "table"; readonly rows: readonly TableRow[] };

/** One row of a table structure: a real `tr` element or an anonymous wrapper. */
export interface TableRow {
  /** The `tr` element's node id, or null for an anonymous row. */
  readonly rowId: NodeId | null;
  readonly cells: readonly TableCell[];
}

/** One cell: a real `td`/`th` element or an anonymous wrapper. */
export interface TableCell {
  /** The cell element's node id, or null for an anonymous cell. */
  readonly cellId: NodeId | null;
  /** Only for anonymous cells: the fixed-up content of the cell. */
  readonly children?: readonly LayoutChild[];
}

/** The layout tree: per-container fixed-up children + table structures. */
export interface LayoutTree {
  /** Block containers (and the document): the post-fixup child sequences. */
  readonly childrenOf: ReadonlyMap<NodeId, readonly LayoutChild[]>;
  /** `display:table` elements: their normalized row structure. */
  readonly tableStructureOf: ReadonlyMap<NodeId, readonly TableRow[]>;
}

/** The style lookup for elements (text/comments have none). */
type StyleOf = (id: NodeId) => ComputedStyle;

/**
 * Build the layout tree for a whole document. Pure: same DOM + styles ⇒ same
 * tree, node for node (the map iteration order is the DOM insertion order).
 */
export function buildLayoutTree(
  dom: DomTree,
  styleOf: StyleOf,
  composition?: ShadowComposition,
): LayoutTree {
  const childrenOf = new Map<NodeId, LayoutChild[]>();
  const tableStructureOf = new Map<NodeId, TableRow[]>();

  /**
   * D6 — the COMPOSED children of a node (the flat tree, DOM Standard
   * §2.2.3): a `<slot>` renders its ASSIGNED light-DOM children (or its own
   * fallback content when nothing is assigned); a SHADOW HOST renders its
   * shadow tree's children instead of its light children. Everything else
   * renders its regular children.
   */
  const composedChildrenOf = (id: NodeId): readonly NodeId[] => {
    if (composition !== undefined) {
      const slotAssigned = composition.slots.get(id);
      if (slotAssigned !== undefined) {
        // A slot: assigned nodes, or fallback content when unassigned.
        if (slotAssigned.length > 0) return slotAssigned;
        return dom.nodes.get(id)?.children ?? [];
      }
      const shadowChildren = composition.hosts.get(id);
      if (shadowChildren !== undefined) {
        return shadowChildren;
      }
    }
    return dom.nodes.get(id)?.children ?? [];
  };

  /** The style of a child element, or null for non-elements. */
  const styleOfChild = (id: NodeId): ComputedStyle | null => {
    const node = dom.nodes.get(id);
    if (node === undefined || node.kind !== "element") {
      return null;
    }
    return styleOf(id);
  };

  const visit = (id: NodeId): void => {
    const node = dom.nodes.get(id);
    if (node === undefined) return;
    if (node.kind === "element") {
      const style = styleOf(id);
      if (style["display"] === "none") return; // display:none subtrees never reach layout.
      if (isTableRoot(node, style)) {
        tableStructureOf.set(id, fixupTableChildren(composedChildrenOf(id), styleOfChild, dom, composedChildrenOf));
      } else {
        childrenOf.set(id, fixupBlockChildren(composedChildrenOf(id), styleOfChild, dom, composedChildrenOf));
      }
      for (const child of composedChildrenOf(id)) visit(child);
      return;
    }
    if (node.kind === "document") {
      childrenOf.set(id, fixupBlockChildren(composedChildrenOf(id), styleOfChild, dom, composedChildrenOf));
      for (const child of composedChildrenOf(id)) visit(child);
    }
    // Text/comment nodes have no children to fix up.
  };

  visit(dom.root);
  return { childrenOf, tableStructureOf };
}

/**
 * Whether a text node's content is entirely whitespace (collapsible).
 * css2.1 §9.2.1.1: a run consisting solely of whitespace generates no
 * anonymous block — it is removed from the layout tree entirely.
 */
function isWhitespaceOnly(node: DomNode): boolean {
  return node.kind === "text" && (node.text ?? "").trim().length === 0;
}

/**
 * Fix up one block container's children:
 *   - consecutive inline-level children → one `inline-run` (dropped when the
 *     run is entirely whitespace-only text),
 *   - other children → `box` entries (floats/positioned/block stay as-is),
 *   - a consecutive run of naked table rows/cells → one anonymous `table`.
 */
function fixupBlockChildren(
  childIds: readonly NodeId[],
  styleOfChild: (id: NodeId) => ComputedStyle | null,
  dom: DomTree,
  composedChildrenOf: (id: NodeId) => readonly NodeId[] = (id) => dom.nodes.get(id)?.children ?? [],
): LayoutChild[] {
  const out: LayoutChild[] = [];
  let run: NodeId[] = [];
  let runHasContent = false;

  const flushRun = (): void => {
    if (run.length === 0) return;
    // css2.1 §9.2.1.1: collapsible whitespace between block-level boxes
    // generates no anonymous block — drop the run entirely.
    if (runHasContent) {
      out.push({ kind: "inline-run", nodes: run });
    }
    run = [];
    runHasContent = false;
  };

  let nakedIds: NodeId[] = [];
  const flushNaked = (): void => {
    if (nakedIds.length === 0) return;
    out.push({
      kind: "table",
      rows: fixupTableChildren(nakedIds, styleOfChild, dom, composedChildrenOf),
    });
    nakedIds = [];
  };

  for (const childId of childIds) {
    const node = dom.nodes.get(childId);
    if (node === undefined || node.kind === "comment") {
      continue;
    }
    const style = styleOfChild(childId);
    if (node.kind === "element" && style !== null && style["display"] === "none") {
      continue; // display:none children never reach layout.
    }
    // Naked table parts (a table-row/cell under a non-table parent) wrap into
    // an anonymous table (css-tables-3 generate_missing_parents).
    if (isTableRow(node, style) || isTableRowGroup(node, style) || isTableCell(node, style)) {
      flushRun();
      nakedIds.push(childId);
      continue;
    }
    flushNaked();
    if (isInlineLevelChild(node, style)) {
      run.push(childId);
      if (!(node.kind === "text" && isWhitespaceOnly(node))) {
        runHasContent = true;
      }
      continue;
    }
    flushRun();
    out.push({ kind: "box", node: childId });
  }
  flushRun();
  flushNaked();
  return out;
}

/**
 * Fix up the children of a table container (css-tables-3 fixup, mirroring
 * Ladybird's `fixup_tables`):
 *   - row groups (thead/tbody/tfoot) expand transparently into their rows;
 *   - a real row element (`display:table-row`) keeps its identity;
 *   - any other content (text, inline elements, block boxes) wraps, per
 *     consecutive sequence, into an anonymous row whose cells follow the same
 *     rule (css-tables-3 generate_missing_child_wrappers).
 */
function fixupTableChildren(
  childIds: readonly NodeId[],
  styleOfChild: (id: NodeId) => ComputedStyle | null,
  dom: DomTree,
  composedChildrenOf: (id: NodeId) => readonly NodeId[] = (id) => dom.nodes.get(id)?.children ?? [],
): TableRow[] {
  const rows: TableRow[] = [];
  let pending: NodeId[] = [];
  const flushPending = (): void => {
    if (pending.length === 0) return;
    // css-tables-3: a CONSECUTIVE sequence of non-row children wraps into ONE
    // anonymous row (cells inside it follow the same consecutive-sequence rule
    // via fixupRowCells — naked cell elements keep their identity, other
    // content wraps into anonymous cells).
    rows.push({ rowId: null, cells: fixupRowCells(pending, styleOfChild, dom, composedChildrenOf) });
    pending = [];
  };

  for (const childId of childIds) {
    const node = dom.nodes.get(childId);
    if (node === undefined || node.kind === "comment") {
      continue;
    }
    const style = styleOfChild(childId);
    if (node.kind === "element" && style !== null && style["display"] === "none") {
      continue;
    }
    // Whitespace-only text inside a table container is removed entirely
    // (css-tables-3 remove_irrelevant_boxes).
    if (node.kind === "text" && isWhitespaceOnly(node)) {
      continue;
    }
    if (isTableRowGroup(node, style)) {
      flushPending();
      // A row group expands transparently: its row children surface as rows;
      // any other consecutive content inside wraps into an anonymous row.
      let groupPending: NodeId[] = [];
      const flushGroup = (): void => {
        if (groupPending.length === 0) return;
        rows.push({ rowId: null, cells: fixupRowCells(groupPending, styleOfChild, dom, composedChildrenOf) });
        groupPending = [];
      };
      for (const rowId of composedChildrenOf(node.id)) {
        const rowNode = dom.nodes.get(rowId);
        if (rowNode === undefined || rowNode.kind === "comment") {
          continue;
        }
        const rowStyle = styleOfChild(rowId);
        if (rowNode.kind === "element" && rowStyle !== null && rowStyle["display"] === "none") {
          continue;
        }
        if (rowNode.kind === "text" && isWhitespaceOnly(rowNode)) {
          continue;
        }
        if (isTableRow(rowNode, rowStyle)) {
          flushGroup();
          rows.push({ rowId, cells: fixupRowCells(composedChildrenOf(rowId), styleOfChild, dom) });
        } else {
          groupPending.push(rowId);
        }
      }
      flushGroup();
      continue;
    }
    if (isTableRow(node, style)) {
      flushPending();
      rows.push({ rowId: childId, cells: fixupRowCells(node.children, styleOfChild, dom) });
      continue;
    }
    pending.push(childId);
  }
  flushPending();
  return rows;
}

/**
 * Fix up one row's children into cells (css-tables-3 generate_missing_child_
 * wrappers): real cell elements keep their identity; any other content (text,
 * inline elements) wraps, per consecutive sequence, into an anonymous cell
 * whose children get the standard block fixup.
 */
function fixupRowCells(
  childIds: readonly NodeId[],
  styleOfChild: (id: NodeId) => ComputedStyle | null,
  dom: DomTree,
  composedChildrenOf: (id: NodeId) => readonly NodeId[] = (id) => dom.nodes.get(id)?.children ?? [],
): TableCell[] {
  const cells: TableCell[] = [];
  let pending: NodeId[] = [];

  const flushPending = (): void => {
    if (pending.length === 0) return;
    cells.push({
      cellId: null,
      children: fixupBlockChildren(pending, styleOfChild, dom, composedChildrenOf),
    });
    pending = [];
  };

  for (const childId of childIds) {
    const node = dom.nodes.get(childId);
    if (node === undefined || node.kind === "comment") {
      continue;
    }
    const style = styleOfChild(childId);
    if (node.kind === "element" && style !== null && style["display"] === "none") {
      continue;
    }
    // Whitespace-only text inside a row is removed (irrelevant-box removal).
    if (node.kind === "text" && isWhitespaceOnly(node)) {
      continue;
    }
    if (isTableCell(node, style)) {
      flushPending();
      cells.push({ cellId: childId });
      continue;
    }
    pending.push(childId);
  }
  flushPending();
  return cells;
}
