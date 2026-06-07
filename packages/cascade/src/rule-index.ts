/**
 * RuleIndex — the SOLE entry point for selector matching (design.md §8.3;
 * Requirement 4, Requirement 15.2). Roots out v0 bug#3 ("索引只做一半:
 * `S_TAG_MAP` 定义了却从不用,选择器匹配 O(规则×元素)"): here the index is the
 * ONLY path by which the cascade discovers matching rules — there is no
 * "bypass the index" code path (Req 4.1, 4.2).
 *
 * ## Structure (design.md §8.3)
 *
 * Rules are bucketed by the *rightmost* compound selector (the "subject") of
 * each of their selector-list entries:
 *
 *   - `byId[id]`        — rightmost compound carries `#id`,
 *   - `byClass[class]`  — rightmost compound carries `.class`,
 *   - `byTag[tag]`      — rightmost compound carries a type selector,
 *   - `universal`       — rightmost compound has no id/class/tag key (the
 *                         universal `*`, or a compound that is only
 *                         pseudo-classes such as `:root`).
 *
 * Each rule is filed into exactly ONE bucket *per selector* it owns, chosen
 * from that selector's rightmost compound by the preference **id > class >
 * tag > universal**. The chosen bucket key is always a NECESSARY condition for
 * the rightmost compound to match the node, so the union of a node's candidate
 * buckets is a SUPERSET of every rule that could possibly match it. Verifying
 * each candidate against the node then yields EXACTLY the brute-force match set
 * (Req 4.3) — the property task 5.4 asserts — while only candidate-bucket rules
 * are ever evaluated, so candidate evaluations scale below
 * total-rules × total-elements (Req 4.4).
 *
 * ## Enrichment over the design sketch (documented)
 *
 * design.md §8.3 sketches the buckets as `readonly StyleRule[]`. The cascade
 * concatenates MULTIPLE stylesheets, but `StyleRule.order` is only the source
 * order *within one sheet*; a global document order across sheets is needed so
 * the source-order cascade tie-break (Req 11.2) is deterministic and so
 * index-based matching returns rules in the SAME order an exhaustive scan does.
 * Each bucket therefore holds {@link IndexedRule} (the rule plus its global
 * document-order index) rather than the bare rule. The four-bucket structure is
 * otherwise exactly the design's.
 *
 * ## Supported selectors (Requirement 15.2)
 *
 * type (`div`), class (`.c`), id (`#i`), the universal `*`, the descendant
 * (` `) and child (`>`) combinators, and a configured subset of structural
 * pseudo-classes that are unambiguously decidable from the `DomTree`:
 *
 *   - `:root`        — an element whose parent is the `document` node,
 *   - `:first-child` — the first *element* child of its parent,
 *   - `:last-child`  — the last *element* child of its parent.
 *
 * Any selector feature outside this subset (attribute selectors, sibling
 * combinators, pseudo-elements, unsupported pseudo-classes) makes the selector
 * safely fail to match rather than match the wrong nodes.
 *
 * This module lives inside the *cascade* stage package and imports ONLY the
 * frozen IR (`@browser-engine/ir`), so it never crosses a stage boundary
 * (`local/no-cross-stage-import`).
 */
import type { DomNode, DomTree, NodeId, StyleRule, StyleSheet } from "@browser-engine/ir";

/** The structural / state pseudo-classes decidable purely from the `DomTree`. */
export type SupportedPseudoClass =
  | "root"
  | "first-child"
  | "last-child"
  | "only-child"
  | "first-of-type"
  | "last-of-type"
  | "only-of-type"
  | "empty"
  | "checked"
  | "disabled"
  | "enabled"
  | "required"
  | "optional"
  | "read-only"
  | "read-write"
  | "link"
  | "any-link";

/** The argument-less pseudo-class subset (Requirement 15.2). */
const SUPPORTED_PSEUDO_CLASSES: ReadonlySet<string> = new Set<SupportedPseudoClass>([
  "root",
  "first-child",
  "last-child",
  "only-child",
  "first-of-type",
  "last-of-type",
  "only-of-type",
  "empty",
  "checked",
  "disabled",
  "enabled",
  "required",
  "optional",
  "read-only",
  "read-write",
  "link",
  "any-link",
]);

/** An attribute-selector operator (`[a]`, `[a=v]`, `[a~=v]`, …). */
type AttrOp = "exists" | "=" | "~=" | "|=" | "^=" | "$=" | "*=";

