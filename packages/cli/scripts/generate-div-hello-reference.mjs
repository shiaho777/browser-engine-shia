/**
 * One-off generator for the committed `<div>hello</div>` reftest reference PNG
 * (task 3.12, Requirement 14.3).
 *
 * The Phase 1 pipeline is deterministic, so the reference image IS the rendered
 * output captured once and committed. Re-run this script (after a deliberate,
 * reviewed rendering change) to regenerate the baseline:
 *
 *   node packages/cli/scripts/generate-div-hello-reference.mjs
 *
 * It writes `packages/cli/reftests/div-hello.png`, which `phase1.ts` loads at
 * check time and compares a fresh render against within the configured pixel
 * threshold (an exact 0-pixel match, given determinism).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { renderHtmlToPng } from "../dist/render.js";

const source = new TextEncoder().encode("<div>hello</div>");
const { png, width, height } = renderHtmlToPng(source);

const outPath = fileURLToPath(new URL("../reftests/div-hello.png", import.meta.url));
mkdirSync(fileURLToPath(new URL("../reftests/", import.meta.url)), { recursive: true });
writeFileSync(outPath, png);

console.log(`wrote ${outPath} (${width}x${height}, ${png.length} bytes)`);
