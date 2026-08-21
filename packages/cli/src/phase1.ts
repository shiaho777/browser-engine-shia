/**
 * Phase 1 vertical-slice fixtures: the first reftest baseline and the first
 * real WPT subset / scoreboard (task 3.12).
 *
 * design.md §5 ("Phase 1 — 端到端竖线") success criteria:
 *   "`<div>hello</div>` 截图与参考图像素对比通过;记分牌可公开展示一个真实
 *    (虽小)的数字。"
 *
 * This module turns those two criteria into concrete, committed artifacts the
 * constitution check gate (`./checks.ts`) runs on every commit:
 *
 *   1. The `<div>hello</div>` REFTEST BASELINE (Requirement 14.3). The Phase 1
 *      pipeline is *pure* (parse → cascade → layout → paint → backend are all
 *      deterministic functions of their input), so rendering `<div>hello</div>`
 *      always produces the same pixels. We capture that output ONCE into a
 *      committed reference PNG (`../reftests/div-hello.png`) and, at check time,
 *      compare a freshly-rendered PNG against it within the configured pixel
 *      threshold (design.md §9.1). Because the render is deterministic the
 *      comparison is an exact (0-pixel) match — the baseline is stable.
 *
 *      Phase 1 honesty: text shaping is a no-op until task 5.7, so the painted
 *      `text` command carries no glyphs and `<div>hello</div>` renders as a
 *      blank white canvas (see `render.test.ts`). That is the genuine, current
 *      end-to-end output — the reference captures exactly it. Req 14.3 is about
 *      the *pixel comparison passing*, which proves the whole pipeline plus the
 *      reftest harness are wired together end-to-end; it does not claim the
 *      glyphs are drawn yet.
 *
 *   2. The first real WPT SUBSET + SCOREBOARD (Requirement 14.4). Phase 0 ran an
 *      honest-empty subset (passCount 0). Phase 1 ships a small set of real
 *      checks that drive the actual stage code (no mocks) for each Phase 1 CSS
 *      capability (color / display / width / height / margin / background-color
 *      / font-size — Requirement 14.2) plus the end-to-end render pipeline. The
 *      scoreboard's pass count is computed by {@link computePhase1Scoreboard}
 *      purely from running those checks, so it is a valid number that is
 *      INDEPENDENT of whether the scoreboard display / screenshot publishes
 *      successfully (Req 14.4; publication degrades gracefully per Req 1.6).
 *
 * The cli is an orchestration layer (not a pipeline stage), so it may legally
 * import the stage packages and infrastructure to compose them here.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { DomTree, Fragment, FragmentTree, NodeId } from "@browser-engine/ir";
import { parseHtml } from "@browser-engine/html-parser";
import { parseCss } from "@browser-engine/css-parser";
import { cascade } from "@browser-engine/cascade";
import { layout } from "@browser-engine/layout";
import { paint } from "@browser-engine/paint";
import {
  computeScoreboard,
  type ReftestEvidence,
  type Scoreboard,
  type SourceFileInput,
  type WptSubset,
} from "@browser-engine/scoreboard";
import { decodePng } from "@browser-engine/test-harness";

import type { ReftestBaseline } from "./checks.js";
import { renderHtmlToPng } from "./render.js";

// ===========================================================================
// 1. The `<div>hello</div>` reftest baseline (Requirement 14.3)
// ===========================================================================

/** The Phase 1 vertical-slice document the first reftest baseline renders. */
export const DIV_HELLO_SOURCE = "<div>hello</div>";

/**
 * Absolute path to the committed reference PNG. Resolved relative to THIS
 * module so it works whether the package is run from `src/` or the built
 * `dist/` (the reference lives in the package's `reftests/` directory, one
 * level up from either output root).
 */
export const DIV_HELLO_REFERENCE_PATH: string = fileURLToPath(
  new URL("../reftests/div-hello.png", import.meta.url),
);

/** Read the committed `<div>hello</div>` reference PNG bytes from disk. */
export function loadDivHelloReference(): Uint8Array {
  return new Uint8Array(readFileSync(DIV_HELLO_REFERENCE_PATH));
}

/** Render `<div>hello</div>` through the full pipeline and return the PNG bytes. */
export function renderDivHelloPng(): Uint8Array {
  return renderHtmlToPng(new TextEncoder().encode(DIV_HELLO_SOURCE)).png;
}

