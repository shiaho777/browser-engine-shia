# Good First Compatibility Work

These are not chores. Each task is small enough for a new contributor, but it
still moves real compatibility, evidence, or open-source velocity. Copy one task
into a GitHub issue, keep the labels, and require the listed proof before merge.

## Rules

- Pick one task and keep the PR narrow.
- Run the listed commands and paste the key result lines in the PR.
- If the task changes WPT outcomes, trace counts, LOC, or public evidence, run
  `npm run evidence` and commit all generated artifacts.
- Do not lower maintained subset baselines.
- Do not add fake APIs or silent stubs to pass a test.

## Task Queue

### Classify One Unsupported Official WPT File

Labels:
`good first issue`, `compatibility`, `wpt`, `stage:harness`,
`phase:1-wpt-war-room`

Goal:
Run one official WPT file or tiny directory from a local checkout, classify
failures by owning stage, and open follow-up issues with evidence.

Evidence:

```bash
npm run wpt -- /path/to/web-platform-tests/dom --limit 20 --trace
```

Deliverable:

- A compatibility issue for each distinct failure bucket.
- No engine behavior changes unless the fix is tiny and separately evidenced.

Done when:

- Each issue includes the command, failure bucket, expected behavior, current
  behavior, and smallest next proof.

### Add Dashboard Copy For One New Evidence Metric

Labels:
`good first issue`, `open-source`, `evidence`, `phase:9-open-source`

Goal:
Expose one existing machine-readable metric from `benchmark-evidence.json` in
`evidence-dashboard.html` without adding a second source of truth.

Files likely touched:

- `packages/benchmark/src/report.ts`
- `packages/benchmark/src/benchmark.test.ts`

Evidence:

```bash
npm run test --workspace @browser-engine/benchmark
npm run evidence
```

Done when:

- The dashboard renders the new metric from benchmark evidence.
- The JSON evidence remains the source of truth for the metric.
- Public evidence files are regenerated from the benchmark command.

### Add One RFC For A Future Stage Seam

Labels:
`good first issue`, `architecture`, `rfc`, `phase:9-open-source`

Goal:
Add one short RFC under `docs/rfcs/` for a future stage seam, using the existing
RFC process expectations: boundary, evidence, rollback, and open questions.

Files likely touched:

- `docs/rfcs/*.md`
- `docs/RFC-PROCESS.md` only if the current process reveals a real gap

Evidence:

```bash
npm run lint
```

Done when:

- The RFC states the decision, alternatives, stage boundary, evidence plan, and
  rollback path.
- The RFC does not approve implementation by itself; it gives maintainers a
  reviewable decision record.

### Add Document Wildcard Tag Query Coverage

Labels:
`good first issue`, `compatibility`, `wpt`, `subset:dom-core`, `stage:guest`,
`phase:1-wpt-war-room`

Goal:
Add a WPT-format fixture proving `document.getElementsByTagName("*")` returns
connected element descendants in tree order, excludes the document root, and
excludes detached elements created or removed earlier in the same script.

Files likely touched:

- `packages/cli/wpt-fixtures/dom/*.html`
- `wpt-subsets/dom-core.json`
- CLI DOM bridge files only if the fixture exposes a real wildcard traversal gap

Evidence:

```bash
npm run wpt:subsets -- --trace
npm run evidence
```

Done when:

- The new fixture is listed in `dom-core.json`.
- The baseline increases only after the fixture passes.
- The fixture proves document wildcard traversal is rooted at the live document
  tree without adding a manual invalidation API.

### Add Node ownerDocument Coverage

Labels:
`good first issue`, `compatibility`, `wpt`, `subset:dom-core`, `stage:guest`,
`phase:1-wpt-war-room`

Goal:
Add `Node.ownerDocument` to the guest DOM bridge and prove elements, text nodes,
comments, detached nodes, clones, and reparented nodes keep pointing at the live
document wrapper.

Files likely touched:

- `packages/cli/src/script.ts`
- `packages/cli/src/script.test.ts`
- `packages/cli/wpt-fixtures/dom/*.html`
- `wpt-subsets/dom-core.json`

Evidence:

```bash
npm run test --workspace @browser-engine/cli
npm run wpt:subsets -- --trace
npm run evidence
```

Done when:

- Connected elements, text nodes, and comments expose the same document wrapper.
- Detached nodes created by `createElement`, `createTextNode`, and
  `createComment` expose that same document wrapper before insertion.
- Cloned and reparented nodes keep the same owner document.
- The new fixture is listed in `dom-core.json` and the baseline only moves
  forward after it passes.

### Add Text splitText Coverage

Labels:
`good first issue`, `compatibility`, `wpt`, `subset:dom-core`, `stage:guest`,
`phase:1-wpt-war-room`

Goal:
Add `Text.splitText()` to the guest DOM bridge and prove it mutates the original
text node, creates the following sibling with the split tail, preserves parent
order, and behaves correctly for detached text nodes.

Files likely touched:

- `packages/cli/src/script.ts`
- `packages/cli/src/script.test.ts`
- `packages/cli/wpt-fixtures/dom/*.html`
- `wpt-subsets/dom-core.json`

Evidence:

```bash
npm run test --workspace @browser-engine/cli
npm run wpt:subsets -- --trace
npm run evidence
```

Done when:

- Splitting a connected text node updates the original text and inserts the new
  text node immediately after it.
- Offset `0` and end-of-string splits preserve the DOM-specified head/tail data.
- A detached text node can be split without entering the document tree.
- Out-of-range offsets throw rather than silently fabricating a result.
- The new fixture is listed in `dom-core.json` and the baseline only moves
  forward after it passes.
