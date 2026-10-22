# RFC 0020 — Input fidelity: typed events, focus, pointer/mouse/keyboard UI sequences

Status: implemented (core surface, with documented simplifications)
Packages: `guest` (`event-system.ts` — `PointerEvent`), `ir` (`DomTree.uiState`),
`cli` (`fine.ts` — `DocUiState` input; `script.ts` — event factory, focus
machinery, `ui` surface; `event-loop.ts`/`esm-runner.ts` — guard-installed
real classes), `cascade` (`rule-index.ts` — five UI-state pseudo-classes),
`generator` (`value-runtime.ts` — full CSS Color 4 keyword table)

## Decision

**Platform events are real guest class instances.** `dispatch` always drove
objects through the `DispatchableEvent` `_set*` hooks, so instead of a
parallel plain-object event, `makeEvent`/`platformEvent` constructs the
proper guest class (`PointerEvent`, `MouseEvent`, `KeyboardEvent`,
`FocusEvent`, `InputEvent`, `WheelEvent`, `CompositionEvent`, `Event`) by
event name and marks it `_setTrusted(true)`. Inside listeners,
`e instanceof PointerEvent`, `e.isTrusted`, and `e.composedPath()` all
behave like a browser; guest-constructed `new Event(...)` is the same
class but untrusted — the spec's real distinction, free.

`classForEventType` encodes the Pointer-Events-3 mapping:
`click`/`auxclick`/`dblclick`/`contextmenu`/`gotpointercapture`/
`lostpointercapture`/`pointer*` → `PointerEvent`; `mouse*` → `MouseEvent`;
`key*` → `KeyboardEvent`; `focus`/`blur`/`focusin`/`focusout` → `FocusEvent`;
`input`/`beforeinput` → `InputEvent`; `wheel` → `WheelEvent`;
`composition*` → `CompositionEvent`; everything else → `Event`.

### UI state is incremental input, not mutation

`DomTree.uiState` (optional, immutable slot — `{ focus?, focusVisible?,
active?, hover? }`) is fed by a new fine input `DocUiState`, seeded per
session and replaced by a fresh object on every transition
(`FineSession.setUiState`). The `domFacade` used by `qFineComputed` and
the query APIs carries it; `matchesPseudoClass` gains:

- `:focus` — `uiState.focus === node`
- `:focus-within` — `uiState.focus` is the node or its descendant
- `:focus-visible` — focused AND the focus-visible flag is set
- `:active` — `uiState.active === node`
- `:hover` — `uiState.hover` is the node or its ancestor chain contains it

Because matching reads the same `dom.uiState` object the fine db tracked,
`setInput(DocUiState)` dirties exactly the computed-style queries that read
it — style reacts to pointer/focus changes through the normal incremental
path. `structOnly` facades skip the slot so layout queries never observe
it (matching the existing `defined` precedent).

`session.uiEpoch` — a monotonic counter bumped in `setUiState` — joins the
script-side `mutations` counter so the `getComputedStyle` proxy caches
invalidate on UI transitions as well as DOM edits.

### Focus machinery (script bridge, shared by every runner)

- `isFocusable(id)` — HTML focusable-area subset: links with `href`,
  enabled form controls (excluding `input[type=hidden]`), `[tabindex]` ≥ 0,
  `iframe`, `audio`/`video[controls]`, `body`/`html`, `contenteditable`;
  `inert`/`hidden` subtrees and `disabled` controls excluded.
