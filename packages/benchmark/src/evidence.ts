/**
 * Live execution evidence for the public benchmark report.
 *
 * The markdown report stays deterministic, so this module keeps only stable
 * counts from maintained WPT subset traces. Wall-clock timings remain available
 * in `wpt --trace` / `wpt-subsets --trace`, but are intentionally not embedded
 * in `BENCHMARK.md`.
 */
import {
  FineSession,
  PHASE3_SMOKE_TESTS,
  createStageTraceCollector,
  defaultWptSubsetDir,
  renderUrlToPng,
  runScript,
  runWptSubsetManifestDir,
  type FetchFn,
  type ResourceTrace,
  type SmokeTest,
  type StageTrace,
  type StageTraceEvent,
} from "@browser-engine/cli";
import type { NodeId } from "@browser-engine/ir";
import { decodePng, encodePng } from "@browser-engine/test-harness";

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

/** Stable query-count evidence for one traced operation. */
export interface StableTraceCounts {
  readonly queryCalls: number;
  readonly recomputes: number;
  readonly cacheHits: number;
  readonly verifiedCacheHits: number;
  readonly dependencyReads: number;
  readonly tracedStages: readonly string[];
}

/** Stable evidence for one deterministic incremental edit step. */
export interface IncrementalEditStepEvidence extends StableTraceCounts {
  readonly name: "prime" | "paint-only-edit" | "layout-affecting-edit" | "no-mutation-render";
}

/** Deterministic fine-session evidence for cross-revision incremental reuse. */
export interface IncrementalEditEvidence extends StableTraceCounts {
  readonly scenario: string;
  readonly documentNodes: number;
  readonly editedNode: string;
  readonly paintOnlyReusedLayout: boolean;
  readonly layoutEditRecomputedLayout: boolean;
  readonly noMutationRecomputes: number;
  readonly steps: readonly IncrementalEditStepEvidence[];
}

/** Stable evidence for one deterministic script-driven DOM edit step. */
export interface ScriptDrivenEditStepEvidence extends StableTraceCounts {
  readonly name: "prime" | "script-paint-only" | "script-layout-edit" | "script-append-child";
  readonly mutations: number;
}

/** Deterministic evidence that real JS DOM APIs feed the incremental graph. */
export interface ScriptDrivenEditEvidence extends StableTraceCounts {
  readonly scenario: string;
  readonly initialDocumentNodes: number;
  readonly finalDocumentNodes: number;
  readonly scriptMutations: number;
  readonly paintOnlyReusedLayout: boolean;
  readonly layoutEditRecomputedLayout: boolean;
  readonly appendChildIncreasedNodes: boolean;
  readonly appendedNodePainted: boolean;
  readonly steps: readonly ScriptDrivenEditStepEvidence[];
}

/** Deterministic evidence for URL/resource-loaded page rendering. */
export interface MissingImageResourceEvidence {
  readonly url: string;
  readonly discoveredResources: number;
  readonly loadedResources: number;
  readonly missingResources: number;
  readonly loadedBytes: number;
  readonly decodedImageCount: number;
  readonly paintedImage: boolean;
  readonly displayCommands: number;
  readonly paintOps: readonly string[];
  readonly pngBytes: number;
}

/** Deterministic evidence that loaded-but-invalid image bytes do not fake paint. */
export interface InvalidImageResourceEvidence {
  readonly url: string;
  readonly discoveredResources: number;
  readonly loadedResources: number;
  readonly missingResources: number;
  readonly loadedBytes: number;
  readonly decodedImageCount: number;
  readonly paintedImage: boolean;
  readonly displayCommands: number;
  readonly paintOps: readonly string[];
  readonly pngBytes: number;
}

/** Deterministic evidence that duplicate external URLs are fetched once and reused. */
export interface DuplicateResourceCacheEvidence {
  readonly url: string;
  readonly fetchCalls: number;
  readonly sharedResourceFetches: number;
  readonly discoveredResources: number;
  readonly loadedResources: number;
  readonly missingResources: number;
  readonly loadedBytes: number;
  readonly decodedImageCount: number;
  readonly paintedImageCount: number;
  readonly displayCommands: number;
  readonly paintOps: readonly string[];
  readonly pngBytes: number;
}

/** Deterministic evidence that duplicate stylesheet URLs share bytes without losing cascade slots. */
export interface DuplicateStylesheetUrlCacheEvidence {
  readonly url: string;
  readonly fetchCalls: number;
  readonly sharedStylesheetFetches: number;
  readonly discoveredResources: number;
  readonly loadedResources: number;
  readonly missingResources: number;
  readonly loadedBytes: number;
  readonly stylesheetCount: number;
  readonly authorStylesheetCount: number;
  readonly authorRuleCount: number;
  readonly authorDeclarationCount: number;
  readonly decodedImageCount: number;
  readonly paintedBackground: boolean;
  readonly duplicateLinkWonSourceOrder: boolean;
  readonly displayCommands: number;
  readonly paintOps: readonly string[];
  readonly pngBytes: number;
}

/** Deterministic evidence that data: resources bypass network but still render. */
export interface DataUrlNoNetworkResourceEvidence {
  readonly url: string;
  readonly fetchCalls: number;
  readonly discoveredResources: number;
  readonly loadedResources: number;
  readonly missingResources: number;
  readonly loadedBytes: number;
  readonly stylesheetCount: number;
  readonly decodedImageCount: number;
  readonly paintedImageCount: number;
  readonly paintedBackground: boolean;
  readonly displayCommands: number;
  readonly paintOps: readonly string[];
  readonly pngBytes: number;
}

/** One data:text/css charset metadata case. */
export interface DataUrlStylesheetCharsetCaseEvidence {
  readonly url: string;
  readonly metadata: string;
  readonly fetchCalls: number;
  readonly dataUrlFetchCalls: number;
  readonly discoveredResources: number;
  readonly loadedResources: number;
  readonly missingResources: number;
  readonly loadedBytes: number;
  readonly stylesheetCount: number;
  readonly authorStylesheetCount: number;
  readonly authorRuleCount: number;
  readonly authorDeclarationCount: number;
  readonly decodedImageCount: number;
  readonly paintedBackground: boolean;
  readonly displayCommands: number;
  readonly paintOps: readonly string[];
  readonly pngBytes: number;
}

/** Deterministic evidence for supported and unsupported data:text/css charset metadata. */
export interface DataUrlStylesheetCharsetEvidence {
  readonly percentUtf8: DataUrlStylesheetCharsetCaseEvidence;
  readonly base64Utf8: DataUrlStylesheetCharsetCaseEvidence;
  readonly unsupportedCharset: DataUrlStylesheetCharsetCaseEvidence;
}

/** One direction of data:text/css/external stylesheet source-order evidence. */
export interface DataUrlStylesheetSourceOrderCaseEvidence {
  readonly url: string;
  readonly externalStylesheetUrl: string;
  readonly fetchCalls: number;
  readonly dataUrlFetchCalls: number;
  readonly externalStylesheetFetches: number;
  readonly discoveredResources: number;
  readonly loadedResources: number;
  readonly missingResources: number;
  readonly loadedBytes: number;
  readonly stylesheetCount: number;
  readonly authorStylesheetCount: number;
  readonly authorRuleCount: number;
  readonly authorDeclarationCount: number;
  readonly decodedImageCount: number;
  readonly paintedBackground: boolean;
  readonly sourceOrderWinnerBlue: boolean;
  readonly displayCommands: number;
  readonly paintOps: readonly string[];
  readonly pngBytes: number;
}

/** Deterministic evidence that data:text/css links share author source order with external CSS. */
export interface DataUrlStylesheetSourceOrderEvidence {
  readonly externalAfterDataUrl: DataUrlStylesheetSourceOrderCaseEvidence;
  readonly dataUrlAfterExternal: DataUrlStylesheetSourceOrderCaseEvidence;
}

/** One direction of external stylesheet/inline style source-order evidence. */
export interface ExternalInlineStylesheetSourceOrderCaseEvidence {
  readonly url: string;
  readonly externalStylesheetUrl: string;
  readonly fetchCalls: number;
  readonly externalStylesheetFetches: number;
  readonly discoveredResources: number;
  readonly loadedResources: number;
  readonly missingResources: number;
  readonly loadedBytes: number;
  readonly stylesheetCount: number;
  readonly authorStylesheetCount: number;
  readonly authorRuleCount: number;
  readonly authorDeclarationCount: number;
  readonly decodedImageCount: number;
  readonly paintedBackground: boolean;
  readonly sourceOrderWinnerBlue: boolean;
  readonly displayCommands: number;
  readonly paintOps: readonly string[];
  readonly pngBytes: number;
}

/** Deterministic evidence that external links and inline style blocks share author source order. */
export interface ExternalInlineStylesheetSourceOrderEvidence {
  readonly inlineAfterExternal: ExternalInlineStylesheetSourceOrderCaseEvidence;
  readonly externalAfterInline: ExternalInlineStylesheetSourceOrderCaseEvidence;
}

/** Deterministic evidence that invalid data:image bytes do not fake network or paint. */
export interface InvalidDataImageResourceEvidence {
  readonly url: string;
  readonly fetchCalls: number;
  readonly discoveredResources: number;
  readonly loadedResources: number;
  readonly missingResources: number;
  readonly loadedBytes: number;
  readonly decodedImageCount: number;
  readonly paintedImageCount: number;
  readonly paintedBackground: boolean;
  readonly displayCommands: number;
  readonly paintOps: readonly string[];
  readonly pngBytes: number;
}

/** Deterministic evidence that invalid data:text/css bytes do not fake author rules. */
export interface InvalidDataStylesheetResourceEvidence {
  readonly url: string;
  readonly fetchCalls: number;
  readonly discoveredResources: number;
  readonly loadedResources: number;
  readonly missingResources: number;
  readonly loadedBytes: number;
  readonly stylesheetCount: number;
  readonly authorStylesheetCount: number;
  readonly authorRuleCount: number;
  readonly authorDeclarationCount: number;
  readonly decodedImageCount: number;
  readonly paintedBackground: boolean;
  readonly displayCommands: number;
  readonly paintOps: readonly string[];
  readonly pngBytes: number;
}

/** Deterministic evidence that non-CSS data stylesheet URLs do not enter CSS. */
export interface NonCssDataStylesheetResourceEvidence {
  readonly url: string;
  readonly fetchCalls: number;
  readonly discoveredResources: number;
  readonly loadedResources: number;
  readonly missingResources: number;
  readonly loadedBytes: number;
  readonly stylesheetCount: number;
  readonly authorStylesheetCount: number;
  readonly authorRuleCount: number;
  readonly authorDeclarationCount: number;
  readonly decodedImageCount: number;
  readonly paintedBackground: boolean;
  readonly displayCommands: number;
  readonly paintOps: readonly string[];
  readonly pngBytes: number;
}

/** Deterministic evidence that stylesheet links without href create no resource or fake sheet. */
export interface NoHrefStylesheetResourceEvidence {
  readonly url: string;
  readonly fetchCalls: number;
  readonly discoveredResources: number;
  readonly loadedResources: number;
  readonly missingResources: number;
  readonly loadedBytes: number;
  readonly stylesheetCount: number;
  readonly authorStylesheetCount: number;
  readonly authorRuleCount: number;
  readonly authorDeclarationCount: number;
  readonly decodedImageCount: number;
  readonly paintedBackground: boolean;
  readonly displayCommands: number;
  readonly paintOps: readonly string[];
  readonly pngBytes: number;
}

/** Deterministic evidence that empty stylesheet hrefs resolve to the document URL without fake CSS. */
export interface EmptyHrefStylesheetResourceEvidence {
  readonly url: string;
  readonly fetchCalls: number;
  readonly discoveredResources: number;
  readonly loadedResources: number;
  readonly missingResources: number;
  readonly loadedBytes: number;
  readonly stylesheetCount: number;
  readonly authorStylesheetCount: number;
  readonly authorRuleCount: number;
  readonly authorDeclarationCount: number;
  readonly decodedImageCount: number;
  readonly paintedBackground: boolean;
  readonly displayCommands: number;
  readonly paintOps: readonly string[];
  readonly pngBytes: number;
}

/** Deterministic evidence that fragment-only stylesheet hrefs preserve fragments without fake CSS. */
export interface FragmentHrefStylesheetResourceEvidence {
  readonly url: string;
  readonly fetchCalls: number;
  readonly discoveredResources: number;
  readonly loadedResources: number;
  readonly missingResources: number;
  readonly loadedBytes: number;
  readonly stylesheetCount: number;
  readonly authorStylesheetCount: number;
  readonly authorRuleCount: number;
  readonly authorDeclarationCount: number;
  readonly decodedImageCount: number;
  readonly paintedBackground: boolean;
  readonly displayCommands: number;
  readonly paintOps: readonly string[];
  readonly pngBytes: number;
}

/** Deterministic evidence that query-only stylesheet hrefs replace the query without fake CSS. */
export interface QueryHrefStylesheetResourceEvidence {
  readonly url: string;
  readonly fetchCalls: number;
  readonly discoveredResources: number;
  readonly loadedResources: number;
  readonly missingResources: number;
  readonly loadedBytes: number;
  readonly stylesheetCount: number;
  readonly authorStylesheetCount: number;
  readonly authorRuleCount: number;
  readonly authorDeclarationCount: number;
  readonly decodedImageCount: number;
  readonly paintedBackground: boolean;
  readonly displayCommands: number;
  readonly paintOps: readonly string[];
  readonly pngBytes: number;
}

/** Deterministic evidence that protocol-relative stylesheet hrefs inherit the document scheme. */
export interface ProtocolRelativeStylesheetResourceEvidence {
  readonly url: string;
  readonly fetchCalls: number;
  readonly discoveredResources: number;
  readonly loadedResources: number;
  readonly missingResources: number;
  readonly loadedBytes: number;
  readonly stylesheetCount: number;
  readonly authorStylesheetCount: number;
  readonly authorRuleCount: number;
  readonly authorDeclarationCount: number;
  readonly decodedImageCount: number;
  readonly paintedBackground: boolean;
  readonly displayCommands: number;
  readonly paintOps: readonly string[];
  readonly pngBytes: number;
}

/** Deterministic evidence that stylesheet rel tokens survive ASCII whitespace boundaries. */
export interface WhitespaceRelStylesheetResourceEvidence {
  readonly url: string;
  readonly fetchCalls: number;
  readonly discoveredResources: number;
  readonly loadedResources: number;
  readonly missingResources: number;
  readonly loadedBytes: number;
  readonly stylesheetCount: number;
  readonly authorStylesheetCount: number;
  readonly authorRuleCount: number;
  readonly authorDeclarationCount: number;
  readonly decodedImageCount: number;
  readonly paintedBackground: boolean;
  readonly sourceOrderWinnerBlue: boolean;
  readonly alternateFetchCalls: number;
  readonly alternateDiscoveredResources: number;
  readonly alternateLoadedResources: number;
  readonly alternateAuthorStylesheetCount: number;
  readonly alternatePaintedBackground: boolean;
  readonly displayCommands: number;
  readonly paintOps: readonly string[];
  readonly pngBytes: number;
}

