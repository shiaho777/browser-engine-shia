# RFC 0040 — Streaming Networking + Incremental Navigation Parsing

Phase 6 (perf). Before this RFC every response was fully buffered: the
network stack awaited `arrayBuffer()`, the document parser tokenized a
complete string, and guest `fetch()` only produced a `Response` once the
last byte landed. A 1 GB download allocated 1 GB; a slowly-streamed
document painted nothing until the wire went quiet.

This RFC makes the byte stream the unit of transfer end-to-end:

```
socket ─► transport leg (undici body / curl -N stdout)
        ─► StreamingNetworkResponse { bodyStream, bytesReceived, cancel }
        ─► NetworkProgressEvent { url, receivedBytes, totalBytes }
        ├─► guest fetch: ChannelStream → Response.body (getReader/async-iter)
        ├─► XHR: progress per wire chunk, real loaded/total
        └─► navigation: IncrementalHtmlParser → committed Document
```

One invariant: **the wire is never drained into memory before consumers
ask for bytes.** Where the spec forces buffering (no-cors opaque, 304
revalidation, cache/SW hits) we adapt — but the live path pushes, never
pre-buffers.

## StreamingNetworkResponse (`guest/network.ts`)

`NetworkStack` gains `requestStream(req)` alongside `request(req)`:

```ts
interface StreamingNetworkResponse {
  url: string; status: number; ok: boolean;
  headers: Record<string, string>;
  bodyStream: AsyncIterable<Uint8Array>;
  bytesReceived(): number;
  totalBytes: number | null;   // Content-Length, else null
  collect(): Promise<Uint8Array>;
  cancel?: () => void;         // kills the wire (curl child / undici body)
}
```

- Redirect hops consume the same loop — intermediate live heads are
  `cancel()`ed, only the final hop's `bodyStream` is exposed.
- `progress: NetworkProgressEvent[]` on the stack records one event per
  wire chunk (`receivedBytes` cumulative, `totalBytes` null when the
  server did not say).
- HTTP-cache and service-worker hits resolve as **one-chunk streams** —
  the interface is uniform, the provenance differs.
- Partially-consumed bodies are never inserted into the HTTP cache:
  `collect()` is the only writer, and a `cancel()`ed body never reaches it.

## Transport legs

**Undici** — `requestViaFetch` splits into `requestHeadViaFetch` (await
headers, don't touch the body) + `readBody`. The live leg exposes
`res.body` (WHATWG ReadableStream) as an AsyncIterable without reading it.

**curl** — `requestStreamViaCurl` spawns `curl -N` (unbuffered stdout)
with `-D <tmpfile>` for headers. Listeners for `data`/`end`/`close`/`error`
attach **immediately after spawn** — a fast response can emit before the
header file is polled, and late listeners miss the events (the exact
deadlock this RFC's first draft hit: close-before-listen → queue never
woke → 30s hangs). `cancel()` kills the child and unlinks the temp files.

Selection is unchanged: `preferCurl` when verbatim navigation headers are
required, undici otherwise. Both legs produce the same `LiveHead` shape.

## Cancellation and abort

`StreamingNetworkResponse.cancel()` reaches the transport:

- Every hop-processing rejection path (CORS, COEP, nosniff, redirect
  error, 304 revalidation) cancels the live head before throwing — no
  leaked curl children, no half-open undici bodies.
- Guest `AbortSignal` → `abortNow()`: `sres.cancel()` kills the wire and
  `ch.error(AbortError)` rejects pending/future readers. Verified: an
  abort mid-body rejects `text()` with `DOMException AbortError` in ~16 ms
  (was: 30 s waiting on `curl --max-time`).
- `ChannelStream.cancel()` (consumer calls `reader.cancel()`) fires
  `onCancel` → `sres.cancel()`, and wakes suspended readers — a cancelled
  reader cannot hang.

## Guest fetch (`fetch-api.ts`)

`Response` accepts a live `bodyStream`; `BodyState` gains a streaming
mode:

- `res.body.getReader()` and `for await` yield `Uint8Array` chunks as they
  land — not on completion.
- `text()`/`json()`/`arrayBuffer()`/`blob()` drain the live stream.
- Double-consumption rejects `TypeError`; `bodyUsed` reflects real use.
- `clone()` tees the **raw** live source (`teeStream`): the original
  stays usable, both branches get every chunk, per spec.
- Cancellation propagates to the wire via `onCancel`; abort propagates
  as `AbortError` errors to readers, not just a rejected fetch promise.

`XHR` (`cli/event-loop.ts`) consumes the live body directly: `progress`
events fire per wire chunk with real `loaded`/`total`/`lengthComputable`,
`responseText` accumulates, `responseType` (text/json/arraybuffer/blob)
resolved at `load`, `abort()`/`timeout` cancel the transport.

## Incremental navigation (`app/page.ts`)

`IncrementalHtmlParser` (`html-parser`) wraps the existing tokenizer +
tree builder: `feed(chunk)` accumulates and tokenizes incrementally,
`finish()` runs the tree build once. Navigation now:

1. `requestStream()` the document — headers land first, CSP/navigation
   decisions run on complete headers.
2. `Content-Disposition: attachment` short-circuits to the download
   path (collecting the body for the handler, unchanged semantics).
3. Chunks feed the parser as they arrive; `page.documentStream` exposes
   the in-flight parse state.
4. On `close`, the final tree commits as the Document — identical output
   to the buffered path, asserted byte-for-byte in tests.

Buffered navigation remains the fallback for stacks without
`requestStream` (custom `NetworkStack` implementors).

## Boundaries (honest)

- `IncrementalHtmlParser` feeds the tokenizer incrementally but builds
  the tree once at EOF — `<script>` execution ordering and speculative
  lookahead are not modelled; painting still happens post-commit.
- `totalBytes` is Content-Length only — chunked/gzip'd lengths are
  unknown until EOF (reported as `null`, `lengthComputable: false`).
- curl streaming is subprocess stdout — no HTTP/2 push, no HTTP/3.
- `ReadableStream` here is a minimal pull-queue (`getReader`,
  `Symbol.asyncIterator`, `cancel`) — not transferable, no BYOB reader,
  no piping. `pipeTo`/`pipeThrough` are future work.
- The HTTP cache stores only completed bodies; range/streaming cache
  slices are out of scope.

## Evidence

- `fetch-stream.test.ts` 7/7 — live `getReader` chunks, async iteration,
  `text`/`arrayBuffer` drain, double-consumption TypeError, live `clone()`
  tee, per-chunk wire progress with redirect final-hop, XHR progress,
  `AbortSignal` → wire-kill + `AbortError` to consumers (16 ms).
- `stream-nav.test.ts` 2/2 — chunked nav ≡ buffered nav output;
  arbitrary chunk boundaries produce the same DOM.
- Regression: session 12/12, service-worker 3/3, rfc-next 44/44 green;
  no leaked curl/node processes after abort or failure paths.
- Full `npm run ci` green with the streaming path active by default —
  every existing test navigates through the live path.
