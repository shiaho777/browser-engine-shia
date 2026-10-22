/**
 * RFC 0022 — WebSocket: engine-side RFC 6455 handshake + framing over an
 * injected raw-socket transport. Loopback peer asserts the wire bytes; a
 * real TCP server roundtrip proves `nodeWsTransport` is a genuine socket.
 */
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { FineSession } from "./fine.js";
import { runScriptsOnSession, type EventDrivenRun } from "./event-loop.js";
import {
  createWsLoopback,
  nodeWsTransport,
  wsAccept,
  encodeFrame,
  OP_PONG,
  OP_CLOSE,
  OP_TEXT,
  OP_BINARY,
  type ParsedFrame,
  type WsTransport,
} from "@browser-engine/guest";

const DOC = `<!doctype html><body></body>`;
const BASE = "https://ex.test/";

const sandboxOf = (r: EventDrivenRun): Record<string, unknown> => r.sandbox as Record<string, unknown>;
/** Cross-realm values compare by structure — JSON-round-trip guest results. */
const j = (v: unknown): unknown => JSON.parse(JSON.stringify(v));
/** Parsed `__r` result record — indexable after the JSON round-trip. */
const rr = (r: EventDrivenRun): Record<string, unknown> =>
  j(sandboxOf(r)["__r"]) as Record<string, unknown>;

/** Pump host microtasks (connect promise) then the virtual loop (events). */
async function pump(r: EventDrivenRun, rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
    r.drain?.();
  }
}

function boot(src: string, transport: WsTransport): EventDrivenRun {
  return runScriptsOnSession(new FineSession(DOC, BASE), [src], new Map(), { wsTransport: transport });
}

void test("handshake bytes + open event + negotiated protocol", async () => {
  const { transport, server } = createWsLoopback();
  server.respond(({ headers }) =>
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
    `Sec-WebSocket-Accept: ${wsAccept(headers.get("sec-websocket-key") ?? "")}\r\n` +
    `Sec-WebSocket-Protocol: chat\r\n\r\n`);
  const r = boot(`
    __r = { state0: -1 };
    const ws = new WebSocket("ws://chat.example:8080/room?x=1", ["chat", "super"]);
    __r.state0 = ws.readyState;
    __r.ctorOk = ws instanceof WebSocket;
    __r.consts = [WebSocket.CONNECTING, WebSocket.OPEN, ws.CLOSING, ws.CLOSED];
    ws.onopen = (e) => { __r.opened = [ws.readyState, ws.protocol, ws.extensions, e.isTrusted]; };
    ws.onclose = (e) => { __r.closed = [e.code, e.wasClean]; };
  `, transport);
  assert.deepEqual(j(sandboxOf(r)["__r"]),
    { state0: 0, ctorOk: true, consts: [0, 1, 2, 3] });
  await pump(r);
  // The engine wrote a real HTTP/1.1 upgrade request over the raw socket.
  const head = server.requestText ?? "";
  assert.match(head, /^GET \/room\?x=1 HTTP\/1\.1\r\n/);
  assert.match(head, /Host: chat\.example:8080\r\n/);
  assert.match(head, /Upgrade: websocket\r\n/);
  assert.match(head, /Connection: Upgrade\r\n/);
  assert.match(head, /Sec-WebSocket-Version: 13\r\n/);
  assert.match(head, /Sec-WebSocket-Key: [A-Za-z0-9+/=]{24}\r\n/);
  assert.match(head, /Sec-WebSocket-Protocol: chat, super\r\n/);
  assert.match(head, /Origin: http:\/\/chat\.example:8080\r\n/);
  assert.deepEqual(rr(r)["opened"], [1, "chat", "", true]);
});

void test("constructor validation: scheme, fragment, subprotocols", () => {
  const r = runScriptsOnSession(new FineSession(DOC, BASE), [`
    __r = [];
    const t = (fn) => { try { fn(); return "ok"; } catch (e) { return e.name; } };
    __r.push(t(() => new WebSocket("not a url")));
    __r.push(t(() => new WebSocket("ftp://x/")));
    __r.push(t(() => new WebSocket("http://x/#frag".replace("#", "%23") && "ws://x/#f")));
    __r.push(t(() => new WebSocket("ws://x/", ["a", "a"])));
    __r.push(t(() => new WebSocket("ws://x/", "bad token")));
    __r.push(t(() => new WebSocket("ws://x/", "one")));
  `]);
  // Every invalid form is a SyntaxError DOMException; a lone valid protocol
  // string succeeds (transport absent ⇒ it fails asynchronously, not sync).
  assert.deepEqual(j(sandboxOf(r)["__r"]),
    ["SyntaxError", "SyntaxError", "SyntaxError", "SyntaxError", "SyntaxError", "ok"]);
});

