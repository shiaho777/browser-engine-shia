/**
 * Browsing context (RFC 0013): the per-document-tree-node session machine —
 * structured history, the guest↔host bridge, owned navigation lifecycle,
 * bfcache retention, and nested child contexts for iframes.
 *
 * Extracted from TabSession so the TOP-LEVEL context and every nested
 * `<iframe>` run the SAME navigation semantics — one implementation, no
 * parallel frame machinery to drift. A context shares its tab's network
 * stack (one cookie jar / HTTP cache) and storage registries; only history,
 * the live page, and the guest host are per-context.
 */

import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";

import { getBoundingClientRect } from "@browser-engine/layout";
import type { DomTree, FragmentTree, NodeId } from "@browser-engine/ir";
import { decodeImageBytesAsync } from "@browser-engine/backend";
import type { DecodedImage } from "@browser-engine/ir";

import {
  type EngineViewport,
} from "./host-api.js";
import {
  LocalStorageRegistry,
  SessionHistory,
  SessionHost,
  SessionStorageRegistry,
  createMemoryStorageArea,
  localStorageOrigin,
  sameDocumentUrl,
  fragmentOf,
  parseWindowFeatures,
  type NavigationIntent,
  type SessionEntry,
  type SessionHistorySnapshot,
  type WindowFeatures,
} from "./session.js";
import type { BrowserNetworkStack, NetworkResponse } from "@browser-engine/guest";
import { documentReferrerPolicy } from "@browser-engine/cli";
import { domFacadeDocument } from "./frame-dom-facade.js";
import { IsolatedFrame } from "./isolated-frame.js";
import { shouldIsolateFrame } from "./site-isolation.js";
import {
  loadHtmlDocument,
  loadPage,
  pumpFrames,
  repaintPage,
  resolveNavigationTarget,
  type PageFrame,
  type PageState,
} from "./page.js";

/** A retained (bfcache) entry's payload — the page plus its live children. */
export interface RetainedEntry {
  readonly url: string;
  readonly page: PageState;
  readonly frames: ReadonlyMap<NodeId, FrameChild>;
  /** iframe load signatures retained alongside the frame tree. */
  readonly sigs: ReadonlyMap<NodeId, string>;
}

/** Construction wiring for a browsing context (shared per tab). */
export interface BrowsingContextDeps {
  /** The TAB's network stack — jar/cache shared by every nested context. */
  readonly network: BrowserNetworkStack;
  /** Per-origin localStorage (process-wide). */
  readonly localRegistry: LocalStorageRegistry;
  /** Per-(tab,origin) sessionStorage. */
  readonly sessionStores: SessionStorageRegistry;
  /** Root context — `target=_top` resolves here. Absent ⇒ self (the tab root). */
  root?: BrowsingContext;
  /** Parent context — `target=_parent` / `parent`/`top` proxies. */
  readonly parent: BrowsingContext | null;
  /** Nesting depth — iframe recursion is capped (self-src cycles). */
  readonly depth: number;
  /** The element in the PARENT document owning this context (iframe node). */
  readonly ownerElement?: NodeId;
  /** The iframe's `sandbox` token list; absent ⇒ unsandboxed. */
  readonly sandboxTokens?: ReadonlySet<string>;
  /** Child viewport provider: the iframe's laid-out content-box size. */
  readonly viewportFor: () => EngineViewport;
  /** Tab-level new-tab hook for `target=_blank`/`window.open`/unknown names. */
  readonly onNewTab?: (
    url: string,
    init?: {
      referrerPolicy?: string;
      popup?: boolean;
      width?: number;
      height?: number;
      /** Named traversable — the shell reuses a tab registered under it. */
      name?: string | null;
      /** `window.open` ⇒ the new tab may `window.close()` itself (spec). */
      scriptOpened?: boolean;
      /** The spawned tab gets NO `window.opener` (noopener/noreferrer). */
      noopener?: boolean;
    },
  ) => void;
  /**
   * `window.open` needs a real new top-level context — in-process hosts return
   * it so the caller gets a WindowProxy; remote (worker) hosts return null and
   * rely on `onNewTab` queueing (a proxy can't cross the worker boundary).
   */
  readonly onOpenWindow?: (url: string, features: WindowFeatures) => BrowsingContext | null;
  /**
   * Download sink: when the thunk returns a directory, `a[download]` and
   * `Content-Disposition: attachment` document responses write there instead
   * of navigating. Undefined/undefined-returning ⇒ downloads stay suppressed.
   */
  readonly downloadsDir?: () => string | undefined;
  /** Chrome callback once a download lands on disk. */
  readonly onDownload?: (file: DownloadedFile) => void;
  /**
   * The chrome-level beforeunload prompt: consulted ONLY when guest code
   * canceled the event (preventDefault/returnValue) — `false` aborts the
   * navigation. Unset ⇒ the shell declines to prompt ⇒ proceed.
   */
  readonly confirmLeave?: () => boolean;
  /** `window.close()` on a script-opened tab — the shell closes the tab. */
  readonly onCloseTab?: () => void;
  /**
   * Cross-tab postMessage relay — the shell routes the message to
   * `targetTabId`'s renderer (worker→worker messaging is browser-mediated).
   */
  readonly onPostMessageRemote?: (msg: PendingPostMessage) => void;
  /** Owning tab id — tags outbound postMessages; 0 when unknown (tests). */
  readonly tabId?: number;
  /** Opener tab id — feeds `window.opener`; null/absent ⇒ no opener. */
  readonly openerTabId?: number | null;
  /**
   * RFC 0031: the opener's identity+COOP captured at window-open time — the
   * opened document's own COOP can sever `window.opener` on its first commit.
   */
  readonly openerInfo?: {
    readonly origin: string | null;
    readonly coop: import("@browser-engine/guest").Coop;
    readonly popup: boolean;
  };
  /** `window.open`-created ⇒ `window.close()` may self-close (script-closable). */
  readonly scriptOpened?: boolean;
  /** `window.focus()` / `proxy.focus()` targets — the shell activates them. */
  readonly onFocusRequest?: (tabId: number) => void;
  /**
   * RFC 0030: a byte-fetch transport REPLACING the network stack for document
   * loads — used by the OOPIF worker's `resources` fixtures (the isolated
   * context then never touches the real wire). http(s) URLs still parse and
   * navigate normally; headers simply don't exist.
   */
  readonly virtualFetch?: (url: string) => Promise<Uint8Array | undefined>;
  /**
   * RFC 0030: ancestor-origin chain supplier for a context whose parents
   * live OUTSIDE this process (OOPIF worker — `deps.parent` is null but the
   * document still has ancestors for `frame-ancestors` checks).
   */
  readonly ancestorOriginsFor?: () => readonly string[];
  /**
   * RFC 0030: OOPIF wiring — `resources` gives the isolated worker a virtual
   * transport (tests/fixtures); `workerUrl` overrides the worker entry path
   * (tests run from dist). Absent ⇒ real network stack + compiled worker.
   */
  readonly oopif?: {
    readonly resources?: Readonly<Record<string, string>>;
    readonly workerUrl?: string | URL;
  };
}

/**
 * A postMessage payload addressed to another tab — mirrors the wire struct.
 * `dataJson` is the JSON-cloned payload (structured clone can't cross our
 * process boundary); `targetOrigin` filters delivery per spec.
 */
export interface PendingPostMessage {
  readonly targetTabId: number;
  readonly fromTabId: number;
  readonly fromUrl: string;
  readonly dataJson: string;
  readonly targetOrigin: string | null;
}

const MAX_FRAME_DEPTH = 3;

/** Unique-per-load opaque origins (sandboxed frames never share storage/DOM). */
let opaqueSeq = 0;

/**
 * One event in a download's lifecycle — `started` → `progress`* →
 * `completed` | `failed`. `bytes` is the running total; `totalBytes` is the
 * Content-Length expectation (null when the server didn't declare one).
 * NOTE: the network stack buffers response bodies, so `progress` reflects
 * disk-write progress, not wire progress (honest boundary).
 */
export interface DownloadedFile {
  /** The post-redirect URL that produced the bytes. */
  readonly url: string;
  readonly filename: string;
  readonly path: string;
  readonly bytes: number;
  readonly totalBytes: number | null;
  readonly state: "started" | "progress" | "completed" | "failed";
  readonly error: string | null;
}

/**
 * RFC 6266 filename from `Content-Disposition`: returns null when the header
 * isn't an attachment. `filename*=` (RFC 5987 encoding) wins over `filename=`.
 */
function attachmentFilename(headers: Readonly<Record<string, string>>): string | null {
  const cd = headers["content-disposition"];
  if (cd === undefined || !/(?:^|;)\s*attachment\b/i.test(cd)) return null;
  const star = /filename\*=([^']*)''([^;]*)/i.exec(cd);
  if (star !== null) {
    try {
      return decodeURIComponent(star[2]!.trim());
    } catch {
      // fall through to the plain filename
    }
  }
  const plain = /filename="([^"]*)"|filename=([^;\s]+)/i.exec(cd);
  return plain !== null ? (plain[1] ?? plain[2] ?? null) : null;
}

