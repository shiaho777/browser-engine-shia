/**
 * Nominal branding for IR types (design.md §6).
 *
 * Each pipeline-stage output carries a *distinct* nominal type brand so that
 * v0-style "read the wrong field / read the wrong stage" mistakes fail to
 * compile. A `FragmentTree` can never be passed where a `ComputedStyle` is
 * expected, even though both are structurally objects, because their phantom
 * brand strings differ (Requirement 3.1).
 *
 * The brand is a *phantom* symbol: it exists only in the type system and is
 * never materialised at runtime, so branding adds zero runtime cost.
 */
declare const brand: unique symbol;

/** Attach a unique nominal brand `B` to a structural type `T`. */
export type Branded<T, B extends string> = T & { readonly [brand]: B };

// ---- branded numeric primitives -------------------------------------------

/** A length in CSS pixels. Branded so a raw `number` cannot stand in for it. */
export type Px = Branded<number, "Px">;

/** Identity of a DOM node within a `DomTree`. */
export type NodeId = Branded<number, "NodeId">;

/** Identity of a fragment within a `FragmentTree`. */
export type FragmentId = Branded<number, "FragmentId">;

/** Construct a `Px` value from a raw number. */
export function px(value: number): Px {
  return value as Px;
}

/** Construct a `NodeId` from a raw number. */
export function nodeId(value: number): NodeId {
  return value as NodeId;
}

/** Construct a `FragmentId` from a raw number. */
export function fragmentId(value: number): FragmentId {
  return value as FragmentId;
}
