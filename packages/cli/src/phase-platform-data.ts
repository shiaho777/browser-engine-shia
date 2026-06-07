/**
 * Platform-as-Data layout/compositing WPT subset + scoreboard wiring
 * (platform-as-data-layout spec, task 6.3; Requirements 9.1, 9.2, 9.3).
 *
 * Each newly-connected capability (flex / grid / table / float / positioned /
 * opacity / transform / z-index) is counted as implemented by the Scoreboard
 * ONLY when a REAL-document WPT check proves it reachable through the actual
 * parse → cascade → layout → paint pipeline — never on the basis of a synthetic
 * ComputedStyle (Requirement 9.2). Every check below drives the real stages (no
 * mocks) and asserts observable geometry / paint behaviour, exactly as
 * `PHASE2_WPT_SUBSET` / `PHASE3_WPT_SUBSET` are authored.
 *
 * The cli is an orchestration layer, so it may compose every stage + the
 * scoreboard here.
 */
import type { DomNode, DomTree, Fragment, FragmentTree, NodeId } from "@browser-engine/ir";
import { parseHtml } from "@browser-engine/html-parser";
import { parseCss } from "@browser-engine/css-parser";
import { cascade } from "@browser-engine/cascade";
import { layout } from "@browser-engine/layout";
import { paint } from "@browser-engine/paint";
import {
  computeScoreboard,
  runWptSubset,
  type ReftestEvidence,
  type Scoreboard,
  type SourceFileInput,
  type WptRunSummary,
  type WptSubset,
} from "@browser-engine/scoreboard";

