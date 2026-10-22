# RFC 0011: Activation Behavior & Form Submission — Real Navigation Entry Points

- **Status**: Implemented
- **Depends on**: RFC 0010 (navigation/session)

## Problem

RFC 0010 gave the session a real navigation engine — but nothing real drives
it. Two entry points remain fake:

| Real browser | Current state |
|---|---|
| Clicking `<a href>` dispatches `click`, runs listeners, then activates → navigates | Guest `el.click()` only handles `#hash` links; host `clickAt` **bypasses the DOM entirely** — hit-test → href → navigate, no `click` event, `preventDefault` ignored |
| `<form>` submission collects controls, encodes, navigates GET/POST | `submit`/`reset` events dispatch but **nothing is collected or sent**; `form.submit()`/`requestSubmit()` don't exist |

The result: `preventDefault()` on a click cannot stop navigation, click
listeners never observe UI clicks, and the single most common navigation path
on the web — link activation — only works for fragment hops.

## Design

### One activation path for both click sources

HTML's model: a click (from user input OR `el.click()`) dispatches a `click`
event through the DOM; when not canceled, the **activation behavior** of the
nearest activating ancestor runs. We adopt it literally:

- `buildDocumentApi` gains a `navigator` sink
  (`(url, opts: {replace?, target?, method?, body?, contentType?}) => void`).
  In the real path it is wired to the `SessionHost` — activation queues a
  `NavigationIntent` drained after the task, exactly like `location.assign`.
- `runActivationBehavior`'s `a`/`area` branch resolves `href` against the
  document URL and calls the sink. `href`-less `<a>` has no activation
  behavior (spec) — the walk continues up the ancestor chain.
- `PageRuntime` gains `clickElement(nodeId)`/`dispatchElementEvent(nodeId,
  type)`: the host's `clickAt` hit-tests, then routes the click **through the
  live sandbox** (listeners + `preventDefault` honored) instead of shortcutting
  to navigation. Pages without a live runtime keep the direct-fallback path —
  with no listeners there is nothing to consult.

### Anchor semantics

- `target`: absent/`_self` → same context; `_blank` → host `openInNewTab`
  callback when provided (tab strip integration), else same context;
  `_parent`/`_top` resolve to the root context of the frame tree
  (RFC 0013).
- `download`: same-origin targets are saved to `downloadsDir` (RFC 0010's
  download subsystem); cross-origin or unsinked downloads still suppress
  navigation per spec.

### Form submission (HTML §4.10.21)

Activation of a submit button/input → `submitForm(form, submitter)`:

1. Dispatch `submit` (bubbles, cancelable) — canceled ⇒ abort. `form.submit()`
   skips the event per spec; `requestSubmit()` runs it.
2. Collect **successful controls** (descendants + `form=`-associated):
   named, non-disabled inputs/textarea/select; unchecked checkboxes/radios
   excluded; only the activating submitter among submit buttons.
   Values read the live control state (`checked` overrides attrs; text fields
   read the `value` attr — the same store `applyTextEdit` writes).
3. Encode `application/x-www-form-urlencoded` (or `text/plain`); submitter
   `formaction`/`formmethod`/`formenctype` override the form's.
4. `method=get` → query appended to `action` (default: document URL);
   `method=post` → body + Content-Type on the navigation request.
   `NavigationIntent.navigate` and `loadPage` gain `method`/`body`/`contentType`
   so a POST is a real POST through the owned redirect loop (303 → GET already
   handled by RFC 0009).

`reset` activation → `reset` event + control state restored to attribute
defaults (checked/value state cleared back to markup).

## Honest boundaries

- No constraint validation (`required`, `:invalid`) — submission never blocks
  on validity.
- `multipart/form-data` bodies fall back to urlencoded; `method=dialog` is a
  no-op.
- `window.open`/`showModalDialog` are not entry points yet.
- UI text input remains host-driven (`commitText`); guest-side `input.value`
  setters are out of scope.

## Tests

`node:test` + `node:http`: link click → navigation with Referer; click-listener
`preventDefault` blocks navigation; `target=_blank` reaches the new-tab hook;
GET form submission encodes controls into the URL; POST sends body +
Content-Type; `form.submit()` skips the submit event, `requestSubmit()` fires
it; submitter overrides win; reset restores control state.
