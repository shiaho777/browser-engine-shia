/**
 * RFC 0032 — the parent-side `Worker` global.
 *
 * `new Worker(url, opts)` fetches the worker source through the document's
 * OWN subresource channel (initiator = the document, destination =
 * `"worker"`), CSP-checks it (`worker-src` → `script-src` → `default-src`),
 * then spawns a real `worker_threads` worker running
 * `dedicated-worker.ts` — a `vm` realm with a DedicatedWorkerGlobalScope.
 *
 * Inbound worker→parent messages are enqueued as TASKS on the page's
 * virtual event loop — they surface to guest `onmessage` handlers only
 * when the loop pumps (deterministic ordering; matches "queue a task" in
 * the spec). `terminate()` kills the thread and drops its pending inbound
 * tasks.
 */
import { Worker as NodeWorker } from "node:worker_threads";

import type { CspContext } from "./csp.js";
import type { VirtualEventLoop } from "./event-loop.js";

export interface WorkerGlobalDeps {
  /** The page's virtual loop — inbound messages enqueue as tasks. */
  readonly loop: VirtualEventLoop;
  /** The owning document's URL — base for worker-script resolution. */
  readonly documentUrl: string;
  /** Bytes channel for the worker script (destination "worker"). */
  readonly fetchWorkerSource: (url: string) => Promise<Uint8Array | undefined>;
  /** The document's CSP — `worker-src`/`script-src` gate the spawn. */
  readonly csp: CspContext | null;
  /** Cleanup hook — the session runtime disposes live workers on teardown. */
  readonly registerWorker?: (dispose: () => void) => void;
}

interface ParentWorker {
  postMessage: (data: unknown) => void;
  terminate: () => void;
  onmessage: unknown;
  onmessageerror: unknown;
  onerror: unknown;
  addEventListener: (type: string, fn: unknown) => void;
  removeEventListener: (type: string, fn: unknown) => void;
}

/** `worker-src` → `child-src` → `script-src` → `default-src` (CSP3 chain —
 *  already encoded in csp.ts's FALLBACK table). */
function workerAllowed(csp: CspContext, url: string): boolean {
  return csp.check("worker", url).allowed;
}

/**
 * Install `Worker` into a document sandbox. Returns the constructor placed
 * on `sandbox["Worker"]`.
 */
export function makeWorkerCtor(deps: WorkerGlobalDeps): (url: unknown, opts?: unknown) => ParentWorker {
  return function Worker(this: unknown, url: unknown, opts?: unknown): ParentWorker {
    const opt = (opts ?? {}) as { type?: unknown; name?: unknown };
    if (opt.type !== undefined && opt.type !== "classic") {
      // Classic-only for now — module workers need the ESM graph in the
      // worker realm (RFC 0032 boundary).
      throw new TypeError(
        `Worker type "${typeof opt.type === "string" ? opt.type : "unknown"}" is not supported — only "classic" workers exist yet`,
      );
    }
    const resolved = new URL(String(url), deps.documentUrl).href;
    const listeners = new Map<string, ((ev: unknown) => void)[]>();
    // The guest-facing handle — `onmessage`/`onerror` are plain properties
    // (setter detection isn't needed: we read them at dispatch time).
    const api: ParentWorker = {
      onmessage: null,
      onmessageerror: null,
      onerror: null,
      postMessage: (payload: unknown): void => {
        if (dead) return;
        if (node === null) pendingOut.push(payload);
        else node.postMessage(payload);
      },
      terminate: (): void => {
        dead = true;
        void node?.terminate();
        node = null;
      },
      addEventListener: (type: string, fn: unknown): void => {
        if (typeof fn !== "function") return;
        const list = listeners.get(type) ?? [];
        list.push(fn as (ev: unknown) => void);
        listeners.set(type, list);
      },
      removeEventListener: (type: string, fn: unknown): void => {
        const list = listeners.get(type);
        if (list === undefined) return;
        const i = list.indexOf(fn as (ev: unknown) => void);
        if (i >= 0) list.splice(i, 1);
      },
    };
    let node: NodeWorker | null = null;
    let dead = false;
    // postMessage-before-spawn queues (spec: messages queue as tasks on the
    // worker's event loop — it hasn't started yet, so WE hold the queue).
    const pendingOut: unknown[] = [];
    const dispatch = (kind: "message" | "error", ev: unknown): void => {
      // A terminated worker's inbound traffic never reaches the page.
      if (dead) return;
      deps.loop.setTimeout(() => {
        if (dead) return;
        const handler = kind === "message" ? api.onmessage : api.onerror;
        if (typeof handler === "function") (handler as (e: unknown) => void)(ev);
        for (const fn of [...(listeners.get(kind) ?? [])]) fn(ev);
      }, 0);
    };

    // CSP `worker-src` chain — a refused spawn is an async `error` event,
    // not a constructor throw (spec: "fire an event named error").
    const allowed = deps.csp !== null ? workerAllowed(deps.csp, resolved) : true;
    if (!allowed) {
      dispatch("error", {
        type: "error",
        message: `Refused to create a worker from '${resolved}' because it violates the document's Content Security Policy directive: "worker-src".`,
      });
      return api;
    }

    // Register at CONSTRUCTION time — a disposed page must kill even a
    // still-fetching worker (registering post-spawn races the fetch).
    deps.registerWorker?.(() => {
      dead = true;
      void node?.terminate();
      node = null;
    });

    void deps
      .fetchWorkerSource(resolved)
      .then((bytes) => {
        if (dead) return;
        if (bytes === undefined) {
          dispatch("error", {
            type: "error",
            message: `Worker source '${resolved}' failed to load`,
          });
          return;
        }
        node = new NodeWorker(new URL("./dedicated-worker.js", import.meta.url), {
          workerData: {
            source: new TextDecoder().decode(bytes),
            url: resolved,
            name: typeof opt.name === "string" ? opt.name : "",
          },
        });
        // An unref'd worker never keeps the page process alive on its own.
        node.unref();
        node.on("message", (payload: unknown) => {
          dispatch("message", { type: "message", data: payload });
        });
        node.on("error", (error: unknown) => {
          dispatch("error", {
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        });
        node.on("exit", () => {
          node = null;
        });
        // Flush queued outbound posts now that the thread exists.
        for (const payload of pendingOut.splice(0)) node.postMessage(payload);
      })
      .catch((error: unknown) => {
        dispatch("error", {
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return api;
  };
}
