/**
 * Repository source scanner (compete-with-google-benchmark spec; Requirement
 * 1.1). Walks `packages/<pkg>/src` and returns the source files the Live_Metrics
 * denominator is computed from, excluding `dist`, `node_modules`, and
 * `generated/` directories. Test files are kept (Live_Metrics splits them out)
 * so the report can honestly show the test-line count too.
 *
 * Kept as a thin, dependency-light wrapper over Node's `fs` so the metrics
 * themselves stay pure functions of the returned file list.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { SourceFileInput } from "@browser-engine/scoreboard";

/** Directory names never descended into. */
const SKIP_DIRS: ReadonlySet<string> = new Set(["dist", "node_modules", ".git"]);

/** Whether a path segment marks generated output (excluded from hand-written). */
function isGeneratedSegment(segment: string): boolean {
  return segment.toLowerCase() === "generated";
}

/** Whether a file is TypeScript source we measure (.ts, excluding .d.ts). */
function isMeasuredSource(name: string): boolean {
  return /\.[cm]?ts$/.test(name) && !name.endsWith(".d.ts");
}

/**
 * Recursively collect measured source files under `dir`. `generated/`
 * directories are still collected (so generated lines are counted toward the
 * total), but `dist`/`node_modules` are skipped entirely.
 */
function walk(dir: string, root: string, out: SourceFileInput[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // unreadable directory — skip rather than crash the benchmark.
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      walk(full, root, out);
    } else if (stats.isFile() && isMeasuredSource(entry)) {
      const rel = path.relative(root, full).split(path.sep).join("/");
      out.push({ path: rel, content: readFileSync(full, "utf8") });
    }
  }
}

/**
 * Scan every `packages/<pkg>/src` tree under `repoRoot` and return the measured
 * source files (path relative to `repoRoot`, content). Generated files are
 * included (classified later); dist/node_modules are excluded.
 */
export function scanRepositorySources(repoRoot: string): readonly SourceFileInput[] {
  const out: SourceFileInput[] = [];
  const packagesDir = path.join(repoRoot, "packages");
  let pkgs: string[];
  try {
    pkgs = readdirSync(packagesDir);
  } catch {
    return out;
  }
  for (const pkg of pkgs) {
    const src = path.join(packagesDir, pkg, "src");
    try {
      if (statSync(src).isDirectory()) {
        walk(src, repoRoot, out);
      }
    } catch {
      // package without a src/ dir — skip.
    }
  }
  return out;
}

export { isGeneratedSegment };
