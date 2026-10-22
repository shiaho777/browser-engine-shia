# RFC 0037 — Accessibility tree: AX extraction from DOM+style+layout

Status: implemented. Every `finishPage` builds a real accessibility tree for
the rendered document — roles per ARIA-in-HTML with `role=` override, names
per the accName ordering, states, and fragment-derived geometry in absolute
page coordinates — exposed on `PageState.axTree`. A serializable snapshot
(`axSnapshot`), a Chrome-style text dump (`axDump`), and a bridge seam
(`AXBridge` + `jsonAxBridge` reference consumer) ship with it.

## Decision

**One invariant: the AX tree is built from the SAME `dom` + `styleOf` +
`fragmentTree` + `focus` inputs the paint pass consumed — assistive tech sees
exactly what was rendered, never a stale or parallel model.**

`buildAxTree(dom, styleOf, fragmentTree, {focus})` lives in
`packages/app/src/a11y.ts` — the layer where document, style and geometry
already join. `renderDom` returns its `styleOf` resolver so the tree reads
the real cascade (`display:none`, `visibility:hidden|collapse`) rather than
re-deriving visibility.

### Roles

- Implicit mapping per ARIA-in-HTML: `a[href]`→`link`, `h1–h6`→`heading`
  (+`level:N` state), `nav`→`navigation`, `main`/`header`/`footer`→
  landmarks (`banner`/`contentinfo` only when the element is not scoped
  inside `article/aside/main/nav/section`), `input[type]`→the full
  checkbox/radio/slider/spinbutton/searchbox/textbox table,
  `select`→`combobox`|`listbox` (by `size`/`multiple`), the table family
  (`table/rowgroup/row/cell/columnheader`), `details`→`group`,
  `summary`→`button`, `progress`/`meter`, `figure`/`figcaption`, list
  machinery (`ul/ol`→`list`, `li`→`listitem`, `dl`/`dt`/`dd`), `p`→
  `paragraph`, `hr`→`separator`, `dialog`, `form`, `img` (empty `alt=""`→
  `none` per spec).
- `role=` wins when the first token is a known ARIA role; unknown tokens
  fall through to the implicit role (spec behavior).
- `role="none"|"presentation"` and unroled containers become `generic`
  (Chrome's genericContainer) — children keep their place in reading order.
- The document root becomes `document` named by `<title>`. Text children
  appear as `StaticText` nodes (reading order preserved).

### Names (accName-lite)

Order: `aria-labelledby` (IDREF list → referenced text) → `aria-label` →
element semantics (`img.alt`, button-`input.value` with Submit/Reset
defaults, `<label for>`/wrapping-label text for form controls, `fieldset`'s
first `<legend>`, `iframe.title`) → subtree text **only for
name-from-content roles** (`button`, `link`, `heading`, `listitem`, `cell`,
`option`, `paragraph`, `term`, `definition`, `caption`, `checkbox`, `radio`,
`switch`, `tab`, `tooltip`, `menuitem*`, `treeitem`, `columnheader`,
`rowheader`, `gridcell`). Landmarks/forms/regions stay nameless unless
explicitly labelled — matching the spec prohibition on name-from-content
for those roles. Hidden subtrees never contribute text.

### States, values, geometry

- States: `focused` (from the page `EditFocus`), `checked`/`unchecked`
  (attr or `aria-checked`), `selected`/`not selected`, `expanded`/
  `collapsed` (`aria-expanded`, `<details open>`), `pressed`,
  `disabled`, `required`, `readonly`, `invalid`, `busy`, `modal`,
  `multiline`, `multiselectable`, `live:<politeness>`, `haspopup`,
  `level:N`, `current`, `linked`, `focusable`.
- `value`: `aria-valuenow`/`aria-valuetext`, text-like `input.value`,
  `progress`/`meter`/`slider`/`spinbutton` values.
- Geometry: union of the node's fragment border-boxes in absolute page
  coordinates (same walk paint uses for images); `null` for purely
  structural nodes (e.g. `StaticText`, `document`).

### Lifecycle

The tree is rebuilt inside every `finishPage` — so DOM mutation, style
changes, relayout, scroll and focus edits all flow to AT consumers through
`page.axTree` on the next repaint, identically to how a real engine
re-serializes its AX tree per frame.

## Honest boundaries

1. **No OS assistive-tech IPC.** AT-SPI (D-Bus), NSAccessibility and UIA all
   require native bindings — the bridge seam is `AXBridge`; `jsonAxBridge`
   is the in-process reference consumer (serializable snapshot for
   automation/tests) and `axDump` gives a `chrome --dump-accessibility-
   tree`-style text form.
2. **accName is a subset**: no `aria-describedby`-driven descriptions on
   every node (description comes from `aria-description`/`title`), no
   pseudo-element contribution, no embedding/recursion semantics for
   controls that pull text from referenced elements beyond `labelledby`.
3. **StaticText nodes carry no geometry** — inline text geometry would need
   per-line-box fragment ranges; the parent element's box covers them.
4. **`textarea`/`select` live values** are script-side state; the tree
   reports attribute `value` only for `input`/`progress`/`meter` and ARIA
   value attributes.
5. **No live-region announcement queue, no relation APIs**
   (`aria-owns`/`activedescendant`/`flowto`), no table header-cell
   association beyond roles, no `AXAction` dispatch (press/scrollTo).
6. **No hit-test-by-point API** — AT "element at point" queries would invert
   the geometry index; the map is there but not exposed yet.
7. Shadow-DOM trees follow the DOM's flattened `parent` links where present
   (shadow roots are side-attached in the DOM model); slot-projection AX
   ordering is not separately modeled.
