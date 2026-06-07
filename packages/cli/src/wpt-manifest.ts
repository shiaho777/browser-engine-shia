/**
 * WPT subset manifests.
 *
 * A manifest turns exploratory WPT runs into a maintained compatibility gate:
 * it declares the files, the owning stage, and the forward-only baseline pass
 * count. Running a manifest compares the live pass count against that baseline.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkWptRegression, type WptRegressionResult } from "@browser-engine/scoreboard";

import { runWptFiles, type WptSuiteReport } from "./wpt-suite.js";

/** The on-disk JSON shape under `wpt-subsets/*.json`. */
export interface WptSubsetManifest {
  /** Stable subset name, e.g. `dom-core`. */
  readonly name: string;
  /** Owning stage/package for triage, e.g. `guest`, `cascade`, `layout`. */
  readonly owner: string;
  /** Root containing the files. Relative paths resolve from the repository root. */
  readonly root: string;
  /** WPT files to run, relative to `root`. */
  readonly files: readonly string[];
  /** Forward-only baseline. A candidate below this count blocks. */
  readonly baselinePassCount: number;
}

/** Result of one manifest run plus its regression-gate verdict. */
export interface WptSubsetManifestRun {
  readonly manifest: WptSubsetManifest;
  readonly root: string;
  readonly report: WptSuiteReport;
  readonly regression: WptRegressionResult;
  readonly passedGate: boolean;
}

/** Aggregate result of running every manifest in a directory. */
export interface WptSubsetManifestRunSummary {
  readonly manifestDir: string;
  readonly runs: readonly WptSubsetManifestRun[];
  readonly passedGate: boolean;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Default subset directory at the repository root. */
export function defaultWptSubsetDir(repoRoot: string = REPO_ROOT): string {
  return path.join(repoRoot, "wpt-subsets");
}

/** Load and validate one manifest JSON file. */
export function loadWptSubsetManifest(file: string): WptSubsetManifest {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`WPT subset manifest ${file} must be a JSON object`);
  }

  const name = readString(parsed, "name", file);
  const owner = readString(parsed, "owner", file);
  const root = readString(parsed, "root", file);
  const files = readStringArray(parsed, "files", file);
  const baselinePassCount = readNonNegativeInteger(parsed, "baselinePassCount", file);

  return { name, owner, root, files, baselinePassCount };
}

/** Discover manifest files in a directory, sorted for deterministic reports. */
export function collectWptSubsetManifestFiles(dir: string): readonly string[] {
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .map((entry) => path.join(dir, entry));
}

/**
 * Run one manifest. `wptRootOverride`, when supplied, replaces the repository
 * root as the base for manifest `root` paths, so the same manifest can target a
 * real `web-platform-tests` checkout.
 */
export async function runWptSubsetManifest(
  manifest: WptSubsetManifest,
  options: { readonly repoRoot?: string; readonly wptRootOverride?: string } = {},
): Promise<WptSubsetManifestRun> {
  const baseRoot = options.wptRootOverride ?? options.repoRoot ?? REPO_ROOT;
  const root = path.resolve(baseRoot, manifest.root);
  const report = await runWptFiles(root, manifest.files);
  const regression = checkWptRegression(manifest.baselinePassCount, report.passed);
  return {
    manifest,
    root,
    report,
    regression,
    passedGate: !regression.blocked,
  };
}

/** Load and run every manifest in a directory. */
export async function runWptSubsetManifestDir(
  manifestDir: string = defaultWptSubsetDir(),
  options: { readonly repoRoot?: string; readonly wptRootOverride?: string } = {},
): Promise<WptSubsetManifestRunSummary> {
  const runs: WptSubsetManifestRun[] = [];
  for (const file of collectWptSubsetManifestFiles(manifestDir)) {
    runs.push(await runWptSubsetManifest(loadWptSubsetManifest(file), options));
  }
  return {
    manifestDir,
    runs,
    passedGate: runs.length > 0 && runs.every((run) => run.passedGate),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, field: string, file: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`WPT subset manifest ${file} field ${field} must be a non-empty string`);
  }
  return value;
}

function readStringArray(record: Record<string, unknown>, field: string, file: string): readonly string[] {
  const value = record[field];
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string" && item !== "")) {
    throw new Error(`WPT subset manifest ${file} field ${field} must be a non-empty string array`);
  }
  return value;
}

function readNonNegativeInteger(record: Record<string, unknown>, field: string, file: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`WPT subset manifest ${file} field ${field} must be a non-negative integer`);
  }
  return value;
}
