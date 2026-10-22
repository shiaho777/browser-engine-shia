/**
 * webcontent-client.ts — the browser-process half of RFC 0004.
 *
 * `WebContentClient` owns one web-content worker thread and exposes the tab's
 * engine operations as typed RPCs. If the renderer dies (`error`/`exit`), all
 * in-flight calls reject with {@link RendererDeadError} and the next call
 * respawns the worker — per-tab process isolation, like a browser's.
 */
import { Worker } from "node:worker_threads";

import {
  ChannelClosedError,
  RpcClient,
  type AppReply,
  type AppRequest,
  type Frame,
  type HitInfo,
  type HistorySnapshot,
  type NavState,
  type StatusReply,
  type StorageAreaSnapshot,
} from "@browser-engine/ipc";

import type { EngineViewport } from "./host-api.js";

/** The renderer exited (or errored) mid-call. */
export class RendererDeadError extends Error {
  constructor() {
    super("web-content renderer exited");
    this.name = "RendererDeadError";
  }
}

export interface ClickOutcome {
  readonly hit: HitInfo;
  readonly navigated: boolean;
  readonly frame: Frame | null;
  readonly editable: HitInfo["editable"];
  readonly nav: NavState;
}

export interface PumpOutcome {
  readonly frames: number;
  readonly mutations: number;
  readonly frameRev: number;
  readonly frame: Frame | null;
  readonly nav: NavState;
}

function wireViewport(v: Partial<EngineViewport> | null | undefined): {
  width: number;
  height: number;
  devicePixelRatio: number;
} | null {
  if (v === null || v === undefined) return null;
  return {
    width: v.width ?? 0,
    height: v.height ?? 0,
    devicePixelRatio: v.devicePixelRatio ?? 0,
  };
}

export class WebContentClient {
  #worker: Worker | null = null;
  #rpc: RpcClient | null = null;
  #disposed = false;
  readonly #profileDir: string | undefined;
  readonly #downloadsDir: string | undefined;
  readonly #identity:
    | {
        tabId: number;
        openerTabId: number | null;
        scriptOpened: boolean;
        openerInfo?: {
          readonly origin: string | null;
          readonly coop: string;
          readonly popup: boolean;
        };
      }
    | undefined;

  constructor(
    profileDir?: string,
    downloadsDir?: string,
    identity?: {
      tabId?: number;
      openerTabId?: number | null;
      scriptOpened?: boolean;
      openerInfo?: {
        readonly origin: string | null;
        readonly coop: string;
        readonly popup: boolean;
      };
    },
  ) {
    this.#profileDir = profileDir;
    this.#downloadsDir = downloadsDir;
    this.#identity = identity === undefined
      ? undefined
      : {
          tabId: identity.tabId ?? 0,
          openerTabId: identity.openerTabId ?? null,
          scriptOpened: identity.scriptOpened === true,
          ...(identity.openerInfo !== undefined
            ? { openerInfo: identity.openerInfo }
            : {}),
        };
  }

  /** Spawn the worker if it isn't running. */
  #ensure(): RpcClient {
    if (this.#disposed) throw new ChannelClosedError("tab closed");
    if (this.#rpc !== null && !this.#rpc.closed) return this.#rpc;
    const worker = new Worker(new URL("./webcontent-worker.js", import.meta.url), {
      workerData: {
        profileDir: this.#profileDir ?? null,
        downloadsDir: this.#downloadsDir ?? null,
        tabId: this.#identity?.tabId ?? 0,
        openerTabId: this.#identity?.openerTabId ?? null,
        scriptOpened: this.#identity?.scriptOpened ?? false,
        openerInfo: this.#identity?.openerInfo ?? null,
      },
    });
    worker.unref();
    const rpc = new RpcClient({
      postMessage: (data, transfer) =>
        worker.postMessage(data, transfer === undefined ? undefined : [...transfer]),
      onMessage: (cb) => worker.on("message", (d: ArrayBuffer) => cb(d)),
    });
    const onDead = () => {
      rpc.failAll(new RendererDeadError());
      this.#rpc = null;
      this.#worker = null;
    };
    worker.once("error", onDead);
    worker.once("exit", onDead);
    this.#worker = worker;
    this.#rpc = rpc;
    return rpc;
  }

  async #call(msg: AppRequest): Promise<AppReply> {
    const rpc = this.#ensure();
    return rpc.call(msg);
  }

