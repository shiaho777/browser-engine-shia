/**
 * Tests for `local/no-cross-stage-import` (task 1.4).
 *
 * Run with: `node --test tools/eslint-rules`
 *
 * Uses ESLint's flat-config RuleTester. Covers the constitution requirements:
 *   - 3.2: a downstream stage leaves upstream IR unchanged — enforced by
 *          forbidding it from importing another stage's internal (mutable)
 *          modules; it may only consume the frozen IR.
 *   - 12.1: code that imports an internal mutable type across a stage boundary
 *           fails the build (lint error).
 *   - 12.7: the prohibition keys off the package directory, so it keeps
 *           enforcing for any package added in later Phases.
 *
 * RuleTester needs a real-looking absolute `filename` so the rule can tell
 * which stage package the linted file belongs to. We synthesise paths under a
 * fake workspace `packages/<stage>/src/...`.
 */
import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import rule from "./no-cross-stage-import.js";

const ROOT = "/repo/packages";
const file = (stage, name = "index.ts") => `${ROOT}/${stage}/src/${name}`;

// The linted files are TypeScript (e.g. `import type …`). The rule itself is
// purely syntactic (no type information), so the typescript-eslint parser is
// used here only to accept TS syntax — no `parserOptions.project` is needed.
const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

ruleTester.run("no-cross-stage-import", rule, {
  valid: [
    // A stage consuming the frozen IR — the ONE sanctioned channel (Req 3.2).
    {
      filename: file("layout"),
      code: `import type { FragmentTree, ComputedStyle } from "@browser-engine/ir";`,
    },
    // A stage importing a deep path *within the IR* package is still fine.
    {
      filename: file("paint"),
      code: `import { deepFreeze } from "@browser-engine/ir";`,
    },
    // A stage importing a non-stage / infrastructure package (kernel) is fine —
    // the kernel is the query substrate, not a pipeline stage.
    {
      filename: file("cascade"),
      code: `import { define } from "@browser-engine/kernel";`,
    },
    // A stage importing its OWN modules by relative path is fine.
    {
      filename: file("layout", "block.ts"),
      code: `import { layoutInline } from "./inline.js";`,
    },
    // A stage importing its own modules from a sibling dir within itself.
    {
      filename: file("cascade", "engine/cascade.ts"),
      code: `import { ruleIndex } from "../index/rule-index.js";`,
    },
    // Third-party + node builtins are untouched.
    {
      filename: file("html-parser"),
      code: `
        import * as fc from "fast-check";
        import path from "node:path";
      `,
    },
    // Orchestration code that is NOT a stage (cli) may wire stages together —
    // composing the pipeline is its job.
    {
      filename: `${ROOT}/cli/src/index.ts`,
      code: `
        import { qLayout } from "@browser-engine/layout";
        import { qPaint } from "@browser-engine/paint";
        import { qDom } from "@browser-engine/html-parser";
      `,
    },
    // Files entirely outside any package (e.g. a root script) are untouched.
    {
      filename: "/repo/scripts/build.ts",
      code: `import { qLayout } from "@browser-engine/layout";`,
    },
    // A stage importing the SAME stage by its scoped self-name is allowed.
    {
      filename: file("layout"),
      code: `import { helper } from "@browser-engine/layout/helpers";`,
    },
  ],

  invalid: [
    // paint (downstream) reaching back into layout's internals by bare scoped
    // specifier (Req 12.1 / bug#2 reverse read).
    {
      filename: file("paint"),
      code: `import { internalBox } from "@browser-engine/layout";`,
      errors: [{ messageId: "crossStageImport" }],
    },
    // Reaching into a stage's *internal* submodule (the mutable type leak the
    // rule exists to stop).
    {
      filename: file("paint"),
      code: `import { MutableBox } from "@browser-engine/layout/src/internal";`,
      errors: [{ messageId: "crossStageImport" }],
    },
    // Cascade importing css-parser's internals across the stage boundary.
    {
      filename: file("cascade"),
      code: `import type { ParserState } from "@browser-engine/css-parser";`,
      errors: [{ messageId: "crossStageImport" }],
    },
    // Relative path that escapes the current stage and dives into another
    // stage's source tree.
    {
      filename: file("paint", "paint.ts"),
      code: `import { MutableBox } from "../../layout/src/internal.js";`,
      errors: [{ messageId: "crossStageImport" }],
    },
    // `export … from` another stage is just as much a cross-stage coupling.
    {
      filename: file("backend"),
      code: `export { Fragment } from "@browser-engine/layout";`,
      errors: [{ messageId: "crossStageImport" }],
    },
    // `export * from` another stage.
    {
      filename: file("backend"),
      code: `export * from "@browser-engine/paint";`,
      errors: [{ messageId: "crossStageImport" }],
    },
    // Dynamic `import()` of another stage.
    {
      filename: file("layout"),
      code: `const m = import("@browser-engine/cascade");`,
      errors: [{ messageId: "crossStageImport" }],
    },
    // `require()` of another stage (defensive CJS guard).
    {
      filename: file("layout"),
      code: `const css = require("@browser-engine/css-parser");`,
      errors: [{ messageId: "crossStageImport" }],
    },
  ],
});

// node:test harness: RuleTester.run executes assertions eagerly above, but wrap
// in a test so `node --test` reports a passing test and non-zero exit on throw.
import { test } from "node:test";
test("no-cross-stage-import rule passes RuleTester valid/invalid suites", () => {});
