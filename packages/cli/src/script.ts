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

import type { DecodedImage, DomNode, DomTree, Fragment, NodeId, StyleRule } from "@browser-engine/ir";
import { Canvas2DEngine, Path2DImpl, canvas2dApi } from "./canvas2d.js";
import { WebGLCore, type GLContextAttributes } from "@browser-engine/gpu";
import { makeWebGLContext, webglBitmap, WebGLRenderingContextProto } from "./webgl.js";
import { CSS_PROPERTIES, canonicalGridAreas, canonicalGridLine, canonicalTrackList, expandShorthand, isGridLineProperty, isSpecifiedCalc, isSpecifiedLength, parsePropertyValue, resolveTrackList, serializeFlexFlow, serializeGrid, serializeGridArea, serializeGridPlacement, serializeGridTemplate, shorthandLonghands } from "@browser-engine/generator";
import { canonicalCssValue } from "./css-supports.js";
import { serializeMediaQueryList, type MediaEnvironment } from "@browser-engine/css-parser";
import type { CssPropertyDef } from "@browser-engine/generator";
import { getBoundingClientRect as boundingRect } from "@browser-engine/layout";
import { ruleMatches, parseEasing, sampleEasing, interpolateValue } from "@browser-engine/cascade";
import {
  computeValidity,
  controlChecked as domChecked,
  controlDisabled as domDisabled,
  controlSelected as domSelected,
  controlValueOf,
  inputType,
  radioGroupPeers,
  selectOptions,
  valueAsNumber,
  willValidate as domWillValidate,
} from "@browser-engine/cascade";
import type { Easing, ValidityFlags } from "@browser-engine/cascade";
import {
  coerceGuestString,
  CustomEvent as CustomEvent,
  DOMException,
  Event as Event,
  UIEvent as UIEvent,
  MouseEvent as MouseEvent,
  PointerEvent as PointerEvent,
  KeyboardEvent as KeyboardEvent,
  FocusEvent as FocusEvent,
  InputEvent as InputEvent,
  WheelEvent as WheelEvent,
  CompositionEvent as CompositionEvent,
  MessageEvent as MessageEvent,
  CloseEvent as CloseEvent,
  makeWebSocketApi,
  makeBlobClass,
  WrapperCache,
  type WsTransport,
  type WebSocketApi,
} from "@browser-engine/guest";

import { parseHtml } from "@browser-engine/html-parser";
import { createBlankFrame, type BlankFrame } from "./blank-frame.js";
import { createMatchMedia } from "./match-media.js";
import { FineSession, type DomMutation } from "./fine.js";
import { MediaEngine, mediaDescriptors, nodeMediaClock, type MediaClock } from "./media.js";

function CSSMediaRule() {}
function CSSStyleRule() {}

/** `@media <prelude> {` → serialized prelude, or null when the rule is not `@media`. */
function mediaRulePrelude(cssText: string): string | null {
  const trimmed = cssText.trim();
  const header = /^@media\b/i.exec(trimmed);
  if (header === null) return null;
  let depth = 0;
  for (let i = header[0].length; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (ch === "{" && depth <= 0) {
      return serializeMediaQueryList(trimmed.slice(header[0].length, i));
    }
  }
  return "not all";
}

function cssRuleObject(cssText: string): object {
  const trimmed = cssText.trim();
  const prelude = mediaRulePrelude(trimmed);
  if (prelude !== null) {
    const open = trimmed.indexOf("{");
    const close = trimmed.lastIndexOf("}");
    const body = open >= 0 && close > open ? trimmed.slice(open + 1, close) : "";
    return {
      cssText: trimmed,
      type: 4,
      conditionText: prelude,
      media: { mediaText: prelude },
      cssRules: splitCssBlocks(body).map(cssRuleObject),
      constructor: CSSMediaRule,
    };
  }
  const style = /^([^{]+)\{([^}]*)\}$/.exec(trimmed);
  if (style !== null) {
    return {
      cssText: trimmed,
      selectorText: (style[1] ?? "").trim(),
      style: declarationStyle(style[2] ?? ""),
      constructor: CSSStyleRule,
    };
  }
  return { cssText: trimmed };
}

function splitCssBlocks(text: string): string[] {
  const rules: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const rule = text.slice(start, i + 1).trim();
        if (rule !== "") rules.push(rule);
        let j = i + 1;
        while (j < text.length && /\s/.test(text[j] ?? "")) j += 1;
        start = j;
        i = j - 1;
      }
    }
  }
  return rules;
}

function declarationStyle(body: string): Record<string, string> {
  const style: Record<string, string> = {};
  for (const part of body.split(";")) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    const name = part.slice(0, colon).trim();
    const value = part.slice(colon + 1).trim();
    if (name === "") continue;
    style[name] = value;
    style[name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value;
  }
  return style;
}

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

function serializeUnresolvedLength(value: unknown): string {
  if (isSpecifiedLength(value)) return `${value.value}${value.unit}`;
  if (isSpecifiedCalc(value)) return `calc(${serializeCalcNode(value.ast)})`;
  return "";
}

function serializeCalcNode(node: { type: string; value?: number; unit?: string; left?: unknown; right?: unknown }): string {
  if (node.type === "px") return `${node.value}px`;
  if (node.type === "len") return `${node.value}${node.unit ?? ""}`;
  if (node.type === "num") return String(node.value);
  const left = serializeCalcNode(node.left as typeof node);
  const right = serializeCalcNode(node.right as typeof node);
  const op = node.type === "add" ? " + " : node.type === "sub" ? " - " : node.type === "mul" ? " * " : " / ";
  return `${left}${op}${right}`;
}

/**
 * Specified value of `flex` / `flex-flow`, rebuilt from the longhands the
 * shorthand expanded into. `null` means this name is not that shorthand, or
 * its longhands are not all present (the raw declaration, if any, still wins).
 */
