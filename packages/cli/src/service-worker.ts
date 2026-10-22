/**
 * RFC 0034 — parent side of Service Workers: the registry + the
 * `navigator.serviceWorker` container face.
 *
 * {@link ServiceWorkerRegistry} is attached to a `BrowserNetworkStack` (one
 * per tab session → registrations survive in-tab navigations) and does two
 * jobs:
 *
 *  1. **Interception** — it implements the guest stack's
 *     `ServiceWorkerInterceptor`: every gated request whose client is
 *     controlled (see below) is dispatched to the active worker's realm as a
 *     `fetch` event; `respondWith` resolves to a real `NetworkResponse`,
 *     absence falls through to the wire. The worker's own `fetch()` arrives
 *     as a `swFetch` port message and re-enters the stack via the
 *     `networkFetch` the stack handed us (marked `skipServiceWorker`).
 *
 *  2. **Registration** — `createServiceWorkerContainer` produces the
 *     `navigator.serviceWorker` object the sandbox sees: `register()`
 *     resolves scope, fetches the script through the page's stack
 *     (`destination:"serviceworker"`, `mode:"same-origin"`), spawns the
 *     `sw-realm` worker, then drives install → activate → activated.
 *
 * Control model (documented approximation): a client is "controlled" when an
 * ACTIVE registration's scope prefix-matches the client's URL — for
 * navigations the request URL itself, for subresources/fetch the `initiator`
 * URL. Spec additionally requires the page to have been claimed at load
 * time; our model intercepts a page's post-activation requests immediately
 * (equivalent to `clients.claim()` having run — `claim()` is a no-op that
 * resolves, the effect is already in force).
 */
import { Worker as NodeWorker } from "node:worker_threads";
import type { NetworkRequest, NetworkResponse } from "@browser-engine/guest";

/** Wire shape of a dispatch to the SW realm. */
interface RealmRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Uint8Array;
  clientId?: string;
}
interface RealmResponse {
  url: string;
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** Fetches the SW script bytes — routes through the page's network stack. */
export type SwScriptFetcher = (scriptUrl: string, pageUrl: string) => Promise<Uint8Array>;

export type SwState = "installing" | "installed" | "activating" | "activated" | "redundant";

export class ServiceWorkerRegistration {
  readonly scope: string;
  readonly scriptUrl: string;
  /** Live `worker_threads` handle — null until spawn, dead after dispose. */
  worker: NodeWorker | null = null;
  state: SwState = "installing";
  #seq = 0;
  readonly #pending = new Map<number, { resolve: (v: RealmResponse | null) => void; reject: (e: unknown) => void }>();
  #evaluatedResolve: (() => void) | null = null;
  #evaluated = new Promise<void>((r) => {
    this.#evaluatedResolve = r;
  });

  constructor(scope: string, scriptUrl: string) {
    this.scope = scope;
    this.scriptUrl = scriptUrl;
  }

  evaluated(): Promise<void> {
    return this.#evaluated;
  }

  noteEvaluated(): void {
    this.#evaluatedResolve?.();
  }

  /** Dispatch install/activate/message; resolves when waitUntil settles. */
  dispatch(
    event: "install" | "activate" | "message",
    extra?: { data?: unknown; clientId?: string },
  ): Promise<RealmResponse | null> {
    return this.#dispatch(event, undefined, extra);
  }

  /** Dispatch a `fetch` event; resolves with respondWith's response or null. */
  dispatchFetch(req: RealmRequest): Promise<RealmResponse | null> {
    return this.#dispatch("fetch", req, undefined);
  }

  #dispatch(
    event: string,
    request?: RealmRequest,
    extra?: { data?: unknown; clientId?: string },
  ): Promise<RealmResponse | null> {
    const worker = this.worker;
    if (worker === null || this.state === "redundant") return Promise.resolve(null);
    const id = this.#seq++;
    const p = new Promise<RealmResponse | null>((resolve, reject) =>
      this.#pending.set(id, { resolve, reject }),
    );
    worker.postMessage({
      type: "dispatch",
      id,
      event,
      ...(request !== undefined ? { request } : {}),
      ...(extra?.data !== undefined ? { data: extra.data } : {}),
      ...(extra?.clientId !== undefined ? { clientId: extra.clientId } : {}),
    });
    return p;
  }

  /** Realm replied to a dispatch. */
  settle(id: number, response: RealmResponse | null | undefined, error?: string): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    if (error !== undefined) pending.reject(new Error(error));
    else pending.resolve(response ?? null);
  }

  rejectAll(reason: string): void {
    for (const p of this.#pending.values()) p.reject(new Error(reason));
    this.#pending.clear();
  }
}

