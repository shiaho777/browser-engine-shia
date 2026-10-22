/**
 * Session layer (RFC 0010): the per-tab browsing context state that survives
 * navigation — structured session history, the guest↔host navigation bridge,
 * and storage with correct lifetimes.
 *
 * A real tab owns ONE network stack, ONE sessionStorage, and a history of
 * structured entries (URL + scroll position + document state) — not a list of
 * strings that reloads blindly. This module is that ownership boundary; the
 * sandbox-side `location`/`history` objects delegate here so guest code
 * (`location.assign`, `history.pushState`, …) drives REAL navigations.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The Web Storage shape guest sandboxes consume (matches StorageImpl). */
export interface StorageArea {
  readonly length: number;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
  key(index: number): string | null;
}

/** In-memory storage area — localStorage/sessionStorage backend (in-process). */
export function createMemoryStorageArea(): StorageArea {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
    clear: () => {
      map.clear();
    },
    key: (i) => [...map.keys()][i] ?? null,
  };
}

/**
 * Per-origin localStorage registry. Owned by the app process (shared across
 * tabs — same origin ⇒ same store, per HTML §11.2). When `persistFile` is
 * given the whole map is JSON-serialized to disk: loaded synchronously at
 * construction, written back atomically (tmp+rename) on every mutation.
 * Separate processes over one file are eventually-consistent — last writer
 * wins per flush, which is what real profile storage gives multi-process
 * browsers in effect.
 */
export class LocalStorageRegistry {
  readonly #stores = new Map<string, StorageArea>();
  readonly #persistFile: string | null;

  constructor(persistFile?: string) {
    this.#persistFile = persistFile ?? null;
    if (this.#persistFile !== null) {
      mkdirSync(dirname(this.#persistFile), { recursive: true });
      this.#loadFromDisk(this.#persistFile);
    }
  }

  /** The storage for `origin` (created on first touch). */
  forOrigin(url: string): StorageArea {
    const origin = localStorageOrigin(url);
    let store = this.#stores.get(origin);
    if (store === undefined) {
      store = createMemoryStorageArea();
      // Mutations must flush — wrap the area rather than teaching every
      // writer about persistence.
      if (this.#persistFile !== null) store = this.#persisting(store);
      this.#stores.set(origin, store);
    }
    return store;
  }

  #persisting(inner: StorageArea): StorageArea {
    return {
      get length() {
        return inner.length;
      },
      getItem: (k) => inner.getItem(k),
      setItem: (k, v) => {
        inner.setItem(k, v);
        this.#saveToDisk();
      },
      removeItem: (k) => {
        inner.removeItem(k);
        this.#saveToDisk();
      },
      clear: () => {
        inner.clear();
        this.#saveToDisk();
      },
      key: (i) => inner.key(i),
    };
  }

  /** Serialize all origins → `{origin: {key: value}}` and write atomically. */
  #saveToDisk(): void {
    const file = this.#persistFile;
    if (file === null) return;
    const out: Record<string, Record<string, string>> = {};
    for (const [origin, store] of this.#stores) {
      const kv: Record<string, string> = {};
      for (let i = 0; i < store.length; i += 1) {
        const k = store.key(i);
        if (k !== null) kv[k] = store.getItem(k) ?? "";
      }
      out[origin] = kv;
    }
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(out), "utf8");
    renameSync(tmp, file);
  }

  #loadFromDisk(file: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return; // absent or corrupt ⇒ cold start (honest: never crash a launch)
    }
    if (typeof parsed !== "object" || parsed === null) return;
    for (const [origin, kv] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof kv !== "object" || kv === null) continue;
      const store = this.#persisting(createMemoryStorageArea());
      for (const [k, v] of Object.entries(kv as Record<string, unknown>)) {
        if (typeof v === "string") store.setItem(k, v);
      }
      this.#stores.set(origin, store);
    }
  }

  /** Test/diagnostics hook: force a write NOW (writes are already sync). */
  flush(): void {
    this.#saveToDisk();
  }
}

/** Origin key shared by local/session registries (opaque ⇒ scheme+host). */
export function localStorageOrigin(url: string): string {
  try {
    const u = new URL(url);
    // engine://, file://, etc. have opaque origins — key on scheme+host so
    // engine pages still get a stable, isolated store.
    return u.origin !== "null" ? u.origin : `${u.protocol}//${u.host}`;
  } catch {
    return "about:";
  }
}

