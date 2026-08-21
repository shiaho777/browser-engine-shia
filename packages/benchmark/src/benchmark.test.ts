/**
 * Tests for the Competitive Benchmark Scoreboard (compete-with-google-benchmark
 * spec; tasks 2.3, 3.3, 5.3, 6.2; Requirements 1-6 + Correctness Properties).
 *
 * Built by `tsc` then run with: `node --test packages/benchmark/dist/*.test.js`.
 *
 * Asserts the honesty rules mechanically:
 *   - live metrics are pure + correct (Property 1);
 *   - every competitor datum has a citation OR is needs-source (Property 2);
 *   - each dimension yields exactly one verdict with required rationale (Prop 3);
 *   - the report is deterministic (Property 4);
 *   - our performance number is never fabricated (Property 5).
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { SourceFileInput } from "@browser-engine/scoreboard";

import { COMPETITORS } from "./competitors.data.js";
import { computeLiveMetrics, isTestFile } from "./metrics.js";
import { evaluateDimensions } from "./dimensions.js";
import {
  buildBenchmarkJsonReport,
  buildSnapshot,
  omitRenderedPngBytes,
  renderBenchmarkJson,
  renderBenchmarkMarkdown,
  renderEvidenceDashboardHtml,
  type BenchmarkJsonReport,
} from "./report.js";
import { liveWptPassCount, BENCHMARK_SELF_TEST_SUBSET } from "./self-test.js";
import { collectExecutionEvidence, type ExecutionEvidence } from "./evidence.js";

// ---------------------------------------------------------------------------
// Property 1 — live metrics are pure + correctly classified.
// ---------------------------------------------------------------------------

const SYNTHETIC: readonly SourceFileInput[] = [
  { path: "packages/x/src/a.ts", content: "const a = 1;\nconst b = 2;\n" }, // 2 hand-written
  { path: "packages/x/src/b.ts", content: "const c = 3;\n" }, // 1 hand-written
  { path: "packages/x/src/generated/g.ts", content: "// @generated\nconst g = 0;\n" }, // generated (skip marker line is blank-trimmed? counts 2)
  { path: "packages/x/src/a.test.ts", content: "test('x', () => {});\nassert(true);\n" }, // test
];

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const EVIDENCE: ExecutionEvidence = {
  subsetCount: 2,
  files: 6,
  subtests: 17,
  passed: 17,
  failed: 0,
  errored: 0,
  queryCalls: 503,
  recomputes: 198,
  cacheHits: 305,
  verifiedCacheHits: 0,
  dependencyReads: 8000,
  tracedStages: ["qFineComputed", "qFineLayout", "qFinePaint", "qFineSheets"],
  incrementalEdit: {
    scenario: "synthetic",
    documentNodes: 45,
    editedNode: "#n20",
    paintOnlyReusedLayout: true,
    layoutEditRecomputedLayout: true,
    noMutationRecomputes: 0,
    queryCalls: 42,
    recomputes: 9,
    cacheHits: 33,
    verifiedCacheHits: 7,
    dependencyReads: 321,
    tracedStages: ["qFineComputed", "qFineLayout", "qFineLayoutStyle", "qFinePaint", "qFineSheets"],
    steps: [
      {
        name: "paint-only-edit",
        queryCalls: 18,
        recomputes: 4,
        cacheHits: 14,
        verifiedCacheHits: 5,
        dependencyReads: 123,
        tracedStages: ["qFineComputed", "qFineLayout", "qFinePaint"],
      },
      {
        name: "no-mutation-render",
        queryCalls: 1,
        recomputes: 0,
        cacheHits: 1,
        verifiedCacheHits: 0,
        dependencyReads: 4,
        tracedStages: ["qFinePaint"],
      },
    ],
  },
  scriptDrivenEdit: {
    scenario: "synthetic script",
    initialDocumentNodes: 8,
    finalDocumentNodes: 9,
    scriptMutations: 4,
    paintOnlyReusedLayout: true,
    layoutEditRecomputedLayout: true,
    appendChildIncreasedNodes: true,
    appendedNodePainted: true,
    queryCalls: 64,
    recomputes: 12,
    cacheHits: 52,
    verifiedCacheHits: 11,
    dependencyReads: 456,
    tracedStages: ["qFineComputed", "qFineLayout", "qFineLayoutStyle", "qFinePaint", "qFineSheets"],
    steps: [
      {
        name: "script-paint-only",
        mutations: 1,
        queryCalls: 21,
        recomputes: 4,
        cacheHits: 17,
        verifiedCacheHits: 6,
        dependencyReads: 144,
        tracedStages: ["qFineComputed", "qFineLayout", "qFinePaint"],
      },
      {
        name: "script-append-child",
        mutations: 3,
        queryCalls: 30,
        recomputes: 6,
        cacheHits: 24,
        verifiedCacheHits: 5,
        dependencyReads: 210,
        tracedStages: ["qFineComputed", "qFineLayout", "qFinePaint"],
      },
    ],
  },
  resourceLoadedPage: {
    url: "https://benchmark.test/index.html",
    rootBytes: 120,
    discoveredResources: 3,
    loadedResources: 2,
    missingResources: 1,
    loadedBytes: 77,
    stylesheetCount: 2,
    decodedImageCount: 1,
    displayCommands: 3,
    paintOps: ["image", "rect"],
    width: 800,
    height: 600,
    pngBytes: 3511,
    missingImage: {
      url: "https://benchmark.test/missing-image.html",
      discoveredResources: 1,
      loadedResources: 0,
      missingResources: 1,
      loadedBytes: 0,
      decodedImageCount: 0,
      paintedImage: false,
      displayCommands: 1,
      paintOps: ["text"],
      pngBytes: 3100,
    },
    invalidImage: {
      url: "https://benchmark.test/invalid-image.html",
      discoveredResources: 1,
      loadedResources: 1,
      missingResources: 0,
      loadedBytes: 9,
      decodedImageCount: 0,
      paintedImage: false,
      displayCommands: 1,
      paintOps: ["text"],
      pngBytes: 3100,
    },
    duplicateResource: {
      url: "https://benchmark.test/duplicate-resource.html",
      fetchCalls: 2,
      sharedResourceFetches: 1,
      discoveredResources: 1,
      loadedResources: 1,
      missingResources: 0,
      loadedBytes: 76,
      decodedImageCount: 2,
      paintedImageCount: 2,
      displayCommands: 2,
      paintOps: ["image"],
      pngBytes: 3200,
    },
    duplicateStylesheet: {
      url: "https://benchmark.test/duplicate-stylesheet.html",
      fetchCalls: 2,
      sharedStylesheetFetches: 1,
      discoveredResources: 1,
      loadedResources: 1,
      missingResources: 0,
      loadedBytes: 67,
      stylesheetCount: 4,
      authorStylesheetCount: 3,
      authorRuleCount: 3,
      authorDeclarationCount: 9,
      decodedImageCount: 0,
      paintedBackground: true,
      duplicateLinkWonSourceOrder: true,
      displayCommands: 1,
      paintOps: ["rect"],
      pngBytes: 3200,
    },
    dataUrlNoNetwork: {
      url: "https://benchmark.test/data-url-resource.html",
      fetchCalls: 1,
      discoveredResources: 0,
      loadedResources: 0,
      missingResources: 0,
      loadedBytes: 0,
      stylesheetCount: 2,
      decodedImageCount: 1,
      paintedImageCount: 1,
      paintedBackground: true,
      displayCommands: 2,
      paintOps: ["image", "rect"],
      pngBytes: 3200,
    },
    dataUrlStylesheetCharset: {
      percentUtf8: {
        url: "https://benchmark.test/data-url-charset-percent-stylesheet.html",
        metadata: "text/css;charset=utf-8",
        fetchCalls: 1,
        dataUrlFetchCalls: 0,
        discoveredResources: 0,
        loadedResources: 0,
        missingResources: 0,
        loadedBytes: 0,
        stylesheetCount: 2,
        authorStylesheetCount: 1,
        authorRuleCount: 1,
        authorDeclarationCount: 3,
        decodedImageCount: 0,
        paintedBackground: true,
        displayCommands: 2,
        paintOps: ["rect", "text"],
        pngBytes: 3200,
      },
      base64Utf8: {
        url: "https://benchmark.test/data-url-charset-base64-stylesheet.html",
        metadata: "text/css;charset=utf-8;base64",
        fetchCalls: 1,
        dataUrlFetchCalls: 0,
        discoveredResources: 0,
        loadedResources: 0,
        missingResources: 0,
        loadedBytes: 0,
        stylesheetCount: 2,
        authorStylesheetCount: 1,
        authorRuleCount: 1,
        authorDeclarationCount: 3,
        decodedImageCount: 0,
        paintedBackground: true,
        displayCommands: 2,
        paintOps: ["rect", "text"],
        pngBytes: 3200,
      },
      unsupportedCharset: {
        url: "https://benchmark.test/data-url-charset-unsupported-stylesheet.html",
        metadata: "text/css;charset=iso-8859-1",
        fetchCalls: 1,
        dataUrlFetchCalls: 0,
        discoveredResources: 0,
        loadedResources: 0,
        missingResources: 0,
        loadedBytes: 0,
        stylesheetCount: 1,
        authorStylesheetCount: 0,
        authorRuleCount: 0,
        authorDeclarationCount: 0,
        decodedImageCount: 0,
        paintedBackground: false,
        displayCommands: 1,
        paintOps: ["text"],
        pngBytes: 3100,
      },
    },
    dataUrlStylesheetSourceOrder: {
      externalAfterDataUrl: {
        url: "https://benchmark.test/data-url-before-external-stylesheet.html",
        externalStylesheetUrl: "https://benchmark.test/late.css",
        fetchCalls: 2,
        dataUrlFetchCalls: 0,
        externalStylesheetFetches: 1,
        discoveredResources: 1,
        loadedResources: 1,
        missingResources: 0,
        loadedBytes: 40,
        stylesheetCount: 3,
        authorStylesheetCount: 2,
        authorRuleCount: 2,
        authorDeclarationCount: 4,
        decodedImageCount: 0,
        paintedBackground: true,
        sourceOrderWinnerBlue: true,
        displayCommands: 1,
        paintOps: ["rect"],
        pngBytes: 3200,
      },
      dataUrlAfterExternal: {
        url: "https://benchmark.test/external-before-data-url-stylesheet.html",
        externalStylesheetUrl: "https://benchmark.test/early.css",
        fetchCalls: 2,
        dataUrlFetchCalls: 0,
        externalStylesheetFetches: 1,
        discoveredResources: 1,
        loadedResources: 1,
        missingResources: 0,
        loadedBytes: 67,
        stylesheetCount: 3,
        authorStylesheetCount: 2,
        authorRuleCount: 2,
        authorDeclarationCount: 4,
        decodedImageCount: 0,
        paintedBackground: true,
        sourceOrderWinnerBlue: true,
        displayCommands: 1,
        paintOps: ["rect"],
        pngBytes: 3200,
      },
    },
    externalInlineStylesheetSourceOrder: {
      inlineAfterExternal: {
        url: "https://benchmark.test/external-before-inline-stylesheet.html",
        externalStylesheetUrl: "https://benchmark.test/early.css",
        fetchCalls: 2,
        externalStylesheetFetches: 1,
        discoveredResources: 1,
        loadedResources: 1,
        missingResources: 0,
        loadedBytes: 67,
        stylesheetCount: 3,
        authorStylesheetCount: 2,
        authorRuleCount: 2,
        authorDeclarationCount: 4,
        decodedImageCount: 0,
        paintedBackground: true,
        sourceOrderWinnerBlue: true,
        displayCommands: 1,
        paintOps: ["rect"],
        pngBytes: 3200,
      },
      externalAfterInline: {
        url: "https://benchmark.test/inline-before-external-stylesheet.html",
        externalStylesheetUrl: "https://benchmark.test/late.css",
        fetchCalls: 2,
        externalStylesheetFetches: 1,
        discoveredResources: 1,
        loadedResources: 1,
        missingResources: 0,
        loadedBytes: 40,
        stylesheetCount: 3,
        authorStylesheetCount: 2,
        authorRuleCount: 2,
        authorDeclarationCount: 4,
        decodedImageCount: 0,
        paintedBackground: true,
        sourceOrderWinnerBlue: true,
        displayCommands: 1,
        paintOps: ["rect"],
        pngBytes: 3200,
      },
    },
    invalidDataImage: {
      url: "https://benchmark.test/invalid-data-image.html",
      fetchCalls: 1,
      discoveredResources: 0,
      loadedResources: 0,
      missingResources: 0,
      loadedBytes: 0,
      decodedImageCount: 0,
      paintedImageCount: 0,
      paintedBackground: true,
      displayCommands: 1,
      paintOps: ["rect"],
      pngBytes: 3200,
    },
    invalidDataStylesheet: {
      url: "https://benchmark.test/invalid-data-stylesheet.html",
      fetchCalls: 1,
      discoveredResources: 0,
      loadedResources: 0,
      missingResources: 0,
      loadedBytes: 0,
      stylesheetCount: 2,
      authorStylesheetCount: 1,
      authorRuleCount: 1,
      authorDeclarationCount: 0,
      decodedImageCount: 0,
      paintedBackground: false,
      displayCommands: 1,
      paintOps: ["text"],
      pngBytes: 3100,
    },
    nonCssDataStylesheet: {
      url: "https://benchmark.test/non-css-data-stylesheet.html",
      fetchCalls: 1,
      discoveredResources: 0,
      loadedResources: 0,
      missingResources: 0,
      loadedBytes: 0,
      stylesheetCount: 1,
      authorStylesheetCount: 0,
      authorRuleCount: 0,
      authorDeclarationCount: 0,
      decodedImageCount: 0,
      paintedBackground: false,
      displayCommands: 1,
      paintOps: ["text"],
      pngBytes: 3100,
    },
    noHrefStylesheet: {
      url: "https://benchmark.test/no-href-stylesheet.html",
      fetchCalls: 2,
      discoveredResources: 1,
      loadedResources: 1,
      missingResources: 0,
      loadedBytes: 67,
      stylesheetCount: 2,
      authorStylesheetCount: 1,
      authorRuleCount: 1,
      authorDeclarationCount: 3,
      decodedImageCount: 0,
      paintedBackground: true,
      displayCommands: 2,
      paintOps: ["rect", "text"],
      pngBytes: 3200,
    },
    emptyHrefStylesheet: {
      url: "https://benchmark.test/empty-href-stylesheet.html",
      fetchCalls: 2,
      discoveredResources: 1,
      loadedResources: 1,
      missingResources: 0,
      loadedBytes: 86,
      stylesheetCount: 2,
      authorStylesheetCount: 1,
      authorRuleCount: 0,
      authorDeclarationCount: 0,
      decodedImageCount: 0,
      paintedBackground: false,
      displayCommands: 1,
      paintOps: ["text"],
      pngBytes: 3100,
    },
    fragmentHrefStylesheet: {
      url: "https://benchmark.test/fragment-href-stylesheet.html",
      fetchCalls: 2,
      discoveredResources: 1,
      loadedResources: 1,
      missingResources: 0,
      loadedBytes: 92,
      stylesheetCount: 2,
      authorStylesheetCount: 1,
      authorRuleCount: 0,
      authorDeclarationCount: 0,
      decodedImageCount: 0,
      paintedBackground: false,
      displayCommands: 1,
      paintOps: ["text"],
      pngBytes: 3100,
    },
    queryHrefStylesheet: {
      url: "https://benchmark.test/query-href-stylesheet.html?old=1#frag",
      fetchCalls: 2,
      discoveredResources: 1,
      loadedResources: 1,
      missingResources: 0,
      loadedBytes: 92,
      stylesheetCount: 2,
      authorStylesheetCount: 1,
      authorRuleCount: 0,
      authorDeclarationCount: 0,
      decodedImageCount: 0,
      paintedBackground: false,
      displayCommands: 1,
      paintOps: ["text"],
      pngBytes: 3100,
    },
    protocolRelativeStylesheet: {
      url: "https://benchmark.test/protocol-relative-stylesheet.html",
      fetchCalls: 2,
      discoveredResources: 1,
      loadedResources: 1,
      missingResources: 0,
      loadedBytes: 67,
      stylesheetCount: 2,
      authorStylesheetCount: 1,
      authorRuleCount: 1,
      authorDeclarationCount: 3,
      decodedImageCount: 0,
      paintedBackground: true,
      displayCommands: 2,
      paintOps: ["rect", "text"],
      pngBytes: 3200,
    },
    whitespaceRelStylesheet: {
      url: "https://benchmark.test/whitespace-rel-stylesheet.html",
      fetchCalls: 3,
      discoveredResources: 2,
      loadedResources: 2,
      missingResources: 0,
      loadedBytes: 107,
      stylesheetCount: 3,
      authorStylesheetCount: 2,
      authorRuleCount: 2,
      authorDeclarationCount: 4,
      decodedImageCount: 0,
      paintedBackground: true,
      sourceOrderWinnerBlue: true,
      alternateFetchCalls: 1,
      alternateDiscoveredResources: 0,
      alternateLoadedResources: 0,
      alternateAuthorStylesheetCount: 0,
      alternatePaintedBackground: false,
      displayCommands: 2,
      paintOps: ["rect", "text"],
      pngBytes: 3200,
    },
    duplicateRelStylesheet: {
      url: "https://benchmark.test/duplicate-rel-stylesheet.html",
      fetchCalls: 3,
      discoveredResources: 2,
      loadedResources: 2,
      missingResources: 0,
      loadedBytes: 107,
      stylesheetCount: 3,
      authorStylesheetCount: 2,
      authorRuleCount: 2,
      authorDeclarationCount: 4,
      decodedImageCount: 0,
      paintedBackground: true,
      sourceOrderWinnerBlue: true,
      alternateFetchCalls: 1,
      alternateDiscoveredResources: 0,
      alternateLoadedResources: 0,
      alternateAuthorStylesheetCount: 0,
      alternatePaintedBackground: false,
      displayCommands: 2,
      paintOps: ["rect", "text"],
      pngBytes: 3200,
    },
    whitespaceHrefStylesheet: {
      url: "https://benchmark.test/whitespace-href-stylesheet.html",
      rawHref: " /early.css ",
      resolvedHref: "https://benchmark.test/early.css",
      loadedResourceUrl: "https://benchmark.test/early.css",
      fetchCalls: 3,
      discoveredResources: 2,
      loadedResources: 2,
      missingResources: 0,
      loadedBytes: 107,
      stylesheetCount: 3,
      authorStylesheetCount: 2,
      authorRuleCount: 2,
      authorDeclarationCount: 4,
      decodedImageCount: 0,
      paintedBackground: true,
      sourceOrderWinnerBlue: true,
      displayCommands: 2,
      paintOps: ["rect", "text"],
      pngBytes: 3200,
    },
    controlCharacterHrefStylesheet: {
      url: "https://benchmark.test/control-character-href-stylesheet.html",
      rawHref: "\n\t/early.css\f",
      rawHrefJson: "\"\\n\\t/early.css\\f\"",
      resolvedHref: "https://benchmark.test/early.css",
      loadedResourceUrl: "https://benchmark.test/early.css",
      fetchCalls: 3,
      discoveredResources: 2,
      loadedResources: 2,
      missingResources: 0,
      loadedBytes: 107,
      stylesheetCount: 3,
      authorStylesheetCount: 2,
      authorRuleCount: 2,
      authorDeclarationCount: 4,
      decodedImageCount: 0,
      paintedBackground: true,
      sourceOrderWinnerBlue: true,
      displayCommands: 2,
      paintOps: ["rect", "text"],
      pngBytes: 3200,
    },
    baseHrefSubresource: {
      url: "https://benchmark.test/pages/base-href-subresource.html",
      rawBaseHref: "https://cdn.benchmark.test/assets/",
      resolvedBaseHref: "https://cdn.benchmark.test/assets/",
      stylesheetHref: "css/theme.css",
      imageSrc: "img/pic.png",
      loadedStylesheetUrl: "https://cdn.benchmark.test/assets/css/theme.css",
      loadedImageUrl: "https://cdn.benchmark.test/assets/img/pic.png",
      fetchCalls: 3,
      stylesheetFetches: 1,
      imageFetches: 1,
      discoveredResources: 2,
      loadedResources: 2,
      missingResources: 0,
      loadedBytes: 174,
      stylesheetCount: 2,
      authorStylesheetCount: 1,
      authorRuleCount: 2,
      authorDeclarationCount: 5,
      decodedImageCount: 1,
      paintedBackground: true,
      paintedImageCount: 1,
      displayCommands: 2,
      paintOps: ["image", "rect"],
      pngBytes: 3200,
      paintedBackgroundRed: true,
      paintedImageBlue: true,
    },
    invalidUrlStylesheet: {
      url: "https://benchmark.test/invalid-url-stylesheet.html",
      fetchCalls: 2,
      discoveredResources: 1,
      loadedResources: 1,
      missingResources: 0,
      loadedBytes: 40,
      stylesheetCount: 3,
      authorStylesheetCount: 2,
      authorRuleCount: 2,
      authorDeclarationCount: 4,
      decodedImageCount: 0,
      paintedBackground: true,
      sourceOrderWinnerBlue: true,
      invalidOnlyFetchCalls: 1,
      invalidOnlyDiscoveredResources: 0,
      invalidOnlyLoadedResources: 0,
      invalidOnlyMissingResources: 0,
      invalidOnlyAuthorStylesheetCount: 0,
      invalidOnlyPaintedBackground: false,
      displayCommands: 2,
      paintOps: ["rect", "text"],
      pngBytes: 3200,
    },
    alternateStylesheet: {
      url: "https://benchmark.test/alternate-stylesheet.html",
      fetchCalls: 1,
      discoveredResources: 0,
      loadedResources: 0,
      missingResources: 0,
      loadedBytes: 0,
      stylesheetCount: 1,
      authorStylesheetCount: 0,
      authorRuleCount: 0,
      authorDeclarationCount: 0,
      decodedImageCount: 0,
      paintedBackground: false,
      displayCommands: 1,
      paintOps: ["text"],
      pngBytes: 3100,
    },
    disabledStylesheet: {
      url: "https://benchmark.test/disabled-stylesheet.html",
      fetchCalls: 1,
      discoveredResources: 0,
      loadedResources: 0,
      missingResources: 0,
      loadedBytes: 0,
      stylesheetCount: 1,
      authorStylesheetCount: 0,
      authorRuleCount: 0,
      authorDeclarationCount: 0,
      decodedImageCount: 0,
      paintedBackground: false,
      displayCommands: 1,
      paintOps: ["text"],
      pngBytes: 3100,
    },
    printMediaStylesheet: {
      url: "https://benchmark.test/print-media-stylesheet.html",
      fetchCalls: 1,
      discoveredResources: 0,
      loadedResources: 0,
      missingResources: 0,
      loadedBytes: 0,
      stylesheetCount: 1,
      authorStylesheetCount: 0,
      authorRuleCount: 0,
      authorDeclarationCount: 0,
      decodedImageCount: 0,
      paintedBackground: false,
      displayCommands: 1,
      paintOps: ["text"],
      pngBytes: 3100,
    },
    stylesheetMediaList: {
      empty: {
        media: "",
        url: "https://benchmark.test/empty-media-media-stylesheet.html",
        fetchCalls: 2,
        discoveredResources: 1,
        loadedResources: 1,
        missingResources: 0,
        loadedBytes: 67,
        stylesheetCount: 2,
        authorStylesheetCount: 1,
        authorRuleCount: 1,
        authorDeclarationCount: 3,
        decodedImageCount: 0,
        paintedBackground: true,
        displayCommands: 2,
        paintOps: ["rect", "text"],
        pngBytes: 3200,
      },
      whitespaceOnly: {
        media: "   ",
        url: "https://benchmark.test/whitespace-only-media-media-stylesheet.html",
        fetchCalls: 2,
        discoveredResources: 1,
        loadedResources: 1,
        missingResources: 0,
        loadedBytes: 67,
        stylesheetCount: 2,
        authorStylesheetCount: 1,
        authorRuleCount: 1,
        authorDeclarationCount: 3,
        decodedImageCount: 0,
        paintedBackground: true,
        displayCommands: 2,
        paintOps: ["rect", "text"],
        pngBytes: 3200,
      },
      matchingList: {
        media: "print, screen",
        url: "https://benchmark.test/media-list-media-stylesheet.html",
        fetchCalls: 2,
        discoveredResources: 1,
        loadedResources: 1,
        missingResources: 0,
        loadedBytes: 67,
        stylesheetCount: 2,
        authorStylesheetCount: 1,
        authorRuleCount: 1,
        authorDeclarationCount: 3,
        decodedImageCount: 0,
        paintedBackground: true,
        displayCommands: 2,
        paintOps: ["rect", "text"],
        pngBytes: 3200,
      },
      spacedMatchingList: {
        media: " print , screen ",
        url: "https://benchmark.test/spaced-media-list-media-stylesheet.html",
        fetchCalls: 2,
        discoveredResources: 1,
        loadedResources: 1,
        missingResources: 0,
        loadedBytes: 67,
        stylesheetCount: 2,
        authorStylesheetCount: 1,
        authorRuleCount: 1,
        authorDeclarationCount: 3,
        decodedImageCount: 0,
        paintedBackground: true,
        displayCommands: 2,
        paintOps: ["rect", "text"],
        pngBytes: 3200,
      },
      emptyItemBeforeScreen: {
        media: ", screen",
        url: "https://benchmark.test/empty-item-before-screen-media-stylesheet.html",
        fetchCalls: 2,
        discoveredResources: 1,
        loadedResources: 1,
        missingResources: 0,
        loadedBytes: 67,
        stylesheetCount: 2,
        authorStylesheetCount: 1,
        authorRuleCount: 1,
        authorDeclarationCount: 3,
        decodedImageCount: 0,
        paintedBackground: true,
        displayCommands: 2,
        paintOps: ["rect", "text"],
        pngBytes: 3200,
      },
      emptyItemAfterScreen: {
        media: "screen,",
        url: "https://benchmark.test/empty-item-after-screen-media-stylesheet.html",
        fetchCalls: 2,
        discoveredResources: 1,
        loadedResources: 1,
        missingResources: 0,
        loadedBytes: 67,
        stylesheetCount: 2,
        authorStylesheetCount: 1,
        authorRuleCount: 1,
        authorDeclarationCount: 3,
        decodedImageCount: 0,
        paintedBackground: true,
        displayCommands: 2,
        paintOps: ["rect", "text"],
        pngBytes: 3200,
      },
      emptyItemsOnly: {
        media: ",",
        url: "https://benchmark.test/empty-items-only-media-stylesheet.html",
        fetchCalls: 1,
        discoveredResources: 0,
        loadedResources: 0,
        missingResources: 0,
        loadedBytes: 0,
        stylesheetCount: 1,
        authorStylesheetCount: 0,
        authorRuleCount: 0,
        authorDeclarationCount: 0,
        decodedImageCount: 0,
        paintedBackground: false,
        displayCommands: 1,
        paintOps: ["text"],
        pngBytes: 3100,
      },
      unsupportedThenScreen: {
        media: "(dynamic-range: high), screen",
        url: "https://benchmark.test/unsupported-media-list-then-screen-media-stylesheet.html",
        fetchCalls: 2,
        discoveredResources: 1,
        loadedResources: 1,
        missingResources: 0,
        loadedBytes: 67,
        stylesheetCount: 2,
        authorStylesheetCount: 1,
        authorRuleCount: 1,
        authorDeclarationCount: 3,
        decodedImageCount: 0,
        paintedBackground: true,
        displayCommands: 2,
        paintOps: ["rect", "text"],
        pngBytes: 3200,
      },
      unsupportedOnly: {
        media: "(dynamic-range: high)",
        url: "https://benchmark.test/unsupported-media-list-only-media-stylesheet.html",
        fetchCalls: 1,
        discoveredResources: 0,
        loadedResources: 0,
        missingResources: 0,
        loadedBytes: 0,
        stylesheetCount: 1,
        authorStylesheetCount: 0,
        authorRuleCount: 0,
        authorDeclarationCount: 0,
        decodedImageCount: 0,
        paintedBackground: false,
        displayCommands: 1,
        paintOps: ["text"],
        pngBytes: 3100,
      },
      unknownTypeThenScreen: {
        media: "projection, screen",
        url: "https://benchmark.test/unknown-media-type-then-screen-media-stylesheet.html",
        fetchCalls: 2,
        discoveredResources: 1,
        loadedResources: 1,
        missingResources: 0,
        loadedBytes: 67,
        stylesheetCount: 2,
        authorStylesheetCount: 1,
        authorRuleCount: 1,
        authorDeclarationCount: 3,
        decodedImageCount: 0,
        paintedBackground: true,
        displayCommands: 2,
        paintOps: ["rect", "text"],
        pngBytes: 3200,
      },
      unknownTypeOnly: {
        media: "projection",
        url: "https://benchmark.test/unknown-media-type-only-media-stylesheet.html",
        fetchCalls: 1,
        discoveredResources: 0,
        loadedResources: 0,
        missingResources: 0,
        loadedBytes: 0,
        stylesheetCount: 1,
        authorStylesheetCount: 0,
        authorRuleCount: 0,
        authorDeclarationCount: 0,
        decodedImageCount: 0,
        paintedBackground: false,
        displayCommands: 1,
        paintOps: ["text"],
        pngBytes: 3100,
      },
      uppercaseScreen: {
        media: "SCREEN",
        url: "https://benchmark.test/uppercase-screen-media-stylesheet.html",
        fetchCalls: 2,
        discoveredResources: 1,
        loadedResources: 1,
        missingResources: 0,
        loadedBytes: 67,
        stylesheetCount: 2,
        authorStylesheetCount: 1,
        authorRuleCount: 1,
        authorDeclarationCount: 3,
        decodedImageCount: 0,
        paintedBackground: true,
        displayCommands: 2,
        paintOps: ["rect", "text"],
        pngBytes: 3200,
      },
      mixedCaseOnlyScreen: {
        media: "Only Screen",
        url: "https://benchmark.test/mixed-case-only-screen-media-stylesheet.html",
        fetchCalls: 2,
        discoveredResources: 1,
        loadedResources: 1,
        missingResources: 0,
        loadedBytes: 67,
        stylesheetCount: 2,
        authorStylesheetCount: 1,
        authorRuleCount: 1,
        authorDeclarationCount: 3,
        decodedImageCount: 0,
        paintedBackground: true,
        displayCommands: 2,
        paintOps: ["rect", "text"],
        pngBytes: 3200,
      },
      spacedOnlyScreen: {
        media: "only   screen",
        url: "https://benchmark.test/spaced-only-screen-media-stylesheet.html",
        fetchCalls: 2,
        discoveredResources: 1,
        loadedResources: 1,
        missingResources: 0,
        loadedBytes: 67,
        stylesheetCount: 2,
        authorStylesheetCount: 1,
        authorRuleCount: 1,
        authorDeclarationCount: 3,
        decodedImageCount: 0,
        paintedBackground: true,
        displayCommands: 2,
        paintOps: ["rect", "text"],
        pngBytes: 3200,
      },
      uppercasePrint: {
        media: "PRINT",
        url: "https://benchmark.test/uppercase-print-media-stylesheet.html",
        fetchCalls: 1,
        discoveredResources: 0,
        loadedResources: 0,
        missingResources: 0,
        loadedBytes: 0,
        stylesheetCount: 1,
        authorStylesheetCount: 0,
        authorRuleCount: 0,
        authorDeclarationCount: 0,
        decodedImageCount: 0,
        paintedBackground: false,
        displayCommands: 1,
        paintOps: ["text"],
        pngBytes: 3100,
      },
      all: {
        media: "all",
        url: "https://benchmark.test/all-media-stylesheet.html",
        fetchCalls: 2,
        discoveredResources: 1,
        loadedResources: 1,
        missingResources: 0,
        loadedBytes: 67,
        stylesheetCount: 2,
        authorStylesheetCount: 1,
        authorRuleCount: 1,
        authorDeclarationCount: 3,
        decodedImageCount: 0,
        paintedBackground: true,
        displayCommands: 2,
        paintOps: ["rect", "text"],
        pngBytes: 3200,
      },
      onlyAll: {
        media: "only all",
        url: "https://benchmark.test/only-all-media-stylesheet.html",
        fetchCalls: 2,
        discoveredResources: 1,
        loadedResources: 1,
        missingResources: 0,
        loadedBytes: 67,
        stylesheetCount: 2,
        authorStylesheetCount: 1,
        authorRuleCount: 1,
        authorDeclarationCount: 3,
        decodedImageCount: 0,
        paintedBackground: true,
        displayCommands: 2,
        paintOps: ["rect", "text"],
        pngBytes: 3200,
      },
      notAll: {
        media: "not all",
        url: "https://benchmark.test/not-all-media-stylesheet.html",
        fetchCalls: 1,
        discoveredResources: 0,
        loadedResources: 0,
        missingResources: 0,
        loadedBytes: 0,
        stylesheetCount: 1,
        authorStylesheetCount: 0,
        authorRuleCount: 0,
        authorDeclarationCount: 0,
        decodedImageCount: 0,
        paintedBackground: false,
        displayCommands: 1,
        paintOps: ["text"],
        pngBytes: 3100,
      },
      spacedNotAll: {
        media: "not   all",
        url: "https://benchmark.test/spaced-not-all-media-stylesheet.html",
        fetchCalls: 1,
        discoveredResources: 0,
        loadedResources: 0,
        missingResources: 0,
        loadedBytes: 0,
        stylesheetCount: 1,
        authorStylesheetCount: 0,
        authorRuleCount: 0,
        authorDeclarationCount: 0,
        decodedImageCount: 0,
        paintedBackground: false,
        displayCommands: 1,
        paintOps: ["text"],
        pngBytes: 3100,
      },
      notPrint: {
        media: "not print",
        url: "https://benchmark.test/not-print-media-stylesheet.html",
        fetchCalls: 2,
        discoveredResources: 1,
        loadedResources: 1,
        missingResources: 0,
        loadedBytes: 67,
        stylesheetCount: 2,
        authorStylesheetCount: 1,
        authorRuleCount: 1,
        authorDeclarationCount: 3,
        decodedImageCount: 0,
        paintedBackground: true,
        displayCommands: 2,
        paintOps: ["rect", "text"],
        pngBytes: 3200,
      },
      spacedNotPrint: {
        media: "not   print",
        url: "https://benchmark.test/spaced-not-print-media-stylesheet.html",
        fetchCalls: 2,
        discoveredResources: 1,
        loadedResources: 1,
        missingResources: 0,
        loadedBytes: 67,
        stylesheetCount: 2,
        authorStylesheetCount: 1,
        authorRuleCount: 1,
        authorDeclarationCount: 3,
        decodedImageCount: 0,
        paintedBackground: true,
        displayCommands: 2,
        paintOps: ["rect", "text"],
        pngBytes: 3200,
      },
      onlyPrint: {
        media: "only print",
        url: "https://benchmark.test/only-print-media-stylesheet.html",
        fetchCalls: 1,
        discoveredResources: 0,
        loadedResources: 0,
        missingResources: 0,
        loadedBytes: 0,
        stylesheetCount: 1,
        authorStylesheetCount: 0,
        authorRuleCount: 0,
        authorDeclarationCount: 0,
        decodedImageCount: 0,
        paintedBackground: false,
        displayCommands: 1,
        paintOps: ["text"],
        pngBytes: 3100,
      },
      spacedOnlyPrint: {
        media: "only   print",
        url: "https://benchmark.test/spaced-only-print-media-stylesheet.html",
        fetchCalls: 1,
        discoveredResources: 0,
        loadedResources: 0,
        missingResources: 0,
        loadedBytes: 0,
        stylesheetCount: 1,
        authorStylesheetCount: 0,
        authorRuleCount: 0,
        authorDeclarationCount: 0,
        decodedImageCount: 0,
        paintedBackground: false,
        displayCommands: 1,
        paintOps: ["text"],
        pngBytes: 3100,
      },
    },
    stylesheetMediaFeature: {
      screenMinWidth: {
        media: "screen and (min-width: 1px)",
        url: "https://benchmark.test/screen-min-width-media-stylesheet.html",
        fetchCalls: 2,
        discoveredResources: 1,
        loadedResources: 1,
        missingResources: 0,
        loadedBytes: 67,
        stylesheetCount: 2,
        authorStylesheetCount: 1,
        authorRuleCount: 1,
        authorDeclarationCount: 3,
        decodedImageCount: 0,
        paintedBackground: true,
        displayCommands: 2,
        paintOps: ["rect", "text"],
        pngBytes: 3200,
      },
      uppercaseScreenMinWidth: {
        media: "screen and (MIN-WIDTH: 1px)",
        url: "https://benchmark.test/uppercase-screen-min-width-media-stylesheet.html",
        fetchCalls: 2,
        discoveredResources: 1,
        loadedResources: 1,
        missingResources: 0,
        loadedBytes: 67,
        stylesheetCount: 2,
        authorStylesheetCount: 1,
        authorRuleCount: 1,
        authorDeclarationCount: 3,
        decodedImageCount: 0,
        paintedBackground: true,
        displayCommands: 2,
        paintOps: ["rect", "text"],
        pngBytes: 3200,
      },
      decimalScreenMinWidth: {
        media: "screen and (min-width: 799.5px)",
        url: "https://benchmark.test/decimal-screen-min-width-media-stylesheet.html",
        fetchCalls: 2,
        discoveredResources: 1,
        loadedResources: 1,
        missingResources: 0,
        loadedBytes: 67,
        stylesheetCount: 2,
        authorStylesheetCount: 1,
        authorRuleCount: 1,
        authorDeclarationCount: 3,
        decodedImageCount: 0,
        paintedBackground: true,
        displayCommands: 2,
        paintOps: ["rect", "text"],
        pngBytes: 3200,
      },
      spacedScreenMinWidth: {
        media: "screen  and  ( min-width : 1px )",
        url: "https://benchmark.test/spaced-screen-min-width-media-stylesheet.html",
        fetchCalls: 2,
        discoveredResources: 1,
        loadedResources: 1,
        missingResources: 0,
        loadedBytes: 67,
        stylesheetCount: 2,
        authorStylesheetCount: 1,
        authorRuleCount: 1,
        authorDeclarationCount: 3,
        decodedImageCount: 0,
        paintedBackground: true,
        displayCommands: 2,
        paintOps: ["rect", "text"],
        pngBytes: 3200,
      },
      bareMinWidth: {
        media: "(min-width: 1px)",
        url: "https://benchmark.test/bare-min-width-media-stylesheet.html",
        fetchCalls: 2,
        discoveredResources: 1,
        loadedResources: 1,
        missingResources: 0,
        loadedBytes: 67,
        stylesheetCount: 2,
        authorStylesheetCount: 1,
        authorRuleCount: 1,
        authorDeclarationCount: 3,
        decodedImageCount: 0,
        paintedBackground: true,
        displayCommands: 2,
        paintOps: ["rect", "text"],
        pngBytes: 3200,
      },
      allMinWidth: {
        media: "all and (min-width: 1px)",
        url: "https://benchmark.test/all-min-width-media-stylesheet.html",
        fetchCalls: 2,
        discoveredResources: 1,
        loadedResources: 1,
        missingResources: 0,
        loadedBytes: 67,
        stylesheetCount: 2,
        authorStylesheetCount: 1,
        authorRuleCount: 1,
        authorDeclarationCount: 3,
        decodedImageCount: 0,
        paintedBackground: true,
        displayCommands: 2,
        paintOps: ["rect", "text"],
        pngBytes: 3200,
      },
      allMaxWidth: {
        media: "all and (max-width: 1px)",
        url: "https://benchmark.test/all-max-width-media-stylesheet.html",
        fetchCalls: 1,
        discoveredResources: 0,
        loadedResources: 0,
        missingResources: 0,
        loadedBytes: 0,
        stylesheetCount: 1,
        authorStylesheetCount: 0,
        authorRuleCount: 0,
        authorDeclarationCount: 0,
        decodedImageCount: 0,
        paintedBackground: false,
        displayCommands: 1,
        paintOps: ["text"],
        pngBytes: 3100,
      },
      onlyAllMinWidth: {
        media: "only all and (min-width: 1px)",
        url: "https://benchmark.test/only-all-min-width-media-stylesheet.html",
        fetchCalls: 2,
        discoveredResources: 1,
        loadedResources: 1,
        missingResources: 0,
        loadedBytes: 67,
        stylesheetCount: 2,
        authorStylesheetCount: 1,
        authorRuleCount: 1,
        authorDeclarationCount: 3,
        decodedImageCount: 0,
        paintedBackground: true,
        displayCommands: 2,
        paintOps: ["rect", "text"],
        pngBytes: 3200,
      },
      unsupportedRangeWidth: {
        media: "screen and (width >= 1px)",
        url: "https://benchmark.test/unsupported-range-width-media-stylesheet.html",
        fetchCalls: 1,
        discoveredResources: 0,
        loadedResources: 0,
        missingResources: 0,
        loadedBytes: 0,
        stylesheetCount: 1,
        authorStylesheetCount: 0,
        authorRuleCount: 0,
        authorDeclarationCount: 0,
        decodedImageCount: 0,
        paintedBackground: false,
        displayCommands: 1,
        paintOps: ["text"],
        pngBytes: 3100,
      },
      unsupportedRangeThenScreen: {
        media: "(width >= 1px), screen",
        url: "https://benchmark.test/unsupported-range-then-screen-media-stylesheet.html",
        fetchCalls: 2,
        discoveredResources: 1,
        loadedResources: 1,
        missingResources: 0,
        loadedBytes: 67,
        stylesheetCount: 2,
        authorStylesheetCount: 1,
        authorRuleCount: 1,
        authorDeclarationCount: 3,
        decodedImageCount: 0,
        paintedBackground: true,
        displayCommands: 2,
        paintOps: ["rect", "text"],
        pngBytes: 3200,
      },
      unsupportedCalcMinWidth: {
        media: "screen and (min-width: calc(1px))",
        url: "https://benchmark.test/unsupported-calc-min-width-media-stylesheet.html",
        fetchCalls: 1,
        discoveredResources: 0,
        loadedResources: 0,
        missingResources: 0,
        loadedBytes: 0,
        stylesheetCount: 1,
        authorStylesheetCount: 0,
        authorRuleCount: 0,
        authorDeclarationCount: 0,
        decodedImageCount: 0,
        paintedBackground: false,
        displayCommands: 1,
        paintOps: ["text"],
        pngBytes: 3100,
      },
      unsupportedHover: {
        media: "screen and (hover: hover)",
        url: "https://benchmark.test/unsupported-hover-media-stylesheet.html",
        fetchCalls: 1,
        discoveredResources: 0,
        loadedResources: 0,
        missingResources: 0,
        loadedBytes: 0,
        stylesheetCount: 1,
        authorStylesheetCount: 0,
        authorRuleCount: 0,
        authorDeclarationCount: 0,
        decodedImageCount: 0,
        paintedBackground: false,
        displayCommands: 1,
        paintOps: ["text"],
        pngBytes: 3100,
      },
      invalidEmptyFeature: {
        media: "screen and ()",
        url: "https://benchmark.test/invalid-empty-feature-media-stylesheet.html",
        fetchCalls: 1,
        discoveredResources: 0,
        loadedResources: 0,
        missingResources: 0,
        loadedBytes: 0,
        stylesheetCount: 1,
        authorStylesheetCount: 0,
        authorRuleCount: 0,
        authorDeclarationCount: 0,
        decodedImageCount: 0,
        paintedBackground: false,
        displayCommands: 1,
        paintOps: ["text"],
        pngBytes: 3100,
      },
      unsupportedBooleanWidth: {
        media: "screen and (width)",
        url: "https://benchmark.test/unsupported-boolean-width-media-stylesheet.html",
        fetchCalls: 1,
        discoveredResources: 0,
        loadedResources: 0,
        missingResources: 0,
        loadedBytes: 0,
        stylesheetCount: 1,
        authorStylesheetCount: 0,
        authorRuleCount: 0,
        authorDeclarationCount: 0,
        decodedImageCount: 0,
        paintedBackground: false,
        displayCommands: 1,
        paintOps: ["text"],
        pngBytes: 3100,
      },
      unknownFeature: {
        media: "screen and (unknown-feature)",
        url: "https://benchmark.test/unknown-feature-media-stylesheet.html",
        fetchCalls: 1,
        discoveredResources: 0,
        loadedResources: 0,
        missingResources: 0,
        loadedBytes: 0,
        stylesheetCount: 1,
        authorStylesheetCount: 0,
        authorRuleCount: 0,
        authorDeclarationCount: 0,
        decodedImageCount: 0,
        paintedBackground: false,
        displayCommands: 1,
        paintOps: ["text"],
        pngBytes: 3100,
      },
      invalidEmptyFeatureThenScreen: {
        media: "screen and (), screen",
        url: "https://benchmark.test/invalid-empty-feature-then-screen-media-stylesheet.html",
        fetchCalls: 2,
        discoveredResources: 1,
        loadedResources: 1,
        missingResources: 0,
        loadedBytes: 67,
        stylesheetCount: 2,
        authorStylesheetCount: 1,
        authorRuleCount: 1,
        authorDeclarationCount: 3,
        decodedImageCount: 0,
        paintedBackground: true,
        displayCommands: 2,
        paintOps: ["rect", "text"],
        pngBytes: 3200,
      },
      screenMaxWidth: {
        media: "screen and (max-width: 1px)",
        url: "https://benchmark.test/screen-max-width-media-stylesheet.html",
        fetchCalls: 1,
        discoveredResources: 0,
        loadedResources: 0,
        missingResources: 0,
        loadedBytes: 0,
        stylesheetCount: 1,
        authorStylesheetCount: 0,
        authorRuleCount: 0,
        authorDeclarationCount: 0,
        decodedImageCount: 0,
        paintedBackground: false,
        displayCommands: 1,
        paintOps: ["text"],
        pngBytes: 3100,
      },
      decimalScreenMaxWidth: {
        media: "screen and (max-width: 799.5px)",
        url: "https://benchmark.test/decimal-screen-max-width-media-stylesheet.html",
        fetchCalls: 1,
        discoveredResources: 0,
        loadedResources: 0,
        missingResources: 0,
        loadedBytes: 0,
        stylesheetCount: 1,
        authorStylesheetCount: 0,
        authorRuleCount: 0,
        authorDeclarationCount: 0,
        decodedImageCount: 0,
        paintedBackground: false,
        displayCommands: 1,
        paintOps: ["text"],
        pngBytes: 3100,
      },
      spacedScreenMaxWidth: {
        media: "screen  and  ( max-width : 1px )",
        url: "https://benchmark.test/spaced-screen-max-width-media-stylesheet.html",
        fetchCalls: 1,
        discoveredResources: 0,
        loadedResources: 0,
        missingResources: 0,
        loadedBytes: 0,
        stylesheetCount: 1,
        authorStylesheetCount: 0,
        authorRuleCount: 0,
        authorDeclarationCount: 0,
        decodedImageCount: 0,
        paintedBackground: false,
        displayCommands: 1,
        paintOps: ["text"],
        pngBytes: 3100,
      },
      screenMinHeight: {
        media: "screen and (min-height: 1px)",
        url: "https://benchmark.test/screen-min-height-media-stylesheet.html",
        fetchCalls: 2,
        discoveredResources: 1,
        loadedResources: 1,
        missingResources: 0,
        loadedBytes: 67,
        stylesheetCount: 2,
        authorStylesheetCount: 1,
        authorRuleCount: 1,
        authorDeclarationCount: 3,
        decodedImageCount: 0,
        paintedBackground: true,
        displayCommands: 2,
        paintOps: ["rect", "text"],
        pngBytes: 3200,
      },
      screenMaxHeight: {
        media: "screen and (max-height: 1px)",
        url: "https://benchmark.test/screen-max-height-media-stylesheet.html",
        fetchCalls: 1,
        discoveredResources: 0,
        loadedResources: 0,
        missingResources: 0,
        loadedBytes: 0,
        stylesheetCount: 1,
        authorStylesheetCount: 0,
        authorRuleCount: 0,
        authorDeclarationCount: 0,
        decodedImageCount: 0,
        paintedBackground: false,
        displayCommands: 1,
        paintOps: ["text"],
        pngBytes: 3100,
      },
      screenExactWidth: {
        media: "screen and (width: 800px)",
        url: "https://benchmark.test/screen-exact-width-media-stylesheet.html",
        fetchCalls: 2,
        discoveredResources: 1,
        loadedResources: 1,
        missingResources: 0,
        loadedBytes: 67,
        stylesheetCount: 2,
        authorStylesheetCount: 1,
        authorRuleCount: 1,
        authorDeclarationCount: 3,
        decodedImageCount: 0,
        paintedBackground: true,
        displayCommands: 2,
        paintOps: ["rect", "text"],
        pngBytes: 3200,
      },
      decimalScreenExactWidth: {
        media: "screen and (width: 800.0px)",
        url: "https://benchmark.test/decimal-screen-exact-width-media-stylesheet.html",
        fetchCalls: 2,
        discoveredResources: 1,
        loadedResources: 1,
        missingResources: 0,
        loadedBytes: 67,
        stylesheetCount: 2,
        authorStylesheetCount: 1,
        authorRuleCount: 1,
        authorDeclarationCount: 3,
        decodedImageCount: 0,
        paintedBackground: true,
        displayCommands: 2,
        paintOps: ["rect", "text"],
        pngBytes: 3200,
      },
      screenExactHeight: {
        media: "screen and (height: 600px)",
        url: "https://benchmark.test/screen-exact-height-media-stylesheet.html",
        fetchCalls: 2,
        discoveredResources: 1,
        loadedResources: 1,
        missingResources: 0,
        loadedBytes: 67,
        stylesheetCount: 2,
        authorStylesheetCount: 1,
        authorRuleCount: 1,
        authorDeclarationCount: 3,
        decodedImageCount: 0,
        paintedBackground: true,
        displayCommands: 2,
        paintOps: ["rect", "text"],
        pngBytes: 3200,
      },
      screenExactHeightMiss: {
        media: "screen and (height: 1px)",
        url: "https://benchmark.test/screen-exact-height-miss-media-stylesheet.html",
        fetchCalls: 1,
        discoveredResources: 0,
        loadedResources: 0,
        missingResources: 0,
        loadedBytes: 0,
        stylesheetCount: 1,
        authorStylesheetCount: 0,
        authorRuleCount: 0,
        authorDeclarationCount: 0,
        decodedImageCount: 0,
        paintedBackground: false,
        displayCommands: 1,
        paintOps: ["text"],
        pngBytes: 3100,
      },
      negatedMatchingFeature: {
        media: "not screen and (min-width: 1px)",
        url: "https://benchmark.test/negated-matching-feature-media-stylesheet.html",
        fetchCalls: 1,
        discoveredResources: 0,
        loadedResources: 0,
        missingResources: 0,
        loadedBytes: 0,
        stylesheetCount: 1,
        authorStylesheetCount: 0,
        authorRuleCount: 0,
        authorDeclarationCount: 0,
        decodedImageCount: 0,
        paintedBackground: false,
        displayCommands: 1,
        paintOps: ["text"],
        pngBytes: 3100,
      },
      negatedMissingFeature: {
        media: "not screen and (max-width: 1px)",
        url: "https://benchmark.test/negated-missing-feature-media-stylesheet.html",
        fetchCalls: 2,
        discoveredResources: 1,
        loadedResources: 1,
        missingResources: 0,
        loadedBytes: 67,
        stylesheetCount: 2,
        authorStylesheetCount: 1,
        authorRuleCount: 1,
        authorDeclarationCount: 3,
        decodedImageCount: 0,
        paintedBackground: true,
        displayCommands: 2,
        paintOps: ["rect", "text"],
        pngBytes: 3200,
      },
    },
    stylesheetOrientationMedia: {
      landscape: {
        media: "screen and (orientation: landscape)",
        url: "https://benchmark.test/landscape-orientation-media-stylesheet.html",
        fetchCalls: 2,
        discoveredResources: 1,
        loadedResources: 1,
        missingResources: 0,
        loadedBytes: 67,
        stylesheetCount: 2,
        authorStylesheetCount: 1,
        authorRuleCount: 1,
        authorDeclarationCount: 3,
        decodedImageCount: 0,
        paintedBackground: true,
        displayCommands: 2,
        paintOps: ["rect", "text"],
        pngBytes: 3200,
      },
      uppercaseLandscape: {
        media: "screen and (ORIENTATION: LANDSCAPE)",
        url: "https://benchmark.test/uppercase-landscape-orientation-media-stylesheet.html",
        fetchCalls: 2,
        discoveredResources: 1,
        loadedResources: 1,
        missingResources: 0,
        loadedBytes: 67,
        stylesheetCount: 2,
        authorStylesheetCount: 1,
        authorRuleCount: 1,
        authorDeclarationCount: 3,
        decodedImageCount: 0,
        paintedBackground: true,
        displayCommands: 2,
        paintOps: ["rect", "text"],
        pngBytes: 3200,
      },
      portrait: {
        media: "screen and (orientation: portrait)",
        url: "https://benchmark.test/portrait-orientation-media-stylesheet.html",
        fetchCalls: 1,
        discoveredResources: 0,
        loadedResources: 0,
        missingResources: 0,
        loadedBytes: 0,
        stylesheetCount: 1,
        authorStylesheetCount: 0,
        authorRuleCount: 0,
        authorDeclarationCount: 0,
        decodedImageCount: 0,
        paintedBackground: false,
        displayCommands: 1,
        paintOps: ["text"],
        pngBytes: 3100,
      },
      uppercasePortrait: {
        media: "screen and (ORIENTATION: PORTRAIT)",
        url: "https://benchmark.test/uppercase-portrait-orientation-media-stylesheet.html",
        fetchCalls: 1,
        discoveredResources: 0,
        loadedResources: 0,
        missingResources: 0,
        loadedBytes: 0,
        stylesheetCount: 1,
        authorStylesheetCount: 0,
        authorRuleCount: 0,
        authorDeclarationCount: 0,
        decodedImageCount: 0,
        paintedBackground: false,
        displayCommands: 1,
        paintOps: ["text"],
        pngBytes: 3100,
      },
    },
    stylesheetCombinedMediaFeature: {
      matching: {
        media: "screen and (min-width: 1px) and (orientation: landscape)",
        url: "https://benchmark.test/combined-media-feature-media-stylesheet.html",
        fetchCalls: 2,
        discoveredResources: 1,
        loadedResources: 1,
        missingResources: 0,
        loadedBytes: 67,
        stylesheetCount: 2,
        authorStylesheetCount: 1,
        authorRuleCount: 1,
        authorDeclarationCount: 3,
        decodedImageCount: 0,
        paintedBackground: true,
        displayCommands: 2,
        paintOps: ["rect", "text"],
        pngBytes: 3200,
      },
      laterMiss: {
        media: "screen and (min-width: 1px) and (orientation: portrait)",
        url: "https://benchmark.test/combined-media-feature-miss-media-stylesheet.html",
        fetchCalls: 1,
        discoveredResources: 0,
        loadedResources: 0,
        missingResources: 0,
        loadedBytes: 0,
        stylesheetCount: 1,
        authorStylesheetCount: 0,
        authorRuleCount: 0,
        authorDeclarationCount: 0,
        decodedImageCount: 0,
        paintedBackground: false,
        displayCommands: 1,
        paintOps: ["text"],
        pngBytes: 3100,
      },
    },
    invalidExternalStylesheet: {
      url: "https://benchmark.test/invalid-external-stylesheet.html",
      discoveredResources: 1,
      loadedResources: 1,
      missingResources: 0,
      loadedBytes: 76,
      stylesheetCount: 2,
      authorStylesheetCount: 1,
      authorRuleCount: 1,
      authorDeclarationCount: 0,
      decodedImageCount: 0,
      paintedBackground: false,
      displayCommands: 1,
      paintOps: ["text"],
      pngBytes: 3100,
    },
    missingStylesheet: {
      url: "https://benchmark.test/missing-stylesheet.html",
      discoveredResources: 1,
      loadedResources: 0,
      missingResources: 1,
      loadedBytes: 0,
      stylesheetCount: 1,
      authorStylesheetCount: 0,
      authorRuleCount: 0,
      authorDeclarationCount: 0,
      decodedImageCount: 0,
      paintedBackground: false,
      displayCommands: 1,
      paintOps: ["text"],
      pngBytes: 3100,
    },
  },
  realSiteSmoke: {
    scenarioCount: 2,
    passed: 2,
    failed: 0,
    coveredCapabilities: ["event-loop-microtask", "fetch", "font-face", "v8-guest-execution"],
    scenarios: [
      {
        id: "smoke/fetch-json-roundtrip",
        capabilities: ["event-loop-microtask", "fetch", "v8-guest-execution"],
        passed: true,
      },
      {
        id: "smoke/web-font-applied",
        capabilities: ["fetch", "font-face"],
        passed: true,
      },
    ],
  },
};

void test("Req 1.1/1.2: live metrics classify hand-written vs generated vs test", () => {
  const m = computeLiveMetrics(SYNTHETIC, 5);
  assert.equal(m.handWrittenLines, 3, "two hand-written files: 2 + 1 = 3 lines");
  assert.ok(m.generatedLines > 0, "the generated file contributes generated lines");
  assert.equal(m.testLines, 2, "the test file's 2 lines are split out");
  assert.equal(m.totalLines, m.handWrittenLines + m.generatedLines + m.testLines);
});

void test("Req 1.3/1.5: CSS/DOM counts come from the live tables; ratios are derived", () => {
  const m = computeLiveMetrics(SYNTHETIC, 5);
  assert.ok(m.cssPropertyCount >= 18, "live CSS data table carries the connected properties");
  assert.ok(m.domMemberCount > 0, "live DOM IDL table has members");
  assert.equal(m.platformFeatureCount, m.cssPropertyCount + m.domMemberCount);
  assert.equal(m.compatPerLoc, 5 / 3, "compat-per-LOC = passes / hand-written lines");
  assert.equal(m.mechanismDensity, m.platformFeatureCount / (3 / 1000));
});

void test("Req 1.6: a zero hand-written denominator yields null, not a fake value", () => {
  const m = computeLiveMetrics([{ path: "packages/x/src/a.test.ts", content: "x\n" }], 5);
  assert.equal(m.handWrittenLines, 0);
  assert.equal(m.compatPerLoc, null);
  assert.equal(m.mechanismDensity, null);
});

void test("Req 1.1: isTestFile recognises test/spec/property-test files", () => {
  assert.equal(isTestFile("packages/x/src/a.test.ts"), true);
  assert.equal(isTestFile("packages/x/src/a.property.test.ts"), true);
  assert.equal(isTestFile("packages/x/src/a.spec.ts"), true);
  assert.equal(isTestFile("packages/x/src/a.ts"), false);
});

void test("live metrics are pure: same inputs ⇒ same output (Property 1)", () => {
  assert.deepEqual(computeLiveMetrics(SYNTHETIC, 7), computeLiveMetrics(SYNTHETIC, 7));
});

void test("live metrics can carry stable execution evidence", () => {
  const m = computeLiveMetrics(SYNTHETIC, 7, EVIDENCE);
  assert.deepEqual(m.executionEvidence, EVIDENCE);
});

// ---------------------------------------------------------------------------
// Property 2 — competitor data: has-value ⟹ has-source; no-source ⟹ needs-source.
// ---------------------------------------------------------------------------

void test("Req 2.1/2.3 (Property 2): every competitor datum is cited or explicitly needs-source", () => {
  for (const d of COMPETITORS) {
    if (d.value !== null) {
      assert.notEqual(d.sourceUrl, "", `${d.metric} has a value, so it must carry a source URL`);
      assert.notEqual(d.confidence, "needs-source", `${d.metric} has a value, so it is not needs-source`);
    } else {
      assert.equal(d.confidence, "needs-source", `${d.metric} has no value, so it must be needs-source`);
    }
  }
});

void test("Req 2.2: the two real citations are present and complete", () => {
  const loc = COMPETITORS.find((d) => d.metric === "hand-written-lines");
  assert.ok(loc && loc.value === 36_000_000 && loc.sourceUrl.includes("wikipedia.org"));
  const interop = COMPETITORS.find((d) => d.metric === "wpt-interop-pass-rate");
  assert.ok(interop && interop.value === 95 && interop.sourceUrl.includes("webkit.org"));
});

// ---------------------------------------------------------------------------
// Property 3 — each dimension: exactly one verdict, with required rationale.
// ---------------------------------------------------------------------------

void test("Req 3.1/3.5 (Property 3): every dimension has exactly one valid verdict", () => {
  const m = computeLiveMetrics(SYNTHETIC, 5);
  const dims = evaluateDimensions(m);
  const ids = dims.map((d) => d.id);
  for (const required of [
    "compat-per-loc",
    "mechanism-density",
    "hand-written-surface",
    "css-coverage",
    "raw-interop",
    "runtime-performance",
  ]) {
    assert.ok(ids.includes(required), `dimension ${required} must be present`);
  }
  for (const d of dims) {
    assert.ok(["WIN", "GAP", "NOT-COMPARABLE"].includes(d.verdict), `${d.id} verdict valid`);
    assert.ok(d.rationale.length > 0, `${d.id} carries a rationale`);
  }
});

void test("Req 3.2: the structurally-ours dimensions are WINs", () => {
  const m = computeLiveMetrics(SYNTHETIC, 5);
  const byId = new Map(evaluateDimensions(m).map((d) => [d.id, d]));
  assert.equal(byId.get("hand-written-surface")?.verdict, "WIN");
  assert.equal(byId.get("compat-per-loc")?.verdict, "WIN");
  assert.equal(byId.get("mechanism-density")?.verdict, "WIN");
});

void test("Req 3.3: breadth dimensions are honest GAPs, not fake wins", () => {
  const m = computeLiveMetrics(SYNTHETIC, 5);
  const byId = new Map(evaluateDimensions(m).map((d) => [d.id, d]));
  assert.equal(byId.get("css-coverage")?.verdict, "GAP");
  assert.equal(byId.get("raw-interop")?.verdict, "GAP");
});

// ---------------------------------------------------------------------------
// Property 5 — performance is never fabricated.
// ---------------------------------------------------------------------------

void test("Req 3.6/6.2 (Property 5): runtime performance is NOT-COMPARABLE with a null our-value", () => {
  const m = computeLiveMetrics(SYNTHETIC, 5);
  const perf = evaluateDimensions(m).find((d) => d.id === "runtime-performance");
  assert.ok(perf !== undefined);
  assert.equal(perf.ourValue, null, "we must NOT fabricate our own performance number");
  assert.equal(perf.verdict, "NOT-COMPARABLE");
});

// ---------------------------------------------------------------------------
// Property 4 — report determinism + structure.
// ---------------------------------------------------------------------------

void test("Req 4.5 (Property 4): the report is byte-for-byte deterministic", () => {
  const m = computeLiveMetrics(SYNTHETIC, 5);
  const snap = buildSnapshot(m);
  assert.equal(renderBenchmarkMarkdown(snap), renderBenchmarkMarkdown(snap));
  assert.equal(renderBenchmarkJson(snap), renderBenchmarkJson(snap));
  assert.equal(renderEvidenceDashboardHtml(snap), renderEvidenceDashboardHtml(snap));
});

void test("machine-readable benchmark evidence is generated from the same snapshot", () => {
  const m = computeLiveMetrics(SYNTHETIC, 5, EVIDENCE);
  const snap = buildSnapshot(m);
  const report = buildBenchmarkJsonReport(snap);
  const parsed = JSON.parse(renderBenchmarkJson(snap)) as BenchmarkJsonReport;

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.generatedBy, "@browser-engine/benchmark");
  assert.equal(report.deterministic, true);
  // The serialized report omits rendered-PNG byte lengths (platform-dependent —
  // see omitRenderedPngBytes), so compare against the same omission applied to
  // the in-memory report.
  assert.deepEqual(parsed, omitRenderedPngBytes(report));
  assert.deepEqual(parsed.metrics, omitRenderedPngBytes(snap.metrics));
  assert.deepEqual(parsed.dimensions, snap.dimensions);
  assert.equal(parsed.metrics.executionEvidence?.resourceLoadedPage.missingResources, 1);
  assert.equal(parsed.metrics.executionEvidence?.realSiteSmoke.passed, 2);
});

void test("static evidence dashboard is generated from the same snapshot", () => {
  const m = computeLiveMetrics(SYNTHETIC, 5, EVIDENCE);
  const html = renderEvidenceDashboardHtml(buildSnapshot(m));

  assert.match(html, /<!doctype html>/);
  assert.match(html, /Evidence Dashboard/);
  assert.match(html, /Hand-written lines/);
  assert.match(html, /Compat \/ LOC/);
  assert.match(html, /Maintained WPT Trace/);
  assert.match(html, /17 passed, 0 failed, 0 errored/);
  assert.match(html, /Incremental Edit Sequence/);
  assert.match(html, /Paint-only reused layout/);
  assert.match(html, /Script-Driven DOM Mutation/);
  assert.match(html, /Resource-Loaded Page/);
  assert.match(html, /3 discovered, 2 loaded, 1 missing/);
  assert.match(html, /Uppercase media-feature min-width author sheets/);
  assert.match(html, /Unsupported range media-feature author sheets/);
  assert.match(html, /All-and media-feature min-width author sheets/);
  assert.match(html, /All-and media-feature max-width author sheets/);
  assert.match(html, /Only-all-and media-feature min-width author sheets/);
  assert.match(html, /Unsupported range then screen author sheets/);
  assert.match(html, /Unsupported calc media-feature author sheets/);
  assert.match(html, /Unsupported hover media-feature author sheets/);
  assert.match(html, /Invalid empty media-feature author sheets/);
  assert.match(html, /Unsupported boolean width media-feature author sheets/);
  assert.match(html, /Unknown media-feature author sheets/);
  assert.match(html, /Invalid empty feature then screen author sheets/);
  assert.match(html, /Uppercase orientation landscape background/);
  assert.match(html, /Uppercase orientation portrait background/);
  assert.match(html, /Missing image painted/);
  assert.match(html, /Invalid image decoded/);
  assert.match(html, /Invalid image painted/);
  assert.match(html, /Duplicate shared fetches/);
  assert.match(html, /Duplicate painted images/);
  assert.match(html, /Duplicate stylesheet shared fetches/);
  assert.match(html, /Duplicate stylesheet author sheets/);
  assert.match(html, /Duplicate stylesheet source-order winner/);
  assert.match(html, /Data URL fetch calls/);
  assert.match(html, /Data URL painted image/);
  assert.match(html, /Data URL charset percent author declarations/);
  assert.match(html, /Data URL charset base64 author declarations/);
  assert.match(html, /Data URL unsupported charset author sheets/);
  assert.match(html, /Data URL stylesheet external-after source-order winner/);
  assert.match(html, /Data URL stylesheet data-after source-order winner/);
  assert.match(html, /Data URL stylesheet data URL fetch calls/);
  assert.match(html, /External\/inline stylesheet inline-after source-order winner/);
  assert.match(html, /External\/inline stylesheet external-after source-order winner/);
  assert.match(html, /External\/inline stylesheet external fetches/);
  assert.match(html, /Invalid data image painted/);
  assert.match(html, /Invalid data stylesheet author declarations/);
  assert.match(html, /Invalid data stylesheet background/);
  assert.match(html, /Non-CSS data stylesheet author sheets/);
  assert.match(html, /Non-CSS data stylesheet background/);
  assert.match(html, /No-href stylesheet author sheets/);
  assert.match(html, /No-href stylesheet background/);
  assert.match(html, /Empty-href stylesheet loaded resources/);
  assert.match(html, /Empty-href stylesheet author declarations/);
  assert.match(html, /Empty-href stylesheet background/);
  assert.match(html, /Fragment-href stylesheet loaded resources/);
  assert.match(html, /Fragment-href stylesheet author declarations/);
  assert.match(html, /Fragment-href stylesheet background/);
  assert.match(html, /Query-href stylesheet loaded resources/);
  assert.match(html, /Query-href stylesheet author declarations/);
  assert.match(html, /Query-href stylesheet background/);
  assert.match(html, /Protocol-relative stylesheet loaded resources/);
  assert.match(html, /Protocol-relative stylesheet author declarations/);
  assert.match(html, /Protocol-relative stylesheet background/);
  assert.match(html, /Whitespace-rel stylesheet loaded resources/);
  assert.match(html, /Whitespace-rel stylesheet author declarations/);
  assert.match(html, /Whitespace-rel stylesheet background/);
  assert.match(html, /Whitespace-rel stylesheet source-order winner/);
  assert.match(html, /Whitespace-rel alternate author sheets/);
  assert.match(html, /Duplicate-rel stylesheet loaded resources/);
  assert.match(html, /Duplicate-rel stylesheet author sheets/);
  assert.match(html, /Duplicate-rel stylesheet source-order winner/);
  assert.match(html, /Duplicate-rel alternate author sheets/);
  assert.match(html, /Whitespace-href stylesheet loaded resources/);
  assert.match(html, /Whitespace-href stylesheet loaded URL/);
  assert.match(html, /Whitespace-href stylesheet source-order winner/);
  assert.match(html, /Control-char href stylesheet loaded URL/);
  assert.match(html, /Control-char href stylesheet source-order winner/);
  assert.match(html, /Base-href stylesheet loaded URL/);
  assert.match(html, /Base-href image loaded URL/);
  assert.match(html, /Base-href stylesheet\/image fetches/);
  assert.match(html, /Invalid-url stylesheet loaded resources/);
  assert.match(html, /Invalid-url stylesheet author sheets/);
  assert.match(html, /Invalid-url stylesheet source-order winner/);
  assert.match(html, /Invalid-url-only missing resources/);
  assert.match(html, /Alternate stylesheet author sheets/);
  assert.match(html, /Alternate stylesheet background/);
  assert.match(html, /Disabled stylesheet author sheets/);
  assert.match(html, /Disabled stylesheet background/);
  assert.match(html, /Print-media stylesheet author sheets/);
  assert.match(html, /Print-media stylesheet background/);
  assert.match(html, /Empty media stylesheet author sheets/);
  assert.match(html, /Whitespace-only media stylesheet author sheets/);
  assert.match(html, /Media-list stylesheet matching author sheets/);
  assert.match(html, /Media-list stylesheet matching background/);
  assert.match(html, /Spaced media-list author sheets/);
  assert.match(html, /Spaced media-list background/);
  assert.match(html, /Empty item before screen media author sheets/);
  assert.match(html, /Empty item after screen media author sheets/);
  assert.match(html, /Empty-only media list author sheets/);
  assert.match(html, /Unsupported media-list then screen author sheets/);
  assert.match(html, /Unsupported media-list then screen background/);
  assert.match(html, /Unsupported media-list only author sheets/);
  assert.match(html, /Unknown media type then screen author sheets/);
  assert.match(html, /Unknown media type only author sheets/);
  assert.match(html, /Uppercase screen media author sheets/);
  assert.match(html, /Mixed-case only-screen media author sheets/);
  assert.match(html, /Spaced only-screen media author sheets/);
  assert.match(html, /Uppercase print media author sheets/);
  assert.match(html, /All media stylesheet author sheets/);
  assert.match(html, /Only-all stylesheet author sheets/);
  assert.match(html, /Not-all stylesheet author sheets/);
  assert.match(html, /Spaced not-all stylesheet author sheets/);
  assert.match(html, /Not-print stylesheet author sheets/);
  assert.match(html, /Spaced not-print stylesheet author sheets/);
  assert.match(html, /Only-print stylesheet author sheets/);
  assert.match(html, /Spaced only-print stylesheet author sheets/);
  assert.match(html, /Media-feature min-width author sheets/);
  assert.match(html, /Decimal media-feature min-width author sheets/);
  assert.match(html, /Spaced media-feature min-width author sheets/);
  assert.match(html, /Media-feature bare min-width author sheets/);
  assert.match(html, /Media-feature max-width author sheets/);
  assert.match(html, /Media-feature max-width background/);
  assert.match(html, /Decimal media-feature max-width author sheets/);
  assert.match(html, /Decimal media-feature max-width background/);
  assert.match(html, /Spaced media-feature max-width author sheets/);
  assert.match(html, /Spaced media-feature max-width background/);
  assert.match(html, /Media-feature min-height author sheets/);
  assert.match(html, /Media-feature max-height author sheets/);
  assert.match(html, /Media-feature max-height background/);
  assert.match(html, /Media-feature exact-width author sheets/);
  assert.match(html, /Decimal media-feature exact-width author sheets/);
  assert.match(html, /Media-feature exact-height author sheets/);
  assert.match(html, /Media-feature exact-height miss author sheets/);
  assert.match(html, /Media-feature negated matching author sheets/);
  assert.match(html, /Media-feature negated missing author sheets/);
  assert.match(html, /Media-feature negated missing background/);
  assert.match(html, /Orientation landscape author sheets/);
  assert.match(html, /Orientation landscape background/);
  assert.match(html, /Orientation portrait author sheets/);
  assert.match(html, /Orientation portrait background/);
  assert.match(html, /Combined media-feature author sheets/);
  assert.match(html, /Combined media-feature background/);
  assert.match(html, /Combined media-feature miss author sheets/);
  assert.match(html, /Combined media-feature miss background/);
  assert.match(html, /Invalid external stylesheet resources/);
  assert.match(html, /Invalid external stylesheet author declarations/);
  assert.match(html, /Missing stylesheet author declarations/);
  assert.match(html, /Missing stylesheet background/);
  assert.match(html, /Real-Site Smoke/);
  assert.match(html, /event-loop-microtask, fetch, font-face, v8-guest-execution/);
  assert.doesNotMatch(html, /<script\b/i);
});

void test("Req 4.1/4.2/4.3/4.4/4.6: the report carries all required sections", () => {
  const m = computeLiveMetrics(SYNTHETIC, 5, EVIDENCE);
  const md = renderBenchmarkMarkdown(buildSnapshot(m));
  assert.match(md, /## Headline — where we lead/);
  assert.match(md, /## Head-to-head/);
  assert.match(md, /\| Dimension \| Ours \(live\) \| Chromium \(cited\) \| Verdict \|/);
  assert.match(md, /## Citations/);
  assert.match(md, /## Honesty statement/);
  assert.match(md, /## Overall/);
  assert.match(md, /## Execution evidence \(maintained WPT subset trace\)/);
  assert.match(md, /Query calls: 503/);
  assert.match(md, /Traced stages: qFineComputed, qFineLayout, qFinePaint, qFineSheets/);
  assert.match(md, /## Incremental edit-sequence evidence/);
  assert.match(md, /Paint-only edit reused layout: yes/);
  assert.match(md, /Layout-affecting edit recomputed layout: yes/);
  assert.match(md, /Verified cache hits: 7/);
  assert.match(md, /\| paint-only-edit \| 18 \| 4 \| 14 \| 5 \| 123 \|/);
  assert.match(md, /## Script-driven DOM mutation evidence/);
  assert.match(md, /Script DOM mutations: 4/);
  assert.match(md, /Paint-only script edit reused layout: yes/);
  assert.match(md, /appendChild increased nodes: yes/);
  assert.match(md, /Appended node painted: yes/);
  assert.match(md, /\| script-append-child \| 3 \| 30 \| 6 \| 24 \| 5 \| 210 \|/);
  assert.match(md, /## Resource-loaded page evidence/);
  assert.match(md, /External resources: 3 discovered, 2 loaded, 1 missing/);
  assert.match(md, /Decoded images: 1/);
  assert.match(md, /Paint ops: image, rect/);
  assert.match(md, /PNG output: 800x600/);
  assert.match(md, /Missing-image-only resources: 1 discovered, 0 loaded, 1 missing/);
  assert.match(md, /Missing-image-only decoded images: 0/);
  assert.match(md, /Missing-image-only painted image: no/);
  assert.match(md, /Invalid-image-only resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /Invalid-image-only loaded bytes: 9/);
  assert.match(md, /Invalid-image-only decoded images: 0/);
  assert.match(md, /Invalid-image-only painted image: no/);
  assert.match(md, /Duplicate-resource fetch calls: 2/);
  assert.match(md, /Duplicate-resource shared fetches: 1/);
  assert.match(md, /Duplicate-resource resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /Duplicate-resource decoded images: 2/);
  assert.match(md, /Duplicate-resource painted images: 2/);
  assert.match(md, /Duplicate-stylesheet URL: https:\/\/benchmark\.test\/duplicate-stylesheet\.html/);
  assert.match(md, /Duplicate-stylesheet fetch calls: 2/);
  assert.match(md, /Duplicate-stylesheet shared fetches: 1/);
  assert.match(md, /Duplicate-stylesheet external resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /Duplicate-stylesheet loaded bytes: 67/);
  assert.match(md, /Duplicate-stylesheet stylesheets: 4/);
  assert.match(md, /Duplicate-stylesheet author stylesheets: 3/);
  assert.match(md, /Duplicate-stylesheet author rules: 3/);
  assert.match(md, /Duplicate-stylesheet author declarations: 9/);
  assert.match(md, /Duplicate-stylesheet decoded images: 0/);
  assert.match(md, /Duplicate-stylesheet painted background: yes/);
  assert.match(md, /Duplicate-stylesheet duplicate link won source order: yes/);
  assert.match(md, /Duplicate-stylesheet paint ops: rect/);
  assert.match(md, /Data-url-only fetch calls: 1/);
  assert.match(md, /Data-url-only external resources: 0 discovered, 0 loaded, 0 missing/);
  assert.match(md, /Data-url-only loaded bytes: 0/);
  assert.match(md, /Data-url-only stylesheets: 2/);
  assert.match(md, /Data-url-only decoded images: 1/);
  assert.match(md, /Data-url-only painted images: 1/);
  assert.match(md, /Data-url-only painted background: yes/);
  assert.match(md, /Data-url-charset percent URL: https:\/\/benchmark\.test\/data-url-charset-percent-stylesheet\.html/);
  assert.match(md, /Data-url-charset percent metadata: text\/css;charset=utf-8/);
  assert.match(md, /Data-url-charset percent fetch calls: 1/);
  assert.match(md, /Data-url-charset percent data URL fetch calls: 0/);
  assert.match(md, /Data-url-charset percent external resources: 0 discovered, 0 loaded, 0 missing/);
  assert.match(md, /Data-url-charset percent stylesheets: 2/);
  assert.match(md, /Data-url-charset percent author stylesheets: 1/);
  assert.match(md, /Data-url-charset percent author declarations: 3/);
  assert.match(md, /Data-url-charset percent painted background: yes/);
  assert.match(md, /Data-url-charset base64 URL: https:\/\/benchmark\.test\/data-url-charset-base64-stylesheet\.html/);
  assert.match(md, /Data-url-charset base64 metadata: text\/css;charset=utf-8;base64/);
  assert.match(md, /Data-url-charset base64 fetch calls: 1/);
  assert.match(md, /Data-url-charset base64 data URL fetch calls: 0/);
  assert.match(md, /Data-url-charset base64 external resources: 0 discovered, 0 loaded, 0 missing/);
  assert.match(md, /Data-url-charset base64 stylesheets: 2/);
  assert.match(md, /Data-url-charset base64 author stylesheets: 1/);
  assert.match(md, /Data-url-charset base64 author declarations: 3/);
  assert.match(md, /Data-url-charset base64 painted background: yes/);
  assert.match(md, /Data-url-charset unsupported URL: https:\/\/benchmark\.test\/data-url-charset-unsupported-stylesheet\.html/);
  assert.match(md, /Data-url-charset unsupported metadata: text\/css;charset=iso-8859-1/);
  assert.match(md, /Data-url-charset unsupported fetch calls: 1/);
  assert.match(md, /Data-url-charset unsupported data URL fetch calls: 0/);
  assert.match(md, /Data-url-charset unsupported external resources: 0 discovered, 0 loaded, 0 missing/);
  assert.match(md, /Data-url-charset unsupported stylesheets: 1/);
  assert.match(md, /Data-url-charset unsupported author stylesheets: 0/);
  assert.match(md, /Data-url-charset unsupported author declarations: 0/);
  assert.match(md, /Data-url-charset unsupported painted background: no/);
  assert.match(md, /Data-url-stylesheet external-after URL: https:\/\/benchmark\.test\/data-url-before-external-stylesheet\.html/);
  assert.match(md, /Data-url-stylesheet external-after external URL: https:\/\/benchmark\.test\/late\.css/);
  assert.match(md, /Data-url-stylesheet external-after fetch calls: 2/);
  assert.match(md, /Data-url-stylesheet external-after data URL fetch calls: 0/);
  assert.match(md, /Data-url-stylesheet external-after external fetches: 1/);
  assert.match(md, /Data-url-stylesheet external-after external resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /Data-url-stylesheet external-after loaded bytes: 40/);
  assert.match(md, /Data-url-stylesheet external-after stylesheets: 3/);
  assert.match(md, /Data-url-stylesheet external-after author stylesheets: 2/);
  assert.match(md, /Data-url-stylesheet external-after author rules: 2/);
  assert.match(md, /Data-url-stylesheet external-after author declarations: 4/);
  assert.match(md, /Data-url-stylesheet external-after decoded images: 0/);
  assert.match(md, /Data-url-stylesheet external-after painted background: yes/);
  assert.match(md, /Data-url-stylesheet external-after source-order winner blue: yes/);
  assert.match(md, /Data-url-stylesheet data-after URL: https:\/\/benchmark\.test\/external-before-data-url-stylesheet\.html/);
  assert.match(md, /Data-url-stylesheet data-after external URL: https:\/\/benchmark\.test\/early\.css/);
  assert.match(md, /Data-url-stylesheet data-after fetch calls: 2/);
  assert.match(md, /Data-url-stylesheet data-after data URL fetch calls: 0/);
  assert.match(md, /Data-url-stylesheet data-after external fetches: 1/);
  assert.match(md, /Data-url-stylesheet data-after external resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /Data-url-stylesheet data-after loaded bytes: 67/);
  assert.match(md, /Data-url-stylesheet data-after stylesheets: 3/);
  assert.match(md, /Data-url-stylesheet data-after author stylesheets: 2/);
  assert.match(md, /Data-url-stylesheet data-after author rules: 2/);
  assert.match(md, /Data-url-stylesheet data-after author declarations: 4/);
  assert.match(md, /Data-url-stylesheet data-after decoded images: 0/);
  assert.match(md, /Data-url-stylesheet data-after painted background: yes/);
  assert.match(md, /Data-url-stylesheet data-after source-order winner blue: yes/);
  assert.match(md, /External-inline-stylesheet inline-after URL: https:\/\/benchmark\.test\/external-before-inline-stylesheet\.html/);
  assert.match(md, /External-inline-stylesheet inline-after external URL: https:\/\/benchmark\.test\/early\.css/);
  assert.match(md, /External-inline-stylesheet inline-after fetch calls: 2/);
  assert.match(md, /External-inline-stylesheet inline-after external fetches: 1/);
  assert.match(md, /External-inline-stylesheet inline-after external resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /External-inline-stylesheet inline-after loaded bytes: 67/);
  assert.match(md, /External-inline-stylesheet inline-after stylesheets: 3/);
  assert.match(md, /External-inline-stylesheet inline-after author stylesheets: 2/);
  assert.match(md, /External-inline-stylesheet inline-after author rules: 2/);
  assert.match(md, /External-inline-stylesheet inline-after author declarations: 4/);
  assert.match(md, /External-inline-stylesheet inline-after decoded images: 0/);
  assert.match(md, /External-inline-stylesheet inline-after painted background: yes/);
  assert.match(md, /External-inline-stylesheet inline-after source-order winner blue: yes/);
  assert.match(md, /External-inline-stylesheet external-after URL: https:\/\/benchmark\.test\/inline-before-external-stylesheet\.html/);
  assert.match(md, /External-inline-stylesheet external-after external URL: https:\/\/benchmark\.test\/late\.css/);
  assert.match(md, /External-inline-stylesheet external-after fetch calls: 2/);
  assert.match(md, /External-inline-stylesheet external-after external fetches: 1/);
  assert.match(md, /External-inline-stylesheet external-after external resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /External-inline-stylesheet external-after loaded bytes: 40/);
  assert.match(md, /External-inline-stylesheet external-after stylesheets: 3/);
  assert.match(md, /External-inline-stylesheet external-after author stylesheets: 2/);
  assert.match(md, /External-inline-stylesheet external-after author rules: 2/);
  assert.match(md, /External-inline-stylesheet external-after author declarations: 4/);
  assert.match(md, /External-inline-stylesheet external-after decoded images: 0/);
  assert.match(md, /External-inline-stylesheet external-after painted background: yes/);
  assert.match(md, /External-inline-stylesheet external-after source-order winner blue: yes/);
  assert.match(md, /Invalid-data-image fetch calls: 1/);
  assert.match(md, /Invalid-data-image external resources: 0 discovered, 0 loaded, 0 missing/);
  assert.match(md, /Invalid-data-image loaded bytes: 0/);
  assert.match(md, /Invalid-data-image decoded images: 0/);
  assert.match(md, /Invalid-data-image painted images: 0/);
  assert.match(md, /Invalid-data-image painted background: yes/);
  assert.match(md, /Invalid-data-stylesheet fetch calls: 1/);
  assert.match(md, /Invalid-data-stylesheet external resources: 0 discovered, 0 loaded, 0 missing/);
  assert.match(md, /Invalid-data-stylesheet loaded bytes: 0/);
  assert.match(md, /Invalid-data-stylesheet stylesheets: 2/);
  assert.match(md, /Invalid-data-stylesheet author stylesheets: 1/);
  assert.match(md, /Invalid-data-stylesheet author rules: 1/);
  assert.match(md, /Invalid-data-stylesheet author declarations: 0/);
  assert.match(md, /Invalid-data-stylesheet decoded images: 0/);
  assert.match(md, /Invalid-data-stylesheet painted background: no/);
  assert.match(md, /Non-css-data-stylesheet fetch calls: 1/);
  assert.match(md, /Non-css-data-stylesheet external resources: 0 discovered, 0 loaded, 0 missing/);
  assert.match(md, /Non-css-data-stylesheet loaded bytes: 0/);
  assert.match(md, /Non-css-data-stylesheet stylesheets: 1/);
  assert.match(md, /Non-css-data-stylesheet author stylesheets: 0/);
  assert.match(md, /Non-css-data-stylesheet author rules: 0/);
  assert.match(md, /Non-css-data-stylesheet author declarations: 0/);
  assert.match(md, /Non-css-data-stylesheet decoded images: 0/);
  assert.match(md, /Non-css-data-stylesheet painted background: no/);
  assert.match(md, /No-href-stylesheet URL: https:\/\/benchmark\.test\/no-href-stylesheet\.html/);
  assert.match(md, /No-href-stylesheet fetch calls: 2/);
  assert.match(md, /No-href-stylesheet external resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /No-href-stylesheet loaded bytes: 67/);
  assert.match(md, /No-href-stylesheet stylesheets: 2/);
  assert.match(md, /No-href-stylesheet author stylesheets: 1/);
  assert.match(md, /No-href-stylesheet author rules: 1/);
  assert.match(md, /No-href-stylesheet author declarations: 3/);
  assert.match(md, /No-href-stylesheet decoded images: 0/);
  assert.match(md, /No-href-stylesheet painted background: yes/);
  assert.match(md, /Empty-href-stylesheet URL: https:\/\/benchmark\.test\/empty-href-stylesheet\.html/);
  assert.match(md, /Empty-href-stylesheet fetch calls: 2/);
  assert.match(md, /Empty-href-stylesheet external resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /Empty-href-stylesheet loaded bytes: 86/);
  assert.match(md, /Empty-href-stylesheet stylesheets: 2/);
  assert.match(md, /Empty-href-stylesheet author stylesheets: 1/);
  assert.match(md, /Empty-href-stylesheet author rules: 0/);
  assert.match(md, /Empty-href-stylesheet author declarations: 0/);
  assert.match(md, /Empty-href-stylesheet decoded images: 0/);
  assert.match(md, /Empty-href-stylesheet painted background: no/);
  assert.match(md, /Fragment-href-stylesheet URL: https:\/\/benchmark\.test\/fragment-href-stylesheet\.html/);
  assert.match(md, /Fragment-href-stylesheet fetch calls: 2/);
  assert.match(md, /Fragment-href-stylesheet external resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /Fragment-href-stylesheet loaded bytes: 92/);
  assert.match(md, /Fragment-href-stylesheet stylesheets: 2/);
  assert.match(md, /Fragment-href-stylesheet author stylesheets: 1/);
  assert.match(md, /Fragment-href-stylesheet author rules: 0/);
  assert.match(md, /Fragment-href-stylesheet author declarations: 0/);
  assert.match(md, /Fragment-href-stylesheet decoded images: 0/);
  assert.match(md, /Fragment-href-stylesheet painted background: no/);
  assert.match(md, /Query-href-stylesheet URL: https:\/\/benchmark\.test\/query-href-stylesheet\.html\?old=1#frag/);
  assert.match(md, /Query-href-stylesheet fetch calls: 2/);
  assert.match(md, /Query-href-stylesheet external resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /Query-href-stylesheet loaded bytes: 92/);
  assert.match(md, /Query-href-stylesheet stylesheets: 2/);
  assert.match(md, /Query-href-stylesheet author stylesheets: 1/);
  assert.match(md, /Query-href-stylesheet author rules: 0/);
  assert.match(md, /Query-href-stylesheet author declarations: 0/);
  assert.match(md, /Query-href-stylesheet decoded images: 0/);
  assert.match(md, /Query-href-stylesheet painted background: no/);
  assert.match(md, /Protocol-relative-stylesheet URL: https:\/\/benchmark\.test\/protocol-relative-stylesheet\.html/);
  assert.match(md, /Protocol-relative-stylesheet fetch calls: 2/);
  assert.match(md, /Protocol-relative-stylesheet external resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /Protocol-relative-stylesheet loaded bytes: 67/);
  assert.match(md, /Protocol-relative-stylesheet stylesheets: 2/);
  assert.match(md, /Protocol-relative-stylesheet author stylesheets: 1/);
  assert.match(md, /Protocol-relative-stylesheet author rules: 1/);
  assert.match(md, /Protocol-relative-stylesheet author declarations: 3/);
  assert.match(md, /Protocol-relative-stylesheet decoded images: 0/);
  assert.match(md, /Protocol-relative-stylesheet painted background: yes/);
  assert.match(md, /Whitespace-rel-stylesheet URL: https:\/\/benchmark\.test\/whitespace-rel-stylesheet\.html/);
  assert.match(md, /Whitespace-rel-stylesheet fetch calls: 3/);
  assert.match(md, /Whitespace-rel-stylesheet external resources: 2 discovered, 2 loaded, 0 missing/);
  assert.match(md, /Whitespace-rel-stylesheet loaded bytes: 107/);
  assert.match(md, /Whitespace-rel-stylesheet stylesheets: 3/);
  assert.match(md, /Whitespace-rel-stylesheet author stylesheets: 2/);
  assert.match(md, /Whitespace-rel-stylesheet author rules: 2/);
  assert.match(md, /Whitespace-rel-stylesheet author declarations: 4/);
  assert.match(md, /Whitespace-rel-stylesheet decoded images: 0/);
  assert.match(md, /Whitespace-rel-stylesheet painted background: yes/);
  assert.match(md, /Whitespace-rel-stylesheet source-order winner blue: yes/);
  assert.match(md, /Whitespace-rel alternate fetch calls: 1/);
  assert.match(md, /Whitespace-rel alternate external resources: 0 discovered, 0 loaded/);
  assert.match(md, /Whitespace-rel alternate author stylesheets: 0/);
  assert.match(md, /Whitespace-rel alternate painted background: no/);
  assert.match(md, /Duplicate-rel-stylesheet URL: https:\/\/benchmark\.test\/duplicate-rel-stylesheet\.html/);
  assert.match(md, /Duplicate-rel-stylesheet fetch calls: 3/);
  assert.match(md, /Duplicate-rel-stylesheet external resources: 2 discovered, 2 loaded, 0 missing/);
  assert.match(md, /Duplicate-rel-stylesheet loaded bytes: 107/);
  assert.match(md, /Duplicate-rel-stylesheet stylesheets: 3/);
  assert.match(md, /Duplicate-rel-stylesheet author stylesheets: 2/);
  assert.match(md, /Duplicate-rel-stylesheet author rules: 2/);
  assert.match(md, /Duplicate-rel-stylesheet author declarations: 4/);
  assert.match(md, /Duplicate-rel-stylesheet decoded images: 0/);
  assert.match(md, /Duplicate-rel-stylesheet painted background: yes/);
  assert.match(md, /Duplicate-rel-stylesheet source-order winner blue: yes/);
  assert.match(md, /Duplicate-rel alternate fetch calls: 1/);
  assert.match(md, /Duplicate-rel alternate external resources: 0 discovered, 0 loaded/);
  assert.match(md, /Duplicate-rel alternate author stylesheets: 0/);
  assert.match(md, /Duplicate-rel alternate painted background: no/);
  assert.match(md, /Whitespace-href-stylesheet URL: https:\/\/benchmark\.test\/whitespace-href-stylesheet\.html/);
  assert.match(md, /Whitespace-href-stylesheet raw href: " \/early\.css "/);
  assert.match(md, /Whitespace-href-stylesheet resolved href: https:\/\/benchmark\.test\/early\.css/);
  assert.match(md, /Whitespace-href-stylesheet loaded resource URL: https:\/\/benchmark\.test\/early\.css/);
  assert.match(md, /Whitespace-href-stylesheet fetch calls: 3/);
  assert.match(md, /Whitespace-href-stylesheet external resources: 2 discovered, 2 loaded, 0 missing/);
  assert.match(md, /Whitespace-href-stylesheet loaded bytes: 107/);
  assert.match(md, /Whitespace-href-stylesheet stylesheets: 3/);
  assert.match(md, /Whitespace-href-stylesheet author stylesheets: 2/);
  assert.match(md, /Whitespace-href-stylesheet author rules: 2/);
  assert.match(md, /Whitespace-href-stylesheet author declarations: 4/);
  assert.match(md, /Whitespace-href-stylesheet decoded images: 0/);
  assert.match(md, /Whitespace-href-stylesheet painted background: yes/);
  assert.match(md, /Whitespace-href-stylesheet source-order winner blue: yes/);
  assert.match(md, /Control-character-href-stylesheet URL: https:\/\/benchmark\.test\/control-character-href-stylesheet\.html/);
  assert.match(md, /Control-character-href-stylesheet raw href JSON: "\\n\\t\/early\.css\\f"/);
  assert.match(md, /Control-character-href-stylesheet resolved href: https:\/\/benchmark\.test\/early\.css/);
  assert.match(md, /Control-character-href-stylesheet loaded resource URL: https:\/\/benchmark\.test\/early\.css/);
  assert.match(md, /Control-character-href-stylesheet fetch calls: 3/);
  assert.match(md, /Control-character-href-stylesheet external resources: 2 discovered, 2 loaded, 0 missing/);
  assert.match(md, /Control-character-href-stylesheet loaded bytes: 107/);
  assert.match(md, /Control-character-href-stylesheet stylesheets: 3/);
  assert.match(md, /Control-character-href-stylesheet author stylesheets: 2/);
  assert.match(md, /Control-character-href-stylesheet author rules: 2/);
  assert.match(md, /Control-character-href-stylesheet author declarations: 4/);
  assert.match(md, /Control-character-href-stylesheet decoded images: 0/);
  assert.match(md, /Control-character-href-stylesheet painted background: yes/);
  assert.match(md, /Control-character-href-stylesheet source-order winner blue: yes/);
  assert.match(md, /Base-href-subresource URL: https:\/\/benchmark\.test\/pages\/base-href-subresource\.html/);
  assert.match(md, /Base-href-subresource raw base href: https:\/\/cdn\.benchmark\.test\/assets\//);
  assert.match(md, /Base-href-subresource resolved base href: https:\/\/cdn\.benchmark\.test\/assets\//);
  assert.match(md, /Base-href-subresource stylesheet href: css\/theme\.css/);
  assert.match(md, /Base-href-subresource image src: img\/pic\.png/);
  assert.match(md, /Base-href-subresource loaded stylesheet URL: https:\/\/cdn\.benchmark\.test\/assets\/css\/theme\.css/);
  assert.match(md, /Base-href-subresource loaded image URL: https:\/\/cdn\.benchmark\.test\/assets\/img\/pic\.png/);
  assert.match(md, /Base-href-subresource fetch calls: 3/);
  assert.match(md, /Base-href-subresource stylesheet fetches: 1/);
  assert.match(md, /Base-href-subresource image fetches: 1/);
  assert.match(md, /Base-href-subresource external resources: 2 discovered, 2 loaded, 0 missing/);
  assert.match(md, /Base-href-subresource loaded bytes: 174/);
  assert.match(md, /Base-href-subresource stylesheets: 2/);
  assert.match(md, /Base-href-subresource author stylesheets: 1/);
  assert.match(md, /Base-href-subresource author rules: 2/);
  assert.match(md, /Base-href-subresource author declarations: 5/);
  assert.match(md, /Base-href-subresource decoded images: 1/);
  assert.match(md, /Base-href-subresource painted background: yes/);
  assert.match(md, /Base-href-subresource painted images: 1/);
  assert.match(md, /Base-href-subresource painted background red: yes/);
  assert.match(md, /Base-href-subresource painted image blue: yes/);
  assert.match(md, /Invalid-url-stylesheet URL: https:\/\/benchmark\.test\/invalid-url-stylesheet\.html/);
  assert.match(md, /Invalid-url-stylesheet fetch calls: 2/);
  assert.match(md, /Invalid-url-stylesheet external resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /Invalid-url-stylesheet loaded bytes: 40/);
  assert.match(md, /Invalid-url-stylesheet stylesheets: 3/);
  assert.match(md, /Invalid-url-stylesheet author stylesheets: 2/);
  assert.match(md, /Invalid-url-stylesheet author rules: 2/);
  assert.match(md, /Invalid-url-stylesheet author declarations: 4/);
  assert.match(md, /Invalid-url-stylesheet decoded images: 0/);
  assert.match(md, /Invalid-url-stylesheet painted background: yes/);
  assert.match(md, /Invalid-url-stylesheet source-order winner blue: yes/);
  assert.match(md, /Invalid-url-only stylesheet fetch calls: 1/);
  assert.match(md, /Invalid-url-only stylesheet external resources: 0 discovered, 0 loaded, 0 missing/);
  assert.match(md, /Invalid-url-only stylesheet author stylesheets: 0/);
  assert.match(md, /Invalid-url-only stylesheet painted background: no/);
  assert.match(md, /Alternate-stylesheet fetch calls: 1/);
  assert.match(md, /Alternate-stylesheet external resources: 0 discovered, 0 loaded, 0 missing/);
  assert.match(md, /Alternate-stylesheet loaded bytes: 0/);
  assert.match(md, /Alternate-stylesheet stylesheets: 1/);
  assert.match(md, /Alternate-stylesheet author stylesheets: 0/);
  assert.match(md, /Alternate-stylesheet author rules: 0/);
  assert.match(md, /Alternate-stylesheet author declarations: 0/);
  assert.match(md, /Alternate-stylesheet decoded images: 0/);
  assert.match(md, /Alternate-stylesheet painted background: no/);
  assert.match(md, /Disabled-stylesheet fetch calls: 1/);
  assert.match(md, /Disabled-stylesheet external resources: 0 discovered, 0 loaded, 0 missing/);
  assert.match(md, /Disabled-stylesheet loaded bytes: 0/);
  assert.match(md, /Disabled-stylesheet stylesheets: 1/);
  assert.match(md, /Disabled-stylesheet author stylesheets: 0/);
  assert.match(md, /Disabled-stylesheet author rules: 0/);
  assert.match(md, /Disabled-stylesheet author declarations: 0/);
  assert.match(md, /Disabled-stylesheet decoded images: 0/);
  assert.match(md, /Disabled-stylesheet painted background: no/);
  assert.match(md, /Print-media-stylesheet fetch calls: 1/);
  assert.match(md, /Print-media-stylesheet external resources: 0 discovered, 0 loaded, 0 missing/);
  assert.match(md, /Print-media-stylesheet loaded bytes: 0/);
  assert.match(md, /Print-media-stylesheet stylesheets: 1/);
  assert.match(md, /Print-media-stylesheet author stylesheets: 0/);
  assert.match(md, /Print-media-stylesheet author rules: 0/);
  assert.match(md, /Print-media-stylesheet author declarations: 0/);
  assert.match(md, /Print-media-stylesheet decoded images: 0/);
  assert.match(md, /Print-media-stylesheet painted background: no/);
  assert.match(md, /Empty media stylesheet media length: 0/);
  assert.match(md, /Empty media stylesheet fetch calls: 2/);
  assert.match(md, /Empty media stylesheet external resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /Empty media stylesheet loaded bytes: 67/);
  assert.match(md, /Empty media stylesheet author stylesheets: 1/);
  assert.match(md, /Empty media stylesheet author rules: 1/);
  assert.match(md, /Empty media stylesheet author declarations: 3/);
  assert.match(md, /Empty media stylesheet painted background: yes/);
  assert.match(md, /Whitespace-only media stylesheet media length: 3/);
  assert.match(md, /Whitespace-only media stylesheet fetch calls: 2/);
  assert.match(md, /Whitespace-only media stylesheet external resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /Whitespace-only media stylesheet loaded bytes: 67/);
  assert.match(md, /Whitespace-only media stylesheet author stylesheets: 1/);
  assert.match(md, /Whitespace-only media stylesheet author rules: 1/);
  assert.match(md, /Whitespace-only media stylesheet author declarations: 3/);
  assert.match(md, /Whitespace-only media stylesheet painted background: yes/);
  assert.match(md, /Media-list stylesheet media: print, screen/);
  assert.match(md, /Media-list stylesheet fetch calls: 2/);
  assert.match(md, /Media-list stylesheet external resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /Media-list stylesheet loaded bytes: 67/);
  assert.match(md, /Media-list stylesheet author stylesheets: 1/);
  assert.match(md, /Media-list stylesheet author rules: 1/);
  assert.match(md, /Media-list stylesheet author declarations: 3/);
  assert.match(md, /Media-list stylesheet painted background: yes/);
  assert.match(md, /Spaced media-list stylesheet media: " print , screen "/);
  assert.match(md, /Spaced media-list stylesheet fetch calls: 2/);
  assert.match(md, /Spaced media-list stylesheet external resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /Spaced media-list stylesheet loaded bytes: 67/);
  assert.match(md, /Spaced media-list stylesheet author stylesheets: 1/);
  assert.match(md, /Spaced media-list stylesheet author rules: 1/);
  assert.match(md, /Spaced media-list stylesheet author declarations: 3/);
  assert.match(md, /Spaced media-list stylesheet painted background: yes/);
  assert.match(md, /Empty item before screen media stylesheet media: , screen/);
  assert.match(md, /Empty item before screen media stylesheet fetch calls: 2/);
  assert.match(md, /Empty item before screen media stylesheet external resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /Empty item before screen media stylesheet loaded bytes: 67/);
  assert.match(md, /Empty item before screen media stylesheet author stylesheets: 1/);
  assert.match(md, /Empty item before screen media stylesheet author rules: 1/);
  assert.match(md, /Empty item before screen media stylesheet author declarations: 3/);
  assert.match(md, /Empty item before screen media stylesheet painted background: yes/);
  assert.match(md, /Empty item after screen media stylesheet media: screen,/);
  assert.match(md, /Empty item after screen media stylesheet fetch calls: 2/);
  assert.match(md, /Empty item after screen media stylesheet external resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /Empty item after screen media stylesheet loaded bytes: 67/);
  assert.match(md, /Empty item after screen media stylesheet author stylesheets: 1/);
  assert.match(md, /Empty item after screen media stylesheet author rules: 1/);
  assert.match(md, /Empty item after screen media stylesheet author declarations: 3/);
  assert.match(md, /Empty item after screen media stylesheet painted background: yes/);
  assert.match(md, /Empty-only media list stylesheet media: ,/);
  assert.match(md, /Empty-only media list stylesheet fetch calls: 1/);
  assert.match(md, /Empty-only media list stylesheet external resources: 0 discovered, 0 loaded, 0 missing/);
  assert.match(md, /Empty-only media list stylesheet loaded bytes: 0/);
  assert.match(md, /Empty-only media list stylesheet author stylesheets: 0/);
  assert.match(md, /Empty-only media list stylesheet author rules: 0/);
  assert.match(md, /Empty-only media list stylesheet author declarations: 0/);
  assert.match(md, /Empty-only media list stylesheet painted background: no/);
  assert.match(md, /Unsupported media-list then screen stylesheet media: \(dynamic-range: high\), screen/);
  assert.match(md, /Unsupported media-list then screen stylesheet fetch calls: 2/);
  assert.match(md, /Unsupported media-list then screen stylesheet external resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /Unsupported media-list then screen stylesheet loaded bytes: 67/);
  assert.match(md, /Unsupported media-list then screen stylesheet author stylesheets: 1/);
  assert.match(md, /Unsupported media-list then screen stylesheet author rules: 1/);
  assert.match(md, /Unsupported media-list then screen stylesheet author declarations: 3/);
  assert.match(md, /Unsupported media-list then screen stylesheet painted background: yes/);
  assert.match(md, /Unsupported media-list only stylesheet media: \(dynamic-range: high\)/);
  assert.match(md, /Unsupported media-list only stylesheet fetch calls: 1/);
  assert.match(md, /Unsupported media-list only stylesheet external resources: 0 discovered, 0 loaded, 0 missing/);
  assert.match(md, /Unsupported media-list only stylesheet loaded bytes: 0/);
  assert.match(md, /Unsupported media-list only stylesheet author stylesheets: 0/);
  assert.match(md, /Unsupported media-list only stylesheet author rules: 0/);
  assert.match(md, /Unsupported media-list only stylesheet author declarations: 0/);
  assert.match(md, /Unsupported media-list only stylesheet painted background: no/);
  assert.match(md, /Unknown media type then screen stylesheet media: projection, screen/);
  assert.match(md, /Unknown media type then screen stylesheet fetch calls: 2/);
  assert.match(md, /Unknown media type then screen stylesheet external resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /Unknown media type then screen stylesheet loaded bytes: 67/);
  assert.match(md, /Unknown media type then screen stylesheet author stylesheets: 1/);
  assert.match(md, /Unknown media type then screen stylesheet author rules: 1/);
  assert.match(md, /Unknown media type then screen stylesheet author declarations: 3/);
  assert.match(md, /Unknown media type then screen stylesheet painted background: yes/);
  assert.match(md, /Unknown media type only stylesheet media: projection/);
  assert.match(md, /Unknown media type only stylesheet fetch calls: 1/);
  assert.match(md, /Unknown media type only stylesheet external resources: 0 discovered, 0 loaded, 0 missing/);
  assert.match(md, /Unknown media type only stylesheet loaded bytes: 0/);
  assert.match(md, /Unknown media type only stylesheet author stylesheets: 0/);
  assert.match(md, /Unknown media type only stylesheet author rules: 0/);
  assert.match(md, /Unknown media type only stylesheet author declarations: 0/);
  assert.match(md, /Unknown media type only stylesheet painted background: no/);
  assert.match(md, /Uppercase screen media stylesheet media: SCREEN/);
  assert.match(md, /Uppercase screen media stylesheet fetch calls: 2/);
  assert.match(md, /Uppercase screen media stylesheet external resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /Uppercase screen media stylesheet loaded bytes: 67/);
  assert.match(md, /Uppercase screen media stylesheet author stylesheets: 1/);
  assert.match(md, /Uppercase screen media stylesheet author rules: 1/);
  assert.match(md, /Uppercase screen media stylesheet author declarations: 3/);
  assert.match(md, /Uppercase screen media stylesheet painted background: yes/);
  assert.match(md, /Mixed-case only-screen media stylesheet media: Only Screen/);
  assert.match(md, /Mixed-case only-screen media stylesheet fetch calls: 2/);
  assert.match(md, /Mixed-case only-screen media stylesheet external resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /Mixed-case only-screen media stylesheet loaded bytes: 67/);
  assert.match(md, /Mixed-case only-screen media stylesheet author stylesheets: 1/);
  assert.match(md, /Mixed-case only-screen media stylesheet author rules: 1/);
  assert.match(md, /Mixed-case only-screen media stylesheet author declarations: 3/);
  assert.match(md, /Mixed-case only-screen media stylesheet painted background: yes/);
  assert.match(md, /Spaced only-screen media stylesheet media: only {3}screen/);
  assert.match(md, /Spaced only-screen media stylesheet fetch calls: 2/);
  assert.match(md, /Spaced only-screen media stylesheet external resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /Spaced only-screen media stylesheet loaded bytes: 67/);
  assert.match(md, /Spaced only-screen media stylesheet author stylesheets: 1/);
  assert.match(md, /Spaced only-screen media stylesheet author rules: 1/);
  assert.match(md, /Spaced only-screen media stylesheet author declarations: 3/);
  assert.match(md, /Spaced only-screen media stylesheet painted background: yes/);
  assert.match(md, /Uppercase print media stylesheet media: PRINT/);
  assert.match(md, /Uppercase print media stylesheet fetch calls: 1/);
  assert.match(md, /Uppercase print media stylesheet external resources: 0 discovered, 0 loaded, 0 missing/);
  assert.match(md, /Uppercase print media stylesheet loaded bytes: 0/);
  assert.match(md, /Uppercase print media stylesheet author stylesheets: 0/);
  assert.match(md, /Uppercase print media stylesheet author rules: 0/);
  assert.match(md, /Uppercase print media stylesheet author declarations: 0/);
  assert.match(md, /Uppercase print media stylesheet painted background: no/);
  assert.match(md, /Not-print stylesheet media: not print/);
  assert.match(md, /Not-print stylesheet fetch calls: 2/);
  assert.match(md, /Not-print stylesheet external resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /Not-print stylesheet loaded bytes: 67/);
  assert.match(md, /Not-print stylesheet author stylesheets: 1/);
  assert.match(md, /Not-print stylesheet author rules: 1/);
  assert.match(md, /Not-print stylesheet author declarations: 3/);
  assert.match(md, /Not-print stylesheet painted background: yes/);
  assert.match(md, /Spaced not-print stylesheet media: not {3}print/);
  assert.match(md, /Spaced not-print stylesheet fetch calls: 2/);
  assert.match(md, /Spaced not-print stylesheet external resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /Spaced not-print stylesheet loaded bytes: 67/);
  assert.match(md, /Spaced not-print stylesheet author stylesheets: 1/);
  assert.match(md, /Spaced not-print stylesheet author rules: 1/);
  assert.match(md, /Spaced not-print stylesheet author declarations: 3/);
  assert.match(md, /Spaced not-print stylesheet painted background: yes/);
  assert.match(md, /Only-print stylesheet media: only print/);
  assert.match(md, /Only-print stylesheet fetch calls: 1/);
  assert.match(md, /Only-print stylesheet external resources: 0 discovered, 0 loaded, 0 missing/);
  assert.match(md, /Only-print stylesheet loaded bytes: 0/);
  assert.match(md, /Only-print stylesheet author stylesheets: 0/);
  assert.match(md, /Only-print stylesheet author rules: 0/);
  assert.match(md, /Only-print stylesheet author declarations: 0/);
  assert.match(md, /Only-print stylesheet painted background: no/);
  assert.match(md, /Spaced only-print stylesheet media: only {3}print/);
  assert.match(md, /Spaced only-print stylesheet fetch calls: 1/);
  assert.match(md, /Spaced only-print stylesheet external resources: 0 discovered, 0 loaded, 0 missing/);
  assert.match(md, /Spaced only-print stylesheet loaded bytes: 0/);
  assert.match(md, /Spaced only-print stylesheet author stylesheets: 0/);
  assert.match(md, /Spaced only-print stylesheet author rules: 0/);
  assert.match(md, /Spaced only-print stylesheet author declarations: 0/);
  assert.match(md, /Spaced only-print stylesheet painted background: no/);
  assert.match(md, /All media stylesheet media: all/);
  assert.match(md, /All media stylesheet fetch calls: 2/);
  assert.match(md, /All media stylesheet external resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /All media stylesheet loaded bytes: 67/);
  assert.match(md, /All media stylesheet author stylesheets: 1/);
  assert.match(md, /All media stylesheet author rules: 1/);
  assert.match(md, /All media stylesheet author declarations: 3/);
  assert.match(md, /All media stylesheet painted background: yes/);
  assert.match(md, /Only-all stylesheet media: only all/);
  assert.match(md, /Only-all stylesheet fetch calls: 2/);
  assert.match(md, /Only-all stylesheet external resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /Only-all stylesheet loaded bytes: 67/);
  assert.match(md, /Only-all stylesheet author stylesheets: 1/);
  assert.match(md, /Only-all stylesheet author rules: 1/);
  assert.match(md, /Only-all stylesheet author declarations: 3/);
  assert.match(md, /Only-all stylesheet painted background: yes/);
  assert.match(md, /Not-all stylesheet media: not all/);
  assert.match(md, /Not-all stylesheet fetch calls: 1/);
  assert.match(md, /Not-all stylesheet external resources: 0 discovered, 0 loaded, 0 missing/);
  assert.match(md, /Not-all stylesheet loaded bytes: 0/);
  assert.match(md, /Not-all stylesheet author stylesheets: 0/);
  assert.match(md, /Not-all stylesheet author rules: 0/);
  assert.match(md, /Not-all stylesheet author declarations: 0/);
  assert.match(md, /Not-all stylesheet painted background: no/);
  assert.match(md, /Spaced not-all stylesheet media: not {3}all/);
  assert.match(md, /Spaced not-all stylesheet fetch calls: 1/);
  assert.match(md, /Spaced not-all stylesheet external resources: 0 discovered, 0 loaded, 0 missing/);
  assert.match(md, /Spaced not-all stylesheet loaded bytes: 0/);
  assert.match(md, /Spaced not-all stylesheet author stylesheets: 0/);
  assert.match(md, /Spaced not-all stylesheet author rules: 0/);
  assert.match(md, /Spaced not-all stylesheet author declarations: 0/);
  assert.match(md, /Spaced not-all stylesheet painted background: no/);
  assert.match(md, /Media-feature min-width stylesheet media: screen and \(min-width: 1px\)/);
  assert.match(md, /Media-feature min-width stylesheet fetch calls: 2/);
  assert.match(md, /Media-feature min-width stylesheet external resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /Media-feature min-width stylesheet loaded bytes: 67/);
  assert.match(md, /Media-feature min-width stylesheet author stylesheets: 1/);
  assert.match(md, /Media-feature min-width stylesheet author rules: 1/);
  assert.match(md, /Media-feature min-width stylesheet author declarations: 3/);
  assert.match(md, /Media-feature min-width stylesheet painted background: yes/);
  assert.match(md, /Uppercase media-feature min-width stylesheet media: screen and \(MIN-WIDTH: 1px\)/);
  assert.match(md, /Uppercase media-feature min-width stylesheet fetch calls: 2/);
  assert.match(md, /Uppercase media-feature min-width stylesheet external resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /Uppercase media-feature min-width stylesheet loaded bytes: 67/);
  assert.match(md, /Uppercase media-feature min-width stylesheet author stylesheets: 1/);
  assert.match(md, /Uppercase media-feature min-width stylesheet author rules: 1/);
  assert.match(md, /Uppercase media-feature min-width stylesheet author declarations: 3/);
  assert.match(md, /Uppercase media-feature min-width stylesheet painted background: yes/);
  assert.match(md, /Decimal media-feature min-width stylesheet media: screen and \(min-width: 799\.5px\)/);
  assert.match(md, /Decimal media-feature min-width stylesheet fetch calls: 2/);
  assert.match(md, /Decimal media-feature min-width stylesheet external resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /Decimal media-feature min-width stylesheet loaded bytes: 67/);
  assert.match(md, /Decimal media-feature min-width stylesheet author stylesheets: 1/);
  assert.match(md, /Decimal media-feature min-width stylesheet author rules: 1/);
  assert.match(md, /Decimal media-feature min-width stylesheet author declarations: 3/);
  assert.match(md, /Decimal media-feature min-width stylesheet painted background: yes/);
  assert.match(md, /Spaced media-feature min-width stylesheet media: screen {2}and {2}\( min-width : 1px \)/);
  assert.match(md, /Spaced media-feature min-width stylesheet fetch calls: 2/);
  assert.match(md, /Spaced media-feature min-width stylesheet external resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /Spaced media-feature min-width stylesheet loaded bytes: 67/);
  assert.match(md, /Spaced media-feature min-width stylesheet author stylesheets: 1/);
  assert.match(md, /Spaced media-feature min-width stylesheet author rules: 1/);
  assert.match(md, /Spaced media-feature min-width stylesheet author declarations: 3/);
  assert.match(md, /Spaced media-feature min-width stylesheet painted background: yes/);
  assert.match(md, /Media-feature bare-min-width stylesheet media: \(min-width: 1px\)/);
  assert.match(md, /Media-feature bare-min-width stylesheet fetch calls: 2/);
  assert.match(md, /Media-feature bare-min-width stylesheet external resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /Media-feature bare-min-width stylesheet loaded bytes: 67/);
  assert.match(md, /Media-feature bare-min-width stylesheet author stylesheets: 1/);
  assert.match(md, /Media-feature bare-min-width stylesheet author rules: 1/);
  assert.match(md, /Media-feature bare-min-width stylesheet author declarations: 3/);
  assert.match(md, /Media-feature bare-min-width stylesheet painted background: yes/);
  assert.match(md, /All-and media-feature min-width stylesheet media: all and \(min-width: 1px\)/);
  assert.match(md, /All-and media-feature min-width stylesheet fetch calls: 2/);
  assert.match(md, /All-and media-feature min-width stylesheet external resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /All-and media-feature min-width stylesheet loaded bytes: 67/);
  assert.match(md, /All-and media-feature min-width stylesheet author stylesheets: 1/);
  assert.match(md, /All-and media-feature min-width stylesheet author rules: 1/);
  assert.match(md, /All-and media-feature min-width stylesheet author declarations: 3/);
  assert.match(md, /All-and media-feature min-width stylesheet painted background: yes/);
  assert.match(md, /All-and media-feature max-width stylesheet media: all and \(max-width: 1px\)/);
  assert.match(md, /All-and media-feature max-width stylesheet fetch calls: 1/);
  assert.match(md, /All-and media-feature max-width stylesheet external resources: 0 discovered, 0 loaded, 0 missing/);
  assert.match(md, /All-and media-feature max-width stylesheet loaded bytes: 0/);
  assert.match(md, /All-and media-feature max-width stylesheet author stylesheets: 0/);
  assert.match(md, /All-and media-feature max-width stylesheet author rules: 0/);
  assert.match(md, /All-and media-feature max-width stylesheet author declarations: 0/);
  assert.match(md, /All-and media-feature max-width stylesheet painted background: no/);
  assert.match(md, /Only-all-and media-feature min-width stylesheet media: only all and \(min-width: 1px\)/);
  assert.match(md, /Only-all-and media-feature min-width stylesheet fetch calls: 2/);
  assert.match(md, /Only-all-and media-feature min-width stylesheet external resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /Only-all-and media-feature min-width stylesheet loaded bytes: 67/);
  assert.match(md, /Only-all-and media-feature min-width stylesheet author stylesheets: 1/);
  assert.match(md, /Only-all-and media-feature min-width stylesheet author rules: 1/);
  assert.match(md, /Only-all-and media-feature min-width stylesheet author declarations: 3/);
  assert.match(md, /Only-all-and media-feature min-width stylesheet painted background: yes/);
  assert.match(md, /Unsupported range media-feature stylesheet media: screen and \(width >= 1px\)/);
  assert.match(md, /Unsupported range media-feature stylesheet fetch calls: 1/);
  assert.match(md, /Unsupported range media-feature stylesheet external resources: 0 discovered, 0 loaded, 0 missing/);
  assert.match(md, /Unsupported range media-feature stylesheet loaded bytes: 0/);
  assert.match(md, /Unsupported range media-feature stylesheet author stylesheets: 0/);
  assert.match(md, /Unsupported range media-feature stylesheet author rules: 0/);
  assert.match(md, /Unsupported range media-feature stylesheet author declarations: 0/);
  assert.match(md, /Unsupported range media-feature stylesheet painted background: no/);
  assert.match(md, /Unsupported range then screen stylesheet media: \(width >= 1px\), screen/);
  assert.match(md, /Unsupported range then screen stylesheet fetch calls: 2/);
  assert.match(md, /Unsupported range then screen stylesheet external resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /Unsupported range then screen stylesheet loaded bytes: 67/);
  assert.match(md, /Unsupported range then screen stylesheet author stylesheets: 1/);
  assert.match(md, /Unsupported range then screen stylesheet author rules: 1/);
  assert.match(md, /Unsupported range then screen stylesheet author declarations: 3/);
  assert.match(md, /Unsupported range then screen stylesheet painted background: yes/);
  assert.match(md, /Unsupported calc media-feature stylesheet media: screen and \(min-width: calc\(1px\)\)/);
  assert.match(md, /Unsupported calc media-feature stylesheet fetch calls: 1/);
  assert.match(md, /Unsupported calc media-feature stylesheet external resources: 0 discovered, 0 loaded, 0 missing/);
  assert.match(md, /Unsupported calc media-feature stylesheet loaded bytes: 0/);
  assert.match(md, /Unsupported calc media-feature stylesheet author stylesheets: 0/);
  assert.match(md, /Unsupported calc media-feature stylesheet author rules: 0/);
  assert.match(md, /Unsupported calc media-feature stylesheet author declarations: 0/);
  assert.match(md, /Unsupported calc media-feature stylesheet painted background: no/);
  assert.match(md, /Unsupported hover media-feature stylesheet media: screen and \(hover: hover\)/);
  assert.match(md, /Unsupported hover media-feature stylesheet fetch calls: 1/);
  assert.match(md, /Unsupported hover media-feature stylesheet external resources: 0 discovered, 0 loaded, 0 missing/);
  assert.match(md, /Unsupported hover media-feature stylesheet loaded bytes: 0/);
  assert.match(md, /Unsupported hover media-feature stylesheet author stylesheets: 0/);
  assert.match(md, /Unsupported hover media-feature stylesheet author rules: 0/);
  assert.match(md, /Unsupported hover media-feature stylesheet author declarations: 0/);
  assert.match(md, /Unsupported hover media-feature stylesheet painted background: no/);
  assert.match(md, /Invalid empty media-feature stylesheet media: screen and \(\)/);
  assert.match(md, /Invalid empty media-feature stylesheet fetch calls: 1/);
  assert.match(md, /Invalid empty media-feature stylesheet external resources: 0 discovered, 0 loaded, 0 missing/);
  assert.match(md, /Invalid empty media-feature stylesheet loaded bytes: 0/);
  assert.match(md, /Invalid empty media-feature stylesheet author stylesheets: 0/);
  assert.match(md, /Invalid empty media-feature stylesheet author rules: 0/);
  assert.match(md, /Invalid empty media-feature stylesheet author declarations: 0/);
  assert.match(md, /Invalid empty media-feature stylesheet painted background: no/);
  assert.match(md, /Unsupported boolean width media-feature stylesheet media: screen and \(width\)/);
  assert.match(md, /Unsupported boolean width media-feature stylesheet fetch calls: 1/);
  assert.match(md, /Unsupported boolean width media-feature stylesheet external resources: 0 discovered, 0 loaded, 0 missing/);
  assert.match(md, /Unsupported boolean width media-feature stylesheet loaded bytes: 0/);
  assert.match(md, /Unsupported boolean width media-feature stylesheet author stylesheets: 0/);
  assert.match(md, /Unsupported boolean width media-feature stylesheet author rules: 0/);
  assert.match(md, /Unsupported boolean width media-feature stylesheet author declarations: 0/);
  assert.match(md, /Unsupported boolean width media-feature stylesheet painted background: no/);
  assert.match(md, /Unknown media-feature stylesheet media: screen and \(unknown-feature\)/);
  assert.match(md, /Unknown media-feature stylesheet fetch calls: 1/);
  assert.match(md, /Unknown media-feature stylesheet external resources: 0 discovered, 0 loaded, 0 missing/);
  assert.match(md, /Unknown media-feature stylesheet loaded bytes: 0/);
  assert.match(md, /Unknown media-feature stylesheet author stylesheets: 0/);
  assert.match(md, /Unknown media-feature stylesheet author rules: 0/);
  assert.match(md, /Unknown media-feature stylesheet author declarations: 0/);
  assert.match(md, /Unknown media-feature stylesheet painted background: no/);
  assert.match(md, /Invalid empty feature then screen stylesheet media: screen and \(\), screen/);
  assert.match(md, /Invalid empty feature then screen stylesheet fetch calls: 2/);
  assert.match(md, /Invalid empty feature then screen stylesheet external resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /Invalid empty feature then screen stylesheet loaded bytes: 67/);
  assert.match(md, /Invalid empty feature then screen stylesheet author stylesheets: 1/);
  assert.match(md, /Invalid empty feature then screen stylesheet author rules: 1/);
  assert.match(md, /Invalid empty feature then screen stylesheet author declarations: 3/);
  assert.match(md, /Invalid empty feature then screen stylesheet painted background: yes/);
  assert.match(md, /Media-feature max-width stylesheet media: screen and \(max-width: 1px\)/);
  assert.match(md, /Media-feature max-width stylesheet fetch calls: 1/);
  assert.match(md, /Media-feature max-width stylesheet external resources: 0 discovered, 0 loaded, 0 missing/);
  assert.match(md, /Media-feature max-width stylesheet loaded bytes: 0/);
  assert.match(md, /Media-feature max-width stylesheet author stylesheets: 0/);
  assert.match(md, /Media-feature max-width stylesheet author rules: 0/);
  assert.match(md, /Media-feature max-width stylesheet author declarations: 0/);
  assert.match(md, /Media-feature max-width stylesheet painted background: no/);
  assert.match(md, /Decimal media-feature max-width stylesheet media: screen and \(max-width: 799\.5px\)/);
  assert.match(md, /Decimal media-feature max-width stylesheet fetch calls: 1/);
  assert.match(md, /Decimal media-feature max-width stylesheet external resources: 0 discovered, 0 loaded, 0 missing/);
  assert.match(md, /Decimal media-feature max-width stylesheet loaded bytes: 0/);
  assert.match(md, /Decimal media-feature max-width stylesheet author stylesheets: 0/);
  assert.match(md, /Decimal media-feature max-width stylesheet author rules: 0/);
  assert.match(md, /Decimal media-feature max-width stylesheet author declarations: 0/);
  assert.match(md, /Decimal media-feature max-width stylesheet painted background: no/);
  assert.match(md, /Spaced media-feature max-width stylesheet media: screen {2}and {2}\( max-width : 1px \)/);
  assert.match(md, /Spaced media-feature max-width stylesheet fetch calls: 1/);
  assert.match(md, /Spaced media-feature max-width stylesheet external resources: 0 discovered, 0 loaded, 0 missing/);
  assert.match(md, /Spaced media-feature max-width stylesheet loaded bytes: 0/);
  assert.match(md, /Spaced media-feature max-width stylesheet author stylesheets: 0/);
  assert.match(md, /Spaced media-feature max-width stylesheet author rules: 0/);
  assert.match(md, /Spaced media-feature max-width stylesheet author declarations: 0/);
  assert.match(md, /Spaced media-feature max-width stylesheet painted background: no/);
  assert.match(md, /Media-feature min-height stylesheet media: screen and \(min-height: 1px\)/);
  assert.match(md, /Media-feature min-height stylesheet fetch calls: 2/);
  assert.match(md, /Media-feature min-height stylesheet external resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /Media-feature min-height stylesheet loaded bytes: 67/);
  assert.match(md, /Media-feature min-height stylesheet author stylesheets: 1/);
  assert.match(md, /Media-feature min-height stylesheet author rules: 1/);
  assert.match(md, /Media-feature min-height stylesheet author declarations: 3/);
  assert.match(md, /Media-feature min-height stylesheet painted background: yes/);
  assert.match(md, /Media-feature max-height stylesheet media: screen and \(max-height: 1px\)/);
  assert.match(md, /Media-feature max-height stylesheet fetch calls: 1/);
  assert.match(md, /Media-feature max-height stylesheet external resources: 0 discovered, 0 loaded, 0 missing/);
  assert.match(md, /Media-feature max-height stylesheet loaded bytes: 0/);
  assert.match(md, /Media-feature max-height stylesheet author stylesheets: 0/);
  assert.match(md, /Media-feature max-height stylesheet author rules: 0/);
  assert.match(md, /Media-feature max-height stylesheet author declarations: 0/);
  assert.match(md, /Media-feature max-height stylesheet painted background: no/);
  assert.match(md, /Media-feature exact-width stylesheet media: screen and \(width: 800px\)/);
  assert.match(md, /Media-feature exact-width stylesheet fetch calls: 2/);
  assert.match(md, /Media-feature exact-width stylesheet external resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /Media-feature exact-width stylesheet loaded bytes: 67/);
  assert.match(md, /Media-feature exact-width stylesheet author stylesheets: 1/);
  assert.match(md, /Media-feature exact-width stylesheet author rules: 1/);
  assert.match(md, /Media-feature exact-width stylesheet author declarations: 3/);
  assert.match(md, /Media-feature exact-width stylesheet painted background: yes/);
  assert.match(md, /Decimal media-feature exact-width stylesheet media: screen and \(width: 800\.0px\)/);
  assert.match(md, /Decimal media-feature exact-width stylesheet fetch calls: 2/);
  assert.match(md, /Decimal media-feature exact-width stylesheet external resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /Decimal media-feature exact-width stylesheet loaded bytes: 67/);
  assert.match(md, /Decimal media-feature exact-width stylesheet author stylesheets: 1/);
  assert.match(md, /Decimal media-feature exact-width stylesheet author rules: 1/);
  assert.match(md, /Decimal media-feature exact-width stylesheet author declarations: 3/);
  assert.match(md, /Decimal media-feature exact-width stylesheet painted background: yes/);
  assert.match(md, /Media-feature exact-height stylesheet media: screen and \(height: 600px\)/);
  assert.match(md, /Media-feature exact-height stylesheet fetch calls: 2/);
  assert.match(md, /Media-feature exact-height stylesheet external resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /Media-feature exact-height stylesheet loaded bytes: 67/);
  assert.match(md, /Media-feature exact-height stylesheet author stylesheets: 1/);
  assert.match(md, /Media-feature exact-height stylesheet author rules: 1/);
  assert.match(md, /Media-feature exact-height stylesheet author declarations: 3/);
  assert.match(md, /Media-feature exact-height stylesheet painted background: yes/);
  assert.match(md, /Media-feature exact-height miss stylesheet media: screen and \(height: 1px\)/);
  assert.match(md, /Media-feature exact-height miss stylesheet fetch calls: 1/);
  assert.match(md, /Media-feature exact-height miss stylesheet external resources: 0 discovered, 0 loaded, 0 missing/);
  assert.match(md, /Media-feature exact-height miss stylesheet loaded bytes: 0/);
  assert.match(md, /Media-feature exact-height miss stylesheet author stylesheets: 0/);
  assert.match(md, /Media-feature exact-height miss stylesheet author rules: 0/);
  assert.match(md, /Media-feature exact-height miss stylesheet author declarations: 0/);
  assert.match(md, /Media-feature exact-height miss stylesheet painted background: no/);
  assert.match(md, /Media-feature negated matching stylesheet media: not screen and \(min-width: 1px\)/);
  assert.match(md, /Media-feature negated matching stylesheet fetch calls: 1/);
  assert.match(md, /Media-feature negated matching stylesheet external resources: 0 discovered, 0 loaded, 0 missing/);
  assert.match(md, /Media-feature negated matching stylesheet loaded bytes: 0/);
  assert.match(md, /Media-feature negated matching stylesheet author stylesheets: 0/);
  assert.match(md, /Media-feature negated matching stylesheet author rules: 0/);
  assert.match(md, /Media-feature negated matching stylesheet author declarations: 0/);
  assert.match(md, /Media-feature negated matching stylesheet painted background: no/);
  assert.match(md, /Media-feature negated missing stylesheet media: not screen and \(max-width: 1px\)/);
  assert.match(md, /Media-feature negated missing stylesheet fetch calls: 2/);
  assert.match(md, /Media-feature negated missing stylesheet external resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /Media-feature negated missing stylesheet loaded bytes: 67/);
  assert.match(md, /Media-feature negated missing stylesheet author stylesheets: 1/);
  assert.match(md, /Media-feature negated missing stylesheet author rules: 1/);
  assert.match(md, /Media-feature negated missing stylesheet author declarations: 3/);
  assert.match(md, /Media-feature negated missing stylesheet painted background: yes/);
  assert.match(md, /Orientation landscape stylesheet media: screen and \(orientation: landscape\)/);
  assert.match(md, /Orientation landscape stylesheet fetch calls: 2/);
  assert.match(md, /Orientation landscape stylesheet external resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /Orientation landscape stylesheet loaded bytes: 67/);
  assert.match(md, /Orientation landscape stylesheet author stylesheets: 1/);
  assert.match(md, /Orientation landscape stylesheet author rules: 1/);
  assert.match(md, /Orientation landscape stylesheet author declarations: 3/);
  assert.match(md, /Orientation landscape stylesheet painted background: yes/);
  assert.match(md, /Uppercase orientation landscape stylesheet media: screen and \(ORIENTATION: LANDSCAPE\)/);
  assert.match(md, /Uppercase orientation landscape stylesheet fetch calls: 2/);
  assert.match(md, /Uppercase orientation landscape stylesheet external resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /Uppercase orientation landscape stylesheet loaded bytes: 67/);
  assert.match(md, /Uppercase orientation landscape stylesheet author stylesheets: 1/);
  assert.match(md, /Uppercase orientation landscape stylesheet author rules: 1/);
  assert.match(md, /Uppercase orientation landscape stylesheet author declarations: 3/);
  assert.match(md, /Uppercase orientation landscape stylesheet painted background: yes/);
  assert.match(md, /Orientation portrait stylesheet media: screen and \(orientation: portrait\)/);
  assert.match(md, /Orientation portrait stylesheet fetch calls: 1/);
  assert.match(md, /Orientation portrait stylesheet external resources: 0 discovered, 0 loaded, 0 missing/);
  assert.match(md, /Orientation portrait stylesheet loaded bytes: 0/);
  assert.match(md, /Orientation portrait stylesheet author stylesheets: 0/);
  assert.match(md, /Orientation portrait stylesheet author rules: 0/);
  assert.match(md, /Orientation portrait stylesheet author declarations: 0/);
  assert.match(md, /Orientation portrait stylesheet painted background: no/);
  assert.match(md, /Uppercase orientation portrait stylesheet media: screen and \(ORIENTATION: PORTRAIT\)/);
  assert.match(md, /Uppercase orientation portrait stylesheet fetch calls: 1/);
  assert.match(md, /Uppercase orientation portrait stylesheet external resources: 0 discovered, 0 loaded, 0 missing/);
  assert.match(md, /Uppercase orientation portrait stylesheet loaded bytes: 0/);
  assert.match(md, /Uppercase orientation portrait stylesheet author stylesheets: 0/);
  assert.match(md, /Uppercase orientation portrait stylesheet author rules: 0/);
  assert.match(md, /Uppercase orientation portrait stylesheet author declarations: 0/);
  assert.match(md, /Uppercase orientation portrait stylesheet painted background: no/);
  assert.match(md, /Combined media-feature stylesheet media: screen and \(min-width: 1px\) and \(orientation: landscape\)/);
  assert.match(md, /Combined media-feature stylesheet fetch calls: 2/);
  assert.match(md, /Combined media-feature stylesheet external resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /Combined media-feature stylesheet loaded bytes: 67/);
  assert.match(md, /Combined media-feature stylesheet author stylesheets: 1/);
  assert.match(md, /Combined media-feature stylesheet author rules: 1/);
  assert.match(md, /Combined media-feature stylesheet author declarations: 3/);
  assert.match(md, /Combined media-feature stylesheet painted background: yes/);
  assert.match(md, /Combined media-feature miss stylesheet media: screen and \(min-width: 1px\) and \(orientation: portrait\)/);
  assert.match(md, /Combined media-feature miss stylesheet fetch calls: 1/);
  assert.match(md, /Combined media-feature miss stylesheet external resources: 0 discovered, 0 loaded, 0 missing/);
  assert.match(md, /Combined media-feature miss stylesheet loaded bytes: 0/);
  assert.match(md, /Combined media-feature miss stylesheet author stylesheets: 0/);
  assert.match(md, /Combined media-feature miss stylesheet author rules: 0/);
  assert.match(md, /Combined media-feature miss stylesheet author declarations: 0/);
  assert.match(md, /Combined media-feature miss stylesheet painted background: no/);
  assert.match(md, /Invalid-external-stylesheet resources: 1 discovered, 1 loaded, 0 missing/);
  assert.match(md, /Invalid-external-stylesheet loaded bytes: 76/);
  assert.match(md, /Invalid-external-stylesheet stylesheets: 2/);
  assert.match(md, /Invalid-external-stylesheet author stylesheets: 1/);
  assert.match(md, /Invalid-external-stylesheet author rules: 1/);
  assert.match(md, /Invalid-external-stylesheet author declarations: 0/);
  assert.match(md, /Invalid-external-stylesheet decoded images: 0/);
  assert.match(md, /Invalid-external-stylesheet painted background: no/);
  assert.match(md, /Missing-stylesheet-only resources: 1 discovered, 0 loaded, 1 missing/);
  assert.match(md, /Missing-stylesheet-only stylesheets: 1/);
  assert.match(md, /Missing-stylesheet-only author stylesheets: 0/);
  assert.match(md, /Missing-stylesheet-only author rules: 0/);
  assert.match(md, /Missing-stylesheet-only author declarations: 0/);
  assert.match(md, /Missing-stylesheet-only painted background: no/);
  assert.match(md, /## Real-site smoke evidence/);
  assert.match(md, /Smoke outcomes: 2 passed, 0 failed/);
  assert.match(md, /Covered capabilities: event-loop-microtask, fetch, font-face, v8-guest-execution/);
  assert.match(md, /\| smoke\/fetch-json-roundtrip \| event-loop-microtask, fetch, v8-guest-execution \| PASS \|/);
  assert.match(md, /\| smoke\/web-font-applied \| fetch, font-face \| PASS \|/);
  // Headline leads with a WIN dimension.
  assert.match(md, /Headline[\s\S]*compat-per-LOC/);
  // A real citation URL is shown.
  assert.match(md, /webkit\.org\/blog\/16413/);
});

// ---------------------------------------------------------------------------
// Req 1.4 — the live WPT pass count comes from running the subset.
// ---------------------------------------------------------------------------

void test("Req 1.4: the self-test subset runs live and every check passes", () => {
  const passes = liveWptPassCount();
  assert.equal(passes, BENCHMARK_SELF_TEST_SUBSET.length, "every self-test check passes live");
  assert.ok(passes > 0);
});

void test("maintained WPT trace evidence is collected live", async () => {
  const evidence = await collectExecutionEvidence(REPO_ROOT);
  assert.ok(evidence.subsetCount >= 2);
  assert.ok(evidence.files > 0);
  assert.equal(evidence.failed, 0);
  assert.equal(evidence.errored, 0);
  assert.ok(evidence.queryCalls > 0);
  assert.ok(evidence.recomputes > 0);
  assert.ok(evidence.cacheHits > 0);
  assert.ok(evidence.dependencyReads > 0);
  assert.ok(evidence.tracedStages.includes("qFinePaint"));
  assert.ok(evidence.incrementalEdit.queryCalls > 0);
  assert.ok(evidence.incrementalEdit.recomputes > 0);
  assert.ok(evidence.incrementalEdit.cacheHits > 0);
  assert.ok(evidence.incrementalEdit.verifiedCacheHits > 0);
  assert.equal(evidence.incrementalEdit.paintOnlyReusedLayout, true);
  assert.equal(evidence.incrementalEdit.layoutEditRecomputedLayout, true);
  assert.equal(evidence.incrementalEdit.noMutationRecomputes, 0);
  assert.ok(evidence.incrementalEdit.steps.some((step) => step.name === "paint-only-edit" && step.verifiedCacheHits > 0));
  assert.ok(evidence.scriptDrivenEdit.queryCalls > 0);
  assert.ok(evidence.scriptDrivenEdit.recomputes > 0);
  assert.ok(evidence.scriptDrivenEdit.cacheHits > 0);
  assert.ok(evidence.scriptDrivenEdit.verifiedCacheHits > 0);
  assert.ok(evidence.scriptDrivenEdit.scriptMutations >= 4);
  assert.equal(evidence.scriptDrivenEdit.paintOnlyReusedLayout, true);
  assert.equal(evidence.scriptDrivenEdit.layoutEditRecomputedLayout, true);
  assert.equal(evidence.scriptDrivenEdit.appendChildIncreasedNodes, true);
  assert.equal(evidence.scriptDrivenEdit.appendedNodePainted, true);
  assert.ok(evidence.scriptDrivenEdit.steps.some((step) => step.name === "script-paint-only" && step.mutations === 1));
  assert.ok(evidence.scriptDrivenEdit.steps.some((step) => step.name === "script-append-child" && step.mutations >= 3));
  assert.equal(evidence.resourceLoadedPage.discoveredResources, 3);
  assert.equal(evidence.resourceLoadedPage.loadedResources, 2);
  assert.equal(evidence.resourceLoadedPage.missingResources, 1);
  assert.equal(evidence.resourceLoadedPage.stylesheetCount, 2);
  assert.equal(evidence.resourceLoadedPage.decodedImageCount, 1);
  assert.ok(evidence.resourceLoadedPage.displayCommands > 0);
  assert.ok(evidence.resourceLoadedPage.paintOps.includes("image"));
  assert.ok(evidence.resourceLoadedPage.pngBytes > 0);
  assert.equal(evidence.resourceLoadedPage.missingImage.discoveredResources, 1);
  assert.equal(evidence.resourceLoadedPage.missingImage.loadedResources, 0);
  assert.equal(evidence.resourceLoadedPage.missingImage.missingResources, 1);
  assert.equal(evidence.resourceLoadedPage.missingImage.loadedBytes, 0);
  assert.equal(evidence.resourceLoadedPage.missingImage.decodedImageCount, 0);
  assert.equal(evidence.resourceLoadedPage.missingImage.paintedImage, false);
  assert.ok(!evidence.resourceLoadedPage.missingImage.paintOps.includes("image"));
  assert.ok(evidence.resourceLoadedPage.missingImage.pngBytes > 0);
  assert.equal(evidence.resourceLoadedPage.invalidImage.discoveredResources, 1);
  assert.equal(evidence.resourceLoadedPage.invalidImage.loadedResources, 1);
  assert.equal(evidence.resourceLoadedPage.invalidImage.missingResources, 0);
  assert.equal(evidence.resourceLoadedPage.invalidImage.loadedBytes, 9);
  assert.equal(evidence.resourceLoadedPage.invalidImage.decodedImageCount, 0);
  assert.equal(evidence.resourceLoadedPage.invalidImage.paintedImage, false);
  assert.ok(!evidence.resourceLoadedPage.invalidImage.paintOps.includes("image"));
  assert.ok(evidence.resourceLoadedPage.invalidImage.pngBytes > 0);
  assert.equal(evidence.resourceLoadedPage.duplicateResource.fetchCalls, 2);
  assert.equal(evidence.resourceLoadedPage.duplicateResource.sharedResourceFetches, 1);
  assert.equal(evidence.resourceLoadedPage.duplicateResource.discoveredResources, 1);
  assert.equal(evidence.resourceLoadedPage.duplicateResource.loadedResources, 1);
  assert.equal(evidence.resourceLoadedPage.duplicateResource.missingResources, 0);
  assert.ok(evidence.resourceLoadedPage.duplicateResource.loadedBytes > 0);
  assert.equal(evidence.resourceLoadedPage.duplicateResource.decodedImageCount, 2);
  assert.equal(evidence.resourceLoadedPage.duplicateResource.paintedImageCount, 2);
  assert.ok(evidence.resourceLoadedPage.duplicateResource.paintOps.includes("image"));
  assert.ok(evidence.resourceLoadedPage.duplicateResource.pngBytes > 0);
  assert.equal(evidence.resourceLoadedPage.duplicateStylesheet.fetchCalls, 2);
  assert.equal(evidence.resourceLoadedPage.duplicateStylesheet.sharedStylesheetFetches, 1);
  assert.equal(evidence.resourceLoadedPage.duplicateStylesheet.discoveredResources, 1);
  assert.equal(evidence.resourceLoadedPage.duplicateStylesheet.loadedResources, 1);
  assert.equal(evidence.resourceLoadedPage.duplicateStylesheet.missingResources, 0);
  assert.ok(evidence.resourceLoadedPage.duplicateStylesheet.loadedBytes > 0);
  assert.equal(evidence.resourceLoadedPage.duplicateStylesheet.stylesheetCount, 4);
  assert.equal(evidence.resourceLoadedPage.duplicateStylesheet.authorStylesheetCount, 3);
  assert.equal(evidence.resourceLoadedPage.duplicateStylesheet.authorRuleCount, 3);
  assert.equal(evidence.resourceLoadedPage.duplicateStylesheet.authorDeclarationCount, 9);
  assert.equal(evidence.resourceLoadedPage.duplicateStylesheet.decodedImageCount, 0);
  assert.equal(evidence.resourceLoadedPage.duplicateStylesheet.paintedBackground, true);
  assert.equal(evidence.resourceLoadedPage.duplicateStylesheet.duplicateLinkWonSourceOrder, true);
  assert.ok(evidence.resourceLoadedPage.duplicateStylesheet.paintOps.includes("rect"));
  assert.ok(evidence.resourceLoadedPage.duplicateStylesheet.pngBytes > 0);
  assert.equal(evidence.resourceLoadedPage.dataUrlNoNetwork.fetchCalls, 1);
  assert.equal(evidence.resourceLoadedPage.dataUrlNoNetwork.discoveredResources, 0);
  assert.equal(evidence.resourceLoadedPage.dataUrlNoNetwork.loadedResources, 0);
  assert.equal(evidence.resourceLoadedPage.dataUrlNoNetwork.missingResources, 0);
  assert.equal(evidence.resourceLoadedPage.dataUrlNoNetwork.loadedBytes, 0);
  assert.equal(evidence.resourceLoadedPage.dataUrlNoNetwork.stylesheetCount, 2);
  assert.equal(evidence.resourceLoadedPage.dataUrlNoNetwork.decodedImageCount, 1);
  assert.equal(evidence.resourceLoadedPage.dataUrlNoNetwork.paintedImageCount, 1);
  assert.equal(evidence.resourceLoadedPage.dataUrlNoNetwork.paintedBackground, true);
  assert.ok(evidence.resourceLoadedPage.dataUrlNoNetwork.paintOps.includes("image"));
  assert.ok(evidence.resourceLoadedPage.dataUrlNoNetwork.paintOps.includes("rect"));
  assert.ok(evidence.resourceLoadedPage.dataUrlNoNetwork.pngBytes > 0);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetCharset.percentUtf8.metadata, "text/css;charset=utf-8");
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetCharset.percentUtf8.fetchCalls, 1);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetCharset.percentUtf8.dataUrlFetchCalls, 0);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetCharset.percentUtf8.discoveredResources, 0);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetCharset.percentUtf8.loadedResources, 0);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetCharset.percentUtf8.missingResources, 0);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetCharset.percentUtf8.loadedBytes, 0);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetCharset.percentUtf8.stylesheetCount, 2);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetCharset.percentUtf8.authorStylesheetCount, 1);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetCharset.percentUtf8.authorRuleCount, 1);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetCharset.percentUtf8.authorDeclarationCount, 3);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetCharset.percentUtf8.decodedImageCount, 0);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetCharset.percentUtf8.paintedBackground, true);
  assert.ok(evidence.resourceLoadedPage.dataUrlStylesheetCharset.percentUtf8.paintOps.includes("rect"));
  assert.ok(evidence.resourceLoadedPage.dataUrlStylesheetCharset.percentUtf8.pngBytes > 0);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetCharset.base64Utf8.metadata, "text/css;charset=utf-8;base64");
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetCharset.base64Utf8.fetchCalls, 1);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetCharset.base64Utf8.dataUrlFetchCalls, 0);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetCharset.base64Utf8.discoveredResources, 0);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetCharset.base64Utf8.loadedResources, 0);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetCharset.base64Utf8.missingResources, 0);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetCharset.base64Utf8.loadedBytes, 0);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetCharset.base64Utf8.stylesheetCount, 2);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetCharset.base64Utf8.authorStylesheetCount, 1);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetCharset.base64Utf8.authorRuleCount, 1);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetCharset.base64Utf8.authorDeclarationCount, 3);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetCharset.base64Utf8.decodedImageCount, 0);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetCharset.base64Utf8.paintedBackground, true);
  assert.ok(evidence.resourceLoadedPage.dataUrlStylesheetCharset.base64Utf8.paintOps.includes("rect"));
  assert.ok(evidence.resourceLoadedPage.dataUrlStylesheetCharset.base64Utf8.pngBytes > 0);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetCharset.unsupportedCharset.metadata, "text/css;charset=iso-8859-1");
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetCharset.unsupportedCharset.fetchCalls, 1);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetCharset.unsupportedCharset.dataUrlFetchCalls, 0);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetCharset.unsupportedCharset.discoveredResources, 0);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetCharset.unsupportedCharset.loadedResources, 0);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetCharset.unsupportedCharset.missingResources, 0);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetCharset.unsupportedCharset.loadedBytes, 0);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetCharset.unsupportedCharset.stylesheetCount, 1);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetCharset.unsupportedCharset.authorStylesheetCount, 0);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetCharset.unsupportedCharset.authorRuleCount, 0);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetCharset.unsupportedCharset.authorDeclarationCount, 0);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetCharset.unsupportedCharset.decodedImageCount, 0);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetCharset.unsupportedCharset.paintedBackground, false);
  assert.ok(!evidence.resourceLoadedPage.dataUrlStylesheetCharset.unsupportedCharset.paintOps.includes("rect"));
  assert.ok(evidence.resourceLoadedPage.dataUrlStylesheetCharset.unsupportedCharset.pngBytes > 0);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetSourceOrder.externalAfterDataUrl.fetchCalls, 2);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetSourceOrder.externalAfterDataUrl.dataUrlFetchCalls, 0);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetSourceOrder.externalAfterDataUrl.externalStylesheetFetches, 1);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetSourceOrder.externalAfterDataUrl.discoveredResources, 1);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetSourceOrder.externalAfterDataUrl.loadedResources, 1);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetSourceOrder.externalAfterDataUrl.missingResources, 0);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetSourceOrder.externalAfterDataUrl.loadedBytes, 40);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetSourceOrder.externalAfterDataUrl.stylesheetCount, 3);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetSourceOrder.externalAfterDataUrl.authorStylesheetCount, 2);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetSourceOrder.externalAfterDataUrl.authorRuleCount, 2);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetSourceOrder.externalAfterDataUrl.authorDeclarationCount, 4);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetSourceOrder.externalAfterDataUrl.decodedImageCount, 0);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetSourceOrder.externalAfterDataUrl.paintedBackground, true);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetSourceOrder.externalAfterDataUrl.sourceOrderWinnerBlue, true);
  assert.ok(evidence.resourceLoadedPage.dataUrlStylesheetSourceOrder.externalAfterDataUrl.paintOps.includes("rect"));
  assert.ok(evidence.resourceLoadedPage.dataUrlStylesheetSourceOrder.externalAfterDataUrl.pngBytes > 0);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetSourceOrder.dataUrlAfterExternal.fetchCalls, 2);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetSourceOrder.dataUrlAfterExternal.dataUrlFetchCalls, 0);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetSourceOrder.dataUrlAfterExternal.externalStylesheetFetches, 1);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetSourceOrder.dataUrlAfterExternal.discoveredResources, 1);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetSourceOrder.dataUrlAfterExternal.loadedResources, 1);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetSourceOrder.dataUrlAfterExternal.missingResources, 0);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetSourceOrder.dataUrlAfterExternal.loadedBytes, 67);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetSourceOrder.dataUrlAfterExternal.stylesheetCount, 3);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetSourceOrder.dataUrlAfterExternal.authorStylesheetCount, 2);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetSourceOrder.dataUrlAfterExternal.authorRuleCount, 2);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetSourceOrder.dataUrlAfterExternal.authorDeclarationCount, 4);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetSourceOrder.dataUrlAfterExternal.decodedImageCount, 0);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetSourceOrder.dataUrlAfterExternal.paintedBackground, true);
  assert.equal(evidence.resourceLoadedPage.dataUrlStylesheetSourceOrder.dataUrlAfterExternal.sourceOrderWinnerBlue, true);
  assert.ok(evidence.resourceLoadedPage.dataUrlStylesheetSourceOrder.dataUrlAfterExternal.paintOps.includes("rect"));
  assert.ok(evidence.resourceLoadedPage.dataUrlStylesheetSourceOrder.dataUrlAfterExternal.pngBytes > 0);
  assert.equal(evidence.resourceLoadedPage.externalInlineStylesheetSourceOrder.inlineAfterExternal.fetchCalls, 2);
  assert.equal(evidence.resourceLoadedPage.externalInlineStylesheetSourceOrder.inlineAfterExternal.externalStylesheetFetches, 1);
  assert.equal(evidence.resourceLoadedPage.externalInlineStylesheetSourceOrder.inlineAfterExternal.discoveredResources, 1);
  assert.equal(evidence.resourceLoadedPage.externalInlineStylesheetSourceOrder.inlineAfterExternal.loadedResources, 1);
  assert.equal(evidence.resourceLoadedPage.externalInlineStylesheetSourceOrder.inlineAfterExternal.missingResources, 0);
  assert.equal(evidence.resourceLoadedPage.externalInlineStylesheetSourceOrder.inlineAfterExternal.loadedBytes, 67);
  assert.equal(evidence.resourceLoadedPage.externalInlineStylesheetSourceOrder.inlineAfterExternal.stylesheetCount, 3);
  assert.equal(evidence.resourceLoadedPage.externalInlineStylesheetSourceOrder.inlineAfterExternal.authorStylesheetCount, 2);
  assert.equal(evidence.resourceLoadedPage.externalInlineStylesheetSourceOrder.inlineAfterExternal.authorRuleCount, 2);
  assert.equal(evidence.resourceLoadedPage.externalInlineStylesheetSourceOrder.inlineAfterExternal.authorDeclarationCount, 4);
  assert.equal(evidence.resourceLoadedPage.externalInlineStylesheetSourceOrder.inlineAfterExternal.decodedImageCount, 0);
  assert.equal(evidence.resourceLoadedPage.externalInlineStylesheetSourceOrder.inlineAfterExternal.paintedBackground, true);
  assert.equal(evidence.resourceLoadedPage.externalInlineStylesheetSourceOrder.inlineAfterExternal.sourceOrderWinnerBlue, true);
  assert.ok(evidence.resourceLoadedPage.externalInlineStylesheetSourceOrder.inlineAfterExternal.paintOps.includes("rect"));
  assert.ok(evidence.resourceLoadedPage.externalInlineStylesheetSourceOrder.inlineAfterExternal.pngBytes > 0);
  assert.equal(evidence.resourceLoadedPage.externalInlineStylesheetSourceOrder.externalAfterInline.fetchCalls, 2);
  assert.equal(evidence.resourceLoadedPage.externalInlineStylesheetSourceOrder.externalAfterInline.externalStylesheetFetches, 1);
  assert.equal(evidence.resourceLoadedPage.externalInlineStylesheetSourceOrder.externalAfterInline.discoveredResources, 1);
  assert.equal(evidence.resourceLoadedPage.externalInlineStylesheetSourceOrder.externalAfterInline.loadedResources, 1);
  assert.equal(evidence.resourceLoadedPage.externalInlineStylesheetSourceOrder.externalAfterInline.missingResources, 0);
  assert.equal(evidence.resourceLoadedPage.externalInlineStylesheetSourceOrder.externalAfterInline.loadedBytes, 40);
  assert.equal(evidence.resourceLoadedPage.externalInlineStylesheetSourceOrder.externalAfterInline.stylesheetCount, 3);
  assert.equal(evidence.resourceLoadedPage.externalInlineStylesheetSourceOrder.externalAfterInline.authorStylesheetCount, 2);
  assert.equal(evidence.resourceLoadedPage.externalInlineStylesheetSourceOrder.externalAfterInline.authorRuleCount, 2);
  assert.equal(evidence.resourceLoadedPage.externalInlineStylesheetSourceOrder.externalAfterInline.authorDeclarationCount, 4);
  assert.equal(evidence.resourceLoadedPage.externalInlineStylesheetSourceOrder.externalAfterInline.decodedImageCount, 0);
  assert.equal(evidence.resourceLoadedPage.externalInlineStylesheetSourceOrder.externalAfterInline.paintedBackground, true);
  assert.equal(evidence.resourceLoadedPage.externalInlineStylesheetSourceOrder.externalAfterInline.sourceOrderWinnerBlue, true);
  assert.ok(evidence.resourceLoadedPage.externalInlineStylesheetSourceOrder.externalAfterInline.paintOps.includes("rect"));
  assert.ok(evidence.resourceLoadedPage.externalInlineStylesheetSourceOrder.externalAfterInline.pngBytes > 0);
  assert.equal(evidence.resourceLoadedPage.invalidDataImage.fetchCalls, 1);
  assert.equal(evidence.resourceLoadedPage.invalidDataImage.discoveredResources, 0);
  assert.equal(evidence.resourceLoadedPage.invalidDataImage.loadedResources, 0);
  assert.equal(evidence.resourceLoadedPage.invalidDataImage.missingResources, 0);
  assert.equal(evidence.resourceLoadedPage.invalidDataImage.loadedBytes, 0);
  assert.equal(evidence.resourceLoadedPage.invalidDataImage.decodedImageCount, 0);
  assert.equal(evidence.resourceLoadedPage.invalidDataImage.paintedImageCount, 0);
  assert.equal(evidence.resourceLoadedPage.invalidDataImage.paintedBackground, true);
  assert.ok(!evidence.resourceLoadedPage.invalidDataImage.paintOps.includes("image"));
  assert.ok(evidence.resourceLoadedPage.invalidDataImage.paintOps.includes("rect"));
  assert.ok(evidence.resourceLoadedPage.invalidDataImage.pngBytes > 0);
  assert.equal(evidence.resourceLoadedPage.invalidDataStylesheet.fetchCalls, 1);
  assert.equal(evidence.resourceLoadedPage.invalidDataStylesheet.discoveredResources, 0);
  assert.equal(evidence.resourceLoadedPage.invalidDataStylesheet.loadedResources, 0);
  assert.equal(evidence.resourceLoadedPage.invalidDataStylesheet.missingResources, 0);
  assert.equal(evidence.resourceLoadedPage.invalidDataStylesheet.loadedBytes, 0);
  assert.equal(evidence.resourceLoadedPage.invalidDataStylesheet.stylesheetCount, 2);
  assert.equal(evidence.resourceLoadedPage.invalidDataStylesheet.authorStylesheetCount, 1);
  assert.equal(evidence.resourceLoadedPage.invalidDataStylesheet.authorRuleCount, 1);
  assert.equal(evidence.resourceLoadedPage.invalidDataStylesheet.authorDeclarationCount, 0);
  assert.equal(evidence.resourceLoadedPage.invalidDataStylesheet.decodedImageCount, 0);
  assert.equal(evidence.resourceLoadedPage.invalidDataStylesheet.paintedBackground, false);
  assert.ok(!evidence.resourceLoadedPage.invalidDataStylesheet.paintOps.includes("rect"));
  assert.ok(evidence.resourceLoadedPage.invalidDataStylesheet.paintOps.includes("text"));
  assert.ok(evidence.resourceLoadedPage.invalidDataStylesheet.pngBytes > 0);
  assert.equal(evidence.resourceLoadedPage.nonCssDataStylesheet.fetchCalls, 1);
  assert.equal(evidence.resourceLoadedPage.nonCssDataStylesheet.discoveredResources, 0);
  assert.equal(evidence.resourceLoadedPage.nonCssDataStylesheet.loadedResources, 0);
  assert.equal(evidence.resourceLoadedPage.nonCssDataStylesheet.missingResources, 0);
  assert.equal(evidence.resourceLoadedPage.nonCssDataStylesheet.loadedBytes, 0);
  assert.equal(evidence.resourceLoadedPage.nonCssDataStylesheet.stylesheetCount, 1);
  assert.equal(evidence.resourceLoadedPage.nonCssDataStylesheet.authorStylesheetCount, 0);
  assert.equal(evidence.resourceLoadedPage.nonCssDataStylesheet.authorRuleCount, 0);
  assert.equal(evidence.resourceLoadedPage.nonCssDataStylesheet.authorDeclarationCount, 0);
  assert.equal(evidence.resourceLoadedPage.nonCssDataStylesheet.decodedImageCount, 0);
  assert.equal(evidence.resourceLoadedPage.nonCssDataStylesheet.paintedBackground, false);
  assert.ok(!evidence.resourceLoadedPage.nonCssDataStylesheet.paintOps.includes("rect"));
  assert.ok(evidence.resourceLoadedPage.nonCssDataStylesheet.paintOps.includes("text"));
  assert.ok(evidence.resourceLoadedPage.nonCssDataStylesheet.pngBytes > 0);
  assert.equal(evidence.resourceLoadedPage.noHrefStylesheet.fetchCalls, 2);
  assert.equal(evidence.resourceLoadedPage.noHrefStylesheet.discoveredResources, 1);
  assert.equal(evidence.resourceLoadedPage.noHrefStylesheet.loadedResources, 1);
  assert.equal(evidence.resourceLoadedPage.noHrefStylesheet.missingResources, 0);
  assert.ok(evidence.resourceLoadedPage.noHrefStylesheet.loadedBytes > 0);
  assert.equal(evidence.resourceLoadedPage.noHrefStylesheet.stylesheetCount, 2);
  assert.equal(evidence.resourceLoadedPage.noHrefStylesheet.authorStylesheetCount, 1);
  assert.equal(evidence.resourceLoadedPage.noHrefStylesheet.authorRuleCount, 1);
  assert.equal(evidence.resourceLoadedPage.noHrefStylesheet.authorDeclarationCount, 3);
  assert.equal(evidence.resourceLoadedPage.noHrefStylesheet.decodedImageCount, 0);
  assert.equal(evidence.resourceLoadedPage.noHrefStylesheet.paintedBackground, true);
  assert.ok(evidence.resourceLoadedPage.noHrefStylesheet.paintOps.includes("rect"));
  assert.ok(evidence.resourceLoadedPage.noHrefStylesheet.pngBytes > 0);
  assert.equal(evidence.resourceLoadedPage.emptyHrefStylesheet.fetchCalls, 2);
  assert.equal(evidence.resourceLoadedPage.emptyHrefStylesheet.discoveredResources, 1);
  assert.equal(evidence.resourceLoadedPage.emptyHrefStylesheet.loadedResources, 1);
  assert.equal(evidence.resourceLoadedPage.emptyHrefStylesheet.missingResources, 0);
  assert.ok(evidence.resourceLoadedPage.emptyHrefStylesheet.loadedBytes > 0);
  assert.equal(evidence.resourceLoadedPage.emptyHrefStylesheet.stylesheetCount, 2);
  assert.equal(evidence.resourceLoadedPage.emptyHrefStylesheet.authorStylesheetCount, 1);
  assert.equal(evidence.resourceLoadedPage.emptyHrefStylesheet.authorRuleCount, 0);
  assert.equal(evidence.resourceLoadedPage.emptyHrefStylesheet.authorDeclarationCount, 0);
  assert.equal(evidence.resourceLoadedPage.emptyHrefStylesheet.decodedImageCount, 0);
  assert.equal(evidence.resourceLoadedPage.emptyHrefStylesheet.paintedBackground, false);
  assert.ok(!evidence.resourceLoadedPage.emptyHrefStylesheet.paintOps.includes("rect"));
  assert.ok(evidence.resourceLoadedPage.emptyHrefStylesheet.paintOps.includes("text"));
  assert.ok(evidence.resourceLoadedPage.emptyHrefStylesheet.pngBytes > 0);
  assert.equal(evidence.resourceLoadedPage.fragmentHrefStylesheet.fetchCalls, 2);
  assert.equal(evidence.resourceLoadedPage.fragmentHrefStylesheet.discoveredResources, 1);
  assert.equal(evidence.resourceLoadedPage.fragmentHrefStylesheet.loadedResources, 1);
  assert.equal(evidence.resourceLoadedPage.fragmentHrefStylesheet.missingResources, 0);
  assert.ok(evidence.resourceLoadedPage.fragmentHrefStylesheet.loadedBytes > 0);
  assert.equal(evidence.resourceLoadedPage.fragmentHrefStylesheet.stylesheetCount, 2);
  assert.equal(evidence.resourceLoadedPage.fragmentHrefStylesheet.authorStylesheetCount, 1);
  assert.equal(evidence.resourceLoadedPage.fragmentHrefStylesheet.authorRuleCount, 0);
  assert.equal(evidence.resourceLoadedPage.fragmentHrefStylesheet.authorDeclarationCount, 0);
  assert.equal(evidence.resourceLoadedPage.fragmentHrefStylesheet.decodedImageCount, 0);
  assert.equal(evidence.resourceLoadedPage.fragmentHrefStylesheet.paintedBackground, false);
  assert.ok(!evidence.resourceLoadedPage.fragmentHrefStylesheet.paintOps.includes("rect"));
  assert.ok(evidence.resourceLoadedPage.fragmentHrefStylesheet.paintOps.includes("text"));
  assert.ok(evidence.resourceLoadedPage.fragmentHrefStylesheet.pngBytes > 0);
  assert.equal(evidence.resourceLoadedPage.queryHrefStylesheet.fetchCalls, 2);
  assert.equal(evidence.resourceLoadedPage.queryHrefStylesheet.discoveredResources, 1);
  assert.equal(evidence.resourceLoadedPage.queryHrefStylesheet.loadedResources, 1);
  assert.equal(evidence.resourceLoadedPage.queryHrefStylesheet.missingResources, 0);
  assert.ok(evidence.resourceLoadedPage.queryHrefStylesheet.loadedBytes > 0);
  assert.equal(evidence.resourceLoadedPage.queryHrefStylesheet.stylesheetCount, 2);
  assert.equal(evidence.resourceLoadedPage.queryHrefStylesheet.authorStylesheetCount, 1);
  assert.equal(evidence.resourceLoadedPage.queryHrefStylesheet.authorRuleCount, 0);
  assert.equal(evidence.resourceLoadedPage.queryHrefStylesheet.authorDeclarationCount, 0);
  assert.equal(evidence.resourceLoadedPage.queryHrefStylesheet.decodedImageCount, 0);
  assert.equal(evidence.resourceLoadedPage.queryHrefStylesheet.paintedBackground, false);
  assert.ok(!evidence.resourceLoadedPage.queryHrefStylesheet.paintOps.includes("rect"));
  assert.ok(evidence.resourceLoadedPage.queryHrefStylesheet.paintOps.includes("text"));
  assert.ok(evidence.resourceLoadedPage.queryHrefStylesheet.pngBytes > 0);
  assert.equal(evidence.resourceLoadedPage.protocolRelativeStylesheet.fetchCalls, 2);
  assert.equal(evidence.resourceLoadedPage.protocolRelativeStylesheet.discoveredResources, 1);
  assert.equal(evidence.resourceLoadedPage.protocolRelativeStylesheet.loadedResources, 1);
  assert.equal(evidence.resourceLoadedPage.protocolRelativeStylesheet.missingResources, 0);
  assert.ok(evidence.resourceLoadedPage.protocolRelativeStylesheet.loadedBytes > 0);
  assert.equal(evidence.resourceLoadedPage.protocolRelativeStylesheet.stylesheetCount, 2);
  assert.equal(evidence.resourceLoadedPage.protocolRelativeStylesheet.authorStylesheetCount, 1);
  assert.equal(evidence.resourceLoadedPage.protocolRelativeStylesheet.authorRuleCount, 1);
  assert.equal(evidence.resourceLoadedPage.protocolRelativeStylesheet.authorDeclarationCount, 3);
  assert.equal(evidence.resourceLoadedPage.protocolRelativeStylesheet.decodedImageCount, 0);
  assert.equal(evidence.resourceLoadedPage.protocolRelativeStylesheet.paintedBackground, true);
  assert.ok(evidence.resourceLoadedPage.protocolRelativeStylesheet.paintOps.includes("rect"));
  assert.ok(evidence.resourceLoadedPage.protocolRelativeStylesheet.pngBytes > 0);
  assert.equal(evidence.resourceLoadedPage.whitespaceRelStylesheet.fetchCalls, 3);
  assert.equal(evidence.resourceLoadedPage.whitespaceRelStylesheet.discoveredResources, 2);
  assert.equal(evidence.resourceLoadedPage.whitespaceRelStylesheet.loadedResources, 2);
  assert.equal(evidence.resourceLoadedPage.whitespaceRelStylesheet.missingResources, 0);
  assert.equal(evidence.resourceLoadedPage.whitespaceRelStylesheet.loadedBytes, 107);
  assert.equal(evidence.resourceLoadedPage.whitespaceRelStylesheet.stylesheetCount, 3);
  assert.equal(evidence.resourceLoadedPage.whitespaceRelStylesheet.authorStylesheetCount, 2);
  assert.equal(evidence.resourceLoadedPage.whitespaceRelStylesheet.authorRuleCount, 2);
  assert.equal(evidence.resourceLoadedPage.whitespaceRelStylesheet.authorDeclarationCount, 4);
  assert.equal(evidence.resourceLoadedPage.whitespaceRelStylesheet.decodedImageCount, 0);
  assert.equal(evidence.resourceLoadedPage.whitespaceRelStylesheet.paintedBackground, true);
  assert.equal(evidence.resourceLoadedPage.whitespaceRelStylesheet.sourceOrderWinnerBlue, true);
  assert.equal(evidence.resourceLoadedPage.whitespaceRelStylesheet.alternateFetchCalls, 1);
  assert.equal(evidence.resourceLoadedPage.whitespaceRelStylesheet.alternateDiscoveredResources, 0);
  assert.equal(evidence.resourceLoadedPage.whitespaceRelStylesheet.alternateLoadedResources, 0);
  assert.equal(evidence.resourceLoadedPage.whitespaceRelStylesheet.alternateAuthorStylesheetCount, 0);
  assert.equal(evidence.resourceLoadedPage.whitespaceRelStylesheet.alternatePaintedBackground, false);
  assert.ok(evidence.resourceLoadedPage.whitespaceRelStylesheet.paintOps.includes("rect"));
  assert.ok(evidence.resourceLoadedPage.whitespaceRelStylesheet.pngBytes > 0);
  assert.equal(evidence.resourceLoadedPage.duplicateRelStylesheet.fetchCalls, 3);
  assert.equal(evidence.resourceLoadedPage.duplicateRelStylesheet.discoveredResources, 2);
  assert.equal(evidence.resourceLoadedPage.duplicateRelStylesheet.loadedResources, 2);
  assert.equal(evidence.resourceLoadedPage.duplicateRelStylesheet.missingResources, 0);
  assert.equal(evidence.resourceLoadedPage.duplicateRelStylesheet.loadedBytes, 107);
  assert.equal(evidence.resourceLoadedPage.duplicateRelStylesheet.stylesheetCount, 3);
  assert.equal(evidence.resourceLoadedPage.duplicateRelStylesheet.authorStylesheetCount, 2);
  assert.equal(evidence.resourceLoadedPage.duplicateRelStylesheet.authorRuleCount, 2);
  assert.equal(evidence.resourceLoadedPage.duplicateRelStylesheet.authorDeclarationCount, 4);
  assert.equal(evidence.resourceLoadedPage.duplicateRelStylesheet.decodedImageCount, 0);
  assert.equal(evidence.resourceLoadedPage.duplicateRelStylesheet.paintedBackground, true);
  assert.equal(evidence.resourceLoadedPage.duplicateRelStylesheet.sourceOrderWinnerBlue, true);
  assert.equal(evidence.resourceLoadedPage.duplicateRelStylesheet.alternateFetchCalls, 1);
  assert.equal(evidence.resourceLoadedPage.duplicateRelStylesheet.alternateDiscoveredResources, 0);
  assert.equal(evidence.resourceLoadedPage.duplicateRelStylesheet.alternateLoadedResources, 0);
  assert.equal(evidence.resourceLoadedPage.duplicateRelStylesheet.alternateAuthorStylesheetCount, 0);
  assert.equal(evidence.resourceLoadedPage.duplicateRelStylesheet.alternatePaintedBackground, false);
  assert.ok(evidence.resourceLoadedPage.duplicateRelStylesheet.paintOps.includes("rect"));
  assert.ok(evidence.resourceLoadedPage.duplicateRelStylesheet.pngBytes > 0);
  assert.equal(evidence.resourceLoadedPage.whitespaceHrefStylesheet.rawHref, " /early.css ");
  assert.equal(evidence.resourceLoadedPage.whitespaceHrefStylesheet.resolvedHref, "https://benchmark.test/early.css");
  assert.equal(evidence.resourceLoadedPage.whitespaceHrefStylesheet.loadedResourceUrl, "https://benchmark.test/early.css");
  assert.equal(evidence.resourceLoadedPage.whitespaceHrefStylesheet.fetchCalls, 3);
  assert.equal(evidence.resourceLoadedPage.whitespaceHrefStylesheet.discoveredResources, 2);
  assert.equal(evidence.resourceLoadedPage.whitespaceHrefStylesheet.loadedResources, 2);
  assert.equal(evidence.resourceLoadedPage.whitespaceHrefStylesheet.missingResources, 0);
  assert.equal(evidence.resourceLoadedPage.whitespaceHrefStylesheet.loadedBytes, 107);
  assert.equal(evidence.resourceLoadedPage.whitespaceHrefStylesheet.stylesheetCount, 3);
  assert.equal(evidence.resourceLoadedPage.whitespaceHrefStylesheet.authorStylesheetCount, 2);
  assert.equal(evidence.resourceLoadedPage.whitespaceHrefStylesheet.authorRuleCount, 2);
  assert.equal(evidence.resourceLoadedPage.whitespaceHrefStylesheet.authorDeclarationCount, 4);
  assert.equal(evidence.resourceLoadedPage.whitespaceHrefStylesheet.decodedImageCount, 0);
  assert.equal(evidence.resourceLoadedPage.whitespaceHrefStylesheet.paintedBackground, true);
  assert.equal(evidence.resourceLoadedPage.whitespaceHrefStylesheet.sourceOrderWinnerBlue, true);
  assert.ok(evidence.resourceLoadedPage.whitespaceHrefStylesheet.paintOps.includes("rect"));
  assert.ok(evidence.resourceLoadedPage.whitespaceHrefStylesheet.pngBytes > 0);
  assert.equal(evidence.resourceLoadedPage.controlCharacterHrefStylesheet.rawHref, "\n\t/early.css\f");
  assert.equal(evidence.resourceLoadedPage.controlCharacterHrefStylesheet.rawHrefJson, "\"\\n\\t/early.css\\f\"");
  assert.equal(evidence.resourceLoadedPage.controlCharacterHrefStylesheet.resolvedHref, "https://benchmark.test/early.css");
  assert.equal(evidence.resourceLoadedPage.controlCharacterHrefStylesheet.loadedResourceUrl, "https://benchmark.test/early.css");
  assert.equal(evidence.resourceLoadedPage.controlCharacterHrefStylesheet.fetchCalls, 3);
  assert.equal(evidence.resourceLoadedPage.controlCharacterHrefStylesheet.discoveredResources, 2);
  assert.equal(evidence.resourceLoadedPage.controlCharacterHrefStylesheet.loadedResources, 2);
  assert.equal(evidence.resourceLoadedPage.controlCharacterHrefStylesheet.missingResources, 0);
  assert.equal(evidence.resourceLoadedPage.controlCharacterHrefStylesheet.loadedBytes, 107);
  assert.equal(evidence.resourceLoadedPage.controlCharacterHrefStylesheet.stylesheetCount, 3);
  assert.equal(evidence.resourceLoadedPage.controlCharacterHrefStylesheet.authorStylesheetCount, 2);
  assert.equal(evidence.resourceLoadedPage.controlCharacterHrefStylesheet.authorRuleCount, 2);
  assert.equal(evidence.resourceLoadedPage.controlCharacterHrefStylesheet.authorDeclarationCount, 4);
  assert.equal(evidence.resourceLoadedPage.controlCharacterHrefStylesheet.decodedImageCount, 0);
  assert.equal(evidence.resourceLoadedPage.controlCharacterHrefStylesheet.paintedBackground, true);
  assert.equal(evidence.resourceLoadedPage.controlCharacterHrefStylesheet.sourceOrderWinnerBlue, true);
  assert.ok(evidence.resourceLoadedPage.controlCharacterHrefStylesheet.paintOps.includes("rect"));
  assert.ok(evidence.resourceLoadedPage.controlCharacterHrefStylesheet.pngBytes > 0);
  assert.equal(evidence.resourceLoadedPage.baseHrefSubresource.rawBaseHref, "https://cdn.benchmark.test/assets/");
  assert.equal(evidence.resourceLoadedPage.baseHrefSubresource.resolvedBaseHref, "https://cdn.benchmark.test/assets/");
  assert.equal(evidence.resourceLoadedPage.baseHrefSubresource.stylesheetHref, "css/theme.css");
  assert.equal(evidence.resourceLoadedPage.baseHrefSubresource.imageSrc, "img/pic.png");
  assert.equal(evidence.resourceLoadedPage.baseHrefSubresource.loadedStylesheetUrl, "https://cdn.benchmark.test/assets/css/theme.css");
  assert.equal(evidence.resourceLoadedPage.baseHrefSubresource.loadedImageUrl, "https://cdn.benchmark.test/assets/img/pic.png");
  assert.equal(evidence.resourceLoadedPage.baseHrefSubresource.fetchCalls, 3);
  assert.equal(evidence.resourceLoadedPage.baseHrefSubresource.stylesheetFetches, 1);
  assert.equal(evidence.resourceLoadedPage.baseHrefSubresource.imageFetches, 1);
  assert.equal(evidence.resourceLoadedPage.baseHrefSubresource.discoveredResources, 2);
  assert.equal(evidence.resourceLoadedPage.baseHrefSubresource.loadedResources, 2);
  assert.equal(evidence.resourceLoadedPage.baseHrefSubresource.missingResources, 0);
  assert.equal(evidence.resourceLoadedPage.baseHrefSubresource.loadedBytes, 174);
  assert.equal(evidence.resourceLoadedPage.baseHrefSubresource.stylesheetCount, 2);
  assert.equal(evidence.resourceLoadedPage.baseHrefSubresource.authorStylesheetCount, 1);
  assert.equal(evidence.resourceLoadedPage.baseHrefSubresource.authorRuleCount, 2);
  assert.equal(evidence.resourceLoadedPage.baseHrefSubresource.authorDeclarationCount, 5);
  assert.equal(evidence.resourceLoadedPage.baseHrefSubresource.decodedImageCount, 1);
  assert.equal(evidence.resourceLoadedPage.baseHrefSubresource.paintedBackground, true);
  assert.equal(evidence.resourceLoadedPage.baseHrefSubresource.paintedImageCount, 1);
  assert.equal(evidence.resourceLoadedPage.baseHrefSubresource.paintedBackgroundRed, true);
  assert.equal(evidence.resourceLoadedPage.baseHrefSubresource.paintedImageBlue, true);
  assert.ok(evidence.resourceLoadedPage.baseHrefSubresource.paintOps.includes("rect"));
  assert.ok(evidence.resourceLoadedPage.baseHrefSubresource.paintOps.includes("image"));
  assert.ok(evidence.resourceLoadedPage.baseHrefSubresource.pngBytes > 0);
  assert.equal(evidence.resourceLoadedPage.invalidUrlStylesheet.fetchCalls, 2);
  assert.equal(evidence.resourceLoadedPage.invalidUrlStylesheet.discoveredResources, 1);
  assert.equal(evidence.resourceLoadedPage.invalidUrlStylesheet.loadedResources, 1);
  assert.equal(evidence.resourceLoadedPage.invalidUrlStylesheet.missingResources, 0);
  assert.equal(evidence.resourceLoadedPage.invalidUrlStylesheet.loadedBytes, 40);
  assert.equal(evidence.resourceLoadedPage.invalidUrlStylesheet.stylesheetCount, 3);
  assert.equal(evidence.resourceLoadedPage.invalidUrlStylesheet.authorStylesheetCount, 2);
  assert.equal(evidence.resourceLoadedPage.invalidUrlStylesheet.authorRuleCount, 2);
  assert.equal(evidence.resourceLoadedPage.invalidUrlStylesheet.authorDeclarationCount, 4);
  assert.equal(evidence.resourceLoadedPage.invalidUrlStylesheet.decodedImageCount, 0);
  assert.equal(evidence.resourceLoadedPage.invalidUrlStylesheet.paintedBackground, true);
  assert.equal(evidence.resourceLoadedPage.invalidUrlStylesheet.sourceOrderWinnerBlue, true);
  assert.equal(evidence.resourceLoadedPage.invalidUrlStylesheet.invalidOnlyFetchCalls, 1);
  assert.equal(evidence.resourceLoadedPage.invalidUrlStylesheet.invalidOnlyDiscoveredResources, 0);
  assert.equal(evidence.resourceLoadedPage.invalidUrlStylesheet.invalidOnlyLoadedResources, 0);
  assert.equal(evidence.resourceLoadedPage.invalidUrlStylesheet.invalidOnlyMissingResources, 0);
  assert.equal(evidence.resourceLoadedPage.invalidUrlStylesheet.invalidOnlyAuthorStylesheetCount, 0);
  assert.equal(evidence.resourceLoadedPage.invalidUrlStylesheet.invalidOnlyPaintedBackground, false);
  assert.ok(evidence.resourceLoadedPage.invalidUrlStylesheet.paintOps.includes("rect"));
  assert.ok(evidence.resourceLoadedPage.invalidUrlStylesheet.pngBytes > 0);
  assert.equal(evidence.resourceLoadedPage.alternateStylesheet.fetchCalls, 1);
  assert.equal(evidence.resourceLoadedPage.alternateStylesheet.discoveredResources, 0);
  assert.equal(evidence.resourceLoadedPage.alternateStylesheet.loadedResources, 0);
  assert.equal(evidence.resourceLoadedPage.alternateStylesheet.missingResources, 0);
  assert.equal(evidence.resourceLoadedPage.alternateStylesheet.loadedBytes, 0);
  assert.equal(evidence.resourceLoadedPage.alternateStylesheet.stylesheetCount, 1);
  assert.equal(evidence.resourceLoadedPage.alternateStylesheet.authorStylesheetCount, 0);
  assert.equal(evidence.resourceLoadedPage.alternateStylesheet.authorRuleCount, 0);
  assert.equal(evidence.resourceLoadedPage.alternateStylesheet.authorDeclarationCount, 0);
  assert.equal(evidence.resourceLoadedPage.alternateStylesheet.decodedImageCount, 0);
  assert.equal(evidence.resourceLoadedPage.alternateStylesheet.paintedBackground, false);
  assert.ok(!evidence.resourceLoadedPage.alternateStylesheet.paintOps.includes("rect"));
  assert.ok(evidence.resourceLoadedPage.alternateStylesheet.paintOps.includes("text"));
  assert.ok(evidence.resourceLoadedPage.alternateStylesheet.pngBytes > 0);
  assert.equal(evidence.resourceLoadedPage.disabledStylesheet.fetchCalls, 1);
  assert.equal(evidence.resourceLoadedPage.disabledStylesheet.discoveredResources, 0);
  assert.equal(evidence.resourceLoadedPage.disabledStylesheet.loadedResources, 0);
  assert.equal(evidence.resourceLoadedPage.disabledStylesheet.missingResources, 0);
  assert.equal(evidence.resourceLoadedPage.disabledStylesheet.loadedBytes, 0);
  assert.equal(evidence.resourceLoadedPage.disabledStylesheet.stylesheetCount, 1);
  assert.equal(evidence.resourceLoadedPage.disabledStylesheet.authorStylesheetCount, 0);
  assert.equal(evidence.resourceLoadedPage.disabledStylesheet.authorRuleCount, 0);
  assert.equal(evidence.resourceLoadedPage.disabledStylesheet.authorDeclarationCount, 0);
  assert.equal(evidence.resourceLoadedPage.disabledStylesheet.decodedImageCount, 0);
  assert.equal(evidence.resourceLoadedPage.disabledStylesheet.paintedBackground, false);
  assert.ok(!evidence.resourceLoadedPage.disabledStylesheet.paintOps.includes("rect"));
  assert.ok(evidence.resourceLoadedPage.disabledStylesheet.paintOps.includes("text"));
  assert.ok(evidence.resourceLoadedPage.disabledStylesheet.pngBytes > 0);
  assert.equal(evidence.resourceLoadedPage.printMediaStylesheet.fetchCalls, 1);
  assert.equal(evidence.resourceLoadedPage.printMediaStylesheet.discoveredResources, 0);
  assert.equal(evidence.resourceLoadedPage.printMediaStylesheet.loadedResources, 0);
  assert.equal(evidence.resourceLoadedPage.printMediaStylesheet.missingResources, 0);
  assert.equal(evidence.resourceLoadedPage.printMediaStylesheet.loadedBytes, 0);
  assert.equal(evidence.resourceLoadedPage.printMediaStylesheet.stylesheetCount, 1);
  assert.equal(evidence.resourceLoadedPage.printMediaStylesheet.authorStylesheetCount, 0);
  assert.equal(evidence.resourceLoadedPage.printMediaStylesheet.authorRuleCount, 0);
  assert.equal(evidence.resourceLoadedPage.printMediaStylesheet.authorDeclarationCount, 0);
  assert.equal(evidence.resourceLoadedPage.printMediaStylesheet.decodedImageCount, 0);
  assert.equal(evidence.resourceLoadedPage.printMediaStylesheet.paintedBackground, false);
  assert.ok(!evidence.resourceLoadedPage.printMediaStylesheet.paintOps.includes("rect"));
  assert.ok(evidence.resourceLoadedPage.printMediaStylesheet.paintOps.includes("text"));
  assert.ok(evidence.resourceLoadedPage.printMediaStylesheet.pngBytes > 0);
  assertMatchingMediaCase(evidence.resourceLoadedPage.stylesheetMediaList.empty, "");
  assertMatchingMediaCase(evidence.resourceLoadedPage.stylesheetMediaList.whitespaceOnly, "   ");
  assert.equal(evidence.resourceLoadedPage.stylesheetMediaList.matchingList.media, "print, screen");
  assert.equal(evidence.resourceLoadedPage.stylesheetMediaList.matchingList.fetchCalls, 2);
  assert.equal(evidence.resourceLoadedPage.stylesheetMediaList.matchingList.discoveredResources, 1);
  assert.equal(evidence.resourceLoadedPage.stylesheetMediaList.matchingList.loadedResources, 1);
  assert.equal(evidence.resourceLoadedPage.stylesheetMediaList.matchingList.missingResources, 0);
  assert.ok(evidence.resourceLoadedPage.stylesheetMediaList.matchingList.loadedBytes > 0);
  assert.equal(evidence.resourceLoadedPage.stylesheetMediaList.matchingList.stylesheetCount, 2);
  assert.equal(evidence.resourceLoadedPage.stylesheetMediaList.matchingList.authorStylesheetCount, 1);
  assert.equal(evidence.resourceLoadedPage.stylesheetMediaList.matchingList.authorRuleCount, 1);
  assert.equal(evidence.resourceLoadedPage.stylesheetMediaList.matchingList.authorDeclarationCount, 3);
  assert.equal(evidence.resourceLoadedPage.stylesheetMediaList.matchingList.decodedImageCount, 0);
  assert.equal(evidence.resourceLoadedPage.stylesheetMediaList.matchingList.paintedBackground, true);
  assert.ok(evidence.resourceLoadedPage.stylesheetMediaList.matchingList.paintOps.includes("rect"));
  assert.ok(evidence.resourceLoadedPage.stylesheetMediaList.matchingList.pngBytes > 0);
  assertMatchingMediaCase(evidence.resourceLoadedPage.stylesheetMediaList.spacedMatchingList, " print , screen ");
  assertMatchingMediaCase(evidence.resourceLoadedPage.stylesheetMediaList.emptyItemBeforeScreen, ", screen");
  assertMatchingMediaCase(evidence.resourceLoadedPage.stylesheetMediaList.emptyItemAfterScreen, "screen,");
  assertInactiveMediaCase(evidence.resourceLoadedPage.stylesheetMediaList.emptyItemsOnly, ",");
  assertMatchingMediaCase(
    evidence.resourceLoadedPage.stylesheetMediaList.unsupportedThenScreen,
    "(dynamic-range: high), screen",
  );
  assertInactiveMediaCase(
    evidence.resourceLoadedPage.stylesheetMediaList.unsupportedOnly,
    "(dynamic-range: high)",
  );
  assertMatchingMediaCase(evidence.resourceLoadedPage.stylesheetMediaList.unknownTypeThenScreen, "projection, screen");
  assertInactiveMediaCase(evidence.resourceLoadedPage.stylesheetMediaList.unknownTypeOnly, "projection");
  assertMatchingMediaCase(evidence.resourceLoadedPage.stylesheetMediaList.uppercaseScreen, "SCREEN");
  assertMatchingMediaCase(evidence.resourceLoadedPage.stylesheetMediaList.mixedCaseOnlyScreen, "Only Screen");
  assertMatchingMediaCase(evidence.resourceLoadedPage.stylesheetMediaList.spacedOnlyScreen, "only   screen");
  assertInactiveMediaCase(evidence.resourceLoadedPage.stylesheetMediaList.uppercasePrint, "PRINT");
  assertMatchingMediaCase(evidence.resourceLoadedPage.stylesheetMediaList.all, "all");
  assertMatchingMediaCase(evidence.resourceLoadedPage.stylesheetMediaList.onlyAll, "only all");
  assertInactiveMediaCase(evidence.resourceLoadedPage.stylesheetMediaList.notAll, "not all");
  assertInactiveMediaCase(evidence.resourceLoadedPage.stylesheetMediaList.spacedNotAll, "not   all");
  assert.equal(evidence.resourceLoadedPage.stylesheetMediaList.notPrint.media, "not print");
  assert.equal(evidence.resourceLoadedPage.stylesheetMediaList.notPrint.fetchCalls, 2);
  assert.equal(evidence.resourceLoadedPage.stylesheetMediaList.notPrint.discoveredResources, 1);
  assert.equal(evidence.resourceLoadedPage.stylesheetMediaList.notPrint.loadedResources, 1);
  assert.equal(evidence.resourceLoadedPage.stylesheetMediaList.notPrint.missingResources, 0);
  assert.ok(evidence.resourceLoadedPage.stylesheetMediaList.notPrint.loadedBytes > 0);
  assert.equal(evidence.resourceLoadedPage.stylesheetMediaList.notPrint.stylesheetCount, 2);
  assert.equal(evidence.resourceLoadedPage.stylesheetMediaList.notPrint.authorStylesheetCount, 1);
  assert.equal(evidence.resourceLoadedPage.stylesheetMediaList.notPrint.authorRuleCount, 1);
  assert.equal(evidence.resourceLoadedPage.stylesheetMediaList.notPrint.authorDeclarationCount, 3);
  assert.equal(evidence.resourceLoadedPage.stylesheetMediaList.notPrint.decodedImageCount, 0);
  assert.equal(evidence.resourceLoadedPage.stylesheetMediaList.notPrint.paintedBackground, true);
  assert.ok(evidence.resourceLoadedPage.stylesheetMediaList.notPrint.paintOps.includes("rect"));
  assert.ok(evidence.resourceLoadedPage.stylesheetMediaList.notPrint.pngBytes > 0);
  assertMatchingMediaCase(evidence.resourceLoadedPage.stylesheetMediaList.spacedNotPrint, "not   print");
  assert.equal(evidence.resourceLoadedPage.stylesheetMediaList.onlyPrint.media, "only print");
  assert.equal(evidence.resourceLoadedPage.stylesheetMediaList.onlyPrint.fetchCalls, 1);
  assert.equal(evidence.resourceLoadedPage.stylesheetMediaList.onlyPrint.discoveredResources, 0);
  assert.equal(evidence.resourceLoadedPage.stylesheetMediaList.onlyPrint.loadedResources, 0);
  assert.equal(evidence.resourceLoadedPage.stylesheetMediaList.onlyPrint.missingResources, 0);
  assert.equal(evidence.resourceLoadedPage.stylesheetMediaList.onlyPrint.loadedBytes, 0);
  assert.equal(evidence.resourceLoadedPage.stylesheetMediaList.onlyPrint.stylesheetCount, 1);
  assert.equal(evidence.resourceLoadedPage.stylesheetMediaList.onlyPrint.authorStylesheetCount, 0);
  assert.equal(evidence.resourceLoadedPage.stylesheetMediaList.onlyPrint.authorRuleCount, 0);
  assert.equal(evidence.resourceLoadedPage.stylesheetMediaList.onlyPrint.authorDeclarationCount, 0);
  assert.equal(evidence.resourceLoadedPage.stylesheetMediaList.onlyPrint.decodedImageCount, 0);
  assert.equal(evidence.resourceLoadedPage.stylesheetMediaList.onlyPrint.paintedBackground, false);
  assert.ok(!evidence.resourceLoadedPage.stylesheetMediaList.onlyPrint.paintOps.includes("rect"));
  assert.ok(evidence.resourceLoadedPage.stylesheetMediaList.onlyPrint.paintOps.includes("text"));
  assert.ok(evidence.resourceLoadedPage.stylesheetMediaList.onlyPrint.pngBytes > 0);
  assertInactiveMediaCase(evidence.resourceLoadedPage.stylesheetMediaList.spacedOnlyPrint, "only   print");
  assertMatchingMediaCase(
    evidence.resourceLoadedPage.stylesheetMediaFeature.screenMinWidth,
    "screen and (min-width: 1px)",
  );
  assertMatchingMediaCase(
    evidence.resourceLoadedPage.stylesheetMediaFeature.uppercaseScreenMinWidth,
    "screen and (MIN-WIDTH: 1px)",
  );
  assertMatchingMediaCase(
    evidence.resourceLoadedPage.stylesheetMediaFeature.decimalScreenMinWidth,
    "screen and (min-width: 799.5px)",
  );
  assertMatchingMediaCase(
    evidence.resourceLoadedPage.stylesheetMediaFeature.spacedScreenMinWidth,
    "screen  and  ( min-width : 1px )",
  );
  assertMatchingMediaCase(
    evidence.resourceLoadedPage.stylesheetMediaFeature.bareMinWidth,
    "(min-width: 1px)",
  );
  assertMatchingMediaCase(
    evidence.resourceLoadedPage.stylesheetMediaFeature.allMinWidth,
    "all and (min-width: 1px)",
  );
  assertInactiveMediaCase(
    evidence.resourceLoadedPage.stylesheetMediaFeature.allMaxWidth,
    "all and (max-width: 1px)",
  );
  assertMatchingMediaCase(
    evidence.resourceLoadedPage.stylesheetMediaFeature.onlyAllMinWidth,
    "only all and (min-width: 1px)",
  );
  assertInactiveMediaCase(
    evidence.resourceLoadedPage.stylesheetMediaFeature.unsupportedRangeWidth,
    "screen and (width >= 1px)",
  );
  assertMatchingMediaCase(
    evidence.resourceLoadedPage.stylesheetMediaFeature.unsupportedRangeThenScreen,
    "(width >= 1px), screen",
  );
  assertInactiveMediaCase(
    evidence.resourceLoadedPage.stylesheetMediaFeature.unsupportedCalcMinWidth,
    "screen and (min-width: calc(1px))",
  );
  assertInactiveMediaCase(
    evidence.resourceLoadedPage.stylesheetMediaFeature.unsupportedHover,
    "screen and (hover: hover)",
  );
  assertInactiveMediaCase(
    evidence.resourceLoadedPage.stylesheetMediaFeature.invalidEmptyFeature,
    "screen and ()",
  );
  assertInactiveMediaCase(
    evidence.resourceLoadedPage.stylesheetMediaFeature.unsupportedBooleanWidth,
    "screen and (width)",
  );
  assertInactiveMediaCase(
    evidence.resourceLoadedPage.stylesheetMediaFeature.unknownFeature,
    "screen and (unknown-feature)",
  );
  assertMatchingMediaCase(
    evidence.resourceLoadedPage.stylesheetMediaFeature.invalidEmptyFeatureThenScreen,
    "screen and (), screen",
  );
  assertInactiveMediaCase(
    evidence.resourceLoadedPage.stylesheetMediaFeature.screenMaxWidth,
    "screen and (max-width: 1px)",
  );
  assertInactiveMediaCase(
    evidence.resourceLoadedPage.stylesheetMediaFeature.decimalScreenMaxWidth,
    "screen and (max-width: 799.5px)",
  );
  assertInactiveMediaCase(
    evidence.resourceLoadedPage.stylesheetMediaFeature.spacedScreenMaxWidth,
    "screen  and  ( max-width : 1px )",
  );
  assertMatchingMediaCase(
    evidence.resourceLoadedPage.stylesheetMediaFeature.screenMinHeight,
    "screen and (min-height: 1px)",
  );
  assertInactiveMediaCase(
    evidence.resourceLoadedPage.stylesheetMediaFeature.screenMaxHeight,
    "screen and (max-height: 1px)",
  );
  assertMatchingMediaCase(
    evidence.resourceLoadedPage.stylesheetMediaFeature.screenExactWidth,
    "screen and (width: 800px)",
  );
  assertMatchingMediaCase(
    evidence.resourceLoadedPage.stylesheetMediaFeature.decimalScreenExactWidth,
    "screen and (width: 800.0px)",
  );
  assertMatchingMediaCase(
    evidence.resourceLoadedPage.stylesheetMediaFeature.screenExactHeight,
    "screen and (height: 600px)",
  );
  assertInactiveMediaCase(
    evidence.resourceLoadedPage.stylesheetMediaFeature.screenExactHeightMiss,
    "screen and (height: 1px)",
  );
  assertInactiveMediaCase(
    evidence.resourceLoadedPage.stylesheetMediaFeature.negatedMatchingFeature,
    "not screen and (min-width: 1px)",
  );
  assertMatchingMediaCase(
    evidence.resourceLoadedPage.stylesheetMediaFeature.negatedMissingFeature,
    "not screen and (max-width: 1px)",
  );
  assertMatchingMediaCase(
    evidence.resourceLoadedPage.stylesheetOrientationMedia.landscape,
    "screen and (orientation: landscape)",
  );
  assertMatchingMediaCase(
    evidence.resourceLoadedPage.stylesheetOrientationMedia.uppercaseLandscape,
    "screen and (ORIENTATION: LANDSCAPE)",
  );
  assertInactiveMediaCase(
    evidence.resourceLoadedPage.stylesheetOrientationMedia.portrait,
    "screen and (orientation: portrait)",
  );
  assertInactiveMediaCase(
    evidence.resourceLoadedPage.stylesheetOrientationMedia.uppercasePortrait,
    "screen and (ORIENTATION: PORTRAIT)",
  );
  assertMatchingMediaCase(
    evidence.resourceLoadedPage.stylesheetCombinedMediaFeature.matching,
    "screen and (min-width: 1px) and (orientation: landscape)",
  );
  assertInactiveMediaCase(
    evidence.resourceLoadedPage.stylesheetCombinedMediaFeature.laterMiss,
    "screen and (min-width: 1px) and (orientation: portrait)",
  );
  assert.equal(evidence.resourceLoadedPage.invalidExternalStylesheet.discoveredResources, 1);
  assert.equal(evidence.resourceLoadedPage.invalidExternalStylesheet.loadedResources, 1);
  assert.equal(evidence.resourceLoadedPage.invalidExternalStylesheet.missingResources, 0);
  assert.ok(evidence.resourceLoadedPage.invalidExternalStylesheet.loadedBytes > 0);
  assert.equal(evidence.resourceLoadedPage.invalidExternalStylesheet.stylesheetCount, 2);
  assert.equal(evidence.resourceLoadedPage.invalidExternalStylesheet.authorStylesheetCount, 1);
  assert.equal(evidence.resourceLoadedPage.invalidExternalStylesheet.authorRuleCount, 1);
  assert.equal(evidence.resourceLoadedPage.invalidExternalStylesheet.authorDeclarationCount, 0);
  assert.equal(evidence.resourceLoadedPage.invalidExternalStylesheet.decodedImageCount, 0);
  assert.equal(evidence.resourceLoadedPage.invalidExternalStylesheet.paintedBackground, false);
  assert.ok(!evidence.resourceLoadedPage.invalidExternalStylesheet.paintOps.includes("rect"));
  assert.ok(evidence.resourceLoadedPage.invalidExternalStylesheet.paintOps.includes("text"));
  assert.ok(evidence.resourceLoadedPage.invalidExternalStylesheet.pngBytes > 0);
  assert.equal(evidence.resourceLoadedPage.missingStylesheet.discoveredResources, 1);
  assert.equal(evidence.resourceLoadedPage.missingStylesheet.loadedResources, 0);
  assert.equal(evidence.resourceLoadedPage.missingStylesheet.missingResources, 1);
  assert.equal(evidence.resourceLoadedPage.missingStylesheet.loadedBytes, 0);
  assert.equal(evidence.resourceLoadedPage.missingStylesheet.stylesheetCount, 1);
  assert.equal(evidence.resourceLoadedPage.missingStylesheet.authorStylesheetCount, 0);
  assert.equal(evidence.resourceLoadedPage.missingStylesheet.authorRuleCount, 0);
  assert.equal(evidence.resourceLoadedPage.missingStylesheet.authorDeclarationCount, 0);
  assert.equal(evidence.resourceLoadedPage.missingStylesheet.decodedImageCount, 0);
  assert.equal(evidence.resourceLoadedPage.missingStylesheet.paintedBackground, false);
  assert.ok(!evidence.resourceLoadedPage.missingStylesheet.paintOps.includes("rect"));
  assert.ok(evidence.resourceLoadedPage.missingStylesheet.pngBytes > 0);
  assert.equal(evidence.realSiteSmoke.scenarioCount, 2);
  assert.equal(evidence.realSiteSmoke.passed, evidence.realSiteSmoke.scenarioCount);
  assert.equal(evidence.realSiteSmoke.failed, 0);
  assert.ok(evidence.realSiteSmoke.coveredCapabilities.includes("fetch"));
  assert.ok(evidence.realSiteSmoke.coveredCapabilities.includes("font-face"));
  assert.ok(evidence.realSiteSmoke.coveredCapabilities.includes("event-loop-microtask"));
  assert.ok(evidence.realSiteSmoke.scenarios.every((scenario) => scenario.passed));
});

function assertMatchingMediaCase(
  actual: ExecutionEvidence["resourceLoadedPage"]["stylesheetMediaFeature"]["screenMinWidth"],
  media: string,
): void {
  assert.equal(actual.media, media);
  assert.equal(actual.fetchCalls, 2);
  assert.equal(actual.discoveredResources, 1);
  assert.equal(actual.loadedResources, 1);
  assert.equal(actual.missingResources, 0);
  assert.ok(actual.loadedBytes > 0);
  assert.equal(actual.stylesheetCount, 2);
  assert.equal(actual.authorStylesheetCount, 1);
  assert.equal(actual.authorRuleCount, 1);
  assert.equal(actual.authorDeclarationCount, 3);
  assert.equal(actual.decodedImageCount, 0);
  assert.equal(actual.paintedBackground, true);
  assert.ok(actual.paintOps.includes("rect"));
  assert.ok(actual.pngBytes > 0);
}

function assertInactiveMediaCase(
  actual: ExecutionEvidence["resourceLoadedPage"]["stylesheetMediaFeature"]["screenMinWidth"],
  media: string,
): void {
  assert.equal(actual.media, media);
  assert.equal(actual.fetchCalls, 1);
  assert.equal(actual.discoveredResources, 0);
  assert.equal(actual.loadedResources, 0);
  assert.equal(actual.missingResources, 0);
  assert.equal(actual.loadedBytes, 0);
  assert.equal(actual.stylesheetCount, 1);
  assert.equal(actual.authorStylesheetCount, 0);
  assert.equal(actual.authorRuleCount, 0);
  assert.equal(actual.authorDeclarationCount, 0);
  assert.equal(actual.decodedImageCount, 0);
  assert.equal(actual.paintedBackground, false);
  assert.ok(!actual.paintOps.includes("rect"));
  assert.ok(actual.paintOps.includes("text"));
  assert.ok(actual.pngBytes > 0);
}
