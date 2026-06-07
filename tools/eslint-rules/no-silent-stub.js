/**
 * ESLint rule: `local/no-silent-stub`
 *
 * Constitution rule for design.md §2 bug#4 / §12 and Requirements 5.1, 5.2,
 * 5.3, 12.2. v0 rotted because "wired but not connected" stubs (fetch → 404,
 * fake location, empty focus/blur) silently masqueraded as working features.
 *
 * This rule makes that physically impossible to merge:
 *
 *   1. A function explicitly marked as a stub (via a marker comment such as
 *      `@stub`, `@unimplemented`, `@not-implemented`, or `TODO: implement`)
 *      MUST signal a loud failure — `throw new NotImplemented(...)` or
 *      `notImplemented(...)` — and MUST NOT return a placeholder/fake value
 *      (Requirements 5.1, 5.2, 12.2). A marked stub that throws NotImplemented
 *      and returns nothing is allowed (Requirement 5.3).
 *
 *   2. Anywhere, a "not implemented"-style failure expressed as a generic
 *      `throw new Error("...not implemented...")` is rejected: unimplemented
 *      paths must throw the sanctioned `NotImplemented` error so the Scoreboard
 *      can identify the missing capability (Requirement 5.1).
 *
 * The rule is purely syntactic (no type information required), so it runs fast
 * and is trivial to unit-test with RuleTester.
 *
 * @type {import("eslint").Rule.RuleModule}
 */

/** Comment markers that declare a function body as an intentional stub. */
const STUB_MARKER =
  /@stub\b|@unimplemented\b|@not-?implemented\b|\b(?:TODO|FIXME)\b[\s:-]*implement/i;

/** Message fragments that betray a hand-rolled "not implemented" error. */
const FAKE_NOT_IMPLEMENTED_MESSAGE =
  /not[\s_-]?implemented|unimplemented|\bstub\b|\bTODO\b|\bFIXME\b/i;

/** The sanctioned error class and helper names (see packages/ir). */
const NOT_IMPLEMENTED_CLASS = "NotImplemented";
const NOT_IMPLEMENTED_FN = "notImplemented";

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

/**
 * @param {import("estree").Node | null | undefined} node
 * @returns {boolean}
 */
function isFunctionNode(node) {
  return node != null && FUNCTION_TYPES.has(node.type);
}

/**
 * Resolve the simple name of a call/new callee, handling both `foo(...)` and
 * `ns.foo(...)` / `new ns.Foo(...)`.
 *
 * @param {any} callee
 * @returns {string | null}
 */
function calleeName(callee) {
  if (!callee) return null;
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && !callee.computed) {
    return callee.property && callee.property.type === "Identifier"
      ? callee.property.name
      : null;
  }
  return null;
}

/** @param {any} node */
function isNotImplementedNew(node) {
  return (
    node &&
    node.type === "NewExpression" &&
    calleeName(node.callee) === NOT_IMPLEMENTED_CLASS
  );
}

/** @param {any} node */
function isNotImplementedCall(node) {
  return (
    node &&
    node.type === "CallExpression" &&
    calleeName(node.callee) === NOT_IMPLEMENTED_FN
  );
}

/** Extract a static string from a Literal / TemplateLiteral, else null. */
function staticString(node) {
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "TemplateLiteral") {
    return node.quasis.map((q) => q.value.cooked ?? q.value.raw).join(" ");
  }
  return null;
}

/**
 * Recursively visit descendants of `node` WITHOUT entering nested function
 * scopes, so that returns/throws belonging to inner closures are not
 * attributed to the outer function.
 *
 * @param {any} node
 * @param {(child: any) => void} onNode
 */
function walkOwn(node, onNode) {
  for (const key of Object.keys(node)) {
    if (key === "parent") continue;
    const value = /** @type {any} */ (node)[key];
    if (Array.isArray(value)) {
      for (const child of value) visitChild(child, onNode);
    } else {
      visitChild(value, onNode);
    }
  }
}

/**
 * @param {any} child
 * @param {(child: any) => void} onNode
 */