/**
 * Per-(tab, origin) sessionStorage (RFC 0013): same-origin frames in a tab
 * share; cross-origin frames isolate. Owned by the TabSession so all contexts
 * in one tab resolve through ONE registry.
 */
export class SessionStorageRegistry {
  readonly #stores = new Map<string, StorageArea>();

  forOrigin(url: string): StorageArea {
    const origin = localStorageOrigin(url);
    let store = this.#stores.get(origin);
    if (store === undefined) {
      store = createMemoryStorageArea();
      this.#stores.set(origin, store);
    }
    return store;
  }

  /** Distinct origins with live stores (diagnostics). */
  get originCount(): number {
    return this.#stores.size;
  }

  /**
   * Serialize every origin's store (RFC: sessionStorage cloning — when a new
   * top-level browsing context is created by duplication/`_blank`, it starts
   * with a COPY of the opener's stores; afterwards the two diverge).
   */
  snapshot(): SessionStorageSnapshot {
    const areas: { origin: string; keys: string[]; values: string[] }[] = [];
    for (const [origin, store] of this.#stores) {
      const keys: string[] = [];
      const values: string[] = [];
      for (let i = 0; i < store.length; i += 1) {
        const k = store.key(i);
        if (k === null) continue;
        keys.push(k);
        values.push(store.getItem(k) ?? "");
      }
      areas.push({ origin, keys, values });
    }
    return { areas };
  }

  /** Rebuild stores from `snapshot` — the clone starts equal, then diverges. */
  restore(snapshot: SessionStorageSnapshot): void {
    for (const area of snapshot.areas) {
      let store = this.#stores.get(area.origin);
      if (store === undefined) {
        store = createMemoryStorageArea();
        this.#stores.set(area.origin, store);
      }
      for (let i = 0; i < area.keys.length; i += 1) {
        store.setItem(area.keys[i]!, area.values[i]!);
      }
    }
  }
}

/**
 * `window.open(url, target, features)` tokens (HTML §7.2 "rules for choosing
 * a navigable"): `popup`/`width`/`height`/`left`/`top` shape the chrome hint;
 * `noopener` returns null and severs opener linkage; `noreferrer` suppresses
 * Referer on the opened navigation.
 */
export interface WindowFeatures {
  readonly popup: boolean;
  readonly width?: number;
  readonly height?: number;
  readonly left?: number;
  readonly top?: number;
  readonly noopener: boolean;
  readonly noreferrer: boolean;
}

const NUMERIC_FEATURE = /^-?\d+$/;

export function parseWindowFeatures(raw: string): WindowFeatures {
  const out: { [k: string]: string | boolean } = {};
  for (const token of raw.split(/[,\s]+/)) {
    if (token === "") continue;
    const eq = token.indexOf("=");
    const name = (eq === -1 ? token : token.slice(0, eq)).trim().toLowerCase();
    const value = eq === -1 ? "true" : token.slice(eq + 1).trim();
    // Bare name ⇒ true; yes/true ⇒ true; no/false/0 ⇒ false; else the value.
    out[name] =
      value === "" || /^(yes|true)$/i.test(value)
        ? true
        : /^(no|false|0)$/i.test(value)
          ? false
          : value;
  }
  const num = (k: string): number | undefined => {
    const v = out[k];
    if (v === undefined || typeof v === "boolean") return undefined;
    return NUMERIC_FEATURE.test(v) ? Number.parseInt(v, 10) : undefined;
  };
  const flag = (k: string): boolean => out[k] === true;
  const width = num("width");
  const height = num("height");
  return {
    // spec: any of popup/width/height/left/top present ⇒ popup-shaped request.
    popup:
      flag("popup") ||
      width !== undefined ||
      height !== undefined ||
      out["left"] !== undefined ||
      out["top"] !== undefined,
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(num("left") !== undefined ? { left: num("left")! } : {}),
    ...(num("top") !== undefined ? { top: num("top")! } : {}),
    // spec: noreferrer implies noopener — they travel together.
    noopener: flag("noopener") || flag("noreferrer"),
    noreferrer: flag("noreferrer"),
  };
}

/** Wire-friendly sessionStorage snapshot (origin → key/value pairs). */
export interface SessionStorageSnapshot {
  readonly areas: readonly {
    origin: string;
    keys: readonly string[];
    values: readonly string[];
  }[];
}

