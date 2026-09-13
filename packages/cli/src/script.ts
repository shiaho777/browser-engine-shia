/**
 * script.ts — the scripting bridge (M3.2: real JavaScript drives the DOM).
 *
 * This closes the interactive loop: REAL JavaScript, executed by V8 (Node's
 * built-in `vm`, the same engine-reuse seam the guest runtime uses — design.md
 * §11, "reuse V8"), mutates the document, and those mutations drive the
 * fine-grained incremental session ({@link FineSession}) so the engine
 * re-renders — recomputing only what the edit touched (M4).
 *
 * Scope (honest): this is a MINIMAL, sanctioned `document` surface —
 * `getElementById` / `querySelector` returning element wrappers with
 * `getAttribute` / `setAttribute` / `textContent`. It proves the data flow
 * (script → DOM mutation → incremental re-render) on real V8. Binding the FULL
 * generated DOM surface (`@browser-engine/guest`) to the live session, and
 * hardened guest isolation, are the larger follow-on; this bridge deliberately
 * exposes only the small, safe surface it implements rather than a stubbed-out
 * full API (no silent NotImplemented placeholders leak to the script).
 *
 * The cli is the wiring layer, so it may reuse `node:vm` to host the script and
 * compose it with the session.
 */
import vm from "node:vm";
import { URL as HostURL } from "node:url";

import type { DomNode, DomTree, NodeId, StyleRule } from "@browser-engine/ir";
import { CSS_PROPERTIES, LENGTH_BARE_ZERO_PX, parsePropertyValue, expandShorthand, isShorthandName } from "@browser-engine/generator";
import type { CssPropertyDef } from "@browser-engine/generator";
import { getBoundingClientRect as boundingRect } from "@browser-engine/layout";
import { ruleMatches, parseEasing, sampleEasing, interpolateValue, customPropertiesOf } from "@browser-engine/cascade";
import type { Easing } from "@browser-engine/cascade";
import {
  coerceGuestString,
  CustomEvent as CustomEvent,
  Event as Event,
  MouseEvent as MouseEvent,
} from "@browser-engine/guest";

import { parseHtml } from "@browser-engine/html-parser";
import { FineSession } from "./fine.js";
import { resolveUrl } from "./loader.js";
import { isActiveStylesheetLink } from "./link-rel.js";
import {
  isDeclarationValueValid,
  makeStylePropertyMap,
  makeStylePropertyMapReadOnly,
  type StyleMapBacking,
} from "./typed-om.js";
import {
  MutationObserverController,
  type ObserverOptions,
  type QueuedRecord,
} from "./mutation-observer.js";

/** CSS property metadata for CSSOM serialization: css-name → { field, tsType }. */
const CSS_NAME_TO_META = new Map(CSS_PROPERTIES.map((p) => [p.name, { field: p.field, tsType: p.tsType }]));
/** CSSOM property aliases accepted on CSSStyleDeclaration objects. */
const CSSOM_PROPERTY_ALIAS_TO_NAME = new Map<string, string>([
  ...CSS_PROPERTIES.flatMap((p): [string, string][] => [[p.name, p.name], [p.field, p.name]]),
  ["cssFloat", "float"],
]);

const DOCUMENT_POSITION_DISCONNECTED = 0x01;
const DOCUMENT_POSITION_PRECEDING = 0x02;
const DOCUMENT_POSITION_FOLLOWING = 0x04;
const DOCUMENT_POSITION_CONTAINS = 0x08;
const DOCUMENT_POSITION_CONTAINED_BY = 0x10;
const DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC = 0x20;

const NODE_DOCUMENT_POSITION_CONSTANTS = Object.freeze({
  DOCUMENT_POSITION_DISCONNECTED,
  DOCUMENT_POSITION_PRECEDING,
  DOCUMENT_POSITION_FOLLOWING,
  DOCUMENT_POSITION_CONTAINS,
  DOCUMENT_POSITION_CONTAINED_BY,
  DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC,
});

/**
 * Resolve a Web-Animations keyframe property KEY — accepted as either a CSS
 * name (`"background-color"`) or the camelCase IDL form (`"backgroundColor"`) —
 * to its data-table row. Returns `undefined` for a property the engine does not
 * know (the caller rejects it loudly rather than animating a phantom property).
 */
const PROP_BY_KEY: ReadonlyMap<string, CssPropertyDef> = (() => {
  const m = new Map<string, CssPropertyDef>();
  for (const p of CSS_PROPERTIES) {
    m.set(p.name, p);
    m.set(p.field, p);
  }
  return m;
})();

/** One animated property's resolved keyframe track: parsed computed values by offset. */
interface PropTrack {
  readonly cssName: string;
  readonly tsType: string;
  readonly def: CssPropertyDef;
  readonly kfs: { readonly offset: number; readonly value: unknown }[];
}

/** A fully-parsed animation effect (timing + per-property tracks). Pure data. */
interface AnimationEffect {
  readonly tracks: PropTrack[];
  readonly durationMs: number;
  readonly delayMs: number;
  readonly easing: Easing;
  readonly fill: "none" | "forwards" | "backwards" | "both";
}

/** A raw keyframe object from guest script: property keys + optional `offset`. */
type RawKeyframe = Record<string, unknown>;

/**
 * Distribute keyframe offsets per web-animations-1 §3.8.2: an explicit `offset`
 * is honored; a missing first/last defaults to 0/1; runs of missing middle
 * offsets are spaced evenly between their known neighbors.
 */
function distributeOffsets(frames: readonly RawKeyframe[]): number[] {
  const n = frames.length;
  const offsets: (number | null)[] = frames.map((f) => {
    const o = f["offset"];
    return typeof o === "number" ? o : null;
  });
  if (n > 0 && offsets[0] === null) offsets[0] = 0;
  if (n > 1 && offsets[n - 1] === null) offsets[n - 1] = 1;
  let i = 0;
  while (i < n) {
    if (offsets[i] === null) {
      let j = i;
      while (j < n && offsets[j] === null) j++;
      const lo = offsets[i - 1] ?? 0;
      const hi = offsets[j] ?? 1;
      const span = j - (i - 1);
      for (let k = i; k < j; k++) offsets[k] = lo + ((hi - lo) * (k - (i - 1))) / span;
      i = j;
    } else i++;
  }
  return offsets.map((o) => o ?? 0);
}

/**
 * Parse guest `keyframes` + `options` into a typed {@link AnimationEffect},
 * reusing the GENERATED per-property parser for each keyframe value and the
 * cascade's {@link parseEasing}. Unknown properties / unparseable values throw
 * (no silent skip — an animation that can't be honored is an error, not a no-op).
 */
function buildEffect(keyframes: readonly RawKeyframe[], options: unknown): AnimationEffect {
  const offsets = distributeOffsets(keyframes);
  const trackMap = new Map<string, PropTrack>();
  keyframes.forEach((frame, idx) => {
    const offset = offsets[idx] ?? 0;
    for (const key of Object.keys(frame)) {
      if (key === "offset" || key === "easing") continue;
      const def = PROP_BY_KEY.get(key);
      if (def === undefined) throw new Error(`cannot animate unknown property: ${key}`);
      const parsed = parsePropertyValue(def.name, String(frame[key]));
      if (!parsed.ok) throw new Error(`unparseable keyframe value for ${key}: ${String(frame[key])}`);
      let track = trackMap.get(def.name);
      if (track === undefined) {
        track = { cssName: def.name, tsType: def.tsType, def, kfs: [] };
        trackMap.set(def.name, track);
      }
      track.kfs.push({ offset, value: parsed.value });
    }
  });
  for (const track of trackMap.values()) track.kfs.sort((a, b) => a.offset - b.offset);

  const opt = typeof options === "number" ? { duration: options } : (options as Record<string, unknown> | undefined) ?? {};
  const durationMs = Math.max(0, Number(opt["duration"]) || 0);
  const delayMs = Math.max(0, Number(opt["delay"]) || 0);
  const easing = parseEasing(typeof opt["easing"] === "string" ? opt["easing"] : "linear");
  const fillRaw = typeof opt["fill"] === "string" ? opt["fill"] : "none";
  const fill = (["none", "forwards", "backwards", "both"].includes(fillRaw) ? fillRaw : "none") as
    | "none"
    | "forwards"
    | "backwards"
    | "both";
  return { tracks: [...trackMap.values()], durationMs, delayMs, easing, fill };
}

/** Sample one property track at fraction `f ∈ [0,1]` (interpolating its segment). */
function sampleTrack(track: PropTrack, f: number): unknown {
  const kfs = track.kfs;
  if (kfs.length === 0) return undefined;
  const first = kfs[0] as { offset: number; value: unknown };
  const last = kfs[kfs.length - 1] as { offset: number; value: unknown };
  if (f <= first.offset) return first.value;
  if (f >= last.offset) return last.value;
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i] as { offset: number; value: unknown };
    const b = kfs[i + 1] as { offset: number; value: unknown };
    if (f >= a.offset && f <= b.offset) {
      const span = b.offset - a.offset;
      const localT = span <= 0 ? 0 : (f - a.offset) / span;
      return interpolateValue(track.def, a.value, b.value, localT);
    }
  }
  return last.value;
}

/** Serialize a ComputedStyle value to its CSSOM string form (by declared tsType). */
function serializeComputed(tsType: string, value: unknown): string {
  if (value === undefined || value === null) return "";
  // Keyword-valued colors (currentcolor, system colors) compute to the keyword.
  if (tsType === "Color" && typeof value === "string") return value;
  if ((tsType === "Color" || tsType === "Color | string") && typeof value === "object" && value !== null) {
    const c = value as { r: number; g: number; b: number; a: number };
    return c.a >= 1 ? `rgb(${c.r}, ${c.g}, ${c.b})` : `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})`;
  }
  if (tsType === "Px" && typeof value === "number") return `${value}px`;
  // Unresolved specified lengths (percentages, units resolveOne can't ground)
  // surface as `{kind:"specified-length"}` — serialize back to unit text so
  // computed styles keep `50%` instead of dropping to "".
  if (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "specified-length" &&
    typeof (value as { value?: unknown }).value === "number"
  ) {
    const sl = value as { value: number; unit: string };
    return `${sl.value}${sl.unit}`;
  }
  if (tsType === "Edges<Px>" && typeof value === "object") {
    const e = value as { top: unknown; right: unknown; bottom: unknown; left: unknown };
    const edge = (v: unknown): string =>
      typeof v === "number"
        ? `${v}px`
        : typeof v === "object" && v !== null && (v as { kind?: unknown }).kind === "specified-length"
          ? `${(v as { value: number }).value}${(v as { unit: string }).unit}`
          : typeof v === "string"
            ? v
            : "0px";
    return `${edge(e.top)} ${edge(e.right)} ${edge(e.bottom)} ${edge(e.left)}`;
  }
  if (tsType === "LengthOrAuto" || tsType === "LengthSizing") {
    return typeof value === "number" ? `${value}px` : typeof value === "string" ? value : "";
  }
  // `line-height` (the only `string | number` field): numbers are resolved px
  // lengths; unitless multipliers are stored as numeric strings.
  if (tsType === "string | number") {
    return typeof value === "number" ? `${value}px` : typeof value === "string" ? value : "";
  }
  // `<time>#` lists (transition-*, animation-*) store seconds[].
  if (tsType === "readonly number[]" && Array.isArray(value)) {
    return value.map((n) => `${n}s`).join(", ");
  }
  if (tsType === "TransformValue") {
    if (Array.isArray(value)) return `matrix(${value.join(", ")})`;
    if (typeof value === "string") return value;
    if (typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "unresolved") {
      return (value as { text: string }).text;
    }
    return "";
  }
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/**
 * Shorthand serialization from computed longhands (CSSOM resolved value). The
 * shorthand stub fields only hold `none` — real serializations compose the
 * longhand set.
 */
function collapseEdges(t: string, r: string, b: string, l: string): string {
  if (t === r && r === b && b === l) return t;
  if (r === l) return t === b ? `${t} ${r}` : `${t} ${r} ${b}`;
  return `${t} ${r} ${b} ${l}`;
}

/**
 * Resolve relative length units inside a computed `transform` serialization —
 * computed transform values carry absolute lengths (em→px against the
 * element's font size, viewport units against the harness 800×600 viewport).
 * Percentages stay unresolved (they need the reference box at used-value time).
 */
function resolveTransformUnits(text: string, fontPx: number): string {
  const factors: Record<string, number> = {
    em: fontPx, rem: fontPx, ex: fontPx * 0.5, ch: fontPx * 0.5,
    cap: fontPx * 0.7, ic: fontPx, lh: fontPx * 1.2, rlh: fontPx * 1.2,
    vw: 8, vh: 6, vmin: 6, vmax: 8,
  };
  return text.replace(
    /(-?\d*\.?\d+(?:[eE][+-]?\d+)?)(em|rem|vw|vh|vmin|vmax|ex|ch|cap|ic|lh|rlh)\b/g,
    (_m, n: string, u: string) => `${Number(n) * factors[u]!}px`,
  );
}

const SHORTHAND_COMPUTED: Record<string, (get: (longhand: string) => string) => string> = {
  background: (get) =>
    `${get("background-color")} ${get("background-image")} ${get("background-repeat")} ` +
    `${get("background-attachment")} ${get("background-position")} / ${get("background-size")} ` +
    `${get("background-origin")} ${get("background-clip")}`,
  margin: (get) =>
    collapseEdges(get("margin-top"), get("margin-right"), get("margin-bottom"), get("margin-left")),
  padding: (get) =>
    collapseEdges(get("padding-top"), get("padding-right"), get("padding-bottom"), get("padding-left")),
};

/** The result of running a script: how many DOM mutations it performed. */
export interface ScriptResult {
  readonly mutations: number;
}

/**
 * Execute `source` as real JavaScript (via V8) against a minimal `document`
 * bound to `session`. Mutating calls (`setAttribute`, `textContent =`) drive the
 * session's incremental DOM mutations; the caller re-renders afterwards to see
 * the effect. Returns the mutation count.
 */
export function runScript(session: FineSession, source: string): ScriptResult {
  const { document, globals, mutations } = buildDocumentApi(session);
  const sandbox: Record<string, unknown> = { document, ...globals };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { timeout: 1000 });
  return { mutations: mutations() };
}

/**
 * Build the minimal `document` surface bound to `session`, plus a getter for the
 * number of mutations performed through it. Shared by {@link runScript} and the
 * WPT harness ({@link import("./wpt.js")}), so both drive the SAME real DOM
 * surface on real V8.
 */
export type DocumentApiOptions = {
  readonly geometryMode?: "full" | "throttled" | "stub";
  readonly styleMode?: "full" | "fast";
  /**
   * Guest-realm compiler for inline `on<type>` attribute handlers. The vm
   * context is owned by the caller (created around the sandbox AFTER this
   * factory runs), so inject a closure that compiles lazily.
   */
  readonly inlineHandlerCompiler?: (body: string) => unknown;
  /** Hash-navigation sink for a/area activation (fires hashchange upstream). */
  readonly hashNavigator?: (fragment: string) => void;
  /**
   * Mutable holder for the <script> element currently executing (HTML:
   * `document.currentScript`). The runner sets it before each inline source
   * and clears it after; the document getter reads it live.
   */
  readonly currentScriptBox?: { current: NodeId | null };
  /**
   * Mutable holder for the sandbox's `location` object, which the runner
   * installs AFTER this factory runs (window.location identity). The
   * document getter `document.location` reads it live — per HTML,
   * document.location must be the SAME object as window.location. When the
   * box is empty (standalone callers), a minimal parse of the session URL
   * backs the getter instead.
   */
  readonly locationBox?: { current: unknown };
  /**
   * Dynamic script execution (HTML §4.12.1): when guest code appends a
   * <script> element (createElement + setAttribute + appendChild — the SPA
   * chunk-loader pattern), the node must fetch and evaluate. The document API
   * owns no vm context, so the runner injects this hook; it reads the node's
   * attributes, fetches the (already-resolved) src, evaluates, and drains.
   */
  readonly onDynamicScript?: (nodeId: NodeId) => void;
  /**
   * Mutable holder for `document.readyState`. Per HTML, parser-inserted
   * scripts execute while the state is `"loading"`; it becomes
   * `"interactive"` after DOMContentLoaded and `"complete"` after load.
   * Runners that drive the full lifecycle own the box and flip it; when
   * absent the getter keeps the historical `"complete"`.
   */
  readonly readyStateBox?: { current: string };
  /**
   * Error sink for exceptions thrown by guest event listeners that the
   * document object dispatches directly (DOMContentLoaded lifecycle,
   * document.dispatchEvent): per HTML each listener error is reported as an
   * uncaught exception and independent listeners still run. The runner
   * connects this to its uncaught-error record.
   */
  readonly onListenerError?: (error: unknown) => void;
  /**
   * Microtask scheduler for MutationObserver delivery. Runners with a virtual
   * event loop pass their loop's `microtask` (late-bound closures are fine —
   * the scheduler is only invoked when a guest mutation actually happens);
   * standalone callers (WPT harnesses) fall back to the realm's real
   * `queueMicrotask`, which matches spec semantics for their sync/async flow.
   */
  readonly observerScheduler?: (fn: () => void) => void;
  /**
   * D6 — the Shadow DOM composition controller. The runner injects it (owned
   * by the FineSession wiring); `attachShadow` calls `registerHost` and slot
   * assignment calls `assignSlot`, both of which re-seed the session's
   * composition kernel input (invalidating exactly the affected layout
   * queries). `read()` returns the current composition for host lookups.
   */
  readonly compositionControl?: {
    registerHost(hostId: NodeId, shadowRootId: NodeId): void;
    assignSlot(slotId: NodeId, assigned: readonly NodeId[]): void;
    read(): { hosts: ReadonlyMap<NodeId, readonly NodeId[]>; slots: ReadonlyMap<NodeId, readonly NodeId[]> } | null;
  };
};

/**
 * A host-side trusted input event about to be dispatched into the page (UI
 * Events). Plain data only — the document API synthesizes the guest-facing
 * event object (including `isTrusted: true` surface for real Event instances).
 */
export type PlatformEventInput = {
  readonly type: string;
  readonly bubbles?: boolean;
  readonly cancelable?: boolean;
  /** Viewport-relative pointer position (CSS px). */
  readonly clientX?: number;
  readonly clientY?: number;
  readonly button?: number;
  readonly buttons?: number;
  readonly detail?: number;
  readonly deltaX?: number;
  readonly deltaY?: number;
  readonly deltaZ?: number;
  readonly deltaMode?: number;
  readonly key?: string;
  readonly code?: string;
};

