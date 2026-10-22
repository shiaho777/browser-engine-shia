import { hitTest } from "@browser-engine/layout";
import { nodeId } from "@browser-engine/ir";

import {
  DEFAULT_APP_VIEWPORT,
  normalizeViewport,
  viewportChanged,
  type EngineViewport,
} from "./host-api.js";
import {
  LocalStorageRegistry,
  SessionHistory,
  SessionHost,
  SessionStorageRegistry,
  type SessionHistorySnapshot,
  type SessionStorageSnapshot,
  type StorageArea,
} from "./session.js";
import { BrowsingContext, type DownloadedFile, type PendingPostMessage } from "./browsing-context.js";
import type { NewTabRequest } from "@browser-engine/ipc";
import { createBrowserNetworkStack, type BrowserNetworkStack } from "@browser-engine/guest";
import { ServiceWorkerRegistry, SharedWorkerRegistry } from "@browser-engine/cli";
import type { EditFocus } from "./focus-overlay.js";
import {
  applyFocus,
  applyTextEdit,
  editableHitFromPoint,
  findLinkHref,
  loadHtmlDocument,
  repaintPage,
  fastScrollPaint,
  resolveNavigationTarget,
  tagOf,
  type EditableHit,
  type PageFrame,
  type PageState,
} from "./page.js";

export interface HitInfo {
  readonly x: number;
  readonly y: number;
  readonly nodeId: string | null;
  readonly tag: string | null;
  readonly href: string | null;
  readonly cursor: "default" | "pointer" | "text";
  readonly editable: EditableHit | null;
}

export interface ClickResult {
  readonly hit: HitInfo;
  readonly navigated: boolean;
  readonly frame: PageFrame;
  readonly editable: EditableHit | null;
}

export interface TabSnapshot {
  readonly id: number;
  readonly title: string;
  readonly url: string;
  readonly active: boolean;
}

export interface TypeOptions {
  readonly caret?: number;
  readonly selStart?: number;
  readonly selEnd?: number;
  readonly preview?: boolean;
}

const EMPTY_HIT = (x: number, y: number): HitInfo => ({
  x,
  y,
  nodeId: null,
  tag: null,
  href: null,
  cursor: "default",
  editable: null,
});

/**
 * A browser tab (RFC 0004+0010+0013): the ROOT browsing context plus the
 * shell's input surface — viewport, hit-testing, clicks, text editing. All
 * navigation/session semantics live in {@link BrowsingContext}; nested
 * iframes get contexts of the same class (see `ctx.frames`).
 */
