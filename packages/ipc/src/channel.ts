/**
 * channel.ts — request/reply plumbing over the generated wire codec.
 *
 * {@link PortLike} is the transport seam: `worker_threads` MessagePorts and
 * Worker objects in production, a loopback pair in tests. The wire itself is
 * always the generated binary frames — this file only owns correlation.
 */

import {
  decodeReply,
  decodeRequest,
  encodeReply,
  encodeRequest,
  type AppReply,
  type AppRequest,
} from "./generated/protocol.js";

/** Minimal duplex endpoint — satisfied by Node's `Worker`/`parentPort`. */
export interface PortLike {
  postMessage(data: ArrayBuffer, transfer?: readonly ArrayBuffer[]): void;
  onMessage(cb: (data: ArrayBuffer) => void): void;
}

interface Pending {
  resolve: (msg: AppReply) => void;
  reject: (err: Error) => void;
}

/** Rejects pending calls when the remote end dies. */
export class ChannelClosedError extends Error {
  constructor(message = "ipc channel closed") {
    super(message);
    this.name = "ChannelClosedError";
  }
}

/** Client side: correlates requests to replies by requestId. */
export class RpcClient {
  #port: PortLike;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #closed = false;

  constructor(port: PortLike) {
    this.#port = port;
    port.onMessage((data) => {
      const { requestId, msg } = decodeReply(data);
      const pending = this.#pending.get(requestId);
      if (pending === undefined) return; // stray reply — drop loudly? drop.
      this.#pending.delete(requestId);
      if (msg.kind === "error") {
        pending.reject(new Error(msg.message));
      } else {
        pending.resolve(msg);
      }
    });
  }

  /** True after {@link failAll} ran — further calls reject immediately. */
  get closed(): boolean {
    return this.#closed;
  }

  call(msg: AppRequest): Promise<AppReply> {
    if (this.#closed) {
      return Promise.reject(new ChannelClosedError());
    }
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise<AppReply>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      const frame = encodeRequest(id, msg);
      this.#port.postMessage(frame, [frame]);
    });
  }

  /** Reject every in-flight call — e.g. when the worker exits mid-op. */
  failAll(err: Error): void {
    this.#closed = true;
    for (const p of this.#pending.values()) p.reject(err);
    this.#pending.clear();
  }
}

/**
 * Server side: decode requests, invoke `handle`, encode the returned reply.
 * `handle` may throw — failures become the reserved `Error` reply under the
 * same requestId, so a crashing op fails that call, not the channel.
 */
export function servePort(
  port: PortLike,
  handle: (msg: AppRequest) => Promise<AppReply>,
): void {
  port.onMessage((data) => {
    void (async () => {
      let requestId = 0;
      try {
        const decoded = decodeRequest(data);
        requestId = decoded.requestId;
        const reply = await handle(decoded.msg);
        const frame = encodeReply(requestId, reply);
        port.postMessage(frame, [frame]);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const frame = encodeReply(requestId, { kind: "error", message });
        port.postMessage(frame, [frame]);
      }
    })();
  });
}

/** In-process loopback pair for tests. */
export function loopbackPorts(): { a: PortLike; b: PortLike } {
  const aToB: ((d: ArrayBuffer) => void)[] = [];
  const bToA: ((d: ArrayBuffer) => void)[] = [];
  return {
    a: {
      postMessage: (d) => queueMicrotask(() => bToA.forEach((cb) => cb(d))),
      onMessage: (cb) => void aToB.push(cb),
    },
    b: {
      postMessage: (d) => queueMicrotask(() => aToB.forEach((cb) => cb(d))),
      onMessage: (cb) => void bToA.push(cb),
    },
  };
}
