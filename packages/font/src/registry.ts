/**
 * `registry.ts` — the font database `font-family` resolves against
 * (RFC 0005). A {@link FontRegistry} owns:
 *
 * - `faces` — the append-only MASTER TABLE a shaped glyph's `faceIndex`
 *   resolves against (the same array backends index per glyph — late appends
 *   are legal because lookups are per-glyph, never snapshot).
 * - named entries — faces registered eagerly (`register`) or probed lazily
 *   from font files (`registerFile`: only the `name`/`OS/2` tables are read
 *   up front; the `FontFace` materializes on first selection).
 * - generic aliases — CSS generic families (`sans-serif`, `monospace`, …)
 *   mapped onto real registered families.
 *
 * `resolve(families, opts)` returns ordered master-table indices — the exact
 * `faceOrder` list `HarfBuzzShaper.shape` consumes: requested families first
 * (each mapped to its best weight/style member), then generic-alias targets,
 * then the registry's default fallback chain for uncovered glyphs.
 */
import { readFileSync } from "node:fs";

import { readSfntFaceInfo, readSfntFaceInfoFromFile, type SfntFaceInfo } from "./names.js";
import { isGenericFamily } from "./features.js";
import { parseTrueType } from "./truetype.js";
import type { FontFace } from "./types.js";

/** What a `font-family` name resolves to before materialization. */
interface RegistryEntry {
  readonly info: SfntFaceInfo;
  /** Already-loaded face (eager registrations). */
  readonly face?: FontFace;
  /** Font file to read on first selection (lazy registrations). */
  readonly path?: string;
  /**
   * Page scope (RFC 0006): a face registered by an `@font-face` rule is
   * visible ONLY when `resolve`/`findLocal` is called with the same scope —
   * page-registered families never leak across pages/tabs, and scoped entries
   * never enter the default fallback chain (CSS Fonts §4: a webfont applies
   * only when its declared family is explicitly named).
   */
  readonly scope?: unknown;
  /** Position in the master table once materialized (-1 while pending). */
  tableIndex: number;
}

/** Selection criteria matching CSS Fonts §5.2's spirit (simplified). */
export interface FontSelect {
  readonly weight?: number;
  readonly italic?: boolean;
  readonly widthClass?: number;
}