/** One `[attr op value]` constraint within a compound selector. */
interface AttrConstraint {
  readonly name: string;
  readonly op: AttrOp;
  readonly value: string;
  /** `[a=v i]` case-insensitive flag. */
  readonly ci: boolean;
}

/** An `:nth-*(An+B)` constraint: matches when index ≡ B (mod A) on its axis. */
interface NthConstraint {
  /** Which 1-based index to test (element index, or same-type index). */
  readonly axis: "child" | "last-child" | "of-type" | "last-of-type";
  readonly a: number;
  readonly b: number;
}

/**
 * A rule paired with its global document-order index (across all sheets), so
 * the index can merge candidates from several buckets back into document order.
 */
export interface IndexedRule {
  readonly rule: StyleRule;
  /** Global document order: ascending across sheets, then rules within a sheet. */
  readonly order: number;
}

/**
 * The selector-matching index (design.md §8.3). Rules are bucketed by the key
 * of their rightmost compound; `universal` collects rules whose rightmost
 * compound has no id/class/tag key.
 */
export interface RuleIndex {
  readonly byId: ReadonlyMap<string, readonly IndexedRule[]>;
  readonly byClass: ReadonlyMap<string, readonly IndexedRule[]>;
  readonly byTag: ReadonlyMap<string, readonly IndexedRule[]>;
  readonly universal: readonly IndexedRule[];
}

// ---------------------------------------------------------------------------
// Index construction.
// ---------------------------------------------------------------------------

/** Mutable working shape while building, frozen-by-convention on return. */
interface MutableIndex {
  readonly byId: Map<string, IndexedRule[]>;
  readonly byClass: Map<string, IndexedRule[]>;
  readonly byTag: Map<string, IndexedRule[]>;
  readonly universal: IndexedRule[];
}

/**
 * Build a {@link RuleIndex} from the cascade's stylesheets (design.md §8.3).
 * Pure: depends only on the rules' selectors. Each rule is filed into one
 * bucket per selector-list entry, keyed on that entry's rightmost compound.
 *
 * @param sheets the frozen StyleSheet IR list, in cascade (document) order.
 * @returns the bucketed rule index.
 */
export function buildRuleIndex(sheets: readonly StyleSheet[]): RuleIndex {
  const index: MutableIndex = {
    byId: new Map(),
    byClass: new Map(),
    byTag: new Map(),
    universal: [],
  };

  let order = 0;
  for (const sheet of sheets) {
    for (const rule of sheet.rules) {
      const indexed: IndexedRule = { rule, order: order++ };
      fileRule(index, indexed);
    }
  }

  return index;
}

/**
 * File a rule into a bucket per selector-list entry. A rule with selectors
 * targeting different keys (e.g. `div, .foo`) is filed into several buckets so
 * the candidate set remains a superset of all rules that could match; the
 * per-bucket de-dup keeps it out of the same bucket twice (e.g. `.a, .a`).
 */
function fileRule(index: MutableIndex, indexed: IndexedRule): void {
  const seenBuckets = new Set<string>(); // bucket tags this rule already joined.
  for (const selector of indexed.rule.selector) {
    const complex = parseComplexSelector(selector.text);
    const subject = complex?.compounds[complex.compounds.length - 1];
    const key = subject === undefined ? UNIVERSAL_KEY : bucketKeyOf(subject);

    // Out-of-subset / empty selectors cannot match anything; still file them in
    // `universal` so the candidate set never *under*-counts (verification will
    // reject them). A de-dup tag keeps a rule listed once per bucket.
    const dedupTag = key.kind === "universal" ? "u" : `${key.kind}:${key.value}`;
    if (seenBuckets.has(dedupTag)) {
      continue;
    }
    seenBuckets.add(dedupTag);
    pushToBucket(index, key, indexed);
  }
}

/** A bucket choice: the bucket kind plus its key (absent for `universal`). */
type BucketKey =
  | { readonly kind: "id"; readonly value: string }
  | { readonly kind: "class"; readonly value: string }
  | { readonly kind: "tag"; readonly value: string }
  | { readonly kind: "universal" };

const UNIVERSAL_KEY: BucketKey = { kind: "universal" };

/**
 * Choose the single bucket for a rightmost compound: id > class > tag, else
 * universal. The chosen key is a NECESSARY condition for the compound to match
 * (an element lacking that id/class/tag cannot satisfy the compound), so the
 * candidate superset property — and hence brute-force equivalence — holds.
 */