/** One entry in the session history — what `history.back()` actually restores. */
export interface SessionEntry {
  /** The committed post-redirect URL (what the address bar shows). */
  readonly url: string;
  readonly title: string;
  /** Scroll position captured when the entry was left — restored on traverse. */
  readonly scrollY: number;
  /** `history.state` payload (pushState/replaceState). */
  readonly state: unknown;
  /**
   * Entries that share a `documentKey` are same-document — traversing between
   * them fires popstate/hashchange WITHOUT reloading (pushState hops).
   */
  readonly documentKey: number;
  /**
   * Joint-history identity (RFC 0013): unique per pushed entry, stable across
   * recordScroll/replaceCurrent spreads — the tab-level joint log references
   * entries by this id, immune to object replacement.
   */
  readonly stepId: number;
}

/** Serializable form of one session entry — survives process restarts. */
export interface SessionEntrySnapshot {
  readonly url: string;
  readonly title: string;
  readonly scrollY: number;
  /** `history.state` as JSON — null when absent or unserializable. */
  readonly stateJson: string | null;
  /** Serialized so same-document (pushState) grouping survives a restart. */
  readonly docKey: number;
}

/** Wire/disk-friendly whole-history snapshot (RFC: history persistence). */
export interface SessionHistorySnapshot {
  readonly entries: readonly SessionEntrySnapshot[];
  readonly index: number;
}

/**
 * Type-only link to PageState (RFC 0012 bfcache): session.ts must not import
 * page.ts's runtime deps — the retained page is opaque to the history.
 */
export interface RetainedPage {
  /** Marker property — the history stores/returns it opaquely. */
  readonly url: string;
}

/**
 * Init fields a submitted navigation can carry (RFC 0011): form POSTs ride a
 * real method+body through the owned redirect loop.
 */
export interface NavigationInit {
  readonly replace?: boolean;
  readonly method?: string;
  readonly body?: string;
  readonly contentType?: string;
  /** `a[download]` filename hint — set ⇒ download the target, don't navigate. */
  readonly download?: string;
  /** Referrer-policy override (window.open "noreferrer"). */
  readonly referrerPolicy?: string;
}

/** The traversal request the host queues when guest code calls history.go. */
export type NavigationIntent =
  | {
      readonly kind: "navigate";
      readonly url: string;
      readonly replace: boolean;
      readonly method?: string;
      readonly body?: string;
      readonly contentType?: string;
      readonly download?: string;
      readonly referrerPolicy?: string;
    }
  | { readonly kind: "reload" }
  | { readonly kind: "close" }
  | { readonly kind: "traverse"; readonly delta: number }
  | { readonly kind: "push-state"; readonly url: string; readonly state: unknown }
  | { readonly kind: "replace-state"; readonly url: string; readonly state: unknown };

/** Strip the fragment: two URLs differing ONLY by `#` are the same document. */
export function sameDocumentUrl(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    ua.hash = "";
    ub.hash = "";
    return ua.href === ub.href;
  } catch {
    return a.split("#")[0] === b.split("#")[0];
  }
}

/** The fragment (""→no fragment) of a URL, or null when unparseable. */
export function fragmentOf(url: string): string | null {
  const i = url.indexOf("#");
  return i === -1 ? "" : url.slice(i + 1);
}

/**
 * Structured session history (HTML §7.4). Entries carry scroll position and
 * document state so traversal restores what the user saw, and pushState hops
 * stay same-document.
 */
export class SessionHistory {
  #entries: SessionEntry[] = [];
  #index = -1;
  #nextDocumentKey = 1;
  #nextStepId = 1;
  /**
   * RFC 0012 bfcache: live pages retained by the entry's documentKey (stable
   * across recordScroll/pushState entry replacement). LRU-capped; an evicted
   * or absent page means traversal falls back to reloading.
   */
  #retained = new Map<number, RetainedPage>();
  /** Max retained pages (bfcache size bound). */
  retainLimit = 3;

  get length(): number {
    return this.#entries.length;
  }

  get index(): number {
    return this.#index;
  }

  get current(): SessionEntry | undefined {
    return this.#index >= 0 ? this.#entries[this.#index] : undefined;
  }

  /** Read-only view — joint-log rebuild and tests iterate this. */
  get entries(): readonly SessionEntry[] {
    return this.#entries;
  }

  canGoBack(): boolean {
    return this.#index > 0;
  }