/**
 * Joint session history (HTML §7.4.1): the TAB holds ONE ordered log of every
 * committed entry across the whole frame tree. A step references its context
 * weakly (detached frames must not leak) AND by its ownerElement path — a
 * parent reload that rebuilds child contexts still resolves their targets.
 */
interface JointStep {
  /**
   * Navigable contributions at this JSH index — usually one; a frame's FIRST
   * load joins its parent's current step instead (contiguous entry, so the
   * initial about:blank doesn't become its own back() stop).
   */
  readonly parts: JointPart[];
}

interface JointPart {
  readonly ref: WeakRef<BrowsingContext>;
  /** ownerElement chain from the root — "" joins to the root's own steps. */
  readonly path: readonly NodeId[];
  /** The latest committed entry for this part (replace refreshes it). */
  entry: SessionEntry;
}

/**
 * The document-space Y of a `#fragment` target (HTML §5.9.8) — first `[id=]`
 * or `a[name=]` match; null means "scroll to top" per spec.
 */
function anchorScrollY(dom: DomTree, tree: FragmentTree, fragment: string): number | null {
  let wanted = fragment;
  try {
    wanted = decodeURIComponent(fragment);
  } catch {
    // Guest/page code may throw here; swallowed by design.
  }
  for (const [id, node] of dom.nodes) {
    if (node.kind !== "element") continue;
    const idAttr = node.attrs?.get("id");
    const nameAttr = node.tag === "a" ? node.attrs?.get("name") : undefined;
    if (idAttr === wanted || nameAttr === wanted || idAttr === fragment) {
      const rect = getBoundingClientRect(tree, id);
      return Math.max(0, rect.y);
    }
  }
  return null;
}

/**
 * RFC 0030: a child navigable is either an in-process BrowsingContext
 * (same-origin/embedder-inherited documents) or an IsolatedFrame (the
 * document lives in its own worker — the parent only ever sees a
 * WindowProxy-shaped handle and a composited bitmap).
 */
export type FrameChild = BrowsingContext | IsolatedFrame;

/**
 * One node of the frame tree: owns its session history, guest host, live
 * page, and nested iframe contexts. `navigate`/`back`/`forward`/`reload` are
 * the full RFC 0010+0011+0012 semantics for ANY depth.
 */
export class BrowsingContext {
  #page: PageState | null = null;
  #history = new SessionHistory();
  #host = new SessionHost();
  /** iframe element nodeId → child context (in-process or isolated worker). */
  #frames = new Map<NodeId, FrameChild>();
  /** iframe nodeId → composited child bitmap for the current paint. */
  #frameImages = new Map<NodeId, DecodedImage>();
  /** iframe nodeId → the src/srcdoc signature the child was loaded with. */
  #frameSignatures = new Map<NodeId, string>();
  /** Joint session history — only the ROOT's instances are ever used. */
  #jointLog: JointStep[] = [];
  #jointCursor = -1;
  #jointRestoring = false;
  #drainingIntents = false;
  readonly #deps: BrowsingContextDeps;
  #network: BrowserNetworkStack;

  #root: BrowsingContext;

