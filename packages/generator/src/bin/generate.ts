/**
 * bin/generate.ts — write the generated artifacts to disk (design.md §4.2).
 *
 * Run via `npm run generate` (which builds first, then `node dist/bin/generate.js`).
 * It runs the isolated {@link generate} entry and writes every emitted file into
 * `packages/generator/src/generated/`. The files are committed to the repo so
 * the build never depends on generation order; `npm run generate` only needs to
 * be re-run when a data-table row changes, and the test suite proves the
 * committed output matches the table (`drift.test.ts`).
 *
 * Per Requirement 6.4 the two emission paths are independent: this writer writes
 * whatever succeeded and exits non-zero only if a path failed, naming which one.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generate } from "../emit/generate.js";

/** The absolute path of `packages/generator/src/generated/`. */
export function generatedDir(): string {
  // This module is compiled to dist/bin/generate.js; the source generated dir is
  // two levels up (dist/bin → dist → package root) then into src/generated.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "src", "generated");
}

/** Write all succeeding artifacts to the generated directory. */
async function main(): Promise<number> {
  const result = generate();
  const outDir = generatedDir();
  await mkdir(outDir, { recursive: true });

  for (const file of result.files) {
    const target = path.join(outDir, file.path);
    await writeFile(target, file.contents, "utf8");
    process.stdout.write(`generated ${path.relative(process.cwd(), target)}\n`);
  }

  if (!result.css.ok) {
    process.stderr.write(`CSS generation FAILED: ${result.css.error}\n`);
  }
  if (!result.dom.ok) {
    process.stderr.write(`DOM generation FAILED: ${result.dom.error}\n`);
  }
  return result.ok ? 0 : 1;
}

void main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
