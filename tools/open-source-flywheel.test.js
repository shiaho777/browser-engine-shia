import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const text = (path) => readFileSync(path, "utf8");
const json = (path) => JSON.parse(text(path));

void test("label taxonomy is unique and covers routed templates", () => {
  const labels = json(".github/labels.json");
  const names = labels.map((label) => label.name);
  assert.equal(new Set(names).size, names.length, "label names must be unique");
  for (const label of labels) {
    assert.match(label.color, /^[0-9a-f]{6}$/i, `${label.name} has a six-digit color`);
    assert.ok(label.description.length > 0, `${label.name} has a description`);
  }

  const required = [
    "needs-triage",
    "good first issue",
    "compatibility",
    "performance",
    "open-source",
    "rfc",
    "evidence",
    "wpt",
    "subset:dom-core",
    "subset:css-cascade",
    "stage:guest",
    "stage:cascade",
    "stage:harness",
    "phase:1-wpt-war-room",
    "phase:9-open-source",
  ];
  for (const name of required) {
    assert.ok(names.includes(name), `missing label ${name}`);
  }
});

void test("good-first queue is evidence-bearing, not chore-only", () => {
  const doc = text("docs/GOOD-FIRST-ISSUES.md");
  const tasks = doc.split(/^### /m).slice(1);
  assert.ok(tasks.length >= 6, "starter queue should have at least six tasks");
  for (const task of tasks) {
    assert.match(task, /Labels:/, "task has labels");
    assert.match(task, /Evidence:/, "task has evidence commands");
    assert.match(task, /Done when:/, "task has a done definition");
  }
  assert.match(doc, /npm run wpt:subsets -- --trace/);
  assert.match(doc, /npm run evidence/);
  assert.match(doc, /official WPT/);
  assert.doesNotMatch(doc, /format-only chore/i);
});

void test("RFC process requires boundary, evidence, and rollback", () => {
  const process = text("docs/RFC-PROCESS.md");
  const template = text("docs/rfcs/0000-template.md");

  for (const phrase of [
    "Stage Boundary Check",
    "Evidence Plan",
    "Alternatives Considered",
    "Rollback",
  ]) {
    assert.ok(template.includes(phrase), `RFC template includes ${phrase}`);
  }
  assert.match(template, /Manual invalidation API added: no/);
  assert.match(template, /Silent stub path added: no/);
  assert.match(process, /New cross-package API or stage seam/);
  assert.match(process, /Public benchmark\/evidence schema changes/);
});

void test("issue and PR templates route by evidence, phase, subset, and RFC", () => {
  const compat = text(".github/ISSUE_TEMPLATE/compatibility.yml");
  const flywheel = text(".github/ISSUE_TEMPLATE/open_source_flywheel.yml");
  const pr = text(".github/pull_request_template.md");

  assert.match(compat, /id: phase/);
  assert.match(compat, /id: subset/);
  assert.match(compat, /subset:dom-core/);
  assert.match(compat, /subset:css-cascade/);
  assert.match(flywheel, /rfc-process/);
  assert.match(flywheel, /good-first-issues/);
  assert.match(pr, /Linked good-first task/);
  assert.match(pr, /Linked RFC/);
  assert.match(pr, /Public evidence updated/);
});
