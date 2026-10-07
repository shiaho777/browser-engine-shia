/**
 * wpt-suite.ts — the OFFICIAL Web Platform Tests importer + runner.
 *
 * This ingests real WPT test files — the `.html` testharness format and the
 * `.window.js` / `.any.js` script formats — exactly as they ship in the
 * web-platform-tests repository, and runs them against this engine on real V8,
 * scoring per-subtest PASS/FAIL the way wptrunner does. Point {@link
 * runWptDirectory} at a real `wpt/` checkout and it walks the tree, resolving
 * each test's `<script src>` includes against the checkout (the shared
 * `/resources/testharness.js` is satisfied by our own harness; other includes
 * are read from disk), and aggregates the results.
 *
 * Honesty: the engine is NOT a full browser, so tests exercising APIs it does
 * not implement (e.g. `document.createElement`, events) report ERROR — exactly
 * as a partial implementation scores against WPT. The runner is the real thing;
 * the pass rate is whatever the engine genuinely earns. We do not vendor the
 * multi-gigabyte suite; we vendor a few real-format fixtures to prove the
 * importer and let it run any checkout you provide.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { MessageChannel, MessagePort, makeBroadcastChannelClass } from "@browser-engine/guest";

import { FineSession } from "./fine.js";
import { buildDocumentApi } from "./script.js";
import { createStageTraceCollector, type StageTrace } from "./stage-trace.js";
import { createAssertions, OptionalFeatureUnsupportedError, WptAssertionError } from "./testharness.js";
import {
  computedRole,
  accessibleName,
  accessibilityProperties,
  isConnectedToDocument,
  type A11yContext,
  type A11yElement,
} from "./accessibility.js";
import {
  makeGeneratedContentResolver,
  type GeneratedContentResolver,
} from "./generated-content.js";
import { makeCssNamespace } from "./css-namespace.js";
import { TYPED_OM_GLOBALS } from "./typed-om.js";
import { DEFAULT_MEDIA_ENVIRONMENT, mediaQueryListMatches } from "@browser-engine/css-parser";
import type { NodeId } from "@browser-engine/ir";
import {
  AbortController,
  AbortSignal,
  AnimationEvent,
  CompositionEvent,
  CustomEvent,
  DOMException,
  Event,
  EventTarget,
  FileReader,
  FocusEvent,
  InputEvent,
  KeyboardEvent,
  Lock,
  LockManager,
  MessageEvent,
  MouseEvent,
  StorageEvent,
  StorageImpl,
  StorageManagerImpl,
  TransitionEvent,
  UIEvent,
  WheelEvent,
  createStorageProxy,
  globalObjectUrls,
  makeBlobClass,
  makeFileClass,
} from "@browser-engine/guest";
import type { WptReport, WptSubtest } from "./wpt.js";

/** Aggregate result of running a directory of WPT tests. */
export interface WptSuiteReport {
  readonly files: number;
  readonly subtests: number;
  readonly passed: number;
  readonly failed: number;
  readonly errored: number;
  /** Per-file reports, keyed by the test's path relative to the suite root. */
  readonly byFile: ReadonlyMap<string, WptReport>;
  /** Optional aggregate query trace across every WPT file in this suite run. */
  readonly trace?: StageTrace;
}

/** Options for WPT suite execution. */
export interface WptSuiteOptions {
  /**
   * Attach query-stage trace evidence. The trace observes the fine-grained
   * session WPT actually uses, and performs one final render per file so
   * qFinePaint/qFineLayout evidence is present even for pure DOM assertions.
   */
  readonly trace?: boolean;
  /** Document URL used for URL/base resolution inside the engine. */
  readonly documentUrl?: string;
}

/** How to resolve a support resource include to its source text (or `undefined`). */
export type ResourceResolver = (src: string) => string | undefined;
const encodeResource = (s: string): Uint8Array => new TextEncoder().encode(s);

// Host objects already reparented into some guest realm — re-reparented on
// every run so each file's fresh realm sees its own intrinsics.
const reparentedToRealm = new WeakSet<object>();

/** Resource paths that OUR harness supplies, so a real include of them is a no-op. */
function isHarnessResource(src: string): boolean {
  // Only skip what we actually provide (our testharness + the testharnessreport
  // + testdriver shims). `/common/` utility scripts are NOT ours — they must
  // load from the checkout (e.g. subset-tests-by-key.js defines the
  // `subsetTestByKey` the URL tests call). idlharness.js and WebIDLParser.js
  // also load from the checkout — our `fetch` resolves their `/interfaces/*.idl`
  // requests against the same checkout.
  return /testharness(report)?\.js|testdriver/.test(src);
}

// ---------------------------------------------------------------------------
// Async harness — full testharness `test` / `async_test` / `promise_test`.
// ---------------------------------------------------------------------------

interface AsyncHarness {
  readonly globals: Record<string, unknown>;
  readonly subtests: WptSubtest[];
  /** Resolves once every async/promise subtest has settled (or timed out). */
  settle(timeoutMs: number): Promise<void>;
}

