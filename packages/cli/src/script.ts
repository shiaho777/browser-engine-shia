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
import { CSS_PROPERTIES, parsePropertyValue, expandShorthand } from "@browser-engine/generator";
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
  if (tsType === "Color" && typeof value === "object") {
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
  const isUnderScope = (id: NodeId, scopeRoot: NodeId | null): boolean => {
    if (scopeRoot === null) return true;
    let cur: NodeId | null | undefined = id;
    while (cur !== null && cur !== undefined) {
      if (cur === scopeRoot) return true;
      cur = session.dom.nodes.get(cur)?.parent;
    }
    return false;
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
      const found = findByIdIndexed(trimmed.slice(1));
      if (found === null) return [];
      if (scopeRoot !== null && (found === scopeRoot || !isUnderScope(found, scopeRoot))) return [];
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
    if (options.onDynamicScript === undefined) return;
    for (const id of ids) {
      if (id === null || id === undefined) continue;
      const node = session.dom.nodes.get(id);
      if (node?.kind === "element" && node.tag === "script") options.onDynamicScript(id);
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
        session.setAttribute(nodeId, attr, String(value));
        mutations += 1;
        // HTML script-element semantics: setting `src` on a CONNECTED script
        // element triggers the fetch-and-run steps (the classic SPA loader
        // pattern: append first, then set src).
        if (attr === "src" && options.onDynamicScript !== undefined) {
          const node = session.dom.nodes.get(nodeId);
          if (node?.kind === "element" && node.tag === "script" && isConnectedToDocument(session.dom, nodeId)) {
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
        session.setAttribute(nodeId, String(qualifiedName), String(value));
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
        return isConnectedToDocument(session.dom, nodeId);
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

  type StylePriority = "" | "important";
  interface StyleDeclarationEntry {
    readonly value: string;
    readonly priority: StylePriority;
  }
  interface StyleDeclarationObject {
    readonly length: number;
    item(index: unknown): string;
    getPropertyValue(prop: unknown): string;
    getPropertyPriority(prop: unknown): string;
    setProperty(prop: unknown, value?: unknown, priority?: unknown): void;
    removeProperty(prop: unknown): string;
    cssText: string;
    _rawDeclValue(prop: unknown): string | undefined;
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
    const parse = (): Map<string, StyleDeclarationEntry> => {
      const map = new Map<string, StyleDeclarationEntry>();
      for (const decl of getText().split(";")) {
        const idx = decl.indexOf(":");
        if (idx <= 0) continue;
        const name = decl.slice(0, idx).trim();
        let value = decl.slice(idx + 1).trim();
        let priority: StylePriority = "";
        const important = /!\s*important\s*$/i.exec(value);
        if (important !== null) {
          priority = "important";
          value = value.slice(0, important.index).trim();
        }
        if (name === "" || value === "") continue;
        // Invalid declarations drop out (CSS error recovery): a later invalid
        // declaration leaves the earlier valid one standing, so SKIP rather
        // than clear. Custom properties and var()-bearing values accept any
        // token stream.
        if (
          !name.startsWith("--") &&
          !/\b(?:var|env)\(/.test(value) &&
          !expandShorthand(name, value) &&
          !isDeclarationValueValid(name, value)
        ) {
          continue;
        }
        map.set(name, { value, priority });
      }
      return map;
    };
    // Values containing var()/env() references are stored verbatim for the
    // Typed OM views (whitespace is significant inside CSSUnparsedValue);
    // the CSSOM getters still return the normalized form.
    const rawOverrides = new Map<string, string>();
    const serialize = (map: Map<string, StyleDeclarationEntry>): string =>
      // CSSOM serializes each declaration with a trailing semicolon.
      [...map]
        .map(([k, decl]) => `${k}: ${decl.value}${decl.priority === "important" ? " !important" : ""};`)
        .join(" ");
    const commit = (map: Map<string, StyleDeclarationEntry>): void => {
      setText(serialize(map));
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
        const direct = map.get(name)?.value;
        if (direct !== undefined) return direct;
        // Longhands read through a declared shorthand (`margin` covers
        // `margin-top`) — the shorthand's expansion decides the value.
        for (const [entryName, entry] of map) {
          if (entryName === name) continue;
          const expanded = expandShorthand(entryName, entry.value);
          if (expanded === null) continue;
          const hit = expanded.find((d) => d.property === name);
          if (hit !== undefined) return hit.value;
        }
        return "";
      },
      getPropertyPriority(prop: unknown): string {
        return parse().get(String(prop))?.priority ?? "";
      },
      setProperty(prop: unknown, value?: unknown, priority?: unknown): void {
        const map = parse();
        const name = String(prop);
        const text = value === undefined ? "" : cssomString(value);
        if (text === "") {
          map.delete(name);
          commit(map);
          return;
        }
        const priorityText = priority === undefined ? "" : cssomString(priority);
        if (priorityText !== "" && priorityText.toLowerCase() !== "important") return;
        // CSSOM setProperty ignores invalid values — the previous valid
        // declaration must stand (it is not replaced by the bad text).
        if (
          !name.startsWith("--") &&
          !/\b(?:var|env)\(/.test(text) &&
          !expandShorthand(name, text) &&
          !isDeclarationValueValid(name, text)
        ) {
          return;
        }
        map.set(name, { value: text, priority: priorityText === "" ? "" : "important" });
        if (/\b(?:var|env)\(/.test(text)) rawOverrides.set(name, text);
        else rawOverrides.delete(name);
        commit(map);
      },
      removeProperty(prop: unknown): string {
        const map = parse();
        const name = String(prop);
        const oldValue = map.get(name)?.value
          ?? (() => {
            // A longhand may be declared through a covering shorthand — the
            // removal result reads through the expansion.
            for (const [entryName, entry] of map) {
              const expanded = expandShorthand(entryName, entry.value);
              const hit = expanded?.find((d) => d.property === name);
              if (hit !== undefined) return hit.value;
            }
            return "";
          })();
        map.delete(name);
        rawOverrides.delete(name);
        // Removing a longhand removes the shorthand declared over it and
        // rewrites the remaining edges as their own longhand declarations.
        for (const [entryName, entry] of map) {
          const expanded = expandShorthand(entryName, entry.value);
          if (expanded === null) continue;
          if (expanded.some((d) => d.property === name)) {
            map.delete(entryName);
            rawOverrides.delete(entryName);
            for (const d of expanded) {
              if (d.property !== name && !map.has(d.property)) {
                map.set(d.property, { value: d.value, priority: entry.priority });
              }
            }
          }
        }
        commit(map);
        return oldValue;
      },
      /** Typed OM seam: the verbatim (untrimmed) value stored by set(). */
      _rawDeclValue(prop: unknown): string | undefined {
        return rawOverrides.get(String(prop));
      },
      get cssText(): string {
        return getText();
      },
      set cssText(value: unknown) {
        rawOverrides.clear();
        setText(String(value));
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
    interface StyleRuleEntry {
      cssText: string;
      ruleObject?: object;
    }
    let rules: StyleRuleEntry[] = [];
    let rulesFromText = "";
    const ensureRulesParsed = (): void => {
      const text = styleText();
      if (text === rulesFromText) return;
      rulesFromText = text;
      rules = [];
      // Top-level rule splitter: handles @media blocks by brace depth.
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
        }
      }
      const tail = text.slice(start).trim();
      if (tail !== "") rules.push({ cssText: tail });
    };
    const rebuildText = (): void => {
      rewriteStyleText(rules.map((r) => r.cssText).join("\n"));
      rulesFromText = rules.map((r) => r.cssText).join("\n");
    };
    const makeRuleObject = (entry: StyleRuleEntry): object => {
      if (entry.ruleObject !== undefined) return entry.ruleObject;
      const parts = splitRule(entry.cssText);
      if (parts === undefined) {
        const rule: Record<string, unknown> = { _entry: entry, _type: 0 };
        Object.setPrototypeOf(rule, CSSRuleCtor.prototype as object);
        entry.ruleObject = rule;
        return rule;
      }
      // The declaration block is a live view: edits via style/styleMap rewrite
      // the rule's cssText, which rewrites the element's text — the stylesheet
      // pipeline re-parses and the cascade picks it up on the next render.
      const decl = makeDeclarationBacked(
        () => splitRule(entry.cssText)?.body ?? "",
        (text) => {
          const cur = splitRule(entry.cssText);
          entry.cssText = `${cur?.selector ?? parts.selector} { ${text} }`;
          rebuildText();
        },
      ) as StyleDeclarationObject;
      // WebIDL attributes live on CSSStyleRule.prototype — the instance only
      // carries internal slots (_entry/_decl/_sheet/_type).
      const rule: Record<string, unknown> = {
        _entry: entry,
        _decl: decl,
        _sheet: sheet,
        _type: 1,
      };
      Object.setPrototypeOf(rule, CSSStyleRuleCtor.prototype as object);
      entry.ruleObject = rule;
      return rule;
    };
    const sheet: Record<string, unknown> = {
      get ownerNode(): object {
        return makeElementCached(nodeId);
      },
      // CSSOM: cssRules is a LIVE CSSRuleList — `sheet.cssRules[sheet.insertRule(x)]`
      // evaluates the list BEFORE insertRule runs, so indexing must read lazily.
      get cssRules(): object {
        const list = new Proxy([] as object[], {
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
            const v = Reflect.get(Array.prototype, prop);
            return typeof v === "function" ? v : v;
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
        return list;
      },
      get rules(): object[] {
        return sheet["cssRules"] as object[];
      },
      insertRule(cssText: unknown, index?: unknown): number {
        ensureRulesParsed();
        const rule = coerceGuestString(cssText).trim();
        if (rule === "") throw new SyntaxError("insertRule: empty rule text");
        const i =
          index === undefined
            ? rules.length
            : Math.max(0, Math.min(rules.length, Math.trunc(Number(index))));
        rules.splice(i, 0, { cssText: rule });
        rebuildText();
        return i;
      },
      deleteRule(index: unknown): void {
        ensureRulesParsed();
        const i = Math.trunc(Number(index));
        if (i < 0 || i >= rules.length) {
          throw new Error(`deleteRule: index ${i} out of range`);
        }
        rules.splice(i, 1);
        rebuildText();
      },
      get cssText(): string {
        return styleText();
      },
      get disabled(): boolean {
        return false;
      },
      set disabled(_value: unknown) {},
      get media(): { mediaText: string } {
        const node = session.dom.nodes.get(nodeId);
        return { mediaText: node?.attrs?.get("media") ?? "" };
      },
      get title(): string | null {
        const node = session.dom.nodes.get(nodeId);
        return node?.attrs?.get("title") ?? null;
      },
      toString(): string {
        return "[object CSSStyleSheet]";
      },
    };
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

  const importParsedNode = (source: DomNode, sourceTree: DomTree): NodeId | null => {
    if (source.kind === "document") return null;
    let id: NodeId;
    if (source.kind === "element") {
      id = session.createElement(source.tag ?? "");
      for (const [name, value] of source.attrs ?? []) {
        session.setAttribute(id, name, value);
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
    return { get: getter as () => unknown, enumerable: true, configurable: true };
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
  Object.defineProperties(CSSGroupingRuleCtor.prototype as object, {
    cssRules: ruleAccessor("cssRules", "_entry", () => []),
    insertRule: {
      value: function insertRule(cssText: unknown, index?: unknown): number {
        void cssText;
        void index;
        throw new Error("insertRule is not supported on this rule");
      },
      writable: true,
      enumerable: true,
      configurable: true,
    },
    deleteRule: {
      value: function deleteRule(index: unknown): void {
        void index;
        throw new Error("deleteRule is not supported on this rule");
      },
      writable: true,
      enumerable: true,
      configurable: true,
    },
  });
  Object.defineProperties(CSSStyleRuleCtor.prototype as object, {
    selectorText: ruleAccessor(
      "selectorText",
      "_entry",
      (_o, v) => splitRule((v as { cssText: string }).cssText)?.selector ?? "",
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
  const gcsProxyCache = new Map<NodeId, object>();
  const gcsValueCache = new Map<NodeId, Record<string, unknown>>();
  const gcsSerializedCache = new Map<NodeId, Map<string, string>>();

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

  function getComputedStyle(el: unknown): object {
    gCsCalls += 1;
    const id = idFromWrapper(el);
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
      const hit = gcsProxyCache.get(id);
      if (hit !== undefined) return hit;
    }

    const customNames = (): string[] => {
      const raw = ensureRaw();
      return raw === null ? [] : [...(customPropertiesOf(raw)?.keys() ?? [])];
    };
    const item = (index: unknown): string => {
      const n = Number(index);
      if (!Number.isInteger(n) || n < 0) return "";
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
      if (id === undefined) return null;
      syncEpoch();
      let raw = gcsValueCache.get(id);
      if (raw !== undefined) return raw;
      gCsCascade += 1;
      raw = session.computed(id);
      gcsValueCache.set(id, raw);
      return raw;
    };

    const fieldString = (field: string, tsType: string): string => {
      if (id === undefined) return "";
      syncEpoch();
      let ser = gcsSerializedCache.get(id);
      if (ser === undefined) {
        ser = new Map();
        gcsSerializedCache.set(id, ser);
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
      if (cssName.startsWith("--")) {
        const raw = ensureRaw();
        return raw === null ? "" : (customPropertiesOf(raw)?.get(cssName) ?? "");
      }
      const shorthandSer = SHORTHAND_COMPUTED[cssName]?.((n) => resolveCssName(n, resolved));
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
          for (const frag of tree.fragments.values()) {
            if (frag.node === id) {
              const box = frag.box.contentBox;
              const px = Number(cssName === "width" ? box.width : box.height);
              return `${px}px`;
            }
          }
        }
      }
      return fieldString(meta.field, meta.tsType);
    };

    const decl: Record<string, unknown> = {
      get length(): number {
        return computedPropertyNames.length + customNames().length;
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
        throw new Error("getComputedStyle declarations are read-only");
      },
      removeProperty: (): never => {
        throw new Error("getComputedStyle declarations are read-only");
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
          return true;
        }
        return Reflect.set(target, prop, value, receiver);
      },
      has(target, prop): boolean {
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

    if (id !== undefined) gcsProxyCache.set(id, proxy);
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
      if (n === undefined || n.kind !== "element" || !isConnectedToDocument(session.dom, focusedNodeId)) {
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
      return fragmentsAt(Number(x), Number(y)).map((id) => makeElementCached(id) as object);
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
    });
    shadowRootWrappers.set(rootId, frag);
    return frag;
  };

  /** Resolve the host element id for a shadow root via the attachShadow map. */
  const nodeIdOfHost = (shadowRootId: NodeId): NodeId => {
    for (const [hostId, entry] of shadowRootIds) {
      if (entry.rootId === shadowRootId) return hostId;
    }
    return shadowRootId;
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
    Document: DocumentCtor,
    DocumentFragment: DocumentFragmentCtor,
    getComputedStyle,
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
export function isConnectedToDocument(dom: DomTree, nodeId: NodeId): boolean {
  let current: NodeId | null | undefined = nodeId;
  const seen = new Set<NodeId>();
  while (current !== null && current !== undefined) {
    if (seen.has(current)) return false;
    seen.add(current);
    if (current === dom.root) return true;
    current = dom.nodes.get(current)?.parent;
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