  constructor(deps: BrowsingContextDeps) {
    this.#deps = deps;
    deps.root = deps.root ?? this; // root context defaults to itself
    this.#root = deps.root;
    this.#network = deps.network;
    // Guest target dispatch: _blank → tab owner; _parent/_top → up the tree.
    this.#host.onNewTab = deps.onNewTab ?? null;
    this.#host.onCloseTab = deps.onCloseTab ?? null;
    this.#host.onPostMessageRemote = deps.onPostMessageRemote ?? null;
    this.#host.tabId = deps.tabId ?? 0;
    this.#host.openerTabId = deps.openerTabId ?? null;
    this.#host.scriptOpened = deps.scriptOpened ?? false;
    this.#host.onFocusRequest = deps.onFocusRequest ?? null;
    const parent = deps.parent;
    this.#host.navigateParent = parent
      ? (url, init) => {
          void parent
            .navigate(url, {
              ...(init?.method !== undefined ? { method: init.method } : {}),
              ...(init?.body !== undefined ? { body: init.body } : {}),
              ...(init?.contentType !== undefined ? { contentType: init.contentType } : {}),
            })
            .catch(() => {});
        }
      : null;
    this.#host.navigateRoot =
      parent !== null
        ? (url, init) => {
            void this.#root
              .navigate(url, {
                ...(init?.method !== undefined ? { method: init.method } : {}),
                ...(init?.body !== undefined ? { body: init.body } : {}),
                ...(init?.contentType !== undefined ? { contentType: init.contentType } : {}),
              })
              .catch(() => {});
          }
        : null;
    // `target="name"` → a direct child frame whose iframe carries that name/id
    // (HTML §7.1.3.2: navigate the named navigable; absent ⇒ self).
    this.#host.navigateNamed = (url, name, init) => {
      const child = this.#findNamedFrame(name);
      if (child === undefined) return false;
      if (child instanceof IsolatedFrame) {
        // Remote frame: the navigation rides the OOPIF port, not the
        // in-process intent queue.
        void child.navigate(url).catch(() => {});
        return true;
      }
      child.sessionHost.submit(url, init);
      void child.drainIntents().catch(() => {});
      return true;
    };
    // `window.open` — synchronous routing + proxy return (HTML §7.2).
    this.#host.onOpenWindow = (url, target, features) =>
      this.#openWindow(url, target, features);
  }

  /** Direct child frame whose iframe element carries `name` (name or id). */
  #findNamedFrame(name: string): FrameChild | undefined {
    for (const [nodeId_, child] of this.#frames) {
      const node = this.#page?.dom.nodes.get(nodeId_);
      if (
        node?.kind === "element" &&
        (node.attrs?.get("name") === name || node.attrs?.get("id") === name)
      ) {
        return child;
      }
    }
    return undefined;
  }

  /**
   * `window.open` (HTML §7.2 rules for choosing a navigable): _self/_parent/
   * _top route along the frame tree; a known frame name navigates it; _blank
   * and unknown names open a new top-level traversable. Returns the target's
   * WindowProxy — or null for `noopener` and for remote tabs (a proxy cannot
   * cross our worker boundary; honest boundary).
   */
  #openWindow(url: string, target: string, featuresRaw: string): unknown {
    const feats = parseWindowFeatures(featuresRaw);
    const t = target === "" ? "_blank" : target.toLowerCase();
    const named = t === "_self" || t === "_parent" || t === "_top" || t === "_blank"
      ? undefined
      : this.#findNamedFrame(t);
    if (t === "_blank" || (named === undefined && !["_self", "_parent", "_top"].includes(t))) {
      // A NEW top-level traversable — the shell hook creates it. Features
      // travel so `noreferrer`/`popup` survive to the new tab's navigation;
      // an unknown NAME travels too (the spawned tab registers under it and
      // later opens with the same name reuse it — HTML §7.1.2.3).
      const created = this.#deps.onOpenWindow?.(url, feats) ?? null;
      if (created === null) {
        this.#deps.onNewTab?.(url, {
          ...(feats.noreferrer ? { referrerPolicy: "no-referrer" } : {}),
          popup: feats.popup,
          ...(feats.width !== undefined ? { width: feats.width } : {}),
          ...(feats.height !== undefined ? { height: feats.height } : {}),
          name: t === "_blank" ? null : target,
          scriptOpened: true,
          noopener: feats.noopener,
        });
      }
      return feats.noopener ? null : (created?.proxyFor(this) ?? null);
    }
    const dest: FrameChild =
      t === "_self"
        ? this
        : t === "_parent"
          ? (this.#deps.parent ?? this)
          : t === "_top"
            ? this.#root
            : named!;
    // Route through the destination's intent queue — same serialization as
    // location.assign, so an open() during a load can't interleave mid-nav.
    if (dest instanceof IsolatedFrame) {
      void dest.navigate(url).catch(() => {});
    } else {
      dest.sessionHost.submit(url, {
        ...(feats.noreferrer ? { referrerPolicy: "no-referrer" } : {}),
      });
      void dest.drainIntents().catch(() => {});
    }
    if (feats.noopener) return null;
    return dest === this
      ? (this.#host.selfWindow ?? this.proxyFor(this))
      : dest.proxyFor(this);
  }

  get deps(): BrowsingContextDeps {
    return this.#deps;
  }

  get page(): PageState | null {
    return this.#page;
  }

  get historyList(): SessionHistory {
    return this.#history;
  }

  get sessionHost(): SessionHost {
    return this.#host;
  }

  get frames(): ReadonlyMap<NodeId, FrameChild> {
    return this.#frames;
  }

  /**
   * Teardown: dispose remote children (terminates their workers) and recurse
   * into in-process children. In-process contexts hold no OS resources of
   * their own; the recursion exists so nested OOPIFs are reached.
   */
  dispose(): void {
    for (const child of this.#frames.values()) child.dispose();
    this.#frames.clear();
    // RFC 0032: the document's dedicated workers die with the context —
    // a disposed page must not leave worker_threads running.
    this.#page?.runtime?.disposeWorkers?.();
    // RFC 0035: media playback timers die too — a playing <video> must not
    // outlive its browsing context.
    this.#page?.media?.dispose();
  }

  get url(): string {
    return this.#history.current?.url ?? this.#page?.url ?? "about:blank";
  }

  get title(): string {
    return this.#page?.title ?? "";
  }

  get viewport(): EngineViewport {
    return this.#deps.viewportFor();
  }

  canGoBack(): boolean {
    // The root answers for the whole traversable — a child iframe's newest
    // navigation is itself a "backable" step in the joint log.
    if (this === this.#root) return this.#jointCursor > 0;
    return this.#history.canGoBack();
  }

  canGoForward(): boolean {
    if (this === this.#root) {
      return this.#jointCursor >= 0 && this.#jointCursor < this.#jointLog.length - 1;
    }
    return this.#history.canGoForward();
  }

  /**
   * Swap the live page after a host-side repaint/edit (scroll, text commit) —
   * no history write, no lifecycle events; the document identity is unchanged.
   */
  setRenderedPage(page: PageState): void {
    this.#page = page;
  }

  /**
   * Adopt a page loaded by an external path (host HTML upload) — pushes a
   * history entry, commits the host, fires pageshow, installs frame globals.
   */
  adoptLoadedPage(page: PageState): void {
    this.#adoptPage(page, true, this.#history.current?.documentKey);
  }

  /** Drain queued guest navigation intents (public wrapper for the shell). */
  async drainIntents(): Promise<PageFrame | null> {
    if (this.#page === null) return null;
    return this.#drainNavigationIntents(this.#page.frame);
  }

  get sessionStorage() {
    return this.#deps.sessionStores.forOrigin(this.url);
  }

  /** The sandbox globals object of the live runtime (proxy injection). */
  get globals(): Record<string, unknown> | null {
    return this.#page?.runtime?.globals ?? null;
  }

  /**
   * The window proxy `source` sees for THIS context — postMessage is bound to
   * `source` so `event.source` identifies the actual caller (HTML §9.4.3):
   * `iframe.contentWindow` in a parent ⇒ proxy bound to the parent;
   * `window.parent` in a child ⇒ the parent's proxy bound to the child.
   */
  proxyFor(source: FrameChild): Record<string, unknown> {
    const cached = this.#proxyCache.get(source);
    if (cached !== undefined) return cached;
    const proxy: Record<string, unknown> = {
      postMessage: (data: unknown, targetOrigin?: unknown) => {
        this.deliverMessage(data, targetOrigin, source);
      },
      closed: false,
    };
    // Cross-context location is read-only href (opaque WindowProxy field).
    Object.defineProperty(proxy, "location", {
      enumerable: true,
      get: () => ({ href: this.url }),
    });
    // `proxy.document` — same-origin only (HTML §7.4.3.1 cross-origin objects
    // expose nothing but location/postMessage). The child's sandbox document
    // wrapper is a plain JS object — it crosses VM contexts safely since the
    // realm boundary here is lexical, not process isolation.
    Object.defineProperty(proxy, "document", {
      enumerable: true,
      get: () => this.documentFor(source),
    });
    // WindowProxy identity is stable per caller (spec observable via ===).
    this.#proxyCache.set(source, proxy);
    return proxy;
  }

  #proxyCache = new WeakMap<FrameChild, Record<string, unknown>>();
  /**
   * Effective origin for same-origin checks (RFC 0013 cross-context DOM):
   * `about:blank`/`srcdoc` documents inherit the embedder's origin; a
   * sandboxed context without `allow-same-origin` gets a fresh opaque key
   * per load, which never equals any other context's.
   */
  #origin: string | null = null;
  /**
   * The committed document's Referrer-Policy (response header, else
   * `<meta name=referrer>`) — the default for every navigation/subresource
   * this document initiates; element-level `referrerpolicy` attrs override.
   */
  #docPolicy: string | undefined;

  /** The context owning iframe element `nodeId` in the current page. */
  frameFor(nodeId: NodeId): FrameChild | undefined {
    return this.#frames.get(nodeId);
  }

  /** RFC 0030: uniform bitmap accessor across in-process and remote frames. */
  get framePngBytes(): Uint8Array | undefined {
    return this.#page?.pngBytes;
  }

  /**
   * `requester` asking for THIS context's document (contentDocument /
   * proxy.document): same-origin ⇒ the child's live document wrapper —
   * a plain JS object that crosses the VM boundary safely; a same-origin
   * SCRIPTLESS child has no wrapper, so we answer a read-only facade over
   * its committed DomTree instead (frame-dom-facade.ts); cross-origin ⇒
   * null (cross-origin objects expose no document per spec).
   */
  documentFor(requester: FrameChild): unknown {
    const mine = this.#origin;
    // An isolated child can never DOM-reach us — its origin isn't even a
    // comparable key in this process.
    const theirs = requester instanceof BrowsingContext ? requester.#origin : null;
    if (mine === null || theirs === null || mine !== theirs) return null;
    const globals = this.globals;
    if (globals !== null) return globals["document"] ?? null;
    const page = this.#page;
    return page === null ? null : domFacadeDocument(page.dom, page.url, page.title);
  }

  /**
   * Install this context's frame-tree globals into its live sandbox:
   * `parent`/`top`/`frameElement`/`frames`/`length`/`postMessage`.
   */
  #installFrameGlobals(): void {
    const globals = this.globals;
    if (globals === null) return;
    const deps = this.#deps;
    globals["parent"] =
      deps.parent !== null ? deps.parent.proxyFor(this) : (globals["window"] ?? globals);
    globals["top"] =
      this.#root === this ? (globals["window"] ?? globals) : this.#root.proxyFor(this);
    globals["frameElement"] = null; // cross-VM element identity: honest boundary.
    globals["postMessage"] = (data: unknown, targetOrigin?: unknown) => {
      this.deliverMessage(data, targetOrigin, this);
    };
    Object.defineProperty(globals, "frames", {
      configurable: true,
      enumerable: true,
      get: () => [...this.#frames.values()].map((f) => f.proxyFor(this)),
    });
    Object.defineProperty(globals, "length", {
      configurable: true,
      enumerable: true,
      get: () => this.#frames.size,
    });
  }

  /**
   * Deliver a `message` event into THIS context's sandbox — data is
   * JSON-cloned (structured-clone-lite across separate VM contexts) and
   * `targetOrigin` is honored per spec (mismatch ⇒ drop).
   */
  deliverMessage(
    data: unknown,
    targetOrigin: unknown,
    source: FrameChild,
  ): void {
    const origin = (() => {
      try {
        return new URL(source.url).origin;
      } catch {
        return "null";
      }
    })();
    const tOrigin = typeof targetOrigin === "string" ? targetOrigin : "/";
    if (tOrigin !== "/" && tOrigin !== "*") {
      let actual = "null";
      try {
        actual = new URL(this.url).origin;
      } catch {
        // Guest/page code may throw here; swallowed by design.
      }
      if (tOrigin !== actual) return;
    }
    let cloned: unknown = data;
    try {
      cloned = JSON.parse(JSON.stringify(data ?? null)) as unknown;
    } catch {
      return; // Unserializable payloads drop like a DataCloneError abort.
    }
    this.#page?.runtime?.fireEvent?.("message", {
      data: cloned,
      origin,
      source: source.proxyFor(this),
    });
  }

  async navigate(
    target: string,
    options: {
      push?: boolean;
      keepAlive?: boolean;
      method?: string;
      body?: string;
      contentType?: string;
      referrerPolicy?: string;
      /** `a[download]` filename hint — non-null routes to the download path. */
      download?: string | null;
      /** RFC 0031: embedder COEP when this is a remote-frame navigation. */
      initiatorCoep?: import("@browser-engine/guest").Coep;
    } = {},
  ): Promise<PageFrame> {
    const currentUrl = this.#history.current?.url ?? this.#page?.url ?? "about:blank";
    const resolved = resolveNavigationTarget(target, currentUrl);
    // a[download]: same-origin resource saves instead of navigating (HTML
    // §4.6.3 — the attribute is honored for same-origin/blob/data only).
    if (options.download !== undefined && options.download !== null) {
      let sameOrigin = false;
      try {
        sameOrigin = new URL(resolved).origin === new URL(currentUrl).origin;
      } catch {
        // unparseable ⇒ not same-origin ⇒ falls through to a normal nav
      }
      if (sameOrigin) {
        await this.#performDownload(resolved, options.download, currentUrl);
        return this.#page!.frame;
      }
    }
    if (
      this.#page !== null &&
      sameDocumentUrl(resolved, currentUrl) &&
      fragmentOf(resolved) !== fragmentOf(currentUrl)
    ) {
      return this.#fragmentNavigate(resolved, options.push ?? true);
    }
    const push = options.push ?? true;
    if (!this.#confirmCrossDocumentLeave()) {
      return this.#page!.frame;
    }
    const outgoingKey = this.#history.current?.documentKey;
    this.#history.recordScroll(this.#page?.scrollY ?? 0);
    this.#stashOutgoing(push);
    const page = await this.#loadDocument(resolved, currentUrl, options);
    if (page === null) {
      // A Content-Disposition: attachment response consumes the navigation —
      // the current document stays (spec: no commit).
      return this.#page!.frame;
    }
    this.#adoptPage(page, push, outgoingKey);
    await this.#loadChildren();
    return this.#drainNavigationIntents(this.#page!.frame);
  }

  /**
   * Commit a freshly loaded page: history entry, host commit, pageshow,
   * nested-iframe discovery + child loading, and the frame-aware repaint.
   */
  #adoptPage(page: PageState, push: boolean, outgoingKey: number | undefined): void {
    this.#page = page;
    this.#frames = new Map();
    this.#frameImages = new Map();
    this.#frameSignatures = new Map();
    const entry = push
      ? this.#history.push(page.url, page.title)
      : (this.#history.replaceCurrent(page.url, page.title), this.#history.current)!;
    if (push) this.#recordJoint(entry);
    else this.#refreshJointEntry(entry);
    if (!push && outgoingKey !== undefined) this.#history.dropRetained(outgoingKey);
    this.#host.commit(entry.url, entry.state);
    this.#broadcastHistoryLength(); // JSH length is traversable-wide
    page.runtime?.fireEvent?.("pageshow", { persisted: false });
    this.#installFrameGlobals();
  }

  /** loadPage wired to this context's shared stack, storage, and host. */
  async #loadDocument(
    resolved: string,
    initiator: string,
    options: {
      keepAlive?: boolean;
      method?: string;
      body?: string;
      contentType?: string;
      srcdocHtml?: string;
      referrerPolicy?: string;
      /** RFC 0031: the embedder's COEP gates this child document fetch. */
      initiatorCoep?: import("@browser-engine/guest").Coep;
    } = {},
  ): Promise<PageState | null> {
    // `about:blank`/srcdoc inherit the EMBEDDER's origin (HTML §7.4.1):
    // the blank iframe in a page reads its parent's localStorage, and is
    // same-origin for contentDocument purposes.
    const embedded = resolved === "about:blank" || options.srcdocHtml !== undefined;
    // RFC 0027 `frame-src`: the PARENT's CSP gates this context's navigation
    // URL (srcdoc/about:blank are embedder content, exempt). A refused child
    // renders as an empty frame — return null before any bytes move.
    const parent = this.#deps.parent;
    if (parent !== null && !embedded) {
      const parentCsp = parent.page?.csp ?? null;
      if (parentCsp !== null && !parentCsp.check("frame", resolved).allowed) {
        return null;
      }
    }
    // RFC 0027 `frame-ancestors`: the CHILD's own policy vets its ancestors —
    // build the origin chain parent-first so the child's response policies
    // (headers/meta) can be checked inside boot.
    const ancestorOrigins: string[] = [];
    {
      let anc = parent;
      while (anc !== null) {
        const u = anc.page?.url;
        if (u !== undefined) {
          try {
            ancestorOrigins.push(new URL(u).origin);
          } catch {
            /* non-URL ancestor — skip */
          }
        }
        anc = anc.#deps.parent;
      }
      // RFC 0030: an OOPIF worker's context has no in-process parents — the
      // embedder chain arrives over the wire instead.
      if (ancestorOrigins.length === 0 && this.#deps.ancestorOriginsFor !== undefined) {
        ancestorOrigins.push(...this.#deps.ancestorOriginsFor());
      }
    }
    // Referrer-Policy: the RESPONSE HEADER carries the document policy —
    // captured in onNavResponse below, preferred over <meta name=referrer>.
    // The element attribute overrides everything at the call site.
    let headerPolicy: string | undefined;
    const effectiveUrl = embedded && initiator !== "about:blank" ? initiator : resolved;
    // sandbox without `allow-same-origin` ⇒ opaque origin ⇒ fresh isolated
    // storage (HTML §4.8.5: opaque origins never share a storage area).
    const opaque = this.#deps.sandboxTokens !== undefined && !this.#deps.sandboxTokens.has("allow-same-origin");
    this.#origin = opaque ? `opaque:${opaqueSeq++}` : localStorageOrigin(effectiveUrl);
    const storage = opaque
      ? {
          localStorage: createMemoryStorageArea(),
          sessionStorage: createMemoryStorageArea(),
        }
      : {
          localStorage: this.#deps.localRegistry.forOrigin(effectiveUrl),
          sessionStorage: this.#deps.sessionStores.forOrigin(effectiveUrl),
        };
    if (options.srcdocHtml !== undefined) {
      const page = await loadHtmlDocument(options.srcdocHtml, resolved, this.viewport, {
        runScripts: this.#scriptsAllowed(),
        ...(this.#deps.parent !== null ? { viewportMinEdge: 1 } : {}),
        keepAlive: true,
        sessionHost: this.#host,
        storage,
        frameLookup: this.frameLookup,
        ancestorOrigins,
      });
      // srcdoc has no headers — it inherits the embedder's document policy.
      this.#docPolicy =
        documentReferrerPolicy(page.dom) ?? this.#docPolicy;
      // RFC 0027: a srcdoc document's own meta `frame-ancestors` can still
      // refuse the embedding.
      if (page.cspBlocked === true) return null;
      return page;
    }
    const page = await loadPage(resolved, {
      ...(ancestorOrigins.length > 0 ? { ancestorOrigins } : {}),
      viewport: this.viewport,
      // Embedded contexts legitimately render at iframe sizes (<200px) —
      // an OOPIF worker root is embedded too (its parents are remote).
      ...(this.#deps.parent !== null || this.#deps.ancestorOriginsFor !== undefined
        ? { viewportMinEdge: 1 }
        : {}),
      keepAlive: true,
      // RFC 0030: a virtual transport replaces the network stack entirely —
      // `network` stays unset so loadPage uses the fetchFn path for the
      // document AND its subresources.
      ...(this.#deps.virtualFetch !== undefined
        ? { fetchFn: this.#deps.virtualFetch }
        : { network: this.#network }),
      sessionHost: this.#host,
      storage,
      runScripts: this.#scriptsAllowed(),
      frameLookup: this.frameLookup,
      ...(initiator !== "about:blank" ? { initiator } : {}),
      ...(options.initiatorCoep !== undefined
        ? { initiatorCoep: options.initiatorCoep }
        : {}),
      // RFC 0031: this tab was opened with an opener — once THIS document's
      // COOP parses inside boot, the pair re-evaluates and `window.opener`
      // severs before any of the opened document's scripts run.
      ...(this.#deps.openerInfo !== undefined
        ? { openerInfo: this.#deps.openerInfo }
        : {}),
      ...(options.method !== undefined ? { method: options.method } : {}),
      ...(options.body !== undefined ? { body: options.body } : {}),
      ...(options.contentType !== undefined ? { contentType: options.contentType } : {}),
      // Element attr > document policy > engine default (strict-origin-when-
      // cross-origin inside the network stack).
      ...((options.referrerPolicy ?? this.#docPolicy) !== undefined
        ? { referrerPolicy: (options.referrerPolicy ?? this.#docPolicy)! }
        : {}),
      onNavResponse: (res: NetworkResponse): "page" | "download" => {
        // The document's own Referrer-Policy header governs the outbound
        // Referer of every navigation this page initiates.
        headerPolicy = res.headers["referrer-policy"];
        if (
          this.#deps.downloadsDir === undefined ||
          attachmentFilename(res.headers) === null
        ) {
          return "page";
        }
        try {
          this.#saveDownload(res, null, resolved);
        } catch {
          this.#deps.onDownload?.({
            url: resolved,
            filename: attachmentFilename(res.headers) ?? "download.bin",
            path: "",
            bytes: 0,
            totalBytes: null,
            state: "failed",
            error: "attachment write failed",
          });
        }
        return "download";
      },
    });
    if (page !== null) {
      // RFC 0027: the child document's `frame-ancestors` refused the embed —
      // the frame stays empty (a real browser paints a CSP error frame).
      if (page.cspBlocked === true) return null;
      // Header > <meta name=referrer> > keep prior (about:blank/srcdoc
      // documents inherit the embedder's policy per spec).
      this.#docPolicy =
        headerPolicy ?? documentReferrerPolicy(page.dom) ?? this.#docPolicy;
    }
    return page;
  }

  /**
   * `a[download]` (HTML §4.6.3): fetch the resource with document semantics
   * and persist it — the navigation never commits.
   */
  async #performDownload(
    resolved: string,
    filenameHint: string,
    initiator: string,
  ): Promise<void> {
    if (this.#deps.downloadsDir?.() === undefined) return; // no sink ⇒ suppressed nav
    try {
      const res = await this.#network.request({
        url: resolved,
        destination: "document",
        mode: "navigate",
        ...(initiator !== "about:blank" ? { initiator } : {}),
        ...(this.#docPolicy !== undefined ? { referrerPolicy: this.#docPolicy } : {}),
      });
      this.#saveDownload(res, filenameHint === "" ? null : filenameHint, resolved);
    } catch (err) {
      // The fetch died — chrome sees a failed-download notice (filename is
      // best-effort: hint, else the URL basename, else a stub).
      this.#deps.onDownload?.({
        url: resolved,
        filename: filenameHint !== "" ? filenameHint : (resolved.split("/").pop() || "download.bin"),
        path: "",
        bytes: 0,
        totalBytes: null,
        state: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Persist a response body into downloadsDir; chrome sees the result. */
  #saveDownload(
    res: NetworkResponse,
    filenameHint: string | null,
    requestUrl: string,
  ): void {
    const dir = this.#deps.downloadsDir?.();
    if (dir === undefined) return;
    const fromCd = attachmentFilename(res.headers);
    const fromUrl = (() => {
      try {
        const base = new URL(res.url !== "" ? res.url : requestUrl).pathname.split("/").pop() ?? "";
        return base === "" ? null : base;
      } catch {
        return null;
      }
    })();
    const raw = filenameHint ?? fromCd ?? fromUrl ?? "download.bin";
    // Filesystem-unsafe chars + ASCII controls sanitize to "_" (keep it
    // regex-free — no-control-regex forbids literal \x00-\x1f classes).
    const filename =
      Array.from(raw)
        .map((ch) => (ch < " " || ch === "\x7f" || '\\/:*?"<>|'.includes(ch) ? "_" : ch))
        .join("") || "download.bin";
    mkdirSync(dir, { recursive: true });
    const path = join(dir, filename);
    const url = res.url !== "" ? res.url : requestUrl;
    // The network stack buffers bodies (and undici hides content-length from
    // response.headers), so the exact total is the buffered length — always
    // known once the response lands. Wire progress would need a streaming
    // network layer; noted as an honest boundary.
    const totalBytes = res.body.byteLength;
    const emit = (bytes: number, state: DownloadedFile["state"], error: string | null = null): void =>
      this.#deps.onDownload?.({ url, filename, path, bytes, totalBytes, state, error });
    emit(0, "started");
    // Chunked stream to disk — progress events report WRITE progress (the
    // body arrives buffered from the network stack; honest boundary).
    const fd = openSync(path, "w");
    try {
      const CHUNK = 64 * 1024;
      let off = 0;
      while (off < res.body.byteLength) {
        const end = Math.min(off + CHUNK, res.body.byteLength);
        writeSync(fd, res.body, off, end - off, off);
        off = end;
        if (off < res.body.byteLength) emit(off, "progress");
      }
    } catch (err) {
      emit(0, "failed", err instanceof Error ? err.message : String(err));
      return;
    } finally {
      closeSync(fd);
    }
    emit(res.body.byteLength, "completed");
  }

  /**
   * Cross-tab message entry (the tab owner relays a `PendingPostMessage` to
   * us via IPC). `targetOrigin` filters delivery; `e.source` is a REPLY
   * proxy whose postMessage routes back through the shell to the sender tab
   * — the symmetric half of the bridge (a live context can't cross).
   */
  deliverCrossTabMessage(msg: PendingPostMessage): void {
    const target = msg.targetOrigin;
    if (target !== null && target !== "*" && target !== "/") {
      let actual = "null";
      try {
        actual = new URL(this.url).origin;
      } catch {
        // Guest/page code may throw here; swallowed by design.
      }
      if (target !== actual) return;
    }
    let data: unknown = null;
    try {
      data = JSON.parse(msg.dataJson) as unknown;
    } catch {
      return;
    }
    let origin = "null";
    try {
      origin = new URL(msg.fromUrl).origin;
    } catch {
      // malformed sender url — keep "null"
    }
    const source = {
      postMessage: (d: unknown, o?: unknown): void =>
        this.#host.postMessageRemote(msg.fromTabId, d, typeof o === "string" ? o : null),
      // `e.source.focus()` — the shell activates the sender's tab.
      focus: (): void => this.#host.focusRemote(msg.fromTabId),
      closed: false,
    };
    this.#page?.runtime?.fireEvent?.("message", { data, origin, source });
  }

  /** `sandbox` without `allow-scripts` ⇒ the child context runs scriptless. */
  #scriptsAllowed(): boolean {
    const tokens = this.#deps.sandboxTokens;
    if (tokens === undefined) return true;
    return tokens.has("allow-scripts");
  }

  /** Same-document fragment hop — scroll, entry, hashchange; no reload. */
  async #fragmentNavigate(url: string, push: boolean): Promise<PageFrame> {
    const page = this.#page!;
    const oldUrl = this.#history.current?.url ?? page.url;
    const fragment = fragmentOf(url) ?? "";
    const anchorY =
      fragment === "" ? 0 : (anchorScrollY(page.dom, page.fragmentTree, fragment) ?? 0);
    if (push) {
      this.#history.recordScroll(page.scrollY);
      this.#recordJoint(this.#history.push(url, page.title, 0));
    } else {
      this.#history.replaceCurrent(url, page.title);
      this.#refreshJointEntry(this.#history.current!);
    }
    this.#host.commit(url, this.#history.current?.state ?? null);
    this.#broadcastHistoryLength(); // JSH length is traversable-wide
    this.#page = await repaintPage(page, this.viewport, page.focus, anchorY);
    page.runtime?.fireEvent?.("hashchange", { oldURL: oldUrl, newURL: url });
    return this.#drainNavigationIntents(this.#page.frame);
  }

  /** This context's ownerElement chain from the root ([] = the root itself). */
  get #jointPath(): readonly NodeId[] {
    const parent = this.#deps.parent;
    if (parent === null) return [];
    return [...parent.#jointPath, this.#deps.ownerElement ?? (-1 as NodeId)];
  }

  /**
   * `history.length` is traversable-wide (HTML §7.10.1): the JOINT log's
   * length is broadcast into EVERY live context's host, so a child nav bumps
   * what the parent observes and vice versa.
   */
  #broadcastHistoryLength(): void {
    const len = this.#root.#jointLog.length;
    const walk = (ctx: BrowsingContext): void => {
      ctx.#host.setHistoryLength(len);
      for (const child of ctx.#frames.values()) {
        // An isolated frame's history length lives in its own process —
        // broadcast only reaches in-process children (documented bound).
        if (child instanceof BrowsingContext) walk(child);
      }
    };
    walk(this.#root);
  }

  /** A committed push appends a joint step (forward log truncates first). */
  #recordJoint(entry: SessionEntry): void {
    const root = this.#root;
    if (root.#jointRestoring) return;
    const part: JointPart = { ref: new WeakRef(this), path: this.#jointPath, entry };
    if (this !== root && this.#history.index === 0 && root.#jointCursor >= 0) {
      // A frame's FIRST committed entry joins the parent's current step —
      // it is a continuation of the parent's own load, not a new stop.
      root.#jointLog[root.#jointCursor]!.parts.push(part);
      return;
    }
    root.#jointLog.length = root.#jointCursor + 1;
    root.#jointLog.push({ parts: [part] });
    root.#jointCursor = root.#jointLog.length - 1;
  }

  /**
   * replace/replaceState keep the entry's stepId — refresh the matching step's
   * entry object so the joint log never holds a stale snapshot.
   */
  #refreshJointEntry(entry: SessionEntry): void {
    const root = this.#root;
    for (const step of root.#jointLog) {
      for (const part of step.parts) {
        if (part.ref.deref() === this && part.entry.stepId === entry.stepId) {
          part.entry = entry;
          return;
        }
      }
    }
  }

  /** Resolve a joint path to the LIVE context (undefined = frame is gone). */
  #contextAtJointPath(path: readonly NodeId[]): BrowsingContext | undefined {
    let ctx: BrowsingContext = this.#root;
    for (const ownerId of path) {
      const next = ctx.#frames.get(ownerId);
      // Isolated children aren't in the joint session history — the path
      // resolves only through in-process contexts.
      if (!(next instanceof BrowsingContext)) return undefined;
      ctx = next;
    }
    return ctx;
  }

  /**
   * Traverse the JOINT log (HTML "apply the history step"): every live
   * navigable adopts its latest recorded entry at-or-before the target — so
   * a click inside an iframe rewinds THE FRAME on `back()`, not the top
   * document. Root moves first: a top-level traverse rebuilds children.
   */
  async #traverseJoint(delta: number): Promise<PageFrame | null> {
    const root = this.#root;
    const target = root.#jointCursor + delta;
    if (target < 0 || target >= root.#jointLog.length) {
      return this.#page?.frame ?? null;
    }
    // Newest-first: each path's latest step ≤ target is its post-traverse
    // entry. Steps whose context died resolve by path — a rebuilt frame
    // reclaims them.
    const wanted = new Map<string, SessionEntry>();
    const paths = new Map<string, readonly NodeId[]>();
    for (let i = target; i >= 0; i -= 1) {
      for (const part of root.#jointLog[i]!.parts) {
        const key = part.path.join(",");
        if (!wanted.has(key)) {
          wanted.set(key, part.entry);
          paths.set(key, part.path);
        }
      }
    }
    root.#jointRestoring = true;
    try {
      const keys = [...paths.keys()].sort((a, b) => a.length - b.length);
      for (const key of keys) {
        const ctx = root.#contextAtJointPath(paths.get(key)!);
        if (ctx === undefined) continue;
        const entry = wanted.get(key)!;
        const cur = ctx.#history.current;
        if (cur !== undefined && cur.stepId === entry.stepId) continue;
        const idx = ctx.#history.locateEntry(entry);
        if (idx >= 0) {
          const d = idx - ctx.#history.index;
          if (d !== 0) await ctx.#traverseSession(d);
        } else if (ctx !== root) {
          // A rebuilt frame's fresh history can't locate the recorded entry —
          // re-navigate to its URL (src-loaded frames only; srcdoc/blank
          // signatures have no meaningful URL to revisit).
          const owner = ctx.#deps.ownerElement;
          const parentCtx =
            owner !== undefined
              ? root.#contextAtJointPath(paths.get(key)!.slice(0, -1))
              : undefined;
          const sig =
            parentCtx !== undefined && owner !== undefined
              ? parentCtx.#frameSignatures.get(owner)
              : undefined;
          if (sig?.startsWith("src:") === true) {
            await ctx.navigate(entry.url);
          }
        }
      }
      root.#jointCursor = target;
    } finally {
      root.#jointRestoring = false;
    }
    return this.#page?.frame ?? null;
  }

  /**
   * beforeunload (HTML §5.11): fire on the outgoing document; a canceled
   * event consults the chrome prompt. `false` means the user declined.
   */
  #confirmCrossDocumentLeave(): boolean {
    const page = this.#page;
    if (page === null) return true;
    // `cancelable` matters: an uncancelable event can never block the
    // navigation, matching DOM's dispatch result semantics.
    const continued =
      page.runtime?.fireEvent?.("beforeunload", { cancelable: true }) ?? true;
    if (continued) return true;
    return this.#deps.confirmLeave?.() ?? true;
  }

  /** RFC 0012: pagehide + bfcache-retain the outgoing page (and its frames). */
  #stashOutgoing(allowed = true): void {
    const page = this.#page;
    if (page === null) return;
    const retain = allowed && page.runtime !== undefined;
    page.runtime?.fireEvent?.("pagehide", { persisted: retain });
    if (retain) {
      const retained: RetainedEntry = {
        url: page.url,
        page,
        frames: this.#frames,
        sigs: this.#frameSignatures,
      };
      this.#history.stashPage(retained);
    }
  }

  /**
   * Guest-queued navigation intents drain after the guest task — bounded so a
   * goto-loop terminates; re-entrant-safe (outer loop picks up nested work).
   */
  async #drainNavigationIntents(frame: PageFrame | null): Promise<PageFrame> {
    if (this.#drainingIntents || this.#page === null) {
      if (frame !== null && frame !== undefined) return frame;
      return this.#page?.frame ?? Promise.reject(new Error("no page"));
    }
    this.#drainingIntents = true;
    try {
      let last = frame ?? this.#page?.frame;
      if (last === null || last === undefined) {
        return Promise.reject(new Error("no page"));
      }
      for (let round = 0; round < 8; round += 1) {
        const intents = this.#host.drainIntents();
        if (intents.length === 0) {
          // Child contexts may have queued their own during the drain.
          last = (await this.#drainChildren(last)) ?? last;
          // Guest code may have inserted/navigated iframes during the drain.
          if (await this.#syncFrames()) last = this.#page?.frame ?? last;
          return last;
        }
        for (const intent of intents) {
          last = (await this.#applyIntent(intent)) ?? last;
        }
      }
      return last;
    } finally {
      this.#drainingIntents = false;
    }
  }

  /** Drain each child's queued intents (postMessage/navigation may cascade). */
  async #drainChildren(last: PageFrame): Promise<PageFrame | null> {
    let out: PageFrame | null = last;
    let anyRepaint = false;
    for (const child of this.#frames.values()) {
      // A remote frame drains its own intents inside the worker — the
      // parent's drain reaches only in-process children.
      if (!(child instanceof BrowsingContext)) continue;
      const before = child.#page?.frameRev ?? 0;
      await child.#drainNavigationIntents(child.#page?.frame ?? null);
      const after = child.#page?.frameRev ?? 0;
      if (after !== before) anyRepaint = true;
    }
    if (anyRepaint && this.#page !== null) {
      await this.#refreshFrameImages();
      this.#page = await repaintPage(
        this.#page,
        this.viewport,
        this.#page.focus,
        this.#page.scrollY,
      );
      out = this.#page.frame;
    }
    return out;
  }

  async #applyIntent(intent: NavigationIntent): Promise<PageFrame | null> {
    switch (intent.kind) {
      case "navigate":
        return this.navigate(intent.url, {
          push: !intent.replace,
          ...(intent.method !== undefined ? { method: intent.method } : {}),
          ...(intent.body !== undefined ? { body: intent.body } : {}),
          ...(intent.contentType !== undefined ? { contentType: intent.contentType } : {}),
          ...(intent.download !== undefined ? { download: intent.download } : {}),
          ...(intent.referrerPolicy !== undefined
            ? { referrerPolicy: intent.referrerPolicy }
            : {}),
        });
      case "reload":
        return this.reload();
      case "close":
        // `window.close()` — the tab owner closes us; nothing to render.
        this.#deps.onCloseTab?.();
        return this.#page?.frame ?? null;
      case "traverse":
        // history.go/back/forward is a TRAVERSABLE-level op: any context's
        // intent walks the root's joint history (HTML §7.4.1).
        return this.#traverseJoint(intent.delta);
      case "push-state":
        this.#recordJoint(this.#history.pushStateEntry(intent.url, intent.state));
        this.#broadcastHistoryLength(); // JSH length is traversable-wide
        return this.#page?.frame ?? null;
      case "replace-state":
        this.#history.replaceCurrent(intent.url, undefined, intent.state);
        this.#refreshJointEntry(this.#history.current!);
        return this.#page?.frame ?? null;
    }
  }

  /** Session traversal: same-document hops, bfcache restore, or reload. */
  async #traverseSession(delta: number): Promise<PageFrame | null> {
    const prevEntry = this.#history.current;
    const peeked = this.#history.peek(delta);
    if (peeked === undefined) return this.#page?.frame ?? null;
    // beforeunload gates only cross-document unloads — same-document
    // traversals (pushState hops) never unload the page.
    if (
      (prevEntry === undefined || peeked.documentKey !== prevEntry.documentKey) &&
      !this.#confirmCrossDocumentLeave()
    ) {
      return this.#page!.frame;
    }
    if (prevEntry !== undefined) {
      this.#history.recordScroll(this.#page?.scrollY ?? 0);
      this.#stashOutgoing();
    }
    const entry = this.#history.traverse(delta);
    if (entry === null) return this.#page?.frame ?? null;
    this.#host.commit(entry.url, entry.state);
    this.#broadcastHistoryLength(); // JSH length is traversable-wide

    if (
      this.#page !== null &&
      prevEntry !== undefined &&
      entry.documentKey === prevEntry.documentKey
    ) {
      this.#page.runtime?.fireEvent?.("popstate", { state: entry.state });
      if (!sameDocumentUrl(entry.url, prevEntry.url)) {
        this.#page.runtime?.fireEvent?.("hashchange", {
          oldURL: prevEntry.url,
          newURL: entry.url,
        });
      }
      const scrollY = this.#host.scrollRestoration === "auto" ? entry.scrollY : 0;
      this.#page = await repaintPage(this.#page, this.viewport, this.#page.focus, scrollY);
      return this.#drainNavigationIntents(this.#page.frame);
    }

    const retained = this.#history.takePage(entry) as RetainedEntry | null;
    if (retained !== null) {
      this.#page = retained.page;
      this.#frames = new Map(retained.frames);
      this.#frameSignatures = new Map(retained.sigs);
      this.#frameImages = new Map();
      retained.page.runtime?.fireEvent?.("pageshow", { persisted: true });
      const restoreY = this.#host.scrollRestoration === "auto" ? entry.scrollY : 0;
      await this.#refreshFrameImages();
      this.#page = await repaintPage(
        retained.page,
        this.viewport,
        retained.page.focus,
        restoreY,
        { frameImages: this.#frameImages },
      );
      this.#installFrameGlobals();
      return this.#drainNavigationIntents(this.#page.frame);
    }

    const page = await this.#loadDocument(entry.url, "about:blank", {});
    if (page === null) {
      // Download-consumed traverse (attachment response): undo the index move
      // — no commit happened, so no history step was taken either.
      this.#history.traverse(-delta);
      return this.#page?.frame ?? null;
    }
    this.#adoptPage(page, false, undefined);
    const restoreY = this.#host.scrollRestoration === "auto" ? entry.scrollY : 0;
    if (restoreY !== 0) {
      this.#page = await repaintPage(page, this.viewport, page.focus, restoreY);
    }
    await this.#loadChildren();
    return this.#drainNavigationIntents(this.#page?.frame ?? null);
  }

  /**
   * Advance this context (and all live children) by `count` render cycles —
   * drain guest work, repaint what changed, composite child bitmaps.
   */
  async pump(
    count = 1,
    options: { readonly settleMs?: number; readonly idleStop?: boolean } = {},
  ): Promise<{ frames: number; mutations: number; frameRev: number }> {
    if (this.#page === null) return { frames: 0, mutations: 0, frameRev: 0 };
    const result = await pumpFrames(this.#page, count, options);
    this.#page = result.page;
    let frames = result.frames;
    let mutations = result.mutations;
    let childChanged = false;
    for (const child of this.#frames.values()) {
      // Remote frames pump on their own worker clock — nothing to do here.
      if (!(child instanceof BrowsingContext)) continue;
      const revBefore = child.#page?.frameRev ?? 0;
      const sub = await child.pump(count, options);
      frames += sub.frames;
      mutations += sub.mutations;
      if ((child.#page?.frameRev ?? 0) !== revBefore) childChanged = true;
    }
    if (childChanged && this.#page !== null) {
      await this.#refreshFrameImages();
      this.#page = await repaintPage(
        this.#page,
        this.viewport,
        this.#page.focus,
        this.#page.scrollY,
        { frameImages: this.#frameImages },
      );
    }
    // Script-driven iframe insertion/src mutation reconciles here.
    await this.#syncFrames();
    await this.#drainNavigationIntents(this.#page.frame);
    return { frames, mutations, frameRev: this.#page.frameRev };
  }

  /**
   * Frame lookup for the guest `iframe.contentWindow` getter — a lazily-read
   * closure over the live children map, threaded down to the document API.
   */
  readonly frameLookup = (nodeId: NodeId): unknown =>
    this.#frames.get(nodeId)?.proxyFor(this) ?? null;

  /**
   * Discover iframes in the live DOM, spawn/load their child contexts, and
   * composite each rendered child into the parent's image map. Async — the
   * frame pops in after the parent paints, like a real browser.
   */
  async #loadChildren(): Promise<void> {
    if (this.#page === null || this.#deps.depth >= MAX_FRAME_DEPTH) return;
    const dom = this.#page.dom;
    const iframeNodes: NodeId[] = [];
    for (const [id, n] of dom.nodes) {
      if (n.kind === "element" && n.tag === "iframe" && this.#iframeConnected(id)) {
        iframeNodes.push(id);
      }
    }
    if (iframeNodes.length === 0) return;
    for (const nodeId_ of iframeNodes) {
      const node = dom.nodes.get(nodeId_);
      if (node?.kind !== "element") continue;
      await this.#loadOneChild(nodeId_, node);
    }
    await this.#refreshFrameImages();
    this.#page = await repaintPage(
      this.#page,
      this.viewport,
      this.#page.focus,
      this.#page.scrollY,
      { frameImages: this.#frameImages },
    );
  }

  /** Ancestor origins starting from `start` — innermost first (RFC 0027 +
   *  0030: the OOPIF worker gets this chain over the wire). */
  #ancestorOriginChain(start: BrowsingContext): string[] {
    const out: string[] = [];
    let anc: BrowsingContext | null = start;
    while (anc !== null) {
      const u = anc.page?.url;
      if (u !== undefined) {
        try {
          out.push(new URL(u).origin);
        } catch {
          /* non-URL ancestor — skip */
        }
      }
      anc = anc.#deps.parent;
    }
    return out;
  }

  /** The URL/document identity a child is (re)loaded for — drift ⇒ re-navigate. */
  #childSignature(node: { attrs?: ReadonlyMap<string, string> }, initiator: string): string {
    const srcdoc = node.attrs?.get("srcdoc");
    if (srcdoc !== undefined) return `srcdoc:${srcdoc}`;
    const src = node.attrs?.get("src");
    if (src === undefined) return "blank";
    return `src:${resolveNavigationTarget(src, initiator)}`;
  }

  /**
   * Spawn + load the child context for one iframe element: sandbox tokens,
   * laid-out size as its viewport, `src`/`srcdoc`/`about:blank` resolution,
   * nested contexts, then the element's `load` event.
   */
  async #loadOneChild(nodeId_: NodeId, node: { attrs?: ReadonlyMap<string, string> }): Promise<void> {
    const page = this.#page;
    if (page === null) return;
    const sandboxAttr = node.attrs?.get("sandbox");
    const sandboxTokens =
      sandboxAttr === undefined
        ? undefined
        : new Set(sandboxAttr.toLowerCase().split(/\s+/).filter(Boolean));
    const rect = getBoundingClientRect(page.fragmentTree, nodeId_);
    const childViewport: EngineViewport = {
      width: Math.max(1, Math.round(rect.width) || 300),
      height: Math.max(1, Math.round(rect.height) || 150),
    };
    const child = new BrowsingContext({
      network: this.#network,
      localRegistry: this.#deps.localRegistry,
      sessionStores: this.#deps.sessionStores,
      root: this.#root,
      parent: this,
      depth: this.#deps.depth + 1,
      ownerElement: nodeId_,
      ...(sandboxTokens !== undefined ? { sandboxTokens } : {}),
      viewportFor: () => childViewport,
      ...(this.#deps.onNewTab !== undefined ? { onNewTab: this.#deps.onNewTab } : {}),
      ...(this.#deps.onOpenWindow !== undefined
        ? { onOpenWindow: this.#deps.onOpenWindow }
        : {}),
      ...(this.#deps.confirmLeave !== undefined ? { confirmLeave: this.#deps.confirmLeave } : {}),
      // Downloads bubble to the tab level — nested contexts share the sink.
      ...(this.#deps.downloadsDir !== undefined ? { downloadsDir: this.#deps.downloadsDir } : {}),
      ...(this.#deps.onDownload !== undefined ? { onDownload: this.#deps.onDownload } : {}),
      // Tab identity: a child's window.close()/opener acts on the WHOLE tab.
      ...(this.#deps.onCloseTab !== undefined ? { onCloseTab: this.#deps.onCloseTab } : {}),
      ...(this.#deps.onPostMessageRemote !== undefined
        ? { onPostMessageRemote: this.#deps.onPostMessageRemote }
        : {}),
      ...(this.#deps.onFocusRequest !== undefined
        ? { onFocusRequest: this.#deps.onFocusRequest }
        : {}),
      tabId: this.#deps.tabId ?? 0,
      openerTabId: this.#deps.openerTabId ?? null,
      scriptOpened: this.#deps.scriptOpened ?? false,
    });
    const src = node.attrs?.get("src");
    const srcdoc = node.attrs?.get("srcdoc");
    const initiator = this.#history.current?.url ?? page.url;
    const resolved = srcdoc !== undefined
      ? initiator
      : resolveNavigationTarget(src ?? "about:blank", initiator);
    this.#frameSignatures.set(nodeId_, this.#childSignature(node, initiator));
    // RFC 0030 site isolation: a cross-origin child document runs in its own
    // worker — the parent keeps only a port-backed WindowProxy + a composited
    // bitmap. srcdoc/about:blank inherit the embedder's origin — never
    // isolated (HTML §7.4.1).
    if (srcdoc === undefined && shouldIsolateFrame(initiator, resolved)) {
      // RFC 0027 `frame-src`: the parent's CSP gates even remote children.
      const parentCsp = page.csp ?? null;
      if (parentCsp !== null && !parentCsp.check("frame", resolved).allowed) return;
      const remote = new IsolatedFrame({
        ownerElement: nodeId_,
        onMessageOut: (frame, data, targetOrigin) =>
          this.deliverMessage(data, targetOrigin, frame),
        // `target=_parent`/`_top` inside the remote frame navigates THIS
        // context (the embedder) — HTML §7.1.3.2 up-the-tree routing.
        onNavigateOut: (navUrl) => {
          void this.navigate(navUrl).catch(() => {});
        },
        ...(this.#deps.oopif?.resources !== undefined
          ? { resources: this.#deps.oopif.resources }
          : {}),
        ...(this.#deps.oopif?.workerUrl !== undefined
          ? { workerUrl: this.#deps.oopif.workerUrl }
          : {}),
      });
      this.#frames.set(nodeId_, remote);
      try {
        const ok = await remote.load({
          url: resolved,
          viewport: childViewport,
          parentUrl: initiator,
          ancestorOrigins: this.#ancestorOriginChain(this),
          ...(page.coep !== undefined && page.coep !== "unsafe-none"
            ? { initiatorCoep: page.coep }
            : {}),
        });
        if (!ok) {
          this.#frames.delete(nodeId_);
          remote.dispose();
          return;
        }
      } catch {
        this.#frames.delete(nodeId_);
        remote.dispose();
        return;
      }
      this.#page?.runtime?.dispatchElementEvent?.(nodeId_, "load");
      return;
    }
    this.#frames.set(nodeId_, child);
    // A failed child document must NOT fail the parent navigation — a real
    // browser paints an error frame. Blank stays composited as no-bitmap.
    try {
      const childPage = await child.#loadDocument(
        srcdoc !== undefined
          ? initiator // srcdoc inherits the embedding URL for storage/origin
          : resolveNavigationTarget(src ?? "about:blank", initiator),
        initiator,
        {
          ...(srcdoc !== undefined ? { srcdocHtml: srcdoc } : {}),
          // iframe[referrerpolicy] governs the child document fetch (spec).
          ...((() => {
            const rp = node.attrs?.get("referrerpolicy");
            return rp === undefined ? {} : { referrerPolicy: rp };
          })()),
          // RFC 0031: a require-corp embedder gates this child document on
          // CORP + the child's own COEP (checked inside the stack).
          ...(page.coep !== undefined && page.coep !== "unsafe-none"
            ? { initiatorCoep: page.coep }
            : {}),
        },
      );
      if (childPage !== null) {
        // null ⇒ the child document was a download (attachment) — the frame
        // stays empty, matching a real browser's detached-download frame.
        child.#adoptPage(childPage, true, undefined);
        await child.#loadChildren();
      }
    } catch {
      return;
    }
    // `load` on the iframe element once the child document boots.
    this.#page?.runtime?.dispatchElementEvent?.(nodeId_, "load");
  }

  /**
   * `src`/`srcdoc` attribute drift re-navigates the child (HTML §4.8.5 —
   * setting `src` is a full navigation of the nested navigable). srcdoc
   * reloads the inline document; src pushes a history entry in the child.
   */
  async #reloadChild(nodeId_: NodeId, node: { attrs?: ReadonlyMap<string, string> }, child: FrameChild): Promise<void> {
    const page = this.#page;
    if (page === null) return;
    const initiator = this.#history.current?.url ?? page.url;
    const srcdoc = node.attrs?.get("srcdoc");
    const src = node.attrs?.get("src");
    this.#frameSignatures.set(nodeId_, this.#childSignature(node, initiator));
    if (child instanceof IsolatedFrame) {
      // Remote frames re-navigate over the port (isolation is re-decided at
      // load — a drift back same-origin still stays remote for this frame's
      // lifetime, matching Chrome's commit-time process choice).
      try {
        await child.navigate(resolveNavigationTarget(src ?? "about:blank", initiator));
      } catch {
        return;
      }
      this.#page?.runtime?.dispatchElementEvent?.(nodeId_, "load");
      return;
    }
    try {
      if (srcdoc !== undefined) {
        const childPage = await child.#loadDocument(initiator, initiator, { srcdocHtml: srcdoc });
        if (childPage !== null) child.#adoptPage(childPage, true, undefined);
      } else {
        const resolved = resolveNavigationTarget(src ?? "about:blank", initiator);
        await child.navigate(resolved);
      }
    } catch {
      return;
    }
    // Each nested navigation fires `load` on the iframe element (spec).
    this.#page?.runtime?.dispatchElementEvent?.(nodeId_, "load");
  }

  /** Parent-chain reachability — a detached iframe's context dies. */
  #iframeConnected(nodeId_: NodeId): boolean {
    const dom = this.#page?.dom;
    if (dom === undefined) return false;
    let cur: NodeId | null | undefined = nodeId_;
    const seen = new Set<NodeId>();
    while (cur !== null && cur !== undefined) {
      if (seen.has(cur)) return false;
      seen.add(cur);
      if (cur === dom.root) return true;
      cur = dom.nodes.get(cur)?.parent;
    }
    return false;
  }

  /**
   * Frame-tree reconciliation after guest mutation (RFC 0013): diff the live
   * DOM's iframe set against live children — new elements load, detached
   * elements die, `src`/`srcdoc` drift re-navigates. Returns repaint-needed.
   */
  async #syncFrames(): Promise<boolean> {
    const page = this.#page;
    if (page === null) return false;
    const dom = page.dom;
    let changed = false;
    for (const nodeId_ of [...this.#frames.keys()]) {
      const n = dom.nodes.get(nodeId_);
      if (n?.kind !== "element" || n.tag !== "iframe" || !this.#iframeConnected(nodeId_)) {
        const gone = this.#frames.get(nodeId_);
        if (gone instanceof IsolatedFrame) gone.dispose();
        this.#frames.delete(nodeId_);
        this.#frameImages.delete(nodeId_);
        this.#frameSignatures.delete(nodeId_);
        changed = true;
      }
    }
    if (this.#deps.depth < MAX_FRAME_DEPTH) {
      for (const [id, n] of dom.nodes) {
        if (n.kind !== "element" || n.tag !== "iframe" || !this.#iframeConnected(id)) continue;
        const existing = this.#frames.get(id);
        const initiator = this.#history.current?.url ?? page.url;
        if (existing === undefined) {
          await this.#loadOneChild(id, n);
          changed = true;
        } else if (this.#frameSignatures.get(id) !== this.#childSignature(n, initiator)) {
          await this.#reloadChild(id, n, existing);
          changed = true;
        }
      }
    }
    if (changed) {
      await this.#refreshFrameImages();
      this.#page = await repaintPage(
        this.#page!,
        this.viewport,
        this.#page!.focus,
        this.#page!.scrollY,
        { frameImages: this.#frameImages },
      );
    }
    return changed;
  }

  /** Decode each child's current frame into the compositing image map. */
  async #refreshFrameImages(): Promise<void> {
    this.#frameImages = new Map();
    for (const [nodeId_, child] of this.#frames) {
      const png = child.framePngBytes;
      if (png === undefined || png.byteLength === 0) continue;
      const decoded = await decodeImageBytesAsync(png);
      if (decoded != null) this.#frameImages.set(nodeId_, decoded);
    }
  }

  /** Public entry: after the page is adopted, load its iframe children. */
  async loadChildrenAndRepaint(): Promise<PageFrame | null> {
    if (this.#page === null) return null;
    await this.#loadChildren();
    return this.#page.frame;
  }

  async back(): Promise<PageFrame | null> {
    return this.#traverseJoint(-1);
  }

  async forward(): Promise<PageFrame | null> {
    return this.#traverseJoint(1);
  }

  async reload(): Promise<PageFrame | null> {
    const entry = this.#history.current;
    const target = entry?.url ?? this.#page?.url;
    if (target === undefined) return null;
    if (!this.#confirmCrossDocumentLeave()) {
      return this.#page?.frame ?? null;
    }
    this.#stashOutgoing(false);
    if (entry !== undefined) this.#history.dropRetained(entry.documentKey);
    const page = await this.#loadDocument(target, "about:blank", {});
    if (page === null) return this.#page?.frame ?? null; // attachment ⇒ stay
    this.#adoptPage(page, false, undefined);
    await this.#loadChildren();
    return this.#drainNavigationIntents(this.#page?.frame ?? null);
  }

  /**
   * Session persistence: export the TOP-LEVEL context's history as data —
   * the shell writes it to disk across restarts. Nested-frame steps don't
   * serialize (their contexts die with the parent document anyway; on
   * restore the fresh document rebuilds its frames).
   */
  exportHistory(): SessionHistorySnapshot {
    return this.#history.snapshot();
  }

  /**
   * Restore a persisted history and reload the current entry — documents
   * come back FRESH (retained pages/VMs don't serialize; honest boundary:
   * this is a reload-restore, not Firefox-style SHIP serialization). The
   * joint log rebuilds one step per entry so `history.length` and joint
   * traversal stay consistent.
   */
  async importHistory(snapshot: SessionHistorySnapshot): Promise<PageFrame | null> {
    this.#history.restore(snapshot);
    const root = this.#root;
    if (this === root) {
      root.#jointLog = this.#history.entries.map((entry) => ({
        parts: [{ ref: new WeakRef(this), path: [], entry }],
      }));
      root.#jointCursor = this.#history.index;
      this.#broadcastHistoryLength();
    }
    const entry = this.#history.current;
    if (entry === undefined) return this.#page?.frame ?? null;
    const page = await this.#loadDocument(entry.url, "about:blank", {});
    if (page === null) return this.#page?.frame ?? null;
    this.#adoptPage(page, false, undefined);
    // adoptPage→replaceCurrent just refreshed the current entry's title; the
    // joint part for it must point at the REPLACED entry object.
    this.#refreshJointEntry(this.#history.current!);
    await this.#loadChildren();
    return this.#drainNavigationIntents(this.#page?.frame ?? null);
  }
}


