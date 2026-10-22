/**
 * RFC 0030 — the out-of-process iframe WORKER. Runs inside the web-content
 * process as a `node:worker_threads` worker: one worker per isolated child
 * navigable. It owns a full `BrowsingContext` (nested iframes inside an
 * OOPIF work — deeper cross-origin frames isolate recursively), its own
 * network stack + cookie jar, and its own storage registries.
 *
 * Wire protocol is plain structured-clone messages (not the generated IPC
 * codec — that codec is the browser↔content boundary; this boundary is
 * content-internal). `resources` fixtures let tests drive a virtual
 * transport; absent ⇒ a real network stack is built.
 */
import { parentPort } from "node:worker_threads";
import type { MessagePort } from "node:worker_threads";
import { createBrowserNetworkStack } from "@browser-engine/guest";
import type { BrowserNetworkStack } from "@browser-engine/guest";
import type { EngineViewport } from "./host-api.js";
import { BrowsingContext } from "./browsing-context.js";
import type { BrowsingContextDeps, FrameChild } from "./browsing-context.js";
import type { PageFrame } from "./page.js";
import { LocalStorageRegistry, SessionStorageRegistry } from "./session.js";

export interface OopifLoadMsg {
  readonly type: "load";
  readonly id: number;
  readonly url: string;
  readonly viewport: EngineViewport;
  readonly ancestorOrigins: readonly string[];
  /** The embedder's URL — becomes `window.parent`'s remote location. */
  readonly parentUrl: string;
  /** RFC 0031: the embedder's COEP gates this child document fetch. */
  readonly initiatorCoep?: "require-corp" | "credentialless" | "unsafe-none";
  /** url→html fixtures: a virtual transport replaces the network stack. */
  readonly resources?: Readonly<Record<string, string>>;
}

export interface OopifNavigateMsg {
  readonly type: "navigate";
  readonly id: number;
  readonly url: string;
}

export interface OopifDeliverMsg {
  readonly type: "deliver";
  readonly data: unknown;
  readonly targetOrigin: string | null;
  readonly sourceOrigin: string;
  readonly sourceUrl: string;
}

export interface OopifDisposeMsg {
  readonly type: "dispose";
}

export type OopifRequest =
  | OopifLoadMsg
  | OopifNavigateMsg
  | OopifDeliverMsg
  | OopifDisposeMsg;

export interface OopifResultMsg {
  readonly type: "result";
  readonly id: number;
  readonly ok: boolean;
  readonly url?: string;
  readonly title?: string;
  readonly png?: Uint8Array;
  readonly error?: string;
}

export interface OopifPostMessageMsg {
  readonly type: "postMessage";
  readonly data: unknown;
  readonly targetOrigin: string | null;
  readonly sourceUrl: string;
}

/** `target=_parent`/`_top` (or `parent.location=`) inside the remote frame. */
export interface OopifNavReplyMsg {
  readonly type: "nav";
  readonly url: string;
}

export type OopifReply =
  | OopifResultMsg
  | OopifPostMessageMsg
  | OopifNavReplyMsg;

const port: MessagePort = (() => {
  if (parentPort === null) {
    throw new Error("oopif-worker: must run under node:worker_threads");
  }
  return parentPort;
})();

let ctx: BrowsingContext | null = null;
let remoteParent: RemoteParent | null = null;
let network: BrowserNetworkStack | null = null;
let resources: Readonly<Record<string, string>> | undefined;

/**
 * The remote embedder, made concrete: a real `BrowsingContext` (so
 * `deps.parent`/`deps.root` and every `instanceof BrowsingContext` narrow
 * still hold) whose ONLY outbound verbs are port messages — `deliverMessage`
 * ⇒ `postMessage` reply to the embedder thread; `navigate` ⇒ `nav` reply so
 * `target=_parent`/`_top`/`parent.location=` navigates the real embedder.
 * It never loads a page: `page`/`globals` stay null and its WindowProxy
 * exposes no `document` (cross-origin by construction).
 */
class RemoteParent extends BrowsingContext {
  readonly #remoteUrl: string;

  constructor(deps: BrowsingContextDeps, url: string) {
    super(deps);
    this.#remoteUrl = url;
  }

  override get url(): string {
    return this.#remoteUrl;
  }

  /** child→embedder: `window.parent.postMessage` lands here via proxyFor. */
  override deliverMessage(
    data: unknown,
    targetOrigin: unknown,
    _source: FrameChild,
  ): void {
    try {
      port.postMessage({
        type: "postMessage",
        data,
        targetOrigin: typeof targetOrigin === "string" ? targetOrigin : null,
        sourceUrl: ctx?.url ?? "",
      } satisfies OopifPostMessageMsg);
    } catch {
      // Unserializable payloads drop like a DataCloneError abort.
    }
  }