/** Deterministic evidence that duplicate stylesheet rel tokens are set-like. */
export interface DuplicateRelStylesheetResourceEvidence {
  readonly url: string;
  readonly fetchCalls: number;
  readonly discoveredResources: number;
  readonly loadedResources: number;
  readonly missingResources: number;
  readonly loadedBytes: number;
  readonly stylesheetCount: number;
  readonly authorStylesheetCount: number;
  readonly authorRuleCount: number;
  readonly authorDeclarationCount: number;
  readonly decodedImageCount: number;
  readonly paintedBackground: boolean;
  readonly sourceOrderWinnerBlue: boolean;
  readonly alternateFetchCalls: number;
  readonly alternateDiscoveredResources: number;
  readonly alternateLoadedResources: number;
  readonly alternateAuthorStylesheetCount: number;
  readonly alternatePaintedBackground: boolean;
  readonly displayCommands: number;
  readonly paintOps: readonly string[];
  readonly pngBytes: number;
}

/** Deterministic evidence that unresolvable stylesheet href URLs are skipped honestly. */
export interface InvalidUrlStylesheetResourceEvidence {
  readonly url: string;
  readonly fetchCalls: number;
  readonly discoveredResources: number;
  readonly loadedResources: number;
  readonly missingResources: number;
  readonly loadedBytes: number;
  readonly stylesheetCount: number;
  readonly authorStylesheetCount: number;
  readonly authorRuleCount: number;
  readonly authorDeclarationCount: number;
  readonly decodedImageCount: number;
  readonly paintedBackground: boolean;
  readonly sourceOrderWinnerBlue: boolean;
  readonly invalidOnlyFetchCalls: number;
  readonly invalidOnlyDiscoveredResources: number;
  readonly invalidOnlyLoadedResources: number;
  readonly invalidOnlyMissingResources: number;
  readonly invalidOnlyAuthorStylesheetCount: number;
  readonly invalidOnlyPaintedBackground: boolean;
  readonly displayCommands: number;
  readonly paintOps: readonly string[];
  readonly pngBytes: number;
}

/** Deterministic evidence that stylesheet href whitespace resolves through the URL parser. */
export interface WhitespaceHrefStylesheetResourceEvidence {
  readonly url: string;
  readonly rawHref: string;
  readonly resolvedHref: string;
  readonly loadedResourceUrl: string;
  readonly fetchCalls: number;
  readonly discoveredResources: number;
  readonly loadedResources: number;
  readonly missingResources: number;
  readonly loadedBytes: number;
  readonly stylesheetCount: number;
  readonly authorStylesheetCount: number;
  readonly authorRuleCount: number;
  readonly authorDeclarationCount: number;
  readonly decodedImageCount: number;
  readonly paintedBackground: boolean;
  readonly sourceOrderWinnerBlue: boolean;
  readonly displayCommands: number;
  readonly paintOps: readonly string[];
  readonly pngBytes: number;
}

/** Deterministic evidence that stylesheet href control characters resolve through the URL parser. */
export interface ControlCharacterHrefStylesheetResourceEvidence {
  readonly url: string;
  readonly rawHref: string;
  readonly rawHrefJson: string;
  readonly resolvedHref: string;
  readonly loadedResourceUrl: string;
  readonly fetchCalls: number;
  readonly discoveredResources: number;
  readonly loadedResources: number;
  readonly missingResources: number;
  readonly loadedBytes: number;
  readonly stylesheetCount: number;
  readonly authorStylesheetCount: number;
  readonly authorRuleCount: number;
  readonly authorDeclarationCount: number;
  readonly decodedImageCount: number;
  readonly paintedBackground: boolean;
  readonly sourceOrderWinnerBlue: boolean;
  readonly displayCommands: number;
  readonly paintOps: readonly string[];
  readonly pngBytes: number;
}

/** Deterministic evidence that the frozen first `<base href>` drives subresource URL resolution. */
export interface BaseHrefSubresourceEvidence {
  readonly url: string;
  readonly rawBaseHref: string;
  readonly resolvedBaseHref: string;
  readonly stylesheetHref: string;
  readonly imageSrc: string;
  readonly loadedStylesheetUrl: string;
  readonly loadedImageUrl: string;
  readonly fetchCalls: number;
  readonly stylesheetFetches: number;
  readonly imageFetches: number;
  readonly discoveredResources: number;
  readonly loadedResources: number;
  readonly missingResources: number;
  readonly loadedBytes: number;
  readonly stylesheetCount: number;
  readonly authorStylesheetCount: number;
  readonly authorRuleCount: number;
  readonly authorDeclarationCount: number;
  readonly decodedImageCount: number;
  readonly paintedBackground: boolean;
  readonly paintedImageCount: number;
  readonly displayCommands: number;
  readonly paintOps: readonly string[];
  readonly pngBytes: number;
  readonly paintedBackgroundRed: boolean;
  readonly paintedImageBlue: boolean;
}

/** Deterministic evidence that alternate stylesheet links are inactive by default. */
export interface AlternateStylesheetResourceEvidence {
  readonly url: string;
  readonly fetchCalls: number;
  readonly discoveredResources: number;
  readonly loadedResources: number;
  readonly missingResources: number;
  readonly loadedBytes: number;
  readonly stylesheetCount: number;
  readonly authorStylesheetCount: number;
  readonly authorRuleCount: number;
  readonly authorDeclarationCount: number;
  readonly decodedImageCount: number;
  readonly paintedBackground: boolean;
  readonly displayCommands: number;
  readonly paintOps: readonly string[];
  readonly pngBytes: number;
}

/** Deterministic evidence that disabled stylesheet links are inactive by default. */
export interface DisabledStylesheetResourceEvidence {
  readonly url: string;
  readonly fetchCalls: number;
  readonly discoveredResources: number;
  readonly loadedResources: number;
  readonly missingResources: number;
  readonly loadedBytes: number;
  readonly stylesheetCount: number;
  readonly authorStylesheetCount: number;
  readonly authorRuleCount: number;
  readonly authorDeclarationCount: number;
  readonly decodedImageCount: number;
  readonly paintedBackground: boolean;
  readonly displayCommands: number;
  readonly paintOps: readonly string[];
  readonly pngBytes: number;
}

/** Deterministic evidence that print media stylesheet links are inactive for screen rendering. */
export interface PrintMediaStylesheetResourceEvidence {
  readonly url: string;
  readonly fetchCalls: number;
  readonly discoveredResources: number;
  readonly loadedResources: number;
  readonly missingResources: number;
  readonly loadedBytes: number;
  readonly stylesheetCount: number;
  readonly authorStylesheetCount: number;
  readonly authorRuleCount: number;
  readonly authorDeclarationCount: number;
  readonly decodedImageCount: number;
  readonly paintedBackground: boolean;
  readonly displayCommands: number;
  readonly paintOps: readonly string[];
  readonly pngBytes: number;
}

/** Deterministic evidence for one stylesheet media decision. */
export interface StylesheetMediaCaseEvidence {
  readonly media: string;
  readonly url: string;
  readonly fetchCalls: number;
  readonly discoveredResources: number;
  readonly loadedResources: number;
  readonly missingResources: number;
  readonly loadedBytes: number;
  readonly stylesheetCount: number;
  readonly authorStylesheetCount: number;
  readonly authorRuleCount: number;
  readonly authorDeclarationCount: number;
  readonly decodedImageCount: number;
  readonly paintedBackground: boolean;
  readonly displayCommands: number;
  readonly paintOps: readonly string[];
  readonly pngBytes: number;
}

/** Deterministic evidence that stylesheet media attributes are evaluated as lists. */
export interface StylesheetMediaListResourceEvidence {
  readonly empty: StylesheetMediaCaseEvidence;
  readonly whitespaceOnly: StylesheetMediaCaseEvidence;
  readonly matchingList: StylesheetMediaCaseEvidence;
  readonly spacedMatchingList: StylesheetMediaCaseEvidence;
  readonly emptyItemBeforeScreen: StylesheetMediaCaseEvidence;
  readonly emptyItemAfterScreen: StylesheetMediaCaseEvidence;
  readonly emptyItemsOnly: StylesheetMediaCaseEvidence;
  readonly unsupportedThenScreen: StylesheetMediaCaseEvidence;
  readonly unsupportedOnly: StylesheetMediaCaseEvidence;
  readonly unknownTypeThenScreen: StylesheetMediaCaseEvidence;
  readonly unknownTypeOnly: StylesheetMediaCaseEvidence;
  readonly uppercaseScreen: StylesheetMediaCaseEvidence;
  readonly mixedCaseOnlyScreen: StylesheetMediaCaseEvidence;
  readonly spacedOnlyScreen: StylesheetMediaCaseEvidence;
  readonly uppercasePrint: StylesheetMediaCaseEvidence;
  readonly all: StylesheetMediaCaseEvidence;
  readonly onlyAll: StylesheetMediaCaseEvidence;
  readonly notAll: StylesheetMediaCaseEvidence;
  readonly spacedNotAll: StylesheetMediaCaseEvidence;
  readonly notPrint: StylesheetMediaCaseEvidence;
  readonly spacedNotPrint: StylesheetMediaCaseEvidence;
  readonly onlyPrint: StylesheetMediaCaseEvidence;
  readonly spacedOnlyPrint: StylesheetMediaCaseEvidence;
}

/** Deterministic evidence that simple stylesheet media features use the render viewport. */
export interface StylesheetMediaFeatureResourceEvidence {
  readonly screenMinWidth: StylesheetMediaCaseEvidence;
  readonly uppercaseScreenMinWidth: StylesheetMediaCaseEvidence;
  readonly decimalScreenMinWidth: StylesheetMediaCaseEvidence;
  readonly spacedScreenMinWidth: StylesheetMediaCaseEvidence;
  readonly bareMinWidth: StylesheetMediaCaseEvidence;
  readonly allMinWidth: StylesheetMediaCaseEvidence;
  readonly allMaxWidth: StylesheetMediaCaseEvidence;
  readonly onlyAllMinWidth: StylesheetMediaCaseEvidence;
  readonly unsupportedRangeWidth: StylesheetMediaCaseEvidence;
  readonly unsupportedRangeThenScreen: StylesheetMediaCaseEvidence;
  readonly unsupportedCalcMinWidth: StylesheetMediaCaseEvidence;
  readonly unsupportedHover: StylesheetMediaCaseEvidence;
  readonly invalidEmptyFeature: StylesheetMediaCaseEvidence;
  readonly unsupportedBooleanWidth: StylesheetMediaCaseEvidence;
  readonly unknownFeature: StylesheetMediaCaseEvidence;
  readonly invalidEmptyFeatureThenScreen: StylesheetMediaCaseEvidence;
  readonly screenMaxWidth: StylesheetMediaCaseEvidence;
  readonly decimalScreenMaxWidth: StylesheetMediaCaseEvidence;
  readonly spacedScreenMaxWidth: StylesheetMediaCaseEvidence;
  readonly screenMinHeight: StylesheetMediaCaseEvidence;
  readonly screenMaxHeight: StylesheetMediaCaseEvidence;
  readonly screenExactWidth: StylesheetMediaCaseEvidence;
  readonly decimalScreenExactWidth: StylesheetMediaCaseEvidence;
  readonly screenExactHeight: StylesheetMediaCaseEvidence;
  readonly screenExactHeightMiss: StylesheetMediaCaseEvidence;
  readonly negatedMatchingFeature: StylesheetMediaCaseEvidence;
  readonly negatedMissingFeature: StylesheetMediaCaseEvidence;
}

/** Deterministic evidence that orientation media features use the render viewport. */
export interface StylesheetOrientationMediaResourceEvidence {
  readonly landscape: StylesheetMediaCaseEvidence;
  readonly uppercaseLandscape: StylesheetMediaCaseEvidence;
  readonly portrait: StylesheetMediaCaseEvidence;
  readonly uppercasePortrait: StylesheetMediaCaseEvidence;
}

/** Deterministic evidence that combined media features require every feature to match. */
export interface StylesheetCombinedMediaFeatureResourceEvidence {
  readonly matching: StylesheetMediaCaseEvidence;
  readonly laterMiss: StylesheetMediaCaseEvidence;
}

/** Deterministic evidence that loaded invalid external CSS does not fake author rules. */
export interface InvalidExternalStylesheetResourceEvidence {
  readonly url: string;
  readonly discoveredResources: number;
  readonly loadedResources: number;
  readonly missingResources: number;
  readonly loadedBytes: number;
  readonly stylesheetCount: number;
  readonly authorStylesheetCount: number;
  readonly authorRuleCount: number;
  readonly authorDeclarationCount: number;
  readonly decodedImageCount: number;
  readonly paintedBackground: boolean;
  readonly displayCommands: number;
  readonly paintOps: readonly string[];
  readonly pngBytes: number;
}

/** Deterministic evidence that a missing stylesheet does not fake author rules. */
export interface MissingStylesheetResourceEvidence {
  readonly url: string;
  readonly discoveredResources: number;
  readonly loadedResources: number;
  readonly missingResources: number;
  readonly loadedBytes: number;
  readonly stylesheetCount: number;
  readonly authorStylesheetCount: number;
  readonly authorRuleCount: number;
  readonly authorDeclarationCount: number;
  readonly decodedImageCount: number;
  readonly paintedBackground: boolean;
  readonly displayCommands: number;
  readonly paintOps: readonly string[];
  readonly pngBytes: number;
}