export interface ServiceWorkerRegistryDeps {
  /** Fetch the worker script through the page's stack. */
  readonly fetchScript: SwScriptFetcher;
}

export class ServiceWorkerRegistry {
  readonly #deps: ServiceWorkerRegistryDeps;
  /** origin → scope-prefix → registration. */
  readonly #regs = new Map<string, Map<string, ServiceWorkerRegistration>>();
  /** pageUrl → the container's inbound-message sink (worker → page postMessage). */
  readonly #clientSinks = new Map<string, (msg: unknown) => void>();
  /**
   * The networkFetch handed to us by the in-flight intercept — the worker's
   * own `fetch()` loopback resolves against it. A single stack serializes
   * requests through this registry, so the last-seen closure is the right one.
   */
  #networkFetch: ((req: NetworkRequest) => Promise<NetworkResponse>) | null = null;

  constructor(deps: ServiceWorkerRegistryDeps) {
    this.#deps = deps;
  }

  /** Active registration covering `url` — longest scope prefix wins. */
  activeFor(url: string): ServiceWorkerRegistration | null {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    const scopes = this.#regs.get(parsed.origin);
    if (scopes === undefined) return null;
    let best: ServiceWorkerRegistration | null = null;
    for (const [scope, reg] of scopes) {
      if (reg.state !== "activated") continue;
      if (parsed.href.startsWith(scope) && (best === null || scope.length > best.scope.length)) {
        best = reg;
      }
    }
    return best;
  }

