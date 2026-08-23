# dom-events vendored WPT files

These files are UNMODIFIED official Web Platform Tests, copied from
web-platform-tests `dom/events/` (W3C 3-clause BSD license, see the WPT
repository root). They are vendored so the maintained `dom-events` subset runs
in CI without a WPT checkout:

- `AddEventListenerOptions-once.any.js`
- `CustomEvent.html`
- `Event-constructors.any.js`
- `Event-defaultPrevented-after-dispatch.html`
- `Event-defaultPrevented.html`
- `Event-dispatch-bubble-canceled.html`
- `Event-dispatch-detached-click.html`
- `Event-dispatch-propagation-stopped.html`
- `Event-returnValue.html`
- `Event-type.html`
- `EventTarget-add-remove-listener.any.js`
- `EventTarget-addEventListener.any.js`
- `EventTarget-dispatchEvent-returnvalue.html`
- `EventTarget-dispatchEvent-returnvalue.html`
- `Event-subclasses-constructors.html`

The runner satisfies `/resources/testharness*.js` includes with its own
harness; these files have no other includes.

## dom-collections

`dom/collections/HTMLCollection-empty-name.html` is likewise an UNMODIFIED
official WPT file (same license), vendored for the `dom-collections` subset.
The other files from the official `dom/collections/` directory are not yet
vendored: they exercise deeper WebIDL platform-object semantics (expando
shadowing on [OverrideBuiltins] objects, prototype tricks, exact own-property
enumeration) that this engine does not implement yet.
