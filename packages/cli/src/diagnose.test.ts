/**
 * Tests for the `diagnose <input|URL>` command: the single console-to-cause
 * entry point that merges guest console + pipeline evidence + failure bucket.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  parseDiagnoseArgs,
  classifyDiagnoseBucket,
  diagnoseInput,
  formatDiagnoseReport,
  runDiagnoseCommand,
} from "./diagnose.js";

void test("parseDiagnoseArgs accepts input with optional --json", () => {
  assert.deepEqual(parseDiagnoseArgs(["a.html"]), { input: "a.html", json: false });
  assert.deepEqual(parseDiagnoseArgs(["--json", "a.html"]), { input: "a.html", json: true });
  assert.deepEqual(parseDiagnoseArgs(["https://site.test/", "--json"]), {
    input: "https://site.test/",
    json: true,
  });
});

void test("parseDiagnoseArgs rejects missing input and unknown options", () => {
  assert.throws(() => parseDiagnoseArgs([]), /missing/);
  assert.throws(() => parseDiagnoseArgs(["a.html", "--wat"]), /unknown option/);
});

void test("classifyDiagnoseBucket maps signals to war-room buckets", () => {
  assert.equal(classifyDiagnoseBucket(null, false), "ok");
  assert.equal(classifyDiagnoseBucket(null, true), "guest-gap");
  assert.equal(classifyDiagnoseBucket("NotImplemented [css-property]: foo", false), "cascade-gap");
  assert.equal(classifyDiagnoseBucket("NotImplemented [dom-api]: foo", false), "guest-gap");
  assert.equal(classifyDiagnoseBucket("NotImplemented [layout-mode]: foo", false), "layout-gap");
  assert.equal(classifyDiagnoseBucket("NotImplemented [paint-command]: foo", false), "paint-gap");
  assert.equal(classifyDiagnoseBucket("render: failed to fetch the document at https://x", false), "network-gap");
  assert.equal(classifyDiagnoseBucket("html tree construction error at line 3", false), "parser-gap");
  assert.equal(classifyDiagnoseBucket("glyph rasterization failed", false), "backend-gap");
  assert.equal(classifyDiagnoseBucket("testharness runner mismatch", false), "harness-gap");
  assert.equal(classifyDiagnoseBucket("layout FragmentTree overflow", false), "layout-gap");
  assert.equal(classifyDiagnoseBucket("DisplayList paint mismatch", false), "paint-gap");
  assert.equal(classifyDiagnoseBucket("some weird failure", false), "engine-bug");
});

void test("diagnoseInput captures guest console without blind re-testing", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "be-diagnose-"));
  try {
    const input = path.join(dir, "in.html");
    writeFileSync(input, `<div>hi</div><script>console.log("hello", 42); console.warn("careful");</script>`);

    const report = await diagnoseInput(input);
    assert.equal(report.kind, "file");
    assert.equal(report.ok, true);
    assert.equal(report.bucket, "ok");
    assert.equal(report.scripts.total, 1);
    assert.equal(report.scripts.inline, 1);
    assert.equal(report.scripts.executed, true);
    assert.ok(report.console.some((e) => e.message.includes("hello")), "console.log must be captured");
    assert.ok(report.stageTrace !== undefined, "file diagnosis must carry stage evidence");
    assert.ok(report.png !== undefined && report.png.bytes > 0);

    const text = formatDiagnoseReport(report);
    assert.match(text, /diagnose:/);
    assert.match(text, /bucket=ok/);
    assert.match(text, /console/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("diagnoseInput surfaces guest errors with a guest-gap bucket", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "be-diagnose-err-"));
  try {
    const input = path.join(dir, "in.html");
    writeFileSync(input, `<div>hi</div><script>throw new Error("boom");</script>`);

    const report = await diagnoseInput(input);
    assert.equal(report.ok, false);
    assert.equal(report.bucket, "guest-gap");
    assert.ok((report.scriptError ?? "").includes("boom"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("runDiagnoseCommand returns 0 on clean pages and 1 on failures", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "be-diagnose-cli-"));
  try {
    const good = path.join(dir, "good.html");
    const bad = path.join(dir, "bad.html");
    writeFileSync(good, "<div>hello</div>");
    writeFileSync(bad, `<div>hi</div><script>throw new Error("boom");</script>`);

    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      assert.equal(await runDiagnoseCommand([good]), 0);
      assert.equal(await runDiagnoseCommand([bad]), 1);
      assert.equal(await runDiagnoseCommand([bad, "--json"]), 1);
    } finally {
      console.log = original;
    }
    const out = lines.join("\n");
    assert.match(out, /bucket=ok/);
    assert.match(out, /bucket=guest-gap/);
    assert.match(out, /"bucket": "guest-gap"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
