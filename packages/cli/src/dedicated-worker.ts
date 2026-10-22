/**
 * RFC 0032 — the dedicated-worker REALM (the script side of `new Worker()`).
 *
 * This file is the `worker_threads` entry the page sandbox spawns. Inside
 * the thread we build a `vm` context with the DedicatedWorkerGlobalScope
 * surface (`self`, `postMessage`, `onmessage`, `importScripts`, `close`,
 * `location`, `name`, timers, `fetch`) and evaluate the worker source —
 * Node's own event loop inside the thread IS the worker's event loop, so
 * inbound parentPort messages queue as real tasks (the same ordering a
 * browser guarantees).
 *
 * Honest boundaries (documented in RFC 0031 style):
 * - classic workers only — `type:"module"` is rejected parent-side;
 * - `importScripts` is genuinely blocking: it covers `data:`/`file:`/
 *   `virtual:` synchronously and falls back to a `curl` subprocess for
 *   http(s) (a worker is a thread — blocking is legal);
 * - `fetch` inside the worker is the raw undici fetch — the page's cookie
 *   jar / CSP / COEP do NOT cross the thread boundary;
 * - payloads use V8 structured clone — no transferables, no DOM nodes.
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

/** Blocking fetch for `importScripts` — data/file read inline, http via curl. */
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

// `sandbox` is the DedicatedWorkerGlobalScope — `self`/`globalThis` point at
// the realm global like a real worker's global proxy does.
const sandbox: Record<string, unknown> = {
  location: { href: data.url, toString: () => data.url },
  name: data.name,
  // Timers/microtasks ride the thread's own loop — real async semantics.
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  queueMicrotask,
  fetch: globalThis.fetch,
  console,
  postMessage: (payload: unknown): void => {
    parentPort?.postMessage(payload);
  },
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
};
sandbox["self"] = sandbox;
sandbox["globalThis"] = sandbox;
sandbox["onmessage"] = null;
sandbox["onerror"] = null;

const messageListeners: ((ev: { data: unknown }) => void)[] = [];
sandbox["addEventListener"] = (type: unknown, fn: unknown): void => {
  if (type === "message" && typeof fn === "function") {
    messageListeners.push(fn as (ev: { data: unknown }) => void);
  }
};
sandbox["removeEventListener"] = (type: unknown, fn: unknown): void => {
  if (type === "message") {
    const i = messageListeners.indexOf(fn as (ev: { data: unknown }) => void);
    if (i >= 0) messageListeners.splice(i, 1);
  }
};

const ctx = vm.createContext(sandbox);

// Inbound messages dispatch through `onmessage` + message listeners — a
// plain `data` event object (structured-clone already crossed the port).
parentPort?.on("message", (payload: unknown) => {
  const ev = { data: payload };
  const handler = sandbox["onmessage"];
  // A throwing message handler surfaces like a top-level worker error.
  if (typeof handler === "function") (handler as (e: unknown) => void)(ev);
  for (const fn of [...messageListeners]) fn(ev);
});

// Top-level evaluation — an uncaught throw propagates to the parent's
// 'error' event (node worker_threads semantics), which the parent-side
// Worker maps onto `onerror`.
vm.runInContext(data.source, ctx, { filename: data.url });