function bucketKeyOf(compound: CompoundSelector): BucketKey {
  if (compound.id !== null) {
    return { kind: "id", value: compound.id };
  }
  if (compound.classes.length > 0) {
    // Any class is a necessary condition; the first is a stable choice.
    return { kind: "class", value: compound.classes[0] as string };
  }
  if (compound.tag !== null) {
    return { kind: "tag", value: compound.tag };
  }
  // Universal `*` or a compound that is only pseudo-classes (e.g. `:root`):
  // no id/class/tag key is necessary, so it must be a universal candidate.
  return UNIVERSAL_KEY;
}

/** Append `indexed` to the bucket named by `key`. */
function pushToBucket(index: MutableIndex, key: BucketKey, indexed: IndexedRule): void {
  if (key.kind === "universal") {
    index.universal.push(indexed);
    return;
  }
  const map = key.kind === "id" ? index.byId : key.kind === "class" ? index.byClass : index.byTag;
  const bucket = map.get(key.value);
  if (bucket === undefined) {
    map.set(key.value, [indexed]);
  } else {
    bucket.push(indexed);
  }
}

// ---------------------------------------------------------------------------
// Matching — the SOLE entry point (design.md §8.3; Req 4.1, 4.2).
// ---------------------------------------------------------------------------

/**
 * Gather the candidate rules for `node` from the index buckets WITHOUT
 * verifying them: `byTag[tag] ∪ universal ∪ byId[id] ∪ byClass[each class]`,
 * de-duplicated and returned in document order. Exposed so the complexity
 * invariant (Req 4.4 — candidates are drawn only from a node's buckets, never
 * the whole rule table) is directly testable.
 */
export function candidateRulesFor(index: RuleIndex, dom: DomTree, node: NodeId): StyleRule[] {
  return collectCandidates(index, dom, node).map((c) => c.rule);
}

/**
 * Match the rules that apply to `node`, routed EXCLUSIVELY through the index
 * (design.md §8.3; Req 4.1, 4.2). Only candidate-bucket rules are verified
 * (Req 4.4); the returned set equals an exhaustive scan's (Req 4.3), in
 * document order.
 *
 * @param index the rule index built from the cascade's stylesheets.
 * @param dom the frozen DomTree IR.
 * @param node the node whose matching rules are requested.
 * @returns the matching rules, in global document order.
 */
export function matchRulesFor(index: RuleIndex, dom: DomTree, node: NodeId): StyleRule[] {
  const candidates = collectCandidates(index, dom, node);
  const matched: IndexedRule[] = [];
  for (const candidate of candidates) {
    if (ruleMatches(candidate.rule, dom, node)) {
      matched.push(candidate);
    }
  }
  matched.sort((a, b) => a.order - b.order);
  return matched.map((m) => m.rule);
}

/**
 * Reference matcher: an exhaustive scan of EVERY rule in document order (no
 * index). Used only by the equivalence property (task 5.4 / Req 4.3) and tests
 * to prove `matchRulesFor` returns the same set — never by the cascade itself.
 *
 * @param sheets the frozen StyleSheet IR list, in cascade (document) order.
 * @param dom the frozen DomTree IR.
 * @param node the node whose matching rules are requested.
 * @returns the matching rules, in global document order.
 */
export function matchRulesByScan(
  sheets: readonly StyleSheet[],
  dom: DomTree,
  node: NodeId,
): StyleRule[] {
  const matched: StyleRule[] = [];
  for (const sheet of sheets) {
    for (const rule of sheet.rules) {
      if (ruleMatches(rule, dom, node)) {
        matched.push(rule);
      }
    }
  }
  return matched;
}

/**
 * Collect a node's candidate rules from the index buckets, de-duplicated by
 * global order (a rule filed into several of the node's buckets appears once).
 * `universal` is always included; id/class/tag buckets are consulted only for
 * an element node.
 */
function collectCandidates(index: RuleIndex, dom: DomTree, node: NodeId): IndexedRule[] {
  const byOrder = new Map<number, IndexedRule>();
  const addBucket = (bucket: readonly IndexedRule[] | undefined): void => {
    if (bucket === undefined) {
      return;
    }
    for (const indexed of bucket) {
      byOrder.set(indexed.order, indexed);
    }
  };

  addBucket(index.universal);

  const domNode = dom.nodes.get(node);
  if (domNode !== undefined && domNode.kind === "element") {
    if (domNode.tag !== undefined) {
      addBucket(index.byTag.get(domNode.tag));
    }
    const id = getAttr(domNode, "id");
    if (id !== null) {
      addBucket(index.byId.get(id));
    }
    for (const cls of classListOf(domNode)) {
      addBucket(index.byClass.get(cls));
    }
  }

  return [...byOrder.values()];
}

