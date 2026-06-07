/**
 * Tests for `local/no-silent-stub` (task 1.3).
 *
 * Run with: `node --test tools/eslint-rules`
 *
 * Uses ESLint's flat-config RuleTester. Covers the constitution requirements:
 *   - 5.1: unimplemented paths throw NotImplemented identifying the feature.
 *   - 5.2 / 12.2: a stub returning a placeholder is rejected.
 *   - 5.3: a path that throws NotImplemented is allowed.
 */
import { RuleTester } from "eslint";
import rule from "./no-silent-stub.js";

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

ruleTester.run("no-silent-stub", rule, {
  valid: [
    // Marked stub that throws NotImplemented (Requirement 5.3).
    {
      code: `
        // @stub
        function widthOf(style) {
          throw new NotImplemented("css-property:width", { category: "css-property" });
        }
      `,
    },
    // Marked stub using the notImplemented() helper.
    {
      code: `
        /** @unimplemented */
        function gridLayout(box) {
          notImplemented("layout-mode:grid");
        }
      `,
    },
    // Arrow stub that calls notImplemented.
    {
      code: `
        // @not-implemented
        const fetchImpl = () => notImplemented("dom-api:fetch");
      `,
    },
    // return notImplemented(...) — returns never, still loud.
    {
      code: `
        // TODO: implement
        function colorOf(s) {
          return notImplemented("css-property:color");
        }
      `,
    },
    // Unmarked, ordinary function returning a real value is untouched.
    {
      code: `
        function add(a, b) {
          return a + b;
        }
      `,
    },
    // Marked stub whose inner closure returns a value — the inner return must
    // NOT be attributed to the outer stub, which itself throws.
    {
      code: `
        // @stub
        function makeHandler() {
          throw new NotImplemented("dom-api:makeHandler");
          const inner = () => 42;
        }
      `,
    },
    // A genuine, non-stub Error that merely mentions an unrelated word.
    {
      code: `
        function validate(x) {
          if (!x) throw new Error("missing argument");
          return x;
        }
      `,
    },
  ],

  invalid: [
    // Stub returning a placeholder value (Requirement 5.2 / 12.2).
    {
      code: `
        // @stub
        function fetchImpl(url) {
          return { status: 404 };
        }
      `,
      errors: [{ messageId: "placeholderReturn" }],
    },
    // Stub returning a fake primitive.
    {
      code: `
        // @unimplemented
        function getComputedWidth() {
          return 0;
        }
      `,
      errors: [{ messageId: "placeholderReturn" }],
    },
    // Arrow stub with a placeholder expression body.
    {
      code: `
        // @stub
        const location = () => ({ href: "about:blank" });
      `,
      errors: [{ messageId: "placeholderReturn" }],
    },
    // Marked stub that neither throws NotImplemented nor returns: silent no-op
    // (e.g. v0's empty focus/blur).
    {
      code: `
        // @stub
        function focus() {
        }
      `,
      errors: [{ messageId: "missingNotImplemented" }],
    },
    // Generic Error announcing "not implemented" instead of NotImplemented
    // (Requirement 5.1).
    {
      code: `
        function paint(cmd) {
          throw new Error("not implemented yet");
        }
      `,
      errors: [{ messageId: "useNotImplemented" }],
    },
  ],
});

// node:test harness: RuleTester.run executes assertions eagerly above, but wrap
// in a test so `node --test` reports a passing test and non-zero exit on throw.
import { test } from "node:test";
test("no-silent-stub rule passes RuleTester valid/invalid suites", () => {});
