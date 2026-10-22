/**
 * WebSocket — RFC 6455 client. The engine owns the wire: the HTTP Upgrade
 * handshake is written and validated here, the frame codec (client masking,
 * fragmentation, ping/pong, the close handshake) lives here, and the guest
 * `WebSocket` class drives both through an injected raw byte transport.
 *
 * Layering:
 * - `WsTransport`/`RawSocket` — the host supplies a dumb duplex byte stream
 *   (TCP for ws:, TLS for wss:). It knows nothing about HTTP or framing.
 * - This module — handshake construction + `Sec-WebSocket-Accept`
 *   validation, frame encode/decode, subprotocol negotiation, the
 *   connection state machine, and event delivery.
 * - Runners — pass a transport and a task queue; the class lands on the
 *   sandbox like every other guest global.
 *
 * Honest boundary (documented in RFC 0022): `wss:` relies on the host TLS
 * socket with no certificate-policy hooks, no HTTP proxy CONNECT for ws:,
 * `Sec-WebSocket-Extensions` is never offered (extensions always "").
 */

import { randomBytes as nodeRandomBytes } from "node:crypto";
import { Event, EventTarget, MessageEvent, CloseEvent } from "./event-system.js";
import { DOMException } from "./abort.js";
import { coerceGuestString } from "./coerce.js";

// ---------------------------------------------------------------------------
// SHA-1 (RFC 3174) — needed for Sec-WebSocket-Accept. Pure TS so both the host
// transport path and in-memory loopback servers share one implementation.
// ---------------------------------------------------------------------------

const K = [0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xca62c1d6] as const;

function sha1(data: Uint8Array): Uint8Array {
  const bitLen = data.length * 8;
  const padded = Math.ceil((data.length + 9) / 64) * 64;
  const msg = new Uint8Array(padded);
  msg.set(data);
  msg[data.length] = 0x80;
  const dv = new DataView(msg.buffer);
  // 64-bit bit length — payloads here are tiny so the high word is 0.
  dv.setUint32(padded - 4, bitLen >>> 0);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let off = 0; off < padded; off += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 80; i += 1) {
      const v = (w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!) >>> 0;
      w[i] = (v << 1) | (v >>> 31);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i += 1) {
      const chunk = Math.floor(i / 20);
      let f: number;
      if (chunk === 0) f = (b & c) | (~b & d);
      else if (chunk === 2) f = (b & c) | (b & d) | (c & d);
      else f = b ^ c ^ d;
      const tmp =
        (((a << 5) | (a >>> 27)) >>> 0) + f + e + K[chunk]! + w[i]! | 0;
      e = d; d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a; a = tmp;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  const out = new Uint8Array(20);
  const ov = new DataView(out.buffer);
  for (const [i, v] of [h0, h1, h2, h3, h4].entries()) ov.setUint32(i * 4, v >>> 0);
  return out;
}

