/**
 * The `render <html> -o out.png` command (task 3.11; Requirement 14.1).
 *
 * This is the wiring layer's *end-to-end* entry point: it drives the FULL
 * pipeline parse → cascade → layout → paint → **backend** for a supported
 * minimal document and writes a PNG screenshot.
 *
 *     SourceBytes (input)         ── seed the document's raw bytes
 *        │
 *        ▼  qPaint (parse → cascade → layout → paint)
 *     DisplayList  ── the backend-agnostic abstract paint commands (§8.6)
 *        │
 *        ▼  ScreenshotBackend.render(list, surface)
 *     Surface      ── an RGBA pixel buffer (the backend's ONLY output target)
 *        │
 *        ▼  encodeSurfaceToPng
 *     PNG bytes    ── written to the `-o` output path
 *
 * The cli is an orchestration layer (not a stage), so it may legally import the
 * stage packages AND the backend to wire them together. Crucially, the backend
 * receives ONLY the `DisplayList` + a `Surface` — never an upstream IR handle —
 * so the Requirement 3.5 "backend reads rendering data exclusively through the
 * DisplayList" boundary holds end-to-end.
 *
 * Phase 1 reuse boundary (Requirement 8.1): the screenshot backend is a minimal
 * self-built software rasterizer; integrating a production Skia/FreeType backend
 * is later work and changes nothing in this wiring (design.md §14 keeps the
 * default backend an open question).
 */
import { writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";

import type { DisplayList, NodeId, Rect } from "@browser-engine/ir";
import { NaiveDb } from "@browser-engine/kernel";
import { parseHtml } from "@browser-engine/html-parser";
import { cascade } from "@browser-engine/cascade";
import { layout } from "@browser-engine/layout";
import { paint } from "@browser-engine/paint";
import { encodeSurfaceToPng, renderDisplayListOnGpu } from "@browser-engine/backend";

import { qPaint, SourceBytes, type Url } from "./pipeline.js";
import { documentStylesheets } from "./stylesheets.js";
import { collectImages } from "./images.js";
import { cacheLoader, defaultFetch, loadResources, type FetchFn } from "./loader.js";
import { pipelineGlyphSource, pipelineShaper } from "./fonts.js";

/**
 * The default screenshot canvas size, in device pixels. Phase 1 has no viewport
 * query plumbed into the DisplayList, so the surface is sized to fit the painted
 * content (see {@link surfaceSizeFor}) but never smaller than this, matching the
 * layout engine's 800px default viewport width.
 */
export const DEFAULT_CANVAS_WIDTH = 800;
/** The default canvas height when the document paints nothing tall. */
export const DEFAULT_CANVAS_HEIGHT = 600;

/** Result of an in-memory render: the PNG bytes plus the surface dimensions. */
export interface RenderResult {
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/**
 * Run the full pipeline for `htmlBytes` and return the rendered PNG + its size.
 * Pure with respect to the filesystem (no reads/writes) so tests can call it
 * directly instead of spawning a process.
 *
 * @param htmlBytes the document's raw source bytes (seeded as `SourceBytes`).
 * @param url the document address / cache key (defaults to `render://input`).
 */
export function renderHtmlToPng(htmlBytes: Uint8Array, url: Url = "render://input"): RenderResult {
  // 1. Seed the pipeline's sole leaf input and drive parse → … → paint.
  const db = new NaiveDb();
  db.setInput(SourceBytes, url, htmlBytes);
  const displayList = db.query(qPaint, url);

  // 2. Render the WHOLE DisplayList through the GPU compositor (every paint op
  //    — rects/borders/text/images/clips/layers — becomes GPU commands).
  const { width, height } = surfaceSizeFor(displayList);
  const surface = renderDisplayListOnGpu(displayList, width, height, pipelineGlyphSource);

  // 3. Encode the rendered pixels to PNG bytes.
  const png = encodeSurfaceToPng(surface);
  return { png, width: surface.width, height: surface.height };
}

/**
 * Render a document fetched from a real URL (M2.3). The async resource phase
 * runs first — fetch the root HTML, then fetch its external subresources
 * (`<link rel=stylesheet>`, `<img>`) into a cache — after which the pure,
 * synchronous pipeline (parse → collect → cascade → layout → paint) renders the
 * document with the cache-backed loaders supplying the fetched bytes. A failed
 * fetch is graceful (the resource is absent, the document renders without it).
 *
 * @param url the document URL to fetch and render (the resolution base).
 * @param fetchFn injectable fetch (defaults to Node's global `fetch`); tests
 *   pass a deterministic stub.
 * @throws Error only if the ROOT document itself cannot be fetched (there is
 *   nothing to render); subresource failures are non-fatal.
 */
export async function renderUrlToPng(
  url: string,
  fetchFn: FetchFn = defaultFetch,
): Promise<RenderResult> {
  const rootBytes = await fetchFn(url);
  if (rootBytes === undefined) {
    throw new Error(`render: failed to fetch the document at ${url}`);
  }

  // Parse, then fetch the document's external subresources into a cache.
  const dom = parseHtml(rootBytes);
  const cache = await loadResources(dom, url, fetchFn);
  const load = cacheLoader(cache, url);

  // Drive the pure synchronous pipeline with cache-backed loaders. (The async
  // URL path composes the stages directly rather than via the kernel queries,
  // which take only `SourceBytes`; incremental URL rendering is later work.)
  const sheets = documentStylesheets(dom, load);
  const styleOf = (node: NodeId) => cascade(dom, sheets, node);
  const images = collectImages(dom, load);
  const displayList = paint(layout(dom, styleOf, { shaper: pipelineShaper }), styleOf, (node) => images.get(node));

  const { width, height } = surfaceSizeFor(displayList);
  const surface = renderDisplayListOnGpu(displayList, width, height, pipelineGlyphSource);
  return { png: encodeSurfaceToPng(surface), width: surface.width, height: surface.height };
}


export function renderFileToPng(inputPath: string, outputPath: string): RenderResult {
  const htmlBytes = new Uint8Array(readFileSync(inputPath));
  const result = renderHtmlToPng(htmlBytes, `file://${inputPath}`);
  writeFileSync(outputPath, result.png);
  return result;
}

/**
 * Compute a canvas size that contains every painted command's bounds. Phase 1
 * does not thread a viewport size into the DisplayList, so we take the union of
 * all command rectangles (and text origins) and pad to the default canvas size,
 * guaranteeing a non-trivial image even for a tiny document.
 */
export function surfaceSizeFor(list: DisplayList): { width: number; height: number } {
  let maxX = 0;
  let maxY = 0;
  const extend = (rect: Rect): void => {
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  };
  for (const cmd of list.commands) {
    switch (cmd.op) {
      case "rect":
      case "border":
      case "image":
      case "push-clip":
        extend(cmd.rect);
        break;
      case "text":
        maxX = Math.max(maxX, cmd.at.x);
        maxY = Math.max(maxY, cmd.at.y);
        break;
      case "pop-clip":
      case "push-layer":
      case "pop-layer":
        break;
    }
  }
  return {
    width: Math.max(DEFAULT_CANVAS_WIDTH, Math.ceil(maxX)),
    height: Math.max(DEFAULT_CANVAS_HEIGHT, Math.ceil(maxY)),
  };
}

/** Parsed `render` command arguments. */
interface RenderArgs {
  readonly input: string;
  readonly output: string;
}

/**
 * Parse `render <input> -o <output>` argv (the slice after the `render`
 * subcommand). Accepts `-o`/`--output` before or after the positional input.
 *
 * @throws Error if the input or output argument is missing.
 */
export function parseRenderArgs(argv: readonly string[]): RenderArgs {
  let input: string | undefined;
  let output: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-o" || arg === "--output") {
      output = argv[i + 1];
      i += 1;
    } else if (arg !== undefined && !arg.startsWith("-")) {
      input ??= arg;
    }
  }
  if (input === undefined) {
    throw new Error("render: missing <input.html> argument (usage: render <input.html> -o <out.png>)");
  }
  if (output === undefined) {
    throw new Error("render: missing -o <out.png> argument (usage: render <input.html> -o <out.png>)");
  }
  return { input, output };
}

/**
 * Run the `render` subcommand from CLI argv (the slice after `render`). Reads
 * the input file, renders it, writes the PNG, and prints a one-line summary.
 * Returns the process exit code (0 on success, 1 on a usage/IO error).
 */
export async function runRender(argv: readonly string[]): Promise<number> {
  let args: RenderArgs;
  try {
    args = parseRenderArgs(argv);
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  try {
    const isUrl = /^https?:\/\//i.test(args.input);
    let result: RenderResult;
    if (isUrl) {
      // Fetch the document (and its subresources) from the network, then render.
      result = await renderUrlToPng(args.input);
      writeFileSync(args.output, result.png);
    } else {
      result = renderFileToPng(args.input, args.output);
    }
    console.log(
      `rendered ${args.input} → ${args.output} (${result.width}x${result.height}, ${result.png.length} bytes)`,
    );
    return 0;
  } catch (error: unknown) {
    console.error(`render failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
