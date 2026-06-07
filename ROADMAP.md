# Roadmap: Open-Source Browser Engine Number One

This project is not an educational renderer and not a niche engine. The target
is a general-purpose client engine that can compete in the same browser-class
scenarios as Chromium while winning on performance-per-complexity,
customizability, and hand-written surface area.

The strategy is not to clone Chromium. The strategy is to make the Web platform
mechanical: specs become data, data becomes generated code, generated code feeds
small hand-written mechanisms, and every mechanism is guarded by tests and
compatibility metrics.

## North-Star Metrics

Every phase must improve at least one of these without weakening the others:

| Metric | Why it matters | Gate |
| --- | --- | --- |
| Official WPT passes | Real compatibility, not self-authored comfort tests | Forward-only pass count |
| compat-per-LOC | The mechanism-density advantage | Scoreboard denominator is hand-written LOC |
| Runtime cost per page | Performance advantage | Stage timing + recompute tracing |
| Incremental recompute size | Small edits must stay small | Naive-vs-incremental differential |
| Silent stub count | Fake APIs destroy trust | Must remain zero |
| Cross-stage boundary violations | Architecture is the moat | Must remain zero |

## Operating Doctrine

1. Platform surface grows by tables and generators, not hand-written boilerplate.
2. Stage boundaries are hard: DOM -> CSS -> cascade -> layout -> paint -> backend.
3. Geometry has one truth source: `FragmentTree`.
4. Unimplemented paths throw `NotImplemented`; they never fake success.
5. Official WPT is the compatibility scoreboard. Self-tests are guardrails, not
   the public compatibility claim.
6. Performance is an architectural invariant: small DOM/style edits must not
   become whole-page recomputes.
7. Reused infrastructure is strength: JS engine, shaping, rasterization,
   networking, TLS, and codecs should be plugged behind narrow seams.

## Phase 1: WPT War Room

Goal: replace "we think it works" with official, reproducible compatibility
evidence.

Deliverables:

- Root command: `npm run wpt -- [wpt-root] [--limit N] [--json]`.
- Curated official subsets under `wpt-subsets/` for parser, DOM, CSS cascade,
  selectors, layout, paint, and event loop. The first maintained manifest is
  `wpt-subsets/dom-core.json`; more manifests should land as compatibility
  fronts become stable.
- Scoreboard integration that records pass count per subset and blocks
  regressions.
- Failure triage output by stage: parser / cascade / layout / paint / backend /
  guest / harness.
- A public "what we pass / what we fail / what is not implemented" report.

Victory condition:

- A contributor can clone a WPT checkout, run one command, and get a stable
  report that can be compared across commits.

## Phase 2: CSS Mechanism Completeness

Goal: make CSS breadth grow by data and common mechanisms instead of ad-hoc
property branches.

Deliverables:

- Typed shorthand expansion for `border`, `background`, `font`, `flex`, `grid`,
  `margin-*`, `padding-*`, `inset-*`, and logical shorthands.
- `calc()`, percentages, viewport units, font-relative units, and property
  dependencies resolved through explicit compute contexts.
- Custom properties and `var()` with cycle detection.
- Media queries and container queries as data-driven predicate IR.
- Cascade layers and origins: UA / user / author / inline / important.
- CSSOM bridge: JS writes to style and triggers minimal invalidation.

Victory condition:

- Common real-world stylesheets parse and compute with typed values rather than
  being preserved as opaque strings.

## Phase 3: Layout Engine Deepening

Goal: graduate from useful layout branches to browser-grade formatting
contexts.

Deliverables:

- Block formatting context: margin collapse, float intrusion, clear, containing
  block, absolute/fixed positioning rules.
- Inline formatting context: inline boxes, line boxes, baseline, bidi/shaping
  integration, atomic inline, inline fragmentation.
- Flexbox: grow/shrink/basis, wrap, align/justify, min/max content.
- Grid: track sizing, `fr`, `minmax()`, areas, auto-placement.
- Table: intrinsic sizing, border collapse, row/column groups.
- Multicol/fragmentation: break rules and column balancing.
- Hit-testing and geometry APIs derived only from `FragmentTree`.

Victory condition:

- Layout WPT and reftests grow without adding new geometry truth sources.

## Phase 4: Text, Fonts, and Internationalization

Goal: render real text, not just Latin demo strings.

