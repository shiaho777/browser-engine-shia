# RFC 0004: App process model — generated IPC + per-tab web-content worker

Status: Implemented

Owner: engine contributors

Labels:
`rfc`, `stage:app`, `phase:shell`

## Decision

Split `packages/app` into the two halves a real browser keeps separate:

- **Browser process (thin shell)** — `server.ts` (HTTP), `electron/main.mjs`
  (Electron main), the tab strip's bookkeeping, and a typed IPC client per
  tab. It owns *chrome*: routes, tab list, and routing — never a `DomTree`.
- **Web-content process (worker)** — a `node:worker_threads` worker **per
  tab** that owns `TabSession`: the whole content pipeline (fetch → parse →
  cascade → layout → paint → raster → PNG), the guest `FineSession`, page
  state, scroll/focus, and session history.

Between them sits a new **`@browser-engine/ipc` package**: a declarative
message schema (data), a codegen emitter that produces a committed binary
codec (`src/generated/protocol.ts`, drift-tested like the CSS/DOM tables —
frames cross the wire as raw `bytes`, never base64), and a request/reply
`RpcChannel` over a minimal `PortLike` endpoint (`worker_threads`
`MessagePort` in production, a loopback pair in tests).

## Problem

Today the whole pipeline runs **in the HTTP server process**: `server.ts`
calls `TabSession.navigate` → `loadPage` → `bootFineSession` → layout →
paint → raster on the same event loop that answers `/api/frame`. The shell
the user reviewed is therefore a test harness, not a client:

- A guest script or layout bug that wedges a tab wedges the *whole* shell —
  no isolation, no crash boundary, no respawn.
- Tab state and chrome state are one object graph; the Electron main and the
  web server duplicate the same in-process `TabHost`.
- There is no wire protocol at all, so nothing can ever run out of process —
  the "browser" is a function call away from `document` internals.

## Goals

- Real process separation: one web-content worker per tab; a crashed or
  killed worker fails *that tab's* replies and is lazily respawned — the
  shell, other tabs, and in-flight requests survive.
- A **generated** wire codec: the message table is data; `npm run generate
  --workspace @browser-engine/ipc` regenerates `protocol.ts`; a drift test
  pins committed output to the schema.
- Frames as binary payloads on the wire (`Uint8Array`, transferred) — the
  HTTP edge still base64s for legacy JSON clients, the worker doesn't.
- Zero HTTP/UI surface change: SHELL_HTML and every `/api/*` route keep
  their shape; only the transport behind them changes.
- `site-check` rides the same client — the evidence harness exercises the
  real process boundary instead of a private in-process path.

## Non-Goals

- Multiple renderer kinds / site isolation (one worker kind, one per tab).
- Sandboxing/seccomp; a worker is a thread, not a security boundary (Node
  workers share the address space isolate-wise but not privileges).
- Bfcache/session-restore across process restarts; a respawned renderer
  reloads from its last history entry.
- Shared-memory frame transport; PNG bytes are copied into the frame buffer
  then transferred — zero extra copies beyond the message itself.
- GPU/Chrome-style `NavigationController` split: session history stays in
  the web-content worker for this RFC (per-renderer session history), with
  the split noted under Open Questions.

## Proposed Mechanism

```
┌── browser process ──────────────────────────────────────────────┐
│ server.ts  →  TabHost(shell)  →  WebContentClient ──RpcChannel─┐ │
│   SHELL_HTML   tab list/nav      per tab                        │ │
│ electron/main.mjs ──────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────┘
                 │  ArrayBuffer frames  ([len][reqId][tag][payload])
                 ▼
┌── web-content worker (one per tab) ─────────────────────────────┐
│ webcontent-worker.ts: dispatch → serialized op queue → TabSession │
│   loadPage / bootFineSession / layout / paint / raster / hitTest  │
└───────────────────────────────────────────────────────────────────┘
```

### `@browser-engine/ipc`

`src/schema.ts` declares the protocol as data — structs, enums, and
request/reply message rows with a small field DSL (`u8/u16/u32/i32/f64/
bool/string/bytes`, `T?` nullable, `T[]` lists, `struct:Name`,
`enum:Name`). `src/emit.ts` renders `src/generated/protocol.ts`:

- `Writer`/`Reader` — DataView cursor over a growable `ArrayBuffer`
  (utf8 strings as `u32 len + bytes`, byte blobs as `u32 len + bytes`).
- `encode<Name>` / `decode<Name>` per message, `MessageTag` constants,
  and `encodeRequest/decodeRequest`/`encodeReply/decodeReply` envelopes:
  `[u32 len][u64 reqId][u16 tag][payload]`, error replies carry a single
  `message` string under a reserved tag.
- `RpcChannel` (`src/channel.ts`) — pending-map correlation, reply
  routing, error propagation; transport-agnostic `PortLike` so tests use
  a loopback port without spawning a worker.