/** Deterministic evidence for URL/resource-loaded page rendering. */
export interface ResourceLoadedPageEvidence {
  readonly url: string;
  readonly rootBytes: number;
  readonly discoveredResources: number;
  readonly loadedResources: number;
  readonly missingResources: number;
  readonly loadedBytes: number;
  readonly stylesheetCount: number;
  readonly decodedImageCount: number;
  readonly displayCommands: number;
  readonly paintOps: readonly string[];
  readonly width: number;
  readonly height: number;
  readonly pngBytes: number;
  readonly missingImage: MissingImageResourceEvidence;
  readonly invalidImage: InvalidImageResourceEvidence;
  readonly duplicateResource: DuplicateResourceCacheEvidence;
  readonly duplicateStylesheet: DuplicateStylesheetUrlCacheEvidence;
  readonly dataUrlNoNetwork: DataUrlNoNetworkResourceEvidence;
  readonly dataUrlStylesheetCharset: DataUrlStylesheetCharsetEvidence;
  readonly dataUrlStylesheetSourceOrder: DataUrlStylesheetSourceOrderEvidence;
  readonly externalInlineStylesheetSourceOrder: ExternalInlineStylesheetSourceOrderEvidence;
  readonly invalidDataImage: InvalidDataImageResourceEvidence;
  readonly invalidDataStylesheet: InvalidDataStylesheetResourceEvidence;
  readonly nonCssDataStylesheet: NonCssDataStylesheetResourceEvidence;
  readonly noHrefStylesheet: NoHrefStylesheetResourceEvidence;
  readonly emptyHrefStylesheet: EmptyHrefStylesheetResourceEvidence;
  readonly fragmentHrefStylesheet: FragmentHrefStylesheetResourceEvidence;
  readonly queryHrefStylesheet: QueryHrefStylesheetResourceEvidence;
  readonly protocolRelativeStylesheet: ProtocolRelativeStylesheetResourceEvidence;
  readonly whitespaceRelStylesheet: WhitespaceRelStylesheetResourceEvidence;
  readonly duplicateRelStylesheet: DuplicateRelStylesheetResourceEvidence;
  readonly whitespaceHrefStylesheet: WhitespaceHrefStylesheetResourceEvidence;
  readonly controlCharacterHrefStylesheet: ControlCharacterHrefStylesheetResourceEvidence;
  readonly baseHrefSubresource: BaseHrefSubresourceEvidence;
  readonly invalidUrlStylesheet: InvalidUrlStylesheetResourceEvidence;
  readonly alternateStylesheet: AlternateStylesheetResourceEvidence;
  readonly disabledStylesheet: DisabledStylesheetResourceEvidence;
  readonly printMediaStylesheet: PrintMediaStylesheetResourceEvidence;
  readonly stylesheetMediaList: StylesheetMediaListResourceEvidence;
  readonly stylesheetMediaFeature: StylesheetMediaFeatureResourceEvidence;
  readonly stylesheetOrientationMedia: StylesheetOrientationMediaResourceEvidence;
  readonly stylesheetCombinedMediaFeature: StylesheetCombinedMediaFeatureResourceEvidence;
  readonly invalidExternalStylesheet: InvalidExternalStylesheetResourceEvidence;
  readonly missingStylesheet: MissingStylesheetResourceEvidence;
}

/** Stable result for one representative real-site smoke scenario. */
export interface RealSiteSmokeScenarioEvidence {
  readonly id: string;
  readonly capabilities: readonly string[];
  readonly passed: boolean;
}

/** Deterministic evidence for the configured real-site smoke set. */
export interface RealSiteSmokeEvidence {
  readonly scenarioCount: number;
  readonly passed: number;
  readonly failed: number;
  readonly coveredCapabilities: readonly string[];
  readonly scenarios: readonly RealSiteSmokeScenarioEvidence[];
}

/** Stable trace evidence for the public benchmark report. */
export interface ExecutionEvidence {
  /** Maintained WPT subset trace, collected live. */
  readonly subsetCount: number;
  readonly files: number;
  readonly subtests: number;
  readonly passed: number;
  readonly failed: number;
  readonly errored: number;
  readonly queryCalls: number;
  readonly recomputes: number;
  readonly cacheHits: number;
  readonly verifiedCacheHits: number;
  readonly dependencyReads: number;
  readonly tracedStages: readonly string[];
  /** Deterministic edit-sequence trace proving cross-revision cache reuse. */
  readonly incrementalEdit: IncrementalEditEvidence;
  /** Deterministic real-JS DOM mutation trace proving script → incremental flow. */
  readonly scriptDrivenEdit: ScriptDrivenEditEvidence;
  /** Deterministic URL render with external CSS/image/missing-resource evidence. */
  readonly resourceLoadedPage: ResourceLoadedPageEvidence;
  /** Deterministic representative real-site smoke evidence. */
  readonly realSiteSmoke: RealSiteSmokeEvidence;
}

/** Run maintained WPT subsets with trace enabled and reduce them to stable counts. */
export async function collectExecutionEvidence(repoRoot: string): Promise<ExecutionEvidence> {
  const summary = await runWptSubsetManifestDir(defaultWptSubsetDir(repoRoot), {
    repoRoot,
    trace: true,
  });
  let files = 0;
  let subtests = 0;
  let passed = 0;
  let failed = 0;
  let errored = 0;
  let queryCalls = 0;
  let recomputes = 0;
  let cacheHits = 0;
  let verifiedCacheHits = 0;
  let dependencyReads = 0;
  const stages = new Set<string>();

  for (const run of summary.runs) {
    files += run.report.files;
    subtests += run.report.subtests;
    passed += run.report.passed;
    failed += run.report.failed;
    errored += run.report.errored;
    const trace: StageTrace | undefined = run.report.trace;
    if (trace === undefined) continue;
    const counts = stableCounts(trace.events);
    queryCalls += counts.queryCalls;
    recomputes += counts.recomputes;
    cacheHits += counts.cacheHits;
    verifiedCacheHits += counts.verifiedCacheHits;
    dependencyReads += counts.dependencyReads;
    for (const stage of counts.tracedStages) stages.add(stage);
  }

  return {
    subsetCount: summary.runs.length,
    files,
    subtests,
    passed,
    failed,
    errored,
    queryCalls,
    recomputes,
    cacheHits,
    verifiedCacheHits,
    dependencyReads,
    tracedStages: Object.freeze([...stages].sort()),
    incrementalEdit: collectIncrementalEditEvidence(),
    scriptDrivenEdit: collectScriptDrivenEditEvidence(),
    resourceLoadedPage: await collectResourceLoadedPageEvidence(),
    realSiteSmoke: await collectRealSiteSmokeEvidence(),
  };
}

const INCREMENTAL_EDIT_SIZE = 40;
const INCREMENTAL_EDIT_TARGET_ID = "n20";

function incrementalEditHtml(): string {
  const items = Array.from(
    { length: INCREMENTAL_EDIT_SIZE },
    (_, i) => `<div id="n${i}" class="box">x</div>`,
  ).join("");
  return (
    "<html><head><style>" +
    ".box { width: 6px; height: 6px; background-color: red }" +
    ".blue { background-color: blue }" +
    ".wide { width: 12px !important }" +
    "</style></head>" +
    `<body>${items}</body></html>`
  );
}

/** Run a fixed edit sequence and reduce it to deterministic trace counts. */
export function collectIncrementalEditEvidence(): IncrementalEditEvidence {
  const collector = createStageTraceCollector();
  const session = new FineSession(incrementalEditHtml(), "benchmark://incremental-edit", {
    onQuery: collector.onQuery,
  });
  const target = nodeById(session, INCREMENTAL_EDIT_TARGET_ID);
  let cursor = 0;
  let layoutBeforePaint: ReturnType<FineSession["layoutTree"]> | undefined;
  let layoutAfterPaint: ReturnType<FineSession["layoutTree"]> | undefined;
  let paintOnlyReusedLayout = false;
  let layoutEditRecomputedLayout = false;
  let noMutationRecomputes = 0;

  const checkpoint = (
    name: IncrementalEditStepEvidence["name"],
    run: () => void,
  ): IncrementalEditStepEvidence => {
    run();
    const events = collector.trace().events.slice(cursor);
    cursor += events.length;
    return Object.freeze({ name, ...stableCounts(events) });
  };

  const steps: IncrementalEditStepEvidence[] = [];
  steps.push(checkpoint("prime", () => {
    session.render();
    layoutBeforePaint = session.layoutTree();
  }));
  steps.push(checkpoint("paint-only-edit", () => {
    if (layoutBeforePaint === undefined) throw new Error("incremental edit evidence: missing primed layout");
    session.setAttribute(target, "class", "box blue");
    session.render();
    layoutAfterPaint = session.layoutTree();
    paintOnlyReusedLayout = layoutAfterPaint === layoutBeforePaint;
  }));
  steps.push(checkpoint("layout-affecting-edit", () => {
    if (layoutAfterPaint === undefined) throw new Error("incremental edit evidence: missing paint-edit layout");
    session.setAttribute(target, "class", "box wide");
    session.render();
    const layoutAfterWidth = session.layoutTree();
    layoutEditRecomputedLayout = layoutAfterWidth !== layoutAfterPaint;
  }));
  steps.push(checkpoint("no-mutation-render", () => {
    const before = session.recomputeCount;
    session.render();
    noMutationRecomputes = session.recomputeCount - before;
  }));

  const counts = mergeCounts(steps);
  return Object.freeze({
    scenario: `${INCREMENTAL_EDIT_SIZE} sibling boxes; paint-only class edit, layout-affecting class edit, no-mutation render`,
    documentNodes: session.dom.nodes.size,
    editedNode: `#${INCREMENTAL_EDIT_TARGET_ID}`,
    paintOnlyReusedLayout,
    layoutEditRecomputedLayout,
    noMutationRecomputes,
    steps: Object.freeze(steps),
    ...counts,
  });
}

function scriptDrivenEditHtml(): string {
  return (
    "<html><head><style>" +
    "#target { width: 10px; height: 10px; background-color: red }" +
    ".blue { background-color: blue !important }" +
    ".wide { width: 20px !important }" +
    ".made { width: 7px; height: 7px; background-color: green }" +
    "</style></head>" +
    '<body><div id="target">x</div></body></html>'
  );
}

/** Run real JavaScript DOM APIs against FineSession and collect stable trace counts. */
export function collectScriptDrivenEditEvidence(): ScriptDrivenEditEvidence {
  const collector = createStageTraceCollector();
  const session = new FineSession(scriptDrivenEditHtml(), "benchmark://script-driven-edit", {
    onQuery: collector.onQuery,
  });
  let cursor = 0;
  let scriptMutations = 0;
  const initialDocumentNodes = session.dom.nodes.size;
  let layoutBeforePaint: ReturnType<FineSession["layoutTree"]> | undefined;
  let layoutAfterPaint: ReturnType<FineSession["layoutTree"]> | undefined;
  let layoutAfterWidth: ReturnType<FineSession["layoutTree"]> | undefined;
  let paintOnlyReusedLayout = false;
  let layoutEditRecomputedLayout = false;
  let appendedNodePainted = false;

  const checkpoint = (
    name: ScriptDrivenEditStepEvidence["name"],
    run: () => number,
  ): ScriptDrivenEditStepEvidence => {
    const mutations = run();
    scriptMutations += mutations;
    const events = collector.trace().events.slice(cursor);
    cursor += events.length;
    return Object.freeze({ name, mutations, ...stableCounts(events) });
  };

  const steps: ScriptDrivenEditStepEvidence[] = [];
  steps.push(checkpoint("prime", () => {
    session.render();
    layoutBeforePaint = session.layoutTree();
    return 0;
  }));
  steps.push(checkpoint("script-paint-only", () => {
    if (layoutBeforePaint === undefined) throw new Error("script evidence: missing primed layout");
    const result = runScript(session, 'document.getElementById("target").classList.add("blue");');
    const list = session.render();
    layoutAfterPaint = session.layoutTree();
    paintOnlyReusedLayout = layoutAfterPaint === layoutBeforePaint;
    if (!list.commands.some((c) => c.op === "rect" && c.fill.b === 255)) {
      throw new Error("script evidence: paint-only classList edit did not repaint blue");
    }
    return result.mutations;
  }));
  steps.push(checkpoint("script-layout-edit", () => {
    if (layoutAfterPaint === undefined) throw new Error("script evidence: missing paint-edit layout");
    const result = runScript(session, 'document.getElementById("target").classList.add("wide");');
    session.render();
    layoutAfterWidth = session.layoutTree();
    layoutEditRecomputedLayout = layoutAfterWidth !== layoutAfterPaint;
    return result.mutations;
  }));
  steps.push(checkpoint("script-append-child", () => {
    const result = runScript(
      session,
      'var el = document.createElement("div"); el.id = "made"; el.className = "made"; document.querySelector("body").appendChild(el);',
    );
    const list = session.render();
    appendedNodePainted = list.commands.some((c) => c.op === "rect" && c.fill.g > 0 && Number(c.rect.width) === 7);
    layoutAfterWidth = session.layoutTree();
    return result.mutations;
  }));

  const counts = mergeCounts(steps);
  const finalDocumentNodes = session.dom.nodes.size;
  return Object.freeze({
    scenario: "real V8 script uses classList.add, document.createElement, id/className setters, and appendChild",
    initialDocumentNodes,
    finalDocumentNodes,
    scriptMutations,
    paintOnlyReusedLayout,
    layoutEditRecomputedLayout,
    appendChildIncreasedNodes: finalDocumentNodes > initialDocumentNodes,
    appendedNodePainted,
    steps: Object.freeze(steps),
    ...counts,
  });
}

const RESOURCE_PAGE_URL = "https://benchmark.test/index.html";

function resourcePageHtml(): string {
  return (
    '<html><head><link rel="stylesheet" href="/style.css"></head>' +
    '<body><img src="/pic.png"><img src="/missing.png"></body></html>'
  );
}

function solidPngBytes(width: number, height: number, rgba: readonly [number, number, number, number]): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = rgba[0];
    data[i * 4 + 1] = rgba[1];
    data[i * 4 + 2] = rgba[2];
    data[i * 4 + 3] = rgba[3];
  }
  return encodePng({ width, height, data });
}

