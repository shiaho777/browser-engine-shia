import { hitTest } from "@browser-engine/layout";
import { nodeId } from "@browser-engine/ir";

import {
  DEFAULT_APP_VIEWPORT,
  normalizeViewport,
  viewportChanged,
  type EngineViewport,
} from "./host-api.js";
import type { EditFocus } from "./focus-overlay.js";
import {
  applyFocus,
  applyTextEdit,
  editableHitFromPoint,
  findLinkHref,
  loadHtmlDocument,
  loadPage,
  pumpFrames,
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

export class TabSession {
  #page: PageState | null = null;
  #history: string[] = [];
  #index = -1;
  #viewport: EngineViewport = { ...DEFAULT_APP_VIEWPORT };
  #id: number;

  constructor(id = 1) {
    this.#id = id;
  }

  get id(): number {
    return this.#id;
  }

  get viewport(): EngineViewport {
    return this.#viewport;
  }

  get url(): string {
    return this.#page?.url ?? "engine://home";
  }

  get title(): string {
    return this.#page?.title ?? "New Tab";
  }

  get frame(): PageFrame | null {
    return this.#page?.frame ?? null;
  }

  get pngBytes(): Uint8Array | null {
    return this.#page?.pngBytes ?? null;
  }

  get frameRev(): number {
    return this.#page?.frameRev ?? 0;
  }

  get page(): PageState | null {
    return this.#page;
  }

  get focus(): EditFocus | null {
    return this.#page?.focus ?? null;
  }

  canGoBack(): boolean {
    return this.#index > 0;
  }

  canGoForward(): boolean {
    return this.#index >= 0 && this.#index < this.#history.length - 1;
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
    if (!changed || this.#page === null) {
      return this.#page?.frame ?? null;
    }
    return this.relayout();
  }

  async relayout(): Promise<PageFrame | null> {
    if (this.#page === null) return null;
    this.#page = await repaintPage(this.#page, this.#viewport, this.#page.focus, this.#page.scrollY ?? 0);
    return this.#page.frame;
  }

  async scrollBy(
    deltaX: number,
    deltaY: number,
    options: { readonly settle?: boolean } = {},
  ): Promise<PageFrame | null> {
    if (this.#page === null) return null;
    const viewH = this.#viewport.height;
    const contentH = this.#page.contentHeight ?? viewH;
    const maxScroll = Math.max(0, contentH - viewH);
    const nextY = Math.max(0, Math.min(maxScroll, (this.#page.scrollY ?? 0) + deltaY));
    const settle = options.settle === true;
    if (!settle && Math.abs(nextY - (this.#page.scrollY ?? 0)) < 0.5 && Math.abs(deltaX) < 0.5) {
      return this.#page.frame;
    }
    const scrollOpts: { quality: "fast" | "full"; pixelRatio?: number } = {
      quality: settle ? "full" : "fast",
    };
    if (typeof this.#viewport.devicePixelRatio === "number") {
      scrollOpts.pixelRatio = this.#viewport.devicePixelRatio;
    }
    this.#page = await fastScrollPaint(this.#page, this.#viewport, nextY, scrollOpts);
    return this.#page.frame;
  }

  get scrollY(): number {
    return this.#page?.scrollY ?? 0;
  }

  get contentHeight(): number {
    return this.#page?.contentHeight ?? this.#viewport.height;
  }

  async navigate(
    target: string,
    options: { push?: boolean; viewport?: Partial<EngineViewport>; keepAlive?: boolean } = {},
  ): Promise<PageFrame> {
    if (options.viewport !== undefined) {
      this.setViewport(options.viewport);
    }
    const push = options.push ?? true;
    const page = await loadPage(target, {
      viewport: this.#viewport,
      ...(options.keepAlive ? { keepAlive: true } : {}),
    });
    this.#page = page;
    if (push) {
      this.#history = this.#history.slice(0, this.#index + 1);
      this.#history.push(page.url);
      this.#index = this.#history.length - 1;
    } else if (this.#index >= 0) {
      this.#history[this.#index] = page.url;
    } else {
      this.#history = [page.url];
      this.#index = 0;
    }
    return page.frame;
  }

  /**
   * Advance the live page by up to `count` render cycles: drain guest
   * timers/rAF, then repaint each time. Stops early when guest work stops
   * mutating the DOM. Returns the number of frames actually produced.
   */
  async pump(
    count = 1,
    options: { readonly settleMs?: number; readonly idleStop?: boolean } = {},
  ): Promise<{ frames: number; mutations: number; frameRev: number }> {
    if (this.#page === null) return { frames: 0, mutations: 0, frameRev: 0 };
    const result = await pumpFrames(this.#page, count, options);
    this.#page = result.page;
    return { frames: result.frames, mutations: result.mutations, frameRev: this.#page.frameRev };
  }

  async loadHtml(
    html: string,
    title = "upload.html",
    viewport?: Partial<EngineViewport>,
  ): Promise<PageFrame> {
    if (viewport !== undefined) {
      this.setViewport(viewport);
    }
    const page = await loadHtmlDocument(html, `engine://upload/${title}`, this.#viewport);
    this.#page = page;
    this.#history = this.#history.slice(0, this.#index + 1);
    this.#history.push(page.url);
    this.#index = this.#history.length - 1;
    return page.frame;
  }

  async back(viewport?: Partial<EngineViewport>): Promise<PageFrame | null> {
    if (viewport !== undefined) {
      this.setViewport(viewport);
    }
    if (!this.canGoBack()) return this.#page?.frame ?? null;
    this.#index -= 1;
    const target = this.#history[this.#index];
    if (target === undefined) return this.#page?.frame ?? null;
    const page = await loadPage(target, { viewport: this.#viewport });
    this.#page = page;
    return page.frame;
  }

  async forward(viewport?: Partial<EngineViewport>): Promise<PageFrame | null> {
    if (viewport !== undefined) {
      this.setViewport(viewport);
    }
    if (!this.canGoForward()) return this.#page?.frame ?? null;
    this.#index += 1;
    const target = this.#history[this.#index];
    if (target === undefined) return this.#page?.frame ?? null;
    const page = await loadPage(target, { viewport: this.#viewport });
    this.#page = page;
    return page.frame;
  }

  async reload(viewport?: Partial<EngineViewport>): Promise<PageFrame | null> {
    if (viewport !== undefined) {
      this.setViewport(viewport);
    }
    if (this.#page === null) return null;
    const page = await loadPage(this.#page.url, { viewport: this.#viewport });
    this.#page = page;
    return page.frame;
  }

  hitTestAt(x: number, y: number): HitInfo {
    if (this.#page === null) {
      return {
        x,
        y,
        nodeId: null,
        tag: null,
        href: null,
        cursor: "default",
        editable: null,
      };
    }
    const docY = y + (this.#page.scrollY ?? 0);
    const hit = hitTest(this.#page.fragmentTree, x, docY);
    if (hit === null) {
      return {
        x,
        y,
        nodeId: null,
        tag: null,
        href: null,
        cursor: "default",
        editable: null,
      };
    }
    const href = findLinkHref(this.#page.dom, hit.node);
    const editable = editableHitFromPoint(this.#page, x, y);
    let cursor: HitInfo["cursor"] = "default";
    if (href !== null) cursor = "pointer";
    else if (editable !== null) cursor = "text";
    return {
      x,
      y,
      nodeId: String(hit.node),
      tag: tagOf(this.#page.dom, hit.node),
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
    if (this.#page === null) {
      const frame = await this.navigate("engine://home");
      return { hit, navigated: true, frame, editable: null };
    }
    if (hit.editable !== null) {
      const id = nodeId(Number(hit.editable.nodeId));
      const caret = hit.editable.value.length;
      this.#page = await applyFocus(this.#page, {
        nodeId: id,
        caret,
        selStart: caret,
        selEnd: caret,
      });
      return {
        hit,
        navigated: false,
        frame: this.#page.frame,
        editable: { ...hit.editable, value: hit.editable.value },
      };
    }
    if (this.#page.focus !== null) {
      this.#page = await applyFocus(this.#page, null);
    }
    if (hit.href === null) {
      return { hit, navigated: false, frame: this.#page.frame, editable: null };
    }
    const next = resolveNavigationTarget(hit.href, this.#page.url);
    const frame = await this.navigate(next, { push: true });
    return { hit: { ...hit, href: next }, navigated: true, frame, editable: null };
  }

  async commitText(
    nodeIdRaw: string,
    text: string,
    options: TypeOptions = {},
  ): Promise<PageFrame | null> {
    if (this.#page === null) return null;
    const id = nodeId(Number(nodeIdRaw));
    const caret = options.caret ?? text.length;
    const selStart = options.selStart ?? caret;
    const selEnd = options.selEnd ?? caret;
    this.#page = await applyTextEdit(this.#page, id, text, this.#viewport, {
      caret,
      selStart,
      selEnd,
    });
    return this.#page.frame;
  }

  async blurFocus(): Promise<PageFrame | null> {
    if (this.#page === null) return null;
    if (this.#page.focus === null) return this.#page.frame;
    this.#page = await applyFocus(this.#page, null);
    return this.#page.frame;
  }
}

export class TabHost {
  #tabs: TabSession[] = [];
  #active = 0;
  #nextId = 1;

  constructor() {
    this.#tabs.push(new TabSession(this.#nextId));
    this.#nextId += 1;
  }

  get active(): TabSession {
    return this.#tabs[this.#active]!;
  }

  get activeId(): number {
    return this.active.id;
  }

  list(): TabSnapshot[] {
    return this.#tabs.map((tab, index) => ({
      id: tab.id,
      title: tab.title,
      url: tab.url,
      active: index === this.#active,
    }));
  }

  create(): TabSnapshot[] {
    const tab = new TabSession(this.#nextId);
    this.#nextId += 1;
    this.#tabs.push(tab);
    this.#active = this.#tabs.length - 1;
    return this.list();
  }

  select(id: number): boolean {
    const index = this.#tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return false;
    this.#active = index;
    return true;
  }

  close(id: number): TabSnapshot[] {
    if (this.#tabs.length <= 1) {
      this.#tabs = [new TabSession(this.#nextId)];
      this.#nextId += 1;
      this.#active = 0;
      return this.list();
    }
    const index = this.#tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return this.list();
    this.#tabs.splice(index, 1);
    if (this.#active >= this.#tabs.length) {
      this.#active = this.#tabs.length - 1;
    } else if (this.#active > index) {
      this.#active -= 1;
    }
    return this.list();
  }
}