### App rewiring

- `webcontent-worker.ts` — worker entry: constructs `TabSession`, runs a
  serialized op queue (a renderer handles nav ops in order), replies on the
  port, exits on `Dispose`.
- `webcontent-client.ts` — `WebContentClient`: spawns the worker, exposes
  the session ops as typed RPCs (`load`, `loadHtml`, `reload`,
  `setViewport`, `scroll`, `hitTest`, `focus`, `blurFocus`, `commitText`,
  `pump`, `frame`, `navState`, `dispose`), marks the renderer dead on
  `error`/`exit` (pending calls reject; next call respawns).
- `tab-host.ts` — shell-side `TabHost`: keeps only `{id, title, url,
  active}` plus cached nav/frame metadata refreshed from replies; `create/
  select/close` map to spawn/terminate. `TabSession` itself is unchanged
  and stays the worker-side class — its unit tests keep running in-process.
- `server.ts` — same routes, new host; `/api/frame` becomes an awaited
  `frame()` RPC instead of a field read.
- `electron/main.mjs` — swaps its in-process `TabHost` import for the same
  client host.
- `site-check.ts` — `checkSite` gains a worker-backed path through
  `WebContentClient` so the harness measures the real boundary.

## Stage Boundary Check

- Upstream stages read: none — app composes existing stage APIs behind
  `TabSession`.
- Downstream stages written: none — the wire carries `PageFrame`/hit/edit
  results as plain data, never IR.
- IR boundary used: unchanged — `DomTree`/`FragmentTree`/`DisplayList`
  never cross the wire; only rendered PNG + derived metadata do.
- New generated surface: `packages/ipc/src/generated/protocol.ts`.
- Manual invalidation API added: no
- Silent stub path added: no (worker crash surfaces as an error reply, and
  crash respawn is explicit in `WebContentClient`)

## Evidence Plan

```bash
npm run typecheck
npm run lint
npm run test
npm run wpt:subsets -- --trace
npm run evidence
```

- `packages/ipc`: codec round-trip tests for every message row (incl.
  `bytes` payloads and nullable fields), drift test pinning committed
  output to the schema, channel tests over a loopback port (reply routing,
  error propagation, out-of-order replies).
- `packages/app`: a `webcontent` test that spawns a real worker — navigate,
  hit-test, edit, pump, kill-respawn — proving end-to-end separation.
- `server.test.ts`/`electron-bridge.test.ts` keep exercising their HTTP/
  IPC surfaces unchanged (now backed by real workers).
- Smoke: `npm run app:no-open` + curl `/api/navigate` + `/api/frame`.

## Alternatives Considered

1. **Structured-clone JSON-RPC over `postMessage`.** Rejected: it makes the
   wire an accident of `postMessage` semantics — no codec to generate, no
   byte discipline, PNG would ride base64 inside JSON. A generated binary
   codec is the honest mirror of what Mojo/LibIPC do, and it is what this
   repo's data-driven ethos prescribes.
2. **One shared worker for all tabs.** Rejected: no isolation — the exact
   property a process model exists to provide. Per-tab workers are the
   Chrome/Ladybird shape and cost one thread each.
3. **`node:child_process` instead of `worker_threads`.** Deferred: workers
   inherit execArgv (`--experimental-vm-modules` for guest ESM) for free and
   support `MessagePort` transfer; a real process fork is a one-flag swap
   behind the same `PortLike` seam if we want OS isolation later.
4. **History in the shell.** Deferred (see Non-Goals): per-renderer session
   history keeps `TabSession` semantics intact and avoids a navigation-commit
   protocol for now.

## Risks

- **Latency**: every `hitTest`/`frame` is now a round trip (~µs–ms). The UI
  already batches input through HTTP; acceptable, and the codec is cheap.
- **Worker startup cost**: spawning per tab adds ~tens of ms and module
  load (HarfBuzz TLA). First tab boots lazily; `create()` shows the tab
  instantly and the first navigate carries the cost it already carried.
- **ESM-in-worker + `vm.SourceTextModule`**: the relaunch flag is inherited
  via `execArgv`; covered by the smoke test.

## Rollback

`tab-session.ts`, `page.ts`, and `engine-runtime.ts` are untouched — the
worker hosts them verbatim. Reverting is deleting `packages/ipc`,
`webcontent-*`, `tab-host.ts`, and pointing `server.ts`/`electron`/`site-
check` back at `TabHost` — a small, revertible diff.

## Open Questions

- Should session history move to the browser process with a
  navigation-commit message pair (the Chrome shape)? Doing so makes
  renderer swap-on-crash truly lossless but adds a second protocol layer.
- Do we want a dedicated network/loader process, or keep `fetch` inside
  web-content for now?
- Frame push events (`FrameReady` notification) vs. today's pull
  `/api/frame` — needed once the shell becomes a real compositor.
