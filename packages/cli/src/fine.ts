/**
 * fine.ts — FINE-GRAINED incremental session (M4: the performance flagship).
 *
 * ## The thesis, made measurable
 *
 * MANIFESTO: "performance comes from MECHANISM, not micro-optimization — the
 * incremental kernel makes 'recompute only what changed' the default." M3's
 * `LiveSession` proved the live loop but held the DOM as ONE input, so any
 * mutation re-verified every node's cascade (the early-stop pruned value-equal
 * dependents, but each cascade still ran). That is O(N) style recalc per edit.
 *
 * This session makes style recalc **O(affected), not O(document)** by changing
 * the DEPENDENCY GRANULARITY — without touching the cascade:
 *
 *   - the DOM is decomposed into PER-NODE kernel inputs ({@link NodeInput}),
 *     one slot per node id;
 *   - the cascade reads the DOM through a LAZY FACADE whose `nodes.get(id)`
 *     calls `db.getInput(NodeInput, …)`. Because the kernel records a dependency
 *     for every input read during a query, `qFineComputed(node)` ends up
 *     depending on EXACTLY the nodes the cascade touched — the node itself plus
 *     its ancestors (for inheritance + descendant/child combinators) — never the
 *     whole tree.
 *
 * So mutating node X's attribute bumps only `NodeInput[X]`; every node whose
 * cascade did not read X stays cache-clean and is NOT recomputed. On a flat list
 * of N items, editing one item recomputes O(1) cascades instead of O(N) — the
 * `recomputeDelta()` diagnostic proves it on hard data (`fine.bench.test`).
 *
 * Layout still walks the whole tree (it produces the whole FragmentTree), so a
 * single edit re-lays-out the document; per-SUBTREE layout incrementality is the
 * next step (M4.2) and slots in behind this same session API. The STYLE-recalc
 * win is real and measured today.
 *
 * The cascade and `collectStylesheets` are reused UNCHANGED: this is pure
 * dependency-graph plumbing, exactly the "mechanism, not micro-optimization"
 * the manifesto promises.
 */
import {
  type DisplayList,
  type DomControlState,
  type DomNode,
  type DomTree,
  type NodeId,
  nodeId,
} from "@browser-engine/ir";
import {
  IncrementalDb,
  define,
  defineInput,
  type InputSlot,
  type QueryTraceObserver,
  type QueryDef,
} from "@browser-engine/kernel";
import { parseHtml } from "@browser-engine/html-parser";
import {
  cascade,
  cascadeWithRuleIndex,
  buildRuleIndex,
  matchRulesForIndexed,
  selectorTargetsHost,
  type IndexedRule,
} from "@browser-engine/cascade";
import { layout } from "@browser-engine/layout";
import { paint } from "@browser-engine/paint";
import {
  DEFAULT_MEDIA_ENVIRONMENT,
  type MediaEnvironment,
} from "@browser-engine/css-parser";

import { collectStylesheets, documentStylesheets, uaStylesheet, type SheetLoader } from "./stylesheets.js";
import { collectImages } from "./images.js";
import { isActiveStylesheetLink } from "./link-rel.js";
import { cacheLoader, documentBaseUrl, resolveUrl } from "./loader.js";
import type { NodeRef, Url } from "./pipeline.js";

import { pipelineFontRegistry, pipelineShaperFor } from "./fonts.js";
import { registerFontFacesSync } from "./webfonts.js";
import type { Coep, Coop } from "@browser-engine/guest";

/**
 * RFC 0031: a document's isolation state — parsed from response headers at
 * boot. `crossOriginIsolated` = COOP same-origin ∧ COEP require-corp/
 * credentialless (the SharedArrayBuffer/high-res-timer gate in real
 * browsers — we expose the flag honestly even though we ship neither).
 */
export interface DocumentIsolation {
  readonly coep: Coep;
  readonly coop: Coop;
  /** `Origin-Agent-Cluster: ?1` on the response — observational only (our
   *  site isolation is already origin-keyed for every frame). */
  readonly originAgentCluster: boolean;
  readonly crossOriginIsolated: boolean;
}

/**
 * Per-node STRUCTURE input (kind/tag/text/children/parent) — what LAYOUT reads
 * to walk the tree and size text. Keyed `${url}\u0000${nodeId}`.
 */
export const NodeStruct: InputSlot<string, DomNode> = defineInput<string, DomNode>("FineNodeStruct");
/**
 * Per-node ATTRIBUTES input — what the CASCADE reads for selector matching.
 * Split from structure so a class/style edit (attrs) does NOT invalidate LAYOUT
 * (which never reads attrs): the basis of paint-only invalidation at node level.
 */
export const NodeAttrs: InputSlot<string, ReadonlyMap<string, string>> =
  defineInput<string, ReadonlyMap<string, string>>("FineNodeAttrs");
/** The document root node id (a tiny per-document input the facade reads). */
export const DocRoot: InputSlot<Url, NodeId> = defineInput<Url, NodeId>("FineDocRoot");
/** Custom-element names defined in this document — a per-document input the
 * CASCADE facade attaches to the DomTree so `:defined` can resolve them. A
 * fresh Set is installed per `define()` so input identity tracks change. */
export const DocDefined: InputSlot<Url, ReadonlySet<string>> =
  defineInput<Url, ReadonlySet<string>>("FineDocDefined");
/** Live UI interaction state — focus/active/hover node ids + the
 * focus-visible modality flag — attached to the DomTree by the cascade
 * facade so state pseudos (`:focus`, `:focus-visible`, `:active`,
 * `:hover`, `:focus-within`) can match. A FRESH object per change so
 * input identity signals every transition. */
export interface DocUiStateValue {
  readonly focus?: NodeId | undefined;
  readonly focusVisible?: boolean | undefined;
  readonly active?: NodeId | undefined;
  readonly hover?: NodeId | undefined;
}
export const DocUiState: InputSlot<Url, DocUiStateValue> =
  defineInput<Url, DocUiStateValue>("FineDocUiState");
/**
 * Live form-control state — the per-control overrides that script or user
 * interaction wrote without touching attributes (`checked`, `selected`,
 * `indeterminate`, `value`, `customError`, `touched`). Attached to the
 * DomTree by the cascade facade so `:checked`, `:valid`, `:invalid`,
 * `:placeholder-shown`, `:indeterminate`, `:user-valid`/`:user-invalid`
 * reflect live control state, not markup. A FRESH Map per change so input
 * identity signals every write.
 */
export const DocControl: InputSlot<Url, ReadonlyMap<NodeId, DomControlState>> =
  defineInput<Url, ReadonlyMap<NodeId, DomControlState>>("FineDocControl");
/**
 * External stylesheet bytes loaded by the wiring layer before the pure query
 * graph runs. Keys are the raw `href` values from the DOM; callers that need
 * URL/base resolution do it before seeding this input.
 */
export const FineExternalSheets: InputSlot<Url, ReadonlyMap<string, Uint8Array>> =
  defineInput<Url, ReadonlyMap<string, Uint8Array>>("FineExternalSheets");

/** The media environment (viewport/DPR/prefers-*) feeding `@media`
 * evaluation in the fine-grained engine; unset ⇒ the default screen env. */
export const FineMedia: InputSlot<Url, MediaEnvironment> =
  defineInput<Url, MediaEnvironment>("FineMedia");

