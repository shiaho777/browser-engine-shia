# RFC 0041 — GC'd DOM Wrappers (WeakRef wrapper cache)

Phase 6 (perf). Before this RFC the session-side wrapper caches in the CLI
realm were strong `Map<NodeId, object>`s: every wrapper ever handed to
guest code lived until session teardown. A page that created and dropped
10k elements pinned all 10k wrappers (plus their closures, expandos, and
`idOf` edges) for the life of the document — an unbounded, always-on leak.

This RFC converts the caches to `WrapperCache`
(`guest/wrapper-cache.ts`): `Map<NodeId, WeakRef<wrapper>>` +
`FinalizationRegistry` cleanup.

## What is keyed weakly, and why the split matters

Two kinds of state hang off a NodeId, with different owners:

| State | Lifetime owner | Cache |
|---|---|---|
| DOM wrapper object (the JS face) | guest references | **WeakRef** — collectible when unreachable |
| Listeners, form/control `nodeState`, `gcs` caches, canvas/WebGL engines, style sheet objects | the DOM node itself | strong per-session `Map` — must survive wrapper GC: an *attached* element whose wrapper was collected still needs its listeners to fire and its canvas bitmap painted |

That split is the semantic rule of this RFC: **wrapper lifetime is
determined by script reachability; engine state lifetime is determined by
node membership.** Deleting engine state on wrapper finalization would be
a correctness bug (detached-from-JS ≠ detached-from-DOM), so we don't do
it.

## The cache (`WrapperCache`)

```ts
set(id, wrapper)  → registers WeakRef + FinalizationRegistry token;
                    returns the canonical wrapper (first live wins)
get(id)           → deref(); lazily deletes dead entries
```

- Identity while reachable is unchanged:
  `getElementById("x") === getElementById("x")` holds — the second call
  derefs the live entry.
- If a wrapper is collected, the next query mints a fresh wrapper for the
  same node. Spec-equivalent: `===` can only be observed while both
  operands are reachable, and reachability forces the same object.
- ABA safety: the registry callback only deletes an entry when its
  `WeakRef` is *still* dead — a re-minted wrapper for the same id is never
  evicted by a stale finalization.
- `element.style` (`styleWrappers`) uses the same cache: a referenced
  `CSSStyleDeclaration` keeps identity and expandos; a dropped one may be
  collected and re-minted — again, only observable while referenced.

## Navigation

Navigation replaces the `boot.session` closure wholesale — every
per-session map, WeakRef or not, becomes collectible; bfcache entries
retain their session deliberately (browser behavior). With weak wrapper
entries, the session holds nothing but the DOM itself, so dropping the
closure frees the entire JS face.

## Boundaries (honest)

- Node-keyed engine state (canvas bitmaps, control state, listener lists)
  lives until session end even for detached-but-alive nodes — matches the
  lifetime model above; reclaiming canvas backing stores for *attached*
  nodes would require reachability analysis through the DOM, which is the
  host GC's job once the session drops.
- `FinalizationRegistry` callbacks are task-scheduled — entry cleanup is
  lazy; the map may hold dead entries between GC and the next task turn
  (bounded by entry size, not wrapper size).
- WeakRef collection timing is engine-defined — tests force GC via a
  `--expose-gc` child process; production correctness never depends on a
  particular collection happening.

## Evidence

- `wrapper-gc.driver` (spawned under `--expose-gc`): detached element,
  subtree root + inner, and style-declaration wrappers all collect after
  full GC — would all be retained by the old strong `Map`.
- `wrapper-gc.test.ts` in-process: `getElementById`/`querySelector`/`body`
  identity stable while referenced; referenced `style` keeps identity +
  expando state.
- Full suite green — every existing DOM test runs against the weak cache
  (identity regressions would surface everywhere).