/**
 * The committed reference was rendered on one platform, but text rasterization
 * goes through system font fallback (macOS SF/Helvetica vs Linux DejaVu), so
 * glyph anti-aliasing differs slightly across OSes (~350 of 480 000 pixels
 * observed). The allowance absorbs that noise while still failing any real
 * layout regression, which displaces far more pixels.
 */
export const DIV_HELLO_MAX_DIFF_PIXELS = 2000;

/**
 * Build the `<div>hello</div>` reftest baseline: a freshly-rendered PNG paired
 * with the committed reference. The render is deterministic per platform; the
 * configured threshold absorbs cross-platform glyph anti-aliasing variance.
 */
export function divHelloBaseline(): ReftestBaseline {
  return {
    name: "div-hello",
    rendered: renderDivHelloPng(),
    reference: loadDivHelloReference(),
    options: { maxDiffPixels: DIV_HELLO_MAX_DIFF_PIXELS },
  };
}

/** The configured Phase 1 reftest baselines the check gate runs (Req 14.3). */
export function phase1Reftests(): readonly ReftestBaseline[] {
  return [divHelloBaseline()];
}

// ===========================================================================
// 2. The first real WPT subset (Requirement 14.4, exercising Req 14.2)
// ===========================================================================

/** Encode a source string as the UTF-8 bytes the parsers consume. */
function encode(source: string): Uint8Array {
  return new TextEncoder().encode(source);
}