/**
 * The document's Content-Security-Policy context (RFC 0027) — set at session
 * construction from response headers + `<meta http-equiv>`; consulted by
 * `qFineSheets` (`style-src` on `<style>`/`<link>`), `qFineComputed`
 * (`style-src-attr` on `style=` attributes), and the script bridge
 * (`script-src`, `connect-src`). `null` = no policy.
 */
export const DocCsp: InputSlot<Url, import("./csp.js").CspContext | null> =
  defineInput<Url, import("./csp.js").CspContext | null>("FineDocCsp");

const EMPTY_ATTRS: ReadonlyMap<string, string> = new Map();
const EMPTY_EXTERNAL_SHEETS: ReadonlyMap<string, Uint8Array> = new Map();

/** The memo key for a node's input slots. */
function nodeKey(url: Url, node: NodeId): string {
  return `${url}\u0000${String(node)}`;
}

/**
 * Attributes that change a replaced element's intrinsic geometry — the ONLY
 * attrs the structure channel keeps, so `type`/`cols`/`size` edits correctly
 * invalidate layout while paint-only attr edits (class/style) still don't.
 */
const LAYOUT_ATTRS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["input", new Set(["type", "size", "width", "height"])],
  ["textarea", new Set(["cols", "rows"])],
  ["select", new Set(["size", "multiple"])],
  ["img", new Set(["width", "height", "src", "data-src"])],
  ["svg", new Set(["width", "height", "viewBox", "viewbox"])],
  ["iframe", new Set(["width", "height"])],
]);

/** Layout-relevant on EVERY element: `dir` resolves paragraph direction and
 * `dir=auto` picks first-strong at bidi time (its edit must invalidate). */
const COMMON_LAYOUT_ATTRS: ReadonlySet<string> = new Set(["dir"]);

/** The structure-only part of a DOM node (everything the cascade matches on —
 * `attrs` — excluded; replaced elements keep their layout-geometry attrs). */
function structOf(node: DomNode): DomNode {
  const tagKeep = node.tag !== undefined ? LAYOUT_ATTRS.get(node.tag) : undefined;
  const keep =
    node.tag === undefined
      ? undefined
      : tagKeep === undefined
        ? COMMON_LAYOUT_ATTRS
        : new Set([...tagKeep, ...COMMON_LAYOUT_ATTRS]);
  const attrs =
    keep === undefined || node.attrs === undefined
      ? undefined
      : [...node.attrs].filter(([k]) => keep.has(k));
  const base: DomNode = {
    id: node.id,
    kind: node.kind,
    children: node.children,
    parent: node.parent,
  };
  const withAttrs =
    attrs !== undefined && attrs.length > 0
      ? { ...base, attrs: new Map(attrs) as ReadonlyMap<string, string> }
      : base;
  const withShadow = node.shadow !== undefined ? { ...withAttrs, shadow: node.shadow } : withAttrs;
  return node.tag !== undefined
    ? node.text !== undefined
      ? { ...withShadow, tag: node.tag, text: node.text }
      : { ...withShadow, tag: node.tag }
    : node.text !== undefined
      ? { ...withShadow, text: node.text }
      : withShadow;
}

/**
 * Build a lazy {@link DomTree} facade over the per-node inputs. The `structOnly`
 * flavour reads ONLY `NodeStruct` (so the consumer — layout — depends only on
 * structure); the full flavour also merges `NodeAttrs` (so the consumer —
 * cascade / stylesheet / image collection — depends on attrs too). Every node a
 * consumer touches is recorded as a per-node dependency of the running query.
 */
function domFacade(
  db: { getInput: <K, V>(slot: InputSlot<K, V>, key: K) => V },
  url: Url,
  structOnly: boolean,
): DomTree {
  const root = db.getInput(DocRoot, url);
  const read = (id: NodeId): DomNode | undefined => {
    try {
      const struct = db.getInput(NodeStruct, nodeKey(url, id));
      if (structOnly) {
        return struct;
      }
      const attrs = db.getInput(NodeAttrs, nodeKey(url, id));
      return attrs === EMPTY_ATTRS ? struct : { ...struct, attrs };
    } catch {
      return undefined; // a node id not present in the document.
    }
  };
  const nodes = { get: read } as unknown as ReadonlyMap<NodeId, DomNode>;
  if (structOnly) {
    return { root, nodes } as unknown as DomTree;
  }
  let defined: ReadonlySet<string> | undefined;
  try {
    defined = db.getInput(DocDefined, url);
  } catch {
    defined = undefined;
  }
  let uiState: DocUiStateValue | undefined;
  try {
    uiState = db.getInput(DocUiState, url);
  } catch {
    uiState = undefined;
  }
  let control: ReadonlyMap<NodeId, DomControlState> | undefined;
  try {
    control = db.getInput(DocControl, url);
  } catch {
    control = undefined;
  }
  return {
    root,
    nodes,
    ...(defined !== undefined ? { defined } : {}),
    ...(uiState !== undefined ? { uiState } : {}),
    ...(control !== undefined ? { control } : {}),
  } as unknown as DomTree;
}

/**
 * The document's CSP context, or `null` when no policy applies. Reads the
 * per-document {@link DocCsp} input so the query graph invalidates the sheet
 * index + computed styles when the context identity changes.
 */
function docCsp(db: { getInput: <K, V>(slot: InputSlot<K, V>, key: K) => V }, url: Url) {
  try {
    return db.getInput(DocCsp, url);
  } catch {
    return null;
  }
}

/** `qFineSheets` — collect stylesheets from the live (full) DOM facade. */
export const qFineSheets = define((db, url: Url) => {
  const externalSheets = db.getInput(FineExternalSheets, url);
  const dom = domFacade(db, url, false);
  let media: MediaEnvironment = DEFAULT_MEDIA_ENVIRONMENT;
  try {
    media = db.getInput(FineMedia, url);
  } catch {
    /* unset ⇒ default env */
  }
  return documentStylesheets(
    dom,
    cacheLoader(externalSheets, documentBaseUrl(dom, url)),
    media,
    docCsp(db, url),
  );
}, "qFineSheets");

/**
 * `qFineComputed` — the cascade for one node, reading the DOM through the full
 * per-node facade so its dependency footprint is the node + its ancestors only.
 */
export const qFineRuleIndex: QueryDef<
  Url,
  { readonly index: ReturnType<typeof buildRuleIndex>; readonly layerOrder: readonly (readonly string[])[] | undefined }
> = define((db, url: Url) => {
  const sheets = db.query(qFineSheets, url);
  const origins: readonly ("ua" | "author")[] = sheets.map((_, i) => (i === 0 ? "ua" : "author"));
  const layerOrder: (readonly string[])[] = [];
  for (const sheet of sheets) {
    if (sheet.layerOrder) {
      for (const layer of sheet.layerOrder) {
        if (!layerOrder.some((l) => l.join(".") === layer.join("."))) {
          layerOrder.push(layer);
        }
      }
    }
  }
  return Object.freeze({
    index: buildRuleIndex(sheets, origins, layerOrder.length > 0 ? layerOrder : undefined),
    layerOrder: layerOrder.length > 0 ? layerOrder : undefined,
  });
}, "qFineRuleIndex");

