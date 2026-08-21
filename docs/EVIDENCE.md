# Evidence

This project earns trust through reproducible artifacts. A browser engine claim
is real only when a contributor can rerun the command and inspect the same
stage, WPT, resource, or benchmark evidence.

## Public Evidence Command

Run the full public evidence path:

```bash
npm run evidence
```

That command runs:

```bash
npm run wpt:subsets -- --trace
npm run benchmark
```

It regenerates three public artifacts:

- `BENCHMARK.md` for human review.
- `benchmark-evidence.json` for dashboards, bots, and machine checks.
- `evidence-dashboard.html` for a static public dashboard.

CI runs the same command and then requires every generated evidence file to be
committed:

```bash
git diff --exit-code -- BENCHMARK.md benchmark-evidence.json evidence-dashboard.html
```

Every CI run uploads the three-file evidence bundle as a `public-evidence`
artifact. Pushes to the repository default branch also publish the same bundle
to GitHub Pages with `evidence-dashboard.html` copied to `index.html`.

## Evidence Artifacts

`BENCHMARK.md`, `benchmark-evidence.json`, and `evidence-dashboard.html` come
from the same `BenchmarkSnapshot`. They must stay in sync; do not edit them by
hand.

The JSON schema is intentionally small and stable:

```json
{
  "schemaVersion": 1,
  "generatedBy": "@browser-engine/benchmark",
  "deterministic": true,
  "metrics": {},
  "dimensions": []
}
```

`metrics.executionEvidence` currently contains:

- maintained WPT subset trace counts
- deterministic incremental edit-sequence evidence
- real V8 script-driven DOM mutation evidence
- resource-loaded page evidence
- representative real-site smoke evidence

## When To Update Public Evidence

Run `npm run evidence` and commit all generated evidence files when a change
affects:

- hand-written product LOC
- generated LOC
- test LOC
- CSS property count
- DOM/WebIDL surface count
- maintained WPT pass counts
- query calls, recomputes, cache hits, verified hits, or dependency reads
- resource discovery/loading/decoding evidence
- smoke scenarios or covered capabilities
- benchmark dimensions or cited comparison data

For local exploration that should not update public artifacts, use targeted
commands instead:

```bash
npm run wpt
npm run wpt -- /path/to/web-platform-tests/dom --limit 100 --trace
npm run wpt:subsets -- --trace
npm run benchmark
```

## Evidence Ladder

Use the smallest proof that covers the claim:

| Claim | Minimum proof | Public proof |
| --- | --- | --- |
| Parser behavior | unit/property test | WPT-format fixture |
| Cascade or computed value | focused cascade test | maintained WPT subset trace |
| Layout behavior | layout test + differential | reftest or WPT subset trace |
| Paint/backend behavior | DisplayList/backend test | PNG/reftest/resource evidence |
| DOM/JS/runtime behavior | guest/runtime test | script-driven mutation or smoke evidence |
| Incremental behavior | recompute/cache assertion | benchmark edit-sequence evidence |
| Contributor workflow | deterministic test | `npm run evidence` stays clean |

## Review Rules

- Do not claim compatibility from a copied assertion when official WPT exists.
- Do not lower a maintained WPT baseline without explaining the upstream test
  removal or replacement.
- Do not embed wall-clock timing in public benchmark artifacts unless a future
  controlled same-machine comparison suite owns that number.
- Do not add fake browser APIs to increase pass counts.
- Do not add manual invalidation APIs; the kernel owns dependency tracking.
- Do not merge public workflow changes without a reproducible command.
