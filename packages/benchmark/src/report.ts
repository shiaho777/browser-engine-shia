/**
 * Benchmark_Report — assemble the live metrics + cited competitor data + per
 * dimension verdicts into a complete, deterministic `BENCHMARK.md`
 * (compete-with-google-benchmark spec; Requirement 4).
 *
 * The report is deterministic: it carries NO real timestamp (a fixed note
 * instead), so regenerating it with no code change is byte-for-byte identical.
 * It leads with the WIN dimensions (the headline), then the full head-to-head
 * table, per-dimension explanations, an honesty statement, and a citations list.
 */
import { COMPETITORS, type CompetitorDatum } from "./competitors.data.js";
import { evaluateDimensions, type DimensionResult, type Verdict } from "./dimensions.js";
import type { LiveMetrics } from "./metrics.js";

/** A full benchmark snapshot: live metrics + per-dimension verdicts. */
export interface BenchmarkSnapshot {
  readonly metrics: LiveMetrics;
  readonly dimensions: readonly DimensionResult[];
}

/** Machine-readable public evidence report, generated from the same snapshot as Markdown. */
export interface BenchmarkJsonReport extends BenchmarkSnapshot {
  readonly schemaVersion: 1;
  readonly generatedBy: "@browser-engine/benchmark";
  readonly deterministic: true;
}

/** Build the snapshot from live metrics (pure). */
export function buildSnapshot(metrics: LiveMetrics): BenchmarkSnapshot {
  return { metrics, dimensions: evaluateDimensions(metrics) };
}

/** Build the stable JSON report object from a snapshot. */
export function buildBenchmarkJsonReport(snapshot: BenchmarkSnapshot): BenchmarkJsonReport {
  return Object.freeze({
    schemaVersion: 1,
    generatedBy: "@browser-engine/benchmark",
    deterministic: true,
    metrics: snapshot.metrics,
    dimensions: snapshot.dimensions,
  });
}

/** Render machine-readable evidence from the same deterministic snapshot. */
export function renderBenchmarkJson(snapshot: BenchmarkSnapshot): string {
  return `${JSON.stringify(buildBenchmarkJsonReport(snapshot), null, 2)}\n`;
}

/** Render a static, dependency-free evidence dashboard from the benchmark snapshot. */
export function renderEvidenceDashboardHtml(snapshot: BenchmarkSnapshot): string {
  const { metrics, dimensions } = snapshot;
  const evidence = metrics.executionEvidence;
  const wins = dimensions.filter((d) => d.verdict === "WIN").length;
  const gaps = dimensions.filter((d) => d.verdict === "GAP").length;
  const ncs = dimensions.filter((d) => d.verdict === "NOT-COMPARABLE").length;
  const cards = [
    metricCard("Hand-written lines", metrics.handWrittenLines.toLocaleString("en-US"), "product surface"),
    metricCard("Platform features", metrics.platformFeatureCount.toLocaleString("en-US"), "CSS + DOM data"),
    metricCard("Compat / LOC", metrics.compatPerLoc === null ? "—" : metrics.compatPerLoc.toFixed(4), "passes per line"),
    metricCard(
      "Mechanism density",
      metrics.mechanismDensity === null ? "—" : metrics.mechanismDensity.toFixed(2),
      "features / kloc",
    ),
  ].join("\n");
  const dimensionRows = dimensions.map((d) => (
    `<tr><th>${escapeHtml(d.label)}</th><td>${escapeHtml(d.ourDisplay)}</td><td>${escapeHtml(d.verdict)}</td></tr>`
  )).join("\n");
  const evidenceBlocks = evidence === undefined
    ? "<p>No execution evidence attached to this snapshot.</p>"
    : [
        section(
          "Maintained WPT Trace",
          [
            ["Subsets", evidence.subsetCount],
            ["Files / subtests", `${evidence.files} / ${evidence.subtests}`],
            ["Outcomes", `${evidence.passed} passed, ${evidence.failed} failed, ${evidence.errored} errored`],
            ["Query calls", evidence.queryCalls],
            ["Recomputes", evidence.recomputes],
            ["Cache hits", evidence.cacheHits],
            ["Dependency reads", evidence.dependencyReads],
          ],
        ),
        section(
          "Incremental Edit Sequence",
          [
            ["Scenario", evidence.incrementalEdit.scenario],
            ["Paint-only reused layout", yesNo(evidence.incrementalEdit.paintOnlyReusedLayout)],
            ["Layout edit recomputed layout", yesNo(evidence.incrementalEdit.layoutEditRecomputedLayout)],
            ["No-mutation recomputes", evidence.incrementalEdit.noMutationRecomputes],
            ["Verified cache hits", evidence.incrementalEdit.verifiedCacheHits],
          ],
        ),
        section(
          "Script-Driven DOM Mutation",
          [
            ["Scenario", evidence.scriptDrivenEdit.scenario],
            ["Document nodes", `${evidence.scriptDrivenEdit.initialDocumentNodes} → ${evidence.scriptDrivenEdit.finalDocumentNodes}`],
            ["Script mutations", evidence.scriptDrivenEdit.scriptMutations],
            ["appendChild increased nodes", yesNo(evidence.scriptDrivenEdit.appendChildIncreasedNodes)],
            ["Appended node painted", yesNo(evidence.scriptDrivenEdit.appendedNodePainted)],
          ],
        ),
        section(
          "Resource-Loaded Page",
          [
            ["URL", evidence.resourceLoadedPage.url],
            ["External resources", `${evidence.resourceLoadedPage.discoveredResources} discovered, ${evidence.resourceLoadedPage.loadedResources} loaded, ${evidence.resourceLoadedPage.missingResources} missing`],
            ["Stylesheets / images", `${evidence.resourceLoadedPage.stylesheetCount} / ${evidence.resourceLoadedPage.decodedImageCount}`],
            ["Missing image painted", yesNo(evidence.resourceLoadedPage.missingImage.paintedImage)],
            ["Invalid image decoded", evidence.resourceLoadedPage.invalidImage.decodedImageCount],
            ["Invalid image painted", yesNo(evidence.resourceLoadedPage.invalidImage.paintedImage)],
            ["Duplicate shared fetches", evidence.resourceLoadedPage.duplicateResource.sharedResourceFetches],
            ["Duplicate painted images", evidence.resourceLoadedPage.duplicateResource.paintedImageCount],
            ["Duplicate stylesheet shared fetches", evidence.resourceLoadedPage.duplicateStylesheet.sharedStylesheetFetches],
            ["Duplicate stylesheet author sheets", evidence.resourceLoadedPage.duplicateStylesheet.authorStylesheetCount],
            ["Duplicate stylesheet source-order winner", yesNo(evidence.resourceLoadedPage.duplicateStylesheet.duplicateLinkWonSourceOrder)],
            ["Data URL fetch calls", evidence.resourceLoadedPage.dataUrlNoNetwork.fetchCalls],
            ["Data URL painted image", evidence.resourceLoadedPage.dataUrlNoNetwork.paintedImageCount],
            ["Data URL charset percent author declarations", evidence.resourceLoadedPage.dataUrlStylesheetCharset.percentUtf8.authorDeclarationCount],
            ["Data URL charset base64 author declarations", evidence.resourceLoadedPage.dataUrlStylesheetCharset.base64Utf8.authorDeclarationCount],
            ["Data URL unsupported charset author sheets", evidence.resourceLoadedPage.dataUrlStylesheetCharset.unsupportedCharset.authorStylesheetCount],
            ["Data URL stylesheet external-after source-order winner", yesNo(evidence.resourceLoadedPage.dataUrlStylesheetSourceOrder.externalAfterDataUrl.sourceOrderWinnerBlue)],
            ["Data URL stylesheet data-after source-order winner", yesNo(evidence.resourceLoadedPage.dataUrlStylesheetSourceOrder.dataUrlAfterExternal.sourceOrderWinnerBlue)],
            ["Data URL stylesheet data URL fetch calls", `${evidence.resourceLoadedPage.dataUrlStylesheetSourceOrder.externalAfterDataUrl.dataUrlFetchCalls} / ${evidence.resourceLoadedPage.dataUrlStylesheetSourceOrder.dataUrlAfterExternal.dataUrlFetchCalls}`],
            ["External/inline stylesheet inline-after source-order winner", yesNo(evidence.resourceLoadedPage.externalInlineStylesheetSourceOrder.inlineAfterExternal.sourceOrderWinnerBlue)],
            ["External/inline stylesheet external-after source-order winner", yesNo(evidence.resourceLoadedPage.externalInlineStylesheetSourceOrder.externalAfterInline.sourceOrderWinnerBlue)],
            ["External/inline stylesheet external fetches", `${evidence.resourceLoadedPage.externalInlineStylesheetSourceOrder.inlineAfterExternal.externalStylesheetFetches} / ${evidence.resourceLoadedPage.externalInlineStylesheetSourceOrder.externalAfterInline.externalStylesheetFetches}`],
            ["Invalid data image painted", evidence.resourceLoadedPage.invalidDataImage.paintedImageCount],
            ["Invalid data stylesheet author declarations", evidence.resourceLoadedPage.invalidDataStylesheet.authorDeclarationCount],
            ["Invalid data stylesheet background", yesNo(evidence.resourceLoadedPage.invalidDataStylesheet.paintedBackground)],
            ["Non-CSS data stylesheet author sheets", evidence.resourceLoadedPage.nonCssDataStylesheet.authorStylesheetCount],
            ["Non-CSS data stylesheet background", yesNo(evidence.resourceLoadedPage.nonCssDataStylesheet.paintedBackground)],
            ["No-href stylesheet author sheets", evidence.resourceLoadedPage.noHrefStylesheet.authorStylesheetCount],
            ["No-href stylesheet background", yesNo(evidence.resourceLoadedPage.noHrefStylesheet.paintedBackground)],
            ["Empty-href stylesheet loaded resources", evidence.resourceLoadedPage.emptyHrefStylesheet.loadedResources],
            ["Empty-href stylesheet author declarations", evidence.resourceLoadedPage.emptyHrefStylesheet.authorDeclarationCount],
            ["Empty-href stylesheet background", yesNo(evidence.resourceLoadedPage.emptyHrefStylesheet.paintedBackground)],
            ["Fragment-href stylesheet loaded resources", evidence.resourceLoadedPage.fragmentHrefStylesheet.loadedResources],
            ["Fragment-href stylesheet author declarations", evidence.resourceLoadedPage.fragmentHrefStylesheet.authorDeclarationCount],
            ["Fragment-href stylesheet background", yesNo(evidence.resourceLoadedPage.fragmentHrefStylesheet.paintedBackground)],
            ["Query-href stylesheet loaded resources", evidence.resourceLoadedPage.queryHrefStylesheet.loadedResources],
            ["Query-href stylesheet author declarations", evidence.resourceLoadedPage.queryHrefStylesheet.authorDeclarationCount],
            ["Query-href stylesheet background", yesNo(evidence.resourceLoadedPage.queryHrefStylesheet.paintedBackground)],
            ["Protocol-relative stylesheet loaded resources", evidence.resourceLoadedPage.protocolRelativeStylesheet.loadedResources],
            ["Protocol-relative stylesheet author declarations", evidence.resourceLoadedPage.protocolRelativeStylesheet.authorDeclarationCount],
            ["Protocol-relative stylesheet background", yesNo(evidence.resourceLoadedPage.protocolRelativeStylesheet.paintedBackground)],
            ["Whitespace-rel stylesheet loaded resources", evidence.resourceLoadedPage.whitespaceRelStylesheet.loadedResources],
            ["Whitespace-rel stylesheet author declarations", evidence.resourceLoadedPage.whitespaceRelStylesheet.authorDeclarationCount],
            ["Whitespace-rel stylesheet background", yesNo(evidence.resourceLoadedPage.whitespaceRelStylesheet.paintedBackground)],
            ["Whitespace-rel stylesheet source-order winner", yesNo(evidence.resourceLoadedPage.whitespaceRelStylesheet.sourceOrderWinnerBlue)],
            ["Whitespace-rel alternate author sheets", evidence.resourceLoadedPage.whitespaceRelStylesheet.alternateAuthorStylesheetCount],
            ["Duplicate-rel stylesheet loaded resources", evidence.resourceLoadedPage.duplicateRelStylesheet.loadedResources],
            ["Duplicate-rel stylesheet author sheets", evidence.resourceLoadedPage.duplicateRelStylesheet.authorStylesheetCount],
            ["Duplicate-rel stylesheet source-order winner", yesNo(evidence.resourceLoadedPage.duplicateRelStylesheet.sourceOrderWinnerBlue)],
            ["Duplicate-rel alternate author sheets", evidence.resourceLoadedPage.duplicateRelStylesheet.alternateAuthorStylesheetCount],
            ["Whitespace-href stylesheet loaded resources", evidence.resourceLoadedPage.whitespaceHrefStylesheet.loadedResources],
            ["Whitespace-href stylesheet loaded URL", evidence.resourceLoadedPage.whitespaceHrefStylesheet.loadedResourceUrl],
            ["Whitespace-href stylesheet source-order winner", yesNo(evidence.resourceLoadedPage.whitespaceHrefStylesheet.sourceOrderWinnerBlue)],
            ["Control-char href stylesheet loaded URL", evidence.resourceLoadedPage.controlCharacterHrefStylesheet.loadedResourceUrl],
            ["Control-char href stylesheet source-order winner", yesNo(evidence.resourceLoadedPage.controlCharacterHrefStylesheet.sourceOrderWinnerBlue)],
            ["Base-href stylesheet loaded URL", evidence.resourceLoadedPage.baseHrefSubresource.loadedStylesheetUrl],
            ["Base-href image loaded URL", evidence.resourceLoadedPage.baseHrefSubresource.loadedImageUrl],
            ["Base-href stylesheet/image fetches", `${evidence.resourceLoadedPage.baseHrefSubresource.stylesheetFetches} / ${evidence.resourceLoadedPage.baseHrefSubresource.imageFetches}`],
            ["Invalid-url stylesheet loaded resources", evidence.resourceLoadedPage.invalidUrlStylesheet.loadedResources],
            ["Invalid-url stylesheet author sheets", evidence.resourceLoadedPage.invalidUrlStylesheet.authorStylesheetCount],
            ["Invalid-url stylesheet source-order winner", yesNo(evidence.resourceLoadedPage.invalidUrlStylesheet.sourceOrderWinnerBlue)],
            ["Invalid-url-only missing resources", evidence.resourceLoadedPage.invalidUrlStylesheet.invalidOnlyMissingResources],
            ["Alternate stylesheet author sheets", evidence.resourceLoadedPage.alternateStylesheet.authorStylesheetCount],
            ["Alternate stylesheet background", yesNo(evidence.resourceLoadedPage.alternateStylesheet.paintedBackground)],
            ["Disabled stylesheet author sheets", evidence.resourceLoadedPage.disabledStylesheet.authorStylesheetCount],
            ["Disabled stylesheet background", yesNo(evidence.resourceLoadedPage.disabledStylesheet.paintedBackground)],
            ["Print-media stylesheet author sheets", evidence.resourceLoadedPage.printMediaStylesheet.authorStylesheetCount],
            ["Print-media stylesheet background", yesNo(evidence.resourceLoadedPage.printMediaStylesheet.paintedBackground)],
            ["Empty media stylesheet author sheets", evidence.resourceLoadedPage.stylesheetMediaList.empty.authorStylesheetCount],
            ["Whitespace-only media stylesheet author sheets", evidence.resourceLoadedPage.stylesheetMediaList.whitespaceOnly.authorStylesheetCount],
            ["Media-list stylesheet matching author sheets", evidence.resourceLoadedPage.stylesheetMediaList.matchingList.authorStylesheetCount],
            ["Media-list stylesheet matching background", yesNo(evidence.resourceLoadedPage.stylesheetMediaList.matchingList.paintedBackground)],
            ["Spaced media-list author sheets", evidence.resourceLoadedPage.stylesheetMediaList.spacedMatchingList.authorStylesheetCount],
            ["Spaced media-list background", yesNo(evidence.resourceLoadedPage.stylesheetMediaList.spacedMatchingList.paintedBackground)],
            ["Empty item before screen media author sheets", evidence.resourceLoadedPage.stylesheetMediaList.emptyItemBeforeScreen.authorStylesheetCount],
            ["Empty item after screen media author sheets", evidence.resourceLoadedPage.stylesheetMediaList.emptyItemAfterScreen.authorStylesheetCount],
            ["Empty-only media list author sheets", evidence.resourceLoadedPage.stylesheetMediaList.emptyItemsOnly.authorStylesheetCount],
            ["Unsupported media-list then screen author sheets", evidence.resourceLoadedPage.stylesheetMediaList.unsupportedThenScreen.authorStylesheetCount],
            ["Unsupported media-list then screen background", yesNo(evidence.resourceLoadedPage.stylesheetMediaList.unsupportedThenScreen.paintedBackground)],
            ["Unsupported media-list only author sheets", evidence.resourceLoadedPage.stylesheetMediaList.unsupportedOnly.authorStylesheetCount],
            ["Unknown media type then screen author sheets", evidence.resourceLoadedPage.stylesheetMediaList.unknownTypeThenScreen.authorStylesheetCount],
            ["Unknown media type only author sheets", evidence.resourceLoadedPage.stylesheetMediaList.unknownTypeOnly.authorStylesheetCount],
            ["Uppercase screen media author sheets", evidence.resourceLoadedPage.stylesheetMediaList.uppercaseScreen.authorStylesheetCount],
            ["Mixed-case only-screen media author sheets", evidence.resourceLoadedPage.stylesheetMediaList.mixedCaseOnlyScreen.authorStylesheetCount],
            ["Spaced only-screen media author sheets", evidence.resourceLoadedPage.stylesheetMediaList.spacedOnlyScreen.authorStylesheetCount],
            ["Uppercase print media author sheets", evidence.resourceLoadedPage.stylesheetMediaList.uppercasePrint.authorStylesheetCount],
            ["All media stylesheet author sheets", evidence.resourceLoadedPage.stylesheetMediaList.all.authorStylesheetCount],
            ["Only-all stylesheet author sheets", evidence.resourceLoadedPage.stylesheetMediaList.onlyAll.authorStylesheetCount],
            ["Not-all stylesheet author sheets", evidence.resourceLoadedPage.stylesheetMediaList.notAll.authorStylesheetCount],
            ["Spaced not-all stylesheet author sheets", evidence.resourceLoadedPage.stylesheetMediaList.spacedNotAll.authorStylesheetCount],
            ["Not-print stylesheet author sheets", evidence.resourceLoadedPage.stylesheetMediaList.notPrint.authorStylesheetCount],
            ["Spaced not-print stylesheet author sheets", evidence.resourceLoadedPage.stylesheetMediaList.spacedNotPrint.authorStylesheetCount],
            ["Only-print stylesheet author sheets", evidence.resourceLoadedPage.stylesheetMediaList.onlyPrint.authorStylesheetCount],
            ["Spaced only-print stylesheet author sheets", evidence.resourceLoadedPage.stylesheetMediaList.spacedOnlyPrint.authorStylesheetCount],
            ["Media-feature min-width author sheets", evidence.resourceLoadedPage.stylesheetMediaFeature.screenMinWidth.authorStylesheetCount],
            ["Uppercase media-feature min-width author sheets", evidence.resourceLoadedPage.stylesheetMediaFeature.uppercaseScreenMinWidth.authorStylesheetCount],
            ["Decimal media-feature min-width author sheets", evidence.resourceLoadedPage.stylesheetMediaFeature.decimalScreenMinWidth.authorStylesheetCount],
            ["Spaced media-feature min-width author sheets", evidence.resourceLoadedPage.stylesheetMediaFeature.spacedScreenMinWidth.authorStylesheetCount],
            ["Media-feature bare min-width author sheets", evidence.resourceLoadedPage.stylesheetMediaFeature.bareMinWidth.authorStylesheetCount],
            ["All-and media-feature min-width author sheets", evidence.resourceLoadedPage.stylesheetMediaFeature.allMinWidth.authorStylesheetCount],
            ["All-and media-feature max-width author sheets", evidence.resourceLoadedPage.stylesheetMediaFeature.allMaxWidth.authorStylesheetCount],
            ["Only-all-and media-feature min-width author sheets", evidence.resourceLoadedPage.stylesheetMediaFeature.onlyAllMinWidth.authorStylesheetCount],
            ["Unsupported range media-feature author sheets", evidence.resourceLoadedPage.stylesheetMediaFeature.unsupportedRangeWidth.authorStylesheetCount],
            ["Unsupported range media-feature background", yesNo(evidence.resourceLoadedPage.stylesheetMediaFeature.unsupportedRangeWidth.paintedBackground)],
            ["Unsupported range then screen author sheets", evidence.resourceLoadedPage.stylesheetMediaFeature.unsupportedRangeThenScreen.authorStylesheetCount],
            ["Unsupported calc media-feature author sheets", evidence.resourceLoadedPage.stylesheetMediaFeature.unsupportedCalcMinWidth.authorStylesheetCount],
            ["Unsupported hover media-feature author sheets", evidence.resourceLoadedPage.stylesheetMediaFeature.unsupportedHover.authorStylesheetCount],
            ["Invalid empty media-feature author sheets", evidence.resourceLoadedPage.stylesheetMediaFeature.invalidEmptyFeature.authorStylesheetCount],
            ["Unsupported boolean width media-feature author sheets", evidence.resourceLoadedPage.stylesheetMediaFeature.unsupportedBooleanWidth.authorStylesheetCount],
            ["Unknown media-feature author sheets", evidence.resourceLoadedPage.stylesheetMediaFeature.unknownFeature.authorStylesheetCount],
            ["Invalid empty feature then screen author sheets", evidence.resourceLoadedPage.stylesheetMediaFeature.invalidEmptyFeatureThenScreen.authorStylesheetCount],
            ["Media-feature max-width author sheets", evidence.resourceLoadedPage.stylesheetMediaFeature.screenMaxWidth.authorStylesheetCount],
            ["Media-feature max-width background", yesNo(evidence.resourceLoadedPage.stylesheetMediaFeature.screenMaxWidth.paintedBackground)],
            ["Decimal media-feature max-width author sheets", evidence.resourceLoadedPage.stylesheetMediaFeature.decimalScreenMaxWidth.authorStylesheetCount],
            ["Decimal media-feature max-width background", yesNo(evidence.resourceLoadedPage.stylesheetMediaFeature.decimalScreenMaxWidth.paintedBackground)],
            ["Spaced media-feature max-width author sheets", evidence.resourceLoadedPage.stylesheetMediaFeature.spacedScreenMaxWidth.authorStylesheetCount],
            ["Spaced media-feature max-width background", yesNo(evidence.resourceLoadedPage.stylesheetMediaFeature.spacedScreenMaxWidth.paintedBackground)],
            ["Media-feature min-height author sheets", evidence.resourceLoadedPage.stylesheetMediaFeature.screenMinHeight.authorStylesheetCount],
            ["Media-feature max-height author sheets", evidence.resourceLoadedPage.stylesheetMediaFeature.screenMaxHeight.authorStylesheetCount],
            ["Media-feature max-height background", yesNo(evidence.resourceLoadedPage.stylesheetMediaFeature.screenMaxHeight.paintedBackground)],
            ["Media-feature exact-width author sheets", evidence.resourceLoadedPage.stylesheetMediaFeature.screenExactWidth.authorStylesheetCount],
            ["Decimal media-feature exact-width author sheets", evidence.resourceLoadedPage.stylesheetMediaFeature.decimalScreenExactWidth.authorStylesheetCount],
            ["Media-feature exact-height author sheets", evidence.resourceLoadedPage.stylesheetMediaFeature.screenExactHeight.authorStylesheetCount],
            ["Media-feature exact-height miss author sheets", evidence.resourceLoadedPage.stylesheetMediaFeature.screenExactHeightMiss.authorStylesheetCount],
            ["Media-feature negated matching author sheets", evidence.resourceLoadedPage.stylesheetMediaFeature.negatedMatchingFeature.authorStylesheetCount],
            ["Media-feature negated missing author sheets", evidence.resourceLoadedPage.stylesheetMediaFeature.negatedMissingFeature.authorStylesheetCount],
            ["Media-feature negated missing background", yesNo(evidence.resourceLoadedPage.stylesheetMediaFeature.negatedMissingFeature.paintedBackground)],
            ["Orientation landscape author sheets", evidence.resourceLoadedPage.stylesheetOrientationMedia.landscape.authorStylesheetCount],
            ["Orientation landscape background", yesNo(evidence.resourceLoadedPage.stylesheetOrientationMedia.landscape.paintedBackground)],
            ["Uppercase orientation landscape author sheets", evidence.resourceLoadedPage.stylesheetOrientationMedia.uppercaseLandscape.authorStylesheetCount],
            ["Uppercase orientation landscape background", yesNo(evidence.resourceLoadedPage.stylesheetOrientationMedia.uppercaseLandscape.paintedBackground)],
            ["Orientation portrait author sheets", evidence.resourceLoadedPage.stylesheetOrientationMedia.portrait.authorStylesheetCount],
            ["Orientation portrait background", yesNo(evidence.resourceLoadedPage.stylesheetOrientationMedia.portrait.paintedBackground)],
            ["Uppercase orientation portrait author sheets", evidence.resourceLoadedPage.stylesheetOrientationMedia.uppercasePortrait.authorStylesheetCount],
            ["Uppercase orientation portrait background", yesNo(evidence.resourceLoadedPage.stylesheetOrientationMedia.uppercasePortrait.paintedBackground)],
            ["Combined media-feature author sheets", evidence.resourceLoadedPage.stylesheetCombinedMediaFeature.matching.authorStylesheetCount],
            ["Combined media-feature background", yesNo(evidence.resourceLoadedPage.stylesheetCombinedMediaFeature.matching.paintedBackground)],
            ["Combined media-feature miss author sheets", evidence.resourceLoadedPage.stylesheetCombinedMediaFeature.laterMiss.authorStylesheetCount],
            ["Combined media-feature miss background", yesNo(evidence.resourceLoadedPage.stylesheetCombinedMediaFeature.laterMiss.paintedBackground)],
            ["Invalid external stylesheet resources", `${evidence.resourceLoadedPage.invalidExternalStylesheet.loadedResources} loaded, ${evidence.resourceLoadedPage.invalidExternalStylesheet.missingResources} missing`],
            ["Invalid external stylesheet author declarations", evidence.resourceLoadedPage.invalidExternalStylesheet.authorDeclarationCount],
            ["Missing stylesheet author declarations", evidence.resourceLoadedPage.missingStylesheet.authorDeclarationCount],
            ["Missing stylesheet background", yesNo(evidence.resourceLoadedPage.missingStylesheet.paintedBackground)],
            ["Paint ops", evidence.resourceLoadedPage.paintOps.join(", ") || "—"],
            ["PNG output", `${evidence.resourceLoadedPage.width}x${evidence.resourceLoadedPage.height}, ${evidence.resourceLoadedPage.pngBytes} bytes`],
          ],
        ),
        section(
          "Real-Site Smoke",
          [
            ["Scenarios", evidence.realSiteSmoke.scenarioCount],
            ["Outcomes", `${evidence.realSiteSmoke.passed} passed, ${evidence.realSiteSmoke.failed} failed`],
            ["Capabilities", evidence.realSiteSmoke.coveredCapabilities.join(", ") || "—"],
          ],
        ),
      ].join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Browser Engine Evidence Dashboard</title>
<style>
:root {
  color-scheme: light;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #f6f7f4;
  color: #1f2521;
}
body {
  margin: 0;
}
header, main {
  max-width: 1120px;
  margin: 0 auto;
  padding: 32px 20px;
}
header {
  display: grid;
  gap: 12px;
  padding-top: 48px;
}
h1 {
  margin: 0;
  font-size: 38px;
  line-height: 1.05;
}
h2 {
  margin: 0 0 14px;
  font-size: 20px;
}
p {
  max-width: 760px;
  margin: 0;
  color: #526057;
  line-height: 1.6;
}
.summary {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  color: #36443b;
}
.pill {
  border: 1px solid #cbd3c7;
  background: #ffffff;
  border-radius: 999px;
  padding: 7px 11px;
  font-size: 13px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 12px;
}
.card, section {
  background: #ffffff;
  border: 1px solid #d7ded4;
  border-radius: 8px;
  box-shadow: 0 1px 0 rgba(31, 37, 33, 0.04);
}
.card {
  padding: 16px;
}
.label {
  color: #627067;
  font-size: 13px;
}
.value {
  margin-top: 8px;
  font-size: 28px;
  font-weight: 720;
}
.hint {
  margin-top: 4px;
  color: #6e7a71;
  font-size: 13px;
}
main {
  display: grid;
  gap: 18px;
}
section {
  padding: 18px;
}
table {
  width: 100%;
  border-collapse: collapse;
}
th, td {
  padding: 10px 0;
  border-top: 1px solid #e5e9e2;
  text-align: left;
  vertical-align: top;
}
th {
  width: 42%;
  font-weight: 650;
}
.facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px 18px;
}
.fact {
  border-top: 1px solid #e5e9e2;
  padding-top: 10px;
}
.fact b {
  display: block;
  margin-bottom: 3px;
}
footer {
  max-width: 1120px;
  margin: 0 auto;
  padding: 0 20px 40px;
  color: #66736a;
  font-size: 13px;
}
</style>
</head>
<body>
<header>
  <h1>Evidence Dashboard</h1>
  <p>Generated from the same deterministic benchmark snapshot as BENCHMARK.md and benchmark-evidence.json. This HTML file is the static dashboard view of that evidence; no live network data or wall-clock timing is embedded.</p>
  <div class="summary">
    <span class="pill">${wins} wins</span>
    <span class="pill">${gaps} honest gaps</span>
    <span class="pill">${ncs} not comparable</span>
    <span class="pill">schema v1</span>
  </div>
