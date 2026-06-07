/**
 * The module-private kernel/guest boundary (design.md §10, §3.1.E;
 * Requirement 7).
 *
 * Every engine-internal handle a DOM wrapper needs — the {@link NodeId} that
 * identifies the node, the Incremental_Kernel {@link Db} it reads through, and
 * the fragment index used to source geometry — is stored **behind the
 * module-private `INTERNAL` symbol**, inside a {@link WeakMap} that guest code
 * has no reference to. The symbol is created here and is **never exported from
 * the package entry point** (`./index.ts`), so guest code can neither name it
 * nor reach the slot it keys.
 *
 * Why this design satisfies all four Requirement 7 criteria (and why a plain
 * symbol-keyed *own property* would NOT):
 *
 *   - 7.1 — the handle is stored behind a module-private symbol (`INTERNAL`)
 *     that is not exported to guests.
 *   - 7.2 — `Object.keys` / `for…in` / `Reflect.ownKeys` over a wrapper exclude
 *     all engine-internal state. A symbol-keyed *own* property would still be
 *     returned by `Reflect.ownKeys(wrapper)` (handing the guest the very symbol
 *     it must not have), so instead the handle lives in a module-private
 *     `WeakMap`: there is NO internal key on the wrapper, its prototype, or its
 *     constructor for any enumeration to surface.
 *   - 7.3 — the injected guest global (see `./surface.ts`) is built from the
 *     generated `DOM_SURFACE` table and nothing else; `INTERNAL` is never part
 *     of that surface.
 *   - 7.4 — a guest that probes for an internal handle by any key it *can* form
 *     (a string, or a fresh symbol of its own) gets `undefined`, because the
 *     only path to the handle is `readInternal`, which closes over the
 *     unexported `slots` map keyed by the unexported `INTERNAL` symbol.
 *
 * The wrapper classes additionally keep the handle in a `#private` field as a
 * second, independent layer of defense (design.md §10).
 *
 * @internal This module is package-private. It MUST NOT be re-exported from
 * `./index.ts`.
 */
import type { FragmentId, NodeId, DomNode } from "@browser-engine/ir";
import { NotImplemented } from "@browser-engine/ir";
import type { Db, QueryDef } from "@browser-engine/kernel";

/**
 * The module-private boundary key. The engine-internal handle is stored *behind*
 * this symbol (it is the key of the slot record held in {@link slots}). Guests
 * never receive this symbol, so they cannot reach the slot.
 */
const INTERNAL: unique symbol = Symbol("engine-internal");

/**
 * The engine-internal handle hidden behind {@link INTERNAL} for every DOM node
 * wrapper. These are exactly the handles Requirement 7.1 names: the node
 * identifier, the Incremental_Kernel `Db`, and the fragment index.
 */
export interface NodeInternal {
  /** Identity of the wrapped node within the DomTree. */
  readonly node: NodeId;
  /** The Incremental_Kernel database the wrapper reads through. */
  readonly db: Db;
  /**
   * The query that resolves a {@link NodeId} to its {@link DomNode}. Reading
   * DOM state goes through the kernel (`db.query(nodeQuery, node)`) so the
   * wrapper participates in automatic dependency tracking (design.md §7).
   */
  readonly nodeQuery: QueryDef<NodeId, DomNode>;
  /**
   * Index of this node's fragment in the FragmentTree — the single legal source
   * of geometry (design.md §6, §8.4). Optional because layout may not have run.
   */
  readonly fragmentIndex?: FragmentId;
}

/**
 * The guest-unreachable store. Maps a wrapper object to a record whose only key
 * is the module-private {@link INTERNAL} symbol; the handle lives *behind* that
 * symbol. Neither `slots` nor `INTERNAL` is exported, so guest code has no path
 * here. A `WeakMap` (rather than an own property) is what keeps wrapper
 * enumeration clean (Requirement 7.2) and stray accesses `undefined`
 * (Requirement 7.4).
 */
const slots = new WeakMap<object, { readonly [INTERNAL]: NodeInternal }>();

/**
 * Associate `wrapper` with its engine-internal `handle`, storing it behind the
 * module-private {@link INTERNAL} symbol. Called once, at wrapper construction,
 * by trusted in-package code only.
 *
 * @internal
 */
export function attachInternal(wrapper: object, handle: NodeInternal): void {
  slots.set(wrapper, { [INTERNAL]: handle });
}

/**
 * Read a wrapper's engine-internal handle. Available to trusted in-package
 * engine code only, because both {@link slots} and {@link INTERNAL} are
 * module-private. Guests cannot call this path: they hold neither the map nor
 * the symbol.
 *
 * @throws NotImplemented if `wrapper` has no attached handle — a loud failure
 *   rather than a silent `undefined`, since an engine-built wrapper always has
 *   one (design.md §12; Requirement 5.1).
 * @internal
 */
export function readInternal(wrapper: object): NodeInternal {
  const record = slots.get(wrapper);
  if (record === undefined) {
    throw new NotImplemented("dom-api:internal-handle", {
      category: "dom-api",
      detail: "object is not an engine-built DOM wrapper (no internal handle)",
    });
  }
  return record[INTERNAL];
}
