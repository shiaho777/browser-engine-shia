/**
 * @browser-engine/guest
 *
 * The kernel/guest boundary and the V8-backed guest runtime (design.md §3.1.E/F,
 * §10, §11; Requirements 7, 16.3, 16.4, 8.1).
 *
 * This package is where engine-internal state is physically isolated from guest
 * page JavaScript and where guest JS is executed across that boundary:
 *
 *   - **DOM wrappers** (`createElementWrapper` / `ElementImpl`) expose ONLY the
 *     generated web surface; their engine-internal handle lives behind the
 *     module-private `INTERNAL` symbol in a package-private WeakMap (task 7.4).
 *   - **The guest global** (`buildGuestGlobal`) is assembled from EXACTLY the
 *     generated DOM surface and nothing engine-internal (Requirement 7.3).
 *   - **The V8 guest runtime** (`GuestRuntime`) reuses the embedded V8 engine
 *     (via Node's `vm`) to run guest JS across the boundary (Requirement 16.3,
 *     8.1), driving an **event loop with microtask scheduling** (`EventLoop`;
 *     Requirement 16.4).
 *
 * Deliberately NOT exported: the module-private `./internal.ts` (the `INTERNAL`
 * symbol, the WeakMap, `attachInternal` / `readInternal`). Keeping it
 * unexported is what makes the engine-internal handle unreachable by package
 * consumers and guests (design.md §10; Requirement 7.1).
 */
export const PACKAGE_NAME = "@browser-engine/guest" as const;

// ---- DOM wrappers (the guest-visible web surface) -------------------------
// The `NodeInternal` TYPE describes the handle shape `createElementWrapper`
// accepts; exporting the type (erased at runtime) is safe and necessary for the
// factory to be callable externally. The module-private `INTERNAL` symbol, the
// WeakMap, and `attachInternal`/`readInternal` remain unexported (Req 7.1).
// ---- DOM wrappers (the guest-visible web surface) -------------------------
// The original ElementImpl from element.ts (5 read methods) is kept for backward
// compatibility. The full implementation lives in node-impls.ts.
export { ElementImpl as ElementImplBase, createElementWrapper } from "./element.js";
export type { NodeInternal } from "./internal.js";

// ---- Concrete DOM wrapper implementations (Node/Element/Text/Document) ----
export {
  NodeImpl,
  ElementImpl,
  TextImpl,
  CommentImpl,
  DocumentImpl,
  DocumentFragmentImpl,
  wrapNode,
  type DOMRectLike,
} from "./node-impls.js";

// ---- DomContext (shared wrapper creation context) -------------------------
export { DomContext } from "./dom-context.js";

// ---- LiveDom (mutable DOM layer) ------------------------------------------
export { LiveDom, syncNodeToKernel, type LiveNode } from "./live-dom.js";

// ---- Wrapper cache (reference identity per NodeId) ------------------------
export { WrapperCache } from "./wrapper-cache.js";

// ---- Event system (Event, EventTarget, MouseEvent, KeyboardEvent, etc.) ---
export {
  Event,
  UIEvent,
  MouseEvent,
  KeyboardEvent,
  CustomEvent,
  FocusEvent,
  InputEvent,
  EventTarget,
  EventTargetImpl,
  EventImpl,
  type EventInit,
  type MouseEventInit,
  type KeyboardEventInit,
} from "./event-system.js";

// ---- Storage (localStorage / sessionStorage) ------------------------------
export { StorageImpl } from "./storage.js";

// ---- CSSStyleDeclaration (getComputedStyle return type) -------------------
export { CSSStyleDeclarationImpl } from "./css-style-declaration.js";

// ---- XMLHttpRequest -------------------------------------------------------
export { XMLHttpRequestImpl } from "./xhr.js";

// ---- Resource loader (img/script/link loading) ----------------------------
export { loadResource, resolveUrl, type LoadedResource } from "./resource-loader.js";

// ---- the guest global builder (surface-only, no engine internals) ---------
export { buildGuestGlobal, type GuestGlobal, type GuestGlobalOptions } from "./guest-global.js";

// ---- the event loop with microtask scheduling (Requirement 16.4) ----------
export { EventLoop, type Task } from "./event-loop.js";

// ---- the reused networking boundary (Requirement 8.1) ---------------------
export {
  nodeFetchNetworkStack,
  createBrowserNetworkStack,
  networkStackToFetchFn,
  networkStackToBrowserFetch,
  DEFAULT_BROWSER_UA,
  type NetworkStack,
  type NetworkRequest,
  type NetworkResponse,
  type BrowserNetworkStack,
  type BrowserNetworkOptions,
  type BrowserNetworkEvent,
} from "./network.js";
export { CookieJar, type StoredCookie } from "./cookie-jar.js";

// ---- aborting (DOM §3.2): AbortController / AbortSignal --------------------
export {
  AbortControllerImpl as AbortController,
  AbortSignalImpl as AbortSignal,
  DOMExceptionImpl as DOMException,
} from "./abort.js";

// ---- guest fetch over the reused stack (Requirements 16.5, 16.7) ----------
export { createGuestFetch, type GuestFetch, type GuestResponse } from "./fetch.js";

// ---- guest-boundary value coercion (spec-like ToString for unknowns) ------
export { coerceGuestString } from "./coerce.js";

// ---- @font-face web-font loading + application (Requirement 16.6) ---------
export {
  FontRegistry,
  loadFontFaces,
  loadFontFace,
  parseFontFaceRules,
  type FontFaceRule,
  type LoadedFont,
} from "./font-face.js";

// ---- the V8-backed guest runtime (Requirements 16.3, 16.4, 8.1) -----------
export {
  GuestRuntime,
  type GuestRuntimeOptions,
  type RunResult,
} from "./runtime.js";
