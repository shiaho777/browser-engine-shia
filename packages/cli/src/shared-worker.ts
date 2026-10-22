/**
 * RFC 0042 — the shared-worker REALM (the script side of `new SharedWorker()`).
 *
 * Same `worker_threads` + `vm` model as `dedicated-worker.ts`, but the
 * global is a SharedWorkerGlobalScope: every connecting client is a LANE —
 * the parent posts `{t:"connect", lane}` and the realm fires a `connect`
 * event carrying the lane's port. Messages between a page and the worker
 * ride `{t:"msg", lane, data}` frames; each lane's port is an independent
 * endpoint with its own queue, `onmessage`, `start()` and `close()`.
 *
 * Port semantics mirror real MessagePorts: a port whose `onmessage` isn't
 * set and whose `start()` wasn't called QUEUES inbound messages; setting
 * `onmessage` or calling `start()` flushes the queue. `close()` on either
 * side severs the lane.
 *
 * Honest boundaries (same as RFC 0032): classic scripts only, V8
 * structured clone payloads, no transferables, `importScripts` sync via
 * data/file/curl, worker `fetch` is raw undici (page jar/CSP/COEP do not
 * cross the thread boundary).
 */
import { parentPort, workerData } from "node:worker_threads";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const data = workerData as {
  source: string;
  url: string;
  name: string;
};

/** Blocking fetch for `importScripts` — identical to dedicated-worker. */
function syncFetch(url: string): Uint8Array | undefined {
  try {
    if (url.startsWith("data:")) {
      const comma = url.indexOf(",");
      if (comma < 0) return undefined;
      const meta = url.slice(5, comma);
      const body = url.slice(comma + 1);
      return new TextEncoder().encode(
        meta.endsWith(";base64") ? Buffer.from(body, "base64").toString("utf8") : decodeURIComponent(body),
      );
    }
    if (url.startsWith("file://")) {
      return new Uint8Array(readFileSync(fileURLToPath(url)));
    }
    if (/^https?:/i.test(url)) {
      const out = execFileSync("curl", ["-sfL", "--max-time", "10", url], {
        maxBuffer: 8 * 1024 * 1024,
      });
      return new Uint8Array(out);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** lane → { port face, inbound dispatcher } — lanes die on either side's close. */
const lanes = new Map<number, { port: Record<string, unknown>; dispatch: (payload: unknown) => void }>();

const makeLanePort = (lane: number): Record<string, unknown> => {
  const listeners: ((ev: { data: unknown }) => void)[] = [];
  const inboundQueue: unknown[] = [];
  let onmessage: unknown = null;
  let started = false;
  let closed = false;
  const dispatch = (payload: unknown): void => {
    if (closed) return;
    if (!started) {
      inboundQueue.push(payload);
      return;
    }
    const ev = { type: "message", data: payload };
    if (typeof onmessage === "function") (onmessage as (e: unknown) => void)(ev);
    for (const fn of [...listeners]) fn(ev);
  };
  const start = (): void => {
    if (started || closed) return;
    started = true;
    for (const pending of inboundQueue.splice(0)) dispatch(pending);
  };
  const port: Record<string, unknown> = {
    postMessage: (payload: unknown): void => {
      if (closed) return;
      parentPort?.postMessage({ t: "msg", lane, data: payload });
    },
    start,
    close: (): void => {
      if (closed) return;
      closed = true;
      inboundQueue.length = 0;
      lanes.delete(lane);
      parentPort?.postMessage({ t: "closed", lane });
    },
    addEventListener: (type: string, fn: unknown): void => {
      // Spec quirk mirrored faithfully: addEventListener does NOT start the
      // port — only `start()` or an `onmessage` assignment opens it.
      if (type === "message" && typeof fn === "function") {
        listeners.push(fn as (ev: { data: unknown }) => void);
      }
    },
    removeEventListener: (type: string, fn: unknown): void => {
      if (type !== "message") return;
      const i = listeners.indexOf(fn as (ev: { data: unknown }) => void);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
  Object.defineProperty(port, "onmessage", {
    get: () => onmessage,
    set: (fn: unknown) => {
      onmessage = typeof fn === "function" ? fn : null;
      start();
    },
    enumerable: true,
    configurable: true,
  });
  lanes.set(lane, { port, dispatch });
  return port;
};

const connectListeners: ((ev: { type: string; ports: readonly Record<string, unknown>[] }) => void)[] = [];

const sandbox: Record<string, unknown> = {
  location: { href: data.url, toString: () => data.url },
  name: data.name,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  queueMicrotask,
  fetch: globalThis.fetch,
  console,
  onconnect: null,
  onerror: null,
  close: (): void => {
    parentPort?.close();
  },
  importScripts: (...urls: unknown[]): void => {
    for (const raw of urls) {
      const resolved = new URL(String(raw), data.url).href;
      const bytes = syncFetch(resolved);
      if (bytes === undefined) {
        throw new Error(`importScripts: failed to load '${resolved}'`);
      }
      vm.runInContext(new TextDecoder().decode(bytes), ctx, { filename: resolved });
    }
  },
  addEventListener: (type: unknown, fn: unknown): void => {
    if (type === "connect" && typeof fn === "function") {
      connectListeners.push(fn as (ev: { type: string; ports: readonly Record<string, unknown>[] }) => void);
    }
  },
  removeEventListener: (type: unknown, fn: unknown): void => {
    if (type === "connect") {
      const i = connectListeners.indexOf(
        fn as (ev: { type: string; ports: readonly Record<string, unknown>[] }) => void,
      );
      if (i >= 0) connectListeners.splice(i, 1);
    }
  },
};
sandbox["self"] = sandbox;
sandbox["globalThis"] = sandbox;

const ctx = vm.createContext(sandbox);

interface LaneFrame {
  t: "connect" | "msg" | "close";
  lane: number;
  data?: unknown;
}

parentPort?.on("message", (frame: LaneFrame) => {
  if (frame.t === "connect") {
    const port = makeLanePort(frame.lane);
    const ev = { type: "connect", ports: [port] };
    const handler = sandbox["onconnect"];
    if (typeof handler === "function") (handler as (e: unknown) => void)(ev);
    for (const fn of [...connectListeners]) fn(ev);
    return;
  }
  if (frame.t === "close") {
    const lane = lanes.get(frame.lane);
    if (lane === undefined) return;
    // Client severed: the port face goes inert; the lane entry is dropped.
    lane.port["postMessage"] = () => undefined;
    lane.dispatch = () => undefined;
    lanes.delete(frame.lane);
    return;
  }
  if (frame.t === "msg") {
    lanes.get(frame.lane)?.dispatch(frame.data);
  }
});

// Top-level evaluation — a worker's script runs to completion before
// connect events dispatch (the browser evaluates the worker first).
vm.runInContext(data.source, ctx, { filename: data.url });
