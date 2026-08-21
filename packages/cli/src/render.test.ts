/**
 * Integration tests for the `render <html> -o out.png` command (task 3.11).
 *
 * Built by `tsc` then run with: `node --test packages/cli/dist/*.test.js`.
 *
 * These drive the FULL pipeline parse → cascade → layout → paint → backend for
 * the Phase 1 minimal document `<div>hello</div>` and assert it produces a real,
 * decodable PNG (Requirement 14.1). The backend consumes ONLY the DisplayList +
 * a Surface (Requirement 3.5) — verified end-to-end here by the fact that the
 * render path hands it nothing else.
 *
 * The decode/round-trip side uses the reftest harness's `decodePng` — the cli is
 * an orchestration layer, so it may import infrastructure packages freely.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { decodePng } from "@browser-engine/test-harness";

import {
  renderHtmlToPng,
  renderFileToPng,
  surfaceSizeFor,
  parseRenderArgs,
  formatStageTrace,
  formatResourceTrace,
  runRender,
  DEFAULT_CANVAS_WIDTH,
  DEFAULT_CANVAS_HEIGHT,
} from "./render.js";

const HELLO = new TextEncoder().encode("<div>hello</div>");

void test("Req 14.1: <div>hello</div> renders through the full pipeline to a valid PNG", () => {
  const result = renderHtmlToPng(HELLO);

  // A non-trivial PNG: bytes produced, sensible default canvas dimensions.
  assert.ok(result.png.length > 0, "render must produce PNG bytes");
  assert.equal(result.width, DEFAULT_CANVAS_WIDTH);
  assert.equal(result.height, DEFAULT_CANVAS_HEIGHT);

  // The bytes are a real, decodable PNG of the reported size (round-trips
  // through the independent reftest decoder).
  const decoded = decodePng(result.png);
  assert.equal(decoded.width, DEFAULT_CANVAS_WIDTH);
  assert.equal(decoded.height, DEFAULT_CANVAS_HEIGHT);
  assert.equal(decoded.data.length, DEFAULT_CANVAS_WIDTH * DEFAULT_CANVAS_HEIGHT * 4);
});

void test("<div>hello</div> now renders VISIBLE text (real glyph rasterization, no longer a no-op)", () => {
  // Text rendering has landed: the DisplayList for `<div>hello</div>` carries a
  // `text` command with real positioned glyphs (built-in bitmap font), and the
  // backend rasterizes their coverage in the computed `color` (black). So the
  // screenshot is NO LONGER an all-white canvas — it contains inked (non-white)
  // pixels where the glyphs are drawn. We assert there is at least some ink, and
  // that the canvas is not entirely black either (text is sparse on white).
  const decoded = decodePng(renderHtmlToPng(HELLO).png);
  let inked = 0;
  for (let i = 0; i < decoded.data.length; i += 4) {
    const r = decoded.data[i] ?? 255;
    const g = decoded.data[i + 1] ?? 255;
    const b = decoded.data[i + 2] ?? 255;
    if (r < 128 && g < 128 && b < 128) inked += 1; // a dark (inked) pixel.
  }
  const totalPixels = decoded.data.length / 4;
  assert.ok(inked > 0, "the glyphs must rasterize at least some inked pixels");
  assert.ok(inked < totalPixels, "text is sparse — the canvas is not entirely inked");
});

void test("rendering is deterministic: same input ⇒ identical PNG bytes", () => {
  const a = renderHtmlToPng(HELLO);
  const b = renderHtmlToPng(HELLO);
  assert.deepEqual([...a.png], [...b.png]);
});

void test("stage tracing reports every render-pipeline query as measurable evidence", () => {
  const result = renderHtmlToPng(HELLO, "render://trace", { trace: true });
  const trace = result.trace;
  assert.ok(trace !== undefined, "trace option must attach a StageTrace");

  const byStage = new Map(trace.summaries.map((summary) => [summary.stage, summary]));
  for (const stage of ["qDom", "qSheets", "qComputed", "qLayout", "qPaint"]) {
    const summary = byStage.get(stage);
    assert.ok(summary !== undefined, `${stage} must appear in the render trace`);
    assert.ok(summary.calls > 0, `${stage} must have at least one observed call`);
    assert.equal(summary.recomputes, summary.calls, "NaiveDb render trace reports every call as a recompute");
    assert.ok(summary.totalDurationMs >= 0);
  }

  assert.ok(trace.totalCalls >= 5);
  assert.equal(trace.totalCacheHits, 0);
  assert.equal(trace.totalRecomputes, trace.totalCalls);
  assert.ok(trace.events.every((event) => event.cacheStatus === "miss"));
  const report = formatStageTrace(trace);
  assert.match(report, /stage trace:/);
  assert.match(report, /qDom/);
  assert.match(report, /qPaint/);
});

void test("formatResourceTrace reports URL resource-loading evidence", () => {
  const report = formatResourceTrace({
    url: "https://site.test/index.html",
    rootBytes: 123,
    discoveredResources: ["https://site.test/style.css", "https://site.test/pic.png"],
    loadedResources: ["https://site.test/pic.png"],
    missingResources: ["https://site.test/style.css"],
    loadedBytes: 42,
    stylesheetCount: 1,
    authorStylesheetCount: 0,
    authorRuleCount: 0,
    authorDeclarationCount: 0,
    decodedImageCount: 1,
    displayCommands: 3,
    imagePaintCount: 1,
    paintOps: ["image", "rect"],
  });
  assert.match(report, /resource trace:/);
  assert.match(report, /rootBytes=123/);
  assert.match(report, /discovered=2 loaded=1 missing=1 loadedBytes=42/);
  assert.match(report, /stylesheets=1 authorSheets=0 authorRules=0 authorDeclarations=0/);
  assert.match(report, /decodedImages=1 displayCommands=3 imagePaints=1/);
  assert.match(report, /paintOps=image,rect/);
});

void test("renderFileToPng reads HTML and writes a PNG to disk", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "be-render-"));
  try {
    const input = path.join(dir, "in.html");
    const output = path.join(dir, "out.png");
    writeFileSync(input, "<div>hello</div>");

    const result = renderFileToPng(input, output);
    const onDisk = new Uint8Array(readFileSync(output));

    assert.deepEqual([...onDisk], [...result.png], "written file matches returned bytes");
    const decoded = decodePng(onDisk);
    assert.equal(decoded.width, result.width);
    assert.equal(decoded.height, result.height);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("runRender writes a PNG and returns exit code 0 on success", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "be-render-cli-"));
  try {
    const input = path.join(dir, "in.html");
    const output = path.join(dir, "out.png");
    writeFileSync(input, "<div>hello</div>");

    const code = await runRender([input, "-o", output]);
    assert.equal(code, 0);

    const decoded = decodePng(new Uint8Array(readFileSync(output)));
    assert.equal(decoded.width, DEFAULT_CANVAS_WIDTH);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("runRender --trace prints the stage-trace evidence table", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "be-render-cli-trace-"));
  try {
    const input = path.join(dir, "in.html");
    const output = path.join(dir, "out.png");
    writeFileSync(input, "<div>hello</div>");

    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      const code = await runRender([input, "-o", output, "--trace"]);
      assert.equal(code, 0);
    } finally {
      console.log = original;
    }

    const out = lines.join("\n");
    assert.match(out, /rendered .*out\.png/);
    assert.match(out, /stage trace:/);
    assert.match(out, /qDom/);
    assert.match(out, /qSheets/);
    assert.match(out, /qComputed/);
    assert.match(out, /qLayout/);
    assert.match(out, /qPaint/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("runRender returns a non-zero exit code on missing arguments", async () => {
  assert.equal(await runRender([]), 1); // no input, no -o
  assert.equal(await runRender(["only-input.html"]), 1); // missing -o
});

void test("parseRenderArgs accepts -o before or after the positional input", () => {
  assert.deepEqual(parseRenderArgs(["a.html", "-o", "b.png"]), { input: "a.html", output: "b.png", trace: false });
  assert.deepEqual(parseRenderArgs(["-o", "b.png", "a.html"]), { input: "a.html", output: "b.png", trace: false });
  assert.deepEqual(parseRenderArgs(["--output", "b.png", "a.html"]), {
    input: "a.html",
    output: "b.png",
    trace: false,
  });
  assert.deepEqual(parseRenderArgs(["--trace", "a.html", "--output", "b.png"]), {
    input: "a.html",
    output: "b.png",
    trace: true,
  });
});

void test("parseRenderArgs rejects unknown render options", () => {
  assert.throws(() => parseRenderArgs(["a.html", "-o", "b.png", "--wat"]), /unknown option/);
});

void test("surfaceSizeFor pads to the default canvas and grows to fit painted content", () => {
  const emptyList = Object.freeze({ commands: Object.freeze([]) }) as never;
  assert.deepEqual(surfaceSizeFor(emptyList), {
    width: DEFAULT_CANVAS_WIDTH,
    height: DEFAULT_CANVAS_HEIGHT,
  });

  // A rect beyond the default bounds grows the surface to contain it.
  const bigList = Object.freeze({
    commands: Object.freeze([
      { op: "rect", rect: { x: 0, y: 0, width: 2000, height: 1000 }, fill: { r: 0, g: 0, b: 0, a: 1 } },
    ]),
  }) as never;
  assert.deepEqual(surfaceSizeFor(bigList), { width: 2000, height: 1000 });
});