// ---------------------------------------------------------------------------
// Selector verification (the candidate-by-candidate check).
// ---------------------------------------------------------------------------

/** Does any selector in `rule`'s selector list match `node`? */
export function ruleMatches(rule: StyleRule, dom: DomTree, node: NodeId): boolean {
  for (const selector of rule.selector) {
    if (selectorMatches(selector.text, dom, node)) {
      return true;
    }
  }
  return false;
}

/** A compound selector: optional type plus id / class / pseudo / attribute constraints. */
interface CompoundSelector {
  readonly tag: string | null;
  readonly id: string | null;
  readonly classes: readonly string[];
  readonly pseudoClasses: readonly SupportedPseudoClass[];
  readonly attributes: readonly AttrConstraint[];
  readonly nth: readonly NthConstraint[];
  /** `:not(...)` negations — each an inner compound that must NOT match. */
  readonly not: readonly CompoundSelector[];
}

/** A parsed complex selector: compounds left→right, with the linking combinators. */
interface ComplexSelector {
  /** Compounds in DOM-ancestor order (index 0 is the leftmost). */
  readonly compounds: readonly CompoundSelector[];
  /** `combinators[k]` links `compounds[k]` to `compounds[k + 1]`. */
  readonly combinators: readonly Combinator[];
}

type Combinator = "descendant" | "child" | "next-sibling" | "subsequent-sibling";

/** Match a selector's text against `node` for the supported subset. */
function selectorMatches(text: string, dom: DomTree, node: NodeId): boolean {
  const complex = parseComplexSelector(text);
  if (complex === null) {
    return false; // empty or out-of-subset selector → no match (safe).
  }
  return matchFrom(complex, complex.compounds.length - 1, dom, node);
}

/**
 * Backtracking right-to-left match: `compounds[index]` must match `node`, then
 * the combinator to its left constrains an ancestor (descendant: any ancestor;
 * child: the direct parent).
 */
function matchFrom(
  complex: ComplexSelector,
  index: number,
  dom: DomTree,
  node: NodeId,
): boolean {
  const domNode = dom.nodes.get(node);
  const compound = complex.compounds[index];
  if (
    domNode === undefined ||
    compound === undefined ||
    !matchesCompound(compound, domNode, dom)
  ) {
    return false;
  }
  if (index === 0) {
    return true; // leftmost compound matched: the whole selector matches.
  }

  const combinator = complex.combinators[index - 1];
  const parentId = domNode.parent;
  if (parentId === null) {
    return false; // nothing to the left to match the remaining compounds.
  }

  if (combinator === "child") {
    return matchFrom(complex, index - 1, dom, parentId);
  }

  if (combinator === "next-sibling" || combinator === "subsequent-sibling") {
    // The left compound must match a PRECEDING element sibling: the immediately
    // preceding one (`+`), or any earlier one (`~`).
    const prevs = precedingElementSiblings(domNode, dom);
    if (combinator === "next-sibling") {
      const immediate = prevs[prevs.length - 1];
      return immediate !== undefined && matchFrom(complex, index - 1, dom, immediate);
    }
    for (const sib of prevs) {
      if (matchFrom(complex, index - 1, dom, sib)) {
        return true;
      }
    }
    return false;
  }

  // Descendant: try every ancestor until one satisfies the remaining prefix.
  let ancestorId: NodeId | null = parentId;
  while (ancestorId !== null) {
    if (matchFrom(complex, index - 1, dom, ancestorId)) {
      return true;
    }
    ancestorId = dom.nodes.get(ancestorId)?.parent ?? null;
  }
  return false;
}

/** The element siblings BEFORE `domNode` under its parent, in document order. */
function precedingElementSiblings(domNode: DomNode, dom: DomTree): NodeId[] {
  if (domNode.parent === null) return [];
  const parent = dom.nodes.get(domNode.parent);
  if (parent === undefined) return [];
  const out: NodeId[] = [];
  for (const sibId of parent.children) {
    if (sibId === domNode.id) break;
    const sib = dom.nodes.get(sibId);
    if (sib !== undefined && sib.kind === "element") out.push(sibId);
  }
  return out;
}

