import vm from "node:vm";

import type { FineSession } from "./fine.js";
import { buildDocumentApi } from "./script.js";
import { BROWSER_USER_AGENT, defaultFetch, type FetchFn } from "./loader.js";
import { makeBlobClass, makeFileClass, globalObjectUrls } from "@browser-engine/guest";
import type { GuestBrowserFetch } from "./event-loop.js";

export interface ModuleEntry {
  readonly url: string;
  readonly source: string;
}

export interface ModuleRunResult {
  readonly supported: boolean;
  readonly evaluated: number;
  readonly linked: number;
  readonly failed: number;
  readonly errors: readonly string[];
  readonly importedUrls: readonly string[];
  readonly mutations: number;
  /** Present only when the run used `keepAlive`: number of guest timers still armed. */
  readonly liveTimers?: number;
  /** Present only with `keepAlive`: wait for in-flight guest fetches/timers once. */
  readonly settle?: (maxMs?: number) => Promise<void>;
  /** Present only with `keepAlive`: total DOM mutations performed so far. */
  readonly getMutations?: () => number;
}

type SourceTextModuleCtor = new (
  code: string,
  options: {
    identifier?: string;
    context?: vm.Context;
    lineOffset?: number;
    columnOffset?: number;
    initializeImportMeta?: (meta: ImportMeta, module: { identifier: string }) => void;
    importModuleDynamically?: (
      specifier: string,
      referrer: { identifier: string },
    ) => Promise<unknown>;
  },
) => {
  status: string;
  identifier: string;
  link: (linker: (specifier: string, referrer: { identifier: string }) => unknown) => Promise<void>;
  evaluate: () => Promise<{ result: unknown }>;
  namespace?: unknown;
};