/** Render a deterministic URL page with external CSS, image, and one missing resource. */
export async function collectResourceLoadedPageEvidence(): Promise<ResourceLoadedPageEvidence> {
  const html = resourcePageHtml();
  const css = "img { width: 30px; height: 20px }";
  const png = solidPngBytes(2, 2, [0, 0, 255, 255]);
  const resources = new Map<string, Uint8Array>([
    [RESOURCE_PAGE_URL, encode(html)],
    ["https://benchmark.test/style.css", encode(css)],
    ["https://benchmark.test/pic.png", png],
  ]);
  const fetchFn: FetchFn = (url) => Promise.resolve(resources.get(url));
  const result = await renderUrlToPng(RESOURCE_PAGE_URL, fetchFn, { trace: true });
  const trace: ResourceTrace | undefined = result.resourceTrace;
  if (trace === undefined) {
    throw new Error("resource-loaded page evidence: missing resource trace");
  }
  return Object.freeze({
    url: trace.url,
    rootBytes: trace.rootBytes,
    discoveredResources: trace.discoveredResources.length,
    loadedResources: trace.loadedResources.length,
    missingResources: trace.missingResources.length,
    loadedBytes: trace.loadedBytes,
    stylesheetCount: trace.stylesheetCount,
    decodedImageCount: trace.decodedImageCount,
    displayCommands: trace.displayCommands,
    paintOps: trace.paintOps,
    width: result.width,
    height: result.height,
    pngBytes: result.png.byteLength,
    missingImage: await collectMissingImageResourceEvidence(),
    invalidImage: await collectInvalidImageResourceEvidence(),
    duplicateResource: await collectDuplicateResourceCacheEvidence(),
    duplicateStylesheet: await collectDuplicateStylesheetUrlCacheEvidence(),
    dataUrlNoNetwork: await collectDataUrlNoNetworkResourceEvidence(),
    dataUrlStylesheetCharset: await collectDataUrlStylesheetCharsetEvidence(),
    dataUrlStylesheetSourceOrder: await collectDataUrlStylesheetSourceOrderEvidence(),
    externalInlineStylesheetSourceOrder: await collectExternalInlineStylesheetSourceOrderEvidence(),
    invalidDataImage: await collectInvalidDataImageResourceEvidence(),
    invalidDataStylesheet: await collectInvalidDataStylesheetResourceEvidence(),
    nonCssDataStylesheet: await collectNonCssDataStylesheetResourceEvidence(),
    noHrefStylesheet: await collectNoHrefStylesheetResourceEvidence(),
    emptyHrefStylesheet: await collectEmptyHrefStylesheetResourceEvidence(),
    fragmentHrefStylesheet: await collectFragmentHrefStylesheetResourceEvidence(),
    queryHrefStylesheet: await collectQueryHrefStylesheetResourceEvidence(),
    protocolRelativeStylesheet: await collectProtocolRelativeStylesheetResourceEvidence(),
    whitespaceRelStylesheet: await collectWhitespaceRelStylesheetResourceEvidence(),
    duplicateRelStylesheet: await collectDuplicateRelStylesheetResourceEvidence(),
    whitespaceHrefStylesheet: await collectWhitespaceHrefStylesheetResourceEvidence(),
    controlCharacterHrefStylesheet: await collectControlCharacterHrefStylesheetResourceEvidence(),
    baseHrefSubresource: await collectBaseHrefSubresourceEvidence(),
    invalidUrlStylesheet: await collectInvalidUrlStylesheetResourceEvidence(),
    alternateStylesheet: await collectAlternateStylesheetResourceEvidence(),
    disabledStylesheet: await collectDisabledStylesheetResourceEvidence(),
    printMediaStylesheet: await collectPrintMediaStylesheetResourceEvidence(),
    stylesheetMediaList: await collectStylesheetMediaListResourceEvidence(),
    stylesheetMediaFeature: await collectStylesheetMediaFeatureResourceEvidence(),
    stylesheetOrientationMedia: await collectStylesheetOrientationMediaResourceEvidence(),
    stylesheetCombinedMediaFeature: await collectStylesheetCombinedMediaFeatureResourceEvidence(),
    invalidExternalStylesheet: await collectInvalidExternalStylesheetResourceEvidence(),
    missingStylesheet: await collectMissingStylesheetResourceEvidence(),
  });
}

/** Render a deterministic URL page with only a missing external image. */
async function collectMissingImageResourceEvidence(): Promise<MissingImageResourceEvidence> {
  const url = "https://benchmark.test/missing-image.html";
  const html = '<body><img src="/missing.png"><div>after</div></body>';
  const resources = new Map<string, Uint8Array>([[url, encode(html)]]);
  const fetchFn: FetchFn = (href) => Promise.resolve(resources.get(href));
  const result = await renderUrlToPng(url, fetchFn, { trace: true });
  const trace: ResourceTrace | undefined = result.resourceTrace;
  if (trace === undefined) {
    throw new Error("missing-image evidence: missing resource trace");
  }
  return Object.freeze({
    url: trace.url,
    discoveredResources: trace.discoveredResources.length,
    loadedResources: trace.loadedResources.length,
    missingResources: trace.missingResources.length,
    loadedBytes: trace.loadedBytes,
    decodedImageCount: trace.decodedImageCount,
    paintedImage: trace.paintOps.includes("image"),
    displayCommands: trace.displayCommands,
    paintOps: trace.paintOps,
    pngBytes: result.png.byteLength,
  });
}

/** Render a deterministic URL page with a loaded but undecodable external image. */
async function collectInvalidImageResourceEvidence(): Promise<InvalidImageResourceEvidence> {
  const url = "https://benchmark.test/invalid-image.html";
  const html = '<body><img src="/bad.png"><div>after</div></body>';
  const badPng = encode("not a png");
  const resources = new Map<string, Uint8Array>([
    [url, encode(html)],
    ["https://benchmark.test/bad.png", badPng],
  ]);
  const fetchFn: FetchFn = (href) => Promise.resolve(resources.get(href));
  const result = await renderUrlToPng(url, fetchFn, { trace: true });
  const trace: ResourceTrace | undefined = result.resourceTrace;
  if (trace === undefined) {
    throw new Error("invalid-image evidence: missing resource trace");
  }
  return Object.freeze({
    url: trace.url,
    discoveredResources: trace.discoveredResources.length,
    loadedResources: trace.loadedResources.length,
    missingResources: trace.missingResources.length,
    loadedBytes: trace.loadedBytes,
    decodedImageCount: trace.decodedImageCount,
    paintedImage: trace.paintOps.includes("image"),
    displayCommands: trace.displayCommands,
    paintOps: trace.paintOps,
    pngBytes: result.png.byteLength,
  });
}

/** Render a deterministic URL page where two image nodes share one external URL. */
async function collectDuplicateResourceCacheEvidence(): Promise<DuplicateResourceCacheEvidence> {
  const url = "https://benchmark.test/duplicate-resource.html";
  const html =
    '<html><head><style>img { width: 10px; height: 10px }</style></head>' +
    '<body><img src="/shared.png"><img src="shared.png"></body></html>';
  const shared = solidPngBytes(2, 2, [0, 128, 255, 255]);
  const resources = new Map<string, Uint8Array>([
    [url, encode(html)],
    ["https://benchmark.test/shared.png", shared],
  ]);
  const calls: string[] = [];
  const fetchFn: FetchFn = (href) => {
    calls.push(href);
    return Promise.resolve(resources.get(href));
  };
  const result = await renderUrlToPng(url, fetchFn, { trace: true });
  const trace: ResourceTrace | undefined = result.resourceTrace;
  if (trace === undefined) {
    throw new Error("duplicate-resource evidence: missing resource trace");
  }
  const sharedUrl = "https://benchmark.test/shared.png";
  return Object.freeze({
    url: trace.url,
    fetchCalls: calls.length,
    sharedResourceFetches: calls.filter((href) => href === sharedUrl).length,
    discoveredResources: trace.discoveredResources.length,
    loadedResources: trace.loadedResources.length,
    missingResources: trace.missingResources.length,
    loadedBytes: trace.loadedBytes,
    decodedImageCount: trace.decodedImageCount,
    paintedImageCount: trace.imagePaintCount,
    displayCommands: trace.displayCommands,
    paintOps: trace.paintOps,
    pngBytes: result.png.byteLength,
  });
}

/** Render a deterministic URL page where duplicate stylesheet links share one fetch but both cascade. */
async function collectDuplicateStylesheetUrlCacheEvidence(): Promise<DuplicateStylesheetUrlCacheEvidence> {
  const url = "https://benchmark.test/duplicate-stylesheet.html";
  const html =
    '<html><head><link rel="stylesheet" href="/shared.css">' +
    "<style>div { width: 20px; height: 20px; background-color: rgb(0, 0, 255) }</style>" +
    '<link rel="stylesheet" href="shared.css"></head><body><div></div></body></html>';
  const css = "div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }";
  const resources = new Map<string, Uint8Array>([
    [url, encode(html)],
    ["https://benchmark.test/shared.css", encode(css)],
  ]);
  const calls: string[] = [];
  const fetchFn: FetchFn = (href) => {
    calls.push(href);
    return Promise.resolve(resources.get(href));
  };
  const result = await renderUrlToPng(url, fetchFn, { trace: true });
  const trace: ResourceTrace | undefined = result.resourceTrace;
  if (trace === undefined) {
    throw new Error("duplicate-stylesheet evidence: missing resource trace");
  }
  const image = decodePng(result.png);
  const pixel = (10 * image.width + 10) * 4;
  const duplicateLinkWonSourceOrder =
    image.data[pixel] === 255 && image.data[pixel + 1] === 0 && image.data[pixel + 2] === 0;
  const sharedUrl = "https://benchmark.test/shared.css";
  return Object.freeze({
    url: trace.url,
    fetchCalls: calls.length,
    sharedStylesheetFetches: calls.filter((href) => href === sharedUrl).length,
    discoveredResources: trace.discoveredResources.length,
    loadedResources: trace.loadedResources.length,
    missingResources: trace.missingResources.length,
    loadedBytes: trace.loadedBytes,
    stylesheetCount: trace.stylesheetCount,
    authorStylesheetCount: trace.authorStylesheetCount,
    authorRuleCount: trace.authorRuleCount,
    authorDeclarationCount: trace.authorDeclarationCount,
    decodedImageCount: trace.decodedImageCount,
    paintedBackground: trace.paintOps.includes("rect"),
    duplicateLinkWonSourceOrder,
    displayCommands: trace.displayCommands,
    paintOps: trace.paintOps,
    pngBytes: result.png.byteLength,
  });
}

/** Render a URL page whose data: stylesheet/image render without network fetches. */
async function collectDataUrlNoNetworkResourceEvidence(): Promise<DataUrlNoNetworkResourceEvidence> {
  const url = "https://benchmark.test/data-url-resource.html";
  const css =
    "div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) } " +
    "img { width: 10px; height: 10px }";
  const image = `data:image/png;base64,${Buffer.from(solidPngBytes(2, 2, [0, 128, 255, 255])).toString("base64")}`;
  const html =
    `<html><head><link rel="stylesheet" href="data:text/css,${encodeURIComponent(css)}"></head>` +
    `<body><div></div><img src="${image}"></body></html>`;
  const calls: string[] = [];
  const fetchFn: FetchFn = (href) => {
    calls.push(href);
    return Promise.resolve(href === url ? encode(html) : undefined);
  };
  const result = await renderUrlToPng(url, fetchFn, { trace: true });
  const trace: ResourceTrace | undefined = result.resourceTrace;
  if (trace === undefined) {
    throw new Error("data-url resource evidence: missing resource trace");
  }
  return Object.freeze({
    url: trace.url,
    fetchCalls: calls.length,
    discoveredResources: trace.discoveredResources.length,
    loadedResources: trace.loadedResources.length,
    missingResources: trace.missingResources.length,
    loadedBytes: trace.loadedBytes,
    stylesheetCount: trace.stylesheetCount,
    decodedImageCount: trace.decodedImageCount,
    paintedImageCount: trace.imagePaintCount,
    paintedBackground: trace.paintOps.includes("rect"),
    displayCommands: trace.displayCommands,
    paintOps: trace.paintOps,
    pngBytes: result.png.byteLength,
  });
}

/** Render data:text/css charset metadata cases without network fetches for data URLs. */
async function collectDataUrlStylesheetCharsetEvidence(): Promise<DataUrlStylesheetCharsetEvidence> {
  const css = "div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }";
  const percentUtf8 = await collectDataUrlStylesheetCharsetCaseEvidence({
    url: "https://benchmark.test/data-url-charset-percent-stylesheet.html",
    metadata: "text/css;charset=utf-8",
    dataUrl: `data:text/css;charset=utf-8,${encodeURIComponent(css)}`,
  });
  const base64Utf8 = await collectDataUrlStylesheetCharsetCaseEvidence({
    url: "https://benchmark.test/data-url-charset-base64-stylesheet.html",
    metadata: "text/css;charset=utf-8;base64",
    dataUrl: `data:text/css;charset=utf-8;base64,${Buffer.from(css, "utf8").toString("base64")}`,
  });
  const unsupportedCharset = await collectDataUrlStylesheetCharsetCaseEvidence({
    url: "https://benchmark.test/data-url-charset-unsupported-stylesheet.html",
    metadata: "text/css;charset=iso-8859-1",
    dataUrl: `data:text/css;charset=iso-8859-1,${encodeURIComponent(css)}`,
  });
  return Object.freeze({
    percentUtf8,
    base64Utf8,
    unsupportedCharset,
  });
}

async function collectDataUrlStylesheetCharsetCaseEvidence(options: {
  readonly url: string;
  readonly metadata: string;
  readonly dataUrl: string;
}): Promise<DataUrlStylesheetCharsetCaseEvidence> {
  const html =
    `<html><head><link rel="stylesheet" href="${options.dataUrl}"></head>` +
    "<body><div>after</div></body></html>";
  const calls: string[] = [];
  const result = await renderUrlToPng(
    options.url,
    (href) => {
      calls.push(href);
      return Promise.resolve(href === options.url ? encode(html) : undefined);
    },
    { trace: true },
  );
  const trace: ResourceTrace | undefined = result.resourceTrace;
  if (trace === undefined) {
    throw new Error("data-url-stylesheet-charset evidence: missing resource trace");
  }

  return Object.freeze({
    url: trace.url,
    metadata: options.metadata,
    fetchCalls: calls.length,
    dataUrlFetchCalls: calls.filter((href) => href === options.dataUrl).length,
    discoveredResources: trace.discoveredResources.length,
    loadedResources: trace.loadedResources.length,
    missingResources: trace.missingResources.length,
    loadedBytes: trace.loadedBytes,
    stylesheetCount: trace.stylesheetCount,
    authorStylesheetCount: trace.authorStylesheetCount,
    authorRuleCount: trace.authorRuleCount,
    authorDeclarationCount: trace.authorDeclarationCount,
    decodedImageCount: trace.decodedImageCount,
    paintedBackground: trace.paintOps.includes("rect"),
    displayCommands: trace.displayCommands,
    paintOps: trace.paintOps,
    pngBytes: result.png.byteLength,
  });
}

/** Render both data:text/css/external source-order directions. */
async function collectDataUrlStylesheetSourceOrderEvidence(): Promise<DataUrlStylesheetSourceOrderEvidence> {
  const externalAfterDataUrl = await collectDataUrlStylesheetSourceOrderCaseEvidence({
    url: "https://benchmark.test/data-url-before-external-stylesheet.html",
    externalStylesheetUrl: "https://benchmark.test/late.css",
    html: (dataUrl) =>
      `<html><head><link rel="stylesheet" href="${dataUrl}">` +
      '<link rel="stylesheet" href="/late.css"></head><body><div></div></body></html>',
    dataCss: "div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }",
    externalCss: "div { background-color: rgb(0, 0, 255) }",
  });
  const dataUrlAfterExternal = await collectDataUrlStylesheetSourceOrderCaseEvidence({
    url: "https://benchmark.test/external-before-data-url-stylesheet.html",
    externalStylesheetUrl: "https://benchmark.test/early.css",
    html: (dataUrl) =>
      '<html><head><link rel="stylesheet" href="/early.css">' +
      `<link rel="stylesheet" href="${dataUrl}"></head><body><div></div></body></html>`,
    dataCss: "div { background-color: rgb(0, 0, 255) }",
    externalCss: "div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }",
  });
  return Object.freeze({
    externalAfterDataUrl,
    dataUrlAfterExternal,
  });
}