  #frameReply(reply: AppReply): { frame: Frame | null; nav: NavState } {
    if (reply.kind !== "frameReply") throw new Error(`ipc: expected frameReply, got ${reply.kind}`);
    const r = reply;
    return { frame: r.frame, nav: r.nav };
  }

  navigate(
    url: string,
    viewport: Partial<EngineViewport>,
    options: { push?: boolean; keepAlive?: boolean; referrerPolicy?: string } = {},
  ): Promise<{ frame: Frame | null; nav: NavState }> {
    return this.#call({
      kind: "load",
      url,
      viewport: wireViewport(viewport) ?? { width: 0, height: 0, devicePixelRatio: 0 },
      keepAlive: options.keepAlive === true,
      push: options.push ?? true,
      referrerPolicy: options.referrerPolicy ?? null,
    }).then((r) => this.#frameReply(r));
  }

  loadHtml(
    html: string,
    title: string,
    viewport: Partial<EngineViewport>,
  ): Promise<{ frame: Frame | null; nav: NavState }> {
    return this.#call({
      kind: "loadHtml",
      html,
      title,
      viewport: wireViewport(viewport) ?? { width: 0, height: 0, devicePixelRatio: 0 },
    }).then((r) => this.#frameReply(r));
  }

  back(viewport?: Partial<EngineViewport>): Promise<{ frame: Frame | null; nav: NavState }> {
    return this.#call({ kind: "back", viewport: wireViewport(viewport) }).then((r) =>
      this.#frameReply(r),
    );
  }

  forward(viewport?: Partial<EngineViewport>): Promise<{ frame: Frame | null; nav: NavState }> {
    return this.#call({ kind: "forward", viewport: wireViewport(viewport) }).then((r) =>
      this.#frameReply(r),
    );
  }

  reload(viewport?: Partial<EngineViewport>): Promise<{ frame: Frame | null; nav: NavState }> {
    return this.#call({ kind: "reload", viewport: wireViewport(viewport) }).then((r) =>
      this.#frameReply(r),
    );
  }

  setViewport(viewport: Partial<EngineViewport>): Promise<{ frame: Frame | null; nav: NavState }> {
    const v = wireViewport(viewport);
    if (v === null) throw new Error("setViewport requires width/height");
    return this.#call({ kind: "setViewport", viewport: v }).then((r) => this.#frameReply(r));
  }

  scroll(
    dx: number,
    dy: number,
    options: { settle?: boolean; viewport?: Partial<EngineViewport> } = {},
  ): Promise<{ frame: Frame | null; nav: NavState }> {
    return this.#call({
      kind: "scroll",
      dx,
      dy,
      settle: options.settle === true,
      viewport: wireViewport(options.viewport),
    }).then((r) => this.#frameReply(r));
  }

  async hitTest(x: number, y: number): Promise<HitInfo> {
    const reply = await this.#call({ kind: "hitTest", x, y });
    if (reply.kind !== "hitInfoReply") throw new Error(`ipc: expected hitInfoReply, got ${reply.kind}`);
    return (reply).hit;
  }

  async click(x: number, y: number, viewport?: Partial<EngineViewport>): Promise<ClickOutcome> {
    const reply = await this.#call({
      kind: "clickAt",
      x,
      y,
      viewport: wireViewport(viewport),
    });
    if (reply.kind !== "clickReply") throw new Error(`ipc: expected clickReply, got ${reply.kind}`);
    const r = reply;
    return { hit: r.hit, navigated: r.navigated, frame: r.frame, editable: r.editable, nav: r.nav };
  }

  async commitText(
    nodeId: string,
    text: string,
    options: { caret?: number; selStart?: number; selEnd?: number; preview?: boolean } = {},
  ): Promise<{ frame: Frame | null; nav: NavState }> {
    const caret = options.caret ?? text.length;
    const reply = await this.#call({
      kind: "commitText",
      nodeId,
      text,
      caret,
      selStart: options.selStart ?? caret,
      selEnd: options.selEnd ?? caret,
      preview: options.preview === true,
    });
    return this.#frameReply(reply);
  }

  async pump(
    count: number,
    options: { settleMs?: number; idleStop?: boolean } = {},
  ): Promise<PumpOutcome> {
    const reply = await this.#call({
      kind: "pump",
      count,
      settleMs: options.settleMs ?? 200,
      idleStop: options.idleStop !== false,
    });
    if (reply.kind !== "pumpReply") throw new Error(`ipc: expected pumpReply, got ${reply.kind}`);
    const r = reply;
    return { frames: r.frames, mutations: r.mutations, frameRev: r.frameRev, frame: r.frame, nav: r.nav };
  }

  async frameBytes(): Promise<{ png: Uint8Array | null; frameRev: number }> {
    const reply = await this.#call({ kind: "getFrame" });
    if (reply.kind !== "frameBytesReply") {
      throw new Error(`ipc: expected frameBytesReply, got ${reply.kind}`);
    }
    const r = reply;
    return { png: r.png, frameRev: r.frameRev };
  }

  async navState(): Promise<NavState> {
    const reply = await this.#call({ kind: "getNav" });
    if (reply.kind !== "navStateReply") {
      throw new Error(`ipc: expected navStateReply, got ${reply.kind}`);
    }
    return (reply).nav;
  }

  /** sessionStorage snapshot across origins — the duplication clone. */
  async exportSessionStorage(): Promise<readonly StorageAreaSnapshot[]> {
    const reply = await this.#call({ kind: "exportSessionStorage" });
    if (reply.kind !== "sessionStorageReply") {
      throw new Error(`ipc: expected sessionStorageReply, got ${reply.kind}`);
    }
    return reply.areas;
  }

  /** Clone a sessionStorage snapshot into this renderer's stores. */
  async importSessionStorage(areas: readonly StorageAreaSnapshot[]): Promise<void> {
    const reply = await this.#call({
      kind: "importSessionStorage",
      areas: areas.map((a) => ({ origin: a.origin, keys: [...a.keys], values: [...a.values] })),
    });
    if (reply.kind !== "statusReply") {
      throw new Error(`ipc: expected statusReply, got ${reply.kind}`);
    }
  }

  /** The renderer's serialized session history (restart persistence). */
  async exportSessionHistory(): Promise<HistorySnapshot> {
    const reply = await this.#call({ kind: "exportHistory" });
    if (reply.kind !== "historyReply") {
      throw new Error(`ipc: expected historyReply, got ${reply.kind}`);
    }
    return reply.snapshot;
  }

  /** Restore a persisted history — reloads the current entry, returns frame. */
  async importSessionHistory(
    snapshot: HistorySnapshot,
  ): Promise<{ frame: Frame | null; nav: NavState }> {
    const reply = await this.#call({
      kind: "importHistory",
      snapshot: {
        index: snapshot.index,
        entries: snapshot.entries.map((e) => ({
          url: e.url,
          title: e.title,
          scrollY: e.scrollY,
          stateJson: e.stateJson,
          docKey: e.docKey,
        })),
      },
    });
    return this.#frameReply(reply);
  }

  /**
   * Inbound cross-tab postMessage — the shell routed a `PendingPostMessage`
   * addressed at this tab. Delivers into the top-level context's realm.
   */
  async deliverMessage(msg: {
    fromTabId: number;
    fromUrl: string;
    dataJson: string;
    targetOrigin: string | null;
  }): Promise<{ frame: Frame | null; nav: NavState }> {
    const reply = await this.#call({
      kind: "deliverMessage",
      fromTabId: msg.fromTabId,
      fromUrl: msg.fromUrl,
      dataJson: msg.dataJson,
      targetOrigin: msg.targetOrigin,
    });
    return this.#frameReply(reply);
  }

  async ping(): Promise<StatusReply> {
    const reply = await this.#call({ kind: "ping" });
    if (reply.kind !== "statusReply") throw new Error(`ipc: expected statusReply, got ${reply.kind}`);
    return reply;
  }

  /** Acknowledge shutdown; the worker stays alive until {@link terminate}. */
  async dispose(): Promise<void> {
    if (this.#rpc === null || this.#rpc.closed) return;
    try {
      await this.#call({ kind: "dispose" });
    } catch {
      // Disposal is best-effort — terminate below is authoritative.
    }
  }

  /**
   * Kill the renderer without closing the tab binding — the next call
   * respawns a fresh web-content worker (crashed-tab semantics; also the
   * seam a future watchdog uses for hung renderers).
   */
  async kill(): Promise<void> {
    const worker = this.#worker;
    if (worker === null) return;
    // `terminate` triggers the 'exit' handler, which fails pending calls and
    // clears #rpc/#worker so the next call spawns a fresh renderer.
    await worker.terminate();
  }

  /** Terminate the renderer synchronously and free the channel. */
  async terminate(): Promise<void> {
    this.#disposed = true;
    const worker = this.#worker;
    this.#worker = null;
    if (this.#rpc !== null) {
      this.#rpc.failAll(new ChannelClosedError("tab closed"));
      this.#rpc = null;
    }
    if (worker !== null) await worker.terminate();
  }
}