/** Does a single compound selector match this DOM node? */
function matchesCompound(compound: CompoundSelector, domNode: DomNode, dom: DomTree): boolean {
  if (domNode.kind !== "element") {
    return false;
  }
  if (compound.tag !== null && domNode.tag !== compound.tag) {
    return false;
  }
  if (compound.id !== null && getAttr(domNode, "id") !== compound.id) {
    return false;
  }
  if (compound.classes.length > 0) {
    const classList = classListOf(domNode);
    for (const cls of compound.classes) {
      if (!classList.has(cls)) {
        return false;
      }
    }
  }
  for (const attr of compound.attributes) {
    if (!matchesAttribute(attr, domNode)) {
      return false;
    }
  }
  for (const pseudo of compound.pseudoClasses) {
    if (!matchesPseudoClass(pseudo, domNode, dom)) {
      return false;
    }
  }
  for (const nth of compound.nth) {
    if (!matchesNth(nth, domNode, dom)) {
      return false;
    }
  }
  for (const inner of compound.not) {
    if (matchesCompound(inner, domNode, dom)) {
      return false; // :not(X) fails when the inner compound matches.
    }
  }
  return true;
}

/** Evaluate an `[attr op value]` constraint against an element. */
function matchesAttribute(attr: AttrConstraint, domNode: DomNode): boolean {
  const raw = getAttr(domNode, attr.name);
  if (raw === null) {
    return false; // the attribute must be present for every operator.
  }
  if (attr.op === "exists") {
    return true;
  }
  const actual = attr.ci ? raw.toLowerCase() : raw;
  const expected = attr.ci ? attr.value.toLowerCase() : attr.value;
  switch (attr.op) {
    case "=":
      return actual === expected;
    case "~=":
      return actual.split(/\s+/).includes(expected) && expected.length > 0;
    case "|=":
      return actual === expected || actual.startsWith(`${expected}-`);
    case "^=":
      return expected.length > 0 && actual.startsWith(expected);
    case "$=":
      return expected.length > 0 && actual.endsWith(expected);
    case "*=":
      return expected.length > 0 && actual.includes(expected);
  }
}

/**
 * Evaluate a structural / state pseudo-class against an element — each
 * unambiguously decidable from the `DomTree` (Requirement 15.2). State pseudos
 * (`:checked`, `:disabled`, …) read the corresponding HTML attribute, which is
 * the static, document-derivable proxy for that state.
 */
function matchesPseudoClass(
  pseudo: SupportedPseudoClass,
  domNode: DomNode,
  dom: DomTree,
): boolean {
  switch (pseudo) {
    case "root":
      return isRootElement(domNode, dom);
    case "first-child":
      return isEdgeElementChild(domNode, dom, "first");
    case "last-child":
      return isEdgeElementChild(domNode, dom, "last");
    case "only-child":
      return isEdgeElementChild(domNode, dom, "first") && isEdgeElementChild(domNode, dom, "last");
    case "first-of-type":
      return ofTypeIndex(domNode, dom, "first") === 1;
    case "last-of-type":
      return ofTypeIndex(domNode, dom, "last") === 1;
    case "only-of-type":
      return ofTypeIndex(domNode, dom, "first") === 1 && ofTypeIndex(domNode, dom, "last") === 1;
    case "empty":
      return isEmptyElement(domNode, dom);
    case "checked":
      return hasAttr(domNode, "checked") || hasAttr(domNode, "selected");
    case "disabled":
      return hasAttr(domNode, "disabled");
    case "enabled":
      return isFormControl(domNode) && !hasAttr(domNode, "disabled");
    case "required":
      return hasAttr(domNode, "required");
    case "optional":
      return isFormControl(domNode) && !hasAttr(domNode, "required");
    case "read-only":
      return hasAttr(domNode, "readonly") || !isFormControl(domNode);
    case "read-write":
      return isFormControl(domNode) && !hasAttr(domNode, "readonly");
    case "link":
    case "any-link":
      return isLinkElement(domNode);
  }
}

/** Whether the element is a link (`a`/`area`/`link` carrying `href`). */
function isLinkElement(domNode: DomNode): boolean {
  return (
    (domNode.tag === "a" || domNode.tag === "area" || domNode.tag === "link") &&
    getAttr(domNode, "href") !== null
  );
}

