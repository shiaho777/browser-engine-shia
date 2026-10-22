/**
 * Round-trip and wire-integrity tests for the generated protocol codec.
 * Every message row in the schema gets an encode→decode equality pass; the
 * hostile cases (truncation, unknown tag, bad enum) must fail loudly.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { MESSAGES } from "./schema.js";
import {
  decodeReply,
  decodeRequest,
  encodeReply,
  encodeRequest,
  MessageTag,
  type AppReply,
  type AppRequest,
  type Frame,
  type HitInfo,
  type Viewport,
} from "./generated/protocol.js";

const VIEWPORT: Viewport = { width: 1024, height: 720, devicePixelRatio: 2 };

const FRAME: Frame = {
  url: "engine://home",
  title: "home",
  width: 1024,
  height: 720,
  png: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]),
  durationMs: 12.5,
  frameRev: 7,
  scriptsRun: 3,
  mutations: 41,
  scriptError: null,
  scriptsLoaded: 3,
  scriptsFailed: 0,
  moduleUrls: 1,
  cookies: 2,
  networkEvents: 9,
  modulesEvaluated: 1,
  modulesLinked: 1,
  esmSupported: true,
  scrollY: 0,
  contentHeight: 1440,
};

const HIT: HitInfo = {
  x: 12,
  y: 34,
  nodeId: "42",
  tag: "a",
  href: "engine://demo",
  cursor: "pointer",
  editable: {
    nodeId: "9",
    tag: "textarea",
    value: "héllo — unicode ✓",
    x: 1,
    y: 2,
    width: 3,
    height: 4,
    multiline: true,
  },
};

const REQUESTS: readonly AppRequest[] = [
  {
    kind: "load",
    url: "https://example.com/",
    viewport: VIEWPORT,
    keepAlive: true,
    push: true,
    referrerPolicy: "no-referrer",
  },
  { kind: "loadHtml", html: "<b>héllo ✓</b>", title: "t", viewport: VIEWPORT },
  { kind: "back", viewport: VIEWPORT },
  { kind: "forward", viewport: VIEWPORT },
  { kind: "reload", viewport: VIEWPORT },
  { kind: "setViewport", viewport: VIEWPORT },
  { kind: "scroll", dx: -3.5, dy: 120.25, settle: true, viewport: null },
  { kind: "hitTest", x: 10, y: 20 },
  { kind: "commitText", nodeId: "9", text: "abc", caret: 3, selStart: 3, selEnd: 3, preview: false },
  { kind: "pump", count: 4, settleMs: 250, idleStop: true },
  { kind: "getFrame" },
  { kind: "getNav" },
  { kind: "ping" },
  { kind: "dispose" },
];

const REPLIES: readonly AppReply[] = [
  { kind: "frameReply", frame: FRAME, nav: { canGoBack: true, canGoForward: false, url: "u", title: "t", hasPage: true, pendingNewTabs: [],
    pendingDownloads: [],
    closeRequested: false, pendingPostMessages: [],
    focusRequests: [], coep: "unsafe-none", coop: "unsafe-none", crossOriginIsolated: false, originAgentCluster: false } },
  { kind: "frameReply", frame: null, nav: { canGoBack: false, canGoForward: true, url: "u", title: "t", hasPage: false, pendingNewTabs: [],
    pendingDownloads: [],
    closeRequested: false, pendingPostMessages: [],
    focusRequests: [], coep: "unsafe-none", coop: "unsafe-none", crossOriginIsolated: false, originAgentCluster: false } },
  { kind: "hitInfoReply", hit: HIT },
  { kind: "hitInfoReply", hit: { ...HIT, nodeId: null, tag: null, href: null, editable: null } },
  { kind: "pumpReply", frames: 2, mutations: 5, frameRev: 9, frame: FRAME, nav: { canGoBack: true, canGoForward: false, url: "u", title: "t", hasPage: true, pendingNewTabs: [],
    pendingDownloads: [],
    closeRequested: false, pendingPostMessages: [],
    focusRequests: [], coep: "unsafe-none", coop: "unsafe-none", crossOriginIsolated: false, originAgentCluster: false } },
  { kind: "frameBytesReply", png: new Uint8Array([9, 8, 7]), frameRev: 3 },
  { kind: "frameBytesReply", png: null, frameRev: 0 },
  { kind: "navStateReply", nav: { canGoBack: true, canGoForward: true, url: "x", title: "y", hasPage: true, pendingNewTabs: [],
    pendingDownloads: [],
    closeRequested: false, pendingPostMessages: [],
    focusRequests: [], coep: "unsafe-none", coop: "unsafe-none", crossOriginIsolated: false, originAgentCluster: false } },
  { kind: "statusReply", ok: true, fonts: "x" },
  { kind: "error", message: "boom" },
];

void test("every request row round-trips through the binary codec", () => {
  for (const msg of REQUESTS) {
    const buf = encodeRequest(1234, msg);
    const { requestId, msg: decoded } = decodeRequest(buf);
    assert.equal(requestId, 1234);
    assert.deepEqual(decoded, msg, `request ${msg.kind}`);
  }
});

void test("every reply row round-trips through the binary codec", () => {
  for (const msg of REPLIES) {
    const buf = encodeReply(77, msg);
    const { requestId, msg: decoded } = decodeReply(buf);
    assert.equal(requestId, 77);
    assert.deepEqual(decoded, msg, `reply ${msg.kind}`);
  }
});

void test("schema rows and emitted tags stay in lockstep", () => {
  // The generated tag table must cover every schema row exactly once.
  assert.equal(Object.keys(MessageTag).length, MESSAGES.length);
  assert.equal(MessageTag.error, 0);
});

void test("a truncated frame fails loudly, not silently", () => {
  const buf = encodeRequest(1, REQUESTS[0]!);
  const cut = buf.slice(0, buf.byteLength - 2);
  assert.throws(() => decodeRequest(cut), /ipc:/);
});

void test("an unknown tag fails loudly", () => {
  const buf = encodeRequest(1, REQUESTS[0]!);
  const u8 = new Uint8Array(buf);
  u8[13] = 250; // tag lives at offset 12..14 (len u32 + reqId u64)
  assert.throws(() => decodeRequest(buf), /unknown request tag/);
});

void test("trailing garbage after a payload fails loudly", () => {
  const buf = encodeReply(1, { kind: "statusReply", ok: true, fonts: "x" });
  const padded = new ArrayBuffer(buf.byteLength + 4);
  new Uint8Array(padded).set(new Uint8Array(buf));
  const v = new DataView(padded);
  v.setUint32(0, padded.byteLength, true); // keep the length field consistent
  assert.throws(() => decodeReply(padded), /trailing bytes/);
});
