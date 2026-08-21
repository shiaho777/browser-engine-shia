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
import { coerceGuestString } from "@browser-engine/guest";

import { parseHtml } from "@browser-engine/html-parser";
import { FineSession } from "./fine.js";

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
export type DocumentApiOptions = {
  readonly geometryMode?: "full" | "throttled" | "stub";
  readonly styleMode?: "full" | "fast";
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
} {
  let mutations = 0;
  const geometryMode = options.geometryMode ?? "full";
  const styleMode = options.styleMode ?? "full";
  const profileGeom = process.env["ENGINE_PROFILE"] === "1";
  let gBcrCalls = 0;
  let gBcrLayoutFulls = 0;
  let gCsCalls = 0;
  let gCsCascade = 0;
  let layoutTreeCache: ReturnType<FineSession["layoutTree"]> | null = null;
  let layoutTreeEpoch = -1;
  let layoutTreeAt = 0;
  const GEOM_THROTTLE_MS = 48;
const resolveLayoutTree = (): ReturnType<FineSession["layoutTree"]> | null => {
    if (geometryMode === "stub") return null;
    if (geometryMode === "full") {
      gBcrLayoutFulls += 1;
      return session.layoutTree();
    }
    const now = performance.now();
    if (
      layoutTreeCache === null ||
      (layoutTreeEpoch !== mutations && now - layoutTreeAt >= GEOM_THROTTLE_MS)
    ) {
      gBcrLayoutFulls += 1;
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
  const elementsByTagName = (scopeRoot: NodeId, want: string): object[] => {
    const out: object[] = [];
    const visit = (id: NodeId): void => {
      for (const childId of session.dom.nodes.get(id)?.children ?? []) {
        const node = session.dom.nodes.get(childId);
        if (node === undefined) continue;
        if (node.kind === "element" && (want === "*" || node.tag === want)) out.push(makeElementCached(childId));
        visit(childId);
      }
    };
    visit(scopeRoot);
    return out;
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
        session.setAttribute(nodeId, htmlAttributeName(name), String(value));
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
      get childNodes(): object[] {
        return childWrappers(nodeId);
      },
      hasChildNodes(): boolean {
        return (session.dom.nodes.get(nodeId)?.children.length ?? 0) > 0;
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
      appendChild(child: unknown): unknown {
        const childId = idFromWrapper(child);
        if (childId !== undefined) {
          session.appendChild(nodeId, childId);
          mutations += 1;
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
      getElementsByTagName(tag: unknown): object[] {
        const want = String(tag).toLowerCase();
        return elementsByTagName(nodeId, want);
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
        return 0;
      },
      set scrollTop(_v: unknown) {},
      get scrollLeft(): number {
        return 0;
      },
      set scrollLeft(_v: unknown) {},
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
  }

  const makeStyleDeclarationCached = (nodeId: NodeId): object => {
    const cached = styleWrappers.get(nodeId);
    if (cached !== undefined) return cached;
    const created = makeStyleDeclaration(nodeId);
    styleWrappers.set(nodeId, created);
    return created;
  };

  const makeStyleDeclaration = (nodeId: NodeId): object => {
    const parse = (): Map<string, StyleDeclarationEntry> => {
      const map = new Map<string, StyleDeclarationEntry>();
      for (const decl of (session.dom.nodes.get(nodeId)?.attrs?.get("style") ?? "").split(";")) {
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
        if (name !== "" && value !== "") map.set(name, { value, priority });
      }
      return map;
    };
    const serialize = (map: Map<string, StyleDeclarationEntry>): string =>
      [...map]
        .map(([k, decl]) => `${k}: ${decl.value}${decl.priority === "important" ? " !important" : ""}`)
        .join("; ");
    const commit = (map: Map<string, StyleDeclarationEntry>): void => {
      session.setAttribute(nodeId, "style", serialize(map));
      mutations += 1;
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
        return parse().get(String(prop))?.value ?? "";
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
        map.set(name, { value: text, priority: priorityText === "" ? "" : "important" });
        commit(map);
      },
      removeProperty(prop: unknown): string {
        const map = parse();
        const oldValue = map.get(String(prop))?.value ?? "";
        map.delete(String(prop));
        commit(map);
        return oldValue;
      },
      get cssText(): string {
        return session.dom.nodes.get(nodeId)?.attrs?.get("style") ?? "";
      },
      set cssText(value: unknown) {
        session.setAttribute(nodeId, "style", String(value));
        mutations += 1;
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
      Object.setPrototypeOf(w, HTMLElementCtor.prototype as object);
    }
    wrapperCache.set(id, w);
    return w;
  };
  const childWrappers = (id: NodeId): object[] =>
    (session.dom.nodes.get(id)?.children ?? []).map((c) => makeElementCached(c));

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

  const replaceInnerHtml = (id: NodeId, html: string): void => {
    const node = session.dom.nodes.get(id);
    if (node === undefined || node.kind === "text" || node.kind === "comment") return;
    for (const child of [...node.children]) {
      session.removeChild(id, child);
    }
    if (html === "") return;
    const tree = parseHtml(new TextEncoder().encode(html));
    const root = tree.nodes.get(tree.root);
    if (root === undefined) return;
    for (const childId of root.children) {
      const child = tree.nodes.get(childId);
      if (child === undefined) continue;
      if (child.kind === "element" && (child.tag === "html" || child.tag === "head" || child.tag === "body")) {
        for (const grand of child.children) {
          const g = tree.nodes.get(grand);
          if (g === undefined) continue;
          const imported = importParsedNode(g, tree);
          if (imported !== null) session.appendChild(id, imported);
        }
        continue;
      }
      const imported = importParsedNode(child, tree);
      if (imported !== null) session.appendChild(id, imported);
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
    const root = tree.nodes.get(tree.root);
    if (root === undefined) return;
    for (const childId of root.children) {
      const child = tree.nodes.get(childId);
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
  const computedPropertyNames = CSS_PROPERTIES.map((p) => p.name);
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

    const item = (index: unknown): string => {
      const n = Number(index);
      if (!Number.isInteger(n) || n < 0) return "";
      return computedPropertyNames[n] ?? "";
    };

    const ensureRaw = (): Record<string, unknown> | null => {
      if (id === undefined) return null;
      let raw = gcsValueCache.get(id);
      if (raw !== undefined) return raw;
      gCsCascade += 1;
      raw = session.computed(id);
      gcsValueCache.set(id, raw);
      return raw;
    };

    const fieldString = (field: string, tsType: string): string => {
      if (id === undefined) return "";
      let ser = gcsSerializedCache.get(id);
      if (ser === undefined) {
        ser = new Map();
        gcsSerializedCache.set(id, ser);
      }
      const cached = ser.get(field);
      if (cached !== undefined) return cached;
      const raw = ensureRaw();
      if (raw === null) return "";
      const out = serializeComputed(tsType, raw[field]);
      ser.set(field, out);
      return out;
    };

    const resolveCssName = (cssName: string): string => {
      const meta = CSS_NAME_TO_META.get(cssName);
      if (meta === undefined) return "";
      return fieldString(meta.field, meta.tsType);
    };

    const decl: Record<string, unknown> = {
      length: computedPropertyNames.length,
      item,
      getPropertyValue: (name: unknown): string => resolveCssName(String(name)),
      getPropertyPriority: (): string => "",
      setProperty: (): never => {
        throw new Error("getComputedStyle declarations are read-only");
      },
      removeProperty: (): never => {
        throw new Error("getComputedStyle declarations are read-only");
      },
      cssText: "",
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
      return "complete";
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
        } catch {
          // Guest/page code may throw here; swallowed by design.
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
    querySelectorAll(selector: unknown): object[] {
      return queryAll(String(selector), null).map((id) => makeElementCached(id));
    },
    getElementsByTagName(tag: unknown): object[] {
      const want = String(tag).toLowerCase();
      return elementsByTagName(session.dom.root, want);
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
    createEvent(_type: unknown): {
      type: string;
      bubbles: boolean;
      cancelable: boolean;
      data: unknown;
      initEvent: (type: unknown, bubbles?: unknown, cancelable?: unknown) => void;
      preventDefault: () => void;
      stopPropagation: () => void;
    } {
      const ev = {
        type: "",
        bubbles: false,
        cancelable: false,
        data: undefined as unknown,
        initEvent(type: unknown, bubbles?: unknown, cancelable?: unknown) {
          this.type = coerceGuestString(type);
          this.bubbles = Boolean(bubbles);
          this.cancelable = Boolean(cancelable);
        },
        preventDefault() {},
        stopPropagation() {},
      };
      return ev;
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
  const domGlobals: Record<string, unknown> = {
    Event: EventCtor,
    Node: NodeCtor,
    Element: ElementCtor,
    HTMLElement: HTMLElementCtor,
    HTMLCanvasElement: HTMLCanvasElementCtor,
    CanvasRenderingContext2D: CanvasRenderingContext2DCtor,
    OffscreenCanvas: OffscreenCanvasCtor,
    SVGElement: SVGElementCtor,
    Document: DocumentCtor,
    DocumentFragment: DocumentFragmentCtor,
    getComputedStyle,
  };
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

/** Whether `nodeId` is currently reachable from the document root. */
function isConnectedToDocument(dom: DomTree, nodeId: NodeId): boolean {
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