export const qFineComputed: QueryDef<NodeRef, ReturnType<typeof cascade>> = define((db, ref: NodeRef) => {
  const dom = domFacade(db, ref.url, false);
  const cache = new Map<NodeId, ReturnType<typeof cascade>>();
  // Shadow DOM (RFC 0018): find the enclosing shadow root by climbing parents
  // until a `"#shadow-root"` node. Each lookup goes through the facade, so the
  // query's dependencies cover the ancestor chain.
  let shadowRoot: NodeId | undefined;
  {
    let cur: NodeId | null = ref.node;
    while (cur !== null) {
      const n = dom.nodes.get(cur);
      if (n === undefined) break;
      if (n.tag === "#shadow-root") {
        shadowRoot = n.id;
        break;
      }
      cur = n.parent;
    }
  }
  // CSP (RFC 0027): `style-src-attr`/`style-src` without 'unsafe-inline'
  // suppresses `style=` declarations at cascade time — the attribute stays in
  // the DOM but contributes no winners. Applies to parser- AND script-written
  // attributes alike (both reach this query).
  const cspCtx = docCsp(db, ref.url);
  const cascadeOpts =
    cspCtx === null
      ? undefined
      : {
          inlineStyleAllowed: (node: DomNode) =>
            cspCtx.checkInline(
              "style",
              { text: node.attrs?.get("style") ?? "" },
              "attr",
            ).allowed,
        };
  if (shadowRoot === undefined) {
    const { index, layerOrder } = db.query(qFineRuleIndex, ref.url);
    // Host element with an open shadow: `:host` rules from its OWN shadow
    // sheets apply at "shadow-host" origin (below every document rule).
    const self = dom.nodes.get(ref.node);
    if (self?.shadow !== undefined) {
      const extras = db.query(qFineShadowHostRules, { url: ref.url, node: self.shadow });
      if (extras.rules.length > 0) {
        return cascadeWithRuleIndex(dom, index, ref.node, undefined, layerOrder, cache, extras, cascadeOpts);
      }
    }
    return cascadeWithRuleIndex(dom, index, ref.node, undefined, layerOrder, cache, undefined, cascadeOpts);
  }
  // Inside a shadow tree: style with that root's sheets; the shadow root
  // node's computed style IS the host's (inheritance crosses the boundary).
  const hostId = dom.nodes.get(shadowRoot)?.parent;
  if (hostId !== undefined && hostId !== null) {
    cache.set(shadowRoot, db.query(qFineComputed, { url: ref.url, node: hostId }));
  }
  const { index, layerOrder } = db.query(qFineShadowIndex, { url: ref.url, node: shadowRoot });
  return cascadeWithRuleIndex(dom, index, ref.node, undefined, layerOrder, cache, undefined, cascadeOpts);
}, "qFineComputed");

/**
 * `qFineShadowIndex` — the rule index for ONE shadow root's sheets
 * (UA sheet + `<style>`/`<link>` inside the shadow subtree). Keyed by the
 * shadow root node id so each shadow tree gets its own scoped index.
 */
export const qFineShadowIndex: QueryDef<
  NodeRef,
  { readonly index: ReturnType<typeof buildRuleIndex>; readonly layerOrder: readonly (readonly string[])[] | undefined }
> = define((db, ref: NodeRef) => {
  const externalSheets = db.getInput(FineExternalSheets, ref.url);
  const dom = domFacade(db, ref.url, false);
  let media: MediaEnvironment = DEFAULT_MEDIA_ENVIRONMENT;
  try {
    media = db.getInput(FineMedia, ref.url);
  } catch {
    /* unset ⇒ default env */
  }
  const shim = { root: ref.node, nodes: dom.nodes, defined: dom.defined } as unknown as DomTree;
  const sheets = [
    uaStylesheet(),
    ...collectStylesheets(
      shim,
      cacheLoader(externalSheets, documentBaseUrl(dom, ref.url)),
      media,
      docCsp(db, ref.url),
    ),
  ];
  const origins: readonly ("ua" | "author")[] = sheets.map((_, i) => (i === 0 ? "ua" : "author"));
  const layerOrder: (readonly string[])[] = [];
  for (const sheet of sheets) {
    if (sheet.layerOrder) {
      for (const layer of sheet.layerOrder) {
        if (!layerOrder.some((l) => l.join(".") === layer.join("."))) {
          layerOrder.push(layer);
        }
      }
    }
  }
  return Object.freeze({
    index: buildRuleIndex(sheets, origins, layerOrder.length > 0 ? layerOrder : undefined),
    layerOrder: layerOrder.length > 0 ? layerOrder : undefined,
  });
}, "qFineShadowIndex");

/**
 * `qFineShadowHostRules` — the pre-filtered `:host` rules of a shadow root,
 * wrapped as `IndexedRule`s at `shadow-host` origin so the host element's
 * cascade can merge them BELOW all document rules (CSS Scoping §2.4).
 */
export const qFineShadowHostRules: QueryDef<
  NodeRef,
  { readonly node: NodeId; readonly rules: readonly IndexedRule[] }
> = define((db, ref: NodeRef) => {
  const externalSheets = db.getInput(FineExternalSheets, ref.url);
  const dom = domFacade(db, ref.url, false);
  let media: MediaEnvironment = DEFAULT_MEDIA_ENVIRONMENT;
  try {
    media = db.getInput(FineMedia, ref.url);
  } catch {
    /* unset ⇒ default env */
  }
  const hostId = dom.nodes.get(ref.node)?.parent;
  if (hostId === undefined || hostId === null) {
    return { node: ref.node, rules: [] };
  }
  const shim = { root: ref.node, nodes: dom.nodes, defined: dom.defined } as unknown as DomTree;
  const loader = cacheLoader(externalSheets, documentBaseUrl(dom, ref.url));
  const sheets = collectStylesheets(shim, loader, media, docCsp(db, ref.url));
  // Keep only rules whose subject compound carries `:host` — rules like
  // `.inner { }` in the shadow sheet must never style the host element.
  const hostOnly = sheets
    .map((sheet) => Object.freeze({
      ...sheet,
      rules: Object.freeze(sheet.rules.filter((r) => r.selector.some((s) => selectorTargetsHost(s.text)))),
    }))
    .filter((sheet) => sheet.rules.length > 0);
  if (hostOnly.length === 0) return { node: hostId, rules: [] };
  const hostIndex = buildRuleIndex(hostOnly);
  const rules = matchRulesForIndexed(hostIndex, dom, hostId).map((i) => ({
    rule: i.rule,
    order: i.order,
    origin: "shadow-host" as const,
    layer: i.layer,
  }));
  return { node: hostId, rules };
}, "qFineShadowHostRules");

/**
 * The ComputedStyle fields the LAYOUT engine actually reads (everything else —
 * `color`, `background*`, `border*Color`, `opacity`, `transform`, `zIndex`,
 * `visibility`, `cursor`, … — is PAINT-ONLY). Kept in sync with the
 * fields `@browser-engine/layout` consults; the differential test
 * (`fine renders identically to the static pipeline`) is the safety net that
 * fails loudly if a layout-relevant field is ever omitted here.
 */
