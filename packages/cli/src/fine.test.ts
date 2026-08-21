/**
 * Tests + HARD-DATA benchmark for the M4 fine-grained incremental session.
 *
 * The flagship measurement: editing ONE node in an N-node document recomputes
 * O(1) cascades with `FineSession` (per-node inputs) versus O(N) with the
 * coarse `LiveSession` (one whole-DOM input). This is the "recompute only what
 * changed" thesis, on real numbers, on the real pipeline.
 *
 * Built by `tsc` then run with: `node --test packages/cli/dist/*.test.js`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { DomTree, NodeId, PaintCmd } from "@browser-engine/ir";

import { FineSession } from "./fine.js";
import { LiveSession } from "./live.js";

/** Build a document of N styled sibling divs (`.item`) under a container. */
function listDoc(n: number): string {
  const items = Array.from({ length: n }, () => '<div class="item">x</div>').join("");
  return (
    "<html><head><style>.item { width: 10px; height: 10px; background-color: red }" +
    " .hot { background-color: blue }</style></head>" +
    `<body><div class="container">${items}</div></body></html>`
  );
}

/** The node id of the k-th `.item` div (0-based) in a parsed list document. */
function itemNodeIds(dom: DomTree): NodeId[] {
  const ids: NodeId[] = [];
  for (const [id, node] of dom.nodes) {
    if (node.kind === "element" && node.tag === "div" && (node.attrs?.get("class") ?? "").includes("item")) {
      ids.push(id);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Correctness: the fine session renders identically to the coarse one
// ---------------------------------------------------------------------------

function rectFills(list: { commands: readonly PaintCmd[] }): string {
  return JSON.stringify(
    list.commands.filter((c): c is Extract<PaintCmd, { op: "rect" }> => c.op === "rect").map((c) => c.fill),
  );
}

void test("FineSession renders identically to LiveSession (same pipeline, finer deps)", () => {
  const html = listDoc(5);
  const fine = new FineSession(html);
  const live = new LiveSession(html);
  assert.equal(rectFills(fine.render()), rectFills(live.render()));
});

void test("a fine-grained mutation is reflected and stays correct vs a fresh render", () => {
  const fine = new FineSession(listDoc(4));
  fine.render();
  const items = itemNodeIds(fine.dom);
  fine.setAttribute(items[1]!, "class", "item hot");

  // A fresh fine session built with the same edit must render identically.
  const fresh = new FineSession(listDoc(4));
  const freshItems = itemNodeIds(fresh.dom);
  fresh.setAttribute(freshItems[1]!, "class", "item hot");
  assert.equal(rectFills(fine.render()), rectFills(fresh.render()));

  // And the edited item is now blue while the rest stay red.
  const blue = fine.render().commands.filter((c) => c.op === "rect" && c.fill.b === 255);
  assert.equal(blue.length, 1, "exactly the one edited item turned blue");
});

// ---------------------------------------------------------------------------
// HARD DATA: per-edit recompute is O(1) for fine vs O(N) for coarse
// ---------------------------------------------------------------------------

void test("HARD DATA: editing 1 of N nodes — fine recompute is ~constant, coarse is ~O(N)", () => {
  const measure = (n: number, make: (html: string) => { render: () => unknown; recomputeCount: number; dom: DomTree; setAttribute: (id: NodeId, k: string, v: string) => void }): number => {
    const session = make(listDoc(n));
    session.render(); // prime all caches.
    const items = itemNodeIds(session.dom);
    const before = session.recomputeCount;
    session.setAttribute(items[Math.floor(n / 2)]!, "class", "item hot"); // edit ONE middle item.
    session.render();
    return session.recomputeCount - before; // compute-fns run for this one edit.
  };

  const N1 = 20;
  const N2 = 80;
  const fine1 = measure(N1, (h) => new FineSession(h));
  const fine2 = measure(N2, (h) => new FineSession(h));
  const coarse1 = measure(N1, (h) => new LiveSession(h));
  const coarse2 = measure(N2, (h) => new LiveSession(h));

  // FINE: the per-edit recompute count barely grows when N quadruples (it is
  // dominated by the single edited cascade + the whole-tree layout/paint, not
  // by N cascades). We assert it does NOT scale with N.
  assert.ok(
    fine2 <= fine1 + 5,
    `fine recompute should be ~constant in N: N=${N1}→${fine1}, N=${N2}→${fine2}`,
  );

  // COARSE: the per-edit recompute count grows roughly with N (every node's
  // cascade re-runs because they all depend on the single whole-DOM input).
  assert.ok(
    coarse2 - coarse1 >= (N2 - N1) - 5,
    `coarse recompute should scale with N: N=${N1}→${coarse1}, N=${N2}→${coarse2}`,
  );

  // The headline asymmetry: at N=80, fine recomputes far fewer cascades than
  // coarse — an order-of-magnitude-class win on style recalc.
  assert.ok(
    fine2 * 4 < coarse2,
    `fine must dramatically beat coarse at N=${N2}: fine=${fine2}, coarse=${coarse2}`,
  );
});

void test("HARD DATA: re-render with NO mutation recomputes nothing in either session", () => {
  for (const session of [new FineSession(listDoc(30)), new LiveSession(listDoc(30))]) {
    session.render();
    const before = session.recomputeCount;
    session.render();
    assert.equal(session.recomputeCount, before, "a no-op re-render recomputes nothing");
  }
});

// ---------------------------------------------------------------------------
// M4.2: PAINT-ONLY INVALIDATION — a paint-only edit re-paints without relayout
// ---------------------------------------------------------------------------

const paintVsLayoutDoc =
  "<html><head><style>#a { width: 40px; height: 30px; background-color: red }" +
  " .blue { background-color: blue !important } .wide { width: 80px !important }</style></head>" +
  '<body><div id="a">x</div></body></html>';

function divA(session: FineSession): NodeId {
  for (const [id, node] of session.dom.nodes) {
    if (node.kind === "element" && node.attrs?.get("id") === "a") return id;
  }
  throw new Error("no #a");
}

void test("M4.2: a PAINT-ONLY mutation (background) re-paints WITHOUT re-laying-out", () => {
  const session = new FineSession(paintVsLayoutDoc);
  session.render();
  const layoutBefore = session.layoutTree();

  // Change only the background colour (a paint-only property).
  session.setAttribute(divA(session), "class", "blue");
  const list = session.render();
  const layoutAfter = session.layoutTree();

  // Layout was NOT recomputed: the kernel returns the very same FragmentTree.
  assert.equal(layoutAfter, layoutBefore, "paint-only edit must reuse the cached layout (no relayout)");
  // But the paint DID update: the background is now blue.
  assert.ok(
    list.commands.some((c) => c.op === "rect" && c.fill.b === 255),
    "the re-paint reflects the new blue background",
  );
});

void test("M4.2: a LAYOUT-affecting mutation (width) DOES re-lay-out", () => {
  const session = new FineSession(paintVsLayoutDoc);
  session.render();
  const layoutBefore = session.layoutTree();

  session.setAttribute(divA(session), "class", "wide");
  session.render();
  const layoutAfter = session.layoutTree();

  assert.notEqual(layoutAfter, layoutBefore, "a width change must produce a fresh layout");
  // And the new width took effect.
  const rect = session.render().commands.find((c) => c.op === "rect");
  assert.ok(rect !== undefined && rect.op === "rect");
  assert.equal(Number(rect.rect.width), 80, "the div is now 80px wide");
});

void test("M4.2: paint-only invalidation holds at scale (1 of N paint edits never relayouts)", () => {
  const items = Array.from({ length: 50 }, (_, i) => `<div id="n${i}" class="box">x</div>`).join("");
  const html =
    "<html><head><style>.box { width: 6px; height: 6px; background-color: red } .blue { background-color: blue }</style></head>" +
    `<body>${items}</body></html>`;
  const session = new FineSession(html);
  session.render();
  const layoutBefore = session.layoutTree();

  // Edit the colour of one middle item — paint only.
  let target: NodeId | null = null;
  for (const [id, node] of session.dom.nodes) {
    if (node.attrs?.get("id") === "n25") target = id;
  }
  session.setAttribute(target!, "class", "box blue");
  session.render();

  assert.equal(session.layoutTree(), layoutBefore, "a paint-only edit never relayouts, even at scale");
  assert.equal(
    session.render().commands.filter((c) => c.op === "rect" && c.fill.b === 255).length,
    1,
    "exactly the edited item repainted blue",
  );
});

// ---------------------------------------------------------------------------
// Real text fidelity: the production pipeline shapes text PROPORTIONALLY
// ---------------------------------------------------------------------------

/** The glyph advances of the first `text` command a session renders. */
function textAdvances(session: FineSession): number[] {
  const cmd = session.render().commands.find((c): c is Extract<PaintCmd, { op: "text" }> => c.op === "text");
  assert.ok(cmd !== undefined, "the document must emit a text command");
  return cmd.glyphs.map((g) => Number(g.advance));
}

void test("the pipeline shapes text proportionally: 'm' advances wider than 'i'", () => {
  const wide = textAdvances(new FineSession("<div>mmmm</div>"));
  const thin = textAdvances(new FineSession("<div>iiii</div>"));
  assert.equal(wide.length, 4);
  assert.equal(thin.length, 4);
  assert.ok(wide[0]! > thin[0]!, `'m' (${wide[0]}) must advance wider than 'i' (${thin[0]})`);
  // Monospace would give every glyph the SAME advance; proportional does not.
  const mixed = textAdvances(new FineSession("<div>Wil</div>"));
  assert.ok(new Set(mixed).size > 1, "a mixed run has more than one distinct advance (not monospace)");
});

// ---------------------------------------------------------------------------
// Structural DOM mutation (createElement / appendChild / removeChild).
// ---------------------------------------------------------------------------

void test("createElement + appendChild adds a rendered, laid-out element", () => {
  const session = new FineSession(
    "<html><head><style>.box{width:10px;height:10px;background-color:red}</style></head><body></body></html>",
  );
  let body: NodeId | null = null;
  for (const [id, node] of session.dom.nodes) if (node.tag === "body") body = id;
  assert.ok(body !== null);

  const before = session.render().commands.filter((c) => c.op === "rect").length;
  const div = session.createElement("div");
  session.setAttribute(div, "class", "box");
  session.appendChild(body, div);
  const after = session.render().commands.filter((c) => c.op === "rect" && c.fill.r === 255).length;

  assert.equal(after, before + 1, "the created .box element paints a red rect");
  // The new node is genuinely in the laid-out tree.
  const frag = [...session.layoutTree().fragments.values()].find((f) => Number(f.node) === Number(div));
  assert.ok(frag !== undefined, "the appended element has a layout fragment");
  assert.equal(Number(frag.box.borderBox.width), 10);
});

void test("removeChild detaches an element so it no longer renders", () => {
  const session = new FineSession(
    '<html><head><style>#a{width:8px;height:8px;background-color:blue}</style></head><body><div id="a"></div></body></html>',
  );
  let body: NodeId | null = null;
  let a: NodeId | null = null;
  for (const [id, node] of session.dom.nodes) {
    if (node.tag === "body") body = id;
    if (node.attrs?.get("id") === "a") a = id;
  }
  assert.ok(session.render().commands.some((c) => c.op === "rect" && c.fill.b === 255), "the blue div renders");
  session.removeChild(body!, a!);
  assert.ok(!session.render().commands.some((c) => c.op === "rect" && c.fill.b === 255), "removed div no longer renders");
});

void test("insertBefore orders created children correctly", () => {
  const session = new FineSession("<html><body></body></html>");
  let body: NodeId | null = null;
  for (const [id, node] of session.dom.nodes) if (node.tag === "body") body = id;
  const a = session.createElement("div");
  const b = session.createElement("div");
  session.appendChild(body!, a);
  session.insertBefore(body!, b, a); // b before a
  assert.deepEqual(
    session.dom.nodes.get(body!)!.children.map((c) => Number(c)),
    [Number(b), Number(a)],
    "insertBefore placed b ahead of a",
  );
});

void test("removeAttribute deletes the attribute key and restyles through fine-grained attrs", () => {
  const session = new FineSession(
    '<html><head><style>.on{width:12px;height:12px;background-color:red}</style></head><body><div id="x" class="on"></div></body></html>',
  );
  let x: NodeId | null = null;
  for (const [id, node] of session.dom.nodes) if (node.attrs?.get("id") === "x") x = id;
  assert.ok(x !== null);
  assert.ok(session.render().commands.some((c) => c.op === "rect" && c.fill.r === 255), "precondition: .on paints");

  session.removeAttribute(x, "class");

  assert.equal(session.dom.nodes.get(x)?.attrs?.has("class"), false, "class key is removed");
  assert.ok(!session.render().commands.some((c) => c.op === "rect" && c.fill.r === 255), "class rule no longer matches");
});

void test("external stylesheet links stay synced across append, href change, and removal", () => {
  const encodeSheet = (css: string): Uint8Array => new TextEncoder().encode(css);
  const sheets = new Map<string, Uint8Array>([
    ["fine://dynamic-stylesheet/a.css", encodeSheet("#x{width:14px;height:14px;background-color:red}")],
    ["fine://dynamic-stylesheet/b.css", encodeSheet("#x{width:18px;height:18px;background-color:blue}")],
  ]);
  const session = new FineSession(
    '<html><head></head><body><div id="x"></div></body></html>',
    "fine://dynamic-stylesheet",
    { loadExternalSheet: (href) => sheets.get(href) },
  );
  let head: NodeId | null = null;
  for (const [id, node] of session.dom.nodes) {
    if (node.tag === "head") head = id;
  }
  assert.ok(head !== null);

  const link = session.createElement("link");
  session.setAttribute(link, "rel", "stylesheet");
  session.setAttribute(link, "href", "a.css");
  session.appendChild(head, link);
  assert.ok(
    session.render().commands.some((c) => c.op === "rect" && c.fill.r === 255 && Number(c.rect.width) === 14),
    "appending a stylesheet link applies its loaded CSS",
  );

  session.setAttribute(link, "href", "b.css");
  assert.ok(
    session.render().commands.some((c) => c.op === "rect" && c.fill.b === 255 && Number(c.rect.width) === 18),
    "changing href refreshes the loaded stylesheet input",
  );

  session.removeChild(head, link);
  assert.ok(
    !session.render().commands.some((c) => c.op === "rect" && (c.fill.r === 255 || c.fill.b === 255)),
    "removing the stylesheet link removes its declarations from the live cascade",
  );
});

void test("external stylesheet links resolve through the frozen base href in FineSession", () => {
  const encodeSheet = (css: string): Uint8Array => new TextEncoder().encode(css);
  const documentUrl = "https://site.test/pages/index.html";
  const stylesheetUrl = "https://cdn.test/assets/theme.css";
  const loads: string[] = [];
  const session = new FineSession(
    '<html><head><base href="https://cdn.test/assets/"><link rel="stylesheet" href="theme.css"></head>' +
      '<body><div id="x"></div></body></html>',
    documentUrl,
    {
      loadExternalSheet: (href) => {
        loads.push(href);
        return href === stylesheetUrl
          ? encodeSheet("#x{width:16px;height:16px;background-color:red}")
          : undefined;
      },
    },
  );

  assert.deepEqual(loads, [stylesheetUrl], "FineSession fetches the base-resolved stylesheet URL");
  assert.ok(
    session.render().commands.some((c) => c.op === "rect" && c.fill.r === 255 && Number(c.rect.width) === 16),
    "base-resolved stylesheet participates in the live cascade",
  );
});

void test("base href mutations rescan stylesheet URLs only when the effective base changes", () => {
  const encodeSheet = (css: string): Uint8Array => new TextEncoder().encode(css);
  const documentUrl = "https://site.test/pages/index.html";
  const firstTheme = "https://cdn-a.test/assets/theme.css";
  const firstNext = "https://cdn-a.test/assets/next.css";
  const changedNext = "https://cdn-b.test/assets/next.css";
  const sheets = new Map<string, Uint8Array>([
    [firstTheme, encodeSheet("#x{width:16px;height:16px;background-color:red}")],
    [firstNext, encodeSheet("#x{width:20px;height:20px;background-color:rgb(0,255,0)}")],
    [changedNext, encodeSheet("#x{width:24px;height:24px;background-color:blue}")],
  ]);
  const loads: string[] = [];
  const session = new FineSession(
    '<html><head><base id="first-base" href="https://cdn-a.test/assets/">' +
      '<base id="later-base" href="https://ignored.test/assets/">' +
      '<link id="theme" rel="stylesheet" href="theme.css"></head><body><div id="x"></div></body></html>',
    documentUrl,
    {
      loadExternalSheet: (href) => {
        loads.push(href);
        return sheets.get(href);
      },
    },
  );
  let firstBase: NodeId | null = null;
  let laterBase: NodeId | null = null;
  let link: NodeId | null = null;
  for (const [id, node] of session.dom.nodes) {
    if (node.attrs?.get("id") === "first-base") firstBase = id;
    if (node.attrs?.get("id") === "later-base") laterBase = id;
    if (node.attrs?.get("id") === "theme") link = id;
  }
  assert.ok(firstBase !== null);
  assert.ok(laterBase !== null);
  assert.ok(link !== null);

  assert.deepEqual(loads, [firstTheme], "initial stylesheet fetch uses the first base");
  assert.ok(
    session.render().commands.some((c) => c.op === "rect" && c.fill.r === 255 && Number(c.rect.width) === 16),
    "initial base-resolved stylesheet applies",
  );

  session.setAttribute(laterBase, "href", "https://cdn-b.test/assets/");

  assert.deepEqual(loads, [firstTheme], "mutating a later base does not refetch or retarget resources");
  assert.ok(
    session.render().commands.some((c) => c.op === "rect" && c.fill.r === 255 && Number(c.rect.width) === 16),
    "later base mutation keeps the first-base stylesheet active",
  );

  session.setAttribute(link, "href", "next.css");

  assert.deepEqual(loads, [firstTheme, firstNext], "link href mutation reloads against the first base");
  assert.ok(
    session.render().commands.some((c) => c.op === "rect" && c.fill.g === 255 && Number(c.rect.width) === 20),
    "link href mutation applies the first-base replacement stylesheet",
  );

  session.setAttribute(firstBase, "href", "https://cdn-b.test/assets/");

  assert.deepEqual(loads, [firstTheme, firstNext, changedNext], "changing the first base reloads current link URLs");
  assert.ok(
    session.render().commands.some((c) => c.op === "rect" && c.fill.b === 255 && Number(c.rect.width) === 24),
    "first base mutation applies the current link through the new base",
  );
});

void test("alternate stylesheet links stay inactive until rel becomes an active stylesheet", () => {
  const encodeSheet = (css: string): Uint8Array => new TextEncoder().encode(css);
  const sheets = new Map<string, Uint8Array>([
    ["fine://alternate-stylesheet/theme.css", encodeSheet("#x{width:14px;height:14px;background-color:red}")],
  ]);
  const loads: string[] = [];
  const session = new FineSession(
    '<html><head></head><body><div id="x"></div></body></html>',
    "fine://alternate-stylesheet",
    {
      loadExternalSheet: (href) => {
        loads.push(href);
        return sheets.get(href);
      },
    },
  );
  let head: NodeId | null = null;
  for (const [id, node] of session.dom.nodes) {
    if (node.tag === "head") head = id;
  }
  assert.ok(head !== null);

  const link = session.createElement("link");
  session.setAttribute(link, "rel", "alternate stylesheet");
  session.setAttribute(link, "href", "theme.css");
  session.appendChild(head, link);

  assert.deepEqual(loads, [], "inactive alternate stylesheet is not loaded");
  assert.ok(
    !session.render().commands.some((c) => c.op === "rect" && c.fill.r === 255),
    "inactive alternate stylesheet does not apply",
  );

  session.setAttribute(link, "rel", "stylesheet");

  assert.deepEqual(loads, ["fine://alternate-stylesheet/theme.css"], "becoming active loads the stylesheet once");
  assert.ok(
    session.render().commands.some((c) => c.op === "rect" && c.fill.r === 255 && Number(c.rect.width) === 14),
    "active stylesheet applies after rel mutation",
  );
});

void test("disabled stylesheet links stay inactive until disabled is removed", () => {
  const encodeSheet = (css: string): Uint8Array => new TextEncoder().encode(css);
  const sheets = new Map<string, Uint8Array>([
    ["fine://disabled-stylesheet/theme.css", encodeSheet("#x{width:14px;height:14px;background-color:red}")],
  ]);
  const loads: string[] = [];
  const session = new FineSession(
    '<html><head></head><body><div id="x"></div></body></html>',
    "fine://disabled-stylesheet",
    {
      loadExternalSheet: (href) => {
        loads.push(href);
        return sheets.get(href);
      },
    },
  );
  let head: NodeId | null = null;
  for (const [id, node] of session.dom.nodes) {
    if (node.tag === "head") head = id;
  }
  assert.ok(head !== null);

  const link = session.createElement("link");
  session.setAttribute(link, "rel", "stylesheet");
  session.setAttribute(link, "disabled", "");
  session.setAttribute(link, "href", "theme.css");
  session.appendChild(head, link);

  assert.deepEqual(loads, [], "disabled stylesheet is not loaded");
  assert.ok(
    !session.render().commands.some((c) => c.op === "rect" && c.fill.r === 255),
    "disabled stylesheet does not apply",
  );

  session.removeAttribute(link, "disabled");

  assert.deepEqual(loads, ["fine://disabled-stylesheet/theme.css"], "removing disabled loads the stylesheet once");
  assert.ok(
    session.render().commands.some((c) => c.op === "rect" && c.fill.r === 255 && Number(c.rect.width) === 14),
    "enabled stylesheet applies after disabled removal",
  );
});

void test("print media stylesheet links stay inactive until media matches screen", () => {
  const encodeSheet = (css: string): Uint8Array => new TextEncoder().encode(css);
  const sheets = new Map<string, Uint8Array>([
    ["fine://media-stylesheet/theme.css", encodeSheet("#x{width:14px;height:14px;background-color:red}")],
  ]);
  const loads: string[] = [];
  const session = new FineSession(
    '<html><head></head><body><div id="x"></div></body></html>',
    "fine://media-stylesheet",
    {
      loadExternalSheet: (href) => {
        loads.push(href);
        return sheets.get(href);
      },
    },
  );
  let head: NodeId | null = null;
  for (const [id, node] of session.dom.nodes) {
    if (node.tag === "head") head = id;
  }
  assert.ok(head !== null);

  const link = session.createElement("link");
  session.setAttribute(link, "rel", "stylesheet");
  session.setAttribute(link, "media", "print");
  session.setAttribute(link, "href", "theme.css");
  session.appendChild(head, link);

  assert.deepEqual(loads, [], "print-only stylesheet is not loaded for screen rendering");
  assert.ok(
    !session.render().commands.some((c) => c.op === "rect" && c.fill.r === 255),
    "print-only stylesheet does not apply",
  );

  session.setAttribute(link, "media", "screen");

  assert.deepEqual(loads, ["fine://media-stylesheet/theme.css"], "matching media loads the stylesheet once");
  assert.ok(
    session.render().commands.some((c) => c.op === "rect" && c.fill.r === 255 && Number(c.rect.width) === 14),
    "screen media stylesheet applies after media mutation",
  );
});

void test("style element text mutations restyle through qFineSheets dependencies", () => {
  const session = new FineSession(
    '<html><head><style id="sheet">#x{width:10px;height:10px;background-color:red}</style></head><body><div id="x"></div></body></html>',
  );
  let styleText: NodeId | null = null;
  for (const [id, node] of session.dom.nodes) {
    if (node.kind === "text" && (node.text ?? "").includes("background-color:red")) styleText = id;
  }
  assert.ok(styleText !== null);
  assert.ok(
    session.render().commands.some((c) => c.op === "rect" && c.fill.r === 255 && Number(c.rect.width) === 10),
    "precondition: the initial style text applies",
  );

  session.setText(styleText, "#x{width:18px;height:18px;background-color:blue}");

  assert.ok(
    session.render().commands.some((c) => c.op === "rect" && c.fill.b === 255 && Number(c.rect.width) === 18),
    "editing the style text invalidates sheets and applies the new rule",
  );
});

void test("removing a style element drops its rules from the live cascade", () => {
  const session = new FineSession(
    '<html><head><style id="sheet">#x{width:20px;height:20px;color:red}</style></head><body><div id="x"></div></body></html>',
  );
  let head: NodeId | null = null;
  let sheet: NodeId | null = null;
  let x: NodeId | null = null;
  for (const [id, node] of session.dom.nodes) {
    if (node.tag === "head") head = id;
    if (node.attrs?.get("id") === "sheet") sheet = id;
    if (node.attrs?.get("id") === "x") x = id;
  }
  assert.ok(head !== null);
  assert.ok(sheet !== null);
  assert.ok(x !== null);
  assert.equal(session.computed(x)["width"], 20, "precondition: the style rule applies");

  session.removeChild(head, sheet);

  assert.equal(session.computed(x)["width"], "auto", "removed style rules no longer affect width");
  assert.equal(session.computed(x).color.r, 0, "removed style rules no longer affect color");
});

import { runScript } from "./script.js";

void test("a script classList.add restyles + re-renders (class selector takes effect)", () => {
  const session = new FineSession(
    '<html><head><style>.on{width:12px;height:12px;background-color:red}</style></head><body><div id="x"></div></body></html>',
  );
  assert.ok(!session.render().commands.some((c) => c.op === "rect" && c.fill.r === 255), "no red before");
  runScript(session, 'document.getElementById("x").classList.add("on");');
  assert.ok(
    session.render().commands.some((c) => c.op === "rect" && c.fill.r === 255 && Number(c.rect.width) === 12),
    "classList.add('on') applied the .on rule and re-rendered a 12px red box",
  );
});