  canGoForward(): boolean {
    return this.#index >= 0 && this.#index < this.#entries.length - 1;
  }

  /** The entry `delta` steps away WITHOUT moving the index (beforeunload peek). */
  peek(delta: number): SessionEntry | undefined {
    const i = this.#index + delta;
    return i >= 0 && i < this.#entries.length ? this.#entries[i] : undefined;
  }

  /** The index of `entry` (by stable stepId), or -1 if it was truncated away. */
  locateEntry(entry: SessionEntry): number {
    return this.#entries.findIndex((e) => e.stepId === entry.stepId);
  }

  /** A full document load commits a NEW entry (truncating forward entries). */
  push(url: string, title: string, scrollY = 0, state: unknown = null): SessionEntry {
    const entry: SessionEntry = {
      url,
      title,
      scrollY,
      state,
      documentKey: this.#nextDocumentKey++,
      stepId: this.#nextStepId++,
    };
    this.#truncateForward();
    this.#entries.push(entry);
    this.#index = this.#entries.length - 1;
    return entry;
  }

  /**
   * pushState: a new entry sharing the CURRENT document — same-document
   * traversal between the two never reloads.
   */
  pushStateEntry(url: string, state: unknown): SessionEntry {
    const cur = this.current;
    const entry: SessionEntry = {
      url,
      title: cur?.title ?? "",
      scrollY: 0,
      state,
      documentKey: cur?.documentKey ?? this.#nextDocumentKey++,
      stepId: this.#nextStepId++,
    };
    this.#truncateForward();
    this.#entries.push(entry);
    this.#index = this.#entries.length - 1;
    return entry;
  }

  /** replace/replaceState: overwrite the current entry in place. */
  replaceCurrent(url: string, title?: string, state?: unknown): void {
    if (this.#index < 0) {
      this.push(url, title ?? "", 0, state ?? null);
      return;
    }
    const cur = this.#entries[this.#index]!;
    this.#entries[this.#index] = {
      url,
      title: title ?? cur.title,
      scrollY: cur.scrollY,
      state: state === undefined ? cur.state : state,
      documentKey: cur.documentKey,
      stepId: cur.stepId,
    };
  }

  /** Remember where the user scrolled before leaving the entry. */
  recordScroll(scrollY: number): void {
    if (this.#index < 0) return;
    const cur = this.#entries[this.#index]!;
    if (cur.scrollY === scrollY) return;
    this.#entries[this.#index] = { ...cur, scrollY };
  }

  /** Move by `delta` entries; returns the entry to activate (null = no move). */
  traverse(delta: number): SessionEntry | null {
    const next = this.#index + delta;
    if (next < 0 || next >= this.#entries.length) return null;
    this.#index = next;
    return this.#entries[next]!;
  }

  /**
   * Serialize the entry list + cursor. `state` goes through JSON — payloads
   * that don't round-trip degrade to null (structured clone is broader than
   * JSON; a persisted store can't do better without a binary format).
   * `documentKey`s are exported as-is — `restore` remaps them to fresh keys
   * so same-document grouping survives without colliding with live keys.
   */
  snapshot(): SessionHistorySnapshot {
    return {
      entries: this.#entries.map((e) => {
        let stateJson: string | null = null;
        try {
          if (e.state !== null && e.state !== undefined) {
            stateJson = JSON.stringify(e.state) ?? null;
          }
        } catch {
          stateJson = null;
        }
        return {
          url: e.url,
          title: e.title,
          scrollY: e.scrollY,
          stateJson,
          docKey: e.documentKey,
        };
      }),
      index: this.#index,
    };
  }

  /**
   * Rebuild from a snapshot: retained pages are dropped (live VMs don't
   * serialize), documentKeys remap fresh (grouping preserved, no collision
   * with keys this history already minted), the index clamps into range.
   */
  restore(snapshot: SessionHistorySnapshot): void {
    this.#retained.clear();
    const docKeyMap = new Map<number, number>();
    this.#entries = snapshot.entries.map((e) => {
      let key = docKeyMap.get(e.docKey);
      if (key === undefined) {
        key = this.#nextDocumentKey++;
        docKeyMap.set(e.docKey, key);
      }
      let state: unknown = null;
      if (e.stateJson !== null) {
        try {
          state = JSON.parse(e.stateJson);
        } catch {
          state = null;
        }
      }
      return {
        url: e.url,
        title: e.title,
        scrollY: e.scrollY,
        state,
        documentKey: key,
        stepId: this.#nextStepId++,
      };
    });
    this.#index =
      snapshot.index >= 0 && snapshot.index < this.#entries.length
        ? snapshot.index
        : this.#entries.length - 1;
  }

  /** Drop forward entries and any pages they retained (bfcache dies with them). */
  #truncateForward(): void {
    const dropped = this.#entries.slice(this.#index + 1);
    this.#entries = this.#entries.slice(0, this.#index + 1);
    for (const e of dropped) this.#retained.delete(e.documentKey);
  }

  // ---- bfcache (RFC 0012) ----------------------------------------------------

  /**
   * Retain `page` on the CURRENT entry (about to be left). LRU: the oldest
   * retained page drops when the cap is exceeded.
   */
  stashPage(page: RetainedPage): void {
    const cur = this.current;
    if (cur === undefined || this.retainLimit <= 0) return;
    this.#retained.delete(cur.documentKey); // refresh recency
    this.#retained.set(cur.documentKey, page);
    while (this.#retained.size > this.retainLimit) {
      const oldest = this.#retained.keys().next().value;
      if (oldest === undefined) break;
      this.#retained.delete(oldest);
    }
  }

  /** Detach + return the page retained on `entry` (null = reload path). */
  takePage(entry: SessionEntry): RetainedPage | null {
    const page = this.#retained.get(entry.documentKey) ?? null;
    if (page !== null) this.#retained.delete(entry.documentKey);
    return page;
  }

  /** Drop any page retained under `key` (reload discards the cached copy). */
  dropRetained(documentKey: number): void {
    this.#retained.delete(documentKey);
  }

  /** Retained-page count (diagnostics/tests). */
  get retainedCount(): number {
    return this.#retained.size;
  }
}

