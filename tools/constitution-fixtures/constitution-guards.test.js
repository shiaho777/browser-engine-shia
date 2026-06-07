/**
 * Constitution guards — "deliberate violation" proof (task 1.11).
 *
 * Run with: `node --test tools/constitution-fixtures/constitution-guards.test.js`
 * (wired into `npm run test:constitution`, part of `npm run ci`).
 *
 * design.md Phase 0 success criterion: "CI 能因'违反任一宪法条款'而红(用故意
 * 违例的 PR 验证守卫真的生效)". The earlier Phase 0 tasks put the guards in
 * place and proved them GREEN on a compliant codebase. This suite proves the
 * other half: each guard actually turns CI **red** for a real violating file,
 * while its compliant twin stays green.
 *
 * Three of the four constitution classes are proven here by linting real
 * fixture files through the ESLint Node API with the actual `local/*`
 * constitution rules:
 *   1. cross-stage import of an internal mutable type → `local/no-cross-stage-import`
 *      (Requirements 12.1, 12.7).
 *   2. unimplemented path returning a placeholder → `local/no-silent-stub`
 *      (Requirements 12.2; 5.1, 5.2).
 *
 * The remaining two classes are proven by their own co-located suites and
 * re-asserted here for a single "all four classes are rejected" checklist:
 *   3. manual stale-marking → packages/kernel/.../no-manual-stale-marking.test.ts
 *      (type-level + runtime; Requirement 12.3 / 2.3).
 *   4. WPT pass-count regression → packages/scoreboard/.../regression.test.ts
 *      (Requirement 10.2).
 *
 * The violation fixtures are parked under `tools/` (excluded from the real
 * build + lint via `eslint.config.js` `ignores: ["tools/**"]` and absent from
 * the tsconfig project), so they can NEVER turn the main CI red by accident.
 * This harness lints them ON PURPOSE and asserts the guard reports the expected
 * error — that is what makes "the guard truly bites" a tested fact rather than
 * a hope.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { Linter } from "eslint";
import tseslint from "typescript-eslint";

import local from "../eslint-rules/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (...segments) => path.join(HERE, "fixtures", ...segments);

const linter = new Linter();

/**
 * Flat config shared by every fixture lint: register the `local` constitution
 * plugin, use the typescript-eslint parser (the rules are purely syntactic — no
 * type information needed), and turn both constitution rules to "error". This
 * mirrors the real `eslint.config.js` rule surface.
 */
function configFor() {
  return {
    // The fixtures are `.ts` files; flat config only lints non-default
    // extensions when a config explicitly matches them, otherwise the Linter
    // reports "No matching configuration found". Match both .ts and .js so the
    // shared config applies to every fixture we feed it.
    files: ["**/*.ts", "**/*.tsx", "**/*.js"],
    plugins: { local },
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      "local/no-cross-stage-import": "error",
      "local/no-silent-stub": "error",
    },
  };
}

/** Lint a fixture file on disk and return ESLint's messages. */
function lintFixture(absPath) {
  const code = readFileSync(absPath, "utf8");
  return linter.verify(code, configFor(), { filename: absPath });
}

/** Collect the set of distinct ruleIds that fired. */
function ruleIdsOf(messages) {
  return new Set(messages.map((m) => m.ruleId));
}

/** Collect the set of distinct messageIds that fired (best-effort). */
function messageIdsOf(messages) {
  return new Set(messages.map((m) => m.messageId).filter(Boolean));
}

// ---------------------------------------------------------------------------
// Class 1 — cross-stage import of an internal mutable type (Req 12.1, 12.7)
// ---------------------------------------------------------------------------

void test("Class 1 (Req 12.1/12.7): a cross-stage import fixture turns the build RED", () => {
  const messages = lintFixture(
    fixture("cross-stage", "packages", "paint", "src", "import-internal.violation.ts"),
  );
  assert.ok(
    ruleIdsOf(messages).has("local/no-cross-stage-import"),
    `expected local/no-cross-stage-import to fire; got: ${JSON.stringify(messages)}`,
  );
  // The fixture commits FOUR cross-stage couplings (bare scoped import, internal
  // submodule import, `export … from`, and a deep relative escape) — each must
  // be flagged, not just one.
  const crossStage = messages.filter((m) => m.ruleId === "local/no-cross-stage-import");
  assert.ok(
    crossStage.length >= 4,
    `expected ≥ 4 cross-stage errors (one per violating import); got ${crossStage.length}`,
  );
  assert.ok(messageIdsOf(crossStage).has("crossStageImport"));
});