function b64encode(bytes: Uint8Array): string {
  const table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!, b = bytes[i + 1], c = bytes[i + 2];
    out += table[a >> 2]! + table[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    out += b === undefined ? "=" : table[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    out += c === undefined ? "=" : table[c & 63]!;
  }
  return out;
}

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** `Sec-WebSocket-Accept` value for a client nonce (RFC 6455 §1.3). */
export function wsAccept(key: string): string {
  return b64encode(sha1(new TextEncoder().encode(key + WS_GUID)));
}

// ---------------------------------------------------------------------------
// Transport abstraction — a raw duplex byte channel.
// ---------------------------------------------------------------------------

export interface RawSocket {
  /** Write bytes; throws are treated as transport failure. */
  write(bytes: Uint8Array): void;
  /** Orderly close of the underlying stream. */
  close(): void;
  onData(cb: (chunk: Uint8Array) => void): void;
  onClose(cb: () => void): void;
  onError(cb: (error: Error) => void): void;
}

export interface WsTransport {
  /** Open a raw byte stream to the endpoint (no handshake performed). */
  connect(url: URL): RawSocket | Promise<RawSocket>;
}

// ---------------------------------------------------------------------------
// Handshake (engine-side: the wire format is ours, not the transport's)
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();
const textDecoderFatal = new TextDecoder("utf-8", { fatal: true });
const textDecoder = new TextDecoder();

export function buildHandshakeRequest(
  url: URL, key: string, protocols: readonly string[],
): Uint8Array {
  const path = (url.pathname === "" ? "/" : url.pathname) + url.search;
  const host =
    url.port === "" ? url.hostname : `${url.hostname}:${url.port}`;
  const lines = [
    `GET ${path} HTTP/1.1`,
    `Host: ${host}`,
    `Upgrade: websocket`,
    `Connection: Upgrade`,
    `Sec-WebSocket-Key: ${key}`,
    `Sec-WebSocket-Version: 13`,
    `Origin: ${url.protocol === "wss:" ? "https" : "http"}://${host}`,
  ];
  if (protocols.length > 0) lines.push(`Sec-WebSocket-Protocol: ${protocols.join(", ")}`);
  return textEncoder.encode(lines.join("\r\n") + "\r\n\r\n");
}

export interface HandshakeResponse {
  readonly status: number;
  readonly headers: ReadonlyMap<string, string>;
}

/**
 * Parse the upgrade response prefix. Returns null while the header block is
 * incomplete; throws on a malformed status line.
 */
export function parseHandshakeResponse(bytes: Uint8Array): { res: HandshakeResponse; rest: Uint8Array } | null {
  const str = textDecoder.decode(bytes);
  const end = str.indexOf("\r\n\r\n");
  if (end < 0) return null;
  const head = str.slice(0, end);
  const rest = bytes.subarray(textEncoder.encode(head + "\r\n\r\n").length);
  const lines = head.split("\r\n");
  const statusLine = lines[0] ?? "";
  const m = /^HTTP\/1\.[01] (\d{3})(?:\s+(.*))?$/.exec(statusLine);
  if (m === null) throw new Error(`websocket: malformed status line '${statusLine}'`);
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(":");
    if (idx > 0) headers.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
  }
  return { res: { status: Number(m[1]), headers }, rest };
}

// ---------------------------------------------------------------------------
// Frame codec (RFC 6455 §5)
// ---------------------------------------------------------------------------

export const OP_CONT = 0x0, OP_TEXT = 0x1, OP_BINARY = 0x2,
  OP_CLOSE = 0x8, OP_PING = 0x9, OP_PONG = 0xa;

export interface ParsedFrame {
  readonly fin: boolean;
  readonly opcode: number;
  readonly masked: boolean;
  /** Payload with the mask already removed. */
  readonly payload: Uint8Array;
}

/** Client→server frame: always masked (RFC 6455 §5.3). */
export function encodeClientFrame(
  opcode: number, payload: Uint8Array, random: (n: number) => Uint8Array,
): Uint8Array {
  return encodeFrame(opcode, payload, true, random(4));
}

/** Server→server-side test frame helper + symmetric encoder. */
export function encodeFrame(
  opcode: number, payload: Uint8Array, masked: boolean, maskKey?: Uint8Array,
): Uint8Array {
  const len = payload.length;
  const headLen = len < 126 ? 2 : len <= 0xffff ? 4 : 10;
  const out = new Uint8Array(headLen + (masked ? 4 : 0) + len);
  const dv = new DataView(out.buffer);
  out[0] = 0x80 | opcode;
  let off: number;
  if (len < 126) { out[1] = len; off = 2; }
  else if (len <= 0xffff) { out[1] = 126; dv.setUint16(2, len); off = 4; }
  else { out[1] = 127; dv.setUint32(2, 0); dv.setUint32(6, len); off = 10; }
  if (masked) {
    out[1] = out[1] | 0x80;
    const key = maskKey ?? nodeRandomBytes(4);
    out.set(key.subarray(0, 4), off); off += 4;
    for (let i = 0; i < len; i += 1) out[off + i] = payload[i]! ^ key[i % 4]!;
  } else {
    out.set(payload, off);
  }
  return out;
}

/** Protocol-violation codes worth distinguishing internally. */
export class WsProtocolError extends Error {
  readonly code: number;
  constructor(code: number, detail: string) {
    super(`websocket: ${detail}`);
    this.code = code;
  }
}

/**
 * Incremental frame parser. `peer` is the sender's role: "server" frames must
 * be unmasked, "client" frames must be masked — violations raise 1002.
 */
export class WsFrameParser {
  #buf = new Uint8Array(0);
  readonly #peer: "server" | "client";

  constructor(peer: "server" | "client") {
    this.#peer = peer;
  }