- `setFocused(id, visible)` — spec order `blur` → `focusout` on the old
  element, state update, then `focus` → `focusin` on the new (blur/focus
  don't bubble, focusout/focusin do; `relatedTarget` carries the other
  endpoint's wrapper).
- `element.focus()` — runs when focusable; `.blur()` clears only when it
  is the focused node. `tabIndex` reflects the attribute, defaulting to
  0 for natively focusable elements, −1 otherwise; setting it writes the
  attribute. `document.activeElement` falls back to `<body>`;
  `document.hasFocus()` is `true` (single-document harness).
- `:focus-visible` heuristic — keyboard modality (Tab, autofocus) and
  text-editing controls set it; pointer and programmatic `.focus()`
  don't. This mirrors the UA rule, not a hardcoded flag.
- **autofocus** — elements inserted carrying `autofocus` (parser scan for
  the initial tree + mutation sink for dynamic inserts) queue for a
  microtask flush; the first focusable candidate takes focus with the
  keyboard-like modality. Once per document.
- Detach — removing the focused/hovered/active subtree silently resets
  that state; no blur events fire on dead nodes (matches Chrome).
- Clicking unfocusable content walks up to the first focusable ancestor;
  the universal fallback is `<body>` — `document.activeElement` becomes
  BODY rather than null.

### The `ui` surface — host-side event synthesis

`buildDocumentApi` returns `ui` (and both runners expose it):

| Method | Sequence |
| --- | --- |
| `ui.pointerMove(id, init?)` | leave/out on the old hovered target, over/enter + `pointermove`/`mousemove` on the new; sets `:hover` |
| `ui.click(id, init?)` | crossing chain if needed → `pointerdown` → `mousedown` → focus default action → `:active` → `pointerup` → `mouseup` → clear `:active` → `click` (button 0) / `auxclick` (button 2 is contextmenu's) + activation behavior |
| `ui.contextMenu(id, init?)` | right-button down/mousedown → `contextmenu` → up/mouseup |
| `ui.dblClick(id, init?)` | two full clicks + `dblclick` (detail 2) |
| `ui.key({key, code?, ...})` | `keydown` → [`keypress` for printable] → `beforeinput` → value edit → `input` → `keyup` on the focused element |
| `ui.tab(dir)` | Tab traversal — positive `tabindex` group sorted by value, then the natural focusable set in document order; wraps; sets `:focus-visible` |

Crossing events are non-bubbling per spec and fire on every path node —
enter runs root→target, leave runs target→root; the pointer pair precedes
the mouse pair (`pointerover`/`pointerenter` then `mouseover`/`mouseenter`,
and symmetrically on the way out). Movement events carry `button: -1`,
`buttons: 0`; press events carry the button and a `buttons` bit-mask.

Keyboard: `keydown` is cancelable — `preventDefault()` suppresses
keypress AND the editing default action (spec groups both as the default).
Printable single-codepoint keys fire `keypress` then drive
`beforeinput`(cancelable, `inputType: "insertText"`) → `nodeState.value`
mutation → `input`; `Backspace` skips keypress and uses
`deleteContentBackward`. `key`/`code`/`location`/`repeat`/modifier fields
populate `KeyboardEvent`; `isComposing`/`charCode`/`keyCode` ride the
class's fields.

`el.click()` and the host `clickElement` now dispatch a trusted
`PointerEvent` (composed) — script-initiated clicks intentionally do NOT
move focus (matches Chrome). `dispatchElementEvent` and
`fireScriptElementEvent` share the same typed factory, so iframe `load`
and friends are trusted real `Event`s too.

### Real classes everywhere (stub removal)

`installEventTarget`'s grab-bag in both runners stopped force-overwriting
typed constructors: `MouseEvent`/`KeyboardEvent`/`FocusEvent`/
`PointerEvent` were previously `EventCtor` aliases. They now guard-install
the guest classes (`if sandbox.X === undefined`) so the document API's
realm constructors always win when present; `getComputedStyle` also became
guard-installed (its unconditional stub was masking the real facade in
`runScriptsOnSession` — found while debugging `:focus` serialization).

## New guest API: `PointerEvent`

Full init surface: `pointerId`, `pointerType`, `isPrimary`, `width`,
`height`, `pressure`, `tangentialPressure`, `tiltX`, `tiltY`, `twist`,
`altitudeAngle`, `azimuthAngle`, plus inherited mouse coordinates/buttons/
modifiers and `getCoalescedEvents()` (single-entry list — no prediction/
coalescing pipeline exists).

## Validation

- `input-fidelity.test.ts` — 16 tests: class identities + property
  passthrough + `isTrusted`, the full click/crossing order,
  blur→focusout→focus→focusin with `relatedTarget`, `activeElement`/
  `hasFocus`/`tabIndex`, all five pseudo-classes through computed style,
  hover enter/move/leave ordering, contextmenu/auxclick/dblclick
  sequences, keyboard value editing (including Backspace and
  preventDefault suppression), Tab ordering+wraparound, autofocus,
  detach-resets-focus, and checkbox activation through `PointerEvent`
  click.
- Full suite: 1458/1458; WPT subsets 462/462 (dom-events unchanged).
- `npm run ci` all gates green.

## Bugs found and fixed by this work

- **`NAMED_COLORS` was a six-entry Phase-1 subset** — `color: pink`,
  `orange`, `purple`, … parsed as declaration-drop errors, which silently
  made UI-state rules look like they weren't matching. Replaced with the
  complete CSS Color 4 keyword table (148 names + `transparent`).
- **`getComputedStyle` stub** in `installEventTarget` unconditionally
  replaced the real facade for `runScriptsOnSession` — guard-installed.
- **`getComputedStyle` script-side caches** only invalidated on DOM
  mutation count — UI-state transitions now bump `session.uiEpoch` and
  flush them.
- **Crossing/press button semantics** — arrival events now carry
  `button: -1`/`buttons: 0` (movement), press events carry the button.

## Boundary (honest)

- `keypress` fires for single-codepoint printable keys only; no IME
  composition pipeline (a `CompositionEvent` class exists but nothing
  synthesizes composition sessions).
- `getCoalescedEvents()` returns a one-element list; no predicted events.
- `:focus-visible` uses the documented UA heuristic (keyboard modality +
  text-editing controls); it does not inspect heuristics like "user had
  previously typed".
- `uiTab` orders positive `tabindex` by value then document order for the
  natural set — flattened-tree preorder including shadow descendants;
  sequential-focus navigation starting points and `inert` nested
  shadow-boundary subtleties are out of scope.
- `pointerenter`/`pointerleave`/`mouseenter`/`mouseleave` fire on every
  path node (spec) rather than only where the boundary actually changes —
  an artifact of stateless per-event dispatch; over/out on the OLD hover
  target fires before enter on the new target's path (spec-correct for a
  move between siblings, conservative otherwise).
- `hasFocus()` always true; no multi-document focus model.
- `activeElement` never enters a shadow root to find a deeper focused
  element (shadow hosts report themselves).
- `WheelEvent`/`CompositionEvent` are constructible but nothing
  synthesizes them yet.
- `click()` on an element does not fire pointer/mouse precursors (spec —
  only the trusted UA sequence does).