function getSourceTextModule(): SourceTextModuleCtor | null {
  const ctor = (vm as unknown as { SourceTextModule?: SourceTextModuleCtor }).SourceTextModule;
  return typeof ctor === "function" ? ctor : null;
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
        // Guest code may throw here; swallowed by design.
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
      event !== null &&
      typeof event === "object" &&
      "type" in event &&
      typeof event.type === "string"
        ? event.type
        : typeof event === "string"
          ? event
          : "";
    const set = listeners.get(type);
    if (set === undefined) return true;
    for (const fn of set) {
      try {
        fn(event);
      } catch {
        // Guest code may throw here; swallowed by design.
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
      ? setTimeout(() => {
          try {
            (fn as (d: { didTimeout: boolean; timeRemaining: () => number }) => void)({
              didTimeout: false,
              timeRemaining: () => 12,
            });
          } catch {
            // Guest code may throw here; swallowed by design.
          }
        }, 1)
      : 0;
  sandbox["cancelIdleCallback"] = (id: unknown) => clearTimeout(Number(id));
  sandbox["scrollTo"] = () => {};
  sandbox["scroll"] = () => {};
  sandbox["innerWidth"] = 1280;
  sandbox["innerHeight"] = 800;
  sandbox["devicePixelRatio"] = 1;
  // CSSOM View §5 `screen` + window chrome dimensions (same surface as the
  // classic runner — bundles branch on screen.width during boot).
  sandbox["screen"] = {
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
  if (typeof (URL as { createObjectURL?: unknown }).createObjectURL !== "function") {
    (URL as unknown as { createObjectURL?: unknown }).createObjectURL = (blob: unknown): string =>
      globalObjectUrls.createObjectURL(blob);
    (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL = (url: unknown): void =>
      globalObjectUrls.revokeObjectURL(url);
  }
}


function quietConsole(): Record<string, (...args: unknown[]) => void> {
  const noop = (..._args: unknown[]): void => {};
  return {
    log: noop,
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    dir: noop,
    table: noop,
    group: noop,
    groupEnd: noop,
    groupCollapsed: noop,
    time: noop,
    timeEnd: noop,
    timeLog: noop,
    assert: noop,
    clear: noop,
    count: noop,
    countReset: noop,
  };
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
          // Guest code may throw here; swallowed by design.
        }
      }
      const set = listeners.get(type);
      if (set !== undefined) {
        for (const fn of set) {
          try {
            fn.call(self);
          } catch {
            // Guest code may throw here; swallowed by design.
          }
        }
      }
    };
    self.open = (m: unknown, u: unknown) => {
      method = (typeof m === "string" ? m : "GET").toUpperCase();
      const raw = typeof u === "string" ? u : "";
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
          const rawUrl = (res as { url?: unknown }).url;
          const resUrl = typeof rawUrl === "string" ? rawUrl : url;
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
    appVersion: "5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
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
  const map = new Map<string, string>();
  const storage = {
    get length() {
      return map.size;
    },
    getItem: (k: unknown) => map.get(String(k)) ?? null,
    setItem: (k: unknown, v: unknown) => {
      map.set(String(k), String(v));
    },
    removeItem: (k: unknown) => {
      map.delete(String(k));
    },
    clear: () => {
      map.clear();
    },
    key: (i: unknown) => [...map.keys()][Number(i)] ?? null,
  };
  sandbox["window"] = sandbox;
  sandbox["self"] = sandbox;
  sandbox["globalThis"] = sandbox;
  sandbox["top"] = sandbox;
  sandbox["parent"] = sandbox;
  sandbox["frames"] = sandbox;
  sandbox["location"] = location;
  sandbox["navigator"] = navigator;
  sandbox["history"] = history;
  sandbox["localStorage"] = storage;
  sandbox["sessionStorage"] = storage;
  sandbox["console"] = quietConsole();
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
      const type = typeof t === "string" ? t : "";
      if (type === "navigation") return [navigationEntry];
      if (type === "paint") return paintEntries.slice();
      if (type === "largest-contentful-paint") return lcpEntries.slice();
      if (type === "resource") return [];
      return [];
    },
    getEntriesByName: (name: unknown, type?: unknown) => {
      const n = typeof name === "string" ? name : "";
      const all = [navigationEntry, ...paintEntries, ...lcpEntries];
      return all.filter((e) => e.name === n && (type === undefined || (typeof type === "string" && e.entryType === type)));
    },
    mark: () => {},
    measure: () => {},
    clearMarks: () => {},
    clearMeasures: () => {},
  };
  const viewportW = 1280;
  const viewportH = 800;
  sandbox["matchMedia"] = (q: unknown) => {
    const media = typeof q === "string" ? q : "";
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
  sandbox["queueMicrotask"] = (fn: unknown) => {
    if (typeof fn === "function") {
      queueMicrotask(() => {
        try {
          (fn as () => void)();
        } catch {
          // Guest code may throw here; swallowed by design.
        }
      });
    }
  };
  sandbox["setTimeout"] = (fn: unknown, delay?: unknown) =>
    typeof fn === "function"
      ? setTimeout(() => {
          try {
            (fn as () => void)();
          } catch {
            // Guest code may throw here; swallowed by design.
          }
        }, Number(delay) || 0)
      : 0;
  sandbox["clearTimeout"] = (id: unknown) => clearTimeout(Number(id));
  sandbox["setInterval"] = (fn: unknown, delay?: unknown) =>
    typeof fn === "function"
      ? setInterval(() => {
          try {
            (fn as () => void)();
          } catch {
            // Guest code may throw here; swallowed by design.
          }
        }, Number(delay) || 0)
      : 0;
  sandbox["clearInterval"] = (id: unknown) => clearInterval(Number(id));
  sandbox["requestAnimationFrame"] = (fn: unknown) =>
    typeof fn === "function"
      ? setTimeout(() => {
          try {
            (fn as (t: number) => void)(performance.now());
          } catch {
            // Guest code may throw here; swallowed by design.
          }
        }, 16)
      : 0;
  sandbox["cancelAnimationFrame"] = (id: unknown) => clearTimeout(Number(id));
  installObserverGlobals(sandbox);
  installEventTarget(sandbox);
}

function resolveSpecifier(specifier: string, baseUrl: string): string | null {
  if (specifier.startsWith("data:") || specifier.startsWith("blob:")) return specifier;
  if (specifier.startsWith("node:") || specifier.startsWith("nodejs:")) return null;
  const trimmed = specifier.trim();
  if (trimmed === "" || trimmed === "_" || trimmed === "-") return null;
  if (
    !trimmed.startsWith(".") &&
    !trimmed.startsWith("/") &&
    !trimmed.includes(":") &&
    !trimmed.startsWith("\\")
  ) {
    return null;
  }
  try {
    const href = new URL(trimmed, baseUrl).href;
    const path = new URL(href).pathname;
    if (path === "/_" || path.endsWith("/_")) return null;
    return href;
  } catch {
    return null;
  }
}

export function isEsmSupported(): boolean {
  return getSourceTextModule() !== null;
}

export async function runModuleScripts(
  session: FineSession,
  entries: readonly ModuleEntry[],
  fetchFn: FetchFn = defaultFetch,
  options: {
    readonly maxModules?: number;
    readonly sandbox?: Record<string, unknown>;
    readonly context?: import("node:vm").Context;
    readonly inheritWindow?: Record<string, unknown>;
    readonly browserFetch?: GuestBrowserFetch;
    readonly settleMs?: number;
    readonly budgetMs?: number;
    /**
     * Keep the module runtime alive after the initial evaluation: live timers,
     * rAF callbacks, and fetches are not sealed, so an embedding host can keep
     * pumping guest work for continuous rendering. The returned result carries
     * `liveTimers`/`settle`/`getMutations` hooks for exactly that.
     */
    readonly keepAlive?: boolean;
  } = {},
): Promise<ModuleRunResult> {
  const SourceTextModule = getSourceTextModule();
  if (SourceTextModule === null) {
    return {
      supported: false,
      evaluated: 0,
      linked: 0,
      failed: entries.length,
      errors: [
        "ESM not available: restart Node with --experimental-vm-modules to execute type=module scripts",
      ],
      importedUrls: [],
      mutations: 0,
    };
  }
  if (entries.length === 0) {
    return { supported: true, evaluated: 0, linked: 0, failed: 0, errors: [], importedUrls: [], mutations: 0 };
  }

  const maxModules = options.maxModules ?? 250;
  const decoder = new TextDecoder();
  let mutationsOf = (): number => 0;
  let sandbox: Record<string, unknown>;
  let context: import("node:vm").Context;

  const safeRun = (fn: () => void): void => {
    try {
      fn();
    } catch {
      // Guest code may throw here; swallowed by design.
    }
  };
  const browserFetch = options.browserFetch;
  const settleMs = options.settleMs ?? 50;
  const budgetMs = options.budgetMs ?? 1_000;
  const budgetDeadline = Date.now() + Math.max(200, budgetMs);
  let sealed = false;
  const liveTimeouts = new Set<ReturnType<typeof setTimeout>>();
  const liveIntervals = new Set<ReturnType<typeof setInterval>>();
  const inflightFetches = new Set<Promise<unknown>>();
  const trackFetch = <T,>(work: Promise<T>): Promise<T> => {
    if (sealed) {
      return Promise.reject(new Error("module fetch sealed"));
    }
    inflightFetches.add(work);
    return work.finally(() => {
      inflightFetches.delete(work);
    });
  };
  const emptyResponse = (url: string): object => {
    const headers = {
      get: (_name: unknown) => null,
      has: (_name: unknown) => false,
    };
    return {
      ok: false,
      status: 0,
      url,
      headers,
      text: () => Promise.resolve(""),
      json: () => Promise.resolve(null),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    };
  };
  const isLowValueModuleFetch = (url: string): boolean => {
    const u = url.toLowerCase();
    return (
      u.includes("log-reporter") ||
      u.includes("bili-collect") ||
      u.includes("google-analytics") ||
      u.includes("googletagmanager") ||
      u.includes("/gtag/") ||
      u.includes("hm.baidu.com") ||
      u.includes("sentry") ||
      u.includes("hotjar") ||
      u.includes("clarity.ms") ||
      u.includes("sensorsdata") ||
      u.endsWith(".map") ||
      u.includes("favicon")
    );
  };
  const makeFetch = () => {
    if (browserFetch !== undefined) {
      return (input: unknown, init?: unknown): Promise<object> => {
        let url = String(input);
        try {
          url = new URL(url, session.url).href;
        } catch {
          // Invalid URL input: keep the raw/fallback value.
        }
        if (sealed || Date.now() >= budgetDeadline || isLowValueModuleFetch(url)) {
          return Promise.resolve(emptyResponse(url));
        }
        return trackFetch(browserFetch(input, init) as Promise<object>);
      };
    }
    return (input: unknown): Promise<object> => {
      let url = String(input);
      try {
        url = new URL(url, session.url).href;
      } catch {
        // Invalid URL input: keep the raw/fallback value.
      }
      if (sealed || Date.now() >= budgetDeadline || isLowValueModuleFetch(url)) {
        return Promise.resolve(emptyResponse(url));
      }
      return trackFetch(
        (async (): Promise<object> => {
          const bytes = await fetchFn(url);
          const ok = bytes !== undefined;
          const body = ok ? decoder.decode(bytes) : "";
          const looksJson =
            ok &&
            (body.trimStart().startsWith("{") ||
              body.trimStart().startsWith("[") ||
              url.includes("/x/") ||
              url.includes("api.") ||
              url.endsWith(".json"));
          const contentType = !ok
            ? "text/plain"
            : looksJson
              ? "application/json; charset=utf-8"
              : url.includes(".js")
                ? "application/javascript; charset=utf-8"
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
          return {
            ok,
            status: ok ? 200 : 404,
            url,
            headers,
            text: () => Promise.resolve(body),
            json: () => {
              try {
                return Promise.resolve(JSON.parse(body) as unknown);
              } catch {
                return Promise.resolve(null);
              }
            },
            arrayBuffer: () => Promise.resolve((bytes ?? new Uint8Array()).buffer),
          };
        })(),
      );
    };
  };

  const installTimers = (target: Record<string, unknown>): void => {
    // keepAlive timers must not hold the host process open: the host drives
    // pumping explicitly, so every guest handle is unref'd.
    const unref = (id: NodeJS.Timeout): NodeJS.Timeout => {
      id.unref?.();
      return id;
    };
    target["queueMicrotask"] = (fn: unknown) => {
      if (typeof fn === "function") queueMicrotask(fn as () => void);
    };
    target["setTimeout"] = (fn: unknown, delay?: unknown) => {
      if (typeof fn !== "function" || sealed) return 0;
      const id = unref(setTimeout(() => {
        liveTimeouts.delete(id);
        if (!sealed) safeRun(fn as () => void);
      }, Number(delay) || 0));
      liveTimeouts.add(id);
      return id as unknown as number;
    };
    target["clearTimeout"] = (id: unknown) => {
      const handle = id as ReturnType<typeof setTimeout>;
      liveTimeouts.delete(handle);
      clearTimeout(handle);
    };
    target["setInterval"] = (fn: unknown, delay?: unknown) => {
      if (typeof fn !== "function" || sealed) return 0;
      const id = unref(setInterval(() => {
        if (sealed) {
          clearInterval(id);
          liveIntervals.delete(id);
          return;
        }
        safeRun(fn as () => void);
      }, Number(delay) || 0));
      liveIntervals.add(id);
      return id as unknown as number;
    };
    target["clearInterval"] = (id: unknown) => {
      const handle = id as ReturnType<typeof setInterval>;
      liveIntervals.delete(handle);
      clearInterval(handle);
    };
    target["requestAnimationFrame"] = (fn: unknown) => {
      if (typeof fn !== "function" || sealed) return 0;
      const id = unref(setTimeout(() => {
        liveTimeouts.delete(id);
        if (!sealed) safeRun(() => (fn as (t: number) => void)(performance.now()));
      }, 16));
      liveTimeouts.add(id);
      return id as unknown as number;
    };
    target["cancelAnimationFrame"] = (id: unknown) => {
      const handle = id as ReturnType<typeof setTimeout>;
      liveTimeouts.delete(handle);
      clearTimeout(handle);
    };
  };
  const sealModuleRuntime = (): void => {
    sealed = true;
    for (const id of liveTimeouts) clearTimeout(id);
    liveTimeouts.clear();
    for (const id of liveIntervals) clearInterval(id);
    liveIntervals.clear();
    inflightFetches.clear();
    sandbox["fetch"] = (input: unknown) => {
      let url = String(input);
      try {
        url = new URL(url, session.url).href;
      } catch {
        // Invalid URL input: keep the raw/fallback value.
      }
      return Promise.resolve(emptyResponse(url));
    };
    installTimers(sandbox);
  };

  if (options.context !== undefined && options.sandbox !== undefined) {
    sandbox = options.sandbox;
    context = options.context;
    installTimers(sandbox);
    sandbox["fetch"] = makeFetch();
    installXMLHttpRequest(sandbox, sandbox["fetch"] as (input: unknown, init?: unknown) => Promise<object>, session.url);
  } else {
    const api = buildDocumentApi(session, { geometryMode: "stub", styleMode: "fast" });
    mutationsOf = api.mutations;
    sandbox = {
      document: api.document,
      ...api.globals,
    };
    sandbox["fetch"] = makeFetch();
    installBrowserGlobals(sandbox, session.url);
    installObserverGlobals(sandbox);
    installEventTarget(sandbox);
    installTimers(sandbox);
    installXMLHttpRequest(sandbox, sandbox["fetch"] as (input: unknown, init?: unknown) => Promise<object>, session.url);
    if (options.inheritWindow !== undefined) {
      const skip = new Set([
        "document",
        "window",
        "self",
        "globalThis",
        "fetch",
        "queueMicrotask",
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "requestAnimationFrame",
        "cancelAnimationFrame",
      ]);
      for (const [key, value] of Object.entries(options.inheritWindow)) {
        if (skip.has(key)) continue;
        if (
          key.startsWith("__") ||
          key.startsWith("_") ||
          key === "abtest" ||
          key === "spmReportData" ||
          key === "reportConfig"
        ) {
          sandbox[key] = value;
        }
      }
    }
    context = vm.createContext(sandbox);
  }

  const moduleCache = new Map<string, InstanceType<SourceTextModuleCtor>>();
  const sourceCache = new Map<string, string>();
  const importedUrls: string[] = [];
  const errors: string[] = [];
  let failed = 0;

  for (const entry of entries) {
    sourceCache.set(entry.url, entry.source);
  }

  const loadSource = async (url: string): Promise<string | null> => {
    const cached = sourceCache.get(url);
    if (cached !== undefined) return cached;
    if (sealed || Date.now() >= budgetDeadline) {
      return null;
    }
    if (moduleCache.size + sourceCache.size > maxModules) {
      errors.push(`module graph exceeded maxModules=${maxModules} at ${url}`);
      return null;
    }
    try {
      const bytes = await fetchFn(url);
      if (bytes === undefined) {
        return null;
      }
      const src = decoder.decode(bytes);
      sourceCache.set(url, src);
      importedUrls.push(url);
      return src;
    } catch (e) {
      errors.push(`module fetch error ${url}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };

  const linker = async (
    specifier: string,
    referrer: { identifier: string },
  ): Promise<InstanceType<SourceTextModuleCtor>> => {
    const resolved = resolveSpecifier(specifier, referrer.identifier);
    if (resolved === null) {
      failed += 1;
      const message = `unsupported module specifier '${specifier}' from ${referrer.identifier}`;
      errors.push(message);
      throw new Error(message);
    }
    const existing = moduleCache.get(resolved);
    if (existing !== undefined) return existing;

    if (resolved.startsWith("data:")) {
      const comma = resolved.indexOf(",");
      const payload = comma >= 0 ? resolved.slice(comma + 1) : "";
      const code = decodeURIComponent(payload);
      const mod = new SourceTextModule(code, {
        identifier: resolved,
        context,
        initializeImportMeta: (meta) => {
          (meta as { url: string }).url = resolved;
        },
        importModuleDynamically: (spec, ref) => linker(spec, ref),
      });
      moduleCache.set(resolved, mod);
      await mod.link(linker);
      return mod;
    }

    const source = await loadSource(resolved);
    if (source === null) {
      failed += 1;
      const message = `module not found: ${resolved}`;
      errors.push(message);
      throw new Error(message);
    }
    const mod = new SourceTextModule(source, {
      identifier: resolved,
      context,
      initializeImportMeta: (meta) => {
        (meta as { url: string }).url = resolved;
      },
      importModuleDynamically: (spec, ref) => linker(spec, ref),
    });
    moduleCache.set(resolved, mod);
    await mod.link(linker);
    return mod;
  };

  const withTimeout = async <T,>(work: Promise<T>, ms: number, label: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => {
            try {
              sealModuleRuntime();
            } catch {
              // Guest code may throw here; swallowed by design.
            }
            reject(new Error(label));
          }, ms);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const remainingMs = (): number => Math.max(0, budgetDeadline - Date.now());
  const profile = process.env["ENGINE_PROFILE"] === "1";
  const forceSealTimer = setTimeout(() => {
    try {
      sealModuleRuntime();
    } catch {
      // Guest code may throw here; swallowed by design.
    }
  }, Math.max(50, budgetMs));

  let evaluated = 0;
  for (const entry of entries) {
    if (remainingMs() <= 20 || sealed) {
      errors.push(`module budget exhausted before ${entry.url}`);
      break;
    }
    try {
      let mod = moduleCache.get(entry.url);
      if (mod === undefined) {
        const tLink0 = performance.now();
        mod = new SourceTextModule(entry.source, {
          identifier: entry.url,
          context,
          initializeImportMeta: (meta) => {
            (meta as { url: string }).url = entry.url;
          },
          importModuleDynamically: (spec, ref) => linker(spec, ref),
        });
        moduleCache.set(entry.url, mod);
        const linkMs = Math.min(8_000, Math.max(80, remainingMs()));
        await withTimeout(mod.link(linker), linkMs, `module link timeout ${entry.url}`);
        if (profile) {
          console.error(
            `[profile] module.link ${Math.round(performance.now() - tLink0)}ms size=${entry.source.length} url=${entry.url.slice(0, 80)}`,
          );
        }
      }
      if (mod.status !== "evaluated" && !sealed) {
        const tEval0 = performance.now();
        const evalMs = Math.min(10_000, Math.max(80, remainingMs()));
        await withTimeout(mod.evaluate(), evalMs, `module evaluate timeout ${entry.url}`);
        if (profile) {
          console.error(
            `[profile] module.eval ${Math.round(performance.now() - tEval0)}ms status=${mod.status}`,
          );
        }
      }
      if (mod.status === "evaluated") evaluated += 1;
    } catch (e) {
      failed += 1;
      const msg = e instanceof Error ? e.message : String(e);
      const stack = e instanceof Error && e.stack ? e.stack.split("\n").slice(0, 6).join(" | ") : "";
      errors.push(`module evaluate ${entry.url}: ${msg}${stack ? " :: " + stack : ""}`);
      if (profile) {
        console.error(`[profile] module.error ${msg.slice(0, 120)}`);
      }
    }
  }
  clearTimeout(forceSealTimer);

  if (options.keepAlive) {
    // keepAlive: the runtime stays unsealed so the host can keep pumping guest
    // timers/rAF for continuous rendering. The budget timer must NOT fire either.
    clearTimeout(forceSealTimer);
  }
  const settleDeadline = Date.now() + Math.min(settleMs, Math.max(0, remainingMs()));
  while (Date.now() < settleDeadline) {
    if (inflightFetches.size > 0) {
      const pending = Promise.allSettled([...inflightFetches]);
      await Promise.race([
        pending,
        new Promise<void>((resolve) => setTimeout(resolve, 16)),
      ]);
      continue;
    }
    if (liveTimeouts.size > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 16));
      continue;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (inflightFetches.size === 0 && liveTimeouts.size === 0) break;
  }
  if (!options.keepAlive) {
    sealModuleRuntime();
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  if (!options.keepAlive) {
    return {
      supported: true,
      evaluated,
      linked: moduleCache.size,
      failed,
      errors: errors.slice(0, 12),
      importedUrls,
      mutations: mutationsOf(),
    };
  }
  return {
    supported: true,
    evaluated,
    linked: moduleCache.size,
    failed,
    errors: errors.slice(0, 12),
    importedUrls,
    mutations: mutationsOf(),
    liveTimers: liveTimeouts.size + liveIntervals.size,
    settle: async (maxMs = 500): Promise<void> => {
      const deadline = Date.now() + Math.max(0, maxMs);
      while (Date.now() < deadline) {
        if (inflightFetches.size === 0 && liveTimeouts.size === 0 && liveIntervals.size === 0) break;
        await new Promise<void>((resolve) => setTimeout(resolve, 16));
      }
    },
    getMutations: mutationsOf,
  };
}