function buildAsyncHarness(): AsyncHarness {
  const subtests: WptSubtest[] = [];
  const pending: Promise<void>[] = [];

  const push = (name: string, status: WptSubtest["status"], message: string | null): void => {
    subtests.push({ name, status, message });
  };
  const classify = (error: unknown): WptSubtest => ({
    name: "",
    status: error instanceof OptionalFeatureUnsupportedError
      ? "PRECONDITION_FAILED"
      : error instanceof WptAssertionError ? "FAIL" : "ERROR",
    message: error instanceof Error ? error.message : String(error),
  });

  /** The per-test tool object (`t`): the real harness binds it as `this` AND
   * passes it as the first test argument. */
  interface TestTools {
    step(f: unknown, ...args: unknown[]): unknown;
    step_func(f: unknown): (...args: unknown[]) => unknown;
    step_func_done(f: unknown): (...args: unknown[]) => void;
    unreached_func(msg?: unknown): () => void;
    timeout(): void;
    set_timeout(f: unknown, ms?: unknown): void;
    step_timeout(f: unknown, ms?: unknown): number | undefined;
    done(): void;
    add_cleanup(f: unknown): void;
    /** @internal The settle path (cleanups + finish) — promise_test uses it. */
    _settle(status: WptSubtest["status"], message: string | null): void;
  }

  /** Promises returned by cleanup functions — awaited before the file's
   *  final settle and (for promise_test) before the next test starts. */
  const cleanupPromises: Promise<unknown>[] = [];
  /** testharness `add_cleanup` — file-scope cleanups run at settle. */
  const fileCleanups: Array<() => unknown> = [];
  const makeTools = (finish: (status: WptSubtest["status"], message: string | null) => void): TestTools => {
    // Cleanup functions run once, when the test settles (real testharness
    // semantics — without them, tests that mutate the document pollute every
    // later test in the same file). Returned promises are collected so the
    // harness can wait for async releases (e.g. held locks) to land.
    const cleanups: Array<() => void> = [];
    let settled = false;
    const settle = (status: WptSubtest["status"], message: string | null): void => {
      if (settled) return;
      settled = true;
      const list = cleanups.splice(0);
      for (const cleanup of list) {
        try {
          const r = cleanup() as unknown;
          if (r !== null && typeof r === "object" && typeof (r as { then?: unknown }).then === "function") {
            cleanupPromises.push(r as Promise<unknown>);
          }
        } catch {
          // Cleanup errors must not mask the test result.
        }
      }
      finish(status, message);
    };
    const tools: TestTools = {
      step(f, ...args) {
        try {
          // testharness binds `this` to the test object inside stepped
          // functions (tests call `this.step_func(...)` on themselves).
          return typeof f === "function"
            ? (f as (this: TestTools, ...a: unknown[]) => unknown).apply(tools, args)
            : undefined;
        } catch (e) {
          const c = classify(e);
          settle(c.status, c.message);
          return undefined;
        }
      },
      step_func(f) {
        return (...args: unknown[]) => tools.step(f, ...args);
      },
      step_func_done(f) {
        return (...args: unknown[]) => {
          tools.step(f, ...args);
          settle("PASS", null);
        };
      },
      unreached_func(msg) {
        return () =>
          settle("FAIL", `unreached: ${String(msg)}`);
      },
      timeout() {
        settle("FAIL", "Test timed out");
      },
      set_timeout(f, ms) {
        if (typeof f === "function") setTimeout(() => tools.step(f), Number(ms) || 0);
      },
      step_timeout(f, ms) {
        if (typeof f !== "function") return undefined;
        return setTimeout(() => {
          tools.step(f);
        }, Number(ms) || 0) as unknown as number;
      },
      done() {
        settle("PASS", null);
      },
      add_cleanup(f) {
        if (typeof f === "function") cleanups.push(f as () => void);
      },
      _settle: settle,
    };
    // Keep the internal settle hook off enumeration paths.
    Object.defineProperty(tools, "_settle", { value: settle, enumerable: false });
    return tools;
  };

  const test = (func: unknown, name: unknown): void => {
    if (typeof func !== "function") return;
    const n = typeof name === "string" ? name : "(unnamed test)";
    // A synchronous test still gets the tool object as `this` (tests call
    // `this.step_func(...)`), and a failing step marks the whole test failed.
    const outcome: { status?: WptSubtest["status"]; message?: string | null } = {};
    const tools = makeTools((status, message) => {
      outcome.status ??= status;
      outcome.message ??= message;
    });
    try {
      (func as (this: TestTools, t: TestTools) => void).call(tools, tools);
    } catch (e) {
      const c = classify(e);
      push(n, c.status, c.message);
      return;
    }
    if (outcome.status !== undefined) push(n, outcome.status, outcome.message ?? null);
    else push(n, "PASS", null);
  };

  const asyncTest = (func: unknown, name: unknown): object => {
    const n = typeof name === "string" ? name : (typeof func === "string" ? func : "(unnamed async_test)");
    let settled = false;
    let resolveDone!: () => void;
    pending.push(new Promise<void>((r) => (resolveDone = r)));
    const finish = (status: WptSubtest["status"], message: string | null): void => {
      if (settled) return;
      settled = true;
      push(n, status, message);
      resolveDone();
    };
    const t = makeTools(finish);
    if (typeof func === "function") t.step(func, t);
    return t;
  };

  // promise_tests run SEQUENTIALLY (real testharness semantics): each test
  // starts only after the previous test settled AND its async cleanups
  // resolved — otherwise held locks / pending timers leak between tests.
  let promiseSeq = Promise.resolve();
  const promiseTest = (func: unknown, name: unknown): void => {
    const n = typeof name === "string" ? name : "(unnamed promise_test)";
    if (typeof func !== "function") return;
    let resolveDone!: () => void;
    pending.push(new Promise<void>((r) => (resolveDone = r)));
    promiseSeq = promiseSeq.then(
      () =>
        new Promise<void>((testDone) => {
          const cleanupsBefore = cleanupPromises.length;
          let settled = false;
          const finish = (status: WptSubtest["status"], message: string | null): void => {
            if (settled) return;
            settled = true;
            push(n, status, message);
            resolveDone();
            // Wait for THIS test's async cleanups before the next test runs.
            void Promise.allSettled(cleanupPromises.slice(cleanupsBefore)).then(() => testDone());
          };
          const t = makeTools(finish);
          // Completion goes through _settle so async cleanups run and are
          // awaited before the NEXT promise_test starts.
          void Promise.resolve()
            .then(() => (func as (t: TestTools) => unknown)(t))
            .then(
              () => t._settle("PASS", null),
              (e: unknown) => {
                const c = classify(e);
                t._settle(c.status, c.message);
              },
            );
        }),
    );
  };

  /**
   * testharness.js `EventWatcher`: promise-based DOM event ordering checks.
   * `wait_for(types)` resolves when the expected sequence has fired; a stray
   * or out-of-order event fails the test via step_func.
   */
  class EventWatcher {
    readonly #handler: (evt: { type: string }) => void;
    #waiting: { types: string[]; resolve: (v: unknown) => void } | null = null;
    #recorded: unknown[] | null = null;

    constructor(
      testTools: TestTools,
      watchedNode: { addEventListener(t: string, f: unknown, c?: boolean): void; removeEventListener(t: string, f: unknown): void },
      eventTypes: string | readonly string[],
      timeoutPromise?: () => Promise<unknown>,
    ) {
      const types = typeof eventTypes === "string" ? [eventTypes] : [...eventTypes];
      const tools = testTools;
      this.#handler = tools.step_func((evt: { type: string }) => {
        if (this.#waiting === null) {
          throw new WptAssertionError(`Not expecting event, but got ${evt.type} event`);
        }
        if (evt.type !== this.#waiting.types[0]) {
          throw new WptAssertionError(
            `Expected ${this.#waiting.types[0]} event, but got ${evt.type} event instead`,
          );
        }
        if (this.#recorded !== null) this.#recorded.push(evt);
        if (this.#waiting.types.length > 1) {
          this.#waiting.types.shift();
          return;
        }
        const resolve = this.#waiting.resolve;
        this.#waiting = null;
        const result = this.#recorded ?? evt;
        this.#recorded = null;
        resolve(result);
      });
      for (const t of types) watchedNode.addEventListener(t, this.#handler, false);
      const node = watchedNode;
      const handler = this.#handler;
      const stop = (): void => {
        for (const t of types) node.removeEventListener(t, handler);
      };
      this.stop_watching = stop;
      tools.add_cleanup?.(stop);
      void timeoutPromise;
    }

    stop_watching: () => void = () => {};

    wait_for(types: string | readonly string[], options?: { record?: string }): Promise<unknown> {
      const list = typeof types === "string" ? [types] : [...types];
      if (options?.record === "all") this.#recorded = [];
      return new Promise((resolve) => {
        this.#waiting = { types: list, resolve };
      });
    }
  }

  const globals: Record<string, unknown> = {
    ...createAssertions(),
    test,
    async_test: asyncTest,
    promise_test: promiseTest,
    // testharness `setup(fn)` runs before the first test; our harness runs
    // scripts after the DOM is fully built, so invoking immediately preserves
    // ordering (options-object forms are ignored).
    setup: (f: unknown) => {
      if (typeof f === "function") (f as () => void)();
    },
    done: () => undefined,
    add_completion_callback: () => undefined,
    EventWatcher,
    // File-level cleanup (testharness `add_cleanup`) — runs once when the
    // file's tests all settle.
    add_cleanup: (f: unknown) => {
      if (typeof f === "function") fileCleanups.push(f as () => unknown);
    },
    step_timeout: (f: unknown, ms: unknown) =>
      typeof f === "function" ? setTimeout(f as () => void, Number(ms) || 0) : 0,
    setTimeout: (f: unknown, ms: unknown) =>
      typeof f === "function" ? setTimeout(f as () => void, Number(ms) || 0) : 0,
    clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
    queueMicrotask: (f: unknown) => {
      if (typeof f === "function") queueMicrotask(f as () => void);
    },
  };

  const settle = async (timeoutMs: number): Promise<void> => {
    if (pending.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((r) => (timer = setTimeout(r, timeoutMs)));
      await Promise.race([Promise.allSettled(pending), timeout]);
      if (timer !== undefined) clearTimeout(timer);
    }
    // testharness add_cleanup — file-scope cleanups run after every test.
    const list = fileCleanups.splice(0);
    for (const cleanup of list) {
      try {
        const r = cleanup();
        if (r !== null && typeof r === "object" && typeof (r as { then?: unknown }).then === "function") {
          await (r as Promise<unknown>);
        }
      } catch {
        // File cleanups must not mask results.
      }
    }
  };

  return { globals, subtests, settle };
}

