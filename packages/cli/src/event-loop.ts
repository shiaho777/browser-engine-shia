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

import { FineSession } from "./fine.js";
import { buildDocumentApi } from "./script.js";
import { BROWSER_USER_AGENT, defaultFetch, type FetchFn } from "./loader.js";
import { coerceGuestString, makeBlobClass, makeFileClass, globalObjectUrls } from "@browser-engine/guest";

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
   * Keep guest intervals alive after the initial flush so a host can keep
   * pumping the returned `drain`/`flushAsync` hooks for continuous rendering.
   * Live handles are unref'd so they never hold the host process open.
   */
  readonly keepAlive?: boolean;
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
}

/** A minimal Promise-shaped thenable scheduled on the virtual loop's microtasks. */
class Thenable<T> {
  #value: T | undefined;
  #settled = false;
  readonly #cbs: ((v: T) => void)[] = [];
  constructor(private readonly loop: VirtualEventLoop) {}

  resolve(value: T): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#value = value;
    for (const cb of this.#cbs) this.loop.microtask(() => cb(value));
    this.#cbs.length = 0;
  }

  then(onFulfilled: (v: T) => unknown): Thenable<unknown> {
    const next = new Thenable<unknown>(this.loop);
    const run = (v: T): void => {
      const result = onFulfilled(v);
      if (result instanceof Thenable) {
        result.then((r) => next.resolve(r));
      } else {
        next.resolve(result);
      }
    };
    if (this.#settled) {
      this.loop.microtask(() => run(this.#value as T));
    } else {
      this.#cbs.push(run);
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
class VirtualEventLoop {
  readonly #microtasks: (() => void)[] = [];
  readonly #timers: Timer[] = [];
  #raf: { id: number; cb: (t: number) => void; cancelled: boolean }[] = [];
  #clock = 0;
  #nextTimerId = 1;
  #nextRafId = 1;
  #onFrame: ((now: number) => void) | undefined;
  #frameWork: (() => boolean) | undefined;
  microtaskCount = 0;
  timerCount = 0;
  frameCount = 0;

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
        fn();
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
          r.cb(this.#clock);
        }
        continue;
      }
      if (pending.length === 0) return;
      // Fire the earliest-due timer (ties: insertion order via stable id).
      pending.sort((a, b) => (a.due !== b.due ? a.due - b.due : a.id - b.id));
      const next = pending[0] as Timer;
      next.cancelled = true;
      this.#clock = Math.max(this.#clock, next.due);
      this.timerCount += 1;
      if (steps++ > maxSteps) return;
      next.fn();
    }
  }
}




function emptyRect(): object {
  return {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    toJSON() {
      return this;
    },
  };
}

function createObserverStub(kind: "mutation" | "resize" | "intersection" | "performance", cb?: unknown): {
  observe: (...args: unknown[]) => void;
  unobserve: (...args: unknown[]) => void;
  disconnect: () => void;
  takeRecords: () => unknown[];
  root?: unknown;
  rootMargin?: string;
  thresholds?: number[];
} {
  const targets = new Set<unknown>();
  let disconnected = false;
  const deliver = (target: unknown): void => {
    if (disconnected || typeof cb !== "function") return;
    queueMicrotask(() => {
      if (disconnected || typeof cb !== "function") return;
      try {
        if (kind === "intersection") {
          const rect = emptyRect();
          (cb as (entries: unknown[], obs: unknown) => void)(
            [
              {
                target,
                isIntersecting: true,
                intersectionRatio: 1,
                boundingClientRect: rect,
                intersectionRect: rect,
                rootBounds: null,
                time: performance.now(),
              },
            ],
            observer,
          );
        } else if (kind === "resize") {
          (cb as (entries: unknown[], obs: unknown) => void)(
            [
              {
                target,
                contentRect: emptyRect(),
                borderBoxSize: [{ inlineSize: 0, blockSize: 0 }],
                contentBoxSize: [{ inlineSize: 0, blockSize: 0 }],
                devicePixelContentBoxSize: [{ inlineSize: 0, blockSize: 0 }],
              },
            ],
            observer,
          );
        }
      } catch {
        // Guest/page code may throw here; swallowed by design.
      }
    });
  };
  const observer = {
    observe: (target?: unknown) => {
      if (target === undefined || disconnected) return;
      targets.add(target);
      if (kind === "intersection" || kind === "resize") deliver(target);
    },
    unobserve: (target?: unknown) => {
      targets.delete(target);
    },
    disconnect: () => {
      disconnected = true;
      targets.clear();
    },
    takeRecords: () => [],
    root: null,
    rootMargin: "0px",
    thresholds: [0],
  };
  return observer;
}

function installObserverGlobals(sandbox: Record<string, unknown>): void {
  const make =
    (kind: "mutation" | "resize" | "intersection" | "performance") =>
    function Observer(this: unknown, cb?: unknown) {
      return createObserverStub(kind, cb);
    };
  const PerformanceObserver = make("performance") as unknown as {
    new (cb?: unknown): ReturnType<typeof createObserverStub>;
    supportedEntryTypes?: readonly string[];
  };
  PerformanceObserver.supportedEntryTypes = [
    "element",
    "event",
    "largest-contentful-paint",
    "layout-shift",
    "longtask",
    "mark",
    "measure",
    "navigation",
    "paint",
    "resource",
    "visibility-state",
  ];
  sandbox["MutationObserver"] = make("mutation");
  sandbox["ResizeObserver"] = make("resize");
  sandbox["IntersectionObserver"] = make("intersection");
  sandbox["PerformanceObserver"] = PerformanceObserver;
}


function installEventTarget(sandbox: Record<string, unknown>): void {
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
    const set = listeners.get(type);
    if (set === undefined) return true;
    for (const fn of set) {
      try {
        fn(event);
      } catch {
        // Guest/page code may throw here; swallowed by design.
      }
    }
    return true;
  };
  sandbox["addEventListener"] = addEventListener;
  sandbox["removeEventListener"] = removeEventListener;
  sandbox["dispatchEvent"] = dispatchEvent;
  sandbox["onerror"] = null;
  sandbox["onload"] = null;
  sandbox["getComputedStyle"] = (_el?: unknown) => new Proxy(
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
  if (sandbox["Event"] === undefined) sandbox["Event"] = EventCtor;
  if (sandbox["CustomEvent"] === undefined) sandbox["CustomEvent"] = CustomEventCtor;
  sandbox["MouseEvent"] = EventCtor;
  sandbox["KeyboardEvent"] = EventCtor;
  sandbox["FocusEvent"] = EventCtor;
  sandbox["PointerEvent"] = EventCtor;
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
  if (sandbox["Blob"] === undefined) sandbox["Blob"] = makeBlobClass();
  if (sandbox["File"] === undefined) sandbox["File"] = makeFileClass();
  if (sandbox["URL.createObjectURL"] === undefined) {
    (URL as unknown as { createObjectURL?: unknown }).createObjectURL = (blob: unknown): string =>
      globalObjectUrls.createObjectURL(blob);
    (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL = (url: unknown): void =>
      globalObjectUrls.revokeObjectURL(url);
  }
}


function installXMLHttpRequest(
  sandbox: Record<string, unknown>,
  doFetch: (input: unknown, init?: unknown) => Promise<object>,
  baseUrl: string,
): void {
  type XhrSelf = {
    readyState: number;
    status: number;
    statusText: string;
    responseText: string;
    response: unknown;
    responseURL: string;
    responseType: string;
    withCredentials: boolean;
    timeout: number;
    onreadystatechange: ((this: XhrSelf, ev?: unknown) => void) | null;
    onload: ((this: XhrSelf, ev?: unknown) => void) | null;
    onerror: ((this: XhrSelf, ev?: unknown) => void) | null;
    onloadend: ((this: XhrSelf, ev?: unknown) => void) | null;
    onloadstart: ((this: XhrSelf, ev?: unknown) => void) | null;
    open: (method: unknown, url: unknown) => void;
    setRequestHeader: (name: unknown, value: unknown) => void;
    send: (body?: unknown) => void;
    abort: () => void;
    getAllResponseHeaders: () => string;
    getResponseHeader: (name: unknown) => string | null;
    addEventListener: (type: unknown, fn: unknown) => void;
    removeEventListener: (type: unknown, fn: unknown) => void;
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
    self.response = "";
    self.responseURL = "";
    self.responseType = "";
    self.withCredentials = false;
    self.timeout = 0;
    self.onreadystatechange = null;
    self.onload = null;
    self.onerror = null;
    self.onloadend = null;
    self.onloadstart = null;
    let method = "GET";
    let url = "";
    const headers: Record<string, string> = {};
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    let aborted = false;
    const emit = (type: string): void => {
      const prop = ({
        readystatechange: self.onreadystatechange,
        load: self.onload,
        error: self.onerror,
        loadend: self.onloadend,
        loadstart: self.onloadstart,
      } as Record<string, ((this: XhrSelf, ev?: unknown) => void) | null>)[type];
      if (typeof prop === "function") {
        try {
          prop.call(self);
        } catch {
          // Guest/page code may throw here; swallowed by design.
        }
      }
      const set = listeners.get(type);
      if (set !== undefined) {
        for (const fn of set) {
          try {
            fn.call(self);
          } catch {
            // Guest/page code may throw here; swallowed by design.
          }
        }
      }
    };
    self.open = (m: unknown, u: unknown) => {
      method = (m === undefined || m === null ? "GET" : coerceGuestString(m)).toUpperCase();
      const raw = coerceGuestString(u);
      try {
        url = new URL(raw, baseUrl).href;
      } catch {
        url = raw;
      }
      self.readyState = 1;
      self.status = 0;
      self.statusText = "";
      self.responseText = "";
      self.response = "";
      emit("readystatechange");
    };
    self.setRequestHeader = (name: unknown, value: unknown) => {
      headers[String(name)] = String(value);
    };
    self.send = (body?: unknown) => {
      if (self.readyState !== 1) return;
      aborted = false;
      self.readyState = 2;
      emit("readystatechange");
      emit("loadstart");
      const init: Record<string, unknown> = { method, headers };
      if (body !== undefined && body !== null && method !== "GET" && method !== "HEAD") {
        init["body"] = body;
      }
      void Promise.resolve(doFetch(url, init))
        .then(async (res) => {
          if (aborted) return;
          const status = Number((res as { status?: unknown }).status ?? 0);
          const ok = Boolean((res as { ok?: unknown }).ok ?? (status >= 200 && status < 300));
          const rawResUrl = (res as { url?: unknown }).url;
          const resUrl = rawResUrl === undefined || rawResUrl === null ? url : coerceGuestString(rawResUrl);
          let text = "";
          const textFn = (res as { text?: unknown }).text;
          if (typeof textFn === "function") {
            text = String(await (textFn as () => Promise<unknown>).call(res));
          }
          self.status = status;
          self.statusText = ok ? "OK" : "Error";
          self.responseURL = resUrl;
          self.responseText = text;
          self.response = text;
          self.readyState = 3;
          emit("readystatechange");
          self.readyState = 4;
          emit("readystatechange");
          if (status >= 200 && status < 300) emit("load");
          else emit("error");
          emit("loadend");
        })
        .catch(() => {
          if (aborted) return;
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
      aborted = true;
      self.readyState = 0;
    };
    self.getAllResponseHeaders = () => "";
    self.getResponseHeader = (_name: unknown) => null;
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


function installBrowserGlobals(sandbox: Record<string, unknown>, href: string): void {
  let protocol = "";
  let host = "";
  let hostname = "";
  let port = "";
  let pathname = "";
  let search = "";
  let hash = "";
  let origin = "";
  try {
    const u = new URL(href);
    protocol = u.protocol;
    host = u.host;
    hostname = u.hostname;
    port = u.port;
    pathname = u.pathname;
    search = u.search;
    hash = u.hash;
    origin = u.origin;
  } catch {
    // Invalid URL input: keep the raw/fallback value.
  }
  const location = {
    href,
    protocol,
    host,
    hostname,
    port,
    pathname,
    search,
    hash,
    origin,
    toString: () => href,
    assign: (_u: unknown) => {},
    replace: (_u: unknown) => {},
    reload: () => {},
  };
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
  };
  const history = {
    length: 1,
    state: null,
    scrollRestoration: "auto",
    back: () => {},
    forward: () => {},
    go: (_n?: unknown) => {},
    pushState: (_s?: unknown, _t?: unknown, _u?: unknown) => {},
    replaceState: (_s?: unknown, _t?: unknown, _u?: unknown) => {},
  };
  const localStorage = createMemoryStorage();
  const sessionStorage = createMemoryStorage();
  sandbox["window"] = sandbox;
  sandbox["self"] = sandbox;
  sandbox["globalThis"] = sandbox;
  sandbox["top"] = sandbox;
  sandbox["parent"] = sandbox;
  sandbox["frames"] = sandbox;
  sandbox["location"] = location;
  sandbox["navigator"] = navigator;
  sandbox["history"] = history;
  sandbox["localStorage"] = localStorage;
  sandbox["sessionStorage"] = sessionStorage;
  const quietConsole = {
    log: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    dir: () => {},
    table: () => {},
    group: () => {},
    groupEnd: () => {},
    groupCollapsed: () => {},
    time: () => {},
    timeEnd: () => {},
    assert: () => {},
    clear: () => {},
    count: () => {},
    countReset: () => {},
  };
  sandbox["console"] = quietConsole;
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
  const viewportW = 1280;
  const viewportH = 800;
  sandbox["matchMedia"] = (q: unknown) => {
    const media = coerceGuestString(q);
    const checks: boolean[] = [];
    const minW = /min-width:\s*(\d+(?:\.\d+)?)px/i.exec(media);
    const maxW = /max-width:\s*(\d+(?:\.\d+)?)px/i.exec(media);
    const minH = /min-height:\s*(\d+(?:\.\d+)?)px/i.exec(media);
    const maxH = /max-height:\s*(\d+(?:\.\d+)?)px/i.exec(media);
    if (minW) checks.push(viewportW >= Number(minW[1]));
    if (maxW) checks.push(viewportW <= Number(maxW[1]));
    if (minH) checks.push(viewportH >= Number(minH[1]));
    if (maxH) checks.push(viewportH <= Number(maxH[1]));
    if (/prefers-color-scheme:\s*light/i.test(media)) checks.push(true);
    if (/prefers-color-scheme:\s*dark/i.test(media)) checks.push(false);
    if (/prefers-reduced-motion:\s*no-preference/i.test(media)) checks.push(true);
    if (/prefers-reduced-motion:\s*reduce/i.test(media)) checks.push(false);
    if (/hover:\s*hover/i.test(media)) checks.push(true);
    if (/pointer:\s*fine/i.test(media)) checks.push(true);
    const matches = checks.length === 0 ? false : checks.every(Boolean);
    return {
      matches,
      media,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    };
  };
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
  installObserverGlobals(sandbox);
  installEventTarget(sandbox);
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
): EventDrivenRun {
  const { document, globals: domGlobals, mutations, tickAnimations, hasActiveAnimations } =
    buildDocumentApi(session);
  const loop = new VirtualEventLoop();
  loop.onAnimationFrame(tickAnimations, hasActiveAnimations);

  const resolveFetchUrl = (input: unknown): string => {
    const raw = String(input);
    try {
      return new URL(raw, session.url).href;
    } catch {
      return raw;
    }
  };
  const fetchFn = (url: unknown): Thenable<object> => {
    const deferred = loop.deferred<object>();
    const href = resolveFetchUrl(url);
    const body = resources.get(href) ?? resources.get(String(url));
    const headers = {
      get: (name: unknown) => {
        const key = String(name).toLowerCase();
        if (key === "content-type") return body !== undefined ? "text/plain; charset=utf-8" : null;
        return null;
      },
      has: (name: unknown) => headers.get(name) !== null,
    };
    loop.microtask(() =>
      deferred.resolve({
        ok: body !== undefined,
        status: body !== undefined ? 200 : 404,
        url: href,
        headers,
        json: (): Thenable<unknown> => {
          const t = loop.deferred<unknown>();
          loop.microtask(() => {
            try {
              t.resolve(JSON.parse(body ?? "null"));
            } catch {
              t.resolve(null);
            }
          });
          return t;
        },
        text: (): Thenable<string> => {
          const t = loop.deferred<string>();
          loop.microtask(() => t.resolve(body ?? ""));
          return t;
        },
      }),
    );
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
  };
  installBrowserGlobals(sandbox, session.url);
  installXMLHttpRequest(
    sandbox,
    (sandbox["fetch"] as (input: unknown, init?: unknown) => Promise<object>),
    session.url,
  );

  let error: string | null = null;
  const context = vm.createContext(sandbox);
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
  };
}

export async function runScriptsOnSessionReal(
  session: FineSession,
  sources: readonly string[],
  fetchFn: FetchFn = defaultFetch,
  options: ScriptNetworkOptions = {},
): Promise<EventDrivenRun> {
  const { document, globals: domGlobals, mutations, tickAnimations, hasActiveAnimations } =
    buildDocumentApi(session, { geometryMode: "stub", styleMode: "fast" });
  const loop = new VirtualEventLoop();
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
  const fetchImpl = (input: unknown, init?: unknown): Thenable<object> => {
    const deferred = loop.deferred<object>();
    const job = (async (): Promise<void> => {
      if (browserFetch !== undefined) {
        try {
          const response = await browserFetch(input, init);
          loop.microtask(() => deferred.resolve(response));
        } catch {
          const href = resolveFetchUrl(input);
          const headers = {
            get: (_name: unknown) => null,
            has: (_name: unknown) => false,
          };
          loop.microtask(() =>
            deferred.resolve({
              ok: false,
              status: 0,
              url: href,
              headers,
              json: (): Thenable<unknown> => {
                const t = loop.deferred<unknown>();
                loop.microtask(() => t.resolve(null));
                return t;
              },
              text: (): Thenable<string> => {
                const t = loop.deferred<string>();
                loop.microtask(() => t.resolve(""));
                return t;
              },
              arrayBuffer: (): Thenable<ArrayBuffer> => {
                const t = loop.deferred<ArrayBuffer>();
                loop.microtask(() => t.resolve(new ArrayBuffer(0)));
                return t;
              },
            }),
          );
        }
        return;
      }
      const href = resolveFetchUrl(input);
      const bytes = await fetchFn(href);
      const ok = bytes !== undefined;
      const body = ok ? decoder.decode(bytes) : "";
      const looksJson =
        ok &&
        (body.trimStart().startsWith("{") ||
          body.trimStart().startsWith("[") ||
          href.includes("/x/") ||
          href.includes("api.") ||
          href.endsWith(".json"));
      const contentType = !ok
        ? "text/plain"
        : looksJson
          ? "application/json; charset=utf-8"
          : href.includes(".js")
            ? "application/javascript; charset=utf-8"
            : href.includes(".css")
              ? "text/css; charset=utf-8"
              : "text/html; charset=utf-8";
      const headers = {
        get: (name: unknown) => {
          const key = String(name).toLowerCase();
          if (key === "content-type") return contentType;
          if (key === "content-length") return ok ? String(body.length) : "0";
          return null;
        },
        has: (name: unknown) => headers.get(name) !== null,
      };
      loop.microtask(() =>
        deferred.resolve({
          ok,
          status: ok ? 200 : 404,
          url: href,
          headers,
          json: (): Thenable<unknown> => {
            const t = loop.deferred<unknown>();
            loop.microtask(() => {
              try {
                t.resolve(JSON.parse(body));
              } catch {
                t.resolve(null);
              }
            });
            return t;
          },
          text: (): Thenable<string> => {
            const t = loop.deferred<string>();
            loop.microtask(() => t.resolve(body));
            return t;
          },
          arrayBuffer: (): Thenable<ArrayBuffer> => {
            const t = loop.deferred<ArrayBuffer>();
            loop.microtask(() => t.resolve((bytes ?? new Uint8Array()).buffer as ArrayBuffer));
            return t;
          },
        }),
      );
    })();
    const tracked = job.finally(() => inflight.delete(tracked));
    inflight.add(tracked);
    return deferred;
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
  };
  installBrowserGlobals(sandbox, session.url);
  installXMLHttpRequest(
    sandbox,
    (sandbox["fetch"] as (input: unknown, init?: unknown) => Promise<object>),
    session.url,
  );

  let error: string | null = null;
  const context = vm.createContext(sandbox);
  // First error wins; include a short stack like the ESM runner so page
  // failures are diagnosable without a debugger.
  const formatError = (e: unknown): string => {
    const message = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error && e.stack ? e.stack.split("\n").slice(0, 6).join(" | ") : "";
    return stack ? `${message} :: ${stack}` : message;
  };
  for (const source of sources) {
    if (source.trim() === "") continue;
    try {
      vm.runInContext(source, context, { timeout: 2000 });
    } catch (e) {
      if (error === null) error = formatError(e);
    }
  }
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
