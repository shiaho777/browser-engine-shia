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
  /** element only — the host's shadow root id (HTML §4.13.6). The shadow root
   * is a SIDE-ATTACHED node (never listed in `children`), modeled as an
   * element with tag `"#shadow-root"` whose `parent` is the host, so ancestor
   * walks and style inheritance cross the boundary naturally. */
  readonly shadow?: NodeId;
}

/** The parsed document tree. Nominally branded so it cannot be confused with
 * any other stage's IR. */
export type DomTree = Branded<
  {
    readonly root: NodeId;
    readonly nodes: ReadonlyMap<NodeId, DomNode>;
    /** Custom-element local names defined in this document (HTML §4.13;
     * feeds the `:defined` pseudo-class). Undefined ⇒ registry absent. */
    readonly defined?: ReadonlySet<string>;
    /** Live UI interaction state (UI Events §focus, CSS Selectors §13):
     * feeds `:focus`, `:focus-within`, `:focus-visible`, `:active`,
     * `:hover`. Undefined ⇒ no UI state tracked. */
    readonly uiState?: {
      /** The document's focused element (`:focus`). */
      readonly focus?: NodeId;
      /** `:focus-visible` applies to the focused element. */
      readonly focusVisible?: boolean;
      /** Element currently being pressed (`:active`). */
      readonly active?: NodeId;
      /** Element under the pointer (`:hover` — ancestors match too). */
      readonly hover?: NodeId;
    };
    /** Live form-control state (HTML §4.10): per-control values that script
     * or user interaction changed WITHOUT touching attributes — feeds
     * `:checked`, `:indeterminate`, `:placeholder-shown`, `:valid`,
     * `:invalid`, `:in-range`, `:out-of-range`, `:user-valid`,
     * `:user-invalid`. Undefined ⇒ no control state tracked (attrs govern). */
    readonly control?: ReadonlyMap<NodeId, DomControlState>;
  },
  "DomTree"
>;

/** The non-attribute live state of one form control. Every field is
 * optional; an absent field falls back to the markup attribute. */
export interface DomControlState {
  /** `input.checked` / `option.selected` live state (`:checked`). */
  readonly checked?: boolean;
  /** `option.selected` live state (kept separate so an option's `:checked`
   * reflects selectedness while a checkbox's reflects checkedness). */
  readonly selected?: boolean;
  /** `input.indeterminate` (visual-only tri-state, `:indeterminate`). */
  readonly indeterminate?: boolean;
  /** `input.value` / `textarea.value` / `select` live value (validation +
   * `:placeholder-shown`). */
  readonly value?: string;
  /** `setCustomValidity(msg)` message — non-empty ⇒ `customError`. */
  readonly customError?: string;
  /** The control has been user-committed (`:user-valid`/`:user-invalid`). */
  readonly touched?: boolean;
}