/** The HTML form controls `:enabled`/`:disabled`/`:read-write` apply to. */
function isFormControl(domNode: DomNode): boolean {
  return (
    domNode.tag === "input" ||
    domNode.tag === "button" ||
    domNode.tag === "select" ||
    domNode.tag === "textarea" ||
    domNode.tag === "option" ||
    domNode.tag === "fieldset"
  );
}

/** Whether an attribute is present (regardless of value). */
function hasAttr(domNode: DomNode, name: string): boolean {
  return domNode.attrs?.has(name) ?? false;
}

/** An element is `:empty` when it has no element or non-whitespace text children. */
function isEmptyElement(domNode: DomNode, dom: DomTree): boolean {
  for (const childId of domNode.children) {
    const child = dom.nodes.get(childId);
    if (child === undefined) continue;
    if (child.kind === "element") return false;
    if (child.kind === "text" && (child.text ?? "").trim().length > 0) return false;
  }
  return true;
}

/** The element's 1-based index among same-tag siblings, from the given end. */
function ofTypeIndex(domNode: DomNode, dom: DomTree, end: "first" | "last"): number {
  if (domNode.parent === null) return 0;
  const parent = dom.nodes.get(domNode.parent);
  if (parent === undefined) return 0;
  const order = end === "first" ? parent.children : [...parent.children].reverse();
  let count = 0;
  for (const sibId of order) {
    const sib = dom.nodes.get(sibId);
    if (sib === undefined || sib.kind !== "element" || sib.tag !== domNode.tag) continue;
    count += 1;
    if (sibId === domNode.id) return count;
  }
  return 0;
}

/** The element's 1-based index among element siblings, from the given end. */
function childIndex(domNode: DomNode, dom: DomTree, end: "first" | "last"): number {
  if (domNode.parent === null) return 0;
  const parent = dom.nodes.get(domNode.parent);
  if (parent === undefined) return 0;
  const order = end === "first" ? parent.children : [...parent.children].reverse();
  let count = 0;
  for (const sibId of order) {
    const sib = dom.nodes.get(sibId);
    if (sib === undefined || sib.kind !== "element") continue;
    count += 1;
    if (sibId === domNode.id) return count;
  }
  return 0;
}

/** Evaluate an `:nth-*(An+B)` constraint: index n satisfies `(n - b) / a` ≥ 0 integer. */
function matchesNth(nth: NthConstraint, domNode: DomNode, dom: DomTree): boolean {
  const idx =
    nth.axis === "child"
      ? childIndex(domNode, dom, "first")
      : nth.axis === "last-child"
        ? childIndex(domNode, dom, "last")
        : nth.axis === "of-type"
          ? ofTypeIndex(domNode, dom, "first")
          : ofTypeIndex(domNode, dom, "last");
  if (idx === 0) return false;
  // idx = a*k + b for some integer k ≥ 0.
  if (nth.a === 0) return idx === nth.b;
  const k = (idx - nth.b) / nth.a;
  return Number.isInteger(k) && k >= 0;
}

/** An element is `:root` when its parent node is the `document` node. */
function isRootElement(domNode: DomNode, dom: DomTree): boolean {
  if (domNode.parent === null) {
    return false; // a parentless node is not a document-rooted element.
  }
  const parent = dom.nodes.get(domNode.parent);
  return parent !== undefined && parent.kind === "document";
}

/**
 * Is `domNode` the first / last *element* child of its parent? Only element
 * siblings count (text / comment nodes are skipped), matching CSS `:first-child`
 * / `:last-child` semantics.
 */
function isEdgeElementChild(domNode: DomNode, dom: DomTree, edge: "first" | "last"): boolean {
  if (domNode.parent === null) {
    return false;
  }
  const parent = dom.nodes.get(domNode.parent);
  if (parent === undefined) {
    return false;
  }
  const siblings = edge === "first" ? parent.children : [...parent.children].reverse();
  for (const siblingId of siblings) {
    const sibling = dom.nodes.get(siblingId);
    if (sibling === undefined || sibling.kind !== "element") {
      continue;
    }
    return siblingId === domNode.id; // first element encountered from the chosen end.
  }
  return false;
}

/** Read an attribute value, or `null` when absent. */
function getAttr(domNode: DomNode, name: string): string | null {
  return domNode.attrs?.get(name) ?? null;
}

/** The element's class list as a set (whitespace-separated `class` attribute). */
function classListOf(domNode: DomNode): ReadonlySet<string> {
  const raw = getAttr(domNode, "class");
  if (raw === null) {
    return EMPTY_CLASS_SET;
  }
  return new Set(raw.split(/\s+/).filter((c) => c.length > 0));
}