  /** Embedder-side navigation request — completes in the parent thread. */
  override navigate(url: string): Promise<PageFrame> {
    port.postMessage({ type: "nav", url } satisfies OopifNavReplyMsg);
    // The navigation is unobservable from this thread; stay pending so the
    // caller's intent queue simply never sees a completion (spec-wise the
    // embedder's navigation races everything anyway).
    return new Promise<PageFrame>(() => {});
  }
}

async function handleLoad(msg: OopifLoadMsg | OopifNavigateMsg): Promise<OopifResultMsg> {
  const id = msg.id;
  try {
    if (msg.type === "load") {
      resources = msg.resources;
      // Pin the load-time values — the union-typed `msg` doesn't narrow
      // inside escaping closures.
      const ancestors = msg.ancestorOrigins;
      const viewport = msg.viewport;
      const url = msg.url;
      const parentUrl = msg.parentUrl;
      const stack = (network ??= createBrowserNetworkStack({ baseUrl: url }));
      // The remote embedder: `parent`/`top` globals and _parent/_top
      // navigations resolve against it — structurally, before any child
      // script runs (no post-commit patching).
      remoteParent = new RemoteParent(
        {
          network: stack,
          localRegistry: new LocalStorageRegistry(),
          sessionStores: new SessionStorageRegistry(),
          parent: null,
          depth: 0,
          viewportFor: () => viewport,
        },
        parentUrl,
      );
      const parent_ = remoteParent;
      ctx = new BrowsingContext({
        network: stack,
        localRegistry: new LocalStorageRegistry(),
        sessionStores: new SessionStorageRegistry(),
        parent: parent_,
        root: parent_,
        depth: 0,
        ancestorOriginsFor: () => ancestors,
        viewportFor: () => viewport,
        ...(resources !== undefined
          ? {
              virtualFetch: (u: string): Promise<Uint8Array | undefined> => {
                const body = resources![u];
                return Promise.resolve(
                  body === undefined ? undefined : new TextEncoder().encode(body),
                );
              },
            }
          : {}),
      });
      await ctx.navigate(msg.url, {
        push: true,
        ...(msg.initiatorCoep !== undefined
          ? { initiatorCoep: msg.initiatorCoep }
          : {}),
      });
      const p = ctx.page;
      return {
        type: "result",
        id,
        ok: true,
        url: ctx.url,
        title: ctx.title,
        ...(p?.pngBytes !== undefined ? { png: p.pngBytes } : {}),
      };
    }
    if (ctx === null) {
      return { type: "result", id, ok: false, error: "navigate before load" };
    }
    await ctx.navigate(msg.url, { push: true });
    const p = ctx.page;
    return {
      type: "result",
      id,
      ok: true,
      url: ctx.url,
      title: ctx.title,
      ...(p?.pngBytes !== undefined ? { png: p.pngBytes } : {}),
    };
  } catch (e) {
    return { type: "result", id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function handleDeliver(msg: OopifDeliverMsg): void {
  const g = ctx?.globals;
  const page = ctx?.page;
  if (g === null || g === undefined || page === null || page === undefined) return;
  // Honor targetOrigin against the CHILD's own origin (we are the target).
  if (msg.targetOrigin !== null && msg.targetOrigin !== "/" && msg.targetOrigin !== "*") {
    let actual = "null";
    try {
      actual = new URL(ctx!.url).origin;
    } catch {
      // Guest/page code may throw here; swallowed by design.
    }
    if (msg.targetOrigin !== actual) return;
  }
  let cloned: unknown = msg.data;
  try {
    cloned = JSON.parse(JSON.stringify(msg.data ?? null)) as unknown;
  } catch {
    return;
  }
  // `event.source` is the embedder's WindowProxy — `e.source.postMessage`
  // replies over the port via RemoteParent.deliverMessage.
  page.runtime?.fireEvent?.("message", {
    data: cloned,
    origin: msg.sourceOrigin,
    source: remoteParent?.proxyFor(ctx!) ?? null,
  });
}

port.on("message", (raw: OopifRequest) => {
  void (async () => {
    if (raw.type === "load" || raw.type === "navigate") {
      const reply: OopifReply = await handleLoad(raw);
      port.postMessage(reply);
      return;
    }
    if (raw.type === "deliver") {
      handleDeliver(raw);
      return;
    }
    if (raw.type === "dispose") {
      process.exit(0);
    }
  })();
});
