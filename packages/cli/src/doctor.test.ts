/**
 * Tests for the `doctor <input|URL>` headless loop: diagnose repeatedly,
 * pick up edits between iterations, and stop early once clean.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  parseDoctorArgs,
  doctorSignature,
  runDoctor,
  formatDoctorResult,
  runDoctorCommand,
  DOCTOR_DEFAULT_MAX,
  DOCTOR_DEFAULT_INTERVAL_MS,
} from "./doctor.js";

void test("parseDoctorArgs defaults and options", () => {
  assert.deepEqual(parseDoctorArgs(["a.html"]), {
    input: "a.html",
    max: DOCTOR_DEFAULT_MAX,
    intervalMs: DOCTOR_DEFAULT_INTERVAL_MS,
    json: false,
  });
  assert.deepEqual(parseDoctorArgs(["a.html", "--max", "3", "--interval-ms", "0", "--json"]), {
    input: "a.html",
    max: 3,
    intervalMs: 0,
    json: true,
  });
  assert.deepEqual(parseDoctorArgs(["a.html", "--jsonl", "out.jsonl"]), {
    input: "a.html",
    max: DOCTOR_DEFAULT_MAX,
    intervalMs: DOCTOR_DEFAULT_INTERVAL_MS,
    json: false,
    jsonl: "out.jsonl",
  });
});

void test("parseDoctorArgs rejects bad input", () => {
  assert.throws(() => parseDoctorArgs([]), /missing/);
  assert.throws(() => parseDoctorArgs(["a.html", "--wat"]), /unknown option/);
  assert.throws(() => parseDoctorArgs(["a.html", "--max", "0"]), /invalid --max/);
  assert.throws(() => parseDoctorArgs(["a.html", "--max"]), /requires a number/);
  assert.throws(() => parseDoctorArgs(["a.html", "--interval-ms", "-1"]), /invalid --interval-ms/);
  assert.throws(() => parseDoctorArgs(["a.html", "--jsonl"]), /requires a path/);
});

void test("runDoctor stops after one iteration on a clean page", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "be-doctor-"));
  try {
    const input = path.join(dir, "good.html");
    writeFileSync(input, "<div>hello</div>");
    let calls = 0;
    const result = await runDoctor(input, { max: 5, intervalMs: 0 }, () => {
      calls += 1;
    });
    assert.equal(result.ok, true);
    assert.equal(result.iterations, 1);
    assert.equal(calls, 1);
    assert.equal(result.stabilized, true);
    assert.match(formatDoctorResult(result), /CLEAN/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("runDoctor exhausts max with a stable signature on persistent failure", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "be-doctor-fail-"));
  try {
    const input = path.join(dir, "bad.html");
    writeFileSync(input, `<div>hi</div><script>throw new Error("boom");</script>`);
    const result = await runDoctor(input, { max: 3, intervalMs: 0 });
    assert.equal(result.ok, false);
    assert.equal(result.iterations, 3);
    assert.equal(result.stabilized, true);
    assert.equal(doctorSignature(result.reports[0] as never), doctorSignature(result.reports[2] as never));
    assert.match(formatDoctorResult(result), /STILL FAILING/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("runDoctor picks up a fix applied between iterations", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "be-doctor-fix-"));
  try {
    const input = path.join(dir, "page.html");
    writeFileSync(input, `<div>hi</div><script>throw new Error("boom");</script>`);
    const result = await runDoctor(input, { max: 5, intervalMs: 0 }, (_report, iteration) => {
      // Simulate the agent fixing the page after seeing iteration 1 fail.
      if (iteration === 1) writeFileSync(input, "<div>fixed</div>");
    });
    assert.equal(result.ok, true);
    assert.equal(result.iterations, 2);
    assert.equal(result.stabilized, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("runDoctorCommand appends one JSON line per iteration", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "be-doctor-cli-"));
  try {
    const input = path.join(dir, "bad.html");
    const jsonl = path.join(dir, "log.jsonl");
    writeFileSync(input, `<div>hi</div><script>throw new Error("boom");</script>`);

    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    let code: number;
    try {
      code = await runDoctorCommand([input, "--max", "2", "--interval-ms", "0", "--jsonl", jsonl]);
    } finally {
      console.log = original;
    }
    assert.equal(code, 1);
    const logged = readFileSync(jsonl, "utf8").trim().split("\n");
    assert.equal(logged.length, 2);
    assert.equal((JSON.parse(logged[0] as string) as { bucket: string }).bucket, "guest-gap");
    assert.match(lines.join("\n"), /STILL FAILING/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
