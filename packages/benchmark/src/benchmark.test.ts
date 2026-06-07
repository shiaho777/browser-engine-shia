/**
 * Tests for the Competitive Benchmark Scoreboard (compete-with-google-benchmark
 * spec; tasks 2.3, 3.3, 5.3, 6.2; Requirements 1-6 + Correctness Properties).
 *
 * Built by `tsc` then run with: `node --test packages/benchmark/dist/*.test.js`.
 *
 * Asserts the honesty rules mechanically:
 *   - live metrics are pure + correct (Property 1);
 *   - every competitor datum has a citation OR is needs-source (Property 2);
 *   - each dimension yields exactly one verdict with required rationale (Prop 3);
 *   - the report is deterministic (Property 4);
 *   - our performance number is never fabricated (Property 5).
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { SourceFileInput } from "@browser-engine/scoreboard";

import { COMPETITORS } from "./competitors.data.js";
import { computeLiveMetrics, isTestFile } from "./metrics.js";
import { evaluateDimensions } from "./dimensions.js";
import { buildSnapshot, renderBenchmarkMarkdown } from "./report.js";
import { liveWptPassCount, BENCHMARK_SELF_TEST_SUBSET } from "./self-test.js";

// ---------------------------------------------------------------------------
// Property 1 — live metrics are pure + correctly classified.
// ---------------------------------------------------------------------------

const SYNTHETIC: readonly SourceFileInput[] = [
  { path: "packages/x/src/a.ts", content: "const a = 1;\nconst b = 2;\n" }, // 2 hand-written
  { path: "packages/x/src/b.ts", content: "const c = 3;\n" }, // 1 hand-written
  { path: "packages/x/src/generated/g.ts", content: "// @generated\nconst g = 0;\n" }, // generated (skip marker line is blank-trimmed? counts 2)
  { path: "packages/x/src/a.test.ts", content: "test('x', () => {});\nassert(true);\n" }, // test
];

void test("Req 1.1/1.2: live metrics classify hand-written vs generated vs test", () => {
  const m = computeLiveMetrics(SYNTHETIC, 5);
  assert.equal(m.handWrittenLines, 3, "two hand-written files: 2 + 1 = 3 lines");
  assert.ok(m.generatedLines > 0, "the generated file contributes generated lines");
  assert.equal(m.testLines, 2, "the test file's 2 lines are split out");
  assert.equal(m.totalLines, m.handWrittenLines + m.generatedLines + m.testLines);
});

void test("Req 1.3/1.5: CSS/DOM counts come from the live tables; ratios are derived", () => {
  const m = computeLiveMetrics(SYNTHETIC, 5);
  assert.ok(m.cssPropertyCount >= 18, "live CSS data table carries the connected properties");
  assert.ok(m.domMemberCount > 0, "live DOM IDL table has members");
  assert.equal(m.platformFeatureCount, m.cssPropertyCount + m.domMemberCount);
  assert.equal(m.compatPerLoc, 5 / 3, "compat-per-LOC = passes / hand-written lines");
  assert.equal(m.mechanismDensity, m.platformFeatureCount / (3 / 1000));
});

void test("Req 1.6: a zero hand-written denominator yields null, not a fake value", () => {
  const m = computeLiveMetrics([{ path: "packages/x/src/a.test.ts", content: "x\n" }], 5);
  assert.equal(m.handWrittenLines, 0);
  assert.equal(m.compatPerLoc, null);
  assert.equal(m.mechanismDensity, null);
});

void test("Req 1.1: isTestFile recognises test/spec/property-test files", () => {
  assert.equal(isTestFile("packages/x/src/a.test.ts"), true);
  assert.equal(isTestFile("packages/x/src/a.property.test.ts"), true);
  assert.equal(isTestFile("packages/x/src/a.spec.ts"), true);
  assert.equal(isTestFile("packages/x/src/a.ts"), false);
});

void test("live metrics are pure: same inputs ⇒ same output (Property 1)", () => {
  assert.deepEqual(computeLiveMetrics(SYNTHETIC, 7), computeLiveMetrics(SYNTHETIC, 7));
});

// ---------------------------------------------------------------------------
// Property 2 — competitor data: has-value ⟹ has-source; no-source ⟹ needs-source.
// ---------------------------------------------------------------------------

void test("Req 2.1/2.3 (Property 2): every competitor datum is cited or explicitly needs-source", () => {
  for (const d of COMPETITORS) {
    if (d.value !== null) {
      assert.notEqual(d.sourceUrl, "", `${d.metric} has a value, so it must carry a source URL`);
      assert.notEqual(d.confidence, "needs-source", `${d.metric} has a value, so it is not needs-source`);
    } else {
      assert.equal(d.confidence, "needs-source", `${d.metric} has no value, so it must be needs-source`);
    }
  }
});

void test("Req 2.2: the two real citations are present and complete", () => {
  const loc = COMPETITORS.find((d) => d.metric === "hand-written-lines");
  assert.ok(loc && loc.value === 36_000_000 && loc.sourceUrl.includes("wikipedia.org"));
  const interop = COMPETITORS.find((d) => d.metric === "wpt-interop-pass-rate");
  assert.ok(interop && interop.value === 95 && interop.sourceUrl.includes("webkit.org"));
});

// ---------------------------------------------------------------------------
// Property 3 — each dimension: exactly one verdict, with required rationale.
// ---------------------------------------------------------------------------

void test("Req 3.1/3.5 (Property 3): every dimension has exactly one valid verdict", () => {
  const m = computeLiveMetrics(SYNTHETIC, 5);
  const dims = evaluateDimensions(m);
  const ids = dims.map((d) => d.id);
  for (const required of [
    "compat-per-loc",
    "mechanism-density",
    "hand-written-surface",
    "css-coverage",
    "raw-interop",
    "runtime-performance",
  ]) {
    assert.ok(ids.includes(required), `dimension ${required} must be present`);
  }
  for (const d of dims) {
    assert.ok(["WIN", "GAP", "NOT-COMPARABLE"].includes(d.verdict), `${d.id} verdict valid`);
    assert.ok(d.rationale.length > 0, `${d.id} carries a rationale`);
  }
});

void test("Req 3.2: the structurally-ours dimensions are WINs", () => {
  const m = computeLiveMetrics(SYNTHETIC, 5);
  const byId = new Map(evaluateDimensions(m).map((d) => [d.id, d]));
  assert.equal(byId.get("hand-written-surface")?.verdict, "WIN");
  assert.equal(byId.get("compat-per-loc")?.verdict, "WIN");
  assert.equal(byId.get("mechanism-density")?.verdict, "WIN");
});

void test("Req 3.3: breadth dimensions are honest GAPs, not fake wins", () => {
  const m = computeLiveMetrics(SYNTHETIC, 5);
  const byId = new Map(evaluateDimensions(m).map((d) => [d.id, d]));
  assert.equal(byId.get("css-coverage")?.verdict, "GAP");
  assert.equal(byId.get("raw-interop")?.verdict, "GAP");
});

// ---------------------------------------------------------------------------
// Property 5 — performance is never fabricated.
// ---------------------------------------------------------------------------

void test("Req 3.6/6.2 (Property 5): runtime performance is NOT-COMPARABLE with a null our-value", () => {
  const m = computeLiveMetrics(SYNTHETIC, 5);
  const perf = evaluateDimensions(m).find((d) => d.id === "runtime-performance");
  assert.ok(perf !== undefined);
  assert.equal(perf.ourValue, null, "we must NOT fabricate our own performance number");
  assert.equal(perf.verdict, "NOT-COMPARABLE");
});

// ---------------------------------------------------------------------------
// Property 4 — report determinism + structure.
// ---------------------------------------------------------------------------

void test("Req 4.5 (Property 4): the report is byte-for-byte deterministic", () => {
  const m = computeLiveMetrics(SYNTHETIC, 5);
  const snap = buildSnapshot(m);
  assert.equal(renderBenchmarkMarkdown(snap), renderBenchmarkMarkdown(snap));
});

void test("Req 4.1/4.2/4.3/4.4/4.6: the report carries all required sections", () => {
  const m = computeLiveMetrics(SYNTHETIC, 5);
  const md = renderBenchmarkMarkdown(buildSnapshot(m));
  assert.match(md, /## Headline — where we lead/);
  assert.match(md, /## Head-to-head/);
  assert.match(md, /\| Dimension \| Ours \(live\) \| Chromium \(cited\) \| Verdict \|/);
  assert.match(md, /## Citations/);
  assert.match(md, /## Honesty statement/);
  assert.match(md, /## Overall/);
  // Headline leads with a WIN dimension.
  assert.match(md, /Headline[\s\S]*compat-per-LOC/);
  // A real citation URL is shown.
  assert.match(md, /webkit\.org\/blog\/16413/);
});

// ---------------------------------------------------------------------------
// Req 1.4 — the live WPT pass count comes from running the subset.
// ---------------------------------------------------------------------------

void test("Req 1.4: the self-test subset runs live and every check passes", () => {
  const passes = liveWptPassCount();
  assert.equal(passes, BENCHMARK_SELF_TEST_SUBSET.length, "every self-test check passes live");
  assert.ok(passes > 0);
});
