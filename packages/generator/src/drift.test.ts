/**
 * drift.test.ts — the committed generated artifacts must match the data table.
 *
 * The `generated/*` files are committed so the build never depends on running
 * the generator first. This test is the guard that keeps them honest: it
 * re-runs `generate()` in memory and compares each emitted file byte-for-byte
 * against the committed copy on disk. If a data-table row changes without
 * re-running `npm run generate`, this fails — so committed code can never drift
 * from the declarative source of truth.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generate } from "./emit/generate.js";

/** Absolute path of `src/generated/`, resolved from this compiled test file. */
function generatedDir(): string {
  // Compiled to dist/drift.test.js; generated source dir is ../src/generated.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "src", "generated");
}

void test("committed generated/* files match the emitter output", async () => {
  const result = generate();
  assert.equal(result.ok, true, "generation must succeed for the committed tables");

  const dir = generatedDir();
  for (const file of result.files) {
    const committed = await readFile(path.join(dir, file.path), "utf8");
    assert.equal(
      committed,
      file.contents,
      `${file.path} is stale — re-run \`npm run generate\` to refresh committed output`,
    );
  }
});
