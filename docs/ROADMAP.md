# Roadmap — browser-engine-shia

The north star: **a real browser, not a test shell** — maximal web
compatibility per handwritten line, honest process/architecture boundaries,
and every compatibility claim backed by runnable evidence (WPT subsets,
differential tests, reftests).

This roadmap is ordered so each phase lands something independently
verifiable. Each item ends with **done-when** criteria — a phase is finished
when its criteria pass, not when code exists.

Legend: ✅ landed · 🟡 partial/simplified · ⬜ not started

## Phase 0 — Where we are (done)

✅ Block/inline formatting, floats, fragments, fragmentation primitives
✅ Cascade (specificity, `var()`, interpolation) + shorthand expansion
✅ Text shaping (HarfBuzz), font families/features/webfonts/synthesis
✅ Image decode (CanvasKit/Skia WASM), `srcset`/`sizes`/lazy-load, background layers
✅ Browser architecture: thin shell + per-tab web-content workers, typed IPC
   with generated codecs, navigation bridge, `TabHost`/`RemoteTab`
✅ Network: redirects, HTTP cache/revalidation, cookie scoping + SameSite,
   `nosniff`, Referrer-Policy (element attrs + document header/meta)
✅ Navigation: session history, **joint** session history across frames,
   bounded bfcache, scroll/history-state, persistence (`session.json`)
✅ Nested contexts: `src`/`srcdoc`/about:blank, sandbox tokens, frame-tree
   reconciliation on DOM mutation, `postMessage`, `WindowProxy`/`frames`,
   `contentDocument` (live wrapper + scriptless DOM facade), `frameElement`
   (in-realm), named traversables, `window.open` features, `window.close`
   (script-closable gate), `window.opener`/`e.source` reply proxies
   (postMessage/focus/closed), cross-tab `postMessage`, focus routing
✅ Forms: GET/POST, successful controls, submitter overrides,
   `requestSubmit()`, reset, beforeunload veto
✅ Storage: localStorage (persisted, atomic writes) + sessionStorage
   (lifetime + clone on `_blank`/duplicate)
✅ Downloads: same-origin `a[download]`, `Content-Disposition: attachment`,
   filename ladder, chunked writes, lifecycle events
   (started/progress/completed/failed) → `TabHost` → HTTP `/api/downloads`
   + Electron preload surface
✅ Evidence: 462 vendored WPT subtests, benchmark gate, constitution/eslint
   guards, generated-codec drift tests

## Phase 1 — Rendering breadth (biggest compat-per-line win)

🟡 **IFC completeness**: text-align/-indent, vertical-align (atomic
   members), line-height, white-space modes, hard breaks — landed
   (RFC 0014). `::first-letter` applies `font-size` and `color` to the first
   letter plus the punctuation that touches it, including when that letter sits
   in a `display: inline` descendant; collapsible whitespace before that inline
   is skipped. `float: left|right` on `::first-letter` shortens the lines the
   letter still covers. `font-weight` bolds the letter (and line 0, when
   `::first-line` sets it) without changing the element's weight.
   `font-style` italicizes the letter the same way (`oblique` shears too); the
   advance does not change, and the element's own style stays put. A face
   whose OS/2 fsSelection bit marks italic is not sheared again.
   `text-transform`, `word-spacing`, `line-height`, and `text-decoration`
   apply to the letter and, when `::first-line` sets them, to line 0.
   `vertical-align` on the letter shifts that glyph. `sub`/`super` use the
   shaper's OS/2 em when it reports one. A floated letter is also a BFC
   float, so the following block wraps beside it. A baseline `display:inline`
   with a single text child, including a nested chain of such inlines, wraps
   in the parent's lines.
   `letter-spacing` widens the letter and, when `::first-line` sets it, line 0.
   `margin` insets the letter and pushes the following text. `padding` sits
   inside that margin, and `border` sits between them: it takes space and paints
   around the letter. `background-color` fills that border box, under the border.
   `::first-line` `background-color` fills the first line's glyph run and stops
   there; the letter's fill paints over it. `background-image` on
   `::first-letter` paints in that same box: the clip is the border box, the
   position origin is the padding box, and a shorthand `no-repeat` is kept when
   a later `background-image` replaces only the url. The same image on
   `::first-line` covers only line 0, and paints under the letter's fill.
   `::first-line` applies size and color to line 0 (that size is what wraps);
   later lines keep the element's font and color. The letter's color wins.
   `linear-gradient` (`to top|right|bottom|left` or `<deg>`, two or more color
   stops) paints across the background clip box. `radial-gradient` (`circle`
   or `ellipse` at the center, two or more stops) paints from the center to
   the farthest corner of that box. A `display: inline` whose only child is
   text wraps in the parent even when `vertical-align` is not `baseline`; the
   alignment still shifts that text on its line. Open: an inline with more
   than one child stays one atomic box, and radial position or size keywords
   are not modeled. `middle` uses OS/2 x-height when present
