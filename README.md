# browser-engine-shia

A from-scratch browser engine built to be read front-to-back. North star:
**highest compat-per-LOC** (passing WPT subset tests per hand-written line),
not feature count.

The current codebase is a working experimental engine, not a production browser:
it can parse HTML/CSS, cascade generated CSS properties, lay out block/inline
content plus several advanced branches, paint a backend-agnostic DisplayList,
and rasterize that list to PNG through the software/GPU backend.

## Monorepo layout

The engine is a single-direction, compiler-style pipeline. Each package is a
stage that communicates only through frozen IR (design.md §4, §6):

| Package | Role |
| --- | --- |
| `ir` | Strongly-typed immutable inter-stage IR boundary |
| `kernel` | Incremental computation kernel (queries, no manual stale-marking) |
| `generator` | Platform-as-Data code generator (CSS table + WebIDL → code) |
| `html-parser` | HTML5 tree construction → DomTree (`qDom`) |
| `css-parser` | CSS → Stylesheet IR (`qSheets`) |
| `cascade` | Cascade / computed style → ComputedStyle (`qComputed`) |
| `layout` | Layout → FragmentTree, the sole source of geometry (`qLayout`) |
| `paint` | Paint → DisplayList, backend-agnostic commands (`qPaint`) |
| `font` | Built-in glyph coverage/rasterization seam for future native shaping |
| `gpu` | Software/GPU-style command execution and compositing |
| `backend` | Screenshot backend + PNG encoder consuming only DisplayList commands |
| `guest` | Guest DOM/runtime surface, event loop, fetch, FontFace support |
| `cli` | `render <html> -o out.png` pipeline entry point |
| `scoreboard` | compat-per-LOC + WPT pass-count publisher |
| `test-harness` | WPT subset runner, reftest, naive-vs-incremental diff |
| `benchmark` | Live repository metrics + cited Chromium comparison report |

## Strategic docs

- `ROADMAP.md` — the phase plan for turning this into a universal,
  browser-class open-source engine.
- `ARCHITECTURE.md` — the constitution: IR boundaries, incrementality, geometry,
  backend, runtime, and WPT contracts.
- `CONTRIBUTING.md` — how to add CSS, DOM, layout, paint, backend, and WPT
  features without breaking the mechanism.
- `docs/WPT-WAR-ROOM.md` — official WPT workflow and failure classification.

## Development

```bash
npm install
npm run typecheck   # tsc --strict across the whole monorepo
npm run lint        # ESLint baseline (constitution rules attach here)
npm run ci          # typecheck + lint + tests, mirrors the CI entry point
npm run benchmark   # recompute BENCHMARK.md from live repository metrics
npm run wpt         # run vendored WPT-format fixtures
npm run wpt -- /path/to/web-platform-tests/dom --limit 100

node packages/cli/dist/index.js render input.html -o out.png
```

Phase 0 is the "constitution": architectural invariants are enforced by the
type system and CI (`.github/workflows/ci.yml`), not by convention.

## Current status

- `npm run ci` is the main gate: strict TypeScript, ESLint constitution rules,
  deliberate violation fixtures, WPT subset checks, reftests, and differential
  tests.
- CSS Platform-as-Data is live for hundreds of properties; real cascade output
  can trigger layout/compositing fields such as `position`, `float`, `flex`,
  `grid`, `opacity`, `transform`, `z-index`, padding/border/overflow, and more.
- Text output currently uses the engine's built-in glyph coverage path. Native
  HarfBuzz/FreeType integration remains a future backend/shaping upgrade.
- WPT coverage is a curated subset plus imported-suite tooling, not a claim of
  full official WPT or browser compatibility.
