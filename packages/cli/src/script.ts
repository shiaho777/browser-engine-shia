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

import type { DomNode, DomTree, NodeId, StyleRule } from "@browser-engine/ir";
import { CSS_PROPERTIES, parsePropertyValue } from "@browser-engine/generator";
import type { CssPropertyDef } from "@browser-engine/generator";
import { getBoundingClientRect as boundingRect } from "@browser-engine/layout";
import { ruleMatches, parseEasing, sampleEasing, interpolateValue } from "@browser-engine/cascade";
import type { Easing } from "@browser-engine/cascade";

import { FineSession } from "./fine.js";

/** CSS property metadata for CSSOM serialization: css-name → { field, tsType }. */
const CSS_NAME_TO_META = new Map(CSS_PROPERTIES.map((p) => [p.name, { field: p.field, tsType: p.tsType }]));

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
  if (tsType === "Color" && typeof value === "object") {
    const c = value as { r: number; g: number; b: number; a: number };
    return c.a >= 1 ? `rgb(${c.r}, ${c.g}, ${c.b})` : `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})`;
  }
  if (tsType === "Px" && typeof value === "number") return `${value}px`;
  if (tsType === "Edges<Px>" && typeof value === "object") {
    const e = value as { top: number; right: number; bottom: number; left: number };
    return `${e.top}px ${e.right}px ${e.bottom}px ${e.left}px`;
  }
  if (tsType === "LengthOrAuto" || tsType === "LengthSizing") {
    return typeof value === "number" ? `${value}px` : typeof value === "string" ? value : "";
  }
  if (tsType === "TransformValue") {
    return Array.isArray(value) ? `matrix(${value.join(", ")})` : typeof value === "string" ? value : "";
  }
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

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
export function buildDocumentApi(session: FineSession): {
  readonly document: object;
  readonly globals: Record<string, unknown>;
  readonly mutations: () => number;
  readonly tickAnimations: (nowMs: number) => void;
  readonly hasActiveAnimations: () => boolean;
} {
  let mutations = 0;

  // ---- Web Animations: active animations driven by the frame clock --------
  interface ActiveAnimation {
    readonly nodeId: NodeId;
    readonly effect: AnimationEffect;
    startTime: number | null;
    finished: boolean;
    cancelled: boolean;
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

  /** Match a full CSS selector (via the cascade engine) against descendants of
   * `scopeRoot` (or the document when null), returning ids in document order. */
  const queryAll = (selector: string, scopeRoot: NodeId | null): NodeId[] => {
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

  /** Whether `id`'s element matches `selector` (full selector engine). */
  const matchesSel = (id: NodeId, selector: string): boolean => {
    const node = session.dom.nodes.get(id);
    if (node === undefined || node.kind !== "element") return false;
    const rule: StyleRule = { selector: [{ text: selector }], declarations: [], specificity: [0, 0, 0], order: 0 };
    return ruleMatches(rule, session.dom, id);
  };

  /** A guest-visible node wrapper bound to a node id in the session. */
  const makeElement = (nodeId: NodeId): object => {
    const wrapper: Record<string, unknown> = {
      getAttribute(name: unknown): string | null {
        const node = session.dom.nodes.get(nodeId);
        return node?.attrs?.get(String(name)) ?? null;
      },
      setAttribute(name: unknown, value: unknown): void {
        session.setAttribute(nodeId, String(name), String(value));
        mutations += 1;
      },
      hasAttribute(name: unknown): boolean {
        return session.dom.nodes.get(nodeId)?.attrs?.has(String(name)) ?? false;
      },
      removeAttribute(name: unknown): void {
        // Modelled as setting empty (the attrs map keeps the key); enough for
        // reflection-style tests without a dedicated structural op.
        session.setAttribute(nodeId, String(name), "");
        mutations += 1;
      },
      get tagName(): string {
        return (session.dom.nodes.get(nodeId)?.tag ?? "").toUpperCase();
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
        return {
          add(...cs: unknown[]): void {
            const set = tokens();
            for (const c of cs) if (!set.includes(String(c))) set.push(String(c));
            write(set);
          },
          remove(...cs: unknown[]): void {
            const drop = new Set(cs.map(String));
            write(tokens().filter((t) => !drop.has(t)));
          },
          toggle(c: unknown, force?: unknown): boolean {
            const name = String(c);
            const has = tokens().includes(name);
            const shouldHave = force === undefined ? !has : force === true;
            if (shouldHave && !has) write([...tokens(), name]);
            else if (!shouldHave && has) write(tokens().filter((t) => t !== name));
            return shouldHave;
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
            has: (_t, prop): boolean =>
              typeof prop === "string" && (session.dom.nodes.get(nodeId)?.attrs?.has(toKebab(prop)) ?? false),
          },
        );
      },
      get style(): object {
        const parse = (): Map<string, string> => {
          const map = new Map<string, string>();
          for (const decl of (session.dom.nodes.get(nodeId)?.attrs?.get("style") ?? "").split(";")) {
            const idx = decl.indexOf(":");
            if (idx > 0) map.set(decl.slice(0, idx).trim(), decl.slice(idx + 1).trim());
          }
          return map;
        };
        const serialize = (map: Map<string, string>): string =>
          [...map].map(([k, v]) => `${k}: ${v}`).join("; ");
        const commit = (map: Map<string, string>): void => {
          session.setAttribute(nodeId, "style", serialize(map));
          mutations += 1;
        };
        return {
          getPropertyValue(prop: unknown): string {
            return parse().get(String(prop)) ?? "";
          },
          setProperty(prop: unknown, value: unknown): void {
            const map = parse();
            map.set(String(prop), String(value));
            commit(map);
          },
          removeProperty(prop: unknown): void {
            const map = parse();
            map.delete(String(prop));
            commit(map);
          },
          get cssText(): string {
            return session.dom.nodes.get(nodeId)?.attrs?.get("style") ?? "";
          },
          set cssText(value: unknown) {
            session.setAttribute(nodeId, "style", String(value));
            mutations += 1;
          },
        };
      },
      get textContent(): string {
        return textContentOf(session.dom, nodeId);
      },
      set textContent(text: unknown) {
        const child = firstTextChild(session.dom, nodeId);
        if (child !== null) {
          session.setText(child, String(text));
        } else {
          session.appendChild(nodeId, session.createTextNode(String(text)));
        }
        mutations += 1;
      },
      get childNodes(): object[] {
        return childWrappers(nodeId);
      },
      get children(): object[] {
        return childWrappers(nodeId).filter((_w, i) => {
          const childId = session.dom.nodes.get(nodeId)?.children[i];
          return childId !== undefined && session.dom.nodes.get(childId)?.kind === "element";
        });
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
      get nextElementSibling(): object | null {
        return siblingElement(nodeId, 1);
      },
      get previousElementSibling(): object | null {
        return siblingElement(nodeId, -1);
      },
      remove(): void {
        const parent = session.dom.nodes.get(nodeId)?.parent ?? null;
        if (parent !== null) {
          session.removeChild(parent, nodeId);
          mutations += 1;
        }
      },
      appendChild(child: unknown): unknown {
        const childId = idFromWrapper(child);
        if (childId !== undefined) {
          session.appendChild(nodeId, childId);
          mutations += 1;
        }
        return child;
      },
      removeChild(child: unknown): unknown {
        const childId = idFromWrapper(child);
        if (childId !== undefined) {
          session.removeChild(nodeId, childId);
          mutations += 1;
        }
        return child;
      },
      insertBefore(child: unknown, ref: unknown): unknown {
        const childId = idFromWrapper(child);
        const refId = idFromWrapper(ref) ?? null;
        if (childId !== undefined) {
          session.insertBefore(nodeId, childId, refId);
          mutations += 1;
        }
        return child;
      },
      getElementsByTagName(tag: unknown): object[] {
        const want = String(tag).toLowerCase();
        const out: object[] = [];
        const visit = (id: NodeId): void => {
          for (const childId of session.dom.nodes.get(id)?.children ?? []) {
            const node = session.dom.nodes.get(childId);
            if (node === undefined) continue;
            if (node.kind === "element" && (want === "*" || node.tag === want)) out.push(makeElementCached(childId));
            visit(childId);
          }
        };
        visit(nodeId);
        return out;
      },
      querySelector(selector: unknown): object | null {
        const ids = queryAll(String(selector), nodeId);
        return ids.length > 0 ? makeElementCached(ids[0] as NodeId) : null;
      },
      querySelectorAll(selector: unknown): object[] {
        return queryAll(String(selector), nodeId).map((id) => makeElementCached(id));
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
        dispatch(nodeId, makeEvent("click", { bubbles: true, cancelable: true }));
      },
      getBoundingClientRect(): object {
        const r = boundingRect(session.layoutTree(), nodeId);
        const x = Number(r.x);
        const y = Number(r.y);
        const w = Number(r.width);
        const h = Number(r.height);
        return { x, y, width: w, height: h, top: y, left: x, right: x + w, bottom: y + h };
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
        return {
          cancel(): void {
            anim.cancelled = true;
          },
          finish(): void {
            anim.finished = true;
          },
          get playState(): string {
            return anim.cancelled ? "idle" : anim.finished ? "finished" : anim.startTime === null ? "pending" : "running";
          },
        };
      },
    };
    idOf.set(wrapper, nodeId);
    return wrapper;
  };

  /** Cache wrappers per node id so repeated lookups return a stable object. */
  const wrapperCache = new Map<NodeId, object>();
  const makeElementCached = (id: NodeId): object => {
    const cached = wrapperCache.get(id);
    if (cached !== undefined) return cached;
    const w = makeElement(id);
    wrapperCache.set(id, w);
    return w;
  };
  const childWrappers = (id: NodeId): object[] =>
    (session.dom.nodes.get(id)?.children ?? []).map((c) => makeElementCached(c));

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

  /** Invoke the listeners registered on `node` for this phase; honour stop flags. */
  function invokeAt(node: NodeId, evt: GuestEvent, capturePhase: boolean): void {
    const list = listeners.get(node);
    if (list === undefined) return;
    evt.currentTarget = makeElementCached(node);
    for (const l of [...list]) {
      if (l.type !== evt.type) continue;
      const isTargetNode = idOf.get(evt.currentTarget) === node && evt.eventPhase === 2;
      if (!isTargetNode && l.capture !== capturePhase) continue;
      l.fn.call(evt.currentTarget, evt);
      if (evt.__stopImmediate) return;
    }
  }

  /** Dispatch `event` to `targetId` through capture/target/bubble phases. */
  function dispatch(targetId: NodeId, event: GuestEvent): boolean {
    const path = ancestorPath(targetId); // [target, ...ancestors, root]
    event.target = makeElementCached(targetId);
    // Capture phase: root → just above target.
    event.eventPhase = 1;
    for (let i = path.length - 1; i >= 1; i -= 1) {
      invokeAt(path[i] as NodeId, event, true);
      if (event.__stop) {
        event.eventPhase = 0;
        return !event.defaultPrevented;
      }
    }
    // Target phase.
    event.eventPhase = 2;
    invokeAt(targetId, event, false);
    // Bubble phase: just above target → root.
    if (event.bubbles && !event.__stop) {
      event.eventPhase = 3;
      for (let i = 1; i < path.length; i += 1) {
        invokeAt(path[i] as NodeId, event, false);
        if (event.__stop) break;
      }
    }
    event.eventPhase = 0;
    event.currentTarget = null;
    return !event.defaultPrevented;
  }

  /** The guest `Event` constructor (`new Event(type, { bubbles, cancelable })`). */
  function EventCtor(this: unknown, type: unknown, opts: unknown): GuestEvent {
    const o = typeof opts === "object" && opts !== null ? (opts as { bubbles?: boolean; cancelable?: boolean }) : {};
    return makeEvent(String(type), { bubbles: o.bubbles === true, cancelable: o.cancelable === true });
  }

  /** `window.getComputedStyle(el)` — a read-only CSSOM declaration over the
   * node's resolved {@link ComputedStyle} (the cascade product). */
  function getComputedStyle(el: unknown): object {
    const id = idFromWrapper(el);
    const decl: Record<string, unknown> = {};
    if (id !== undefined) {
      const cs = session.computed(id) as unknown as Record<string, unknown>;
      for (const [, meta] of CSS_NAME_TO_META) {
        decl[meta.field] = serializeComputed(meta.tsType, cs[meta.field]);
      }
    }
    decl["getPropertyValue"] = (name: unknown): string => {
      const meta = CSS_NAME_TO_META.get(String(name));
      if (meta === undefined) return "";
      const v = decl[meta.field];
      return typeof v === "string" ? v : "";
    };
    return decl;
  }

  const document = {
    getElementById(id: unknown): object | null {
      return wrap(findById(session.dom, String(id)));
    },
    querySelector(selector: unknown): object | null {
      const ids = queryAll(String(selector), null);
      return ids.length > 0 ? makeElementCached(ids[0] as NodeId) : null;
    },
    querySelectorAll(selector: unknown): object[] {
      return queryAll(String(selector), null).map((id) => makeElementCached(id));
    },
    getElementsByTagName(tag: unknown): object[] {
      const want = String(tag).toLowerCase();
      const out: object[] = [];
      for (const [id, node] of session.dom.nodes) {
        if (node.kind === "element" && (want === "*" || node.tag === want)) out.push(makeElementCached(id));
      }
      return out;
    },
    createElement(tag: unknown): object {
      const id = session.createElement(String(tag));
      mutations += 1;
      return makeElementCached(id);
    },
    createTextNode(text: unknown): object {
      const id = session.createTextNode(String(text));
      mutations += 1;
      return makeElementCached(id);
    },
  };

  const domGlobals: Record<string, unknown> = { Event: EventCtor, getComputedStyle };
  return {
    document,
    globals: domGlobals,
    mutations: () => mutations,
    tickAnimations,
    hasActiveAnimations,
  };
}

// ---------------------------------------------------------------------------
// Minimal DOM queries over the session's current DOM.
// ---------------------------------------------------------------------------

/** Find the first element whose `id` attribute equals `id`. */
function findById(dom: DomTree, id: string): NodeId | null {
  return findElement(dom, (n) => (n.attrs?.get("id") ?? null) === id);
}

/** First element node (document order from root) satisfying `pred`. */
function findElement(dom: DomTree, pred: (n: DomNode) => boolean): NodeId | null {
  let found: NodeId | null = null;
  const visit = (id: NodeId): void => {
    if (found !== null) return;
    const node = dom.nodes.get(id);
    if (node === undefined) return;
    if (node.kind === "element" && pred(node)) {
      found = id;
      return;
    }
    for (const child of node.children) visit(child);
  };
  visit(dom.root);
  return found;
}

/** The id of an element's first text-node child, or `null`. */
function firstTextChild(dom: DomTree, element: NodeId): NodeId | null {
  const node = dom.nodes.get(element);
  if (node === undefined) return null;
  for (const childId of node.children) {
    const child = dom.nodes.get(childId);
    if (child !== undefined && child.kind === "text") {
      return childId;
    }
  }
  return null;
}

/** The concatenated text of an element's text-node children. */
function textContentOf(dom: DomTree, element: NodeId): string {
  const node = dom.nodes.get(element);
  if (node === undefined) return "";
  let text = "";
  for (const childId of node.children) {
    const child = dom.nodes.get(childId);
    if (child !== undefined && child.kind === "text") {
      text += child.text ?? "";
    }
  }
  return text;
}