const LAYOUT_FIELDS: ReadonlySet<string> = new Set([
  "display", "fontSize",
  // Font selection is layout-relevant: family/weight/style/stretch decide the
  // shaped face and its advances; feature/variation/synthesis change metrics
  // (kern, small-caps widths, synthetic bold); direction drives bidi order.
  "fontFamily", "fontWeight", "fontStyle", "fontStretch", "fontKerning",
  "fontVariant", "fontVariantCaps", "fontVariantLigatures", "fontVariantNumeric",
  "fontVariantPosition", "fontVariantEastAsian", "fontVariantAlternates",
  "fontFeatureSettings", "fontVariationSettings", "fontOpticalSizing",
  "fontSynthesis", "fontSizeAdjust", "fontPalette", "direction", "unicodeBidi",
  "textTransform",
  "width", "height", "minWidth", "maxWidth", "minHeight", "maxHeight",
  "margin", "marginTop", "marginRight", "marginBottom", "marginLeft",
  "padding", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "borderWidth", "borderStyle",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  "borderTopStyle", "borderRightStyle", "borderBottomStyle", "borderLeftStyle",
  "boxSizing", "position", "top", "right", "bottom", "left", "float", "clear",
  "aspectRatio",
  // Writing mode chooses which physical axis is the block axis. Absolute
  // boxes size align-self / justify-self against the containing block's mode.
  "writingMode",
  "flexDirection", "flexGrow", "flexShrink", "flexBasis", "flexWrap",
  "justifyContent", "alignItems", "alignSelf", "alignContent", "justifySelf", "order",
  "gap", "columnGap", "rowGap",
  "gridTemplateColumns", "gridTemplateRows",
  "lineHeight", "textAlign", "whiteSpace", "letterSpacing", "wordSpacing",
  "textIndent", "wordBreak", "overflowWrap",
  // `overflow` is LAYOUT-relevant, not paint-only: a non-visible value makes
  // the box a BFC root, which changes margin collapsing and float containment.
  "overflow", "overflowX", "overflowY",
]);

/** Project a full ComputedStyle to ONLY its layout-relevant fields (frozen). */
function projectLayoutStyle(full: ReturnType<typeof cascade>): ReturnType<typeof cascade> {
  const out: Record<string, unknown> = {};
  const src = full as Record<string, unknown>;
  for (const key of Object.keys(src)) {
    if (LAYOUT_FIELDS.has(key)) {
      out[key] = src[key];
    }
  }
  return Object.freeze(out) as unknown as ReturnType<typeof cascade>;
}

/**
 * `qFineLayoutStyle` — the LAYOUT-RELEVANT projection of a node's computed
 * style. This is the key to PAINT-ONLY INVALIDATION: when a mutation changes a
 * node's paint-only properties (e.g. `color`, hover/animation effects), this
 * projection re-computes to a DEEP-EQUAL value, so the kernel's early-stop keeps
 * `qFineLayout` cache-clean — the document re-PAINTS without re-LAYING-OUT, the
 * optimization real engines call "paint-only invalidation".
 */
export const qFineLayoutStyle: QueryDef<NodeRef, ReturnType<typeof cascade>> = define((db, ref: NodeRef) => {
  return projectLayoutStyle(db.query(qFineComputed, ref));
}, "qFineLayoutStyle");

/** `qFineLayout` — lay the document out, reading the layout-style projection.
 * Uses the STRUCT-ONLY facade, so it depends on node structure (+ layout style)
 * but NOT on attrs — a class/style edit that is paint-only never invalidates it. */
export const qFineLayout = define((db, url: Url) => {
  const dom = domFacade(db, url, true);
  const damage = db.getInput(LayoutDamage, url);
  if (damage !== undefined) {
    return layout(dom, (node) => db.query(qFineLayoutStyle, { url, node }), {
      shaper: pipelineShaperFor(url),
      incremental: damage,
    });
  }
  return layout(dom, (node) => db.query(qFineLayoutStyle, { url, node }), { shaper: pipelineShaperFor(url) });
}, "qFineLayout");

/** `qFinePaint` — the DisplayList for the live document. */
export const qFinePaint: QueryDef<Url, DisplayList> = define((db, url: Url) => {
  const dom = domFacade(db, url, false);
  const fragments = db.query(qFineLayout, url);
  const images = collectImages(dom);
  return paint(
    fragments,
    (node) => db.query(qFineComputed, { url, node }),
    (node) => images.get(node),
  );
}, "qFinePaint");

/**
 * RFC 0038: per-session layout-damage store — the kernel-visible input slot.
 * The session owns the underlying object; mutations mark it BEFORE queries
 * recompute, so `qFineLayout` hands layout() a live damage view. The slot's
 * VALUE identity never changes across the session's life — it must not drive
 * invalidation by itself (the struct/attr/char inputs already do).
 */
export const LayoutDamage = defineInput<Url, LayoutDamageStore>("LayoutDamage");

/**
 * RFC 0038: damage view handed to layout(). `clean(id)` is conservative — it
 * answers "the subtree's internal inputs are provably unchanged" using the
 * mutation stream; anything uncertain returns false and the boundary re-lays
 * out (correctness never depends on reuse).
 */
export interface LayoutDamageStore {
  /** Nodes whose own box must re-lay out (childList targets; text parents). */
  readonly structural: ReadonlySet<NodeId>;
  /**
   * Nodes whose mutations can change DESCENDANTS' computed styles (attribute
   * edits — `class`/`style`/`id`, any cascade-visible attr). Ancestor walking
   * checks membership so inherited changes taint the whole subtree.
   */
  readonly content: ReadonlySet<NodeId>;
  /** A global-restyle source mutated (`<style>` text, `<link>`, `<base>`). */
  global: boolean;
  /**
   * Render-layer hint: the collected stylesheets contain structural
   * pseudo-classes (`:first-child`, `:nth-*`, `:empty`…) or sibling
   * combinators (`+`, `~`) — either can restyle SIBLINGS on a childList or
   * attribute edit, so damage fans out conservatively. Default false.
   */
  siblingSelectors: boolean;
  /** Bumped by callers when untracked global inputs change (viewport/scroll). */
  epoch: number;
  /** The cross-run subtree cache handed to `layout()`. */
  readonly entries: Map<NodeId, import("@browser-engine/layout").CachedSubtree>;
  /** Reuse counters for benchmark evidence. */
  readonly stats: { hits: number; misses: number; stores: number; bypassed: number };
  /** "Subtree at `id` is provably unchanged since the damage snapshot." */
  clean(id: NodeId): boolean;
  /** Reset after a render consumes the damage. */
  consume(): void;
}

const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Options for {@link FineSession}. */
export interface FineSessionOptions {
  /** Read-only query observer for trace/profiling evidence. */
  readonly onQuery?: QueryTraceObserver;
  /**
   * Optional sync stylesheet resource loader supplied by the wiring layer.
   * Called during session construction, never from inside a query.
   */
  readonly loadExternalSheet?: SheetLoader;
  /**
   * The document's Content-Security-Policy context (RFC 0027), built by the
   * boot path from response headers + `<meta>` tags. Stored as a per-document
   * input so style/sheet queries can consult it with dependency tracking.
   */
  readonly csp?: import("./csp.js").CspContext | null;
}

/**
 * A DOM mutation emitted by {@link FineSession} — the input to MutationObserver
 * record construction (DOM §"queue a mutation record"). Sinks are invoked
 * SYNCHRONOUSLY at mutation time; the document facade translates these into
 * MutationRecord objects and schedules the compound microtask.
 *
 * Reparenting (`appendChild`/`insertBefore` of an attached node) emits TWO
 * records, matching browser behavior: a `childList` removal on the old parent
 * followed by a `childList` addition on the new parent.
 */