</header>
<main>
  <div class="grid">
${cards}
  </div>
  <section>
    <h2>Benchmark Dimensions</h2>
    <table>
      <tbody>
${dimensionRows}
      </tbody>
    </table>
  </section>
${evidenceBlocks}
</main>
<footer>Regenerate with npm run evidence. Public artifacts must stay committed together.</footer>
</body>
</html>
`;
}

/** A small verdict badge for the table. */
function badge(v: Verdict): string {
  switch (v) {
    case "WIN":
      return "🟢 WIN";
    case "GAP":
      return "🟡 GAP";
    case "NOT-COMPARABLE":
      return "⚪ N/C";
  }
}

/** Render a competitor cell (value + short source), or a needs-source note. */
function competitorCell(c: CompetitorDatum | null): string {
  if (c === null) return "—";
  if (c.value === null) return "_needs-source_";
  const v = c.unit === "%" ? `${c.value}${c.unit}` : `${c.value.toLocaleString("en-US")} ${c.unit}`;
  return `${v} _(${c.sourceName})_`;
}

/** Escape a cell's pipe characters so the Markdown table stays well-formed. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

/** Escape text for static HTML output. */
function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function metricCard(label: string, value: string, hint: string): string {
  return `    <article class="card"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div><div class="hint">${escapeHtml(hint)}</div></article>`;
}

function section(title: string, facts: readonly (readonly [string, string | number])[]): string {
  const rows = facts.map(([label, value]) => (
    `<div class="fact"><b>${escapeHtml(label)}</b><span>${escapeHtml(value)}</span></div>`
  )).join("\n");
  return `<section>
    <h2>${escapeHtml(title)}</h2>
    <div class="facts">
