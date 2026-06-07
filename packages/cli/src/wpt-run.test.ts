import test from "node:test";
import assert from "node:assert/strict";

import { formatWptReport, parseWptArgs } from "./wpt-run.js";
import type { WptSuiteReport } from "./wpt-suite.js";

void test("parseWptArgs defaults to the vendored WPT-format fixtures", () => {
  const args = parseWptArgs([]);
  assert.ok(args.root.endsWith("packages/cli/wpt-fixtures"));
  assert.equal(args.limit, Infinity);
  assert.equal(args.json, false);
});

void test("parseWptArgs accepts root, --limit, and --json", () => {
  const args = parseWptArgs(["/tmp/wpt/dom", "--limit", "25", "--json"]);
  assert.equal(args.root, "/tmp/wpt/dom");
  assert.equal(args.limit, 25);
  assert.equal(args.json, true);
});

void test("formatWptReport summarizes suite totals and failing files", () => {
  const report: WptSuiteReport = {
    files: 1,
    subtests: 2,
    passed: 1,
    failed: 1,
    errored: 1,
    byFile: new Map([
      [
        "dom/example.html",
        {
          passed: 1,
          failed: 1,
          harnessError: "missing document API",
          subtests: [
            { name: "ok", status: "PASS", message: null },
            { name: "boom", status: "ERROR", message: "missing document API" },
          ],
        },
      ],
    ]),
  };

  const text = formatWptReport("/tmp/wpt", report);
  assert.match(text, /files: 1/);
  assert.match(text, /passed: 1/);
  assert.match(text, /dom\/example\.html/);
  assert.match(text, /harnessError=missing document API/);
});
