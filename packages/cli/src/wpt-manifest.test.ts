import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  collectWptSubsetManifestFiles,
  loadWptSubsetManifest,
  runWptSubsetManifest,
  runWptSubsetManifestDir,
  type WptSubsetManifest,
} from "./wpt-manifest.js";
import { formatWptSubsetSummary, parseWptSubsetArgs } from "./wpt-subsets-run.js";

const FIXTURE_MANIFEST: WptSubsetManifest = {
  name: "dom-core",
  owner: "guest",
  root: "packages/cli/wpt-fixtures",
  files: [
    "dom/getelementbyid.html",
    "dom/queryselector.html",
    "dom/attributes.window.js",
  ],
  baselinePassCount: 8,
};

void test("loadWptSubsetManifest validates the JSON manifest shape", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "be-wpt-manifest-"));
  const file = path.join(dir, "dom-core.json");
  writeFileSync(file, JSON.stringify(FIXTURE_MANIFEST), "utf8");

  assert.deepEqual(loadWptSubsetManifest(file), FIXTURE_MANIFEST);
});

void test("collectWptSubsetManifestFiles returns sorted JSON manifest paths", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "be-wpt-manifests-"));
  writeFileSync(path.join(dir, "b.json"), JSON.stringify(FIXTURE_MANIFEST), "utf8");
  writeFileSync(path.join(dir, "a.json"), JSON.stringify({ ...FIXTURE_MANIFEST, name: "a" }), "utf8");
  writeFileSync(path.join(dir, "README.md"), "ignored", "utf8");

  assert.deepEqual(
    collectWptSubsetManifestFiles(dir).map((file) => path.basename(file)),
    ["a.json", "b.json"],
  );
});

void test("runWptSubsetManifest runs the listed files and passes the baseline gate", async () => {
  const run = await runWptSubsetManifest(FIXTURE_MANIFEST);

  assert.equal(run.report.files, 3);
  assert.equal(run.report.passed, 8);
  assert.equal(run.regression.baseline, 8);
  assert.equal(run.regression.candidate, 8);
  assert.equal(run.passedGate, true);
});

void test("runWptSubsetManifest blocks when candidate pass count is below baseline", async () => {
  const run = await runWptSubsetManifest({ ...FIXTURE_MANIFEST, baselinePassCount: 9 });

  assert.equal(run.report.passed, 8);
  assert.equal(run.regression.blocked, true);
  assert.equal(run.passedGate, false);
});

void test("runWptSubsetManifestDir aggregates manifests and formats the gate summary", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "be-wpt-manifest-dir-"));
  writeFileSync(path.join(dir, "dom-core.json"), JSON.stringify(FIXTURE_MANIFEST), "utf8");

  const summary = await runWptSubsetManifestDir(dir);
  assert.equal(summary.runs.length, 1);
  assert.equal(summary.passedGate, true);

  const text = formatWptSubsetSummary(summary);
  assert.match(text, /subsets: 1/);
  assert.match(text, /dom-core/);
  assert.match(text, /baseline=8/);
  assert.match(text, /gate=PASS/);
});

void test("parseWptSubsetArgs accepts manifest dir, --wpt-root, and --json", () => {
  const args = parseWptSubsetArgs(["/tmp/subsets", "--wpt-root", "/tmp/wpt", "--json"]);

  assert.equal(args.manifestDir, "/tmp/subsets");
  assert.equal(args.wptRootOverride, "/tmp/wpt");
  assert.equal(args.json, true);
});