  push(chunk: Uint8Array): ParsedFrame[] {
    const merged = new Uint8Array(this.#buf.length + chunk.length);
    merged.set(this.#buf); merged.set(chunk, this.#buf.length);
    this.#buf = merged;
    const frames: ParsedFrame[] = [];
    let off = 0;
    for (;;) {
      const buf = this.#buf;
      if (buf.length - off < 2) break;
      const b0 = buf[off]!, b1 = buf[off + 1]!;
      const fin = (b0 & 0x80) !== 0;
      const rsv = b0 & 0x70;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let pos = off + 2;
      if (rsv !== 0) throw new WsProtocolError(1002, "RSV bits set with no extension negotiated");
      if (this.#peer === "server" && masked) throw new WsProtocolError(1002, "masked server frame");
      if (this.#peer === "client" && !masked) throw new WsProtocolError(1002, "unmasked client frame");
      const isControl = opcode >= 0x8;
      if (isControl && !fin) throw new WsProtocolError(1002, "fragmented control frame");
      if (opcode !== OP_CONT && opcode !== OP_TEXT && opcode !== OP_BINARY && !isControl) {
        throw new WsProtocolError(1002, `unknown opcode ${opcode}`);
      }
      if (len === 126) {
        if (buf.length - pos < 2) break;
        len = new DataView(buf.buffer, buf.byteOffset).getUint16(pos); pos += 2;
      } else if (len === 127) {
        if (buf.length - pos < 8) break;
        const dv = new DataView(buf.buffer, buf.byteOffset);
        const hi = dv.getUint32(pos), lo = dv.getUint32(pos + 4); pos += 8;
        if (hi !== 0) throw new WsProtocolError(1009, "frame too large");
        len = lo;
      }
      if (isControl && len > 125) throw new WsProtocolError(1002, "control frame over 125 bytes");
      const maskLen = masked ? 4 : 0;
      if (buf.length - pos < maskLen + len) break;
      let payload = buf.subarray(pos + maskLen, pos + maskLen + len);
      if (masked) {
        const key = buf.subarray(pos, pos + 4);
        const un = new Uint8Array(len);
        for (let i = 0; i < len; i += 1) un[i] = payload[i]! ^ key[i % 4]!;
        payload = un;
      } else {
        payload = new Uint8Array(payload); // detach from the rolling buffer
      }
      frames.push({ fin, opcode, masked, payload });
      off = pos + maskLen + len;
    }
    this.#buf = this.#buf.subarray(off);
    return frames;
  }
}

// ---------------------------------------------------------------------------
// Loopback transport — an in-memory peer for tests and dev harnesses. The
// "server" half sees the client's raw handshake bytes (assertable), decodes
// masked client frames, and emits unmasked server frames — the full RFC 6455
// contract, minus TCP.
// ---------------------------------------------------------------------------

export interface WsLoopbackServer {
  /** The client's raw HTTP upgrade request (null until received). */
  readonly requestText: string | null;
  readonly requestHeaders: ReadonlyMap<string, string> | null;
  /** Override the upgrade response (return raw HTTP bytes). */
  respond(fn: (req: { raw: string; headers: ReadonlyMap<string, string> }) => string): void;
  /** Client frames, unmasked, as they arrive. */
  onFrame(cb: (frame: ParsedFrame) => void): void;
  onHandshakeBytes(cb: (raw: Uint8Array) => void): void;
  sendText(text: string): void;
  sendBinary(bytes: Uint8Array): void;
  sendPing(payload?: Uint8Array): void;
  sendPong(payload?: Uint8Array): void;
  sendClose(code?: number, reason?: string): void;
  sendRaw(bytes: Uint8Array): void;
  /** Drop the transport without a close frame (unclean close, 1006). */
  drop(): void;
}

export function createWsLoopback(): { transport: WsTransport; server: WsLoopbackServer } {
  let clientData: ((c: Uint8Array) => void) | null = null;
  let clientClose: (() => void) | null = null;
  let frameCb: ((f: ParsedFrame) => void) | null = null;
  let hsBytesCb: ((b: Uint8Array) => void) | null = null;
  let responder: ((req: { raw: string; headers: ReadonlyMap<string, string> }) => string) | null = null;
  let hsBuf: Uint8Array = new Uint8Array(0);
  let requestText: string | null = null;
  let requestHeaders: ReadonlyMap<string, string> | null = null;
  let handshook = false;
  const parser = new WsFrameParser("client"); // server role: client frames must be masked

  const deliver = (bytes: Uint8Array): void => {
    if (clientData === null) return;
    clientData(bytes);
  };

  const completeHandshake = (reqBytes: Uint8Array): void => {
    const raw = textDecoder.decode(reqBytes);
    requestText = raw;
    const headers = new Map<string, string>();
    for (const line of raw.split("\r\n").slice(1)) {
      const idx = line.indexOf(":");
      if (idx > 0) headers.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
    }
    requestHeaders = headers;
    const req = { raw, headers };
    const response = responder !== null
      ? responder(req)
      : `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${wsAccept(headers.get("sec-websocket-key") ?? "")}\r\n\r\n`;
    deliver(textEncoder.encode(response));
    handshook = true;
  };

  const socket: RawSocket = {
    write(bytes) {
      if (!handshook) {
        hsBuf = concatBytes(hsBuf, bytes);
        hsBytesCb?.(hsBuf);
        const str = textDecoder.decode(hsBuf);
        if (str.includes("\r\n\r\n")) completeHandshake(hsBuf);
        return;
      }
      for (const frame of parser.push(bytes)) frameCb?.(frame);
    },
    close() { clientClose?.(); },
    onData(cb) { clientData = cb; },
    onClose(cb) { clientClose = cb; },
    onError() { /* loopback never errors */ },
  };

  const server: WsLoopbackServer = {
    get requestText() { return requestText; },
    get requestHeaders() { return requestHeaders; },
    respond(fn) { responder = fn; },
    onFrame(cb) { frameCb = cb; },
    onHandshakeBytes(cb) { hsBytesCb = cb; },
    sendText(text) { deliver(encodeFrame(OP_TEXT, textEncoder.encode(text), false)); },
    sendBinary(bytes) { deliver(encodeFrame(OP_BINARY, bytes, false)); },
    sendPing(payload = new Uint8Array(0)) { deliver(encodeFrame(OP_PING, payload, false)); },
    sendPong(payload = new Uint8Array(0)) { deliver(encodeFrame(OP_PONG, payload, false)); },
    sendClose(code, reason = "") {
      const payload = code === undefined
        ? new Uint8Array(0)
        : concatBytes(Uint8Array.of(code >> 8, code & 0xff), textEncoder.encode(reason));
      deliver(encodeFrame(OP_CLOSE, payload, false));
    },
    sendRaw(bytes) { deliver(bytes); },
    drop() { clientClose?.(); },
  };
  return { transport: { connect: () => socket }, server };
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a); out.set(b, a.length);
  return out;
}

// ---------------------------------------------------------------------------
// Node transport — real TCP (ws:) / TLS (wss:) via the host runtime.
// ---------------------------------------------------------------------------

export function nodeWsTransport(): WsTransport {
  return {
    async connect(url: URL): Promise<RawSocket> {
      const wss = url.protocol === "wss:";
      const port = url.port === "" ? (wss ? 443 : 80) : Number(url.port);
      const host = url.hostname;
      const mod = wss ? await import("node:tls") : await import("node:net");
      return await new Promise<RawSocket>((resolve, reject) => {
        const sock = wss
          ? (mod as typeof import("node:tls")).connect({ host, port, servername: host })
          : (mod as typeof import("node:net")).connect({ host, port });
        let settled = false;
        const dataCbs: ((c: Uint8Array) => void)[] = [];
        const closeCbs: (() => void)[] = [];
        const errCbs: ((e: Error) => void)[] = [];
        sock.on("data", (chunk: Buffer) => {
          for (const cb of dataCbs) cb(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        });
        sock.on("close", () => { for (const cb of closeCbs) cb(); });
        sock.on("error", (err: Error) => {
          if (!settled) { settled = true; reject(err); return; }
          for (const cb of errCbs) cb(err);
        });
        const ready = wss ? "secureConnect" : "connect";
        sock.once(ready as "connect", () => {
          settled = true;
          resolve({
            write: (b) => { sock.write(Buffer.from(b.buffer, b.byteOffset, b.byteLength)); },
            close: () => { sock.end(); },
            onData: (cb) => dataCbs.push(cb),
            onClose: (cb) => closeCbs.push(cb),
            onError: (cb) => errCbs.push(cb),
          });
        });
      });
    },
  };
}

// ---------------------------------------------------------------------------
// The guest WebSocket class
// ---------------------------------------------------------------------------

export interface WebSocketDeps {
  /** Document base URL for resolving the constructor argument. */
  readonly baseUrl?: string;
  readonly transport?: WsTransport;
  readonly random?: (n: number) => Uint8Array;
  /** Task scheduler — the runner's microtask queue or ambient queueMicrotask. */
  readonly queueTask?: (fn: () => void) => void;
  /** Guest Blob class — binaryType:"blob" delivers real Blob instances. */
  readonly BlobCtor?: new (
    parts?: readonly unknown[], options?: { readonly type?: unknown },
  ) => unknown;
}

const WS_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const VALID_CLOSE_CODES = new Set([
  1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011,
]);
function closeCodeAllowed(code: number): boolean {
  return VALID_CLOSE_CODES.has(code) || (code >= 3000 && code <= 4999);
}

/** Public surface of the guest WebSocket class (EventTarget + WS members). */
export interface GuestWebSocket extends EventTarget {
  readonly url: string;
  readonly readyState: number;
  readonly protocol: string;
  readonly extensions: string;
  readonly bufferedAmount: number;
  binaryType: string;
  onopen: unknown;
  onmessage: unknown;
  onerror: unknown;
  onclose: unknown;
  readonly CONNECTING: 0;
  readonly OPEN: 1;
  readonly CLOSING: 2;
  readonly CLOSED: 3;
  send(data: unknown): void;
  close(code?: unknown, reason?: unknown): void;
}

export interface GuestWebSocketCtor {
  new (url?: unknown, protocols?: unknown): GuestWebSocket;
  readonly CONNECTING: 0;
  readonly OPEN: 1;
  readonly CLOSING: 2;
  readonly CLOSED: 3;
}

/** Realm intrinsics bound post-context so guest `instanceof` checks hold. */
export interface WsRealm {
  ArrayBuffer?: new (length: number) => ArrayBuffer;
  TypeError?: new (message: string) => Error;
}

export interface WebSocketApi {
  readonly WebSocket: GuestWebSocketCtor;
  /**
   * Bind the guest realm's own intrinsics after `vm.createContext` (the same
   * post-context pattern as fetch-api `bindRealmErrors`): binaryType:
   * "arraybuffer" then delivers objects that pass guest `instanceof
   * ArrayBuffer`, and thrown TypeErrors are realm-local.
   */
  bindRealm(realm: WsRealm): void;
}

export function makeWebSocketApi(deps: WebSocketDeps = {}): WebSocketApi {
  const random = deps.random ?? ((n: number) => new Uint8Array(nodeRandomBytes(n)));
  const queueTask = deps.queueTask ?? ((fn: () => void) => queueMicrotask(fn));
  const transport = deps.transport;
  const baseUrl = deps.baseUrl;
  const BlobCtor = deps.BlobCtor;
  const realm: { ArrayBuffer?: new (n: number) => ArrayBuffer; TypeError?: new (m: string) => Error } = {};
  const RealmTypeError = (m: string): Error =>
    realm.TypeError !== undefined ? new realm.TypeError(m) : new TypeError(m);

  class WebSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;

    readonly url: string;
    readonly extensions = "";
    onopen: unknown = null;
    onmessage: unknown = null;
    onerror: unknown = null;
    onclose: unknown = null;

    #readyState = 0;
    #protocol = "";
    #bufferedAmount = 0;
    #binaryType: "blob" | "arraybuffer" = "blob";
    #socket: RawSocket | null = null;
    #parser = new WsFrameParser("server");
    #hsBuf: Uint8Array = new Uint8Array(0);
    #key: string;
    #offered: readonly string[];
    #handshook = false;
    #closeSent = false;
    #closeFromPeerSeen = false;
    #failed = false;
    // Fragmentation reassembly.
    #fragOp: number | null = null;
    #fragChunks: Uint8Array[] = [];

    constructor(url: unknown, protocols?: unknown) {
      super();
      // HTML §9.3.2: url resolves against the entry settings' base URL.
      let parsed: URL;
      try {
        parsed = new URL(coerceGuestString(url), baseUrl);
      } catch {
        throw new DOMException(`invalid WebSocket URL`, "SyntaxError");
      }
      if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
        throw new DOMException(`WebSocket requires a ws: or wss: URL (got '${parsed.protocol}')`, "SyntaxError");
      }
      if (parsed.hash !== "") {
        throw new DOMException("WebSocket URL must not contain a fragment", "SyntaxError");
      }
      const offered = protocols === undefined
        ? []
        : Array.isArray(protocols)
          ? protocols.map((p) => coerceGuestString(p))
          : [coerceGuestString(protocols)];
      const seen = new Set<string>();
      for (const p of offered) {
        if (!WS_TOKEN_RE.test(p)) {
          throw new DOMException(`invalid Sec-WebSocket-Protocol token '${p}'`, "SyntaxError");
        }
        if (seen.has(p)) {
          throw new DOMException(`duplicate subprotocol '${p}'`, "SyntaxError");
        }
        seen.add(p);
      }
      this.url = parsed.href;
      this.#offered = offered;
      this.#key = b64encode(random(16));
      this.#connect(parsed);
    }

    get readyState(): number { return this.#readyState; }
    get protocol(): string { return this.#protocol; }
    get bufferedAmount(): number { return this.#bufferedAmount; }
    get binaryType(): string { return this.#binaryType; }
    set binaryType(v: unknown) {
      const s = coerceGuestString(v);
      if (s !== "blob" && s !== "arraybuffer") {
        throw RealmTypeError(`binaryType must be "blob" or "arraybuffer" (got '${s}')`);
      }
      this.#binaryType = s;
    }

    #emit(type: string, event: Event): void {
      // Events fire as tasks (HTML event loop), queued through the runner's
      // scheduler so they interleave with guest microtasks deterministically.
      queueTask(() => {
        event._setTrusted(true);
        this.dispatchEvent(event);
        const handler = this[`on${type}` as "onopen"];
        if (typeof handler === "function") {
          (handler as (e: Event) => void).call(this, event);
        }
      });
    }

    #connect(url: URL): void {
      if (transport === undefined) {
        // No transport configured — the connection fails (spec-shaped
        // failure surface: error + unclean close, not a thrown error).
        queueTask(() => this.#failConnection());
        return;
      }
      void Promise.resolve()
        .then(() => transport.connect(url))
        .then((socket) => {
          if (this.#readyState === 3) { socket.close(); return; } // closed during connect
          this.#socket = socket;
          socket.onData((chunk) => this.#onBytes(chunk));
          socket.onClose(() => this.#onTransportClose());
          socket.onError(() => this.#failConnection());
          socket.write(buildHandshakeRequest(url, this.#key, this.#offered));
        })
        .catch(() => this.#failConnection());
    }

    #onBytes(chunk: Uint8Array): void {
      if (this.#readyState === 3) return;
      if (!this.#handshook) {
        this.#hsBuf = concatBytes(this.#hsBuf, chunk);
        let parsed: { res: HandshakeResponse; rest: Uint8Array } | null = null;
        try {
          parsed = parseHandshakeResponse(this.#hsBuf);
        } catch {
          this.#failConnection();
          return;
        }
        if (parsed === null) return;
        const { res, rest } = parsed;
        const conn = res.headers.get("connection") ?? "";
        const ok =
          res.status === 101 &&
          res.headers.get("upgrade")?.toLowerCase() === "websocket" &&
          conn.toLowerCase().split(",").map((t) => t.trim()).includes("upgrade") &&
          res.headers.get("sec-websocket-accept") === wsAccept(this.#key);
        const sub = res.headers.get("sec-websocket-protocol");
        const subOk = sub === undefined || this.#offered.includes(sub);
        if (!ok || !subOk) {
          this.#failConnection();
          return;
        }
        this.#handshook = true;
        this.#protocol = sub ?? "";
        this.#readyState = 1;
        this.#emit("open", new Event("open"));
        if (rest.length > 0) this.#onBytes(rest);
        return;
      }
      let frames: ParsedFrame[];
      try {
        frames = this.#parser.push(chunk);
      } catch (err) {
        this.#failProtocol(err instanceof WsProtocolError ? err.code : 1002);
        return;
      }
      for (const f of frames) this.#onFrame(f);
    }

    #onFrame(f: ParsedFrame): void {
      switch (f.opcode) {
        case OP_TEXT:
        case OP_BINARY: {
          if (this.#fragOp !== null) { this.#failProtocol(1002); return; }
          if (f.fin) { this.#deliverMessage(f.opcode, f.payload); return; }
          this.#fragOp = f.opcode;
          this.#fragChunks = [f.payload];
          return;
        }
        case OP_CONT: {
          if (this.#fragOp === null) { this.#failProtocol(1002); return; }
          this.#fragChunks.push(f.payload);
          if (!f.fin) return;
          const total = this.#fragChunks.reduce((n, c) => n + c.length, 0);
          const full = new Uint8Array(total);
          let at = 0;
          for (const c of this.#fragChunks) { full.set(c, at); at += c.length; }
          const op = this.#fragOp;
          this.#fragOp = null; this.#fragChunks = [];
          this.#deliverMessage(op, full);
          return;
        }
        case OP_PING: {
          try { this.#socket?.write(encodeClientFrame(OP_PONG, f.payload, random)); }
          catch { this.#failConnection(); }
          return;
        }
        case OP_PONG: return; // no event surface for pongs (spec).
        case OP_CLOSE: {
          let code: number | undefined;
          let reason = "";
          if (f.payload.length === 1) { this.#failProtocol(1002); return; }
          if (f.payload.length >= 2) {
            code = new DataView(f.payload.buffer, f.payload.byteOffset).getUint16(0);
            if (!closeCodeAllowed(code) || code === 1005 || code === 1006) {
              this.#failProtocol(1002);
              return;
            }
            try {
              reason = textDecoderFatal.decode(f.payload.subarray(2));
            } catch {
              this.#failProtocol(1007);
              return;
            }
          }
          if (this.#closeFromPeerSeen) { this.#failProtocol(1002); return; }
          this.#closeFromPeerSeen = true;
          if (!this.#closeSent) {
            this.#closeSent = true;
            try { this.#socket?.write(encodeClientFrame(OP_CLOSE, f.payload, random)); }
            catch { /* echo failure falls through to transport close */ }
          }
          this.#readyState = 3;
          try { this.#socket?.close(); } catch { /* already gone */ }
          this.#emit("close", new CloseEvent("close", {
            code: code ?? 1005, reason, wasClean: true,
          }));
          return;
        }
        default: this.#failProtocol(1002);
      }
    }

    #deliverMessage(opcode: number, payload: Uint8Array): void {
      if (this.#readyState !== 1 && this.#readyState !== 2) return;
      if (opcode === OP_TEXT) {
        let text: string;
        try {
          text = textDecoderFatal.decode(payload);
        } catch {
          this.#failProtocol(1007); // invalid utf-8 in a text message
          return;
        }
        this.#emit("message", new MessageEvent("message", { data: text, origin: this.#origin() }));
        return;
      }
      let data: unknown;
      if (this.#binaryType === "arraybuffer") {
        // Realm-bound ArrayBuffer so guest `e.data instanceof ArrayBuffer`.
        const Ctor = realm.ArrayBuffer ?? ArrayBuffer;
        const buf = new Ctor(payload.byteLength);
        new Uint8Array(buf).set(payload);
        data = buf;
      } else {
        data = BlobCtor !== undefined
          ? new BlobCtor([payload], {})
          : payload; // host without a Blob ctor gets raw bytes (documented edge)
      }
      this.#emit("message", new MessageEvent("message", { data, origin: this.#origin() }));
    }

    #origin(): string {
      try {
        const u = new URL(this.url);
        return `${u.protocol === "wss:" ? "https" : "http"}://${u.host}`;
      } catch {
        return "";
      }
    }

    #failProtocol(code: number): void {
      // Protocol error: send a close with the code, then hard-drop the socket.
      if (this.#socket !== null && !this.#closeSent && this.#readyState !== 3) {
        this.#closeSent = true;
        try {
          this.#socket.write(encodeClientFrame(
            OP_CLOSE, Uint8Array.of(code >> 8, code & 0xff), random));
        } catch { /* dying anyway */ }
      }
      this.#readyState = 3;
      try { this.#socket?.close(); } catch { /* already gone */ }
      this.#emit("error", new Event("error"));
      this.#emit("close", new CloseEvent("close", { code, reason: "", wasClean: false }));
    }

    #failConnection(): void {
      // Transport or handshake failure before/without a clean close (1006).
      if (this.#failed) return;
      this.#failed = true;
      this.#readyState = 3;
      this.#emit("error", new Event("error"));
      this.#emit("close", new CloseEvent("close", { code: 1006, reason: "", wasClean: false }));
    }

    #onTransportClose(): void {
      if (this.#readyState === 3) return;
      // FIN without a completed close handshake — abnormal closure.
      this.#failConnection();
    }

    send(data: unknown): void {
      if (this.#readyState === 0) {
        throw new DOMException(
          "WebSocket is still CONNECTING — send() is not allowed", "InvalidStateError");
      }
      if (this.#readyState !== 1) {
        // CLOSING/CLOSED: the data is discarded but bufferedAmount still
        // accrues the would-be byte count (HTML §9.3.3).
        this.#bufferedAmount += byteLengthOf(data);
        return;
      }
      if (typeof data === "string") {
        const payload = textEncoder.encode(data);
        this.#write(OP_TEXT, payload);
        return;
      }
      // Cross-realm: `instanceof ArrayBuffer` fails on vm-realm buffers — duck-
      // type instead (a view has `.buffer`; a bare ArrayBuffer does not).
      if (isRealmArrayBuffer(data)) {
        this.#write(OP_BINARY, new Uint8Array(data));
        return;
      }
      if (ArrayBuffer.isView(data)) {
        this.#write(OP_BINARY, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        return;
      }
      const maybeBlob = data as { arrayBuffer?: () => Promise<ArrayBuffer> } | null;
      if (maybeBlob !== null && typeof maybeBlob === "object" && typeof maybeBlob.arrayBuffer === "function") {
        void maybeBlob.arrayBuffer().then((buf) => {
          if (this.#readyState === 1) this.#write(OP_BINARY, new Uint8Array(buf));
        });
        return;
      }
      throw RealmTypeError("send() accepts string, ArrayBuffer, ArrayBufferView, or Blob");
    }

    #write(opcode: number, payload: Uint8Array): void {
      this.#bufferedAmount += payload.length;
      try {
        this.#socket?.write(encodeClientFrame(opcode, payload, random));
      } catch {
        this.#failConnection();
        return;
      }
      // Socket writes are synchronous for our transports; the counter
      // reflects "queued but not yet transmitted" and settles to 0.
      this.#bufferedAmount -= payload.length;
    }

    close(code?: unknown, reason?: unknown): void {
      let c: number | undefined;
      if (code !== undefined) {
        c = Math.trunc(Number(code));
        if (!Number.isFinite(c) || !closeCodeAllowed(c)) {
          throw new DOMException(
            `close code must be 1000 or 3000–4999 (got ${c})`, "InvalidAccessError");
        }
      }
      let r = "";
      if (reason !== undefined) {
        r = coerceGuestString(reason);
        if (textEncoder.encode(r).length > 123) {
          throw new DOMException("close reason exceeds 123 bytes", "SyntaxError");
        }
      }
      if (this.#readyState === 3 || this.#readyState === 2) return;
      const payload = c === undefined
        ? new Uint8Array(0)
        : concatBytes(Uint8Array.of(c >> 8, c & 0xff), textEncoder.encode(r));
      this.#closeSent = true;
      if (this.#readyState === 0) {
        // Closing a connecting socket: drop the transport the moment the
        // handshake would complete — the close frame gets no channel.
        this.#readyState = 3;
        void Promise.resolve().then(() => {
          try { this.#socket?.close(); } catch { /* never connected */ }
        });
        this.#emit("close", new CloseEvent("close", { code: 1006, reason: "", wasClean: false }));
        return;
      }
      this.#readyState = 2;
      try { this.#socket?.write(encodeClientFrame(OP_CLOSE, payload, random)); }
      catch { this.#failConnection(); }
    }
  }

  return {
    WebSocket,
    bindRealm(r: WsRealm): void {
      if (r.ArrayBuffer !== undefined) realm.ArrayBuffer = r.ArrayBuffer;
      if (r.TypeError !== undefined) realm.TypeError = r.TypeError;
    },
  };
}

/** Cross-realm ArrayBuffer: byteLength + slice, no `buffer` (views have one). */
function isRealmArrayBuffer(data: unknown): data is ArrayBuffer {
  if (typeof data !== "object" || data === null) return false;
  const d = data as { byteLength?: unknown; slice?: unknown; buffer?: unknown };
  return typeof d.byteLength === "number" && typeof d.slice === "function" && d.buffer === undefined;
}

function byteLengthOf(data: unknown): number {
  if (typeof data === "string") return textEncoder.encode(data).length;
  if (isRealmArrayBuffer(data)) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  const b = data as { size?: unknown } | null;
  return b !== null && typeof b === "object" && typeof b.size === "number" ? b.size : 0;
}

