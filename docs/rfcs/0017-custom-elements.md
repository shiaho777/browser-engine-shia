# RFC 0017 — Custom Elements v1

Status: implemented (core surface, with documented simplifications)
Packages: `cli` (script bridge, session), `ir` (DomTree), `cascade` (`:defined`)

## Decision

Real `customElements` on the guest global — registry, upgrade machinery, and
all four lifecycle entry points that matter to page code — implemented inside
`buildDocumentApi()` so classic and ESM script paths share one behaviour, with
the defined-name set mirrored into the incremental DOM so `:defined` matches
inside the existing cascade, and lifecycle delivery riding the same
`session.onMutation` sink that feeds MutationObserver.

### Why a script-bridge registry, not a DomNode field

A custom-element definition is realm state (it maps names to *guest
constructors*); putting JS functions into `DomNode`/IR would smear the script
boundary into the kernel input layer. Instead:

- `ceRegistry: Map<localName, { ctor, observedAttributes, extendTag }>` lives
  inside `buildDocumentApi` — per-document, per-script-realm, exactly where a
  browser keeps it.
- The **defined-name set** (strings only — data, not behaviour) is mirrored
  onto `session` via `session.defineCustomElement(name)` → a fresh `Set` per
  define, seeded into the incremental db as `DocDefined` and attached to the
  full `DomTree` facade (`structOnly` facades skip it — layout never sees CE
  state). Cascade reads `dom.defined` for `:defined`. The mutable `#dom` tree
  gets the same field so script-side consumers agree.

## Mechanism

### `customElements` surface

`define(name, ctor, { extends? })` validates: potential custom-element name
(`[a-z][.\w-]*-[.\w-]*` + reserved-name blocklist → `SyntaxError`
DOMException), function ctor, no duplicate name, no reused ctor (both
`NotSupportedError`), captures `static observedAttributes` into a Set.
`get`, `whenDefined` (waiter map resolved with the ctor; invalid name →
rejected promise), `upgrade(wrapper)` for manual upgrades.

### Upgrade — one path for every element origin

`ceUpgradeIfDefined(id)` runs lazily from `makeElementCached` — the single
choke point every DOM accessor already flows through (`createElement`,
`querySelector*`, `childNodes`, `innerHTML` results, event targets…). It:

1. resolves the definition: `is=` attr for customized built-ins (requires
   `def.extendTag === node.tag`), else same-named autonomous def;
2. stamps `ceUpgraded` (idempotent), swaps the cached wrapper's prototype to
   `def.ctor.prototype` — preserving wrapper identity, so `instanceof` flips
   true even for wrappers handed out before `define()`;
3. runs the class constructor via `Reflect.construct(def.ctor, [], def.ctor)`
   while `pendingCeUpgrade` holds the wrapper — `super()` inside `extends
   HTMLElement` (or any generated `HTML*Element` interface ctor — they got the
   same early-return) yields the wrapper instead of throwing "Illegal
   constructor";
4. enqueues `attributeChangedCallback` per observed attribute present
   (oldValue `null` → current), then `connectedCallback` if the node is
   connected — matching the spec's upgrade ordering.

`define()` then upgrades every matching element already in the document in
tree order — parser-created elements upgrade exactly like dynamic ones.

### Lifecycle delivery

A second `session.onMutation` sink (independent of any MutationObserver
registration) routes:

- `childList` additions whose new subtree is connected → per-element preorder:
  upgrade-if-defined, then `connectedCallback` (the upgrade itself emits it
  for first-time upgrades — no double-fire);
- `childList` removals where the former parent is still connected → preorder
  `disconnectedCallback` on upgraded nodes (reparent = removal+insertion pair,
  so moves fire disc→conn exactly like browsers);
- `attributes` on upgraded nodes → `attributeChangedCallback(name, old, new)`
  gated by `observedAttributes`, reusing the mutation record's captured
  `oldValue`.

All callbacks are invoked on the wrapper and funnel through
`options.onListenerError`, matching the listener-error policy.

### `:defined`

`SupportedPseudoClass` gained `"defined"`; matching reads `dom.defined`:
built-in tags always match, hyphenated tags match iff defined, `is=` matches
iff its value is defined. Selector matching, `matches()`, `querySelector*`,
and the style cascade all inherit it since RuleIndex is the sole entry point.

## Boundaries (honest)

- **No Shadow DOM** — `attachShadow` doesn't exist yet (Phase 2 item);
  `slot`, event retargeting, and style scoping are absent.
- **`adoptedCallback` unimplemented** — there is no `adoptNode` machinery to
  hang it on; documented, not faked.
- **Reaction-queue granularity** — lifecycle callbacks run synchronously
  inside the mutating call (after the DOM write, same tick), not via the
  spec's backup-element-queue/microtask-checkpoint machinery; user-visible
  ordering matches for observed mutations, but a callback that mutates the DOM
  re-enters the sink immediately rather than at checkpoint time.
- **`is=` matching is name-only** in the cascade (`:defined` doesn't
  re-verify `extends` vs the host tag) and in `ceDefinitionFor` a defined
  `is` name whose `extends` tag differs is ignored for upgrade — matching
  browsers' "inert `is`" outcome via a slightly different predicate.
- **Failed upgrades stay failed** — a throwing ctor marks the node upgraded
  (spec "failed" state); `upgrade()` won't retry, connectedCallback still
  fires (the DOM-write reaction still dispatches — spec queues it regardless).
- **`cloneNode` upgrades eagerly** — cloning runs the constructor (spec-
  consistent); the clone's upgrade happens on wrapper creation, not lazily
  at insertion.
- **Name regex is ASCII-subset** — the full Unicode `PotentialCustomElementName`
  production is approximated by `[a-z][.\w-]*-[.\w-]*` + reserved list; exotic
  astral names would be rejected that a browser would accept.
- **Registry is per-`buildDocumentApi` call** — the app path creating a fresh
  api per document is correct; a second api on the same session gets an empty
  registry (session-level `defineCustomElement` set persists for `:defined`
  but constructor state does not transfer).

## Verification

`packages/cli/src/custom-elements.test.ts` — 12 tests driven through
`runScriptsOnSession`: define/get/identity, error taxonomy (SyntaxError/
NotSupportedError/TypeError), conn/disc on attach-detach-reattach and subtree
removal, observedAttributes gating with old/new, parser-upgrade ordering
(ctor→attrChanged→conn), innerHTML-insertion upgrade, `:defined` on all three
states, customized built-ins via `{ extends }` + `{ is }`, illegal-direct-
construction (`new HTMLElement()`, `new XFoo()`), `whenDefined` resolve/
reject, and thrown-ctor resilience. 1423/1423 total, WPT 462/462, all gates.

## Rollback

`git revert` of this RFC's diff removes: the CE block + `pendingCeUpgrade` in
`script.ts`, `defineCustomElement`/`DocDefined`/`defined` in `fine.ts`/`ir`,
the `"defined"` pseudo in `rule-index.ts`, and `custom-elements.test.ts`.
No other feature depends on these additions.