async function collectDataUrlStylesheetSourceOrderCaseEvidence(options: {
  readonly url: string;
  readonly externalStylesheetUrl: string;
  readonly html: (dataUrl: string) => string;
  readonly dataCss: string;
  readonly externalCss: string;
}): Promise<DataUrlStylesheetSourceOrderCaseEvidence> {
  const dataUrl = `data:text/css,${encodeURIComponent(options.dataCss)}`;
  const html = options.html(dataUrl);
  const externalCssBytes = encode(options.externalCss);
  const calls: string[] = [];
  const resources = new Map<string, Uint8Array>([
    [options.url, encode(html)],
    [options.externalStylesheetUrl, externalCssBytes],
  ]);
  const result = await renderUrlToPng(
    options.url,
    (href) => {
      calls.push(href);
      return Promise.resolve(resources.get(href));
    },
    { trace: true },
  );
  const trace: ResourceTrace | undefined = result.resourceTrace;
  if (trace === undefined) {
    throw new Error("data-url-stylesheet-source-order evidence: missing resource trace");
  }
  const image = decodePng(result.png);
  const pixel = (10 * image.width + 10) * 4;

  return Object.freeze({
    url: trace.url,
    externalStylesheetUrl: options.externalStylesheetUrl,
    fetchCalls: calls.length,
    dataUrlFetchCalls: calls.filter((href) => href === dataUrl).length,
    externalStylesheetFetches: calls.filter((href) => href === options.externalStylesheetUrl).length,
    discoveredResources: trace.discoveredResources.length,
    loadedResources: trace.loadedResources.length,
    missingResources: trace.missingResources.length,
    loadedBytes: trace.loadedBytes,
    stylesheetCount: trace.stylesheetCount,
    authorStylesheetCount: trace.authorStylesheetCount,
    authorRuleCount: trace.authorRuleCount,
    authorDeclarationCount: trace.authorDeclarationCount,
    decodedImageCount: trace.decodedImageCount,
    paintedBackground: trace.paintOps.includes("rect"),
    sourceOrderWinnerBlue: image.data[pixel] === 0 && image.data[pixel + 1] === 0 && image.data[pixel + 2] === 255,
    displayCommands: trace.displayCommands,
    paintOps: trace.paintOps,
    pngBytes: result.png.byteLength,
  });
}

/** Render both external stylesheet/inline style source-order directions. */
async function collectExternalInlineStylesheetSourceOrderEvidence(): Promise<ExternalInlineStylesheetSourceOrderEvidence> {
  const inlineAfterExternal = await collectExternalInlineStylesheetSourceOrderCaseEvidence({
    url: "https://benchmark.test/external-before-inline-stylesheet.html",
    externalStylesheetUrl: "https://benchmark.test/early.css",
    html:
      '<html><head><link rel="stylesheet" href="/early.css">' +
      "<style>div { background-color: rgb(0, 0, 255) }</style></head><body><div></div></body></html>",
    externalCss: "div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }",
  });
  const externalAfterInline = await collectExternalInlineStylesheetSourceOrderCaseEvidence({
    url: "https://benchmark.test/inline-before-external-stylesheet.html",
    externalStylesheetUrl: "https://benchmark.test/late.css",
    html:
      "<html><head><style>div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }</style>" +
      '<link rel="stylesheet" href="/late.css"></head><body><div></div></body></html>',
    externalCss: "div { background-color: rgb(0, 0, 255) }",
  });
  return Object.freeze({
    inlineAfterExternal,
    externalAfterInline,
  });
}

async function collectExternalInlineStylesheetSourceOrderCaseEvidence(options: {
  readonly url: string;
  readonly externalStylesheetUrl: string;
  readonly html: string;
  readonly externalCss: string;
}): Promise<ExternalInlineStylesheetSourceOrderCaseEvidence> {
  const externalCssBytes = encode(options.externalCss);
  const calls: string[] = [];
  const resources = new Map<string, Uint8Array>([
    [options.url, encode(options.html)],
    [options.externalStylesheetUrl, externalCssBytes],
  ]);
  const result = await renderUrlToPng(
    options.url,
    (href) => {
      calls.push(href);
      return Promise.resolve(resources.get(href));
    },
    { trace: true },
  );
  const trace: ResourceTrace | undefined = result.resourceTrace;
  if (trace === undefined) {
    throw new Error("external-inline-stylesheet-source-order evidence: missing resource trace");
  }
  const image = decodePng(result.png);
  const pixel = (10 * image.width + 10) * 4;

  return Object.freeze({
    url: trace.url,
    externalStylesheetUrl: options.externalStylesheetUrl,
    fetchCalls: calls.length,
    externalStylesheetFetches: calls.filter((href) => href === options.externalStylesheetUrl).length,
    discoveredResources: trace.discoveredResources.length,
    loadedResources: trace.loadedResources.length,
    missingResources: trace.missingResources.length,
    loadedBytes: trace.loadedBytes,
    stylesheetCount: trace.stylesheetCount,
    authorStylesheetCount: trace.authorStylesheetCount,
    authorRuleCount: trace.authorRuleCount,
    authorDeclarationCount: trace.authorDeclarationCount,
    decodedImageCount: trace.decodedImageCount,
    paintedBackground: trace.paintOps.includes("rect"),
    sourceOrderWinnerBlue: image.data[pixel] === 0 && image.data[pixel + 1] === 0 && image.data[pixel + 2] === 255,
    displayCommands: trace.displayCommands,
    paintOps: trace.paintOps,
    pngBytes: result.png.byteLength,
  });
}

/** Render a URL page whose invalid data:image neither fetches nor paints. */
async function collectInvalidDataImageResourceEvidence(): Promise<InvalidDataImageResourceEvidence> {
  const url = "https://benchmark.test/invalid-data-image.html";
  const html =
    '<html><head><style>div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }</style></head>' +
    '<body><img src="data:image/png;base64,not-a-real-png"><div>after</div></body></html>';
  const calls: string[] = [];
  const fetchFn: FetchFn = (href) => {
    calls.push(href);
    return Promise.resolve(href === url ? encode(html) : undefined);
  };
  const result = await renderUrlToPng(url, fetchFn, { trace: true });
  const trace: ResourceTrace | undefined = result.resourceTrace;
  if (trace === undefined) {
    throw new Error("invalid-data-image evidence: missing resource trace");
  }
  return Object.freeze({
    url: trace.url,
    fetchCalls: calls.length,
    discoveredResources: trace.discoveredResources.length,
    loadedResources: trace.loadedResources.length,
    missingResources: trace.missingResources.length,
    loadedBytes: trace.loadedBytes,
    decodedImageCount: trace.decodedImageCount,
    paintedImageCount: trace.imagePaintCount,
    paintedBackground: trace.paintOps.includes("rect"),
    displayCommands: trace.displayCommands,
    paintOps: trace.paintOps,
    pngBytes: result.png.byteLength,
  });
}

/** Render a URL page whose invalid data:text/css does not fetch or fake rules. */
async function collectInvalidDataStylesheetResourceEvidence(): Promise<InvalidDataStylesheetResourceEvidence> {
  const url = "https://benchmark.test/invalid-data-stylesheet.html";
  const css = "div { width: bogus; height: nope; background-color: definitely-not-a-color }";
  const html =
    `<html><head><link rel="stylesheet" href="data:text/css,${encodeURIComponent(css)}"></head>` +
    "<body><div>after</div></body></html>";
  const calls: string[] = [];
  const fetchFn: FetchFn = (href) => {
    calls.push(href);
    return Promise.resolve(href === url ? encode(html) : undefined);
  };
  const result = await renderUrlToPng(url, fetchFn, { trace: true });
  const trace: ResourceTrace | undefined = result.resourceTrace;
  if (trace === undefined) {
    throw new Error("invalid-data-stylesheet evidence: missing resource trace");
  }
  return Object.freeze({
    url: trace.url,
    fetchCalls: calls.length,
    discoveredResources: trace.discoveredResources.length,
    loadedResources: trace.loadedResources.length,
    missingResources: trace.missingResources.length,
    loadedBytes: trace.loadedBytes,
    stylesheetCount: trace.stylesheetCount,
    authorStylesheetCount: trace.authorStylesheetCount,
    authorRuleCount: trace.authorRuleCount,
    authorDeclarationCount: trace.authorDeclarationCount,
    decodedImageCount: trace.decodedImageCount,
    paintedBackground: trace.paintOps.includes("rect"),
    displayCommands: trace.displayCommands,
    paintOps: trace.paintOps,
    pngBytes: result.png.byteLength,
  });
}

/** Render a URL page whose data:text/plain stylesheet does not fetch or enter CSS. */
async function collectNonCssDataStylesheetResourceEvidence(): Promise<NonCssDataStylesheetResourceEvidence> {
  const url = "https://benchmark.test/non-css-data-stylesheet.html";
  const css = "div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }";
  const html =
    `<html><head><link rel="stylesheet" href="data:text/plain,${encodeURIComponent(css)}"></head>` +
    "<body><div>after</div></body></html>";
  const calls: string[] = [];
  const fetchFn: FetchFn = (href) => {
    calls.push(href);
    return Promise.resolve(href === url ? encode(html) : undefined);
  };
  const result = await renderUrlToPng(url, fetchFn, { trace: true });
  const trace: ResourceTrace | undefined = result.resourceTrace;
  if (trace === undefined) {
    throw new Error("non-css-data-stylesheet evidence: missing resource trace");
  }
  return Object.freeze({
    url: trace.url,
    fetchCalls: calls.length,
    discoveredResources: trace.discoveredResources.length,
    loadedResources: trace.loadedResources.length,
    missingResources: trace.missingResources.length,
    loadedBytes: trace.loadedBytes,
    stylesheetCount: trace.stylesheetCount,
    authorStylesheetCount: trace.authorStylesheetCount,
    authorRuleCount: trace.authorRuleCount,
    authorDeclarationCount: trace.authorDeclarationCount,
    decodedImageCount: trace.decodedImageCount,
    paintedBackground: trace.paintOps.includes("rect"),
    displayCommands: trace.displayCommands,
    paintOps: trace.paintOps,
    pngBytes: result.png.byteLength,
  });
}

/** Render a URL page where a href-less stylesheet link does not fetch or add author CSS. */
async function collectNoHrefStylesheetResourceEvidence(): Promise<NoHrefStylesheetResourceEvidence> {
  const url = "https://benchmark.test/no-href-stylesheet.html";
  const stylesheetUrl = "https://benchmark.test/theme.css";
  const html =
    '<html><head><link rel="stylesheet"><link rel="stylesheet" href="/theme.css"></head>' +
    "<body><div>after</div></body></html>";
  const css = encode("div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }");
  const calls: string[] = [];
  const resources = new Map<string, Uint8Array>([
    [url, encode(html)],
    [stylesheetUrl, css],
  ]);
  const fetchFn: FetchFn = (href) => {
    calls.push(href);
    return Promise.resolve(resources.get(href));
  };
  const result = await renderUrlToPng(url, fetchFn, { trace: true });
  const trace: ResourceTrace | undefined = result.resourceTrace;
  if (trace === undefined) {
    throw new Error("no-href-stylesheet evidence: missing resource trace");
  }
  return Object.freeze({
    url: trace.url,
    fetchCalls: calls.length,
    discoveredResources: trace.discoveredResources.length,
    loadedResources: trace.loadedResources.length,
    missingResources: trace.missingResources.length,
    loadedBytes: trace.loadedBytes,
    stylesheetCount: trace.stylesheetCount,
    authorStylesheetCount: trace.authorStylesheetCount,
    authorRuleCount: trace.authorRuleCount,
    authorDeclarationCount: trace.authorDeclarationCount,
    decodedImageCount: trace.decodedImageCount,
    paintedBackground: trace.paintOps.includes("rect"),
    displayCommands: trace.displayCommands,
    paintOps: trace.paintOps,
    pngBytes: result.png.byteLength,
  });
}

/** Render a URL page where href="" resolves to the document URL but does not fake CSS declarations. */
async function collectEmptyHrefStylesheetResourceEvidence(): Promise<EmptyHrefStylesheetResourceEvidence> {
  const url = "https://benchmark.test/empty-href-stylesheet.html";
  const html =
    '<html><head><link rel="stylesheet" href=""></head>' +
    "<body><div>after</div></body></html>";
  const calls: string[] = [];
  const fetchFn: FetchFn = (href) => {
    calls.push(href);
    return Promise.resolve(href === url ? encode(html) : undefined);
  };
  const result = await renderUrlToPng(url, fetchFn, { trace: true });
  const trace: ResourceTrace | undefined = result.resourceTrace;
  if (trace === undefined) {
    throw new Error("empty-href-stylesheet evidence: missing resource trace");
  }
  return Object.freeze({
    url: trace.url,
    fetchCalls: calls.length,
    discoveredResources: trace.discoveredResources.length,
    loadedResources: trace.loadedResources.length,
    missingResources: trace.missingResources.length,
    loadedBytes: trace.loadedBytes,
    stylesheetCount: trace.stylesheetCount,
    authorStylesheetCount: trace.authorStylesheetCount,
    authorRuleCount: trace.authorRuleCount,
    authorDeclarationCount: trace.authorDeclarationCount,
    decodedImageCount: trace.decodedImageCount,
    paintedBackground: trace.paintOps.includes("rect"),
    displayCommands: trace.displayCommands,
    paintOps: trace.paintOps,
    pngBytes: result.png.byteLength,
  });
}

/** Render a URL page where href="#sheet" preserves the fragment but does not fake CSS declarations. */
async function collectFragmentHrefStylesheetResourceEvidence(): Promise<FragmentHrefStylesheetResourceEvidence> {
  const url = "https://benchmark.test/fragment-href-stylesheet.html";
  const fragmentUrl = `${url}#sheet`;
  const html =
    '<html><head><link rel="stylesheet" href="#sheet"></head>' +
    "<body><div>after</div></body></html>";
  const calls: string[] = [];
  const fetchFn: FetchFn = (href) => {
    calls.push(href);
    return Promise.resolve(href === url || href === fragmentUrl ? encode(html) : undefined);
  };
  const result = await renderUrlToPng(url, fetchFn, { trace: true });
  const trace: ResourceTrace | undefined = result.resourceTrace;
  if (trace === undefined) {
    throw new Error("fragment-href-stylesheet evidence: missing resource trace");
  }
  return Object.freeze({
    url: trace.url,
    fetchCalls: calls.length,
    discoveredResources: trace.discoveredResources.length,
    loadedResources: trace.loadedResources.length,
    missingResources: trace.missingResources.length,
    loadedBytes: trace.loadedBytes,
    stylesheetCount: trace.stylesheetCount,
    authorStylesheetCount: trace.authorStylesheetCount,
    authorRuleCount: trace.authorRuleCount,
    authorDeclarationCount: trace.authorDeclarationCount,
    decodedImageCount: trace.decodedImageCount,
    paintedBackground: trace.paintOps.includes("rect"),
    displayCommands: trace.displayCommands,
    paintOps: trace.paintOps,
    pngBytes: result.png.byteLength,
  });
}