/**
 * The guest↔host navigation bridge (RFC 0010). The sandbox's `location` and
 * `history` delegate here: state reads (`href`, `length`, `state`) reflect the
 * current entry synchronously — as the spec requires pushState to — while
 * navigations queue as {@link NavigationIntent}s the session drains after the
 * guest task completes (real navigation is asynchronous).
 */
export class SessionHost {
  /** The committed URL guest `location.href` observes; mutated on commit. */
  currentUrl = "about:blank";
  /** `history.state` — mutated synchronously by pushState/replaceState. */
  currentState: unknown = null;
  /** `history.scrollRestoration` — "manual" suppresses scroll restore. */
  scrollRestoration: "auto" | "manual" = "auto";
  /**
   * RFC 0011: `target=_blank` — the tab owner installs this to open a real new
   * tab. Unset ⇒ the navigation stays in the current context.
   */
  onNewTab:
    | ((url: string, init?: { name?: string | null; scriptOpened?: boolean }) => void)
    | null = null;
  /**
   * RFC 0013: `target=_parent`/`_top` from a nested context delegates upward.
   * Unset ⇒ root context: navigates self.
   */
  navigateParent: ((url: string, init?: NavigationInit) => void) | null = null;
  navigateRoot: ((url: string, init?: NavigationInit) => void) | null = null;
  /**
   * RFC 0013: `target="name"` — the owning BrowsingContext resolves the name
   * against its child frames (name/id on the iframe element) and returns
   * true when it routed the navigation into that frame.
   */
  navigateNamed: ((url: string, name: string, init?: NavigationInit) => boolean) | null = null;
  /**
   * `window.open` (RFC 0013): synchronous — the owning context routes the
   * target and returns the opened window's proxy (or null for noopener /
   * un-marshallable remote tabs). Unset ⇒ `open` returns null.
   */
  onOpenWindow: ((url: string, target: string, features: string) => unknown) | null = null;
  /**
   * The caller's own WindowProxy (the sandbox's `window` object) — installed
   * when the navigation globals boot so `window.open(url,'_self')` returns
   * THE identical proxy the spec promises, not a fresh wrapper.
   */
  selfWindow: unknown = null;
  /**
   * The opener tab's id when this context lives in a script-opened tab —
   * feeds `window.opener` (null ⇒ no opener / noopener).
   */
  openerTabId: number | null = null;
  /**
   * Whether this tab was created by `window.open` — only script-opened
   * contexts may `window.close()` themselves (HTML §7.2.1 "script-closable").
   */
  scriptOpened = false;
  /** The owning tab's id — tags outbound cross-tab postMessages. */
  tabId = 0;
  /** Shell hook: a script-opened tab asks to be closed (`window.close`). */
  onCloseTab: (() => void) | null = null;
  /**
   * Cross-tab postMessage sink: the message is tagged with this tab's id and
   * routed by the shell to `targetTabId`'s renderer (worker→worker messaging
   * is always mediated by the browser process).
   */
  onPostMessageRemote:
    | ((msg: {
        targetTabId: number;
        fromTabId: number;
        fromUrl: string;
        dataJson: string;
        targetOrigin: string | null;
      }) => void)
    | null = null;
  #historyLength = 0;
  #intents: NavigationIntent[] = [];

