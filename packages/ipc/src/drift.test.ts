/**
 * drift.test.ts — the committed generated artifact must match the schema.
 *
 * Mirrors packages/generator's drift guard: this re-runs the emitter in
 * memory and compares byte-for-byte against the committed copy on disk, so
 * committed code can never drift from the declarative protocol table.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { emitProtocol } from "./emit.js";

void test("committed generated/protocol.ts matches the emitter output", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const committed = await readFile(path.resolve(here, "..", "src", "generated", "protocol.ts"), "utf8");
  assert.equal(
    committed,
    emitProtocol(),
    "protocol.ts is stale — re-run `npm run generate --workspace @browser-engine/ipc`",
  );
});