/** Render a URL page where href="?sheet" replaces query/fragment but does not fake CSS declarations. */
async function collectQueryHrefStylesheetResourceEvidence(): Promise<QueryHrefStylesheetResourceEvidence> {
  const url = "https://benchmark.test/query-href-stylesheet.html?old=1#frag";
  const queryUrl = "https://benchmark.test/query-href-stylesheet.html?sheet";
  const html =
    '<html><head><link rel="stylesheet" href="?sheet"></head>' +
    "<body><div>after</div></body></html>";
  const calls: string[] = [];
  const fetchFn: FetchFn = (href) => {
    calls.push(href);
    return Promise.resolve(href === url || href === queryUrl ? encode(html) : undefined);
  };
  const result = await renderUrlToPng(url, fetchFn, { trace: true });
  const trace: ResourceTrace | undefined = result.resourceTrace;
  if (trace === undefined) {
    throw new Error("query-href-stylesheet evidence: missing resource trace");
  }
  return Object.freeze({
    url: trace.url,
    fetchCalls: calls.length,
    discoveredResources: trace.discoveredResources.length,
    loadedResources: trace.loadedResources.length,
    missingResources: trace.missingResources.length,
    loadedBytes: trace.loadedBytes,
    stylesheetCount: trace.stylesheetCount,
    authorStylesheetCount: trace.authorStylesheetCount,
    authorRuleCount: trace.authorRuleCount,
    authorDeclarationCount: trace.authorDeclarationCount,
    decodedImageCount: trace.decodedImageCount,
    paintedBackground: trace.paintOps.includes("rect"),
    displayCommands: trace.displayCommands,
    paintOps: trace.paintOps,
    pngBytes: result.png.byteLength,
  });
}

/** Render a URL page whose protocol-relative stylesheet inherits the document scheme and applies. */
async function collectProtocolRelativeStylesheetResourceEvidence(): Promise<ProtocolRelativeStylesheetResourceEvidence> {
  const url = "https://benchmark.test/protocol-relative-stylesheet.html";
  const stylesheetUrl = "https://cdn.test/theme.css";
  const html =
    '<html><head><link rel="stylesheet" href="//cdn.test/theme.css"></head>' +
    "<body><div></div></body></html>";
  const css = encode("div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }");
  const calls: string[] = [];
  const resources = new Map<string, Uint8Array>([
    [url, encode(html)],
    [stylesheetUrl, css],
  ]);
  const fetchFn: FetchFn = (href) => {
    calls.push(href);
    return Promise.resolve(resources.get(href));
  };
  const result = await renderUrlToPng(url, fetchFn, { trace: true });
  const trace: ResourceTrace | undefined = result.resourceTrace;
  if (trace === undefined) {
    throw new Error("protocol-relative-stylesheet evidence: missing resource trace");
  }
  return Object.freeze({
    url: trace.url,
    fetchCalls: calls.length,
    discoveredResources: trace.discoveredResources.length,
    loadedResources: trace.loadedResources.length,
    missingResources: trace.missingResources.length,
    loadedBytes: trace.loadedBytes,
    stylesheetCount: trace.stylesheetCount,
    authorStylesheetCount: trace.authorStylesheetCount,
    authorRuleCount: trace.authorRuleCount,
    authorDeclarationCount: trace.authorDeclarationCount,
    decodedImageCount: trace.decodedImageCount,
    paintedBackground: trace.paintOps.includes("rect"),
    displayCommands: trace.displayCommands,
    paintOps: trace.paintOps,
    pngBytes: result.png.byteLength,
  });
}

/** Render a URL page whose stylesheet rel token is surrounded by ASCII whitespace. */
async function collectWhitespaceRelStylesheetResourceEvidence(): Promise<WhitespaceRelStylesheetResourceEvidence> {
  const url = "https://benchmark.test/whitespace-rel-stylesheet.html";
  const earlyUrl = "https://benchmark.test/early.css";
  const lateUrl = "https://benchmark.test/late.css";
  const html =
    '<html><head><link rel=" preload\tstylesheet\n " href="/early.css">' +
    '<link rel="stylesheet" href="/late.css"></head><body><div></div></body></html>';
  const earlyCss = encode("div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }");
  const lateCss = encode("div { background-color: rgb(0, 0, 255) }");
  const calls: string[] = [];
  const resources = new Map<string, Uint8Array>([
    [url, encode(html)],
    [earlyUrl, earlyCss],
    [lateUrl, lateCss],
  ]);
  const fetchFn: FetchFn = (href) => {
    calls.push(href);
    return Promise.resolve(resources.get(href));
  };
  const result = await renderUrlToPng(url, fetchFn, { trace: true });
  const trace: ResourceTrace | undefined = result.resourceTrace;
  if (trace === undefined) {
    throw new Error("whitespace-rel-stylesheet evidence: missing resource trace");
  }
  const image = decodePng(result.png);
  const pixel = (10 * image.width + 10) * 4;

  const alternateUrl = "https://benchmark.test/whitespace-rel-alternate-stylesheet.html";
  const alternateHtml =
    '<html><head><link rel=" alternate\tstylesheet\n " href="/theme.css"></head>' +
    "<body><div>after</div></body></html>";
  const alternateCss = encode("div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }");
  const alternateCalls: string[] = [];
  const alternateResources = new Map<string, Uint8Array>([
    [alternateUrl, encode(alternateHtml)],
    ["https://benchmark.test/theme.css", alternateCss],
  ]);
  const alternateResult = await renderUrlToPng(
    alternateUrl,
    (href) => {
      alternateCalls.push(href);
      return Promise.resolve(alternateResources.get(href));
    },
    { trace: true },
  );
  const alternateTrace: ResourceTrace | undefined = alternateResult.resourceTrace;
  if (alternateTrace === undefined) {
    throw new Error("whitespace-rel-alternate-stylesheet evidence: missing resource trace");
  }

  return Object.freeze({
    url: trace.url,
    fetchCalls: calls.length,
    discoveredResources: trace.discoveredResources.length,
    loadedResources: trace.loadedResources.length,
    missingResources: trace.missingResources.length,
    loadedBytes: trace.loadedBytes,
    stylesheetCount: trace.stylesheetCount,
    authorStylesheetCount: trace.authorStylesheetCount,
    authorRuleCount: trace.authorRuleCount,
    authorDeclarationCount: trace.authorDeclarationCount,
    decodedImageCount: trace.decodedImageCount,
    paintedBackground: trace.paintOps.includes("rect"),
    sourceOrderWinnerBlue: image.data[pixel] === 0 && image.data[pixel + 1] === 0 && image.data[pixel + 2] === 255,
    alternateFetchCalls: alternateCalls.length,
    alternateDiscoveredResources: alternateTrace.discoveredResources.length,
    alternateLoadedResources: alternateTrace.loadedResources.length,
    alternateAuthorStylesheetCount: alternateTrace.authorStylesheetCount,
    alternatePaintedBackground: alternateTrace.paintOps.includes("rect"),
    displayCommands: trace.displayCommands,
    paintOps: trace.paintOps,
    pngBytes: result.png.byteLength,
  });
}

/** Render a URL page whose stylesheet rel token is duplicated but still set-like. */
async function collectDuplicateRelStylesheetResourceEvidence(): Promise<DuplicateRelStylesheetResourceEvidence> {
  const url = "https://benchmark.test/duplicate-rel-stylesheet.html";
  const earlyUrl = "https://benchmark.test/early.css";
  const lateUrl = "https://benchmark.test/late.css";
  const html =
    '<html><head><link rel="stylesheet stylesheet" href="/early.css">' +
    '<link rel="stylesheet" href="/late.css"></head><body><div></div></body></html>';
  const earlyCss = encode("div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }");
  const lateCss = encode("div { background-color: rgb(0, 0, 255) }");
  const calls: string[] = [];
  const resources = new Map<string, Uint8Array>([
    [url, encode(html)],
    [earlyUrl, earlyCss],
    [lateUrl, lateCss],
  ]);
  const fetchFn: FetchFn = (href) => {
    calls.push(href);
    return Promise.resolve(resources.get(href));
  };
  const result = await renderUrlToPng(url, fetchFn, { trace: true });
  const trace: ResourceTrace | undefined = result.resourceTrace;
  if (trace === undefined) {
    throw new Error("duplicate-rel-stylesheet evidence: missing resource trace");
  }
  const image = decodePng(result.png);
  const pixel = (10 * image.width + 10) * 4;

  const alternateUrl = "https://benchmark.test/duplicate-rel-alternate-stylesheet.html";
  const alternateHtml =
    '<html><head><link rel="alternate stylesheet stylesheet" href="/theme.css"></head>' +
    "<body><div>after</div></body></html>";
  const alternateCss = encode("div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }");
  const alternateCalls: string[] = [];
  const alternateResources = new Map<string, Uint8Array>([
    [alternateUrl, encode(alternateHtml)],
    ["https://benchmark.test/theme.css", alternateCss],
  ]);
  const alternateResult = await renderUrlToPng(
    alternateUrl,
    (href) => {
      alternateCalls.push(href);
      return Promise.resolve(alternateResources.get(href));
    },
    { trace: true },
  );
  const alternateTrace: ResourceTrace | undefined = alternateResult.resourceTrace;
  if (alternateTrace === undefined) {
    throw new Error("duplicate-rel-alternate-stylesheet evidence: missing resource trace");
  }

  return Object.freeze({
    url: trace.url,
    fetchCalls: calls.length,
    discoveredResources: trace.discoveredResources.length,
    loadedResources: trace.loadedResources.length,
    missingResources: trace.missingResources.length,
    loadedBytes: trace.loadedBytes,
    stylesheetCount: trace.stylesheetCount,
    authorStylesheetCount: trace.authorStylesheetCount,
    authorRuleCount: trace.authorRuleCount,
    authorDeclarationCount: trace.authorDeclarationCount,
    decodedImageCount: trace.decodedImageCount,
    paintedBackground: trace.paintOps.includes("rect"),
    sourceOrderWinnerBlue: image.data[pixel] === 0 && image.data[pixel + 1] === 0 && image.data[pixel + 2] === 255,
    alternateFetchCalls: alternateCalls.length,
    alternateDiscoveredResources: alternateTrace.discoveredResources.length,
    alternateLoadedResources: alternateTrace.loadedResources.length,
    alternateAuthorStylesheetCount: alternateTrace.authorStylesheetCount,
    alternatePaintedBackground: alternateTrace.paintOps.includes("rect"),
    displayCommands: trace.displayCommands,
    paintOps: trace.paintOps,
    pngBytes: result.png.byteLength,
  });
}

/** Render a URL page whose stylesheet href has leading/trailing whitespace. */
async function collectWhitespaceHrefStylesheetResourceEvidence(): Promise<WhitespaceHrefStylesheetResourceEvidence> {
  const url = "https://benchmark.test/whitespace-href-stylesheet.html";
  const rawHref = " /early.css ";
  const earlyUrl = "https://benchmark.test/early.css";
  const lateUrl = "https://benchmark.test/late.css";
  const html =
    `<html><head><link rel="stylesheet" href="${rawHref}">` +
    '<link rel="stylesheet" href="/late.css"></head><body><div></div></body></html>';
  const earlyCss = encode("div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }");
  const lateCss = encode("div { background-color: rgb(0, 0, 255) }");
  const calls: string[] = [];
  const resources = new Map<string, Uint8Array>([
    [url, encode(html)],
    [earlyUrl, earlyCss],
    [lateUrl, lateCss],
  ]);
  const fetchFn: FetchFn = (href) => {
    calls.push(href);
    return Promise.resolve(resources.get(href));
  };
  const result = await renderUrlToPng(url, fetchFn, { trace: true });
  const trace: ResourceTrace | undefined = result.resourceTrace;
  if (trace === undefined) {
    throw new Error("whitespace-href-stylesheet evidence: missing resource trace");
  }
  const image = decodePng(result.png);
  const pixel = (10 * image.width + 10) * 4;
  const loadedResourceUrl = trace.loadedResources[0] ?? "";

  return Object.freeze({
    url: trace.url,
    rawHref,
    resolvedHref: earlyUrl,
    loadedResourceUrl,
    fetchCalls: calls.length,
    discoveredResources: trace.discoveredResources.length,
    loadedResources: trace.loadedResources.length,
    missingResources: trace.missingResources.length,
    loadedBytes: trace.loadedBytes,
    stylesheetCount: trace.stylesheetCount,
    authorStylesheetCount: trace.authorStylesheetCount,
    authorRuleCount: trace.authorRuleCount,
    authorDeclarationCount: trace.authorDeclarationCount,
    decodedImageCount: trace.decodedImageCount,
    paintedBackground: trace.paintOps.includes("rect"),
    sourceOrderWinnerBlue: image.data[pixel] === 0 && image.data[pixel + 1] === 0 && image.data[pixel + 2] === 255,
    displayCommands: trace.displayCommands,
    paintOps: trace.paintOps,
    pngBytes: result.png.byteLength,
  });
}