  /** `navigator.serviceWorker.register` — fetch → spawn → install → activate. */
  async register(
    scriptUrl: string,
    opts: { scope?: string } | undefined,
    pageUrl: string,
  ): Promise<ServiceWorkerRegistration> {
    const page = new URL(pageUrl);
    const resolvedScript = new URL(scriptUrl, pageUrl).href;
    if (new URL(resolvedScript).origin !== page.origin) {
      throw new Error(`serviceWorker.register: script ${resolvedScript} is cross-origin to ${pageUrl}`);
    }
    const scope = new URL(opts?.scope ?? "./", resolvedScript).href;
    if (new URL(scope).origin !== page.origin) {
      throw new Error(`serviceWorker.register: scope ${scope} is cross-origin to ${pageUrl}`);
    }
    const origin = page.origin;
    let scopes = this.#regs.get(origin);
    if (scopes === undefined) {
      scopes = new Map();
      this.#regs.set(origin, scopes);
    }
    const existing = scopes.get(scope);
    if (existing !== null && existing !== undefined && existing.scriptUrl === resolvedScript && existing.state === "activated") {
      return existing;
    }
    const bytes = await this.#deps.fetchScript(resolvedScript, pageUrl);
    const reg = new ServiceWorkerRegistration(scope, resolvedScript);
    const worker = new NodeWorker(new URL("./sw-realm.js", import.meta.url), {
      workerData: { source: new TextDecoder().decode(bytes), url: resolvedScript, scope },
    });
    reg.worker = worker;
    worker.on("message", (msg: unknown) => this.#onWorkerMessage(reg, msg));
    worker.on("error", () => {
      reg.state = "redundant";
      reg.rejectAll("service worker error");
    });
    worker.on("exit", () => {
      if (reg.state !== "redundant") reg.state = "redundant";
      reg.rejectAll("service worker exited");
    });
    worker.unref();
    scopes.set(scope, reg);
    await reg.evaluated();
    // Lifecycle per Service Workers §"Installation": install event's
    // waitUntil gates the transition to installed; then activate.
    await reg.dispatch("install");
    reg.state = "installed";
    reg.state = "activating";
    await reg.dispatch("activate");
    reg.state = "activated";
    // Notify containers whose pages fall in scope so `controller` lands.
    for (const [url, sink] of this.#clientSinks) {
      if (url.startsWith(scope)) sink({ type: "__swActivated", scope });
    }
    return reg;
  }

  /**
   * The guest-stack seam: dispatch `fetch` to the active worker for the
   * controlled client, or return null to fall through to the wire.
   */
  async handle(
    req: NetworkRequest,
    networkFetch: (req: NetworkRequest) => Promise<NetworkResponse>,
  ): Promise<NetworkResponse | null> {
    this.#networkFetch = networkFetch;
    const clientUrl = req.mode === "navigate" ? req.url : req.initiator;
    if (clientUrl === undefined) return null;
    const reg = this.activeFor(clientUrl);
    if (reg === null) return null;
    const wire: RealmRequest = {
      url: req.url,
      method: req.method ?? "GET",
      headers: { ...(req.headers ?? {}) },
      ...(req.body !== undefined ? { body: req.body } : {}),
      clientId: clientUrl,
    };
    const res = await reg.dispatchFetch(wire);
    if (res === null) return null;
    return { url: res.url !== "" ? res.url : req.url, status: res.status, ok: res.ok, headers: res.headers, body: res.body };
  }

  /** `ServiceWorker.postMessage(page → worker)` — the registration's active face. */
  postToWorker(reg: ServiceWorkerRegistration, msg: unknown, clientId: string): void {
    void reg.dispatch("message", { data: msg, clientId });
  }

  addClientSink(pageUrl: string, sink: (msg: unknown) => void): void {
    this.#clientSinks.set(pageUrl, sink);
  }

  removeClientSink(pageUrl: string): void {
    this.#clientSinks.delete(pageUrl);
  }

  #onWorkerMessage(reg: ServiceWorkerRegistration, raw: unknown): void {
    const msg = raw as {
      type?: string;
      id?: number;
      response?: RealmResponse | null;
      error?: string;
      req?: RealmRequest;
      msg?: unknown;
      clientId?: string;
    };
    if (msg.type === "evaluated") {
      reg.noteEvaluated();
      return;
    }
    if (msg.type === "result" && msg.id !== undefined) {
      reg.settle(msg.id, msg.response ?? null, msg.error);
      return;
    }
    if (msg.type === "swFetch" && msg.id !== undefined && msg.req !== undefined) {
      const id = msg.id;
      const fetcher = this.#networkFetch;
      const finish = (payload: object): void => reg.worker?.postMessage({ type: "swFetchResult", id, ...payload });
      if (fetcher === null) {
        finish({ ok: false, error: "no network channel" });
        return;
      }
      const req: NetworkRequest = {
        url: msg.req.url,
        method: msg.req.method,
        headers: msg.req.headers,
        ...(msg.req.body !== undefined ? { body: msg.req.body } : {}),
        skipServiceWorker: true,
      };
      fetcher(req).then(
        (res) =>
          finish({
            ok: true,
            response: { url: res.url, status: res.status, ok: res.ok, headers: { ...res.headers }, body: res.body },
          }),
        (err: unknown) => finish({ ok: false, error: String(err) }),
      );
      return;
    }
    if (msg.type === "clientMessage") {
      const sink = msg.clientId !== undefined ? this.#clientSinks.get(msg.clientId) : undefined;
      sink?.(msg.msg);
    }
  }