const EMPTY_CLASS_SET: ReadonlySet<string> = new Set<string>();

// ---------------------------------------------------------------------------
// Selector parsing (the supported subset).
// ---------------------------------------------------------------------------

/**
 * Parse selector `text` into a {@link ComplexSelector}. Returns `null` when the
 * selector is empty or uses a feature outside the supported subset (pseudo-
 * elements, `:has()`, unknown functional pseudo-classes), so an unsupported
 * rule safely fails to match rather than matching wrong nodes. Supports the
 * descendant/child/`+`/`~` combinators with a bracket- and paren-aware
 * tokenizer (so `[a~="x y"]` and `:nth-child(2n+1)` are not split on spaces).
 */
function parseComplexSelector(text: string): ComplexSelector | null {
  const items = tokenizeComplex(text);
  if (items === null) {
    return null;
  }
  const compounds: CompoundSelector[] = [];
  const combinators: Combinator[] = [];
  let pending: Combinator = "descendant";
  let expectCompound = true;

  for (const item of items) {
    if (item.kind === "comb") {
      if (expectCompound) {
        return null; // a combinator with no left-hand compound: malformed.
      }
      pending = item.combinator;
      expectCompound = true;
      continue;
    }
    const compound = parseCompound(item.text);
    if (compound === null) {
      return null; // out-of-subset compound.
    }
    if (compounds.length > 0) {
      combinators.push(pending);
    }
    compounds.push(compound);
    pending = "descendant";
    expectCompound = false;
  }

  if (expectCompound || compounds.length === 0) {
    return null; // trailing combinator or empty selector.
  }
  return { compounds, combinators };
}

type SelectorItem =
  | { readonly kind: "compound"; readonly text: string }
  | { readonly kind: "comb"; readonly combinator: Combinator };

/**
 * Split a complex selector into compound tokens and explicit combinators,
 * respecting `[...]`, `(...)`, and quotes so whitespace inside them is not a
 * boundary. Returns `null` on bracket imbalance.
 */
function tokenizeComplex(text: string): SelectorItem[] | null {
  const items: SelectorItem[] = [];
  let cur = "";
  let depth = 0;
  let quote: string | null = null;
  const flush = (): void => {
    if (cur.length > 0) {
      items.push({ kind: "compound", text: cur });
      cur = "";
    }
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (quote !== null) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "[" || ch === "(") {
      depth += 1;
      cur += ch;
      continue;
    }
    if (ch === "]" || ch === ")") {
      depth -= 1;
      cur += ch;
      continue;
    }
    if (depth > 0) {
      cur += ch;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f") {
      flush();
      continue;
    }
    if (ch === ">" || ch === "+" || ch === "~") {
      flush();
      items.push({
        kind: "comb",
        combinator: ch === ">" ? "child" : ch === "+" ? "next-sibling" : "subsequent-sibling",
      });
      continue;
    }
    cur += ch;
  }
  if (depth !== 0 || quote !== null) {
    return null; // unbalanced brackets / quotes.
  }
  flush();
  return items;
}

/**
 * Parse one compound selector token (`div`, `.a`, `#id`, `div.a#id`, `*`,
 * `div:first-child`, `[type="text"]`, `:nth-child(2n+1)`, `:not(.x)`, …).
 * Returns `null` for any feature outside the supported subset.
 */