export class TabSession {
  /** The root browsing context — top-level document, iframe parent chain ends here. */
  #ctx: BrowsingContext;
  // RFC 0034: one registry per tab session → SW registrations survive
  // navigations inside the tab; the registry is the stack's intercept seam.
  #swRegistry = new ServiceWorkerRegistry({
    fetchScript: async (scriptUrl, pageUrl) => {
      const res = await this.#network.request({
        url: scriptUrl,
        initiator: pageUrl,
        destination: "serviceworker",
        mode: "same-origin",
        credentials: "same-origin",
        skipServiceWorker: true,
      });
      return res.body;
    },
  });
  // RFC 0042: shared workers live per-tab-stack — every document + iframe
  // in the context tree shares the realms; navigations keep them alive.
  #sharedWorkers = new SharedWorkerRegistry();
  #network: BrowserNetworkStack = createBrowserNetworkStack({
    timeoutMs: 8_000,
    serviceWorker: this.#swRegistry,
    sharedWorkers: this.#sharedWorkers,
  });
  #sessionStores = new SessionStorageRegistry();
  #localRegistry: LocalStorageRegistry;
  #viewport: EngineViewport = { ...DEFAULT_APP_VIEWPORT };
  #id: number;
  /** The tab strip installs this to give `target=_blank`/`window.open`/named
   *  targets a real new tab. */
  onNewTab:
    | ((
        url: string,
        init?: {
          referrerPolicy?: string;
          popup?: boolean;
          width?: number;
          height?: number;
          name?: string | null;
          scriptOpened?: boolean;
          noopener?: boolean;
        },
      ) => void)
    | null = null;
  /**
   * The chrome-level beforeunload prompt (HTML §5.11): consulted only when
   * guest code canceled `beforeunload` — `false` aborts the navigation.
   */
  confirmBeforeLeave: (() => boolean) | null = null;
  /** `_blank`/`window.open` targets with no handler queue here for the host. */
  #newTabRequests: NewTabRequest[] = [];
  /**
   * Where `a[download]`/`Content-Disposition: attachment` payloads land.
   * null ⇒ downloads stay suppressed (pre-download-subsystem behavior).
   */
  downloadsDir: string | null = null;
  /** Chrome notification once a download hits disk. */
  onDownload: ((file: DownloadedFile) => void) | null = null;
  /** Download lifecycle events queue here for the wire (worker → shell). */
  #downloadEvents: DownloadedFile[] = [];
  /** `window.close()` on a script-opened tab sets this for the shell drain. */
  #closeRequested = false;
  /** `opener`/`e.source` postMessages destined for OTHER tabs. */
  #postMessages: PendingPostMessage[] = [];
  /** `window.focus()` targets (own or remote tab ids) for the shell. */
  #focusRequests: number[] = [];

  /**
   * `identity` wires the cross-tab machinery: `openerTabId` feeds
   * `window.opener`, `scriptOpened` gates `window.close()` (spec: only
   * script-created contexts are script-closable).
   */
  constructor(
    id = 1,
    localRegistry?: LocalStorageRegistry,
    identity?: {
      openerTabId?: number | null;
      scriptOpened?: boolean;
      openerInfo?: {
        readonly origin: string | null;
        readonly coop: import("@browser-engine/guest").Coop;
        readonly popup: boolean;
      };
    },
  ) {
    this.#id = id;
    this.#localRegistry = localRegistry ?? new LocalStorageRegistry();
    // root omitted ⇒ the context is its own root (top-level browsing context).
    this.#ctx = new BrowsingContext({
      network: this.#network,
      localRegistry: this.#localRegistry,
      sessionStores: this.#sessionStores,
      parent: null,
      depth: 0,
      viewportFor: () => this.#viewport,
      onNewTab: (url, init) =>
        this.onNewTab !== null
          ? this.onNewTab(url, init)
          : this.#newTabRequests.push({
              url,
              popup: init?.popup ?? false,
              referrerPolicy: init?.referrerPolicy ?? null,
              width: init?.width ?? null,
              height: init?.height ?? null,
              name: init?.name ?? null,
              scriptOpened: init?.scriptOpened ?? false,
              noopener: init?.noopener ?? false,
              // RFC 0031: the opened tab's own COOP re-evaluates this pair —
              // it needs OUR origin+coop captured at open time.
              openerOrigin: this.#pageOrigin(),
              openerCoop: this.#ctx.page?.coop ?? null,
            }),
      downloadsDir: () => this.downloadsDir ?? undefined,
      onDownload: (file) => {
        this.#downloadEvents.push(file);
        this.onDownload?.(file);
      },
      confirmLeave: () => this.confirmBeforeLeave?.() ?? true,
      onCloseTab: () => {
        this.#closeRequested = true;
      },
      onPostMessageRemote: (msg) => {
        this.#postMessages.push(msg);
      },
      onFocusRequest: (tabId) => {
        this.#focusRequests.push(tabId);
      },
      tabId: id,
      openerTabId: identity?.openerTabId ?? null,
      scriptOpened: identity?.scriptOpened ?? false,
      ...(identity?.openerInfo !== undefined
        ? { openerInfo: identity.openerInfo }
        : {}),
    });
  }

  /** This tab's committed-document origin — `null` when none/parse failure. */
  #pageOrigin(): string | null {
    const url = this.#ctx.page?.url;
    if (url === undefined) return null;
    try {
      return new URL(url).origin;
    } catch {
      return null;
    }
  }

  /**
   * Drain `_blank`/`window.open` requests made since the last call (the
   * worker lifts them into NavState so the browser process opens real tabs).
   */
  takeNewTabRequests(): NewTabRequest[] {
    const out = this.#newTabRequests;
    this.#newTabRequests = [];
    return out;
  }

  /** Drain download lifecycle events (surfaced to chrome via NavState). */
  takeDownloadEvents(): DownloadedFile[] {
    const out = this.#downloadEvents;
    this.#downloadEvents = [];
    return out;
  }

  /** `window.close()` pending since the last reply — shell closes the tab. */
  takeCloseRequested(): boolean {
    const out = this.#closeRequested;
    this.#closeRequested = false;
    return out;
  }

  /** Drain cross-tab postMessages for the shell to route (NavState). */
  takePostMessages(): PendingPostMessage[] {
    const out = this.#postMessages;
    this.#postMessages = [];
    return out;
  }

  /** Drain `window.focus()` targets for the shell's tab strip (NavState). */
  takeFocusRequests(): number[] {
    const out = this.#focusRequests;
    this.#focusRequests = [];
    return out;
  }

  /**
   * Inbound cross-tab postMessage — delivers into the ROOT context's realm
   * (opener relationships are top-level). `e.source` is a reply proxy whose
   * postMessage routes back to the sender tab through the shell.
   */
  deliverMessage(msg: PendingPostMessage): void {
    this.#ctx.deliverCrossTabMessage(msg);
  }

  /** RFC: sessionStorage cloning — a snapshot across every live origin. */
  exportSessionStorage(): SessionStorageSnapshot {
    return this.#sessionStores.snapshot();
  }

  /** Clone a snapshot into this tab's stores (starts equal, then diverges). */
  importSessionStorage(snapshot: SessionStorageSnapshot): void {
    this.#sessionStores.restore(snapshot);
  }

  /** Persistable form of this tab's session history (restart restore). */
  exportSessionHistory(): SessionHistorySnapshot {
    return this.#ctx.exportHistory();
  }

  /**
   * Restore a persisted history and reload its current entry — documents
   * come back fresh (live page state never serializes to disk).
   */
  async importSessionHistory(snapshot: SessionHistorySnapshot): Promise<void> {
    await this.#ctx.importHistory(snapshot);
  }

  /** The root browsing context (navigation/session internals, frames tree). */
  get context(): BrowsingContext {
    return this.#ctx;
  }

  /** The session's shared network stack (cookie jar + HTTP cache). */
  get network(): BrowserNetworkStack {
    return this.#network;
  }

  /** The guest↔host navigation bridge (location/history delegate). */
  get sessionHost(): SessionHost {
    return this.#ctx.sessionHost;
  }

  /**
   * Teardown — disposes the frame tree, terminating any out-of-process
   * (cross-origin) iframe workers (RFC 0030) and the session's service
   * workers (RFC 0034). Idempotent.
   */
  dispose(): void {
    this.#swRegistry.dispose();
    this.#ctx.dispose();
  }

  /** Structured session history (back/forward list). */
  get historyList(): SessionHistory {
    return this.#ctx.historyList;
  }

  /** The tab-scoped sessionStorage for the CURRENT origin (test/diag). */
  get sessionStorage(): StorageArea {
    return this.#ctx.sessionStorage;
  }

  get id(): number {
    return this.#id;
  }

  get viewport(): EngineViewport {
    return this.#viewport;
  }

  get url(): string {
    // The committed entry URL is authoritative (pushState may have rewritten
    // it without loading — the address bar must reflect the entry, not just
    // the loaded document's URL).
    return this.#ctx.url === "about:blank" && this.#ctx.page === null
      ? "engine://home"
      : this.#ctx.url;
  }

  get title(): string {
    return this.#ctx.title === "" ? "New Tab" : this.#ctx.title;
  }

  get frame(): PageFrame | null {
    return this.#ctx.page?.frame ?? null;
  }

  get pngBytes(): Uint8Array | null {
    return this.#ctx.page?.pngBytes ?? null;
  }

  get frameRev(): number {
    return this.#ctx.page?.frameRev ?? 0;
  }

  get page(): PageState | null {
    return this.#ctx.page;
  }

  get focus(): EditFocus | null {
    return this.#ctx.page?.focus ?? null;
  }

  canGoBack(): boolean {
    return this.#ctx.canGoBack();
  }

  canGoForward(): boolean {
    return this.#ctx.canGoForward();
  }

  setViewport(input: Partial<EngineViewport> | null | undefined): boolean {
    const next = normalizeViewport(input, this.#viewport);
    if (!viewportChanged(this.#viewport, next)) {
      this.#viewport = next;
      return false;
    }
    this.#viewport = next;
    return true;
  }

  async applyViewport(input: Partial<EngineViewport> | null | undefined): Promise<PageFrame | null> {
    const changed = this.setViewport(input);
    if (!changed || this.#ctx.page === null) {
      return this.#ctx.page?.frame ?? null;
    }
    return this.relayout();
  }

  async relayout(): Promise<PageFrame | null> {
    const page = this.#ctx.page;
    if (page === null) return null;
    this.#ctx.setRenderedPage(
      await repaintPage(page, this.#viewport, page.focus, page.scrollY ?? 0),
    );
    return this.#ctx.page?.frame ?? null;
  }

  async scrollBy(
    deltaX: number,
    deltaY: number,
    options: { readonly settle?: boolean } = {},
  ): Promise<PageFrame | null> {
    const page = this.#ctx.page;
    if (page === null) return null;
    const viewH = this.#viewport.height;
    const contentH = page.contentHeight ?? viewH;
    const maxScroll = Math.max(0, contentH - viewH);
    const nextY = Math.max(0, Math.min(maxScroll, (page.scrollY ?? 0) + deltaY));
    const settle = options.settle === true;
    if (!settle && Math.abs(nextY - (page.scrollY ?? 0)) < 0.5 && Math.abs(deltaX) < 0.5) {
      return page.frame;
    }
    const scrollOpts: { quality: "fast" | "full"; pixelRatio?: number } = {
      quality: settle ? "full" : "fast",
    };
    if (typeof this.#viewport.devicePixelRatio === "number") {
      scrollOpts.pixelRatio = this.#viewport.devicePixelRatio;
    }
    this.#ctx.setRenderedPage(await fastScrollPaint(page, this.#viewport, nextY, scrollOpts));
    return this.#ctx.page?.frame ?? null;
  }

  get scrollY(): number {
    return this.#ctx.page?.scrollY ?? 0;
  }

  get contentHeight(): number {
    return this.#ctx.page?.contentHeight ?? this.#viewport.height;
  }

  async navigate(
    target: string,
    options: {
      push?: boolean;
      viewport?: Partial<EngineViewport>;
      keepAlive?: boolean;
      method?: string;
      body?: string;
      contentType?: string;
      referrerPolicy?: string;
    } = {},
  ): Promise<PageFrame> {
    if (options.viewport !== undefined) {
      this.setViewport(options.viewport);
    }
    try {
      return await this.#ctx.navigate(target, options);
    } catch {
      return this.#ctx.page?.frame ?? (await this.navigate("engine://home"));
    }
  }

  /**
   * Advance the live page by up to `count` render cycles: drain guest
   * timers/rAF here AND in every live child context, repaint, re-composite.
   */
  async pump(
    count = 1,
    options: { readonly settleMs?: number; readonly idleStop?: boolean } = {},
  ): Promise<{ frames: number; mutations: number; frameRev: number }> {
    const r = await this.#ctx.pump(count, options);
    return { frames: r.frames, mutations: r.mutations, frameRev: r.frameRev };
  }

  async loadHtml(
    html: string,
    title = "upload.html",
    viewport?: Partial<EngineViewport>,
  ): Promise<PageFrame> {
    if (viewport !== undefined) {
      this.setViewport(viewport);
    }
    const page = await loadHtmlDocument(html, `engine://upload/${title}`, this.#viewport, {
      keepAlive: true,
      sessionHost: this.#ctx.sessionHost,
      storage: {
        localStorage: this.#localRegistry.forOrigin(`engine://upload/${title}`),
        sessionStorage: this.#sessionStores.forOrigin(`engine://upload/${title}`),
      },
      frameLookup: this.#ctx.frameLookup,
    });
    this.#ctx.adoptLoadedPage(page);
    return this.#ctx.page?.frame ?? page.frame;
  }

  async back(viewport?: Partial<EngineViewport>): Promise<PageFrame | null> {
    if (viewport !== undefined) {
      this.setViewport(viewport);
    }
    return this.#ctx.back();
  }

  async forward(viewport?: Partial<EngineViewport>): Promise<PageFrame | null> {
    if (viewport !== undefined) {
      this.setViewport(viewport);
    }
    return this.#ctx.forward();
  }

  async reload(viewport?: Partial<EngineViewport>): Promise<PageFrame | null> {
    if (viewport !== undefined) {
      this.setViewport(viewport);
    }
    return this.#ctx.reload();
  }

  hitTestAt(x: number, y: number): HitInfo {
    const page = this.#ctx.page;
    if (page === null) return EMPTY_HIT(x, y);
    const docY = y + (page.scrollY ?? 0);
    const hit = hitTest(page.fragmentTree, x, docY);
    if (hit === null) return EMPTY_HIT(x, y);
    const href = findLinkHref(page.dom, hit.node);
    const editable = editableHitFromPoint(page, x, y);
    let cursor: HitInfo["cursor"] = "default";
    if (href !== null) cursor = "pointer";
    else if (editable !== null) cursor = "text";
    return {
      x,
      y,
      nodeId: String(hit.node),
      tag: tagOf(page.dom, hit.node),
      href,
      cursor,
      editable,
    };
  }

  async clickAt(
    x: number,
    y: number,
    viewport?: Partial<EngineViewport>,
  ): Promise<ClickResult> {
    if (viewport !== undefined) {
      this.setViewport(viewport);
    }
    const hit = this.hitTestAt(x, y);
    const page = this.#ctx.page;
    if (page === null) {
      const frame = await this.navigate("engine://home");
      return { hit, navigated: true, frame, editable: null };
    }
    if (hit.editable !== null) {
      const id = nodeId(Number(hit.editable.nodeId));
      const caret = hit.editable.value.length;
      this.#ctx.setRenderedPage(
        await applyFocus(page, { nodeId: id, caret, selStart: caret, selEnd: caret }),
      );
      return {
        hit,
        navigated: false,
        frame: this.#ctx.page?.frame ?? page.frame,
        editable: { ...hit.editable, value: hit.editable.value },
      };
    }
    if (page.focus !== null) {
      this.#ctx.setRenderedPage(await applyFocus(page, null));
    }
    // RFC 0011: the click goes THROUGH the guest when a live runtime exists —
    // listeners run, preventDefault cancels, activation behavior navigates
    // (links, submit buttons, details — one code path as el.click()).
    const runtime = page.runtime;
    if (runtime?.clickElement !== undefined && runtime.clickElement !== null && hit.nodeId !== null) {
      const urlBefore = this.url;
      runtime.clickElement(nodeId(Number(hit.nodeId)));
      await this.#ctx.drainIntents();
      const frame = this.#ctx.page?.frame ?? page.frame;
      return { hit, navigated: this.url !== urlBefore, frame, editable: null };
    }
    if (hit.href === null) {
      const frame = this.#ctx.page?.frame ?? page.frame;
      return { hit, navigated: false, frame, editable: null };
    }
    // Scriptless/static page: no listeners to consult — direct traversal.
    const next = resolveNavigationTarget(hit.href, page.url);
    const frame = await this.navigate(next, { push: true });
    return { hit: { ...hit, href: next }, navigated: true, frame, editable: null };
  }

  async commitText(
    nodeIdRaw: string,
    text: string,
    options: TypeOptions = {},
  ): Promise<PageFrame | null> {
    const page = this.#ctx.page;
    if (page === null) return null;
    const id = nodeId(Number(nodeIdRaw));
    const caret = options.caret ?? text.length;
    const selStart = options.selStart ?? caret;
    const selEnd = options.selEnd ?? caret;
    this.#ctx.setRenderedPage(
      await applyTextEdit(page, id, text, this.#viewport, {
        caret,
        selStart,
        selEnd,
      }),
    );
    return this.#ctx.page?.frame ?? null;
  }

  async blurFocus(): Promise<PageFrame | null> {
    const page = this.#ctx.page;
    if (page === null) return null;
    if (page.focus === null) return page.frame;
    this.#ctx.setRenderedPage(await applyFocus(page, null));
    return this.#ctx.page?.frame ?? null;
  }
}
