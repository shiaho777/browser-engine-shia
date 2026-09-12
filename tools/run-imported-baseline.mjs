/**
 * run-imported-baseline.mjs — run every manifest in wpt-imported/manifests/ and
 * record the honest per-area pass/fail/error counts to wpt-imported/baseline.json.
 *
 * The imported corpus is NOT a regression gate (every manifest's
 * baselinePassCount is 0); this file is the measured starting point so future
 * work can be diffed against it. Re-run after engine changes to track progress:
 *
 *   node tools/run-imported-baseline.mjs
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Guest test code can create its own promises the harness never observes; when
// such a promise rejects (e.g. `scroller.scrollTo is not a function` in a
// scroll-animations test), Node's default unhandledRejection behavior would
// kill the whole baseline run. The harness still scores whatever it observed;
// an escaped rejection must not erase 70 manifests of measurement. Count them
// so the baseline records how often this happens.
let escapedRejections = 0;
process.on("unhandledRejection", () => {
  escapedRejections += 1;
});

// Guest test code can also throw synchronously from a late-firing timer (e.g. a
// shadow-dom test asserting inside setTimeout after the harness finished the
// test). Such an escaped exception must not erase the whole baseline run; count
// it and continue with the next manifest.
let escapedExceptions = 0;
process.on("uncaughtException", (err) => {
  escapedExceptions += 1;
  process.stderr.write(`[baseline] escaped exception (continuing): ${err && err.message ? err.message : err}\n`);
});

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_DIR = path.join(REPO_ROOT, "wpt-imported", "manifests");
const OUT = path.join(REPO_ROOT, "wpt-imported", "baseline.json");

const { runWptSubsetManifestDir } = await import(
  path.join(REPO_ROOT, "packages/cli/dist/wpt-manifest.js")
);

const summary = await runWptSubsetManifestDir(MANIFEST_DIR);

const manifests = {};
let totals = { files: 0, subtests: 0, passed: 0, failed: 0, errored: 0 };
for (const run of summary.runs) {
  manifests[run.manifest.name] = {
    owner: run.manifest.owner,
    files: run.report.files,
    subtests: run.report.subtests,
    passed: run.report.passed,
    failed: run.report.failed,
    errored: run.report.errored,
  };
  totals = {
    files: totals.files + run.report.files,
    subtests: totals.subtests + run.report.subtests,
    passed: totals.passed + run.report.passed,
    failed: totals.failed + run.report.failed,
    errored: totals.errored + run.report.errored,
  };
}

const baseline = {
  generated: new Date().toISOString(),
  source: "Ladybird vendored WPT (ladybird-master/Tests/LibWeb/Text/input/wpt-import)",
  license: "BSD-2-Clause (Ladybird); WPT itself is BSD (see wpt-imported/wpt/LICENSE.md)",
  note: "Baseline measurement of the from-scratch engine against the imported WPT corpus. Not a CI gate: most tests fail/error because the engine is partial. Failed tests are recorded, never deleted.",
  escapedRejections,
  escapedExceptions,
  totals,
  manifests,
};

writeFileSync(OUT, `${JSON.stringify(baseline, null, 2)}\n`);
console.log(`wrote ${OUT}`);
console.log(
  `totals: files=${String(totals.files)} subtests=${String(totals.subtests)} passed=${String(totals.passed)} failed=${String(totals.failed)} errored=${String(totals.errored)}`,
);
