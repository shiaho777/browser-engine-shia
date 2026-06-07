/**
 * NotImplemented — the single sanctioned signal for an unimplemented path.
 *
 * Design rationale (design.md §2 bug#4, §12; Requirement 5):
 * v0's failure mode was "wired but not connected" stubs — `fetch` hard-coded to
 * 404, a fake `location`, empty `focus`/`blur` — that silently masqueraded as
 * working features. There was no mechanism to tell "implemented" apart from
 * "placeholder".
 *
 * The constitution's answer: an unimplemented path MUST fail loudly by throwing
 * a `NotImplemented` error that *identifies the missing capability*, and MUST
 * NOT return a placeholder/fake value. The companion ESLint rule
 * `local/no-silent-stub` (tools/eslint-rules) makes this physically enforced in
 * CI (Requirements 5.2, 12.2): a stub that returns a placeholder turns CI red.
 *
 * The carried `feature`/`category` are what the Scoreboard reads to mark a
 * capability as not implemented (Requirement 5.4).
 */

/**
 * Classifies the kind of capability that is missing, so the Scoreboard and
 * error consumers can group/report unimplemented surfaces (Requirement 5.4).
 */
export type NotImplementedCategory =
  | "css-property"
  | "dom-api"
  | "layout-mode"
  | "paint-command"
  | "pipeline-stage"
  | "selector"
  | "other";

/** Optional context attached to a {@link NotImplemented} error. */
export interface NotImplementedOptions {
  /** Classifies the missing capability. Defaults to `"other"`. */
  readonly category?: NotImplementedCategory;
  /** Free-form human-readable detail about what is missing. */
  readonly detail?: string;
  /** Underlying cause, forwarded to the standard `Error` `cause` option. */
  readonly cause?: unknown;
}

/**
 * Error thrown by any code path that has not yet been implemented.
 *
 * It always identifies the missing capability via {@link NotImplemented.feature}
 * (Requirement 5.1). Never catch-and-swallow this to return a placeholder — that
 * reintroduces the exact class of bug Phase 0 exists to prevent.
 */
export class NotImplemented extends Error {
  /** The missing capability, e.g. `"css-property:grid-template-columns"`. */
  readonly feature: string;
  /** Classification of the missing capability. */
  readonly category: NotImplementedCategory;
  /** Optional human-readable detail, present only when supplied. */
  readonly detail?: string;

  constructor(feature: string, options: NotImplementedOptions = {}) {
    const category: NotImplementedCategory = options.category ?? "other";
    const detailSuffix = options.detail === undefined ? "" : ` — ${options.detail}`;
    const message = `NotImplemented [${category}]: ${feature}${detailSuffix}`;
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );

    // Stable name across transpilation / minification and prototype chains.
    this.name = "NotImplemented";
    this.feature = feature;
    this.category = category;
    if (options.detail !== undefined) {
      this.detail = options.detail;
    }

    // Preserve the prototype chain when targeting ES that down-levels classes.
    Object.setPrototypeOf(this, NotImplemented.prototype);
  }
}

/**
 * Convenience thrower. Returns `never`, so it can be used wherever a value is
 * expected without tricking the type checker into accepting a placeholder:
 *
 * ```ts
 * function widthOf(style: ComputedStyle): Px {
 *   return notImplemented("css-property:width", { category: "css-property" });
 * }
 * ```
 *
 * The `local/no-silent-stub` lint rule recognises both `throw new
 * NotImplemented(...)` and `notImplemented(...)` as a valid loud failure.
 */
export function notImplemented(
  feature: string,
  options?: NotImplementedOptions,
): never {
  throw new NotImplemented(feature, options);
}

/** Type guard for {@link NotImplemented}. */
export function isNotImplemented(value: unknown): value is NotImplemented {
  return value instanceof NotImplemented;
}
