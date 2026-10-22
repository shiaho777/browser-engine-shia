/**
 * tab-host.ts — the browser-process side of the split (RFC 0004).
 *
 * `RemoteTab` is the shell's handle to a tab: every engine op is a typed RPC
 * to that tab's web-content worker, and frame/nav replies refresh the cached
 * metadata the chrome needs synchronously (tab strip, /api/frame, navState).
 *
 * `TabHost` owns the tab list only — chrome bookkeeping; no DOM, no IR.
 */
import {
  type Frame,
  type HitInfo,
  type NavState,
  type NewTabRequest,
  type DownloadEvent,
  type HistorySnapshot,
  type PendingPostMessage,
} from "@browser-engine/ipc";

import {
  DEFAULT_APP_VIEWPORT,
  normalizeViewport,
  type EngineViewport,
} from "./host-api.js";
import type { PageFrame } from "./page.js";
import { WebContentClient } from "./webcontent-client.js";
import type { EditableHit } from "./page.js";

export interface TabSnapshot {
  readonly id: number;
  readonly title: string;
  readonly url: string;
  readonly active: boolean;
}

export interface ClickResult {
  readonly hit: HitInfo;
  readonly navigated: boolean;
  readonly frame: PageFrame;
  readonly editable: EditableHit | null;
}

export interface PumpResult {
  readonly frames: number;
  readonly mutations: number;
  readonly frameRev: number;
}

/** Wire Frame → the PageFrame shape the chrome HTTP surface already speaks. */
function frameFromWire(f: Frame): PageFrame {
  const pngBase64 = Buffer.from(f.png.buffer, f.png.byteOffset, f.png.byteLength).toString("base64");
  return {
    url: f.url,
    title: f.title,
    width: f.width,
    height: f.height,
    pngBase64,
    bytes: f.png.byteLength,
    durationMs: f.durationMs,
    scriptsRun: f.scriptsRun,
    mutations: f.mutations,
    scriptError: f.scriptError,
    engine: "fine",
    frameRev: f.frameRev,
    scriptsLoaded: f.scriptsLoaded,
    scriptsFailed: f.scriptsFailed,
    moduleUrls: f.moduleUrls,
    cookies: f.cookies,
    networkEvents: f.networkEvents,
    modulesEvaluated: f.modulesEvaluated,
    modulesLinked: f.modulesLinked,
    esmSupported: f.esmSupported,
  };
}

/**
 * The shell's handle on one tab. Every operation is an RPC to the tab's
 * renderer worker; frame/nav replies refresh the cached chrome metadata.
 * Sync getters (`url`/`title`/`pngBytes`/…) serve the HTTP surface that reads
 * them between requests.
 */