✅ **`position: relative/absolute/fixed/sticky`** — containing-block rules
   (positioned OR transformed ancestor), % insets vs padding box,
   scroll-pinned fixed, per-axis sticky clamp, z-index group order
   (RFC 0014)
🟡 **Real flex** — direction/wrap/order, grow+shrink bidirectional
   distribution, basis (px/%/auto), gap, justify/align-*, stretch relayout
   — landed (RFC 0015). Row auto bases are max-content; free space goes to `flex-grow`
🟡 **Real grid** — template cols+rows (px/%/fr/auto/minmax/repeat),
   spans, auto-flow row/column/dense, implicit tracks via auto-rows/
   auto-columns, cell align/self + content distribution, stretch
   — landed (RFC 0015). Column and definite-row `subgrid` reuse parent tracks.
🟡 **`display: table`** — row groups (thead/tbody/tfoot + anonymous),
   colspan/rowspan occupancy, border-collapse + border-spacing, cell
   vertical-align, table-layout auto/fixed, collapsed-border conflicts
   — landed (RFC 0015). `col`/`colgroup` widths seed columns
✅ **Media queries** — `@media` evaluation sees real viewport w/h,
   orientation, DPR, prefers-color-scheme/reduced-motion, hover, range
   syntax; wired through page render + live/fine incremental paths
   (RFC 0014)
🟡 **Transforms + compositing** — transform/translate/rotate/scale matrix
   composition, transform-origin, opacity/filter layers, transform
   captures fixed CB — landed (RFC 0014). `will-change: transform|opacity|filter`
   promotes a layer. Open: scroll-driven animations.

Done-when: WPT css/css-flexbox + css/css-grid subset fixtures imported and
passing at ≥60%; position/mediaqueries subsets ≥80%; a real-site smoke set
(top-10 landing pages vendored) renders recognizably (reftest vs Chromium
screenshot tolerance).

## Phase 2 — DOM & Web API breadth

🟡 **MutationObserver** ✅ RFC 0016 — real records via `FineSession.onMutation`,
   subtree/attr/characterData filters + oldValue + reparent pairs + compound-
   microtask batching. Open: transient registrations on detached subtrees.
🟡 **IntersectionObserver + ResizeObserver** ✅ RFC 0016 — real FragmentTree
   geometry at frame/microtask boundaries: thresholds, rootMargin, element
   roots, box options, initial delivery. Open: scroll plumbing, delivery one
   microtask after eval (not in-step), stub-geometry path in the app runtime.
🟡 **Custom Elements v1** ✅ RFC 0017 — registry + lazy upgrade on wrapper
   creation (parse/createElement/innerHTML paths unified), `super()` →
   platform wrapper, connected/disconnected/attributeChanged callbacks via
   the session mutation sink, `:defined` through a cascade-visible defined
   set, customized built-ins (`{ extends }`/`is=`). Open: adoptedCallback
   (no adoptNode), reaction-queue checkpoint timing, `is=`/`extends` name-
   only cascade matching, ASCII-subset name validation.