  /** Terminate every live worker — called on session teardown. */
  dispose(): void {
    for (const scopes of this.#regs.values()) {
      for (const reg of scopes.values()) {
        reg.state = "redundant";
        reg.rejectAll("registry disposed");
        void reg.worker?.terminate();
        reg.worker = null;
      }
    }
    this.#clientSinks.clear();
  }
}

// ---- navigator.serviceWorker container --------------------------------------

export interface SwContainerDeps {
  readonly registry: ServiceWorkerRegistry;
  readonly pageUrl: string;
  /** Schedule an inbound (worker→page) message task on the page's loop. */
  readonly postTask: (fn: () => void) => void;
}

/** The `ServiceWorker` handle the page sees (registration.active / controller). */
interface SwHandle {
  readonly scriptURL: string;
  readonly state: string;
  postMessage(msg: unknown): void;
}

function swHandleOf(registry: ServiceWorkerRegistry, reg: ServiceWorkerRegistration, pageUrl: string): SwHandle {
  return {
    scriptURL: reg.scriptUrl,
    get state() {
      return reg.state;
    },
    postMessage: (msg: unknown): void => {
      registry.postToWorker(reg, msg, pageUrl);
    },
  };
}

/**
 * The `ServiceWorkerContainer` face (`navigator.serviceWorker`). The page
 * registers itself as a client sink so `Client.postMessage` from the worker
 * arrives as a real `message` event on the container — dispatched through
 * the page's own event loop via `postTask`.
 */
export function createServiceWorkerContainer(deps: SwContainerDeps): object {
  const { registry, pageUrl, postTask } = deps;
  const messageListeners: ((ev: { data: unknown }) => void)[] = [];
  let onmessage: ((ev: { data: unknown }) => void) | null = null;

  const deliver = (data: unknown): void => {
    postTask(() => {
      const ev = { data };
      onmessage?.(ev);
      for (const fn of [...messageListeners]) fn(ev);
    });
  };
  registry.addClientSink(pageUrl, deliver);

  const container = {
    register(scriptURL: unknown, opts?: { scope?: string }): Promise<object> {
      return registry.register(String(scriptURL), opts, pageUrl).then((reg) => ({
        scope: reg.scope,
        active: swHandleOf(registry, reg, pageUrl),
        installing: null,
        waiting: null,
        updateViaCache: "imports",
      }));
    },
    getRegistration(clientURL?: unknown): Promise<object | undefined> {
      const url = typeof clientURL === "string" ? clientURL : pageUrl;
      const reg = registry.activeFor(url);
      return Promise.resolve(
        reg === null
          ? undefined
          : { scope: reg.scope, active: swHandleOf(registry, reg, pageUrl), installing: null, waiting: null },
      );
    },
    get ready(): Promise<object> {
      const reg = registry.activeFor(pageUrl);
      if (reg !== null) {
        return Promise.resolve({ scope: reg.scope, active: swHandleOf(registry, reg, pageUrl) });
      }
      return new Promise((resolve) => {
        const poll = (): void => {
          const r = registry.activeFor(pageUrl);
          if (r !== null) resolve({ scope: r.scope, active: swHandleOf(registry, r, pageUrl) });
          else postTask(poll);
        };
        postTask(poll);
      });
    },
    get controller(): object | null {
      const reg = registry.activeFor(pageUrl);
      return reg === null ? null : swHandleOf(registry, reg, pageUrl);
    },
    addEventListener(type: unknown, fn: unknown): void {
      if (String(type) === "message" && typeof fn === "function") {
        messageListeners.push(fn as (ev: { data: unknown }) => void);
      }
    },
    removeEventListener(type: unknown, fn: unknown): void {
      if (String(type) !== "message") return;
      const i = messageListeners.indexOf(fn as (ev: { data: unknown }) => void);
      if (i >= 0) messageListeners.splice(i, 1);
    },
    get onmessage(): unknown {
      return onmessage;
    },
    set onmessage(fn: unknown) {
      onmessage = typeof fn === "function" ? (fn as (ev: { data: unknown }) => void) : null;
    },
  };
  return container;
}
