# WPT War Room

Official Web Platform Tests are the compatibility battlefield. This project can
keep self-tests for local invariants, but browser-class claims must come from
official WPT files or WPT-format fixtures.

## Commands

Run the vendored WPT-format fixtures:

```bash
npm run wpt
```

Run a local WPT checkout or subdirectory:

```bash
npm run wpt -- /path/to/web-platform-tests/dom --limit 100
```

Emit machine-readable JSON:

```bash
npm run wpt -- /path/to/web-platform-tests/html --limit 50 --json
```

Attach fine-grained query evidence to the WPT report:

```bash
npm run wpt -- /path/to/web-platform-tests/dom --limit 100 --trace
```

Run maintained subset manifests and enforce their stored pass-count baselines:

```bash
npm run wpt:subsets
```

Run maintained subsets with trace evidence:

```bash
npm run wpt:subsets -- --trace
```

Regenerate the public evidence report after maintained WPT, resource, smoke, or
incremental evidence changes:

```bash
npm run evidence
```

Run the same manifests against an external checkout root:

```bash
npm run wpt:subsets -- --wpt-root /path/to/web-platform-tests
```

The command exits with:

- `0` when every discovered subtest passes
- `1` when any subtest fails/errors or no tests are discovered

For `npm run wpt`, a non-zero exit is expected when exploring unsupported WPT
areas. For `npm run wpt:subsets`, non-zero means a maintained baseline regressed
or the manifest could not be run.

## Workflow

1. Pick a small official WPT directory or file set.
2. Run it with a limit first.
3. Classify every failure by owning stage.
4. Fix the highest-leverage missing mechanism.
5. Re-run the subset.
6. When the pass count is stable, add the subset to the scoreboard and make it
   forward-only.

## Failure Classification

Use these buckets in issues and PR descriptions:

| Bucket | Meaning |
| --- | --- |
| `harness-gap` | The WPT runner lacks a harness feature needed by the test |
| `parser-gap` | HTML/CSS parser does not produce the right IR |
| `cascade-gap` | Selector/cascade/computed value mismatch |
| `layout-gap` | Fragment geometry or layout algorithm mismatch |
| `paint-gap` | DisplayList command stream mismatch |
| `backend-gap` | Raster/composite/output mismatch |
| `guest-gap` | DOM/event/JS/WebIDL runtime missing behavior |
| `network-gap` | Fetch/origin/storage/security behavior missing |
| `engine-bug` | The mechanism exists but returns the wrong result |

Map the bucket to labels from `.github/labels.json`: add `compatibility`,
`wpt`, the owning `stage:*` label, the relevant `phase:*` label, and a
`subset:*` label when a maintained subset is involved.

## Maintained Subsets

Maintained subsets live under `wpt-subsets/*.json`. Each manifest contains:

```json
{
  "name": "dom-core",
  "owner": "guest",
  "root": "packages/cli/wpt-fixtures",
  "files": [
    "dom/getelementbyid.html"
  ],
  "baselinePassCount": 3
}
```

Rules:

- A manifest is a CI contract.
- `root` is resolved from the repository root by default.
- `--wpt-root /path/to/web-platform-tests` replaces the repository root as the
  base for `root`, so future official subsets can point at a real checkout.
- Lowering `baselinePassCount` is a compatibility regression unless the test was
  removed upstream and the PR explains why.
- Expanding a manifest is the preferred way to make compatibility progress
  visible.
- `--trace` adds the actual fine-grained query graph evidence for the WPT run
  (`qFineSheets`, `qFineComputed`, `qFineLayout`, `qFinePaint`): calls,
  recomputes, cache hits, dependency reads, and timing.
- `npm run evidence` embeds only deterministic WPT trace counts and related
  execution evidence in `BENCHMARK.md`, `benchmark-evidence.json`, and
  `evidence-dashboard.html`; wall-clock timings stay in command output because
  they are environment-dependent.

## What Not To Do

- Do not copy a WPT assertion into a local test and claim official coverage.
- Do not skip failing subtests without classifying them.
- Do not make the runner hide missing APIs.
- Do not increase pass count by weakening assertions or faking browser APIs.
- Do not mix broad WPT exploration with a regression gate in the same PR.

## First Target Subsets

1. `dom-core`: create/query/mutate nodes, attributes, text, classList, dataset.
2. `css-cascade`: selectors, attribute selectors, specificity, inheritance,
   initial values.
3. `events`: EventTarget, capture/bubble, default prevention.
4. `css-values`: lengths, percentages, `calc()`, colors, transforms.
5. `layout-block-inline`: block flow, inline flow, margin collapse, line boxes.
6. `layout-flex-grid`: flex and grid algorithm subsets.
7. `paint-compositing`: backgrounds, borders, overflow, transforms, opacity.
8. `html-parser`: tree construction, quirks, serialization recovery.

Maintained today:

- `wpt-subsets/dom-core.json`
- `wpt-subsets/css-cascade.json`

Starter tasks that expand these gates live in `docs/GOOD-FIRST-ISSUES.md`.