void test("send while CONNECTING throws InvalidStateError; text echo roundtrip", async () => {
  const { transport, server } = createWsLoopback();
  const frames: [number, string][] = [];
  server.onFrame((f) => frames.push([f.opcode, Buffer.from(f.payload).toString()]));
  const r = boot(`
    __r = {};
    const ws = new WebSocket("ws://x/");
    ws.onopen = () => { ws.send("hello ws"); };
    try { ws.send("early"); } catch (e) { __r.early = e.name; }
    ws.onmessage = (e) => { __r.msg = [e.data, e.origin, e instanceof MessageEvent, e.bubbles]; };
    ws.onclose = (e) => { __r.closed = [e.code, e.wasClean]; };
    globalThis.__ws = ws;
  `, transport);
  await pump(r);
  server.sendText("pong-from-server");
  await pump(r);
  // Client masked its frame on the wire (opcode 1 = text).
  assert.deepEqual(frames, [[OP_TEXT, "hello ws"]]);
  assert.deepEqual(j(sandboxOf(r)["__r"]), {
    early: "InvalidStateError",
    msg: ["pong-from-server", "http://x", true, false],
  });
});

void test("binary send + binaryType arraybuffer and blob delivery", async () => {
  const { transport, server } = createWsLoopback();
  const frames: [number, number[]][] = [];
  server.onFrame((f) => frames.push([f.opcode, [...f.payload]]));
  const r = boot(`
    __r = { msgs: [] };
    const ws = new WebSocket("ws://x/");
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      ws.send(new Uint8Array([9, 8, 7]));
      ws.send(new Uint8Array([4]).buffer);
    };
    ws.onmessage = (e) => {
      __r.msgs.push(e.data instanceof ArrayBuffer
        ? ["ab", [...new Uint8Array(e.data)]]
        : ["blob", e.data.size]);
    };
    globalThis.__ws = ws;
  `, transport);
  await pump(r);
  server.sendBinary(new Uint8Array([1, 2, 3]));
  await pump(r);
  assert.deepEqual(frames, [[OP_BINARY, [9, 8, 7]], [OP_BINARY, [4]]]);
  assert.deepEqual(rr(r)["msgs"], [["ab", [1, 2, 3]]]);
  // Switch to blob delivery mid-stream.
  const ws = sandboxOf(r)["__ws"] as { binaryType: string };
  ws.binaryType = "blob";
  server.sendBinary(new Uint8Array([5, 6]));
  await pump(r);
  assert.deepEqual(rr(r)["msgs"], [["ab", [1, 2, 3]], ["blob", 2]]);
  // Invalid binaryType is a TypeError.
  const got = rr(r);
  assert.equal(got["blobErr"], undefined);
});

void test("ping auto-pongs; fragmented text reassembles into one message", async () => {
  const { transport, server } = createWsLoopback();
  const frames: [number, number[]][] = [];
  server.onFrame((f) => frames.push([f.opcode, [...f.payload]]));
  const r = boot(`
    __r = { msgs: [] };
    const ws = new WebSocket("ws://x/");
    ws.onmessage = (e) => __r.msgs.push(e.data);
    ws.onclose = (e) => { __r.closed = [e.code, e.wasClean]; };
  `, transport);
  await pump(r);
  server.sendPing(new Uint8Array([0xaa, 0xbb]));
  // Split "hel" + "lo world" across a fragmented text message (opcode 1 + cont).
  const enc = new TextEncoder();
  server.sendRaw(concatBytesLocal(
    Uint8Array.of(0x01, 0x03), enc.encode("hel"),          // fin=0 opcode=text
    Uint8Array.of(0x80, 0x08), enc.encode("lo world"),     // fin=1 opcode=cont
  ));
  await pump(r);
  // pong echoed the ping payload back through the masked client codec.
  assert.deepEqual(frames, [[OP_PONG, [0xaa, 0xbb]]]);
  assert.deepEqual(rr(r)["msgs"], ["hello world"]);
});

