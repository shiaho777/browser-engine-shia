/**
 * RpcChannel tests over the in-process loopback transport — reply routing,
 * error propagation, and channel teardown.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  ChannelClosedError,
  RpcClient,
  loopbackPorts,
  servePort,
  type AppRequest,
  type AppReply,
} from "./index.js";

function serve(handle: (msg: AppRequest) => Promise<AppReply>): RpcClient {
  const { a, b } = loopbackPorts();
  servePort(b, handle);
  return new RpcClient(a);
}

void test("a request resolves with its reply", async () => {
  const client = serve((msg) => {
    assert.equal(msg.kind, "ping");
    return Promise.resolve({ kind: "statusReply" as const, ok: true, fonts: "x" });
  });
  const reply = await client.call({ kind: "ping" });
  assert.deepEqual(reply, { kind: "statusReply", ok: true, fonts: "x" });
});

void test("a throwing handler yields a rejected call, not a dead channel", async () => {
  const client = serve((msg) => {
    if (msg.kind === "dispose") return Promise.reject(new Error("nope"));
    return Promise.resolve({ kind: "statusReply" as const, ok: true, fonts: "x" });
  });
  await assert.rejects(() => client.call({ kind: "dispose" }), /nope/);
  // The channel survives — a subsequent request still completes.
  const reply = await client.call({ kind: "ping" });
  assert.equal(reply.kind, "statusReply");
});

void test("concurrent requests correlate replies by requestId", async () => {
  const client = serve(async (msg) => {
    // Reply out of order: fast for ping, slow for getNav.
    if (msg.kind === "getNav") {
      await new Promise((r) => setTimeout(r, 20));
      return {
        kind: "navStateReply",
        nav: { canGoBack: false, canGoForward: false, url: "u", title: "t", hasPage: true, pendingNewTabs: [],
    pendingDownloads: [],
    closeRequested: false, pendingPostMessages: [],
    focusRequests: [], coep: "unsafe-none", coop: "unsafe-none", crossOriginIsolated: false, originAgentCluster: false },
      };
    }
    return { kind: "statusReply", ok: true, fonts: "x" };
  });
  const slow = client.call({ kind: "getNav" });
  const fast = client.call({ kind: "ping" });
  const [fastReply, slowReply] = await Promise.all([fast, slow]);
  assert.equal(fastReply.kind, "statusReply");
  assert.equal(slowReply.kind, "navStateReply");
});

void test("failAll rejects in-flight calls and future ones", async () => {
  const client = serve(async () => new Promise<AppReply>(() => {}));
  const pending = client.call({ kind: "ping" });
  client.failAll(new Error("worker died"));
  await assert.rejects(pending, /worker died/);
  await assert.rejects(() => client.call({ kind: "ping" }), ChannelClosedError);
});