/** Render a URL page whose stylesheet href has ASCII control characters around the URL. */
async function collectControlCharacterHrefStylesheetResourceEvidence(): Promise<ControlCharacterHrefStylesheetResourceEvidence> {
  const url = "https://benchmark.test/control-character-href-stylesheet.html";
  const rawHref = "\n\t/early.css\f";
  const earlyUrl = "https://benchmark.test/early.css";
  const lateUrl = "https://benchmark.test/late.css";
  const html =
    `<html><head><link rel="stylesheet" href="${rawHref}">` +
    '<link rel="stylesheet" href="/late.css"></head><body><div></div></body></html>';
  const earlyCss = encode("div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }");
  const lateCss = encode("div { background-color: rgb(0, 0, 255) }");
  const calls: string[] = [];
  const resources = new Map<string, Uint8Array>([
    [url, encode(html)],
    [earlyUrl, earlyCss],
    [lateUrl, lateCss],
  ]);
  const fetchFn: FetchFn = (href) => {
    calls.push(href);
    return Promise.resolve(resources.get(href));
  };
  const result = await renderUrlToPng(url, fetchFn, { trace: true });
  const trace: ResourceTrace | undefined = result.resourceTrace;
  if (trace === undefined) {
    throw new Error("control-character-href-stylesheet evidence: missing resource trace");
  }
  const image = decodePng(result.png);
  const pixel = (10 * image.width + 10) * 4;
  const loadedResourceUrl = trace.loadedResources[0] ?? "";

  return Object.freeze({
    url: trace.url,
    rawHref,
    rawHrefJson: JSON.stringify(rawHref),
    resolvedHref: earlyUrl,
    loadedResourceUrl,
    fetchCalls: calls.length,
    discoveredResources: trace.discoveredResources.length,
    loadedResources: trace.loadedResources.length,
    missingResources: trace.missingResources.length,
    loadedBytes: trace.loadedBytes,
    stylesheetCount: trace.stylesheetCount,
    authorStylesheetCount: trace.authorStylesheetCount,
    authorRuleCount: trace.authorRuleCount,
    authorDeclarationCount: trace.authorDeclarationCount,
    decodedImageCount: trace.decodedImageCount,
    paintedBackground: trace.paintOps.includes("rect"),
    sourceOrderWinnerBlue: image.data[pixel] === 0 && image.data[pixel + 1] === 0 && image.data[pixel + 2] === 255,
    displayCommands: trace.displayCommands,
    paintOps: trace.paintOps,
    pngBytes: result.png.byteLength,
  });
}

/** Render a URL page whose stylesheet and image both resolve through `<base href>`. */
async function collectBaseHrefSubresourceEvidence(): Promise<BaseHrefSubresourceEvidence> {
  const url = "https://benchmark.test/pages/base-href-subresource.html";
  const rawBaseHref = "https://cdn.benchmark.test/assets/";
  const resolvedBaseHref = rawBaseHref;
  const stylesheetHref = "css/theme.css";
  const imageSrc = "img/pic.png";
  const loadedStylesheetUrl = "https://cdn.benchmark.test/assets/css/theme.css";
  const loadedImageUrl = "https://cdn.benchmark.test/assets/img/pic.png";
  const html =
    `<html><head><base href="${rawBaseHref}"><link rel="stylesheet" href="${stylesheetHref}"></head>` +
    `<body><div></div><img src="${imageSrc}"></body></html>`;
  const css = encode("div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) } img { width: 20px; height: 20px }");
  const imageBytes = solidPngBytes(2, 2, [0, 0, 255, 255]);
  const calls: string[] = [];
  const resources = new Map<string, Uint8Array>([
    [url, encode(html)],
    [loadedStylesheetUrl, css],
    [loadedImageUrl, imageBytes],
  ]);
  const fetchFn: FetchFn = (href) => {
    calls.push(href);
    return Promise.resolve(resources.get(href));
  };
  const result = await renderUrlToPng(url, fetchFn, { trace: true });
  const trace: ResourceTrace | undefined = result.resourceTrace;
  if (trace === undefined) {
    throw new Error("base-href-subresource evidence: missing resource trace");
  }
  const image = decodePng(result.png);
  // The UA sheet gives body an 8px margin: the red div paints at (8, 8)-(28, 28)
  // and the image below it at (8, 28)-(28, 48); sample inside each, clear of the
  // margin and the div/image boundary.
  const backgroundPixel = (12 * image.width + 12) * 4;
  const imagePixel = (32 * image.width + 12) * 4;

  return Object.freeze({
    url: trace.url,
    rawBaseHref,
    resolvedBaseHref,
    stylesheetHref,
    imageSrc,
    loadedStylesheetUrl,
    loadedImageUrl,
    fetchCalls: calls.length,
    stylesheetFetches: calls.filter((href) => href === loadedStylesheetUrl).length,
    imageFetches: calls.filter((href) => href === loadedImageUrl).length,
    discoveredResources: trace.discoveredResources.length,
    loadedResources: trace.loadedResources.length,
    missingResources: trace.missingResources.length,
    loadedBytes: trace.loadedBytes,
    stylesheetCount: trace.stylesheetCount,
    authorStylesheetCount: trace.authorStylesheetCount,
    authorRuleCount: trace.authorRuleCount,
    authorDeclarationCount: trace.authorDeclarationCount,
    decodedImageCount: trace.decodedImageCount,
    paintedBackground: trace.paintOps.includes("rect"),
    paintedImageCount: trace.imagePaintCount,
    displayCommands: trace.displayCommands,
    paintOps: trace.paintOps,
    pngBytes: result.png.byteLength,
    paintedBackgroundRed: image.data[backgroundPixel] === 255 && image.data[backgroundPixel + 1] === 0 && image.data[backgroundPixel + 2] === 0,
    paintedImageBlue: image.data[imagePixel] === 0 && image.data[imagePixel + 1] === 0 && image.data[imagePixel + 2] === 255,
  });
}

/** Render a URL page whose invalid stylesheet href is skipped before fetch accounting. */
async function collectInvalidUrlStylesheetResourceEvidence(): Promise<InvalidUrlStylesheetResourceEvidence> {
  const url = "https://benchmark.test/invalid-url-stylesheet.html";
  const stylesheetUrl = "https://benchmark.test/theme.css";
  const html =
    '<html><head><style>div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }</style>' +
    '<link rel="stylesheet" href="http://bad.test:99999/theme.css">' +
    '<link rel="stylesheet" href="/theme.css"></head><body><div></div></body></html>';
  const css = encode("div { background-color: rgb(0, 0, 255) }");
  const calls: string[] = [];
  const resources = new Map<string, Uint8Array>([
    [url, encode(html)],
    [stylesheetUrl, css],
  ]);
  const fetchFn: FetchFn = (href) => {
    calls.push(href);
    return Promise.resolve(resources.get(href));
  };
  const result = await renderUrlToPng(url, fetchFn, { trace: true });
  const trace: ResourceTrace | undefined = result.resourceTrace;
  if (trace === undefined) {
    throw new Error("invalid-url-stylesheet evidence: missing resource trace");
  }
  const image = decodePng(result.png);
  const pixel = (10 * image.width + 10) * 4;

  const invalidOnlyUrl = "https://benchmark.test/invalid-url-only-stylesheet.html";
  const invalidOnlyHtml =
    '<html><head><link rel="stylesheet" href="http://bad.test:99999/theme.css"></head>' +
    "<body><div>after</div></body></html>";
  const invalidOnlyCalls: string[] = [];
  const invalidOnlyResult = await renderUrlToPng(
    invalidOnlyUrl,
    (href) => {
      invalidOnlyCalls.push(href);
      return Promise.resolve(href === invalidOnlyUrl ? encode(invalidOnlyHtml) : undefined);
    },
    { trace: true },
  );
  const invalidOnlyTrace: ResourceTrace | undefined = invalidOnlyResult.resourceTrace;
  if (invalidOnlyTrace === undefined) {
    throw new Error("invalid-url-only-stylesheet evidence: missing resource trace");
  }

  return Object.freeze({
    url: trace.url,
    fetchCalls: calls.length,
    discoveredResources: trace.discoveredResources.length,
    loadedResources: trace.loadedResources.length,
    missingResources: trace.missingResources.length,
    loadedBytes: trace.loadedBytes,
    stylesheetCount: trace.stylesheetCount,
    authorStylesheetCount: trace.authorStylesheetCount,
    authorRuleCount: trace.authorRuleCount,
    authorDeclarationCount: trace.authorDeclarationCount,
    decodedImageCount: trace.decodedImageCount,
    paintedBackground: trace.paintOps.includes("rect"),
    sourceOrderWinnerBlue: image.data[pixel] === 0 && image.data[pixel + 1] === 0 && image.data[pixel + 2] === 255,
    invalidOnlyFetchCalls: invalidOnlyCalls.length,
    invalidOnlyDiscoveredResources: invalidOnlyTrace.discoveredResources.length,
    invalidOnlyLoadedResources: invalidOnlyTrace.loadedResources.length,
    invalidOnlyMissingResources: invalidOnlyTrace.missingResources.length,
    invalidOnlyAuthorStylesheetCount: invalidOnlyTrace.authorStylesheetCount,
    invalidOnlyPaintedBackground: invalidOnlyTrace.paintOps.includes("rect"),
    displayCommands: trace.displayCommands,
    paintOps: trace.paintOps,
    pngBytes: result.png.byteLength,
  });
}

/** Render a URL page whose alternate stylesheet link is inactive by default. */
async function collectAlternateStylesheetResourceEvidence(): Promise<AlternateStylesheetResourceEvidence> {
  const url = "https://benchmark.test/alternate-stylesheet.html";
  const stylesheetUrl = "https://benchmark.test/theme.css";
  const html =
    '<html><head><link rel="alternate stylesheet" href="/theme.css"></head>' +
    "<body><div>after</div></body></html>";
  const css = encode("div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }");
  const calls: string[] = [];
  const resources = new Map<string, Uint8Array>([
    [url, encode(html)],
    [stylesheetUrl, css],
  ]);
  const fetchFn: FetchFn = (href) => {
    calls.push(href);
    return Promise.resolve(resources.get(href));
  };
  const result = await renderUrlToPng(url, fetchFn, { trace: true });
  const trace: ResourceTrace | undefined = result.resourceTrace;
  if (trace === undefined) {
    throw new Error("alternate-stylesheet evidence: missing resource trace");
  }
  return Object.freeze({
    url: trace.url,
    fetchCalls: calls.length,
    discoveredResources: trace.discoveredResources.length,
    loadedResources: trace.loadedResources.length,
    missingResources: trace.missingResources.length,
    loadedBytes: trace.loadedBytes,
    stylesheetCount: trace.stylesheetCount,
    authorStylesheetCount: trace.authorStylesheetCount,
    authorRuleCount: trace.authorRuleCount,
    authorDeclarationCount: trace.authorDeclarationCount,
    decodedImageCount: trace.decodedImageCount,
    paintedBackground: trace.paintOps.includes("rect"),
    displayCommands: trace.displayCommands,
    paintOps: trace.paintOps,
    pngBytes: result.png.byteLength,
  });
}

/** Render a URL page whose disabled stylesheet link is inactive by default. */
async function collectDisabledStylesheetResourceEvidence(): Promise<DisabledStylesheetResourceEvidence> {
  const url = "https://benchmark.test/disabled-stylesheet.html";
  const stylesheetUrl = "https://benchmark.test/theme.css";
  const html =
    '<html><head><link rel="stylesheet" disabled href="/theme.css"></head>' +
    "<body><div>after</div></body></html>";
  const css = encode("div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }");
  const calls: string[] = [];
  const resources = new Map<string, Uint8Array>([
    [url, encode(html)],
    [stylesheetUrl, css],
  ]);
  const fetchFn: FetchFn = (href) => {
    calls.push(href);
    return Promise.resolve(resources.get(href));
  };
  const result = await renderUrlToPng(url, fetchFn, { trace: true });
  const trace: ResourceTrace | undefined = result.resourceTrace;
  if (trace === undefined) {
    throw new Error("disabled-stylesheet evidence: missing resource trace");
  }
  return Object.freeze({
    url: trace.url,
    fetchCalls: calls.length,
    discoveredResources: trace.discoveredResources.length,
    loadedResources: trace.loadedResources.length,
    missingResources: trace.missingResources.length,
    loadedBytes: trace.loadedBytes,
    stylesheetCount: trace.stylesheetCount,
    authorStylesheetCount: trace.authorStylesheetCount,
    authorRuleCount: trace.authorRuleCount,
    authorDeclarationCount: trace.authorDeclarationCount,
    decodedImageCount: trace.decodedImageCount,
    paintedBackground: trace.paintOps.includes("rect"),
    displayCommands: trace.displayCommands,
    paintOps: trace.paintOps,
    pngBytes: result.png.byteLength,
  });
}

/** Render a URL page whose print media stylesheet is inactive for screen rendering. */
async function collectPrintMediaStylesheetResourceEvidence(): Promise<PrintMediaStylesheetResourceEvidence> {
  const url = "https://benchmark.test/print-media-stylesheet.html";
  const stylesheetUrl = "https://benchmark.test/theme.css";
  const html =
    '<html><head><link rel="stylesheet" media="print" href="/theme.css"></head>' +
    "<body><div>after</div></body></html>";
  const css = encode("div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }");
  const calls: string[] = [];
  const resources = new Map<string, Uint8Array>([
    [url, encode(html)],
    [stylesheetUrl, css],
  ]);
  const fetchFn: FetchFn = (href) => {
    calls.push(href);
    return Promise.resolve(resources.get(href));
  };
  const result = await renderUrlToPng(url, fetchFn, { trace: true });
  const trace: ResourceTrace | undefined = result.resourceTrace;
  if (trace === undefined) {
    throw new Error("print-media-stylesheet evidence: missing resource trace");
  }
  return Object.freeze({
    url: trace.url,
    fetchCalls: calls.length,
    discoveredResources: trace.discoveredResources.length,
    loadedResources: trace.loadedResources.length,
    missingResources: trace.missingResources.length,
    loadedBytes: trace.loadedBytes,
    stylesheetCount: trace.stylesheetCount,
    authorStylesheetCount: trace.authorStylesheetCount,
    authorRuleCount: trace.authorRuleCount,
    authorDeclarationCount: trace.authorDeclarationCount,
    decodedImageCount: trace.decodedImageCount,
    paintedBackground: trace.paintOps.includes("rect"),
    displayCommands: trace.displayCommands,
    paintOps: trace.paintOps,
    pngBytes: result.png.byteLength,
  });
}

