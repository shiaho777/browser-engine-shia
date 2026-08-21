# dom-events vendored WPT files

These four files are UNMODIFIED official Web Platform Tests, copied from
web-platform-tests `dom/events/` (W3C 3-clause BSD license, see the WPT
repository root). They are vendored so the maintained `dom-events` subset runs
in CI without a WPT checkout:

- `AddEventListenerOptions-once.any.js`
- `Event-type.html`
- `EventTarget-add-remove-listener.any.js`
- `EventTarget-addEventListener.any.js`

The runner satisfies `/resources/testharness*.js` includes with its own
harness; these files have no other includes.
