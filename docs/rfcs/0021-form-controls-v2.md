# RFC 0021 — Form controls v2: live control state, constraint validation, control layout

Status: implemented (core surface, with documented simplifications)
Packages: `ir` (`dom.ts` — `DomControlState`, `DomTree.control`), `cli`
(`fine.ts` — `DocControl` input, `structOf` layout-attr subset;
`script.ts` — control wrappers, validation, submission; `stylesheets.ts`
— UA rules; `forms-v2.test.ts`), `cascade` (`form-state.ts` — shared
semantics; `rule-index.ts` — 15 form pseudo-classes), `layout`
(`index.ts` — `isReplacedElement`, control intrinsic sizing)

## Decision

**Live control state is a first-class IR slot, not a DOM mutation.**
`DomTree.control?: ReadonlyMap<NodeId, DomControlState>` mirrors the
`uiState` precedent from RFC 0020: per-node `{ checked, selected,
indeterminate, value, customError, touched, valueDirty, selStart, selEnd,
selDir }`, seeded and replaced by the fine input `DocControl`, carried by
the full `domFacade`, and skipped by `structOnly` facades so layout never
observes it. `patchControl` in the script bridge is the single writer —
property sets, UI activation, editing, and `reset()` all funnel through
it, so DOM/cascade/layout/submission always agree on live state.

**`packages/cascade/src/form-state.ts` is the single source of truth**
for control semantics. Both `rule-index.ts` (pseudo-class matching) and
`script.ts` (wrapper getters/setters, submission, `successfulControls`)
call the same helpers:

- classification (`isTextControl`, `isCheckable`, `selectOptions`, …)
- `domDisabled` — fieldset-aware, with the first-legend exemption
- `domChecked` — live state over markup default
- `controlValueOf` — dirty-aware live value per control kind
- `computeValidity` — the ten `ValidityState` flags
- `matchesReadWrite` — disabled/readonly plus `contenteditable`
  inheritance
- placeholder-shown, `:default`, `:indeterminate`, `touched` helpers

### Pseudo-classes (15)

`:checked` `:disabled` `:enabled` `:required` `:optional` `:read-only`
`:read-write` `:valid` `:invalid` `:in-range` `:out-of-range` `:default`
`:indeterminate` `:placeholder-shown` `:user-valid` `:user-invalid`.

All read live control state: a programmatic `el.checked = true` toggles
`:checked` through `DocControl` invalidation (no attribute edit), option
`selectedness` feeds `:checked`, fieldset descendants resolve `:disabled`
through ancestors, and `contenteditable` propagates `:read-write` down
the tree.

### Layout: controls are replaced-ish elements

`isReplacedElement` replaces the repeated `img|svg|iframe` tag tests at
every layout site; `input`, `textarea`, `select`, `meter`, `progress`
join the set. `resolveIntrinsicSize` derives control metrics:

- checkbox/radio → the UA control square (~13px in the fixture)
- text inputs → `size`-attr × char width (default 20ch)
- textarea → `cols` × char width / `rows` × line height
- select → widest option / a minimum field width

`input[type=hidden]` is `display:none` in the UA sheet and `<datalist>`
renders nothing. The fine layout path needed one structural fix:
`qFineLayout` intentionally uses `structOnly` facades (attribute edits
must not dirty layout) — `structOf` now retains a small allowlist of
layout-relevant attributes on replaced/form tags (`type`, `size`,
`cols`, `rows`, `multiple`, `width`, `height`, `src`, `viewBox`, …) so
intrinsic sizing sees real values while unrelated attribute churn still
does not invalidate layout.

### Script surface (all real, all write-through to `DocControl`)

- Common: `value`/`defaultValue`/`checked`/`defaultChecked`/`selected`/
  `defaultSelected`/`disabled`/`required`/`readOnly`/`multiple`/`name`/
  `type`/`form`/`labels`/`validity`/`willValidate`/`validationMessage`/
  `checkValidity()`/`reportValidity()`/`setCustomValidity()`.
- Input: type sanitization on set, `valueAsNumber`, `stepUp`/`stepDown`
  with min/max/step clamping, `selectionStart`/`selectionEnd`/
  `selectionDirection`/`setSelectionRange`/`select`/`setRangeText`
  (select/start/end/preserve modes), `indeterminate`, and radio-group
  exclusivity on **both** activation and property assignment.
