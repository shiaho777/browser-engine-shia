/**
 * event-loop.ts — a deterministic event loop + async networking for real JS
 * (#4: the event-loop / network half of "be a real browser").
 *
 * The browser event loop is microtasks (promise reactions, `queueMicrotask`)
 * drained to empty after each macrotask, and macrotasks (timers) ordered by due
 * time. This module models exactly that on a VIRTUAL CLOCK so it is fully
 * deterministic and testable: real JavaScript (V8 via `node:vm`) schedules work
 * through `setTimeout` / `queueMicrotask` / `fetch`, those callbacks mutate the
 * live {@link FineSession} DOM, and {@link EventDrivenRun} drains the loop to a
 * fixed point — exactly the ordering a browser guarantees (all microtasks
 * before the next timer).
 *
 * Networking is an injected, deterministic resolver (a `url → body` map — the
 * same shape the resource loader uses), surfaced to scripts as a `fetch()`
 * returning a thenable `Response` with `.text()`. No real sockets: the resolver
 * is the seam where a real transport would plug in. The async DATA FLOW
 * (fetch → promise reaction → DOM mutation → re-render) is real and ordered.
 */
import vm from "node:vm";

import type { NodeId } from "@browser-engine/ir";

import { FineSession, type DocumentIsolation } from "./fine.js";
import { CSS } from "./css-supports.js";
import { createMatchMedia } from "./match-media.js";
import { createMediaPreferences } from "./preferences.js";
import { makeWorkerCtor } from "./worker-global.js";
import { makeSharedWorkerCtor, SharedWorkerRegistry } from "./shared-worker-global.js";
import { buildDocumentApi } from "./script.js";
import { createServiceWorkerContainer } from "./service-worker.js";
import { BROWSER_USER_AGENT, defaultFetch, type FetchFn } from "./loader.js";
import {
  coerceGuestString,
  makeBlobClass,
  makeFileClass,
  globalObjectUrls,
  makeFetchApi,
  adaptResponseLike,
  DOMException,
  UIEvent as GuestUIEvent,
  MouseEvent as GuestMouseEvent,
  PointerEvent as GuestPointerEvent,
  KeyboardEvent as GuestKeyboardEvent,
  FocusEvent as GuestFocusEvent,
  InputEvent as GuestInputEvent,
  WheelEvent as GuestWheelEvent,
  CompositionEvent as GuestCompositionEvent,
  type FetchApi,
  type NormalizedRequest,
  type RawFetchResult,
  type WsTransport,
  mixedContentVerdict,
  isPotentiallyTrustworthyUrl,
} from "@browser-engine/guest";

export type GuestBrowserFetch = (
  input: unknown,
  init?: unknown,
) => Promise<{
  ok: boolean;
  status: number;
  url: string;
  headers: { get: (name: unknown) => string | null; has: (name: unknown) => boolean };
  text: () => Promise<string>;
  json: () => Promise<unknown>;
  arrayBuffer: () => Promise<ArrayBuffer>;
}>;

export interface ScriptNetworkOptions {
  readonly browserFetch?: GuestBrowserFetch;
  /**
   * RFC 0022: raw-socket transport for guest `new WebSocket(...)` —
   * `nodeWsTransport()` for real TCP/TLS, `createWsLoopback()` for tests.
   * Unset ⇒ sockets fail closed (error + 1006 close events, spec-shaped).
   */
  readonly wsTransport?: WsTransport;
  /**
   * Keep guest intervals alive after the initial flush so a host can keep
   * pumping the returned `drain`/`flushAsync` hooks for continuous rendering.
   * Live handles are unref'd so they never hold the host process open.
   */
  readonly keepAlive?: boolean;
  /**
   * Aligned with `sources` (external scripts may be interleaved): the <script>
   * element node executing each source, or null when unknown. Drives
   * `document.currentScript`.
   */
  readonly scriptNodeIds?: readonly (import("@browser-engine/ir").NodeId | null)[];
  /** Shared holder the document API reads for `document.currentScript`. */
  readonly currentScriptBox?: { current: import("@browser-engine/ir").NodeId | null };
  /**
   * Aligned with `sources`: the URL each source came from (inline = null),
   * used as the vm filename so guest stack frames identify the script.
   */
  readonly scriptUrls?: readonly (string | null)[];
  /** RFC 0013: iframe nodeId → child context window proxy (contentWindow). */
  readonly frameLookup?: (nodeId: import("@browser-engine/ir").NodeId) => unknown;
  /**
   * RFC 0010: the session's navigation bridge. When present, the sandbox's
   * `location`/`history` become LIVE objects delegating here (real
   * navigations, real pushState). Absent ⇒ the legacy static stubs.
   */
  readonly sessionHost?: NavigationHost;
  /**
   * RFC 0010: session-scoped storage to install as `localStorage`/
   * `sessionStorage`. Absent ⇒ fresh per-boot memory stores (harness paths).
   */
  readonly storage?: SessionStorageBag;
  /**
   * Live viewport geometry getter (IntersectionObserver root bounds; scroll
   * offsets move the viewport in document space between evaluations).
   */
  readonly viewport?: () => {
    readonly width: number;
    readonly height: number;
    readonly scrollY: number;
  };
  /**
   * RFC 0027: the document's CSP context. `connect-src` gates guest
   * `fetch`/XHR/WebSocket targets, `script-src` gates dynamic `<script>`
   * injection, and `style-src`/`style-src-attr` flow through the session's
   * cascade gate. Absent ⇒ no policy (the default for harness paths).
   */
  readonly csp?: import("./csp.js").CspContext | null;
  /**
   * RFC 0032: the dedicated worker-script byte channel — `destination:
   * "worker"`, `mode: "same-origin"`, `credentials: "same-origin"` per
   * Fetch §"fetch a classic worker script" (classic worker URLs are
   * same-origin-restricted). Absent ⇒ the runner's generic `fetchFn`.
   */
  readonly fetchWorkerSource?: (url: string) => Promise<Uint8Array | undefined>;
  /**
   * RFC 0033: `drawImage(imgEl)` source resolution — element NodeId → the
   * decoded pixels the page's resource pass produced. Absent ⇒ `<img>`
   * sources draw nothing (canvas/canvas sources still work).
   */
  readonly canvasImageSource?: (nodeId: import("@browser-engine/ir").NodeId) => import("@browser-engine/ir").DecodedImage | undefined;
  /**
   * RFC 0034: the session's service-worker registry — installs
   * `navigator.serviceWorker` (a real container: register/ready/controller/
   * message events) and lets `respondWith` interception see this page.
   * Absent ⇒ `navigator.serviceWorker` is undefined.
   */
  readonly serviceWorkerRegistry?: import("./service-worker.js").ServiceWorkerRegistry;
  /**
   * RFC 0042: the shared-worker registry — one instance per network stack /
   * browsing-context tree so same-(url,name) connects share one realm.
   * Absent ⇒ a per-session registry (intra-page sharing still works).
   */
  readonly sharedWorkerRegistry?: import("./shared-worker-global.js").SharedWorkerRegistry;
  /**
   * RFC 0042: the shared worker-script byte channel — `destination:
   * "sharedworker"`, `mode: "same-origin"`. Absent ⇒ fetchWorkerSource, then
   * the runner's generic fetchFn.
   */
  readonly fetchSharedWorkerSource?: (url: string) => Promise<Uint8Array | undefined>;
  /**
   * RFC 0035: the document's media engine (`<video>`/`<audio>` — fetch,
   * probe, playback clock). The runner binds dispatch + the loop clock;
   * element wrappers get the HTMLMediaElement surface.
   */
  readonly media?: import("./media.js").MediaEngine;
}

/**
 * The session's navigation bridge (RFC 0010) — a structural interface so the
 * app layer's `SessionHost` satisfies it without a dependency edge. Guest
 * `location`/`history` delegate to these methods; navigation intent is queued
 * asynchronously (real navigation happens after the current task).
 */
export interface NavigationHost {
  /** The committed document URL — `location.href` reads this live. */
  currentUrl: string;
  /** `history.state` — mutated synchronously by pushState/replaceState. */
  currentState: unknown;
  scrollRestoration: "auto" | "manual";
  readonly historyLength: number;
  /**
   * Commit a new document URL before its scripts run — the host reflects the
   * NEW page during boot (guest `location.assign` resolves against it).
   */
  commit(url: string, state?: unknown): void;
  assign(url: string): void;
  replace(url: string): void;
  /**
   * RFC 0011: activation-behavior sink — a/area clicks and form submissions.
   * `init` carries target/method/body; the host applies target dispatch
   * (_blank/_parent/_top) and queues the intent. Optional: absent ⇒
   * activation falls back to assign semantics.
   */
  submit?(url: string, init?: {
    replace?: boolean;
    target?: string;
    method?: string;
    body?: string;
    contentType?: string;
  }): void;
  navigateTarget?(url: string, target: string, init?: {
    replace?: boolean;
    method?: string;
    body?: string;
    contentType?: string;
  }): void;
  reload(): void;
  setHash(fragment: string): void;
  back(): void;
  forward(): void;
  go(delta?: number): void;
  pushState(state: unknown, url?: string | null): void;
  replaceState(state: unknown, url?: string | null): void;
  /**
   * `window.open(url, target, features)` — synchronous: returns the opened
   * navigable's WindowProxy, or null (noopener/remote/unavailable).
   */
  openWindow?(
    url: string | undefined,
    target: string | undefined,
    features: string | undefined,
  ): unknown;
  /**
   * The realm's own `window` object — set by installNavigationGlobals so
   * `window.open(url,'_self')` can return the identical proxy (spec: _self's
   * WindowProxy IS the caller's own).
   */
  selfWindow?: unknown;
  /** `window.close()` — gated on scriptOpened inside the host (spec). */
  closeWindow?(): void;
  /**
   * `window.opener.postMessage` — routes a JSON-cloned payload to the tab
   * whose id is `targetTabId`, through the browser-process router.
   */
  postMessageRemote?(
    targetTabId: number,
    data: unknown,
    targetOrigin: string | null,
  ): void;
  /** The opener tab's id — null ⇒ `window.opener` is null (noopener/none). */
  openerTabId?: number | null;
  /** `window.focus()` — asks the shell to activate this tab. */
  focusWindow?(): void;
  /** `opener.focus()`/`e.source.focus()` — activate a REMOTE tab. */
  focusRemote?(targetTabId: number): void;
}

/** The Web Storage shape the sandbox exposes (structural — StorageImpl-compatible). */
export interface StorageAreaLike {
  readonly length: number;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
  key(index: number): string | null;
}

/** Session-provided storage pair (RFC 0010). */
export interface SessionStorageBag {
  readonly localStorage: StorageAreaLike;
  readonly sessionStorage: StorageAreaLike;
}

/** The outcome of an event-driven run: work performed + DOM mutations. */
export interface EventDrivenRun {
  /** Microtasks drained. */
  readonly microtasks: number;
  /** Timer callbacks fired. */
  readonly timers: number;
  /** Animation frames flushed (`requestAnimationFrame` callbacks). */
  readonly frames: number;
  /** DOM mutations performed across the whole run. */
  readonly mutations: number;
  /** A top-level error from the initial synchronous script, if any. */
  readonly error: string | null;
  readonly sandbox?: Record<string, unknown>;
  readonly context?: import("node:vm").Context;
  readonly getMutations?: () => number;
  readonly drain?: () => void;
  readonly flushAsync?: () => Promise<void>;
  /** RFC 0032: terminate every dedicated worker this document spawned —
   *  worker threads survive page teardown otherwise (unref'd ≠ collected). */
  readonly disposeWorkers?: () => void;
  /**
   * RFC 0033: rasterize every live `<canvas>`'s op log to its current
   * bitmap — the paint path pulls this lazily per frame.
   */
  readonly canvasBitmaps?: () => ReadonlyMap<import("@browser-engine/ir").NodeId, import("@browser-engine/ir").DecodedImage>;
  /**
   * RFC 0011: dispatch a UI click at a DOM node — identical to `el.click()`
   * (event + activation behavior). Lets the host's hit-tested clicks honor
   * listeners/preventDefault.
   */
  readonly clickElement?: (nodeId: import("@browser-engine/ir").NodeId) => void;
  /** RFC 0013: dispatch an event at an element (iframe `load`, …). */
  readonly dispatchElementEvent?: (
    nodeId: import("@browser-engine/ir").NodeId,
    type: string,
    init?: Record<string, unknown>,
  ) => void;
  /**
   * RFC 0020: the host's UI-input synthesis surface — real pointer/mouse/
   * keyboard/focus/tab sequences through the shared dispatch machinery.
   */
  readonly ui?: {
    readonly pointerMove: (nodeId: import("@browser-engine/ir").NodeId, init?: Record<string, unknown>) => void;
    readonly click: (nodeId: import("@browser-engine/ir").NodeId, init?: Record<string, unknown>) => void;
    readonly contextMenu: (nodeId: import("@browser-engine/ir").NodeId, init?: Record<string, unknown>) => void;
    readonly dblClick: (nodeId: import("@browser-engine/ir").NodeId, init?: Record<string, unknown>) => void;
    readonly key: (detail: {
      key: string; code?: string; repeat?: boolean; location?: number;
      ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean;
    }) => void;
    readonly tab: (dir: 1 | -1) => void;
    readonly focusedId: () => import("@browser-engine/ir").NodeId | null;
  };
}