function normalize(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Score a candidate against the request — lower is better. */
function score(entry: RegistryEntry, sel: Required<FontSelect>): number {
  // `@font-face` range descriptors: a request inside [lo,hi] is an exact hit.
  const range = entry.info.weightRange;
  const weightDist = range !== undefined
    ? sel.weight < range[0]
      ? range[0] - sel.weight
      : sel.weight > range[1]
        ? sel.weight - range[1]
        : 0
    : Math.abs((entry.info.weightClass ?? 400) - sel.weight);
  let s = weightDist;
  if (entry.info.italic !== sel.italic) s += 400; // style beats weight distance
  s += Math.abs((entry.info.widthClass ?? 5) - sel.widthClass) * 25;
  return s;
}

export class FontRegistry {
  /**
   * The master face table — append-only, shared live with the shaper and the
   * backends' raster sources (they index it per glyph).
   */
  readonly faces: FontFace[] = [];
  readonly #byFamily = new Map<string, RegistryEntry[]>();
  readonly #generics = new Map<string, string>();
  readonly #eager: RegistryEntry[] = []; // eager registrations, registration order

  /**
   * Register an already-parsed face. `info` overrides the metadata read from
   * `face.data`'s `name`/`OS/2` tables (or stands in when the face carries no
   * bytes, e.g. programmatic faces). `scope` tags the entry as page-local
   * (RFC 0006 — an `@font-face` registration). Returns the master-table index.
   */
  register(face: FontFace, info?: Partial<SfntFaceInfo>, scope?: unknown): number {
    const tableIndex = this.faces.length;
    this.faces.push(face);
    let meta: SfntFaceInfo | null = null;
    if (face.data !== undefined) {
      try {
        meta =
          readSfntFaceInfo(face.data).find(
            (f) => f.faceIndex === (face.collectionIndex ?? 0),
          ) ?? null;
      } catch {
        meta = null;
      }
    }
    const merged: SfntFaceInfo = {
      faceIndex: face.collectionIndex ?? 0,
      family: info?.family ?? meta?.family ?? null,
      subfamily: info?.subfamily ?? meta?.subfamily ?? null,
      fullName: info?.fullName ?? meta?.fullName ?? null,
      postscriptName: info?.postscriptName ?? meta?.postscriptName ?? null,
      weightClass: info?.weightClass ?? meta?.weightClass ?? null,
      widthClass: info?.widthClass ?? meta?.widthClass ?? null,
      italic: info?.italic ?? meta?.italic ?? false,
      ...(info?.weightRange !== undefined ? { weightRange: info.weightRange } : {}),
    };
    const entry: RegistryEntry = { info: merged, face, scope, tableIndex };
    if (merged.family !== null) {
      const list = this.#byFamily.get(normalize(merged.family)) ?? [];
      list.push(entry);
      this.#byFamily.set(normalize(merged.family), list);
    }
    this.#eager.push(entry);
    return tableIndex;
  }

  /**
   * Probe a font FILE — read its `name`/`OS/2` tables only (never glyph
   * data), register every face (collection members included) as a lazy entry.
   * Returns how many named faces were registered. Unreadable/non-sfnt files
   * contribute 0.
   */
  registerFile(path: string): number {
    let infos: SfntFaceInfo[];
    try {
      infos = readSfntFaceInfoFromFile(path);
    } catch {
      return 0;
    }
    let count = 0;
    for (const info of infos) {
      if (info.family === null) continue;
      const entry: RegistryEntry = { info, path, tableIndex: -1 };
      const list = this.#byFamily.get(normalize(info.family)) ?? [];
      list.push(entry);
      this.#byFamily.set(normalize(info.family), list);
      count += 1;
    }
    return count;
  }

  /** Map a CSS generic family keyword onto a registered family name. */
  alias(generic: string, family: string): void {
    this.#generics.set(normalize(generic), normalize(family));
  }

  /** All registered family names (normalized, deduped) — diagnostics. */
  families(): string[] {
    return [...this.#byFamily.keys()].sort();
  }

  /** Materialize an entry into the master table (append-once). */
  #materialize(entry: RegistryEntry): number {
    if (entry.tableIndex >= 0) return entry.tableIndex;
    if (entry.path === undefined) return -1;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(readFileSync(entry.path));
    } catch {
      return -1;
    }
    let face: FontFace;
    try {
      face = parseTrueType(bytes, entry.info.faceIndex);
    } catch {
      return -1; // CFF-only member etc. — the family stays registered.
    }
    entry.tableIndex = this.faces.length;
    this.faces.push(face);
    return entry.tableIndex;
  }

  /**
   * The default fallback chain: every eagerly-registered face, ordered by
   * weight distance from `sel.weight` (stable) — so a 700 run leads with the
   * registered bold face, exactly the pipeline's old bold-order rule.
   */
  defaultOrder(sel: FontSelect = {}): readonly number[] {
    const want: Required<FontSelect> = {
      weight: sel.weight ?? 400,
      italic: sel.italic ?? false,
      widthClass: sel.widthClass ?? 5,
    };
    return [...this.#eager]
      .filter((e) => e.scope === undefined)
      .sort((a, b) => score(a, want) - score(b, want))
      .map((e) => e.tableIndex)
      .filter((i) => i >= 0);
  }

  /**
   * Resolve a `local()`/`@font-face src: local(...)` name (RFC 0006): match the
   * registered PostScript name, full name, or family (in that priority), then
   * materialize the winner. Scoped entries are considered only for the matching
   * `scope`. Returns a master-table index or `-1`.
   */
  findLocal(name: string, scope?: unknown): number {
    const want = normalize(name);
    if (want === "") return -1;
    const visible = (e: RegistryEntry): boolean =>
      e.scope === undefined || e.scope === scope;
    // Unique entries across both indexes (eager entries also sit in byFamily).
    const entries: RegistryEntry[] = [];
    const seen = new Set<RegistryEntry>();
    for (const pool of [this.#eager, ...this.#byFamily.values()]) {
      for (const entry of pool) {
        if (!seen.has(entry)) {
          seen.add(entry);
          entries.push(entry);
        }
      }
    }
    // Field priority per CSS Fonts §4.4: postscriptName > fullName > family.
    for (const field of ["postscriptName", "fullName", "family"] as const) {
      for (const entry of entries) {
        if (!visible(entry)) continue;
        const value = entry.info[field];
        if (value !== null && normalize(value) === want) {
          return this.#materialize(entry);
        }
      }
    }
    return -1;
  }

  /**
   * Resolve a `font-family` list to ordered master-table indices:
   * requested families (best weight/style member each), then generic-alias
   * targets, then the default chain — deduped, unknowns skipped.
   */
  resolve(families: readonly string[], sel: FontSelect = {}, scope?: unknown): number[] {
    const want: Required<FontSelect> = {
      weight: sel.weight ?? 400,
      italic: sel.italic ?? false,
      widthClass: sel.widthClass ?? 5,
    };
    const order: number[] = [];
    const seen = new Set<number>();
    const push = (idx: number): void => {
      if (idx < 0 || seen.has(idx)) return;
      seen.add(idx);
      order.push(idx);
    };
    const visible = (e: RegistryEntry): boolean => e.scope === undefined || e.scope === scope;
    const resolveName = (name: string): void => {
      const key = this.#generics.get(name) ?? name;
      const candidates = this.#byFamily.get(key);
      if (candidates === undefined || candidates.length === 0) return;
      let best: RegistryEntry | undefined;
      let bestScore = Infinity;
      for (const entry of candidates) {
        if (!visible(entry)) continue;
        const s = score(entry, want);
        if (s < bestScore) {
          bestScore = s;
          best = entry;
        }
      }
      if (best !== undefined) push(this.#materialize(best));
    };
    for (const raw of families) {
      const name = normalize(raw);
      if (isGenericFamily(name)) resolveName(this.#generics.get(name) ?? name);
      else resolveName(name);
    }
    for (const idx of this.defaultOrder(want)) push(idx);
    return order;
  }
}