export class RemoteTab {
  #client: WebContentClient;
  #id: number;
  #viewport: EngineViewport = { ...DEFAULT_APP_VIEWPORT };
  #nav: NavState = {
    canGoBack: false,
    canGoForward: false,
    url: "engine://home",
    title: "New Tab",
    hasPage: false,
    pendingNewTabs: [],
    pendingDownloads: [],
    closeRequested: false,
    pendingPostMessages: [],
    focusRequests: [],
    coep: "unsafe-none",
    coop: "unsafe-none",
    crossOriginIsolated: false,
    originAgentCluster: false,
  };
  #png: Uint8Array | null = null;
  #frameRev = 0;
  #lastFrame: PageFrame | null = null;
  /**
   * `_blank` navigation requests surface on ANY nav reply — TabHost installs
   * this to open a real tab cloned from this opener.
   */
  onNewTabRequest: ((req: NewTabRequest, opener: RemoteTab) => void) | null = null;
  /** Downloaded-file notices ride every nav reply — the chrome badge hook. */
  onDownload: ((file: DownloadEvent) => void) | null = null;
  /** `window.close()` on a script-opened tab — the shell closes this tab. */
  onCloseRequest: ((tab: RemoteTab) => void) | null = null;
  /**
   * Outbound cross-tab postMessage — the shell routes it to
   * `targetTabId`'s RemoteTab (`deliverMessage`).
   */
  onPostMessageRoute: ((msg: PendingPostMessage, sender: RemoteTab) => void) | null = null;
  /** `window.focus()`/`proxy.focus()` — the shell activates the target tab. */
  onFocusRequest: ((targetTabId: number, source: RemoteTab) => void) | null = null;

  constructor(
    id: number,
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
    this.#id = id;
    this.#client = new WebContentClient(profileDir, downloadsDir, identity);
  }

  get id(): number {
    return this.#id;
  }

  get url(): string {
    return this.#nav.url;
  }

  get title(): string {
    return this.#nav.title;
  }

  get viewport(): EngineViewport {
    return this.#viewport;
  }

  get frame(): PageFrame | null {
    return this.#lastFrame;
  }

  get pngBytes(): Uint8Array | null {
    return this.#png;
  }

  get frameRev(): number {
    return this.#frameRev;
  }

  canGoBack(): boolean {
    return this.#nav.canGoBack;
  }

  canGoForward(): boolean {
    return this.#nav.canGoForward;
  }

  navState(): NavState {
    return this.#nav;
  }

  /**
   * Shell-bound side-channel drain — every nav reply carries work the worker
   * wants done in the browser process (new tabs, downloads, closes,
   * cross-tab postMessage routing).
   */
  #drainNav(nav: NavState): void {
    for (const req of nav.pendingNewTabs) {
      this.onNewTabRequest?.(req, this);
    }
    for (const dl of nav.pendingDownloads) {
      this.onDownload?.(dl);
    }
    for (const msg of nav.pendingPostMessages) {
      this.onPostMessageRoute?.(msg, this);
    }
    for (const targetId of nav.focusRequests) {
      this.onFocusRequest?.(targetId, this);
    }
    if (nav.closeRequested) this.onCloseRequest?.(this);
  }

  #adopt(result: { frame: Frame | null; nav: NavState }): PageFrame | null {
    this.#nav = result.nav;
    this.#drainNav(result.nav);
    if (result.frame !== null) {
      this.#png = result.frame.png;
      this.#frameRev = result.frame.frameRev;
      this.#lastFrame = frameFromWire(result.frame);
    }
    return this.#lastFrame;
  }

  async navigate(
    target: string,
    options: {
      push?: boolean;
      viewport?: Partial<EngineViewport>;
      keepAlive?: boolean;
      referrerPolicy?: string;
    } = {},
  ): Promise<PageFrame> {
    const viewport = { ...this.#viewport, ...options.viewport };
    const { frame, nav } = await this.#client.navigate(target, viewport, {
      push: options.push ?? true,
      keepAlive: options.keepAlive === true,
      ...(options.referrerPolicy !== undefined
        ? { referrerPolicy: options.referrerPolicy }
        : {}),
    });
    this.#viewport = { ...this.#viewport, ...options.viewport };
    const adopted = this.#adopt({ frame, nav });
    if (adopted === null) throw new Error("navigate produced no frame");
    return adopted;
  }

  async loadHtml(
    html: string,
    title = "upload.html",
    viewport?: Partial<EngineViewport>,
  ): Promise<PageFrame> {
    const merged = { ...this.#viewport, ...viewport };
    const { frame, nav } = await this.#client.loadHtml(html, title, merged);
    this.#viewport = merged;
    const adopted = this.#adopt({ frame, nav });
    if (adopted === null) throw new Error("loadHtml produced no frame");
    return adopted;
  }

  async back(viewport?: Partial<EngineViewport>): Promise<PageFrame | null> {
    if (viewport !== undefined) this.#viewport = { ...this.#viewport, ...viewport };
    return this.#adopt(await this.#client.back(this.#viewport));
  }

  async forward(viewport?: Partial<EngineViewport>): Promise<PageFrame | null> {
    if (viewport !== undefined) this.#viewport = { ...this.#viewport, ...viewport };
    return this.#adopt(await this.#client.forward(this.#viewport));
  }

  async reload(viewport?: Partial<EngineViewport>): Promise<PageFrame | null> {
    if (viewport !== undefined) this.#viewport = { ...this.#viewport, ...viewport };
    return this.#adopt(await this.#client.reload(this.#viewport));
  }

  async applyViewport(input: Partial<EngineViewport> | null | undefined): Promise<PageFrame | null> {
    const next = normalizeViewport(input, this.#viewport);
    this.#viewport = next;
    return this.#adopt(await this.#client.setViewport(next));
  }

  async scrollBy(
    deltaX: number,
    deltaY: number,
    options: { settle?: boolean; viewport?: Partial<EngineViewport> } = {},
  ): Promise<PageFrame | null> {
    if (options.viewport !== undefined) {
      this.#viewport = normalizeViewport(options.viewport, this.#viewport);
    }
    return this.#adopt(
      await this.#client.scroll(deltaX, deltaY, {
        settle: options.settle === true,
        viewport: this.#viewport,
      }),
    );
  }

  hitTestAt(x: number, y: number): Promise<HitInfo> {
    return this.#client.hitTest(x, y);
  }

  async clickAt(
    x: number,
    y: number,
    viewport?: Partial<EngineViewport>,
  ): Promise<ClickResult> {
    if (viewport !== undefined) this.#viewport = { ...this.#viewport, ...viewport };
    const result = await this.#client.click(x, y, this.#viewport);
    this.#nav = result.nav;
    this.#drainNav(result.nav);
    if (result.frame !== null) {
      this.#png = result.frame.png;
      this.#frameRev = result.frame.frameRev;
      this.#lastFrame = frameFromWire(result.frame);
    }
    if (this.#lastFrame === null) throw new Error("click produced no frame");
    return {
      hit: result.hit,
      navigated: result.navigated,
      frame: this.#lastFrame,
      editable: result.editable,
    };
  }

  async commitText(
    nodeIdRaw: string,
    text: string,
    options: { caret?: number; selStart?: number; selEnd?: number; preview?: boolean } = {},
  ): Promise<PageFrame | null> {
    return this.#adopt(await this.#client.commitText(nodeIdRaw, text, options));
  }

  async pump(
    count = 1,
    options: { settleMs?: number; idleStop?: boolean } = {},
  ): Promise<PumpResult> {
    const result = await this.#client.pump(count, options);
    this.#nav = result.nav;
    this.#drainNav(result.nav);
    if (result.frame !== null) {
      this.#png = result.frame.png;
      this.#frameRev = result.frame.frameRev;
      this.#lastFrame = frameFromWire(result.frame);
    }
    return { frames: result.frames, mutations: result.mutations, frameRev: this.#frameRev };
  }

  /**
   * Deliver a cross-tab postMessage into this tab's top-level context — the
   * sender is another RemoteTab (the shell's routing table resolved us).
   */
  async deliverMessage(msg: PendingPostMessage): Promise<PageFrame | null> {
    return this.#adopt(await this.#client.deliverMessage(msg));
  }

  /** sessionStorage snapshot across origins — the duplication clone. */
  async exportSessionStorage(): Promise<readonly { origin: string; keys: readonly string[]; values: readonly string[] }[]> {
    return this.#client.exportSessionStorage();
  }

  /** Clone a sessionStorage snapshot into this tab (starts equal, diverges). */
  async importSessionStorage(
    areas: readonly { origin: string; keys: readonly string[]; values: readonly string[] }[],
  ): Promise<void> {
    await this.#client.importSessionStorage(areas);
  }

  /** Serialized session history — the shell persists it across restarts. */
  async exportSessionHistory(): Promise<HistorySnapshot> {
    return this.#client.exportSessionHistory();
  }

  /**
   * Restore a persisted history — the current entry reloads fresh (live
   * page/VM state is never serialized; honest boundary).
   */
  async importSessionHistory(snapshot: HistorySnapshot): Promise<PageFrame | null> {
    return this.#adopt(await this.#client.importSessionHistory(snapshot));
  }

  /** Liveness + the renderer's own font-stack report. */
  async ping(): Promise<{ ok: boolean; fonts: string }> {
    const reply = await this.#client.ping();
    return { ok: reply.ok, fonts: reply.fonts };
  }

  /** Shutdown the renderer — called by TabHost.close / server teardown. */
  async dispose(): Promise<void> {
    await this.#client.terminate();
  }
}

/**
 * The shell's tab list. Chrome bookkeeping only: which renderers exist,
 * which is active — content lives behind each `RemoteTab`'s worker.
 */
export class TabHost {
  #tabs: RemoteTab[] = [];
  #active = 0;
  #nextId = 1;
  readonly #profileDir: string | undefined;
  readonly #downloadsDir: string | undefined;
  /** Chrome-level download notification (renderer already wrote the file). */
  onDownload: ((file: DownloadEvent) => void) | null = null;
  /** Chrome hook when a script-opened tab asks to close itself. */
  onTabClosed: ((id: number) => void) | null = null;
  /**
   * Named top-level traversables (HTML §7.1.2.3): `window.open(u,'w')` on an
   * unknown name registers under 'w'; later opens with 'w' reuse that tab.
   */
  #namedTabs = new Map<string, RemoteTab>();

  constructor(
    options: { readonly profileDir?: string; readonly downloadsDir?: string } = {},
  ) {
    this.#profileDir = options.profileDir;
    this.#downloadsDir = options.downloadsDir;
    this.#tabs.push(this.#makeTab(this.#nextId));
    this.#nextId += 1;
  }

  /** Every renderer carries the `_blank` → real-tab hook + cross-tab wires. */
  #makeTab(
    id: number,
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
  ): RemoteTab {
    const tab = new RemoteTab(id, this.#profileDir, this.#downloadsDir, {
      tabId: id,
      ...identity,
    });
    tab.onNewTabRequest = (req, opener) => {
      void this.openInNewTab(req, opener).catch(() => {});
    };
    tab.onDownload = (file) => this.onDownload?.(file);
    tab.onCloseRequest = (self) => {
      this.close(self.id);
      this.onTabClosed?.(self.id);
    };
    // Worker→worker postMessage routes through the browser process — the
    // sender queues it in NavState, we forward to the target's RemoteTab.
    tab.onPostMessageRoute = (msg) => {
      const target = this.#tabs.find((t) => t.id === msg.targetTabId);
      void target?.deliverMessage(msg).catch(() => {});
    };
    // `window.focus()`/`opener.focus()` → activate the target tab in chrome.
    tab.onFocusRequest = (targetId) => {
      this.select(targetId);
    };
    return tab;
  }

  get active(): RemoteTab {
    return this.#tabs[this.#active]!;
  }

  get activeId(): number {
    return this.active.id;
  }

  /** A specific tab's handle (for cross-tab tests/tools beyond the strip). */
  tab(id: number): RemoteTab | undefined {
    return this.#tabs.find((t) => t.id === id);
  }

  list(): TabSnapshot[] {
    return this.#tabs.map((tab, index) => ({
      id: tab.id,
      title: tab.title,
      url: tab.url,
      active: index === this.#active,
    }));
  }

  /**
   * Export every tab's session history (the shell persists these to disk).
   * The active index travels so a restore reopens the right tab.
   */
  async exportSession(): Promise<{ tabs: { id: number; history: HistorySnapshot }[]; activeIndex: number }> {
    const tabs: { id: number; history: HistorySnapshot }[] = [];
    for (const tab of this.#tabs) {
      tabs.push({ id: tab.id, history: await tab.exportSessionHistory() });
    }
    return { tabs, activeIndex: this.#active };
  }

  /**
   * Recreate tabs from persisted snapshots — each import reloads that tab's
   * current entry. Empty history ⇒ a bare new tab.
   */
  async restoreSession(
    saved: { tabs: readonly { history: HistorySnapshot }[]; activeIndex: number },
  ): Promise<TabSnapshot[]> {
    // A cold start leaves one never-navigated tab behind — drop it first.
    if (this.#tabs.length === 1 && !this.#tabs[0]!.navState().hasPage) {
      this.#tabs = [];
      this.#active = 0;
    }
    for (let i = 0; i < saved.tabs.length; i += 1) {
      this.#tabs.push(this.#makeTab(this.#nextId));
      this.#nextId += 1;
    }
    this.#active = Math.min(Math.max(saved.activeIndex, 0), this.#tabs.length - 1);
    for (let i = 0; i < saved.tabs.length; i += 1) {
      await this.#tabs[i]!.importSessionHistory(saved.tabs[i]!.history);
    }
    return this.list();
  }

  create(): TabSnapshot[] {
    this.#tabs.push(this.#makeTab(this.#nextId));
    this.#nextId += 1;
    this.#active = this.#tabs.length - 1;
    return this.list();
  }

  /**
   * `target=_blank` / `window.open` semantics: a REAL new tab whose
   * sessionStorage starts as a copy of the opener's (then diverges per
   * spec). Named requests reuse the registered traversable; `window.open`
   * requests inherit opener linkage (`window.opener`/`postMessage` back) and
   * the script-closable bit.
   */
  async openInNewTab(req: NewTabRequest, opener: RemoteTab): Promise<TabSnapshot[]> {
    // Named traversable reuse — a second open('','w') navigates the SAME tab.
    if (req.name !== null) {
      const existing = this.#namedTabs.get(req.name);
      if (existing !== undefined && this.#tabs.includes(existing)) {
        await existing.navigate(req.url, {
          ...(req.referrerPolicy !== null ? { referrerPolicy: req.referrerPolicy } : {}),
        });
        this.#active = this.#tabs.indexOf(existing);
        return this.list();
      }
    }
    const snapshot = await opener.exportSessionStorage();
    const tab = this.#makeTab(this.#nextId, {
      // noopener/noreferrer ⇒ no opener link (spec); else the new tab can
      // postMessage back through the shell's cross-tab router.
      openerTabId: req.noopener ? null : opener.id,
      scriptOpened: req.scriptOpened,
      // RFC 0031: COOP severing resolves when the OPENED document's response
      // headers land — the opener's origin+coop travel with the request so
      // the pair can be evaluated inside that tab's boot (pre-script).
      ...(req.noopener
        ? {}
        : {
            openerInfo: {
              origin: req.openerOrigin,
              coop: req.openerCoop ?? "unsafe-none",
              popup: req.popup,
            },
          }),
    });
    this.#nextId += 1;
    this.#tabs.push(tab);
    this.#active = this.#tabs.length - 1;
    if (req.name !== null) this.#namedTabs.set(req.name, tab);
    await tab.importSessionStorage(snapshot);
    await tab.navigate(req.url, {
      ...(req.referrerPolicy !== null ? { referrerPolicy: req.referrerPolicy } : {}),
    });
    return this.list();
  }

  /**
   * Tab duplication: cloned sessionStorage + current URL. Honest boundary —
   * the joint session history list is NOT cloned.
   */
  async duplicate(id = this.activeId): Promise<TabSnapshot[]> {
    const opener = this.#tabs.find((tab) => tab.id === id);
    if (opener === undefined) return this.list();
    return this.openInNewTab(
      {
        url: opener.url,
        referrerPolicy: null,
        popup: false,
        width: null,
        height: null,
        name: null,
        scriptOpened: false,
        noopener: false,
        openerOrigin: null,
        openerCoop: null,
      },
      opener,
    );
  }

  select(id: number): boolean {
    const index = this.#tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return false;
    this.#active = index;
    return true;
  }

  close(id: number): TabSnapshot[] {
    // A closed tab vacates its registered name (later opens create fresh).
    for (const [name, tab] of this.#namedTabs) {
      if (tab.id === id) this.#namedTabs.delete(name);
    }
    if (this.#tabs.length <= 1) {
      const old = this.#tabs[0]!;
      this.#tabs = [this.#makeTab(this.#nextId)];
      this.#nextId += 1;
      this.#active = 0;
      void old.dispose();
      return this.list();
    }
    const index = this.#tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return this.list();
    const [removed] = this.#tabs.splice(index, 1);
    if (this.#active >= this.#tabs.length) {
      this.#active = this.#tabs.length - 1;
    } else if (this.#active > index) {
      this.#active -= 1;
    }
    void removed?.dispose();
    return this.list();
  }

  /** Terminate every renderer — server/electron shutdown path. */
  async dispose(): Promise<void> {
    await Promise.all(this.#tabs.map((tab) => tab.dispose()));
    this.#tabs = [this.#makeTab(this.#nextId)];
    this.#nextId += 1;
    this.#active = 0;
  }
}