void test("Class 1 negative control: the IR-only (compliant) fixture stays GREEN", () => {
  const messages = lintFixture(
    fixture("cross-stage", "packages", "paint", "src", "import-ir.compliant.ts"),
  );
  assert.equal(
    messages.filter((m) => m.ruleId === "local/no-cross-stage-import").length,
    0,
    `compliant IR consumption must not be flagged; got: ${JSON.stringify(messages)}`,
  );
});

// ---------------------------------------------------------------------------
// Class 2 — unimplemented path returning a placeholder (Req 12.2; 5.1, 5.2)
// ---------------------------------------------------------------------------

void test("Class 2 (Req 12.2/5.2): a silent-stub fixture turns the build RED", () => {
  const messages = lintFixture(
    fixture("silent-stub", "packages", "cascade", "src", "placeholder-return.violation.ts"),
  );
  assert.ok(
    ruleIdsOf(messages).has("local/no-silent-stub"),
    `expected local/no-silent-stub to fire; got: ${JSON.stringify(messages)}`,
  );
  const stub = messages.filter((m) => m.ruleId === "local/no-silent-stub");
  const ids = messageIdsOf(stub);
  // The fixture exhibits all three failure shapes the rule catches.
  assert.ok(ids.has("placeholderReturn"), "placeholder-return stubs must be flagged (Req 5.2)");
  assert.ok(ids.has("missingNotImplemented"), "silent no-op stubs must be flagged");
  assert.ok(
    ids.has("useNotImplemented"),
    "a generic 'not implemented' Error must be redirected to NotImplemented (Req 5.1)",
  );
});

void test("Class 2 negative control: the NotImplemented-throwing (compliant) fixture stays GREEN", () => {
  const messages = lintFixture(
    fixture("silent-stub", "packages", "cascade", "src", "throws-not-implemented.compliant.ts"),
  );
  assert.equal(
    messages.filter((m) => m.ruleId === "local/no-silent-stub").length,
    0,
    `loud NotImplemented failures must not be flagged; got: ${JSON.stringify(messages)}`,
  );
});

// ---------------------------------------------------------------------------
// Classes 3 & 4 — checklist re-assertion (full proofs in co-located suites)
// ---------------------------------------------------------------------------

void test("Class 3 (Req 2.3/12.3): the kernel exposes no manual stale-marking API", async () => {
  // Import the BUILT kernel so this checklist item is self-contained. (The
  // exhaustive proof — including the type-level `keyof Db` equality that makes a
  // manual-invalidation method fail to compile — lives in
  // packages/kernel/src/no-manual-stale-marking.test.ts.)
  const { NaiveDb } = await import("../../packages/kernel/dist/index.js");
  const db = new NaiveDb();
  const surface = db;
  // A manual dirty-bit surface (set-stale here, consume-it-there) is exactly
  // the v0 bug class the kernel design forbids: invalidation is the kernel's
  // own job (Req 2.3). None of these members may exist.
  for (const forbidden of ["invalidate", "markStale", "setDirty", "bump", "markDirty"]) {
    assert.equal(
      forbidden in db,
      false,
      `manual stale-marking member must not exist on the Db: ${forbidden}`,
    );
    assert.equal(typeof surface[forbidden], "undefined", `unexpected ${forbidden} API`);
  }
  // Positive control: the sanctioned read/write surface IS present.
  for (const sanctioned of ["getInput", "query", "setInput"]) {
    assert.equal(typeof surface[sanctioned], "function", `expected Db.${sanctioned} to exist`);
  }
});

void test("Class 4 (Req 10.2): a WPT pass-count regression is blocked by the gate", async () => {
  // Import the BUILT scoreboard gate so this checklist item is self-contained.
  // (The exhaustive proof — including the runner-fed end-to-end case and the
  //  fast-check property — lives in packages/scoreboard/src/regression.test.ts.)
  const { checkWptRegression } = await import(
    "../../packages/scoreboard/dist/regression.js"
  );
  assert.equal(
    checkWptRegression(10, 7).blocked,
    true,
    "a candidate below the baseline must block the merge (Req 10.2)",
  );
  assert.equal(checkWptRegression(10, 10).blocked, false, "flat is allowed");
  assert.equal(checkWptRegression(10, 12).blocked, false, "forward progress is allowed");
});
