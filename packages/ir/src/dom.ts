/**
 * Stage 1 IR: DomTree (design.md §6).
 *
 * Output of the HTML parser. Immutable, branded `"DomTree"`. Downstream stages
 * may read it but can never mutate it (Requirement 3.1/3.2).
 */
import type { Branded, NodeId } from "./brand.js";

/** Kind discriminant for a DOM node. */
export type DomNodeKind = "element" | "text" | "comment" | "document";

/** A single DOM node. Fields are populated according to `kind`. */
export interface DomNode {
  readonly id: NodeId;
  readonly kind: DomNodeKind;
  /** element only, lowercased */
  readonly tag?: string;
  /** element only */
  readonly attrs?: ReadonlyMap<string, string>;
  /** text / comment only */
  readonly text?: string;
  readonly children: readonly NodeId[];
  readonly parent: NodeId | null;
}

/** The parsed document tree. Nominally branded so it cannot be confused with
 * any other stage's IR. */
export type DomTree = Branded<
  {
    readonly root: NodeId;
    readonly nodes: ReadonlyMap<NodeId, DomNode>;
  },
  "DomTree"
>;
