/**
 * `getBoundingClientRect` — reads geometry ONLY from the FragmentTree
 * (design.md §8.4; Requirement 3.4). This is the architectural root-cause fix
 * for v0 bug#2.
 *
 * ## What v0 got wrong, and why this cannot repeat
 *
 * v0's `getBoundingClientRect` reverse-read the wrong field off the cascade
 * product (`S_COMPUTED_STYLE._layoutBox`) instead of the layout product
 * (`S_LAYOUT_BOX`). Here that mistake is structurally impossible: this function
 * accepts only the {@link FragmentTree} (the SOLE source of geometry, design.md
 * §6) and `ComputedStyle` carries NO geometry fields at all (Requirement 3.3,
 * enforced by the IR's types). There is no `ComputedStyle` in scope to misread,
 * and even if there were, it has no rectangle to return — a wrong-field read
 * would not type-check.
 *
 * ## The single legal source (Requirement 3.4)
 *
 * The returned rectangle is exactly the node's `Fragment.box.borderBox` and
 * nothing else. Task 3.9's geometry single-source property (Property 3) leans on
 * this exact equality:
 *
 *     ∀ node:  getBoundingClientRect(tree, node) === fragmentOf(node).box.borderBox
 *
 * ## Coordinate space (documented Phase 1 simplification)
 *
 * The layout engine (task 3.7) expresses each fragment's `BoxGeometry`
 * **relative to its containing block** (design.md §6, "相对包含块"). A browser's
 * `getBoundingClientRect` returns *viewport-relative* coordinates. Phase 1
 * deliberately returns the fragment's `borderBox` **verbatim in the layout's
 * containing-block-relative coordinate space** rather than accumulating ancestor
 * offsets into document-absolute coordinates. Two reasons:
 *
 *   1. Requirement 3.4 — the thing under test — is purely about the *source* of
 *      the rectangle (FragmentTree.borderBox, never ComputedStyle), not its
 *      coordinate origin. Returning the borderBox verbatim demonstrates the
 *      single-source guarantee directly.
 *   2. It keeps Property 3 an exact identity (`gBCR === frag.box.borderBox`); an
 *      ancestor-offset transform would be a separate, later concern (the
 *      viewport transform lands when real positioned/scroll layout does).
 *
 * ## Absent / non-laid-out node
 *
 * A node that produced no fragment — most commonly `display:none`, whose subtree
 * the layout engine skips entirely — has no geometry. This returns a **zero
 * rectangle** for that case, matching the web platform: a `display:none`
 * element's `getBoundingClientRect()` is a `DOMRect` of all zeros. It is a real,
 * specified value (not a placeholder for an unimplemented path), so it is
 * returned rather than signalled as missing.
 *
 * This module imports ONLY the frozen IR (`@browser-engine/ir`) — the single
 * sanctioned inter-stage channel — so it never reaches across a stage boundary.
 */
import { px } from "@browser-engine/ir";
import type { FragmentTree, NodeId, Rect } from "@browser-engine/ir";

/**
 * The rectangle returned for a node that produced no fragment (e.g.
 * `display:none`). All-zero, matching the web platform's `DOMRect` for a
 * non-laid-out element. Frozen so callers cannot mutate the shared instance.
 */
const ZERO_RECT: Rect = Object.freeze({
  x: px(0),
  y: px(0),
  width: px(0),
  height: px(0),
});

/**
 * Return the bounding rectangle of `node`, derived **solely** from its
 * {@link FragmentTree} fragment's `box.borderBox` (design.md §8.4;
 * Requirement 3.4).
 *
 * Each `Fragment` back-references its DOM node via `Fragment.node`, so the
 * node→fragment lookup is a scan of the fragment map for the matching
 * `node` id. In Phase 1 a laid-out node maps to exactly one fragment, so the
 * first match is its box; this returns that fragment's `borderBox`.
 *
 * @param tree the layout product — the only legal source of geometry.
 * @param node the DOM node whose border-box rectangle is requested.
 * @returns the node's `borderBox` (containing-block-relative; see the module
 *   doc), or a zero rectangle when the node produced no fragment
 *   (`display:none` / not laid out).
 */
export function getBoundingClientRect(tree: FragmentTree, node: NodeId): Rect {
  for (const fragment of tree.fragments.values()) {
    if (fragment.node === node) {
      return fragment.box.borderBox; // the SOLE legal source (Req 3.4).
    }
  }
  return ZERO_RECT; // no fragment ⇒ display:none / not laid out ⇒ zero rect.
}