/** `flex-grow` / `flex-shrink` accept a unitless `calc()`; fold constants to `calc(n)`. */
function canonicalFlexComponent(property: string, value: string): string | null {
  const text = value.trim();
  // Specified flex-basis keeps `calc()` (the computed value resolves it later).
  // `calc(3px)` must not collapse to `3px` at specified-value time.
  if (property === "flex-basis" && /^calc\(/i.test(text) && text.endsWith(")")) {
    return text.replace(/\s+/g, " ");
  }
  const canon = canonicalCssValue(property, value);
  if (canon !== null) return canon;
  if (property !== "flex-grow" && property !== "flex-shrink") return null;
  if (!/^calc\(/i.test(text) || !text.endsWith(")")) return null;
  const inner = text.slice(5, -1);
  if (/[a-z%]/i.test(inner)) return null;
  const n = evalUnitlessCalc(inner);
  return n === null ? null : `calc(${n})`;
}

/** Evaluate a unitless `calc()` body (`2 + 1`, `-1`). Returns null if it is not pure arithmetic. */
function evalUnitlessCalc(input: string): number | null {
  const compact = input.replace(/\s+/g, "");
  const tokens = compact.match(/\d*\.?\d+|[()+\-*/]/g);
  if (tokens === null || tokens.join("") !== compact) return null;
  let i = 0;
  const parseExpr = (): number | null => {
    let left = parseTerm();
    if (left === null) return null;
    while (tokens[i] === "+" || tokens[i] === "-") {
      const op = tokens[i];
      i += 1;
      const right = parseTerm();
      if (right === null) return null;
      left = op === "+" ? left + right : left - right;
    }
    return left;
  };
  const parseTerm = (): number | null => {
    let left = parseFactor();
    if (left === null) return null;
    while (tokens[i] === "*" || tokens[i] === "/") {
      const op = tokens[i];
      i += 1;
      const right = parseFactor();
      if (right === null || (op === "/" && right === 0)) return null;
      left = op === "*" ? left * right : left / right;
    }
    return left;
  };
  const parseFactor = (): number | null => {
    const tok = tokens[i];
    if (tok === undefined) return null;
    if (tok === "+" || tok === "-") {
      i += 1;
      const inner = parseFactor();
      return inner === null ? null : tok === "-" ? -inner : inner;
    }
    if (tok === "(") {
      i += 1;
      const inner = parseExpr();
      if (inner === null || tokens[i] !== ")") return null;
      i += 1;
      return inner;
    }
    if (/^(?:\d+\.?\d*|\.\d+)$/.test(tok)) {
      i += 1;
      const n = Number(tok);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };
  const result = parseExpr();
  return result === null || i !== tokens.length || !Number.isFinite(result) ? null : result;
}

/** Computed `flex-basis`: negative lengths clamp to 0; a pure percentage calc simplifies. */
function cssLength(serialized: string): number | null {
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(serialized.trim());
  if (match === null) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

function serializeFlexBasisComputed(raw: string): string {
  const pxMatch = /^(-?[\d.]+)px$/.exec(raw);
  if (pxMatch !== null) {
    const n = Number(pxMatch[1]);
    return Number.isFinite(n) && n < 0 ? "0px" : raw;
  }
  const flat = raw.replace(/\s+/g, "");
  const onlyPct = /^calc\(([+-]?\d*\.?\d+)%\)$/.exec(flat);
  if (onlyPct !== null) return `${onlyPct[1]}%`;
  const pctPlusZero = /^calc\(([+-]?\d*\.?\d+)%\+0px\)$/.exec(flat);
  if (pctPlusZero !== null) return `${pctPlusZero[1]}%`;
  return raw;
}

function specifiedShorthand(name: string, map: ReadonlyMap<string, { value: string }>): string | null {
  if (name === "flex") {
    const grow = map.get("flex-grow");
    const shrink = map.get("flex-shrink");
    const basis = map.get("flex-basis");
    if (grow === undefined || shrink === undefined || basis === undefined) return null;
    return `${grow.value} ${shrink.value} ${basis.value}`;
  }
  if (name === "flex-flow") {
    const direction = map.get("flex-direction");
    const wrap = map.get("flex-wrap");
    if (direction === undefined || wrap === undefined) return null;
    return serializeFlexFlow(direction.value, wrap.value);
  }
  const read = (key: string): string | null => map.get(key)?.value ?? null;
  if (name === "grid-column" || name === "grid-row") {
    const axis = name === "grid-column" ? "column" : "row";
    const start = read(`grid-${axis}-start`);
    const end = read(`grid-${axis}-end`);
    if (start === null || end === null) return null;
    return serializeGridPlacement(start, end);
  }
  if (name === "grid-area") {
    const rowStart = read("grid-row-start");
    const columnStart = read("grid-column-start");
    const rowEnd = read("grid-row-end");
    const columnEnd = read("grid-column-end");
    if (rowStart === null || columnStart === null || rowEnd === null || columnEnd === null) return null;
    return serializeGridArea(rowStart, columnStart, rowEnd, columnEnd);
  }
  if (name === "grid-template") {
    const rows = read("grid-template-rows");
    const columns = read("grid-template-columns");
    const areas = read("grid-template-areas");
    if (rows === null || columns === null || areas === null) return null;
    return serializeGridTemplate(rows, columns, areas);
  }
  if (name === "grid") {
    const rows = read("grid-template-rows");
    const columns = read("grid-template-columns");
    const areas = read("grid-template-areas");
    const autoRows = read("grid-auto-rows");
    const autoColumns = read("grid-auto-columns");
    const flow = read("grid-auto-flow");
    if (rows === null || columns === null || areas === null || autoRows === null || autoColumns === null || flow === null) {
      return null;
    }
    return serializeGrid(rows, columns, areas, autoRows, autoColumns, flow);
  }
  return null;
}

interface StyleBlockEntry {
  value: string;
  priority: "" | "important";
}

/** Parse a cssText declaration block, expanding shorthands into longhands. */
function styleBlockFromCssText(text: string): Map<string, StyleBlockEntry> {
  const map = new Map<string, StyleBlockEntry>();
  for (const piece of text.split(";")) {
    const idx = piece.indexOf(":");
    if (idx <= 0) continue;
    const name = piece.slice(0, idx).trim().toLowerCase();
    let raw = piece.slice(idx + 1).trim();
    let priority: "" | "important" = "";
    const important = /!\s*important\s*$/i.exec(raw);
    if (important !== null) {
      priority = "important";
      raw = raw.slice(0, important.index).trim();
    }
    if (name === "" || raw === "") continue;
    const longhands = shorthandLonghands(name);
    if (longhands !== null) {
      const expanded = expandShorthand(name, raw);
      if (expanded === null) continue;
      const stored: { property: string; value: string }[] = [];
      let ok = true;
      for (const decl of expanded) {
        const canon = canonicalFlexComponent(decl.property, decl.value);
        if (canon === null) {
          ok = false;
          break;
        }
        stored.push({ property: decl.property, value: canon });
      }
      if (!ok) continue;
      map.delete(name);
      for (const longhand of longhands) map.delete(longhand);
      for (const decl of stored) map.set(decl.property, { value: decl.value, priority });
      continue;
    }
    if (isGridLineProperty(name)) {
      const line = canonicalGridLine(name, raw);
      if (line === null) continue;
      map.set(name, { value: line, priority });
      continue;
    }
    if (name === "grid-template-areas") {
      const areas = canonicalGridAreas(raw);
      if (areas === null) continue;
      map.set(name, { value: areas, priority });
      continue;
    }
    map.set(name, { value: raw, priority });
  }
  return map;
}

/**
 * Declaration block text. A shorthand whose longhands round-trip is emitted in
 * place of those longhands. A block that is only that shorthand keeps a trailing
 * semicolon so `grid: 10px / 20px;` matches the CSSOM serialization tests.
 */
function serializeStyleBlock(map: ReadonlyMap<string, StyleBlockEntry>): string {
  const skip = new Set<string>();
  const prefix: string[] = [];
  const tryShorthand = (name: string): void => {
    const longhands = shorthandLonghands(name);
    if (longhands === null || longhands.some((key) => !map.has(key) || skip.has(key))) return;
    const serial = specifiedShorthand(name, map);
    if (serial === null || serial === "") return;
    const expanded = expandShorthand(name, serial);
    if (expanded === null) return;
    for (const longhand of longhands) {
      const produced = expanded.find((decl) => decl.property === longhand);
      if (produced === undefined) return;
      const canon = canonicalFlexComponent(produced.property, produced.value);
      if (canon !== map.get(longhand)?.value) return;
    }
    prefix.push(`${name}: ${serial}`);
    for (const longhand of longhands) skip.add(longhand);
  };
  tryShorthand("grid");
  tryShorthand("grid-template");
  tryShorthand("grid-area");
  tryShorthand("grid-column");
  tryShorthand("grid-row");
  tryShorthand("flex");
  tryShorthand("flex-flow");
  const rest = [...map]
    .filter(([key]) => !skip.has(key))
    .map(([key, decl]) => `${key}: ${decl.value}${decl.priority === "important" ? " !important" : ""}`);
  if (prefix.length === 0) return rest.join("; ");
  const body = rest.length === 0 ? prefix.join("; ") : `${prefix.join("; ")}; ${rest.join("; ")}`;
  return body.endsWith(";") ? body : `${body};`;
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
    if (typeof value === "number") return `${value}px`;
    if (typeof value === "string") return value;
    return serializeUnresolvedLength(value);
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
/**
 * What activation behavior hands the navigation host (RFC 0011): link clicks
 * carry `target`; form submissions may carry `method`/`body`/`contentType`.
 */
export interface ActivationInit {
  readonly replace?: boolean;
  readonly target?: string;
  readonly method?: string;
  readonly body?: string;
  readonly contentType?: string;
  /** Element-level `referrerpolicy` attr — overrides the document policy. */
  readonly referrerPolicy?: string;
}

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
   * RFC 0011: full-navigation sink for activation behavior — a/area clicks
   * and form submissions resolve here. `init` carries the spec inputs the
   * host needs: `target` (link/form target), `method`/`body`/`contentType`
   * (form POST). Fragment hops prefer the host too when this is set — the
   * host performs the same-document check and history entry itself.
   */
  readonly navigator?: (url: string, init?: ActivationInit) => void;
  /**
   * RFC 0013: resolves an iframe element's nested browsing context to its
   * window proxy (for `iframe.contentWindow`). Lazily read per access — the
   * host populates frames after child documents load.
   */
  readonly frameLookup?: (nodeId: NodeId) => unknown;
  /**
   * Animation-frame scheduler shared with `requestAnimationFrame`. Blank
   * iframes deliver resize and media-query change events on it.
   */
  readonly scheduleFrame?: (cb: () => void) => void;
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
   * Microtask scheduler for observer delivery (MutationObserver records and
   * Resize/IntersectionObserver entries both ride the microtask queue). The
   * virtual-event-loop runner injects `loop.microtask` so observer callbacks
   * interleave with guest `queueMicrotask` calls in true FIFO order; callers
   * on a real event loop leave this unset and get the ambient queue.
   */
  readonly queueMicrotask?: (fn: () => void) => void;
  /**
   * RFC 0033: resolves a `drawImage(imgEl)` source — the element's decoded
   * pixels from the page's resource pass (`PageState.decodedImages`,
   * updated lazily as images land). Absent ⇒ image sources draw nothing.
   */
  readonly canvasImageSource?: (nodeId: NodeId) => DecodedImage | undefined;
  /**
   * Live viewport geometry for IntersectionObserver root-bounds and layout —
   * a getter because scrolling moves the viewport in document space between
   * evaluations. Defaults to an 800×600 viewport at scroll origin.
   */
  readonly viewport?: () => {
    readonly width: number;
    readonly height: number;
    readonly scrollY: number;
  };
  /**
   * Error sink for exceptions thrown by guest event listeners that the
   * document object dispatches directly (DOMContentLoaded lifecycle,
   * document.dispatchEvent): per HTML each listener error is reported as an
   * uncaught exception and independent listeners still run. The runner
   * connects this to its uncaught-error record.
   */
  readonly onListenerError?: (error: unknown) => void;
  /**
   * RFC 0022: WebSocket transport — a raw duplex byte channel to ws:/wss:
   * endpoints (`nodeWsTransport` for real sockets, `createWsLoopback` for
   * tests). When unset, `new WebSocket(...)` still works but every
   * connection fails the spec-shaped way (error + unclean close events).
   */
  readonly wsTransport?: WsTransport;
  /**
   * RFC 0035: the document's media engine — created by the host (engine-
   * runtime) so scriptless pages still load/probe/frame media; here it gets
   * bound to dispatch + the page clock and the element IDL surface.
   */
  readonly media?: MediaEngine;
  /** Page-clock adapter for media timers (loop clock in the classic runner). */
  readonly mediaClock?: MediaClock;
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
  /** RFC 0011: dispatch click + activation behavior on a node (UI clicks). */
  readonly clickElement: (nodeId: NodeId) => void;
  /** RFC 0013: dispatch an event at an element (iframe `load`, …). */
  readonly dispatchElementEvent: (nodeId: NodeId, type: string, init?: Record<string, unknown>) => void;
  /** RFC 0020: UI-input synthesis — pointer/mouse/keyboard/focus/tab. */
  readonly ui: {
    readonly pointerMove: (nodeId: NodeId, init?: Record<string, unknown>) => void;
    readonly click: (nodeId: NodeId, init?: Record<string, unknown>) => void;
    readonly contextMenu: (nodeId: NodeId, init?: Record<string, unknown>) => void;
    readonly dblClick: (nodeId: NodeId, init?: Record<string, unknown>) => void;
    readonly key: (detail: { key: string; code?: string; repeat?: boolean; location?: number;
                           ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean }) => void;
    readonly tab: (dir: 1 | -1) => void;
    readonly focusedId: () => NodeId | null;
  };
  /**
   * RFC 0022: bind the guest realm's intrinsics to the WebSocket api after
   * `vm.createContext` — `bindWsRealm({ArrayBuffer, TypeError})`. Realm-bound
   * objects pass guest `instanceof` checks (same pattern as fetch realm
   * errors). Idempotent; safe to skip when no ws transport is configured.
   */
  readonly bindWsRealm: (realm: {
    ArrayBuffer?: new (length: number) => ArrayBuffer;
    TypeError?: new (message: string) => Error;
  }) => void;
  /**
   * RFC 0033: rasterize every live `<canvas>`'s recorded op log to its
   * current bitmap — pulled lazily by the paint path each frame, so canvas
   * draws land without a mutation-cascade round-trip.
   */
  readonly canvasBitmaps: () => ReadonlyMap<NodeId, DecodedImage>;
} {
  let compileInlineHandler: ((body: string) => unknown) | null = null;
  let navigateToHashFragment: ((fragment: string) => void) | null = null;
  const navigatorSink = options.navigator ?? null;
  const frameLookup = options.frameLookup ?? null;
  const blankFrames = new Map<NodeId, BlankFrame>();
  const srcdocFrames = new Map<NodeId, { readonly session: FineSession; readonly window: object }>();
  const scheduleFrame = options.scheduleFrame ?? ((cb: () => void) => queueMicrotask(cb));
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
  /**
   * Fragment boxes are in the parent fragment's margin-origin coordinates.
   * `getBoundingClientRect` / `offset*` need the viewport border box, so walk
   * each ancestor's margin-box origin and add this box.
   */
  const viewportBorder = (
    tree: NonNullable<ReturnType<FineSession["layoutTree"]>>,
    nodeId: NodeId,
  ): { x: number; y: number; width: number; height: number } | null => {
    const byNode = new Map<NodeId, { id: number; frag: (typeof tree.fragments extends ReadonlyMap<infer _, infer V> ? V : never) }>();
    const parentOf = new Map<number, number>();
    for (const [id, frag] of tree.fragments) {
      const fid = Number(id);
      if (!byNode.has(frag.node)) byNode.set(frag.node, { id: fid, frag });
      for (const child of frag.children) parentOf.set(Number(child), fid);
    }
    const target = byNode.get(nodeId);
    if (target === undefined) return null;
    const originOf = new Map<number, { x: number; y: number }>();
    const origin = (id: number): { x: number; y: number } => {
      const cached = originOf.get(id);
      if (cached !== undefined) return cached;
      const parentId = parentOf.get(id);
      if (parentId === undefined) {
        const root = { x: 0, y: 0 };
        originOf.set(id, root);
        return root;
      }
      const parent = tree.fragments.get(parentId as never);
      const parentOrigin = origin(parentId);
      const box = parent?.box;
      const next = {
        x: parentOrigin.x + Number(box?.marginBox.x ?? 0),
        y: parentOrigin.y + Number(box?.marginBox.y ?? 0),
      };
      originOf.set(id, next);
      return next;
    };
    const box = target.frag.box.borderBox;
    const at = origin(target.id);
    return {
      x: at.x + Number(box.x),
      y: at.y + Number(box.y),
      width: Number(box.width),
      height: Number(box.height),
    };
  };
  const rectFromTree = (
    tree: ReturnType<FineSession["layoutTree"]> | null,
    nodeId: NodeId,
  ): { x: number; y: number; width: number; height: number; top: number; left: number; right: number; bottom: number } => {
    if (tree === null) {
      return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
    }
    const placed = viewportBorder(tree, nodeId);
    const r = placed ?? boundingRect(tree, nodeId);
    const x = Number(r.x);
    const y = Number(r.y);
    const w = Number(r.width);
    const h = Number(r.height);
    return { x, y, width: w, height: h, top: y, left: x, right: x + w, bottom: y + h };
  };

  /**
   * Element scroll positions and the document (root) scroll. Layout still
   * places sticky boxes against scroll 0; CSSOM re-applies the live scroll
   * when reading `offset*` and `getBoundingClientRect`.
   */
  const elementScroll = new Map<NodeId, { top: number; left: number }>();
  const templateFragments = new Map<NodeId, NodeId>();
  let documentScrollX = 0;
  let documentScrollY = 0;

  const axisLength = (value: unknown): number => {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : 0;
  };
  const borderEdge = (style: Record<string, unknown> | null, key: string): number => {
    if (style === null) return 0;
    const v = style[key];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  };
  const styleOf = (id: NodeId): Record<string, unknown> | null => {
    try {
      return session.computed(id);
    } catch {
      return null;
    }
  };
  const paddingOriginOf = (
    tree: NonNullable<ReturnType<FineSession["layoutTree"]>>,
    id: NodeId,
  ): { x: number; y: number } | null => {
    const box = viewportBorder(tree, id);
    if (box === null) return null;
    const style = styleOf(id);
    return {
      x: box.x + borderEdge(style, "borderLeftWidth"),
      y: box.y + borderEdge(style, "borderTopWidth"),
    };
  };
  const offsetParentId = (id: NodeId): NodeId | null => {
    let current = session.dom.nodes.get(id)?.parent ?? null;
    while (current !== null) {
      const node = session.dom.nodes.get(current);
      if (node === undefined || node.kind !== "element") break;
      const position = styleOf(current)?.["position"];
      if (typeof position === "string" && position !== "static") return current;
      if (node.tag === "body" || node.tag === "html") return current;
      current = node.parent;
    }
    return null;
  };
  const scrollsOnAxis = (value: unknown): boolean =>
    value === "auto" || value === "scroll" || value === "hidden";
  const isScrollportNode = (id: NodeId): boolean => {
    const style = styleOf(id);
    if (style === null) return false;
    // The `overflow` shorthand is not always expanded into the longhands, so a
    // computed `overflow: hidden` must still make a scrollport.
    if (scrollsOnAxis(style["overflow"])) return true;
    return scrollsOnAxis(style["overflowX"]) || scrollsOnAxis(style["overflowY"]);
  };
  const nearestScrollport = (id: NodeId): NodeId | null => {
    let current = session.dom.nodes.get(id)?.parent ?? null;
    while (current !== null) {
      const node = session.dom.nodes.get(current);
      if (node === undefined || node.kind !== "element") break;
      if (isScrollportNode(current)) return current;
      current = node.parent;
    }
    return null;
  };
  const insetPx = (style: Record<string, unknown> | null, key: string): number | null => {
    if (style === null) return null;
    const value = style[key];
    if (value === "auto" || value === undefined || value === null) return null;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const matched = /^(-?\d+(?:\.\d+)?)px$/.exec(value.trim());
      return matched === null ? null : Number(matched[1]);
    }
    if (typeof value === "object") {
      const box = value as { value?: unknown; unit?: unknown };
      if (typeof box.value === "number" && Number.isFinite(box.value) && (box.unit === "px" || box.unit === undefined)) {
        return box.value;
      }
    }
    return null;
  };
  /**
   * Scroll-0 layout already pins a sticky box to its inset. Adding the live
   * scroll on top of that used position reproduces `scroll + inset`, then
   * clamps the box inside its parent's border box.
   */
  const stickyContentBox = (
    tree: NonNullable<ReturnType<FineSession["layoutTree"]>>,
    id: NodeId,
    flow: { x: number; y: number; width: number; height: number },
  ): { x: number; y: number; width: number; height: number } => {
    const style = styleOf(id);
    if (style?.["position"] !== "sticky") return flow;
    const port = nearestScrollport(id);
    const scroll = port === null
      ? { top: documentScrollY, left: documentScrollX }
      : (elementScroll.get(port) ?? { top: 0, left: 0 });
    const portOrigin = port === null ? { x: 0, y: 0 } : (paddingOriginOf(tree, port) ?? { x: 0, y: 0 });
    const portBox = port === null ? null : viewportBorder(tree, port);
    const portW = portBox?.width ?? options.viewport?.().width ?? 800;
    const portH = portBox?.height ?? options.viewport?.().height ?? 600;
    let visualX = flow.x - portOrigin.x - scroll.left;
    let visualY = flow.y - portOrigin.y - scroll.top;
    const insetL = insetPx(style, "left");
    const insetR = insetPx(style, "right");
    const insetT = insetPx(style, "top");
    const insetB = insetPx(style, "bottom");
    if (insetL !== null) visualX = Math.max(visualX, insetL);
    if (insetT !== null) visualY = Math.max(visualY, insetT);
    if (insetR !== null) visualX = Math.min(visualX, portW - insetR - flow.width);
    if (insetB !== null) visualY = Math.min(visualY, portH - insetB - flow.height);
    const parent = session.dom.nodes.get(id)?.parent ?? null;
    if (parent !== null && parent === port) {
      // The scrollport's padding edge stays at the visual origin. Its own
      // scroll must not slide that edge out from under the sticky box.
      visualX = Math.min(Math.max(visualX, 0), Math.max(0, portW - flow.width));
      visualY = Math.min(Math.max(visualY, 0), Math.max(0, portH - flow.height));
    } else if (parent !== null) {
      // A nested sticky clamps to its parent's used border box, including
      // that parent's own sticky shift.
      const cb = contentBorder(tree, parent);
      const cbL = cb.x - portOrigin.x - scroll.left;
      const cbT = cb.y - portOrigin.y - scroll.top;
      visualX = Math.min(Math.max(visualX, cbL), cbL + cb.width - flow.width);
      visualY = Math.min(Math.max(visualY, cbT), cbT + cb.height - flow.height);
    }
    return {
      x: portOrigin.x + visualX + scroll.left,
      y: portOrigin.y + visualY + scroll.top,
      width: flow.width,
      height: flow.height,
    };
  };
  const contentBorder = (
    tree: ReturnType<FineSession["layoutTree"]> | null,
    id: NodeId,
  ): { x: number; y: number; width: number; height: number } => {
    const flow = rectFromTree(tree, id);
    if (tree === null) return flow;
    return stickyContentBox(tree, id, flow);
  };
  const ancestorScroll = (id: NodeId): { top: number; left: number } => {
    let top = documentScrollY;
    let left = documentScrollX;
    let current = session.dom.nodes.get(id)?.parent ?? null;
    while (current !== null) {
      if (isScrollportNode(current)) {
        const scroll = elementScroll.get(current);
        if (scroll !== undefined) {
          top += scroll.top;
          left += scroll.left;
        }
      }
      current = session.dom.nodes.get(current)?.parent ?? null;
    }
    return { top, left };
  };
  const visualBorder = (
    tree: ReturnType<FineSession["layoutTree"]> | null,
    id: NodeId,
  ): { x: number; y: number; width: number; height: number; top: number; left: number; right: number; bottom: number } => {
    const content = contentBorder(tree, id);
    const scroll = ancestorScroll(id);
    const x = content.x - scroll.left;
    const y = content.y - scroll.top;
    return {
      x, y, width: content.width, height: content.height,
      top: y, left: x, right: x + content.width, bottom: y + content.height,
    };
  };
  const scrollExtent = (
    tree: NonNullable<ReturnType<FineSession["layoutTree"]>>,
    id: NodeId,
  ): { width: number; height: number } => {
    const self = viewportBorder(tree, id);
    if (self === null) return { width: 0, height: 0 };
    const origin = paddingOriginOf(tree, id) ?? { x: self.x, y: self.y };
    let maxR = self.x + self.width;
    let maxB = self.y + self.height;
    const descends = (node: NodeId): boolean => {
      let cur: NodeId | null = node;
      while (cur !== null) {
        if (cur === id) return true;
        cur = session.dom.nodes.get(cur)?.parent ?? null;
      }
      return false;
    };
    for (const frag of tree.fragments.values()) {
      if (frag.node === id || !descends(frag.node)) continue;
      const box = viewportBorder(tree, frag.node);
      if (box === null) continue;
      maxR = Math.max(maxR, box.x + box.width);
      maxB = Math.max(maxB, box.y + box.height);
    }
    return {
      width: Math.max(self.width, maxR - origin.x),
      height: Math.max(self.height, maxB - origin.y),
    };
  };
  const clampScroll = (id: NodeId, top: number, left: number): { top: number; left: number } => {
    const tree = resolveLayoutTree();
    if (tree === null) return { top: Math.max(0, top), left: Math.max(0, left) };
    const self = viewportBorder(tree, id);
    const extent = scrollExtent(tree, id);
    const maxTop = Math.max(0, extent.height - (self?.height ?? 0));
    const maxLeft = Math.max(0, extent.width - (self?.width ?? 0));
    return {
      top: Math.min(maxTop, Math.max(0, top)),
      left: Math.min(maxLeft, Math.max(0, left)),
    };
  };
  const setDocumentScroll = (x: number, y: number): void => {
    documentScrollX = Math.max(0, x);
    documentScrollY = Math.max(0, y);
  };
  const scrollToArgs = (x: unknown, y?: unknown): { left: number; top: number } | null => {
    if (typeof x === "object" && x !== null) {
      const o = x as { left?: unknown; top?: unknown };
      return {
        left: o.left === undefined ? documentScrollX : axisLength(o.left),
        top: o.top === undefined ? documentScrollY : axisLength(o.top),
      };
    }
    if (x === undefined && y === undefined) return null;
    return { left: axisLength(x), top: axisLength(y) };
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
    // Rendering-step observers (Resize/IntersectionObserver) evaluate against
    // the post-animation layout at every frame boundary.
    runGeometryCheck();
  };
  const hasActiveAnimations = (): boolean =>
    animations.some((a) => !a.cancelled && !a.finished) || geometryCheckPending;

  /** Map a guest element/text wrapper back to its session node id. */
  const idOf = new WeakMap<object, NodeId>();
  /** Recover a node id from a guest wrapper value (safely, for unknown inputs). */
  const idFromWrapper = (w: unknown): NodeId | undefined =>
    typeof w === "object" && w !== null ? idOf.get(w) : undefined;

  /** Registered event listeners, per node id. */
  type Listener = { readonly type: string; readonly fn: GuestFn; readonly capture: boolean };
  const listeners = new Map<NodeId, Listener[]>();
  /** Stable CSSStyleDeclaration wrappers; element.style keeps identity and expando state.
   * WeakRef-keyed (RFC 0041): a declaration nobody references may be collected;
   * re-access mints a fresh one — identity is only observable while referenced. */
  const styleWrappers = new WrapperCache();
  /** Live per-node property state the tree does not model (checked/open/
   * value/selected/indeterminate/customError/touched/selection). Fields the
   * cascade can see mirror through {@link syncControlState} into the
   * session's `DocControl` input; `open` and `valueDirty` stay script-local. */
  const nodeState = new Map<NodeId, {
    checked?: boolean;
    open?: boolean;
    value?: string;
    selected?: boolean;
    indeterminate?: boolean;
    customError?: string;
    touched?: boolean;
    valueDirty?: boolean;
    selStart?: number;
    selEnd?: number;
    selDir?: "forward" | "backward" | "none";
  }>();

  /** Push a control's cascade-visible fields into `DocControl` so
   * `:checked`/`:valid`/`:placeholder-shown`/… recompute (fresh map identity
   * → incremental invalidation + script-side gcs cache epoch bump). */
  function syncControlState(id: NodeId): void {
    const s = nodeState.get(id);
    const patch =
      s === undefined
        ? undefined
        : {
            ...(s.checked !== undefined ? { checked: s.checked } : {}),
            ...(s.selected !== undefined ? { selected: s.selected } : {}),
            ...(s.indeterminate !== undefined ? { indeterminate: s.indeterminate } : {}),
            ...(s.value !== undefined ? { value: s.value } : {}),
            ...(s.customError !== undefined ? { customError: s.customError } : {}),
            ...(s.touched !== undefined ? { touched: s.touched } : {}),
          };
    session.setControlState(
      id,
      patch !== undefined && Object.keys(patch).length > 0 ? patch : undefined,
    );
  }

  /** Patch one control's nodeState fields and sync the cascade view. */
  function patchControl(
    id: NodeId,
    fields: Partial<{
      checked: boolean;
      selected: boolean;
      indeterminate: boolean;
      value: string;
      customError: string;
      touched: boolean;
      valueDirty: boolean;
      selStart: number;
      selEnd: number;
      selDir: "forward" | "backward" | "none";
    }>,
  ): void {
    const s = nodeState.get(id) ?? {};
    Object.assign(s, fields);
    nodeState.set(id, s);
    syncControlState(id);
  }

  /** Mark a control user-committed — feeds `:user-valid`/`:user-invalid`. */
  function markTouched(id: NodeId): void {
    if (nodeState.get(id)?.touched !== true) patchControl(id, { touched: true });
  }
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
        // Scoped id query: walk the scope subtree — the document id index
        // never enters shadow trees, so it cannot serve shadow scopes.
        const found = elementIdsByAttrValue(scopeRoot, "id", want)[0];
        return found === undefined ? [] : [found];
      }
      const found = findByIdIndexed(want);
      return found === null ? [] : [found];
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

  /** Element ids under `scopeRoot` with `attr === value` (shadow-scoped getElementById). */
  const elementIdsByAttrValue = (scopeRoot: NodeId, attr: string, value: string): NodeId[] =>
    elementIdsByTagName(scopeRoot, "*").filter(
      (id) => session.dom.nodes.get(id)?.attrs?.get(attr) === value,
    );

  // --- Shadow DOM (RFC 0018) -------------------------------------------------
  // The shadow root hangs off `host.shadow` — NEVER in `children` — so light-
  // DOM queries (getElementsByTagName/querySelector) stay tree-scoped for free.
  // ---------------------------------------------------------------------------

  /** The enclosing `"#shadow-root"` node id for `id`, or undefined. */
  const enclosingShadowRootId = (id: NodeId): NodeId | undefined => {
    let cur: NodeId | null = session.dom.nodes.get(id)?.parent ?? null;
    while (cur !== null) {
      const n = session.dom.nodes.get(cur);
      if (n === undefined) return undefined;
      if (n.tag === "#shadow-root") return cur;
      cur = n.parent;
    }
    return undefined;
  };

  /** Every `<slot>` element inside `rootId`'s subtree (tree order). */
  const slotsInSubtree = (rootId: NodeId): NodeId[] =>
    elementIdsByTagName(rootId, "slot");

  /** The light-DOM ids assigned to `slotId` (name-matched; text → default slot). */
  const slotAssignedIds = (slotId: NodeId): NodeId[] => {
    const slotNode = session.dom.nodes.get(slotId);
    if (slotNode === undefined || slotNode.tag !== "slot") return [];
    const srId = enclosingShadowRootId(slotId);
    if (srId === undefined) return [];
    const hostId = session.dom.nodes.get(srId)?.parent;
    if (hostId === undefined || hostId === null) return [];
    const host = session.dom.nodes.get(hostId);
    if (host === undefined) return [];
    const name = slotNode.attrs?.get("name") ?? "";
    return host.children.filter((cid) => {
      const c = session.dom.nodes.get(cid);
      if (c?.kind === "element") return (c.attrs?.get("slot") ?? "") === name;
      return c?.kind === "text" && name === "";
    });
  };

  /** The slot `id` is currently assigned to (its parent must be a shadow host). */
  const assignedSlotFor = (id: NodeId): NodeId | undefined => {
    const node = session.dom.nodes.get(id);
    const parentId = node?.parent;
    if (node === undefined || parentId === null || parentId === undefined) return undefined;
    const shadowId = session.dom.nodes.get(parentId)?.shadow;
    if (shadowId === undefined) return undefined;
    const name = node.kind === "element" ? (node.attrs?.get("slot") ?? "") : "";
    for (const sid of slotsInSubtree(shadowId)) {
      const s = session.dom.nodes.get(sid);
      if ((s?.attrs?.get("name") ?? "") === name) return sid;
    }
    return undefined;
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
  const nodeIdsFromParentNodeArgs = (values: unknown[]): NodeId[] => {
    const out: NodeId[] = [];
    for (const value of values) {
      const id = idFromWrapper(value);
      if (id === undefined) {
        out.push(session.createTextNode(String(value)));
        continue;
      }
      const node = session.dom.nodes.get(id);
      // Appending a DocumentFragment inserts its children, not the fragment.
      if (node?.kind === "element" && node.tag === "#document-fragment") {
        out.push(...node.children);
      } else {
        out.push(id);
      }
    }
    return out;
  };

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
  /** Which context mode a canvas is locked into (first getContext wins). */
  const canvasKinds = new Map<NodeId, "2d" | "webgl">();
  const canvasEngines = new Map<NodeId, Canvas2DEngine>();
  const webglCores = new Map<NodeId, WebGLCore>();
  // drawImage(canvasElement)/OffscreenCanvas source resolution — guest-facing
  // objects map back to their engine through this registry.
  const canvasObjects = new WeakMap<object, Canvas2DEngine>();
  const makeCanvas2dContext = (canvasId: NodeId, opts?: { opaque?: boolean }): object => {
    const attrNum = (name: string, dflt: number): number => {
      const raw = session.dom.nodes.get(canvasId)?.attrs?.get(name);
      const n = raw !== undefined ? Number(raw) : NaN;
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
    };
    let engine = canvasEngines.get(canvasId);
    if (engine === undefined) {
      engine = new Canvas2DEngine(attrNum("width", 300), attrNum("height", 150), opts);
      canvasEngines.set(canvasId, engine);
      // The element wrapper → engine mapping lets drawImage(canvasEl) pull the
      // peer bitmap; registered lazily on ctx.canvas access as well.
      canvasObjects.set(makeElementCached(canvasId), engine);
    }
    return canvas2dApi(engine, {
      canvasRef: () => makeElementCached(canvasId),
      resolveImage: (source) => {
        const id = idOf.get(source as object);
        if (id === undefined) return undefined;
        return options.canvasImageSource?.(id);
      },
      resolveCanvas: (source) =>
        typeof source === "object" && source !== null ? canvasObjects.get(source) : undefined,
    });
  };
  /**
   * `canvas.getContext("webgl")` — RFC 0036 software-GL context. The core IS
   * the drawing buffer; `webglBitmap` snapshots it into the canvas paint
   * channel. `texImage2D(source)` resolves img/canvas/OffscreenCanvas sources
   * through the same registries drawImage uses.
   */
  const makeWebGLCtx = (canvasId: NodeId, attrs?: GLContextAttributes): object => {
    const attrNum = (name: string, dflt: number): number => {
      const raw = session.dom.nodes.get(canvasId)?.attrs?.get(name);
      const n = raw !== undefined ? Number(raw) : NaN;
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
    };
    let core = webglCores.get(canvasId);
    if (core === undefined) {
      core = new WebGLCore(attrNum("width", 300), attrNum("height", 150), attrs);
      webglCores.set(canvasId, core);
    }
    return makeWebGLContext(core, makeElementCached(canvasId), {
      imageSource: (source) => {
        const id = idOf.get(source as object);
        if (id !== undefined) {
          const glPeer = webglCores.get(id);
          if (glPeer !== undefined) return glPeer.snapshot();
          const e2d = canvasEngines.get(id);
          if (e2d !== undefined) return e2d.rasterize();
          return options.canvasImageSource?.(id);
        }
        const offscreen = typeof source === "object" && source !== null
          ? canvasObjects.get(source) : undefined;
        return offscreen?.rasterize();
      },
    });
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
      getAttributeNS(ns: unknown, name: unknown): string | null {
        // Nullable namespace: null and undefined both mean the null namespace.
        // This engine stores HTML attributes in that namespace only.
        if (ns !== null && ns !== undefined) return null;
        const node = session.dom.nodes.get(nodeId);
        return node?.attrs?.get(String(name)) ?? null;
      },
      setAttribute(name: unknown, value: unknown): void {
        const attr = htmlAttributeName(name);
        session.setAttribute(nodeId, attr, String(value));
        mutations += 1;
        // RFC 0033: writing canvas width/height resets the backing bitmap
        // (HTML §"concept-canvas-set-bitmap-dimensions").
        const node0 = session.dom.nodes.get(nodeId);
        if (node0?.tag === "canvas" && (attr === "width" || attr === "height")) {
          const dims = node0.attrs;
          const w = Number(dims?.get("width"));
          const h = Number(dims?.get("height"));
          canvasEngines.get(nodeId)?.resize(
            Number.isFinite(w) && w >= 0 ? w : 300,
            Number.isFinite(h) && h >= 0 ? h : 150,
          );
        }
        // HTML script-element semantics: setting `src` on a CONNECTED script
        // element triggers the fetch-and-run steps (the classic SPA loader
        // pattern: append first, then set src).
        if (attr === "src" && options.onDynamicScript !== undefined) {
          const node = session.dom.nodes.get(nodeId);
          if (node?.kind === "element" && node.tag === "script" && isConnectedToDocument(session.dom, nodeId)) {
            options.onDynamicScript(nodeId);
          }
        }
        // RFC 0035: `setAttribute("src")` on a media element re-runs resource
        // selection — the same trigger the `src` IDL setter uses.
        if (attr === "src" && options.media !== undefined) {
          const tag = session.dom.nodes.get(nodeId)?.tag;
          if (tag === "video" || tag === "audio") options.media.srcChanged(nodeId);
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
      set style(value: unknown) {
        // `el.style = "left: 50px"` assigns cssText. A string replaces the
        // declaration; the CSSStyleDeclaration object itself stays put.
        session.setAttribute(nodeId, "style", value == null ? "" : cssomString(value));
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
        const node = session.dom.nodes.get(nodeId);
        // A shadow root's DOM parent is null — the host is only its
        // shadow-including parent (getRootNode/events use that chain).
        if (node === undefined || node.tag === "#shadow-root") return null;
        const p = node.parent ?? null;
        return p === null ? null : makeElementCached(p);
      },
      get parentElement(): object | null {
        const node = session.dom.nodes.get(nodeId);
        if (node === undefined || node.tag === "#shadow-root") return null;
        const p = node.parent ?? null;
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
        if (node?.kind !== "element" || node.tag !== "template") return null;
        // HTMLTemplateElement.content is a DocumentFragment. The parser stores
        // the template's markup as its children; the first read moves them
        // into the fragment so they are not rendered (template is display:none).
        let fragId = templateFragments.get(nodeId);
        if (fragId === undefined) {
          fragId = session.createElement("#document-fragment");
          templateFragments.set(nodeId, fragId);
          const children = [...(session.dom.nodes.get(nodeId)?.children ?? [])];
          for (const child of children) {
            session.removeChild(nodeId, child);
            session.appendChild(fragId, child);
          }
          mutations += 1;
        }
        return makeElementCached(fragId);
      },
      appendChild(child: unknown): unknown {
        const childId = idFromWrapper(child);
        if (childId !== undefined) {
          session.appendChild(nodeId, childId);
          mutations += 1;
          notifyDynamicScripts([childId]);
          connectBlankIframes(childId);
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
      // --- Shadow DOM (RFC 0018) -------------------------------------------
      attachShadow(init: unknown): object {
        const mode = (init as { mode?: unknown } | null)?.mode === "closed" ? "closed" : "open";
        const node = session.dom.nodes.get(nodeId);
        const tag = node?.tag ?? "";
        const SHADOW_HOST_TAGS = new Set([
          "article", "aside", "blockquote", "body", "div", "footer",
          "h1", "h2", "h3", "h4", "h5", "h6", "header", "main", "nav", "p", "section", "span",
        ]);
        // Any valid custom-element name may host a shadow root — defined or
        // not (HTML §4.13.6 "shadow host" list + potential CE hosts).
        const isCeHost = isValidCustomElementName(tag);
        if (node?.kind !== "element" || (!SHADOW_HOST_TAGS.has(tag) && !isCeHost)) {
          throw new DOMException(`'${tag || "node"}' does not support shadow roots`, "NotSupportedError");
        }
        if (node.shadow !== undefined) {
          throw new DOMException("Shadow root cannot be created on a host which already hosts a shadow tree", "NotSupportedError");
        }
        const sid = session.attachShadow(nodeId, mode);
        if (sid === null) {
          throw new DOMException("Shadow root cannot be created on a host which already hosts a shadow tree", "NotSupportedError");
        }
        mutations += 1;
        return makeElementCached(sid);
      },
      get shadowRoot(): object | null {
        const sid = session.dom.nodes.get(nodeId)?.shadow;
        if (sid === undefined) return null;
        // Closed roots exist internally but are hidden from page script.
        if ((session.dom.nodes.get(sid)?.attrs?.get("mode") ?? "open") !== "open") return null;
        return makeElementCached(sid);
      },
      getRootNode(opts?: unknown): object {
        const composed = (opts as { composed?: unknown } | null)?.composed === true;
        let cur: NodeId | null = nodeId;
        let top: NodeId = nodeId;
        while (cur !== null) {
          const n = session.dom.nodes.get(cur);
          if (n === undefined) break;
          if (!composed && n.tag === "#shadow-root") return makeElementCached(cur);
          top = cur;
          cur = n.parent;
        }
        return top === session.dom.root ? (document) : makeElementCached(top);
      },
      get assignedSlot(): object | null {
        const sid = assignedSlotFor(nodeId);
        return sid === undefined ? null : makeElementCached(sid);
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
        // HTMLElement.click() dispatches a PointerEvent (Pointer Events
        // §5.2.5); activation behavior runs only when it was not
        // default-prevented. Script-initiated clicks do not move focus.
        const event = makeEvent("click", { bubbles: true, cancelable: true, composed: true });
        if (dispatch(nodeId, event)) runActivationBehavior(nodeId);
      },
      focus(): void {
        if (isFocusable(nodeId)) setFocused(nodeId, isTextEditingControl(nodeId));
      },
      blur(): void {
        if (focusedId === nodeId) setFocused(null, false);
      },
      get tabIndex(): number {
        const attr = elementAttr(nodeId, "tabindex");
        if (attr !== undefined) {
          const parsed = Number(attr);
          return Number.isNaN(parsed) ? -1 : Math.trunc(parsed);
        }
        // Natively focusable elements default to 0, others to -1.
        return isFocusable(nodeId) ? 0 : -1;
      },
      set tabIndex(v: unknown) {
        session.setAttribute(nodeId, "tabindex", String(Math.trunc(Number(v) || 0)));
        mutations += 1;
      },
      get value(): unknown {
        const node = session.dom.nodes.get(nodeId);
        const tag = node?.tag;
        if (tag === "input" || tag === "textarea") return controlValue(nodeId);
        if (tag === "output" || tag === "select") return controlValueOf(session.dom, node!);
        if (tag === "option") return optionValue(nodeId);
        if (tag === "button") return node?.attrs?.get("value") ?? "";
        return undefined;
      },
      set value(v: unknown) {
        const node = session.dom.nodes.get(nodeId);
        const tag = node?.tag;
        const str = coerceGuestString(v);
        if (tag === "input" || tag === "textarea") {
          setTextValue(nodeId, str);
          mutations += 1;
          return;
        }
        if (tag === "output") {
          patchControl(nodeId, { value: str });
          return;
        }
        if (tag === "option") {
          session.setAttribute(nodeId, "value", str);
          mutations += 1;
          return;
        }
        if (tag === "button") {
          session.setAttribute(nodeId, "value", str);
          mutations += 1;
          return;
        }
        if (tag === "select" && node !== undefined) {
          // select.value = pick the first option whose value matches
          // (multiple: every match); no match ⇒ all deselected.
          const multiple = node.attrs?.has("multiple") === true;
          let found = false;
          for (const opt of selectOptions(session.dom, node)) {
            const hit = optionValue(opt.id) === str && (multiple || !found);
            patchControl(opt.id, { selected: hit });
            if (hit) found = true;
          }
        }
      },
      // RFC 0011: form element methods — submit() skips the submit event per
      // spec; requestSubmit() runs it (cancelable). No-ops on non-forms.
      submit(): void {
        if (session.dom.nodes.get(nodeId)?.tag === "form") {
          submitForm(nodeId, null, true);
        }
      },
      requestSubmit(submitter?: unknown): void {
        if (session.dom.nodes.get(nodeId)?.tag !== "form") return;
        const subId = idFromWrapper(submitter) ?? null;
        submitForm(nodeId, subId);
      },
      reset(): void {
        if (session.dom.nodes.get(nodeId)?.tag === "form") resetForm(nodeId);
      },
      /**
       * RFC 0013: `iframe.contentWindow` — the child context's window proxy
       * (postMessage-capable); null until the frame loads / on non-iframes.
       */
      get srcdoc(): string {
        if (session.dom.nodes.get(nodeId)?.tag !== "iframe") return "";
        return session.dom.nodes.get(nodeId)?.attrs?.get("srcdoc") ?? "";
      },
      set srcdoc(value: unknown) {
        if (session.dom.nodes.get(nodeId)?.tag !== "iframe") return;
        session.setAttribute(nodeId, "srcdoc", String(value));
        mutations += 1;
        navigateSrcdoc(nodeId);
      },
      get media(): string {
        const tag = session.dom.nodes.get(nodeId)?.tag;
        if (tag !== "style" && tag !== "link") return "";
        return session.dom.nodes.get(nodeId)?.attrs?.get("media") ?? "";
      },
      set media(value: unknown) {
        const tag = session.dom.nodes.get(nodeId)?.tag;
        if (tag !== "style" && tag !== "link") return;
        session.setAttribute(nodeId, "media", coerceGuestString(value));
        mutations += 1;
      },
      get contentWindow(): object | null {
        if (session.dom.nodes.get(nodeId)?.tag !== "iframe") return null;
        const w = frameLookup?.(nodeId) ?? srcdocFrames.get(nodeId)?.window ?? blankFrames.get(nodeId)?.window;
        return typeof w === "object" && w !== null ? w : null;
      },
      /**
       * `iframe.contentDocument` — `contentWindow.document` per spec: the
       * child's document wrapper when the two contexts are same-origin,
       * null otherwise (cross-origin frames only expose the proxy).
       */
      get contentDocument(): object | null {
        if (session.dom.nodes.get(nodeId)?.tag !== "iframe") return null;
        const w = (frameLookup?.(nodeId) ?? srcdocFrames.get(nodeId)?.window ?? blankFrames.get(nodeId)?.window) as { document?: unknown } | null | undefined;
        const doc = w?.document;
        return typeof doc === "object" && doc !== null ? doc : null;
      },
      /** `control.form` — the owning form element (form=-attr aware). */
      get form(): object | null {
        const node = session.dom.nodes.get(nodeId);
        if (node?.kind !== "element") return null;
        const explicit = node.attrs?.get("form");
        if (explicit !== undefined) {
          for (const [id, n] of session.dom.nodes) {
            if (n?.kind === "element" && n.tag === "form" && n.attrs?.get("id") === explicit) {
              return makeElementCached(id);
            }
          }
          return null;
        }
        const owner = ownerForm(nodeId);
        return owner !== null ? makeElementCached(owner) : null;
      },
      get checked(): boolean {
        return controlChecked(nodeId);
      },
      set checked(value: unknown) {
        patchControl(nodeId, { checked: Boolean(value) });
        // Checking a radio unchecks its group (same name, same form owner).
        if (value === true) {
          const n = session.dom.nodes.get(nodeId);
          if (n?.tag === "input" && inputType(n) === "radio") radioGroupUncheck(nodeId);
        }
      },
      /**
       * RFC 0021: `input.indeterminate` — the visual tri-state flag (property
       * only, never an attribute). Feeds `:indeterminate` via DocControl.
       */
      get indeterminate(): boolean {
        return nodeState.get(nodeId)?.indeterminate === true;
      },
      set indeterminate(value: unknown) {
        patchControl(nodeId, { indeterminate: Boolean(value) });
      },

      // ---- RFC 0021: form-control IDL surface -------------------------------

      /** Sanitized `type`: input falls back to "text" for unknown values,
       * button to "submit"; select reports "select-one"/"select-multiple";
       * textarea/fieldset/output report their tag. */
      get type(): unknown {
        const node = session.dom.nodes.get(nodeId);
        const tag = node?.tag;
        if (tag === "input" && node !== undefined) return inputType(node);
        if (tag === "button") {
          const raw = (node?.attrs?.get("type") ?? "submit").toLowerCase();
          return raw === "submit" || raw === "reset" || raw === "button" ? raw : "submit";
        }
        if (tag === "select") return node?.attrs?.has("multiple") === true ? "select-multiple" : "select-one";
        if (tag === "textarea") return "textarea";
        if (tag === "fieldset") return "fieldset";
        if (tag === "output") return "output";
        return undefined;
      },
      set type(v: unknown) {
        const tag = session.dom.nodes.get(nodeId)?.tag;
        if (tag === "input" || tag === "button") {
          session.setAttribute(nodeId, "type", coerceGuestString(v));
          mutations += 1;
        }
      },
      /** `disabled` reflects the ATTRIBUTE (fieldset-inherited disablement
       * is visible via `:disabled`/`willValidate`, not this property). */
      get disabled(): boolean {
        return hasElementAttr(nodeId, "disabled");
      },
      set disabled(v: unknown) {
        reflectBool.set(nodeId, "disabled", v);
      },
      get name(): string {
        return session.dom.nodes.get(nodeId)?.attrs?.get("name") ?? "";
      },
      set name(v: unknown) {
        reflectStr.set(nodeId, "name", v);
      },
      get required(): boolean {
        return hasElementAttr(nodeId, "required");
      },
      set required(v: unknown) {
        reflectBool.set(nodeId, "required", v);
      },
      get readOnly(): boolean {
        return hasElementAttr(nodeId, "readonly");
      },
      set readOnly(v: unknown) {
        reflectBool.set(nodeId, "readonly", v);
      },
      get placeholder(): string {
        return session.dom.nodes.get(nodeId)?.attrs?.get("placeholder") ?? "";
      },
      set placeholder(v: unknown) {
        reflectStr.set(nodeId, "placeholder", v);
      },
      get pattern(): string {
        return session.dom.nodes.get(nodeId)?.attrs?.get("pattern") ?? "";
      },
      set pattern(v: unknown) {
        reflectStr.set(nodeId, "pattern", v);
      },
      get min(): string {
        return session.dom.nodes.get(nodeId)?.attrs?.get("min") ?? "";
      },
      set min(v: unknown) {
        reflectStr.set(nodeId, "min", v);
      },
      get max(): string {
        return session.dom.nodes.get(nodeId)?.attrs?.get("max") ?? "";
      },
      set max(v: unknown) {
        reflectStr.set(nodeId, "max", v);
      },
      get step(): string {
        return session.dom.nodes.get(nodeId)?.attrs?.get("step") ?? "";
      },
      set step(v: unknown) {
        reflectStr.set(nodeId, "step", v);
      },
      get minLength(): number {
        return reflectLong.get(nodeId, "minlength", -1);
      },
      set minLength(v: unknown) {
        reflectLong.set(nodeId, "minlength", v);
      },
      get maxLength(): number {
        return reflectLong.get(nodeId, "maxlength", -1);
      },
      set maxLength(v: unknown) {
        reflectLong.set(nodeId, "maxlength", v);
      },
      get multiple(): boolean {
        return hasElementAttr(nodeId, "multiple");
      },
      set multiple(v: unknown) {
        reflectBool.set(nodeId, "multiple", v);
      },
      get size(): number {
        return reflectLong.get(nodeId, "size", 20);
      },
      set size(v: unknown) {
        reflectLong.set(nodeId, "size", v);
      },
      get autocomplete(): string {
        return session.dom.nodes.get(nodeId)?.attrs?.get("autocomplete") ?? "";
      },
      set autocomplete(v: unknown) {
        reflectStr.set(nodeId, "autocomplete", v);
      },
      get autofocus(): boolean {
        return hasElementAttr(nodeId, "autofocus");
      },
      set autofocus(v: unknown) {
        reflectBool.set(nodeId, "autofocus", v);
      },
      /** defaultValue — the `value` attribute (input) / text children
       * (textarea/output). Setting it also updates the live value when the
       * value isn't dirty (HTML §4.10.19.3 dirty-value flag). */
      get defaultValue(): string {
        const node = session.dom.nodes.get(nodeId);
        if (node?.tag === "textarea" || node?.tag === "output") {
          return node.children
            .map((c) => session.dom.nodes.get(c))
            .filter((c) => c?.kind === "text")
            .map((c) => (c as { text: string }).text)
            .join("");
        }
        return node?.attrs?.get("value") ?? "";
      },
      set defaultValue(v: unknown) {
        const node = session.dom.nodes.get(nodeId);
        if (node?.tag === "textarea" || node?.tag === "output") {
          replaceTextContent(session, nodeId, coerceGuestString(v));
        } else {
          session.setAttribute(nodeId, "value", coerceGuestString(v));
        }
        if (nodeState.get(nodeId)?.valueDirty !== true) {
          patchControl(nodeId, { value: coerceGuestString(v) });
        }
        mutations += 1;
      },
      get defaultChecked(): boolean {
        return hasElementAttr(nodeId, "checked");
      },
      set defaultChecked(v: unknown) {
        reflectBool.set(nodeId, "checked", v);
      },
      /** `input.valueAsNumber` — value in the type's numeric domain; NaN
       * when empty/unparsable; only number/date-family types may set. */
      get valueAsNumber(): unknown {
        const node = session.dom.nodes.get(nodeId);
        if (node?.tag !== "input") return undefined;
        const n = valueAsNumber(inputType(node), controlValue(nodeId));
        return n === null ? NaN : n;
      },
      set valueAsNumber(v: unknown) {
        const node = session.dom.nodes.get(nodeId);
        if (node?.tag !== "input") return;
        const t = inputType(node);
        if (!["number", "range", "date", "month", "week", "time", "datetime-local"].includes(t)) {
          throw new DOMException("valueAsNumber: not allowed for this input type", "InvalidStateError");
        }
        const n = Number(v);
        if (!Number.isFinite(n)) {
          setTextValue(nodeId, "");
        } else if (t === "number" || t === "range") {
          setTextValue(nodeId, String(n));
        } else if (t === "date") {
          const d = new Date(n);
          setTextValue(nodeId, Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10));
        } else {
          setTextValue(nodeId, String(n));
        }
        mutations += 1;
      },
      stepUp(n?: unknown): void {
        stepBy(nodeId, Math.trunc(Number(n ?? 1) || 1), 1);
      },
      stepDown(n?: unknown): void {
        stepBy(nodeId, Math.trunc(Number(n ?? 1) || 1), -1);
      },

      // ---- Constraint-validation IDL (shared flags engine) ----------------
      get validity(): object {
        return validityObject(nodeId);
      },
      get validationMessage(): string {
        return validationMessageOf(nodeId);
      },
      get willValidate(): boolean {
        return controlWillValidate(nodeId);
      },
      checkValidity(): boolean {
        return checkControlValidity(nodeId);
      },
      reportValidity(): boolean {
        return checkControlValidity(nodeId);
      },
      setCustomValidity(msg: unknown): void {
        patchControl(nodeId, { customError: coerceGuestString(msg) });
      },

      // ---- Selection (text-entry controls; the rest reject per spec) -------
      get selectionStart(): unknown {
        if (!isTextEditingControl(nodeId)) return null;
        return selOf(nodeId).start;
      },
      set selectionStart(v: unknown) {
        if (!isTextEditingControl(nodeId)) return;
        const len = [...controlValue(nodeId)].length;
        patchControl(nodeId, { selStart: Math.max(0, Math.min(Math.trunc(Number(v) || 0), len)) });
      },
      get selectionEnd(): unknown {
        if (!isTextEditingControl(nodeId)) return null;
        return selOf(nodeId).end;
      },
      set selectionEnd(v: unknown) {
        if (!isTextEditingControl(nodeId)) return;
        const len = [...controlValue(nodeId)].length;
        patchControl(nodeId, { selEnd: Math.max(0, Math.min(Math.trunc(Number(v) || 0), len)) });
      },
      get selectionDirection(): unknown {
        if (!isTextEditingControl(nodeId)) return null;
        return selOf(nodeId).dir;
      },
      set selectionDirection(v: unknown) {
        if (!isTextEditingControl(nodeId)) return;
        const d = String(v);
        if (d === "forward" || d === "backward" || d === "none") {
          patchControl(nodeId, { selDir: d });
        }
      },
      setSelectionRange(start: unknown, end: unknown, dir?: unknown): void {
        if (!isTextEditingControl(nodeId)) return;
        const len = [...controlValue(nodeId)].length;
        const s = Math.max(0, Math.min(Math.trunc(Number(start) || 0), len));
        const e = Math.max(0, Math.min(Math.trunc(Number(end) || 0), len));
        const d = coerceGuestString(dir);
        patchControl(nodeId, {
          selStart: s, selEnd: Math.max(s, e),
          selDir: d === "forward" || d === "backward" || d === "none" ? d : "none",
        });
      },
      select(): void {
        if (!isTextEditingControl(nodeId)) return;
        const len = [...controlValue(nodeId)].length;
        patchControl(nodeId, { selStart: 0, selEnd: len, selDir: "none" });
      },
      setRangeText(replacement: unknown, start?: unknown, end?: unknown, mode?: unknown): void {
        if (!isTextEditingControl(nodeId)) return;
        const value = controlValue(nodeId);
        const cps = [...value];
        const sel = selOf(nodeId);
        const s = start === undefined ? sel.start : Math.max(0, Math.min(Math.trunc(Number(start) || 0), cps.length));
        const e = end === undefined ? sel.end : Math.max(0, Math.min(Math.trunc(Number(end) || 0), cps.length));
        const rep = coerceGuestString(replacement);
        const next = cps.slice(0, s).join("") + rep + cps.slice(e).join("");
        const caret = s + [...rep].length;
        setTextValue(nodeId, next);
        const m = coerceGuestString(mode === undefined ? "preserve" : mode);
        patchControl(nodeId, m === "select" ? { selStart: s, selEnd: caret } :
          m === "start" ? { selStart: s, selEnd: s } :
          m === "end" ? { selStart: caret, selEnd: caret } : {});
      },

      // ---- select / option / datalist collections -------------------------
      /** select.options / datalist.options — a LIVE collection proxy. */
      get options(): unknown {
        const tag = session.dom.nodes.get(nodeId)?.tag;
        if (tag !== "select" && tag !== "datalist") return undefined;
        return controlCollection(() => optionIdsOf(nodeId));
      },
      get selectedOptions(): unknown {
        if (session.dom.nodes.get(nodeId)?.tag !== "select") return undefined;
        return controlCollection(() =>
          optionIdsOf(nodeId).filter((oid) => {
            const n = session.dom.nodes.get(oid);
            return n !== undefined && domSelected(session.dom, n);
          }),
        );
      },
      get selectedIndex(): unknown {
        const node = session.dom.nodes.get(nodeId);
        if (node?.tag !== "select") return undefined;
        return optionIdsOf(nodeId).findIndex((oid) => {
          const n = session.dom.nodes.get(oid);
          return n !== undefined && domSelected(session.dom, n);
        });
      },
      set selectedIndex(v: unknown) {
        const node = session.dom.nodes.get(nodeId);
        if (node?.tag !== "select") return;
        const idx = Math.trunc(Number(v));
        const ids = optionIdsOf(nodeId);
        ids.forEach((oid, i) => patchControl(oid, { selected: i === idx }));
      },
      add(element?: unknown, before?: unknown): void {
        // select.add(option, before?) — insert; `before` may be an index or node.
        const node = session.dom.nodes.get(nodeId);
        if (node?.tag !== "select") return;
        const el = idFromWrapper(element);
        if (el === undefined) return;
        const ids = optionIdsOf(nodeId);
        let beforeId: NodeId | null = null;
        if (typeof before === "number") {
          beforeId = ids[Math.trunc(before)] ?? null;
        } else if (before !== null && before !== undefined) {
          beforeId = idFromWrapper(before) ?? null;
        }
        if (beforeId !== null) {
          session.insertBefore(nodeId, el, beforeId);
        } else {
          session.appendChild(nodeId, el);
        }
        mutations += 1;
      },
      remove(index?: unknown): void {
        const tag = session.dom.nodes.get(nodeId)?.tag;
        if (tag === "select" && index !== undefined) {
          // select.remove(i) — drop the i-th option (HTML §4.10.7).
          const target = optionIdsOf(nodeId)[Math.trunc(Number(index))];
          if (target === undefined) return;
          const parent = session.dom.nodes.get(target)?.parent;
          if (parent !== null && parent !== undefined) session.removeChild(parent, target);
          mutations += 1;
          return;
        }
        const parent = session.dom.nodes.get(nodeId)?.parent ?? null;
        if (parent !== null) {
          session.removeChild(parent, nodeId);
          mutations += 1;
        }
      },
      item(index: unknown): unknown {
        const ids = optionIdsOf(nodeId);
        const id = ids[Math.trunc(Number(index))];
        return id === undefined ? null : makeElementCached(id);
      },
      namedItem(name: unknown): unknown {
        const key = String(name);
        const id = optionIdsOf(nodeId).find((oid) => {
          const n = session.dom.nodes.get(oid);
          return n?.attrs?.get("id") === key || n?.attrs?.get("name") === key;
        });
        return id === undefined ? null : makeElementCached(id);
      },

      // ---- option IDL ------------------------------------------------------
      get selected(): unknown {
        const node = session.dom.nodes.get(nodeId);
        if (node?.tag !== "option") return undefined;
        return domSelected(session.dom, node);
      },
      set selected(v: unknown) {
        const node = session.dom.nodes.get(nodeId);
        if (node?.tag !== "option") return;
        patchControl(nodeId, { selected: Boolean(v) });
        // In a non-multiple select, selecting one deselects the siblings.
        if (v === true) {
          const sel = ownerSelect(nodeId);
          if (sel !== null && session.dom.nodes.get(sel)?.attrs?.has("multiple") !== true) {
            for (const oid of optionIdsOf(sel)) {
              if (oid !== nodeId) patchControl(oid, { selected: false });
            }
          }
        }
      },
      get defaultSelected(): boolean {
        return hasElementAttr(nodeId, "selected");
      },
      set defaultSelected(v: unknown) {
        reflectBool.set(nodeId, "selected", v);
      },
      get index(): unknown {
        const node = session.dom.nodes.get(nodeId);
        if (node?.tag !== "option") return undefined;
        const sel = ownerSelect(nodeId);
        if (sel === null) return -1;
        return optionIdsOf(sel).indexOf(nodeId);
      },
      get text(): string {
        return controlTextOf(nodeId).trim().replace(/\s+/g, " ");
      },
      set text(v: unknown) {
        if (session.dom.nodes.get(nodeId)?.tag !== "option") return;
        replaceTextContent(session, nodeId, coerceGuestString(v));
        mutations += 1;
      },
      get label(): string {
        return session.dom.nodes.get(nodeId)?.attrs?.get("label") ??
          controlTextOf(nodeId).trim().replace(/\s+/g, " ");
      },
      set label(v: unknown) {
        reflectStr.set(nodeId, "label", v);
      },

      // ---- textarea IDL ----------------------------------------------------
      get textLength(): unknown {
        if (session.dom.nodes.get(nodeId)?.tag !== "textarea") return undefined;
        return [...controlValue(nodeId)].length;
      },
      get rows(): unknown {
        if (session.dom.nodes.get(nodeId)?.tag !== "textarea") return undefined;
        return reflectLong.get(nodeId, "rows", 2);
      },
      set rows(v: unknown) {
        reflectLong.set(nodeId, "rows", v);
      },
      get cols(): unknown {
        if (session.dom.nodes.get(nodeId)?.tag !== "textarea") return undefined;
        return reflectLong.get(nodeId, "cols", 20);
      },
      set cols(v: unknown) {
        reflectLong.set(nodeId, "cols", v);
      },
      get wrap(): unknown {
        if (session.dom.nodes.get(nodeId)?.tag !== "textarea") return undefined;
        return session.dom.nodes.get(nodeId)?.attrs?.get("wrap") ?? "soft";
      },
      set wrap(v: unknown) {
        reflectStr.set(nodeId, "wrap", v);
      },

      // ---- label / output / fieldset / datalist / form ----------------------
      get htmlFor(): string {
        return session.dom.nodes.get(nodeId)?.attrs?.get("for") ?? "";
      },
      set htmlFor(v: unknown) {
        reflectStr.set(nodeId, "for", v);
      },
      get control(): unknown {
        if (session.dom.nodes.get(nodeId)?.tag !== "label") return undefined;
        const c = labeledControlOf(nodeId);
        return c === null ? null : makeElementCached(c);
      },
      /** label.labels is meaningless; controls expose `labels` — the
       * HTMLLabelElement set pointing at this control. */
      get labels(): unknown {
        const node = session.dom.nodes.get(nodeId);
        if (node?.kind !== "element") return undefined;
        return controlCollection(() => labelsOf(nodeId));
      },
      /** `input[list]` → the referenced datalist element (or null). */
      get list(): unknown {
        if (session.dom.nodes.get(nodeId)?.tag !== "input") return undefined;
        const d = listDatalist(nodeId);
        return d === null ? null : makeElementCached(d);
      },
      get files(): unknown {
        const node = session.dom.nodes.get(nodeId);
        if (node?.tag !== "input") return undefined;
        if (inputType(node) !== "file") return null;
        // No file picker exists — an honest empty FileList-shaped object.
        return { length: 0, item: () => null };
      },
      /** form.elements / fieldset.elements — live named/indexed collection. */
      get elements(): unknown {
        const node = session.dom.nodes.get(nodeId);
        if (node?.tag !== "form" && node?.tag !== "fieldset") return undefined;
        return controlCollection(() => associatedControls(nodeId));
      },
      get length(): unknown {
        const tag = session.dom.nodes.get(nodeId)?.tag;
        if (tag === "form") return associatedControls(nodeId).length;
        if (tag === "select") return optionIdsOf(nodeId).length;
        return undefined;
      },
      get noValidate(): boolean {
        return hasElementAttr(nodeId, "novalidate");
      },
      set noValidate(v: unknown) {
        reflectBool.set(nodeId, "novalidate", v);
      },
      get acceptCharset(): string {
        return session.dom.nodes.get(nodeId)?.attrs?.get("accept-charset") ?? "";
      },
      set acceptCharset(v: unknown) {
        reflectStr.set(nodeId, "accept-charset", v);
      },
      get action(): string {
        return session.dom.nodes.get(nodeId)?.attrs?.get("action") ?? "";
      },
      set action(v: unknown) {
        reflectStr.set(nodeId, "action", v);
      },
      /** form.method — sanitized get/post/dialog (missing/invalid ⇒ "get"). */
      get method(): unknown {
        if (session.dom.nodes.get(nodeId)?.tag !== "form") return undefined;
        const raw = (session.dom.nodes.get(nodeId)?.attrs?.get("method") ?? "").toLowerCase();
        return raw === "post" || raw === "dialog" ? raw : "get";
      },
      set method(v: unknown) {
        if (session.dom.nodes.get(nodeId)?.tag === "form") {
          reflectStr.set(nodeId, "method", v);
        }
      },
      get enctype(): unknown {
        if (session.dom.nodes.get(nodeId)?.tag !== "form") return undefined;
        const raw = (session.dom.nodes.get(nodeId)?.attrs?.get("enctype") ?? "").toLowerCase();
        return raw === "text/plain" || raw === "multipart/form-data"
          ? raw
          : "application/x-www-form-urlencoded";
      },
      set enctype(v: unknown) {
        if (session.dom.nodes.get(nodeId)?.tag === "form") {
          reflectStr.set(nodeId, "enctype", v);
        }
      },
      get target(): string {
        return session.dom.nodes.get(nodeId)?.attrs?.get("target") ?? "";
      },
      set target(v: unknown) {
        reflectStr.set(nodeId, "target", v);
      },
      getBoundingClientRect(): object {
        gBcrCalls += 1;
        if (geometryMode === "stub") {
          return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
        }
        return visualBorder(resolveLayoutTree(), nodeId);
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
        const tree = resolveLayoutTree();
        const content = contentBorder(tree, nodeId);
        const parent = offsetParentId(nodeId);
        if (parent === null || tree === null) return Math.round(content.y);
        const parentNode = session.dom.nodes.get(parent);
        // Root sticky is measured from the viewport: `scrollY + top`. The
        // body's padding edge sits below its margin, so subtracting it here
        // would miss that sum.
        if (nearestScrollport(nodeId) === null && (parentNode?.tag === "body" || parentNode?.tag === "html")) {
          return Math.round(content.y);
        }
        const parentBox = contentBorder(tree, parent);
        const originY = parentBox.y + borderEdge(styleOf(parent), "borderTopWidth");
        return Math.round(content.y - originY);
      },
      get offsetLeft(): number {
        const tree = resolveLayoutTree();
        const content = contentBorder(tree, nodeId);
        const parent = offsetParentId(nodeId);
        if (parent === null || tree === null) return Math.round(content.x);
        const parentNode = session.dom.nodes.get(parent);
        if (nearestScrollport(nodeId) === null && (parentNode?.tag === "body" || parentNode?.tag === "html")) {
          return Math.round(content.x);
        }
        const parentBox = contentBorder(tree, parent);
        const originX = parentBox.x + borderEdge(styleOf(parent), "borderLeftWidth");
        return Math.round(content.x - originX);
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
        const tree = resolveLayoutTree();
        if (tree === null) return 0;
        return Math.round(scrollExtent(tree, nodeId).width);
      },
      get scrollHeight(): number {
        const tree = resolveLayoutTree();
        if (tree === null) return 0;
        return Math.round(scrollExtent(tree, nodeId).height);
      },
      get scrollTop(): number {
        return elementScroll.get(nodeId)?.top ?? 0;
      },
      set scrollTop(v: unknown) {
        const prev = elementScroll.get(nodeId) ?? { top: 0, left: 0 };
        elementScroll.set(nodeId, clampScroll(nodeId, axisLength(v), prev.left));
      },
      get scrollLeft(): number {
        return elementScroll.get(nodeId)?.left ?? 0;
      },
      set scrollLeft(v: unknown) {
        const prev = elementScroll.get(nodeId) ?? { top: 0, left: 0 };
        elementScroll.set(nodeId, clampScroll(nodeId, prev.top, axisLength(v)));
      },
      scrollTo(x?: unknown, y?: unknown): void {
        const prev = elementScroll.get(nodeId) ?? { top: 0, left: 0 };
        const next = typeof x === "object" && x !== null
          ? {
              left: (x as { left?: unknown }).left === undefined ? prev.left : axisLength((x as { left?: unknown }).left),
              top: (x as { top?: unknown }).top === undefined ? prev.top : axisLength((x as { top?: unknown }).top),
            }
          : { left: x === undefined ? prev.left : axisLength(x), top: y === undefined ? prev.top : axisLength(y) };
        elementScroll.set(nodeId, clampScroll(nodeId, next.top, next.left));
      },
      scrollBy(x?: unknown, y?: unknown): void {
        const prev = elementScroll.get(nodeId) ?? { top: 0, left: 0 };
        const delta = typeof x === "object" && x !== null
          ? {
              left: axisLength((x as { left?: unknown }).left),
              top: axisLength((x as { top?: unknown }).top),
            }
          : { left: axisLength(x), top: axisLength(y) };
        elementScroll.set(nodeId, clampScroll(nodeId, prev.top + delta.top, prev.left + delta.left));
      },
      getContext(type: unknown, opts?: unknown): object | null {
        const tag = session.dom.nodes.get(nodeId)?.tag ?? "";
        if (tag !== "canvas") return null;
        const kind = coerceGuestString(type).toLowerCase();
        if (kind !== "2d" && kind !== "webgl" && kind !== "experimental-webgl") return null;
        const want = kind === "2d" ? "2d" : "webgl";
        // Spec: the FIRST getContext fixes the context mode — a later call for
        // a different mode on the same canvas returns null.
        const locked = canvasKinds.get(nodeId);
        if (locked !== undefined && locked !== want) return null;
        let ctx = canvasContexts.get(nodeId);
        if (ctx === undefined) {
          if (want === "webgl") {
            const attrs =
              typeof opts === "object" && opts !== null ? (opts as GLContextAttributes) : undefined;
            ctx = makeWebGLCtx(nodeId, attrs);
          } else {
            const opaque =
              typeof opts === "object" && opts !== null && (opts as { alpha?: unknown }).alpha === false;
            ctx = makeCanvas2dContext(nodeId, opaque ? { opaque: true } : undefined);
          }
          canvasContexts.set(nodeId, ctx);
          canvasKinds.set(nodeId, want);
        }
        return ctx;
      },
      toDataURL(type?: unknown, _quality?: unknown): string {
        const engine = canvasEngines.get(nodeId);
        const bytes = engine?.toPngBytes();
        if (bytes === undefined) {
          // Cold CanvasKit / empty canvas → the 1×1 transparent PNG fallback
          // (spec: zero-size canvases still produce a valid PNG).
          return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        }
        void type; // PNG only — jpeg/webp encode is a documented boundary.
        return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
      },
      toBlob(callback: unknown, type?: unknown, _quality?: unknown): void {
        if (typeof callback !== "function") return;
        const engine = canvasEngines.get(nodeId);
        const bytes = engine?.toPngBytes();
        void type;
        const blob =
          bytes === undefined
            ? null
            : {
                type: "image/png",
                size: bytes.length,
                arrayBuffer: () => Promise.resolve(bytes.slice().buffer),
              };
        try {
          (callback as (blob: unknown) => void)(blob);
        } catch {
          // Guest/page code may throw here; swallowed by design.
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
        if (tag === "iframe") {
          const n = Number(value);
          if (Number.isFinite(n)) {
            session.setAttribute(nodeId, "width", String(n));
            mutations += 1;
            refreshIframeViewport(nodeId);
          }
          return;
        }
        if (tag === "canvas" || tag === "img" || tag === "video") {
          const n = Number(value) || 0;
          session.setAttribute(nodeId, "width", String(n));
          // Spec: setting canvas dims resets the bitmap AND the context state.
          if (tag === "canvas") {
            const h = session.dom.nodes.get(nodeId)?.attrs?.get("height");
            const hh = Number.isFinite(Number(h)) ? Number(h) : 150;
            canvasEngines.get(nodeId)?.resize(n, hh);
            webglCores.get(nodeId)?.resize(n, hh);
          }
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
        if (tag === "iframe") {
          const n = Number(value);
          if (Number.isFinite(n)) {
            session.setAttribute(nodeId, "height", String(n));
            mutations += 1;
            refreshIframeViewport(nodeId);
          }
          return;
        }
        if (tag === "canvas" || tag === "img" || tag === "video") {
          const n = Number(value) || 0;
          session.setAttribute(nodeId, "height", String(n));
          if (tag === "canvas") {
            const w = session.dom.nodes.get(nodeId)?.attrs?.get("width");
            const ww = Number.isFinite(Number(w)) ? Number(w) : 300;
            canvasEngines.get(nodeId)?.resize(ww, n);
            webglCores.get(nodeId)?.resize(ww, n);
          }
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
    // HTMLFormElement named getter (HTML §4.10.3): `form.foo` resolves the
    // associated control named `foo` (or a RadioNodeList for a group). The
    // wrapper is a plain object, so a Proxy supplies the dynamic named-getter
    // trap; real properties keep winning (`in` check first).
    if (session.dom.nodes.get(nodeId)?.tag === "form") {
      const proxied = new Proxy(wrapper, {
        get(t, prop, recv) {
          if (Reflect.has(t, prop)) return Reflect.get(t, prop, recv) as unknown;
          if (typeof prop !== "string" || prop === "") return undefined;
          const hits = associatedControls(nodeId).filter((cid) => {
            const n = session.dom.nodes.get(cid);
            return n?.attrs?.get("name") === prop || n?.attrs?.get("id") === prop;
          });
          if (hits.length === 0) return undefined;
          if (hits.length === 1) return makeElementCached(hits[0]!);
          // RadioNodeList shape: the group with a live `value` accessor.
          return radioNodeList(hits);
        },
        has(t, prop) {
          if (Reflect.has(t, prop)) return true;
          if (typeof prop !== "string" || prop === "") return false;
          return associatedControls(nodeId).some((cid) => {
            const n = session.dom.nodes.get(cid);
            return n?.attrs?.get("name") === prop || n?.attrs?.get("id") === prop;
          });
        },
      });
      idOf.set(proxied, nodeId);
      return proxied;
    }
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
        .map(([key, decl]) => `${key}: ${decl.value}${decl.priority === "important" ? " !important" : ""}`)
        .join("; ");
    const commit = (map: Map<string, StyleDeclarationEntry>): void => {
      session.setAttribute(nodeId, "style", serialize(map));
      mutations += 1;
      refreshIframeViewport(nodeId);
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
        const flex = specifiedShorthand(name, map);
        if (flex !== null) return flex;
        return map.get(name)?.value ?? "";
      },
      getPropertyPriority(prop: unknown): string {
        return parse().get(String(prop))?.priority ?? "";
      },
      setProperty(prop: unknown, value?: unknown, priority?: unknown): void {
        const map = parse();
        const name = String(prop);
        const text = value === undefined ? "" : cssomString(value);
        const priorityText = priority === undefined ? "" : cssomString(priority);
        const flag: StylePriority = priorityText.toLowerCase() === "important" ? "important" : "";
        const longhands = shorthandLonghands(name);
        // An empty value removes the declaration before priority is checked.
        if (text === "") {
          map.delete(name);
          if (longhands !== null) for (const longhand of longhands) map.delete(longhand);
          commit(map);
          return;
        }
        if (priorityText !== "" && flag !== "important") return;
        const gridLine = canonicalGridLine(name, text);
        if (isGridLineProperty(name)) {
          if (gridLine === null) return;
          map.set(name, { value: gridLine, priority: flag });
          commit(map);
          return;
        }
        if (name === "grid-template-columns" || name === "grid-template-rows") {
          const canon = canonicalTrackList(text);
          if (canon === null) return;
          map.set(name, { value: canon, priority: flag });
          commit(map);
          return;
        }
        if (name === "grid-template-areas") {
          const areas = canonicalGridAreas(text);
          if (areas === null) return;
          map.set(name, { value: areas, priority: flag });
          commit(map);
          return;
        }
        if (longhands !== null) {
          const expanded = expandShorthand(name, text);
          if (expanded === null) return;
          const stored: { property: string; value: string }[] = [];
          for (const decl of expanded) {
            const canon = canonicalFlexComponent(decl.property, decl.value);
            if (canon === null) return;
            stored.push({ property: decl.property, value: canon });
          }
          map.delete(name);
          for (const longhand of longhands) map.delete(longhand);
          for (const decl of stored) map.set(decl.property, { value: decl.value, priority: flag });
          commit(map);
          return;
        }
        const stored = canonicalCssValue(name, text);
        if (stored === null) return;
        map.set(name, { value: stored, priority: flag });
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
        return serializeStyleBlock(parse());
      },
      set cssText(value: unknown) {
        commit(styleBlockFromCssText(value == null ? "" : cssomString(value)));
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
    type StyleRuleEntry = { cssText: string };
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
        if (ch === "\\") {
          i += 1;
          continue;
        }
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
    const ruleView = (cssText: string): object => cssRuleObject(cssText);
    const sheet: Record<string, unknown> = {
      get ownerNode(): object {
        return makeElementCached(nodeId);
      },
      get cssRules(): object[] {
        ensureRulesParsed();
        return rules.map((r) => ruleView(r.cssText));
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

  /** Cache wrappers per node id so repeated lookups return a stable object.
   * WeakRef + FinalizationRegistry (RFC 0041): the map must never pin a
   * wrapper — guest code holding nothing means the wrapper (and the node's
   * JS-side state) is collectible, which is what makes wrapper caches
   * leak-free across long sessions and navigations. */
  const wrapperCache = new WrapperCache();
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
    } else if (tag === "#shadow-root") {
      Object.setPrototypeOf(w, ShadowRootCtor.prototype as object);
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
    // RFC 0035: the HTMLMediaElement/HTMLVideoElement surface — state lives
    // in the shared MediaEngine (scriptless pages still load/probe/frame it).
    if ((tag === "video" || tag === "audio") && options.media !== undefined) {
      Object.defineProperties(w, mediaDescriptors(options.media, id));
    }
    if (tag === "style" || tag === "link") {
      Object.defineProperty(w, "sheet", {
        get: () => makeStyleSheetObject(id),
        enumerable: true,
        configurable: true,
      });
    }
    if (tag === "#shadow-root") {
      // ShadowRoot surface: host, mode, and a getElementById scoped to the
      // shadow tree (document.getElementById must never reach inside — the
      // shadow root is not in `children`, so document walks never see it).
      Object.defineProperties(w, {
        host: {
          get: () => {
            const p = session.dom.nodes.get(id)?.parent;
            return p === null || p === undefined ? null : makeElementCached(p);
          },
          enumerable: true,
        },
        mode: {
          get: () => session.dom.nodes.get(id)?.attrs?.get("mode") ?? "open",
          enumerable: true,
        },
        getElementById: {
          value: (idAttr: unknown) => {
            const want = coerceGuestString(idAttr);
            const found = elementIdsByAttrValue(id, "id", want)[0];
            return found === undefined ? null : makeElementCached(found);
          },
        },
      });
    }
    if (tag === "slot") {
      Object.defineProperties(w, {
        name: {
          get: () => session.dom.nodes.get(id)?.attrs?.get("name") ?? "",
          set: (v: unknown) => session.setAttribute(id, "name", coerceGuestString(v)),
          enumerable: true,
        },
        assignedNodes: {
          value: (_opts?: unknown) =>
            slotAssignedIds(id).map((n) => makeElementCached(n)),
        },
        assignedElements: {
          value: (_opts?: unknown) =>
            slotAssignedIds(id)
              .filter((n) => session.dom.nodes.get(n)?.kind === "element")
              .map((n) => makeElementCached(n)),
        },
      });
    }
    wrapperCache.set(id, w);
    // Custom Elements: a defined tag/`is=` upgrades on first wrapper creation —
    // the ctor runs with the wrapper as `this` (HTMLElement.super() yields it).
    ceUpgradeIfDefined(id);
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
    const tree = parseHtml(new TextEncoder().encode(html));
    for (const contentId of fragmentContentRoots(tree)) {
      const child = tree.nodes.get(contentId);
      if (child === undefined) continue;
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

  /**
   * An engine-created event. RFC 0020: platform events are real guest event
   * class instances (typed by name via {@link classForEventType}) marked
   * trusted — `e instanceof MouseEvent` and `e.isTrusted` hold inside
   * listeners, while guest `new Event(...)` yields the same class untrusted.
   */
  function makeEvent(type: string, opts?: { bubbles?: boolean; cancelable?: boolean; composed?: boolean }): GuestEvent {
    return platformEvent(type, { ...opts });
  }

  /**
   * The DOM ancestor path of `id` (node → root, inclusive). Stops at a
   * `"#shadow-root"` — its DOM parent is null (the host is only its
   * SHADOW-INCLUDING parent). Event dispatch uses {@link shadowPath} instead.
   */
  function ancestorPath(id: NodeId): NodeId[] {
    const path: NodeId[] = [];
    let cur: NodeId | null = id;
    while (cur !== null) {
      path.push(cur);
      const n = session.dom.nodes.get(cur);
      cur = n === undefined || n.tag === "#shadow-root" ? null : (n.parent ?? null);
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
    _setComposedPath?: (path: object[]) => void;
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

  /** `el.onload = fn` is an own property of the wrapper, not an attribute. */
  function invokePropertyHandler(node: NodeId, evt: GuestEvent): void {
    if (propagationStopped(evt)) return;
    const host = makeElementCached(node) as Record<string, unknown>;
    const handler = host[`on${evt.type}`];
    if (typeof handler !== "function") return;
    const result = (handler as (this: unknown, event: GuestEvent) => unknown).call(host, evt);
    if (result === false) evt.preventDefault();
  }

  function iframeCssPx(style: string, name: string): number | undefined {
    const match = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)px`, "i").exec(style);
    if (match === null) return undefined;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : undefined;
  }

  function iframeViewport(nodeId: NodeId): { width: number; height: number } {
    const node = session.dom.nodes.get(nodeId);
    const style = node?.attrs?.get("style") ?? "";
    const widthAttr = Number(node?.attrs?.get("width"));
    const heightAttr = Number(node?.attrs?.get("height"));
    return {
      width: iframeCssPx(style, "width") ?? (Number.isFinite(widthAttr) && widthAttr > 0 ? widthAttr : 300),
      height: iframeCssPx(style, "height") ?? (Number.isFinite(heightAttr) && heightAttr > 0 ? heightAttr : 150),
    };
  }

  function iframeMedia(nodeId: NodeId): MediaEnvironment {
    const box = iframeViewport(nodeId);
    return { type: "screen", widthPx: box.width, heightPx: box.height };
  }

  /** `srcdoc` iframe: a child session whose `@media` viewport is this element's size. */
  function navigateSrcdoc(nodeId: NodeId): void {
    const node = session.dom.nodes.get(nodeId);
    if (node?.tag !== "iframe" || frameLookup !== null) return;
    if (!isConnectedToDocument(session.dom, nodeId)) return;
    const srcdoc = node.attrs?.get("srcdoc");
    if (srcdoc === undefined) return;
    const childSession = new FineSession(srcdoc, session.url);
    childSession.setMedia(iframeMedia(nodeId));
    const child = buildDocumentApi(childSession, { scheduleFrame });
    const frameWindow = {
      document: child.document,
      getComputedStyle: child.globals["getComputedStyle"] as (el: unknown) => object,
      get innerWidth(): number {
        return iframeViewport(nodeId).width;
      },
      get innerHeight(): number {
        return iframeViewport(nodeId).height;
      },
      matchMedia: createMatchMedia(() => iframeMedia(nodeId)),
      addEventListener(): void {},
      removeEventListener(): void {},
    };
    srcdocFrames.set(nodeId, { session: childSession, window: frameWindow });
    blankFrames.delete(nodeId);
    dispatch(nodeId, makeEvent("load"));
  }

  function refreshIframeViewport(nodeId: NodeId): void {
    srcdocFrames.get(nodeId)?.session.setMedia(iframeMedia(nodeId));
    blankFrames.get(nodeId)?.viewportChanged();
  }

  /** about:blank iframe: a child window whose media viewport is this element's size. */
  function connectBlankIframes(nodeId: NodeId): void {
    const node = session.dom.nodes.get(nodeId);
    if (node === undefined) return;
    if (node.kind === "element" && node.tag === "iframe" && frameLookup === null) {
      const srcdoc = node.attrs?.get("srcdoc");
      const src = node.attrs?.get("src");
      if (srcdoc !== undefined) {
        navigateSrcdoc(nodeId);
      } else if (!blankFrames.has(nodeId) && !srcdocFrames.has(nodeId) && (src === undefined || src === "" || src === "about:blank")) {
        blankFrames.set(nodeId, createBlankFrame({
          viewport: () => iframeViewport(nodeId),
          scheduleFrame,
        }));
        dispatch(nodeId, makeEvent("load"));
      }
    }
    for (const child of node.children) connectBlankIframes(child);
  }

  /** Run the element's inline `on<type>` attribute handler (if any) at target. */
  function invokeInlineHandler(node: NodeId, evt: GuestEvent): void {
    if (propagationStopped(evt)) return;
    const body = session.dom.nodes.get(node)?.attrs?.get(`on${evt.type}`);
    if (body === undefined || compileInlineHandler === null) return;
    // RFC 0027: inline event handlers are `script-src-attr` inline blocks —
    // a refused policy blocks BOTH the compile and the dispatch (the handler
    // simply does not exist for this event).
    const csp = session.csp;
    if (csp !== null && !csp.checkInline("script", { text: body }, "attr").allowed) return;
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

  /** The labeled control (HTML §4.10.4): `label[for=id]` resolves by id;
   * otherwise the first labelable descendant in tree order. */
  function labeledControlOf(labelId: NodeId): NodeId | null {
    const forAttr = session.dom.nodes.get(labelId)?.attrs?.get("for");
    if (forAttr !== undefined && forAttr !== "") {
      for (const [id, n] of session.dom.nodes) {
        if (n?.kind === "element" && n.attrs?.get("id") === forAttr) {
          return labelable(n) ? id : null;
        }
      }
      return null;
    }
    const visit = (id: NodeId): NodeId | null => {
      for (const childId of session.dom.nodes.get(id)?.children ?? []) {
        const n = session.dom.nodes.get(childId);
        if (n?.kind === "element" && labelable(n)) {
          return childId;
        }
        const found = visit(childId);
        if (found !== null) return found;
      }
      return null;
    };
    return visit(labelId);
  }

  /** The labelable elements (HTML §4.10.4): the controls a label forwards to. */
  function labelable(n: DomNode): boolean {
    return (
      n.tag === "input" ||
      n.tag === "button" ||
      n.tag === "select" ||
      n.tag === "textarea" ||
      n.tag === "meter" ||
      n.tag === "output" ||
      n.tag === "progress"
    );
  }

  /** The owning `<select>` of an option/optgroup (nearest ancestor). */
  function ownerSelect(id: NodeId): NodeId | null {
    let cur = session.dom.nodes.get(id)?.parent ?? null;
    const seen = new Set<NodeId>();
    while (cur !== null && seen.add(cur)) {
      const n = session.dom.nodes.get(cur);
      if (n?.tag === "select") return cur;
      cur = n?.parent ?? null;
    }
    return null;
  }

  function activateCheckboxRadio(id: NodeId, radio: boolean): void {
    // Clicking a checked radio is a no-op (radios don't uncheck on click).
    if (radio && controlChecked(id)) return;
    patchControl(id, { checked: radio ? true : !controlChecked(id), touched: true });
    if (radio) radioGroupUncheck(id);
    dispatch(id, makeEvent("input", { bubbles: true }));
    dispatch(id, makeEvent("change", { bubbles: true }));
  }

  /** Uncheck every other radio in `id`'s group (same name + form owner —
   * HTML §4.10.5.1.17 radio-button-group semantics). */
  function radioGroupUncheck(id: NodeId): void {
    const node = session.dom.nodes.get(id);
    if (node === undefined) return;
    for (const peer of radioGroupPeers(session.dom, node)) {
      if (controlChecked(peer)) patchControl(peer, { checked: false });
    }
  }

  function activateFormControl(id: NodeId, type: string): void {
    const form = ownerForm(id);
    if (form === null) return;
    if (type === "submit") submitForm(form, id);
    else if (type === "reset") resetForm(form);
  }

  /**
   * a/area activation (RFC 0011, HTML §4.8.11): resolve `href` against the
   * document and navigate — full navigations via the host navigator (which
   * itself detects same-document fragment hops), falling back to the harness
   * hashNavigator for test paths without a session host. No `href` ⇒ the
   * element isn't a link; `download` ⇒ no navigation.
   */
  function activateLink(id: NodeId): void {
    const node = session.dom.nodes.get(id);
    if (node?.kind !== "element") return;
    const href = node.attrs?.get("href");
    if (href === undefined) return;
    let abs: string | null = null;
    try {
      abs = new HostURL(href, session.baseUrl).href;
    } catch {
      abs = null;
    }
    if (abs === null) return;
    const target = node.attrs?.get("target") ?? "";
    const download = node.attrs?.get("download");
    const referrerPolicy = node.attrs?.get("referrerpolicy");
    if (navigatorSink !== null) {
      const init: { target?: string; download?: string; referrerPolicy?: string } = {};
      if (target !== "") init.target = target;
      // The attr is a filename HINT (empty string ⇒ server/URL decides).
      if (download !== undefined) init.download = download;
      if (referrerPolicy !== undefined) init.referrerPolicy = referrerPolicy;
      if (
        init.target !== undefined ||
        init.download !== undefined ||
        init.referrerPolicy !== undefined
      ) {
        navigatorSink(abs, init);
      } else {
        navigatorSink(abs, undefined);
      }
      return;
    }
    if (download !== undefined) return; // harness path: still suppress nav
    // Harness path (no session host): same-document fragment hops only.
    const hashIndex = href.indexOf("#");
    if (hashIndex >= 0 && sameDocumentHref(abs, session.url)) {
      navigateToHashFragment?.(href.slice(hashIndex + 1));
    }
  }

  function sameDocumentHref(a: string, b: string): boolean {
    try {
      const ua = new HostURL(a);
      const ub = new HostURL(b);
      ua.hash = "";
      ub.hash = "";
      return ua.href === ub.href;
    } catch {
      return a.split("#")[0] === b.split("#")[0];
    }
  }

  // ---- Form submission (RFC 0011, HTML §4.10.21) -----------------------------

  /** Live control value: nodeState override (script/keyboard edits) wins;
   * otherwise textarea text / the `value` attribute seed. */
  function controlValue(id: NodeId): string {
    const state = nodeState.get(id);
    if (state?.value !== undefined) return state.value;
    const node = session.dom.nodes.get(id);
    if (node?.kind !== "element") return "";
    if (node.tag === "textarea") {
      return (node.children ?? [])
        .map((c) => session.dom.nodes.get(c))
        .filter((c) => c?.kind === "text")
        .map((c) => (c as { text: string }).text)
        .join("");
    }
    return node.attrs?.get("value") ?? "";
  }

  function controlChecked(id: NodeId): boolean {
    const node = session.dom.nodes.get(id);
    if (node === undefined) return false;
    return domChecked(session.dom, node);
  }

  /** "Actually disabled" — attr OR `fieldset[disabled]` ancestor (HTML
   * §4.10.18.1), shared with `:disabled` matching via cascade/form-state. */
  function controlDisabled(id: NodeId): boolean {
    const node = session.dom.nodes.get(id);
    if (node === undefined) return false;
    return domDisabled(node, session.dom);
  }

  /** Node text via the module helper (select option default value). */
  const controlTextOf = (id: NodeId): string => textContentOf(session.dom, id);

  // ---- RFC 0021: form-control surface helpers -------------------------------

  /** option.value — the `value` attribute, else the option's label text
   * (HTML §4.10.11 option value rule). */
  function optionValue(id: NodeId): string {
    const node = session.dom.nodes.get(id);
    if (node === undefined) return "";
    return node.attrs?.get("value") ?? controlTextOf(id).trim().replace(/\s+/g, " ");
  }

  /** boolean content-attribute reflector (`el.disabled = x` ⇄ attr). */
  const reflectBool = {
    get: (id: NodeId, attr: string): boolean => hasElementAttr(id, attr),
    set: (id: NodeId, attr: string, v: unknown): void => {
      if (v === true || (typeof v !== "boolean" && Boolean(v))) {
        session.setAttribute(id, attr, "");
      } else {
        session.removeAttribute(id, attr);
      }
      mutations += 1;
    },
  };
  /** string content-attribute reflector. */
  const reflectStr = {
    get: (id: NodeId, attr: string): string =>
      session.dom.nodes.get(id)?.attrs?.get(attr) ?? "",
    set: (id: NodeId, attr: string, v: unknown): void => {
      session.setAttribute(id, attr, coerceGuestString(v));
      mutations += 1;
    },
  };
  /** integer content-attribute reflector (min -2147483648 clamp per IDL). */
  const reflectLong = {
    get: (id: NodeId, attr: string, dflt: number): number => {
      const raw = session.dom.nodes.get(id)?.attrs?.get(attr);
      const n = raw === undefined ? NaN : parseInt(raw, 10);
      return Number.isFinite(n) ? n : dflt;
    },
    set: (id: NodeId, attr: string, v: unknown): void => {
      session.setAttribute(id, attr, String(Math.trunc(Number(v) || 0)));
      mutations += 1;
    },
  };

  // ---- Constraint validation (HTML §4.10.21.2 — flags computed by the
  // shared cascade/form-state module so `:valid` and `checkValidity` agree)

  function validityFlagsOf(id: NodeId): ValidityFlags {
    const node = session.dom.nodes.get(id);
    if (node === undefined || node.kind !== "element") {
      return { valueMissing: false, typeMismatch: false, patternMismatch: false,
        tooLong: false, tooShort: false, rangeUnderflow: false, rangeOverflow: false,
        stepMismatch: false, badInput: false, customError: false };
    }
    return computeValidity(session.dom, node);
  }

  /** A ValidityState snapshot: all ten flags + `valid`. */
  function validityObject(id: NodeId): object {
    const f = validityFlagsOf(id);
    return {
      ...f,
      get valid(): boolean {
        return Object.values(f).every((v) => !v);
      },
    };
  }

  /** Spec-shape default validation messages per failing flag. */
  const VALIDATION_MESSAGES: Readonly<Record<keyof ValidityFlags, string>> = {
    valueMissing: "Please fill out this field.",
    typeMismatch: "Please enter a valid value.",
    patternMismatch: "Please match the requested format.",
    tooLong: "Please shorten this text.",
    tooShort: "Please lengthen this text.",
    rangeUnderflow: "Value must be greater than or equal to the minimum.",
    rangeOverflow: "Value must be less than or equal to the maximum.",
    stepMismatch: "Please enter a valid value.",
    badInput: "Please enter a number.",
    customError: "",
  };

  function validationMessageOf(id: NodeId): string {
    const f = validityFlagsOf(id);
    if (f.customError) return nodeState.get(id)?.customError ?? "";
    for (const key of Object.keys(VALIDATION_MESSAGES) as (keyof ValidityFlags)[]) {
      if (f[key]) return VALIDATION_MESSAGES[key];
    }
    return "";
  }

  /** checkValidity/reportValidity (HTML §4.10.21.3): return the validity
   * verdict; on failure fire the cancelable `invalid` event (the bubble UI
   * of reportValidity has no harness surface — event semantics only). */
  function checkControlValidity(id: NodeId): boolean {
    const f = validityFlagsOf(id);
    if (Object.values(f).every((v) => !v)) return true;
    dispatch(id, makeEvent("invalid", { cancelable: true }));
    return false;
  }

  function controlWillValidate(id: NodeId): boolean {
    const node = session.dom.nodes.get(id);
    return node !== undefined && domWillValidate(session.dom, node);
  }

  /** The option elements of a select/datalist (DOM order, ids). */
  function optionIdsOf(id: NodeId): NodeId[] {
    const node = session.dom.nodes.get(id);
    if (node === undefined) return [];
    return selectOptions(session.dom, node).map((o) => o.id);
  }

  /**
   * A live HTMLCollection-like view over a computed id list — numeric
   * indices, `length`, `item`, `namedItem`, and named-property lookup
   * resolve against the CURRENT dom on every access (a Proxy, so indices
   * stay live without re-materializing).
   */
  function controlCollection(ids: () => readonly NodeId[]): object {
    const target: Record<string | symbol, unknown> = {};
    return new Proxy(target, {
      get(_t, prop) {
        const list = ids();
        if (prop === "length") return list.length;
        if (prop === "item") return (i: unknown) => {
          const n = Math.trunc(Number(i));
          const id = Number.isFinite(n) && n >= 0 ? list[n] : undefined;
          return id === undefined ? null : makeElementCached(id);
        };
        if (prop === "namedItem") return (name: unknown) => {
          const key = String(name);
          const hits = list.filter((c) => {
            const n = session.dom.nodes.get(c);
            return n?.attrs?.get("id") === key || n?.attrs?.get("name") === key;
          });
          if (hits.length === 0) return null;
          // HTMLFormControlsCollection.namedItem: multiple hits ⇒ RadioNodeList.
          return hits.length === 1 ? makeElementCached(hits[0]!) : radioNodeList(hits);
        };
        if (prop === Symbol.iterator) {
          return function* () {
            for (const c of ids()) yield makeElementCached(c);
          };
        }
        if (typeof prop === "string") {
          if (/^\d+$/.test(prop)) {
            const id = list[Number(prop)];
            return id === undefined ? undefined : makeElementCached(id);
          }
          const hits = list.filter((c) => {
            const n = session.dom.nodes.get(c);
            return n?.attrs?.get("id") === prop || n?.attrs?.get("name") === prop;
          });
          if (hits.length === 1) return makeElementCached(hits[0]!);
          if (hits.length > 1) return radioNodeList(hits);
        }
        return (target)[prop];
      },
      has(_t, prop) {
        if (typeof prop !== "string") return false;
        const list = ids();
        if (/^\d+$/.test(prop)) return Number(prop) < list.length;
        return list.some((c) => {
          const n = session.dom.nodes.get(c);
          return n?.attrs?.get("id") === prop || n?.attrs?.get("name") === prop;
        });
      },
    });
  }

  /**
   * RadioNodeList: a control collection over a same-named group plus the
   * live `value` accessor (HTML §4.10.5 — reads the checked member's value,
   * setting checks the member whose value matches).
   */
  function radioNodeList(hitIds: readonly NodeId[]): object {
    const list = controlCollection(() => hitIds);
    Object.defineProperty(list, "value", {
      configurable: true,
      get: () => {
        const sel = hitIds.find((cid) => controlChecked(cid));
        return sel === undefined ? "" : controlValue(sel);
      },
      set: (v: unknown) => {
        const wanted = String(v);
        const hit = hitIds.find((cid) => {
          const n = session.dom.nodes.get(cid);
          if (n === undefined) return false;
          const kind = n.tag === "input" ? (n.attrs?.get("type") ?? "text").toLowerCase() : "";
          return (kind === "radio" || kind === "checkbox") && controlValue(cid) === wanted;
        });
        if (hit !== undefined) patchControl(hit, { checked: true });
      },
    });
    return list;
  }

  /** Elements labeling `id` — `label[for=id]` plus wrapping ancestors. */
  function labelsOf(id: NodeId): NodeId[] {
    const out: NodeId[] = [];
    for (const [lid, n] of session.dom.nodes) {
      if (n?.tag !== "label") continue;
      if (labeledControlOf(lid) === id) out.push(lid);
    }
    return out;
  }

  /** Selection state for text-entry controls (caret at end by default). */
  function selOf(id: NodeId): { start: number; end: number; dir: string } {
    const s = nodeState.get(id);
    const len = [...controlValue(id)].length;
    return {
      start: Math.min(s?.selStart ?? len, len),
      end: Math.min(s?.selEnd ?? len, len),
      dir: s?.selDir ?? "none",
    };
  }

  /** The datalist element an `input[list]` resolves to (or null). */
  function listDatalist(id: NodeId): NodeId | null {
    const listAttr = session.dom.nodes.get(id)?.attrs?.get("list");
    if (listAttr === undefined) return null;
    for (const [lid, n] of session.dom.nodes) {
      if (n?.kind === "element" && n.tag === "datalist" && n.attrs?.get("id") === listAttr) {
        return lid;
      }
    }
    return null;
  }

  /** `input.stepUp`/`stepDown` (number/range — HTML §4.10.5.3.10/11). */
  function stepBy(id: NodeId, n: number, dir: 1 | -1): void {
    const node = session.dom.nodes.get(id);
    if (node?.tag !== "input") return;
    const t = inputType(node);
    if (t !== "number" && t !== "range") {
      throw new DOMException("stepUp: not allowed for this input type", "InvalidStateError");
    }
    const stepRaw = node.attrs?.get("step");
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    const unit = Number.isFinite(step) && step > 0 ? step : 1;
    const cur = valueAsNumber(t, controlValue(id));
    const base = Number(node.attrs?.get("min") ?? "") || 0;
    const next = cur === null ? base + n * dir * unit : cur + n * dir * unit;
    const min = Number(node.attrs?.get("min"));
    const max = Number(node.attrs?.get("max"));
    let v = next;
    if (Number.isFinite(min) && v < min) v = min;
    if (Number.isFinite(max) && v > max) v = max;
    setTextValue(id, String(v));
    mutations += 1;
  }

  /** All form-associated elements belonging to `formId` (descendants + `form=`). */
  function associatedControls(formId: NodeId): NodeId[] {
    const formNode = session.dom.nodes.get(formId);
    const formAttrId = formNode?.attrs?.get("id");
    const out: NodeId[] = [];
    // HTML §4.10.3 "listed elements" — what form.elements exposes.
    const isControl = (tag: string | undefined): boolean =>
      tag === "input" || tag === "textarea" || tag === "select" ||
      tag === "button" || tag === "fieldset" || tag === "output";
    const walk = (id: NodeId): void => {
      for (const c of session.dom.nodes.get(id)?.children ?? []) {
        const n = session.dom.nodes.get(c);
        if (n?.kind === "element" && isControl(n.tag)) out.push(c);
        walk(c);
      }
    };
    walk(formId);
    if (formAttrId !== undefined) {
      for (const [id, n] of session.dom.nodes) {
        if (n?.kind === "element" && isControl(n.tag) && n.attrs?.get("form") === formAttrId && !out.includes(id)) {
          out.push(id);
        }
      }
    }
    return out;
  }

  /**
   * Successful controls (HTML §4.10.21.7): named, enabled; checkable controls
   * only when checked; only the activating submitter contributes a name.
   */
  function successfulControls(formId: NodeId, submitterId: NodeId | null): [string, string][] {
    const pairs: [string, string][] = [];
    for (const id of associatedControls(formId)) {
      const node = session.dom.nodes.get(id);
      if (node?.kind !== "element" || controlDisabled(id)) continue;
      const name = node.attrs?.get("name");
      const tag = node.tag;
      const type = (node.attrs?.get("type") ?? "").toLowerCase();
      if (tag === "select") {
        if (name === undefined) continue;
        const multiple = node.attrs?.has("multiple") === true;
        let picked = false;
        const options = selectOptions(session.dom, node);
        for (const opt of options) {
          const selected = domSelected(session.dom, opt);
          // Nothing selected in a single-select ⇒ the FIRST option submits.
          if (selected || (!picked && !multiple && options[0] === opt)) {
            pairs.push([name, optionValue(opt.id)]);
            picked = true;
            if (!multiple) break;
          }
        }
        continue;
      }
      if (tag === "output") {
        if (name !== undefined) pairs.push([name, controlValue(id)]);
        continue;
      }
      if (tag === "fieldset") continue; // fieldsets are listed, not submittable.
      if (tag === "textarea") {
        if (name !== undefined) pairs.push([name, controlValue(id)]);
        continue;
      }
      if (tag === "button") {
        const btype = type === "" ? "submit" : type;
        if (btype === "submit" && id === submitterId && name !== undefined) {
          pairs.push([name, node.attrs?.get("value") ?? ""]);
        }
        continue;
      }
      if (tag === "input") {
        if (type === "checkbox" || type === "radio") {
          if (name !== undefined && controlChecked(id)) {
            pairs.push([name, node.attrs?.get("value") ?? "on"]);
          }
          continue;
        }
        if (type === "submit" || type === "image") {
          if (id === submitterId && name !== undefined) {
            pairs.push([name, controlValue(id)]);
          }
          continue;
        }
        if (type === "button" || type === "reset" || type === "file") continue;
        // hidden/text/…/empty/unknown — text semantics submit the value.
        if (name !== undefined) pairs.push([name, controlValue(id)]);
      }
    }
    return pairs;
  }

  /** application/x-www-form-urlencoded — space is "+", everything else %XX. */
  function encodeUrlencoded(pairs: readonly [string, string][]): string {
    const enc = (s: string): string => encodeURIComponent(s).replace(/%20/g, "+");
    return pairs.map(([n, v]) => `${enc(n)}=${enc(v)}`).join("&");
  }

  /**
   * Form submission (HTML §4.10.21): dispatch `submit` (cancelable — aborts),
   * then mutate-or-navigate per method. `form.submit()` skips the event per
   * spec (`skipEvent`). Submitter `formaction`/`formmethod`/`formenctype`
   * override the form's attributes.
   */
  function submitForm(formId: NodeId, submitterId: NodeId | null, skipEvent = false): void {
    const form = session.dom.nodes.get(formId);
    if (form?.kind !== "element") return;
    if (!skipEvent && !dispatch(formId, makeEvent("submit", { bubbles: true, cancelable: true }))) {
      return;
    }
    // Interactive validation (HTML §4.10.21.6): unless the form/submitter
    // opts out, invalid controls abort the submission — each gets a
    // cancelable `invalid` event and the first invalid control takes focus.
    const subNode = submitterId !== null ? session.dom.nodes.get(submitterId) : undefined;
    const novalidate =
      form.attrs?.has("novalidate") === true ||
      subNode?.attrs?.has("formnovalidate") === true;
    if (!novalidate) {
      const invalid: NodeId[] = [];
      for (const cid of associatedControls(formId)) {
        const cn = session.dom.nodes.get(cid);
        if (cn === undefined || !domWillValidate(session.dom, cn)) continue;
        const flags = computeValidity(session.dom, cn);
        if (Object.values(flags).some((v) => v)) invalid.push(cid);
      }
      if (invalid.length > 0) {
        for (const cid of invalid) {
          dispatch(cid, makeEvent("invalid", { cancelable: true }));
        }
        const first = invalid.find((cid) => isFocusable(cid));
        if (first !== undefined) setFocused(first, false);
        return;
      }
    }
    const sub = submitterId !== null ? session.dom.nodes.get(submitterId) : undefined;
    const subAttrs = sub?.kind === "element" ? sub.attrs : undefined;
    const action = subAttrs?.get("formaction") ?? form.attrs?.get("action") ?? session.url;
    const method = (subAttrs?.get("formmethod") ?? form.attrs?.get("method") ?? "get").toLowerCase();
    const enctype = (subAttrs?.get("formenctype") ?? form.attrs?.get("enctype") ?? "application/x-www-form-urlencoded").toLowerCase();
    const target = subAttrs?.get("formtarget") ?? form.attrs?.get("target") ?? "";
    // Element-level Referrer-Policy: submitter's `formreferrerpolicy` wins
    // over the form's `referrerpolicy` (HTML §4.10.21 submission rules).
    const referrerPolicy = subAttrs?.get("formreferrerpolicy") ?? form.attrs?.get("referrerpolicy");
    const rpInit =
      referrerPolicy === undefined ? {} : { referrerPolicy };
    let abs: string;
    try {
      abs = new HostURL(action, session.baseUrl).href;
    } catch {
      return;
    }
    if (method === "dialog") return; // dialog closes a <dialog> — out of scope.
    const pairs = successfulControls(formId, submitterId);
    if (method === "post") {
      let body: string;
      let contentType = enctype;
      if (enctype === "text/plain") {
        body = pairs.map(([n, v]) => `${n}=${v}`).join("\r\n") + "\r\n";
      } else {
        body = encodeUrlencoded(pairs);
        contentType = "application/x-www-form-urlencoded";
      }
      navigatorSink?.(abs, {
        method: "POST",
        body,
        contentType,
        ...(target === "" ? {} : { target }),
        ...rpInit,
      });
      return;
    }
    // GET (and anything else): query replaces action's existing query.
    const url = new HostURL(abs);
    url.search = "";
    const encoded = encodeUrlencoded(pairs);
    navigatorSink?.(encoded === "" ? url.href : `${url.href}?${encoded}`, {
      ...(target === "" ? {} : { target }),
      ...rpInit,
    });
  }

  /** `reset` activation: cancelable event first, then controls revert to markup defaults. */
  function resetForm(formId: NodeId): void {
    if (!dispatch(formId, makeEvent("reset", { bubbles: true, cancelable: true }))) return;
    for (const id of associatedControls(formId)) {
      nodeState.delete(id); // checked/open overrides drop — attrs govern again.
      syncControlState(id);
    }
    mutations += 1;
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
        if ((tag === "a" || tag === "area") && node.attrs?.has("href") === true) {
          activateLink(cur);
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

  /**
   * The shadow-including parent of `id` (DOM §"shadow-including tree"):
   * a slotted light DOM child routes through its assigned `<slot>`; a shadow
   * root's parent is its host; anything else falls back to the DOM parent.
   * This is the parent relation EVENT paths follow — the flattened tree.
   */
  const shadowParentOf = (id: NodeId): NodeId | null => {
    const node = session.dom.nodes.get(id);
    if (node === undefined) return null;
    if (node.tag === "#shadow-root") return node.parent ?? null;
    const slot = assignedSlotFor(id);
    if (slot !== undefined) return slot;
    return node.parent ?? null;
  };

  /** The shadow-including ancestor path `[id, ...ancestors, topmost]`. */
  const shadowPath = (id: NodeId): NodeId[] => {
    const path: NodeId[] = [id];
    let cur = shadowParentOf(id);
    let guard = 0;
    while (cur !== null && guard < 4096) {
      path.push(cur);
      cur = shadowParentOf(cur);
      guard += 1;
    }
    return path;
  };

  /**
   * The event-dispatch SCOPE of `id` for retargeting: a shadow root is its
   * own scope; other nodes take the first enclosing shadow root in their
   * shadow-including parent chain (so a slotted light child belongs to the
   * shadow tree it lands in); document-scope nodes return the topmost.
   */
  const eventScopeOf = (id: NodeId): NodeId => {
    const node = session.dom.nodes.get(id);
    if (node === undefined) return id;
    if (node.tag === "#shadow-root") return id;
    let cur: NodeId | null = id;
    let top: NodeId = id;
    while (cur !== null) {
      const n = session.dom.nodes.get(cur);
      if (n === undefined) break;
      if (n.tag === "#shadow-root") return cur;
      top = cur;
      cur = shadowParentOf(cur);
    }
    return top;
  };

  /** Invoke the listeners registered on `node` for this phase; honour stop flags. */
  function invokeAt(node: NodeId, evt: GuestEvent, capturePhase: boolean): void {
    const list = listeners.get(node);
    if (list === undefined) return;
    const cached = makeElementCached(node);
    setEventCurrentTarget(evt, cached);
    // Shadow-DOM retargeting (DOM §2.9): a listener outside the event's tree
    // sees the deepest path node that shares ITS scope as `target`.
    if (activeDispatchPath !== null && evt.eventPhase !== 2) {
      const want = eventScopeOf(node);
      let adjusted: NodeId | null = null;
      for (const n of activeDispatchPath) {
        if (eventScopeOf(n) === want) {
          adjusted = n;
          break;
        }
      }
      if (adjusted !== null) setEventTarget(evt, makeElementCached(adjusted));
    }
    for (const l of [...list]) {
      if (l.type !== evt.type) continue;
      const isTargetNode = idOf.get(cached) === node && evt.eventPhase === 2;
      if (!isTargetNode && l.capture !== capturePhase) continue;
      l.fn.call(evt.currentTarget, evt);
      if (immediatePropagationStopped(evt)) return;
    }
  }

  /**
   * The full (untruncated, unretargeted) propagation path of the in-flight
   * dispatch — consumed by {@link invokeAt} to compute each listener's
   * retargeted `event.target`. Saved/restored so nested dispatches compose.
   */
  let activeDispatchPath: NodeId[] | null = null;

  /** Dispatch `event` to `targetId` through capture/target/bubble phases. */
  function dispatch(targetId: NodeId, event: GuestEvent): boolean {
    const fullPath = shadowPath(targetId); // [target, ...ancestors, root] — flattened-tree
    // Shadow DOM (DOM §2.9): a non-composed event never crosses the shadow
    // boundary — the propagation path truncates at the shadow root. Composed
    // events keep the full path, and `target` retargets per listener scope.
    const composed = (event as { composed?: boolean }).composed === true;
    const shadowIdx = fullPath.findIndex((id) => session.dom.nodes.get(id)?.tag === "#shadow-root");
    const path = !composed && shadowIdx >= 0 ? fullPath.slice(0, shadowIdx + 1) : fullPath;
    (event as { __composedPath?: NodeId[] }).__composedPath = fullPath;
    const impl = event as DispatchableEvent;
    if (typeof impl._setComposedPath === "function") impl._setComposedPath(fullPath.map((id) => makeElementCached(id)));
    const prevPath = activeDispatchPath;
    activeDispatchPath = fullPath;
    try {
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
      setEventTarget(event, makeElementCached(targetId));
      invokeAt(targetId, event, false);
      invokeInlineHandler(targetId, event);
      invokePropertyHandler(targetId, event);
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
    } finally {
      activeDispatchPath = prevPath;
    }
  }

  /**
   * RFC 0020 — typed platform events. `dispatch` drives any object with the
   * {@link DispatchableEvent} hooks, and every guest event class implements
   * them, so engine-dispatched events are REAL class instances: `e instanceof
   * MouseEvent` / `e instanceof PointerEvent` / `e instanceof Event` hold,
   * and the engine marks them trusted (guest-constructed ones are not).
   */
  type AnyEventCtor = new (type: string, init?: unknown) => Event;
  function classForEventType(type: string): AnyEventCtor {
    // Pointer Events §5.2.5: click/auxclick/dblclick/contextmenu are
    // PointerEvent in a pointer-capable UA.
    if (type === "click" || type === "auxclick" || type === "dblclick" || type === "contextmenu" ||
        type === "gotpointercapture" || type === "lostpointercapture" || type.startsWith("pointer")) {
      return PointerEvent as unknown as AnyEventCtor;
    }
    if (type.startsWith("mouse")) return MouseEvent as unknown as AnyEventCtor;
    if (type.startsWith("key")) return KeyboardEvent as unknown as AnyEventCtor;
    if (type === "focus" || type === "blur" || type === "focusin" || type === "focusout") {
      return FocusEvent as unknown as AnyEventCtor;
    }
    if (type === "input" || type === "beforeinput") return InputEvent as unknown as AnyEventCtor;
    if (type === "wheel") return WheelEvent as unknown as AnyEventCtor;
    if (type.startsWith("composition")) return CompositionEvent as unknown as AnyEventCtor;
    return Event as unknown as AnyEventCtor;
  }

  /** Build a trusted, typed platform event for `type` carrying `init`. */
  function platformEvent(type: string, init?: Record<string, unknown>): GuestEvent {
    const evt = new (classForEventType(type))(type, init ?? {});
    evt._setTrusted(true);
    return evt as unknown as GuestEvent;
  }

  // -----------------------------------------------------------------------
  // Focus machinery (UI Events §focus + HTML §6.5)
  // -----------------------------------------------------------------------

  let focusedId: NodeId | null = null;
  let focusVisibleNow = false;
  let activeId: NodeId | null = null;
  let hoverId: NodeId | null = null;

  const elementAttr = (id: NodeId, name: string): string | undefined =>
    session.dom.nodes.get(id)?.attrs?.get(name);

  const hasElementAttr = (id: NodeId, name: string): boolean =>
    elementAttr(id, name) !== undefined;

  /** Text-editing controls — the subset that can receive inserted text and
   * always renders `:focus-visible` per the UA heuristic. */
  const isTextEditingControl = (id: NodeId): boolean => {
    const tag = session.dom.nodes.get(id)?.tag;
    return tag === "textarea" || (tag === "input" &&
      !["checkbox", "radio", "submit", "reset", "button", "image", "file", "hidden", "range", "color"]
        .includes((elementAttr(id, "type") ?? "text").toLowerCase()));
  };

  /** HTML §"focusable area": natively focusable tags + valid tabindex. */
  function isFocusable(id: NodeId): boolean {
    const node = session.dom.nodes.get(id);
    if (node === undefined || node.kind !== "element") return false;
    if (!isConnectedToDocument(session.dom, id)) return false;
    // `inert` subtrees and `hidden` elements cannot take focus.
    if (hasElementAttr(id, "inert") || hasElementAttr(id, "hidden")) return false;
    const tabindex = elementAttr(id, "tabindex");
    if (tabindex !== undefined && !Number.isNaN(Number(tabindex)) && Number(tabindex) >= 0) {
      return !hasElementAttr(id, "disabled");
    }
    const tag = node.tag ?? "";
    switch (tag) {
      case "a": case "area":
        return hasElementAttr(id, "href");
      case "button":
      case "select":
      case "textarea":
        return !hasElementAttr(id, "disabled");
      case "input": {
        const t = (elementAttr(id, "type") ?? "text").toLowerCase();
        return t !== "hidden" && !hasElementAttr(id, "disabled");
      }
      case "iframe":
        return true;
      case "audio": case "video":
        return hasElementAttr(id, "controls");
      case "body": case "html":
        return true;
      default:
        return hasElementAttr(id, "contenteditable") && !hasElementAttr(id, "disabled");
    }
  }

  function setTextValue(id: NodeId, v: string): void {
    // Setting the value IDL marks dirty (so defaultValue writes stop
    // tracking it) and resets the caret to end (HTML §4.10.19.3).
    patchControl(id, { value: v, valueDirty: true, selStart: [...v].length, selEnd: [...v].length });
  }

  /**
   * Move focus (UI Events §5.3.1 event order): blur → focusout on the old
   * element, then focus → focusin on the new. `visible` feeds
   * `:focus-visible` — true for keyboard modality, autofocus, and
   * text-editing controls; false for pointer and programmatic `.focus()`.
   */
  function setFocused(id: NodeId | null, visible: boolean): void {
    if (id === focusedId) {
      if (id !== null && visible !== focusVisibleNow) {
        focusVisibleNow = visible;
        session.setUiState({ focusVisible: visible });
      }
      return;
    }
    const oldId = focusedId;
    if (oldId !== null && session.dom.nodes.has(oldId)) {
      const rel = id !== null && session.dom.nodes.has(id) ? makeElementCached(id) : null;
      dispatch(oldId, platformEvent("blur", { bubbles: false, cancelable: false, relatedTarget: rel }));
      dispatch(oldId, platformEvent("focusout", { bubbles: true, cancelable: false, relatedTarget: rel }));
    }
    focusedId = id;
    focusVisibleNow = id !== null && visible;
    session.setUiState(id !== null
      ? { focus: id, focusVisible: focusVisibleNow }
      : { focus: undefined, focusVisible: false });
    if (id !== null) {
      const rel = oldId !== null && session.dom.nodes.has(oldId) ? makeElementCached(oldId) : null;
      dispatch(id, platformEvent("focus", { bubbles: false, cancelable: false, relatedTarget: rel }));
      dispatch(id, platformEvent("focusin", { bubbles: true, cancelable: false, relatedTarget: rel }));
    }
  }

  /** Focus may move during a mousedown's default action (UI Events §5.2.2.1).
   * `preventDefault()` on mousedown suppresses it — browsers key off that. */
  function focusFromPointer(targetId: NodeId): void {
    let cur: NodeId | null = targetId;
    while (cur !== null) {
      if (isFocusable(cur)) {
        const isEditable = isTextEditingControl(cur);
        setFocused(cur, isEditable);
        return;
      }
      cur = session.dom.nodes.get(cur)?.parent ?? null;
    }
    // Chrome moves focus to nothing when a mousedown lands on unfocusable
    // content — a plain-div click blurs the old field.
    setFocused(null, false);
  }

  /** Insert `text` into the focused editable control via the input-event
   * pipeline (beforeinput cancelable → mutate → input). Returns false when
   * the element can't take text. */
  function insertText(id: NodeId, text: string): boolean {
    const node = session.dom.nodes.get(id);
    if (node === undefined) return false;
    if (!isTextEditingControl(id) || hasElementAttr(id, "disabled") || hasElementAttr(id, "readonly")) {
      return false;
    }
    const before = platformEvent("beforeinput", {
      bubbles: true, cancelable: true, data: text, inputType: "insertText",
    });
    if (!dispatch(id, before)) return true;
    setTextValue(id, controlValue(id) + text);
    markTouched(id);
    mutations += 1;
    dispatch(id, platformEvent("input", { bubbles: true, cancelable: false, data: text, inputType: "insertText" }));
    return true;
  }

  function deleteBackwards(id: NodeId): boolean {
    if (!isTextEditingControl(id) || hasElementAttr(id, "disabled") || hasElementAttr(id, "readonly")) {
      return false;
    }
    const before = platformEvent("beforeinput", {
      bubbles: true, cancelable: true, data: null, inputType: "deleteContentBackward",
    });
    if (!dispatch(id, before)) return true;
    const v = controlValue(id);
    if (v.length > 0) {
      setTextValue(id, v.slice(0, -1));
      mutations += 1;
    }
    // A delete attempt on an empty field still counts as interaction for
    // :user-invalid — the user did try to edit.
    markTouched(id);
    dispatch(id, platformEvent("input", { bubbles: true, cancelable: false, data: null, inputType: "deleteContentBackward" }));
    return true;
  }

  // -----------------------------------------------------------------------
  // UI input sequences (UI Events §5) — the host's event-synthesis surface.
  // -----------------------------------------------------------------------

  type PointerInit = {
    button?: number; buttons?: number;
    clientX?: number; clientY?: number; screenX?: number; screenY?: number;
    ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean;
    pointerId?: number; pointerType?: string; isPrimary?: boolean;
  };

  const pointerInit = (raw: Record<string, unknown> | undefined, button: number, buttons: number): Record<string, unknown> => {
    const i = raw as PointerInit | undefined;
    return {
    bubbles: true, cancelable: true, composed: true,
    pointerId: i?.pointerId ?? 1,
    pointerType: i?.pointerType ?? "mouse",
    isPrimary: i?.isPrimary ?? true,
    width: 1, height: 1,
    pressure: buttons !== 0 ? 0.5 : 0,
    button, buttons,
    clientX: i?.clientX ?? 0, clientY: i?.clientY ?? 0,
    screenX: i?.screenX ?? i?.clientX ?? 0, screenY: i?.screenY ?? i?.clientY ?? 0,
    ctrlKey: i?.ctrlKey === true, shiftKey: i?.shiftKey === true,
    altKey: i?.altKey === true, metaKey: i?.metaKey === true,
    };
  };

  /**
   * Boundary-crossing sequence for a family ("pointer" | "mouse"), in UA
   * order: `<name>over/out` bubbles at the target, then `<name>enter/leave`
   * (non-bubbling) fires on every path node — enter top-down, leave
   * bottom-up (UI Events §5.3.3, Pointer Events §10).
   */
  function fireCrossing(targetId: NodeId, enter: boolean, family: "pointer" | "mouse",
                        init: Record<string, unknown>): void {
    dispatch(targetId, platformEvent(
      family + (enter ? "over" : "out"), init));
    const path = shadowPath(targetId);
    const order = enter ? [...path].reverse() : path;
    for (const node of order) {
      if (session.dom.nodes.get(node)?.kind !== "element" && node !== session.dom.root) continue;
      dispatch(node, platformEvent(
        family + (enter ? "enter" : "leave"),
        { ...init, bubbles: false, cancelable: false }));
    }
  }

  function setHover(id: NodeId | null): void {
    hoverId = id;
    session.setUiState({ hover: id ?? undefined });
  }

  function setActive(id: NodeId | null): void {
    activeId = id;
    session.setUiState({ active: id ?? undefined });
  }

  function uiPointerMove(targetId: NodeId, init?: Record<string, unknown>): void {
    const pi = pointerInit(init, -1, 0);
    if (hoverId !== targetId) {
      if (hoverId !== null) {
        fireCrossing(hoverId, false, "pointer", pi);
        fireCrossing(hoverId, false, "mouse", pi);
      }
      fireCrossing(targetId, true, "pointer", pi);
      fireCrossing(targetId, true, "mouse", pi);
      setHover(targetId);
    }
    dispatch(targetId, platformEvent("pointermove", pi));
    dispatch(targetId, platformEvent("mousemove", pi));
  }

  /** A full primary/secondary button click sequence ending in click or
   * auxclick. Right-button context menus ride {@link uiContextMenu}. */
  function uiClick(targetId: NodeId, init?: Record<string, unknown>): void {
    const button = typeof init?.["button"] === "number" ? init["button"] : 0;
    const downInit = pointerInit(init, button, 1 << button);
    const upInit = pointerInit(init, button, 0);
    if (hoverId !== targetId) {
      // A pointer arriving already over the element fires the crossing chain
      // once before the press — movement events carry button=-1/buttons=0.
      const moveInit = pointerInit(init, -1, 0);
      if (hoverId !== null) {
        fireCrossing(hoverId, false, "pointer", moveInit);
        fireCrossing(hoverId, false, "mouse", moveInit);
      }
      fireCrossing(targetId, true, "pointer", moveInit);
      fireCrossing(targetId, true, "mouse", moveInit);
      setHover(targetId);
    }
    let allowed = dispatch(targetId, platformEvent("pointerdown", downInit));
    allowed = dispatch(targetId, platformEvent("mousedown", downInit)) && allowed;
    if (allowed) focusFromPointer(targetId);
    setActive(targetId);
    dispatch(targetId, platformEvent("pointerup", upInit));
    dispatch(targetId, platformEvent("mouseup", upInit));
    setActive(null);
    if (button === 0) {
      const clickAllowed = dispatch(targetId, platformEvent("click", upInit));
      if (clickAllowed) runActivationBehavior(targetId);
    } else {
      dispatch(targetId, platformEvent("auxclick", upInit));
    }
  }

  function uiContextMenu(targetId: NodeId, init?: Record<string, unknown>): void {
    const down = pointerInit(init, 2, 2);
    const up = pointerInit(init, 2, 0);
    dispatch(targetId, platformEvent("pointerdown", down));
    let allowed = dispatch(targetId, platformEvent("mousedown", down));
    if (allowed) focusFromPointer(targetId);
    setActive(targetId);
    // UI Events §5.4.4: contextmenu dispatches after mousedown, before
    // pointerup on right-button presses (Windows convention).
    allowed = dispatch(targetId, platformEvent("contextmenu", up)) && allowed;
    dispatch(targetId, platformEvent("pointerup", up));
    dispatch(targetId, platformEvent("mouseup", up));
    setActive(null);
  }

  function uiDblClick(targetId: NodeId, init?: Record<string, unknown>): void {
    uiClick(targetId, { ...init, button: 0 });
    uiClick(targetId, { ...init, button: 0 });
    const pi = pointerInit(init, 0, 0);
    dispatch(targetId, platformEvent("dblclick", { ...pi, detail: 2 }));
  }

  /** Key synthesis on the focused element (body when nothing focused):
   * keydown → [keypress for printable] → beforeinput/input value editing →
   * keyup. preventDefault on keydown suppresses the text default action. */
  function uiKey(detail: { key: string; code?: string; repeat?: boolean; location?: number;
                          ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean }): void {
    const targetId = focusedId ?? session.dom.root;
    const init: Record<string, unknown> = {
      bubbles: true, cancelable: true, composed: true,
      key: detail.key, code: detail.code ?? "", repeat: detail.repeat === true,
      location: detail.location ?? 0,
      ctrlKey: detail.ctrlKey === true, shiftKey: detail.shiftKey === true,
      altKey: detail.altKey === true, metaKey: detail.metaKey === true,
      charCode: detail.key.length === 1 ? detail.key.charCodeAt(0) : 0,
      keyCode: detail.key.length === 1 ? detail.key.toUpperCase().charCodeAt(0) : 0,
    };
    const allowed = dispatch(targetId, platformEvent("keydown", init));
    if (allowed) {
      if (detail.key.length === 1) {
        dispatch(targetId, platformEvent("keypress", init));
        if (isTextEditingControl(targetId)) insertText(targetId, detail.key);
      } else if (detail.key === "Backspace") {
        if (isTextEditingControl(targetId)) deleteBackwards(targetId);
      } else if (detail.key === "Tab") {
        uiTab(detail.shiftKey === true ? -1 : 1);
      }
    }
    dispatch(targetId, platformEvent("keyup", init));
  }

  /** Focus traversal: Tab order = positive tabindex (sorted) then natural
   * order of the remaining focusable set, flattened-tree preorder. */
  function uiTab(dir: 1 | -1): void {
    const candidates: NodeId[] = [];
    forEachElementPreorder(session.dom.root, (id) => {
      const tag = session.dom.nodes.get(id)?.tag;
      if (tag !== "body" && tag !== "html" && isFocusable(id)) candidates.push(id);
    });
    if (candidates.length === 0) { setFocused(null, false); return; }
    const ranked = (id: NodeId): { group: 0 | 1; order: number } => {
      const ti = Number(elementAttr(id, "tabindex") ?? "0");
      return ti > 0 && !Number.isNaN(ti) ? { group: 0, order: ti } : { group: 1, order: 0 };
    };
    const sorted = [...candidates].sort((a, b) => {
      const ra = ranked(a), rb = ranked(b);
      if (ra.group !== rb.group) return ra.group - rb.group;
      if (ra.order !== rb.order) return ra.order - rb.order;
      return 0; // stable sort keeps document order within a group
    });
    const idx = focusedId === null ? -1 : sorted.indexOf(focusedId);
    let next: NodeId | null;
    if (idx === -1) next = dir === 1 ? sorted[0]! : sorted[sorted.length - 1]!;
    else {
      const n = sorted[idx + dir];
      next = n === undefined ? (dir === 1 ? sorted[0]! : sorted[sorted.length - 1]!) : n;
    }
    // Keyboard modality → :focus-visible applies.
    setFocused(next, true);
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
  /** Set while a custom element's constructor runs: `super()` (extends
   * HTMLElement) must yield the wrapper being upgraded instead of throwing. */
  let pendingCeUpgrade: object | null = null;
  function HTMLElementCtor(this: unknown): object {
    // Custom Elements §"upgrade": constructing the element returns the
    // platform-created wrapper; only reachable while pendingCeUpgrade is set.
    if (pendingCeUpgrade !== null) return pendingCeUpgrade;
    throw new Error("Illegal constructor");
  }
  Object.setPrototypeOf(HTMLElementCtor.prototype as object, ElementCtor.prototype as object);
  // AriaMixin string reflection (ARIA in HTML). Each IDL attribute reflects a
  // content attribute and therefore queues a custom element attribute reaction.
  const ariaStringReflect: ReadonlyArray<readonly [string, string]> = [
    ["ariaAtomic", "aria-atomic"],
    ["ariaAutoComplete", "aria-autocomplete"],
    ["ariaBrailleLabel", "aria-braillelabel"],
    ["ariaBrailleRoleDescription", "aria-brailleroledescription"],
    ["ariaBusy", "aria-busy"],
    ["ariaChecked", "aria-checked"],
    ["ariaColCount", "aria-colcount"],
    ["ariaColIndex", "aria-colindex"],
    ["ariaColSpan", "aria-colspan"],
    ["ariaCurrent", "aria-current"],
    ["ariaDisabled", "aria-disabled"],
    ["ariaExpanded", "aria-expanded"],
    ["ariaHasPopup", "aria-haspopup"],
    ["ariaHidden", "aria-hidden"],
    ["ariaInvalid", "aria-invalid"],
    ["ariaKeyShortcuts", "aria-keyshortcuts"],
    ["ariaLabel", "aria-label"],
    ["ariaLevel", "aria-level"],
    ["ariaLive", "aria-live"],
    ["ariaModal", "aria-modal"],
    ["ariaMultiLine", "aria-multiline"],
    ["ariaMultiSelectable", "aria-multiselectable"],
    ["ariaOrientation", "aria-orientation"],
    ["ariaPlaceholder", "aria-placeholder"],
    ["ariaPosInSet", "aria-posinset"],
    ["ariaPressed", "aria-pressed"],
    ["ariaReadOnly", "aria-readonly"],
    ["ariaRelevant", "aria-relevant"],
    ["ariaRequired", "aria-required"],
    ["ariaRoleDescription", "aria-roledescription"],
    ["ariaRowCount", "aria-rowcount"],
    ["ariaRowIndex", "aria-rowindex"],
    ["ariaRowSpan", "aria-rowspan"],
    ["ariaSelected", "aria-selected"],
    ["ariaSetSize", "aria-setsize"],
    ["ariaSort", "aria-sort"],
    ["ariaValueMax", "aria-valuemax"],
    ["ariaValueMin", "aria-valuemin"],
    ["ariaValueNow", "aria-valuenow"],
    ["ariaValueText", "aria-valuetext"],
  ];
  for (const [prop, attr] of ariaStringReflect) {
    Object.defineProperty(ElementCtor.prototype, prop, {
      configurable: true,
      enumerable: true,
      get(this: unknown): string | null {
        const id = idFromWrapper(this);
        if (id === undefined) return null;
        return session.dom.nodes.get(id)?.attrs?.get(attr) ?? null;
      },
      set(this: unknown, value: unknown): void {
        const id = idFromWrapper(this);
        if (id === undefined) return;
        if (value === null) session.removeAttribute(id, attr);
        else session.setAttribute(id, attr, textContentString(value));
        mutations += 1;
      },
    });
  }

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
  /** Shadow DOM (RFC 0018): shadow roots are `DocumentFragment` subclasses. */
  function ShadowRootCtor(): never {
    throw new Error("Illegal constructor");
  }
  Object.setPrototypeOf(ShadowRootCtor.prototype as object, DocumentFragmentCtor.prototype as object);

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
    if (gcsMutEpoch !== mutations + session.uiEpoch + session.mediaEpoch) {
      gcsMutEpoch = mutations + session.uiEpoch + session.mediaEpoch;
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
      // Shorthand computed values are the longhands, not the shorthand's own
      // initial string. `flex: none` expands to grow/shrink/basis and must
      // read back as `0 0 auto`.
      if (cssName === "flex") {
        const grow = Math.max(0, Number(fieldString("flexGrow", "number")));
        const shrink = Math.max(0, Number(fieldString("flexShrink", "number")));
        const basis = serializeFlexBasisComputed(fieldString("flexBasis", "LengthOrAuto"));
        const growText = Number.isFinite(grow) ? String(grow) : "0";
        const shrinkText = Number.isFinite(shrink) ? String(shrink) : "1";
        return `${growText} ${shrinkText} ${basis}`;
      }
      if (cssName === "flex-basis") {
        return serializeFlexBasisComputed(fieldString("flexBasis", "LengthOrAuto"));
      }
      if (cssName === "flex-flow") {
        const direction = fieldString("flexDirection", "string");
        const wrap = fieldString("flexWrap", "string");
        return serializeFlexFlow(direction === "" ? "row" : direction, wrap === "" ? "nowrap" : wrap);
      }
      if (cssName === "grid-column" || cssName === "grid-row") {
        const axis = cssName === "grid-column" ? "Column" : "Row";
        return serializeGridPlacement(
          fieldString(`grid${axis}Start`, "string"),
          fieldString(`grid${axis}End`, "string"),
        );
      }
      if (cssName === "grid-area") {
        return serializeGridArea(
          fieldString("gridRowStart", "string"),
          fieldString("gridColumnStart", "string"),
          fieldString("gridRowEnd", "string"),
          fieldString("gridColumnEnd", "string"),
        );
      }
      if (cssName === "grid-template-columns" || cssName === "grid-template-rows") {
        const field = cssName === "grid-template-columns" ? "gridTemplateColumns" : "gridTemplateRows";
        const specified = fieldString(field, "string");
        const display = fieldString("display", "string");
        const axis = cssName === "grid-template-columns" ? "width" : "height";
        const breadth = cssLength(fieldString(axis, "LengthOrAuto"));
        const em = cssLength(fieldString("fontSize", "Px"));
        // A subgrid declaration on a grid container whose parent is not a
        // grid computes to the initial value. The specified value stays put.
        // This does not depend on a definite size: an auto-width grid still
        // has to drop the subgrid.
        if (/^subgrid\b/i.test(specified.trim()) && (display === "grid" || display === "inline-grid") && id !== undefined) {
          const node = session.dom.nodes.get(id);
          const parentId = node?.parent ?? null;
          const parent = parentId === null ? undefined : session.dom.nodes.get(parentId);
          const parentComputed = parentId !== null && parent?.kind === "element"
            ? (session.computed(parentId) as { display?: unknown }).display
            : undefined;
          const parentDisplay = typeof parentComputed === "string" ? parentComputed : "";
          if (parentDisplay !== "grid" && parentDisplay !== "inline-grid") return "none";
          return specified.trim();
        }
        if ((display === "grid" || display === "inline-grid") && id !== undefined && breadth !== null && em !== null && breadth > 0) {
          const node = session.dom.nodes.get(id);
          const kids = (node?.children ?? []).filter((childId) => session.dom.nodes.get(childId)?.kind === "element");
          let content = 0;
          const first = kids[0];
          let leadingImplicit = false;
          if (first !== undefined) {
            const childStyle = session.computed(first) as Record<string, unknown>;
            const childSize = childStyle[axis];
            if (typeof childSize === "number" && childSize > 0) content = childSize;
            // `auto / 1` ends on the first explicit line, so the item sits in one
            // leading implicit track and does not occupy the explicit list.
            const startKey = axis === "width" ? "gridColumnStart" : "gridRowStart";
            const endKey = axis === "width" ? "gridColumnEnd" : "gridRowEnd";
            const start = childStyle[startKey];
            const end = childStyle[endKey];
            leadingImplicit = (start === "auto" || start === "") && typeof end === "string" && Number(end) === 1;
          }
          const px = (n: number): string => `${Math.round(Math.max(0, n) * 1000) / 1000}px`;
          if (specified.trim().toLowerCase() === "none") {
            if (kids.length === 0) return "none";
            // One implicit auto track. It stretches to the container, and it
            // does not shrink below the item's contribution.
            return px(Math.max(content, breadth));
          }
          // Layout's unset template is the sentinel "0", not an author length of 0px.
          if (specified.trim() === "0") return specified;
          const resolved = resolveTrackList(specified, {
            breadth,
            em,
            items: leadingImplicit ? 0 : kids.length,
            content: leadingImplicit ? 0 : content,
          });
          if (resolved === null) return specified;
          if (!leadingImplicit) return resolved;
          const explicitSum = [...resolved.matchAll(/(\d+(?:\.\d+)?)px/g)].reduce((sum, match) => sum + Number(match[1] ?? 0), 0);
          return `${px(Math.max(content, breadth - explicitSum))} ${resolved}`;
        }
        return specified;
      }
      if (cssName === "grid-template" || cssName === "grid") {
        const rows = fieldString("gridTemplateRows", "string");
        const columns = fieldString("gridTemplateColumns", "string");
        const areas = fieldString("gridTemplateAreas", "string");
        // Unset templates stay at the layout initial "0", not an author `none`.
        if (cssName === "grid-template") {
          if (rows === "0" && columns === "0" && (areas === "none" || areas === "")) return "none";
          return serializeGridTemplate(rows, columns, areas);
        }
        const autoRows = fieldString("gridAutoRows", "string");
        const autoColumns = fieldString("gridAutoColumns", "string");
        const flow = fieldString("gridAutoFlow", "string");
        if (rows === "0" && columns === "0" && (areas === "none" || areas === "") && autoRows === "auto" && autoColumns === "auto" && flow === "row") {
          return "none";
        }
        return serializeGrid(rows, columns, areas, autoRows, autoColumns, flow);
      }
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
    get children(): object {
      return makeLiveCollection(() =>
        (session.dom.nodes.get(session.dom.root)?.children ?? []).filter(
          (childId) => session.dom.nodes.get(childId)?.kind === "element",
        ),
      );
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
    get currentScript(): object | null {
      const id = options.currentScriptBox?.current ?? null;
      return id !== null ? makeElementCached(id) : null;
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
    /** HTML §6.5.2: the focused element, falling back to <body>/<html>. */
    get activeElement(): object | null {
      if (focusedId !== null && session.dom.nodes.has(focusedId)) return makeElementCached(focusedId);
      const body = elementIdsByTagName(session.dom.root, "body")[0];
      return body !== undefined ? makeElementCached(body) : null;
    },
    hasFocus(): boolean {
      // Single-document harness: the document always owns the focus ring.
      return true;
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
    createElement(tag: unknown, opts?: unknown): object {
      const id = session.createElement(String(tag));
      mutations += 1;
      // Custom Elements §4.5.1: `{ is: "x-foo" }` marks a customized built-in —
      // the `is` attribute lands before the upgrade check resolves it.
      const is = (opts as Record<string, unknown> | undefined)?.["is"];
      if (typeof is === "string") session.setAttribute(id, "is", is);
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
      if (kind === "PointerEvent") return new PointerEvent("");
      if (kind === "KeyboardEvent") return new KeyboardEvent("");
      if (kind === "FocusEvent") return new FocusEvent("");
      if (kind === "InputEvent") return new InputEvent("");
      if (kind === "WheelEvent") return new WheelEvent("");
      if (kind === "CompositionEvent") return new CompositionEvent("");
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
  // RFC 0035: HTMLMediaElement — the common <video>/<audio> base interface.
  const HTMLMediaElementCtor = function HTMLMediaElement() {} as unknown as new () => object;
  Object.setPrototypeOf(HTMLMediaElementCtor.prototype as object, HTMLElementCtor.prototype as object);
  // WebIDL interface constants live on the constructor too (instances get
  // the same names from mediaDescriptors' own-property `consts`).
  Object.defineProperties(HTMLMediaElementCtor, {
    NETWORK_EMPTY: { value: 0 }, NETWORK_IDLE: { value: 1 },
    NETWORK_LOADING: { value: 2 }, NETWORK_NO_SOURCE: { value: 3 },
    HAVE_NOTHING: { value: 0 }, HAVE_METADATA: { value: 1 },
    HAVE_CURRENT_DATA: { value: 2 }, HAVE_FUTURE_DATA: { value: 3 },
    HAVE_ENOUGH_DATA: { value: 4 },
  });

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
    const ctor = function (this: unknown, _w?: unknown, _h?: unknown): object {
      // Customized built-ins extend these interfaces — `super()` must yield
      // the wrapper being upgraded, exactly like HTMLElement does.
      if (pendingCeUpgrade !== null) return pendingCeUpgrade;
      throw new Error("Illegal constructor");
    } as unknown as new () => object;
    Object.setPrototypeOf(
      ctor.prototype as object,
      name === "HTMLAudioElement" || name === "HTMLVideoElement"
        ? (HTMLMediaElementCtor.prototype as object)
        : (HTMLElementCtor.prototype as object),
    );
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
  const OffscreenCanvasCtor = function OffscreenCanvas(this: object, w?: unknown, h?: unknown) {
    let bw = Math.max(0, Math.floor(Number(w) || 0));
    let bh = Math.max(0, Math.floor(Number(h) || 0));
    let cached: object | null = null;
    let engine: Canvas2DEngine | null = null;
    let glCore: WebGLCore | null = null;
    const ensure = (): Canvas2DEngine => {
      if (engine === null) {
        engine = new Canvas2DEngine(bw, bh);
        canvasObjects.set(this, engine);
      }
      return engine;
    };
    Object.defineProperty(this, "width", {
      enumerable: true,
      get: () => bw,
      // OffscreenCanvas width/height setters resize the bitmap (and reset
      // context state) — same "set bitmap dimensions" algorithm as <canvas>.
      set: (v: unknown) => {
        bw = Math.max(0, Math.floor(Number(v) || 0));
        engine?.resize(bw, bh);
      },
    });
    Object.defineProperty(this, "height", {
      enumerable: true,
      get: () => bh,
      set: (v: unknown) => {
        bh = Math.max(0, Math.floor(Number(v) || 0));
        engine?.resize(bw, bh);
      },
    });
    Object.defineProperty(this, "getContext", {
      enumerable: true,
      value: (type: unknown, opts?: unknown): object | null => {
        const kind = coerceGuestString(type).toLowerCase();
        if (kind === "webgl" || kind === "experimental-webgl") {
          if (cached === null && engine === null) {
            if (glCore === null) glCore = new WebGLCore(bw, bh);
            cached = makeWebGLContext(glCore, this, {
              imageSource: (source) => {
                const id = idOf.get(source as object);
                if (id !== undefined) return options.canvasImageSource?.(id);
                const off = typeof source === "object" && source !== null
                  ? canvasObjects.get(source) : undefined;
                return off?.rasterize();
              },
            });
          }
          return cached;
        }
        if (kind !== "2d") return null;
        if (cached === null) {
          const eng = ensure();
          cached = canvas2dApi(eng, {
            canvasRef: () => this,
            resolveImage: (source) => {
              const id = idOf.get(source as object);
              return id === undefined ? undefined : options.canvasImageSource?.(id);
            },
            resolveCanvas: (source) =>
              typeof source === "object" && source !== null ? canvasObjects.get(source) : undefined,
          });
        }
        void opts;
        return cached;
      },
    });
  } as unknown as new (w?: unknown, h?: unknown) => object;
  // RFC 0036: `WebGLRenderingContext` — interface object (non-constructible
  // per WebIDL); ctx objects carry its prototype so `instanceof` works.
  const WebGLRenderingContextCtor = function WebGLRenderingContext(): object {
    throw new TypeError("Illegal constructor");
  } as unknown as new () => object;
  WebGLRenderingContextCtor.prototype = WebGLRenderingContextProto;
  // -------------------------------------------------------------------------
  // Observers (DOM §"mutation observers"; IntersectionObserver; ResizeObserver)
  //
  // MutationObserver rides the session's synchronous mutation sink and batches
  // records into ONE compound microtask per notification round (DOM §"queue a
  // mutation observer compound microtask"). ResizeObserver/IntersectionObserver
  // are RENDERING-STEP observers: they evaluate against the FragmentTree at
  // frame boundaries (tickAnimations) and on a scheduled microtask after
  // observe()/mutations — never synchronously inside a DOM write.
  // -------------------------------------------------------------------------

  const enqueueMicrotask =
    options.queueMicrotask ?? ((fn: () => void) => queueMicrotask(fn));

  /** `isAncestor` over the live DOM parent chain — for MO subtree matching;
   * stops at a shadow root (document observers never see shadow mutations). */
  const isAncestorOf = (ancestor: NodeId, node: NodeId): boolean => {
    let cur = session.dom.nodes.get(node)?.parent ?? null;
    while (cur !== null) {
      if (cur === ancestor) return true;
      const n = session.dom.nodes.get(cur);
      cur = n === undefined || n.tag === "#shadow-root" ? null : (n.parent ?? null);
    }
    return false;
  };

  interface RectObj {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly top: number;
    readonly left: number;
    readonly right: number;
    readonly bottom: number;
    toJSON(): object;
  }
  const rectObj = (x: number, y: number, w: number, h: number): RectObj => {
    const r: RectObj = {
      x, y, width: w, height: h,
      top: y, left: x, right: x + w, bottom: y + h,
      toJSON() {
        return { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, left: r.left, right: r.right, bottom: r.bottom };
      },
    };
    return r;
  };

  /** node → layout fragment index built once per geometry evaluation pass. */
  type FragmentIndex = Map<NodeId, Fragment>;

  /**
   * Document-space border-box rect. The fragment tree expresses each node's
   * rects in its PARENT's coordinate space (the point where the parent placed
   * this fragment's margin box — `offsetFragment` semantics). Escaping one
   * level means adding the ancestor's margin-box origin as expressed in the
   * NEXT space up — so the document position is the node's own borderBox plus
   * each ancestor's `marginBox` origin. All reads stay inside the FragmentTree,
   * the single legal geometry source.
   */
  const documentRectOf = (fragByNode: FragmentIndex, nodeId: NodeId): RectObj | null => {
    const frag = fragByNode.get(nodeId);
    if (frag === undefined) return null; // display:none / not laid out.
    let x = Number(frag.box.borderBox.x);
    let y = Number(frag.box.borderBox.y);
    let cur = session.dom.nodes.get(nodeId)?.parent ?? null;
    while (cur !== null) {
      const ancestor = fragByNode.get(cur);
      if (ancestor !== undefined) {
        x += Number(ancestor.box.marginBox.x);
        y += Number(ancestor.box.marginBox.y);
      }
      cur = session.dom.nodes.get(cur)?.parent ?? null;
    }
    return rectObj(x, y, Number(frag.box.borderBox.width), Number(frag.box.borderBox.height));
  };

  // -- MutationObserver -------------------------------------------------------

  interface MutationInit {
    readonly childList: boolean;
    readonly attributes: boolean;
    readonly characterData: boolean;
    readonly subtree: boolean;
    readonly attributeOldValue: boolean;
    readonly characterDataOldValue: boolean;
    readonly attributeFilter: readonly string[] | null;
  }
  interface MutationRecordObj {
    readonly type: string;
    readonly target: object | null;
    readonly addedNodes: object;
    readonly removedNodes: object;
    readonly previousSibling: object | null;
    readonly nextSibling: object | null;
    readonly attributeName: string | null;
    readonly attributeNamespace: null;
    readonly oldValue: string | null;
  }
  interface MutationObserverIface {
    observe(target: unknown, init?: unknown): void;
    disconnect(): void;
    takeRecords(): MutationRecordObj[];
  }
  const mutationObservers = new Set<{
    readonly regs: Map<NodeId, MutationInit>;
    queue: MutationRecordObj[];
    readonly cb: (records: MutationRecordObj[], obs: unknown) => void;
  }>();
  let mutationMicrotaskQueued = false;

  const staticNodeList = (ids: readonly NodeId[]): object => {
    const snapshot = [...ids];
    return makeNodeList(() => snapshot);
  };
  const wrapOrNull = (id: NodeId | null): object | null =>
    id === null ? null : makeElementCached(id);

  const routeMutation = (m: DomMutation): void => {
    let queued = false;
    for (const obs of mutationObservers) {
      for (const [targetId, init] of obs.regs) {
        if (m.target !== targetId && !(init.subtree && isAncestorOf(targetId, m.target))) continue;
        if (m.kind === "childList" && !init.childList) continue;
        if (m.kind === "attributes") {
          if (!init.attributes) continue;
          if (init.attributeFilter !== null && m.attributeName !== null && !init.attributeFilter.includes(m.attributeName)) continue;
        }
        if (m.kind === "characterData" && !init.characterData) continue;
        const wantOld =
          (m.kind === "attributes" && init.attributeOldValue) ||
          (m.kind === "characterData" && init.characterDataOldValue);
        obs.queue.push({
          type: m.kind,
          target: wrapOrNull(m.target),
          addedNodes: staticNodeList(m.addedNodes),
          removedNodes: staticNodeList(m.removedNodes),
          previousSibling: wrapOrNull(m.previousSibling),
          nextSibling: wrapOrNull(m.nextSibling),
          attributeName: m.attributeName,
          attributeNamespace: null,
          oldValue: wantOld ? m.oldValue : null,
        });
        queued = true;
        break; // DOM: at most one record per observer per mutation.
      }
    }
    if (queued && !mutationMicrotaskQueued) {
      mutationMicrotaskQueued = true;
      enqueueMicrotask(() => {
        mutationMicrotaskQueued = false;
        for (const obs of [...mutationObservers]) {
          if (obs.queue.length === 0) continue;
          const records = obs.queue;
          obs.queue = [];
          try {
            obs.cb(records, obs);
          } catch (error) {
            options.onListenerError?.(error);
          }
        }
      });
    }
    // Geometry observers re-evaluate after DOM writes (layout may have moved).
    if (geometryObservers.size > 0) scheduleGeometryCheck();
  };
  session.onMutation(routeMutation);

  class MutationObserverImpl implements MutationObserverIface {
    readonly regs = new Map<NodeId, MutationInit>();
    queue: MutationRecordObj[] = [];
    readonly cb: (records: MutationRecordObj[], obs: unknown) => void;
    constructor(cb: unknown) {
      if (typeof cb !== "function") {
        throw new TypeError("MutationObserver: callback is not a function");
      }
      this.cb = cb as (records: MutationRecordObj[], obs: unknown) => void;
      mutationObservers.add(this);
    }
    observe(target: unknown, init?: unknown): void {
      const id = idFromWrapper(target);
      if (id === undefined) {
        throw new TypeError("MutationObserver.observe: target is not a Node");
      }
      const o = (init ?? {}) as Record<string, unknown>;
      const normalized: MutationInit = {
        childList: Boolean(o["childList"]),
        // DOM §observe: attributeOldValue/attributeFilter imply attributes;
        // characterDataOldValue implies characterData.
        attributes:
          o["attributes"] !== undefined
            ? Boolean(o["attributes"])
            : Boolean(o["attributeOldValue"]) || o["attributeFilter"] !== undefined,
        characterData:
          o["characterData"] !== undefined
            ? Boolean(o["characterData"])
            : Boolean(o["characterDataOldValue"]),
        subtree: Boolean(o["subtree"]),
        attributeOldValue: Boolean(o["attributeOldValue"]),
        characterDataOldValue: Boolean(o["characterDataOldValue"]),
        attributeFilter: Array.isArray(o["attributeFilter"])
          ? (o["attributeFilter"] as unknown[]).map(String)
          : null,
      };
      if (!normalized.childList && !normalized.attributes && !normalized.characterData) {
        throw new TypeError(
          "MutationObserver.observe: at least one of childList, attributes, characterData must be true",
        );
      }
      this.regs.set(id, normalized); // re-observing a target replaces its init.
    }
    disconnect(): void {
      this.regs.clear();
      this.queue = [];
    }
    takeRecords(): MutationRecordObj[] {
      const out = this.queue;
      this.queue = [];
      return out;
    }
  }
  const MutationObserverCtor = MutationObserverImpl as unknown as new (
    cb: unknown,
  ) => MutationObserverIface;

  // -- ResizeObserver / IntersectionObserver (rendering-step observers) --------

  const geometryObservers = new Set<object>();
  let geometryCheckPending = false;

  /** Run a geometry pass: one layout resolution shared by all geometry
   * observers, then per-observer entry generation + delivery. */
  const runGeometryCheck = (): void => {
    geometryCheckPending = false;
    if (geometryObservers.size === 0) return;
    const tree = resolveLayoutTree();
    const fragByNode: FragmentIndex = new Map();
    if (tree !== null) {
      for (const f of tree.fragments.values()) {
        if (!fragByNode.has(f.node)) fragByNode.set(f.node, f);
      }
    }
    const now = performance.now();
    for (const obs of [...geometryObservers]) {
      (obs as { eval(fragByNode: FragmentIndex, now: number): void }).eval(fragByNode, now);
    }
    for (const obs of [...geometryObservers]) {
      (obs as { flush(): void }).flush();
    }
  };
  const scheduleGeometryCheck = (): void => {
    if (geometryCheckPending) return;
    geometryCheckPending = true;
    enqueueMicrotask(runGeometryCheck);
  };

  interface ResizeTargetReg {
    lastInline: number;
    lastBlock: number;
    readonly box: "content-box" | "border-box" | "device-pixel-content-box";
  }
  class ResizeObserverImpl {
    readonly #cb: (entries: unknown[], obs: unknown) => void;
    readonly #targets = new Map<NodeId, ResizeTargetReg>();
    #pending: unknown[] = [];
    #flushQueued = false;
    constructor(cb: unknown) {
      if (typeof cb !== "function") {
        throw new TypeError("ResizeObserver: callback is not a function");
      }
      this.#cb = cb as (entries: unknown[], obs: unknown) => void;
    }
    observe(target: unknown, init?: unknown): void {
      const id = idFromWrapper(target);
      if (id === undefined) {
        throw new TypeError("ResizeObserver.observe: target is not an Element");
      }
      const box = (init as Record<string, unknown> | undefined)?.["box"];
      this.#targets.set(id, {
        box:
          box === "border-box" || box === "device-pixel-content-box"
            ? box
            : "content-box",
        lastInline: -1, // sentinel: first evaluation always delivers (spec initial delivery).
        lastBlock: -1,
      });
      geometryObservers.add(this);
      scheduleGeometryCheck();
    }
    unobserve(target: unknown): void {
      const id = idFromWrapper(target);
      if (id !== undefined) this.#targets.delete(id);
      if (this.#targets.size === 0) geometryObservers.delete(this);
    }
    disconnect(): void {
      this.#targets.clear();
      this.#pending = [];
      geometryObservers.delete(this);
    }
    takeRecords(): unknown[] {
      const out = this.#pending;
      this.#pending = [];
      return out;
    }
    eval(fragByNode: FragmentIndex, now: number): void {
      for (const [id, reg] of this.#targets) {
        const frag = fragByNode.get(id);
        const box = reg.box === "content-box" ? frag?.box.contentBox : frag?.box.borderBox;
        const w = Number(box?.width ?? 0);
        const h = Number(box?.height ?? 0);
        if (w === reg.lastInline && h === reg.lastBlock) continue;
        reg.lastInline = w;
        reg.lastBlock = h;
        const content = frag?.box.contentBox;
        this.#pending.push({
          target: wrapOrNull(id),
          contentRect: rectObj(
            Number(content?.x ?? 0),
            Number(content?.y ?? 0),
            Number(content?.width ?? 0),
            Number(content?.height ?? 0),
          ),
          borderBoxSize: [{ inlineSize: Number(frag?.box.borderBox.width ?? 0), blockSize: Number(frag?.box.borderBox.height ?? 0) }],
          contentBoxSize: [{ inlineSize: Number(content?.width ?? 0), blockSize: Number(content?.height ?? 0) }],
          devicePixelContentBoxSize: [{ inlineSize: Math.round(Number(content?.width ?? 0)), blockSize: Math.round(Number(content?.height ?? 0)) }],
          time: now,
        });
      }
    }
    flush(): void {
      if (this.#pending.length === 0 || this.#flushQueued) return;
      this.#flushQueued = true;
      enqueueMicrotask(() => {
        this.#flushQueued = false;
        const entries = this.#pending;
        this.#pending = [];
        if (entries.length === 0) return;
        try {
          this.#cb(entries, this);
        } catch (error) {
          options.onListenerError?.(error);
        }
      });
    }
  }
  const ResizeObserverCtor = ResizeObserverImpl as unknown as new (
    cb: unknown,
  ) => object;

  class IntersectionObserverImpl {
    readonly #cb: (entries: unknown[], obs: unknown) => void;
    readonly root: object | null;
    readonly #rootId: NodeId | null;
    readonly #rootMargin: { top: number; right: number; bottom: number; left: number };
    readonly #rootMarginPct: { top: boolean; right: boolean; bottom: boolean; left: boolean };
    readonly thresholds: readonly number[];
    readonly #targets = new Map<NodeId, { prevIndex: number; prevIntersecting: boolean }>();
    #pending: unknown[] = [];
    #flushQueued = false;
    constructor(cb: unknown, init?: unknown) {
      if (typeof cb !== "function") {
        throw new TypeError("IntersectionObserver: callback is not a function");
      }
      this.#cb = cb as (entries: unknown[], obs: unknown) => void;
      const o = (init ?? {}) as Record<string, unknown>;
      const rootRaw = o["root"];
      let rootId: NodeId | null = null;
      if (rootRaw !== undefined && rootRaw !== null) {
        const resolved = idFromWrapper(rootRaw);
        if (resolved === undefined) {
          throw new TypeError("IntersectionObserver: root must be an Element or Document");
        }
        rootId = resolved;
      }
      this.#rootId = rootId;
      this.root = rootId === null ? null : wrapOrNull(rootId);
      const marginRaw = typeof o["rootMargin"] === "string" ? o["rootMargin"] : "0px";
      const parts = marginRaw.trim().split(/\s+/).filter((s) => s.length > 0);
      const vals = (parts.length > 0 ? parts : ["0px"]).map((p) => {
        const m = /^(-?\d+(?:\.\d+)?)(px|%)?$/.exec(p);
        return m === null ? { n: 0, pct: false } : { n: Number(m[1]), pct: m[2] === "%" };
      });
      const [t, r, b, l] = [vals[0]!, vals[1] ?? vals[0]!, vals[2] ?? vals[0]!, vals[3] ?? vals[1] ?? vals[0]!];
      this.#rootMargin = { top: t.n, right: r.n, bottom: b.n, left: l.n };
      this.#rootMarginPct = { top: t.pct, right: r.pct, bottom: b.pct, left: l.pct };
      const traw = o["threshold"];
      const list = Array.isArray(traw) ? traw : traw === undefined ? [0] : [traw];
      const parsed = list.map((v) => {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 1) {
          throw new RangeError("IntersectionObserver: threshold must be between 0 and 1");
        }
        return n;
      });
      this.thresholds = Object.freeze([...new Set(parsed)].sort((a, b) => a - b));
    }
    get rootMargin(): string {
      return `${this.#rootMargin.top}${this.#rootMarginPct.top ? "%" : "px"} ${this.#rootMargin.right}${this.#rootMarginPct.right ? "%" : "px"} ${this.#rootMargin.bottom}${this.#rootMarginPct.bottom ? "%" : "px"} ${this.#rootMargin.left}${this.#rootMarginPct.left ? "%" : "px"}`;
    }
    observe(target: unknown): void {
      const id = idFromWrapper(target);
      if (id === undefined) {
        throw new TypeError("IntersectionObserver.observe: target is not an Element");
      }
      this.#targets.set(id, { prevIndex: -1, prevIntersecting: false });
      geometryObservers.add(this);
      scheduleGeometryCheck();
    }
    unobserve(target: unknown): void {
      const id = idFromWrapper(target);
      if (id !== undefined) this.#targets.delete(id);
      if (this.#targets.size === 0) geometryObservers.delete(this);
    }
    disconnect(): void {
      this.#targets.clear();
      this.#pending = [];
      geometryObservers.delete(this);
    }
    takeRecords(): unknown[] {
      const out = this.#pending;
      this.#pending = [];
      return out;
    }
    eval(fragByNode: FragmentIndex, now: number): void {
      // Root bounds: viewport (document space, scrolled) or the root element's
      // border box, expanded by rootMargin (percentages resolve against the
      // root rect's own dimension on each axis).
      let rootX = 0;
      let rootY = 0;
      let rootW = 0;
      let rootH = 0;
      if (this.#rootId === null) {
        const v = options.viewport?.() ?? { width: 800, height: 600, scrollY: 0 };
        rootX = 0;
        rootY = v.scrollY;
        rootW = v.width;
        rootH = v.height;
      } else {
        const r = documentRectOf(fragByNode, this.#rootId);
        if (r === null) return; // root not laid out → nothing intersects.
        rootX = r.x;
        rootY = r.y;
        rootW = r.width;
        rootH = r.height;
      }
      const top = this.#rootMargin.top * (this.#rootMarginPct.top ? rootH / 100 : 1);
      const right = this.#rootMargin.right * (this.#rootMarginPct.right ? rootW / 100 : 1);
      const bottom = this.#rootMargin.bottom * (this.#rootMarginPct.bottom ? rootH / 100 : 1);
      const left = this.#rootMargin.left * (this.#rootMarginPct.left ? rootW / 100 : 1);
      const rootBounds = rectObj(rootX - left, rootY - top, rootW + left + right, rootH + top + bottom);

      for (const [id, state] of this.#targets) {
        const laidOut = fragByNode.has(id);
        const target = documentRectOf(fragByNode, id) ?? rectObj(0, 0, 0, 0);
        const interX = Math.max(target.x, rootBounds.x);
        const interY = Math.max(target.y, rootBounds.y);
        const interW = Math.min(target.right, rootBounds.right) - interX;
        const interH = Math.min(target.bottom, rootBounds.bottom) - interY;
        // Edge-touching counts as intersecting (spec); a non-laid-out node
        // (display:none) has no box to intersect — report not-intersecting.
        const isIntersecting = laidOut && interW >= 0 && interH >= 0;
        const ratio =
          isIntersecting && target.width * target.height > 0
            ? Math.max(0, Math.min(1, (interW * interH) / (target.width * target.height)))
            : 0;
        // Spec: thresholdIndex counts thresholds already passed — for
        // isIntersecting the first index whose threshold > ratio.
        let index = 0;
        if (isIntersecting) {
          index = this.thresholds.length;
          for (let i = 0; i < this.thresholds.length; i += 1) {
            if ((this.thresholds[i] as number) > ratio) {
              index = i;
              break;
            }
          }
        }
        if (index === state.prevIndex && isIntersecting === state.prevIntersecting) continue;
        state.prevIndex = index;
        state.prevIntersecting = isIntersecting;
        this.#pending.push({
          target: wrapOrNull(id),
          time: now,
          rootBounds: this.#rootId === null ? rectObj(rootX, rootY, rootW, rootH) : rootBounds,
          boundingClientRect: target,
          intersectionRect: isIntersecting ? rectObj(interX, interY, Math.max(0, interW), Math.max(0, interH)) : rectObj(0, 0, 0, 0),
          isIntersecting,
          intersectionRatio: ratio,
        });
      }
    }
    flush(): void {
      if (this.#pending.length === 0 || this.#flushQueued) return;
      this.#flushQueued = true;
      enqueueMicrotask(() => {
        this.#flushQueued = false;
        const entries = this.#pending;
        this.#pending = [];
        if (entries.length === 0) return;
        try {
          this.#cb(entries, this);
        } catch (error) {
          options.onListenerError?.(error);
        }
      });
    }
  }
  const IntersectionObserverCtor = IntersectionObserverImpl as unknown as new (
    cb: unknown,
    init?: unknown,
  ) => object;

  /**
   * PerformanceObserver — honest shell: the performance timeline (marks,
   * measures, resource/paint entries) does not exist yet, so this registers
   * observations and never delivers entries rather than fabricating data.
   * `takeRecords` returns an empty list; `supportedEntryTypes` mirrors the
   * platform surface for feature detection.
   */
  class PerformanceObserverImpl {
    static readonly supportedEntryTypes = Object.freeze([
      "element", "event", "largest-contentful-paint", "layout-shift",
      "longtask", "mark", "measure", "navigation", "paint", "resource",
      "visibility-state",
    ]);
    constructor(cb: unknown) {
      if (typeof cb !== "function") {
        throw new TypeError("PerformanceObserver: callback is not a function");
      }
    }
    observe(_options?: unknown): void {}
    disconnect(): void {}
    takeRecords(): unknown[] {
      return [];
    }
  }
  const PerformanceObserverCtor = PerformanceObserverImpl as unknown as new (
    cb: unknown,
  ) => object;
  Object.defineProperty(PerformanceObserverCtor, "supportedEntryTypes", {
    get: () => PerformanceObserverImpl.supportedEntryTypes,
  });

  // -------------------------------------------------------------------------
  // Custom Elements v1 (HTML §4.13)
  //
  // A per-document registry maps local names → { ctor, observedAttributes,
  // extendTag }. Upgrading is lazy and host-driven: `makeElementCached` calls
  // `ceUpgradeIfDefined` once the plain wrapper exists, so EVERY wrapper path
  // (createElement, querySelector, childNodes, innerHTML-driven insertions)
  // upgrades uniformly. `super()` inside a custom-element class returns the
  // wrapper being upgraded via `pendingCeUpgrade`. Lifecycle callbacks are
  // delivered from the session mutation sink — synchronous at the mutation,
  // matching the platform's reaction-stack timing closely enough for page code.
  // -------------------------------------------------------------------------

  interface CeDefinition {
    readonly name: string;
    readonly ctor: new () => object;
    readonly observedAttributes: ReadonlySet<string>;
    /** Customized built-in: the element local name the class extends. */
    readonly extendTag: string | null;
  }
  const ceRegistry = new Map<string, CeDefinition>();
  /** Node ids already through the upgrade reaction (ctor ran). */
  const ceUpgraded = new Set<NodeId>();
  const ceWaiters = new Map<
    string,
    { readonly promise: Promise<unknown>; resolve: (ctor: unknown) => void }
  >();

  /** The CE definition a node resolves to: `is=` for customized built-ins,
   * otherwise a same-named autonomous definition. */
  const ceDefinitionFor = (id: NodeId): CeDefinition | undefined => {
    const node = session.dom.nodes.get(id);
    if (node?.kind !== "element") return undefined;
    const is = node.attrs?.get("is");
    if (is !== undefined) {
      const d = ceRegistry.get(is);
      if (d !== undefined && d.extendTag === node.tag) return d;
    }
    const d = ceRegistry.get(node.tag ?? "");
    return d !== undefined && d.extendTag === null ? d : undefined;
  };

  /** Invoke a CE lifecycle callback on the node's wrapper. */
  const ceInvoke = (id: NodeId, def: CeDefinition, kind: string, args: unknown[]): void => {
    const method = (def.ctor.prototype as Record<string, unknown>)[kind];
    if (typeof method !== "function") return;
    try {
      (method as (...a: unknown[]) => void).apply(makeElementCached(id), args);
    } catch (error) {
      options.onListenerError?.(error);
    }
  };

  /**
   * Upgrade `id` if it is not already upgraded (Custom Elements §"upgrade an
   * element"): run the constructor on the existing wrapper, then enqueue
   * attributeChangedCallback per observed attribute present, then
   * connectedCallback when connected.
   */
  const ceUpgradeIfDefined = (id: NodeId): void => {
    if (ceUpgraded.has(id)) return;
    const def = ceDefinitionFor(id);
    if (def === undefined) return;
    ceUpgraded.add(id);
    const w = makeElementCached(id);
    Object.setPrototypeOf(w, def.ctor.prototype as object);
    const prev = pendingCeUpgrade;
    pendingCeUpgrade = w;
    try {
      Reflect.construct(def.ctor, [], def.ctor);
    } catch (error) {
      options.onListenerError?.(error);
    } finally {
      pendingCeUpgrade = prev;
    }
    const attrs = session.dom.nodes.get(id)?.attrs;
    if (attrs !== undefined) {
      for (const [k, v] of attrs) {
        if (def.observedAttributes.has(k)) {
          ceInvoke(id, def, "attributeChangedCallback", [k, null, v, null]);
        }
      }
    }
    if (isConnectedToDocument(session.dom, id)) ceInvoke(id, def, "connectedCallback", []);
  };

  /** `id` and its element descendants in tree order — INCLUDING shadow trees
   * (a host's shadow children connect/disconnect with it). */
  const forEachElementPreorder = (id: NodeId, fn: (id: NodeId) => void): void => {
    const node = session.dom.nodes.get(id);
    if (node === undefined) return;
    if (node.kind === "element") fn(id);
    if (node.shadow !== undefined) forEachElementPreorder(node.shadow, fn);
    for (const child of node.children) forEachElementPreorder(child, fn);
  };

  /** Every element under `root` matching `tag`, traversing shadow roots too —
   * used by `customElements.define` upgrades (light-DOM queries stay clean). */
  const elementIdsByTagNameDeep = (root: NodeId, want: string): NodeId[] => {
    const out: NodeId[] = [];
    const visit = (id: NodeId): void => {
      const node = session.dom.nodes.get(id);
      if (node === undefined) return;
      if (node.kind === "element" && node.tag === want) out.push(id);
      if (node.shadow !== undefined) visit(node.shadow);
      for (const child of node.children) visit(child);
    };
    for (const child of session.dom.nodes.get(root)?.children ?? []) visit(child);
    return out;
  };

  /**
   * `slotchange` (HTML §4.15): recompute the slot assignment signature for
   * every slot in each affected shadow root and fire a bubbling `slotchange`
   * (per slot, on a microtask) when the assignment actually changed.
   */
  const slotSignatures = new Map<NodeId, string>();
  /** Slots whose change signal is queued but not yet delivered — spec signals
   * ONCE per slot until the event fires, so rapid re-assignment coalesces. */
  const slotPending = new Set<NodeId>();
  const shadowRootAffectedBy = (id: NodeId): NodeId | undefined => {
    const n = session.dom.nodes.get(id);
    if (n === undefined) return undefined;
    if (n.tag === "#shadow-root") return id;          // children of the root itself
    if (n.shadow !== undefined) return n.shadow;       // mutation on the host (light children)
    const sr = enclosingShadowRootId(id);              // node inside a shadow tree
    if (sr !== undefined) return sr;
    const p = n.parent;                                 // `slot=` attr on a light child
    if (p !== null && p !== undefined) {
      const ps = session.dom.nodes.get(p)?.shadow;
      if (ps !== undefined) return ps;
    }
    return undefined;
  };
  const queueSlotChange = (m: DomMutation): void => {
    const roots = new Set<NodeId>();
    for (const id of [m.target, ...m.addedNodes, ...m.removedNodes]) {
      const r = shadowRootAffectedBy(id);
      if (r !== undefined) roots.add(r);
    }
    for (const root of roots) {
      for (const sid of slotsInSubtree(root)) {
        const sig = slotAssignedIds(sid).join(",");
        if (slotSignatures.get(sid) === sig) continue;
        slotSignatures.set(sid, sig);
        if (slotPending.has(sid)) continue;
        slotPending.add(sid);
        const fire = (): void => {
          slotPending.delete(sid);
          dispatch(sid, makeEvent("slotchange", { bubbles: true }));
        };
        if (options.queueMicrotask !== undefined) options.queueMicrotask(fire);
        else fire();
      }
    }
  };

  // -----------------------------------------------------------------------
  // Autofocus (HTML §4.3.11.1): the first inserted element carrying the
  // `autofocus` attribute takes focus when the autofocus queue is flushed —
  // on the next microtask after insertion. Only one autofocus lands per
  // document.
  // -----------------------------------------------------------------------
  let autofocusDone = false;
  const autofocusQueue: NodeId[] = [];
  let autofocusScheduled = false;
  const flushAutofocus = (): void => {
    autofocusScheduled = false;
    if (autofocusDone) return;
    while (autofocusQueue.length > 0) {
      const cand = autofocusQueue.shift();
      if (cand === undefined) break;
      if (!session.dom.nodes.has(cand) || !isFocusable(cand)) continue;
      setFocused(cand, true); // autofocus is a keyboard-like modality
      autofocusDone = true;
      break;
    }
  };
  const queueAutofocus = (id: NodeId): void => {
    if (autofocusDone || autofocusQueue.includes(id)) return;
    autofocusQueue.push(id);
    if (autofocusScheduled) return;
    autofocusScheduled = true;
    if (options.queueMicrotask !== undefined) options.queueMicrotask(flushAutofocus);
    else void Promise.resolve().then(flushAutofocus);
  };

  // Parser-inserted autofocus elements predate the mutation sink — scan the
  // initial tree once (the "parser-end flush" of HTML §4.3.11.1).
  forEachElementPreorder(session.dom.root, (id) => {
    if (elementAttr(id, "autofocus") !== undefined) queueAutofocus(id);
  });

  // Lifecycle dispatch rides the session mutation sink (always active —
  // independent of whether any MutationObserver is registered).
  session.onMutation((m: DomMutation): void => {
    queueSlotChange(m);
    if (m.kind === "childList") {
      for (const removed of m.removedNodes) {
        // A detached focused/hovered/active element silently loses its UI
        // state — no blur events fire on a node outside the document.
        forEachElementPreorder(removed, (id) => {
          if (id === focusedId) {
            focusedId = null;
            focusVisibleNow = false;
            session.setUiState({ focus: undefined, focusVisible: false });
          }
          if (id === hoverId) setHover(null);
          if (id === activeId) setActive(null);
        });
      }
      for (const added of m.addedNodes) {
        if (!isConnectedToDocument(session.dom, added)) continue;
        forEachElementPreorder(added, (id) => {
          if (elementAttr(id, "autofocus") !== undefined) queueAutofocus(id);
          // Option insertion steps: inserting a selected option into a
          // select-one deselects the others (HTML "option insertion steps").
          if (
            session.dom.nodes.get(id)?.tag === "option" &&
            // nodeState first: `opt.selected=true` while detached is live
            // state that never entered the dom control map.
            (nodeState.get(id)?.selected ?? elementAttr(id, "selected") !== undefined)
          ) {
            const sel = ownerSelect(id);
            if (sel !== null && !hasElementAttr(sel, "multiple")) {
              for (const oid of optionIdsOf(sel)) {
                if (oid !== id) patchControl(oid, { selected: false });
              }
            }
          }
        });
      }
    }
    if (ceRegistry.size === 0 && ceUpgraded.size === 0) return;
    if (m.kind === "childList") {
      for (const removed of m.removedNodes) {
        // The removed subtree was connected iff the former parent is still in
        // the document (check NOW, post-removal).
        if (!isConnectedToDocument(session.dom, m.target)) continue;
        forEachElementPreorder(removed, (id) => {
          const def = ceDefinitionFor(id);
          if (def !== undefined && ceUpgraded.has(id)) {
            ceInvoke(id, def, "disconnectedCallback", []);
          }
        });
      }
      for (const added of m.addedNodes) {
        if (!isConnectedToDocument(session.dom, added)) continue;
        forEachElementPreorder(added, (id) => {
          const def = ceDefinitionFor(id);
          if (def === undefined) return;
          const wasUpgraded = ceUpgraded.has(id);
          ceUpgradeIfDefined(id); // ctor + attrChanged + connected for new upgrades
          if (wasUpgraded) ceInvoke(id, def, "connectedCallback", []);
        });
      }
      return;
    }
    if (m.kind === "attributes" && m.attributeName !== null) {
      const def = ceDefinitionFor(m.target);
      if (def === undefined || !ceUpgraded.has(m.target)) return;
      if (!def.observedAttributes.has(m.attributeName)) return;
      const newValue = session.dom.nodes.get(m.target)?.attrs?.get(m.attributeName) ?? null;
      ceInvoke(m.target, def, "attributeChangedCallback", [m.attributeName, m.oldValue, newValue, null]);
    }
  });

  const ceDefine = (name: unknown, ctor: unknown, opts?: unknown): void => {
    const local = coerceGuestString(name);
    if (!isValidCustomElementName(local)) {
      throw new DOMException(`'${local}' is not a valid custom element name`, "SyntaxError");
    }
    if (typeof ctor !== "function") {
      throw new TypeError("customElements.define: constructor must be a function");
    }
    if (ceRegistry.has(local)) {
      throw new DOMException(`custom element '${local}' is already defined`, "NotSupportedError");
    }
    for (const d of ceRegistry.values()) {
      if (d.ctor === ctor) {
        throw new DOMException("this constructor is already used for another custom element", "NotSupportedError");
      }
    }
    const extendTag = (opts as Record<string, unknown> | undefined)?.["extends"];
    const observed = new Set<string>(
      Array.isArray((ctor as { observedAttributes?: unknown }).observedAttributes)
        ? ((ctor as unknown as { observedAttributes: unknown[] }).observedAttributes).map(String)
        : [],
    );
    const def: CeDefinition = {
      name: local,
      ctor: ctor as new () => object,
      observedAttributes: observed,
      extendTag: typeof extendTag === "string" ? extendTag.toLowerCase() : null,
    };
    ceRegistry.set(local, def);
    // Feeds `:defined` matching through the cascade's DomTree input.
    session.defineCustomElement(local);
    // whenDefined waiters resolve with the constructor.
    const waiter = ceWaiters.get(local);
    if (waiter !== undefined) {
      ceWaiters.delete(local);
      waiter.resolve(def.ctor);
    }
    // Upgrade matching elements already in the document, in tree order —
    // upgrade covers ctor, attributeChangedCallback (per observed attr), and
    // connectedCallback (for connected nodes).
    const tags = def.extendTag === null ? [local] : [def.extendTag];
    for (const tag of tags) {
      for (const id of elementIdsByTagNameDeep(session.dom.root, tag)) {
        if (ceDefinitionFor(id) === def) ceUpgradeIfDefined(id);
      }
    }
  };

  const customElementsApi = {
    define: ceDefine,
    get(name: unknown): unknown {
      return ceRegistry.get(coerceGuestString(name))?.ctor;
    },
    whenDefined(name: unknown): Promise<unknown> {
      const local = coerceGuestString(name);
      if (!isValidCustomElementName(local)) {
        return Promise.reject(
          new DOMException(`'${local}' is not a valid custom element name`, "SyntaxError"),
        );
      }
      const existing = ceRegistry.get(local);
      if (existing !== undefined) return Promise.resolve(existing.ctor);
      const pending = ceWaiters.get(local);
      if (pending !== undefined) return pending.promise;
      let resolveFn: (ctor: unknown) => void = () => undefined;
      const promise = new Promise<unknown>((resolve) => {
        resolveFn = resolve;
      });
      ceWaiters.set(local, { promise, resolve: resolveFn });
      return promise;
    },
    upgrade(wrapper: unknown): void {
      const id = idFromWrapper(wrapper);
      if (id !== undefined) ceUpgradeIfDefined(id);
    },
  };


  // RFC 0022: WebSocket api bundle — the class is installed in domGlobals;
  // `bindRealm` is returned so the runner can bind realm ArrayBuffer/TypeError
  // after `vm.createContext` (same post-context pattern as fetch realm errors).
  const wsApi: WebSocketApi = makeWebSocketApi({
    baseUrl: session.url,
    ...(options.wsTransport !== undefined ? { transport: options.wsTransport } : {}),
    queueTask: enqueueMicrotask,
    BlobCtor: makeBlobClass(),
  });
  const domGlobals: Record<string, unknown> = {
    Event: Event,
    CustomEvent: CustomEvent,
    UIEvent: UIEvent,
    MouseEvent: MouseEvent,
    PointerEvent: PointerEvent,
    KeyboardEvent: KeyboardEvent,
    FocusEvent: FocusEvent,
    InputEvent: InputEvent,
    WheelEvent: WheelEvent,
    CompositionEvent: CompositionEvent,
    Node: NodeCtor,
    Element: ElementCtor,
    HTMLElement: HTMLElementCtor,
    MutationObserver: MutationObserverCtor,
    ResizeObserver: ResizeObserverCtor,
    IntersectionObserver: IntersectionObserverCtor,
    PerformanceObserver: PerformanceObserverCtor,
    customElements: customElementsApi,
    ...Object.fromEntries([...htmlInterfaceCtors].map(([name, { ctor }]) => [name, ctor])),
    CanvasRenderingContext2D: CanvasRenderingContext2DCtor,
    OffscreenCanvas: OffscreenCanvasCtor,
    WebGLRenderingContext: WebGLRenderingContextCtor,
    // RFC 0035: media interfaces — HTMLMediaElement is the common base;
    // `new Audio(src)` is the spec's detached-<audio> constructor.
    HTMLMediaElement: HTMLMediaElementCtor,
    Audio: function Audio(this: unknown, src?: unknown): object {
      const el = (document as { createElement(t: string): object }).createElement("audio");
      if (src !== undefined) {
        (el as { src: string }).src = coerceGuestString(src);
      }
      return el;
    },
    // RFC 0033: real Path2D — an owned verb list consumed by fill/stroke/clip.
    Path2D: Path2DImpl,
    // `new Text(data)` — a text node created directly in the live tree.
    Text: function Text(this: unknown, data: unknown) {
      const id = session.createTextNode(coerceGuestString(data));
      mutations += 1;
      return makeElementCached(id);
    },
    NodeList: NodeListCtor,
    SVGElement: SVGElementCtor,
    ShadowRoot: ShadowRootCtor,
    Document: DocumentCtor,
    DocumentFragment: DocumentFragmentCtor,
    MessageEvent: MessageEvent,
    CloseEvent: CloseEvent,
    // RFC 0022: the guest WebSocket class — RFC 6455 handshake + framing run
    // engine-side over the injected raw-socket transport; events ride the
    // document's microtask queue like every other guest-facing delivery.
    WebSocket: wsApi.WebSocket,
    getComputedStyle,
    get scrollX(): number {
      return documentScrollX;
    },
    get scrollY(): number {
      return documentScrollY;
    },
    scrollTo(x?: unknown, y?: unknown): void {
      const next = scrollToArgs(x, y);
      if (next === null) return;
      setDocumentScroll(next.left, next.top);
    },
    scrollBy(x?: unknown, y?: unknown): void {
      if (typeof x === "object" && x !== null) {
        const o = x as { left?: unknown; top?: unknown };
        setDocumentScroll(documentScrollX + axisLength(o.left), documentScrollY + axisLength(o.top));
        return;
      }
      setDocumentScroll(documentScrollX + axisLength(x), documentScrollY + axisLength(y));
    },
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
  // RFC 0035: bind the media engine to THIS api's dispatch + clock — one
  // engine per document shared by the classic and module runs (second binder
  // wins harmlessly: same session, same dispatch semantics).
  if (options.media !== undefined) {
    const clock = options.mediaClock ?? nodeMediaClock();
    options.media.bindRuntime({
      emit: (id: NodeId, type: string): void => {
        dispatch(id, platformEvent(type, {}));
      },
      clock,
    });
  }
  return {
    document,
    globals: domGlobals,
    mutations: () => mutations,
    tickAnimations,
    hasActiveAnimations,
    fireDocumentLifecycleEvents,
    fireScriptElementEvent,
    /**
     * RFC 0011: the host's UI-click entry point — identical semantics to
     * `el.click()` (dispatch click; run activation when not canceled) so a
     * shell tap and a script click share one path.
     */
    clickElement: (id: NodeId): void => {
      // Hit tests can land on a text child — retarget to the nearest element
      // (the UA's activation target), same as clicking rendered text.
      let target: NodeId | null = id;
      while (target !== null && session.dom.nodes.get(target)?.kind !== "element") {
        target = session.dom.nodes.get(target)?.parent ?? null;
      }
      if (target === null) return;
      // RFC 0020: a host click is the full pointer+mouse sequence.
      uiClick(target);
    },
    /**
     * RFC 0013: element-targeted event delivery for the host (e.g. `load` on
     * an iframe after its child document boots). Events are typed by name.
     */
    dispatchElementEvent: (id: NodeId, type: string, init?: Record<string, unknown>): void => {
      if (session.dom.nodes.get(id)?.kind !== "element") return;
      dispatch(id, platformEvent(type, init ?? {}));
    },
    /**
     * RFC 0020: the host's UI-input synthesis surface — real pointer, mouse,
     * keyboard, focus, and tab-traversal sequences backed by the shared
     * dispatch machinery. Id form keeps the boundary explicit; resolving the
     * element wrapper is left to the caller.
     */
    ui: {
      pointerMove: uiPointerMove,
      click: uiClick,
      contextMenu: uiContextMenu,
      dblClick: uiDblClick,
      key: uiKey,
      tab: uiTab,
      focusedId: (): NodeId | null => focusedId,
    },
    bindWsRealm: (realm) => wsApi.bindRealm(realm),
    canvasBitmaps: (): ReadonlyMap<NodeId, DecodedImage> => {
      const out = new Map<NodeId, DecodedImage>();
      for (const [id, engine] of canvasEngines) {
        const img = engine.rasterize();
        if (img !== undefined) out.set(id, img);
      }
      // WebGL drawing buffers ride the same channel — the framebuffer IS the
      // canvas bitmap (snapshot() applies preserveDrawingBuffer semantics).
      for (const [id, core] of webglCores) {
        out.set(id, webglBitmap(core));
      }
      return out;
    },
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

/** Whether `maybeDescendant` is currently contained by `root`, inclusive.
 * A `"#shadow-root"` ends the walk — its DOM parent is null, so document
 * containment never reaches inside a shadow tree. */
function containsNode(dom: DomTree, root: NodeId, maybeDescendant: NodeId): boolean {
  let current: NodeId | null | undefined = maybeDescendant;
  const seen = new Set<NodeId>();
  while (current !== null && current !== undefined) {
    if (current === root) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    const n = dom.nodes.get(current);
    current = n === undefined || n.tag === "#shadow-root" ? null : n.parent;
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

const CE_RESERVED_NAMES: ReadonlySet<string> = new Set([
  "annotation-xml", "color-profile", "font-face", "font-face-src",
  "font-face-uri", "font-face-format", "font-face-name", "missing-glyph",
]);
// HTML valid custom element name: an element local name that starts with an
// ASCII lowercase letter, contains "-", and has no ASCII uppercase. Other
// code points, including non-BMP characters, are allowed.
const CE_LOCAL_NAME_RE = /^(?:[A-Za-z][^\0\t\n\f\r\u0020/>]*|[:_\u0080-\u{10FFFF}][A-Za-z0-9-.:_\u0080-\u{10FFFF}]*)$/u;

function isValidCustomElementName(local: string): boolean {
  if (local.length === 0 || !local.includes("-") || CE_RESERVED_NAMES.has(local)) return false;
  const first = local.codePointAt(0) ?? 0;
  if (first < 0x61 || first > 0x7a) return false;
  for (const ch of local) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0x41 && cp <= 0x5a) return false;
  }
  return CE_LOCAL_NAME_RE.test(local);
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
