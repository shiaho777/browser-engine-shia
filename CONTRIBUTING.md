# Contributing

The project goal is a general-purpose, high-performance, highly customizable
open-source browser engine. Contributions should move the engine toward that
goal with real mechanisms, tests, and measurable compatibility.

## Quick Start

```bash
npm install
npm run build
npm run ci
npm run evidence
npm run benchmark
npm run wpt
npm run wpt:subsets
```

`npm run wpt` runs the vendored WPT-format fixtures by default. To run a local
web-platform-tests checkout:

```bash
npm run wpt -- /path/to/wpt --limit 100
```

New contributors should start with `docs/GOOD-FIRST-ISSUES.md`. Changes that
create or reshape stage seams, generated surfaces, backend adapters, browser
services, or public evidence schema should use `docs/RFC-PROCESS.md`.

## Evidence Ladder

Every contribution should climb the smallest evidence ladder that proves the
change without pretending to prove more than it does.

| Change type | Minimum evidence | Stronger public evidence |
| --- | --- | --- |
| Parser / CSS parser | focused unit or property test | WPT-format fixture or maintained WPT subset |
| Cascade / selector / computed value | cascade test plus WPT-format fixture | `npm run wpt:subsets -- --trace` with the relevant manifest |
| Layout algorithm | layout unit test plus naive-vs-incremental differential | reftest or WPT subset with stage trace |
| Paint / backend / image / text | DisplayList/backend test plus PNG/reftest evidence | resource-loaded page or real-site smoke evidence |
| DOM / JS / event loop / fetch | WPT-format guest/runtime test | script-driven DOM mutation or real-site smoke evidence |
| Incremental behavior | recompute-count or verified-hit assertion | benchmark edit-sequence evidence in `BENCHMARK.md` |
| Public workflow / metrics | deterministic report test | regenerated public evidence artifacts with stable hashes |

The current public benchmark evidence includes:

- maintained WPT subset trace
- deterministic incremental edit-sequence trace
- real V8 script-driven DOM mutation trace
- URL/resource-loaded page evidence
- real-site smoke evidence

Regenerate public evidence artifacts with:

```bash
npm run evidence
```

CI uploads those artifacts as `public-evidence` for PR review. On the default
branch, the same bundle is published as the public dashboard.

When your change affects hand-written LOC, test LOC, feature counts, WPT
outcomes, trace counts, or smoke evidence, commit the resulting `BENCHMARK.md`,
`benchmark-evidence.json`, and `evidence-dashboard.html` changes and mention
the reason in the PR.

## Development Rules

1. Do not add silent stubs. Throw `NotImplemented` for missing capabilities.
2. Do not import another stage's internals. Use `@browser-engine/ir` or a
   generated infrastructure surface.
3. Do not create a second geometry source. Geometry belongs in `FragmentTree`.
4. Do not add manual invalidation APIs. The kernel owns dependency tracking.
5. Do not fake compatibility. Add WPT, reftest, differential, or unit evidence.
6. Prefer data rows and shared mechanisms over per-feature hand-written code.

## Labels And Issue Routing

`.github/labels.json` is the versioned label taxonomy. Use labels to make every
issue reviewable by phase, stage, subset, and evidence type:

- `phase:*` says which roadmap front owns the work.
- `stage:*` says which engine boundary owns the behavior.
- `subset:*` says which maintained WPT gate is involved.
- `wpt`, `evidence`, `rfc`, and `good first issue` describe the proof path.

Do not mark a task `good first issue` unless it has a concrete command and a
real compatibility, evidence, or workflow outcome.

## RFCs

Use `docs/RFC-PROCESS.md` and `docs/rfcs/0000-template.md` when a change affects
a new seam, generated surface, backend adapter, public evidence schema, or
network/security policy. An accepted RFC is not evidence by itself; follow-up
implementation PRs still need tests, WPT, trace, benchmark, or dashboard proof.

## Before Sending A PR

Run:

```bash
npm run typecheck
npm run lint
npm run test:eslint-rules
npm run test:constitution
npm run test
npm run wpt:subsets -- --trace
npm run evidence
```

For compatibility changes, also run the relevant WPT subset or fixture:

```bash
npm run wpt
npm run wpt -- /path/to/wpt/dom --limit 50
npm run wpt -- /path/to/wpt/dom --limit 50 --trace
```

For render/resource changes, also run a traced render:

```bash
node packages/cli/dist/index.js render input.html -o out.png --trace
```

For URL/resource-loader changes, prefer a deterministic mock-backed test over a
network-dependent benchmark. Public reports must be reproducible.

## Adding A CSS Property

Use this path when the property is mostly declarative.