🟡 **Shadow DOM v1** ✅ RFC 0018 — `attachShadow` open/closed on the host
   `shadow` field (light-DOM queries stay clean), composed-tree layout
   (flattened slot assignment incl. fallback content) across ALL layout
   algorithms, scoped stylesheets + `:host()` at a dedicated `shadow-host`
   cascade origin, `slotchange` (signal-deduped microtask), flattened-tree
   event paths with per-listener scope retargeting + `composed`/`composedPath`,
   `getRootNode({composed})`, `assignedSlot`/`assignedNodes`, CE lifecycle
   inside shadow trees. Open: declarative shadow DOM, `assignedNodes({flatten})`
   slot-chaining, `::slotted`/`::part`/`:host-context`, `adoptNode` across
   roots, shadow `style.sheet` wiring.
🟡 **fetch + XMLHttpRequest in guest globals** ✅ RFC 0019 — shared
   `makeFetchApi` facade (guest-realm Headers/Request/Response/
   ReadableStream, clone/bodyUsed/one-shot bodies, realm-bound error
   intrinsics); all three runners ride it (virtual resources, browserFetch
   hook, fetchFn bytes); XHR over the same fetch with spec event semantics
   (404 = load, transport = error, abort/timeout, responseType decode,
   InvalidStateError gating); `networkStackToBrowserFetch` forwards full
   init to NetworkStack. Open: Request redirect/cache/integrity/mode
   policy enforcement, streaming bodies (buffered bytes only),
   multipart/form-data, responseXML, opaque responses, upload progress.
🟡 **Keyboard/pointer event fidelity** ✅ RFC 0020 — platform events are
   real typed guest classes (`PointerEvent` family, `isTrusted`), the
   `ui` host surface drives full pointer/mouse/keyboard/focus/tab
   sequences through shared dispatch, `DomTree.uiState` feeds
   `:focus`/`:focus-within`/`:focus-visible`/`:active`/`:hover` through
   incremental computed style, focus machinery (focusable-area detection,
   activeElement/hasFocus/tabIndex, autofocus queue, mousedown
   preventDefault suppression, detach reset), keyboard text editing via
   beforeinput/input. Open: no IME composition, coalesced events are
   single-entry, `:focus-visible` is the documented heuristic, `uiTab`
   ignores sequential-focus starting points.
🟡 **Form controls v2** ✅ RFC 0021 — live control state is an IR slot
   (`DomTree.control` / `DocControl` input), `cascade/form-state.ts` is
   the single semantics source shared by pseudo-class matching and the
   script surface: 15 form pseudo-classes through incremental computed
   style, constraint validation (all ten flags, `check`/`reportValidity`,
   interactive submission blocking + focus-first-invalid, `novalidate`/
   `formnovalidate`), controls as replaced-ish layout items with
   `size`/`cols`/`rows` intrinsic sizing, full element APIs (select/
   option/textarea/output/datalist/label/form collections/
   `RadioNodeList`), radio exclusivity on activation and assignment,
   `reset()` to markup defaults. Open: datalist is model-only (no
   suggestion UI), select-one reset-on-arbitrary-mutation subset,
   `valueAsDate` null, no `appearance` widget theme.
🟡 **WebSocket** ✅ RFC 0022 — engine-side RFC 6455: HTTP Upgrade
   handshake built+validated in-engine (`Sec-WebSocket-Accept` via
   pure-TS SHA-1), frame codec (client masking, fragmentation,
   ping/pong, two-direction close), over an injected raw-socket
   transport — `nodeWsTransport()` (real TCP/TLS, tested end-to-end) +
   `createWsLoopback()` (deterministic in-memory peer). Spec failure
   surfaces: 1002/1006/1007 close codes, `SyntaxError`/`InvalidState`/
   `InvalidAccess` DOMExceptions, realm-bound `ArrayBuffer` delivery.
   Open: no extension negotiation, no proxy CONNECT, no cookie-jar
   integration on the upgrade request, no half-open detection.

Done-when: WPT dom/observers + custom-elements + shadow-dom subsets imported;
`/html/semantics/forms` fixtures ≥70%; a vendored interactive-site fixture
(todo-list app with MO-driven render) runs unmodified.

## Phase 3 — Text & i18n correctness

