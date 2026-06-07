/**
 * ESLint rule: `local/no-cross-stage-import`
 *
 * Constitution rule for design.md §2 bug#2 / §3.C / §6 and Requirements 3.2,
 * 12.1, 12.7. v0 rotted because `getBoundingClientRect` reached *across* a
 * stage boundary and read the wrong field (`S_COMPUTED_STYLE._layoutBox`
 * instead of `S_LAYOUT_BOX`): stages shared mutable handles, so "cross-stage
 * reverse reads" and "wrong-field reads" were always one typo away.
 *
 * The architecture's answer (design.md §4 / §6) is a single-direction,
 * compiler-style pipeline whose stages communicate ONLY through the frozen,
 * nominally-branded IR in `@browser-engine/ir`:
 *
 *     html-parser → css-parser → cascade → layout → paint → backend
 *                         (each stage: a pure function of its upstream *IR*)
 *
 * A stage must never import another stage package — doing so would hand it that
 * stage's *internal mutable* types/handles instead of the read-only frozen IR.
 * The only sanctioned inter-stage channel is `@browser-engine/ir`.
 *
 * This rule makes that boundary physically un-mergeable (CI fails — Req 12.1):
 *
 *   - A file that lives inside a stage package MUST NOT import (static `import`,
 *     `import type`, dynamic `import()`, `require`, or `export … from`) any
 *     *other* stage package — neither by bare specifier
 *     (`@browser-engine/layout`, `@browser-engine/layout/src/internal`) nor by a
 *     relative path that escapes into another stage's directory
 *     (`../../layout/src/internal`).
 *
 *   - Importing the frozen IR (`@browser-engine/ir`), the incremental kernel,
 *     or any other non-stage / infrastructure package is allowed — that is how
 *     stages legally consume upstream output. So is importing a stage's *own*
 *     modules (relative or self-named).
 *
 *   - Orchestration / wiring layers that are NOT themselves stages (cli,
 *     kernel, generator, scoreboard, test-harness, …) are free to import stage
 *     packages: composing the pipeline is their job. The prohibition is
 *     specifically stage → other-stage, which is the cross-stage "偷读".
 *
 * Because the rule keys off the *directory* a file lives in, it keeps enforcing
 * the boundary for every package added in any later Phase, with zero new
 * configuration (Requirement 12.7).
 *
 * The rule is purely syntactic (no type information required): it inspects
 * import specifiers and the linted file's path, so it runs fast and is trivial
 * to unit-test with RuleTester.
 *
 * @type {import("eslint").Rule.RuleModule}
 */
import path from "node:path";

/** npm scope shared by every workspace package (see packages/*\/package.json). */
const DEFAULT_SCOPE = "@browser-engine";

/**
 * The pipeline *stages* (design.md §4.1). Each owns exactly one output IR and
 * may only talk to its neighbours through the frozen IR. These are directory /
 * unscoped-package names so the rule works whether code refers to a stage by
 * its scoped name (`@browser-engine/layout`) or by a relative path that lands
 * in `packages/layout/`.
 */
const DEFAULT_STAGES = [
  "html-parser", // → DomTree IR
  "css-parser", //  → StyleSheet IR
  "cascade", //     → ComputedStyle IR
  "layout", //      → FragmentTree IR (sole geometry source)
  "paint", //       → DisplayList IR
  "backend", //     → pixels / vector (consumes DisplayList only)
];

/** The one sanctioned inter-stage channel (frozen, branded IR). */
const DEFAULT_IR_PACKAGE = "ir";

/** Normalise a filesystem path to forward slashes for stable matching. */
function toPosix(p) {
  return p.replace(/\\/g, "/");
}

/**
 * Extract the workspace package directory name from any absolute/normalised
 * path that contains a `.../packages/<name>/...` segment, else null.
 *
 * @param {string} p
 * @returns {string | null}
 */