export function buildDocumentApi(
  session: FineSession,
  options: DocumentApiOptions = {},
): {
  readonly document: object;
  readonly globals: Record<string, unknown>;
  readonly mutations: () => number;
  readonly tickAnimations: (nowMs: number) => void;
  readonly hasActiveAnimations: () => boolean;
  /** Fire DOMContentLoaded at the document (HTML end-of-parsing lifecycle). */
  readonly fireDocumentLifecycleEvents: () => void;
  /**
   * Fire `load` (or `error`) on a dynamically-executed <script> element —
   * webpack-style loaders resolve chunk promises from the script's load
   * event; without it every dynamic chunk "times out" from the page's view.
   */
  readonly fireScriptElementEvent: (nodeId: NodeId, type: "load" | "error") => void;
  /**
   * Host→guest trusted input dispatch (UI Events): fire a platform-generated
   * pointer/mouse/wheel event at a DOM node through the full capture → target
   * → bubble path, then run activation behavior for `click`. This is the
   * bridge real browser input uses to reach page listeners; without it a
   * host-side click can only navigate, never run `addEventListener` handlers.
   */
  readonly dispatchPlatformEvent: (
    nodeId: NodeId,
    event: PlatformEventInput,
  ) => boolean;
} {
  let compileInlineHandler: ((body: string) => unknown) | null = null;
  let navigateToHashFragment: ((fragment: string) => void) | null = null;
  let mutations = 0;
  const geometryMode = options.geometryMode ?? "full";
  const styleMode = options.styleMode ?? "full";
  compileInlineHandler = options.inlineHandlerCompiler ?? null;
  navigateToHashFragment = options.hashNavigator ?? null;
  const profileGeom = process.env["ENGINE_PROFILE"] === "1";
  let gBcrCalls = 0;
  let gBcrLayoutFulls = 0;
  let gCsCalls = 0;
  let gCsCascade = 0;
  let layoutTreeCache: ReturnType<FineSession["layoutTree"]> | null = null;
  let layoutTreeEpoch = -1;
  let layoutTreeAt = 0;
  let geometryLayouts = 0;
  // Geometry throttle: a full layout recompute costs O(100ms+) on real
  // pages, and SPA bootstraps measure in tight loops (dozens of gBCR rounds
  // during mount). Two guards keep measure-driven boot loops from
  // serializing into tens of full layouts: at most one recompute per 200ms,
  // and a hard per-session budget (after it, callers see the last cached
  // tree — every engine repaint still refreshes it for free).
  const GEOM_THROTTLE_MS = 200;
  const GEOM_LAYOUT_BUDGET = 3;
const resolveLayoutTree = (): ReturnType<FineSession["layoutTree"]> | null => {
    if (geometryMode === "stub") return null;
    if (geometryMode === "full") {
      gBcrLayoutFulls += 1;
      return session.layoutTree();
    }
    const now = performance.now();
    const budgetLeft = geometryLayouts < GEOM_LAYOUT_BUDGET;
    if (
      layoutTreeCache === null ||
      (budgetLeft && layoutTreeEpoch !== mutations && now - layoutTreeAt >= GEOM_THROTTLE_MS)
    ) {
      gBcrLayoutFulls += 1;
      geometryLayouts += 1;
      layoutTreeCache = session.layoutTree();
      layoutTreeEpoch = mutations;
      layoutTreeAt = now;
    }
    return layoutTreeCache;
  };
  const rectFromTree = (
    tree: ReturnType<FineSession["layoutTree"]> | null,
    nodeId: NodeId,
  ): { x: number; y: number; width: number; height: number; top: number; left: number; right: number; bottom: number } => {
    if (tree === null) {
      return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
    }
    const r = boundingRect(tree, nodeId);
    const x = Number(r.x);
    const y = Number(r.y);
    const w = Number(r.width);
    const h = Number(r.height);
    return { x, y, width: w, height: h, top: y, left: x, right: x + w, bottom: y + h };
  };
  if (profileGeom) {
    process.once("exit", () => {
      console.error(
        `[profile] script.geom gBCR=${gBcrCalls} layoutFull=${gBcrLayoutFulls} gCS=${gCsCalls} cascade=${gCsCascade} mode=${geometryMode}/${styleMode}`,
      );
    });
  }

  // ---- Web Animations: active animations driven by the frame clock --------
  interface ActiveAnimation {
    readonly nodeId: NodeId;
    readonly effect: AnimationEffect;
    startTime: number | null;
    finished: boolean;
    cancelled: boolean;
    paused?: boolean;
    /** The guest-facing Animation handle `animate()` returned. */
    handle?: object;
    /** Inline values for the animated properties at start (to revert non-filling). */
    readonly prior: Map<string, string | undefined>;
  }
  const animations: ActiveAnimation[] = [];

  /** Parse a node's inline `style` attribute into a declaration map. */
  const parseInline = (nodeId: NodeId): Map<string, string> => {
    const map = new Map<string, string>();
    for (const decl of (session.dom.nodes.get(nodeId)?.attrs?.get("style") ?? "").split(";")) {
      const idx = decl.indexOf(":");
      if (idx > 0) map.set(decl.slice(0, idx).trim(), decl.slice(idx + 1).trim());
    }
    return map;
  };
  /** Merge `props` into a node's inline style and re-render (one mutation). */
  const applyInline = (nodeId: NodeId, props: Map<string, string | undefined>): void => {
    const map = parseInline(nodeId);
    for (const [k, v] of props) {
      if (v === undefined) map.delete(k);
      else map.set(k, v);
    }
    session.setAttribute(nodeId, "style", [...map].map(([k, v]) => `${k}: ${v}`).join("; "));
    mutations += 1;
  };

  /** Advance every active animation to `nowMs`, installing interpolated styles. */
  const tickAnimations = (nowMs: number): void => {
    for (const anim of animations) {
      if (anim.cancelled || anim.finished) continue;
      anim.startTime ??= nowMs;
      const active = nowMs - anim.startTime - anim.effect.delayMs;
      const beforeStart = active < 0;
      const raw =
        anim.effect.durationMs <= 0 ? (beforeStart ? 0 : 1) : Math.min(Math.max(active / anim.effect.durationMs, 0), 1);
      if (beforeStart && anim.effect.fill !== "backwards" && anim.effect.fill !== "both") continue;
      const eased = sampleEasing(anim.effect.easing, raw);
      const props = new Map<string, string | undefined>();
      for (const track of anim.effect.tracks) {
        props.set(track.cssName, serializeComputed(track.tsType, sampleTrack(track, eased)));
      }
      const done = !beforeStart && raw >= 1;
      if (done && (anim.effect.fill === "none" || anim.effect.fill === "backwards")) {
        // Not filling forwards: revert the animated properties to their pre-run values.
        applyInline(anim.nodeId, anim.prior);
        anim.finished = true;
      } else {
        applyInline(anim.nodeId, props);
        if (done) anim.finished = true;
      }
    }
  };
  const hasActiveAnimations = (): boolean => animations.some((a) => !a.cancelled && !a.finished);

  /** Map a guest element/text wrapper back to its session node id. */
  const idOf = new WeakMap<object, NodeId>();
  /** Recover a node id from a guest wrapper value (safely, for unknown inputs). */
  const idFromWrapper = (w: unknown): NodeId | undefined =>
    typeof w === "object" && w !== null ? idOf.get(w) : undefined;

  /** Registered event listeners, per node id. */
  type Listener = { readonly type: string; readonly fn: GuestFn; readonly capture: boolean };
  const listeners = new Map<NodeId, Listener[]>();
  /** Stable CSSStyleDeclaration wrappers; element.style keeps identity and expando state. */
  const styleWrappers = new Map<NodeId, object>();
  /** Live per-node property state the tree does not model (checked/open). */
  const nodeState = new Map<NodeId, { checked?: boolean; open?: boolean }>();
  /**
   * Inline `on<type>` attribute handler compiler. The guest context is created
   * by the CALLER of buildDocumentApi (the WPT runner / event loop), so it
   * injects a compiler that evals in its realm; without one, inline handlers
   * are inert. Hash navigation from link activation is injected the same way.
   * (Declared at the top of the factory, assigned from DocumentApiOptions.)
   */
  const inlineHandlerCache = new Map<string, GuestFn>();

  let idIndexEpoch = -1;
  let idIndex = new Map<string, NodeId>();
  const rebuildIdIndex = (): void => {
    idIndex = new Map();
    const visit = (id: NodeId): void => {
      const node = session.dom.nodes.get(id);
      if (node === undefined) return;
      if (node.kind === "element") {
        const attrId = node.attrs?.get("id");
        if (attrId !== undefined && attrId !== "" && !idIndex.has(attrId)) {
          idIndex.set(attrId, id);
        }
      }
      for (const child of node.children) visit(child);
    };
    visit(session.dom.root);
    idIndexEpoch = mutations;
  };
  const findByIdIndexed = (want: string): NodeId | null => {
    if (idIndexEpoch !== mutations) rebuildIdIndex();
    return idIndex.get(want) ?? null;
  };
  const collectByTag = (scopeRoot: NodeId | null, want: string): NodeId[] => {
    const out: NodeId[] = [];
    const visit = (id: NodeId, includeSelf: boolean): void => {
      const node = session.dom.nodes.get(id);
      if (node === undefined) return;
      if (includeSelf && node.kind === "element" && (want === "*" || node.tag === want)) out.push(id);
      for (const child of node.children) visit(child, true);
    };
    if (scopeRoot === null) {
      visit(session.dom.root, false);
    } else {
      for (const child of session.dom.nodes.get(scopeRoot)?.children ?? []) visit(child, true);
    }
    return out;
  };
  const collectByClass = (scopeRoot: NodeId | null, className: string): NodeId[] => {
    const out: NodeId[] = [];
    const visit = (id: NodeId, includeSelf: boolean): void => {
      const node = session.dom.nodes.get(id);
      if (node === undefined) return;
      if (includeSelf && node.kind === "element") {
        const cls = node.attrs?.get("class") ?? "";
        if (cls === className || cls.split(/\s+/).includes(className)) out.push(id);
      }
      for (const child of node.children) visit(child, true);
    };
    if (scopeRoot === null) {
      visit(session.dom.root, false);
    } else {
      for (const child of session.dom.nodes.get(scopeRoot)?.children ?? []) visit(child, true);
    }
    return out;
  };

  const queryAll = (selector: string, scopeRoot: NodeId | null): NodeId[] => {
    const trimmed = selector.trim();
    if (trimmed === "") return [];
    if (trimmed.charCodeAt(0) === 35 /* # */ && /^#[\w:-]+$/.test(trimmed)) {
      const want = trimmed.slice(1);
      if (scopeRoot !== null) {
        // Scoped `#id` queries must see detached subtrees too — the global id
        // index only covers the connected document.
        let found: NodeId | null = null;
        const visit = (id: NodeId): void => {
          const node = session.dom.nodes.get(id);
          if (node === undefined || found !== null) return;
          if (node.kind === "element" && node.attrs?.get("id") === want) found = id;
          for (const child of node.children) visit(child);
        };
        visit(scopeRoot);
        return found !== null && found !== scopeRoot ? [found] : [];
      }
      const found = findByIdIndexed(want);
      if (found === null) return [];
      return [found];
    }
    if (/^[a-zA-Z][\w-]*$/.test(trimmed)) {
      return collectByTag(scopeRoot, trimmed.toLowerCase());
    }
    if (trimmed.charCodeAt(0) === 46 /* . */ && /^\.[\w-]+$/.test(trimmed)) {
      return collectByClass(scopeRoot, trimmed.slice(1));
    }
    const rule: StyleRule = {
      selector: [{ text: selector }],
      declarations: [],
      specificity: [0, 0, 0],
      order: 0,
    };
    const out: NodeId[] = [];
    const visit = (id: NodeId, includeSelf: boolean): void => {
      const node = session.dom.nodes.get(id);
      if (node === undefined) return;
      if (includeSelf && node.kind === "element" && ruleMatches(rule, session.dom, id)) out.push(id);
      for (const child of node.children) visit(child, true);
    };
    visit(scopeRoot ?? session.dom.root, false);
    return out;
  };

  /** Collect matching element descendants from a connected subtree in tree order. */
  /** Element ids under `scopeRoot` matching a tag (or all elements for "*"). */
  const elementIdsByTagName = (scopeRoot: NodeId, want: string): NodeId[] => {
    const out: NodeId[] = [];
    const visit = (id: NodeId): void => {
      for (const childId of session.dom.nodes.get(id)?.children ?? []) {
        const node = session.dom.nodes.get(childId);
        if (node === undefined) continue;
        if (node.kind === "element" && (want === "*" || node.tag === want)) out.push(childId);
        visit(childId);
      }
    };
    visit(scopeRoot);
    return out;
  };

  /** Element ids under `scopeRoot` whose class attribute contains every token. */
  const elementIdsByClassName = (scopeRoot: NodeId, tokens: readonly string[]): NodeId[] =>
    elementIdsByTagName(scopeRoot, "*").filter((id) => {
      const cls = session.dom.nodes.get(id)?.attrs?.get("class") ?? "";
      const have = new Set(cls.split(/\s+/).filter((t) => t.length > 0));
      return tokens.every((t) => have.has(t));
    });

  // Elements whose `name` attribute participates in the HTMLCollection named
  // getter (HTML standard: https://html.spec.whatwg.org/#dom-htmlcollection-supported-property-names).
  const NAME_ATTRIBUTE_TAGS = new Set(["a", "applet", "area", "embed", "form", "frame", "frameset", "iframe", "img", "object"]);

  /**
   * A LIVE HTMLCollection over `queryIds` — re-evaluated on every access, so
   * DOM mutations are reflected immediately. Supports length, the indexed
   * property getter, item(), the named getter (id for every element; name for
   * the spec'd tag set), Symbol.iterator, and the platform object semantics
   * official WPT exercises (`in`, ownKeys, and strict-mode TypeError on
   * assignments that would shadow an indexed or supported named property).
   */
  const makeLiveCollection = (queryIds: () => readonly NodeId[]): object => {
    const snapshotIds = (): NodeId[] => queryIds().filter((id) => session.dom.nodes.has(id));
    const namedItem = (rawName: unknown): object | null => {
      const name = coerceGuestString(rawName);
      if (name === "") return null;
      for (const id of snapshotIds()) {
        const attrs = session.dom.nodes.get(id)?.attrs;
        if (attrs?.get("id") === name) return makeElementCached(id);
        if (NAME_ATTRIBUTE_TAGS.has(session.dom.nodes.get(id)?.tag ?? "") && attrs?.get("name") === name) {
          return makeElementCached(id);
        }
      }
      return null;
    };
    const supportedNames = (): string[] => {
      const names: string[] = [];
      for (const id of snapshotIds()) {
        const node = session.dom.nodes.get(id);
        const idAttr = node?.attrs?.get("id");
        if (idAttr !== undefined && idAttr !== "") names.push(idAttr);
        if (node !== undefined && node.attrs !== undefined && NAME_ATTRIBUTE_TAGS.has(node.tag ?? "")) {
          const nameAttr = node.attrs?.get("name");
          if (nameAttr !== undefined && nameAttr !== "") names.push(nameAttr);
        }
      }
      return names;
    };
    const isIndexKey = (prop: string): boolean => /^(0|[1-9][0-9]*)$/.test(prop);
    const valuesIterator = function* (): Generator<object> {
      for (const id of snapshotIds()) yield makeElementCached(id);
    };
    const methods: Record<string, unknown> = {
      item: (index: unknown): object | null => {
        const list = snapshotIds();
        const i = Math.trunc(Number(index));
        if (!Number.isFinite(i) || i < 0 || i >= list.length) return null;
        return makeElementCached(list[i] as NodeId);
      },
      namedItem,
      keys: function* (): Generator<number> {
        let i = 0;
        for (const _ of snapshotIds()) yield i++;
      },
      values: function* (): Generator<object> {
        yield* valuesIterator();
      },
      entries: function* (): Generator<[number, object]> {
        let i = 0;
        for (const id of snapshotIds()) yield [i++, makeElementCached(id)];
      },
      [Symbol.iterator]: valuesIterator,
      toString: () => "[object HTMLCollection]",
    };
    return new Proxy(methods, {
      get(_target, prop) {
        if (typeof prop === "symbol") return Reflect.get(methods, prop) as unknown;
        if (isIndexKey(prop)) {
          const list = snapshotIds();
          const i = Number(prop);
          return i < list.length ? makeElementCached(list[i] as NodeId) : undefined;
        }
        switch (prop) {
          case "length":
            return snapshotIds().length;
          default:
            return Reflect.get(methods, prop);
        }
      },
      has(_target, prop) {
        if (typeof prop === "string" && (isIndexKey(prop) || prop === "length")) return true;
        if (typeof prop === "symbol") return prop in methods;
        return supportedNames().includes(prop) || prop in methods;
      },
      ownKeys() {
        const keys = snapshotIds().map((_, i) => String(i));
        keys.push("length");
        keys.push(...supportedNames());
        return keys;
      },
      getOwnPropertyDescriptor(_target, prop) {
        if (typeof prop === "string" && isIndexKey(prop)) {
          const list = snapshotIds();
          const i = Number(prop);
          if (i < list.length) {
            return { value: makeElementCached(list[i] as NodeId), writable: true, enumerable: true, configurable: true };
          }
          return undefined;
        }
        if (prop === "length") {
          // configurable:true satisfies the proxy target-invariant check (the plain
          // methods object has no own 'length'); live semantics still hold — reads
          // re-query and assignment is rejected by the set trap.
          return { value: snapshotIds().length, writable: false, enumerable: true, configurable: true };
        }
        if (typeof prop === "string" && supportedNames().includes(prop)) {
          const found = namedItem(prop);
          if (found !== null) return { value: found, writable: true, enumerable: true, configurable: true };
        }
        return undefined;
      },
      set(_target, prop, value) {
        // [OverrideBuiltins]: assigning an indexed or supported named property
        // must not create an expando — strict-mode code throws.
        if (typeof prop === "string" && (isIndexKey(prop) || prop === "length" || supportedNames().includes(prop))) {
          throw new TypeError(`Cannot create proxy set property '${prop}' on an HTMLCollection`);
        }
        return Reflect.set(methods, prop, value);
      },
      deleteProperty(_target, prop) {
        if (typeof prop === "string" && (isIndexKey(prop) || prop === "length")) return false;
        if (typeof prop === "string" && supportedNames().includes(prop)) return false;
        return Reflect.deleteProperty(methods, prop);
      },
    });
  };

  /**
   * NodeList (DOM §7.1): `childNodes` returns a LIVE NodeList,
   * `querySelectorAll` a STATIC one. Same array-like surface as
   * HTMLCollection but WITHOUT the named getter, plus forEach; the
   * NodeListCtor.prototype ancestor makes `instanceof NodeList` work.
   */
  const NodeListCtor = function NodeList(): never {
    throw new Error("Illegal constructor");
  } as unknown as new () => object;
  Object.setPrototypeOf(NodeListCtor.prototype as object, Object.prototype);
  const makeNodeList = (queryIds: () => readonly NodeId[]): object => {
    const snapshotIds = (): NodeId[] => queryIds().filter((id) => session.dom.nodes.has(id));
    const isIndexKey = (prop: string): boolean => /^(0|[1-9][0-9]*)$/.test(prop);
    const valuesIterator = function* (): Generator<object> {
      for (const id of snapshotIds()) yield makeElementCached(id);
    };
    const methods: Record<string, unknown> = {
      item: (index: unknown): object | null => {
        const list = snapshotIds();
        const i = Math.trunc(Number(index));
        if (!Number.isFinite(i) || i < 0 || i >= list.length) return null;
        return makeElementCached(list[i] as NodeId);
      },
      forEach: (callback: unknown, thisArg?: unknown): void => {
        if (typeof callback !== "function") return;
        const list = snapshotIds();
        for (let i = 0; i < list.length; i += 1) {
          (callback as (n: object, i: number, l: object) => void).call(
            thisArg,
            makeElementCached(list[i] as NodeId),
            i,
            proxyRef,
          );
        }
      },
      keys: function* (): Generator<number> {
        let i = 0;
        for (const _ of snapshotIds()) yield i++;
      },
      values: function* (): Generator<object> {
        yield* valuesIterator();
      },
      entries: function* (): Generator<[number, object]> {
        let i = 0;
        for (const id of snapshotIds()) yield [i++, makeElementCached(id)];
      },
      [Symbol.iterator]: valuesIterator,
      toString: () => "[object NodeList]",
    };
    const proxyRef: object = new Proxy(methods, {
      getPrototypeOf(): object | null {
        return NodeListCtor.prototype as object;
      },
      get(_target, prop) {
        if (typeof prop === "symbol") return Reflect.get(methods, prop) as unknown;
        if (isIndexKey(prop)) {
          const list = snapshotIds();
          const i = Number(prop);
          return i < list.length ? makeElementCached(list[i] as NodeId) : undefined;
        }
        switch (prop) {
          case "length":
            return snapshotIds().length;
          default:
            return Reflect.get(methods, prop);
        }
      },
      has(_target, prop) {
        if (typeof prop === "string" && (isIndexKey(prop) || prop === "length")) return true;
        if (typeof prop === "symbol") return prop in methods;
        return prop in methods;
      },
      ownKeys() {
        const keys = snapshotIds().map((_, i) => String(i));
        keys.push("length");
        return keys;
      },
      getOwnPropertyDescriptor(_target, prop) {
        if (typeof prop === "string" && isIndexKey(prop)) {
          const list = snapshotIds();
          const i = Number(prop);
          if (i < list.length) {
            return { value: makeElementCached(list[i] as NodeId), writable: true, enumerable: true, configurable: true };
          }
          return undefined;
        }
        if (prop === "length") {
          // configurable:true satisfies the proxy target-invariant check (the plain
          // methods object has no own 'length'); live semantics still hold — reads
          // re-query and assignment is rejected by the set trap.
          return { value: snapshotIds().length, writable: false, enumerable: true, configurable: true };
        }
        return undefined;
      },
      set(_target, prop, value) {
        return Reflect.set(methods, prop, value);
      },
    });
    return proxyRef;
  };

  /** Whether `id`'s element matches `selector` (full selector engine). */
  const matchesSel = (id: NodeId, selector: string): boolean => {
    const node = session.dom.nodes.get(id);
    if (node === undefined || node.kind !== "element") return false;
    const rule: StyleRule = { selector: [{ text: selector }], declarations: [], specificity: [0, 0, 0], order: 0 };
    return ruleMatches(rule, session.dom, id);
  };

  /** Clone `sourceId` into a new detached subtree, preserving current node data. */
  const cloneSubtree = (sourceId: NodeId, deep: boolean): NodeId | null => {
    const source = session.dom.nodes.get(sourceId);
    if (source === undefined || source.kind === "document") return null;
    let cloneId: NodeId;
    if (source.kind === "element") {
      cloneId = session.createElement(source.tag ?? "");
      for (const [name, value] of source.attrs ?? []) {
        session.setAttribute(cloneId, name, value);
      }
    } else if (source.kind === "text") {
      cloneId = session.createTextNode(source.text ?? "");
    } else {
      cloneId = session.createComment(source.text ?? "");
    }
    if (deep) {
      for (const childId of source.children) {
        const childCloneId = cloneSubtree(childId, true);
        if (childCloneId !== null) session.appendChild(cloneId, childCloneId);
      }
    }
    return cloneId;
  };

  /** Compare two nodes by DOM structure/data, not wrapper identity or node ids. */
  const nodesStructurallyEqual = (leftId: NodeId, rightId: NodeId): boolean => {
    const left = session.dom.nodes.get(leftId);
    const right = session.dom.nodes.get(rightId);
    if (left === undefined || right === undefined) return false;
    if (left.kind !== right.kind) return false;
    if (left.kind === "element" && (left.tag ?? "") !== (right.tag ?? "")) return false;
    if ((left.kind === "text" || left.kind === "comment") && (left.text ?? "") !== (right.text ?? "")) return false;
    const leftAttrs = left.attrs ?? new Map<string, string>();
    const rightAttrs = right.attrs ?? new Map<string, string>();
    if (leftAttrs.size !== rightAttrs.size) return false;
    for (const [name, value] of leftAttrs) {
      if (rightAttrs.get(name) !== value) return false;
    }
    if (left.children.length !== right.children.length) return false;
    for (let i = 0; i < left.children.length; i += 1) {
      const leftChild = left.children[i];
      const rightChild = right.children[i];
      if (leftChild === undefined || rightChild === undefined) return false;
      if (!nodesStructurallyEqual(leftChild, rightChild)) return false;
    }
    return true;
  };

  /** Put a subtree into normalized DOM form: no empty/adjacent text nodes. */
  const normalizeSubtree = (targetId: NodeId): boolean => {
    const target = session.dom.nodes.get(targetId);
    if (target === undefined || target.kind === "text" || target.kind === "comment") return false;
    let changed = false;

    for (const childId of [...target.children]) {
      const child = session.dom.nodes.get(childId);
      if (child?.kind === "element" || child?.kind === "document") {
        changed = normalizeSubtree(childId) || changed;
      }
    }

    let previousTextId: NodeId | null = null;
    for (const childId of [...(session.dom.nodes.get(targetId)?.children ?? [])]) {
      const child = session.dom.nodes.get(childId);
      if (child === undefined || child.parent !== targetId) continue;
      if (child.kind !== "text") {
        previousTextId = null;
        continue;
      }

      const text = child.text ?? "";
      if (text === "") {
        session.removeChild(targetId, childId);
        changed = true;
        continue;
      }
      if (previousTextId === null) {
        previousTextId = childId;
        continue;
      }

      const previous = session.dom.nodes.get(previousTextId);
      session.setText(previousTextId, `${previous?.text ?? ""}${text}`);
      session.removeChild(targetId, childId);
      changed = true;
    }

    return changed;
  };

  /** DOM Standard document-position comparison, computed from the live tree. */
  const compareNodeDocumentPosition = (referenceId: NodeId, otherId: NodeId): number => {
    if (referenceId === otherId) return 0;

    const referencePath = ancestorPath(referenceId);
    const otherPath = ancestorPath(otherId);
    const referenceRoot = referencePath[referencePath.length - 1];
    const otherRoot = otherPath[otherPath.length - 1];

    if (referenceRoot === undefined || otherRoot === undefined || referenceRoot !== otherRoot) {
      const direction =
        Number(referenceId) < Number(otherId)
          ? DOCUMENT_POSITION_FOLLOWING
          : DOCUMENT_POSITION_PRECEDING;
      return DOCUMENT_POSITION_DISCONNECTED | DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC | direction;
    }

    if (referencePath.includes(otherId)) {
      return DOCUMENT_POSITION_CONTAINS | DOCUMENT_POSITION_PRECEDING;
    }
    if (otherPath.includes(referenceId)) {
      return DOCUMENT_POSITION_CONTAINED_BY | DOCUMENT_POSITION_FOLLOWING;
    }

    const referenceFromRoot = [...referencePath].reverse();
    const otherFromRoot = [...otherPath].reverse();
    let i = 0;
    while (
      i < referenceFromRoot.length &&
      i < otherFromRoot.length &&
      referenceFromRoot[i] === otherFromRoot[i]
    ) {
      i += 1;
    }

    const commonAncestor = referenceFromRoot[i - 1];
    const referenceBranch = referenceFromRoot[i];
    const otherBranch = otherFromRoot[i];
    const siblings = commonAncestor === undefined ? [] : (session.dom.nodes.get(commonAncestor)?.children ?? []);
    const referenceIndex = referenceBranch === undefined ? -1 : siblings.indexOf(referenceBranch);
    const otherIndex = otherBranch === undefined ? -1 : siblings.indexOf(otherBranch);
    return referenceIndex < otherIndex ? DOCUMENT_POSITION_FOLLOWING : DOCUMENT_POSITION_PRECEDING;
  };

  /** Convert ParentNode variadic arguments into nodes, using Text nodes for strings. */
  const nodeIdsFromParentNodeArgs = (values: unknown[]): NodeId[] =>
    values.map((value) => idFromWrapper(value) ?? session.createTextNode(String(value)));

  /**
   * After any tree insertion, <script> elements inserted from guest script
   * (not parser-created) get executed per HTML script-element semantics:
   * "when a script element that is not parser-inserted becomes connected,
   * fetch and run it." The runner's hook does the fetch/eval; this is a
   * no-op when no hook was injected (standalone callers).
   */
  const notifyDynamicScripts = (ids: readonly (NodeId | null | undefined)[]): void => {
    for (const id of ids) {
      if (id === null || id === undefined) continue;
      const node = session.dom.nodes.get(id);
      if (node?.kind !== "element") continue;
      if (node.tag === "script" && options.onDynamicScript !== undefined) options.onDynamicScript(id);
      // A <link> that becomes a connected, active stylesheet link finishes
      // loading its sheet during insertion — `load` fires at the element.
      if (
        node.tag === "link" &&
        isConnectedToDocument(session.dom, id, shadowHostResolver) &&
        isActiveStylesheetLink(node, session.isLinkEnabled(id))
      ) {
        dispatch(id, makeEvent("load"));
      }
      // A connected <iframe> loads its (empty/srcdoc) nested document and
      // fires `load` at the element.
      if (node.tag === "iframe" && isConnectedToDocument(session.dom, id, shadowHostResolver)) {
        ensureIframeDoc(id);
        dispatch(id, makeEvent("load"));
      }
    }
  };

  /** Detach nodes before variadic insertion, mirroring DOM's convert-nodes step. */
  const detachForVariadicInsert = (ids: readonly NodeId[]): void => {
    for (const id of ids) {
      const parent = session.dom.nodes.get(id)?.parent ?? null;
      if (parent !== null) session.removeChild(parent, id);
    }
  };

  /** Insert variadic ParentNode content at either edge of `parentId`. */
  const insertParentNodeContent = (parentId: NodeId, values: unknown[], edge: "append" | "prepend"): void => {
    if (values.length === 0) return;
    const ids = nodeIdsFromParentNodeArgs(values);
    detachForVariadicInsert(ids);
    const ref = edge === "prepend" ? (session.dom.nodes.get(parentId)?.children[0] ?? null) : null;
    for (const id of ids) {
      session.insertBefore(parentId, id, ref);
    }
    mutations += 1;
    notifyDynamicScripts(ids);
  };

  /** Insert variadic ChildNode content before or after `targetId` in its parent. */
  const insertChildNodeContent = (targetId: NodeId, values: unknown[], side: "before" | "after"): void => {
    if (values.length === 0) return;
    const parentId = session.dom.nodes.get(targetId)?.parent ?? null;
    if (parentId === null) return;
    const ids = nodeIdsFromParentNodeArgs(values);
    const moving = new Set(ids);
    const siblings = session.dom.nodes.get(parentId)?.children ?? [];
    const targetIndex = siblings.indexOf(targetId);
    if (targetIndex < 0) return;
    const viable =
      side === "before"
        ? [...siblings.slice(0, targetIndex)].reverse().find((id) => !moving.has(id))
        : siblings.slice(targetIndex + 1).find((id) => !moving.has(id));
    detachForVariadicInsert(ids);
    let ref: NodeId | null = null;
    if (side === "before") {
      const kids = session.dom.nodes.get(parentId)?.children ?? [];
      ref = viable === undefined ? (kids[0] ?? null) : (kids[kids.indexOf(viable) + 1] ?? null);
    } else {
      ref = viable ?? null;
    }
    for (const id of ids) {
      session.insertBefore(parentId, id, ref);
    }
    mutations += 1;
    notifyDynamicScripts(ids);
  };

  /** Replace a ChildNode receiver with variadic content at its old position. */
  const replaceChildNodeContent = (targetId: NodeId, values: unknown[]): void => {
    const parentId = session.dom.nodes.get(targetId)?.parent ?? null;
    if (parentId === null) return;
    const ids = nodeIdsFromParentNodeArgs(values);
    const moving = new Set(ids);
    const siblings = session.dom.nodes.get(parentId)?.children ?? [];
    const targetIndex = siblings.indexOf(targetId);
    if (targetIndex < 0) return;
    const viableNextSibling = siblings.slice(targetIndex + 1).find((id) => !moving.has(id)) ?? null;
    detachForVariadicInsert(ids);
    if (session.dom.nodes.get(targetId)?.parent === parentId) {
      session.removeChild(parentId, targetId);
    }
    const ref = viableNextSibling !== null && session.dom.nodes.get(viableNextSibling)?.parent === parentId
      ? viableNextSibling
      : null;
    for (const id of ids) {
      session.insertBefore(parentId, id, ref);
    }
    mutations += 1;
    notifyDynamicScripts(ids);
  };

  /**
   * DOM §4.4 insertAdjacent: insert `ids` relative to `targetId` at the given
   * position. "beforebegin"/"afterend" require a parent (throw SyntaxError per
   * spec when the receiver has none); returns whether any node was inserted.
   */
  const insertAdjacentNodes = (targetId: NodeId, ids: readonly NodeId[], position: unknown): boolean => {
    const where = coerceGuestString(position).toLowerCase();
    if (where !== "beforebegin" && where !== "afterbegin" && where !== "beforeend" && where !== "afterend") {
      throw new SyntaxError(`insertAdjacent: invalid position '${coerceGuestString(position)}'`);
    }
    const parentId = session.dom.nodes.get(targetId)?.parent ?? null;
    if (parentId === null && (where === "beforebegin" || where === "afterend")) {
      throw new SyntaxError("insertAdjacent: no parent for 'beforebegin'/'afterend'");
    }
    detachForVariadicInsert(ids);
    let parentIdUsed: NodeId = targetId;
    let ref: NodeId | null = null;
    if (where === "beforebegin") {
      parentIdUsed = parentId as NodeId;
      ref = targetId;
    } else if (where === "afterend") {
      parentIdUsed = parentId as NodeId;
      // after `targetId` — ref must be the real next sibling (null would append).
      const kids = session.dom.nodes.get(parentId as NodeId)?.children ?? [];
      const targetIndex = kids.indexOf(targetId);
      ref = targetIndex >= 0 ? (kids[targetIndex + 1] ?? null) : null;
    } else if (where === "afterbegin") {
      parentIdUsed = targetId;
      ref = (session.dom.nodes.get(targetId)?.children[0] ?? null);
    } else {
      parentIdUsed = targetId;
      ref = null;
    }
    for (const id of ids) {
      session.insertBefore(parentIdUsed, id, ref);
    }
    mutations += 1;
    return ids.length > 0;
  };

  /** A guest-visible node wrapper bound to a node id in the session. */
  let documentRef: object | null = null;
  let cookieJar = "";
  const canvasContexts = new Map<NodeId, object>();
  const makeCanvas2dContext = (canvasId: NodeId): object => {
    const state = {
      fillStyle: "#000000",
      strokeStyle: "#000000",
      lineWidth: 1,
      lineCap: "butt",
      lineJoin: "miter",
      miterLimit: 10,
      globalAlpha: 1,
      globalCompositeOperation: "source-over",
      font: "10px sans-serif",
      textAlign: "start",
      textBaseline: "alphabetic",
      direction: "inherit",
      shadowBlur: 0,
      shadowColor: "rgba(0, 0, 0, 0)",
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      imageSmoothingEnabled: true,
      imageSmoothingQuality: "low",
    };
    const measure = {
      width: 0,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: 0,
      actualBoundingBoxAscent: 0,
      actualBoundingBoxDescent: 0,
      fontBoundingBoxAscent: 0,
      fontBoundingBoxDescent: 0,
      emHeightAscent: 0,
      emHeightDescent: 0,
      hangingBaseline: 0,
      alphabeticBaseline: 0,
      ideographicBaseline: 0,
    };
    const ctx: Record<string, unknown> = {
      canvas: null,
      get fillStyle() {
        return state.fillStyle;
      },
      set fillStyle(v: unknown) {
        state.fillStyle = String(v);
      },
      get strokeStyle() {
        return state.strokeStyle;
      },
      set strokeStyle(v: unknown) {
        state.strokeStyle = String(v);
      },
      get lineWidth() {
        return state.lineWidth;
      },
      set lineWidth(v: unknown) {
        state.lineWidth = Number(v) || 0;
      },
      get lineCap() {
        return state.lineCap;
      },
      set lineCap(v: unknown) {
        state.lineCap = String(v);
      },
      get lineJoin() {
        return state.lineJoin;
      },
      set lineJoin(v: unknown) {
        state.lineJoin = String(v);
      },
      get miterLimit() {
        return state.miterLimit;
      },
      set miterLimit(v: unknown) {
        state.miterLimit = Number(v) || 0;
      },
      get globalAlpha() {
        return state.globalAlpha;
      },
      set globalAlpha(v: unknown) {
        state.globalAlpha = Number(v) || 0;
      },
      get globalCompositeOperation() {
        return state.globalCompositeOperation;
      },
      set globalCompositeOperation(v: unknown) {
        state.globalCompositeOperation = String(v);
      },
      get font() {
        return state.font;
      },
      set font(v: unknown) {
        state.font = String(v);
      },
      get textAlign() {
        return state.textAlign;
      },
      set textAlign(v: unknown) {
        state.textAlign = String(v);
      },
      get textBaseline() {
        return state.textBaseline;
      },
      set textBaseline(v: unknown) {
        state.textBaseline = String(v);
      },
      get direction() {
        return state.direction;
      },
      set direction(v: unknown) {
        state.direction = String(v);
      },
      get shadowBlur() {
        return state.shadowBlur;
      },
      set shadowBlur(v: unknown) {
        state.shadowBlur = Number(v) || 0;
      },
      get shadowColor() {
        return state.shadowColor;
      },
      set shadowColor(v: unknown) {
        state.shadowColor = String(v);
      },
      get shadowOffsetX() {
        return state.shadowOffsetX;
      },
      set shadowOffsetX(v: unknown) {
        state.shadowOffsetX = Number(v) || 0;
      },
      get shadowOffsetY() {
        return state.shadowOffsetY;
      },
      set shadowOffsetY(v: unknown) {
        state.shadowOffsetY = Number(v) || 0;
      },
      get imageSmoothingEnabled() {
        return state.imageSmoothingEnabled;
      },
      set imageSmoothingEnabled(v: unknown) {
        state.imageSmoothingEnabled = Boolean(v);
      },
      get imageSmoothingQuality() {
        return state.imageSmoothingQuality;
      },
      set imageSmoothingQuality(v: unknown) {
        state.imageSmoothingQuality = String(v);
      },
      save() {},
      restore() {},
      beginPath() {},
      closePath() {},
      moveTo(_x: unknown, _y: unknown) {},
      lineTo(_x: unknown, _y: unknown) {},
      bezierCurveTo(_a: unknown, _b: unknown, _c: unknown, _d: unknown, _e: unknown, _f: unknown) {},
      quadraticCurveTo(_a: unknown, _b: unknown, _c: unknown, _d: unknown) {},
      arc(_x: unknown, _y: unknown, _r: unknown, _a0: unknown, _a1: unknown, _ccw?: unknown) {},
      arcTo(_x1: unknown, _y1: unknown, _x2: unknown, _y2: unknown, _r: unknown) {},
      ellipse(_x: unknown, _y: unknown, _rx: unknown, _ry: unknown, _rot: unknown, _a0: unknown, _a1: unknown, _ccw?: unknown) {},
      rect(_x: unknown, _y: unknown, _w: unknown, _h: unknown) {},
      fill(_a?: unknown, _b?: unknown) {},
      stroke(_path?: unknown) {},
      clip(_a?: unknown, _b?: unknown) {},
      clearRect(_x: unknown, _y: unknown, _w: unknown, _h: unknown) {},
      fillRect(_x: unknown, _y: unknown, _w: unknown, _h: unknown) {},
      strokeRect(_x: unknown, _y: unknown, _w: unknown, _h: unknown) {},
      fillText(_t: unknown, _x: unknown, _y: unknown, _mw?: unknown) {},
      strokeText(_t: unknown, _x: unknown, _y: unknown, _mw?: unknown) {},
      measureText(text: unknown): object {
        const s = coerceGuestString(text);
        const width = Math.max(0, s.length * 6);
        return { ...measure, width };
      },
      drawImage(_img: unknown, ..._rest: unknown[]) {},
      createImageData(w: unknown, h?: unknown): object {
        const width = typeof w === "object" && w !== null && "width" in (w)
          ? Number((w).width) || 0
          : Number(w) || 0;
        const height = typeof w === "object" && w !== null && "height" in (w)
          ? Number((w).height) || 0
          : Number(h) || 0;
        return {
          width,
          height,
          data: new Uint8ClampedArray(Math.max(0, Math.floor(width) * Math.floor(height) * 4)),
        };
      },
      getImageData(this: { createImageData: (w: unknown, h?: unknown) => object }, _x: unknown, _y: unknown, w: unknown, h: unknown): object {
        return this.createImageData(w, h);
      },
      putImageData(_data: unknown, _x: unknown, _y: unknown, ..._rest: unknown[]) {},
      createLinearGradient(_x0: unknown, _y0: unknown, _x1: unknown, _y1: unknown): object {
        return { addColorStop(_o: unknown, _c: unknown) {} };
      },
      createRadialGradient(_x0: unknown, _y0: unknown, _r0: unknown, _x1: unknown, _y1: unknown, _r1: unknown): object {
        return { addColorStop(_o: unknown, _c: unknown) {} };
      },
      createPattern(_img: unknown, _rep: unknown): object | null {
        return { setTransform(_m: unknown) {} };
      },
      scale(_x: unknown, _y: unknown) {},
      rotate(_a: unknown) {},
      translate(_x: unknown, _y: unknown) {},
      transform(_a: unknown, _b: unknown, _c: unknown, _d: unknown, _e: unknown, _f: unknown) {},
      setTransform(_a?: unknown, _b?: unknown, _c?: unknown, _d?: unknown, _e?: unknown, _f?: unknown) {},
      resetTransform() {},
      getTransform(): object {
        return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
      },
      setLineDash(_seg: unknown) {},
      getLineDash(): number[] {
        return [];
      },
      lineDashOffset: 0,
      isPointInPath(..._args: unknown[]): boolean {
        return false;
      },
      isPointInStroke(..._args: unknown[]): boolean {
        return false;
      },
      drawFocusIfNeeded(_el?: unknown) {},
    };
    Object.defineProperty(ctx, "canvas", {
      get: () => makeElementCached(canvasId),
      enumerable: true,
    });
    return ctx;
  };
  /**
   * URL decomposition IDL attributes (HTML §2.6 "URL decomposition IDL
   * attributes") for hyperlink elements (`a`, `area`): every accessor reflects
   * the resolved absolute URL of the `href` content attribute. Libraries (e.g.
   * axios's browser URL normalizer) rely on `document.createElement("a")` +
   * `setAttribute("href", url)` and then read `protocol`/`host`/`pathname`…
   * without these getters the reads come back `undefined` and the consuming
   * code crashes on `undefined.charAt`. Returned as PROPERTY DESCRIPTORS and
   * installed with `Object.defineProperties` — an object-literal spread would
   * invoke each getter once at element-creation time and freeze the fallback
   * values in as plain data properties. Setters re-serialize through the URL
   * per component per spec; the remaining setters are silent no-ops matching
   * the rest of this surface.
   */
  const urlDecompositionDescriptors = (
    nodeId: NodeId,
    session: FineSession,
  ): PropertyDescriptorMap => {
    const resolvedUrl = (): URL | null => {
      const node = session.dom.nodes.get(nodeId);
      const raw = node?.attrs?.get("href");
      if (raw === undefined || raw === "") return null;
      try {
        // Host-realm URL: inside a vm context the guest realm may not define a
        // `URL` global, so reference the statically imported binding.
        return new HostURL(raw, session.baseUrl);
      } catch {
        return null;
      }
    };
    return {
      protocol: {
        // No href → the spec's "no resolved URL" state: every component is "".
        get: () => resolvedUrl()?.protocol ?? "",
        set: (value: unknown) => {
          const url = resolvedUrl();
          if (url !== null) {
            session.setAttribute(nodeId, "href", `${String(value)}${url.href.slice(url.href.indexOf(":") + 1)}`);
            mutations += 1;
          }
        },
      },
      host: { get: () => resolvedUrl()?.host ?? "" },
      hostname: { get: () => resolvedUrl()?.hostname ?? "" },
      port: { get: () => resolvedUrl()?.port ?? "" },
      pathname: { get: () => resolvedUrl()?.pathname ?? "" },
      search: { get: () => resolvedUrl()?.search ?? "" },
      hash: {
        get: () => resolvedUrl()?.hash ?? "",
        set: (value: unknown) => {
          const url = resolvedUrl();
          if (url === null) return;
          url.hash = coerceGuestString(value);
          session.setAttribute(nodeId, "href", url.href);
          mutations += 1;
        },
      },
      origin: { get: () => resolvedUrl()?.origin ?? "" },
    };
  };
  const makeElement = (nodeId: NodeId): object => {
    const wrapper: Record<string, unknown> = {
      get nodeType(): number {
        const node = session.dom.nodes.get(nodeId);
        if (node === undefined) return 0;
        if (node.kind === "element") return 1;
        if (node.kind === "text") return 3;
        if (node.kind === "comment") return 8;
        return 1;
      },
      get nodeName(): string {
        const node = session.dom.nodes.get(nodeId);
        if (node === undefined) return "#document";
        if (node.kind === "text") return "#text";
        if (node.kind === "comment") return "#comment";
        return (node.tag ?? "").toUpperCase();
      },
      get localName(): string {
        const node = session.dom.nodes.get(nodeId);
        return node?.kind === "element" ? (node.tag ?? "") : "";
      },
      get ownerDocument(): object | null {
        return documentRef;
      },
      getAttribute(name: unknown): string | null {
        const node = session.dom.nodes.get(nodeId);
        return node?.attrs?.get(htmlAttributeName(name)) ?? null;
      },
      setAttribute(name: unknown, value: unknown): void {
        const attr = htmlAttributeName(name);
        session.setAttribute(
          nodeId,
          attr,
          attr === "style" ? rewriteStyleAttrUrls(String(value)) : String(value),
        );
        mutations += 1;
        // HTML script-element semantics: setting `src` on a CONNECTED script
        // element triggers the fetch-and-run steps (the classic SPA loader
        // pattern: append first, then set src).
        if (attr === "src" && options.onDynamicScript !== undefined) {
          const node = session.dom.nodes.get(nodeId);
          if (node?.kind === "element" && node.tag === "script" && isConnectedToDocument(session.dom, nodeId, shadowHostResolver)) {
            options.onDynamicScript(nodeId);
          }
        }
      },
      // a/area href: the activation behavior reads this attribute, and tests
      // retarget links through the IDL property.
      get href(): string {
        return session.dom.nodes.get(nodeId)?.attrs?.get("href") ?? "";
      },
      set href(value: unknown) {
        session.setAttribute(nodeId, "href", coerceGuestString(value));
        mutations += 1;
      },
      get src(): string {
        return session.dom.nodes.get(nodeId)?.attrs?.get("src") ?? "";
      },
      set src(value: unknown) {
        session.setAttribute(nodeId, "src", coerceGuestString(value));
        mutations += 1;
      },
      hasAttribute(name: unknown): boolean {
        return session.dom.nodes.get(nodeId)?.attrs?.has(htmlAttributeName(name)) ?? false;
      },
      removeAttribute(name: unknown): void {
        session.removeAttribute(nodeId, htmlAttributeName(name));
        mutations += 1;
      },
      getAttributeNames(): string[] {
        const node = session.dom.nodes.get(nodeId);
        return node?.kind === "element" ? [...(node.attrs?.keys() ?? [])] : [];
      },
      toggleAttribute(name: unknown, force?: unknown): boolean {
        const attr = htmlAttributeName(name);
        const has = session.dom.nodes.get(nodeId)?.attrs?.has(attr) ?? false;
        const shouldHave = arguments.length > 1 ? Boolean(force) : !has;
        if (shouldHave && !has) {
          session.setAttribute(nodeId, attr, "");
          mutations += 1;
        } else if (!shouldHave && has) {
          session.removeAttribute(nodeId, attr);
          mutations += 1;
        }
        return shouldHave;
      },
      // Namespaced attributes (SVG/xlink): the attribute table stores the
      // qualified name verbatim ("xlink:title"), so NS reads resolve by
      // matching the localName suffix of a qualified name.
      setAttributeNS(_ns: unknown, qualifiedName: unknown, value: unknown): void {
        const qn = String(qualifiedName);
        session.setAttribute(
          nodeId,
          qn,
          qn.toLowerCase() === "style" ? rewriteStyleAttrUrls(String(value)) : String(value),
        );
        mutations += 1;
      },
      getAttributeNS(_ns: unknown, localName: unknown): string | null {
        const attrs = session.dom.nodes.get(nodeId)?.attrs;
        if (attrs === undefined) return null;
        const local = String(localName);
        const direct = attrs.get(local);
        if (direct !== undefined) return direct;
        for (const [key, val] of attrs) {
          if (key.endsWith(`:${local}`)) return val;
        }
        return null;
      },
      hasAttributeNS(_ns: unknown, localName: unknown): boolean {
        const attrs = session.dom.nodes.get(nodeId)?.attrs;
        if (attrs === undefined) return false;
        const local = String(localName);
        if (attrs.has(local)) return true;
        for (const key of attrs.keys()) {
          if (key.endsWith(`:${local}`)) return true;
        }
        return false;
      },
      removeAttributeNS(_ns: unknown, localName: unknown): void {
        const attrs = session.dom.nodes.get(nodeId)?.attrs;
        if (attrs === undefined) return;
        const local = String(localName);
        if (attrs.has(local)) {
          session.removeAttribute(nodeId, local);
          mutations += 1;
          return;
        }
        for (const key of attrs.keys()) {
          if (key.endsWith(`:${local}`)) {
            session.removeAttribute(nodeId, key);
            mutations += 1;
            return;
          }
        }
      },
      get tagName(): string {
        return (session.dom.nodes.get(nodeId)?.tag ?? "").toUpperCase();
      },
      get namespaceURI(): string {
        const tag = session.dom.nodes.get(nodeId)?.tag ?? "";
        if (tag === "svg" || tag === "path" || tag === "g" || tag === "circle" || tag === "rect" || tag === "line" || tag === "polyline" || tag === "polygon" || tag === "ellipse" || tag === "text" || tag === "tspan" || tag === "defs" || tag === "use" || tag === "symbol" || tag === "clipPath" || tag === "mask" || tag === "pattern" || tag === "linearGradient" || tag === "radialGradient" || tag === "stop" || tag === "image" || tag === "foreignObject") {
          return "http://www.w3.org/2000/svg";
        }
        if (tag === "math" || tag === "mi" || tag === "mo" || tag === "mn" || tag === "mrow") {
          return "http://www.w3.org/1998/Math/MathML";
        }
        return "http://www.w3.org/1999/xhtml";
      },
      get baseURI(): string {
        return session.baseUrl;
      },
      get id(): string {
        return session.dom.nodes.get(nodeId)?.attrs?.get("id") ?? "";
      },
      set id(value: unknown) {
        session.setAttribute(nodeId, "id", String(value));
        mutations += 1;
      },
      get className(): string {
        return session.dom.nodes.get(nodeId)?.attrs?.get("class") ?? "";
      },
      set className(value: unknown) {
        session.setAttribute(nodeId, "class", String(value));
        mutations += 1;
      },
      get classList(): object {
        const tokens = (): string[] =>
          (session.dom.nodes.get(nodeId)?.attrs?.get("class") ?? "").split(/\s+/).filter((t) => t.length > 0);
        const write = (list: string[]): void => {
          session.setAttribute(nodeId, "class", list.join(" "));
          mutations += 1;
        };
        const validate = (token: string): void => {
          if (token === "") throw new Error("SyntaxError: token must not be empty");
          if (/[\t\n\f\r ]/.test(token)) throw new Error("InvalidCharacterError: token must not contain ASCII whitespace");
        };
        const validateAll = (values: unknown[]): string[] => {
          const out = values.map(String);
          for (const token of out) validate(token);
          return out;
        };
        return {
          add(...cs: unknown[]): void {
            const names = validateAll(cs);
            const set = tokens();
            for (const name of names) if (!set.includes(name)) set.push(name);
            write(set);
          },
          remove(...cs: unknown[]): void {
            const drop = new Set(validateAll(cs));
            write(tokens().filter((t) => !drop.has(t)));
          },
          toggle(c: unknown, force?: unknown): boolean {
            const name = String(c);
            validate(name);
            const has = tokens().includes(name);
            const shouldHave = force === undefined ? !has : force === true;
            if (shouldHave && !has) write([...tokens(), name]);
            else if (!shouldHave && has) write(tokens().filter((t) => t !== name));
            return shouldHave;
          },
          replace(oldToken: unknown, newToken: unknown): boolean {
            const oldName = String(oldToken);
            const newName = String(newToken);
            validate(oldName);
            validate(newName);
            if (!tokens().includes(oldName)) return false;
            const out: string[] = [];
            let replaced = false;
            for (const token of tokens()) {
              if (token === oldName || token === newName) {
                if (!replaced) {
                  out.push(newName);
                  replaced = true;
                }
              } else {
                out.push(token);
              }
            }
            write(out);
            return true;
          },
          contains(c: unknown): boolean {
            return tokens().includes(String(c));
          },
          item(i: unknown): string | null {
            return tokens()[Number(i)] ?? null;
          },
          get length(): number {
            return tokens().length;
          },
        };
      },
      get dataset(): object {
        const toKebab = (p: string): string => `data-${p.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
        const toCamel = (name: string): string | null =>
          name.startsWith("data-") && name.length > "data-".length
            ? name.slice("data-".length).replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())
            : null;
        const keys = (): string[] => {
          const out: string[] = [];
          const seen = new Set<string>();
          for (const name of session.dom.nodes.get(nodeId)?.attrs?.keys() ?? []) {
            const prop = toCamel(name);
            if (prop !== null && !seen.has(prop)) {
              out.push(prop);
              seen.add(prop);
            }
          }
          return out;
        };
        return new Proxy(
          {},
          {
            get: (_t, prop): unknown =>
              typeof prop === "string" ? session.dom.nodes.get(nodeId)?.attrs?.get(toKebab(prop)) : undefined,
            set: (_t, prop, value): boolean => {
              if (typeof prop === "string") {
                session.setAttribute(nodeId, toKebab(prop), String(value));
                mutations += 1;
              }
              return true;
            },
            deleteProperty: (_t, prop): boolean => {
              if (typeof prop === "string") {
                const attr = toKebab(prop);
                if (session.dom.nodes.get(nodeId)?.attrs?.has(attr) === true) {
                  session.removeAttribute(nodeId, attr);
                  mutations += 1;
                }
              }
              return true;
            },
            has: (_t, prop): boolean =>
              typeof prop === "string" && (session.dom.nodes.get(nodeId)?.attrs?.has(toKebab(prop)) ?? false),
            ownKeys: (): string[] => keys(),
            getOwnPropertyDescriptor: (_t, prop): PropertyDescriptor | undefined => {
              if (typeof prop !== "string") return undefined;
              const value = session.dom.nodes.get(nodeId)?.attrs?.get(toKebab(prop));
              return value === undefined ? undefined : { value, writable: true, enumerable: true, configurable: true };
            },
          },
        );
      },
      get style(): object {
        return makeStyleDeclarationCached(nodeId);
      },
      // Typed OM: `attributeStyleMap` is the mutable StylePropertyMap view of
      // the same inline declaration `style` exposes — both read through to the
      // style attribute, so they stay in sync automatically.
      get attributeStyleMap(): object {
        return attributeStyleMapForNode(nodeId);
      },
      computedStyleMap(): object {
        return computedStyleMapForNode(nodeId);
      },
      set style(value: unknown) {
        // `el.style = "…"` assigns the style attribute's cssText wholesale.
        session.setAttribute(nodeId, "style", coerceGuestString(value));
        mutations += 1;
      },
      get textContent(): string {
        return textContentOf(session.dom, nodeId);
      },
      set textContent(text: unknown) {
        replaceTextContent(session, nodeId, textContentString(text));
        mutations += 1;
      },
      get data(): string {
        const node = session.dom.nodes.get(nodeId);
        return node?.kind === "text" || node?.kind === "comment" ? (node.text ?? "") : "";
      },
      set data(value: unknown) {
        const node = session.dom.nodes.get(nodeId);
        if (node?.kind === "text" || node?.kind === "comment") {
          session.setText(nodeId, String(value));
          mutations += 1;
        }
      },
      get childNodes(): object {
        return makeNodeList(() => session.dom.nodes.get(nodeId)?.children ?? []);
      },
      hasChildNodes(): boolean {
        return (session.dom.nodes.get(nodeId)?.children.length ?? 0) > 0;
      },
      get children(): object {
        return makeLiveCollection(() =>
          (session.dom.nodes.get(nodeId)?.children ?? []).filter(
            (childId) => session.dom.nodes.get(childId)?.kind === "element",
          ),
        );
      },
      get firstChild(): object | null {
        const kids = session.dom.nodes.get(nodeId)?.children ?? [];
        const first = kids[0];
        return first !== undefined ? makeElementCached(first) : null;
      },
      get lastChild(): object | null {
        const kids = session.dom.nodes.get(nodeId)?.children ?? [];
        const last = kids[kids.length - 1];
        return last !== undefined ? makeElementCached(last) : null;
      },
      get firstElementChild(): object | null {
        return edgeElementChild(nodeId, 1);
      },
      get lastElementChild(): object | null {
        return edgeElementChild(nodeId, -1);
      },
      get childElementCount(): number {
        return (session.dom.nodes.get(nodeId)?.children ?? []).filter(
          (c) => session.dom.nodes.get(c)?.kind === "element",
        ).length;
      },
      get parentNode(): object | null {
        const p = session.dom.nodes.get(nodeId)?.parent ?? null;
        return p === null ? null : makeElementCached(p);
      },
      get parentElement(): object | null {
        const p = session.dom.nodes.get(nodeId)?.parent ?? null;
        return p !== null && session.dom.nodes.get(p)?.kind === "element" ? makeElementCached(p) : null;
      },
      get isConnected(): boolean {
        return isConnectedToDocument(session.dom, nodeId, shadowHostResolver);
      },
      contains(other: unknown): boolean {
        const otherId = idFromWrapper(other);
        return otherId !== undefined && containsNode(session.dom, nodeId, otherId);
      },
      cloneNode(deep?: unknown): object {
        const cloneId = cloneSubtree(nodeId, Boolean(deep));
        if (cloneId === null) throw new Error("cloneNode cannot clone this node");
        return makeElementCached(cloneId);
      },
      isEqualNode(other: unknown): boolean {
        const otherId = idFromWrapper(other);
        return otherId !== undefined && nodesStructurallyEqual(nodeId, otherId);
      },
      normalize(): void {
        if (normalizeSubtree(nodeId)) mutations += 1;
      },
      compareDocumentPosition(other: unknown): number {
        const otherId = idFromWrapper(other);
        if (otherId === undefined) throw new TypeError("compareDocumentPosition requires a Node");
        return compareNodeDocumentPosition(nodeId, otherId);
      },
      ...NODE_DOCUMENT_POSITION_CONSTANTS,
      get nextElementSibling(): object | null {
        return siblingElement(nodeId, 1);
      },
      get previousElementSibling(): object | null {
        return siblingElement(nodeId, -1);
      },
      get nextSibling(): object | null {
        return siblingNode(nodeId, 1);
      },
      get previousSibling(): object | null {
        return siblingNode(nodeId, -1);
      },
      get innerHTML(): string {
        return serializeChildrenHtml(nodeId);
      },
      set innerHTML(html: unknown) {
        replaceInnerHtml(nodeId, coerceGuestString(html));
        mutations += 1;
      },
      get outerHTML(): string {
        return serializeNodeHtml(nodeId);
      },
      set outerHTML(html: unknown) {
        replaceOuterHtml(nodeId, coerceGuestString(html));
        mutations += 1;
      },
      get content(): object | null {
        const node = session.dom.nodes.get(nodeId);
        if (node?.kind === "element" && node.tag === "template") {
          return makeElementCached(nodeId);
        }
        return null;
      },
      remove(): void {
        const parent = session.dom.nodes.get(nodeId)?.parent ?? null;
        if (parent !== null) {
          session.removeChild(parent, nodeId);
          mutations += 1;
        }
      },
      /**
       * D6 — Shadow DOM (Web Components §3): create a shadow root under this
       * element. The shadow tree is regular DOM in the session; the returned
       * ShadowRoot wrapper exposes it for guest manipulation. The document's
       * composition input updates so layout renders the flat tree: this host
       * lays out its shadow children, and `<slot>`s inside pull light children.
       */
      attachShadow(init?: unknown): object {
        const mode = init !== null && typeof init === "object" && (init as { mode?: unknown }).mode === "closed"
          ? "closed"
          : "open";
        // Build the shadow tree in the session's DOM: a detached root node
        // carrying the host's children position.
        const shadowRootId = session.createElement("#shadow-root");
        session.setAttribute(shadowRootId, "data-shadow-mode", mode);
        shadowRootIds.set(nodeId, { rootId: shadowRootId, mode });
        session.registerShadowHost(nodeId, shadowRootId);
        // Record the host → shadow-children composition. The shadow root's
        // children are what the host renders.
        compositionMutator?.registerHost(nodeId, shadowRootId);
        mutations += 1;
        return makeShadowRoot(shadowRootId, mode);
      },
      /** ShadowRoot host accessor: open roots are reachable via `el.shadowRoot`. */
      get shadowRoot(): object | null {
        const entry = shadowRootIds.get(nodeId);
        if (entry === undefined || entry.mode === "closed") return null;
        return makeShadowRoot(entry.rootId, entry.mode);
      },
      appendChild(child: unknown): unknown {
        const childId = idFromWrapper(child);
        if (childId !== undefined) {
          session.appendChild(nodeId, childId);
          mutations += 1;
          notifyDynamicScripts([childId]);
        }
        return child;
      },
      append(...values: unknown[]): void {
        insertParentNodeContent(nodeId, values, "append");
      },
      prepend(...values: unknown[]): void {
        insertParentNodeContent(nodeId, values, "prepend");
      },
      before(...values: unknown[]): void {
        insertChildNodeContent(nodeId, values, "before");
      },
      after(...values: unknown[]): void {
        insertChildNodeContent(nodeId, values, "after");
      },
      replaceWith(...values: unknown[]): void {
        replaceChildNodeContent(nodeId, values);
      },
      /**
       * HTML §4.2.5 / DOM §4.4: insert adjacent element/text relative to this
       * element ("beforebegin" | "afterbegin" | "beforeend" | "afterend",
       * case-insensitive). Returns the inserted element (insertAdjacentElement)
       * so chains like `d.insertAdjacentElement("afterend", el).focus()` work.
       * Throws SyntaxError on an unknown position, matching the platform.
       */
      insertAdjacentElement(position: unknown, element: unknown): object | null {
        const id = idFromWrapper(element);
        if (id === undefined) return null;
        insertAdjacentNodes(nodeId, [id], position);
        return element as object;
      },
      insertAdjacentText(position: unknown, text: unknown): void {
        insertAdjacentNodes(nodeId, [session.createTextNode(coerceGuestString(text))], position);
      },
      removeChild(child: unknown): unknown {
        const childId = idFromWrapper(child);
        if (childId !== undefined) {
          if (session.dom.nodes.get(childId)?.parent !== nodeId) {
            throw new Error("removeChild child is not a child of this node");
          }
          session.removeChild(nodeId, childId);
          mutations += 1;
        }
        return child;
      },
      replaceChild(newChild: unknown, oldChild: unknown): unknown {
        const newChildId = idFromWrapper(newChild);
        const oldChildId = idFromWrapper(oldChild);
        if (newChildId !== undefined && oldChildId !== undefined && newChildId !== oldChildId) {
          if (session.dom.nodes.get(oldChildId)?.parent !== nodeId) {
            throw new Error("replaceChild oldChild is not a child of this node");
          }
          session.insertBefore(nodeId, newChildId, oldChildId);
          session.removeChild(nodeId, oldChildId);
          mutations += 1;
        }
        return oldChild;
      },
      insertBefore(child: unknown, ref: unknown): unknown {
        const childId = idFromWrapper(child);
        const refId = idFromWrapper(ref) ?? null;
        if (childId !== undefined && refId !== null && childId === refId) {
          return child;
        }
        if (childId !== undefined) {
          if (refId !== null && session.dom.nodes.get(refId)?.parent !== nodeId) {
            throw new Error("insertBefore reference node is not a child of this node");
          }
          session.insertBefore(nodeId, childId, refId);
          mutations += 1;
        }
        return child;
      },
      getElementsByTagName(tag: unknown): object {
        const want = coerceGuestString(tag).toLowerCase();
        return makeLiveCollection(() => elementIdsByTagName(nodeId, want));
      },
      getElementsByTagNameNS(_ns: unknown, localName: unknown): object {
        const local = coerceGuestString(localName).toLowerCase();
        return makeLiveCollection(() => elementIdsByTagName(nodeId, local === "*" ? "*" : local));
      },
      getElementsByClassName(names: unknown): object {
        const tokens = coerceGuestString(names).trim().split(/\s+/).filter((t) => t.length > 0);
        return makeLiveCollection(() => elementIdsByClassName(nodeId, tokens));
      },
      querySelector(selector: unknown): object | null {
        const ids = queryAll(String(selector), nodeId);
        return ids.length > 0 ? makeElementCached(ids[0] as NodeId) : null;
      },
      querySelectorAll(selector: unknown): object {
        // Static NodeList: the query is evaluated ONCE (DOM §8.2.3), unlike
        // the live childNodes collection.
        const snapshot = queryAll(String(selector), nodeId);
        return makeNodeList(() => snapshot);
      },
      matches(selector: unknown): boolean {
        return matchesSel(nodeId, String(selector));
      },
      closest(selector: unknown): object | null {
        const sel = String(selector);
        let cur: NodeId | null = nodeId;
        while (cur !== null) {
          if (matchesSel(cur, sel)) return makeElementCached(cur);
          cur = session.dom.nodes.get(cur)?.parent ?? null;
        }
        return null;
      },
      addEventListener(type: unknown, fn: unknown, options: unknown): void {
        if (typeof fn !== "function") return;
        const capture = options === true || (typeof options === "object" && options !== null && (options as { capture?: unknown }).capture === true);
        const list = listeners.get(nodeId) ?? [];
        list.push({ type: String(type), fn: fn as GuestFn, capture });
        listeners.set(nodeId, list);
      },
      removeEventListener(type: unknown, fn: unknown, options: unknown): void {
        const capture = options === true || (typeof options === "object" && options !== null && (options as { capture?: unknown }).capture === true);
        const list = listeners.get(nodeId);
        if (list === undefined) return;
        listeners.set(
          nodeId,
          list.filter((l) => !(l.type === String(type) && l.fn === fn && l.capture === capture)),
        );
      },
      dispatchEvent(event: unknown): boolean {
        return dispatch(nodeId, event as GuestEvent);
      },
      click(): void {
        const event = makeEvent("click", { bubbles: true, cancelable: true });
        // Activation behavior runs only when the click was not default-prevented.
        if (dispatch(nodeId, event)) runActivationBehavior(nodeId);
      },
      get checked(): boolean {
        const state = nodeState.get(nodeId);
        if (state?.checked !== undefined) return state.checked;
        const initial = session.dom.nodes.get(nodeId)?.attrs?.get("checked") !== undefined;
        nodeState.set(nodeId, { ...state, checked: initial });
        return initial;
      },
      set checked(value: unknown) {
        const state = nodeState.get(nodeId) ?? {};
        state.checked = Boolean(value);
        nodeState.set(nodeId, state);
      },
      // IDL-reflected `type` (input/button/ol/link…) — content attribute.
      get type(): string {
        return session.dom.nodes.get(nodeId)?.attrs?.get("type") ?? "";
      },
      set type(value: unknown) {
        session.setAttribute(nodeId, "type", coerceGuestString(value));
        mutations += 1;
      },
      // IDL-reflected boolean `switch` (input[type=checkbox] experimental).
      get switch(): boolean {
        return session.dom.nodes.get(nodeId)?.attrs?.has("switch") ?? false;
      },
      set switch(value: unknown) {
        if (value) {
          session.setAttribute(nodeId, "switch", "");
        } else {
          session.removeAttribute(nodeId, "switch");
        }
        mutations += 1;
      },
      getBoundingClientRect(): object {
        gBcrCalls += 1;
        if (geometryMode === "stub") {
          return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
        }
        return rectFromTree(resolveLayoutTree(), nodeId);
      },
      getClientRects(): object {
        gBcrCalls += 1;
        const r =
          geometryMode === "stub"
            ? { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }
            : rectFromTree(resolveLayoutTree(), nodeId);
        if (!(r.width > 0) || !(r.height > 0)) {
          return {
            length: 0,
            item: () => null,
            [Symbol.iterator]: function* () {},
          };
        }
        return {
          length: 1,
          item: (i: unknown) => (Number(i) === 0 ? r : null),
          0: r,
          [Symbol.iterator]: function* () {
            yield r;
          },
        };
      },
      get offsetWidth(): number {
        return Math.round(rectFromTree(resolveLayoutTree(), nodeId).width);
      },
      get offsetHeight(): number {
        return Math.round(rectFromTree(resolveLayoutTree(), nodeId).height);
      },
      get offsetTop(): number {
        return Math.round(rectFromTree(resolveLayoutTree(), nodeId).top);
      },
      get offsetLeft(): number {
        return Math.round(rectFromTree(resolveLayoutTree(), nodeId).left);
      },
      get offsetParent(): unknown {
        // CSSOM View: nearest ancestor with non-static position; body/html fallback.
        let current = session.dom.nodes.get(nodeId)?.parent ?? null;
        while (current !== null) {
          const n = session.dom.nodes.get(current);
          if (n === undefined || n.kind !== "element") break;
          let position: unknown = "static";
          try {
            position = session.computed(current)["position"] ?? "static";
          } catch {
            // Cascade can fail for detached/foreign nodes; treat as static.
          }
          if (position !== "static" && position !== undefined) {
            return makeElementCached(current);
          }
          if (n.tag === "body" || n.tag === "html") return makeElementCached(current);
          current = n.parent;
        }
        return null;
      },
      get clientWidth(): number {
        return Math.max(0, Math.round(rectFromTree(resolveLayoutTree(), nodeId).width));
      },
      get clientHeight(): number {
        return Math.max(0, Math.round(rectFromTree(resolveLayoutTree(), nodeId).height));
      },
      get scrollWidth(): number {
        return Math.round(rectFromTree(resolveLayoutTree(), nodeId).width);
      },
      get scrollHeight(): number {
        return Math.round(rectFromTree(resolveLayoutTree(), nodeId).height);
      },
      get scrollTop(): number {
        return scrollOffsets.get(nodeId)?.top ?? 0;
      },
      set scrollTop(v: unknown) {
        const o = scrollOffsets.get(nodeId) ?? { left: 0, top: 0 };
        o.top = Math.max(0, Number(v) || 0);
        scrollOffsets.set(nodeId, o);
      },
      get scrollLeft(): number {
        return scrollOffsets.get(nodeId)?.left ?? 0;
      },
      set scrollLeft(v: unknown) {
        const o = scrollOffsets.get(nodeId) ?? { left: 0, top: 0 };
        o.left = Math.max(0, Number(v) || 0);
        scrollOffsets.set(nodeId, o);
      },
      scrollTo(xOrOptions?: unknown, y?: unknown): void {
        const opts = typeof xOrOptions === "object" && xOrOptions !== null
          ? xOrOptions as { left?: unknown; top?: unknown }
          : { left: xOrOptions, top: y };
        const o = scrollOffsets.get(nodeId) ?? { left: 0, top: 0 };
        if (opts.top !== undefined) o.top = Math.max(0, Number(opts.top) || 0);
        if (opts.left !== undefined) o.left = Math.max(0, Number(opts.left) || 0);
        scrollOffsets.set(nodeId, o);
      },
      scroll(xOrOptions?: unknown, y?: unknown): void {
        const me = this as { scrollTo: (a?: unknown, b?: unknown) => void };
        me.scrollTo(xOrOptions, y);
      },
      scrollBy(xOrOptions?: unknown, y?: unknown): void {
        const cur = scrollOffsets.get(nodeId) ?? { left: 0, top: 0 };
        const opts = typeof xOrOptions === "object" && xOrOptions !== null
          ? xOrOptions as { left?: unknown; top?: unknown }
          : { left: xOrOptions, top: y };
        const me = this as { scrollTo: (a?: unknown, b?: unknown) => void };
        me.scrollTo(cur.left + (Number(opts.left) || 0), cur.top + (Number(opts.top) || 0));
      },
      getContext(type: unknown, _opts?: unknown): object | null {
        const tag = session.dom.nodes.get(nodeId)?.tag ?? "";
        if (tag !== "canvas") return null;
        const kind = coerceGuestString(type).toLowerCase();
        if (kind !== "2d") return null;
        let ctx = canvasContexts.get(nodeId);
        if (ctx === undefined) {
          ctx = makeCanvas2dContext(nodeId);
          canvasContexts.set(nodeId, ctx);
        }
        return ctx;
      },
      toDataURL(..._args: unknown[]): string {
        return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      },
      toBlob(callback: unknown, _type?: unknown, _quality?: unknown): void {
        if (typeof callback === "function") {
          try {
            (callback as (blob: null) => void)(null);
          } catch {
            // Guest/page code may throw here; swallowed by design.
          }
        }
      },
      get width(): number {
        const tag = session.dom.nodes.get(nodeId)?.tag ?? "";
        if (tag === "canvas" || tag === "img" || tag === "video") {
          const raw = session.dom.nodes.get(nodeId)?.attrs?.get("width");
          const n = raw !== undefined ? Number(raw) : NaN;
          if (Number.isFinite(n) && n >= 0) return n;
          return tag === "canvas" ? 300 : 0;
        }
        return Math.round(rectFromTree(resolveLayoutTree(), nodeId).width);
      },
      set width(value: unknown) {
        const tag = session.dom.nodes.get(nodeId)?.tag ?? "";
        if (tag === "canvas" || tag === "img" || tag === "video") {
          session.setAttribute(nodeId, "width", String(Number(value) || 0));
          mutations += 1;
        }
      },
      get height(): number {
        const tag = session.dom.nodes.get(nodeId)?.tag ?? "";
        if (tag === "canvas" || tag === "img" || tag === "video") {
          const raw = session.dom.nodes.get(nodeId)?.attrs?.get("height");
          const n = raw !== undefined ? Number(raw) : NaN;
          if (Number.isFinite(n) && n >= 0) return n;
          return tag === "canvas" ? 150 : 0;
        }
        return Math.round(rectFromTree(resolveLayoutTree(), nodeId).height);
      },
      set height(value: unknown) {
        const tag = session.dom.nodes.get(nodeId)?.tag ?? "";
        if (tag === "canvas" || tag === "img" || tag === "video") {
          session.setAttribute(nodeId, "height", String(Number(value) || 0));
          mutations += 1;
        }
      },
      /**
       * `element.animate(keyframes, options)` — the Web Animations API entry
       * point. Parses the keyframes/timing into a typed effect now (rejecting
       * unknown properties / unparseable values), registers it on the frame
       * clock, and returns a minimal `Animation` handle. The effect is sampled
       * each frame by {@link tickAnimations}, driven by the event loop's frame
       * scheduler — the same `requestAnimationFrame` clock real engines use.
       */
      animate(keyframes: unknown, options: unknown): object {
        const frames = Array.isArray(keyframes) ? (keyframes as RawKeyframe[]) : [];
        const effect = buildEffect(frames, options);
        const anim: ActiveAnimation = {
          nodeId,
          effect,
          startTime: null,
          finished: false,
          cancelled: false,
          prior: new Map(effect.tracks.map((t) => [t.cssName, parseInline(nodeId).get(t.cssName)])),
        };
        animations.push(anim);
        const handle = {
          cancel(): void {
            anim.cancelled = true;
          },
          finish(): void {
            anim.finished = true;
          },
          play(): void {
            anim.startTime ??= 0;
          },
          pause(): void {
            anim.paused = true;
          },
          get currentTime(): number {
            return anim.startTime ?? 0;
          },
          get playbackRate(): number {
            return 1;
          },
          get playState(): string {
            return anim.cancelled ? "idle" : anim.finished ? "finished" : anim.startTime === null ? "pending" : "running";
          },
          get effect(): AnimationEffect {
            return anim.effect;
          },
        };
        anim.handle = handle;
        return handle;
      },
      /** `getAnimations()` — this element's live animation handles (Web
       *  Animations §Animatable). */
      getAnimations(): object[] {
        return animations
          .filter((a) => a.nodeId === nodeId && !a.cancelled && !a.finished)
          .map((a) => a.handle as object);
      },
      /** `focus()` — make this element the document's active element and
       *  dispatch focus/focusin (UI Events §focus). */
      focus(): void {
        if (focusedNodeId === nodeId) return;
        const prev = focusedNodeId;
        focusedNodeId = nodeId;
        if (prev !== null) {
          dispatch(prev, makeEvent("blur"));
          dispatch(prev, makeEvent("focusout"));
        }
        dispatch(nodeId, makeEvent("focus"));
        dispatch(nodeId, makeEvent("focusin"));
      },
      /** `blur()` — move focus back to nothing (→ body per activeElement). */
      blur(): void {
        if (focusedNodeId !== nodeId) return;
        focusedNodeId = null;
        dispatch(nodeId, makeEvent("blur"));
        dispatch(nodeId, makeEvent("focusout"));
      },
    };
    idOf.set(wrapper, nodeId);
    return wrapper;
  };

  interface StyleDeclarationObject {
    readonly length: number;
    item(index: unknown): string;
    getPropertyValue(prop: unknown): string;
    getPropertyPriority(prop: unknown): string;
    setProperty(prop: unknown, value?: unknown, priority?: unknown): void;
    removeProperty(prop: unknown): string;
    cssText: string;
    _rawDeclValue(prop: unknown): string | undefined;
    [Symbol.iterator](): IterableIterator<string>;
  }

  const makeStyleDeclarationCached = (nodeId: NodeId): object => {
    const cached = styleWrappers.get(nodeId);
    if (cached !== undefined) return cached;
    const created = makeStyleDeclaration(nodeId);
    styleWrappers.set(nodeId, created);
    return created;
  };

  /**
   * A CSSStyleDeclaration over a get/set text pair — the same declaration-block
   * machinery serves an element's inline `style` attribute and a style rule's
   * `{ … }` body (CSSStyleRule.style / .styleMap).
   */
  const makeDeclarationBacked = (getText: () => string, setText: (text: string) => void): object => {
    // Escape-aware declaration split: `;` and `:` inside strings, parens, or
    // `\` escapes do not delimit (e.g. `--a\;b` / `content: "a;b"`).
    const splitDeclarations = (text: string): string[] => {
      const out: string[] = [];
      let start = 0;
      let depth = 0;
      let quote = "";
      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i] as string;
        if (quote !== "") {
          if (ch === "\\") i += 1;
          else if (ch === quote) quote = "";
          continue;
        }
        if (ch === "\\") {
          i += 1;
          continue;
        }
        if (ch === '"' || ch === "'") {
          quote = ch;
          continue;
        }
        if (ch === "(") depth += 1;
        else if (ch === ")") depth -= 1;
        else if (ch === ";" && depth === 0) {
          out.push(text.slice(start, i));
          start = i + 1;
        }
      }
      out.push(text.slice(start));
      return out;
    };
    const declColon = (decl: string): number => {
      let depth = 0;
      let quote = "";
      for (let i = 0; i < decl.length; i += 1) {
        const ch = decl[i] as string;
        if (quote !== "") {
          if (ch === "\\") i += 1;
          else if (ch === quote) quote = "";
          continue;
        }
        if (ch === "\\") {
          i += 1;
          continue;
        }
        if (ch === '"' || ch === "'") {
          quote = ch;
          continue;
        }
        if (ch === "(") depth += 1;
        else if (ch === ")") depth -= 1;
        else if (ch === ":" && depth === 0) return i;
      }
      return -1;
    };
    // `\xx` escape decode for identifiers (custom property names).
    const unescapeIdent = (name: string): string =>
      name.replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/g, (_m, hex: string | undefined, ch: string | undefined) =>
        hex !== undefined ? String.fromCodePoint(parseInt(hex, 16)) : (ch ?? ""));
    /** Relative `url()` inner → absolute, resolved against the CURRENT
     *  document base URL (frozen into the stored declaration text). */
    const declUrl = (inner: string): string | null => resolveUrl(inner, session.baseUrl);
    const parseText = (source: string): Map<string, StyleDeclarationEntry> => {
      rawOverrides.clear();
      const map = new Map<string, StyleDeclarationEntry>();
      for (const decl of splitDeclarations(source)) {
        const idx = declColon(decl);
        if (idx <= 0) continue;
        let name = decl.slice(0, idx).trim();
        if (name.startsWith("--") && name.includes("\\")) name = unescapeIdent(name);
        let value = decl.slice(idx + 1).trim();
        let priority: StylePriority = "";
        const important = /!\s*important\s*$/i.exec(value);
        if (important !== null) {
          priority = "important";
          value = value.slice(0, important.index).trim();
        }
        if (name === "" || value === "") continue;
        // `all` is the universal shorthand: a CSS-wide keyword applies to every
        // longhand (except direction/unicode-bidi/custom properties, per spec).
        if (name === "all") {
          const wide = value.toLowerCase();
          if (!CSS_WIDE_VALUE_SET.has(wide)) continue;
          for (const p of allLonghandNames()) applyDecl(map, p, wide, priority);
          continue;
        }
        // Invalid declarations drop out (CSS error recovery): a later invalid
        // declaration leaves the earlier valid one standing, so SKIP rather
        // than clear. Custom properties and var()-bearing values accept any
        // token stream.
        const passthrough = name.startsWith("--") || /\b(?:var|env)\(/.test(value);
        if (
          !passthrough &&
          !expandShorthand(name, value) &&
          !isDeclarationValueValid(name, value)
        ) {
          continue;
        }
        // Valid declarations store the CSSOM-canonical serialization
        // (`5% .5%` → `5% 0.5%`); var()/custom-prop values stay verbatim.
        // Shorthands expand to their longhands at this point: the stored
        // declaration set is always longhand-shaped (CSSOM "declared
        // declarations"), and shorthands are re-synthesized at serialization.
        const wide = value.toLowerCase();
        const covered = isShorthandName(name) ? coveredLonghands(name) : null;
        if (covered !== null) {
          // CSS-wide keywords AND var()/env()-carrying values on a shorthand
          // set every covered longhand verbatim (pending-substitution
          // semantics — the var reference resolves at computed-value time).
          const spread = !passthrough && CSS_WIDE_VALUE_SET.has(wide)
            ? wide
            : /\b(?:var|env)\(/.test(value)
              ? value
              : null;
          if (spread !== null) {
            const pending = /\b(?:var|env)\(/.test(spread);
            for (const p of covered) {
              applyDecl(map, p, spread, priority, pending);
              if (pending) rawOverrides.set(p, spread);
              else rawOverrides.delete(p);
            }
            continue;
          }
        }
        const expanded = passthrough ? null : expandShorthand(name, value);
        if (expanded !== null) {
          for (const e of expanded) {
            // Expansion entries with an empty value remove the longhand
            // (e.g. `font: menu` resets the font-variant longhands).
            if (e.value === "") map.delete(e.property);
            else {
              const canon = canonicalDeclValue(e.property, e.value, declUrl);
              applyDecl(map, e.property, canon, priority);
              if (canon !== e.value && /url\(/i.test(e.value)) rawOverrides.set(e.property, e.value);
            }
          }
        } else {
          const canon = passthrough ? value : canonicalDeclValue(name, value, declUrl);
          applyDecl(map, name, canon, priority);
          // url() is frozen-absolute in the canonical value — keep the authored
          // text for the Typed OM declared-value views (verbatim channel).
          if (!passthrough && canon !== value && /url\(/i.test(value)) rawOverrides.set(name, value);
        }
      }
      return map;
    };
    const parse = (): Map<string, StyleDeclarationEntry> => {
      const src = getText();
      if (parsedCache !== null && parsedCache.src === src) return parsedCache.map;
      const map = parseText(src);
      parsedCache = { src, map };
      return map;
    };
    // Values containing var()/env() references are stored verbatim for the
    // Typed OM views (whitespace is significant inside CSSUnparsedValue);
    // the CSSOM getters still return the normalized form.
    const rawOverrides = new Map<string, string>();
    const serialize = (map: Map<string, StyleDeclarationEntry>): string =>
      serializeDeclarations(map);
    // The declaration list is a LIVE structure (Blink keeps the parsed
    // declarations, not the source text): memoize by source text so mutation
    // ordering survives commits that serialize shorthands folded.
    let parsedCache: { src: string; map: Map<string, StyleDeclarationEntry> } | null = null;
    const commit = (map: Map<string, StyleDeclarationEntry>): void => {
      const serialized = serialize(map);
      setText(serialized);
      parsedCache = { src: serialized, map };
    };
    const declaredAliases = (map: Map<string, StyleDeclarationEntry>): string[] => {
      const keys: string[] = [];
      const seen = new Set<string>();
      const add = (key: string): void => {
        if (!seen.has(key)) {
          keys.push(key);
          seen.add(key);
        }
      };
      for (const name of map.keys()) {
        for (const [alias, cssName] of CSSOM_PROPERTY_ALIAS_TO_NAME) {
          if (cssName === name) add(alias);
        }
      }
      return keys;
    };
    const styleDeclaration: StyleDeclarationObject = {
      get length(): number {
        return parse().size;
      },
      item(index: unknown): string {
        const n = Number(index);
        if (!Number.isInteger(n) || n < 0) return "";
        return [...parse().keys()][n] ?? "";
      },
      getPropertyValue(prop: unknown): string {
        const map = parse();
        const name = String(prop);
        const direct = map.get(name);
        if (direct !== undefined) return direct.pending === true ? "" : direct.value;
        // Shorthand read: synthesize from its longhands when the whole group is
        // declared with one priority and the value is shorthand-representable.
        return synthesizeShorthand(map, name)?.value ?? "";
      },
      getPropertyPriority(prop: unknown): string {
        const map = parse();
        const name = String(prop);
        return map.get(name)?.priority ?? synthesizeShorthand(map, name)?.priority ?? "";
      },
      setProperty(prop: unknown, value?: unknown, priority?: unknown): void {
        const map = parse();
        const before = serialize(map);
        const name = String(prop);
        const text = value === undefined ? "" : cssomString(value);
        const priorityText = priority === undefined ? "" : cssomString(priority);
        if (priorityText !== "" && priorityText.toLowerCase() !== "important") return;
        const prio: StylePriority = priorityText === "" ? "" : "important";
        if (text === "" || name === "all") {
          if (text !== "") {
            const wide = text.trim().toLowerCase();
            if (CSS_WIDE_VALUE_SET.has(wide)) {
              for (const p of allLonghandNames()) applyDecl(map, p, wide, prio);
            }
          } else if (name === "all") {
            for (const p of allLonghandNames()) map.delete(p);
          } else {
            map.delete(name);
            if (isShorthandName(name)) {
              for (const rule of SHORTHAND_FOLD_RULES) {
                if (rule.name === name) for (const l of rule.longhands) map.delete(l);
              }
            }
          }
          if (serialize(map) !== before) commit(map);
          return;
        }
        const passthrough = name.startsWith("--") || /\b(?:var|env)\(/.test(text);
        // CSSOM setProperty ignores invalid values — the previous valid
        // declaration must stand (it is not replaced by the bad text).
        const wide = text.trim().toLowerCase();
        const covered = isShorthandName(name) ? coveredLonghands(name) : null;
        const spread = covered !== null
          ? (!passthrough && CSS_WIDE_VALUE_SET.has(wide) ? wide
            : /\b(?:var|env)\(/.test(text) ? text : null)
          : null;
        const expanded = passthrough || spread !== null ? null : expandShorthand(name, text);
        if (!passthrough && spread === null && expanded === null && !isDeclarationValueValid(name, text)) {
          return;
        }
        if (spread !== null) {
          const pending = /\b(?:var|env)\(/.test(spread);
          for (const p of covered!) {
            applyDecl(map, p, spread, prio, pending);
            if (pending) rawOverrides.set(p, spread);
            else rawOverrides.delete(p);
          }
        } else if (expanded !== null) {
          for (const e of expanded) {
            if (e.value === "") {
              map.delete(e.property);
              rawOverrides.delete(e.property);
              continue;
            }
            const canon = canonicalDeclValue(e.property, e.value, declUrl);
            applyDecl(map, e.property, canon, prio);
            if (canon !== e.value && /url\(/i.test(e.value)) rawOverrides.set(e.property, e.value);
            else rawOverrides.delete(e.property);
          }
        } else {
          const canon = passthrough ? text : canonicalDeclValue(name, text, declUrl);
          applyDecl(map, name, canon, prio);
          if (passthrough || (canon !== text && /url\(/i.test(text))) rawOverrides.set(name, text);
          else rawOverrides.delete(name);
        }
        // No-op writes must not rewrite the attribute (MutationObserver would
        // record a spurious style mutation otherwise).
        if (serialize(map) !== before) commit(map);
      },
      removeProperty(prop: unknown): string {
        const map = parse();
        const before = serialize(map);
        const name = String(prop);
        const oldValue = map.get(name)?.value ?? synthesizeShorthand(map, name)?.value ?? "";
        if (name === "all") {
          for (const p of allLonghandNames()) map.delete(p);
        } else if (map.delete(name) === false && isShorthandName(name)) {
          for (const rule of SHORTHAND_FOLD_RULES) {
            if (rule.name === name) for (const l of rule.longhands) map.delete(l);
          }
        }
        rawOverrides.delete(name);
        if (serialize(map) !== before) commit(map);
        return oldValue;
      },
      /** Typed OM seam: the verbatim (untrimmed) value stored by set(). */
      _rawDeclValue(prop: unknown): string | undefined {
        return rawOverrides.get(String(prop));
      },
      // CSSStyleDeclaration is iterable over its declared property names.
      [Symbol.iterator](): IterableIterator<string> {
        return [...parse().keys()][Symbol.iterator]();
      },
      get cssText(): string {
        return serialize(parse());
      },
      set cssText(value: unknown) {
        rawOverrides.clear();
        // cssText stores the CANONICAL serialization of the parsed input —
        // invalid declarations drop out of the attribute (`"z: 1; bad"` →
        // the attribute reads `"z-index: 1;"`-style canonical text).
        commit(parseText(coerceGuestString(value)));
      },
    };
    const ownKeys = (target: StyleDeclarationObject): Array<string | symbol> => {
      const map = parse();
      const keys: Array<string | symbol> = [];
      const seen = new Set<string | symbol>();
      const add = (key: string | symbol): void => {
        if (!seen.has(key)) {
          keys.push(key);
          seen.add(key);
        }
      };
      for (let i = 0; i < map.size; i += 1) add(String(i));
      for (const alias of declaredAliases(map)) add(alias);
      for (const key of Reflect.ownKeys(target)) add(key);
      return keys;
    };
    const namedDescriptor = (prop: string): PropertyDescriptor | undefined => {
      if (isCssomArrayIndex(prop)) {
        const value = styleDeclaration.item(Number(prop));
        return value === "" ? undefined : { value, writable: false, enumerable: true, configurable: true };
      }
      const cssName = CSSOM_PROPERTY_ALIAS_TO_NAME.get(prop);
      if (cssName === undefined) return undefined;
      const value = parse().get(cssName)?.value;
      return value === undefined ? undefined : { value, writable: true, enumerable: true, configurable: true };
    };
    return new Proxy(styleDeclaration, {
      get(target, prop, receiver): unknown {
        if (typeof prop === "string" && isCssomArrayIndex(prop)) {
          return target.item(Number(prop));
        }
        const cssName = typeof prop === "string" ? CSSOM_PROPERTY_ALIAS_TO_NAME.get(prop) : undefined;
        if (cssName !== undefined) return target.getPropertyValue(cssName);
        return Reflect.get(target, prop, receiver);
      },
      set(target, prop, value): boolean {
        const cssName = typeof prop === "string" ? CSSOM_PROPERTY_ALIAS_TO_NAME.get(prop) : undefined;
        if (cssName !== undefined) {
          target.setProperty(cssName, value);
          return true;
        }
        return Reflect.set(target, prop, value);
      },
      has(target, prop): boolean {
        // Array indices present (so Array.prototype.indexOf/includes see
        // them — `indexOf` does HasProperty before Get).
        if (typeof prop === "string" && isCssomArrayIndex(prop)) {
          return target.item(Number(prop)) !== "";
        }
        return (typeof prop === "string" && CSSOM_PROPERTY_ALIAS_TO_NAME.has(prop)) || Reflect.has(target, prop);
      },
      ownKeys,
      getOwnPropertyDescriptor(target, prop): PropertyDescriptor | undefined {
        if (typeof prop === "string") {
          const descriptor = namedDescriptor(prop);
          if (descriptor !== undefined) return descriptor;
        }
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
    });
  };

  const makeStyleDeclaration = (nodeId: NodeId): object =>
    makeDeclarationBacked(
      () => session.dom.nodes.get(nodeId)?.attrs?.get("style") ?? "",
      (text) => {
        session.setAttribute(nodeId, "style", text);
        mutations += 1;
      },
    );

  /** Typed OM backing over a CSSStyleDeclaration — shared by the inline
   * `attributeStyleMap` and the declared `CSSStyleRule.styleMap`. */
  const styleMapBackingForDecl = (decl: StyleDeclarationObject): StyleMapBacking => ({
    entries: () => {
      const out: Array<[string, string]> = [];
      for (let i = 0; i < decl.length; i += 1) {
        const name = decl.item(i);
        if (name !== "") out.push([name, decl.getPropertyValue(name)]);
      }
      return out;
    },
    get: (prop) => {
      const v = decl.getPropertyValue(prop);
      if (v === "") return null;
      return decl._rawDeclValue(prop) ?? v;
    },
    set: (prop, text) => {
      decl.setProperty(prop, text);
    },
    remove: (prop) => decl.removeProperty(prop),
  });

  /** Typed OM `attributeStyleMap` — [SameObject]: the map is cached on the
   * (already per-node cached) declaration object. */
  const attributeStyleMapForNode = (id: NodeId): object => {
    const decl = makeStyleDeclarationCached(id) as StyleDeclarationObject & {
      _typedMap?: object;
    };
    if (decl._typedMap === undefined) {
      decl._typedMap = makeStylePropertyMap(styleMapBackingForDecl(decl));
    }
    return decl._typedMap;
  };

  /** Typed OM `computedStyleMap()` — [SameObject] per element. */
  const computedStyleMapCache = new Map<NodeId, object>();
  const computedStyleMapForNode = (id: NodeId): object => {
    const cached = computedStyleMapCache.get(id);
    if (cached !== undefined) return cached;
    const gcs = getComputedStyle(makeElementCached(id)) as {
      length: number;
      item(i: number): string;
      getPropertyValue(name: string, resolved?: boolean): string;
    };
    const backing: StyleMapBacking = {
      entries: () => {
        const out: Array<[string, string]> = [];
        for (let i = 0; i < gcs.length; i += 1) {
          const name = gcs.item(i);
          const v = gcs.getPropertyValue(name, false);
          if (name !== "" && v !== "") out.push([name, v]);
        }
        // Computed StylePropertyMap order: standard properties sorted
        // code-unit-ascending with non-dashed names first, then custom
        // properties in code-unit order (WPT iterable.tentative).
        const cmp = (a: string, b: string): number =>
          a.startsWith("-") === b.startsWith("-") ? (a < b ? -1 : a > b ? 1 : 0)
            : a.startsWith("-") ? 1 : -1;
        const standard = out.filter(([n]) => !n.startsWith("--")).sort((x, y) => cmp(x[0], y[0]));
        const customs = out.filter(([n]) => n.startsWith("--")).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
        return [...standard, ...customs];
      },
      get: (prop) => {
        const v = gcs.getPropertyValue(prop, false);
        return v === "" ? null : v;
      },
      set: () => {
        throw new Error("computedStyleMap is read-only");
      },
      remove: () => {
        throw new Error("computedStyleMap is read-only");
      },
      computed: true,
    };
    const map = makeStylePropertyMapReadOnly(backing);
    computedStyleMapCache.set(id, map);
    return map;
  };

  /**
   * CSSStyleSheet for a style/link element (CSSOM §6): ownerNode + a live
   * cssRules list initialized from the element's style text, insertRule/
   * deleteRule that both update the rule list AND rewrite the element's text
   * content — the session's stylesheet pipeline re-parses the DOM on
   * re-render, so rewritten text is what actually drives the cascade.
   * Emotion/styled-components-like libraries depend on exactly this surface
   * (`sheet.ownerNode`, `sheet.cssRules`, `sheet.insertRule`) for their
   * speed/nonce paths.
   */
  const styleSheetCache = new Map<NodeId, object>();
  /** Split `selector { body }` into its parts (undefined for @-rules). */
  const splitRule = (cssText: string): { selector: string; body: string } | undefined => {
    const open = cssText.indexOf("{");
    const close = cssText.lastIndexOf("}");
    if (open < 0 || close < open) return undefined;
    const prelude = cssText.slice(0, open).trim();
    if (prelude.startsWith("@")) return undefined;
    return { selector: prelude, body: cssText.slice(open + 1, close) };
  };

  interface StyleRuleEntry {
    cssText: string;
    ruleObject?: object;
  }
  /**
   * CSSOM rule list machinery shared by element-backed sheets and detached
   * (constructed) CSSStyleSheets: a lazily-parsed top-level rule list, a LIVE
   * cssRules proxy (evaluated per access — `sheet.cssRules[sheet.insertRule(x)]`
   * reads the list BEFORE insertRule runs), and insertRule/deleteRule that
   * write back through `setText` (element text rewrite, or the detached
   * sheet's own text store).
   */
  // At-rule type numbers (CSSOM §5.1) for rules that get typed objects.
  const AT_RULE_TYPES: Record<string, number> = {
    charset: 2, media: 4, "font-face": 5, page: 6,
    keyframes: 7, "-webkit-keyframes": 7, "-moz-keyframes": 7, "-o-keyframes": 7,
    namespace: 10, "counter-style": 11, supports: 12,
    "font-feature-values": 14, viewport: 15,
  };

  interface ImportPrelude {
    href: string;
    layerRaw: string | null;
    layerName: string | null;
    supports: string | null;
    mediaText: string;
  }
  // Parse `@import <url|string> [layer|layer(name)] [supports(<cond>)] [<media>]`.
  const parseImportRule = (cssText: string): ImportPrelude | undefined => {
    let s = cssText.trim().replace(/^@import\b/i, "").trim();
    if (/;$/.test(s)) s = s.slice(0, s.lastIndexOf(";")).trimEnd();
    let href: string;
    const urlM = /^url\(\s*/i.exec(s);
    if (urlM !== null) {
      s = s.slice(urlM[0].length);
      if (s.startsWith('"') || s.startsWith("'")) {
        const q = s[0] as string;
        const end = s.indexOf(q, 1);
        if (end < 0) return undefined;
        href = s.slice(1, end);
        s = s.slice(end + 1);
        if (!/^\s*\)/.test(s)) return undefined;
        s = s.replace(/^\s*\)/, "");
      } else {
        const end = s.indexOf(")");
        if (end < 0) return undefined;
        href = s.slice(0, end).trim();
        s = s.slice(end + 1);
      }
    } else if (s.startsWith('"') || s.startsWith("'")) {
      const q = s[0] as string;
      const end = s.indexOf(q, 1);
      if (end < 0) return undefined;
      href = s.slice(1, end);
      s = s.slice(end + 1);
    } else {
      return undefined;
    }
    s = s.trimStart();
    let layerRaw: string | null = null;
    let layerName: string | null = null;
    const layerM = /^layer(\(\s*[^)]*?\s*\))?(?=[\s;]|$)/i.exec(s);
    if (layerM !== null) {
      layerRaw = layerM[0];
      const inner = /^layer\(\s*([^)]*?)\s*\)$/i.exec(layerM[0]);
      layerName = inner !== null ? (inner[1] ?? "") : "";
      s = s.slice(layerM[0].length).trimStart();
    }
    let supports: string | null = null;
    const supM = /^supports\(/i.exec(s);
    if (supM !== null) {
      let depth = 0;
      let end = -1;
      for (let i = supM[0].length - 1; i < s.length; i += 1) {
        const ch = s[i];
        if (ch === "(") depth += 1;
        else if (ch === ")") {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end < 0) return undefined;
      supports = s.slice(supM[0].length, end).trim();
      s = s.slice(end + 1).trimStart();
    }
    return { href, layerRaw, layerName, supports, mediaText: s.trim() };
  };
  const serializeImportRule = (p: ImportPrelude): string =>
    `@import url("${p.href.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}")` +
    (p.layerRaw !== null ? ` ${p.layerRaw}` : "") +
    (p.supports !== null ? ` supports(${p.supports})` : "") +
    (p.mediaText !== "" ? ` ${p.mediaText}` : "") +
    ";";

  // `@namespace [prefix] <url|string>` → {prefix, uri}.
  const parseNamespaceRule = (cssText: string): { prefix: string | null; uri: string } | undefined => {
    let s = cssText.trim().replace(/^@namespace\b/i, "").trim();
    if (/;$/.test(s)) s = s.slice(0, s.lastIndexOf(";")).trimEnd();
    let prefix: string | null = null;
    const preM = /^([a-zA-Z_][\w-]*)\s+/.exec(s);
    if (preM !== null && !/^url\(/i.test(s)) {
      prefix = preM[1] ?? null;
      s = s.slice(preM[0].length);
    }
    const urlM = /^url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/i.exec(s);
    if (urlM !== null) {
      return { prefix, uri: urlM[1] ?? urlM[2] ?? (urlM[3] ?? "").trim() };
    }
    const strM = /^(?:"([^"]*)"|'([^']*)')/.exec(s);
    if (strM !== null) {
      return { prefix, uri: strM[1] ?? strM[2] ?? "" };
    }
    return undefined;
  };

  // Keyframe selectors serialize canonical: from→0%, to→100%.
  const normalizeKeyText = (sel: string): string =>
    sel.split(",").map((k) => {
      const t = k.trim().toLowerCase();
      if (t === "from") return "0%";
      if (t === "to") return "100%";
      return t;
    }).join(", ");

  // Media query serialization normalization (CSSOM §serialize-a-media-query):
  // lowercase the type and feature names, collapse whitespace, and drop a
  // leading `all and` (but not `not all`/`only all`).
  const normalizeMediaQuery = (q: string): string => {
    let s = q.trim().replace(/\s+/g, " ");
    s = s.replace(/^all\s+and\s+/i, "");
    const typeM = /^((?:not|only)\s+)?([a-zA-Z-]+)/i.exec(s);
    if (typeM !== null) {
      s = (typeM[1] ?? "") + (typeM[2] ?? "").toLowerCase() + s.slice(typeM[0].length);
    }
    return s.replace(/\(\s*([a-zA-Z-]+)/g, (_m, name: string) => `(${name.toLowerCase()}`);
  };
  const normalizeMediaQueryList = (text: string): string =>
    text.split(",").map((q) => normalizeMediaQuery(q)).join(", ");

  interface NsContext {
    def: string | null;
    map: Map<string, string>;
  }
  // Canonical An+B for :nth-*() (CSSOM serialize-an-an+b-value).
  const NTH_PSEUDOS = new Set([
    "nth-child", "nth-last-child", "nth-of-type", "nth-last-of-type",
    "nth-col", "nth-last-col",
  ]);
  const serializeAnPlusB = (raw: string): string | undefined => {
    const s = raw.trim().toLowerCase().replace(/\s+/g, " ");
    if (s === "even") return "2n";
    if (s === "odd") return "2n+1";
    let m = /^([+-]?)(\d*)n(?:\s*([+-])\s*(\d+))?$/.exec(s);
    if (m !== null) {
      const sign = m[1] === "-" ? "-" : "";
      const a = m[2] ?? "";
      const aPart = a === "" || a === "1" ? `${sign}n` : `${sign}${a}n`;
      const b = m[4];
      if (b === undefined || b === "0") return aPart;
      return `${aPart}${m[3]}${b}`;
    }
    m = /^([+-]?)(\d+)$/.exec(s);
    if (m !== null) return `${m[1] === "-" ? "-" : ""}${m[2]}`;
    return undefined;
  };
  // Serialize a selector per CSSOM: collapse whitespace, canonicalize
  // functional-pseudo arguments, and elide namespace prefixes that resolve to
  // the sheet's default @namespace (or `*|` when no default is declared).
  const serializeSelectorText = (raw: string, ns: NsContext | undefined): string => {
    const s = raw;
    let out = "";
    let i = 0;
    let compoundStart = true;
    const skipWs = (j: number): number => {
      while (j < s.length && /\s/.test(s[j] as string)) j += 1;
      return j;
    };
    while (i < s.length) {
      const c = s[i] as string;
      if (/\s/.test(c)) {
        const j = skipWs(i);
        const next = s[j] ?? "";
        if (next === "") {
          i = j;
        } else if (next === ">" || next === "+" || next === "~") {
          if (!out.endsWith(" ")) out += " ";
          out += `${next} `;
          i = j + 1;
          compoundStart = true;
        } else if (next === ",") {
          if (out.endsWith(" ")) out = out.slice(0, -1);
          out += ", ";
          i = j + 1;
          compoundStart = true;
        } else {
          if (!out.endsWith(" ")) out += " ";
          i = j;
          compoundStart = true;
        }
        continue;
      }
      if (c === ">" || c === "+" || c === "~") {
        if (!out.endsWith(" ")) out += " ";
        out += `${c} `;
        i += 1;
        compoundStart = true;
        continue;
      }
      if (c === ",") {
        if (out.endsWith(" ")) out = out.slice(0, -1);
        out += ", ";
        i += 1;
        compoundStart = true;
        continue;
      }
      if (c === "[") {
        // Attribute selector: copy to `]`, collapsing whitespace but keeping
        // the whitespace that terminates a \xx escape.
        let j = i + 1;
        let inner = "";
        while (j < s.length && s[j] !== "]") {
          if (s[j] === "\\") {
            let k = j + 1;
            let esc = "\\";
            while (k < s.length && k < j + 7 && /[0-9a-fA-F]/.test(s[k] as string)) {
              esc += s[k];
              k += 1;
            }
            if (k === j + 1 && k < s.length) {
              esc += s[k];
              k += 1;
            } else if (k < s.length && s[k] !== "]") {
              // Hex escapes serialize with a trailing space terminator.
              esc += " ";
              if (/\s/.test(s[k] as string)) k = skipWs(k);
            }
            inner += esc;
            j = k;
            continue;
          }
          if (/\s/.test(s[j] as string)) {
            const k = skipWs(j);
            if (s[k] === "]") {
              j = k;
              break;
            }
            inner += " ";
            j = k;
            continue;
          }
          inner += s[j];
          j += 1;
        }
        out += `[${inner}${s[j] === "]" ? "]" : ""}`;
        i = j + 1;
        compoundStart = false;
        continue;
      }
      if (c === ":") {
        const m = /^::?([a-zA-Z-]+)/.exec(s.slice(i));
        if (m !== null) {
          const marker = m[0] ?? "";
          const name = (m[1] ?? "").toLowerCase();
          const colonLen = marker.startsWith("::") ? 2 : 1;
          const head = `${s.slice(i, i + colonLen)}${name}`;
          const j = i + marker.length;
          if (s[j] === "(") {
            // Functional pseudo: balance-scan to the matching `)`.
            let depth = 1;
            let k = j + 1;
            while (k < s.length && depth > 0) {
              if (s[k] === "(") depth += 1;
              else if (s[k] === ")") depth -= 1;
              k += 1;
            }
            const arg = s.slice(j + 1, k - 1);
            const canon = NTH_PSEUDOS.has(name) ? serializeAnPlusB(arg) : undefined;
            out += `${head}(${canon ?? serializeSelectorText(arg.trim(), ns)})`;
            i = k;
          } else {
            out += head;
            i = j;
          }
          compoundStart = false;
          continue;
        }
      }
      // Namespace prefix at the start of a compound selector.
      if (compoundStart) {
        const m = /^([a-zA-Z_][\w-]*|\*)?\|(?![|=])([a-zA-Z_*]|\\)?/.exec(s.slice(i));
        if (m !== null && (m[1] !== undefined || m[2] !== undefined)) {
          const prefix = m[1];
          let kept = "";
          if (ns === undefined) {
            kept = prefix !== undefined ? `${prefix}|` : "|";
          } else if (prefix === undefined) {
            kept = "|";
          } else if (prefix === "*") {
            kept = ns.def !== null ? "*|" : "";
          } else if (ns.map.get(prefix) !== ns.def || ns.def === null) {
            kept = `${prefix}|`;
          }
          out += kept;
          i += (m[0] ?? "").length - (m[2] ?? "").length;
          // A bare universal selector is omitted when it is not the only
          // component and carried no (or an elided) namespace prefix.
          if (kept === "" && s[i] === "*" && s[i + 1] !== undefined && ".#:[".includes(s[i + 1] as string)) {
            i += 1;
          }
          compoundStart = false;
          continue;
        }
        if (s[i] === "*" && s[i + 1] !== undefined && ".#:[".includes(s[i + 1] as string)) {
          // `*.c` → `.c` (universal selector omitted, no namespace prefix).
          i += 1;
          compoundStart = false;
          continue;
        }
      }
      out += c;
      i += 1;
      if (c !== "(" && c !== ")") compoundStart = false;
    }
    return out.trim();
  };

  const makeRuleHost = (
    getText: () => string,
    setText: (text: string) => void,
    getSheet: () => object,
    options: { readonly disallowImport?: boolean; readonly keyframes?: boolean; readonly grouping?: boolean } = {},
  ): { readonly cssRules: object; insertRule(cssText: unknown, index?: unknown): number; deleteRule(index: unknown): void } => {
    const disallowImport = options.disallowImport === true;
    let rules: StyleRuleEntry[] = [];
    let rulesFromText = "";
    const ensureRulesParsed = (): void => {
      const text = getText();
      if (text === rulesFromText) return;
      rulesFromText = text;
      rules = [];
      // Top-level rule splitter: handles @media blocks by brace depth and
      // braceless at-rules (@import/@namespace) by top-level semicolons.
      let depth = 0;
      let start = 0;
      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === "{") depth += 1;
        else if (ch === "}") {
          depth -= 1;
          if (depth === 0) {
            rules.push({ cssText: text.slice(start, i + 1).trim() });
            // skip trailing semicolon/whitespace to the next rule start
            let j = i + 1;
            while (j < text.length && /\s/.test(text[j] as string)) j += 1;
            if (text[j] === ";") j += 1;
            while (j < text.length && /\s/.test(text[j] as string)) j += 1;
            start = j;
            i = j - 1;
          }
        } else if (ch === ";" && depth === 0 && /^\s*@/.test(text.slice(start, i))) {
          rules.push({ cssText: text.slice(start, i + 1).trim() });
          start = i + 1;
        }
      }
      const tail = text.slice(start).trim();
      if (tail !== "") rules.push({ cssText: tail });
      // Constructed sheets drop @import rules at parse time (CSSOM §6.4.1).
      if (disallowImport) rules = rules.filter((r) => !/^@import\b/i.test(r.cssText));
    };
    const rebuildText = (): void => {
      setText(rules.map((r) => r.cssText).join("\n"));
      rulesFromText = rules.map((r) => r.cssText).join("\n");
    };
    const makeRuleObject = (entry: StyleRuleEntry): object => {
      if (entry.ruleObject !== undefined) return entry.ruleObject;
      const parts = splitRule(entry.cssText);
      const atName = (/^@([a-zA-Z-]+)/.exec(entry.cssText.trimStart())?.[1] ?? "").toLowerCase();
      const finish = (
        type: number,
        proto: object,
        slots: Record<string, unknown> = {},
      ): Record<string, unknown> => {
        const rule: Record<string, unknown> = {
          _entry: entry, _sheet: getSheet(), _type: type, ...slots,
        };
        Object.setPrototypeOf(rule, proto);
        entry.ruleObject = rule;
        return rule;
      };

      // Braceless at-rules.
      if (atName === "import") {
        const parsed = parseImportRule(entry.cssText);
        if (parsed !== undefined) {
          const slots: ImportPrelude & { media: Record<string, unknown>; sheet: object | null } = {
            ...parsed,
            media: {},
            sheet: null,
          };
          const reserialize = (): void => {
            entry.cssText = serializeImportRule(slots);
            rebuildText();
          };
          slots.media = makeMediaList(slots.mediaText, () => {
            slots.mediaText = slots.media["mediaText"] as string;
            reserialize();
          });
          // The imported sheet: a detached CSSStyleSheet (we don't fetch the
          // referenced resource — the cascade sees an empty sheet).
          slots.sheet = makeDetachedSheet("");
          entry.cssText = serializeImportRule(slots);
          return finish(3, CSSImportRuleCtor.prototype as object, { _import: slots });
        }
        return finish(3, CSSRuleCtor.prototype as object);
      }
      if (atName === "namespace") {
        const ns = parseNamespaceRule(entry.cssText);
        return finish(10, CSSNamespaceRuleCtor.prototype as object, {
          _namespace: ns ?? { prefix: null, uri: "" },
        });
      }
      // splitRule rejects @-preludes; at-rules need a raw brace split with the
      // `@name` stripped from the prelude.
      const atRuleBody = (cssText: string): string => {
        const open = cssText.indexOf("{");
        const close = cssText.lastIndexOf("}");
        return open >= 0 && close > open ? cssText.slice(open + 1, close) : "";
      };
      const atParts = (() => {
        if (atName === "") return undefined;
        const open = entry.cssText.indexOf("{");
        const close = entry.cssText.lastIndexOf("}");
        if (open < 0 || close < open) return undefined;
        const raw = entry.cssText.slice(0, open).trim().replace(/^@[a-zA-Z-]+\s*/, "");
        return { prelude: raw, body: entry.cssText.slice(open + 1, close) };
      })();
      if (atParts === undefined) {
        if (parts === undefined || atName !== "") {
          return finish(AT_RULE_TYPES[atName] ?? 0, CSSRuleCtor.prototype as object);
        }
      }

      // Grouping rules: @media/@supports/@keyframes hold an inner rule list
      // hosted on the braced body.
      if ((atName === "media" || atName === "supports") && atParts !== undefined) {
        const rule = finish(
          atName === "media" ? 4 : 12,
          (atName === "media" ? CSSMediaRuleCtor : CSSSupportsRuleCtor).prototype as object,
        );
        const indentInner = (inner: string): string => {
          const t = inner.trim();
          if (t === "") return "";
          return `${t.split("\n").map((l) => `  ${l.trim()}`).join("\n")}\n`;
        };
        const serialize = (): void => {
          const inner = atRuleBody(entry.cssText);
          entry.cssText = `@${atName} ${slotText(rule["_prelude"])} {\n${indentInner(inner)}}`;
          rebuildText();
        };
        rule["_reserialize"] = serialize;
        rule["_prelude"] = atName === "media"
          ? normalizeMediaQueryList(atParts.prelude.trim())
          : atParts.prelude.trim();
        if (atName === "media") {
          rule["_media"] = makeMediaList(rule["_prelude"] as string, () => {
            rule["_prelude"] = normalizeMediaQueryList(
              (rule["_media"] as Record<string, unknown>)["mediaText"] as string,
            );
            serialize();
          });
        }
        rule["_group"] = makeRuleHost(
          () => atRuleBody(entry.cssText),
          (inner) => {
            entry.cssText = `@${atName} ${slotText(rule["_prelude"])} {\n${indentInner(inner)}}`;
            rebuildText();
          },
          getSheet,
          { grouping: true },
        );
        // Canonicalize in place: `@media speech {}` → `@media speech {\n}`.
        entry.cssText = `@${atName} ${slotText(rule["_prelude"])} {\n${indentInner(atParts.body)}}`;
        return rule;
      }
      if (AT_RULE_TYPES[atName] === 7 && atParts !== undefined) {
        const rule = finish(7, CSSKeyframesRuleCtor.prototype as object);
        rule["_prelude"] = atParts.prelude.trim().replace(/^"(.*)"$/, "$1");
        // A name that is not a valid custom-ident (CSS-wide keywords, `none`,
        // `default`) serializes as a quoted string per css-animations.
        const nameOut = (): string => {
          const n = slotText(rule["_prelude"]);
          const low = n.toLowerCase();
          return CSS_WIDE_VALUE_SET.has(low) || low === "none" || low === "default"
            ? `"${n}"` : n;
        };
        rule["_reserialize"] = (): void => {
          const inner = atRuleBody(entry.cssText);
          entry.cssText = `@keyframes ${nameOut()} {\n${inner}}`;
          rebuildText();
        };
        rule["_group"] = makeRuleHost(
          () => atRuleBody(entry.cssText),
          (inner) => {
            entry.cssText = `@keyframes ${nameOut()} {\n${inner}}`;
            rebuildText();
          },
          getSheet,
          { keyframes: true },
        );
        entry.cssText = `@keyframes ${nameOut()} {\n${atParts.body}}`;
        // Indexed getter: `keyframes[0]` → cssRules[0]; `keyframes.length`.
        const proxied = new Proxy(rule, {
          get(t, prop): unknown {
            const list = (t["_group"] as ReturnType<typeof makeRuleHost>).cssRules as {
              length: number; [i: number]: unknown;
            };
            if (prop === "length") return list.length;
            if (typeof prop === "string" && /^\d+$/.test(prop)) {
              return list[Number(prop)];
            }
            return Reflect.get(t, prop);
          },
        });
        entry.ruleObject = proxied;
        return proxied;
      }

      // Declaration-bearing at-rules: @page (page selector) / @font-face.
      if ((atName === "page" || atName === "font-face") && atParts !== undefined) {
        const rule = finish(
          atName === "page" ? 6 : 5,
          (atName === "page" ? CSSPageRuleCtor : CSSFontFaceRuleCtor).prototype as object,
        );
        const serialize = (): void => {
          const body = atRuleBody(entry.cssText).trim();
          if (atName === "page") {
            const sel = slotText(rule["_pageSel"]);
            entry.cssText =
              `@page${sel !== "" ? ` ${sel}` : ""} {${body !== "" ? ` ${body} ` : " "}}`;
          } else {
            entry.cssText = `@font-face {${body !== "" ? ` ${body} ` : " "}}`;
          }
          rebuildText();
        };
        rule["_reserialize"] = serialize;
        rule["_pageSel"] = atName === "page" ? atParts.prelude.trim() : "";
        rule["_decl"] = makeDeclarationBacked(
          () => atRuleBody(entry.cssText),
          (text) => {
            const sel = slotText(rule["_pageSel"]);
            entry.cssText = atName === "page"
              ? `@page${sel !== "" ? ` ${sel}` : ""} {${text !== "" ? ` ${text} ` : " "}}`
              : `@font-face {${text !== "" ? ` ${text} ` : " "}}`;
            rebuildText();
          },
        );
        // Canonicalize `{...}` → `{ body }` spacing in place.
        entry.cssText = atName === "page"
          ? `@page${atParts.prelude.trim() !== "" ? ` ${atParts.prelude.trim()}` : ""} {${atParts.body.trim() !== "" ? ` ${atParts.body.trim()} ` : " "}}`
          : `@font-face {${atParts.body.trim() !== "" ? ` ${atParts.body.trim()} ` : " "}}`;
        return rule;
      }
      // @font-feature-values: prelude is the family name; the braced body holds
      // nested @annotation/@styleset/… blocks of `ident: <number>+` entries.
      if (atName === "font-feature-values" && atParts !== undefined) {
        const ffv: FfvData = {
          fontFamily: atParts.prelude.trim(),
          maps: parseFfvBody(atParts.body),
        };
        const rule = finish(14, CSSFontFeatureValuesRuleCtor.prototype as object, {
          _ffv: ffv,
        });
        ffv.reserialize = (): void => {
          let inner = "";
          for (const [attr, at] of FFV_ATTRS) {
            const map = ffv.maps[attr];
            if (map === undefined || map.size === 0) continue;
            const decls = [...map].map(([k, vs]) => `${k}: ${vs.join(" ")};`).join(" ");
            inner += ` @${at} { ${decls} }`;
          }
          entry.cssText = `@font-feature-values ${ffv.fontFamily} {${inner} }`;
          rebuildText();
        };
        return rule;
      }
      if (atName !== "") {
        return finish(AT_RULE_TYPES[atName] ?? 0, CSSRuleCtor.prototype as object);
      }
      if (parts === undefined) {
        return finish(0, CSSRuleCtor.prototype as object);
      }

      // The declaration block is a live view: edits via style/styleMap rewrite
      // the rule's cssText, which rewrites the element's text — the stylesheet
      // pipeline re-parses and the cascade picks it up on the next render.
      if (options.keyframes === true) {
        const keyText = normalizeKeyText(parts.selector);
        const decl = makeDeclarationBacked(
          () => splitRule(entry.cssText)?.body ?? "",
          (text) => {
            entry.cssText = `${keyText} { ${text} }`;
            rebuildText();
          },
        ) as StyleDeclarationObject;
        entry.cssText = `${keyText} { ${parts.body.trim()} }`;
        return finish(8, CSSKeyframeRuleCtor.prototype as object, {
          _decl: decl,
          _keyText: keyText,
        });
      }
      const decl = makeDeclarationBacked(
        () => splitRule(entry.cssText)?.body ?? "",
        (text) => {
          const cur = splitRule(entry.cssText);
          entry.cssText = `${cur?.selector ?? parts.selector} { ${text} }`;
          rebuildText();
        },
      ) as StyleDeclarationObject;
      // Lazily collect the sheet's @namespace declarations for selectorText
      // serialization (default-namespace prefix elision).
      const nsctx = (): NsContext => {
        ensureRulesParsed();
        const map = new Map<string, string>();
        let def: string | null = null;
        for (const r of rules) {
          if (/^@namespace\b/i.test(r.cssText)) {
            const parsedNs = parseNamespaceRule(r.cssText);
            if (parsedNs !== undefined) {
              if (parsedNs.prefix !== null) map.set(parsedNs.prefix, parsedNs.uri);
              else def = parsedNs.uri;
            }
          }
        }
        return { def, map };
      };
      // A materialized rule reports canonical cssText: `sel { decl; decl; }`.
      const canonSel = serializeSelectorText(parts.selector, nsctx());
      const canonBody = decl.cssText;
      entry.cssText = `${canonSel} {${canonBody !== "" ? ` ${canonBody} ` : " "}}`;
      // WebIDL attributes live on CSSStyleRule.prototype — the instance only
      // carries internal slots (_entry/_decl/_sheet/_type).
      const rule: Record<string, unknown> = {
        _entry: entry,
        _decl: decl,
        _sheet: getSheet(),
        _type: 1,
        _nsctx: nsctx,
      };
      Object.setPrototypeOf(rule, CSSStyleRuleCtor.prototype as object);
      entry.ruleObject = rule;
      return rule;
    };
    const cssRules = new Proxy([] as object[], {
      get(_target, prop): unknown {
        ensureRulesParsed();
        if (prop === "length") return rules.length;
        if (typeof prop === "string" && /^\d+$/.test(prop)) {
          const i = Number(prop);
          return i < rules.length ? makeRuleObject(rules[i]!) : undefined;
        }
        if (prop === Symbol.iterator) {
          return function* (): IterableIterator<object> {
            for (let i = 0; i < rules.length; i += 1) yield makeRuleObject(rules[i]!);
          };
        }
        // Array.prototype methods read length+indices through the proxy.
        const v: unknown = Reflect.get(Array.prototype, prop);
        return v;
      },
      has(_target, prop): boolean {
        ensureRulesParsed();
        return (typeof prop === "string" && /^\d+$/.test(prop) && Number(prop) < rules.length)
          || Reflect.has(Array.prototype, prop);
      },
      getOwnPropertyDescriptor(_target, prop): PropertyDescriptor | undefined {
        ensureRulesParsed();
        if (typeof prop === "string" && /^\d+$/.test(prop) && Number(prop) < rules.length) {
          return { value: makeRuleObject(rules[Number(prop)]!), writable: false, enumerable: true, configurable: true };
        }
        if (prop === "length") {
          return { value: rules.length, writable: true, enumerable: false, configurable: false };
        }
        return undefined;
      },
    });
    return {
      cssRules,
      insertRule(cssText: unknown, index?: unknown): number {
        ensureRulesParsed();
        const rule = coerceGuestString(cssText).trim();
        // CSSOM §insert-a-css-rule order: index bounds, then parse, then
        // hierarchy constraints.
        const i = index === undefined ? 0 : Math.trunc(Number(index));
        if (i < 0 || i > rules.length) {
          throw new DOMException(`insertRule: index ${i} out of range`, "IndexSizeError");
        }
        if (rule === "") {
          throw new DOMException("insertRule: empty rule text", "SyntaxError");
        }
        const atM = /^@([a-zA-Z-]+)/i.exec(rule);
        const insertAt = atM?.[1]?.toLowerCase() ?? "";
        if (insertAt === "") {
          const parts = splitRule(rule);
          if (parts === undefined || parts.selector === "") {
            throw new DOMException("insertRule: could not parse rule", "SyntaxError");
          }
        } else if (!(insertAt in AT_RULE_TYPES) && insertAt !== "import") {
          // Unknown at-rules parse as generic rules; require a braced body or
          // a trailing semicolon shape.
          if (!/^@[a-zA-Z-]+[^;{]*(;|\{.*\}\s*;?)$/s.test(rule)) {
            throw new DOMException("insertRule: could not parse rule", "SyntaxError");
          }
        }
        // Constructed sheets reject @import; grouping rules reject @import and
        // @namespace; top-level @import must precede non-@charset/@import rules
        // and @namespace must precede everything else.
        if (insertAt === "import") {
          if (disallowImport === true || options.grouping === true) {
            throw new DOMException(
              "insertRule cannot insert @import rules",
              disallowImport === true ? "SyntaxError" : "HierarchyRequestError",
            );
          }
          if (rules.some((r) => !/^@(charset|import)\b/i.test(r.cssText))) {
            throw new DOMException(
              "insertRule: @import must precede all other rules",
              "HierarchyRequestError",
            );
          }
        }
        if (insertAt === "namespace") {
          if (options.grouping === true) {
            throw new DOMException(
              "insertRule cannot insert @namespace rules in a grouping rule",
              "HierarchyRequestError",
            );
          }
          if (rules.some((r) => !/^@(charset|import|namespace)\b/i.test(r.cssText))) {
            throw new DOMException(
              "insertRule: @namespace must precede all other rules",
              "InvalidStateError",
            );
          }
        }
        // Selectors may not reference undeclared namespace prefixes.
        if (insertAt === "") {
          const sel = splitRule(rule)?.selector ?? "";
          if (/[a-zA-Z_][\w-]*\|(?![|=])/.test(sel)) {
            const declared = new Set<string>();
            for (const r of rules) {
              if (/^@namespace\b/i.test(r.cssText)) {
                const p = parseNamespaceRule(r.cssText)?.prefix;
                if (p !== null && p !== undefined) declared.add(p.toLowerCase());
              }
            }
            for (const m of sel.matchAll(/([a-zA-Z_][\w-]*)\|(?![|=])/g)) {
              const prefix = (m[1] ?? "").toLowerCase();
              if (!declared.has(prefix)) {
                throw new DOMException(
                  `insertRule: undeclared namespace prefix "${prefix}"`,
                  "SyntaxError",
                );
              }
            }
          }
        }
        rules.splice(i, 0, { cssText: rule });
        rebuildText();
        return i;
      },
      deleteRule(index: unknown): void {
        ensureRulesParsed();
        const i = Math.trunc(Number(index));
        if (i < 0 || i >= rules.length) {
          throw new DOMException(`deleteRule: index ${i} out of range`, "IndexSizeError");
        }
        // Deleting an @namespace rule while other (non @charset/@import/
        // @namespace) rules exist would leave an invalid sheet.
        const target = rules[i];
        if (target !== undefined && /^@namespace\b/i.test(target.cssText)
          && rules.some((r, j) => j !== i && !/^@(charset|import|namespace)\b/i.test(r.cssText))) {
          throw new DOMException(
            "deleteRule: cannot delete @namespace while other rules exist",
            "InvalidStateError",
          );
        }
        const removed = rules.splice(i, 1)[0];
        // Detach the old rule object: parentStyleSheet reads null, mutations
        // no longer reach the sheet (the entry is out of the list).
        if (removed?.ruleObject !== undefined) {
          const ro = removed.ruleObject as Record<string, unknown>;
          ro["_sheet"] = null;
          ro["_reserialize"] = (): void => {};
        }
        rebuildText();
      },
    };
  };

  // Detached CSSStyleSheet for CSSImportRule.styleSheet — the referenced
  // resource is not fetched, so the imported sheet is empty.
  const makeDetachedSheet = (text: string): object => {
    const sheet = (CSSStyleSheetCtor as unknown as (o: object) => Record<string, unknown>).call(undefined, {});
    sheet["_text"] = text;
    return sheet;
  };

  const makeStyleSheetObject = (nodeId: NodeId): object => {
    const cached = styleSheetCache.get(nodeId);
    if (cached !== undefined) return cached;
    const styleText = (): string => {
      let text = "";
      const collect = (id: NodeId): void => {
        const node = session.dom.nodes.get(id);
        if (node === undefined) return;
        if (node.kind === "text") {
          text += node.text ?? "";
          return;
        }
        for (const child of node.children) collect(child);
      };
      collect(nodeId);
      return text;
    };
    const rewriteStyleText = (text: string): void => {
      const node = session.dom.nodes.get(nodeId);
      if (node === undefined) return;
      const textIds: NodeId[] = [];
      const collectText = (id: NodeId): void => {
        const node = session.dom.nodes.get(id);
        if (node === undefined) return;
        if (node.kind === "text") {
          textIds.push(id);
          return;
        }
        for (const child of node.children) collectText(child);
      };
      collectText(nodeId);
      if (textIds.length === 1 && (session.dom.nodes.get(textIds[0] as NodeId)?.text ?? "") === text) {
        return;
      }
      for (const textId of textIds) session.removeChild(nodeId, textId);
      if (text !== "") session.appendChild(nodeId, session.createTextNode(text));
      mutations += 1;
    };
    const host = makeRuleHost(styleText, rewriteStyleText, () => sheet);
    // Element-backed sheets are CSSStyleSheet instances: shared members
    // (cssRules/insertRule/deleteRule/ownerRule/type/href/…) come from the
    // prototype via the `_host`/`_cssText` slots; element-linked attributes
    // (ownerNode/title/media/cssText) stay as own accessors.
    const sheet: Record<string, unknown> = {
      _host: host,
      _cssText: styleText,
      get ownerNode(): object {
        return makeElementCached(nodeId);
      },
      get cssText(): string {
        return styleText();
      },
      get disabled(): boolean {
        const node = session.dom.nodes.get(nodeId);
        if (node?.tag === "link") {
          if (node.attrs?.has("disabled") === true) return true;
          const tokens = (node.attrs?.get("rel") ?? "").toLowerCase().split(/\s+/);
          return (
            tokens.includes("stylesheet") &&
            tokens.includes("alternate") &&
            !session.isLinkEnabled(nodeId)
          );
        }
        return false;
      },
      set disabled(value: unknown) {
        const node = session.dom.nodes.get(nodeId);
        if (node?.tag !== "link") return;
        session.setLinkEnabled(nodeId, !value);
        if (value) session.setAttribute(nodeId, "disabled", "");
        else session.removeAttribute(nodeId, "disabled");
      },
      get media(): object {
        const node = session.dom.nodes.get(nodeId);
        return makeMediaList(node?.attrs?.get("media") ?? "");
      },
      // [PutForwards=mediaText]: `sheet.media = "print"` updates the list.
      set media(v: unknown) {
        session.setAttribute(nodeId, "media", coerceGuestString(v));
      },
      get title(): string | null {
        const node = session.dom.nodes.get(nodeId);
        return node?.attrs?.get("title") ?? null;
      },
      replaceSync(text: unknown): undefined {
        rewriteStyleText(coerceGuestString(text));
        return undefined;
      },
      replace(text: unknown): Promise<object> {
        rewriteStyleText(coerceGuestString(text));
        return Promise.resolve(sheet);
      },
      toString(): string {
        return "[object CSSStyleSheet]";
      },
    };
    Object.setPrototypeOf(sheet, CSSStyleSheetCtor.prototype as object);
    styleSheetCache.set(nodeId, sheet);
    return sheet;
  };

  /** Live list of the document's style/link sheets (document.styleSheets). */
  const documentStyleSheetsList = (): object[] => {
    const sheets: object[] = [];
    const visit = (id: NodeId): void => {
      const node = session.dom.nodes.get(id);
      if (node === undefined) return;
      if (node.kind === "element" && (node.tag === "style" || node.tag === "link")) {
        // link only counts when rel=stylesheet (CSSOM: only active sheets)
        const rel = (node.attrs?.get("rel") ?? "").toLowerCase();
        if (node.tag === "style" || rel.includes("stylesheet")) {
          sheets.push(makeStyleSheetObject(id));
        }
      }
      for (const child of node.children) visit(child);
    };
    visit(session.dom.root);
    return sheets;
  };

  /** Cache wrappers per node id so repeated lookups return a stable object. */
  const wrapperCache = new Map<NodeId, object>();
  const makeElementCached = (id: NodeId): object => {
    const cached = wrapperCache.get(id);
    if (cached !== undefined) return cached;
    const w = makeElement(id);
    const node = session.dom.nodes.get(id);
    const tag = node?.kind === "element" ? (node.tag ?? "") : "";
    const isSvg =
      tag === "svg" ||
      tag === "path" ||
      tag === "g" ||
      tag === "circle" ||
      tag === "rect" ||
      tag === "line" ||
      tag === "polyline" ||
      tag === "polygon" ||
      tag === "ellipse" ||
      tag === "text" ||
      tag === "tspan" ||
      tag === "defs" ||
      tag === "use" ||
      tag === "symbol" ||
      tag === "clipPath" ||
      tag === "mask" ||
      tag === "pattern" ||
      tag === "linearGradient" ||
      tag === "radialGradient" ||
      tag === "stop" ||
      tag === "image" ||
      tag === "foreignObject";
    if (node?.kind === "text" || node?.kind === "comment") {
      Object.setPrototypeOf(w, NodeCtor.prototype as object);
    } else if (isSvg) {
      Object.setPrototypeOf(w, SVGElementCtor.prototype as object);
    } else {
      // Tag-specific interface prototype when one exists (HTMLAnchorElement
      // for <a>, HTMLDivElement for <div>, …), else HTMLElement.prototype —
      // so `el instanceof HTMLAnchorElement` behaves like the platform.
      Object.setPrototypeOf(w, interfaceCtorForTag(tag) ?? (HTMLElementCtor.prototype as object));
    }
    // URL decomposition accessors live on the element itself so they win over
    // any same-named prototype member (installed AFTER the prototype is set —
    // defineProperties with own accessors).
    if (tag === "a" || tag === "area") {
      Object.defineProperties(w, urlDecompositionDescriptors(id, session));
    }
    if (tag === "style" || tag === "link") {
      Object.defineProperty(w, "sheet", {
        get: () => makeStyleSheetObject(id),
        enumerable: true,
        configurable: true,
      });
    }
    if (tag === "link") {
      // HTMLLinkElement.disabled — reflects the `disabled` attribute, OR an
      // alternate stylesheet that was never explicitly enabled. The
      // script-set "explicitly enabled" flag persists across disconnect.
      const linkDisabled = (): boolean => {
        const node = session.dom.nodes.get(id);
        if (node === undefined) return false;
        if (node.attrs?.has("disabled") === true) return true;
        const tokens = (node.attrs?.get("rel") ?? "").toLowerCase().split(/\s+/);
        return (
          tokens.includes("stylesheet") &&
          tokens.includes("alternate") &&
          !session.isLinkEnabled(id)
        );
      };
      const setLinkDisabled = (value: unknown): void => {
        // Set the flag BEFORE the attribute change so the attribute-driven
        // external-sheet rescan sees the new enablement state.
        session.setLinkEnabled(id, !value);
        if (value) session.setAttribute(id, "disabled", "");
        else session.removeAttribute(id, "disabled");
        mutations += 1;
      };
      const onEventProp = (type: string): PropertyDescriptor => ({
        get: () => listeners.get(id)?.find((l) => l.type === type)?.fn ?? null,
        set: (fn: unknown) => {
          const list = (listeners.get(id) ?? []).filter((l) => l.type !== type);
          if (typeof fn === "function") list.push({ type, fn: fn as GuestFn, capture: false });
          listeners.set(id, list);
        },
        enumerable: true,
        configurable: true,
      });
      Object.defineProperties(w, {
        disabled: { get: linkDisabled, set: setLinkDisabled, enumerable: true, configurable: true },
        onload: onEventProp("load"),
        onerror: onEventProp("error"),
      });
    }
    if (tag === "iframe") {
      // HTMLIFrameElement.contentDocument / .contentWindow — the nested
      // browsing context is a lazily-built `#iframe-document` subtree.
      Object.defineProperties(w, {
        contentDocument: {
          get: () => makeIframeDocument(ensureIframeDoc(id)),
          enumerable: true,
          configurable: true,
        },
        contentWindow: {
          get: () => makeIframeWindow(ensureIframeDoc(id)),
          enumerable: true,
          configurable: true,
        },
      });
    }
    wrapperCache.set(id, w);
    return w;
  };

  /** The first/last element child of `id`, ignoring text and comment nodes. */
  const edgeElementChild = (id: NodeId, dir: 1 | -1): object | null => {
    const kids = session.dom.nodes.get(id)?.children ?? [];
    let i = dir === 1 ? 0 : kids.length - 1;
    while (i >= 0 && i < kids.length) {
      const child = kids[i];
      if (child !== undefined && session.dom.nodes.get(child)?.kind === "element") return makeElementCached(child);
      i += dir;
    }
    return null;
  };

  /** The nearest element sibling of `id` in direction `dir` (+1 next, −1 prev). */
  const siblingElement = (id: NodeId, dir: 1 | -1): object | null => {
    const parent = session.dom.nodes.get(id)?.parent ?? null;
    if (parent === null) return null;
    const kids = session.dom.nodes.get(parent)?.children ?? [];
    let i = kids.indexOf(id) + dir;
    while (i >= 0 && i < kids.length) {
      const sib = kids[i];
      if (sib !== undefined && session.dom.nodes.get(sib)?.kind === "element") return makeElementCached(sib);
      i += dir;
    }
    return null;
  };

  const siblingNode = (id: NodeId, dir: 1 | -1): object | null => {
    const parent = session.dom.nodes.get(id)?.parent ?? null;
    if (parent === null) return null;
    const kids = session.dom.nodes.get(parent)?.children ?? [];
    const i = kids.indexOf(id) + dir;
    if (i < 0 || i >= kids.length) return null;
    const sib = kids[i];
    return sib === undefined ? null : makeElementCached(sib);
  };

  const escapeHtmlText = (value: string): string =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const escapeHtmlAttr = (value: string): string =>
    escapeHtmlText(value).replace(/"/g, "&quot;");
  const VOID_HTML = new Set([
    "area","base","br","col","embed","hr","img","input","link","meta","param","source","track","wbr",
  ]);
  const serializeNodeHtml = (id: NodeId): string => {
    const node = session.dom.nodes.get(id);
    if (node === undefined) return "";
    if (node.kind === "text") return escapeHtmlText(node.text ?? "");
    if (node.kind === "comment") return `<!--${node.text ?? ""}-->`;
    if (node.kind === "document") return serializeChildrenHtml(id);
    const tag = node.tag ?? "";
    let attrs = "";
    for (const [name, value] of node.attrs ?? []) {
      attrs += ` ${name}="${escapeHtmlAttr(value)}"`;
    }
    if (VOID_HTML.has(tag)) return `<${tag}${attrs}>`;
    return `<${tag}${attrs}>${serializeChildrenHtml(id)}</${tag}>`;
  };

  const serializeChildrenHtml = (id: NodeId): string => {
    const kids = session.dom.nodes.get(id)?.children ?? [];
    let out = "";
    for (const child of kids) out += serializeNodeHtml(child);
    return out;
  };

  /**
   * `url()` values inside a `style` attribute resolve against the document
   * base URL at declaration time — the resolved absolute URL is what gets
   * stored, so a later `<base>` change does not retroactively rewrite it
   * (the frozen-at-parse semantics `css-style-attr-decl-block` requires).
   */
  const rewriteStyleAttrUrls = (text: string): string => {
    if (!/url\s*\(/i.test(text)) return text;
    let out = "";
    let i = 0;
    const n = text.length;
    while (i < n) {
      const headMatch = /^url\s*\(/i.exec(text.slice(i));
      // A `url` preceded by an identifier char is a name tail (e.g. `xurl(`),
      // not a url() token.
      if (headMatch === null || (i > 0 && /[a-zA-Z0-9_-]/.test(text[i - 1] as string))) {
        out += text[i] as string;
        i += 1;
        continue;
      }
      const head = headMatch[0];
      const open = i + head.length;
      let j = open;
      let inner = "";
      let closed = false;
      while (j < n) {
        const ch = text[j] as string;
        if (ch === ")") { closed = true; break; }
        if (ch === '"' || ch === "'") {
          const q = ch;
          inner += ch;
          j += 1;
          while (j < n && text[j] !== q) { inner += text[j] as string; j += 1; }
          if (j < n) { inner += text[j] as string; j += 1; }
          continue;
        }
        inner += ch;
        j += 1;
      }
      if (!closed) { out += text.slice(i); i = n; break; }
      const t = inner.trim();
      const qm = /^(['"])([\s\S]*)\1$/.exec(t);
      const bare = qm !== null ? (qm[2] as string) : t;
      const abs = bare === "" ? null : resolveUrl(bare, session.baseUrl);
      out += head + (abs === null ? inner : `"${abs.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`) + ")";
      i = j + 1;
    }
    return out;
  };

  const importParsedNode = (source: DomNode, sourceTree: DomTree): NodeId | null => {
    if (source.kind === "document") return null;
    let id: NodeId;
    if (source.kind === "element") {
      id = session.createElement(source.tag ?? "");
      for (const [name, value] of source.attrs ?? []) {
        session.setAttribute(id, name, name === "style" ? rewriteStyleAttrUrls(value) : value);
      }
    } else if (source.kind === "text") {
      id = session.createTextNode(source.text ?? "");
    } else {
      id = session.createComment(source.text ?? "");
    }
    for (const childId of source.children) {
      const child = sourceTree.nodes.get(childId);
      if (child === undefined) continue;
      const imported = importParsedNode(child, sourceTree);
      if (imported !== null) session.appendChild(id, imported);
    }
    return id;
  };

  /**
   * Fragment content roots: the document-outline synthesis wraps parsed
   * fragments in html/head/body, so real content may sit at any depth of
   * those wrappers. Flatten them (in document order) before importing.
   */
  const fragmentContentRoots = (tree: ReturnType<typeof parseHtml>): NodeId[] => {
    const out: NodeId[] = [];
    const isOutline = (n: ReturnType<typeof tree.nodes.get>) =>
      n !== undefined && n.kind === "element" &&
      (n.tag === "html" || n.tag === "head" || n.tag === "body");
    const visit = (id: NodeId): void => {
      const n = tree.nodes.get(id);
      if (n === undefined) return;
      if (isOutline(n)) {
        for (const c of n.children) visit(c);
        return;
      }
      out.push(id);
    };
    for (const c of tree.nodes.get(tree.root)?.children ?? []) visit(c);
    return out;
  };

  const replaceInnerHtml = (id: NodeId, html: string): void => {
    const node = session.dom.nodes.get(id);
    if (node === undefined || node.kind === "text" || node.kind === "comment") return;
    for (const child of [...node.children]) {
      session.removeChild(id, child);
    }
    if (html === "") return;
    insertHtmlIntoParent(id, html);
  };

  /**
   * Parse `html` and append its content roots under `parentId` — the shared
   * parse-and-import engine behind `innerHTML =`, `document.write`, and
   * `insertAdjacentHTML`.
   */
  const insertHtmlIntoParent = (parentId: NodeId, html: string): void => {
    const tree = parseHtml(new TextEncoder().encode(html));
    for (const contentId of fragmentContentRoots(tree)) {
      const child = tree.nodes.get(contentId);
      if (child === undefined) continue;
      const imported = importParsedNode(child, tree);
      if (imported !== null) session.appendChild(parentId, imported);
    }
  };

  /**
   * D5 — `document.write` insertion: parse `html` and insert its content
   * AFTER `afterId` (the currently executing script's document position).
   */
  const insertHtmlAfterNode = (afterId: NodeId, html: string): void => {
    const parent = session.dom.nodes.get(afterId)?.parent ?? null;
    if (parent === null) return;
    const siblings = session.dom.nodes.get(parent)?.children ?? [];
    const index = siblings.indexOf(afterId);
    const ref = index >= 0 && index + 1 < siblings.length ? (siblings[index + 1] ?? null) : null;
    const tree = parseHtml(new TextEncoder().encode(html));
    for (const contentId of fragmentContentRoots(tree)) {
      const child = tree.nodes.get(contentId);
      if (child === undefined) continue;
      const imported = importParsedNode(child, tree);
      if (imported !== null) session.insertBefore(parent, imported, ref);
    }
  };

  const replaceOuterHtml = (id: NodeId, html: string): void => {
    const parent = session.dom.nodes.get(id)?.parent ?? null;
    if (parent === null) return;
    const kids = session.dom.nodes.get(parent)?.children ?? [];
    const index = kids.indexOf(id);
    const ref = index >= 0 && index + 1 < kids.length ? (kids[index + 1] ?? null) : null;
    session.removeChild(parent, id);
    if (html === "") return;
    const tree = parseHtml(new TextEncoder().encode(html));
    for (const contentId of fragmentContentRoots(tree)) {
      const child = tree.nodes.get(contentId);
      if (child === undefined) continue;
      const imported = importParsedNode(child, tree);
      if (imported !== null) session.insertBefore(parent, imported, ref);
    }
  };


  const wrap = (id: NodeId | null): object | null => (id === null ? null : makeElementCached(id));

  // ---- DOM events: capture → target → bubble propagation ------------------

  type GuestFn = (...args: unknown[]) => unknown;
  interface GuestEvent {
    type: string;
    bubbles: boolean;
    cancelable: boolean;
    target: object | null;
    currentTarget: object | null;
    eventPhase: number;
    defaultPrevented: boolean;
    __stop: boolean;
    __stopImmediate: boolean;
    preventDefault(): void;
    stopPropagation(): void;
    stopImmediatePropagation(): void;
  }

  function makeEvent(type: string, opts?: { bubbles?: boolean; cancelable?: boolean }): GuestEvent {
    const evt: GuestEvent = {
      type,
      bubbles: opts?.bubbles ?? false,
      cancelable: opts?.cancelable ?? false,
      target: null,
      currentTarget: null,
      eventPhase: 0,
      defaultPrevented: false,
      __stop: false,
      __stopImmediate: false,
      preventDefault(): void {
        if (evt.cancelable) evt.defaultPrevented = true;
      },
      stopPropagation(): void {
        evt.__stop = true;
      },
      stopImmediatePropagation(): void {
        evt.__stop = true;
        evt.__stopImmediate = true;
      },
    };
    return evt;
  }

  /** The ancestor path of `id` from the node up to the root (inclusive of node). */
  function ancestorPath(id: NodeId): NodeId[] {
    const path: NodeId[] = [];
    let cur: NodeId | null = id;
    while (cur !== null) {
      path.push(cur);
      cur = session.dom.nodes.get(cur)?.parent ?? null;
    }
    return path;
  }

  // The dispatch machinery drives BOTH internal plain-object events
  // ({@link makeEvent}) and real guest `Event` instances whose target /
  // currentTarget / eventPhase are readonly accessors — mutate and read
  // dispatch state through the internal hooks when they exist.
  type DispatchableEvent = GuestEvent & {
    _setTarget?: (v: object | null) => void;
    _setCurrentTarget?: (v: object | null) => void;
    _setPhase?: (p: number) => void;
    _propagationStopped?: () => boolean;
    _immediatePropagationStopped?: () => boolean;
  };

  function setEventTarget(evt: GuestEvent, value: object | null): void {
    const impl = evt as DispatchableEvent;
    if (typeof impl._setTarget === "function") impl._setTarget(value);
    else evt.target = value;
  }

  function setEventCurrentTarget(evt: GuestEvent, value: object | null): void {
    const impl = evt as DispatchableEvent;
    if (typeof impl._setCurrentTarget === "function") impl._setCurrentTarget(value);
    else evt.currentTarget = value;
  }

  function setEventPhase(evt: GuestEvent, phase: number): void {
    const impl = evt as DispatchableEvent;
    if (typeof impl._setPhase === "function") impl._setPhase(phase);
    else evt.eventPhase = phase;
  }

  function propagationStopped(evt: GuestEvent): boolean {
    const impl = evt as DispatchableEvent;
    if (typeof impl._propagationStopped === "function") return impl._propagationStopped();
    return evt.__stop === true;
  }

  function immediatePropagationStopped(evt: GuestEvent): boolean {
    const impl = evt as DispatchableEvent;
    if (typeof impl._immediatePropagationStopped === "function") return impl._immediatePropagationStopped();
    return evt.__stopImmediate === true;
  }

  /** Run the element's inline `on<type>` attribute handler (if any) at target. */
  function invokeInlineHandler(node: NodeId, evt: GuestEvent): void {
    if (propagationStopped(evt)) return;
    const body = session.dom.nodes.get(node)?.attrs?.get(`on${evt.type}`);
    if (body === undefined || compileInlineHandler === null) return;
    const key = `${node}:${evt.type}`;
    let handler = inlineHandlerCache.get(key);
    if (handler === undefined) {
      const compiled = compileInlineHandler(body);
      if (typeof compiled !== "function") return;
      handler = compiled as GuestFn;
      inlineHandlerCache.set(key, handler);
    }
    const result = handler.call(makeElementCached(node), evt);
    if (result === false) evt.preventDefault();
  }

  /** The nearest form ancestor of `id` (or null). */
  function ownerForm(id: NodeId): NodeId | null {
    let cur: NodeId | null = session.dom.nodes.get(id)?.parent ?? null;
    while (cur !== null) {
      if (session.dom.nodes.get(cur)?.tag === "form") return cur;
      cur = session.dom.nodes.get(cur)?.parent ?? null;
    }
    return null;
  }

  /** The first labelable descendant of a <label> (tree order). */
  function labeledControlOf(labelId: NodeId): NodeId | null {
    const visit = (id: NodeId): NodeId | null => {
      for (const childId of session.dom.nodes.get(id)?.children ?? []) {
        const n = session.dom.nodes.get(childId);
        if (n?.kind === "element" && (n.tag === "input" || n.tag === "button" || n.tag === "select" || n.tag === "textarea")) {
          return childId;
        }
        const found = visit(childId);
        if (found !== null) return found;
      }
      return null;
    };
    return visit(labelId);
  }

  function activateCheckboxRadio(id: NodeId, radio: boolean): void {
    const state = nodeState.get(id) ?? {};
    const previously = state.checked ?? session.dom.nodes.get(id)?.attrs?.get("checked") !== undefined;
    state.checked = radio ? true : !previously;
    nodeState.set(id, state);
    dispatch(id, makeEvent("input", { bubbles: true }));
    dispatch(id, makeEvent("change", { bubbles: true }));
  }

  function activateFormControl(id: NodeId, type: string): void {
    const form = ownerForm(id);
    if (form !== null) dispatch(form, makeEvent(type, { bubbles: true, cancelable: true }));
  }

  function activateHashLink(id: NodeId): void {
    const href = session.dom.nodes.get(id)?.attrs?.get("href") ?? "";
    const hashIndex = href.indexOf("#");
    navigateToHashFragment?.(hashIndex >= 0 ? href.slice(hashIndex + 1) : "");
  }

  function toggleDetails(summaryId: NodeId): void {
    const parentId = session.dom.nodes.get(summaryId)?.parent ?? null;
    if (parentId === null) return;
    const details = session.dom.nodes.get(parentId);
    if (details === undefined || details.tag !== "details") return;
    const state = nodeState.get(parentId) ?? {};
    state.open = !state.open;
    nodeState.set(parentId, state);
    dispatch(parentId, makeEvent("toggle"));
  }

  /**
   * Activation behavior (HTML §2.5): walk from the clicked element up the
   * ancestor chain and run the NEAREST activation behavior — checkbox/radio
   * toggle + input/change, form submit/reset, hash navigation for a/area,
   * details toggle via summary, and label forwarding to its control.
   */
  function runActivationBehavior(startId: NodeId, visited: Set<NodeId> = new Set()): void {
    let cur: NodeId | null = startId;
    while (cur !== null && !visited.has(cur)) {
      visited.add(cur);
      const node = session.dom.nodes.get(cur);
      if (node?.kind === "element") {
        const tag = node.tag;
        const type = (node.attrs?.get("type") ?? "").toLowerCase();
        if (tag === "input" && (type === "checkbox" || type === "radio")) {
          activateCheckboxRadio(cur, type === "radio");
          return;
        }
        if (tag === "input" && (type === "submit" || type === "image")) {
          activateFormControl(cur, "submit");
          return;
        }
        if (tag === "button" && (type === "" || type === "submit")) {
          activateFormControl(cur, "submit");
          return;
        }
        if ((tag === "input" || tag === "button") && type === "reset") {
          activateFormControl(cur, "reset");
          return;
        }
        if (tag === "a" || tag === "area") {
          activateHashLink(cur);
          return;
        }
        if (tag === "summary") {
          toggleDetails(cur);
          return;
        }
        if (tag === "label") {
          const control = labeledControlOf(cur);
          if (control !== null) runActivationBehavior(control, visited);
          return;
        }
      }
      cur = node?.parent ?? null;
    }
  }

  /** Invoke the listeners registered on `node` for this phase; honour stop flags. */
  function invokeAt(node: NodeId, evt: GuestEvent, capturePhase: boolean): void {
    const list = listeners.get(node);
    if (list === undefined) return;
    const cached = makeElementCached(node);
    setEventCurrentTarget(evt, cached);
    for (const l of [...list]) {
      if (l.type !== evt.type) continue;
      const isTargetNode = idOf.get(cached) === node && evt.eventPhase === 2;
      if (!isTargetNode && l.capture !== capturePhase) continue;
      l.fn.call(evt.currentTarget, evt);
      if (immediatePropagationStopped(evt)) return;
    }
  }

  /** Dispatch `event` to `targetId` through capture/target/bubble phases. */
  function dispatch(targetId: NodeId, event: GuestEvent): boolean {
    const path = ancestorPath(targetId); // [target, ...ancestors, root]
    setEventTarget(event, makeElementCached(targetId));
    // Capture phase: root → just above target.
    setEventPhase(event, 1);
    for (let i = path.length - 1; i >= 1; i -= 1) {
      invokeAt(path[i] as NodeId, event, true);
      if (propagationStopped(event)) {
        setEventPhase(event, 0);
        return !event.defaultPrevented;
      }
    }
    // Target phase.
    setEventPhase(event, 2);
    invokeAt(targetId, event, false);
    invokeInlineHandler(targetId, event);
    // Bubble phase: just above target → root.
    if (event.bubbles && !propagationStopped(event)) {
      setEventPhase(event, 3);
      for (let i = 1; i < path.length; i += 1) {
        invokeAt(path[i] as NodeId, event, false);
        if (propagationStopped(event)) break;
      }
    }
    setEventPhase(event, 0);
    setEventCurrentTarget(event, null);
    return !event.defaultPrevented;
  }

  /** The guest `Event` constructor (`new Event(type, { bubbles, cancelable })`). */
  function EventCtor(this: unknown, type: unknown, opts: unknown): GuestEvent {
    const o = typeof opts === "object" && opts !== null ? (opts as { bubbles?: boolean; cancelable?: boolean }) : {};
    return makeEvent(String(type), { bubbles: o.bubbles === true, cancelable: o.cancelable === true });
  }

  /**
   * Synthesize a trusted (platform-generated) guest event from plain host
   * input data. The event carries pointer/keyboard fields when present, so
   * page handlers that read `clientX` / `key` / `button` see real values.
   * DOM `isTrusted` is true for platform events (UI Events §3.2); the
   * plain-object event model marks trustedness with an internal flag the
   * dispatch path never resets.
   */
  function makePlatformEvent(input: PlatformEventInput): GuestEvent {
    const pointerLike = input.clientX !== undefined || input.clientY !== undefined
      || input.button !== undefined || input.deltaY !== undefined;
    const keyLike = input.key !== undefined || input.code !== undefined;
    const evt = makeEvent(input.type, {
      bubbles: input.bubbles ?? true,
      cancelable: input.cancelable ?? true,
    });
    const withInput = evt as unknown as Record<string, unknown>;
    withInput["isTrusted"] = true;
    if (pointerLike) {
      withInput["clientX"] = input.clientX ?? 0;
      withInput["clientY"] = input.clientY ?? 0;
      withInput["screenX"] = input.clientX ?? 0;
      withInput["screenY"] = input.clientY ?? 0;
      withInput["pageX"] = input.clientX ?? 0;
      withInput["pageY"] = input.clientY ?? 0;
      withInput["offsetX"] = input.clientX ?? 0;
      withInput["offsetY"] = input.clientY ?? 0;
      withInput["button"] = input.button ?? 0;
      withInput["buttons"] = input.buttons ?? 0;
      withInput["movementX"] = 0;
      withInput["movementY"] = 0;
      withInput["deltaX"] = input.deltaX ?? 0;
      withInput["deltaY"] = input.deltaY ?? 0;
      withInput["deltaZ"] = input.deltaZ ?? 0;
      withInput["deltaMode"] = input.deltaMode ?? 0;
    }
    if (keyLike) {
      withInput["key"] = input.key ?? "";
      withInput["code"] = input.code ?? "";
      withInput["keyCode"] = 0;
      withInput["which"] = 0;
      withInput["charCode"] = 0;
      withInput["repeat"] = false;
      withInput["isComposing"] = false;
      withInput["getModifierState"] = (): boolean => false;
    }
    withInput["detail"] = input.detail ?? 0;
    withInput["view"] = null;
    return evt;
  }

  /**
   * Host→guest trusted input dispatch (UI Events): dispatch a platform event
   * at `nodeId` through capture → target → bubble, then run the activation
   * behavior for `click` when not default-prevented. Returns whether the
   * event was NOT default-prevented (mirrors `dispatchEvent`).
   */
  function dispatchPlatformEvent(nodeId: NodeId, input: PlatformEventInput): boolean {
    if (session.dom.nodes.get(nodeId) === undefined) return true;
    const evt = makePlatformEvent(input);
    const notPrevented = dispatch(nodeId, evt);
    if (input.type === "click" && notPrevented) {
      runActivationBehavior(nodeId);
    }
    return notPrevented;
  }

  function NodeCtor(): never {
    throw new Error("Illegal constructor");
  }
  Object.assign(NodeCtor, NODE_DOCUMENT_POSITION_CONSTANTS);
  Object.assign(NodeCtor.prototype, NODE_DOCUMENT_POSITION_CONSTANTS);
  function ElementCtor(): never {
    throw new Error("Illegal constructor");
  }
  Object.setPrototypeOf(ElementCtor.prototype as object, NodeCtor.prototype as object);
  function HTMLElementCtor(): never {
    throw new Error("Illegal constructor");
  }
  Object.setPrototypeOf(HTMLElementCtor.prototype as object, ElementCtor.prototype as object);

  function SVGElementCtor(): never {
    throw new Error("Illegal constructor");
  }
  Object.setPrototypeOf(SVGElementCtor.prototype as object, ElementCtor.prototype as object);
  function MathMLElementCtor(): never {
    throw new Error("Illegal constructor");
  }
  Object.setPrototypeOf(MathMLElementCtor.prototype as object, ElementCtor.prototype as object);

  // CSSOM rule interfaces — members live on the prototypes per WebIDL.
  function CSSRuleCtor(): never {
    throw new Error("Illegal constructor");
  }
  function CSSGroupingRuleCtor(): never {
    throw new Error("Illegal constructor");
  }
  function CSSStyleRuleCtor(): never {
    throw new Error("Illegal constructor");
  }
  Object.setPrototypeOf(CSSGroupingRuleCtor, CSSRuleCtor);
  Object.setPrototypeOf(CSSGroupingRuleCtor.prototype as object, CSSRuleCtor.prototype as object);
  Object.setPrototypeOf(CSSStyleRuleCtor, CSSGroupingRuleCtor);
  Object.setPrototypeOf(CSSStyleRuleCtor.prototype as object, CSSGroupingRuleCtor.prototype as object);
  // WebIDL: attribute getters brand-check `this` (reading the attribute on
  // the prototype object itself throws TypeError) and carry the name
  // `get <attr>`.
  const ruleAccessor = (
    attr: string,
    slot: string,
    get: (o: Record<string, unknown>, v: unknown) => unknown,
  ): PropertyDescriptor => {
    const getter = function (this: Record<string, unknown>): unknown {
      const v = this[slot];
      if (v === undefined) throw new TypeError("Illegal invocation");
      return get(this, v);
    };
    Object.defineProperty(getter, "name", { value: `get ${attr}` });
    return { get: getter, enumerable: true, configurable: true };
  };
  Object.defineProperties(CSSRuleCtor.prototype as object, {
    type: ruleAccessor("type", "_type", (_o, v) => v),
    cssText: ruleAccessor(
      "cssText",
      "_entry",
      (_o, v) => (v as { cssText: string }).cssText,
    ),
    parentRule: ruleAccessor("parentRule", "_entry", () => null),
    parentStyleSheet: ruleAccessor("parentStyleSheet", "_sheet", (_o, v) => v),
  });
  Object.defineProperties(CSSStyleRuleCtor.prototype as object, {
    selectorText: ruleAccessor(
      "selectorText",
      "_entry",
      (o, v) => {
        const sel = splitRule((v as { cssText: string }).cssText)?.selector ?? "";
        const getNs = o["_nsctx"];
        return serializeSelectorText(
          sel,
          typeof getNs === "function" ? (getNs as () => NsContext)() : undefined,
        );
      },
    ),
    style: ruleAccessor("style", "_decl", (_o, v) => v),
    // Typed OM: [SameObject] StylePropertyMap — cached on the rule.
    styleMap: ruleAccessor("styleMap", "_decl", (o, v) => {
      const self = o as { _styleMap?: object };
      if (self._styleMap === undefined) {
        self._styleMap = makeStylePropertyMap(styleMapBackingForDecl(v as StyleDeclarationObject));
      }
      return self._styleMap;
    }),
  });

  // Typed at-rule interfaces (CSSOM §5.4+). All are illegal to construct;
  // instances are created internally by makeRuleObject with internal slots.
  function CSSMediaRuleCtor(): never {
    throw new Error("Illegal constructor");
  }
  function CSSSupportsRuleCtor(): never {
    throw new Error("Illegal constructor");
  }
  function CSSPageRuleCtor(): never {
    throw new Error("Illegal constructor");
  }
  function CSSFontFaceRuleCtor(): never {
    throw new Error("Illegal constructor");
  }
  function CSSImportRuleCtor(): never {
    throw new Error("Illegal constructor");
  }
  function CSSNamespaceRuleCtor(): never {
    throw new Error("Illegal constructor");
  }
  function CSSKeyframesRuleCtor(): never {
    throw new Error("Illegal constructor");
  }
  function CSSKeyframeRuleCtor(): never {
    throw new Error("Illegal constructor");
  }
  const linkRuleCtor = (name: string, ctor: { prototype: object }, base: { prototype: object }): void => {
    Object.defineProperty(ctor, "name", { value: name });
    Object.setPrototypeOf(ctor, base);
    Object.setPrototypeOf(ctor.prototype, base.prototype);
    Object.defineProperty(ctor.prototype, "constructor", {
      value: ctor, writable: true, enumerable: false, configurable: true,
    });
  };
  linkRuleCtor("CSSMediaRule", CSSMediaRuleCtor, CSSGroupingRuleCtor);
  linkRuleCtor("CSSSupportsRule", CSSSupportsRuleCtor, CSSGroupingRuleCtor);
  linkRuleCtor("CSSPageRule", CSSPageRuleCtor, CSSGroupingRuleCtor);
  linkRuleCtor("CSSFontFaceRule", CSSFontFaceRuleCtor, CSSRuleCtor);
  linkRuleCtor("CSSImportRule", CSSImportRuleCtor, CSSRuleCtor);
  linkRuleCtor("CSSNamespaceRule", CSSNamespaceRuleCtor, CSSRuleCtor);
  linkRuleCtor("CSSKeyframesRule", CSSKeyframesRuleCtor, CSSRuleCtor);
  linkRuleCtor("CSSKeyframeRule", CSSKeyframeRuleCtor, CSSRuleCtor);

  const slotCheck = (o: Record<string, unknown>, slot: string): unknown => {
    const v = o[slot];
    if (v === undefined) throw new TypeError("Illegal invocation");
    return v;
  };
  // [PutForwards=mediaText] shared by CSSMediaRule.media / CSSImportRule.media /
  // StyleSheet.media.
  const mediaForward = (slot: string): PropertyDescriptor => ({
    get: function (this: Record<string, unknown>): unknown {
      return slotCheck(this, slot);
    },
    set: function (this: Record<string, unknown>, v: unknown): void {
      const list = slotCheck(this, slot) as Record<string, unknown>;
      list["mediaText"] = coerceGuestString(v);
    },
    enumerable: true,
    configurable: true,
  });
  const groupHost = (o: Record<string, unknown>): {
    readonly cssRules: object;
    insertRule(cssText: unknown, index?: unknown): number;
    deleteRule(index: unknown): void;
  } => slotCheck(o, "_group") as ReturnType<typeof makeRuleHost>;
  Object.defineProperties(CSSGroupingRuleCtor.prototype as object, {
    cssRules: {
      get: function (this: Record<string, unknown>): unknown {
        return groupHost(this).cssRules;
      },
      enumerable: true,
      configurable: true,
    },
    insertRule: {
      value: function insertRule(this: Record<string, unknown>, cssText: unknown, index?: unknown): number {
        return groupHost(this).insertRule(cssText, index);
      },
      writable: true,
      enumerable: true,
      configurable: true,
    },
    deleteRule: {
      value: function deleteRule(this: Record<string, unknown>, index: unknown): void {
        groupHost(this).deleteRule(index);
      },
      writable: true,
      enumerable: true,
      configurable: true,
    },
  });
  Object.defineProperties(CSSMediaRuleCtor.prototype as object, {
    media: mediaForward("_media"),
    conditionText: {
      get: function (this: Record<string, unknown>): unknown {
        return slotCheck(this, "_prelude");
      },
      set: function (this: Record<string, unknown>, v: unknown): void {
        const media = slotCheck(this, "_media") as Record<string, unknown>;
        media["mediaText"] = coerceGuestString(v);
      },
      enumerable: true,
      configurable: true,
    },
  });
  Object.defineProperties(CSSSupportsRuleCtor.prototype as object, {
    conditionText: {
      get: function (this: Record<string, unknown>): unknown {
        return slotCheck(this, "_prelude");
      },
      set: function (this: Record<string, unknown>, v: unknown): void {
        this["_prelude"] = coerceGuestString(v);
        (this["_reserialize"] as (() => void) | undefined)?.();
      },
      enumerable: true,
      configurable: true,
    },
  });
  Object.defineProperties(CSSPageRuleCtor.prototype as object, {
    selectorText: {
      get: function (this: Record<string, unknown>): unknown {
        return slotCheck(this, "_pageSel");
      },
      set: function (this: Record<string, unknown>, v: unknown): void {
        slotCheck(this, "_pageSel");
        const text = coerceGuestString(v);
        // Page selector grammar: optional ident + page pseudos, no whitespace.
        const m = /^([a-zA-Z_][\w-]*)?((?::[a-zA-Z-]+)*)$/.exec(text);
        if (m === null) return;
        const pseudos = (m[2] ?? "").match(/:[a-zA-Z-]+/g) ?? [];
        const valid = pseudos.every((p) =>
          [":first", ":left", ":right", ":blank"].includes(p.toLowerCase()));
        if (!valid) return;
        this["_pageSel"] = (m[1] ?? "") + pseudos.map((p) => p.toLowerCase()).join("");
        (this["_reserialize"] as (() => void) | undefined)?.();
      },
      enumerable: true,
      configurable: true,
    },
    style: {
      get: function (this: Record<string, unknown>): unknown {
        return slotCheck(this, "_decl");
      },
      set: function (this: Record<string, unknown>, v: unknown): void {
        const decl = slotCheck(this, "_decl") as Record<string, unknown>;
        decl["cssText"] = coerceGuestString(v);
      },
      enumerable: true,
      configurable: true,
    },
  });
  Object.defineProperties(CSSFontFaceRuleCtor.prototype as object, {
    style: ruleAccessor("style", "_decl", (_o, v) => v),
  });
  Object.defineProperties(CSSImportRuleCtor.prototype as object, {
    href: ruleAccessor("href", "_import", (_o, v) => (v as { href: string }).href),
    media: {
      get: function (this: Record<string, unknown>): unknown {
        return (slotCheck(this, "_import") as { media: object }).media;
      },
      set: function (this: Record<string, unknown>, v: unknown): void {
        const im = slotCheck(this, "_import") as { media: Record<string, unknown> };
        im.media["mediaText"] = coerceGuestString(v);
      },
      enumerable: true,
      configurable: true,
    },
    styleSheet: ruleAccessor("styleSheet", "_import", (_o, v) => (v as { sheet: object }).sheet),
    supportsText: ruleAccessor("supportsText", "_import", (_o, v) =>
      (v as { supports: string | null }).supports),
    layerName: ruleAccessor("layerName", "_import", (_o, v) =>
      (v as { layerName: string | null }).layerName),
  });
  Object.defineProperties(CSSNamespaceRuleCtor.prototype as object, {
    namespaceURI: ruleAccessor("namespaceURI", "_namespace", (_o, v) =>
      (v as { uri: string }).uri),
    prefix: ruleAccessor("prefix", "_namespace", (_o, v) =>
      (v as { prefix: string | null }).prefix),
  });
  Object.defineProperties(CSSKeyframesRuleCtor.prototype as object, {
    name: {
      get: function (this: Record<string, unknown>): unknown {
        return slotCheck(this, "_prelude");
      },
      set: function (this: Record<string, unknown>, v: unknown): void {
        slotCheck(this, "_prelude");
        this["_prelude"] = coerceGuestString(v);
        (this["_reserialize"] as (() => void) | undefined)?.();
      },
      enumerable: true,
      configurable: true,
    },
    cssRules: {
      get: function (this: Record<string, unknown>): unknown {
        return groupHost(this).cssRules;
      },
      enumerable: true,
      configurable: true,
    },
    appendRule: {
      value: function appendRule(this: Record<string, unknown>, cssText: unknown): void {
        groupHost(this).insertRule(cssText, (groupHost(this).cssRules as { length: number }).length);
      },
      writable: true,
      enumerable: true,
      configurable: true,
    },
    deleteRule: {
      value: function deleteRule(this: Record<string, unknown>, select: unknown): void {
        const host = groupHost(this);
        const list = host.cssRules as { length: number; [i: number]: Record<string, unknown> };
        const sel = coerceGuestString(select);
        // CSSKeyframesRule.deleteRule removes the LAST rule with keyText match.
        for (let i = list.length - 1; i >= 0; i -= 1) {
          if (list[i]?.["keyText"] === sel) {
            host.deleteRule(i);
            return;
          }
        }
      },
      writable: true,
      enumerable: true,
      configurable: true,
    },
    findRule: {
      value: function findRule(this: Record<string, unknown>, select: unknown): unknown {
        const list = groupHost(this).cssRules as { length: number; [i: number]: Record<string, unknown> };
        const sel = coerceGuestString(select);
        // CSSKeyframesRule.findRule returns the LAST rule with keyText match.
        for (let i = list.length - 1; i >= 0; i -= 1) {
          if (list[i]?.["keyText"] === sel) return list[i];
        }
        return null;
      },
      writable: true,
      enumerable: true,
      configurable: true,
    },
  });
  Object.defineProperties(CSSKeyframeRuleCtor.prototype as object, {
    keyText: ruleAccessor("keyText", "_keyText", (_o, v) => v),
    style: ruleAccessor("style", "_decl", (_o, v) => v),
  });

  // ── @font-feature-values (CSS Fonts 4 §om-fontfeaturevalues) ─────────
  function CSSFontFeatureValuesRuleCtor(): never {
    throw new Error("Illegal constructor");
  }
  function CSSFontFeatureValuesMapCtor(): never {
    throw new Error("Illegal constructor");
  }
  linkRuleCtor("CSSFontFeatureValuesRule", CSSFontFeatureValuesRuleCtor, CSSRuleCtor);
  Object.defineProperty(CSSFontFeatureValuesMapCtor, "name", { value: "CSSFontFeatureValuesMap" });
  Object.defineProperty(CSSFontFeatureValuesMapCtor.prototype as object, "constructor", {
    value: CSSFontFeatureValuesMapCtor, writable: true, enumerable: false, configurable: true,
  });

  /** `[attribute-name, at-rule-name]` pairs in spec serialization order. */
  const FFV_ATTRS: readonly (readonly [string, string])[] = [
    ["annotation", "annotation"],
    ["characterVariant", "character-variant"],
    ["ornaments", "ornaments"],
    ["stylistic", "stylistic"],
    ["styleset", "styleset"],
    ["swash", "swash"],
  ];

  interface FfvData {
    fontFamily: string;
    maps: Record<string, Map<string, number[]>>;
    reserialize?: (() => void) | undefined;
  }

  const parseFfvBody = (body: string): Record<string, Map<string, number[]>> => {
    const maps: Record<string, Map<string, number[]>> = {};
    for (const [attr] of FFV_ATTRS) maps[attr] = new Map();
    let i = 0;
    while (i < body.length) {
      const m = /@([a-zA-Z-]+)\s*\{/.exec(body.slice(i));
      if (m === null) break;
      const at = (m[1] ?? "").toLowerCase();
      const start = i + m.index + m[0].length;
      const close = body.indexOf("}", start);
      const inner = close < 0 ? body.slice(start) : body.slice(start, close);
      i = close < 0 ? body.length : close + 1;
      const attr = FFV_ATTRS.find(([, a]) => a === at)?.[0];
      if (attr === undefined) continue;
      const map = maps[attr] as Map<string, number[]>;
      for (const decl of inner.split(";")) {
        const d = /^\s*([a-zA-Z_][\w-]*)\s*:\s*(.*?)\s*$/.exec(decl);
        if (d === null) continue;
        const nums = (d[2] ?? "").split(/\s+/).filter((t) => t !== "").map(Number);
        if (nums.some((n) => !Number.isFinite(n))) continue;
        map.set(d[1] as string, nums);
      }
    }
    return maps;
  };

  const ffvSlot = (o: Record<string, unknown>): { ffv: FfvData; attr: string } =>
    slotCheck(o, "_ffvMap") as { ffv: FfvData; attr: string };

  const ffvMapOf = (o: Record<string, unknown>): Map<string, number[]> =>
    ffvSlot(o).ffv.maps[ffvSlot(o).attr] as Map<string, number[]>;

  Object.defineProperties(CSSFontFeatureValuesMapCtor.prototype as object, {
    size: {
      get: function (this: Record<string, unknown>): number {
        return ffvMapOf(this).size;
      },
      enumerable: true, configurable: true,
    },
    set: {
      value: function set(this: Record<string, unknown>, name: unknown, value: unknown): void {
        const { ffv, attr } = ffvSlot(this);
        const nums = Array.isArray(value)
          ? value.map((v) => Number(v))
          : [Number(value)];
        if (nums.some((n) => !Number.isFinite(n))) {
          throw new TypeError("CSSFontFeatureValuesMap.set: value must be a number or a list of numbers");
        }
        ffv.maps[attr]?.set(coerceGuestString(name), nums);
        ffv.reserialize?.();
      },
      writable: true, enumerable: true, configurable: true,
    },
    get: {
      value: function get(this: Record<string, unknown>, name: unknown): unknown {
        return ffvMapOf(this).get(coerceGuestString(name));
      },
      writable: true, enumerable: true, configurable: true,
    },
    has: {
      value: function has(this: Record<string, unknown>, name: unknown): boolean {
        return ffvMapOf(this).has(coerceGuestString(name));
      },
      writable: true, enumerable: true, configurable: true,
    },
    delete: {
      value: function (this: Record<string, unknown>, name: unknown): void {
        const { ffv, attr } = ffvSlot(this);
        ffv.maps[attr]?.delete(coerceGuestString(name));
        ffv.reserialize?.();
      },
      writable: true, enumerable: true, configurable: true,
    },
    clear: {
      value: function clear(this: Record<string, unknown>): void {
        const { ffv, attr } = ffvSlot(this);
        ffv.maps[attr]?.clear();
        ffv.reserialize?.();
      },
      writable: true, enumerable: true, configurable: true,
    },
    forEach: {
      value: function forEach(this: Record<string, unknown>, cb: unknown, thisArg?: unknown): void {
        const fn = cb as (v: number[], k: string, m: object) => void;
        for (const [k, v] of ffvMapOf(this)) fn.call(thisArg, v, k, this);
      },
      writable: true, enumerable: true, configurable: true,
    },
  });

  const ffvMapAccessor = (attr: string): PropertyDescriptor => ({
    get: function (this: Record<string, unknown>): unknown {
      const slot = `_ffvMap_${attr}`;
      if (this[slot] === undefined) {
        const ffv = slotCheck(this, "_ffv") as FfvData;
        const o: Record<string, unknown> = { _ffvMap: { ffv, attr } };
        Object.setPrototypeOf(o, CSSFontFeatureValuesMapCtor.prototype as object);
        this[slot] = o;
      }
      return this[slot];
    },
    enumerable: true, configurable: true,
  });

  Object.defineProperties(CSSFontFeatureValuesRuleCtor.prototype as object, {
    fontFamily: {
      get: function (this: Record<string, unknown>): unknown {
        return (slotCheck(this, "_ffv") as FfvData).fontFamily;
      },
      set: function (this: Record<string, unknown>, v: unknown): void {
        const ffv = slotCheck(this, "_ffv") as FfvData;
        ffv.fontFamily = coerceGuestString(v);
        ffv.reserialize?.();
      },
      enumerable: true, configurable: true,
    },
    ...Object.fromEntries(FFV_ATTRS.map(([attr]) => [attr, ffvMapAccessor(attr)])),
  });

  // ── CSSOM sheet interfaces ────────────────────────────────────────────
  function MediaListCtor(): never {
    throw new Error("Illegal constructor");
  }

  // MediaList (CSSOM §5.2): comma-separated medium list with item/append/
  // delete. `onChange` lets owning rules reserialize their cssText when the
  // list is mutated through mediaText/appendMedium/deleteMedium.
  const makeMediaList = (initial: string, onChange?: () => void): Record<string, unknown> => {
    let mediaText = initial;
    const changed = (): void => {
      if (onChange !== undefined) onChange();
    };
    const items = (): string[] =>
      mediaText.trim() === "" ? [] : mediaText.split(",").map((s) => s.trim()).filter((s) => s !== "");
    const list: Record<string, unknown> = {};
    Object.defineProperties(list, {
      mediaText: {
        get: () => mediaText,
        set: (v: unknown) => {
          mediaText = coerceGuestString(v);
          changed();
        },
        enumerable: true,
        configurable: true,
      },
      length: { get: () => items().length, enumerable: true, configurable: true },
      item: {
        value: (i: unknown) => items()[Math.trunc(Number(i))] ?? null,
        writable: true, enumerable: true, configurable: true,
      },
      appendMedium: {
        value: (m: unknown) => {
          const medium = coerceGuestString(m);
          const cur = items();
          if (!cur.includes(medium)) {
            mediaText = [...cur, medium].join(", ");
            changed();
          }
        },
        writable: true, enumerable: true, configurable: true,
      },
      deleteMedium: {
        value: (m: unknown) => {
          const medium = coerceGuestString(m);
          const cur = items();
          if (!cur.includes(medium)) throw new Error(`NotFoundError: medium "${medium}" not in list`);
          mediaText = cur.filter((s) => s !== medium).join(", ");
          changed();
        },
        writable: true, enumerable: true, configurable: true,
      },
      [Symbol.toStringTag]: { value: "MediaList", configurable: true },
      toString: { value: () => mediaText, writable: true, enumerable: true, configurable: true },
    });
    Object.setPrototypeOf(list, MediaListCtor.prototype as object);
    return list;
  };

  // CSSRule type constants (CSSOM §5.1) — own + prototype per WebIDL legacy.
  const CSS_RULE_CONSTANTS: Record<string, number> = {
    STYLE_RULE: 1, CHARSET_RULE: 2, IMPORT_RULE: 3, MEDIA_RULE: 4,
    FONT_FACE_RULE: 5, PAGE_RULE: 6, KEYFRAMES_RULE: 7, KEYFRAME_RULE: 8,
    MARGIN_RULE: 9, NAMESPACE_RULE: 10, COUNTER_STYLE_RULE: 11,
    SUPPORTS_RULE: 12, FONT_FEATURE_VALUES_RULE: 14, VIEWPORT_RULE: 15,
  };
  Object.assign(CSSRuleCtor, CSS_RULE_CONSTANTS);
  Object.assign(CSSRuleCtor.prototype, CSS_RULE_CONSTANTS);

  // Constructed/adopted stylesheets: detached sheets keep their own rule text
  // in `_text`; mutations notify so adopted sheets re-seed the cascade input.
  let adoptedSheets: Record<string, unknown>[] = [];
  const syncAdoptedSheets = (): void => {
    session.setAdoptedSheets(
      adoptedSheets
        .filter((s) => s["_disabled"] !== true)
        .map((s) => String((s["_cssText"] as () => string)())),
    );
    mutations += 1;
  };
  const adoptedSheetMutated = (sheet: Record<string, unknown>): void => {
    if (adoptedSheets.includes(sheet)) syncAdoptedSheets();
    for (const [rootId, list] of shadowAdopted) {
      if (list.includes(sheet)) syncShadowAdopted(rootId);
    }
  };

  function StyleSheetCtor(): never {
    throw new Error("Illegal constructor");
  }
  /**
   * Freeze `url()` references in a stylesheet text against the sheet's base
   * URL (CSSOM §6.4.1 — constructed sheets resolve relative urls at parse
   * time; the resolved absolute survives later document-base changes).
   */
  const absolutizeCssUrls = (text: string, base: string): string =>
    text.replace(
      /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s][^)]*?))\s*\)/gi,
      (_m, dq: string | undefined, sq: string | undefined, bare: string | undefined) => {
        const raw = (dq ?? sq ?? bare ?? "").trim();
        if (raw === "" || /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|#)/.test(raw)) return `url("${raw}")`;
        try {
          return `url("${new HostURL(raw, base).href}")`;
        } catch {
          return `url("${raw}")`;
        }
      },
    );

  const constructSheet = (options: unknown, ownerDoc: object): object => {
    const opts = (options ?? {}) as Record<string, unknown>;
    // CSSStyleSheetInit.baseURL — "must be a valid URL"; resolved against the
    // constructor document's base URL, defaulting to it when absent.
    let baseURL = session.baseUrl;
    if (opts["baseURL"] !== undefined) {
      try {
        baseURL = new HostURL(cssomString(opts["baseURL"]), session.baseUrl).href;
      } catch {
        throw new DOMException("CSSStyleSheet: invalid baseURL", "NotAllowedError");
      }
    }
    const self: Record<string, unknown> = {
      _text: "",
      _constructed: true,
      _baseURL: baseURL,
      _ownerDoc: ownerDoc,
      _disabled: opts["disabled"] === true,
      _media: makeMediaList(typeof opts["media"] === "string" ? opts["media"] : ""),
    };
    Object.setPrototypeOf(self, CSSStyleSheetCtor.prototype as object);
    self["_host"] = makeRuleHost(
      () => self["_text"] as string,
      (text) => {
        self["_text"] = absolutizeCssUrls(text, self["_baseURL"] as string);
        adoptedSheetMutated(self);
      },
      () => self,
      { disallowImport: true },
    );
    self["_cssText"] = () => self["_text"] as string;
    return self;
  };
  function CSSStyleSheetCtor(this: unknown, options?: unknown): object {
    // Sheets remember their constructor document — adopting a sheet into a
    // DIFFERENT document's adoptedStyleSheets throws NotAllowedError.
    return constructSheet(options, document);
  }
  Object.defineProperty(CSSStyleSheetCtor, "name", { value: "CSSStyleSheet" });
  Object.setPrototypeOf(CSSStyleSheetCtor, StyleSheetCtor);
  Object.setPrototypeOf(CSSStyleSheetCtor.prototype as object, StyleSheetCtor.prototype as object);
  Object.defineProperty(CSSStyleSheetCtor.prototype, "constructor", {
    value: CSSStyleSheetCtor, writable: true, enumerable: false, configurable: true,
  });
  const sheetAccessor = (
    attr: string,
    get: (o: Record<string, unknown>) => unknown,
  ): PropertyDescriptor => {
    const getter = function (this: Record<string, unknown>): unknown {
      if (this["_host"] === undefined && this["_sheetKind"] === undefined) {
        throw new TypeError("Illegal invocation");
      }
      return get(this);
    };
    Object.defineProperty(getter, "name", { value: `get ${attr}` });
    return { get: getter, enumerable: true, configurable: true };
  };
  const sheetMethod = (fn: (o: Record<string, unknown>, ...args: unknown[]) => unknown): PropertyDescriptor => ({
    value: function (this: Record<string, unknown>, ...args: unknown[]): unknown {
      if (this["_host"] === undefined && this["_sheetKind"] === undefined) {
        throw new TypeError("Illegal invocation");
      }
      return fn(this, ...args);
    },
    writable: true, enumerable: true, configurable: true,
  });
  Object.defineProperties(StyleSheetCtor.prototype as object, {
    type: sheetAccessor("type", () => "text/css"),
    href: sheetAccessor("href", () => null),
    ownerNode: sheetAccessor("ownerNode", (o) => o["_ownerNode"] ?? null),
    parentStyleSheet: sheetAccessor("parentStyleSheet", () => null),
    title: sheetAccessor("title", (o) => o["_title"] ?? null),
    media: {
      get: function (this: Record<string, unknown>): unknown {
        if (this["_host"] === undefined && this["_sheetKind"] === undefined) {
          throw new TypeError("Illegal invocation");
        }
        return this["_media"];
      },
      set: function (this: Record<string, unknown>, v: unknown): void {
        if (this["_host"] === undefined && this["_sheetKind"] === undefined) {
          throw new TypeError("Illegal invocation");
        }
        const list = this["_media"] as Record<string, unknown> | undefined;
        if (list !== undefined) list["mediaText"] = coerceGuestString(v);
      },
      enumerable: true,
      configurable: true,
    },
    disabled: {
      get: function (this: Record<string, unknown>): unknown {
        return this["_disabled"] === true;
      },
      set: function (this: Record<string, unknown>, v: unknown): void {
        this["_disabled"] = v === true;
        adoptedSheetMutated(this);
      },
      enumerable: true, configurable: true,
    },
  });
  Object.defineProperties(CSSStyleSheetCtor.prototype as object, {
    ownerRule: sheetAccessor("ownerRule", () => null),
    cssRules: sheetAccessor("cssRules", (o) => (o["_host"] as ReturnType<typeof makeRuleHost>).cssRules),
    rules: sheetAccessor("rules", (o) => (o["_host"] as ReturnType<typeof makeRuleHost>).cssRules),
    insertRule: sheetMethod((o, cssText, index) =>
      (o["_host"] as ReturnType<typeof makeRuleHost>).insertRule(
        absolutizeCssUrls(coerceGuestString(cssText), o["_baseURL"] as string ?? session.baseUrl),
        index,
      )),
    deleteRule: sheetMethod((o, index) =>
      (o["_host"] as ReturnType<typeof makeRuleHost>).deleteRule(index)),
    replaceSync: sheetMethod((o, text) => {
      o["_text"] = absolutizeCssUrls(coerceGuestString(text), o["_baseURL"] as string ?? session.baseUrl);
      adoptedSheetMutated(o);
      return undefined;
    }),
    replace: sheetMethod((o, text) => {
      o["_text"] = absolutizeCssUrls(coerceGuestString(text), o["_baseURL"] as string ?? session.baseUrl);
      adoptedSheetMutated(o);
      return Promise.resolve(o);
    }),
  });

  // Typed OM partials: Element.computedStyleMap(), and the
  // ElementCSSInlineStyle mixin's attributeStyleMap on the host interfaces.
  const elementId = (o: unknown): NodeId => {
    const id = idFromWrapper(o);
    if (id === undefined) throw new TypeError("Illegal invocation");
    return id;
  };
  Object.defineProperty(ElementCtor.prototype as object, "computedStyleMap", {
    value: function computedStyleMap(this: unknown): object {
      return computedStyleMapForNode(elementId(this));
    },
    writable: true,
    enumerable: true,
    configurable: true,
  });
  const attributeStyleMapGet = function attributeStyleMap(this: unknown): object {
    return attributeStyleMapForNode(elementId(this));
  };
  Object.defineProperty(attributeStyleMapGet, "name", { value: "get attributeStyleMap" });
  for (const ctor of [HTMLElementCtor, SVGElementCtor, MathMLElementCtor]) {
    Object.defineProperty(ctor.prototype as object, "attributeStyleMap", {
      get: attributeStyleMapGet,
      enumerable: true,
      configurable: true,
    });
  }

  function DocumentCtor(): never {
    throw new Error("Illegal constructor");
  }
  Object.setPrototypeOf(DocumentCtor.prototype as object, NodeCtor.prototype as object);
  function DocumentFragmentCtor(): never {
    throw new Error("Illegal constructor");
  }
  Object.setPrototypeOf(DocumentFragmentCtor.prototype as object, NodeCtor.prototype as object);

  /** `window.getComputedStyle(el)` — a read-only CSSOM declaration over the
   * node's resolved {@link ComputedStyle} (the cascade product). */
  // `getComputedStyle` enumerates only properties that can produce a computed
  // value — `all`/`font` are shorthand stubs (initial `""`, no computed field)
  // and must not appear in the enumeration (matching real CSSOM behavior,
  // and keeping `[...getComputedStyle(el)]` consistent with computedStyleMap).
  const computedPropertyNames = CSS_PROPERTIES.filter((p) => p.initial !== "").map((p) => p.name);
  let gcsMutEpoch = -1;
  const gcsProxyCache = new Map<string, object>();
  const gcsValueCache = new Map<string, Record<string, unknown>>();
  const gcsSerializedCache = new Map<string, Map<string, string>>();

  const FAST_GCS_DEFAULTS: Record<string, string> = {
    display: "block",
    visibility: "visible",
    position: "static",
    opacity: "1",
    overflow: "visible",
    "overflow-x": "visible",
    "overflow-y": "visible",
    width: "auto",
    height: "auto",
    "max-width": "none",
    "max-height": "none",
    "min-width": "0px",
    "min-height": "0px",
    margin: "0px",
    "margin-top": "0px",
    "margin-right": "0px",
    "margin-bottom": "0px",
    "margin-left": "0px",
    padding: "0px",
    "padding-top": "0px",
    "padding-right": "0px",
    "padding-bottom": "0px",
    "padding-left": "0px",
    border: "0px none rgb(0, 0, 0)",
    "border-top-width": "0px",
    "border-right-width": "0px",
    "border-bottom-width": "0px",
    "border-left-width": "0px",
    "border-top-style": "none",
    "border-right-style": "none",
    "border-bottom-style": "none",
    "border-left-style": "none",
    "box-sizing": "content-box",
    float: "none",
    clear: "none",
    "z-index": "auto",
    "font-size": "16px",
    "font-weight": "400",
    "line-height": "normal",
    color: "rgb(0, 0, 0)",
    "background-color": "rgba(0, 0, 0, 0)",
    "pointer-events": "auto",
    "white-space": "normal",
    "text-align": "start",
    "vertical-align": "baseline",
    transform: "none",
    "transform-origin": "50% 50% 0px",
    transition: "all 0s ease 0s",
    animation: "none",
    flex: "0 1 auto",
    "flex-direction": "row",
    "flex-wrap": "nowrap",
    "justify-content": "flex-start",
    "align-items": "stretch",
    "align-self": "auto",
    gap: "normal",
    "grid-template-columns": "none",
    "grid-template-rows": "none",
  };
  let fastGcsShared: object | null = null;

  /**
   * Parse a `getComputedStyle` pseudo-element argument: `::?ident` with CSS
   * escape decoding, consuming to the END of the string — anything else
   * (trailing whitespace, punctuation, a lone `\`) is malformed → `null`.
   */
  const parsePseudoIdent = (s: string): string | null => {
    const m = /^(::?)/.exec(s);
    if (m === null) return null;
    const rest = s.slice((m[1] as string).length);
    let name = "";
    let i = 0;
    while (i < rest.length) {
      const c = rest[i] as string;
      if (c === "\\") {
        let j = i + 1;
        let hex = "";
        while (j < rest.length && hex.length < 6 && /[0-9a-fA-F]/.test(rest[j] as string)) {
          hex += rest[j];
          j += 1;
        }
        if (hex !== "") {
          name += String.fromCodePoint(parseInt(hex, 16));
          if (rest[j] !== undefined && /\s/.test(rest[j] as string)) j += 1;
          i = j;
          continue;
        }
        if (j < rest.length) {
          name += rest[j];
          i = j + 1;
          continue;
        }
        return null;
      }
      if (/[\w-]/.test(c) || c.charCodeAt(0) >= 0x80) {
        name += c;
        i += 1;
        continue;
      }
      return null;
    }
    return name === "" ? null : name.toLowerCase();
  };

  function getComputedStyle(el: unknown, pseudoElt?: unknown): object {
    gCsCalls += 1;
    const id = idFromWrapper(el);
    // Pseudo-element argument (CSSOM §dom-window-getcomputedstyle): absent,
    // empty, or non-`:`-prefixed → the element's own style; a well-formed
    // `::?ident` selects a pseudo-element; malformed or unknown pseudo names
    // produce an EMPTY immutable declaration.
    let pseudoName: string | null = null;
    let pseudoEmpty = false;
    if (pseudoElt !== undefined && pseudoElt !== null) {
      const s = cssomString(pseudoElt);
      if (s.startsWith(":")) {
        const parsed = parsePseudoIdent(s);
        const elNode = id !== undefined ? session.dom.nodes.get(id) : undefined;
        const isFileInput =
          elNode?.kind === "element" &&
          elNode.tag === "input" &&
          (elNode.attrs?.get("type") ?? "").toLowerCase() === "file";
        if (parsed === null) {
          pseudoEmpty = true;
        } else if (
          parsed === "before" || parsed === "after" ||
          (parsed === "file-selector-button" && isFileInput)
        ) {
          pseudoName = parsed;
        } else {
          pseudoEmpty = true;
        }
      }
    }
    const cacheKey = `${id ?? "x"}\0${pseudoEmpty ? "?" : (pseudoName ?? "")}`;
    if (styleMode === "fast") {
      if (fastGcsShared === null) {
        const resolveFast = (cssName: string): string => FAST_GCS_DEFAULTS[cssName] ?? "";
        const decl: Record<string, unknown> = {
          length: computedPropertyNames.length,
          item: (index: unknown): string => {
            const n = Number(index);
            if (!Number.isInteger(n) || n < 0) return "";
            return computedPropertyNames[n] ?? "";
          },
          getPropertyValue: (name: unknown): string => resolveFast(String(name)),
          getPropertyPriority: (): string => "",
          setProperty: (): void => {},
          removeProperty: (): string => "",
          cssText: "",
          *[Symbol.iterator](): IterableIterator<string> {
            for (const n of computedPropertyNames) yield n;
          },
        };
        fastGcsShared = new Proxy(decl, {
          get(target, prop, receiver): unknown {
            if (typeof prop === "string") {
              if (isCssomArrayIndex(prop)) return (decl["item"] as (index: unknown) => string)(Number(prop));
              if (prop === "cssFloat") return resolveFast("float");
              const cssName = CSSOM_PROPERTY_ALIAS_TO_NAME.get(prop);
              if (cssName !== undefined) return resolveFast(cssName);
              if (FAST_GCS_DEFAULTS[prop] !== undefined) return FAST_GCS_DEFAULTS[prop];
            }
            return Reflect.get(target, prop, receiver);
          },
          set(): boolean {
            return true;
          },
          has(target, prop): boolean {
            return (
              (typeof prop === "string" &&
                (prop === "cssFloat" ||
                  CSSOM_PROPERTY_ALIAS_TO_NAME.has(prop) ||
                  FAST_GCS_DEFAULTS[prop] !== undefined)) ||
              Reflect.has(target, prop)
            );
          },
        });
      }
      return fastGcsShared;
    }
    if (gcsMutEpoch !== mutations) {
      gcsMutEpoch = mutations;
      gcsProxyCache.clear();
      gcsValueCache.clear();
      gcsSerializedCache.clear();
    }
    if (id !== undefined) {
      const hit = gcsProxyCache.get(cacheKey);
      if (hit !== undefined) return hit;
    }

    // Elements inside a NON-RENDERED iframe document (the iframe element's
    // `display: none` suppresses its browsing context) produce an empty
    // declaration, same as detached nodes.
    const underNonRenderedIframe = (nodeId: NodeId): boolean => {
      let cur: NodeId | null = session.dom.nodes.get(nodeId)?.parent ?? null;
      while (cur !== null) {
        const n = session.dom.nodes.get(cur);
        if (n === undefined) return false;
        if (n.kind === "element" && n.tag === "#iframe-document") {
          const iframeId = n.parent;
          if (iframeId === null) return false;
          const cs = session.computed(iframeId) as Record<string, unknown> | null;
          if (cs === null) return false;
          const meta = CSS_NAME_TO_META.get("display");
          return meta !== undefined && serializeComputed(meta.tsType, cs[meta.field]) === "none";
        }
        cur = n.parent;
      }
      return false;
    };

    // Light-DOM children of a shadow host render only when slotted into the
    // shadow tree (flat-tree §3): find a `<slot>` in the shadow whose `name`
    // matches the child's `slot` attribute (default "" both sides).
    const isSlottedIntoShadow = (lightChildId: NodeId, rootId: NodeId): boolean => {
      const want = session.dom.nodes.get(lightChildId)?.attrs?.get("slot") ?? "";
      const walk = (nid: NodeId): boolean => {
        const n = session.dom.nodes.get(nid);
        if (n === undefined) return false;
        if (n.kind === "element" && n.tag === "slot" && (n.attrs?.get("name") ?? "") === want) return true;
        return n.children.some(walk);
      };
      return walk(rootId);
    };
    const isUnslottedLight = (nodeId: NodeId): boolean => {
      let cur: NodeId | null | undefined = nodeId;
      while (cur !== null && cur !== undefined) {
        const n = session.dom.nodes.get(cur);
        if (n === undefined) return false;
        const parent = n.parent;
        if (parent !== null) {
          const entry = shadowRootIds.get(parent);
          if (entry !== undefined && !isSlottedIntoShadow(cur, entry.rootId)) return true;
        }
        cur = parent;
      }
      return false;
    };

    // Elements outside the flat tree — and unknown/malformed pseudo-element
    // requests — produce an empty declaration block: disconnected nodes have
    // no computed style at all (CSSOM §6.1 — "if the element is not being
    // rendered, return an empty declaration").
    const isDetached = (): boolean =>
      pseudoEmpty ||
      (id !== undefined &&
        (!isConnectedToDocument(session.dom, id, shadowHostResolver) ||
          underNonRenderedIframe(id) ||
          isUnslottedLight(id)));
    const customNames = (): string[] => {
      if (isDetached()) return [];
      const raw = ensureRaw();
      return raw === null ? [] : [...(customPropertiesOf(raw)?.keys() ?? [])];
    };
    const item = (index: unknown): string => {
      const n = Number(index);
      if (!Number.isInteger(n) || n < 0 || isDetached()) return "";
      if (n < computedPropertyNames.length) return computedPropertyNames[n] ?? "";
      return customNames()[n - computedPropertyNames.length] ?? "";
    };

    // A previously-returned proxy must see fresh values after DOM mutations —
    // the epoch check lives in the read path, not only at getComputedStyle
    // call time (a computedStyleMap captured earlier reads through it too).
    const syncEpoch = (): void => {
      if (gcsMutEpoch !== mutations) {
        gcsMutEpoch = mutations;
        gcsProxyCache.clear();
        gcsValueCache.clear();
        gcsSerializedCache.clear();
      }
    };

    const ensureRaw = (): Record<string, unknown> | null => {
      if (id === undefined || pseudoEmpty) return null;
      syncEpoch();
      let raw = gcsValueCache.get(cacheKey);
      if (raw !== undefined) return raw;
      gCsCascade += 1;
      raw = pseudoName === null ? session.computed(id) : session.computedPseudo(id, pseudoName);
      gcsValueCache.set(cacheKey, raw);
      return raw;
    };

    const fieldString = (field: string, tsType: string): string => {
      if (id === undefined) return "";
      syncEpoch();
      let ser = gcsSerializedCache.get(cacheKey);
      if (ser === undefined) {
        ser = new Map();
        gcsSerializedCache.set(cacheKey, ser);
      }
      const cached = ser.get(field);
      if (cached !== undefined) return cached;
      const raw = ensureRaw();
      if (raw === null) return "";
      let out = serializeComputed(tsType, raw[field]);
      if (field === "transform" && out !== "" && out !== "none") {
        const fs = typeof raw["fontSize"] === "number" ? raw["fontSize"] : 16;
        out = resolveTransformUnits(out, fs);
      }
      ser.set(field, out);
      return out;
    };

    const resolveCssName = (cssName: string, resolved = true): string => {
      if (isDetached()) return "";
      if (cssName.startsWith("--")) {
        const raw = ensureRaw();
        return raw === null ? "" : (customPropertiesOf(raw)?.get(cssName) ?? "");
      }
      const shorthandSer = (Object.hasOwn(SHORTHAND_COMPUTED, cssName) ? SHORTHAND_COMPUTED[cssName] : undefined)?.((n) => resolveCssName(n, resolved));
      if (shorthandSer !== undefined) return shorthandSer;
      const meta = CSS_NAME_TO_META.get(cssName);
      if (meta === undefined) return "";
      // CSSOM resolved values: `width`/`height` on an element with a box are
      // the USED content-box size (px), not the computed (possibly %/auto)
      // value. `computedStyleMap` keeps the unresolved computed value — only
      // the CSSStyleDeclaration path resolves through layout here.
      if (resolved && (cssName === "width" || cssName === "height")) {
        const tree = resolveLayoutTree();
        if (tree !== null && id !== undefined) {
          if (pseudoName !== null) {
            // A pseudo-element has no layout fragment: resolve its percentage
            // size against the containing block — the originating element's
            // content box (or the nearest ANCESTOR with a box when the element
            // itself generates none, e.g. display: contents).
            const computed = fieldString(meta.field, meta.tsType);
            const pm = /^([+-]?(?:\d+\.?\d*|\.\d+))%$/.exec(computed.trim());
            if (pm === null) {
              return computed === "" ? computed : canonicalizeCssValueText(computed, cssName);
            }
            let cur: NodeId | undefined = id;
            while (cur !== undefined) {
              // `display: contents`/`none` elements generate no box — their
              // pseudo's containing block is the nearest ancestor WITH one.
              const d = session.computed(cur)["display" as keyof ReturnType<typeof session.computed>];
              if (d !== "contents" && d !== "none") {
                for (const frag of tree.fragments.values()) {
                  if (frag.node === cur) {
                    const box = frag.box.contentBox;
                    const cb = Number(cssName === "width" ? box.width : box.height);
                    const pct = Number(pm[1]);
                    return `${pct * cb / 100}px`;
                  }
                }
              }
              cur = session.dom.nodes.get(cur)?.parent ?? undefined;
            }
            return computed;
          }
          for (const frag of tree.fragments.values()) {
            if (frag.node === id) {
              const box = frag.box.contentBox;
              const px = Number(cssName === "width" ? box.width : box.height);
              return `${px}px`;
            }
          }
        }
      }
      const computed = fieldString(meta.field, meta.tsType);
      // Computed values serialize through the same canonicalization as
      // declaration values (url() quoting, font-family quote rules, number
      // canonicalization) so style.cssText and getComputedStyle agree.
      return computed === "" ? computed : canonicalizeCssValueText(computed, cssName);
    };

    const decl: Record<string, unknown> = {
      get length(): number {
        return isDetached() ? 0 : computedPropertyNames.length + customNames().length;
      },
      item,
      // The optional `resolved` flag is an internal hook for computedStyleMap:
      // Typed OM's computed map exposes the UNRESOLVED computed value (e.g.
      // `50%`), while CSSOM's getComputedStyle exposes resolved used values
      // (`25px`). Extra params are invisible to property enumeration.
      getPropertyValue: (name: unknown, resolved?: unknown): string =>
        resolveCssName(String(name), resolved !== false),
      getPropertyPriority: (): string => "",
      setProperty: (): never => {
        throw new DOMException("getComputedStyle declarations are read-only", "NoModificationAllowedError");
      },
      removeProperty: (): never => {
        throw new DOMException("getComputedStyle declarations are read-only", "NoModificationAllowedError");
      },
      cssText: "",
      // CSSStyleDeclaration enumerates its longhand property names (plus any
      // custom properties) when spread/iterated.
      *[Symbol.iterator](): IterableIterator<string> {
        const total = computedPropertyNames.length + customNames().length;
        for (let i = 0; i < total; i += 1) yield item(i);
      },
    };

    const ownKeys = (): Array<string | symbol> => {
      const keys: Array<string | symbol> = [];
      const seen = new Set<string | symbol>();
      const add = (key: string | symbol): void => {
        if (!seen.has(key)) {
          keys.push(key);
          seen.add(key);
        }
      };
      for (let i = 0; i < computedPropertyNames.length; i += 1) add(String(i));
      for (const alias of CSSOM_PROPERTY_ALIAS_TO_NAME.keys()) add(alias);
      for (const key of Reflect.ownKeys(decl)) add(key);
      return keys;
    };

    const namedDescriptor = (prop: string): PropertyDescriptor | undefined => {
      if (isCssomArrayIndex(prop)) {
        const value = item(Number(prop));
        return value === "" ? undefined : { value, writable: false, enumerable: true, configurable: true };
      }
      const cssName = prop === "cssFloat" ? "float" : CSSOM_PROPERTY_ALIAS_TO_NAME.get(prop);
      if (cssName === undefined) return undefined;
      const value = resolveCssName(cssName);
      return value === "" && cssName !== "float"
        ? { value: "", writable: false, enumerable: true, configurable: true }
        : { value, writable: false, enumerable: true, configurable: true };
    };

    const proxy = new Proxy(decl, {
      get(target, prop, receiver): unknown {
        if (typeof prop === "string" && isCssomArrayIndex(prop)) {
          return item(Number(prop));
        }
        if (prop === "cssFloat") return resolveCssName("float");
        const cssName = typeof prop === "string" ? CSSOM_PROPERTY_ALIAS_TO_NAME.get(prop) : undefined;
        if (cssName !== undefined) return resolveCssName(cssName);
        return Reflect.get(target, prop, receiver);
      },
      set(target, prop, value, receiver): boolean {
        if (typeof prop === "string" && (prop === "cssText" || prop === "cssFloat" || CSSOM_PROPERTY_ALIAS_TO_NAME.has(prop))) {
          throw new DOMException("getComputedStyle declarations are read-only", "NoModificationAllowedError");
        }
        return Reflect.set(target, prop, value, receiver);
      },
      has(target, prop): boolean {
        if (typeof prop === "string" && isCssomArrayIndex(prop)) {
          return item(Number(prop)) !== "";
        }
        return (
          (typeof prop === "string" && (prop === "cssFloat" || CSSOM_PROPERTY_ALIAS_TO_NAME.has(prop))) ||
          Reflect.has(target, prop)
        );
      },
      ownKeys,
      getOwnPropertyDescriptor(target, prop): PropertyDescriptor | undefined {
        if (typeof prop === "string") {
          const descriptor = namedDescriptor(prop);
          if (descriptor !== undefined) return descriptor;
        }
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
    });

    if (id !== undefined) gcsProxyCache.set(cacheKey, proxy);
    return proxy;
  }

  const documentListeners = new Map<string, Set<(...args: unknown[]) => void>>();

  /** The focused element (HTML §6.5 — document.activeElement target). */
  let focusedNodeId: NodeId | null = null;

  /** Per-element scroll offset storage (scrollLeft/scrollTop). */
  const scrollOffsets = new Map<NodeId, { left: number; top: number }>();

  /**
   * Fragments under (x, y) in paint order (deepest/last first match wins in
   * callers). Derived from the layout fragment tree — geometry's single
   * source of truth.
   */
  const fragmentsAt = (x: number, y: number): NodeId[] => {
    let tree;
    try {
      tree = session.layoutTree();
    } catch {
      return [];
    }
    const hits: Array<{ node: NodeId; depth: number; order: number }> = [];
    let order = 0;
    for (const frag of tree.fragments.values()) {
      order += 1;
      const b = frag.box.borderBox;
      const bx = Number(b.x); const by = Number(b.y);
      const bw = Number(b.width); const bh = Number(b.height);
      if (x >= bx && x < bx + bw && y >= by && y < by + bh) {
        let depth = 0;
        let cur: NodeId | null = frag.node;
        while (cur !== null && session.dom.nodes.get(cur) !== undefined) {
          depth += 1;
          cur = session.dom.nodes.get(cur)?.parent ?? null;
        }
        hits.push({ node: frag.node, depth, order });
      }
    }
    // Paint order approximation: deeper boxes above shallower, ties → later
    // in fragment order. Reverse so index 0 = topmost.
    hits.sort((a, b) => (b.depth - a.depth) || (b.order - a.order));
    return hits.map((h) => h.node);
  };

  const document = {
    get nodeType(): number {
      return 9;
    },
    get nodeName(): string {
      return "#document";
    },
    get baseURI(): string {
      return session.baseUrl;
    },
    get styleSheets(): object[] {
      return documentStyleSheetsList();
    },
    // CSSOM §6.4.2 — FrozenArray<CSSStyleSheet>: the same array object is
    // returned until the attribute is set again; adopted sheets feed the
    // cascade (after the document's own sheets) unless disabled.
    get adoptedStyleSheets(): object[] {
      return adoptedSheets;
    },
    set adoptedStyleSheets(value: unknown) {
      if (
        value === null ||
        (typeof value !== "object" && typeof value !== "function") ||
        typeof (value as Iterable<unknown>)[Symbol.iterator] !== "function"
      ) {
        throw new TypeError("adoptedStyleSheets must be a sequence of CSSStyleSheet");
      }
      const list = [...(value as Iterable<unknown>)] as Record<string, unknown>[];
      for (const item of list) {
        if (item === null || (typeof item !== "object" && typeof item !== "function") || item["_cssText"] === undefined) {
          throw new TypeError("adoptedStyleSheets entries must be CSSStyleSheet");
        }
        // CSSOM §6.4.2: only constructed sheets may be adopted — element-backed
        // (non-constructed) sheets throw "NotAllowedError".
        if (item["_constructed"] !== true) {
          throw new DOMException("only constructed stylesheets may be adopted", "NotAllowedError");
        }
        // …and a sheet's document must be THIS document (no cross-tree adopt).
        if (item["_ownerDoc"] !== document) {
          throw new DOMException("stylesheet belongs to a different document", "NotAllowedError");
        }
      }
      adoptedSheets = list;
      syncAdoptedSheets();
    },
    get location(): unknown {
      if (options.locationBox !== undefined && options.locationBox.current !== null) {
        return options.locationBox.current;
      }
      // Standalone callers: minimal Location-shaped parse of the session URL.
      try {
        const u = new HostURL(session.url);
        return {
          href: u.href,
          protocol: u.protocol,
          host: u.host,
          hostname: u.hostname,
          port: u.port,
          pathname: u.pathname,
          search: u.search,
          hash: u.hash,
          origin: u.origin,
          toString: () => u.href,
        };
      } catch {
        return null;
      }
    },
    get URL(): string {
      return session.url;
    },
    get documentURI(): string {
      return session.url;
    },
    get domain(): string {
      try {
        return new URL(session.url).hostname;
      } catch {
        return "";
      }
    },
    set domain(_v: unknown) {},
    get referrer(): string {
      return "";
    },
    get title(): string {
      for (const [id, n] of session.dom.nodes) {
        if (n.kind === "element" && n.tag === "title") {
          return textContentOf(session.dom, id).trim();
        }
      }
      return "";
    },
    set title(value: unknown) {
      for (const [id, n] of session.dom.nodes) {
        if (n.kind === "element" && n.tag === "title") {
          replaceTextContent(session, id, coerceGuestString(value));
          mutations += 1;
          return;
        }
      }
    },
    get characterSet(): string {
      return "UTF-8";
    },
    get charset(): string {
      return "UTF-8";
    },
    get compatMode(): string {
      return "CSS1Compat";
    },
    get contentType(): string {
      return "text/html";
    },
    get documentElement(): object | null {
      for (const child of session.dom.nodes.get(session.dom.root)?.children ?? []) {
        const n = session.dom.nodes.get(child);
        if (n?.kind === "element" && n.tag === "html") return makeElementCached(child);
      }
      return wrap(session.dom.root);
    },
    get head(): object | null {
      for (const [id, n] of session.dom.nodes) {
        if (n.kind === "element" && n.tag === "head") return makeElementCached(id);
      }
      return null;
    },
    get body(): object | null {
      for (const [id, n] of session.dom.nodes) {
        if (n.kind === "element" && n.tag === "body") return makeElementCached(id);
      }
      return null;
    },
    get scripts(): object {
      return makeLiveCollection(() => elementIdsByTagName(session.dom.root, "script"));
    },
    /**
     * HTML §4.2.5 `document.write` — insert parsed HTML at the PARSER'S
     * INSERTION POINT: right after the currently executing <script> element
     * (the spec's "insertion point" while the parser runs; after parsing it
     * does nothing per spec, but we accept it anyway — browsers do).
     */
    write(...args: unknown[]): void {
      const html = args.map((a) => coerceGuestString(a)).join("");
      if (html === "") return;
      const scriptId = options.currentScriptBox?.current ?? null;
      if (scriptId !== null) {
        insertHtmlAfterNode(scriptId, html);
      } else {
        // No executing script: append to the body (the graceful post-parse
        // behavior real browsers show for late document.write).
        const body = [...session.dom.nodes.values()].find(
          (n) => n.kind === "element" && n.tag === "body",
        );
        if (body !== undefined) {
          insertHtmlIntoParent(body.id, html);
        }
      }
      mutations += 1;
    },
    /** `document.writeln(html)` — write + a trailing newline. */
    writeln(...args: unknown[]): void {
      document.write(...args, "\n");
    },
    /** HTML §4.2.5 `document.open()` — a no-op that "re-opens" the stream. */
    open(): void {},
    /** HTML §4.2.5 `document.close()` — a no-op that closes the stream. */
    close(): void {},
    get currentScript(): object | null {
      const id = options.currentScriptBox?.current ?? null;
      return id !== null ? makeElementCached(id) : null;
    },
    // ---- Focus (UI Events §focus) -----------------------------------------
    // The focused element lives in a slot; focus() sets it and dispatches
    // focus/focusin (blur/focusout on the previous). `activeElement` reads it.
    get activeElement(): object | null {
      if (focusedNodeId === null) {
        const body = (document as { body?: object | null }).body;
        return body ?? null;
      }
      const n = session.dom.nodes.get(focusedNodeId);
      if (n === undefined || n.kind !== "element" || !isConnectedToDocument(session.dom, focusedNodeId, shadowHostResolver)) {
        return (document as { body?: object | null }).body ?? null;
      }
      return makeElementCached(focusedNodeId);
    },
    get hasFocus(): () => boolean {
      return () => focusedNodeId !== null;
    },
    /**
     * `document.elementFromPoint(x, y)` — hit-test the layout fragment tree:
     * the deepest box whose border box contains the point wins (ties → later
     * tree order ≈ paint order). Geometry's single source of truth does the
     * work; no separate hit-test bookkeeping.
     */
    elementFromPoint(x: unknown, y: unknown): object | null {
      const hits = fragmentsAt(Number(x), Number(y));
      return hits.length === 0 ? null : makeElementCached(hits[0] as NodeId);
    },
    elementsFromPoint(x: unknown, y: unknown): object[] {
      return fragmentsAt(Number(x), Number(y)).map((id) => makeElementCached(id));
    },
    get cookie(): string {
      return cookieJar;
    },
    set cookie(v: unknown) {
      const raw = coerceGuestString(v);
      const semi = raw.indexOf(";");
      const pair = semi >= 0 ? raw.slice(0, semi) : raw;
      const eq = pair.indexOf("=");
      if (eq <= 0) return;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (name === "") return;
      const parts = cookieJar.length > 0 ? cookieJar.split("; ") : [];
      const next: string[] = [];
      let replaced = false;
      for (const part of parts) {
        const i = part.indexOf("=");
        const n = i >= 0 ? part.slice(0, i) : part;
        if (n === name) {
          if (!/;\s*max-age=0/i.test(raw) && !/;\s*expires=Thu, 01 Jan 1970/i.test(raw)) {
            next.push(`${name}=${value}`);
          }
          replaced = true;
        } else if (part !== "") {
          next.push(part);
        }
      }
      if (!replaced && !/;\s*max-age=0/i.test(raw) && !/;\s*expires=Thu, 01 Jan 1970/i.test(raw)) {
        next.push(`${name}=${value}`);
      }
      cookieJar = next.join("; ");
    },
    get readyState(): string {
      return options.readyStateBox?.current ?? "complete";
    },
    get visibilityState(): string {
      return "visible";
    },
    get hidden(): boolean {
      return false;
    },
    addEventListener(type: unknown, fn: unknown): void {
      if (typeof fn !== "function") return;
      const key = String(type);
      let set = documentListeners.get(key);
      if (set === undefined) {
        set = new Set();
        documentListeners.set(key, set);
      }
      set.add(fn as (...args: unknown[]) => void);
    },
    removeEventListener(type: unknown, fn: unknown): void {
      const set = documentListeners.get(String(type));
      if (set === undefined || typeof fn !== "function") return;
      set.delete(fn as (...args: unknown[]) => void);
    },
    dispatchEvent(event: unknown): boolean {
      const type =
        event !== null && typeof event === "object" && "type" in event
          ? coerceGuestString(event.type)
          : coerceGuestString(event);
      const set = documentListeners.get(type);
      if (set === undefined) return true;
      for (const fn of set) {
        try {
          fn(event);
        } catch (error) {
          // HTML: a listener exception is reported as uncaught; the
          // remaining listeners still run.
          if (options.onListenerError !== undefined) options.onListenerError(error);
        }
      }
      return true;
    },
    getElementById(id: unknown): object | null {
      return wrap(findByIdIndexed(String(id)));
    },
    querySelector(selector: unknown): object | null {
      const ids = queryAll(String(selector), null);
      return ids.length > 0 ? makeElementCached(ids[0] as NodeId) : null;
    },
    querySelectorAll(selector: unknown): object {
      // Static NodeList: evaluated once at call time (DOM §8.2.3).
      const snapshot = queryAll(String(selector), null);
      return makeNodeList(() => snapshot);
    },
    getElementsByTagName(tag: unknown): object {
      const want = coerceGuestString(tag).toLowerCase();
      return makeLiveCollection(() => elementIdsByTagName(session.dom.root, want));
    },
    getElementsByTagNameNS(_ns: unknown, localName: unknown): object {
      // Namespaces are not modeled yet (every element is HTML), so only the
      // local name filters; "*" matches everything like the spec requires.
      const local = coerceGuestString(localName).toLowerCase();
      return makeLiveCollection(() => elementIdsByTagName(session.dom.root, local === "*" ? "*" : local));
    },
    getElementsByClassName(names: unknown): object {
      const tokens = coerceGuestString(names).trim().split(/\s+/).filter((t) => t.length > 0);
      return makeLiveCollection(() => elementIdsByClassName(session.dom.root, tokens));
    },
    createElement(tag: unknown): object {
      const id = session.createElement(String(tag));
      mutations += 1;
      return makeElementCached(id);
    },
    createElementNS(_ns: unknown, tag: unknown): object {
      const raw = String(tag);
      const local = raw.includes(":") ? (raw.split(":").pop() ?? raw) : raw;
      const id = session.createElement(local);
      mutations += 1;
      return makeElementCached(id);
    },
    createDocumentFragment(): object {
      const id = session.createElement("template");
      mutations += 1;
      return makeElementCached(id);
    },
    createTextNode(text: unknown): object {
      const id = session.createTextNode(String(text));
      mutations += 1;
      return makeElementCached(id);
    },
    createComment(text: unknown): object {
      const id = session.createComment(String(text));
      mutations += 1;
      return makeElementCached(id);
    },
    // DOM §4.6 `adoptNode` — detach from the old parent; adopting a node that
    // lived in an iframe document empties its shadow roots' adoptedStyleSheets.
    adoptNode(node: unknown): object {
      const nodeId = idFromWrapper(node);
      if (nodeId === undefined) throw new TypeError("adoptNode requires a Node");
      if (docScopeOfNode(nodeId) !== null) {
        for (const [hostId, entry] of shadowRootIds) {
          if (containsNode(session.dom, nodeId, hostId)) {
            shadowAdopted.delete(entry.rootId);
            syncShadowAdopted(entry.rootId);
          }
        }
      }
      const parent = session.dom.nodes.get(nodeId)?.parent ?? null;
      if (parent !== null) session.removeChild(parent, nodeId);
      mutations += 1;
      return node as object;
    },
    // DOM §4.6 `importNode` — clone into this document; the shadow root (and
    // its adoptedStyleSheets) are NOT copied.
    importNode(node: unknown, deep?: unknown): object {
      const nodeId = idFromWrapper(node);
      if (nodeId === undefined) throw new TypeError("importNode requires a Node");
      const cloneId = cloneSubtree(nodeId, deep !== false);
      if (cloneId === null) throw new DOMException("cannot import this node", "NotSupportedError");
      mutations += 1;
      return makeElementCached(cloneId);
    },
    createEvent(eventType: unknown): object {
      // Real event instances so initEvent/initCustomEvent and dispatch share
      // one implementation with guest-constructed events. Legacy createEvent
      // yields an UNINITIALIZED event: empty type until initEvent runs.
      const kind = coerceGuestString(eventType);
      if (kind === "CustomEvent") return new CustomEvent("");
      if (kind === "MouseEvent" || kind === "MouseEvents") return new MouseEvent("");
      return new Event("");
    },
    createEventObject(): { data: unknown; type: string } {
      return { data: undefined, type: "" };
    },
    fireEvent(type: unknown, event?: unknown): boolean {
      const ev =
        event !== null && typeof event === "object"
          ? { ...(event), type: coerceGuestString(type).replace(/^on/, "") }
          : { type: coerceGuestString(type).replace(/^on/, "") };
      return document.dispatchEvent(ev);
    },
    hasChildNodes(): boolean {
      return (session.dom.nodes.get(session.dom.root)?.children.length ?? 0) > 0;
    },
    compareDocumentPosition(other: unknown): number {
      const otherId = idFromWrapper(other);
      if (otherId === undefined) throw new TypeError("compareDocumentPosition requires a Node");
      return compareNodeDocumentPosition(session.dom.root, otherId);
    },
    ...NODE_DOCUMENT_POSITION_CONSTANTS,
  };
  idOf.set(document, session.dom.root);
  documentRef = document;

  Object.setPrototypeOf(document, DocumentCtor.prototype as object);
  const HTMLCanvasElementCtor = function HTMLCanvasElement() {} as unknown as new () => object;

  /**
   * The HTML element interface map (HTML §4.13): every tag with a distinct
   * DOM interface gets its own constructor whose prototype chains to
   * HTMLElement.prototype, so `instanceof HTMLAnchorElement` works and
   * `new HTMLAnchorElement()` creates the matching element. This is the real
   * platform surface — bundles feature-check these constructors constantly.
   */
  const HTML_INTERFACE_TAGS: ReadonlyArray<readonly [string, string]> = [
    ["HTMLAnchorElement", "a"],
    ["HTMLAreaElement", "area"],
    ["HTMLAudioElement", "audio"],
    ["HTMLBaseElement", "base"],
    ["HTMLBodyElement", "body"],
    ["HTMLBRElement", "br"],
    ["HTMLButtonElement", "button"],
    ["HTMLCanvasElement", "canvas"],
    ["HTMLDataElement", "data"],
    ["HTMLDataListElement", "datalist"],
    ["HTMLDetailsElement", "details"],
    ["HTMLDialogElement", "dialog"],
    ["HTMLDivElement", "div"],
    ["HTMLDListElement", "dl"],
    ["HTMLEmbedElement", "embed"],
    ["HTMLFieldSetElement", "fieldset"],
    ["HTMLFormElement", "form"],
    ["HTMLHeadingElement", "h1"],
    ["HTMLHeadElement", "head"],
    ["HTMLHGroupElement", "hgroup"],
    ["HTMLHRElement", "hr"],
    ["HTMLHtmlElement", "html"],
    ["HTMLIFrameElement", "iframe"],
    ["HTMLImageElement", "img"],
    ["HTMLInputElement", "input"],
    ["HTMLLabelElement", "label"],
    ["HTMLLegendElement", "legend"],
    ["HTMLLIElement", "li"],
    ["HTMLLinkElement", "link"],
    ["HTMLMapElement", "map"],
    ["HTMLMenuElement", "menu"],
    ["HTMLMetaElement", "meta"],
    ["HTMLMeterElement", "meter"],
    ["HTMLModElement", "del"],
    ["HTMLObjectElement", "object"],
    ["HTMLOListElement", "ol"],
    ["HTMLOptGroupElement", "optgroup"],
    ["HTMLOptionElement", "option"],
    ["HTMLOutputElement", "output"],
    ["HTMLParagraphElement", "p"],
    ["HTMLParamElement", "param"],
    ["HTMLPictureElement", "picture"],
    ["HTMLPreElement", "pre"],
    ["HTMLProgressElement", "progress"],
    ["HTMLQuoteElement", "blockquote"],
    ["HTMLScriptElement", "script"],
    ["HTMLSelectElement", "select"],
    ["HTMLSlotElement", "slot"],
    ["HTMLSourceElement", "source"],
    ["HTMLSpanElement", "span"],
    ["HTMLStyleElement", "style"],
    ["HTMLTableCaptionElement", "caption"],
    ["HTMLTableCellElement", "td"],
    ["HTMLTableColElement", "col"],
    ["HTMLTableElement", "table"],
    ["HTMLTableRowElement", "tr"],
    ["HTMLTableSectionElement", "tbody"],
    ["HTMLTemplateElement", "template"],
    ["HTMLTextAreaElement", "textarea"],
    ["HTMLTimeElement", "time"],
    ["HTMLTitleElement", "title"],
    ["HTMLTrackElement", "track"],
    ["HTMLUListElement", "ul"],
    ["HTMLVideoElement", "video"],
    ["HTMLUnknownElement", "unknown"],
  ];

  /** name → constructor; also the map used to pick a wrapper's prototype. */
  const htmlInterfaceCtors = new Map<string, { ctor: new () => object; tag: string }>();
  for (const [name, tag] of HTML_INTERFACE_TAGS) {
    if (name === "HTMLCanvasElement") {
      htmlInterfaceCtors.set(name, { ctor: HTMLCanvasElementCtor, tag });
      continue;
    }
    const ctor = function (this: unknown, _w?: unknown, _h?: unknown): void {
      throw new Error("Illegal constructor");
    } as unknown as new () => object;
    Object.setPrototypeOf(ctor.prototype as object, HTMLElementCtor.prototype as object);
    htmlInterfaceCtors.set(name, { ctor, tag });
  }
  /** A wrapper for `tag` gets `ctor.prototype` when the tag has its own interface. */
  const interfaceCtorForTag = (tag: string): object | null => {
    for (const [, { ctor: c, tag: t }] of htmlInterfaceCtors) {
      if (t === tag) return c.prototype as object;
    }
    return null;
  };
  Object.setPrototypeOf(HTMLCanvasElementCtor.prototype, HTMLElementCtor.prototype as object);
  const CanvasRenderingContext2DCtor = function CanvasRenderingContext2D() {} as unknown as new () => object;
  const OffscreenCanvasCtor = function OffscreenCanvas(this: { width: number; height: number; getContext: (t: unknown) => object | null }, w?: unknown, h?: unknown) {
    this.width = Number(w) || 0;
    this.height = Number(h) || 0;
    let cached: object | null = null;
    this.getContext = (type: unknown) => {
      if (coerceGuestString(type).toLowerCase() !== "2d") return null;
      if (cached === null) {
        cached = {
          canvas: this,
          fillStyle: "#000",
          strokeStyle: "#000",
          lineWidth: 1,
          globalAlpha: 1,
          font: "10px sans-serif",
          save() {},
          restore() {},
          beginPath() {},
          closePath() {},
          moveTo() {},
          lineTo() {},
          rect() {},
          fill() {},
          stroke() {},
          clearRect() {},
          fillRect() {},
          strokeRect() {},
          fillText() {},
          strokeText() {},
          measureText(text: unknown) {
            return { width: coerceGuestString(text).length * 6 };
          },
          drawImage() {},
          createImageData(cw: unknown, ch?: unknown) {
            const width = Number(cw) || 0;
            const height = Number(ch) || 0;
            return { width, height, data: new Uint8ClampedArray(Math.max(0, width * height * 4)) };
          },
          getImageData(_x: unknown, _y: unknown, cw: unknown, ch: unknown) {
            const width = Number(cw) || 0;
            const height = Number(ch) || 0;
            return { width, height, data: new Uint8ClampedArray(Math.max(0, width * height * 4)) };
          },
          putImageData() {},
          scale() {},
          rotate() {},
          translate() {},
          setTransform() {},
          resetTransform() {},
          transform() {},
          setLineDash() {},
          getLineDash() {
            return [];
          },
        };
      }
      return cached;
    };
  } as unknown as new (w?: unknown, h?: unknown) => object;

  // ---- MutationObserver (DOM Standard §mutation-observers) ------------------
  // The REAL observer: the session reports every DOM mutation through the
  // listener seam (fine.ts), the controller applies the spec's options filter
  // and batches records per observer, and delivery rides the injected
  // microtask scheduler (the runner's virtual loop, or the realm's real one).
  const observerScheduler = options.observerScheduler ?? ((fn: () => void) => queueMicrotask(fn));
  const mutationObserverController = new MutationObserverController(
    (id) => {
      const parent = session.dom.nodes.get(id as NodeId)?.parent;
      return parent === null || parent === undefined ? null : Number(parent);
    },
    observerScheduler,
  );
  session.setMutationListener((m) => {
    mutationObserverController.queueMutation({
      kind: m.kind,
      target: Number(m.target),
      attributeName: m.attributeName,
      attributeNamespace: null,
      oldValue: m.oldValue ?? null,
      added: m.added?.map(Number),
      removed: m.removed?.map(Number),
      previousSibling: m.previousSibling != null ? Number(m.previousSibling) : null,
      nextSibling: m.nextSibling != null ? Number(m.nextSibling) : null,
    });
  });
  /** Wrap a controller record (NodeId-level) into the guest-facing MutationRecord. */
  const wrapMutationRecord = (record: QueuedRecord): object => {
    const wrapId = (id: number): object => makeElementCached(id as NodeId);
    return {
      type: record.type,
      target: wrapId(record.target),
      addedNodes: makeNodeList(() => record.addedNodes.map((id) => id as NodeId)),
      removedNodes: makeNodeList(() => record.removedNodes.map((id) => id as NodeId)),
      previousSibling: record.previousSibling !== null ? wrapId(record.previousSibling) : null,
      nextSibling: record.nextSibling !== null ? wrapId(record.nextSibling) : null,
      attributeName: record.attributeName,
      attributeNamespace: record.attributeNamespace,
      oldValue: record.oldValue,
    };
  };
  const observerCallbacks = new WeakMap<object, (records: unknown, observer: unknown) => void>();
  const normalizeObserverOptions = (input: unknown): ObserverOptions => {
    if (input === null || typeof input !== "object") return {};
    const o = input as Record<string, unknown>;
    return {
      ...("childList" in o ? { childList: Boolean(o["childList"]) } : {}),
      ...("attributes" in o ? { attributes: Boolean(o["attributes"]) } : {}),
      ...("characterData" in o ? { characterData: Boolean(o["characterData"]) } : {}),
      ...("subtree" in o ? { subtree: Boolean(o["subtree"]) } : {}),
      ...("attributeOldValue" in o ? { attributeOldValue: Boolean(o["attributeOldValue"]) } : {}),
      ...("characterDataOldValue" in o ? { characterDataOldValue: Boolean(o["characterDataOldValue"]) } : {}),
      ...(Array.isArray(o["attributeFilter"])
        ? { attributeFilter: (o["attributeFilter"] as unknown[]).map((v) => String(v)) }
        : {}),
    };
  };
  /**
   * D6 — the composition mutator: the single writer of the session's Shadow
   * composition. The document API owns it (buildDocumentApi wires it to
   * options.compositionControl); attachShadow / slot assignment call into it
   * and the layout queries re-run on the changed composition.
   */
  interface CompositionMutator {
    registerHost(hostId: NodeId, shadowRootId: NodeId): void;
    assignSlot(slotId: NodeId, assigned: readonly NodeId[]): void;
  }

  const compositionMutator: CompositionMutator | null = options.compositionControl ?? null;

  /** Host node → its shadow root (written by attachShadow; read by shadowRoot). */
  const shadowRootIds = new Map<NodeId, { rootId: NodeId; mode: "open" | "closed" }>();

  /**
   * A ShadowRoot wrapper: a DocumentFragment-shaped handle over the shadow
   * tree's root node. Guest code appends INTO it to build shadow content.
   */
  const shadowRootWrappers = new Map<NodeId, object>();
  const makeShadowRoot = (rootId: NodeId, mode: "open" | "closed"): object => {
    const existing = shadowRootWrappers.get(rootId);
    if (existing !== undefined) return existing;
    const frag = makeElementCached(rootId);
    Object.defineProperties(frag, {
      mode: { value: mode, enumerable: true },
      host: { get: () => makeElementCached(nodeIdOfHost(rootId)), enumerable: true },
      // ShadowRoot.getElementById — id lookup scoped to this shadow subtree.
      getElementById: {
        value: (id: unknown): object | null => {
          const wanted = String(id);
          const walk = (nid: NodeId): NodeId | null => {
            const n = session.dom.nodes.get(nid);
            if (n === undefined) return null;
            if (n.kind === "element" && n.attrs?.get("id") === wanted) return nid;
            for (const c of n.children) {
              const hit = walk(c);
              if (hit !== null) return hit;
            }
            return null;
          };
          const hit = walk(rootId);
          return hit === null ? null : makeElementCached(hit);
        },
        writable: true,
        enumerable: true,
        configurable: true,
      },
      // CSSOM §6.4.2 — FrozenArray<CSSStyleSheet> scoped to this shadow tree.
      adoptedStyleSheets: {
        get: (): object[] => shadowAdopted.get(rootId) ?? [],
        set: (value: unknown): void => {
          if (
            value === null ||
            (typeof value !== "object" && typeof value !== "function") ||
            typeof (value as Iterable<unknown>)[Symbol.iterator] !== "function"
          ) {
            throw new TypeError("adoptedStyleSheets must be a sequence of CSSStyleSheet");
          }
          const list = [...(value as Iterable<unknown>)] as Record<string, unknown>[];
          for (const item of list) {
            if (item === null || (typeof item !== "object" && typeof item !== "function") || item["_cssText"] === undefined) {
              throw new TypeError("adoptedStyleSheets entries must be CSSStyleSheet");
            }
            if (item["_constructed"] !== true) {
              throw new DOMException("only constructed stylesheets may be adopted", "NotAllowedError");
            }
          }
          shadowAdopted.set(rootId, list);
          syncShadowAdopted(rootId);
          mutations += 1;
        },
        enumerable: true,
        configurable: true,
      },
    });
    shadowRootWrappers.set(rootId, frag);
    return frag;
  };

  /** Per-shadow-root adopted sheet objects (`shadowRoot.adoptedStyleSheets`). */
  const shadowAdopted = new Map<NodeId, Record<string, unknown>[]>();
  const syncShadowAdopted = (rootId: NodeId): void => {
    session.setShadowAdoptedSheets(
      rootId,
      (shadowAdopted.get(rootId) ?? [])
        .filter((s) => s["_disabled"] !== true)
        .map((s) => String((s["_cssText"] as () => string)())),
    );
    mutations += 1;
  };

  /** Resolve the host element id for a shadow root via the attachShadow map. */
  const nodeIdOfHost = (shadowRootId: NodeId): NodeId => {
    for (const [hostId, entry] of shadowRootIds) {
      if (entry.rootId === shadowRootId) return hostId;
    }
    return shadowRootId;
  };
  /** Connectedness resolver for {@link isConnectedToDocument}: null when the
   * id is not a registered shadow root (otherwise `nodeIdOfHost` echoes it). */
  const shadowHostResolver = (rootId: NodeId): NodeId | null => {
    const h = nodeIdOfHost(rootId);
    return h === rootId ? null : h;
  };

  // ---- iframe nested documents ---------------------------------------------
  // An iframe's `contentDocument` is modeled as a `#iframe-document` SUBTREE of
  // the same session DOM: it hangs off the iframe element, so connectedness,
  // element wrappers, and the kernel stay unified — while `treeScopeOf` treats
  // it as a scope boundary (its styles are its own `<style>`s + own adopted
  // sheets; the outer document's sheets never reach inside).
  /** iframe element id → its nested `#iframe-document` root id. */
  const iframeDocRoots = new Map<NodeId, NodeId>();
  /** `#iframe-document` root id → its document wrapper. */
  const iframeDocWrappers = new Map<NodeId, object>();
  /** `#iframe-document` root id → its `contentWindow` object. */
  const iframeWindowWrappers = new Map<NodeId, object>();

  /** The document OWNING a node: `null` = main document, else the
   * `#iframe-document` root id whose subtree contains it. Shadow trees resolve
   * through their host. */
  const docScopeOfNode = (id: NodeId): NodeId | null => {
    let cur: NodeId | null | undefined = id;
    const seen = new Set<NodeId>();
    while (cur !== null && cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      const n = session.dom.nodes.get(cur);
      if (n === undefined) return null;
      if (n.kind === "element" && n.tag === "#iframe-document") return cur;
      if (n.kind === "element" && n.tag === "#shadow-root") {
        cur = shadowHostResolver(cur);
        continue;
      }
      cur = n.parent;
    }
    return null;
  };

  /** Lazily create the iframe's nested document subtree (srcdoc or about:blank
   * skeleton). Safe to call repeatedly. */
  const ensureIframeDoc = (iframeId: NodeId): NodeId => {
    const existing = iframeDocRoots.get(iframeId);
    if (existing !== undefined) return existing;
    const rootId = session.createElement("#iframe-document");
    session.appendChild(iframeId, rootId);
    iframeDocRoots.set(iframeId, rootId);
    // about:blank skeleton — built explicitly (the fragment parser drops
    // <html>/<head>/<body> as context-only tags).
    const html = session.createElement("html");
    const head = session.createElement("head");
    const body = session.createElement("body");
    session.appendChild(rootId, html);
    session.appendChild(html, head);
    session.appendChild(html, body);
    const srcdoc = session.dom.nodes.get(iframeId)?.attrs?.get("srcdoc");
    if (srcdoc !== undefined && srcdoc !== "") insertHtmlIntoParent(body, srcdoc);
    mutations += 1;
    return rootId;
  };

  /** The `document` object of an iframe's nested browsing context. */
  const makeIframeDocument = (docRootId: NodeId): object => {
    const existing = iframeDocWrappers.get(docRootId);
    if (existing !== undefined) return existing;
    const doc: Record<string, unknown> = {
      nodeType: 9,
      nodeName: "#document",
      get documentElement(): object | null {
        for (const child of session.dom.nodes.get(docRootId)?.children ?? []) {
          const n = session.dom.nodes.get(child);
          if (n?.kind === "element" && n.tag === "html") return makeElementCached(child);
        }
        return null;
      },
      get body(): object | null {
        const walk = (id: NodeId): NodeId | null => {
          const n = session.dom.nodes.get(id);
          if (n === undefined) return null;
          if (n.kind === "element" && n.tag === "body") return id;
          for (const c of n.children) {
            const hit = walk(c);
            if (hit !== null) return hit;
          }
          return null;
        };
        const id = walk(docRootId);
        return id === null ? null : makeElementCached(id);
      },
      createElement(tag: unknown): object {
        const elId = session.createElement(String(tag));
        mutations += 1;
        return makeElementCached(elId);
      },
      createTextNode(text: unknown): object {
        const elId = session.createTextNode(String(text));
        mutations += 1;
        return makeElementCached(elId);
      },
      // Per-document adopted sheets — the doc root doubles as the cascade
      // scope key, so this reuses the shadow-adopted plumbing.
      get adoptedStyleSheets(): object[] {
        return shadowAdopted.get(docRootId) ?? [];
      },
      set adoptedStyleSheets(value: unknown) {
        if (
          value === null ||
          (typeof value !== "object" && typeof value !== "function") ||
          typeof (value as Iterable<unknown>)[Symbol.iterator] !== "function"
        ) {
          throw new TypeError("adoptedStyleSheets must be a sequence of CSSStyleSheet");
        }
        const list = [...(value as Iterable<unknown>)] as Record<string, unknown>[];
        for (const item of list) {
          if (item === null || (typeof item !== "object" && typeof item !== "function") || item["_cssText"] === undefined) {
            throw new TypeError("adoptedStyleSheets entries must be CSSStyleSheet");
          }
          if (item["_constructed"] !== true || item["_ownerDoc"] !== doc) {
            throw new DOMException("only this document's constructed stylesheets may be adopted", "NotAllowedError");
          }
        }
        shadowAdopted.set(docRootId, list);
        syncShadowAdopted(docRootId);
        mutations += 1;
      },
      // DOM §4.6 `adoptNode`: remove from the old parent; crossing a document
      // boundary empties every shadow root's adoptedStyleSheets inside.
      adoptNode(node: unknown): object {
        const nodeId = idFromWrapper(node);
        if (nodeId === undefined) throw new TypeError("adoptNode requires a Node");
        if (docScopeOfNode(nodeId) !== docRootId) {
          for (const [hostId, entry] of shadowRootIds) {
            if (containsNode(session.dom, nodeId, hostId)) {
              shadowAdopted.delete(entry.rootId);
              syncShadowAdopted(entry.rootId);
            }
          }
        }
        const parent = session.dom.nodes.get(nodeId)?.parent ?? null;
        if (parent !== null) session.removeChild(parent, nodeId);
        mutations += 1;
        return node as object;
      },
      // DOM §4.6 `importNode`: clone without copying the shadow root.
      importNode(node: unknown, deep?: unknown): object {
        const nodeId = idFromWrapper(node);
        if (nodeId === undefined) throw new TypeError("importNode requires a Node");
        const cloneId = cloneSubtree(nodeId, deep !== false);
        if (cloneId === null) throw new DOMException("cannot import this node", "NotSupportedError");
        mutations += 1;
        return makeElementCached(cloneId);
      },
      get defaultView(): object {
        return makeIframeWindow(docRootId);
      },
    };
    iframeDocWrappers.set(docRootId, doc);
    return doc;
  };

  /** The `contentWindow` of an iframe: its own document + own CSSStyleSheet
   * constructor (whose sheets are owned by the nested document). */
  const makeIframeWindow = (docRootId: NodeId): object => {
    const existing = iframeWindowWrappers.get(docRootId);
    if (existing !== undefined) return existing;
    const doc = makeIframeDocument(docRootId);
    const win: Record<string, unknown> = {
      document: doc,
      DOMException,
      getComputedStyle: (el: unknown, pseudo?: unknown) => getComputedStyle(el, pseudo),
    };
    win["CSSStyleSheet"] = function (this: unknown, options?: unknown): object {
      return constructSheet(options, doc);
    };
    Object.defineProperty(win["CSSStyleSheet"], "name", { value: "CSSStyleSheet" });
    Object.setPrototypeOf(win["CSSStyleSheet"], CSSStyleSheetCtor);
    (win["CSSStyleSheet"] as { prototype: object }).prototype = CSSStyleSheetCtor.prototype as object;
    iframeWindowWrappers.set(docRootId, win);
    return win;
  };

  const MutationObserverCtor = class MutationObserver {
    constructor(callback: unknown) {
      if (typeof callback !== "function") {
        throw new TypeError("MutationObserver: callback must be a function");
      }
      observerCallbacks.set(this, callback as (records: unknown, observer: unknown) => void);
    }
    observe(target: unknown, options?: unknown): void {
      const id = idFromWrapper(target);
      if (id === undefined) {
        throw new TypeError("MutationObserver.observe: target must be a Node");
      }
      mutationObserverController.observe(
        this,
        (records, observer) => {
          const cb = observerCallbacks.get(observer as object);
          if (cb === undefined) return;
          cb.call(observer, records.map(wrapMutationRecord), observer);
        },
        Number(id),
        normalizeObserverOptions(options),
      );
    }
    disconnect(): void {
      mutationObserverController.disconnect(this);
    }
    takeRecords(): unknown[] {
      return mutationObserverController.takeRecords(this).map(wrapMutationRecord);
    }
  };

  const domGlobals: Record<string, unknown> = {
    Event: EventCtor,
    Node: NodeCtor,
    Element: ElementCtor,
    HTMLElement: HTMLElementCtor,
    ...Object.fromEntries([...htmlInterfaceCtors].map(([name, { ctor }]) => [name, ctor])),
    CanvasRenderingContext2D: CanvasRenderingContext2DCtor,
    OffscreenCanvas: OffscreenCanvasCtor,
    // `new Text(data)` — a text node created directly in the live tree.
    Text: function Text(this: unknown, data: unknown) {
      const id = session.createTextNode(coerceGuestString(data));
      mutations += 1;
      return makeElementCached(id);
    },
    NodeList: NodeListCtor,
    MutationObserver: MutationObserverCtor,
    SVGElement: SVGElementCtor,
    MathMLElement: MathMLElementCtor,
    CSSRule: CSSRuleCtor,
    CSSGroupingRule: CSSGroupingRuleCtor,
    CSSStyleRule: CSSStyleRuleCtor,
    StyleSheet: StyleSheetCtor,
    CSSStyleSheet: CSSStyleSheetCtor,
    MediaList: MediaListCtor,
    CSSMediaRule: CSSMediaRuleCtor,
    CSSSupportsRule: CSSSupportsRuleCtor,
    CSSPageRule: CSSPageRuleCtor,
    CSSFontFaceRule: CSSFontFaceRuleCtor,
    CSSImportRule: CSSImportRuleCtor,
    CSSNamespaceRule: CSSNamespaceRuleCtor,
    CSSKeyframesRule: CSSKeyframesRuleCtor,
    CSSKeyframeRule: CSSKeyframeRuleCtor,
    CSSFontFeatureValuesRule: CSSFontFeatureValuesRuleCtor,
    CSSFontFeatureValuesMap: CSSFontFeatureValuesMapCtor,
    Document: DocumentCtor,
    DocumentFragment: DocumentFragmentCtor,
    getComputedStyle,
    // `CSS` namespace (CSSOM §namespaces): supports() validates declarations
    // (2-arg form) or support conditions (1-arg `(prop: value)` / not/and/or).
    CSS: (() => {
      const supportsDecl = (prop: string, value: string): boolean => {
        const name = prop.trim().toLowerCase();
        if (name === "" || value.trim() === "" || /!/.test(value)) return false;
        if (name.startsWith("--")) return /^--[a-zA-Z0-9_-]/.test(name);
        if (!CSS_NAME_TO_META.has(name) && !isShorthandName(name)) return false;
        return expandShorthand(name, value) !== null || isDeclarationValueValid(name, value);
      };
      // Split `s` at top-level ` <kw> ` (paren depth 0); null when absent.
      const splitAt = (s: string, kw: "or" | "and"): string[] | null => {
        const parts: string[] = [];
        let depth = 0;
        let last = 0;
        let i = 0;
        while (i < s.length) {
          const ch = s[i] as string;
          if (ch === "(") depth += 1;
          else if (ch === ")") depth -= 1;
          else if (depth === 0) {
            const m = new RegExp(`^\\s+${kw}\\s+`, "i").exec(s.slice(i));
            if (m !== null) {
              parts.push(s.slice(last, i));
              i += m[0].length;
              last = i;
              continue;
            }
          }
          i += 1;
        }
        if (parts.length === 0) return null;
        parts.push(s.slice(last));
        return parts;
      };
      const supportsCond = (cond: string): boolean => {
        const s = cond.trim();
        if (/^not\s+/i.test(s)) return !supportsCond(s.slice(4));
        const ors = splitAt(s, "or");
        if (ors !== null) return ors.some(supportsCond);
        const ands = splitAt(s, "and");
        if (ands !== null) return ands.every(supportsCond);
        const inner = s.startsWith("(") && s.endsWith(")") ? s.slice(1, -1).trim() : s;
        const idx = inner.indexOf(":");
        return idx > 0 && supportsDecl(inner.slice(0, idx), inner.slice(idx + 1));
      };
      return {
        supports(prop: unknown, value?: unknown): boolean {
          if (prop === undefined) throw new TypeError("supports() requires a condition");
          if (value === undefined) return supportsCond(cssomString(prop));
          return supportsDecl(cssomString(prop), cssomString(value));
        },
        escape(ident: unknown): string {
          return String(ident).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch.codePointAt(0)?.toString(16)} `);
        },
      };
    })(),
  };
  /**
   * HTML §7.8 lifecycle: after parsing completes (all classic scripts have
   * run), the document fires `DOMContentLoaded` at the document, then `load`
   * at the window. Many SPAs defer hydration until these events — the runner
   * calls this between script evaluation and the first timer drain.
   */
  const fireDocumentLifecycleEvents = (): void => {
    const dcl = makeEvent("DOMContentLoaded", { bubbles: true });
    // Tree-phase dispatch (capture/target/bubble on the document root) AND the
    // document-object listener registry: the platform fires DOMContentLoaded
    // AT the document, so both attachment styles must see it.
    dispatch(session.dom.root, dcl);
    const set = documentListeners.get("DOMContentLoaded");
    if (set !== undefined) {
      for (const fn of [...set]) {
        try {
          fn(dcl);
        } catch (error) {
          // HTML: report the exception; the remaining listeners still run.
          if (options.onListenerError !== undefined) options.onListenerError(error);
        }
      }
    }
  };
  const fireScriptElementEvent = (nodeId: NodeId, type: "load" | "error"): void => {
    // HTML script element: `load` fires when the script has been fetched and
    // executed; `error` when the fetch or evaluation failed. Listeners attach
    // via the element's registry (el.onload / addEventListener).
    dispatch(nodeId, makeEvent(type));
  };
  return {
    document,
    globals: domGlobals,
    mutations: () => mutations,
    tickAnimations,
    hasActiveAnimations,
    fireDocumentLifecycleEvents,
    fireScriptElementEvent,
    dispatchPlatformEvent,
  };
}

// ---------------------------------------------------------------------------
// Minimal DOM queries over the session's current DOM.
// ---------------------------------------------------------------------------

/** Whether `nodeId` is currently reachable from the document root. */
export function isConnectedToDocument(
  dom: DomTree,
  nodeId: NodeId,
  shadowHost?: (shadowRootId: NodeId) => NodeId | null,
): boolean {
  let current: NodeId | null | undefined = nodeId;
  const seen = new Set<NodeId>();
  while (current !== null && current !== undefined) {
    if (seen.has(current)) return false;
    seen.add(current);
    if (current === dom.root) return true;
    const node = dom.nodes.get(current);
    // A shadow root is detached in the flat DOM but connected through its host
    // (DOM §shadow-tree connectedness): hop to the host and keep walking.
    if (node?.kind === "element" && node.tag === "#shadow-root") {
      current = shadowHost?.(current) ?? null;
      continue;
    }
    current = node?.parent;
  }
  return false;
}

/** Whether `maybeDescendant` is currently contained by `root`, inclusive. */
function containsNode(dom: DomTree, root: NodeId, maybeDescendant: NodeId): boolean {
  let current: NodeId | null | undefined = maybeDescendant;
  const seen = new Set<NodeId>();
  while (current !== null && current !== undefined) {
    if (current === root) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    current = dom.nodes.get(current)?.parent;
  }
  return false;
}

/** WebIDL-compatible coercion for nullable `Node.textContent`. */
function textContentString(text: unknown): string {
  // WebIDL's DOMString conversion intentionally delegates to JavaScript stringification.
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return text === null ? "" : String(text);
}

/** WebIDL-compatible DOMString conversion for CSSOM method arguments. */
function cssomString(value: unknown): string {
  return String(value);
}

/** Internal slot read: rule records carry string slots (`_prelude`, …). */
const slotText = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * CSSOM "serialize a component value" normalization for declared values:
 * whitespace runs collapse to one space and number tokens get their canonical
 * serialization (leading zero — `.5` → `0.5`, `-0` → `0`, `+2` → `2`,
 * `1.` → `1`, exponent folded). String contents and `var()`/`url()` bodies are
 * untouched.
 */
// ---------------------------------------------------------------------------
// CSSOM declaration-block serialization: shorthand synthesis.
//
// Declarations are stored as longhands (shorthands expand on parse). On
// serialize — and on `getPropertyValue(shorthand)` — fully-declared shorthand
// groups fold back into their shorthand per the CSSOM "serialize a CSS
// declaration block" rules: a shorthand is emitted only when every longhand
// it covers is declared, all with the same priority.
// ---------------------------------------------------------------------------

type StylePriority = "" | "important";
interface StyleDeclarationEntry {
  readonly value: string;
  readonly priority: StylePriority;
  /** Set when the entry carries a shorthand's pending-substitution value
   *  (`background: var(--a)` spreads the raw var() text onto every longhand):
   *  the longhand's own serialization is empty. */
  readonly pending?: boolean;
}

const CSS_WIDE_VALUE_SET: ReadonlySet<string> = new Set([
  "initial", "inherit", "unset", "revert", "revert-layer",
]);

/** `all` covers every longhand except these (and itself), per CSS Cascade §4. */
const ALL_SHORTHAND_EXCLUDED: ReadonlySet<string> = new Set([
  "all", "direction", "unicode-bidi",
]);

let allLonghandNamesCache: string[] | null = null;
const allLonghandNames = (): string[] => {
  if (allLonghandNamesCache === null) {
    allLonghandNamesCache = CSS_PROPERTIES
      .map((p) => p.name)
      .filter((n) => !n.startsWith("--") && !ALL_SHORTHAND_EXCLUDED.has(n) && !isShorthandName(n));
  }
  return allLonghandNamesCache;
};

interface ShorthandFoldRule {
  readonly name: string;
  readonly longhands: readonly string[];
  /** Joins the longhand values into the shorthand value, or null when the
   *  shorthand cannot represent them. `values[i]` corresponds to
   *  `longhands[i]`. */
  readonly synthesize: (values: readonly string[]) => string | null;
}

/** Blink-style quad collapse: identical values merge right→left→bottom. */
const joinQuad = (t: string, r: string, b: string, l: string): string =>
  t === r && r === b && b === l ? t :
  b === t && l === r ? `${t} ${r}` :
  l === r ? `${t} ${r} ${b}` :
  `${t} ${r} ${b} ${l}`;

const quadRule = (name: string, props: readonly string[]): ShorthandFoldRule => ({
  name,
  longhands: props,
  synthesize: (v) => joinQuad(v[0] as string, v[1] as string, v[2] as string, v[3] as string),
});

const pairRule = (name: string, props: readonly string[]): ShorthandFoldRule => ({
  name,
  longhands: props,
  synthesize: (v) => (v[0] === v[1] ? (v[0] as string) : `${v[0]} ${v[1]}`),
});

const borderEdgeLH = (edge: string): readonly string[] => [
  `border-${edge}-width`, `border-${edge}-style`, `border-${edge}-color`,
];

/** `<width> <style> <color>` — omit components at their initial value. */
const joinBorderEdge = (v: readonly string[]): string => {
  const parts: string[] = [];
  if (v[0] !== "medium") parts.push(v[0] as string);
  if (v[1] !== "none") parts.push(v[1] as string);
  if (v[2] !== "currentcolor") parts.push(v[2] as string);
  return parts.length === 0 ? "medium" : parts.join(" ");
};

const SHORTHAND_FOLD_RULES: readonly ShorthandFoldRule[] = [
  {
    name: "all",
    longhands: allLonghandNames(),
    synthesize: (v) =>
      v.every((x) => x === v[0]) && CSS_WIDE_VALUE_SET.has(v[0] as string)
        ? (v[0] as string)
        : null,
  },
  {
    name: "border",
    longhands: [
      "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
      "border-top-style", "border-right-style", "border-bottom-style", "border-left-style",
      "border-top-color", "border-right-color", "border-bottom-color", "border-left-color",
      "border-image",
    ],
    synthesize: (v) => {
      const allEq = (i: number): boolean => v[i] === v[i + 1] && v[i + 1] === v[i + 2] && v[i + 2] === v[i + 3];
      if (v[12] !== "none" || !allEq(0) || !allEq(4) || !allEq(8)) return null;
      return joinBorderEdge([v[0] as string, v[4] as string, v[8] as string]);
    },
  },
  quadRule("border-width", ["border-top-width", "border-right-width", "border-bottom-width", "border-left-width"]),
  quadRule("border-style", ["border-top-style", "border-right-style", "border-bottom-style", "border-left-style"]),
  quadRule("border-color", ["border-top-color", "border-right-color", "border-bottom-color", "border-left-color"]),
  { name: "border-top", longhands: borderEdgeLH("top"), synthesize: joinBorderEdge },
  { name: "border-right", longhands: borderEdgeLH("right"), synthesize: joinBorderEdge },
  { name: "border-bottom", longhands: borderEdgeLH("bottom"), synthesize: joinBorderEdge },
  { name: "border-left", longhands: borderEdgeLH("left"), synthesize: joinBorderEdge },
  quadRule("margin", ["margin-top", "margin-right", "margin-bottom", "margin-left"]),
  quadRule("padding", ["padding-top", "padding-right", "padding-bottom", "padding-left"]),
  quadRule("inset", ["top", "right", "bottom", "left"]),
  quadRule("border-radius", ["border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius"]),
  {
    name: "list-style",
    longhands: ["list-style-position", "list-style-type", "list-style-image"],
    synthesize: (v) => {
      const parts: string[] = [];
      if (v[0] !== "outside") parts.push(v[0] as string);
      if (v[1] !== "disc") parts.push(v[1] as string);
      if (v[2] !== "none") parts.push(v[2] as string);
      return parts.length === 0 ? null : parts.join(" ");
    },
  },
  {
    name: "outline",
    longhands: ["outline-color", "outline-style", "outline-width"],
    synthesize: (v) => {
      const parts: string[] = [];
      if (v[0] !== "invert" && v[0] !== "currentcolor") parts.push(v[0] as string);
      if (v[1] !== "none") parts.push(v[1] as string);
      if (v[2] !== "medium") parts.push(v[2] as string);
      return parts.length === 0 ? null : parts.join(" ");
    },
  },
  {
    name: "flex",
    longhands: ["flex-grow", "flex-basis", "flex-shrink"],
    synthesize: (v) => {
      const [g, b, s] = v as [string, string, string];
      if (g === "0" && s === "1" && b === "auto") return "initial";
      if (g === "0" && s === "0" && b === "auto") return "none";
      if (g === "1" && s === "1" && b === "auto") return "auto";
      const basis = b === "0" || b === "0%" ? "0px" : b;
      return `${g} ${s} ${basis}`;
    },
  },
  {
    name: "font",
    longhands: ["font-style", "font-weight", "font-stretch", "font-size", "line-height", "font-family"],
    synthesize: (v) => {
      const parts: string[] = [];
      if (v[0] !== "normal") parts.push(v[0] as string);
      if (v[1] !== "normal" && v[1] !== "400") parts.push(v[1] as string);
      if (v[2] !== "normal") parts.push(v[2] as string);
      parts.push(v[3] as string);
      if (v[4] !== "normal") parts[parts.length - 1] = `${v[3]} / ${v[4]}`;
      parts.push(v[5] as string);
      return parts.join(" ");
    },
  },
  {
    name: "font-variant",
    longhands: [
      "font-variant-ligatures", "font-variant-caps", "font-variant-alternates",
      "font-variant-numeric", "font-variant-east-asian", "font-variant-position",
      "font-variant-emoji",
    ],
    synthesize: (v) => {
      const nonNormal = v.filter((x) => x !== "normal");
      if (nonNormal.length === 0) return "normal";
      if (nonNormal.length === 1) {
        return v[0] === "none" ? "none" : (nonNormal[0] as string);
      }
      return null;
    },
  },
  {
    name: "text-decoration",
    longhands: ["text-decoration-line", "text-decoration-style", "text-decoration-color", "text-decoration-thickness"],
    synthesize: (v) => {
      const parts: string[] = [v[0] as string];
      if (v[1] !== "solid") parts.push(v[1] as string);
      if (v[2] !== "currentcolor") parts.push(v[2] as string);
      if (v[3] !== "auto" && v[3] !== "from-font") parts.push(v[3] as string);
      return parts.join(" ");
    },
  },
  {
    name: "background",
    longhands: [
      "background-color", "background-image", "background-repeat", "background-attachment",
      "background-position", "background-size", "background-origin", "background-clip",
    ],
    synthesize: (v) => {
      const [color, image, repeat, attachment, position, size, origin, clip] =
        v as [string, string, string, string, string, string, string, string];
      const parts: string[] = [];
      if (color !== "transparent" && color !== "rgba(0, 0, 0, 0)") parts.push(color);
      if (image !== "none") parts.push(image);
      if (repeat !== "repeat") parts.push(repeat);
      if (attachment !== "scroll") parts.push(attachment);
      if (position !== "0% 0%" || size !== "auto") {
        parts.push(size === "auto" ? position : `${position} / ${size}`);
      }
      if (origin !== "padding-box" || clip !== "border-box") {
        if (origin === clip) parts.push(origin);
        else {
          if (origin !== "padding-box") parts.push(origin);
          if (clip !== "border-box") parts.push(clip);
        }
      }
      return parts.length === 0 ? null : parts.join(" ");
    },
  },
  pairRule("overflow", ["overflow-x", "overflow-y"]),
  pairRule("gap", ["row-gap", "column-gap"]),
  pairRule("inset-block", ["inset-block-start", "inset-block-end"]),
  pairRule("inset-inline", ["inset-inline-start", "inset-inline-end"]),
  pairRule("place-items", ["align-items", "justify-items"]),
  pairRule("place-content", ["align-content", "justify-content"]),
  pairRule("place-self", ["align-self", "justify-self"]),
];

/** Shorthands without a fold rule still need a longhand list for `all`-style
 *  CSS-wide expansion (`overflow: inherit` → every longhand `inherit`). */
const EXTRA_SHORTHAND_COVERAGE: Readonly<Record<string, readonly string[]>> = {
  transition: ["transition-property", "transition-duration", "transition-timing-function", "transition-delay"],
  "border-image": ["border-image-source", "border-image-slice", "border-image-width", "border-image-outset", "border-image-repeat"],
  "grid-row": ["grid-row-start", "grid-row-end"],
  "grid-column": ["grid-column-start", "grid-column-end"],
  "grid-area": ["grid-row-start", "grid-column-start", "grid-row-end", "grid-column-end"],
  "grid-gap": ["row-gap", "column-gap"],
  "overflow-block": ["overflow-y"],
  "overflow-inline": ["overflow-x"],
  "-webkit-line-clamp": ["line-clamp"],
};

const coveredLonghands = (name: string): readonly string[] | null => {
  if (name === "all") return allLonghandNames();
  const rule = SHORTHAND_FOLD_RULES.find((r) => r.name === name);
  if (rule !== undefined) return rule.longhands;
  return Object.hasOwn(EXTRA_SHORTHAND_COVERAGE, name) ? (EXTRA_SHORTHAND_COVERAGE[name] ?? null) : null;
};

const FOLD_RULES_BY_LONGHAND: ReadonlyMap<string, ShorthandFoldRule[]> = (() => {
  const m = new Map<string, ShorthandFoldRule[]>();
  for (const rule of SHORTHAND_FOLD_RULES) {
    for (const lh of rule.longhands) {
      const list = m.get(lh);
      if (list === undefined) m.set(lh, [rule]);
      else list.push(rule);
    }
  }
  return m;
})();

/** Try to synthesize `shorthand` from its longhands in `map`; null when the
 *  group is incomplete or the value is not shorthand-representable. */
const synthesizeShorthand = (
  map: Map<string, StyleDeclarationEntry>,
  shorthand: string,
): { value: string; priority: StylePriority; covered: readonly string[] } | null => {
  const rules = SHORTHAND_FOLD_RULES.filter((r) => r.name === shorthand);
  for (const rule of rules) {
    const entries = rule.longhands.map((l) => map.get(l));
    if (entries.some((e) => e === undefined)) continue;
    const priority = (entries[0] as StyleDeclarationEntry).priority;
    if (!entries.every((e) => (e as StyleDeclarationEntry).priority === priority)) continue;
    const vals = entries.map((e) => (e as StyleDeclarationEntry).value);
    const wideCount = vals.filter((v) => CSS_WIDE_VALUE_SET.has(v)).length;
    if (wideCount > 0 && wideCount < vals.length) continue;
    // Pending-substitution shorthand (`background: var(--x)` spreads the raw
    // var() text onto every longhand): the shorthand reads back verbatim, but
    // any non-uniform var()-bearing mix cannot be shorthand-serialized.
    if (vals.some((v) => /\b(?:var|env)\(/.test(v))) {
      if (vals.every((v) => v === vals[0])) {
        return { value: vals[0] as string, priority, covered: rule.longhands };
      }
      continue;
    }
    const value = wideCount === vals.length
      ? (vals.every((v) => v === vals[0]) ? (vals[0] as string) : null)
      : rule.synthesize(vals);
    if (value === null) continue;
    return { value, priority, covered: rule.longhands };
  }
  return null;
};

const canonicalDeclValue = (
  prop: string,
  text: string,
  urlResolver?: (inner: string) => string | null,
): string => {
  const v = canonicalizeCssValueText(text, prop, urlResolver);
  return v === "0" && LENGTH_BARE_ZERO_PX.has(prop) ? "0px" : v;
};

// Custom property names are stored unescaped (`--\61 b` → `--ab`); on
// serialization they re-escape per serialize-an-identifier (non-word chars
// become `\hh ` escapes so `;`/`"` can't corrupt the declaration block).
const serializeDeclName = (name: string): string => {
  if (!name.startsWith("--")) return name;
  let out = "--";
  for (const ch of name.slice(2)) {
    if (/[a-zA-Z0-9_-]/.test(ch)) {
      out += ch;
    } else {
      out += `\\${(ch.codePointAt(0) as number).toString(16)} `;
    }
  }
  return out;
};

/** Applies one declaration with Blink-style remove+append semantics: a
 *  re-declared property moves to the end of the block, and an `!important`
 *  entry cannot be overridden by a normal-priority write. */
const applyDecl = (
  map: Map<string, StyleDeclarationEntry>,
  name: string,
  value: string,
  priority: StylePriority,
  pending = false,
): void => {
  const prev = map.get(name);
  if (prev !== undefined && prev.priority === "important" && priority !== "important") return;
  map.delete(name);
  map.set(name, pending ? { value, priority, pending: true } : { value, priority });
};

const serializeDeclarations = (map: Map<string, StyleDeclarationEntry>): string => {
  const lines: string[] = [];
  const group: Array<[string, StyleDeclarationEntry]> = [...map.entries()];
  const remaining = new Set(group.map(([k]) => k));
  for (const [name, decl] of group) {
    if (!remaining.has(name)) continue;
    const imp = decl.priority === "important" ? " !important" : "";
    let folded = false;
    for (const rule of FOLD_RULES_BY_LONGHAND.get(name) ?? []) {
      if (!rule.longhands.every((l) => remaining.has(l))) continue;
      const lEntries = rule.longhands.map((l) => map.get(l) as StyleDeclarationEntry);
      // A shorthand only folds when every covered longhand shares one
      // priority — a mixed-priority group serializes as longhands.
      if (!lEntries.every((e) => e.priority === decl.priority)) continue;
      const vals = lEntries.map((e) => e.value);
      const wideCount = vals.filter((v) => CSS_WIDE_VALUE_SET.has(v)).length;
      if (wideCount > 0 && wideCount < vals.length) continue;
      // Pending-substitution shorthand: `font: var(--a)` spreads the raw
      // var() text onto every longhand — serialize it back verbatim. A
      // non-uniform var() mix cannot fold; longhands serialize as-is.
      if (vals.some((v) => /\b(?:var|env)\(/.test(v))) {
        if (!vals.every((v) => v === vals[0])) continue;
        lines.push(`${serializeDeclName(rule.name)}: ${vals[0]}${imp};`);
        for (const l of rule.longhands) remaining.delete(l);
        folded = true;
        break;
      }
      const value = wideCount === vals.length
        ? (vals.every((v) => v === vals[0]) ? (vals[0] as string) : null)
        : rule.synthesize(vals);
      if (value === null) continue;
      lines.push(`${serializeDeclName(rule.name)}: ${value}${imp};`);
      for (const l of rule.longhands) remaining.delete(l);
      folded = true;
      break;
    }
    if (!folded) {
      lines.push(`${serializeDeclName(name)}: ${decl.value}${imp};`);
      remaining.delete(name);
    }
  }
  return lines.join(" ");
};

function canonicalizeCssValueText(
  text: string,
  propName = "",
  urlResolver?: (inner: string) => string | null,
): string {
  let out = "";
  let i = 0;
  const n = text.length;
  const isDigit = (c: string): boolean => c >= "0" && c <= "9";
  const isNameStart = (c: string): boolean => /[a-zA-Z_]/.test(c) || (c !== "" && (c.codePointAt(0) ?? 0) >= 0x80);
  const isNameChar = (c: string): boolean => isNameStart(c) || isDigit(c) || c === "-";
  const scanString = (from: number): { end: number; body: string } => {
    const quote = text[from] as string;
    let j = from + 1;
    let body = "";
    while (j < n && text[j] !== quote) {
      if (text[j] === "\\" && j + 1 < n) {
        body += text[j] as string;
        j += 1;
      }
      body += text[j] as string;
      j += 1;
    }
    j += 1;
    return { end: j, body };
  };
  const emitQuoted = (body: string): string => `"${body.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const scanBalanced = (from: number): number => {
    // `from` points just past `(`; returns index just past the matching `)`.
    let depth = 1;
    let j = from;
    while (j < n && depth > 0) {
      const c = text[j] as string;
      if (c === '"' || c === "'") {
        const q = c;
        j += 1;
        while (j < n && text[j] !== q) {
          if (text[j] === "\\") j += 1;
          j += 1;
        }
        j += 1;
        continue;
      }
      if (c === "(") depth += 1;
      if (c === ")") depth -= 1;
      j += 1;
    }
    return j;
  };
  const normFunc = (fname: string, inner: string): string => {
    const lower = fname.toLowerCase();
    if (lower === "attr") {
      const hadPipe = inner.includes("|");
      const cleaned = inner.replace(/\|/g, " ");
      const commaIdx = cleaned.indexOf(",");
      const name = cleaned.slice(0, commaIdx < 0 ? cleaned.length : commaIdx).trim();
      let fallback = commaIdx < 0 ? "" : cleaned.slice(commaIdx + 1).trim();
      const fbMatch = /^(['"])(.*)\1$/.exec(fallback);
      const hadFallback = fbMatch !== null;
      if (hadFallback) {
        const body = (fbMatch)[2] as string;
        if (hadPipe && body === "") return `attr(${name})`;
        fallback = emitQuoted(body);
      } else if (fallback !== "") {
        fallback = canonicalizeCssValueText(fallback);
      }
      return fallback === "" ? `attr(${name})` : `attr(${name}, ${fallback})`;
    }
    if (lower === "counter" || lower === "counters") {
      const parts: string[] = [];
      let depth = 0;
      let last = 0;
      for (let k = 0; k < inner.length; k += 1) {
        const c = inner[k] as string;
        if (c === "(") depth += 1;
        if (c === ")") depth -= 1;
        if (c === "," && depth === 0) {
          parts.push(inner.slice(last, k));
          last = k + 1;
        }
      }
      parts.push(inner.slice(last));
      const args = parts.map((p) => p.trim());
      if (lower === "counter" && args.length === 2 && args[1] === "decimal") args.pop();
      if (lower === "counters" && args.length === 3 && args[2] === "decimal") args.pop();
      return `${lower}(${args.map((a) => {
        const m = /^(['"])(.*)\1$/.exec(a);
        return m !== null ? emitQuoted(m[2] as string) : a;
      }).join(", ")})`;
    }
    return `${fname}(${canonicalizeCssValueText(inner)})`;
  };
  while (i < n) {
    const ch = text[i] as string;
    if (/\s/.test(ch)) {
      while (i < n && /\s/.test(text[i] as string)) i += 1;
      out += " ";
      continue;
    }
    if (ch === '"' || ch === "'") {
      const { end, body } = scanString(i);
      i = end;
      out += emitQuoted(body);
      continue;
    }
    if (isNameStart(ch) || (ch === "-" && (isNameStart(text[i + 1] ?? "") || text[i + 1] === "-"))) {
      const start = i;
      i += 1;
      while (i < n && isNameChar(text[i] as string)) i += 1;
      const word = text.slice(start, i);
      if (text[i] === "(") {
        const end = scanBalanced(i + 1);
        const inner = text.slice(i + 1, end - 1);
        i = end;
        if (word.toLowerCase() === "url") {
          const t = inner.trim();
          const m = /^(['"])(.*)\1$/.exec(t);
          const bare = m !== null ? (m[2] as string) : t;
          const resolved = urlResolver !== undefined && bare !== "" ? (urlResolver(bare) ?? bare) : bare;
          out += `url(${emitQuoted(resolved)})`;
        } else {
          out += normFunc(word, inner);
        }
        continue;
      }
      out += word;
      continue;
    }
    // number token: [+-]? ( digits [. digits]? | . digits ) (e [+-]? digits)?
    const numMatch = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if (numMatch !== null) {
      const prev = i > 0 ? (text[i - 1] as string) : "";
      const num = numMatch[0];
      // A number can't start a new token right after an ident/delim char.
      if (isNameChar(prev) || prev === "." || prev === ")" ) {
        out += num;
        i += num.length;
        continue;
      }
      let s = num;
      let neg = false;
      if (s[0] === "+" || s[0] === "-") {
        neg = s[0] === "-";
        s = s.slice(1);
      }
      // fold exponent: 2e2 → 200, 1e-1 → 0.1
      const eMatch = /[eE]([+-]?\d+)$/.exec(s);
      if (eMatch !== null) {
        const mantissa = s.slice(0, eMatch.index);
        const exp = Number(eMatch[1]);
        if (Number.isSafeInteger(exp)) {
          const digits = mantissa.replace(".", "");
          const point = mantissa.includes(".") ? mantissa.indexOf(".") : mantissa.length;
          const newPoint = point + exp;
          if (newPoint <= 0) {
            s = `0.${"0".repeat(-newPoint)}${digits}`;
          } else if (newPoint >= digits.length) {
            s = digits + "0".repeat(newPoint - digits.length);
          } else {
            s = `${digits.slice(0, newPoint)}.${digits.slice(newPoint)}`;
          }
        }
      }
      // canonical number: strip trailing . and fraction zeros, add leading 0,
      // drop - for zero.
      if (s.includes(".")) {
        s = s.replace(/0+$/, "").replace(/\.$/, "");
      }
      if (s.startsWith(".")) s = `0${s}`;
      if (s === "" || s === "0") neg = false;
      if (s === "") s = "0";
      s = (neg ? "-" : "") + s;
      // unit or % follows — lowercase it
      const unitMatch = /^[%]?[a-zA-Z][a-zA-Z0-9-]*/.exec(text.slice(i + numMatch[0].length));
      if (unitMatch !== null) {
        s += unitMatch[0].toLowerCase();
        i += numMatch[0].length + unitMatch[0].length;
      } else {
        if (text[i + numMatch[0].length] === "%") {
          s += "%";
          i += 1;
        }
        i += numMatch[0].length;
      }
      out += s;
      continue;
    }
    out += ch;
    i += 1;
  }
  let result = out.trim();
  if (propName === "font-family") {
    // <family-name>: a quoted name that would parse differently unquoted —
    // generic-family keywords, CSS-wide keywords, `default`, digit-starting
    // names, and non-ident text — must stay quoted (with double quotes);
    // any other quoted name that is a valid ident sequence drops the quotes.
    result = result
      .split(",")
      .map((part) => {
        const t = part.trim();
        const m = /^"(.*)"$/.exec(t);
        if (m === null) return t;
        const inner = m[1] as string;
        const low = inner.toLowerCase();
        if (
          GENERIC_FONT_FAMILIES.has(low)
          || /^generic\(/.test(low)
          || CSS_WIDE_VALUE_SET.has(low)
          || low === "default"
          || !/^[a-zA-Z_-][\w-]*( [a-zA-Z_-][\w-]*)*$/.test(inner)
        ) {
          return `"${inner}"`;
        }
        return inner;
      })
      .join(", ");
  }
  return result;
}

const GENERIC_FONT_FAMILIES: ReadonlySet<string> = new Set([
  "serif", "sans-serif", "cursive", "fantasy", "monospace", "system-ui",
  "math", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded",
]);

/** HTML element attribute names are ASCII-case-insensitive in this bridge. */
function htmlAttributeName(value: unknown): string {
  return String(value).toLowerCase();
}

/** Whether a property key is a canonical CSSOM indexed-property name. */
function isCssomArrayIndex(prop: string): boolean {
  if (prop === "") return false;
  const index = Number(prop);
  return Number.isInteger(index) && index >= 0 && index < 4294967295 && String(index) === prop;
}

/** Replace a node's text content using DOM's "replace all" setter semantics. */
function replaceTextContent(session: FineSession, nodeId: NodeId, text: string): void {
  const node = session.dom.nodes.get(nodeId);
  if (node === undefined) return;
  if (node.kind === "text" || node.kind === "comment") {
    session.setText(nodeId, text);
    return;
  }
  for (const childId of [...node.children]) {
    session.removeChild(nodeId, childId);
  }
  if (text !== "") {
    session.appendChild(nodeId, session.createTextNode(text));
  }
}

/** The recursive text content of a node, following tree order for descendants. */
function textContentOf(dom: DomTree, nodeId: NodeId): string {
  const node = dom.nodes.get(nodeId);
  if (node === undefined) return "";
  if (node.kind === "text") return node.text ?? "";
  if (node.kind === "comment") return node.text ?? "";
  let text = "";
  for (const childId of node.children) {
    const child = dom.nodes.get(childId);
    if (child !== undefined && child.kind === "text") {
      text += child.text ?? "";
    } else if (child !== undefined && (child.kind === "element" || child.kind === "document")) {
      text += textContentOf(dom, childId);
    }
  }
  return text;
}