// ---------------------------------------------------------------------------
// Running one test file.
// ---------------------------------------------------------------------------

/** Extract `<script>` blocks (inline content and `src` references) in order. */
export function extractScripts(html: string): { src?: string; content: string }[] {
  const scripts: { src?: string; content: string }[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] ?? "";
    const srcMatch = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs);
    if (srcMatch !== null) {
      scripts.push({ src: srcMatch[1] as string, content: "" });
    } else {
      scripts.push({ content: m[2] ?? "" });
    }
  }
  return scripts;
}

/** The `<body>` (or whole doc) HTML to parse as the test's DOM, scripts stripped. */
function documentHtml(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
}

/**
 * Run one WPT testharness HTML test. Inline scripts run in order; `<script src>`
 * to shared harness files is a no-op (we provide the harness), other includes
 * are resolved via `resolveResource` (read from the checkout). Returns the
 * per-subtest report.
 */
export async function runWptHtml(
  html: string,
  resolveResource?: ResourceResolver,
  options: WptSuiteOptions = {},
): Promise<WptReport> {
  const collector = options.trace === true ? createStageTraceCollector() : undefined;
  // The guest vm context exists only after the sandbox is assembled below, so
  // the inline-handler compiler closes over a slot assigned right after.
  let guestContext: vm.Context | null = null;
  const session = new FineSession(
    documentHtml(html),
    options.documentUrl ?? "wpt://doc",
    {
      ...(collector === undefined ? {} : { onQuery: collector.onQuery }),
      loadExternalSheet: (href) => {
        const source = resolveResource?.(href);
        return source === undefined ? undefined : encodeResource(source);
      },
    },
  );
  const { document, globals } = buildDocumentApi(session, {
    inlineHandlerCompiler: (body): unknown => vm.runInContext(`(function (event) {\n${body}\n})`, guestContext as vm.Context),
    // a/area activation navigates: update the sandbox location and fire a
    // hashchange at the window (only when the fragment actually changed).
    hashNavigator: (fragment) => {
      const oldURL = String(sandboxLocation["href"]);
      const base = oldURL.split("#")[0] ?? oldURL;
      const newURL = fragment === "" ? base : `${base}#${fragment}`;
      if (newURL === oldURL) return;
      sandboxLocation["href"] = newURL;
      const handler = sandbox["onhashchange"];
      if (typeof handler === "function") (handler as (e: unknown) => void)({ oldURL, newURL });
    },
  });
  const harness = buildAsyncHarness();
  const sandbox: Record<string, unknown> = { document, ...globals, ...harness.globals };
  const sandboxLocation: Record<string, unknown> = {
    href: options.documentUrl ?? "wpt://doc",
    get origin() {
      try {
        const u = new URL(String(this["href"]));
        // `wpt:` is a non-special scheme so URL.origin is "null" — but WPT
        // tests compose `${location.origin}/...` into URLs, which needs a
        // real (non-opaque) origin to round-trip.
        if (u.protocol === "wpt:") return `wpt://${u.host === "" ? "wpt" : u.host}`;
        return u.origin;
      } catch {
        return "null";
      }
    },
    get hash() {
      const href = String(this["href"]);
      const index = href.indexOf("#");
      return index === -1 ? "" : href.slice(index);
    },
    set hash(value) {
      const base = String(this["href"]).split("#")[0];
      this["href"] = value.startsWith("#") ? base + value : base + "#" + value;
    },
  };
  sandbox["location"] = sandboxLocation;
  sandbox["self"] = sandbox;
  sandbox["globalThis"] = sandbox;
  sandbox["window"] = sandbox;
  // The CSS namespace: supports()/escape() run the engine's real supports
  // evaluator and serializer — no stubbed false. Unit factories and
  // registerProperty come from the Typed OM module (per-document registry).
  // WebIDL: interface objects and namespaces on the global are {writable,
  // configurable, NON-enumerable} — plain assignment would make them
  // enumerable and fail idlharness' global-property checks.
  const installGlobal = (name: string, value: unknown): void => {
    Object.defineProperty(sandbox, name, {
      value, writable: true, enumerable: false, configurable: true,
    });
  };
  installGlobal("CSS", makeCssNamespace());
  for (const [name, ctor] of Object.entries(TYPED_OM_GLOBALS)) {
    installGlobal(name, ctor);
  }
  // matchMedia → MediaQueryList over the harness media environment.
  sandbox["matchMedia"] = (query: unknown) => {
    const media = String(query);
    const mql: Record<string, unknown> = {
      media,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    };
    Object.defineProperty(mql, "matches", {
      get: () => mediaQueryListMatches(media, DEFAULT_MEDIA_ENVIRONMENT),
      enumerable: true,
    });
    return mql;
  };
  // ---- Window named access (HTML §7.2.4) --------------------------------
  // `window.foo` resolves elements whose `id` is `foo` (any element) or whose
  // `name` is `foo` on the nameable tags. The value is a LIVE lookup — a
  // getter per registered name — and names register eagerly at parse plus on
  // every later id/name mutation or subtree insertion (the session's
  // mutation seam, the same one MutationObserver rides).
  const NAMEABLE_TAGS = new Set([
    "a", "applet", "area", "embed", "form", "frame", "frameset", "iframe", "img", "object",
  ]);
  interface NamedElement {
    getAttribute(name: string): string | null;
    readonly localName: string;
    readonly children: ArrayLike<NamedElement>;
  }
  const namedElements = (name: string): NamedElement[] => {
    const out: NamedElement[] = [];
    const walk = (el: NamedElement): void => {
      if (el.getAttribute("id") === name || (NAMEABLE_TAGS.has(el.localName) && el.getAttribute("name") === name)) {
        out.push(el);
      }
      const kids = el.children;
      for (let i = 0; i < kids.length; i += 1) walk(kids[i] as NamedElement);
    };
    const root = (document as { documentElement?: NamedElement }).documentElement;
    if (root !== undefined && root !== null) walk(root);
    return out;
  };
  const namedWindowValue = (name: string): unknown => {
    const els = namedElements(name);
    if (els.length === 0) return undefined;
    if (els.length === 1) return els[0];
    // Multiple matches → a collection (HTMLCollection shape).
    const col: Record<string | number, unknown> = { length: els.length, item: (i: number) => els[i] ?? null };
    for (let i = 0; i < els.length; i += 1) col[i] = els[i];
    return col;
  };
  const registerNamed = (name: string): void => {
    if (name === "") return;
    // Real globals (own or inherited) always win over named access.
    if (name in sandbox || Object.getOwnPropertyDescriptor(sandbox, name) !== undefined) return;
    Object.defineProperty(sandbox, name, {
      configurable: true,
      enumerable: true,
      get: () => namedWindowValue(name),
      // Assignment shadows: define an own data property (WebIDL window [[Set]]).
      set: (v: unknown) => {
        Object.defineProperty(sandbox, name, { value: v, writable: true, enumerable: true, configurable: true });
      },
    });
  };
  const registerNamedFromNode = (nodeId: NodeId): void => {
    const node = session.dom.nodes.get(nodeId);
    if (node?.kind !== "element") return;
    const idAttr = node.attrs?.get("id");
    if (idAttr !== undefined && idAttr !== "") registerNamed(idAttr);
    if (node.tag !== undefined && NAMEABLE_TAGS.has(node.tag)) {
      const nameAttr = node.attrs?.get("name");
      if (nameAttr !== undefined && nameAttr !== "") registerNamed(nameAttr);
    }
  };
  // Initial scan of the parsed document.
  for (const node of session.dom.nodes.values()) registerNamedFromNode(node.id);
  // Later: attribute writes (id/name) and subtree insertions.
  session.addMutationListener((m) => {
    if (m.kind === "attributes" && (m.attributeName === "id" || m.attributeName === "name")) {
      registerNamedFromNode(m.target);
    } else if (m.kind === "childList" && m.added !== undefined) {
      const scan = (id: NodeId): void => {
        registerNamedFromNode(id);
        for (const kid of session.dom.nodes.get(id)?.children ?? []) scan(kid);
      };
      for (const id of m.added) scan(id);
    }
  });
  // Real event-platform constructors: tests build targets and synthetic events
  // directly (`new EventTarget()`, `new Event("x")`), and abortable listener
  // options need the abort surface (DOM §3.2). The sandbox itself is the
  // `window` object and Window implements EventTarget, so the window-level
  // listener methods dispatch through an internal target.
  sandbox["EventTarget"] = EventTarget;
  sandbox["Event"] = Event;
  sandbox["CustomEvent"] = CustomEvent;
  // `Window` marks the global's interface for idlharness' exposed_in() check —
  // `'Window' in self` is how it detects a Window global.
  sandbox["Window"] = class Window {};
  sandbox["UIEvent"] = UIEvent;
  sandbox["MouseEvent"] = MouseEvent;
  sandbox["KeyboardEvent"] = KeyboardEvent;
  sandbox["FocusEvent"] = FocusEvent;
  sandbox["InputEvent"] = InputEvent;
  sandbox["AbortController"] = AbortController;
  sandbox["AbortSignal"] = AbortSignal;
  // Web Streams API: Node ships the spec-compliant implementation of
  // ReadableStream / WritableStream / TransformStream — reuse it wholesale
  // (the same principle as URL: Node's IS the platform implementation).
  sandbox["ReadableStream"] = ReadableStream;
  sandbox["WritableStream"] = WritableStream;
  sandbox["TransformStream"] = TransformStream;
  sandbox["ByteLengthQueuingStrategy"] = ByteLengthQueuingStrategy;
  sandbox["CountQueuingStrategy"] = CountQueuingStrategy;
  sandbox["ReadableStreamDefaultReader"] = ReadableStreamDefaultReader;
  sandbox["ReadableStreamDefaultController"] = ReadableStreamDefaultController;
  sandbox["WritableStreamDefaultWriter"] = WritableStreamDefaultWriter;
  sandbox["WritableStreamDefaultController"] = WritableStreamDefaultController;
  sandbox["TransformStreamDefaultController"] = TransformStreamDefaultController;
  sandbox["DOMException"] = DOMException;
  // idlharness/testharness catch `instanceof AssertionError` — our asserts
  // throw WptAssertionError, so the name must resolve inside the guest.
  sandbox["AssertionError"] = WptAssertionError;
  // WHATWG URL: the engine reuses the platform parser (Node's URL is a
  // spec-compliant WHATWG URL implementation); WPT url/* tests exercise it.
  sandbox["URL"] = URL;
  sandbox["URLSearchParams"] = URLSearchParams;
  sandbox["WheelEvent"] = WheelEvent;
  sandbox["CompositionEvent"] = CompositionEvent;
  sandbox["AnimationEvent"] = AnimationEvent;
  sandbox["TransitionEvent"] = TransitionEvent;
  // Frame clock: requestAnimationFrame schedules on the macrotask queue —
  // the runner's model of "before the next repaint" (16ms frame).
  sandbox["requestAnimationFrame"] = (cb: unknown) =>
    setTimeout(() => {
      if (typeof cb === "function") (cb as (t: number) => void)(performance.now());
    }, 16);
  sandbox["cancelAnimationFrame"] = (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>);
  // Window-level scroll storage (elements carry their own scrollTop/Left).
  let windowScrollX = 0;
  let windowScrollY = 0;
  const windowScrollTo = (xOrOptions?: unknown, y?: unknown): void => {
    const opts = typeof xOrOptions === "object" && xOrOptions !== null
      ? xOrOptions as { left?: unknown; top?: unknown }
      : { left: xOrOptions, top: y };
    if (opts.left !== undefined) windowScrollX = Math.max(0, Number(opts.left) || 0);
    if (opts.top !== undefined) windowScrollY = Math.max(0, Number(opts.top) || 0);
  };
  sandbox["scrollTo"] = windowScrollTo;
  sandbox["scroll"] = windowScrollTo;
  sandbox["scrollBy"] = (xOrOptions?: unknown, y?: unknown): void => {
    const opts = typeof xOrOptions === "object" && xOrOptions !== null
      ? xOrOptions as { left?: unknown; top?: unknown }
      : { left: xOrOptions, top: y };
    windowScrollTo(windowScrollX + (Number(opts.left) || 0), windowScrollY + (Number(opts.top) || 0));
  };
  Object.defineProperties(sandbox, {
    scrollX: { get: () => windowScrollX, enumerable: true, configurable: true },
    pageXOffset: { get: () => windowScrollX, enumerable: true, configurable: true },
    scrollY: { get: () => windowScrollY, enumerable: true, configurable: true },
    pageYOffset: { get: () => windowScrollY, enumerable: true, configurable: true },
  });
  sandbox["performance"] = { now: () => performance.now(), timeOrigin: 0 };
  const windowTarget = new EventTarget();
  sandbox["addEventListener"] = windowTarget.addEventListener.bind(windowTarget);
  sandbox["removeEventListener"] = windowTarget.removeEventListener.bind(windowTarget);
  sandbox["dispatchEvent"] = windowTarget.dispatchEvent.bind(windowTarget);
  /**
   * WPT `fetch()` for test data: real WPT suites serve `resources/*.json` over
   * HTTP, but our runner reads from the checkout directly. The seam is the
   * same one used for `<script src>` includes (`resolveResource`), so data
   * files load with the same path mapping. Returns a fetch-shaped Response
   * with `.json()` / `.text()` / `.ok` / `.status`.
   */
  sandbox["fetch"] = (input: unknown, _init?: unknown): Promise<unknown> => {
    const url = typeof input === "string" ? input : String(input);
    const source = resolveResource?.(url);
    if (source === undefined) {
      return Promise.resolve({
        ok: false,
        status: 404,
        url,
        json: () => Promise.reject(new Error(`fetch: ${url} not found`)),
        text: () => Promise.reject(new Error(`fetch: ${url} not found`)),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      url,
      json: () => {
        try {
          return Promise.resolve(JSON.parse(source));
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e));
          return Promise.reject(err);
        }
      },
      text: () => Promise.resolve(source),
    });
  };

  // ---- Platform primitives the corpus exercises (real implementations) ----
  // Web Storage (HTML §12.3): proxy-wrapped Storage areas + StorageEvent.
  // Each sandbox gets its OWN Storage subclass — tests pollute
  // `Storage.prototype` (defineProperty / accessors) and a shared class
  // object would leak that pollution into the next file's sandbox.
  class SandboxStorage extends StorageImpl {}
  sandbox["Storage"] = SandboxStorage;
  const localArea = new SandboxStorage();
  const sessionArea = new SandboxStorage();
  sandbox["localStorage"] = createStorageProxy(localArea);
  sandbox["sessionStorage"] = createStorageProxy(sessionArea);
  sandbox["StorageEvent"] = StorageEvent;
  // File API: the guest Blob/File classes + FileReader + object URLs.
  sandbox["Blob"] = makeBlobClass();
  sandbox["File"] = makeFileClass();
  sandbox["FileReader"] = FileReader;
  if (typeof (URL as { createObjectURL?: unknown }).createObjectURL !== "function") {
    (URL as unknown as { createObjectURL?: unknown }).createObjectURL = (blob: unknown): string =>
      globalObjectUrls.createObjectURL(blob);
    (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL = (url: unknown): void =>
      globalObjectUrls.revokeObjectURL(url);
  }
  // Navigator + Web Locks (navigator.locks → a real LockManager). The
  // returned promises are rewrapped into the GUEST realm's Promise so that
  // `result instanceof Promise`/`Promise.resolve(p) === p` checks hold inside
  // the vm context. The realm's Promise intrinsic is only reachable via
  // runInContext AFTER createContext — resolved lazily into RealmPromise.
  let RealmPromise: PromiseConstructor = Promise;
  const guestify = (p: Promise<unknown>): Promise<unknown> =>
    new RealmPromise((res, rej) => {
      p.then(res, rej);
    });
  class GuestLockManager extends LockManager {
    override request(...args: Parameters<LockManager["request"]>): Promise<unknown> {
      return guestify(super.request(...args));
    }
    override query(): Promise<{ held: never[]; pending: never[] }> {
      return guestify(super.query()) as Promise<{ held: never[]; pending: never[] }>;
    }
  }
  class GuestStorageManager extends StorageManagerImpl {
    override estimate(): Promise<{ usage: number; quota: number }> {
      return guestify(super.estimate()) as Promise<{ usage: number; quota: number }>;
    }
    override persisted(): Promise<boolean> {
      return guestify(super.persisted()) as Promise<boolean>;
    }
    override persist(): Promise<boolean> {
      return guestify(super.persist()) as Promise<boolean>;
    }
  }
  sandbox["navigator"] = {
    userAgent: "browser-engine-shia (WPT harness)",
    locks: new GuestLockManager(),
    storage: new GuestStorageManager(localArea, sessionArea),
  };
  sandbox["Lock"] = Lock;
  sandbox["LockManager"] = GuestLockManager;
  // HTML §9.4 messaging: real structured clone + channels from the host
  // platform (Node's implementations ARE spec implementations — the same
  // reuse doctrine as URL/Streams).
  sandbox["structuredClone"] = structuredClone;
  sandbox["MessageChannel"] = MessageChannel;
  sandbox["MessagePort"] = MessagePort;
  sandbox["BroadcastChannel"] = makeBroadcastChannelClass(
    () => {
      const o = sandboxLocation["origin"];
      return typeof o === "string" ? o : "";
    },
  );
  sandbox["MessageEvent"] = MessageEvent;
  /** window.postMessage(data, "*"): self-delivery as a queued task. */
  sandbox["postMessage"] = (data: unknown, _targetOrigin?: unknown): void => {
    const event = new MessageEvent("message", { data, origin: "", source: sandbox });
    setTimeout(() => {
      const handler = sandbox["onmessage"];
      if (typeof handler === "function") (handler as (e: unknown) => void)(event);
      windowTarget.dispatchEvent(event);
    }, 0);
  };

  /**
   * testdriver seam: `test_driver` backs the accessibility commands the
   * WPT corpus exercises — computed role/label run the engine's real ARIA
   * + AccName computation over the live element wrappers.
   */
  // Generated-content seam: resolve `::before`/`::after` text (strings,
  // attr(), counters, `content: x / "alt"`) from the kernel-produced sheets.
  const docRoot = (document as { documentElement?: A11yElement }).documentElement;
  const generatedContent: GeneratedContentResolver =
    docRoot === undefined
      ? () => ""
      : makeGeneratedContentResolver(session.styleSheets(), docRoot, (el, sel) => {
          const m = (el as unknown as { matches?: (s: string) => boolean }).matches;
          return typeof m === "function" ? m.call(el, sel) : false;
        });
  const a11yContext: A11yContext = {
    getElementById: (id) =>
      (document as { getElementById?: (i: string) => unknown }).getElementById?.(id) as A11yElement | null,
    querySelectorAll: (selector) =>
      ((document as { querySelectorAll?: (s: string) => unknown }).querySelectorAll?.(selector) ?? []) as ArrayLike<A11yElement>,
    getComputedStyle: (el) => {
      const g = (globals)["getComputedStyle"];
      if (typeof g !== "function") return { getPropertyValue: () => "" };
      const decl = (g as (e: unknown) => unknown)(el) as { getPropertyValue?: (n: string) => unknown };
      return {
        getPropertyValue: (n: string) => {
          const v = decl?.getPropertyValue?.(n);
          return typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "";
        },
      };
    },
    shadowChildrenOf: (el) => {
      const root = (el as unknown as { shadowRoot?: { childNodes?: ArrayLike<A11yElement> } | null }).shadowRoot;
      // undefined = no shadow root (light DOM renders); [] = empty shadow root.
      if (root === null || root === undefined || root.childNodes === undefined) return undefined;
      const out: A11yElement[] = [];
      for (let i = 0; i < root.childNodes.length; i += 1) out.push(root.childNodes[i] as A11yElement);
      return out;
    },
    slotAssignmentOf: (slot) => {
      if (slot.localName !== "slot") return undefined;
      // Walk up to the shadow root (the wrapper exposing `host`). A slot
      // outside a shadow tree renders its own fallback content → undefined.
      let p = (slot as unknown as { parentNode?: unknown }).parentNode;
      for (let depth = 0; p !== null && p !== undefined && depth < 20; depth += 1) {
        const host = (p as { host?: unknown }).host;
        if (host !== null && host !== undefined) {
          const name = slot.getAttribute("name");
          const light = (host as { childNodes?: ArrayLike<A11yElement> }).childNodes;
          const out: A11yElement[] = [];
          if (light !== undefined) {
            for (let i = 0; i < light.length; i += 1) {
              const n = light[i] as A11yElement;
              // Named slots take elements whose `slot` attr matches; the
              // default slot takes every node without a `slot` attr.
              const target = n.nodeType === 1 ? n.getAttribute("slot") : null;
              if ((name ?? "") === (target ?? "")) out.push(n);
            }
          }
          return out;
        }
        p = (p as { parentNode?: unknown }).parentNode;
      }
      return undefined;
    },
    pseudoContent: (el, which) => generatedContent(el, which),
    documentElement: docRoot,
  };
  const a11yIds = new Map<A11yElement, string>();
  let a11yIdSeq = 0;
  const a11yNodes = new Map<string, A11yElement>();
  const a11yIdFor = (el: A11yElement): string => {
    const existing = a11yIds.get(el);
    if (existing !== undefined) return existing;
    const id = `ax-${++a11yIdSeq}`;
    a11yIds.set(el, id);
    a11yNodes.set(id, el);
    return id;
  };
  sandbox["test_driver"] = {
    // Detached elements are not in the accessibility tree: role/label are "".
    get_computed_role: (el: unknown) =>
      Promise.resolve(
        isConnectedToDocument(el as A11yElement, a11yContext)
          ? computedRole(el as A11yElement, a11yContext)
          : "",
      ),
    get_computed_label: (el: unknown) =>
      Promise.resolve(
        isConnectedToDocument(el as A11yElement, a11yContext)
          ? accessibleName(el as A11yElement, a11yContext, new Set())
          : "",
      ),
    get_accessibility_properties_for_element: (el: unknown) =>
      Promise.resolve(accessibilityProperties(el as A11yElement, a11yContext, a11yIdFor)),
    get_accessibility_properties_for_accessibility_node: (id: unknown) => {
      const el = a11yNodes.get(String(id));
      return Promise.resolve(
        el === undefined ? null : accessibilityProperties(el, a11yContext, a11yIdFor),
      );
    },
  };

  let harnessError: string | null = null;
  vm.createContext(sandbox);
  // The contextified realm's own intrinsics (not reachable as sandbox props):
  // locks/messaging promises must be guest-realm Promises for WPT identity
  // assertions like `Promise.resolve(p) === p`.
  RealmPromise = vm.runInContext("Promise", sandbox) as PromiseConstructor;
  // WebIDL realm checks (idlharness asserts e.g.
  // `Object.getPrototypeOf(interfaceObject) === Function.prototype` inside the
  // guest). Host-defined globals carry host intrinsics — reparent root
  // prototypes onto the realm's own Function.prototype/Object.prototype.
  // Subclass links (ctor.__proto__ = parent ctor, proto.__proto__ = parent
  // proto) are left untouched since they already match the IDL chain.
  {
    const intrinsics = vm.runInContext(
      "({ fn: Function.prototype, obj: Object.prototype })",
      sandbox,
    ) as { fn: object; obj: object };
    // Globals are host objects shared across test files, and each file gets a
    // fresh realm — objects reparented for an earlier file must be reparented
    // again to the *current* realm's intrinsics (the proto check alone would
    // skip them and assert against a stale realm).
    for (const key of Object.getOwnPropertyNames(sandbox)) {
      const v = sandbox[key];
      try {
        if (typeof v === "function") {
          if (Object.getPrototypeOf(v) === Function.prototype || reparentedToRealm.has(v)) {
            Object.setPrototypeOf(v, intrinsics.fn);
            reparentedToRealm.add(v);
          }
          const p = (v as { prototype?: unknown }).prototype;
          if (
            p !== null && typeof p === "object" &&
            (Object.getPrototypeOf(p) === Object.prototype || reparentedToRealm.has(p))
          ) {
            Object.setPrototypeOf(p, intrinsics.obj);
            reparentedToRealm.add(p);
          }
        } else if (
          v !== null &&
          typeof v === "object" &&
          (Object.getPrototypeOf(v) === Object.prototype || reparentedToRealm.has(v))
        ) {
          Object.setPrototypeOf(v, intrinsics.obj);
          reparentedToRealm.add(v);
        }
      } catch {
        // Proxies or invariants may refuse reparenting — leave as is.
      }
    }
    // WebIDL indexed iterables: entries/keys/values/forEach/@@iterator on the
    // prototype are literally the realm's own Array.prototype functions.
    const arrProto = vm.runInContext("Array.prototype", sandbox) as Record<
      PropertyKey,
      unknown
    >;
    for (const name of ["CSSUnparsedValue", "CSSTransformValue", "CSSNumericArray"]) {
      const proto = (sandbox[name] as { prototype?: object } | undefined)?.prototype;
      if (proto === undefined) continue;
      for (const m of ["entries", "keys", "values", "forEach"]) {
        Object.defineProperty(proto, m, {
          value: arrProto[m],
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
      Object.defineProperty(proto, Symbol.iterator, {
        value: arrProto[Symbol.iterator],
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }
  }
  guestContext = sandbox;
  try {
    for (const script of extractScripts(html)) {
      let source = script.content;
      if (script.src !== undefined) {
        if (isHarnessResource(script.src)) continue; // provided by our harness.
        source = resolveResource?.(script.src) ?? "";
      }
      if (source.trim() === "") continue;
      vm.runInContext(source, sandbox, { timeout: 5000 });
    }
    await harness.settle(2000);
  } catch (error) {
    harnessError = error instanceof Error ? error.message : String(error);
  }
  let traceError: string | undefined;
  if (collector !== undefined) {
    try {
      session.render();
    } catch (error) {
      traceError = error instanceof Error ? error.message : String(error);
    }
  }

  const passed = harness.subtests.filter((t) => t.status === "PASS").length;
  // PRECONDITION_FAILED (assert_implements_optional) is a skip, not a failure —
  // matching upstream testharness status semantics.
  const failed = harness.subtests.filter((t) => t.status === "FAIL" || t.status === "ERROR").length;
  return collector === undefined
    ? { subtests: harness.subtests, passed, failed, harnessError }
    : traceError === undefined
      ? { subtests: harness.subtests, passed, failed, harnessError, trace: collector.trace() }
      : { subtests: harness.subtests, passed, failed, harnessError, trace: collector.trace(), traceError };
}

/** Run a `.window.js` / `.any.js` WPT test (JS body, implicit window/document). */
export async function runWptScriptFile(
  source: string,
  resolveResource?: ResourceResolver,
  options: WptSuiteOptions = {},
): Promise<WptReport> {
  // `// META: script=foo.js` headers pull in extra includes (resolved from disk).
  const metaIncludes = [...source.matchAll(/^\/\/\s*META:\s*script=(.+)$/gim)].map((m) => (m[1] ?? "").trim());
  const prelude = metaIncludes
    .filter((s) => !isHarnessResource(s))
    .map((s) => resolveResource?.(s) ?? "")
    .join("\n");
  const html = "<html><head></head><body></body></html>";
  // Wrap as a single inline script so the HTML runner executes it.
  return runWptHtml(`${documentHtml(html)}<script>${prelude}\n${source}</script>`, resolveResource, options);
}

// ---------------------------------------------------------------------------
// Walking a real WPT checkout.
// ---------------------------------------------------------------------------

/** Recursively collect runnable WPT test files under `root`. */
export function collectWptTests(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        // Skip WPT's support/tooling directories that hold no runnable tests.
        if (entry === "resources" || entry === "tools" || entry === "common" || entry.startsWith(".")) continue;
        walk(full);
        continue;
      }
      if (isRunnableWptTest(full)) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

/** Whether a path is a runnable testharness test (.html with the include, or .window/.any.js). */
function isRunnableWptTest(file: string): boolean {
  if (/\.(window|any)\.js$/.test(file)) return true;
  if (/\.x?html$/.test(file)) {
    try {
      return readFileSync(file, "utf8").includes("testharness.js");
    } catch {
      return false;
    }
  }
  return false;
}

/** Run one WPT file under `root`, resolving support resources against the same checkout. */
export async function runWptFile(
  root: string,
  file: string,
  options: WptSuiteOptions = {},
): Promise<readonly [string, WptReport]> {
  const full = path.isAbsolute(file) ? file : path.join(root, file);
  const resolve: ResourceResolver = (src) => {
    const wptPath = pathFromWptDocumentUrl(src);
    const target = wptPath !== null
      ? path.join(root, wptPath)
      : src.startsWith("/")
        ? path.join(root, src)
        : path.join(path.dirname(full), src);
    try {
      return readFileSync(target, "utf8");
    } catch {
      return undefined;
    }
  };
  const source = readFileSync(full, "utf8");
  const relative = path.relative(root, full).split(path.sep).join("/");
  const documentUrl = `wpt://doc/${relative}`;
  const report = /\.(window|any)\.js$/.test(full)
    ? await runWptScriptFile(source, resolve, { ...options, documentUrl })
    : await runWptHtml(source, resolve, { ...options, documentUrl });
  return [path.relative(root, full), report] as const;
}

/** Map the engine's synthetic WPT document URLs back to checkout-relative paths. */
function pathFromWptDocumentUrl(src: string): string | null {
  try {
    const url = new URL(src);
    if (url.protocol !== "wpt:" || url.hostname !== "doc") {
      return null;
    }
    return decodeURIComponent(url.pathname).replace(/^\/+/, "");
  } catch {
    return null;
  }
}

/** Run an explicit file list under `root`, scoring only those tests. */
export async function runWptFiles(
  root: string,
  files: readonly string[],
  options: WptSuiteOptions = {},
): Promise<WptSuiteReport> {
  const collector = options.trace === true ? createStageTraceCollector() : undefined;
  const byFile = new Map<string, WptReport>();
  let subtests = 0;
  let passed = 0;
  let failed = 0;
  let errored = 0;

  for (const file of files) {
    const relative = path.relative(root, path.isAbsolute(file) ? file : path.join(root, file)).split(path.sep).join("/");
    let report: WptReport;
    try {
      [, report] = await runWptFile(
        root,
        file,
        collector === undefined ? {} : { trace: true },
      );
    } catch (error) {
      // One file's escaped exception (e.g. a throw inside a timer callback the
      // harness cannot observe) must not kill the whole suite run.
      report = {
        subtests: [{ name: "(harness)", status: "ERROR", message: error instanceof Error ? error.message : String(error) }],
        passed: 0,
        failed: 0,
        harnessError: error instanceof Error ? error.message : String(error),
      };
    }
    byFile.set(relative, report);
    if (collector !== undefined) {
      replayTrace(report.trace, collector);
    }
    subtests += report.subtests.length;
    passed += report.passed;
    failed += report.subtests.filter((t) => t.status === "FAIL").length;
    errored += report.subtests.filter((t) => t.status === "ERROR").length;
  }

  return collector === undefined
    ? { files: files.length, subtests, passed, failed, errored, byFile }
    : { files: files.length, subtests, passed, failed, errored, byFile, trace: collector.trace() };
}

/**
 * Run every WPT test under `root` (a real web-platform-tests checkout), scoring
 * each against this engine. `<script src>` includes resolve against the
 * checkout. Returns the aggregate suite report. `limit` caps the number of
 * files (for sampling a huge tree).
 */
export async function runWptDirectory(
  root: string,
  limit = Infinity,
  options: WptSuiteOptions = {},
): Promise<WptSuiteReport> {
  const files = collectWptTests(root).slice(0, limit);
  return runWptFiles(root, files, options);
}

function replayTrace(trace: StageTrace | undefined, collector: ReturnType<typeof createStageTraceCollector>): void {
  if (trace === undefined) return;
  for (const event of trace.events) {
    collector.onQuery({
      query: { name: event.stage },
      queryName: event.stage,
      key: event.key,
      durationMs: event.durationMs,
      dependencyCount: event.dependencyCount,
      cacheStatus: event.cacheStatus,
    });
  }
}
