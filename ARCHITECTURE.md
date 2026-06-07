# Architecture Constitution

This engine is a compiler-style browser pipeline. Each stage consumes immutable
IR from the previous stages and produces one immutable IR product. The design is
meant to scale to a general-purpose browser engine while keeping the hand-written
core small, inspectable, and aggressively testable.

## Pipeline Shape

```text
SourceBytes
  -> qDom       -> DomTree
  -> qSheets    -> StyleSheet[]
  -> qComputed  -> ComputedStyle per node
  -> qLayout    -> FragmentTree
  -> qPaint     -> DisplayList
  -> backend    -> Surface / PNG / platform output
```

The CLI is the wiring layer. It may import stages to compose the pipeline. A
stage must not import another stage's internals.

## Package Roles

| Package | Role |
| --- | --- |
| `ir` | Nominally branded, immutable inter-stage IR |
| `kernel` | Query engine, naive and true incremental backends |
| `generator` | Platform-as-Data CSS/WebIDL generation |
| `html-parser` | HTML bytes to `DomTree` |
| `css-parser` | CSS bytes to `StyleSheet` |
| `cascade` | Selectors + cascade to `ComputedStyle` |
| `layout` | `DomTree` + style to `FragmentTree` geometry |
| `paint` | `FragmentTree` + style to `DisplayList` |
| `gpu` | GPU-style command execution and compositing |
| `font` | Built-in glyph coverage and native shaping/raster seams |
| `backend` | Screenshot surface, software/GPU render path, PNG encoding |
| `guest` | DOM/runtime surface exposed to guest JavaScript |
| `cli` | Pipeline orchestration, render command, WPT runner |
| `scoreboard` | LOC, WPT pass count, compat-per-LOC |
| `test-harness` | Reftest, PNG, and differential testing tools |
| `benchmark` | Live project metrics and cited competitor comparisons |

## Non-Negotiable Invariants

### 1. No Silent Stubs

If a capability is not implemented, it must throw `NotImplemented` with a useful
feature name and category. It must not return a fake value.

Enforced by:

- `local/no-silent-stub`
- constitution fixtures under `tools/constitution-fixtures`
- check gate probes in `packages/cli/src/checks.ts`

### 2. No Cross-Stage Internals

Stages communicate only through `@browser-engine/ir` and generated infrastructure
surfaces. A stage must not import mutable or private types from another stage.

Enforced by:

- `local/no-cross-stage-import`
- TypeScript project references
- CI lint gate

### 3. Geometry Has One Truth Source

Resolved geometry lives in `FragmentTree`. `ComputedStyle` contains style values
only. Paint commands copy geometry from `FragmentTree` into `DisplayList`; the
backend consumes only `DisplayList` plus a surface.

Required behavior:

- `getBoundingClientRect` derives from fragment border boxes.
- Paint never asks layout or DOM for geometry after the DisplayList boundary.
- Backend never receives DOM, style, or layout handles.

### 4. Incrementality Is a Kernel Property

No caller marks stale. Queries read inputs and other queries through `Db`; the
kernel records dependencies and decides what is clean.

Allowed DB surface:

- `getInput`
- `query`
- `setInput`

Forbidden DB surface:

- `invalidate`
- `markStale`
- `setDirty`
- `markDirty`
- any equivalent manual stale marking API

### 5. Platform Breadth Comes From Data

CSS properties and DOM surface should grow through declarative rows and code
generation. Hand-written code is reserved for common mechanisms: parsing
families, value computation contexts, selector matching, layout algorithms,
paint commands, and host/runtime seams.

When adding Web platform surface, prefer this order:

1. data row or IDL row
2. generated parser/field/surface
3. shared mechanism
4. WPT or reftest
5. only then a feature-specific branch if the spec truly requires it

## Incremental Kernel Contract

Every query must be pure with respect to the graph:

- reads go through `db.getInput` or `db.query`
- no hidden global mutable state
- deterministic result for identical inputs
- immutable result when it crosses a stage boundary

The true incremental backend must be byte-for-byte equivalent to the naive
backend. Any optimization that changes observable output is a bug.

## IR Contract

IR values are:

- nominally branded at the type level
- deeply frozen where practical
- exposed as readonly structures
- copied when crossing into backend commands

Important caveat: JavaScript cannot fully freeze `Map` mutation methods or
typed-array contents at runtime. TypeScript readonly types and tests guard those
paths, and the incremental backend compares Map/Set contents structurally when
detecting dependency changes.

## WPT Contract

Official WPT is the compatibility source of truth. Self-authored tests are still
valuable, but they prove local invariants, not browser-class compatibility.

Each WPT subset should have:

- a clear feature owner/stage
- a stored baseline pass count
- a forward-only regression gate
- known failures classified as missing API, parser gap, layout gap, paint gap,
  harness gap, or genuine engine bug

## Backend Contract

Backends are replaceable consumers of `DisplayList`. They may use Skia, Canvas,
WebGPU, software raster, or a platform compositor, but they must not pierce the
pipeline and read upstream IR.

Backend input:

- `DisplayList`
- target surface or platform output
- optional font/image/glyph providers behind explicit seams

Backend output:

- pixels, surface, or platform frame

## Guest Runtime Contract

Guest JavaScript must never receive privileged host access accidentally. The
guest surface is explicitly built from generated and hand-approved APIs.

Runtime rules:

- fake DOM APIs are forbidden
- missing APIs throw or are absent according to spec/harness expectations
- mutations flow into the incremental graph
- event loop behavior is deterministic in tests
- real network/filesystem access goes through explicit policy objects

## How To Decide If A Change Belongs

A change belongs if it makes the final universal browser-engine goal more true:

- more official WPT passes
- fewer fake APIs
- better incremental behavior
- stronger stage boundaries
- clearer generated platform surface
- faster or smaller without weakening correctness

A change does not belong if it:

- adds a shortcut that bypasses IR
- introduces a silent placeholder
- hard-codes a fixture result
- makes compatibility numbers look better without real capability
- hides a failure rather than classifying it