function visitChild(child, onNode) {
  if (!child || typeof child.type !== "string") return;
  // Stop at nested function boundaries — their returns/throws are their own.
  if (isFunctionNode(child)) return;
  onNode(child);
  walkOwn(child, onNode);
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Unimplemented paths must throw NotImplemented and must never return a placeholder value.",
      recommended: true,
    },
    schema: [],
    messages: {
      placeholderReturn:
        "Unimplemented stub returns a placeholder value. An unimplemented path must `throw new NotImplemented(<feature>)` (or call `notImplemented(<feature>)`), never return a fake value.",
      missingNotImplemented:
        "Function is marked as an unimplemented stub but never throws NotImplemented. Replace the body with `throw new NotImplemented(<feature>)` or `notImplemented(<feature>)`.",
      useNotImplemented:
        "Use `throw new NotImplemented(<feature>)` for unimplemented paths instead of a generic Error, so the missing capability is identified and the scoreboard can mark it not implemented.",
    },
  },

  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    const allComments = sourceCode.getAllComments();

    /**
     * Does any comment inside the function body, immediately before the
     * function, or before its enclosing statement, carry a stub marker?
     *
     * @param {any} fn
     */
    function hasStubMarker(fn) {
      // (a) comments physically inside the function node's range.
      for (const comment of allComments) {
        if (
          comment.range[0] >= fn.range[0] &&
          comment.range[1] <= fn.range[1] &&
          STUB_MARKER.test(comment.value)
        ) {
          return true;
        }
      }
      // (b) comments directly before the function node.
      for (const comment of sourceCode.getCommentsBefore(fn)) {
        if (STUB_MARKER.test(comment.value)) return true;
      }
      // (c) comments before the enclosing statement (covers `// @stub` above a
      //     `const f = () => {...}` or a class method / exported declaration).
      let stmt = fn.parent;
      while (
        stmt &&
        stmt.type !== "VariableDeclaration" &&
        stmt.type !== "Property" &&
        stmt.type !== "MethodDefinition" &&
        stmt.type !== "PropertyDefinition" &&
        stmt.type !== "ExportNamedDeclaration" &&
        stmt.type !== "ExportDefaultDeclaration"
      ) {
        // Only climb across expression wrappers, not across other statements.
        if (
          stmt.type.endsWith("Statement") ||
          stmt.type === "Program"
        ) {
          break;
        }
        stmt = stmt.parent;
      }
      if (stmt && stmt !== fn) {
        for (const comment of sourceCode.getCommentsBefore(stmt)) {
          if (STUB_MARKER.test(comment.value)) return true;
        }
      }
      return false;
    }

    /**
     * Analyse a marked stub function for placeholder returns and loud failures.
     *
     * @param {any} fn
     */
    function analyzeStub(fn) {
      const body = fn.body;

      // Arrow with an expression body: `() => expr`.
      if (fn.type === "ArrowFunctionExpression" && body.type !== "BlockStatement") {
        if (isNotImplementedCall(body)) return; // `() => notImplemented(...)` ✓
        context.report({ node: body, messageId: "placeholderReturn" });
        return;
      }

      let firstPlaceholderReturn = null;
      let loud = false;

      const inspect = (node) => {
        if (node.type === "ThrowStatement") {
          if (isNotImplementedNew(node.argument) || isNotImplementedCall(node.argument)) {
            loud = true;
          }
          return;
        }
        if (isNotImplementedCall(node)) {
          loud = true;
          return;
        }
        if (node.type === "ReturnStatement") {
          if (node.argument == null) return; // bare `return;` is not a value.
          if (isNotImplementedCall(node.argument)) {
            loud = true; // `return notImplemented(...)` ✓ (returns `never`).
            return;
          }
          if (firstPlaceholderReturn == null) firstPlaceholderReturn = node;
        }
      };

      walkOwn(body, inspect);

      if (firstPlaceholderReturn != null) {
        context.report({ node: firstPlaceholderReturn, messageId: "placeholderReturn" });
        return;
      }
      if (!loud) {
        context.report({ node: fn, messageId: "missingNotImplemented" });
      }
    }

    /** @param {any} fn */
    function checkFunction(fn) {
      if (hasStubMarker(fn)) analyzeStub(fn);
    }

    return {
      FunctionDeclaration: checkFunction,
      FunctionExpression: checkFunction,
      ArrowFunctionExpression: checkFunction,

      // Independent of markers: a generic Error that announces it is "not
      // implemented" must become a real NotImplemented (Requirement 5.1).
      ThrowStatement(node) {
        const arg = node.argument;
        if (!arg || arg.type !== "NewExpression") return;
        const name = calleeName(arg.callee);
        if (name == null || name === NOT_IMPLEMENTED_CLASS) return;
        if (!name.endsWith("Error")) return;
        const message = arg.arguments.length > 0 ? staticString(arg.arguments[0]) : null;
        if (message != null && FAKE_NOT_IMPLEMENTED_MESSAGE.test(message)) {
          context.report({ node, messageId: "useNotImplemented" });
        }
      },
    };
  },
};