- Textarea: `value`/`defaultValue`/`textLength`/`rows`/`cols`, dirty flag
  (`defaultValue` edits never touch a dirty live value).
- Select/option: `options`/`selectedOptions`/`selectedIndex`/`value`/
  `multiple`/`add`/`remove`, live `selected` state, select-one
  exclusivity, option insertion steps (inserting a selected option into
  a select-one deselects the rest).
- `form.elements` (live HTMLFormControlsCollection), `form[name]` named
  access, `RadioNodeList` (multi-hit named access + live `value`
  accessor), `output` `value`/`defaultValue`, `input.list` →
  `<datalist>` back-reference, `label.control` (explicit `for` and
  wrapping), `input.labels`.

### Validation and submission

`computeValidity` implements all ten flags — `valueMissing`,
`typeMismatch`, `patternMismatch`, `tooLong`/`tooShort`,
`rangeUnderflow`/`rangeOverflow`, `stepMismatch`, `badInput`,
`customError`. `checkValidity()` fires a cancelable non-bubbling
`invalid` on failure and returns the verdict; `reportValidity()` is the
same plus the UA report hook. Interactive submission runs the
constraint-validation sweep: invalid controls each get `invalid`, the
first is focused, and submission aborts; `novalidate` on the form or
`formnovalidate` on the submitter bypasses it. `form.reset()` restores
markup defaults and clears `DocControl` state wholesale.

## Bugs found and fixed by this work

- **`select.value` conflated getter and submission semantics** — the
  shared helper returned the first option when nothing was selected,
  which is the form-data-construction rule; the `.value` getter must be
  `""` (spec). Split: submission keeps its own first-option fallback.
- **Detached-node live state** — `opt.selected = true` before insertion
  wrote the `nodeState` map but `session.dom.control` has no detached
  nodes; the insertion fixup reads `nodeState` first so pre-insertion
  state survives the attach.
- **`namedItem` returned the first hit only** — spec requires a
  `RadioNodeList` for multi-hit names (`f.elements.grp`); both the
  collection trap and `form[name]` now share `radioNodeList`.
- **Backspace on an empty field never marked the control touched** —
  the touch write sat inside the length>0 branch; a delete attempt on an
  empty field is still an interaction for `:user-invalid`.
- **`structOnly` hid all attributes from layout** — control intrinsic
  sizing regressed to default sizes (and `img[width]`-style attr sizing
  was inert on the fine path); fixed via the attr allowlist, preserving
  the invalidation discipline.

## Boundary (honest)

- Option insertion implements the deselect-others rule; the select-one
  "reset to first option when nothing selected" on arbitrary mutation
  sequences is the documented subset.
- `datalist` is model-only (options + `input.list` back-reference) — no
  suggestion-popup UI exists.
- `reportValidity()` has no visual form; it returns the verdict and
  fires the events — the "UA report" is a no-op log-free surface.
- `badInput` is reachable only for numeric input that fails coercion
  through `valueAsNumber`; partial-input heuristics (e.g. "1e" while
  typing) are not tracked.
- `select` intrinsic width uses the widest option text measure when
  available, else a field minimum — no full popup-menu metrics.
- `valueAsDate` is `null` (no Date plumbing yet); `webkitEntries`,
  `showPicker()`, and file/`files` handling are out of scope.
- Control rendering is box-level replaced layout — there is no native
  widget theme (no `appearance` painting, no dropdown chrome).

## Evidence

- `forms-v2.test.ts`: 17/17 — constraint flags, `setCustomValidity`,
  `check`/`reportValidity` event semantics, interactive submission
  blocking + focus-first-invalid, `novalidate`/`formnovalidate`, radio
  exclusivity on activation AND property set, live `:checked`/
  `:indeterminate`/`:default` through computed style, fieldset
  disabled + first-legend exemption, the select model (options/
  selectedIndex/value/multiple/add/remove + insertion fixup), textarea
  dirty semantics, `label.control`/`input.labels`, `output`/`datalist`/
  `input.list`, `form.elements`/`form[name]`/`RadioNodeList.value`,
  input reflectors (`type` sanitize, `valueAsNumber`, `stepUp`/`Down`,
  selection APIs + `setRangeText`), `:placeholder-shown`/`:read-write`/
  `:read-only`/`:user-invalid`, intrinsic sizing, `reset()`.
- Full suite: 1475/1475; WPT subsets 462/462 (zero regression).
- `npm run ci` all gates green.
