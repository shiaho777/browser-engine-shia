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

The command exits with:

- `0` when every discovered subtest passes
- `1` when any subtest fails/errors or no tests are discovered

For exploration against a broad WPT checkout, a non-zero exit is expected until
the subset becomes a maintained gate.

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

## Maintained Subsets

The next step is to add `wpt-subsets/*.json` manifests. Each manifest should
contain:

```json
{
  "name": "dom-core",
  "owner": "guest",
  "root": "dom",
  "files": [
    "nodes/Document-createElement.html"
  ],
  "baselinePassCount": 0
}
```

Rules:

- A manifest is a CI contract.
- Lowering `baselinePassCount` is a compatibility regression unless the test was
  removed upstream and the PR explains why.
- Expanding a manifest is the preferred way to make compatibility progress
  visible.

## What Not To Do

- Do not copy a WPT assertion into a local test and claim official coverage.
- Do not skip failing subtests without classifying them.
- Do not make the runner hide missing APIs.
- Do not increase pass count by weakening assertions or faking browser APIs.
- Do not mix broad WPT exploration with a regression gate in the same PR.

## First Target Subsets

1. `dom-core`: create/query/mutate nodes, attributes, text, classList, dataset.
2. `events`: EventTarget, capture/bubble, default prevention.
3. `css-cascade`: selectors, specificity, inheritance, initial values.
4. `css-values`: lengths, percentages, `calc()`, colors, transforms.
5. `layout-block-inline`: block flow, inline flow, margin collapse, line boxes.
6. `layout-flex-grid`: flex and grid algorithm subsets.
7. `paint-compositing`: backgrounds, borders, overflow, transforms, opacity.
8. `html-parser`: tree construction, quirks, serialization recovery.