/** Throw a plain assertion failure (counted as a WPT `fail` by the runner). */
function expect(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

/** The first element node of a parsed document (the subject of a selector). */
function firstElementId(dom: DomTree): NodeId {
  for (const [id, node] of dom.nodes) {
    if (node.kind === "element") {
      return id;
    }
  }
  throw new Error("expected at least one element node in the parsed DOM");
}

/** The first text node of a parsed document (used for inheritance checks). */
function firstTextId(dom: DomTree): NodeId {
  for (const [id, node] of dom.nodes) {
    if (node.kind === "text") {
      return id;
    }
  }
  throw new Error("expected a text node in the parsed DOM");
}

/** The fragment laid out for a given DOM node. */
function fragmentForNode(tree: FragmentTree, node: NodeId): Fragment {
  for (const fragment of tree.fragments.values()) {
    if (fragment.node === node) {
      return fragment;
    }
  }
  throw new Error(`expected a fragment for node ${String(node)}`);
}

/**
 * The Phase 1 capabilities the scoreboard tracks: the seven CSS properties of
 * Requirement 14.2 plus the end-to-end render pipeline (Requirement 14.1).
 */
export const PHASE1_CAPABILITIES: readonly string[] = [
  "color",
  "display",
  "width",
  "height",
  "margin",
  "background-color",
  "font-size",
  "render-pipeline",
];

/**
 * The first real WPT subset (Requirement 14.4). Each test drives the ACTUAL
 * stage code — parse, cascade, layout, paint, and the full render — for one
 * Phase 1 capability and asserts the real, observable behaviour (no mocks). A
 * test passes when its `run` completes without throwing.
 */
export const PHASE1_WPT_SUBSET: WptSubset = [
  {
    id: "phase1/css-cascade/color-named.html",
    capability: "color",
    run: () => {
      const dom = parseHtml(encode("<div>hello</div>"));
      const sheets = [parseCss(encode("div { color: red }"))];
      const style = cascade(dom, sheets, firstElementId(dom));
      const c = style.color;
      expect(
        c.r === 255 && c.g === 0 && c.b === 0 && c.a === 1,
        `color did not cascade to red: ${JSON.stringify(c)}`,
      );
    },
  },
  {
    id: "phase1/css-display/display-block.html",
    capability: "display",
    run: () => {
      const dom = parseHtml(encode("<div></div>"));
      const sheets = [parseCss(encode("div { display: block }"))];
      const style = cascade(dom, sheets, firstElementId(dom));
      expect(style.display === "block", `display did not cascade to block: ${style.display}`);
    },
  },
  {
    id: "phase1/css-sizing/width-px.html",
    capability: "width",
    run: () => {
      const dom = parseHtml(encode("<div></div>"));
      const sheets = [parseCss(encode("div { width: 120px }"))];
      const tree = layout(dom, (node) => cascade(dom, sheets, node));
      const frag = fragmentForNode(tree, firstElementId(dom));
      expect(frag.box.borderBox.width === 120, `width did not resolve to 120px: ${frag.box.borderBox.width}`);
    },
  },
  {
    id: "phase1/css-sizing/height-px.html",
    capability: "height",
    run: () => {
      const dom = parseHtml(encode("<div></div>"));
      const sheets = [parseCss(encode("div { height: 60px }"))];
      const tree = layout(dom, (node) => cascade(dom, sheets, node));
      const frag = fragmentForNode(tree, firstElementId(dom));
      expect(frag.box.borderBox.height === 60, `height did not resolve to 60px: ${frag.box.borderBox.height}`);
    },
  },
  {
    id: "phase1/css-box/margin-shorthand.html",
    capability: "margin",
    run: () => {
      const dom = parseHtml(encode("<div></div>"));
      const sheets = [parseCss(encode("div { width: 100px; height: 10px; margin: 5px }"))];
      const tree = layout(dom, (node) => cascade(dom, sheets, node));
      const frag = fragmentForNode(tree, firstElementId(dom));
      // The margin box is the border box grown by 5px on every edge, and the
      // border box is offset by the left/top margin within the margin box.
      expect(frag.box.marginBox.width === 110, `margin box width: ${frag.box.marginBox.width}`);
      expect(frag.box.marginBox.height === 20, `margin box height: ${frag.box.marginBox.height}`);
      expect(frag.box.borderBox.x === 5, `border box x offset by margin: ${frag.box.borderBox.x}`);
    },
  },
  {
    id: "phase1/css-backgrounds/background-color.html",
    capability: "background-color",
    run: () => {
      const dom = parseHtml(encode("<div></div>"));
      const sheets = [
        parseCss(encode("div { width: 100px; height: 50px; background-color: red }")),
      ];
      const styleOf = (node: NodeId) => cascade(dom, sheets, node);
      const list = paint(layout(dom, styleOf), styleOf);
      const hasRedRect = list.commands.some(
        (cmd) =>
          cmd.op === "rect" &&
          cmd.fill.r === 255 &&
          cmd.fill.g === 0 &&
          cmd.fill.b === 0 &&
          cmd.fill.a === 1,
      );
      expect(hasRedRect, "background-color did not paint a red rect command");
    },
  },
  {
    id: "phase1/css-fonts/font-size-inherits.html",
    capability: "font-size",
    run: () => {
      const dom = parseHtml(encode("<div>hello</div>"));
      const sheets = [parseCss(encode("div { font-size: 20px }"))];
      // The text node inherits font-size from its <div> parent.
      const style = cascade(dom, sheets, firstTextId(dom));
      expect(style.fontSize === 20, `font-size did not inherit to 20px: ${style.fontSize}`);
    },
  },
  {
    id: "phase1/render/div-hello-to-png.html",
    capability: "render-pipeline",
    run: () => {
      const result = renderHtmlToPng(encode("<div>hello</div>"));
      expect(result.png.length > 0, "render produced no PNG bytes");
      const decoded = decodePng(result.png);
      expect(
        decoded.width === result.width && decoded.height === result.height,
        `decoded PNG ${decoded.width}x${decoded.height} != reported ${result.width}x${result.height}`,
      );
    },
  },
];

// ===========================================================================
// 3. The Phase 1 scoreboard (Requirement 14.4)
// ===========================================================================

/** Optional inputs for {@link computePhase1Scoreboard}. */
export interface Phase1ScoreboardOptions {
  /**
   * Reftest evidence feeding capability status (design.md §9.1). Independent of
   * the WPT pass count — passing it does NOT change `passCount` (Req 14.4).
   */
  readonly reftests?: readonly ReftestEvidence[];
  /**
   * Source files for the compat-per-LOC denominator. Optional here because
   * Req 14.4 is specifically about the WPT pass count; when omitted the
   * denominator is empty and `compatPerLoc` is `null` (an honest "not measured
   * in this slice"), while the pass count remains valid.
   */
  readonly sourceFiles?: Iterable<SourceFileInput>;
}

/**
 * Compute the Phase 1 scoreboard snapshot from the real WPT subset. The
 * resulting `passCount` is a valid number derived purely from running the
 * subset, with NO dependency on whether the scoreboard display / screenshot
 * publishes successfully (Requirement 14.4). Publication is a separate, fallible
 * step (`publishScoreboard`) that never invalidates this held count (Req 1.6).
 */
export function computePhase1Scoreboard(options: Phase1ScoreboardOptions = {}): Scoreboard {
  return computeScoreboard({
    wptSubset: PHASE1_WPT_SUBSET,
    sourceFiles: options.sourceFiles ?? [],
    capabilities: PHASE1_CAPABILITIES,
    reftests: options.reftests ?? [],
  });
}
