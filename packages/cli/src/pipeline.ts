/**
 * The §7.2 render pipeline, written as incremental-kernel queries.
 *
 * This is the *wiring layer* (design.md §4, §7.2): it composes the six pipeline
 * stages — each a pure function of its upstream **frozen IR** — into the kernel
 * query graph
 *
 *     SourceBytes (input)
 *        │
 *        ▼
 *      qDom ──► qSheets
 *        │         │
 *        └────┬────┘
 *             ▼
 *          qComputed ──► qLayout ──► qPaint ──► DisplayList
 *
 * Stages communicate ONLY through `@browser-engine/ir` (the sanctioned, frozen
 * channel); the cli package is an orchestration layer, not a stage, so it may
 * legally import the stage packages to wire them together (the
 * `local/no-cross-stage-import` rule polices stage→stage imports, not the
 * wiring layer).
 *
 * Phase 0 (task 1.10): every stage signals {@link NotImplemented} rather than
 * returning a placeholder (design.md §12; Requirement 5.1). Therefore *running*
 * any query — `db.query(qPaint, url)` — surfaces the earliest stage's
 * `NotImplemented` (html-parse). That deterministic "empty pipeline →
 * NotImplemented" behaviour is the EXPECTED green baseline of Phase 0
 * (Requirement 12.5); the harnesses treat it as passing, not as a failure.
 *
 * The query *interface* is already in its final form: when the real stage
 * implementations land (tasks 3.1–3.10) and the naive kernel is swapped for the
 * true incremental backend (task 5.9), these query definitions do not change
 * (Requirements 2.7, 9.3).
 */
import {
  type ComputedStyle,
  type DisplayList,
  type DomTree,
  type FragmentTree,
  type NodeId,
  type StyleSheet,
} from "@browser-engine/ir";
import { define, defineInput, type InputSlot, type QueryDef } from "@browser-engine/kernel";
import { parseHtml } from "@browser-engine/html-parser";
import { cascade } from "@browser-engine/cascade";
import { layout } from "@browser-engine/layout";
import { paint } from "@browser-engine/paint";

import { documentStylesheets } from "./stylesheets.js";
import { collectImages } from "./images.js";
import { pipelineShaper } from "./fonts.js";

/** A document address — the pipeline's per-document cache key (design.md §7.2). */
export type Url = string;

/**
 * Composite key for {@link qComputed}: which node, in which document. design.md
 * §7.2 keys the cascade query by `NodeId` and resolves the document via
 * `urlOf(node)`; Phase 0 carries the `url` alongside the node so the query can
 * read its upstream IR without a separate node→url index (which lands with the
 * real DOM in task 3.1).
 */
export interface NodeRef {
  readonly url: Url;
  readonly node: NodeId;
}

/**
 * The single leaf **input** of the pipeline: the raw source bytes for a URL
 * (design.md §7.2 `SourceBytes`). The only thing a caller may write; everything
 * downstream is a derived query whose invalidation the kernel handles itself
 * (Requirement 2.3 — there is no manual stale-marking surface).
 */
export const SourceBytes: InputSlot<Url, Uint8Array> = defineInput<Url, Uint8Array>("SourceBytes");

/**
 * `qDom` — parse the source bytes into the DomTree IR (design.md §7.2).
 * Phase 0: `parseHtml` throws `NotImplemented`, so this query throws when run.
 */
export const qDom: QueryDef<Url, DomTree> = define(
  (db, url) => parseHtml(db.getInput(SourceBytes, url)),
  "qDom",
);

/**
 * `qSheets` — collect and parse the document's stylesheets (design.md §7.2
 * `collectStylesheets(db, qDom, url)`). It depends on `qDom` and walks the
 * parsed document for `<style>` elements and inline `data:` `<link
 * rel=stylesheet>`s (task M2: real collection, replacing the Phase-1 hack that
 * parsed the document's own bytes as one sheet). A CSS at-rule the minimal
 * parser does not implement still surfaces `NotImplemented` from `parseCss`.
 */
export const qSheets: QueryDef<Url, readonly StyleSheet[]> = define((db, url) => {
  const dom = db.query(qDom, url);
  return documentStylesheets(dom);
}, "qSheets");

/**
 * `qComputed` — the cascade product for one node (design.md §7.2, §8.1). Reads
 * the frozen `qDom` + `qSheets` IR; produces a geometry-free ComputedStyle.
 * Phase 0: `cascade` throws `NotImplemented`.
 */
export const qComputed: QueryDef<NodeRef, ComputedStyle> = define((db, ref) => {
  const dom = db.query(qDom, ref.url);
  const sheets = db.query(qSheets, ref.url);
  return cascade(dom, sheets, ref.node);
}, "qComputed");

/**
 * `qLayout` — lay the document out into the FragmentTree IR, the sole source of
 * geometry (design.md §7.2, §8.2). Reads `qDom` + per-node `qComputed`.
 * Phase 0: `layout` throws `NotImplemented`.
 */
export const qLayout: QueryDef<Url, FragmentTree> = define((db, url) => {
  const dom = db.query(qDom, url);
  return layout(dom, (node) => db.query(qComputed, { url, node }), { shaper: pipelineShaper });
}, "qLayout");

/**
 * `qPaint` — emit the backend-agnostic DisplayList IR (design.md §7.2, §8.6).
 * Reads `qLayout` + per-node `qComputed`. Phase 0: `paint` throws
 * `NotImplemented`; running this query is what drives the whole empty pipeline.
 */
export const qPaint: QueryDef<Url, DisplayList> = define((db, url) => {
  const fragments = db.query(qLayout, url);
  const dom = db.query(qDom, url);
  const images = collectImages(dom);
  return paint(
    fragments,
    (node) => db.query(qComputed, { url, node }),
    (node) => images.get(node),
  );
}, "qPaint");