function packageDirOf(p) {
  const match = /(?:^|\/)packages\/([^/]+)(?:\/|$)/.exec(toPosix(p));
  return match ? match[1] : null;
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Pipeline stages must communicate only through the frozen IR; a stage must not import another stage's internal (mutable) modules across the stage boundary.",
      recommended: true,
    },
    schema: [
      {
        type: "object",
        properties: {
          // npm scope of the monorepo packages.
          scope: { type: "string" },
          // Unscoped names of the pipeline-stage packages.
          stages: {
            type: "array",
            items: { type: "string" },
            uniqueItems: true,
          },
          // Unscoped name of the sanctioned frozen-IR package.
          irPackage: { type: "string" },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      crossStageImport:
        "Cross-stage import: stage `{{from}}` must not import stage `{{to}}`. Pipeline stages communicate only through the frozen IR (`{{scope}}/{{ir}}`); importing another stage exposes its internal mutable types and reintroduces cross-stage reverse reads.",
    },
  },

  create(context) {
    const options = context.options[0] ?? {};
    const scope = options.scope ?? DEFAULT_SCOPE;
    const stages = new Set(options.stages ?? DEFAULT_STAGES);
    const irPackage = options.irPackage ?? DEFAULT_IR_PACKAGE;
    const scopePrefix = `${scope}/`;

    const filename = context.filename ?? context.getFilename();

    // Which stage (if any) does the *current* file belong to? If the file is
    // not inside a stage package, this rule has nothing to enforce (e.g. cli /
    // kernel / generator orchestration code may freely wire stages together).
    const fromStage = (() => {
      const dir = packageDirOf(filename);
      return dir != null && stages.has(dir) ? dir : null;
    })();

    if (fromStage == null) {
      return {}; // not a stage file → no cross-stage boundary to police here.
    }

    const fileDir = path.dirname(filename);

    /**
     * Resolve which stage package a specifier targets, or null if it does not
     * target a stage (own package, IR, kernel, node builtin, third-party, …).
     *
     * @param {string} spec the import/require specifier
     * @returns {string | null} the targeted stage's unscoped name, or null
     */
    function targetStageOf(spec) {
      if (typeof spec !== "string" || spec.length === 0) return null;

      // Scoped workspace specifier: `@browser-engine/<name>[/subpath]`.
      if (spec.startsWith(scopePrefix)) {
        const pkg = spec.slice(scopePrefix.length).split("/")[0];
        if (pkg === irPackage) return null; // the sanctioned IR channel.
        return stages.has(pkg) ? pkg : null;
      }

      // Relative specifier: resolve against the file's directory and see if it
      // escapes into another `packages/<stage>/` tree (a deep "偷读").
      if (spec.startsWith("./") || spec.startsWith("../")) {
        const resolved = path.resolve(fileDir, spec);
        const dir = packageDirOf(resolved);
        return dir != null && stages.has(dir) ? dir : null;
      }

      // Bare third-party / node builtin specifier → not a stage.
      return null;
    }

    /**
     * Flag `node` if `spec` reaches a *different* stage than the current file.
     *
     * @param {import("estree").Node} node node to attach the report to
     * @param {unknown} spec the specifier value
     */
    function check(node, spec) {
      if (typeof spec !== "string") return;
      const toStage = targetStageOf(spec);
      if (toStage != null && toStage !== fromStage) {
        context.report({
          node,
          messageId: "crossStageImport",
          data: { from: fromStage, to: toStage, scope, ir: irPackage },
        });
      }
    }

    return {
      // `import … from "x"` / `import type … from "x"`.
      ImportDeclaration(node) {
        check(node.source, node.source.value);
      },
      // `export … from "x"`.
      ExportNamedDeclaration(node) {
        if (node.source) check(node.source, node.source.value);
      },
      // `export * from "x"`.
      ExportAllDeclaration(node) {
        if (node.source) check(node.source, node.source.value);
      },
      // `import("x")` with a static string argument.
      ImportExpression(node) {
        if (node.source && node.source.type === "Literal") {
          check(node.source, node.source.value);
        }
      },
      // `require("x")` (defensive — repo is ESM, but cheap to guard).
      CallExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "require" &&
          node.arguments.length === 1 &&
          node.arguments[0].type === "Literal"
        ) {
          check(node.arguments[0], node.arguments[0].value);
        }
      },
    };
  },
};
