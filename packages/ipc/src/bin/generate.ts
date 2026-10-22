/**
 * bin/generate.ts — write `src/generated/protocol.ts` from the schema.
 *
 * Mirrors `packages/generator/src/bin/generate.ts`: emitted output is
 * committed, `drift.test.ts` proves it matches the schema. Run via
 * `npm run generate --workspace @browser-engine/ipc`.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { emitProtocol } from "../emit.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "..", "..", "src", "generated");

await mkdir(outDir, { recursive: true });
const target = path.join(outDir, "protocol.ts");
await writeFile(target, emitProtocol(), "utf8");
process.stdout.write(`generated ${target}\n`);
