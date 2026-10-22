# RFC 0030 — Site Isolation (OOPIF)

Status: implemented (cross-origin iframes run in their own worker; honest
WindowProxy-only boundary).

## Decision

`shouldIsolateFrame(initiator, resolved)` (packages/app/src/site-isolation.ts)
decides per iframe: an `http(s)` child whose **origin differs from the
embedding document's origin** runs out-of-process. `about:blank`/`srcdoc`
children inherit the embedder's origin and are never isolated.

The isolated child is a `worker_threads` worker running **a full
`BrowsingContext`** (packages/app/src/oopif-worker.ts) — the same class the
in-process frame tree uses, so layout, scripts, storage, nested iframes and
(recursive) site isolation inside an OOPIF all work unchanged. Each worker
owns its own `BrowserNetworkStack` (cookie jar, HTTP cache, CORS/HSTS
policy), `LocalStorageRegistry` and `SessionStorageRegistry`.

The parent keeps an `IsolatedFrame` (packages/app/src/isolated-frame.ts): a
port-backed surface holding the committed `url`/`title`, the latest
composited PNG (`framePngBytes`), and RPC for load/navigate/deliver/dispose.
`BrowsingContext.#frames` is now `Map<NodeId, FrameChild>` where
`FrameChild = BrowsingContext | IsolatedFrame`; joint-history walks, intent
drains, repaints and disposal narrow with `instanceof BrowsingContext`.

## The remote embedder

Inside the worker, `window.parent`/`window.top` must resolve **before any
child script runs** — post-commit patching is too late (scripts execute
inside `#loadDocument`). So `deps.parent` and `deps.root` are a
`RemoteParent` — a real `BrowsingContext` subclass that never loads a page,
constructed once per worker:

- `deliverMessage` ⇒ posts a `postMessage` reply to the embedder thread;
  the parent's `IsolatedFrame.onMessageOut` feeds it into the parent
  context's real `deliverMessage` (origin check, JSON clone, `event.source`
  = the remote frame's WindowProxy, `event.origin` = the child's origin).
- `navigate` ⇒ posts a `nav` reply; `IsolatedFrame.onNavigateOut` navigates
  the embedder context — `target=_parent`, `parent.location =`, and
  `navigateParent`/`navigateRoot` host hooks all route here.
- `proxyFor` is inherited, so `event.source` inside the remote document is
  a live reply channel (`e.source.postMessage` → `postMessage` reply →
  embedder's message event), and `window.parent.document` is correctly
  absent (RemoteParent has no page ⇒ `documentFor` ⇒ null).

Parent→child traffic is symmetric: `iframe.contentWindow` resolves to
`IsolatedFrame.proxyFor(parentCtx)`, whose `postMessage` posts a `deliver`
request the worker answers with the real `deliverMessage` (sender-side
`event.origin` = the embedder's origin, computed from `source.url` on the
parent side — NOT self-reported by the remote frame).

## Process boundary, honestly

- **No DOM reach**: `contentDocument`, `contentWindow.document`, and
  `documentFor` are all null across the boundary — verified by test.
- **Bitmap compositing**: the worker renders its own document and returns
  PNG bytes in every load/navigate result; `#refreshFrameImages` treats it
  identically to an in-process `page.pngBytes`.
- **Lifecycle**: remote frames are spawned on child discovery and on
  attribute-drift reloads; `dispose` terminates the worker (frame removal,
  teardown, failed loads). The worker is `unref`'d so it never holds the
  embedder's event loop.
- **CSP `frame-src`** still gates the spawn in the parent; the remote
  document's own CSP/HSTS/CORS apply inside its worker because the whole
  policy stack is per-`BrowsingContext`-deps, not global.

## Boundaries (explicit)

1. **No joint-session-history across the boundary** — a remote frame's
   `canGoBack`/`canGoForward` are `false` parent-side; the parent JSH has
   no remote parts, so top-level `back()` does not rewind remote children
   (worker-local history does work inside the worker).
2. **No process migration** — a remote frame that navigates same-origin
   stays in its worker (no rejoin), matching how real browsers treat
   already-committed site instances.
3. **`window.open(url,"_parent")`/`sessionHost.submit` on the remote
   parent is inert** — intents queue on a context that never drains;
   `target=_parent` *links/forms* work because they ride `navigateParent`
   (→ `RemoteParent.navigate` → `nav` reply).
4. **postMessage payload is JSON-cloned** — no structured-clone
   transferables, no SharedArrayBuffer/MessagePort porting (SAB is also
   meaningless across threads without COOP/COEP — see RFC 0031).
5. **Worker crash** rejects pending load/navigate calls and leaves the
   frame blank; there is no renderer-relaunch-on-crash yet.
6. **No `window.frames[N]`/`parent.frames` enumeration over the wire** —
   `frames`/`length` inside the worker reflect its own in-worker children.

## Evidence

`packages/app/src/site-isolation.test.ts` — 4 tests over real loopback HTTP
(two origins by port): isolation decision matrix; cross-origin iframe boots
in a worker (committed URL, composited bitmap, `load` event on the iframe
element) while exposing NO document/globals parent-side; same-origin stays
in-process; a full parent↔child postMessage round-trip with correct
`event.origin`, live `event.source` reply channel, and
`window.parent !== window` inside the remote document.
