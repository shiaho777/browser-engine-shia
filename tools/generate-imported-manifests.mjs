/**
 * generate-imported-manifests.mjs — build per-area WPT subset manifests for the
 * vendored Ladybird `wpt-import` tree under `wpt-imported/wpt/`.
 *
 * One manifest per top-level WPT area (dom, css, html, ...), written to
 * `wpt-imported/manifests/<area>.json` in the same schema as `wpt-subsets/*.json`.
 * These manifests are NOT a regression gate: `baselinePassCount` is always 0 so
 * the forward-only gate can never block on them. Their purpose is to record the
 * honest starting point of the engine against the imported corpus and to track
 * progress over time (see `wpt-imported/baseline.json`).
 *
 * File selection mirrors `collectWptTests` in packages/cli/src/wpt-suite.ts:
 *   - skip `resources`, `tools`, `common`, and dot-directories
 *   - include `*.window.js` / `*.any.js`
 *   - include `*.html` / `*.htm` / `*.xhtml` whose text references testharness.js
 */
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WPT_ROOT = path.join(REPO_ROOT, "wpt-imported", "wpt");
const MANIFEST_DIR = path.join(REPO_ROOT, "wpt-imported", "manifests");

/** Areas that hold no runnable testharness tests for our engine. */
const EXCLUDED_AREAS = new Set(["_wpttools"]);

const SKIP_DIRS = new Set(["resources", "tools", "common"]);

function isRunnableWptTest(file) {
  if (/\.(window|any)\.js$/.test(file)) return true;
  if (/\.(x?html?|htm)$/.test(file)) {
    try {
      return readFileSync(file, "utf8").includes("testharness.js");
    } catch {
      return false;
    }
  }
  return false;
}

function collect(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;
        walk(full);
        continue;
      }
      if (isRunnableWptTest(full)) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

/** Map a WPT area name to the owning stage/package used in wpt-subsets. */
function ownerFor(area) {
  if (area === "css") return "cascade";
  if (area === "dom" || area === "domparsing" || area === "domxpath" || area === "custom-elements" || area === "shadow-dom" || area === "selection") return "guest";
  if (area === "html" || area === "editing" || area === "inert" || area === "quirks") return "guest";
  return "guest";
}

mkdirSync(MANIFEST_DIR, { recursive: true });

const areas = readdirSync(WPT_ROOT)
  .filter((entry) => {
    if (entry.startsWith(".") || EXCLUDED_AREAS.has(entry)) return false;
    try {
      return statSync(path.join(WPT_ROOT, entry)).isDirectory();
    } catch {
      return false;
    }
  })
  .sort();

const index = [];
for (const area of areas) {
  const areaRoot = path.join(WPT_ROOT, area);
  const files = collect(areaRoot).map((full) =>
    path.relative(WPT_ROOT, full).split(path.sep).join("/"),
  );
  if (files.length === 0) continue;
  const manifest = {
    name: `imported-${area}`,
    owner: ownerFor(area),
    root: "wpt-imported/wpt",
    files,
    // Imported corpus: gate never blocks. Tracked in wpt-imported/baseline.json.
    baselinePassCount: 0,
  };
  const file = path.join(MANIFEST_DIR, `${area}.json`);
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  index.push({ area, manifest: path.basename(file), files: files.length });
  console.log(`${area}: ${files.length} files`);
}

console.log(`\n${index.length} manifests written to ${MANIFEST_DIR}`);