/** Render URL pages proving stylesheet media lists drive resource loading and cascade participation. */
async function collectStylesheetMediaListResourceEvidence(): Promise<StylesheetMediaListResourceEvidence> {
  return Object.freeze({
    empty: await collectStylesheetMediaCaseEvidence("empty-media", ""),
    whitespaceOnly: await collectStylesheetMediaCaseEvidence("whitespace-only-media", "   "),
    matchingList: await collectStylesheetMediaCaseEvidence("media-list", "print, screen"),
    spacedMatchingList: await collectStylesheetMediaCaseEvidence("spaced-media-list", " print , screen "),
    emptyItemBeforeScreen: await collectStylesheetMediaCaseEvidence("empty-item-before-screen", ", screen"),
    emptyItemAfterScreen: await collectStylesheetMediaCaseEvidence("empty-item-after-screen", "screen,"),
    emptyItemsOnly: await collectStylesheetMediaCaseEvidence("empty-items-only", ","),
    unsupportedThenScreen: await collectStylesheetMediaCaseEvidence(
      "unsupported-media-list-then-screen",
      "(dynamic-range: high), screen",
    ),
    unsupportedOnly: await collectStylesheetMediaCaseEvidence("unsupported-media-list-only", "(dynamic-range: high)"),
    unknownTypeThenScreen: await collectStylesheetMediaCaseEvidence(
      "unknown-media-type-then-screen",
      "projection, screen",
    ),
    unknownTypeOnly: await collectStylesheetMediaCaseEvidence("unknown-media-type-only", "projection"),
    uppercaseScreen: await collectStylesheetMediaCaseEvidence("uppercase-screen", "SCREEN"),
    mixedCaseOnlyScreen: await collectStylesheetMediaCaseEvidence("mixed-case-only-screen", "Only Screen"),
    spacedOnlyScreen: await collectStylesheetMediaCaseEvidence("spaced-only-screen", "only   screen"),
    uppercasePrint: await collectStylesheetMediaCaseEvidence("uppercase-print", "PRINT"),
    all: await collectStylesheetMediaCaseEvidence("all", "all"),
    onlyAll: await collectStylesheetMediaCaseEvidence("only-all", "only all"),
    notAll: await collectStylesheetMediaCaseEvidence("not-all", "not all"),
    spacedNotAll: await collectStylesheetMediaCaseEvidence("spaced-not-all", "not   all"),
    notPrint: await collectStylesheetMediaCaseEvidence("not-print", "not print"),
    spacedNotPrint: await collectStylesheetMediaCaseEvidence("spaced-not-print", "not   print"),
    onlyPrint: await collectStylesheetMediaCaseEvidence("only-print", "only print"),
    spacedOnlyPrint: await collectStylesheetMediaCaseEvidence("spaced-only-print", "only   print"),
  });
}

/** Render URL pages proving simple stylesheet media features use the screen-like viewport. */
async function collectStylesheetMediaFeatureResourceEvidence(): Promise<StylesheetMediaFeatureResourceEvidence> {
  return Object.freeze({
    screenMinWidth: await collectStylesheetMediaCaseEvidence("screen-min-width", "screen and (min-width: 1px)"),
    uppercaseScreenMinWidth: await collectStylesheetMediaCaseEvidence(
      "uppercase-screen-min-width",
      "screen and (MIN-WIDTH: 1px)",
    ),
    decimalScreenMinWidth: await collectStylesheetMediaCaseEvidence(
      "decimal-screen-min-width",
      "screen and (min-width: 799.5px)",
    ),
    spacedScreenMinWidth: await collectStylesheetMediaCaseEvidence(
      "spaced-screen-min-width",
      "screen  and  ( min-width : 1px )",
    ),
    bareMinWidth: await collectStylesheetMediaCaseEvidence("bare-min-width", "(min-width: 1px)"),
    allMinWidth: await collectStylesheetMediaCaseEvidence("all-min-width", "all and (min-width: 1px)"),
    allMaxWidth: await collectStylesheetMediaCaseEvidence("all-max-width", "all and (max-width: 1px)"),
    onlyAllMinWidth: await collectStylesheetMediaCaseEvidence(
      "only-all-min-width",
      "only all and (min-width: 1px)",
    ),
    unsupportedRangeWidth: await collectStylesheetMediaCaseEvidence(
      "unsupported-range-width",
      "screen and (width >= 1px)",
    ),
    unsupportedRangeThenScreen: await collectStylesheetMediaCaseEvidence(
      "unsupported-range-then-screen",
      "(width >= 1px), screen",
    ),
    unsupportedCalcMinWidth: await collectStylesheetMediaCaseEvidence(
      "unsupported-calc-min-width",
      "screen and (min-width: calc(1px))",
    ),
    unsupportedHover: await collectStylesheetMediaCaseEvidence("unsupported-hover", "screen and (hover: hover)"),
    invalidEmptyFeature: await collectStylesheetMediaCaseEvidence(
      "invalid-empty-feature",
      "screen and ()",
    ),
    unsupportedBooleanWidth: await collectStylesheetMediaCaseEvidence(
      "unsupported-boolean-width",
      "screen and (width)",
    ),
    unknownFeature: await collectStylesheetMediaCaseEvidence(
      "unknown-feature",
      "screen and (unknown-feature)",
    ),
    invalidEmptyFeatureThenScreen: await collectStylesheetMediaCaseEvidence(
      "invalid-empty-feature-then-screen",
      "screen and (), screen",
    ),
    screenMaxWidth: await collectStylesheetMediaCaseEvidence("screen-max-width", "screen and (max-width: 1px)"),
    decimalScreenMaxWidth: await collectStylesheetMediaCaseEvidence(
      "decimal-screen-max-width",
      "screen and (max-width: 799.5px)",
    ),
    spacedScreenMaxWidth: await collectStylesheetMediaCaseEvidence(
      "spaced-screen-max-width",
      "screen  and  ( max-width : 1px )",
    ),
    screenMinHeight: await collectStylesheetMediaCaseEvidence("screen-min-height", "screen and (min-height: 1px)"),
    screenMaxHeight: await collectStylesheetMediaCaseEvidence("screen-max-height", "screen and (max-height: 1px)"),
    screenExactWidth: await collectStylesheetMediaCaseEvidence("screen-exact-width", "screen and (width: 800px)"),
    decimalScreenExactWidth: await collectStylesheetMediaCaseEvidence(
      "decimal-screen-exact-width",
      "screen and (width: 800.0px)",
    ),
    screenExactHeight: await collectStylesheetMediaCaseEvidence("screen-exact-height", "screen and (height: 600px)"),
    screenExactHeightMiss: await collectStylesheetMediaCaseEvidence("screen-exact-height-miss", "screen and (height: 1px)"),
    negatedMatchingFeature: await collectStylesheetMediaCaseEvidence(
      "negated-matching-feature",
      "not screen and (min-width: 1px)",
    ),
    negatedMissingFeature: await collectStylesheetMediaCaseEvidence(
      "negated-missing-feature",
      "not screen and (max-width: 1px)",
    ),
  });
}

/** Render URL pages proving orientation media features use the screen-like viewport. */
async function collectStylesheetOrientationMediaResourceEvidence(): Promise<StylesheetOrientationMediaResourceEvidence> {
  return Object.freeze({
    landscape: await collectStylesheetMediaCaseEvidence("landscape-orientation", "screen and (orientation: landscape)"),
    uppercaseLandscape: await collectStylesheetMediaCaseEvidence(
      "uppercase-landscape-orientation",
      "screen and (ORIENTATION: LANDSCAPE)",
    ),
    portrait: await collectStylesheetMediaCaseEvidence("portrait-orientation", "screen and (orientation: portrait)"),
    uppercasePortrait: await collectStylesheetMediaCaseEvidence(
      "uppercase-portrait-orientation",
      "screen and (ORIENTATION: PORTRAIT)",
    ),
  });
}

/** Render URL pages proving combined media features are conjunctive. */
async function collectStylesheetCombinedMediaFeatureResourceEvidence(): Promise<StylesheetCombinedMediaFeatureResourceEvidence> {
  return Object.freeze({
    matching: await collectStylesheetMediaCaseEvidence(
      "combined-media-feature",
      "screen and (min-width: 1px) and (orientation: landscape)",
    ),
    laterMiss: await collectStylesheetMediaCaseEvidence(
      "combined-media-feature-miss",
      "screen and (min-width: 1px) and (orientation: portrait)",
    ),
  });
}

async function collectStylesheetMediaCaseEvidence(
  slug: string,
  media: string,
): Promise<StylesheetMediaCaseEvidence> {
  const url = `https://benchmark.test/${slug}-media-stylesheet.html`;
  const stylesheetUrl = "https://benchmark.test/theme.css";
  const html =
    `<html><head><link rel="stylesheet" media="${media}" href="/theme.css"></head>` +
    "<body><div>after</div></body></html>";
  const css = encode("div { width: 20px; height: 20px; background-color: rgb(255, 0, 0) }");
  const calls: string[] = [];
  const resources = new Map<string, Uint8Array>([
    [url, encode(html)],
    [stylesheetUrl, css],
  ]);
  const fetchFn: FetchFn = (href) => {
    calls.push(href);
    return Promise.resolve(resources.get(href));
  };
  const result = await renderUrlToPng(url, fetchFn, { trace: true });
  const trace: ResourceTrace | undefined = result.resourceTrace;
  if (trace === undefined) {
    throw new Error(`${slug}-media-stylesheet evidence: missing resource trace`);
  }
  return Object.freeze({
    media,
    url: trace.url,
    fetchCalls: calls.length,
    discoveredResources: trace.discoveredResources.length,
    loadedResources: trace.loadedResources.length,
    missingResources: trace.missingResources.length,
    loadedBytes: trace.loadedBytes,
    stylesheetCount: trace.stylesheetCount,
    authorStylesheetCount: trace.authorStylesheetCount,
    authorRuleCount: trace.authorRuleCount,
    authorDeclarationCount: trace.authorDeclarationCount,
    decodedImageCount: trace.decodedImageCount,
    paintedBackground: trace.paintOps.includes("rect"),
    displayCommands: trace.displayCommands,
    paintOps: trace.paintOps,
    pngBytes: result.png.byteLength,
  });
}

/** Render a deterministic URL page whose fetched stylesheet bytes parse to no declarations. */
async function collectInvalidExternalStylesheetResourceEvidence(): Promise<InvalidExternalStylesheetResourceEvidence> {
  const url = "https://benchmark.test/invalid-external-stylesheet.html";
  const stylesheetUrl = "https://benchmark.test/bad.css";
  const html =
    '<html><head><link rel="stylesheet" href="/bad.css"></head>' +
    "<body><div>after</div></body></html>";
  const badCss = encode("div { width: bogus; height: nope; background-color: definitely-not-a-color }");
  const resources = new Map<string, Uint8Array>([
    [url, encode(html)],
    [stylesheetUrl, badCss],
  ]);
  const fetchFn: FetchFn = (href) => Promise.resolve(resources.get(href));
  const result = await renderUrlToPng(url, fetchFn, { trace: true });
  const trace: ResourceTrace | undefined = result.resourceTrace;
  if (trace === undefined) {
    throw new Error("invalid-external-stylesheet evidence: missing resource trace");
  }
  return Object.freeze({
    url: trace.url,
    discoveredResources: trace.discoveredResources.length,
    loadedResources: trace.loadedResources.length,
    missingResources: trace.missingResources.length,
    loadedBytes: trace.loadedBytes,
    stylesheetCount: trace.stylesheetCount,
    authorStylesheetCount: trace.authorStylesheetCount,
    authorRuleCount: trace.authorRuleCount,
    authorDeclarationCount: trace.authorDeclarationCount,
    decodedImageCount: trace.decodedImageCount,
    paintedBackground: trace.paintOps.includes("rect"),
    displayCommands: trace.displayCommands,
    paintOps: trace.paintOps,
    pngBytes: result.png.byteLength,
  });
}

/** Render a deterministic URL page with only a missing external stylesheet. */
async function collectMissingStylesheetResourceEvidence(): Promise<MissingStylesheetResourceEvidence> {
  const url = "https://benchmark.test/missing-stylesheet.html";
  const html =
    '<html><head><link rel="stylesheet" href="/missing.css"></head>' +
    "<body><div>after</div></body></html>";
  const resources = new Map<string, Uint8Array>([[url, encode(html)]]);
  const fetchFn: FetchFn = (href) => Promise.resolve(resources.get(href));
  const result = await renderUrlToPng(url, fetchFn, { trace: true });
  const trace: ResourceTrace | undefined = result.resourceTrace;
  if (trace === undefined) {
    throw new Error("missing-stylesheet evidence: missing resource trace");
  }
  return Object.freeze({
    url: trace.url,
    discoveredResources: trace.discoveredResources.length,
    loadedResources: trace.loadedResources.length,
    missingResources: trace.missingResources.length,
    loadedBytes: trace.loadedBytes,
    stylesheetCount: trace.stylesheetCount,
    authorStylesheetCount: trace.authorStylesheetCount,
    authorRuleCount: trace.authorRuleCount,
    authorDeclarationCount: trace.authorDeclarationCount,
    decodedImageCount: trace.decodedImageCount,
    paintedBackground: trace.paintOps.includes("rect"),
    displayCommands: trace.displayCommands,
    paintOps: trace.paintOps,
    pngBytes: result.png.byteLength,
  });
}

/** Run the configured representative real-site smoke set and collect stable evidence. */
export async function collectRealSiteSmokeEvidence(
  tests: readonly SmokeTest[] = PHASE3_SMOKE_TESTS,
): Promise<RealSiteSmokeEvidence> {
  const scenarios: RealSiteSmokeScenarioEvidence[] = [];
  const covered = new Set<string>();
  let passed = 0;

  for (const test of tests) {
    await test.run();
    passed += 1;
    for (const capability of test.capabilities) covered.add(capability);
    scenarios.push(Object.freeze({
      id: test.id,
      capabilities: Object.freeze([...test.capabilities].sort()),
      passed: true,
    }));
  }

  return Object.freeze({
    scenarioCount: tests.length,
    passed,
    failed: tests.length - passed,
    coveredCapabilities: Object.freeze([...covered].sort()),
    scenarios: Object.freeze(scenarios.sort((a, b) => a.id.localeCompare(b.id))),
  });
}

function nodeById(session: FineSession, id: string): NodeId {
  for (const [nodeId, node] of session.dom.nodes) {
    if (node.attrs?.get("id") === id) return nodeId;
  }
  throw new Error(`incremental edit evidence: missing target ${id}`);
}

function stableCounts(events: readonly StageTraceEvent[]): StableTraceCounts {
  let recomputes = 0;
  let cacheHits = 0;
  let verifiedCacheHits = 0;
  let dependencyReads = 0;
  const stages = new Set<string>();

  for (const event of events) {
    stages.add(event.stage);
    dependencyReads += event.dependencyCount;
    if (event.cacheStatus === "miss") {
      recomputes += 1;
    } else {
      cacheHits += 1;
      if (event.cacheStatus === "verified-hit") verifiedCacheHits += 1;
    }
  }

  return Object.freeze({
    queryCalls: events.length,
    recomputes,
    cacheHits,
    verifiedCacheHits,
    dependencyReads,
    tracedStages: Object.freeze([...stages].sort()),
  });
}

function mergeCounts(counts: readonly StableTraceCounts[]): StableTraceCounts {
  let queryCalls = 0;
  let recomputes = 0;
  let cacheHits = 0;
  let verifiedCacheHits = 0;
  let dependencyReads = 0;
  const stages = new Set<string>();

  for (const count of counts) {
    queryCalls += count.queryCalls;
    recomputes += count.recomputes;
    cacheHits += count.cacheHits;
    verifiedCacheHits += count.verifiedCacheHits;
    dependencyReads += count.dependencyReads;
    for (const stage of count.tracedStages) stages.add(stage);
  }

  return Object.freeze({
    queryCalls,
    recomputes,
    cacheHits,
    verifiedCacheHits,
    dependencyReads,
    tracedStages: Object.freeze([...stages].sort()),
  });
}