export interface DomMutation {
  readonly kind: "childList" | "attributes" | "characterData";
  /** The record target — the parent for childList, the node itself otherwise. */
  readonly target: NodeId;
  readonly addedNodes: readonly NodeId[];
  readonly removedNodes: readonly NodeId[];
  /** Siblings adjacent to the added/removed nodes at mutation time. */
  readonly previousSibling: NodeId | null;
  readonly nextSibling: NodeId | null;
  readonly attributeName: string | null;
  /** Pre-mutation value of an attribute / character data (null when unset). */
  readonly oldValue: string | null;
}

/** Sink invoked synchronously for every DOM mutation the session performs. */
export type DomMutationSink = (mutation: DomMutation) => void;

/**
 * A fine-grained incremental document session. Same API surface as
 * {@link import("./live.js").LiveSession}, but the DOM is decomposed into
 * per-node inputs so a mutation recomputes only the cascades that actually read
 * the edited node.
 */
export class FineSession {
  readonly #db: IncrementalDb;
  readonly #url: Url;
  #loadExternalSheet: SheetLoader | undefined;
  #dom: DomTree;
  #nodes: Map<NodeId, DomNode>;
  #root: NodeId;
  #pendingStructSeeds: Set<NodeId> = new Set();
  #pendingAttrSeeds: Set<NodeId> = new Set();
  readonly #mutationSinks = new Set<DomMutationSink>();
  /** Next free node id for created nodes (one past the current maximum). */
  #nextId: number;
  /** Defined custom-element local names — a fresh Set per define so the
   * incremental input sees a new identity on each registration. */
  #definedNames: ReadonlySet<string> = new Set();
  #uiState: DocUiStateValue = {};
  #csp: import("./csp.js").CspContext | null = null;
  /**
   * RFC 0038: live damage store for incremental layout. Mutations mark it in
   * `#emitMutation`; `qFineLayout` hands it to `layout()` so formatting-context
   * boundaries inside undamaged subtrees replay cached fragments instead of
   * re-laying out. `consume()` runs once a render has used the damage view.
   */
  readonly #damageStructural = new Set<NodeId>();
  readonly #damageContent = new Set<NodeId>();
  readonly #damage: LayoutDamageStore = {
    structural: this.#damageStructural,
    content: this.#damageContent,
    global: false,
    siblingSelectors: false,
    epoch: 0,
    entries: new Map(),
    stats: { hits: 0, misses: 0, stores: 0, bypassed: 0 },
    clean: (id: NodeId): boolean => this.#isCleanForLayout(id),
    consume: (): void => {
      this.#damageStructural.clear();
      this.#damageContent.clear();
      this.#damage.global = false;
    },
  };
  /** RFC 0031: the document's isolation policies (COEP/COOP/OAC) — parsed
   *  from response headers by the boot path. Plain fields, not inputs: no
   *  incremental query reads them (subresource gates consult them at
   *  request time). */
  #isolation: DocumentIsolation = {
    coep: "unsafe-none",
    coop: "unsafe-none",
    originAgentCluster: false,
    crossOriginIsolated: false,
  };

  constructor(html: string, url: Url = "fine://doc", options: FineSessionOptions = {}) {
    this.#db = new IncrementalDb(options.onQuery === undefined ? {} : { onQuery: options.onQuery });
    this.#url = url;
    this.#loadExternalSheet = options.loadExternalSheet;
    this.#csp = options.csp ?? null;
    const parsed = parseHtml(encode(html));
    this.#root = parsed.root;
    this.#nodes = new Map(parsed.nodes);
    this.#dom = { root: this.#root, nodes: this.#nodes } as unknown as DomTree;
    let max = 0;
    for (const id of this.#nodes.keys()) max = Math.max(max, Number(id));
    this.#nextId = max + 1;
    this.#seed(this.#dom);
  }

  /** Seed the document root + every node's structure/attrs + external sheets. */
  #seed(dom: DomTree): void {
    this.#db.setInput(DocRoot, this.#url, dom.root);
    this.#db.setInput(LayoutDamage, this.#url, this.#damage);
    this.#db.setInput(DocDefined, this.#url, this.#definedNames);
    this.#db.setInput(DocUiState, this.#url, this.#uiState);
    this.#db.setInput(DocControl, this.#url, this.#controlState);
    this.#db.setInput(DocCsp, this.#url, this.#csp);
    this.#syncExternalSheets();
    for (const [id, node] of dom.nodes) {
      this.#db.setInput(NodeStruct, nodeKey(this.#url, id), structOf(node));
      this.#db.setInput(NodeAttrs, nodeKey(this.#url, id), node.attrs ?? EMPTY_ATTRS);
    }
  }

  /** The current DOM tree. */
  get dom(): DomTree {
    return this.#dom;
  }

  /**
   * The document's CSP context (RFC 0027), or `null` when no policy applies.
   * Script/dynamic-resource bridges consult this for `script-src`/
   * `connect-src`/`frame-src` checks; the cascade consults the DocCsp input.
   */
  get csp(): import("./csp.js").CspContext | null {
    return this.#csp;
  }

  /**
   * Install/replace the CSP context after construction — the boot path parses
   * `<meta>` policies from the just-constructed DOM (`documentCsp` needs the
   * tree) and installs the result here before any style/script query runs.
   */
  setCsp(csp: import("./csp.js").CspContext | null): void {
    this.#csp = csp;
    this.#db.setInput(DocCsp, this.#url, csp);
  }

  /**
   * The document's COEP/COOP/agent-cluster state (RFC 0031) — installed by
   * the boot path after response-header parse, before scripts run.
   */
  get isolation(): DocumentIsolation {
    return this.#isolation;
  }

  setIsolation(isolation: DocumentIsolation): void {
    this.#isolation = isolation;
  }

  /**
   * RFC 0038: the live layout-damage store. The render path hands it to
   * `layout()` as `options.incremental`; `qFineLayout` does the same through
   * the kernel input slot. Callers bump `epoch` on viewport/scrollY changes
   * and call `consume()` once a render has committed the damage.
   */
  get layoutDamage(): LayoutDamageStore {
    return this.#damage;
  }

  /**
   * RFC 0038: declare whether the sheet set can restyle siblings (structural
   * pseudo-classes, sibling combinators). When true, childList edits and
   * attribute edits fan out damage to all children of the touched parent —
   * a `+`/`~` or `:first-child` rule can change a sibling's own box.
   */

  /**
   * RFC 0038: "the subtree rooted at `id` is provably unchanged". Three taint
   * directions: the node ITSELF in either set; a CONTENT-dirty ancestor
   * (attribute edits inherit down); and any dirty node INSIDE the subtree —
   * checked the cheap direction: for each dirty node, walk ITS ancestors —
   * if `id` appears on the chain, the dirt is inside `id`'s subtree. Cost is
   * O(|dirty| × depth), not O(subtree). Structural dirt ABOVE the node (a
   * sibling insert on an ancestor) does not taint it — the subtree's internal
   * layout only depends on itself plus the incoming containing size.
   */
  #isCleanForLayout(id: NodeId): boolean {
    if (this.#damage.global) return false;
    if (this.#damageStructural.has(id) || this.#damageContent.has(id)) return false;
    for (const d of this.#damageStructural) {
      let cur: NodeId | null = d;
      while (cur !== null) {
        if (cur === id) return false;
        cur = this.#nodes.get(cur)?.parent ?? null;
      }
    }
    for (const d of this.#damageContent) {
      let cur: NodeId | null = d;
      while (cur !== null) {
        if (cur === id) return false;
        cur = this.#nodes.get(cur)?.parent ?? null;
      }
    }
    let cur = this.#nodes.get(id)?.parent ?? null;
    while (cur !== null) {
      if (this.#damageContent.has(cur)) return false;
      cur = this.#nodes.get(cur)?.parent ?? null;
    }
    return true;
  }

  /**
   * Register a defined custom-element local name (called by the script bridge's
   * `customElements.define`). Feeds `:defined` matching through the cascade
   * facade — installed as a FRESH Set so input identity signals the change.
   */
  defineCustomElement(localName: string): void {
    const next = new Set(this.#definedNames);
    next.add(localName);
    this.#definedNames = next;
    (this.#dom as { defined?: ReadonlySet<string> }).defined = next;
    this.#db.setInput(DocDefined, this.#url, next);
  }

  /**
   * Update the document's live UI state (focus/active/hover) — the script
   * bridge's focus machinery and pointer sequences drive this. A fresh
   * object per change keeps input identity honest.
   */
  #uiEpoch = 0;

  /** Monotonic counter bumped on every UI-state transition — script-side
   * caches (getComputedStyle) join it with the DOM mutation counter to
   * detect style-affecting UI changes. */
  get uiEpoch(): number {
    return this.#uiEpoch;
  }

  setUiState(partial: Partial<DocUiStateValue>): void {
    const next: DocUiStateValue = { ...this.#uiState, ...partial };
    this.#uiState = next;
    this.#uiEpoch += 1;
    (this.#dom as { uiState?: DocUiStateValue }).uiState = next;
    this.#db.setInput(DocUiState, this.#url, next);
  }

  /** Live per-control state (checked/selected/value/… overrides that never
   * touch attributes) — the script bridge's form-control surface drives
   * this. A fresh Map per change keeps input identity honest; `uiEpoch`
   * bumps too since control state feeds computed style (`:checked`, …). */
  #controlState: ReadonlyMap<NodeId, DomControlState> = new Map();

  setControlState(id: NodeId, patch: DomControlState | undefined): void {
    const next = new Map(this.#controlState);
    if (patch === undefined) next.delete(id);
    else next.set(id, patch);
    this.#controlState = next;
    this.#uiEpoch += 1;
    (this.#dom as { control?: ReadonlyMap<NodeId, DomControlState> }).control = next;
    this.#db.setInput(DocControl, this.#url, next);
  }

  /** Drop every per-control override (form reset — attrs govern again). */
  clearControlStates(): void {
    if (this.#controlState.size === 0) return;
    this.#controlState = new Map();
    this.#uiEpoch += 1;
    (this.#dom as { control?: ReadonlyMap<NodeId, DomControlState> }).control = this.#controlState;
    this.#db.setInput(DocControl, this.#url, this.#controlState);
  }

  /** The currently tracked UI state (read-only snapshot for callers). */
  get uiState(): DocUiStateValue {
    return { ...this.#uiState };
  }

  /** The immutable document URL that keys this session. */
  #mediaEpoch = 0;

  /** Bumps when {@link setMedia} replaces the viewport. Computed-style caches key on it. */
  get mediaEpoch(): number {
    return this.#mediaEpoch;
  }

  /**
   * Install the media environment (`@media`, `<style media>`). The next
   * computed style reads the new viewport.
   */
  setMedia(env: MediaEnvironment): void {
    this.#mediaEpoch += 1;
    this.#db.setInput(FineMedia, this.#url, env);
  }

  get url(): Url {
    return this.#url;
  }

  /** The current effective base URL exposed to resource loading and guest DOM APIs. */
  get baseUrl(): string {
    return this.#documentBaseUrl();
  }

  /** Diagnostic: total compute-fn executions so far. */
  get recomputeCount(): number {
    return this.#db.recomputeCount;
  }

  /** Render the current document to a DisplayList (incrementally). */
  render(): DisplayList {
    this.#flushSeeds();
    // `@font-face` sync subset (RFC 0006): register data:/local faces at the
    // entry seam so queries stay pure; network `src`s need renderUrlToPng.
    registerFontFacesSync(
      this.#db.query(qFineSheets, this.#url),
      pipelineFontRegistry,
      this.#url,
      this.#url,
      { csp: this.#csp },
    );
    const list = this.#db.query(qFinePaint, this.#url);
    this.#damage.consume();
    return list;
  }

  /**
   * The current FragmentTree (layout product). Exposed so callers can observe
   * layout caching: across a PAINT-ONLY mutation the kernel returns the SAME
   * frozen FragmentTree reference (layout did not recompute — paint-only
   * invalidation); a layout-affecting mutation returns a fresh one.
   */
  layoutTree(): ReturnType<typeof layout> {
    this.#flushSeeds();
    const tree = this.#db.query(qFineLayout, this.#url);
    this.#damage.consume();
    return tree;
  }

  /** The current ComputedStyle of a node (via the kernel). */
  computed(node: NodeId): ReturnType<typeof cascade> {
    this.#flushSeeds();
    return this.#db.query(qFineComputed, { url: this.#url, node });
  }

  setExternalSheetLoader(loader: SheetLoader | undefined): void {
    this.#loadExternalSheet = loader;
    this.#syncExternalSheets();
    // External sheets are fetched bytes — their CONTENT changes without any
    // DOM mutation, so entries cached under the old sheet set must miss.
    this.#damage.epoch += 1;
  }

  /**
   * Subscribe to DOM mutations (MutationObserver plumbing). The sink is invoked
   * synchronously during every mutating call; returns an unsubscribe function.
   */
  onMutation(sink: DomMutationSink): () => void {
    this.#mutationSinks.add(sink);
    return () => {
      this.#mutationSinks.delete(sink);
    };
  }

  #emitMutation(mutation: DomMutation): void {
    this.#markLayoutDamage(mutation);
    for (const sink of this.#mutationSinks) sink(mutation);
  }

  /**
   * RFC 0038: translate a DOM mutation into layout damage. Semantics:
   *  - `childList` on P → P's own box is dirty (its child list changed); its
   *    children's internals are untouched — they keep their cache entries and
   *    land at new positions inside P's re-layout. When the sheet set can
   *    restyle siblings (structural pseudos / `+`/`~` combinators) ALL of P's
   *    children become content-dirty instead.
   *  - `attributes` on N → N is content-dirty: descendants inherit.
   *  - `characterData` on text T → T's PARENT element is structurally dirty
   *    (its inline run changed); T itself is a leaf with no box to cache.
   *  - `<style>` text/`<link>` attrs/`<base>` → global: every computed style
   *    is suspect, all entries must miss.
   */
  #markLayoutDamage(mutation: DomMutation): void {
    const target = this.#nodes.get(mutation.target);
    // Global restyle sources — check the element owning the change. For
    // characterData the target IS the text node; its parent element is the
    // <style>/<link> owner.
    const owner =
      target?.kind === "element"
        ? target
        : target?.kind === "text" && target.parent !== null
          ? this.#nodes.get(target.parent)
          : undefined;
    const tag = owner?.kind === "element" ? owner.tag : undefined;
    if (tag === "style" || tag === "link" || tag === "base") {
      this.#damage.global = true;
    }
    if (mutation.kind === "childList") {
      this.#damageStructural.add(mutation.target);
      // An inserted/removed subtree that CONTAINS a sheet element is a global
      // restyle source even though the childList target itself is ordinary.
      for (const moved of [...mutation.addedNodes, ...mutation.removedNodes]) {
        if (this.#subtreeHasSheetNode(moved)) this.#damage.global = true;
      }
      if (this.#damage.siblingSelectors) {
        for (const sib of target?.children ?? []) this.#damageContent.add(sib);
        for (const sib of mutation.removedNodes) this.#damageContent.add(sib);
      }
      return;
    }
    if (mutation.kind === "attributes") {
      this.#damageContent.add(mutation.target);
      if (this.#damage.siblingSelectors && target?.parent !== null && target?.parent !== undefined) {
        for (const sib of this.#nodes.get(target.parent)?.children ?? []) {
          this.#damageContent.add(sib);
        }
      }
      return;
    }
    // characterData — the text node's own inline run changed inside its parent.
    const parent = target?.parent;
    this.#damageStructural.add(parent ?? mutation.target);
  }

  /** RFC 0038: does the subtree contain a global-restyle element? */
  #subtreeHasSheetNode(id: NodeId): boolean {
    const node = this.#nodes.get(id);
    if (node === undefined) return false;
    if (
      node.kind === "element" &&
      (node.tag === "style" || node.tag === "link" || node.tag === "base")
    ) {
      return true;
    }
    for (const c of node.children) {
      if (this.#subtreeHasSheetNode(c)) return true;
    }
    return false;
  }

  /**
   * Emit a childList record. `siblingList`/`index` describe the node list at
   * the mutation's logical instant — the OLD array + removed index for a
   * removal, the NEW array + insertion index for an addition — so the record's
   * sibling fields match what the platform reports.
   */
  #emitListEdit(
    target: NodeId,
    added: readonly NodeId[],
    removed: readonly NodeId[],
    siblingList: readonly NodeId[],
    index: number,
  ): void {
    const after = index + added.length + removed.length;
    this.#emitMutation({
      kind: "childList",
      target,
      addedNodes: added,
      removedNodes: removed,
      previousSibling: index > 0 ? (siblingList[index - 1] ?? null) : null,
      nextSibling: index >= 0 ? (siblingList[after] ?? null) : null,
      attributeName: null,
      oldValue: null,
    });
  }

  #emitAtomic(
    kind: "attributes" | "characterData",
    target: NodeId,
    attributeName: string | null,
    oldValue: string | null,
  ): void {
    this.#emitMutation({
      kind,
      target,
      addedNodes: [],
      removedNodes: [],
      previousSibling: null,
      nextSibling: null,
      attributeName,
      oldValue,
    });
  }

  setText(node: NodeId, text: string): void {
    const existing = this.#nodes.get(node);
    if (existing === undefined) return;
    const oldValue = existing.text ?? null;
    const updated: DomNode = { ...existing, text };
    this.#nodes.set(node, updated);
    this.#seedStruct(node);
    this.#emitAtomic("characterData", node, null, oldValue);
  }

  setAttribute(node: NodeId, name: string, value: string): void {
    const previousBaseUrl = this.#documentBaseUrl();
    const existing = this.#nodes.get(node);
    if (existing === undefined || existing.kind !== "element") return;
    const oldValue = existing.attrs?.get(name) ?? null;
    const attrs = new Map(existing.attrs ?? []);
    attrs.set(name, value);
    const updated: DomNode = { ...existing, attrs };
    this.#nodes.set(node, updated);
    this.#seedAttrs(node);
    this.#syncExternalSheetsIfAttributeMutation(updated, name, previousBaseUrl);
    this.#emitAtomic("attributes", node, name, oldValue);
  }

  removeAttribute(node: NodeId, name: string): void {
    const previousBaseUrl = this.#documentBaseUrl();
    const existing = this.#nodes.get(node);
    if (existing === undefined || existing.kind !== "element") return;
    const oldValue = existing.attrs?.get(name) ?? null;
    if (oldValue === null) return; // removing an absent attribute records nothing.
    const attrs = new Map(existing.attrs ?? []);
    attrs.delete(name);
    const updated: DomNode = { ...existing, attrs };
    this.#nodes.set(node, updated);
    this.#seedAttrs(node);
    this.#syncExternalSheetsIfAttributeMutation(updated, name, previousBaseUrl);
    this.#emitAtomic("attributes", node, name, oldValue);
  }

  #seedNode(node: NodeId): void {
    this.#pendingStructSeeds.add(node);
    this.#pendingAttrSeeds.add(node);
  }

  #seedStruct(node: NodeId): void {
    this.#pendingStructSeeds.add(node);
  }

  #seedAttrs(node: NodeId): void {
    this.#pendingAttrSeeds.add(node);
  }

  #flushSeeds(): void {
    if (this.#pendingStructSeeds.size === 0 && this.#pendingAttrSeeds.size === 0) return;
    for (const node of this.#pendingStructSeeds) {
      const updated = this.#nodes.get(node);
      if (updated === undefined) continue;
      this.#db.setInput(NodeStruct, nodeKey(this.#url, node), structOf(updated));
    }
    for (const node of this.#pendingAttrSeeds) {
      const updated = this.#nodes.get(node);
      if (updated === undefined) continue;
      this.#db.setInput(NodeAttrs, nodeKey(this.#url, node), updated.attrs ?? EMPTY_ATTRS);
    }
    this.#pendingStructSeeds.clear();
    this.#pendingAttrSeeds.clear();
  }

  /** Detach `child` from its current parent, emitting the removal record the
   * platform reports for reparenting (remove-then-insert = two records). */
  #detachChild(child: NodeId): void {
    const c = this.#nodes.get(child);
    if (c === undefined || c.parent === null) return;
    const old = this.#nodes.get(c.parent);
    if (old === undefined) return;
    const oldSiblings = old.children;
    const index = oldSiblings.indexOf(child);
    this.#nodes.set(old.id, {
      ...old,
      children: old.children.filter((id) => id !== child),
    });
    if (index >= 0) this.#emitListEdit(old.id, [], [child], oldSiblings, index);
  }

  createElement(tag: string): NodeId {
    const id = nodeId(this.#nextId);
    this.#nextId += 1;
    const node: DomNode = {
      id,
      kind: "element",
      tag: tag.toLowerCase(),
      attrs: new Map(),
      children: [],
      parent: null,
    };
    this.#nodes.set(id, node);
    this.#seedNode(id);
    return id;
  }

  createTextNode(text: string): NodeId {
    const id = nodeId(this.#nextId);
    this.#nextId += 1;
    const node: DomNode = { id, kind: "text", text, children: [], parent: null };
    this.#nodes.set(id, node);
    this.#seedNode(id);
    return id;
  }

  createComment(text: string): NodeId {
    const id = nodeId(this.#nextId);
    this.#nextId += 1;
    const node: DomNode = { id, kind: "comment", text, children: [], parent: null };
    this.#nodes.set(id, node);
    this.#seedNode(id);
    return id;
  }

  /**
   * `attachShadow` (HTML §4.13.6): create a `"#shadow-root"` element node
   * side-attached to the host via `host.shadow` — it never appears in
   * `children`, keeping light-DOM structure queries clean. Its `parent`
   * is the host, so ancestor walks/inheritance cross the boundary.
   * Returns `null` when the host already has a shadow.
   */
  attachShadow(hostId: NodeId, mode: "open" | "closed"): NodeId | null {
    const host = this.#nodes.get(hostId);
    if (host === undefined || host.kind !== "element" || host.shadow !== undefined) return null;
    const id = nodeId(this.#nextId);
    this.#nextId += 1;
    const shadowRoot: DomNode = {
      id,
      kind: "element",
      tag: "#shadow-root",
      attrs: new Map([["mode", mode]]),
      children: [],
      parent: hostId,
    };
    this.#nodes.set(id, shadowRoot);
    this.#nodes.set(hostId, { ...host, shadow: id });
    this.#seedNode(id);
    this.#pendingStructSeeds.add(hostId);
    return id;
  }

  /** The shadow root attached to `hostId`, if any (mode recorded in attrs). */
  shadowRootOf(hostId: NodeId): NodeId | null {
    return this.#nodes.get(hostId)?.shadow ?? null;
  }

  appendChild(parent: NodeId, child: NodeId): void {
    const previousBaseUrl = this.#documentBaseUrl();
    const p = this.#nodes.get(parent);
    const c = this.#nodes.get(child);
    if (p === undefined || c === undefined || parent === child) return;
    const oldParent = c.parent;
    this.#detachChild(child);
    const freshParent = this.#nodes.get(parent);
    if (freshParent === undefined) return;
    this.#nodes.set(parent, {
      ...freshParent,
      children: [...freshParent.children.filter((id) => id !== child), child],
    });
    this.#nodes.set(child, { ...c, parent });
    this.#seedStruct(parent);
    this.#seedStruct(child);
    if (oldParent !== null && oldParent !== parent) this.#seedStruct(oldParent);
    this.#syncExternalSheetsIfSubtreeMutationCanAffectResources(child, previousBaseUrl);
    const newChildren = this.#nodes.get(parent)?.children ?? [];
    this.#emitListEdit(parent, [child], [], newChildren, newChildren.indexOf(child));
  }

  insertBefore(parent: NodeId, child: NodeId, ref: NodeId | null): void {
    const previousBaseUrl = this.#documentBaseUrl();
    const p = this.#nodes.get(parent);
    const c = this.#nodes.get(child);
    if (p === undefined || c === undefined || parent === child) return;
    const oldParent = c.parent;
    this.#detachChild(child);
    const freshParent = this.#nodes.get(parent);
    if (freshParent === undefined) return;
    const kids = freshParent.children.filter((id) => id !== child);
    const at = ref === null ? kids.length : kids.indexOf(ref);
    const idx = at < 0 ? kids.length : at;
    this.#nodes.set(parent, {
      ...freshParent,
      children: [...kids.slice(0, idx), child, ...kids.slice(idx)],
    });
    this.#nodes.set(child, { ...c, parent });
    this.#seedStruct(parent);
    this.#seedStruct(child);
    if (oldParent !== null && oldParent !== parent) this.#seedStruct(oldParent);
    this.#syncExternalSheetsIfSubtreeMutationCanAffectResources(child, previousBaseUrl);
    this.#emitListEdit(parent, [child], [], this.#nodes.get(parent)?.children ?? [], idx);
  }

  removeChild(parent: NodeId, child: NodeId): void {
    const previousBaseUrl = this.#documentBaseUrl();
    const p = this.#nodes.get(parent);
    const c = this.#nodes.get(child);
    if (p === undefined || c === undefined) return;
    const oldSiblings = p.children;
    const index = oldSiblings.indexOf(child);
    this.#nodes.set(parent, {
      ...p,
      children: p.children.filter((id) => id !== child),
    });
    this.#nodes.set(child, { ...c, parent: null });
    this.#seedStruct(parent);
    this.#seedStruct(child);
    this.#syncExternalSheetsIfSubtreeMutationCanAffectResources(child, previousBaseUrl);
    if (index >= 0) this.#emitListEdit(parent, [], [child], oldSiblings, index);
  }

  /** Recompute the external stylesheet input from the current DOM. */
  #syncExternalSheets(): void {
    this.#db.setInput(FineExternalSheets, this.#url, loadExternalStylesheets(this.#dom, this.#url, this.#loadExternalSheet));
  }

  /** The document's current effective base URL for resolving external resources. */
  #documentBaseUrl(): string {
    return documentBaseUrl(this.#dom, this.#url);
  }

  /** Rescan stylesheet resources only for mutations that can change external sheet URLs. */
  #syncExternalSheetsIfAttributeMutation(node: DomNode | undefined, name: string, previousBaseUrl: string): void {
    if (
      this.#documentBaseUrl() !== previousBaseUrl ||
      node?.kind === "element" &&
      node.tag === "link" &&
      (name === "href" || name === "rel" || name === "disabled" || name === "media")
    ) {
      this.#syncExternalSheets();
    }
  }

  /** Rescan when moving/removing a stylesheet link or changing the document base URL. */
  #syncExternalSheetsIfSubtreeMutationCanAffectResources(node: NodeId, previousBaseUrl: string): void {
    if (this.#documentBaseUrl() !== previousBaseUrl || subtreeHasStylesheetLink(this.#dom, node)) {
      this.#syncExternalSheets();
    }
  }
}