🟡 **Bidi (UAX#9)** ✅ RFC 0023 — full X/W/N/I pipeline: explicit-format
   controls, embeddings/overrides/isolates (incl. FSI), weak types, N0
   bracket pairs, paragraph-wide visual reordering across text nodes AND
   atomic boxes; `dir`/`dir=auto`/`unicode-bidi` through computed style +
   UA sheet (`<bdo>`/`<bdi>`); direction-aware `text-align:start`. Open:
   range-table Bidi_Class (not generated UCD), `()[]{}` bracket subset,
   no L1 line-level reset, atomic-inline boundary neutrals approximated,
   `textarea[dir=auto]`→plaintext gap
🟡 **Line breaking (UAX#14)** ✅ RFC 0024 — break-class table (BK/SP/ZW/WJ/
   GL/SHY/BA/HY/CL/OP/EX/IS/QU/NU/PR/PO/ID/CJ/RI/AL) + pair rules driving
   maximal unbreakable units through both inline paths; CJK char-level
   breaks, closing/opening punct protection, number groups, ZWSP, soft
   hyphens (`hyphens` + emitted `-`), `word-break` all three,
   `line-break:loose` (CJ), `overflow-wrap`. Open: no Thai/Lao/Khmer/Myanmar
   dictionary iterator, `strict`≈`normal`, RI always paired, `hyphens:auto`
   ≙manual (no dictionaries), cross-member shy, no pretty/balance
🟡 **Vertical writing modes** ✅ RFC 0025 — logical→physical mapping in
   the cascade (`margin-block-start`, `inline-size`, `inset-*`, logical
   border/radii re-competing under source order), virtual-space
   transposition for `vertical-rl`/`vertical-lr`/`sideways-*`,
   perpendicular + different-axis nested modes via inverse remap, and
   `text-orientation` glyph rotation metadata (`mixed`/`upright`/
   `sideways`). Open: unrotated glyph metrics (no `vert`/`vrt2` yet),
   orthogonal-child sizing approximates shrink-to-fit, replaced elements
   transpose instead of staying upright, sticky tracks `scrollY`
🟡 **Ruby** ✅ RFC 0026 — display-role partition (`ruby-text`/`-container`
   /`ruby-base`/`none`), per-item fragments with own styles, centred/flush
   alignment, over/under stacking that grows the line box, base-run atomic
   baseline, inline-level membership, `font-size:%` cascade fix. Open: no
   rb↔rt segment pairing, `space-between`≈centre, no neighbour overhang,
   nested ruby flattens, `inter-character`≈over

Done-when: WPT css/css-text + css-writing-modes + i18n fixtures ≥60%.

## Phase 4 — Security & isolation

🟡 **CSP** ✅ RFC 0027 — header+meta policies with enforce/report-only,
   source matching ('self'/'none'/nonces/hashes/schemes/wildcard hosts/`*`),
   `-elem`/`-attr`→`-src`→`default-src` fallback, script/style/img/connect/
   font/frame sinks, `style=`+`on*` attribute gates, `unsafe-eval`,
   `upgrade-insecure-requests`+`block-all-mixed-content`, `frame-ancestors`,
   `report-uri` POST delivery. Open: no `report-to`/`strict-dynamic` sinks,
   no `sandbox`/`form-action`/`navigate-to` enforcement, no `javascript:` URL
   gating, no SRI
🟡 **CORS** ✅ RFC 0028 — stack-internal enforcement: per-hop ACAO on
   every redirect hop, OPTIONS preflight through the real transport,
   CorsCache keyed (origin|url|credentials) honoring Max-Age (600s cap),
   credentials modes (omit/same-origin/include) driving cookie+auth
   attach AND strip, `no-cors` header safelisting + opaque filtered
   responses, `cors` ACEH-exposed header filtering, `crossorigin` attr
   map for img/link/script loads, always-cors `@font-face` channel, XHR
   `withCredentials`→credentials:include. Open: virtual transport is
   permissive-cors (no server headers), no redirected-preflight
   re-check, no PNA, no canvas-taint tracking
🟡 **Mixed-content + HSTS** ✅ RFC 0029 — `HstsStore` (RFC 6797: max-age,
   includeSubDomains ancestor walk, max-age=0 clears, serialize/restore
   hooks) observed only over secure transports; http→https upgrade before
   every wire byte AND on each redirect hop; baseline Mixed Content Level 2
   in the stack: blockable destinations (script/style/font/iframe/empty…)
   reject, optionally-blockable media upgrades a posteriori; iframe
   navigations declare `destination:"iframe"` so frame subloads block while
   top-level navs stay exempt; real per-URL destination wiring
   (image/style/script/font/module-cors channel) fixing SameSite=Lax on
   subresources; ws:// gate; virtual transport enforces the same verdict.
   Open: no preload list, no cert-error gate, no built-in cross-restart
   persistence, bare `nodeFetchNetworkStack` shim skips HSTS
🟡 **Site isolation** ✅ RFC 0030 — `shouldIsolateFrame` (origin-keyed,
   srcdoc/about:blank exempt) spawns a `worker_threads` worker per
   cross-origin iframe running a FULL `BrowsingContext` (nested OOPIF
   recursion, own network stack + storage registries); `IsolatedFrame` is
   the parent-side port-backed handle (url/title/composited PNG, load/
   navigate/deliver/dispose RPC, unref'd worker); `FrameChild` union with
   `instanceof` narrowing across JSH/intents/repaint/dispose; RemoteParent
   (a pageless BC subclass) gives `window.parent`/`top` real proxies from
   script-time zero — `deliverMessage`→postMessage reply,
   `navigate`→nav-out (target=_parent/_top); CSP `frame-src` gates the
   spawn. Open: remote frames are outside the joint session history
   (parent back() doesn't rewind them), no process migration on
   same-origin re-nav, `window.open(_parent)` inert, JSON-clone-only
   postMessage payloads, no renderer relaunch on crash
🟡 **COEP/COOP + credentialless + agent clusters** ✅ RFC 0031 — `coep.ts`
   pure policy (parsers total: absent ⇒ unsafe defaults; CORP absent ⇒
   same-origin); `initiatorCoep` threads every fetch — `credentialless`
   strips jar cookies + caller credentials on gated cross-origin hops,
   `require-corp` enforces CORP per redirect hop AND demands the iframe
   child's own COEP; `bootFineSession` parses the three headers pre-script;
   COOP pair check severs `window.opener` inside boot (opener identity
   rides NewTabRequest→workerData→BC deps); `crossOriginIsolated` /
   `originAgentCluster` / `isSecureContext` sandbox globals; NavState
   carries the isolation fields for chrome. Open: no PSL (last-two-labels
   site), report-only variants unparsed, no credential-partitioned HTTP
   cache, `credentialless`-child COEP relaxation unmodeled

Done-when: WPT content-security-policy + cors subsets; cross-origin iframe
fixtures prove no DOM reach across the process boundary.

## Phase 5 — Platform power

🟡 **Dedicated Workers** ✅ RFC 0032 — `new Worker(url)` spawns a real
   `worker_threads` realm (`dedicated-worker.ts`) with the
   DedicatedWorkerGlobalScope surface (`self`, `postMessage`, `close`,
   `importScripts`, `onmessage`/`onerror`, listeners, real timers,
   `location`, `name`); the thread's own Node loop IS the worker event
   loop. Parent-side (`worker-global.ts`): script fetched through a
   dedicated `destination:"worker"` + `mode:"same-origin"` channel
   carrying the document's COEP; `worker-src` CSP gates the spawn
   (async error event, not a throw); pre-spawn posts queue and flush;
   inbound messages dispatch as virtual-loop tasks; V8 structured
   clone payloads; construction-time registry +
   `disposeWorkers`/`BrowsingContext.dispose()` teardown (unref alone
   doesn't survive `node --test`). Open: `type:"module"` is an honest
   TypeError (no worker ESM graph), worker `fetch`/`importScripts`
   bypass the page's jar/CSP/COEP (raw undici/curl), no transferables,
   no nested workers (SharedWorker landed separately — RFC 0042)
🟡 **Service Workers** ✅ RFC 0034 — `navigator.serviceWorker.register`
   spawns a real `worker_threads` SW realm (install/activate/fetch/message
   events with waitUntil/respondWith, `caches`, `clients`, `skipWaiting`),
   and every controlled client's request — navigations AND subresources —
   dispatches `fetch` through the interception seam INSIDE the network
   stack (post request-gates, pre HTTP cache). The worker's own `fetch`
   loop-backs through the stack (cookies/CORS apply, self-interception
   impossible). Registrations live per-stack → survive tab navigations;
   scope = longest-prefix match. Open: claim-always control model, no
   update lifecycle, in-memory per-realm caches, no push/sync,
   prefix scope matching
🟡 **SharedWorker** ✅ RFC 0042 — `(url, name)`-keyed shared realms on
   `worker_threads`: each connect is a lane (MessagePort-shaped port with
   spec queuing/start/onmessage semantics on both sides, incl. the
   addEventListener-doesn't-start quirk); registry bound on the stack ⇒
   context-tree sharing incl. same-origin iframes + survives navigations;
   `destination:"sharedworker"` script channel, `worker-src` CSP gate,
   last-lane teardown evicts the realm; `type:"module"` honest TypeError.
   Open: no MessageChannel for documents, no transferables/nested spawn
🟡 **`<canvas>` 2D** ✅ RFC 0033 — `Canvas2DEngine` (`canvas2d.ts`) records
   an op log and rasterizes lazily through the existing CanvasKit/Skia
   backend; `canvas2dApi` is the guest-facing `CanvasRenderingContext2D`
   (paths/Path2D, transforms, gradients/patterns, real text +
   `measureText`, `ImageData`, `drawImage` from canvas/OffscreenCanvas/
   decoded `<img>`, `isPointInPath`/`isPointInStroke` via real Skia
   geometry, dashes, shadows, composites). Element wiring: one context per
   NodeId, `width`/`height` writes reset bitmap+state (IDL and
   `setAttribute`), real `toDataURL`/`toBlob` PNG. Bitmaps ride the same
   `imageOf` channel as `<img>` (`boot.canvas.bitmaps` → paint) and live
  `drawImage(imgEl)` resolves through a per-render decoded-images box.
   Also fixed two latent bugs it exposed: the IFC line box now grows
   upward for tall atomics (§10.8), and `loadPage`'s bare fetchFn adapter
   no longer shadows the gated subresource channel (CORP/destination/
   mode were being skipped). Open: PNG-only encode, no ImageBitmap/
   transferToImageBitmap, no video/SVG drawImage sources, no canvas
   tainting, cold-CanvasKit degrades to `undefined`/1×1, some text+filter
   fields stored-not-painted
🟡 **`<video>/<audio>`** ✅ RFC 0035 — `MediaEngine` (`media.ts`) drives the
   HTMLMediaElement state machine over a two-decoder bridge: pure-TS
   RIFF/WAVE + an ffmpeg/ffprobe subprocess bridge (probe, RGBA `frameAt`,
   f32 PCM). Fetch goes through the page's own stack — `destination:
   "video"|"audio"`, `media-src` CSP gate, `crossorigin`→CORS, COEP honored;
   `preload`/`autoplay`/`loop`/`controls`/`muted`/`volume`/`playbackRate`
   and the full event set fire on the document's virtual-loop clock (no
   second clock to drift). `<source>` children filter by `type`
   (`canPlayMime`) and `media` (`mediaQueryListMatches`); `src`/`currentSrc`/
   `play()`/`pause()`/`load()`/`seeking`/`buffered`/`TimeRanges` all real;
   `HTMLVideoElement`/`HTMLAudioElement`→`HTMLMediaElement`→`HTMLElement`
   chain + `new Audio(src)`. `<video>` is replaced (probe dims, else the
   300×150 default-object size); `audio[controls]` paints a 300×54
   placeholder; decoded frames + poster ride the `imageOf` channel with
   `object-fit:contain`. `prime()` runs inside the page resource pass so
   scriptless docs still load/frame media. Open: whole-file buffering (no
   Range/streaming — `buffered` reports [0,duration]), no audible output
   (PCM decodes; timeline advances muted), frames decode per-paint (no
   autonomous repaint), no textTracks/EME/MSE/captureStream, ffmpeg is a
   host dep (absent → WAV only)
🟡 **WebGL/WebGPU** — RFC 0036: software-GL WebGL1 shipped (GLSL front-end → AST interpreter → perspective-correct rasterizer; depth/blend/scissor/FBO-lite/readPixels; guest `WebGLRenderingContext` + mode lock + OffscreenCanvas). WebGPU hardware device stays opportunistic (navigator.gpu/Dawn). No WebGL2, no extensions — documented
🟡 **a11y tree** — RFC 0037: real AX extraction shipped (ARIA-in-HTML implicit roles + `role=` override, accName ordering w/ name-from-content gate, full state set, absolute fragment geometry, display/hidden/aria-hidden pruning, per-frame rebuild through finishPage). `axSnapshot`/`axDump`/`AXBridge` seam ship; OS AT IPC (AT-SPI/NSAccessibility/UIA) needs native bindings — documented boundary

Done-when: WPT workers + html-canvas subsets; service-worker `install/
fetch/offline` fixture path works end-to-end. **Phase 5 feature set now
fully landed**: workers (dedicated+service), `<canvas>` 2D, media elements,
WebGL1 software device, a11y tree, SharedWorker.

## Phase 6 — Perf engineering

🟡 **Incremental layout** — RFC 0038: mutation→damage tracking
   (structural/content/global marks off the `#emitMutation` funnel) +
   boundary replay in `layoutNode` (BFC roots, flex/grid/table/multicol/ruby
   containers, flex/grid items, replaced elements); replayed subtrees mint
   fresh fragment ids; OOF-leak subtrees never cached; epoch invalidates on
   viewport/scrollY/sheet-loader changes; non-boundary blocks still re-lay
   out (in-flow floats/margins cross them); benchmark `subtreeReuse` records
   hits + replay-correctness + warm/cold wall-time
🟡 **Paint invalidation + retained surface** — RFC 0039: display-list
   prefix/suffix diffing → damage-rect union (+ focus-overlay bounds) →
   scissored repair into the retained frame buffer; identical frames skip
   rasterization entirely; transform/filter layers force a full render
   (bounded honestly); benchmark `paintDamage` records changed-command
   counts + damage-area fraction + byte-identical correctness
🟡 **True streaming network** — RFC 0040: `requestStream()` exposes a
   live `bodyStream` per final redirect hop (undici body or `curl -N`
   stdout; intermediate hops cancelled, not buffered); per-chunk
   `NetworkProgressEvent` wire-byte progress; guest `Response.body` is a
   real pull-queue (`getReader`/async-iter/`clone` tee/`bodyUsed`), XHR
   fires real progress events; `AbortSignal` + reader-cancel kill the
   transport (`AbortError` to consumers, ~16 ms vs 30 s timeout);
   navigation feeds `IncrementalHtmlParser` — chunked ≡ buffered output
🟡 **GC'd DOM wrappers** — RFC 0041: session wrapper + style-declaration
   caches are WeakRef+FinalizationRegistry (`WrapperCache`) — collectible
   when guest-unreferenced, canonical-while-alive, ABA-safe eviction;
   node-keyed engine state (listeners, canvas bitmaps, control state)
   correctly stays strong — wrapper lifetime follows script reachability,
   engine state follows node membership; navigation drops the session
   closure wholesale (bfcache retains deliberately)

Done-when: benchmark dashboard shows incremental-layout win on mutation-
heavy fixtures; streaming download progress events reflect wire bytes.

## Standing work (every phase)

- WPT subset expansion as each capability lands (the `wpt-fixtures`
  harness + `npm run wpt -- <path>` already accept real WPT checkouts).
- Reftest pairs for each rendering milestone (Chromium screenshot
  tolerance where available).
- RFC per phase, honest-boundaries sections kept current — every claimed
  feature must state what it does NOT do.

## Explicit non-goals (permanently, unless rescoped)

- No JIT'd JS engine of our own — embed V8/JSC if/when VM performance or
  spec-faithful DOM bindings become the blocker (a real engine embed is a
  Phase 5+ decision with a dedicated RFC).
- No OS-level popup chrome/dialogs — popup features stay hints.
- No same-process shortcut for cross-origin DOM — WindowProxy honesty is a
  design invariant, not a convenience.