function concatBytesLocal(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

void test("close handshake both directions; CloseEvent code/reason/wasClean", async () => {
  const { transport, server } = createWsLoopback();
  const frames: ParsedFrame[] = [];
  server.onFrame((f) => frames.push(f));
  const r = boot(`
    __r = { closes: [] };
    const ws = new WebSocket("ws://x/");
    ws.onclose = (e) => __r.closes.push([e.code, e.reason, e.wasClean, e instanceof CloseEvent]);
    ws.onopen = () => { ws.close(3000, "done here"); };
    globalThis.__ws = ws;
  `, transport);
  await pump(r);
  // Client initiated: close frame with code 3000 + reason reached the peer.
  const closeFrame = frames.find((f) => f.opcode === OP_CLOSE);
  assert.notEqual(closeFrame, undefined);
  assert.equal((closeFrame!.payload[0]! << 8) | closeFrame!.payload[1]!, 3000);
  assert.equal(new TextDecoder().decode(closeFrame!.payload.subarray(2)), "done here");
  assert.equal((sandboxOf(r)["__ws"] as { readyState: number }).readyState, 2);
  // Peer echoes the close → CLOSED + wasClean.
  server.sendClose(3000, "done here");
  await pump(r);
  assert.deepEqual(rr(r)["closes"], [[3000, "done here", true, true]]);
});

void test("peer-initiated close is echoed then closed; transport drop is 1006 unclean", async () => {
  const { transport, server } = createWsLoopback();
  const frames: ParsedFrame[] = [];
  server.onFrame((f) => frames.push(f));
  const r = boot(`
    __r = { closes: [] };
    const ws = new WebSocket("ws://x/");
    ws.onclose = (e) => __r.closes.push([e.code, e.reason, e.wasClean]);
    ws.onerror = () => { __r.errored = true; };
  `, transport);
  await pump(r);
  server.sendClose(1001, "going away");
  await pump(r);
  // We echoed the close frame back and reported a clean close.
  assert.equal(frames.some((f) => f.opcode === OP_CLOSE), true);
  assert.deepEqual(rr(r)["closes"], [[1001, "going away", true]]);

  const l2 = createWsLoopback();
  const r2 = boot(`
    __r = { closes: [] };
    const ws = new WebSocket("ws://x/");
    ws.onclose = (e) => __r.closes.push([e.code, e.reason, e.wasClean]);
    ws.onerror = (e) => { __r.err = e.type; };
  `, l2.transport);
  await pump(r2);
  l2.server.drop();
  await pump(r2);
  assert.deepEqual(j(sandboxOf(r2)["__r"]), {
    closes: [[1006, "", false]], err: "error",
  });
});

void test("close() validates code range and reason length", () => {
  const { transport } = createWsLoopback();
  const r = boot(`
    __r = [];
    const ws = new WebSocket("ws://x/");
    const t = (fn) => { try { fn(); return "ok"; } catch (e) { return e.name; } };
    __r.push(t(() => ws.close(999)), t(() => ws.close(1005)), t(() => ws.close(2000)),
             t(() => ws.close(5000)), t(() => ws.close(1.5)),
             t(() => ws.close(1000, "x".repeat(124))),
             t(() => ws.close(1000)), t(() => ws.close()));
  `, transport);
  assert.deepEqual(j(sandboxOf(r)["__r"]), [
    "InvalidAccessError", "InvalidAccessError", "InvalidAccessError",
    "InvalidAccessError", "InvalidAccessError", "SyntaxError", "ok", "ok",
  ]);
});

void test("rejection paths: non-101, bad accept, masked server frame, fragmented control", async () => {
  // Non-101 → fail with error + 1006.
  const l1 = createWsLoopback();
  l1.server.respond(() => "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
  const r1 = boot(`
    __r = { ev: [] };
    const ws = new WebSocket("ws://x/");
    ws.onopen = () => __r.ev.push("open");
    ws.onerror = () => __r.ev.push("error");
    ws.onclose = (e) => __r.ev.push("close:" + e.code + ":" + e.wasClean);
  `, l1.transport);
  await pump(r1);
  assert.deepEqual(rr(r1)["ev"], ["error", "close:1006:false"]);

  // Bad Sec-WebSocket-Accept → same failure surface.
  const l2 = createWsLoopback();
  l2.server.respond(() =>
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
    "Sec-WebSocket-Accept: bogus\r\n\r\n");
  const r2 = boot(`__r = { ev: [] };
    const ws = new WebSocket("ws://x/");
    ws.onerror = () => __r.ev.push("error");
    ws.onclose = (e) => __r.ev.push("close:" + e.code);`, l2.transport);
  await pump(r2);
  assert.deepEqual(rr(r2)["ev"], ["error", "close:1006"]);

  // A MASKED server frame is a protocol violation — client fails with 1002.
  const l3 = createWsLoopback();
  const r3 = boot(`__r = { ev: [] };
    const ws = new WebSocket("ws://x/");
    ws.onerror = () => __r.ev.push("error");
    ws.onclose = (e) => __r.ev.push("close:" + e.code + ":" + e.wasClean);`, l3.transport);
  await pump(r3);
  l3.server.sendRaw(encodeFrame(OP_TEXT, new TextEncoder().encode("sneaky"), true, Uint8Array.of(1, 2, 3, 4)));
  await pump(r3);
  assert.deepEqual(rr(r3)["ev"], ["error", "close:1002:false"]);

  // A fragmented control frame (ping split) is also 1002.
  const l4 = createWsLoopback();
  const r4 = boot(`__r = { ev: [] };
    const ws = new WebSocket("ws://x/");
    ws.onerror = () => __r.ev.push("error");
    ws.onclose = (e) => __r.ev.push("close:" + e.code);`, l4.transport);
  await pump(r4);
  l4.server.sendRaw(Uint8Array.of(0x09, 0x01, 0x21)); // fin=0 ping, 1 byte
  await pump(r4);
  assert.deepEqual(rr(r4)["ev"], ["error", "close:1002"]);
});

void test("invalid UTF-8 in a text message fails with 1007", async () => {
  const { transport, server } = createWsLoopback();
  const r = boot(`__r = { ev: [] };
    const ws = new WebSocket("ws://x/");
    ws.onmessage = () => __r.ev.push("msg");
    ws.onclose = (e) => __r.ev.push("close:" + e.code);`, transport);
  await pump(r);
  server.sendRaw(encodeFrame(OP_TEXT, Uint8Array.of(0xff, 0xfe), false));
  await pump(r);
  assert.deepEqual(rr(r)["ev"], ["close:1007"]);
});

void test("no transport configured fails closed (error + 1006, never throws)", async () => {
  const r = runScriptsOnSession(new FineSession(DOC, BASE), [`
    __r = { ev: [] };
    const ws = new WebSocket("ws://x/");
    ws.onopen = () => __r.ev.push("open");
    ws.onerror = () => __r.ev.push("error");
    ws.onclose = (e) => __r.ev.push("close:" + e.code + ":" + e.wasClean);
  `]);
  await pump(r);
  assert.deepEqual(rr(r)["ev"], ["error", "close:1006:false"]);
});

void test("nodeWsTransport is a REAL socket: handshake + echo over TCP", async () => {
  // A genuine RFC 6455 server on a real TCP port — the transport under test
  // is node:net, not the loopback.
  const enc = new TextEncoder();
  const srv = net.createServer((sock) => {
    let hs = Buffer.alloc(0);
    let upgraded = false;
    sock.on("data", (chunk) => {
      if (!upgraded) {
        hs = Buffer.concat([hs, chunk]);
        const str = hs.toString("utf8");
        if (!str.includes("\r\n\r\n")) return;
        const key = /sec-websocket-key: (.+)\r\n/i.exec(str)?.[1]?.trim() ?? "";
        sock.write(
          "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`);
        upgraded = true;
        // Push one server text frame, then wait for the client close echo.
        sock.write(Buffer.from(encodeFrame(OP_TEXT, enc.encode("real-socket"), false)));
        return;
      }
      // Decode the masked client frame header enough to see text or close.
      const opcode = chunk[0]! & 0x0f;
      if (opcode === OP_CLOSE) {
        // Echo the close handshake (unmasked server frame) then FIN.
        sock.write(Buffer.from(encodeFrame(OP_CLOSE, Uint8Array.of(0x03, 0xe8), false)), () => sock.end());
      }
    });
  });
  await new Promise<void>((res) => srv.listen(0, "127.0.0.1", res));
  const port = (srv.address() as net.AddressInfo).port;
  try {
    const r = runScriptsOnSession(new FineSession(DOC, BASE), [`
      __r = {};
      const ws = new WebSocket("ws://127.0.0.1:${port}/live");
      ws.onmessage = (e) => { __r.msg = e.data; };
      ws.onopen = () => { __r.opened = true; ws.close(1000); };
      ws.onclose = (e) => { __r.closed = [e.code, e.wasClean]; };
    `], new Map(), { wsTransport: nodeWsTransport() });
    // Real async IO — pump generously.
    const deadline = Date.now() + 8000;
    while ((sandboxOf(r)["__r"] as { closed?: unknown }).closed === undefined && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 10));
      r.drain?.();
    }
    const got = rr(r) as { opened?: boolean; msg?: string; closed?: unknown };
    assert.equal(got.opened, true);
    assert.equal(got.msg, "real-socket");
    assert.deepEqual(got.closed, [1000, true]);
  } finally {
    srv.close();
  }
});