function parseCompound(token: string): CompoundSelector | null {
  let tag: string | null = null;
  let id: string | null = null;
  const classes: string[] = [];
  const pseudoClasses: SupportedPseudoClass[] = [];
  const attributes: AttrConstraint[] = [];
  const nth: NthConstraint[] = [];
  const not: CompoundSelector[] = [];

  let i = 0;
  const len = token.length;
  while (i < len) {
    const ch = token[i];
    if (ch === "*") {
      if (tag !== null) return null;
      i += 1;
      continue;
    }
    if (ch === "#") {
      const name = readIdent(token, i + 1);
      if (name.length === 0) return null;
      id = name;
      i += 1 + name.length;
      continue;
    }
    if (ch === ".") {
      const name = readIdent(token, i + 1);
      if (name.length === 0) return null;
      classes.push(name);
      i += 1 + name.length;
      continue;
    }
    if (ch === "[") {
      const close = token.indexOf("]", i);
      if (close === -1) return null;
      const attr = parseAttribute(token.slice(i + 1, close));
      if (attr === null) return null;
      attributes.push(attr);
      i = close + 1;
      continue;
    }
    if (ch === ":") {
      if (token[i + 1] === ":") {
        return null; // pseudo-element (::before, …): out of subset → safe non-match.
      }
      const name = readIdent(token, i + 1);
      if (name.length === 0) return null;
      let after = i + 1 + name.length;
      if (token[after] === "(") {
        // Functional pseudo-class: :nth-*(...) or :not(...).
        const close = token.indexOf(")", after);
        if (close === -1) return null;
        const arg = token.slice(after + 1, close);
        if (name === "not") {
          const inner = parseCompound(arg.trim());
          if (inner === null) return null;
          not.push(inner);
        } else {
          const axis = NTH_AXES[name];
          if (axis === undefined) return null;
          const parsed = parseNth(arg.trim());
          if (parsed === null) return null;
          nth.push({ axis, a: parsed.a, b: parsed.b });
        }
        after = close + 1;
      } else {
        if (!SUPPORTED_PSEUDO_CLASSES.has(name)) {
          return null;
        }
        pseudoClasses.push(name as SupportedPseudoClass);
      }
      i = after;
      continue;
    }
    if (isIdentStart(ch)) {
      if (tag !== null) return null;
      const name = readIdent(token, i);
      tag = name.toLowerCase();
      i += name.length;
      continue;
    }
    return null; // unsupported character.
  }

  return { tag, id, classes, pseudoClasses, attributes, nth, not };
}

/** The `:nth-*` functional pseudo-classes mapped to the index axis they test. */
const NTH_AXES: Readonly<Record<string, NthConstraint["axis"]>> = {
  "nth-child": "child",
  "nth-last-child": "last-child",
  "nth-of-type": "of-type",
  "nth-last-of-type": "last-of-type",
};

/** Parse an attribute selector body (`name`, `name=v`, `name~="v" i`, …). */
function parseAttribute(body: string): AttrConstraint | null {
  const trimmed = body.trim();
  const m = /^([A-Za-z_][\w-]*)\s*(?:([~|^$*]?=)\s*(.+?))?\s*$/.exec(trimmed);
  if (m === null) return null;
  const name = (m[1] as string).toLowerCase();
  if (m[2] === undefined) {
    return { name, op: "exists", value: "", ci: false };
  }
  let rest = (m[3] ?? "").trim();
  let ci = false;
  // Optional case-insensitivity flag: `[a=v i]` / `[a=v s]`.
  const flagMatch = /\s+([iIsS])$/.exec(rest);
  if (flagMatch !== null) {
    ci = (flagMatch[1] as string).toLowerCase() === "i";
    rest = rest.slice(0, flagMatch.index).trim();
  }
  let value = rest;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return { name, op: m[2] as AttrOp, value, ci };
}

/** Parse an `An+B` micro-syntax (`odd`, `even`, `3`, `2n`, `2n+1`, `-n+3`). */
function parseNth(text: string): { readonly a: number; readonly b: number } | null {
  const s = text.replace(/\s+/g, "").toLowerCase();
  if (s === "odd") return { a: 2, b: 1 };
  if (s === "even") return { a: 2, b: 0 };
  if (/^[+-]?\d+$/.test(s)) return { a: 0, b: Number(s) };
  // [+-]?(\d+)?n([+-]\d+)?
  const m = /^([+-]?\d*)n([+-]\d+)?$/.exec(s);
  if (m === null) return null;
  const aRaw = m[1];
  const a = aRaw === "" || aRaw === "+" ? 1 : aRaw === "-" ? -1 : Number(aRaw);
  const b = m[2] === undefined ? 0 : Number(m[2]);
  return { a, b };
}

/** Read an identifier run starting at `start`; returns the matched substring. */
function readIdent(token: string, start: number): string {
  let i = start;
  while (i < token.length && isIdentChar(token[i])) {
    i += 1;
  }
  return token.slice(start, i);
}

/** An identifier starts with an ASCII letter, `_`, `-`, or a non-ASCII char. */
function isIdentStart(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  return (
    (ch >= "a" && ch <= "z") ||
    (ch >= "A" && ch <= "Z") ||
    ch === "_" ||
    ch === "-" ||
    ch.charCodeAt(0) > 0x7f
  );
}

/** An identifier continues with name-start characters plus ASCII digits. */
function isIdentChar(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  return isIdentStart(ch) || (ch >= "0" && ch <= "9");
}