${rows}
    </div>
  </section>`;
}

/**
 * Render the complete `BENCHMARK.md` from a snapshot. Deterministic: identical
 * snapshot ⇒ identical bytes (no timestamps).
 */
export function renderBenchmarkMarkdown(snapshot: BenchmarkSnapshot): string {
  const { metrics, dimensions } = snapshot;
  const wins = dimensions.filter((d) => d.verdict === "WIN");
  const gaps = dimensions.filter((d) => d.verdict === "GAP");
  const ncs = dimensions.filter((d) => d.verdict === "NOT-COMPARABLE");

  const lines: string[] = [];

  lines.push("# BENCHMARK — Head-to-Head vs Chromium / Chrome");
  lines.push("");
  lines.push(
    "> Generated by `@browser-engine/benchmark`. **Our numbers are computed live from this repository** (re-run `npm run benchmark` to reproduce). **Chromium's numbers are cited reference snapshots** — never re-run here, never invented. Where no citation exists, the cell reads _needs-source_ rather than a fabricated value.",
  );
  lines.push("");

  // ---- Headline: the dimensions we win -----------------------------------
  lines.push("## Headline — where we lead");
  lines.push("");
  if (wins.length === 0) {
    lines.push("_No WIN dimensions in this snapshot._");
  } else {
    for (const w of wins) {
      lines.push(`- **${w.label}: ${w.ourDisplay}** — ${w.rationale}`);
    }
  }
  lines.push("");

  // ---- Overall honest summary line ---------------------------------------
  lines.push("## Overall");
  lines.push("");
  lines.push(
    `We **lead** on ${wins.length} dimension(s) (${wins.map((d) => d.label.split(" (")[0]).join(", ") || "—"}); ` +
      `we **honestly trail** on ${gaps.length} (${gaps.map((d) => d.label.split(" (")[0]).join(", ") || "—"}); ` +
      `and ${ncs.length} dimension(s) are **not comparable** without a co-located run (${ncs.map((d) => d.label.split(" (")[0]).join(", ") || "—"}). ` +
      "We win on mechanism, readability, and compat-per-LOC; Chromium wins on raw breadth and shipping performance. That asymmetry is the whole strategy.",
  );
  lines.push("");

  // ---- The head-to-head table --------------------------------------------
  lines.push("## Head-to-head");
  lines.push("");
  lines.push("| Dimension | Ours (live) | Chromium (cited) | Verdict |");
  lines.push("|---|---|---|---|");
  for (const d of dimensions) {
    lines.push(
      `| ${cell(d.label)} | ${cell(d.ourDisplay)} | ${cell(competitorCell(d.competitor))} | ${badge(d.verdict)} |`,
    );
  }
  lines.push("");

  // ---- Live metrics breakdown --------------------------------------------
  lines.push("## Our live metrics (re-computed every run)");
  lines.push("");
  lines.push(`- Hand-written product lines: **${metrics.handWrittenLines.toLocaleString("en-US")}**`);
  lines.push(`- Generated lines: ${metrics.generatedLines.toLocaleString("en-US")}`);
  lines.push(`- Test lines: ${metrics.testLines.toLocaleString("en-US")}`);
  lines.push(`- Total system size: ${metrics.totalLines.toLocaleString("en-US")}`);
  lines.push(`- CSS properties (data table): **${metrics.cssPropertyCount}**`);
  lines.push(`- DOM interface members (IDL table): **${metrics.domMemberCount}**`);
  lines.push(`- Platform features total: ${metrics.platformFeatureCount}`);
  lines.push(`- Benchmark self-test numerator: ${metrics.wptPassCount} passing checks`);
  lines.push(
    `- **compat-per-LOC: ${metrics.compatPerLoc === null ? "—" : metrics.compatPerLoc.toFixed(4)} passes/line**`,
  );
  lines.push(
    `- **mechanism-density: ${metrics.mechanismDensity === null ? "—" : metrics.mechanismDensity.toFixed(2)} features/kloc**`,
  );
  lines.push("");

  // ---- Execution evidence ------------------------------------------------
  lines.push("## Execution evidence (maintained WPT subset trace)");
  lines.push("");
  if (metrics.executionEvidence === undefined) {
    lines.push("_No maintained-subset trace evidence attached to this snapshot._");
  } else {
    const e = metrics.executionEvidence;
    lines.push(`- Maintained subsets traced: ${e.subsetCount}`);
    lines.push(`- WPT files/subtests: ${e.files} files, ${e.subtests} subtests`);
    lines.push(`- WPT outcomes: ${e.passed} passed, ${e.failed} failed, ${e.errored} errored`);
    lines.push(`- Query calls: ${e.queryCalls}`);
    lines.push(`- Recomputation events: ${e.recomputes}`);
    lines.push(`- Cache hits: ${e.cacheHits}`);
    lines.push(`- Verified cache hits: ${e.verifiedCacheHits}`);
    lines.push(`- Dependency reads: ${e.dependencyReads}`);
    lines.push(`- Traced stages: ${e.tracedStages.join(", ") || "—"}`);
    lines.push("");
    lines.push("## Incremental edit-sequence evidence");
    lines.push("");
    const edit = e.incrementalEdit;
    lines.push(`- Scenario: ${edit.scenario}`);
    lines.push(`- Document nodes: ${edit.documentNodes}`);
    lines.push(`- Edited node: ${edit.editedNode}`);
    lines.push(`- Paint-only edit reused layout: ${edit.paintOnlyReusedLayout ? "yes" : "no"}`);
    lines.push(`- Layout-affecting edit recomputed layout: ${edit.layoutEditRecomputedLayout ? "yes" : "no"}`);
    lines.push(`- No-mutation render recomputes: ${edit.noMutationRecomputes}`);
    lines.push(`- Query calls: ${edit.queryCalls}`);
    lines.push(`- Recomputation events: ${edit.recomputes}`);
    lines.push(`- Cache hits: ${edit.cacheHits}`);
    lines.push(`- Verified cache hits: ${edit.verifiedCacheHits}`);
    lines.push(`- Dependency reads: ${edit.dependencyReads}`);
    lines.push(`- Traced stages: ${edit.tracedStages.join(", ") || "—"}`);
    lines.push("");
    lines.push("| Step | Calls | Recomputes | Cache hits | Verified hits | Dependency reads |");
    lines.push("|---|---:|---:|---:|---:|---:|");
    for (const step of edit.steps) {
      lines.push(
        `| ${step.name} | ${step.queryCalls} | ${step.recomputes} | ${step.cacheHits} | ${step.verifiedCacheHits} | ${step.dependencyReads} |`,
      );
    }
    lines.push("");
    lines.push("## Script-driven DOM mutation evidence");
    lines.push("");
    const script = e.scriptDrivenEdit;
    lines.push(`- Scenario: ${script.scenario}`);
    lines.push(`- Document nodes: ${script.initialDocumentNodes} → ${script.finalDocumentNodes}`);
    lines.push(`- Script DOM mutations: ${script.scriptMutations}`);
    lines.push(`- Paint-only script edit reused layout: ${script.paintOnlyReusedLayout ? "yes" : "no"}`);
    lines.push(`- Layout-affecting script edit recomputed layout: ${script.layoutEditRecomputedLayout ? "yes" : "no"}`);
    lines.push(`- appendChild increased nodes: ${script.appendChildIncreasedNodes ? "yes" : "no"}`);
    lines.push(`- Appended node painted: ${script.appendedNodePainted ? "yes" : "no"}`);
    lines.push(`- Query calls: ${script.queryCalls}`);
    lines.push(`- Recomputation events: ${script.recomputes}`);
    lines.push(`- Cache hits: ${script.cacheHits}`);
    lines.push(`- Verified cache hits: ${script.verifiedCacheHits}`);
    lines.push(`- Dependency reads: ${script.dependencyReads}`);
    lines.push(`- Traced stages: ${script.tracedStages.join(", ") || "—"}`);
    lines.push("");
    lines.push("| Step | Mutations | Calls | Recomputes | Cache hits | Verified hits | Dependency reads |");
    lines.push("|---|---:|---:|---:|---:|---:|---:|");
    for (const step of script.steps) {
      lines.push(
        `| ${step.name} | ${step.mutations} | ${step.queryCalls} | ${step.recomputes} | ${step.cacheHits} | ${step.verifiedCacheHits} | ${step.dependencyReads} |`,
      );
    }
    lines.push("");
    lines.push("## Resource-loaded page evidence");
    lines.push("");
    const page = e.resourceLoadedPage;
    lines.push(`- URL: ${page.url}`);
    lines.push(`- Root HTML bytes: ${page.rootBytes}`);
    lines.push(
      `- External resources: ${page.discoveredResources} discovered, ${page.loadedResources} loaded, ${page.missingResources} missing`,
    );
    lines.push(`- Loaded resource bytes: ${page.loadedBytes}`);
    lines.push(`- Stylesheets: ${page.stylesheetCount}`);
    lines.push(`- Decoded images: ${page.decodedImageCount}`);
    lines.push(`- Display commands: ${page.displayCommands}`);
    lines.push(`- Paint ops: ${page.paintOps.join(", ") || "—"}`);
    lines.push(`- PNG output: ${page.width}x${page.height}, ${page.pngBytes} bytes`);
    lines.push(`- Missing-image-only URL: ${page.missingImage.url}`);
    lines.push(
      `- Missing-image-only resources: ${page.missingImage.discoveredResources} discovered, ${page.missingImage.loadedResources} loaded, ${page.missingImage.missingResources} missing`,
    );
    lines.push(`- Missing-image-only decoded images: ${page.missingImage.decodedImageCount}`);
    lines.push(`- Missing-image-only painted image: ${page.missingImage.paintedImage ? "yes" : "no"}`);
    lines.push(`- Missing-image-only paint ops: ${page.missingImage.paintOps.join(", ") || "—"}`);
    lines.push(`- Invalid-image-only URL: ${page.invalidImage.url}`);
    lines.push(
      `- Invalid-image-only resources: ${page.invalidImage.discoveredResources} discovered, ${page.invalidImage.loadedResources} loaded, ${page.invalidImage.missingResources} missing`,
    );
    lines.push(`- Invalid-image-only loaded bytes: ${page.invalidImage.loadedBytes}`);
    lines.push(`- Invalid-image-only decoded images: ${page.invalidImage.decodedImageCount}`);
    lines.push(`- Invalid-image-only painted image: ${page.invalidImage.paintedImage ? "yes" : "no"}`);
    lines.push(`- Invalid-image-only paint ops: ${page.invalidImage.paintOps.join(", ") || "—"}`);
    lines.push(`- Duplicate-resource URL: ${page.duplicateResource.url}`);
    lines.push(`- Duplicate-resource fetch calls: ${page.duplicateResource.fetchCalls}`);
    lines.push(`- Duplicate-resource shared fetches: ${page.duplicateResource.sharedResourceFetches}`);
    lines.push(
      `- Duplicate-resource resources: ${page.duplicateResource.discoveredResources} discovered, ${page.duplicateResource.loadedResources} loaded, ${page.duplicateResource.missingResources} missing`,
    );
    lines.push(`- Duplicate-resource loaded bytes: ${page.duplicateResource.loadedBytes}`);
    lines.push(`- Duplicate-resource decoded images: ${page.duplicateResource.decodedImageCount}`);
    lines.push(`- Duplicate-resource painted images: ${page.duplicateResource.paintedImageCount}`);
    lines.push(`- Duplicate-resource paint ops: ${page.duplicateResource.paintOps.join(", ") || "—"}`);
    lines.push(`- Duplicate-stylesheet URL: ${page.duplicateStylesheet.url}`);
    lines.push(`- Duplicate-stylesheet fetch calls: ${page.duplicateStylesheet.fetchCalls}`);
    lines.push(`- Duplicate-stylesheet shared fetches: ${page.duplicateStylesheet.sharedStylesheetFetches}`);
    lines.push(
      `- Duplicate-stylesheet external resources: ${page.duplicateStylesheet.discoveredResources} discovered, ${page.duplicateStylesheet.loadedResources} loaded, ${page.duplicateStylesheet.missingResources} missing`,
    );
    lines.push(`- Duplicate-stylesheet loaded bytes: ${page.duplicateStylesheet.loadedBytes}`);
    lines.push(`- Duplicate-stylesheet stylesheets: ${page.duplicateStylesheet.stylesheetCount}`);
    lines.push(`- Duplicate-stylesheet author stylesheets: ${page.duplicateStylesheet.authorStylesheetCount}`);
    lines.push(`- Duplicate-stylesheet author rules: ${page.duplicateStylesheet.authorRuleCount}`);
    lines.push(`- Duplicate-stylesheet author declarations: ${page.duplicateStylesheet.authorDeclarationCount}`);
    lines.push(`- Duplicate-stylesheet decoded images: ${page.duplicateStylesheet.decodedImageCount}`);
    lines.push(`- Duplicate-stylesheet painted background: ${page.duplicateStylesheet.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Duplicate-stylesheet duplicate link won source order: ${page.duplicateStylesheet.duplicateLinkWonSourceOrder ? "yes" : "no"}`);
    lines.push(`- Duplicate-stylesheet paint ops: ${page.duplicateStylesheet.paintOps.join(", ") || "—"}`);
    lines.push(`- Data-url-only URL: ${page.dataUrlNoNetwork.url}`);
    lines.push(`- Data-url-only fetch calls: ${page.dataUrlNoNetwork.fetchCalls}`);
    lines.push(
      `- Data-url-only external resources: ${page.dataUrlNoNetwork.discoveredResources} discovered, ${page.dataUrlNoNetwork.loadedResources} loaded, ${page.dataUrlNoNetwork.missingResources} missing`,
    );
    lines.push(`- Data-url-only loaded bytes: ${page.dataUrlNoNetwork.loadedBytes}`);
    lines.push(`- Data-url-only stylesheets: ${page.dataUrlNoNetwork.stylesheetCount}`);
    lines.push(`- Data-url-only decoded images: ${page.dataUrlNoNetwork.decodedImageCount}`);
    lines.push(`- Data-url-only painted images: ${page.dataUrlNoNetwork.paintedImageCount}`);
    lines.push(`- Data-url-only painted background: ${page.dataUrlNoNetwork.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Data-url-only paint ops: ${page.dataUrlNoNetwork.paintOps.join(", ") || "—"}`);
    lines.push(`- Data-url-charset percent URL: ${page.dataUrlStylesheetCharset.percentUtf8.url}`);
    lines.push(`- Data-url-charset percent metadata: ${page.dataUrlStylesheetCharset.percentUtf8.metadata}`);
    lines.push(`- Data-url-charset percent fetch calls: ${page.dataUrlStylesheetCharset.percentUtf8.fetchCalls}`);
    lines.push(`- Data-url-charset percent data URL fetch calls: ${page.dataUrlStylesheetCharset.percentUtf8.dataUrlFetchCalls}`);
    lines.push(
      `- Data-url-charset percent external resources: ${page.dataUrlStylesheetCharset.percentUtf8.discoveredResources} discovered, ${page.dataUrlStylesheetCharset.percentUtf8.loadedResources} loaded, ${page.dataUrlStylesheetCharset.percentUtf8.missingResources} missing`,
    );
    lines.push(`- Data-url-charset percent stylesheets: ${page.dataUrlStylesheetCharset.percentUtf8.stylesheetCount}`);
    lines.push(`- Data-url-charset percent author stylesheets: ${page.dataUrlStylesheetCharset.percentUtf8.authorStylesheetCount}`);
    lines.push(`- Data-url-charset percent author declarations: ${page.dataUrlStylesheetCharset.percentUtf8.authorDeclarationCount}`);
    lines.push(`- Data-url-charset percent painted background: ${page.dataUrlStylesheetCharset.percentUtf8.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Data-url-charset base64 URL: ${page.dataUrlStylesheetCharset.base64Utf8.url}`);
    lines.push(`- Data-url-charset base64 metadata: ${page.dataUrlStylesheetCharset.base64Utf8.metadata}`);
    lines.push(`- Data-url-charset base64 fetch calls: ${page.dataUrlStylesheetCharset.base64Utf8.fetchCalls}`);
    lines.push(`- Data-url-charset base64 data URL fetch calls: ${page.dataUrlStylesheetCharset.base64Utf8.dataUrlFetchCalls}`);
    lines.push(
      `- Data-url-charset base64 external resources: ${page.dataUrlStylesheetCharset.base64Utf8.discoveredResources} discovered, ${page.dataUrlStylesheetCharset.base64Utf8.loadedResources} loaded, ${page.dataUrlStylesheetCharset.base64Utf8.missingResources} missing`,
    );
    lines.push(`- Data-url-charset base64 stylesheets: ${page.dataUrlStylesheetCharset.base64Utf8.stylesheetCount}`);
    lines.push(`- Data-url-charset base64 author stylesheets: ${page.dataUrlStylesheetCharset.base64Utf8.authorStylesheetCount}`);
    lines.push(`- Data-url-charset base64 author declarations: ${page.dataUrlStylesheetCharset.base64Utf8.authorDeclarationCount}`);
    lines.push(`- Data-url-charset base64 painted background: ${page.dataUrlStylesheetCharset.base64Utf8.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Data-url-charset unsupported URL: ${page.dataUrlStylesheetCharset.unsupportedCharset.url}`);
    lines.push(`- Data-url-charset unsupported metadata: ${page.dataUrlStylesheetCharset.unsupportedCharset.metadata}`);
    lines.push(`- Data-url-charset unsupported fetch calls: ${page.dataUrlStylesheetCharset.unsupportedCharset.fetchCalls}`);
    lines.push(`- Data-url-charset unsupported data URL fetch calls: ${page.dataUrlStylesheetCharset.unsupportedCharset.dataUrlFetchCalls}`);
    lines.push(
      `- Data-url-charset unsupported external resources: ${page.dataUrlStylesheetCharset.unsupportedCharset.discoveredResources} discovered, ${page.dataUrlStylesheetCharset.unsupportedCharset.loadedResources} loaded, ${page.dataUrlStylesheetCharset.unsupportedCharset.missingResources} missing`,
    );
    lines.push(`- Data-url-charset unsupported stylesheets: ${page.dataUrlStylesheetCharset.unsupportedCharset.stylesheetCount}`);
    lines.push(`- Data-url-charset unsupported author stylesheets: ${page.dataUrlStylesheetCharset.unsupportedCharset.authorStylesheetCount}`);
    lines.push(`- Data-url-charset unsupported author declarations: ${page.dataUrlStylesheetCharset.unsupportedCharset.authorDeclarationCount}`);
    lines.push(`- Data-url-charset unsupported painted background: ${page.dataUrlStylesheetCharset.unsupportedCharset.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Data-url-stylesheet external-after URL: ${page.dataUrlStylesheetSourceOrder.externalAfterDataUrl.url}`);
    lines.push(`- Data-url-stylesheet external-after external URL: ${page.dataUrlStylesheetSourceOrder.externalAfterDataUrl.externalStylesheetUrl}`);
    lines.push(`- Data-url-stylesheet external-after fetch calls: ${page.dataUrlStylesheetSourceOrder.externalAfterDataUrl.fetchCalls}`);
    lines.push(`- Data-url-stylesheet external-after data URL fetch calls: ${page.dataUrlStylesheetSourceOrder.externalAfterDataUrl.dataUrlFetchCalls}`);
    lines.push(`- Data-url-stylesheet external-after external fetches: ${page.dataUrlStylesheetSourceOrder.externalAfterDataUrl.externalStylesheetFetches}`);
    lines.push(
      `- Data-url-stylesheet external-after external resources: ${page.dataUrlStylesheetSourceOrder.externalAfterDataUrl.discoveredResources} discovered, ${page.dataUrlStylesheetSourceOrder.externalAfterDataUrl.loadedResources} loaded, ${page.dataUrlStylesheetSourceOrder.externalAfterDataUrl.missingResources} missing`,
    );
    lines.push(`- Data-url-stylesheet external-after loaded bytes: ${page.dataUrlStylesheetSourceOrder.externalAfterDataUrl.loadedBytes}`);
    lines.push(`- Data-url-stylesheet external-after stylesheets: ${page.dataUrlStylesheetSourceOrder.externalAfterDataUrl.stylesheetCount}`);
    lines.push(`- Data-url-stylesheet external-after author stylesheets: ${page.dataUrlStylesheetSourceOrder.externalAfterDataUrl.authorStylesheetCount}`);
    lines.push(`- Data-url-stylesheet external-after author rules: ${page.dataUrlStylesheetSourceOrder.externalAfterDataUrl.authorRuleCount}`);
    lines.push(`- Data-url-stylesheet external-after author declarations: ${page.dataUrlStylesheetSourceOrder.externalAfterDataUrl.authorDeclarationCount}`);
    lines.push(`- Data-url-stylesheet external-after decoded images: ${page.dataUrlStylesheetSourceOrder.externalAfterDataUrl.decodedImageCount}`);
    lines.push(`- Data-url-stylesheet external-after painted background: ${page.dataUrlStylesheetSourceOrder.externalAfterDataUrl.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Data-url-stylesheet external-after source-order winner blue: ${page.dataUrlStylesheetSourceOrder.externalAfterDataUrl.sourceOrderWinnerBlue ? "yes" : "no"}`);
    lines.push(`- Data-url-stylesheet external-after paint ops: ${page.dataUrlStylesheetSourceOrder.externalAfterDataUrl.paintOps.join(", ") || "—"}`);
    lines.push(`- Data-url-stylesheet data-after URL: ${page.dataUrlStylesheetSourceOrder.dataUrlAfterExternal.url}`);
    lines.push(`- Data-url-stylesheet data-after external URL: ${page.dataUrlStylesheetSourceOrder.dataUrlAfterExternal.externalStylesheetUrl}`);
    lines.push(`- Data-url-stylesheet data-after fetch calls: ${page.dataUrlStylesheetSourceOrder.dataUrlAfterExternal.fetchCalls}`);
    lines.push(`- Data-url-stylesheet data-after data URL fetch calls: ${page.dataUrlStylesheetSourceOrder.dataUrlAfterExternal.dataUrlFetchCalls}`);
    lines.push(`- Data-url-stylesheet data-after external fetches: ${page.dataUrlStylesheetSourceOrder.dataUrlAfterExternal.externalStylesheetFetches}`);
    lines.push(
      `- Data-url-stylesheet data-after external resources: ${page.dataUrlStylesheetSourceOrder.dataUrlAfterExternal.discoveredResources} discovered, ${page.dataUrlStylesheetSourceOrder.dataUrlAfterExternal.loadedResources} loaded, ${page.dataUrlStylesheetSourceOrder.dataUrlAfterExternal.missingResources} missing`,
    );
    lines.push(`- Data-url-stylesheet data-after loaded bytes: ${page.dataUrlStylesheetSourceOrder.dataUrlAfterExternal.loadedBytes}`);
    lines.push(`- Data-url-stylesheet data-after stylesheets: ${page.dataUrlStylesheetSourceOrder.dataUrlAfterExternal.stylesheetCount}`);
    lines.push(`- Data-url-stylesheet data-after author stylesheets: ${page.dataUrlStylesheetSourceOrder.dataUrlAfterExternal.authorStylesheetCount}`);
    lines.push(`- Data-url-stylesheet data-after author rules: ${page.dataUrlStylesheetSourceOrder.dataUrlAfterExternal.authorRuleCount}`);
    lines.push(`- Data-url-stylesheet data-after author declarations: ${page.dataUrlStylesheetSourceOrder.dataUrlAfterExternal.authorDeclarationCount}`);
    lines.push(`- Data-url-stylesheet data-after decoded images: ${page.dataUrlStylesheetSourceOrder.dataUrlAfterExternal.decodedImageCount}`);
    lines.push(`- Data-url-stylesheet data-after painted background: ${page.dataUrlStylesheetSourceOrder.dataUrlAfterExternal.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Data-url-stylesheet data-after source-order winner blue: ${page.dataUrlStylesheetSourceOrder.dataUrlAfterExternal.sourceOrderWinnerBlue ? "yes" : "no"}`);
    lines.push(`- Data-url-stylesheet data-after paint ops: ${page.dataUrlStylesheetSourceOrder.dataUrlAfterExternal.paintOps.join(", ") || "—"}`);
    lines.push(`- External-inline-stylesheet inline-after URL: ${page.externalInlineStylesheetSourceOrder.inlineAfterExternal.url}`);
    lines.push(`- External-inline-stylesheet inline-after external URL: ${page.externalInlineStylesheetSourceOrder.inlineAfterExternal.externalStylesheetUrl}`);
    lines.push(`- External-inline-stylesheet inline-after fetch calls: ${page.externalInlineStylesheetSourceOrder.inlineAfterExternal.fetchCalls}`);
    lines.push(`- External-inline-stylesheet inline-after external fetches: ${page.externalInlineStylesheetSourceOrder.inlineAfterExternal.externalStylesheetFetches}`);
    lines.push(
      `- External-inline-stylesheet inline-after external resources: ${page.externalInlineStylesheetSourceOrder.inlineAfterExternal.discoveredResources} discovered, ${page.externalInlineStylesheetSourceOrder.inlineAfterExternal.loadedResources} loaded, ${page.externalInlineStylesheetSourceOrder.inlineAfterExternal.missingResources} missing`,
    );
    lines.push(`- External-inline-stylesheet inline-after loaded bytes: ${page.externalInlineStylesheetSourceOrder.inlineAfterExternal.loadedBytes}`);
    lines.push(`- External-inline-stylesheet inline-after stylesheets: ${page.externalInlineStylesheetSourceOrder.inlineAfterExternal.stylesheetCount}`);
    lines.push(`- External-inline-stylesheet inline-after author stylesheets: ${page.externalInlineStylesheetSourceOrder.inlineAfterExternal.authorStylesheetCount}`);
    lines.push(`- External-inline-stylesheet inline-after author rules: ${page.externalInlineStylesheetSourceOrder.inlineAfterExternal.authorRuleCount}`);
    lines.push(`- External-inline-stylesheet inline-after author declarations: ${page.externalInlineStylesheetSourceOrder.inlineAfterExternal.authorDeclarationCount}`);
    lines.push(`- External-inline-stylesheet inline-after decoded images: ${page.externalInlineStylesheetSourceOrder.inlineAfterExternal.decodedImageCount}`);
    lines.push(`- External-inline-stylesheet inline-after painted background: ${page.externalInlineStylesheetSourceOrder.inlineAfterExternal.paintedBackground ? "yes" : "no"}`);
    lines.push(`- External-inline-stylesheet inline-after source-order winner blue: ${page.externalInlineStylesheetSourceOrder.inlineAfterExternal.sourceOrderWinnerBlue ? "yes" : "no"}`);
    lines.push(`- External-inline-stylesheet inline-after paint ops: ${page.externalInlineStylesheetSourceOrder.inlineAfterExternal.paintOps.join(", ") || "—"}`);
    lines.push(`- External-inline-stylesheet external-after URL: ${page.externalInlineStylesheetSourceOrder.externalAfterInline.url}`);
    lines.push(`- External-inline-stylesheet external-after external URL: ${page.externalInlineStylesheetSourceOrder.externalAfterInline.externalStylesheetUrl}`);
    lines.push(`- External-inline-stylesheet external-after fetch calls: ${page.externalInlineStylesheetSourceOrder.externalAfterInline.fetchCalls}`);
    lines.push(`- External-inline-stylesheet external-after external fetches: ${page.externalInlineStylesheetSourceOrder.externalAfterInline.externalStylesheetFetches}`);
    lines.push(
      `- External-inline-stylesheet external-after external resources: ${page.externalInlineStylesheetSourceOrder.externalAfterInline.discoveredResources} discovered, ${page.externalInlineStylesheetSourceOrder.externalAfterInline.loadedResources} loaded, ${page.externalInlineStylesheetSourceOrder.externalAfterInline.missingResources} missing`,
    );
    lines.push(`- External-inline-stylesheet external-after loaded bytes: ${page.externalInlineStylesheetSourceOrder.externalAfterInline.loadedBytes}`);
    lines.push(`- External-inline-stylesheet external-after stylesheets: ${page.externalInlineStylesheetSourceOrder.externalAfterInline.stylesheetCount}`);
    lines.push(`- External-inline-stylesheet external-after author stylesheets: ${page.externalInlineStylesheetSourceOrder.externalAfterInline.authorStylesheetCount}`);
    lines.push(`- External-inline-stylesheet external-after author rules: ${page.externalInlineStylesheetSourceOrder.externalAfterInline.authorRuleCount}`);
    lines.push(`- External-inline-stylesheet external-after author declarations: ${page.externalInlineStylesheetSourceOrder.externalAfterInline.authorDeclarationCount}`);
    lines.push(`- External-inline-stylesheet external-after decoded images: ${page.externalInlineStylesheetSourceOrder.externalAfterInline.decodedImageCount}`);
    lines.push(`- External-inline-stylesheet external-after painted background: ${page.externalInlineStylesheetSourceOrder.externalAfterInline.paintedBackground ? "yes" : "no"}`);
    lines.push(`- External-inline-stylesheet external-after source-order winner blue: ${page.externalInlineStylesheetSourceOrder.externalAfterInline.sourceOrderWinnerBlue ? "yes" : "no"}`);
    lines.push(`- External-inline-stylesheet external-after paint ops: ${page.externalInlineStylesheetSourceOrder.externalAfterInline.paintOps.join(", ") || "—"}`);
    lines.push(`- Invalid-data-image URL: ${page.invalidDataImage.url}`);
    lines.push(`- Invalid-data-image fetch calls: ${page.invalidDataImage.fetchCalls}`);
    lines.push(
      `- Invalid-data-image external resources: ${page.invalidDataImage.discoveredResources} discovered, ${page.invalidDataImage.loadedResources} loaded, ${page.invalidDataImage.missingResources} missing`,
    );
    lines.push(`- Invalid-data-image loaded bytes: ${page.invalidDataImage.loadedBytes}`);
    lines.push(`- Invalid-data-image decoded images: ${page.invalidDataImage.decodedImageCount}`);
    lines.push(`- Invalid-data-image painted images: ${page.invalidDataImage.paintedImageCount}`);
    lines.push(`- Invalid-data-image painted background: ${page.invalidDataImage.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Invalid-data-image paint ops: ${page.invalidDataImage.paintOps.join(", ") || "—"}`);
    lines.push(`- Invalid-data-stylesheet URL: ${page.invalidDataStylesheet.url}`);
    lines.push(`- Invalid-data-stylesheet fetch calls: ${page.invalidDataStylesheet.fetchCalls}`);
    lines.push(
      `- Invalid-data-stylesheet external resources: ${page.invalidDataStylesheet.discoveredResources} discovered, ${page.invalidDataStylesheet.loadedResources} loaded, ${page.invalidDataStylesheet.missingResources} missing`,
    );
    lines.push(`- Invalid-data-stylesheet loaded bytes: ${page.invalidDataStylesheet.loadedBytes}`);
    lines.push(`- Invalid-data-stylesheet stylesheets: ${page.invalidDataStylesheet.stylesheetCount}`);
    lines.push(`- Invalid-data-stylesheet author stylesheets: ${page.invalidDataStylesheet.authorStylesheetCount}`);
    lines.push(`- Invalid-data-stylesheet author rules: ${page.invalidDataStylesheet.authorRuleCount}`);
    lines.push(`- Invalid-data-stylesheet author declarations: ${page.invalidDataStylesheet.authorDeclarationCount}`);
    lines.push(`- Invalid-data-stylesheet decoded images: ${page.invalidDataStylesheet.decodedImageCount}`);
    lines.push(`- Invalid-data-stylesheet painted background: ${page.invalidDataStylesheet.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Invalid-data-stylesheet paint ops: ${page.invalidDataStylesheet.paintOps.join(", ") || "—"}`);
    lines.push(`- Non-css-data-stylesheet URL: ${page.nonCssDataStylesheet.url}`);
    lines.push(`- Non-css-data-stylesheet fetch calls: ${page.nonCssDataStylesheet.fetchCalls}`);
    lines.push(
      `- Non-css-data-stylesheet external resources: ${page.nonCssDataStylesheet.discoveredResources} discovered, ${page.nonCssDataStylesheet.loadedResources} loaded, ${page.nonCssDataStylesheet.missingResources} missing`,
    );
    lines.push(`- Non-css-data-stylesheet loaded bytes: ${page.nonCssDataStylesheet.loadedBytes}`);
    lines.push(`- Non-css-data-stylesheet stylesheets: ${page.nonCssDataStylesheet.stylesheetCount}`);
    lines.push(`- Non-css-data-stylesheet author stylesheets: ${page.nonCssDataStylesheet.authorStylesheetCount}`);
    lines.push(`- Non-css-data-stylesheet author rules: ${page.nonCssDataStylesheet.authorRuleCount}`);
    lines.push(`- Non-css-data-stylesheet author declarations: ${page.nonCssDataStylesheet.authorDeclarationCount}`);
    lines.push(`- Non-css-data-stylesheet decoded images: ${page.nonCssDataStylesheet.decodedImageCount}`);
    lines.push(`- Non-css-data-stylesheet painted background: ${page.nonCssDataStylesheet.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Non-css-data-stylesheet paint ops: ${page.nonCssDataStylesheet.paintOps.join(", ") || "—"}`);
    lines.push(`- No-href-stylesheet URL: ${page.noHrefStylesheet.url}`);
    lines.push(`- No-href-stylesheet fetch calls: ${page.noHrefStylesheet.fetchCalls}`);
    lines.push(
      `- No-href-stylesheet external resources: ${page.noHrefStylesheet.discoveredResources} discovered, ${page.noHrefStylesheet.loadedResources} loaded, ${page.noHrefStylesheet.missingResources} missing`,
    );
    lines.push(`- No-href-stylesheet loaded bytes: ${page.noHrefStylesheet.loadedBytes}`);
    lines.push(`- No-href-stylesheet stylesheets: ${page.noHrefStylesheet.stylesheetCount}`);
    lines.push(`- No-href-stylesheet author stylesheets: ${page.noHrefStylesheet.authorStylesheetCount}`);
    lines.push(`- No-href-stylesheet author rules: ${page.noHrefStylesheet.authorRuleCount}`);
    lines.push(`- No-href-stylesheet author declarations: ${page.noHrefStylesheet.authorDeclarationCount}`);
    lines.push(`- No-href-stylesheet decoded images: ${page.noHrefStylesheet.decodedImageCount}`);
    lines.push(`- No-href-stylesheet painted background: ${page.noHrefStylesheet.paintedBackground ? "yes" : "no"}`);
    lines.push(`- No-href-stylesheet paint ops: ${page.noHrefStylesheet.paintOps.join(", ") || "—"}`);
    lines.push(`- Empty-href-stylesheet URL: ${page.emptyHrefStylesheet.url}`);
    lines.push(`- Empty-href-stylesheet fetch calls: ${page.emptyHrefStylesheet.fetchCalls}`);
    lines.push(
      `- Empty-href-stylesheet external resources: ${page.emptyHrefStylesheet.discoveredResources} discovered, ${page.emptyHrefStylesheet.loadedResources} loaded, ${page.emptyHrefStylesheet.missingResources} missing`,
    );
    lines.push(`- Empty-href-stylesheet loaded bytes: ${page.emptyHrefStylesheet.loadedBytes}`);
    lines.push(`- Empty-href-stylesheet stylesheets: ${page.emptyHrefStylesheet.stylesheetCount}`);
    lines.push(`- Empty-href-stylesheet author stylesheets: ${page.emptyHrefStylesheet.authorStylesheetCount}`);
    lines.push(`- Empty-href-stylesheet author rules: ${page.emptyHrefStylesheet.authorRuleCount}`);
    lines.push(`- Empty-href-stylesheet author declarations: ${page.emptyHrefStylesheet.authorDeclarationCount}`);
    lines.push(`- Empty-href-stylesheet decoded images: ${page.emptyHrefStylesheet.decodedImageCount}`);
    lines.push(`- Empty-href-stylesheet painted background: ${page.emptyHrefStylesheet.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Empty-href-stylesheet paint ops: ${page.emptyHrefStylesheet.paintOps.join(", ") || "—"}`);
    lines.push(`- Fragment-href-stylesheet URL: ${page.fragmentHrefStylesheet.url}`);
    lines.push(`- Fragment-href-stylesheet fetch calls: ${page.fragmentHrefStylesheet.fetchCalls}`);
    lines.push(
      `- Fragment-href-stylesheet external resources: ${page.fragmentHrefStylesheet.discoveredResources} discovered, ${page.fragmentHrefStylesheet.loadedResources} loaded, ${page.fragmentHrefStylesheet.missingResources} missing`,
    );
    lines.push(`- Fragment-href-stylesheet loaded bytes: ${page.fragmentHrefStylesheet.loadedBytes}`);
    lines.push(`- Fragment-href-stylesheet stylesheets: ${page.fragmentHrefStylesheet.stylesheetCount}`);
    lines.push(`- Fragment-href-stylesheet author stylesheets: ${page.fragmentHrefStylesheet.authorStylesheetCount}`);
    lines.push(`- Fragment-href-stylesheet author rules: ${page.fragmentHrefStylesheet.authorRuleCount}`);
    lines.push(`- Fragment-href-stylesheet author declarations: ${page.fragmentHrefStylesheet.authorDeclarationCount}`);
    lines.push(`- Fragment-href-stylesheet decoded images: ${page.fragmentHrefStylesheet.decodedImageCount}`);
    lines.push(`- Fragment-href-stylesheet painted background: ${page.fragmentHrefStylesheet.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Fragment-href-stylesheet paint ops: ${page.fragmentHrefStylesheet.paintOps.join(", ") || "—"}`);
    lines.push(`- Query-href-stylesheet URL: ${page.queryHrefStylesheet.url}`);
    lines.push(`- Query-href-stylesheet fetch calls: ${page.queryHrefStylesheet.fetchCalls}`);
    lines.push(
      `- Query-href-stylesheet external resources: ${page.queryHrefStylesheet.discoveredResources} discovered, ${page.queryHrefStylesheet.loadedResources} loaded, ${page.queryHrefStylesheet.missingResources} missing`,
    );
    lines.push(`- Query-href-stylesheet loaded bytes: ${page.queryHrefStylesheet.loadedBytes}`);
    lines.push(`- Query-href-stylesheet stylesheets: ${page.queryHrefStylesheet.stylesheetCount}`);
    lines.push(`- Query-href-stylesheet author stylesheets: ${page.queryHrefStylesheet.authorStylesheetCount}`);
    lines.push(`- Query-href-stylesheet author rules: ${page.queryHrefStylesheet.authorRuleCount}`);
    lines.push(`- Query-href-stylesheet author declarations: ${page.queryHrefStylesheet.authorDeclarationCount}`);
    lines.push(`- Query-href-stylesheet decoded images: ${page.queryHrefStylesheet.decodedImageCount}`);
    lines.push(`- Query-href-stylesheet painted background: ${page.queryHrefStylesheet.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Query-href-stylesheet paint ops: ${page.queryHrefStylesheet.paintOps.join(", ") || "—"}`);
    lines.push(`- Protocol-relative-stylesheet URL: ${page.protocolRelativeStylesheet.url}`);
    lines.push(`- Protocol-relative-stylesheet fetch calls: ${page.protocolRelativeStylesheet.fetchCalls}`);
    lines.push(
      `- Protocol-relative-stylesheet external resources: ${page.protocolRelativeStylesheet.discoveredResources} discovered, ${page.protocolRelativeStylesheet.loadedResources} loaded, ${page.protocolRelativeStylesheet.missingResources} missing`,
    );
    lines.push(`- Protocol-relative-stylesheet loaded bytes: ${page.protocolRelativeStylesheet.loadedBytes}`);
    lines.push(`- Protocol-relative-stylesheet stylesheets: ${page.protocolRelativeStylesheet.stylesheetCount}`);
    lines.push(`- Protocol-relative-stylesheet author stylesheets: ${page.protocolRelativeStylesheet.authorStylesheetCount}`);
    lines.push(`- Protocol-relative-stylesheet author rules: ${page.protocolRelativeStylesheet.authorRuleCount}`);
    lines.push(`- Protocol-relative-stylesheet author declarations: ${page.protocolRelativeStylesheet.authorDeclarationCount}`);
    lines.push(`- Protocol-relative-stylesheet decoded images: ${page.protocolRelativeStylesheet.decodedImageCount}`);
    lines.push(`- Protocol-relative-stylesheet painted background: ${page.protocolRelativeStylesheet.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Protocol-relative-stylesheet paint ops: ${page.protocolRelativeStylesheet.paintOps.join(", ") || "—"}`);
    lines.push(`- Whitespace-rel-stylesheet URL: ${page.whitespaceRelStylesheet.url}`);
    lines.push(`- Whitespace-rel-stylesheet fetch calls: ${page.whitespaceRelStylesheet.fetchCalls}`);
    lines.push(
      `- Whitespace-rel-stylesheet external resources: ${page.whitespaceRelStylesheet.discoveredResources} discovered, ${page.whitespaceRelStylesheet.loadedResources} loaded, ${page.whitespaceRelStylesheet.missingResources} missing`,
    );
    lines.push(`- Whitespace-rel-stylesheet loaded bytes: ${page.whitespaceRelStylesheet.loadedBytes}`);
    lines.push(`- Whitespace-rel-stylesheet stylesheets: ${page.whitespaceRelStylesheet.stylesheetCount}`);
    lines.push(`- Whitespace-rel-stylesheet author stylesheets: ${page.whitespaceRelStylesheet.authorStylesheetCount}`);
    lines.push(`- Whitespace-rel-stylesheet author rules: ${page.whitespaceRelStylesheet.authorRuleCount}`);
    lines.push(`- Whitespace-rel-stylesheet author declarations: ${page.whitespaceRelStylesheet.authorDeclarationCount}`);
    lines.push(`- Whitespace-rel-stylesheet decoded images: ${page.whitespaceRelStylesheet.decodedImageCount}`);
    lines.push(`- Whitespace-rel-stylesheet painted background: ${page.whitespaceRelStylesheet.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Whitespace-rel-stylesheet source-order winner blue: ${page.whitespaceRelStylesheet.sourceOrderWinnerBlue ? "yes" : "no"}`);
    lines.push(`- Whitespace-rel alternate fetch calls: ${page.whitespaceRelStylesheet.alternateFetchCalls}`);
    lines.push(
      `- Whitespace-rel alternate external resources: ${page.whitespaceRelStylesheet.alternateDiscoveredResources} discovered, ${page.whitespaceRelStylesheet.alternateLoadedResources} loaded`,
    );
    lines.push(`- Whitespace-rel alternate author stylesheets: ${page.whitespaceRelStylesheet.alternateAuthorStylesheetCount}`);
    lines.push(`- Whitespace-rel alternate painted background: ${page.whitespaceRelStylesheet.alternatePaintedBackground ? "yes" : "no"}`);
    lines.push(`- Whitespace-rel-stylesheet paint ops: ${page.whitespaceRelStylesheet.paintOps.join(", ") || "—"}`);
    lines.push(`- Duplicate-rel-stylesheet URL: ${page.duplicateRelStylesheet.url}`);
    lines.push(`- Duplicate-rel-stylesheet fetch calls: ${page.duplicateRelStylesheet.fetchCalls}`);
    lines.push(
      `- Duplicate-rel-stylesheet external resources: ${page.duplicateRelStylesheet.discoveredResources} discovered, ${page.duplicateRelStylesheet.loadedResources} loaded, ${page.duplicateRelStylesheet.missingResources} missing`,
    );
    lines.push(`- Duplicate-rel-stylesheet loaded bytes: ${page.duplicateRelStylesheet.loadedBytes}`);
    lines.push(`- Duplicate-rel-stylesheet stylesheets: ${page.duplicateRelStylesheet.stylesheetCount}`);
    lines.push(`- Duplicate-rel-stylesheet author stylesheets: ${page.duplicateRelStylesheet.authorStylesheetCount}`);
    lines.push(`- Duplicate-rel-stylesheet author rules: ${page.duplicateRelStylesheet.authorRuleCount}`);
    lines.push(`- Duplicate-rel-stylesheet author declarations: ${page.duplicateRelStylesheet.authorDeclarationCount}`);
    lines.push(`- Duplicate-rel-stylesheet decoded images: ${page.duplicateRelStylesheet.decodedImageCount}`);
    lines.push(`- Duplicate-rel-stylesheet painted background: ${page.duplicateRelStylesheet.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Duplicate-rel-stylesheet source-order winner blue: ${page.duplicateRelStylesheet.sourceOrderWinnerBlue ? "yes" : "no"}`);
    lines.push(`- Duplicate-rel alternate fetch calls: ${page.duplicateRelStylesheet.alternateFetchCalls}`);
    lines.push(
      `- Duplicate-rel alternate external resources: ${page.duplicateRelStylesheet.alternateDiscoveredResources} discovered, ${page.duplicateRelStylesheet.alternateLoadedResources} loaded`,
    );
    lines.push(`- Duplicate-rel alternate author stylesheets: ${page.duplicateRelStylesheet.alternateAuthorStylesheetCount}`);
    lines.push(`- Duplicate-rel alternate painted background: ${page.duplicateRelStylesheet.alternatePaintedBackground ? "yes" : "no"}`);
    lines.push(`- Duplicate-rel-stylesheet paint ops: ${page.duplicateRelStylesheet.paintOps.join(", ") || "—"}`);
    lines.push(`- Whitespace-href-stylesheet URL: ${page.whitespaceHrefStylesheet.url}`);
    lines.push(`- Whitespace-href-stylesheet raw href: "${page.whitespaceHrefStylesheet.rawHref}"`);
    lines.push(`- Whitespace-href-stylesheet resolved href: ${page.whitespaceHrefStylesheet.resolvedHref}`);
    lines.push(`- Whitespace-href-stylesheet loaded resource URL: ${page.whitespaceHrefStylesheet.loadedResourceUrl}`);
    lines.push(`- Whitespace-href-stylesheet fetch calls: ${page.whitespaceHrefStylesheet.fetchCalls}`);
    lines.push(
      `- Whitespace-href-stylesheet external resources: ${page.whitespaceHrefStylesheet.discoveredResources} discovered, ${page.whitespaceHrefStylesheet.loadedResources} loaded, ${page.whitespaceHrefStylesheet.missingResources} missing`,
    );
    lines.push(`- Whitespace-href-stylesheet loaded bytes: ${page.whitespaceHrefStylesheet.loadedBytes}`);
    lines.push(`- Whitespace-href-stylesheet stylesheets: ${page.whitespaceHrefStylesheet.stylesheetCount}`);
    lines.push(`- Whitespace-href-stylesheet author stylesheets: ${page.whitespaceHrefStylesheet.authorStylesheetCount}`);
    lines.push(`- Whitespace-href-stylesheet author rules: ${page.whitespaceHrefStylesheet.authorRuleCount}`);
    lines.push(`- Whitespace-href-stylesheet author declarations: ${page.whitespaceHrefStylesheet.authorDeclarationCount}`);
    lines.push(`- Whitespace-href-stylesheet decoded images: ${page.whitespaceHrefStylesheet.decodedImageCount}`);
    lines.push(`- Whitespace-href-stylesheet painted background: ${page.whitespaceHrefStylesheet.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Whitespace-href-stylesheet source-order winner blue: ${page.whitespaceHrefStylesheet.sourceOrderWinnerBlue ? "yes" : "no"}`);
    lines.push(`- Whitespace-href-stylesheet paint ops: ${page.whitespaceHrefStylesheet.paintOps.join(", ") || "—"}`);
    lines.push(`- Control-character-href-stylesheet URL: ${page.controlCharacterHrefStylesheet.url}`);
    lines.push(`- Control-character-href-stylesheet raw href JSON: ${page.controlCharacterHrefStylesheet.rawHrefJson}`);
    lines.push(`- Control-character-href-stylesheet resolved href: ${page.controlCharacterHrefStylesheet.resolvedHref}`);
    lines.push(`- Control-character-href-stylesheet loaded resource URL: ${page.controlCharacterHrefStylesheet.loadedResourceUrl}`);
    lines.push(`- Control-character-href-stylesheet fetch calls: ${page.controlCharacterHrefStylesheet.fetchCalls}`);
    lines.push(
      `- Control-character-href-stylesheet external resources: ${page.controlCharacterHrefStylesheet.discoveredResources} discovered, ${page.controlCharacterHrefStylesheet.loadedResources} loaded, ${page.controlCharacterHrefStylesheet.missingResources} missing`,
    );
    lines.push(`- Control-character-href-stylesheet loaded bytes: ${page.controlCharacterHrefStylesheet.loadedBytes}`);
    lines.push(`- Control-character-href-stylesheet stylesheets: ${page.controlCharacterHrefStylesheet.stylesheetCount}`);
    lines.push(`- Control-character-href-stylesheet author stylesheets: ${page.controlCharacterHrefStylesheet.authorStylesheetCount}`);
    lines.push(`- Control-character-href-stylesheet author rules: ${page.controlCharacterHrefStylesheet.authorRuleCount}`);
    lines.push(`- Control-character-href-stylesheet author declarations: ${page.controlCharacterHrefStylesheet.authorDeclarationCount}`);
    lines.push(`- Control-character-href-stylesheet decoded images: ${page.controlCharacterHrefStylesheet.decodedImageCount}`);
    lines.push(`- Control-character-href-stylesheet painted background: ${page.controlCharacterHrefStylesheet.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Control-character-href-stylesheet source-order winner blue: ${page.controlCharacterHrefStylesheet.sourceOrderWinnerBlue ? "yes" : "no"}`);
    lines.push(`- Control-character-href-stylesheet paint ops: ${page.controlCharacterHrefStylesheet.paintOps.join(", ") || "—"}`);
    lines.push(`- Base-href-subresource URL: ${page.baseHrefSubresource.url}`);
    lines.push(`- Base-href-subresource raw base href: ${page.baseHrefSubresource.rawBaseHref}`);
    lines.push(`- Base-href-subresource resolved base href: ${page.baseHrefSubresource.resolvedBaseHref}`);
    lines.push(`- Base-href-subresource stylesheet href: ${page.baseHrefSubresource.stylesheetHref}`);
    lines.push(`- Base-href-subresource image src: ${page.baseHrefSubresource.imageSrc}`);
    lines.push(`- Base-href-subresource loaded stylesheet URL: ${page.baseHrefSubresource.loadedStylesheetUrl}`);
    lines.push(`- Base-href-subresource loaded image URL: ${page.baseHrefSubresource.loadedImageUrl}`);
    lines.push(`- Base-href-subresource fetch calls: ${page.baseHrefSubresource.fetchCalls}`);
    lines.push(`- Base-href-subresource stylesheet fetches: ${page.baseHrefSubresource.stylesheetFetches}`);
    lines.push(`- Base-href-subresource image fetches: ${page.baseHrefSubresource.imageFetches}`);
    lines.push(
      `- Base-href-subresource external resources: ${page.baseHrefSubresource.discoveredResources} discovered, ${page.baseHrefSubresource.loadedResources} loaded, ${page.baseHrefSubresource.missingResources} missing`,
    );
    lines.push(`- Base-href-subresource loaded bytes: ${page.baseHrefSubresource.loadedBytes}`);
    lines.push(`- Base-href-subresource stylesheets: ${page.baseHrefSubresource.stylesheetCount}`);
    lines.push(`- Base-href-subresource author stylesheets: ${page.baseHrefSubresource.authorStylesheetCount}`);
    lines.push(`- Base-href-subresource author rules: ${page.baseHrefSubresource.authorRuleCount}`);
    lines.push(`- Base-href-subresource author declarations: ${page.baseHrefSubresource.authorDeclarationCount}`);
    lines.push(`- Base-href-subresource decoded images: ${page.baseHrefSubresource.decodedImageCount}`);
    lines.push(`- Base-href-subresource painted background: ${page.baseHrefSubresource.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Base-href-subresource painted images: ${page.baseHrefSubresource.paintedImageCount}`);
    lines.push(`- Base-href-subresource painted background red: ${page.baseHrefSubresource.paintedBackgroundRed ? "yes" : "no"}`);
    lines.push(`- Base-href-subresource painted image blue: ${page.baseHrefSubresource.paintedImageBlue ? "yes" : "no"}`);
    lines.push(`- Base-href-subresource paint ops: ${page.baseHrefSubresource.paintOps.join(", ") || "—"}`);
    lines.push(`- Invalid-url-stylesheet URL: ${page.invalidUrlStylesheet.url}`);
    lines.push(`- Invalid-url-stylesheet fetch calls: ${page.invalidUrlStylesheet.fetchCalls}`);
    lines.push(
      `- Invalid-url-stylesheet external resources: ${page.invalidUrlStylesheet.discoveredResources} discovered, ${page.invalidUrlStylesheet.loadedResources} loaded, ${page.invalidUrlStylesheet.missingResources} missing`,
    );
    lines.push(`- Invalid-url-stylesheet loaded bytes: ${page.invalidUrlStylesheet.loadedBytes}`);
    lines.push(`- Invalid-url-stylesheet stylesheets: ${page.invalidUrlStylesheet.stylesheetCount}`);
    lines.push(`- Invalid-url-stylesheet author stylesheets: ${page.invalidUrlStylesheet.authorStylesheetCount}`);
    lines.push(`- Invalid-url-stylesheet author rules: ${page.invalidUrlStylesheet.authorRuleCount}`);
    lines.push(`- Invalid-url-stylesheet author declarations: ${page.invalidUrlStylesheet.authorDeclarationCount}`);
    lines.push(`- Invalid-url-stylesheet decoded images: ${page.invalidUrlStylesheet.decodedImageCount}`);
    lines.push(`- Invalid-url-stylesheet painted background: ${page.invalidUrlStylesheet.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Invalid-url-stylesheet source-order winner blue: ${page.invalidUrlStylesheet.sourceOrderWinnerBlue ? "yes" : "no"}`);
    lines.push(`- Invalid-url-only stylesheet fetch calls: ${page.invalidUrlStylesheet.invalidOnlyFetchCalls}`);
    lines.push(
      `- Invalid-url-only stylesheet external resources: ${page.invalidUrlStylesheet.invalidOnlyDiscoveredResources} discovered, ${page.invalidUrlStylesheet.invalidOnlyLoadedResources} loaded, ${page.invalidUrlStylesheet.invalidOnlyMissingResources} missing`,
    );
    lines.push(`- Invalid-url-only stylesheet author stylesheets: ${page.invalidUrlStylesheet.invalidOnlyAuthorStylesheetCount}`);
    lines.push(`- Invalid-url-only stylesheet painted background: ${page.invalidUrlStylesheet.invalidOnlyPaintedBackground ? "yes" : "no"}`);
    lines.push(`- Invalid-url-stylesheet paint ops: ${page.invalidUrlStylesheet.paintOps.join(", ") || "—"}`);
    lines.push(`- Alternate-stylesheet URL: ${page.alternateStylesheet.url}`);
    lines.push(`- Alternate-stylesheet fetch calls: ${page.alternateStylesheet.fetchCalls}`);
    lines.push(
      `- Alternate-stylesheet external resources: ${page.alternateStylesheet.discoveredResources} discovered, ${page.alternateStylesheet.loadedResources} loaded, ${page.alternateStylesheet.missingResources} missing`,
    );
    lines.push(`- Alternate-stylesheet loaded bytes: ${page.alternateStylesheet.loadedBytes}`);
    lines.push(`- Alternate-stylesheet stylesheets: ${page.alternateStylesheet.stylesheetCount}`);
    lines.push(`- Alternate-stylesheet author stylesheets: ${page.alternateStylesheet.authorStylesheetCount}`);
    lines.push(`- Alternate-stylesheet author rules: ${page.alternateStylesheet.authorRuleCount}`);
    lines.push(`- Alternate-stylesheet author declarations: ${page.alternateStylesheet.authorDeclarationCount}`);
    lines.push(`- Alternate-stylesheet decoded images: ${page.alternateStylesheet.decodedImageCount}`);
    lines.push(`- Alternate-stylesheet painted background: ${page.alternateStylesheet.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Alternate-stylesheet paint ops: ${page.alternateStylesheet.paintOps.join(", ") || "—"}`);
    lines.push(`- Disabled-stylesheet URL: ${page.disabledStylesheet.url}`);
    lines.push(`- Disabled-stylesheet fetch calls: ${page.disabledStylesheet.fetchCalls}`);
    lines.push(
      `- Disabled-stylesheet external resources: ${page.disabledStylesheet.discoveredResources} discovered, ${page.disabledStylesheet.loadedResources} loaded, ${page.disabledStylesheet.missingResources} missing`,
    );
    lines.push(`- Disabled-stylesheet loaded bytes: ${page.disabledStylesheet.loadedBytes}`);
    lines.push(`- Disabled-stylesheet stylesheets: ${page.disabledStylesheet.stylesheetCount}`);
    lines.push(`- Disabled-stylesheet author stylesheets: ${page.disabledStylesheet.authorStylesheetCount}`);
    lines.push(`- Disabled-stylesheet author rules: ${page.disabledStylesheet.authorRuleCount}`);
    lines.push(`- Disabled-stylesheet author declarations: ${page.disabledStylesheet.authorDeclarationCount}`);
    lines.push(`- Disabled-stylesheet decoded images: ${page.disabledStylesheet.decodedImageCount}`);
    lines.push(`- Disabled-stylesheet painted background: ${page.disabledStylesheet.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Disabled-stylesheet paint ops: ${page.disabledStylesheet.paintOps.join(", ") || "—"}`);
    lines.push(`- Print-media-stylesheet URL: ${page.printMediaStylesheet.url}`);
    lines.push(`- Print-media-stylesheet fetch calls: ${page.printMediaStylesheet.fetchCalls}`);
    lines.push(
      `- Print-media-stylesheet external resources: ${page.printMediaStylesheet.discoveredResources} discovered, ${page.printMediaStylesheet.loadedResources} loaded, ${page.printMediaStylesheet.missingResources} missing`,
    );
    lines.push(`- Print-media-stylesheet loaded bytes: ${page.printMediaStylesheet.loadedBytes}`);
    lines.push(`- Print-media-stylesheet stylesheets: ${page.printMediaStylesheet.stylesheetCount}`);
    lines.push(`- Print-media-stylesheet author stylesheets: ${page.printMediaStylesheet.authorStylesheetCount}`);
    lines.push(`- Print-media-stylesheet author rules: ${page.printMediaStylesheet.authorRuleCount}`);
    lines.push(`- Print-media-stylesheet author declarations: ${page.printMediaStylesheet.authorDeclarationCount}`);
    lines.push(`- Print-media-stylesheet decoded images: ${page.printMediaStylesheet.decodedImageCount}`);
    lines.push(`- Print-media-stylesheet painted background: ${page.printMediaStylesheet.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Print-media-stylesheet paint ops: ${page.printMediaStylesheet.paintOps.join(", ") || "—"}`);
    lines.push(`- Empty media stylesheet media length: ${page.stylesheetMediaList.empty.media.length}`);
    lines.push(`- Empty media stylesheet fetch calls: ${page.stylesheetMediaList.empty.fetchCalls}`);
    lines.push(
      `- Empty media stylesheet external resources: ${page.stylesheetMediaList.empty.discoveredResources} discovered, ${page.stylesheetMediaList.empty.loadedResources} loaded, ${page.stylesheetMediaList.empty.missingResources} missing`,
    );
    lines.push(`- Empty media stylesheet loaded bytes: ${page.stylesheetMediaList.empty.loadedBytes}`);
    lines.push(`- Empty media stylesheet author stylesheets: ${page.stylesheetMediaList.empty.authorStylesheetCount}`);
    lines.push(`- Empty media stylesheet author rules: ${page.stylesheetMediaList.empty.authorRuleCount}`);
    lines.push(`- Empty media stylesheet author declarations: ${page.stylesheetMediaList.empty.authorDeclarationCount}`);
    lines.push(`- Empty media stylesheet painted background: ${page.stylesheetMediaList.empty.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Whitespace-only media stylesheet media length: ${page.stylesheetMediaList.whitespaceOnly.media.length}`);
    lines.push(`- Whitespace-only media stylesheet fetch calls: ${page.stylesheetMediaList.whitespaceOnly.fetchCalls}`);
    lines.push(
      `- Whitespace-only media stylesheet external resources: ${page.stylesheetMediaList.whitespaceOnly.discoveredResources} discovered, ${page.stylesheetMediaList.whitespaceOnly.loadedResources} loaded, ${page.stylesheetMediaList.whitespaceOnly.missingResources} missing`,
    );
    lines.push(`- Whitespace-only media stylesheet loaded bytes: ${page.stylesheetMediaList.whitespaceOnly.loadedBytes}`);
    lines.push(`- Whitespace-only media stylesheet author stylesheets: ${page.stylesheetMediaList.whitespaceOnly.authorStylesheetCount}`);
    lines.push(`- Whitespace-only media stylesheet author rules: ${page.stylesheetMediaList.whitespaceOnly.authorRuleCount}`);
    lines.push(`- Whitespace-only media stylesheet author declarations: ${page.stylesheetMediaList.whitespaceOnly.authorDeclarationCount}`);
    lines.push(`- Whitespace-only media stylesheet painted background: ${page.stylesheetMediaList.whitespaceOnly.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Media-list stylesheet media: ${page.stylesheetMediaList.matchingList.media}`);
    lines.push(`- Media-list stylesheet fetch calls: ${page.stylesheetMediaList.matchingList.fetchCalls}`);
    lines.push(
      `- Media-list stylesheet external resources: ${page.stylesheetMediaList.matchingList.discoveredResources} discovered, ${page.stylesheetMediaList.matchingList.loadedResources} loaded, ${page.stylesheetMediaList.matchingList.missingResources} missing`,
    );
    lines.push(`- Media-list stylesheet loaded bytes: ${page.stylesheetMediaList.matchingList.loadedBytes}`);
    lines.push(`- Media-list stylesheet author stylesheets: ${page.stylesheetMediaList.matchingList.authorStylesheetCount}`);
    lines.push(`- Media-list stylesheet author rules: ${page.stylesheetMediaList.matchingList.authorRuleCount}`);
    lines.push(`- Media-list stylesheet author declarations: ${page.stylesheetMediaList.matchingList.authorDeclarationCount}`);
    lines.push(`- Media-list stylesheet painted background: ${page.stylesheetMediaList.matchingList.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Spaced media-list stylesheet media: ${JSON.stringify(page.stylesheetMediaList.spacedMatchingList.media)}`);
    lines.push(`- Spaced media-list stylesheet fetch calls: ${page.stylesheetMediaList.spacedMatchingList.fetchCalls}`);
    lines.push(
      `- Spaced media-list stylesheet external resources: ${page.stylesheetMediaList.spacedMatchingList.discoveredResources} discovered, ${page.stylesheetMediaList.spacedMatchingList.loadedResources} loaded, ${page.stylesheetMediaList.spacedMatchingList.missingResources} missing`,
    );
    lines.push(`- Spaced media-list stylesheet loaded bytes: ${page.stylesheetMediaList.spacedMatchingList.loadedBytes}`);
    lines.push(`- Spaced media-list stylesheet author stylesheets: ${page.stylesheetMediaList.spacedMatchingList.authorStylesheetCount}`);
    lines.push(`- Spaced media-list stylesheet author rules: ${page.stylesheetMediaList.spacedMatchingList.authorRuleCount}`);
    lines.push(`- Spaced media-list stylesheet author declarations: ${page.stylesheetMediaList.spacedMatchingList.authorDeclarationCount}`);
    lines.push(`- Spaced media-list stylesheet painted background: ${page.stylesheetMediaList.spacedMatchingList.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Empty item before screen media stylesheet media: ${page.stylesheetMediaList.emptyItemBeforeScreen.media}`);
    lines.push(`- Empty item before screen media stylesheet fetch calls: ${page.stylesheetMediaList.emptyItemBeforeScreen.fetchCalls}`);
    lines.push(
      `- Empty item before screen media stylesheet external resources: ${page.stylesheetMediaList.emptyItemBeforeScreen.discoveredResources} discovered, ${page.stylesheetMediaList.emptyItemBeforeScreen.loadedResources} loaded, ${page.stylesheetMediaList.emptyItemBeforeScreen.missingResources} missing`,
    );
    lines.push(`- Empty item before screen media stylesheet loaded bytes: ${page.stylesheetMediaList.emptyItemBeforeScreen.loadedBytes}`);
    lines.push(`- Empty item before screen media stylesheet author stylesheets: ${page.stylesheetMediaList.emptyItemBeforeScreen.authorStylesheetCount}`);
    lines.push(`- Empty item before screen media stylesheet author rules: ${page.stylesheetMediaList.emptyItemBeforeScreen.authorRuleCount}`);
    lines.push(`- Empty item before screen media stylesheet author declarations: ${page.stylesheetMediaList.emptyItemBeforeScreen.authorDeclarationCount}`);
    lines.push(`- Empty item before screen media stylesheet painted background: ${page.stylesheetMediaList.emptyItemBeforeScreen.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Empty item after screen media stylesheet media: ${page.stylesheetMediaList.emptyItemAfterScreen.media}`);
    lines.push(`- Empty item after screen media stylesheet fetch calls: ${page.stylesheetMediaList.emptyItemAfterScreen.fetchCalls}`);
    lines.push(
      `- Empty item after screen media stylesheet external resources: ${page.stylesheetMediaList.emptyItemAfterScreen.discoveredResources} discovered, ${page.stylesheetMediaList.emptyItemAfterScreen.loadedResources} loaded, ${page.stylesheetMediaList.emptyItemAfterScreen.missingResources} missing`,
    );
    lines.push(`- Empty item after screen media stylesheet loaded bytes: ${page.stylesheetMediaList.emptyItemAfterScreen.loadedBytes}`);
    lines.push(`- Empty item after screen media stylesheet author stylesheets: ${page.stylesheetMediaList.emptyItemAfterScreen.authorStylesheetCount}`);
    lines.push(`- Empty item after screen media stylesheet author rules: ${page.stylesheetMediaList.emptyItemAfterScreen.authorRuleCount}`);
    lines.push(`- Empty item after screen media stylesheet author declarations: ${page.stylesheetMediaList.emptyItemAfterScreen.authorDeclarationCount}`);
    lines.push(`- Empty item after screen media stylesheet painted background: ${page.stylesheetMediaList.emptyItemAfterScreen.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Empty-only media list stylesheet media: ${page.stylesheetMediaList.emptyItemsOnly.media}`);
    lines.push(`- Empty-only media list stylesheet fetch calls: ${page.stylesheetMediaList.emptyItemsOnly.fetchCalls}`);
    lines.push(
      `- Empty-only media list stylesheet external resources: ${page.stylesheetMediaList.emptyItemsOnly.discoveredResources} discovered, ${page.stylesheetMediaList.emptyItemsOnly.loadedResources} loaded, ${page.stylesheetMediaList.emptyItemsOnly.missingResources} missing`,
    );
    lines.push(`- Empty-only media list stylesheet loaded bytes: ${page.stylesheetMediaList.emptyItemsOnly.loadedBytes}`);
    lines.push(`- Empty-only media list stylesheet author stylesheets: ${page.stylesheetMediaList.emptyItemsOnly.authorStylesheetCount}`);
    lines.push(`- Empty-only media list stylesheet author rules: ${page.stylesheetMediaList.emptyItemsOnly.authorRuleCount}`);
    lines.push(`- Empty-only media list stylesheet author declarations: ${page.stylesheetMediaList.emptyItemsOnly.authorDeclarationCount}`);
    lines.push(`- Empty-only media list stylesheet painted background: ${page.stylesheetMediaList.emptyItemsOnly.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Unsupported media-list then screen stylesheet media: ${page.stylesheetMediaList.unsupportedThenScreen.media}`);
    lines.push(`- Unsupported media-list then screen stylesheet fetch calls: ${page.stylesheetMediaList.unsupportedThenScreen.fetchCalls}`);
    lines.push(
      `- Unsupported media-list then screen stylesheet external resources: ${page.stylesheetMediaList.unsupportedThenScreen.discoveredResources} discovered, ${page.stylesheetMediaList.unsupportedThenScreen.loadedResources} loaded, ${page.stylesheetMediaList.unsupportedThenScreen.missingResources} missing`,
    );
    lines.push(`- Unsupported media-list then screen stylesheet loaded bytes: ${page.stylesheetMediaList.unsupportedThenScreen.loadedBytes}`);
    lines.push(`- Unsupported media-list then screen stylesheet author stylesheets: ${page.stylesheetMediaList.unsupportedThenScreen.authorStylesheetCount}`);
    lines.push(`- Unsupported media-list then screen stylesheet author rules: ${page.stylesheetMediaList.unsupportedThenScreen.authorRuleCount}`);
    lines.push(`- Unsupported media-list then screen stylesheet author declarations: ${page.stylesheetMediaList.unsupportedThenScreen.authorDeclarationCount}`);
    lines.push(`- Unsupported media-list then screen stylesheet painted background: ${page.stylesheetMediaList.unsupportedThenScreen.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Unsupported media-list only stylesheet media: ${page.stylesheetMediaList.unsupportedOnly.media}`);
    lines.push(`- Unsupported media-list only stylesheet fetch calls: ${page.stylesheetMediaList.unsupportedOnly.fetchCalls}`);
    lines.push(
      `- Unsupported media-list only stylesheet external resources: ${page.stylesheetMediaList.unsupportedOnly.discoveredResources} discovered, ${page.stylesheetMediaList.unsupportedOnly.loadedResources} loaded, ${page.stylesheetMediaList.unsupportedOnly.missingResources} missing`,
    );
    lines.push(`- Unsupported media-list only stylesheet loaded bytes: ${page.stylesheetMediaList.unsupportedOnly.loadedBytes}`);
    lines.push(`- Unsupported media-list only stylesheet author stylesheets: ${page.stylesheetMediaList.unsupportedOnly.authorStylesheetCount}`);
    lines.push(`- Unsupported media-list only stylesheet author rules: ${page.stylesheetMediaList.unsupportedOnly.authorRuleCount}`);
    lines.push(`- Unsupported media-list only stylesheet author declarations: ${page.stylesheetMediaList.unsupportedOnly.authorDeclarationCount}`);
    lines.push(`- Unsupported media-list only stylesheet painted background: ${page.stylesheetMediaList.unsupportedOnly.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Unknown media type then screen stylesheet media: ${page.stylesheetMediaList.unknownTypeThenScreen.media}`);
    lines.push(`- Unknown media type then screen stylesheet fetch calls: ${page.stylesheetMediaList.unknownTypeThenScreen.fetchCalls}`);
    lines.push(
      `- Unknown media type then screen stylesheet external resources: ${page.stylesheetMediaList.unknownTypeThenScreen.discoveredResources} discovered, ${page.stylesheetMediaList.unknownTypeThenScreen.loadedResources} loaded, ${page.stylesheetMediaList.unknownTypeThenScreen.missingResources} missing`,
    );
    lines.push(`- Unknown media type then screen stylesheet loaded bytes: ${page.stylesheetMediaList.unknownTypeThenScreen.loadedBytes}`);
    lines.push(`- Unknown media type then screen stylesheet author stylesheets: ${page.stylesheetMediaList.unknownTypeThenScreen.authorStylesheetCount}`);
    lines.push(`- Unknown media type then screen stylesheet author rules: ${page.stylesheetMediaList.unknownTypeThenScreen.authorRuleCount}`);
    lines.push(`- Unknown media type then screen stylesheet author declarations: ${page.stylesheetMediaList.unknownTypeThenScreen.authorDeclarationCount}`);
    lines.push(`- Unknown media type then screen stylesheet painted background: ${page.stylesheetMediaList.unknownTypeThenScreen.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Unknown media type only stylesheet media: ${page.stylesheetMediaList.unknownTypeOnly.media}`);
    lines.push(`- Unknown media type only stylesheet fetch calls: ${page.stylesheetMediaList.unknownTypeOnly.fetchCalls}`);
    lines.push(
      `- Unknown media type only stylesheet external resources: ${page.stylesheetMediaList.unknownTypeOnly.discoveredResources} discovered, ${page.stylesheetMediaList.unknownTypeOnly.loadedResources} loaded, ${page.stylesheetMediaList.unknownTypeOnly.missingResources} missing`,
    );
    lines.push(`- Unknown media type only stylesheet loaded bytes: ${page.stylesheetMediaList.unknownTypeOnly.loadedBytes}`);
    lines.push(`- Unknown media type only stylesheet author stylesheets: ${page.stylesheetMediaList.unknownTypeOnly.authorStylesheetCount}`);
    lines.push(`- Unknown media type only stylesheet author rules: ${page.stylesheetMediaList.unknownTypeOnly.authorRuleCount}`);
    lines.push(`- Unknown media type only stylesheet author declarations: ${page.stylesheetMediaList.unknownTypeOnly.authorDeclarationCount}`);
    lines.push(`- Unknown media type only stylesheet painted background: ${page.stylesheetMediaList.unknownTypeOnly.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Uppercase screen media stylesheet media: ${page.stylesheetMediaList.uppercaseScreen.media}`);
    lines.push(`- Uppercase screen media stylesheet fetch calls: ${page.stylesheetMediaList.uppercaseScreen.fetchCalls}`);
    lines.push(
      `- Uppercase screen media stylesheet external resources: ${page.stylesheetMediaList.uppercaseScreen.discoveredResources} discovered, ${page.stylesheetMediaList.uppercaseScreen.loadedResources} loaded, ${page.stylesheetMediaList.uppercaseScreen.missingResources} missing`,
    );
    lines.push(`- Uppercase screen media stylesheet loaded bytes: ${page.stylesheetMediaList.uppercaseScreen.loadedBytes}`);
    lines.push(`- Uppercase screen media stylesheet author stylesheets: ${page.stylesheetMediaList.uppercaseScreen.authorStylesheetCount}`);
    lines.push(`- Uppercase screen media stylesheet author rules: ${page.stylesheetMediaList.uppercaseScreen.authorRuleCount}`);
    lines.push(`- Uppercase screen media stylesheet author declarations: ${page.stylesheetMediaList.uppercaseScreen.authorDeclarationCount}`);
    lines.push(`- Uppercase screen media stylesheet painted background: ${page.stylesheetMediaList.uppercaseScreen.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Mixed-case only-screen media stylesheet media: ${page.stylesheetMediaList.mixedCaseOnlyScreen.media}`);
    lines.push(`- Mixed-case only-screen media stylesheet fetch calls: ${page.stylesheetMediaList.mixedCaseOnlyScreen.fetchCalls}`);
    lines.push(
      `- Mixed-case only-screen media stylesheet external resources: ${page.stylesheetMediaList.mixedCaseOnlyScreen.discoveredResources} discovered, ${page.stylesheetMediaList.mixedCaseOnlyScreen.loadedResources} loaded, ${page.stylesheetMediaList.mixedCaseOnlyScreen.missingResources} missing`,
    );
    lines.push(`- Mixed-case only-screen media stylesheet loaded bytes: ${page.stylesheetMediaList.mixedCaseOnlyScreen.loadedBytes}`);
    lines.push(`- Mixed-case only-screen media stylesheet author stylesheets: ${page.stylesheetMediaList.mixedCaseOnlyScreen.authorStylesheetCount}`);
    lines.push(`- Mixed-case only-screen media stylesheet author rules: ${page.stylesheetMediaList.mixedCaseOnlyScreen.authorRuleCount}`);
    lines.push(`- Mixed-case only-screen media stylesheet author declarations: ${page.stylesheetMediaList.mixedCaseOnlyScreen.authorDeclarationCount}`);
    lines.push(`- Mixed-case only-screen media stylesheet painted background: ${page.stylesheetMediaList.mixedCaseOnlyScreen.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Spaced only-screen media stylesheet media: ${page.stylesheetMediaList.spacedOnlyScreen.media}`);
    lines.push(`- Spaced only-screen media stylesheet fetch calls: ${page.stylesheetMediaList.spacedOnlyScreen.fetchCalls}`);
    lines.push(
      `- Spaced only-screen media stylesheet external resources: ${page.stylesheetMediaList.spacedOnlyScreen.discoveredResources} discovered, ${page.stylesheetMediaList.spacedOnlyScreen.loadedResources} loaded, ${page.stylesheetMediaList.spacedOnlyScreen.missingResources} missing`,
    );
    lines.push(`- Spaced only-screen media stylesheet loaded bytes: ${page.stylesheetMediaList.spacedOnlyScreen.loadedBytes}`);
    lines.push(`- Spaced only-screen media stylesheet author stylesheets: ${page.stylesheetMediaList.spacedOnlyScreen.authorStylesheetCount}`);
    lines.push(`- Spaced only-screen media stylesheet author rules: ${page.stylesheetMediaList.spacedOnlyScreen.authorRuleCount}`);
    lines.push(`- Spaced only-screen media stylesheet author declarations: ${page.stylesheetMediaList.spacedOnlyScreen.authorDeclarationCount}`);
    lines.push(`- Spaced only-screen media stylesheet painted background: ${page.stylesheetMediaList.spacedOnlyScreen.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Uppercase print media stylesheet media: ${page.stylesheetMediaList.uppercasePrint.media}`);
    lines.push(`- Uppercase print media stylesheet fetch calls: ${page.stylesheetMediaList.uppercasePrint.fetchCalls}`);
    lines.push(
      `- Uppercase print media stylesheet external resources: ${page.stylesheetMediaList.uppercasePrint.discoveredResources} discovered, ${page.stylesheetMediaList.uppercasePrint.loadedResources} loaded, ${page.stylesheetMediaList.uppercasePrint.missingResources} missing`,
    );
    lines.push(`- Uppercase print media stylesheet loaded bytes: ${page.stylesheetMediaList.uppercasePrint.loadedBytes}`);
    lines.push(`- Uppercase print media stylesheet author stylesheets: ${page.stylesheetMediaList.uppercasePrint.authorStylesheetCount}`);
    lines.push(`- Uppercase print media stylesheet author rules: ${page.stylesheetMediaList.uppercasePrint.authorRuleCount}`);
    lines.push(`- Uppercase print media stylesheet author declarations: ${page.stylesheetMediaList.uppercasePrint.authorDeclarationCount}`);
    lines.push(`- Uppercase print media stylesheet painted background: ${page.stylesheetMediaList.uppercasePrint.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Not-print stylesheet media: ${page.stylesheetMediaList.notPrint.media}`);
    lines.push(`- Not-print stylesheet fetch calls: ${page.stylesheetMediaList.notPrint.fetchCalls}`);
    lines.push(
      `- Not-print stylesheet external resources: ${page.stylesheetMediaList.notPrint.discoveredResources} discovered, ${page.stylesheetMediaList.notPrint.loadedResources} loaded, ${page.stylesheetMediaList.notPrint.missingResources} missing`,
    );
    lines.push(`- Not-print stylesheet loaded bytes: ${page.stylesheetMediaList.notPrint.loadedBytes}`);
    lines.push(`- Not-print stylesheet author stylesheets: ${page.stylesheetMediaList.notPrint.authorStylesheetCount}`);
    lines.push(`- Not-print stylesheet author rules: ${page.stylesheetMediaList.notPrint.authorRuleCount}`);
    lines.push(`- Not-print stylesheet author declarations: ${page.stylesheetMediaList.notPrint.authorDeclarationCount}`);
    lines.push(`- Not-print stylesheet painted background: ${page.stylesheetMediaList.notPrint.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Spaced not-print stylesheet media: ${page.stylesheetMediaList.spacedNotPrint.media}`);
    lines.push(`- Spaced not-print stylesheet fetch calls: ${page.stylesheetMediaList.spacedNotPrint.fetchCalls}`);
    lines.push(
      `- Spaced not-print stylesheet external resources: ${page.stylesheetMediaList.spacedNotPrint.discoveredResources} discovered, ${page.stylesheetMediaList.spacedNotPrint.loadedResources} loaded, ${page.stylesheetMediaList.spacedNotPrint.missingResources} missing`,
    );
    lines.push(`- Spaced not-print stylesheet loaded bytes: ${page.stylesheetMediaList.spacedNotPrint.loadedBytes}`);
    lines.push(`- Spaced not-print stylesheet author stylesheets: ${page.stylesheetMediaList.spacedNotPrint.authorStylesheetCount}`);
    lines.push(`- Spaced not-print stylesheet author rules: ${page.stylesheetMediaList.spacedNotPrint.authorRuleCount}`);
    lines.push(`- Spaced not-print stylesheet author declarations: ${page.stylesheetMediaList.spacedNotPrint.authorDeclarationCount}`);
    lines.push(`- Spaced not-print stylesheet painted background: ${page.stylesheetMediaList.spacedNotPrint.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Only-print stylesheet media: ${page.stylesheetMediaList.onlyPrint.media}`);
    lines.push(`- Only-print stylesheet fetch calls: ${page.stylesheetMediaList.onlyPrint.fetchCalls}`);
    lines.push(
      `- Only-print stylesheet external resources: ${page.stylesheetMediaList.onlyPrint.discoveredResources} discovered, ${page.stylesheetMediaList.onlyPrint.loadedResources} loaded, ${page.stylesheetMediaList.onlyPrint.missingResources} missing`,
    );
    lines.push(`- Only-print stylesheet loaded bytes: ${page.stylesheetMediaList.onlyPrint.loadedBytes}`);
    lines.push(`- Only-print stylesheet author stylesheets: ${page.stylesheetMediaList.onlyPrint.authorStylesheetCount}`);
    lines.push(`- Only-print stylesheet author rules: ${page.stylesheetMediaList.onlyPrint.authorRuleCount}`);
    lines.push(`- Only-print stylesheet author declarations: ${page.stylesheetMediaList.onlyPrint.authorDeclarationCount}`);
    lines.push(`- Only-print stylesheet painted background: ${page.stylesheetMediaList.onlyPrint.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Spaced only-print stylesheet media: ${page.stylesheetMediaList.spacedOnlyPrint.media}`);
    lines.push(`- Spaced only-print stylesheet fetch calls: ${page.stylesheetMediaList.spacedOnlyPrint.fetchCalls}`);
    lines.push(
      `- Spaced only-print stylesheet external resources: ${page.stylesheetMediaList.spacedOnlyPrint.discoveredResources} discovered, ${page.stylesheetMediaList.spacedOnlyPrint.loadedResources} loaded, ${page.stylesheetMediaList.spacedOnlyPrint.missingResources} missing`,
    );
    lines.push(`- Spaced only-print stylesheet loaded bytes: ${page.stylesheetMediaList.spacedOnlyPrint.loadedBytes}`);
    lines.push(`- Spaced only-print stylesheet author stylesheets: ${page.stylesheetMediaList.spacedOnlyPrint.authorStylesheetCount}`);
    lines.push(`- Spaced only-print stylesheet author rules: ${page.stylesheetMediaList.spacedOnlyPrint.authorRuleCount}`);
    lines.push(`- Spaced only-print stylesheet author declarations: ${page.stylesheetMediaList.spacedOnlyPrint.authorDeclarationCount}`);
    lines.push(`- Spaced only-print stylesheet painted background: ${page.stylesheetMediaList.spacedOnlyPrint.paintedBackground ? "yes" : "no"}`);
    lines.push(`- All media stylesheet media: ${page.stylesheetMediaList.all.media}`);
    lines.push(`- All media stylesheet fetch calls: ${page.stylesheetMediaList.all.fetchCalls}`);
    lines.push(
      `- All media stylesheet external resources: ${page.stylesheetMediaList.all.discoveredResources} discovered, ${page.stylesheetMediaList.all.loadedResources} loaded, ${page.stylesheetMediaList.all.missingResources} missing`,
    );
    lines.push(`- All media stylesheet loaded bytes: ${page.stylesheetMediaList.all.loadedBytes}`);
    lines.push(`- All media stylesheet author stylesheets: ${page.stylesheetMediaList.all.authorStylesheetCount}`);
    lines.push(`- All media stylesheet author rules: ${page.stylesheetMediaList.all.authorRuleCount}`);
    lines.push(`- All media stylesheet author declarations: ${page.stylesheetMediaList.all.authorDeclarationCount}`);
    lines.push(`- All media stylesheet painted background: ${page.stylesheetMediaList.all.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Only-all stylesheet media: ${page.stylesheetMediaList.onlyAll.media}`);
    lines.push(`- Only-all stylesheet fetch calls: ${page.stylesheetMediaList.onlyAll.fetchCalls}`);
    lines.push(
      `- Only-all stylesheet external resources: ${page.stylesheetMediaList.onlyAll.discoveredResources} discovered, ${page.stylesheetMediaList.onlyAll.loadedResources} loaded, ${page.stylesheetMediaList.onlyAll.missingResources} missing`,
    );
    lines.push(`- Only-all stylesheet loaded bytes: ${page.stylesheetMediaList.onlyAll.loadedBytes}`);
    lines.push(`- Only-all stylesheet author stylesheets: ${page.stylesheetMediaList.onlyAll.authorStylesheetCount}`);
    lines.push(`- Only-all stylesheet author rules: ${page.stylesheetMediaList.onlyAll.authorRuleCount}`);
    lines.push(`- Only-all stylesheet author declarations: ${page.stylesheetMediaList.onlyAll.authorDeclarationCount}`);
    lines.push(`- Only-all stylesheet painted background: ${page.stylesheetMediaList.onlyAll.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Not-all stylesheet media: ${page.stylesheetMediaList.notAll.media}`);
    lines.push(`- Not-all stylesheet fetch calls: ${page.stylesheetMediaList.notAll.fetchCalls}`);
    lines.push(
      `- Not-all stylesheet external resources: ${page.stylesheetMediaList.notAll.discoveredResources} discovered, ${page.stylesheetMediaList.notAll.loadedResources} loaded, ${page.stylesheetMediaList.notAll.missingResources} missing`,
    );
    lines.push(`- Not-all stylesheet loaded bytes: ${page.stylesheetMediaList.notAll.loadedBytes}`);
    lines.push(`- Not-all stylesheet author stylesheets: ${page.stylesheetMediaList.notAll.authorStylesheetCount}`);
    lines.push(`- Not-all stylesheet author rules: ${page.stylesheetMediaList.notAll.authorRuleCount}`);
    lines.push(`- Not-all stylesheet author declarations: ${page.stylesheetMediaList.notAll.authorDeclarationCount}`);
    lines.push(`- Not-all stylesheet painted background: ${page.stylesheetMediaList.notAll.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Spaced not-all stylesheet media: ${page.stylesheetMediaList.spacedNotAll.media}`);
    lines.push(`- Spaced not-all stylesheet fetch calls: ${page.stylesheetMediaList.spacedNotAll.fetchCalls}`);
    lines.push(
      `- Spaced not-all stylesheet external resources: ${page.stylesheetMediaList.spacedNotAll.discoveredResources} discovered, ${page.stylesheetMediaList.spacedNotAll.loadedResources} loaded, ${page.stylesheetMediaList.spacedNotAll.missingResources} missing`,
    );
    lines.push(`- Spaced not-all stylesheet loaded bytes: ${page.stylesheetMediaList.spacedNotAll.loadedBytes}`);
    lines.push(`- Spaced not-all stylesheet author stylesheets: ${page.stylesheetMediaList.spacedNotAll.authorStylesheetCount}`);
    lines.push(`- Spaced not-all stylesheet author rules: ${page.stylesheetMediaList.spacedNotAll.authorRuleCount}`);
    lines.push(`- Spaced not-all stylesheet author declarations: ${page.stylesheetMediaList.spacedNotAll.authorDeclarationCount}`);
    lines.push(`- Spaced not-all stylesheet painted background: ${page.stylesheetMediaList.spacedNotAll.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Media-feature min-width stylesheet media: ${page.stylesheetMediaFeature.screenMinWidth.media}`);
    lines.push(`- Media-feature min-width stylesheet fetch calls: ${page.stylesheetMediaFeature.screenMinWidth.fetchCalls}`);
    lines.push(
      `- Media-feature min-width stylesheet external resources: ${page.stylesheetMediaFeature.screenMinWidth.discoveredResources} discovered, ${page.stylesheetMediaFeature.screenMinWidth.loadedResources} loaded, ${page.stylesheetMediaFeature.screenMinWidth.missingResources} missing`,
    );
    lines.push(`- Media-feature min-width stylesheet loaded bytes: ${page.stylesheetMediaFeature.screenMinWidth.loadedBytes}`);
    lines.push(`- Media-feature min-width stylesheet author stylesheets: ${page.stylesheetMediaFeature.screenMinWidth.authorStylesheetCount}`);
    lines.push(`- Media-feature min-width stylesheet author rules: ${page.stylesheetMediaFeature.screenMinWidth.authorRuleCount}`);
    lines.push(`- Media-feature min-width stylesheet author declarations: ${page.stylesheetMediaFeature.screenMinWidth.authorDeclarationCount}`);
    lines.push(`- Media-feature min-width stylesheet painted background: ${page.stylesheetMediaFeature.screenMinWidth.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Uppercase media-feature min-width stylesheet media: ${page.stylesheetMediaFeature.uppercaseScreenMinWidth.media}`);
    lines.push(`- Uppercase media-feature min-width stylesheet fetch calls: ${page.stylesheetMediaFeature.uppercaseScreenMinWidth.fetchCalls}`);
    lines.push(
      `- Uppercase media-feature min-width stylesheet external resources: ${page.stylesheetMediaFeature.uppercaseScreenMinWidth.discoveredResources} discovered, ${page.stylesheetMediaFeature.uppercaseScreenMinWidth.loadedResources} loaded, ${page.stylesheetMediaFeature.uppercaseScreenMinWidth.missingResources} missing`,
    );
    lines.push(`- Uppercase media-feature min-width stylesheet loaded bytes: ${page.stylesheetMediaFeature.uppercaseScreenMinWidth.loadedBytes}`);
    lines.push(`- Uppercase media-feature min-width stylesheet author stylesheets: ${page.stylesheetMediaFeature.uppercaseScreenMinWidth.authorStylesheetCount}`);
    lines.push(`- Uppercase media-feature min-width stylesheet author rules: ${page.stylesheetMediaFeature.uppercaseScreenMinWidth.authorRuleCount}`);
    lines.push(`- Uppercase media-feature min-width stylesheet author declarations: ${page.stylesheetMediaFeature.uppercaseScreenMinWidth.authorDeclarationCount}`);
    lines.push(`- Uppercase media-feature min-width stylesheet painted background: ${page.stylesheetMediaFeature.uppercaseScreenMinWidth.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Decimal media-feature min-width stylesheet media: ${page.stylesheetMediaFeature.decimalScreenMinWidth.media}`);
    lines.push(`- Decimal media-feature min-width stylesheet fetch calls: ${page.stylesheetMediaFeature.decimalScreenMinWidth.fetchCalls}`);
    lines.push(
      `- Decimal media-feature min-width stylesheet external resources: ${page.stylesheetMediaFeature.decimalScreenMinWidth.discoveredResources} discovered, ${page.stylesheetMediaFeature.decimalScreenMinWidth.loadedResources} loaded, ${page.stylesheetMediaFeature.decimalScreenMinWidth.missingResources} missing`,
    );
    lines.push(`- Decimal media-feature min-width stylesheet loaded bytes: ${page.stylesheetMediaFeature.decimalScreenMinWidth.loadedBytes}`);
    lines.push(`- Decimal media-feature min-width stylesheet author stylesheets: ${page.stylesheetMediaFeature.decimalScreenMinWidth.authorStylesheetCount}`);
    lines.push(`- Decimal media-feature min-width stylesheet author rules: ${page.stylesheetMediaFeature.decimalScreenMinWidth.authorRuleCount}`);
    lines.push(`- Decimal media-feature min-width stylesheet author declarations: ${page.stylesheetMediaFeature.decimalScreenMinWidth.authorDeclarationCount}`);
    lines.push(`- Decimal media-feature min-width stylesheet painted background: ${page.stylesheetMediaFeature.decimalScreenMinWidth.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Spaced media-feature min-width stylesheet media: ${page.stylesheetMediaFeature.spacedScreenMinWidth.media}`);
    lines.push(`- Spaced media-feature min-width stylesheet fetch calls: ${page.stylesheetMediaFeature.spacedScreenMinWidth.fetchCalls}`);
    lines.push(
      `- Spaced media-feature min-width stylesheet external resources: ${page.stylesheetMediaFeature.spacedScreenMinWidth.discoveredResources} discovered, ${page.stylesheetMediaFeature.spacedScreenMinWidth.loadedResources} loaded, ${page.stylesheetMediaFeature.spacedScreenMinWidth.missingResources} missing`,
    );
    lines.push(`- Spaced media-feature min-width stylesheet loaded bytes: ${page.stylesheetMediaFeature.spacedScreenMinWidth.loadedBytes}`);
    lines.push(`- Spaced media-feature min-width stylesheet author stylesheets: ${page.stylesheetMediaFeature.spacedScreenMinWidth.authorStylesheetCount}`);
    lines.push(`- Spaced media-feature min-width stylesheet author rules: ${page.stylesheetMediaFeature.spacedScreenMinWidth.authorRuleCount}`);
    lines.push(`- Spaced media-feature min-width stylesheet author declarations: ${page.stylesheetMediaFeature.spacedScreenMinWidth.authorDeclarationCount}`);
    lines.push(`- Spaced media-feature min-width stylesheet painted background: ${page.stylesheetMediaFeature.spacedScreenMinWidth.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Media-feature bare-min-width stylesheet media: ${page.stylesheetMediaFeature.bareMinWidth.media}`);
    lines.push(`- Media-feature bare-min-width stylesheet fetch calls: ${page.stylesheetMediaFeature.bareMinWidth.fetchCalls}`);
    lines.push(
      `- Media-feature bare-min-width stylesheet external resources: ${page.stylesheetMediaFeature.bareMinWidth.discoveredResources} discovered, ${page.stylesheetMediaFeature.bareMinWidth.loadedResources} loaded, ${page.stylesheetMediaFeature.bareMinWidth.missingResources} missing`,
    );
    lines.push(`- Media-feature bare-min-width stylesheet loaded bytes: ${page.stylesheetMediaFeature.bareMinWidth.loadedBytes}`);
    lines.push(`- Media-feature bare-min-width stylesheet author stylesheets: ${page.stylesheetMediaFeature.bareMinWidth.authorStylesheetCount}`);
    lines.push(`- Media-feature bare-min-width stylesheet author rules: ${page.stylesheetMediaFeature.bareMinWidth.authorRuleCount}`);
    lines.push(`- Media-feature bare-min-width stylesheet author declarations: ${page.stylesheetMediaFeature.bareMinWidth.authorDeclarationCount}`);
    lines.push(`- Media-feature bare-min-width stylesheet painted background: ${page.stylesheetMediaFeature.bareMinWidth.paintedBackground ? "yes" : "no"}`);
    lines.push(`- All-and media-feature min-width stylesheet media: ${page.stylesheetMediaFeature.allMinWidth.media}`);
    lines.push(`- All-and media-feature min-width stylesheet fetch calls: ${page.stylesheetMediaFeature.allMinWidth.fetchCalls}`);
    lines.push(
      `- All-and media-feature min-width stylesheet external resources: ${page.stylesheetMediaFeature.allMinWidth.discoveredResources} discovered, ${page.stylesheetMediaFeature.allMinWidth.loadedResources} loaded, ${page.stylesheetMediaFeature.allMinWidth.missingResources} missing`,
    );
    lines.push(`- All-and media-feature min-width stylesheet loaded bytes: ${page.stylesheetMediaFeature.allMinWidth.loadedBytes}`);
    lines.push(`- All-and media-feature min-width stylesheet author stylesheets: ${page.stylesheetMediaFeature.allMinWidth.authorStylesheetCount}`);
    lines.push(`- All-and media-feature min-width stylesheet author rules: ${page.stylesheetMediaFeature.allMinWidth.authorRuleCount}`);
    lines.push(`- All-and media-feature min-width stylesheet author declarations: ${page.stylesheetMediaFeature.allMinWidth.authorDeclarationCount}`);
    lines.push(`- All-and media-feature min-width stylesheet painted background: ${page.stylesheetMediaFeature.allMinWidth.paintedBackground ? "yes" : "no"}`);
    lines.push(`- All-and media-feature max-width stylesheet media: ${page.stylesheetMediaFeature.allMaxWidth.media}`);
    lines.push(`- All-and media-feature max-width stylesheet fetch calls: ${page.stylesheetMediaFeature.allMaxWidth.fetchCalls}`);
    lines.push(
      `- All-and media-feature max-width stylesheet external resources: ${page.stylesheetMediaFeature.allMaxWidth.discoveredResources} discovered, ${page.stylesheetMediaFeature.allMaxWidth.loadedResources} loaded, ${page.stylesheetMediaFeature.allMaxWidth.missingResources} missing`,
    );
    lines.push(`- All-and media-feature max-width stylesheet loaded bytes: ${page.stylesheetMediaFeature.allMaxWidth.loadedBytes}`);
    lines.push(`- All-and media-feature max-width stylesheet author stylesheets: ${page.stylesheetMediaFeature.allMaxWidth.authorStylesheetCount}`);
    lines.push(`- All-and media-feature max-width stylesheet author rules: ${page.stylesheetMediaFeature.allMaxWidth.authorRuleCount}`);
    lines.push(`- All-and media-feature max-width stylesheet author declarations: ${page.stylesheetMediaFeature.allMaxWidth.authorDeclarationCount}`);
    lines.push(`- All-and media-feature max-width stylesheet painted background: ${page.stylesheetMediaFeature.allMaxWidth.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Only-all-and media-feature min-width stylesheet media: ${page.stylesheetMediaFeature.onlyAllMinWidth.media}`);
    lines.push(`- Only-all-and media-feature min-width stylesheet fetch calls: ${page.stylesheetMediaFeature.onlyAllMinWidth.fetchCalls}`);
    lines.push(
      `- Only-all-and media-feature min-width stylesheet external resources: ${page.stylesheetMediaFeature.onlyAllMinWidth.discoveredResources} discovered, ${page.stylesheetMediaFeature.onlyAllMinWidth.loadedResources} loaded, ${page.stylesheetMediaFeature.onlyAllMinWidth.missingResources} missing`,
    );
    lines.push(`- Only-all-and media-feature min-width stylesheet loaded bytes: ${page.stylesheetMediaFeature.onlyAllMinWidth.loadedBytes}`);
    lines.push(`- Only-all-and media-feature min-width stylesheet author stylesheets: ${page.stylesheetMediaFeature.onlyAllMinWidth.authorStylesheetCount}`);
    lines.push(`- Only-all-and media-feature min-width stylesheet author rules: ${page.stylesheetMediaFeature.onlyAllMinWidth.authorRuleCount}`);
    lines.push(`- Only-all-and media-feature min-width stylesheet author declarations: ${page.stylesheetMediaFeature.onlyAllMinWidth.authorDeclarationCount}`);
    lines.push(`- Only-all-and media-feature min-width stylesheet painted background: ${page.stylesheetMediaFeature.onlyAllMinWidth.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Unsupported range media-feature stylesheet media: ${page.stylesheetMediaFeature.unsupportedRangeWidth.media}`);
    lines.push(`- Unsupported range media-feature stylesheet fetch calls: ${page.stylesheetMediaFeature.unsupportedRangeWidth.fetchCalls}`);
    lines.push(
      `- Unsupported range media-feature stylesheet external resources: ${page.stylesheetMediaFeature.unsupportedRangeWidth.discoveredResources} discovered, ${page.stylesheetMediaFeature.unsupportedRangeWidth.loadedResources} loaded, ${page.stylesheetMediaFeature.unsupportedRangeWidth.missingResources} missing`,
    );
    lines.push(`- Unsupported range media-feature stylesheet loaded bytes: ${page.stylesheetMediaFeature.unsupportedRangeWidth.loadedBytes}`);
    lines.push(`- Unsupported range media-feature stylesheet author stylesheets: ${page.stylesheetMediaFeature.unsupportedRangeWidth.authorStylesheetCount}`);
    lines.push(`- Unsupported range media-feature stylesheet author rules: ${page.stylesheetMediaFeature.unsupportedRangeWidth.authorRuleCount}`);
    lines.push(`- Unsupported range media-feature stylesheet author declarations: ${page.stylesheetMediaFeature.unsupportedRangeWidth.authorDeclarationCount}`);
    lines.push(`- Unsupported range media-feature stylesheet painted background: ${page.stylesheetMediaFeature.unsupportedRangeWidth.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Unsupported range then screen stylesheet media: ${page.stylesheetMediaFeature.unsupportedRangeThenScreen.media}`);
    lines.push(`- Unsupported range then screen stylesheet fetch calls: ${page.stylesheetMediaFeature.unsupportedRangeThenScreen.fetchCalls}`);
    lines.push(
      `- Unsupported range then screen stylesheet external resources: ${page.stylesheetMediaFeature.unsupportedRangeThenScreen.discoveredResources} discovered, ${page.stylesheetMediaFeature.unsupportedRangeThenScreen.loadedResources} loaded, ${page.stylesheetMediaFeature.unsupportedRangeThenScreen.missingResources} missing`,
    );
    lines.push(`- Unsupported range then screen stylesheet loaded bytes: ${page.stylesheetMediaFeature.unsupportedRangeThenScreen.loadedBytes}`);
    lines.push(`- Unsupported range then screen stylesheet author stylesheets: ${page.stylesheetMediaFeature.unsupportedRangeThenScreen.authorStylesheetCount}`);
    lines.push(`- Unsupported range then screen stylesheet author rules: ${page.stylesheetMediaFeature.unsupportedRangeThenScreen.authorRuleCount}`);
    lines.push(`- Unsupported range then screen stylesheet author declarations: ${page.stylesheetMediaFeature.unsupportedRangeThenScreen.authorDeclarationCount}`);
    lines.push(`- Unsupported range then screen stylesheet painted background: ${page.stylesheetMediaFeature.unsupportedRangeThenScreen.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Unsupported calc media-feature stylesheet media: ${page.stylesheetMediaFeature.unsupportedCalcMinWidth.media}`);
    lines.push(`- Unsupported calc media-feature stylesheet fetch calls: ${page.stylesheetMediaFeature.unsupportedCalcMinWidth.fetchCalls}`);
    lines.push(
      `- Unsupported calc media-feature stylesheet external resources: ${page.stylesheetMediaFeature.unsupportedCalcMinWidth.discoveredResources} discovered, ${page.stylesheetMediaFeature.unsupportedCalcMinWidth.loadedResources} loaded, ${page.stylesheetMediaFeature.unsupportedCalcMinWidth.missingResources} missing`,
    );
    lines.push(`- Unsupported calc media-feature stylesheet loaded bytes: ${page.stylesheetMediaFeature.unsupportedCalcMinWidth.loadedBytes}`);
    lines.push(`- Unsupported calc media-feature stylesheet author stylesheets: ${page.stylesheetMediaFeature.unsupportedCalcMinWidth.authorStylesheetCount}`);
    lines.push(`- Unsupported calc media-feature stylesheet author rules: ${page.stylesheetMediaFeature.unsupportedCalcMinWidth.authorRuleCount}`);
    lines.push(`- Unsupported calc media-feature stylesheet author declarations: ${page.stylesheetMediaFeature.unsupportedCalcMinWidth.authorDeclarationCount}`);
    lines.push(`- Unsupported calc media-feature stylesheet painted background: ${page.stylesheetMediaFeature.unsupportedCalcMinWidth.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Unsupported hover media-feature stylesheet media: ${page.stylesheetMediaFeature.unsupportedHover.media}`);
    lines.push(`- Unsupported hover media-feature stylesheet fetch calls: ${page.stylesheetMediaFeature.unsupportedHover.fetchCalls}`);
    lines.push(
      `- Unsupported hover media-feature stylesheet external resources: ${page.stylesheetMediaFeature.unsupportedHover.discoveredResources} discovered, ${page.stylesheetMediaFeature.unsupportedHover.loadedResources} loaded, ${page.stylesheetMediaFeature.unsupportedHover.missingResources} missing`,
    );
    lines.push(`- Unsupported hover media-feature stylesheet loaded bytes: ${page.stylesheetMediaFeature.unsupportedHover.loadedBytes}`);
    lines.push(`- Unsupported hover media-feature stylesheet author stylesheets: ${page.stylesheetMediaFeature.unsupportedHover.authorStylesheetCount}`);
    lines.push(`- Unsupported hover media-feature stylesheet author rules: ${page.stylesheetMediaFeature.unsupportedHover.authorRuleCount}`);
    lines.push(`- Unsupported hover media-feature stylesheet author declarations: ${page.stylesheetMediaFeature.unsupportedHover.authorDeclarationCount}`);
    lines.push(`- Unsupported hover media-feature stylesheet painted background: ${page.stylesheetMediaFeature.unsupportedHover.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Invalid empty media-feature stylesheet media: ${page.stylesheetMediaFeature.invalidEmptyFeature.media}`);
    lines.push(`- Invalid empty media-feature stylesheet fetch calls: ${page.stylesheetMediaFeature.invalidEmptyFeature.fetchCalls}`);
    lines.push(
      `- Invalid empty media-feature stylesheet external resources: ${page.stylesheetMediaFeature.invalidEmptyFeature.discoveredResources} discovered, ${page.stylesheetMediaFeature.invalidEmptyFeature.loadedResources} loaded, ${page.stylesheetMediaFeature.invalidEmptyFeature.missingResources} missing`,
    );
    lines.push(`- Invalid empty media-feature stylesheet loaded bytes: ${page.stylesheetMediaFeature.invalidEmptyFeature.loadedBytes}`);
    lines.push(`- Invalid empty media-feature stylesheet author stylesheets: ${page.stylesheetMediaFeature.invalidEmptyFeature.authorStylesheetCount}`);
    lines.push(`- Invalid empty media-feature stylesheet author rules: ${page.stylesheetMediaFeature.invalidEmptyFeature.authorRuleCount}`);
    lines.push(`- Invalid empty media-feature stylesheet author declarations: ${page.stylesheetMediaFeature.invalidEmptyFeature.authorDeclarationCount}`);
    lines.push(`- Invalid empty media-feature stylesheet painted background: ${page.stylesheetMediaFeature.invalidEmptyFeature.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Unsupported boolean width media-feature stylesheet media: ${page.stylesheetMediaFeature.unsupportedBooleanWidth.media}`);
    lines.push(`- Unsupported boolean width media-feature stylesheet fetch calls: ${page.stylesheetMediaFeature.unsupportedBooleanWidth.fetchCalls}`);
    lines.push(
      `- Unsupported boolean width media-feature stylesheet external resources: ${page.stylesheetMediaFeature.unsupportedBooleanWidth.discoveredResources} discovered, ${page.stylesheetMediaFeature.unsupportedBooleanWidth.loadedResources} loaded, ${page.stylesheetMediaFeature.unsupportedBooleanWidth.missingResources} missing`,
    );
    lines.push(`- Unsupported boolean width media-feature stylesheet loaded bytes: ${page.stylesheetMediaFeature.unsupportedBooleanWidth.loadedBytes}`);
    lines.push(`- Unsupported boolean width media-feature stylesheet author stylesheets: ${page.stylesheetMediaFeature.unsupportedBooleanWidth.authorStylesheetCount}`);
    lines.push(`- Unsupported boolean width media-feature stylesheet author rules: ${page.stylesheetMediaFeature.unsupportedBooleanWidth.authorRuleCount}`);
    lines.push(`- Unsupported boolean width media-feature stylesheet author declarations: ${page.stylesheetMediaFeature.unsupportedBooleanWidth.authorDeclarationCount}`);
    lines.push(`- Unsupported boolean width media-feature stylesheet painted background: ${page.stylesheetMediaFeature.unsupportedBooleanWidth.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Unknown media-feature stylesheet media: ${page.stylesheetMediaFeature.unknownFeature.media}`);
    lines.push(`- Unknown media-feature stylesheet fetch calls: ${page.stylesheetMediaFeature.unknownFeature.fetchCalls}`);
    lines.push(
      `- Unknown media-feature stylesheet external resources: ${page.stylesheetMediaFeature.unknownFeature.discoveredResources} discovered, ${page.stylesheetMediaFeature.unknownFeature.loadedResources} loaded, ${page.stylesheetMediaFeature.unknownFeature.missingResources} missing`,
    );
    lines.push(`- Unknown media-feature stylesheet loaded bytes: ${page.stylesheetMediaFeature.unknownFeature.loadedBytes}`);
    lines.push(`- Unknown media-feature stylesheet author stylesheets: ${page.stylesheetMediaFeature.unknownFeature.authorStylesheetCount}`);
    lines.push(`- Unknown media-feature stylesheet author rules: ${page.stylesheetMediaFeature.unknownFeature.authorRuleCount}`);
    lines.push(`- Unknown media-feature stylesheet author declarations: ${page.stylesheetMediaFeature.unknownFeature.authorDeclarationCount}`);
    lines.push(`- Unknown media-feature stylesheet painted background: ${page.stylesheetMediaFeature.unknownFeature.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Invalid empty feature then screen stylesheet media: ${page.stylesheetMediaFeature.invalidEmptyFeatureThenScreen.media}`);
    lines.push(`- Invalid empty feature then screen stylesheet fetch calls: ${page.stylesheetMediaFeature.invalidEmptyFeatureThenScreen.fetchCalls}`);
    lines.push(
      `- Invalid empty feature then screen stylesheet external resources: ${page.stylesheetMediaFeature.invalidEmptyFeatureThenScreen.discoveredResources} discovered, ${page.stylesheetMediaFeature.invalidEmptyFeatureThenScreen.loadedResources} loaded, ${page.stylesheetMediaFeature.invalidEmptyFeatureThenScreen.missingResources} missing`,
    );
    lines.push(`- Invalid empty feature then screen stylesheet loaded bytes: ${page.stylesheetMediaFeature.invalidEmptyFeatureThenScreen.loadedBytes}`);
    lines.push(`- Invalid empty feature then screen stylesheet author stylesheets: ${page.stylesheetMediaFeature.invalidEmptyFeatureThenScreen.authorStylesheetCount}`);
    lines.push(`- Invalid empty feature then screen stylesheet author rules: ${page.stylesheetMediaFeature.invalidEmptyFeatureThenScreen.authorRuleCount}`);
    lines.push(`- Invalid empty feature then screen stylesheet author declarations: ${page.stylesheetMediaFeature.invalidEmptyFeatureThenScreen.authorDeclarationCount}`);
    lines.push(`- Invalid empty feature then screen stylesheet painted background: ${page.stylesheetMediaFeature.invalidEmptyFeatureThenScreen.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Media-feature max-width stylesheet media: ${page.stylesheetMediaFeature.screenMaxWidth.media}`);
    lines.push(`- Media-feature max-width stylesheet fetch calls: ${page.stylesheetMediaFeature.screenMaxWidth.fetchCalls}`);
    lines.push(
      `- Media-feature max-width stylesheet external resources: ${page.stylesheetMediaFeature.screenMaxWidth.discoveredResources} discovered, ${page.stylesheetMediaFeature.screenMaxWidth.loadedResources} loaded, ${page.stylesheetMediaFeature.screenMaxWidth.missingResources} missing`,
    );
    lines.push(`- Media-feature max-width stylesheet loaded bytes: ${page.stylesheetMediaFeature.screenMaxWidth.loadedBytes}`);
    lines.push(`- Media-feature max-width stylesheet author stylesheets: ${page.stylesheetMediaFeature.screenMaxWidth.authorStylesheetCount}`);
    lines.push(`- Media-feature max-width stylesheet author rules: ${page.stylesheetMediaFeature.screenMaxWidth.authorRuleCount}`);
    lines.push(`- Media-feature max-width stylesheet author declarations: ${page.stylesheetMediaFeature.screenMaxWidth.authorDeclarationCount}`);
    lines.push(`- Media-feature max-width stylesheet painted background: ${page.stylesheetMediaFeature.screenMaxWidth.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Decimal media-feature max-width stylesheet media: ${page.stylesheetMediaFeature.decimalScreenMaxWidth.media}`);
    lines.push(`- Decimal media-feature max-width stylesheet fetch calls: ${page.stylesheetMediaFeature.decimalScreenMaxWidth.fetchCalls}`);
    lines.push(
      `- Decimal media-feature max-width stylesheet external resources: ${page.stylesheetMediaFeature.decimalScreenMaxWidth.discoveredResources} discovered, ${page.stylesheetMediaFeature.decimalScreenMaxWidth.loadedResources} loaded, ${page.stylesheetMediaFeature.decimalScreenMaxWidth.missingResources} missing`,
    );
    lines.push(`- Decimal media-feature max-width stylesheet loaded bytes: ${page.stylesheetMediaFeature.decimalScreenMaxWidth.loadedBytes}`);
    lines.push(`- Decimal media-feature max-width stylesheet author stylesheets: ${page.stylesheetMediaFeature.decimalScreenMaxWidth.authorStylesheetCount}`);
    lines.push(`- Decimal media-feature max-width stylesheet author rules: ${page.stylesheetMediaFeature.decimalScreenMaxWidth.authorRuleCount}`);
    lines.push(`- Decimal media-feature max-width stylesheet author declarations: ${page.stylesheetMediaFeature.decimalScreenMaxWidth.authorDeclarationCount}`);
    lines.push(`- Decimal media-feature max-width stylesheet painted background: ${page.stylesheetMediaFeature.decimalScreenMaxWidth.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Spaced media-feature max-width stylesheet media: ${page.stylesheetMediaFeature.spacedScreenMaxWidth.media}`);
    lines.push(`- Spaced media-feature max-width stylesheet fetch calls: ${page.stylesheetMediaFeature.spacedScreenMaxWidth.fetchCalls}`);
    lines.push(
      `- Spaced media-feature max-width stylesheet external resources: ${page.stylesheetMediaFeature.spacedScreenMaxWidth.discoveredResources} discovered, ${page.stylesheetMediaFeature.spacedScreenMaxWidth.loadedResources} loaded, ${page.stylesheetMediaFeature.spacedScreenMaxWidth.missingResources} missing`,
    );
    lines.push(`- Spaced media-feature max-width stylesheet loaded bytes: ${page.stylesheetMediaFeature.spacedScreenMaxWidth.loadedBytes}`);
    lines.push(`- Spaced media-feature max-width stylesheet author stylesheets: ${page.stylesheetMediaFeature.spacedScreenMaxWidth.authorStylesheetCount}`);
    lines.push(`- Spaced media-feature max-width stylesheet author rules: ${page.stylesheetMediaFeature.spacedScreenMaxWidth.authorRuleCount}`);
    lines.push(`- Spaced media-feature max-width stylesheet author declarations: ${page.stylesheetMediaFeature.spacedScreenMaxWidth.authorDeclarationCount}`);
    lines.push(`- Spaced media-feature max-width stylesheet painted background: ${page.stylesheetMediaFeature.spacedScreenMaxWidth.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Media-feature min-height stylesheet media: ${page.stylesheetMediaFeature.screenMinHeight.media}`);
    lines.push(`- Media-feature min-height stylesheet fetch calls: ${page.stylesheetMediaFeature.screenMinHeight.fetchCalls}`);
    lines.push(
      `- Media-feature min-height stylesheet external resources: ${page.stylesheetMediaFeature.screenMinHeight.discoveredResources} discovered, ${page.stylesheetMediaFeature.screenMinHeight.loadedResources} loaded, ${page.stylesheetMediaFeature.screenMinHeight.missingResources} missing`,
    );
    lines.push(`- Media-feature min-height stylesheet loaded bytes: ${page.stylesheetMediaFeature.screenMinHeight.loadedBytes}`);
    lines.push(`- Media-feature min-height stylesheet author stylesheets: ${page.stylesheetMediaFeature.screenMinHeight.authorStylesheetCount}`);
    lines.push(`- Media-feature min-height stylesheet author rules: ${page.stylesheetMediaFeature.screenMinHeight.authorRuleCount}`);
    lines.push(`- Media-feature min-height stylesheet author declarations: ${page.stylesheetMediaFeature.screenMinHeight.authorDeclarationCount}`);
    lines.push(`- Media-feature min-height stylesheet painted background: ${page.stylesheetMediaFeature.screenMinHeight.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Media-feature max-height stylesheet media: ${page.stylesheetMediaFeature.screenMaxHeight.media}`);
    lines.push(`- Media-feature max-height stylesheet fetch calls: ${page.stylesheetMediaFeature.screenMaxHeight.fetchCalls}`);
    lines.push(
      `- Media-feature max-height stylesheet external resources: ${page.stylesheetMediaFeature.screenMaxHeight.discoveredResources} discovered, ${page.stylesheetMediaFeature.screenMaxHeight.loadedResources} loaded, ${page.stylesheetMediaFeature.screenMaxHeight.missingResources} missing`,
    );
    lines.push(`- Media-feature max-height stylesheet loaded bytes: ${page.stylesheetMediaFeature.screenMaxHeight.loadedBytes}`);
    lines.push(`- Media-feature max-height stylesheet author stylesheets: ${page.stylesheetMediaFeature.screenMaxHeight.authorStylesheetCount}`);
    lines.push(`- Media-feature max-height stylesheet author rules: ${page.stylesheetMediaFeature.screenMaxHeight.authorRuleCount}`);
    lines.push(`- Media-feature max-height stylesheet author declarations: ${page.stylesheetMediaFeature.screenMaxHeight.authorDeclarationCount}`);
    lines.push(`- Media-feature max-height stylesheet painted background: ${page.stylesheetMediaFeature.screenMaxHeight.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Media-feature exact-width stylesheet media: ${page.stylesheetMediaFeature.screenExactWidth.media}`);
    lines.push(`- Media-feature exact-width stylesheet fetch calls: ${page.stylesheetMediaFeature.screenExactWidth.fetchCalls}`);
    lines.push(
      `- Media-feature exact-width stylesheet external resources: ${page.stylesheetMediaFeature.screenExactWidth.discoveredResources} discovered, ${page.stylesheetMediaFeature.screenExactWidth.loadedResources} loaded, ${page.stylesheetMediaFeature.screenExactWidth.missingResources} missing`,
    );
    lines.push(`- Media-feature exact-width stylesheet loaded bytes: ${page.stylesheetMediaFeature.screenExactWidth.loadedBytes}`);
    lines.push(`- Media-feature exact-width stylesheet author stylesheets: ${page.stylesheetMediaFeature.screenExactWidth.authorStylesheetCount}`);
    lines.push(`- Media-feature exact-width stylesheet author rules: ${page.stylesheetMediaFeature.screenExactWidth.authorRuleCount}`);
    lines.push(`- Media-feature exact-width stylesheet author declarations: ${page.stylesheetMediaFeature.screenExactWidth.authorDeclarationCount}`);
    lines.push(`- Media-feature exact-width stylesheet painted background: ${page.stylesheetMediaFeature.screenExactWidth.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Decimal media-feature exact-width stylesheet media: ${page.stylesheetMediaFeature.decimalScreenExactWidth.media}`);
    lines.push(`- Decimal media-feature exact-width stylesheet fetch calls: ${page.stylesheetMediaFeature.decimalScreenExactWidth.fetchCalls}`);
    lines.push(
      `- Decimal media-feature exact-width stylesheet external resources: ${page.stylesheetMediaFeature.decimalScreenExactWidth.discoveredResources} discovered, ${page.stylesheetMediaFeature.decimalScreenExactWidth.loadedResources} loaded, ${page.stylesheetMediaFeature.decimalScreenExactWidth.missingResources} missing`,
    );
    lines.push(`- Decimal media-feature exact-width stylesheet loaded bytes: ${page.stylesheetMediaFeature.decimalScreenExactWidth.loadedBytes}`);
    lines.push(`- Decimal media-feature exact-width stylesheet author stylesheets: ${page.stylesheetMediaFeature.decimalScreenExactWidth.authorStylesheetCount}`);
    lines.push(`- Decimal media-feature exact-width stylesheet author rules: ${page.stylesheetMediaFeature.decimalScreenExactWidth.authorRuleCount}`);
    lines.push(`- Decimal media-feature exact-width stylesheet author declarations: ${page.stylesheetMediaFeature.decimalScreenExactWidth.authorDeclarationCount}`);
    lines.push(`- Decimal media-feature exact-width stylesheet painted background: ${page.stylesheetMediaFeature.decimalScreenExactWidth.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Media-feature exact-height stylesheet media: ${page.stylesheetMediaFeature.screenExactHeight.media}`);
    lines.push(`- Media-feature exact-height stylesheet fetch calls: ${page.stylesheetMediaFeature.screenExactHeight.fetchCalls}`);
    lines.push(
      `- Media-feature exact-height stylesheet external resources: ${page.stylesheetMediaFeature.screenExactHeight.discoveredResources} discovered, ${page.stylesheetMediaFeature.screenExactHeight.loadedResources} loaded, ${page.stylesheetMediaFeature.screenExactHeight.missingResources} missing`,
    );
    lines.push(`- Media-feature exact-height stylesheet loaded bytes: ${page.stylesheetMediaFeature.screenExactHeight.loadedBytes}`);
    lines.push(`- Media-feature exact-height stylesheet author stylesheets: ${page.stylesheetMediaFeature.screenExactHeight.authorStylesheetCount}`);
    lines.push(`- Media-feature exact-height stylesheet author rules: ${page.stylesheetMediaFeature.screenExactHeight.authorRuleCount}`);
    lines.push(`- Media-feature exact-height stylesheet author declarations: ${page.stylesheetMediaFeature.screenExactHeight.authorDeclarationCount}`);
    lines.push(`- Media-feature exact-height stylesheet painted background: ${page.stylesheetMediaFeature.screenExactHeight.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Media-feature exact-height miss stylesheet media: ${page.stylesheetMediaFeature.screenExactHeightMiss.media}`);
    lines.push(`- Media-feature exact-height miss stylesheet fetch calls: ${page.stylesheetMediaFeature.screenExactHeightMiss.fetchCalls}`);
    lines.push(
      `- Media-feature exact-height miss stylesheet external resources: ${page.stylesheetMediaFeature.screenExactHeightMiss.discoveredResources} discovered, ${page.stylesheetMediaFeature.screenExactHeightMiss.loadedResources} loaded, ${page.stylesheetMediaFeature.screenExactHeightMiss.missingResources} missing`,
    );
    lines.push(`- Media-feature exact-height miss stylesheet loaded bytes: ${page.stylesheetMediaFeature.screenExactHeightMiss.loadedBytes}`);
    lines.push(`- Media-feature exact-height miss stylesheet author stylesheets: ${page.stylesheetMediaFeature.screenExactHeightMiss.authorStylesheetCount}`);
    lines.push(`- Media-feature exact-height miss stylesheet author rules: ${page.stylesheetMediaFeature.screenExactHeightMiss.authorRuleCount}`);
    lines.push(`- Media-feature exact-height miss stylesheet author declarations: ${page.stylesheetMediaFeature.screenExactHeightMiss.authorDeclarationCount}`);
    lines.push(`- Media-feature exact-height miss stylesheet painted background: ${page.stylesheetMediaFeature.screenExactHeightMiss.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Media-feature negated matching stylesheet media: ${page.stylesheetMediaFeature.negatedMatchingFeature.media}`);
    lines.push(`- Media-feature negated matching stylesheet fetch calls: ${page.stylesheetMediaFeature.negatedMatchingFeature.fetchCalls}`);
    lines.push(
      `- Media-feature negated matching stylesheet external resources: ${page.stylesheetMediaFeature.negatedMatchingFeature.discoveredResources} discovered, ${page.stylesheetMediaFeature.negatedMatchingFeature.loadedResources} loaded, ${page.stylesheetMediaFeature.negatedMatchingFeature.missingResources} missing`,
    );
    lines.push(`- Media-feature negated matching stylesheet loaded bytes: ${page.stylesheetMediaFeature.negatedMatchingFeature.loadedBytes}`);
    lines.push(`- Media-feature negated matching stylesheet author stylesheets: ${page.stylesheetMediaFeature.negatedMatchingFeature.authorStylesheetCount}`);
    lines.push(`- Media-feature negated matching stylesheet author rules: ${page.stylesheetMediaFeature.negatedMatchingFeature.authorRuleCount}`);
    lines.push(`- Media-feature negated matching stylesheet author declarations: ${page.stylesheetMediaFeature.negatedMatchingFeature.authorDeclarationCount}`);
    lines.push(`- Media-feature negated matching stylesheet painted background: ${page.stylesheetMediaFeature.negatedMatchingFeature.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Media-feature negated missing stylesheet media: ${page.stylesheetMediaFeature.negatedMissingFeature.media}`);
    lines.push(`- Media-feature negated missing stylesheet fetch calls: ${page.stylesheetMediaFeature.negatedMissingFeature.fetchCalls}`);
    lines.push(
      `- Media-feature negated missing stylesheet external resources: ${page.stylesheetMediaFeature.negatedMissingFeature.discoveredResources} discovered, ${page.stylesheetMediaFeature.negatedMissingFeature.loadedResources} loaded, ${page.stylesheetMediaFeature.negatedMissingFeature.missingResources} missing`,
    );
    lines.push(`- Media-feature negated missing stylesheet loaded bytes: ${page.stylesheetMediaFeature.negatedMissingFeature.loadedBytes}`);
    lines.push(`- Media-feature negated missing stylesheet author stylesheets: ${page.stylesheetMediaFeature.negatedMissingFeature.authorStylesheetCount}`);
    lines.push(`- Media-feature negated missing stylesheet author rules: ${page.stylesheetMediaFeature.negatedMissingFeature.authorRuleCount}`);
    lines.push(`- Media-feature negated missing stylesheet author declarations: ${page.stylesheetMediaFeature.negatedMissingFeature.authorDeclarationCount}`);
    lines.push(`- Media-feature negated missing stylesheet painted background: ${page.stylesheetMediaFeature.negatedMissingFeature.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Orientation landscape stylesheet media: ${page.stylesheetOrientationMedia.landscape.media}`);
    lines.push(`- Orientation landscape stylesheet fetch calls: ${page.stylesheetOrientationMedia.landscape.fetchCalls}`);
    lines.push(
      `- Orientation landscape stylesheet external resources: ${page.stylesheetOrientationMedia.landscape.discoveredResources} discovered, ${page.stylesheetOrientationMedia.landscape.loadedResources} loaded, ${page.stylesheetOrientationMedia.landscape.missingResources} missing`,
    );
    lines.push(`- Orientation landscape stylesheet loaded bytes: ${page.stylesheetOrientationMedia.landscape.loadedBytes}`);
    lines.push(`- Orientation landscape stylesheet author stylesheets: ${page.stylesheetOrientationMedia.landscape.authorStylesheetCount}`);
    lines.push(`- Orientation landscape stylesheet author rules: ${page.stylesheetOrientationMedia.landscape.authorRuleCount}`);
    lines.push(`- Orientation landscape stylesheet author declarations: ${page.stylesheetOrientationMedia.landscape.authorDeclarationCount}`);
    lines.push(`- Orientation landscape stylesheet painted background: ${page.stylesheetOrientationMedia.landscape.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Uppercase orientation landscape stylesheet media: ${page.stylesheetOrientationMedia.uppercaseLandscape.media}`);
    lines.push(`- Uppercase orientation landscape stylesheet fetch calls: ${page.stylesheetOrientationMedia.uppercaseLandscape.fetchCalls}`);
    lines.push(
      `- Uppercase orientation landscape stylesheet external resources: ${page.stylesheetOrientationMedia.uppercaseLandscape.discoveredResources} discovered, ${page.stylesheetOrientationMedia.uppercaseLandscape.loadedResources} loaded, ${page.stylesheetOrientationMedia.uppercaseLandscape.missingResources} missing`,
    );
    lines.push(`- Uppercase orientation landscape stylesheet loaded bytes: ${page.stylesheetOrientationMedia.uppercaseLandscape.loadedBytes}`);
    lines.push(`- Uppercase orientation landscape stylesheet author stylesheets: ${page.stylesheetOrientationMedia.uppercaseLandscape.authorStylesheetCount}`);
    lines.push(`- Uppercase orientation landscape stylesheet author rules: ${page.stylesheetOrientationMedia.uppercaseLandscape.authorRuleCount}`);
    lines.push(`- Uppercase orientation landscape stylesheet author declarations: ${page.stylesheetOrientationMedia.uppercaseLandscape.authorDeclarationCount}`);
    lines.push(`- Uppercase orientation landscape stylesheet painted background: ${page.stylesheetOrientationMedia.uppercaseLandscape.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Orientation portrait stylesheet media: ${page.stylesheetOrientationMedia.portrait.media}`);
    lines.push(`- Orientation portrait stylesheet fetch calls: ${page.stylesheetOrientationMedia.portrait.fetchCalls}`);
    lines.push(
      `- Orientation portrait stylesheet external resources: ${page.stylesheetOrientationMedia.portrait.discoveredResources} discovered, ${page.stylesheetOrientationMedia.portrait.loadedResources} loaded, ${page.stylesheetOrientationMedia.portrait.missingResources} missing`,
    );
    lines.push(`- Orientation portrait stylesheet loaded bytes: ${page.stylesheetOrientationMedia.portrait.loadedBytes}`);
    lines.push(`- Orientation portrait stylesheet author stylesheets: ${page.stylesheetOrientationMedia.portrait.authorStylesheetCount}`);
    lines.push(`- Orientation portrait stylesheet author rules: ${page.stylesheetOrientationMedia.portrait.authorRuleCount}`);
    lines.push(`- Orientation portrait stylesheet author declarations: ${page.stylesheetOrientationMedia.portrait.authorDeclarationCount}`);
    lines.push(`- Orientation portrait stylesheet painted background: ${page.stylesheetOrientationMedia.portrait.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Uppercase orientation portrait stylesheet media: ${page.stylesheetOrientationMedia.uppercasePortrait.media}`);
    lines.push(`- Uppercase orientation portrait stylesheet fetch calls: ${page.stylesheetOrientationMedia.uppercasePortrait.fetchCalls}`);
    lines.push(
      `- Uppercase orientation portrait stylesheet external resources: ${page.stylesheetOrientationMedia.uppercasePortrait.discoveredResources} discovered, ${page.stylesheetOrientationMedia.uppercasePortrait.loadedResources} loaded, ${page.stylesheetOrientationMedia.uppercasePortrait.missingResources} missing`,
    );
    lines.push(`- Uppercase orientation portrait stylesheet loaded bytes: ${page.stylesheetOrientationMedia.uppercasePortrait.loadedBytes}`);
    lines.push(`- Uppercase orientation portrait stylesheet author stylesheets: ${page.stylesheetOrientationMedia.uppercasePortrait.authorStylesheetCount}`);
    lines.push(`- Uppercase orientation portrait stylesheet author rules: ${page.stylesheetOrientationMedia.uppercasePortrait.authorRuleCount}`);
    lines.push(`- Uppercase orientation portrait stylesheet author declarations: ${page.stylesheetOrientationMedia.uppercasePortrait.authorDeclarationCount}`);
    lines.push(`- Uppercase orientation portrait stylesheet painted background: ${page.stylesheetOrientationMedia.uppercasePortrait.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Combined media-feature stylesheet media: ${page.stylesheetCombinedMediaFeature.matching.media}`);
    lines.push(`- Combined media-feature stylesheet fetch calls: ${page.stylesheetCombinedMediaFeature.matching.fetchCalls}`);
    lines.push(
      `- Combined media-feature stylesheet external resources: ${page.stylesheetCombinedMediaFeature.matching.discoveredResources} discovered, ${page.stylesheetCombinedMediaFeature.matching.loadedResources} loaded, ${page.stylesheetCombinedMediaFeature.matching.missingResources} missing`,
    );
    lines.push(`- Combined media-feature stylesheet loaded bytes: ${page.stylesheetCombinedMediaFeature.matching.loadedBytes}`);
    lines.push(`- Combined media-feature stylesheet author stylesheets: ${page.stylesheetCombinedMediaFeature.matching.authorStylesheetCount}`);
    lines.push(`- Combined media-feature stylesheet author rules: ${page.stylesheetCombinedMediaFeature.matching.authorRuleCount}`);
    lines.push(`- Combined media-feature stylesheet author declarations: ${page.stylesheetCombinedMediaFeature.matching.authorDeclarationCount}`);
    lines.push(`- Combined media-feature stylesheet painted background: ${page.stylesheetCombinedMediaFeature.matching.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Combined media-feature miss stylesheet media: ${page.stylesheetCombinedMediaFeature.laterMiss.media}`);
    lines.push(`- Combined media-feature miss stylesheet fetch calls: ${page.stylesheetCombinedMediaFeature.laterMiss.fetchCalls}`);
    lines.push(
      `- Combined media-feature miss stylesheet external resources: ${page.stylesheetCombinedMediaFeature.laterMiss.discoveredResources} discovered, ${page.stylesheetCombinedMediaFeature.laterMiss.loadedResources} loaded, ${page.stylesheetCombinedMediaFeature.laterMiss.missingResources} missing`,
    );
    lines.push(`- Combined media-feature miss stylesheet loaded bytes: ${page.stylesheetCombinedMediaFeature.laterMiss.loadedBytes}`);
    lines.push(`- Combined media-feature miss stylesheet author stylesheets: ${page.stylesheetCombinedMediaFeature.laterMiss.authorStylesheetCount}`);
    lines.push(`- Combined media-feature miss stylesheet author rules: ${page.stylesheetCombinedMediaFeature.laterMiss.authorRuleCount}`);
    lines.push(`- Combined media-feature miss stylesheet author declarations: ${page.stylesheetCombinedMediaFeature.laterMiss.authorDeclarationCount}`);
    lines.push(`- Combined media-feature miss stylesheet painted background: ${page.stylesheetCombinedMediaFeature.laterMiss.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Invalid-external-stylesheet URL: ${page.invalidExternalStylesheet.url}`);
    lines.push(
      `- Invalid-external-stylesheet resources: ${page.invalidExternalStylesheet.discoveredResources} discovered, ${page.invalidExternalStylesheet.loadedResources} loaded, ${page.invalidExternalStylesheet.missingResources} missing`,
    );
    lines.push(`- Invalid-external-stylesheet loaded bytes: ${page.invalidExternalStylesheet.loadedBytes}`);
    lines.push(`- Invalid-external-stylesheet stylesheets: ${page.invalidExternalStylesheet.stylesheetCount}`);
    lines.push(`- Invalid-external-stylesheet author stylesheets: ${page.invalidExternalStylesheet.authorStylesheetCount}`);
    lines.push(`- Invalid-external-stylesheet author rules: ${page.invalidExternalStylesheet.authorRuleCount}`);
    lines.push(`- Invalid-external-stylesheet author declarations: ${page.invalidExternalStylesheet.authorDeclarationCount}`);
    lines.push(`- Invalid-external-stylesheet decoded images: ${page.invalidExternalStylesheet.decodedImageCount}`);
    lines.push(`- Invalid-external-stylesheet painted background: ${page.invalidExternalStylesheet.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Invalid-external-stylesheet paint ops: ${page.invalidExternalStylesheet.paintOps.join(", ") || "—"}`);
    lines.push(`- Missing-stylesheet-only URL: ${page.missingStylesheet.url}`);
    lines.push(
      `- Missing-stylesheet-only resources: ${page.missingStylesheet.discoveredResources} discovered, ${page.missingStylesheet.loadedResources} loaded, ${page.missingStylesheet.missingResources} missing`,
    );
    lines.push(`- Missing-stylesheet-only stylesheets: ${page.missingStylesheet.stylesheetCount}`);
    lines.push(`- Missing-stylesheet-only author stylesheets: ${page.missingStylesheet.authorStylesheetCount}`);
    lines.push(`- Missing-stylesheet-only author rules: ${page.missingStylesheet.authorRuleCount}`);
    lines.push(`- Missing-stylesheet-only author declarations: ${page.missingStylesheet.authorDeclarationCount}`);
    lines.push(`- Missing-stylesheet-only painted background: ${page.missingStylesheet.paintedBackground ? "yes" : "no"}`);
    lines.push(`- Missing-stylesheet-only paint ops: ${page.missingStylesheet.paintOps.join(", ") || "—"}`);
    lines.push("");
    lines.push("## Real-site smoke evidence");
    lines.push("");
    const smoke = e.realSiteSmoke;
    lines.push(`- Smoke scenarios: ${smoke.scenarioCount}`);
    lines.push(`- Smoke outcomes: ${smoke.passed} passed, ${smoke.failed} failed`);
    lines.push(`- Covered capabilities: ${smoke.coveredCapabilities.join(", ") || "—"}`);
    lines.push("");
    lines.push("| Scenario | Capabilities | Result |");
    lines.push("|---|---|---|");
    for (const scenario of smoke.scenarios) {
      lines.push(`| ${scenario.id} | ${scenario.capabilities.join(", ") || "—"} | ${scenario.passed ? "PASS" : "FAIL"} |`);
    }
  }
  lines.push("");

  // ---- Per-dimension explanations ----------------------------------------
  lines.push("## Dimension details");
  lines.push("");
  for (const d of dimensions) {
    lines.push(`### ${d.label} — ${badge(d.verdict)}`);
    lines.push("");
    lines.push(`- Ours (live): ${d.ourDisplay}`);
    lines.push(`- Chromium (cited): ${competitorCell(d.competitor)}`);
    lines.push(`- ${d.rationale}`);
    lines.push("");
  }

  // ---- Citations ---------------------------------------------------------
  lines.push("## Citations");
  lines.push("");
  lines.push(
    "Every competitor figure below is a cited reference snapshot, not a benchmark re-run by this project.",
  );
  lines.push("");
  for (const c of COMPETITORS) {
    if (c.confidence === "needs-source") {
      lines.push(
        `- **${c.engine} — ${c.metric}**: _needs-source_ — ${c.methodology}`,
      );
    } else {
      lines.push(
        `- **${c.engine} — ${c.metric}**: ${c.value === null ? "—" : c.value.toLocaleString("en-US")} ${c.unit} ` +
          `— [${c.sourceName}](${c.sourceUrl}), as of ${c.asOf} (confidence: ${c.confidence}). ${c.methodology}`,
      );
    }
  }
  lines.push("");

  // ---- Honesty statement -------------------------------------------------
  lines.push("## Honesty statement");
  lines.push("");
  lines.push(
    "- Our metrics are computed live from the repository source; anyone can reproduce them with `npm run benchmark`.",
  );
  lines.push(
    "- Chromium's metrics are cited public / third-party figures. We did **not** re-run any Chromium benchmark; doing so would require its full source and a controlled environment.",
  );
  lines.push(
    "- We do **not** fabricate our own runtime-performance numbers: with no co-located Chromium run and native libraries (HarfBuzz/FreeType) not yet integrated, that dimension is marked **NOT-COMPARABLE**.",
  );
  lines.push(
    "- We win the dimensions that are structurally ours (compat-per-LOC, mechanism-density, hand-written readability) and honestly concede the dimensions that are Chromium's (raw breadth, shipping performance). Showing the gaps is what makes the wins credible.",
  );
  lines.push("");

  return lines.join("\n");
}