  get historyLength(): number {
    return this.#historyLength;
  }

  setHistoryLength(n: number): void {
    this.#historyLength = n;
  }

  /** Commit a navigation: the visible URL/state now reflect the new entry. */
  commit(url: string, state: unknown = null): void {
    this.currentUrl = url;
    this.currentState = state;
  }

  get intents(): readonly NavigationIntent[] {
    return this.#intents;
  }

  drainIntents(): NavigationIntent[] {
    const out = this.#intents;
    this.#intents = [];
    return out;
  }

  // ---- location delegation -------------------------------------------------

  assign(url: string): void {
    this.submit(url);
  }

  replace(url: string): void {
    this.submit(url, { replace: true });
  }

  /**
   * Queue a navigation with full init (RFC 0011) — activation behavior and
   * form submission call this with the resolved target semantics applied by
   * the caller (target already dispatched to new-tab/parent/root).
   */
  submit(url: string, init: NavigationInit = {}): void {
    const abs = this.resolve(url);
    if (abs === null) return;
    this.#intents.push({
      kind: "navigate",
      url: abs,
      replace: init.replace ?? false,
      ...(init.method !== undefined ? { method: init.method } : {}),
      ...(init.body !== undefined ? { body: init.body } : {}),
      ...(init.contentType !== undefined ? { contentType: init.contentType } : {}),
      ...(init.download !== undefined ? { download: init.download } : {}),
      ...(init.referrerPolicy !== undefined ? { referrerPolicy: init.referrerPolicy } : {}),
    });
  }

  /**
   * Target-dispatching navigation (RFC 0011): `_blank` → new-tab hook (or
   * self when no tab strip), `_parent`/`_top` → delegate upward when nested.
   */
  navigateTarget(url: string, target: string, init: NavigationInit = {}): void {
    // `a[download]` wins over target — a download never opens a context.
    if (init.download !== undefined) {
      this.submit(url, init);
      return;
    }
    const t = target.toLowerCase();
    if (t === "_blank" && this.onNewTab !== null) {
      const abs = this.resolve(url);
      if (abs !== null) this.onNewTab(abs);
      return;
    }
    if (t === "_parent" && this.navigateParent !== null) {
      const abs = this.resolve(url);
      if (abs !== null) this.navigateParent(abs, init);
      return;
    }
    if (t === "_top" && this.navigateRoot !== null) {
      const abs = this.resolve(url);
      if (abs !== null) this.navigateRoot(abs, init);
      return;
    }
    if (
      t !== "_self" &&
      t !== "_parent" &&
      t !== "_top" &&
      t !== "_blank" &&
      this.navigateNamed !== null
    ) {
      const abs = this.resolve(url);
      if (abs !== null && this.navigateNamed(abs, target, init)) return;
      // Unknown name ⇒ create a named traversable which LATER opens with the
      // same name reuse (HTML §7.1.2.3 "rules for choosing a navigable").
      if (abs !== null && this.onNewTab !== null) {
        this.onNewTab(abs, { name: target });
        return;
      }
    }
    this.submit(url, init);
  }

  reload(): void {
    this.#intents.push({ kind: "reload" });
  }

  /**
   * `window.close()` — queues a close intent so it applies after the current
   * task like every other navigation-affecting op. Spec gate: only
   * script-opened contexts may close themselves (`scriptOpened`).
   */
  closeWindow(): void {
    if (!this.scriptOpened) return; // non-script-closable — silently ignored
    this.#intents.push({ kind: "close" });
  }

  /**
   * `window.opener.postMessage` / `e.source.postMessage` — the payload is
   * JSON-cloned (structured clone can't cross our process boundary) and
   * queued for the shell to route to the target tab's renderer.
   */
  postMessageRemote(targetTabId: number, data: unknown, targetOrigin: string | null): void {
    let dataJson: string;
    try {
      dataJson = JSON.stringify(data ?? null) ?? "null";
    } catch {
      return; // unserializable payloads drop like a DataCloneError abort
    }
    this.onPostMessageRemote?.({
      targetTabId,
      fromTabId: this.tabId,
      fromUrl: this.currentUrl,
      dataJson,
      targetOrigin,
    });
  }

  /** `window.focus()` on this window — asks the shell to activate our tab. */
  focusWindow(): void {
    this.onFocusRequest?.(this.tabId);
  }

  /** `opener.focus()` / `e.source.focus()` — focus a REMOTE tab via shell. */
  focusRemote(targetTabId: number): void {
    this.onFocusRequest?.(targetTabId);
  }

  /**
   * Shell hook: a `window.focus()` target (this tab or a remote one) asks to
   * become active — the tab strip's `select` answers it.
   */
  onFocusRequest: ((tabId: number) => void) | null = null;

  /**
   * `window.open` — synchronous per spec (the return value is a WindowProxy,
   * not a promise). The caller's context routes target + features.
   */
  openWindow(
    url: string | undefined,
    target: string | undefined,
    features: string | undefined,
  ): unknown {
    const raw = url === undefined || url === "" ? "about:blank" : url;
    const abs = this.resolve(raw) ?? "about:blank";
    return this.onOpenWindow?.(abs, target ?? "_blank", features ?? "") ?? null;
  }

  /** `location.hash = x` — resolves to a same-document navigate when possible. */
  setHash(fragment: string): void {
    this.assign(`${this.currentUrl.split("#")[0]}#${fragment.replace(/^#/, "")}`);
  }

  // ---- history delegation --------------------------------------------------

  back(): void {
    this.#intents.push({ kind: "traverse", delta: -1 });
  }

  forward(): void {
    this.#intents.push({ kind: "traverse", delta: 1 });
  }

  go(delta = 0): void {
    if (delta === 0) {
      this.#intents.push({ kind: "reload" });
      return;
    }
    this.#intents.push({ kind: "traverse", delta });
  }

  /**
   * pushState (HTML §7.4.1.2): synchronously updates the visible URL and state
   * WITHOUT fetching — the URL change is observable immediately. Queues an
   * intent so the session commits the new history entry after the task.
   *
   * @throws TypeError-style on cross-origin targets (spec SecurityError).
   */
  pushState(state: unknown, url: string | null | undefined): void {
    const abs = url === null || url === undefined ? this.currentUrl : this.resolve(url);
    if (abs === null || !this.sameOrigin(abs)) {
      throw new DOMExceptionShim(
        `pushState cannot create a history entry for a different origin: ${url}`,
      );
    }
    this.currentUrl = abs;
    this.currentState = state;
    this.#intents.push({ kind: "push-state", url: abs, state });
  }

  replaceState(state: unknown, url: string | null | undefined): void {
    const abs = url === null || url === undefined ? this.currentUrl : this.resolve(url);
    if (abs === null || !this.sameOrigin(abs)) {
      throw new DOMExceptionShim(
        `replaceState cannot rewrite a history entry to a different origin: ${url}`,
      );
    }
    this.currentUrl = abs;
    this.currentState = state;
    this.#intents.push({ kind: "replace-state", url: abs, state });
  }

  private resolve(url: string): string | null {
    try {
      return new URL(url, this.currentUrl).href;
    } catch {
      // `about:`-scheme and other non-hierarchical bases aren't URL-parseable
      // — an absolute input still resolves, a relative one is dropped (same
      // as the DOM's behavior resolving against an opaque base).
      try {
        return new URL(url).href;
      } catch {
        return null;
      }
    }
  }

  private sameOrigin(url: string): boolean {
    try {
      const a = new URL(this.currentUrl);
      const b = new URL(url);
      if (a.origin !== "null" && b.origin !== "null") return a.origin === b.origin;
      return a.protocol === b.protocol && a.host === b.host;
    } catch {
      return false;
    }
  }
}

/**
 * A SecurityError thrown where the spec throws `SecurityError` DOMException —
 * we don't carry the DOMException class into the app layer, so the shim names
 * it for guest-visible fidelity.
 */
export class DOMExceptionShim extends Error {
  override readonly name = "SecurityError";
}