/** A minimal Promise-shaped thenable scheduled on the virtual loop's microtasks. */
class Thenable<T> {
  #value: T | undefined;
  #error: unknown;
  #settled = false;
  #failed = false;
  readonly #cbs: ((v: T) => void)[] = [];
  readonly #rcbs: ((e: unknown) => void)[] = [];
  constructor(private readonly loop: VirtualEventLoop) {}

  resolve(value: T): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#value = value;
    for (const cb of this.#cbs) this.loop.microtask(() => cb(value));
    this.#cbs.length = 0;
    this.#rcbs.length = 0;
  }

  reject(reason: unknown): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#failed = true;
    this.#error = reason;
    for (const cb of this.#rcbs) this.loop.microtask(() => cb(reason));
    this.#cbs.length = 0;
    this.#rcbs.length = 0;
  }

  then(onFulfilled: (v: T) => unknown, onRejected?: (e: unknown) => unknown): Thenable<unknown> {
    const next = new Thenable<unknown>(this.loop);
    const run = (v: T): void => {
      const result = onFulfilled(v);
      if (result instanceof Thenable) {
        result.then((r) => next.resolve(r), (e) => next.reject(e));
      } else {
        next.resolve(result);
      }
    };
    const runRejected = (e: unknown): void => {
      if (onRejected === undefined) {
        next.reject(e);
        return;
      }
      const result = onRejected(e);
      if (result instanceof Thenable) {
        result.then((r) => next.resolve(r), (e2) => next.reject(e2));
      } else {
        next.resolve(result);
      }
    };
    if (this.#settled) {
      if (this.#failed) this.loop.microtask(() => runRejected(this.#error));
      else this.loop.microtask(() => run(this.#value as T));
    } else {
      this.#cbs.push(run);
      this.#rcbs.push(runRejected);
    }
    return next;
  }

  catch(onRejected: (e: unknown) => unknown): Thenable<unknown> {
    return this.then((v) => v, onRejected);
  }

  finally(fn: () => unknown): Thenable<T> {
    const next = new Thenable<T>(this.loop);
    const run = (v: T): void => {
      fn();
      next.resolve(v);
    };
    const runRejected = (e: unknown): void => {
      fn();
      next.reject(e);
    };
    if (this.#settled) {
      if (this.#failed) this.loop.microtask(() => runRejected(this.#error));
      else this.loop.microtask(() => run(this.#value as T));
    } else {
      this.#cbs.push(run);
      this.#rcbs.push(runRejected);
    }
    return next;
  }
}

interface Timer {
  readonly id: number;
  readonly due: number;
  readonly fn: () => void;
  cancelled: boolean;
}

/** A virtual-clock event loop: microtask FIFO + due-ordered macrotask timers. */
export class VirtualEventLoop {
  readonly #microtasks: (() => void)[] = [];
  readonly #timers: Timer[] = [];
  #raf: { id: number; cb: (t: number) => void; cancelled: boolean }[] = [];
  #clock = 0;
  /**
   * Wall-clock anchor for runs whose transport is REAL (keepAlive site
   * sessions): a timer must not fire before its delay has ACTUALLY elapsed,
   * or a page's 120s chunk-load timeout fires the instant the queue is
   * otherwise empty — while the host network is still mid-flight. Purely
   * virtual runs (tests) leave this off for determinism.
   */
  readonly #realTime: boolean;
  readonly #startedAtMs: number;
  #nextTimerId = 1;
  #nextRafId = 1;
  #onFrame: ((now: number) => void) | undefined;
  #frameWork: (() => boolean) | undefined;
  #onUncaught: ((error: unknown) => void) | undefined;
  microtaskCount = 0;
  timerCount = 0;
  frameCount = 0;

  constructor(options: { realTime?: boolean } = {}) {
    this.#realTime = options.realTime === true;
    this.#startedAtMs = Date.now();
  }

  /** Real milliseconds elapsed since the loop started (0 when not real-time). */
  get #realElapsedMs(): number {
    return this.#realTime ? Date.now() - this.#startedAtMs : Number.POSITIVE_INFINITY;
  }

  /**
   * Report uncaught errors from timer/rAF callbacks without aborting the loop
   * (HTML: an exception in a timer task reports to the global error handler
   * and the task completes).
   */
  onUncaught(handler: (error: unknown) => void): void {
    this.#onUncaught = handler;
  }

  #runGuarded(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      if (this.#onUncaught === undefined) throw e;
      this.#onUncaught(e);
    }
  }

  /**
   * Register a per-frame HOOK driven by the same clock as `requestAnimationFrame`:
   * `onFrame(now)` runs at the start of every flushed frame (before the rAF
   * callbacks, matching the HTML "update the rendering" order), and `hasWork`
   * lets a frame be produced even when no rAF callback is queued (so a running
   * CSS animation keeps the clock ticking until it finishes).
   */
  onAnimationFrame(onFrame: (now: number) => void, hasWork: () => boolean): void {
    this.#onFrame = onFrame;
    this.#frameWork = hasWork;
  }

  /**
   * The loop's virtual clock in ms (0 until the first drain step; RFC 0035 —
   * media playback anchors here so `video.currentTime` advances exactly with
   * the timers the loop fires).
   */
  now(): number {
    return this.#clock;
  }

  microtask(fn: () => void): void {
    this.#microtasks.push(fn);
  }

  setTimeout(fn: () => void, delay: number): number {
    const id = this.#nextTimerId++;
    this.#timers.push({ id, due: this.#clock + Math.max(0, delay || 0), fn, cancelled: false });
    return id;
  }

  clearTimeout(id: number): void {
    const t = this.#timers.find((x) => x.id === id);
    if (t !== undefined) t.cancelled = true;
  }

  setInterval(fn: () => void, delay: number): number {
    const period = Math.max(0, delay || 0);
    const id = this.#nextTimerId++;
    const tick = (): void => {
      const current = this.#timers.find((x) => x.id === id && !x.cancelled);
      if (current === undefined) return;
      try {
        fn();
      } finally {
        if (!current.cancelled) {
          this.#timers.push({ id, due: this.#clock + period, fn: tick, cancelled: false });
        }
      }
    };
    this.#timers.push({ id, due: this.#clock + period, fn: tick, cancelled: false });
    return id;
  }

  clearInterval(id: number): void {
    for (const t of this.#timers) {
      if (t.id === id) t.cancelled = true;
    }
  }

  requestAnimationFrame(cb: (t: number) => void): number {
    const id = this.#nextRafId++;
    this.#raf.push({ id, cb, cancelled: false });
    return id;
  }

  cancelAnimationFrame(id: number): void {
    const r = this.#raf.find((x) => x.id === id);
    if (r !== undefined) r.cancelled = true;
  }

  /** Make a fresh loop-bound {@link Thenable}. */
  deferred<T>(): Thenable<T> {
    return new Thenable<T>(this);
  }

  /**
   * Drain microtasks, then either flush one ANIMATION FRAME (the queued
   * `requestAnimationFrame` callbacks, advancing the clock ~16ms) or fire the
   * earliest timer — repeating to a fixed point. The frame budget caps runaway
   * self-scheduling rAF loops (a real engine bounds them by wall-clock; we bound
   * by `maxFrames`).
   */
  drain(maxSteps = 100000, maxFrames = 1000): void {
    let steps = 0;
    for (;;) {
      while (this.#microtasks.length > 0) {
        if (steps++ > maxSteps) return;
        const fn = this.#microtasks.shift() as () => void;
        this.microtaskCount += 1;
        this.#runGuarded(fn);
      }
      const frame = this.#raf.filter((r) => !r.cancelled);
      const pending = this.#timers.filter((t) => !t.cancelled);
      const animating = this.#frameWork?.() ?? false;
      // Flush a frame when a rAF callback is queued OR a CSS animation is still
      // running — either way the frame clock must advance ~16ms.
      if ((frame.length > 0 || animating) && this.frameCount < maxFrames) {
        this.#raf = [];
        this.#clock += 16;
        this.frameCount += 1;
        // "Update the rendering": sample animations FIRST, then run rAF callbacks.
        if (steps++ > maxSteps) return;
        this.#onFrame?.(this.#clock);
        for (const r of frame) {
          if (steps++ > maxSteps) return;
          this.#runGuarded(() => r.cb(this.#clock));
        }
        continue;
      }
      if (pending.length === 0) return;
      // Fire the earliest-due timer (ties: insertion order via stable id).
      pending.sort((a, b) => (a.due !== b.due ? a.due - b.due : a.id - b.id));
      const next = pending[0] as Timer;
      if (next.due > this.#clock + this.#realElapsedMs) {
        // Wall-clock gate (real-time runs): the earliest timer is not actually
        // due yet — yield so the host can do real work (network) and re-drain.
        return;
      }
      next.cancelled = true;
      this.#clock = Math.max(this.#clock, next.due);
      this.timerCount += 1;
      if (steps++ > maxSteps) return;
      this.#runGuarded(next.fn);
    }
  }
}




// Observer globals (MutationObserver/ResizeObserver/IntersectionObserver and a
// shell PerformanceObserver) are REAL implementations installed by
// buildDocumentApi's `globals` — nothing to stub here.


function installEventTarget(sandbox: Record<string, unknown>, fetchApi?: FetchApi): void {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const addEventListener = (type: unknown, fn: unknown): void => {
    if (typeof fn !== "function") return;
    const key = String(type);
    let set = listeners.get(key);
    if (set === undefined) {
      set = new Set();
      listeners.set(key, set);
    }
    set.add(fn as (...args: unknown[]) => void);
  };
  const removeEventListener = (type: unknown, fn: unknown): void => {
    const set = listeners.get(String(type));
    if (set === undefined || typeof fn !== "function") return;
    set.delete(fn as (...args: unknown[]) => void);
  };
  const dispatchEvent = (event: unknown): boolean => {
    const type =
      event !== null && typeof event === "object" && "type" in event
        ? coerceGuestString(event.type)
        : coerceGuestString(event);
    // Host-origin events are plain objects — give them the platform event
    // surface (preventDefault honored only when cancelable, per DOM §2.9).
    let prevented = false;
    if (event !== null && typeof event === "object") {
      const ev = event as {
        preventDefault?: unknown;
        defaultPrevented?: boolean;
        cancelable?: boolean;
        returnValue?: unknown;
      };
      if (typeof ev.preventDefault !== "function") {
        ev.preventDefault = (): void => {
          if (ev.cancelable === true) {
            ev.defaultPrevented = true;
          }
        };
      }
    }
    // `window.onhashchange = fn` style property listeners fire alongside
    // addEventListener listeners (DOM §2.7 event handler attributes). A
    // non-undefined return on beforeunload-style handlers means "prompt"
    // (legacy returnValue semantics, HTML §5.11.1).
    const propHandler = sandbox[`on${type}`];
    if (typeof propHandler === "function") {
      try {
        const ret = (propHandler as (e: unknown) => unknown)(event);
        if (typeof ret === "string" || ret === false) prevented = true;
      } catch {
        // Guest/page code may throw here; swallowed by design.
      }
    }
    const set = listeners.get(type);
    if (set !== undefined) {
      for (const fn of set) {
        try {
          fn(event);
        } catch {
          // Guest/page code may throw here; swallowed by design.
        }
      }
    }
    if (event !== null && typeof event === "object") {
      const ev = event as {
        defaultPrevented?: boolean;
        returnValue?: unknown;
      };
      if (ev.defaultPrevented === true) prevented = true;
      if (ev.returnValue === false || typeof ev.returnValue === "string") {
        prevented = true;
      }
    }
    return !prevented;
  };
  sandbox["addEventListener"] = addEventListener;
  sandbox["removeEventListener"] = removeEventListener;
  sandbox["dispatchEvent"] = dispatchEvent;
  sandbox["onerror"] = null;
  sandbox["onload"] = null;
  // A static fallback only when the document API did not provide the real
  // computed-style facade (external-sandbox contexts).
  if (sandbox["getComputedStyle"] === undefined) sandbox["getComputedStyle"] = (_el?: unknown) => new Proxy(
    {
      display: "block",
      visibility: "visible",
      position: "static",
      opacity: "1",
      width: "auto",
      height: "auto",
      overflow: "visible",
      "font-size": "16px",
      color: "rgb(0, 0, 0)",
      "background-color": "rgba(0, 0, 0, 0)",
      getPropertyValue(name: unknown) {
        const key = String(name);
        const v = (this as Record<string, unknown>)[key];
        return typeof v === "string" ? v : "";
      },
    },
    {
      get: (t, prop) => {
        if (prop === "getPropertyValue") return (n: unknown) => {
          const key = String(n);
          const v = (t as Record<string, unknown>)[key];
          return typeof v === "string" ? v : "";
        };
        if (typeof prop === "string" && prop in t) return (t as Record<string, unknown>)[prop];
        return "";
      },
    },
  );
  sandbox["requestIdleCallback"] = (fn: unknown) =>
    typeof fn === "function"
      ? setTimeout(() => (fn as (d: { didTimeout: boolean; timeRemaining: () => number }) => void)({
          didTimeout: false,
          timeRemaining: () => 12,
        }), 1)
      : 0;
  sandbox["cancelIdleCallback"] = (id: unknown) => clearTimeout(Number(id));
  sandbox["scrollTo"] = () => {};
  sandbox["scroll"] = () => {};
  sandbox["innerWidth"] = 1280;
  sandbox["innerHeight"] = 800;
  sandbox["devicePixelRatio"] = 1;
  // CSSOM View §5: the `screen` object — desktop viewport dimensions, as a
  // barebones but real surface (bundles use screen.width/height for
  // responsive bootstrapping decisions).
  const screenObj = {
    width: 1280,
    height: 800,
    availWidth: 1280,
    availHeight: 800,
    availLeft: 0,
    availTop: 0,
    colorDepth: 24,
    pixelDepth: 24,
    orientation: { type: "landscape-primary", angle: 0, onchange: null },
  };
  sandbox["screen"] = screenObj;
  sandbox["outerWidth"] = 1280;
  sandbox["outerHeight"] = 800;
  sandbox["screenX"] = 0;
  sandbox["screenY"] = 0;
  sandbox["screenLeft"] = 0;
  sandbox["screenTop"] = 0;
  const NodeCtor = function Node() {} as unknown as new () => object;
  const ElementCtor = function Element() {} as unknown as new () => object;
  Object.setPrototypeOf(ElementCtor.prototype, (NodeCtor as unknown as { prototype: object }).prototype);
  const HTMLElementCtor = function HTMLElement() {} as unknown as new () => object;
  Object.setPrototypeOf(HTMLElementCtor.prototype, (ElementCtor as unknown as { prototype: object }).prototype);
  const SVGElementCtor = function SVGElement() {} as unknown as new () => object;
  Object.setPrototypeOf(SVGElementCtor.prototype, (ElementCtor as unknown as { prototype: object }).prototype);
  const DocumentCtor = function Document() {} as unknown as new () => object;
  Object.setPrototypeOf(DocumentCtor.prototype, (NodeCtor as unknown as { prototype: object }).prototype);
  const DocumentFragmentCtor = function DocumentFragment() {} as unknown as new () => object;
  Object.setPrototypeOf(DocumentFragmentCtor.prototype, (NodeCtor as unknown as { prototype: object }).prototype);
  const EventCtor = function Event(this: { type: string; bubbles: boolean; cancelable: boolean; defaultPrevented: boolean; preventDefault: () => void; stopPropagation: () => void; stopImmediatePropagation: () => void }, type: unknown) {
    this.type = String(type);
    this.bubbles = false;
    this.cancelable = false;
    this.defaultPrevented = false;
    this.preventDefault = () => {
      this.defaultPrevented = true;
    };
    this.stopPropagation = () => {};
    this.stopImmediatePropagation = () => {};
  };
  const CustomEventCtor = function CustomEvent(this: { type: string; detail: unknown; bubbles: boolean; cancelable: boolean; defaultPrevented: boolean; preventDefault: () => void; stopPropagation: () => void; stopImmediatePropagation: () => void }, type: unknown, init?: unknown) {
    EventCtor.call(this, type);
    this.detail = init && typeof init === "object" ? (init as { detail?: unknown }).detail : undefined;
  };
  const ImageCtor = function Image(this: { width: number; height: number; src: string; onload: null; onerror: null; complete: boolean }, w?: unknown, h?: unknown) {
    this.width = Number(w) || 0;
    this.height = Number(h) || 0;
    this.src = "";
    this.onload = null;
    this.onerror = null;
    this.complete = false;
  };
  if (sandbox["Node"] === undefined) sandbox["Node"] = NodeCtor;
  if (sandbox["Element"] === undefined) sandbox["Element"] = ElementCtor;
  if (sandbox["HTMLElement"] === undefined) sandbox["HTMLElement"] = HTMLElementCtor;
  if (sandbox["SVGElement"] === undefined) sandbox["SVGElement"] = SVGElementCtor;
  sandbox["MathMLElement"] = function MathMLElement() {};
  if (sandbox["Document"] === undefined) sandbox["Document"] = DocumentCtor;
  if (sandbox["DocumentFragment"] === undefined) sandbox["DocumentFragment"] = DocumentFragmentCtor;
  // RFC 0020: real typed event classes — guard-installed so the
  // document API's realm constructors (which carry the dispatch hooks)
  // always win when present.
  if (sandbox["Event"] === undefined) sandbox["Event"] = EventCtor;
  if (sandbox["CustomEvent"] === undefined) sandbox["CustomEvent"] = CustomEventCtor;
  if (sandbox["UIEvent"] === undefined) sandbox["UIEvent"] = GuestUIEvent;
  if (sandbox["MouseEvent"] === undefined) sandbox["MouseEvent"] = GuestMouseEvent;
  if (sandbox["PointerEvent"] === undefined) sandbox["PointerEvent"] = GuestPointerEvent;
  if (sandbox["KeyboardEvent"] === undefined) sandbox["KeyboardEvent"] = GuestKeyboardEvent;
  if (sandbox["FocusEvent"] === undefined) sandbox["FocusEvent"] = GuestFocusEvent;
  if (sandbox["InputEvent"] === undefined) sandbox["InputEvent"] = GuestInputEvent;
  if (sandbox["WheelEvent"] === undefined) sandbox["WheelEvent"] = GuestWheelEvent;
  if (sandbox["CompositionEvent"] === undefined) sandbox["CompositionEvent"] = GuestCompositionEvent;
  sandbox["Image"] = ImageCtor;
  sandbox["HTMLImageElement"] = ImageCtor;
  sandbox["XMLHttpRequest"] = function XMLHttpRequest(this: {
    readyState: number;
    status: number;
    responseText: string;
    open: () => void;
    send: () => void;
  }) {
    this.readyState = 0;
    this.status = 0;
    this.responseText = "";
    this.open = () => {};
    this.send = () => {};
  };
  sandbox["DOMParser"] = function DOMParser(this: { parseFromString: () => object }) {
    this.parseFromString = () => ({
      documentElement: null,
      body: null,
      head: null,
      querySelector: () => null,
      querySelectorAll: () => [],
    });
  };
  sandbox["CSS"] = {
    supports: () => false,
    escape: (s: unknown) => String(s),
  };
  if (sandbox["TextEncoder"] === undefined) sandbox["TextEncoder"] = TextEncoder;
  if (sandbox["TextDecoder"] === undefined) sandbox["TextDecoder"] = TextDecoder;
  if (sandbox["URL"] === undefined) sandbox["URL"] = URL;
  if (sandbox["URLSearchParams"] === undefined) sandbox["URLSearchParams"] = URLSearchParams;
  if (sandbox["AbortController"] === undefined) sandbox["AbortController"] = AbortController;
  if (sandbox["AbortSignal"] === undefined) sandbox["AbortSignal"] = AbortSignal;
  // Fetch API primitives (Fetch §5, RFC 0019): the guest realm's OWN
  // spec-shaped classes — `instanceof` works, `Response.clone()`/`bodyUsed`/
  // `body` streams are real, and `fetch()` returns true `Response` instances.
  // The caller supplies the per-document api bundle so sandbox classes and
  // the runner's fetch impl share ONE class set (`instanceof` must hold for
  // guest-constructed Requests passed back into fetch).
  const api = fetchApi ?? makeFetchApi("about:blank");
  if (sandbox["Headers"] === undefined) sandbox["Headers"] = api.Headers;
  if (sandbox["Request"] === undefined) sandbox["Request"] = api.Request;
  if (sandbox["Response"] === undefined) sandbox["Response"] = api.Response;
  if (sandbox["ReadableStream"] === undefined) sandbox["ReadableStream"] = api.ReadableStream;
  if (sandbox["FormData"] === undefined) sandbox["FormData"] = FormData;
  if (sandbox["Blob"] === undefined) sandbox["Blob"] = makeBlobClass();
  if (sandbox["File"] === undefined) sandbox["File"] = makeFileClass();
  if (sandbox["URL.createObjectURL"] === undefined) {
    (URL as unknown as { createObjectURL?: unknown }).createObjectURL = (blob: unknown): string =>
      globalObjectUrls.createObjectURL(blob);
    (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL = (url: unknown): void =>
      globalObjectUrls.revokeObjectURL(url);
  }
}


/**
 * XMLHttpRequest (XHR §4, RFC 0019) over the guest `fetch` — the same
 * transport every fetch call uses, so redirects/cookies/network errors are
 * shared behavior. Spec-correct event semantics: a received HTTP response
 * (ANY status — 404 included) completes with `load`; `error` is reserved
 * for transport failure; `abort`/`timeout` are their own events.
 *
 * Real surface: `getAllResponseHeaders`/`getResponseHeader` read the
 * response's enumerable header list; `responseType` decodes
 * ""/text/json/arraybuffer/blob; `abort()` cancels the in-flight fetch;
 * `timeout` rejects via AbortSignal.timeout; `upload` exists as an
 * XHRUpload-shaped target (no synthetic progress — honest).
 */
export function installXMLHttpRequest(
  sandbox: Record<string, unknown>,
  doFetch: (input: unknown, init?: unknown) => Promise<object>,
  baseUrl: string,
): void {
  // DOMException instances thrown to guest code must be the realm's own
  // (installed on the sandbox after vm context creation) so guest
  // `instanceof DOMException` holds.
  const domError = (message: string, name: string): Error =>
    new ((sandbox["DOMException"] as typeof DOMException | undefined) ?? DOMException)(
      message,
      name,
    );
  type XhrSelf = {
    readyState: number;
    status: number;
    statusText: string;
    responseText: string;
    responseXML: object | null;
    response: unknown;
    responseURL: string;
    responseType: string;
    responseUrl: string;
    withCredentials: boolean;
    timeout: number;
    upload: object;
    onreadystatechange: ((this: XhrSelf, ev?: unknown) => void) | null;
    onload: ((this: XhrSelf, ev?: unknown) => void) | null;
    onerror: ((this: XhrSelf, ev?: unknown) => void) | null;
    onloadend: ((this: XhrSelf, ev?: unknown) => void) | null;
    onloadstart: ((this: XhrSelf, ev?: unknown) => void) | null;
    onabort: ((this: XhrSelf, ev?: unknown) => void) | null;
    ontimeout: ((this: XhrSelf, ev?: unknown) => void) | null;
    onprogress: ((this: XhrSelf, ev?: unknown) => void) | null;
    open: (method: unknown, url: unknown, async?: unknown, user?: unknown, password?: unknown) => void;
    setRequestHeader: (name: unknown, value: unknown) => void;
    overrideMimeType: (mime: unknown) => void;
    send: (body?: unknown) => void;
    abort: () => void;
    getAllResponseHeaders: () => string;
    getResponseHeader: (name: unknown) => string | null;
    addEventListener: (type: unknown, fn: unknown) => void;
    removeEventListener: (type: unknown, fn: unknown) => void;
    dispatchEvent: (ev: unknown) => boolean;
  };
  const Ctor = function XMLHttpRequest(this: XhrSelf) {
    // Aliased once here because `self` is captured across the async XHR
    // callbacks below, where `this` would be unbound.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    self.readyState = 0;
    self.status = 0;
    self.statusText = "";
    self.responseText = "";
    self.responseXML = null;
    self.response = "";
    self.responseURL = "";
    self.responseUrl = "";
    self.responseType = "";
    self.withCredentials = false;
    self.timeout = 0;
    self.onreadystatechange = null;
    self.onload = null;
    self.onerror = null;
    self.onloadend = null;
    self.onloadstart = null;
    self.onabort = null;
    self.ontimeout = null;
    self.onprogress = null;
    let method = "GET";
    let url = "";
    const headers: Record<string, string> = {};
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    let sendFlag = false;
    let abortController: AbortController | null = null;
    let responseHeaders:
      | { get(n: unknown): string | null; entries?: () => Iterable<[string, string]> }
      | null = null;
    let mimeOverride: string | null = null;
    const uploadListeners = new Map<string, Set<(...args: unknown[]) => void>>();
    // `upload` is an XMLHttpRequestUpload — a real event target surface; we
    // never fabricate progress bytes for it.
    self.upload = {
      addEventListener: (type: unknown, fn: unknown) => {
        if (typeof fn !== "function") return;
        const key = String(type);
        let set = uploadListeners.get(key);
        if (set === undefined) {
          set = new Set();
          uploadListeners.set(key, set);
        }
        set.add(fn as (...args: unknown[]) => void);
      },
      removeEventListener: (type: unknown, fn: unknown) => {
        const set = uploadListeners.get(String(type));
        if (set === undefined || typeof fn !== "function") return;
        set.delete(fn as (...args: unknown[]) => void);
      },
      onloadstart: null,
      onprogress: null,
      onload: null,
      onloadend: null,
      onerror: null,
      onabort: null,
      ontimeout: null,
    };
    const emit = (type: string): void => {
      const prop = ({
        readystatechange: self.onreadystatechange,
        load: self.onload,
        error: self.onerror,
        loadend: self.onloadend,
        loadstart: self.onloadstart,
        abort: self.onabort,
        timeout: self.ontimeout,
        progress: self.onprogress,
      } as Record<string, ((this: XhrSelf, ev?: unknown) => void) | null>)[type];
      const ev = { type, target: self, currentTarget: self };
      if (typeof prop === "function") {
        try {
          prop.call(self, ev);
        } catch {
          // Guest/page code may throw here; swallowed by design.
        }
      }
      const set = listeners.get(type);
      if (set !== undefined) {
        for (const fn of set) {
          try {
            fn.call(self, ev);
          } catch {
            // Guest/page code may throw here; swallowed by design.
          }
        }
      }
    };
    const emitUpload = (type: string): void => {
      const up = self.upload as Record<string, unknown>;
      const prop = up[`on${type}`];
      const ev = { type, target: self.upload, currentTarget: self.upload };
      if (typeof prop === "function") {
        try {
          (prop as (ev: unknown) => void).call(self.upload, ev);
        } catch {
          // Guest/page code may throw here; swallowed by design.
        }
      }
      const set = uploadListeners.get(type);
      if (set !== undefined) {
        for (const fn of set) {
          try {
            fn.call(self.upload, ev);
          } catch {
            // Guest/page code may throw here; swallowed by design.
          }
        }
      }
    };
    self.open = (m: unknown, u: unknown, async?: unknown, _user?: unknown, _password?: unknown) => {
      method = (m === undefined || m === null ? "GET" : coerceGuestString(m)).toUpperCase();
      const raw = coerceGuestString(u);
      try {
        url = new URL(raw, baseUrl).href;
      } catch {
        url = raw;
      }
      if (async === false) {
        throw domError("Synchronous XMLHttpRequest is not supported", "InvalidAccessError");
      }
      sendFlag = false;
      abortController = null;
      responseHeaders = null;
      self.readyState = 1;
      self.status = 0;
      self.statusText = "";
      self.responseText = "";
      self.response = "";
      self.responseURL = "";
      self.responseUrl = "";
      emit("readystatechange");
    };
    self.setRequestHeader = (name: unknown, value: unknown) => {
      if (self.readyState !== 1 || sendFlag) {
        throw domError("setRequestHeader must be called after open() and before send()", "InvalidStateError");
      }
      headers[String(name)] = String(value);
    };
    self.overrideMimeType = (mime: unknown) => {
      mimeOverride = coerceGuestString(mime);
    };
    self.send = (body?: unknown) => {
      if (self.readyState !== 1 || sendFlag) {
        throw domError("send() requires readyState OPENED", "InvalidStateError");
      }
      sendFlag = true;
      abortController = new AbortController();
      const ctrl = abortController;
      let timedOut = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      if (self.timeout > 0) {
        timeoutId = setTimeout(() => {
          timedOut = true;
          ctrl.abort();
        }, self.timeout);
      }
      self.readyState = 2;
      emit("readystatechange");
      emit("loadstart");
      if (body !== undefined && body !== null) emitUpload("loadstart");
      const init: Record<string, unknown> = { method, headers, signal: ctrl.signal };
      // RFC 0028: XHR is a CORS-mode fetch; withCredentials maps to
      // credentials "include" (XHR §"the send() method" + Fetch §4.2).
      init["mode"] = "cors";
      init["credentials"] = self.withCredentials ? "include" : "same-origin";
      if (body !== undefined && body !== null && method !== "GET" && method !== "HEAD") {
        init["body"] = body;
      }
      const settle = (): void => {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      };
      void Promise.resolve(doFetch(url, init))
        .then(async (res) => {
          if (!sendFlag) return; // aborted meanwhile
          const status = Number((res as { status?: unknown }).status ?? 0);
          const rawResUrl = (res as { url?: unknown }).url;
          const resUrl = rawResUrl === undefined || rawResUrl === null ? url : coerceGuestString(rawResUrl);
          const resHeaders = (res as { headers?: unknown }).headers;
          responseHeaders =
            typeof resHeaders === "object" && resHeaders !== null
              ? (resHeaders as { get(n: unknown): string | null; entries?: () => Iterable<[string, string]> })
              : null;
          self.status = status;
          self.statusText = "";
          self.responseURL = resUrl;
          self.responseUrl = resUrl;
          let text = "";
          let parsed: unknown = "";
          const rtype = self.responseType;
          // RFC 0040: when the fetch body is a live stream, XHR reads it
          // chunk-wise — readyState 3 + a ProgressEvent per wire chunk with
          // real loaded/total; responseText tracks the prefix as it lands.
          const liveBody = (res as { body?: unknown }).body;
          const canStream =
            liveBody !== null &&
            liveBody !== undefined &&
            typeof (liveBody as { getReader?: unknown }).getReader === "function";
          if (canStream && sendFlag) {
            const totalHeader = responseHeaders?.get("content-length");
            const total = totalHeader !== null && totalHeader !== undefined ? Number(totalHeader) : NaN;
            const reader = (liveBody as { getReader(): { read(): Promise<{ value?: Uint8Array; done: boolean }> } }).getReader();
            const parts: Uint8Array[] = [];
            let loaded = 0;
            const dec = new TextDecoder();
            const textParts: string[] = [];
            for (;;) {
              if (!sendFlag) {
                // abort() mid-body — cancel the wire, drop the load path.
                void (reader as { cancel?: (r?: unknown) => Promise<void> }).cancel?.("aborted");
                break;
              }
              const { value, done } = await reader.read();
              if (done) break;
              if (value === undefined) continue;
              parts.push(value);
              loaded += value.byteLength;
              textParts.push(dec.decode(value, { stream: true }));
              if (rtype === "" || rtype === "text") {
                self.responseText = textParts.join("");
                self.response = self.responseText;
              }
              self.readyState = 3;
              emit("readystatechange");
              const loadedEv = loaded;
              const totalEv = Number.isFinite(total) ? total : 0;
              const computable = Number.isFinite(total);
              // ProgressEvent shape: listeners read ev.loaded/total.
              const ev = {
                type: "progress",
                target: self,
                currentTarget: self,
                loaded: loadedEv,
                total: totalEv,
                lengthComputable: computable,
              };
              if (typeof self.onprogress === "function") {
                try {
                  self.onprogress.call(self, ev);
                } catch {
                  // Guest/page code may throw here; swallowed by design.
                }
              }
              const pset = listeners.get("progress");
              if (pset !== undefined) {
                for (const fn of pset) {
                  try {
                    fn.call(self, ev);
                  } catch {
                    // Guest/page code may throw here; swallowed by design.
                  }
                }
              }
            }
            if (!sendFlag) return; // aborted
            textParts.push(dec.decode());
            const all = new Uint8Array(loaded);
            let off = 0;
            for (const p of parts) {
              all.set(p, off);
              off += p.byteLength;
            }
            text = textParts.join("");
            if (rtype === "arraybuffer") {
              parsed = all.buffer.slice(0, all.byteLength);
            } else if (rtype === "blob") {
              const BlobCtor = makeBlobClass();
              parsed = new BlobCtor([all], { type: responseHeaders?.get("content-type") ?? "" });
            } else if (rtype === "json") {
              try {
                parsed = JSON.parse(text) as unknown;
              } catch {
                parsed = null;
              }
            } else {
              parsed = text;
            }
          } else if (rtype === "arraybuffer" || rtype === "blob") {
            const abFn = (res as { arrayBuffer?: unknown }).arrayBuffer;
            const buf = typeof abFn === "function" ? await (abFn as () => Promise<ArrayBuffer>).call(res) : new ArrayBuffer(0);
            if (rtype === "arraybuffer") parsed = buf;
            else {
              const BlobCtor = makeBlobClass();
              parsed = new BlobCtor([buf], { type: responseHeaders?.get("content-type") ?? "" });
            }
          } else {
            const textFn = (res as { text?: unknown }).text;
            if (typeof textFn === "function") {
              text = String(await (textFn as () => Promise<unknown>).call(res));
            }
            if (rtype === "json") {
              try {
                parsed = JSON.parse(text) as unknown;
              } catch {
                parsed = null;
              }
            } else {
              parsed = text;
            }
          }
          // MIME override applies to the text/json decode path (charset is
          // UTF-8 throughout — the engine's single decoding boundary).
          void mimeOverride;
          if (!sendFlag) return;
          self.responseText = rtype === "" || rtype === "text" ? text : "";
          if (!sendFlag) return;
          self.response = parsed;
          self.readyState = 3;
          emit("readystatechange");
          emit("progress");
          self.readyState = 4;
          emit("readystatechange");
          // Spec: ANY received HTTP response completes with `load` — a 404 is
          // a successful completion, not a network error.
          emit("load");
          if (body !== undefined && body !== null) {
            emitUpload("load");
            emitUpload("loadend");
          }
          emit("loadend");
          settle();
        })
        .catch(() => {
          settle();
          if (!sendFlag) return;
          if (timedOut) {
            self.readyState = 4;
            self.response = "";
            self.responseText = "";
            emit("readystatechange");
            emit("timeout");
            emit("loadend");
            return;
          }
          // Aborted via abort() — the abort() path already emitted.
          self.status = 0;
          self.statusText = "";
          self.responseText = "";
          self.response = "";
          self.readyState = 4;
          emit("readystatechange");
          emit("error");
          emit("loadend");
        });
    };
    self.abort = () => {
      if (!sendFlag) return;
      sendFlag = false;
      abortController?.abort();
      self.readyState = 0;
      emit("abort");
      emit("loadend");
    };
    self.getAllResponseHeaders = () => {
      if (responseHeaders === null) return "";
      const h = responseHeaders;
      if (typeof h.entries === "function") {
        const lines: string[] = [];
        for (const [k, v] of h.entries()) lines.push(`${k}: ${v}`);
        return lines.length > 0 ? lines.join("\r\n") + "\r\n" : "";
      }
      // Structural headers (older stubs): probe the common names.
      const out: string[] = [];
      for (const name of ["content-type", "content-length", "etag", "last-modified", "cache-control", "expires", "date", "server", "location", "set-cookie"]) {
        const v = h.get(name);
        if (v !== null) out.push(`${name}: ${v}`);
      }
      return out.length > 0 ? out.join("\r\n") + "\r\n" : "";
    };
    self.getResponseHeader = (name: unknown) =>
      responseHeaders === null ? null : responseHeaders.get(name);
    self.addEventListener = (type: unknown, fn: unknown) => {
      if (typeof fn !== "function") return;
      const key = String(type);
      let set = listeners.get(key);
      if (set === undefined) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(fn as (...args: unknown[]) => void);
    };
    self.removeEventListener = (type: unknown, fn: unknown) => {
      const set = listeners.get(String(type));
      if (set === undefined || typeof fn !== "function") return;
      set.delete(fn as (...args: unknown[]) => void);
    };
    self.dispatchEvent = (ev: unknown) => {
      const t = (ev as { type?: unknown })?.type;
      emit(typeof t === "string" ? t : coerceGuestString(t ?? ""));
      return true;
    };
  } as unknown as {
    new (): XhrSelf;
    UNSENT: number;
    OPENED: number;
    HEADERS_RECEIVED: number;
    LOADING: number;
    DONE: number;
  };
  Ctor.UNSENT = 0;
  Ctor.OPENED = 1;
  Ctor.HEADERS_RECEIVED = 2;
  Ctor.LOADING = 3;
  Ctor.DONE = 4;
  sandbox["XMLHttpRequest"] = Ctor;
}


/**
 * RFC 0010: install `location`/`history`/`localStorage`/`sessionStorage`.
 * With a session host they are LIVE objects delegating to it (real
 * navigations queue as intents; pushState's URL update is synchronously
 * visible). Without one — harness/WPT paths — they are the historical
 * static stubs. Shared by the classic and module script runners so both
 * script kinds observe identical navigation semantics.
 */
export function installNavigationGlobals(
  sandbox: Record<string, unknown>,
  href: string,
  host?: NavigationHost,
  storage?: SessionStorageBag,
): void {
  const location: Record<string, unknown> = {};
  const urlParts = (raw: string): Record<string, string> => {
    try {
      const u = new URL(raw);
      return {
        protocol: u.protocol,
        host: u.host,
        hostname: u.hostname,
        port: u.port,
        pathname: u.pathname,
        search: u.search,
        hash: u.hash,
        origin: u.origin,
      };
    } catch {
      return {
        protocol: "",
        host: "",
        hostname: "",
        port: "",
        pathname: "",
        search: "",
        hash: "",
        origin: "",
      };
    }
  };
  if (host !== undefined) {
    const live = host;
    for (const part of ["protocol", "host", "hostname", "port", "pathname", "search", "origin"]) {
      Object.defineProperty(location, part, {
        get: () => urlParts(live.currentUrl)[part] ?? "",
        enumerable: true,
      });
    }
    Object.defineProperty(location, "href", {
      get: () => live.currentUrl,
      set: (v: unknown) => live.assign(String(v)),
      enumerable: true,
    });
    Object.defineProperty(location, "hash", {
      get: () => urlParts(live.currentUrl)["hash"] ?? "",
      set: (v: unknown) => live.setHash(String(v)),
      enumerable: true,
    });
    location["toString"] = () => live.currentUrl;
    location["assign"] = (u: unknown) => live.assign(String(u));
    location["replace"] = (u: unknown) => live.replace(String(u));
    location["reload"] = () => live.reload();
  } else {
    const parts = urlParts(href);
    for (const [k, v] of Object.entries(parts)) location[k] = v;
    location["href"] = href;
    location["toString"] = () => href;
    location["assign"] = (_u: unknown) => {};
    location["replace"] = (_u: unknown) => {};
    location["reload"] = () => {};
  }
  const history: Record<string, unknown> = {};
  if (host !== undefined) {
    const live = host;
    Object.defineProperty(history, "length", {
      get: () => live.historyLength,
      enumerable: true,
    });
    Object.defineProperty(history, "state", {
      get: () => live.currentState,
      enumerable: true,
    });
    Object.defineProperty(history, "scrollRestoration", {
      get: () => live.scrollRestoration,
      set: (v: unknown) => {
        if (v === "auto" || v === "manual") live.scrollRestoration = v;
      },
      enumerable: true,
    });
    history["back"] = () => live.back();
    history["forward"] = () => live.forward();
    history["go"] = (n?: unknown) => live.go(Number(n) || 0);
    // pushState's URL arg is optional in the spec (omitted ⇒ current URL).
    const toUrlArg = (u: unknown): string | null => {
      if (u === undefined || u === null) return null;
      if (typeof u === "string") return u;
      if (typeof u === "number" || typeof u === "boolean" || typeof u === "bigint") return String(u);
      const s = (u as { toString?: () => unknown }).toString?.();
      return typeof s === "string" ? s : null;
    };
    history["pushState"] = (s?: unknown, _t?: unknown, u?: unknown) =>
      live.pushState(s, toUrlArg(u));
    history["replaceState"] = (s?: unknown, _t?: unknown, u?: unknown) =>
      live.replaceState(s, toUrlArg(u));
  } else {
    Object.assign(history, {
      length: 1,
      state: null,
      scrollRestoration: "auto",
      back: () => {},
      forward: () => {},
      go: (_n?: unknown) => {},
      pushState: (_s?: unknown, _t?: unknown, _u?: unknown) => {},
      replaceState: (_s?: unknown, _t?: unknown, _u?: unknown) => {},
    });
  }
  // RFC 0010: session-injected storage survives navigation; without a session
  // the historical per-boot memory stores remain (harness/WPT paths).
  const localStorage = storage?.localStorage ?? createMemoryStorage();
  const sessionStorage = storage?.sessionStorage ?? createMemoryStorage();
  sandbox["location"] = location;
  sandbox["history"] = history;
  sandbox["localStorage"] = localStorage;
  sandbox["sessionStorage"] = sessionStorage;
  // `window.open` — synchronous per spec: the return value is a WindowProxy
  // (or null for noopener/remote tabs), never a promise.
  if (host !== undefined) {
    const live = host;
    const toStr = (v: unknown): string | undefined =>
      v === undefined || v === null
        ? undefined
        : typeof v === "string"
          ? v
          : typeof v === "number" || typeof v === "boolean" || typeof v === "bigint"
            ? String(v)
            : undefined;
    sandbox["open"] = (u?: unknown, t?: unknown, f?: unknown): unknown =>
      live.openWindow?.(toStr(u), toStr(t), toStr(f)) ?? null;
    // `window.close()` — the host silently ignores it on non-script-opened
    // tabs (spec: only script-closable contexts may self-close).
    sandbox["close"] = (): void => live.closeWindow?.();
    // `window.opener` — a REPLY proxy to the opener tab (the live context
    // lives in another worker; only postMessage crosses). null when the tab
    // has no opener or was opened with noopener/noreferrer.
    const openerTabId = live.openerTabId;
    sandbox["opener"] =
      openerTabId === undefined || openerTabId === null
        ? null
        : {
            postMessage: (data: unknown, targetOrigin?: unknown): void =>
              live.postMessageRemote?.(
                openerTabId,
                data,
                typeof targetOrigin === "string" ? targetOrigin : null,
              ),
            focus: (): void => live.focusRemote?.(openerTabId),
            closed: false,
          };
    // `window.focus()` routes to the tab strip; `window.blur()` is an honest
    // no-op — there is no chrome focus model to move away to.
    sandbox["focus"] = (): void => live.focusWindow?.();
    sandbox["blur"] = (): void => {};
  }
}

function installBrowserGlobals(
  sandbox: Record<string, unknown>,
  href: string,
  consoleCapture?: (level: string, parts: string[]) => void,
  host?: NavigationHost,
  storage?: SessionStorageBag,
  fetchApi?: FetchApi,
  isolation?: DocumentIsolation,
  serviceWorker?: object,
): FetchApi {
  const mediaPreferences = createMediaPreferences();
  const pageMedia = { type: "screen" as const, widthPx: 1280, heightPx: 800, resolutionDppx: 1 };
  const navigator = {
    userAgent: BROWSER_USER_AGENT,
    appName: "Netscape",
    appVersion: "5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    appCodeName: "Mozilla",
    product: "Gecko",
    productSub: "20030107",
    vendor: "Google Inc.",
    vendorSub: "",
    language: "zh-CN",
    languages: ["zh-CN", "zh", "en"],
    platform: "MacIntel",
    hardwareConcurrency: 8,
    maxTouchPoints: 0,
    cookieEnabled: true,
    onLine: true,
    webdriver: false,
    doNotTrack: null,
    pdfViewerEnabled: true,
    javaEnabled: () => false,
    sendBeacon: () => true,
    // RFC 0034: real container when a registry is wired, else undefined
    // (the honest absence — pages feature-detect this member).
    ...(serviceWorker !== undefined ? { serviceWorker } : {}),
    preferences: mediaPreferences.api,
  };
  // RFC 0031: `crossOriginIsolated` + `originAgentCluster` — read-only globals
  // off the document's parsed isolation state (boot runs before scripts).
  sandbox["crossOriginIsolated"] = isolation?.crossOriginIsolated ?? false;
  sandbox["originAgentCluster"] = isolation?.originAgentCluster ?? false;
  // `isSecureContext` — potentially-trustworthy origin (Secure Contexts
  // §3.2); COOP/COEP isolation doesn't create it but implies it in practice.
  sandbox["isSecureContext"] = isPotentiallyTrustworthyUrl(href);
  installNavigationGlobals(sandbox, href, host, storage);
  sandbox["window"] = sandbox;
  sandbox["self"] = sandbox;
  sandbox["globalThis"] = sandbox;
  sandbox["top"] = sandbox;
  sandbox["parent"] = sandbox;
  sandbox["frames"] = sandbox;
  sandbox["navigator"] = navigator;
  // Console API (Console §1): guest output is CAPTURED into a bounded ring
  // buffer (survivable diagnostics; DevTools-parity) — never printed, never
  // dropped silently. Errors and warnings are kept even past the cap.
  const consoleLog: { level: string; message: string }[] = [];
  sandbox["__consoleLog"] = consoleLog;
  const formatArgs = (args: unknown[]): string =>
    args
      .map((a) => {
        if (typeof a === "string") return a;
        if (typeof a === "object" && a !== null && "message" in a) {
          // Cross-realm Error: instanceof fails across vm boundaries, so
          // duck-type on the message member (name when present). Include the
          // first stack frame when the guest preserved one — site bundles
          // strip stacks at runtime, so capture whatever survives.
          const name = (a as { name?: unknown }).name;
          const message = String((a as { message?: unknown }).message);
          const label = typeof name === "string" && name !== "" ? `${name}: ${message}` : message;
          const stack = (a as { stack?: unknown }).stack;
          const firstFrame =
            typeof stack === "string"
              ? (stack.split("\n").find((l) => l.includes("at ")) ?? "").trim()
              : "";
          return firstFrame !== "" ? `${label} :: ${firstFrame.slice(0, 160)}` : label;
        }
        if (typeof a === "object" && a !== null) {
          try {
            return JSON.stringify(a) ?? "[object]";
          } catch {
            return "[unserializable]";
          }
        }
        if (typeof a === "symbol" || typeof a === "function") {
          return a.toString();
        }
        return String(a);
      })
      .join(" ");
  const record = (level: string): ((...args: unknown[]) => void) => {
    return (...args: unknown[]) => {
      const message = formatArgs(args);
      if (level === "error" || level === "warn") {
        if (consoleLog.length >= 200) consoleLog.splice(0, consoleLog.length - 199);
      } else if (consoleLog.length >= 200) {
        return;
      }
      consoleLog.push({ level, message });
    };
  };
  const quietConsole = {
    log: record("log"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    debug: record("debug"),
    trace: record("trace"),
    dir: record("log"),
    table: record("log"),
    group: record("group"),
    groupEnd: record("group"),
    groupCollapsed: record("group"),
    time: record("time"),
    timeEnd: record("time"),
    assert: record("assert"),
    clear: () => {
      consoleLog.length = 0;
    },
    count: record("count"),
    countReset: record("count"),
  };
  sandbox["console"] = quietConsole;
  if (consoleCapture !== undefined) {
    sandbox["__consoleSink"] = (level: string, parts: string[]): void => consoleCapture(level, parts);
  }
  sandbox["atob"] = (data: unknown) => Buffer.from(String(data), "base64").toString("binary");
  sandbox["btoa"] = (data: unknown) => Buffer.from(String(data), "binary").toString("base64");
  const navStart = Date.now() - 1000;
  const navigationEntry = {
    name: href,
    entryType: "navigation",
    startTime: 0,
    duration: 1000,
    initiatorType: "navigation",
    nextHopProtocol: "h2",
    workerStart: 0,
    redirectStart: 0,
    redirectEnd: 0,
    fetchStart: 100,
    domainLookupStart: 110,
    domainLookupEnd: 120,
    connectStart: 130,
    connectEnd: 140,
    secureConnectionStart: 135,
    requestStart: 150,
    responseStart: 200,
    responseEnd: 250,
    transferSize: 0,
    encodedBodySize: 0,
    decodedBodySize: 0,
    serverTiming: [],
    unloadEventStart: 0,
    unloadEventEnd: 0,
    domInteractive: 500,
    domContentLoadedEventStart: 600,
    domContentLoadedEventEnd: 610,
    domComplete: 700,
    loadEventStart: 800,
    loadEventEnd: 900,
    type: "navigate",
    redirectCount: 0,
  };
  const paintEntries = [
    { name: "first-paint", entryType: "paint", startTime: 120, duration: 0 },
    { name: "first-contentful-paint", entryType: "paint", startTime: 180, duration: 0 },
  ];
  const lcpEntries = [
    {
      name: "",
      entryType: "largest-contentful-paint",
      startTime: 320,
      duration: 0,
      size: 12000,
      renderTime: 320,
      loadTime: 300,
      id: "",
      url: "",
      element: null,
    },
  ];
  sandbox["performance"] = {
    now: () => performance.now(),
    timeOrigin: navStart,
    timing: {
      navigationStart: navStart,
      unloadEventStart: 0,
      unloadEventEnd: 0,
      redirectStart: 0,
      redirectEnd: 0,
      fetchStart: navStart + 100,
      domainLookupStart: navStart + 110,
      domainLookupEnd: navStart + 120,
      connectStart: navStart + 130,
      connectEnd: navStart + 140,
      secureConnectionStart: navStart + 135,
      requestStart: navStart + 150,
      responseStart: navStart + 200,
      responseEnd: navStart + 250,
      domLoading: navStart + 300,
      domInteractive: navStart + 500,
      domContentLoadedEventStart: navStart + 600,
      domContentLoadedEventEnd: navStart + 610,
      domComplete: navStart + 700,
      loadEventStart: navStart + 800,
      loadEventEnd: navStart + 900,
    },
    getEntries: () => [navigationEntry, ...paintEntries, ...lcpEntries],
    getEntriesByType: (t: unknown) => {
      const type = coerceGuestString(t);
      if (type === "navigation") return [navigationEntry];
      if (type === "paint") return paintEntries.slice();
      if (type === "largest-contentful-paint") return lcpEntries.slice();
      if (type === "resource") return [];
      return [];
    },
    getEntriesByName: (name: unknown, type?: unknown) => {
      const n = coerceGuestString(name);
      const all = [navigationEntry, ...paintEntries, ...lcpEntries];
      return all.filter((e) => e.name === n && (type === undefined || e.entryType === coerceGuestString(type)));
    },
    mark: () => {},
    measure: () => {},
    clearMarks: () => {},
    clearMeasures: () => {},
  };
  sandbox["matchMedia"] = createMatchMedia(() => mediaPreferences.environment(pageMedia));
  sandbox["CSS"] = CSS;
  if (sandbox["setInterval"] === undefined) {
    sandbox["setInterval"] = (fn: unknown, delay?: unknown) =>
      typeof fn === "function" ? setInterval(fn as () => void, Number(delay) || 0) : 0;
  }
  if (sandbox["clearInterval"] === undefined) {
    sandbox["clearInterval"] = (id: unknown) => clearInterval(Number(id));
  }
  if (sandbox["setTimeout"] === undefined) {
    sandbox["setTimeout"] = (fn: unknown, delay?: unknown) =>
      typeof fn === "function" ? setTimeout(fn as () => void, Number(delay) || 0) : 0;
  }
  if (sandbox["clearTimeout"] === undefined) {
    sandbox["clearTimeout"] = (id: unknown) => clearTimeout(Number(id));
  }
  const api = fetchApi ?? makeFetchApi(href);
  installEventTarget(sandbox, api);
  return api;
}

function createMemoryStorage(): {
  length: number;
  getItem: (k: unknown) => string | null;
  setItem: (k: unknown, v: unknown) => void;
  removeItem: (k: unknown) => void;
  clear: () => void;
  key: (i: unknown) => string | null;
} {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    getItem: (k) => map.get(String(k)) ?? null,
    setItem: (k, v) => {
      map.set(String(k), String(v));
    },
    removeItem: (k) => {
      map.delete(String(k));
    },
    clear: () => {
      map.clear();
    },
    key: (i) => [...map.keys()][Number(i)] ?? null,
  };
}

export function runScriptsOnSession(
  session: FineSession,
  sources: readonly string[],
  resources: ReadonlyMap<string, string> = new Map(),
  options: {
    readonly wsTransport?: WsTransport;
    readonly csp?: import("./csp.js").CspContext | null;
    /** RFC 0033: drawImage(imgEl) source resolution (decodedImages). */
    readonly canvasImageSource?: (
      nodeId: import("@browser-engine/ir").NodeId,
    ) => import("@browser-engine/ir").DecodedImage | undefined;
    /** RFC 0034: navigator.serviceWorker backing registry. */
    readonly serviceWorkerRegistry?: import("./service-worker.js").ServiceWorkerRegistry;
    /** RFC 0042: shared-worker registry (absent ⇒ per-session default). */
    readonly sharedWorkerRegistry?: import("./shared-worker-global.js").SharedWorkerRegistry;
    /** RFC 0035: the document's media engine. */
    readonly media?: import("./media.js").MediaEngine;
  } = {},
): EventDrivenRun {
  const locationBox: { current: unknown } = { current: null };
  const loop = new VirtualEventLoop();
  const csp = options.csp ?? session.csp ?? null;
  // RFC 0032: live dedicated workers spawned by this document — the run
  // disposes them (an unref'd thread still pins `node --test` runs).
  const liveWorkers = new Set<() => void>();
  const { document, globals: domGlobals, mutations, tickAnimations, hasActiveAnimations, ui, bindWsRealm, canvasBitmaps } =
    buildDocumentApi(session, {
      locationBox,
      // Observer delivery rides the SAME microtask queue guests see, so
      // MutationObserver callbacks interleave with queueMicrotask in FIFO order.
      queueMicrotask: (fn) => loop.microtask(fn),
      ...(options.wsTransport !== undefined ? { wsTransport: options.wsTransport } : {}),
      ...(options.canvasImageSource !== undefined ? { canvasImageSource: options.canvasImageSource } : {}),
      ...(options.media !== undefined
        ? {
            media: options.media,
            mediaClock: {
              now: () => loop.now(),
              setTimeout: (fn: () => void, ms: number) => loop.setTimeout(fn, ms),
              clearTimeout: (id: number) => loop.clearTimeout(id),
            },
          }
        : {}),
    });
  loop.onAnimationFrame(tickAnimations, hasActiveAnimations);

  // The fetch api bundle is shared with the sandbox classes (installed via
  // installBrowserGlobals below) so `instanceof` holds for guest-constructed
  // Request objects passed back into fetch — one bundle per document.
  const fetchApi = makeFetchApi(session.url);
  // Bound to the REALM's TypeError once the vm context exists (fetch
  // rejections fire at drain time — after context creation) so guest
  // `instanceof TypeError` holds across the realm boundary.
  let realmTypeError: typeof TypeError | undefined;
  const serveResource = (href: string, rawUrl: string): RawFetchResult => {
    const body = resources.get(href) ?? resources.get(rawUrl);
    return {
      status: body !== undefined ? 200 : 404,
      url: href,
      headers: body !== undefined ? { "content-type": "text/plain; charset=utf-8" } : {},
      body: body !== undefined ? new TextEncoder().encode(body) : new Uint8Array(),
    };
  };
  const fetchFn = (input: unknown, init?: unknown): Thenable<object> => {
    // Normalization is synchronous — Request construction errors throw here,
    // before any async step (matching the platform's argument checking).
    const request = new fetchApi.Request(input, init);
    const deferred = loop.deferred<object>();
    const signal = request.signal as { aborted?: boolean } | null | undefined;
    // RFC 0027: `connect-src` — a refused URL rejects the fetch promise with a
    // TypeError (Fetch §5.6's network-error path), never reaching the map.
    if (csp !== null && !csp.check("connect", request.url).allowed) {
      loop.microtask(() =>
        deferred.reject(
          new TypeError(
            `Refused to connect to '${request.url}' because it violates the document's Content Security Policy directive: "connect-src".`,
          ),
        ),
      );
      return deferred;
    }
    // RFC 0028: `mode:"same-origin"` is a client-side gate — a cross-origin
    // target rejects before serving. `no-cors` resolves as an OPAQUE response
    // (the Map transport has no ACAO headers to check, so a cors-mode request
    // stays permissive here — the real stack enforces; documented bound).
    let crossOriginTarget = false;
    try {
      crossOriginTarget = new URL(request.url).origin !== new URL(session.url).origin;
    } catch {
      crossOriginTarget = false;
    }
    if (request.mode === "same-origin" && crossOriginTarget) {
      loop.microtask(() =>
        deferred.reject(
          // The realm's own TypeError — guest `instanceof TypeError` holds.
          new (realmTypeError ?? TypeError)(
            `Failed to fetch: request mode "same-origin" cannot fetch cross-origin URL '${request.url}'`,
          ),
        ),
      );
      return deferred;
    }
    // RFC 0029: baseline mixed content is CLIENT-side policy — the virtual
    // Map transport enforces the same block rules as the real stack (fetch
    // lands on destination "empty": blockable, not upgradable).
    const mixed = mixedContentVerdict(request.url, session.url, "empty", request.mode);
    if (mixed.action === "block") {
      loop.microtask(() =>
        deferred.reject(
          new (realmTypeError ?? TypeError)(
            `Mixed Content: fetch of insecure URL '${request.url}' from secure context '${session.url}' was blocked`,
          ),
        ),
      );
      return deferred;
    }
    const fetchUrl = mixed.action === "upgrade" ? mixed.url : request.url;
    if (signal?.aborted === true) {
      // Fetch §4.3: a pre-aborted signal REJECTS the fetch promise with an
      // "AbortError" DOMException. (HTTP-level failures like 404 resolve an
      // ok=false Response; transport errors and aborts reject.) The realm's
      // own DOMException is installed on the sandbox after context creation.
      loop.microtask(() =>
        deferred.reject(
          new ((sandbox["DOMException"] as typeof DOMException | undefined) ?? DOMException)(
            "The operation was aborted.",
            "AbortError",
          ),
        ),
      );
      return deferred;
    }
    loop.microtask(() => {
      deferred.resolve(
        fetchApi.responseFromRaw(
          request.mode === "no-cors"
            ? { status: 0, url: "", headers: {}, body: new Uint8Array(0), type: "opaque" }
            : serveResource(fetchUrl, String(input)),
        ),
      );
    });
    return deferred;
  };

  const sandbox: Record<string, unknown> = {
    document,
    ...domGlobals,
    setTimeout: (fn: unknown, delay: unknown) =>
      typeof fn === "function" ? loop.setTimeout(fn as () => void, Number(delay) || 0) : 0,
    clearTimeout: (id: unknown) => loop.clearTimeout(Number(id)),
    queueMicrotask: (fn: unknown) => {
      if (typeof fn === "function") loop.microtask(fn as () => void);
    },
    requestAnimationFrame: (fn: unknown) =>
      typeof fn === "function" ? loop.requestAnimationFrame(fn as (t: number) => void) : 0,
    cancelAnimationFrame: (id: unknown) => loop.cancelAnimationFrame(Number(id)),
    fetch: fetchFn,
    // RFC 0032: workers spawn from the sync runner too — the virtual
    // resource map is the worker-source channel here.
    Worker: makeWorkerCtor({
      loop,
      documentUrl: session.url,
      fetchWorkerSource: (u) => {
        const body = resources.get(u);
        return Promise.resolve(
          body === undefined ? undefined : new TextEncoder().encode(body),
        );
      },
      csp,
      registerWorker: (dispose) => liveWorkers.add(dispose),
    }),
    // RFC 0042: SharedWorker — the virtual resource map is the script
    // channel; a caller-supplied registry shares realms across pages.
    SharedWorker: makeSharedWorkerCtor({
      loop,
      documentUrl: session.url,
      fetchWorkerSource: (u) => {
        const body = resources.get(u);
        return Promise.resolve(
          body === undefined ? undefined : new TextEncoder().encode(body),
        );
      },
      csp,
      registry: options.sharedWorkerRegistry ?? new SharedWorkerRegistry(),
      registerWorker: (dispose) => liveWorkers.add(dispose),
    }),
  };
  installBrowserGlobals(
    sandbox,
    session.url,
    undefined,
    undefined,
    undefined,
    fetchApi,
    session.isolation,
    // RFC 0034: navigator.serviceWorker — a real container when the session
    // network stack carries a registry; inbound worker→page messages dispatch
    // as virtual-loop tasks like every other inbound event.
    ...(options.serviceWorkerRegistry !== undefined
      ? [createServiceWorkerContainer({
          registry: options.serviceWorkerRegistry,
          pageUrl: session.url,
          postTask: (fn) => loop.setTimeout(fn, 0),
        })]
      : []),
  );
  locationBox.current = sandbox["location"];
  installXMLHttpRequest(
    sandbox,
    (sandbox["fetch"] as (input: unknown, init?: unknown) => Promise<object>),
    session.url,
  );

  let error: string | null = null;
  const context = vm.createContext(sandbox);
  // Bind the realm's own error intrinsics so API-thrown errors pass guest
  // `instanceof TypeError`/`instanceof DOMException` checks (host-constructed
  // errors fail cross-realm identity).
  {
    const errs = vm.runInContext(
      "({ TypeError, RangeError, ArrayBuffer, EvalError, DOMException: typeof DOMException !== \"undefined\" ? DOMException : null })",
      context,
    ) as { TypeError: typeof TypeError; RangeError: typeof RangeError; ArrayBuffer: typeof ArrayBuffer; EvalError: typeof EvalError; DOMException: typeof DOMException | null };
    // Node's vm realm has no DOMException intrinsic — fall back to the
    // guest-package class, installed as the sandbox global so guest
    // `e instanceof DOMException` still holds.
    const de = errs.DOMException ?? DOMException;
    fetchApi.bindRealmErrors({ ...errs, DOMException: de });
    sandbox["DOMException"] = de;
    realmTypeError = errs.TypeError;
    // RFC 0022: realm ArrayBuffer for binaryType:"arraybuffer" delivery.
    bindWsRealm({ ArrayBuffer: errs.ArrayBuffer, TypeError: errs.TypeError });
    // RFC 0027: `unsafe-eval` — replace the realm's eval/Function globals with
    // throwing stubs when an enforcing policy omits the keyword.
    if (csp !== null && !csp.allowsEval) {
      const blockedEval = (): never => {
        csp.violations.push({
          directive: "script-src",
          effectiveDirective: "script-src",
          blockedUrl: "eval",
          documentUrl: csp.documentUrl,
          disposition: "enforce",
        });
        throw new errs.EvalError(
          "Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script",
        );
      };
      sandbox["eval"] = blockedEval;
      sandbox["Function"] = new Proxy(Function, {
        construct: () => blockedEval(),
        apply: () => blockedEval(),
      });
    }
  }
  for (const source of sources) {
    if (source.trim() === "") continue;
    try {
      vm.runInContext(source, context, { timeout: 5000 });
    } catch (e) {
      if (error === null) error = e instanceof Error ? e.message : String(e);
    }
  }
  try {
    loop.drain();
  } catch (e) {
    if (error === null) error = e instanceof Error ? e.message : String(e);
  }

  return {
    microtasks: loop.microtaskCount,
    timers: loop.timerCount,
    frames: loop.frameCount,
    mutations: mutations(),
    error,
    sandbox,
    context,
    getMutations: mutations,
    drain: () => loop.drain(),
    disposeWorkers: () => {
      for (const dispose of [...liveWorkers]) dispose();
      liveWorkers.clear();
    },
    canvasBitmaps,
    ui,
  };
}

export function runScriptsOnSessionReal(
  session: FineSession,
  sources: readonly string[],
  fetchFn: FetchFn = defaultFetch,
  options: ScriptNetworkOptions = {},
): Promise<EventDrivenRun> {
  return runScriptsOnSessionRealInner(session, sources, fetchFn, options);
}

async function runScriptsOnSessionRealInner(
  session: FineSession,
  sources: readonly string[],
  fetchFn: FetchFn = defaultFetch,
  options: ScriptNetworkOptions = {},
): Promise<EventDrivenRun> {
  const locationBox: { current: unknown } = { current: null };
  // Late-bound dynamic script evaluator: the vm context exists only after
  // the sandbox is fully assembled, but appendChild can fire any time.
  let dynamicScriptEvaluator: ((nodeId: NodeId) => void) | null = null;
  let loopErrorSink: ((error: unknown) => void) | null = null;
  const navHost = options.sessionHost;
  // RFC 0032: live dedicated workers — the run disposes them on teardown.
  const liveWorkers = new Set<() => void>();
  const loop = new VirtualEventLoop({ realTime: true });
  // RFC 0027: the document's CSP context — options take precedence, else the
  // session's installed policy (set by the app layer from response headers).
  const csp = options.csp ?? session.csp ?? null;
  const { document, globals: domGlobals, mutations, tickAnimations, hasActiveAnimations, fireDocumentLifecycleEvents, fireScriptElementEvent, clickElement, dispatchElementEvent, ui, bindWsRealm, canvasBitmaps } =
    buildDocumentApi(session, {
      geometryMode: "stub",
      styleMode: "fast",
      locationBox,
      queueMicrotask: (fn) => loop.microtask(fn),
      ...(options.viewport !== undefined ? { viewport: options.viewport } : {}),
      // RFC 0027: WebSocket targets are `connect-src` fetches — wrap the host
      // transport so a refused URL fails the socket before any bytes move
      // (the WS layer surfaces the throw as error + 1006 close events).
      ...(options.wsTransport !== undefined
        ? {
            wsTransport: {
              connect: (u: URL) => {
                // RFC 0029: ws:// from a secure context is blockable mixed
                // content (sockets aren't in the upgradable set).
                if (u.protocol === "ws:" && isPotentiallyTrustworthyUrl(session.url)) {
                  throw new TypeError(
                    `Mixed Content: insecure WebSocket '${u.href}' from secure context '${session.url}' was blocked`,
                  );
                }
                if (csp !== null) {
                  const gated = csp.gateSubresourceUrl(u.href);
                  if (gated.blocked || !csp.check("connect", gated.url).allowed) {
                    throw new TypeError(
                      `Refused to connect to '${u.href}' because it violates the document's Content Security Policy directive: "connect-src".`,
                    );
                  }
                  if (gated.url !== u.href) u = new URL(gated.url);
                }
                return options.wsTransport!.connect(u);
              },
            } satisfies WsTransport,
          }
        : {}),
      onDynamicScript: (nodeId: NodeId) => dynamicScriptEvaluator?.(nodeId),
      ...(options.canvasImageSource !== undefined ? { canvasImageSource: options.canvasImageSource } : {}),
      ...(options.media !== undefined
        ? {
            media: options.media,
            mediaClock: {
              now: () => loop.now(),
              setTimeout: (fn: () => void, ms: number) => loop.setTimeout(fn, ms),
              clearTimeout: (id: number) => loop.clearTimeout(id),
            },
          }
        : {}),
      // RFC 0011: link clicks and form submissions become real host
      // navigations — target dispatch (_blank/_parent/_top) lives in the host.
      ...(options.frameLookup !== undefined ? { frameLookup: options.frameLookup } : {}),
      ...(navHost !== undefined
        ? {
            navigator: (url: string, init?: {
              replace?: boolean; target?: string; method?: string;
              body?: string; contentType?: string; download?: string;
              referrerPolicy?: string;
            }) => {
              if (init?.target !== undefined && navHost.navigateTarget !== undefined) {
                navHost.navigateTarget(url, init.target, init);
                return;
              }
              if (navHost.submit !== undefined) navHost.submit(url, init);
              else navHost.assign(url);
            },
          }
        : {}),
      // listener exceptions (lifecycle + document.dispatchEvent) surface as
      // the run's error instead of vanishing
      onListenerError: (error: unknown) => {
        if (error === null) return;
        loopErrorSink?.(error);
      },
    });
  loop.onAnimationFrame(tickAnimations, hasActiveAnimations);
  const decoder = new TextDecoder();
  const inflight = new Set<Promise<void>>();
  const liveIntervals = new Set<number>();
  const browserFetch = options.browserFetch;

  const resolveFetchUrl = (input: unknown): string => {
    const raw = String(input);
    try {
      return new URL(raw, session.url).href;
    } catch {
      return raw;
    }
  };
  // RFC 0019: the guest fetch goes through the shared makeFetchApi facade —
  // Request-input normalization, init merging (method/headers/body/mode/
  // credentials/referrerPolicy), forbidden methods, and abort handling all
  // live there; this runner only supplies the transport core. Responses are
  // real guest `Response` instances (clone/bodyUsed/body stream work).
  const fetchApi = makeFetchApi(session.url);
  // Bound to the realm's TypeError after vm context creation so fetch
  // rejections pass guest `instanceof TypeError` checks.
  let realmTypeError: typeof TypeError | undefined;
  const fetchCore = async (req: NormalizedRequest): Promise<RawFetchResult> => {
    // RFC 0027: `connect-src` — a refused URL rejects the fetch promise with
    // a TypeError (Fetch §5.6's "network error" path); mixed-content upgrade
    // applies first. `blockedUrl` in the violation records the ORIGINAL URL.
    let url = req.url;
    if (csp !== null) {
      const gated = csp.gateSubresourceUrl(url);
      const refused = gated.blocked || !csp.check("connect", gated.url).allowed;
      if (refused) {
        throw new TypeError(
          `Refused to connect to '${url}' because it violates the document's Content Security Policy directive: "connect-src".`,
        );
      }
      url = gated.url;
    }
    // RFC 0029: baseline mixed content — an http target from a secure
    // document rejects (fetch lands on destination "empty": blockable).
    // The stack-backed browserFetch path repeats this check in the stack.
    const mixed = mixedContentVerdict(url, session.url, "empty", req.mode);
    if (mixed.action === "block") {
      throw new TypeError(
        `Mixed Content: fetch of insecure URL '${url}' from secure context '${session.url}' was blocked`,
      );
    }
    if (mixed.action === "upgrade") url = mixed.url;
    // RFC 0028: `mode:"same-origin"` is a pure client-side check — it rejects
    // cross-origin fetches regardless of transport. `no-cors` semantics on
    // the VIRTUAL path produce an opaque response (the real stack also does
    // ACAO enforcement + preflights; a Map transport has no server headers,
    // so cors-mode requests stay permissive here — a documented bound).
    const sameOriginFail = (() => {
      if (req.mode !== "same-origin") return false;
      try {
        return new URL(url).origin !== new URL(session.url).origin;
      } catch {
        return false;
      }
    })();
    if (sameOriginFail) {
      // Realm TypeError — guest `instanceof TypeError` holds.
      throw new (realmTypeError ?? TypeError)(
        `Failed to fetch: request mode "same-origin" cannot fetch cross-origin URL '${url}'`,
      );
    }
    if (browserFetch !== undefined) {
      // The injected stack-backed fetch gets the full init so the same
      // transport sees exactly what the guest asked for.
      const res = await browserFetch(url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        signal: req.signal,
        mode: req.mode,
        credentials: req.credentials,
        referrerPolicy: req.referrerPolicy,
      });
      return adaptResponseLike(res, url);
    }
    const bytes = await fetchFn(url);
    if (req.mode === "no-cors") {
      // Opaque filtered response — the bytes went over the (virtual) wire;
      // guest script just can't READ them.
      return {
        status: 0,
        url: "",
        headers: {},
        body: new Uint8Array(0),
        type: "opaque",
      };
    }
    const ok = bytes !== undefined;
    const body = ok ? bytes : new Uint8Array();
    const text = ok ? decoder.decode(bytes) : "";
    const looksJson =
      ok &&
      (text.trimStart().startsWith("{") ||
        text.trimStart().startsWith("[") ||
        url.includes("/x/") ||
        url.includes("api.") ||
        url.endsWith(".json"));
    const contentType = !ok
      ? "text/plain"
      : looksJson
        ? "application/json; charset=utf-8"
        : url.includes(".js")
          ? "application/javascript; charset=utf-8"
          : url.includes(".css")
            ? "text/css; charset=utf-8"
            : "text/html; charset=utf-8";
    return {
      status: ok ? 200 : 404,
      url,
      headers: { "content-type": contentType, "content-length": String(body.byteLength) },
      body,
    };
  };
  const guestFetch = fetchApi.makeFetch(fetchCore);
  const fetchImpl = (input: unknown, init?: unknown): Promise<object> => {
    // In-flight tracking (the flush loop waits for network work to settle):
    // the entry is removed when the fetch resolves OR rejects — never left
    // behind, matching the previous job-tracking semantics.
    const work = guestFetch(input, init) as Promise<object>;
    const tracked = work.then(
      () => {
        inflight.delete(tracked);
      },
      () => {
        inflight.delete(tracked);
      },
    );
    inflight.add(tracked);
    return work;
  };

  const sandbox: Record<string, unknown> = {
    document,
    ...domGlobals,
    setTimeout: (fn: unknown, delay: unknown) =>
      typeof fn === "function" ? loop.setTimeout(fn as () => void, Number(delay) || 0) : 0,
    clearTimeout: (id: unknown) => loop.clearTimeout(Number(id)),
    setInterval: (fn: unknown, delay: unknown) => {
      if (typeof fn !== "function") return 0;
      const handle = setInterval(() => {
        try {
          (fn as () => void)();
        } catch {
          // Guest/page code may throw here; swallowed by design.
        }
      }, Number(delay) || 0);
      if (options.keepAlive === true) handle.unref?.();
      const id = handle as unknown as number;
      liveIntervals.add(id);
      return id;
    },
    clearInterval: (id: unknown) => {
      const n = Number(id);
      liveIntervals.delete(n);
      clearInterval(n);
    },
    queueMicrotask: (fn: unknown) => {
      if (typeof fn === "function") loop.microtask(fn as () => void);
    },
    requestAnimationFrame: (fn: unknown) =>
      typeof fn === "function" ? loop.requestAnimationFrame(fn as (t: number) => void) : 0,
    cancelAnimationFrame: (id: unknown) => loop.cancelAnimationFrame(Number(id)),
    fetch: fetchImpl,
    // RFC 0032: `new Worker(url)` spawns a REAL worker_threads realm — the
    // source rides the document's fetch channel (destination "worker"),
    // `worker-src` gates the spawn, inbound messages are loop tasks.
    Worker: makeWorkerCtor({
      loop,
      documentUrl: session.url,
      fetchWorkerSource:
        options.fetchWorkerSource ?? ((u) => Promise.resolve(fetchFn(u))),
      csp,
      registerWorker: (dispose) => liveWorkers.add(dispose),
    }),
    // RFC 0042: `new SharedWorker(url)` — shared realm per (url,name); the
    // stack-bound registry makes navigations/iframes share workers.
    SharedWorker: makeSharedWorkerCtor({
      loop,
      documentUrl: session.url,
      fetchWorkerSource:
        options.fetchWorkerSource ?? ((u) => Promise.resolve(fetchFn(u))),
      ...(options.fetchSharedWorkerSource !== undefined
        ? { fetchSharedWorkerSource: options.fetchSharedWorkerSource }
        : {}),
      csp,
      registry: options.sharedWorkerRegistry ?? new SharedWorkerRegistry(),
      registerWorker: (dispose) => liveWorkers.add(dispose),
    }),
  };
  installBrowserGlobals(
    sandbox,
    session.url,
    undefined,
    options.sessionHost,
    options.storage,
    fetchApi,
    session.isolation,
    ...(options.serviceWorkerRegistry !== undefined
      ? [createServiceWorkerContainer({
          registry: options.serviceWorkerRegistry,
          pageUrl: session.url,
          postTask: (fn) => loop.setTimeout(fn, 0),
        })]
      : []),
  );
  // document.location must be the SAME object as window.location (HTML §7.3);
  // hand the document getter the installed location after globals exist.
  locationBox.current = sandbox["location"];
  installXMLHttpRequest(
    sandbox,
    (sandbox["fetch"] as (input: unknown, init?: unknown) => Promise<object>),
    session.url,
  );

  let error: string | null = null;
  const context = vm.createContext(sandbox);
  // Bind realm error intrinsics (same rationale as the virtual runner).
  {
    const errs = vm.runInContext(
      "({ TypeError, RangeError, ArrayBuffer, EvalError, DOMException: typeof DOMException !== \"undefined\" ? DOMException : null })",
      context,
    ) as { TypeError: typeof TypeError; RangeError: typeof RangeError; ArrayBuffer: typeof ArrayBuffer; EvalError: typeof EvalError; DOMException: typeof DOMException | null };
    const de = errs.DOMException ?? DOMException;
    fetchApi.bindRealmErrors({ ...errs, DOMException: de });
    sandbox["DOMException"] = de;
    realmTypeError = errs.TypeError;
    bindWsRealm({ ArrayBuffer: errs.ArrayBuffer, TypeError: errs.TypeError });
    // RFC 0027: `unsafe-eval` — with an enforcing script-src/default-src that
    // lacks the keyword, the realm's `eval`/`Function` globals become throwing
    // stubs (the VM's own eval machinery is unaffected; guest code sees
    // EvalError like a real CSP-blocked eval).
    if (csp !== null && !csp.allowsEval) {
      const blockedEval = (): never => {
        csp.violations.push({
          directive: "script-src",
          effectiveDirective: "script-src",
          blockedUrl: "eval",
          documentUrl: csp.documentUrl,
          disposition: "enforce",
        });
        throw new errs.EvalError(
          "Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script",
        );
      };
      sandbox["eval"] = blockedEval;
      sandbox["Function"] = new Proxy(Function, {
        construct: () => blockedEval(),
        apply: () => blockedEval(),
      });
    }
  }
  // `window.open(url,'_self')` must return the realm's OWN WindowProxy — the
  // contextified global — not a host-side wrapper (identity breaks across
  // the vm boundary otherwise).
  if (options.sessionHost !== undefined) {
    options.sessionHost.selfWindow = vm.runInContext("this", context);
  }
  // First error wins; include a short stack like the ESM runner so page
  // failures are diagnosable without a debugger.
  const formatError = (e: unknown): string => {
    const message = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error && e.stack ? e.stack.split("\n").slice(0, 6).join(" | ") : "";
    return stack ? `${message} :: ${stack}` : message;
  };
  // Dynamic script execution (HTML §4.12.1): a guest-appended <script> with
  // a src fetches and evaluates in this context; inline text evaluates
  // directly. Each inserted script element runs at most once; evaluation is
  // scheduled as a microtask-adjacent task so chunk code registers modules
  // before the next timer fires. currentScript points at the executing node.
  const executedDynamicScripts = new Set<NodeId>();
  const inlineScriptText = (nodeId: NodeId): string => {
    const node = session.dom.nodes.get(nodeId);
    if (node === undefined) return "";
    if (node.kind === "text") return node.text ?? "";
    let out = "";
    for (const child of node.children) out += inlineScriptText(child);
    return out;
  };
  dynamicScriptEvaluator = (nodeId: NodeId): void => {
    if (executedDynamicScripts.has(nodeId)) return;
    executedDynamicScripts.add(nodeId);
    const node = session.dom.nodes.get(nodeId);
    if (node === undefined || node.kind !== "element") return;
    const type = node.attrs?.get("type");
    if (type !== undefined && type !== "" && !/javascript|ecmascript/i.test(type)) return;
    const src = node.attrs?.get("src")?.trim();
    const evaluate = (code: string, label: string): void => {
      loop.microtask(() => {
        box.current = nodeId;
        try {
          vm.runInContext(code, context, { timeout: 2000, filename: label });
          // script executed → `load` fires on the element (webpack loaders
          // resolve their chunk promise from this event)
          fireScriptElementEvent(nodeId, "load");
        } catch (e) {
          if (error === null) error = formatError(e);
          fireScriptElementEvent(nodeId, "error");
        }
        box.current = null;
      });
    };
    if (src !== undefined && src !== "") {
      let href = resolveFetchUrl(src);
      // RFC 0027: `script-src` — a refused dynamic fetch behaves like a
      // network error (element fires `error`, the loader pattern still works).
      if (csp !== null) {
        const gated = csp.gateSubresourceUrl(href);
        // `<script src>` injection is a script-src-ELEM fetch.
        if (gated.blocked || !csp.check("script", gated.url, "elem").allowed) {
          fireScriptElementEvent(nodeId, "error");
          return;
        }
        href = gated.url;
      }
      void (async (): Promise<void> => {
        try {
          let code: string | null = null;
          if (browserFetch !== undefined) {
            const response = await browserFetch(href);
            code = response.ok ? await response.text() : null;
          } else {
            const response = await fetch(href);
            code = response.ok ? await response.text() : null;
          }
          if (code !== null) evaluate(code, href);
          else fireScriptElementEvent(nodeId, "error");
        } catch {
          // network failure: report `error` on the element (the page's loader
          // listens for it) and let the script simply never run.
          fireScriptElementEvent(nodeId, "error");
        }
      })();
    } else {
      const inline = inlineScriptText(nodeId);
      // RFC 0027: `script-src-elem`/`script-src` gates injected inline bodies —
      // the element's nonce/hash may still unblock it (webpack-style loaders
      // that inject nonced bootstraps keep working).
      if (inline.trim() !== "") {
        if (csp !== null &&
          !csp.checkInline(
            "script",
            { nonce: node.attrs?.get("nonce"), text: inline.trim() },
            "elem",
          ).allowed) {
          fireScriptElementEvent(nodeId, "error");
          return;
        }
        evaluate(inline, "inline-dynamic");
      }
    }
  };
  loop.onUncaught((e) => {
    if (error === null) error = formatError(e);
  });
  loopErrorSink = (e: unknown): void => {
    if (error === null) error = formatError(e);
  };
  const box = options.currentScriptBox ?? { current: null as import("@browser-engine/ir").NodeId | null };
  for (let i = 0; i < sources.length; i += 1) {
    const source = sources[i] ?? "";
    if (source.trim() === "") continue;
    box.current = options.scriptNodeIds?.[i] ?? null;
    try {
      // Per-source filename: guest stack frames must identify WHICH script
      // failed (inline sources are labeled by index, externals by URL when
      // the host provided scriptUrls).
      const filename = options.scriptUrls?.[i] ?? `inline-script-${i}.js`;
      vm.runInContext(source, context, { timeout: 2000, filename });
    } catch (e) {
      if (error === null) error = formatError(e);
    }
  }
  box.current = null;
  // HTML end-of-parsing lifecycle: DOMContentLoaded at the document, then
  // `load` at the window. SPAs commonly defer hydration until these fire.
  // Callback errors report through the loop's uncaught handler like any task.
  loop.microtask(() => fireDocumentLifecycleEvents());
  loop.microtask(() => {
    const winDispatch = sandbox["dispatchEvent"];
    if (typeof winDispatch === "function") {
      (winDispatch as (event: unknown) => boolean)({ type: "load" });
    }
    const onLoad = sandbox["onload"];
    if (typeof onLoad === "function") (onLoad as () => void)();
  });
  const flushAsync = async (maxMs = 500): Promise<void> => {
    loop.drain();
    let rounds = 0;
    const deadline = Date.now() + Math.max(0, maxMs);
    while (inflight.size > 0 && rounds < 24 && Date.now() < deadline) {
      const wait = Promise.allSettled([...inflight]);
      const timeout = new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now())));
      });
      await Promise.race([wait, timeout]);
      loop.drain();
      rounds += 1;
    }
    inflight.clear();
    loop.drain();
    // Guest fetch chains run on REAL promise microtasks (host queue); a guest
    // reaction may hop through our loop thenables, so yield a full macrotask
    // turn (which runs ALL chained host microtasks) before the final drain.
    await new Promise<void>((resolve) => setImmediate(resolve));
    loop.drain();
    if (options.keepAlive !== true) {
      for (const id of liveIntervals) clearInterval(id);
      liveIntervals.clear();
    }
  };

  try {
    await flushAsync();
  } catch (e) {
    if (error === null) error = formatError(e);
  }

  return {
    microtasks: loop.microtaskCount,
    timers: loop.timerCount,
    frames: loop.frameCount,
    mutations: mutations(),
    error,
    sandbox,
    context,
    getMutations: mutations,
    drain: () => loop.drain(),
    flushAsync,
    disposeWorkers: () => {
      for (const dispose of [...liveWorkers]) dispose();
      liveWorkers.clear();
    },
    canvasBitmaps,
    clickElement: (nodeId) => {
      try {
        clickElement(nodeId);
      } catch {
        // Guest activation code may throw here; swallowed by design.
      }
    },
    dispatchElementEvent: (nodeId, type, init) => {
      try {
        dispatchElementEvent(nodeId, type, init);
      } catch {
        // Guest listeners may throw here; swallowed by design.
      }
    },
    ui: {
      pointerMove: (nodeId, init) => { try { ui.pointerMove(nodeId, init); } catch { /* guest listeners */ } },
      click: (nodeId, init) => { try { ui.click(nodeId, init); } catch { /* guest listeners */ } },
      contextMenu: (nodeId, init) => { try { ui.contextMenu(nodeId, init); } catch { /* guest listeners */ } },
      dblClick: (nodeId, init) => { try { ui.dblClick(nodeId, init); } catch { /* guest listeners */ } },
      key: (detail) => { try { ui.key(detail); } catch { /* guest listeners */ } },
      tab: (dir) => { try { ui.tab(dir); } catch { /* guest listeners */ } },
      focusedId: () => ui.focusedId(),
    },
  };
}

/**
 * Run `source` as real JavaScript against a document parsed from `html`, with a
 * deterministic event loop and an injected `fetch` resolver, then drain the loop
 * to completion. `resources` maps a URL to its response body text.
 */
export function runEventDriven(
  html: string,
  source: string,
  resources: ReadonlyMap<string, string> = new Map(),
): EventDrivenRun {
  return runScriptsOnSession(new FineSession(html), [source], resources);
}

/**
 * Like {@link runEventDriven}, but `fetch` uses a REAL network transport
 * (`fetchFn`, defaulting to Node's global `fetch` — real HTTP/TLS via
 * {@link defaultFetch}). The run is async: it runs the script, drains the loop,
 * then awaits each in-flight real fetch and re-drains, repeating to a fixed
 * point — so genuine network completion drives promise reactions and DOM
 * mutations in the correct event-loop order. Tests inject a deterministic
 * `fetchFn`; production uses the real socket-backed default.
 */
export async function runEventDrivenReal(
  html: string,
  source: string,
  fetchFn: FetchFn = defaultFetch,
): Promise<EventDrivenRun> {
  return runScriptsOnSessionReal(new FineSession(html), [source], fetchFn);
}