/** Load the external stylesheets currently referenced by the parsed document. */
function loadExternalStylesheets(
  dom: DomTree,
  documentUrl: string,
  loadExternal?: SheetLoader,
): ReadonlyMap<string, Uint8Array> {
  if (loadExternal === undefined) {
    return EMPTY_EXTERNAL_SHEETS;
  }
  const baseUrl = documentBaseUrl(dom, documentUrl);
  const sheets = new Map<string, Uint8Array>();
  const visit = (id: NodeId): void => {
    const node = dom.nodes.get(id);
    if (node === undefined) {
      return;
    }
    if (!isActiveStylesheetLink(node)) {
      for (const child of node.children) {
        visit(child);
      }
      return;
    }
    const href = node.attrs?.get("href");
    if (href !== undefined && href.length > 0 && !isDataUrl(href)) {
      const abs = resolveUrl(href, baseUrl);
      if (abs !== null) {
        const bytes = loadExternal(abs);
        if (bytes !== undefined) {
          sheets.set(abs, bytes);
        }
      }
    }
    for (const child of node.children) {
      visit(child);
    }
  };
  visit(dom.root);
  return sheets.size === 0 ? EMPTY_EXTERNAL_SHEETS : sheets;
}

/** Whether a subtree contains at least one stylesheet link element. */
function subtreeHasStylesheetLink(dom: DomTree, id: NodeId): boolean {
  const node = dom.nodes.get(id);
  if (node === undefined) return false;
  if (node.kind === "element" && node.tag === "link") return true;
  if (node.children.length === 0) return false;
  for (const child of node.children) {
    if (subtreeHasStylesheetLink(dom, child)) return true;
  }
  return false;
}

/** URL schemes are ASCII case-insensitive. */
function isDataUrl(href: string): boolean {
  return href.slice(0, 5).toLowerCase() === "data:";
}
