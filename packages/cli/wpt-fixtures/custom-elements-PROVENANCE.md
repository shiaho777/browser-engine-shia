# custom-elements and shadow-dom vendored WPT files

These files are unmodified official Web Platform Tests, copied from
web-platform-tests (W3C 3-clause BSD license, see the WPT repository root).
They are vendored so the maintained subsets run in CI without a WPT checkout.

`custom-elements`:

- `form-associated/focusability.html`
- `reactions/AriaMixin-string-attributes.html` (plus `reactions/resources/reactions.js` and `resources/custom-elements-helpers.js`)
- `registries/valid-custom-element-names.html`

`shadow-dom`:

- `slots-outside-shadow-dom.html`

The runner supplies `testharness.js`. These files have no other includes.
The rest of the official directories are not vendored yet: scoped registries,
customized built-in construction, declarative shadow DOM, and `referenceTarget`
still fail.
