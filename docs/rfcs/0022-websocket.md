# RFC 0022 — WebSocket: engine-side RFC 6455 over injected raw sockets

Status: implemented (full client handshake + framing, documented transport edges)
Packages: `guest` (`websocket.ts` — handshake/codec/class/transports;
`event-system.ts` — `MessageEvent`/`CloseEvent`), `cli` (`script.ts` —
`domGlobals.WebSocket`, `wsTransport` option, `bindWsRealm`;
`event-loop.ts`/`esm-runner.ts` — option passthrough + realm binding;
`websocket.test.ts`)

## Decision

**The wire format lives in the engine; the transport is a dumb byte
pipe.** `WsTransport.connect(url)` returns a `RawSocket` — `write`,
`close`, `onData`/`onClose`/`onError`. Everything above it is engine
code: the HTTP/1.1 Upgrade request is built and validated here
(`buildHandshakeRequest`, `parseHandshakeResponse`, `wsAccept` over a
pure-TS SHA-1), the frame codec does client masking, extended payload
lengths, fragmentation reassembly, control-frame rules, ping→pong, and
the two-direction close handshake. This is the same layering a real
browser uses — HTTP machinery negotiates the upgrade, then the socket
handed to the WebSocket protocol layer is raw.

Two transports ship:

- `nodeWsTransport()` — real `node:net` (ws:) / `node:tls` (wss:, SNI
  from host) sockets. Genuinely async; a test roundtrips over a real
  TCP port.
- `createWsLoopback()` — in-memory peer for tests/dev: the "server"
  sees the client's raw request bytes, auto-computes the 101 accept
  (or `respond(fn)` overrides it), decodes masked client frames, and
  emits server frames. Deterministic, no clocks.

A guest with **no configured transport** still gets a real `WebSocket`
class — connections fail the spec-shaped way (`error` + `close` 1006,
never a thrown error).

## Semantics implemented

- Constructor: base-URL resolution, `ws:`/`wss:` scheme gate, fragment
  rejection, subprotocol token + duplicate validation — all
  `SyntaxError` DOMExceptions.
- Handshake validation: 101 status, `Upgrade`/`Connection` tokens,
  `Sec-WebSocket-Accept` equality (SHA-1 of key+GUID), and negotiated
  `Sec-WebSocket-Protocol` must be one we offered — else fail.
- `readyState` constants on both class and prototype; `url`,
  `protocol`, `extensions`, `bufferedAmount` (accrues even on
  discarded post-close sends, per HTML §9.3.3), `binaryType`
  (`"blob"`→guest `Blob`, `"arraybuffer"`→**realm-bound** `ArrayBuffer`
  — `bindRealm` after `vm.createContext`, mirroring fetch's
  `bindRealmErrors`).
- `send()`: CONNECTING → `InvalidStateError`; text→opcode 1;
  ArrayBuffer/views **cross-realm duck-typed** (`instanceof` fails on
  vm-realm buffers — a view has `.buffer`, a bare buffer doesn't);
  Blob→async `arrayBuffer()` read.
- `close(code?, reason?)`: 1000/3000–4999 range validation
  (`InvalidAccessError`), reason ≤123 UTF-8 bytes (`SyntaxError`),
  close frame → CLOSING → peer echo → CLOSED with `CloseEvent{code,
  reason, wasClean:true}`; transport drop before the echo → 1006
  unclean.
- Protocol violations fail with the RFC code: masked server frame,
  RSV bits, fragmented/oversized control frame, stray continuation →
  1002; invalid UTF-8 in a text message → 1007; oversized frame →
  1009. A failure sends a close frame carrying the code, drops the
  socket, fires `error` then `close`.
- Events are real `Event`/`MessageEvent`/`CloseEvent` instances
  (`isTrusted`), dispatched as tasks through the runner's injected
  `queueTask` — in the virtual loop they interleave with guest
  microtasks deterministically.
- Server ping → client pong echo (masked) automatically; pongs are
  consumed silently (spec has no pong event).

## Boundary (honest)

- `Sec-WebSocket-Extensions` is never offered — `extensions` is always
  `""` (permessage-deflate etc. out of scope).
- `wss:` uses host TLS with default verification; no certificate-policy
  hooks, no client certs.
- No HTTP proxy CONNECT for `ws:`; no `Sec-WebSocket-Protocol` beyond
  negotiation echo; cookies/auth headers are not injected into the
  upgrade request (the transport writes exactly what the engine
  builds — a documented gap vs. browsers which consult the cookie jar).
- `onerror` carries a plain `Event` (spec); no per-frame error detail
  reaches the guest.
- `bufferedAmount` settles to 0 immediately (writes are synchronous);
  it is not a backpressure signal.
- Ping timeouts/half-open detection are not implemented — a silent
  peer just never closes.
- The loopback peer is a test harness, not a spec'd API — exposed
  deliberately so hosts can script deterministic servers.

## Evidence

- `websocket.test.ts`: 12/12 — request byte shape + negotiated
  subprotocol, constructor validation taxonomy, CONNECTING send throw,
  masked text echo, binary delivery in both `binaryType` modes (real
  realm `ArrayBuffer` + guest `Blob`), ping→pong with payload echo,
  fragmentation reassembly, close handshake both directions with
  `CloseEvent` fidelity, transport-drop 1006, close-arg validation,
  all rejection paths (403, bad accept, masked server frame,
  fragmented control, bad UTF-8), no-transport failure surface, and a
  **real TCP socket roundtrip** through `nodeWsTransport`.
- Full suite: 1487/1487; WPT subsets 462/462 (unchanged).
- `npm run ci` all gates green.
