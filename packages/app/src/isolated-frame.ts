/**
 * RFC 0030 — parent-side handle for an out-of-process iframe (OOPIF).
 * The child's whole browsing context lives in a `worker_threads` worker
 * (`oopif-worker.ts`); this class is the narrow port-backed surface the
 * parent frame tree sees: a WindowProxy (postMessage + location.href +
 * closed ONLY — cross-origin objects expose nothing else per HTML §7.4.3),
 * a composited bitmap, navigation forwarding, and teardown.
 */
import { Worker } from "node:worker_threads";
import type { NodeId } from "@browser-engine/ir";
import type { EngineViewport } from "./host-api.js";
import type {
  OopifReply,
  OopifRequest,
  OopifResultMsg,
} from "./oopif-worker.js";

interface PendingCall {
  readonly resolve: (msg: OopifResultMsg) => void;
  readonly reject: (err: Error) => void;
}

export interface IsolatedFrameDeps {
  /** The iframe element nodeId in the parent document. */
  readonly ownerElement: NodeId;
  /** Outbound child→parent postMessage delivery (routes via the parent ctx). */
  readonly onMessageOut: (
    frame: IsolatedFrame,
    data: unknown,
    targetOrigin: string | null,
  ) => void;
  /**
   * `target=_parent`/`_top`/`parent.location=` inside the remote frame asks
   * the embedder to navigate (the worker's RemoteParent relays it).
   */
  readonly onNavigateOut?: (url: string) => void;
  /**
   * url→html fixtures: a virtual transport inside the worker (tests /
   * engine:// pages); absent ⇒ the worker runs a real network stack.
   */
  readonly resources?: Readonly<Record<string, string>>;
  readonly workerUrl?: string | URL;
}

export class IsolatedFrame {
  readonly ownerElement: NodeId;
  #worker: Worker;
  #seq = 0;
  #pending = new Map<number, PendingCall>();
  #png: Uint8Array | undefined;
  #closed = false;
  #onMessageOut: IsolatedFrameDeps["onMessageOut"];
  readonly #onNav: IsolatedFrameDeps["onNavigateOut"];
  readonly #resources: Readonly<Record<string, string>> | undefined;
  /** The committed URL (post-redirect), reported by the worker. */
  url = "about:blank";
  title = "";

  constructor(deps: IsolatedFrameDeps) {
    this.ownerElement = deps.ownerElement;
    this.#onMessageOut = deps.onMessageOut;
    this.#onNav = deps.onNavigateOut;
    this.#resources = deps.resources;
    const workerUrl =
      deps.workerUrl ?? new URL("./oopif-worker.js", import.meta.url);
    this.#worker = new Worker(workerUrl);
    this.#worker.unref();
    this.#worker.on("message", (raw: OopifReply) => this.#onReply(raw));
    this.#worker.on("error", () => this.#failAll(new Error("oopif worker error")));
    this.#worker.on("exit", () => this.#failAll(new Error("oopif worker exited")));
  }

  #failAll(err: Error): void {
    for (const [, p] of this.#pending) p.reject(err);
    this.#pending.clear();
  }

  #onReply(msg: OopifReply): void {
    if (msg.type === "postMessage") {
      this.#onMessageOut(this, msg.data, msg.targetOrigin);
      return;
    }
    if (msg.type === "nav") {
      // The remote document asked to navigate its embedder
      // (target=_parent/_top, parent.location=…).
      this.#onNav?.(msg.url);
      return;
    }
    if (msg.type === "result") {
      const pending = this.#pending.get(msg.id);
      if (pending === undefined) return;
      this.#pending.delete(msg.id);
      if (msg.ok) {
        if (msg.url !== undefined) this.url = msg.url;
        if (msg.title !== undefined) this.title = msg.title;
        if (msg.png !== undefined) this.#png = msg.png;
      }
      pending.resolve(msg);
    }
  }

  #call(msg: { type: "load" | "navigate" } & Record<string, unknown>): Promise<OopifResultMsg> {
    const id = ++this.#seq;
    return new Promise<OopifResultMsg>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage({ ...msg, id });
    });
  }

  async load(opts: {
    readonly url: string;
    readonly viewport: EngineViewport;
    readonly ancestorOrigins: readonly string[];
    readonly parentUrl: string;
    readonly initiatorCoep?: "require-corp" | "credentialless" | "unsafe-none";
  }): Promise<boolean> {
    const res = await this.#call({
      type: "load",
      url: opts.url,
      viewport: opts.viewport,
      ancestorOrigins: opts.ancestorOrigins,
      parentUrl: opts.parentUrl,
      ...(opts.initiatorCoep !== undefined
        ? { initiatorCoep: opts.initiatorCoep }
        : {}),
      ...(this.#resources !== undefined ? { resources: this.#resources } : {}),
    });
    if (!res.ok) return false;
    // The load reply carries the first frame's pixels synchronously.
    return true;
  }

  /** Attribute-drift / named-target navigation of the remote document. */
  async navigate(url: string): Promise<null> {
    const res = await this.#call({ type: "navigate", url });
    if (res.ok) {
      // result handler already stored url/png.
    }
    return null;
  }

  /** The child's composited bitmap (PNG bytes), or undefined before paint. */
  get framePngBytes(): Uint8Array | undefined {
    return this.#png;
  }

  /**
   * Parent→child postMessage (parent's `childProxy.postMessage` called this).
   * `targetOrigin` is re-checked inside the worker against the child's own
   * committed origin.
   */
  deliverRemoteMessage(
    data: unknown,
    targetOrigin: unknown,
    sourceOrigin: string,
    sourceUrl: string,
  ): void {
    try {
      this.#worker.postMessage({
        type: "deliver",
        data,
        targetOrigin: typeof targetOrigin === "string" ? targetOrigin : null,
        sourceOrigin,
        sourceUrl,
      } satisfies OopifRequest);
    } catch {
      // Unserializable payload — drop like a DataCloneError abort.
    }
  }

  /**
   * The cross-origin WindowProxy the embedder sees: `postMessage`, `closed`,
   * `location.href` and NOTHING else — `document` doesn't even exist as a
   * property (HTML §7.4.3 cross-origin objects).
   */
  proxyFor(source: { readonly url: string }): Record<string, unknown> {
    return {
      postMessage: (data: unknown, targetOrigin?: unknown) => {
        // event.origin inside the remote document names the SENDER.
        let sourceOrigin = "null";
        try {
          sourceOrigin = new URL(source.url).origin;
        } catch {
          /* opaque-initiator page — "null" is correct */
        }
        this.deliverRemoteMessage(data, targetOrigin, sourceOrigin, source.url);
      },
      closed: this.#closed,
      location: { href: this.url },
    };
  }

  /** Cross-origin frames never expose a document — always null. */
  documentFor(): null {
    return null;
  }

  /** No guest intents to drain parent-side — the worker owns its queue. */
  drainIntents(): Promise<null> {
    return Promise.resolve(null);
  }

  /** Honest boundary: the page lives in another process — never a PageState. */
  get page(): null {
    return null;
  }

  /** Honest boundary: the sandbox globals live in another process. */
  get globals(): null {
    return null;
  }

  /** Joint-history introspection can't see a remote frame — always false. */
  canGoBack(): false {
    return false;
  }

  canGoForward(): false {
    return false;
  }

  get closed(): boolean {
    return this.#closed;
  }

  dispose(): void {
    this.#closed = true;
    try {
      this.#worker.postMessage({ type: "dispose" } satisfies OopifRequest);
    } catch {
      // worker may already be gone
    }
    void this.#worker.terminate();
    this.#failAll(new Error("oopif disposed"));
  }
}