// ---------------------------------------------------------------------------
// Helpers (mirror PHASE2/PHASE3 style).
// ---------------------------------------------------------------------------

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function expect(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function layoutDoc(html: string, css: string): { dom: DomTree; tree: FragmentTree } {
  const dom = parseHtml(enc(html));
  const sheets = [parseCss(enc(css))];
  const tree = layout(dom, (node: NodeId) => cascade(dom, sheets, node));
  return { dom, tree };
}

function paintOps(html: string, css: string): string[] {
  const dom = parseHtml(enc(html));
  const sheets = [parseCss(enc(css))];
  const styleOf = (node: NodeId) => cascade(dom, sheets, node);
  return paint(layout(dom, styleOf), styleOf).commands.map((c) => c.op);
}

function elementsByTag(dom: DomTree, tag: string): DomNode[] {
  const out: DomNode[] = [];
  for (const node of dom.nodes.values()) {
    if (node.kind === "element" && node.tag === tag) out.push(node);
  }
  return out;
}

function fragmentForNode(tree: FragmentTree, node: NodeId): Fragment {
  for (const f of tree.fragments.values()) {
    if (f.node === node) return f;
  }
  throw new Error(`no fragment for node ${String(node)}`);
}

// ---------------------------------------------------------------------------
// Capabilities + the real-document subset.
// ---------------------------------------------------------------------------

/** The capabilities this spec connects to the real pipeline (Requirement 9.1). */
export const PLATFORM_DATA_CAPABILITIES: readonly string[] = [
  "layout-flex",
  "layout-grid",
  "layout-table",
  "layout-float",
  "layout-positioned",
  "compositing-opacity",
  "compositing-transform",
  "compositing-zindex",
];

/**
 * The real-document WPT subset. Each test drives parse → cascade → layout(/paint)
 * for one capability and asserts real behaviour — proof the capability is
 * reachable WITHOUT a synthetic ComputedStyle (Requirement 9.2).
 */
export const PLATFORM_DATA_WPT_SUBSET: WptSubset = [
  {
    id: "padl/css-flexbox/real-row-equal.html",
    capability: "layout-flex",
    run: () => {
      const { dom, tree } = layoutDoc(
        '<div class="f"><span class="i"></span><span class="i"></span></div>',
        ".f { display: flex; width: 300px; height: 50px } .i { height: 50px }",
      );
      const items = elementsByTag(dom, "span");
      const a = fragmentForNode(tree, items[0]!.id);
      const b = fragmentForNode(tree, items[1]!.id);
      expect(Number(a.box.borderBox.width) === 150 && Number(b.box.borderBox.width) === 150, "flex equal split");
      expect(Number(b.box.borderBox.x) === 150, "flex items lay along the main axis");
    },
  },
  {
    id: "padl/css-grid/real-two-columns.html",
    capability: "layout-grid",
    run: () => {
      const { dom, tree } = layoutDoc(
        '<div class="g"><span class="c"></span><span class="c"></span><span class="c"></span><span class="c"></span></div>',
        ".g { display: grid; grid-template-columns: 2; width: 200px } .c { height: 25px }",
      );
      const cells = elementsByTag(dom, "span").map((n) => fragmentForNode(tree, n.id));
      expect(Number(cells[1]!.box.borderBox.x) === 100, "grid column 2 at x=100");
      expect(Number(cells[3]!.box.borderBox.y) === 25, "grid row 2 at y=25 (row-major)");
    },
  },
  {
    id: "padl/css-table/real-rows.html",
    capability: "layout-table",
    run: () => {
      const { dom, tree } = layoutDoc(
        "<table><tr><td></td><td></td></tr></table>",
        "table { display: table; width: 200px } td { height: 20px }",
      );
      const row = fragmentForNode(tree, elementsByTag(dom, "tr")[0]!.id);
      expect(Number(row.box.borderBox.width) === 200, "table row spans the table width");
    },
  },
  {
    id: "padl/css-float/real-left.html",
    capability: "layout-float",
    run: () => {
      const { dom, tree } = layoutDoc(
        '<div class="c"><span class="fl"></span><span class="flow"></span></div>',
        ".c { width: 400px } .fl { float: left; width: 100px; height: 50px } .flow { height: 20px }",
      );
      const flow = fragmentForNode(tree, elementsByTag(dom, "span")[1]!.id);
      expect(Number(flow.box.borderBox.y) === 0, "in-flow content flows beside the float");
    },
  },
  {
    id: "padl/css-position/real-absolute.html",
    capability: "layout-positioned",
    run: () => {
      const { dom, tree } = layoutDoc(
        '<div class="c"><span class="abs"></span><span class="flow"></span></div>',
        ".c { width: 300px } .abs { position: absolute; top: 10px; left: 20px; height: 40px } .flow { height: 15px }",
      );
      const abs = fragmentForNode(tree, elementsByTag(dom, "span")[0]!.id);
      const flow = fragmentForNode(tree, elementsByTag(dom, "span")[1]!.id);
      expect(Number(abs.box.borderBox.x) === 20 && Number(abs.box.borderBox.y) === 10, "absolute at insets");
      expect(Number(flow.box.borderBox.y) === 0, "absolute reserves no in-flow space");
    },
  },
  {
    id: "padl/css-compositing/real-opacity.html",
    capability: "compositing-opacity",
    run: () => {
      const ops = paintOps('<div class="b"></div>', ".b { width: 50px; height: 50px; background-color: red; opacity: 0.5 }");
      expect(ops.includes("push-layer") && ops.includes("pop-layer"), "opacity pushes a layer");
    },
  },
  {
    id: "padl/css-compositing/real-transform.html",
    capability: "compositing-transform",
    run: () => {
      const ops = paintOps('<div class="b"></div>', ".b { width: 50px; height: 50px; background-color: red; transform: matrix(2,0,0,2,0,0) }");
      expect(ops.includes("push-layer"), "transform pushes a layer");
    },
  },
  {
    id: "padl/css-compositing/real-zindex.html",
    capability: "compositing-zindex",
    run: () => {
      const dom = parseHtml(enc('<div class="c"><span class="hi"></span><span class="lo"></span></div>'));
      const sheets = [
        parseCss(
          enc(
            ".c { width: 100px } .hi { z-index: 2; height: 20px; background-color: red } .lo { z-index: 1; height: 20px; background-color: blue }",
          ),
        ),
      ];
      const styleOf = (node: NodeId) => cascade(dom, sheets, node);
      const rects = paint(layout(dom, styleOf), styleOf).commands.filter((c) => c.op === "rect");
      expect(rects.length === 2, "both backgrounds paint");
      expect(rects[0]!.op === "rect" && rects[0]!.fill.b === 255, "lower z-index (blue) paints first");
    },
  },
];

/** The forward-only baseline: every authored check passes. */
export const PLATFORM_DATA_WPT_BASELINE = PLATFORM_DATA_WPT_SUBSET.length;

/** Run the platform-as-data layout/compositing subset. */
export function runPlatformDataWptSubset(): WptRunSummary {
  return runWptSubset(PLATFORM_DATA_WPT_SUBSET);
}

/** Optional inputs for {@link computePlatformDataScoreboard}. */
export interface PlatformDataScoreboardOptions {
  readonly reftests?: readonly ReftestEvidence[];
  readonly sourceFiles?: Iterable<SourceFileInput>;
}

/**
 * Compute the scoreboard over the real-document subset. A capability is reported
 * implemented only when its real-document check passes (Requirement 9.1, 9.2).
 */
export function computePlatformDataScoreboard(options: PlatformDataScoreboardOptions = {}): Scoreboard {
  return computeScoreboard({
    wptSubset: PLATFORM_DATA_WPT_SUBSET,
    sourceFiles: options.sourceFiles ?? [],
    capabilities: PLATFORM_DATA_CAPABILITIES,
    reftests: options.reftests ?? [],
  });
}