1. Add or update a row in
   `packages/generator/src/css-properties.data.ts`.
2. Reuse an existing grammar if possible. Add a grammar only when a family of
   properties needs it.
3. Run:

   ```bash
   npm run generate --workspace @browser-engine/generator
   npm run test --workspace @browser-engine/generator
   npm run test --workspace @browser-engine/cascade
   ```

4. Add WPT or focused tests proving parse -> cascade -> computed value.
5. If layout or paint consumes the value, add end-to-end tests in `cli`,
   `layout`, or `paint`.

Do not add a hand-written parser branch for a single property unless the spec
requires behavior that cannot be represented by an existing grammar family.

## Adding A CSS Shorthand Or Value Mechanism

Shorthands should not stay opaque strings when they control common real-world
style.

1. Add a shared parser/expander mechanism.
2. Preserve unknown or unsupported syntax honestly; do not pretend it computed.
3. Expand to typed longhands before cascade output where possible.
4. Add tests for invalid syntax, omitted components, defaulting, and
   serialization if applicable.
5. Add WPT cases or map existing WPT files into a subset.

## Adding DOM Or WebIDL Surface

1. Add the IDL row in `packages/generator/src/dom-interfaces.idl.ts`.
2. Generate and inspect the emitted surface.
3. Implement the runtime behavior in `guest` or `cli` only through approved
   runtime seams.
4. Missing behavior must throw or be absent; never return a fake object.
5. Add WPT-format tests when possible.

## Adding Layout Behavior

1. Identify the formatting context: block, inline, flex, grid, table, multicol,
   positioned, or replaced.
2. Keep all resolved geometry in `FragmentTree`.
3. Add unit tests for the algorithm.
4. Add reftests when pixels matter.
5. Add naive-vs-incremental differential coverage if inputs can mutate.
6. Verify `getBoundingClientRect` still reads the same geometry source.

## Adding Paint Or Backend Behavior

1. Add a backend-agnostic `DisplayList` command only if existing commands cannot
   express the behavior.
2. Paint must copy values into commands; commands must not hold upstream IR
   references.
3. Backend code consumes only `DisplayList` plus explicit providers/surfaces.
4. Add CPU/GPU equivalence or PNG/reftest evidence.
5. Unsupported backend commands should throw a descriptive error, not no-op.

## Adding WPT Coverage

The preferred compatibility proof is official WPT.

1. Pick a small subset directory or file group.
2. Run it with:

   ```bash
   npm run wpt -- /path/to/wpt/path --limit 100
   ```

3. Classify failures:
   - parser gap
   - cascade gap
   - selector gap
   - layout gap
   - paint/backend gap
   - guest runtime gap
   - harness gap
   - genuine engine bug
4. Add or update a subset manifest when the files become a maintained gate.
5. Store a baseline pass count and block regressions before claiming support.

Maintained manifests live in `wpt-subsets/*.json` and are enforced by:

```bash
npm run wpt:subsets
npm run wpt:subsets -- --trace
```

`--trace` is not decoration. It records the actual fine-grained query graph
used by the WPT runner, including recomputes, cache hits, verified hits, and
dependency reads. Use it when claiming an incremental or stage-boundary win.

## Adding Public Benchmark Evidence

Use `packages/benchmark/src/evidence.ts` when a capability should become part
of the public report. `BENCHMARK.md`, `benchmark-evidence.json`, and
`evidence-dashboard.html` are generated from the same snapshot; keep evidence
deterministic:

1. Count stable facts only: pass counts, resource counts, query counts, cache
   hits, dependency reads, PNG dimensions, command counts.
2. Do not embed wall-clock timings in public benchmark artifacts.
3. Use deterministic fixtures or maintained smoke scenarios, not live network
   resources.
4. Add report tests in `packages/benchmark/src/benchmark.test.ts`.
5. Run `npm run evidence` twice if determinism is in doubt.

## Commit Discipline

Good commits are small and prove one thing:

- a data row plus generated artifacts plus tests
- one layout rule plus WPT/reftest
- one runtime API plus WPT-format test
- one backend feature plus pixel evidence
- one invariant guard plus deliberate violation fixture

Avoid commits that mix unrelated compatibility work, refactors, and benchmark
updates. If a generated report changes because LOC changed, mention it.

## What "Done" Means

A feature is done when:

- it has no silent stub path
- it respects stage boundaries
- it has tests at the right level
- it updates generated artifacts if needed
- it does not regress existing WPT/reftest/differential gates
- it is documented when it creates a new mechanism or public workflow

If the feature is only a partial implementation, say exactly what is supported
and what still throws `NotImplemented`.
