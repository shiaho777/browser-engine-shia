/**
 * generate.ts — the top-level code-generation entry (design.md §4.2).
 *
 * `generate()` runs the two emission paths — CSS artifacts (from
 * `CSS_PROPERTIES`) and the DOM surface (from `DOM_INTERFACES`) — in ISOLATION,
 * capturing per-path success or failure. This makes Requirement 6.4 real and
 * testable: a thrown error inside CSS-parser generation is caught and recorded,
 * and DOM-surface generation still proceeds and succeeds (proven by
 * `independence.test.ts`). The two paths share no inputs, so neither can break
 * the other.
 *
 * The result is a structured {@link GenerateResult} rather than a throw, so a
 * caller (the `bin/generate.ts` writer, or a test) can inspect exactly which
 * path failed and why, write the files that did succeed, and exit non-zero only
 * when appropriate.
 */
import { CSS_PROPERTIES } from "../css-properties.data.js";
import { DOM_INTERFACES } from "../dom-interfaces.idl.js";
import type { CssPropertyDef } from "../css-property-def.js";
import type { IdlInterface } from "../dom-interfaces.idl.js";
import { emitCssArtifacts } from "./css-codegen.js";
import { emitDomArtifacts } from "./dom-codegen.js";
import type { GeneratedFile } from "./emit-support.js";

/** Inputs to {@link generate}. Defaults to the committed data tables. */
export interface GenerateInput {
  /** The CSS property data table (defaults to `CSS_PROPERTIES`). */
  readonly properties?: readonly CssPropertyDef[];
  /** The DOM IDL interface table (defaults to `DOM_INTERFACES`). */
  readonly interfaces?: readonly IdlInterface[];
}

/** The outcome of one isolated emission path. */
export type PathResult =
  | { readonly ok: true; readonly files: readonly GeneratedFile[] }
  | { readonly ok: false; readonly error: string };

/**
 * The structured result of a full generation run. Each path is independent: one
 * may fail while the other succeeds (Requirement 6.4).
 */
export interface GenerateResult {
  /** The CSS artifacts path (parser + initial + inheritance + fields). */
  readonly css: PathResult;
  /** The DOM-surface path. */
  readonly dom: PathResult;
  /** All files from the paths that succeeded, in CSS-then-DOM order. */
  readonly files: readonly GeneratedFile[];
  /** True only when BOTH paths succeeded. */
  readonly ok: boolean;
}

/** Run one emission path, converting any thrown error into a failed result. */
function runPath(emit: () => readonly GeneratedFile[]): PathResult {
  try {
    return { ok: true, files: emit() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

/**
 * Generate every artifact from the data tables (Requirements 6.2, 6.3, 6.4).
 *
 * The CSS path and the DOM path run independently and in isolation: a failure in
 * one is captured in its {@link PathResult} and does not prevent the other from
 * producing its files. The returned {@link GenerateResult.files} contains the
 * artifacts of whichever paths succeeded.
 */
export function generate(input: GenerateInput = {}): GenerateResult {
  const properties = input.properties ?? CSS_PROPERTIES;
  const interfaces = input.interfaces ?? DOM_INTERFACES;

  // Independent paths: each is isolated so the other proceeds regardless.
  const css = runPath(() => emitCssArtifacts(properties));
  const dom = runPath(() => emitDomArtifacts(interfaces));

  const files: GeneratedFile[] = [];
  if (css.ok) {
    files.push(...css.files);
  }
  if (dom.ok) {
    files.push(...dom.files);
  }

  return { css, dom, files, ok: css.ok && dom.ok };
}
