# dom-abort vendored WPT files

These files are UNMODIFIED official Web Platform Tests, copied from
web-platform-tests `dom/abort/` (W3C 3-clause BSD license, see the WPT
repository root). They are vendored so the maintained `dom-abort` subset runs
in CI without a WPT checkout:

- `AbortSignal.any.js`
- `abort-signal-any.any.js` (with `resources/abort-signal-any-tests.js`)
- `event.any.js`
- `timeout.any.js`

The two iframe-based files from the same directory
(`abort-signal-timeout.html`, `reason-constructor.html`) are NOT vendored:
they require multi-document testing this engine does not provide yet.

The runner satisfies `/resources/testharness*.js` includes with its own
harness and `META: script=` includes from the vendored `resources/` directory.