Deliverables:

- Native HarfBuzz shaping adapter behind the existing `TextShaper` seam.
- FreeType or platform-font raster adapter behind the glyph coverage seam.
- Font discovery, `@font-face`, fallback chains, glyph atlas, and glyph cache.
- Complex scripts, emoji, CJK, bidi, baseline, line-height, and text decoration.
- Font loading events and CSS Font Loading API surface.

Victory condition:

- Mixed-script WPT and real webfont pages render with stable metrics and
  production-grade glyph output.

## Phase 5: DOM, JS, and WebIDL Runtime

Goal: make dynamic pages a first-class target.

Deliverables:

- Bind a real JS engine; do not write one.
- Upgrade WebIDL generation into real bindings: type conversion, exceptions,
  overloads, attributes, operations, and prototypes.
- DOM mutation -> fine-grained style/layout/paint invalidation.
- EventTarget capture/bubble/default actions, forms, focus, selection, input.
- Event loop alignment: tasks, microtasks, timers, rAF, promises, fetch, and
  render ticks.
- CSSOM, geometry APIs, and DOM APIs wired into one coherent runtime.

Victory condition:

- Official DOM/event/html/webidl WPT subsets grow with no fake APIs.

## Phase 6: Media, Canvas, SVG, and Replaced Elements

Goal: support the browser surface that real applications depend on without
turning the core into a pile of special cases.

Deliverables:

- Image pipeline: PNG/JPEG/WebP/AVIF decode through mature libraries.
- Replaced element layout: intrinsic size, object-fit, object-position.
- Canvas 2D mapped onto backend display operations.
- Static SVG render tree, then DOM-integrated SVG.
- Media boundary for video/audio with explicit decode/compositor seams.

Victory condition:

- Images, canvas, SVG, and media participate in the same layout/paint/composite
  pipeline without reverse reads into upstream stages.

## Phase 7: Network, Security, and Browser Services

Goal: be safe enough to run untrusted pages.

Deliverables:

- URL parser, origin model, CORS, CSP, referrer policy.
- Fetch: redirects, headers, MIME sniffing, streaming, cache policy.
- Cookies, storage, session/local storage, and quota boundaries.
- Sandbox/isolation model for guest code.
- Reuse system or mature libraries for TLS and HTTP stacks.

Victory condition:

- No host escape, no fake network APIs, and deterministic policy tests.

## Phase 8: Performance Leadership

Goal: make lightness and speed measurable advantages, not vibes.

Deliverables:

- Stage tracing: parse/cascade/layout/paint/backend time, memory, recompute
  counts, cache hit rates.
- Fine-grained incremental mode as the default render path.
- Selector/style sharing and invalidation indexes.
- Layout dirty regions and paint invalidation regions.
- Tile cache, glyph atlas, image cache, and parallel raster.
- Project-local performance suite plus same-machine comparisons when possible.

Victory condition:

- A small DOM/style edit recomputes only the affected graph, and CI can prove it.

## Phase 9: Open-Source Flywheel

Goal: make the project easy to trust, easy to run, and hard to corrupt.

Deliverables:

- `ARCHITECTURE.md`: the constitution and stage boundaries.
- `CONTRIBUTING.md`: how to add features without breaking the mechanism.
- Issue labels mapped to phases and WPT subsets.
- `good first issue` tasks that add real compatibility, not chores.
- RFC process for new stage seams, generated surfaces, or backend choices.
- Public dashboard generated from repository evidence.

Victory condition:

- A new contributor can run the engine in 30 minutes and land a small
  compatibility improvement in one day.

## The Next Ten Concrete Pull Requests

1. Add root WPT command and document the WPT War Room workflow.
2. Add `wpt-subsets/dom-core.json` and wire it into scoreboard regression.
3. Add `wpt-subsets/css-cascade.json` and make pass count forward-only.
4. Implement typed `border` shorthand expansion.
5. Implement `calc()` for length values.
6. Add CSS custom property parsing and unresolved token storage.
7. Add stage tracing for `qDom`, `qSheets`, `qComputed`, `qLayout`, `qPaint`.
8. Switch the CLI render path to the true incremental backend behind a flag.
9. Add HarfBuzz/FreeType adapter spike behind the existing text seams.
10. Add WebIDL binding conformance tests for generated DOM members.
